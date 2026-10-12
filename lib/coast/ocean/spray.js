// Spray, mist and splashes: deterministic GPU particles (camera-facing soft sprites).
//
// Nothing is simulated. Every particle is a closed-form function of time:
//   - rock surges: emitters in the water along the platform, the surf rocks and the headland foot;
//     their surge times / strengths mirror the ocean's crest arrival (spray/emitters.js). Each
//     particle picks its surge cycle from t (re-seeded every cycle, so no two surges are alike) and
//     flies  x0 + vt*tau + (v0 - vt)(1 - e^-k tau)/k  (linear drag toward the gusting wind, gravity).
//     The water goes with the swell and up the face (no geysers): at the small rocks a translucent,
//     streaky wall stands on the arriving crest 0-9 m seaward, then domes over the rock; walls get a
//     sheet climbing the face; submerged rocks only a faint flat boil; far rocks a low rim;
//   - breaking crests: ocean.breakerEvents() (the same schedule as the visible breakers and the
//     audio) is packed each frame into a small event texture; every event throws a backlit lip veil
//     that rides the crest line and peels along it, plus spindrift trails dragged landward. Both are
//     gated by a mirror of the ocean's along-crest whitewater segmentation (segM);
//   - a faint salt haze in the gully (the surf-zone veil is the atmosphere's analytic HAZE_SPRAY).
// Sprites: procedural atlas (curtain with fall streaks, droplet trails, cloud, torn wisp), oriented
// upright / along the motion / along the crest line, streaked by a 1/60 s shutter, dissolving from
// their thin parts over their life (holes, not fading blobs). Lighting: sun visibility from a baked
// shadow-height field (the platform shades the gully and the dark rock: blue-white there, cream where
// sunlit), Henyey-Greenstein forward scattering toward the low sun, shared aerial perspective. Each
// fragment fades against the ground / water under it (no depth texture); a small depth bias toward
// the camera (dropped where terrain stands in between) stops sprites cutting into rock faces.
import { SURF, SURF_LINE, buildTauLUT } from './coast.js';
import { crestStrength as crestJS, OUTER_BREAK } from './surf.glsl.js';
import { GUST_GLSL } from '../core/wind.js';
import { ATMOSPHERE_GLSL } from '../core/atmosphere.js';
import { invAcesSRGB8 } from '../post/tonemap.js';
import { hash2 } from '../core/rng.js';
import { createSprayAtlas } from './spray/texture.js';
import { buildRockEmitters, bakeSunField } from './spray/emitters.js';

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

// ---------------------------------------------------------------------------------------------
const COMMON_GLSL = /* glsl */ `
uniform sampler2D uAtlas;
uniform sampler2D uField;   // (ground height, sun shadow height)
uniform vec4 uFieldRect;
uniform float uST;          // spray time (s, wrapped at the ocean loop)
uniform float uTime;        // scene time (wrapped at 3600 s, the gust loop)
uniform float uFocalPx;     // projection focal length in target pixels
uniform vec3 uLitCol;       // sun-lit dense spray minus the shaded colour (HDR)
uniform vec3 uShadeCol;     // shaded dense spray (HDR)
uniform float uWindU;       // mean near-surface wind (m/s)
uniform float uOpacity;
uniform vec2 uWindDir;
${GUST_GLSL}

uint sprH(uint x){ x ^= x >> 16u; x *= 0x7feb352du; x ^= x >> 15u; x *= 0x846ca68bu; x ^= x >> 16u; return x; }
float sprR(uint seed, uint k){ return float(sprH(seed * 0x9E3779B9u + k * 0x85ebca6bu + 0x165667b1u) >> 8u) * (1.0 / 16777216.0); }

vec2 fieldAt(vec2 xz){
  vec2 uv = (xz - uFieldRect.xy) * uFieldRect.zw;
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return vec2(0.0, -10.0);
  return texture(uField, uv).rg;
}
// Henyey-Greenstein, normalised to 1 at 57 deg from the sun (the platform's direction)
float hgN(float c, float g){
  float d = 1.0 + g * g - 2.0 * g * c;
  float d0 = 1.0 + g * g - 2.0 * g * 0.54;
  return pow(d0 / max(d, 1e-3), 1.5);
}
`;

const VERT = /* glsl */ `
precision highp float;
precision highp int;
attribute vec4 aInst;   // (source index, particle index, kind: 0 rock / 1 breaker, unused)
uniform sampler2D uEmit;   // rock emitters (w = count): row0 (x, 0, z, t0) row1 (nx, nz, expo, spacing) row2 S[k mod 4] row3 (class, ...)
uniform sampler2D uEvents; // breaker events (w = slots): row0 (x, z, age, strength) row1 (shoreX, shoreZ, seed, kind)
uniform float uPeriod;
uniform float uCycles;     // surge cycles per spray loop (loop / period)
uniform vec2 uSwell;       // swell travel direction (xz, unit)
uniform float uDbgK;
float dbgTag = 0.0;
${COMMON_GLSL}
${ATMOSPHERE_GLSL}
varying vec2 vUv;
varying vec4 vCol;      // colour (rgb) and alpha
varying vec4 vFade;     // (fragment world x, z, fragment world height, fade floor)
varying vec3 vMisc;     // (fade band, edge glow, age01 for the dissolve; < 0: none)
varying float vDense;

// closed-form flight with linear drag k toward terminal velocity vt
vec3 flight(vec3 p0, vec3 v0, vec3 vt, float k, float tau){
  return p0 + vt * tau + (v0 - vt) * (1.0 - exp(-k * tau)) / k;
}

void kill(){ gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vCol = vec4(0.0); }

// mirror of the ocean's along-crest whitewater segmentation (surf.glsl.js segM, sHashI, sNoise1)
float spHashI(int n, int s){
  uint h = uint(n) * 374761393u + uint(s) * 668265263u;
  h = (h ^ (h >> 13u)) * 1274126177u;
  h ^= h >> 16u;
  return float(h >> 8u) * (1.0 / 16777216.0);
}
float spNoise1(float x, int seed){
  float i = floor(x); float f = x - i; f = f*f*(3.0-2.0*f);
  int ii = int(i);
  return mix(spHashI(ii, seed), spHashI(ii + 1, seed), f);
}
float spSegM(float idx, float s, float gap, float d){
  float i = mod(idx, 120.0);
  float sl = d / 95.0;
  float n = 0.58 * spNoise1(s / 19.0 + i * 5.3 + sl, 4) + 0.42 * spNoise1(s / 7.0 + i * 2.1 - 1.6 * sl, 5);
  float lo = 0.3 + 0.05 * gap + 0.12 * (spHashI(int(i), 7) - 0.5) + 0.2 * (spNoise1(s / 140.0 + i * 0.77, 10) - 0.5)
           - 0.06 * smoothstep(140.0, 160.0, d) * smoothstep(250.0, 220.0, d); // (mirror of surf.glsl.js segM)
  float g = mix(0.55, 1.25, spNoise1(s / 50.0 + i * 1.9, 6));
  return smoothstep(lo, lo + 0.22, n) * g;
}

void main(){
  vec2 wd = normalize(uWindDir);
  vec3 W3 = vec3(wd.x, 0.0, wd.y);
  float kind = aInst.z;
  uint pj = uint(aInst.y + 0.5);
  vec3 P; float size, alpha, rot, dense, fadeFloor, fadeBand, cellId, tau, life;
  float aspect = 1.0;      // sprite height / width before the motion stretch
  float orient = 0.0;      // 0: random rotation, 1: v axis along the (upward) screen motion, 2: u axis along uAxisW, 3: u along the motion
  float shade = 1.0;       // extra darkening of shaded thin spray
  float glowK = 0.0;       // extra forward-scattered glow of thin veils
  vec3 axisW = vec3(1.0, 0.0, 0.0);
  vec3 vel = vec3(0.0);

  if (kind < 0.5) {
    // ------------------------------------------------ rock surge
    int e = int(aInst.x + 0.5);
    vec4 E0 = texelFetch(uEmit, ivec2(e, 0), 0);
    vec4 E1 = texelFetch(uEmit, ivec2(e, 1), 0);
    vec4 E2 = texelFetch(uEmit, ivec2(e, 2), 0);
    vec4 E3 = texelFetch(uEmit, ivec2(e, 3), 0);
    float cls = E3.x;       // 0 wall (platform / headland foot), 1 submerged, 2 far rock, 3 small exposed rock
    uint seed = uint(e) * 131u + 7u;
    // type and birth offset stay fixed per (emitter, particle) so the cycle can be computed ...
    float r0 = sprR(seed, pj * 16u + 0u), r1 = sprR(seed, pj * 16u + 1u), r2 = sprR(seed, pj * 16u + 2u);
    // 0: water (sheet / clump thrown up the face)  1: fine spray blown off the top
    float type = r0 < 0.7 ? 0.0 : 1.0;
    if (cls > 0.5 && cls < 1.5 && type > 0.5) { kill(); return; }
    bool second = r1 < 0.2;
    // small rocks: the arriving crest already breaks on the reef 0-12 m seaward of the rock, so part of
    // the white wall stands out there and reaches it earlier (crest speed ~5 m/s); walls: 0-3 m
    float rO = sprR(seed, pj * 16u + 12u);
    float dOut = type < 0.5 ? (cls > 2.5 ? 9.0 * rO * rO : cls < 0.5 ? 3.0 * rO * rO : 0.0) : 0.0;
    // (small rocks: the water piles onto the rock and domes over it ~1-2.5 s after the crest arrives)
    float b = (second ? 5.0 : 0.0) + (type < 0.5 ? 0.15 + 1.5 * r2 : 0.6 + 2.0 * r2) - dOut / 5.0 + (cls > 2.5 ? 1.0 : 0.0);
    float cyc = floor((uST - E0.w - b) / uPeriod);
    int kk = int(mod(cyc, 4.0) + 0.5) & 3;
    // ... everything else is re-drawn every cycle: no two surges on a rock are alike
    uint key = uint(int(mod(cyc, uCycles) + 0.5));
    uint seedC = sprH(uint(e) * 0x2545F491u + key * 0x632BE5ABu + 0x9E37u);
    float cj0 = sprR(seedC, 0u), cj1 = sprR(seedC, 1u), cj2 = sprR(seedC, 2u);
    tau = uST - (E0.w + cyc * uPeriod + b + (cj0 - 0.5) * 0.6);
    uint seed2 = sprH(seed ^ (key * 0x632BE5ABu + 0x51u));
    float r3 = sprR(seed2, pj * 16u + 3u);
    float r4 = sprR(seed2, pj * 16u + 4u), r5 = sprR(seed2, pj * 16u + 5u), r6 = sprR(seed2, pj * 16u + 6u), r7 = sprR(seed2, pj * 16u + 7u);
    float r8 = sprR(seed2, pj * 16u + 8u), r9 = sprR(seed2, pj * 16u + 9u), r10 = sprR(seed2, pj * 16u + 10u), r11 = sprR(seed2, pj * 16u + 11u);
    float S = second ? 0.4 : E2[kk];
    S *= E1.z * mix(0.7, 1.2, cj1);
    // bigger surges light up more particles; weak ones only a few low clumps
    // (weak surges throw nothing: a handful of lone sheets reads as white tick marks, not a surge)
    float act = step(r3, clamp((S - 0.26) / 0.7, 0.0, 1.0));
    if (act < 0.5) { kill(); return; }
    vec2 n = E1.xy; vec2 tg = vec2(-n.y, n.x);
    vec3 n3 = vec3(n.x, 0.0, n.y), tg3 = vec3(tg.x, 0.0, tg.y), sw3 = vec3(uSwell.x, 0.0, uSwell.y);
    float face = clamp(-dot(n, uSwell), 0.0, 1.0);
    float spacing = E1.w;
    float Sv = clamp(S, 0.0, 1.3);
    // neighbouring emitters merge into one sheet: wide tangent spread (far rocks: a rim, not a ball)
    float spread = cls > 1.5 && cls < 2.5 ? 3.2 : cls > 2.5 ? 4.5 : 3.5;
    vec3 p0 = vec3(E0.x, 0.0, E0.z) + tg3 * ((r4 - 0.5) * spread + (cj2 - 0.5)) * spacing
            + n3 * (0.2 + 2.0 * r5 * r5) - sw3 * dOut;
    float G = gustMulAt(uTime - 0.5 * tau);
    vec3 wind = W3 * uWindU * G;
    if (cls > 0.5 && cls < 1.5) {
      // submerged / awash rock: the surge boils over it: flat, low, faint white water
      p0.y = 0.05;
      vec3 v0 = sw3 * (1.0 + 1.5 * r8) + tg3 * (r9 - 0.5) * 1.5 + vec3(0.0, 0.3 + 0.9 * r6 * Sv, 0.0);
      float k = 1.2;
      vec3 vt = sw3 * 0.8 + wind * 0.15 - vec3(0.0, 9.81 / k, 0.0);
      P = flight(p0, v0, vt, k, tau);
      P.y = max(P.y, 0.05);
      vel = vec3(0.0);
      life = 1.2 + 1.0 * r10;
      size = (1.4 + 1.6 * r11) * (1.0 + 0.4 * tau);
      alpha = (0.07 + 0.08 * r9) * Sv * smoothstep(0.0, 0.25, tau) * (1.0 - smoothstep(0.4 * life, life, tau));
      dense = 0.8; cellId = 2.0;
      aspect = 0.33; orient = 2.0; axisW = tg3;
      fadeFloor = -0.6; fadeBand = 0.6;
    } else if (type < 0.5) {
      // water thrown up the face: a translucent streaky sheet / dome that travels with the crest,
      // piles onto the rock and falls back within ~1-2 s (no geysers: the up-speed is capped)
      bool far = cls > 1.5 && cls < 2.5;
      bool small = cls > 2.5;
      float up = far ? Sv * (1.8 + 2.2 * r6) + 0.8 : small ? min(Sv * (4.5 + 5.5 * r6) + 2.0, 12.0) : min(Sv * (3.2 + 5.0 * r6 * r6) + 1.4, 9.0);
      up *= 1.0 - 0.45 * clamp(dOut / 9.0, 0.0, 1.0);   // out on the reef: a breaking crest, not a hit
      p0.y = 0.15 + 0.8 * r7 * Sv;
      // along the swell (over small rocks the water runs across the top), sideways along the face,
      // and ~20 % backwash falling seaward
      float bw = step(0.8, r7);
      vec3 vh = sw3 * (small ? (2.0 + 3.0 * r8) * (0.4 + 0.6 * face) : 1.2 * r8 * face) * (1.0 - bw)
              + tg3 * (r9 - 0.5) * 3.5 + n3 * (0.6 + 1.6 * r8) * bw;
      vec3 v0 = vh + vec3(0.0, up * (1.0 - 0.4 * bw), 0.0);
      float k = 0.4 + 0.5 * r10;
      vec3 vt = wind * 0.8 - vec3(0.0, 9.81 / k, 0.0);
      P = flight(p0, v0, vt, k, tau);
      vel = vt + (v0 - vt) * exp(-k * tau);
      life = 2.0 * up / 9.81 + 0.5;
      size = (0.75 + 1.3 * r11) * mix(0.85, 1.35, Sv) * (far ? 0.75 : 1.0) * (1.0 + 0.6 * tau);
      alpha = (0.32 + 0.3 * r9) * smoothstep(0.0, 0.08, tau) * (1.0 - smoothstep(0.45 * life, life, tau)) / (1.0 + 0.4 * tau);
      if (far) { alpha *= 0.75; dbgTag = 3.0; } else dbgTag = 4.0;
      alpha *= 1.0 - 0.4 * clamp(dOut / 9.0, 0.0, 1.0);      // the breaking crest is thinner than the hit
      if (small) shade = 0.45;                               // (small rocks: mostly in the platform's shade; the
                                                             //  reference hit is blue-white throughout)
      dense = 1.0;
      cellId = r10 < 0.65 ? 1.0 : 2.0;
      aspect = mix(0.8, 1.25, smoothstep(0.4, 0.9, Sv)); orient = 1.0;
      fadeFloor = 0.1; fadeBand = 0.3 + 0.2 * size;
    } else {
      // fine spray: rises with the sheet, then the wind drags it landward as a thinning veil
      float up = Sv * (2.2 + 4.0 * r6) + 0.8;
      p0.y = 0.4 + Sv * 2.0 * r7;
      vec3 v0 = n3 * (0.2 + 0.8 * r8) + sw3 * face * 0.8 + vec3(0.0, up, 0.0);
      float k = 1.4 + 1.6 * r10;
      vec3 vt = wind - vec3(0.0, 0.15 + 0.5 * r9, 0.0);
      P = flight(p0, v0, vt, k, tau);
      vel = vt + (v0 - vt) * exp(-k * tau);
      // turbulence grows with age
      float ta = 0.5 * Sv * (1.0 - exp(-tau / 1.2)) * tau;
      P += ta * vec3(sin(2.1 * tau + 6.28 * r4), 0.5 * sin(1.7 * tau + 6.28 * r5), sin(1.3 * tau + 6.28 * r11));
      life = 1.8 + 2.4 * r11 * Sv;
      size = (0.8 + 1.1 * r2) * mix(0.8, 1.2, Sv) * (1.0 + 0.4 * tau);
      alpha = (0.05 + 0.08 * r9) * Sv * smoothstep(0.0, 0.35, tau) * (1.0 - smoothstep(0.3 * life, life, tau)) / (1.0 + 0.5 * tau);
      if (cls > 1.5 && cls < 2.5) alpha *= 0.5;
      dense = 0.25; shade = 0.5;
      cellId = r10 < 0.4 ? 0.0 : 3.0;
      orient = cellId > 2.5 ? 3.0 : 0.0;
      fadeFloor = 0.3; fadeBand = 0.5 + 0.3 * size;
    }
    if (tau < 0.0 || tau > life) { kill(); return; }
    rot = 6.2832 * r3 * 7.0 + (r5 - 0.5) * 1.5 * tau;
  } else {
    // ------------------------------------------------ breaking crest
    int s = int(aInst.x + 0.5);
    vec4 V0 = texelFetch(uEvents, ivec2(s, 0), 0);
    vec4 V1 = texelFetch(uEvents, ivec2(s, 1), 0);
    vec4 V2 = texelFetch(uEvents, ivec2(s, 2), 0);
    if (V0.w <= 0.0) { kill(); return; }
    uint seed = uint(V1.z * 16777216.0);
    float r0 = sprR(seed, pj * 16u + 0u), r1 = sprR(seed, pj * 16u + 1u), r2 = sprR(seed, pj * 16u + 2u), r3 = sprR(seed, pj * 16u + 3u);
    float r4 = sprR(seed, pj * 16u + 4u), r5 = sprR(seed, pj * 16u + 5u), r6 = sprR(seed, pj * 16u + 6u), r7 = sprR(seed, pj * 16u + 7u);
    float r8 = sprR(seed, pj * 16u + 8u), r9 = sprR(seed, pj * 16u + 9u), r10 = sprR(seed, pj * 16u + 10u), r11 = sprR(seed, pj * 16u + 11u);
    float A = V0.w;
    bool inner = V1.w > 0.5;
    if (r1 > 0.35 + 0.65 * A) { kill(); return; }
    vec2 sd = normalize(V1.xy + 1e-5);
    vec2 tg = vec2(-sd.y, sd.x);
    vec3 sd3 = vec3(sd.x, 0.0, sd.y), tg3 = vec3(tg.x, 0.0, tg.y);
    float type = r0 < 0.62 ? 0.0 : 1.0;
    float c = inner ? 4.0 : 6.0;                     // bore speed (m/s)
    // spread along the crest segment the event stands for; the lip peels along the crest
    float span = inner ? 26.0 : 40.0;
    float along = (r4 - 0.5) * span;
    float pdir = fract(V1.z * 7.31) < 0.5 ? -1.0 : 1.0;
    float peel = (along * pdir + 0.5 * span) * (0.02 + 0.02 * fract(V1.z * 3.7));
    float b = type < 0.5 ? peel + 0.35 * r2 : peel + 0.3 + 1.6 * r2;
    tau = V0.z - b;
    vec3 p0 = vec3(V0.x, 0.0, V0.y) + sd3 * c * b + tg3 * along;
    // only where this piece of the crest carries whitewater in the ocean shader
    float seg = V2.x >= 0.0 ? spSegM(V2.x, V2.y + along * tg.y, smoothstep(300.0, 1300.0, length(p0.xz - cameraPosition.xz)), V2.z) : 1.0;
    float segW = smoothstep(0.25, 0.75, seg);
    if (segW <= 0.0) { kill(); return; }
    float crestH = (inner ? 0.9 : 1.7) * (0.6 + 0.6 * A);
    float G = gustMulAt(uTime - 0.5 * tau);
    vec3 wind = W3 * uWindU * G * 1.15;
    float Sv = clamp(A, 0.0, 1.0);
    if (type < 0.5) {
      // the plunging lip: a thin backlit veil stretched along the crest line, riding the crest top
      p0.y = crestH * (0.95 + 0.4 * r6);
      // (rides exactly with the crest line: all live lip pieces stay on one line, not staggered bars)
      vec3 v0 = sd3 * c + vec3(0.0, (0.5 + 1.0 * r8) * (0.5 + 0.6 * Sv), 0.0);
      float k = 2.0;
      vec3 vt = sd3 * c + wind * 0.15 - vec3(0.0, 1.0, 0.0);
      P = flight(p0, v0, vt, k, tau);
      vel = vec3(0.0);
      life = 1.0 + 1.2 * r10;
      size = (1.9 + 1.6 * r11) * (inner ? 0.7 : 1.0) * (1.0 + 0.5 * tau);
      alpha = segW * (0.2 + 0.2 * r9) * (0.6 + 0.5 * Sv) * smoothstep(0.0, 0.15, tau) * (1.0 - smoothstep(0.35 * life, life, tau));
      // from a few hundred metres an upright lip veil reads as a white post, not as spray: real
      // spindrift is invisible that far out, so the veil only exists near the camera
      // (inside ~170 m the visible breakers are nearbreak.js events, which carry their own lip spray in
      // the ocean shader: a surf-schedule veil there stands over open water as a row of white bars)
      alpha *= 1.0 - smoothstep(110.0, 190.0, length(p0.xz - cameraPosition.xz));
      alpha *= smoothstep(165.0, 200.0, length(p0.xz - cameraPosition.xz));
      if (alpha <= 0.0) { kill(); return; }
      dense = 0.45; cellId = 3.0; glowK = 2.0; dbgTag = 1.0;
      aspect = 1.0 / (2.2 + 1.5 * r7); orient = 2.0; axisW = tg3;
      fadeFloor = 0.3; fadeBand = 0.4 + 0.2 * size;
    } else {
      // spindrift: torn off the lip and dragged landward by the wind: a thin downwind trail
      p0.y = crestH * (0.9 + 0.4 * r6);
      vec3 v0 = sd3 * (1.0 + 2.0 * r7) + vec3(0.0, 1.0 + 2.0 * r8, 0.0);
      float k = 1.8 + 1.5 * r9;
      vec3 vt = wind - vec3(0.0, 0.2, 0.0);
      P = flight(p0, v0, vt, k, tau);
      vel = vt + (v0 - vt) * exp(-k * tau);
      float ta = 0.4 * (1.0 - exp(-tau / 1.2)) * tau;
      P += ta * vec3(sin(2.3 * tau + 6.28 * r4), 0.4 * sin(1.9 * tau + 6.28 * r5), sin(1.1 * tau + 6.28 * r11));
      life = 1.6 + 1.6 * r10;
      size = (0.8 + 1.0 * r11) * (1.0 + 0.7 * tau);
      alpha = segW * (0.05 + 0.09 * r9) * (0.5 + 0.6 * Sv) * smoothstep(0.0, 0.3, tau) * (1.0 - smoothstep(0.3 * life, life, tau)) / (1.0 + 0.5 * tau);
      alpha *= 1.0 - smoothstep(180.0, 320.0, length(p0.xz - cameraPosition.xz));
      alpha *= smoothstep(165.0, 200.0, length(p0.xz - cameraPosition.xz)); // (see the lip veil)
      dense = 0.3; cellId = 3.0; glowK = 1.0; dbgTag = 2.0;
      aspect = 0.6; orient = 3.0;
      fadeFloor = 0.4; fadeBand = 0.6 + 0.3 * size;
    }
    if (tau < 0.0 || tau > life) { kill(); return; }
    rot = 6.2832 * r3 * 5.0 + (r5 - 0.5) * tau;
  }

  // ---- lighting ----
  vec2 fld = fieldAt(P.xz);
  // sun visibility: shadow height from the baked field (softened over ~3 m)
  float vis = smoothstep(fld.y - 1.2, fld.y + 1.8, P.y);
  vec3 V = normalize(P - cameraPosition);
  float cs = dot(V, uSunDir);
  float ph = hgN(cs, 0.55);
  // dense water: diffuse-ish, a little forward glow; thin spray: phase dominated
  // (thin spray per unit opacity is brighter than dense water: its light is scattered forward;
  // thin spray in shade only sees the sky: darker and fainter)
  float litK = dense > 0.99 && shade < 0.99 ? shade : 1.0;
  if (litK < 1.0) shade = 1.0;
  vec3 col = uShadeCol * mix(1.15, 1.0, dense) * mix(shade, 1.0, max(vis, dense))
           + uLitCol * vis * litK * (mix(0.7 + 0.45 * ph, mix(0.85, 1.15, clamp(ph / 3.0, 0.0, 1.0)), dense) + glowK * ph);
  alpha *= mix(mix(0.35, 1.0, shade), 1.0, max(vis, dense));
  vec4 at = atmosphereAlong(P);
  col = col * at.w + at.rgb * (1.0 - at.w);

  // ---- sprite ----
  vec4 mv = viewMatrix * vec4(P, 1.0);
  float depth = max(-mv.z, 0.1);
  float ppm = uFocalPx / depth;                  // pixels per metre at the particle
  float sx = size, sy = size * aspect;
  float minPx = 2.5;
  float grow = max(1.0, minPx / max(min(sx, sy) * ppm, 1e-3));
  alpha /= grow * grow;                          // same energy when clamped to the minimum size
  sx *= grow; sy *= grow;
  // fade the far ones (sub-pixel detail)
  alpha *= 1.0 - smoothstep(900.0, 1300.0, depth);
  alpha *= uOpacity;
  if (alpha < 0.0015) { kill(); return; }
  vec2 cn = position.xy;                         // [-0.5, 0.5]
  // screen-space motion: a 1/60 s shutter streaks fast water along its path
  vec2 vv = (viewMatrix * vec4(vel, 0.0)).xy;
  float vl = length(vv);
  float st = clamp(1.0 + 1.5 * vl * ppm / 60.0 / max(min(sx, sy) * ppm, 1.0), 1.0, 4.0);
  vec2 ax, pr;
  if (orient > 2.5 && vl > 0.05) {            // u axis along the motion (wisps): long along it
    ax = vv / vl; pr = vec2(-ax.y, ax.x);
    sx *= st; sy /= sqrt(st);
  } else if (orient > 1.5) {                  // u axis along a world direction (crest line)
    vec2 a2 = (viewMatrix * vec4(axisW, 0.0)).xy;
    ax = normalize(a2 + vec2(1e-4, 0.0)); pr = vec2(-ax.y, ax.x);
  } else if (orient > 0.5) {                  // v axis along the upward screen motion (sheets)
    vec2 m = vl > 0.05 ? vv / vl : vec2(0.0, 1.0);
    if (m.y < 0.0) m = -m;
    // mostly upright: fall streaks stay close to vertical
    m = normalize(mix(vec2(0.0, 1.0), m, 0.3) + vec2(sin(rot) * 0.1, 0.0));
    pr = m; ax = vec2(m.y, -m.x);
    sy *= st; sx /= sqrt(st);
  } else {
    ax = vec2(cos(rot), sin(rot)); pr = vec2(-ax.y, ax.x);
    if (vl > 0.05) {
      // random rotation first, then a mild stretch along the motion
      vec2 c0 = ax * cn.x + pr * cn.y;
      vec2 m = vv / vl, mp = vec2(-m.y, m.x);
      cn = vec2(dot(c0, m), dot(c0, mp));
      ax = m; pr = mp;
      float st2 = min(st, 2.0);
      sx *= st2; sy /= sqrt(st2);
    }
  }
  vec2 off = ax * cn.x * sx + pr * cn.y * sy;
  vec4 mvo = vec4(mv.xy + off, mv.z, 1.0);
  gl_Position = projectionMatrix * mvo;
  // depth bias toward the camera: a sprite hugging a rock face does not cut into it
  float bias = min(0.4 * max(sx, sy), 2.0);
  // no bias where terrain stands between the particle and the camera (cliff foot, behind the platform)
  vec2 toC = normalize(cameraPosition.xz - P.xz);
  float gT = max(fieldAt(P.xz + toC * 1.5).x, max(fieldAt(P.xz + toC * 3.0).x, fieldAt(P.xz + toC * 5.0).x));
  bias *= 1.0 - smoothstep(P.y - 0.5, P.y + 0.5, gT);
  vec4 cb = projectionMatrix * vec4(mvo.xy, mvo.z + bias, 1.0);
  gl_Position.z = cb.z / cb.w * gl_Position.w;
  // fragment world position on the billboard (the fragment shader fades it against the ground)
  vec3 camR = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 camU = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 Wf = P + camR * off.x + camU * off.y;
  vFade = vec4(Wf.x, Wf.z, Wf.y, fadeFloor);
  vMisc = vec3(fadeBand, (1.0 - dense) * 0.6 + 0.25 * clamp(ph - 1.0, 0.0, 2.0) * vis, clamp(tau / max(life, 1e-3), 0.0, 1.0) * dense);
  vDense = dense;
  vUv = (position.xy + 0.5) * 0.4 + 0.05 + vec2(mod(cellId, 2.0), floor(cellId / 2.0)) * 0.5;
  if (uDbgK > 0.5) { col = dbgTag < 0.5 ? vec3(1.0,0.0,1.0) : dbgTag < 1.5 ? vec3(4.0,0.0,0.0) : dbgTag < 2.5 ? vec3(0.0,4.0,0.0) : dbgTag < 3.5 ? vec3(0.0,0.0,4.0) : vec3(4.0,4.0,0.0); alpha = min(1.0, alpha * 3.0); }
  vCol = vec4(col, alpha);
}
`;

const FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uAtlas;
uniform sampler2D uField;
uniform vec4 uFieldRect;
varying vec2 vUv;
varying vec4 vCol;
varying vec4 vFade;
varying vec3 vMisc;
varying float vDense;
void main(){
  float d = texture(uAtlas, vUv).r;
  // dissolve over the life of dense water: thin parts go first, the sheet tears into holes
  float ag = vMisc.z;
  float dd = d * mix(1.0, smoothstep(0.55 * ag, 0.55 * ag + 0.3, d), vDense);
  // fade against the ground / rock / water under this fragment (no depth texture)
  vec2 uv = (vFade.xy - uFieldRect.xy) * uFieldRect.zw;
  float ground = 0.0;
  if (all(greaterThanEqual(uv, vec2(0.0))) && all(lessThanEqual(uv, vec2(1.0)))) ground = max(texture(uField, uv).r, 0.0);
  float a = dd * vCol.a * smoothstep(0.0, 1.0, (vFade.z - ground - vFade.w) / vMisc.x);
  if (a < 0.002) discard;
  // thin edges of the cloud glow in the forward-scattered sun light
  vec3 col = vCol.rgb * (1.0 + vMisc.y * (1.0 - dd));
  gl_FragColor = vec4(col * a, a);
}
`;

// ---------------------------------------------------------------------------------------------
// Salt-haze band: a few huge, faint sprites drifting downwind over the surf zone and the gully.
const MIST_VERT = /* glsl */ `
precision highp float;
attribute vec4 aBase;   // (x, y, z, size)
attribute vec4 aParm;   // (phase, alpha, speed mul, cell/rot seed)
uniform float uWrap;
${COMMON_GLSL}
${ATMOSPHERE_GLSL}
varying vec2 vUv;
varying vec4 vCol;
varying vec4 vFade;
varying vec3 vMisc;
varying float vDense;
void main(){
  vec2 wd = normalize(uWindDir);
  float adv = uTime * 7.5 * 0.55 * aParm.z + aParm.x * uWrap;
  float f = fract(adv / uWrap);
  vec3 P = aBase.xyz + vec3(wd.x, 0.0, wd.y) * (f - 0.5) * uWrap;
  float env = sin(3.14159 * f); env *= env;
  // gentle breathing so the band never looks static
  float br = 0.75 + 0.25 * sin(uTime * (6.2832 * 120.0 / 3600.0) + aParm.w * 40.0); // 120 cycles per uTime loop
  vec2 fld = fieldAt(P.xz);
  float vis = smoothstep(fld.y - 3.0, fld.y + 3.0, P.y);
  vec3 V = normalize(P - cameraPosition);
  float ph = hgN(dot(V, uSunDir), 0.5);
  vec3 col = uShadeCol * 0.75 + uLitCol * vis * 0.5 * ph;
  vec4 at = atmosphereAlong(P);
  col = col * at.w + at.rgb * (1.0 - at.w);
  vec4 mv = viewMatrix * vec4(P, 1.0);
  float rot = (aParm.w - 0.5) * 0.3 + 0.08 * sin(uTime * (6.2832 * 7.0 / 3600.0) + aParm.w * 9.0);
  vec2 cn = position.xy;
  vec2 off = vec2(cos(rot) * cn.x - sin(rot) * cn.y, sin(rot) * cn.x + cos(rot) * cn.y) * aBase.w * vec2(1.6, 0.7);
  mv.xy += off;
  gl_Position = projectionMatrix * mv;
  vec3 camR = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 camU = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 Wf = P + camR * off.x + camU * off.y;
  vFade = vec4(Wf.x, Wf.z, Wf.y, 0.8);
  vMisc = vec3(0.35 * aBase.w, 0.0, 0.0);
  vDense = 0.0;
  vUv = (cn + 0.5) * 0.4 + 0.05 + (aParm.w < 0.5 ? vec2(0.0) : vec2(0.5, 0.5));
  vCol = vec4(col, aParm.y * env * br * uOpacity * (1.0 - smoothstep(700.0, 1200.0, -mv.z)));
}
`;

export default async function create(ctx) {
  const { THREE, scene, camera, uniforms, layout, quality, renderer } = ctx;
  const tier = quality.tier;
  const prog = (v, s) => ctx.progress(v, s || 'Spray');
  const oceanMod = ctx.modules.ocean || {};
  const T = oceanMod.params?.breakerPeriod || SURF.T;
  const LOOP = oceanMod.params?.loop || 1200;
  const Q = {
    high: { rockP: 84, slots: 64, breakP: 52, mist: 14, keep: 1.0, dMax: 1150 },
    medium: { rockP: 44, slots: 48, breakP: 18, mist: 10, keep: 0.7, dMax: 900 },
    low: { rockP: 22, slots: 36, breakP: 10, mist: 6, keep: 0.45, dMax: 700 },
  }[tier] || { rockP: 44, slots: 64, breakP: 30, mist: 14, keep: 1.0, dMax: 1150 };

  prog(0.05, 'Spray');
  const atlas = createSprayAtlas(THREE, tier === 'low' ? 64 : 128);

  // ---- sun / ground field ----
  const sd = uniforms.uSunDir.value;
  const field = await bakeSunField(layout, [sd.x, sd.y, sd.z], { minX: -200, maxX: 240, minZ: -520, maxZ: 70 }, tier === 'high' ? 2.5 : 4,
    async (f) => { prog(0.1 + 0.6 * f, 'Spray'); await nextFrame(); });
  const toHalf = THREE.DataUtils.toHalfFloat;
  const fd = new Uint16Array(field.w * field.h * 2);
  for (let k = 0; k < field.w * field.h; k++) { fd[2 * k] = toHalf(Math.max(-1, field.H[k])); fd[2 * k + 1] = toHalf(field.S[k]); }
  const fieldTex = new THREE.DataTexture(fd, field.w, field.h, THREE.RGFormat, THREE.HalfFloatType);
  fieldTex.minFilter = fieldTex.magFilter = THREE.LinearFilter;
  fieldTex.wrapS = fieldTex.wrapT = THREE.ClampToEdgeWrapping;
  fieldTex.needsUpdate = true;

  // ---- rock emitters ----
  const lut = buildTauLUT();
  try { lut.tex?.dispose?.(); } catch (e) { /* not needed */ }
  const wdir = ctx.config.ocean?.waveDir || [0.94, 0.34];
  const wl = Math.hypot(wdir[0], wdir[1]);
  const emitters = buildRockEmitters(layout, { T, p: SURF.p, line: SURF_LINE }, lut.tauAt, [wdir[0] / wl, wdir[1] / wl]);
  const nE = emitters.length;
  const emitData = new Float32Array(nE * 4 * 4);
  emitters.forEach((e, i) => {
    emitData.set([e.x, 0, e.z, e.t0], (0 * nE + i) * 4);
    emitData.set([e.nx, e.nz, e.expo, e.spacing], (1 * nE + i) * 4);
    emitData.set([e.cls, 0, 0, 0], (3 * nE + i) * 4);
  });
  const emitTex = new THREE.DataTexture(emitData, nE, 4, THREE.RGBAFormat, THREE.FloatType);
  emitTex.minFilter = emitTex.magFilter = THREE.NearestFilter;
  emitTex.needsUpdate = true;
  prog(0.8, 'Spray');

  // ---- breaker event slots ----
  const SLOTS = Q.slots;
  const evData = new Float32Array(SLOTS * 3 * 4);
  const evTex = new THREE.DataTexture(evData, SLOTS, 3, THREE.RGBAFormat, THREE.FloatType);
  // crest index and alongshore coordinate of an event (breakerEvents returns them as ev.crest; this
  // is the fallback for an ocean without it): the
  // shader evaluates the ocean's along-crest segmentation (segM) with them, so lip spray only rides
  // the pieces of a crest that actually carry whitewater
  const crestOf = (ev) => {
    const inner = ev.kind === 'inner';
    const sRef = ev.z + 0.35 * (inner ? 112 : 210);
    const i0 = Math.floor((ev.time + lut.tauAt(inner ? 114 : 170) - SURF.p * ev.z) / T) - 1;
    for (let i = i0; i <= i0 + 3; i++) {
      const d = inner ? 114 : OUTER_BREAK[0] + OUTER_BREAK[1] * crestJS(i, sRef);
      if (Math.abs(i * T - lut.tauAt(d) + SURF.p * ev.z - ev.time) < 0.01) return [i, ev.z + 0.35 * d];
    }
    return [-1, 0];
  };
  evTex.minFilter = evTex.magFilter = THREE.NearestFilter;
  evTex.needsUpdate = true;
  // shoreward direction at an alongshore position (beach waterline normal, pointing to land)
  const BW = layout.BEACH_WATERLINE;
  const shoreDirAt = (z) => {
    for (let i = 0; i < BW.length - 1; i++) {
      const [ax, az] = BW[i], [bx, bz] = BW[i + 1];
      if (z <= az && z >= bz) { const tx = bx - ax, tz = bz - az, l = Math.hypot(tx, tz); return [-tz / l, tx / l].map((v) => v * Math.sign(-tz || 1)); }
    }
    return [1, 0];
  };

  // ---- instanced sprite geometry (rock + breaker particles in one draw) ----
  const quad = new THREE.PlaneGeometry(1, 1);
  const inst = [];
  emitters.forEach((e, i) => {
    const n = Math.max(4, Math.round(Q.rockP * Math.min(1, 0.25 + 0.75 * e.expo)));
    for (let j = 0; j < n; j++) inst.push(i, j, 0, 0);
  });
  for (let s = 0; s < SLOTS; s++) for (let j = 0; j < Q.breakP; j++) inst.push(s, j, 1, 0);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = quad.index;
  geo.setAttribute('position', quad.getAttribute('position'));
  geo.setAttribute('aInst', new THREE.InstancedBufferAttribute(new Float32Array(inst), 4));
  geo.instanceCount = inst.length / 4;

  const litHDR = invAcesSRGB8(246, 238, 212), shadeHDR = invAcesSRGB8(188, 210, 225);
  const common = {
    uAtlas: { value: atlas },
    uField: { value: fieldTex },
    uFieldRect: { value: new THREE.Vector4(...field.rect) },
    uST: { value: 0 },
    uFocalPx: { value: 1000 },
    uLitCol: { value: new THREE.Vector3(...litHDR.map((v, i) => Math.max(0, v - shadeHDR[i]))) },
    uShadeCol: { value: new THREE.Vector3(...shadeHDR) },
    uWindU: { value: 7.5 },
    uOpacity: { value: 1.0 },
  };
  const shared = {
    uTime: uniforms.uTime, uWindDir: uniforms.uWindDir, uGust: uniforms.uGust, uWindSpeed: uniforms.uWindSpeed, uWindAdv: uniforms.uWindAdv,
    uSunDir: uniforms.uSunDir, uSunColor: uniforms.uSunColor, uHazeColor: uniforms.uHazeColor, uHazeSunColor: uniforms.uHazeSunColor,
    uHazeDensity: uniforms.uHazeDensity, uHazeFalloff: uniforms.uHazeFalloff,
  };
  const blendCfg = {
    transparent: true, depthWrite: false, depthTest: true,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
  };
  const mat = new THREE.ShaderMaterial({
    uniforms: { ...shared, ...common, uEmit: { value: emitTex }, uEvents: { value: evTex }, uPeriod: { value: T },
      uCycles: { value: Math.round(LOOP / T) }, uSwell: { value: new THREE.Vector2(wdir[0] / wl, wdir[1] / wl) }, uDbgK: { value: ctx.params.get('spraydebug') === 'kinds' ? 1 : 0 } },
    vertexShader: VERT,
    fragmentShader: FRAG,
    ...blendCfg,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 1; // after the opaque scene, before the trees' blended foliage fringe (2)
  mesh.name = 'spray';
  scene.add(mesh);

  // ---- mist band ----
  const NM = Q.mist;
  const MIST_WRAP = 120, MIST_U = 7.5 * 0.55; // m, m/s (must match uWrap and uWindU * 0.55 in MIST_VERT)
  const mb = new Float32Array(NM * 4), mp = new Float32Array(NM * 4);
  const rnd = (i, k) => hash2(i * 7 + 3, 5000 + k);
  for (let i = 0; i < NM; i++) {
    // gully and around the platform / rocks (salt haze after the surges). (The surf-zone band is left
    // to the atmosphere's analytic spray veil: sprites there read as lens-shaped patches.)
    const x = -30 + 130 * rnd(i, 1), z = -60 - 110 * rnd(i, 2), y = 2 + 7 * rnd(i, 3), s = 16 + 18 * rnd(i, 4), a = 0.04 + 0.03 * rnd(i, 5);
    mb.set([x, y, z, s], i * 4);
    // drift speed quantised so every sprite makes a whole number of wraps per 3600 s (uTime loop)
    const cyc = Math.round((3600 * MIST_U * (0.8 + 0.4 * rnd(i, 7))) / MIST_WRAP);
    mp.set([rnd(i, 6), a, (cyc * MIST_WRAP) / (3600 * MIST_U), rnd(i, 8)], i * 4);
  }
  const mgeo = new THREE.InstancedBufferGeometry();
  mgeo.index = quad.index;
  mgeo.setAttribute('position', quad.getAttribute('position'));
  mgeo.setAttribute('aBase', new THREE.InstancedBufferAttribute(mb, 4));
  mgeo.setAttribute('aParm', new THREE.InstancedBufferAttribute(mp, 4));
  mgeo.instanceCount = NM;
  const mmat = new THREE.ShaderMaterial({
    uniforms: { ...shared, ...common, uWrap: { value: MIST_WRAP } },
    vertexShader: MIST_VERT,
    fragmentShader: FRAG,
    ...blendCfg,
  });
  const mmesh = new THREE.Mesh(mgeo, mmat);
  mmesh.frustumCulled = false;
  mmesh.renderOrder = 0.5;
  mmesh.name = 'spray-mist';
  scene.add(mmesh);

  // debug hooks
  const dbg = ctx.params.get('spraydebug');
  if (dbg === 'off') { mesh.visible = false; mmesh.visible = false; }
  if (dbg === 'nomist') mmesh.visible = false;
  if (ctx.params.has('sprayop')) { common.uOpacity.value = Number(ctx.params.get('sprayop')); }

  const bufSize = new THREE.Vector2();
  let evCache = null;
  function schedule(t) {
    // rock surge strengths for the cycles around t (k mod 4 channels)
    const tl = ((t % LOOP) + LOOP) % LOOP;
    const row = 2 * nE * 4;
    for (let i = 0; i < nE; i++) {
      const e = emitters[i];
      const kc = Math.floor((tl - e.t0) / T);
      for (let k = kc - 2; k <= kc + 1; k++) {
        const A0 = crestJS(k + e.kOff, e.s);
        emitData[row + i * 4 + (((k % 4) + 4) % 4)] = 0.35 + 0.8 * A0;
      }
    }
    emitTex.needsUpdate = true;
    // breaker events whose particles may be alive now (born up to 3 s after the break, live <= 5 s)
    evData.fill(0);
    if (typeof oceanMod.breakerEvents === 'function') {
      // query a slightly wider window and reuse it for ~1 s of playback (the selection below is by
      // time only, so the result is the same as a fresh query; seeks re-query)
      if (!evCache || t - 7.5 < evCache.t0 || t + 0.05 > evCache.t1) {
        // static per-event selection (distance + a hash of the event): an event never pops in or
        // out mid-life because of the others
        evCache = {
          t0: t - 8.0, t1: t + 1.0,
          evs: oceanMod.breakerEvents(t - 8.0, t + 1.0).filter((ev) => ev.dist < Q.dMax
            && (ev.dist < 300 || hash2(Math.round(ev.time * 100) | 0, (Math.round(ev.z * 10) | 0) + 77) < Q.keep)),
        };
      }
      let evs = evCache.evs.filter((ev) => ev.time >= t - 7.5 && ev.time < t + 0.05);
      // (sorted by time; on overflow the oldest, already fading, events give way)
      if (evs.length > SLOTS) evs = evs.slice(evs.length - SLOTS);
      evs.forEach((ev, s) => {
        const sd2 = shoreDirAt(ev.z);
        const seed = hash2(Math.round(ev.time * 100) | 0, Math.round(ev.z * 10) | 0);
        evData.set([ev.x, ev.z, t - ev.time, ev.strength], s * 4);
        evData.set([sd2[0], sd2[1], seed, ev.kind === 'inner' ? 1 : 0], (SLOTS + s) * 4);
        if (ev.crest === undefined) ev.crest = crestOf(ev);
        evData.set([ev.crest[0], ev.crest[1], ev.crest[2] ?? 170, 0], (2 * SLOTS + s) * 4);
      });
    }
    evTex.needsUpdate = true;
    common.uST.value = tl;
  }
  schedule(0);
  prog(1, 'Spray');

  return {
    mesh,
    emitters,
    update(t) {
      schedule(t);
      renderer.getDrawingBufferSize(bufSize);
      const hpx = bufSize.y * (quality.scale || 1);
      common.uFocalPx.value = hpx / (2 * Math.tan((camera.fov * Math.PI) / 360));
      common.uWindU.value = 7.5;
    },
  };
}
