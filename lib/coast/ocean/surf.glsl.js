// Shared GLSL for the ocean: coastal-field lookup and the analytic surf model.
// Everything is a pure function of (xz, uOT) so the ocean is deterministic and loops.

export const COAST_GLSL = /* glsl */ `
uniform sampler2D uCoastA0; uniform sampler2D uCoastA1; uniform sampler2D uCoastA2;
uniform vec4 uRect0; uniform vec4 uRect1; uniform vec4 uRect2;
float coastEdgeW(vec2 uv){
  vec2 e = min(uv, 1.0 - uv);
  return smoothstep(0.004, 0.03, min(e.x, e.y));
}
// (dSurf, depth, dRock, gully)
vec4 coastA(vec2 xz){
  vec4 r = vec4(1.0e4, 300.0, 1.0e4, 0.0);
  vec2 u2 = (xz - uRect2.xy) * uRect2.zw; float w2 = coastEdgeW(u2);
  if (w2 > 0.0) r = mix(r, texture(uCoastA2, u2), w2);
  vec2 u1 = (xz - uRect1.xy) * uRect1.zw; float w1 = coastEdgeW(u1);
  if (w1 > 0.0) r = mix(r, texture(uCoastA1, u1), w1);
  vec2 u0 = (xz - uRect0.xy) * uRect0.zw; float w0 = coastEdgeW(u0);
  if (w0 > 0.0) r = mix(r, texture(uCoastA0, u0), w0);
  return r;
}
`;

export const COASTB_GLSL = /* glsl */ `
uniform sampler2D uCoastB0; uniform sampler2D uCoastB1; uniform sampler2D uCoastB2;
// (grad dSurf.xz, dBeach (true beach distance), 0)
vec4 coastB(vec2 xz){
  vec4 r = vec4(-1.0, 0.0, 1.0e4, 0.0);
  vec2 u2 = (xz - uRect2.xy) * uRect2.zw; float w2 = coastEdgeW(u2);
  if (w2 > 0.0) r = mix(r, texture(uCoastB2, u2), w2);
  vec2 u1 = (xz - uRect1.xy) * uRect1.zw; float w1 = coastEdgeW(u1);
  if (w1 > 0.0) r = mix(r, texture(uCoastB1, u1), w1);
  vec2 u0 = (xz - uRect0.xy) * uRect0.zw; float w0 = coastEdgeW(u0);
  if (w0 > 0.0) r = mix(r, texture(uCoastB0, u0), w0);
  return r;
}
`;

// JS mirror of sHashI / sNoise1 / crestStrength below (bit-exact hash; used for the audio's breaker
// schedule in ocean.js breakerEvents and audio.js). Keep in sync with the GLSL.
function sHashI(n, seed) {
  let h = Math.imul(n | 0, 374761393) + Math.imul(seed | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (((h ^ (h >>> 16)) >>> 8) & 0xffffff) / 16777216; // top 24 bits: exact in float32 too
}
function sNoise1(x, seed) {
  const i = Math.floor(x);
  let f = x - i;
  f = f * f * (3 - 2 * f);
  const a = sHashI(i, seed);
  return a + (sHashI(i + 1, seed) - a) * f;
}
export function crestStrength(idx, s) {
  const i = ((idx % 120) + 120) % 120;
  const a = sHashI(i, 1);
  const grp = 0.5 + 0.5 * Math.sin(i * 0.785398 + 2.75);
  const n = sNoise1(s / 90 + i * 3.17, 2) * 0.6 + sNoise1(s / 35 + i * 7.31, 3) * 0.4;
  return Math.max(0, Math.min(1.2, 0.25 * a + 0.3 * grp + 0.85 * n - 0.12));
}

// 2D value noise on the integer hash; the y lattice wraps every py cells (py*2 crests = the 120-crest loop)
function sNoise2(x, y, seed, py) {
  const ix = Math.floor(x), iyf = Math.floor(y);
  let fx = x - ix, fy = y - iyf;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
  const iy = ((iyf % py) + py) % py, iy1 = (((iyf + 1) % py) + py) % py;
  const a = sHashI(ix + iy * 7919, seed), b = sHashI(ix + 1 + iy * 7919, seed);
  const c = sHashI(ix + iy1 * 7919, seed), d = sHashI(ix + 1 + iy1 * 7919, seed);
  const u = a + (b - a) * fx, v = c + (d - c) * fx;
  return u + (v - u) * fy;
}
const SURF_T = 10.0, SURF_P = Math.sin(20 * Math.PI / 180) / 8.5; // (= coast.js SURF.T / SURF.p)
// crest-line warp (phase units) of the crest passing at phase psi, alongshore coordinate s: every
// crest carries its own bends (mirror of the GLSL surfWarp)
export function surfWarp(s, psi) {
  const y = (((psi % 120) + 120) % 120) * 0.5;
  return 0.2 * (sNoise2(s / 170, y, 8, 60) - 0.5) + 0.1 * (sNoise2(s / 62, y + 0.5, 9, 60) - 0.5)
       + 0.08 * (sNoise2(s / 23, y + 0.25, 13, 60) - 0.5);
}
// time at which crest #i passes (d, z) (warped phase model): solves psi + surfWarp(s, psi) = i
export function crestTime(i, tau, z, d) {
  const s = z + 0.35 * Math.max(d, 0);
  let psi = i - surfWarp(s, i);
  psi = i - surfWarp(s, psi);
  psi = i - surfWarp(s, psi);
  return psi * SURF_T - tau + SURF_P * z;
}

// crest-strength ramps of the outer-bar and inner-bar whitewater (whiteW); breakerEvents mirrors them
export const WW_OUTER = [0.14, 0.34];
export const WW_INNER = [0.1, 0.45];
// outer-bar break distance from the beach: d = OUTER_BREAK[0] + OUTER_BREAK[1] * A (GLSL outerBreakD)
export const OUTER_BREAK = [160, 90]; // (r4: measured outer white edge ~210-230 m out, densest band ~160-200 m)
const f = (v) => v.toFixed(4);
// rip channel along the headland: inside ~140-180 m of the eye (the nominal eye xz (0, 0), world-
// anchored) and east of the platform (x < ~0) the beach bores die in the deep water by the headland
// (measured: clear water there, the reference's broken water on the left sits 150-230 m out; the
// near-field breaking there is nearbreak.js's). 1 = surf as usual, 0 = no surf whitewater / bores.
export const RIP = [178, 138, 12, -30];
// north end of the beach, by the headland (alongshore s = z + 0.35 d > ~-300): the bar lies further
// out (the reference's broken water there sits 180-260 m off the beach line, ~35 m outside the
// beach's own outer break); every break / zone distance of the surf model is measured from the
// shifted line d - surfBreakOff(s) (whiteW, crestAmp, segM, breakerEvents)
export const BREAK_OFF = [35, -380, -260]; // (whiteW's depth gates are relaxed by 0.07 m per m of shift: the bar lies deeper there)
export function surfBreakOff(s) {
  const k = Math.max(0, Math.min(1, (s - BREAK_OFF[1]) / (BREAK_OFF[2] - BREAK_OFF[1])));
  return BREAK_OFF[0] * k * k * (3 - 2 * k);
}
export function surfRipG(x, z) {
  const sm = (a, b, v) => { const k = Math.max(0, Math.min(1, (v - a) / (b - a))); return k * k * (3 - 2 * k); };
  return 1 - sm(RIP[0], RIP[1], Math.hypot(x, z)) * sm(RIP[2], RIP[3], x);
}

// Surf model. psi = (t + tau(d) - p z) / T + surfWarp(s, psi) : crest i passes a point when psi
// crosses i (the warp bends every crest line its own way; breakerEvents solves it with crestTime).
export const SURF_GLSL = /* glsl */ `
uniform sampler2D uTau;
uniform float uOT;      // ocean time (mod loop)
uniform float uSurfT;   // breaker period
uniform float uSurfP;   // alongshore slowness
uniform float uDMax;    // LUT range
uniform float uSurfAmp; // global height multiplier

// integer hash (hash2() of core/rng.js, top 24 bits so it is bit-exact on every GPU and in JS; the JS
// crestStrength() at the top of this file mirrors it), so the audio's breaker schedule (ocean.js
// breakerEvents) matches the visible crests. (A fract(sin()) hash differs between GPU float32 and JS.)
float sHashI(int n, int s){
  uint h = uint(n) * 374761393u + uint(s) * 668265263u;
  h = (h ^ (h >> 13u)) * 1274126177u;
  h ^= h >> 16u;
  return float(h >> 8u) * (1.0 / 16777216.0); // top 24 bits: exactly representable -> bit-exact vs JS
}
float sNoise1(float x, int seed){
  float i = floor(x); float f = x - i; f = f*f*(3.0-2.0*f);
  int ii = int(i);
  return mix(sHashI(ii, seed), sHashI(ii + 1, seed), f);
}
// 2D value noise, y lattice periodic in py cells (JS mirror: sNoise2 at the top of surf.glsl.js)
float sNoise2(vec2 p, int seed, float py){
  vec2 i = floor(p); vec2 f = p - i; f = f*f*(3.0-2.0*f);
  int ix = int(i.x);
  int iy = int(mod(i.y, py)) * 7919, iy1 = int(mod(i.y + 1.0, py)) * 7919;
  return mix(mix(sHashI(ix + iy, seed), sHashI(ix + 1 + iy, seed), f.x),
             mix(sHashI(ix + iy1, seed), sHashI(ix + 1 + iy1, seed), f.x), f.y);
}
// crest-line warp (phase units): every crest carries its own bends along the shore (60-200 m, up to
// +-0.15 T, i.e. +-10 m and +-10 deg of crest orientation), so successive lines are not parallel
// copies; it depends on the crest's own phase, so a bend travels with its crest (d warp/d psi < 0.25:
// the warped phase stays monotonic). Periodic in psi over the 120-crest loop. (JS mirror: surfWarp)
float surfWarp(float s, float psi){
  float y = mod(psi, 120.0) * 0.5;
  return 0.2 * (sNoise2(vec2(s / 170.0, y), 8, 60.0) - 0.5) + 0.1 * (sNoise2(vec2(s / 62.0, y + 0.5), 9, 60.0) - 0.5)
       + 0.08 * (sNoise2(vec2(s / 23.0, y + 0.25), 13, 60.0) - 0.5); // (short wiggles: +-2-3 m every 20-30 m, wavy lines)
}

// strength of crest #idx at alongshore coordinate s, ~[0, 1.2]
float crestStrength(float idx, float s){
  float i = mod(idx, 120.0);
  float a = sHashI(int(i), 1);
  float grp = 0.5 + 0.5 * sin(i * 0.785398 + 2.75); // 8-wave groups (a big set during the replayed 0-14 s)
  float n = sNoise1(s / 90.0 + i * 3.17, 2) * 0.6 + sNoise1(s / 35.0 + i * 7.31, 3) * 0.4;
  return clamp(0.25 * a + 0.3 * grp + 0.85 * n - 0.12, 0.0, 1.2);
}

// (JS mirror: OUTER_BREAK above / breakerEvents / spray.js)
float outerBreakD(float A){ return ${f(OUTER_BREAK[0])} + ${f(OUTER_BREAK[1])} * A; }
// (JS mirror: surfBreakOff above)
float surfBreakOff(float s){ return ${f(BREAK_OFF[0])} * smoothstep(${f(BREAK_OFF[1])}, ${f(BREAK_OFF[2])}, s); }
// (JS mirror: surfRipG above)
float surfRipG(vec2 xz){ return 1.0 - smoothstep(${f(RIP[0])}, ${f(RIP[1])}, length(xz)) * smoothstep(${f(RIP[2])}, ${f(RIP[3])}, xz.x); }

// whitewater intensity carried by a crest of strength A while it is at distance d (water depth h):
// crests only break over the bars (h < ~10 m) and a bore only survives in shallow water — over the
// deep water under the headland / off the reef it dies out within ~25 m
// bg: beach gate (0 on the rock shelf under the headland, where there is no sand bar / swash)
// fd: pixel footprint in d (m): far out one pixel spans 30-60 m of range, so the 12-20 m break /
// inner / shore ramps are widened to it (a sub-pixel ramp flickered as the handheld camera moved)
float whiteW(float d, float A, float h, float bg, float fd){
  float dO = outerBreakD(A);
  float outer = smoothstep(${f(WW_OUTER[0])}, ${f(WW_OUTER[1])}, A) * smoothstep(dO + 3.0 + fd, dO - 9.0 - fd, d) * mix(0.36, 1.0, smoothstep(108.0, 155.0, d));
  outer *= smoothstep(15.0, 10.5, h) * mix(1.0, smoothstep(12.0, 9.0, h), smoothstep(dO - 6.0, dO - 30.0, d));
  float Ai = smoothstep(${f(WW_INNER[0])}, ${f(WW_INNER[1])}, A);
  float inner = smoothstep(124.0 + fd, 104.0 - fd, d) * Ai * mix(0.4, 1.0, smoothstep(35.0, 92.0, d)) * smoothstep(6.0, 4.2, h);
  float shore = smoothstep(24.0 + fd, 7.0 - fd, d) * 0.85 * smoothstep(4.0, 2.0, h);
  return max(max(outer, inner * bg), shore * bg);
}
float whiteW(float d, float A, float h, float bg){ return whiteW(d, A, h, bg, 0.0); }
float whiteW(float d, float A, float h){ return whiteW(d, A, h, 1.0, 0.0); }

// along-crest segmentation of the whitewater: each crest breaks in 5-60 m pieces of varying
// brightness, staggered line to line (per-line threshold); gap (0..1) opens more clear water between
// the pieces (far along the beach: short staggered crests, not continuous stripes)
// d: distance from the beach — the two octaves drift along the crest in opposite directions as it
// travels shoreward, so pieces grow, split, merge and die at different times (not a fixed dash pattern);
// the soft ramp tapers every piece toward its ends (bright core, thin ragged ends)
// (JS mirror of the pattern: spray.js spSegM)
// fs: pixel footprint along the crest line (m of s per pixel; 0 = unfiltered): the crests run nearly
// along the view direction, so s is strongly foreshortened far out — each octave fades to its mean
// before it aliases into dotted rows
float segM(float idx, float s, float gap, float d, float fs){
  float i = mod(idx, 120.0);
  float sl = d / 95.0;
  float k1 = 1.0 - smoothstep(0.3, 0.8, fs / 19.0), k2 = 1.0 - smoothstep(0.3, 0.8, fs / 7.0);
  float n = 0.5 + 0.58 * k1 * (sNoise1(s / 19.0 + i * 5.3 + sl, 4) - 0.5) + 0.42 * k2 * (sNoise1(s / 7.0 + i * 2.1 - 1.6 * sl, 5) - 0.5);
  // (threshold: ~68% of the crest white near, ~58% far; pieces 5-70 m, median ~24 m, with 5-40 m
  // clear gaps; a 140 m density octave groups them: dense stretches and sparse ones along a line)
  float lo = 0.3 + 0.05 * gap + 0.12 * (sHashI(int(i), 7) - 0.5) + 0.2 * (1.0 - smoothstep(0.3, 0.8, fs / 140.0)) * (sNoise1(s / 140.0 + i * 0.77, 10) - 0.5)
           - 0.06 * smoothstep(140.0, 160.0, d) * smoothstep(250.0, 220.0, d); // (denser just inside the outer break; spray.js spSegM mirrors)
  float g = mix(0.55, 1.25, sNoise1(s / 50.0 + i * 1.9, 6)); // piece-to-piece strength
  // (piece ends: the threshold ramp is widened to the pixel footprint — the n slope is at most
  // ~0.05 + 0.09 per m along the crest — so a far piece never ends in a sub-pixel hard cut that
  // steps / sparkles as it drifts; fs = 0 (vertex, JS mirrors) keeps the plain ramp)
  float e = fs * (0.046 * k1 + 0.09 * k2);
  return smoothstep(lo - e, lo + 0.22 + e, n) * g;
}

// screen steepness of a crest line: a crest that runs within a few degrees of the view ray projects
// as a steep / vertical stroke (behind the platform the beach, and every crest parallel to it, bends
// toward the camera: bright vertical 'hooks' the reference never shows). Analytic (crest tangent
// against the radial direction, foreshortened by eye height / range): smooth, no screen derivatives.
// 1 below ~37 deg on screen, 0 above ~53 deg (shallower lines are the measured inner-zone look).
float crestViewGate(vec2 xz, vec2 gradPsi, vec3 cam){
  vec2 r = xz - cam.xz;
  float gr = length(gradPsi) * length(r) + 1e-6;
  float sn = abs(dot(gradPsi, r)) / gr;                       // sin(crest tangent, view ray)
  float cs = abs(gradPsi.x * r.y - gradPsi.y * r.x) / gr;     // cos
  float slope = cs / max(sn, 1e-3) * max(cam.y - 0.0, 1.0) / max(length(r), 1.0);
  return 1.0 - smoothstep(0.75, 1.35, slope);
}

// amplitude of a crest of strength A at distance d
float crestAmp(float d, float A){
  float dO = outerBreakD(A);
  float big = smoothstep(0.34, 0.48, A);
  float a = 0.35 + 0.45 * A;
  a *= 1.0 + 1.1 * smoothstep(650.0, 230.0, d) * (0.5 + 0.5 * big);
  a *= mix(1.0, mix(0.42, 1.0, smoothstep(dO - 45.0, dO, d)), big);
  // shoaling peak: the crest jacks up over the last ~30 m before it pitches
  a *= 1.0 + 0.75 * big * smoothstep(dO + 34.0, dO + 4.0, d) * smoothstep(dO - 8.0, dO + 1.0, d);
  a *= mix(0.38, 1.0, smoothstep(70.0, 118.0, d));
  a *= smoothstep(-2.0, 30.0, d) * 0.85 + 0.15 * smoothstep(-2.0, 4.0, d);
  return a * uSurfAmp;
}

struct SurfPhase { float psi; float i0; float u; float s; float d; float tauP; };

SurfPhase surfPhase(vec2 xz, float d, float dR){
  SurfPhase P;
  float dd = max(d, 0.0);
  vec4 lut = texture(uTau, vec2(clamp(dd / uDMax, 0.0, 1.0) * (1023.0/1024.0) + 0.5/1024.0, 0.5));
  float tau = lut.x + max(dd - uDMax, 0.0) * lut.y;
  // crests slow down in the shallows around the rocks and wrap around them
  float rl = max(0.0, 45.0 - max(dR, 0.0));
  tau -= 0.0022 * rl * rl * smoothstep(20.0, 70.0, dd);
  P.s = xz.y + 0.35 * dd;
  P.psi = (uOT + tau - uSurfP * xz.y) / uSurfT;
  P.psi += surfWarp(P.s, P.psi);
  P.i0 = floor(P.psi);
  P.u = P.psi - P.i0;
  P.d = d;
  P.tauP = lut.y;
  return P;
}

// crest profile: du in [-0.5,0.5), negative = ahead of (shoreward of) the crest
float crestShape(float du, float steep){
  float wf = mix(0.12, 0.045, steep);
  float wb = 0.2;
  float x = du < 0.0 ? du / wf : du / wb;
  return exp(-x * x) - 0.32;
}
// blur: pixel footprint in phase units. The steep front is only 2-5 m wide, below a pixel where the
// view looks across the crests; widening it to the footprint keeps the height step (the integral of
// the slope) but stops the sub-pixel face from aliasing into a thin contour along the crest
float crestShapeD(float du, float steep, float blur){
  float wf = mix(0.11, 0.035, steep);
  float wb = 0.2;
  float w = du < 0.0 ? wf : wb;
  w = sqrt(w * w + blur * blur);
  float x = du / w;
  return -2.0 * x / w * exp(-x * x);
}
float crestShapeD(float du, float steep){ return crestShapeD(du, steep, 0.0); }

// surf height (vertex): crest profile for unbroken waves, bore (step + decaying roller) for broken ones
// bg: beach gate, sJo: along-crest jitter of the segment ends, gap: segM gap (same as the fragment's
// whitewater mask, so a crest only steps into a bore where it actually carries whitewater)
// one crest's contribution at phase offset du (du in [-0.5, 0.5), negative = ahead of the crest)
// fpv: grid spacing in phase units. The bore front (a 1-2 m step) is never steeper than ~1.6 grid
// cells: a step inside one ring folds the mesh along the triangle edges, and a crest line crossing
// the rings at a shallow angle then shows as a stepped / dashed staircase
float surfCrestY(float idx, float du, float s, float d, float h, float wide, float fpv, float bg, float sJo, float gap, float gV){
  float A = crestStrength(idx, s);
  float bO = surfBreakOff(s);
  d -= bO; h -= 0.07 * bO; // (break / zone distances and the bar's depth gates from the shifted line at the north end)
  float steep = smoothstep(outerBreakD(A) + 60.0, outerBreakD(A), d) * smoothstep(0.35, 0.55, A);
  steep = max(steep, smoothstep(160.0, 118.0, d) * smoothstep(60.0, 100.0, d));
  steep *= 1.0 - wide;
  float amp = crestAmp(d, A);
  float W = min(whiteW(d, A, h, bg) * segM(idx, (s + sJo) * mix(2.2, 1.0, bg), max(gap, 0.45 * (1.0 - bg)), d, 0.0), 1.0) * gV;
  float y = amp * crestShape(du, steep);
  // bore: water level steps up at the front and relaxes behind it; whitewater roller on top
  float age = du * uSurfT;
  float fr = smoothstep(-max(0.03 + 0.03 * wide, 1.6 * fpv), 0.0, du);
  float bore = du >= 0.0 ? exp(-age / 3.0) : fr;
  float roller = du >= 0.0 ? exp(-age / 1.1) : fr;
  y = mix(y, amp * (1.1 * bore - 0.3) + 0.9 * roller * amp, W * 0.85);
  // roller hump: the tumbling whitewater stands proud of the bore level just behind the front
  float hw = max(0.02 + 0.03 * wide, 1.3 * fpv);
  float hx = (du - 0.008) / hw;
  y += W * 0.85 * amp * 0.4 * exp(-hx * hx) * (0.02 + 0.03 * wide) / hw; // (widened: same volume)
  return y;
}
// gD: grad of the surf distance (coastB.xy): beach bores whose crest projects steeply on screen
// (crestViewGate) carry no bore / roller, like the fragment's whitewater
float surfHeight(vec2 xz, float d, float dR, float h, float sp, float bg, float sJo, float gap, vec2 gD){
  if (d > 1400.0) return 0.0;
  float wide = smoothstep(2.0, 12.0, sp);
  SurfPhase P = surfPhase(xz, d, dR);
  float fpv = sp * P.tauP / uSurfT;
  float gV = mix(1.0, crestViewGate(xz, (P.tauP * gD - vec2(0.0, uSurfP)) / uSurfT, cameraPosition),
                 max(bg, smoothstep(190.0, 230.0, length(xz - cameraPosition.xz))) * smoothstep(12.0, 30.0, d));
  gV *= surfRipG(xz); // (no bores in the rip channel by the headland, like the fragment's whitewater)
  // the trough between crest i0 (behind) and i0+1 (ahead) blends the two crests' levels over
  // u = 0.35-0.65, so there is no height step along the trough line where the crest index switches
  float wB = smoothstep(0.35, 0.65, P.u);
  float y = 0.0;
  if (wB < 1.0) y += (1.0 - wB) * surfCrestY(P.i0, P.u, P.s, d, h, wide, fpv, bg, sJo, gap, gV);
  if (wB > 0.0) y += wB * surfCrestY(P.i0 + 1.0, P.u - 1.0, P.s, d, h, wide, fpv, bg, sJo, gap, gV);
  return y;
}
`;
