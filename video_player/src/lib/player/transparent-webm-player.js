import { WebAudioClock } from '../audio/web-audio-clock.js';
import { IncrementalWebmDemuxer } from '../demuxers/incremental-webm-demuxer.js';
import { RendererFactory } from '../renderers/renderer-factory.js';
import { FetchStreamRequest } from '../../network/fetch-stream-request.js';
import { EncodedMediaStore } from '../../store/encoded-media-store.js';
import { PlaybackBufferController } from './playback-buffer-controller.js';

const MAX_BUFFERED_PAIRS = 8;
const AUDIO_DURATION_TOLERANCE_US = 50_000;

/**
 * 透明 WebM 播放器：持续读取单个 WebM 响应，增量完成 Demux、双 VideoDecoder
 * 和 WebGPU/WebGL 合成。所有媒体缓存只存在内存，dispose() 时统一释放。
 */
export class TransparentWebmPlayer {
  constructor({
    canvas,
    sourceUrl,
    startupBufferMs = 500,
    resumeBufferMs = 300,
    audioEnabled = false,
    webGpuEnabled = true,
    onCacheProgress = () => {},
    onVideoInfoChange = () => {},
    onError = () => {},
    onPlayingChange = () => {},
  }) {
    this.canvas = canvas;
    this.sourceUrl = sourceUrl;
    this.audioEnabled = audioEnabled;
    this.webGpuEnabled = webGpuEnabled;
    this.onCacheProgress = onCacheProgress;
    this.onVideoInfoChange = onVideoInfoChange;
    this.onError = onError;
    this.onPlayingChange = onPlayingChange;
    this.bufferController = new PlaybackBufferController({
      startupBufferMs,
      resumeBufferMs,
      audioEnabled,
    });

    this.renderer = null;
    this.decoderConfig = null;
    this.colorDecoder = null;
    this.alphaDecoder = null;
    this.audioClock = null;
    this.demuxer = null;
    this.request = null;
    this.abortController = null;
    this.store = new EncodedMediaStore();
    this.nextPairIndex = 0;
    this.nextAudioIndex = 0;

    this.partialPairs = new Map();
    this.decodedPairs = [];
    this.pairsInFlight = 0;
    this.renderingPairs = 0;
    this.currentTimeUs = 0;
    this.playbackStartedAt = 0;
    this.animationId = 0;
    this.waiters = [];

    this.playing = false;
    this.wantsToPlay = false;
    this.starting = false;
    this.ready = false;
    this.failed = false;
    this.disposed = false;
    this.loadingError = null;
    this.audioInitialized = false;
    this.audioEnded = false;
    this.renderFrame = (now) => this._render(now);
  }

  /**
   * load() 在“可开始播放”时返回；剩余资源仍会在后台持续读取和解析。
   * 因此页面无需等待整个短视频完成下载，仍可在首段缓冲就绪后显示首帧。
   */
  async load() {
    if (!('VideoDecoder' in window) || !('EncodedVideoChunk' in window)) {
      throw new Error('当前环境不支持 VideoDecoder。');
    }

    try {
      this.abortController = new AbortController();
      this.demuxer = new IncrementalWebmDemuxer();
      this.loadingPromise = this._loadResource().catch((error) => {
        if (!this.disposed) {
          this.loadingError = error;
          this._notifyMediaChanged();
          this._fail(error);
        }
      });

      await this._waitFor(() => Boolean(this.store.metadata));
      await this._initializeMedia();
      await this._waitFor(() => this.bufferController.canStart(
        this.store,
        this.audioClock,
        0
      ));

      this.ready = true;
      this._submitPair(this.store.frames[0]);
      return this._createLoadInfo();
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  toggle() {
    if (this.wantsToPlay || this.playing) this.pause();
    else void this.play();
  }

  /** 用户点击后才恢复 AudioContext，满足浏览器自动播放策略。 */
  async play() {
    if (!this.ready || this.failed || this.disposed) return;
    if (this.store.complete && this.currentTimeUs >= this._getDurationUs()) this._prepareReplay();
    this.wantsToPlay = true;
    await this._startPlayback();
  }

  pause() {
    if (!this.wantsToPlay && !this.playing) return;
    this.wantsToPlay = false;
    this.currentTimeUs = this._readClock(performance.now());
    this.playing = false;
    this.audioClock?.pause();
    cancelAnimationFrame(this.animationId);
    this.animationId = 0;
    this._drawThrough(this.currentTimeUs);
    this.onPlayingChange(false, 'paused');
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.playing = false;
    this.wantsToPlay = false;
    this.abortController?.abort();
    cancelAnimationFrame(this.animationId);
    this._resolveWaiters();
    this.audioClock?.dispose();
    this._closeBufferedFrames();
    this._closeDecoders();
    this.renderer?.destroy();
  }

  async _loadResource() {
    this.request = new FetchStreamRequest({
      sourceUrl: this.sourceUrl,
      signal: this.abortController.signal,
    });
    this._notifyCacheProgress(false);

    for await (const bytes of this.request.read()) {
      this._acceptDemuxed(this.demuxer.append(bytes));
      this.store.sourceBytes = this.request.loadedBytes;
      this._notifyCacheProgress(false);
    }
    this._acceptDemuxed(this.demuxer.finish());
    this.store.finish(this.request.loadedBytes);
    this._notifyCacheProgress(true);
    await this._completeAudioInput();
    this._validateDurations();
    this._notifyMediaChanged();
  }

  _acceptDemuxed(output) {
    this.store.append(output);
    if (this.store.metadata) this.onVideoInfoChange(this._createVideoInfo());
    this._feedAudioChunks();
    this._notifyMediaChanged();
  }

  async _initializeMedia() {
    const metadata = this.store.metadata;
    this.canvas.width = metadata.width;
    this.canvas.height = metadata.height;
    this.renderer = await RendererFactory.create(this.canvas, {
      webGpuEnabled: this.webGpuEnabled,
    });
    this.canvas = this.renderer.canvas;
    this.decoderConfig = await this._getDecoderConfig(
      metadata.codec,
      metadata.width,
      metadata.height
    );
    this._createDecoders();

    if (this.audioEnabled) {
      if (!metadata.audio) throw new Error('启用音频时，WebM 必须包含 Opus 音轨。');
      this.audioClock = new WebAudioClock(metadata.audio, {
        onBufferChange: () => this._notifyMediaChanged(),
        onError: (error) => this._fail(error),
      });
      await this.audioClock.initialize();
      this.audioInitialized = true;
      this._feedAudioChunks();
      await this._completeAudioInput();
      this._validateDurations();
    }
  }

  _feedAudioChunks() {
    if (!this.audioInitialized || !this.audioClock) return;
    while (this.nextAudioIndex < this.store.audioChunks.length) {
      this.audioClock.append(this.store.audioChunks[this.nextAudioIndex]);
      this.nextAudioIndex += 1;
    }
  }

  async _completeAudioInput() {
    if (
      !this.audioEnabled
      || !this.store.complete
      || !this.audioInitialized
      || !this.audioClock
      || this.audioEnded
    ) {
      return;
    }
    this.audioEnded = true;
    await this.audioClock.end();
  }

  _validateDurations() {
    if (!this.audioClock?.durationUs || !this.store.videoBufferedEndUs) return;
    if (Math.abs(this.audioClock.durationUs - this.store.videoBufferedEndUs) > AUDIO_DURATION_TOLERANCE_US) {
      throw new Error(
        `音视频时长不一致：视频 ${this.store.videoBufferedEndUs}μs，音频 ${this.audioClock.durationUs}μs。`
      );
    }
  }

  async _waitFor(predicate) {
    while (!predicate()) {
      if (this.loadingError) throw this.loadingError;
      if (this.disposed) throw new Error('播放器已释放。');
      await new Promise((resolve) => this.waiters.push(resolve));
    }
  }

  _notifyMediaChanged() {
    this._resolveWaiters();
    if (this.wantsToPlay && this.ready && !this.playing) void this._startPlayback();
  }

  /** 向页面报告网络缓存字节数；它和媒体播放进度是两套独立状态。 */
  _notifyCacheProgress(complete) {
    this.onCacheProgress({
      loadedBytes: this.request?.loadedBytes ?? 0,
      totalBytes: this.request?.totalBytes ?? 0,
      complete,
    });
  }

  _resolveWaiters() {
    const waiters = this.waiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  _createLoadInfo() {
    return {
      ...this._createVideoInfo(),
      sourceBytes: this.store.sourceBytes,
      downloadComplete: this.store.complete,
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

  async _startPlayback() {
    if (
      this.starting
      || this.playing
      || !this.wantsToPlay
      || !this.bufferController.canContinue(this.store, this.audioClock, this.currentTimeUs)
    ) {
      return;
    }

    this.starting = true;
    try {
      await this.audioClock?.playFrom(this.currentTimeUs);
      if (!this.wantsToPlay || this.failed || this.disposed) return;
      this.playbackStartedAt = performance.now() - this.currentTimeUs / 1000;
      this.playing = true;
      this.onPlayingChange(true, 'playing');
      this._decodeAhead();
      this.animationId = requestAnimationFrame(this.renderFrame);
    } catch (error) {
      this._fail(new Error(`音频播放失败：${error.message}`));
    } finally {
      this.starting = false;
    }
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
    this.alphaDecoder.configure(this.decoderConfig);
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
    if (!this.playing && this.currentTimeUs === 0) this._drawThrough(0);
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
      this._fail(error);
    }
  }

  _render(now) {
    if (!this.playing || this.failed) return;
    this.audioClock?.schedule();
    this.currentTimeUs = this._readClock(now);

    if (this.store.complete && this.currentTimeUs >= this._getDurationUs()) {
      this._finishPlayback();
      return;
    }

    if (!this.bufferController.canContinue(this.store, this.audioClock, this.currentTimeUs)) {
      this._pauseForBuffering();
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
    const maximum = this.store.complete ? this.store.videoBufferedEndUs : Number.POSITIVE_INFINITY;
    return Math.min(Math.max(timestampUs, 0), maximum);
  }

  _pauseForBuffering() {
    this.currentTimeUs = this._readClock(performance.now());
    this.playing = false;
    this.audioClock?.pause();
    this.animationId = 0;
    this.onPlayingChange(false, 'buffering');
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
      .catch((error) => this._fail(error))
      .finally(() => {
        TransparentWebmPlayer._closePair(pair);
        this.renderingPairs = Math.max(0, this.renderingPairs - 1);
        this._decodeAhead();
      });
  }

  /** 播放完成后保留压缩数据，再次点击时只重置 Decoder 和帧索引。 */
  _prepareReplay() {
    this.colorDecoder.reset();
    this.alphaDecoder.reset();
    this.colorDecoder.configure(this.decoderConfig);
    this.alphaDecoder.configure(this.decoderConfig);
    this._closeBufferedFrames();
    this.nextPairIndex = 0;
    this.pairsInFlight = 0;
    this.currentTimeUs = 0;
    this.playbackStartedAt = 0;
  }

  /** 到达媒体末尾时停止音视频，不自动循环；最后一帧继续留在 Canvas 上。 */
  _finishPlayback() {
    const durationUs = this._getDurationUs();
    this.currentTimeUs = durationUs;
    this._drawThrough(durationUs);
    this.playing = false;
    this.wantsToPlay = false;
    this.audioClock?.pause();
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
    this.wantsToPlay = false;
    cancelAnimationFrame(this.animationId);
    this.animationId = 0;
    this.audioClock?.pause();
    this._closeBufferedFrames();
    this._closeDecoders();
    this._resolveWaiters();
    this.onPlayingChange(false, 'failed');
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

  static _closePair(pair) {
    pair.color.close();
    pair.alpha.close();
  }
}
