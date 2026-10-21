# Moutheyes

A Chrome/Brave extension that tracks the faces in any HTML5 video (YouTube and most other
sites) and puts each face's own moving mouth over its eyes, **in real time**. A live
version of moutheyes-py. It can also do the same to the pictures on pages, in the background.
Everything runs locally on your GPU with MediaPipe; nothing leaves your machine.
DRM-protected video (Netflix, Disney+, Prime) can't be read.

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
- **Pictures** (`src/content/images.ts`, `src/tracker/stills.ts`, `src/shared/imagecache.ts`):
  see below.

## With the 2D-3D Video Converter

Both can be on for the same video, in either order: the 3D extension then converts the
moutheyes picture instead of the raw video. While moutheyes is on, the video element carries
`data-moutheyes="<canvas id>"` and fires `moutheyes:change` (on/off) and `moutheyes:frame`
(new frame) events; the canvas holds the full frame, letterboxed by CSS like the video.

## Build and install

```sh
npm install
npm run build   # unpacked extension in dist/ (downloads the 3.7 MB face model on first build)
```

Open `chrome://extensions` (or `brave://extensions`), turn on **Developer mode**, click
**Load unpacked**, and pick `dist/`.

## Use

The toolbar popup's **On/Off** switch turns the whole extension on or off, on every page;
switching it on also starts the current tab's main video. Below it are a checkbox each for
**Videos** (on by default) and **Images** (off).

With Videos on, hover a video and click **Moutheyes**, or press **Alt+Shift+E**. Fullscreen
works too. The popup's **Start video / Stop video** button acts on the most prominent video on
the page (including one inside an embedded player or a shadow DOM); if it can't start, the popup
says why. Tabs that were open before the extension was installed
or reloaded work without a refresh: the background script (and, failing that, the popup) gives
them a fresh content script. The popup also sets mouth size, the most faces per video or picture (1–4),
smoothing, mouth echo, the object filter, skin blending and a stats overlay.

**Mouth echo** staggers the mouths in time: the eye on the left of the picture shows the mouth
from *d* seconds ago, the right eye from *2d* ago (up to 0.5 s / 1 s), so the real mouth and the
two copies play like a round. Each face keeps 1 s of mouth crops on the GPU (about 5 MB per
face); the history restarts after a seek or when a face is lost, such as at a camera cut.

**Object filter** leaves whatever is neither skin nor lips (captions, a hand, a microphone) out
of the mouth copies, using skin and lip colour models measured from the face itself. Inside the
mouth opening, dark and nearly colourless pixels (cavity, teeth) are kept too, so a white caption
across an open mouth can still slip through there. High settings also cut out mustaches.

## Images

With Images on, pictures (`<img>`, including `srcset` and `<picture>`) near the viewport are
checked for faces one at a time, and those with faces are shown with moutheyes in their place.
Turning Images off puts every original back.

- **Animations** (GIF, APNG, animated WebP) get moutheyes in every frame: faces are found by a
  thorough search every 24 frames and tracked in between, short gaps are filled and the
  landmarks smoothed (as in moutheyes-py), and the result is encoded as an animated GIF
  ([gifenc](https://github.com/mattdesl/gifenc)) with the original timing, looping and 1-bit
  transparency. Up to 1024 px, 500 frames and 150 megapixels in all; larger ones are left alone.
  Mouth echo applies to videos only.
- The converter always works from the picture's file, never from the pixels on screen, so an
  animation is never frozen into whichever frame was showing. Files a server labels with the
  wrong type are recognised from their first bytes, as the browser does.

- **Gentle by design:** it only works while the browser is idle and the tab is visible, pauses
  while a moutheyes video plays, and a lock shared by all tabs lets one picture at a time use the
  GPU. A picture's face search is thorough (every tile at three sizes, then each face confirmed
  in a second, differently framed look, with a stricter confidence than video: a false face
  would stick), about 1–3 s per large picture, once.
- **Cache** (shared by all tabs): an IndexedDB index of every picture URL looked at, with the
  landmarks of its faces (or that it has none), and where each moutheyes version made from it
  is stored in Cache Storage, per settings. Changing mouth size or the like re-renders from the
  cached landmarks; seeing a picture again is a cache read that doesn't even load MediaPipe.
  Least recently used pictures are evicted past 256 MB or 5,000 entries; the popup shows the
  cache's size and can clear it. Pictures that couldn't be used are retried after a day.
- **Skipped:** pictures under 64 px (or shown under 48 px), SVGs, still pictures over 4096 px,
  and animations past the limits above. Only the top frame of a page is scanned (embedded frames are mostly
  ads, and each would need its own tracker). CSS background images aren't converted.
- Pictures the page can't read itself (other origins) are fetched by the extension, which is
  why it asks for access to all sites (`host_permissions`). Some sites refuse requests that
  don't come from their own pages; those pictures are left alone.

## Development

```sh
npm run watch       # rebuild on change, then reload the extension
npm run typecheck
npm run fetch-test-media && npm run e2e -- [--headful]   # screenshots in test/out/
```

`fetch-test-media` cuts 20 s of *Tears of Steel* (CC-BY Blender Foundation) with ffmpeg, and
makes the test clips and still pictures from it.
e2e needs Brave or Chrome for Testing (branded Chrome 137+ ignores `--load-extension`).
`node scripts/make-icons.mjs` regenerates the icons.
