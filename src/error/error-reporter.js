export class PlayerError extends Error {
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
export class ErrorReporter {
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
