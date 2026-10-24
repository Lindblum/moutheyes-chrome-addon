# Moutheyes

A Chrome/Brave extension that puts each face's own moving mouth over its eyes, in videos in
real time and in the pictures on pages. A live version of moutheyes-py. Everything runs locally
on your GPU with MediaPipe; nothing leaves your machine. DRM-protected video can't be read.

## Install

```sh
npm install
npm run build   # unpacked extension in dist/ (downloads the 3.7 MB face model on first build)
```

In `brave://extensions` (or `chrome://extensions`), turn on **Developer mode**, click
**Load unpacked**, and pick `dist/`.

## Use

- **On/Off** in the popup turns the extension on or off on every page.
- **Videos:** each page's main video gets moutheyes on its own. To pick another, hover it and
  click **Moutheyes: Off**, or press **Alt+Shift+E**. Turning a video off by hand keeps the page's
  videos off until you turn one on or move to another address.
- **Images:** pictures with faces near the viewport are converted in the background, including
  animated GIF/APNG/WebP (output as GIF). Unticking puts the originals back.
- **Settings:** mouth size, max faces, smoothing, **mouth echo** (each eye's mouth plays *d* and
  *2d* seconds late), **object filter** (keeps captions, hands and mics out of the mouth copies),
  skin blending and a stats overlay.

## How it works

- **Tracking** (`src/tracker/`): MediaPipe's face landmarker runs in an extension-origin iframe.
  Faces are followed in a crop around where they were and found by searching zoomed tiles, so
  small faces in wide frames aren't missed. Landmarks are One Euro smoothed.
- **Compositing** (`src/render/`): a port of moutheyes-py's `moutheye_frame()` in WebGL2:
  feathered lip-hull mask, Lab skin gating and tone matching.
- **Pictures** (`src/tracker/stills.ts`): a thorough face search, then per-frame tracking for
  animations. Work waits for idle time, and a lock shared by tabs lets one picture at a time use
  the GPU. Results are cached (IndexedDB + Cache Storage, 256 MB, least recently used evicted).
  Pictures from other sites are fetched by the extension, hence `<all_urls>` access.
