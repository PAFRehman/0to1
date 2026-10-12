// Sky, clouds, sun & sky lighting, environment map, far-field sun shadow.
//
// - Clear sky: measured display-space model inverted through the post tone map (skyModel.js,
//   SKY_GLSL) on a camera-centred dome drawn AFTER the opaque geometry (xyww far plane, depth test)
//   so only visible sky pixels are shaded.
// - Clouds: small fair-weather cumulus / fractus. Each cloud is a little volume (union of
//   "puff" ellipsoids with per-puff squash, flat base, wind shear, eroded by 3D fbm plus a
//   high-frequency fringe erosion for ragged fractus edges, soft density ramp) that is ray-marched
//   ONCE at load with sun self-shadowing (+ a multiple-scattering approximation), an HG
//   forward/back phase and a height-dependent neutral-grey sky ambient, into a 360 deg
//   equirectangular band texture (elevation -3..21 deg, premultiplied linear radiance + alpha).
//   The key light is the real sun azimuth (60 deg, el 10 deg at cloud height): lit right flanks
//   with a peach forward-scatter edge, mauve-grey shaded left / under sides as in the reference.
//   The dome samples the band with a slow rigid azimuthal drift (measured 0.026-0.041 deg/s,
//   0.036 used), so the per-frame cost is one texture fetch; the band wraps around 360 deg, so
//   the drift loops forever (10000 s period). After the reference replay (t > 14 s) parts of the
//   clouds slowly thicken / fray and fade (value noise over the band x a periodic time lattice,
//   up to 45 %, ~1 min cycles), so the sky is never a rigid sprite. Clouds visible in the reference framing come from a
//   catalogue measured on the reference frame (pixel position/size/kind at t=0 with the base camera
//   pose, per-cloud density / sun scale); the rest of the band is seeded random clouds kept out
//   of the whole camera window (az -58..48, el < 14.5 deg).
// - Environment: PMREM of the sky + clouds, white-balanced / scaled toward the measured ambient
//   (skyModel ENV_WHITE_BALANCE, E_sun : E_sky(up) ~ 2.4 : 1) + a grass/sea ground bounce below
//   the horizon -> scene.environment and ctx.env. The same lighting as L2 SH: skyModel.js
//   SKY_IRRADIANCE_GLSL skyIrradiance(n) for custom shaders.
// - Lights: sun direction/colour from config.sun (DirectionalLight intensity = PI * sun.intensity
//   so three.js' BRDF (albedo/PI) matches custom shaders that use albedo * uSunColor * NdotL);
//   shadow frustum fitted to the foreground headland/trees box; weak hemisphere fill.
// - Far sun shadow (farShadow.js): static ortho depth map of the terrain from the sun, baked on the
//   first frame; ctx.uniforms.uFarShadow* + FAR_SHADOW_GLSL farSunVisibility(worldPos, normal).
import * as THREE from 'three';
import { SKY_GLSL, SKY_V3, ENV_WHITE_BALANCE, ENV_GROUND } from './skyModel.js';
import { mulberry32 } from '../core/rng.js';
import { dirFromAngles } from '../config.js';
import { createFarShadow, FAR_SHADOW_GLSL, FAR_SHADOW_BOX } from './farShadow.js';

const EL0 = -3 * Math.PI / 180; // cloud band elevation range (radians)
const EL1 = 21 * Math.PI / 180;
// measured 0.51-0.79 px/s (0.026-0.041 deg/s, faster for higher clouds); one rigid band speed
export const CLOUD_DRIFT = 0.036 * Math.PI / 180; // rad/s, +azimuth (to the right)

// Clouds visible in the reference frame r_0.0 (1276x718): centre px, size px, kind, seed, skew
// (profile tilt: >0 = taller on the right), density scale.
const CATALOG = [
  { px: [748, 27], sz: [142, 36], kind: 'cu', seed: 11, skew: 1.5, n: 12, dens: 0.8, shadeX: [-0.12, 0.26, 0.5], tail: 1.25, sun: 1.15 },  // A (C1) peach dome right, ragged tail left
  // B (C2): a translucent slate streak with 3-4 narrow white turrets (low parts thin: lowDens)
  { px: [592, 41], sz: [140, 26], kind: 'row', seed: 23, skew: -0.1, n: 12, dens: 1.0, sun: 0.55, bump: 0.3, lowDens: 0.8, sunRamp: [0.22, 0.62] },
  // C3 (C, D, E): softer, lower-contrast lavender fractus lumps than C1 (clip std 11.7 vs C1 20)
  { px: [572, 73], sz: [86, 25], kind: 'cu', seed: 37, skew: 0.5, n: 10, dens: 0.5, sun: 0.6, shadeX: [-0.25, 0.25, 0.6], bump: 0.55, lowDens: 0.6, ero: 1.05 },    // C (C3 left) fractus lump
  { px: [658, 73], sz: [96, 21], kind: 'cu', seed: 41, skew: 0.3, n: 11, dens: 0.48, sun: 0.62, shadeX: [-0.3, 0.1, 0.5], bump: 0.55, lowDens: 0.6, ero: 1.05 },    // D (C3 right) lit lumps, notch between C and D
  { px: [537, 84], sz: [66, 18], kind: 'cu', seed: 53, skew: 0.3, n: 9, dens: 0.35, sun: 0.55, bump: 0.5, lowDens: 0.6, ero: 1.05 },    // E
  { px: [866, 41], sz: [40, 17], kind: 'cu', seed: 67, skew: 0.3, n: 7, dens: 0.1, sun: 0.5, bump: 0.3 },    // F (C5) small soft puff
  { px: [935, 21], sz: [20, 26], kind: 'tower', seed: 71, skew: 0, n: 4, dens: 0.1, sun: 0.45 },   // G (C6) faint vertical wisp
  // tiny puffs (< 30 px): no sub-puffs, soft wispy density ramp, faint (clip H: 6-8 levels, no base line)
  { px: [808, 60], sz: [14, 8], kind: 'cu', seed: 83, skew: 0, n: 3, dens: 0.1, sun: 0.6, bump: 0, soft: 0.7 },       // H
  { px: [308, 73], sz: [30, 14], kind: 'cu', seed: 97, skew: 0.2, n: 4, dens: 0.4, sun: 0.25, bump: 0, soft: 0.5 },    // I
  { px: [72, 10], sz: [24, 8], kind: 'wisp', seed: 101, skew: 0, n: 4, dens: 0.6 },     // J
  { px: [393, 43], sz: [48, 7], kind: 'wisp', seed: 113, skew: 0, n: 6, dens: 0.6 },    // K
  { px: [300, 3], sz: [32, 9], kind: 'wisp', seed: 127, skew: 0, n: 4, dens: 0.6 },     // L
  { px: [155, 52], sz: [20, 10], kind: 'wisp', seed: 131, skew: 0, n: 3, dens: 0.5 },   // M
  { px: [378, 87], sz: [22, 6], kind: 'wisp', seed: 139, skew: 0, n: 4, dens: 0.5 },    // N
  { px: [440, 86], sz: [20, 5], kind: 'wisp', seed: 149, skew: 0, n: 3, dens: 0.5 },    // O
  { px: [345, 31], sz: [9, 8], kind: 'wisp', seed: 151, skew: 0, n: 2, dens: 0.5 },     // P
  { px: [1205, 5], sz: [28, 8], kind: 'wisp', seed: 157, skew: 0, n: 3, dens: 0.4 },    // Q
  { px: [1095, -13], sz: [30, 12], kind: 'cu', seed: 163, skew: 0.2, n: 6, dens: 0.8 },  // R (enters at t~10 s when the camera tilts up)
];

const MAXP = 12;

const BAKE_VERT = /* glsl */ `
uniform vec4 uAzEl;   // az0, az1, el0, el1 of this cloud's quad (rad)
uniform vec4 uCenter; // azc, elc, width (rad), 0
uniform vec2 uBand;   // EL0, EL1
varying vec2 vLocal;
void main(){
  float az = mix(uAzEl.x, uAzEl.y, position.x);
  float el = mix(uAzEl.z, uAzEl.w, position.y);
  vLocal = vec2((az - uCenter.x) / uCenter.z, (el - uCenter.y) / uCenter.z);
  float u = az / 6.28318530718 + 0.5;
  float v = (el - uBand.x) / (uBand.y - uBand.x);
  gl_Position = vec4(u * 2.0 - 1.0, v * 2.0 - 1.0, 0.0, 1.0);
}`;

const BAKE_FRAG = /* glsl */ `
precision highp float;
#define MAXP ${MAXP}
uniform vec4 uPuffs[MAXP];
uniform int uNP;
uniform vec4 uShape;   // base y, top y, erosion, noise frequency
uniform vec4 uShape2;  // sigma, wispiness, seed, x-stretch
uniform float uZr;     // half depth of the march box
uniform vec3 uSunL;    // sun direction in cloud-local frame (x right, y up, z toward viewer)
uniform float uPhase;
uniform vec3 uSunCol;
uniform vec3 uAmbTop;
uniform vec3 uAmbBot;
uniform float uLStep;
uniform float uSquash;
uniform float uPuffSq[MAXP]; // per-puff vertical squash (0 = use uSquash)
uniform float uSunScale;
uniform vec3 uShadeX; // x0, x1, strength: sun blocked on the left part of the cloud
uniform float uShear;
uniform float uBaseSun; // sun fraction reaching the flat base  // wind shear: upper parts displaced to the right (downwind)
uniform float uTail;   // >0: thin ragged tail on the left (fades out, low)
varying vec2 vLocal;

float hash13(vec3 p){ p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
float vnoise(vec3 p){
  vec3 i = floor(p); vec3 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  float a = hash13(i), b = hash13(i + vec3(1,0,0)), c = hash13(i + vec3(0,1,0)), d = hash13(i + vec3(1,1,0));
  float e = hash13(i + vec3(0,0,1)), g = hash13(i + vec3(1,0,1)), h = hash13(i + vec3(0,1,1)), k = hash13(i + vec3(1,1,1));
  return mix(mix(mix(a,b,f.x), mix(c,d,f.x), f.y), mix(mix(e,g,f.x), mix(h,k,f.x), f.y), f.z);
}
float fbm(vec3 p, int oct){
  float s = 0.0, a = 0.5, n = 0.0;
  for (int i = 0; i < 6; i++){
    if (i >= oct) break;
    float v = vnoise(p);
    s += a * mix(v, 1.0 - abs(2.0 * v - 1.0), 0.2); n += a; // part billow: rounded cauliflower lobes
    p = p * 2.07 + vec3(1.7, 9.2, 3.1); a *= 0.5;
  }
  return s / n;
}
// Worley F1 on a jittered grid: xyz = p - nearest feature point (cell units), w = distance.
// The feature points are the centres of the sub-puffs of the cauliflower surface.
vec3 hash33(vec3 p){ p = fract(p * vec3(0.1031, 0.1030, 0.0973)); p += dot(p, p.yxz + 33.33); return fract((p.xxy + p.yxx) * p.zyx); }
vec4 worley(vec3 p){
  vec3 i = floor(p), f = fract(p);
  float best = 9.0; vec3 bv = vec3(0.0);
  for (int z = -1; z <= 1; z++) for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++){
    vec3 o = vec3(float(x), float(y), float(z));
    vec3 r = o + 0.1 + 0.8 * hash33(i + o) - f;
    float d = dot(r, r);
    if (d < best){ best = d; bv = r; }
  }
  return vec4(-bv, sqrt(best));
}
float shapeField(vec3 p){
  float f = -10.0;
  for (int i = 0; i < MAXP; i++){
    if (i >= uNP) break;
    vec4 c = uPuffs[i];
    float sq = uPuffSq[i] > 0.0 ? uPuffSq[i] : uSquash;
    vec3 d = (p - c.xyz) / (c.w * vec3(1.0, sq, 1.0));
    f = max(f, 1.0 - dot(d, d));
  }
  return f;
}
vec3 gBumpN; float gBumpW; // sub-puff normal / weight of the last primary density() sample
uniform float uBump;    // cauliflower sub-puff amplitude (0 = off)
uniform float uLowDens; // density factor of the lower cloud (1 = uniform)
uniform vec2 uSunRamp;  // relative heights over which the sun fraction ramps from uBaseSun to 1
float density(vec3 p, int oct){
  // low-frequency warp: irregular, non-blobby silhouettes
  vec3 w = vec3(vnoise(p * 4.0 + uShape2.z), vnoise(p * 4.0 + uShape2.z + 17.3), vnoise(p * 4.0 + uShape2.z + 41.9)) - 0.5;
  p += w * vec3(0.1, 0.04, 0.1);
  p.x -= uShear * (p.y - uShape.x);
  float f = shapeField(p);
  float ero = uShape.z;
  if (f + ero < 0.0) return 0.0;
  vec3 q = p * uShape.w * vec3(1.0 / uShape2.w, 1.0, 1.0) + uShape2.z;
  float n = fbm(q, oct);
  // value-noise fbm has a small spread (~0.5 +- 0.15): stretch it so erosion really bites
  float d = f + ero * (n - 0.5) * 3.6 - ero * 0.22;
  // cauliflower: two scales of sub-puffs (Worley spheres) bulging out of the surface. Only in
  // the primary march (oct > 3); the light march sees the smooth field, the sub-puff shading is
  // analytic (normal of the nearest sub-sphere) in main().
  gBumpW = 0.0; gBumpN = vec3(0.0, 1.0, 0.0);
  if (uBump > 0.0 && oct > 3 && d > -0.6 && d < 0.7) {
    vec3 qb = p * uShape.w * 0.62 * vec3(1.0 / uShape2.w, 1.3, 1.0) + uShape2.z * 1.3;
    vec4 w1 = worley(qb);
    vec4 w2 = worley(qb * 2.1 + 5.1);
    float b = (0.62 - w1.w) * 0.85 + (0.6 - w2.w) * 0.12;
    // sub-puffs bulge on the upper cloud only: the clip's bodies / bases are smooth and soft
    float hb = (p.y - uShape.x) / max(uShape.y - uShape.x, 1e-3);
    float rim = (1.0 - smoothstep(0.05, 0.7, d)) * smoothstep(0.3, 0.6, hb);
    d += uBump * b * rim;
    gBumpN = normalize(normalize(w1.xyz) * 0.8 + normalize(w2.xyz) * 0.2);
    gBumpW = rim;
  }
  // ragged fringes: high-frequency erosion only near the boundary (fractus edges, gaps)
  if (oct > 2 && d < 0.5 && d > -0.35) {
    float n2 = fbm(q * vec3(2.2, 3.4, 3.1) + 7.7, 2);
    float rim = 1.0 - smoothstep(0.02, 0.5, d);
    // cumulus with sub-puffs: crisp sunlit upper lumps, ragged translucent fringes only low down
    if (uBump > 0.0) rim *= mix(1.0, 0.3, smoothstep(0.3, 0.75, (p.y - uShape.x) / max(uShape.y - uShape.x, 1e-3)));
    d += 0.9 * (n2 - 0.5) * 2.0 * rim;
    // second, finer erosion octave (~30 per cloud width): ragged holes and translucent fringes
    // along the rim instead of a smooth sausage outline
    float n3 = vnoise(q * vec3(2.6, 3.2, 2.6) * 2.5 + 3.3);
    d -= 0.35 * ero * smoothstep(0.35, 0.75, n3) * rim * 1.6;
  }
  // soft optical edges: density ramps over the outer ~20% of the cloud
  // (the outer ~30 % stays optically thin: translucent fringes, the sky shows through)
  // (cumulus with sub-puffs: a quicker ramp -> crisp sunlit cauliflower tops)
  float ramp = uBump > 0.0 ? 0.55 : 1.2;
  float dens = mix(pow(clamp(d / ramp, 0.0, 1.0), uBump > 0.0 ? 2.0 : 1.6), pow(clamp(d / 0.9, 0.0, 1.0), 1.2) * 0.5, uShape2.y);
  // optically thin lower cloud (C2's translucent slate streak under dense turrets)
  if (uLowDens < 1.0) dens *= mix(uLowDens, 1.0, smoothstep(0.2, 0.55, (p.y - uShape.x) / max(uShape.y - uShape.x, 1e-3)));
  // tail: the left part thins out and stays low
  if (uTail > 0.0) dens *= mix(1.0, 0.35 + 0.65 * smoothstep(-0.45, 0.0, p.x), uTail);
  // flat, slightly ragged base
  // (ragged and a little soft: the clip's bases are uneven grey-lavender, not a ruled line)
  float base = uShape.x + (n - 0.5) * 0.045 * (1.0 + 2.0 * uShape2.y);
  dens *= smoothstep(base - 0.006, base + 0.04, p.y);
  return dens;
}
void main(){
  const int N = 40;
  float ds = 2.0 * uZr / float(N);
  float jit = hash13(vec3(gl_FragCoord.xy, 7.0));
  float T = 1.0;
  vec3 col = vec3(0.0);
  float sig = uShape2.x;
  for (int i = 0; i < N; i++){
    float z = uZr - (float(i) + jit) * ds;
    vec3 p = vec3(vLocal, z);
    float d = density(p, 5);
    vec3 bn = gBumpN; float bw = gBumpW;
    if (d > 0.003){
      float od = 0.0;
      for (int j = 0; j < 6; j++){
        vec3 q = p + uSunL * (float(j) + 0.5) * uLStep;
        od += density(q, 3);
      }
      od *= uLStep * sig;
      float Ts = exp(-od) * 0.84 + exp(-od * 0.22) * 0.12 + exp(-od * 0.05) * 0.04;
      // local "powder" darkening for sun light entering dense regions near the view surface
      float powder = 1.0 - 0.25 * exp(-d * 10.0);
      float hf = clamp((p.y - uShape.x) / max(uShape.y - uShape.x, 1e-3), 0.0, 1.0);
      vec3 amb = mix(uAmbBot, uAmbTop, smoothstep(0.0, 1.0, hf));
      // darker bases and (optionally) a shadowed flank, as in the reference clouds
      float sunH = mix(uBaseSun, 1.0, smoothstep(uSunRamp.x, uSunRamp.y, hf));
      float sunX = 1.0 - uShadeX.z * (1.0 - smoothstep(uShadeX.x, uShadeX.y, p.x));
      // sub-puff shading: each bulge is lit on its sun side and shaded in the crevices; sky light
      // favours the upward-facing bulges
      float lam = clamp(dot(bn, uSunL) * 0.6 + 0.45, 0.0, 1.0);
      float sunB = mix(1.0, 0.22 + 1.25 * lam, 0.55 * bw);
      amb *= mix(1.0, 0.72 + 0.4 * (bn.y * 0.5 + 0.5), 0.6 * bw);
      vec3 S = uSunCol * (uPhase * uSunScale * sunH * sunX * sunB) * Ts * powder + amb;
      float st = exp(-sig * d * ds);
      col += T * (1.0 - st) * S;
      T *= st;
      if (T < 0.004) break;
    }
  }
  gl_FragColor = vec4(col, 1.0 - T);
}`;

const DOME_VERT = /* glsl */ `
varying vec3 vDir;
void main(){
  vDir = position;
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww;
}`;

const DOME_FRAG = /* glsl */ `
${SKY_GLSL}
uniform sampler2D uClouds;
uniform float uDrift;
uniform float uEnvMode;
uniform vec2 uBand;
uniform vec3 uGround;
uniform vec2 uCloudBlur; // texel offsets of the soft 5-tap cloud lookup (codec / lens softness)
uniform vec2 uLife;      // cloud evolution: time coordinate (lattice units, periodic mod 60), amplitude
varying vec3 vDir;
// slow cloud evolution: parts of the clouds thicken / fray and fade over ~1 min. Value noise over
// (azimuth, elevation) in the band's frame x time; the time lattice is periodic (mod 60 cells).
float lhash(vec3 i){ i.z = mod(i.z, 60.0); vec3 p = fract(i * vec3(0.1031, 0.1030, 0.0973)); p += dot(p, p.yzx + 33.33); return fract((p.x + p.y) * p.z); }
float lnoise(vec3 p){
  vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(lhash(i), lhash(i + vec3(1,0,0)), f.x), mix(lhash(i + vec3(0,1,0)), lhash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(lhash(i + vec3(0,0,1)), lhash(i + vec3(1,0,1)), f.x), mix(lhash(i + vec3(0,1,1)), lhash(i + vec3(1,1,1)), f.x), f.y), f.z);
}
void main(){
  vec3 dir = normalize(vDir);
  vec3 sky = skyRadiance(dir);
  float el = asin(clamp(dir.y, -1.0, 1.0));
  float az = atan(dir.x, -dir.z) - uDrift;
  vec2 uv = vec2(fract(az / 6.28318530718 + 0.5), (el - uBand.x) / (uBand.y - uBand.x));
  vec4 cl = vec4(0.0);
  if (uv.y > 0.0 && uv.y < 1.0) {
    // soft lookup: the clip's cloud outlines spread over ~3 px (lens + codec)
    cl = texture2D(uClouds, uv) * 0.36
       + (texture2D(uClouds, uv + vec2(uCloudBlur.x, 0.0)) + texture2D(uClouds, uv - vec2(uCloudBlur.x, 0.0))
        + texture2D(uClouds, uv + vec2(0.0, uCloudBlur.y)) + texture2D(uClouds, uv - vec2(0.0, uCloudBlur.y))) * 0.16;
    if (uLife.y > 0.0 && cl.a > 0.002) {
      // ~1.5 deg x 1 deg cells (clouds are 3-7 deg wide: parts evolve independently), 2 octaves
      vec3 lp = vec3(uv.x * 240.0, uv.y * 24.0, uLife.x);
      float n = lnoise(lp) * 0.65 + lnoise(lp * vec3(2.03, 2.03, 1.0) + vec3(17.1, 5.3, 31.0)) * 0.35;
      cl *= 1.0 - uLife.y * smoothstep(0.35, 0.8, n);
    }
  }
  // aerial perspective on the clouds: low (distant) clouds dissolve into the horizon haze
  float vis = 1.0 - exp(-max(el, 0.0) / 0.05);
  vec3 c = sky * (1.0 - cl.a) + mix(sky * cl.a, cl.rgb, vis);
  if (uEnvMode > 0.5) {
    // environment only: phone-like white balance of the sky light (the fitted sky colours are
    // display-referred; an unbalanced blue-sky IBL makes shaded land far too blue), and sea /
    // land below the horizon, fading from the hazy horizon colour
    const vec3 WB = ${SKY_V3(ENV_WHITE_BALANCE)};
    c *= WB;
    if (dir.y < 0.0) c = mix(sky * 0.4 * WB, uGround, smoothstep(0.0, 0.1, -dir.y));
  }
  gl_FragColor = vec4(c, 1.0);
}`;

function pxToAzEl(config, px, py, W = 1276, H = 718) {
  const cam = config.camera;
  const th = Math.tan((cam.vfovDeg * Math.PI) / 360);
  const x0 = ((px + 0.5) / W * 2 - 1) * th * (W / H);
  const y0 = (1 - (py + 0.5) / H * 2) * th;
  // base camera roll (three.js YXZ: roll is applied first, in camera space)
  const rr = ((cam.rollDeg || 0) * Math.PI) / 180;
  const x = x0 * Math.cos(rr) - y0 * Math.sin(rr);
  const y = x0 * Math.sin(rr) + y0 * Math.cos(rr);
  const z = -1;
  const p = (cam.pitchDeg * Math.PI) / 180;
  const Y = y * Math.cos(p) - z * Math.sin(p);
  const Z = y * Math.sin(p) + z * Math.cos(p);
  const n = Math.hypot(x, Y, Z);
  const yaw = ((cam.yawDeg || 0) * Math.PI) / 180;
  return { az: Math.atan2(x / n, -Z / n) - yaw, el: Math.asin(Y / n) };
}

function buildCloud(def, rand) {
  // returns local puffs (width = 1), base/top, erosion etc.
  const a = def.aspect;
  const puffs = [];
  const base = -a / 2;
  const n = Math.min(MAXP, def.n);
  if (def.kind === 'wisp') {
    for (let i = 0; i < n; i++) {
      const t = n === 1 ? 0.5 : i / (n - 1);
      const x = (t - 0.5) * 0.62 + (rand() - 0.5) * 0.08;
      const r = Math.max(a * 0.9, 0.12) * (0.75 + 0.5 * rand()) * (1 - 0.5 * Math.abs(2 * x));
      puffs.push([x, (rand() - 0.5) * a * 0.4, (rand() - 0.5) * 0.1, r]);
    }
  } else if (def.kind === 'row') {
    // a thin flat dark streak with 3-4 separated turrets standing on it (reference cloud C2)
    const nb = 5;
    for (let i = 0; i < nb; i++) {
      const t = (i + 0.5) / nb;
      const r = 0.2 + 0.04 * rand();
      puffs.push([(t - 0.5) * 0.78 + (rand() - 0.5) * 0.04, base + r * 0.34 * 0.45, (rand() - 0.5) * 0.08, r, 0.34]); // (slate streak, clip ~10 px)
    }
    const nt = Math.min(MAXP - nb, 4 + (rand() < 0.5 ? 0 : 1));
    for (let i = 0; i < nt; i++) {
      const t = (i + 0.5) / nt;
      const x = (t - 0.5) * 0.82 + (rand() - 0.5) * 0.06;
      // narrow, tall turrets (clip: ~15 px wide white columns on a ~8 px streak)
      const h = 0.8 + 0.4 * rand();
      const rv = a * (0.18 + 0.07 * rand());
      puffs.push([x, base + a * 0.3 + a * 0.38 * h, (rand() - 0.5) * 0.1, rv / 0.55, 1.4]);
    }
  } else if (def.kind === 'tower') {
    for (let i = 0; i < n; i++) {
      const t = n === 1 ? 0.5 : i / (n - 1);
      const r = 0.34 * (1 - 0.35 * t) * (0.85 + 0.3 * rand());
      puffs.push([(rand() - 0.5) * 0.25 + t * 0.12, base + r * 0.5 + t * (a - r * 1.2), (rand() - 0.5) * 0.1, r]);
    }
  } else {
    // flat-based body (a few wide, low puffs) + turrets of varying height on top
    const sq = 0.55;
    const nb = Math.max(2, Math.round(n * 0.35));
    for (let i = 0; i < nb; i++) {
      const t = (i + 0.5) / nb;
      const x = (t - 0.5) * 0.74 + (rand() - 0.5) * 0.05;
      const rv = a * (0.3 + 0.1 * rand());
      puffs.push([x, base + rv * 0.4, (rand() - 0.5) * 0.1, (rv / sq) * 1.5]);
    }
    for (let i = 0; i < n - nb; i++) {
      const x = (rand() - 0.5) * 0.92;
      let prof = 1 - 0.7 * (2 * x) * (2 * x) + def.skew * 2 * x;
      prof = Math.min(1.25, Math.max(0.25, prof));
      const rv = a * 0.24 * (0.7 + 0.6 * rand()) * Math.sqrt(prof);
      const y = base + a * 0.25 + a * 0.55 * prof * (0.5 + 0.5 * rand());
      puffs.push([x, Math.min(y, base + a - rv * 0.9), (rand() - 0.5) * 0.12, rv / sq]);
    }
  }
  const squash = def.kind === 'cu' || def.kind === 'row' ? 0.55 : def.kind === 'wisp' ? 0.5 : 1.0;
  let top = base, zr = 0.05, xmin = 1, xmax = -1;
  for (const p of puffs) {
    top = Math.max(top, p[1] + p[3] * (p[4] || squash));
    zr = Math.max(zr, Math.abs(p[2]) + p[3]);
    xmin = Math.min(xmin, p[0] - p[3]);
    xmax = Math.max(xmax, p[0] + p[3]);
  }
  const wisp = def.kind === 'wisp';
  // strips break up into lumps and gaps (the clip's C3 group: separate fractus lumps, def.ero)
  const ero = def.ero ?? (def.kind === 'row' ? 0.95 : 0.88);
  const margin = ero * 0.4 * Math.max(...puffs.map((p) => p[3]));
  return {
    puffs,
    base: wisp ? base - a : base,
    top,
    // margins cover the erosion and the low-frequency warp (0.1 x, 0.04 y, 0.1 z) in density()
    zr: zr + margin + 0.06,
    box: [xmin - margin - 0.06, xmax + margin + 0.06 + 0.3 * Math.max(top - base, 0.1), (wisp ? base - a * 0.5 : base) - 0.035, top + margin + 0.03],
    ero,
    freq: 12.0,
    stretch: wisp ? 4.5 : def.kind === 'row' ? 1.6 : 1.3,
    // (cumuliform: optically thinner bodies — the clip's grey bodies are translucent, the sky shows
    // through; the dense sub-puff lumps stay opaque, see the density contrast in density())
    sigma: (wisp ? 8 : 12) * def.dens,
    wisp: wisp ? 1 : 0,
    squash,
  };
}

export default async function create(ctx) {
  const { renderer, scene, uniforms, config, quality, sunLight, hemiLight } = ctx;
  ctx.progress(0.05, 'Sky and light');

  // ---------------------------------------------------------------- cloud list
  const rand = mulberry32(90210);
  const defs = [];
  const degPx = 66 / 1276; // approx angular size of a reference pixel
  for (const c of CATALOG) {
    const { az, el } = pxToAzEl(config, c.px[0], c.px[1]);
    const w = c.sz[0] * degPx * Math.PI / 180;
    const h = c.sz[1] * (40.15 / 718) * Math.PI / 180;
    defs.push({ ...c, az, el, w, aspect: h / w });
  }
  // seeded fill: everywhere outside the reference window, and above the frame top
  const fill = quality.tier === 'low' ? 45 : 90;
  for (let i = 0; i < fill; i++) {
    const az = (rand() * 2 - 1) * Math.PI;
    const el = (1.2 + Math.pow(rand(), 1.6) * 14) * Math.PI / 180;
    const size = (1 + 5.5 * Math.pow(rand(), 2.2)) * Math.PI / 180 * (1 + el * 1.5);
    // keep the whole cloud (not just its centre) out of the window the camera ever sees
    // (az -43..+33 deg, el up to ~10.5 deg during the pan / tilt) plus a margin
    const D = Math.PI / 180;
    const inWindow = az + size * 0.7 > -58 * D && az - size * 0.7 < 48 * D && el - size * 0.3 < 14.5 * D;
    if (inWindow || Math.abs(Math.abs(az) - Math.PI) < 0.12) continue;
    const kind = rand() < 0.3 ? 'wisp' : 'cu';
    defs.push({
      az, el, w: size, aspect: kind === 'wisp' ? 0.12 + 0.1 * rand() : 0.2 + 0.15 * rand(), kind,
      seed: 1000 + i, skew: (rand() - 0.5) * 0.8, n: kind === 'wisp' ? 4 : 5 + Math.floor(rand() * 6), dens: 0.6 + 0.4 * rand(),
    });
  }

  // ---------------------------------------------------------------- bake
  const maxTex = renderer.capabilities.maxTextureSize;
  const PW = Math.min(maxTex, quality.tier === 'high' ? 8192 : quality.tier === 'medium' ? 4096 : 2048);
  const PH = PW / 16;
  const cloudRT = new THREE.WebGLRenderTarget(PW, PH, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.RepeatWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    generateMipmaps: false,
  });
  cloudRT.texture.colorSpace = THREE.LinearSRGBColorSpace;

  const sunDir = uniforms.uSunDir.value.clone().normalize();
  // Cloud key light: side-on from the right and a little above (tuned to the reference clouds:
  // lit right flanks / turret tops, shaded left and under sides).
  // near the real sun azimuth (60 deg) but ~18 deg further round and a little higher: with the
  // exact sun only a thin crescent of each cloud is lit, the reference shows broad lit right-hand
  // domes (peach) with a forward-scatter edge and mauve-grey shaded left / under sides
  const cloudSun = new THREE.Vector3().fromArray(dirFromAngles(config.sun.azimuthDeg + 18, 12)).normalize();
  const bakeMat = new THREE.ShaderMaterial({
    vertexShader: BAKE_VERT,
    fragmentShader: BAKE_FRAG,
    uniforms: {
      uAzEl: { value: new THREE.Vector4() },
      uCenter: { value: new THREE.Vector4() },
      uBand: { value: new THREE.Vector2(EL0, EL1) },
      uPuffs: { value: Array.from({ length: MAXP }, () => new THREE.Vector4()) },
      uNP: { value: 0 },
      uShape: { value: new THREE.Vector4() },
      uShape2: { value: new THREE.Vector4() },
      uZr: { value: 0.2 },
      uSunL: { value: new THREE.Vector3() },
      uPhase: { value: 1 },
      uSunCol: { value: new THREE.Vector3(11.6, 5.4, 1.45) },
      uAmbTop: { value: new THREE.Vector3(0.47, 0.47, 0.51) },
      uAmbBot: { value: new THREE.Vector3(0.33, 0.33, 0.37) },
      uShear: { value: 0 },
      uBaseSun: { value: 0.3 },
      uTail: { value: 0 },
      uSunScale: { value: 1 },
      uShadeX: { value: new THREE.Vector3(0, 1, 0) },
      uLStep: { value: 0.085 },
      uSquash: { value: 0.55 },
      uPuffSq: { value: new Float32Array(MAXP) },
      uBump: { value: 0 },
      uLowDens: { value: 1 },
      uSunRamp: { value: new THREE.Vector2(0.06, 0.55) },
    },
    depthTest: false,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
  });
  const quadGeo = new THREE.BufferGeometry();
  quadGeo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0], 3));
  const quad = new THREE.Mesh(quadGeo, bakeMat);
  quad.frustumCulled = false;
  const bakeScene = new THREE.Scene();
  bakeScene.add(quad);
  const bakeCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const prevTarget = renderer.getRenderTarget();
  const prevClear = renderer.getClearColor(new THREE.Color());
  const prevAlpha = renderer.getClearAlpha();
  const prevAutoClear = renderer.autoClear;
  renderer.setRenderTarget(cloudRT);
  renderer.setClearColor(0x000000, 0);
  renderer.clear(true, false, false);
  renderer.autoClear = false;

  const U = bakeMat.uniforms;
  const up = new THREE.Vector3(0, 1, 0);
  const hg = (g, c) => (1 - g * g) / Math.pow(1 + g * g - 2 * g * c, 1.5);
  // far-to-near-ish: draw big/low ones first so small near-looking wisps sit on top
  defs.sort((a, b) => a.el - b.el);
  for (let i = 0; i < defs.length; i++) {
    const def = defs[i];
    const r = mulberry32(def.seed * 7919 + 17);
    const cl = buildCloud(def, r);
    const d = new THREE.Vector3(Math.sin(def.az) * Math.cos(def.el), Math.sin(def.el), -Math.cos(def.az) * Math.cos(def.el));
    const right = new THREE.Vector3().crossVectors(d, up).normalize();
    const upL = new THREE.Vector3().crossVectors(right, d).normalize();
    const L = new THREE.Vector3(cloudSun.dot(right), cloudSun.dot(upL), -cloudSun.dot(d));
    const cosT = -L.z; // angle between light propagation (-L) and the ray toward the viewer (+z)
    U.uSunL.value.copy(L);
    U.uPhase.value = 0.6 * hg(0.6, cosT) + 0.4 * hg(-0.2, cosT);
    for (let k = 0; k < MAXP; k++) {
      const p = cl.puffs[k];
      U.uPuffSq.value[k] = p && p[4] ? p[4] : 0;
      if (p) U.uPuffs.value[k].set(p[0], p[1], p[2], p[3]); else U.uPuffs.value[k].set(0, 0, 0, 1e-3);
    }
    U.uNP.value = cl.puffs.length;
    U.uShape.value.set(cl.base, cl.top, cl.ero, cl.freq);
    U.uShape2.value.set(cl.sigma, cl.wisp, (def.seed % 97) * 3.17, cl.stretch);
    U.uZr.value = cl.zr;
    U.uSquash.value = cl.squash;
    U.uSunScale.value = def.kind === 'wisp' ? 0.0 : (def.sun ?? 1);
    // wisps / tiny fractus: optically thin, mauve-grey, darker than the sky behind them
    if (def.kind === 'wisp') { U.uAmbTop.value.set(0.4, 0.5, 0.58); U.uAmbBot.value.set(0.37, 0.46, 0.54); }
    // cumulus: neutral slate shaded undersides / left flanks (reference darkest 10 %: 183,184,184)
    // (lighter, bluer-lavender bases than a CG slate: the clip's C1 base p10 is 175,181,182)
    // (measured shade p10 175,181,184 at t 9, p50 of C2 187,190,196: lavender-grey, B highest)
    else { U.uAmbTop.value.set(0.37, 0.37, 0.46); U.uAmbBot.value.set(0.27, 0.27, 0.35); }
    // cauliflower sub-puffs on every cumuliform cloud (not on the thin wisps)
    U.uBump.value = def.kind === 'wisp' ? 0 : (def.bump ?? 1.0);
    U.uShear.value = def.kind === 'wisp' ? 0.1 : 0.25;
    U.uTail.value = def.tail || 0;
    U.uBaseSun.value = def.kind === 'row' ? 0.2 : 0.22;
    U.uLowDens.value = def.lowDens ?? 1;
    U.uSunRamp.value.fromArray(def.sunRamp || [0.06, 0.55]);
    // tiny puffs: soft (wisp-like) density ramp, no crisp flat base
    if (def.soft) U.uShape2.value.y = def.soft;
    if (def.shadeX) U.uShadeX.value.fromArray(def.shadeX); else U.uShadeX.value.set(0, 1, 0);
    U.uCenter.value.set(def.az, def.el, def.w, 0);
    const [x0, x1, y0, y1] = cl.box;
    const az0 = def.az + x0 * def.w, az1 = def.az + x1 * def.w;
    if (az0 < -Math.PI || az1 > Math.PI) continue; // never straddle the seam (behind the camera)
    U.uAzEl.value.set(az0, az1, def.el + y0 * def.w, def.el + y1 * def.w);
    renderer.render(bakeScene, bakeCam);
    if (i % 12 === 11) {
      ctx.progress(0.1 + 0.6 * (i / defs.length), 'Clouds');
      await new Promise((res) => setTimeout(res, 0));
    }
  }
  renderer.autoClear = prevAutoClear;
  renderer.setRenderTarget(prevTarget);
  renderer.setClearColor(prevClear, prevAlpha);
  bakeMat.dispose();
  quadGeo.dispose();

  // ---------------------------------------------------------------- dome
  const makeDomeMat = (envMode) => new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: envMode ? false : true,
    uniforms: {
      uSkyZenith: uniforms.uSkyZenith,
      uSkyHorizon: uniforms.uSkyHorizon,
      uClouds: { value: cloudRT.texture },
      uDrift: { value: 0 },
      uEnvMode: { value: envMode ? 1 : 0 },
      uBand: { value: new THREE.Vector2(EL0, EL1) },
      uGround: { value: new THREE.Vector3().fromArray(ENV_GROUND) },
      // ~1 reference px in the texture (8192 wide: 1 texel = 0.044 deg; 1 ref px = 0.052 deg)
      // (0.7 texel: crisp sunlit lumps; the soft bodies come from the bake itself)
      uCloudBlur: { value: envMode ? new THREE.Vector2() : new THREE.Vector2(0.7 / 8192, (0.7 / 8192) * 2 * Math.PI / (EL1 - EL0)) },
      uLife: { value: new THREE.Vector2() },
    },
    vertexShader: DOME_VERT,
    fragmentShader: DOME_FRAG,
  });
  const domeMat = makeDomeMat(false);
  const domeGeo = new THREE.SphereGeometry(1000, 96, 48);
  const dome = new THREE.Mesh(domeGeo, domeMat);
  dome.frustumCulled = false;
  // drawn after all opaque geometry (at the far plane via xyww, depth test LessEqual) so only
  // visible sky pixels are shaded; transparent objects still blend over it
  dome.renderOrder = 1e6;
  dome.onBeforeRender = (r, s, cam) => dome.position.copy(cam.position);
  scene.add(dome);
  ctx.progress(0.75, 'Sky light');

  // ---------------------------------------------------------------- environment (PMREM)
  const envScene = new THREE.Scene();
  const envMat = makeDomeMat(true);
  const envDome = new THREE.Mesh(new THREE.SphereGeometry(50, 64, 32), envMat);
  envDome.frustumCulled = false;
  envScene.add(envDome);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envRT = pmrem.fromScene(envScene, 0, 0.1, 200);
  pmrem.dispose();
  envMat.dispose();
  envDome.geometry.dispose();
  scene.environment = envRT.texture;
  ctx.env = envRT.texture;

  // ---------------------------------------------------------------- lights
  const sunCol = new THREE.Color(config.sun.color);
  sunLight.color.copy(sunCol);
  sunLight.intensity = config.sun.intensity * Math.PI;
  fitShadow(sunLight, sunDir);
  // shadow-map budget: 2048 on 'high', 1024 otherwise (sky create runs before the first render,
  // so the map is not allocated yet). Below 'high' the map is refreshed at 30 Hz (every other
  // frame at 60 fps) from update(t); the adapter can set shadowHz for any tier.
  // Capture mode keeps per-frame updates so renderAt(t) is exact.
  sunLight.shadow.mapSize.setScalar(quality.tier === 'high' ? 2048 : 1024);
  const halfRateShadow = !ctx.capture && (quality.tier !== 'high' || Number.isFinite(quality.shadowHz));
  if (halfRateShadow) renderer.shadowMap.autoUpdate = false;
  let shadowSlot = NaN;
  // PBR materials get their ambient from scene.environment; the hemisphere light is only a
  // small fill for anything without IBL.
  hemiLight.color.setRGB(0.42, 0.68, 1.0);
  hemiLight.groundColor.setRGB(0.12, 0.14, 0.09);
  hemiLight.intensity = 0.15;
  // static far-field sun shadow (beach / dunes / surf beyond the shadow-map box), baked on the
  // first frame once terrain exists; exposed as ctx.uniforms.uFarShadow* + FAR_SHADOW_GLSL
  const noFarShadow = ctx.params.has('nofarshadow'); // debug A/B
  const farShadow = createFarShadow(renderer, uniforms, sunDir, quality.tier === 'low' ? 1024 : 2048);
  if (ctx.params.get('debug') === 'farshadowall') uniforms.uFarShadowParams.value.w = 1;
  if (ctx.params.get('debug') === 'farshadow') {
    const B = FAR_SHADOW_BOX;
    const g = new THREE.PlaneGeometry(B.maxX - B.minX, B.maxZ - B.minZ, 1, 1).rotateX(-Math.PI / 2)
      .translate((B.minX + B.maxX) / 2, 0.8, (B.minZ + B.maxZ) / 2);
    const m = new THREE.ShaderMaterial({
      uniforms: { ...uniforms },
      vertexShader: 'varying vec3 vW; void main(){ vW = (modelMatrix * vec4(position,1.0)).xyz; gl_Position = projectionMatrix * viewMatrix * vec4(vW,1.0); }',
      fragmentShader: FAR_SHADOW_GLSL + 'varying vec3 vW; void main(){ float v = farSunVisibility(vW, vec3(0.0,1.0,0.0)); gl_FragColor = vec4(mix(vec3(0.05,0.0,0.3), vec3(2.0,1.6,0.8), v), 1.0); }',
      polygonOffset: true, polygonOffsetFactor: -4,
    });
    const dbg = new THREE.Mesh(g, m);
    dbg.frustumCulled = false;
    scene.add(dbg);
  }
  ctx.progress(1, 'Sky and light');

  return {
    cloudTexture: cloudRT.texture,
    farShadow,
    dispose() { farShadow.dispose(); cloudRT.dispose(); envRT.dispose(); },
    update(t) {
      if (!noFarShadow) farShadow.bake(scene);
      if (halfRateShadow) {
        const slot = Math.floor(t * (quality.shadowHz || 30));
        if (slot !== shadowSlot) { renderer.shadowMap.needsUpdate = true; shadowSlot = slot; }
      }
      domeMat.uniforms.uDrift.value = (CLOUD_DRIFT * t) % (2 * Math.PI); // pure function of t
      // cloud evolution (pure function of t): off during the reference replay (t < 14 s, the
      // catalogue clouds match the clip), then parts of the clouds fade / fray by up to 45 % over
      // ~1 min cycles; the time lattice loops every 3600 s (60 cells of 60 s)
      const lk = Math.min(1, Math.max(0, (t - 14) / 16));
      domeMat.uniforms.uLife.value.set((t / 60) % 60, 0.45 * lk * lk * (3 - 2 * lk));
    },
  };
}

// Directional-light shadow camera fitted to the foreground headland/trees box.
function fitShadow(light, sunDir) {
  const box = new THREE.Box3(new THREE.Vector3(-60, 0, -160), new THREE.Vector3(130, 40, 10));
  const center = box.getCenter(new THREE.Vector3());
  light.target.position.copy(center);
  // far toward the sun so casters up to ~600 m sun-ward of the box (knoll, headland, dune
  // crests on the right) still land inside the depth range
  light.position.copy(center).addScaledVector(sunDir, 800);
  light.target.updateMatrixWorld();
  light.updateMatrixWorld();
  const view = new THREE.Matrix4().lookAt(light.position, center, new THREE.Vector3(0, 1, 0));
  const inv = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler().setFromRotationMatrix(view)).invert();
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  const v = new THREE.Vector3();
  for (let i = 0; i < 8; i++) {
    v.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z);
    v.sub(light.position).applyMatrix4(inv);
    minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x);
    minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y);
    minZ = Math.min(minZ, v.z); maxZ = Math.max(maxZ, v.z);
  }
  const sc = light.shadow.camera;
  sc.left = minX - 2; sc.right = maxX + 2; sc.bottom = minY - 2; sc.top = maxY + 2;
  sc.near = Math.max(1, -maxZ - 650); sc.far = -minZ + 20;
  sc.updateProjectionMatrix();
  light.shadow.needsUpdate = true;
}
