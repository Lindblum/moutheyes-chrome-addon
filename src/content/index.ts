// Content script entry: finds videos, wires the hover button and keyboard shortcut, manages one
// Session per moutheyes video, runs picture conversion, and answers the popup.
import { TaintedVideoError } from '../render/renderer';
import type { FrameStatus } from '../shared/protocol';
import { DEFAULT_SETTINGS, loadSettings, onSettingsChanged, type Settings } from '../shared/settings';
import { ImageConverter } from './images';
import { Session } from './session';
import { Overlay } from './ui';

const MIN_W = 200;
const MIN_H = 112;
/** How often (ms) a content script checks that the extension it belongs to is still loaded. */
const ALIVE_POLL_MS = 2000;

/** What the popup calls in each frame (through chrome.scripting, in this isolated world). */
export interface MoutheyesApi {
  build: string;
  /** Whether the extension it belongs to is still loaded (it tears itself down if not). */
  alive(): boolean;
  status(): FrameStatus;
  /** Turns moutheyes on or off for this frame's main video. */
  toggle(): FrameStatus;
  /** Turns moutheyes on for this frame's main video unless a video here already has it. */
  start(): FrameStatus;
  /** Turns moutheyes off for every video in this frame. */
  stop(): FrameStatus;
  /** Removes everything this content script added and stops it. */
  teardown(): void;
}

declare global {
  interface Window {
    __moutheyes?: MoutheyesApi;
  }
}

// This script can arrive twice: from the manifest, and injected by the background script (on
// install or reload) or the popup (into a tab that didn't answer). A working one of the same
// build stays. One from an older build, or cut off from the extension by a reload (it can't
// answer the popup any more), is replaced; one in another world notices on its own (alive()).
const existing = window.__moutheyes;
if (!existing || existing.build !== __BUILD_ID__ || !existing.alive()) {
  existing?.teardown();
  window.__moutheyes = main();
}

function main(): MoutheyesApi {
  let settings: Settings = DEFAULT_SETTINGS;
  const sessions = new Map<HTMLVideoElement, Session>();
  let overlay: Overlay | null = null;
  let hovered: HTMLVideoElement | null = null;
  const listeners = new AbortController();
  const signal = listeners.signal;

  // Pictures only in the top frame: every frame would need its own tracker otherwise, and
  // embedded frames are mostly ads.
  const isTop = window === window.top;
  // Picture work waits while a moutheyes video is playing, so it never costs video frames.
  const videoPlaying = () => [...sessions.keys()].some((v) => !v.paused);
  let images: ImageConverter | null = null;
  /** Why moutheyes last failed to start, or stopped on its own (shown in the popup). */
  let lastError = '';
  const videosOn = () => settings.enabled && settings.videos;

  function apply(s: Settings) {
    if (signal.aborted) return;
    settings = s;
    if (!videosOn()) {
      sessions.forEach((sess) => sess.stop());
      overlay?.hideButton();
    }
    sessions.forEach((sess) => sess.applySettings(s));
    if (s.enabled && s.images && isTop) {
      images ??= new ImageConverter(s, videoPlaying);
      images.applySettings(s);
      images.start();
    } else {
      images?.stop();
    }
  }
  loadSettings().then(apply);
  onSettingsChanged(apply);

  function teardown() {
    if (signal.aborted) return;
    listeners.abort();
    clearInterval(aliveTimer);
    sessions.forEach((s) => s.stop());
    images?.stop();
    overlay?.dispose();
    if (window.__moutheyes === api) delete window.__moutheyes;
  }

  /** False once the extension has been reloaded or removed; this script then cleans up after itself. */
  function alive(): boolean {
    if (chrome.runtime?.id) return true;
    teardown();
    return false;
  }
  const aliveTimer = window.setInterval(alive, ALIVE_POLL_MS);

  const ui = () => (overlay ??= new Overlay(toggle));

  function candidates(): HTMLVideoElement[] {
    return allVideos(document).filter((v) => {
      const r = v.getBoundingClientRect();
      return r.width >= MIN_W && r.height >= MIN_H;
    });
  }

  /** How much of a video is on screen, counting playing videos double. */
  function prominence(v: HTMLVideoElement): number {
    const r = v.getBoundingClientRect();
    const w = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0));
    const h = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
    return w * h * (v.paused ? 1 : 2);
  }

  /** The video a shortcut or popup click should act on: the one under the mouse, else the most prominent. */
  function primary(): HTMLVideoElement | null {
    const all = candidates();
    // The hovered video counts only while it's still showing (players hide their hover previews).
    if (hovered && all.includes(hovered)) return hovered;
    return all.sort((a, b) => prominence(b) - prominence(a))[0] ?? null;
  }

  function toggle(video: HTMLVideoElement): boolean {
    if (!alive()) return false;
    const on = flip(video);
    if (video === hovered) ui().showButton(video, on);
    return on;
  }

  /** Turns moutheyes on or off for this video. Returns whether it is now on. */
  function flip(video: HTMLVideoElement): boolean {
    const existing = sessions.get(video);
    if (existing) {
      existing.stop();
      ui().toast('Moutheyes off', 1500);
      return false;
    }
    let session: Session | null = null;
    try {
      session = new Session(video, settings, ui(), (s) => {
        sessions.delete(s.video);
        if (s.failure) lastError = s.failure;
      });
      session.start();
    } catch (e) {
      session?.stop();
      if (e instanceof TaintedVideoError) {
        lastError = "this video is protected (DRM), so the browser won't let the extension read its pixels";
        ui().toast("This video is protected (DRM), so the browser won't let the extension read its pixels.", 7000);
      } else {
        lastError = e instanceof Error ? e.message : String(e);
        ui().toast(`Moutheyes failed to start: ${lastError}`, 7000);
        console.error('[moutheyes]', e);
      }
      return false;
    }
    lastError = '';
    sessions.set(video, session);
    ui().toast('Moutheyes on', 2000);
    return true;
  }

  // Hover button: hit-test videos on mouse move (once per animation frame).
  let moveQueued = false;
  let lastPoint = { x: 0, y: 0 };
  document.addEventListener(
    'mousemove',
    (e) => {
      lastPoint = { x: e.clientX, y: e.clientY };
      if (moveQueued) return;
      moveQueued = true;
      requestAnimationFrame(() => {
        moveQueued = false;
        const { x, y } = lastPoint;
        if (!videosOn() || !alive()) return;
        hovered = candidates().find((v) => {
          const r = v.getBoundingClientRect();
          return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
        }) ?? null;
        if (hovered) ui().showButton(hovered, sessions.has(hovered));
      });
    },
    { passive: true, signal },
  );

  // Alt+Shift+E toggles moutheyes on the hovered (or largest) video. Handled in-page so it
  // works inside the site's own fullscreen too.
  window.addEventListener(
    'keydown',
    (e) => {
      if (!e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey || e.code !== 'KeyE' || !videosOn()) return;
      const video = primary();
      if (!video) return;
      e.preventDefault();
      e.stopPropagation();
      toggle(video);
    },
    { capture: true, signal },
  );

  function status(): FrameStatus {
    const main = primary();
    let faces = 0;
    sessions.forEach((s) => (faces += s.faceCount));
    return {
      videos: candidates().length,
      active: sessions.size,
      faces,
      images: images?.count ?? 0,
      score: main ? prominence(main) : 0,
      buildId: __BUILD_ID__,
      error: lastError || undefined,
    };
  }

  const api: MoutheyesApi = {
    build: __BUILD_ID__,
    alive,
    status,
    toggle() {
      const v = primary();
      if (v && videosOn()) toggle(v);
      return status();
    },
    start() {
      const v = primary();
      if (v && videosOn() && !sessions.size) toggle(v);
      return status();
    },
    stop() {
      sessions.forEach((s) => toggle(s.video));
      return status();
    },
    teardown,
  };
  return api;
}

/** Shadow roots on the page, found at most once a second (walking every element is not free). */
let shadowRoots: ShadowRoot[] = [];
let shadowScan = 0;

/** Every video in the document, including those inside (open) shadow roots, as some players use. */
function allVideos(doc: Document): HTMLVideoElement[] {
  if (performance.now() - shadowScan > 1000) {
    shadowScan = performance.now();
    shadowRoots = [];
    const walk = (root: Document | ShadowRoot) => {
      for (const el of root.querySelectorAll('*')) {
        if (!el.shadowRoot) continue;
        shadowRoots.push(el.shadowRoot);
        walk(el.shadowRoot);
      }
    };
    walk(doc);
  }
  return [doc, ...shadowRoots].flatMap((root) => [...root.querySelectorAll('video')]);
}
