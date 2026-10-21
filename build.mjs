// Bundles the extension into ./dist. Usage: node build.mjs [--watch]
import * as esbuild from 'esbuild';
import { cp, mkdir, rm, stat, writeFile } from 'node:fs/promises';

const watch = process.argv.includes('--watch');
const MP_WASM = 'node_modules/@mediapipe/tasks-vision/wasm';
// MediaPipe's face landmarker model (~3.7 MB), bundled so tracking works offline.
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const MODEL = 'models/face_landmarker.task';

async function fetchModel() {
  if (await stat(MODEL).then(() => true, () => false)) return;
  console.log(`Downloading ${MODEL_URL}`);
  const res = await fetch(MODEL_URL);
  if (!res.ok) throw new Error(`model download failed (HTTP ${res.status})`);
  await mkdir('models', { recursive: true });
  await writeFile(MODEL, Buffer.from(await res.arrayBuffer()));
}

async function copyStatic() {
  await mkdir('dist/tracker', { recursive: true });
  await mkdir('dist/popup', { recursive: true });
  await mkdir('dist/models', { recursive: true });
  await cp('src/manifest.json', 'dist/manifest.json');
  await cp('src/tracker/host.html', 'dist/tracker/host.html');
  await cp('src/popup/popup.html', 'dist/popup/popup.html');
  await cp('src/popup/popup.css', 'dist/popup/popup.css');
  await cp('src/icons', 'dist/icons', { recursive: true });
  // FilesetResolver picks the SIMD or no-SIMD build at runtime.
  for (const f of ['vision_wasm_internal', 'vision_wasm_nosimd_internal']) {
    for (const ext of ['.js', '.wasm']) await cp(`${MP_WASM}/${f}${ext}`, `dist/mediapipe/${f}${ext}`);
  }
  await cp(MODEL, `dist/${MODEL}`);
}

const common = {
  bundle: true,
  target: 'chrome120',
  logLevel: 'info',
  sourcemap: watch ? 'inline' : false,
  minify: !watch,
  legalComments: 'none',
  // Lets the popup detect a page still running a content script from an older build.
  define: { __BUILD_ID__: JSON.stringify(Date.now().toString(36)) },
};

const configs = [
  { ...common, entryPoints: ['src/content/index.ts'], outfile: 'dist/content.js', format: 'iife' },
  { ...common, entryPoints: ['src/popup/popup.ts'], outfile: 'dist/popup/popup.js', format: 'iife' },
  { ...common, entryPoints: ['src/background.ts'], outfile: 'dist/background.js', format: 'iife' },
  { ...common, entryPoints: ['src/tracker/host.ts'], outfile: 'dist/tracker/host.js', format: 'esm' },
];

await fetchModel();
await rm('dist', { recursive: true, force: true });
await copyStatic();
if (watch) {
  for (const c of configs) await (await esbuild.context(c)).watch();
  console.log('Watching… (static files are copied once; restart to pick up html/css/manifest changes)');
} else {
  await Promise.all(configs.map((c) => esbuild.build(c)));
}
