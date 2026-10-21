// Face geometry for moutheyes, ported from moutheyes-py's moutheye_frame(): where each mouth
// copy goes, its soft mask, and the skin-colour model that gates and tints it. The renderer's
// shader mirrors maskAlpha(), rgbToLab() and skinProb(); keep them in step.

// MediaPipe face-mesh landmark indices
export const LIPS_OUTER = [61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291,
  375, 321, 405, 314, 17, 84, 181, 91, 146];
export const MOUTH_L = 61;
export const MOUTH_R = 291;
/** (outer corner, inner corner, top lid, bottom lid) for each eye */
export const EYES = [[33, 133, 159, 145], [263, 362, 386, 374]] as const;
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

export interface EyeGeom {
  /** Destination (eye) -> source (mouth) affine, row-major 2x3. */
  inv: [number, number, number, number, number, number];
  /** Destination quad covering the mouth copy: 4 corners as x, y pairs. */
  quad: number[];
  /** Colour gain matching the copy to the skin around the eye. */
  gain: [number, number, number];
}

export interface FaceGeom {
  /** Convex hull of the outer lips, flat x, y pairs, frame pixels. */
  hull: number[];
  /** Mouth width (corner to corner). */
  mw: number;
  eyes: EyeGeom[];
  skin: SkinModel | null;
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

/**
 * Where each eye gets its mouth: the mouth is scaled to mouthScale x the eye's width, turned to
 * the eye line (both eyes share its angle so the pair looks consistent) and centred on the eye.
 */
export function faceGeometry(L: Landmarks, mouthScale: number): Omit<FaceGeom, 'skin'> {
  const ml = pt(L, MOUTH_L);
  const mr = pt(L, MOUTH_R);
  const mw = mouthWidth(L);
  const mouthAng = Math.atan2(mr[1] - ml[1], mr[0] - ml[0]);
  const lips = LIPS_OUTER.map((i) => pt(L, i));
  const mc = mean(lips);
  const hullPts = convexHull(lips).slice(0, MAX_HULL);
  const hull = hullPts.flat();

  const m = maskParams(mw);
  const grow = m.pad + 3 * m.sigma;
  const xs = hullPts.map((p) => p[0]);
  const ys = hullPts.map((p) => p[1]);
  const box: [number, number][] = [
    [Math.min(...xs) - grow, Math.min(...ys) - grow],
    [Math.max(...xs) + grow, Math.min(...ys) - grow],
    [Math.max(...xs) + grow, Math.max(...ys) + grow],
    [Math.min(...xs) - grow, Math.max(...ys) + grow],
  ];

  const eCenters = EYES.map((e) => mean([pt(L, e[0]), pt(L, e[1])]));
  const eyeAng = Math.atan2(eCenters[1][1] - eCenters[0][1], eCenters[1][0] - eCenters[0][0]);
  const eyes = EYES.map(([o, i, top, bot]): EyeGeom => {
    const ew = dist(pt(L, o), pt(L, i));
    const ec = mean([pt(L, o), pt(L, i), pt(L, top), pt(L, bot)]);
    const s = (mouthScale * ew) / mw;
    // src -> dest: rotate by (eyeAng - mouthAng) and scale about the mouth centre, then move it onto the eye.
    const th = eyeAng - mouthAng;
    const a = s * Math.cos(th);
    const b = s * Math.sin(th);
    const fwd = (p: [number, number]) => [
      a * (p[0] - mc[0]) - b * (p[1] - mc[1]) + ec[0],
      b * (p[0] - mc[0]) + a * (p[1] - mc[1]) + ec[1],
    ];
    // dest -> src
    const k = 1 / (a * a + b * b);
    const ia = a * k;
    const ib = b * k;
    const inv: EyeGeom['inv'] = [ia, ib, mc[0] - ia * ec[0] - ib * ec[1], -ib, ia, mc[1] + ib * ec[0] - ia * ec[1]];
    return { inv, quad: box.flatMap(fwd), gain: [1, 1, 1] };
  });
  return { hull, mw, eyes };
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
