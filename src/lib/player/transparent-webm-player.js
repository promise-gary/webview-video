import { PlayerError } from '../../error/error-reporter.js';
import { EncodedMediaStore } from '../../store/encoded-media-store.js';
import { WebAudioClock } from '../audio/web-audio-clock.js';
import { IncrementalWebmDemuxer } from '../demuxers/incremental-webm-demuxer.js';
import { RendererFactory } from '../renderers/renderer-factory.js';

const MAX_BUFFERED_PAIRS = 8;
const AUDIO_DURATION_TOLERANCE_US = 50_000;

/** 完整接收宿主资源后，单次自动播放透明 WebM。 */
export class TransparentWebmPlayer {
  constructor({
    canvas,
    resourceReader,
    audioEnabled = false,
    webGpuEnabled = true,
    onCacheProgress = () => {},
    onVideoInfoChange = () => {},
    onError = () => {},
    onPlayingChange = () => {},
    onTechnicalPath = () => {},
  }) {
    this.canvas = canvas;
    this.resourceReader = resourceReader;
    this.audioEnabled = audioEnabled;
    this.webGpuEnabled = webGpuEnabled;
    this.onCacheProgress = onCacheProgress;
    this.onVideoInfoChange = onVideoInfoChange;
    this.onError = onError;
    this.onPlayingChange = onPlayingChange;
    this.onTechnicalPath = onTechnicalPath;

    this.renderer = null;
    this.decoderConfig = null;
    this.colorDecoder = null;
    this.alphaDecoder = null;
    this.audioClock = null;
    this.demuxer = null;
    this.store = new EncodedMediaStore();

    this.nextPairIndex = 0;
    this.partialPairs = new Map();
    this.decodedPairs = [];
    this.pairsInFlight = 0;
    this.renderingPairs = 0;
    this.currentTimeUs = 0;
    this.playbackStartedAt = 0;
    this.animationId = 0;

    this.started = false;
    this.playing = false;
    this.failed = false;
    this.disposed = false;
    this.renderFrame = (now) => this._render(now);
  }

  /** 接收完整资源，完成 Demux、解码器及渲染器初始化。 */
  async load() {
    if (!('VideoDecoder' in window) || !('EncodedVideoChunk' in window)) {
      this._reportTechnicalPath('error', 'WebCodecs VideoDecoder Unsupported');
      throw new PlayerError('DECODER_FAILED', 'decoder', '当前环境不支持 VideoDecoder。');
    }
    this._reportTechnicalPath('success', 'WebCodecs VideoDecoder');

    try {
      if (!this.resourceReader?.read) {
        throw new PlayerError('BRIDGE_FAILED', 'resource', '缺少可用的本地资源读取器。');
      }

      this.demuxer = new IncrementalWebmDemuxer();
      await this._loadResource();
      if (!this.store.metadata || !this.store.frames.length) {
        throw new PlayerError('DEMUX_FAILED', 'demux', '本地资源不包含可播放的视频帧。');
      }

      await this._initializeMedia();
      this._reportTechnicalPath('success', 'Resource Ready');
      return this._createLoadInfo();
    } catch (error) {
      const playerError = PlayerError.from(error, 'PLAYBACK_FAILED', 'playback');
      this._reportTechnicalPath('error', playerError.message);
      this.dispose();
      throw playerError;
    }
  }

  /** 仅由页面入口在 resourceReady 之后调用，不提供暂停或重播。 */
  async start() {
    if (this.started || this.failed || this.disposed) return;
    this.started = true;

    try {
      await this.audioClock?.start();
      if (this.failed || this.disposed) return;
      this.playbackStartedAt = performance.now();
      this.playing = true;
      this._reportTechnicalPath('success', 'Playing');
      this.onPlayingChange(true, 'playing');
      this._decodeAhead();
      this.animationId = requestAnimationFrame(this.renderFrame);
    } catch (error) {
      this._fail(PlayerError.from(error, 'AUDIO_FAILED', 'audio', '音频播放失败。'));
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.playing = false;
    this.resourceReader?.cancel();
    cancelAnimationFrame(this.animationId);
    this.animationId = 0;
    this.audioClock?.dispose();
    this._closeBufferedFrames();
    this._closeDecoders();
    this.renderer?.destroy();
  }

  async _loadResource() {
    this._notifyCacheProgress(false);
    let streamStarted = false;

    try {
      for await (const bytes of this.resourceReader.read()) {
        if (!streamStarted) {
          streamStarted = true;
          this._reportTechnicalPath('success', 'Native Bridge');
          this._reportTechnicalPath('success', 'Chunked Resource');
        }

        let output;
        try {
          output = this.demuxer.append(bytes);
        } catch (error) {
          throw PlayerError.from(error, 'DEMUX_FAILED', 'demux');
        }
        this._acceptDemuxed(output);
        this.store.sourceBytes = this.resourceReader.loadedBytes;
        this._notifyCacheProgress(false);
      }
    } catch (error) {
      throw PlayerError.from(error, 'BRIDGE_FAILED', 'resource');
    }

    try {
      this._acceptDemuxed(this.demuxer.finish());
    } catch (error) {
      throw PlayerError.from(error, 'DEMUX_FAILED', 'demux');
    }
    this.store.finish(this.resourceReader.loadedBytes);
    this._notifyCacheProgress(true);
  }

  _acceptDemuxed(output) {
    this.store.append(output);
    if (output.metadata) {
      this._reportTechnicalPath('success', 'WebM Demux');
      if (output.metadata.audio) this._reportTechnicalPath('success', 'Opus Track');
    }
    if (output.frames.length) {
      this._reportTechnicalPath('success', 'VP9 Color Track');
      this._reportTechnicalPath('success', 'VP9 Alpha Track');
    }
    if (this.store.metadata) this.onVideoInfoChange(this._createVideoInfo());
  }

  async _initializeMedia() {
    const metadata = this.store.metadata;
    this.canvas.width = metadata.width;
    this.canvas.height = metadata.height;

    try {
      if (!this.webGpuEnabled) this._reportTechnicalPath('info', 'WebGPU Disabled');
      this.renderer = await RendererFactory.create(this.canvas, {
        webGpuEnabled: this.webGpuEnabled,
      });
    } catch (error) {
      throw PlayerError.from(error, 'RENDERER_FAILED', 'renderer');
    }

    this.canvas = this.renderer.canvas;
    if (this.webGpuEnabled && this.renderer.name === 'WebGL') {
      this._reportTechnicalPath('warning', 'WebGPU Failed');
      this._reportTechnicalPath('info', 'Fallback to WebGL');
    }
    this._reportTechnicalPath('success', `${this.renderer.name} Renderer`);
    this._reportTechnicalPath(
      'success',
      this.renderer.name === 'WebGPU' ? 'WGSL Alpha Compose' : 'GLSL Alpha Compose'
    );

    this.decoderConfig = await this._getDecoderConfig(
      metadata.codec,
      metadata.width,
      metadata.height
    );
    this._createDecoders();

    if (!this.audioEnabled) {
      this._reportTechnicalPath('info', 'Audio Disabled');
      return;
    }
    if (!metadata.audio) {
      throw new PlayerError('AUDIO_FAILED', 'audio', '启用音频时，WebM 必须包含 Opus 音轨。');
    }

    try {
      this.audioClock = new WebAudioClock(metadata.audio, {
        onError: (error) => this._fail(PlayerError.from(error, 'AUDIO_FAILED', 'audio')),
      });
      await this.audioClock.initialize();
      for (const chunk of this.store.audioChunks) this.audioClock.append(chunk);
      await this.audioClock.end();
      this.store.audioChunks = [];
      this._reportTechnicalPath('success', 'Opus AudioDecoder');
      this._reportTechnicalPath('success', 'Web Audio Clock');
      this._reportDurationDifference();
    } catch (error) {
      throw PlayerError.from(error, 'AUDIO_FAILED', 'audio');
    }
  }

  _reportDurationDifference() {
    if (!this.audioClock?.durationUs || !this.store.videoBufferedEndUs) return;
    const differenceUs = Math.abs(this.audioClock.durationUs - this.store.videoBufferedEndUs);
    if (differenceUs > AUDIO_DURATION_TOLERANCE_US) {
      this._reportTechnicalPath('warning', 'Audio Duration Mismatch');
    }
  }

  _notifyCacheProgress(complete) {
    this.onCacheProgress({
      loadedBytes: this.resourceReader?.loadedBytes ?? 0,
      totalBytes: this.resourceReader?.totalBytes ?? 0,
      complete,
    });
  }

  _createLoadInfo() {
    return {
      ...this._createVideoInfo(),
      sourceBytes: this.store.sourceBytes,
      resourceComplete: this.store.complete,
      renderer: this.renderer.name,
      fallbackReason: this.renderer.fallbackReason ?? '',
      audioEnabled: Boolean(this.audioClock),
    };
  }

  _createVideoInfo() {
    const durationUs = this.store.videoBufferedEndUs;
    return {
      width: this.store.metadata.width,
      height: this.store.metadata.height,
      frames: this.store.frames.length,
      fps: durationUs ? this.store.frames.length / (durationUs / 1_000_000) : 0,
      duration: durationUs / 1_000_000,
    };
  }

  async _getDecoderConfig(codec, width, height) {
    try {
      const support = await VideoDecoder.isConfigSupported({
        codec,
        codedWidth: width,
        codedHeight: height,
        hardwareAcceleration: 'prefer-hardware',
        optimizeForLatency: true,
      });
      if (!support.supported) throw new Error(`当前环境不支持 ${codec}。`);
      this._reportTechnicalPath('success', 'VP9 Decoder Supported');
      return support.config;
    } catch (error) {
      throw PlayerError.from(error, 'DECODER_FAILED', 'decoder');
    }
  }

  _createDecoders() {
    try {
      this.colorDecoder = new VideoDecoder({
        output: (frame) => this._acceptFrame('color', frame),
        error: (error) => this._fail(PlayerError.from(error, 'DECODER_FAILED', 'decoder')),
      });
      this.alphaDecoder = new VideoDecoder({
        output: (frame) => this._acceptFrame('alpha', frame),
        error: (error) => this._fail(PlayerError.from(error, 'DECODER_FAILED', 'decoder')),
      });
      this.colorDecoder.configure(this.decoderConfig);
      this._reportTechnicalPath('success', 'Color VideoDecoder');
      this.alphaDecoder.configure(this.decoderConfig);
      this._reportTechnicalPath('success', 'Alpha VideoDecoder');
    } catch (error) {
      throw PlayerError.from(error, 'DECODER_FAILED', 'decoder');
    }
  }

  _submitPair(pair) {
    this.colorDecoder.decode(this._createChunk(pair.color, pair));
    this.alphaDecoder.decode(this._createChunk(pair.alpha, pair));
    this.store.frames[this.nextPairIndex] = null;
    this.nextPairIndex += 1;
    this.pairsInFlight += 1;
  }

  _createChunk(frame, pair) {
    return new EncodedVideoChunk({
      type: frame.type,
      timestamp: pair.timestamp,
      duration: pair.duration,
      data: frame.data,
    });
  }

  _acceptFrame(channel, frame) {
    if (this.failed || this.disposed) {
      frame.close();
      return;
    }
    const pair = this.partialPairs.get(frame.timestamp) ?? { timestamp: frame.timestamp };
    pair[channel]?.close();
    pair[channel] = frame;
    this.partialPairs.set(frame.timestamp, pair);
    if (!pair.color || !pair.alpha) return;

    this._reportTechnicalPath('success', 'Color + Alpha Pair');
    this.partialPairs.delete(frame.timestamp);
    this.pairsInFlight = Math.max(0, this.pairsInFlight - 1);
    this.decodedPairs.push(pair);
    this.decodedPairs.sort((left, right) => left.timestamp - right.timestamp);
  }

  _decodeAhead() {
    if (
      !this.playing
      || this.failed
      || this.colorDecoder?.state !== 'configured'
      || this.alphaDecoder?.state !== 'configured'
    ) return;

    try {
      while (
        this.nextPairIndex < this.store.frames.length
        && this.decodedPairs.length + this.pairsInFlight + this.renderingPairs < MAX_BUFFERED_PAIRS
      ) {
        this._submitPair(this.store.frames[this.nextPairIndex]);
      }
    } catch (error) {
      this._fail(PlayerError.from(error, 'DECODER_FAILED', 'decoder'));
    }
  }

  _render(now) {
    if (!this.playing || this.failed) return;
    this.audioClock?.schedule();
    this.currentTimeUs = this._readClock(now);

    if (this.currentTimeUs >= this._getDurationUs()) {
      this._finishPlayback();
      return;
    }

    this._drawThrough(this.currentTimeUs);
    this._decodeAhead();
    this.animationId = requestAnimationFrame(this.renderFrame);
  }

  _readClock(now) {
    const timestampUs = this.audioClock
      ? this.audioClock.currentTimeUs
      : (now - this.playbackStartedAt) * 1000;
    return Math.min(Math.max(timestampUs, 0), this._getDurationUs());
  }

  _drawThrough(timestampUs) {
    let selectedPair = null;
    while (this.decodedPairs.length && this.decodedPairs[0].timestamp <= timestampUs) {
      if (selectedPair) TransparentWebmPlayer._closePair(selectedPair);
      selectedPair = this.decodedPairs.shift();
    }
    if (selectedPair) this._drawPair(selectedPair);
  }

  _drawPair(pair) {
    this.renderingPairs += 1;
    this.renderer.render(pair)
      .then(() => this._reportTechnicalPath('success', 'First Frame Rendered'))
      .catch((error) => this._fail(PlayerError.from(error, 'RENDERER_FAILED', 'renderer')))
      .finally(() => {
        TransparentWebmPlayer._closePair(pair);
        this.renderingPairs = Math.max(0, this.renderingPairs - 1);
        this._decodeAhead();
      });
  }

  _finishPlayback() {
    const durationUs = this._getDurationUs();
    this.currentTimeUs = durationUs;
    this._drawThrough(durationUs);
    this.playing = false;
    this.audioClock?.stop();
    this.animationId = 0;
    this.onPlayingChange(false, 'ended');
  }

  _getDurationUs() {
    return this.audioClock?.durationUs
      ? Math.min(this.audioClock.durationUs, this.store.videoBufferedEndUs)
      : this.store.videoBufferedEndUs;
  }

  _fail(error) {
    if (this.failed || this.disposed) return;
    this.failed = true;
    this.playing = false;
    cancelAnimationFrame(this.animationId);
    this.animationId = 0;
    this.audioClock?.stop();
    this._closeBufferedFrames();
    this._closeDecoders();
    this._reportTechnicalPath('error', error.message);
    this.onError(error);
    this.onPlayingChange(false, 'failed');
  }

  _closeBufferedFrames() {
    for (const pair of this.partialPairs.values()) {
      pair.color?.close();
      pair.alpha?.close();
    }
    this.partialPairs.clear();
    for (const pair of this.decodedPairs) TransparentWebmPlayer._closePair(pair);
    this.decodedPairs = [];
  }

  _closeDecoders() {
    for (const decoder of [this.colorDecoder, this.alphaDecoder]) {
      if (decoder && decoder.state !== 'closed') decoder.close();
    }
  }

  _reportTechnicalPath(type, message) {
    this.onTechnicalPath(type, message);
  }

  static _closePair(pair) {
    pair.color.close();
    pair.alpha.close();
  }
}
