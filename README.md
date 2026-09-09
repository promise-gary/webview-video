# WebView Transparent Video Player

用于 Flutter WebView 的透明 WebM 串行播放页。页面自行下载完整视频，完成后才解析、
解码和播放；当前视频的资源完全释放后，才会下载下一份视频。

## 播放链路

```text
完整下载一个 WebM
        ↓
WebM Demux
        ↓
单路 VP9（左半 RGB + 右半 Alpha）
        ↓
单 VideoDecoder → WebGPU / WebGL 合成
        ↓
等待最后一帧绘制完成
        ↓
释放 Decoder、VideoFrame、Renderer、Canvas 和完整文件数据
        ↓
下载下一个 WebM
```

测试资源为：

```text
https://downloadcdn.oopz.cn/video_test_20260902/001-low.webm
...
https://downloadcdn.oopz.cn/video_test_20260902/134-high.webm
```

每个编号按 `low → standard → high` 顺序播放。页面默认关闭音频，只测试视频解码、
透明通道合成和 Canvas 绘制。

## 页面 API

页面加载后会自动从第一份资源开始播放，同时提供：

```js
window.webviewVideo.playPrevious();
window.webviewVideo.playNext();
window.webviewVideo.clear();
```

切换视频会取消当前下载或播放，但新任务仍会等待旧任务完整释放，不会并行持有两份
视频资源。

播放器初始化完成后通过 `VideoPlayerEvents` JavaScriptChannel 上报一次 `version` 事件；
正常下载和播放过程不向 Flutter 发送日志事件。错误通过 `error` 事件上报，并包含当前
视频的 `fileName` 和错误详情：

```json
{"event":"version","fileName":"","data":{"version":"1.0.1"}}
```

```json
{"event":"error","fileName":"001-low.webm","data":{"message":"错误信息"}}
```

## Debug

使用 `?debug=true` 显示当前文件、下载字节数、下载百分比、视频信息和 Renderer。

## 构建

```bash
npm ci
npm run build
```

构建产物位于 `dist/`，可作为静态站点部署。
