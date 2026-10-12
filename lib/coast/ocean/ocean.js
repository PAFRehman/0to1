// Ocean: GPU FFT wind sea (3 cascades) + analytic coastal surf, on a camera-centred polar grid.
// See fft.js (spectrum / FFT), coast.js (coastal field bake + surf LUT), surf.glsl.js (surf model),
// foamtex.js (procedural foam lace). Everything is a pure function of time.
import * as THREE from 'three';
import { createGridViewFilter } from '../core/view-grid.js';
import { ATMOSPHERE_GLSL, CURVATURE_GLSL } from '../core/atmosphere.js';
import { SKY_GLSL } from '../sky/skyModel.js';
import { createFFT, OCEAN_LOOP } from './fft.js';
import { bakeLevel, buildTauLUT, SURF, SURF_LINE } from './coast.js';
import { createFoamTexture, FOAM_TILE } from './foamtex.js';
import { COAST_GLSL, COASTB_GLSL, SURF_GLSL, crestStrength, crestTime, WW_OUTER, WW_INNER, OUTER_BREAK, BREAK_OFF, surfRipG, surfBreakOff } from './surf.glsl.js';
import { createNearBreakers, NBK_GLSL, NBK_FRAG_GLSL } from './nearbreak.js';

const GULLY = [
  [-14, -28], [4, -37], [22, -37], [48, -42], [66, -54], [86, -80], [102, -112], [116, -150],
  [80, -140], [40, -137], [6, -140], [-12, -156], [-22, -140], [-22, -100],
];

function buildGrid(rings, segs, halfAngleDeg, h, rMin, rMax) {
  const aMax = Math.atan(h / rMin), aMin = Math.atan(h / rMax);
  const pos = new Float32Array(rings * segs * 3);
  const spacing = new Float32Array(rings * segs);
  const half = (halfAngleDeg * Math.PI) / 180;
  const dTh = (2 * half) / (segs - 1);
  // alpha spacing: uniform in depression angle (≈ uniform screen rows), slightly denser near horizon
  const rs = [];
  for (let i = 0; i < rings; i++) {
    const f = i / (rings - 1);
    const a = aMax + (aMin - aMax) * Math.pow(f, 0.85);
    rs.push(h / Math.tan(a));
  }
  for (let i = 0; i < rings; i++) {
    const r = rs[i];
    const dr = i < rings - 1 ? rs[i + 1] - r : r - rs[i - 1];
    for (let j = 0; j < segs; j++) {
      const th = -half + j * dTh;
      const k = i * segs + j;
      pos[k * 3] = r * Math.sin(th);
      pos[k * 3 + 1] = 0;
      pos[k * 3 + 2] = -r * Math.cos(th);
      spacing[k] = Math.max(dr, r * dTh);
    }
  }
  const idx = new Uint32Array((rings - 1) * (segs - 1) * 6);
  let o = 0;
  for (let i = 0; i < rings - 1; i++) {
    for (let j = 0; j < segs - 1; j++) {
      const a = i * segs + j, b = a + 1, c = a + segs, d = c + 1;
      idx[o++] = a; idx[o++] = b; idx[o++] = c;
      idx[o++] = b; idx[o++] = d; idx[o++] = c;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aSpacing', new THREE.BufferAttribute(spacing, 1));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  return g;
}

const NOISE_GLSL = /* glsl */ `
float hash11(float p){ p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float macroNoise(vec2 p){
  vec2 i = floor(p), f = fract(p); vec2 u = f*f*(3.0-2.0*f);
  vec2 i0 = mod(i, 256.0), i1 = mod(i + 1.0, 256.0);
  float a = hash11(i0.x + i0.y * 57.0), b = hash11(i1.x + i0.y * 57.0);
  float c = hash11(i0.x + i1.y * 57.0), d = hash11(i1.x + i1.y * 57.0);
  return mix(mix(a,b,u.x), mix(c,d,u.x), u.y);
}
`;

const VERT = /* glsl */ `
${CURVATURE_GLSL}
${COAST_GLSL}
${COASTB_GLSL}
${SURF_GLSL}
${NOISE_GLSL}
${NBK_GLSL}
uniform sampler2D uDisp0; uniform sampler2D uDisp1; uniform sampler2D uDisp2;
uniform sampler2D uDeriv0;
uniform vec3 uLen;
uniform float uFFTAmp;
uniform float uN;
uniform float uNbThr;
uniform vec2 uWaveDir;
attribute float aSpacing;
varying vec3 vWorld;
varying vec2 vXZ;
varying float vFftY;
varying float vSurfY;


void main(){
  vec3 wp = (modelMatrix * vec4(position, 1.0)).xyz;
  vec2 xz = wp.xz;
  vec4 cA = coastA(xz);
  float depth = cA.y;
  // the wind sea is only damped toward the BEACH surf line: under the headland (where the extended
  // surf line runs through deep water) it keeps its full amplitude
  vec4 cBv = coastB(xz);
  float beachG = smoothstep(30.0, 10.0, cBv.z - cA.x);
  float dBe = mix(400.0, cA.x, beachG);
  float att = smoothstep(-0.3, 7.0, depth) * mix(0.35, 1.0, smoothstep(40.0, 160.0, dBe));
  // (near field: a submerged shoal off the headland — the wash rock 1-2 m down — keeps its wind sea;
  // the depth damping is for the beach, over the reef it drew a flat, dark slick. Same in FRAG)
  att = max(att, smoothstep(-0.3, 1.2, depth) * smoothstep(3.0, 8.0, cA.z) * (1.0 - beachG) * smoothstep(320.0, 220.0, length(cameraPosition.xz - xz)));
  float macro = 0.8 + 0.4 * macroNoise(xz / 900.0 + 3.7);
  vec3 D = vec3(0.0);
  float l0 = log2(max(aSpacing / (uLen.x / uN), 1.0));
  float l1 = log2(max(aSpacing / (uLen.y / uN), 1.0));
  float l2 = log2(max(aSpacing / (uLen.z / uN), 1.0));
  D += textureLod(uDisp0, xz / uLen.x, l0).xyz * macro;
  if (l1 < 9.0) D += textureLod(uDisp1, xz / uLen.y + 0.37, l1).xyz;
  if (l2 < 9.0) D += textureLod(uDisp2, xz / uLen.z + 0.71, l2).xyz;
  D *= att * uFFTAmp;
  float distF = length(cameraPosition.xz - xz);
#ifndef OCEAN_LQ
  // near-field breakers (see FRAG nbField): the spilling crest stands proud as a roller hump with a
  // short lip thrown forward
  float nbM = smoothstep(420.0, 260.0, distF) * (1.0 - cA.w) * smoothstep(1.5, 4.0, depth)
            * (1.0 - beachG * smoothstep(330.0, 230.0, cA.x))
            * smoothstep(170.0, 250.0, distF); // (closer: nearbreak.js breakers; no flat slabs)
  if (nbM > 0.0) {
    vec4 e0 = textureLod(uDeriv0, xz / uLen.x, l0 + 1.5) * macro * att * uFFTAmp;
    float J0 = (1.0 + e0.z) * (1.0 + e0.w);
    vec2 xzr = vec2(xz.y, -xz.x);
    float gB = smoothstep(0.1, 0.4, textureLod(uDisp0, xzr / (uLen.x * 0.45) + 0.29, l0 + 2.0).y);
    float thrN = uNbThr + 0.05 * smoothstep(12.0, 5.0, depth); // shoaling: steeper in 5-10 m of water
    float nbv = smoothstep(thrN, thrN - 0.06, J0) * gB * nbM;
    D.y += nbv * 0.75;
    D.xz += uWaveDir * nbv * 0.9;
  }
#endif
  // ---- near-field breakers (nearbreak.js): individual crests under the headland steepen into an
  // asymmetric forward-leaning profile, pitch a lip forward and carry a lumpy whitewater roller
#ifndef OCEAN_LOW
  if (distF < 270.0) {
    float nbkG = smoothstep(270.0, 210.0, distF) * (1.0 - cA.w) * smoothstep(2.0, 5.0, depth) * smoothstep(2.0, 8.0, cA.z) * (1.0 - beachG);
    if (nbkG > 0.0) {
      for (int i = 0; i < NBK_N; i++) {
#ifdef OCEAN_LQ
        if (i >= 3) break; // (medium: the three strongest events, slots 0-2, as in the fragment)
#endif
        vec4 e0 = uNbk0[i]; vec4 e1 = uNbk1[i]; vec4 e2 = uNbk2[i];
        if (e0.w <= 0.0) continue;
        vec2 abN = nbkLocal(xz, e0, e2); // (each event carries its own world frame)
        float b = abN.y, a = abN.x;
        if (b < -40.0 || b > 16.0 || abs(a) > e1.x + 20.0 + 2.5 * e0.w) continue;
        vec2 hs = nbkShape(a, b, e0, e1, aSpacing);
        D.y += hs.x * nbkG;
        D.xz += e2.xy * hs.y * nbkG;
      }
    }
  }
#endif
  float sy = surfHeight(xz, cA.x, cA.z, cA.y, aSpacing, beachG,
                        14.0 * (macroNoise(xz / 6.0 + 2.7) - 0.5) * (1.0 - smoothstep(2.0, 5.0, aSpacing)), smoothstep(300.0, 1300.0, distF), cBv.xy);
  // swash: raise the thin sheet near the waterline so the edge runs up and down the beach
  vFftY = D.y;
  vSurfY = sy;
  wp.xz += D.xz;
  wp.y = D.y + sy;
  vXZ = xz;
  wp = earthCurve(wp);
  vWorld = wp;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;

const FRAG = /* glsl */ `
${ATMOSPHERE_GLSL}
${SKY_GLSL}
${COAST_GLSL}
${COASTB_GLSL}
${SURF_GLSL}
${NOISE_GLSL}
uniform sampler2D uDeriv0; uniform sampler2D uDeriv1; uniform sampler2D uDeriv2;
uniform sampler2D uDisp0; uniform sampler2D uDisp1;
uniform float uNbThr;
uniform vec3 uLen;
uniform float uFFTAmp;
uniform sampler2D uFoam;
uniform float uFoamTile;
uniform vec2 uWaveDir;
uniform vec2 uWindDir;
uniform float uGust;
uniform vec3 uDeep; uniform vec3 uMid; uniform vec3 uShallow; uniform vec3 uCrest; uniform vec3 uMilky; uniform vec3 uAerated;
uniform vec3 uFoamSky;
uniform float uReflScale; uniform float uFresMax;
uniform float uWcThresh;
uniform float uSlopeGain;
uniform float uDebug;
varying vec3 vWorld;
varying vec2 vXZ;
varying float vFftY;
varying float vSurfY;
${NBK_GLSL}
${NBK_FRAG_GLSL}

float cov(float lace, float c, float soft){
  // coverage threshold on the lace field: c=1 -> solid, c->0 -> only filaments
  return smoothstep(1.0 - c - soft * 0.5, 1.0 - c + soft, lace) * mix(0.45, 1.0, clamp(c * 1.4, 0.0, 1.0));
}

// Jacobian of the breaking-scale chop (cascades 0+1) at xz
float jac01(vec2 q, float macro, float att){
  // mip bias: breaking is judged on the smoothed chop -> fewer, larger, coherent whitecaps
  vec4 d = (texture(uDeriv0, q / uLen.x, 1.0) * macro + 0.7 * texture(uDeriv1, q / uLen.y + 0.37, 1.6)) * att * uFFTAmp;
  return (1.0 + d.z) * (1.0 + d.w);
}

void main(){
  vec2 xz = vXZ;
  vec4 cA = coastA(xz);
  vec4 cB = coastB(xz);
  float dB = cA.x, depth = cA.y, dR = cA.z, gully = cA.w;
  float dBt = cB.z; // true distance to the beach waterline
  float beachG = smoothstep(30.0, 10.0, dBt - dB);
  float dBe = mix(400.0, dB, beachG); // (damping toward the beach surf line only, see VERT)
  float att = smoothstep(-0.3, 7.0, depth) * mix(0.35, 1.0, smoothstep(40.0, 160.0, dBe));
  att = max(att, smoothstep(-0.3, 1.2, depth) * smoothstep(3.0, 8.0, dR) * (1.0 - beachG) * smoothstep(320.0, 220.0, length(cameraPosition.xz - xz))); // (submerged shoal, see VERT)
  float macro = 0.8 + 0.4 * macroNoise(xz / 900.0 + 3.7);

  // ---- FFT slopes + Jacobian ----
  vec4 d0 = texture(uDeriv0, xz / uLen.x) * vec4(macro);
  vec4 d1 = texture(uDeriv1, xz / uLen.y + 0.37);
#ifdef OCEAN_LOW
  vec4 d2 = length(cameraPosition.xz - xz) < 300.0 ? texture(uDeriv2, xz / uLen.z + 0.71) : vec4(0.0);
#else
  vec4 d2 = texture(uDeriv2, xz / uLen.z + 0.71);
#endif
  float distF = length(cameraPosition.xz - xz);
  float w1n = 1.0 - 0.55 * smoothstep(250.0, 1500.0, distF);
  // short wind waves / capillaries (cascade 2: 6 cm - 1.3 m): full weight wherever the pixel footprint
  // resolves them — the trilinear/anisotropic mips average the sub-pixel part away (no sparkle), so
  // only a gentle distance taper (the mip mean of the choppy slopes is not zero-mean far out)
  float w2n = mix(0.6, 0.2, smoothstep(250.0, 500.0, distF)) * (1.0 - smoothstep(900.0, 2500.0, distF));
  vec4 dsum = (d0 + d1 + d2) * att * uFFTAmp;
  // far out the shading leans a little more on the shorter chop (slower texture trace speed)
  float w0s = mix(1.0, 0.7, smoothstep(200.0, 800.0, distF));
  // near field: the short wind waves (cascades 1-2, 0.1-40 m) carry the crisp small-scale texture of
  // the reference (measured 1.5 px detail near 9.0 vs 5.1-5.5): extra shading-only slope gain
  float nearG = mix(1.45, 1.0, smoothstep(150.0, 400.0, distF));
  // (closest in, under the cliffs, the reference water reads smooth — long swell faces and fine
  // streaks, no crinkly fine chop: the extra gain fades out inside ~200 m)
  nearG *= mix(0.68, 1.0, smoothstep(100.0, 220.0, distF));
  vec4 dshade = (d0 * w0s + (d1 * w1n * mix(0.7, 1.1, smoothstep(80.0, 400.0, distF)) + d2 * w2n) * nearG) * att * uFFTAmp;
  float normAtt = mix(0.3, 1.0, smoothstep(40.0, 110.0, dBe));
  vec2 slope = dshade.xy / max(1.0 + dsum.zw, vec2(0.3)) * normAtt * uSlopeGain * mix(1.0, 1.1, smoothstep(300.0, 2000.0, distF)) * mix(1.0, 0.35, smoothstep(3000.0, 10000.0, distF));
  float J = (1.0 + dsum.z) * (1.0 + dsum.w);
  // near field: the rolling wind waves (cascade 0, 7-70 m) carry the big light/dark relief of the
  // reference (grey-blue sky-mirroring backs, dark teal faces): extra shading weight on their slope
  slope += d0.xy * att * uFFTAmp * 0.35 * normAtt * smoothstep(320.0, 100.0, distF) / max(1.0 + dsum.zw, vec2(0.3));

  // ---- surf ----
  SurfPhase P = surfPhase(xz, dB, dR);
  bool front = P.u > 0.5;
  float idxN = front ? P.i0 + 1.0 : P.i0;
  float du = front ? P.u - 1.0 : P.u;
  float AN = crestStrength(idxN, P.s);
  float A0 = crestStrength(P.i0, P.s);
  float A1 = crestStrength(P.i0 + 1.0, P.s);
  // (north end: the break / zone distances are measured from the shifted line, see surfBreakOff)
  float dBo = dB - surfBreakOff(P.s);
  float steep = smoothstep(outerBreakD(AN) + 60.0, outerBreakD(AN), dBo) * smoothstep(0.35, 0.55, AN);
  steep = max(steep, smoothstep(160.0, 118.0, dBo) * smoothstep(60.0, 100.0, dBo));
  float amp = crestAmp(dBo, AN);
  vec2 gradPsi = (P.tauP * cB.xy - vec2(0.0, uSurfP)) / uSurfT;
  vec2 surfSlope = amp * crestShapeD(du, steep, 1.5 * fwidth(P.psi)) * gradPsi;
  surfSlope *= min(1.0, 0.5 / max(length(surfSlope), 1e-5)); // no mirror-like crest faces
  float surfG = step(0.0, dB) * (dB < 1400.0 ? 1.0 : 0.0);
  slope += surfSlope * surfG;
  // reflection normal: the crest faces tilt the reflected ray sideways toward the (off-frame) sun
  // azimuth, whose warm horizon sky drew a thin gold contour along every crest front of the inner
  // surf (any residual tilt there still showed). Cap the crest's share of the reflection tilt (none
  // inside the outer bar); relief shading and foam lighting keep the full crest slope.
  float sCap = 0.2 * smoothstep(120.0, 200.0, dB);
  // (near field under the cliffs: the rolling swell does tilt the reflection — the warm tint that drew
  // the gold contours is removed from the reflection below)
  sCap = max(sCap, 0.4 * smoothstep(320.0, 120.0, distF) * smoothstep(40.0, 70.0, dB));
  vec2 slopeR = slope - surfSlope * surfG * (1.0 - min(1.0, sCap / max(length(surfSlope), 1e-5)));

  // ---- near-field breakers (nearbreak.js): relief of the breaking crests (see the composite below)
  NbkOut NB; NB.grad = vec2(0.0); NB.cov = 0.0; NB.col = vec3(0.0); NB.trans = 0.0; NB.aer = 0.0;
  vec2 nbkDX = dFdx(xz), nbkDY = dFdy(xz);
#ifndef OCEAN_LOW
  float nbkG = smoothstep(270.0, 210.0, distF) * (1.0 - gully) * smoothstep(2.0, 5.0, depth) * smoothstep(2.0, 8.0, dR) * (1.0 - beachG);
  if (nbkG > 0.0) {
    vec2 fwdN = -normalize(gradPsi + 1e-6);
    vec2 aDirN = normalize(vec2(0.0, 1.0) + 0.35 * cB.xy);
    NB = nbkFrag(xz, P.psi, P.s, uSurfT / max(P.tauP, 0.05), fwdN, aDirN, nbkDX, nbkDY);
    NB.cov *= nbkG; NB.trans *= nbkG; NB.aer *= nbkG;
    vec2 gN = NB.grad * nbkG;
    gN *= min(1.0, 0.9 / max(length(gN), 1e-5)); // (no mirror-like faces)
    slope += gN; slopeR += gN;
  }
#endif
  vec3 N = normalize(vec3(-slopeR.x, 1.0, -slopeR.y));
  vec3 V = normalize(cameraPosition - vWorld);
  float dist = length(cameraPosition - vWorld);
  float nearSoft = 0.05 * smoothstep(160.0, 50.0, dist);

  // ---- foam fields ----
  float crestH = vFftY * 0.55 * smoothstep(900.0, 250.0, dist) + vSurfY * 0.8;
  float age = P.u * uSurfT;
  // beach-type surf (inner-bar break, swash, milky water, shallow tint) belongs to the beach, not to
  // the rock shelf under the headland (where the straight surf-line extension is much nearer than the beach)
  // every crest breaks in 20-150 m pieces separated by clear water (mask thresholds the coverage)
  // lumpy along the crest (4-20 m), so distant rollers are not flat slabs
  float iL = mod(P.i0, 120.0); // crest index, periodic with the 1200 s loop
  float iN = mod(idxN, 120.0);  // (the crest this pixel belongs to: ahead of or behind it)
  // pixel footprint along the crest line (m of s per pixel): the crests run nearly along the view
  // direction, so every along-crest noise fades to its mean before it aliases into dotted rows
  vec2 gPs = vec2(dFdx(P.psi), dFdy(P.psi)), gSs = vec2(dFdx(P.s), dFdy(P.s));
  float fsA = abs(gSs.y * gPs.x - gSs.x * gPs.y) / max(length(gPs), 1e-7);
  #define SAA(L) (1.0 - smoothstep(0.3, 0.8, fsA / (L)))
  // world-space footprint (the range direction far out: ~30 m per pixel at 1 km)
  vec2 fdX = dFdx(xz), fdY = dFdy(xz);
  float fpR = max(length(fdX), length(fdY));
  #define WAA(L) (1.0 - smoothstep(0.3, 0.8, fpR / (L)))
  float lump = 0.5 + (macroNoise(vec2(P.s / 9.0, iN * 3.1)) - 0.5) * 0.6 * SAA(9.0) + (macroNoise(vec2(P.s / 3.5, iN * 1.7 + 9.0)) - 0.5) * 0.4 * SAA(3.5);
  // the break point wanders along the crest (no ruler-straight seaward edge)
  // (each crest carries its own jitter: W1 of the crest ahead uses that crest's seed, so a crest's
  // whitewater is continuous across its line, where the pixel switches from W1 to W0)
  float iL1 = mod(P.i0 + 1.0, 120.0);
  float jA = (26.0 + 22.0 * smoothstep(120.0, 70.0, dB)) * SAA(20.0);
  float dJ = dBo + jA * (macroNoise(vec2(P.s / 20.0, iL * 2.3 + 4.0)) - 0.5);
  float dJ1 = dBo + jA * (macroNoise(vec2(P.s / 20.0, iL1 * 2.3 + 4.0)) - 0.5);
  float sJ = P.s + 14.0 * (macroNoise(xz / 6.0 + 2.7) - 0.5) * WAA(6.0); // ragged segment ends
  float segGap = smoothstep(300.0, 1300.0, distF);
  // off the headland / reef (no sand bar) the crests break in short, scattered pieces (10-30 m)
  // with more clear water between them, not in long beach-style lines (same in surfHeight)
  sJ *= mix(2.2, 1.0, beachG);
  segGap = max(segGap, 0.45 * (1.0 - beachG));
  float fsJ = fsA * mix(2.2, 1.0, beachG);
  float fdB = fwidth(dB);
  float depthO = depth - 0.07 * (dB - dBo); // (the bar's depth gates, shifted with the break line)
  float ww0 = whiteW(dJ, A0, depthO, beachG, fdB);
  float W0 = ww0 * segM(P.i0, sJ, segGap, dBo, fsJ);
  float W1 = whiteW(dJ1, A1, depthO, beachG, fdB) * segM(P.i0 + 1.0, sJ, segGap, dBo, fsJ);
  // previous crest's residue lace: approximated by this crest's pieces (a whole crest evaluation
  // less per pixel; the old lace then also leaves clear water where this crest has none)
  float Wp = 0.7 * W0;
  // (near field under the headland: the breaking there is carried by the individual breakers of
  // nearbreak.js; the swell-crest whitewater is only a faint remnant there, no flat white patches)
  float nbkZ = 0.75 * smoothstep(210.0, 150.0, distF) * (1.0 - beachG);
  // (rip channel by the headland, left of the platform within ~140-180 m: no surf whitewater, see
  // surfRipG — the slabs the beach bores painted there were not in the reference)
  float ripG = surfRipG(xz);
  nbkZ = 1.0 - (1.0 - nbkZ) * ripG;
  W0 *= 1.0 - nbkZ; W1 *= 1.0 - nbkZ; Wp *= 1.0 - nbkZ; ww0 *= ripG;
  // behind the platform the beach (and every crest line parallel to it) bends toward the camera: a
  // bore there projects as a steep, bright vertical 'hook' the reference never shows. The beach
  // whitewater fades where its crest projects steeper than ~27-45 deg on screen (analytic, smooth:
  // crest tangent vs view ray; same gate on the vertex bores, see surfHeight)
  // (also off the beach beyond the near-breaker field: a crest wrapping toward the camera there drew
  // the same curled stroke)
  float alignF = mix(1.0, crestViewGate(xz, gradPsi, cameraPosition), max(beachG, smoothstep(190.0, 230.0, distF)) * smoothstep(12.0, 30.0, dB));
  W0 *= alignF; W1 *= alignF; Wp *= alignF; ww0 *= alignF;
  // spreading whitewater: an old bore's sheet spreads along the crest past the ends of its piece and
  // lingers as a soft milky veil over the beach surf zone (patchy, see veil below)
  float Wv = ww0 * mix(0.35, 1.0, min(W0 / max(ww0, 1e-3), 1.0)) * (1.0 - nbkZ) * beachG;
  // ragged bore front: the whitewater fades in over 0.05-2.25 s behind the phase line (varies along the crest)
  // (never sharper than ~1.5 px: a sub-pixel front along a shallow crest line rasterises as a dashed
  // 'zipper' staircase; fwidth of the continuous phase gives the pixel footprint in seconds of age)
  float fwU = fwidth(P.psi);
  // the whitewater face of the broken crest (ahead of the phase line: the bore front the vertex
  // shader ramps over >= 1.6 grid rings, ~2.9 px of phase) continues without a gap into the head
  // behind it; its leading edge is ragged (0.7-1.6 face widths, varies along the crest) and soft
  // (the face of a ~2 m wall spans ~2000/dist px: the face band is that many pixels of phase, capped)
  float fwF = min(max(0.04, fwU * clamp(1800.0 / dist, 1.3, 2.9)), 0.14);
  float ragF = 0.5 + (macroNoise(vec2(P.s / 6.0, iN * 1.9 + 3.0)) - 0.5) * SAA(6.0);
  // (the face reaches furthest ahead in the core of each piece and shrinks toward its ends, so every
  // head is a soft hump, not a straight-edged slab)
  // (the lip continues across the phase line and hands over to the head / sheet over >= 2 px of
  // phase: everything that starts at the line ramps in, so no 1-px step / staircase along it)
  float rampU = max(2.0 * fwU, 0.012);
  float xf = smoothstep(0.0, rampU, P.u);
  float Wn = front ? W1 : W0;
  // (head / roller / sheet start at full strength on the line and ramp in over >= 2 px AHEAD of it:
  // the white piece keeps its brightness, its leading edge is never a 1-px step)
  float xr = front ? smoothstep(-rampU, 0.0, du) : 1.0;
  float ageP = front ? 0.0 : age;
  float faceE = -fwF * (0.3 + 1.3 * smoothstep(0.15, 0.9, Wn)) * (0.75 + 0.5 * ragF);
  float lip = Wn * smoothstep(faceE - 1.5 * fwU, faceE + 0.6 * fwF + 1.5 * fwU, du) * (front ? 1.0 : 1.0 - xf);
  lip *= smoothstep(0.25, 0.6, lump) * mix(0.55, 1.0, smoothstep(60.0, 95.0, dB));
  // the roller: a soft bright head (brightest in the core of each piece, W0 tapers toward the ends)
  // over the first ~1-1.5 s (8-12 m) behind the front, its back edge torn by the lump noise
  // (far out each head / roller is widened in phase to >= 2 px, partly energy-kept: no 1-px slivers)
  float fwT = 2.0 * fwU * uSurfT;
  float tR = max(1.5, fwT);
  float roller = Wn * xr * exp(-ageP / tR) * sqrt(1.5 / tR) * smoothstep(0.2, 0.6, lump);
  // (farther out the head also stands as a wall + spray above the bore: its projection is taller than
  // its footprint on the water, measured 3-5 px heads at 0.6-1 km, not 1-2 px slivers)
  // (a crest that has just broken over the outer bar — its first ~15-50 m — plunges: a taller,
  // brighter head than the bore it becomes; measured distinct bright strokes along the outer band)
  float dON = outerBreakD(AN), dJN = front ? dJ1 : dJ;
  float freshO = smoothstep(dON + 4.0, dON - 6.0, dJN) * smoothstep(dON - 55.0, dON - 18.0, dJN) * smoothstep(0.3, 0.5, AN);
  // the tall, sun-lit wall of a breaking piece is short (5-15 m peaks along the crest, measured
  // 10-20 px heads); the rest of the piece is the lower, translucent sheet
  float hSeg = mix(0.5, smoothstep(0.38, 0.68, macroNoise(vec2(P.s / 5.5, iN * 2.9 + 1.3))), SAA(5.5));
  // (beyond ~250 m the measured heads are compact, isolated bright curls (15-30 px wide, 6-10 px
  // tall: the lip + spray wall stands up) over faint lines: concentrated in the hSeg peaks, taller
  // there, and the long sheet between them fainter)
  float cmpH = smoothstep(250.0, 450.0, dist) * SAA(5.5);
  float tH = (0.6 + 0.9 * lump) * (0.5 + 0.8 * min(Wn, 1.0)) * mix(1.0, 2.1, smoothstep(250.0, 850.0, dist)) * (1.0 + 0.9 * freshO)
           * mix(1.0, mix(0.7, 1.6, hSeg), cmpH);
  float tHw = max(tH, fwT);
  float head = Wn * xr * exp(-ageP / tHw) * sqrt(tH / tHw) * smoothstep(0.25, 0.6, lump) * smoothstep(0.3, 0.7, Wn) * (1.0 + 0.8 * freshO);
  head *= mix(mix(0.4, 1.3, hSeg), mix(0.15, 1.8, hSeg * hSeg), cmpH); // (measured: distinct short bright heads along most broken crests)
  roller *= mix(0.5, 1.0, hSeg);
  lip *= mix(0.45, 1.15, hSeg) * mix(1.0, 0.6, cmpH);
  // translucent whitewater for ~1.5-3 s (12-25 m) behind the head (varies piece to piece), then
  // streaky lace fading over ~50 m
  // (beach surf zone between the gutter and the outer break: the broken sheets spread wide and
  // linger — measured a broad pale, lacy band there (x 500-600, rows 200-240: L 152, sd 36, p95 224))
  // (measured across the beach surf at row 215: outer edge ~220 m, dense pale band 160-200 m (L 160-
  // 185), darker gutter 110-140 m (L 126-139), inner plateau 30-90 m (L 147-153))
  float sprZ = beachG * smoothstep(140.0, 160.0, dBo) * smoothstep(250.0, 215.0, dBo);
  float gutE = beachG * smoothstep(100.0, 115.0, dBo) * smoothstep(155.0, 140.0, dBo) * (1.0 - 0.5 * surfBreakOff(P.s) / ${BREAK_OFF[0].toFixed(1)});
  float surfCov = Wn * xr * mix(1.5, 1.85, sprZ) * (1.0 - 0.45 * gutE) * mix(1.0, 0.8, cmpH) * exp(-ageP / (mix(3.4, mix(5.6, 7.5, sprZ), beachG) * mix(0.6, 1.4, lump)));
  // (old lace fades out just ahead of the next line and the new one ramps in behind it: the old
  // crest's pieces and the new one's differ, a hard switch drew straight seams along the lines)
  float xfE = xf * (1.0 - smoothstep(0.8, 1.0, P.u));
  float sheetL = (W0 * (0.9 * exp(-age / 11.0) + 0.25 * exp(-age / 24.0)) + 0.4 * Wp * exp(-(age + uSurfT) / 12.0)) * xfE;
  float aer = (W0 * exp(-age / 5.5) + 0.2 * Wp * exp(-(age + uSurfT) / 5.5)) * xfE; // (clear turquoise gaps between the lines)

  // flow: shoreward drift in the surf, slow downwind drift offshore (two-phase flow map: pure f(t))
  vec2 shoreDir = -cB.xy;
  vec2 wd = normalize(uWindDir);
  float surfZ = smoothstep(430.0, 260.0, dB);
  vec2 flowV = mix(uWaveDir * 0.35, shoreDir * 1.1, surfZ);
  // streak orientation: along the wind offshore, along the crest lines in the surf
  vec2 crestT = normalize(vec2(-shoreDir.y, shoreDir.x) + 1e-4);
  vec2 fdir = normalize(mix(wd, crestT * sign(dot(crestT, wd) + 1e-3), surfZ));
  vec2 fper = vec2(-fdir.y, fdir.x);
  const float PF = 6.0;
  float cy0 = floor(uOT / PF), cy1 = floor(uOT / PF + 0.5);
  float ph0 = uOT / PF - cy0, ph1 = uOT / PF + 0.5 - cy1;
  float wA = 1.0 - abs(2.0 * ph0 - 1.0), wBl = 1.0 - wA;
  vec2 oA = vec2(hash11(mod(cy0, 200.0) * 1.7 + 0.3), hash11(mod(cy0, 200.0) * 3.1 + 5.0)) * 97.0;
  vec2 oB = vec2(hash11(mod(cy1, 200.0) * 1.7 + 0.3), hash11(mod(cy1, 200.0) * 3.1 + 5.0)) * 97.0;
  vec2 pA = xz - flowV * ph0 * PF + oA;
  vec2 pB = xz - flowV * ph1 * PF + oB;
  vec4 fA = texture(uFoam, pA / uFoamTile, 0.5);
  vec4 fB = texture(uFoam, pB / uFoamTile, 0.5);
  // streaks: texture u axis along the flow
  const float ST = 1.6;
  vec4 sA = texture(uFoam, vec2(dot(pA, fdir), dot(pA, fper)) / (uFoamTile * ST) + 0.31, 0.5);
  vec4 sB = texture(uFoam, vec2(dot(pB, fdir), dot(pB, fper)) / (uFoamTile * ST) + 0.31, 0.5);
  float nrm = inversesqrt(wA * wA + wBl * wBl);
  vec4 f1 = (fA * wA + fB * wBl - 0.47) * nrm + 0.47;   // variance-preserving blend
  vec4 f2 = (sA * wA + sB * wBl - 0.44) * nrm + 0.44;
  vec4 f3 = texture(uFoam, xz / (uFoamTile * 0.31) + 0.53);
  float lace = f1.r;
  float streak = f2.a;
  // near field: a finer octave of the foam (2.6 m tile: 8-30 cm clots, bubbles, holes), same flow
  float fineT = 0.47;
  float nearF = smoothstep(260.0, 110.0, length(cameraPosition - vWorld));
#ifndef OCEAN_LOW
  if (nearF > 0.0) {
    vec4 gA = texture(uFoam, pA / (uFoamTile * 0.11) + 0.19);
    vec4 gB = texture(uFoam, pB / (uFoamTile * 0.11) + 0.61);
    fineT = mix(0.47, (0.6 * gA.r + 0.4 * gA.g) * wA + (0.6 * gB.r + 0.4 * gB.g) * wBl, nearF);
  }
#endif
  float patchN = f1.b;
  float bub = f3.g;
  // fine lace (0.5-1 m filaments) mixed into the thin-foam threshold: thin foam is never a flat fill
  float fl = mix(mix(f3.r, fineT, 0.5 * nearF), 0.47, smoothstep(150.0, 450.0, dist)); // (near: finer 8-30 cm threads)
  // near-field wind streaks (reference rows 450-700): the old foam under the cliffs is drawn out into
  // long, fine white threads (5-30 m long, 0.2-0.5 m wide) running along the wind — near-horizontal
  // on screen — bent into slow swirls, gathered in patches with clear turquoise between (measured
  // 18-32% > 150 near the bottom-left). Streak channel stretched a further ~4x along the flow, its
  // ridges thresholded; widened to the pixel footprint (fwidth) so a thread never breaks into dashes
  float nStk = 0.0;
#ifndef OCEAN_LOW
  float stZ = smoothstep(330.0, 190.0, dist) * (1.0 - beachG) * (1.0 - gully);
  if (stZ > 0.0) {
    vec2 sw = vec2(macroNoise(xz / 37.0 + 2.2), macroNoise(xz / 37.0 + 7.9)) - 0.5;
    vec2 sw2 = vec2(macroNoise(xz / 13.0 + 5.1), macroNoise(xz / 13.0 + 1.4)) - 0.5;
    vec2 qS = xz + 14.0 * sw + 3.0 * sw2;
    vec2 sdr = normalize(vec2(1.0, -0.12) + 0.5 * vec2(sw.y, -sw.x)); // (swirls: the thread direction turns with the warp)
    vec2 spr = vec2(-sdr.y, sdr.x);
    vec2 qA = qS - flowV * ph0 * PF + oA, qB = qS - flowV * ph1 * PF + oB;
    const float SL_ = 7.0, SC_ = 2.4;
    float s1 = texture(uFoam, vec2(dot(qA, sdr) / (uFoamTile * SL_), dot(qA, spr) / (uFoamTile * SC_)) + 0.41).a;
    float s2 = texture(uFoam, vec2(dot(qB, sdr) / (uFoamTile * SL_), dot(qB, spr) / (uFoamTile * SC_)) + 0.67).a;
    float fwS = max(fwidth(s1), fwidth(s2));
    float thr0 = 0.5 - 0.08 * patchN;
    float aaS = 1.0 - smoothstep(0.08, 0.2, fwS);
    float stTh = (smoothstep(thr0 - 0.01 - fwS, thr0 + 0.05 + fwS, s1) * wA + smoothstep(thr0 - 0.01 - fwS, thr0 + 0.05 + fwS, s2) * wBl) * aaS;
    // patches: the threads gather in 20-60 m drifts, sparse elsewhere
    float pS = smoothstep(0.3, 0.72, 0.6 * macroNoise(qS / 29.0 + 9.3) + 0.4 * patchN);
    nStk = stTh * mix(0.3, 1.0, pS) * stZ;
  }
#endif

  // rocks: irregular apron + surges synced to the swell, travelling along the rock faces
  float dRn = dR + 10.0 * (macroNoise(xz / 7.0 + 11.0) - 0.5) + 5.0 * (macroNoise(xz / 2.1 + 5.0) - 0.5);
  float offR = 4.0 * macroNoise(xz / 22.0 + 3.0);
  float ageR = mod(age + offR, uSurfT);
  float surge = exp(-ageR / 2.2) * (0.35 + 0.8 * A0) + 0.35 * exp(-mod(ageR + 5.0, uSurfT) / 1.6);
  float rockCov = smoothstep(1.5 + 8.0 * surge, 0.0, dRn) * 0.55 + 0.28 * smoothstep(2.0, 0.0, dRn) + 0.2 * exp(-max(dRn, 0.0) / 7.0);
  // near field under the headland: the swell surges 15-25 m out from the cliff base and drains back
  // as streaming lace (measured: 20-45% white along the bottom frame edge)
  float cliffW = (1.0 - beachG) * smoothstep(150.0, 90.0, distF);
  // (kept to a lacy wash: isolated submerged rocks off the cliff must not turn into opaque white ovals)
  rockCov = max(rockCov, cliffW * (0.3 * smoothstep(12.0 + 10.0 * surge, 2.0, dRn) + 0.12 * exp(-max(dRn, 0.0) / 18.0)));
  float gullyCov = gully * (0.9 + 0.3 * surge);
  // lower-left wash (image x 0-260, rows 630-705, 66-85 m out): the swell bursts against the foot of
  // the foreground headland (a ledge along z ~ -55, hidden below the cliff top) and boils over the
  // submerged wash rock (ROCKS [-40,-66], 1-2 m down; not in the coast bake's rock mask): torn, bubbly
  // whitewater flung 10-20 m out from the ledge that drains back as streaming lace.
  // Timing: the surf phase carried to the ledge (the crests reach it ~0.19 s/m after the water
  // seaward of it), i.e. the rendered swell's own arrival, plus two weaker wind-sea surges per swell
  // period (measured surges peaking at t ~1.0, 4.5 and 9.3 s; the main one at t = 1.0)
  float washFr = 0.0, washL = 0.0;
  float washZ = smoothstep(-84.0, -70.0, xz.x) * smoothstep(-12.0, -22.0, xz.x) * smoothstep(-100.0, -84.0, xz.y) * (1.0 - beachG) * (1.0 - gully);
  if (washZ > 0.0) {
    float wn1 = macroNoise(xz / 5.5 + 21.3) - 0.5, wn2 = macroNoise(xz / 2.1 + 4.7) - 0.5;
    float dL = -xz.y - 55.0 - 0.06 * (xz.x + 40.0) + 6.0 * wn1 + 2.5 * wn2 + 3.0 * (lace - 0.5) + 2.0 * (fineT - 0.47); // m seaward of the ledge (torn at 0.3-3 m)
    float tw = fract(P.psi - 0.019 * max(dL, 0.0) + 0.605) * uSurfT;     // s since the main surge hit it
    // the shoal: the surge runs further out over the submerged rock and boils there
    float dRk = length((xz - vec2(-40.0, -66.0)) * vec2(1.0, 1.3)) + 6.0 * wn1 + 2.5 * wn2;
    float shoal = smoothstep(10.0, 3.0, dRk);
    for (int k = 0; k < 3; k++) {
      float offK = k == 0 ? 0.0 : (k == 1 ? 3.5 : 8.6);
      float stK = k == 0 ? 1.0 : (k == 1 ? 0.8 : 0.6);
      float tk = mod(tw - offK, uSurfT);
      // the burst runs out from the ledge (3 m -> 10-18 m in ~1.5 s), ragged along its front
      float R = 2.0 + (4.0 + 8.0 * stK + 5.0 * shoal) * (1.0 - exp(-tk / 1.1)) * (0.85 + 0.3 * (macroNoise(vec2(xz.x / 9.0, float(k) * 3.7 + mod(floor((uOT - tk) / uSurfT), 1200.0 / uSurfT) * 1.3)) - 0.5) * 2.0); // (swell-cycle seed, periodic with the 1200 s loop)
      float inside = smoothstep(R + 2.5, R - 3.0, dL);
      // (densest at the ledge, thinning toward the front)
      float fr = stK * smoothstep(0.0, 0.35, tk) * exp(-tk / 2.6) * (0.7 + 0.3 * smoothstep(R, 0.25 * R, dL));
      // the rim of the burst (the tumbling front running out) stays white longest
      float rim = exp(-pow((dL - R + 2.0) / 4.0, 2.0)) * stK * exp(-tk / 3.2) * smoothstep(0.0, 0.3, tk);
      washFr = max(washFr, max(inside * fr, rim * 0.45));
      // drain: the spent sheet streams back as lace (this surge and the tail of the previous cycle)
      // (the lace follows the burst: it builds as the fresh whitewater spends itself)
      washL = max(washL, smoothstep(R + 4.0, R - 2.0, dL) * stK * (k == 2 ? 0.6 : 1.0) * (exp(-tk / 5.5) * smoothstep(0.6, 3.0, tk) + exp(-(tk + uSurfT) / 5.5)));
    }
    washL = max(washL, shoal * 0.3); // (a little lace always lingers over the shoal)
    // (a churning band always hugs the ledge foot itself)
    washFr = max(washFr, 0.38 * smoothstep(4.5, 0.5, dL) * (0.7 + 0.3 * sin(uOT * 1.298525 + xz.x * 0.4))); // (2 pi 248 / 1200: loop-safe)
    float reach = smoothstep(26.0, 12.0, dL);
    washFr *= washZ * reach * smoothstep(-3.0, 1.0, dL);
    washL = min(washL * washZ * smoothstep(34.0, 14.0, dL), 1.0);
  }

  // whitecaps offshore: Jacobian of the breaking-scale chop, plus a tail left behind (upwind)
  float thr = uWcThresh;
  float Jb = jac01(xz, macro, att);
  // chop breaks mostly on the crests of the long waves (clusters the whitecaps into groups); far
  // out the flecks are sub-pixel and mostly vanish
  float longCrest = smoothstep(-0.35, 0.7, vFftY);
  float wcG = smoothstep(-1.0, 4.0, depth) * mix(0.1, 1.0, longCrest) * mix(1.0, 0.5, smoothstep(700.0, 2500.0, distF));
  // under the cliffs the chop rarely breaks (measured 1.2% dense): no field of small flecks there
  // (the near-field breaking is carried by the long-wave breakers nb below, not by chop whitecaps)
  wcG *= mix(0.2, 1.0, smoothstep(120.0, 350.0, distF));
  // along-crest breakup: a second, rotated sample of the moving FFT height (its crest lines run ALONG
  // the wave direction, 5-20 m apart) cuts every Jacobian line into short pieces that ride the sea
  // and slide along the crest as they grow (loop-safe: the FFT loops)
  vec2 xzr = vec2(xz.y, -xz.x);
  vec2 wdr = vec2(uWaveDir.y, -uWaveDir.x);
#ifdef OCEAN_LQ
  float gg = 1.0, ggT = 1.0;
#else
  float gg = smoothstep(-0.05, 0.06, texture(uDisp1, xzr / (uLen.y * 0.8) + 0.13, 1.0).y);
  float ggT = smoothstep(-0.05, 0.06, texture(uDisp1, (xzr + wdr * 5.0) / (uLen.y * 0.8) + 0.13, 1.0).y);
#endif
  float wcNow = smoothstep(thr, thr - 0.2, Jb) * wcG * gg;
  // comet tail: the head just downwind leaves a thin streak behind it (upwind of the head)
#ifdef OCEAN_LQ
  float wcT = 0.0; // medium/low: no extra Jacobian taps for the whitecap tails
#else
  float wcT = smoothstep(thr, thr - 0.2, jac01(xz + uWaveDir * 5.0, macro, att)) * wcG * ggT;
#endif
  float wc = max(wcNow, wcT * (0.3 + 0.5 * smoothstep(0.3, 0.7, streak)));
  float wcHead = smoothstep(thr - 0.05, thr - 0.25, Jb) * wcG * gg;

  // ---- near-field breakers: the steepest crests of the long wind waves (cascade 0, 7-70 m) spill
  // over the deep water under the headland: a 10-40 m piece of crest becomes a tumbling roller that
  // rides the wave (cream-lit leading face, shaded back, a translucent veil left behind upwind)
  float nb = 0.0, nbT = 0.0, nbHead = 0.0;
#ifndef OCEAN_LQ
  float nbM = smoothstep(420.0, 260.0, distF) * (1.0 - gully) * smoothstep(1.5, 4.0, depth)
            * (1.0 - beachG * smoothstep(330.0, 230.0, dB))
            * smoothstep(170.0, 250.0, distF); // (closer: nearbreak.js breakers; no flat slabs)
  if (nbM > 0.0) {
    vec4 e0 = texture(uDeriv0, xz / uLen.x, 1.5) * macro * att * uFFTAmp;
    float J0 = (1.0 + e0.z) * (1.0 + e0.w);
    float gB = smoothstep(0.1, 0.4, texture(uDisp0, xzr / (uLen.x * 0.45) + 0.29, 2.0).y);
    // (shoaling: over the 5-10 m shelf under the headland the crests break more readily)
    float thrN = uNbThr + 0.05 * smoothstep(12.0, 5.0, depth);
    nb = smoothstep(thrN, thrN - 0.06, J0) * gB * nbM;
    vec2 q = xz + uWaveDir * 8.0;
    vec4 e1 = texture(uDeriv0, q / uLen.x, 1.5) * macro * att * uFFTAmp;
    float gBT = smoothstep(0.1, 0.55, texture(uDisp0, (xzr + wdr * 8.0) / (uLen.x * 0.45) + 0.29, 2.0).y);
    nbT = smoothstep(thrN + 0.04, thrN - 0.06, (1.0 + e1.z) * (1.0 + e1.w)) * gBT * nbM;
    // leading (downwind, sun-facing) face of the crest: the lit tumbling wall
    float s0 = dot(e0.xy, uWaveDir);
    nbHead = nb * smoothstep(0.03, -0.05, s0);
  }
#endif
  // the leading (downwind) edge of a breaking crest is where the tumbling roller is: bright crescent;
  // just ahead of it the steepened face is thin and backlit (translucent turquoise window)
#ifdef OCEAN_LQ
  float lead = wcNow; float wcFace = 0.0;
#else
  float lead = wcNow * (1.0 - 0.75 * wcT);
  float wcFace = smoothstep(thr, thr - 0.2, jac01(xz - uWaveDir * 3.5, macro, att)) * wcG * (1.0 - smoothstep(0.05, 0.3, wcNow));
#endif

  // world-space breakup so distant sheets are not flat bands
  // (every world-space octave fades to its mean where the pixel footprint — the range direction far
  // out: ~30 m per pixel at 1 km — would alias it into blocky dashes and sparkle)
  float fpCa = abs(dot(fdX, crestT)) + abs(dot(fdY, crestT)), fpSa = abs(dot(fdX, shoreDir)) + abs(dot(fdY, shoreDir));
  // crest-aligned streak noise (25 m along the crest, 4 m across): distant sheets break into streaks
  // (all three seeded by the crest the pixel belongs to — continuous across its line, where the head
  // starts — and cross-faded mid-way between the lines, where that crest changes)
  float wSd = smoothstep(0.42, 0.58, P.u);
  float aB1 = 0.6 * WAA(14.0), aB2 = 0.4 * WAA(5.0);
  vec2 xS = vec2(dot(xz, crestT) / 25.0, dot(xz, shoreDir) / 4.0);
  vec2 xT = vec2(dot(xz, crestT) / 16.0, dot(xz, shoreDir) / 2.2);
  float brk = 0.5, nS0 = 0.0, nT0 = 0.0;
  if (wSd < 1.0) {
    brk += (1.0 - wSd) * ((macroNoise(xz / 14.0 + iL * 1.37) - 0.5) * aB1 + (macroNoise(xz / 5.0 - iL * 0.71) - 0.5) * aB2);
    nS0 += (1.0 - wSd) * (macroNoise(xS + iL * 0.37) - 0.5);
    nT0 += (1.0 - wSd) * (macroNoise(xT + iL * 0.53) - 0.5);
  }
  if (wSd > 0.0) {
    brk += wSd * ((macroNoise(xz / 14.0 + iL1 * 1.37) - 0.5) * aB1 + (macroNoise(xz / 5.0 - iL1 * 0.71) - 0.5) * aB2);
    nS0 += wSd * (macroNoise(xS + iL1 * 0.37) - 0.5);
    nT0 += wSd * (macroNoise(xT + iL1 * 0.53) - 0.5);
  }
  float nS = 0.5 + nS0 * 0.65 * (1.0 - smoothstep(0.3, 0.8, max(fpCa / 25.0, fpSa / 4.0))) + (macroNoise(xz / 9.0 + 5.1) - 0.5) * 0.35 * WAA(9.0);
  // (only a mild crest-aligned streak modulation: strong 4 m streaks stacked every piece into 2-3
  // parallel slats; the measured pieces are soft blobs with a soft trailing sheet)
  surfCov *= mix(0.5, 1.25, brk) * mix(0.72, 1.12, nS);
  sheetL *= mix(0.6, 1.2, brk);
  lip *= smoothstep(0.25, 0.6, brk + 0.2);
  // near field off the headland: the pitching lip of a short reef-break piece is torn spray and
  // bubbles, not an opaque oval
  lip *= mix(1.0, 0.2 + 0.8 * smoothstep(0.3, 0.62, fineT + 0.3 * lace), nearF * (1.0 - beachG));
  // (the sheet's share of the dense whitewater is torn lace, not an opaque fill: lower cover)
  float denseCov = clamp(max(max(min(surfCov * 0.36, 0.4), roller * 1.3), max(lip * 1.2, head * 1.5)), 0.0, 1.2);
  // near field off the headland: the short reef-break pieces are torn, bubbly whitewater, not opaque ovals
  denseCov *= mix(1.0, 0.25 + 0.75 * smoothstep(0.25, 0.6, fineT + 0.3 * lace), nearF * (1.0 - beachG));
  float laceS = mix(lace, streak, 0.25 + 0.4 * smoothstep(1.0, 8.0, age));
  float softD = 0.2 + 0.45 * smoothstep(250.0, 1500.0, distF) + nearSoft;
  // thick foam: fresh whitewater, rock wash, gully churn, whitecap heads
  float foam = cov(laceS + 0.25 * patchN - 0.1, denseCov, softD);
  // the whitewater sheet behind the head: a translucent, streaky veil (brushed along the crest by the
  // wind), soft-edged — not an opaque, hard-edged slab
  // (torn: a lace of streaks along the crest with turquoise holes that open up as it ages — the
  // measured sheets are white filaments over turquoise, not a flat translucent fill)
  float shT = mix(streak, lace, 0.4) + 0.3 * (nS - 0.5) + 0.15 * (patchN - 0.5);
  float sheetA = cov(shT, clamp(surfCov * 0.42, 0.0, 0.75), 0.3) * 0.9;
  foam = max(foam, sheetA);
  // soft milky veil of old, spread whitewater (30-60 m patches: measured 5-12% pale >190 across the
  // beach surf zone between the lines, where the clean lines alone left turquoise)
  // (patches seeded by the continuous phase: they drift ~1 m/s and evolve instead of popping at every
  // line; the veil of a crest fades in behind its line and out just ahead of the next one)
  float psL = mod(P.psi, 120.0);
  float veilP = 0.5 + (macroNoise(xz / 38.0 + psL * vec2(0.23, 0.11)) - 0.5) * WAA(38.0) * 0.8 + (macroNoise(xz / 13.0 - psL * vec2(0.17, -0.29)) - 0.5) * WAA(13.0) * 0.45;
  float veil = Wv * (0.6 * exp(-age / 8.0) + 0.4) * smoothstep(0.24, 0.62, veilP) * smoothstep(20.0, 60.0, dB) * 0.72
             * mix(1.0, 0.8, smoothstep(130.0, 190.0, dB)) // (outer zone: a little clearer between the lines)
             * mix(0.5, 1.0, smoothstep(85.0, 125.0, dBt)) // (inner zone: clear light-blue water, measured)
             * (1.0 - 0.6 * gutE) * (1.0 + 0.6 * sprZ) // (clear gutter; dense pale band inside the outer break)
             * smoothstep(0.0, 0.1, P.u) * (1.0 - smoothstep(0.85, 1.0, P.u));
  // world-space coverage noise (3-16 m, footprint-filtered; also thresholds the far foam below)
  float nF = 0.5 + (macroNoise(xz / 2.6 + 7.0) - 0.5) * 0.3 * WAA(2.6) + (macroNoise(xz / 7.0 + 3.0) - 0.5) * 0.4 * WAA(7.0) + (macroNoise(xz / 16.0 + 1.3) - 0.5) * 0.3 * WAA(16.0);
  // (torn and streaky inside — lace near, world noise far — so it reads as spread foam, not fog)
  float veilF = veil * mix(0.4 + 0.6 * smoothstep(0.25, 0.7, mix(streak, lace, 0.4)), 0.55 + 0.45 * smoothstep(0.3, 0.7, nF + 0.25 * (nS - 0.5)), smoothstep(150.0, 650.0, dist));
  // (thresholded like the rest: a weak lip is a few torn filaments, not a smooth translucent veil
  // drawn along the whole crest line)
  foam = max(foam, cov(mix(lace, streak, 0.3) + 0.15 * (patchN - 0.5), min(lip, 1.0), 0.15 + nearSoft));
  float rf = cov(mix(lace, streak, 0.3) + 0.2 * (patchN - 0.5), clamp(rockCov, 0.0, 1.0) * mix(0.45, 0.9, smoothstep(0.0, 3.0, -dRn + 3.0 * surge)), 0.12 + nearSoft);
  // (gully: a continuous, streaky aerated churn with turquoise flow between, not lace blobs with
  // dark holes: flow-streaked texture, soft threshold, a lower cap)
  float gf = cov(lace * 0.3 + streak * 0.45 + fineT * 0.1 + bub * 0.15, clamp(gullyCov * mix(0.5, 0.95, smoothstep(0.2, 0.6, patchN)), 0.0, 0.78), 0.38 + nearSoft);
  foam = max(foam, max(rf, gf));
  float wcf = cov(streak * 0.55 + lace * 0.3 + bub * 0.15, wc * 0.75 + 0.35 * wcNow, 0.22 + 0.3 * smoothstep(250.0, 1500.0, distF) + nearSoft);
  foam = max(foam, wcf * mix(0.4, 1.0, smoothstep(0.1, 0.5, wcNow)) * (0.55 + 0.45 * smoothstep(0.2, 0.8, wc)));
  // near-field breakers: opaque, clotted roller on the crest; a lacy translucent veil behind it
  // (torn and bubbly, never a smooth opaque disc: the coverage is thresholded against the fine lace)
  float nbf = cov(0.35 * lace + 0.25 * streak + 0.4 * fineT + 0.15 * nb, clamp(nbHead * 0.75 + nb * 0.3, 0.0, 0.72), 0.3 + nearSoft);
  foam = max(foam, nbf);
  float nbV = cov(mix(streak * 0.7 + lace * 0.3, fl, 0.4), clamp(nbT * 0.75, 0.0, 0.8), 0.12 + nearSoft);
  foam = max(foam, nbV * 0.6);
  // breaking head: a torn crescent along the leading edge (solid white only in its core), not a blob
  float headT = smoothstep(0.1, 0.45, wcNow) * smoothstep(0.22, 0.55, 0.4 * lace + 0.3 * streak + 0.3 * f3.r + 0.45 * lead - 0.1);
  headT *= mix(1.0, smoothstep(0.28, 0.6, fineT + 0.3 * lace), nearF); // torn and bubbly up close
  foam = max(foam, headT * (0.8 + 0.2 * lace));
  // thin foam: lace / residue / old streaks (bubbles in the water, lit by the water, fine-textured)
  // (the old sheet behind the heads is torn lace — white filaments over turquoise, ~35-50% cover —
  // not a near-solid veil: at full sheetL the old c = 0.8 painted flat opaque slabs)
  float lacW = cov(mix(laceS + 0.2 * patchN - 0.05, fl, 0.35) + 0.2 * (nS - 0.5), min(sheetL * 0.85, 0.5), softD * 0.4);
  float thinF = lacW * 0.95;
  thinF = max(thinF, cov(mix(streak, fl, 0.35), min(0.3 * W0 * exp(-age / 9.0) + 0.15 * aer, 0.65), 0.08 + nearSoft) * 0.85);
  // milky inner surf (15-80 m from the beach): streaky, translucent lace between the bores
  float milk = smoothstep(95.0, 40.0, dBt) * smoothstep(-2.0, 8.0, dBt) * smoothstep(8.0, 40.0, dR) * beachG;
  float milkF = cov(mix(streak * 0.7 + lace * 0.3, fl, 0.3), 0.3 + 0.2 * aer, 0.2 + nearSoft) * milk * 0.7;
  thinF = max(thinF, milkF);
  // inner zone (~8-100 m from the beach): thin, irregular, broken foam lines drifting to the beach —
  // each reformed bore front and the residue line it left half a period earlier; every line wanders
  // on its own (phase warp that travels with it), is cut into 5-30 m pieces, and is widened to its
  // pixel footprint with its energy kept (no staircase, no sparkle), fading to its mean where the
  // lines crowd below ~3 px apart
  // (outside the inner bar, up to the outer break: the residue lines of the broken bores, u = 1/3, 2/3
  // behind each crest, fewer in the clear gutter — measured ~2x more lines than crests across the zone)
  float outZ = smoothstep(95.0, 125.0, dBt);
#ifdef OCEAN_LQ
  float inZ = smoothstep(125.0, 90.0, dBt) * smoothstep(3.0, 12.0, dBt) * beachG * smoothstep(8.0, 30.0, dR); // (medium/low: inner zone only)
#else
  float inZ = mix(smoothstep(125.0, 90.0, dBt), smoothstep(265.0, 205.0, dB) * (1.0 - 0.6 * smoothstep(100.0, 115.0, dBt) * smoothstep(160.0, 145.0, dBt)) * 0.85, outZ)
            * smoothstep(3.0, 12.0, dBt) * beachG * smoothstep(8.0, 30.0, dR);
#endif
  float fq = 3.0 * fwU;
  float inL = 0.0, inLF = 0.0;
  if (inZ > 0.0) {
    float q = P.psi * 3.0 + 0.5 + 0.3 * SAA(21.0) * (sNoise2(vec2(P.s / 21.0, mod(P.psi, 120.0)), 11, 120.0) - 0.5)
            + 0.08 * SAA(7.0) * (sNoise2(vec2(P.s / 7.0, mod(P.psi, 120.0) * 1.5), 12, 180.0) - 0.5);
    float li = floor(q);
    float lq = q - li - 0.5;
    float lw = 0.035 + 0.03 * sNoise1(P.s / 11.0 + mod(li, 360.0) * 2.3, 14); // line width varies along it
    float wq = sqrt(lw * lw + fq * fq);
    float prof = exp(-lq * lq / (wq * wq)) * lw / wq * (1.0 - smoothstep(0.3, 0.6, fq));
    float lm = mod(li, 360.0); // (3 lines per crest: periodic with the 120-crest loop)
    float pc = smoothstep(0.33, 0.58, 0.5 + 0.65 * SAA(26.0) * (sNoise1(P.s / 26.0 + lm * 3.7, 12) - 0.5) + 0.35 * SAA(9.0) * (sNoise1(P.s / 9.0 + lm * 1.3, 13) - 0.5));
    float isF = step(mod(li, 3.0), 0.5); // bore fronts (brighter, thicker) / residue lines
    inL = prof * pc * mix(0.65, 1.0, isF) * inZ * alignF * ripG * (1.0 - isF * outZ); // (outer fronts: the main whitewater)
    inLF = inL * isF * smoothstep(20.0, 45.0, dBt);
  }
  thinF = max(thinF, min(inL * 1.25, 0.95));
  // shore break and swash: every bore collapses on the beach face into a bright, soft white band that
  // runs up the sand and drains back as lace (measured: a near-continuous soft white band 3-8 px along
  // the waterline, brightest where a bore has just arrived, broken in places)
  // (never thinner than ~3 px across: far along the beach a sub-pixel band broke into a dotted line
  // where the terrain cuts the water mesh)
  float swZ = beachG * smoothstep(max(24.0, 3.0 * fwidth(dBt)), 4.0, dBt) * smoothstep(-6.0, 0.5, dBt) * smoothstep(8.0, 30.0, dR);
  float swash = 0.0;
  if (swZ > 0.0) {
    // (pattern seeded by the continuous phase: it evolves as each bore arrives instead of being
    // re-seeded along the crest line sweeping down the beach; the arrival pulse ramps in)
    float swN = 0.5 + (macroNoise(vec2(P.s / 17.0, psL * 0.45 + 2.0)) - 0.5) * SAA(17.0) + (macroNoise(vec2(P.s / 6.0, psL * 0.8)) - 0.5) * 0.6 * SAA(6.0);
    swash = swZ * (0.6 + 0.4 * xf * exp(-age / 3.0)) * smoothstep(0.15, 0.5, swN);
    foam = max(foam, cov(mix(laceS, streak, 0.3) + 0.2 * (patchN - 0.5), min(swash, 0.95), 0.25 + nearSoft));
  }
  // clear turquoise gutter ~110-155 m from the beach, between the inner and outer bars
  // (north end, by the headland: the broken water fills the zone right up to the platform — measured
  // ~20% bright lace in every frame there — no clear gutter, a denser, whiter persistent lace band)
  float nEnd = surfBreakOff(P.s) / ${BREAK_OFF[0].toFixed(1)};
  float gutter = smoothstep(100.0, 115.0, dBt) * smoothstep(160.0, 145.0, dBt) * (1.0 - 0.5 * nEnd);
  // persistent streaky lace across the surf zone (shallow water inside the outer bar), not in the gutter
  float surfBand = smoothstep(310.0, 215.0, dB) * smoothstep(15.0, 55.0, dBt) * smoothstep(10.0, 7.0, depth - 1.5 * nEnd) * (1.0 - gutter) * ripG;
  float bandCov = surfBand * (0.3 + 0.35 * patchN) * mix(0.7, 1.2, brk) * (1.0 + 0.3 * nEnd);
  float bandL = cov(mix(streak * 0.75 + lace * 0.25, fl, 0.35), bandCov, 0.1 + nearSoft);
  thinF = max(thinF, bandL * 0.8);
  // old wind-streaked lace: surf zone (thin in the gutter) and a narrow band around the rocks
  float oldF = (0.14 + 0.36 * smoothstep(420.0, 150.0, dB)) * smoothstep(360.0, 230.0, dB) * (1.0 - 0.3 * gutter) + 0.35 * exp(-max(dR, 0.0) / 40.0);
  oldF *= (0.35 + 1.1 * patchN) * mix(0.75, 1.3, smoothstep(-0.6, 0.9, crestH));
  // (under the cliffs the long wind streaks (nStk) carry the old foam: fewer short marbled squiggles)
  float oldNear = 1.0 - 0.55 * smoothstep(300.0, 200.0, dist) * (1.0 - beachG) * (1.0 - gully);
  thinF = max(thinF, cov(mix(streak * 0.8 + lace * 0.2, fl, 0.4), oldF * 0.8 * oldNear, 0.1 + nearSoft) * 0.7);
  // ... and a network of thin filaments (ridges of the lace fields) wherever old foam lingers
  float filF = smoothstep(0.5, 0.66, 0.35 * lace + 0.35 * streak + 0.3 * fl + 0.12 * (patchN - 0.5) + 0.04) * smoothstep(0.05, 0.35, oldF);
  // ... gathered in patches and along the crests (15-25 m), with clear water between them
  // (a density modulation, not a hard gate: sparse areas keep a few filaments, no decal-like holes)
  filF *= mix(0.4, 1.0, smoothstep(0.2, 0.8, 0.6 * macroNoise(xz / 22.0 + 1.7) + 0.4 * patchN + 0.3 * (smoothstep(-0.5, 0.8, crestH) - 0.5)));
  thinF = max(thinF, filF * 0.9 * (1.0 - smoothstep(200.0, 450.0, dist)) * oldNear);
  // near-field wind streaks (see nStk)
  thinF = max(thinF, nStk * 0.8);
  foam = max(foam, thinF);
  // lower-left wash: torn, bubbly whitewater (thresholded against the fine bubble / lace texture, so
  // it is clots and holes, never an opaque oval) and the lace it drains back as
  float wfT = cov(0.5 * fineT + 0.3 * lace + 0.2 * bub + 0.1 * washFr, min(washFr * 1.7, 0.94), 0.3 + nearSoft);
  // (the lace is distinct threads and clots on clear turquoise, not a milky veil: sharp threshold, capped)
  float wfL = cov(mix(streak, lace, 0.5) * 0.65 + 0.35 * fineT + 0.1 * (patchN - 0.5), min(washL * 1.0, 0.68), 0.14 + nearSoft) * 0.9;
  foam = max(foam, max(wfT, wfL));
  // distance: foam texture minifies to its mean coverage — keep it crisp but fade to coverage
  // (the lace texture loses its contrast under minification, so blend to the expected coverage)
  float far = smoothstep(150.0, 650.0, dist);
  // surf whitewater (solid, lumpy pieces) and whitecaps / rock wash
  float cmS = clamp(max(max(head * 1.5, roller * 1.3), lip * 1.2) * mix(0.7, 1.15, brk), 0.0, 1.0);
  float cmSh = clamp(min(surfCov, 1.0) * mix(0.6, 1.2, brk), 0.0, 1.0);
  float covMean = max(wc * 0.75 + 0.2 * wcNow, max(rockCov * 0.55, gullyCov * 0.9));
  covMean *= mix(0.55, 1.15, brk);
  float covLace = max(max(sheetL * 1.0, bandCov * 0.6), max(oldF * 0.4, milk * 0.4)) * 0.85;
  // threshold the expected coverage against world-space noise (3-8 m) so distant foam keeps
  // crisp, lumpy edges instead of smooth slabs
  float cm = clamp(covMean, 0.0, 1.0);
  float farFoam = smoothstep(0.45, 0.8, cm + 0.6 * (nF - 0.5)) * 0.85 + 0.15 * cm;
  farFoam = max(farFoam, smoothstep(0.2, 0.5, cmS + 0.55 * (nF - 0.5)) * 0.97);
  // (the sheet behind the heads is a translucent veil of streaks, the heads are opaque)
  farFoam = max(farFoam, smoothstep(0.12, 0.8, cmSh + 0.35 * (nS - 0.5) + 0.75 * (nF - 0.5)) * mix(0.62, 0.8, nS));
  farFoam = max(farFoam, 0.45 * smoothstep(0.42, 0.85, clamp(covLace, 0.0, 1.0) + 0.7 * (nS - 0.5)));
  // far out the whitewater lines crowd below a few pixels: their phase-mean coverage (a soft pale
  // band, as measured) replaces the thresholded pieces, which would alias into dashes
  float farMix = smoothstep(0.025, 0.11, fwU);
  float bandMean = min(mix(W0, W1, P.u), 1.0) * 0.85 + 0.4 * min(covLace, 1.0); // (continuous across the lines)
  // (where a whole crest spacing spans only a few pixels even the widened pieces flicker under the
  // handheld sub-pixel motion: only the mean is left)
  farFoam = mix(farFoam, max(farFoam * 0.55 * (1.0 - smoothstep(0.15, 0.4, fwU)), bandMean), farMix);
  // (the inner-zone lines and the swash band are footprint-filtered already: keep them far out too)
  farFoam = max(farFoam, max(min(inL * 1.25, 0.95), smoothstep(0.1, 0.6, swash + 0.3 * (nF - 0.5)) * 0.92));
  // (beyond ~0.7 km only the footprint-filtered far path: the 15% of thresholded near texture kept
  // closer in is sub-pixel there and flickered under the handheld sub-pixel motion, p99 34 vs 9.5)
  foam = mix(foam, farFoam, far * mix(0.85, 1.0, smoothstep(600.0, 1000.0, dist)));
  // the whitewater behind the heads is a translucent, streaky sheet, not paint
  foam *= 1.0 - (0.45 - 0.3 * nS) * (1.0 - 0.5 * sprZ) * smoothstep(0.05, 0.4, mix(W0, W1, wSd)) * (1.0 - clamp(head * 2.0, 0.0, 1.0)) * smoothstep(60.0, 250.0, dist); // (continuous across the lines)
  foam = max(foam, veilF); // (the milky veil: pale old foam, after the sheet's translucency cut)
  foam = clamp(foam, 0.0, 1.0);
  // how "thick" the foam is (thin/old foam is sky-lit only, translucent)
  // (the sheet behind the heads is a thinner, translucent veil: only the heads / rollers / lips are
  // thick, sun-lit whitewater)
  float denseT = max(max(min(surfCov, 0.95) * mix(0.85, 0.8, smoothstep(150.0, 400.0, dist)), roller * 1.3), max(lip * 1.2, head * 1.5));
  denseT = max(denseT, inLF * 0.8); // (the inner bore lines are white, not just lifted water)
  denseT = max(denseT, lacW * min(sheetL, 1.0) * 0.7); // (the sheet's lace filaments are white foam, not lifted water)
  denseT = max(denseT, bandL * 0.3 * nEnd); // (north end: the persistent lace is whiter)
  denseT = max(denseT, swash * 0.7);  // (the swash band is white foam)
  // ---- far whitecaps: beyond ~450 m the FFT's breaking chop minifies away (its Jacobian averages
  // to 1 in the mips), yet the measured sea stays full of small bright caps to the horizon (~15
  // blobs per 25 rows, 1-1.3% cover, 3-8 px wide, 1-2 px tall: the wall + spray of a cap stands up,
  // so its screen height is ~constant). Statistical caps on a grid of ~constant screen size that is
  // anchored to the world: cells in (azimuth, 1/range) about the nominal eye, 8 x 3.5 px; a cell
  // hosts a cap for 2-4.5 s of its 8/10/12 s cycle (divides the 1200 s loop) at a hashed spot;
  // every cap is >= 1 px with a >= 1 px soft edge (fwidth of the cell coordinates): no sparkle
  float wcFar = 0.0;
#ifndef OCEAN_LQ
  {
    float gF = smoothstep(330.0, 520.0, distF) * (1.0 - smoothstep(1100.0, 2800.0, distF)) * smoothstep(290.0, 380.0, dB) * smoothstep(8.0, 20.0, depth)
             * (1.0 - gully) * mix(0.35, 1.0, smoothstep(0.3, 0.7, macroNoise(xz / 260.0 + 4.1)));
    vec2 cq = vec2(atan(xz.x, -xz.y) / 0.0125, 9860.0 / max(length(xz), 50.0)); // (12 x 3.5 px cells)
    vec2 fwq = fwidth(cq);
    // (the cell rows are staggered column by column: no screen lattice of caps on level rows)
    float cxi = floor(cq.x);
    cq.y += sHashI(int(mod(cxi, 4096.0)), 31);
    if (gF > 0.0 && fwq.x < 0.5 && fwq.y < 0.6) {
      vec2 ci = floor(cq), cf = cq - ci;
      int cid = int(mod(ci.x, 4096.0)) + int(mod(ci.y, 4096.0)) * 4099;
      float P = 8.0 + 2.0 * floor(sHashI(cid, 21) * 2.999);
      float ph = (uOT + sHashI(cid, 22) * P) / P;
      int k = int(mod(floor(ph), 1200.0 / P)); // (1200 / P cycles per loop for P = 8, 10, 12: no jump at the wrap)
      float ageC = fract(ph) * P;
      int eid = cid * 7 + k * 104729;
      float live = 2.0 + 2.5 * sHashI(eid, 23);
      float on = step(sHashI(eid, 24), 0.5 + 0.2 * smoothstep(1400.0, 600.0, distF)); // (denser toward 0.5-0.7 km)
      vec2 cc = vec2(0.42, 0.32) + vec2(0.16, 0.36) * vec2(sHashI(eid, 25), sHashI(eid, 26)); // (anywhere in the cell)
      // (measured: thin horizontal dashes, 3-12 px long and ~1 px tall, mostly faint, a few bright —
      // not round dots: a separable profile, tapered ends, the sub-pixel height widened to >= ~1 px
      // with its energy kept, so most caps stay dim and none sparkles)
      float hz = sHashI(eid, 27);
      vec2 hw2 = vec2(0.2 + 0.25 * hz * sHashI(eid, 30), 0.1 + 0.06 * sHashI(eid, 28));
      vec2 hq = max(hw2, vec2(1.2, 1.0) * fwq);
      vec2 dq = (cf - cc - vec2(0.02, 0.0) * ageC) / hq; // (drifts downwind a little while it lives)
      float blob = max(0.0, 1.0 - dq.x * dq.x) * exp(-2.0 * dq.y * dq.y) * (hw2.y / hq.y) * mix(1.0, 2.3, hz * hz);
      float life = smoothstep(0.0, 0.35, ageC) * (1.0 - smoothstep(0.45 * live, live, ageC));
      // (soft window at the cell border: a cap never gets clipped into a hard edge)
      float win = smoothstep(0.0, 0.08, cf.x) * smoothstep(1.0, 0.92, cf.x) * smoothstep(0.0, 0.12, cf.y) * smoothstep(1.0, 0.88, cf.y);
      wcFar = min(blob * win * life * on * gF * mix(0.5, 1.0, sHashI(eid, 29)), 1.0);
    }
  }
#endif
  denseT = max(denseT, wcFar * 1.8); // (white caps, not lifted water)
  foam = max(foam, wcFar);
  denseT = max(denseT, max(veil * 1.2, inL * 0.45 * outZ)); // (milky veil / residue lines: pale, not lifted water)
  float thick = clamp(max(max(denseT, wcNow * 1.2 + 0.35 * wc), max(max(rockCov, gullyCov), nbHead * 0.9 + nb * 0.3)), 0.0, 1.0);
  thick = max(thick, min(max(washFr * 1.1, max(washL * 0.4, nStk * 0.9)), 1.0)); // (wash: whitewater; streaks: white threads)
  // turbulent whitewater: thick foam is not a flat white fill but bubbly, streaky and torn, with
  // darker aerated water between the clots (sparse inside, dense toward a ragged edge); only the
  // freshest heads stay nearly solid. Near: fine lace (0.5-1 m) + flow streaks; farther (the lace
  // texture minifies to its mean) crest-aligned world noise, faded to its mean per pixel footprint
  float fpC = fpCa, fpS = fpSa; // (footprints along / across the crest, computed above)
  float aaT = 1.0 - smoothstep(0.4, 0.9, max(fpC / 16.0, fpS / 2.2));
  float aaT2 = 1.0 - smoothstep(0.4, 0.9, length(vec2(fpC, fpS)) / 3.5);
  float nT = 0.5 + 0.6 * aaT * nT0
                 + 0.4 * aaT2 * (macroNoise(xz / 3.5 + 8.1) - 0.5);
  float tex = mix(0.45 * f3.r + 0.3 * streak + 0.25 * lace, nT, smoothstep(120.0, 400.0, dist));
  tex = mix(tex, 0.55 * fineT + 0.25 * f3.r + 0.2 * lace, 0.8 * nearF);
  float fresh = clamp(max(max(head * 1.6, nb * 1.2), max(max(wcHead, 0.5 * wcFar), lip)), 0.0, 1.0);
  fresh = max(fresh, washFr * 0.25);
  float tkW = smoothstep(0.35, 0.8, thick) * (1.0 - 0.6 * fresh);
  float keep = smoothstep(0.26, 0.5, tex + 0.4 * (foam - 1.0) + 0.06);
  foam = min(1.0, foam * mix(1.0, 1.15, tkW)) * mix(1.0, keep, tkW * 0.75); // (edges pushed out: ~same coverage)
  // near: whitewater is a bubbly mass, never a flat fill — small holes and thin spots everywhere
  // (the bubble plume below shows through them)
  foam *= mix(1.0, mix(0.35, 1.0, smoothstep(0.2, 0.4, fineT + 0.1 * fresh)), nearF * smoothstep(0.2, 0.6, thick));

  // ---- water body colour ----
  float shallowT = exp(-max(depth, 0.0) / 3.5) * step(-50.0, dBt) * 0.8 * smoothstep(8.0, 40.0, dR) * beachG;
  vec3 body = mix(uDeep, uMid, smoothstep(0.02, 0.3, V.y));
  float baseL = dot(body, vec3(0.2126, 0.7152, 0.0722));
  body = mix(body, uShallow, shallowT * 0.9);
  // the surf band is turquoise (suspended sand, bubbles) between the whitewater lines
  body = mix(body, uShallow, 0.08 * smoothstep(330.0, 230.0, dB) * beachG * smoothstep(-5.0, 20.0, dBt));
  // far out (> 4 km) the deep blue gives way to the grey of the rough, hazy sea surface
  body = mix(body, vec3(0.08, 0.085, 0.095), smoothstep(1500.0, 7000.0, dist) * 0.9);
  // thin crests: translucent turquoise glow (FFT crest glow only near the camera)
  float sss = smoothstep(-0.2, 1.4, crestH) * (0.75 + 0.25 * steep);
  // sharp, compressed chop crests (Jacobian < 1) are thin and backlit by the low sun: translucent
  sss = max(sss, smoothstep(0.95, 0.45, J) * smoothstep(-0.3, 0.5, crestH) * 0.8 * smoothstep(600.0, 150.0, dist));
  float nearC = smoothstep(400.0, 80.0, dist);
  body *= mix(mix(mix(0.55, 0.46, nearC), 0.8, smoothstep(700.0, 3000.0, dist)), mix(1.1, 1.3, nearC), smoothstep(-1.2, 0.6, crestH));
  body = mix(body, uCrest * mix(1.0, 1.15, nearC), clamp(sss, 0.0, 1.0) * mix(0.35, 0.8, smoothstep(0.02, 0.2, V.y)));
  // near-field wave relief: faces turned toward the camera look into the dark water, faces turned
  // away catch more light (the sub-pixel Fresnel/translucency contrast of the measured near field)
  vec2 vh = normalize(V.xz + 1e-5);
  body *= clamp(1.0 + 1.8 * dot(slope, vh) * nearC, 0.65, 1.4);
  // near-field swell relief (under the cliffs): the rolling swells read as brighter, translucent
  // turquoise crests over dark troughs (the vertex-interpolated crest height alone is too subtle
  // here). Deliberately broad profile (not the sharp breaking front: no thin contour lines).
  float swX = du / (du < 0.0 ? 0.13 : 0.22);
  float swP = exp(-swX * swX);
  float swA = clamp(amp * 1.1, 0.0, 1.0) * nearC * (dB < 1400.0 ? 1.0 : 0.0) * step(0.0, dB);
  body *= mix(1.0, mix(0.76, 1.22, swP), swA);
  body = mix(body, uCrest * 1.1, swA * 0.18 * swP);
  // milky inner surf zone and aerated water under recent foam
  body = mix(body, uMilky, milk * 0.5 * mix(0.55, 1.25, brk));
  // (the smooth inner surf mirrors the blue sky: measured (138-146, 166-174, 184-192), B > G)
  body *= mix(vec3(1.0), vec3(0.98, 0.96, 1.65), milk * 0.9);
  float aerT = clamp(aer * 0.7 + gully * 0.55 * smoothstep(0.35, 0.75, patchN + 0.3 * surge) + 0.25 * exp(-max(dR, 0.0) / 10.0) * (0.4 + surge) * patchN, 0.0, 1.0);
  // (around the wash the water stays saturated turquoise in the reference: a little green glow of the
  // bubble cloud only, no milky lift — that drew a grey-brown veil over the drained area)
  body = mix(body, uCrest, clamp(washFr * 0.12, 0.0, 0.12));
  body *= mix(1.0, 0.6, gully * (1.0 - aerT)); // gully water sits in the cliff shade
  body = mix(body, uAerated, aerT * 0.55);

  float NdV = max(dot(N, V), 0.0);
  float F = 0.02 + 0.98 * pow(1.0 - NdV, 5.0);
  // near field: the full Fresnel swing between faces (looking into the water) and backs (grazing,
  // mirroring the bright low sky) is what draws the swell and the wind chop (measured grey-blue backs)
  float nearR = smoothstep(300.0, 90.0, dist) * (1.0 - gully);
  F = min(F, mix(mix(uFresMax, 0.72, nearR), 0.55, smoothstep(2500.0, 10000.0, dist)));
  vec3 R = reflect(-V, N);
  // rough distant water reflects the sky well above the bright horizon band; near the horizon the
  // grazing sea mirrors the bright horizon sky
  R.y = max(abs(R.y), mix(0.03, 0.14, smoothstep(300.0, 4000.0, dist)) * (1.0 - 0.85 * smoothstep(2500.0, 8000.0, dist)));
  R = normalize(R);
  vec3 refl = skyRadiance(R);
  // no sun lobe on the water (measured: no glitter): remove the sky model's aureole term
  float muR = max(dot(R, SKY_SUN_DIR), 0.0);
  refl -= vec3(1.0, 0.72, 0.42) * (pow(muR, 12.0) * 2.5 + pow(muR, 300.0) * 25.0) * step(-0.02, R.y) * smoothstep(26.0, 42.0, skyAzEq(R));
  refl = max(refl, 0.0) * uReflScale * mix(1.0, 1.9, smoothstep(1800.0, 9000.0, dist)) * mix(0.75, 1.0, smoothstep(150.0, 400.0, dist));
  // the sea mirrors the cool sky: no warm (sun-side horizon) tint in the reflection (measured: no
  // gold on the water); keep the luminance
  float rL = dot(refl, vec3(0.2126, 0.7152, 0.0722));
  float warmR = smoothstep(0.62, 1.05, refl.r / max(refl.b, 1e-4));
  refl = mix(refl, rL * mix(vec3(0.8, 1.0, 1.06), vec3(0.68, 1.0, 1.18), nearR), 0.6 * warmR);
  refl *= mix(1.0, 2.2, nearR);
  body *= mix(1.0, 0.86, nearR); // (keeps the near-field mean with the stronger reflection)
  vec3 col = mix(body, refl, F);
  // light transmitted through the thin, backlit crests is not hidden by the surface reflection
  col = mix(col, uCrest * 1.1, clamp(sss, 0.0, 1.0) * smoothstep(450.0, 120.0, dist) * (1.0 - gully) * 0.35 * (1.0 - F));
  // open water varies in brightness across the chop, hardly in hue (measured G/B 0.88-1.0; the
  // blue troughs / green crests of the height tint read as painted bands): pull the chroma of the
  // mid field toward the measured teal, keep the luminance texture
  {
    float lcol = dot(col, vec3(0.2126, 0.7152, 0.0722));
    float hk = 0.3 * smoothstep(150.0, 300.0, dist) * (1.0 - smoothstep(450.0, 750.0, dist)) * (1.0 - 0.85 * smoothstep(450.0, 280.0, dB)) * (1.0 - gully);
    // (only the too-blue troughs are pulled: the rest keeps its calibrated colour)
    hk *= smoothstep(1.2, 1.55, col.b / max(col.g, 1e-4));
    col = mix(col, lcol * vec3(0.3, 1.08, 1.22), hk * 2.0);
  }
  col *= mix(1.0, 0.62, gully); // the gully sits in the shade of the headland cliffs
  // the mid field (0.15-0.7 km) is teal, not the bluest band (measured G-B: far -22, mid -11, near -4)
  col *= mix(vec3(1.0), vec3(0.99, 1.07, 0.98), smoothstep(120.0, 300.0, dist) * (1.0 - smoothstep(550.0, 1000.0, dist)) * (1.0 - gully));
  // beach surf zone (inside the outer bar): suspended sand and fine bubbles make the water milky —
  // paler and greyer than the open-water teal (measured R +10-20 over dB 45-240, G/B ~ unchanged)
  {
    // (inner part only: between the outer lines the measured water stays saturated turquoise)
    float milkZ = beachG * smoothstep(125.0, 85.0, dB) * smoothstep(-2.0, 12.0, dBt) * (1.0 - gully);
    float lc = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col = mix(col, lc * vec3(0.64, 1.0, 1.42) * mix(1.32, 1.08, smoothstep(280.0, 520.0, dist)), milkZ * 0.6); // (near: paler, measured) // (measured (139,168,184): B-G +15)
  }
  // the rough far sea (0.4-5 km) is steel blue (measured G-B ~ -22): its sub-pixel facets mirror the
  // bluer sky well above the horizon band, not the grey-cyan horizon itself
  col *= mix(vec3(1.0), vec3(0.93, 0.94, 1.17), smoothstep(600.0, 1300.0, dist) * (1.0 - 0.5 * smoothstep(4000.0, 12000.0, dist)) * (1.0 - gully));
  // near field under the cliffs: deeper, saturated teal troughs (measured: less red, more green in
  // the dark water; the sky reflection greyed them), crests keep their colour
  float nearW = smoothstep(500.0, 180.0, dist) * (1.0 - gully);
  float dk = smoothstep(1.1, 0.5, dot(col, vec3(0.2126, 0.7152, 0.0722)) / max(baseL, 1e-4));
  col *= mix(vec3(1.0), mix(vec3(0.99, 1.0, 1.02), vec3(0.88, 1.08, 1.08), dk), nearW);
  // closest in (under ~250 m) the water is a lighter, greener turquoise (measured non-foam
  // (58-72, 134-140, 140-148), G-R 70-78; was G-R 55-65 and too dark at t = 0.5 / 12.5)
  col *= mix(vec3(1.0), vec3(0.97, 1.07, 1.05), smoothstep(270.0, 130.0, dist) * (1.0 - smoothstep(0.0, 0.3, gully)));

  // ---- foam material ----
  vec3 L = normalize(uSunDir);
  float thickL = smoothstep(0.15, 0.7, thick);
  // bubble plume: fresh whitewater drives a cloud of bubbles metres down; through the holes and
  // around the edges of the surface foam it glows pale turquoise (measured bubble plumes (99,157,164));
  // a breaking crest's face just ahead of the roller is thin and backlit (turquoise window)
  float plume = clamp(max(thick * 0.85, fresh), 0.0, 1.0) * smoothstep(0.1, 0.6, foam) * (1.0 - 0.6 * gully);
  col = mix(col, mix(uAerated, uCrest * 1.2, 0.35) * mix(0.9, 1.1, bub), plume * 0.3 * (1.0 - far));
  col = mix(col, uCrest * 1.35, clamp(wcFace, 0.0, 1.0) * 0.45 * (1.0 - far));
  // foam relief: thick foam stands proud of the water in clots, so every clot has a sun-lit cream
  // side and a blue-grey self-shadowed side (screen-space derivative bump on the wave normal)
  // broken crests: the bore is a 1-3 m step of tumbling whitewater (surfHeight); its wall faces the
  // way the wave runs (toward the low sun: cream-lit), the roller's back slope falls away (shaded)
  float Wc = front ? W1 : W0;
  float bw = 0.03 + 1.5 * fwidth(P.psi);
  float xb = clamp((du + bw) / bw, 0.0, 1.0);
  float dfr = (du < 0.0) ? 6.0 * xb * (1.0 - xb) / bw : 0.0;
  float ageB = max(du, 0.0) * uSurfT;
  float dro = du >= 0.0 ? -(1.1 / 3.0 * exp(-ageB / 3.0) + 0.9 / 1.1 * exp(-ageB / 1.1)) * uSurfT : 0.0;
  vec2 boreSlope = amp * Wc * 0.85 * (2.0 * dfr + dro) * gradPsi * surfG;
  boreSlope *= min(1.0, 1.6 / max(length(boreSlope), 1e-5));
  // (the foam lights with the wind-sea relief and the bore wall; the smooth swell profile under a
  // whitewater sheet only tilts it gently, or every sheet behind a crest would sit in shade)
  vec2 slopeF = (slope - surfSlope * surfG) * 1.6 + surfSlope * surfG * 0.35 + boreSlope;
  vec3 Nw = normalize(vec3(-slopeF.x, 1.0, -slopeF.y));
  float fh = 0.3 * foam * thickL * (0.55 * fineT + 0.25 * lace + 0.2 * f3.r) * nearF;
  vec3 dpx = dFdx(vWorld), dpy = dFdy(vWorld);
  vec3 r1 = cross(dpy, Nw), r2 = cross(Nw, dpx);
  float det = dot(dpx, r1);
  vec3 gH = sign(det) * (dFdx(fh) * r1 + dFdy(fh) * r2);
  vec3 Nf = normalize(abs(det) * Nw - gH);
  // pockets between the clots are self-shadowed (see less sun and sky)
  float cav = mix(1.0, smoothstep(0.12, 0.62, 0.7 * fineT + 0.3 * lace + 0.2 * foam - 0.08), thickL * 0.75 * nearF);
  // foam colours calibrated through the display contract (post/tonemap.js: invACES of the measured
  // sRGB of analysis/ocean.md), so the sun side really ends up cream after tone mapping:
  // sun-facing lip (248,240,218), fresh top (240,238,224), shaded side (156,192,215), old sheet (192,199,202)
  // (the phone's 4:2:0 chroma blur mixes a small whitecap's chroma with the turquoise water around
  // it: the fresh / lit tones carry extra warmth so the heads still read cream after post)
  const vec3 FOAM_LIT = vec3(7.5, 2.41, 0.59);   // (255,238,205)
  const vec3 FOAM_TOP = vec3(5.24, 2.55, 0.83);  // (250,238,212)
  const vec3 FOAM_SHADE = vec3(0.366, 0.765, 1.259);
  const vec3 FOAM_OLD = vec3(0.751, 0.869, 0.926);
  // sun-lit cream heads: breaking whitecaps and the fresh whitewater of the surf
  // (not the small reformed bores of the milky inner zone: those read as thin gold arcs)
  float hw = clamp(max(wcHead * mix(0.6, 0.85, lead), head * 2.08 * smoothstep(70.0, 100.0, dB)), 0.0, 1.0);
  hw = max(hw, nbHead);
  float freshF = clamp(max(max(fresh, hw), 0.35 * thick), 0.0, 1.0);
  float sunF = dot(Nf, L);
  // wrap lighting; the pockets between the clots are self-shadowed
  float litF = smoothstep(-0.3, 0.22, sunF + 0.12 * (Nf.y - 0.9)) * mix(0.3, 1.0, cav);
  litF *= mix(1.0, 0.45, gully); // cliff shade over the gully
  const vec3 FOAM_BASE = vec3(0.80, 0.915, 0.96); // (196,203,205) lit, not fresh: the sheet behind the heads
  vec3 foamCol = mix(FOAM_SHADE, mix(FOAM_BASE, FOAM_TOP, freshF), litF * litF * (3.0 - 2.0 * litF));
  // faces turned toward the low sun (the wall / lip of a breaking crest): warm cream
  foamCol = mix(foamCol, FOAM_LIT, smoothstep(0.04, 0.35, sunF) * smoothstep(0.2, 0.7, freshF) * cav);
  // streaky, clotted brightness inside the whitewater (log-ish: dim clots toward the shaded tone)
  foamCol = mix(foamCol, FOAM_OLD, clamp((1.0 - (0.72 + 0.22 * lace + 0.14 * bub)) * 1.2 + tkW * (0.45 - 0.5 * tex) * 0.8, 0.0, 0.7));
  // near: sun-lit bubble clots sparkle brighter than the churn around them
  foamCol *= 1.0 + 0.3 * smoothstep(0.5, 0.8, fineT) * nearF * thickL * smoothstep(0.3, 0.7, litF);
  // shaded, churning gully foam: cyan-white aerated churn, not grey-white (measured 150-190:
  // (138-151,176-179,194-196), > 190: (164-170,198,217-219))
  foamCol = mix(foamCol, vec3(0.42, 0.93, 1.42) * mix(0.8, 1.0, smoothstep(0.3, 0.7, lace + 0.3 * bub)), 0.85 * smoothstep(0.0, 0.5, gully));
  // thin foam (lace, bubbles just under the surface) takes the water's colour, lifted
  // (measured near-water lace: the water plus 30-70 in R, i.e. a grey lift, not a cyan brightening)
  // (near field under the cliffs: the lace is bubbles lit through turquoise water, a cyan lift — the
  // grey lift raised R by 10-17 over the bottom-left lace, measured)
  vec3 thinLift = mix(vec3(0.05, 0.06, 0.075), vec3(0.025, 0.07, 0.085), smoothstep(300.0, 180.0, dist) * (1.0 - beachG));
  vec3 thinCol = mix(col * 1.1 + thinLift, FOAM_OLD * 0.9, smoothstep(0.5, 0.85, f3.r) * 0.55);
  foamCol = mix(thinCol, foamCol, smoothstep(0.25, 0.65, thick));
  // lower-left wash: blue-white aerated churn (measured > 190: (170,209,216), 150-190: (132,181,192)),
  // not cream; clotted (brighter clots, greyer-blue churn between)
  float wM = clamp(max(washFr * 1.5, washL * 0.8), 0.0, 1.0);
  foamCol = mix(foamCol, vec3(0.42, 1.08, 1.6) * mix(0.72, 1.08, smoothstep(0.3, 0.7, 0.6 * fineT + 0.4 * lace)), wM);
  // distant surf heads are 1-3 px walls: the phone's sharpening leaves them as bright specks
  // (measured 1.4-2.1% of the far surf band > 215; the plain lit tone blurred to < 215)
  foamCol *= 1.0 + 1.1 * clamp(head * 2.0, 0.0, 1.0) * smoothstep(220.0, 1000.0, dist) * smoothstep(0.3, 0.8, litF);
  // foam follows the wave relief instead of sitting on top as a flat decal
  foamCol *= mix(0.78, 1.08, smoothstep(-1.2, 0.6, crestH));
  col = mix(col, foamCol, foam);

  // ---- near-field breakers (nearbreak.js): translucent turquoise upper face, aerated water under the
  // sheet, then the whitewater (wall / roller / sheet) over everything
  {
    const vec3 NB_FACE = vec3(0.133, 0.563, 0.332); // (92,172,138) light through the thin face
    col = mix(col, NB_FACE * mix(0.9, 1.15, fineT), NB.trans * 0.55);
    col = mix(col, uAerated, NB.aer * 0.35 * (1.0 - NB.cov));
    col = mix(col, NB.col, NB.cov);
  }
  if (uDebug > 0.5 && uDebug < 1.5) col = vec3(fract(P.psi), W0, foam);
  if (uDebug > 10.5 && uDebug < 11.5) col = vec3(NB.cov, NB.aer, NB.trans);
  if (uDebug > 11.5 && uDebug < 12.5) col = vec3(W0, ww0, fract(P.psi)); // (surf: whitewater / whiteW / phase)
  if (uDebug > 1.5 && uDebug < 2.5) col = vec3(clamp(dB / 400.0, 0.0, 1.0), clamp(depth / 20.0, 0.0, 1.0), clamp(dR / 50.0, 0.0, 1.0));
  if (uDebug > 2.5 && uDebug < 3.5) col = vec3(clamp(1.0 - J, 0.0, 1.0), wc, 0.0);
  if (uDebug > 3.5 && uDebug < 4.5) col = vec3(clamp(denseCov, 0.0, 1.0), wc, clamp(max(bandCov, oldF), 0.0, 1.0));
  col = applyAtmosphere(col, vWorld);
  if (uDebug > 4.5 && uDebug < 5.5) col = vec3(W0, clamp(denseCov, 0.0, 1.0), farFoam) * 3.0;
  if (uDebug > 6.5 && uDebug < 7.5) col = vec3(step(0.5, foam), step(0.5, farFoam), step(0.3, denseCov)) * 20.0;
  if (uDebug > 7.5 && uDebug < 8.5) col = vec3(step(0.5, W0), step(0.3, cmS), step(0.6, cmS)) * 20.0;
  if (uDebug > 5.5 && uDebug < 6.5) col = vec3(foam, thick, clamp(covLace, 0.0, 1.0)) * 3.0;
  if (uDebug > 9.5 && uDebug < 10.5) col = vec3(nb, nbT, W0) * 20.0;
  if (uDebug > 8.5 && uDebug < 9.5) col = vec3(step(fract(dB / 50.0), 0.06) * step(dB, 400.0), step(fract(dBt / 50.0), 0.06) * step(dBt, 400.0), step(fract(depth / 5.0), 0.08) * step(depth, 20.0)) * 20.0;
  gl_FragColor = vec4(col, 1.0);
}
`;

function lin(hex, k = 1) { return new THREE.Color(hex).multiplyScalar(k); }

export default async function create(ctx) {
  const { scene, uniforms, config, renderer, layout, quality, camera } = ctx;
  const oc = config.ocean;
  const tier = quality.tier;
  const prog = (v, l) => ctx.progress?.(v, l);
  const nextFrame = () => new Promise((r) => (typeof requestAnimationFrame !== 'undefined' ? requestAnimationFrame(() => r()) : setTimeout(r, 0)));

  // ---- FFT ----
  // N=128 still resolves every wave band of cascades 0 and 1 (only < 12 cm chop is lost) at 1/4 of
  // the FFT traffic. Prescaled half-float ping-pong halves intermediate memory traffic at every
  // tier; the final displacement maps already use half floats. Wave bands and update rate stay intact.
  const N = quality.software ? 64 : tier === 'high' ? 256 : 128;
  const dir = oc.waveDir;
  const dl = Math.hypot(dir[0], dir[1]);
  const Ls = oc.cascades;
  const kc1 = ((2 * Math.PI) / Ls[1]) * 6, kc2 = ((2 * Math.PI) / Ls[2]) * 6;
  const fft = createFFT(renderer, {
    N,
    cascades: [
      { L: Ls[0], kMin: 0, kMax: kc1 },
      { L: Ls[1], kMin: kc1, kMax: kc2 },
      { L: Ls[2], kMin: kc2, kMax: 1e9 },
    ],
    U: oc.windSpeed, fetch: oc.fetch, gamma: 3.3, spread: oc.spread,
    dir: [dir[0] / dl, dir[1] / dl], seed: 1234, amp: oc.fftAmp, choppiness: oc.choppiness,
    fullFloat: false, aniso: tier === 'high' ? 4 : 2,
  });
  prog(0.15, 'Ocean spectrum');
  await nextFrame();

  // ---- coastal field ----
  const gullyFn = (x, z, h) => {
    if (h > 0) return 0;
    const s = layout.polygonSDF(x, z, GULLY);
    return Math.max(0, Math.min(1, (4 - s) / 30)) * 0.9;
  };
  const lv = tier === 'high' ? 1 : 0.6;
  const yieldEvery = (base, span) => async (f) => { prog(base + span * f, 'Surf and shoreline'); await nextFrame(); };
  const L0 = await bakeLevel(layout, { minX: -200, maxX: 280, minZ: -620, maxZ: 60 }, Math.round(384 * lv), Math.round(544 * lv), gullyFn, yieldEvery(0.2, 0.35));
  const L1 = await bakeLevel(layout, { minX: -1600, maxX: 700, minZ: -3700, maxZ: 150 }, Math.round(256 * lv), Math.round(448 * lv), null, yieldEvery(0.55, 0.25));
  const L2 = await bakeLevel(layout, { minX: -7000, maxX: 2000, minZ: -42000, maxZ: 1000 }, 128, 512, null, yieldEvery(0.8, 0.12));
  const lut = buildTauLUT();
  const nbk = createNearBreakers();
  const foamTex = createFoamTexture(tier === 'high' ? 512 : 256);
  prog(0.95, 'Ocean surface');

  // ---- mesh ----
  // camera-centred wedge: rings from just below the lowest visible ray (~55 m) to 46 km; the half
  // angle covers the horizontal FOV plus the handheld pan, with a fixed angular step so the grid can
  // be snapped to whole steps of yaw (vertices never slide across the wave fields).
  // (high: 0.26 deg columns instead of 0.178 — 31% fewer triangles, pixel-identical within noise;
  // fewer rings did show in the far chop, so the ring count stays)
  const rings = tier === 'high' ? 300 : tier === 'medium' ? 180 : 120;
  const dThDeg = tier === 'high' ? 0.26 : tier === 'medium' ? 0.33 : 0.52;
  const halfFor = (aspect) => {
    const hh = Math.atan(Math.tan((camera.fov * Math.PI) / 360) * aspect) * (180 / Math.PI);
    return Math.min(75, Math.max(30, hh + 13));
  };
  let builtHalf = halfFor(camera.aspect);
  const mkGeo = (half) => {
    const segs = Math.round((2 * half) / dThDeg) + 1;
    return buildGrid(rings, segs, (dThDeg * (segs - 1)) / 2, 35, 48, 46000);
  };
  const geo = mkGeo(builtHalf);
  const dThRad = (dThDeg * Math.PI) / 180;

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      ...uniforms,
      uOT: { value: 0 },
      uDisp0: { value: fft.disp[0] }, uDisp1: { value: fft.disp[1] }, uDisp2: { value: fft.disp[2] },
      uDeriv0: { value: fft.deriv[0] }, uDeriv1: { value: fft.deriv[1] }, uDeriv2: { value: fft.deriv[2] },
      uLen: { value: new THREE.Vector3(Ls[0], Ls[1], Ls[2]) },
      uN: { value: N },
      uFFTAmp: { value: ctx.params.has('oceanfft') ? Number(ctx.params.get('oceanfft')) : 1.0 },
      uCoastA0: { value: L0.texA }, uCoastA1: { value: L1.texA }, uCoastA2: { value: L2.texA },
      uCoastB0: { value: L0.texB }, uCoastB1: { value: L1.texB }, uCoastB2: { value: L2.texB },
      uRect0: { value: L0.rect }, uRect1: { value: L1.rect }, uRect2: { value: L2.rect },
      uTau: { value: lut.tex },
      uSurfT: { value: SURF.T }, uSurfP: { value: SURF.p }, uDMax: { value: SURF.dMax },
      uSurfAmp: { value: oc.surfAmp },
      uFoam: { value: foamTex }, uFoamTile: { value: FOAM_TILE },
      uWaveDir: { value: new THREE.Vector2(dir[0] / dl, dir[1] / dl) },
      uDeep: { value: lin(oc.deep, oc.bodyGain) },
      uMid: { value: lin(oc.mid, oc.bodyGain) },
      uShallow: { value: lin(oc.shallow, oc.bodyGain) },
      uCrest: { value: lin(oc.crest, oc.bodyGain) },
      uMilky: { value: lin(oc.milky, oc.bodyGain) },
      uAerated: { value: lin(oc.aerated, oc.bodyGain) },
      uFoamSky: { value: lin(oc.foamSky, oc.foamSkyGain) },
      uReflScale: { value: oc.reflScale },
      uFresMax: { value: oc.fresnelMax },
      uWcThresh: { value: oc.whitecapJ },
      uNbThr: { value: oc.breakerJ },
      uSlopeGain: { value: oc.slopeGain },
      uDebug: { value: Number(ctx.params.get('oceandebug') || 0) },
      ...nbk.uniforms,
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    defines: tier === 'high' ? {} : tier === 'medium' ? { OCEAN_LQ: 1 } : { OCEAN_LQ: 1, OCEAN_LOW: 1 },
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.name = 'ocean';
  scene.add(mesh);

  const fwd = new THREE.Vector3();
  const filterView = createGridViewFilter(mesh, camera);
  function placeMesh() {
    camera.getWorldDirection(fwd);
    mesh.position.set(camera.position.x, 0, camera.position.z);
    // rebuild (~9 MB upload) only when the view got wider than the built wedge, or much narrower
    // (e.g. rotated to portrait) — not on every small aspect change (mobile address bar)
    const need = halfFor(camera.aspect);
    if (need > builtHalf + 1e-3 || need < builtHalf - 12) {
      builtHalf = need;
      const old = mesh.geometry;
      mesh.geometry = mkGeo(builtHalf);
      old.dispose();
    }
    const yaw = Math.atan2(-fwd.x, -fwd.z);
    mesh.rotation.set(0, Math.round(yaw / dThRad) * dThRad, 0);
    mesh.updateMatrixWorld();
    filterView();
  }

  // ---- breaker events (mirrors the GLSL surf model) ----
  // crestStrength: bit-exact JS mirror of the GLSL (integer hash), imported from surf.glsl.js
  // surf-phase shoreline (beach waterline continued north through the headland, as baked)
  const SL = [...SURF_LINE, ...layout.BEACH_WATERLINE];
  const shoreAt = (z) => {
    for (let i = 0; i < SL.length - 1; i++) {
      const [ax, az] = SL[i], [bx, bz] = SL[i + 1];
      if (z <= az && z >= bz) {
        const m = (bx - ax) / (bz - az);
        return { x: ax + m * (z - az), k: Math.sqrt(1 + m * m) };
      }
    }
    return { x: SL[SL.length - 1][0], k: 1 };
  };
  const HALF_FOV = (33 * Math.PI) / 180;
  const smooth = (e0, e1, x) => { const k = Math.max(0, Math.min(1, (x - e0) / (e1 - e0))); return k * k * (3 - 2 * k); };
  // Breaking waves in view between t0 and t1 (sorted by time): {time, x, z, strength, kind, pan, dist}
  // kind 'outer' (big plunging sets, 170-280 m out, incl. the reef break left of the platform) or
  // 'inner' (reforming waves at ~114 m, strength <= 0.6). pan: -1 left .. +1 right of the view axis.
  function breakerEvents(t0, t1) {
    const out = [];
    const cx = camera.position.x, cz = camera.position.z;
    for (let z = 20; z >= -1600; z -= z > -400 ? 30 : 60) {
      const sh = shoreAt(z);
      for (const kind of ['outer', 'inner']) {
        // break distance depends on the crest; iterate candidate crests
        // (north end: every break distance is measured from the shifted line, see surfBreakOff)
        const off = surfBreakOff(z + 0.35 * (kind === 'outer' ? 210 : 112));
        const dRef = (kind === 'outer' ? 210 : 112) + off;
        const s = z + 0.35 * dRef;
        const tau = lut.tauAt(dRef);
        const i0 = Math.floor((t0 + tau - SURF.p * z) / SURF.T) - 2;
        const i1 = Math.ceil((t1 + tau - SURF.p * z) / SURF.T) + 2;
        for (let i = i0; i <= i1; i++) {
          const A = crestStrength(i, s);
          let d, strength;
          if (kind === 'outer') {
            if (A < 0.5 * (WW_OUTER[0] + WW_OUTER[1])) continue; // mid-point of whiteW's outer-bar ramp
            d = OUTER_BREAK[0] + OUTER_BREAK[1] * A; strength = Math.min(1, 0.4 + 0.6 * A);
          } else {
            const k = Math.max(0, Math.min(1, (A - WW_INNER[0]) / (WW_INNER[1] - WW_INNER[0])));
            strength = k * k * (3 - 2 * k) * 0.6;
            if (strength < 0.08) continue;
            d = 114;
          }
          d += off;
          const x = sh.x - d * sh.k;
          const hd = -layout.heightAt(x, z);
          if (hd < 0.5) continue; // behind the headland / platform
          // same depth gate as whiteW() in the shader
          const hdO = hd - 0.07 * off; // (shifted with the break line, see surfBreakOff)
          const g = kind === 'outer' ? smooth(15.0, 10.5, hdO) : smooth(6.0, 4.2, hdO);
          strength *= g * surfRipG(x, z); // (and no surf in the rip channel by the headland)
          if (strength < 0.08) continue;
          // (warped crest lines: surf.glsl.js surfWarp / crestTime)
          const tb = crestTime(i, lut.tauAt(d), z, d);
          if (tb >= t0 && tb < t1) {
            const ang = Math.atan2(x - cx, -(z - cz));
            if (Math.abs(ang) > HALF_FOV * 1.3) continue;
            // crest: [index, alongshore s, distance] for the spray's segmentation gate
            out.push({ time: tb, x, z, strength, kind, pan: Math.max(-1, Math.min(1, ang / HALF_FOV)), dist: Math.hypot(x - cx, z - cz), crest: [i, z + 0.35 * d, d - off] });
          }
        }
      }
    }
    out.sort((a, b) => a.time - b.time);
    return out;
  }

  placeMesh();
  fft.update(0);

  return {
    mesh,
    params: { breakerPeriod: SURF.T, loop: OCEAN_LOOP, hs: fft.hs },
    breakerEvents,
    crestStrength, // JS mirror of the GLSL crest strength (audio uses it for the rock surges)
    dispose() { fft.dispose(); },
    update(t) {
      const tl = ((t % OCEAN_LOOP) + OCEAN_LOOP) % OCEAN_LOOP;
      mat.uniforms.uOT.value = tl;
      nbk.update(tl);
      fft.update(t);
      placeMesh();
    },
  };
}
