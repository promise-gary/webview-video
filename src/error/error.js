/**
 * 将播放器错误去重后通知宿主应用。
 */
export class ErrorHandler {
  constructor({ bridge }) {
    this.bridge = bridge;
    this.reportedErrors = new WeakSet();
  }

  /** 创建带上下文的错误并先通知宿主，调用方仍可继续 throw/reject。 */
  create(message, { fileName = '', cause } = {}) {
    const causeMessage = ErrorHandler._getMessage(cause);
    const causeName = cause && typeof cause.name === 'string' ? cause.name : '';
    const causeDetail = causeName && causeName !== 'Error'
      ? `${causeName}${causeMessage ? `: ${causeMessage}` : ''}`
      : causeMessage;
    const completeMessage = causeDetail && causeDetail !== message
      ? `${message}：${causeDetail}`
      : message;
    const error = new Error(completeMessage);
    if (cause !== undefined) {
      error.cause = cause;
      if (cause && typeof cause.name === 'string') error.name = cause.name;
    }
    this.report(error, fileName);
    return error;
  }

  report(error, fileName = '') {
    if (error instanceof Error) {
      if (this.reportedErrors.has(error)) return;
      this.reportedErrors.add(error);
    }

    const message = ErrorHandler._getMessage(error) || '发生未知错误。';
    this.bridge.emit('error', fileName, {
      message,
      name: error && typeof error.name === 'string' ? error.name : typeof error,
      stack: error && typeof error.stack === 'string' ? error.stack : '',
      cause: ErrorHandler._getMessage(error?.cause),
    });
  }

  static _getMessage(error) {
    if (error instanceof Error) return error.message;
    if (typeof error === 'string') return error;
    if (error && typeof error.message === 'string') return error.message;
    return '';
  }
}
