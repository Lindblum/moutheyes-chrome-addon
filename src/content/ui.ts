// Page-level overlay UI (hover toggle button, toasts, stats) in a closed shadow root so
// site CSS can't touch it and ours can't leak.

const CSS = `
:host { all: initial; }
.layer { position: fixed; inset: 0; pointer-events: none; z-index: 2147483647;
  font: 600 13px/1.3 system-ui, sans-serif; }
.btn { position: fixed; pointer-events: auto; cursor: pointer; border: 0; border-radius: 6px;
  padding: 6px 10px; background: rgba(20,20,20,.78); color: #fff; font: inherit;
  letter-spacing: .5px; opacity: 0; transition: opacity .2s; }
.btn.show { opacity: 1; }
.btn.on { background: rgba(0,120,255,.9); }
.toast { position: fixed; left: 50%; bottom: 10%; transform: translateX(-50%); max-width: 70vw;
  background: rgba(20,20,20,.9); color: #fff; padding: 10px 16px; border-radius: 8px;
  font-weight: 500; opacity: 0; transition: opacity .3s; }
.toast.show { opacity: 1; }
.stats { position: fixed; background: rgba(0,0,0,.65); color: #9f9; padding: 3px 6px;
  border-radius: 4px; font: 500 11px/1.3 ui-monospace, monospace; white-space: pre; }
`;

export class Overlay {
  readonly host = document.createElement('moutheyes-overlay');
  private layer: HTMLDivElement;
  private button: HTMLButtonElement;
  private toastEl: HTMLDivElement;
  private toastTimer = 0;
  private hideTimer = 0;
  private buttonTarget: HTMLVideoElement | null = null;

  constructor(private onButton: (v: HTMLVideoElement) => void) {
    const root = this.host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = CSS;
    this.layer = document.createElement('div');
    this.layer.className = 'layer';
    this.button = document.createElement('button');
    this.button.className = 'btn';
    this.button.title = 'Moutheyes on/off (Alt+Shift+E)';
    this.button.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      if (this.buttonTarget) this.onButton(this.buttonTarget);
    });
    this.toastEl = document.createElement('div');
    this.toastEl.className = 'toast';
    this.layer.append(this.button, this.toastEl);
    root.append(style, this.layer);
    this.reparent();
    document.addEventListener('fullscreenchange', this.reparent);
  }

  dispose() {
    document.removeEventListener('fullscreenchange', this.reparent);
    clearTimeout(this.toastTimer);
    clearTimeout(this.hideTimer);
    this.host.remove();
  }

  /** Keep the overlay inside the fullscreen element so it stays visible there. */
  private reparent = () => {
    const fs = document.fullscreenElement;
    const parent = fs && !(fs instanceof HTMLVideoElement) && !(fs instanceof HTMLCanvasElement) ? fs : document.documentElement;
    if (this.host.parentNode !== parent) parent.appendChild(this.host);
  };

  showButton(video: HTMLVideoElement, active: boolean) {
    const r = video.getBoundingClientRect();
    this.buttonTarget = video;
    this.button.textContent = active ? 'Moutheyes: On' : 'Moutheyes: Off';
    this.button.classList.toggle('on', active);
    // Top left, one row down: the 2D-3D Video Converter's button (same size) takes the first row.
    this.button.style.left = `${Math.max(4, r.left + 12)}px`;
    this.button.style.top = `${Math.max(4, r.top + 12) + this.button.offsetHeight + 6}px`;
    this.button.classList.add('show');
    clearTimeout(this.hideTimer);
    this.hideTimer = window.setTimeout(() => this.hideButton(), 2500);
  }

  hideButton() {
    this.button.classList.remove('show');
  }

  toast(text: string, ms = 4000) {
    this.toastEl.textContent = text;
    this.toastEl.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toastEl.classList.remove('show'), ms);
  }

  createStats(): HTMLDivElement {
    const el = document.createElement('div');
    el.className = 'stats';
    this.layer.appendChild(el);
    return el;
  }
}
