import { FetchStreamRequest } from './fetch-stream-request.js';

const NOOP = () => {};

/** 为播放和预下载共用同一个限流、去重的 WebM 下载队列。 */
export class WebmResourceLoader {
  constructor({ cache, diagnostics, errorHandler, maxConcurrentDownloads }) {
    this.cache = cache;
    this.diagnostics = diagnostics;
    this.errorHandler = errorHandler;
    this.maxConcurrentDownloads = maxConcurrentDownloads;
    this.activeDownloadCount = 0;
    this.sequence = 0;
    this.queue = [];
    this.tasks = new Map();
    this.disposed = false;
    this.disposePromise = null;
  }

  async preload(resources) {
    const completions = resources.map((resource) =>
      this._schedule(resource, false).promise.then(() => undefined));
    const results = await Promise.allSettled(completions);
    let completed = 0;
    let failed = 0;
    for (const result of results) {
      if (result.status === 'fulfilled') completed += 1;
      else failed += 1;
    }
    this.diagnostics.info('preload.complete', {
      total: resources.length,
      completed,
      failed,
      maxConcurrentDownloads: this.maxConcurrentDownloads,
    });
    await this.cache.sampleStorage('preload.complete');
    return { completed, failed };
  }

  async load(resource, { signal, onProgress = NOOP }) {
    if (this.disposed) {
      throw this.errorHandler.create('WebM 资源加载器已释放。', {
        fileName: resource.fileName,
      });
    }
    if (signal.aborted) throw WebmResourceLoader._createAbortError();
    onProgress({
      loadedBytes: 0,
      totalBytes: 0,
      complete: false,
      source: 'cache',
    });
    const cachedMedia = await this.cache.read(resource);
    if (signal.aborted) throw WebmResourceLoader._createAbortError();
    if (cachedMedia) {
      onProgress({
        loadedBytes: cachedMedia.byteLength,
        totalBytes: cachedMedia.byteLength,
        complete: true,
        source: 'cache',
      });
      return cachedMedia;
    }

    const task = this._schedule(resource, true);
    const result = await this._waitForTask(task, signal, onProgress);
    if (signal.aborted) throw WebmResourceLoader._createAbortError();
    if (result.buffer) return result;

    const media = await this.cache.read(resource);
    if (!media) {
      throw this.errorHandler.create('WebM 下载完成后未能从 IndexedDB 读取。', {
        fileName: resource.fileName,
      });
    }
    if (result.source === 'cache') {
      onProgress({
        loadedBytes: media.byteLength,
        totalBytes: media.byteLength,
        complete: true,
        source: 'cache',
      });
    }
    return { ...media, source: result.source };
  }

  dispose() {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    const pendingTasks = [...this.tasks.values()].map((task) => task.promise);
    const error = WebmResourceLoader._createAbortError();
    for (const task of this.queue) task.reject(error);
    this.queue.length = 0;
    for (const task of this.tasks.values()) {
      task.abortController?.abort();
    }
    this.tasks.clear();
    this.disposePromise = Promise.allSettled(pendingTasks).then(() => undefined);
    return this.disposePromise;
  }

  _schedule(resource, playbackPriority) {
    const existingTask = this.tasks.get(resource.cacheKey);
    if (existingTask) {
      if (playbackPriority && existingTask.state === 'queued') {
        existingTask.playbackPriority = true;
        this._sortQueue();
      }
      return existingTask;
    }

    let resolveTask;
    let rejectTask;
    const promise = new Promise((resolve, reject) => {
      resolveTask = resolve;
      rejectTask = reject;
    });
    const task = {
      resource,
      playbackPriority,
      order: this.sequence++,
      state: 'queued',
      promise,
      resolve: resolveTask,
      reject: rejectTask,
      listeners: new Set(),
      lastProgress: null,
      abortController: null,
    };
    this.tasks.set(resource.cacheKey, task);
    this.queue.push(task);
    this._sortQueue();
    this._pump();
    return task;
  }

  _pump() {
    while (
      !this.disposed
      && this.activeDownloadCount < this.maxConcurrentDownloads
      && this.queue.length > 0
    ) {
      const task = this.queue.shift();
      task.state = 'active';
      task.abortController = new AbortController();
      this.activeDownloadCount += 1;
      void this._runTask(task)
        .then(task.resolve, (error) => {
          if (!WebmResourceLoader._isAbortError(error)) {
            this.errorHandler.report(error, task.resource.fileName);
          }
          task.reject(error);
        })
        .finally(() => {
          this.activeDownloadCount -= 1;
          task.state = 'complete';
          task.listeners.clear();
          if (this.tasks.get(task.resource.cacheKey) === task) {
            this.tasks.delete(task.resource.cacheKey);
          }
          this._pump();
        });
    }
  }

  async _runTask(task) {
    const { resource } = task;
    if (await this.cache.contains(resource)) {
      this.diagnostics.info('preload.cache-hit', {
        fileName: resource.fileName,
        cacheKey: resource.cacheKey,
      });
      return { source: 'cache' };
    }

    const request = new FetchStreamRequest({
      sourceUrl: resource.url,
      signal: task.abortController.signal,
      diagnostics: this.diagnostics,
      fileName: resource.fileName,
      onProgress: (progress) => {
        const nextProgress = { ...progress, source: 'network' };
        task.lastProgress = nextProgress;
        for (const listener of task.listeners) listener(nextProgress);
      },
    });
    const media = await request.download();
    await this.cache.write(resource, media);
    return { ...media, source: 'network' };
  }

  _waitForTask(task, signal, onProgress) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const release = () => {
        task.listeners.delete(onProgress);
        signal.removeEventListener('abort', onAbort);
      };
      const onAbort = () => {
        if (settled) return;
        settled = true;
        release();
        reject(WebmResourceLoader._createAbortError());
      };
      task.listeners.add(onProgress);
      if (task.lastProgress) onProgress(task.lastProgress);
      else onProgress({
        loadedBytes: 0,
        totalBytes: 0,
        complete: false,
        source: 'network',
      });
      signal.addEventListener('abort', onAbort, { once: true });
      task.promise.then(
        (media) => {
          if (settled) return;
          settled = true;
          release();
          resolve(media);
        },
        (error) => {
          if (settled) return;
          settled = true;
          release();
          reject(error);
        },
      );
    });
  }

  _sortQueue() {
    this.queue.sort((left, right) => {
      if (left.playbackPriority !== right.playbackPriority) {
        return left.playbackPriority ? -1 : 1;
      }
      return left.order - right.order;
    });
  }

  static _createAbortError() {
    return new DOMException('WebM 资源读取已取消。', 'AbortError');
  }

  static _isAbortError(error) {
    return error instanceof DOMException && error.name === 'AbortError';
  }
}
