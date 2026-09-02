/**
 * 将播放器内部错误通知给宿主应用，同时保留原有的 throw/reject 行为。
 */
export class ErrorHandler {
  constructor({ bridge }) {
    this.bridge = bridge;
    this.reportedErrors = new WeakSet();
  }

  handle(command, callback) {
    const sessionId =
      command && typeof command.sessionId === "string"
        ? command.sessionId
        : "";

    try {
      const result = callback();
      if (result && typeof result.then === "function") {
        return result.catch((error) => {
          this.report(error, sessionId);
          throw error;
        });
      }
      return result;
    } catch (error) {
      this.report(error, sessionId);
      throw error;
    }
  }

  report(error, sessionId = "") {
    if (error instanceof Error) {
      if (this.reportedErrors.has(error)) return;
      this.reportedErrors.add(error);
    }

    const message =
      error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : "发生未知错误。";
    this.bridge.emit("error", sessionId, { message });
  }
}
