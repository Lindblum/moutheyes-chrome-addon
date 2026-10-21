import type { PopupRequest, PopupStatus } from '../shared/protocol';
import { loadSettings, saveSettings, type Settings } from '../shared/settings';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const statusEl = $('status');
const toggleBtn = $<HTMLButtonElement>('toggle');

const FORMAT: Partial<Record<keyof Settings, (v: number) => string>> = {
  mouthScale: (v) => `${v.toFixed(2)}×`,
  smoothing: (v) => (v ? v.toFixed(2) : 'off'),
};

async function send(msg: PopupRequest): Promise<PopupStatus | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id == null) return null;
  try {
    return (await chrome.tabs.sendMessage(tab.id, msg)) ?? null;
  } catch {
    return null; // no content script (chrome:// page, store) or no frame with a video
  }
}

function showStatus(s: PopupStatus | null) {
  const on = !!s && s.active > 0;
  toggleBtn.disabled = !s;
  toggleBtn.textContent = on ? 'On' : 'Off';
  toggleBtn.classList.toggle('on', on);
  statusEl.classList.toggle('warn', !!s && s.buildId !== __BUILD_ID__);
  if (!s) statusEl.textContent = 'No video found on this page. (Just reloaded the extension? Refresh this tab.)';
  else if (s.buildId !== __BUILD_ID__) statusEl.textContent = 'This tab is running an older version. Reload the extension, then refresh this tab.';
  else if (s.active) statusEl.textContent = `On · ${s.faces} face${s.faces === 1 ? '' : 's'} tracked`;
  else statusEl.textContent = `${s.videos} video${s.videos > 1 ? 's' : ''} found`;
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

  toggleBtn.addEventListener('click', async () => showStatus(await send({ type: 'toggle' })));
  showStatus(await send({ type: 'status' }));
}

init();
