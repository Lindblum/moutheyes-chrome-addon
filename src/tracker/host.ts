// Runs inside a hidden chrome-extension:// iframe so MediaPipe's WASM loads under the
// extension's CSP instead of the host page's, and so the image cache is shared by every tab.
// Talks to the content script over a MessagePort: video frames come in, get their faces tracked,
// smoothed and measured, and go back; pictures go through the still-image pipeline (stills.ts).
import { eyeSpots, mouthGeom, mouthWidth, type FaceGeom, type Landmarks } from '../shared/face';
import type { FromHost, ToHost, TrackOptions } from '../shared/protocol';
import { convertImage } from './stills';
import {
  colorModel, detectIn, grabSample, loadLandmarkers, measureColors, measureGains, measureSkin, roi, sameFace, searchLm,
  tiles, trackLm, type ColorState, type Sample,
} from './vision';

/** Frames a face may go undetected before its mouths are removed (brief misses don't flicker). */
const HOLD_FRAMES = 4;
/** While faces may still be missing, look for new ones every this many frames (every frame if none). */
const SEARCH_EVERY = 4;
/** A search tries further tiles until it has used this much time (ms), at least one. */
const SEARCH_BUDGET_MS = 8;

let port: MessagePort | null = null;

function send(msg: FromHost, transfer: Transferable[] = []) {
  port?.postMessage(msg, transfer);
}

async function init() {
  try {
    send({ type: 'ready', provider: await loadLandmarkers() });
  } catch (e) {
    send({ type: 'error', message: e instanceof Error ? e.message : String(e) });
  }
}

// ---------------------------------------------------------------- tracks and smoothing
interface Track extends ColorState {
  id: number;
  /** Last detection, unsmoothed: where to look next. */
  raw: Landmarks;
  /** Per-point speed estimate of the smoothed landmarks (px/s). */
  dL: Float32Array;
  missed: number;
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
let nextTrackId = 1;

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
  return tracks.some((t) => sameFace(t.raw, raw));
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
        next.push({ id: nextTrackId++, raw, L: new Float32Array(raw), dL: new Float32Array(raw.length), missed: 0, skin: null, lips: null, gains: [[1, 1, 1], [1, 1, 1]] });
      }
      s.searched++;
    } while (next.length < opts.maxFaces && s.searched < all.length && performance.now() - t0 < SEARCH_BUDGET_MS);
  }
  s.frame++;
  s.tracks = next.slice(0, opts.maxFaces);
  return s.tracks.length < opts.maxFaces && s.searched < all.length;
}

/**
 * Whether a face that went undetected this frame is still where it was: its cheeks and forehead
 * still show its skin colour. After a shot change they show something else, and holding the
 * face there would leave mouths (and echoes of its old mouth) on whatever is there now.
 */
function stillThere(t: Track, smp: Sample): boolean {
  const model = colorModel(t.skin);
  const now = measureSkin(t.L, smp);
  if (!model || !now) return false;
  const da = now.ab[0] - model.ab[0];
  const db = now.ab[1] - model.ab[1];
  const chroma = Math.sqrt(da * (model.icov[0] * da + model.icov[1] * db) + db * (model.icov[2] * da + model.icov[3] * db));
  const light = Math.abs((now.lo + now.hi) / 2 - (model.lo + model.hi) / 2);
  return chroma < 3 && light < model.margin;
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
    const smp = (opts.skinMatch || opts.objectFilter > 0) && s.tracks.length ? grabSample(bitmap) : null;
    if (smp) s.tracks = s.tracks.filter((t) => !t.missed || stillThere(t, smp));
    const faces = s.tracks.map((t): FaceGeom => {
      const face: FaceGeom = {
        id: t.id,
        mouth: mouthGeom(t.L),
        eyes: eyeSpots(t.L),
        scale: opts.mouthScale,
        gains: [[1, 1, 1], [1, 1, 1]],
        skin: null,
        lips: null,
        // Held faces could only be checked with the skin sample.
        echo: !t.missed || !!smp,
      };
      if (smp) {
        // A held face's spot was just checked; its colours aren't measured again until it's seen.
        if (!t.missed) measureColors(t, smp);
        face.skin = colorModel(t.skin);
        face.lips = colorModel(t.lips);
        if (opts.skinMatch) measureGains(t.gains, face, smp, W, H);
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
    else if (msg.type === 'image') {
      convertImage(msg.url, msg.file, msg.opts).then((r) => send({ type: 'image-done', id: msg.id, ...r }));
    }
  };
});
