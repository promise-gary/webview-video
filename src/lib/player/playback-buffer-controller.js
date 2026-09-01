/** 只判断“是否有足够的压缩音视频可继续播放”，不持有任何媒体数据。 */
export class PlaybackBufferController {
  constructor({ startupBufferMs, resumeBufferMs, audioEnabled }) {
    this.startupBufferUs = startupBufferMs * 1000;
    this.resumeBufferUs = resumeBufferMs * 1000;
    this.audioEnabled = audioEnabled;
  }

  canStart(store, audioClock, timestampUs = 0) {
    return this._hasBufferedMedia(store, audioClock, timestampUs, this.startupBufferUs);
  }

  canContinue(store, audioClock, timestampUs) {
    return this._hasBufferedMedia(store, audioClock, timestampUs, this.resumeBufferUs);
  }

  _hasBufferedMedia(store, audioClock, timestampUs, requiredUs) {
    const bufferedThroughUs = timestampUs + requiredUs;
    return Boolean(store.frames.length)
      && store.hasVideoThrough(bufferedThroughUs)
      && (!this.audioEnabled || audioClock?.hasBufferedThrough(bufferedThroughUs));
  }
}
