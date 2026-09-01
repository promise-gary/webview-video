const DEFAULT_CHANNEL_NAME = 'WebviewVideoBridge';

/** 封装 WebView 页面向宿主发送的字符串消息。 */
export class NativeBridge {
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
