const MAX_MEDIA_BYTES = 512 * 1024 * 1024;
const NOOP = () => {};

/** 下载一份完整媒体数据；不解析、不解码，也不保留分块。 */
export class FetchStreamRequest {
  constructor({ sourceUrl, signal, onProgress = NOOP }) {
    this.sourceUrl = sourceUrl;
    this.signal = signal;
    this.onProgress = onProgress;
  }

  async download() {
    const response = await fetch(this.sourceUrl, { signal: this.signal });
    if (!response.ok) {
      throw new Error(`WebM 下载失败（HTTP ${response.status}）。`);
    }

    const totalBytes = Number(response.headers.get('Content-Length'));
    if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0) {
      throw new Error('WebM 响应缺少有效的 Content-Length。');
    }
    if (totalBytes > MAX_MEDIA_BYTES) {
      throw new Error(`WebM 不能超过 ${MAX_MEDIA_BYTES} 字节。`);
    }
    if (!response.body) {
      throw new Error('当前环境无法读取响应字节流。');
    }

    const mediaBytes = new Uint8Array(totalBytes);
    const reader = response.body.getReader();
    let loadedBytes = 0;
    this.onProgress({ loadedBytes, totalBytes, complete: false });

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (loadedBytes + value.byteLength > totalBytes) {
          throw new Error('WebM 下载数据超过 Content-Length。');
        }
        mediaBytes.set(value, loadedBytes);
        loadedBytes += value.byteLength;
        this.onProgress({ loadedBytes, totalBytes, complete: false });
      }
    } finally {
      reader.releaseLock();
    }

    if (loadedBytes !== totalBytes) {
      throw new Error(`WebM 下载不完整：${loadedBytes}/${totalBytes} 字节。`);
    }
    this.onProgress({ loadedBytes, totalBytes, complete: true });
    return mediaBytes.buffer;
  }
}
