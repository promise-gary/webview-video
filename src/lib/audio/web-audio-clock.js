/**
 * 增量 Opus → PCM → Web Audio 时钟。
 *
 * PCM 只存在内存中：既能在网络仍下载时先播放，也能在暂停恢复或重新播放时复用。
 */
export class WebAudioClock {
  constructor(stream, { onBufferChange = () => {}, onError = () => {} } = {}) {
    this.stream = stream;
    this.onBufferChange = onBufferChange;
    this.onError = onError;
    this.audioContext = null;
    this.decoder = null;
    this.blocks = [];
    this.sources = new Set();
    this.inputEnded = false;
    this.complete = false;
    this.durationUs = 0;
    this.pausedTimeUs = 0;
    this.mediaStartUs = 0;
    this.contextStartTime = 0;
    this.scheduledUntilUs = 0;
    this.playing = false;
    this.disposed = false;
  }

  /** 配置 Decoder 和 AudioContext；不会触发声音，真正 resume() 在 playFrom()。 */
  async initialize() {
    if (!('AudioDecoder' in window) || !('EncodedAudioChunk' in window)) {
      throw new Error('当前环境不支持 AudioDecoder。');
    }
    const AudioContextConstructor = window.AudioContext ?? window.webkitAudioContext;
    if (!AudioContextConstructor) throw new Error('当前环境不支持 Web Audio。');

    const support = await AudioDecoder.isConfigSupported({
      codec: this.stream.codec,
      sampleRate: this.stream.sampleRate,
      numberOfChannels: this.stream.numberOfChannels,
    });
    if (!support.supported) throw new Error(`当前环境不支持音频编码 ${this.stream.codec}。`);

    this.audioContext = new AudioContextConstructor();
    this.decoder = new AudioDecoder({
      output: (audioData) => this._acceptAudioData(audioData),
      error: (error) => this.onError(error),
    });
    this.decoder.configure(support.config);
  }

  /** 每个 WebM Opus packet 到达后立即送入 AudioDecoder。 */
  append(chunk) {
    if (!this.decoder || this.inputEnded || this.disposed) return;
    this.decoder.decode(new EncodedAudioChunk({
      type: chunk.type,
      timestamp: chunk.timestamp,
      duration: chunk.duration,
      data: chunk.data,
    }));
  }

  /** 输入结束时 flush 最后几个 Opus packet，并确定完整音频时长。 */
  async end() {
    if (!this.decoder || this.inputEnded) return;
    this.inputEnded = true;
    await this.decoder.flush();
    this._closeDecoder();
    this.blocks.sort((left, right) => left.timestamp - right.timestamp);
    this.durationUs = this.bufferedEndUs;
    this.complete = true;
    this.onBufferChange();
  }

  get bufferedEndUs() {
    const last = this.blocks.at(-1);
    return last ? last.timestamp + last.duration : 0;
  }

  /** 完整输入结束后已有全部 PCM；下载期间只允许读取已经解码到的时间范围。 */
  hasBufferedThrough(timestampUs) {
    return Boolean(this.blocks.length) && (this.complete || this.bufferedEndUs >= timestampUs);
  }

  get currentTimeUs() {
    if (!this.playing || !this.audioContext) return this.pausedTimeUs;
    const timestampUs = this._currentAbsoluteTimeUs();
    return this.complete && this.durationUs
      ? Math.min(timestampUs, this.durationUs)
      : timestampUs;
  }

  /** 从指定媒体时间开始排程约 1 秒 PCM；AudioContext 是视频的主时钟。 */
  async playFrom(timestampUs) {
    if (!this.audioContext || !this.blocks.length || this.disposed) {
      throw new Error('音频缓冲尚未就绪。');
    }
    await this.audioContext.resume();
    if (this.disposed) return;

    this._stopSources();
    this.pausedTimeUs = this.complete
      ? Math.min(Math.max(timestampUs, 0), this.durationUs)
      : Math.max(timestampUs, 0);
    this.mediaStartUs = this.pausedTimeUs;
    this.contextStartTime = this.audioContext.currentTime;
    this.scheduledUntilUs = this.mediaStartUs;
    this.playing = true;
    this.schedule();
  }

  /** rAF 中持续调用，始终让扬声器前方保留约 1 秒已排程 PCM。 */
  schedule() {
    if (!this.playing || !this.audioContext || !this.blocks.length) return;
    const currentUs = this._currentAbsoluteTimeUs();
    const targetUs = this.complete
      ? Math.min(currentUs + 1_000_000, this.durationUs)
      : currentUs + 1_000_000;
    if (this.scheduledUntilUs < currentUs) this.scheduledUntilUs = currentUs;

    while (this.scheduledUntilUs < targetUs) {
      const positionUs = this.scheduledUntilUs;
      const block = this.blocks.find((candidate) => (
        candidate.timestamp <= positionUs
        && positionUs < candidate.timestamp + candidate.duration
      ));
      if (!block) return;

      const offsetUs = positionUs - block.timestamp;
      const playableUs = block.duration - offsetUs;
      const source = this.audioContext.createBufferSource();
      source.buffer = this._getAudioBuffer(block);
      source.connect(this.audioContext.destination);
      source.onended = () => {
        source.disconnect();
        this.sources.delete(source);
      };
      source.start(
        this.contextStartTime + (this.scheduledUntilUs - this.mediaStartUs) / 1_000_000,
        offsetUs / 1_000_000,
        playableUs / 1_000_000
      );
      this.sources.add(source);
      this.scheduledUntilUs += playableUs;
    }
  }

  pause() {
    this.pausedTimeUs = this.currentTimeUs;
    this.playing = false;
    this._stopSources();
    return this.pausedTimeUs;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.pause();
    this._closeDecoder();
    this.blocks = [];
    if (this.audioContext && this.audioContext.state !== 'closed') void this.audioContext.close();
    this.audioContext = null;
  }

  _acceptAudioData(audioData) {
    if (this.disposed) {
      audioData.close();
      return;
    }
    try {
      if (audioData.numberOfChannels !== this.stream.numberOfChannels) {
        throw new Error(`AudioDecoder 输出声道数异常：${audioData.numberOfChannels}。`);
      }
      const planes = [];
      for (let channel = 0; channel < audioData.numberOfChannels; channel += 1) {
        const samples = new Float32Array(audioData.numberOfFrames);
        audioData.copyTo(samples, { planeIndex: channel, format: 'f32-planar' });
        planes.push(samples);
      }
      this.blocks.push({
        timestamp: audioData.timestamp,
        duration: Math.round(audioData.numberOfFrames * 1_000_000 / audioData.sampleRate),
        planes,
        audioBuffer: null,
      });
      this.blocks.sort((left, right) => left.timestamp - right.timestamp);
      this.onBufferChange();
    } catch (error) {
      this.onError(error);
    } finally {
      audioData.close();
    }
  }

  _getAudioBuffer(block) {
    if (block.audioBuffer) return block.audioBuffer;
    const buffer = this.audioContext.createBuffer(
      this.stream.numberOfChannels,
      block.planes[0].length,
      this.stream.sampleRate
    );
    for (let channel = 0; channel < block.planes.length; channel += 1) {
      buffer.copyToChannel(block.planes[channel], channel);
    }
    block.audioBuffer = buffer;
    return buffer;
  }

  _currentAbsoluteTimeUs() {
    return this.mediaStartUs + Math.round(
      (this.audioContext.currentTime - this.contextStartTime) * 1_000_000
    );
  }

  _stopSources() {
    for (const source of this.sources) {
      source.onended = null;
      source.disconnect();
      try {
        source.stop();
      } catch {
        // 已自然播放完的 AudioBufferSourceNode 不能再次 stop()。
      }
    }
    this.sources.clear();
  }

  _closeDecoder() {
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
    this.decoder = null;
  }
}
