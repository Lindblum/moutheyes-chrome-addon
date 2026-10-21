// Content script entry: finds videos, wires the hover button, keyboard shortcut and popup
// messages, and manages one Session per moutheyes video.
import { TaintedVideoError } from '../render/renderer';
import type { PopupRequest, PopupStatus } from '../shared/protocol';
import { DEFAULT_SETTINGS, loadSettings, onSettingsChanged, type Settings } from '../shared/settings';
import { Session } from './session';
import { Overlay } from './ui';

const MIN_W = 200;
const MIN_H = 112;

declare global {
  interface Window {
    __moutheyesLoaded?: boolean;
  }
}

if (!window.__moutheyesLoaded) {
  window.__moutheyesLoaded = true;
  main();
}

function main() {
  let settings: Settings = DEFAULT_SETTINGS;
  const sessions = new Map<HTMLVideoElement, Session>();
  let overlay: Overlay | null = null;
  let hovered: HTMLVideoElement | null = null;

  loadSettings().then((s) => (settings = s));
  onSettingsChanged((s) => {
    settings = s;
    sessions.forEach((sess) => sess.applySettings(s));
  });

  const ui = () => (overlay ??= new Overlay(toggle));

  function candidates(): HTMLVideoElement[] {
    return [...document.querySelectorAll('video')].filter((v) => {
      const r = v.getBoundingClientRect();
      return r.width >= MIN_W && r.height >= MIN_H;
    });
  }

  /** The video a shortcut or popup click should act on. */
  function primary(): HTMLVideoElement | null {
    if (hovered?.isConnected) return hovered;
    const area = (v: HTMLVideoElement) => {
      const r = v.getBoundingClientRect();
      const w = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0));
      const h = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
      return w * h * (v.paused ? 1 : 2);
    };
    return candidates().sort((a, b) => area(b) - area(a))[0] ?? null;
  }

  function toggle(video: HTMLVideoElement): boolean {
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
      session = new Session(video, settings, ui(), (s) => sessions.delete(s.video));
      session.start();
    } catch (e) {
      session?.stop();
      if (e instanceof TaintedVideoError) {
        ui().toast("This video is protected (DRM), so the browser won't let the extension read its pixels.", 7000);
      } else {
        ui().toast(`Moutheyes failed to start: ${e instanceof Error ? e.message : e}`, 7000);
        console.error('[moutheyes]', e);
      }
      return false;
    }
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
        hovered = candidates().find((v) => {
          const r = v.getBoundingClientRect();
          return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
        }) ?? null;
        if (hovered) ui().showButton(hovered, sessions.has(hovered));
      });
    },
    { passive: true },
  );

  // Alt+Shift+E toggles moutheyes on the hovered (or largest) video. Handled in-page so it
  // works inside the site's own fullscreen too.
  window.addEventListener(
    'keydown',
    (e) => {
      if (!e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey || e.code !== 'KeyE') return;
      const video = primary();
      if (!video) return;
      e.preventDefault();
      e.stopPropagation();
      toggle(video);
    },
    true,
  );

  chrome.runtime.onMessage.addListener((msg: PopupRequest, _sender, respond: (s: PopupStatus) => void) => {
    // Only frames that actually contain a video answer, so the popup hears from the right one.
    const videos = candidates();
    if (!videos.length) return false;
    if (msg.type === 'toggle') {
      const v = primary();
      if (v) toggle(v);
    }
    let faces = 0;
    sessions.forEach((s) => (faces += s.faceCount));
    respond({ videos: videos.length, active: sessions.size, faces, buildId: __BUILD_ID__ });
    return false;
  });
}
