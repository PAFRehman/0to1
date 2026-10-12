// Shrubs: dead twiggy shrubs on the left cliff brow, a low twiggy scrub mound near the trees,
// and the dark-green dome bushes at the right frame edge (far end of the headland).
//
// Twigs: procedurally grown branch networks (seeded RNG, gnarled kinks, knobbly radius swelling
// along the path length, forks, long upright whips at the limb ends and a clutter of fine wiry
// side twigs) meshed as 3-sided tubes. The vertex shader keeps every twig at least ~0.8 px wide
// (so fine twigs stay visible and anti-aliased under MSAA instead of vanishing) and bends
// branches with the shared wind (weight grows along each branch). Weathered silver-grey wood with
// a soft sky sheen, lichen blotches and dark cracks (faded out on sub-pixel twigs). Dome bushes:
// noise-displaced spheres with a leafy procedural shading. All lighting through a patched
// MeshStandardMaterial (shadow map, hemisphere + sun) with aerial perspective.
import * as THREE from 'three';
import { mulberry32, fbm2 } from '../core/rng.js';
import { WIND_UNIFORMS_GLSL, WIND_FIELD_GLSL } from '../core/wind.js';
import { patchMaterialAtmosphere } from '../core/atmosphere.js';
import { CONFIG } from '../config.js';
import { patchVegLighting, makeSunVis, sunMaskAt, deadShrubSpots, refCameraRay } from './grass.js';

// ---------------------------------------------------------------------------------------------
// Branch network growth. Returns a list of segments {a:[x,y,z], b:[x,y,z], ra, rb, wa, wb}.
function growShrub(rand, base, opts) {
  const segs = [];
  const { stems, height, spread, lean, r0, depthMax, segLen, forkBias = 0.5, elev = [0.35, 0.95], rise = 0.06, sideUp = 0.0, taper = 1.7, forkSpread = 1.3, rMin = 0.0025, kink = 0.7,
    prostrateEvery = 0, elevP = [0.05, 0.25], broom = 0, broomLen = 0.12, clutter = 0, clutterLen = 0.18 } = opts;
  // a broom of fine twigs fanning upward from a limb end
  function addBroom(p, d, w, pl) {
    const nb = broom + Math.floor(rand() * 2);
    for (let b = 0; b < nb; b++) {
      let bd = [d[0] * 0.4 + (rand() - 0.5) * 1.2, 0.8 + rand() * 0.6, d[2] * 0.4 + (rand() - 0.5) * 1.2];
      let q = p.slice(), ww = w, pp = pl;
      const L = broomLen * (0.5 + rand());
      for (let k = 0; k < 2; k++) {
        bd = [bd[0] + (rand() - 0.5) * 0.5, bd[1], bd[2] + (rand() - 0.5) * 0.5];
        const l = Math.hypot(bd[0], bd[1], bd[2]);
        const q2 = [q[0] + bd[0] / l * L / 2, q[1] + bd[1] / l * L / 2, q[2] + bd[2] / l * L / 2];
        segs.push({ a: q, b: q2, ra: rMin * 1.2, rb: rMin, wa: ww, wb: ww + L * 0.3, pla: pp, plb: pp + L / 2, broom: true });
        q = q2; ww += L * 0.3; pp += L / 2;
      }
    }
  }
  function grow(p, dir, r, depth, w, len, pl = 0) {
    let pos = p.slice();
    let d = dir.slice();
    const n = Math.max(2, Math.round(len / segLen));
    for (let i = 0; i < n; i++) {
      // gnarled: random kink every segment, slight gravity/phototropism
      d[0] += (rand() - 0.5) * kink; d[1] += (rand() - 0.5) * kink * 0.7 + rise; d[2] += (rand() - 0.5) * kink;
      const l = Math.hypot(d[0], d[1], d[2]); d = [d[0] / l, d[1] / l, d[2] / l];
      const sl = len / n;
      const q = [pos[0] + d[0] * sl, pos[1] + d[1] * sl, pos[2] + d[2] * sl];
      const rb = r * (1 - 0.35 * (i + 1) / n);
      const wb = w + sl * 0.6;
      segs.push({ a: pos, b: q, ra: r * (1 - 0.35 * i / n), rb, wa: w, wb, pla: pl, plb: pl + sl });
      pos = q; w = wb; pl += sl;
      // side branches
      if (depth < depthMax - (broom ? 1 : 0) && rand() < forkBias && i < n - 1) {
        const nd = [d[0] + (rand() - 0.5) * 1.6, d[1] + (rand() - 0.2) * 0.9 + sideUp, d[2] + (rand() - 0.5) * 1.6];
        grow(pos, nd, rb * 0.62, depth + 1, w, len * (0.45 + rand() * 0.3), pl);
      }
    }
    if (depth >= depthMax && broom) addBroom(pos, d, w, pl);
    if (depth < depthMax) {
      const k = 2 + (rand() < 0.4 ? 1 : 0);
      for (let j = 0; j < k; j++) {
        const nd = [d[0] + (rand() - 0.5) * forkSpread, d[1] + (rand() - 0.3) * forkSpread * 0.7 + sideUp * 0.7, d[2] + (rand() - 0.5) * forkSpread];
        grow(pos, nd, r * 0.55, depth + 1, w, len * (0.5 + rand() * 0.25), pl);
      }
    }
  }
  for (let s = 0; s < stems; s++) {
    const az = lean + (rand() - 0.5) * spread;
    const pr = prostrateEvery && s % prostrateEvery === prostrateEvery - 1;
    const el = pr ? elevP[0] + rand() * (elevP[1] - elevP[0]) : elev[0] + rand() * (elev[1] - elev[0]); // radians above horizontal
    const dir = [Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)];
    const off = [base[0] + (rand() - 0.5) * 0.3, base[1], base[2] + (rand() - 0.5) * 0.3];
    grow(off, dir, r0 * (0.7 + rand() * 0.5), 0, 0, height * (0.55 + rand() * 0.4));
  }
  // pipe-model-ish taper: radius falls with path length so tips end in 2-6 mm twigs
  let maxPl = 0;
  for (const s of segs) maxPl = Math.max(maxPl, s.plb);
  const L = maxPl * 1.02;
  // knobbly, gnarled wood: a smooth random swelling along the path length (continuous across
  // segments, so no steps), strongest on the old limbs
  const kph = [rand() * 6.28, rand() * 6.28, rand() * 6.28];
  const knob = (pl) => 1 + 0.22 * Math.sin(pl * 21 + kph[0]) * Math.sin(pl * 7.3 + kph[1]) + 0.12 * Math.sin(pl * 43 + kph[2]);
  for (const s of segs) {
    if (s.broom) continue;
    s.ra = Math.max(rMin, Math.min(s.ra, r0 * Math.pow(1 - s.pla / L, taper)) * knob(s.pla));
    s.rb = Math.max(rMin, Math.min(s.rb, r0 * Math.pow(1 - s.plb / L, taper)) * knob(s.plb));
  }
  // clutter: short, fine, dead side twigs sprouting at random along the limbs (the tangled grey
  // twig haze of a dead shrub), wiry: 2-3 kinked segments, up-biased
  const nOld = segs.length;
  for (let c = 0; c < clutter; c++) {
    const host = segs[Math.floor(rand() * nOld)];
    if (host.broom || host.rb > r0 * 0.5) continue;
    let q = host.b.slice(), w = host.wb, pl = host.plb;
    let d = [(rand() - 0.5) * 2, 0.3 + rand() * 1.0, (rand() - 0.5) * 2];
    const len = clutterLen * (0.4 + rand());
    const n = 2 + (rand() < 0.5 ? 1 : 0);
    for (let k = 0; k < n; k++) {
      d = [d[0] + (rand() - 0.5) * 0.9, d[1] + (rand() - 0.5) * 0.5, d[2] + (rand() - 0.5) * 0.9];
      const l = Math.hypot(d[0], d[1], d[2]);
      const q2 = [q[0] + d[0] / l * len / n, q[1] + d[1] / l * len / n, q[2] + d[2] / l * len / n];
      segs.push({ a: q, b: q2, ra: rMin * (k ? 1.0 : 1.3), rb: rMin, wa: w, wb: w + len / n * 0.4, pla: pl, plb: pl + len / n, broom: true });
      q = q2; w += len / n * 0.4; pl += len / n;
    }
  }
  return segs;
}

// Dead coastal shrub (the silvered, wind-killed Acacia / Banksia skeletons on the lip): 2-3 thick,
// sinuous limbs sprawling up-left toward the sea (smooth S-arcs from a slowly drifting curvature,
// not per-segment kinks), sparse secondary and tertiary branches, and on about half of the branch
// ends 1-2 long, gently curving spider twigs with log-normal lengths; a prostrate limb every third
// stem sinks into the herbs. Segments carry a baked cavity term (dark near the ground and at forks).
function growDeadShrub(rand, base, o) {
  const segs = [];
  const gy = base[1];
  const lnLen = () => Math.min(0.7, Math.max(0.15, Math.exp(Math.log(0.3) + 0.5 * gauss())));
  function gauss() { return (rand() + rand() + rand() + rand() - 2) * 1.2247; }
  const cav = (p, fork) => {
    const hA = Math.min(1, Math.max(0, (p[1] - gy) / 0.15));
    return (0.25 + 0.75 * hA * hA * (3 - 2 * hA)) * (fork ? 0.6 : 1);
  };
  // smooth path: direction d drifts with a slowly random-walking curvature
  function limb(p0, d0, len, r0, r1, depth, pl0, sink = 0) {
    let pos = p0.slice(), d = d0.slice(), curl = [0, 0, 0];
    const n = Math.max(3, Math.round(len / o.segLen));
    const sl = len / n;
    let pl = pl0;
    const ends = [];
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < 3; k++) curl[k] = curl[k] * 0.82 + (rand() - 0.5) * o.curl * (k === 1 ? 0.6 : 1);
      d = [d[0] + curl[0], d[1] + curl[1] - o.droop * (i / n) * (depth === 0 ? 1 : 0.5), d[2] + curl[2]];
      if (sink) d[1] = Math.min(d[1], 0.12); // prostrate limbs stay low
      const l = Math.hypot(d[0], d[1], d[2]); d = [d[0] / l, d[1] / l, d[2] / l];
      const q = [pos[0] + d[0] * sl, pos[1] + d[1] * sl, pos[2] + d[2] * sl];
      if (q[1] < gy - 0.1) q[1] = gy - 0.1 + 0.02 * rand();
      const ta = i / n, tb = (i + 1) / n;
      const ra = r0 + (r1 - r0) * Math.pow(ta, 0.8), rb = r0 + (r1 - r0) * Math.pow(tb, 0.8);
      segs.push({ a: pos, b: q, ra, rb, pla: pl, plb: pl + sl, ca: cav(pos, i === 0 && depth > 0), cb: cav(q, false), depth });
      pos = q; pl += sl;
      // side branches off the main limbs (sparse)
      if (depth < 2 && i > 1 && i < n - 1 && rand() < (depth === 0 ? o.branch : o.branch * 0.7)) {
        const side = rand() < 0.5 ? -1 : 1;
        const ang = side * (0.5 + rand() * 0.7);
        const ca = Math.cos(ang), sa = Math.sin(ang);
        const nd = [d[0] * ca - d[2] * sa, d[1] + 0.25 + rand() * 0.5, d[0] * sa + d[2] * ca];
        const rr = rb * (0.5 + rand() * 0.15);
        limb(q, nd, len * (1 - tb) * (0.5 + rand() * 0.5) + 0.12, rr, Math.max(0.006, rr * 0.3), depth + 1, pl);
      }
    }
    ends.push([pos, d, pl]);
    // spider twigs on about half of the ends: 1-2 long, thin, gently curving
    for (const [p, dd, pp] of ends) {
      if (rand() > o.twigP) continue;
      const nt = 1 + (rand() < 0.5 ? 1 : 0) + (rand() < 0.25 ? 1 : 0);
      for (let t = 0; t < nt; t++) {
        let td = [dd[0] + (rand() - 0.5) * 0.8, dd[1] + 0.3 + rand() * 0.5, dd[2] + (rand() - 0.5) * 0.8];
        let q = p.slice(), tpl = pp, c2 = [0, 0, 0];
        const L = lnLen() * o.twigLen;
        const m = 4;
        for (let k = 0; k < m; k++) {
          for (let j = 0; j < 3; j++) c2[j] = c2[j] * 0.7 + (rand() - 0.5) * 0.4;
          td = [td[0] + c2[0], td[1] + c2[1], td[2] + c2[2]];
          const l = Math.hypot(td[0], td[1], td[2]);
          const q2 = [q[0] + td[0] / l * L / m, q[1] + td[1] / l * L / m, q[2] + td[2] / l * L / m];
          segs.push({ a: q, b: q2, ra: 0.006 - 0.003 * k / m, rb: 0.006 - 0.003 * (k + 1) / m, pla: tpl, plb: tpl + L / m, ca: 1, cb: 1, depth: 3 });
          q = q2; tpl += L / m;
        }
      }
    }
  }
  for (let s = 0; s < o.stems; s++) {
    const pr = s % 3 === 2;
    const az = o.lean + (rand() - 0.5) * o.spread;
    const el = pr ? 0.04 + rand() * 0.1 : 0.35 + rand() * 0.4;
    const dir = [Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)];
    const off = [base[0] + (rand() - 0.5) * 0.25, gy - (pr ? 0.05 + rand() * 0.05 : 0.02), base[2] + (rand() - 0.5) * 0.25];
    const r0 = o.r0 * (0.8 + rand() * 0.3) * (pr ? 0.8 : 1);
    limb(off, dir, o.height * (pr ? 1.1 + rand() * 0.5 : 0.9 + rand() * 0.6), r0, Math.max(0.008, r0 * 0.25), 0, 0, pr ? 1 : 0);
  }
  // knobbly swelling along the path (continuous: a function of path length), old wood only
  const kph = [rand() * 6.28, rand() * 6.28, rand() * 6.28];
  const knob = (pl) => 1 + 0.1 * Math.sin(pl * 9 + kph[0]) * Math.sin(pl * 3.1 + kph[1]) + 0.04 * Math.sin(pl * 23 + kph[2]);
  for (const g of segs) if (g.depth < 3) { g.ra *= knob(g.pla); g.rb *= knob(g.plb); }
  // a dense, dark nest of short dead twigs around the base (the near-black core of the shrub)
  for (let c = 0; c < (o.nest || 0); c++) {
    const a = rand() * 6.283, rr = 0.38 * Math.sqrt(rand());
    let q = [base[0] + Math.cos(a) * rr, gy + rand() * 0.22, base[2] + Math.sin(a) * rr];
    let d = [Math.cos(a) * 0.6 + (rand() - 0.5), 0.3 + rand() * 0.8, Math.sin(a) * 0.6 + (rand() - 0.5)];
    const len = 0.08 + rand() * 0.18;
    for (let k = 0; k < 2; k++) {
      d = [d[0] + (rand() - 0.5) * 0.6, d[1] + (rand() - 0.5) * 0.4, d[2] + (rand() - 0.5) * 0.6];
      const l = Math.hypot(d[0], d[1], d[2]);
      const q2 = [q[0] + d[0] / l * len / 2, q[1] + d[1] / l * len / 2, q[2] + d[2] / l * len / 2];
      segs.push({ a: q, b: q2, ra: 0.0045, rb: 0.003, pla: 0, plb: 0.05, ca: cav(q, true) * 0.6, cb: cav(q2, false) * 0.7, depth: 3 });
      q = q2;
    }
  }
  // clutter: a few fine dead side twigs with random lengths
  const nOld = segs.length;
  for (let c = 0; c < o.clutter; c++) {
    const host = segs[Math.floor(rand() * nOld)];
    if (host.depth === 0 && host.rb > 0.03) continue;
    let q = host.b.slice(), pl = host.plb;
    let d = [(rand() - 0.5) * 2, 0.2 + rand() * 0.9, (rand() - 0.5) * 2];
    const len = 0.08 + rand() * 0.32;
    for (let k = 0; k < 3; k++) {
      d = [d[0] + (rand() - 0.5) * 0.5, d[1] + (rand() - 0.5) * 0.3, d[2] + (rand() - 0.5) * 0.5];
      const l = Math.hypot(d[0], d[1], d[2]);
      const q2 = [q[0] + d[0] / l * len / 3, q[1] + d[1] / l * len / 3, q[2] + d[2] / l * len / 3];
      segs.push({ a: q, b: q2, ra: 0.0035, rb: 0.0025, pla: pl, plb: pl + len / 3, ca: 0.85, cb: 1, depth: 3 });
      q = q2; pl += len / 3;
    }
  }
  return segs;
}

// Mesh segments as tubes (5 sides for limbs thicker than ~2.5 cm, else 3); attributes: position
// (centre), normal (radial dir), aTwig = (radius, windWeight, phase, shade), aSun, aCav (baked cavity).
function tubeGeometry(allSegs) {
  let nv = 0, ni = 0;
  const sides = allSegs.map((g) => (Math.max(g.ra, g.rb) > 0.025 ? 5 : 3));
  for (const k of sides) { nv += 2 * k; ni += 6 * k; }
  const pos = new Float32Array(nv * 3);
  const nrm = new Float32Array(nv * 3);
  const twig = new Float32Array(nv * 4);
  const sunA = new Float32Array(nv);
  const cavA = new Float32Array(nv);
  const idx = new Uint32Array(ni);
  const t = new THREE.Vector3(), u = new THREE.Vector3(), v = new THREE.Vector3(), up = new THREE.Vector3();
  let vo = 0, io = 0;
  for (let s = 0; s < allSegs.length; s++) {
    const g = allSegs[s], K = sides[s];
    t.set(g.b[0] - g.a[0], g.b[1] - g.a[1], g.b[2] - g.a[2]).normalize();
    up.set(0, 1, 0); if (Math.abs(t.y) > 0.9) up.set(1, 0, 0);
    u.crossVectors(t, up).normalize(); v.crossVectors(t, u).normalize();
    const base = vo;
    for (let e = 0; e < 2; e++) {
      const p = e ? g.b : g.a, r = e ? g.rb : g.ra, w = e ? g.wb : g.wa;
      for (let k = 0; k < K; k++) {
        const a = k * 6.2831853 / K + 0.5;
        const nx = u.x * Math.cos(a) + v.x * Math.sin(a), ny = u.y * Math.cos(a) + v.y * Math.sin(a), nz = u.z * Math.cos(a) + v.z * Math.sin(a);
        pos.set(p, vo * 3);
        nrm.set([nx, ny, nz], vo * 3);
        twig.set([r, w, g.phase, g.shade], vo * 4);
        sunA[vo] = e ? g.sb : g.sa;
        cavA[vo] = (e ? g.cb : g.ca) ?? 1;
        vo++;
      }
    }
    for (let k = 0; k < K; k++) {
      const k1 = (k + 1) % K;
      const a0 = base + k, a1 = base + k1, b0 = base + K + k, b1 = base + K + k1;
      idx.set([a0, a1, b1, a0, b1, b0], io); io += 6;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  geo.setAttribute('aTwig', new THREE.BufferAttribute(twig, 4));
  geo.setAttribute('aSun', new THREE.BufferAttribute(sunA, 1));
  geo.setAttribute('aCav', new THREE.BufferAttribute(cavA, 1));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeBoundingSphere();
  return geo;
}

export default async function create(ctx) {
  const { scene, layout, uniforms, quality } = ctx;
  const rand = mulberry32(4471);
  const lowQ = quality.tier === 'low';

  // ---- dead grey shrubs along the left cliff lip (image x 250..540, rows 560..675) --------------
  // 5 separate gnarled shrubs whose bases are raycast from the reference frame (see grass.js
  // DEAD_SHRUB_PX): contorted limbs leaning up-left toward the sea (2 of 3 stems rising, 1 lying
  // low along the lip), each limb ending in a broom of fine twig tips fanning upward; 0.75-1.25 m.
  const allSegs = [];
  const deadSpots = deadShrubSpots(layout);
  const LEAN = Math.atan2(-0.8, -0.65); // toward -X (the sea) and away from the camera: up-left in the image
  for (let si = 0; si < deadSpots.length; si++) {
    const { x, y: gy, z, h, stems } = deadSpots[si];
    const hh = h * (0.75 + 0.5 * rand()); // +-25 % around the measured height
    const segs = growDeadShrub(rand, [x, gy, z], {
      stems: lowQ ? 2 : Math.min(3, stems - (rand() < 0.5 ? 1 : 0)), height: hh * 1.05, lean: LEAN + (rand() - 0.5) * 0.5, spread: 1.4,
      r0: 0.045 + 0.015 * rand() * Math.min(1, h / 0.6), segLen: 0.05, curl: 0.34, droop: 0.3, branch: lowQ ? 0.3 : 0.5,
      twigP: lowQ ? 0.6 : 0.95, twigLen: 0.5, clutter: lowQ ? 8 : 20, nest: lowQ ? 14 : quality.tier === 'high' ? 60 : 32,
    });
    // scale heights about the ground so the twig tips reach the (varied) measured height
    let top = 0;
    for (const sg of segs) top = Math.max(top, sg.a[1] - gy, sg.b[1] - gy);
    const k = Math.min(1.5, Math.max(0.5, hh / Math.max(0.05, top)));
    const pts = new Set();
    for (const sg of segs) { pts.add(sg.a); pts.add(sg.b); } // (consecutive segments share points)
    for (const pt of pts) if (pt[1] > gy) pt[1] = gy + (pt[1] - gy) * k;
    const phase = rand() * 6.28;
    for (const sg of segs) { sg.phase = phase; sg.shade = 0.0; sg.wa = sg.pla * 0.6; sg.wb = sg.plb * 0.6; }
    allSegs.push(...segs);
  }
  // ---- low twiggy scrub mound near the trees (image x 1060..1160, rows 552..600, ~15 m) --------
  // domed, airy, grey-violet twig mass embedded in the dead-grass tussocks; bases raycast from the
  // reference frame: [px, py, height (m), width]
  const scrubPx = [[1066, 599, 0.45, 0.9], [1092, 602, 0.54, 1.1], [1118, 600, 0.52, 1.0], [1144, 597, 0.42, 0.8], [1082, 592, 0.38, 0.7], [1108, 592, 0.42, 0.8]];
  for (const [px, py, h, wdt] of scrubPx) {
    const p = refCameraRay(layout, px, py);
    if (!p) continue;
    const y = layout.heightAt(p.x, p.z) - 0.03;
    const segs = growShrub(rand, [p.x, y, p.z], {
      stems: lowQ ? 3 : Math.round(10 * wdt), height: h * 0.5, spread: 6.28, lean: 0, r0: 0.012,
      depthMax: lowQ ? 2 : 3, segLen: 0.06, forkBias: 0.55, elev: [0.25, 1.0], rise: 0.0, rMin: 0.002, clutter: lowQ ? 10 : 45, clutterLen: 0.12,
    });
    let top = 0;
    for (const sg of segs) top = Math.max(top, sg.a[1] - y, sg.b[1] - y);
    const k = Math.min(1.6, Math.max(0.5, h / Math.max(0.05, top)));
    const pts = new Set();
    for (const sg of segs) { pts.add(sg.a); pts.add(sg.b); }
    for (const pt of pts) pt[1] = y + (pt[1] - y) * k;
    const phase = rand() * 6.28;
    for (const sg of segs) { sg.phase = phase; sg.shade = 1.0; }
    allSegs.push(...segs);
  }
  ctx.progress(0.5, 'Scrub');

  const sunVis = makeSunVis(layout, uniforms.uSunDir.value);
  for (const g of allSegs) { g.sa = sunVis(g.a[0], g.a[2], g.a[1]) * sunMaskAt(g.a[0], g.a[2]); g.sb = sunVis(g.b[0], g.b[2], g.b[1]) * sunMaskAt(g.b[0], g.b[2]); }
  const twigGeo = tubeGeometry(allSegs);
  // weathered, silvered wood has a soft sheen: the upper sides pick up the grey-blue sky
  const twigMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6, metalness: 0, alphaToCoverage: true });
  const uPx = { value: 0.001 };
  twigMat.onBeforeCompile = (sh) => {
    for (const k of ['uTime', 'uWindDir', 'uGust', 'uWindSpeed', 'uWindAdv']) sh.uniforms[k] = uniforms[k];
    sh.uniforms.uPx = uPx;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        ${WIND_UNIFORMS_GLSL}
        uniform float uTime;
        ${WIND_FIELD_GLSL}
        attribute vec4 aTwig;
        attribute float aSun;
        attribute float aCav;
        uniform float uPx;
        varying float vCav;
        varying float vTwA;
        varying float vSunV;
        varying float vShade;
        varying float vTip;
        varying vec3 vTwWP;
        varying float vTwR;`)
      .replace('#include <begin_vertex>', `
        vec3 cen = position;
        float wgt = aTwig.y;
        float wf = windField(cen.xz);
        // rates are whole multiples of 1/60 Hz (21/60 and 35/60 Hz), so time wraps seamlessly at 60 s
        float sT = mod(uTime, 60.0);
        float sw = sin(sT * 2.1991149 + aTwig.z + cen.x * 0.7) * 0.6 + sin(sT * 3.6651914 + aTwig.z * 1.7) * 0.4;
        vec3 wdir = vec3(uWindDir.x, 0.0, uWindDir.y);
        cen += (wdir * (0.5 + 0.5 * sw) + vec3(0.0, 0.3 * sw, 0.0)) * wgt * wgt * 0.018 * wf;
        float dcam = length(cen - cameraPosition);
        // >= 0.6 px radius (1.2 px wide) at the actual scene-target resolution; the widened part is
        // carried by alpha-to-coverage so a thin twig keeps its true optical weight
        float rr = max(aTwig.x, 0.6 * dcam * uPx);
        vec3 transformed = cen + objectNormal * rr;
        vTwA = clamp(aTwig.x / rr, 0.35, 1.0); vCav = aCav;
        vShade = aTwig.w; vSunV = aSun; vTwWP = cen; vTwR = rr / max(aTwig.x, 1e-4);
        vTip = clamp(1.0 - aTwig.x / 0.02, 0.0, 1.0);`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying float vShade; varying float vTip; varying float vSunV; varying vec3 vTwWP; varying float vTwR; varying float vCav; varying float vTwA;
        float twH(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
        float twN(vec3 x){ vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(mix(twH(i), twH(i + vec3(1,0,0)), f.x), mix(twH(i + vec3(0,1,0)), twH(i + vec3(1,1,0)), f.x), f.y),
                     mix(mix(twH(i + vec3(0,0,1)), twH(i + vec3(1,0,1)), f.x), mix(twH(i + vec3(0,1,1)), twH(i + vec3(1,1,1)), f.x), f.y), f.z); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        // weathered, silvered dead wood: pale blue-lilac grey on the sky-facing tops, near-black in the
        // cavities (baked: near the ground and at forks); bark texture: grey-green lichen blotches
        // (4-8 cm) and dark weathering cracks, faded out as the twig gets thinner than a pixel
        vec3 twWN = normalize(inverseTransformDirection(vNormal, viewMatrix));
        vec3 deadWood = mix(0.085, 0.12, vTip) * vec3(0.95, 0.93, 1.06) * (0.55 + 1.1 * max(twWN.y, 0.0));
        vec3 scrubWood = mix(vec3(0.04), vec3(0.12), vTip) * vec3(0.95, 0.97, 1.05);
        vec3 wc = mix(deadWood, scrubWood, vShade);
        float barkF = 1.0 - smoothstep(1.2, 2.5, vTwR);
        float lich = smoothstep(0.58, 0.78, twN(vTwWP * 16.0) * 0.7 + twN(vTwWP * 41.0) * 0.3);
        float crack = smoothstep(0.6, 0.8, twN(vTwWP * vec3(70.0, 18.0, 70.0)));
        wc = mix(wc, wc * vec3(0.78, 0.86, 0.72), lich * 0.6 * barkF);
        wc *= 1.0 - 0.6 * crack * barkF;
        wc *= 0.8 + 0.4 * twN(vTwWP * 5.0);
        wc *= mix(vCav, 1.0, vShade);
        diffuseColor.rgb = wc;
        diffuseColor.a = vTwA;`)
      ;
    patchVegLighting(sh, uniforms, { sun: 'vSunV', occ: 'mix(vCav, 1.0, 0.3)', trans: '0.0' });
  };
  twigMat.customProgramCacheKey = () => 'shrub-twig4';
  patchMaterialAtmosphere(twigMat, uniforms);
  const twigs = new THREE.Mesh(twigGeo, twigMat);
  // no shadow casting: the tubes are expanded in the colour pass only (a depth pass would draw
  // zero-area triangles), and the reference foreground is in shade anyway
  twigs.castShadow = false;
  twigs.receiveShadow = true;
  twigs.renderOrder = -1; // occluders first: the terrain / grass behind them is not shaded twice
  scene.add(twigs);

  // ---- the grey-green windswept bush at the right frame edge (image x 1153-1276, rows 246-300 at
  // t=0.5, ~220 m away on the knoll): overlapping noise-displaced lobes whose ground points and
  // silhouette tops are raycast from the reference frame (they follow the knoll / camera).
  const domeGeo = new THREE.SphereGeometry(1, lowQ ? 20 : 28, lowQ ? 12 : 16);
  const dpos = domeGeo.attributes.position;
  const merged = [];
  const domes = [];
  {
    // lobes along the bush's ground line (reference row ~298, x 1160..1290), raycast onto the
    // knoll; each lobe's top reaches the measured silhouette row (left dome ~262, right mass ~248)
    const lobePx = [[1166, 300, 278], [1182, 299, 265], [1199, 298, 261], [1216, 297, 264], [1234, 297, 256], [1252, 296, 250], [1270, 296, 247], [1290, 296, 246]];
    const drand = mulberry32(777);
    const c = CONFIG.camera;
    const eye = new THREE.Vector3().fromArray(c.position);
    for (let i = 0; i < (lowQ ? lobePx.length - 2 : lobePx.length); i++) {
      const [px, py, pyTop] = lobePx[lowQ ? i + 1 : i];
      const g = refCameraRay(layout, px, py);
      if (!g) continue;
      const dh = Math.hypot(g.x - eye.x, g.z - eye.z);
      // the silhouette-top pixel's ray at the same horizontal distance
      const t = refCameraRay(layout, px, pyTop, 1276, 718, dh);
      const dep = (drand() - 0.3) * 3.0; // push some lobes a little further back
      const k = (dh + dep) / dh;
      const x = eye.x + (g.x - eye.x) * k, z = eye.z + (g.z - eye.z) * k;
      const r = 2.4 + drand() * 1.0;
      const top = Math.max(2.5, t.y - layout.heightAt(x, z) + 0.8);
      domes.push([x, z, r, top]);
    }
  }
  for (const [x, z, r, top] of domes) {
    const g = domeGeo.clone();
    const p = g.attributes.position;
    const gy = layout.heightAt(x, z) - 0.8;
    for (let i = 0; i < p.count; i++) {
      const vx = dpos.getX(i), vy = dpos.getY(i), vz = dpos.getZ(i);
      const n = fbm2(vx * 2.2 + x, vz * 2.2 + vy * 1.8 + z, 4) * 0.7 + fbm2(vx * 6.0 - z, vz * 6.0 + vy * 5.0 + x, 2) * 0.3;
      const k = r * (0.62 + 0.76 * n);
      // rounded dome up to the lobe's top height (ragged, leafy silhouette)
      const yy = vy > 0 ? Math.pow(vy, 0.8) * top : vy * 0.8;
      p.setXYZ(i, x + vx * k * 1.25, gy + yy * (0.78 + 0.4 * n), z + vz * k);
    }
    g.computeVertexNormals();
    merged.push(g);
  }
  const domeAll = mergeGeos(merged);
  const domeMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0 });
  domeMat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vDomeWP;\nvarying vec3 vDomeN;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvDomeWP = (modelMatrix * vec4(position, 1.0)).xyz; vDomeN = normal;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vDomeWP; varying vec3 vDomeN;
        float dHash(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
        float dNoise(vec3 x){ vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(mix(dHash(i), dHash(i + vec3(1,0,0)), f.x), mix(dHash(i + vec3(0,1,0)), dHash(i + vec3(1,1,0)), f.x), f.y),
                     mix(mix(dHash(i + vec3(0,0,1)), dHash(i + vec3(1,0,1)), f.x), mix(dHash(i + vec3(0,1,1)), dHash(i + vec3(1,1,1)), f.x), f.y), f.z); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        float leaf = dNoise(vDomeWP * 1.6) * 0.6 + dNoise(vDomeWP * 4.1) * 0.4;
        float clump = dNoise(vDomeWP * 0.45);
        // sage-grey foliage, sunlit rim slightly yellow-green; holes with grey branches low down
        vec3 dark = vec3(0.17, 0.21, 0.165), lit = vec3(0.29, 0.34, 0.27);
        diffuseColor.rgb = mix(dark, lit, smoothstep(0.25, 0.8, leaf * 0.7 + clump * 0.3));
        float hgtN = clamp((vDomeWP.y - 7.0) / 7.0, 0.0, 1.0);
        float hole = smoothstep(0.62, 0.72, dNoise(vDomeWP * vec3(0.9, 1.6, 0.9) + 3.0)) * smoothstep(0.45, 0.1, hgtN);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.04, 0.045, 0.043), hole * 0.5);
        float twig = smoothstep(0.08, 0.0, abs(dNoise(vDomeWP * vec3(2.5, 0.8, 2.5)) - 0.5)) * hole;
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.16, 0.16, 0.155), twig * 0.7);
        diffuseColor.rgb *= mix(0.6, 1.0, smoothstep(-0.2, 0.6, vDomeN.y));`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          vec3 q = vDomeWP * 2.3;
          vec3 bump = vec3(dNoise(q) - 0.5, dNoise(q + 7.3) - 0.5, dNoise(q + 13.1) - 0.5);
          normal = normalize(normal + (viewMatrix * vec4(bump, 0.0)).xyz * 0.7);
        }`)
      ;
    patchVegLighting(sh, uniforms, { sun: '1.0', occ: '1.0', trans: '0.3', specOcc: '0.3', reuseShadow: false });
  };
  domeMat.customProgramCacheKey = () => 'shrub-dome';
  patchMaterialAtmosphere(domeMat, uniforms);
  const domeMesh = new THREE.Mesh(domeAll, domeMat);
  domeMesh.receiveShadow = true;
  domeMesh.renderOrder = -1;
  scene.add(domeMesh);

  ctx.progress(1, 'Scrub');
  if (ctx.params.get('debug') === 'grass') console.warn('[shrubs] twig segments', allSegs.length, 'domes', domes.length);
  const _v2 = new THREE.Vector2();
  return {
    update() {
      // metres per pixel at 1 m on the scene target (drawing buffer x dynamic-resolution scale)
      ctx.renderer.getDrawingBufferSize(_v2);
      uPx.value = 2 * Math.tan(THREE.MathUtils.degToRad(ctx.camera.fov) / 2) / Math.max(1, _v2.y * (quality.scale || 1));
    },
  };
}

function mergeGeos(list) {
  let nv = 0, ni = 0;
  for (const g of list) { nv += g.attributes.position.count; ni += g.index ? g.index.count : g.attributes.position.count; }
  const pos = new Float32Array(nv * 3), nrm = new Float32Array(nv * 3), idx = new Uint32Array(ni);
  let vo = 0, io = 0;
  for (const g of list) {
    pos.set(g.attributes.position.array, vo * 3);
    nrm.set(g.attributes.normal.array, vo * 3);
    if (g.index) { for (let i = 0; i < g.index.count; i++) idx[io + i] = g.index.array[i] + vo; io += g.index.count; }
    else { for (let i = 0; i < g.attributes.position.count; i++) idx[io + i] = vo + i; io += g.attributes.position.count; }
    vo += g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeBoundingSphere();
  return out;
}
