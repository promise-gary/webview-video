/**
 * WebGL 兼容渲染后端。
 *
 * 输入和 WebGPU Renderer 相同：一对 Color/Alpha VideoFrame。
 * 区别是这里通过 texImage2D() 将 VideoFrame 内容更新到两张普通 WebGL
 * Texture，再用 GLSL Fragment Shader 合成最终 RGBA。
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
    this.colorTexture = this._createTexture(gl.TEXTURE0);
    this.alphaTexture = this._createTexture(gl.TEXTURE1);

    gl.useProgram(this.program);
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_color'), 0);
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_alpha'), 1);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.clearColor(0, 0, 0, 0);
  }

  /**
   * 把一对 VideoFrame 上传为两张纹理并绘制。
   *
   * texImage2D() 可能触发像素格式转换或纹理复制，但兼容性通常比
   * WebGPU importExternalTexture() 更广。该方法完成后 Player 即可关闭帧。
   */
  async render(pair) {
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);

    // 这是 WebGL/GPU 清理命令，不是 Canvas 2D 的 clearRect()。
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.program);

    // Texture Unit 0 保存当前颜色 VideoFrame。
    this._uploadFrame(gl.TEXTURE0, this.colorTexture, pair.color);

    // Texture Unit 1 保存当前灰度 Alpha VideoFrame。
    this._uploadFrame(gl.TEXTURE1, this.alphaTexture, pair.alpha);

    // 六个顶点组成两个三角形，Fragment Shader 会覆盖完整 Canvas。
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  _uploadFrame(unit, texture, frame) {
    const gl = this.gl;
    gl.activeTexture(unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);
  }

  // 显式删除由本 Renderer 创建的 WebGL 对象。
  destroy() {
    const gl = this.gl;
    gl.deleteTexture(this.colorTexture);
    gl.deleteTexture(this.alphaTexture);
    gl.deleteBuffer(this.buffer);
    gl.deleteProgram(this.program);
  }

  /**
   * 创建合成程序：
   *
   * Vertex Shader 负责位置和纹理坐标；
   * Fragment Shader 采样颜色 RGB，并取 Alpha 纹理 red 通道作为透明度。
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
      uniform sampler2D u_color;
      uniform sampler2D u_alpha;
      varying vec2 v_texCoord;

      void main() {
        vec3 color = texture2D(u_color, v_texCoord).rgb;
        float alpha = texture2D(u_alpha, v_texCoord).r;

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

  // 两张纹理只创建一次；每帧通过 texImage2D() 更新其内容。
  _createTexture(unit) {
    const gl = this.gl;
    const texture = gl.createTexture();
    gl.activeTexture(unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return texture;
  }
}
