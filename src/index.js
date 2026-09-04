/** WebView 透明视频播放器的页面初始化入口。 */
import { PlayerBridge } from "./bridge/player-bridge.js";
import { ErrorHandler } from "./error/error.js";
import { LogPanel } from "./lib/debug/log-panel.js";
import { PlayerDebugPanel } from "./lib/debug/player-debug-panel.js";
import { PlayerSessionController } from "./lib/player/player-session-controller.js";

//#region 获取 dom元素
const canvasHost = document.querySelector(".player");
const canvas = document.querySelector("#video-canvas");
const debugLayer = document.querySelector("#debug-layer");
//#endregion

//#region 调试功能
const debugEnabled =
  new URL(window.location.href).searchParams.get("debug") === "true";
const playerDebugPanel = PlayerDebugPanel.create({
  enabled: debugEnabled,
  parent: debugLayer,
});
const logPanel = LogPanel.instance.initialize({
  // 保留技术链路回调，但不再在 debug 模式下挂载可视化日志面板。
  enabled: false,
  parent: debugLayer,
});
//#endregion

const playerBridge = new PlayerBridge();
const errorHandler = new ErrorHandler({ bridge: playerBridge });
const sessionController = new PlayerSessionController({
  canvas,
  canvasHost,
  bridge: playerBridge,
  errorHandler,
  onVideoInfoChange: (info) => playerDebugPanel.updateVideoInfo(info),
  onRendererChange: (renderer) => playerDebugPanel.updateRenderer(renderer),
  onError: (error) => playerDebugPanel.showError(error),
  onTechnicalPath: (type, message) => logPanel.add(type, message),
});

/**
 * 宿主应用 → 播放器页面的稳定公共 API。
 * 完整数据到齐前只存在 Session Controller，不创建任何音视频或 GPU 资源。
 */
window.webviewVideo = Object.freeze({
  beginMedia: (command) =>
    errorHandler.handle(command, () => sessionController.beginMedia(command)),
  appendMediaChunk: (command) =>
    errorHandler.handle(command, () => sessionController.appendMediaChunk(command)),
  finishMedia: (command) =>
    errorHandler.handle(command, () => sessionController.finishMedia(command)),
  clear: (command) =>
    errorHandler.handle(command, () => sessionController.clear(command)),
});

// 页面销毁只是兜底；正常情况下每个视频已经在 ended/error/clear 后释放。
window.addEventListener(
  "beforeunload",
  () => sessionController.dispose(),
  { once: true },
);
playerBridge.emit("pageReady");
