// Downloads test media: 20 s of Tears of Steel with frontal faces, cut from the full film with
// ffmpeg range requests (CC-BY Blender Foundation, mango.blender.org).
import { execFileSync } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';

const SRC = 'https://download.blender.org/demo/movies/ToS/tears_of_steel_720p.mov';
const OUT = 'test/media/faces.mp4';

await mkdir('test/media', { recursive: true });
if (await stat(OUT).then(() => true, () => false)) {
  console.log(`${OUT} already present`);
} else {
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', '122', '-t', '20', '-i', SRC, '-an',
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '23', '-pix_fmt', 'yuv420p', OUT], { stdio: 'inherit' });
  console.log(`Saved ${OUT}`);
}
