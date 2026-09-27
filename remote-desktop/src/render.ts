// Draws decoded pictures on the viewer's canvas: a 2D context for WebCodecs
// VideoFrames, or a WebGL2 program converting the software decoder's I420
// planes on the GPU. One canvas holds one context type, so the mode is
// fixed when the renderer is created.
import type { DecodedPicture } from "./decoder";

export type RenderMode = "2d" | "webgl";

const VERTEX = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = vec2((aPos.x + 1.0) * 0.5, (1.0 - aPos.y) * 0.5);
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

// Full-range BT.601, matching the server's BGRX to I420 conversion.
const FRAGMENT = `#version 300 es
precision mediump float;
in vec2 vUv;
uniform sampler2D uY;
uniform sampler2D uU;
uniform sampler2D uV;
uniform vec2 uCrop;
out vec4 outColor;
void main() {
  vec2 uv = vUv * uCrop;
  float y = texture(uY, uv).r;
  float u = texture(uU, uv).r - 0.5;
  float v = texture(uV, uv).r - 0.5;
  float r = y + 1.402 * v;
  float g = y - 0.344136 * u - 0.714136 * v;
  float b = y + 1.772 * u;
  outColor = vec4(r, g, b, 1.0);
}`;

export class Renderer {
  private ctx2d: CanvasRenderingContext2D | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private textures: WebGLTexture[] = [];
  private cropLocation: WebGLUniformLocation | null = null;
  private planeSize = { width: 0, height: 0 };

  constructor(
    private readonly canvas: HTMLCanvasElement,
    readonly mode: RenderMode,
  ) {
    if (mode === "2d") {
      this.ctx2d = canvas.getContext("2d", { alpha: false, desynchronized: true });
    } else {
      // Tiles are drawn one at a time into their own viewport, so the
      // buffer must keep what the other tiles drew.
      this.gl = canvas.getContext("webgl2", { alpha: false, desynchronized: true, antialias: false, preserveDrawingBuffer: true });
      if (this.gl) this.setupGl(this.gl);
    }
  }

  get ready(): boolean {
    return this.ctx2d !== null || this.gl !== null;
  }

  /** The whole frame's size; tiles are drawn at their offsets inside it. */
  setSize(width: number, height: number): void {
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
  }

  draw(picture: DecodedPicture): void {
    const { rect } = picture;
    if (picture.kind === "video") {
      const frame = picture.frame;
      try {
        this.ctx2d?.drawImage(frame, rect.x, rect.y);
      } finally {
        frame.close();
      }
      return;
    }
    if (!this.gl) return;
    // WebGL's origin is bottom-left.
    this.gl.viewport(rect.x, this.canvas.height - rect.y - picture.height, picture.width, picture.height);
    this.drawI420(this.gl, picture);
  }

  private setupGl(gl: WebGL2RenderingContext): void {
    const compile = (type: number, src: string) => {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, src);
      gl.compileShader(shader);
      return shader;
    };
    const program = gl.createProgram()!;
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(program);
    gl.useProgram(program);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const pos = gl.getAttribLocation(program, "aPos");
    gl.enableVertexAttribArray(pos);
    gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);
    for (const [i, name] of ["uY", "uU", "uV"].entries()) {
      const tex = gl.createTexture()!;
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.uniform1i(gl.getUniformLocation(program, name), i);
      this.textures.push(tex);
    }
    this.cropLocation = gl.getUniformLocation(program, "uCrop");
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  }

  private drawI420(gl: WebGL2RenderingContext, pic: Extract<DecodedPicture, { kind: "i420" }>): void {
    const { codedWidth: w, codedHeight: h } = pic;
    const ySize = w * h;
    const cw = w >> 1;
    const ch = h >> 1;
    const planes: Array<[Uint8Array, number, number]> = [
      [pic.data.subarray(0, ySize), w, h],
      [pic.data.subarray(ySize, ySize + cw * ch), cw, ch],
      [pic.data.subarray(ySize + cw * ch, ySize + 2 * cw * ch), cw, ch],
    ];
    const sameSize = this.planeSize.width === w && this.planeSize.height === h;
    planes.forEach(([data, pw, ph], i) => {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, this.textures[i]);
      if (sameSize) {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, pw, ph, gl.RED, gl.UNSIGNED_BYTE, data);
      } else {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, pw, ph, 0, gl.RED, gl.UNSIGNED_BYTE, data);
      }
    });
    this.planeSize = { width: w, height: h };
    gl.uniform2f(this.cropLocation, pic.width / w, pic.height / h);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}
