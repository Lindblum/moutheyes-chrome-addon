// Moutheyes for the pictures on pages, still or animated (GIF, APNG, animated WebP). A picture is
// only ever examined once: its faces (or that it has none) go into the image cache, and each
// moutheyes version made from it is stored there too, so showing it again, in any tab, is a cache
// read. The work itself is slow on purpose: every search tile is tried (a picture is examined
// once, so it's worth being thorough), the event loop gets a turn every few milliseconds so video
// frames aren't held up, and a lock shared by all tabs lets only one picture at a time use the GPU.
import { applyPalette, GIFEncoder, quantize } from 'gifenc';
import { Renderer } from '../render/renderer';
import { eyeSpan, eyeSpots, mouthGeom, mouthWidth, type FaceGeom, type Landmarks } from '../shared/face';
import { cacheKey, getEntry, outputKey, putEntry, readOutput, writeOutput, type ImageEntry } from '../shared/imagecache';
import type { ImageOptions, ImageResult } from '../shared/protocol';
import {
  colorModel, detectIn, grabSample, loadStillLandmarker, measureColors, measureGains, roi, sameFace, stillLm, tiles, trackLm,
  type ColorState,
} from './vision';

/** Still pictures bigger than this (either side) are left alone. */
const MAX_SIDE = 4096;
/**
 * Animations are left alone past any of these: every frame is tracked, rendered and encoded, so
 * a long or large one would keep the GPU busy for minutes.
 */
const MAX_ANIM_SIDE = 1024;
const MAX_ANIM_FRAMES = 500;
const MAX_ANIM_PIXELS = 150e6;
/** Search tiles smaller than this can't hold a face the landmarker would find. */
const MIN_TILE = 48;
/**
 * Tile sizes searched: down to a quarter of the picture's short side, which finds faces about
 * 1/20 of it tall (a figure in a wide shot). Video stops at half, to stay within a frame.
 */
const TILE_LEVELS = 3;
/** Most faces kept per picture (Max Faces picks among these when rendering). */
const MAX_FACES = 4;
/** In an animation, a thorough search for new faces every this many frames (faces are tracked in between). */
const ANIM_SEARCH_EVERY = 24;
/** A face lost for more than this many frames is done; shorter gaps are filled from the nearest frames. */
const ANIM_HOLD = 12;
/** A face must be seen in this share of an animation's frames (and at least 3) to count. */
const ANIM_MIN_SHARE = 0.1;
/** An animated face's colours are measured on up to this many of its frames. */
const ANIM_COLOR_FRAMES = 8;
/** Pictures that couldn't be used are tried again after this long. */
const RETRY_MS = 24 * 3600 * 1000;
/** Held by whichever tab is using the GPU for a picture. */
const GPU_LOCK = 'moutheyes-image-gpu';
/** Detection runs this long (ms) before the event loop gets a turn (for video frames). */
const SLICE_MS = 10;
/** Colours are measured on a copy of the picture at most this big (long side). */
const SAMPLE_SIDE = 2048;

let renderer: Renderer | null = null;
let canvas: HTMLCanvasElement | null = null;

/** Yields to the event loop (a message, which unlike setTimeout isn't clamped to 4 ms). */
function nextTask(): Promise<void> {
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => resolve();
    ch.port2.postMessage(null);
  });
}

let slice = 0;

/** Gives the event loop a turn once the current slice of work has run SLICE_MS. */
async function breathe() {
  if (performance.now() - slice < SLICE_MS) return;
  await nextTask();
  slice = performance.now();
}

/** The cache makes things faster, but pictures still convert when it can't be used. */
function cached<T>(p: Promise<T>, fallback: T): Promise<T> {
  return p.catch((e) => {
    console.warn('[moutheyes] image cache unavailable:', e);
    return fallback;
  });
}

// ---------------------------------------------------------------- reading pictures
interface Animation {
  frames: ImageBitmap[];
  /** Per frame, how long it shows (ms). */
  delays: number[];
  /** In gifenc's terms: 0 = forever, -1 = once, N = N more times. */
  repeat: number;
}

/** A decoded picture: one frame, or an animation. */
type Picture = { width: number; height: number } & ({ still: ImageBitmap; anim?: undefined } | { anim: Animation; still?: undefined });

function closePicture(p: Picture) {
  p.still?.close();
  p.anim?.frames.forEach((f) => f.close());
}

/** Fetches a picture the page couldn't read itself (host permissions make this CORS-exempt). */
async function fetchFile(url: string): Promise<Blob> {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`unreadable (HTTP ${res.status})`);
  return res.blob();
}

/**
 * The file's real image type from its first bytes, for files a server labelled wrongly (or not
 * at all): browsers show those in <img> anyway, so they get converted too.
 */
async function sniffType(file: Blob): Promise<string | null> {
  const b = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  if (ascii(0, 4) === 'GIF8') return 'image/gif';
  if (b[0] === 0x89 && ascii(1, 4) === 'PNG') return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  if (ascii(4, 8) === 'ftyp' && /^avi[fs]$/.test(ascii(8, 12))) return 'image/avif';
  if (ascii(0, 2) === 'BM') return 'image/bmp';
  return null;
}

/**
 * Decodes a picture file, every frame if it's animated (frames come out whole: the decoder
 * applies GIF disposal and blending).
 */
async function openPicture(file: Blob): Promise<Picture> {
  if (!file.type.startsWith('image/')) {
    const type = await sniffType(file);
    if (!type) throw new Error(`unsupported (${file.type || 'unknown type'})`);
    file = new Blob([file], { type });
  }
  if (file.type === 'image/svg+xml') throw new Error('unsupported (SVG)');
  const Decoder = (self as unknown as { ImageDecoder?: any }).ImageDecoder;
  if (Decoder && (await Decoder.isTypeSupported(file.type).catch(() => false))) {
    const dec = new Decoder({ data: await file.arrayBuffer(), type: file.type });
    try {
      await dec.tracks.ready;
      await dec.completed; // the frame count is final once the whole file is parsed
      const track = dec.tracks.selectedTrack;
      const n: number = track?.frameCount ?? 1;
      if (n > 1) {
        const frames: ImageBitmap[] = [];
        const delays: number[] = [];
        try {
          for (let i = 0; i < n; i++) {
            const { image } = await dec.decode({ frameIndex: i });
            const w: number = image.displayWidth;
            const h: number = image.displayHeight;
            if (i === 0 && (Math.max(w, h) > MAX_ANIM_SIDE || n > MAX_ANIM_FRAMES || w * h * n > MAX_ANIM_PIXELS)) {
              image.close();
              throw new Error(`animation too large (${w}x${h}, ${n} frames)`);
            }
            delays.push(Math.round((image.duration ?? 100_000) / 1000));
            frames.push(await createImageBitmap(image, { premultiplyAlpha: 'none' }));
            image.close();
          }
        } catch (e) {
          frames.forEach((f) => f.close());
          throw e;
        }
        const reps: number = track.repetitionCount;
        const repeat = reps === Infinity ? 0 : reps === 0 ? -1 : reps;
        return { width: frames[0].width, height: frames[0].height, anim: { frames, delays, repeat } };
      }
    } finally {
      dec.close();
    }
  }
  const still = await createImageBitmap(file, { premultiplyAlpha: 'none' });
  if (Math.max(still.width, still.height) > MAX_SIDE) {
    still.close();
    throw new Error(`too large (${still.width}x${still.height})`);
  }
  return { width: still.width, height: still.height, still };
}

// ---------------------------------------------------------------- finding faces
/**
 * Every face in the picture, largest first: every search tile is tried (with the stricter still
 * landmarker), then each face is looked at again in a crop around it, which gives better
 * landmarks than the tile it was found in.
 */
async function findFaces(bitmap: ImageBitmap): Promise<Landmarks[]> {
  const found: Landmarks[] = [];
  for (const box of tiles(bitmap.width, bitmap.height, TILE_LEVELS)) {
    if (box[2] < MIN_TILE) continue;
    for (const L of detectIn(stillLm!, bitmap, box)) if (!found.some((f) => sameFace(f, L))) found.push(L);
    await breathe();
  }
  // A real face is found again when framed differently; texture that only resembled one in a
  // particular tile (folds in a jacket, foliage) usually isn't, and is dropped.
  const refined: Landmarks[] = [];
  for (const L of found) {
    const again = detectIn(stillLm!, bitmap, roi(L)).find((M) => sameFace(L, M));
    if (again && !refined.some((f) => sameFace(f, again))) refined.push(again);
    await breathe();
  }
  return refined.sort((a, b) => eyeSpan(b) - eyeSpan(a)).slice(0, MAX_FACES);
}

/** Per face, its landmarks in each frame of an animation (null where it isn't there). */
type Tracks = (Landmarks | null)[][];

const seenIn = (t: (Landmarks | null)[]) => t.filter((L): L is Landmarks => !!L);

/**
 * Faces through an animation: found by a thorough search every ANIM_SEARCH_EVERY frames and
 * followed frame to frame in crops in between. Then, as in moutheyes-py, short gaps are filled
 * from the nearest frame and the landmarks are smoothed (keeping hard cuts).
 */
async function trackAnimation(frames: ImageBitmap[]): Promise<Tracks> {
  const n = frames.length;
  const tracks: { L: (Landmarks | null)[]; last: Landmarks; missed: number; done: boolean }[] = [];
  for (let i = 0; i < n; i++) {
    const claimed: Landmarks[] = [];
    for (const t of tracks) {
      if (t.done) continue;
      const M = detectIn(trackLm!, frames[i], roi(t.last)).find((m) => sameFace(t.last, m) && !claimed.some((c) => sameFace(c, m)));
      if (M) {
        t.L[i] = M;
        t.last = M;
        t.missed = 0;
        claimed.push(M);
      } else if (++t.missed > ANIM_HOLD) {
        t.done = true;
      }
      await breathe();
    }
    const active = tracks.filter((t) => !t.done);
    if (i % ANIM_SEARCH_EVERY === 0 && active.length < MAX_FACES) {
      for (const L of await findFaces(frames[i])) {
        if (active.some((t) => sameFace(t.last, L))) continue;
        const t = { L: new Array<Landmarks | null>(n).fill(null), last: L, missed: 0, done: false };
        t.L[i] = L;
        tracks.push(t);
      }
    }
  }
  // A face seen only fleetingly is more likely a false detection than a face.
  const minSeen = Math.min(n, Math.max(3, Math.ceil(ANIM_MIN_SHARE * n)));
  return tracks
    .filter((t) => seenIn(t.L).length >= minSeen)
    .map((t) => smoothTrack(fillGaps(t.L)))
    .sort((a, b) => avgSpan(b) - avgSpan(a))
    .slice(0, MAX_FACES);
}

const avgSpan = (t: (Landmarks | null)[]) => {
  const s = seenIn(t);
  return s.reduce((n, L) => n + eyeSpan(L), 0) / s.length;
};

/** Frames between a face's first and last sighting where it was missed get the nearest sighting. */
function fillGaps(t: (Landmarks | null)[]): (Landmarks | null)[] {
  const seen = t.flatMap((L, i) => (L ? [i] : []));
  const first = seen[0];
  const last = seen[seen.length - 1];
  return t.map((L, i) => {
    if (L || i < first || i > last) return L;
    const j = seen.reduce((best, k) => (Math.abs(k - i) < Math.abs(best - i) ? k : best), first);
    return t[j];
  });
}

/** Light temporal smoothing (weighted 3-tap), skipped across a jump of a quarter mouth width (a cut). */
function smoothTrack(t: (Landmarks | null)[]): (Landmarks | null)[] {
  const meanDiff = (a: Landmarks, b: Landmarks) => {
    let s = 0;
    for (let k = 0; k < a.length; k++) s += Math.abs(a[k] - b[k]);
    return s / a.length;
  };
  return t.map((L, i) => {
    const prev = t[i - 1];
    const next = t[i + 1];
    if (!L || !prev || !next) return L;
    const scale = mouthWidth(L);
    if (Math.max(meanDiff(prev, L), meanDiff(next, L)) >= 0.25 * scale) return L;
    const out = new Float32Array(L.length);
    for (let k = 0; k < L.length; k++) out[k] = 0.25 * prev[k] + 0.5 * L[k] + 0.25 * next[k];
    return out;
  });
}

// ---------------------------------------------------------------- rendering
function prepare(width: number, height: number): Renderer {
  canvas ??= document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  renderer ??= new Renderer(canvas, { alpha: true });
  return renderer;
}

function faceGeom(id: number, L: Landmarks, colors: ColorState, o: ImageOptions): FaceGeom {
  return {
    id,
    mouth: mouthGeom(L),
    eyes: eyeSpots(L),
    scale: o.mouthScale,
    gains: [[1, 1, 1], [1, 1, 1]],
    skin: colorModel(colors.skin),
    lips: colorModel(colors.lips),
    echo: false,
  };
}

/** Draws the moutheyes version of a still picture and encodes it (WebP, keeping any transparency). */
async function renderStill(bitmap: ImageBitmap, faces: Landmarks[], o: ImageOptions): Promise<Blob> {
  const r = prepare(bitmap.width, bitmap.height);
  const smp = grabSample(bitmap, SAMPLE_SIDE);
  const geoms = faces.slice(0, o.maxFaces).map((L, i) => {
    const colors: ColorState = { L, skin: null, lips: null };
    measureColors(colors, smp);
    const face = faceGeom(i, L, colors, o);
    if (o.skinMatch) measureGains([[1, 1, 1], [1, 1, 1]], face, smp, bitmap.width, bitmap.height, 1);
    return face;
  });
  r.uploadFrame(bitmap);
  r.render(geoms, { skinGate: o.skinMatch, filter: o.objectFilter });
  return new Promise((resolve, reject) =>
    canvas!.toBlob((b) => (b ? resolve(b) : reject(new Error('could not encode the picture'))), 'image/webp', 0.92));
}

/** Whether any pixel of the frame is see-through. */
function hasAlpha(bitmap: ImageBitmap): boolean {
  const px = grabSample(bitmap).px;
  for (let i = 3; i < px.length; i += 4) if (px[i] < 255) return true;
  return false;
}

/**
 * Draws every frame of an animation with moutheyes and encodes the result as an animated GIF
 * with the original timing and looping (each frame with its own 256-colour palette; 1-bit
 * transparency if the original has any).
 */
async function renderAnimation(anim: Animation, tracks: Tracks, o: ImageOptions): Promise<Blob> {
  const { frames } = anim;
  const W = frames[0].width;
  const H = frames[0].height;
  const r = prepare(W, H);
  const faces = tracks.slice(0, o.maxFaces);
  // Each face's colours, pooled over a few of its frames (as moutheyes-py does).
  const colors = faces.map((t) => {
    const seen = t.flatMap((L, i) => (L ? [i] : []));
    const state: ColorState = { L: t[seen[0]]!, skin: null, lips: null };
    const step = Math.max(1, Math.floor(seen.length / ANIM_COLOR_FRAMES));
    for (let k = 0; k < seen.length; k += step) {
      state.L = t[seen[k]]!;
      measureColors(state, grabSample(frames[seen[k]], SAMPLE_SIDE));
    }
    return state;
  });
  const gains = faces.map((): [number, number, number][] => [[1, 1, 1], [1, 1, 1]]);
  const transparent = hasAlpha(frames[0]);
  const format = transparent ? 'rgba4444' : 'rgb565';
  const gif = GIFEncoder();
  for (let i = 0; i < frames.length; i++) {
    const smp = o.skinMatch ? grabSample(frames[i], SAMPLE_SIDE) : null;
    const geoms = faces.flatMap((t, f) => {
      const L = t[i];
      if (!L) return [];
      const face = faceGeom(f, L, colors[f], o);
      if (smp) measureGains(gains[f], face, smp, W, H);
      return [face];
    });
    r.uploadFrame(frames[i]);
    r.render(geoms, { skinGate: o.skinMatch, filter: o.objectFilter });
    const px = r.readPixels();
    const palette = quantize(px, 256, { format, oneBitAlpha: transparent });
    const index = applyPalette(px, palette, format);
    const clear = transparent ? palette.findIndex((c) => c[3] === 0) : -1;
    gif.writeFrame(index, W, H, {
      palette,
      delay: anim.delays[i],
      repeat: anim.repeat,
      transparent: clear >= 0,
      transparentIndex: Math.max(0, clear),
      // Frames are whole pictures; with transparency, each must clear the one before it.
      dispose: transparent ? 2 : -1,
    });
    await breathe();
  }
  gif.finish();
  return new Blob([gif.bytes()], { type: 'image/gif' });
}

// ---------------------------------------------------------------- converting
/**
 * The moutheyes version of a picture: from the cache when it's there, otherwise made (and
 * cached). `file` is the picture when the page could read it; otherwise it's fetched here.
 */
export async function convertImage(url: string, file: Blob | null, o: ImageOptions): Promise<ImageResult> {
  try {
    const key = await cacheKey(url);
    const okey = outputKey(o);
    const now = Date.now();
    const entry: ImageEntry | undefined = key ? await cached(getEntry(key), undefined) : undefined;
    // Builds before animation support recorded animated pictures as errors; those are redone.
    const retry = !entry?.error || entry.error === 'animated' || now - entry.checked >= RETRY_MS;
    if (entry?.error && !retry) return { faces: 0, blob: null, cached: true, error: entry.error };
    if (entry && !entry.error) {
      if (!entry.faces.length) return { faces: 0, blob: null, cached: true };
      const stored = entry.outputs[okey] && (await cached(readOutput(entry.outputs[okey].url), null));
      if (stored) {
        await cached(putEntry({ ...entry, lastUsed: now }), undefined);
        return { faces: Math.min(entry.faces.length, o.maxFaces), blob: stored, cached: true };
      }
    }

    let pic: Picture;
    try {
      pic = await openPicture(file ?? (await fetchFile(url)));
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      if (key) await cached(putEntry({ key, checked: now, lastUsed: now, width: 0, height: 0, faces: [], error, outputs: {} }), undefined);
      return { faces: 0, blob: null, cached: false, error };
    }
    try {
      // What's known about the picture's faces is reused if it's still the same kind of picture.
      const known = entry && !entry.error && !!entry.animation === !!pic.anim ? entry : undefined;
      return await navigator.locks.request(GPU_LOCK, async () => {
        slice = performance.now();
        await loadStillLandmarker();
        let e: ImageEntry;
        let blob: Blob | null = null;
        if (pic.anim) {
          const tracks = known?.animation?.tracks ?? (await trackAnimation(pic.anim.frames));
          e = known
            ? { ...known, lastUsed: Date.now() }
            : {
                key: key ?? '', checked: Date.now(), lastUsed: Date.now(), width: pic.width, height: pic.height,
                faces: tracks.map((t) => seenIn(t)[0]), animation: { frames: pic.anim.frames.length, tracks }, outputs: {},
              };
          if (tracks.length) blob = await renderAnimation(pic.anim, tracks, o);
        } else {
          const faces = known?.faces ?? (await findFaces(pic.still));
          e = known
            ? { ...known, lastUsed: Date.now() }
            : { key: key ?? '', checked: Date.now(), lastUsed: Date.now(), width: pic.width, height: pic.height, faces, outputs: {} };
          if (faces.length) blob = await renderStill(pic.still, faces, o);
        }
        if (!blob) {
          if (key) await cached(putEntry(e), undefined);
          return { faces: 0, blob: null, cached: false };
        }
        if (key) await cached(writeOutput(e, okey, blob), undefined);
        return { faces: Math.min(e.faces.length, o.maxFaces), blob, cached: false };
      });
    } finally {
      closePicture(pic);
    }
  } catch (e) {
    return { faces: 0, blob: null, cached: false, error: e instanceof Error ? e.message : String(e) };
  }
}
