# WebView Transparent Video Player

面向宿主应用内嵌 WebView 的透明 WebM 播放页面。项目以 HTTPS 静态网站部署，页面
只负责解析和播放宿主应用传入的完整媒体数据，不会主动请求任何视频 URL。

## 播放链路

```text
宿主应用二进制数据
        ↓ Base64 分块传输
window.webviewVideo
        ↓ 完整数据到齐
WebM Demux
   ├─ VP9 Color ─┐
   ├─ VP9 Alpha ─┴→ VideoDecoder → WebGPU / WebGL
   └─ Opus → AudioDecoder → Web Audio 播放时钟
```

“无缓冲”指没有网络缓冲、启动缓冲和播放中的再缓冲。播放器仍保留最多 8 对已解码
VideoFrame 和约 1 秒的 Web Audio 调度窗口；它们是解码渲染所需的有界执行队列。

## 生命周期

- 页面加载后保持 idle，不创建 Decoder、AudioContext、GPU Renderer 或动画循环；
- 宿主应用完整传输媒体后，调用 `finishMedia` 创建播放器并自动开始一次性播放；
- 每份媒体对应一个 `sessionId` 和一个 `TransparentWebmPlayer`；
- 自然结束、播放错误或宿主应用主动 `clear` 后，释放该媒体的 Decoder、Audio、
  VideoFrame、GPU、PCM 和压缩数据引用；
- 页面和 WebView 保持存在，下一份媒体不需要重新创建 WebView；
- 播放结束不保留内部重播数据，如需重播应由宿主应用再次传入媒体。

## 宿主应用 → JavaScript

页面就绪后会暴露 `window.webviewVideo`。

### 1. 开始传输

```js
window.webviewVideo.beginMedia({
  sessionId: 'video-1',
  totalBytes: 10485760,
  options: {
    audioEnabled: true,
    webGpuEnabled: true,
  },
});
```

`totalBytes` 必须是准确的完整媒体字节数。开始传输只分配接收用 ArrayBuffer，不会
启动解析、解码或渲染。当前单份媒体上限为 512MiB。

### 2. 顺序追加 Base64 分块

```js
window.webviewVideo.appendMediaChunk({
  sessionId: 'video-1',
  sequence: 0,
  base64: 'GkXfo59ChoEBQveBAULygQ...',
});
```

建议宿主应用从二进制数据按 128–256KiB 分块、逐块等待 JavaScript 调用完成，再发送
下一块。`sequence` 从 `0` 开始且必须连续，Base64 不应包含 Data URL 前缀。

### 3. 完成加载并开始播放

```js
await window.webviewVideo.finishMedia({ sessionId: 'video-1' });
```

`finishMedia` 会验证接收字节数、解析完整 WebM、初始化解码器，并等待首帧实际渲染。
随后自动开始播放，宿主应用会依次收到 `loaded` 和 `playing` 事件。

如果 WebView 要通过 JavaScript 自动播放带音频内容，宿主侧需要允许媒体播放不依赖
页面用户手势；否则启动失败后播放器会发送 `error` 并释放当前媒体。

### 其他控制

```js
window.webviewVideo.clear({ sessionId: 'video-1' });
```

`clear` 用于强制终止和释放当前媒体，不支持暂停或恢复。开始新的 `sessionId` 也会释放并
替换尚未结束的旧媒体。

## JavaScript → 宿主应用

页面默认向名为 `VideoPlayerEvents` 的 JavaScriptChannel 发送 JSON 字符串：

```json
{
  "event": "loaded",
  "sessionId": "video-1",
  "data": {
    "width": 1080,
    "height": 1920,
    "duration": 22,
    "frames": 660,
    "renderer": "WebGPU"
  }
}
```

事件包括：

- `pageReady`：Bridge 已挂载；
- `loaded`：完整媒体解析、初始化和首帧渲染完成；
- `playing`：播放时钟已经启动；
- `ended`：自然播放结束；
- `error`：命令、加载或播放发生错误；
- `released`：当前媒体资源已经释放，页面恢复 idle。

正常顺序固定为 `loaded → playing → ended → released`。活动播放器发生错误时顺序为
`error → released`；无活动 Session 的命令校验错误只发送 `error`。
普通浏览器调试时，相同 payload 也会通过 `webview-video-event` CustomEvent 派发。

### 错误上报

公开 API 和播放器产生的错误会发送到 `VideoPlayerEvents`：

```json
{
  "event": "error",
  "sessionId": "video-1",
  "data": {
    "message": "当前环境不支持 VideoDecoder。"
  }
}
```

公开 API 发送错误事件后仍会保留原有的 throw 或 reject，避免改变现有调用语义。

## 媒体约束

当前解析和播放内核支持：

- 一个带 `AlphaMode` 的 VP9 视频轨；
- 颜色帧位于 `Block`，Alpha 帧位于对应的 `BlockAdditional`；
- 第一对 Color/Alpha 帧必须是关键帧；
- 可选的单 Opus 音轨；
- 不支持 HLS、DASH、Lacing、多视频轨或加密媒体。

## 静态部署

项目没有运行时第三方依赖和构建步骤，可以直接把仓库中的静态文件部署到 HTTPS
站点。入口为 `index.html`，可使用 `?debug=true` 显示媒体、Renderer 和技术链路信息。

浏览器仍会通过 HTTPS 加载站点自身的 HTML、CSS 和 JavaScript 模块；“不主动请求数据”
特指播放器不会通过 Fetch、XHR 或媒体 URL 获取视频内容。
