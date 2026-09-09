/**
 * WebGL 兼容渲染后端。
 *
 * 输入和 WebGPU Renderer 相同：一张左侧 RGB、右侧 Alpha 的 VideoFrame。
 * 这里通过 texSubImage2D() 更新一张预分配纹理，再用 Fragment Shader 合成。
 */
export class WebGlRenderer {
  /**
   * WebGL 是本 Demo 的最终回退层。
   * premultipliedAlpha=false 表示 Shader 输出未经预乘的 RGB + Alpha。
   */
  static create(canvas) {
    const gl = canvas.getContext('webgl', {
      alpha: true,
      antialias: false,
      premultipliedAlpha: false,
    });
    if (!gl) throw new Error('WebGL 不可用。');
    return new WebGlRenderer(canvas, gl);
  }

  // 构造阶段创建并缓存所有可以跨帧复用的 WebGL 资源。
  constructor(canvas, gl) {
    this.canvas = canvas;
    this.gl = gl;
    this.name = 'WebGL';
    this.program = this._createProgram();
    this.buffer = this._createBuffer();
    this.packedTexture = this._createTexture(gl.TEXTURE0, canvas.width * 2, canvas.height);
    this.destroyed = false;

    gl.useProgram(this.program);
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_packed'), 0);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.clearColor(0, 0, 0, 0);
  }

  /**
   * 把一张 VideoFrame 上传为纹理并绘制。
   *
   * texSubImage2D() 可能触发像素格式转换或纹理复制，但不会每帧重新分配
   * 纹理存储，且兼容性通常比
   * WebGPU importExternalTexture() 更广。该方法完成后 Player 即可关闭帧。
   */
  async render(frame) {
    if (this.destroyed) throw new Error('WebGL Renderer 已释放。');
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);

    // 这是 WebGL/GPU 清理命令，不是 Canvas 2D 的 clearRect()。
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.program);

    this._uploadFrame(gl.TEXTURE0, this.packedTexture, frame);

    // 六个顶点组成两个三角形，Fragment Shader 会覆盖完整 Canvas。
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  _uploadFrame(unit, texture, frame) {
    const gl = this.gl;
    gl.activeTexture(unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      frame
    );
  }

  // 显式删除由本 Renderer 创建的 WebGL 对象。
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    const gl = this.gl;
    gl.finish();
    gl.deleteTexture(this.packedTexture);
    gl.deleteBuffer(this.buffer);
    gl.deleteProgram(this.program);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }

  /**
   * 创建合成程序：
   *
   * Vertex Shader 负责位置和纹理坐标；
   * Fragment Shader 分别采样左右半边，并取右半边 red 通道作为透明度。
   */
  _createProgram() {
    const gl = this.gl;
    const vertexShader = this._compile(gl.VERTEX_SHADER, `
      attribute vec2 a_position;
      attribute vec2 a_texCoord;
      varying vec2 v_texCoord;

      void main() {
        gl_Position = vec4(a_position, 0.0, 1.0);
        v_texCoord = a_texCoord;
      }
    `);
    const fragmentShader = this._compile(gl.FRAGMENT_SHADER, `
      precision mediump float;
      uniform sampler2D u_packed;
      varying vec2 v_texCoord;

      void main() {
        vec2 colorCoord = vec2(v_texCoord.x * 0.5, v_texCoord.y);
        vec2 alphaCoord = vec2(0.5 + v_texCoord.x * 0.5, v_texCoord.y);
        vec3 color = texture2D(u_packed, colorCoord).rgb;
        float alpha = texture2D(u_packed, alphaCoord).r;

        // Context 配置 premultipliedAlpha=false，因此这里输出 straight alpha。
        gl_FragColor = vec4(color, alpha);
      }
    `);
    const program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`WebGL Program 创建失败：${gl.getProgramInfoLog(program)}`);
    }
    return program;
  }

  // Shader 编译失败时立刻抛错，让 Factory/Player 进入统一错误处理。
  _compile(type, source) {
    const gl = this.gl;
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(`WebGL Shader 创建失败：${gl.getShaderInfoLog(shader)}`);
    }
    return shader;
  }

  /**
   * 顶点数据每项包含四个 float：
   * [position.x, position.y, texCoord.x, texCoord.y]
   */
  _createBuffer() {
    const gl = this.gl;
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1, 0, 0,
       1, -1, 1, 0,
      -1,  1, 0, 1,
      -1,  1, 0, 1,
       1, -1, 1, 0,
       1,  1, 1, 1,
    ]), gl.STATIC_DRAW);

    const stride = 4 * Float32Array.BYTES_PER_ELEMENT;
    const position = gl.getAttribLocation(this.program, 'a_position');
    const textureCoordinate = gl.getAttribLocation(this.program, 'a_texCoord');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(textureCoordinate);
    gl.vertexAttribPointer(
      textureCoordinate,
      2,
      gl.FLOAT,
      false,
      stride,
      2 * Float32Array.BYTES_PER_ELEMENT
    );
    return buffer;
  }

  // 拼接纹理只分配一次；每帧通过 texSubImage2D() 更新其内容。
  _createTexture(unit, width, height) {
    const gl = this.gl;
    const texture = gl.createTexture();
    gl.activeTexture(unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      width,
      height,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null
    );
    return texture;
  }
}
