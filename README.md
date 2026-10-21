# Video Moutheyes

A Chrome/Brave extension that tracks the faces in any HTML5 video (YouTube and most other
sites) and puts each face's own moving mouth over its eyes, **in real time**. A live
version of moutheyes-py. Tracking runs locally on your GPU with MediaPipe;
nothing leaves your machine. DRM-protected video (Netflix, Disney+, Prime) can't be read.

## How it works

- **Tracking** (`src/tracker/`): MediaPipe's face landmarker runs in an extension-origin
  iframe, so page CSPs can't block its WASM. Each tracked face is followed in a crop around
  where it was last seen, and new faces are found by cycling through zoomed tiles of the frame.
  This finds faces that are small in a wide frame, which the detector misses when given the
  whole frame. Landmarks are smoothed with a One Euro filter.
- **Compositing** (`src/render/`, `src/shared/face.ts`): ported from moutheyes-py's
  `moutheye_frame()`. The mouth is scaled to the eye's width, turned to the eye line and drawn
  with a feathered mask: the lip hull plus a margin of surrounding skin, gated by a Lab skin-colour
  model sampled from the cheeks and forehead, and tinted to match the skin around each eye.
- Each frame is shown only after it comes back from the tracker with its faces, so the mouths
  never lag behind the picture. Output runs about one frame behind the audio.

## Build and install

```sh
npm install
npm run build   # unpacked extension in dist/ (downloads the 3.7 MB face model on first build)
```

Open `chrome://extensions` (or `brave://extensions`), turn on **Developer mode**, click
**Load unpacked**, and pick `dist/`.

## Use

Hover a video and click **Moutheyes**, or press **Alt+Shift+E**. Fullscreen works too.

The toolbar popup sets mouth size, how many faces to track (1–4), smoothing, skin blending
and a stats overlay.

## Development

```sh
npm run watch       # rebuild on change, then reload the extension
npm run typecheck
npm run fetch-test-media && npm run e2e -- [--headful]   # screenshots in test/out/
```

`fetch-test-media` cuts 20 s of *Tears of Steel* (CC-BY Blender Foundation) with ffmpeg.
e2e needs Brave or Chrome for Testing (branded Chrome 137+ ignores `--load-extension`).
`node scripts/make-icons.mjs` regenerates the icons.
