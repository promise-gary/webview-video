import { FetchStreamRequest } from '../../network/fetch-stream-request.js';
import { TransparentWebmPlayer } from './transparent-webm-player.js';

const NOOP = () => {};

/** 严格串行地执行：完整下载 → 播放 → 完整释放 → 下一个。 */
export class SerialVideoController {
  constructor({
    canvas,
    canvasHost,
    resources,
    errorHandler,
    diagnostics,
    playerOptions = {},
    onDownloadProgress = NOOP,
    onVideoInfoChange = NOOP,
    onRendererChange = NOOP,
    onError = NOOP,
  }) {
    this.canvas = canvas;
    this.canvasHost = canvasHost;
    this.resources = resources;
    this.errorHandler = errorHandler;
    this.diagnostics = diagnostics;
    this.playerOptions = playerOptions;
    this.onDownloadProgress = onDownloadProgress;
    this.onVideoInfoChange = onVideoInfoChange;
    this.onRendererChange = onRendererChange;
    this.onError = onError;
    this.currentPosition = -1;
    this.generation = 0;
    this.abortController = null;
    this.player = null;
    this.sharedRenderer = null;
    this.operation = Promise.resolve();
    this.disposed = false;
  }

  start() {
    return this._requestPlayback(0);
  }

  playPrevious() {
    return this._requestPlayback(this.currentPosition - 1);
  }

  playNext() {
    return this._requestPlayback(this.currentPosition + 1);
  }

  clear() {
    this.generation += 1;
    this._cancelActive();
    return this.operation;
  }

  dispose() {
    if (this.disposed) return this.operation;
    this.disposed = true;
    this.generation += 1;
    this._cancelActive();
    this.onDownloadProgress = NOOP;
    this.onVideoInfoChange = NOOP;
    this.onRendererChange = NOOP;
    this.onError = NOOP;
    const activeOperation = this.operation;
    this.operation = activeOperation.finally(() => this._destroySharedRenderer());
    return this.operation;
  }

  _requestPlayback(position) {
    if (this.disposed || position < 0 || position >= this.resources.length) {
      return this.operation;
    }

    const generation = ++this.generation;
    this.diagnostics.info('play.request', {
      generation,
      position,
      fileName: this.resources[position].fileName,
    });
    this._cancelActive();
    const previousOperation = this.operation;
    this.operation = previousOperation
      .catch(NOOP)
      .then(() => this._playFrom(position, generation))
      .catch((error) => {
        if (this.disposed) return;
        const resource = this.resources[this.currentPosition];
        this.diagnostics.error('play.unhandled-error', error, {
          generation,
          fileName: resource?.fileName ?? '',
        });
        this.errorHandler.report(error, resource?.fileName ?? '');
        this.onError(error);
      });
    return this.operation;
  }

  async _playFrom(startPosition, generation) {
    for (
      let position = startPosition;
      position < this.resources.length && this._isCurrent(generation);
      position += 1
    ) {
      this.currentPosition = position;
      const resource = this.resources[position];
      this.diagnostics.info('play.begin', { generation, position, fileName: resource.fileName });
      try {
        await this._playOne(resource, generation);
      } catch (error) {
        if (!this._isCurrent(generation)) return;
        this.diagnostics.error('play.failed', error, { generation, fileName: resource.fileName });
        this.errorHandler.report(error, resource.fileName);
        this.onError(error);
        return;
      } finally {
        await this._releaseActive();
      }
    }
  }

  async _playOne(resource, generation) {
    const abortController = new AbortController();
    this.abortController = abortController;
    this.onDownloadProgress({
      fileName: resource.fileName,
      loadedBytes: 0,
      totalBytes: 0,
      complete: false,
    });
    this.diagnostics.info('download.begin', { generation, fileName: resource.fileName });

    const request = new FetchStreamRequest({
      sourceUrl: resource.url,
      signal: abortController.signal,
      diagnostics: this.diagnostics,
      fileName: resource.fileName,
      onProgress: (progress) => {
        if (this._isCurrent(generation)) {
          this.onDownloadProgress({ fileName: resource.fileName, ...progress });
        }
      },
    });
    const mediaBuffer = await request.download();
    if (!this._isCurrent(generation)) return;
    this.abortController = null;
    this.diagnostics.info('download.complete', {
      generation,
      fileName: resource.fileName,
      bytes: mediaBuffer.byteLength,
    });
    this.diagnostics.sampleMemory('download.complete', {
      generation,
      fileName: resource.fileName,
      mediaBytes: mediaBuffer.byteLength,
    });

    this._discardInvalidSharedRenderer();
    const reusableRenderer = this.sharedRenderer;
    this.diagnostics.info(
      reusableRenderer ? 'renderer.shared.reused' : 'renderer.shared.create.request',
      {
        fileName: resource.fileName,
        name: reusableRenderer?.name ?? '',
      }
    );
    const player = new TransparentWebmPlayer({
      canvas: this.canvas,
      renderer: reusableRenderer,
      reuseRenderer: true,
      ...this.playerOptions,
      diagnostics: this.diagnostics,
      fileName: resource.fileName,
      onRendererCreated: (renderer) => {
        if (!this._isCurrentPlayer(generation, player)) {
          renderer.destroy();
          return;
        }
        this.sharedRenderer = renderer;
        this.canvas = renderer.canvas;
        this.diagnostics.info('renderer.shared.created', { name: renderer.name });
      },
      onVideoInfoChange: (videoInfo) => {
        if (this._isCurrentPlayer(generation, player)) {
          this.onVideoInfoChange({
            ...videoInfo,
            source: {
              fileName: resource.fileName,
              fileSize: mediaBuffer.byteLength,
            },
          });
        }
      },
    });
    this.player = player;

    const info = await player.load(mediaBuffer);
    if (!this._isCurrentPlayer(generation, player)) return;
    this.canvas = player.canvas;
    this.onRendererChange(info.renderer);
    this.diagnostics.info('player.ready', {
      generation,
      fileName: resource.fileName,
      renderer: info.renderer,
    });
    await player.start();
    this.diagnostics.info('play.complete', { generation, fileName: resource.fileName });
  }

  _cancelActive() {
    this.diagnostics.info('play.cancel', {
      generation: this.generation,
      fileName: this.resources[this.currentPosition]?.fileName ?? '',
      hasDownload: Boolean(this.abortController),
      hasPlayer: Boolean(this.player),
    });
    this.abortController?.abort();
    const disposePromise = this.player?.dispose();
    if (disposePromise) void disposePromise.catch(NOOP);
  }

  async _releaseActive() {
    const player = this.player;
    this.abortController?.abort();
    this.abortController = null;
    this.player = null;
    if (!player) {
      this.diagnostics.info('play.release.no-player', {});
      return;
    }

    this.diagnostics.info('player.dispose.begin', {});
    await player.dispose();
    this._discardInvalidSharedRenderer();
    if (this.sharedRenderer) {
      this.canvas = this.sharedRenderer.canvas;
    } else {
      this.canvas = this.canvasHost.querySelector('#video-canvas') ?? player.canvas;
      this.canvas = SerialVideoController._replaceWithIdleCanvas(this.canvas);
    }
    this.diagnostics.info('player.dispose.complete', {
      canvasSize: [this.canvas.width, this.canvas.height],
    });
    this.diagnostics.sampleMemory('player.dispose.complete');
  }

  _discardInvalidSharedRenderer() {
    if (!this.sharedRenderer || this.sharedRenderer.isAvailable) return;
    this.diagnostics.warn('renderer.shared.invalid', { name: this.sharedRenderer.name });
    this.sharedRenderer.destroy();
    this.sharedRenderer = null;
  }

  _destroySharedRenderer() {
    if (!this.sharedRenderer) return;
    this.diagnostics.info('renderer.shared.destroy', { name: this.sharedRenderer.name });
    this.sharedRenderer.destroy();
    this.sharedRenderer = null;
  }

  _isCurrent(generation) {
    return !this.disposed && this.generation === generation;
  }

  _isCurrentPlayer(generation, player) {
    return this._isCurrent(generation) && this.player === player;
  }

  static _replaceWithIdleCanvas(canvas) {
    const replacement = canvas.cloneNode(false);
    replacement.width = 1;
    replacement.height = 1;
    canvas.replaceWith(replacement);
    return replacement;
  }
}
