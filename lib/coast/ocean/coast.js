// Coastal field bake: from layout.heightAt, at load time, three nested levels of
//   A = (dSurf, depth, dRock, gully)    dSurf : signed distance to the Main Beach waterline extended
//                                               straight north through the headland (+ sea); the surf
//                                               phase model uses it so crest lines stay straight
//                                       depth : -heightAt (m, + in the sea)
//                                       dRock : exact EDT distance to non-beach land (headland,
//                                               platform, rocks), negative inside
//                                       gully : aerated-water mask (enclosed water between rocks)
//   B = (grad dSurf.xz, dBeach, 0)      dBeach: true signed distance to the beach waterline (+ sea)
// Also the swell travel-time LUT tau(d) used by the surf model (shared with breakerEvents()).
import * as THREE from 'three';

const toHalf = THREE.DataUtils.toHalfFloat;

// 1D squared Euclidean distance transform (Felzenszwalb & Huttenlocher)
function edt1d(f, n, d, v, z) {
  let k = 0;
  v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
    k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
}

// Exact EDT of a binary mask (1 = feature). Returns distance (in texels) to the nearest feature.
function edt2d(mask, w, h) {
  const INF = 1e20;
  const out = new Float32Array(w * h);
  const n = Math.max(w, h);
  const f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  for (let i = 0; i < w * h; i++) out[i] = mask[i] ? 0 : INF;
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = out[y * w + x];
    edt1d(f, h, d, v, z);
    for (let y = 0; y < h; y++) out[y * w + x] = d[y];
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = out[y * w + x];
    edt1d(f, w, d, v, z);
    for (let x = 0; x < w; x++) out[y * w + x] = Math.sqrt(d[x]);
  }
  return out;
}

// Surf-phase shoreline: the beach waterline continued along its own direction past its northern
// end (slope dx/dz ~ -0.4), so points north of (96,-120) get a straight-line distance, not a radial one.
const SURF_EXT = [[-10, 150], [32, 40], [72, -60]];

export async function bakeLevel(layout, bounds, w, h, gullyFn, yieldFn) {
  const surfLine = [...SURF_EXT, ...layout.BEACH_WATERLINE];
  const { minX, maxX, minZ, maxZ } = bounds;
  const sx = (maxX - minX) / (w - 1), sz = (maxZ - minZ) / (h - 1);
  const hgt = new Float32Array(w * h);
  const beach = new Float32Array(w * h);
  const surfD = new Float32Array(w * h);
  const rockMask = new Uint8Array(w * h);
  const seaMask = new Uint8Array(w * h);
  for (let j = 0; j < h; j++) {
    const z = minZ + j * sz;
    for (let i = 0; i < w; i++) {
      const x = minX + i * sx;
      const k = j * w + i;
      const c = layout.componentsAt(x, z);
      const hh = c.h;
      const b = -layout.beachSigned(x, z);
      hgt[k] = hh;
      beach[k] = b;
      surfD[k] = -layout.polylineSigned(x, z, surfLine);
      const land = hh > 0.0;
      // rock = land made by the headland / platform / knoll / surf rocks (not the beach berm)
      rockMask[k] = land && Math.max(c.head, c.plat, c.rock, c.knoll) >= c.main - 0.05 ? 1 : 0;
      seaMask[k] = land ? 0 : 1;
    }
    if (yieldFn && (j & 15) === 15) await yieldFn(j / h);
  }
  const dOut = edt2d(rockMask, w, h); // sea: distance to rock
  const dIn = edt2d(Uint8Array.from(rockMask, (m) => 1 - m), w, h); // rock: distance to non-rock
  const texel = Math.sqrt(sx * sz);
  const A = new Uint16Array(w * h * 4);
  const B = new Uint16Array(w * h * 4);
  const dRock = new Float32Array(w * h);
  for (let k = 0; k < w * h; k++) {
    dRock[k] = rockMask[k] ? -(dIn[k] - 0.5) * texel : (dOut[k] - 0.5) * texel;
  }
  for (let j = 0; j < h; j++) {
    const z = minZ + j * sz;
    for (let i = 0; i < w; i++) {
      const x = minX + i * sx;
      const k = j * w + i;
      const g = gullyFn ? gullyFn(x, z, hgt[k], dRock[k]) : 0;
      A[k * 4] = toHalf(Math.max(-2000, Math.min(60000, surfD[k])));
      A[k * 4 + 1] = toHalf(-hgt[k]);
      A[k * 4 + 2] = toHalf(Math.min(60000, dRock[k]));
      A[k * 4 + 3] = toHalf(g);
      const i0 = Math.max(0, i - 1), i1 = Math.min(w - 1, i + 1);
      const j0 = Math.max(0, j - 1), j1 = Math.min(h - 1, j + 1);
      const bx = (surfD[j * w + i1] - surfD[j * w + i0]) / ((i1 - i0) * sx);
      const bz = (surfD[j1 * w + i] - surfD[j0 * w + i]) / ((j1 - j0) * sz);
      const bl = Math.hypot(bx, bz) || 1;
      B[k * 4] = toHalf(bx / bl);
      B[k * 4 + 1] = toHalf(bz / bl);
      B[k * 4 + 2] = toHalf(Math.max(-2000, Math.min(60000, beach[k])));
      B[k * 4 + 3] = 0;
    }
  }
  const mkTex = (arr) => {
    const t = new THREE.DataTexture(arr, w, h, THREE.RGBAFormat, THREE.HalfFloatType);
    t.minFilter = THREE.LinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.generateMipmaps = false;
    t.needsUpdate = true;
    return t;
  };
  return {
    texA: mkTex(A), texB: mkTex(B),
    // uv = (x - minX) * scale.x, (z - minZ) * scale.y ; half-texel inset handled in shader
    rect: new THREE.Vector4(minX, minZ, 1 / (maxX - minX), 1 / (maxZ - minZ)),
    texel: new THREE.Vector2(1 / w, 1 / h),
  };
}

// --- surf travel-time LUT -------------------------------------------------------------------
// Phase speed of the 10 s swell as a function of distance from the beach waterline.
export const SURF_LINE = SURF_EXT;
export const SURF = {
  T: 10.0, // swell / breaker period (s)
  p: Math.sin(20 * Math.PI / 180) / 8.5, // alongshore slowness (Snell invariant), s/m
  dMax: 1200,
  lutSize: 1024,
};

export function surfSpeed(d) {
  // depth profile of the Main Beach sea floor (see layout.mainland), bars smoothed
  const dd = Math.max(d, 0);
  let depth = 0.028 * dd + 0.00002 * dd * dd - 0.6 * Math.exp(-(((dd - 75) / 26) ** 2)) - 0.5 * Math.exp(-(((dd - 175) / 34) ** 2));
  depth = Math.max(depth, 0.25);
  const c = Math.sqrt(9.81 * depth);
  return Math.min(c, 10.5);
}

export function buildTauLUT() {
  const n = SURF.lutSize;
  const tau = new Float32Array(n);
  const data = new Uint16Array(n * 4);
  let acc = 0;
  const step = SURF.dMax / (n - 1);
  for (let i = 0; i < n; i++) {
    const d = i * step;
    if (i > 0) {
      const dm = d - step * 0.5;
      const c = surfSpeed(dm);
      acc += Math.sqrt(Math.max(1 / (c * c) - SURF.p * SURF.p, 1e-6)) * step;
    }
    tau[i] = acc;
    const c = surfSpeed(d);
    data[i * 4] = toHalf(acc);
    data[i * 4 + 1] = toHalf(Math.sqrt(Math.max(1 / (c * c) - SURF.p * SURF.p, 1e-6)));
    data[i * 4 + 2] = toHalf(c);
    data[i * 4 + 3] = toHalf(0);
  }
  const tex = new THREE.DataTexture(data, n, 1, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  const tauAt = (d) => {
    const x = Math.max(0, d) / step;
    if (x >= n - 1) {
      const c = surfSpeed(SURF.dMax);
      return tau[n - 1] + (x - (n - 1)) * step * Math.sqrt(1 / (c * c) - SURF.p * SURF.p);
    }
    const i = Math.floor(x), f = x - i;
    return tau[i] * (1 - f) + tau[i + 1] * f;
  };
  return { tex, tau, tauAt };
}
