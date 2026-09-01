import { WebmDemuxer } from './webm-demuxer.js';

const ID = Object.freeze({
  SEGMENT: 0x18538067,
  INFO: 0x1549a966,
  TRACKS: 0x1654ae6b,
  CLUSTER: 0x1f43b675,
});

const DEFAULT_FRAME_DURATION_US = 1_000_000 / 30;
const DEFAULT_AUDIO_DURATION_US = 20_000;

/**
 * 只读取本 Demo 需要的 WebM 顶层 Element。append() 可接收任意网络字节块：
 * 不完整 Element 留在内部，下一批字节到达后再继续解析。
 */
export class IncrementalWebmDemuxer {
  constructor() {
    this.bytes = new Uint8Array(0);
    this.length = 0;
    this.cursor = 0;
    this.segmentEnd = 0;
    this.timecodeScaleNs = 1_000_000;
    this.videoTrack = null;
    this.audioTrack = null;
    this.metadataSent = false;
    this.pendingFrame = null;
    this.pendingAudioChunk = null;
    this.frameCount = 0;
    this.finished = false;
  }

  append(chunk) {
    if (this.finished) throw new Error('WebM Demuxer 已结束，不能继续追加数据。');
    this._appendBytes(chunk);
    return this._drain(false);
  }

  finish() {
    if (this.finished) return this._emptyOutput();
    this.finished = true;
    const output = this._drain(true);
    if (!this.videoTrack || (!this.frameCount && !this.pendingFrame)) {
      throw new Error('WebM 中没有可解码的 VP9 Alpha 帧。');
    }
    this._flushPending(output, 'frame');
    this._flushPending(output, 'audio');
    output.sourceBytes = this.length;
    return output;
  }

  _appendBytes(chunk) {
    const required = this.length + chunk.byteLength;
    if (required > this.bytes.byteLength) {
      const capacity = Math.max(required, this.bytes.byteLength * 2, 64 * 1024);
      const next = new Uint8Array(capacity);
      next.set(this.bytes.subarray(0, this.length));
      this.bytes = next;
    }
    this.bytes.set(chunk, this.length);
    this.length = required;
  }

  _drain(isFinal) {
    const output = this._emptyOutput();
    if (!this.segmentEnd && !this._readSegmentHeader(isFinal)) return output;

    const limit = Math.min(this.length, this.segmentEnd);
    while (this.cursor < limit) {
      const element = this._readElement(this.cursor, limit, isFinal);
      if (!element) break;
      this.cursor = element.end;

      if (element.id === ID.INFO) {
        this.timecodeScaleNs = WebmDemuxer._readTimecodeScale(this.bytes, element);
      } else if (element.id === ID.TRACKS) {
        const tracks = WebmDemuxer._readTracks(this.bytes, element);
        this.videoTrack = tracks.videoTrack;
        this.audioTrack = tracks.audioTrack;
        if (!this.metadataSent) {
          this.metadataSent = true;
          output.metadata = {
            width: this.videoTrack.width,
            height: this.videoTrack.height,
            codec: 'vp09.00.40.08',
            audio: this.audioTrack && {
              codec: 'opus',
              sampleRate: this.audioTrack.sampleRate,
              numberOfChannels: this.audioTrack.numberOfChannels,
            },
          };
        }
      } else if (element.id === ID.CLUSTER) {
        if (!this.videoTrack) throw new Error('WebM Cluster 出现在 Tracks 之前。');
        const streams = WebmDemuxer._readCluster(
          this.bytes,
          element,
          this.videoTrack.number,
          this.audioTrack?.number ?? 0,
          this.timecodeScaleNs
        );
        streams.frames.sort((left, right) => left.timestamp - right.timestamp);
        streams.audioChunks.sort((left, right) => left.timestamp - right.timestamp);
        for (const frame of streams.frames) this._appendFrame(output, frame);
        for (const chunk of streams.audioChunks) this._appendAudio(output, chunk);
      }
    }

    if (isFinal && this.cursor < limit) throw new Error('WebM 文件在一个 Element 结束前截断。');
    return output;
  }

  _readSegmentHeader(isFinal) {
    let offset = 0;
    while (offset < this.length) {
      try {
        const availableBytes = this.bytes.subarray(0, this.length);
        const id = WebmDemuxer._readVint(availableBytes, offset, true);
        const size = WebmDemuxer._readVint(availableBytes, offset + id.length, false);
        const dataOffset = offset + id.length + size.length;
        const end = size.unknown ? Number.POSITIVE_INFINITY : dataOffset + size.value;

        // Segment 的 payload 就是后续要增量读取的主体；头部完整后不能再等待整个 payload。
        if (id.value === ID.SEGMENT) {
          this.cursor = dataOffset;
          this.segmentEnd = end;
          return true;
        }

        // Segment 之前的 EBML Header 等元素仍必须完整，才能安全跳到下一个元素。
        if (size.unknown || end > this.length) return false;
        offset = end;
      } catch (error) {
        if (isFinal) throw error;
        return false;
      }
    }
    if (isFinal) throw new Error('资源不是有效的 WebM：没有 Segment。');
    return false;
  }

  _readElement(offset, limit, isFinal) {
    try {
      // 解析头时使用逻辑长度视图，避免扩容后的零填充被误认为真实网络数据。
      const availableBytes = this.bytes.subarray(0, limit);
      const id = WebmDemuxer._readVint(availableBytes, offset, true);
      const size = WebmDemuxer._readVint(availableBytes, offset + id.length, false);
      const dataOffset = offset + id.length + size.length;
      if (dataOffset > limit) return null;
      if (size.unknown && !isFinal) return null;
      const end = size.unknown ? limit : dataOffset + size.value;
      if (end > limit || end <= offset) return null;
      return {
        id: id.value,
        size: end - dataOffset,
        dataOffset,
        end,
        unknown: size.unknown,
      };
    } catch (error) {
      // 网络块经常只包含一部分 EBML 头；最终输入仍无法读取才视为非法资源。
      if (isFinal) throw error;
      return null;
    }
  }

  _appendFrame(output, frame) {
    if (!this.frameCount && !this.pendingFrame && (
      frame.color.type !== 'key' || frame.alpha.type !== 'key'
    )) {
      throw new Error('WebM 的第一对 Color/Alpha 帧必须都是关键帧。');
    }
    const pendingFrame = this.pendingFrame;
    if (pendingFrame) {
      pendingFrame.duration ||= frame.timestamp - pendingFrame.timestamp;
      output.frames.push(pendingFrame);
      this.frameCount += 1;
    }
    this.pendingFrame = frame;
  }

  _appendAudio(output, chunk) {
    const pendingAudioChunk = this.pendingAudioChunk;
    if (pendingAudioChunk) {
      pendingAudioChunk.duration ||= chunk.timestamp - pendingAudioChunk.timestamp;
      output.audioChunks.push(pendingAudioChunk);
    }
    this.pendingAudioChunk = chunk;
  }

  _flushPending(output, type) {
    const key = type === 'frame' ? 'pendingFrame' : 'pendingAudioChunk';
    const fallback = type === 'frame' ? DEFAULT_FRAME_DURATION_US : DEFAULT_AUDIO_DURATION_US;
    const outputKey = type === 'frame' ? 'frames' : 'audioChunks';
    const pendingItem = this[key];
    if (!pendingItem) return;
    pendingItem.duration ||= fallback;
    output[outputKey].push(pendingItem);
    if (type === 'frame') this.frameCount += 1;
    this[key] = null;
  }

  _emptyOutput() {
    return { metadata: null, frames: [], audioChunks: [], sourceBytes: 0 };
  }
}
