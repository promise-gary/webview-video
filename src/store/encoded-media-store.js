/** 保存 Demux 产生的压缩媒体数据，已解码的 VideoFrame 由播放器及时释放。 */
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
}
