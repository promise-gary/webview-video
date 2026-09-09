/**
 * 当前 Demo 所需的最小 WebM / Matroska Element ID。
 *
 * 这里只实现“单路左右拼接 VP9 视频轨 + 单 Opus 音频轨”的读取能力，不试图成为
 * 通用 Matroska 库。遇到加密、Lacing、多视频轨等结构时会明确报错。
 */
const ID = Object.freeze({
  // WebM/Matroska 顶层结构与时间基。
  SEGMENT: 0x18538067,
  INFO: 0x1549a966,
  TIMECODE_SCALE: 0x2ad7b1,

  // Tracks 下每条音视频轨共用的元数据。
  TRACKS: 0x1654ae6b,
  TRACK_ENTRY: 0xae,
  TRACK_NUMBER: 0xd7,
  TRACK_TYPE: 0x83,
  CODEC_ID: 0x86,
  CODEC_PRIVATE: 0x63a2,

  // VP9 视频轨的编码尺寸。
  VIDEO: 0xe0,
  PIXEL_WIDTH: 0xb0,
  PIXEL_HEIGHT: 0xba,

  // Opus 音频轨的采样参数。
  AUDIO: 0xe1,
  SAMPLING_FREQUENCY: 0xb5,
  CHANNELS: 0x9f,

  // Cluster 内保存真正的压缩数据和局部时间码。
  CLUSTER: 0x1f43b675,
  CLUSTER_TIMECODE: 0xe7,
  BLOCK_GROUP: 0xa0,
  BLOCK: 0xa1,
  SIMPLE_BLOCK: 0xa3,
  BLOCK_DURATION: 0x9b,
});

// Matroska TrackType 的标准编号：1 表示视频，2 表示音频。
const VIDEO_TRACK_TYPE = 1;
const AUDIO_TRACK_TYPE = 2;

// TimecodeScale 缺省为 1,000,000ns，即一个 WebM tick 等于 1ms。
const DEFAULT_TIMECODE_SCALE_NS = 1_000_000;

// 只有最后一块缺少 duration 且无法推导时才会用到这些保底值。
const FALLBACK_FRAME_DURATION_US = 1_000_000 / 30;
const FALLBACK_AUDIO_DURATION_US = 20_000;

/**
 * 完整 WebM 文件的解析工具。宿主应用传输全部字节并确认结束后，播放器才调用
 * parse()；播放阶段不会再等待或追加媒体数据。
 *
 * 每个 VP9 帧的左半边保存 RGB，右半边保存灰度 Alpha。Demux 后每个时间戳
 * 只产生一个压缩块，播放器也只需一个 VideoDecoder。
 */
export class WebmDemuxer {
  /**
   * @param {ArrayBuffer} buffer 完整 WebM 文件。
   * @param {{ audioEnabled?: boolean }} options 解析开关。
   * @returns {{
   *   frames: Array<{
   *     timestamp: number,
   *     duration: number,
   *     data: Uint8Array,
   *     type: 'key' | 'delta'
   *   }>,
   *   width: number,
   *   height: number,
   *   duration: number,
   *   codec: string,
   *   audio: null | {
   *     chunks: Array<{
   *       timestamp: number,
   *       duration: number,
   *       type: 'key',
   *       data: Uint8Array
   *     }>,
   *     codec: 'opus',
   *     sampleRate: number,
   *     numberOfChannels: number,
   *     codecPrivate: Uint8Array,
   *     duration: number
   *   }
   * }}
   */
  static parse(buffer, { audioEnabled = true } = {}) {
    // Uint8Array 只建立视图，不复制完整文件；各帧 data 也继续引用该缓冲区。
    const bytes = new Uint8Array(buffer);

    // 第一阶段读取容器元数据，得到时间基和音视频 TrackNumber。
    const segment = this._findSegment(bytes);
    let info = null;
    let tracks = null;
    for (const element of this._children(bytes, segment)) {
      if (element.id === ID.INFO) info = element;
      if (element.id === ID.TRACKS) tracks = element;
      if (info && tracks) break;
    }
    if (!info || !tracks) throw new Error('WebM 缺少 Info 或 Tracks。');

    const timecodeScaleNs = this._readTimecodeScale(bytes, info);
    const { videoTrack, audioTrack } = this._readTracks(bytes, tracks, audioEnabled);
    // 第二阶段遍历全部 Cluster，把交织存储的音视频压缩块分别放入两个时间轴。
    const frames = [];
    const audioChunks = audioTrack ? [] : null;

    for (const cluster of this._children(bytes, segment)) {
      if (cluster.id !== ID.CLUSTER) continue;
      const clusterStreams = this._readCluster(
        bytes,
        cluster,
        videoTrack.number,
        audioTrack?.number ?? 0,
        timecodeScaleNs
      );
      frames.push(...clusterStreams.frames);
      if (audioChunks) audioChunks.push(...clusterStreams.audioChunks);
    }

    // Cluster 一般按时间排列，但显式排序可以避免依赖封装器的写入顺序。
    frames.sort((left, right) => left.timestamp - right.timestamp);
    if (!frames.length) throw new Error('WebM 中没有可解码的 VP9 帧。');
    const firstFrame = frames[0];
    if (firstFrame.type !== 'key') {
      throw new Error('WebM 的第一帧必须是关键帧。');
    }

    // WebCodecs chunk 最好带 duration；容器未写时根据下一个 timestamp 推导。
    this._fillFrameDurations(frames);
    if (audioChunks) this._fillChunkDurations(audioChunks, FALLBACK_AUDIO_DURATION_US);
    return {
      frames,
      width: videoTrack.width / 2,
      height: videoTrack.height,
      codedWidth: videoTrack.width,
      codedHeight: videoTrack.height,
      duration: frames.at(-1).timestamp + frames.at(-1).duration,
      codec: 'vp09.00.10.08',
      audio: audioTrack
        ? {
          chunks: audioChunks,
          codec: 'opus',
          sampleRate: audioTrack.sampleRate,
          numberOfChannels: audioTrack.numberOfChannels,
          codecPrivate: audioTrack.codecPrivate,
          duration: audioChunks.length
            ? audioChunks.at(-1).timestamp + audioChunks.at(-1).duration
            : 0,
        }
        : null,
    };
  }

  // 在 EBML 顶层找到 Segment；Segment 可以使用“未知长度”编码直到文件结尾。
  static _findSegment(bytes) {
    let offset = 0;
    while (offset < bytes.length) {
      const element = this._readElement(bytes, offset, bytes.length);
      if (element.id === ID.SEGMENT) return element;
      offset = element.end;
    }
    throw new Error('资源不是有效的 WebM：没有 Segment。');
  }

  // Info 中的 TimecodeScale 单位为纳秒；WebM 默认值是 1,000,000ns。
  static _readTimecodeScale(bytes, info) {
    for (const element of this._children(bytes, info)) {
      if (element.id === ID.TIMECODE_SCALE) return this._readUnsigned(bytes, element);
    }
    return DEFAULT_TIMECODE_SCALE_NS;
  }

  // 读取本播放器支持的唯一 VP9 视频轨，以及可选的唯一 Opus 音频轨。
  static _readTracks(bytes, tracks, audioEnabled) {
    const videoTracks = [];
    const audioTracks = audioEnabled ? [] : null;
    for (const entry of this._children(bytes, tracks)) {
      if (entry.id !== ID.TRACK_ENTRY) continue;

      let entryType = 0;
      for (const element of this._children(bytes, entry)) {
        if (element.id !== ID.TRACK_TYPE) continue;
        entryType = this._readUnsigned(bytes, element);
        break;
      }
      if (entryType !== VIDEO_TRACK_TYPE && (!audioEnabled || entryType !== AUDIO_TRACK_TYPE)) {
        continue;
      }

      let number = 0;
      let type = 0;
      let codecId = '';
      let video = null;
      let audio = null;
      let codecPrivate = null;
      for (const element of this._children(bytes, entry)) {
        if (element.id === ID.TRACK_NUMBER) {
          number = this._readUnsigned(bytes, element);
        } else if (element.id === ID.TRACK_TYPE) {
          type = this._readUnsigned(bytes, element);
        } else if (element.id === ID.CODEC_ID) {
          codecId = this._readString(bytes, element);
        } else if (element.id === ID.CODEC_PRIVATE) {
          // 对 A_OPUS 来说通常是 OpusHead；这里只用于验证 WebM 轨道完整性。
          // 原始 Opus packet 送入 AudioDecoder 时不会把它作为 description 传入。
          codecPrivate = bytes.subarray(element.dataOffset, element.end);
        } else if (element.id === ID.VIDEO) {
          video = this._readVideoSettings(bytes, element);
        } else if (element.id === ID.AUDIO) {
          audio = this._readAudioSettings(bytes, element);
        }
      }

      if (type === VIDEO_TRACK_TYPE) {
        videoTracks.push({ number, codecId, ...video });
      } else if (type === AUDIO_TRACK_TYPE && audioTracks) {
        audioTracks.push({ number, codecId, codecPrivate, ...audio });
      }
    }

    if (videoTracks.length !== 1) {
      throw new Error(`Demo 只支持一个视频轨，当前为 ${videoTracks.length} 个。`);
    }

    const track = videoTracks[0];
    if (
      track.codecId !== 'V_VP9'
      || !track.number
      || !track.width
      || !track.height
      || track.width % 2 !== 0
    ) {
      throw new Error('视频轨必须是宽度可二等分的有效 VP9 轨道。');
    }

    if (audioTracks && audioTracks.length > 1) {
      throw new Error(`Demo 最多支持一个音频轨，当前为 ${audioTracks.length} 个。`);
    }
    const audioTrack = audioTracks?.[0] ?? null;
    if (
      audioTrack
      && (
        audioTrack.codecId !== 'A_OPUS'
        || !audioTrack.number
        || !audioTrack.sampleRate
        || !audioTrack.numberOfChannels
        || !audioTrack.codecPrivate?.length
      )
    ) {
      throw new Error('音频轨必须是带 CodecPrivate 的有效 Opus 轨道。');
    }
    return { videoTrack: track, audioTrack };
  }

  static _readVideoSettings(bytes, video) {
    let width = 0;
    let height = 0;
    for (const element of this._children(bytes, video)) {
      if (element.id === ID.PIXEL_WIDTH) {
        width = this._readUnsigned(bytes, element);
      } else if (element.id === ID.PIXEL_HEIGHT) {
        height = this._readUnsigned(bytes, element);
      }
    }
    return { width, height };
  }

  // Audio Element 里的采样率是 EBML Float，声道数是 EBML Unsigned Integer。
  static _readAudioSettings(bytes, audio) {
    let sampleRate = 0;
    let numberOfChannels = 0;
    for (const element of this._children(bytes, audio)) {
      if (element.id === ID.SAMPLING_FREQUENCY) {
        sampleRate = this._readFloat(bytes, element);
      } else if (element.id === ID.CHANNELS) {
        numberOfChannels = this._readUnsigned(bytes, element);
      }
    }
    return { sampleRate, numberOfChannels };
  }

  /**
   * Cluster Timecode 是簇的基准时间，Block 内保存有符号的相对时间。
   * 两者相加后再通过 TimecodeScale 转成 WebCodecs 使用的微秒。
   */
  static _readCluster(
    bytes,
    cluster,
    videoTrackNumber,
    audioTrackNumber,
    timecodeScaleNs
  ) {
    let timecodeElement = null;
    for (const element of this._children(bytes, cluster)) {
      if (element.id !== ID.CLUSTER_TIMECODE) continue;
      timecodeElement = element;
      break;
    }
    if (!timecodeElement) throw new Error('Cluster 缺少 Timecode。');
    const clusterTimecode = this._readUnsigned(bytes, timecodeElement);
    const frames = [];
    const audioChunks = audioTrackNumber ? [] : null;

    for (const element of this._children(bytes, cluster)) {
      if (element.id === ID.BLOCK_GROUP) {
        const blockElement = this._findBlock(bytes, element);
        const track = this._readVint(bytes, blockElement.dataOffset, false);
        if (track.value !== videoTrackNumber && track.value !== audioTrackNumber) continue;
        const group = this._readBlockGroup(bytes, element);
        const timestamp = this._toMicroseconds(
          clusterTimecode + group.relativeTimecode,
          timecodeScaleNs
        );
        const duration = group.durationTicks
          ? this._toMicroseconds(group.durationTicks, timecodeScaleNs)
          : 0;

        if (group.trackNumber === videoTrackNumber) {
          frames.push({
            timestamp,
            duration,
            data: group.data,
            type: this._frameType(group.data),
          });
        } else if (audioChunks && group.trackNumber === audioTrackNumber) {
          audioChunks.push(this._createAudioChunk(group, timestamp, duration));
        }
      } else if (element.id === ID.SIMPLE_BLOCK) {
        const track = this._readVint(bytes, element.dataOffset, false);
        if (track.value !== videoTrackNumber && track.value !== audioTrackNumber) continue;
        const block = this._readBlock(bytes, element);
        const timestamp = this._toMicroseconds(
          clusterTimecode + block.relativeTimecode,
          timecodeScaleNs
        );
        if (audioChunks && block.trackNumber === audioTrackNumber) {
          audioChunks.push(this._createAudioChunk(block, timestamp, 0));
        } else if (block.trackNumber === videoTrackNumber) {
          frames.push({
            timestamp,
            duration: 0,
            data: block.data,
            type: this._frameType(block.data),
          });
        }
      }
    }
    return { frames, audioChunks };
  }

  static _findBlock(bytes, blockGroup) {
    for (const element of this._children(bytes, blockGroup)) {
      if (element.id === ID.BLOCK) return element;
    }
    throw new Error('BlockGroup 缺少 Block。');
  }

  // 将 BlockGroup 还原成压缩块和可选 duration。
  static _readBlockGroup(bytes, blockGroup) {
    let block = null;
    let durationTicks = 0;
    for (const element of this._children(bytes, blockGroup)) {
      if (element.id === ID.BLOCK) {
        block = this._readBlock(bytes, element);
      } else if (element.id === ID.BLOCK_DURATION) {
        durationTicks = this._readUnsigned(bytes, element);
      }
    }
    if (!block) throw new Error('BlockGroup 缺少 Block。');
    return { ...block, durationTicks };
  }

  /**
   * Block 负载头：
   *
   * TrackNumber(VINT) + RelativeTimecode(int16) + Flags(uint8) + 压缩数据
   */
  static _readBlock(bytes, element) {
    const track = this._readVint(bytes, element.dataOffset, false);
    const headerSize = track.length + 3;
    if (element.size <= headerSize) throw new Error('WebM Block 数据不完整。');

    const view = new DataView(
      bytes.buffer,
      bytes.byteOffset + element.dataOffset,
      element.size
    );
    const relativeTimecode = view.getInt16(track.length, false);
    const flags = view.getUint8(track.length + 2);

    // Flags 的 1-2 位表示 Lacing；本 Demo 每个 Block 必须只有一帧。
    if ((flags & 0x06) !== 0) throw new Error('Demo 暂不支持 WebM Lacing。');
    return {
      trackNumber: track.value,
      relativeTimecode,
      data: bytes.subarray(element.dataOffset + headerSize, element.end),
    };
  }

  static _createAudioChunk(block, timestamp, duration) {
    return {
      // WebCodecs 规定 Opus EncodedAudioChunk 的 type 始终为 key。
      type: 'key',
      timestamp,
      duration,
      data: block.data,
    };
  }

  // Matroska tick × TimecodeScale(ns) ÷ 1000 = WebCodecs 使用的微秒。
  static _toMicroseconds(timecode, timecodeScaleNs) {
    return Math.round(timecode * timecodeScaleNs / 1000);
  }

  /**
   * IVF/WebM 都不直接为最后一帧提供可靠 duration。
   * 优先保留 BlockDuration，其余帧用下一帧时间戳之差，最后一帧使用中位数。
   */
  static _fillFrameDurations(frames) {
    this._fillChunkDurations(frames, FALLBACK_FRAME_DURATION_US);
  }

  /**
   * WebM 通常不给每个 SimpleBlock 写 BlockDuration，使用相邻时间戳补齐。
   * 最后一块没有“下一块”可参考，因此使用前面 duration 的中位数；中位数不会
   * 被偶发的大时间间隔明显拉偏。
   */
  static _fillChunkDurations(chunks, fallbackDurationUs) {
    if (!chunks.length) return;
    const durations = [];
    for (let index = 0; index < chunks.length - 1; index += 1) {
      chunks[index].duration ||= chunks[index + 1].timestamp - chunks[index].timestamp;
      if (chunks[index].duration > 0) durations.push(chunks[index].duration);
    }

    durations.sort((left, right) => left - right);
    if (!chunks.at(-1).duration) {
      chunks.at(-1).duration = durations.length
        ? durations[Math.floor(durations.length / 2)]
        : fallbackDurationUs;
    }
  }

  // 从 VP9 uncompressed header 判断关键帧，逻辑与原 IVF Demo 保持一致。
  static _frameType(data) {
    if (!data.length || (data[0] >> 6) !== 0b10) throw new Error('VP9 帧头无效。');
    const profile = ((data[0] >> 5) & 1) | (((data[0] >> 4) & 1) << 1);
    if (profile !== 0) throw new Error(`只支持 VP9 Profile 0，当前为 ${profile}。`);
    const showExistingFrame = (data[0] >> 3) & 1;
    return showExistingFrame === 0 && ((data[0] >> 2) & 1) === 0
      ? 'key'
      : 'delta';
  }

  // 遍历一个 Master Element 的直接子元素，不递归解释 Block 二进制内容。
  static *_children(bytes, parent) {
    let offset = parent.dataOffset;
    while (offset < parent.end) {
      const element = this._readElement(bytes, offset, parent.end);
      yield element;
      offset = element.end;
    }
  }

  /**
   * 读取一个 EBML Element 的公共头，但不解释 payload。
   * 返回的数据区间统一使用 [dataOffset, end)，便于 subarray() 零复制引用。
   */
  static _readElement(bytes, offset, limit) {
    const id = this._readVint(bytes, offset, true);
    const size = this._readVint(bytes, offset + id.length, false);
    const dataOffset = offset + id.length + size.length;
    const end = size.unknown ? limit : dataOffset + size.value;
    if (dataOffset > limit || end > limit || end <= offset) {
      throw new Error(`WebM Element 0x${id.value.toString(16)} 越界。`);
    }
    return {
      id: id.value,
      size: end - dataOffset,
      dataOffset,
      end,
    };
  }

  /**
   * 读取 EBML Variable-Size Integer。
   *
   * Element ID 保留首字节的长度标记；Element Size 和 TrackNumber 清除标记。
   * 使用 BigInt 只是为了安全识别 8 字节的“未知长度”，最终文件偏移仍为 Number。
   */
  static _readVint(bytes, offset, preserveMarker) {
    const first = bytes[offset];
    if (first === undefined || first === 0) throw new Error('EBML VINT 无效。');

    let marker = 0x80;
    let length = 1;
    while (!(first & marker) && length <= 8) {
      marker >>= 1;
      length += 1;
    }
    if (length > 8 || offset + length > bytes.length) {
      throw new Error('EBML VINT 数据不完整。');
    }

    let value = BigInt(preserveMarker ? first : first & (marker - 1));
    for (let index = 1; index < length; index += 1) {
      value = (value << 8n) | BigInt(bytes[offset + index]);
    }

    const unknownValue = (1n << BigInt(7 * length)) - 1n;
    const unknown = !preserveMarker && value === unknownValue;
    if (!unknown && value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error('EBML VINT 超出 JavaScript 安全整数范围。');
    }
    return { length, value: unknown ? 0 : Number(value), unknown };
  }

  static _readUnsigned(bytes, element) {
    if (element.size < 1 || element.size > 8) throw new Error('WebM 无符号整数长度无效。');
    let value = 0n;
    for (let offset = element.dataOffset; offset < element.end; offset += 1) {
      value = (value << 8n) | BigInt(bytes[offset]);
    }
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error('WebM 整数超出 JavaScript 安全范围。');
    }
    return Number(value);
  }

  // EBML Float 只允许 4 字节单精度或 8 字节双精度，并使用大端序。
  static _readFloat(bytes, element) {
    const view = new DataView(
      bytes.buffer,
      bytes.byteOffset + element.dataOffset,
      element.size
    );
    if (element.size === 4) return view.getFloat32(0, false);
    if (element.size === 8) return view.getFloat64(0, false);
    throw new Error('WebM 浮点数长度无效。');
  }

  static _readString(bytes, element) {
    return new TextDecoder().decode(
      bytes.subarray(element.dataOffset, element.end)
    );
  }
}
