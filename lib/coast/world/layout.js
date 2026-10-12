// World layout: the single source of truth for the shape of land and sea floor.
// Pure JS (no three.js) so it can also be evaluated from Node for calibration.
//
// heightAt(x, z) -> metres above sea level (negative = sea floor depth).
// Everything that touches the coastline (terrain meshes, ocean depth/shore-distance bake,
// vegetation placement) MUST derive from these functions so land and water line up.
//
// Frame: +X right (west), -Z forward (south), camera at (0, 35, 0) looking along -Z.
// Calibrated against the reference video (horizon row ~147.5, hFOV 66 deg, pitch -12.36 deg, roll +0.2 deg;
// silhouettes re-solved with the YXZ camera incl. the t=0.5 handheld pose, see tools/calib.mjs).

import { fbm2, valueNoise2 } from '../core/rng.js';

export const SEA_LEVEL = 0;

// ---------------------------------------------------------------------------------------------
// Main Beach mean waterline (x, z) from the near end (hidden behind scrub, right frame edge)
// to the far south. Land is on the +X side.
export const BEACH_WATERLINE = [
  [96, -120], [118, -175], [133, -230], [141, -290], [144, -360], [143, -440], [139, -540],
  [126, -760], [96, -1100], [45, -1600], [-35, -2150], [-250, -4000], [-800, -8000],
  [-2200, -14000], [-4200, -21000], [-7000, -30000], [-10000, -40000],
];

// Foreground headland (the camera stands on it): cliff-top outline, counter-clockwise, x/z.
// Its seaward edge runs from the lower-left frame corner diagonally to the casuarinas
// and then right, above the surging gully in front of the rock platform.
export const HEADLAND_OUTLINE = [
  [-9.4, 40], [-9.0, 12], [-8.4, 2], [-7.8, -5], [-6.8, -8.0], [-5.6, -9.1], [-4.2, -10.4],
  [-3.8, -12.4], [-3.1, -16], [-3.0, -20.6], [-3.4, -26.4], [-3.8, -33.5], [-2.2, -37.0],
  [0.8, -38.5], [7.3, -40.6], [13.4, -45.0], [19.1, -47.4], [24.7, -48.0], [32, -51.3], [40, -56.5],
  [52, -64], [66, -76], [80, -90], [94, -106], [106, -124], [114, -140], [122, -160],
  [130, -190], [138, -228], [190, -190], [230, -60], [230, 60], [-10, 60],
];

// Scrub-covered knoll at the right frame edge behind the platform's east end (image x 1150-1276,
// rows 250-300): centre x/z, radii, height.
export const KNOLL = [134, -200, 14, 22, 15.5];

// Flat-topped rock platform (~10.6 m, eroded outline) across the gully, image x 655..1276, top row ~318.
export const PLATFORM_OUTLINE = [
  [3.5, -143], [7, -140.5], [20, -137.5], [44, -136], [70, -137], [96, -139], [112, -144], [120, -156],
  [114, -163], [90, -162], [60, -161], [30, -160], [12, -159], [6, -156.5], [2.5, -154], [0.5, -150], [1.2, -146],
];
export const PLATFORM_HEIGHT = 10.6;

// Isolated rocks in the surf (x, z, radius, height)
export const ROCKS = [
  [-10.6, -149, 4.0, 0.7], // dark wet rock left of the platform (image ~548-592, rows 370-400)
  [-4, -143, 3.5, -0.3], // awash ledge (drives foam only)
  [-32, -212, 3.0, 0.8], // small rock further out (image ~490,312)
  [4, -222, 4.0, 1.0],
  [-40, -66, 4, -2.6], // submerged wash rock off the foreground cliff (deep enough that wave troughs never bare it)
  [-26, -32, 6, 1.2],
];

// ---------------------------------------------------------------------------------------------
// Geometry helpers

// (allocation-free: these run ~10M times during the load-time bakes. Math.hypot is only evaluated
// for segments that can beat the current best, so the results are bit-identical to the plain loop.)

// Signed distance to an open polyline; positive on the left side when walking the polyline
// (for BEACH_WATERLINE walking toward -Z, "left" is +X = land).
export function polylineSigned(px, pz, pts) {
  let best = Infinity, bestSq = Infinity, sign = 1;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const ax = a[0], az = a[1];
    const vx = b[0] - ax, vz = b[1] - az;
    const wx = px - ax, wz = pz - az;
    const t = Math.max(0, Math.min(1, (wx * vx + wz * vz) / (vx * vx + vz * vz)));
    const dx = wx - vx * t, dz = wz - vz * t;
    if (dx * dx + dz * dz > bestSq) continue; // clearly farther (bestSq carries a 1e-9 margin)
    const d = Math.hypot(dx, dz);
    if (d < best) { best = d; bestSq = d * d * (1 + 1e-9); sign = vx * wz - vz * wx > 0 ? 1 : -1; }
  }
  return best * sign;
}

// Signed distance to a closed polygon: negative inside.
export function polygonSDF(px, pz, pts) {
  let d = Infinity, dSq = Infinity, inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[j], b = pts[i];
    const ax = a[0], az = a[1], bx = b[0], bz = b[1];
    const vx = bx - ax, vz = bz - az;
    const wx = px - ax, wz = pz - az;
    const t = Math.max(0, Math.min(1, (wx * vx + wz * vz) / (vx * vx + vz * vz)));
    const dx = wx - vx * t, dz = wz - vz * t;
    if (dx * dx + dz * dz <= dSq) {
      const e = Math.hypot(dx, dz);
      if (e < d) { d = e; dSq = e * e * (1 + 1e-9); }
    }
    if ((bz > pz) !== (az > pz) && px < ((ax - bx) * (pz - bz)) / (az - bz) + bx) inside = !inside;
  }
  return inside ? -d : d;
}

const smoothstep = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const smax = (a, b, k) => { const h = Math.max(k - Math.abs(a - b), 0) / k; return Math.max(a, b) + h * h * k * 0.25; };

// ---------------------------------------------------------------------------------------------
// Component height fields

// Distance from the beach waterline, positive on land.
export function beachSigned(x, z) { return polylineSigned(x, z, BEACH_WATERLINE); }

function mainland(x, z) {
  const s = beachSigned(x, z);
  if (s < 0) {
    // sandy sea floor: gentle slope with two shore-parallel sand bars (breaker lines)
    const d = -s;
    let h = -0.028 * d - 0.00002 * d * d;
    h += 0.9 * Math.exp(-(((d - 75) / 22) ** 2)) + 0.7 * Math.exp(-(((d - 175) / 30) ** 2));
    h += (fbm2(x * 0.01, z * 0.01, 3) - 0.5) * 0.8;
    // rocky zone around the headland and the platform: deeper gullies, no sand bars
    const deep = smoothstep(-320, -215, z) * smoothstep(128, 92, x);
    h -= deep * (5.0 + (fbm2(x * 0.03 + 4.2, z * 0.03, 3) - 0.5) * 4.0);
    return Math.max(h, -28);
  }
  // beach sand (berm) -> fore-dune -> scrub swale -> near ridge -> main dune ridge (layered hills)
  let h = 0.05 * Math.min(s, 40);
  h += smoothstep(32, 85, s) * (12 + 7 * fbm2(x * 0.004, z * 0.004, 3));
  // hills start well south of the headland so they never block the view to the right
  const hillMask = smoothstep(-250, -1100, z);
  // scrub swale behind the fore-dune, slowly rising
  h += smoothstep(110, 420, s) * (6 + 6 * fbm2(x * 0.003 + 1.3, z * 0.003, 2)) * hillMask;
  if (s > 150) {
    const a1 = fbm2(z * 0.0016 + 7.1, x * 0.001, 3), a2 = fbm2(z * 0.0011 + 2.9, x * 0.0008 + 5.0, 3);
    // near ridge: crest ~700-900 m inland, 70-100 m, crest line wanders along-shore
    const sN = 610 + 160 * (a1 - 0.5);
    const hN = (60 + 30 * (a2 - 0.5)) * (0.72 + 0.28 * smoothstep(-1050, -1650, z));
    // (steep, shaded camera-facing front; the scrub swale in front of it stays nearly flat and sunlit)
    const dN = (s - sN) / (s < sN ? 165 : 320);
    const near = hN * Math.exp(-dN * dN) * smoothstep(240, 440, s);
    // saddle behind, then the main (high dune) ridge 2-3 km inland
    const a3 = fbm2(x * 0.0006 + 3.1, z * 0.00035, 4);
    // (height scale by range re-solved for the -12.36 deg camera pitch: skyline rows of the reference)
    const rng = Math.hypot(x, z);
    const kMain = 0.93 - 0.13 * smoothstep(3700, 4600, rng) - 0.08 * smoothstep(7000, 11000, rng);
    const main = kMain * smoothstep(750, 1750, s) * (160 + 50 * (a3 - 0.5) + 16 * Math.exp(-(((z + 3400) / 600) ** 2)) - 10 * smoothstep(-2900, -2300, z));
    // mid ridge (a separate forested layer between the near ridge and the main ridge)
    const a4 = fbm2(z * 0.0013 + 4.4, x * 0.001 + 1.9, 3);
    const sM = 1180 + 180 * (a4 - 0.5);
    const dM = (s - sM) / (s < sM ? 170 : 260);
    const mid = (78 + 36 * (a2 - 0.5)) * Math.exp(-dM * dM) * smoothstep(-700, -1300, z);
    h += Math.max(near, mid, main) * hillMask;
    // tree-group crowns on the hill forest (2-4 px bumps on the ridge lines)
    const cr = 1 - Math.abs(2 * valueNoise2(x * 0.045 + 7.7, z * 0.045) - 1);
    h += (cr * cr - 0.4) * 9.0 * hillMask * smoothstep(300, 700, s);
  }
  // scrub-canopy roughness
  h += (fbm2(x * 0.03, z * 0.03, 3) - 0.5) * 3.0 * smoothstep(60, 140, s);
  // forest canopy relief on the hills (tree groups break up the ridge line)
  h += (fbm2(x * 0.02 + 5.3, z * 0.02, 3) - 0.5) * 7.0 * hillMask * smoothstep(170, 600, s);
  // high scrubby dune WSW of the platform, always off-frame right (azimuth > 36 deg). Laid out
  // along the sun ray (az 60, el 7): it shades the east half of the platform top as in the
  // reference, while the platform's west end and the foreground tree crowns stay sunlit.
  const u = 0.5 * x + 0.866 * z, v = 0.866 * x - 0.5 * z;
  if (v > 220 && v < 440 && u > -116) {
    h = Math.max(h, 46 * smoothstep(-114, -100, u) * smoothstep(225, 270, v) * smoothstep(430, 380, v) * (0.85 + 0.3 * fbm2(x * 0.02, z * 0.02, 2)));
  }
  return h;
}

// Lower-left brow (reference image x 0-260, rows ~688-718 at t = 0.5): the cliff's brow is a knob of
// dark, blocky coffee rock, not grass. Rock exposure 0..1: everything seaward of a line from
// (-2.85, -6.28) to (-4.6, -8.5) (raycast from the reference: rock to image x ~250 on the bottom row,
// to x ~175 on row 690), with a ragged ~0.4 m noise edge; it merges into the normal 1.4 m cliff rim
// beyond z ~ -9. terrain.js (classify) and grass.js (grassW) both use it.
export function browRockAt(x, z) {
  if (x > -2.0 || x < -10 || z < -9.6 || z > -3) return 0;
  const xb = -2.85 + 0.78 * (z + 6.28) + (fbm2(x * 1.4 + 5.1, z * 1.4 - 2.3, 3) - 0.5) * 0.9 + (valueNoise2(x * 4.1, z * 4.1 + 1.7) - 0.5) * 0.25;
  return smoothstep(xb + 0.06, xb - 0.3, x) * smoothstep(-9.4, -8.4, z);
}
// Left cliff edge beyond the dead shrubs (z -11..-34; reference image x ~500-640, rows 520-610 at
// t = 0.5 / 9): the outer ~1-2 m of the brow (where the view grazes over the edge) is a dark band of
// bare soil, rock and dead litter with a ragged inner edge, not lawn running out to the skyline.
export function edgeRockAt(x, z, d) {
  if (x > 1.5 || x < -7 || z > -10.5 || z < -36) return 0;
  if (d === undefined) d = polygonSDF(x, z, HEADLAND_OUTLINE);
  // (the silhouette lies at d ~ -1.1..-1.9 here: a ~0.3-0.8 m strip of it shows, 10-25 px as in the reference)
  const w = 1.85 + 0.3 * smoothstep(-13, -15, z) * smoothstep(-23, -20, z) + (fbm2(x * 0.8 + 2.1, z * 0.8, 3) - 0.5) * 1.0 + (valueNoise2(x * 3.1, z * 3.1 + 4.4) - 0.5) * 0.45;
  return smoothstep(-w - 0.2, -w + 0.2, d) * smoothstep(-11.0, -12.6, z) * smoothstep(-36, -32, z);
}
// all bare rock / soil on the headland top (both of the above): no lawn, mat or blades there
export function bareRockAt(x, z, d) { return Math.max(browRockAt(x, z), edgeRockAt(x, z, d)); }
// The rock knob's top: angular 0.3-0.5 m blocks standing 0.08-0.3 m above the grass level with open
// joints between them (irregular rocky skyline against the sea at image rows ~686-695, was a smooth
// grass roll-over at rows 699-708). Kept off the outline (the cliff / coastline are unchanged) and
// > 0.3 m seaward of the grass line, so the dead-shrub / tree anchor rays (x > -3.3) never cross it.
function browKnob(x, z, d) {
  if (x > -3.0 || z < -9.2 || z > -4.5 || d > 0) return 0;
  const k = browRockAt(x - 0.35, z) * smoothstep(0.0, -0.7, d) * smoothstep(-9.1, -8.1, z);
  if (k <= 0) return 0;
  const vx = x * 2.6 + 0.25 * valueNoise2(x * 3.0, z * 3.0), vz = z * 2.6;
  const vb = voronoi(vx, vz);
  const ridged = 1 - Math.abs(2 * valueNoise2(x * 5.3 + 1.3, z * 5.3) - 1);
  // each block's top is a tilted facet (angular, not domed)
  const fa = vb.id * 37.7, tilt = 0.03 + 0.04 * hash2(Math.floor(vb.id * 1e6), 7);
  const facet = (Math.cos(fa) * (vx - vb.cx) + Math.sin(fa) * (vz - vb.cz)) * tilt;
  // + crumbly 5-10 cm relief
  const crumb = 0.05 * (ridged - 0.5) + 0.022 * (valueNoise2(x * 11.0 + 4.2, z * 11.0) - 0.5);
  return k * (-0.01 + 0.12 * vb.id + facet + crumb - 0.05 * smoothstep(0.14, 0.0, vb.edge));
}

// Rock lumps and litter mounds along the bare edge band, z -13..-18.5 only (clear of the dead
// shrubs on the lip and of the rays to the casuarina / dead-limb anchors in trees.js, which graze
// this edge further on): 0.5-1 m humps up to ~0.2 m, so the edge against the water reads rocky.
function edgeLumps(x, z, d) {
  if (z > -12.8 || z < -19.0 || x > 1.0 || x < -6.5 || d < -3.2) return 0;
  const k = edgeRockAt(x, z, d) * smoothstep(-13.0, -14.5, z) * smoothstep(-19.0, -17.8, z) * smoothstep(-3.2, -2.2, d) * smoothstep(0.0, -0.5, d);
  if (k <= 0) return 0;
  const vb = voronoi(x * 1.5 + 0.3 * valueNoise2(x * 1.7, z * 1.7), z * 1.5);
  const hump = smoothstep(0.0, 0.3, vb.edge) * (0.06 + 0.14 * vb.id);
  return k * (hump + 0.05 * (valueNoise2(x * 4.3 + 2.0, z * 4.3) - 0.5));
}

// ground anchors of the vegetation on the lower-left lip (x, z), raycast from the reference frame
const LIP_ANCHORS = [[-3.20, -8.05], [-2.68, -8.36], [-2.09, -8.40], [-1.61, -8.64], [-1.15, -9.33], [-0.66, -10.39], [-1.99, -11.62]];
const LIP_DROP = 2.5;
function headland(x, z) {
  // outline bbox x -10..230, z -228..60: beyond 80 m of it the SDF test below returns -30 anyway
  if (x < -90 || x > 310 || z < -308 || z > 140) return -30;
  const d = polygonSDF(x, z, HEADLAND_OUTLINE); // <0 inside
  if (d > 80) return -30;
  // plateau: ground under camera ~33.4, falls forward (toward -Z) and toward the left edge
  const fwd = Math.min(Math.max(0, -z), 160);
  // west of the casuarinas (off-frame right) the headland stays high; it shades the platform
  const west = smoothstep(45, 110, x) * smoothstep(-175, -125, z);
  let top = 33.4 - (0.36 * fwd - 0.00095 * fwd * fwd) * (1 - 0.55 * west);
  top += Math.min(Math.max(0, x), 120) * 0.02; // rises gently toward the scrub on the right
  top -= Math.max(0, d + 1.5) * 0.6; // slight brow right at the cliff edge
  // behind the casuarinas the brow rolls over earlier (the sea shows down to image row ~500)
  top -= smoothstep(-7, 0, d) * 1.1 * smoothstep(3, 9, x) * smoothstep(24, 18, x) * smoothstep(-30, -36, z);
  // tussocks and rock lumps along the edge (irregular skyline at the 2-5 px scale)
  top += (fbm2(x * 0.5 + 3.3, z * 0.5, 3) - 0.5) * 0.9 * smoothstep(-3.5, -0.5, d) * smoothstep(-34, -40, z);
  top += (fbm2(x * 0.08, z * 0.08, 4) - 0.5) * 1.4;
  // lower-left lip (reference image x ~200-430): the brow rolls over lower toward the edge, except
  // within ~1 m of the dead-shrub / tree bases that are raycast onto it (grass.js DEAD_SHRUB_PX,
  // trees.js G(482,606)), so those anchors stay where they are.
  if (x > -6.5 && x < -1.4 && z < -6.5 && z > -15 && d > -2.6) {
    let dmin = 9;
    for (const [ax, az] of LIP_ANCHORS) dmin = Math.min(dmin, Math.hypot(x - ax, z - az));
    top -= LIP_DROP * smoothstep(-2.5, -0.9, d) * smoothstep(-1.5, -2.3, x) * smoothstep(-6.6, -7.6, z) * smoothstep(-15.0, -13.5, z)
      * smoothstep(1.0, 1.3, dmin);
  }
  if (d <= 0) return top + browKnob(x, z, d) + edgeLumps(x, z, d);
  // cliff: steep, rough drop into the sea
  const rough = (fbm2(x * 0.15, z * 0.15, 3) - 0.5) * 3.0;
  const cliff = top - 0.9 - d * (3.2 + rough * 0.3);
  return Math.max(cliff, -6 - d * 0.08);
}

// jittered-grid Voronoi (cell size 1): returns nearest-cell hash in [0,1) and edge distance
function hash2(i, j) { let h = (i * 374761393 + j * 668265263) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }
function voronoi(px, pz) {
  const ix = Math.floor(px), iz = Math.floor(pz);
  let d1 = 9, d2 = 9, id = 0, ncx = 0, ncz = 0;
  for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
    const cx = ix + i + 0.15 + 0.7 * hash2(ix + i, iz + j), cz = iz + j + 0.15 + 0.7 * hash2(iz + j + 71, ix + i - 13);
    const d = (px - cx) ** 2 + (pz - cz) ** 2;
    if (d < d1) { d2 = d1; d1 = d; id = hash2(ix + i + 19, iz + j + 5); ncx = cx; ncz = cz; } else if (d < d2) d2 = d;
  }
  return { id, edge: Math.sqrt(d2) - Math.sqrt(d1), cx: ncx, cz: ncz };
}

// Front-edge top height of the platform along x (m), measured from the reference at t=0.5:
// ~10.2 m in the east, stepping down in broken blocks to the water at the west end (x ~ 0).
const PLAT_PROFILE = [[-4, -1.0], [0.5, 0.4], [2.5, 1.4], [5.0, 2.3], [7.0, 2.7], [9.5, 4.1], [12.5, 6.4],
  [16, 7.6], [19, 8.5], [22, 8.9], [30, 9.2], [40, 9.6], [55, 10.1], [200, 10.2]];
function interp(pts, x) {
  if (x <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) if (x <= pts[i][0]) { const [x0, y0] = pts[i - 1], [x1, y1] = pts[i]; return y0 + (y1 - y0) * (x - x0) / (x1 - x0); }
  return pts[pts.length - 1][1];
}

function platform(x, z) {
  if (x < -40 || x > 170 || z > -95 || z < -215) return -30;
  // eroded, irregular outline (chipped edge) and a blocky top; steep, jointed, ledged faces
  const e = (fbm2(x * 0.09 + 11.3, z * 0.09, 3) - 0.5) * 4.4 + (valueNoise2(x * 0.22 + 3.7, z * 0.22) - 0.5) * 1.8
    + (valueNoise2(x * 0.6 + 1.1, z * 0.6) - 0.5) * 0.6;
  // vertical joints every ~5.3 m (jittered): 0.5 m slots that notch the top edge and groove the face
  const jx = x / 5.3 + 0.4 * (valueNoise2(z * 0.07, 2.7) - 0.5);
  const jf = jx - Math.floor(jx);
  const jh = hash2(Math.floor(jx + 0.5), 29);
  const slot = smoothstep(0.43, 0.475, Math.abs(jf - 0.5)) * smoothstep(0.35, 0.55, jh) * (0.4 + jh);
  let d = polygonSDF(x, z, PLATFORM_OUTLINE) + e + 0.9 * slot;
  // small bites out of the edge (0.5-1 m notches)
  if (d > -1.8 && valueNoise2(x * 0.9 + 1.7, z * 0.9) > 0.62) d += 0.6;
  const n = fbm2(x * 0.12, z * 0.12, 4);
  const n2 = valueNoise2(x * 0.7, z * 0.7);
  // blocky erosion: 1.5-4 m joint blocks, each raised/lowered by up to +-0.3 m
  const vb = voronoi(x * 0.38 + 0.3 * n, z * 0.38);
  const block = (Math.round(vb.id * 4) / 4 - 0.5) * 0.6 - 0.3 * smoothstep(0.12, 0.0, vb.edge);
  // front-edge profile; the west part breaks down into the water in ~2.8 m blocks
  const bw = 2.8, bx = (x + 1.4 * (valueNoise2(z * 0.4, 5.1) - 0.5)) / bw, bi = Math.floor(bx);
  const stepped = interp(PLAT_PROFILE, (bi + 0.5) * bw) + (hash2(bi, 3) - 0.5) * 0.7;
  const prof = stepped + (interp(PLAT_PROFILE, x) - stepped) * smoothstep(16, 30, x);
  // the top dips gently away from the front edge (seen nearly edge-on from the lookout)
  const back = Math.max(0, -z - 140.5) * 0.12 * smoothstep(8, 20, x);
  let top = prof + (n - 0.5) * 1.3 + (n2 - 0.5) * 0.4 + block - back;
  const face = (dd, tp) => {
    if (dd <= 0) return tp - smoothstep(-0.6, 0, dd) * 0.35;
    // steep jointed faces with 1.4 m ledges and slumped lower talus
    // upper lip slopes (~50 deg, weathered and sunlit), the lower 6-7 m are steep
    const drop = Math.min(dd, 2.6) * 1.35 + Math.max(0, dd - 2.6) * 4.4 + Math.max(0, dd - 4.2) * 1.6;
    const q = drop / 1.4, qf = q - Math.floor(q);
    const dropQ = (Math.floor(q) + smoothstep(0.35, 1.0, qf)) * 1.4;
    return Math.max(tp - 0.35 - dropQ - Math.sin(drop * 1.3) * 0.15, -5 - dd * 0.1);
  };
  // East of x ~18 (reference image x > ~780) the front is a broken, weathered shelf rather than one
  // wall: ~6.5 m joint blocks whose upper face is set back 1-4.5 m behind a bench at 25-75 % of the
  // height (some blocks twice; each block with its own top level, +-0.7 m), so the face reads as
  // ledges, blocks and shaded recesses (terrain.js darkens them with a baked occlusion term).
  const kE = smoothstep(16, 26, x);
  const f0 = face(d, top);
  if (kE > 0 && d > -9 && f0 > 2.5) { // (the lower 2.5 m, i.e. the waterline footprint, is unchanged)
    const cx = (x + 2.4 * (valueNoise2(z * 0.35, 8.1) - 0.5)) / 6.5, ci = Math.floor(cx);
    const hA = hash2(ci, 41), hB = hash2(ci, 43), hC = hash2(ci, 47), hD = hash2(ci, 53), hE = hash2(ci, 59);
    const wob = 0.75 + 0.5 * valueNoise2(x * 0.45 + 2.2, z * 0.45);
    const sb = kE * (hA < 0.25 ? 0.3 : 1.0 + 3.5 * hB) * wob;
    const tpU = top + kE * ((hD - 0.5) * 1.4 - 0.35 * smoothstep(0.12, 0.0, Math.min(cx - ci, ci + 1 - cx)));
    const hb = top * (0.25 + 0.5 * hC) + (valueNoise2(x * 0.9, z * 0.9 + 3.0) - 0.5) * 0.8 - 0.3 * Math.max(0, d);
    let h = Math.max(face(d + sb, tpU), Math.min(Math.max(hb, 2.5), f0));
    // some blocks step back twice (a second, higher bench)
    if (hE > 0.55) {
      const sb2 = kE * (1.2 + 2.0 * hash2(ci, 61)) * wob;
      const hb2 = hb + (tpU - hb) * (0.45 + 0.25 * hash2(ci, 67));
      h = Math.max(face(d + sb + sb2, tpU), Math.min(hb2, h));
    }
    return h;
  }
  return f0;
}

function knoll(x, z) {
  const [kx, kz, rx, rz, kh] = KNOLL;
  const dx = (x - kx) / rx, dz = (z - kz) / rz;
  const r2 = dx * dx + dz * dz;
  if (r2 > 6) return -30;
  const n = fbm2(x * 0.05, z * 0.05, 3);
  let h = kh * Math.exp(-r2 * 1.1) * (0.8 + 0.4 * n) - 3 + (1 - Math.min(1, r2)) * 2;
  // low rocky shoulder toward the platform (carries the windswept bush of the groundcover module)
  h = Math.max(h, 5.0 * Math.exp(-((x - 104) ** 2 + (z + 181) ** 2) / 70) - 1.2 + (n - 0.5) * 1.5);
  // lumpy outline: 2.5-4 m bush domes on the scrub-covered crest and flanks
  const vb = voronoi(x * 0.3 + 0.4 * n, z * 0.3);
  h += (1.8 * smoothstep(0.0, 0.45, vb.edge) - 0.6 + 0.6 * vb.id) * smoothstep(2.2, 0.8, r2);
  return h;
}

function rocks(x, z) {
  let h = -30;
  for (const [rx, rz, r, rh] of ROCKS) {
    const dd = Math.hypot(x - rx, z - rz) / r;
    if (dd < 2) {
      // faceted, flat-topped, jagged (ridged noise + 0.3 m strata steps)
      const n = valueNoise2(x * 1.1 + rx, z * 1.1);
      const ridged = 1 - Math.abs(2 * valueNoise2(x * 1.7, z * 1.7 + rz) - 1);
      const ridged2 = 1 - Math.abs(2 * valueNoise2(x * 0.6 + 3.1, z * 0.6 + rz) - 1);
      let v = Math.min(rh, rh * 1.6 * (1 - dd)) + 0.7 * (ridged - 0.5) + 0.5 * (ridged2 - 0.5) + (n - 0.5) * 0.5 - 0.2;
      // angular facets: a few tilted planes cut the top
      const fa = hash2(Math.floor(x * 0.8 + 0.5 * n), Math.floor(z * 0.8)) * 6.283;
      v -= Math.max(0, Math.cos(fa) * (x - rx) + Math.sin(fa) * (z - rz)) * 0.25;
      h = Math.max(h, v);
    }
  }
  return h;
}

// ---------------------------------------------------------------------------------------------
// Public API

export function heightAt(x, z) {
  let h = mainland(x, z);
  h = smax(h, headland(x, z), 6);
  h = smax(h, knoll(x, z), 4);
  h = smax(h, platform(x, z), 3);
  h = Math.max(h, rocks(x, z));
  return h;
}

// Per-component heights (for material classification in the terrain module).
export function componentsAt(x, z) {
  const main = mainland(x, z), head = headland(x, z), plat = platform(x, z), rock = rocks(x, z), knl = knoll(x, z);
  let h = smax(main, head, 6);
  h = smax(h, knl, 4);
  h = smax(h, plat, 3);
  h = Math.max(h, rock);
  return { h, main, head, plat, rock, knoll: knl };
}

// Which surface material dominates at a land point (hint for shading/vegetation placement).
// Returns one of 'sea' | 'sand' | 'dune' | 'rock' | 'grass'.
export function surfaceAt(x, z) {
  const h = heightAt(x, z);
  if (h < 0) return 'sea';
  if (polygonSDF(x, z, PLATFORM_OUTLINE) < 2) return 'rock';
  if (rocks(x, z) > h - 0.3) return 'rock';
  if (knoll(x, z) > h - 0.5) return 'dune'; // scrub-covered knoll
  const dh = polygonSDF(x, z, HEADLAND_OUTLINE);
  if (dh < 0) return dh > -3 ? 'rock' : 'grass';
  if (dh < 25 && h < 30) return 'rock';
  const s = beachSigned(x, z);
  if (s < 55) return 'sand';
  return 'dune';
}

// Bounds of the detailed near field (used by terrain meshing / ocean bakes)
export const NEAR_BOUNDS = { minX: -400, maxX: 600, minZ: -1400, maxZ: 120 };
