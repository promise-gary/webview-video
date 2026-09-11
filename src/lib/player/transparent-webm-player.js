import { WebAudioClock } from '../audio/web-audio-clock.js';
import { WebmDemuxer } from '../demuxers/webm-demuxer.js';
import { RendererFactory } from '../renderers/renderer-factory.js';
import { EncodedMediaStore } from '../../store/encoded-media-store.js';

// 这是解码/渲染执行窗口，不是网络缓冲。它只限制同时存活的 VideoFrame 数量。
const MAX_DECODED_FRAMES = 4;
const AUDIO_DURATION_TOLERANCE_US = 50_000;
const NOOP = () => {};

/**
 * 一次性透明 WebM 播放器。
 *
 * load() 只接受完整媒体数据；播放器本身没有 URL、Fetch、流式输入或再缓冲状态。
 * 每一份媒体创建一个实例，播放结束后由串行控制器统一 await dispose()。
 */
export class TransparentWebmPlayer {
  constructor({
    canvas,
    renderer = null,
    reuseRenderer = false,
    audioEnabled = false,
    webGpuEnabled = true,
    diagnostics,
    fileName,
    onRendererCreated = NOOP,
    onVideoInfoChange = NOOP,
  }) {
    this.canvas = canvas;
    this.renderer = renderer;
    this.reuseRenderer = reuseRenderer;
    this.audioEnabled = audioEnabled;
    this.webGpuEnabled = webGpuEnabled;
    this.diagnostics = diagnostics;
    this.fileName = fileName;
    this.onRendererCreated = onRendererCreated;
    this.onVideoInfoChange = onVideoInfoChange;

    this.store = new EncodedMediaStore();
    this.decoder = null;
    this.audioClock = null;
    this.nextFrameIndex = 0;

    this.decodedFrames = [];
    this.framesInFlight = 0;
    this.pendingRenderFrame = null;
    this.renderPromise = null;
    this.decoderDrainPromise = null;
    this.decodersFlushed = false;
    this.rendererCreationPromise = null;
    this.disposePromise = null;
    this.currentTimeUs = 0;
    this.playbackStartedAt = 0;
    this.animationId = 0;
    this.renderedFrameCount = 0;
    this.lastStatsLoggedAt = 0;

    this.playing = false;
    this.started = false;
    this.ready = false;
    this.failed = false;
    this.disposed = false;
    this.ending = false;
    this.firstFrameRendered = false;
    this.firstFrameResolve = null;
    this.firstFrameReject = null;
    this.playbackResolve = null;
    this.playbackReject = null;
    this.renderFrame = (now) => this._render(now);
  }

  /**
   * 完整解析媒体、初始化解码和渲染，并等待首帧真正画到 Canvas 后返回。
   * 返回前首帧已经完成绘制。
   */
  async load(mediaData) {
    if (this.disposed) throw new Error('播放器已释放。');
    if (this.ready || this.store.metadata) throw new Error('播放器已经加载过媒体。');

    try {
      this.diagnostics.info('player.load.begin', {
        fileName: this.fileName,
        mediaBytes: mediaData.byteLength,
      });
      if (!('VideoDecoder' in window) || !('EncodedVideoChunk' in window)) {
        throw new Error('当前环境不支持 VideoDecoder。');
      }
      const mediaBuffer = TransparentWebmPlayer._toArrayBuffer(mediaData);
      const media = WebmDemuxer.parse(mediaBuffer, {
        audioEnabled: this.audioEnabled,
      });
      this.store.load(media);
      this.diagnostics.info('player.demux.complete', {
        fileName: this.fileName,
        width: media.width,
        height: media.height,
        frames: media.frames.length,
        durationUs: media.duration,
      });
      this.onVideoInfoChange(this._createVideoInfo());
      await this._initializeMedia();
      this.ready = true;

      const firstFrameReady = new Promise((resolve, reject) => {
        this.firstFrameResolve = resolve;
        this.firstFrameReject = reject;
      });
      this._submitFrame(this.store.frames[0]);
      await firstFrameReady;
      this._assertLoadingActive();
      this.diagnostics.info('player.first-frame.complete', { fileName: this.fileName });
      return this._createLoadInfo();
    } catch (error) {
      this.diagnostics.error('player.load.failed', error, { fileName: this.fileName });
      this._fail(error);
      throw error;
    }
  }

  /** 从 0 开始一次性播放；启动后不提供暂停、恢复或内部重播。 */
  async start() {
    if (!this.ready || this.failed || this.disposed) {
      throw new Error('播放器尚未就绪或已经释放。');
    }
    if (this.started) return;

    this.started = true;
    try {
      await this.audioClock?.start();
    } catch (error) {
      const playbackError = new Error(`音频播放失败：${error.message}`);
      this._fail(playbackError);
      throw playbackError;
    }
    if (this.failed || this.disposed) return;
    this.playbackStartedAt = performance.now();
    this.playing = true;
    this.diagnostics.info('player.play.begin', { fileName: this.fileName });
    const playbackComplete = new Promise((resolve, reject) => {
      this.playbackResolve = resolve;
      this.playbackReject = reject;
    });
    this._decodeAhead();
    this.animationId = requestAnimationFrame(this.renderFrame);
    await playbackComplete;
  }

  /**
   * 幂等释放本视频拥有的全部显式资源，并断开完整媒体 ArrayBuffer 的引用。
   * 共享 Renderer 由串行控制器负责销毁，播放器只在段末清空其输出。
   * JS Heap 的实际归还时机由 WebView 的垃圾回收器决定。
   */
  dispose() {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    this.diagnostics.info('player.dispose.begin', {
      fileName: this.fileName,
      decodedFrames: this.decodedFrames.length,
      framesInFlight: this.framesInFlight,
    });
    this.ready = false;
    this.playing = false;
    cancelAnimationFrame(this.animationId);
    this.animationId = 0;

    this.firstFrameReject?.(new Error('播放器在首帧渲染前已释放。'));
    this.firstFrameResolve = null;
    this.firstFrameReject = null;
    this.playbackReject?.(new Error('播放器已释放。'));
    this.playbackResolve = null;
    this.playbackReject = null;
    const audioDisposePromise = this.audioClock?.dispose() ?? Promise.resolve();
    this._closePendingRenderFrame();
    this._closeBufferedFrames();
    this._closeDecoder();
    this.onVideoInfoChange = NOOP;
    this.disposePromise = this._completeDispose(audioDisposePromise);
    return this.disposePromise;
  }

  async _completeDispose(audioDisposePromise) {
    try {
      await this.decoderDrainPromise;
    } catch {
      // Decoder 已在同步释放阶段关闭。
    }
    try {
      await this.rendererCreationPromise;
    } catch {
      // Renderer 初始化错误由 load() 的统一错误路径处理。
    }
    await this._waitForRenderIdle();
    let rendererError = null;
    try {
      if (this.reuseRenderer) {
        await this.renderer?.clear();
      } else {
        this.renderer?.destroy();
      }
    } catch (error) {
      rendererError = error;
    } finally {
      await audioDisposePromise;
      this.store.clear();
      this.audioClock = null;
      this.renderer = null;
      this.diagnostics.info('player.dispose.complete', { fileName: this.fileName });
    }
    if (rendererError) throw rendererError;
  }

  async _initializeMedia() {
    this._assertLoadingActive();
    const metadata = this.store.metadata;
    let renderer = this.renderer;
    const reusedRenderer = Boolean(renderer);
    if (renderer) {
      this.canvas = renderer.canvas;
      await renderer.resize(metadata.width, metadata.height);
    } else {
      this.canvas.width = metadata.width;
      this.canvas.height = metadata.height;
      const rendererCreationPromise = RendererFactory.create(this.canvas, {
        webGpuEnabled: this.webGpuEnabled,
        diagnostics: this.diagnostics,
      });
      this.rendererCreationPromise = rendererCreationPromise;
      try {
        renderer = await rendererCreationPromise;
      } finally {
        if (this.rendererCreationPromise === rendererCreationPromise) {
          this.rendererCreationPromise = null;
        }
      }
    }
    if (this.disposed || this.failed) {
      if (!reusedRenderer) renderer.destroy();
      this._assertLoadingActive();
    }
    this.renderer = renderer;
    // RendererFactory 在 WebGPU 初始化后失败时可能替换 Canvas。
    this.canvas = this.renderer.canvas;
    if (this.reuseRenderer && !reusedRenderer) this.onRendererCreated(this.renderer);
    const decoderConfig = await this._getDecoderConfig(
      metadata.codec,
      metadata.codedWidth,
      metadata.codedHeight
    );
    this._assertLoadingActive();
    this._createDecoder(decoderConfig);
    this.diagnostics.info('player.decoder.configured', {
      fileName: this.fileName,
      codec: decoderConfig.codec,
      width: decoderConfig.codedWidth,
      height: decoderConfig.codedHeight,
    });

    if (!this.audioEnabled) return;
    if (!metadata.audio) throw new Error('启用音频时，WebM 必须包含 Opus 音轨。');

    this.audioClock = new WebAudioClock(metadata.audio, {
      onError: (error) => this._fail(error),
    });
    await this.audioClock.initialize();
    this._assertLoadingActive();

    // 媒体已经完整，所有 Opus packet 一次送入并立即 flush，不存在后续缓冲输入。
    for (const chunk of this.store.audioChunks) this.audioClock.append(chunk);
    await this.audioClock.end();
    this._assertLoadingActive();
    this._validateDurations();
  }

  _assertLoadingActive() {
    if (this.disposed || this.failed) throw new Error('播放器加载已取消。');
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
      renderer: this.renderer.name,
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
    this.diagnostics.info('player.decoder.supported', {
      fileName: this.fileName,
      codec,
      width,
      height,
      hardwareAcceleration: support.config.hardwareAcceleration ?? 'default',
    });
    return support.config;
  }

  _createDecoder(decoderConfig) {
    this.decoder = new VideoDecoder({
      output: (frame) => this._acceptFrame(frame),
      error: (error) => this._fail(error),
    });
    this.decoder.configure(decoderConfig);
  }

  _submitFrame(frame) {
    this.decoder.decode(new EncodedVideoChunk({
      type: frame.type,
      timestamp: frame.timestamp,
      duration: frame.duration,
      data: frame.data,
    }));
    this.nextFrameIndex += 1;
    this.framesInFlight += 1;
  }

  _acceptFrame(frame) {
    if (this.failed || this.disposed) {
      frame.close();
      return;
    }
    this.framesInFlight = Math.max(0, this.framesInFlight - 1);
    this.decodedFrames.push(frame);
    this.decodedFrames.sort((left, right) => left.timestamp - right.timestamp);
    // 首帧时间戳不一定严格为 0，load 仍必须等待它完成实际渲染。
    if (!this.playing && !this.firstFrameRendered) this._drawThrough(frame.timestamp);
    this._logStats();
  }

  _decodeAhead() {
    if (
      !this.playing
      || this.failed
      || this.decoder?.state !== 'configured'
    ) return;

    try {
      while (
        this.nextFrameIndex < this.store.frames.length
        && this.decodedFrames.length
          + this.framesInFlight
          + (this.renderPromise ? 1 : 0)
          + (this.pendingRenderFrame ? 1 : 0) < MAX_DECODED_FRAMES
      ) {
        this._submitFrame(this.store.frames[this.nextFrameIndex]);
      }
      if (this.nextFrameIndex === this.store.frames.length) {
        this._drainDecoder();
      }
    } catch (error) {
      this._fail(error);
    }
  }

  _render(now) {
    if (!this.playing || this.failed || this.disposed) return;
    this.audioClock?.schedule();
    this.currentTimeUs = this._readClock(now);

    this._drawThrough(this.currentTimeUs);
    this._decodeAhead();
    this._logStats();
    if (
      this.currentTimeUs >= this._getDurationUs()
      && this.decodersFlushed
      && this.framesInFlight === 0
    ) {
      this._finishPlayback();
      return;
    }
    this.animationId = requestAnimationFrame(this.renderFrame);
  }

  _readClock(now) {
    const timestampUs = this.audioClock
      ? this.audioClock.currentTimeUs
      : (now - this.playbackStartedAt) * 1000;
    return Math.min(Math.max(timestampUs, 0), this._getDurationUs());
  }

  _drawThrough(timestampUs) {
    let selectedFrame = null;
    while (this.decodedFrames.length && this.decodedFrames[0].timestamp <= timestampUs) {
      selectedFrame?.close();
      selectedFrame = this.decodedFrames.shift();
    }
    if (selectedFrame) this._queueRenderFrame(selectedFrame);
  }

  _queueRenderFrame(frame) {
    if (this.failed || this.disposed) {
      frame.close();
      return;
    }
    if (this.renderPromise) {
      this.pendingRenderFrame?.close();
      this.pendingRenderFrame = frame;
      return;
    }
    this._startRender(frame);
  }

  _startRender(frame) {
    const renderPromise = this._renderFrame(frame);
    this.renderPromise = renderPromise;
    void renderPromise.finally(() => {
      if (this.renderPromise !== renderPromise) return;
      this.renderPromise = null;
      const pendingFrame = this.pendingRenderFrame;
      this.pendingRenderFrame = null;
      if (pendingFrame) {
        if (this.failed || this.disposed) {
          pendingFrame.close();
        } else {
          this._startRender(pendingFrame);
        }
      } else {
        this._decodeAhead();
      }
    });
  }

  async _renderFrame(frame) {
    try {
      await this.renderer.render(frame);
      this.renderedFrameCount += 1;
      if (!this.firstFrameRendered && !this.failed && !this.disposed) {
        await this.renderer.flush?.();
        this.firstFrameRendered = true;
        this.firstFrameResolve?.();
        this.firstFrameResolve = null;
        this.firstFrameReject = null;
      }
    } catch (error) {
      this._fail(error);
    } finally {
      if (!this.renderer?.ownsFrames) frame.close();
    }
  }

  /** 解码完成且最后一帧绘制结束后，才结束本次一次性播放。 */
  _finishPlayback() {
    if (this.ending) return;
    this.ending = true;
    const durationUs = this._getDurationUs();
    this.currentTimeUs = durationUs;
    this._drawThrough(durationUs);
    this.playing = false;
    this.audioClock?.stop();
    this.animationId = 0;
    this.diagnostics.info('player.play.finish', {
      fileName: this.fileName,
      renderedFrames: this.renderedFrameCount,
    });
    void this._completePlayback();
  }

  async _completePlayback() {
    try {
      await this._waitForRenderIdle();
      await this.renderer.flush?.();
      if (this.failed || this.disposed) return;
      this.playbackResolve?.();
      this.playbackResolve = null;
      this.playbackReject = null;
      this.diagnostics.info('player.play.complete', { fileName: this.fileName });
    } catch (error) {
      this._fail(error);
    }
  }

  _drainDecoder() {
    if (this.decoderDrainPromise || this.decodersFlushed) return;
    const decoder = this.decoder;
    if (decoder?.state !== 'configured') return;
    this.diagnostics.info('player.decoder.flush.begin', { fileName: this.fileName });
    const drainPromise = decoder.flush()
      .then(() => {
        if (this.disposed || this.failed) return;
        if (this.framesInFlight) {
          throw new Error('仍有视频帧未完成解码。');
        }
        this.decodersFlushed = true;
        this._closeDecoder();
        this.diagnostics.info('player.decoder.flush.complete', { fileName: this.fileName });
      });
    this.decoderDrainPromise = drainPromise;
    void drainPromise.catch((error) => this._fail(error));
  }

  async _waitForRenderIdle() {
    while (this.renderPromise) await this.renderPromise;
  }

  _getDurationUs() {
    return this.audioClock?.durationUs
      ? Math.min(this.audioClock.durationUs, this.store.videoDurationUs)
      : this.store.videoDurationUs;
  }

  _fail(error) {
    if (this.failed || this.disposed) return;
    this.diagnostics.error('player.failed', error, {
      fileName: this.fileName,
      decodedFrames: this.decodedFrames.length,
      framesInFlight: this.framesInFlight,
    });
    this.failed = true;
    this.playing = false;
    cancelAnimationFrame(this.animationId);
    this.animationId = 0;
    this.audioClock?.stop();
    this._closePendingRenderFrame();
    this._closeBufferedFrames();
    this._closeDecoder();
    this.firstFrameReject?.(error);
    this.firstFrameResolve = null;
    this.firstFrameReject = null;
    this.playbackReject?.(error);
    this.playbackResolve = null;
    this.playbackReject = null;
  }

  _closePendingRenderFrame() {
    this.pendingRenderFrame?.close();
    this.pendingRenderFrame = null;
  }

  _closeBufferedFrames() {
    for (const frame of this.decodedFrames) frame.close();
    this.decodedFrames = [];
  }

  _closeDecoder() {
    const decoder = this.decoder;
    this.decoder = null;
    if (decoder && decoder.state !== 'closed') decoder.close();
    this.diagnostics.info('player.decoder.closed', { fileName: this.fileName });
  }

  _logStats() {
    const now = performance.now();
    if (now - this.lastStatsLoggedAt < 1_000) return;
    this.lastStatsLoggedAt = now;
    this.diagnostics.info('player.stats', {
      fileName: this.fileName,
      renderedFrames: this.renderedFrameCount,
      decodedFrames: this.decodedFrames.length,
      framesInFlight: this.framesInFlight,
      hasPendingRenderFrame: Boolean(this.pendingRenderFrame),
    });
  }

  static _toArrayBuffer(mediaData) {
    if (mediaData instanceof ArrayBuffer) return mediaData;
    if (!ArrayBuffer.isView(mediaData)) throw new Error('媒体数据必须是完整的二进制数据。');
    const bytes = new Uint8Array(mediaData.buffer, mediaData.byteOffset, mediaData.byteLength);
    return bytes.slice().buffer;
  }
}
