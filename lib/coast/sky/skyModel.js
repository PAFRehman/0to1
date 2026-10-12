// Shared analytic sky radiance (no clouds). Used by the sky dome, the environment bake, ocean
// reflections and the aerial perspective (airlight).
// Owned by the sky module.
//
// Include SKY_GLSL in a fragment shader and call skyRadiance(dir) (dir = world-space view
// direction, need not be normalised). Output is linear HDR radiance (~0.3..6 per channel, the
// bright warm horizon on the sun side is the maximum) calibrated so that the post tone map
// (ACES fitted, exposure 1) reproduces the reference video's sky.
//
// Model (analysis/sky_light.md section 1, measured on the reference, RMS ~4/3/3 levels):
//   display-linear colour = mix(ANTI(eh), SUN(eh), w)
//     eh = elevation above the visible sea horizon (deg; the horizon dips 0.19 deg at 35 m),
//     w  = clamp((az + 9) / 38, 0, 1.08) with az the azimuth relative to the camera forward axis
//          (deg, + right). Off screen the sky is mirrored about the real sun's vertical plane
//          (az_eq = sunAz - |az - sunAz|), so it is brightest around the sun (az 60 deg) and the
//          anti-sun side (everything behind the camera) takes the cool anti-side profile.
//   HDR radiance = inverse ACES-fitted tone map of that display colour (a 3x3 matrix, a per
//   channel quadratic and another 3x3 matrix), so that after the post tone map the sky matches.
//   Plus a Mie aureole around the (off-frame) sun that only the environment map / reflections see.
// The ANTI/SUN profiles are monotone-cubic resampled from the measured anchors onto a grid
// uniform in sqrt(eh) (dense near the horizon: grey marine band in the first ~1.5 deg).
//
// For compatibility SKY_GLSL still declares uSkyZenith / uSkyHorizon (unused here). It does NOT
// declare uSunDir so it can be combined with ATMOSPHERE_GLSL: the static sun is baked in.
// SKY_CORE_GLSL is the same function without any uniform declarations (used by the atmosphere).
import { CONFIG } from '../config.js';

const f = (v) => (Number.isInteger(v) ? v.toFixed(1) : String(+v.toFixed(5)));
const v3 = (a) => `vec3(${a.map(f).join(', ')})`;

const sunD = CONFIG.sun.direction;
const SUN = sunD.map((x) => x / Math.hypot(sunD[0], sunD[1], sunD[2]));
const SUN_AZ = CONFIG.sun.azimuthDeg;

// Measured anchors (sRGB 8 bit): elevation above the sea horizon (deg) -> colour.
// el <= 7.5 measured at t = 0.5; 9.5-10 measured at t = 13.5 (camera tilted up); above that
// extrapolated. Round 2: 6.5-15 deg nudged bluer (anti side) / dimmer (sun side) against the
// full-render comparison at t = 0.5 and 9 (render too grey / warm 7-9 deg above the horizon); (only reflections / environment see it).
const ANTI = [
  [0.0, [157, 178, 179]], [0.75, [169, 188, 185]], [1.5, [180, 200, 194]], [2.5, [184, 207, 203]],
  [3.5, [185, 212, 210]], [4.5, [180, 216, 217]], [5.5, [174, 212, 220]], [6.5, [167, 211, 225]],
  [7.5, [161, 208, 228]], [10, [150, 202, 229]], [15, [143, 196, 230]], [30, [134, 182, 220]],
  [90, [118, 164, 210]],
];
const SUNSIDE = [
  [0.0, [249, 237, 205]], [0.75, [249, 238, 208]], [1.5, [248, 239, 212]], [2.5, [245, 240, 216]],
  [3.5, [245, 242, 222]], [4.5, [240, 240, 226]], [5.5, [238, 239, 227]], [6.5, [232, 239, 229]],
  [7.5, [222, 236, 231]], [9.5, [199, 225, 230]], [15, [184, 218, 235]], [30, [158, 199, 228]],
  [90, [124, 170, 212]],
];
const s2l = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };

// monotone cubic (Fritsch-Carlson) interpolation of one channel
function pchip(xs, ys) {
  const n = xs.length, d = [], m = new Array(n).fill(0);
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] * d[i] <= 0) m[i] = 0;
    else {
      const w1 = 2 * (xs[i + 1] - xs[i]) + (xs[i] - xs[i - 1]), w2 = (xs[i + 1] - xs[i]) + 2 * (xs[i] - xs[i - 1]);
      m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
    }
  }
  return (x) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0; while (x > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i], t = (x - xs[i]) / h, t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
  };
}
const NK = 32; // grid: eh = 90 * (u / NK)^2, u = 0..NK
function resample(tab) {
  const xs = tab.map((r) => r[0]);
  const fns = [0, 1, 2].map((ch) => pchip(xs, tab.map((r) => s2l(r[1][ch]))));
  const out = [];
  for (let u = 0; u <= NK; u++) { const eh = 90 * (u / NK) ** 2; out.push(fns.map((fn) => fn(eh))); }
  return out;
}
const KA = resample(ANTI), KS = resample(SUNSIDE);

export const SKY_PARAMS = { anti: ANTI, sunSide: SUNSIDE, sun: SUN, sunAz: SUN_AZ };

// JS mirror of the GLSL skyDisplay(w, ehDeg) (display-linear colour)
export function skyDisplayJS(w, ehDeg) {
  const u = Math.sqrt(Math.min(Math.max(ehDeg, 0), 90) / 90) * NK;
  const i = Math.min(Math.floor(u), NK - 1), t = u - i;
  return [0, 1, 2].map((c) => {
    const a = KA[i][c] + (KA[i + 1][c] - KA[i][c]) * t;
    const s = KS[i][c] + (KS[i + 1][c] - KS[i][c]) * t;
    return a + (s - a) * w;
  });
}
export const SKY_V3 = v3;

// Uniform-free core (constants + skyRadiance); ATMOSPHERE_GLSL includes this.
export const SKY_CORE_GLSL = /* glsl */ `
#ifndef SKY_MODEL_GLSL
#define SKY_MODEL_GLSL
const vec3 SKY_SUN_DIR = ${v3(SUN)};
const float SKY_SUN_AZ = ${f(SUN_AZ)};

// inverse of the post's ACES fitted curve (display-linear 0..~0.96 -> HDR scene-linear)
vec3 skyInvACES(vec3 o){
  const mat3 OUTI = mat3(0.64303825, 0.05926869, 0.00596190, 0.31118675, 0.93143649, 0.06392902, 0.04577546, 0.00929492, 0.93011838);
  const mat3 INI = mat3(1.76474097, -0.14702785, -0.03633683, -0.67577768, 1.16025151, -0.16243644, -0.08896329, -0.01322366, 1.19877327);
  vec3 y = OUTI * clamp(o, 0.0, 0.96);
  vec3 A = 1.0 - y * 0.983729;
  vec3 B = 0.0245786 - y * 0.4329510;
  vec3 C = -(0.000090537 + y * 0.238081);
  vec3 v = (-B + sqrt(max(B * B - 4.0 * A * C, 0.0))) / (2.0 * A);
  return max(INI * v, 0.0);
}

// Display-linear sky colour (pre inverse tone map) for the w parameter and elevation above the
// sea horizon. Piecewise-linear in u, written as a sum of clamped ramps (no dynamic array
// indexing, which is slow on some GPUs / ANGLE / SwiftShader).
vec3 skyDisplay(float w, float ehDeg){
  float u = sqrt(clamp(ehDeg, 0.0, 90.0) / 90.0) * ${f(NK)};
  vec3 a = ${v3(KA[0])};
  vec3 s = ${v3(KS[0])};
${KA.slice(1).map((k, i) => `  { float t = clamp(u - ${f(i)}, 0.0, 1.0); a += ${v3(k.map((x, c) => x - KA[i][c]))} * t; s += ${v3(KS[i + 1].map((x, c) => x - KS[i][c]))} * t; }`).join('\n')}
  return mix(a, s, w);
}

// azimuth (deg, relative to the camera forward axis) mirrored about the sun's vertical plane
float skyAzEq(vec3 dir){
  float az = degrees(atan(dir.x, -dir.z));
  float d = abs(mod(az - SKY_SUN_AZ + 540.0, 360.0) - 180.0);
  return SKY_SUN_AZ - d;
}

// Clear-sky radiance for direction dir (linear HDR, pre tone map).
vec3 skyRadiance(vec3 dir){
  dir = normalize(dir);
  float azq = skyAzEq(dir);
  float w = clamp((azq + 9.0) / 38.0, 0.0, 1.08);
  float eh = degrees(asin(clamp(dir.y, -1.0, 1.0))) + 0.19;
  vec3 disp = skyDisplay(w, eh);
  // beyond az -25 deg (seen during the pan to the left, t 3-7 s) the anti-side sky brightens again
  disp *= mix(vec3(1.0), vec3(1.12, 1.1, 1.04), smoothstep(-24.0, -42.0, azq) * smoothstep(0.5, 3.0, eh));
  vec3 c = skyInvACES(disp);
  // aureole around the real (off-frame) sun: zero on screen (az <= 33 deg is >= 27 deg from it),
  // only the environment map / far reflections see it
  float mu = max(dot(dir, SKY_SUN_DIR), 0.0);
  c += vec3(1.0, 0.72, 0.42) * (pow(mu, 12.0) * 2.5 + pow(mu, 300.0) * 25.0) * step(-0.02, dir.y) * smoothstep(26.0, 42.0, azq);
  return c;
}
#endif
`;

export const SKY_GLSL = /* glsl */ `
#ifndef SKY_MODEL_UNIFORMS
#define SKY_MODEL_UNIFORMS
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizon;
#endif
${SKY_CORE_GLSL}
`;

// ------------------------------------------------------------------------------------------
// CPU mirror of skyRadiance (for irradiance / SH bakes) and a shared sky-irradiance helper.
const ACES_IN = [[0.59719, 0.35458, 0.04823], [0.07600, 0.90834, 0.01566], [0.02840, 0.13383, 0.83777]];
const ACES_OUT = [[1.60475, -0.53108, -0.07367], [-0.10208, 1.10813, -0.00605], [-0.00327, -0.07276, 1.07602]];
function inv3(m) {
  const [a, b, c] = m[0], [d, e, g] = m[1], [h, i, k] = m[2];
  const A = e * k - g * i, B = -(d * k - g * h), C = d * i - e * h, det = a * A + b * B + c * C;
  return [[A / det, -(b * k - c * i) / det, (b * g - c * e) / det], [B / det, (a * k - c * h) / det, -(a * g - c * d) / det], [C / det, -(a * i - b * h) / det, (a * e - b * d) / det]];
}
const OUTI = inv3(ACES_OUT), INI = inv3(ACES_IN);
const mv = (m, v) => m.map((r) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);
export function skyInvACESJS(o) {
  const y = mv(OUTI, o.map((x) => Math.min(Math.max(x, 0), 0.96)));
  const v = y.map((q) => {
    const A = 1 - q * 0.983729, B = 0.0245786 - q * 0.4329510, C = -(0.000090537 + q * 0.238081);
    return (-B + Math.sqrt(Math.max(B * B - 4 * A * C, 0))) / (2 * A);
  });
  return mv(INI, v).map((x) => Math.max(x, 0));
}
export function skyRadianceJS(d) {
  const n = Math.hypot(d[0], d[1], d[2]);
  d = d.map((x) => x / n);
  const az = Math.atan2(d[0], -d[2]) * 180 / Math.PI;
  const azq = SUN_AZ - Math.abs(((az - SUN_AZ + 540) % 360) - 180);
  const w = Math.min(Math.max((azq + 9) / 38, 0), 1.08);
  const eh = Math.asin(Math.max(-1, Math.min(1, d[1]))) * 180 / Math.PI + 0.19;
  const sm = (a, b, x) => { const t = Math.min(Math.max((x - a) / (b - a), 0), 1); return t * t * (3 - 2 * t); };
  const k = sm(-24, -42, azq) * sm(0.5, 3, eh);
  const disp = skyDisplayJS(w, eh).map((x, c) => x * (1 + ([0.12, 0.1, 0.04][c]) * k));
  const col = skyInvACESJS(disp);
  const mu = Math.max(d[0] * SUN[0] + d[1] * SUN[1] + d[2] * SUN[2], 0);
  const g = (mu ** 12 * 2.5 + mu ** 300 * 25) * (d[1] >= -0.02 ? 1 : 0) * sm(26, 42, azq);
  return [col[0] + g, col[1] + 0.72 * g, col[2] + 0.42 * g];
}

// Environment lighting (what sky.js bakes into the PMREM): sky x ENV_WHITE_BALANCE above the
// horizon, fading to a grass/sea ground bounce below it.
// (phone-like white balance of the display-fitted sky toward the measured ambient colour
// (0.62, 0.80, 1.0), times 0.85 so that E_sun : E_sky(up) ~ 2.4 : 1 in G as measured)
export const ENV_WHITE_BALANCE = [1.23, 0.85, 0.56];
export const ENV_GROUND = [0.10, 0.11, 0.07];
export function envRadianceJS(d) {
  const n = Math.hypot(d[0], d[1], d[2]);
  const y = d[1] / n;
  const sky = skyRadianceJS(d).map((x, c) => x * ENV_WHITE_BALANCE[c]);
  if (y >= 0) return sky;
  const t = Math.min(Math.max(-y / 0.1, 0), 1), s = t * t * (3 - 2 * t);
  return sky.map((x, c) => x * 0.4 * (1 - s) + ENV_GROUND[c] * s);
}

// L2 spherical-harmonics irradiance of the environment (9 RGB coefficients, already convolved
// and divided by PI: skyIrradiance(n) = radiance leaving a white Lambertian surface lit by the
// sky + ground bounce, same units as albedo * uSunColor * NdotL).
function bakeSH() {
  const L = Array.from({ length: 9 }, () => [0, 0, 0]);
  const NT = 90, NP = 180;
  for (let i = 0; i < NT; i++) {
    const th = (i + 0.5) / NT * Math.PI;
    const st = Math.sin(th), ct = Math.cos(th);
    for (let j = 0; j < NP; j++) {
      const ph = (j + 0.5) / NP * 2 * Math.PI;
      const x = st * Math.cos(ph), z = st * Math.sin(ph), y = ct;
      const dw = st * (Math.PI / NT) * (2 * Math.PI / NP);
      const c = envRadianceJS([x, y, z]);
      const Y = [0.282095, 0.488603 * y, 0.488603 * z, 0.488603 * x, 1.092548 * x * y, 1.092548 * y * z,
        0.315392 * (3 * z * z - 1), 1.092548 * x * z, 0.546274 * (x * x - y * y)];
      for (let k = 0; k < 9; k++) for (let ch = 0; ch < 3; ch++) L[k][ch] += c[ch] * Y[k] * dw;
    }
  }
  const A = [Math.PI, 2 * Math.PI / 3, 2 * Math.PI / 3, 2 * Math.PI / 3, Math.PI / 4, Math.PI / 4, Math.PI / 4, Math.PI / 4, Math.PI / 4];
  return L.map((l, k) => l.map((v) => v * A[k] / Math.PI));
}
export const SKY_SH = bakeSH();

// GLSL: vec3 skyIrradiance(vec3 n) (world-space normal), no uniforms; matches scene.environment.
export const SKY_IRRADIANCE_GLSL = /* glsl */ `
#ifndef SKY_IRRADIANCE_GLSL
#define SKY_IRRADIANCE_GLSL
vec3 skyIrradiance(vec3 n){
  n = normalize(n);
  float x = n.x, y = n.y, z = n.z;
  return max(vec3(0.0),
      ${v3(SKY_SH[0])} * 0.282095
    + ${v3(SKY_SH[1])} * (0.488603 * y)
    + ${v3(SKY_SH[2])} * (0.488603 * z)
    + ${v3(SKY_SH[3])} * (0.488603 * x)
    + ${v3(SKY_SH[4])} * (1.092548 * x * y)
    + ${v3(SKY_SH[5])} * (1.092548 * y * z)
    + ${v3(SKY_SH[6])} * (0.315392 * (3.0 * z * z - 1.0))
    + ${v3(SKY_SH[7])} * (1.092548 * x * z)
    + ${v3(SKY_SH[8])} * (0.546274 * (x * x - y * y)));
}
#endif
`;
