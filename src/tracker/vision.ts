// What the video tracker and the still-image pipeline share: MediaPipe's face landmarkers, finding
// faces in crops of a picture, and measuring a face's skin and lip colours and tone gains.
import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';
import {
  eyeSpan, maskAlpha, maskParams, mouthWidth, placeMouth, rgbToLab, sdPolygon, skinProb, LIP_BAND, SKIN_POINTS,
  type FaceGeom, type Landmarks, type SkinModel,
} from '../shared/face';

/** Long side of the downscaled copy that skin colour and tone matching are measured on. */
const SAMPLE_SIDE = 480;
/** Side of the square crops faces are looked for in. */
const CROP = 256;
/** A known face is looked for in a crop this many times its landmark box (room to move). */
const CROP_MARGIN = 2;
/**
 * Confidence needed for a face in a still picture (video uses 0.3). A mouth pasted onto a
 * sandbag stays in a picture for good; a missed face isn't noticed.
 */
const STILL_DETECTION = 0.6;
const STILL_PRESENCE = 0.7;

/** Finds the one face in a crop around a known face; finds any faces in a search tile. */
export let trackLm: FaceLandmarker | null = null;
export let searchLm: FaceLandmarker | null = null;
/**
 * Searches still pictures, more strictly: a false face in a video is gone a moment later, in a
 * picture it would stay. Made only when a picture first needs searching.
 */
export let stillLm: FaceLandmarker | null = null;
let loading: Promise<string> | null = null;
let loadingStill: Promise<void> | null = null;
let fileset: Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>> | null = null;
let delegate: 'GPU' | 'CPU' = 'GPU';

function createLandmarker(numFaces: number, detection: number, presence = detection) {
  return FaceLandmarker.createFromOptions(fileset!, {
    baseOptions: { modelAssetPath: chrome.runtime.getURL('models/face_landmarker.task'), delegate },
    runningMode: 'IMAGE',
    numFaces,
    minFaceDetectionConfidence: detection,
    minFacePresenceConfidence: presence,
  });
}
const cropCanvas = new OffscreenCanvas(CROP, CROP);
const cropCtx = cropCanvas.getContext('2d')!;
let sampleCanvas: OffscreenCanvas | null = null;
let sampleCtx: OffscreenCanvasRenderingContext2D | null = null;

/** Loads the landmarkers once (GPU, else CPU). Resolves with a description of what runs them. */
export function loadLandmarkers(): Promise<string> {
  loading ??= (async () => {
    fileset = await FilesetResolver.forVisionTasks(chrome.runtime.getURL('mediapipe'));
    try {
      trackLm = await createLandmarker(1, 0.3);
    } catch (e) {
      console.warn('[moutheyes] GPU delegate failed, using CPU:', e);
      delegate = 'CPU';
      trackLm = await createLandmarker(1, 0.3);
    }
    searchLm = await createLandmarker(4, 0.3);
    return `MediaPipe · ${delegate}`;
  })();
  loading.catch(() => (loading = null)); // let a later request try again
  return loading;
}

/** Loads the landmarkers, including the stricter one for still pictures. */
export async function loadStillLandmarker(): Promise<void> {
  await loadLandmarkers();
  loadingStill ??= createLandmarker(4, STILL_DETECTION, STILL_PRESENCE).then((lm) => void (stillLm = lm));
  loadingStill.catch(() => (loadingStill = null));
  return loadingStill;
}

// ---------------------------------------------------------------- finding faces
/** A square region of the picture: x, y, side. May reach past the picture's edges. */
export type Box = [number, number, number];

/**
 * Faces in one square region, as picture-pixel landmarks. The face detector squeezes whatever it
 * gets into 128x128, so a face that's small in a wide picture is only found in a crop around it.
 */
export function detectIn(lm: FaceLandmarker, bitmap: ImageBitmap, [x0, y0, side]: Box): Landmarks[] {
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

/** Where to look for a known face again: its landmark box, enlarged. */
export function roi(L: Landmarks): Box {
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

/**
 * Search regions: the whole picture, then picture-high squares, then squares of half that size,
 * and so on for `levels` sizes. Each half-overlaps its neighbours.
 */
export function tiles(W: number, H: number, levels = 2): Box[] {
  const long = Math.max(W, H);
  const out: Box[] = [[(W - long) / 2, (H - long) / 2, long]];
  for (let l = 0; l < levels; l++) {
    const side = Math.min(W, H) / 2 ** l;
    const step = side / 2;
    for (let y = 0; y + side <= H + 1; y += step) {
      for (let x = 0; x + side <= W + 1; x += step) out.push([x, y, side]);
    }
  }
  return out;
}

export const center = (L: Landmarks): [number, number] => {
  let x = 0;
  let y = 0;
  for (let i = 0; i < L.length; i += 2) {
    x += L[i];
    y += L[i + 1];
  }
  return [(2 * x) / L.length, (2 * y) / L.length];
};

/** Whether two sets of landmarks are on the same face. */
export function sameFace(a: Landmarks, b: Landmarks): boolean {
  const ca = center(a);
  const cb = center(b);
  return Math.hypot(ca[0] - cb[0], ca[1] - cb[1]) < 0.5 * eyeSpan(b);
}

// ---------------------------------------------------------------- skin colour and tone matching
export interface Sample {
  px: Uint8ClampedArray;
  w: number;
  h: number;
  /** Sample pixels per picture pixel. */
  k: number;
}

/** A copy of the picture to measure colours on, at most `side` pixels on its long side. */
export function grabSample(bitmap: ImageBitmap, side = SAMPLE_SIDE): Sample {
  const k = Math.min(1, side / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * k));
  const h = Math.max(1, Math.round(bitmap.height * k));
  if (!sampleCanvas || sampleCanvas.width !== w || sampleCanvas.height !== h) {
    sampleCanvas = new OffscreenCanvas(w, h);
    sampleCtx = sampleCanvas.getContext('2d', { willReadFrequently: true });
  }
  sampleCtx!.clearRect(0, 0, w, h);
  sampleCtx!.drawImage(bitmap, 0, 0, w, h);
  return { px: sampleCtx!.getImageData(0, 0, w, h).data, w, h, k };
}

function percentile(sorted: Float32Array, q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))];
}

/** Robust colour statistics: Lab chroma mean/covariance and lightness range, before inversion. */
export interface ColorStats {
  ab: [number, number];
  cov: [number, number, number, number];
  lo: number;
  hi: number;
}

/** A face's landmarks and what has been measured of its colours so far. */
export interface ColorState {
  L: Landmarks;
  skin: ColorStats | null;
  lips: ColorStats | null;
}

/**
 * Colour statistics of the pixels in discs of radius r (sample pixels) around the given centres
 * (picture pixels), with outliers dropped by distance from the median (hair over the forehead,
 * glasses, highlights, a finger over the lips). Null if fewer than `min` pixels survive.
 */
function measureColor(
  smp: Sample, centres: [number, number][], r: number, min: number,
  accept: (lab: [number, number, number]) => boolean = () => true,
): ColorStats | null {
  const seen = new Uint8Array(smp.w * smp.h);
  const labs: number[] = [];
  for (const [fx, fy] of centres) {
    const cx = Math.round(fx * smp.k);
    const cy = Math.round(fy * smp.k);
    for (let y = Math.max(0, cy - r); y <= Math.min(smp.h - 1, cy + r); y++) {
      for (let x = Math.max(0, cx - r); x <= Math.min(smp.w - 1, cx + r); x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 > r * r || seen[y * smp.w + x]) continue;
        seen[y * smp.w + x] = 1;
        const o = (y * smp.w + x) * 4;
        // Transparent pixels (a cut-out portrait's background) aren't the face's colour.
        if (smp.px[o + 3] < 128) continue;
        const lab = rgbToLab(smp.px[o], smp.px[o + 1], smp.px[o + 2]);
        if (accept(lab)) labs.push(...lab);
      }
    }
  }
  const n = labs.length / 3;
  if (n < min) return null;
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
  if (keep.length < min) return null;
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
  return {
    ab: [ma, mb],
    // floor of ~3 units: flat or palette-quantized pictures are near-degenerate
    cov: [caa / dn + 9, cab / dn, cab / dn, cbb / dn + 9],
    lo: percentile(lv, 0.05),
    hi: percentile(lv, 0.95),
  };
}

/** Blends a new measurement into a running estimate. */
function follow(prev: ColorStats | null, now: ColorStats | null, a: number): ColorStats | null {
  if (!now || !prev) return prev ?? now;
  return {
    ab: [prev.ab[0] + (now.ab[0] - prev.ab[0]) * a, prev.ab[1] + (now.ab[1] - prev.ab[1]) * a],
    cov: prev.cov.map((v, i) => v + (now.cov[i] - v) * a) as ColorStats['cov'],
    lo: prev.lo + (now.lo - prev.lo) * a,
    hi: prev.hi + (now.hi - prev.hi) * a,
  };
}

/**
 * Skin colour from discs on the cheeks, forehead and nose bridge. A small face only has a few
 * pixels there, so it needs fewer: 40% of what the discs could hold, up to 50.
 */
export function measureSkin(L: Landmarks, smp: Sample): ColorStats | null {
  const r = Math.max(1, Math.floor(0.06 * eyeSpan(L) * smp.k));
  const min = Math.min(50, Math.max(12, Math.floor(0.4 * SKIN_POINTS.length * Math.PI * r * r)));
  return measureColor(smp, SKIN_POINTS.map((i): [number, number] => [L[2 * i], L[2 * i + 1]]), r, min);
}

/**
 * Measures skin, then lips (from the band between their outer and inner lines), and blends them
 * into the running estimates. A first measurement is taken as is.
 */
export function measureColors(t: ColorState, smp: Sample) {
  const L = t.L;
  t.skin = follow(t.skin, measureSkin(L, smp), 0.15);
  const skin = t.skin;
  if (!skin) return;
  const lipR = Math.max(1, Math.floor(0.035 * mouthWidth(L) * smp.k));
  const band = LIP_BAND.map(([o, i]): [number, number] => [(L[2 * o] + L[2 * i]) / 2, (L[2 * o + 1] + L[2 * i + 1]) / 2]);
  // Lips are skin with more red (a) and about the same yellow-blue (b). Anything else in the band
  // (a caption or microphone over the lips) must not become "lip colour".
  const lipLike = ([l, a, b]: [number, number, number]) =>
    a - skin.ab[0] > -6 && a - skin.ab[0] < 30 && Math.abs(b - skin.ab[1]) < 14 && l > skin.lo - 90 && l < skin.hi + 30;
  t.lips = follow(t.lips, measureColor(smp, band, lipR, 20, lipLike), 0.08);
}

export function colorModel(c: ColorStats | null): SkinModel | null {
  if (!c) return null;
  const [a, b, cc, d] = c.cov;
  const det = a * d - b * cc;
  return {
    ab: c.ab,
    icov: [d / det, -b / det, -cc / det, a / det],
    lo: c.lo,
    hi: c.hi,
    margin: Math.max(12, 0.3 * (c.hi - c.lo)),
  };
}

/**
 * Per eye, the colour gain that matches the mouth copy to the skin around the eye: compares the
 * picture and the copy over the mask's outer ring (skin pixels only, when there's a skin model).
 * `gains` holds the running values, moved toward the new measurement by `rate` (1 = take it).
 */
export function measureGains(gains: [number, number, number][], face: FaceGeom, smp: Sample, W: number, H: number, rate = 0.3) {
  const m = maskParams(face.mouth.w);
  face.eyes.forEach((spot, ei) => {
    const eye = placeMouth(face.mouth, spot, face.scale);
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
        const a = maskAlpha(sdPolygon(face.mouth.hull, sx, sy), 1, e, m);
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
    const g = gains[ei];
    for (let c = 0; c < 3; c++) g[c] += (target[c] - g[c]) * rate;
    face.gains[ei] = [g[0], g[1], g[2]];
  });
}
