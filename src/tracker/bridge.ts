// Content-script side of the face tracker: owns the hidden host iframe, keeps at most one video
// frame in flight so tracking never queues up behind playback, and passes pictures to convert.
import type { FaceGeom } from '../shared/face';
import type { FromHost, HostTokenMessage, ImageOptions, ImageResult, ToHost, TrackOptions } from '../shared/protocol';

export interface TrackResult {
  bitmap: ImageBitmap;
  faces: FaceGeom[];
  searching: boolean;
  ms: number;
}

type State = 'idle' | 'loading' | 'ready' | 'failed';

/** Give up if the tracker hasn't come up by then. */
const LOAD_TIMEOUT_MS = 30_000;

class TrackerBridge {
  state: State = 'idle';
  error = '';
  provider = '';
  busy = false;
  private port: MessagePort | null = null;
  private iframe: HTMLIFrameElement | null = null;
  private nextId = 1;
  private pending = new Map<number, (r: TrackResult | null) => void>();
  private images = new Map<number, (r: ImageResult) => void>();
  private connected: Promise<void> | null = null;
  private readyWaiters: Array<(ok: boolean) => void> = [];
  private loadTimer = 0;

  /** Loads the face landmarkers if needed. Resolves true when video tracking is usable. */
  ensureLoaded(): Promise<boolean> {
    if (this.state === 'ready') return Promise.resolve(true);
    // A failed load (a timeout in a background tab, a hiccup) is tried again on the next start
    // rather than ruling moutheyes out on this page until it's reloaded.
    if (this.state === 'failed') {
      this.state = 'idle';
      this.connected = null;
    }
    const p = new Promise<boolean>((r) => this.readyWaiters.push(r));
    if (this.state === 'idle') {
      this.state = 'loading';
      this.loadTimer = window.setTimeout(() => this.fail('timed out loading the face tracker'), LOAD_TIMEOUT_MS);
      this.connect().then(() => this.post({ type: 'init' }));
    }
    return p;
  }

  /** Adds the host iframe and connects to it (without loading the landmarkers yet). */
  private connect(): Promise<void> {
    this.connected ??= new Promise((resolve) => {
      const iframe = document.createElement('iframe');
      iframe.src = chrome.runtime.getURL('tracker/host.html');
      iframe.setAttribute('aria-hidden', 'true');
      iframe.tabIndex = -1;
      iframe.style.cssText =
        'position:fixed!important;left:-10px!important;top:-10px!important;width:1px!important;' +
        'height:1px!important;opacity:0!important;pointer-events:none!important;border:0!important;';
      iframe.addEventListener('load', async () => {
        // The host only accepts a connection with a token registered first (see background.ts).
        const token = crypto.randomUUID();
        const msg: HostTokenMessage = { type: 'host-token', token };
        try {
          await chrome.runtime.sendMessage(msg);
        } catch {
          return resolve(); // the extension was reloaded; this script is on its way out
        }
        const channel = new MessageChannel();
        this.port = channel.port1;
        this.port.onmessage = (e: MessageEvent<FromHost>) => this.onMessage(e.data);
        const origin = new URL(chrome.runtime.getURL('')).origin;
        iframe.contentWindow!.postMessage({ type: 'moutheyes-connect', token }, origin, [channel.port2]);
        resolve();
      });
      (document.body ?? document.documentElement).appendChild(iframe);
      this.iframe = iframe;
    });
    return this.connected;
  }

  /** Converts a picture (see convertImage() in stills.ts). Never rejects. */
  async image(url: string, file: Blob | null, opts: ImageOptions): Promise<ImageResult> {
    await this.connect();
    if (!this.port) return { faces: 0, blob: null, cached: false, error: this.error || 'tracker unavailable' };
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.images.set(id, resolve);
      this.post({ type: 'image', id, url, file, opts });
    });
  }

  private fail(message: string) {
    if (this.state !== 'loading') return;
    clearTimeout(this.loadTimer);
    this.state = 'failed';
    this.error = message;
    this.iframe?.remove();
    this.iframe = null;
    this.port = null;
    this.connected = Promise.resolve();
    this.readyWaiters.splice(0).forEach((r) => r(false));
    this.images.forEach((r) => r({ faces: 0, blob: null, cached: false, error: message }));
    this.images.clear();
  }

  private post(msg: ToHost, transfer: Transferable[] = []) {
    this.port?.postMessage(msg, transfer);
  }

  private onMessage(msg: FromHost) {
    switch (msg.type) {
      case 'ready':
        clearTimeout(this.loadTimer);
        this.provider = msg.provider;
        this.state = 'ready';
        this.readyWaiters.splice(0).forEach((r) => r(true));
        break;
      case 'error':
        this.fail(msg.message);
        break;
      case 'faces':
        this.resolve(msg.id, { bitmap: msg.bitmap, faces: msg.faces, searching: msg.searching, ms: msg.ms });
        break;
      case 'image-done': {
        const { type: _, id, ...result } = msg;
        this.images.get(id)?.(result);
        this.images.delete(id);
        break;
      }
      case 'frame-error':
        console.warn('[moutheyes] tracking failed:', msg.message);
        msg.bitmap?.close();
        this.resolve(msg.id, null);
        break;
    }
  }

  private resolve(id: number, r: TrackResult | null) {
    const cb = this.pending.get(id);
    this.pending.delete(id);
    this.busy = false;
    if (cb) cb(r);
    else r?.bitmap.close();
  }

  /**
   * Sends a frame for tracking; the result carries the same frame back. Resolves null if busy,
   * not ready, or tracking failed.
   */
  track(stream: number, bitmap: ImageBitmap, time: number, reset: boolean, opts: TrackOptions): Promise<TrackResult | null> {
    if (this.state !== 'ready' || this.busy) {
      bitmap.close();
      return Promise.resolve(null);
    }
    this.busy = true;
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.post({ type: 'frame', id, stream, time, reset, bitmap, opts }, [bitmap]);
    });
  }
}

export const tracker = new TrackerBridge();
