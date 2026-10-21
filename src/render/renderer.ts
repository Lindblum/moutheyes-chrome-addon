// WebGL2 compositor: draws a tracked frame, then each face's mouth over both of its eyes. The
// mouth mask, skin gating and Lab conversion mirror src/shared/face.ts.
import { MAX_HULL, maskParams, type FaceGeom } from '../shared/face';

const FRAME_VS = `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  vUv = vec2(p.x, 1.0 - p.y); // the frame is uploaded top row first
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAME_FS = `#version 300 es
precision highp float;
uniform sampler2D uTex;
in vec2 vUv;
out vec4 o;
void main() { o = vec4(texture(uTex, vUv).rgb, 1.0); }`;

const EYE_VS = `#version 300 es
in vec2 aPos;
uniform vec2 uSize;
out vec2 vDest;
void main() {
  vDest = aPos;
  vec2 c = aPos / uSize * 2.0 - 1.0;
  gl_Position = vec4(c.x, -c.y, 0.0, 1.0);
}`;

const EYE_FS = `#version 300 es
precision highp float;
#define MAX_HULL ${MAX_HULL}
uniform sampler2D uTex;
uniform vec2 uSize;
uniform vec3 uInvX, uInvY;
uniform vec2 uHull[MAX_HULL];
uniform int uHullN;
uniform vec4 uMask; // core, pad, sigma, edge
uniform bool uSkinOn;
uniform vec2 uSkinAb;
uniform mat2 uSkinIcov;
uniform vec3 uSkinL; // lo, hi, margin
uniform vec3 uGain;
in vec2 vDest;
out vec4 o;

float sdPolygon(vec2 p) {
  float d = 1e20;
  float s = 1.0;
  for (int i = 0, j = uHullN - 1; i < uHullN; j = i, i++) {
    vec2 e = uHull[j] - uHull[i];
    vec2 w = p - uHull[i];
    vec2 b = w - e * clamp(dot(w, e) / max(dot(e, e), 1e-6), 0.0, 1.0);
    d = min(d, dot(b, b));
    bvec3 c = bvec3(p.y >= uHull[i].y, p.y < uHull[j].y, e.x * w.y > e.y * w.x);
    if (all(c) || all(not(c))) s = -s;
  }
  return s * sqrt(d);
}

float phi(float x) { return 0.5 * (1.0 + tanh(0.7978845608 * (x + 0.044715 * x * x * x))); }

float lin(float c) { return c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4); }
float lf(float t) { return t > 0.008856 ? pow(t, 1.0 / 3.0) : 7.787 * t + 16.0 / 116.0; }

// OpenCV 8-bit Lab scale: L 0..255, a/b offset by 128 (the offsets cancel out below).
vec3 lab(vec3 rgb) {
  vec3 l = vec3(lin(rgb.r), lin(rgb.g), lin(rgb.b));
  float X = dot(l, vec3(0.412453, 0.35758, 0.180423)) / 0.950456;
  float Y = dot(l, vec3(0.212671, 0.71516, 0.072169));
  float Z = dot(l, vec3(0.019334, 0.119193, 0.950227)) / 1.088754;
  float L = Y > 0.008856 ? 116.0 * pow(Y, 1.0 / 3.0) - 16.0 : 903.3 * Y;
  return vec3(L * 2.55, 500.0 * (lf(X) - lf(Y)) + 128.0, 200.0 * (lf(Y) - lf(Z)) + 128.0);
}

float skinProb(vec3 rgb) {
  vec3 c = lab(rgb);
  vec2 d = c.yz - uSkinAb;
  float dist = sqrt(max(0.0, dot(d, uSkinIcov * d)));
  float chroma = clamp((4.5 - dist) / 1.5, 0.0, 1.0);
  float off = max(uSkinL.x - c.x, c.x - uSkinL.y);
  return chroma * clamp(1.0 - off / uSkinL.z, 0.0, 1.0);
}

void main() {
  vec3 dp = vec3(vDest, 1.0);
  vec2 src = vec2(dot(uInvX, dp), dot(uInvY, dp));
  vec3 rgb = texture(uTex, src / uSize).rgb;
  float p = uSkinOn ? skinProb(rgb * 255.0) : 1.0;
  float d = sdPolygon(src);
  float e = min(min(src.x, src.y), min(uSize.x - src.x, uSize.y - src.y));
  float a = max(phi((uMask.x - d) / uMask.z), phi((uMask.y - d) / uMask.z) * p) * phi((e - uMask.w) / uMask.z);
  a = clamp((a - 0.04) / 0.96, 0.0, 1.0);
  if (a <= 0.0) discard;
  o = vec4(clamp(rgb * uGain, 0.0, 1.0), a);
}`;

export class TaintedVideoError extends Error {}

function compile(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const prog = gl.createProgram()!;
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]] as const) {
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(`shader: ${gl.getShaderInfoLog(sh)}`);
    gl.attachShader(prog, sh);
  }
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(`link: ${gl.getProgramInfoLog(prog)}`);
  return prog;
}

export class Renderer {
  private gl: WebGL2RenderingContext;
  private frameProg: WebGLProgram;
  private eyeProg: WebGLProgram;
  private tex: WebGLTexture;
  private quadBuf: WebGLBuffer;
  private vao: WebGLVertexArrayObject;
  private u: Record<string, WebGLUniformLocation | null> = {};
  private frameW = 0;
  private frameH = 0;

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: false });
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;
    this.frameProg = compile(gl, FRAME_VS, FRAME_FS);
    this.eyeProg = compile(gl, EYE_VS, EYE_FS);
    for (const name of ['uTex', 'uSize', 'uInvX', 'uInvY', 'uHull', 'uHullN', 'uMask', 'uSkinOn', 'uSkinAb', 'uSkinIcov', 'uSkinL', 'uGain']) {
      this.u[name] = gl.getUniformLocation(this.eyeProg, name);
    }
    this.tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    this.quadBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    const loc = gl.getAttribLocation(this.eyeProg, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  }

  get hasFrame(): boolean {
    return this.frameW > 0;
  }

  uploadFrame(bitmap: ImageBitmap) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
    } catch (e) {
      if (e instanceof DOMException && e.name === 'SecurityError') throw new TaintedVideoError('cross-origin video');
      throw e;
    }
    this.frameW = bitmap.width;
    this.frameH = bitmap.height;
  }

  /** content: where the picture sits in the canvas (x, y, w, h as fractions), honoring object-fit. */
  render(faces: FaceGeom[], content: [number, number, number, number]) {
    const gl = this.gl;
    const bw = gl.drawingBufferWidth;
    const bh = gl.drawingBufferHeight;
    gl.viewport(0, 0, bw, bh);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!this.hasFrame) return;
    const [cx, cy, cw, ch] = content;
    gl.viewport(Math.round(cx * bw), Math.round((1 - cy - ch) * bh), Math.round(cw * bw), Math.round(ch * bh));
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);

    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
    gl.useProgram(this.frameProg);
    gl.uniform1i(gl.getUniformLocation(this.frameProg, 'uTex'), 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (!faces.length) return;

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.eyeProg);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    const u = this.u;
    gl.uniform1i(u.uTex, 0);
    gl.uniform2f(u.uSize, this.frameW, this.frameH);
    for (const f of faces) {
      const hull = new Float32Array(MAX_HULL * 2);
      hull.set(f.hull.slice(0, MAX_HULL * 2));
      gl.uniform2fv(u.uHull, hull);
      gl.uniform1i(u.uHullN, f.hull.length / 2);
      const m = maskParams(f.mw);
      gl.uniform4f(u.uMask, m.core, m.pad, m.sigma, m.edge);
      gl.uniform1i(u.uSkinOn, f.skin ? 1 : 0);
      if (f.skin) {
        gl.uniform2f(u.uSkinAb, f.skin.ab[0], f.skin.ab[1]);
        // mat2 uniforms are column-major; icov is symmetric anyway.
        gl.uniformMatrix2fv(u.uSkinIcov, false, [f.skin.icov[0], f.skin.icov[2], f.skin.icov[1], f.skin.icov[3]]);
        gl.uniform3f(u.uSkinL, f.skin.lo, f.skin.hi, f.skin.margin);
      }
      for (const eye of f.eyes) {
        const q = eye.quad;
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([q[0], q[1], q[2], q[3], q[4], q[5], q[0], q[1], q[4], q[5], q[6], q[7]]), gl.STREAM_DRAW);
        gl.uniform3f(u.uInvX, eye.inv[0], eye.inv[1], eye.inv[2]);
        gl.uniform3f(u.uInvY, eye.inv[3], eye.inv[4], eye.inv[5]);
        gl.uniform3f(u.uGain, eye.gain[0], eye.gain[1], eye.gain[2]);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      }
    }
  }

  dispose() {
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
