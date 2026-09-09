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
    this.playerOptions = playerOptions;
    this.onDownloadProgress = onDownloadProgress;
    this.onVideoInfoChange = onVideoInfoChange;
    this.onRendererChange = onRendererChange;
    this.onError = onError;
    this.currentPosition = -1;
    this.generation = 0;
    this.abortController = null;
    this.player = null;
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
    return this.operation;
  }

  _requestPlayback(position) {
    if (this.disposed || position < 0 || position >= this.resources.length) {
      return this.operation;
    }

    const generation = ++this.generation;
    this._cancelActive();
    const previousOperation = this.operation;
    this.operation = previousOperation
      .catch(NOOP)
      .then(() => this._playFrom(position, generation))
      .catch((error) => {
        if (this.disposed) return;
        const resource = this.resources[this.currentPosition];
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
      try {
        await this._playOne(resource, generation);
      } catch (error) {
        if (!this._isCurrent(generation)) return;
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

    const request = new FetchStreamRequest({
      sourceUrl: resource.url,
      signal: abortController.signal,
      onProgress: (progress) => {
        if (this._isCurrent(generation)) {
          this.onDownloadProgress({ fileName: resource.fileName, ...progress });
        }
      },
    });
    const mediaBuffer = await request.download();
    if (!this._isCurrent(generation)) return;
    this.abortController = null;

    const player = new TransparentWebmPlayer({
      canvas: this.canvas,
      ...this.playerOptions,
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
    await player.start();
  }

  _cancelActive() {
    this.abortController?.abort();
    const disposePromise = this.player?.dispose();
    if (disposePromise) void disposePromise.catch(NOOP);
  }

  async _releaseActive() {
    const player = this.player;
    this.abortController?.abort();
    this.abortController = null;
    this.player = null;
    if (!player) return;

    await player.dispose();
    this.canvas = this.canvasHost.querySelector('#video-canvas') ?? player.canvas;
    this.canvas = SerialVideoController._replaceWithIdleCanvas(this.canvas);
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
