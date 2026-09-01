const DEFAULT_PLAYER_OPTIONS = {
  startupBufferMs: 500,
  resumeBufferMs: 300,
  audioEnabled: true,
  webGpuEnabled: true,
};

/** 解析播放器页面 URL 参数。 */
export class PlayerPageConfig {
  static fromUrl(url) {
    const pageUrl = new URL(url);
    const parameters = pageUrl.searchParams;
    const sourceUrl = parameters.get('src')?.trim();
    if (!sourceUrl) throw new Error('缺少必填参数 src。');

    return {
      debugEnabled: this._readBoolean(parameters, 'debug', false),
      playerOptions: {
        sourceUrl: new URL(sourceUrl, pageUrl).href,
        startupBufferMs: this._readNonNegativeInteger(
          parameters,
          'startupBufferMs',
          DEFAULT_PLAYER_OPTIONS.startupBufferMs
        ),
        resumeBufferMs: this._readNonNegativeInteger(
          parameters,
          'resumeBufferMs',
          DEFAULT_PLAYER_OPTIONS.resumeBufferMs
        ),
        audioEnabled: this._readBoolean(
          parameters,
          'audioEnabled',
          DEFAULT_PLAYER_OPTIONS.audioEnabled
        ),
        webGpuEnabled: this._readBoolean(
          parameters,
          'webGpuEnabled',
          DEFAULT_PLAYER_OPTIONS.webGpuEnabled
        ),
      },
    };
  }

  static _readBoolean(parameters, name, defaultValue) {
    const value = parameters.get(name);
    return value === 'true' || value === 'false' ? value === 'true' : defaultValue;
  }

  static _readNonNegativeInteger(parameters, name, defaultValue) {
    const value = parameters.get(name);
    const number = Number(value);
    return value !== null && value !== '' && Number.isSafeInteger(number) && number >= 0
      ? number
      : defaultValue;
  }
}
