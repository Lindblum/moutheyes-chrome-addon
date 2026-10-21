// Runs inside a hidden chrome-extension:// iframe so MediaPipe's WASM loads under the
// extension's CSP instead of the host page's. Talks to the content script over a MessagePort:
// each frame comes in, gets its faces tracked, smoothed and measured, and goes back.
import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';
import {
  eyeSpan, faceGeometry, maskAlpha, maskParams, mouthWidth, rgbToLab, sdPolygon, skinProb, SKIN_POINTS,
  type FaceGeom, type Landmarks, type SkinModel,
} from '../shared/face';
import type { FromHost, ToHost, TrackOptions } from '../shared/protocol';

/** Long side of the downscaled copy that skin colour and tone matching are measured on. */
const SAMPLE_SIDE = 480;
/** Frames a face may go undetected before its mouths are removed (brief misses don't flicker). */
const HOLD_FRAMES = 4;
/** Side of the square crops faces are looked for in. */
const CROP = 256;
/** A tracked face is looked for in a crop this many times its landmark box (room to move). */
const CROP_MARGIN = 2;
/** While faces may still be missing, look for new ones every this many frames (every frame if none). */
const SEARCH_EVERY = 4;
/** A search tries further tiles until it has used this much time (ms), at least one. */
const SEARCH_BUDGET_MS = 8;

let port: MessagePort | null = null;
/** Finds the one face in a crop around a tracked face; finds any faces in a search tile. */
let trackLm: FaceLandmarker | null = null;
let searchLm: FaceLandmarker | null = null;
let provider = '';
const cropCanvas = new OffscreenCanvas(CROP, CROP);
const cropCtx = cropCanvas.getContext('2d')!;
let sampleCanvas: OffscreenCanvas | null = null;
let sampleCtx: OffscreenCanvasRenderingContext2D | null = null;

function send(msg: FromHost, transfer: Transferable[] = []) {
  port?.postMessage(msg, transfer);
}

async function init() {
  if (trackLm) return send({ type: 'ready', provider });
  try {
    const fileset = await FilesetResolver.forVisionTasks(chrome.runtime.getURL('mediapipe'));
    const create = (delegate: 'GPU' | 'CPU', numFaces: number) =>
      FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: chrome.runtime.getURL('models/face_landmarker.task'), delegate },
        runningMode: 'IMAGE',
        numFaces,
        minFaceDetectionConfidence: 0.3,
        minFacePresenceConfidence: 0.3,
      });
    let delegate: 'GPU' | 'CPU' = 'GPU';
    try {
      trackLm = await create(delegate, 1);
    } catch (e) {
      console.warn('[moutheyes] GPU delegate failed, using CPU:', e);
      delegate = 'CPU';
      trackLm = await create(delegate, 1);
    }
    searchLm = await create(delegate, 4);
    provider = `MediaPipe · ${delegate}`;
    send({ type: 'ready', provider });
  } catch (e) {
    send({ type: 'error', message: e instanceof Error ? e.message : String(e) });
  }
}

// ---------------------------------------------------------------- finding faces
/** A square region of the frame: x, y, side. May reach past the frame's edges. */
type Box = [number, number, number];

/**
 * Faces in one square region, as frame-pixel landmarks. The face detector squeezes whatever it
 * gets into 128x128, so a face that's small in a wide frame is only found in a crop around it.
 */
function detectIn(lm: FaceLandmarker, bitmap: ImageBitmap, [x0, y0, side]: Box): Landmarks[] {
  cropCtx.fillStyle = '#000';
  cropCtx.fillRect(0, 0, CROP, CROP);
  cropCtx.drawImage(bitmap, x0, y0, side, side, 0, 0, CROP, CROP);
  return lm.detect(cropCanvas).faceLandmarks.map((pts) => {
    const L = new Float32Array(pts.length * 2);
    pts.forEach((p, i) => {
      L[2 * i] = x0 + p.x * side;
      L[2 * i + 1] = y0 + p.y * side;
    });
    return L;
  });
}

/** Where to look for a tracked face next: its landmark box, enlarged. */
function roi(L: Landmarks): Box {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < L.length; i += 2) {
    x0 = Math.min(x0, L[i]);
    x1 = Math.max(x1, L[i]);
    y0 = Math.min(y0, L[i + 1]);
    y1 = Math.max(y1, L[i + 1]);
  }
  const side = CROP_MARGIN * Math.max(x1 - x0, y1 - y0);
  return [(x0 + x1 - side) / 2, (y0 + y1 - side) / 2, side];
}

/** Search regions, cycled one per search: the whole frame, then frame-high squares, then half-size ones. */
function tiles(W: number, H: number): Box[] {
  const long = Math.max(W, H);
  const out: Box[] = [[(W - long) / 2, (H - long) / 2, long]];
  for (const side of [Math.min(W, H), Math.min(W, H) / 2]) {
    const step = side / 2;
    for (let y = 0; y + side <= H + 1; y += step) {
      for (let x = 0; x + side <= W + 1; x += step) out.push([x, y, side]);
    }
  }
  return out;
}

// ---------------------------------------------------------------- tracks and smoothing
interface Track {
  /** Last detection, unsmoothed: where to look next. */
  raw: Landmarks;
  /** Smoothed landmarks, and their per-point speed estimate (px/s). */
  L: Landmarks;
  dL: Float32Array;
  missed: number;
  /** Running skin-colour statistics, before inversion. */
  skin: { ab: [number, number]; cov: [number, number, number, number]; lo: number; hi: number } | null;
  gains: [number, number, number][];
}

interface Stream {
  tracks: Track[];
  time: number;
  frame: number;
  /** Next search tile, and tiles searched in the current frame. */
  tile: number;
  searched: number;
}

const streams = new Map<number, Stream>();

const center = (L: Landmarks): [number, number] => {
  let x = 0;
  let y = 0;
  for (let i = 0; i < L.length; i += 2) {
    x += L[i];
    y += L[i + 1];
  }
  return [(2 * x) / L.length, (2 * y) / L.length];
};

const lowpass = (dt: number, cutoff: number) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));

/**
 * One Euro filter on every landmark: heavy smoothing while a face is still (no jitter), little
 * while it moves (no lag). Speed is measured in mouth widths per second so it doesn't depend on
 * how big the face is in the frame.
 */
function smooth(t: Track, raw: Landmarks, dt: number, smoothing: number) {
  const scale = mouthWidth(raw);
  let moved = 0;
  for (let i = 0; i < raw.length; i++) moved += Math.abs(raw[i] - t.L[i]);
  // A jump of a quarter mouth width on average is a cut, not motion: start over.
  if (smoothing <= 0 || dt <= 0 || dt > 0.5 || moved / raw.length > 0.25 * scale) {
    t.L.set(raw);
    t.dL.fill(0);
    return;
  }
  const minCutoff = 0.3 + 8 * (1 - smoothing) ** 2;
  const beta = 4;
  const ad = lowpass(dt, 1);
  for (let i = 0; i < raw.length; i += 2) {
    const vx = (raw[i] - t.L[i]) / dt;
    const vy = (raw[i + 1] - t.L[i + 1]) / dt;
    t.dL[i] += (vx - t.dL[i]) * ad;
    t.dL[i + 1] += (vy - t.dL[i + 1]) * ad;
    const a = lowpass(dt, minCutoff + (beta * Math.hypot(t.dL[i], t.dL[i + 1])) / scale);
    t.L[i] += (raw[i] - t.L[i]) * a;
    t.L[i + 1] += (raw[i + 1] - t.L[i + 1]) * a;
  }
}

/** True if another track already follows the face these landmarks belong to. */
function taken(tracks: Track[], raw: Landmarks): boolean {
  const c = center(raw);
  return tracks.some((t) => {
    const o = center(t.raw);
    return Math.hypot(o[0] - c[0], o[1] - c[1]) < 0.5 * eyeSpan(raw);
  });
}

/**
 * Follows each tracked face into this frame (looking in a crop around where it was), drops
 * faces lost for too long or that converged onto another track's face, and now and then
 * searches one tile of the frame for new faces.
 */
function updateTracks(s: Stream, bitmap: ImageBitmap, time: number, opts: TrackOptions): boolean {
  const t0 = performance.now();
  const dt = time - s.time;
  // The same frame again (paused video): keep searching where the last pass stopped.
  const sameFrame = dt === 0 && s.frame > 0;
  if (!sameFrame) s.searched = 0;
  s.time = time;
  const next: Track[] = [];
  for (const t of s.tracks) {
    const [raw] = detectIn(trackLm!, bitmap, roi(t.raw));
    if (!raw) {
      if (++t.missed <= HOLD_FRAMES) next.push(t);
    } else if (!taken(next, raw)) {
      t.raw = raw;
      t.missed = 0;
      smooth(t, raw, dt, opts.smoothing);
      next.push(t);
    }
  }
  const all = tiles(bitmap.width, bitmap.height);
  if (next.length < opts.maxFaces && (!next.length || sameFrame || s.frame % SEARCH_EVERY === 0)) {
    do {
      for (const raw of detectIn(searchLm!, bitmap, all[s.tile++ % all.length])) {
        if (next.length >= opts.maxFaces) break;
        if (taken(next, raw)) continue;
        next.push({ raw, L: new Float32Array(raw), dL: new Float32Array(raw.length), missed: 0, skin: null, gains: [[1, 1, 1], [1, 1, 1]] });
      }
      s.searched++;
    } while (next.length < opts.maxFaces && s.searched < all.length && performance.now() - t0 < SEARCH_BUDGET_MS);
  }
  s.frame++;
  s.tracks = next.slice(0, opts.maxFaces);
  return s.tracks.length < opts.maxFaces && s.searched < all.length;
}

// ---------------------------------------------------------------- skin colour and tone matching
interface Sample {
  px: Uint8ClampedArray;
  w: number;
  h: number;
  /** Sample pixels per frame pixel. */
  k: number;
}

function grabSample(bitmap: ImageBitmap): Sample {
  const k = Math.min(1, SAMPLE_SIDE / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * k));
  const h = Math.max(1, Math.round(bitmap.height * k));
  if (!sampleCanvas || sampleCanvas.width !== w || sampleCanvas.height !== h) {
    sampleCanvas = new OffscreenCanvas(w, h);
    sampleCtx = sampleCanvas.getContext('2d', { willReadFrequently: true });
  }
  sampleCtx!.drawImage(bitmap, 0, 0, w, h);
  return { px: sampleCtx!.getImageData(0, 0, w, h).data, w, h, k };
}

function percentile(sorted: Float32Array, q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))];
}

/**
 * Skin colour from discs on the cheeks, forehead and nose bridge: Lab chroma mean/covariance and
 * lightness range, blended into the track's running estimate. Null if too little skin is visible.
 */
function measureSkin(t: Track, smp: Sample) {
  const L = t.L;
  const r = Math.max(1, Math.floor(0.06 * eyeSpan(L) * smp.k));
  const seen = new Uint8Array(smp.w * smp.h);
  const labs: number[] = [];
  for (const i of SKIN_POINTS) {
    const cx = Math.round(L[2 * i] * smp.k);
    const cy = Math.round(L[2 * i + 1] * smp.k);
    for (let y = Math.max(0, cy - r); y <= Math.min(smp.h - 1, cy + r); y++) {
      for (let x = Math.max(0, cx - r); x <= Math.min(smp.w - 1, cx + r); x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 > r * r || seen[y * smp.w + x]) continue;
        seen[y * smp.w + x] = 1;
        const o = (y * smp.w + x) * 4;
        labs.push(...rgbToLab(smp.px[o], smp.px[o + 1], smp.px[o + 2]));
      }
    }
  }
  const n = labs.length / 3;
  if (n < 50) return;
  // drop outliers (hair over the forehead, glasses, highlights) by distance from the median
  const med: number[] = [];
  const mad: number[] = [];
  for (let c = 0; c < 3; c++) {
    const v = Float32Array.from({ length: n }, (_, i) => labs[3 * i + c]).sort();
    const m = percentile(v, 0.5);
    const dev = v.map((x) => Math.abs(x - m)).sort();
    med.push(m);
    mad.push(1.4826 * percentile(dev, 0.5) + 2);
  }
  const keep: number[] = [];
  for (let i = 0; i < n; i++) {
    if ([0, 1, 2].every((c) => Math.abs(labs[3 * i + c] - med[c]) < 3 * mad[c])) keep.push(i);
  }
  if (keep.length < 50) return;
  let ma = 0;
  let mb = 0;
  for (const i of keep) {
    ma += labs[3 * i + 1];
    mb += labs[3 * i + 2];
  }
  ma /= keep.length;
  mb /= keep.length;
  let caa = 0;
  let cab = 0;
  let cbb = 0;
  for (const i of keep) {
    const da = labs[3 * i + 1] - ma;
    const db = labs[3 * i + 2] - mb;
    caa += da * da;
    cab += da * db;
    cbb += db * db;
  }
  const dn = keep.length - 1;
  const lv = Float32Array.from(keep, (i) => labs[3 * i]).sort();
  const now = {
    ab: [ma, mb] as [number, number],
    // floor of ~3 units: flat or palette-quantized video is near-degenerate
    cov: [caa / dn + 9, cab / dn, cab / dn, cbb / dn + 9] as [number, number, number, number],
    lo: percentile(lv, 0.05),
    hi: percentile(lv, 0.95),
  };
  if (!t.skin) {
    t.skin = now;
    return;
  }
  const a = 0.15;
  const s = t.skin;
  s.ab = [s.ab[0] + (now.ab[0] - s.ab[0]) * a, s.ab[1] + (now.ab[1] - s.ab[1]) * a];
  s.cov = s.cov.map((v, i) => v + (now.cov[i] - v) * a) as typeof s.cov;
  s.lo += (now.lo - s.lo) * a;
  s.hi += (now.hi - s.hi) * a;
}

function skinModel(t: Track): SkinModel | null {
  if (!t.skin) return null;
  const [a, b, c, d] = t.skin.cov;
  const det = a * d - b * c;
  return {
    ab: t.skin.ab,
    icov: [d / det, -b / det, -c / det, a / det],
    lo: t.skin.lo,
    hi: t.skin.hi,
    margin: Math.max(12, 0.3 * (t.skin.hi - t.skin.lo)),
  };
}

/**
 * Per eye, the colour gain that matches the mouth copy to the skin around the eye: compares the
 * frame and the copy over the mask's outer ring (skin pixels only, when there's a skin model).
 */
function measureGains(t: Track, face: FaceGeom, smp: Sample, W: number, H: number) {
  const m = maskParams(face.mw);
  face.eyes.forEach((eye, ei) => {
    const q = eye.quad;
    const x0 = Math.max(0, Math.floor(Math.min(q[0], q[2], q[4], q[6]) * smp.k));
    const x1 = Math.min(smp.w - 1, Math.ceil(Math.max(q[0], q[2], q[4], q[6]) * smp.k));
    const y0 = Math.max(0, Math.floor(Math.min(q[1], q[3], q[5], q[7]) * smp.k));
    const y1 = Math.min(smp.h - 1, Math.ceil(Math.max(q[1], q[3], q[5], q[7]) * smp.k));
    const [ia, ib, ic, id, ie, iff] = eye.inv;
    const sumOut = [0, 0, 0];
    const sumPatch = [0, 0, 0];
    const skinOut = [0, 0, 0];
    const skinPatch = [0, 0, 0];
    let n = 0;
    let ns = 0;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = (x + 0.5) / smp.k;
        const dy = (y + 0.5) / smp.k;
        const sx = ia * dx + ib * dy + ic;
        const sy = id * dx + ie * dy + iff;
        const e = Math.min(sx, sy, W - sx, H - sy);
        const a = maskAlpha(sdPolygon(face.hull, sx, sy), 1, e, m);
        if (a <= 0.05 || a >= 0.5) continue;
        const px = Math.min(smp.w - 1, Math.max(0, Math.floor(sx * smp.k)));
        const py = Math.min(smp.h - 1, Math.max(0, Math.floor(sy * smp.k)));
        const o = (y * smp.w + x) * 4;
        const p = (py * smp.w + px) * 4;
        n++;
        for (let c = 0; c < 3; c++) {
          sumOut[c] += smp.px[o + c];
          sumPatch[c] += smp.px[p + c];
        }
        if (face.skin) {
          const both = Math.min(
            skinProb(face.skin, rgbToLab(smp.px[o], smp.px[o + 1], smp.px[o + 2])),
            skinProb(face.skin, rgbToLab(smp.px[p], smp.px[p + 1], smp.px[p + 2])),
          );
          if (both > 0.5) {
            ns++;
            for (let c = 0; c < 3; c++) {
              skinOut[c] += smp.px[o + c];
              skinPatch[c] += smp.px[p + c];
            }
          }
        }
      }
    }
    const [so, sp, cnt] = ns > 20 ? [skinOut, skinPatch, ns] : [sumOut, sumPatch, n];
    let target: [number, number, number] = [1, 1, 1];
    if (cnt > 20) {
      target = [0, 1, 2].map((c) => Math.min(1.14, Math.max(0.88, (so[c] / cnt + 1) / (sp[c] / cnt + 1)))) as typeof target;
    }
    const g = t.gains[ei];
    for (let c = 0; c < 3; c++) g[c] += (target[c] - g[c]) * 0.3;
    eye.gain = [g[0], g[1], g[2]];
  });
}

// ---------------------------------------------------------------- frames
function runFrame(msg: Extract<ToHost, { type: 'frame' }>) {
  const { id, bitmap, opts } = msg;
  if (!trackLm || !searchLm) return send({ type: 'frame-error', id, bitmap, message: 'tracker not loaded' }, [bitmap]);
  try {
    const t0 = performance.now();
    const W = bitmap.width;
    const H = bitmap.height;
    let s = streams.get(msg.stream);
    if (!s || msg.reset) {
      s = { tracks: [], time: msg.time, frame: 0, tile: 0, searched: 0 };
      streams.set(msg.stream, s);
    }
    const searching = updateTracks(s, bitmap, msg.time, opts);
    const smp = opts.skinMatch && s.tracks.length ? grabSample(bitmap) : null;
    const faces = s.tracks.map((t): FaceGeom => {
      const face: FaceGeom = { ...faceGeometry(t.L, opts.mouthScale), skin: null };
      if (smp) {
        measureSkin(t, smp);
        face.skin = skinModel(t);
        measureGains(t, face, smp, W, H);
      }
      return face;
    });
    send({ type: 'faces', id, bitmap, faces, searching, ms: performance.now() - t0 }, [bitmap]);
  } catch (e) {
    send({ type: 'frame-error', id, bitmap, message: e instanceof Error ? e.message : String(e) }, [bitmap]);
  }
}

window.addEventListener('message', (e) => {
  if (port || e.data?.type !== 'moutheyes-connect' || !e.ports[0]) return;
  port = e.ports[0];
  port.onmessage = (ev: MessageEvent<ToHost>) => {
    const msg = ev.data;
    if (msg.type === 'init') init();
    else if (msg.type === 'frame') runFrame(msg);
  };
});

