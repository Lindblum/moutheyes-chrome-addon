// WebGL2 compositor: draws a tracked frame, then each face's mouth over both of its eyes. The
// mouth mask, skin gating and Lab conversion mirror src/shared/face.ts. For the mouth echo it
// keeps a couple of seconds of mouth crops per face, so an eye can show the mouth as it was.
import { MAX_HULL, maskParams, mouthBox, placeMouth, type FaceGeom, type MouthGeom, type SkinModel } from '../shared/face';

/** Seconds of mouth history kept per face, and crops stored per second of video. */
const HISTORY_SECONDS = 1;
const HISTORY_RATE = 30;
const HISTORY_LAYERS = HISTORY_SECONDS * HISTORY_RATE + 4;
/** Side of a stored mouth crop, in texels. */
const CROP_SIDE = 192;

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
void main() { o = texture(uTex, vUv); }`;

// Copies a square of the frame (uCrop: x, y, side in frame pixels) into a history layer.
const COPY_FS = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform vec2 uSize;
uniform vec3 uCrop;
out vec4 o;
void main() {
  vec2 src = uCrop.xy + gl_FragCoord.xy / ${CROP_SIDE}.0 * uCrop.z;
  o = vec4(texture(uTex, src / uSize).rgb, 1.0);
}`;

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
uniform highp sampler2DArray uHistTex;
uniform bool uHist; // sample a stored mouth crop (uLayer, covering uCrop) instead of the frame
uniform float uLayer;
uniform vec3 uCrop;
uniform vec2 uSize;
uniform vec3 uInvX, uInvY;
uniform vec2 uHull[MAX_HULL];
uniform int uHullN;
uniform vec2 uInner[MAX_HULL]; // the mouth opening
uniform int uInnerN;
uniform vec4 uMask; // core, pad, sigma, edge
uniform bool uSkinGate; // keep the outer margin only where it's skin
uniform float uFilter; // 0..1: how strictly to leave out what is neither skin nor lips (0 = off)
uniform float uTap; // spacing of the colour taps, so dither and noise don't speckle the mask
uniform bool uSkinOn, uLipOn;
uniform vec2 uSkinAb, uLipAb;
uniform mat2 uSkinIcov, uLipIcov;
uniform vec3 uSkinL, uLipL; // lo, hi, margin
uniform vec3 uGain;
in vec2 vDest;
out vec4 o;

float sdPolygon(vec2 poly[MAX_HULL], int n, vec2 p) {
  float d = 1e20;
  float s = 1.0;
  for (int i = 0, j = n - 1; i < n; j = i, i++) {
    vec2 e = poly[j] - poly[i];
    vec2 w = p - poly[i];
    vec2 b = w - e * clamp(dot(w, e) / max(dot(e, e), 1e-6), 0.0, 1.0);
    d = min(d, dot(b, b));
    bvec3 c = bvec3(p.y >= poly[i].y, p.y < poly[j].y, e.x * w.y > e.y * w.x);
    if (all(c) || all(not(c))) s = -s;
  }
  return s * sqrt(d);
}

float phi(float x) { return 0.5 * (1.0 + tanh(0.7978845608 * (x + 0.044715 * x * x * x))); }

float lin(float c) { return c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4); }
float lf(float t) { return t > 0.008856 ? pow(t, 1.0 / 3.0) : 7.787 * t + 16.0 / 116.0; }

// rgb in 0..1, to OpenCV 8-bit Lab scale: L 0..255, a/b offset by 128.
vec3 lab(vec3 rgb) {
  vec3 l = vec3(lin(rgb.r), lin(rgb.g), lin(rgb.b));
  float X = dot(l, vec3(0.412453, 0.35758, 0.180423)) / 0.950456;
  float Y = dot(l, vec3(0.212671, 0.71516, 0.072169));
  float Z = dot(l, vec3(0.019334, 0.119193, 0.950227)) / 1.088754;
  float L = Y > 0.008856 ? 116.0 * pow(Y, 1.0 / 3.0) - 16.0 : 903.3 * Y;
  return vec3(L * 2.55, 500.0 * (lf(X) - lf(Y)) + 128.0, 200.0 * (lf(Y) - lf(Z)) + 128.0);
}

// How well a Lab colour matches a colour model (skinProb() in face.ts).
float colorProb(vec3 c, vec2 ab, mat2 icov, vec3 l) {
  vec2 d = c.yz - ab;
  float dist = sqrt(max(0.0, dot(d, icov * d)));
  float chroma = clamp((4.5 - dist) / 1.5, 0.0, 1.0);
  float off = max(l.x - c.x, c.x - l.y);
  return chroma * clamp(1.0 - off / l.z, 0.0, 1.0);
}

vec3 srcColor(vec2 src) {
  return uHist
    ? texture(uHistTex, vec3((src - uCrop.xy) / uCrop.z, uLayer)).rgb
    : texture(uTex, src / uSize).rgb;
}

void main() {
  vec3 dp = vec3(vDest, 1.0);
  vec2 src = vec2(dot(uInvX, dp), dot(uInvY, dp));
  vec3 rgb = srcColor(src);
  // Skin averaged over a centre tap and four around it; skin-or-lips at its lowest among them,
  // which grows a cut-out object by a tap so its compression fringe goes too.
  float skin = 0.0;
  float face = 1.0;
  // In the mouth opening also the cavity (dark) and teeth (bright, nearly colourless).
  float mouth = 1.0;
  const vec2 taps[5] = vec2[5](vec2(0.0), vec2(1.0, 0.0), vec2(-1.0, 0.0), vec2(0.0, 1.0), vec2(0.0, -1.0));
  for (int k = 0; k < 5; k++) {
    vec3 c = lab(k == 0 ? rgb : srcColor(src + taps[k] * uTap));
    float ps = uSkinOn ? colorProb(c, uSkinAb, uSkinIcov, uSkinL) : 1.0;
    float pl = uLipOn ? colorProb(c, uLipAb, uLipIcov, uLipL) : 0.0;
    skin += ps;
    face = min(face, max(ps, pl));
    float chroma = length(c.yz - 128.0);
    float inside = max(1.0 - smoothstep(60.0, 110.0, c.x), 1.0 - smoothstep(14.0, 26.0, chroma));
    mouth = min(mouth, max(max(ps, pl), inside));
  }
  skin /= 5.0;
  float margin = uSkinGate && uSkinOn ? skin : 1.0;
  float keep = 1.0;
  if (uFilter > 0.0 && uSkinOn) {
    float opening = 1.0 - smoothstep(-1.0, 1.0, sdPolygon(uInner, uInnerN, src));
    // What is clearly none of these (an object, a coloured caption) goes at any strength;
    // stricter settings also drop what only half matches (shadow, stubble).
    float t = 0.5 * uFilter;
    keep = smoothstep(t, t + 0.2, mix(face, mouth, opening));
  }
  float d = sdPolygon(uHull, uHullN, src);
  float e = min(min(src.x, src.y), min(uSize.x - src.x, uSize.y - src.y));
  float a = max(phi((uMask.x - d) / uMask.z), phi((uMask.y - d) / uMask.z) * margin) * keep * phi((e - uMask.w) / uMask.z);
  a = clamp((a - 0.04) / 0.96, 0.0, 1.0);
  if (a <= 0.0) discard;
  o = vec4(clamp(rgb * uGain, 0.0, 1.0), a);
}`;

export class TaintedVideoError extends Error {}

/** Why the browser won't let us read this video's pixels, as a clause for the popup ("Moutheyes: ..."). */
export function taintedVideoReason(video: HTMLVideoElement): string {
  if (video.mediaKeys) return "this video is DRM-protected, so the browser won't let the extension read its pixels";
  if (location.protocol === 'file:') {
    return "the browser won't let extensions read the pixels of a video opened from a local file; serve the page over http instead (e.g. npx http-server)";
  }
  return "this video is protected (cross-origin or DRM), so the browser won't let the extension read its pixels";
}

/** taintedVideoReason() as a sentence, for a toast. */
export function taintedVideoMessage(video: HTMLVideoElement): string {
  const reason = taintedVideoReason(video);
  return `${reason[0].toUpperCase()}${reason.slice(1)}.`;
}

/** A face's mouth at one moment: which history layer holds its crop, and where it was. */
interface Snapshot {
  time: number;
  layer: number;
  mouth: MouthGeom;
  box: [number, number, number];
}

interface History {
  tex: WebGLTexture;
  snaps: Snapshot[];
  next: number;
}

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
  private copyProg: WebGLProgram;
  private tex: WebGLTexture;
  private fbo: WebGLFramebuffer;
  /** Bound when a face has no history, since the shader's array sampler always needs a texture. */
  private emptyHist: WebGLTexture;
  private histories = new Map<number, History>();
  private quadBuf: WebGLBuffer;
  private vao: WebGLVertexArrayObject;
  private u: Record<string, WebGLUniformLocation | null> = {};
  private frameW = 0;
  private frameH = 0;

  /** alpha: keep the picture's transparency (still pictures; video frames are opaque). */
  constructor(canvas: HTMLCanvasElement, { alpha = false } = {}) {
    // preserveDrawingBuffer: other extensions read this canvas after "moutheyes:frame".
    const gl = canvas.getContext('webgl2', { alpha, antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;
    this.frameProg = compile(gl, FRAME_VS, FRAME_FS);
    this.eyeProg = compile(gl, EYE_VS, EYE_FS);
    this.copyProg = compile(gl, FRAME_VS, COPY_FS);
    this.fbo = gl.createFramebuffer()!;
    this.emptyHist = this.historyTexture(1, 1);
    for (const name of ['uTex', 'uHistTex', 'uHist', 'uLayer', 'uCrop', 'uSize', 'uInvX', 'uInvY', 'uHull', 'uHullN',
      'uInner', 'uInnerN', 'uMask', 'uSkinGate', 'uFilter', 'uTap', 'uSkinOn', 'uSkinAb', 'uSkinIcov', 'uSkinL',
      'uLipOn', 'uLipAb', 'uLipIcov', 'uLipL', 'uGain']) {
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

  private historyTexture(side: number, layers: number): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, side, side, layers);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  /** Forgets all mouth history (seek, echo turned off). */
  clearHistory() {
    this.histories.forEach((h) => this.gl.deleteTexture(h.tex));
    this.histories.clear();
  }

  /**
   * Stores each face's mouth from the current frame (at most HISTORY_RATE per second of video
   * time) and drops the history of faces no longer tracked.
   */
  record(faces: FaceGeom[], time: number) {
    const gl = this.gl;
    const ids = new Set(faces.map((f) => f.id));
    for (const [id, h] of this.histories) {
      if (ids.has(id)) continue;
      gl.deleteTexture(h.tex);
      this.histories.delete(id);
    }
    if (!this.hasFrame) return;
    for (const f of faces) {
      let h = this.histories.get(f.id);
      if (!h) {
        h = { tex: this.historyTexture(CROP_SIDE, HISTORY_LAYERS), snaps: [], next: 0 };
        this.histories.set(f.id, h);
      }
      const last = h.snaps[h.snaps.length - 1];
      if (last && time < last.time) h.snaps = []; // time went backwards: a loop or seek
      else if (last && time - last.time < 0.9 / HISTORY_RATE) continue;
      const layer = h.next++ % HISTORY_LAYERS;
      const box = mouthBox(f.mouth);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, h.tex, 0, layer);
      gl.viewport(0, 0, CROP_SIDE, CROP_SIDE);
      gl.disable(gl.BLEND);
      gl.bindVertexArray(null);
      gl.useProgram(this.copyProg);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.uniform1i(gl.getUniformLocation(this.copyProg, 'uTex'), 0);
      gl.uniform2f(gl.getUniformLocation(this.copyProg, 'uSize'), this.frameW, this.frameH);
      gl.uniform3f(gl.getUniformLocation(this.copyProg, 'uCrop'), box[0], box[1], box[2]);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      h.snaps = h.snaps.filter((sn) => sn.layer !== layer);
      h.snaps.push({ time, layer, mouth: f.mouth, box });
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** The stored mouth closest before `time` (the oldest one if history doesn't reach back that far). */
  private snapshot(id: number, time: number): { h: History; snap: Snapshot } | null {
    const h = this.histories.get(id);
    if (!h?.snaps.length) return null;
    let snap = h.snaps[0];
    for (const sn of h.snaps) if (sn.time <= time) snap = sn;
    return { h, snap };
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

  /**
   * Draws the frame (the canvas is the frame's size) and the faces' mouths over their eyes.
   * With an echo, the eye on the left of the picture shows the mouth from `echo` seconds before
   * `time`, the right one from twice that. skinGate keeps the outer margin only where it's
   * skin; filter (0..1) leaves out whatever is neither skin nor lips. Returns how many eyes
   * showed an earlier mouth.
   */
  render(faces: FaceGeom[], { time = 0, echo = 0, skinGate = true, filter = 0 } = {}): number {
    const gl = this.gl;
    const bw = gl.drawingBufferWidth;
    const bh = gl.drawingBufferHeight;
    gl.viewport(0, 0, bw, bh);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!this.hasFrame) return 0;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);

    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
    gl.useProgram(this.frameProg);
    gl.uniform1i(gl.getUniformLocation(this.frameProg, 'uTex'), 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (!faces.length) return 0;
    let echoed = 0;

    gl.enable(gl.BLEND);
    // Mouths blend into the colour; the picture's own transparency stays as it was.
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
    gl.useProgram(this.eyeProg);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    const u = this.u;
    gl.uniform1i(u.uTex, 0);
    gl.uniform1i(u.uHistTex, 1);
    gl.uniform2f(u.uSize, this.frameW, this.frameH);
    gl.uniform1i(u.uSkinGate, skinGate ? 1 : 0);
    gl.uniform1f(u.uFilter, filter);
    const setModel = (on: WebGLUniformLocation | null, ab: WebGLUniformLocation | null, icov: WebGLUniformLocation | null,
      l: WebGLUniformLocation | null, m: SkinModel | null) => {
      gl.uniform1i(on, m ? 1 : 0);
      if (!m) return;
      gl.uniform2f(ab, m.ab[0], m.ab[1]);
      // mat2 uniforms are column-major; icov is symmetric anyway.
      gl.uniformMatrix2fv(icov, false, [m.icov[0], m.icov[2], m.icov[1], m.icov[3]]);
      gl.uniform3f(l, m.lo, m.hi, m.margin);
    };
    for (const f of faces) {
      setModel(u.uSkinOn, u.uSkinAb, u.uSkinIcov, u.uSkinL, f.skin);
      setModel(u.uLipOn, u.uLipAb, u.uLipIcov, u.uLipL, f.lips);
      // Eyes in picture order, left first.
      const order = f.eyes.map((_, i) => i).sort((a, b) => f.eyes[a].c[0] - f.eyes[b].c[0]);
      order.forEach((ei, rank) => {
        const past = echo > 0 && f.echo ? this.snapshot(f.id, time - echo * (rank + 1)) : null;
        const mouth = past?.snap.mouth ?? f.mouth;
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, past?.h.tex ?? this.emptyHist);
        gl.uniform1i(u.uHist, past ? 1 : 0);
        if (past && past.snap.time < time) echoed++;
        if (past) {
          gl.uniform1f(u.uLayer, past.snap.layer);
          gl.uniform3f(u.uCrop, past.snap.box[0], past.snap.box[1], past.snap.box[2]);
        }
        const poly = (pts: number[]) => {
          const a = new Float32Array(MAX_HULL * 2);
          a.set(pts.slice(0, MAX_HULL * 2));
          return a;
        };
        gl.uniform2fv(u.uHull, poly(mouth.hull));
        gl.uniform1i(u.uHullN, Math.min(MAX_HULL, mouth.hull.length / 2));
        gl.uniform2fv(u.uInner, poly(mouth.inner));
        gl.uniform1i(u.uInnerN, Math.min(MAX_HULL, mouth.inner.length / 2));
        const m = maskParams(mouth.w);
        gl.uniform4f(u.uMask, m.core, m.pad, m.sigma, m.edge);
        gl.uniform1f(u.uTap, 0.03 * mouth.w + 0.5);
        const { inv, quad: q } = placeMouth(mouth, f.eyes[ei], f.scale);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([q[0], q[1], q[2], q[3], q[4], q[5], q[0], q[1], q[4], q[5], q[6], q[7]]), gl.STREAM_DRAW);
        gl.uniform3f(u.uInvX, inv[0], inv[1], inv[2]);
        gl.uniform3f(u.uInvY, inv[3], inv[4], inv[5]);
        const g = f.gains[ei];
        gl.uniform3f(u.uGain, g[0], g[1], g[2]);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      });
    }
    return echoed;
  }

  /** What was last drawn, as RGBA bytes (not premultiplied), top row first. */
  readPixels(): Uint8Array {
    const gl = this.gl;
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    // WebGL reads the bottom row first.
    const row = w * 4;
    const out = new Uint8Array(px.length);
    for (let y = 0; y < h; y++) out.set(px.subarray((h - 1 - y) * row, (h - y) * row), y * row);
    return out;
  }

  dispose() {
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
