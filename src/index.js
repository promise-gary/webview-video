import { PlayerBridge } from "./bridge/player-bridge.js";
import { ErrorHandler } from "./error/error.js";
import { PlayerDiagnostics } from "./lib/debug/player-diagnostics.js";
import { PlayerDebugPanel } from "./lib/debug/player-debug-panel.js";
import { SerialVideoController } from "./lib/player/serial-video-controller.js";
import { WebmResourceLoader } from "./network/webm-resource-loader.js";
import { IndexedDbVideoCache } from "./storage/indexeddb-video-cache.js";

const MAX_PRELOAD_CONCURRENCY = 5;

const canvasHost = document.querySelector(".player");
const canvas = document.querySelector("#video-canvas");
const debugLayer = document.querySelector("#debug-layer");
const debugEnabled =
  new URL(window.location.href).searchParams.get("debug") === "true";
const playerBridge = new PlayerBridge();
const diagnostics = PlayerDiagnostics.create({
  enabled: debugEnabled,
  bridge: playerBridge,
});
const errorHandler = new ErrorHandler({ bridge: playerBridge });
diagnostics.info("page.ready", {
  webGpuAvailable: Boolean(navigator.gpu),
  videoDecoderAvailable: "VideoDecoder" in window,
  encodedVideoChunkAvailable: "EncodedVideoChunk" in window,
  indexedDbAvailable: "indexedDB" in window,
  userAgent: navigator.userAgent,
});
diagnostics.sampleMemory("page.ready");
window.addEventListener("error", (event) => {
  const error = event.error instanceof Error
    ? event.error
    : errorHandler.create(event.message || "WebView 发生未知错误。", {
      fileName: event.filename,
    });
  diagnostics.error(
    "window.error",
    error,
    { fileName: event.filename, line: event.lineno, column: event.colno },
  );
  errorHandler.report(error, event.filename);
});
window.addEventListener("unhandledrejection", (event) => {
  diagnostics.error("window.unhandled-rejection", event.reason);
  errorHandler.report(event.reason);
});
const playerDebugPanel = PlayerDebugPanel.create({
  enabled: debugEnabled,
  parent: debugLayer,
});
const videoCache = new IndexedDbVideoCache({ diagnostics, errorHandler });
let controller = null;
let resourceLoader = null;
let initializationPromise = null;
let disposePromise = null;
let pageDisposed = false;

function createController(resources, loader) {
  return new SerialVideoController({
    canvas: canvasHost.querySelector("#video-canvas") ?? canvas,
    canvasHost,
    resources,
    resourceLoader: loader,
    errorHandler,
    diagnostics,
    playerOptions: {
      audioEnabled: false,
      webGpuEnabled: true,
    },
    onDownloadProgress: (progress) => playerDebugPanel.updateDownload(progress),
    onVideoInfoChange: (videoInfo) => playerDebugPanel.updateVideoInfo(videoInfo),
    onRendererChange: (renderer) => playerDebugPanel.updateRenderer(renderer),
    onError: (error) => playerDebugPanel.showError(error),
  });
}

function setResources(resources) {
  try {
    validateResources(resources);
    if (pageDisposed) throw errorHandler.create("播放器页面已释放。");
    if (controller) {
      playerBridge.emit("resources.ready", "", {
        count: controller.resources.length,
        reused: true,
      });
      return;
    }
    if (initializationPromise) return;

    initializationPromise = initializeResources(resources)
      .catch((error) => {
        diagnostics.error("resources.initialize.failed", error);
        errorHandler.report(error);
        playerDebugPanel.showError(error);
      })
      .finally(() => {
        initializationPromise = null;
      });
  } catch (error) {
    errorHandler.report(error);
    throw error;
  }
}

async function initializeResources(resources) {
  await videoCache.open();
  if (pageDisposed) return;

  await videoCache.retain(new Set(resources.map((resource) => resource.cacheKey)));
  if (pageDisposed) return;

  const nextResourceLoader = new WebmResourceLoader({
    cache: videoCache,
    diagnostics,
    errorHandler,
    maxConcurrentDownloads: MAX_PRELOAD_CONCURRENCY,
  });
  const nextController = createController(resources, nextResourceLoader);
  resourceLoader = nextResourceLoader;
  controller = nextController;
  playerBridge.emit("resources.ready", "", {
    count: resources.length,
    reused: false,
    maxPreloadConcurrency: MAX_PRELOAD_CONCURRENCY,
  });
  void nextResourceLoader.preload(resources).catch((error) => {
    diagnostics.error("preload.failed", error);
    errorHandler.report(error);
  });
  void nextController.start();
}

function validateResources(resources) {
  if (!Array.isArray(resources) || resources.length === 0) {
    throw errorHandler.create("视频资源列表不能为空。");
  }
  const cacheKeys = new Set();
  for (const resource of resources) {
    if (!resource || typeof resource !== "object") {
      throw errorHandler.create("视频资源格式无效。");
    }
    if (
      typeof resource.fileName !== "string"
      || !resource.fileName
      || typeof resource.url !== "string"
      || !resource.url
      || typeof resource.cacheKey !== "string"
      || !resource.cacheKey
    ) {
      throw errorHandler.create("视频资源缺少 fileName、url 或 cacheKey。");
    }
    const resourceUrl = new URL(resource.url);
    if (resourceUrl.protocol !== "https:") {
      throw errorHandler.create(`视频资源必须使用 HTTPS：${resource.fileName}`, {
        fileName: resource.fileName,
      });
    }
    if (cacheKeys.has(resource.cacheKey)) {
      throw errorHandler.create(`视频资源 cacheKey 重复：${resource.cacheKey}`, {
        fileName: resource.fileName,
      });
    }
    cacheKeys.add(resource.cacheKey);
  }
}

function disposePlayer() {
  if (disposePromise) return disposePromise;
  pageDisposed = true;
  disposePromise = releasePlayer();
  return disposePromise;
}

async function releasePlayer() {
  await initializationPromise;
  const activeController = controller;
  const activeResourceLoader = resourceLoader;
  controller = null;
  resourceLoader = null;
  const controllerDisposePromise = activeController?.dispose();
  const loaderDisposePromise = activeResourceLoader?.dispose();
  const [controllerDisposeResult] = await Promise.allSettled([
    controllerDisposePromise,
    loaderDisposePromise,
  ]);
  if (controllerDisposeResult.status === "rejected") {
    errorHandler.report(controllerDisposeResult.reason);
  }
  videoCache.close();
  playerBridge.emit("disposed");
}

window.webviewVideo = Object.freeze({
  setResources,
  playPrevious: () => controller?.playPrevious(),
  playNext: () => controller?.playNext(),
  clear: () => controller?.clear(),
  dispose: disposePlayer,
});
playerBridge.emit("version", "", { version: "double-1.1.0" });

window.addEventListener("beforeunload", disposePlayer, {
  once: true,
});
