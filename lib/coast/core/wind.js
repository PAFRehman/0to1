// Shared wind model. One deterministic gust signal drives vegetation sway, grass,
// foam streaks and the wind/rustle audio so that sound and picture move together.
import { CONFIG } from '../config.js';
import { hash2 } from './rng.js';

// 1D smooth value noise in [-1,1] whose lattice wraps every `period` cells, so a noise evaluated at
// x = t * period / LOOP + offset repeats exactly every LOOP seconds.
export const WIND_LOOP = 3600; // s (a multiple of every other loop period: 60 s sway, 180 s camera, 1200 s ocean)
function pnoise1(x, period, seed) {
  const i = Math.floor(x), f = x - i;
  const u = f * f * (3 - 2 * f);
  const i0 = ((i % period) + period) % period, i1 = (i0 + 1) % period;
  const a = hash2(i0, seed) * 2 - 1, b = hash2(i1, seed) * 2 - 1;
  return a + (b - a) * u;
}

const dir = CONFIG.wind.direction;
const len = Math.hypot(dir[0], dir[1]);
export const WIND_DIR = [dir[0] / len, dir[1] / len]; // xz, direction the air moves toward

// Gust multiplier (~0.5..1.5, mean 1) at time t (seconds), measured from the reference:
// motion energy of the crowns has p90/p10 ~1.66 and max/min ~2.4 on a 0.5 s envelope with
// gust periods of 5-10 s (analysis/vegetation.md section 3). Vegetation sway amplitude goes
// with gustMul^2, needle flutter with gustMul^1.5. Periodic over WIND_LOOP (3600 s, so the gust
// sequence never audibly repeats): lattice rates 396, 1320 and 4680 cells per hour
// (0.11, 0.367, 1.3 Hz: gust periods of ~5-10 s plus buffeting).
export function gustMulAt(t) {
  const g = 1 + 0.30 * pnoise1(t * 396 / 3600, 396, 11) + 0.15 * pnoise1(t * 1320 / 3600 + 17, 1320, 23) + 0.06 * pnoise1(t * 4680 / 3600 + 41, 4680, 37);
  return Math.max(0.25, g);
}

// Gust strength in [0,1] at time t (seconds): gustMulAt() remapped (0.45..1.55 -> 0..1), mean ~0.5.
export function gustAt(t) {
  return Math.min(1, Math.max(0, (gustMulAt(t) - 0.45) / 1.1));
}

// Wind speed in m/s at time t.
export function windSpeedAt(t) {
  const g = gustAt(t);
  return CONFIG.wind.speed * (1 - CONFIG.wind.gustiness * 0.5 + CONFIG.wind.gustiness * g);
}

// GLSL helpers; uniforms uWindDir (vec2), uGust (float), uWindSpeed (float), uWindAdv (float) and
// uTime (float) are provided by ctx.uniforms and must be declared by the including shader via
// WIND_UNIFORMS_GLSL (uTime separately). uWindAdv = (CONFIG.wind.speed * t) % WIND_ADV_WRAP: the
// mean-speed advection distance, wrapped so it stays small and never jumps with the gusting speed.
export const WIND_ADV_WRAP = 2000; // m (must match main.js)
export const WIND_UNIFORMS_GLSL = /* glsl */ `
uniform vec2 uWindDir;
uniform float uGust;
uniform float uWindSpeed;
uniform float uWindAdv;
`;

// Travelling gust field: spatially varying multiplier (~0.4..1.6) that moves downwind at the mean
// wind speed, so neighbouring plants do not move in perfect unison. The noise lives in wind-aligned
// coordinates (along, across) and its lattice wraps along the wind every WIND_ADV_WRAP metres
// (0.035 * 2000 = 70 and 0.11 * 2000 = 220 cells), so the uWindAdv wrap is seamless and the input
// stays bounded however long the page runs.
export const WIND_FIELD_GLSL = /* glsl */ `
float windHash(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
// integer lattice index wrapped into [0, per): the +0.5 keeps the division away from integer
// boundaries, so the wrap is exact on every GPU (plain mod() may return per instead of 0)
float windWrap(float i, float per){ return i - per * floor((i + 0.5) / per); }
float windNoiseP(vec2 p, float per){ vec2 i=floor(p), f=fract(p); vec2 u=f*f*(3.0-2.0*f);
  float x0 = windWrap(i.x, per), x1 = windWrap(i.x + 1.0, per);
  return mix(mix(windHash(vec2(x0, i.y)), windHash(vec2(x1, i.y)), u.x), mix(windHash(vec2(x0, i.y + 1.0)), windHash(vec2(x1, i.y + 1.0)), u.x), u.y); }
float windField(vec2 xz){
  vec2 q = vec2(dot(xz, uWindDir), dot(xz, vec2(-uWindDir.y, uWindDir.x)));
  q.x -= uWindAdv;                                    // advect with the (mean) wind
  float n = windNoiseP(q * 0.035, ${(WIND_ADV_WRAP * 0.035).toFixed(1)}) * 0.65 + windNoiseP(q * 0.11 + 7.1, ${(WIND_ADV_WRAP * 0.11).toFixed(1)}) * 0.35;
  return (0.45 + 1.1 * n) * (0.35 + 0.9 * uGust);
}
float windField(vec2 xz, float t){ return windField(xz); } // legacy signature (advection comes from uWindAdv)
`;

// Bit-exact GLSL port of gustMulAt()/gustAt() (uses rng.js hash2 + noise1) so shaders can evaluate
// the gust at a *delayed* time: gusts roll through the scene downwind at ~7 m/s, e.g.
//   float G = gustMulAt(uTime - dot(worldPos.xz, uWindDir) / GUST_ADVECTION);
export const GUST_ADVECTION = 7.0; // m/s, measured (left clump -> crown B -> crown C)
export const GUST_GLSL = /* glsl */ `
float gHash2(int x, int y){
  uint h = uint(x) * 374761393u + uint(y) * 668265263u;
  h = (h ^ (h >> 13u)) * 1274126177u;
  h = h ^ (h >> 16u);
  return float(h) * (1.0 / 4294967296.0);
}
float gNoise1(float x, float period, int seed){
  float i = floor(x); float f = x - i; float u = f * f * (3.0 - 2.0 * f);
  float i0 = mod(i, period);
  float i1 = mod(i0 + 1.0, period);
  float a = gHash2(int(i0 + 0.5), seed) * 2.0 - 1.0, b = gHash2(int(i1 + 0.5), seed) * 2.0 - 1.0;
  return a + (b - a) * u;
}
float gustMulAt(float t){
  return max(0.25, 1.0 + 0.30 * gNoise1(t * (396.0 / 3600.0), 396.0, 11) + 0.15 * gNoise1(t * (1320.0 / 3600.0) + 17.0, 1320.0, 23) + 0.06 * gNoise1(t * (4680.0 / 3600.0) + 41.0, 4680.0, 37));
}
float gustAtGL(float t){ return clamp((gustMulAt(t) - 0.45) / 1.1, 0.0, 1.0); }
`;
