// Face geometry for moutheyes, ported from moutheyes-py's moutheye_frame(): where each mouth
// copy goes, its soft mask, and the skin-colour model that gates and tints it. The renderer's
// shader mirrors maskAlpha(), rgbToLab() and skinProb() (and adds the lip-colour object filter);
// keep them in step.

// MediaPipe face-mesh landmark indices
export const LIPS_OUTER = [61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291,
  375, 321, 405, 314, 17, 84, 181, 91, 146];
export const MOUTH_L = 61;
export const MOUTH_R = 291;
/** (outer corner, inner corner, top lid, bottom lid) for each eye */
export const EYES = [[33, 133, 159, 145], [263, 362, 386, 374]] as const;
/** Inner lip line, upper then lower, corner to corner. */
export const INNER_UPPER = [78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308];
export const INNER_LOWER = [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308];
/** (outer, inner) lip point pairs; the lip colour is sampled midway between them. */
export const LIP_BAND = [[185, 191], [40, 80], [39, 81], [37, 82], [0, 13], [267, 312], [269, 311], [270, 310], [409, 415],
  [146, 95], [91, 88], [181, 178], [84, 87], [17, 14], [314, 317], [405, 402], [321, 318], [375, 324]];
/** Upper cheeks, forehead and nose bridge: skin on most faces, clear of lips, eyes, brows and beards. */
export const SKIN_POINTS = [50, 280, 101, 330, 117, 346, 151, 108, 337, 6, 197];
export const MAX_HULL = 24;

/** Landmarks as a flat [x0, y0, x1, y1, ...] array in frame pixels. */
export type Landmarks = Float32Array;

export interface SkinModel {
  /** Mean Lab chroma, inverse chroma covariance (row-major 2x2), lightness range. */
  ab: [number, number];
  icov: [number, number, number, number];
  lo: number;
  hi: number;
  margin: number;
}

/** A mouth as it was in one frame. */
export interface MouthGeom {
  /** Centre (mean of the outer lip points), corner-to-corner width and angle (radians). */
  c: [number, number];
  w: number;
  ang: number;
  /** Convex hull of the outer lips, flat x, y pairs, frame pixels. */
  hull: number[];
  /** The mouth opening (inside the inner lip line), flat x, y pairs, frame pixels. */
  inner: number[];
}

/** Where a mouth copy goes: an eye's centre, corner-to-corner width and the eye-line angle. */
export interface EyeSpot {
  c: [number, number];
  w: number;
  ang: number;
}

export interface Placement {
  /** Destination (eye) -> source (mouth) affine, row-major 2x3. */
  inv: [number, number, number, number, number, number];
  /** Destination quad covering the mouth copy: 4 corners as x, y pairs. */
  quad: number[];
}

export interface FaceGeom {
  /** Stable while the face stays tracked. */
  id: number;
  mouth: MouthGeom;
  eyes: EyeSpot[];
  /** Mouth size relative to the eye. */
  scale: number;
  /** Per eye, the colour gain matching the copy to the skin around it. */
  gains: [number, number, number][];
  skin: SkinModel | null;
  /** Lip colour, for the object filter. */
  lips: SkinModel | null;
  /**
   * False while the face is held in place undetected without a skin check that it's still
   * there: its eyes then show the live mouth, not echoes of its old one.
   */
  echo: boolean;
}

const pt = (L: Landmarks, i: number): [number, number] => [L[2 * i], L[2 * i + 1]];
const dist = (a: [number, number], b: [number, number]) => Math.hypot(b[0] - a[0], b[1] - a[1]);
const mean = (ps: [number, number][]): [number, number] => [
  ps.reduce((s, p) => s + p[0], 0) / ps.length,
  ps.reduce((s, p) => s + p[1], 0) / ps.length,
];

export function mouthWidth(L: Landmarks): number {
  return dist(pt(L, MOUTH_L), pt(L, MOUTH_R)) + 1e-6;
}

export function eyeSpan(L: Landmarks): number {
  return dist(pt(L, EYES[0][0]), pt(L, EYES[1][0]));
}

/** Monotone-chain convex hull, counter-clockwise in y-down image space. */
export function convexHull(ps: [number, number][]): [number, number][] {
  const p = [...ps].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: [number, number][] = [];
  for (const q of p.reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/** Mask shape for a mouth of width mw, as in moutheyes-py. */
export function maskParams(mw: number) {
  return {
    /** Thin border that always comes along (lip edges aren't skin-coloured). */
    core: Math.max(1, Math.floor(0.04 * mw)),
    /** Margin of surrounding skin, kept only where it is skin. */
    pad: Math.max(2, Math.floor(0.12 * mw)),
    /** Feather (Gaussian sigma). */
    sigma: 0.1 * mw + 1,
    /** Cleared margin at the frame edge, so a mouth there still gets a feathered edge. */
    edge: Math.floor(0.2 * mw) + 1,
  };
}

/** Standard normal CDF (tanh approximation): a blurred step. */
function phi(x: number): number {
  return 0.5 * (1 + Math.tanh(0.7978845608 * (x + 0.044715 * x * x * x)));
}

/**
 * Mask alpha at signed distance d from the lip hull (negative inside), skin probability p and
 * distance e from the nearest frame edge: the hull grown by `core` plus the hull grown by `pad`
 * gated on skin, both feathered, faint tails cut.
 */
export function maskAlpha(d: number, p: number, e: number, m: ReturnType<typeof maskParams>): number {
  const soft = (r: number) => phi((r - d) / m.sigma);
  const a = Math.max(soft(m.core), soft(m.pad) * p) * phi((e - m.edge) / m.sigma);
  return Math.min(1, Math.max(0, (a - 0.04) / 0.96));
}

/** Signed distance from a polygon (flat x, y pairs), negative inside. */
export function sdPolygon(poly: number[], x: number, y: number): number {
  const n = poly.length / 2;
  let d = Infinity;
  let s = 1;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const ex = poly[2 * j] - poly[2 * i];
    const ey = poly[2 * j + 1] - poly[2 * i + 1];
    const wx = x - poly[2 * i];
    const wy = y - poly[2 * i + 1];
    const t = Math.min(1, Math.max(0, (wx * ex + wy * ey) / (ex * ex + ey * ey || 1)));
    d = Math.min(d, (wx - ex * t) ** 2 + (wy - ey * t) ** 2);
    const c1 = y >= poly[2 * i + 1];
    const c2 = y < poly[2 * j + 1];
    const c3 = ex * wy > ey * wx;
    if ((c1 && c2 && c3) || (!c1 && !c2 && !c3)) s = -s;
  }
  return s * Math.sqrt(d);
}

export function mouthGeom(L: Landmarks): MouthGeom {
  const ml = pt(L, MOUTH_L);
  const mr = pt(L, MOUTH_R);
  const lips = LIPS_OUTER.map((i) => pt(L, i));
  return {
    c: mean(lips),
    w: mouthWidth(L),
    ang: Math.atan2(mr[1] - ml[1], mr[0] - ml[0]),
    hull: convexHull(lips).slice(0, MAX_HULL).flat(),
    inner: [...INNER_UPPER, ...INNER_LOWER.slice(1, -1).reverse()].flatMap((i) => pt(L, i)),
  };
}

/** Both eyes share the eye-line angle so the pair looks consistent. */
export function eyeSpots(L: Landmarks): EyeSpot[] {
  const lines = EYES.map((e) => mean([pt(L, e[0]), pt(L, e[1])]));
  const ang = Math.atan2(lines[1][1] - lines[0][1], lines[1][0] - lines[0][0]);
  return EYES.map(([o, i, top, bot]) => ({
    c: mean([pt(L, o), pt(L, i), pt(L, top), pt(L, bot)]),
    w: dist(pt(L, o), pt(L, i)),
    ang,
  }));
}

/** The square of the frame that holds everything a mouth's mask can reach: x, y, side. */
export function mouthBox(m: MouthGeom): [number, number, number] {
  const mp = maskParams(m.w);
  const grow = mp.pad + 3 * mp.sigma;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < m.hull.length; i += 2) {
    x0 = Math.min(x0, m.hull[i]);
    x1 = Math.max(x1, m.hull[i]);
    y0 = Math.min(y0, m.hull[i + 1]);
    y1 = Math.max(y1, m.hull[i + 1]);
  }
  const side = Math.max(x1 - x0, y1 - y0) + 2 * grow;
  return [(x0 + x1 - side) / 2, (y0 + y1 - side) / 2, side];
}

/**
 * Where a mouth goes on an eye: scaled to `scale` x the eye's width, turned to the eye line and
 * centred on the eye. The mouth may be from an earlier frame than the eye.
 */
export function placeMouth(m: MouthGeom, e: EyeSpot, scale: number): Placement {
  const s = (scale * e.w) / m.w;
  // src -> dest: rotate by (eye angle - mouth angle) and scale about the mouth centre, then move it onto the eye.
  const th = e.ang - m.ang;
  const a = s * Math.cos(th);
  const b = s * Math.sin(th);
  const [mx, my] = m.c;
  const [ex, ey] = e.c;
  const fwd = (x: number, y: number) => [a * (x - mx) - b * (y - my) + ex, b * (x - mx) + a * (y - my) + ey];
  // dest -> src
  const k = 1 / (a * a + b * b);
  const ia = a * k;
  const ib = b * k;
  const [bx, by, side] = mouthBox(m);
  return {
    inv: [ia, ib, mx - ia * ex - ib * ey, -ib, ia, my + ib * ex - ia * ey],
    quad: [...fwd(bx, by), ...fwd(bx + side, by), ...fwd(bx + side, by + side), ...fwd(bx, by + side)],
  };
}

/** sRGB (0..255) to Lab scaled like OpenCV's 8-bit COLOR_RGB2LAB (L 0..255, a/b offset by 128). */
export function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  const lin = (c: number) => {
    c /= 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const R = lin(r);
  const G = lin(g);
  const B = lin(b);
  const X = (0.412453 * R + 0.35758 * G + 0.180423 * B) / 0.950456;
  const Y = 0.212671 * R + 0.71516 * G + 0.072169 * B;
  const Z = (0.019334 * R + 0.119193 * G + 0.950227 * B) / 1.088754;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const L = Y > 0.008856 ? 116 * Math.cbrt(Y) - 16 : 903.3 * Y;
  return [(L * 255) / 100, 500 * (f(X) - f(Y)) + 128, 200 * (f(Y) - f(Z)) + 128];
}

/** 0..1: how well a Lab colour matches the skin model. */
export function skinProb(s: SkinModel, lab: [number, number, number]): number {
  const da = lab[1] - s.ab[0];
  const db = lab[2] - s.ab[1];
  const d = Math.sqrt(Math.max(0, da * (s.icov[0] * da + s.icov[1] * db) + db * (s.icov[2] * da + s.icov[3] * db)));
  const chroma = Math.min(1, Math.max(0, (4.5 - d) / 1.5)); // full weight within 3 sigma, none past 4.5
  const off = Math.max(s.lo - lab[0], lab[0] - s.hi);
  return chroma * Math.min(1, Math.max(0, 1 - off / s.margin));
}
