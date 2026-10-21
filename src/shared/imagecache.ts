// The image cache, shared by every tab (it lives on the extension's origin): which pictures have
// faces (with their landmarks, so a settings change only re-renders), and where the moutheyes
// versions made from them are stored. The index is in IndexedDB; the pictures themselves are in
// Cache Storage. Least recently used pictures are evicted past the limits below.
import type { ImageOptions } from './protocol';

const DB_NAME = 'moutheyes-images';
const STORE = 'images';
const OUTPUTS = 'moutheyes-images-v1';
/** Moutheyes pictures are stored under made-up URLs in this (never fetched) namespace. */
const OUTPUT_ORIGIN = 'https://moutheyes.invalid';
/** Stored moutheyes pictures are evicted, least recently used first, past this many bytes... */
const MAX_BYTES = 256 * 1024 * 1024;
/** ...and pictures (with or without faces) past this many entries. */
const MAX_ENTRIES = 5000;
/** Eviction trims down to this share of the limits, so it doesn't run on every write. */
const TRIM_TO = 0.8;

export interface ImageEntry {
  /** The picture's URL (a hash of it for long data: URLs). */
  key: string;
  /** When its faces were looked for, and when it was last shown. */
  checked: number;
  lastUsed: number;
  width: number;
  height: number;
  /**
   * Landmarks of each face found (flat x, y in picture pixels), largest face first. Empty: none.
   * In an animation, each face as first seen.
   */
  faces: Float32Array[];
  /** For animations: each face's landmarks in every frame (null where it isn't there). */
  animation?: { frames: number; tracks: (Float32Array | null)[][] };
  /** Why the picture couldn't be used (unreadable, animated, ...); it's tried again later. */
  error?: string;
  /** Settings key -> the stored moutheyes picture made with those settings. */
  outputs: Record<string, { url: string; bytes: number }>;
}

/** What a stored moutheyes picture depends on besides the picture itself. */
export function outputKey(o: ImageOptions): string {
  return `s${o.mouthScale.toFixed(2)}-f${o.maxFaces}-k${o.skinMatch ? 1 : 0}-o${o.objectFilter.toFixed(2)}`;
}

async function sha256(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The cache key for a picture URL, or null if it can't be cached (blob: URLs only live as long
 * as their page).
 */
export async function cacheKey(url: string): Promise<string | null> {
  if (url.startsWith('blob:')) return null;
  return url.length > 1024 ? `sha256:${await sha256(url)}` : url;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'key' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  dbPromise.catch(() => (dbPromise = null));
  return dbPromise;
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const req = fn(d.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function getEntry(key: string): Promise<ImageEntry | undefined> {
  return run('readonly', (s) => s.get(key));
}

export async function putEntry(e: ImageEntry): Promise<void> {
  await run('readwrite', (s) => s.put(e));
}

/** The stored moutheyes picture, or null if it has been evicted. */
export async function readOutput(url: string): Promise<Blob | null> {
  const res = await (await caches.open(OUTPUTS)).match(url);
  return res ? res.blob() : null;
}

/** Stores a moutheyes picture for this entry and settings key, and records where it is. */
export async function writeOutput(e: ImageEntry, okey: string, blob: Blob): Promise<void> {
  const url = `${OUTPUT_ORIGIN}/${await sha256(`${e.key}\n${okey}`)}`;
  await (await caches.open(OUTPUTS)).put(url, new Response(blob, { headers: { 'Content-Type': blob.type } }));
  e.outputs[okey] = { url, bytes: blob.size };
  await putEntry(e);
  scheduleTrim();
}

let trimTimer = 0;

function scheduleTrim() {
  clearTimeout(trimTimer);
  trimTimer = self.setTimeout(() => trim().catch((err) => console.warn('[moutheyes] image cache trim failed:', err)), 5000);
}

/** Evicts least recently used pictures until the cache is back under its limits. */
export async function trim(): Promise<void> {
  const entries: ImageEntry[] = await run('readonly', (s) => s.getAll());
  const bytesOf = (e: ImageEntry) => outputBytes(e) + trackBytes(e);
  let bytes = entries.reduce((n, e) => n + bytesOf(e), 0);
  let count = entries.length;
  if (bytes <= MAX_BYTES && count <= MAX_ENTRIES) return;
  const cache = await caches.open(OUTPUTS);
  entries.sort((a, b) => a.lastUsed - b.lastUsed);
  for (const e of entries) {
    if (bytes <= MAX_BYTES * TRIM_TO && count <= MAX_ENTRIES * TRIM_TO) break;
    await Promise.all(Object.values(e.outputs).map((o) => cache.delete(o.url)));
    bytes -= bytesOf(e);
    if (count > MAX_ENTRIES * TRIM_TO) {
      await run('readwrite', (s) => s.delete(e.key));
      count--;
    } else {
      // Over the byte limit only: keep what's known about its faces, drop the pictures (and an
      // animation's per-frame tracks, which are its bulk; it gets tracked again if it comes back).
      const { animation: _, ...rest } = e;
      await putEntry({ ...rest, faces: e.animation ? [] : e.faces, error: e.animation ? 'evicted' : e.error, checked: e.animation ? 0 : e.checked, outputs: {} });
    }
  }
}

const outputBytes = (e: ImageEntry) => Object.values(e.outputs).reduce((n, o) => n + o.bytes, 0);
/** Animations keep landmarks for every frame, which can add up to more than the picture. */
const trackBytes = (e: ImageEntry) =>
  e.animation?.tracks.reduce((n, t) => t.reduce((m, L) => m + (L ? L.byteLength : 0), n), 0) ?? 0;

export interface CacheStats {
  pictures: number;
  withFaces: number;
  bytes: number;
}

export async function cacheStats(): Promise<CacheStats> {
  const entries: ImageEntry[] = await run('readonly', (s) => s.getAll());
  return {
    pictures: entries.length,
    withFaces: entries.filter((e) => e.faces.length).length,
    bytes: entries.reduce((n, e) => n + outputBytes(e) + trackBytes(e), 0),
  };
}

export async function clearCache(): Promise<void> {
  await run('readwrite', (s) => s.clear());
  await caches.delete(OUTPUTS);
}
