const LOG_TYPES = Object.freeze({
  success: { symbol: '✓', className: 'success' },
  info: { symbol: '→', className: 'info' },
  warning: { symbol: '⚠', className: 'warning' },
  error: { symbol: '✕', className: 'error' },
});

let logPanelInstance = null;

/** 仅在 debug 模式展示播放器实际经过的技术节点。 */
export class LogPanel {
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
