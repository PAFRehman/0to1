// Shared hierarchical vegetation wind (vertex-shader side). Pure function of time.
//
// Every animated vertex carries
//   aWind0 = (w0, w1, w2, flex)  normalised position along its limb / branch / twig (0 at the
//                                attachment, 1 at the tip; children inherit the parent's value at the
//                                attachment point so the hierarchy stays connected), flex = amplitude scale
//   aWind1 = (ph0, ph1, ph2, seed) random phases per level + a per-element seed
// vegWind(p, aWind0, aWind1) returns a world-space displacement in metres.
//
// Numbers from analysis/vegetation.md: limb 0.45 Hz / ~2 cm, crown (branch) 0.55 Hz / 4.5 cm h + 2.8 cm v
// shared by every spray of a crown (bulk 1.6 / 1.0 px), twig+spray 0.64 Hz / 4 cm (spray-relative
// 1.5 px), 2.4-3.6 Hz spray shimmer; gusts advect downwind at 7 m/s, sway amplitude grows with the
// local gust multiplier (0.4 + 0.6 G^2). Modelled crown B: bulk 1.67/1.01 px, relative 1.55 px,
// velocity power <1 / >2 Hz = 76 / 16 % (ref 71 / 14 %). On top, each crown spray card moves with a
// spatially coherent sway field (0.7-1.35 Hz, ~9 cm), 2-4 Hz buffeting and a texture-space ripple:
// DIS-flow residual (non-rigid) motion of crowns B+C at t = 4 s, half res: 0.28-0.34 px/frame
// (ref 0.36-0.42; was 0.13).
import { GUST_GLSL, GUST_ADVECTION } from '../../core/wind.js';

export const VEG_WIND_GLSL = /* glsl */ `
uniform float uTime;
uniform vec2 uWindDir;
uniform vec3 uViewPos;
${GUST_GLSL}
// quantise frequencies to multiples of 1/60 Hz: all motion is periodic over the 60 s loop, and time is
// wrapped to [0, 60) so float precision never decays over long sessions (gustMulAt is 3600 s periodic)
float vegQ(float f){ return floor(f * 60.0 + 0.5) / 60.0; }
float vegT(){ return mod(uTime, 60.0); }
// the gust is periodic over 3600 s (core/wind.js) and uTime is uploaded wrapped to [0, 3600)
float vegGust(vec3 p){ return gustMulAt(mod(uTime, 3600.0) - dot(p.xz, uWindDir) / ${GUST_ADVECTION.toFixed(2)}); }
float vegSway(float t, float f, float ph){
  float a = 6.2831853 * f * t + ph;
  return sin(a) + 0.18 * sin(2.0 * a + 0.9) + 0.25 * sin(6.2831853 * vegQ(0.63 * f) * t + ph * 1.63);
}
vec3 vegWind(vec3 p, vec4 w, vec4 ph){
  float G = vegGust(p);
  float amp = (0.4 + 0.6 * G * G) * w.w;
  float lean = (G - 1.0) * 0.9 * w.w;
  vec3 wd = vec3(uWindDir.x, 0.0, uWindDir.y);
  vec3 sd = vec3(-uWindDir.y, 0.0, uWindDir.x);
  float t = vegT();
  float f0 = vegQ(0.45 * (0.9 + 0.2 * fract(ph.x * 3.17)));
  float f1 = vegQ(0.55 * (0.85 + 0.3 * fract(ph.y * 5.31)));
  float f2 = vegQ(0.64 * (0.8 + 0.35 * fract(ph.z * 7.13)));
  float s0 = vegSway(t, f0, ph.x), s1 = vegSway(t, f1, ph.y), s2 = vegSway(t, f2, ph.z);
  float c2 = cos(6.2831853 * vegQ(f2 * 1.07) * t + ph.z * 1.3);
  float k0 = w.x * w.x, k1 = w.y * w.y, k2 = w.z * w.z;
  // crown-scale sway dominates (every spray of a crown shares the branch phase), per-twig jiggle is small
  vec3 d = wd * (0.020 * k0 * (s0 * amp + lean)
               + 0.045 * k1 * (s1 * amp + lean)
               + 0.040 * k2 * (s2 * amp + lean * 1.2));
  d += vec3(0.0, 1.0, 0.0) * (0.008 * k0 * cos(6.2831853 * f0 * t + ph.x) + 0.028 * k1 * cos(6.2831853 * f1 * t + ph.y) + 0.018 * k2 * c2 - 0.02 * k2 * lean) * amp;
  d += sd * (0.006 * k1 * sin(6.2831853 * vegQ(f1 * 0.8) * t + ph.y * 2.1) + 0.012 * k2 * sin(6.2831853 * vegQ(f2 * 0.77) * t + ph.z * 2.3)) * amp;
  // close-up pendulous branch (flex < 1): vertical bobbing dominates (ref: 11-13 px rms at 0.68 Hz)
  if (w.w < 0.9) {
    float e = k2 + 0.5 * k1;
    d.y += e * amp * (0.045 * c2 + 0.02 * sin(6.2831853 * vegQ(0.45) * t + ph.x * 2.0) + 0.018 * sin(6.2831853 * vegQ(1.2) * t + ph.z * 3.1));
  }
  return d;
}
`;

// Replaces three's <begin_vertex> for tubes (branches): displace every vertex.
// Twigs thinner than ~1 px at 1080p (3.4e-4 rad radius) are widened to that footprint and their true
// coverage goes out as alpha (alpha-to-coverage in trees.js): sub-pixel twigs render as soft grey lines
// instead of dotted, near-black ones (the video's thin twigs are mid-grey against the sea).
export const BRANCH_BEGIN_VERTEX = /* glsl */ `
float bRmin = max(3.4e-4, 0.5 * uVegPx) * length(position - uViewPos);
vec3 transformed = vec3(position) + normal * max(0.0, bRmin - aRad) + vegWind(position, aWind0, aWind1);
`;
// Replaces <beginnormal_vertex>: tubes under ~2 px shade with the axis-perpendicular normal facing the
// camera (the same on every vertex of a ring), so a 3-sided twig never shows a lit facet as a row of
// sparkling dots.
export const BRANCH_BEGIN_NORMAL = /* glsl */ `
vec3 objectNormal = vec3( normal );
{
  float bR1 = max(3.4e-4, 0.5 * uVegPx) * length(position - uViewPos);
  float bThin = 1.0 - smoothstep(1.5 * bR1, 3.0 * bR1, aRad);
  vec3 bV = normalize(uViewPos - position);
  vec3 bN = bV - aTan * dot(aTan, bV);
  float bl = length(bN);
  if (bl > 1e-3) objectNormal = normalize(mix(objectNormal, bN / bl, bThin));
}
`;

// Foliage cards: attached at aAnchor, following the host twig tip. The card itself only rolls ~2 deg
// and BENDS (displacement grows with the squared distance from the attachment, so the free strand
// ends lag and stream at ~0.64 Hz); tiny 1-2.5 Hz tip flutter. Measured targets (flow vs ref):
// crown velocity ~0.4-0.5 px/frame at 30 fps with >70 % of the power below 1 Hz.
export const CARD_BEGIN_VERTEX = /* glsl */ `
vec3 anc = aAnchor;
vec3 off = position - anc;
float cG = vegGust(anc);
float cSeed = aWind1.w;
float g15 = pow(cG, 1.5) * aWind0.w;
// slow roll about the attachment (+-2 deg); most motion comes from the host branch sway below
float vt = vegT();
float fq = vegQ(1.0 + 1.5 * fract(cSeed * 7.31));
float roll = (0.035 * sin(6.2831853 * vegQ(0.64) * vt + cSeed * 40.0) + 0.006 * sin(6.2831853 * fq * vt + cSeed * 91.0)) * g15;
vec3 ax = normalize(uViewPos - anc);
float cr = cos(roll), sr = sin(roll);
off = off * cr + cross(ax, off) * sr + ax * dot(ax, off) * (1.0 - cr);
vec3 wd3 = vec3(uWindDir.x, 0.0, uWindDir.y);
off += wd3 * dot(off, wd3) * 0.12 * (cG - 1.0);
// bending: the attachment stays put, the free strand ends lag and stream (quadratic in distance)
// aLocal = offset from the attachment in units of the card size
float fl = (max(aLocal.x, 0.0) + 0.5 * abs(aLocal.y)) * 0.5;
float bend = fl * fl;
float fb = vegQ(0.64 * (0.85 + 0.3 * fract(cSeed * 3.7)));
float bph = 6.2831853 * fb * vt + cSeed * 23.0;
vec3 flut = (wd3 * (sin(bph) + 0.3 * sin(6.2831853 * vegQ(2.1 * fb) * vt + cSeed * 48.3 + 1.3)) + vec3(0.0, 0.45, 0.0) * cos(6.2831853 * vegQ(0.93 * fb) * vt + cSeed * 21.4 + 0.7)) * (0.05 * bend * g15 * aCardSize)
          + (wd3 + vec3(0.0, 0.6, 0.0)) * sin(6.2831853 * fq * vt + cSeed * 57.0) * (0.008 * bend * g15);
// crown sprays: each spray also sways on its own (0.5-1.2 Hz, 4.5 cm downwind / 2.2 cm vertical /
// 2 cm across, ~2 px at 22 m) on top of the shared crown sway, and buffets at 2-4 Hz (1.8 cm): the
// crowns 'boil' internally like the video instead of moving as rigid sheets (flow residual ~0.5 px/frame)
// The spray sway is a spatially coherent field (phase from the anchor position, ~1.6 m wavelength,
// + a little per-spray jitter; ~9 cm downwind, 4 cm vertical): neighbouring sprays move together, lumps a metre apart move out of
// phase, which is what reads (and measures) as the crowns' internal motion; independent per-card
// motion would average out under the overlapping see-through sprays.
float crownK = step(0.9, aWind0.w) * (0.45 + 0.55 * g15) * (aWind0.w < 0.99 ? 0.65 : 1.0); // (r4b: flex 0.95 flags crown B: calmer sprays, ref)
float swPh = dot(anc, vec3(4.3, 3.4, 2.7)) + cSeed * 1.8;
vec3 sdir3 = vec3(-uWindDir.y, 0.0, uWindDir.x);
flut += (wd3 * (0.085 * sin(6.2831853 * vegQ(0.85) * vt + swPh) + 0.035 * sin(6.2831853 * vegQ(1.35) * vt + swPh * 1.7 + 1.1))
       + vec3(0.0, 0.04, 0.0) * cos(6.2831853 * vegQ(1.05) * vt + swPh * 1.3)
       + sdir3 * (0.03 * sin(6.2831853 * vegQ(0.7) * vt + swPh * 0.8))) * crownK;
float fs = vegQ(2.0 + 2.0 * fract(cSeed * 5.13));
flut += (wd3 + vec3(0.0, 0.6, 0.0)) * sin(6.2831853 * fs * vt + cSeed * 71.0) * (0.028 * crownK);
vec3 transformed = anc + vegWind(anc, aWind0, aWind1) + off + flut;
// |vTexBias| = mip bias; the sign flags the close-up branch E (< 0: drawn by the blended pass only)
vTexBias = aWind0.w < 0.9 ? -1.3 : 0.6; /* r5: crowns 1.0 -> 0.6 (the combed atlas tufts keep a fine streak grain, ref hp at 1.5 px ~7.4-9.4); E: larger curtain cards, their strands resolve like the ref's at t 9 */ /* r4b: a little crisper (ref fine 1-2 px contrast B 9.1 / C 12.1 vs ours 7.9 / 9.6; E shows its fibres) */ // E soft (out of focus + motion, CoC ~3-4 px, ref); distant tufts: soft, motion-blurred ~2-3 px streaks (r4: +0.15, ref 1-2 px contrast ~0.85x ours)
// texture-space ripple (threads wave inside the card): x = distance from the attachment, y = phase
float fr = vegQ(1.6 + 1.4 * fract(cSeed * 9.7));
vCardRip = vec3(max(aLocal.x, 0.0), 6.2831853 * fr * vt + cSeed * 40.0, g15);
`;

export const CARD_ATTRIBS_GLSL = /* glsl */ `
attribute vec4 aWind0;
attribute vec4 aWind1;
attribute vec3 aAnchor;
attribute vec2 aLocal;
attribute float aCardSize;
varying float vTexBias;
varying vec3 vCardRip;
`;

export const BRANCH_ATTRIBS_GLSL = /* glsl */ `
attribute vec4 aWind0;
attribute vec4 aWind1;
attribute float aRad;
attribute vec3 aTan;
uniform float uVegPx;
`;

// Patch a built-in material (Standard/Lambert/Depth/Distance) with the wind displacement.
// kind: 'branch' | 'card'. `uniforms` = ctx.uniforms (shared objects), viewPos = uniform object.
// (r4b) angular size of one render-target pixel (rad), set every frame by trees.js update(): the
// sub-pixel twig widening keeps twigs >= 1 px wide at any render size (medium / low tiers, dynamic
// resolution) - a fixed 1080p footprint broke them into dashes on smaller targets
export const VEG_PX = { value: 6.8e-4 };
export function patchVegWind(material, kind, uniforms, viewPos, extra) {
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    shader.uniforms.uTime = uniforms.uTime;
    shader.uniforms.uWindDir = uniforms.uWindDir;
    shader.uniforms.uViewPos = viewPos;
    shader.uniforms.uVegPx = VEG_PX;
    const attribs = kind === 'card' ? CARD_ATTRIBS_GLSL : BRANCH_ATTRIBS_GLSL;
    const body = kind === 'card' ? CARD_BEGIN_VERTEX : BRANCH_BEGIN_VERTEX;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + attribs + VEG_WIND_GLSL)
      .replace('#include <begin_vertex>', body);
    if (kind === 'branch') shader.vertexShader = shader.vertexShader.replace('#include <beginnormal_vertex>', BRANCH_BEGIN_NORMAL);
    if (extra) extra(shader);
    if (prev) prev(shader, renderer);
  };
  const prevKey = material.customProgramCacheKey.bind(material);
  material.customProgramCacheKey = () => 'vegwind-' + kind + '|' + prevKey();
  return material;
}
