/**
 * WebGPU 渲染后端。
 *
 * 它不负责解码，也不拥有播放队列。输入是一对已经按 timestamp 配对的
 * VideoFrame，输出是带透明通道的 WebGPU Canvas。
 *
 * 与 WebGL 版的核心区别：
 * - WebGL 使用 texImage2D(VideoFrame) 更新普通纹理；
 * - WebGPU 使用 importExternalTexture(VideoFrame) 导入外部纹理。
 */
export class WebGpuRenderer {
  /**
   * 异步创建 Adapter、Device、Canvas Context 和 RenderPipeline。
   * 任意步骤失败都会抛出，由 RendererFactory 尝试 WebGL。
   */
  static async create(canvas, { diagnostics }) {
    if (!navigator.gpu) throw new Error('WebGPU 不可用。');

    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('无法获取 WebGPU Adapter。');
    diagnostics.info('webgpu.adapter.ready', {
      maxTextureDimension2D: adapter.limits.maxTextureDimension2D,
    });

    const device = await adapter.requestDevice();
    diagnostics.info('webgpu.device.ready', {
      maxTextureDimension2D: device.limits.maxTextureDimension2D,
    });

    // 当前方案必须直接采样 VideoFrame，因此不能只检查 navigator.gpu。
    if (typeof device.importExternalTexture !== 'function') {
      device.destroy();
      throw new Error('WebGPU 不支持 VideoFrame 外部纹理。');
    }

    try {
      const context = canvas.getContext('webgpu');
      if (!context) throw new Error('无法创建 WebGPU Canvas Context。');
      const format = navigator.gpu.getPreferredCanvasFormat();

      /**
       * Shader 输出预乘颜色 color.rgb * alpha，所以 Canvas 也配置为
       * premultiplied，避免浏览器合成 Canvas 时再次错误处理透明颜色。
       */
      context.configure({ device, format, alphaMode: 'premultiplied' });
      diagnostics.info('webgpu.context.configured', { format });

      const module = device.createShaderModule({
        code: `
          // binding 0 是公共采样器，binding 1/2 分别是颜色和 Alpha 帧。
          @group(0) @binding(0) var frameSampler: sampler;
          @group(0) @binding(1) var colorFrame: texture_external;
          @group(0) @binding(2) var alphaFrame: texture_external;

          struct VertexOutput {
            @builtin(position) position: vec4f,
            @location(0) texCoord: vec2f,
          };

          @vertex
          fn vertexMain(@builtin(vertex_index) index: u32) -> VertexOutput {
            // 六个顶点组成两个三角形，完整覆盖 Canvas。
            let positions = array<vec2f, 6>(
              vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
              vec2f(-1.0,  1.0), vec2f(1.0, -1.0), vec2f( 1.0, 1.0)
            );

            // WebGPU 纹理坐标原点和最终显示方向在这里一次性匹配。
            let coordinates = array<vec2f, 6>(
              vec2f(0.0, 1.0), vec2f(1.0, 1.0), vec2f(0.0, 0.0),
              vec2f(0.0, 0.0), vec2f(1.0, 1.0), vec2f(1.0, 0.0)
            );
            var output: VertexOutput;
            output.position = vec4f(positions[index], 0.0, 1.0);
            output.texCoord = coordinates[index];
            return output;
          }

          @fragment
          fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
            // 外部纹理可能来自 YUV VideoFrame，浏览器负责采样时的颜色转换。
            let color = textureSampleBaseClampToEdge(
              colorFrame,
              frameSampler,
              input.texCoord
            );

            // Alpha 视频是灰度画面，取转换后颜色的 red 通道作为透明度。
            let alpha = textureSampleBaseClampToEdge(
              alphaFrame,
              frameSampler,
              input.texCoord
            ).r;

            // Canvas 使用 premultiplied alpha，因此 RGB 必须预先乘以 Alpha。
            return vec4f(color.rgb * alpha, alpha);
          }
        `,
      });
      const pipeline = await device.createRenderPipelineAsync({
        layout: 'auto',
        vertex: { module, entryPoint: 'vertexMain' },
        fragment: {
          module,
          entryPoint: 'fragmentMain',
          targets: [{ format }],
        },
        primitive: { topology: 'triangle-list' },
      });

      // Pipeline 和 Sampler 跨帧复用；每帧只创建与 VideoFrame 相关的资源。
      return new WebGpuRenderer(
        canvas,
        device,
        context,
        pipeline,
        device.createSampler({ magFilter: 'linear', minFilter: 'linear' }),
        format,
        diagnostics
      );
    } catch (error) {
      // 初始化中途失败时主动销毁 Device，再由 Factory 创建 WebGL。
      device.destroy();
      throw error;
    }
  }

  constructor(canvas, device, context, pipeline, sampler, format, diagnostics) {
    this.canvas = canvas;
    this.device = device;
    this.context = context;
    this.pipeline = pipeline;
    this.bindGroupLayout = pipeline.getBindGroupLayout(0);
    this.sampler = sampler;
    this.format = format;
    this.diagnostics = diagnostics;
    this.name = 'WebGPU';
    this.ownsFramePairs = true;
    this.destroyed = false;
    this.deviceLost = false;
    this.renderingFailed = false;
    this.pendingFramePairs = [];
    this.fenceCount = 0;
    this.totalFenceWaitMs = 0;
    this.maxFenceWaitMs = 0;
    this.lastFenceStatsLoggedAt = 0;

    device.lost.then((info) => {
      this.deviceLost = true;
      if (diagnostics.enabled) {
        const data = {
          reason: info.reason,
          message: info.message,
          intentionallyDestroyed: this.destroyed,
        };
        if (info.reason === 'destroyed') this.diagnostics.info('webgpu.device.lost', data);
        else this.diagnostics.error('webgpu.device.lost', new Error(info.message), data);
      }
    });
    if (diagnostics.enabled) {
      device.onuncapturederror = (event) => {
        this.diagnostics.error('webgpu.uncaptured-error', event.error);
      };
    }
  }

  get isAvailable() {
    return !this.destroyed && !this.deviceLost && !this.renderingFailed;
  }

  resize(width, height) {
    if (!this.isAvailable) throw new Error('WebGPU Renderer 不可用。');
    if (this.canvas.width === width && this.canvas.height === height) return;
    this.canvas.width = width;
    this.canvas.height = height;
    this.context.configure({
      device: this.device,
      format: this.format,
      alphaMode: 'premultiplied',
    });
    this.diagnostics.info('webgpu.canvas.resized', { canvasSize: [width, height] });
  }

  /**
   * 渲染一对 VideoFrame。
   *
   * 每两帧才等待一次 GPU 完成，避免每个 render pass 都让 CPU 与 GPU 同步。
   * Renderer 会持有输入帧，直到对应批次完成后再关闭，保证外部纹理有效。
   */
  async render(pair) {
    if (!this.isAvailable) throw new Error('WebGPU Renderer 不可用。');
    const device = this.device;

    /**
     * GPUExternalTexture 是 VideoFrame 的临时 GPU 视图，而不是永久纹理。
     * 它的生命周期受源 VideoFrame 约束，因此每一帧都需要重新导入。
     */
    try {
      const bindGroup = device.createBindGroup({
        layout: this.bindGroupLayout,
        entries: [
          { binding: 0, resource: this.sampler },
          {
            binding: 1,
            resource: device.importExternalTexture({ source: pair.color }),
          },
          {
            binding: 2,
            resource: device.importExternalTexture({ source: pair.alpha }),
          },
        ],
      });

      // CommandEncoder 用于记录本帧所有 GPU 命令。
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: this.context.getCurrentTexture().createView(),

          // 在 GPU RenderPass 中清成完全透明，不经过 Canvas 2D clearRect。
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: 'clear',
          storeOp: 'store',
        }],
      });
      pass.setPipeline(this.pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.draw(6);
      pass.end();
      device.queue.submit([encoder.finish()]);
    } catch (error) {
      this.renderingFailed = true;
      throw error;
    }

    this.pendingFramePairs.push(pair);
    if (this.pendingFramePairs.length < 2) return;
    await this.flush();
  }

  /** 播放器在首帧和结束时调用，确保最后不足两帧的提交也已安全完成。 */
  async flush() {
    if (!this.pendingFramePairs.length) return;
    const framePairs = this.pendingFramePairs;
    this.pendingFramePairs = [];
    const startedAt = performance.now();
    try {
      await this.device.queue.onSubmittedWorkDone();
    } catch (error) {
      this.renderingFailed = true;
      throw error;
    } finally {
      const waitMs = performance.now() - startedAt;
      this.fenceCount += 1;
      this.totalFenceWaitMs += waitMs;
      this.maxFenceWaitMs = Math.max(this.maxFenceWaitMs, waitMs);
      this._logFenceStats();
      for (const pair of framePairs) {
        pair.color.close();
        pair.alpha.close();
      }
    }
  }

  async clear() {
    if (!this.isAvailable) return;
    try {
      const encoder = this.device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: this.context.getCurrentTexture().createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: 'clear',
          storeOp: 'store',
        }],
      });
      pass.end();
      this.device.queue.submit([encoder.finish()]);
      await this.device.queue.onSubmittedWorkDone();
    } catch (error) {
      this.renderingFailed = true;
      throw error;
    }
  }

  // Device 是该 Renderer 创建的最终 GPU 资源，销毁它会释放其子资源。
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.diagnostics.info('webgpu.destroy.begin', {
      pendingFramePairs: this.pendingFramePairs.length,
      fenceCount: this.fenceCount,
      averageFenceWaitMs: this.fenceCount ? this.totalFenceWaitMs / this.fenceCount : 0,
      maxFenceWaitMs: this.maxFenceWaitMs,
    });
    if (typeof this.context.unconfigure === 'function') this.context.unconfigure();
    this.device.destroy();
    for (const pair of this.pendingFramePairs) {
      pair.color.close();
      pair.alpha.close();
    }
    this.pendingFramePairs = [];
    this.diagnostics.info('webgpu.destroy.complete');
  }

  _logFenceStats() {
    const now = performance.now();
    if (now - this.lastFenceStatsLoggedAt < 1_000) return;
    this.lastFenceStatsLoggedAt = now;
    this.diagnostics.info('webgpu.fence.stats', {
      fenceCount: this.fenceCount,
      averageWaitMs: this.totalFenceWaitMs / this.fenceCount,
      maxWaitMs: this.maxFenceWaitMs,
      pendingFramePairs: this.pendingFramePairs.length,
    });
  }
}
