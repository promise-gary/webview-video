/**
 * 仅保存压缩数据。短视频完整下载后仍保留它们，暂停恢复和重新播放时无需再次请求。
 * 已解码的 VideoFrame 不放在这里，仍由播放器维持很小的窗口并及时 close()。
 */
export class EncodedMediaStore {
  constructor() {
    this.metadata = null;
    this.frames = [];
    this.audioChunks = [];
    this.videoBufferedEndUs = 0;
    this.sourceBytes = 0;
    this.complete = false;
  }

  append({ metadata, frames, audioChunks }) {
    if (metadata) this.metadata = metadata;
    this.frames.push(...frames);
    this.audioChunks.push(...audioChunks);
    for (const frame of frames) {
      this.videoBufferedEndUs = Math.max(
        this.videoBufferedEndUs,
        frame.timestamp + frame.duration
      );
    }
  }

  finish(sourceBytes) {
    this.sourceBytes = sourceBytes;
    this.complete = true;
  }

  hasVideoThrough(timestampUs) {
    return this.complete || this.videoBufferedEndUs >= timestampUs;
  }
}
