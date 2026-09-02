/** 完整 Opus 音轨 → PCM → Web Audio 播放时钟。 */
export class WebAudioClock {
  constructor(stream, { onError = () => {} } = {}) {
    this.stream = stream;
    this.onError = onError;
    this.audioContext = null;
    this.decoder = null;
    this.blocks = [];
    this.sources = new Set();
    this.inputEnded = false;
    this.durationUs = 0;
    this.contextStartTime = 0;
    this.scheduledUntilUs = 0;
    this.playing = false;
    this.disposed = false;
  }

  /** 配置 Decoder 和 AudioContext；不会触发声音，真正 resume() 在 start()。 */
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

  /** 把完整音轨中的一个 WebM Opus packet 送入 AudioDecoder。 */
  append(chunk) {
    if (!this.decoder || this.inputEnded || this.disposed) return;
    this.decoder.decode(new EncodedAudioChunk({
      type: chunk.type,
      timestamp: chunk.timestamp,
      duration: chunk.duration,
      data: chunk.data,
    }));
  }

  /** 所有 packet 提交后 flush，并确定完整音频时长。 */
  async end() {
    if (!this.decoder || this.inputEnded) return;
    this.inputEnded = true;
    await this.decoder.flush();
    this._closeDecoder();
    this.blocks.sort((left, right) => left.timestamp - right.timestamp);
    this.durationUs = this.decodedEndUs;
  }

  get decodedEndUs() {
    const last = this.blocks.at(-1);
    return last ? last.timestamp + last.duration : 0;
  }

  get currentTimeUs() {
    if (!this.playing || !this.audioContext) return 0;
    const timestampUs = this._currentAbsoluteTimeUs();
    return this.durationUs ? Math.min(timestampUs, this.durationUs) : timestampUs;
  }

  /** 从 0 开始一次性播放，AudioContext 同时作为视频主时钟。 */
  async start() {
    if (!this.audioContext || !this.blocks.length || this.disposed) {
      throw new Error('完整音频数据尚未就绪。');
    }
    await this.audioContext.resume();
    if (this.disposed) return;

    this._stopSources();
    this.contextStartTime = this.audioContext.currentTime;
    this.scheduledUntilUs = 0;
    this.playing = true;
    this.schedule();
  }

  /** rAF 中持续调用，始终让扬声器前方保留约 1 秒已排程 PCM。 */
  schedule() {
    if (!this.playing || !this.audioContext || !this.blocks.length) return;
    const currentUs = this._currentAbsoluteTimeUs();
    const targetUs = Math.min(currentUs + 1_000_000, this.durationUs);
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
        this.contextStartTime + this.scheduledUntilUs / 1_000_000,
        offsetUs / 1_000_000,
        playableUs / 1_000_000
      );
      this.sources.add(source);
      this.scheduledUntilUs += playableUs;
    }
  }

  /** 只用于自然结束、错误和 dispose，不保留恢复播放位置。 */
  stop() {
    this.playing = false;
    this._stopSources();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
    this._closeDecoder();
    this.blocks = [];
    if (this.audioContext && this.audioContext.state !== 'closed') void this.audioContext.close();
    this.audioContext = null;
    // stream 可能持有 CodecPrivate 的 Uint8Array 视图，必须随媒体一起断开引用。
    this.stream = null;
    this.onError = () => {};
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
    return Math.round((this.audioContext.currentTime - this.contextStartTime) * 1_000_000);
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
