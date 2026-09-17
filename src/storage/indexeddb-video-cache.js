const DATABASE_NAME = 'webview-video-cache';
const DATABASE_VERSION = 1;
const VIDEO_STORE_NAME = 'videos';
const PROBE_CACHE_KEY = '__indexeddb_probe__';

/** 持久化完整 WebM；缓存失败时统一上报并终止当前流程。 */
export class IndexedDbVideoCache {
  constructor({ diagnostics, errorHandler }) {
    this.diagnostics = diagnostics;
    this.errorHandler = errorHandler;
    this.database = null;
    this.openPromise = null;
  }

  open() {
    if (this.database) return Promise.resolve();
    if (this.openPromise) return this.openPromise;
    this.openPromise = this._openAndValidate().catch((error) => {
      this.openPromise = null;
      this.diagnostics.error('cache.open.failed', error);
      this.errorHandler.report(error);
      throw error;
    });
    return this.openPromise;
  }

  async contains(resource) {
    const record = await this._getRecord(resource.cacheKey, resource.fileName);
    if (!record) return false;
    if (IndexedDbVideoCache._isValidRecord(record, resource)) return true;
    this.diagnostics.warn('cache.invalid', {
      fileName: resource.fileName,
      cacheKey: resource.cacheKey,
    });
    await this.delete(resource.cacheKey, resource.fileName);
    return false;
  }

  async read(resource) {
    const record = await this._getRecord(resource.cacheKey, resource.fileName);
    if (!record) {
      this.diagnostics.info('cache.miss', {
        fileName: resource.fileName,
        cacheKey: resource.cacheKey,
      });
      return null;
    }
    if (!IndexedDbVideoCache._isValidRecord(record, resource)) {
      this.diagnostics.warn('cache.invalid', {
        fileName: resource.fileName,
        cacheKey: resource.cacheKey,
      });
      await this.delete(resource.cacheKey, resource.fileName);
      return null;
    }

    try {
      const buffer = await record.blob.arrayBuffer();
      if (buffer.byteLength !== record.byteLength) {
        throw this.errorHandler.create('IndexedDB 中的 WebM 数据长度不完整。', {
          fileName: resource.fileName,
        });
      }
      this.diagnostics.info('cache.hit', {
        fileName: resource.fileName,
        cacheKey: resource.cacheKey,
        bytes: buffer.byteLength,
      });
      return {
        buffer,
        byteLength: buffer.byteLength,
        contentType: record.contentType,
        source: 'cache',
      };
    } catch (error) {
      this.diagnostics.error('cache.read.failed', error, {
        fileName: resource.fileName,
        cacheKey: resource.cacheKey,
      });
      this.errorHandler.report(error, resource.fileName);
      await this.delete(resource.cacheKey, resource.fileName);
      throw error;
    }
  }

  async write(resource, media) {
    const record = {
      cacheKey: resource.cacheKey,
      fileName: resource.fileName,
      url: resource.url,
      byteLength: media.byteLength,
      contentType: media.contentType || 'video/webm',
      blob: new Blob([media.buffer], {
        type: media.contentType || 'video/webm',
      }),
      cachedAt: Date.now(),
    };
    this.diagnostics.info('cache.write.begin', {
      fileName: resource.fileName,
      cacheKey: resource.cacheKey,
      bytes: media.byteLength,
    });
    try {
      await this._putRecord(record);
      this.diagnostics.info('cache.write.complete', {
        fileName: resource.fileName,
        cacheKey: resource.cacheKey,
        bytes: media.byteLength,
      });
    } catch (error) {
      const event = error?.name === 'QuotaExceededError'
        ? 'cache.quota.exceeded'
        : 'cache.write.failed';
      this.diagnostics.error(event, error, {
        fileName: resource.fileName,
        cacheKey: resource.cacheKey,
        bytes: media.byteLength,
      });
      this.errorHandler.report(error, resource.fileName);
      throw error;
    }
  }

  delete(cacheKey, fileName = '') {
    const database = this._requireDatabase(fileName);
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(VIDEO_STORE_NAME, 'readwrite');
      let settled = false;
      const rejectTransaction = (message) => {
        if (settled) return;
        settled = true;
        reject(this.errorHandler.create(message, {
          fileName,
          cause: transaction.error,
        }));
      };
      transaction.objectStore(VIDEO_STORE_NAME).delete(cacheKey);
      transaction.oncomplete = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      transaction.onerror = () => rejectTransaction('删除 IndexedDB WebM 缓存失败。');
      transaction.onabort = () => rejectTransaction('删除 IndexedDB WebM 缓存被中止。');
    });
  }

  retain(cacheKeys) {
    const database = this._requireDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(VIDEO_STORE_NAME, 'readwrite');
      const store = transaction.objectStore(VIDEO_STORE_NAME);
      const request = store.openKeyCursor();
      let removed = 0;
      let settled = false;
      const rejectTransaction = (message) => {
        if (settled) return;
        settled = true;
        reject(this.errorHandler.create(message, {
          cause: transaction.error,
        }));
      };
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        if (cursor.key !== PROBE_CACHE_KEY && !cacheKeys.has(cursor.key)) {
          cursor.delete();
          removed += 1;
        }
        cursor.continue();
      };
      transaction.oncomplete = () => {
        if (settled) return;
        settled = true;
        this.diagnostics.info('cache.prune.complete', { removed });
        resolve();
      };
      transaction.onerror = () => rejectTransaction('清理 IndexedDB WebM 缓存失败。');
      transaction.onabort = () => rejectTransaction('清理 IndexedDB WebM 缓存被中止。');
    });
  }

  async sampleStorage(stage) {
    if (typeof navigator.storage?.estimate !== 'function') return;
    try {
      const estimate = await navigator.storage.estimate();
      this.diagnostics.info('storage.sample', {
        stage,
        usageBytes: estimate.usage ?? 0,
        quotaBytes: estimate.quota ?? 0,
      });
    } catch (error) {
      this.diagnostics.warn('storage.sample.failed', {
        stage,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  close() {
    this.database?.close();
    this.database = null;
    this.openPromise = null;
    this.diagnostics.info('cache.closed');
  }

  async _openAndValidate() {
    if (!('indexedDB' in window)) {
      throw this.errorHandler.create('当前 WebView 不支持 IndexedDB。');
    }
    this.diagnostics.info('cache.open.begin');
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      let settled = false;
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(VIDEO_STORE_NAME)) {
          request.result.createObjectStore(VIDEO_STORE_NAME, {
            keyPath: 'cacheKey',
          });
        }
      };
      request.onsuccess = () => {
        if (settled) {
          request.result.close();
          return;
        }
        settled = true;
        resolve(request.result);
      };
      request.onerror = () => {
        if (settled) return;
        settled = true;
        reject(this.errorHandler.create('打开 IndexedDB 失败。', {
          cause: request.error,
        }));
      };
      request.onblocked = () => {
        if (settled) return;
        settled = true;
        reject(this.errorHandler.create('IndexedDB 升级被其他页面阻塞。'));
      };
    });
    database.onversionchange = () => {
      database.close();
      if (this.database === database) {
        this.database = null;
        this.openPromise = null;
      }
    };
    this.database = database;
    try {
      await this._validateReadWrite();
      this.diagnostics.info('cache.open.complete');
      await this.sampleStorage('cache.open.complete');
    } catch (error) {
      database.close();
      this.database = null;
      throw error;
    }
  }

  async _validateReadWrite() {
    const probe = {
      cacheKey: PROBE_CACHE_KEY,
      fileName: '',
      url: '',
      byteLength: 1,
      contentType: 'application/octet-stream',
      blob: new Blob([new Uint8Array([1])]),
      cachedAt: Date.now(),
    };
    await this._putRecord(probe);
    const savedProbe = await this._getRecord(PROBE_CACHE_KEY);
    if (!(savedProbe?.blob instanceof Blob) || savedProbe.blob.size !== 1) {
      throw this.errorHandler.create('IndexedDB 读写校验失败。');
    }
    await this.delete(PROBE_CACHE_KEY);
  }

  _getRecord(cacheKey, fileName = '') {
    const database = this._requireDatabase(fileName);
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(VIDEO_STORE_NAME, 'readonly');
      const request = transaction.objectStore(VIDEO_STORE_NAME).get(cacheKey);
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(
        this.errorHandler.create('读取 IndexedDB WebM 缓存失败。', {
          fileName,
          cause: request.error,
        }),
      );
    });
  }

  _putRecord(record) {
    const database = this._requireDatabase(record.fileName);
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(VIDEO_STORE_NAME, 'readwrite');
      let settled = false;
      const rejectTransaction = (message) => {
        if (settled) return;
        settled = true;
        reject(this.errorHandler.create(message, {
          fileName: record.fileName,
          cause: transaction.error,
        }));
      };
      transaction.objectStore(VIDEO_STORE_NAME).put(record);
      transaction.oncomplete = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      transaction.onerror = () => rejectTransaction('写入 IndexedDB WebM 缓存失败。');
      transaction.onabort = () => rejectTransaction('写入 IndexedDB WebM 缓存被中止。');
    });
  }

  _requireDatabase(fileName = '') {
    if (!this.database) {
      throw this.errorHandler.create('IndexedDB WebM 缓存尚未初始化。', {
        fileName,
      });
    }
    return this.database;
  }

  static _isValidRecord(record, resource) {
    return record.cacheKey === resource.cacheKey
      && record.url === resource.url
      && record.fileName === resource.fileName
      && Number.isSafeInteger(record.byteLength)
      && record.byteLength > 0
      && record.blob instanceof Blob
      && record.blob.size === record.byteLength;
  }
}
