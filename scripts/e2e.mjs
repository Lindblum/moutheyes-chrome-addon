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

const MIME = { '.html': 'text/html', '.mp4': 'video/mp4', '.js': 'text/javascript' };
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

  const box = await toggle(page, '#plain');
  const canvas = await page.waitForSelector('canvas.moutheyes-canvas', { timeout: 5000 });
  console.log('Overlay canvas created.');

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
  console.log('Saved test/out/{moutheyes,big-mouths,no-skin-match,plain,letterbox}.png');
} catch (e) {
  failed = true;
  console.error('E2E FAILED:', e);
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
