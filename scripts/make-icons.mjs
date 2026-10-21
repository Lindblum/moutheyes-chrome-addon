// Generates the extension icons (a face whose eyes are mouths, on a dark tile) without any deps.
import { mkdir, writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

// Colour of the icon at (x, y) in unit coordinates (0..1), or null outside the tile.
function shade(x, y) {
  const r = 0.2; // tile corner radius
  const dx = Math.max(r - x, 0, x - (1 - r));
  const dy = Math.max(r - y, 0, y - (1 - r));
  if (Math.hypot(dx, dy) > r) return null;
  const inEllipse = (cx, cy, rx, ry) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
  // An open, smiling mouth: red lips around a dark opening with a row of upper teeth.
  const mouth = (cx, cy, rx, ry) => {
    if (!inEllipse(cx, cy, rx, ry)) return null;
    const u = (x - cx) / rx;
    const top = cy - ry * 0.15 + ry * 0.25 * u * u; // opening is a crescent, widest in the middle
    const bot = cy + ry * 0.55 - ry * 0.45 * u * u;
    if (y < top || y > bot) return [222, 48, 72];
    return y < top + (bot - top) * 0.35 ? [250, 250, 245] : [70, 12, 22];
  };
  const parts = [mouth(0.32, 0.4, 0.15, 0.11), mouth(0.68, 0.4, 0.15, 0.11), mouth(0.5, 0.72, 0.19, 0.12)];
  for (const c of parts) if (c) return c;
  if (inEllipse(0.5, 0.53, 0.42, 0.42)) return [250, 200, 80];
  return [32, 34, 38];
}

function png(size) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  const SS = 4; // supersampling per axis, for antialiasing
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const sum = [0, 0, 0, 0];
      for (let j = 0; j < SS; j++) {
        for (let i = 0; i < SS; i++) {
          const c = shade((x + (i + 0.5) / SS) / size, (y + (j + 0.5) / SS) / size);
          if (!c) continue;
          for (let k = 0; k < 3; k++) sum[k] += c[k];
          sum[3]++;
        }
      }
      const o = y * (size * 4 + 1) + 1 + x * 4;
      for (let k = 0; k < 3; k++) raw[o + k] = sum[3] ? Math.round(sum[k] / sum[3]) : 0;
      raw[o + 3] = Math.round((sum[3] / (SS * SS)) * 255);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

await mkdir('src/icons', { recursive: true });
for (const s of [16, 32, 48, 128]) await writeFile(`src/icons/icon${s}.png`, png(s));
console.log('Wrote src/icons/icon{16,32,48,128}.png');
