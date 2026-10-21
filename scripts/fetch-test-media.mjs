// Downloads test media: 20 s of Tears of Steel with frontal faces, cut from the full film with
// ffmpeg range requests (CC-BY Blender Foundation, mango.blender.org). Also makes occluded.mp4:
// the same clip with a yellow bar across the first face's lips from 6 s to 10 s, for the object filter,
// cut.mp4: 2 s of a face, then a hard cut to 2 s of a test pattern with no face, and still
// pictures for image conversion in stills/.
import { execFileSync } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';

const SRC = 'https://download.blender.org/demo/movies/ToS/tears_of_steel_720p.mov';
const OUT = 'test/media/faces.mp4';
const OCCLUDED = 'test/media/occluded.mp4';
const CUT = 'test/media/cut.mp4';
const exists = (p) => stat(p).then(() => true, () => false);

await mkdir('test/media', { recursive: true });
if (await exists(OUT)) {
  console.log(`${OUT} already present`);
} else {
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', '122', '-t', '20', '-i', SRC, '-an',
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '23', '-pix_fmt', 'yuv420p', OUT], { stdio: 'inherit' });
  console.log(`Saved ${OUT}`);
}

if (await exists(OCCLUDED)) {
  console.log(`${OCCLUDED} already present`);
} else {
  const bar = (x, y, w, h, color) => `drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=${color}:t=fill:enable='between(t,6,10)'`;
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', OUT, '-vf', `${bar(440, 174, 180, 14, 'black')},${bar(442, 176, 176, 10, 'yellow')}`,
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-pix_fmt', 'yuv420p', OCCLUDED], { stdio: 'inherit' });
  console.log(`Saved ${OCCLUDED}`);
}

if (await exists(CUT)) {
  console.log(`${CUT} already present`);
} else {
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', '8', '-t', '2', '-i', OUT, '-f', 'lavfi', '-i', 'testsrc2=size=1280x534:rate=24:duration=2',
    '-filter_complex', '[0:v]fps=24,setsar=1[a];[1:v]setsar=1[b];[a][b]concat=n=2:v=1[v]', '-map', '[v]',
    '-c:v', 'libx264', '-preset', 'fast', '-pix_fmt', 'yuv420p', CUT], { stdio: 'inherit' });
  console.log(`Saved ${CUT}`);
}

// Still pictures: two faces, a face that is tiny in a wide shot (the close-up at a quarter size,
// pasted into the wide shot, whose own figure looks down and isn't findable), no face, and a
// cut-out portrait with a transparent background.
const STILLS = 'test/media/stills';
await mkdir(STILLS, { recursive: true });
const frame = (t, out, vf = []) => execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(t), '-i', OUT, '-frames:v', '1',
  ...(vf.length ? ['-vf', vf.join(',')] : []), out], { stdio: 'inherit' });
const stills = {
  'face.jpg': () => frame(9, `${STILLS}/face.jpg`),
  'face2.jpg': () => frame(19, `${STILLS}/face2.jpg`),
  'small-face.jpg': () => execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', '15', '-i', OUT, '-ss', '9', '-i', OUT,
    '-filter_complex', '[1]scale=320:-1[s];[0][s]overlay=60:330', '-frames:v', '1', `${STILLS}/small-face.jpg`], { stdio: 'inherit' }),
  'portrait.png': () => frame(9, `${STILLS}/portrait.png`, ['crop=300:300:280:0', 'format=rgba',
    "geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lt(hypot(X-150,Y-140),130),255,0)'"]),
  // Animations: a face as GIF and as APNG (an animated picture whose name doesn't say so), no
  // face, and a cut-out face with a transparent background.
  'anim.gif': () => execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', '8', '-t', '2', '-i', OUT, '-vf',
    'fps=10,scale=480:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse', '-loop', '0', `${STILLS}/anim.gif`], { stdio: 'inherit' }),
  'anim.png': () => execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', '8', '-t', '1', '-i', OUT, '-vf', 'fps=10,scale=320:-1',
    '-plays', '0', '-f', 'apng', `${STILLS}/anim.png`], { stdio: 'inherit' }),
  'anim-noface.gif': () => execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=10:duration=1', '-vf',
    'split[a][b];[a]palettegen[p];[b][p]paletteuse', '-loop', '0', `${STILLS}/anim-noface.gif`], { stdio: 'inherit' }),
  'anim-alpha.gif': () => execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', '8.5', '-t', '1', '-i', OUT, '-vf',
    "fps=10,crop=300:300:280:0,format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lt(hypot(X-150,Y-140),130),255,0)'," +
    'split[a][b];[a]palettegen=reserve_transparent=1[p];[b][p]paletteuse=alpha_threshold=128', '-loop', '0', `${STILLS}/anim-alpha.gif`], { stdio: 'inherit' }),
  'noface.png': () => execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360', '-frames:v', '1',
    `${STILLS}/noface.png`], { stdio: 'inherit' }),
};
for (const [name, make] of Object.entries(stills)) {
  if (await exists(`${STILLS}/${name}`)) continue;
  make();
  console.log(`Saved ${STILLS}/${name}`);
}
