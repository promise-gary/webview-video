import { PlayerError } from '../error/error-reporter.js';

const DEFAULT_CHUNK_SIZE = 256 * 1024;

/** 通过宿主 Bridge 分块读取一份完整的本地资源。 */
export class BridgeReader {
  constructor({ bridge, sessionId, totalBytes, chunkSize = DEFAULT_CHUNK_SIZE }) {
    if (!bridge || typeof bridge.post !== 'function') {
      throw new PlayerError('BRIDGE_FAILED', 'resource', '缺少可用的资源 Bridge。');
    }
    if (typeof sessionId !== 'string' || !sessionId.trim()) {
      throw new PlayerError('BRIDGE_FAILED', 'resource', 'sessionId 必须是非空字符串。');
    }
    if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0) {
      throw new PlayerError('BRIDGE_FAILED', 'resource', 'totalBytes 必须是正整数。');
    }

    this.bridge = bridge;
    this.sessionId = sessionId;
    this.totalBytes = totalBytes;
    this.chunkSize = Number.isSafeInteger(chunkSize) && chunkSize > 0
      ? chunkSize
      : DEFAULT_CHUNK_SIZE;
    this.loadedBytes = 0;
    this.complete = false;
    this.cancelled = false;
    this.pendingRequest = null;
  }

  async *read() {
    while (!this.complete) {
      const chunk = await this._requestChunk();
      if (chunk.bytes.byteLength) {
        this.loadedBytes += chunk.bytes.byteLength;
        yield chunk.bytes;
      }

      if (this.loadedBytes > this.totalBytes) {
        throw new PlayerError(
          'BRIDGE_FAILED',
          'resource',
          '宿主返回的资源数据超过 totalBytes。'
        );
      }
      if (!chunk.bytes.byteLength && !chunk.done) {
        throw new PlayerError('BRIDGE_FAILED', 'resource', '宿主返回了空的资源分块。');
      }
      this.complete = chunk.done || this.loadedBytes === this.totalBytes;
    }
  }

  acceptChunk(payload) {
    if (!payload || payload.sessionId !== this.sessionId) return false;
    if (!this.pendingRequest) return false;

    try {
      const base64 = typeof payload.base64 === 'string' ? payload.base64 : '';
      const bytes = BridgeReader._decodeBase64(base64);
      if (bytes.byteLength > this.pendingRequest.length) {
        throw new PlayerError('BRIDGE_FAILED', 'resource', '宿主返回的资源分块过大。');
      }

      const pendingRequest = this.pendingRequest;
      this.pendingRequest = null;
      pendingRequest.resolve({ bytes, done: payload.done === true });
      return true;
    } catch (error) {
      this.fail(error);
      return false;
    }
  }

  fail(reason) {
    const error = PlayerError.from(reason, 'BRIDGE_FAILED', 'resource');
    const pendingRequest = this.pendingRequest;
    this.pendingRequest = null;
    this.cancelled = true;
    pendingRequest?.reject(error);
  }

  cancel() {
    if (this.cancelled || this.complete) return;
    this.fail(new PlayerError('BRIDGE_FAILED', 'resource', '资源读取已取消。'));
  }

  _requestChunk() {
    if (this.cancelled) {
      return Promise.reject(new PlayerError('BRIDGE_FAILED', 'resource', '资源读取已取消。'));
    }

    const offset = this.loadedBytes;
    const length = Math.min(this.chunkSize, this.totalBytes - offset);
    return new Promise((resolve, reject) => {
      this.pendingRequest = { offset, length, resolve, reject };
      const sent = this.bridge.post('readResource', {
        sessionId: this.sessionId,
        offset,
        length,
      });
      if (sent) return;

      this.pendingRequest = null;
      reject(new PlayerError('BRIDGE_FAILED', 'resource', '无法向宿主请求资源分块。'));
    });
  }

  static _decodeBase64(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }
}
