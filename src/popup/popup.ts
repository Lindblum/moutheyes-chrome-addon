import { cacheStats, clearCache } from '../shared/imagecache';
import type { MoutheyesApi } from '../content/index';
import type { FrameStatus } from '../shared/protocol';
import { loadSettings, saveSettings, type Settings } from '../shared/settings';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const statusEl = $('status');
const powerBtn = $<HTMLButtonElement>('toggle');

const FORMAT: Partial<Record<keyof Settings, (v: number) => string>> = {
  mouthScale: (v) => `${v.toFixed(2)}×`,
  maxFaces: (v) => String(v),
  smoothing: (v) => (v ? v.toFixed(2) : 'off'),
  objectFilter: (v) => (v ? v.toFixed(2) : 'off'),
  mouthEcho: (v) => (v ? `${v.toFixed(2)} s / ${(2 * v).toFixed(2)} s` : 'off'),
};

/** The tab the popup acts on: the active one (or ?tab=<id>, for tests). */
async function tabId(): Promise<number | null> {
  const param = new URLSearchParams(location.search).get('tab');
  if (param) return Number(param);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

type Command = 'status' | 'start';

/**
 * Runs a content-script command in the tab's frames (all of them, or the given ones) and returns
 * each frame's status; null for frames without a working content script.
 */
async function inFrames(tab: number, cmd: Command, frameIds?: number[]): Promise<{ frameId: number; status: FrameStatus | null }[]> {
  const results = await chrome.scripting.executeScript({
    target: frameIds ? { tabId: tab, frameIds } : { tabId: tab, allFrames: true },
    func: (c: Command) => (window as Window & { __moutheyes?: MoutheyesApi }).__moutheyes?.[c]() ?? null,
    args: [cmd],
  });
  return results.map((r) => ({ frameId: r.frameId, status: (r.result as FrameStatus | null) ?? null }));
}

let injected = false;

/**
 * Every frame's status. A tab with no working content script (open since before the extension
 * was installed or reloaded) gets a fresh one first, so it works without a refresh. Once per
 * popup: some frames (about:blank ones) never answer, and re-injecting is not free.
 */
async function frames(tab: number): Promise<{ frameId: number; status: FrameStatus }[]> {
  let all = await inFrames(tab, 'status');
  if (!injected && all.some((f) => !f.status || f.status.buildId !== __BUILD_ID__)) {
    injected = true;
    await chrome.scripting.executeScript({ target: { tabId: tab, allFrames: true }, files: ['content.js'] }).catch(() => {});
    all = await inFrames(tab, 'status');
  }
  return all.flatMap((f) => (f.status ? [{ frameId: f.frameId, status: f.status }] : []));
}

/** The whole tab: counts summed over its frames. Null if Moutheyes can't run on this page. */
async function tabStatus(): Promise<FrameStatus | null> {
  const tab = await tabId();
  if (tab == null) return null;
  try {
    const all = await frames(tab);
    if (!all.length) return null;
    const sum = (k: 'videos' | 'active' | 'faces' | 'images') => all.reduce((n, f) => n + f.status[k], 0);
    const error = all.find((f) => f.status.error)?.status.error;
    return { videos: sum('videos'), active: sum('active'), faces: sum('faces'), images: sum('images'), score: 0, buildId: __BUILD_ID__, error };
  } catch {
    return null; // chrome:// pages, the web store, ...
  }
}

/**
 * Starts moutheyes on the tab's main video, unless one already has it: the most prominent video
 * in any frame (a video scrolled out of view still counts, after any on screen). A start rather
 * than a toggle, so a repeated click can't undo it.
 */
async function startVideo(): Promise<void> {
  const tab = await tabId();
  if (tab == null) return;
  try {
    const all = await frames(tab);
    if (all.some((f) => f.status.active)) return;
    const target = all.filter((f) => f.status.videos > 0).sort((a, b) => b.status.score - a.status.score)[0];
    if (target) await inFrames(tab, 'start', [target.frameId]);
  } catch {
    // the page went away
  }
}

let enabled = true;
let videosOn = true;
let imagesOn = false;
/** While a click is being carried out (a busy page can take a while to answer). */
let busy = false;

function showStatus(s: FrameStatus | null) {
  if (busy) return; // the click's own result is on its way
  powerBtn.textContent = enabled ? 'On' : 'Off';
  powerBtn.classList.toggle('on', enabled);
  document.body.classList.toggle('off', !enabled);
  if (!enabled) {
    statusEl.textContent = 'Moutheyes is off on every page.';
    return;
  }
  if (!s) {
    statusEl.textContent = "Moutheyes can't run on this page.";
    return;
  }
  const parts: string[] = [];
  if (videosOn) {
    if (s.active) parts.push(`Video on · ${s.faces} face${s.faces === 1 ? '' : 's'} tracked`);
    else if (s.videos) parts.push(`${s.videos} video${s.videos > 1 ? 's' : ''} found`);
    else parts.push('No video found');
  }
  if (imagesOn) parts.push(`${s.images} picture${s.images === 1 ? '' : 's'} with moutheyes`);
  if (s.error && !s.active) parts.push(`Couldn't start: ${s.error}`);
  statusEl.textContent = parts.join(' · ') || 'Videos and Images are both unticked.';
}

async function showCache() {
  const el = $('cacheStats');
  try {
    const c = await cacheStats();
    const mb = c.bytes / (1024 * 1024);
    el.textContent = `Image cache: ${c.withFaces} of ${c.pictures} pictures had faces · ${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  } catch {
    el.textContent = 'Image cache: unavailable';
  }
}

type Control = HTMLInputElement | HTMLSelectElement;

function control(key: keyof Settings): Control | null {
  return document.getElementById(key) as Control | null;
}

function renderOutput(key: keyof Settings, el: Control) {
  const out = document.querySelector<HTMLOutputElement>(`output[for="${key}"]`);
  if (out && FORMAT[key]) out.textContent = FORMAT[key]!(Number(el.value));
}

async function init() {
  const settings = await loadSettings();
  for (const key of Object.keys(settings) as (keyof Settings)[]) {
    const el = control(key);
    if (!el) continue;
    if (el instanceof HTMLInputElement && el.type === 'checkbox') el.checked = settings[key] as boolean;
    else el.value = String(settings[key]);
    renderOutput(key, el);
    el.addEventListener('input', () => {
      renderOutput(key, el);
      const v = el instanceof HTMLInputElement && el.type === 'checkbox' ? el.checked : Number(el.value);
      saveSettings({ [key]: v });
    });
  }

  enabled = settings.enabled;
  videosOn = settings.videos;
  imagesOn = settings.images;
  let refreshing = false;
  /** Bumped by each click: a status asked for before it is out of date. */
  let generation = 0;
  const refresh = async (force = false) => {
    if (refreshing && !force) return; // a busy page is still answering the last one
    refreshing = true;
    const gen = generation;
    try {
      const s = await tabStatus();
      if (gen === generation) showStatus(s);
    } finally {
      refreshing = false;
    }
  };
  /** Carries out a click, ignoring further clicks on the main switch until it's done, then shows the result. */
  const act = async (work: () => Promise<void>) => {
    busy = true;
    generation++;
    statusEl.classList.add('busy');
    try {
      await work();
    } finally {
      busy = false;
      generation++;
      statusEl.classList.remove('busy');
      await refresh(true);
    }
  };
  /** After a setting reaches the pages: start this tab's video if videos are now on. */
  const settled = async () => {
    await new Promise((r) => setTimeout(r, 100)); // let the pages see the setting first
    if (enabled && videosOn) await startVideo();
  };
  // Ticking Videos starts this tab's video; unticking it stops every video (the pages see to that).
  $('videos').addEventListener('input', (e) => {
    videosOn = (e.target as HTMLInputElement).checked;
    act(settled);
  });
  $('images').addEventListener('input', (e) => {
    imagesOn = (e.target as HTMLInputElement).checked;
    setTimeout(refresh, 300); // give the page a moment to start or stop
  });
  $('clearCache').addEventListener('click', async () => {
    await clearCache();
    showCache();
  });
  // The main switch: everything, on every page. Switching it on also starts this tab's video.
  powerBtn.addEventListener('click', () => {
    if (busy) return;
    enabled = !enabled;
    powerBtn.textContent = enabled ? 'On' : 'Off';
    powerBtn.classList.toggle('on', enabled);
    act(async () => {
      await saveSettings({ enabled });
      await settled();
    });
  });
  refresh();
  showCache();
  // Keep the popup current while it's open: videos appear, sessions stop, pictures convert.
  let ticks = 0;
  setInterval(() => {
    refresh();
    if (imagesOn && ++ticks % 2 === 0) showCache();
  }, 1000);
}

init();
