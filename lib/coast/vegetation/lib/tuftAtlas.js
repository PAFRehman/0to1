// Procedural casuarina foliage atlas: separate drooping tassels of fine branchlet threads.
//
// A she-oak spray is hundreds of 1-2 mm thick, 10-30 cm long jointed branchlets hanging off a thin
// twig. Seen at 20-25 m in the wind they read as soft streaks: bundles (tassels) of threads streaming
// downwind at 10-40 deg or hanging steeply (55-80 deg), with transparent gaps between them. Every cell
// is built from such tassels (4-11 threads each, 1-2 px thick at S = 512; ~1 px x 5-15 px on screen at
// the crowns' 6x minification). Tassel tones are drawn dark olive -> mid -> golden (interior first,
// lit sprays over them) with flat per-tassel light: nothing is top-lit (the crown light field is
// applied per card in trees.js).
//
// Layout (atlas = 4S x 4S, S = 512 on 'high', 256 / 128 on lower tiers):
//   rows 0-3: 16 wide 2:1 cells (S x S/2)
//     0..9   'spray'    : an irregular lump of 46-66 tassels around 2-4 sub-centres (crowns, tree A, E)
//     10..13 'streamer' : 5-7 long hanging tassels (ragged crown bottoms, E)
//     14..15 'wisp'     : 12-17 sparse drooping tassels lit at the downwind tips (tree A)
//   rows 4-5: 8 square cells (S x S)
//     16..19 'tassel'   : steeply hanging thread fans (legacy)
//     20..23 'puff'     : a dense square tassel lump (crown interiors)
// The atlas gets a light horizontal smear (the video's motion blur), is premultiplied so no dark halos
// appear, windowed so nothing touches a cell border (mips never bleed between cells), and its
// alpha-weighted mean colour is normalised to the calibrated value the crown palettes were tuned for.
import { mulberry32 } from '../../core/rng.js';

export const ATLAS_COLS = 4;
export const ATLAS_VARIANTS = 24;
export const VARIANT_SETS = {
  spray: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  streamer: [10, 11, 12, 13],
  wisp: [14, 15],
  tassel: [16, 17, 18, 19],
  puff: [20, 21, 22, 23],
};
// width / height of a variant's cell
export function variantAspect(v) { return v < 16 ? 2 : 1; }
// attachment point of the carrying twig in cell-local uv (v measured from the top of the cell)
export function variantAttach(v) { return v < 16 ? [0.08, 0.36] : [0.22, 0.4]; }
// legacy (square variants)
export const ATTACH = [0.22, 0.4];

// alpha-weighted mean linear colour the crown palettes (trees.js PAL) were calibrated against
const TARGET_MEAN = [0.68 * 0.6, 0.619 * 0.6, 0.40 * 0.6];
// gain the foliage vertex colours apply so crowns keep their calibrated mean (the atlas itself is darker
// than before: it now carries the tufts' baked self-shadow, and its lit threads need headroom)
export const ATLAS_GAIN = 1 / 0.6;

function cellRect(v, S) {
  if (v < 16) return { x: (v % 4) * S, y: Math.floor(v / 4) * S / 2, w: S, h: S / 2 };
  const k = v - 16;
  return { x: (k % 4) * S, y: 2 * S + Math.floor(k / 4) * S, w: S, h: S };
}

// thread colour: lit = warm golden, shaded = greener grey-olive (hue follows the light, ref)
function threadCol(lit, lum, a) {
  const l = Math.max(0, Math.min(1, lit));
  const r = (0.56 + 0.44 * l) * lum, g = (0.56 + 0.38 * l) * lum, b = (0.47 + 0.19 * l) * lum;
  const c = (x) => Math.max(0, Math.min(255, Math.round(255 * x)));
  return `rgba(${c(r)},${c(g)},${c(b)},${a.toFixed(3)})`;
}

// One domed tuft hanging off a twig node at (ox, oy): N threads, each a parabolic arc
//   P(u) = start + u * len * d0 + u^2 * len * (stream, droop)
// o: { R (px scale), n, th0/th1 (initial angle range, deg, + = down), droop, stream, lenK, alphaK,
//      lumK, back (fraction of dark interior threads), twigLen (fraction of R) }
function drawTuft(g, rng, S, ox, oy, o) {
  const R = o.R;
  const k = S / 512;
  const twigLen = R * (o.twigLen ?? 0.7);
  const twAng = (o.twigDeg ?? 8) * Math.PI / 180;
  const tx = Math.cos(twAng), ty = Math.sin(twAng);
  g.lineCap = 'round';
  // a handful of thin grey sub-twigs inside the tuft (visible between the threads up close)
  g.lineWidth = Math.max(0.8, 1.6 * k);
  g.strokeStyle = `rgba(84,78,64,${(0.55 + 0.2 * rng()).toFixed(3)})`;
  g.beginPath(); g.moveTo(ox, oy); g.lineTo(ox + tx * twigLen, oy + ty * twigLen); g.stroke();
  const nsub = 2 + Math.floor(rng() * 3);
  g.lineWidth = Math.max(0.6, 1.0 * k);
  for (let i = 0; i < nsub; i++) {
    const s = 0.2 + 0.7 * rng();
    const bx = ox + tx * twigLen * s, by = oy + ty * twigLen * s;
    const a = (15 + 45 * rng()) * Math.PI / 180, L = R * (0.25 + 0.3 * rng());
    g.strokeStyle = `rgba(80,74,62,${(0.35 + 0.25 * rng()).toFixed(3)})`;
    g.beginPath(); g.moveTo(bx, by); g.lineTo(bx + Math.cos(a) * L, by + Math.sin(a) * L); g.stroke();
  }
  const n = Math.round(o.n * (S >= 512 ? 1 : S >= 256 ? 0.75 : 0.5));
  const th0 = o.th0 * Math.PI / 180, th1 = o.th1 * Math.PI / 180;
  // back (interior, shaded) threads first, then the front shell over them
  const threads = [];
  for (let i = 0; i < n; i++) {
    const back = rng() < (o.back ?? 0.45);
    const s = Math.pow(rng(), 0.8);
    const sx = ox + tx * twigLen * s + (rng() - 0.5) * R * 0.12, sy = oy + ty * twigLen * s + (rng() - 0.5) * R * 0.1;
    // initial angle: upper threads arch over the dome, lower ones hang
    const f = rng();
    const th = th0 + (th1 - th0) * f;
    const len = R * (0.3 + 0.85 * Math.sqrt(rng())) * (o.lenK ?? 1) * (1 - 0.3 * s);
    const droop = (o.droop ?? 0.55) * (0.7 + 0.6 * rng()), stream = (o.stream ?? 0.25) * (0.6 + 0.8 * rng());
    // brightness from the thread's place in the dome: top (small f) lit, lower threads in the tuft's
    // own shadow; back threads darker still
    // flat, random per-thread brightness (no top-lit dome: the sun is 7 deg high and to the side)
    const lit = Math.min(1, Math.max(0, 0.5 + 0.6 * (rng() - 0.5))) * (back ? 0.75 : 1);
    const lum = (back ? 0.6 + 0.2 * rng() : 0.72 + 0.3 * rng()) * (o.lumK ?? 1);
    const a = (back ? 0.4 + 0.3 * rng() : 0.35 + 0.45 * rng()) * (o.alphaK ?? 1);
    const w = Math.max(0.7, (1.0 + 0.8 * rng()) * k * (o.widthK ?? 1));
    threads.push({ back, sx, sy, th, len, droop, stream, lit, lum, a, w });
  }
  threads.sort((p, q) => (p.back === q.back ? 0 : p.back ? -1 : 1));
  for (const t of threads) {
    const dx = Math.cos(t.th), dy = Math.sin(t.th);
    // quadratic Bezier of the parabola: C = P0 + len/2 d0, E = P0 + len (d0 + (stream, droop))
    const cx = t.sx + 0.5 * t.len * dx, cy = t.sy + 0.5 * t.len * dy;
    const ex = t.sx + t.len * (dx + t.stream), ey = t.sy + t.len * (dy + t.droop);
    g.lineWidth = t.w;
    // two halves: the hanging tip of a lower thread sinks further into shadow, an upper thread's tip
    // (the dome's outer rim) catches the most light
    const mx = 0.25 * t.sx + 0.5 * cx + 0.25 * ex, my = 0.25 * t.sy + 0.5 * cy + 0.25 * ey;
    const c1x = 0.5 * (t.sx + cx), c1y = 0.5 * (t.sy + cy), c2x = 0.5 * (cx + ex), c2y = 0.5 * (cy + ey);
    g.strokeStyle = threadCol(t.lit * 0.95, t.lum * 0.96, t.a);
    g.beginPath(); g.moveTo(t.sx, t.sy); g.quadraticCurveTo(c1x, c1y, mx, my); g.stroke();
    g.strokeStyle = threadCol(Math.min(1, t.lit * 1.05), t.lum * 1.04, t.a * 0.9);
    g.beginPath(); g.moveTo(mx, my); g.quadraticCurveTo(c2x, c2y, ex, ey); g.stroke();
  }
}

const DEGR = Math.PI / 180;
// (r5) crown sprays drawn as wind-combed tufts (drawCombSpray) instead of crossing tassel bundles
const COMBED = true;

// One tassel: a bundle of fine, drooping branchlets hanging off one twig node at (sx, sy), heading th
// (rad, 0 = downwind / screen right, + = down), length L, base spread wb (px), n threads. Its colour
// is flat with per-thread jitter (the crown light field is applied per card in trees.js; nothing here
// is top-lit), the free downwind tips a touch brighter than the bases.
function drawTassel(g, rng, k, t) {
  const dx = Math.cos(t.th), dy = Math.sin(t.th);
  const nx = -dy, ny = dx;
  g.lineCap = 'round';
  for (let i = 0; i < t.n; i++) {
    const o = (rng() - 0.5) * t.wb;
    const fan = (rng() - 0.5) * t.fan + (o / Math.max(1, t.L)) * 1.2; // outer threads fan out
    const len = t.L * (0.55 + 0.45 * rng());
    const droop = t.droop * (0.4 + 1.2 * rng());
    const x0 = t.sx + nx * o * 0.4 + dx * Math.abs(o) * 0.3, y0 = t.sy + ny * o * 0.4 + dy * Math.abs(o) * 0.3;
    const ddx = dx + nx * fan, ddy = dy + ny * fan;
    const ex = x0 + len * ddx, ey = y0 + len * (ddy + droop);
    const cx = x0 + 0.55 * len * ddx, cy = y0 + 0.55 * len * ddy;
    const tl = t.lum * (0.87 + 0.26 * rng()); // (r4: softer thread-to-thread jitter: ref 1-2 px contrast ~0.85x ours)
    g.lineWidth = Math.max(0.7, (0.8 + 1.0 * rng()) * k * (t.wK ?? 1));
    const mx = 0.25 * x0 + 0.5 * cx + 0.25 * ex, my = 0.25 * y0 + 0.5 * cy + 0.25 * ey;
    const a = t.a * (0.6 + 0.4 * rng());
    g.strokeStyle = threadCol(t.lit, tl * (t.baseK ?? 0.95), a);
    g.beginPath(); g.moveTo(x0, y0); g.quadraticCurveTo(0.5 * (x0 + cx), 0.5 * (y0 + cy), mx, my); g.stroke();
    g.strokeStyle = threadCol(Math.min(1, t.lit + (t.tipLit ?? 0.06)), tl * (t.tipK ?? 1.05), a * 0.9);
    g.beginPath(); g.moveTo(mx, my); g.quadraticCurveTo(0.5 * (cx + ex), 0.5 * (cy + ey), ex, ey); g.stroke();
  }
}

// tassel tone classes: dark olive interior sprays, mid, bright golden sunlit sprays (drawn in that order)
function tasselTone(rng, o) {
  const r = rng();
  if (r < (o.dark ?? 0.24)) return { lum: 0.7 + 0.12 * rng(), lit: 0.22 + 0.2 * rng(), order: 0 }; // (r4b: +9 %: ref crown darks ~(83,74,56))
  if (r > 1 - (o.bright ?? 0.26)) return { lum: 0.9 + 0.14 * rng(), lit: 0.75 + 0.2 * rng(), order: 2 };
  return { lum: 0.74 + 0.16 * rng(), lit: 0.42 + 0.3 * rng(), order: 1 };
}

// A spray lump seen from 20-25 m: tassels hang from nodes scattered (gaussian) around a few sub-centres,
// so a card is an irregular, see-through mass of separate streaks (1 px wide, 5-15 px long on screen):
// most stream downwind at 10-40 deg, some hang steeply (55-80 deg), with transparent gaps between them.
function drawTasselLump(g, rng, S, W, H, subs, o) {
  const k = S / 512;
  const m = 0.06 * Math.min(W, H) + 5 * k;
  const tierK = S >= 512 ? 1 : S >= 256 ? 0.8 : 0.6;
  const nT = Math.round(o.n * (S >= 512 ? 1 : S >= 256 ? 0.9 : 0.75));
  const list = [];
  const fl = o.flat || [10, 40], st = o.steepR || [55, 80];
  for (let i = 0; i < nT; i++) {
    const sb = subs[Math.floor(rng() * subs.length)];
    const gx = (rng() + rng() + rng() - 1.5) * 1.2, gy = (rng() + rng() + rng() - 1.5) * 1.2;
    let sx = sb.x + gx * sb.rx, sy = sb.y + gy * sb.ry;
    const steep = rng() < (o.steep ?? 0.3);
    const rise = !steep && o.rise && rng() < o.rise / (1 - (o.steep ?? 0.3));
    const th = (steep ? st[0] + (st[1] - st[0]) * rng() : rise ? o.riseR[0] + (o.riseR[1] - o.riseR[0]) * rng() : fl[0] + (fl[1] - fl[0]) * rng()) * DEGR;
    let L = (o.L0 + (o.L1 - o.L0) * rng()) * k * (steep ? 0.8 : 1);
    sx = Math.max(m, Math.min(W - m - 12 * k, sx)); sy = Math.max(m, Math.min(H - m - 8 * k, sy));
    const ex = L * (Math.cos(th) + 0.25) * 1.1, ey = L * (Math.sin(th) + 0.25 + (o.droop ?? 0.12)) * 1.1;
    const sc = Math.min(1, (W - m - sx) / Math.max(1, ex), (H - m - sy) / Math.max(1, ey), ey < 0 ? (sy - m) / Math.max(1, -ey) : 1);
    L *= Math.max(0.2, sc);
    const tone = tasselTone(rng, o);
    list.push({
      sx, sy, th, L, wb: (o.wb0 ?? 3) * k + (o.wb1 ?? 5) * k * rng(), fan: o.fan ?? 0.3, droop: o.droop ?? 0.12,
      n: Math.max(2, Math.round((o.t0 ?? 4) + ((o.t1 ?? 8) - (o.t0 ?? 4)) * rng() * tierK)),
      lum: tone.lum * (o.lumK ?? 1), lit: tone.lit, a: o.a0 + (o.a1 - o.a0) * rng(), order: tone.order + 0.9 * rng(),
      wK: o.wK, baseK: o.baseK, tipK: o.tipK, tipLit: o.tipLit,
    });
  }
  list.sort((p, q) => p.order - q.order);
  for (const t of list) drawTassel(g, rng, k, t);
}

// (r5) One wind-combed tuft: a fan of fine, long branchlet threads that all stream along one heading
// th (rad, 0 = downwind / screen right, + = down) from a base near (x, y), spreading a little with
// distance and drooping at the tips. Threads are drawn base -> mid -> tip with the alpha rising then
// fading out (translucent, feathered tuft ends), so after mip filtering a tuft reads as one soft,
// streaky brush stroke (ref: 25-55 px tufts of parallel streaks, the heading differs tuft to tuft),
// not as a blot of crossing sticks. A few wider, brighter strands give the sparse crisp highlight
// streaks of the video (its fine band is sparse / high-kurtosis over a smooth body).
function drawComb(g, rng, k, c) {
  const dx = Math.cos(c.th), dy = Math.sin(c.th), nx = -dy, ny = dx;
  g.lineCap = 'round';
  const seg = (x0, y0, x1, y1, x2, y2, col, w) => { g.strokeStyle = col; g.lineWidth = w; g.beginPath(); g.moveTo(x0, y0); g.quadraticCurveTo(x1, y1, x2, y2); g.stroke(); };
  const n = c.n + c.nHi;
  // threads run in parallel strand bundles (~1 px apart on screen) with gaps between them: after mip
  // filtering the tuft keeps a fine streak grain along its heading instead of blurring to a flat blot
  const nb = Math.max(3, Math.round(c.wb / (9 * k)));
  const bund = [];
  for (let j = 0; j < nb; j++) bund.push({ o: ((j + 0.5) / nb - 0.5) * c.wb + (rng() - 0.5) * 4 * k, da: (rng() - 0.5) * c.spread, lk: 0.88 + 0.24 * rng() });
  for (let i = 0; i < n; i++) {
    const hi = i >= c.n;
    const B = bund[Math.floor(rng() * nb)];
    const o = B.o + (rng() - 0.5) * 3.5 * k;
    const da = B.da + (rng() - 0.5) * 0.06 + (o / Math.max(1, c.L)) * 0.9; // bundles fan out
    const ca = Math.cos(da), sa = Math.sin(da);
    const tdx = dx * ca - dy * sa, tdy = dy * ca + dx * sa;
    const len = c.L * (hi ? 0.6 + 0.4 * rng() : 0.4 + 0.6 * Math.sqrt(rng()));
    const back = (rng() - 0.3) * 0.22 * c.L;
    const x0 = c.x + nx * o + dx * back, y0 = c.y + ny * o + dy * back;
    const droop = c.droop * (0.4 + 1.2 * rng()), curl = (rng() - 0.5) * 0.16;
    // P(u) = P0 + u len d + u^2 len (curl n + droop down)
    const P = (u) => [x0 + u * len * tdx + u * u * len * curl * nx, y0 + u * len * tdy + u * u * len * (curl * ny + droop)];
    const tl = c.lum * B.lk * (hi ? 1.1 + 0.1 * rng() : 0.94 + 0.12 * rng());
    const lit = Math.min(1, c.lit + (hi ? 0.2 : 0));
    const a = (hi ? c.aHi : c.a) * (0.65 + 0.35 * rng());
    const w = hi ? Math.max(0.9, (2.4 + 1.6 * rng()) * k) : Math.max(0.7, (0.9 + 1.0 * rng()) * k);
    const us = [0, 0.3, 0.68, 1];
    const aK = [0.6, 1.0, 0.45];
    for (let s = 0; s < 3; s++) {
      const p0 = P(us[s]), p2 = P(us[s + 1]), pm = P(0.5 * (us[s] + us[s + 1]));
      // control point of the quadratic through pm
      const cx = 2 * pm[0] - 0.5 * (p0[0] + p2[0]), cy = 2 * pm[1] - 0.5 * (p0[1] + p2[1]);
      seg(p0[0], p0[1], cx, cy, p2[0], p2[1], threadCol(Math.min(1, lit + (s === 2 ? c.tipLit : 0)), tl * (s === 0 ? 0.94 : s === 2 ? c.tipK : 1), a * aK[s]), w * (s === 2 ? 0.8 : 1));
    }
  }
}

// (r5) a spray / puff cell: 2-6 combed tufts sharing a cell heading (+-14 deg each), fitted inside the
// cell margins; tones dark olive -> mid -> golden drawn in that order
function drawCombSpray(g, rng, S, W, H, ax, ay, o) {
  const k = S / 512;
  const m = 0.05 * Math.min(W, H) + 4 * k;
  const tierK = S >= 512 ? 1 : S >= 256 ? 0.88 : 0.62; // (medium 0.88 / low 0.62: same mean alpha as the 512 cells)
  const list = [];
  for (let i = 0; i < o.nT; i++) {
    const f = (i + 0.3 + 0.4 * rng()) / o.nT;
    let th = o.th + (rng() - 0.5) * 2 * o.thJ;
    if (rng() < o.steep) th = (rng() < 0.6 ? 45 + 35 * rng() : -40 - 35 * rng()) * DEGR; // hanging or flaring up-right
    let L = (o.L0 + (o.L1 - o.L0) * rng()) * k;
    let x = ax + (o.x0 + (o.x1 - o.x0) * f) * W + (rng() - 0.5) * 0.06 * W, y = (o.y0 + (o.y1 - o.y0) * rng()) * H;
    x = Math.max(m, Math.min(W - m - 10 * k, x)); y = Math.max(m, Math.min(H - m - 6 * k, y));
    // fit the tuft (heading +- spread/2, droop) inside the margins
    const sp = o.spread / 2;
    let sc = 1;
    for (const da of [-sp - 0.35, 0, sp + 0.35]) {
      const ex = L * Math.cos(th + da), ey = L * (Math.sin(th + da) + 1.1 * o.droop);
      if (ex > 0) sc = Math.min(sc, (W - m - x) / ex);
      if (ex < 0) sc = Math.min(sc, (x - m) / -ex);
      if (ey > 0) sc = Math.min(sc, (H - m - y) / ey);
      if (ey < 0) sc = Math.min(sc, (y - m) / -ey);
    }
    L *= Math.max(0.3, sc);
    const tone = tasselTone(rng, o);
    const nK = Math.max(0.35, L / (o.L1 * k));
    list.push({ x, y, th, L, spread: o.spread, droop: o.droop, wb: (o.wb0 + o.wb1 * rng()) * k * Math.max(0.5, nK),
      n: Math.max(6, Math.round((o.n0 + (o.n1 - o.n0) * rng()) * nK * tierK)), nHi: Math.round((o.hi0 + o.hi1 * rng()) * (tone.order === 0 ? 0.3 : 1)),
      lum: (0.86 + 0.6 * (tone.lum - 0.86)) * (o.lumK ?? 1), lit: 0.55 + 0.7 * (tone.lit - 0.55), a: o.a, aHi: o.aHi, tipK: o.tipK ?? 1.06, tipLit: o.tipLit ?? 0.1, order: tone.order + 0.9 * rng() });
  }
  list.sort((p, q) => p.order - q.order);
  for (const c of list) drawComb(g, rng, k, c);
}
// per-variant cell heading (deg, + = drooping): most sprays stream downwind with a slight droop, some
// rise, some hang (the card roll in trees.js adds +-40 deg on top)
const COMB_TH = [14, 32, -10, 44, 6, 26, 0, 52, 20, 38];
const COMB_OPT = (v, sq) => ({
  nT: sq ? 6 + (v % 2) : 3 + (v % 3), th: COMB_TH[v % 10] * DEGR, thJ: 18 * DEGR, steep: 0.28, spread: 0.6, droop: 0.1,
  L0: sq ? 160 : 190, L1: sq ? 280 : 330, x0: 0.0, x1: sq ? 0.45 : 0.45, y0: sq ? 0.16 : 0.18, y1: sq ? 0.72 : 0.66,
  wb0: 56, wb1: 60, n0: 115, n1: 175, hi0: 3, hi1: 5, a: 0.5, aHi: 0.75, dark: 0.26, bright: 0.28,
});

// thin grey carrying twig(s) from the attachment node through the sub-centres
function drawCarrier(g, S, ax, ay, subs, rng) {
  g.lineCap = 'round';
  g.lineWidth = Math.max(0.8, 1.8 * S / 512);
  g.strokeStyle = 'rgba(92,86,72,0.55)';
  const sorted = subs.slice().sort((p, q) => p.x - q.x);
  g.beginPath(); g.moveTo(ax, ay);
  for (const sb of sorted) g.lineTo(sb.x - sb.rx * 0.3, sb.y - sb.ry * 0.2 + (rng() - 0.5) * 4 * S / 512);
  g.stroke();
}

// Crown sprays (spray / puff cells). The reference crowns' strand grain is nearly isotropic about the
// horizontal (structure-tensor angles: ~20 % rising up-right at -60..-10 deg, ~50 % within +-30 deg,
// ~25 % hanging 30-90 deg; measured on crowns B/C at t = 0.5 / 4 / 9 / 12.5): tassels stream downwind
// from -18 deg (rising, blown up-right) to +32 deg, ~30 % hang steeply, ~8 % flare steeply up-right;
// little droop, so the cards
// do not read as one combed, down-right slanted sheet.
// (r4b) coarser brush strokes: the ref sprays at 20-25 m are 2-3 px wide, 10-30 px long bright streak
// bundles over a dark interior, not a fine combed fur - half as many tassels, each a wider, longer
// bundle of more threads, a wider spread of directions and less parabolic droop (read as curls)
const SPRAY_OPT = (n) => ({ n: Math.round(n * 0.5), L0: 55, L1: 140, a0: 0.55, a1: 0.9, steep: 0.22, flat: [-40, 45], steepR: [50, 88], rise: 0.1, riseR: [-78, -48], droop: 0.08, fan: 0.55, wb0: 11, wb1: 16, t0: 9, t1: 15 });

function drawWide(g, rng, S, v) {
  const W = S, H = S / 2;
  const [au, av] = variantAttach(v);
  const ax = au * W, ay = av * H;
  const k = S / 512;
  const subs = [];
  if (v < 10) {
    // spray: an irregular lump of 46-66 separate tassels around 2-4 sub-centres
    const ns = 2 + (v % 3);
    for (let i = 0; i < ns; i++) {
      subs.push({ x: W * (0.18 + 0.52 * (i + 0.5) / ns + 0.08 * (rng() - 0.5)), y: H * (0.24 + 0.26 * rng()),
        rx: (45 + 45 * rng()) * k, ry: (22 + 20 * rng()) * k });
    }
    if (COMBED) { drawCarrier(g, S, ax, ay, subs.slice(0, 1), rng); drawCombSpray(g, rng, S, W, H, ax, ay, COMB_OPT(v, false)); } // (r5)
    else { drawCarrier(g, S, ax, ay, subs, rng); drawTasselLump(g, rng, S, W, H, subs, SPRAY_OPT(46 + (v % 5) * 5)); }
  } else if (v < 14) {
    // streamer: 4-7 long wind-streamed tassels hanging from nodes along a short twig
    subs.push({ x: W * 0.28, y: H * 0.3, rx: 45 * k, ry: 10 * k });
    if (v % 2) subs.push({ x: W * 0.45, y: H * 0.34, rx: 30 * k, ry: 8 * k });
    drawCarrier(g, S, ax, ay, subs, rng);
    drawTasselLump(g, rng, S, W, H, subs, { n: 5 + (v % 3), L0: 90, L1: 160, a0: 0.5, a1: 0.85, steep: 0.45, flat: [18, 42], steepR: [45, 70], droop: 0.2, t0: 6, t1: 11, wb0: 4, wb1: 7, fan: 0.35 });
  } else {
    // wisp (tree A layers): 12-17 separate drooping tassels strung along a twig, lit only at the
    // downwind tips, lots of gaps (45-55 % coverage)
    subs.push({ x: W * 0.42, y: H * 0.36, rx: 85 * k, ry: 12 * k });
    drawCarrier(g, S, ax, ay, [{ x: W * 0.8, y: H * 0.38, rx: 0, ry: 0 }], rng);
    drawTasselLump(g, rng, S, W, H, subs, { n: 12 + (v % 2) * 5, L0: 50, L1: 110, a0: 0.55, a1: 0.9, steep: 0.35, flat: [15, 40], steepR: [50, 75], droop: 0.18, t0: 5, t1: 9, dark: 0.3, bright: 0.2, baseK: 0.85, tipK: 1.25, tipLit: 0.45 });
  }
}

// scale a tuft so its envelope (sampled thread arcs at the extreme random multipliers) fills the room
// it is given inside the cell margins, then draw it
function tuftExtent(o) {
  // extent at R = 1 relative to the attachment node
  let x1 = 0, y0 = 0, y1 = 0;
  const lenMax = 1.15 * (o.lenK ?? 1), tw = (o.twigLen ?? 0.7);
  const twA = (o.twigDeg ?? 8) * Math.PI / 180;
  for (let k = 0; k <= 8; k++) {
    const th = (o.th0 + (o.th1 - o.th0) * k / 8) * Math.PI / 180;
    for (const dm of [0.7, 1.3]) for (const sm of [0.6, 1.4]) for (const s of [0, 1]) {
      const sx = Math.cos(twA) * tw * s, sy = Math.sin(twA) * tw * s;
      const L = lenMax * (1 - 0.3 * s);
      for (let u = 0; u <= 1.001; u += 0.1) {
        const x = sx + u * L * Math.cos(th) + u * u * L * (o.stream ?? 0.3) * sm;
        const y = sy + u * L * Math.sin(th) + u * u * L * (o.droop ?? 0.5) * dm;
        x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      }
    }
  }
  return { x1: x1 + 0.08, y0: y0 - 0.06, y1: y1 + 0.06 };
}
function fitAndDraw(g, rng, S, W, H, t) {
  const o = t.o;
  const m = 0.05 * Math.min(W, H) + 3;
  const e = tuftExtent(o);
  const R = Math.min(o.R, (W - m - t.x) / e.x1, (H - m - t.y) / e.y1, e.y0 < 0 ? (t.y - m) / -e.y0 : 1e9);
  const nK = (R / o.R) * (R / o.R);
  drawTuft(g, rng, S, t.x, t.y, Object.assign({}, o, { R, n: Math.max(12, Math.round((o.n || (R * 512 / S) * (R * 512 / S) * (o.dens ?? 0.06)) * (o.n ? Math.max(0.35, nK) : 1))) }));
}

function drawSquare(g, rng, S, v) {
  const [au, av] = variantAttach(v);
  const ax = au * S, ay = av * S;
  const tufts = [];
  if (v >= 20) {
    // puff (crown interiors): a dense square lump of 62-83 tassels around 3-5 sub-centres
    const subs = [];
    const ns = 3 + ((v - 20) % 3);
    for (let i = 0; i < ns; i++) {
      const a = (i / ns) * Math.PI * 2 + rng() * 0.8, d = S * (0.08 + 0.1 * rng());
      subs.push({ x: S * 0.4 + Math.cos(a) * d * 1.3, y: S * 0.38 + Math.sin(a) * d * 0.8, rx: S * (0.09 + 0.05 * rng()), ry: S * (0.06 + 0.04 * rng()) });
    }
    if (COMBED) { drawCarrier(g, S, ax, ay, subs.slice(0, 1), rng); drawCombSpray(g, rng, S, S, S, ax, ay, COMB_OPT(v, true)); } // (r5)
    else { drawCarrier(g, S, ax, ay, subs, rng); drawTasselLump(g, rng, S, S, S, subs, SPRAY_OPT(62 + (v % 4) * 7)); }
    return;
  } else if (COMBED) {
    // (r5) 'tassel' cells = curtains for the close-up branch E (3 m): one or two wide fans of long, fine,
    // parallel branchlets hanging down-right from the node (ref E: two soft lobes of drooping strands)
    drawCarrier(g, S, ax, ay, [{ x: ax + 0.12 * S, y: ay + 0.04 * S, rx: 0, ry: 0 }], rng);
    drawCombSpray(g, rng, S, S, S, ax, ay, { nT: 2 + (v % 2), th: (20 + 6 * (v % 3)) * DEGR, thJ: 9 * DEGR, steep: 0, spread: 0.7, droop: 0.22,
      L0: 330, L1: 420, x0: -0.06, x1: 0.1, y0: 0.3, y1: 0.46, wb0: 70, wb1: 50, n0: 170, n1: 230, hi0: 3, hi1: 4, a: 0.48, aHi: 0.62, dark: 0.04, bright: 0.4 }); // (few dark fans: ref E mid-band contrast ~0.6x ours)
    return;
  } else {
    // tassel: 2-3 steeply hanging tassels from nodes along a short twig
    const k = 2 + (v % 2);
    for (let i = 0; i < k; i++) {
      const s = (i + 0.4) / (k + 0.2);
      const R = S * (0.22 + 0.05 * rng());
      tufts.push({ x: ax + S * 0.5 * s, y: ay + S * 0.03 * rng(),
        o: { R, n: 0, th0: -20, th1: 70, droop: 0.7 + 0.25 * rng(), stream: 0.3 + 0.15 * rng(), lenK: 1.2, back: 0.4, twigDeg: 20, dens: 0.035, widthK: 1.8 } });
    }
  }
  g.lineCap = 'round';
  g.lineWidth = Math.max(0.8, 2.0 * S / 512);
  g.strokeStyle = 'rgba(78,70,58,0.6)';
  for (const t of tufts) { g.beginPath(); g.moveTo(ax, ay); g.quadraticCurveTo((ax + t.x) / 2, (ay + t.y) / 2 - 3, t.x, t.y); g.stroke(); }
  for (const t of tufts) fitAndDraw(g, rng, S, S, S, t);
}

// horizontal box blur (one pass) on a premultiplied float RGBA buffer, in place via a row scratch
function hBlur(A, W, H, r) {
  const n = 2 * r + 1, inv = 1 / n;
  const row = new Float32Array(W * 4);
  for (let y = 0; y < H; y++) {
    const o = y * W * 4;
    row.set(A.subarray(o, o + W * 4));
    for (let ch = 0; ch < 4; ch++) {
      let acc = 0;
      for (let a = -r; a <= r; a++) acc += row[Math.min(W - 1, Math.max(0, a)) * 4 + ch];
      for (let x = 0; x < W; x++) {
        A[o + x * 4 + ch] = acc * inv;
        acc += row[Math.min(W - 1, x + r + 1) * 4 + ch] - row[Math.max(0, x - r) * 4 + ch];
      }
    }
  }
}

// vertical box blur (one pass) on a premultiplied float RGBA buffer, in place via a column scratch
function vBlur(A, W, H, r) {
  const n = 2 * r + 1, inv = 1 / n;
  const colm = new Float32Array(H * 4);
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) for (let ch = 0; ch < 4; ch++) colm[y * 4 + ch] = A[(y * W + x) * 4 + ch];
    for (let ch = 0; ch < 4; ch++) {
      let acc = 0;
      for (let a = -r; a <= r; a++) acc += colm[Math.min(H - 1, Math.max(0, a)) * 4 + ch];
      for (let y = 0; y < H; y++) {
        A[(y * W + x) * 4 + ch] = acc * inv;
        acc += colm[Math.min(H - 1, y + r + 1) * 4 + ch] - colm[Math.max(0, y - r) * 4 + ch];
      }
    }
  }
}

export function makeTuftAtlas(THREE, seed = 7, opts = {}) {
  const S = opts.cell || 512;
  const W = S * ATLAS_COLS, H = S * 4;
  const cv = typeof document === 'undefined' ? new OffscreenCanvas(W, H) : document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  g.clearRect(0, 0, W, H);
  for (let v = 0; v < ATLAS_VARIANTS; v++) {
    const r = cellRect(v, S);
    g.save();
    g.beginPath(); g.rect(r.x, r.y, r.w, r.h); g.clip();
    g.translate(r.x, r.y);
    const rng = mulberry32(seed * 131 + v * 17);
    if (v < 16) drawWide(g, rng, S, v); else drawSquare(g, rng, S, v);
    g.restore();
  }
  const img = g.getImageData(0, 0, W, H).data;
  const N = W * H;
  const A = new Float32Array(N * 4);
  for (let i = 0; i < N; i++) {
    const a = img[i * 4 + 3] / 255;
    A[i * 4] = img[i * 4] * a; A[i * 4 + 1] = img[i * 4 + 1] * a; A[i * 4 + 2] = img[i * 4 + 2] * a; A[i * 4 + 3] = a;
  }
  // motion smear: the video's sprays move ~1-2 px per 1/60 s exposure, nearly isotropically (bobbing
  // slightly more than swaying), and the phone codec softens them further: a horizontal + a smaller
  // vertical box blur (strands stay readable up close through the crisp share; mips blur the crowns)
  const rh = Math.max(1, Math.round(S * 0.008));
  hBlur(A, W, H, rh);
  vBlur(A, W, H, Math.max(1, Math.round(S * 0.007)));
  // mix crisp + smeared, un-premultiply, window at cell borders
  const data = new Uint8Array(N * 4);
  const fall = Math.max(3, S * 10 / 512), gut = Math.max(2, S * 6 / 512);
  const lin = new Float32Array(256);
  for (let i = 0; i < 256; i++) { const c = i / 255; lin[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  const mean = [0, 0, 0]; let aw = 0;
  // (r5) opacity gain: lower tiers draw fewer, larger cards, so their tufts are made denser to keep the
  // crowns' coverage (medium / low crown B coverage 0.39 / 0.35 at 1.3, high 0.46, ref 0.46-0.52)
  const aGain = S >= 512 ? 1.3 : S >= 256 ? 1.45 : 1.6;
  for (let y = 0; y < H; y++) {
    const wide = y < 2 * S;
    const ch = wide ? S / 2 : S;
    const cy = wide ? y % ch : (y - 2 * S) % ch;
    const dy = Math.min(cy, ch - 1 - cy) - gut;
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const cx = x % S, dx = Math.min(cx, S - 1 - cx) - gut;
      const e = Math.max(0, Math.min(1, Math.min(dx, dy) / fall));
      const win = e * e * (3 - 2 * e);
      const a0 = img[i * 4 + 3] / 255;
      const kb = 0.82, kc = 1 - kb; // smeared / crisp share (r5: 0.7 -> 0.82, softer tuft outlines, ref crown edge gradient ~0.7x ours)
      let a = kb * A[i * 4 + 3] + kc * a0;
      const pr = kb * A[i * 4] + kc * img[i * 4] * a0, pg = kb * A[i * 4 + 1] + kc * img[i * 4 + 1] * a0, pb = kb * A[i * 4 + 2] + kc * img[i * 4 + 2] * a0;
      if (a > 0.004) {
        data[i * 4] = Math.min(255, pr / a); data[i * 4 + 1] = Math.min(255, pg / a); data[i * 4 + 2] = Math.min(255, pb / a);
      } else { data[i * 4] = 150; data[i * 4 + 1] = 140; data[i * 4 + 2] = 108; }
      a = Math.min(1, a * aGain) * win; // (the wider smear spreads coverage: keep the crowns' opacity) (r5: 1.2 -> 1.3 with the softer fringe ramp)
      data[i * 4 + 3] = Math.round(a * 255);
      if (a > 0.004) { mean[0] += lin[data[i * 4]] * a; mean[1] += lin[data[i * 4 + 1]] * a; mean[2] += lin[data[i * 4 + 2]] * a; aw += a; }
    }
  }
  // normalise the alpha-weighted mean colour to the calibrated target (per channel, linear)
  if (aw > 0) {
    const toS = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
    const lut = [0, 1, 2].map((c) => {
      const k = TARGET_MEAN[c] / (mean[c] / aw);
      const t = new Uint8Array(256);
      for (let i = 0; i < 256; i++) t[i] = Math.max(0, Math.min(255, Math.round(255 * toS(Math.min(1, lin[i] * k)))));
      return t;
    });
    for (let i = 0; i < N; i++) { data[i * 4] = lut[0][data[i * 4]]; data[i * 4 + 1] = lut[1][data[i * 4 + 1]]; data[i * 4 + 2] = lut[2][data[i * 4 + 2]]; }
  }
  // per-variant alpha bounding box in cell-local uv (v from the top of the cell), so cards can be
  // shrunk to the part of their cell that holds any texel
  const bounds = [];
  for (let v = 0; v < ATLAS_VARIANTS; v++) {
    const r = cellRect(v, S);
    let x0 = r.w, y0 = r.h, x1 = -1, y1 = -1;
    for (let y = 0; y < r.h; y++) {
      const row = (r.y + y) * W + r.x;
      for (let x = 0; x < r.w; x++) {
        if (data[(row + x) * 4 + 3] > 1) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      }
    }
    bounds.push(x1 < 0 ? [0, 0, 1, 1] : [x0 / r.w, y0 / r.h, (x1 + 1) / r.w, (y1 + 1) / r.h]);
  }
  const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  tex.userData.debugCanvas = opts.debug ? cv : null;
  tex.userData.variantBounds = bounds; // [u0, v0, u1, v1] per variant, cell-local (see variantBounds)
  return tex;
}

// Cell-local alpha bounding box [u0, v0, u1, v1] of variant v (v measured from the top of the cell,
// like variantAttach) in an atlas made by makeTuftAtlas; the whole cell when unknown.
export function variantBounds(tex, v) {
  const b = tex && tex.userData && tex.userData.variantBounds;
  return (b && b[v]) || [0, 0, 1, 1];
}

// uv rectangle of a variant (v = 0 at the top row of the atlas image, matching the DataTexture rows)
export function variantRect(v) {
  const r = cellRect(v, 1);
  return { u0: r.x / 4, v0: r.y / 4, du: r.w / 4, dv: r.h / 4 };
}
