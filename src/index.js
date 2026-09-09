import { PlayerBridge } from './bridge/player-bridge.js';
import { ErrorHandler } from './error/error.js';
import { PlayerDebugPanel } from './lib/debug/player-debug-panel.js';
import { SerialVideoController } from './lib/player/serial-video-controller.js';

const RESOURCE_BASE_URL = 'https://downloadcdn.oopz.cn/video_test_20260902';
const RESOURCE_QUALITIES = Object.freeze(['low', 'standard', 'high']);
const resources = [];
for (let number = 1; number <= 134; number += 1) {
  const prefix = String(number).padStart(3, '0');
  for (const quality of RESOURCE_QUALITIES) {
    const fileName = `${prefix}-${quality}.webm`;
    resources.push({ fileName, url: `${RESOURCE_BASE_URL}/${fileName}` });
  }
}
Object.freeze(resources);

const canvasHost = document.querySelector('.player');
const canvas = document.querySelector('#video-canvas');
const debugLayer = document.querySelector('#debug-layer');
const debugEnabled = new URL(window.location.href).searchParams.get('debug') === 'true';
const playerDebugPanel = PlayerDebugPanel.create({
  enabled: debugEnabled,
  parent: debugLayer,
});
const playerBridge = new PlayerBridge();
const errorHandler = new ErrorHandler({ bridge: playerBridge });
const controller = new SerialVideoController({
  canvas,
  canvasHost,
  resources,
  errorHandler,
  playerOptions: {
    audioEnabled: false,
    webGpuEnabled: true,
  },
  onDownloadProgress: (progress) => playerDebugPanel.updateDownload(progress),
  onVideoInfoChange: (videoInfo) => playerDebugPanel.updateVideoInfo(videoInfo),
  onRendererChange: (renderer) => playerDebugPanel.updateRenderer(renderer),
  onError: (error) => playerDebugPanel.showError(error),
});

window.webviewVideo = Object.freeze({
  playPrevious: () => controller.playPrevious(),
  playNext: () => controller.playNext(),
  clear: () => controller.clear(),
});
playerBridge.emit('version', '', { version: '1.0.0' });

window.addEventListener('beforeunload', () => controller.dispose(), { once: true });
void controller.start();
