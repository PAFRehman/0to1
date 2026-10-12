// Procedural, tileable foam texture baked once at load (RGBA8, mip-mapped).
//   R: lace — domain-warped ridged noise (marbled filaments, 1.5-3 m) over a weak Worley network
//   G: bubbles / fine speckle (~0.2 m)
//   B: mid-scale patchiness (periodic fbm, 3-8 m)
//   A: streaks — warped ridged noise stretched ~5x along u (sample with u along the flow)
// The tile spans FOAM_TILE metres.
import * as THREE from 'three';
import { mulberry32 } from '../core/rng.js';

export const FOAM_TILE = 24;

function worleyGrid(n, rand) {
  const pts = new Float32Array(n * n * 2);
  for (let i = 0; i < n * n; i++) { pts[i * 2] = rand(); pts[i * 2 + 1] = rand(); }
  return pts;
}

function worley(u, v, n, pts) {
  // u,v in [0,1) tile space; returns [F1, F2] in cell units
  const x = u * n, y = v * n;
  const xi = Math.floor(x), yi = Math.floor(y);
  let f1 = 9, f2 = 9;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = xi + dx, cy = yi + dy;
      const wx = ((cx % n) + n) % n, wy = ((cy % n) + n) % n;
      const px = cx + pts[(wy * n + wx) * 2], py = cy + pts[(wy * n + wx) * 2 + 1];
      const d = Math.hypot(px - x, py - y);
      if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) f2 = d;
    }
  }
  return [f1, f2];
}

function periodicValueNoise(n, rand, ny = n) {
  const nx = n;
  const g = new Float32Array(nx * ny);
  for (let i = 0; i < nx * ny; i++) g[i] = rand();
  return (u, v) => {
    const x = u * nx, y = v * ny;
    const xi = Math.floor(x), yi = Math.floor(y);
    const fx = x - xi, fy = y - yi;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const i0 = ((xi % nx) + nx) % nx, i1 = (i0 + 1) % nx, j0 = ((yi % ny) + ny) % ny, j1 = (j0 + 1) % ny;
    const a = g[j0 * nx + i0], b = g[j0 * nx + i1], c = g[j1 * nx + i0], d = g[j1 * nx + i1];
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  };
}
const ridge = (n) => 1 - Math.abs(2 * n - 1);

export function createFoamTexture(size = 512) {
  const rand = mulberry32(0xf0a3);
  const nA = 12, nB = 34, nC = 110;
  const pA = worleyGrid(nA, rand), pB = worleyGrid(nB, rand), pC = worleyGrid(nC, rand);
  const vn = [4, 8, 16, 32].map((n) => periodicValueNoise(n, rand));
  const sn = [6, 24, 64].map((n) => periodicValueNoise(n, rand));
  // marbled lace: isotropic ridged octaves (8, 16 cells over the tile ~ 3 m, 1.5 m) with warp
  const rl = [8, 16, 32].map((n) => periodicValueNoise(n, rand));
  const wl = [4, 8].map((n) => periodicValueNoise(n, rand));
  // anisotropic streaks: few cells along u, many along v (stretched ~5x along u)
  const ra = [[3, 16], [6, 32], [12, 64]].map(([a, b]) => periodicValueNoise(a, rand, b));
  const wa = [[4, 8], [8, 16]].map(([a, b]) => periodicValueNoise(a, rand, b));
  const data = new Uint8Array(size * size * 4);
  const clamp01 = (x) => Math.max(0, Math.min(1, x));
  for (let j = 0; j < size; j++) {
    const v = (j + 0.5) / size;
    for (let i = 0; i < size; i++) {
      const u = (i + 0.5) / size;
      const [a1, a2] = worley(u, v, nA, pA);
      const [b1, b2] = worley(u, v, nB, pB);
      const [c1] = worley(u, v, nC, pC);
      const warp = vn[2](u, v);
      // filaments: small F2-F1 near cell borders
      const eA = 1 - clamp01((a2 - a1) / (0.55 + 0.3 * warp));
      const eB = 1 - clamp01((b2 - b1) / 0.6);
      const holes = clamp01(a1 * 1.1); // cell centres are open water
      let cell = 0.62 * Math.pow(eA, 1.6) + 0.38 * Math.pow(eB, 1.3);
      cell = cell * (0.55 + 0.45 * holes);
      // domain-warped ridged filaments (periodic warp keeps it tileable)
      const wu = u + 0.07 * (wl[0](u, v) - 0.5) + 0.035 * (wl[1](u, v) - 0.5);
      const wv = v + 0.07 * (wl[0](u + 0.5, v + 0.5) - 0.5) + 0.035 * (wl[1](u + 0.5, v) - 0.5);
      const rid = 0.55 * Math.pow(ridge(rl[0](wu, wv)), 3) + 0.3 * Math.pow(ridge(rl[1](wu, wv)), 3) + 0.15 * Math.pow(ridge(rl[2](wu, wv)), 2);
      let lace = 0.3 * cell + 0.85 * rid + 0.12 * (vn[3](u, v) - 0.5);
      const au = u + 0.05 * (wa[0](u, v) - 0.5), av = v + 0.03 * (wa[0](u + 0.5, v) - 0.5) + 0.012 * (wa[1](u, v) - 0.5);
      const str = 0.55 * Math.pow(ridge(ra[0](au, av)), 2.5) + 0.3 * Math.pow(ridge(ra[1](au, av)), 2.5) + 0.15 * Math.pow(ridge(ra[2](au, av)), 2);
      const bub = clamp01(1 - c1 * 1.6) * (0.5 + 0.5 * vn[3](u * 1, v * 1));
      const patch = 0.5 * vn[0](u, v) + 0.3 * vn[1](u, v) + 0.2 * vn[2](u, v);
      const streak = 0.8 * str + 0.25 * (0.55 * sn[0](u, v) + 0.45 * sn[1](u, v)) - 0.05;
      const o = (j * size + i) * 4;
      data[o] = Math.round(clamp01(lace) * 255);
      data[o + 1] = Math.round(clamp01(bub) * 255);
      data[o + 2] = Math.round(clamp01(patch) * 255);
      data[o + 3] = Math.round(clamp01(streak) * 255);
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}
