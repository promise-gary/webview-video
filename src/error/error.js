/**
 * 将播放器错误去重后通知宿主应用。
 */
export class ErrorHandler {
  constructor({ bridge }) {
    this.bridge = bridge;
    this.reportedErrors = new WeakSet();
  }

  report(error, fileName = '') {
    if (error instanceof Error) {
      if (this.reportedErrors.has(error)) return;
      this.reportedErrors.add(error);
    }

    const message =
      error instanceof Error
        ? error.message
        : typeof error === 'string'
          ? error
          : '发生未知错误。';
    this.bridge.emit('error', fileName, { message });
  }
}
