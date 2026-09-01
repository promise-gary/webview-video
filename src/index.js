/** 透明视频播放器的精简页面入口。 */
import { NativeBridge } from './bridge/native-bridge.js';
import { PlayerPageConfig } from './config/player-page-config.js';
import { ErrorReporter, PlayerError } from './error/error-reporter.js';
import { LogPanel } from './lib/debug/log-panel.js';
import { PlayerDebugPanel } from './lib/debug/player-debug-panel.js';
import { TransparentWebmPlayer } from './lib/player/transparent-webm-player.js';
import { BridgeReader } from './resource/bridge-reader.js';

const canvas = document.querySelector('#video-canvas');
const debugLayer = document.querySelector('#debug-layer');

class PlayerApplication {
  constructor({ playerCanvas, playerDebugLayer, bridge }) {
    this.canvas = playerCanvas;
    this.debugLayer = playerDebugLayer;
    this.bridge = bridge;
    this.playerDebugPanel = null;
    this.logPanel = null;
    this.activeSession = null;
    this.errorReporter = new ErrorReporter({
      bridge,
      getPlayerDebugPanel: () => this.playerDebugPanel,
      getLogPanel: () => this.logPanel,
    });
  }

  async open(input) {
    let session = null;
    try {
      const pageConfig = PlayerPageConfig.fromInput(input);
      this._initializeDebug(pageConfig.debugEnabled);
      const reader = new BridgeReader({
        bridge: this.bridge,
        sessionId: input?.sessionId,
        totalBytes: input?.totalBytes,
        chunkSize: input?.chunkSize,
      });

      this._disposeActiveSession('replaced');
      session = {
        id: reader.sessionId,
        reader,
        player: null,
        playing: false,
      };
      this.activeSession = session;

      const player = new TransparentWebmPlayer({
        canvas: this.canvas,
        resourceReader: reader,
        ...pageConfig.playerOptions,
        onCacheProgress: (progress) => this.playerDebugPanel.updateCache(progress),
        onVideoInfoChange: (videoInfo) => this.playerDebugPanel.updateVideoInfo(videoInfo),
        onError: (error) => this.errorReporter.report(session, error),
        onPlayingChange: (playing, state) => this._handlePlayingChange(session, playing, state),
        onTechnicalPath: (type, message) => this.logPanel.add(type, message),
      });
      session.player = player;

      // 完整资源接收并初始化后，通知宿主并单次自动播放。
      const info = await player.load();
      if (this.activeSession !== session) return;

      this.canvas = player.canvas;
      this.playerDebugPanel.updateRenderer(info.renderer);
      this.playerDebugPanel.updateVideoInfo(info);
      this.bridge.post('resourceReady', {
        sessionId: session.id,
        ...info,
      });
      await player.start();
    } catch (error) {
      if (session && this.activeSession !== session) return;
      this.errorReporter.report(session, error);
    }
  }

  receiveResourceChunk(payload) {
    return this.activeSession?.reader.acceptChunk(payload) ?? false;
  }

  failResource(payload) {
    if (!payload || payload.sessionId !== this.activeSession?.id) return false;
    const message = typeof payload.message === 'string'
      ? payload.message
      : '宿主读取本地资源失败。';
    this.activeSession.reader.fail(
      new PlayerError('BRIDGE_FAILED', 'resource', message)
    );
    return true;
  }

  dispose(reason = 'disposed') {
    this._disposeActiveSession(reason);
  }

  _initializeDebug(enabled) {
    if (this.playerDebugPanel && this.logPanel) return;
    this.playerDebugPanel = PlayerDebugPanel.create({
      enabled,
      parent: this.debugLayer,
    });
    this.logPanel = LogPanel.instance.initialize({
      enabled,
      parent: this.debugLayer,
    });
  }

  _handlePlayingChange(session, playing, state) {
    if (this.activeSession !== session) return;
    if (playing) {
      if (session.playing) return;
      session.playing = true;
      this.bridge.post('playStarted', {
        sessionId: session.id,
        currentTime: session.player.currentTimeUs / 1_000_000,
      });
      return;
    }

    if (!session.playing) return;
    session.playing = false;
    this.bridge.post('playStopped', {
      sessionId: session.id,
      currentTime: session.player.currentTimeUs / 1_000_000,
      reason: state,
    });
  }

  _disposeActiveSession(reason) {
    const session = this.activeSession;
    if (!session) return;
    this.activeSession = null;

    if (session.playing) {
      this.bridge.post('playStopped', {
        sessionId: session.id,
        currentTime: session.player.currentTimeUs / 1_000_000,
        reason,
      });
    }
    session.player?.dispose();
    session.reader.cancel();
  }

}

const bridge = new NativeBridge();
const application = new PlayerApplication({
  playerCanvas: canvas,
  playerDebugLayer: debugLayer,
  bridge,
});

window.WebviewVideo = Object.freeze({
  open: (input) => application.open(input),
  receiveResourceChunk: (payload) => application.receiveResourceChunk(payload),
  failResource: (payload) => application.failResource(payload),
  dispose: () => application.dispose(),
});

// Player 创建的 Decoder、AudioContext、VideoFrame 和 GPU 资源必须统一释放。
window.addEventListener('beforeunload', () => application.dispose());
bridge.post('pageReady', { protocolVersion: 1 });
