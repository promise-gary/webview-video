const DEFAULT_PLAYER_OPTIONS = {
  audioEnabled: false,
  webGpuEnabled: true,
};

/** 解析宿主通过 Bridge 传入的播放器配置。 */
export class PlayerPageConfig {
  static fromInput(input = {}) {
    const values = input && typeof input === 'object' ? input : {};

    return {
      debugEnabled: this._readBoolean(values, 'debug', false),
      playerOptions: {
        audioEnabled: this._readBoolean(
          values,
          'audioEnabled',
          DEFAULT_PLAYER_OPTIONS.audioEnabled
        ),
        webGpuEnabled: this._readBoolean(
          values,
          'webGpuEnabled',
          DEFAULT_PLAYER_OPTIONS.webGpuEnabled
        ),
      },
    };
  }

  static _readBoolean(values, name, defaultValue) {
    const value = values[name];
    return typeof value === 'boolean' ? value : defaultValue;
  }
}
