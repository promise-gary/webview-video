/**
 * Renderer 选择器。
 *
 * 业务降级链只有两级：
 *
 * VideoDecoder + WebGPU
 *          ↓ 初始化失败
 * VideoDecoder + WebGL
 *
 * RendererFactory 不负责 VideoDecoder 能力检查，那是播放器的职责。
 */
import { WebGlRenderer } from './webgl-renderer.js';
import { WebGpuRenderer } from './webgpu-renderer.js';

export class RendererFactory {
  /**
   * webGpuEnabled=true 时优先创建 WebGPU Renderer，失败后创建 WebGL；
   * webGpuEnabled=false 时主动跳过 WebGPU，直接创建 WebGL Renderer。
   *
   * @param {HTMLCanvasElement} canvas 页面原始 Canvas。
   * @param {{ webGpuEnabled?: boolean }} options 渲染后端开关。
   * @returns {Promise<WebGpuRenderer | WebGlRenderer>}
   */
  static async create(canvas, { webGpuEnabled = true } = {}) {
    let webGpuError = null;

    if (webGpuEnabled && navigator.gpu) {
      try {
        return await WebGpuRenderer.create(canvas);
      } catch (error) {
        webGpuError = error;
        console.warn('WebGPU 初始化失败，切换到 WebGL。', error);

        /**
         * 一个 Canvas 一旦成功调用 getContext('webgpu')，就不能再对同一个
         * Canvas 获取 webgl context。WebGPU 可能在创建 context 之后、创建
         * Pipeline 时才失败，因此回退时必须用全新的 Canvas。
         */
        canvas = this._replaceCanvas(canvas);
      }
    } else if (webGpuEnabled) {
      webGpuError = new Error('navigator.gpu 不存在');
    }

    try {
      const renderer = WebGlRenderer.create(canvas);

      /**
       * 只有“尝试过 WebGPU 但失败”才属于降级。
       * 主动关闭 WebGPU 时直接选择 WebGL，不应向 UI 报告失败。
       */
      renderer.fallbackReason = webGpuEnabled
        ? webGpuError?.message ?? ''
        : '';
      return renderer;
    } catch (webGlError) {
      const webGpuMessage = webGpuEnabled
        ? webGpuError?.message ?? '当前环境没有 WebGPU'
        : '已通过配置关闭';

      // 不再提供 <video> 或 Canvas 2D 第三层降级，两者都失败时直接结束。
      throw new Error(
        `WebGPU 不可用：${webGpuMessage}；WebGL 不可用：${webGlError.message}`
      );
    }
  }

  // cloneNode 会保留 id、width、height 等属性，但不会复制旧 Canvas Context。
  static _replaceCanvas(canvas) {
    const replacement = canvas.cloneNode(false);
    canvas.replaceWith(replacement);
    return replacement;
  }
}
