import { WebAudioClock } from '../audio/web-audio-clock.js';
import { WebmDemuxer } from '../demuxers/webm-demuxer.js';
import { RendererFactory } from '../renderers/renderer-factory.js';
import { EncodedMediaStore } from '../../store/encoded-media-store.js';

// 这是解码/渲染执行窗口，不是网络缓冲。它只限制同时存活的 VideoFrame 数量。
const MAX_DECODED_PAIRS = 8;
const AUDIO_DURATION_TOLERANCE_US = 50_000;
const NOOP = () => {};

/**
 * 一次性透明 WebM 播放器。
 *
 * load() 只接受完整媒体数据；播放器本身没有 URL、Fetch、流式输入或再缓冲状态。
 * 每一份媒体创建一个实例，播放结束后由页面 Session Controller 统一 dispose()。
 */
export class TransparentWebmPlayer {
  constructor({
    canvas,
    audioEnabled = true,
    webGpuEnabled = true,
    onVideoInfoChange = NOOP,
    onError = NOOP,
    onPlaying = NOOP,
    onEnded = NOOP,
    onTechnicalPath = NOOP,
  }) {
    this.canvas = canvas;
    this.audioEnabled = audioEnabled;
    this.webGpuEnabled = webGpuEnabled;
    this.onVideoInfoChange = onVideoInfoChange;
    this.onError = onError;
    this.onPlaying = onPlaying;
    this.onEnded = onEnded;
    this.onTechnicalPath = onTechnicalPath;

    this.store = new EncodedMediaStore();
    this.renderer = null;
    this.decoderConfig = null;
    this.colorDecoder = null;
    this.alphaDecoder = null;
    this.audioClock = null;
    this.nextPairIndex = 0;

    this.partialPairs = new Map();
    this.decodedPairs = [];
    this.pairsInFlight = 0;
    this.renderingPairs = 0;
    this.currentTimeUs = 0;
    this.playbackStartedAt = 0;
    this.animationId = 0;

    this.playing = false;
    this.starting = false;
    this.started = false;
    this.ready = false;
    this.failed = false;
    this.disposed = false;
    this.firstFrameRendered = false;
    this.firstFrameResolve = null;
    this.firstFrameReject = null;
    this.renderFrame = (now) => this._render(now);
  }

  /**
   * 完整解析媒体、初始化解码和渲染，并等待首帧真正画到 Canvas 后返回。
   * 该返回点就是 Bridge 的 loaded 语义，不再表示“启动缓冲已满足”。
   */
  async load(mediaData) {
    if (this.disposed) throw new Error('播放器已释放。');
    if (this.ready || this.store.metadata) throw new Error('播放器已经加载过媒体。');

    try {
      if (!('VideoDecoder' in window) || !('EncodedVideoChunk' in window)) {
        throw new Error('当前环境不支持 VideoDecoder。');
      }
      this._reportTechnicalPath('success', 'WebCodecs VideoDecoder');
      const mediaBuffer = TransparentWebmPlayer._toArrayBuffer(mediaData);
      const media = WebmDemuxer.parse(mediaBuffer);
      this.store.load(media, mediaBuffer.byteLength);
      this._reportTechnicalPath('success', 'Complete WebM Data');
      this._reportTechnicalPath('success', 'WebM Demux');
      this._reportTechnicalPath('success', 'VP9 Color Track');
      this._reportTechnicalPath('success', 'VP9 Alpha Track');
      if (media.audio) this._reportTechnicalPath('success', 'Opus Track');

      this.onVideoInfoChange(this._createVideoInfo());
      await this._initializeMedia();
      this.ready = true;

      const firstFrameReady = new Promise((resolve, reject) => {
        this.firstFrameResolve = resolve;
        this.firstFrameReject = reject;
      });
      this._submitPair(this.store.frames[0]);
      await firstFrameReady;
      return this._createLoadInfo();
    } catch (error) {
      this._fail(error);
      this.dispose();
      throw error;
    }
  }

  /** 从 0 开始一次性播放；启动后不提供暂停、恢复或内部重播。 */
  async start() {
    if (!this.ready || this.failed || this.disposed) {
      throw new Error('播放器尚未就绪或已经释放。');
    }
    if (this.started || this.starting || this.playing) return;

    this.started = true;
    this.starting = true;
    try {
      await this.audioClock?.start();
      if (this.failed || this.disposed) return;
      this.playbackStartedAt = performance.now();
      this.playing = true;
      this._reportTechnicalPath('success', 'Playing');
      this.onPlaying();
      // 宿主可能在 playing 事件中同步 clear/replace，不能再为旧 Session 启动 rAF。
      if (this.failed || this.disposed) return;
      this._decodeAhead();
      this.animationId = requestAnimationFrame(this.renderFrame);
    } catch (error) {
      const playbackError = new Error(`音频播放失败：${error.message}`);
      this._fail(playbackError);
      throw playbackError;
    } finally {
      this.starting = false;
    }
  }

  /**
   * 幂等释放本视频拥有的全部显式资源，并断开完整媒体 ArrayBuffer 的引用。
   * JS Heap 的实际归还时机由 WebView 的垃圾回收器决定。
   */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.ready = false;
    this.playing = false;
    cancelAnimationFrame(this.animationId);
    this.animationId = 0;

    this.firstFrameReject?.(new Error('播放器在首帧渲染前已释放。'));
    this.firstFrameResolve = null;
    this.firstFrameReject = null;
    this.audioClock?.dispose();
    this._closeBufferedFrames();
    this._closeDecoders();
    this.renderer?.destroy();
    this.store.clear();

    this.audioClock = null;
    this.colorDecoder = null;
    this.alphaDecoder = null;
    this.renderer = null;
    this.decoderConfig = null;
    this.onVideoInfoChange = NOOP;
    this.onError = NOOP;
    this.onPlaying = NOOP;
    this.onEnded = NOOP;
    this.onTechnicalPath = NOOP;
  }

  async _initializeMedia() {
    const metadata = this.store.metadata;
    this.canvas.width = metadata.width;
    this.canvas.height = metadata.height;
    if (!this.webGpuEnabled) this._reportTechnicalPath('info', 'WebGPU Disabled');
    this.renderer = await RendererFactory.create(this.canvas, {
      webGpuEnabled: this.webGpuEnabled,
    });
    // RendererFactory 在 WebGPU 初始化后失败时可能替换 Canvas。
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
    if (!metadata.audio) throw new Error('启用音频时，WebM 必须包含 Opus 音轨。');

    this.audioClock = new WebAudioClock(metadata.audio, {
      onError: (error) => this._fail(error),
    });
    await this.audioClock.initialize();
    this._reportTechnicalPath('success', 'Opus AudioDecoder');
    this._reportTechnicalPath('success', 'Web Audio Clock');

    // 媒体已经完整，所有 Opus packet 一次送入并立即 flush，不存在后续缓冲输入。
    for (const chunk of this.store.audioChunks) this.audioClock.append(chunk);
    await this.audioClock.end();
    this._validateDurations();
  }

  _validateDurations() {
    if (!this.audioClock?.durationUs || !this.store.videoDurationUs) return;
    if (Math.abs(this.audioClock.durationUs - this.store.videoDurationUs) > AUDIO_DURATION_TOLERANCE_US) {
      throw new Error(
        `音视频时长不一致：视频 ${this.store.videoDurationUs}μs，音频 ${this.audioClock.durationUs}μs。`
      );
    }
  }

  _createLoadInfo() {
    return {
      ...this._createVideoInfo(),
      sourceBytes: this.store.sourceBytes,
      renderer: this.renderer.name,
      fallbackReason: this.renderer.fallbackReason ?? '',
      audioEnabled: Boolean(this.audioClock),
    };
  }

  _createVideoInfo() {
    const durationUs = this.store.videoDurationUs;
    return {
      width: this.store.metadata.width,
      height: this.store.metadata.height,
      frames: this.store.frames.length,
      fps: durationUs ? this.store.frames.length / (durationUs / 1_000_000) : 0,
      duration: durationUs / 1_000_000,
    };
  }

  async _getDecoderConfig(codec, width, height) {
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
  }

  _createDecoders() {
    this.colorDecoder = new VideoDecoder({
      output: (frame) => this._acceptFrame('color', frame),
      error: (error) => this._fail(error),
    });
    this.alphaDecoder = new VideoDecoder({
      output: (frame) => this._acceptFrame('alpha', frame),
      error: (error) => this._fail(error),
    });
    this.colorDecoder.configure(this.decoderConfig);
    this._reportTechnicalPath('success', 'Color VideoDecoder');
    this.alphaDecoder.configure(this.decoderConfig);
    this._reportTechnicalPath('success', 'Alpha VideoDecoder');
  }

  _submitPair(pair) {
    this.colorDecoder.decode(this._createChunk(pair.color, pair));
    this.alphaDecoder.decode(this._createChunk(pair.alpha, pair));
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

    this.partialPairs.delete(frame.timestamp);
    this.pairsInFlight = Math.max(0, this.pairsInFlight - 1);
    this.decodedPairs.push(pair);
    this.decodedPairs.sort((left, right) => left.timestamp - right.timestamp);
    // 首帧时间戳不一定严格为 0，loaded 仍必须等待这对帧完成实际渲染。
    if (!this.playing && !this.firstFrameRendered) this._drawThrough(pair.timestamp);
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
        && this.decodedPairs.length + this.pairsInFlight + this.renderingPairs < MAX_DECODED_PAIRS
      ) {
        this._submitPair(this.store.frames[this.nextPairIndex]);
      }
    } catch (error) {
      this._fail(error);
    }
  }

  _render(now) {
    if (!this.playing || this.failed || this.disposed) return;
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
      .then(() => {
        if (!this.firstFrameRendered) {
          this.firstFrameRendered = true;
          this._reportTechnicalPath('success', 'First Frame Rendered');
          this.firstFrameResolve?.();
          this.firstFrameResolve = null;
          this.firstFrameReject = null;
        }
      })
      .catch((error) => this._fail(error))
      .finally(() => {
        TransparentWebmPlayer._closePair(pair);
        this.renderingPairs = Math.max(0, this.renderingPairs - 1);
        this._decodeAhead();
      });
  }

  /** 到达末尾只报告 ended；Session Controller 随后销毁本实例，不保留重播数据。 */
  _finishPlayback() {
    const durationUs = this._getDurationUs();
    this.currentTimeUs = durationUs;
    this._drawThrough(durationUs);
    this.playing = false;
    this.audioClock?.stop();
    this.animationId = 0;
    this.onEnded();
  }

  _getDurationUs() {
    return this.audioClock?.durationUs
      ? Math.min(this.audioClock.durationUs, this.store.videoDurationUs)
      : this.store.videoDurationUs;
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
    this.firstFrameReject?.(error);
    this.firstFrameResolve = null;
    this.firstFrameReject = null;
    this._reportTechnicalPath('error', error.message);
    this.onError(error);
    console.error(error);
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

  static _toArrayBuffer(mediaData) {
    if (mediaData instanceof ArrayBuffer) return mediaData;
    if (!ArrayBuffer.isView(mediaData)) throw new Error('媒体数据必须是完整的二进制数据。');
    const bytes = new Uint8Array(mediaData.buffer, mediaData.byteOffset, mediaData.byteLength);
    return bytes.slice().buffer;
  }

  static _closePair(pair) {
    pair.color.close();
    pair.alpha.close();
  }
}
