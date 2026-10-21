// Content-script side of the face tracker: owns the hidden host iframe and keeps at most one
// frame in flight so tracking never queues up behind playback.
import type { FaceGeom } from '../shared/face';
import type { FromHost, ToHost, TrackOptions } from '../shared/protocol';

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
  private readyWaiters: Array<(ok: boolean) => void> = [];
  private loadTimer = 0;

  /** Starts the tracker if needed. Resolves true when it's usable. */
  ensureLoaded(): Promise<boolean> {
    if (this.state === 'ready') return Promise.resolve(true);
    if (this.state === 'failed') return Promise.resolve(false);
    const p = new Promise<boolean>((r) => this.readyWaiters.push(r));
    if (this.state === 'idle') this.start();
    return p;
  }

  private start() {
    this.state = 'loading';
    const iframe = document.createElement('iframe');
    iframe.src = chrome.runtime.getURL('tracker/host.html');
    iframe.setAttribute('aria-hidden', 'true');
    iframe.tabIndex = -1;
    iframe.style.cssText =
      'position:fixed!important;left:-10px!important;top:-10px!important;width:1px!important;' +
      'height:1px!important;opacity:0!important;pointer-events:none!important;border:0!important;';
    this.loadTimer = window.setTimeout(() => this.fail('timed out loading the face tracker'), LOAD_TIMEOUT_MS);
    iframe.addEventListener('load', () => {
      const channel = new MessageChannel();
      this.port = channel.port1;
      this.port.onmessage = (e: MessageEvent<FromHost>) => this.onMessage(e.data);
      const origin = new URL(chrome.runtime.getURL('')).origin;
      iframe.contentWindow!.postMessage({ type: 'moutheyes-connect' }, origin, [channel.port2]);
      this.post({ type: 'init' });
    });
    (document.body ?? document.documentElement).appendChild(iframe);
    this.iframe = iframe;
  }

  private fail(message: string) {
    if (this.state !== 'loading') return;
    clearTimeout(this.loadTimer);
    this.state = 'failed';
    this.error = message;
    this.iframe?.remove();
    this.iframe = null;
    this.port = null;
    this.readyWaiters.splice(0).forEach((r) => r(false));
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
