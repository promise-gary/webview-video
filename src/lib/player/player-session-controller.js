import { TransparentWebmPlayer } from './transparent-webm-player.js';

const MAX_MEDIA_BYTES = 512 * 1024 * 1024;
const NOOP = () => {};

/**
 * 页面级媒体所有者：接收完整数据、创建一个 Player，并在结束后恢复 idle。
 * 页面与 Bridge 常驻，但 transfer、Player、Canvas Context 都只属于当前 session。
 */
export class PlayerSessionController {
  constructor({
    canvas,
    canvasHost,
    bridge,
    errorHandler,
    onVideoInfoChange = NOOP,
    onRendererChange = NOOP,
    onError = NOOP,
    onTechnicalPath = NOOP,
  }) {
    this.canvas = canvas;
    this.canvasHost = canvasHost;
    this.bridge = bridge;
    this.errorHandler = errorHandler;
    this.onVideoInfoChange = onVideoInfoChange;
    this.onRendererChange = onRendererChange;
    this.onError = onError;
    this.onTechnicalPath = onTechnicalPath;
    this.activeSessionId = '';
    this.generation = 0;
    this.transfer = null;
    this.player = null;
    this.disposed = false;
  }

  /**
   * 宿主应用先声明准确长度，页面只分配一次最终 ArrayBuffer。
   * begin 阶段不会创建 Decoder、AudioContext 或 GPU Renderer。
   */
  beginMedia({ sessionId, totalBytes, source = {}, options = {} } = {}) {
    this._assertAvailable();
    PlayerSessionController._validateSessionId(sessionId);
    if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0) {
      throw new Error('totalBytes 必须是正安全整数。');
    }
    if (totalBytes > MAX_MEDIA_BYTES) {
      throw new Error(`媒体数据不能超过 ${MAX_MEDIA_BYTES} 字节。`);
    }

    const sourceInfo = source && typeof source === 'object' ? source : {};
    const sourceFileName =
      typeof sourceInfo.fileName === 'string' ? sourceInfo.fileName : '';
    const sourceFileSize = Number.isSafeInteger(sourceInfo.fileSize)
      ? sourceInfo.fileSize
      : totalBytes;
    if (sourceFileSize !== totalBytes) {
      throw new Error('原始文件大小与 totalBytes 不一致。');
    }

    const mediaOptions = options && typeof options === 'object' ? options : {};
    this._releaseActive('replaced');
    this.generation += 1;
    this.activeSessionId = sessionId;
    this.transfer = {
      sessionId,
      totalBytes,
      receivedBytes: 0,
      nextSequence: 0,
      bytes: new Uint8Array(totalBytes),
      source: {
        fileName: sourceFileName,
        fileSize: sourceFileSize,
      },
      options: {
        audioEnabled: mediaOptions.audioEnabled !== false,
        webGpuEnabled: mediaOptions.webGpuEnabled !== false,
      },
    };
    return { sessionId, totalBytes, nextSequence: 0 };
  }

  /** Base64 只是跨 WebView JS 调用的传输编码，解码后立即丢弃对应字符串。 */
  appendMediaChunk({ sessionId, sequence, base64 } = {}) {
    const transfer = this._requireTransfer(sessionId);
    if (!Number.isSafeInteger(sequence) || sequence !== transfer.nextSequence) {
      throw new Error(`媒体分块顺序错误，期望 sequence=${transfer.nextSequence}。`);
    }
    if (typeof base64 !== 'string' || !base64.length) {
      throw new Error('base64 必须是非空字符串。');
    }

    const chunk = PlayerSessionController._decodeBase64(base64);
    const nextReceivedBytes = transfer.receivedBytes + chunk.byteLength;
    if (nextReceivedBytes > transfer.totalBytes) {
      throw new Error('接收到的媒体数据超过 totalBytes。');
    }
    transfer.bytes.set(chunk, transfer.receivedBytes);
    transfer.receivedBytes = nextReceivedBytes;
    transfer.nextSequence += 1;
    return {
      sessionId,
      receivedBytes: transfer.receivedBytes,
      totalBytes: transfer.totalBytes,
      nextSequence: transfer.nextSequence,
    };
  }

  /** 只有全部字节到齐后才把 ArrayBuffer 的所有权交给 Player。 */
  async finishMedia({ sessionId } = {}) {
    const transfer = this._requireTransfer(sessionId);
    if (transfer.receivedBytes !== transfer.totalBytes) {
      throw new Error(
        `媒体数据不完整：${transfer.receivedBytes}/${transfer.totalBytes} 字节。`
      );
    }

    const generation = this.generation;
    const mediaBuffer = transfer.bytes.buffer;
    const sourceInfo = transfer.source;
    const playerOptions = transfer.options;
    this.transfer = null;
    const player = new TransparentWebmPlayer({
      canvas: this.canvas,
      ...playerOptions,
      onVideoInfoChange: (info) => {
        if (this._isCurrent(sessionId, generation, player)) {
          this.onVideoInfoChange({ ...info, source: sourceInfo });
        }
      },
      onTechnicalPath: (type, message) => {
        if (this._isCurrent(sessionId, generation, player)) {
          this.onTechnicalPath(type, message);
        }
      },
      onPlaying: () => this._handlePlaying(sessionId, generation, player),
      onEnded: () => this._handleEnded(sessionId, generation, player),
      onError: (error) => this._handleError(sessionId, generation, player, error),
    });
    this.player = player;

    const info = await player.load(mediaBuffer);
    if (!this._isCurrent(sessionId, generation, player)) {
      throw new Error('媒体加载期间 session 已被替换。');
    }
    // WebGPU → WebGL 回退可能替换原 Canvas，控制器必须接管最终节点。
    this.canvas = player.canvas;
    this.onRendererChange(info.renderer);
    const loadedInfo = { ...info, source: sourceInfo };
    this.bridge.emit('loaded', sessionId, loadedInfo);
    await player.start();
    if (!this._isCurrent(sessionId, generation, player)) {
      throw new Error('媒体启动期间 session 已被替换。');
    }
    return loadedInfo;
  }

  clear({ sessionId } = {}) {
    if (!this.activeSessionId) return;
    PlayerSessionController._validateSessionId(sessionId);
    if (sessionId !== this.activeSessionId) throw new Error('sessionId 不是当前媒体。');
    this._releaseActive('cleared');
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this._releaseActive('pageDisposed', false);
    this.onVideoInfoChange = NOOP;
    this.onRendererChange = NOOP;
    this.onError = NOOP;
    this.onTechnicalPath = NOOP;
  }

  _handlePlaying(sessionId, generation, player) {
    if (!this._isCurrent(sessionId, generation, player)) return;
    this.bridge.emit('playing', sessionId);
  }

  _handleEnded(sessionId, generation, player) {
    if (!this._isCurrent(sessionId, generation, player)) return;
    this.bridge.emit('ended', sessionId, {
      duration: player.currentTimeUs / 1_000_000,
    });
    // ended 先同步送达宿主应用，再在微任务中销毁当前媒体的所有资源。
    queueMicrotask(() => {
      if (this._isCurrent(sessionId, generation, player)) this._releaseActive('ended');
    });
  }

  _handleError(sessionId, generation, player, error) {
    if (!this._isCurrent(sessionId, generation, player)) return;
    this.errorHandler.report(error, sessionId);
    queueMicrotask(() => {
      if (this._isCurrent(sessionId, generation, player)) this._releaseActive('error');
    });
    this.onError(error);
  }

  _releaseActive(reason, notify = true) {
    const releasedSessionId = this.activeSessionId;
    const player = this.player;
    this.generation += 1;
    this.transfer = null;
    this.player = null;
    this.activeSessionId = '';

    if (player) {
      // RendererFactory 的 WebGPU 回退可能替换 DOM Canvas，即使后续 WebGL 也失败。
      // 优先接管仍在页面中的节点，避免留下无法再次使用的 Context。
      this.canvas = this.canvasHost.querySelector('#video-canvas') ?? player.canvas;
      player.dispose();
      this.canvas = PlayerSessionController._replaceWithIdleCanvas(this.canvas);
    }
    if (notify && releasedSessionId) {
      this.bridge.emit('released', releasedSessionId, { reason });
    }
  }

  _requireTransfer(sessionId) {
    PlayerSessionController._validateSessionId(sessionId);
    if (!this.transfer || this.transfer.sessionId !== sessionId) {
      throw new Error('当前没有对应的媒体接收任务。');
    }
    return this.transfer;
  }

  _isCurrent(sessionId, generation, player) {
    return !this.disposed
      && this.activeSessionId === sessionId
      && this.generation === generation
      && this.player === player;
  }

  _assertAvailable() {
    if (this.disposed) throw new Error('页面播放器控制器已释放。');
  }

  static _validateSessionId(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId.trim()) {
      throw new Error('sessionId 必须是非空字符串。');
    }
  }

  static _decodeBase64(base64) {
    let binary;
    try {
      binary = window.atob(base64);
    } catch {
      throw new Error('媒体分块不是有效的 Base64。');
    }
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }

  static _replaceWithIdleCanvas(canvas) {
    const replacement = canvas.cloneNode(false);
    replacement.width = 1;
    replacement.height = 1;
    canvas.replaceWith(replacement);
    return replacement;
  }
}
