# Chrome Web Store submission

`npm run package` builds the extension and writes `moutheyes-<version>.zip` (upload this). Bump
`version` in `package.json` for each upload; the manifest takes it from there.

## Listing

- **Name:** Moutheyes
- **Summary** (the manifest description, 132 characters at most): Puts each face's own mouth over
  its eyes, in videos in real time and in the pictures on pages.
- **Category:** Fun
- **Icon:** `src/icons/icon128.png`.
- **Screenshots** (1280×800 or 640×400, up to 5): use footage you're allowed to show and alter.
  - Best: video of yourself, or of people who agreed to it.
  - Blender open movies, CC-BY 3.0, credit "© Blender Foundation | mango.blender.org" in the
    description: *Tears of Steel* (real actors, the e2e test media; `npm run fetch-test-media`) and
    *Sintel* (animated faces, `test/media/sintel-trailer.mp4`).
  - Not: TV, films, music videos, streamers or celebrities (copyright and likeness), and stock
    footage whose license forbids showing people in an unflattering way (Pexels, for example).
  - Played in a plain local page (`npm run test-page`) rather than on YouTube, so no other
    brand or someone else's video is in the shot.

## Privacy tab

- **Single purpose:** Shows the faces in videos and pictures on web pages with their mouths copied
  over their eyes.
- **Remote code:** No. All code, the WebAssembly runtime and the face model are in the package.
- **Data use:** collects none of the listed data types. Page content (video frames, pictures) is
  processed locally and never sent anywhere; see `PRIVACY.md`.
- **Privacy policy URL:** a public link to `PRIVACY.md`, for example on GitHub.

## Permission justifications

| Permission | Why |
| --- | --- |
| `<all_urls>` host access and content script | The effect works on videos and pictures on any site the user visits, including videos in embedded frames. Pictures from other sites (CDNs) are downloaded by the extension, since the page itself can't read their pixels. |
| `scripting` | Adds the content script to tabs that were already open when the extension was installed or updated, and lets the popup ask each frame of the current tab for its status. |
| `storage` | Saves the popup's settings. |
| `unlimitedStorage` | The optional image cache (IndexedDB and Cache Storage, capped at 256 MB by the extension) so pictures seen before are shown instantly instead of being run through face tracking again. |
| `wasm-unsafe-eval` (CSP) | Runs the bundled MediaPipe face tracker, which is WebAssembly. No JavaScript `eval`. |
| Web-accessible `tracker/host.html` | The face tracker runs in a hidden extension iframe so its WebAssembly loads under the extension's CSP, not the site's. It accepts connections only from the extension's own content script (a one-time token sent through extension messaging). |
