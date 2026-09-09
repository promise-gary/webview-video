/**
 * 保存一份完整 WebM 解析出的压缩音视频数据。
 *
 * 帧数据是原始 ArrayBuffer 的视图，不会为每一帧复制字节；因此 clear() 不仅
 * 清理索引，也会断开播放器对整份 WebM ArrayBuffer 的最后一组强引用。
 */
export class EncodedMediaStore {
  constructor() {
    this.metadata = null;
    this.frames = [];
    this.audioChunks = [];
    this.videoDurationUs = 0;
  }

  load(media) {
    this.metadata = {
      width: media.width,
      height: media.height,
      codedWidth: media.codedWidth,
      codedHeight: media.codedHeight,
      codec: media.codec,
      audio: media.audio,
    };
    this.frames = media.frames;
    this.audioChunks = media.audio?.chunks ?? [];
    this.videoDurationUs = media.duration;
  }

  clear() {
    this.metadata = null;
    this.frames = [];
    this.audioChunks = [];
    this.videoDurationUs = 0;
  }
}
