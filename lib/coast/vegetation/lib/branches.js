// Procedural branch skeletons + tube meshing for the casuarinas.
// A branch is a polyline with per-point radius and hierarchical wind weights:
//   w[i] = [w0, w1, w2] (limb / branch / twig), ph = [ph0, ph1, ph2], flex.
// Children inherit the parent's weights at the attachment point so wind displacement stays continuous.

export class Branch {
  constructor(pts, rad, level, opts = {}) {
    this.pts = pts; // THREE.Vector3[]
    this.rad = rad; // number[]
    this.level = level; // 0 trunk (stiff), 1 limb, 2 branch, 3+ twig
    this.dead = !!opts.dead;
    this.flex = opts.flex ?? 1;
    this.radial = opts.radial ?? 5;
    this.color = opts.color || null; // [r,g,b] linear
    this.tree = opts.tree ?? 0;
    this.w = [];
    this.ph = [0, 0, 0];
    this.len = 0;
    this.s = [];
  }
}

const slotOf = (level) => Math.min(Math.max(level - 1, -1), 2);

// Compute arc length + wind weights. parent/attachIdx optional.
export function finalizeBranch(b, parent, attachIdx, rng) {
  const n = b.pts.length;
  const acc = [0];
  for (let i = 1; i < n; i++) acc.push(acc[i - 1] + b.pts[i].distanceTo(b.pts[i - 1]));
  b.len = acc[n - 1] || 1e-3;
  b.s = acc.map((a) => a / b.len);
  const base = parent ? parent.w[attachIdx].slice() : [0, 0, 0];
  b.ph = parent ? parent.ph.slice() : [rng() * 6.283, rng() * 6.283, rng() * 6.283];
  const slot = slotOf(b.level);
  if (slot >= 0) {
    const pslot = parent ? slotOf(parent.level) : -1;
    if (pslot < slot) b.ph[slot] = rng() * 6.283;
    for (let k = slot + 1; k < 3; k++) b.ph[k] = rng() * 6.283;
  }
  b.w = b.s.map((s) => {
    const w = base.slice();
    if (slot >= 0) {
      const start = parent && slotOf(parent.level) === slot ? base[slot] : 0;
      w[slot] = start + (1 - start) * s;
    }
    return w;
  });
  if (parent) b.flex = parent.flex;
  return b;
}

// Kinked polyline through world waypoints (casuarina limbs are angular: 10-25 deg kinks every 0.5-1 m).
export function kinkedPath(THREE, waypoints, seg, kinkDeg, rng) {
  const curve = new THREE.CatmullRomCurve3(waypoints, false, 'centripetal');
  const L = curve.getLength();
  const n = Math.max(2, Math.ceil(L / seg));
  const pts = curve.getSpacedPoints(n);
  const amp = seg * Math.tan(kinkDeg * Math.PI / 180) * 0.6;
  const off = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  for (let i = 1; i < pts.length - 1; i++) {
    const t = tmp.subVectors(pts[i + 1], pts[i - 1]).normalize();
    const r = new THREE.Vector3(rng() - 0.5, rng() - 0.5, rng() - 0.5);
    r.addScaledVector(t, -r.dot(t)).multiplyScalar(2 * amp);
    off.multiplyScalar(0.45).add(r);
    const fade = Math.min(1, i / 2, (pts.length - 1 - i) / 1.5);
    pts[i].addScaledVector(off, fade);
  }
  return pts;
}

export function taper(n, r0, r1, pow = 1) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(r0 + (r1 - r0) * Math.pow(i / Math.max(1, n - 1), pow));
  return out;
}

function randomPerp(THREE, t, rng) {
  const a = Math.abs(t.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const u = new THREE.Vector3().crossVectors(t, a).normalize();
  const v = new THREE.Vector3().crossVectors(t, u).normalize();
  const th = rng() * Math.PI * 2;
  return u.multiplyScalar(Math.cos(th)).addScaledVector(v, Math.sin(th));
}

// Grow a free twig from a start point along dir (random walk with wind lean and gravity).
export function growTwig(THREE, start, dir, len, seg, rng, opts = {}) {
  const pts = [start.clone()];
  const d = dir.clone().normalize();
  const lean = opts.lean || new THREE.Vector3(1, 0, 0);
  const steps = Math.max(2, Math.round(len / seg));
  const p = start.clone();
  for (let k = 0; k < steps; k++) {
    const j = randomPerp(THREE, d, rng).multiplyScalar(Math.tan((opts.wobbleDeg ?? 18) * Math.PI / 180) * rng());
    d.add(j).addScaledVector(lean, opts.leanK ?? 0.08).add(new THREE.Vector3(0, opts.gravity ?? -0.04, 0)).normalize();
    p.addScaledVector(d, len / steps);
    pts.push(p.clone());
  }
  return pts;
}

// Recursive side shoots along a branch. Returns new branches (already finalized).
export function sprout(THREE, parent, rng, cfg, out, depth = 0) {
  const n = parent.pts.length;
  const T = new THREE.Vector3();
  const lean = cfg.lean;
  for (let i = 1; i < n - 1; i++) {
    const s = parent.s[i];
    if (s < cfg.minS[depth]) continue;
    if (rng() > cfg.prob[depth]) continue;
    T.subVectors(parent.pts[i + 1], parent.pts[i - 1]).normalize();
    const side = randomPerp(THREE, T, rng);
    const ang = (30 + 40 * rng()) * Math.PI / 180;
    const dir = T.clone().multiplyScalar(Math.cos(ang)).addScaledVector(side, Math.sin(ang));
    dir.addScaledVector(lean, 0.3);
    dir.y += cfg.rise ?? 0.15;
    const dead = parent.dead || rng() < cfg.deadProb;
    if (dead) dir.y -= 0.15;
    // never grow into the ground: shoots of limbs lying low are re-aimed upward
    const gy = cfg.ground ? cfg.ground(parent.pts[i].x, parent.pts[i].z) : -Infinity;
    if (parent.pts[i].y - gy < 0.8) dir.y = Math.max(dir.y, 0.25 + 0.3 * rng());
    const len = Math.min((cfg.maxLen || [2.2, 1.2, 0.6])[depth], Math.max(0.18, parent.len * (0.22 + 0.33 * rng()) * (1.15 - s * 0.6) * (cfg.lenK ?? 1)));
    const pts = growTwig(THREE, parent.pts[i], dir, len, Math.min(0.35, len / 3), rng, {
      lean, leanK: 0.05, gravity: dead ? -0.02 : -0.05, wobbleDeg: 22,
    });
    if (cfg.ground) {
      let under = false;
      for (let k = 1; k < pts.length; k++) if (pts[k].y < cfg.ground(pts[k].x, pts[k].z) + 0.05) under = true;
      if (under) continue; // reject shoots that would poke through the terrain
    }
    const r0 = Math.min(parent.rad[i] * 0.6, cfg.maxR ?? 0.05);
    const child = new Branch(pts, taper(pts.length, r0, Math.max(0.004, r0 * 0.25)), parent.level + 1, {
      dead, radial: r0 > 0.03 ? 5 : r0 > 0.012 ? 4 : 3, tree: parent.tree,
    });
    finalizeBranch(child, parent, i, rng);
    out.push(child);
    if (depth + 1 < cfg.prob.length) sprout(THREE, child, rng, cfg, out, depth + 1);
  }
}

// Mesh all branches into one BufferGeometry (world space) with wind attributes and vertex colours.
// veilOf(b, i) (optional): 0..1 per skeleton point - how deep the point sits inside the foliage (aVeil).
export function buildTubes(THREE, branches, colorOf, veilOf) {
  let nv = 0, ni = 0;
  for (const b of branches) { nv += b.pts.length * b.radial; ni += (b.pts.length - 1) * b.radial * 6; }
  const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), col = new Float32Array(nv * 3);
  const uv = new Float32Array(nv * 2);
  const w0 = new Float32Array(nv * 4), w1 = new Float32Array(nv * 4), rad = new Float32Array(nv);
  const tan = new Float32Array(nv * 3), veil = new Float32Array(nv);
  const idx = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni);
  let v = 0, k = 0;
  const T = new THREE.Vector3(), N = new THREE.Vector3(), B = new THREE.Vector3(), tmp = new THREE.Vector3();
  for (const b of branches) {
    const n = b.pts.length, R = b.radial;
    const base = v;
    const c = colorOf(b);
    const seed = (b.ph[0] * 13.7 + b.ph[2] * 3.1) % 1;
    for (let i = 0; i < n; i++) {
      if (i === 0) T.subVectors(b.pts[1], b.pts[0]);
      else if (i === n - 1) T.subVectors(b.pts[n - 1], b.pts[n - 2]);
      else T.subVectors(b.pts[i + 1], b.pts[i - 1]);
      T.normalize();
      if (b.faceCam) {
        // flat camera-facing ribbon (radial = 2): N spans the ribbon's width, across the view direction
        tmp.subVectors(b.faceCam, b.pts[i]);
        N.crossVectors(T, tmp).normalize();
      } else if (i === 0) {
        tmp.set(0, 1, 0);
        if (Math.abs(T.dot(tmp)) > 0.9) tmp.set(1, 0, 0);
        N.crossVectors(T, tmp).normalize();
      } else {
        N.addScaledVector(T, -N.dot(T)).normalize();
      }
      B.crossVectors(T, N).normalize();
      const r = b.rad[i];
      // lighten the bark slightly toward the thin ends and add per-ring variation
      const vl = veilOf ? veilOf(b, i) : 0;
      const shade = b.faceCam ? (b.shade ? b.shade[i] : 1) : 0.9 + 0.18 * Math.sin(b.s[i] * b.len * 1.3 + seed * 20) * Math.sin(b.s[i] * b.len * 0.57 + seed * 7);
      for (let j = 0; j < R; j++) {
        const a = (j / R) * Math.PI * 2;
        const cx = Math.cos(a), sx = Math.sin(a);
        const nx = N.x * cx + B.x * sx, ny = N.y * cx + B.y * sx, nz = N.z * cx + B.z * sx;
        pos[v * 3] = b.pts[i].x + nx * r; pos[v * 3 + 1] = b.pts[i].y + ny * r; pos[v * 3 + 2] = b.pts[i].z + nz * r;
        nor[v * 3] = nx; nor[v * 3 + 1] = ny; nor[v * 3 + 2] = nz;
        col[v * 3] = c[0] * shade; col[v * 3 + 1] = c[1] * shade; col[v * 3 + 2] = c[2] * shade;
        uv[v * 2] = b.faceCam ? 7.5 : j / R; uv[v * 2 + 1] = b.faceCam ? 0.0 : b.s[i] * b.len; // ribbons: flat bark term
        rad[v] = r; veil[v] = vl;
        tan[v * 3] = T.x; tan[v * 3 + 1] = T.y; tan[v * 3 + 2] = T.z;
        const w = b.w[i];
        w0[v * 4] = w[0]; w0[v * 4 + 1] = w[1]; w0[v * 4 + 2] = w[2]; w0[v * 4 + 3] = b.flex;
        w1[v * 4] = b.ph[0]; w1[v * 4 + 1] = b.ph[1]; w1[v * 4 + 2] = b.ph[2]; w1[v * 4 + 3] = seed;
        v++;
      }
    }
    for (let i = 0; i < n - 1; i++) {
      for (let j = 0; j < R; j++) {
        const a = base + i * R + j, b2 = base + i * R + ((j + 1) % R);
        const c2 = a + R, d = b2 + R;
        idx[k++] = a; idx[k++] = b2; idx[k++] = c2;
        idx[k++] = b2; idx[k++] = d; idx[k++] = c2;
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('aWind0', new THREE.BufferAttribute(w0, 4));
  g.setAttribute('aWind1', new THREE.BufferAttribute(w1, 4));
  g.setAttribute('aRad', new THREE.BufferAttribute(rad, 1)); // tube radius (sub-pixel twig widening)
  g.setAttribute('aTan', new THREE.BufferAttribute(tan, 3)); // tube axis (thin-twig shading normal)
  if (veilOf) g.setAttribute('aVeil', new THREE.BufferAttribute(veil, 1)); // needle veil over wood inside the crowns
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeBoundingSphere();
  return g;
}
