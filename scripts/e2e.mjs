// Smoke test: loads dist/ into Brave or Chrome, opens test/index.html, turns moutheyes on for
// the first video and checks that faces get tracked; saves screenshots to test/out/.
// Usage: npm run e2e [-- --headful] [-- --browser "C:\path\to\chrome.exe"]
import { createReadStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const headful = args.includes('--headful');
const browserArg = args.includes('--browser') ? args[args.indexOf('--browser') + 1] : null;
const CANDIDATES = [
  browserArg,
  'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe',
  'C:/Program Files/Google/Chrome for Testing/chrome.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].filter(Boolean);

async function findBrowser() {
  for (const p of CANDIDATES) {
    try {
      await stat(p);
      return p;
    } catch {}
  }
  throw new Error('No Brave/Chrome found; pass --browser <path>');
}

const MIME = { '.html': 'text/html', '.mp4': 'video/mp4', '.js': 'text/javascript', '.jpg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif' };
function serve(root) {
  const server = http.createServer(async (req, res) => {
    const file = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    try {
      const s = await stat(file.endsWith(path.sep) ? path.join(file, 'index.html') : file);
      const f = s.isDirectory() ? path.join(file, 'index.html') : file;
      const size = (await stat(f)).size;
      const type = MIME[path.extname(f)] ?? 'application/octet-stream';
      const range = req.headers.range?.match(/bytes=(\d+)-(\d*)/);
      if (range) {
        const start = Number(range[1]);
        const end = range[2] ? Number(range[2]) : size - 1;
        res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 });
        createReadStream(f, { start, end }).pipe(res);
      } else {
        res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes' });
        createReadStream(f).pipe(res);
      }
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((r) => server.listen(0, () => r(server)));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = await serve(path.resolve('test'));
const url = `http://localhost:${server.address().port}/index.html`;
const ext = path.resolve('dist');
await rm('test/out', { recursive: true, force: true });
await mkdir('test/out', { recursive: true });

const browser = await puppeteer.launch({
  executablePath: await findBrowser(),
  headless: !headful,
  userDataDir: path.resolve('test/out/profile'),
  args: [
    `--disable-extensions-except=${ext}`,
    `--load-extension=${ext}`,
    '--autoplay-policy=no-user-gesture-required',
    '--window-size=1400,1000',
  ],
  defaultViewport: { width: 1300, height: 900 },
});

let failed = false;
const toggle = async (page, selector) => {
  const box = await (await page.$(selector)).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await sleep(300);
  await page.keyboard.down('Alt');
  await page.keyboard.down('Shift');
  await page.keyboard.press('KeyE');
  await page.keyboard.up('Shift');
  await page.keyboard.up('Alt');
  return box;
};
// boundingBox() is relative to the viewport; screenshot clips are relative to the page.
const shot = async (page, box, name) => {
  const y = box.y + (await page.evaluate(() => scrollY));
  await page.screenshot({ path: `test/out/${name}.png`, clip: { x: box.x, y, width: box.width, height: box.height } });
};

try {
  const page = await browser.newPage();
  page.on('console', (m) => console.log(`[page:${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => document.querySelector('#plain').readyState >= 2, { timeout: 15000 });
  // 8 s in: a frontal close-up.
  await page.evaluate(() => {
    const v = document.querySelector('#plain');
    v.currentTime = 8;
    return v.play();
  });

  // Moutheyes is on, so the page's main video (the playing one) gets it without being asked.
  const box = await (await page.$('#plain')).boundingBox();
  const canvas = await page.waitForSelector('#plain + canvas.moutheyes-canvas', { timeout: 5000 });
  if ((await page.$$('canvas.moutheyes-canvas')).length !== 1) throw new Error('more than one video started on its own');
  console.log('Overlay canvas created on its own for the playing video.');

  let data = {};
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    data = await canvas.evaluate((c) => ({ ...c.dataset, w: c.width, h: c.height }));
    if (Number(data.faces) > 0 && Number(data.fps) > 0) break;
    if (data.error) break;
  }
  console.log('Canvas state:', data);
  if (data.error) throw new Error(`tracker failed: ${data.error}`);
  if (!(Number(data.faces) > 0)) throw new Error('no faces tracked');

  const hostFrame = page.frames().find((f) => f.url().includes('/tracker/host.html'));
  console.log('Tracker host frame:', hostFrame ? hostFrame.url() : 'not loaded');
  for (let i = 0; i < 3; i++) {
    await sleep(1000);
    const d = await canvas.evaluate((c) => ({ ...c.dataset }));
    console.log(`  fps=${d.fps} trackMs=${d.trackMs} faces=${d.faces}`);
  }

  // The same paused frame, plain and with moutheyes at a few settings.
  await page.evaluate(() => {
    const v = document.querySelector('#plain');
    v.pause();
    v.currentTime = 8.5;
  });
  await sleep(1500);
  await shot(page, box, 'moutheyes');
  console.log('Paused frame:', await canvas.evaluate((c) => ({ ...c.dataset })));
  if (hostFrame) {
    for (const [name, cfg] of Object.entries({
      'big-mouths': { mouthScale: 2.2 },
      'no-skin-match': { mouthScale: 1.35, skinMatch: false },
    })) {
      await hostFrame.evaluate((c) => chrome.storage.local.set(c), cfg);
      await sleep(1200);
      await shot(page, box, name);
    }
    await hostFrame.evaluate(() => chrome.storage.local.set({ skinMatch: true }));

    // Mouth echo: build up history while playing, then pause without seeking (a seek clears
    // it) and compare the same frame with and without the echo.
    await hostFrame.evaluate(() => chrome.storage.local.set({ mouthEcho: 0.5 }));
    await page.evaluate(() => document.querySelector('#plain').play());
    await sleep(1800); // stays clear of the camera cut at 11.1 s, where the face's history restarts
    await page.evaluate(() => document.querySelector('#plain').pause());
    await sleep(1000);
    await shot(page, box, 'echo');
    const echoed = await canvas.evaluate((c) => Number(c.dataset.echoedEyes));
    console.log(`Eyes showing an earlier mouth: ${echoed} (expected 2)`);
    if (echoed !== 2) throw new Error('mouth echo not applied');
    await hostFrame.evaluate(() => chrome.storage.local.set({ mouthEcho: 0 }));
    await sleep(1000);
    await shot(page, box, 'echo-off');
  }
  await toggle(page, '#plain');
  await sleep(500);
  await shot(page, box, 'plain');

  // Letterboxed video gets its own overlay with the bars kept.
  const lb = await page.$('#letterbox');
  await lb.scrollIntoView();
  await page.evaluate(() => {
    const v = document.querySelector('#letterbox');
    v.currentTime = 8;
    return v.play();
  });
  const lbBox = await toggle(page, '#letterbox');
  await sleep(2500);
  const count = await page.$$eval('canvas.moutheyes-canvas', (c) => c.length);
  console.log(`Active overlay canvases: ${count} (expected 1)`);
  if (count !== 1) throw new Error('letterboxed video did not get an overlay');
  await shot(page, lbBox, 'letterbox');

  // Object filter: a yellow bar across the lips (occluded.mp4) must not be copied onto the eyes.
  await toggle(page, '#letterbox');
  if (hostFrame && (await stat('test/media/occluded.mp4').then(() => true, () => false))) {
    await page.evaluate(() => {
      const v = document.querySelector('#plain');
      v.src = 'media/occluded.mp4';
      v.currentTime = 7.5;
    });
    await page.waitForFunction(() => document.querySelector('#plain').readyState >= 2);
    await (await page.$('#plain')).scrollIntoView();
    const plainBox = await toggle(page, '#plain');
    await page.evaluate(() => document.querySelector('#plain').play());
    await page.waitForFunction(() => document.querySelector('#plain').currentTime > 8.5, { timeout: 20000 });
    await page.evaluate(() => document.querySelector('#plain').pause());
    await sleep(1500);
    // Yellow pixels in the picture: the video itself vs. the moutheyes output.
    const yellow = () => page.evaluate(() => {
      const count = (src, w, h) => {
        const c = new OffscreenCanvas(w, h);
        const ctx = c.getContext('2d');
        ctx.drawImage(src, 0, 0, w, h);
        const px = ctx.getImageData(0, 0, w, h).data;
        let n = 0;
        for (let i = 0; i < px.length; i += 4) if (px[i] > 170 && px[i + 1] > 170 && px[i + 2] < 100) n++;
        return n;
      };
      const v = document.querySelector('#plain');
      return { video: count(v, v.videoWidth, v.videoHeight), out: count(document.querySelector('#plain + canvas.moutheyes-canvas'), v.videoWidth, v.videoHeight) };
    });
    const counts = {};
    for (const f of [0, 0.7]) {
      await hostFrame.evaluate((v) => chrome.storage.local.set({ objectFilter: v }), f);
      await sleep(1200);
      counts[f] = await yellow();
      await shot(page, plainBox, `object-filter-${f}`);
    }
    console.log(`Yellow pixels, video / output: filter off ${counts[0].video} / ${counts[0].out}, filter 0.7 ${counts[0.7].video} / ${counts[0.7].out}`);
    // Extra yellow in the output is the bar copied onto the eyes.
    const copiedOff = counts[0].out - counts[0].video;
    const copiedOn = counts[0.7].out - counts[0.7].video;
    if (copiedOff < 50) console.log('NOTE: the bar was not copied onto the eyes even unfiltered (face not tracked?)');
    else if (copiedOn > 0.1 * copiedOff) throw new Error('object filter let the bar through');
  } else {
    console.log('Skipping object filter check (run npm run fetch-test-media for test/media/occluded.mp4).');
  }
  // Shot change to a picture without a face: no echo of the old mouth may linger there.
  if (hostFrame && (await stat('test/media/cut.mp4').then(() => true, () => false))) {
    await hostFrame.evaluate(() => chrome.storage.local.set({ mouthEcho: 0.3 }));
    await page.evaluate(() => {
      const v = document.querySelector('#plain');
      v.loop = false;
      v.src = 'media/cut.mp4';
    });
    await page.waitForFunction(() => document.querySelector('#plain').readyState >= 2);
    const log = await page.evaluate(async () => {
      const v = document.querySelector('#plain');
      const c = document.querySelector('#plain + canvas.moutheyes-canvas');
      const out = [];
      // Logged by each shown frame's own time: frames are drawn a little after the video reaches them.
      new MutationObserver(() => out.push([Number(c.dataset.frameTime), Number(c.dataset.echoedEyes)])).observe(c, { attributes: true, attributeFilter: ['data-echoed-eyes'] });
      await v.play();
      await new Promise((r) => v.addEventListener('ended', r, { once: true }));
      return out;
    });
    const before = log.filter(([t, n]) => t > 1 && t < 1.95 && n > 0).length;
    const after = log.filter(([t, n]) => t > 2.0 && n > 0).length;
    console.log(`Echoing frames before the cut: ${before}, after it: ${after} (expected 0)`);
    if (before && after) throw new Error('mouth echo lingered after a shot change');
    await hostFrame.evaluate(() => chrome.storage.local.set({ mouthEcho: 0 }));
  } else {
    console.log('Skipping shot change check (run npm run fetch-test-media for test/media/cut.mp4).');
  }
  // Image conversion: pictures with faces get moutheyes, the rest are left alone, and a reload
  // is answered from the cache.
  if (hostFrame && (await stat('test/media/stills/face.jpg').then(() => true, () => false))) {
    const port = server.address().port;
    await page.evaluate(() => document.querySelectorAll('video').forEach((v) => v.pause()));
    await page.evaluate((port) => {
      // Another origin (127.0.0.1 vs localhost): the page can't read it, the extension fetches it.
      const img = Object.assign(document.createElement('img'), { id: 'pic-xo', width: 480, alt: 'cross-origin face' });
      img.src = `http://127.0.0.1:${port}/media/stills/face2.jpg?xo`;
      document.querySelector('#pictures').append(img);
    }, port);
    await page.$eval('#pictures', (e) => e.scrollIntoView());
    const expectOn = ['pic-face', 'pic-face2', 'pic-small', 'pic-portrait', 'pic-in-picture', 'pic-xo', 'pic-anim', 'pic-apng', 'pic-anim-alpha'];
    const expectOff = ['pic-noface', 'pic-thumb', 'pic-anim-noface'];
    const state = () => page.evaluate(() => Object.fromEntries(
      [...document.querySelectorAll('#pictures img')].map((i) => [i.id, i.dataset.moutheyes === 'on'])));
    const waitConverted = async (ms) => {
      const t0 = Date.now();
      let st = {};
      while (Date.now() - t0 < ms) {
        st = await state();
        if (expectOn.every((id) => st[id])) break;
        await sleep(250);
      }
      return { st, seconds: (Date.now() - t0) / 1000 };
    };

    let t0 = Date.now();
    await hostFrame.evaluate(() => chrome.storage.local.set({ images: true, maxFaces: 2 }));
    let { st, seconds } = await waitConverted(150000);
    console.log(`Pictures converted (first visit, ${seconds.toFixed(1)} s):`, st);
    const missing = expectOn.filter((id) => !st[id]);
    const wrong = expectOff.filter((id) => st[id]);
    if (missing.length || wrong.length) throw new Error(`image conversion: missing ${missing}, unexpected ${wrong}`);
    // The cut-out portrait keeps its transparent corners.
    const corner = await page.$eval('#pic-portrait', async (img) => {
      await img.decode();
      const c = new OffscreenCanvas(img.naturalWidth, img.naturalHeight).getContext('2d');
      c.drawImage(img, 0, 0);
      return c.getImageData(2, 2, 1, 1).data[3];
    });
    console.log(`Portrait corner alpha: ${corner} (expected 0)`);
    if (corner !== 0) throw new Error('transparency lost');
    // Animations stay animated, frame for frame; the transparent one keeps its see-through corners.
    const frames = await page.evaluate(async () => {
      const count = async (url) => {
        const blob = await (await fetch(url)).blob();
        const dec = new ImageDecoder({ data: await blob.arrayBuffer(), type: blob.type });
        await dec.tracks.ready;
        await dec.completed;
        const n = dec.tracks.selectedTrack.frameCount;
        const { image } = await dec.decode({ frameIndex: Math.floor(n / 2) });
        const c = new OffscreenCanvas(image.displayWidth, image.displayHeight).getContext('2d');
        c.drawImage(image, 0, 0);
        const cornerAlpha = c.getImageData(2, 2, 1, 1).data[3];
        image.close();
        dec.close();
        return { n, type: blob.type, cornerAlpha };
      };
      const out = {};
      for (const [id, orig] of [['pic-anim', 'media/stills/anim.gif'], ['pic-apng', 'media/stills/anim.png'], ['pic-anim-alpha', 'media/stills/anim-alpha.gif'], ['pic-anim-noface', 'media/stills/anim-noface.gif']]) {
        out[id] = { original: await count(orig), shown: await count(document.getElementById(id).src) };
      }
      return out;
    });
    console.log('Animations (original vs shown):', JSON.stringify(frames));
    for (const [id, f] of Object.entries(frames)) {
      if (f.shown.n !== f.original.n || f.shown.n < 2) throw new Error(`${id} lost its animation (${f.original.n} -> ${f.shown.n} frames)`);
    }
    if (frames['pic-anim-alpha'].shown.cornerAlpha !== 0) throw new Error('animated transparency lost');
    await page.$eval('#pictures', (e) => e.scrollIntoView());
    await sleep(300);
    const pics = await (await page.$('#pictures')).boundingBox();
    await page.screenshot({ path: 'test/out/pictures.png', clip: { x: pics.x, y: pics.y + (await page.evaluate(() => scrollY)), width: pics.width, height: Math.min(pics.height, 1600) } });

    // Reload: every picture comes from the cache.
    await page.reload({ waitUntil: 'load' });
    await page.evaluate((port) => {
      const img = Object.assign(document.createElement('img'), { id: 'pic-xo', width: 480 });
      img.src = `http://127.0.0.1:${port}/media/stills/face2.jpg?xo`;
      document.querySelector('#pictures').append(img);
    }, port);
    await page.$eval('#pictures', (e) => e.scrollIntoView());
    ({ st, seconds } = await waitConverted(30000));
    console.log(`Pictures converted (reload, from cache, ${seconds.toFixed(1)} s)`);
    if (!expectOn.every((id) => st[id])) throw new Error('pictures not converted after reload');
    const host2 = page.frames().find((f) => f.url().includes('/tracker/host.html'));
    const loadedModel = await host2.evaluate(() => performance.getEntriesByType('resource').some((r) => r.name.includes('face_landmarker.task')));
    console.log(`Face model loaded on reload: ${loadedModel} (expected false: cache hits need no detection)`);
    const index = await host2.evaluate(() => new Promise((resolve) => {
      const req = indexedDB.open('moutheyes-images');
      req.onsuccess = () => {
        const all = req.result.transaction('images').objectStore('images').getAll();
        all.onsuccess = () => resolve(all.result.map((e) => `${e.key.split('/').pop()}: ${e.faces.length} face(s), ${Object.keys(e.outputs).length} output(s)${e.error ? `, ${e.error}` : ''}`));
      };
    }));
    console.log('Image cache index:', index);
    // Each test picture has exactly this many findable faces (a false face would be a bug that sticks).
    const expectFaces = {
      'face.jpg': 1, 'face2.jpg': 1, 'face2.jpg?xo': 1, 'small-face.jpg': 1, 'portrait.png': 1, 'noface.png': 0,
      'anim.gif': 1, 'anim.png': 1, 'anim-alpha.gif': 1, 'anim-noface.gif': 0,
    };
    for (const [name, n] of Object.entries(expectFaces)) {
      const line = index.find((l) => l.startsWith(`${name}:`));
      if (!line?.startsWith(`${name}: ${n} face(s)`)) throw new Error(`expected ${n} face(s) in ${name}, cache says: ${line}`);
    }

    // Images off: every original picture is back.
    await host2.evaluate(() => chrome.storage.local.set({ images: false }));
    await sleep(800);
    const restored = await page.evaluate(() => [...document.querySelectorAll('#pictures img, #pictures source')]
      .filter((e) => (e.getAttribute('src') ?? e.getAttribute('srcset') ?? '').startsWith('blob:')).map((e) => e.id || e.tagName));
    console.log(`Still showing moutheyes after Images off: ${restored.length ? restored : 'none'}`);
    if (restored.length) throw new Error('pictures not restored');
  } else {
    console.log('Skipping image conversion check (run npm run fetch-test-media for test/media/stills/).');
  }
  // The popup, on a page whose only video is in an embedded frame (with Images on, the popup used
  // to hear from the top frame there, see 0 videos and grey out its button); its main switch
  // (off stops everything, on starts the tab's video); then on a tab whose content script is
  // gone (as after reloading the extension without refreshing the tab).
  {
    const host = page.frames().find((f) => f.url().includes('/tracker/host.html'));
    const extId = new URL(host.url()).host;
    await host.evaluate(() => chrome.storage.local.set({ images: true }));
    const fpage = await browser.newPage();
    await fpage.goto(`http://localhost:${server.address().port}/frames.html`, { waitUntil: 'load' });
    const player = () => fpage.frames().find((f) => f.url().includes('frame-video.html'));
    await player().waitForFunction(() => document.querySelector('video').readyState >= 2);
    const canvases = () => player().$$eval('canvas.moutheyes-canvas', (c) => c.length);
    const popup = await browser.newPage();
    await popup.goto(`chrome-extension://${extId}/popup/popup.html`);
    const tabId = await popup.evaluate(async () => (await chrome.tabs.query({ url: 'http://localhost/frames.html' }))[0].id);
    const ui = () => popup.evaluate(() => ({
      power: document.querySelector('#toggle').textContent,
      videos: document.querySelector('#videos').checked,
      status: document.querySelector('#status').textContent,
    }));
    const openPopup = async () => {
      await popup.goto(`chrome-extension://${extId}/popup/popup.html?tab=${tabId}`);
      await popup.waitForFunction(() => !document.querySelector('#status').textContent.startsWith('Checking'));
      return ui();
    };
    const click = async (id) => {
      await popup.click(id);
      await sleep(1500);
      const r = await ui();
      console.log(`  clicked ${id}:`, r, `canvases in the embedded frame: ${await canvases()}`);
      return r;
    };
    const expect = async (ok, canvasCount, what) => {
      if (!ok || (await canvases()) !== canvasCount) throw new Error(what);
    };

    // The embedded video loads after the page, and still gets moutheyes on its own.
    await fpage.bringToFront();
    await player().waitForSelector('canvas.moutheyes-canvas', { timeout: 5000 });
    await popup.bringToFront();
    let st = await openPopup();
    console.log('Popup on embedded-video page:', st);
    if (st.power !== 'On' || !st.videos || !st.status.startsWith('Video on')) throw new Error('the video in an embedded frame did not start on its own');
    st = await click('#toggle');
    await expect(st.power === 'Off' && st.status.includes('off'), 0, 'main switch did not turn moutheyes off');
    st = await click('#toggle');
    await expect(st.power === 'On' && st.status.startsWith('Video on'), 1, "main switch did not turn moutheyes on with the tab's video");
    st = await click('#videos');
    await expect(!st.videos, 0, 'unticking Videos did not stop the video');
    st = await click('#videos');
    await expect(st.videos && st.status.startsWith('Video on'), 1, "ticking Videos did not start the tab's video");
    await click('#toggle');
    // A second click while a busy page is still answering the first must not undo it.
    player().evaluate(() => { const end = Date.now() + 1500; while (Date.now() < end); }).catch(() => {});
    await sleep(100);
    await popup.click('#toggle');
    await sleep(200);
    await popup.click('#toggle');
    await sleep(2500);
    st = await ui();
    console.log('  double click while the page was busy:', st, `canvases: ${await canvases()}`);
    await expect(st.power === 'On', 1, 'a double click on the main switch undid the first');
    await click('#videos');

    // Simulate a content script cut off from the extension: remove it from every frame.
    await popup.evaluate((id) => chrome.scripting.executeScript({
      target: { tabId: id, allFrames: true },
      func: () => { window.__moutheyes?.teardown(); },
    }), tabId);
    st = await openPopup();
    console.log('Popup after the content script was removed:', st);
    if (st.status.startsWith("Moutheyes can't")) throw new Error('popup did not recover a tab without a content script');
    st = await click('#videos');
    await expect(st.videos && st.status.startsWith('Video on'), 1, 'ticking Videos failed after re-injecting the content script');
    await host.evaluate(() => chrome.storage.local.set({ images: false })).catch(() => {});
    await popup.close();
    await fpage.close();
  }
  // Single-page sites (YouTube): a video turned off by hand stays off on that address, but the
  // next address starts afresh; and a player the site hides gives up moutheyes.
  {
    const spa = await browser.newPage();
    await spa.goto(url, { waitUntil: 'load' });
    await spa.evaluate(() => document.querySelector('#plain').play());
    await spa.waitForSelector('#plain + canvas.moutheyes-canvas', { timeout: 8000 });
    await toggle(spa, '#plain');
    await sleep(2500);
    const count = () => spa.$$eval('canvas.moutheyes-canvas', (c) => c.length);
    if ((await count()) !== 0) throw new Error('a video turned off by hand started again on its own');
    await spa.evaluate(() => history.pushState({}, '', '?next'));
    await spa.waitForSelector('#plain + canvas.moutheyes-canvas', { timeout: 5000 });
    console.log('After moving to a new address, the video started on its own again.');
    await spa.evaluate(() => (document.querySelector('#plain').style.display = 'none'));
    await spa.waitForFunction(() => !document.querySelector('#plain + canvas.moutheyes-canvas'), { timeout: 8000 });
    console.log('A hidden player gave up its moutheyes.');
    await spa.close();
  }
  console.log('Saved test/out/{pictures,moutheyes,big-mouths,no-skin-match,echo,echo-off,plain,letterbox,object-filter-*}.png');
} catch (e) {
  failed = true;
  console.error('E2E FAILED:', e);
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
