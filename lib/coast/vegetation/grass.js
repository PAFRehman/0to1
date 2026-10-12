// Grass: a draped leafy ground mat + instanced blades, seed stalks, weed rosettes and dead-grass
// tussocks on the foreground headland.
//
// - Mat: a thin mesh draped 4 cm over the headland grass (heightAt), shaded per pixel:
//   * macro structure: raised mats of small-leaved herbs (domain-warped, footprint-filtered fbm,
//     0.3-1.5 m, lumpy edges) between flatter, yellower turf; the mats' camera-facing edges (the
//     field sampled 30 cm further along the view ray) show their dark leaf undersides, and the
//     turf around a mat is slightly occluded;
//   * herb mats: 3 layers of scattered oval leaves (2.6 / 4.5 / 7.5 cm, "texture bombing" with
//     random size/orientation/absence, no lattice) over deep gaps, cool grey-blue sky sheen on the
//     upper leaves (lower roughness), 10-20 cm lumpiness;
//   * turf: blade-tip speckle and radial blade strokes (standing blades project to vertical
//     strokes: the streak noise runs in (azimuth, distance) around the fixed eye), dark tuft gaps,
//     a brightness-independent hue drift and reddish-brown dead patches;
//   * bare soil with small pebbles along the cliff lip and under the dead shrubs, a few tiny
//     flowers, grey-brown needle litter drifts under the she-oaks, the reddish dead-grass zones.
//   Every layer fades to its mean by its own pixel footprint (max of both screen axes), so nothing
//   aliases or sparkles and detail appears with resolution (more at 1440p than at 720p).
// - Blades (5 tris) scattered 5..32 m from the eye inside the (pan-widened) view wedge with a
//   1/d^2 density, widened to >= 1 px with alpha-to-coverage, faded out with distance (LOD);
//   occluded dark bases, straw / bleached tips on a quarter of the near blades, ~1 % seed stalks
//   with a spindle-shaped seed head (near field only).
// - Tussocks: near the casuarinas, big soft reddish-brown mounds (150-210 fine arching blades,
//   darker core, paler outer blades); further back, smaller clusters in the dead-grass band.
// - Weeds: clustered 6-leaf rosettes (near field only) with a lower roughness (grey-blue sky sheen).
// Lighting (shared with shrubs.js): sun x baked terrain self-shadow x sun mask (the reference
// foreground slope is in shade; only the brow behind the trees is sunlit) with the tree shadow
// map, a forward-scattering translucency term, and the terrain's own sky ambient (no warm tint).
// Everything is a pure function of uTime (deterministic, loops forever).
import * as THREE from 'three';
import { mulberry32, fbm2, valueNoise2 } from '../core/rng.js';
import { WIND_UNIFORMS_GLSL, WIND_FIELD_GLSL } from '../core/wind.js';
import { patchMaterialAtmosphere } from '../core/atmosphere.js';
import { CONFIG, DEG } from '../config.js';

// sRGB albedo palette (hue ~80 deg, tuned against the reference after lighting + grade)
export const GRASS_COLOR = {
  green: '#818056',
  greenDark: '#424830',
  greenLight: '#93967c',
  dry: '#9e8f70',
  dead: '#8a6e63', // reddish-brown (slightly mauve) dead grass / tussocks
  weed: '#879a6a',
};

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// ---- world-space masks (JS; the mat has GLSL copies via per-vertex attributes) ----------------
// Dead-grass / tussock zones measured by raycasting the reference: the tussock mass right of the
// casuarina feet (image x 930-1276, rows 555-625, 11-20 m) and the band behind the trees along the
// brow (image x 765-1210, rows 480-520, 30-55 m). Broken up with ~3 m noise.
export function deadMaskAt(x, z) {
  const near = smooth(2.6, 4.4, x + 0.12 * (z + 12)) * smooth(-7.9, -8.9, z) * smooth(-14.6, -12.4, z);
  const zc = -30.5 - 0.45 * (x - 4);
  const far = smooth(7.5, 3.5, Math.abs(z - zc)) * smooth(2.0, 5.0, x) * smooth(36, 28, x);
  // needle litter / dead grass under and behind the casuarinas (image rows ~500-545)
  const zl = -22.0 - 0.3 * (x - 4);
  const litter = smooth(5.0, 2.0, Math.abs(z - zl)) * smooth(3.0, 5.5, x) * smooth(20, 15, x) * 0.85;
  const band = Math.max(far, litter);
  const brk = smooth(0.25, 0.5, fbm2(x * 0.33 + 7.0, z * 0.33 - 3.0, 3));
  const clump = smooth(0.3, 0.48, fbm2(x * 0.8 - 3.0, z * 0.8 + 5.0, 3)); // ~1.2 m tussock clusters
  return Math.min(1, Math.max(near * clump * (0.6 + 0.4 * brk), band * (0.7 + 0.3 * brk)));
}
// Grass under the crowns reads grey and desaturated in the reference (66-72,69-79,63-65).
export function crownMaskAt(x, z) {
  return smooth(3.0, 5.5, x) * smooth(-7.5, -10.5, z) * smooth(-32, -24, z) * smooth(20, 14, x);
}
// Dead grey shrubs along the left cliff lip: base pixels in the 1276x718 reference frame (t = 0.5)
// raycast through CONFIG.camera onto heightAt, so they follow any change of the camera or the lip.
// [px, py, height (m), stems]
export const DEAD_SHRUB_PX = [[282, 676, 0.62, 4], [350, 664, 0.7, 4], [414, 656, 0.72, 4], [470, 647, 0.55, 3], [526, 632, 0.5, 3], [580, 618, 0.4, 2]];
export function refCameraRay(layout, px, py, W = 1276, H = 718, atHorizDist = 0) {
  const c = CONFIG.camera;
  const cam = new THREE.PerspectiveCamera(c.vfovDeg, W / H, 0.1, 1000);
  cam.position.fromArray(c.position);
  cam.rotation.order = 'YXZ';
  cam.rotation.set(c.pitchDeg * DEG, c.yawDeg * DEG, c.rollDeg * DEG);
  cam.updateMatrixWorld(); cam.updateProjectionMatrix();
  const dir = new THREE.Vector3(px / W * 2 - 1, 1 - py / H * 2, 0.5).unproject(cam).sub(cam.position).normalize();
  const at = (t) => cam.position.clone().addScaledVector(dir, t);
  if (atHorizDist > 0) return at(atHorizDist / Math.max(1e-6, Math.hypot(dir.x, dir.z)));
  let prev = 0.5;
  for (let t = 0.5; t < 600; t += Math.max(0.05, t * 0.01)) {
    const p = at(t);
    if (p.y <= layout.heightAt(p.x, p.z)) {
      let a = prev, b = t;
      for (let k = 0; k < 20; k++) { const m = (a + b) / 2, q = at(m); if (q.y <= layout.heightAt(q.x, q.z)) b = m; else a = m; }
      return at(b);
    }
    prev = t;
  }
  return null;
}
export function deadShrubSpots(layout) {
  return DEAD_SHRUB_PX.map(([px, py, h, stems]) => {
    const p = refCameraRay(layout, px, py) || new THREE.Vector3(-3, 30, -9);
    return { x: p.x, y: layout.heightAt(p.x, p.z), z: p.z, h, stems };
  });
}
// Direct-sun mask: the reference foreground slope is in shade (tree shadows from the right plus
// terrain); only the brow strip behind the trees (image x 1100-1276, rows 485-510, with the golden
// patch at x 1140-1205, rows 488-505) is sunlit.
// A second, golden lobe: the sunlit strip in front of the brow between the dead trees' shadows
// (reference x 590-770, rows 528-548 at t=0.5 -> x -1..3.5, z -19..-27), with a ragged edge.
export function sunMaskAt(x, z) {
  const brow = smooth(11.0, 14.0, x) * smooth(-23.0, -26.5, z) * smooth(0.25, 0.5, fbm2(x * 0.25 + 1.0, z * 0.25, 2) + 0.12);
  const rag = fbm2(x * 0.9 + 13.0, z * 0.9 - 4.0, 3);
  const gold = smooth(-2.2, -0.6, x) * smooth(4.4, 2.8, x) * smooth(-18.6, -20.2, z) * smooth(-28.0, -25.8, z) * smooth(0.3, 0.5, rag + 0.08);
  return Math.max(brow, gold);
}

// Pure function of position: ground-level grass albedo (linear), exported for the terrain.
export function grassAlbedo(x, z, out = new THREE.Color()) {
  const n1 = fbm2(x * 0.17 + 5.1, z * 0.17 - 2.7, 3); // ~6 m
  const n2 = fbm2(x * 0.7 - 7.3, z * 0.7 + 1.9, 3); // ~1.5 m
  const n3 = valueNoise2(x * 3.3, z * 3.3); // 0.3 m
  out.copy(lin(GRASS_COLOR.greenDark)).lerp(lin(GRASS_COLOR.green), smooth(0.25, 0.7, n2));
  out.lerp(lin(GRASS_COLOR.greenLight), smooth(0.55, 0.8, n1) * 0.5);
  out.lerp(lin(GRASS_COLOR.dry), smooth(0.62, 0.85, n1 * 0.6 + n3 * 0.4) * 0.35);
  out.lerp(lin(GRASS_COLOR.dead), deadMaskAt(x, z));
  return out;
}
const _c = {};
function lin(hex) { if (!_c[hex]) _c[hex] = new THREE.Color(hex); return _c[hex]; }

// ---- shared vegetation lighting (also used by shrubs.js) ----------------------------------------
// sun: GLSL float expression (baked sun visibility x mask), occ: indirect occlusion expression,
// trans: forward-scattering translucency weight (thin leaves/blades), all evaluated in the fragment.
// reuseShadow: take the shadowed sun from the light loop (directLight) instead of sampling the shadow
// map again; that colour also carries the far shadow, so meshes outside the near shadow box (the
// distant bush) pass false to keep their translucency unshadowed as tuned.
export function patchVegLighting(sh, uniforms, { sun = '1.0', occ = '1.0', trans = '0.0', specOcc = null, reuseShadow = true } = {}) {
  sh.uniforms.uSkyZenith = uniforms.uSkyZenith;
  sh.uniforms.uSkyHorizon = uniforms.uSkyHorizon;
  sh.fragmentShader = sh.fragmentShader
    .replace('#include <common>', '#include <common>\nuniform vec3 uSkyZenith;\nuniform vec3 uSkyHorizon;')
    .replace('#include <lights_fragment_end>', /* glsl */ `#include <lights_fragment_end>
      #if NUM_DIR_LIGHTS > 0 && ${trans === '0.0' ? 0 : 1}
      {
        vec3 gTL = directionalLights[0].direction;
        #if NUM_DIR_LIGHTS == 1 && defined( RE_Direct ) && ${reuseShadow ? 1 : 0}
        // the directional loop in lights_fragment_begin left the (single) sun in directLight, its
        // colour already multiplied by the shadow map (and the far shadow, 1 inside the near box)
        vec3 gTC = directLight.color;
        #else
        vec3 gTC = directionalLights[0].color;
        #if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
        gTC *= getShadow( directionalShadowMap[0], directionalLightShadows[0].shadowMapSize, directionalLightShadows[0].shadowIntensity, directionalLightShadows[0].shadowBias, directionalLightShadows[0].shadowRadius, vDirectionalShadowCoord[0] );
        #endif
        #endif
        float gFwd = clamp(dot(-geometryViewDir, gTL), 0.0, 1.0);
        reflectedLight.directDiffuse += diffuseColor.rgb * gTC * (0.25 + 0.75 * gFwd * gFwd) * (${trans}) * RECIPROCAL_PI;
      }
      #endif
      reflectedLight.directDiffuse *= (${sun}); reflectedLight.directSpecular *= (${sun});`)
    .replace('#include <aomap_fragment>', /* glsl */ `#include <aomap_fragment>
      {
        // the terrain's sky ambient (shared sky colours; scene.environment is too blue on land)
        vec3 gWN = inverseTransformDirection(normal, viewMatrix);
        float gUp = clamp(gWN.y * 0.5 + 0.5, 0.0, 1.0);
        vec3 gSkyAmb = mix(uSkyHorizon, uSkyZenith, 0.35) * 1.15;
        vec3 gGndAmb = vec3(0.10, 0.095, 0.07);
        reflectedLight.indirectDiffuse = diffuseColor.rgb * mix(gGndAmb, gSkyAmb, gUp) * (${occ});
        reflectedLight.indirectSpecular *= (${specOcc || occ});
      }`);
}

// Terrain self-shadow toward the low sun (same method as the terrain's baked term): march a
// height grid toward the sun and compare the steepest occluder slope with the sun elevation.
export function makeSunVis(layout, sunDir) {
  const X0 = -40, X1 = 420, Z0 = -160, Z1 = 90, S = 2;
  const nx = Math.round((X1 - X0) / S) + 1, nz = Math.round((Z1 - Z0) / S) + 1;
  const g = new Float32Array(nx * nz);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) g[j * nx + i] = Math.max(0, layout.heightAt(X0 + i * S, Z0 + j * S));
  const len = Math.hypot(sunDir.x, sunDir.z);
  const dx = sunDir.x / len, dz = sunDir.z / len, tanE = sunDir.y / len;
  const sample = (x, z) => {
    const fx = (x - X0) / S, fz = (z - Z0) / S;
    const i = Math.min(nx - 2, Math.max(0, Math.floor(fx))), k = Math.min(nz - 2, Math.max(0, Math.floor(fz)));
    const u = Math.min(1, Math.max(0, fx - i)), v = Math.min(1, Math.max(0, fz - k));
    const a = g[k * nx + i], b = g[k * nx + i + 1], c = g[(k + 1) * nx + i], d = g[(k + 1) * nx + i + 1];
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
  return (x, z, h) => {
    let maxSlope = -1, t = 1.0;
    while (t < 600) {
      const px = x + dx * t, pz = z + dz * t;
      if (px < X0 || px > X1 || pz < Z0 || pz > Z1) break;
      const sl = (sample(px, pz) - h) / t;
      if (sl > maxSlope) maxSlope = sl;
      if (h + t * tanE > 120) break;
      t += Math.max(1.0, t * 0.05);
    }
    return 1 - smooth(tanE - 0.012, tanE + 0.018, maxSlope);
  };
}

// GLSL noise for the mat: hashed value noise (broad colour only) and hashed-gradient simplex noise
// (all fine detail: no lattice-aligned diamonds or cells).
const MAT_NOISE_GLSL = /* glsl */ `
float gmH12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 gmH22(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
float gmVN(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(gmH12(i), gmH12(i + vec2(1.0, 0.0)), f.x), mix(gmH12(i + vec2(0.0, 1.0)), gmH12(i + vec2(1.0, 1.0)), f.x), f.y); }
float gmFbm(vec2 p){ float a = 0.5, s = 0.0; for (int i = 0; i < 4; i++){ s += a * gmVN(p); p = mat2(0.8, 0.6, -0.6, 0.8) * p * 2.03 + 17.1; a *= 0.5; } return s / 0.9375; }
// simplex noise in [-1, 1]
float gmSN(vec2 p){
  const float K1 = 0.366025404, K2 = 0.211324865;
  vec2 i = floor(p + (p.x + p.y) * K1);
  vec2 a = p - i + (i.x + i.y) * K2;
  float m = step(a.y, a.x);
  vec2 o = vec2(m, 1.0 - m);
  vec2 b = a - o + K2, c = a - 1.0 + 2.0 * K2;
  vec3 h = max(0.5 - vec3(dot(a, a), dot(b, b), dot(c, c)), 0.0);
  vec3 n = h * h * h * h * vec3(dot(a, gmH22(i) * 2.0 - 1.0), dot(b, gmH22(i + o) * 2.0 - 1.0), dot(c, gmH22(i + 1.0) * 2.0 - 1.0));
  return dot(n, vec3(70.0));
}
// One band-limited octave: world xz -> scaled by 1/L across and 1/(L*S) along the view (+Z)
// direction (leaves foreshorten ~4-10x at this grazing view), rotated by ang (so octaves never share
// a lattice). Faded to 0 as the pixel footprint in noise cycles goes 0.3 -> 0.55 (no aliasing).
float gmOct(vec2 p, vec2 dx, vec2 dy, float L, float S, float ang, out float fade){
  vec2 sc = vec2(1.0 / L, 1.0 / (L * S));
  float fp = max(length(dx * sc), length(dy * sc));
  fade = 1.0 - smoothstep(0.22, 0.45, fp); // (well below Nyquist: stable under sub-pixel camera motion)
  if (fade <= 0.0) return 0.0;
  float ca = cos(ang), sa = sin(ang);
  vec2 q = mat2(ca, sa, -sa, ca) * (p * sc);
  return gmSN(q + vec2(ang * 17.0, ang * 5.0));
}
// One layer of scattered leaves ("bombing": one jittered, randomly sized/oriented/absent oval leaf per
// cell, the 2x2 nearest cells tested so leaves overlap cell borders and no lattice shows). Cells are
// L across and L*S along the view (+Z) direction (leaves tilt up toward the camera). Returns coverage
// and the covering leaf's brightness in br; beyond the footprint limit both fall to their means.
float gmLeaves(vec2 p, vec2 dx, vec2 dy, float L, float S, float ang, float pres, float presU, out float br){
  vec2 sc = vec2(1.0 / L, 1.0 / (L * S));
  float fp = max(length(dx * sc), length(dy * sc));
  float fade = 1.0 - smoothstep(0.24, 0.5, fp);
  float mCov = pres * 0.36;
  br = 1.0;
  if (fade <= 0.0) return mCov;
  float ca = cos(ang), sa = sin(ang);
  vec2 q = mat2(ca, sa, -sa, ca) * (p * sc) + vec2(ang * 13.0, ang * 7.0);
  vec2 i0 = floor(q - 0.5);
  float cov = 0.0, b = 1.0;
  for (int k = 0; k < 4; k++) {
    vec2 ci = i0 + vec2(float(k & 1), float(k >> 1));
    vec2 h = gmH22(ci);
    float h3 = gmH12(ci + 17.3);
    if (h3 > pres) continue;
    float u = h3 / presU;
    vec2 d = q - ci - 0.5 - (h - 0.5) * 0.7;
    float th = fract(u * 13.7 + h.x) * 3.1416;
    float cth = cos(th), sth = sin(th);
    d = vec2(cth * d.x + sth * d.y, -sth * d.x + cth * d.y);
    float r = 0.26 + 0.2 * fract(u * 7.3 + h.y);
    float e = length(d * vec2(0.5, 1.0)) / r;
    float aa = fp / r * 1.5 + 0.12;
    float m = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, e);
    if (m > cov) { cov = m; b = (0.62 + 0.76 * fract(u * 31.1 + h.x * 3.0)) * (0.88 + 0.24 * clamp(-d.y / r, -1.0, 1.0)); }
  }
  br = mix(1.0, b, fade);
  return mix(mCov, cov, fade);
}
`;

function srgbVec(hex) { const c = new THREE.Color(hex); return `vec3(${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)})`; }

export default async function create(ctx) {
  const { scene, layout, uniforms, quality } = ctx;
  const tier = quality.tier;
  // lawn blades (mostly sub-2-px slivers: the mat carries the texture) thin out more on lower tiers
  // than the tussocks, which are distinct shapes in the dead-grass zones
  const countScale = tier === 'high' ? 1 : tier === 'medium' ? 0.35 : 0.25;
  const tussockScale = tier === 'high' ? 1 : tier === 'medium' ? 0.5 : 0.25;
  // lawn blades fade out LAWN_FADE[0]..[1] m from the eye (the mat carries the texture beyond);
  // lower tiers fade earlier (most distant blades are sub-pixel slivers)
  const LAWN_FADE = tier === 'high' ? [15, 22] : [12, 17];
  const rand = mulberry32(90211);
  const yieldUI = () => new Promise((r) => setTimeout(r, 0));
  const DEBUG_TUSSOCK = ctx.params.get('debug') === 'tussock';
  // mat parallax: herb mats stand POM_D m above the turf, marched in POM_N steps (off on 'low')
  const POM_N = tier === 'high' ? 6 : tier === 'medium' ? 4 : 0;
  const POM_D = 0.10;

  // ---- height / SDF grid caches over the plateau (bilinear) ------------------------------------
  const GX0 = -10, GX1 = 60, GZ0 = -66, GZ1 = 2, GS = 0.25;
  const gnx = Math.round((GX1 - GX0) / GS) + 1, gnz = Math.round((GZ1 - GZ0) / GS) + 1;
  const hgrid = new Float32Array(gnx * gnz);
  for (let j = 0; j < gnz; j++) {
    const z = GZ0 + j * GS;
    for (let i = 0; i < gnx; i++) hgrid[j * gnx + i] = layout.heightAt(GX0 + i * GS, z);
    if ((j & 31) === 0) { ctx.progress(0.05 + 0.3 * j / gnz, 'Grass'); await yieldUI(); }
  }
  const SS = 0.5;
  const snx = Math.round((GX1 - GX0) / SS) + 1, snz = Math.round((GZ1 - GZ0) / SS) + 1;
  const sd = new Float32Array(snx * snz);
  for (let j = 0; j < snz; j++) for (let i = 0; i < snx; i++) sd[j * snx + i] = layout.polygonSDF(GX0 + i * SS, GZ0 + j * SS, layout.HEADLAND_OUTLINE);
  function bil(arr, nx, nz, x0, z0, s, x, z) {
    const fx = (x - x0) / s, fz = (z - z0) / s;
    const i = Math.max(0, Math.min(nx - 2, Math.floor(fx))), j = Math.max(0, Math.min(nz - 2, Math.floor(fz)));
    const u = fx - i, v = fz - j;
    const a = arr[j * nx + i], b = arr[j * nx + i + 1], c = arr[(j + 1) * nx + i], d = arr[(j + 1) * nx + i + 1];
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }
  const H = (x, z) => bil(hgrid, gnx, gnz, GX0, GZ0, GS, x, z);
  const SDF = (x, z) => bil(sd, snx, snz, GX0, GZ0, SS, x, z);
  const sunVis = makeSunVis(layout, uniforms.uSunDir.value);
  // terrain normal from the height grid
  const nrm = (x, z, out) => {
    const e = 0.4;
    const nx = H(x - e, z) - H(x + e, z), nz = H(x, z - e) - H(x, z + e);
    const l = Math.hypot(nx, 2 * e, nz);
    out[0] = nx / l; out[1] = 2 * e / l; out[2] = nz / l;
    return out;
  };
  // grass weight exactly as the terrain classifies it (grass on top, rock rim down the cliff)
  const grassW = (x, z, ny) => {
    const nearCam = smooth(-14, -8, z) * smooth(-2, -5, x);
    const sdv = SDF(x, z);
    const g = smooth(-0.1, -1.4 - 2.0 * nearCam, sdv) * (1 - layout.bareRockAt(x, z, sdv)); // (bare rock: brow knob, left edge band)
    return g * (1 - smooth(0.30, 0.55, 1 - ny));
  };
  const cam = new THREE.Vector3().fromArray(ctx.config.camera.position);
  const N = [0, 1, 0];
  const shrubSpots = deadShrubSpots(layout);
  // contact shade under the dead shrubs (also applied to blades rooted there)
  const shrubAOAt = (x, z) => {
    let a = 1;
    for (let i = 0; i < shrubSpots.length; i++) {
      const p = shrubSpots[i], r = 0.5;
      a *= 1 - 0.3 * smooth(r, r * 0.3, Math.hypot(x - p.x + 0.15, z - p.z + 0.15));
    }
    return a;
  };

  // ---- the mat -----------------------------------------------------------------------------------
  let matTris = 0;
  {
    const MX0 = -8, MX1 = 40, MZ0 = -58, MZ1 = -3, MS = tier === 'low' ? 1.0 : 0.5;
    const mnx = Math.round((MX1 - MX0) / MS) + 1, mnz = Math.round((MZ1 - MZ0) / MS) + 1;
    const pos = new Float32Array(mnx * mnz * 3), nor = new Float32Array(mnx * mnz * 3), mat4 = new Float32Array(mnx * mnz * 4);
    const shade = new Float32Array(mnx * mnz);
    for (let j = 0; j < mnz; j++) {
      const z = MZ0 + j * MS;
      for (let i = 0; i < mnx; i++) {
        const x = MX0 + i * MS, k = j * mnx + i;
        const y = layout.heightAt(x, z);
        nrm(x, z, N);
        pos.set([x, y + 0.04, z], k * 3); nor.set(N, k * 3);
        const gw = grassW(x, z, N[1]);
        mat4.set([gw, gw > 0 ? sunVis(x, z, y + 0.3) * sunMaskAt(x, z) : 0, deadMaskAt(x, z), crownMaskAt(x, z)], k * 4);
        // the strip along the west cliff lip near the camera reads darker in the reference
        // (shaded by the dead shrubs and the cliff, less open sky)
        // (round 5: continued along the left edge to z ~ -23, where the reference slope by the edge band is
        // dark olive at t = 9)
        shade[k] = 1 - 0.18 * smooth(-7.0, -2.5, SDF(x, z)) * Math.max(smooth(-17, -12, z), smooth(-25, -20, z) * smooth(0.5, -1.5, x)) * smooth(2.0, -0.5, x);
      }
      if ((j & 15) === 0) await yieldUI();
    }
    const idx = [];
    for (let j = 0; j < mnz - 1; j++) for (let i = 0; i < mnx - 1; i++) {
      const a = j * mnx + i, b = a + 1, c = a + mnx, d = c + 1;
      if (Math.max(mat4[a * 4], mat4[b * 4], mat4[c * 4], mat4[d * 4]) <= 0.01) continue;
      // keep only what can be in frame (pan-widened wedge)
      const x = MX0 + (i + 0.5) * MS, z = MZ0 + (j + 0.5) * MS;
      const ang = Math.atan2(x - cam.x, -(z - cam.z));
      if (ang < -1.0 || ang > 0.85) continue;
      idx.push(a, c, b, b, c, d);
    }
    const mg = new THREE.BufferGeometry();
    mg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    mg.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    mg.setAttribute('aMat', new THREE.BufferAttribute(mat4, 4));
    mg.setAttribute('aShade', new THREE.BufferAttribute(shade, 1));
    mg.setIndex(idx);
    mg.computeBoundingSphere();
    matTris = idx.length / 3;
    const C = GRASS_COLOR;
    const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0, alphaToCoverage: true });
    const shrubAO = shrubSpots.map((p) => new THREE.Vector4(p.x - 0.15, p.z - 0.15, 0.5, 0.3));
    m.onBeforeCompile = (sh) => {
      sh.uniforms.uShrubAO = { value: shrubAO };
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec4 aMat;\nattribute float aShade;\nvarying vec4 vMat;\nvarying vec3 vMWP;\nvarying vec3 vMN;\nvarying float vShadeM;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvMat = aMat; vShadeM = aShade; vMN = normal; vMWP = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
          varying vec4 vMat; varying vec3 vMWP; varying vec3 vMN; varying float vShadeM;
          ${MAT_NOISE_GLSL}
          float gmGloss; vec2 gmTilt; float gmOcc;
          uniform vec4 uShrubAO[6];
          // footprint-filtered value fbm: each octave fades to its mean as it nears the pixel size
          float gmFbmF(vec2 p, float fpx){
            float a = 0.5, s = 0.0, f = 1.0;
            for (int i = 0; i < 4; i++) {
              s += a * mix(0.5, gmVN(p), 1.0 - smoothstep(0.22, 0.45, fpx * f));
              p = mat2(0.8, 0.6, -0.6, 0.8) * p * 2.03 + 17.1; f *= 2.03; a *= 0.5;
            }
            return s / 0.9375;
          }
          // radial streaks: grass blades stand up, so they project to near-vertical strokes. pr =
          // (view azimuth x 9 m, distance) around the fixed eye: lines of constant azimuth are vertical
          // on screen. w / l: stroke width / length (m). Fades out by its own pixel footprint.
          float gmStreak(vec2 pr, vec2 dpx, vec2 dpy, float w, float l, float seed, out float fade){
            vec2 sc = vec2(1.0 / w, 1.0 / l);
            float fp = max(length(dpx * sc), length(dpy * sc));
            fade = 1.0 - smoothstep(0.22, 0.45, fp);
            if (fade <= 0.0) return 0.0;
            return gmSN(pr * sc + seed);
          }
          // gmStreak in distance-banded polar coordinates: band k runs (azimuth x 2^k, distance), which is
          // world-metric laterally at 2^k m; two bands blended by fract(log2 distance) (matching seeds
          // at the band seams), so strokes keep their world width and recede to sub-pixel with distance
          vec2 gmEyeRel(vec2 q){ return q - vec2(${CONFIG.camera.position[0].toFixed(2)}, ${CONFIG.camera.position[2].toFixed(2)}); }
          float gmStreakB(vec2 q, float w, float l, float seed){
            vec2 rel = gmEyeRel(q);
            float rho = length(rel), az = atan(rel.x, -rel.y);
            vec2 dA = vec2(dFdx(az), dFdy(az)), dR = vec2(dFdx(rho), dFdy(rho));
            float lg = log2(max(rho, 1.0)), k = floor(lg), fr = lg - k;
            float s1 = exp2(k), s2 = s1 * 2.0, f1, f2;
            float a = gmStreak(vec2(az * s1, rho), vec2(dA.x * s1, dR.x), vec2(dA.y * s1, dR.y), w, l, seed + k * 7.31, f1) * f1;
            float b = gmStreak(vec2(az * s2, rho), vec2(dA.x * s2, dR.x), vec2(dA.y * s2, dR.y), w, l, seed + (k + 1.0) * 7.31, f2) * f2;
            return mix(a, b, fr);
          }
          // gmOct / gmLeaves in the same distance-banded polar frame: the along-view stretch S follows
          // the actual view azimuth everywhere (no world-Z combing at the frame sides). Noise bands are
          // blended variance-preserving; leaf bands split the leaf population by the blend weight (no
          // double-exposed leaves). gpDA / gpDR: screen derivatives of (azimuth, distance) at the entry.
          vec2 gpDA, gpDR;
          float gmOctB(vec2 p, float L, float S, float ang){
            vec2 rel = gmEyeRel(p);
            float rho = length(rel), az = atan(rel.x, -rel.y);
            float lg = log2(max(rho, 1.0)), k = floor(lg), fr = lg - k;
            float s1 = exp2(k), s2 = s1 * 2.0, f1, f2;
            float a = gmOct(vec2(az * s1, rho) + k * vec2(3.7, 1.3), vec2(gpDA.x * s1, gpDR.x), vec2(gpDA.y * s1, gpDR.y), L, S, ang, f1);
            float b = gmOct(vec2(az * s2, rho) + (k + 1.0) * vec2(3.7, 1.3), vec2(gpDA.x * s2, gpDR.x), vec2(gpDA.y * s2, gpDR.y), L, S, ang, f2);
            return (a * f1 * (1.0 - fr) + b * f2 * fr) / sqrt((1.0 - fr) * (1.0 - fr) + fr * fr);
          }
          float gmLeavesB(vec2 p, float L, float S, float ang, float pres, out float br){
            vec2 rel = gmEyeRel(p);
            float rho = length(rel), az = atan(rel.x, -rel.y);
            float lg = log2(max(rho, 1.0)), k = floor(lg), fr = lg - k;
            float s1 = exp2(k), s2 = s1 * 2.0, b1, b2;
            float c1 = gmLeaves(vec2(az * s1, rho) + k * vec2(3.7, 1.3), vec2(gpDA.x * s1, gpDR.x), vec2(gpDA.y * s1, gpDR.y), L, S, ang, pres * (1.0 - fr), pres, b1);
            float c2 = gmLeaves(vec2(az * s2, rho) + (k + 1.0) * vec2(3.7, 1.3), vec2(gpDA.x * s2, gpDR.x), vec2(gpDA.y * s2, gpDR.y), L, S, ang, pres * fr, pres, b2);
            br = c2 > c1 ? b2 : b1;
            return 1.0 - (1.0 - c1) * (1.0 - c2);
          }
          // sparse small round things on the ground (flowers, pebbles): one per cell with probability
          // pr, radius r (m) scaled by 0.6..1.4; returns coverage (faded out once sub-pixel) and a hash
          float gmDots(vec2 q, float fpW, float cell, float pr, float r, float seed, out float hsh){
            vec2 c = q / cell + seed;
            vec2 ci = floor(c);
            vec2 h = gmH22(ci);
            hsh = gmH12(ci + 3.7);
            if (hsh > pr) return 0.0;
            float rr = r * (0.6 + 0.8 * h.y) / cell;
            float e = length(c - ci - 0.25 - 0.5 * h) / rr;
            float aa = fpW / cell / rr + 0.15;
            return (1.0 - smoothstep(1.0 - aa, 1.0 + aa, e)) * (1.0 - smoothstep(0.6, 1.2, fpW / (r * (0.6 + 0.8 * h.y))));
          }
          // herb-mat elevation field in [0, 1] (0 = turf level, 1 = top of a mat): domain-warped,
          // footprint-filtered value fbm, 0.3-1.5 m mats with steep-ish rims
          const float HT = 0.52;
          float gmHerbV(vec2 q, float fa, float hfp, float hoff){
            vec2 wv = vec2(gmSN(mat2(0.921, 0.389, -0.389, 0.921) * (q * 1.25) + vec2(6.8, 2.0)),
                           gmSN(mat2(-0.323, 0.946, -0.946, -0.323) * (q * 1.25) + vec2(32.3, 9.5))) * fa;
            // + a 12 cm lump octave (piled leaves: ragged rims), faded by the footprint / march step
            float lf = 1.0 - smoothstep(0.25, 0.5, hfp / 1.3 / 0.12);
            return gmFbmF((q + wv * 0.3) * 1.6 + 5.0, hfp * 1.6 / 1.3) + hoff + 0.07 * lf * gmSN(q * 8.3 + 3.1);
          }
          vec3 grassMat(vec3 wp){
            vec2 q0 = wp.xz;
            vec2 dx = dFdx(wp.xz), dy = dFdy(wp.xz);
            float fpW = max(length(dx), length(dy));
            // polar frame around the fixed eye (the handheld camera only rotates: no swimming)
            vec2 rel = q0 - vec2(${CONFIG.camera.position[0].toFixed(2)}, ${CONFIG.camera.position[2].toFixed(2)});
            float rho = length(rel);
            vec2 rdir = rel / max(rho, 1e-3);
            { float az0 = atan(rel.x, -rel.y); gpDA = vec2(dFdx(az0), dFdy(az0)); gpDR = vec2(dFdx(rho), dFdy(rho)); }
            float dead = vMat.z, crown = vMat.w;
            float herbOK = (1.0 - dead) * (1.0 - 0.4 * crown);
            float n15 = gmFbm(q0 * 0.7 + 11.0);
            float fa = 1.0 - smoothstep(0.3, 0.55, fpW / 0.8); // warp fades with the footprint
            float hfp = fpW * 1.3;
            float hoff0 = 0.14 * (n15 - 0.5);

            // ---- parallax: the herb mats stand up to PD above the turf. The eye is fixed (the handheld
            // camera only rotates), so a short ray march through the elevation field below the mesh
            // (which sits at the mats' top) gives real occlusion: mats hide the turf behind them, show
            // their camera-facing rims, and overlap into rows with the distance.
            vec2 q = q0;
            float eH = 0.0, slope = 0.0;
            ${POM_N > 0 ? `
            float PD = ${POM_D.toFixed(3)} * smoothstep(52.0, 34.0, rho) * herbOK;
            if (PD > 0.003) {
              vec3 Vw = normalize(wp - cameraPosition);
              float cosV = max(-dot(Vw, normalize(vMN)), 0.035);
              vec2 stq = Vw.xz / cosV * (PD / ${POM_N.toFixed(1)});
              // the marched field is filtered by the step length (no slicing), the shading uses full detail
              float hfpM = max(hfp, length(stq) * 1.3 * 0.7);
              float ePrev = smoothstep(HT - 0.06, HT + 0.26, gmHerbV(q0, fa, hfpM, hoff0));
              float fPrev = -PD * (1.0 - ePrev);
              q = q0 + stq * ${POM_N.toFixed(1)};
              if (fPrev >= -1e-4) { q = q0; eH = ePrev; }
              else {
                for (int i = 1; i <= ${POM_N}; i++) {
                  vec2 qi = q0 + stq * float(i);
                  float ei = smoothstep(HT - 0.06, HT + 0.26, gmHerbV(qi, fa, hfpM, hoff0));
                  float fi = PD * float(i) / ${POM_N.toFixed(1)} - PD * (1.0 - ei);
                  if (fi >= 0.0) {
                    float t = fPrev / (fPrev - fi);
                    q = q0 + stq * (float(i - 1) + t);
                    eH = mix(ePrev, ei, t);
                    slope = (ei - ePrev) * PD / max(length(stq), 1e-4);
                    break;
                  }
                  ePrev = ei; fPrev = fi;
                }
              }
            }` : ''}
            // at the parallax silhouettes (the hit point jumps between neighbouring pixels) the detail
            // layers use the jump as their footprint: they fade toward their mean there instead of
            // aliasing (no crawling rim pixels under the handheld sub-pixel motion)
            {
              float disc = length(fwidth(q)) / max(length(fwidth(q0)), 1e-5);
              float kd = clamp(disc * 0.6, 1.0, 6.0);
              gpDA *= kd; gpDR *= kd; dx *= kd; dy *= kd; fpW *= kd;
            }
            // leaf/speckle texture coordinates unwrapped over the rims (the hit point barely moves up a
            // steep face: continue the texture by the face height, no vertical smearing)
            vec2 qt = q + rdir * eH * ${POM_D.toFixed(3)} * 1.6;
            float n6 = gmFbm(q * 0.17 + 3.0), n03 = 0.5 + 0.5 * gmSN(q * 3.3 + 1.7);
            vec3 col = mix(${srgbVec(C.greenDark)}, ${srgbVec(C.green)}, 0.3 + 0.7 * smoothstep(0.22, 0.72, n15));
            col = mix(col, ${srgbVec(C.greenLight)}, smoothstep(0.55, 0.8, n6) * 0.45);
            col = mix(col, ${srgbVec(C.dry)}, smoothstep(0.6, 0.85, n6 * 0.6 + n03 * 0.4) * 0.25);
            // soft 13 cm tuft modulation
            float fc;
            float md = gmOctB(q, 0.13, 2.2, 1.1); fc = 1.0;
            float cB = mix(0.84, 1.08, smoothstep(-0.5, 0.5, md * fc)) / 0.96;

            // ---- macro structure at the hit: raised mats of small-leaved herbs (crisp lumpy edges)
            // between flat, finer, yellower turf
            float fe, fe2;
            float lump = gmOctB(q, 0.07, 1.8, 2.6) + 0.5 * gmOctB(q, 0.03, 2.0, 0.9);
            float hv = gmHerbV(q, fa, hfp, hoff0) + 0.08 * lump;
            float aaH = fwidth(hv) * 0.7 + 0.022;
            float herb = smoothstep(HT - aaH, HT + aaH, hv) * herbOK;
            // small herb rosettes scattered through the turf (8-25 cm), so turf and herbs intermix
            float rosN = gmFbmF(q * 5.2 + 17.0, fpW * 5.2) + 0.25 * lump;
            float aaR = fwidth(rosN) * 0.7 + 0.02;
            herb = max(herb, smoothstep(0.66 - aaR, 0.66 + aaR, rosN) * herbOK * 0.95);
            // camera-facing rims of the mats (rising along the ray): dark leaf undersides
            float front = smoothstep(0.2, 0.9, slope) * herbOK * smoothstep(-0.35, 0.25, lump);
            float prox = smoothstep(0.38, HT, hv) * (1.0 - herb) * herbOK;
            // mat dome: the top catches the open sky, the rims and the foot are shaded
            float dome = mix(0.92, 1.05, smoothstep(0.1, 0.9, eH));

            // ---- herb mats: 3-4 layers of scattered oval leaves (2.6 / 4.5 / 7.5 cm, 12 cm on ~30 % of
            // the mats) over deep dark gaps
            float f3, f4;
            float o4 = gmOctB(qt, 0.20, 5.0, 2.62); f4 = 1.0;
            float o3 = gmOctB(qt, 0.095, 4.5, 1.97); f3 = 1.0;
            float F = 0.5 + 0.3 * f3 * (smoothstep(-0.42, 0.42, o3) - 0.5) + 0.2 * f4 * (smoothstep(-0.5, 0.5, o4) - 0.5);
            vec2 wq = qt + vec2(o3 * f3, o4 * f4) * 0.01;
            float Bh = 1.0, Fl = 0.5, bA = 1.0, bB = 1.0;
            if (herb + front > 0.003) {
              float bC, bD;
              float pres = 0.74 + 0.24 * F;
              float big = smoothstep(0.56, 0.66, gmVN(q * 0.9 + 33.0));
              float mC = gmLeavesB(wq, 0.09, 2.6, 1.97, pres, bC);
              float mD = big > 0.01 ? gmLeavesB(wq, 0.13, 2.8, 2.9, pres * big, bD) : 0.0;
              float mB = gmLeavesB(wq, 0.054, 2.4, 1.24, pres, bB);
              ${tier === 'low' ? 'float mA = pres * 0.9 * 0.36; // low tier: finest leaf layer at its mean' : 'float mA = gmLeavesB(wq, 0.032, 2.2, 0.65, pres * 0.9, bA);'}
              // deep gaps near the eye (the dark soil between the leaves), shallower further off
              float V = mix(0.025, 0.06, smoothstep(8.0, 16.0, rho));
              float Vg = V;
              V = mix(V, 0.62 * bC, mC); V = mix(V, 0.86 * bD, mD); V = mix(V, 0.98 * bB, mB); V = mix(V, 1.40 * bA, mA);
              float mc0 = pres * 0.36;
              float V0 = mix(mix(mix(mix(Vg, 0.62, mc0), 0.86, mc0 * big), 0.98, mc0), 1.40, mc0 * 0.9);
              Bh = V / V0 * mix(0.72, 1.22, F);
              Fl = clamp((V - 0.06) / 1.2, 0.0, 1.0);
            }
            // ---- turf: fine blade-tip speckle and radial blade strokes
            float fs1, fs2;
            float sp1 = gmOctB(qt, 0.03, 2.0, 0.8);
            float sp2 = gmOctB(qt, 0.06, 2.4, 2.1);
            ${tier === 'low' ? 'float sk1 = 0.0, sk2 = 0.0; // low tier: no blade strokes' : `float sk1 = gmStreakB(q, 0.016, 0.09, 3.1);
            float sk2 = gmStreakB(q, 0.028, 0.16, 7.7);`}
            float Bt = 1.0 + 0.24 * sp1 + 0.15 * sp2 + 0.12 * sk1 + 0.08 * sk2; // (smoother turf than the herb mats)
            Bt *= mix(1.0, 0.66, smoothstep(0.3, 0.8, -sp1)) * mix(1.0, 0.8, smoothstep(0.2, 0.7, -sk2)); // dark gaps between tufts

            // colour: herb leaves cooler and fresher (grey-blue sky sheen on the upper leaves); turf
            // olive with reddish-brown dead patches
            vec3 weedC = ${srgbVec(C.weed)};
            // (round 5: dark green herb mats on lighter, smoother, more golden turf, as in the reference;
            // the mats read lighter than the turf and the bright fraction too green)
            vec3 herbC = col * vec3(0.60, 0.74, 0.57);
            // upper leaves: a fresher, slightly lighter green (no grey-blue frost), so the mats blend
            // into the turf as a greener mottle
            herbC = mix(herbC, weedC * vec3(0.96, 1.0, 0.86), smoothstep(0.5, 0.95, Fl) * 0.3);
            herbC *= mix(vec3(1.0), vec3(1.0, 1.06, 0.92) * 1.08, smoothstep(0.62, 0.95, Fl));
            vec3 turfC = col * vec3(1.37, 1.33, 1.03);
            // hue drift independent of brightness (fresher / drier / browner patches, 0.3-1.5 m)
            float hueN = gmFbmF(q * 2.3 + 91.0, fpW * 2.3);
            vec3 hueK = mix(vec3(1.04, 1.0, 0.92), vec3(0.93, 1.0, 1.12), smoothstep(0.3, 0.7, hueN));
            turfC *= hueK; herbC *= mix(vec3(1.0), hueK, 0.35);
            turfC = mix(turfC, vec3(dot(turfC, vec3(0.3, 0.55, 0.15))), 0.04);
            float redP = smoothstep(0.56, 0.78, gmFbmF(q * 1.7 + 41.0, fpW * 1.7)) * (1.0 - herb);
            turfC = mix(turfC, ${srgbVec(C.dead)} * 0.95, redP * 0.25);
            vec3 c = mix(turfC * Bt * (1.0 - 0.1 * prox), herbC * mix(1.0, Bh, 0.8) * 0.94 * dome, herb);
            // the mat's camera-facing rim: dark leaf undersides, broken up by the leaves hanging over it
            c = mix(c, herbC * mix(0.5, 0.85, Fl), front * 0.4);
            // 2-5 m patchiness: darker, cooler olive hollows and lighter golden-green swells
            float cpN = gmFbm(q * 0.33 + 5.0) + 0.35 * (gmFbm(q * 0.9 + 21.0) - 0.5);
            c *= mix(vec3(0.86, 0.88, 0.93), vec3(1.12, 1.09, 1.0), smoothstep(0.28, 0.72, cpN));

            // ---- bare soil and small stones: along the west cliff lip, under the dead shrubs, and a
            // few worn spots
            float ao = 1.0;
            for (int i = 0; i < 6; i++) {
              float dd = length(q - uShrubAO[i].xy);
              ao *= 1.0 - uShrubAO[i].w * smoothstep(uShrubAO[i].z, uShrubAO[i].z * 0.3, dd);
            }
            float lip = (1.0 - vShadeM) / 0.18;
            float bn = gmFbmF(q * 1.1 + 77.0, fpW * 1.1) + 0.03 * lump;
            float bare = smoothstep(0.02, 0.06, bn - 0.84 + 0.3 * lip + 0.3 * (1.0 - ao)) * (1.0 - dead) * (1.0 - herb * 0.7);
            float sh1 = 0.0, sh2 = 0.0;
            float st1 = 0.0, st2 = 0.0;
            if (bare > 0.001) { st1 = gmDots(q, fpW, 0.06, 0.45, 0.012, 11.0, sh1); st2 = gmDots(q, fpW, 0.11, 0.3, 0.02, 23.0, sh2); }
            vec3 soil = vec3(0.22, 0.2, 0.17) * (0.8 + 0.4 * n03) * (1.0 + 0.2 * sp2);
            soil = mix(soil, vec3(0.44, 0.43, 0.40) * (0.8 + 0.4 * sh1 / 0.45), st1);
            soil = mix(soil, vec3(0.40, 0.39, 0.36) * (0.8 + 0.5 * sh2 / 0.3), st2);
            c = mix(c, soil, bare * 0.85);

            // ---- a few tiny flowers and seed heads on the lawn (yellow flat-weed, white clover heads)
            float fh1 = 0.0, fh2 = 0.0;
            float fl1 = 0.0, fl2 = 0.0;
            if (rho < 18.0) {
              fl1 = gmDots(q + vec2(lump) * 0.02, fpW, 0.35, 0.05, 0.009, 51.0, fh1) * (1.0 - dead) * (1.0 - bare);
              fl2 = gmDots(q, fpW, 0.28, 0.035 * herb, 0.007, 63.0, fh2);
            }
            c = mix(c, vec3(0.78, 0.62, 0.16), fl1);
            c = mix(c, vec3(0.72, 0.72, 0.66), fl2);

            // ---- reddish-brown dead grass: streaky, with dark shaded gaps
            float fs;
            float st = 0.5 + 0.5 * gmOctB(q, 0.09, 2.5, 0.2);
            float dks = gmStreakB(q, 0.012, 0.1, 5.3);
            vec3 deadC = ${srgbVec(C.dead)} * (0.65 + 0.6 * st) * (1.0 + 0.18 * dks) * mix(1.0, 0.8, smoothstep(0.5, 0.2, n15));
            // the tussock mass right of the casuarina feet (11-20 m): the ground between the tussocks is
            // their dark reddish-brown litter, not bright lawn
            float nearT = smoothstep(2.6, 4.4, q.x + 0.12 * (q.y + 12.0)) * smoothstep(-7.9, -8.9, q.y) * smoothstep(-14.6, -12.4, q.y);
            deadC = mix(deadC, ${srgbVec('#4e3c38')} * (0.75 + 0.5 * st), nearT * 0.85);
            // the dead band along the brow behind the trees (30-55 m) reads reddish-brown (R-G ~ +8)
            float farW = smoothstep(7.5, 3.5, abs(q.y + 30.5 + 0.45 * (q.x - 4.0))) * smoothstep(2.0, 5.0, q.x) * smoothstep(36.0, 28.0, q.x);
            deadC = mix(deadC, ${srgbVec('#9a7466')} * (0.85 + 0.35 * st), farW * 0.6);
            c = mix(c, deadC, dead);
            // ---- under the she-oaks: grey, desaturated, with grey-brown needle litter in drifts (not
            // over the reddish brow band)
            float crownE = crown * (1.0 - 0.75 * farW * dead);
            float g = dot(c, vec3(0.3, 0.55, 0.15));
            float litter = crownE * smoothstep(0.35, 0.65, n03 * 0.6 + st * 0.4);
            c = mix(c, vec3(g) * vec3(1.0, 1.02, 0.96), crownE * 0.45) * (1.0 - 0.3 * crownE);
            c = mix(c, ${srgbVec('#6d625a')} * (0.8 + 0.4 * st), litter * 0.55);
            // the shaded west lip strip near the eye reads greener / cooler than the golden turf behind
            // (reference x 260-640, rows 690-718: G/R ~1.25, B ~ R - 12)
            c *= mix(vec3(1.0), vec3(0.88, 1.0, 1.1), clamp(lip, 0.0, 1.0));
            float f = 1.0 * cB * ao * vShadeM;
            gmGloss = 0.15 * herb * smoothstep(0.55, 0.95, Fl) * (1.0 - front);
            gmTilt = vec2(o3 * f3, o4 * f4) * 0.3 + (vec2(bA, bB) - 1.0) * 0.6 * herb - rdir * front * 0.8;
            gmOcc = mix(mix(0.9, 0.8, prox), mix(0.68, 1.0, Fl) * mix(0.92, 1.02, eH), herb) * mix(1.0, 0.8, front) * ao;
            return c * f;
          }`)
        .replace('#include <color_fragment>', `#include <color_fragment>
          diffuseColor.rgb = grassMat(vMWP);
          // (ragged, tufty mat edge where the grass meets rock / bare soil: 0.15-0.9 m noise, each octave
          // faded by its footprint)
          float aFp = max(length(dFdx(vMWP.xz)), length(dFdy(vMWP.xz)));
          float aN = (gmVN(vMWP.xz * 3.1 + 7.0) * 0.65 + gmVN(vMWP.xz * 7.3 + 2.0) * 0.35 - 0.5) * (1.0 - smoothstep(0.05, 0.12, aFp))
                   + (gmVN(vMWP.xz * 1.15 + 3.0) - 0.5) * 0.8 * (1.0 - smoothstep(0.2, 0.45, aFp));
          diffuseColor.a = smoothstep(0.35, 0.8, vMat.x + 0.7 * aN * (1.0 - smoothstep(0.8, 1.0, vMat.x))) * smoothstep(-57.5, -51.0, vMWP.z) * smoothstep(39.5, 33.0, vMWP.x);
          if (diffuseColor.a < 0.04) discard;`)
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(0.86, 0.66, gmGloss);')
        .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
          { vec3 gWN = inverseTransformDirection(normal, viewMatrix);
            gWN = normalize(gWN + vec3(gmTilt.x, 0.0, gmTilt.y) * 0.5);
            normal = normalize((viewMatrix * vec4(gWN, 0.0)).xyz); }`);
      patchVegLighting(sh, uniforms, { sun: 'vMat.y', occ: 'gmOcc', trans: '0.35' });
    };
    m.customProgramCacheKey = () => 'grass-mat';
    patchMaterialAtmosphere(m, uniforms);
    const mesh = new THREE.Mesh(mg, m);
    // This ground surface is immutable. The separate blades, weeds and tussocks keep their
    // complete live wind animation; only this expensive procedural surface can reuse its lighting.
    mesh.userData.staticLighting = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.renderOrder = -2; // drawn before the terrain it covers (saves the terrain shading underneath)
    scene.add(mesh);
  }
  ctx.progress(0.45, 'Grass');
  await yieldUI();

  // ---- scatter: blades, tussocks, weeds ----------------------------------------------------------
  // Visible wedge (base framing +-35 deg, pan up to 10 deg left): ang in [-0.87, 0.70] rad.
  const K = 14000 * countScale; // blades per m^2 at 1 m eye distance (1/d^2 falloff)
  const RHO_MAX = 250 * countScale;
  const blades = []; // 20 floats per blade (see attributes below)
  const weeds = [];
  const tuss = []; // tussock core domes: 12 floats each (root xyz, yaw, R, H, seed, lean, rgb, sun)
  const col = new THREE.Color();
  const CELL = 0.5;
  let row = 0;
  // ext: [tip (0..1: straw / sunlit tip amount), seed stalk (1 = thin stalk + seed head), hash]
  const pushBlade = (px, y, pz, yaw, hgt, wid, lean, leanA, c, sun, kind, tip = 0, seed = 0) => {
    nrm(px, pz, N);
    blades.push(px, y + 0.025, pz, yaw, hgt, wid, lean, rand() * 6.283, c.r, c.g, c.b, leanA, N[0], N[1], N[2], sun, kind, tip, seed, rand());
  };
  for (let z = -4; z > -58; z -= CELL) {
    for (let x = -8; x < 40; x += CELL) {
      const dx = x - cam.x, dz = z - cam.z;
      const dh = Math.hypot(dx, dz);
      const ang = Math.atan2(dx, -dz);
      if (ang < -0.9 || ang > 0.72) continue;
      if (SDF(x + CELL / 2, z - CELL / 2) > 0.5) continue;
      const cy = H(x + CELL / 2, z - CELL / 2);
      const d = Math.hypot(dh, cam.y - cy);
      const dead0 = deadMaskAt(x + CELL / 2, z - CELL / 2);
      // tussocks in the dead-grass zones (out to the brow band ~55 m)
      if (dead0 > 0.05 && d < 22) {
        // near zone (11-20 m): big, dense, soft reddish-brown tussock mounds (0.3-0.55 m tall,
        // 0.35-0.6 m across) of fine arching blades, darker in the core
        const tExp = dead0 * 1.8 * CELL * CELL;
        let nt = Math.floor(tExp); if (rand() < tExp - nt) nt++;
        for (let k = 0; k < nt; k++) {
          const tx = x + rand() * CELL, tz = z - rand() * CELL;
          nrm(tx, tz, N);
          if (grassW(tx, tz, N[1]) < 0.5) continue;
          const ty = H(tx, tz);
          const sun = sunVis(tx, tz, ty + 0.4) * sunMaskAt(tx, tz);
          const R = 0.17 + rand() * 0.13;
          const th = (0.28 + rand() * 0.26) * (0.7 + 0.3 * deadMaskAt(tx, tz));
          // a soft, fuzzy core dome (the dense dead mass) under ~200 fine arching blades
          const nb = Math.round((170 + rand() * 60) * (tier === 'high' ? 1 : tier === 'medium' ? 0.55 : 0.3));
          const base = 0.75 + rand() * 0.3;
          const tipT = 0.05 + rand() * 0.15;
          const crownK = 1 - 0.3 * crownMaskAt(tx, tz);
          col.set('#a88878').convertSRGBToLinear();
          col.multiplyScalar(base * crownK * (0.85 + 0.3 * rand()));
          tuss.push(tx, ty - 0.03, tz, rand() * 6.283, R * (1.2 + 0.25 * rand()), th * (0.42 + 0.12 * rand()), rand() * 100, 0.15 + 0.1 * rand(), col.r, col.g, col.b, sun);
          // a second, smaller offset lobe: irregular, non-ellipsoid mounds
          const oa = rand() * 6.283, od = R * (0.45 + 0.3 * rand());
          tuss.push(tx + Math.cos(oa) * od, ty - 0.03, tz + Math.sin(oa) * od, rand() * 6.283, R * (0.55 + 0.2 * rand()), th * (0.38 + 0.15 * rand()), rand() * 100, 0.2, col.r * 1.05, col.g * 1.03, col.b, sun);
          for (let b = 0; b < nb; b++) {
            const a = rand() * 6.283, rr = Math.pow(rand(), 0.8) * R;
            grassAlbedo(tx, tz, col).lerp(lin('#7a5f56'), 0.93);
            col.multiplyScalar(base * (0.45 + rand() * 0.45) * crownK);
            if (rand() < 0.08) col.lerp(lin(GRASS_COLOR.greenDark), 0.4); // a few live blades
            if (DEBUG_TUSSOCK) col.setRGB(1, 0, 0);
            const la = Math.atan2(Math.sin(a) * 0.7 + 0.15, Math.cos(a) * 0.7 + 0.35);
            const rn = rr / (R * 1.05);
            const dome = Math.sqrt(Math.max(0, 1 - rn * rn));
            // inner blades darker (self-shaded core), outer ones arch over and catch the sky
            col.multiplyScalar(0.55 + 0.5 * rn);
            if (rn < 0.5) col.lerp(lin('#4a3834'), 0.5 * (1 - rn * 2));
            pushBlade(tx + Math.cos(a) * rr, ty, tz + Math.sin(a) * rr, rand() * 6.283, th * (0.45 + 0.55 * dome) * (0.8 + rand() * 0.4),
              0.007 + rand() * 0.01, 0.7 + rand() * 0.6 + 1.4 * rn, la, col, sun, 1, tipT * rand() * (0.4 + 0.6 * rn));
          }
        }
      } else if (dead0 > 0.05) {
        const tExp = dead0 * 4.0 * CELL * CELL * tussockScale;
        let nt = Math.floor(tExp); if (rand() < tExp - nt) nt++;
        for (let k = 0; k < nt; k++) {
          const tx = x + rand() * CELL, tz = z - rand() * CELL;
          nrm(tx, tz, N);
          if (grassW(tx, tz, N[1]) < 0.5) continue;
          const ty = H(tx, tz);
          const dist = Math.hypot(tx - cam.x, ty - cam.y, tz - cam.z);
          const sun = sunVis(tx, tz, ty + 0.4) * sunMaskAt(tx, tz);
          const th = (0.2 + rand() * 0.22) * (0.6 + 0.4 * deadMaskAt(tx, tz));
          // a dense fountain of fine (4-9 mm) blades: sub-pixel beyond ~10 m, so they build a soft
          // coverage-blended mound with a dark core, arching tips and pale straw ends
          const nb = Math.round(((dist < 25 ? 44 : 16) + rand() * 10) * (tier === 'high' ? 1 : 0.6));
          const base = rand() * 0.25 + 0.8;
          const R = 0.1 + rand() * 0.07;
          const tipT = 0.1 + rand() * 0.25; // how bleached this clump's tips are
          if (dist < 26) { // (further off the mounds are a few pixels: the mat and blades carry them)
            col.set('#a88878').convertSRGBToLinear();
            col.multiplyScalar(base * (1 - 0.3 * crownMaskAt(tx, tz)) * (0.85 + 0.3 * rand()));
            tuss.push(tx, ty - 0.02, tz, rand() * 6.283, R * 1.05, th * 0.5, rand() * 100, 0.2, col.r, col.g, col.b, sun);
          }
          for (let b = 0; b < nb; b++) {
            const a = rand() * 6.283, rr = Math.pow(rand(), 0.7) * R;
            grassAlbedo(tx, tz, col).lerp(lin(GRASS_COLOR.dead), 0.9);
            col.multiplyScalar(base * (0.62 + rand() * 0.45) * (1 - 0.3 * crownMaskAt(tx, tz)));
            if (rand() < 0.12) col.lerp(lin(GRASS_COLOR.green), 0.35); // a few live green blades
            if (DEBUG_TUSSOCK) col.setRGB(1, 0, 0);
            // lean outward, biased downwind (+X, slightly toward the camera)
            const la = Math.atan2(Math.sin(a) * 0.6 + 0.2, Math.cos(a) * 0.6 + 0.6);
            // rounded clump outline: the outer blades are shorter and arch over more
            const rn = rr / (R * 1.08);
            const dome = Math.sqrt(Math.max(0, 1 - rn * rn));
            const seedS = rand() < 0.01 ? 1 : 0;
            pushBlade(tx + Math.cos(a) * rr, ty, tz + Math.sin(a) * rr, rand() * 6.283, th * (seedS ? 1.5 : (0.35 + 0.65 * dome) * (0.75 + rand() * 0.45)),
              seedS ? 0.003 : 0.004 + rand() * 0.005, seedS ? 0.2 : 0.8 + rand() * 0.8 + 0.6 * rn, la, col, sun, 1, tipT * (0.5 + rand() * 0.5), seedS);
          }
        }
      }
      if (dh < 5.0 || d > LAWN_FADE[1] + 2) continue;
      const rho = Math.min(RHO_MAX, K / (d * d)) * (d > 20 ? 0.5 : 1); // sub-pixel beyond 20 m: the mat carries it
      const expected = rho * CELL * CELL;
      let n = Math.floor(expected);
      if (rand() < expected - n) n++;
      for (let k = 0; k < n; k++) {
        const px = x + rand() * CELL, pz = z - rand() * CELL;
        nrm(px, pz, N);
        const gw = grassW(px, pz, N[1]);
        if (gw < 0.5) continue;
        const edge = smooth(0.5, 0.9, gw); // shorter, no straw at the edges / silhouette
        const y = H(px, pz);
        const dist = Math.hypot(px - cam.x, y - cam.y, pz - cam.z);
        const dead = deadMaskAt(px, pz);
        const sun = sunVis(px, pz, y + 0.4) * sunMaskAt(px, pz);
        // weeds: clustered rosettes around fbm peaks, near field only
        const weedP = 0.55 * smooth(0.56, 0.68, fbm2(px * 2.2 + 11.0, pz * 2.2, 3)) * smooth(15, 9, dist) * (1 - dead);
        if (rand() < weedP) {
          weeds.push(px, y, pz, rand() * 6.283, 0.022 + rand() * 0.02, 0.7 + rand() * 0.6, rand() * 6.283, sun);
          continue;
        }
        grassAlbedo(px, pz, col);
        // brightness spread: wide in the near field (distinct blades), narrow further off where the
        // blades are 1-px slivers over the textured mat (no glittering dashes)
        col.multiplyScalar((1.05 + (rand() - 0.5) * 0.75 * smooth(16, 8, dist)) * shrubAOAt(px, pz));
        if (rand() < (0.05 + 0.2 * dead) * edge) col.lerp(lin(GRASS_COLOR.dry), 0.65);
        const tuft = rand() < 0.5;
        const hgt = (tuft ? 0.03 + rand() * 0.035 : 0.05 + rand() * 0.07) * (0.6 + 0.4 * edge) * (1 + dead * 1.5);
        const wid = tuft ? 0.012 + rand() * 0.016 : 0.004 + rand() * 0.004;
        const leanA = Math.atan2(-0.36, 0.93) + (rand() - 0.5) * 5.5;
        // ~2.5 % seed stalks (thin, 12-30 cm, a 2-3 cm seed head), the rest leaves with drier tips
        if (dist < 13 && rand() < 0.012 * edge) {
          col.lerp(lin(GRASS_COLOR.dry), 0.35);
          pushBlade(px, y, pz, rand() * 6.283, 0.12 + rand() * 0.18, 0.0025, 0.1 + rand() * 0.25, leanA, col, sun, 0, 0.6, 1);
          continue;
        }
        pushBlade(px, y, pz, rand() * 6.283, hgt, wid, 0.15 + rand() * 0.55, leanA, col, sun, 0, (rand() < 0.25 ? 0.3 + rand() * 0.5 : rand() * 0.2) * smooth(18, 10, dist));
      }
    }
    if ((++row & 15) === 0) { ctx.progress(0.45 + 0.4 * (-4 - z) / 54, 'Grass'); await yieldUI(); }
  }
  ctx.progress(0.85, 'Grass');

  // ---- blade geometry --------------------------------------------------------------------------
  const SEG = tier === 'high' ? 3 : 2;
  const bpos = [], bidx = [];
  for (let s = 0; s < SEG; s++) { const t = s / SEG; bpos.push(-1, t, 0, 1, t, 0); }
  bpos.push(0, 1, 0);
  for (let s = 0; s < SEG - 1; s++) { const a = s * 2; bidx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  bidx.push((SEG - 1) * 2, (SEG - 1) * 2 + 1, SEG * 2);

  const nBlades = blades.length / 20;
  const bg = new THREE.InstancedBufferGeometry();
  bg.setAttribute('position', new THREE.Float32BufferAttribute(bpos, 3));
  bg.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(bpos.length).fill(0), 3));
  bg.setIndex(bidx);
  const ib = new THREE.InstancedInterleavedBuffer(new Float32Array(blades), 20, 1);
  bg.setAttribute('iRoot', new THREE.InterleavedBufferAttribute(ib, 4, 0));
  bg.setAttribute('iShape', new THREE.InterleavedBufferAttribute(ib, 4, 4));
  bg.setAttribute('iCol', new THREE.InterleavedBufferAttribute(ib, 4, 8));
  bg.setAttribute('iNrm', new THREE.InterleavedBufferAttribute(ib, 4, 12));
  bg.setAttribute('iExt', new THREE.InterleavedBufferAttribute(ib, 4, 16));
  bg.instanceCount = nBlades;
  bg.boundingSphere = new THREE.Sphere(new THREE.Vector3(15, 25, -30), 60);

  // metres per pixel at 1 m (updated per frame from the camera + drawing buffer)
  const uPx = { value: 0.001 };
  const sharedDefs = /* glsl */ `
    ${WIND_UNIFORMS_GLSL}
    uniform float uTime;
    uniform float uPx;
    ${WIND_FIELD_GLSL}
    varying vec3 vGCol;
    varying float vGT;
    varying float vGSun;
    varying float vGA;
    varying float vGK;
    varying vec3 vGE;
  `;

  function makeMaterial(vertexBody, fragAO, opts) {
    const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: opts.rough, metalness: 0, side: THREE.DoubleSide, alphaToCoverage: true });
    m.onBeforeCompile = (sh) => {
      for (const k of ['uTime', 'uWindDir', 'uGust', 'uWindSpeed', 'uWindAdv']) sh.uniforms[k] = uniforms[k];
      sh.uniforms.uPx = uPx;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\n' + sharedDefs + vertexBody.decl)
        .replace('#include <beginnormal_vertex>', vertexBody.normal)
        .replace('#include <begin_vertex>', vertexBody.pos);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vGCol;\nvarying float vGT;\nvarying float vGSun;\nvarying float vGA;\nvarying float vGK;\nvarying vec3 vGE;\n' + (opts.fragDecl || ''))
        .replace('#include <color_fragment>', '#include <color_fragment>\nfloat gAlpha = vGA;\n' + fragAO + '\ndiffuseColor.a = clamp(gAlpha, 0.0, 1.0);')
        .replace('#include <normal_fragment_begin>', `
          vec3 normal = normalize( vNormal );
          vec3 nonPerturbedNormal = normal;
          float faceDirection = 1.0;
          #ifdef USE_TANGENT
          vec3 tangent = normalize( vTangent ); vec3 bitangent = normalize( vBitangent );
          #endif
          `);
      patchVegLighting(sh, uniforms, { sun: 'vGSun', occ: 'mix(0.7, 1.1, vGT)', trans: opts.trans });
    };
    m.customProgramCacheKey = () => 'grass-' + vertexBody.key;
    return patchMaterialAtmosphere(m, uniforms);
  }

  const bladeVS = {
    key: 'blade2',
    decl: /* glsl */ `
      attribute vec4 iRoot; attribute vec4 iShape; attribute vec4 iCol; attribute vec4 iNrm; attribute vec4 iExt;
      vec3 gBladePos(out vec3 across, out vec3 face){
        float t = position.y, side = position.x;
        // seed stalks: rows moved up so the last two segments form a spindle-shaped head
        bool seedS = iExt.z > 0.5;
        if (seedS && t > 0.01 && t < 0.99) t = mix(0.78, 0.9, clamp((t - 0.333) / 0.334, 0.0, 1.0));
        float yaw = iRoot.w;
        across = vec3(cos(yaw), 0.0, sin(yaw));
        vec3 leanDir = vec3(cos(iCol.w), 0.0, sin(iCol.w));
        float dist = distance(cameraPosition, iRoot.xyz);
        // LOD: lawn blades fade out ${LAWN_FADE[0]}..${LAWN_FADE[1]} m (the mat carries the texture beyond), tussocks 60..75 m
        float lod = iExt.x > 0.5 ? smoothstep(75.0, 60.0, dist) : smoothstep(${LAWN_FADE[1].toFixed(1)}, ${LAWN_FADE[0].toFixed(1)}, dist);
        float h = iShape.x * lod;
        // wind: slow sway modulated by the travelling gust field (the reference grass is near-still)
        float wf = windField(iRoot.xz);
        // sway rates are whole multiples of 1/60 Hz (1 Hz lawn, 0.55 Hz tussocks), so time can be
        // wrapped at 60 s: seamless, and float precision never decays over long sessions
        float ph = iShape.w + dot(iRoot.xz, uWindDir) * 0.9 - mod(uTime, 60.0) * mix(6.2831853, 3.4557519, iExt.x);
        // sub-pixel blades must not move (the reference lawn is still beyond ~10 m; a swaying 1-px
        // sliver flips MSAA coverage samples and sparkles): lawn sway fades out 5..9 m, tussocks (11 m+)
        // are still
        float swayK = iExt.x > 0.5 ? smoothstep(11.0, 8.0, dist) : smoothstep(9.0, 5.0, dist);
        float sway = (0.035 + 0.08 * wf) * (0.7 + 0.3 * sin(ph)) * (1.0 - iExt.x * 0.65) * swayK;
        vec3 wdir = vec3(uWindDir.x, 0.0, uWindDir.y);
        vec3 bend = leanDir * iShape.z + wdir * sway * 1.6;
        float bl = length(bend);
        float t2 = t * t;
        vec3 p = iRoot.xyz + vec3(0.0, h * t * (1.0 - 0.25 * min(bl, 1.5) * t), 0.0) + bend * h * t2 * 0.6;
        // >= 1.2 px wide; coverage alpha for the part below that
        float wTrue = iShape.y * (seedS ? (t > 0.85 ? 3.4 + 1.6 * iExt.w : 1.0) / (1.0 - t * 0.85) : 1.0);
        float wMin = dist * uPx * 1.2;
        float w = max(wTrue, wMin);
        vGA = max(wTrue / w, 0.4); // fewer 1-sample coverage states
        p += across * side * w * 0.5 * (1.0 - t * 0.85);
        face = normalize(cross(across, normalize(vec3(0.0, 1.0, 0.0) + bend * 0.6 * t)));
        if (dot(face, cameraPosition - p) < 0.0) face = -face;
        return p;
      }
    `,
    normal: /* glsl */ `
      vec3 gAcross; vec3 gFace; vec3 gP = gBladePos(gAcross, gFace);
      vec3 objectNormal = normalize(iNrm.xyz + 0.25 * gFace);
      #ifdef USE_TANGENT
      vec3 objectTangent = vec3(1.0, 0.0, 0.0);
      #endif
      vGCol = iCol.rgb; vGT = position.y; vGSun = iNrm.w; vGK = iExt.x;
      vGE = vec3(iExt.y, iExt.z, iExt.w);
      if (iExt.z > 0.5 && vGT > 0.01 && vGT < 0.99) vGT = mix(0.78, 0.9, clamp((vGT - 0.333) / 0.334, 0.0, 1.0));
    `,
    pos: /* glsl */ `vec3 transformed = gP;`,
  };
  // blade colour: dark, occluded base inside the turf / tussock core; lighter body; straw-bleached
  // or sun-yellowed tips on part of the blades; seed stalks straw with a darker purple-brown or pale
  // straw seed head
  const bladeMat = makeMaterial(bladeVS, /* glsl */ `
    {
      float gT = vGT;
      vec3 bc = vGCol * mix(0.8, 1.15, gT) * mix(mix(0.62, 0.45, vGK), 1.0, smoothstep(0.0, 0.5, gT));
      bc = mix(bc, ${srgbVec('#a3a26a')}, 0.18 * gT * (1.0 - vGK));
      vec3 straw = mix(${srgbVec('#b3a37e')}, ${srgbVec('#8e7c78')}, vGK); // lawn: straw; tussocks: mauve-grey
      bc = mix(bc, straw * mix(0.8, 1.05, vGE.z), vGE.x * smoothstep(0.45, 1.0, gT) * mix(0.45, 0.7, vGK));
      if (vGE.y > 0.5) {
        vec3 head = mix(${srgbVec('#5e4c46')}, ${srgbVec('#8e826a')}, step(0.6, vGE.z));
        bc = mix(vGCol * 1.05, head, smoothstep(0.8, 0.84, gT));
      }
      diffuseColor.rgb *= bc;
    }`, { rough: 0.85, trans: 'mix(0.6, 0.9, vGK)' });
  const bladeMesh = new THREE.Mesh(bg, bladeMat);
  bladeMesh.frustumCulled = false;
  bladeMesh.receiveShadow = true;
  bladeMesh.castShadow = false;
  bladeMesh.renderOrder = -2;
  if (ctx.params.get('debug') !== 'noblades') scene.add(bladeMesh);

  // ---- weeds: rosettes of 6 ovate leaves (each a diamond) ----------------------------------------
  const nWeeds = weeds.length / 8;
  const wpos = [], widx = [];
  for (let l = 0; l < 6; l++) {
    const a = l * Math.PI / 3 + 0.4 * (l & 1);
    const b = wpos.length / 3;
    wpos.push(0, 0, a, 0.4, -1, a, 0.4, 1, a, 1, 0, a);
    widx.push(b, b + 1, b + 3, b, b + 3, b + 2);
  }
  const wg = new THREE.InstancedBufferGeometry();
  wg.setAttribute('position', new THREE.Float32BufferAttribute(wpos, 3));
  wg.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(wpos.length).fill(0), 3));
  wg.setIndex(widx);
  const wdat = new Float32Array(nWeeds * 12);
  for (let i = 0; i < nWeeds; i++) {
    const o = i * 8;
    col.set(GRASS_COLOR.weed).multiplyScalar(0.42 + 0.36 * rand());
    wdat.set([weeds[o], weeds[o + 1] + 0.035, weeds[o + 2], weeds[o + 3], weeds[o + 4], weeds[o + 5], weeds[o + 6], 0, col.r, col.g, col.b, weeds[o + 7]], i * 12);
  }
  const iw = new THREE.InstancedInterleavedBuffer(wdat, 12, 1);
  wg.setAttribute('iRoot', new THREE.InterleavedBufferAttribute(iw, 4, 0));
  wg.setAttribute('iShape', new THREE.InterleavedBufferAttribute(iw, 4, 4));
  wg.setAttribute('iCol', new THREE.InterleavedBufferAttribute(iw, 4, 8));
  wg.instanceCount = nWeeds;
  wg.boundingSphere = bg.boundingSphere.clone();
  const weedVS = {
    key: 'weed2',
    decl: /* glsl */ `
      attribute vec4 iRoot; attribute vec4 iShape; attribute vec4 iCol;
      vec3 gWeedPos(out vec3 nrm){
        float along = position.x, side = position.y, a = position.z + iRoot.w;
        float L = iShape.x;
        vec3 dir = vec3(cos(a), 0.0, sin(a));
        vec3 sd = vec3(-dir.z, 0.0, dir.x);
        float tilt = 0.35 + 0.25 * sin(iShape.z + a);
        vec3 leafDir = normalize(dir + vec3(0.0, tilt, 0.0));
        vec3 p = iRoot.xyz + leafDir * L * along + sd * side * L * 0.38 * iShape.y;
        nrm = normalize(cross(sd, leafDir));
        if (nrm.y < 0.0) nrm = -nrm;
        nrm = normalize(nrm * 0.6 + vec3(0.0, 1.0, 0.0));
        float dist = distance(cameraPosition, iRoot.xyz);
        vGA = 1.0;
        return mix(iRoot.xyz, p, smoothstep(16.0, 12.0, dist));
      }
    `,
    normal: /* glsl */ `
      vec3 gN; vec3 gP = gWeedPos(gN);
      vec3 objectNormal = gN;
      #ifdef USE_TANGENT
      vec3 objectTangent = vec3(1.0, 0.0, 0.0);
      #endif
      vGCol = iCol.rgb; vGT = 0.4 + 0.6 * position.x; vGSun = iCol.w; vGK = 0.0;
    `,
    pos: /* glsl */ `vec3 transformed = gP;`,
  };
  const weedMat = makeMaterial(weedVS, /* glsl */ `diffuseColor.rgb *= vGCol * mix(0.6, 1.0, vGT);`, { rough: 0.5, trans: '0.4' });
  const weedMesh = new THREE.Mesh(wg, weedMat);
  weedMesh.frustumCulled = false;
  weedMesh.receiveShadow = true;
  weedMesh.renderOrder = -2;
  scene.add(weedMesh);

  // ---- tussock core domes: a lumpy, fuzzy-edged half ellipsoid per tussock (dark reddish-brown
  // at the foot, paler mauve at the top, fine vertical strand texture filtered by footprint, alpha
  // falling off toward the silhouette through alpha-to-coverage), so the tussocks read as dense soft
  // mounds with the blades as their fibrous surface ------------------------------------------------
  const nTuss = tuss.length / 12;
  {
    const AZ = tier === 'low' ? 8 : 12, RG = tier === 'low' ? 3 : 4;
    const dp = [], di = [];
    for (let r = 0; r <= RG; r++) {
      const el = (r / RG) * Math.PI / 2;
      for (let a = 0; a < AZ; a++) {
        const az = a / AZ * Math.PI * 2;
        dp.push(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az));
      }
    }
    for (let r = 0; r < RG; r++) for (let a = 0; a < AZ; a++) {
      const i0 = r * AZ + a, i1 = r * AZ + (a + 1) % AZ, j0 = i0 + AZ, j1 = i1 + AZ;
      di.push(i0, j0, i1, i1, j0, j1);
    }
    const tg = new THREE.InstancedBufferGeometry();
    tg.setAttribute('position', new THREE.Float32BufferAttribute(dp, 3));
    tg.setAttribute('normal', new THREE.Float32BufferAttribute(dp.slice(), 3));
    tg.setIndex(di);
    const it = new THREE.InstancedInterleavedBuffer(new Float32Array(tuss), 12, 1);
    tg.setAttribute('iRoot', new THREE.InterleavedBufferAttribute(it, 4, 0));
    tg.setAttribute('iShape', new THREE.InterleavedBufferAttribute(it, 4, 4));
    tg.setAttribute('iCol', new THREE.InterleavedBufferAttribute(it, 4, 8));
    tg.instanceCount = nTuss;
    tg.boundingSphere = bg.boundingSphere.clone();
    const domeVS = {
      key: 'tdome1',
      decl: /* glsl */ `
        attribute vec4 iRoot; attribute vec4 iShape; attribute vec4 iCol;
        vec3 gDomePos(out vec3 n){
          vec3 lp = position;
          float az = atan(lp.z, lp.x);
          float yaw = iRoot.w, c = cos(yaw), s = sin(yaw);
          float R = iShape.x, H = iShape.y;
          // lumpy outline, a flatter, slightly downwind-leaning crown
          float lk = 1.0 + 0.2 * sin(az * 3.0 + iShape.z) + 0.1 * sin(az * 5.0 + iShape.z * 2.3) + 0.06 * sin(az * 9.0 + iShape.z * 3.7);
          vec3 q = vec3(c * lp.x - s * lp.z, lp.y, s * lp.x + c * lp.z);
          vec3 p = iRoot.xyz + vec3(q.x * R * lk, q.y * H * (0.9 + 0.1 * lk), q.z * R * lk);
          p.xz += vec2(0.55, -0.2) * iShape.w * H * q.y * q.y;
          n = normalize(vec3(q.x / R, q.y / H, q.z / R));
          float dist = distance(cameraPosition, iRoot.xyz);
          vGE = vec3(az * R * lk, lp.y * H, iShape.z);
          vGA = 1.0;
          return p;
        }
      `,
      normal: /* glsl */ `
        vec3 gN; vec3 gP = gDomePos(gN);
        vec3 objectNormal = gN;
        #ifdef USE_TANGENT
        vec3 objectTangent = vec3(1.0, 0.0, 0.0);
        #endif
        vGCol = iCol.rgb; vGT = position.y; vGSun = iCol.w; vGK = 1.0;
      `,
      pos: /* glsl */ `vec3 transformed = gP;`,
    };
    const domeMat = makeMaterial(domeVS, /* glsl */ `
      {
        // vertical strands (5-8 mm), tilted a little, faded to their mean once sub-pixel
        vec2 sc = vec2(vGE.x / 0.007 + vGE.y * 9.0, vGE.y / 0.08);
        float fw = max(fwidth(sc.x), 1e-4);
        float sfade = 1.0 - smoothstep(0.35, 0.7, fw);
        float n1 = gtN(sc + vGE.z), n2 = gtN(sc * vec2(0.37, 0.5) + vGE.z * 1.7);
        float strands = mix(0.5, n1 * 0.6 + n2 * 0.4, sfade);
        float lumpN = gtN(vec2(vGE.x / 0.09, vGE.y / 0.07) + vGE.z * 3.1);
        float ht = vGT;
        vec3 bc = vGCol * mix(0.6, 1.1, pow(ht, 0.7)) * (0.6 + 0.8 * strands) * (0.8 + 0.4 * lumpN);
        bc = mix(bc, ${srgbVec('#8e7c78')} * 0.8, smoothstep(0.6, 1.0, ht) * 0.3 * strands);
        diffuseColor.rgb *= bc;
        // fuzzy silhouette: coverage falls toward the grazing rim and in the strand gaps near the top
        float nv = abs(dot(normalize(vNormal), normalize(vViewPosition)));
        gAlpha = smoothstep(0.0, 0.75, nv + 0.25 * (1.0 - ht) - 0.25 * lumpN + 0.1) * mix(1.0, 0.45 + 1.1 * strands, smoothstep(0.3, 1.0, ht));
      }`, { rough: 0.9, trans: '0.5', fragDecl: /* glsl */ `
        float gtH(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
        float gtN(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(gtH(i), gtH(i + vec2(1.0, 0.0)), f.x), mix(gtH(i + vec2(0.0, 1.0)), gtH(i + vec2(1.0, 1.0)), f.x), f.y); }` });
    const domeMesh = new THREE.Mesh(tg, domeMat);
    domeMesh.frustumCulled = false;
    domeMesh.receiveShadow = true;
    domeMesh.renderOrder = -2;
    if (ctx.params.get('debug') !== 'nodomes') scene.add(domeMesh);
  }

  // ---- lip fringe: low, lumpy herb clumps along the headland edge and around the dead shrubs' feet
  // (the reference lip is a raised herb mound that hides the shrub bases and breaks the silhouette
  // against the sea). Each clump is a flattened dome of 36 small oval leaves (alpha-to-coverage
  // outlines), lit tops and dark lower leaves; static (the reference herbs are still).
  let nFringe = 0;
  if (tier !== 'low') {
    const fr = mulberry32(5519);
    const NL = 44;
    const lp = [], la = [], li = [];
    for (let l = 0; l < NL; l++) {
      const az = fr() * 6.283, el = Math.asin(Math.pow(fr(), 0.55)) * 0.95, rot = fr() * 6.283, sz = 0.02 + 0.016 * fr();
      const b = lp.length / 3;
      for (const [u, v] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { lp.push(u, v, 0); la.push(az, el, rot, sz); }
      li.push(b, b + 1, b + 2, b, b + 2, b + 3);
    }
    const fdat = [];
    const spots = deadShrubSpots(layout);
    const herbCol = new THREE.Color(GRASS_COLOR.green).multiply(new THREE.Color(0.62, 0.74, 0.62));
    const addClump = (x, z, sc) => {
      nrm(x, z, N);
      if (N[1] < 0.55) return;
      const y = H(x, z);
      const W = (0.12 + 0.16 * fr()) * sc, Hh = W * (0.45 + 0.35 * fr());
      col.copy(herbCol).multiplyScalar(0.75 + 0.4 * fr());
      if (fr() < 0.3) col.lerp(new THREE.Color(GRASS_COLOR.greenDark), 0.35);
      fdat.push(x, y - 0.03, z, fr() * 6.283, W, Hh, 0.85 + 0.35 * fr(), fr() * 100, col.r, col.g, col.b, sunVis(x, z, y + 0.3) * sunMaskAt(x, z));
    };
    for (let z = -4.5; z > -24; z -= 0.16) {
      for (let x = -10; x < 3; x += 0.16) {
        const jx = x + (fr() - 0.5) * 0.16, jz = z + (fr() - 0.5) * 0.16;
        const dh = Math.hypot(jx - cam.x, jz - cam.z);
        if (dh < 6 || dh > 22) continue;
        const ang = Math.atan2(jx - cam.x, -(jz - cam.z));
        if (ang < -0.9 || ang > 0.72) continue;
        const sdf = SDF(jx, jz);
        if (sdf > -0.12 || sdf < -1.8) continue;
        const pr = 0.22 * smooth(-1.8, -0.9, sdf) * smooth(-0.12, -0.4, sdf) * smooth(0.3, 0.55, fbm2(jx * 1.3 + 3.0, jz * 1.3, 2) + 0.1);
        // (only a few tufts on the bare rock / soil of the brow knob and the edge band)
        if (fr() < pr * (1 - 0.75 * layout.bareRockAt(jx, jz, sdf))) addClump(jx, jz, 1.0 + 0.6 * smooth(-0.9, -0.3, sdf));
      }
    }
    // around the dead shrubs' feet (mostly on the camera side)
    for (const sp of spots) {
      for (let k = 0; k < 9; k++) {
        const a = fr() * 6.283, r = 0.15 + 0.55 * Math.sqrt(fr());
        addClump(sp.x + Math.cos(a) * r * 1.2, sp.z + Math.sin(a) * r + 0.2, 1.2);
      }
    }
    nFringe = fdat.length / 12;
    const fg = new THREE.InstancedBufferGeometry();
    fg.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3));
    fg.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(lp.length).fill(0), 3));
    fg.setAttribute('aLeaf', new THREE.Float32BufferAttribute(la, 4));
    fg.setIndex(li);
    const ifr = new THREE.InstancedInterleavedBuffer(new Float32Array(fdat), 12, 1);
    fg.setAttribute('iRoot', new THREE.InterleavedBufferAttribute(ifr, 4, 0));
    fg.setAttribute('iShape', new THREE.InterleavedBufferAttribute(ifr, 4, 4));
    fg.setAttribute('iCol', new THREE.InterleavedBufferAttribute(ifr, 4, 8));
    fg.instanceCount = nFringe;
    fg.boundingSphere = new THREE.Sphere(new THREE.Vector3(-4, 30, -14), 20);
    const fringeVS = {
      key: 'fringe1',
      decl: /* glsl */ `
        attribute vec4 iRoot; attribute vec4 iShape; attribute vec4 iCol; attribute vec4 aLeaf;
        vec3 gFringePos(out vec3 n){
          float az = aLeaf.x + iRoot.w, el = aLeaf.y;
          vec3 dn = vec3(cos(el) * cos(az), sin(el), cos(el) * sin(az));
          // lumpy dome: the radius varies with azimuth per clump
          float lk = 1.0 + 0.18 * sin(az * 3.0 + iShape.w) + 0.1 * sin(az * 5.0 + iShape.w * 1.7);
          vec3 c = iRoot.xyz + vec3(dn.x * iShape.x * lk, dn.y * iShape.y * lk, dn.z * iShape.x * lk);
          vec3 ln = normalize(dn + vec3(0.0, 0.7, 0.0));
          vec3 t1 = normalize(cross(ln, vec3(cos(aLeaf.z), 0.0, sin(aLeaf.z))));
          vec3 t2 = cross(ln, t1);
          float L = aLeaf.w * iShape.z;
          // >= 1 px leaves (coverage carries the rest)
          float dist = distance(cameraPosition, c);
          float Lp = max(L, dist * uPx * 0.9);
          vGA = clamp(L / Lp, 0.4, 1.0);
          vec3 p = c + t1 * position.x * Lp + t2 * position.y * Lp * 0.6;
          n = normalize(dn * 0.65 + ln * 0.35);
          vGE = vec3(position.xy, fract(aLeaf.z * 7.13 + iShape.w));
          return p;
        }
      `,
      normal: /* glsl */ `
        vec3 gN; vec3 gP = gFringePos(gN);
        vec3 objectNormal = gN;
        #ifdef USE_TANGENT
        vec3 objectTangent = vec3(1.0, 0.0, 0.0);
        #endif
        vGCol = iCol.rgb; vGT = sin(aLeaf.y); vGSun = iCol.w; vGK = 0.0;
      `,
      pos: /* glsl */ `vec3 transformed = gP;`,
    };
    const fringeMat = makeMaterial(fringeVS, /* glsl */ `
      {
        vec2 uv = vGE.xy;
        // oval leaf with a slightly pointed tip; darker midrib; lower leaves shaded by the ones above
        float e = length(vec2(uv.x, uv.y / (1.0 - 0.3 * uv.x * uv.x)));
        float aa = fwidth(e) + 0.05;
        gAlpha *= 1.0 - smoothstep(1.0 - aa, 1.0, e);
        float rib = mix(0.85, 1.0, smoothstep(0.0, 0.2, abs(uv.y)));
        diffuseColor.rgb *= vGCol * mix(0.35, 1.18, vGT * vGT) * (0.78 + 0.44 * vGE.z) * rib;
      }`, { rough: 0.55, trans: '0.45' });
    const fringeMesh = new THREE.Mesh(fg, fringeMat);
    fringeMesh.frustumCulled = false;
    fringeMesh.receiveShadow = true;
    fringeMesh.renderOrder = -2;
    scene.add(fringeMesh);
  }

  const _v2 = new THREE.Vector2();
  ctx.progress(1, 'Grass');
  if (ctx.params.get('debug') === 'grass') console.warn('[grass] blades', nBlades, 'weeds', nWeeds, 'mat tris', matTris, 'tussock domes', nTuss, 'fringe clumps', nFringe, 'total tris', nBlades * 5 + nWeeds * 12 + matTris + nTuss * (tier === 'low' ? 48 : 96) + nFringe * 88);
  return {
    blades: nBlades,
    weeds: nWeeds,
    update() {
      const cam3 = ctx.camera;
      ctx.renderer.getDrawingBufferSize(_v2);
      // the scene target is the drawing buffer x the dynamic-resolution scale (post.js)
      uPx.value = 2 * Math.tan(THREE.MathUtils.degToRad(cam3.fov) / 2) / Math.max(1, _v2.y * (quality.scale || 1));
    },
  };
}
