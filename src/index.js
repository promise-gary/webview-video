/** 透明视频播放器的精简页面入口。 */
import { PlayerPageConfig } from './config/player-page-config.js';
import { LogPanel } from './lib/debug/log-panel.js';
import { PlayerDebugPanel } from './lib/debug/player-debug-panel.js';
import { TransparentWebmPlayer } from './lib/player/transparent-webm-player.js';

const canvas = document.querySelector('#video-canvas');
const debugLayer = document.querySelector('#debug-layer');
const debugEnabled = new URL(window.location.href).searchParams.get('debug') === 'true';
const playerDebugPanel = PlayerDebugPanel.create({
  enabled: debugEnabled,
  parent: debugLayer,
});
const logPanel = LogPanel.instance.initialize({
  enabled: debugEnabled,
  parent: debugLayer,
});

try {
  const pageConfig = PlayerPageConfig.fromUrl(window.location.href);

  const player = new TransparentWebmPlayer({
    canvas,
    ...pageConfig.playerOptions,
    onCacheProgress: (progress) => playerDebugPanel.updateCache(progress),
    onVideoInfoChange: (videoInfo) => playerDebugPanel.updateVideoInfo(videoInfo),
    onError: (error) => playerDebugPanel.showError(error),
    onTechnicalPath: (type, message) => logPanel.add(type, message),
  });

  // Player 创建的 Decoder、AudioContext、VideoFrame 和 GPU 资源必须统一释放。
  window.addEventListener('beforeunload', () => player.dispose());

  // load() 等待首段缓冲和视频首帧预览；剩余资源会继续在后台读取和解析。
  player.load().then((info) => {
    playerDebugPanel.updateRenderer(info.renderer);
    playerDebugPanel.updateVideoInfo(info);

    // Canvas 本身承接用户手势，不增加任何可见的播放控件。
    player.canvas.addEventListener('click', () => player.toggle());
  }).catch((error) => {
    playerDebugPanel.showError(error);
    logPanel.add('error', error.message);
  });
} catch (error) {
  playerDebugPanel.showError(error);
  logPanel.add('error', `Player Config: ${error.message}`);
  console.error(error);
}
