// Picture conversion: watches the page's <img> elements and, one at a time, has the tracker host
// (and its cache, shared by all tabs) make moutheyes versions of the ones near the viewport that
// have faces, then shows those in their place. It's slow on purpose: only while the browser is
// idle, the tab is visible and no moutheyes video is playing.
import type { Blocked, ImageOptions } from '../shared/protocol';
import type { Settings } from '../shared/settings';
import { tracker } from '../tracker/bridge';

/** Pictures smaller than this (natural pixels, either side) can't hold a usable face. */
const MIN_NATURAL = 64;
/** ...and pictures shown smaller than this aren't worth it. */
const MIN_SHOWN = 48;
/** Pictures this close to the viewport (px) are converted ahead of being scrolled to. */
const LOOKAHEAD = '600px';
/** While paused (tab hidden, a video playing), check back this often (ms). */
const PAUSE_POLL_MS = 1000;

interface Original {
  src: string | null;
  srcset: string | null;
  sizes: string | null;
  /** <source> elements of an enclosing <picture>, and their srcset. */
  sources: [HTMLSourceElement, string | null][];
}

interface Converted {
  /** The picture URL the moutheyes version was made from, and the settings it was made with. */
  url: string;
  okey: string;
  blobUrl: string;
  original: Original;
}

export function imageOptions(s: Settings): ImageOptions {
  return { mouthScale: s.mouthScale, maxFaces: s.maxFaces, skinMatch: s.skinMatch, objectFilter: s.objectFilter };
}

const optionsKey = (o: ImageOptions) => JSON.stringify(o);

export class ImageConverter {
  private running = false;
  private stopped = true;
  private settings: Settings;
  /** Pictures waiting, and those currently near the viewport (done first). */
  private queue = new Set<HTMLImageElement>();
  private near = new Set<HTMLImageElement>();
  /** URL each picture was last looked at for (with the settings), so it isn't redone. */
  private seen = new WeakMap<HTMLImageElement, string>();
  private converted = new Map<HTMLImageElement, Converted>();
  /** Results for this page by URL + settings, so repeats (thumbnails, carousels) skip the round trip. */
  private results = new Map<string, Blob | null>();
  /** Pictures on this page the extension may not read, by URL (see ImageResult.blocked). */
  private blocked = new Map<string, Blocked>();
  /** Object URLs of our own output, which must never be taken for a picture to convert. */
  private ours = new Set<string>();
  private io: IntersectionObserver;
  private mo: MutationObserver;

  constructor(settings: Settings, private busy: () => boolean) {
    this.settings = settings;
    this.io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const img = e.target as HTMLImageElement;
        if (e.isIntersecting) {
          this.near.add(img);
          this.enqueue(img);
        } else {
          this.near.delete(img);
        }
      }
    }, { rootMargin: LOOKAHEAD });
    this.mo = new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'attributes') {
          const t = r.target;
          const img = t instanceof HTMLSourceElement && t.parentElement instanceof HTMLPictureElement
            ? t.parentElement.querySelector('img')
            : t;
          if (!(img instanceof HTMLImageElement)) continue;
          const c = this.converted.get(img);
          // Our own swap (src and <source> srcset point at our output, img srcset is removed),
          // or the site changing the picture (then it's looked at afresh).
          const ownValue = r.attributeName === 'src' || t !== img ? c?.blobUrl : null;
          if (c && (t as Element).getAttribute(r.attributeName!) === ownValue) continue;
          if (c) this.forget(img);
          this.seen.delete(img);
          this.enqueue(img);
          continue;
        }
        r.addedNodes.forEach((n) => this.watchTree(n));
        // Removed pictures get their original back: pages often move nodes by removing and
        // re-adding them, and they must come back as themselves, not as our output.
        r.removedNodes.forEach((n) => this.imagesIn(n).forEach((img) => this.restore(img)));
      }
    });
  }

  /** Pictures on the page currently shown with moutheyes. */
  get count(): number {
    return this.converted.size;
  }

  /** Pictures on this page left alone because the extension may not read them. */
  get blockedCounts(): Record<Blocked, number> {
    const n = { access: 0, login: 0 };
    this.blocked.forEach((reason) => n[reason]++);
    return n;
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.watchTree(document.documentElement);
    this.mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'srcset'] });
  }

  /** Stops, and puts every original picture back. */
  stop() {
    this.stopped = true;
    this.io.disconnect();
    this.mo.disconnect();
    this.queue.clear();
    this.near.clear();
    for (const img of [...this.converted.keys()]) this.restore(img);
    this.seen = new WeakMap();
    // Site access may change while stopped; blocked pictures are tried again on the next start.
    for (const k of this.results.keys()) if (this.blocked.has(k.split('\n')[0])) this.results.delete(k);
    this.blocked.clear();
  }

  applySettings(s: Settings) {
    const changed = optionsKey(imageOptions(s)) !== optionsKey(imageOptions(this.settings));
    this.settings = s;
    if (!changed || this.stopped) return;
    // Everything is redone with the new settings (face detection comes from the cache).
    for (const img of [...this.converted.keys()]) {
      this.seen.delete(img);
      this.enqueue(img);
    }
  }

  private imagesIn(n: Node): HTMLImageElement[] {
    if (n instanceof HTMLImageElement) return [n];
    return n instanceof Element ? [...n.querySelectorAll('img')] : [];
  }

  private watchTree(n: Node) {
    this.imagesIn(n).forEach((img) => this.io.observe(img));
  }

  private enqueue(img: HTMLImageElement) {
    if (this.stopped) return;
    this.queue.add(img);
    this.pump();
  }

  /** Works through the queue, one picture at a time, nearest first. */
  private async pump() {
    if (this.running) return;
    this.running = true;
    try {
      while (!this.stopped && this.queue.size) {
        if (document.hidden || this.busy()) {
          await new Promise((r) => setTimeout(r, PAUSE_POLL_MS));
          continue;
        }
        await new Promise((r) => requestIdleCallback(r, { timeout: 2000 }));
        const img = [...this.queue].find((i) => this.near.has(i));
        if (!img) break; // the rest have scrolled away; they come back when they're near again
        this.queue.delete(img);
        await this.convert(img).catch((e) => console.warn('[moutheyes] picture conversion failed:', e));
      }
    } finally {
      this.running = false;
    }
  }

  private async convert(img: HTMLImageElement) {
    if (!img.isConnected) return;
    if (!img.complete || !img.naturalWidth) {
      img.addEventListener('load', () => this.enqueue(img), { once: true });
      return;
    }
    const c = this.converted.get(img);
    const url = c?.url ?? (img.currentSrc || img.src);
    const opts = imageOptions(this.settings);
    const okey = optionsKey(opts);
    if (!url || this.ours.has(url) || this.seen.get(img) === `${url}\n${okey}`) return;
    this.seen.set(img, `${url}\n${okey}`);
    if (img.naturalWidth < MIN_NATURAL || img.naturalHeight < MIN_NATURAL) return;
    const r = img.getBoundingClientRect();
    if (r.width < MIN_SHOWN || r.height < MIN_SHOWN) return;
    if (/^data:image\/svg|\.svg(\?|#|$)/i.test(url)) return;

    const resultKey = `${url}\n${okey}`;
    let blob = this.results.get(resultKey);
    if (blob === undefined) {
      const res = await tracker.image(url, await this.file(url), opts);
      if (res.error) console.debug(`[moutheyes] skipped picture (${res.error}): ${url.slice(0, 200)}`);
      if (res.blocked) this.blocked.set(url, res.blocked);
      blob = res.blob;
      this.results.set(resultKey, blob);
    }
    // The page may have moved on meanwhile (scrolled away is fine; replaced or removed is not).
    if (this.stopped || !img.isConnected) return;
    const now = this.converted.get(img);
    if ((now?.url ?? (img.currentSrc || img.src)) !== url) return;
    if (!blob) {
      if (now) this.restore(img); // no faces with these settings (fewer Max Faces won't do that, but be safe)
      return;
    }
    this.show(img, url, okey, blob);
  }

  /**
   * The picture's file, for those the page can read itself (same site, data: and blob: URLs);
   * null for the rest, which the tracker host fetches. Always the file, never the pixels on
   * screen: an animation has to arrive whole, not as whatever frame was showing.
   */
  private async file(url: string): Promise<Blob | null> {
    const own = /^(data|blob):/.test(url) || new URL(url, location.href).origin === location.origin;
    if (!own) return null;
    try {
      const res = await fetch(url);
      return res.ok ? await res.blob() : null;
    } catch {
      return null;
    }
  }

  private show(img: HTMLImageElement, url: string, okey: string, blob: Blob) {
    const prev = this.converted.get(img);
    const blobUrl = URL.createObjectURL(blob);
    this.ours.add(blobUrl);
    const original = prev?.original ?? {
      src: img.getAttribute('src'),
      srcset: img.getAttribute('srcset'),
      sizes: img.getAttribute('sizes'),
      sources: img.parentElement instanceof HTMLPictureElement
        ? [...img.parentElement.querySelectorAll('source')].map((s): [HTMLSourceElement, string | null] => [s, s.getAttribute('srcset')])
        : [],
    };
    this.converted.set(img, { url, okey, blobUrl, original });
    // srcset and <picture> sources win over src, so they point at the moutheyes version too.
    for (const [source] of original.sources) source.setAttribute('srcset', blobUrl);
    img.removeAttribute('sizes');
    img.removeAttribute('srcset');
    img.setAttribute('src', blobUrl);
    img.dataset.moutheyes = 'on';
    if (prev) this.release(prev.blobUrl);
  }

  /** Puts the original picture back. */
  private restore(img: HTMLImageElement) {
    const c = this.converted.get(img);
    if (!c) return;
    this.converted.delete(img);
    const set = (el: Element, name: string, v: string | null) => (v === null ? el.removeAttribute(name) : el.setAttribute(name, v));
    for (const [source, srcset] of c.original.sources) set(source, 'srcset', srcset);
    set(img, 'sizes', c.original.sizes);
    set(img, 'srcset', c.original.srcset);
    set(img, 'src', c.original.src);
    delete img.dataset.moutheyes;
    this.release(c.blobUrl);
  }

  private release(blobUrl: string) {
    URL.revokeObjectURL(blobUrl);
    this.ours.delete(blobUrl);
  }

  /** The page replaced or removed a picture: drop what we did to it, without touching it. */
  private forget(img: HTMLImageElement) {
    const c = this.converted.get(img);
    this.queue.delete(img);
    this.near.delete(img);
    if (!c) return;
    this.converted.delete(img);
    if (img.dataset.moutheyes) delete img.dataset.moutheyes;
    this.release(c.blobUrl);
  }
}
