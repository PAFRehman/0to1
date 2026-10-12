// Near-field breakers under the headland (80-160 m below the camera): individual breaking waves that
// ride the 10 s swell phase field of the surf model (surf.glsl.js surfPhase: psi = (t + tau(d) - p z)/T),
// so their crests have the refracted orientation and speed of the rendered swell.
// Each event is a piece of crest with its own phase psiE (it rides the iso-line psi = psiE), a centre
// sE along the crest (P.s coordinate), a break time tB and a height H. Life cycle (tau = t - tB):
//   tau -6..0  shoaling: the hump rises, the front face steepens and turns translucent near the top
//   tau -1..1  the crest feathers, pitches forward (lip thrown ahead, vertex displacement) and the
//              whitewater curtain runs down the face
//   tau 0..6   a tumbling roller of cream-lit whitewater rides the crest; the broken section peels
//              along the crest
//   tau 0..14  an aerated sheet with torn lace is left behind the crest and drifts slowly forward
// The replayed reference window (t 0-14 s) uses events measured from the reference video; beyond it
// the schedule is a seeded function of the swell cycle (10 s), periodic with the 1200 s ocean loop.
// Pure function of t: the CPU picks the active events for the current time and uploads them.
import { SURF } from './coast.js';

export const NBK_N = 6;

// Events measured from the reference video (see work/r4_breakers). In the near field the broken
// crests run across the view (left to right, slightly toward the camera: refracted around the reef),
// so each event has its own world frame: crest centre (x0, z0) at the break, travel direction th
// (deg from +X toward +Z) and speed c (m/s; slow, 4-5 m/s, over the reef). tB = break time, H =
// crest height (m), L = half-length of the broken section at full peel, off = offset of the broken
// section from the hump centre, w = whitewater strength, dur = roller lifetime scale (s, quarter steps)
// (positions: reference screen points projected onto the sea plane, minus ~4 m for the crest height)
const REPLAY = [
  // lacy, decaying hump at t = 0.5 (x 135-230, rows 505-550) and a small feathering crest above it
  // (r5: w 0.55 -> 0.4: its bright core had ~2x the reference's pixels > 200)
  { x0: -45.0, z0: -82.0, th: 12, c: 4.0, tB: -2.0, H: 2.0, L: 2.5, off: 0.0, w: 0.4, dur: 1.5, seed: 0.11 },
  { x0: -47.0, z0: -100.0, th: 15, c: 4.0, tB: 1.2, H: 1.5, L: 1.5, off: 0.0, w: 0.45, dur: 1, seed: 0.37 },
  // the spilling peak travelling right at t = 7.5-11 (x 320 -> 470, rows 500-550); its trail is the
  // lower sheet at t = 12.5
  { x0: -37.0, z0: -86.5, th: 7, c: 4.3, tB: 6.8, H: 3.2, L: 2.5, off: 0.0, w: 1.0, dur: 5, seed: 0.53 },
  // the big breaker emerging behind the she-oak at t = 9 (x 60) that becomes the kidney-shaped mass
  // with the cream crescent at t = 12.5 (front x 150-300, rows 470-525)
  { x0: -53.5, z0: -100.5, th: 40, c: 4.4, tB: 8.8, H: 3.4, L: 8.0, off: 0.0, w: 1.0, dur: 4, seed: 0.71 },
  // a second piece of the same crest further out joins it from the upper left (the upper half of the
  // t = 12.5 mass, rows 430-470)
  // (r5: longer, stronger, longer-lived: the t = 12.5 mass had ~60% of the reference's bright area,
  // missing its upper half)
  { x0: -56.5, z0: -111.9, th: 40, c: 4.4, tB: 9.7, H: 2.2, L: 7.0, off: 0.0, w: 1.0, dur: 5, seed: 0.47 },
  // bore sheets further out (123-186 m, rows 330-420): broken crests on the outer reef
  { x0: -76.0, z0: -150.0, th: 20, c: 6.0, tB: -3.0, H: 2.4, L: 14.0, off: 0.0, w: 1.0, dur: 3, seed: 0.29 },
  { x0: -62.0, z0: -140.0, th: 20, c: 6.0, tB: 6.0, H: 2.6, L: 12.0, off: 0.0, w: 0.9, dur: 4, seed: 0.83 },
];

function hash(n, s) {
  let h = Math.imul(n | 0, 374761393) + Math.imul(s | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (((h ^ (h >>> 16)) >>> 8) & 0xffffff) / 16777216;
}

export function createNearBreakers() {
  const LOOP = 1200;
  const T = SURF.T;
  // seeded schedule for the swell cycles after the replay window (cycles 2..117; the last 20 s before
  // the loop wrap stay calm so the replay events can wrap cleanly): near pieces under the cliffs
  // (85-110 m) and longer bore sheets on the outer reef (125-190 m)
  const events = REPLAY.map((e) => ({ ...e }));
  for (let n = 2; n < 118; n++) {
    for (let k = 0; k < 3; k++) {
      const h0 = hash(n, 11 + k);
      if (h0 < 0.3) continue;
      const tB = n * T + (k + hash(n, 21 + k)) * (T / 3);
      const far = hash(n, 31 + k) < 0.4;
      const big = hash(n, 51 + k);
      events.push(far ? {
        x0: -95 + 45 * hash(n, 41 + k), z0: -185 + 50 * hash(n, 71 + k), th: 12 + 16 * hash(n, 61 + k), c: 5.5 + hash(n, 81 + k),
        tB, H: 1.8 + 1.0 * big, L: 6 + 8 * hash(n, 121 + k), off: 0, w: 0.7 + 0.3 * hash(n, 91 + k),
        dur: 3 + Math.floor(2 * hash(n, 111 + k)), seed: hash(n, 101 + k),
      } : {
        x0: -62 + 34 * hash(n, 41 + k), z0: -100 + 20 * hash(n, 71 + k), th: 5 + 25 * hash(n, 61 + k), c: 3.8 + 1.2 * hash(n, 81 + k),
        tB, H: 1.4 + 2.0 * big, L: 1.5 + 5.0 * big * hash(n, 121 + k), off: (hash(n, 131 + k) - 0.5) * 3.0,
        w: 0.6 + 0.4 * hash(n, 91 + k), dur: 2 + Math.floor(4 * hash(n, 111 + k)), seed: hash(n, 101 + k),
      });
    }
  }
  for (const e of events) { const a = e.th * Math.PI / 180; e.dx = Math.cos(a); e.dz = Math.sin(a); }
  const u0 = Array.from({ length: NBK_N }, () => [0, 0, 0, 0]);
  const u1 = Array.from({ length: NBK_N }, () => [0, 0, 0, 0]);
  const u2 = Array.from({ length: NBK_N }, () => [1, 0, 4, 0]);
  const flat0 = new Float32Array(NBK_N * 4), flat1 = new Float32Array(NBK_N * 4), flat2 = new Float32Array(NBK_N * 4);
  const uniforms = {
    uNbk0: { value: flat0 },
    uNbk1: { value: flat1 },
    uNbk2: { value: flat2 },
  };
  const act = [];
  function update(tl) {
    act.length = 0;
    for (const e of events) {
      for (let k = -1; k <= 1; k++) {
        const tB = e.tB + LOOP * k;
        const tau = tl - tB;
        if (tau < -6.5 || tau > 14.0) continue;
        act.push({ e, tau, w: e.H * (tau < 0 ? 1 + tau / 7 : 1 - tau / 16) });
      }
    }
    act.sort((a, b) => b.w - a.w);
    const wCut = act.length > NBK_N ? act[NBK_N].w : 0;
    // slots 0-2 = the 3 strongest, 3-5 the next 3 (medium tier draws 0-2), each group ordered by break
    // time, so the slot order changes only when the set changes
    const top = act.slice(0, 3).sort((a, b) => b.tau - a.tau);
    const nxt = act.slice(3, NBK_N).sort((a, b) => b.tau - a.tau);
    const sel = top.concat(nxt);
    for (let i = 0; i < NBK_N; i++) {
      const a = sel[i];
      if (!a) { u0[i] = [0, 0, 0, 0]; u1[i] = [0, 0, 0, 0]; u2[i] = [1, 0, 4, 0]; }
      else {
        const e = a.e;
        // (fade an event out before a 7th one can push it out of the slots: no one-frame pop)
        const fadeW = wCut > 0 ? Math.min(1, Math.max(0, (a.w - wCut) / 0.3)) : 1;
        const fw = fadeW * fadeW * (3 - 2 * fadeW);
        u0[i] = [e.x0 + e.dx * e.c * a.tau, e.z0 + e.dz * e.c * a.tau, a.tau, e.H];
        // (z: integer part = 4 * dur (quarter seconds), fraction = seed)
        u1[i] = [e.L, e.off, Math.round(e.dur * 4) + 0.999 * e.seed, e.w * fw];
        u2[i] = [e.dx, e.dz, e.c, 0];
      }
      flat0.set(u0[i], i * 4);
      flat1.set(u1[i], i * 4);
      flat2.set(u2[i], i * 4);
    }
  }
  return { uniforms, update, events };
}

// ---- GLSL (needs SURF_GLSL, NOISE_GLSL: macroNoise) ----
export const NBK_GLSL = /* glsl */ `
#define NBK_N ${NBK_N}
uniform vec4 uNbk0[NBK_N]; // (crest centre x, z (world), tau = t - tBreak, H)  H = 0: unused slot
uniform vec4 uNbk1[NBK_N]; // (L half-length of the broken section, off, 4 dur + seed, whitewater strength)
uniform vec4 uNbk2[NBK_N]; // (travel direction x, z, speed c (m/s), -)
// local frame of event i at world xz: (a along the crest, b ahead of the crest line)
vec2 nbkLocal(vec2 xz, vec4 e0, vec4 e2){
  vec2 r = xz - e0.xy;
  return vec2(dot(r, vec2(-e2.y, e2.x)), dot(r, e2.xy));
}

float nbkDur(vec4 e1){ return max(floor(e1.z) * 0.25, 0.5); }
// the broken section is a peak: its centre leads and the shoulders lag (convex front, rounded
// kidney-shaped whitewater mass instead of a straight diagonal ridge). b_bent = b + nbkBend
float nbkBend(float a, vec4 e1){
  float q = a - e1.y, Q = e1.x + 9.0;
  return 0.022 * Q * Q * (1.0 - exp(-q * q / (Q * Q)));
}
// broken section along the crest: peels out from the centre after the break; ragged ends
float nbkSec(float a, vec4 e1, float tau, float soft){
  float Lc = e1.x * (0.3 + 0.7 * smoothstep(-0.3, 3.0, tau)) + 0.8;
  return smoothstep(Lc + soft, Lc - soft, abs(a - e1.y));
}
// crest height of event (e0, e1) at local (a along the crest, bR ahead of the phase line), plus the
// forward (lip) displacement; blurB = sampling footprint (vertex spacing / pixel): the steep front,
// the roller, the bore front and the lumps are widened / faded to it (no crawling, no contour line)
vec2 nbkShape(float a, float bR, vec4 e0, vec4 e1, float blurB){
  float b = bR + nbkBend(a, e1);
  float tau = e0.z, H = e0.w;
  float dur = nbkDur(e1), sdn = fract(e1.z) * 37.0;
  float grow = smoothstep(-6.5, -0.6, tau);
  float fall = mix(1.0, 0.42, smoothstep(0.3, 0.4 * dur + 1.0, tau)) * (1.0 - smoothstep(dur + 2.0, 2.0 * dur + 7.0, tau));
  float Lh = e1.x + 6.0 + 2.5 * H;
  float ah = a / Lh;
  float envA = exp(-2.0 * ah * ah);
  // the front steepens into an asymmetric, forward-leaning profile before the break
  float steep = smoothstep(-4.0, 0.0, tau) * (1.0 - 0.6 * smoothstep(dur - 0.5, dur + 2.0, tau));
  float wf = mix(6.0, 1.7, steep);
  wf = sqrt(wf * wf + blurB * blurB);
  float wb = mix(mix(9.0, 6.5, steep), 20.0, smoothstep(0.5, 3.5, tau));
  float x = b > 0.0 ? b / wf : b / wb;
  float y = H * grow * fall * envA * exp(-x * x);
  float sec = nbkSec(a, e1, tau, 2.0);
  // lumps of the tumbling whitewater: 4-6 m clots plus a 1.6 m octave, faded by the footprint
  float bs = b + 1.6 * tau;
#ifdef OCEAN_LQ
  float lmp = 0.5;
#else
  float lmp = 0.5 + (macroNoise(vec2(a / 5.0, bs / 3.4) + sdn) - 0.5) * (1.0 - smoothstep(0.5, 1.0, blurB / 3.5))
                  + (macroNoise(vec2(a / 1.6, bs / 1.4) + sdn + 4.3) - 0.5) * 0.3 * (1.0 - smoothstep(0.4, 0.8, blurB / 1.5));
#endif
  // whitewater roller riding just behind the crest after the break (stands proud, lumpy)
  float rol = smoothstep(-0.2, 0.8, tau) * exp(-max(tau - 0.8, 0.0) / dur) * sec * e1.w;
  float xr = (b + 1.1) / sqrt(4.84 + blurB * blurB);
  y += H * 0.55 * rol * exp(-xr * xr) * (0.6 + 0.8 * lmp);
  // the broken crest runs on as a raised, lumpy bore: a whitewater mass ~0.5-1 m thick left behind it
  float tb = min(max(tau + 0.5, 0.0), 3.6);
  float mass = smoothstep(-0.2, 0.8, tau) * sec * e1.w * exp(-max(tau - 2.5, 0.0) / (dur + 2.0))
             * smoothstep(-4.0 * tb - 2.0, -0.4 * (4.0 * tb + 2.0), b) * (b < 0.0 ? 1.0 : exp(-b * b / (0.64 + blurB * blurB)));
  y += 0.32 * H * mass * (0.45 + 0.9 * lmp);
  // pitching lip: the crest top is thrown forward (and falls) around the break. Its amplitude is
  // capped to the width of the lip so the forward displacement never folds the mesh (dD/db > -0.82)
  float pitch = smoothstep(-1.0, 0.2, tau) * (1.0 - smoothstep(0.9, 2.6, tau));
  float sl = 0.6 * wf + 0.6;
  float xl = b / sl;
  float lip = min(0.6 * H, 0.95 * sl) * pitch * sec * envA * exp(-xl * xl);
  y -= lip * 0.25 * smoothstep(0.3, 1.5, tau);
  return vec2(y, lip);
}
`;

// ---- fragment: slope of the breakers, translucent face, whitewater, spray veil (needs uFoam,
// uFoamTile, uSunDir, uSurfT, macroNoise, cameraPosition). Colours through the display contract
// (invACES of the measured sRGB, ref frames 9.0 / 12.5 s): the thin lower curtain lit through by the
// low sun (250,239,206), hot core (254,243,212); body of the mass sky-lit blue-white (166,195,210)
// with brighter clots (225,228,222) and shaded folds (110,148,160); backlit spray veil (240,234,218)
export const NBK_FRAG_GLSL = /* glsl */ `
struct NbkOut { vec2 grad; float cov; vec3 col; float trans; float aer; };
// dX, dY: screen derivatives of xz, taken in uniform control flow by the caller (the textures here
// are sampled with explicit gradients: this runs inside a per-pixel branch / early-out loop)
// (psiS, sS, lamS, fwdS, aDirS: the surf-phase frame, unused since the events carry world frames)
NbkOut nbkFrag(vec2 xz, float psiS, float sS, float lamS, vec2 fwdS, vec2 aDirS, vec2 dX, vec2 dY){
  float fpM = max(length(dX), length(dY));
  NbkOut o; o.grad = vec2(0.0); o.cov = 0.0; o.col = vec3(0.0); o.trans = 0.0; o.aer = 0.0;
  const vec3 NB_LIT = vec3(4.358, 2.481, 0.700);   // (250,239,206)
  const vec3 NB_CORE = vec3(7.360, 3.257, 0.650);  // (254,243,212)
  const vec3 NB_TOP = vec3(1.577, 1.764, 1.428);   // (225,228,222)
  const vec3 NB_SHADE = vec3(0.225, 0.471, 0.694);
  const vec3 NB_POCKET = vec3(0.099, 0.223, 0.280);
  const vec3 NB_SHEET = vec3(0.62, 0.92, 1.12);    // (180,200,210) lit clots of the sheet
  const vec3 NB_BW = vec3(0.448, 0.808, 1.116);    // (166,195,210) sky-lit body of the whitewater
  const vec3 NB_FOLD = vec3(0.217, 0.400, 0.480);  // (110,148,160) shaded folds between the clots
  const vec3 NB_MIST = vec3(2.878, 2.191, 1.166);  // (240,234,218) backlit spray veil
  vec3 L = normalize(uSunDir);
  // a point h m above the water shows on the water plane at xz + away * kH * h (view ray): in the
  // crest frame that is (dadh, dbdh) per metre of height (dbdh < 0: up the screen, behind the crest)
  vec2 rel = xz - cameraPosition.xz;
  float kH = length(rel) / max(cameraPosition.y, 1.0);
  vec2 away = rel / max(length(rel), 1e-3);
#ifdef OCEAN_LQ
  for (int i = 0; i < 3; i++) {   // (slots 0-2 hold the three strongest events)
#else
  for (int i = 0; i < NBK_N; i++) {
#endif
    vec4 e0 = uNbk0[i]; vec4 e1 = uNbk1[i];
    if (e0.w <= 0.0) continue;
    vec4 e2 = uNbk2[i];
    float tau = e0.z, H = e0.w;
    vec2 fwd = e2.xy, aDir = vec2(-e2.y, e2.x);
    float c = e2.z; // crest speed (m/s)
    vec2 ab = nbkLocal(xz, e0, e2);
    float a = ab.x, bR = ab.y;
    float b = bR + nbkBend(a, e1);
    float dbdh = dot(away, fwd) * kH;
    dbdh = dbdh < 0.0 ? min(dbdh, -0.6) : max(dbdh, 0.6);
    float dadh = dot(away, aDir) * kH;
    float hTop = H * (0.7 + 0.8 * smoothstep(-0.3, 1.2, tau)); // spray veil top above the lip
    float mOn = tau < 3.8 ? hTop : 0.0;
    float back = max(min(2.0 + max(tau, 0.0) * (c - 1.0), 60.0) + 6.0, max(-dbdh, 0.0) * mOn + 2.0);
    if (b < -back || b > max(16.0, dbdh * mOn + 2.0) || abs(a) > e1.x + 20.0 + 2.5 * H + abs(dadh) * mOn) continue;
    vec2 lX = vec2(dot(aDir, dX), dot(fwd, dX)), lY = vec2(dot(aDir, dY), dot(fwd, dY)); // d(a,b)
    float blurB = 1.5 * fpM;
    vec2 h0 = nbkShape(a, bR, e0, e1, blurB);
    float eps = max(0.3, fpM);
    float hb = nbkShape(a, bR + eps, e0, e1, blurB).x;
    float ha = nbkShape(a + eps, bR, e0, e1, blurB).x;
    vec2 g = ((hb - h0.x) / eps) * fwd + ((ha - h0.x) / eps) * aDir;
    o.grad += g;

    // ---- masks ----
    float dur = nbkDur(e1);
    float steep = smoothstep(-4.0, 0.0, tau) * (1.0 - 0.6 * smoothstep(dur - 0.5, dur + 2.0, tau));
    float wf = sqrt(pow(mix(6.0, 1.7, steep), 2.0) + blurB * blurB);
    float hf = b > 0.0 ? exp(-(b / wf) * (b / wf)) : 1.0;   // height fraction on the front face
    float Lh = e1.x + 6.0 + 2.5 * H;
    float envA = exp(-2.0 * (a / Lh) * (a / Lh));
    float soft = 1.2 + 0.12 * e1.x + fpM;
    // torn texture: bubbly clots of the roller tumble down the face (local coords, scrolled)
    float sd = fract(e1.z) * 31.0;
    vec2 uvR = vec2(a, b - 1.4 * max(tau, 0.0)) / (uFoamTile * 0.2) + sd;
    vec4 fr = textureGrad(uFoam, uvR, lX / (uFoamTile * 0.2), lY / (uFoamTile * 0.2));
    float bw = b + (c - 0.9) * tau; // ~world-fixed coordinate across the crest (sheet drifts ~0.9 m/s)
    vec4 fs = textureGrad(uFoam, vec2(a, bw) / (uFoamTile * 0.28) + sd + 0.37, lX / (uFoamTile * 0.28), lY / (uFoamTile * 0.28));
    // holes of the aged mass torn into streaks along the drift (3:1, sheared, domain-warped)
    float wA = 1.2 * (macroNoise(vec2(a / 4.0, bw / 5.0) + sd) - 0.5);
    mat2 m2 = mat2(1.0, 0.0, 0.22, 0.33); // (a, bw) -> (a + 0.22 bw, 0.33 bw)
#ifdef OCEAN_LQ
    vec4 fs2 = fs;
#else
    vec4 fs2 = textureGrad(uFoam, m2 * vec2(a + wA, bw) / (uFoamTile * 0.5) + sd + 0.71, m2 * lX / (uFoamTile * 0.5), m2 * lY / (uFoamTile * 0.5));
#endif
    float txR = 0.5 * fr.r + 0.3 * fr.g + 0.2 * fr.b;
    float txS = 0.45 * fs.r + 0.25 * fs2.a + 0.3 * fs.g;
    float ragA = (macroNoise(vec2(b / 2.0 + sd, a / 1.5)) - 0.5) * 2.5; // ragged section ends
    float sec = nbkSec(a + ragA, e1, tau, soft);
    float ws = e1.w;
    // spilling feather at the crest just before / at the break
    float feat = smoothstep(-1.8, -0.2, tau) * (1.0 - smoothstep(0.2, 1.0, tau)) * exp(-(b / 1.1) * (b / 1.1)) * sec * ws;
    // whitewater curtain running down the face from the pitching lip; it reaches furthest down at the
    // peak of the section (rounded / peaked outline, not a straight-edged slab)
    float Lc = e1.x * (0.3 + 0.7 * smoothstep(-0.3, 3.0, tau)) + 1.5;
    float aq = (a + 0.6 * ragA - e1.y) / Lc;
    float pk = exp(-1.2 * aq * aq);
    float reach = 0.9 * smoothstep(-0.3, 1.5, tau) * (1.0 - 0.55 * smoothstep(1.5, dur + 1.0, tau)) * (0.3 + 0.7 * pk);
    float tw = 0.12 + 0.6 * fpM / wf;
    float wallZ = smoothstep(1.0 - reach - tw, 1.0 - reach + tw, hf + 0.35 * (txR - 0.5)) * smoothstep(-0.8, -0.2, b);
    float life = 1.0 - smoothstep(0.3 * dur + 0.6, 0.55 * dur + 1.6, tau);
    float wall = wallZ * sec * ws * smoothstep(-0.4, 0.6, tau) * life;
    // tumbling roller / bore mass behind the crest: widens as the broken crest runs on (the foam
    // made at the break is left behind at ~c - 0.9 m/s); dense at the front, torn at the back
    float rb = 1.8 + 1.1 * min(max(tau, 0.0), 4.5);
    float rol = sec * ws * smoothstep(-0.2, 0.5, tau) * exp(-max(tau - 1.5, 0.0) / dur)
              * smoothstep(-rb - 2.0, -0.35 * rb, b + 2.2 * (txR - 0.5)) * smoothstep(0.9 + fpM, 0.1 - fpM, b);
    // aerated sheet left behind: foam made at the crest (age = -b / (c - 0.9)) as long as it broke
    float age = max(-b, 0.0) / max(c - 0.9, 1.0);
    float made = smoothstep(0.0, 0.8, tau + 1.5 * ws - age) * smoothstep(1.0, -1.5, b); // (spilling from ~1.5 s before the break)
    float secS = nbkSec(a + ragA * 1.6, e1, tau - age, soft * 1.6 + 1.0);
    float sheet = made * secS * ws * (1.3 * exp(-age / 2.2) + 0.3 * exp(-age / 6.0));
    // coverage: dense cores, torn edges (thresholded against the texture; soft >= pixel footprint)
    float aa = clamp(fpM / 0.25, 0.0, 1.0);
    float thW = 0.12 + 0.15 * aa;
    float wr = max(wall, rol);
    float covW = smoothstep(0.35 - thW, 0.35 + thW, wr * 0.9 + 0.35 * (txR - 0.5) + 0.1);
    covW = min(covW, wr * 3.0);
    float covF = smoothstep(0.2, 0.6, feat + 0.4 * (txR - 0.5)) * 0.9;
    float freshS = exp(-age / 3.5) * made * secS;
    float covS = smoothstep(0.62 - sheet * 0.55 - thW, 0.62 - sheet * 0.55 + thW, txS) * smoothstep(0.02, 0.2, sheet);
    covS = max(covS, smoothstep(0.12 - thW, 0.12 + thW, txS + 0.4 * freshS - 0.2) * smoothstep(0.1, 0.4, freshS * ws));
    // the bore mass behind the crest: the foam of the broken crest left behind it (longer than the
    // raised vertex plateau: ~30 m by tau 3.5); dense, its back torn into streaks along the drift
    float tbm = min(max(tau + 0.5, 0.0), 5.0);
    float mExt = max(c - 0.9, 2.0) * 1.6 * tbm + 2.5;
    float secB = nbkSec(a + 1.4 * ragA, e1, tau, soft * 1.5 + 0.12 * max(-b, 0.0)); // (the mass spreads along the crest as it ages)
    float massF = smoothstep(-0.2, 0.8, tau) * secB * ws * exp(-max(tau - 2.5, 0.0) / (dur + 2.0))
                * smoothstep(-1.05 * mExt, -0.25 * mExt, b + 4.0 * (txS - 0.5) + 3.0 * wA) * smoothstep(0.9 + fpM, 0.1 - fpM, b);
    float covM = smoothstep(0.24 - thW, 0.24 + thW, massF + 0.45 * (txS - 0.5));
    float holes = smoothstep(0.12 - 0.5 * thW, 0.34 + 0.5 * thW, 0.55 * txS + 0.45 * fs2.g);
    float backM = smoothstep(-0.45 * mExt, -0.8 * mExt, b);   // holes only in the older back of the mass
    covM *= mix(1.0, holes, backM);
    float cov = max(max(max(covW, covF), covS * 0.95), covM);
    if (cov > 0.0) {
      // curtain streaks running down the face (streak channel, u along the fall line; warped and
      // modulated so they never line up into a comb)
      float stA = smoothstep(0.3, 0.7, macroNoise(vec2(a / 5.0, 0.4 * tau) + sd * 0.7));
      vec2 uvC = vec2(b * 0.8 - 2.2 * max(tau, 0.0), a + 2.0 * wA) / (uFoamTile * 0.22) + sd + 0.13;
      vec2 cX = vec2(lX.y * 0.8, lX.x) / (uFoamTile * 0.22), cY = vec2(lY.y * 0.8, lY.x) / (uFoamTile * 0.22);
#ifdef OCEAN_LQ
      float strk = 0.5;
#else
      float strk = mix(0.5, textureGrad(uFoam, uvC, cX, cY).a, stA);
#endif
      vec3 n = normalize(vec3(-g.x, 1.0, -g.y));
      float sunF = dot(n, L);
      float lit = smoothstep(-0.1, 0.35, sunF);
      // tumbling clots: bright lumps of sky-lit foam separated by self-shadowed, darker folds; a 2-4 m
      // modulation makes the lumps larger and fewer
      float clotM = macroNoise(vec2(a / 3.0, bw / 2.6) + sd * 2.1);
      float clot = 0.62 * txR + 0.08 * strk + 0.3 * mix(0.5, macroNoise(vec2(a / 1.3, bw / 1.1) + sd), 1.0 - smoothstep(0.3, 0.8, fpM / 1.1));
      clot = clamp(clot + 0.3 * (clotM - 0.5), 0.0, 1.0);
      // regions (measured, ref 9.0 / 12.5 s): the thin lower curtain on the front face glows cream (the
      // low sun shines through it: a crescent along the front rim); the top of the roller and the mass
      // behind are sky-lit blue-white with brighter clots and darker folds; the older sheet is lace
      float faceW = smoothstep(-0.9, 0.3, b);
      float creamW = faceW * smoothstep(0.985, 0.8, hf + 0.15 * (txR - 0.5)) * (0.5 + 0.5 * pk)
                   * (1.0 - smoothstep(0.6 * dur, dur + 0.5, tau))
                   * smoothstep(0.12, 0.45, 0.85 * txR + 0.15 * strk)
                   * mix(1.0, smoothstep(0.25, 0.65, macroNoise(vec2(a / 3.5, 0.3 * tau) + sd * 1.7)), 0.7 * smoothstep(1.0, 3.0, tau) * smoothstep(3.0, 7.0, e1.x));
      // hot core: where the curtain is thinnest and freshest (lower curtain at the peak of the section)
      float coreW = smoothstep(0.55, 0.9, pk) * smoothstep(-0.3, 0.3, tau) * (1.0 - smoothstep(0.9, 2.0, tau)) * smoothstep(0.9, 0.55, hf);
      vec3 cFace = mix(NB_LIT * mix(0.8, 1.0, lit), NB_CORE, clamp(coreW * (0.6 + 0.8 * txR), 0.0, 1.0));
      vec3 cLow = mix(NB_BW, NB_TOP, smoothstep(0.4, 0.8, clot) * 0.6);
      cLow = mix(cLow, NB_FOLD, smoothstep(0.42, 0.18, clot) * 0.75);
      vec3 cFaceAll = mix(cLow, cFace, creamW);
      vec3 cTop = mix(NB_BW, NB_TOP * mix(0.9, 1.15, lit), smoothstep(0.35, 0.75, clot));
      cTop = mix(cTop, NB_FOLD, smoothstep(0.42, 0.15, clot) * 0.85);
      // inside the body: the gaps between the clots are shaded folds (darker), not holes
      cTop = mix(cTop, NB_FOLD, (1.0 - holes) * (1.0 - backM) * 0.55);
      float fresh = exp(-age / 3.5);
      vec3 cBack = mix(NB_SHADE, NB_SHEET, smoothstep(0.3, 0.7, txS));
      cBack = mix(cBack, NB_POCKET, smoothstep(0.4, 0.2, txS) * 0.6);
      cBack = mix(cBack, cTop, smoothstep(0.05, 0.4, fresh * ws));
      float topW = (1.0 - faceW) * smoothstep(-rb - 1.0, -0.3 * rb, b);
      vec3 cw = mix(mix(cBack, cTop, topW / max(1.0 - faceW, 1e-3)), cFaceAll, faceW);
      // after the curtain has gone the lit front of the rolling bore stays as a cream crescent
      float rimW = smoothstep(-1.8 - fpM, -0.5, b + 0.6 * (txR - 0.5)) * smoothstep(0.5 + fpM, -0.2, b) * (0.35 + 0.65 * pk)
                 * smoothstep(0.6, 1.6, tau) * (1.0 - smoothstep(dur, dur + 2.0, tau)) * smoothstep(0.3, 0.6, clot + 0.2 * lit) * smoothstep(1.5, 3.0, dur) * smoothstep(2.4, 3.4, H);
      cw = mix(cw, NB_LIT * mix(0.75, 1.0, lit), 0.4 * rimW);
      vec3 ce = mix(cBack, cTop, smoothstep(0.1, 0.6, covM / max(cov, 1e-3)));
      ce = mix(ce, cw, smoothstep(0.1, 0.6, max(covW, covF) / max(cov, 1e-3)));
      o.col = o.col * (1.0 - cov) + ce * cov; // premultiplied 'over'
      o.cov = 1.0 - (1.0 - o.cov) * (1.0 - cov);
    }
    // ---- spray veil thrown up and back by the pitching lip: backlit, see-through, soft (never
    // thresholded). A plume over the broken section (narrowing and leaning back with height), its
    // density integrated along the view ray: the point of the ray h m above the water lies at
    // (a, b) - (dadh, dbdh) h in the crest frame (4 samples)
    float mT = smoothstep(-0.8, 0.2, tau) * (1.0 - smoothstep(1.5, 3.8, tau)) * smoothstep(1.0, 2.2, H)
             * (1.0 - smoothstep(0.4 * dur + 0.5, 0.6 * dur + 1.5, tau)); // (short-lived pieces: no lasting plume)
    if (mT > 0.0) {
      float dbR = dot(away, fwd) * kH, daR = dot(away, aDir) * kH;
      float Lm = e1.x * (0.3 + 0.7 * smoothstep(-0.3, 3.0, tau)) + 1.2;
      float acc = 0.0, hAcc = 0.0;
      for (int k = 0; k < 4; k++) {
        float hr = (float(k) + 0.5) * 0.25;
        float h = hr * hTop;
        vec2 q = vec2(a - daR * h, b - dbR * h);
        float wa = Lm * (1.0 - 0.6 * hr);
        float wbm = (1.0 + 0.35 * H) * (1.0 - 0.5 * hr);
        float b0 = -0.7 - 0.35 * h;
        float wsp = macroNoise(vec2(q.x / 2.2, h / 1.1 - 0.9 * tau) + sd * 1.3);
        float qb = (q.y - b0) / wbm;
        float d = exp(-qb * qb) * smoothstep(wa + soft, wa - 0.5 * soft, abs(q.x - e1.y + 1.5 * (wsp - 0.5)))
                * pow(1.0 - hr, 1.5) * (0.3 + 1.0 * wsp);
        acc += d; hAcc += d * hr;
      }
      float mist = 0.92 * (1.0 - exp(-1.1 * acc * mT * ws * envA));
      float hMean = hAcc / max(acc, 1e-4);
      // lit through near the lip (cream), a white veil above
      vec3 cm = mix(NB_LIT * 0.85, NB_MIST, smoothstep(0.25, 0.7, hMean));
      cm = mix(cm, NB_TOP, 0.5 * smoothstep(0.45, 0.8, hMean));
      o.col = o.col * (1.0 - mist) + cm * mist;
      o.cov = 1.0 - (1.0 - o.cov) * (1.0 - mist);
    }
    // translucent turquoise face: the thin, steep front face below the whitewater, from the shoaling
    // hump through the break (darker toward the trough)
    float face = smoothstep(-0.3 - fpM, 0.3 + fpM, b) * smoothstep(0.06, 0.35, hf) * (1.0 - 0.4 * smoothstep(0.9, 1.0, hf))
               * smoothstep(-5.0, -1.5, tau) * (1.0 - smoothstep(2.5, 5.0, tau)) * envA * smoothstep(0.6, 1.6, H)
               * (0.55 + 0.45 * hf);
    o.trans = max(o.trans, face * (1.0 - cov));
    o.aer = max(o.aer, made * secS * exp(-age / 8.0) * ws);
  }
  o.col /= max(o.cov, 1e-4);
  return o;
}
`;
