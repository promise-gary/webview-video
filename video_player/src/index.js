/** 透明视频播放器的精简页面入口，只负责初始化和可选调试信息。 */
import { PlayerPageConfig } from './config/player-page-config.js';
import { TransparentWebmPlayer } from './lib/player/transparent-webm-player.js';

const canvas = document.querySelector('#video-canvas');
const debugPanel = document.querySelector('#debug-panel');
const debugInfo = document.querySelector('#debug-info');
const cacheProgress = document.querySelector('#cache-progress');
const cacheDetail = document.querySelector('#cache-detail');

let debugEnabled = false;

/** 将字节换算成便于阅读的 MB，仅负责页面展示。 */
const formatMegabytes = (bytes) => `${(bytes / 1024 / 1024).toFixed(2)} MB`;

/**
 * 缓存进度表示网络资源的接收进度，不代表当前播放位置。
 * Content-Length 暂时未知时使用原生 progress 的不确定状态。
 */
const showCacheProgress = ({ loadedBytes, totalBytes, complete }) => {
  if (!debugEnabled) return;
  if (!totalBytes) {
    cacheProgress.removeAttribute('value');
    cacheDetail.textContent = `${formatMegabytes(loadedBytes)} · 总大小未知`;
    return;
  }

  const percent = Math.min(100, loadedBytes / totalBytes * 100);
  cacheProgress.value = percent;
  cacheProgress.textContent = `${percent.toFixed(1)}%`;
  cacheDetail.textContent = complete
    ? `${formatMegabytes(totalBytes)} · 已完成`
    : `${formatMegabytes(loadedBytes)} / ${formatMegabytes(totalBytes)} · ${percent.toFixed(1)}%`;
};

let rendererName = '初始化中';

/** Demux 每解析出一批新帧便刷新，下载完成后显示完整视频信息。 */
const showVideoInfo = ({ width, height, fps, frames, duration }) => {
  if (!debugEnabled) return;
  debugInfo.textContent =
    `${width} × ${height} · ${fps.toFixed(2)} FPS`
    + ` · ${frames} 帧 · ${duration.toFixed(2)} 秒 · ${rendererName}`;
};

try {
  const pageConfig = PlayerPageConfig.fromUrl(window.location.href);
  debugEnabled = pageConfig.debugEnabled;
  if (debugEnabled) debugPanel.hidden = false;

  const player = new TransparentWebmPlayer({
    canvas,
    ...pageConfig.playerOptions,
    onCacheProgress: showCacheProgress,
    onVideoInfoChange: showVideoInfo,
    onError: (error) => {
      if (debugEnabled) debugInfo.textContent = `播放器错误：${error.message}`;
    },
  });

  // Player 创建的 Decoder、AudioContext、VideoFrame 和 GPU 资源必须统一释放。
  window.addEventListener('beforeunload', () => player.dispose());

  // load() 等待首段缓冲和视频首帧预览；剩余资源会继续在后台读取和解析。
  player.load().then((info) => {
    rendererName = info.renderer;
    showVideoInfo(info);

    if (debugEnabled && info.fallbackReason) {
      console.info(`WebGPU 已降级为 WebGL：${info.fallbackReason}`);
    }

    // Canvas 本身承接用户手势，不增加任何可见的播放控件。
    player.canvas.addEventListener('click', () => player.toggle());
  }).catch((error) => {
    if (debugEnabled) debugInfo.textContent = `播放器加载失败：${error.message}`;
  });
} catch (error) {
  debugPanel.hidden = false;
  debugInfo.textContent = `播放器配置错误：${error.message}`;
  console.error(error);
}
