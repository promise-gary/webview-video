const MEMORY_SAMPLE_INTERVAL_MS = 30_000;

/** 只供 Safari Web Inspector 和宿主应用使用的低频播放器诊断日志。 */
export class PlayerDiagnostics {
  static create({ enabled, bridge }) {
    return new PlayerDiagnostics({ enabled, bridge });
  }

  constructor({ enabled, bridge }) {
    this.enabled = enabled;
    this.bridge = bridge;
    this.startedAt = performance.now();
    this.lastUserAgentMemorySampleAt = 0;
  }

  info(event, data = {}) {
    this._write('info', event, data);
  }

  warn(event, data = {}) {
    this._write('warn', event, data);
  }

  error(event, error, data = {}) {
    this._write('error', event, {
      ...data,
      error: PlayerDiagnostics._createErrorInfo(error),
    });
  }

  sampleMemory(stage, data = {}) {
    if (!this.enabled) return;
    const performanceMemory = performance.memory;
    const heap = performanceMemory
      ? {
        usedBytes: performanceMemory.usedJSHeapSize,
        totalBytes: performanceMemory.totalJSHeapSize,
        limitBytes: performanceMemory.jsHeapSizeLimit,
      }
      : 'unavailable';
    this.info('memory.sample', { stage, heap, ...data });

    const measureMemory = performance.measureUserAgentSpecificMemory;
    const now = performance.now();
    if (typeof measureMemory !== 'function' || now - this.lastUserAgentMemorySampleAt < MEMORY_SAMPLE_INTERVAL_MS) {
      return;
    }
    this.lastUserAgentMemorySampleAt = now;
    void measureMemory.call(performance)
      .then((result) => this.info('memory.user-agent', { stage, bytes: result.bytes }))
      .catch((error) => this.warn('memory.user-agent.unavailable', {
        stage,
        message: error instanceof Error ? error.message : String(error),
      }));
  }

  _write(level, event, data) {
    if (!this.enabled) return;
    const { fileName = '', ...details } = data;
    const payload = {
      elapsedMs: Math.round(performance.now() - this.startedAt),
      level,
      event,
      ...details,
    };
    console[level]('[video-diag]', payload);
    this.bridge.emit('diagnostic', fileName, payload);
  }

  static _createErrorInfo(error) {
    if (error instanceof Error) {
      return {
        name: error.name,
        message: error.message,
        stack: error.stack ?? '',
        cause: error.cause instanceof Error
          ? error.cause.message
          : error.cause === undefined
            ? ''
            : String(error.cause),
      };
    }
    return { name: typeof error, message: String(error), stack: '' };
  }
}
