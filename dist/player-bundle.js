/* 此文件由 npm run build 自动生成，请勿直接修改。 */
(() => {
  'use strict';

  const moduleFactories = {
    "src/index.js": (module, exports, require) => {
      /** 透明视频播放器的精简页面入口。 */
      const { NativeBridge } = require("src/bridge/native-bridge.js");
      const { PlayerPageConfig } = require("src/config/player-page-config.js");
      const { ErrorReporter, PlayerError } = require("src/error/error-reporter.js");
      const { LogPanel } = require("src/lib/debug/log-panel.js");
      const { PlayerDebugPanel } = require("src/lib/debug/player-debug-panel.js");
      const { TransparentWebmPlayer } = require("src/lib/player/transparent-webm-player.js");
      const { BridgeReader } = require("src/resource/bridge-reader.js");
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
      
    },
    "src/bridge/native-bridge.js": (module, exports, require) => {
      const DEFAULT_CHANNEL_NAME = 'WebviewVideoBridge';
      
      /** 封装 WebView 页面向宿主发送的字符串消息。 */
      class NativeBridge {
        constructor({ channelName = DEFAULT_CHANNEL_NAME } = {}) {
          this.channelName = channelName;
        }
      
        post(type, payload = {}) {
          const channel = window[this.channelName];
          if (!channel || typeof channel.postMessage !== 'function') {
            console.warn(`未检测到 ${this.channelName} JavaScript Channel。`);
            return false;
          }
      
          channel.postMessage(JSON.stringify({ ...payload, type }));
          return true;
        }
      }
      
      Object.assign(exports, { NativeBridge });
    },
    "src/config/player-page-config.js": (module, exports, require) => {
      const DEFAULT_PLAYER_OPTIONS = {
        audioEnabled: false,
        webGpuEnabled: true,
      };
      
      /** 解析宿主通过 Bridge 传入的播放器配置。 */
      class PlayerPageConfig {
        static fromInput(input = {}) {
          const values = input && typeof input === 'object' ? input : {};
      
          return {
            debugEnabled: this._readBoolean(values, 'debug', false),
            playerOptions: {
              audioEnabled: this._readBoolean(
                values,
                'audioEnabled',
                DEFAULT_PLAYER_OPTIONS.audioEnabled
              ),
              webGpuEnabled: this._readBoolean(
                values,
                'webGpuEnabled',
                DEFAULT_PLAYER_OPTIONS.webGpuEnabled
              ),
            },
          };
        }
      
        static _readBoolean(values, name, defaultValue) {
          const value = values[name];
          return typeof value === 'boolean' ? value : defaultValue;
        }
      }
      
      Object.assign(exports, { PlayerPageConfig });
    },
    "src/error/error-reporter.js": (module, exports, require) => {
      class PlayerError extends Error {
        constructor(code, stage, message, cause = null) {
          super(message);
          this.name = 'PlayerError';
          this.code = code;
          this.stage = stage;
          if (cause) this.cause = cause;
        }
      
        static from(error, code, stage, message = '') {
          if (error instanceof PlayerError) return error;
          const detail = error instanceof Error ? error.message : String(error);
          return new PlayerError(code, stage, message || detail, error);
        }
      }
      
      /** 将播放器错误统一转换为 Bridge 事件，不让异常穿透页面入口。 */
      class ErrorReporter {
        constructor({ bridge, getPlayerDebugPanel, getLogPanel }) {
          this.bridge = bridge;
          this.getPlayerDebugPanel = getPlayerDebugPanel;
          this.getLogPanel = getLogPanel;
          this.reportedSessions = new WeakSet();
        }
      
        report(session, error, fallback = {}) {
          if (session && this.reportedSessions.has(session)) return;
          if (session) this.reportedSessions.add(session);
      
          const playerError = PlayerError.from(
            error,
            fallback.code ?? 'PLAYBACK_FAILED',
            fallback.stage ?? 'playback',
            fallback.message
          );
          this.getPlayerDebugPanel()?.showError(playerError);
          this.getLogPanel()?.add('error', playerError.message);
          this.bridge.post('playerError', {
            sessionId: session?.id ?? '',
            code: playerError.code,
            stage: playerError.stage,
            message: playerError.message,
          });
          console.error(playerError);
        }
      }
      
      Object.assign(exports, { PlayerError, ErrorReporter });
    },
    "src/lib/debug/log-panel.js": (module, exports, require) => {
      const LOG_TYPES = Object.freeze({
        success: { symbol: '✓', className: 'success' },
        info: { symbol: '→', className: 'info' },
        warning: { symbol: '⚠', className: 'warning' },
        error: { symbol: '✕', className: 'error' },
      });
      
      let logPanelInstance = null;
      
      /** 仅在 debug 模式展示播放器实际经过的技术节点。 */
      class LogPanel {
        static get instance() {
          if (!logPanelInstance) logPanelInstance = new LogPanel();
          return logPanelInstance;
        }
      
        constructor() {
          if (logPanelInstance) return logPanelInstance;
      
          this.enabled = false;
          this.initialized = false;
          this.loggedEntries = new Set();
          this.list = null;
          logPanelInstance = this;
        }
      
        initialize({ enabled, parent }) {
          if (this.initialized) return this;
          this.initialized = true;
          this.enabled = enabled;
      
          if (enabled) {
            parent.hidden = false;
            this._mount(parent);
          }
          return this;
        }
      
        add(type, message) {
          if (!this.enabled || !this.list) return;
      
          const logType = LOG_TYPES[type] ?? LOG_TYPES.info;
          const entryKey = `${logType.className}:${message}`;
          if (this.loggedEntries.has(entryKey)) return;
          this.loggedEntries.add(entryKey);
      
          const item = document.createElement('div');
          item.className = `log-panel__item log-panel__item--${logType.className}`;
      
          const symbol = document.createElement('span');
          symbol.className = 'log-panel__symbol';
          symbol.textContent = logType.symbol;
      
          const text = document.createElement('span');
          text.textContent = message;
      
          item.append(symbol, text);
          this.list.append(item);
          this.list.scrollTop = this.list.scrollHeight;
      
          if (type === 'error') console.error(`[Video Debug] ${logType.symbol} ${message}`);
          else if (type === 'warning') console.warn(`[Video Debug] ${logType.symbol} ${message}`);
          else console.debug(`[Video Debug] ${logType.symbol} ${message}`);
        }
      
        _mount(parent) {
          const style = document.createElement('style');
          style.textContent = `
            .log-panel {
              width: min(210px, calc(100% - 16px));
              max-height: 45vh;
              align-self: flex-end;
              flex: 0 1 auto;
              padding: 8px;
              overflow: hidden;
              border: 1px solid rgb(255 255 255 / 16%);
              border-radius: 8px;
              background: rgb(0 0 0 / 78%);
              color: #fff;
              font: 10px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
              pointer-events: none;
            }
      
            .log-panel__title {
              margin-bottom: 5px;
              color: #cbd5e1;
              font-weight: 700;
              letter-spacing: 0.08em;
            }
      
            .log-panel__list {
              max-height: calc(45vh - 34px);
              overflow: auto;
              scrollbar-width: none;
            }
      
            .log-panel__list::-webkit-scrollbar {
              display: none;
            }
      
            .log-panel__item {
              display: grid;
              grid-template-columns: 12px minmax(0, 1fr);
              gap: 3px;
            }
      
            .log-panel__item--success {
              color: #86efac;
            }
      
            .log-panel__item--info {
              color: #bfdbfe;
            }
      
            .log-panel__item--warning {
              color: #fde68a;
            }
      
            .log-panel__item--error {
              color: #fca5a5;
            }
          `;
      
          const panel = document.createElement('aside');
          panel.className = 'log-panel';
          panel.setAttribute('aria-label', '播放器技术链路');
      
          const title = document.createElement('div');
          title.className = 'log-panel__title';
          title.textContent = 'VIDEO DEBUG';
      
          this.list = document.createElement('div');
          this.list.className = 'log-panel__list';
      
          panel.append(title, this.list);
          document.head.append(style);
          parent.prepend(panel);
        }
      }
      
      Object.assign(exports, { LogPanel });
    },
    "src/lib/debug/player-debug-panel.js": (module, exports, require) => {
      /** 播放器业务调试面板：展示媒体信息、实际 Renderer 和资源缓存进度。 */
      class PlayerDebugPanel {
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
      
      Object.assign(exports, { PlayerDebugPanel });
    },
    "src/lib/player/transparent-webm-player.js": (module, exports, require) => {
      const { PlayerError } = require("src/error/error-reporter.js");
      const { EncodedMediaStore } = require("src/store/encoded-media-store.js");
      const { WebAudioClock } = require("src/lib/audio/web-audio-clock.js");
      const { IncrementalWebmDemuxer } = require("src/lib/demuxers/incremental-webm-demuxer.js");
      const { RendererFactory } = require("src/lib/renderers/renderer-factory.js");
      const MAX_BUFFERED_PAIRS = 8;
      const AUDIO_DURATION_TOLERANCE_US = 50_000;
      
      /** 完整接收宿主资源后，单次自动播放透明 WebM。 */
      class TransparentWebmPlayer {
        constructor({
          canvas,
          resourceReader,
          audioEnabled = false,
          webGpuEnabled = true,
          onCacheProgress = () => {},
          onVideoInfoChange = () => {},
          onError = () => {},
          onPlayingChange = () => {},
          onTechnicalPath = () => {},
        }) {
          this.canvas = canvas;
          this.resourceReader = resourceReader;
          this.audioEnabled = audioEnabled;
          this.webGpuEnabled = webGpuEnabled;
          this.onCacheProgress = onCacheProgress;
          this.onVideoInfoChange = onVideoInfoChange;
          this.onError = onError;
          this.onPlayingChange = onPlayingChange;
          this.onTechnicalPath = onTechnicalPath;
      
          this.renderer = null;
          this.decoderConfig = null;
          this.colorDecoder = null;
          this.alphaDecoder = null;
          this.audioClock = null;
          this.demuxer = null;
          this.store = new EncodedMediaStore();
      
          this.nextPairIndex = 0;
          this.partialPairs = new Map();
          this.decodedPairs = [];
          this.pairsInFlight = 0;
          this.renderingPairs = 0;
          this.currentTimeUs = 0;
          this.playbackStartedAt = 0;
          this.animationId = 0;
      
          this.started = false;
          this.playing = false;
          this.failed = false;
          this.disposed = false;
          this.renderFrame = (now) => this._render(now);
        }
      
        /** 接收完整资源，完成 Demux、解码器及渲染器初始化。 */
        async load() {
          if (!('VideoDecoder' in window) || !('EncodedVideoChunk' in window)) {
            this._reportTechnicalPath('error', 'WebCodecs VideoDecoder Unsupported');
            throw new PlayerError('DECODER_FAILED', 'decoder', '当前环境不支持 VideoDecoder。');
          }
          this._reportTechnicalPath('success', 'WebCodecs VideoDecoder');
      
          try {
            if (!this.resourceReader?.read) {
              throw new PlayerError('BRIDGE_FAILED', 'resource', '缺少可用的本地资源读取器。');
            }
      
            this.demuxer = new IncrementalWebmDemuxer();
            await this._loadResource();
            if (!this.store.metadata || !this.store.frames.length) {
              throw new PlayerError('DEMUX_FAILED', 'demux', '本地资源不包含可播放的视频帧。');
            }
      
            await this._initializeMedia();
            this._reportTechnicalPath('success', 'Resource Ready');
            return this._createLoadInfo();
          } catch (error) {
            const playerError = PlayerError.from(error, 'PLAYBACK_FAILED', 'playback');
            this._reportTechnicalPath('error', playerError.message);
            this.dispose();
            throw playerError;
          }
        }
      
        /** 仅由页面入口在 resourceReady 之后调用，不提供暂停或重播。 */
        async start() {
          if (this.started || this.failed || this.disposed) return;
          this.started = true;
      
          try {
            await this.audioClock?.start();
            if (this.failed || this.disposed) return;
            this.playbackStartedAt = performance.now();
            this.playing = true;
            this._reportTechnicalPath('success', 'Playing');
            this.onPlayingChange(true, 'playing');
            this._decodeAhead();
            this.animationId = requestAnimationFrame(this.renderFrame);
          } catch (error) {
            this._fail(PlayerError.from(error, 'AUDIO_FAILED', 'audio', '音频播放失败。'));
          }
        }
      
        dispose() {
          if (this.disposed) return;
          this.disposed = true;
          this.playing = false;
          this.resourceReader?.cancel();
          cancelAnimationFrame(this.animationId);
          this.animationId = 0;
          this.audioClock?.dispose();
          this._closeBufferedFrames();
          this._closeDecoders();
          this.renderer?.destroy();
        }
      
        async _loadResource() {
          this._notifyCacheProgress(false);
          let streamStarted = false;
      
          try {
            for await (const bytes of this.resourceReader.read()) {
              if (!streamStarted) {
                streamStarted = true;
                this._reportTechnicalPath('success', 'Native Bridge');
                this._reportTechnicalPath('success', 'Chunked Resource');
              }
      
              let output;
              try {
                output = this.demuxer.append(bytes);
              } catch (error) {
                throw PlayerError.from(error, 'DEMUX_FAILED', 'demux');
              }
              this._acceptDemuxed(output);
              this.store.sourceBytes = this.resourceReader.loadedBytes;
              this._notifyCacheProgress(false);
            }
          } catch (error) {
            throw PlayerError.from(error, 'BRIDGE_FAILED', 'resource');
          }
      
          try {
            this._acceptDemuxed(this.demuxer.finish());
          } catch (error) {
            throw PlayerError.from(error, 'DEMUX_FAILED', 'demux');
          }
          this.store.finish(this.resourceReader.loadedBytes);
          this._notifyCacheProgress(true);
        }
      
        _acceptDemuxed(output) {
          this.store.append(output);
          if (output.metadata) {
            this._reportTechnicalPath('success', 'WebM Demux');
            if (output.metadata.audio) this._reportTechnicalPath('success', 'Opus Track');
          }
          if (output.frames.length) {
            this._reportTechnicalPath('success', 'VP9 Color Track');
            this._reportTechnicalPath('success', 'VP9 Alpha Track');
          }
          if (this.store.metadata) this.onVideoInfoChange(this._createVideoInfo());
        }
      
        async _initializeMedia() {
          const metadata = this.store.metadata;
          this.canvas.width = metadata.width;
          this.canvas.height = metadata.height;
      
          try {
            if (!this.webGpuEnabled) this._reportTechnicalPath('info', 'WebGPU Disabled');
            this.renderer = await RendererFactory.create(this.canvas, {
              webGpuEnabled: this.webGpuEnabled,
            });
          } catch (error) {
            throw PlayerError.from(error, 'RENDERER_FAILED', 'renderer');
          }
      
          this.canvas = this.renderer.canvas;
          if (this.webGpuEnabled && this.renderer.name === 'WebGL') {
            this._reportTechnicalPath('warning', 'WebGPU Failed');
            this._reportTechnicalPath('info', 'Fallback to WebGL');
          }
          this._reportTechnicalPath('success', `${this.renderer.name} Renderer`);
          this._reportTechnicalPath(
            'success',
            this.renderer.name === 'WebGPU' ? 'WGSL Alpha Compose' : 'GLSL Alpha Compose'
          );
      
          this.decoderConfig = await this._getDecoderConfig(
            metadata.codec,
            metadata.width,
            metadata.height
          );
          this._createDecoders();
      
          if (!this.audioEnabled) {
            this._reportTechnicalPath('info', 'Audio Disabled');
            return;
          }
          if (!metadata.audio) {
            throw new PlayerError('AUDIO_FAILED', 'audio', '启用音频时，WebM 必须包含 Opus 音轨。');
          }
      
          try {
            this.audioClock = new WebAudioClock(metadata.audio, {
              onError: (error) => this._fail(PlayerError.from(error, 'AUDIO_FAILED', 'audio')),
            });
            await this.audioClock.initialize();
            for (const chunk of this.store.audioChunks) this.audioClock.append(chunk);
            await this.audioClock.end();
            this.store.audioChunks = [];
            this._reportTechnicalPath('success', 'Opus AudioDecoder');
            this._reportTechnicalPath('success', 'Web Audio Clock');
            this._reportDurationDifference();
          } catch (error) {
            throw PlayerError.from(error, 'AUDIO_FAILED', 'audio');
          }
        }
      
        _reportDurationDifference() {
          if (!this.audioClock?.durationUs || !this.store.videoBufferedEndUs) return;
          const differenceUs = Math.abs(this.audioClock.durationUs - this.store.videoBufferedEndUs);
          if (differenceUs > AUDIO_DURATION_TOLERANCE_US) {
            this._reportTechnicalPath('warning', 'Audio Duration Mismatch');
          }
        }
      
        _notifyCacheProgress(complete) {
          this.onCacheProgress({
            loadedBytes: this.resourceReader?.loadedBytes ?? 0,
            totalBytes: this.resourceReader?.totalBytes ?? 0,
            complete,
          });
        }
      
        _createLoadInfo() {
          return {
            ...this._createVideoInfo(),
            sourceBytes: this.store.sourceBytes,
            resourceComplete: this.store.complete,
            renderer: this.renderer.name,
            fallbackReason: this.renderer.fallbackReason ?? '',
            audioEnabled: Boolean(this.audioClock),
          };
        }
      
        _createVideoInfo() {
          const durationUs = this.store.videoBufferedEndUs;
          return {
            width: this.store.metadata.width,
            height: this.store.metadata.height,
            frames: this.store.frames.length,
            fps: durationUs ? this.store.frames.length / (durationUs / 1_000_000) : 0,
            duration: durationUs / 1_000_000,
          };
        }
      
        async _getDecoderConfig(codec, width, height) {
          try {
            const support = await VideoDecoder.isConfigSupported({
              codec,
              codedWidth: width,
              codedHeight: height,
              hardwareAcceleration: 'prefer-hardware',
              optimizeForLatency: true,
            });
            if (!support.supported) throw new Error(`当前环境不支持 ${codec}。`);
            this._reportTechnicalPath('success', 'VP9 Decoder Supported');
            return support.config;
          } catch (error) {
            throw PlayerError.from(error, 'DECODER_FAILED', 'decoder');
          }
        }
      
        _createDecoders() {
          try {
            this.colorDecoder = new VideoDecoder({
              output: (frame) => this._acceptFrame('color', frame),
              error: (error) => this._fail(PlayerError.from(error, 'DECODER_FAILED', 'decoder')),
            });
            this.alphaDecoder = new VideoDecoder({
              output: (frame) => this._acceptFrame('alpha', frame),
              error: (error) => this._fail(PlayerError.from(error, 'DECODER_FAILED', 'decoder')),
            });
            this.colorDecoder.configure(this.decoderConfig);
            this._reportTechnicalPath('success', 'Color VideoDecoder');
            this.alphaDecoder.configure(this.decoderConfig);
            this._reportTechnicalPath('success', 'Alpha VideoDecoder');
          } catch (error) {
            throw PlayerError.from(error, 'DECODER_FAILED', 'decoder');
          }
        }
      
        _submitPair(pair) {
          this.colorDecoder.decode(this._createChunk(pair.color, pair));
          this.alphaDecoder.decode(this._createChunk(pair.alpha, pair));
          this.store.frames[this.nextPairIndex] = null;
          this.nextPairIndex += 1;
          this.pairsInFlight += 1;
        }
      
        _createChunk(frame, pair) {
          return new EncodedVideoChunk({
            type: frame.type,
            timestamp: pair.timestamp,
            duration: pair.duration,
            data: frame.data,
          });
        }
      
        _acceptFrame(channel, frame) {
          if (this.failed || this.disposed) {
            frame.close();
            return;
          }
          const pair = this.partialPairs.get(frame.timestamp) ?? { timestamp: frame.timestamp };
          pair[channel]?.close();
          pair[channel] = frame;
          this.partialPairs.set(frame.timestamp, pair);
          if (!pair.color || !pair.alpha) return;
      
          this._reportTechnicalPath('success', 'Color + Alpha Pair');
          this.partialPairs.delete(frame.timestamp);
          this.pairsInFlight = Math.max(0, this.pairsInFlight - 1);
          this.decodedPairs.push(pair);
          this.decodedPairs.sort((left, right) => left.timestamp - right.timestamp);
        }
      
        _decodeAhead() {
          if (
            !this.playing
            || this.failed
            || this.colorDecoder?.state !== 'configured'
            || this.alphaDecoder?.state !== 'configured'
          ) return;
      
          try {
            while (
              this.nextPairIndex < this.store.frames.length
              && this.decodedPairs.length + this.pairsInFlight + this.renderingPairs < MAX_BUFFERED_PAIRS
            ) {
              this._submitPair(this.store.frames[this.nextPairIndex]);
            }
          } catch (error) {
            this._fail(PlayerError.from(error, 'DECODER_FAILED', 'decoder'));
          }
        }
      
        _render(now) {
          if (!this.playing || this.failed) return;
          this.audioClock?.schedule();
          this.currentTimeUs = this._readClock(now);
      
          if (this.currentTimeUs >= this._getDurationUs()) {
            this._finishPlayback();
            return;
          }
      
          this._drawThrough(this.currentTimeUs);
          this._decodeAhead();
          this.animationId = requestAnimationFrame(this.renderFrame);
        }
      
        _readClock(now) {
          const timestampUs = this.audioClock
            ? this.audioClock.currentTimeUs
            : (now - this.playbackStartedAt) * 1000;
          return Math.min(Math.max(timestampUs, 0), this._getDurationUs());
        }
      
        _drawThrough(timestampUs) {
          let selectedPair = null;
          while (this.decodedPairs.length && this.decodedPairs[0].timestamp <= timestampUs) {
            if (selectedPair) TransparentWebmPlayer._closePair(selectedPair);
            selectedPair = this.decodedPairs.shift();
          }
          if (selectedPair) this._drawPair(selectedPair);
        }
      
        _drawPair(pair) {
          this.renderingPairs += 1;
          this.renderer.render(pair)
            .then(() => this._reportTechnicalPath('success', 'First Frame Rendered'))
            .catch((error) => this._fail(PlayerError.from(error, 'RENDERER_FAILED', 'renderer')))
            .finally(() => {
              TransparentWebmPlayer._closePair(pair);
              this.renderingPairs = Math.max(0, this.renderingPairs - 1);
              this._decodeAhead();
            });
        }
      
        _finishPlayback() {
          const durationUs = this._getDurationUs();
          this.currentTimeUs = durationUs;
          this._drawThrough(durationUs);
          this.playing = false;
          this.audioClock?.stop();
          this.animationId = 0;
          this.onPlayingChange(false, 'ended');
        }
      
        _getDurationUs() {
          return this.audioClock?.durationUs
            ? Math.min(this.audioClock.durationUs, this.store.videoBufferedEndUs)
            : this.store.videoBufferedEndUs;
        }
      
        _fail(error) {
          if (this.failed || this.disposed) return;
          this.failed = true;
          this.playing = false;
          cancelAnimationFrame(this.animationId);
          this.animationId = 0;
          this.audioClock?.stop();
          this._closeBufferedFrames();
          this._closeDecoders();
          this._reportTechnicalPath('error', error.message);
          this.onError(error);
          this.onPlayingChange(false, 'failed');
        }
      
        _closeBufferedFrames() {
          for (const pair of this.partialPairs.values()) {
            pair.color?.close();
            pair.alpha?.close();
          }
          this.partialPairs.clear();
          for (const pair of this.decodedPairs) TransparentWebmPlayer._closePair(pair);
          this.decodedPairs = [];
        }
      
        _closeDecoders() {
          for (const decoder of [this.colorDecoder, this.alphaDecoder]) {
            if (decoder && decoder.state !== 'closed') decoder.close();
          }
        }
      
        _reportTechnicalPath(type, message) {
          this.onTechnicalPath(type, message);
        }
      
        static _closePair(pair) {
          pair.color.close();
          pair.alpha.close();
        }
      }
      
      Object.assign(exports, { TransparentWebmPlayer });
    },
    "src/store/encoded-media-store.js": (module, exports, require) => {
      /** 保存 Demux 产生的压缩媒体数据，已解码的 VideoFrame 由播放器及时释放。 */
      class EncodedMediaStore {
        constructor() {
          this.metadata = null;
          this.frames = [];
          this.audioChunks = [];
          this.videoBufferedEndUs = 0;
          this.sourceBytes = 0;
          this.complete = false;
        }
      
        append({ metadata, frames, audioChunks }) {
          if (metadata) this.metadata = metadata;
          this.frames.push(...frames);
          this.audioChunks.push(...audioChunks);
          for (const frame of frames) {
            this.videoBufferedEndUs = Math.max(
              this.videoBufferedEndUs,
              frame.timestamp + frame.duration
            );
          }
        }
      
        finish(sourceBytes) {
          this.sourceBytes = sourceBytes;
          this.complete = true;
        }
      }
      
      Object.assign(exports, { EncodedMediaStore });
    },
    "src/lib/audio/web-audio-clock.js": (module, exports, require) => {
      /**
       * 完整 Opus 解码后，为单次播放提供 Web Audio 时钟。
       */
      class WebAudioClock {
        constructor(stream, { onError = () => {} } = {}) {
          this.stream = stream;
          this.onError = onError;
          this.audioContext = null;
          this.decoder = null;
          this.blocks = [];
          this.sources = new Set();
          this.inputEnded = false;
          this.durationUs = 0;
          this.contextStartTime = 0;
          this.scheduledUntilUs = 0;
          this.playing = false;
          this.disposed = false;
        }
      
        /** 配置 Decoder 和 AudioContext，不会触发声音。 */
        async initialize() {
          if (!('AudioDecoder' in window) || !('EncodedAudioChunk' in window)) {
            throw new Error('当前环境不支持 AudioDecoder。');
          }
          const AudioContextConstructor = window.AudioContext ?? window.webkitAudioContext;
          if (!AudioContextConstructor) throw new Error('当前环境不支持 Web Audio。');
      
          const support = await AudioDecoder.isConfigSupported({
            codec: this.stream.codec,
            sampleRate: this.stream.sampleRate,
            numberOfChannels: this.stream.numberOfChannels,
          });
          if (!support.supported) throw new Error(`当前环境不支持音频编码 ${this.stream.codec}。`);
      
          this.audioContext = new AudioContextConstructor();
          this.decoder = new AudioDecoder({
            output: (audioData) => this._acceptAudioData(audioData),
            error: (error) => this.onError(error),
          });
          this.decoder.configure(support.config);
        }
      
        /** 每个 WebM Opus packet 到达后立即送入 AudioDecoder。 */
        append(chunk) {
          if (!this.decoder || this.inputEnded || this.disposed) return;
          this.decoder.decode(new EncodedAudioChunk({
            type: chunk.type,
            timestamp: chunk.timestamp,
            duration: chunk.duration,
            data: chunk.data,
          }));
        }
      
        /** 输入结束时 flush 最后几个 Opus packet，并确定完整音频时长。 */
        async end() {
          if (!this.decoder || this.inputEnded) return;
          this.inputEnded = true;
          await this.decoder.flush();
          this._closeDecoder();
          this.blocks.sort((left, right) => left.timestamp - right.timestamp);
          this.durationUs = this.bufferedEndUs;
        }
      
        get bufferedEndUs() {
          const last = this.blocks.at(-1);
          return last ? last.timestamp + last.duration : 0;
        }
      
        get currentTimeUs() {
          if (!this.playing || !this.audioContext) return 0;
          return Math.min(this._currentAbsoluteTimeUs(), this.durationUs);
        }
      
        /** 从起点排程 PCM，AudioContext 是视频的主时钟。 */
        async start() {
          if (!this.audioContext || !this.blocks.length || this.disposed) {
            throw new Error('音频资源尚未就绪。');
          }
          await this.audioContext.resume();
          if (this.disposed) return;
      
          this._stopSources();
          this.contextStartTime = this.audioContext.currentTime;
          this.scheduledUntilUs = 0;
          this.playing = true;
          this.schedule();
        }
      
        /** rAF 中持续调用，始终让扬声器前方保留约 1 秒已排程 PCM。 */
        schedule() {
          if (!this.playing || !this.audioContext || !this.blocks.length) return;
          const currentUs = this._currentAbsoluteTimeUs();
          const targetUs = Math.min(currentUs + 1_000_000, this.durationUs);
          if (this.scheduledUntilUs < currentUs) this.scheduledUntilUs = currentUs;
      
          while (this.scheduledUntilUs < targetUs) {
            const positionUs = this.scheduledUntilUs;
            const block = this.blocks.find((candidate) => (
              candidate.timestamp <= positionUs
              && positionUs < candidate.timestamp + candidate.duration
            ));
            if (!block) return;
      
            const offsetUs = positionUs - block.timestamp;
            const playableUs = block.duration - offsetUs;
            const source = this.audioContext.createBufferSource();
            source.buffer = this._getAudioBuffer(block);
            source.connect(this.audioContext.destination);
            source.onended = () => {
              source.disconnect();
              this.sources.delete(source);
            };
            source.start(
              this.contextStartTime + this.scheduledUntilUs / 1_000_000,
              offsetUs / 1_000_000,
              playableUs / 1_000_000
            );
            this.sources.add(source);
            this.scheduledUntilUs += playableUs;
          }
        }
      
        /** 播放结束、失败或销毁时停止已排程的音频。 */
        stop() {
          this.playing = false;
          this._stopSources();
        }
      
        dispose() {
          if (this.disposed) return;
          this.disposed = true;
          this.stop();
          this._closeDecoder();
          this.blocks = [];
          if (this.audioContext && this.audioContext.state !== 'closed') void this.audioContext.close();
          this.audioContext = null;
        }
      
        _acceptAudioData(audioData) {
          if (this.disposed) {
            audioData.close();
            return;
          }
          try {
            if (audioData.numberOfChannels !== this.stream.numberOfChannels) {
              throw new Error(`AudioDecoder 输出声道数异常：${audioData.numberOfChannels}。`);
            }
            const planes = [];
            for (let channel = 0; channel < audioData.numberOfChannels; channel += 1) {
              const samples = new Float32Array(audioData.numberOfFrames);
              audioData.copyTo(samples, { planeIndex: channel, format: 'f32-planar' });
              planes.push(samples);
            }
            this.blocks.push({
              timestamp: audioData.timestamp,
              duration: Math.round(audioData.numberOfFrames * 1_000_000 / audioData.sampleRate),
              planes,
              audioBuffer: null,
            });
            this.blocks.sort((left, right) => left.timestamp - right.timestamp);
          } catch (error) {
            this.onError(error);
          } finally {
            audioData.close();
          }
        }
      
        _getAudioBuffer(block) {
          if (block.audioBuffer) return block.audioBuffer;
          const buffer = this.audioContext.createBuffer(
            this.stream.numberOfChannels,
            block.planes[0].length,
            this.stream.sampleRate
          );
          for (let channel = 0; channel < block.planes.length; channel += 1) {
            buffer.copyToChannel(block.planes[channel], channel);
          }
          block.audioBuffer = buffer;
          return buffer;
        }
      
        _currentAbsoluteTimeUs() {
          return Math.round((this.audioContext.currentTime - this.contextStartTime) * 1_000_000);
        }
      
        _stopSources() {
          for (const source of this.sources) {
            source.onended = null;
            source.disconnect();
            try {
              source.stop();
            } catch {
              // 已自然播放完的 AudioBufferSourceNode 不能再次 stop()。
            }
          }
          this.sources.clear();
        }
      
        _closeDecoder() {
          if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
          this.decoder = null;
        }
      }
      
      Object.assign(exports, { WebAudioClock });
    },
    "src/lib/demuxers/incremental-webm-demuxer.js": (module, exports, require) => {
      const { WebmDemuxer } = require("src/lib/demuxers/webm-demuxer.js");
      const ID = Object.freeze({
        SEGMENT: 0x18538067,
        INFO: 0x1549a966,
        TRACKS: 0x1654ae6b,
        CLUSTER: 0x1f43b675,
      });
      
      const DEFAULT_FRAME_DURATION_US = 1_000_000 / 30;
      const DEFAULT_AUDIO_DURATION_US = 20_000;
      
      /**
       * 只读取本 Demo 需要的 WebM 顶层 Element。append() 可接收任意网络字节块：
       * 不完整 Element 留在内部，下一批字节到达后再继续解析。
       */
      class IncrementalWebmDemuxer {
        constructor() {
          this.bytes = new Uint8Array(0);
          this.length = 0;
          this.cursor = 0;
          this.segmentEnd = 0;
          this.timecodeScaleNs = 1_000_000;
          this.videoTrack = null;
          this.audioTrack = null;
          this.metadataSent = false;
          this.pendingFrame = null;
          this.pendingAudioChunk = null;
          this.frameCount = 0;
          this.finished = false;
        }
      
        append(chunk) {
          if (this.finished) throw new Error('WebM Demuxer 已结束，不能继续追加数据。');
          this._appendBytes(chunk);
          return this._drain(false);
        }
      
        finish() {
          if (this.finished) return this._emptyOutput();
          this.finished = true;
          const output = this._drain(true);
          if (!this.videoTrack || (!this.frameCount && !this.pendingFrame)) {
            throw new Error('WebM 中没有可解码的 VP9 Alpha 帧。');
          }
          this._flushPending(output, 'frame');
          this._flushPending(output, 'audio');
          output.sourceBytes = this.length;
          return output;
        }
      
        _appendBytes(chunk) {
          const required = this.length + chunk.byteLength;
          if (required > this.bytes.byteLength) {
            const capacity = Math.max(required, this.bytes.byteLength * 2, 64 * 1024);
            const next = new Uint8Array(capacity);
            next.set(this.bytes.subarray(0, this.length));
            this.bytes = next;
          }
          this.bytes.set(chunk, this.length);
          this.length = required;
        }
      
        _drain(isFinal) {
          const output = this._emptyOutput();
          if (!this.segmentEnd && !this._readSegmentHeader(isFinal)) return output;
      
          const limit = Math.min(this.length, this.segmentEnd);
          while (this.cursor < limit) {
            const element = this._readElement(this.cursor, limit, isFinal);
            if (!element) break;
            this.cursor = element.end;
      
            if (element.id === ID.INFO) {
              this.timecodeScaleNs = WebmDemuxer._readTimecodeScale(this.bytes, element);
            } else if (element.id === ID.TRACKS) {
              const tracks = WebmDemuxer._readTracks(this.bytes, element);
              this.videoTrack = tracks.videoTrack;
              this.audioTrack = tracks.audioTrack;
              if (!this.metadataSent) {
                this.metadataSent = true;
                output.metadata = {
                  width: this.videoTrack.width,
                  height: this.videoTrack.height,
                  codec: 'vp09.00.40.08',
                  audio: this.audioTrack && {
                    codec: 'opus',
                    sampleRate: this.audioTrack.sampleRate,
                    numberOfChannels: this.audioTrack.numberOfChannels,
                  },
                };
              }
            } else if (element.id === ID.CLUSTER) {
              if (!this.videoTrack) throw new Error('WebM Cluster 出现在 Tracks 之前。');
              const streams = WebmDemuxer._readCluster(
                this.bytes,
                element,
                this.videoTrack.number,
                this.audioTrack?.number ?? 0,
                this.timecodeScaleNs
              );
              streams.frames.sort((left, right) => left.timestamp - right.timestamp);
              streams.audioChunks.sort((left, right) => left.timestamp - right.timestamp);
              for (const frame of streams.frames) this._appendFrame(output, frame);
              for (const chunk of streams.audioChunks) this._appendAudio(output, chunk);
            }
          }
      
          if (isFinal && this.cursor < limit) throw new Error('WebM 文件在一个 Element 结束前截断。');
          return output;
        }
      
        _readSegmentHeader(isFinal) {
          let offset = 0;
          while (offset < this.length) {
            try {
              const availableBytes = this.bytes.subarray(0, this.length);
              const id = WebmDemuxer._readVint(availableBytes, offset, true);
              const size = WebmDemuxer._readVint(availableBytes, offset + id.length, false);
              const dataOffset = offset + id.length + size.length;
              const end = size.unknown ? Number.POSITIVE_INFINITY : dataOffset + size.value;
      
              // Segment 的 payload 就是后续要增量读取的主体；头部完整后不能再等待整个 payload。
              if (id.value === ID.SEGMENT) {
                this.cursor = dataOffset;
                this.segmentEnd = end;
                return true;
              }
      
              // Segment 之前的 EBML Header 等元素仍必须完整，才能安全跳到下一个元素。
              if (size.unknown || end > this.length) return false;
              offset = end;
            } catch (error) {
              if (isFinal) throw error;
              return false;
            }
          }
          if (isFinal) throw new Error('资源不是有效的 WebM：没有 Segment。');
          return false;
        }
      
        _readElement(offset, limit, isFinal) {
          try {
            // 解析头时使用逻辑长度视图，避免扩容后的零填充被误认为真实网络数据。
            const availableBytes = this.bytes.subarray(0, limit);
            const id = WebmDemuxer._readVint(availableBytes, offset, true);
            const size = WebmDemuxer._readVint(availableBytes, offset + id.length, false);
            const dataOffset = offset + id.length + size.length;
            if (dataOffset > limit) return null;
            if (size.unknown && !isFinal) return null;
            const end = size.unknown ? limit : dataOffset + size.value;
            if (end > limit || end <= offset) return null;
            return {
              id: id.value,
              size: end - dataOffset,
              dataOffset,
              end,
              unknown: size.unknown,
            };
          } catch (error) {
            // 网络块经常只包含一部分 EBML 头；最终输入仍无法读取才视为非法资源。
            if (isFinal) throw error;
            return null;
          }
        }
      
        _appendFrame(output, frame) {
          if (!this.frameCount && !this.pendingFrame && (
            frame.color.type !== 'key' || frame.alpha.type !== 'key'
          )) {
            throw new Error('WebM 的第一对 Color/Alpha 帧必须都是关键帧。');
          }
          const pendingFrame = this.pendingFrame;
          if (pendingFrame) {
            pendingFrame.duration ||= frame.timestamp - pendingFrame.timestamp;
            output.frames.push(pendingFrame);
            this.frameCount += 1;
          }
          this.pendingFrame = frame;
        }
      
        _appendAudio(output, chunk) {
          const pendingAudioChunk = this.pendingAudioChunk;
          if (pendingAudioChunk) {
            pendingAudioChunk.duration ||= chunk.timestamp - pendingAudioChunk.timestamp;
            output.audioChunks.push(pendingAudioChunk);
          }
          this.pendingAudioChunk = chunk;
        }
      
        _flushPending(output, type) {
          const key = type === 'frame' ? 'pendingFrame' : 'pendingAudioChunk';
          const fallback = type === 'frame' ? DEFAULT_FRAME_DURATION_US : DEFAULT_AUDIO_DURATION_US;
          const outputKey = type === 'frame' ? 'frames' : 'audioChunks';
          const pendingItem = this[key];
          if (!pendingItem) return;
          pendingItem.duration ||= fallback;
          output[outputKey].push(pendingItem);
          if (type === 'frame') this.frameCount += 1;
          this[key] = null;
        }
      
        _emptyOutput() {
          return { metadata: null, frames: [], audioChunks: [], sourceBytes: 0 };
        }
      }
      
      Object.assign(exports, { IncrementalWebmDemuxer });
    },
    "src/lib/demuxers/webm-demuxer.js": (module, exports, require) => {
      /**
       * 当前 Demo 所需的最小 WebM / Matroska Element ID。
       *
       * 这里只实现“单 VP9 Alpha 视频轨 + 单 Opus 音频轨”的读取能力，不试图成为
       * 通用 Matroska 库。遇到加密、Lacing、多视频轨等结构时会明确报错。
       */
      const ID = Object.freeze({
        // WebM/Matroska 顶层结构与时间基。
        SEGMENT: 0x18538067,
        INFO: 0x1549a966,
        TIMECODE_SCALE: 0x2ad7b1,
      
        // Tracks 下每条音视频轨共用的元数据。
        TRACKS: 0x1654ae6b,
        TRACK_ENTRY: 0xae,
        TRACK_NUMBER: 0xd7,
        TRACK_TYPE: 0x83,
        CODEC_ID: 0x86,
        CODEC_PRIVATE: 0x63a2,
      
        // VP9 视频轨的尺寸和透明视频标记。
        VIDEO: 0xe0,
        PIXEL_WIDTH: 0xb0,
        PIXEL_HEIGHT: 0xba,
        ALPHA_MODE: 0x53c0,
      
        // Opus 音频轨的采样参数。
        AUDIO: 0xe1,
        SAMPLING_FREQUENCY: 0xb5,
        CHANNELS: 0x9f,
      
        // Cluster 内保存真正的压缩数据和局部时间码。
        CLUSTER: 0x1f43b675,
        CLUSTER_TIMECODE: 0xe7,
        BLOCK_GROUP: 0xa0,
        BLOCK: 0xa1,
        SIMPLE_BLOCK: 0xa3,
        BLOCK_DURATION: 0x9b,
      
        // WebM Alpha 通过 BlockAdditional 给同一颜色帧附加一份 VP9 Alpha 帧。
        BLOCK_ADDITIONS: 0x75a1,
        BLOCK_MORE: 0xa6,
        BLOCK_ADD_ID: 0xee,
        BLOCK_ADDITIONAL: 0xa5,
      });
      
      // Matroska TrackType 的标准编号：1 表示视频，2 表示音频。
      const VIDEO_TRACK_TYPE = 1;
      const AUDIO_TRACK_TYPE = 2;
      
      // TimecodeScale 缺省为 1,000,000ns，即一个 WebM tick 等于 1ms。
      const DEFAULT_TIMECODE_SCALE_NS = 1_000_000;
      
      // 只有最后一块缺少 duration 且无法推导时才会用到这些保底值。
      const FALLBACK_FRAME_DURATION_US = 1_000_000 / 30;
      const FALLBACK_AUDIO_DURATION_US = 20_000;
      
      /**
       * WebM Element 的底层解析工具，并保留完整文件 parse() 作为校验入口。
       * 正式播放器使用 IncrementalWebmDemuxer 持续喂入字节；它复用本类的轨道、
       * Cluster、Block 和 EBML 读取逻辑，避免两套容器规则逐渐分叉。
       *
       * WebM Alpha 的物理结构是：
       *
       * BlockGroup
       *   ├─ Block                    → 普通 VP9 颜色帧
       *   └─ BlockAdditions
       *       └─ BlockAdditional      → 单独编码的 VP9 Alpha 帧
       *
       * 因此，“直接使用 WebM”仍然需要 Demux，但不需要事先生成两份 IVF。
       */
      class WebmDemuxer {
        /**
         * @param {ArrayBuffer} buffer 完整 WebM 文件。
         * @returns {{
         *   frames: Array<{
         *     timestamp: number,
         *     duration: number,
         *     color: { data: Uint8Array, type: 'key' | 'delta' },
         *     alpha: { data: Uint8Array, type: 'key' | 'delta' }
         *   }>,
         *   width: number,
         *   height: number,
         *   duration: number,
         *   codec: string,
         *   audio: null | {
         *     chunks: Array<{
         *       timestamp: number,
         *       duration: number,
         *       type: 'key',
         *       data: Uint8Array
         *     }>,
         *     codec: 'opus',
         *     sampleRate: number,
         *     numberOfChannels: number,
         *     codecPrivate: Uint8Array,
         *     duration: number
         *   }
         * }}
         */
        static parse(buffer) {
          // Uint8Array 只建立视图，不复制完整文件；各帧 data 也继续引用该缓冲区。
          const bytes = new Uint8Array(buffer);
      
          // 第一阶段读取容器元数据，得到时间基和音视频 TrackNumber。
          const segment = this._findSegment(bytes);
          const segmentChildren = [...this._children(bytes, segment)];
          const info = segmentChildren.find((element) => element.id === ID.INFO);
          const tracks = segmentChildren.find((element) => element.id === ID.TRACKS);
          if (!info || !tracks) throw new Error('WebM 缺少 Info 或 Tracks。');
      
          const timecodeScaleNs = this._readTimecodeScale(bytes, info);
          const { videoTrack, audioTrack } = this._readTracks(bytes, tracks);
          // 第二阶段遍历全部 Cluster，把交织存储的音视频压缩块分别放入两个时间轴。
          const frames = [];
          const audioChunks = [];
      
          for (const cluster of segmentChildren) {
            if (cluster.id !== ID.CLUSTER) continue;
            const clusterStreams = this._readCluster(
              bytes,
              cluster,
              videoTrack.number,
              audioTrack?.number ?? 0,
              timecodeScaleNs
            );
            frames.push(...clusterStreams.frames);
            audioChunks.push(...clusterStreams.audioChunks);
          }
      
          // Cluster 一般按时间排列，但显式排序可以避免依赖封装器的写入顺序。
          frames.sort((left, right) => left.timestamp - right.timestamp);
          if (!frames.length) throw new Error('WebM 中没有可解码的 VP9 Alpha 帧。');
          const firstFrame = frames[0];
          if (firstFrame.color.type !== 'key' || firstFrame.alpha.type !== 'key') {
            throw new Error('WebM 的第一对 Color/Alpha 帧必须都是关键帧。');
          }
      
          // WebCodecs chunk 最好带 duration；容器未写时根据下一个 timestamp 推导。
          this._fillFrameDurations(frames);
          this._fillChunkDurations(audioChunks, FALLBACK_AUDIO_DURATION_US);
          return {
            frames,
            width: videoTrack.width,
            height: videoTrack.height,
            duration: frames.at(-1).timestamp + frames.at(-1).duration,
            codec: 'vp09.00.40.08',
            audio: audioTrack
              ? {
                chunks: audioChunks,
                codec: 'opus',
                sampleRate: audioTrack.sampleRate,
                numberOfChannels: audioTrack.numberOfChannels,
                codecPrivate: audioTrack.codecPrivate,
                duration: audioChunks.length
                  ? audioChunks.at(-1).timestamp + audioChunks.at(-1).duration
                  : 0,
              }
              : null,
          };
        }
      
        // 在 EBML 顶层找到 Segment；Segment 可以使用“未知长度”编码直到文件结尾。
        static _findSegment(bytes) {
          let offset = 0;
          while (offset < bytes.length) {
            const element = this._readElement(bytes, offset, bytes.length);
            if (element.id === ID.SEGMENT) return element;
            offset = element.end;
          }
          throw new Error('资源不是有效的 WebM：没有 Segment。');
        }
      
        // Info 中的 TimecodeScale 单位为纳秒；WebM 默认值是 1,000,000ns。
        static _readTimecodeScale(bytes, info) {
          for (const element of this._children(bytes, info)) {
            if (element.id === ID.TIMECODE_SCALE) return this._readUnsigned(bytes, element);
          }
          return DEFAULT_TIMECODE_SCALE_NS;
        }
      
        // 读取本 Demo 支持的唯一 VP9 Alpha 视频轨，以及可选的唯一 Opus 音频轨。
        static _readTracks(bytes, tracks) {
          const videoTracks = [];
          const audioTracks = [];
          for (const entry of this._children(bytes, tracks)) {
            if (entry.id !== ID.TRACK_ENTRY) continue;
      
            let number = 0;
            let type = 0;
            let codecId = '';
            let video = null;
            let audio = null;
            let codecPrivate = null;
            for (const element of this._children(bytes, entry)) {
              if (element.id === ID.TRACK_NUMBER) {
                number = this._readUnsigned(bytes, element);
              } else if (element.id === ID.TRACK_TYPE) {
                type = this._readUnsigned(bytes, element);
              } else if (element.id === ID.CODEC_ID) {
                codecId = this._readString(bytes, element);
              } else if (element.id === ID.CODEC_PRIVATE) {
                // 对 A_OPUS 来说通常是 OpusHead；这里只用于验证 WebM 轨道完整性。
                // 原始 Opus packet 送入 AudioDecoder 时不会把它作为 description 传入。
                codecPrivate = bytes.subarray(element.dataOffset, element.end);
              } else if (element.id === ID.VIDEO) {
                video = this._readVideoSettings(bytes, element);
              } else if (element.id === ID.AUDIO) {
                audio = this._readAudioSettings(bytes, element);
              }
            }
      
            if (type === VIDEO_TRACK_TYPE) {
              videoTracks.push({ number, codecId, ...video });
            } else if (type === AUDIO_TRACK_TYPE) {
              audioTracks.push({ number, codecId, codecPrivate, ...audio });
            }
          }
      
          if (videoTracks.length !== 1) {
            throw new Error(`Demo 只支持一个视频轨，当前为 ${videoTracks.length} 个。`);
          }
      
          const track = videoTracks[0];
          if (
            track.codecId !== 'V_VP9'
            || !track.number
            || !track.width
            || !track.height
            || track.alphaMode !== 1
          ) {
            throw new Error('视频轨必须是带 AlphaMode 的有效 VP9 轨道。');
          }
      
          if (audioTracks.length > 1) {
            throw new Error(`Demo 最多支持一个音频轨，当前为 ${audioTracks.length} 个。`);
          }
          const audioTrack = audioTracks[0] ?? null;
          if (
            audioTrack
            && (
              audioTrack.codecId !== 'A_OPUS'
              || !audioTrack.number
              || !audioTrack.sampleRate
              || !audioTrack.numberOfChannels
              || !audioTrack.codecPrivate?.length
            )
          ) {
            throw new Error('音频轨必须是带 CodecPrivate 的有效 Opus 轨道。');
          }
          return { videoTrack: track, audioTrack };
        }
      
        static _readVideoSettings(bytes, video) {
          let width = 0;
          let height = 0;
          let alphaMode = 0;
          for (const element of this._children(bytes, video)) {
            if (element.id === ID.PIXEL_WIDTH) {
              width = this._readUnsigned(bytes, element);
            } else if (element.id === ID.PIXEL_HEIGHT) {
              height = this._readUnsigned(bytes, element);
            } else if (element.id === ID.ALPHA_MODE) {
              alphaMode = this._readUnsigned(bytes, element);
            }
          }
          return { width, height, alphaMode };
        }
      
        // Audio Element 里的采样率是 EBML Float，声道数是 EBML Unsigned Integer。
        static _readAudioSettings(bytes, audio) {
          let sampleRate = 0;
          let numberOfChannels = 0;
          for (const element of this._children(bytes, audio)) {
            if (element.id === ID.SAMPLING_FREQUENCY) {
              sampleRate = this._readFloat(bytes, element);
            } else if (element.id === ID.CHANNELS) {
              numberOfChannels = this._readUnsigned(bytes, element);
            }
          }
          return { sampleRate, numberOfChannels };
        }
      
        /**
         * Cluster Timecode 是簇的基准时间，Block 内保存有符号的相对时间。
         * 两者相加后再通过 TimecodeScale 转成 WebCodecs 使用的微秒。
         */
        static _readCluster(
          bytes,
          cluster,
          videoTrackNumber,
          audioTrackNumber,
          timecodeScaleNs
        ) {
          const children = [...this._children(bytes, cluster)];
          const timecodeElement = children.find(
            (element) => element.id === ID.CLUSTER_TIMECODE
          );
          if (!timecodeElement) throw new Error('Cluster 缺少 Timecode。');
          const clusterTimecode = this._readUnsigned(bytes, timecodeElement);
          const frames = [];
          const audioChunks = [];
      
          for (const element of children) {
            if (element.id === ID.BLOCK_GROUP) {
              // 带 Alpha 的视频必须使用 BlockGroup，才能同时携带 BlockAdditional。
              const group = this._readBlockGroup(bytes, element);
              const timestamp = this._toMicroseconds(
                clusterTimecode + group.relativeTimecode,
                timecodeScaleNs
              );
              const duration = group.durationTicks
                ? this._toMicroseconds(group.durationTicks, timecodeScaleNs)
                : 0;
      
              if (group.trackNumber === videoTrackNumber) {
                if (!group.alphaData) {
                  throw new Error(`时间戳 ${group.relativeTimecode} 的视频帧缺少 Alpha。`);
                }
                frames.push({
                  timestamp,
                  duration,
                  color: {
                    data: group.data,
                    type: this._frameType(group.data),
                  },
                  alpha: {
                    data: group.alphaData,
                    type: this._frameType(group.alphaData),
                  },
                });
              } else if (group.trackNumber === audioTrackNumber) {
                audioChunks.push(this._createAudioChunk(group, timestamp, duration));
              }
            } else if (element.id === ID.SIMPLE_BLOCK) {
              // ffmpeg 生成的 Opus packet 使用更轻量的 SimpleBlock，不含 Alpha 附加数据。
              const block = this._readBlock(bytes, element);
              if (block.trackNumber === audioTrackNumber) {
                const timestamp = this._toMicroseconds(
                  clusterTimecode + block.relativeTimecode,
                  timecodeScaleNs
                );
                audioChunks.push(this._createAudioChunk(block, timestamp, 0));
              } else if (block.trackNumber === videoTrackNumber) {
                throw new Error('带 Alpha 的视频帧必须使用 BlockGroup。');
              }
            }
          }
          return { frames, audioChunks };
        }
      
        // 将 BlockGroup 还原成“主压缩块 + 可选 Alpha + 可选 duration”。
        static _readBlockGroup(bytes, blockGroup) {
          let block = null;
          let alphaData = null;
          let durationTicks = 0;
          for (const element of this._children(bytes, blockGroup)) {
            if (element.id === ID.BLOCK) {
              block = this._readBlock(bytes, element);
            } else if (element.id === ID.BLOCK_DURATION) {
              durationTicks = this._readUnsigned(bytes, element);
            } else if (element.id === ID.BLOCK_ADDITIONS) {
              alphaData = this._readAlphaAddition(bytes, element);
            }
          }
          if (!block) throw new Error('BlockGroup 缺少 Block。');
          return { ...block, alphaData, durationTicks };
        }
      
        // BlockAddID=1 是 WebM Alpha 的传统映射；省略 BlockAddID 时默认同样为 1。
        static _readAlphaAddition(bytes, additions) {
          for (const more of this._children(bytes, additions)) {
            if (more.id !== ID.BLOCK_MORE) continue;
            let blockAddId = 1;
            let data = null;
            for (const element of this._children(bytes, more)) {
              if (element.id === ID.BLOCK_ADD_ID) {
                blockAddId = this._readUnsigned(bytes, element);
              } else if (element.id === ID.BLOCK_ADDITIONAL) {
                data = bytes.subarray(element.dataOffset, element.end);
              }
            }
            if (blockAddId === 1 && data) return data;
          }
          return null;
        }
      
        /**
         * Block 负载头：
         *
         * TrackNumber(VINT) + RelativeTimecode(int16) + Flags(uint8) + 压缩数据
         */
        static _readBlock(bytes, element) {
          const track = this._readVint(bytes, element.dataOffset, false);
          const headerSize = track.length + 3;
          if (element.size <= headerSize) throw new Error('WebM Block 数据不完整。');
      
          const view = new DataView(
            bytes.buffer,
            bytes.byteOffset + element.dataOffset,
            element.size
          );
          const relativeTimecode = view.getInt16(track.length, false);
          const flags = view.getUint8(track.length + 2);
      
          // Flags 的 1-2 位表示 Lacing；本 Demo 每个 Block 必须只有一帧。
          if ((flags & 0x06) !== 0) throw new Error('Demo 暂不支持 WebM Lacing。');
          return {
            trackNumber: track.value,
            relativeTimecode,
            data: bytes.subarray(element.dataOffset + headerSize, element.end),
          };
        }
      
        static _createAudioChunk(block, timestamp, duration) {
          return {
            // WebCodecs 规定 Opus EncodedAudioChunk 的 type 始终为 key。
            type: 'key',
            timestamp,
            duration,
            data: block.data,
          };
        }
      
        // Matroska tick × TimecodeScale(ns) ÷ 1000 = WebCodecs 使用的微秒。
        static _toMicroseconds(timecode, timecodeScaleNs) {
          return Math.round(timecode * timecodeScaleNs / 1000);
        }
      
        /**
         * IVF/WebM 都不直接为最后一帧提供可靠 duration。
         * 优先保留 BlockDuration，其余帧用下一帧时间戳之差，最后一帧使用中位数。
         */
        static _fillFrameDurations(frames) {
          this._fillChunkDurations(frames, FALLBACK_FRAME_DURATION_US);
        }
      
        /**
         * WebM 通常不给每个 SimpleBlock 写 BlockDuration，使用相邻时间戳补齐。
         * 最后一块没有“下一块”可参考，因此使用前面 duration 的中位数；中位数不会
         * 被偶发的大时间间隔明显拉偏。
         */
        static _fillChunkDurations(chunks, fallbackDurationUs) {
          if (!chunks.length) return;
          const durations = [];
          for (let index = 0; index < chunks.length - 1; index += 1) {
            chunks[index].duration ||= chunks[index + 1].timestamp - chunks[index].timestamp;
            if (chunks[index].duration > 0) durations.push(chunks[index].duration);
          }
      
          durations.sort((left, right) => left - right);
          if (!chunks.at(-1).duration) {
            chunks.at(-1).duration = durations.length
              ? durations[Math.floor(durations.length / 2)]
              : fallbackDurationUs;
          }
        }
      
        // 从 VP9 uncompressed header 判断关键帧，逻辑与原 IVF Demo 保持一致。
        static _frameType(data) {
          if (!data.length || (data[0] >> 6) !== 0b10) throw new Error('VP9 帧头无效。');
          const profile = ((data[0] >> 5) & 1) | (((data[0] >> 4) & 1) << 1);
          if (profile !== 0) throw new Error(`只支持 VP9 Profile 0，当前为 ${profile}。`);
          const showExistingFrame = (data[0] >> 3) & 1;
          return showExistingFrame === 0 && ((data[0] >> 2) & 1) === 0
            ? 'key'
            : 'delta';
        }
      
        // 遍历一个 Master Element 的直接子元素，不递归解释 Block 二进制内容。
        static *_children(bytes, parent) {
          let offset = parent.dataOffset;
          while (offset < parent.end) {
            const element = this._readElement(bytes, offset, parent.end);
            yield element;
            offset = element.end;
          }
        }
      
        /**
         * 读取一个 EBML Element 的公共头，但不解释 payload。
         * 返回的数据区间统一使用 [dataOffset, end)，便于 subarray() 零复制引用。
         */
        static _readElement(bytes, offset, limit) {
          const id = this._readVint(bytes, offset, true);
          const size = this._readVint(bytes, offset + id.length, false);
          const dataOffset = offset + id.length + size.length;
          const end = size.unknown ? limit : dataOffset + size.value;
          if (dataOffset > limit || end > limit || end <= offset) {
            throw new Error(`WebM Element 0x${id.value.toString(16)} 越界。`);
          }
          return {
            id: id.value,
            size: end - dataOffset,
            dataOffset,
            end,
          };
        }
      
        /**
         * 读取 EBML Variable-Size Integer。
         *
         * Element ID 保留首字节的长度标记；Element Size 和 TrackNumber 清除标记。
         * 使用 BigInt 只是为了安全识别 8 字节的“未知长度”，最终文件偏移仍为 Number。
         */
        static _readVint(bytes, offset, preserveMarker) {
          const first = bytes[offset];
          if (first === undefined || first === 0) throw new Error('EBML VINT 无效。');
      
          let marker = 0x80;
          let length = 1;
          while (!(first & marker) && length <= 8) {
            marker >>= 1;
            length += 1;
          }
          if (length > 8 || offset + length > bytes.length) {
            throw new Error('EBML VINT 数据不完整。');
          }
      
          let value = BigInt(preserveMarker ? first : first & (marker - 1));
          for (let index = 1; index < length; index += 1) {
            value = (value << 8n) | BigInt(bytes[offset + index]);
          }
      
          const unknownValue = (1n << BigInt(7 * length)) - 1n;
          const unknown = !preserveMarker && value === unknownValue;
          if (!unknown && value > BigInt(Number.MAX_SAFE_INTEGER)) {
            throw new Error('EBML VINT 超出 JavaScript 安全整数范围。');
          }
          return { length, value: unknown ? 0 : Number(value), unknown };
        }
      
        static _readUnsigned(bytes, element) {
          if (element.size < 1 || element.size > 8) throw new Error('WebM 无符号整数长度无效。');
          let value = 0n;
          for (let offset = element.dataOffset; offset < element.end; offset += 1) {
            value = (value << 8n) | BigInt(bytes[offset]);
          }
          if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
            throw new Error('WebM 整数超出 JavaScript 安全范围。');
          }
          return Number(value);
        }
      
        // EBML Float 只允许 4 字节单精度或 8 字节双精度，并使用大端序。
        static _readFloat(bytes, element) {
          const view = new DataView(
            bytes.buffer,
            bytes.byteOffset + element.dataOffset,
            element.size
          );
          if (element.size === 4) return view.getFloat32(0, false);
          if (element.size === 8) return view.getFloat64(0, false);
          throw new Error('WebM 浮点数长度无效。');
        }
      
        static _readString(bytes, element) {
          return new TextDecoder().decode(
            bytes.subarray(element.dataOffset, element.end)
          );
        }
      }
      
      Object.assign(exports, { WebmDemuxer });
    },
    "src/lib/renderers/renderer-factory.js": (module, exports, require) => {
      /**
       * Renderer 选择器。
       *
       * 业务降级链只有两级：
       *
       * VideoDecoder + WebGPU
       *          ↓ 初始化失败
       * VideoDecoder + WebGL
       *
       * RendererFactory 不负责 VideoDecoder 能力检查，那是播放器的职责。
       */
      const { WebGlRenderer } = require("src/lib/renderers/webgl-renderer.js");
      const { WebGpuRenderer } = require("src/lib/renderers/webgpu-renderer.js");
      class RendererFactory {
        /**
         * webGpuEnabled=true 时优先创建 WebGPU Renderer，失败后创建 WebGL；
         * webGpuEnabled=false 时主动跳过 WebGPU，直接创建 WebGL Renderer。
         *
         * @param {HTMLCanvasElement} canvas 页面原始 Canvas。
         * @param {{ webGpuEnabled?: boolean }} options 渲染后端开关。
         * @returns {Promise<WebGpuRenderer | WebGlRenderer>}
         */
        static async create(canvas, { webGpuEnabled = true } = {}) {
          let webGpuError = null;
      
          if (webGpuEnabled && navigator.gpu) {
            try {
              return await WebGpuRenderer.create(canvas);
            } catch (error) {
              webGpuError = error;
              console.warn('WebGPU 初始化失败，切换到 WebGL。', error);
      
              /**
               * 一个 Canvas 一旦成功调用 getContext('webgpu')，就不能再对同一个
               * Canvas 获取 webgl context。WebGPU 可能在创建 context 之后、创建
               * Pipeline 时才失败，因此回退时必须用全新的 Canvas。
               */
              canvas = this._replaceCanvas(canvas);
            }
          } else if (webGpuEnabled) {
            webGpuError = new Error('navigator.gpu 不存在');
          }
      
          try {
            const renderer = WebGlRenderer.create(canvas);
      
            /**
             * 只有“尝试过 WebGPU 但失败”才属于降级。
             * 主动关闭 WebGPU 时直接选择 WebGL，不应向 UI 报告失败。
             */
            renderer.fallbackReason = webGpuEnabled
              ? webGpuError?.message ?? ''
              : '';
            return renderer;
          } catch (webGlError) {
            const webGpuMessage = webGpuEnabled
              ? webGpuError?.message ?? '当前环境没有 WebGPU'
              : '已通过配置关闭';
      
            // 不再提供 <video> 或 Canvas 2D 第三层降级，两者都失败时直接结束。
            throw new Error(
              `WebGPU 不可用：${webGpuMessage}；WebGL 不可用：${webGlError.message}`
            );
          }
        }
      
        // cloneNode 会保留 id、width、height 等属性，但不会复制旧 Canvas Context。
        static _replaceCanvas(canvas) {
          const replacement = canvas.cloneNode(false);
          canvas.replaceWith(replacement);
          return replacement;
        }
      }
      
      Object.assign(exports, { RendererFactory });
    },
    "src/lib/renderers/webgl-renderer.js": (module, exports, require) => {
      /**
       * WebGL 兼容渲染后端。
       *
       * 输入和 WebGPU Renderer 相同：一对 Color/Alpha VideoFrame。
       * 区别是这里通过 texImage2D() 将 VideoFrame 内容更新到两张普通 WebGL
       * Texture，再用 GLSL Fragment Shader 合成最终 RGBA。
       */
      class WebGlRenderer {
        /**
         * WebGL 是本 Demo 的最终回退层。
         * premultipliedAlpha=false 表示 Shader 输出未经预乘的 RGB + Alpha。
         */
        static create(canvas) {
          const gl = canvas.getContext('webgl', {
            alpha: true,
            antialias: false,
            premultipliedAlpha: false,
          });
          if (!gl) throw new Error('WebGL 不可用。');
          return new WebGlRenderer(canvas, gl);
        }
      
        // 构造阶段创建并缓存所有可以跨帧复用的 WebGL 资源。
        constructor(canvas, gl) {
          this.canvas = canvas;
          this.gl = gl;
          this.name = 'WebGL';
          this.program = this._createProgram();
          this.buffer = this._createBuffer();
          this.colorTexture = this._createTexture(gl.TEXTURE0);
          this.alphaTexture = this._createTexture(gl.TEXTURE1);
      
          gl.useProgram(this.program);
          gl.uniform1i(gl.getUniformLocation(this.program, 'u_color'), 0);
          gl.uniform1i(gl.getUniformLocation(this.program, 'u_alpha'), 1);
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
          gl.clearColor(0, 0, 0, 0);
        }
      
        /**
         * 把一对 VideoFrame 上传为两张纹理并绘制。
         *
         * texImage2D() 可能触发像素格式转换或纹理复制，但兼容性通常比
         * WebGPU importExternalTexture() 更广。该方法完成后 Player 即可关闭帧。
         */
        async render(pair) {
          const gl = this.gl;
          gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      
          // 这是 WebGL/GPU 清理命令，不是 Canvas 2D 的 clearRect()。
          gl.clear(gl.COLOR_BUFFER_BIT);
          gl.useProgram(this.program);
      
          // Texture Unit 0 保存当前颜色 VideoFrame。
          this._uploadFrame(gl.TEXTURE0, this.colorTexture, pair.color);
      
          // Texture Unit 1 保存当前灰度 Alpha VideoFrame。
          this._uploadFrame(gl.TEXTURE1, this.alphaTexture, pair.alpha);
      
          // 六个顶点组成两个三角形，Fragment Shader 会覆盖完整 Canvas。
          gl.drawArrays(gl.TRIANGLES, 0, 6);
        }
      
        _uploadFrame(unit, texture, frame) {
          const gl = this.gl;
          gl.activeTexture(unit);
          gl.bindTexture(gl.TEXTURE_2D, texture);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);
        }
      
        // 显式删除由本 Renderer 创建的 WebGL 对象。
        destroy() {
          const gl = this.gl;
          gl.deleteTexture(this.colorTexture);
          gl.deleteTexture(this.alphaTexture);
          gl.deleteBuffer(this.buffer);
          gl.deleteProgram(this.program);
        }
      
        /**
         * 创建合成程序：
         *
         * Vertex Shader 负责位置和纹理坐标；
         * Fragment Shader 采样颜色 RGB，并取 Alpha 纹理 red 通道作为透明度。
         */
        _createProgram() {
          const gl = this.gl;
          const vertexShader = this._compile(gl.VERTEX_SHADER, `
            attribute vec2 a_position;
            attribute vec2 a_texCoord;
            varying vec2 v_texCoord;
      
            void main() {
              gl_Position = vec4(a_position, 0.0, 1.0);
              v_texCoord = a_texCoord;
            }
          `);
          const fragmentShader = this._compile(gl.FRAGMENT_SHADER, `
            precision mediump float;
            uniform sampler2D u_color;
            uniform sampler2D u_alpha;
            varying vec2 v_texCoord;
      
            void main() {
              vec3 color = texture2D(u_color, v_texCoord).rgb;
              float alpha = texture2D(u_alpha, v_texCoord).r;
      
              // Context 配置 premultipliedAlpha=false，因此这里输出 straight alpha。
              gl_FragColor = vec4(color, alpha);
            }
          `);
          const program = gl.createProgram();
          gl.attachShader(program, vertexShader);
          gl.attachShader(program, fragmentShader);
          gl.linkProgram(program);
          gl.deleteShader(vertexShader);
          gl.deleteShader(fragmentShader);
          if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            throw new Error(`WebGL Program 创建失败：${gl.getProgramInfoLog(program)}`);
          }
          return program;
        }
      
        // Shader 编译失败时立刻抛错，让 Factory/Player 进入统一错误处理。
        _compile(type, source) {
          const gl = this.gl;
          const shader = gl.createShader(type);
          gl.shaderSource(shader, source);
          gl.compileShader(shader);
          if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            throw new Error(`WebGL Shader 创建失败：${gl.getShaderInfoLog(shader)}`);
          }
          return shader;
        }
      
        /**
         * 顶点数据每项包含四个 float：
         * [position.x, position.y, texCoord.x, texCoord.y]
         */
        _createBuffer() {
          const gl = this.gl;
          const buffer = gl.createBuffer();
          gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
          gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
            -1, -1, 0, 0,
             1, -1, 1, 0,
            -1,  1, 0, 1,
            -1,  1, 0, 1,
             1, -1, 1, 0,
             1,  1, 1, 1,
          ]), gl.STATIC_DRAW);
      
          const stride = 4 * Float32Array.BYTES_PER_ELEMENT;
          const position = gl.getAttribLocation(this.program, 'a_position');
          const textureCoordinate = gl.getAttribLocation(this.program, 'a_texCoord');
          gl.enableVertexAttribArray(position);
          gl.vertexAttribPointer(position, 2, gl.FLOAT, false, stride, 0);
          gl.enableVertexAttribArray(textureCoordinate);
          gl.vertexAttribPointer(
            textureCoordinate,
            2,
            gl.FLOAT,
            false,
            stride,
            2 * Float32Array.BYTES_PER_ELEMENT
          );
          return buffer;
        }
      
        // 两张纹理只创建一次；每帧通过 texImage2D() 更新其内容。
        _createTexture(unit) {
          const gl = this.gl;
          const texture = gl.createTexture();
          gl.activeTexture(unit);
          gl.bindTexture(gl.TEXTURE_2D, texture);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
          return texture;
        }
      }
      
      Object.assign(exports, { WebGlRenderer });
    },
    "src/lib/renderers/webgpu-renderer.js": (module, exports, require) => {
      /**
       * WebGPU 渲染后端。
       *
       * 它不负责解码，也不拥有播放队列。输入是一对已经按 timestamp 配对的
       * VideoFrame，输出是带透明通道的 WebGPU Canvas。
       *
       * 与 WebGL 版的核心区别：
       * - WebGL 使用 texImage2D(VideoFrame) 更新普通纹理；
       * - WebGPU 使用 importExternalTexture(VideoFrame) 导入外部纹理。
       */
      class WebGpuRenderer {
        /**
         * 异步创建 Adapter、Device、Canvas Context 和 RenderPipeline。
         * 任意步骤失败都会抛出，由 RendererFactory 尝试 WebGL。
         */
        static async create(canvas) {
          if (!navigator.gpu) throw new Error('WebGPU 不可用。');
      
          // 高性能是偏好而非保证，系统仍可能选择集成 GPU 或唯一可用 GPU。
          const adapter = await navigator.gpu.requestAdapter({
            powerPreference: 'high-performance',
          });
          if (!adapter) throw new Error('无法获取 WebGPU Adapter。');
      
          const device = await adapter.requestDevice();
      
          // 当前方案必须直接采样 VideoFrame，因此不能只检查 navigator.gpu。
          if (typeof device.importExternalTexture !== 'function') {
            device.destroy();
            throw new Error('WebGPU 不支持 VideoFrame 外部纹理。');
          }
      
          try {
            const context = canvas.getContext('webgpu');
            if (!context) throw new Error('无法创建 WebGPU Canvas Context。');
            const format = navigator.gpu.getPreferredCanvasFormat();
      
            /**
             * Shader 输出预乘颜色 color.rgb * alpha，所以 Canvas 也配置为
             * premultiplied，避免浏览器合成 Canvas 时再次错误处理透明颜色。
             */
            context.configure({ device, format, alphaMode: 'premultiplied' });
      
            const module = device.createShaderModule({
              code: `
                // binding 0 是公共采样器，binding 1/2 分别是颜色和 Alpha 帧。
                @group(0) @binding(0) var frameSampler: sampler;
                @group(0) @binding(1) var colorFrame: texture_external;
                @group(0) @binding(2) var alphaFrame: texture_external;
      
                struct VertexOutput {
                  @builtin(position) position: vec4f,
                  @location(0) texCoord: vec2f,
                };
      
                @vertex
                fn vertexMain(@builtin(vertex_index) index: u32) -> VertexOutput {
                  // 六个顶点组成两个三角形，完整覆盖 Canvas。
                  let positions = array<vec2f, 6>(
                    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
                    vec2f(-1.0,  1.0), vec2f(1.0, -1.0), vec2f( 1.0, 1.0)
                  );
      
                  // WebGPU 纹理坐标原点和最终显示方向在这里一次性匹配。
                  let coordinates = array<vec2f, 6>(
                    vec2f(0.0, 1.0), vec2f(1.0, 1.0), vec2f(0.0, 0.0),
                    vec2f(0.0, 0.0), vec2f(1.0, 1.0), vec2f(1.0, 0.0)
                  );
                  var output: VertexOutput;
                  output.position = vec4f(positions[index], 0.0, 1.0);
                  output.texCoord = coordinates[index];
                  return output;
                }
      
                @fragment
                fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
                  // 外部纹理可能来自 YUV VideoFrame，浏览器负责采样时的颜色转换。
                  let color = textureSampleBaseClampToEdge(
                    colorFrame,
                    frameSampler,
                    input.texCoord
                  );
      
                  // Alpha 视频是灰度画面，取转换后颜色的 red 通道作为透明度。
                  let alpha = textureSampleBaseClampToEdge(
                    alphaFrame,
                    frameSampler,
                    input.texCoord
                  ).r;
      
                  // Canvas 使用 premultiplied alpha，因此 RGB 必须预先乘以 Alpha。
                  return vec4f(color.rgb * alpha, alpha);
                }
              `,
            });
            const pipeline = await device.createRenderPipelineAsync({
              layout: 'auto',
              vertex: { module, entryPoint: 'vertexMain' },
              fragment: {
                module,
                entryPoint: 'fragmentMain',
                targets: [{ format }],
              },
              primitive: { topology: 'triangle-list' },
            });
      
            // Pipeline 和 Sampler 跨帧复用；每帧只创建与 VideoFrame 相关的资源。
            return new WebGpuRenderer(
              canvas,
              device,
              context,
              pipeline,
              device.createSampler({ magFilter: 'linear', minFilter: 'linear' })
            );
          } catch (error) {
            // 初始化中途失败时主动销毁 Device，再由 Factory 创建 WebGL。
            device.destroy();
            throw error;
          }
        }
      
        constructor(canvas, device, context, pipeline, sampler) {
          this.canvas = canvas;
          this.device = device;
          this.context = context;
          this.pipeline = pipeline;
          this.sampler = sampler;
          this.name = 'WebGPU';
        }
      
        /**
         * 渲染一对 VideoFrame。
         *
         * Promise 只有在 GPU 已完成本次之前提交的工作后才结束。Player 会等待
         * Promise settle 后关闭 VideoFrame，保证外部纹理使用期间源帧仍然有效。
         */
        async render(pair) {
          const device = this.device;
      
          /**
           * GPUExternalTexture 是 VideoFrame 的临时 GPU 视图，而不是永久纹理。
           * 它的生命周期受源 VideoFrame 约束，因此每一帧都需要重新导入。
           */
          const bindGroup = device.createBindGroup({
            layout: this.pipeline.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: this.sampler },
              {
                binding: 1,
                resource: device.importExternalTexture({ source: pair.color }),
              },
              {
                binding: 2,
                resource: device.importExternalTexture({ source: pair.alpha }),
              },
            ],
          });
      
          // CommandEncoder 用于记录本帧所有 GPU 命令。
          const encoder = device.createCommandEncoder();
          const pass = encoder.beginRenderPass({
            colorAttachments: [{
              view: this.context.getCurrentTexture().createView(),
      
              // 在 GPU RenderPass 中清成完全透明，不经过 Canvas 2D clearRect。
              clearValue: { r: 0, g: 0, b: 0, a: 0 },
              loadOp: 'clear',
              storeOp: 'store',
            }],
          });
          pass.setPipeline(this.pipeline);
          pass.setBindGroup(0, bindGroup);
          pass.draw(6);
          pass.end();
          device.queue.submit([encoder.finish()]);
      
          // Player 在该 Promise 完成后 close Color/Alpha VideoFrame。
          await device.queue.onSubmittedWorkDone();
        }
      
        // Device 是该 Renderer 创建的最终 GPU 资源，销毁它会释放其子资源。
        destroy() {
          this.device.destroy();
        }
      }
      
      Object.assign(exports, { WebGpuRenderer });
    },
    "src/resource/bridge-reader.js": (module, exports, require) => {
      const { PlayerError } = require("src/error/error-reporter.js");
      const DEFAULT_CHUNK_SIZE = 256 * 1024;
      
      /** 通过宿主 Bridge 分块读取一份完整的本地资源。 */
      class BridgeReader {
        constructor({ bridge, sessionId, totalBytes, chunkSize = DEFAULT_CHUNK_SIZE }) {
          if (!bridge || typeof bridge.post !== 'function') {
            throw new PlayerError('BRIDGE_FAILED', 'resource', '缺少可用的资源 Bridge。');
          }
          if (typeof sessionId !== 'string' || !sessionId.trim()) {
            throw new PlayerError('BRIDGE_FAILED', 'resource', 'sessionId 必须是非空字符串。');
          }
          if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0) {
            throw new PlayerError('BRIDGE_FAILED', 'resource', 'totalBytes 必须是正整数。');
          }
      
          this.bridge = bridge;
          this.sessionId = sessionId;
          this.totalBytes = totalBytes;
          this.chunkSize = Number.isSafeInteger(chunkSize) && chunkSize > 0
            ? chunkSize
            : DEFAULT_CHUNK_SIZE;
          this.loadedBytes = 0;
          this.complete = false;
          this.cancelled = false;
          this.pendingRequest = null;
        }
      
        async *read() {
          while (!this.complete) {
            const chunk = await this._requestChunk();
            if (chunk.bytes.byteLength) {
              this.loadedBytes += chunk.bytes.byteLength;
              yield chunk.bytes;
            }
      
            if (this.loadedBytes > this.totalBytes) {
              throw new PlayerError(
                'BRIDGE_FAILED',
                'resource',
                '宿主返回的资源数据超过 totalBytes。'
              );
            }
            if (!chunk.bytes.byteLength && !chunk.done) {
              throw new PlayerError('BRIDGE_FAILED', 'resource', '宿主返回了空的资源分块。');
            }
            this.complete = chunk.done || this.loadedBytes === this.totalBytes;
          }
        }
      
        acceptChunk(payload) {
          if (!payload || payload.sessionId !== this.sessionId) return false;
          if (!this.pendingRequest) return false;
      
          try {
            const base64 = typeof payload.base64 === 'string' ? payload.base64 : '';
            const bytes = BridgeReader._decodeBase64(base64);
            if (bytes.byteLength > this.pendingRequest.length) {
              throw new PlayerError('BRIDGE_FAILED', 'resource', '宿主返回的资源分块过大。');
            }
      
            const pendingRequest = this.pendingRequest;
            this.pendingRequest = null;
            pendingRequest.resolve({ bytes, done: payload.done === true });
            return true;
          } catch (error) {
            this.fail(error);
            return false;
          }
        }
      
        fail(reason) {
          const error = PlayerError.from(reason, 'BRIDGE_FAILED', 'resource');
          const pendingRequest = this.pendingRequest;
          this.pendingRequest = null;
          this.cancelled = true;
          pendingRequest?.reject(error);
        }
      
        cancel() {
          if (this.cancelled || this.complete) return;
          this.fail(new PlayerError('BRIDGE_FAILED', 'resource', '资源读取已取消。'));
        }
      
        _requestChunk() {
          if (this.cancelled) {
            return Promise.reject(new PlayerError('BRIDGE_FAILED', 'resource', '资源读取已取消。'));
          }
      
          const offset = this.loadedBytes;
          const length = Math.min(this.chunkSize, this.totalBytes - offset);
          return new Promise((resolve, reject) => {
            this.pendingRequest = { offset, length, resolve, reject };
            const sent = this.bridge.post('readResource', {
              sessionId: this.sessionId,
              offset,
              length,
            });
            if (sent) return;
      
            this.pendingRequest = null;
            reject(new PlayerError('BRIDGE_FAILED', 'resource', '无法向宿主请求资源分块。'));
          });
        }
      
        static _decodeBase64(base64) {
          const binary = atob(base64);
          const bytes = new Uint8Array(binary.length);
          for (let index = 0; index < binary.length; index += 1) {
            bytes[index] = binary.charCodeAt(index);
          }
          return bytes;
        }
      }
      
      Object.assign(exports, { BridgeReader });
    }
  };
  const moduleCache = new Map();

  const loadModule = (moduleId) => {
    if (moduleCache.has(moduleId)) return moduleCache.get(moduleId).exports;
    const factory = moduleFactories[moduleId];
    if (!factory) throw new Error(`找不到播放器模块：${moduleId}`);

    const module = { exports: {} };
    moduleCache.set(moduleId, module);
    factory(module, module.exports, loadModule);
    return module.exports;
  };

  loadModule("src/index.js");
})();
