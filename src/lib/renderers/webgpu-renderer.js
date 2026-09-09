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
  static async create(canvas) {
    if (!navigator.gpu) throw new Error('WebGPU 不可用。');

    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('无法获取 WebGPU Adapter。');

    const device = await adapter.requestDevice();

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
        device.createSampler({ magFilter: 'linear', minFilter: 'linear' })
      );
    } catch (error) {
      // 初始化中途失败时主动销毁 Device，再由 Factory 创建 WebGL。
      device.destroy();
      throw error;
    }
  }

  constructor(canvas, device, context, pipeline, sampler) {
    this.canvas = canvas;
    this.device = device;
    this.context = context;
    this.pipeline = pipeline;
    this.bindGroupLayout = pipeline.getBindGroupLayout(0);
    this.sampler = sampler;
    this.name = 'WebGPU';
    this.destroyed = false;
  }

  /**
   * 渲染一对 VideoFrame。
   *
   * Promise 只有在 GPU 已完成本次之前提交的工作后才结束。Player 会等待
   * Promise settle 后关闭 VideoFrame，保证外部纹理使用期间源帧仍然有效。
   */
  async render(pair) {
    if (this.destroyed) throw new Error('WebGPU Renderer 已释放。');
    const device = this.device;

    /**
     * GPUExternalTexture 是 VideoFrame 的临时 GPU 视图，而不是永久纹理。
     * 它的生命周期受源 VideoFrame 约束，因此每一帧都需要重新导入。
     */
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

    // Player 在该 Promise 完成后 close Color/Alpha VideoFrame。
    await device.queue.onSubmittedWorkDone();
  }

  // Device 是该 Renderer 创建的最终 GPU 资源，销毁它会释放其子资源。
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    if (typeof this.context.unconfigure === 'function') this.context.unconfigure();
    this.device.destroy();
  }
}
