// One active moutheyes video: an overlay canvas over a <video>, its capture loop and its share
// of the face tracker. Each frame is shown only once it comes back from the tracker with its
// faces, so the mouths always sit exactly where the eyes are in that frame.
import { Renderer, TaintedVideoError } from '../render/renderer';
import type { FaceGeom } from '../shared/face';
import type { Settings } from '../shared/settings';
import { tracker, type TrackResult } from '../tracker/bridge';
import type { Overlay } from './ui';

/** Frames bigger than this (long side) are scaled down before tracking and display. */
const MAX_CAPTURE_SIDE = 1920;

let nextStream = 1;

export class Session {
  readonly canvas = document.createElement('canvas');
  private renderer: Renderer;
  private stream = nextStream++;
  private raf = 0;
  private newFrame = true;
  private capturing = false;
  /** Drop the tracker's smoothing history with the next frame (seek, new source). */
  private reset = true;
  private stopped = false;
  private faces: FaceGeom[] = [];
  private lastBox = '';
  private trackMsAvg = 0;
  private trackFailed = '';
  private statsEl: HTMLDivElement | null = null;
  private renderFrames = 0;
  private statsTimer = 0;
  private listeners: Array<() => void> = [];

  constructor(
    readonly video: HTMLVideoElement,
    private settings: Settings,
    private overlay: Overlay,
    private onEnd: (s: Session) => void,
  ) {
    this.renderer = new Renderer(this.canvas);
  }

  get faceCount(): number {
    return this.faces.length;
  }

  start() {
    if (this.video.mediaKeys) throw new TaintedVideoError('encrypted media');
    this.canvas.className = 'moutheyes-canvas';
    // Hidden until the first tracked frame is ready; the video shows through until then.
    this.canvas.style.cssText = 'position:absolute;pointer-events:none;display:block;background:#000;margin:0;padding:0;border:0;visibility:hidden;';
    const z = getComputedStyle(this.video).zIndex;
    if (z !== 'auto') this.canvas.style.zIndex = z;
    this.video.insertAdjacentElement('afterend', this.canvas);

    this.on(this.video, 'seeked', () => this.onDiscontinuity());
    this.on(this.video, 'emptied', () => this.onDiscontinuity());
    this.watchFrames();
    this.applySettings(this.settings);
    this.statsTimer = window.setInterval(() => this.updateStats(), 1000);
    this.raf = requestAnimationFrame(this.tick);
    tracker.ensureLoaded().then((ok) => {
      if (ok || this.stopped) return;
      this.trackFailed = tracker.error;
      this.overlay.toast(`Face tracker unavailable (${tracker.error}).`, 6000);
      this.stop();
    });
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    cancelAnimationFrame(this.raf);
    clearInterval(this.statsTimer);
    this.listeners.forEach((off) => off());
    this.renderer.dispose();
    this.canvas.remove();
    this.statsEl?.remove();
    this.onEnd(this);
  }

  applySettings(s: Settings) {
    this.settings = s;
    // Mouth size and the rest only reach the picture with the next tracked frame.
    this.newFrame = true;
    if (s.showStats && !this.statsEl) this.statsEl = this.overlay.createStats();
    if (!s.showStats && this.statsEl) {
      this.statsEl.remove();
      this.statsEl = null;
    }
  }

  private on(target: EventTarget, type: string, fn: EventListener) {
    target.addEventListener(type, fn);
    this.listeners.push(() => target.removeEventListener(type, fn));
  }

  private watchFrames() {
    const v = this.video;
    if (!('requestVideoFrameCallback' in v)) return; // fall back to capturing every tick
    let handle = 0;
    const cb = () => {
      this.newFrame = true;
      handle = v.requestVideoFrameCallback(cb);
    };
    handle = v.requestVideoFrameCallback(cb);
    this.listeners.push(() => v.cancelVideoFrameCallback(handle));
  }

  private onDiscontinuity() {
    this.newFrame = true;
    this.reset = true;
  }

  private tick = () => {
    this.raf = requestAnimationFrame(this.tick);
    const v = this.video;
    if (!v.isConnected) return this.stop();
    if (this.layout() && this.renderer.hasFrame) this.draw();
    if (v.readyState < 2 || !v.videoWidth) return;
    const frameChanged = this.newFrame || !('requestVideoFrameCallback' in v);
    if (frameChanged && !this.capturing && tracker.state === 'ready' && !tracker.busy) this.capture();
  };

  /** Grabs the current video frame and sends it through the tracker. */
  private async capture() {
    const v = this.video;
    this.capturing = true;
    this.newFrame = false;
    const reset = this.reset;
    this.reset = false;
    const k = Math.min(1, MAX_CAPTURE_SIDE / Math.max(v.videoWidth, v.videoHeight));
    const s = this.settings;
    let result: TrackResult | null = null;
    try {
      const bitmap = await createImageBitmap(v, k < 1
        ? { resizeWidth: Math.round(v.videoWidth * k), resizeHeight: Math.round(v.videoHeight * k), resizeQuality: 'medium' }
        : {});
      result = await tracker.track(this.stream, bitmap, v.currentTime, reset, {
        mouthScale: s.mouthScale,
        maxFaces: s.maxFaces,
        smoothing: s.smoothing,
        skinMatch: s.skinMatch,
      });
    } catch (e) {
      console.warn('[moutheyes] frame capture failed:', e);
    } finally {
      this.capturing = false;
    }
    if (!result) return;
    if (this.stopped) return result.bitmap.close();
    try {
      this.renderer.uploadFrame(result.bitmap);
    } catch (e) {
      if (e instanceof TaintedVideoError) {
        this.overlay.toast("This video is protected (DRM or cross-origin), so the browser won't let the extension read its pixels.", 7000);
        return this.stop();
      }
      throw e;
    } finally {
      result.bitmap.close();
    }
    this.faces = result.faces;
    if (result.searching && this.video.paused) this.newFrame = true;
    this.trackMsAvg = this.trackMsAvg ? this.trackMsAvg * 0.9 + result.ms * 0.1 : result.ms;
    this.draw();
    this.canvas.style.visibility = 'visible';
  }

  private draw() {
    this.renderer.render(this.faces, this.contentRect());
    this.renderFrames++;
  }

  /** Positions and sizes the canvas over the video. Returns true if anything changed. */
  private layout(): boolean {
    const v = this.video;
    const c = this.canvas;
    const w = v.offsetWidth;
    const h = v.offsetHeight;
    c.style.left = `${v.offsetLeft}px`;
    c.style.top = `${v.offsetTop}px`;
    c.style.width = `${w}px`;
    c.style.height = `${h}px`;
    const dpr = window.devicePixelRatio || 1;
    const bw = Math.min(3840, Math.max(2, Math.round(w * dpr)));
    const bh = Math.min(2160, Math.max(2, Math.round(h * dpr)));
    const key = `${bw}x${bh}:${v.offsetLeft},${v.offsetTop}:${getComputedStyle(v).objectFit}`;
    if (c.width !== bw || c.height !== bh) {
      c.width = bw;
      c.height = bh;
    }
    if (key === this.lastBox) return false;
    this.lastBox = key;
    return true;
  }

  /** Where the video picture sits inside the canvas, honoring object-fit. */
  private contentRect(): [number, number, number, number] {
    const v = this.video;
    const bw = this.canvas.width;
    const bh = this.canvas.height;
    const fit = getComputedStyle(v).objectFit;
    if (fit === 'fill' || !v.videoWidth) return [0, 0, 1, 1];
    const scale = fit === 'cover'
      ? Math.max(bw / v.videoWidth, bh / v.videoHeight)
      : Math.min(bw / v.videoWidth, bh / v.videoHeight);
    const w = (v.videoWidth * scale) / bw;
    const h = (v.videoHeight * scale) / bh;
    return [(1 - w) / 2, (1 - h) / 2, w, h];
  }

  private updateStats() {
    // Exposed on the canvas for debugging and the e2e test.
    this.canvas.dataset.faces = String(this.faces.length);
    this.canvas.dataset.fps = String(this.renderFrames);
    this.canvas.dataset.trackMs = String(Math.round(this.trackMsAvg));
    if (this.trackFailed) this.canvas.dataset.error = this.trackFailed;
    if (this.statsEl) {
      const r = this.video.getBoundingClientRect();
      this.statsEl.style.left = `${Math.max(4, r.right - 220)}px`;
      this.statsEl.style.top = `${Math.max(4, r.top + 12)}px`;
      this.statsEl.textContent = `${tracker.provider || 'loading tracker…'}\n${this.renderFrames} fps · ${Math.round(this.trackMsAvg)} ms\n${this.faces.length} face${this.faces.length === 1 ? '' : 's'}`;
    }
    this.renderFrames = 0;
  }
}
