// Rock-surge emitters and the sun-visibility / ground-height field for the spray (load-time bakes).
//
// Rock surges mirror the ocean shader's foam surge (ocean.js):
//   psi = (t + tau(dSurf) - p z) / T, tau reduced by 0.0022 * max(0, 45 - dRock)^2 near rocks,
//   ageR = mod(psi_frac * T + offR, T), offR = 4 * macroNoise(xz / 22 + 3),
//   surge = exp(-ageR / 2.2) * (0.35 + 0.8 * A0) + 0.35 * exp(-mod(ageR + 5, T) / 1.6)
// so the main surge of crest k peaks at t_k = t0 + k T with t0 = T - offR - tau + p z and strength
// crestStrength(k, s), s = z + 0.35 dSurf; a weaker second surge follows 5 s later.

const fract = (x) => x - Math.floor(x);
// JS mirror of ocean.js hash11 / macroNoise (float32 vs double differs by ~1e-4: irrelevant here)
function hash11(p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
function macroNoise(px, pz) {
  const ix = Math.floor(px), iz = Math.floor(pz);
  const fx = px - ix, fz = pz - iz;
  const ux = fx * fx * (3 - 2 * fx), uz = fz * fz * (3 - 2 * fz);
  const m = (v) => ((v % 256) + 256) % 256;
  const x0 = m(ix), x1 = m(ix + 1), z0 = m(iz), z1 = m(iz + 1);
  const a = hash11(x0 + z0 * 57), b = hash11(x1 + z0 * 57), c = hash11(x0 + z1 * 57), d = hash11(x1 + z1 * 57);
  return (a + (b - a) * ux) * (1 - uz) + (c + (d - c) * ux) * uz;
}

// Walk outward from a rock outline sample until open water; returns the emitter or null.
function toWater(layout, x, z, nx, nz, maxS) {
  for (let s = 0.5; s <= maxS; s += 0.5) {
    const qx = x + nx * s, qz = z + nz * s;
    if (layout.heightAt(qx, qz) < -0.35) return { x: qx, z: qz, s };
  }
  return null;
}

const LAG = 0.8;
export function buildRockEmitters(layout, surf, tauAt, swellDir) {
  const out = [];
  const SL = [...surf.line, ...layout.BEACH_WATERLINE];
  const sdf = (x, z, poly) => layout.polygonSDF(x, z, poly);
  const add = (x, z, nx, nz, weight, spacing, maxS, tag, cls = 0) => {
    const w = toWater(layout, x, z, nx, nz, maxS);
    if (!w) return;
    // exposure: faces turned toward the arriving swell take the hits; sheltered faces still get wash
    const face = -(nx * swellDir[0] + nz * swellDir[1]);
    let expo = Math.min(1.15, Math.max(0.12, 0.28 + 0.95 * face)) * weight;
    // (x, z) in water, (nx, nz) outward normal
    const dS = Math.max(0, -layout.polylineSigned(w.x, w.z, SL));
    const rl = Math.max(0, 45 - w.s);
    const k = Math.min(1, Math.max(0, (dS - 20) / 50));
    const tau = tauAt(dS) - 0.0022 * rl * rl * k * k * (3 - 2 * k);
    // crest k reaches the emitter (psi = k) at t = k T - tau + p z. (The ocean's rock-foam surge leads
    // that by offR = 4 macroNoise(xz / 22 + 3) s; the splash itself follows the crest: the water
    // climbs the face and the plume peaks ~1 s after the crest arrives, as in the reference, where
    // the crest reaches the dark rock at ~3.6 s and the plume tops out at ~5 s.)
    const offR = 4 * macroNoise(w.x / 22 + 3, w.z / 22 + 3);
    const tRaw = -tau + surf.p * w.z;
    const m = Math.floor(tRaw / surf.T);
    // + LAG: the white water starts to climb the face ~1 s after the phase line passes (measured
    // against the reference: phase line at the dark rock ~2.4 s, plume 3.6-5.6 s)
    const t0 = tRaw - m * surf.T + LAG; // splash of crest (c + kOff) starts at t0 + c T
    out.push({ x: w.x, z: w.z, nx, nz, expo, spacing, t0, kOff: m, offR, s: w.z + 0.35 * dS, tag, cls });
  };
  // polygon outline: samples every `spacing` m, outward normal from the SDF gradient
  const outline = (poly, spacing, weight, maxS, filter, tag) => {
    for (let i = 0; i < poly.length; i++) {
      const [ax, az] = poly[i], [bx, bz] = poly[(i + 1) % poly.length];
      const L = Math.hypot(bx - ax, bz - az);
      const n = Math.max(1, Math.round(L / spacing));
      for (let k = 0; k < n; k++) {
        const f = (k + 0.5) / n;
        const x = ax + (bx - ax) * f, z = az + (bz - az) * f;
        if (filter && !filter(x, z)) continue;
        const e = 0.5;
        let gx = sdf(x + e, z, poly) - sdf(x - e, z, poly), gz = sdf(x, z + e, poly) - sdf(x, z - e, poly);
        const gl = Math.hypot(gx, gz) || 1;
        add(x, z, gx / gl, gz / gl, weight, spacing, maxS, tag);
      }
    }
  };
  // (0.65: the dark rock and the awash ledge seaward of it take the brunt; in the reference the
  // platform end shows white water at its foot, not tall plumes)
  outline(layout.PLATFORM_OUTLINE, 3.2, 0.65, 12, null, 'platform');
  // foreground headland foot (lower-left) and the headland side of the gully
  outline(layout.HEADLAND_OUTLINE, 4.0, 0.8, 30, (x, z) => x < 60 && z < -28 && z > -40, 'headland');
  // headland side of the gully: sheltered by the platform, the surges there are weaker
  outline(layout.HEADLAND_OUTLINE, 4.0, 0.5, 30, (x, z) => x < 60 && z <= -40 && z > -80, 'gully');
  layout.ROCKS.forEach(([rx, rz, r, rh], i) => {
    // deeply submerged rocks (the wash rock off the foreground cliff): the ocean's own white water
    // is all there is; airborne or boiling spray over plain water read as floating cotton balls
    if (rh < -1.0) return;
    const n = Math.max(6, Math.round((2 * Math.PI * r) / 2.6));
    for (let k = 0; k < n; k++) {
      const a = ((k + 0.5) / n) * Math.PI * 2;
      const nx = Math.cos(a), nz = Math.sin(a);
      // awash / submerged rocks: the surge boils over them (weaker, lower)
      // (the two small rocks ~220 m out get lower surges: at that range a few tall clumps read as blobs)
      // class: 1 submerged / awash (flat boil only), 2 far (low rim), 3 small exposed rock (the
      // surge runs over it as a dome)
      const cls = rh < 0 ? 1 : rz < -200 ? 2 : 3;
      const wgt = rh < 0 ? 0.55 : rz < -200 ? 0.7 : 1.1;
      const w = toWater(layout, rx + nx * r * 0.6, rz + nz * r * 0.6, nx, nz, r + 6);
      if (w) add(rx + nx * r * 0.6, rz + nz * r * 0.6, nx, nz, wgt, 2.6, r + 6, 'rock' + i, cls);
    }
  });
  // de-duplicate (overlapping outlines)
  const keep = [];
  for (const e of out) if (!keep.some((k) => Math.hypot(k.x - e.x, k.z - e.z) < 1.8)) keep.push(e);
  return keep;
}

// Ground height (m, >= -1) and sun shadow height (the height above which a point sees the sun) on a
// grid around the headland / platform / surf zone. Sun direction (x, y, z) normalised.
export async function bakeSunField(layout, sunDir, bounds, cell, yieldFn) {
  const { minX, maxX, minZ, maxZ } = bounds;
  const w = Math.round((maxX - minX) / cell) + 1, h = Math.round((maxZ - minZ) / cell) + 1;
  const H = new Float32Array(w * h);
  for (let j = 0; j < h; j++) {
    const z = minZ + j * cell;
    for (let i = 0; i < w; i++) H[j * w + i] = layout.heightAt(minX + i * cell, z);
    if (yieldFn && (j & 31) === 31) await yieldFn(0.6 * j / h);
  }
  // shadow casters: the platform stands as a full-height block (its seaward end is a vertical cliff
  // in the reference and shades the dark rock and the gully mouth west of it)
  const C = new Float32Array(w * h);
  for (let j = 0; j < h; j++) {
    const z = minZ + j * cell;
    for (let i = 0; i < w; i++) {
      const k = j * w + i, x = minX + i * cell;
      let v = H[k];
      if (x > -10 && x < 130 && z < -125 && z > -175) {
        const d = layout.polygonSDF(x, z, layout.PLATFORM_OUTLINE);
        // (+ ~9 m skirt: in the reference the gully mouth and the dark rock west of the platform lie
        // in its shade: blue-white foam and splashes there, cream-lit crests further out)
        const f = Math.min(1, Math.max(0, (9.0 - d) / 5.0));
        v = Math.max(v, (layout.PLATFORM_HEIGHT - 1) * f);
      }
      C[k] = v;
    }
  }
  const hl = Math.hypot(sunDir[0], sunDir[2]);
  const sx = sunDir[0] / hl, sz = sunDir[2] / hl, tanEl = sunDir[1] / hl;
  let maxH = 0;
  for (let k = 0; k < H.length; k++) maxH = Math.max(maxH, H[k]);
  const maxS = maxH / Math.max(tanEl, 1e-3) + cell;
  const at = (x, z) => {
    const fi = (x - minX) / cell, fj = (z - minZ) / cell;
    if (fi < 0 || fj < 0 || fi >= w - 1 || fj >= h - 1) return 0;
    const i = Math.floor(fi), j = Math.floor(fj), u = fi - i, v = fj - j, k = j * w + i;
    return (C[k] * (1 - u) + C[k + 1] * u) * (1 - v) + (C[k + w] * (1 - u) + C[k + w + 1] * u) * v;
  };
  const S = new Float32Array(w * h);
  for (let j = 0; j < h; j++) {
    const z = minZ + j * cell;
    for (let i = 0; i < w; i++) {
      const x = minX + i * cell;
      let m = -5;
      for (let s = cell * 0.75; s < maxS; s += cell * 0.75) {
        const v = at(x + sx * s, z + sz * s) - s * tanEl;
        if (v > m) m = v;
      }
      S[j * w + i] = m;
    }
    if (yieldFn && (j & 31) === 31) await yieldFn(0.6 + 0.4 * j / h);
  }
  return { w, h, H, S, rect: [minX, minZ, 1 / (maxX - minX), 1 / (maxZ - minZ)] };
}
