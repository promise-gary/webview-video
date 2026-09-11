const MAX_MEDIA_BYTES = 512 * 1024 * 1024;
const NOOP = () => {};

/** 下载一份完整媒体数据；不解析、不解码，也不保留分块。 */
export class FetchStreamRequest {
  constructor({ sourceUrl, signal, diagnostics, fileName, onProgress = NOOP }) {
    this.sourceUrl = sourceUrl;
    this.signal = signal;
    this.diagnostics = diagnostics;
    this.fileName = fileName;
    this.onProgress = onProgress;
    this.lastLoggedPercent = -10;
  }

  async download() {
    const requestContext = this._createRequestContext();
    this.diagnostics.info('download.fetch.begin', {
      fileName: this.fileName,
      ...requestContext,
    });
    let response;
    try {
      response = await fetch(this.sourceUrl, { signal: this.signal });
    } catch (error) {
      this.diagnostics.error('download.fetch.failed', error, {
        fileName: this.fileName,
        aborted: this.signal.aborted,
        ...requestContext,
        resourceTiming: this._getResourceTiming(),
        candidates: this._createFailureCandidates(requestContext),
      });
      throw error;
    }
    if (!response.ok) {
      const error = new Error(`WebM 下载失败（HTTP ${response.status}）。`);
      this.diagnostics.error('download.response.failed', error, {
        fileName: this.fileName,
        status: response.status,
        statusText: response.statusText,
      });
      throw error;
    }

    const totalBytes = Number(response.headers.get('Content-Length'));
    this.diagnostics.info('download.response', {
      fileName: this.fileName,
      status: response.status,
      totalBytes,
      contentType: response.headers.get('Content-Type') ?? '',
      responseType: response.type,
      responseUrl: response.url,
      redirected: response.redirected,
    });
    if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0) {
      const error = new Error('WebM 响应缺少有效的 Content-Length。');
      this.diagnostics.error('download.content-length.invalid', error, {
        fileName: this.fileName,
        contentLength: response.headers.get('Content-Length') ?? '',
      });
      throw error;
    }
    if (totalBytes > MAX_MEDIA_BYTES) {
      throw new Error(`WebM 不能超过 ${MAX_MEDIA_BYTES} 字节。`);
    }
    if (!response.body) {
      throw new Error('当前环境无法读取响应字节流。');
    }

    const mediaBytes = new Uint8Array(totalBytes);
    this.diagnostics.info('download.buffer.allocated', {
      fileName: this.fileName,
      bytes: mediaBytes.byteLength,
    });
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
        this._logProgress(loadedBytes, totalBytes);
      }
    } catch (error) {
      this.diagnostics.error('download.stream.failed', error, {
        fileName: this.fileName,
        loadedBytes,
        totalBytes,
        percent: Math.round(loadedBytes / totalBytes * 100),
        aborted: this.signal.aborted,
      });
      throw error;
    } finally {
      reader.releaseLock();
    }

    if (loadedBytes !== totalBytes) {
      const error = new Error(`WebM 下载不完整：${loadedBytes}/${totalBytes} 字节。`);
      this.diagnostics.error('download.stream.incomplete', error, {
        fileName: this.fileName,
        loadedBytes,
        totalBytes,
      });
      throw error;
    }
    this.onProgress({ loadedBytes, totalBytes, complete: true });
    this.diagnostics.info('download.stream.complete', {
      fileName: this.fileName,
      loadedBytes,
      totalBytes,
    });
    return mediaBytes.buffer;
  }

  _logProgress(loadedBytes, totalBytes) {
    const percent = Math.floor(loadedBytes / totalBytes * 100);
    if (percent < this.lastLoggedPercent + 10 && percent !== 100) return;
    this.lastLoggedPercent = percent;
    this.diagnostics.info('download.progress', {
      fileName: this.fileName,
      loadedBytes,
      totalBytes,
      percent,
    });
  }

  _createRequestContext() {
    const pageUrl = new URL(window.location.href);
    const sourceUrl = new URL(this.sourceUrl, pageUrl);
    const connection = navigator.connection;
    return {
      sourceUrl: sourceUrl.href,
      sourceOrigin: sourceUrl.origin,
      sourceProtocol: sourceUrl.protocol,
      pageOrigin: pageUrl.origin,
      pageProtocol: pageUrl.protocol,
      crossOrigin: sourceUrl.origin !== pageUrl.origin,
      online: navigator.onLine,
      secureContext: window.isSecureContext,
      visibilityState: document.visibilityState,
      connectionType: connection?.effectiveType ?? 'unavailable',
    };
  }

  _createFailureCandidates(requestContext) {
    const candidates = [];
    if (!requestContext.online) candidates.push('设备处于离线状态。');
    if (requestContext.pageProtocol === 'https:' && requestContext.sourceProtocol === 'http:') {
      candidates.push('HTTPS 页面正在请求 HTTP 视频；检查 WKWebView 的混合内容策略。');
    }
    if (FetchStreamRequest._isPrivateIpv4(requestContext.sourceUrl)) {
      candidates.push(
        '视频地址为私网 IPv4；确认 iPhone 与服务端同一 Wi-Fi、Node 监听 0.0.0.0，且防火墙已开放端口。'
      );
    }
    if (requestContext.crossOrigin) {
      candidates.push('这是跨域请求；确认响应包含 Access-Control-Allow-Origin。');
    }
    candidates.push('WebKit 未向 fetch 暴露底层网络错误码；检查 Node 服务端是否收到该请求。');
    return candidates;
  }

  _getResourceTiming() {
    const entries = performance.getEntriesByName(this.sourceUrl, 'resource');
    const entry = entries.at(-1);
    if (!entry) return { available: false };
    return {
      available: true,
      durationMs: Math.round(entry.duration),
      transferBytes: entry.transferSize,
      encodedBodyBytes: entry.encodedBodySize,
      decodedBodyBytes: entry.decodedBodySize,
    };
  }

  static _isPrivateIpv4(url) {
    const hostname = new URL(url).hostname;
    return (
      hostname.startsWith('10.')
      || hostname.startsWith('192.168.')
      || /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname)
    );
  }
}
