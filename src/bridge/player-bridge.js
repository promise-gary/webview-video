const DEFAULT_CHANNEL_NAME = 'VideoPlayerEvents';
const BROWSER_EVENT_NAME = 'webview-video-event';

/**
 * 播放器页面 → 宿主应用的单向事件适配器。
 *
 * 宿主 WebView 可以注入带 postMessage() 的 VideoPlayerEvents 对象接收 JSON；
 * 同一 payload 也会作为 DOM CustomEvent 派发，便于在普通浏览器中独立联调。
 */
export class PlayerBridge {
  constructor({ channelName = DEFAULT_CHANNEL_NAME } = {}) {
    this.channelName = channelName;
  }

  emit(event, sessionId = '', data = {}) {
    const payload = {
      event,
      sessionId,
      data,
    };
    const channel = window[this.channelName];

    // 宿主通道不存在时保持静默，确保页面可以独立在浏览器中调试。
    if (channel && typeof channel.postMessage === 'function') {
      try {
        channel.postMessage(JSON.stringify(payload));
      } catch (error) {
        // Bridge 故障不应破坏播放器自身的释放流程，但必须保留可观测错误。
        console.error('VideoPlayerEvents 消息发送失败。', error);
      }
    }
    try {
      window.dispatchEvent(new CustomEvent(BROWSER_EVENT_NAME, { detail: payload }));
    } catch (error) {
      console.error('播放器浏览器事件派发失败。', error);
    }
  }
}
