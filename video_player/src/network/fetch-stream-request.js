/** 通过单次 Fetch 请求持续读取响应字节；网络分块大小不等于 WebM 帧边界。 */
export class FetchStreamRequest {
  constructor({ sourceUrl, signal }) {
    this.sourceUrl = sourceUrl;
    this.signal = signal;
    this.loadedBytes = 0;
    this.totalBytes = 0;
  }

  async *read() {
    const response = await fetch(this.sourceUrl, { signal: this.signal });
    if (!response.ok) throw new Error(`WebM 加载失败（HTTP ${response.status}）。`);
    this.totalBytes = Number(response.headers.get('Content-Length')) || 0;
    if (!response.body) throw new Error('当前环境无法读取响应字节流。');

    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        this.loadedBytes += value.byteLength;
        yield value;
      }
    } finally {
      reader.releaseLock();
    }
  }
}
