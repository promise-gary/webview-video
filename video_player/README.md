# Transparent Video Player

从定型 Demo 提取的精简播放器页面，内部播放、解码和渲染逻辑保持不变。

- 默认只显示全屏透明 Canvas；
- 点击 Canvas 播放或暂停；
- 通过 URL 参数传入视频地址和播放器配置；
- 使用 `debug=true` 显示视频技术信息和网络缓存进度；
- 必须通过 HTTP/HTTPS 访问，不能直接使用 `file://`。

```text
index.html?src=https%3A%2F%2Frender-video-server.onrender.com%2Fvideo
index.html?src=.%2Fvideos%2Fdemo.webm&audioEnabled=false&debug=true
```

URL 参数：

```text
src                 必填，支持相对或绝对 URL
startupBufferMs     默认 500
resumeBufferMs      默认 300
audioEnabled        默认 true
webGpuEnabled       默认 true
debug               默认 false
```

# WebM Demux + VideoDecoder Demo

播放链路：

```text
FetchStreamRequest
        ↓
IncrementalWebmDemuxer
   ├─ Block          → Color VP9 → VideoDecoder ┐
   ├─ BlockAdditional → Alpha VP9 → VideoDecoder ├→ WebGPU / WebGL
   └─ SimpleBlock    → Opus → AudioDecoder → Web Audio
                                            ↓
                                  视频主播放时钟
```

本次测试源 WebM 运行时 Demux、双路硬件解码、音频解码和 GPU 合成：

- 默认播放 WebM 内的 Opus 音轨，并以其播放进度驱动视频；
- 使用 `audioEnabled=false` 可关闭音频；
- 使用单次 `fetch` 持续读取 `response.body`，首段缓冲完成即可播放；
- 不使用 HLS/DASH，也不创建多个媒体分片；
- 下载和增量 Demux 持续运行到响应结束，不受播放进度控制；
- 当前高质量 WebM 约 9.95MB，首个 Cluster 约 990KB；Demuxer 累计到完整 Cluster 后
  才能输出其中的首批音视频数据；
- 不持久化资源，压缩帧和 PCM 只在内存中保留到 `dispose()`；
- 不依赖 IVF；
- 默认 WebGPU，失败时降级 WebGL；
- 使用 `webGpuEnabled=false` 可直接测试 WebGL。

当前源 WebM 包含 660 对 VP9 Color/Alpha 帧和一条 Opus 音轨。请通过 HTTP/HTTPS
访问 `index.html`，不要直接使用 `file://`。
