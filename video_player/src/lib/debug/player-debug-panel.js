/** 播放器业务调试面板：展示媒体信息、实际 Renderer 和资源缓存进度。 */
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
    this.cacheProgress = this.panel.querySelector('#cache-progress');
    this.cacheDetail = this.panel.querySelector('#cache-detail');

    if (enabled) {
      parent.hidden = false;
      this.panel.hidden = false;
    }
  }

  updateCache({ loadedBytes, totalBytes, complete }) {
    if (!this.enabled) return;

    if (!totalBytes) {
      this.cacheProgress.removeAttribute('value');
      this.cacheDetail.textContent = `${this._formatMegabytes(loadedBytes)} · 总大小未知`;
      return;
    }

    const percent = Math.min(100, loadedBytes / totalBytes * 100);
    this.cacheProgress.value = percent;
    this.cacheProgress.textContent = `${percent.toFixed(1)}%`;
    this.cacheDetail.textContent = complete
      ? `${this._formatMegabytes(totalBytes)} · 已完成`
      : `${this._formatMegabytes(loadedBytes)} / ${this._formatMegabytes(totalBytes)}`
        + ` · ${percent.toFixed(1)}%`;
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
    this.debugInfo.classList.remove('error');
    this.debugInfo.textContent =
      `${width} × ${height} · ${fps.toFixed(2)} FPS`
      + ` · ${frames} 帧 · ${duration.toFixed(2)} 秒 · ${this.rendererName}`;
  }

  _formatMegabytes(bytes) {
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  }
}
