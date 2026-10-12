// Windswept coastal she-oaks (Casuarina equisetifolia) on the Point Lookout headland.
//
// Placement is done in the reference image: every limb waypoint / crown mass is given as a pixel of
// the 1276x718 reference frame plus a distance along the camera ray (or a ground hit), converted to
// world space with the calibrated base camera (so a config pitch/roll change re-projects everything).
// Skeletons: hand-placed wind-swept limbs, each from its own base (rising from the lower left into the
// crowns, or running near-horizontally along the ground, crossing at different heights), kinked paths,
// recursive side shoots (bare twig network, ~40% dead, never into the ground), a screen of fine grey
// upright dead twigs, crown branches grown into each foliage mass and twigs to every spray; generated
// wood inside the crown cores is cut away (the needles hide it). Bark: procedural furrows, sky-lit tops,
// golden-grey sun-facing flanks, weathered silver-grey dead wood.
// Foliage: camera-facing cards from a 2048^2 procedural atlas (lib/tuftAtlas.js) of separate, drooping,
// wind-streamed TASSELS (bundles of hair-thin branchlet threads): at 20-25 m a card resolves into
// ~1 px x 5-15 px soft streaks with see-through gaps, like the video's crowns. Tufts are scattered
// around clump centres inside screen-space-holed crown ellipsoids with ragged hanging bottoms, and drawn
// as an alpha-tested core (front-to-back, depth + shadows; only the densest texels) plus a blended
// soft fringe (back-to-front) that carries most of the semi-transparent, motion-blurred look.
// Lighting (sun 7 deg high, front-right): one continuous crown light field evaluated at each card's
// anchor (sun-side / rim brighter, deep core slightly darker, ~0.6 m noise, mild per-clump and
// per-spray mottling) - nothing is top-lit, the crowns are evenly lit top to bottom like the reference;
// hue follows the light (golden lit sprays, greyer olive shade) and a forward-scattering + isotropic
// needle-cloud sun term adds the backlit glow.
// Close-up branch E (3 m): real thread geometry - ~1.7k camera-facing 3-segment ribbons hanging from
// its nodes (golden needle lighting), over a few soft cards.
// Wood: gnarled hand-placed limbs (radius noise, swelling at kinks), crooked slanted dead twigs, bark
// fissures / knots / lichen faded by pixel footprint; sub-pixel twigs are widened to ~1 px and output
// their true coverage as alpha-to-coverage (soft grey lines, not black dots), with a camera-facing
// shading normal below ~2 px (no sparkling facets).
// Wind: hierarchical vertex animation (lib/vegWind.js) driven by the shared, downwind-travelling,
// 60 s-periodic gust function: shared crown sway + a spatially coherent spray sway field + 2-4 Hz
// buffeting + a texture-space ripple, so the crowns move internally like the video.
import * as THREE from 'three';
import { CONFIG, DEG } from '../config.js';
import { mulberry32, fbm2 } from '../core/rng.js';
import { patchMaterialAtmosphere } from '../core/atmosphere.js';
import { WIND_DIR } from '../core/wind.js';
import { Branch, finalizeBranch, kinkedPath, taper, sprout, growTwig, buildTubes } from './lib/branches.js';
import { makeTuftAtlas, variantRect, variantAspect, variantAttach, variantBounds, VARIANT_SETS, ATLAS_GAIN } from './lib/tuftAtlas.js';
import { patchVegWind, VEG_PX } from './lib/vegWind.js';
import { invAcesSRGB8 } from '../post/tonemap.js';

const REF_W = 1276, REF_H = 718;
// Linear-space correction of foliage albedo against the green-cyan cast of sky IBL + ACES (calibrated
// on crowns B/C: target sRGB ~(104..128, 97..114, 79..86) region means).
// r4: G lowered (crown hue 46 -> ~40 deg like the reference's golden-tan, not yellow-green)
const FOLIAGE_TINT = [1.07, 1.06, 2.33];

const CORE_A = 0.88; // alpha-test threshold of the opaque foliage core (the fringe pass skips these texels)
// lump shading (see makeFoliageMat): light gradient across a clump, fade radius (clump units)
// (r4: rounder, tighter, more strongly modelled lumps: the ref crowns' energy at 6-24 px scales is
// ~1.5x ours at equal 1-2 px texture contrast; their shaded undersides are greyer, b/r ~0.75)
const LUMP_K = 0.3, LUMP_R = [0.8, 1.65], LUMP_Y = 0.72; // (r5: K 0.45 -> 0.3: the strongly top-lit lumps read as cauliflower heads; ref tufts are evenly lit streaks)

function lin(hex) { const c = new THREE.Color(hex); return [c.r, c.g, c.b]; }
function smoothstep(a, b, x) { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); }

export default async function create(ctx) {
  const { scene, layout, uniforms, quality } = ctx;
  const tier = quality?.tier || 'high';
  const density = tier === 'high' ? 1 : tier === 'medium' ? 0.6 : 0.35;
  // keeps crown coverage when the card count drops (r4b: low 1.44 -> 1.3 and the lump fade only by sqrt:
  // same-size renders gave crown C coverage 0.59 high / 0.63 medium / 0.70 low, ref 0.50)
  const tierSize = tier === 'low' ? 1.3 : Math.pow(density, -0.35);
  const lumpRK = Math.sqrt(tierSize);
  const eThreads = 0; // (r4b: none - the threads were stretched by the whipping motion into straw lines below the tufts; the out-of-focus ref tufts are soft masses, the cards carry their fibres) // (r4: fewer: the out-of-focus ref tufts read as soft masses, the soft cards carry them) // close-up branch E threads per node
  const rng = mulberry32(20240925);

  // ---- calibrated reference camera ---------------------------------------------------------
  const cam = CONFIG.camera;
  const refCam = new THREE.PerspectiveCamera(cam.vfovDeg, REF_W / REF_H, 0.1, 1000);
  refCam.position.fromArray(cam.position);
  refCam.rotation.order = 'YXZ';
  refCam.rotation.set(cam.pitchDeg * DEG, cam.yawDeg * DEG, cam.rollDeg * DEG);
  refCam.updateMatrixWorld();
  refCam.updateProjectionMatrix();
  const eye = refCam.position.clone();
  const FPX = (REF_H / 2) / Math.tan((cam.vfovDeg * DEG) / 2); // focal length in px

  const rayDir = (px, py) => new THREE.Vector3(px / REF_W * 2 - 1, 1 - py / REF_H * 2, 0.5).unproject(refCam).sub(eye).normalize();
  // point at distance d along the pixel ray
  const P = (px, py, d) => eye.clone().addScaledVector(rayDir(px, py), d);
  // ground hit along the pixel ray (+ lift in metres)
  const G = (px, py, lift = 0) => {
    const dir = rayDir(px, py);
    let prev = 0;
    for (let t = 1; t < 200; t += 0.1) {
      const p = eye.clone().addScaledVector(dir, t);
      if (p.y <= layout.heightAt(p.x, p.z)) {
        // refine
        let a = prev, b = t;
        for (let k = 0; k < 12; k++) {
          const m = (a + b) / 2; const q = eye.clone().addScaledVector(dir, m);
          if (q.y <= layout.heightAt(q.x, q.z)) b = m; else a = m;
        }
        const q = eye.clone().addScaledVector(dir, b);
        q.y += lift;
        return q;
      }
      prev = t;
    }
    return eye.clone().addScaledVector(dir, 30);
  };
  // project a pixel/distance point straight down onto the ground (+lift)
  const GB = (px, py, d, lift = 0) => { const p = P(px, py, d); p.y = layout.heightAt(p.x, p.z) + lift; return p; };

  const lean = new THREE.Vector3(WIND_DIR[0], 0, WIND_DIR[1]).normalize();
  // sun direction with its (small) vertical part damped: the crown light field is a sun-side term
  const sunW = uniforms.uSunDir?.value ? uniforms.uSunDir.value.clone() : new THREE.Vector3(0.86, 0.12, -0.5);
  const SUN_FLAT = new THREE.Vector3(sunW.x, 0.3 * sunW.y, sunW.z).normalize();

  // ---- tree specifications (reference-frame pixels) -------------------------------------
  // limbs: { pts: [...Vector3], r: [r0, r1], level, dead?, from?: index of limb it branches off }
  // blobs: { c: [px, py], d: dist, rx, ry (px), rz (m), n: tufts, size: [min,max] m, pal }
  // Albedos calibrated (full-scene renders, t=0.5) for sun = 2.1*PI (config.sun) + sky IBL: region
  // means crown B ~(100,87,65) vs ref (110,98,73), crown C ~(127,110,82) vs ref (133,118,86).
  const PAL = {
    sunB: ['#9a936c', '#918b68', '#a19971', '#968e66'],
    shadeB: ['#8c8569', '#847e63', '#888266'], // (r4b: ref lower-crown foliage b/r ~0.63, 83-135: warmer olive, not grey-green)
    A: ['#988656', '#8e7e50', '#a08e5c'],
    Alow: ['#77745f', '#6f6d5a', '#7c7862'], // (r4b) tree A's shaded lower layer: grey olive, ref p50 ~(85,85,81) // (r4b: warmer olive, ref darkest-quartile b/r ~0.6) // backlit grey-olive with golden tips (ref interiors ~(72,64,44), tips ~(180,165,120)); hue ~40 deg
    E: ['#9a925c', '#948c59', '#908856'], // (r4b: ref E (139,126,83): greener, darker) // (r4: ref E mid (139,125,81): darker, more saturated golden-olive)
    D: ['#7c7d6b', '#77786a'], // neutral grey-green bush (ref sRGB ~(96,93,90))
    sunC: ['#9f9872', '#98916e', '#a59e76', '#9b9470'], // (r4: b/r 0.78 -> 0.72: ref crown C's lit sprays are as golden as B's, hue ~42-49 deg)
    shadeC: ['#867b5a', '#7d7456'], // (r4b: ref C shade hue ~37: browner)
  };

  const trees = [];
  // Tree B (main, dense golden crown). Wind-swept: every limb has its own base (at most two per base),
  // thick limbs rise from the lower left toward the crown, others run near-horizontally along the ground
  // to the left and right, crossing each other at different heights (ref x 480-1100, rows 520-620).
  trees.push({
    name: 'B', flex: 1,
    limbs: [
      // 0-1: main limbs rising from the lower left into the crown
      { pts: [G(770, 604), P(800, 572, 15.5), P(842, 528, 17), P(885, 482, 18.5), P(925, 432, 20), P(952, 382, 21), P(972, 340, 21.5)], r: [0.07, 0.03], level: 0 },
      { pts: [G(905, 590), P(935, 556, 17.5), P(975, 515, 19), P(1010, 470, 20.5), P(1038, 425, 21.5), P(1058, 392, 22)], r: [0.065, 0.028], level: 0 },
      // 2: leaning limb off limb 0 up into the left half of the crown
      { pts: [P(842, 528, 17), P(868, 478, 18.4), P(898, 425, 20), P(930, 365, 21)], r: [0.045, 0.02], level: 1 },
      // 3: low limb running right, near the ground
      { pts: [G(752, 603), G(800, 591, 0.45), G(860, 579, 0.75), G(930, 567, 0.95), G(1000, 554, 1.0), G(1062, 546, 0.8)], r: [0.055, 0.02], level: 0 },
      // 4-5: limbs lying along the ground to the left (dead, weathered)
      { pts: [G(742, 598), G(700, 577, 0.55), G(650, 562, 0.85), G(600, 554, 0.75), G(550, 546, 0.45), G(505, 541, 0.25)], r: [0.05, 0.018], level: 0, dead: true },
      { pts: [G(692, 611), G(640, 602, 0.35), G(590, 600, 0.45), G(530, 606, 0.3), G(482, 606, 0.15)], r: [0.045, 0.015], level: 0, dead: true },
      // 6: rising limb from the lower left toward the left crown lobe
      { pts: [G(682, 606), P(712, 562, 15.5), P(752, 518, 16.5), P(800, 482, 17.6), P(848, 456, 18.6)], r: [0.05, 0.018], level: 0 },
      // 7: right rising limb toward crown C
      { pts: [G(990, 578), P(1040, 542, 19.5), P(1090, 507, 21), P(1130, 482, 22), P(1168, 462, 23)], r: [0.055, 0.022], level: 0 },
      // 8: dead limb arching over the ground (crosses 4 and 6)
      { pts: [G(640, 593), G(690, 573, 0.9), G(740, 561, 1.3), G(795, 567, 1.0), G(845, 589, 0.3)], r: [0.042, 0.014], level: 0, dead: true },
      // 9: branch off limb 0 to the left lobe
      { pts: [P(842, 528, 17), P(812, 492, 17.8), P(782, 458, 18.6), P(762, 438, 19.3)], r: [0.04, 0.012], level: 1 },
      // 10: dead branch off limb 1 running right
      { pts: [P(975, 515, 19), P(1030, 520, 19.5), P(1090, 515, 20), P(1132, 505, 20.5)], r: [0.04, 0.012], level: 1, dead: true },
      // 11: thin dead limb low in the middle
      { pts: [G(880, 600), G(930, 612, 0.25), G(990, 620, 0.3), G(1040, 612, 0.25)], r: [0.045, 0.012], level: 0, dead: true },
      // 12-13: rising limbs crossing the middle (the lattice under crown B, ref x 720-1010, rows 470-610)
      { pts: [G(720, 608), P(780, 562, 16), P(850, 522, 17.5), P(920, 496, 19), P(990, 472, 20.5)], r: [0.05, 0.018], level: 0 },
      { pts: [G(800, 606), P(842, 576, 16.2), P(900, 546, 17.6), P(960, 526, 19), P(1012, 502, 20)], r: [0.045, 0.015], level: 0, dead: true },
    ],
    blobs: [
      // (r4b: re-placed against the reference coverage grid (t = 0.5 / 9 / 12.5): crown top raised into
      // the sea band above the rock edge (ref rows 297-306), dense lower-left lobe (x 824-900, rows
      // 376-424), a gap under the centre (x 896-1000, rows 424-448), lower-right mass down to row ~490)
      { c: [910, 391], d: 21, rx: 74, ry: 34, rz: 1.6, n: 58, size: [0.55, 1.0], pal: 'sunB' },
      { c: [985, 338], d: 22, rx: 50, ry: 32, rz: 1.4, n: 36, size: [0.5, 0.9], pal: 'sunB' },
      { c: [986, 315], d: 22, rx: 34, ry: 13, rz: 1.1, n: 9, size: [0.45, 0.8], pal: 'sunB' },
      { c: [1038, 390], d: 22, rx: 55, ry: 48, rz: 1.5, n: 52, size: [0.55, 1.0], pal: 'sunB' },
      { c: [848, 410], d: 20, rx: 44, ry: 26, rz: 1.0, n: 24, size: [0.45, 0.8], pal: 'shadeB' },
      { c: [874, 388], d: 20.5, rx: 32, ry: 14, rz: 0.9, n: 10, size: [0.45, 0.8], pal: 'shadeB' },
      { c: [830, 416], d: 19.5, rx: 22, ry: 20, rz: 0.8, n: 9, size: [0.4, 0.7], pal: 'shadeB' },
      { c: [1036, 340], d: 22, rx: 30, ry: 16, rz: 1.2, n: 6, size: [0.5, 0.9], pal: 'sunB' },
      { c: [1032, 452], d: 22, rx: 52, ry: 22, rz: 1.2, n: 18, size: [0.45, 0.85], pal: 'shadeB' },
    ],
  });
  // Tree C (right) — gnarled trunk leaning +X from behind the scrub, forking at (1222,476) + a leaning stem at x ~1110.
  trees.push({
    name: 'C', flex: 1,
    limbs: [
      { pts: [G(1165, 530), P(1192, 505, 24.8), P(1222, 480, 24.8), P(1214, 452, 24.6), P(1190, 422, 24.4), P(1165, 392, 24.2)], r: [0.09, 0.04], level: 0, kink: 25, tp: 1.1 },
      { pts: [P(1222, 476, 24.8), P(1238, 440, 24.6), P(1247, 405, 24.4), P(1255, 374, 24.3)], r: [0.075, 0.012], level: 1, kink: 22 },
      { pts: [G(1070, 532), P(1098, 508, 24.4), P(1112, 478, 24.3), P(1134, 448, 24.1), P(1146, 410, 24)], r: [0.065, 0.028], level: 0, kink: 25, tp: 1.1 },
      { pts: [G(1182, 526), G(1140, 540, 0.35), G(1095, 548, 0.4), G(1050, 552, 0.3)], r: [0.07, 0.015], level: 1, dead: true },
    ],
    blobs: [
      { c: [1167, 406], d: 24, rx: 64, ry: 44, rz: 1.5, n: 30, size: [0.55, 1.0], pal: 'sunC' },
      { c: [1216, 410], d: 24.5, rx: 40, ry: 20, rz: 1.2, n: 14, size: [0.5, 0.9], pal: 'sunC' },
      { c: [1118, 432], d: 23.5, rx: 30, ry: 26, rz: 1.0, n: 13, size: [0.45, 0.8], pal: 'shadeC' },
      { c: [1262, 410], d: 23, rx: 24, ry: 24, rz: 1.1, n: 7, size: [0.5, 0.9], pal: 'D' },
      { c: [1150, 425], d: 24, rx: 30, ry: 24, rz: 1.0, n: 10, size: [0.5, 0.9], pal: 'sunC' }, // (r4) C's left lumps (ref)
    ],
  });
  // Tree A (small, sparse, left) — base (620,540), trunk to y 445 then fans out into 4-5 horizontally
  // layered, elongated grey-olive sprays with golden tips.
  trees.push({
    name: 'A', flex: 1,
    limbs: [
      { pts: [G(620, 542), P(610, 505, 22.4), P(617, 470, 22.4), P(608, 446, 22.4)], r: [0.065, 0.03], level: 0, tp: 1.1 }, // (r4b: ref trunk ~4 px)
      { pts: [P(608, 446, 22.4), P(580, 447, 22.6), P(548, 458, 22.8), P(515, 476, 23)], r: [0.04, 0.012], level: 1 },
      { pts: [P(608, 446, 22.4), P(640, 425, 22.3), P(672, 412, 22.2), P(708, 405, 22.1)], r: [0.035, 0.01], level: 1 },
      { pts: [P(612, 490, 22.4), P(650, 478, 22.3), P(695, 462, 22.2), P(730, 455, 22)], r: [0.03, 0.01], level: 1 },
      { pts: [P(610, 505, 22.4), P(572, 500, 22.6), P(530, 502, 22.8), P(478, 510, 23)], r: [0.03, 0.01], level: 1 },
      // dead limb lying on the ground
      { pts: [G(662, 547, 0.12), G(620, 543, 0.15), G(580, 538, 0.12), G(548, 534, 0.1)], r: [0.06, 0.02], level: 1, dead: true },
    ],
    blobs: [
      // (r4: more, smaller streaky sprays - ref: ~10 golden-tipped sprays at rows 383-437 over a broad
      // darker grey-olive layer at rows 430-490, x 620-735; not a few round tan puffs)
      { c: [668, 414], d: 22.2, rx: 46, ry: 20, rz: 0.6, n: 28, size: [0.26, 0.44], pal: 'A', layer: true },
      { c: [560, 465], d: 22.8, rx: 32, ry: 20, rz: 0.5, n: 29, size: [0.26, 0.44], pal: 'A', layer: true },
      { c: [640, 472], d: 22.5, rx: 45, ry: 20, rz: 0.5, n: 61, size: [0.26, 0.44], pal: 'A', layer: true, low: true },
      { c: [708, 455], d: 22.1, rx: 30, ry: 11, rz: 0.4, n: 14, size: [0.26, 0.44], pal: 'A', layer: true },
      { c: [702, 478], d: 22.2, rx: 40, ry: 22, rz: 0.4, n: 54, size: [0.26, 0.44], pal: 'A', layer: true, low: true },
      { c: [750, 490], d: 22.0, rx: 32, ry: 20, rz: 0.4, n: 29, size: [0.26, 0.44], pal: 'A', layer: true, low: true },
      { c: [505, 528], d: 23, rx: 38, ry: 15, rz: 0.4, n: 20, size: [0.26, 0.44], pal: 'A', layer: true },
    ],
  });
  // Tree E (off-frame left, 3 m from the camera): a pendulous branch with wind-streamed sprays whipping in
  // and out of the left frame edge. The upper mass is just outside the base framing (revealed by the pan).
  trees.push({
    name: 'E', flex: 0.55,
    limbs: [
      { pts: [P(-560, 528, 3.7), P(-320, 478, 3.4), P(-160, 448, 3.25), P(-40, 428, 3.12), P(25, 436, 3.05)], r: [0.008, 0.0015], level: 1, radial: 4 }, // (r4b: ends inside the upper tuft)
      { pts: [P(-50, 426, 3.12), P(-46, 450, 3.1), P(-40, 469, 3.07), P(-30, 481, 3.05)], r: [0.004, 0.0015], level: 2, radial: 3 },
    ],
    blobs: [
      // (r5: two broad, soft lobes of drooping combed tufts reaching x ~75 / rows 410-460 and 480-525 at t 0.5
      // (ref), not a few separate compact clumps)
      { c: [-36, 410], d: 3.1, rx: 50, ry: 6, rz: 0.08, n: 11, size: [0.13, 0.19], pal: 'E', hang: true, limb: 0, rollOff: -14 }, // (lobes continue past the frame edge: the pan reveals more, ref)
      { c: [-20, 488], d: 3.05, rx: 46, ry: 8, rz: 0.08, n: 11, size: [0.14, 0.2], pal: 'E', hang: true, limb: 1 },
      { c: [-150, 466], d: 3.25, rx: 45, ry: 18, rz: 0.1, n: 5, size: [0.16, 0.22], pal: 'E', hang: true, limb: 0 },
    ],
  });

  // ---- build skeletons -------------------------------------------------------------------------
  const branches = [];
  const cards = []; // {anchor, right, up, w, h, variant, color, normal, wind: branch/idx}
  const crowns = []; // foliage ellipsoids (for hiding twigs inside the crowns)
  const toCam = new THREE.Vector3();
  // unit direction from a point toward the reference eye
  const toEyeDir = (p) => eye.clone().sub(p).normalize();

  const nearestPoint = (list, p, filter) => {
    let best = null, bi = 0, bd = Infinity;
    for (const b of list) {
      if (filter && !filter(b)) continue;
      for (let i = 0; i < b.pts.length; i++) {
        const d = b.pts[i].distanceToSquared(p);
        if (d < bd) { bd = d; best = b; bi = i; }
      }
    }
    return { b: best, i: bi, d: Math.sqrt(bd) };
  };

  for (let ti = 0; ti < trees.length; ti++) {
    const T = trees[ti];
    const trng = mulberry32(1000 + ti * 77);
    const own = [];
    const limbs = [];
    for (const L of T.limbs) {
      const isE = T.name === 'E';
      const pts = kinkedPath(THREE, L.pts, isE ? 0.08 : L.level === 0 ? 0.5 : 0.42, isE ? 6 : L.kink ?? 18, trng);
      // thick over most of the length (ground limbs stay 5-8 px wide at 13-15 m), thinning at the end
      const b = new Branch(pts, taper(pts.length, L.r[0], L.r[1], L.tp ?? (isE ? 0.8 : 1.3)), L.level, {
        dead: L.dead, radial: L.radial ?? (L.r[0] > 0.1 ? 7 : L.r[0] > 0.05 ? 6 : 5), tree: ti, flex: T.flex,
      });
      // attach to the nearest earlier limb (for continuous wind), trunks stand alone
      let parent = null, pi = 0;
      if (L.level > 0 && limbs.length) {
        const np = nearestPoint(limbs, pts[0]);
        if (np.d < 0.6) { parent = np.b; pi = np.i; }
      }
      finalizeBranch(b, parent, pi, trng);
      b.flex = T.flex;
      b.handPlaced = true;
      limbs.push(b);
      own.push(b);
    }
    // bare twig network along limbs (not for the close-up branch E)
    if (T.name !== 'E') {
      const sp = [];
      for (const b of limbs) {
        sprout(THREE, b, trng, {
          lean, minS: [0.15, 0.1, 0.1], prob: T.name === 'A' ? [0.6 * density + 0.05, 0.3] : [0.55 * density + 0.1, 0.45, 0.3], deadProb: 0.4, rise: 0.12, maxR: 0.045, lenK: 0.9,
          ground: (x, z) => layout.heightAt(x, z),
        }, sp);
      }
      own.push(...sp);
      // screen of fine, grey, upright dead twigs rising 0.4-1.4 m above the low limbs (ref y 440-560)
      if (T.name === 'B' || T.name === 'A') {
        const want = Math.round((T.name === 'B' ? 40 : 12) * density);
        const low = limbs.filter((b) => b.pts.some((p) => p.y - layout.heightAt(p.x, p.z) < 1.6));
        const scr = new THREE.Vector3();
        let made = 0;
        for (let tries = 0; tries < want * 6 && made < want && low.length; tries++) {
          const b = low[Math.floor(trng() * low.length)];
          const i = 1 + Math.floor(trng() * (b.pts.length - 2));
          const p0 = b.pts[i];
          if (p0.y - layout.heightAt(p0.x, p0.z) > 1.8) continue;
          scr.copy(p0).project(refCam);
          const px = (scr.x + 1) * 0.5 * REF_W;
          if (px < 480 || px > 1150) continue;
          const tilt = (25 + 40 * trng()) * DEG;
          const side = (trng() - 0.5) * 0.7;
          const dir = new THREE.Vector3(0, Math.cos(tilt), 0).addScaledVector(lean, Math.sin(tilt) * (trng() < 0.8 ? 1 : -0.6)).add(new THREE.Vector3(-lean.z * side, 0, lean.x * side)).normalize();
          const len = 0.4 + 1.0 * trng();
          const pts = growTwig(THREE, p0.clone(), dir, len, Math.max(0.1, len / (3 + Math.floor(trng() * 3))), trng, { lean, leanK: 0.03, gravity: -0.02, wobbleDeg: 32 });
          const tw = new Branch(pts, taper(pts.length, 0.007, 0.002), 3, { dead: true, radial: 3, tree: ti });
          tw.screen = true;
          finalizeBranch(tw, b, i, trng);
          own.push(tw);
          made++;
          // one or two forks
          for (let fk = 0, nf = 1 + Math.floor(trng() * 2.6); fk < nf; fk++) {
            const j = 1 + Math.floor(trng() * (pts.length - 1));
            const d2 = dir.clone().add(new THREE.Vector3((trng() - 0.5), 0.3, (trng() - 0.5))).normalize();
            const p2 = growTwig(THREE, pts[j].clone(), d2, len * 0.5, Math.max(0.1, len / 6), trng, { lean, leanK: 0.04, gravity: 0.0, wobbleDeg: 25 });
            const f = new Branch(p2, taper(p2.length, 0.0045, 0.002), 3, { dead: true, radial: 3, tree: ti });
            f.screen = true;
            finalizeBranch(f, tw, j, trng);
            own.push(f);
          }
        }
      }
    }
    // crown branches + tufts
    for (let bi = 0; bi < T.blobs.length; bi++) {
      const Bl = T.blobs[bi];
      // (r4b) every foliage mass has its own RNG: editing one mass no longer reshuffles the others
      const trng = mulberry32(9000 + ti * 101 + bi * 7 + (Bl.seed ?? 0) * 1013);
      const isE = T.name === 'E';
      // many small wide spray cards (2:1) build a continuous, streaky crown mass
      const n = Math.max(2, Math.round(Bl.n * (isE ? 1 : density * (Bl.layer ? 2.15 : /^shade/.test(Bl.pal) ? 1.5 : 2.1) * (T.name === 'C' ? 1.25 : T.name === 'B' ? 1.1 : 1)))); // (r5: C x1.25 / B x1.1: the feathered combed tufts cover less, ref C coverage 0.61-0.65) // (r5: tree A 2.4 -> 2.15: ref A foliage coverage ~0.07 in its box, ours was 0.15)
      const c = P(Bl.c[0], Bl.c[1], Bl.d);
      const mpp = Bl.d / FPX; // metres per px
      const rx = Bl.rx * mpp, ry = Bl.ry * mpp, rz = Bl.rz;
      const alive = (b) => !b.dead && b.level <= 1;
      const crown = [];
      const blobPh = trng() * 6.283; // one shared crown-sway phase per foliage mass
      if (!Bl.hang) {
        crowns.push({ c, rx, ry, rz: Math.max(rz, 0.05), tree: ti });
        const k = 2 + Math.floor(trng() * 3);
        for (let j = 0; j < k; j++) {
          const target = c.clone().add(new THREE.Vector3((trng() - 0.5) * 1.5 * rx, (trng() - 0.4) * 1.3 * ry, (trng() - 0.5) * 1.4 * rz));
          const np = nearestPoint(limbs, target, alive);
          if (!np.b) continue;
          const mid = np.b.pts[np.i].clone().lerp(target, 0.5);
          mid.y += 0.15 * np.b.pts[np.i].distanceTo(target);
          const pts = kinkedPath(THREE, [np.b.pts[np.i].clone(), mid, target], 0.35, 18, trng);
          const r0 = Math.min(np.b.rad[np.i] * 0.7, 0.04);
          const cb = new Branch(pts, taper(pts.length, r0, 0.006), 2, { radial: 4, tree: ti });
          finalizeBranch(cb, np.b, np.i, trng);
          crown.push(cb);
          own.push(cb);
        }
      }
      const hosts = Bl.hang ? [limbs[Bl.limb]] : crown.length ? crown.concat(limbs.filter(alive)) : limbs.filter(alive);
      const scr = new THREE.Vector3();
      // Clumps: the reference crowns are lumps of ~40-60 px (1-1.5 m) of sprays, each lit on its upper /
      // sun side and self-shadowed underneath, with dark gaps between them. Tufts are scattered around
      // clump centres (inside the noise-shaped crown silhouette); each clump has its own light level and
      // hue (sunlit golden-yellow vs greyer olive).
      const clumps = [];
      if (!Bl.hang) {
        const nCl = Math.max(2, Math.round(Bl.rx * Bl.ry / (Bl.layer ? 250 : 400)));
        const minD = Bl.layer ? 15 : 20; // px between clump centres
        for (let tries = 0; clumps.length < nCl && tries < nCl * 40; tries++) {
          const u = new THREE.Vector3(trng() * 2 - 1, trng() * 2 - 1, trng() * 2 - 1);
          const l = u.length();
          if (l > 0.92) continue;
          const nz = fbm2(u.x * 2.3 + ti * 7, u.y * 2.3 + Bl.c[0] * 0.01, 3);
          if (l > 0.5 + 0.6 * nz) continue;
          if (clumps.some((c2) => Math.hypot((c2.u.x - u.x) * Bl.rx, (c2.u.y - u.y) * Bl.ry) < minD * (tries > nCl * 20 ? 0.6 : 1))) continue;
          clumps.push({ u, light: T.name === 'B' ? 0.85 + 0.26 * trng() : 0.8 + 0.36 * trng(), hue: trng() * 2 - 1, hue2: trng() * 2 - 1 }); // (r4b: B narrower - its darks ~10 % low / lights ~5 % high vs ref)
        }
      }
      const sgx = (Bl.layer ? 19 : 24) / Bl.rx, sgy = (Bl.layer ? 6 : 13) / Bl.ry; // clump extent (px -> unit ellipsoid)
      const gauss = () => (trng() + trng() + trng() - 1.5) * 1.15;
      for (let j = 0; j < n; j++) {
        // tuft position: shell-biased sample in the ellipsoid, silhouette roughened with noise, flat-ish
        // bottom with a few hanging streamers, and screen-space holes (sea/sky gaps through the crown)
        let q = null, uy = 0, hangTuft = false, clump = null, cyN = 0, cxN = 0;
        for (let tries = 0; tries < 14; tries++) {
          let u, cl = null, gx = 0, gy = 0;
          if (clumps.length) {
            cl = clumps[Math.floor(trng() * clumps.length)];
            gx = gauss(); gy = gauss();
            u = new THREE.Vector3(cl.u.x + gx * sgx, cl.u.y + gy * sgy, cl.u.z + gauss() * 0.35);
            if (u.length() > 1.12) continue;
          } else {
            u = new THREE.Vector3(trng() * 2 - 1, trng() * 2 - 1, trng() * 2 - 1);
            const l = u.length();
            if (l > 1 || l < 0.05) continue;
            const nz = fbm2(u.x * 2.3 + ti * 7 + j * 0.01, u.y * 2.3 + Bl.c[0] * 0.01, 3);
            if (l > 0.55 + 0.6 * nz) continue;
          }
          let hangT = false;
          if (!Bl.hang && !Bl.layer && u.y < 0 && u.y >= -0.5 && trng() < 0.15) continue;
          if (!Bl.hang && !Bl.layer && u.y < -0.5) {
            if (trng() > 0.72) continue; // ragged hanging bottom: streamers with ~50 % gaps (ref rows 440-485)
            hangT = true;
          }
          const cand = c.clone().add(new THREE.Vector3(u.x * rx, u.y * ry, u.z * rz));
          if (!Bl.hang) {
            scr.copy(cand).project(refCam);
            const px = (scr.x + 1) * 0.5 * REF_W, py = (1 - scr.y) * 0.5 * REF_H;
            // (r4b: offsets chosen so the carved gaps fall where the reference crowns have gaps)
            const hole = fbm2(px / 24 + (ti === 0 ? 34.357 : ti === 1 ? 79.855 : ti * 3.1), py / 24 + (ti === 0 ? 14.865 : 5.3), 3);
            if (hole < (Bl.layer ? 0.3 : 0.3 - 0.1 * (1 - smoothstep(0.55, 0.95, u.length())))) continue;
          }
          q = cand; uy = u.y; hangTuft = hangT; clump = cl; cyN = gy; cxN = gx;
          break;
        }
        if (!q) continue;
        let anchor, host;
        if (Bl.hang) {
          // tufts hang from nodes of the pendulous branch
          const np = nearestPoint(hosts, q);
          host = { b: np.b, i: np.i };
          anchor = np.b.pts[np.i].clone();
          // short drooping twig from the node down to the tuft
          const tw = [anchor.clone(), anchor.clone().lerp(q, 0.5).add(new THREE.Vector3(0.01, -0.01, 0)), q.clone()];
          const twig = new Branch(tw, [0.0035, 0.0025, 0.002], 3, { radial: 3, tree: ti });
          finalizeBranch(twig, np.b, np.i, trng);
          own.push(twig);
          host = { b: twig, i: 2 };
          anchor = q;
          // Close-up (3 m) branchlet threads: at this distance the video resolves individual drooping,
          // 1-3 px wide she-oak branchlets, so each node also hangs a bunch of real thread geometry
          // (camera-facing 3-segment ribbons in the branch mesh, alpha-to-coverage below 1 px). Threads
          // of a node share its sway phase (coherent spray motion) and their tips swing wider (w2 > 1).
          if (eThreads > 0) {
            const er = mulberry32(5150 + j * 131 + Math.round(Bl.c[0] * 7));
            const nth = Math.round(eThreads);
            const rightV = new THREE.Vector3(1, 0, 0), downV = new THREE.Vector3(0, -1, 0);
            for (let t2 = 0; t2 < nth; t2++) {
              const st = q.clone().add(new THREE.Vector3((er() - 0.3) * 0.08, (er() - 0.5) * 0.04, (er() - 0.5) * 0.06));
              const ang = (8 + 30 * er()) * DEG; // streaming downwind (screen right) and down
              const L = 0.025 + 0.03 * er(); // 8-18 px on screen at 3 m, inside the tuft (ref: compact tufts)
              const d0 = rightV.clone().multiplyScalar(Math.cos(ang)).addScaledVector(downV, Math.sin(ang)).add(new THREE.Vector3(0, 0, (er() - 0.5) * 0.6)).normalize();
              const bend = rightV.clone().multiplyScalar(0.3 + 0.3 * er()).addScaledVector(downV, 0.1 + 0.18 * er());
              const pts = [];
              for (let u = 0; u <= 3; u++) { const f = u / 3; pts.push(st.clone().addScaledVector(d0, f * L).addScaledVector(bend, f * f * L)); }
              const th = new Branch(pts, [0.00055, 0.0005, 0.00045, 0.0003], 3, { radial: 2, tree: ti }); // ~50 % coverage (widened to 1 px, alpha-to-coverage)
              finalizeBranch(th, twig, 2, er);
              th.flex = T.flex;
              th.faceCam = eye;
              th.thread = true;
              th.ph[2] = twig.ph[2] + (er() - 0.5) * 0.4;
              th.w = th.w.map((w, i) => [w[0], w[1], 1 + 0.2 * th.s[i]]); // (tips swing a little wider; more stretched them into a hanging curtain)
              // golden sunlit threads over darker olive inner ones (ref sRGB ~(150,135,85) +-12 %)
              // (fewer, less dark inner threads: the out-of-focus tufts read soft, ref hp contrast ~0.7x ours)
              const dark = er() < 0.3;
              const l = (dark ? 0.66 : 1.0) * (0.88 + 0.24 * er());
              th.color = dark ? [0.44 * l, 0.37 * l, 0.12 * l] : [0.70 * l, 0.56 * l, 0.16 * l];
              th.shade = [0.85, 0.95, 1.05, 1.12];
              own.push(th);
            }
          }
        } else {
          const np = nearestPoint(hosts, q);
          const start = np.b.pts[np.i].clone();
          const dist = start.distanceTo(q);
          if (dist > 0.12) {
            const tw = growTwig(THREE, start, q.clone().sub(start), dist, Math.max(0.12, dist / 3), trng, { lean, leanK: 0.02, gravity: -0.03, wobbleDeg: 12 });
            tw[tw.length - 1].copy(q);
            const twig = new Branch(tw, taper(tw.length, Math.min(0.012, np.b.rad[np.i] * 0.6), 0.003), 3, { radial: 3, tree: ti });
            finalizeBranch(twig, np.b, np.i, trng);
            twig.inCrown = true; // (r4b: never drawn - wind host only; the tufts cover their ends, ref shows no dark twig fans)
            host = { b: twig, i: tw.length - 1 };
          } else host = { b: np.b, i: np.i };
          anchor = q;
        }
        // cards for this tuft
        const outward = q.clone().sub(c).divide(new THREE.Vector3(rx, ry, Math.max(rz, 1e-3)));
        const odist = Math.min(1, outward.length());
        const rim = !Bl.hang && !Bl.layer && odist > 0.78;
        if (rim && trng() < 0.4) continue; // sparse, see-through rims
        const ncards = isE ? 2 : 1 + (trng() < (Bl.layer ? 0.5 : odist < 0.7 ? 0.55 : 0.3) ? 1 : 0); // denser crown cores / tree A masses (ref)
        const pal = PAL[Bl.low ? 'Alow' : Bl.pal];
        const palCol = new THREE.Color(pal[Math.floor(trng() * pal.length)]);
        for (let k = 0; k < ncards; k++) {
          let vset;
          const vr = trng();
          if (Bl.hang) vset = VARIANT_SETS.tassel; // (r5) curtains: wide fans of long drooping branchlets (ref E lobes)
          else if (hangTuft) vset = vr < 0.75 ? VARIANT_SETS.streamer : VARIANT_SETS.spray;
          else if (Bl.layer) vset = vr < 0.45 ? VARIANT_SETS.wisp : VARIANT_SETS.spray; // (r5: 0.3 -> 0.45, sparser see-through sprays) // small see-through tassel sprays strung along tree A's limbs (ref: many with golden downwind tips)
          else if (rim) vset = vr < 0.2 ? VARIANT_SETS.streamer : VARIANT_SETS.spray;
          else vset = vr < 0.2 ? VARIANT_SETS.puff : VARIANT_SETS.spray; // some round clumps among the streaks
          const variant = vset[Math.floor(trng() * vset.length)];
          // (tree A: smaller separate sprays with gaps between them, not continuous sheets - ref)
          const sK = isE ? 1 : (variantAspect(variant) > 1 ? 1.2 : 0.95) * tierSize * (Bl.layer ? 0.95 : 1); // fewer, larger cards on lower tiers
          const s = (Bl.size[0] + (Bl.size[1] - Bl.size[0]) * trng() * (k ? 0.7 : 1)) * (rim ? 0.8 : hangTuft ? 1.3 : 1) * sK * (isE ? 1 : 0.8 + 0.5 * trng() * trng());
          // spray-to-spray light variation (ref: bright sprays over darker olive)
          // Sun at 7 deg, front-right: crowns are evenly lit top to bottom (ref: flat band means), the
          // sun-facing (right / far) side and thin rims brighter, the deep core a little darker. One
          // continuous field at the anchor (neighbouring cards share it: no per-card seams) + mild
          // per-clump and per-spray mottling.
          let pj, sunTuft = false, inW = 0;
          if (Bl.hang) pj = 0.94 + 0.12 * trng();
          else {
            const e3 = anchor.clone().sub(c).divide(new THREE.Vector3(rx, ry, Math.max(rz, 0.05)));
            const rr = e3.length();
            const sunSide = smoothstep(-0.4, 0.8, e3.dot(SUN_FLAT) / Math.max(rr, 1e-3));
            const cn = fbm2(anchor.x / 0.6 + anchor.z / 0.9 + ti * 3.3, anchor.y / 0.6 - anchor.z / 1.1, 2);
            pj = (0.83 + 0.16 * sunSide) * (0.8 + 0.2 * smoothstep(0.3, 0.9, rr)) * (1 + 0.16 * (cn - 0.5));
            pj *= (clump ? clump.light : 1) * (0.95 + 0.1 * trng()) * 1.27; // (x1.27: calibrated after the card normals went camera-facing)
            // each clump is a lump lit on its upper / sun-side (right) flank and self-shadowed under it
            // (ref: 25-55 px lumps, golden tops over darker olive undersides; the crown as a whole stays
            // evenly lit): the tuft's gaussian offset inside its clump drives it
            if (clump) {
              const lg = Math.max(-1.3, Math.min(1.3, 1.1 * cyN + 0.6 * cxN));
              pj *= 1 + (Bl.layer ? 0.3 : 0.15) * lg;
              if (lg < -0.4) inW = Math.max(inW, 0.5 * smoothstep(-0.4, -1.2, lg));
            }
            // about half of the outer sun-side sprays are directly sunlit: brighter, yellow-green golden
            // tufts on the crowns' right / upper-right edges (ref crown C, B top)
            const hh = Math.abs(Math.sin(anchor.x * 12.9898 + anchor.y * 78.233 + anchor.z * 37.719) * 43758.5453) % 1;
            if (!Bl.layer && sunSide > 0.55 && rr > 0.68 && hh < 0.5) { pj *= T.name === 'B' ? 1.12 : 1.17; sunTuft = true; }
            // (r4b) tree A: golden downwind spray tips on dark olive bodies (ref)
            if (Bl.layer && !Bl.low && cxN > 0.45 && hh < 0.65) { pj *= 1.22; sunTuft = true; }
            // lower / deep interior: darker yellow-green olive, not beige (ref crown B/C cores, tree A masses)
            inW = Math.max(inW, (1 - smoothstep(0.45, 0.95, rr)) * (0.45 + 0.55 * smoothstep(0.25, -0.6, e3.y)) * (1 - 0.5 * sunSide));
            if (Bl.layer) inW = Math.max(inW, (Bl.low ? 0.45 : 0.35) + 0.35 * smoothstep(0.3, -0.6, e3.y));
            if (Bl.low) pj *= 0.88; // (r5: 0.8 -> 0.88) (r4) tree A's lower spray layer: darker grey-olive (ref)
            // (r4) sprays at the back of a crown sit in the shadow of the front lumps: darker, greyer olive,
            // so the gaps between the front lumps read as dark interior (ref), not as flat mid-tone
            if (!Bl.layer) {
              const dz = anchor.clone().sub(c).dot(toEyeDir(c)) / Math.max(rz, 0.05); // > 0: toward the camera
              const back = smoothstep(0.1, -0.85, dz);
              pj *= 1 - 0.05 * back;
              inW = Math.max(inW, 0.7 * back);
            }
          }
          const baseCol = palCol.clone();
          // (r4b: x3 at clump level - overlapping cards averaged the old +-5 % away; ref hue spread at
          // lump scale ~3 deg, p10-p90 34-46 deg: some lumps olive-green, some brown-golden)
          if (clump) { baseCol.r *= 1 + 0.07 * clump.hue; baseCol.g *= 1 + 0.06 * clump.hue2; baseCol.b *= 1 - 0.16 * clump.hue; } // (r4 hue2: yellow-green vs browner lumps, ref hue p10-p90 34-46 deg)
          if (sunTuft) { baseCol.g *= 1.06; baseCol.b *= 0.8; } // (r4b: ref sunlit sprays bright golden-yellow, hue ~46-50)
          // shaded interior: darker, and a little greyer / browner (ref shade p20 (94,84,62), hue ~40 deg
          // like the lit sprays: not greener)
          if (!Bl.hang) { baseCol.b *= 0.94; baseCol.r *= 1 - 0.05 * inW; baseCol.g *= 1 - 0.04 * inW; baseCol.b *= 1 + 0.2 * inW; } // (r4: ref shade b/r ~0.75, s ~0.25)
          baseCol.multiplyScalar(ATLAS_GAIN * (T.name === 'B' ? 0.91 : T.name === 'E' ? 0.97 : T.name === 'A' ? 1.65 : 0.99)); // (r5: B/C +6 %: the combed atlas' mean normalisation shifted; A: sparser wisps, ref A foliage p50 97 vs ours 73) // E: sunlit golden sprays (ref #A29054); A: backlit sparse layers (r4: darker olive bases under golden tips)
          baseCol.r *= Math.pow(pj, 1.25); baseCol.g *= pj; baseCol.b *= Math.pow(pj, 0.85);
          baseCol.r *= FOLIAGE_TINT[0]; baseCol.g *= FOLIAGE_TINT[1]; baseCol.b *= FOLIAGE_TINT[2] * (T.name === 'B' ? 1.13 : 1);
          if (T.name === 'B') baseCol.g *= 1.025; // (r4b: ref B hue p50 40 deg)
          const off = k ? new THREE.Vector3((trng() - 0.4) * s * (isE ? 0.22 : 0.6), (trng() - 0.55) * s * 0.3, (trng() - 0.5) * (isE ? 0.05 : 0.2)) : new THREE.Vector3();
          cards.push({
            anchor: anchor.clone().add(off), size: s, variant, color: baseCol,
            roll: (Bl.hang ? (-12 + 22 * trng() + (Bl.rollOff ?? 0)) /* (r5: curtains hang 10-50 deg like the ref E strands) */ : hangTuft ? (12 + 25 * trng()) : rim || Bl.layer ? (-38 + 72 * trng()) : (-58 + 112 * trng())) * DEG, yaw: (trng() - 0.5) * 60 * DEG, // (r5: wider roll: ref streak orientations are near-uniform, |angle| > 60 deg ~22 %)
            outward: outward.normalize(), host, flex: T.flex, seed: trng(), blobPh: Bl.hang ? null : blobPh, uy,
            // the tuft's clump (lump) centre + its horizontal scale (m): lump shading / fuzzy lump edges
            lump: clump ? { c: c.clone().add(new THREE.Vector3(clump.u.x * rx, clump.u.y * ry, clump.u.z * Math.max(rz, 0.05))), R: (Bl.layer ? -22 : 24) * mpp * (hangTuft ? 1.6 : 1) } : null, // (hanging streamers reach further)
            crown: { c, rx, ry, rz: Math.max(rz, 0.05), hang: !!Bl.hang, clump: !!Bl.layer },
            calm: T.name === 'B' || T.name === 'A', // (r5: + A, ref A almost still: 0.15 px/frame vs ours 0.26) (r4b) ref crown B's spray-level motion at calm camera ~half ours (flow, t 12.4)
          });
        }
      }
    }
    for (const b of own) branches.push(b);
    ctx.progress?.(0.15 + 0.5 * (ti + 1) / trees.length, 'She-oaks');
    await new Promise((r) => setTimeout(r, 0));
  }

  // ---- hide crown-interior wood ----------------------------------------------------------------
  // Crown branches / twigs / sprouts inside a foliage mass are hidden by the needles in the reference:
  // cut every generated (not hand-placed) branch into the runs of points outside the crown cores (r > 0.8), keeping one
  // point of overlap so a twig still visibly enters the foliage.
  // screen-space crown ellipses (reference camera): generated twigs must not run IN FRONT of the lit
  // foliage (they drew black lines across crown B); inside the crowns (r 0.55-0.8) they stay, as faint
  // grey wood seen through the see-through sprays (ref crown C)
  const scrC = new THREE.Vector3();
  for (const cr of crowns) {
    scrC.copy(cr.c).project(refCam);
    cr.sx = (scrC.x + 1) * 0.5 * REF_W; cr.sy = (1 - scrC.y) * 0.5 * REF_H;
    const dC = cr.c.distanceTo(eye);
    cr.srx = cr.rx / dC * FPX; cr.sry = cr.ry / dC * FPX; cr.dist = dC;
  }
  const inCrown = (p, r2, front) => {
    for (const cr of crowns) {
      const ex = (p.x - cr.c.x) / cr.rx, ey = (p.y - cr.c.y) / cr.ry, ez = (p.z - cr.c.z) / cr.rz;
      if (ex * ex + ey * ey + ez * ez < r2) return true;
      if (front) {
        scrC.copy(p).project(refCam);
        const qx = ((scrC.x + 1) * 0.5 * REF_W - cr.sx) / (0.85 * cr.srx), qy = ((1 - scrC.y) * 0.5 * REF_H - cr.sy) / (0.85 * cr.sry);
        const dp = p.distanceTo(eye);
        if (qx * qx + qy * qy < 1 && dp < cr.dist - 0.35 * cr.rz && dp > cr.dist - 2.2 * cr.rz) return true;
      }
    }
    return false;
  };
  // generated wood above the upper part of a B/C crown (screen space, any depth)
  const aboveCrown = (p) => {
    scrC.copy(p).project(refCam);
    const px = (scrC.x + 1) * 0.5 * REF_W, py = (1 - scrC.y) * 0.5 * REF_H;
    for (const cr of crowns) {
      if (cr.tree > 1) continue;
      if (Math.abs(px - cr.sx) < 0.9 * cr.srx && py < cr.sy - 0.4 * cr.sry && py > cr.sy - 2.2 * cr.sry) return true;
    }
    return false;
  };
  const visibleBranches = [];
  for (const b of branches) {
    // (r4b) branch E's wood is hidden in / behind its out-of-focus tufts in the ref: it drew a straight dark
    // stick through and past them (kept as the wind host of the tufts)
    if (b.tree === 3) { if (b.thread) visibleBranches.push(b); continue; }
    if (b.screen) { visibleBranches.push(b); continue; }
    // hand-placed limbs stay visible where they enter a crown, only the deep core hides them
    // (r4: generated twigs are hidden deeper (r < 0.71): with the denser, modelled lumps they drew black
    // twig fans across crown B, where the ref shows only a few thin grey twigs)
    // (r4b: crowns B/C hide their wood deeper (generated r < 0.89, limbs r < 0.67) and no generated wood
    // may stick out above a crown top: it drew near-black sticks / twig 'spiders' over and above crown B,
    // where the ref shows only faint grey 1 px twigs)
    const bc = b.tree === 0 || b.tree === 1;
    const r2 = b.handPlaced ? (bc ? 0.45 : 0.3) : (bc ? 0.8 : 0.5);
    const inside = b.pts.map((p) => inCrown(p, r2, !b.handPlaced) || (bc && !b.handPlaced && aboveCrown(p)));
    if (!inside.some((v) => v)) { visibleBranches.push(b); continue; }
    let i = 0;
    const n = b.pts.length;
    while (i < n) {
      while (i < n && inside[i]) i++;
      if (i >= n) break;
      let j = i;
      while (j < n && !inside[j]) j++;
      const a0 = Math.max(0, i - 1), a1 = Math.min(n - 1, j); // one point of overlap on each side
      if (a1 - a0 >= 1) {
        const sub = Object.assign(Object.create(Object.getPrototypeOf(b)), b);
        sub.pts = b.pts.slice(a0, a1 + 1); sub.rad = b.rad.slice(a0, a1 + 1);
        sub.w = b.w.slice(a0, a1 + 1); sub.s = b.s.slice(a0, a1 + 1);
        visibleBranches.push(sub);
      }
      i = j;
    }
  }

  // ---- gnarled hand-placed limbs ---------------------------------------------------------------
  // (ref: the wood varies in thickness and swells at forks / kinks; constant-radius tubes read as hoses)
  // every segment is split in two (the path stays angular) and the radius gets +-22 % noise at a
  // 0.3-0.7 m wavelength plus a swelling at each kink; a separate RNG keeps the skeletons unchanged.
  {
    const V3 = THREE.Vector3;
    const a = new V3(), b2 = new V3();
    for (const b of visibleBranches) {
      if (!b.handPlaced || b.tree === 3 || b.pts.length < 2) continue;
      const n = b.pts.length;
      const pts = [], rad = [], w = [], sArr = [];
      const seed = (b.ph[0] * 7.1 + b.pts[0].x * 0.37) % 50;
      for (let i = 0; i < n; i++) {
        let sw = 1;
        if (i > 0 && i < n - 1) {
          a.subVectors(b.pts[i], b.pts[i - 1]).normalize(); b2.subVectors(b.pts[i + 1], b.pts[i]).normalize();
          sw = 1 + 0.28 * Math.min(1, Math.acos(Math.max(-1, Math.min(1, a.dot(b2)))) / (25 * DEG));
        }
        pts.push(b.pts[i].clone()); rad.push(b.rad[i] * sw); w.push(b.w[i].slice()); sArr.push(b.s[i]);
        if (i < n - 1) {
          pts.push(b.pts[i].clone().lerp(b.pts[i + 1], 0.5)); rad.push(0.5 * (b.rad[i] + b.rad[i + 1]));
          w.push(b.w[i].map((x, k) => 0.5 * (x + b.w[i + 1][k]))); sArr.push(0.5 * (b.s[i] + b.s[i + 1]));
        }
      }
      let acc = 0;
      for (let i = 0; i < pts.length; i++) {
        if (i) acc += pts[i].distanceTo(pts[i - 1]);
        const nz = fbm2(acc / 0.5 + seed, seed * 0.7, 2) * 2 - 1;
        rad[i] *= Math.max(0.75, 1 + 0.3 * nz);
      }
      b.pts = pts; b.rad = rad; b.w = w; b.s = sArr;
      b.radial = Math.max(b.radial, 5);
    }
  }

  // ---- branch mesh -----------------------------------------------------------------------------
  // the sky IBL is cyan: bark albedos are pre-tinted warm so rendered bark stays neutral dark grey;
  // dead limbs are weathered silver-grey, fine twigs lighter grey (ref: never black, mid-grey against
  // the sea: their true sub-pixel coverage goes out as alpha-to-coverage)
  const barkLive = lin('#584f44'), barkDead = lin('#7a7268'), barkE = lin('#7a7060'), barkScreen = lin('#8c8880');
  const barkTwig = lin('#8a8172'), barkCrown = lin('#6a6256'), barkA = lin('#6e6558');
  // (r4b) needle veil: wood seen inside / behind the foliage (ellipsoid r < 1.3) is overlaid by the
  // semi-transparent needles - soft olive-grey, never near-black (ref crown interiors >= ~(80,70,42))
  const veilAt = (p) => {
    let v = 0;
    for (const cr of crowns) {
      if (cr.tree > 2) continue;
      const ex = (p.x - cr.c.x) / cr.rx, ey = (p.y - cr.c.y) / cr.ry, ez = (p.z - cr.c.z) / cr.rz;
      v = Math.max(v, 1 - smoothstep(0.75, 1.3, Math.sqrt(ex * ex + ey * ey + ez * ez)));
    }
    return v;
  };
  const branchGeo = buildTubes(THREE, visibleBranches, (b) => {
    if (b.thread) return b.color;
    if (b.tree === 3) return barkE;
    if (b.screen) return barkScreen;
    if (b.dead) return barkDead;
    if (b.tree === 2 && b.level >= 2) return barkScreen;
    if (b.tree === 2 && b.handPlaced) return barkA; // (r4b: ref tree A trunk mid-grey ~45-65, not black)
    return b.level >= 3 ? barkTwig : b.level === 2 ? barkCrown : barkLive;
  }, (b, i) => (b.tree === 3 ? 0 : veilAt(b.pts[i])));
  const viewPos = { value: eye.clone() };
  const branchMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0, alphaToCoverage: true });
  // bark is matte: suppress the grazing-angle Fresnel sky sheen that turns thin cylinders teal
  patchVegWind(branchMat, 'branch', uniforms, viewPos, (shader) => {
    shader.uniforms.uSunDirB = uniforms.uSunDir;
    shader.uniforms.uSunColB = uniforms.uSunColor;
    shader.uniforms.uFolVeil = { value: new THREE.Vector3(...invAcesSRGB8(92, 80, 54)) };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vBarkUv;\nvarying float vBCov;\nattribute float aVeil;\nvarying float vVeil;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\n  vBarkUv = uv;\n  vVeil = aVeil;')
      // true coverage of a widened sub-pixel twig (1 at >= 1 px)
      .replace('#include <project_vertex>', 'vBCov = clamp(aRad / (max(3.4e-4, 0.5 * uVegPx) * length(position - uViewPos)), 0.12, 1.0);\n#include <project_vertex>');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec2 vBarkUv;
varying float vBCov;
varying float vVeil;
uniform vec3 uFolVeil;
uniform vec3 uSunDirB;
uniform vec3 uSunColB;
float bkHash(vec2 p){ p = fract(p * vec2(234.34, 435.345)); p += dot(p, p + 34.23); return fract(p.x * p.y); }
float bkNoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(bkHash(i), bkHash(i + vec2(1.0, 0.0)), f.x), mix(bkHash(i + vec2(0.0, 1.0)), bkHash(i + vec2(1.0, 1.0)), f.x), f.y); }`)
      // longitudinal furrows + weathered patches (uv.x wraps around the tube, uv.y = metres along it)
      .replace('#include <color_fragment>', `#include <color_fragment>
  if (vBarkUv.x < 5.0) {
    vec2 bu = vec2(fract(vBarkUv.x) * 7.0, vBarkUv.y * 1.6);
    // pixel footprint along the branch (m): fine octaves fade out before they can alias
    float fw = max(fwidth(vBarkUv.y), 1e-4);
    float detail = 1.0 - smoothstep(0.015, 0.09, fw);
    float fur = bkNoise(vec2(bu.x, bu.y)) * 0.65 + bkNoise(vec2(bu.x * 2.0 + 3.1, bu.y * 3.0)) * 0.35;
    // fine fibrous furrows (she-oak bark: finely fissured, stringy)
    float fine = bkNoise(vec2(bu.x * 4.0 + 7.7, bu.y * 11.0));
    fur += (fine - 0.5) * 0.45 * detail;
    float patchN = bkNoise(vec2(vBarkUv.y * 0.35, 1.7));
    // knots / branch scars: dark oval pits with a lighter swollen rim every ~0.8 m (on some)
    float kc = floor(vBarkUv.y * 1.25);
    float kOn = step(0.5, bkHash(vec2(kc, 3.7))) * (1.0 - smoothstep(0.03, 0.14, fw));
    float ky = (fract(vBarkUv.y * 1.25) - 0.2 - 0.6 * bkHash(vec2(kc, 9.1))) / 0.1;
    float kx = (fract(vBarkUv.x - bkHash(vec2(kc, 5.3))) - 0.5) / 0.14;
    float kd = kx * kx + ky * ky;
    float knot = kOn * (1.0 - smoothstep(0.3, 1.0, kd));
    float krim = kOn * smoothstep(0.7, 1.1, kd) * (1.0 - smoothstep(1.1, 2.0, kd));
    // pale grey-green lichen / weathered patches on the upper surfaces
    float lich = smoothstep(0.66, 0.8, bkNoise(vec2(fract(vBarkUv.x) * 5.0 + 11.0, vBarkUv.y * 2.3))) * 0.35;
    diffuseColor.rgb *= (0.72 + 0.56 * fur) * (0.85 + 0.35 * patchN) * (1.0 - 0.5 * knot + 0.15 * krim);
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.32, 0.31, 0.27), lich);
  }
  diffuseColor.a = vBCov * (1.0 - 0.45 * vVeil);`)
      // needle veil: wood inside the crowns is seen through / behind the sprays (soft olive-grey)
      .replace('#include <opaque_fragment>', 'outgoingLight = mix(outgoingLight, uFolVeil, 0.6 * vVeil);\n#include <opaque_fragment>')
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
  {
    // sky-lit top edges, occluded undersides; matte bark (no teal Fresnel sheen)
    vec3 wN = inverseTransformDirection(normal, viewMatrix);
    reflectedLight.indirectDiffuse *= mix(0.62, 1.0, smoothstep(-0.1, 0.7, wN.y));
    reflectedLight.indirectSpecular *= 0.12;
    reflectedLight.directSpecular *= 0.3;
    // low sun from the right: sun-facing bark (limb tops / flanks) catches a golden-grey rim
    float sunFace = smoothstep(0.05, 0.6, dot(wN, normalize(uSunDirB)));
    reflectedLight.directDiffuse *= 1.0 + 0.9 * sunFace;
    // close-up E branchlet threads (uv.x flag): thin translucent needles lit from any side, like the
    // foliage cards (isotropic needle-cloud term, warm transmitted light)
    if (vBarkUv.x > 5.0) {
      reflectedLight.directDiffuse += diffuseColor.rgb * vec3(0.69, 0.6, 0.28) * uSunColB * 1.3 * 0.3183;
      reflectedLight.indirectSpecular *= 0.3;
    }
  }`);
  });
  patchMaterialAtmosphere(branchMat, uniforms);
  branchMat.envMapIntensity = 0.9; // sky-lit tops (undersides damped in the shader)
  const branchMesh = new THREE.Mesh(branchGeo, branchMat);
  branchMesh.castShadow = true;
  branchMesh.receiveShadow = true;
  const branchDepth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  patchVegWind(branchDepth, 'branch', uniforms, viewPos);
  branchMesh.customDepthMaterial = branchDepth;
  branchMesh.name = 'trees-branches';
  branchMesh.renderOrder = -1; // occluders before the terrain / ocean behind them
  scene.add(branchMesh);

  // ---- foliage cards ---------------------------------------------------------------------------
  ctx.progress?.(0.75, 'She-oak needles');
  const atlas = makeTuftAtlas(THREE, 11, { cell: tier === 'high' ? 512 : tier === 'medium' ? 256 : 128 });
  cards.sort((a, b) => b.anchor.distanceToSquared(eye) - a.anchor.distanceToSquared(eye));
  const nc = cards.length;
  const pos = new Float32Array(nc * 4 * 3), nor = new Float32Array(nc * 4 * 3), col = new Float32Array(nc * 4 * 3);
  const uv = new Float32Array(nc * 4 * 2), loc = new Float32Array(nc * 4 * 2), anc = new Float32Array(nc * 4 * 3);
  const w0 = new Float32Array(nc * 4 * 4), w1 = new Float32Array(nc * 4 * 4), csz = new Float32Array(nc * 4), clmp = new Float32Array(nc * 4 * 4);
  const idx = new Uint32Array(nc * 6);
  const up = new THREE.Vector3(), right = new THREE.Vector3(), fwd = new THREE.Vector3(), nrm = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const corners = [[0, 0], [1, 0], [1, 1], [0, 1]];
  // Cards are shrunk to their variant's alpha bounding box (~54 % of an atlas cell on average) plus a
  // margin of 2 px at a 360 px tall view (4 px at 720p: the mip / vTexBias footprint of the blurred
  // fringe, whose smoothstep drops filtered alpha < 0.07), so the rasterised area drops (~14 % of the
  // card pixels) while the image stays the same: position, uv and aLocal are affine over the card, and
  // the vertex colours are re-sampled from the full card's interpolation.
  const pxAng360 = 2 * Math.tan(CONFIG.camera.vfovDeg * DEG / 2) / 360;
  const quad = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const cornerCol = [new THREE.Color(), new THREE.Color(), new THREE.Color(), new THREE.Color()];
  // value at cell-local (x, y) of the full card as rasterised (triangles 0-2-1 and 0-3-2)
  const lerpQuad = (c, x, y) => (x >= y ? c[0] + (c[1] - c[0]) * x + (c[2] - c[1]) * y : c[0] + (c[2] - c[3]) * x + (c[3] - c[0]) * y);
  let areaFull = 0, areaKept = 0;
  for (let i = 0; i < nc; i++) {
    const C = cards[i];
    toCam.subVectors(eye, C.anchor).normalize();
    // card basis facing the reference camera, 'right' = screen right (downwind), rotated by roll/yaw
    right.set(1, 0, 0).addScaledVector(toCam, -toCam.x).normalize();
    up.crossVectors(toCam, right).normalize();
    q.setFromAxisAngle(toCam, -C.roll);
    right.applyQuaternion(q); up.applyQuaternion(q);
    fwd.copy(toCam);
    q.setFromAxisAngle(up, C.yaw);
    right.applyQuaternion(q); fwd.applyQuaternion(q);
    const asp = variantAspect(C.variant), att = variantAttach(C.variant);
    const w = asp > 1 ? C.size * 1.9 : C.size * (C.flex < 1 ? 1.5 : 1.75), h = w / asp;
    // lighting normal: blend of card normal and crown-outward direction (soft volumetric shading);
    // (up-bias: the sun sits right/slightly in front of the camera, so camera-facing tufts get most of
    // their light from the sky dome above; a flat camera-facing normal would leave the crowns murky)
    if (C.crown.hang) nrm.copy(fwd).multiplyScalar(0.6).addScaledVector(C.outward, 0.2).add(new THREE.Vector3(0.3, 0.3, 0)).normalize();
    else nrm.copy(fwd).multiplyScalar(0.6).addScaledVector(new THREE.Vector3(C.outward.x, 0.3 * C.outward.y, C.outward.z), 0.4).normalize();
    const cr = C.crown;
    const vr = variantRect(C.variant);
    const hb = C.host.b, hi = C.host.i;
    const hw = hb.w[hi];
    const bb = variantBounds(atlas, C.variant);
    const dCam = C.anchor.distanceTo(eye);
    const mx = 2 * dCam * pxAng360 / w + 0.01, my = 2 * dCam * pxAng360 / h + 0.01;
    const bx0 = Math.max(0, bb[0] - mx), by0 = Math.max(0, bb[1] - my), bx1 = Math.min(1, bb[2] + mx), by1 = Math.min(1, bb[3] + my);
    corners[0][0] = bx0; corners[0][1] = by0; corners[1][0] = bx1; corners[1][1] = by0;
    corners[2][0] = bx1; corners[2][1] = by1; corners[3][0] = bx0; corners[3][1] = by1;
    const sa = w * h / (dCam * dCam);
    areaFull += sa; areaKept += sa * (bx1 - bx0) * (by1 - by0);
    for (let k = 0; k < 4; k++) {
      // vertex colour of the full card's corner k (shading as authored on the whole cell)
      const [lx, ly] = quad[k];
      const dx = (lx - att[0]) * w, dy = (ly - att[1]) * h;
      const px = C.anchor.x + right.x * dx - up.x * dy, py = C.anchor.y + right.y * dx - up.y * dy, pz = C.anchor.z + right.z * dx - up.z * dy;
      // smooth clump-scale self-occlusion from the vertex's depth inside the crown ellipsoid
      let ao;
      if (cr.hang) {
        // E: sunlit tops, shaded olive hanging tips; wide sprays also darken toward the attachment (dark olive bases)
        ao = asp > 1 ? (0.93 + 0.08 * Math.min(1, lx / 0.6)) * (1.06 - 0.2 * ly) : 1.06 - 0.14 * ly; // (r5: curtains: ref lower lobe nearly as golden as the upper) // (r4b: golden tops over darker olive undersides, ref ~(185,164,108) / (102,91,58))
      } else {
        // the crown light field is already in C.color (evaluated at the anchor): flat over the card
        ao = cr.clump ? 1.08 : 1.0;
      }
      // hue follows the light: sunlit puff tops go yellow, shaded interiors olive-green (ref)
      const aoC = Math.max(0.05, ao);
      // (ref: sunlit tops saturated golden, b/r ~0.64; shaded interior / lower crown greyer olive-green,
      // g/r ~0.95, b/r ~0.75-0.85)
      const shadeK = aoC < 1;
      cornerCol[k].setRGB(C.color.r * Math.pow(aoC, shadeK ? 1.38 : 1.3), C.color.g * aoC, C.color.b * Math.pow(aoC, shadeK ? 0.72 : 0.7));
    }
    const cR = [cornerCol[0].r, cornerCol[1].r, cornerCol[2].r, cornerCol[3].r];
    const cG = [cornerCol[0].g, cornerCol[1].g, cornerCol[2].g, cornerCol[3].g];
    const cB = [cornerCol[0].b, cornerCol[1].b, cornerCol[2].b, cornerCol[3].b];
    for (let k = 0; k < 4; k++) {
      const [lx, ly] = corners[k];
      const vi = i * 4 + k;
      const dx = (lx - att[0]) * w, dy = (ly - att[1]) * h;
      pos[vi * 3] = C.anchor.x + right.x * dx - up.x * dy;
      pos[vi * 3 + 1] = C.anchor.y + right.y * dx - up.y * dy;
      pos[vi * 3 + 2] = C.anchor.z + right.z * dx - up.z * dy;
      nor[vi * 3] = nrm.x; nor[vi * 3 + 1] = nrm.y; nor[vi * 3 + 2] = nrm.z;
      col[vi * 3] = lerpQuad(cR, lx, ly); col[vi * 3 + 1] = lerpQuad(cG, lx, ly); col[vi * 3 + 2] = lerpQuad(cB, lx, ly);
      uv[vi * 2] = vr.u0 + lx * vr.du; uv[vi * 2 + 1] = vr.v0 + ly * vr.dv;
      // position relative to the attachment in units of the card's size (drives the bending)
      loc[vi * 2] = dx / C.size; loc[vi * 2 + 1] = dy / C.size;
      anc[vi * 3] = C.anchor.x; anc[vi * 3 + 1] = C.anchor.y; anc[vi * 3 + 2] = C.anchor.z;
      // every spray of a foliage mass shares one crown-sway phase (the crown moves as a whole, ref)
      const shared = C.blobPh !== null && C.blobPh !== undefined;
      w0[vi * 4] = hw[0]; w0[vi * 4 + 1] = shared ? 1 : hw[1]; w0[vi * 4 + 2] = hw[2]; w0[vi * 4 + 3] = C.calm ? 0.95 * hb.flex : hb.flex; // (0.95: calmer spray field, see vegWind)
      w1[vi * 4] = hb.ph[0]; w1[vi * 4 + 1] = shared ? C.blobPh : hb.ph[1]; w1[vi * 4 + 2] = hb.ph[2]; w1[vi * 4 + 3] = C.seed;
      csz[vi] = C.size;
      if (C.lump) { clmp[vi * 4] = C.lump.c.x; clmp[vi * 4 + 1] = C.lump.c.y; clmp[vi * 4 + 2] = C.lump.c.z; clmp[vi * 4 + 3] = C.lump.R; }
    }
    idx.set([i * 4, i * 4 + 2, i * 4 + 1, i * 4, i * 4 + 3, i * 4 + 2], i * 6); // CCW as seen from the camera
  }
  const cardGeo = new THREE.BufferGeometry();
  cardGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  cardGeo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  cardGeo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  cardGeo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  cardGeo.setAttribute('aLocal', new THREE.BufferAttribute(loc, 2));
  cardGeo.setAttribute('aAnchor', new THREE.BufferAttribute(anc, 3));
  cardGeo.setAttribute('aWind0', new THREE.BufferAttribute(w0, 4));
  cardGeo.setAttribute('aWind1', new THREE.BufferAttribute(w1, 4));
  cardGeo.setAttribute('aCardSize', new THREE.BufferAttribute(csz, 1));
  cardGeo.setAttribute('aClump', new THREE.BufferAttribute(clmp, 4));
  cardGeo.setIndex(new THREE.BufferAttribute(idx, 1));
  cardGeo.computeBoundingSphere();
  cardGeo.boundingSphere.radius += 1;
  // the alpha-tested core pass shares the attributes but draws front-to-back (early-Z) and skips the
  // out-of-focus close-up branch E, which is drawn soft (blended pass only)
  const coreGeo = new THREE.BufferGeometry();
  for (const k of Object.keys(cardGeo.attributes)) coreGeo.setAttribute(k, cardGeo.attributes[k]);
  const coreIdx = [];
  for (let i = nc - 1; i >= 0; i--) {
    if (cards[i].crown.hang) continue;
    coreIdx.push(i * 4, i * 4 + 2, i * 4 + 1, i * 4, i * 4 + 3, i * 4 + 2);
  }
  coreGeo.setIndex(new THREE.BufferAttribute(new Uint32Array(coreIdx), 1));
  coreGeo.boundingSphere = cardGeo.boundingSphere.clone();

  // Two-pass foliage: an alpha-tested core (depth write, casts shadows) + a blended soft fringe drawn
  // back-to-front (cards are pre-sorted for the near-static camera). This gives the soft, motion-blurred
  // look of the video tufts without relying on alpha-to-coverage.
  function makeFoliageMat(blend) {
    const m = new THREE.MeshStandardMaterial({
      map: atlas, vertexColors: true, roughness: 1, metalness: 0,
      alphaTest: blend ? 0.02 : CORE_A, side: THREE.DoubleSide, shadowSide: THREE.DoubleSide,
      transparent: blend, depthWrite: !blend,
    });
    m.envMapIntensity = 0.7; // self-occlusion of the sky inside dense tufts
    // soft translucency + wrap: light scattering through the needle tufts (warm)
    patchVegWind(m, 'card', uniforms, viewPos, (shader) => {
      shader.uniforms.uTransl = { value: new THREE.Color('#d8cc90') };
      shader.uniforms.uSunDirF = uniforms.uSunDir;
      shader.uniforms.uSunColF = uniforms.uSunColor;
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform vec3 uTransl;\nuniform vec3 uSunDirF;\nuniform vec3 uSunColF;')
        .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        {
          vec3 V = normalize(vViewPosition);
          vec3 Lv = normalize((viewMatrix * vec4(uSunDirF, 0.0)).xyz);
          // needle clouds scatter strongly forward: the sun is ~45 deg off the view axis for crown B
          // (right, slightly in front of the camera), so the tufts glow golden from transmitted light
          float cosV = max(dot(-V, Lv), 0.0);
          float back = 0.6 * cosV * cosV + 0.9 * pow(cosV, 6.0);
          // thin, sparse parts of a spray (low texel coverage: outer threads, crown rims) transmit more
          back *= 0.9 + 0.15 * (1.0 - fAlpha);
          float wrap = max(dot(normal, Lv) * 0.5 + 0.5, 0.0);
          // + an isotropic part: a cloud of thin cylindrical needles shows lit flanks from any side
          reflectedLight.directDiffuse += diffuseColor.rgb * uTransl * uSunColF * (0.6 + 0.5 * wrap + 3.2 * back) * 0.3183;
          reflectedLight.indirectSpecular *= 0.3;
        }`);
      // Lumps (ref: crowns are 25-55 x 15-30 px lumps of sprays, golden on their upper / sun-side flank,
      // darker olive under it, with soft fuzzy edges and gaps where the rock / sea shows through). The
      // cards (45-100 px) are larger than a lump, so the lump is shaped per fragment: the rest-pose
      // offset from the card's clump centre in the camera plane (x in R, y in 0.54 R units; tuft anchors
      // lie within ~1) drives a light gradient and fades the spray threads that stray beyond ~1.2-2.3.
      // Every card of a clump shares the centre, so overlapping cards agree (no per-card seams).
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec4 aClump;\nvarying vec3 vClumpD;')
        .replace('#include <project_vertex>', `{
          vClumpD = vec3(0.0);
          if (aClump.w != 0.0) {
            // (w < 0: tree A's layered sprays - flat, elongated lumps)
            float lR = abs(aClump.w), lY = aClump.w < 0.0 ? 0.45 : ${LUMP_Y.toFixed(2)};
            vec3 cdv = position - aClump.xyz;
            vec3 crt = normalize(cross(normalize(aClump.xyz - uViewPos), vec3(0.0, 1.0, 0.0)));
            // z = 1 + per-clump seed (ragged outline below)
            vClumpD = vec3(dot(cdv, crt) / lR, cdv.y / (lY * lR), 1.0 + fract(sin(dot(aClump.xyz, vec3(1.9898, 7.8233, 3.7719))) * 43758.5453));
          }
        }
        #include <project_vertex>`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vTexBias;\nvarying vec3 vCardRip;\nvarying vec3 vClumpD;')
        .replace('#include <map_fragment>', 'float fAlpha = 1.0;\n#ifdef USE_MAP\n  vec2 ripUv = vMapUv + vec2(0.0, 0.0035 * vCardRip.z * min(vCardRip.x, 1.5) * sin(vCardRip.y - vCardRip.x * 3.0));\n  vec4 sampledDiffuseColor = texture( map, ripUv, abs(vTexBias) );\n  diffuseColor *= sampledDiffuseColor;\n  fAlpha = sampledDiffuseColor.a;\n#endif'
          + `
  if (vClumpD.z > 0.5) {
    float lcr = length(vClumpD.xy);
    float lcl = clamp(dot(vClumpD.xy, vec2(0.42, 0.91)) * 0.75, -1.0, 1.0);
    float lumpL = 1.0 + lcl * (lcl < 0.0 ? ${(LUMP_K * 0.6).toFixed(3)} : ${LUMP_K.toFixed(3)});
    // lit flank golden-yellow; shaded underside darker and greyer (r4b: desaturated toward its luminance,
    // ref darkest-quintile saturation ~0.30 vs lit ~0.37, instead of a per-channel power that kept it)
    if (lumpL > 1.0) diffuseColor.rgb *= vec3(pow(lumpL, 1.05), lumpL, pow(lumpL, 0.38));
    else {
      float lumY = dot(diffuseColor.rgb, vec3(0.3, 0.59, 0.11));
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(lumY), 0.85 * (1.0 - lumpL)) * vec3(pow(lumpL, 1.1), lumpL, pow(lumpL, 0.85));
    }
    // (r4b) ragged, brush-like lump outline instead of identical soft ellipses: the fade radius varies
    // with direction (per-clump seed), stretches downwind / up-right (wind-streamed sprays), and sparse
    // thread texels fade first while dense spray cores reach further
    float lsd = vClumpD.z - 1.0;
    float lang = lcr > 1e-3 ? atan(vClumpD.y, vClumpD.x) : 0.0;
    float lrag = 1.0 + 0.2 * sin(3.0 * lang + 6.283 * lsd) + 0.13 * sin(5.0 * lang + 17.0 * lsd);
    float ldw = 1.0 + 0.35 * max(dot(vClumpD.xy, vec2(0.8, 0.6)) / (lcr + 1e-4), 0.0);
    float lrr = lcr / (lrag * ldw) + 0.3 * (0.5 - fAlpha);
    diffuseColor.a *= 1.0 - smoothstep(${(LUMP_R[0] * lumpRK).toFixed(2)}, ${(LUMP_R[1] * lumpRK).toFixed(2)}, lrr); // (wider on lower tiers: fewer cards)
  }`
          // fringe pass: texels the alpha-tested core already wrote (identical colour) are skipped before lighting
          + (blend ? '\n  if (vTexBias > 0.0 && diffuseColor.a >= ' + CORE_A.toFixed(2) + ') discard;' : ''));
      if (blend) {
        shader.fragmentShader = shader.fragmentShader.replace('#include <alphatest_fragment>',
          'diffuseColor.a = smoothstep(0.02, 0.85, diffuseColor.a);\n  if (diffuseColor.a < 0.02) discard;');
      }
    });
    patchMaterialAtmosphere(m, uniforms);
    return m;
  }
  const foliage = new THREE.Mesh(coreGeo, makeFoliageMat(false));
  foliage.castShadow = true;
  foliage.receiveShadow = true;
  const foliageDepth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: atlas, alphaTest: 0.6, side: THREE.DoubleSide });
  patchVegWind(foliageDepth, 'card', uniforms, viewPos);
  foliage.customDepthMaterial = foliageDepth;
  foliage.name = 'trees-foliage';
  foliage.renderOrder = -1;
  scene.add(foliage);
  const fringe = new THREE.Mesh(cardGeo, makeFoliageMat(true));
  fringe.receiveShadow = true;
  fringe.name = 'trees-foliage-soft';
  fringe.renderOrder = 2;
  // one draw with both faces instead of three's back-then-front split (the cards face the camera and
  // are pre-sorted back to front, so the single pass keeps the blend order)
  fringe.material.forceSinglePass = true;
  scene.add(fringe);
  // medium / low: the needle cards skip shadow-map sampling (most of their look is in the vertex colours)
  if (ctx.params?.has('tnoshadow') || tier !== 'high') { foliage.receiveShadow = false; fringe.receiveShadow = false; }
  const stats = { branches: visibleBranches.length, cards: nc, branchTris: branchGeo.index.count / 3, cardTris: nc * 2, cardAreaKept: +(areaKept / Math.max(1e-9, areaFull)).toFixed(3) };
  if (ctx.capture && ctx.params.has('treestats')) console.warn('[trees] stats ' + JSON.stringify(stats));
  ctx.progress?.(1, 'She-oaks');

  return {
    meshes: { branches: branchMesh, foliage, fringe },
    stats,
    update() {
      // pixel footprint of the current render target (sub-pixel twig widening, lib/vegWind.js)
      const cam = ctx.camera, hPx = (ctx.size?.height || 1080) * (ctx.renderer?.getPixelRatio?.() || 1) * (quality?.scale || 1);
      if (cam && hPx > 0) VEG_PX.value = 2 * Math.tan((cam.fov * DEG) / 2) / hPx;
    },
  };
}
