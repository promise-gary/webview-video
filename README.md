# Transparent Video Player

面向 Flutter WebView 内嵌场景的透明 WebM 播放器。播放器不访问远端视频地址，
视频资源的获取和缓存由 Flutter 宿主管理，页面通过 JavaScript Bridge 分块读取字节。

播放链路：

```text
Flutter 本地资源
        ↓ JavaScript Bridge（256 KB 分块）
BridgeReader
        ↓ 完整接收后进入 ready
IncrementalWebmDemuxer
   ├─ Block           → VP9 Color → VideoDecoder ┐
   ├─ BlockAdditional → VP9 Alpha → VideoDecoder ├→ WebGPU / WebGL
   └─ SimpleBlock     → Opus → AudioDecoder → Web Audio
```

主要行为：

- 页面没有按钮、点击或触摸播放事件；
- 完整资源接收、Demux 和媒体初始化完成后自动播放；
- 默认关闭音频，避免无用户手势时触发 WebView 的自动播放限制；
- 仍保留 VP9 Color/Alpha 解码、Opus、WebGPU/WebGL 降级和两套 Debug Panel；
- 播放器不提供暂停和重播，Flutter 可以通过 Bridge 调用 `dispose`；
- 每次资源读取使用独立 `sessionId`，旧资源分块不会进入新播放任务。

## 嵌入 Flutter

修改源码后先生成不依赖 ES Module 的单文件脚本：

```shell
npm run build
```

然后将运行时文件复制到 Flutter 项目的 `assets/webview_video/`：

```text
assets/webview_video/
├── index.html
├── styles.css
└── dist/
    └── player-bundle.js
```

源码仍保留在 `src/` 中维护，但 Flutter 不需要打包源码目录。`dist/player-bundle.js` 是零依赖
构建脚本生成的经典脚本，可以避免本地 `file://` 页面加载 ES Module 时的跨域差异。

在 `pubspec.yaml` 中登记运行时目录：

```yaml
flutter:
  assets:
    - assets/webview_video/
    - assets/webview_video/dist/
```

先注册 JavaScript Channel，再加载本地页面：

```dart
final webViewController = WebViewController();
await webViewController.setJavaScriptMode(JavaScriptMode.unrestricted);
await webViewController.setBackgroundColor(const Color(0x00000000));
await webViewController.addJavaScriptChannel(
  'WebviewVideoBridge',
  onMessageReceived: onWebviewVideoMessage,
);
await webViewController.loadFlutterAsset('assets/webview_video/index.html');
```

页面初始化完成后会发送：

```json
{
  "type": "pageReady",
  "protocolVersion": 1
}
```

Flutter 收到 `pageReady` 后调用 `open`。参数需要使用 `jsonEncode` 生成，避免字符串
转义问题：

```dart
final openPayload = jsonEncode(<String, Object>{
  'sessionId': 'gift-001',
  'totalBytes': resourceBytes.length,
  'chunkSize': 262144,
  'audioEnabled': false,
  'webGpuEnabled': true,
  'debug': kDebugMode,
});

await webViewController.runJavaScript(
  'window.WebviewVideo.open($openPayload)',
);
```

`resourceBytes` 只是示例。正式项目可以在自己的 DataProvider 或 Service 中维护资源，
播放器只要求能够按照 `offset` 和 `length` 返回 `Uint8List`，不要求使用文件路径。

## Bridge 资源传输

页面每次只向 Flutter 请求一个分块：

```json
{
  "type": "readResource",
  "sessionId": "gift-001",
  "offset": 0,
  "length": 262144
}
```

Flutter 根据范围读取字节，并通过 `receiveResourceChunk` 返回。最后一块需要将 `done`
设置为 `true`：

```dart
import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

Future<void> sendResourceChunk({
  required String sessionId,
  required int offset,
  required int length,
  required Uint8List resourceBytes,
}) async {
  final end = min(offset + length, resourceBytes.length);
  final chunkBytes = Uint8List.sublistView(resourceBytes, offset, end);
  final chunkPayload = jsonEncode(<String, Object>{
    'sessionId': sessionId,
    'offset': offset,
    'base64': base64Encode(chunkBytes),
    'done': end == resourceBytes.length,
  });

  await webViewController.runJavaScript(
    'window.WebviewVideo.receiveResourceChunk($chunkPayload)',
  );
}
```

如果 Flutter 读取失败，可以终止当前资源：

```dart
final errorPayload = jsonEncode(<String, Object>{
  'sessionId': 'gift-001',
  'message': '本地资源读取失败',
});
await webViewController.runJavaScript(
  'window.WebviewVideo.failResource($errorPayload)',
);
```

Bridge 使用 Base64 是因为 `webview_flutter` 的 JavaScript Channel 传递字符串。
播放器使用 256 KB 分块限制单次字符串和临时内存大小；分块仅用于传输，播放器不会在
资源未完整时提前播放。

## Flutter 接收消息

`onWebviewVideoMessage` 需要解析 `JavaScriptMessage.message`：

```dart
Future<void> onWebviewVideoMessage(JavaScriptMessage javaScriptMessage) async {
  final decodedMessage = jsonDecode(javaScriptMessage.message);
  if (decodedMessage is! Map<String, dynamic>) return;

  final messageType = decodedMessage['type'];
  if (messageType == 'pageReady') {
    await openVideoResource();
    return;
  }
  if (messageType == 'readResource') {
    await handleResourceRead(decodedMessage);
    return;
  }
  if (messageType == 'resourceReady') {
    onResourceReady(decodedMessage);
    return;
  }
  if (messageType == 'playStarted') {
    onPlayStarted(decodedMessage);
    return;
  }
  if (messageType == 'playStopped') {
    onPlayStopped(decodedMessage);
    return;
  }
  if (messageType == 'playerError') {
    onPlayerError(decodedMessage);
  }
}
```

其中 `openVideoResource`、`handleResourceRead` 和四个 `on...` 方法由 Flutter 使用者根据
自己的 DataProvider、BLoC 或业务回调实现。

## Bridge 回调

### 资源准备完毕

所有字节接收、Demux、时长校验和渲染器初始化完成后发送一次：

```json
{
  "type": "resourceReady",
  "sessionId": "gift-001",
  "sourceBytes": 17400000,
  "resourceComplete": true,
  "width": 750,
  "height": 1624,
  "frames": 318,
  "duration": 11.517,
  "renderer": "WebGL"
}
```

### 开始播放

播放器真正进入播放时钟后发送一次：

```json
{
  "type": "playStarted",
  "sessionId": "gift-001",
  "currentTime": 0
}
```

### 停止播放

自然结束、资源替换、释放或播放失败时发送：

```json
{
  "type": "playStopped",
  "sessionId": "gift-001",
  "currentTime": 11.517,
  "reason": "ended"
}
```

`reason` 可能为：

```text
ended
failed
replaced
disposed
```

当前版本必须等完整资源准备完毕才播放，不再存在播放期间的缓冲状态。

### 错误

资源传输、Demux、解码、渲染、音频或播放失败时发送：

```json
{
  "type": "playerError",
  "sessionId": "gift-001",
  "code": "DEMUX_FAILED",
  "stage": "demux",
  "message": "WebM 数据解析失败"
}
```

`code` 可能为 `BRIDGE_FAILED`、`DEMUX_FAILED`、`DECODER_FAILED`、
`RENDERER_FAILED`、`AUDIO_FAILED` 或 `PLAYBACK_FAILED`。

## Flutter 主动控制

页面不注册任何用户交互事件，也不提供暂停和重播。离开页面时可以主动释放：

```dart
await webViewController.runJavaScript('window.WebviewVideo.dispose()');
```

需要播放新资源时，使用新的 `sessionId` 再次调用 `open()`。

## 配置参数

`window.WebviewVideo.open()` 支持：

```text
sessionId          必填，非空字符串
totalBytes         必填，资源完整字节数
chunkSize          默认 262144
audioEnabled       默认 false
webGpuEnabled      默认 true
debug              默认 false
```
