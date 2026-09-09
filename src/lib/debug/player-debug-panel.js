/** 播放器业务调试面板：展示下载进度、媒体信息和实际 Renderer。 */
export class PlayerDebugPanel {
  static create({ enabled, parent }) {
    return new PlayerDebugPanel({ enabled, parent });
  }

  constructor({ enabled, parent }) {
    this.enabled = enabled;
    this.rendererName = '初始化中';
    this.videoInfo = null;
    this.panel = parent.querySelector('#player-debug-panel');
    this.debugInfo = this.panel.querySelector('#debug-info');
    this.downloadProgress = this.panel.querySelector('#download-progress');
    this.downloadDetail = this.panel.querySelector('#download-detail');

    if (enabled) {
      parent.hidden = false;
      this.panel.hidden = false;
    }
  }

  updateDownload({ fileName, loadedBytes, totalBytes, complete }) {
    if (!this.enabled) return;
    if (!totalBytes) {
      this.rendererName = '初始化中';
      this.videoInfo = null;
      this.debugInfo.classList.remove('error');
      this.debugInfo.textContent = `正在下载 ${fileName}…`;
      this.downloadProgress.value = 0;
      this.downloadProgress.textContent = '0%';
      this.downloadDetail.textContent = `${fileName} · 等待下载…`;
      return;
    }

    const percent = Math.min(100, loadedBytes / totalBytes * 100);
    this.downloadProgress.value = percent;
    this.downloadProgress.textContent = `${percent.toFixed(1)}%`;
    this.downloadDetail.textContent = complete
      ? `${fileName} · ${PlayerDebugPanel._formatBytes(totalBytes)} · 已完成`
      : `${fileName} · ${PlayerDebugPanel._formatBytes(loadedBytes)}`
        + ` / ${PlayerDebugPanel._formatBytes(totalBytes)} · ${percent.toFixed(1)}%`;
  }

  updateVideoInfo(videoInfo) {
    if (!this.enabled) return;
    this.videoInfo = videoInfo;
    this._renderVideoInfo();
  }

  updateRenderer(rendererName) {
    if (!this.enabled) return;
    this.rendererName = rendererName;
    this._renderVideoInfo();
  }

  showError(error) {
    if (!this.enabled) return;
    this.debugInfo.textContent = `播放器错误：${error.message}`;
    this.debugInfo.classList.add('error');
  }

  _renderVideoInfo() {
    if (!this.videoInfo) return;
    const { width, height, fps, frames, duration } = this.videoInfo;
    const source = this.videoInfo.source && typeof this.videoInfo.source === 'object'
      ? this.videoInfo.source
      : {};
    const fileName = typeof source.fileName === 'string' ? source.fileName : '';
    const fileSize = Number.isSafeInteger(source.fileSize) ? source.fileSize : 0;
    const sourceLabel = fileName
      ? `${fileName} · ${PlayerDebugPanel._formatBytes(fileSize)} · `
      : '';
    this.debugInfo.classList.remove('error');
    this.debugInfo.textContent =
      `${sourceLabel}${width} × ${height} · ${fps.toFixed(2)} FPS`
      + ` · ${frames} 帧 · ${duration.toFixed(2)} 秒 · ${this.rendererName}`;
  }

  static _formatBytes(bytes) {
    if (!bytes) return '0 B';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }
}
