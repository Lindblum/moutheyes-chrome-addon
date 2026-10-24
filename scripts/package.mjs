// Builds the extension and zips dist/ for the Chrome Web Store: moutheyes-<version>.zip, with
// manifest.json at the root. Usage: node scripts/package.mjs
import { execFileSync } from 'node:child_process';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { crc32, deflateRawSync } from 'node:zlib';

execFileSync(process.execPath, ['build.mjs'], { stdio: 'inherit' });

const { version } = JSON.parse(await readFile('package.json', 'utf8'));
const out = `moutheyes-${version}.zip`;
const files = (await readdir('dist', { recursive: true, withFileTypes: true }))
  .filter((d) => d.isFile())
  .map((d) => `${d.parentPath}/${d.name}`.replace(/\\/g, '/').replace(/^dist\//, ''))
  .sort();

// A plain zip (deflate, no extras): local headers and data, then the central directory.
const now = new Date();
const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
const local = [];
const central = [];
let offset = 0;
for (const name of files) {
  const data = await readFile(`dist/${name}`);
  const packed = deflateRawSync(data, { level: 9 });
  const nameBuf = Buffer.from(name, 'utf8');
  const crc = crc32(data);
  const fields = (h, at) => {
    h.writeUInt16LE(20, at); // version needed
    h.writeUInt16LE(0x0800, at + 2); // UTF-8 names
    h.writeUInt16LE(8, at + 4); // deflate
    h.writeUInt16LE(dosTime, at + 6);
    h.writeUInt16LE(dosDate, at + 8);
    h.writeUInt32LE(crc, at + 10);
    h.writeUInt32LE(packed.length, at + 14);
    h.writeUInt32LE(data.length, at + 18);
    h.writeUInt16LE(nameBuf.length, at + 22);
  };
  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0);
  fields(lh, 4);
  local.push(lh, nameBuf, packed);
  const ch = Buffer.alloc(46);
  ch.writeUInt32LE(0x02014b50, 0);
  ch.writeUInt16LE(20, 4); // version made by
  fields(ch, 6);
  ch.writeUInt32LE(offset, 42);
  central.push(ch, nameBuf);
  offset += lh.length + nameBuf.length + packed.length;
}
const dir = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(dir.length, 12);
end.writeUInt32LE(offset, 16);
await writeFile(out, Buffer.concat([...local, dir, end]));
console.log(`Wrote ${out} (${files.length} files, ${((offset + dir.length) / 1024 / 1024).toFixed(1)} MB)`);
