// One active moutheyes video: an overlay canvas over a <video>, its capture loop and its share
// of the face tracker. Each frame is shown only once it comes back from the tracker with its
// faces, so the mouths always sit exactly where the eyes are in that frame.
//
// Other extensions can use the result in place of the video's own pixels (the 2D-3D Video
// Converter does): while it's on, the video carries data-moutheyes="<canvas id>", and the video
// fires "moutheyes:change" when that turns on or off and "moutheyes:frame" after every new
// frame. The canvas holds the whole frame at the video's resolution, letterboxed by CSS
// object-fit like the video itself.
import { Renderer, TaintedVideoError, taintedVideoMessage, taintedVideoReason } from '../render/renderer';
import type { FaceGeom } from '../shared/face';
import type { Settings } from '../shared/settings';
import { tracker, type TrackResult } from '../tracker/bridge';
import type { Overlay } from './ui';

/** Frames bigger than this (long side) are scaled down before tracking and display. */
const MAX_CAPTURE_SIDE = 1920;

let nextStream = 1;

/** Whether the browser lets us read this bitmap's pixels (it won't for cross-origin video). */
function isReadable(bitmap: ImageBitmap): boolean {
  // A fresh canvas each time: drawing an unreadable bitmap taints a canvas for good.
  const probe = new OffscreenCanvas(1, 1).getContext('2d')!;
  probe.drawImage(bitmap, 0, 0, 1, 1);
  try {
    probe.getImageData(0, 0, 1, 1);
    return true;
  } catch {
    return false;
  }
}

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
  private trackMsAvg = 0;
  private trackFailed = '';
  /** The video source whose pixels we've confirmed we may read. */
  private readableSrc: string | null = null;
  private statsEl: HTMLDivElement | null = null;
  private renderFrames = 0;
  private statsTimer = 0;
  private listeners: Array<() => void> = [];

  constructor(
    readonly video: HTMLVideoElement,
    private settings: Settings,
    private overlay: Overlay,
    private onEnd: (s: Session) => void,
    /** Turned on by hand, so failures get a toast (on its own, only the popup says why). */
    private announce = true,
  ) {
    this.renderer = new Renderer(this.canvas);
  }

  /** Why the session stopped on its own, if it did. */
  get failure(): string {
    return this.trackFailed;
  }

  get faceCount(): number {
    return this.faces.length;
  }

  start() {
    if (this.video.mediaKeys) throw new TaintedVideoError('encrypted media');
    this.canvas.className = 'moutheyes-canvas';
    this.canvas.id = `moutheyes-${this.stream}`;
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
    if (this.video.dataset.moutheyes === this.canvas.id) {
      delete this.video.dataset.moutheyes;
      this.video.dispatchEvent(new Event('moutheyes:change'));
    }
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
    this.renderer.clearHistory();
    this.reset = true;
  }

  private tick = () => {
    this.raf = requestAnimationFrame(this.tick);
    const v = this.video;
    if (!v.isConnected) return this.stop();
    this.layout();
    if (v.readyState < 2 || !v.videoWidth) return;
    const frameChanged = this.newFrame || !('requestVideoFrameCallback' in v);
    if (frameChanged && !this.capturing && tracker.state === 'ready' && !tracker.busy) this.capture();
  };

  /** The browser won't let us read the video's pixels: say why and turn off. */
  private failTainted() {
    if (this.announce) this.overlay.toast(taintedVideoMessage(this.video), 7000);
    this.trackFailed = taintedVideoReason(this.video);
    this.stop();
  }

  /** Grabs the current video frame and sends it through the tracker. */
  private async capture() {
    const v = this.video;
    this.capturing = true;
    this.newFrame = false;
    const reset = this.reset;
    const time = v.currentTime;
    this.reset = false;
    const k = Math.min(1, MAX_CAPTURE_SIDE / Math.max(v.videoWidth, v.videoHeight));
    const s = this.settings;
    let result: TrackResult | null = null;
    try {
      let bitmap: ImageBitmap;
      try {
        bitmap = await createImageBitmap(v, k < 1
          ? { resizeWidth: Math.round(v.videoWidth * k), resizeHeight: Math.round(v.videoHeight * k), resizeQuality: 'medium' }
          : {});
      } catch (e) {
        // tick() only captures once the video has a frame, so this means the browser won't
        // let us read it (Chrome reports a cross-origin video as InvalidStateError here).
        if (e instanceof DOMException && (e.name === 'SecurityError' || e.name === 'InvalidStateError')) {
          return this.failTainted();
        }
        throw e;
      }
      // A cross-origin video still gives a bitmap, just one nothing may read (posting it to the
      // tracker fails with a DataCloneError), so check once per source.
      if (this.readableSrc !== v.currentSrc) {
        if (!isReadable(bitmap)) {
          bitmap.close();
          return this.failTainted();
        }
        this.readableSrc = v.currentSrc;
      }
      result = await tracker.track(this.stream, bitmap, time, reset, {
        mouthScale: s.mouthScale,
        maxFaces: s.maxFaces,
        smoothing: s.smoothing,
        skinMatch: s.skinMatch,
        objectFilter: s.objectFilter,
      });
    } catch (e) {
      console.warn('[moutheyes] frame capture failed:', e);
    } finally {
      this.capturing = false;
    }
    if (!result) return;
    if (this.stopped) return result.bitmap.close();
    try {
      const c = this.canvas;
      if (c.width !== result.bitmap.width || c.height !== result.bitmap.height) {
        c.width = result.bitmap.width;
        c.height = result.bitmap.height;
      }
      this.renderer.uploadFrame(result.bitmap);
    } catch (e) {
      if (e instanceof TaintedVideoError) return this.failTainted();
      throw e;
    } finally {
      result.bitmap.close();
    }
    this.faces = result.faces;
    if (result.searching && this.video.paused) this.newFrame = true;
    this.trackMsAvg = this.trackMsAvg ? this.trackMsAvg * 0.9 + result.ms * 0.1 : result.ms;
    const echo = s.mouthEcho;
    if (echo > 0) this.renderer.record(this.faces, time);
    else this.renderer.clearHistory();
    // Exposed for debugging and the e2e test: the shown frame's video time, and its echoed eyes.
    this.canvas.dataset.frameTime = time.toFixed(3);
    this.canvas.dataset.echoedEyes = String(this.renderer.render(this.faces, { time, echo, skinGate: s.skinMatch, filter: s.objectFilter }));
    this.renderFrames++;
    if (this.video.dataset.moutheyes !== this.canvas.id) {
      this.canvas.style.visibility = 'visible';
      this.video.dataset.moutheyes = this.canvas.id;
      this.video.dispatchEvent(new Event('moutheyes:change'));
    }
    this.video.dispatchEvent(new Event('moutheyes:frame'));
  }

  /** Keeps the canvas over the video, letterboxed the same way. */
  private layout() {
    const v = this.video;
    const st = this.canvas.style;
    const cs = getComputedStyle(v);
    st.left = `${v.offsetLeft}px`;
    st.top = `${v.offsetTop}px`;
    st.width = `${v.offsetWidth}px`;
    st.height = `${v.offsetHeight}px`;
    st.objectFit = cs.objectFit;
    st.objectPosition = cs.objectPosition;
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
