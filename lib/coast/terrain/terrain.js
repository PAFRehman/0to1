// Terrain: every land surface (foreground headland, rock platform, rocks, beach, dunes, hills).
//
// Geometry (all heights from world/layout.js heightAt, the single source of truth):
//  - fg:       0.3 m rectangular grid under/around the camera (headland top, cliff edge, ledge)
//  - platform: 0.35 m grid for the flat-topped rock platform + nearby rocks (sharp silhouettes)
//  - polar:    camera-centred polar grid (constant angular density => constant pixel density)
//              from 26 m to 45 km, split into a near ring (1.45 % radial ratio) and a far ring
//              (2.4 %, beyond 1 km; medium/low: beyond 420 m); the near ring casts shadows.
//              (Dense rows out to 1 km keep the per-vertex sun bake / crest normals from smearing
//              into vertical streaks and horizontal combing on the dune crests and near hills.)
//              Sea-floor triangles deeper than 6 m are dropped (the ocean hides them).
// Coarser meshes overlap finer ones by one cell and use polygonOffset so the finer one wins.
//
// Shading: patched MeshStandardMaterial (shadows, sun + hemisphere light from main.js) with a
// fully procedural albedo/roughness/normal/AO: grass (+dry patches, needle-litter band),
// sandstone rock (weak warped strata, tafoni cavities, joints, lichen, wet/algae base), sand
// (dry/damp/wet, streaks, tracks), sea floor, and dune scrub / forest canopy. The canopy ray-traces
// one sphere crown per jittered xz cell (4.8 m scrub -> 12.5 m forest; 4x4 candidate cells shifted
// toward the camera) against the view ray, so crowns stay round and occlude each other on hill
// faces seen at grazing angles; the hit normal (+leaf-clump / branch-mass noise, each faded before
// it is under ~3 px) is lit by three.js, and crown->crown / crown->gap sun shadows are tested
// against the same candidates. Crowns are clumped (tree groups / bush masses with clearings, 30-60 m
// noise on presence and size) and have ragged outlines (silhouette radius varies with the
// screen-plane angle around the crown). Resolved out to ~2.3 km (the near hills show 4-8 px crowns);
// beyond, or when crowns get sub-pixel, it fades to tree-group blotches on a camera-facing
// cylindrical projection. Where the view grazes the canopy (dune crests / swale at 1-4 deg) the
// trace smears, so an embossed angular-space fbm (crowns and clumps seen from the lookout) takes
// over: golden sunlit upper edges, darker undersides and gaps. Resolved crowns under the low
// back-light also get a wrapped-top + forward-transmission foliage sun term (golden crown tops).
// The sand/scrub boundary is made of whole crowns, with sparse low fore-dune clumps
// (angular-space blobs, round on screen) thinning out toward the beach in front of it, rows of
// short spinifex dashes on the fore-dune face and a scalloped, shaded erosion scarp below the scrub
// line; the beach gets screen-space foot/tyre-track streaks. Rock: pitted/granular micro-relief,
// two-octave normal detail (both footprint-filtered), tafoni out to the platform, an algae band in
// the splash zone and glossy (low-roughness) wet rock at the waterline. Sunlit
// scrub tops are tinted golden-olive; per-crown sun contrast is softened beyond ~250 m.
// Canopy direct specular is cut to 20 % (a rough leaf volume has no grazing sheen; it washed the
// flat far scrub swale into a smooth pale carpet); the 1-2.5 km far field gets crown texture with
// golden sunlit tops and bluish shaded gaps.
// Direct sun is multiplied by a per-vertex terrain self-shadow term baked at load time by
// marching a height grid toward the sun (the shadow map only covers the foreground).
// On the hills (z < -560) the bake only marches 70 m (local relief), so the scrub swale / crests
// catch the sun as in the reference; the polar rings opt out of the sky module's far shadow map
// (the bake covers them); on the rings the bake is lightly blurred (azimuth + radial) so single
// lit vertices do not stretch into streaks. Unresolved far-field crowns get a soft extra foliage
// sun term on broad "sunlit stands" (angular-space noise seen from the lookout, round on flat and
// steep ground alike) with only low-contrast crown-group texture.
// Ambient: own cosine-weighted sky term from the shared uSkyZenith/uSkyHorizon (scene.environment
// is too blue for land), boosted on foliage. Own land aerial perspective (replaces applyAtmosphere):
// the shared haze with most of the low surf-spray veil cut inland of the beach, plus a land-only
// top-up toward the measured beta (TERRAIN_HAZE_TARGET, self-cancelling once uHazeDensity reaches
// it). Medium/low tiers define TERRAIN_LQ (no crown shadow march, no sub-pixel crack Voronoi, no ragged
// crown outlines, crowns traced only to ~1.3 km).
// Round 4 (realism pass):
//  - Crown bases come from half-float height textures (the sun-bake grids: 5 m near, 20 m far),
//    not from the pixel's tangent plane, so crowns no longer slide / shear with the interpolated
//    normal (diagonal smears, twinkle in motion). The same field gives a 30 m Laplacian crease term
//    (darker gullies, lighter spurs) on the dunes and hills.
//  - All footprint fades use uTPix (pixel angle of the scene target, updated per frame) instead of
//    constants tuned for 718 rows; line features (cracks, joints, tafoni rims, bedding, beach ruts,
//    strandline) are prefiltered (width >= ~1.2-1.5 px, contrast scaled by w0 / w).
//  - Sun bake: 600 m march on the hills from 5 m above ground (crowns / canopy roughness do not
//    shade themselves), 3 radial blur passes on the rings, and the dune front / swale at azimuth
//    > ~26 deg lies in the shadow of the hills off-frame right: only the crest band catches the sun.
//  - Beyond ~0.5 km the lit canopy is one continuous mass (per-crown golden tops / wrap /
//    transmission blend into a ground-normal term); where the view grazes the canopy the crown
//    trace is replaced by the angular-space mosaic (the jittered crown rows banded horizontally).
//    The shaded near band keeps flat, low-contrast crowns (per-crown normal weight <= 0.1).
//  - Hills: chroma falls with range, the 1-2 km slopes lighter / neutral, 2.5-4 km darker; sandy
//    blowouts; lower per-crown contrast beyond 1.2 km; forward-scatter tint of the land airlight
//    (brighter / neutral toward the sun, darker blue-grey away from it).
//  - Beach: wandering, broken 4WD track bands and ruts, strandline, wind ripples (near), debris /
//    footprint dashes on the upper beach, glossy swash band (roughness 0.14); thin-water sea floor
//    stays wet-sand grey to -0.8 m.
//  - Platform: sunlit / pale top lip (baked edge mask aEdge), salt-crusted pitted top, fine grain and
//    bedding lines, lighter east shelf / darker west end, no pale bench tops (they read as
//    columns), damped face-normal staircase striations, lighter / browner wet base.
//  - Headland brow: exposed soil patches along the cliff edge, redder litter, mottling.
//  - Knoll: darker green bush masses with yellow-green sunlit rims and leafy texture.
//  - Medium/low: 3x3 crown candidates (no candidate arrays).
// Round 5 (dune scrub / hill faces):
//  - The sea-facing dune front turns away from the 7 deg sun (dot(n, sun) ~ -0.2..-0.28): its canopy
//    gets no direct / wrapped / transmitted sun (bfK, from the ground normal with a ragged ~8 px
//    angular-noise edge; dunes only, h < ~35 m, not the knoll); the crest / swale behind it stay lit
//    -> a broad golden crest band above a dark front, as in the reference (was: lumpy pale-topped
//    crowns in shade and a sunlit front on the left half of the beach).
//  - That shaded front scrub (0.3-1.5 km) is a flat, dense mass: per-crown albedo / AO / normal
//    modelling flattened to a neutral blue-grey base (darker, bluer beyond ~0.5 km) with
//    angular-space texture (10-25 px masses, 4-6 px shrubs with sky-lit upper edges, 2.5-3.5 px
//    dark gaps; each octave faded by its on-screen period); ~40 % less land haze on it beyond 0.5 km
//    (reference: the darkest, least hazy land, ~(66,76,82) at 650 m, ~(86,94,95) at 480 m).
//  - Lit crest band: warmer golden-olive (R ~ G, low B) with golden clump tops and dark gaps.
//  - Scrub line: gaps between the edge crowns show shaded understory (no white sand slivers), a
//    darker toe below, a smoother edge (less 16 m noise), scrub reaching ~4 m further toward the sea
//    at the near end; fore-dune clumps / debris dashes sparser and fainter (no dark fragments).
//  - Ridge tops of the 1.1-1.8 km hills greyer / slightly bluer.
// Round 5b (review fixes):
//  - Crest band tapers out by azimuth (thick to ~21 deg, thinning from below to ~25 deg, in shade
//    beyond ~26 deg with only a thin pale rim of dead shrubs on the crest top), as in the reference
//    at every time; broad ~80 px thickness variation; crowns poke 2-4 px above the shadow line.
//  - Upper gold tier on the 1-2 km back-dune crests (14-21 deg): broken patches applied after the
//    face / azimuth masks, dimmer than the main band.
//  - Band texture: ~10 x 8 px lit clump masses on a rotated lattice, sparse 4-5 px bright crown
//    tops, positively skewed ~2.5 px twig grain (pre-emphasised against the haze / post softening).
//  - Shaded front: bluer beyond ~0.5 km, weaker 1-4 px grain, sparse sky-lit bush tops, a faint
//    2.7 px leaf grain; extends to ~3 km (far-left dune front: dark, flat, less hazy).
//  - Scrub line: soft 20 m floor (no contour-parallel clamp), ~60 m at the near end (bright sand
//    ramp below the knoll, no toe darkening there).
//  - Hills: away-from-sun haze less cyan, mid azimuths slate (B > G), far hill faces turned from the
//    sun without sunlit crown tops, weaker crown / gap contrast beyond ~1.1 km, scattered dark tree
//    clumps on the near hill faces, a light glare veil on the lower slopes toward the sun.
//  - Perf: no ragged-outline noise on deep shaded-front pixels (flattened anyway), gold texture only
//    where the band is, octave pairs only where weighted; medium/low drop the fine front octaves.
// Debug: ?debug=tgrey (grey albedo), ?debug=tsurf (surface weights), ?debug=tsfr (unlit albedo replaced by R shaded-front mask, G gold-band mask, B sun visibility), ?debug=tsun (R sun bake, G far-field lit mask, B farK),
// ?tstats (log triangle/vertex counts + build time).
// Also adds two tiny people on the platform (one merged mesh).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { patchMaterialAtmosphere, CURVATURE_GLSL } from '../core/atmosphere.js';
import { polygonSDF, PLATFORM_OUTLINE, HEADLAND_OUTLINE, beachSigned } from '../world/layout.js';

const smoothstep = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// ---------------------------------------------------------------------------------------------
// Cooperative yielding for the long load-time loops: checked every 2048 samples, it yields a
// macrotask once ~12 ms of work have passed so the loading bar keeps repainting. Hidden tabs are
// not yielded (nothing is painted there, and background timers are throttled to ~1 Hz).
function makeYielder() {
  let last = performance.now();
  return async function tick() {
    if (performance.now() - last < 12) return;
    if (typeof document === 'undefined' || !document.hidden) await new Promise((r) => setTimeout(r, 0));
    last = performance.now();
  };
}

// ---------------------------------------------------------------------------------------------
// Height grids for the baked terrain self-shadow
async function makeGrid(layout, minX, maxX, minZ, maxZ, nx, nz, tick) {
  const data = new Float32Array(nx * nz);
  let cnt = 0;
  for (let j = 0; j < nz; j++) {
    const z = minZ + (maxZ - minZ) * j / (nz - 1);
    for (let i = 0; i < nx; i++) {
      const x = minX + (maxX - minX) * i / (nx - 1);
      data[j * nx + i] = Math.max(0, layout.heightAt(x, z));
    }
    if ((cnt += nx) >= 2048) { cnt = 0; await tick(); }
  }
  const sx = (nx - 1) / (maxX - minX), sz = (nz - 1) / (maxZ - minZ);
  return {
    data, nx, nz, minX, maxX, minZ, maxZ,
    inside: (x, z) => x >= minX && x <= maxX && z >= minZ && z <= maxZ,
    sample(x, z) {
      const fx = (x - minX) * sx, fz = (z - minZ) * sz;
      const i = Math.min(nx - 2, Math.max(0, Math.floor(fx))), j = Math.min(nz - 2, Math.max(0, Math.floor(fz)));
      const u = Math.min(1, Math.max(0, fx - i)), v = Math.min(1, Math.max(0, fz - j));
      const o = j * nx + i;
      const a = data[o], b = data[o + 1], c = data[o + nx], d = data[o + nx + 1];
      return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
    },
  };
}

async function makeSunVis(layout, sunDir, tick) {
  const fine = await makeGrid(layout, -160, 760, -1600, 80, 185, 337, tick); // 5 m
  const coarse = await makeGrid(layout, -600, 3600, -9000, 100, 211, 456, tick); // 20 m
  const len = Math.hypot(sunDir.x, sunDir.z);
  const dx = sunDir.x / len, dz = sunDir.z / len;
  const tanE = sunDir.y / len;
  const vis = (x, z, h) => {
    let maxSlope = -1;
    let t = 3.0;
    // hills / swale: 600 m (ridges and the near-hill spur on the sun side shade the swale, so only
    // the crest band catches the low sun), marched from the crown tops (crowns do not shade
    // themselves)
    const maxT = z > -430 ? 4000 : z > -560 ? 4000 - 3400 * (-430 - z) / 130 : 600;
    // (ignore sub-metre bumps (block tops etc.); on the dunes / hills ignore the 3-7 m canopy
    // roughness too: its 25-55 m long low-sun shadows streaked the dune faces diagonally)
    const h0 = Math.max(h, 0) + 1.0 + 4.0 * smoothstep(-300, -480, z);
    while (t < maxT) {
      const px = x + dx * t, pz = z + dz * t;
      let hs;
      if (fine.inside(px, pz)) hs = fine.sample(px, pz);
      else if (coarse.inside(px, pz)) hs = coarse.sample(px, pz);
      else break;
      const s = (hs - h0) / t;
      if (s > maxSlope) maxSlope = s;
      if (h0 + t * tanE > 260) break; // above everything
      t += Math.max(1.5, t * 0.06);
    }
    return 1 - smoothstep(tanE - 0.012, tanE + 0.018, maxSlope);
  };
  grids.fine = fine; grids.coarse = coarse;
  // the dune front / swale on the right of the frame (azimuth > ~26 deg from the lookout) lies in
  // the shadow of the high scrubby hills off-frame right (reference: the lit crest band ends at
  // image x ~1100-1150, darker scrub beyond); a soft, slightly wandering boundary
  return (x, z, h) => {
    let v = vis(x, z, h);
    // (dune front / swale only: on the hills a wandering boundary printed vertical light shafts)
    if (z < -300 && h > 3 && h < 42) {
      const az = Math.atan2(x, -z) * 57.2958 + 0.8 * Math.sin(z * 0.013) + 0.5 * Math.sin(z * 0.041 + 1.3);
      v *= 1 - 0.88 * smoothstep(25.0, 28.5, az) * smoothstep(3, 9, h) * smoothstep(42, 30, h);
    }
    return v;
  };
}
const grids = {};

// ---------------------------------------------------------------------------------------------
// Per-vertex surface classification -> aSurf (sand, rock, grass, canopy), aMisc (sunVis, beachDist, zone)
let rim = 0, sKnoll = 0, bare = 0;
function classify(layout, x, z, out) {
  rim = 0; sKnoll = 0; bare = 0;
  const c = layout.componentsAt(x, z);
  const h = c.h;
  let sand = 0, rock = 0, grass = 0, veg = 0;
  const s = beachSigned(x, z);
  // mainland contribution
  if (h < 0.2 && c.main >= h - 0.3) {
    sand = 1; // beach / sea floor
  } else {
    const vegW = smoothstep(30, 52, s);
    sand = 1 - vegW; veg = vegW;
  }
  let w = [sand, rock, grass, veg];
  // headland
  if (c.head > c.main - 0.5 && c.head > -8) {
    const dh = polygonSDF(x, z, HEADLAND_OUTLINE);
    // grass on top, rock/soil down the cliff; a wider dark rock rim at the bottom-left of frame
    const nearCam = smoothstep(-14, -8, z) * smoothstep(-2, -5, x);
    const g = smoothstep(-0.1, -1.4 - 2.0 * nearCam, dh);
    const k = smoothstep(-1.0, 3.0, c.head - c.main);
    // lower-left brow knob and the left edge band beyond the dead shrubs: bare rock / soil
    // (layout.bareRockAt), no grass
    const br = k * layout.bareRockAt(x, z, dh);
    const gg = g * (1 - br);
    rim = k * Math.max(1 - g, br);
    bare = br;
    w = w.map((v) => v * (1 - k));
    w[2] += k * gg; w[1] += k * (1 - gg);
  }
  // scrub knoll
  if (c.knoll > -2) {
    const kk = smoothstep(-0.8, 0.8, c.knoll - Math.max(c.main, c.head, c.plat));
    w = w.map((v) => v * (1 - kk));
    w[3] += kk;
    sKnoll = kk;
  }
  // platform and rocks
  const pk = Math.max(smoothstep(-0.6, 0.6, c.plat - Math.max(c.main, c.head)), smoothstep(-0.15, 0.1, c.rock - Math.max(c.main, c.head, c.plat)));
  if (pk > 0) {
    w = w.map((v) => v * (1 - pk));
    w[1] += pk;
  }
  out[0] = w[0]; out[1] = w[1]; out[2] = w[2]; out[3] = w[3];
  return { h, s: s + (95 - s) * sKnoll };
}

// ---------------------------------------------------------------------------------------------
// Recess darkening for a rectangular rock grid (the platform's broken east shelf): horizon-based
// occlusion from the grid's own heights (8 directions, up to recess.radius m), written into the
// dark-rock weight aMisc.z so the shaded joints, bench corners and the foot of set-back faces read
// as darker recesses (plus a base darkening of the weathered east shelf).
// recess = { step, radius, base, gain, mask(x, z) }.
async function bakeRecess(pos, surf, misc, nx, nz, recess, tick, edge) {
  const S = Math.max(2, Math.round(recess.radius / recess.step));
  const SE = Math.max(1, Math.round(2.0 / recess.step));
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  for (let j = 0; j < nz; j++) {
    if ((j & 15) === 0) await tick();
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      const x = pos[k * 3], z = pos[k * 3 + 2];
      const h0 = pos[k * 3 + 1];
      if (edge && surf[k * 4 + 1] > 0.5 && h0 > 2.0) {
        // top lip: the largest height drop within 2 m (the weathered, sunlit crust along the edge)
        let drop = 0;
        for (const [di, dj] of dirs) {
          for (let s = 1; s <= SE; s++) {
            const ii = i + di * s, jj = j + dj * s;
            if (ii < 0 || jj < 0 || ii >= nx || jj >= nz) break;
            drop = Math.max(drop, h0 - pos[(jj * nx + ii) * 3 + 1]);
          }
        }
        edge[k] = smoothstep(0.9, 2.4, drop) * surf[k * 4 + 1];
      }
      const w = recess.mask(x, z) * surf[k * 4 + 1];
      if (w <= 0) continue;
      let occ = 0;
      for (const [di, dj] of dirs) {
        const len = Math.hypot(di, dj) * recess.step;
        let m = 0;
        for (let s = 1; s <= S; s++) {
          const ii = i + di * s, jj = j + dj * s;
          if (ii < 0 || jj < 0 || ii >= nx || jj >= nz) break;
          const sl = (pos[(jj * nx + ii) * 3 + 1] - h0) / (s * len);
          if (sl > m) m = sl;
        }
        occ += m / Math.sqrt(1 + m * m);
      }
      occ /= dirs.length;
      misc[k * 3 + 2] = Math.max(misc[k * 3 + 2], w * (recess.base + recess.gain * smoothstep(0.08, 0.4, occ)));
    }
  }
}

// ---------------------------------------------------------------------------------------------
async function buildGeometry(layout, verts, nx, nz, sunVis, keepTri, useSun = true, flip = false, tick = async () => {}, onProgress = null, recess = null, blurSun = false) {
  // verts: Float32Array of (x,z) pairs, nx*nz, row-major
  const n = nx * nz;
  const pos = new Float32Array(n * 3);
  const surf = new Float32Array(n * 4);
  const misc = new Float32Array(n * 3);
  const edge = new Float32Array(n);
  const w4 = [0, 0, 0, 0];
  for (let i = 0; i < n; i++) {
    if ((i & 2047) === 0 && i > 0) { if (onProgress) onProgress(i / n); await tick(); }
    const x = verts[i * 2], z = verts[i * 2 + 1];
    pos[i * 3] = x; pos[i * 3 + 2] = z;
    // cheap early-out for open sea far from any rock/headland (hidden under the ocean)
    const s0 = beachSigned(x, z);
    if (s0 < -70 && !(x > -90 && x < 320 && z > -310 && z < 145)) {
      pos[i * 3 + 1] = -20; surf[i * 4] = 1; misc[i * 3] = 1; misc[i * 3 + 1] = -200;
      continue;
    }
    const { h, s } = classify(layout, x, z, w4);
    pos[i * 3 + 1] = h;
    surf.set(w4, i * 4);
    misc[i * 3] = useSun && h > -1 ? sunVis(x, z, h) : 1;
    misc[i * 3 + 1] = Math.max(-200, Math.min(400, s));
    misc[i * 3 + 2] = rim;
    edge[i] = bare; // (headland bare rock / soil; the platform build overwrites it with its lip mask)
  }
  if (recess) await bakeRecess(pos, surf, misc, nx, nz, recess, tick, edge);
  if (blurSun) {
    // polar rings: soften the baked sun term ([1 2 1] twice across azimuth, once radially, land
    // vertices only). Single lit/shadowed vertices otherwise stretch into thin vertical streaks
    // along the long, thin far-ring triangles seen at grazing angles.
    const src = new Float32Array(n);
    for (let pass = 0; pass < 5; pass++) {
      const st = pass < 2 ? 1 : nx; // 2 azimuth + 3 radial passes (lit/unlit rows made horizontal streaks)
      for (let k = 0; k < n; k++) src[k] = misc[k * 3];
      for (let j = 0; j < nz; j++) {
        if ((j & 63) === 0) await tick();
        for (let i = 0; i < nx; i++) {
          const k = j * nx + i;
          if (pos[k * 3 + 1] <= -1) continue;
          let acc = 2 * src[k], w = 2;
          const a = st === 1 ? (i > 0 ? k - 1 : -1) : (j > 0 ? k - nx : -1);
          const b = st === 1 ? (i < nx - 1 ? k + 1 : -1) : (j < nz - 1 ? k + nx : -1);
          if (a >= 0 && pos[a * 3 + 1] > -1) { acc += src[a]; w++; }
          if (b >= 0 && pos[b * 3 + 1] > -1) { acc += src[b]; w++; }
          misc[k * 3] = acc / w;
        }
      }
    }
  }
  const idx = [];
  for (let j = 0; j < nz - 1; j++) {
    if ((j & 15) === 0) await tick();
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
      const ha = pos[a * 3 + 1], hb = pos[b * 3 + 1], hc = pos[c * 3 + 1], hd = pos[d * 3 + 1];
      if (Math.max(ha, hb, hc, hd) < -2.5) continue; // sea floor, hidden by the opaque ocean
      if (keepTri && !keepTri(a, b, c, d, pos)) continue;
      if (flip) idx.push(a, b, c, b, d, c);
      else idx.push(a, c, b, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aSurf', new THREE.BufferAttribute(surf, 4));
  geo.setAttribute('aMisc', new THREE.BufferAttribute(misc, 3));
  geo.setAttribute('aEdge', new THREE.BufferAttribute(edge, 1));
  geo.setIndex(n > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
  return geo;
}

function rectVerts(minX, maxX, minZ, maxZ, step) {
  const nx = Math.round((maxX - minX) / step) + 1, nz = Math.round((maxZ - minZ) / step) + 1;
  const v = new Float32Array(nx * nz * 2);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    v[(j * nx + i) * 2] = minX + (maxX - minX) * i / (nx - 1);
    v[(j * nx + i) * 2 + 1] = minZ + (maxZ - minZ) * j / (nz - 1);
  }
  return { v, nx, nz };
}

function polarRadii(r0, r1, ratio) {
  const radii = [];
  for (let r = r0; r < r1 * ratio; r *= ratio) radii.push(Math.min(r, r1));
  return radii;
}

function polarVerts(cx, cz, az0, az1, radii, nAz) {
  const nz = radii.length, nx = nAz;
  const v = new Float32Array(nx * nz * 2);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    const a = (az0 + (az1 - az0) * i / (nx - 1)) * Math.PI / 180;
    v[(j * nx + i) * 2] = cx + Math.sin(a) * radii[j];
    v[(j * nx + i) * 2 + 1] = cz - Math.cos(a) * radii[j];
  }
  return { v, nx, nz };
}

// ---------------------------------------------------------------------------------------------
const GLSL_NOISE = /* glsl */ `
float tHash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 tHash22(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
float tNoise(vec2 p){
  vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  float a = tHash12(i), b = tHash12(i + vec2(1, 0)), c = tHash12(i + vec2(0, 1)), d = tHash12(i + vec2(1, 1));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float tFbm(vec2 p, int oct){
  float s = 0.0, a = 0.5, n = 0.0;
  for (int i = 0; i < 6; i++){ if (i >= oct) break; s += a * tNoise(p); n += a; p = p * 2.03 + vec2(17.1, -9.3); a *= 0.5; }
  return s / n;
}
// tFbm with every octave faded to its mean by its footprint (fq: cycles per pixel of the first octave)
float tFbmF(vec2 p, int oct, float fq){
  float s = 0.0, a = 0.5, n = 0.0;
  for (int i = 0; i < 6; i++){ if (i >= oct) break; s += a * mix(0.5, tNoise(p), smoothstep(0.5, 0.25, fq)); n += a; p = p * 2.03 + vec2(17.1, -9.3); fq *= 2.03; a *= 0.5; }
  return s / n;
}
// Voronoi: x = nearest distance, y = second distance, zw = nearest cell id
vec4 tVoronoi(vec2 p){
  vec2 ip = floor(p), fp = fract(p);
  float d1 = 8.0, d2 = 8.0; vec2 id = vec2(0);
  vec2 rel = vec2(0);
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++){
    vec2 g = vec2(i, j);
    vec2 o = tHash22(ip + g) * 0.8 + 0.1;
    vec2 r = g + o - fp;
    float d = dot(r, r);
    if (d < d1){ d2 = d1; d1 = d; id = ip + g; rel = r; } else if (d < d2){ d2 = d; }
  }
  return vec4(sqrt(d1), sqrt(d2), id);
}
vec2 tVoronoiRel(vec2 p){
  vec2 ip = floor(p), fp = fract(p);
  float d1 = 8.0; vec2 rel = vec2(0);
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++){
    vec2 g = vec2(i, j);
    vec2 r = g + tHash22(ip + g) * 0.8 + 0.1 - fp;
    float d = dot(r, r);
    if (d < d1){ d1 = d; rel = r; }
  }
  return rel;
}
vec3 srgb(vec3 c){ return pow(c, vec3(2.2)); }
// crown field (cell units): xy = vector to the nearest crown centre, z = its distance, w = radius
vec4 tCrown(vec2 p){
  vec2 ip = floor(p), fp = fract(p);
  float d1 = 8.0; vec2 rel = vec2(0); vec2 id = vec2(0);
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++){
    vec2 g = vec2(i, j);
    vec2 r = g + tHash22(ip + g) * 0.7 + 0.15 - fp;
    float d = dot(r, r);
    if (d < d1){ d1 = d; rel = r; id = ip + g; }
  }
  return vec4(rel, sqrt(d1), 0.5 + 0.32 * tHash12(id + 7.7));
}
float tCrownH(vec2 p){ vec4 c = tCrown(p); return c.w * sqrt(max(0.0, 1.0 - c.z * c.z / (c.w * c.w))); }
`;

const GLSL_SHADE = /* glsl */ `
// Procedural surface: returns albedo (linear), roughness, world normal, ambient occlusion.
float gVegSun = 1.0;
float gVegAmb = 1.0;
float gFarK = 0.0;   // sky-ambient boost on foliage (open canopy: sky light reaches the crown sides)
float gFoliageSun = 0.0; // extra direct sun on the sun-facing sides of unresolved (far-field) crowns
float gVegF = 0.0;       // canopy fraction of the surface mix
vec3 gDbg = vec3(0.0);
float gFrontShade = 0.0; // shaded dune-front scrub (less land haze, see the fog block)
float gSunVis = 1.0;     // baked sun visibility, raised where back-dune crowns poke into the sun
float gCrest = 0.0;      // sunlit golden crest band (less land haze, see the fog block)
void terrainSurface(vec3 wp, vec3 nG, vec4 surf, vec3 misc, out vec3 albedo, out float rough, out vec3 nW, out float ao){
  float dist = length(wp - cameraPosition);
  vec2 fw = fwidth(wp.xz);
  float fsS = max(fwidth(misc.y), 0.02); // footprint across the beach (m of waterline distance per pixel)
  // sand / scrub boundary (waterline distance of the scrub edge; the fore-dune and beach use it too)
  float sEdge = 1e4;
  // (reference scrub line, measured per column against the waterline distance: ~50 m at the near
  // end, ~35 m at z ~ -500, the scrub reaching down to within ~20 m of the waterline beyond ~0.6 km,
  // where the beach below it is a thin strip)
  if (misc.y > 13.0) {
    float nearE = smoothstep(-620.0, -400.0, wp.z);
    // (~60 m right at the near end, z > -350: bright sand ramp below the knoll in the reference)
    float sRaw = mix(22.0, 50.0, nearE) + 10.0 * smoothstep(-430.0, -350.0, wp.z) + (tFbm(wp.xz * 0.02 + 4.0, 3) - 0.5) * mix(10.0, 22.0, nearE) + (tFbm(wp.xz * 0.06 + 1.3, 2) - 0.5) * 9.0;
    // soft floor at 20 m (a hard clamp traced the waterline-distance contour exactly)
    sEdge = 20.0 + 4.0 * log(1.0 + exp(clamp((sRaw - 20.0) / 4.0, -20.0, 20.0)));
  }
  float foot = max(max(fw.x, fw.y), dist * uTPix * 1.18); // metres per pixel (approx; 0.0012 * dist at 718 rows)
  nW = nG;
  ao = 1.0;
  float slope = 1.0 - nG.y;
  float wSand = surf.x, wRock = surf.y, wGrass = surf.z, wVeg = surf.w;
  // steep grass -> exposed soil/rock
  float steep = smoothstep(0.30, 0.55, slope) * wGrass;
  wGrass -= steep; wRock += steep;

  // ---------------- grass (foreground headland) ----------------
  vec3 grass = vec3(0.0);
  if (wGrass > 1e-3) {
    float n1 = tFbm(wp.xz * 0.16, 4);   // ~6 m patches
    float n2 = tFbm(wp.xz * 0.7 + 3.1, 3); // ~1.5 m
    float n3 = tNoise(wp.xz * 3.3);         // 0.3 m grain
    vec3 green = srgb(vec3(0.40, 0.45, 0.30));
    vec3 dgreen = srgb(vec3(0.28, 0.33, 0.20));
    vec3 dry = srgb(vec3(0.52, 0.48, 0.33));
    vec3 brown = srgb(vec3(0.44, 0.36, 0.31));
    grass = mix(dgreen, green, smoothstep(0.3, 0.7, n2));
    grass = mix(grass, dry, smoothstep(0.55, 0.78, n1) * 0.75);
    float fine = smoothstep(0.25, 0.02, foot);
    grass *= mix(1.0, 0.62 + 0.76 * n3, fine);
    // tufts / blade clumps (~10 cm), elongated downwind
    float tuft = tNoise(vec2(wp.x * 7.0 + wp.z * 3.0, wp.z * 11.0 - wp.x * 2.0));
    grass *= mix(1.0, 0.7 + 0.6 * tuft, smoothstep(0.06, 0.01, foot));
    // needle litter / dead grass under the casuarinas (reddish-brown band behind the trees)
    // (mask from the distance to the cliff edge behind the trees, broken up by noise)
    float eD = 1e3;
    if (wp.z < -25.0 && wp.x > -6.0 && wp.x < 52.0) for (int i = 0; i < 8; i++) {
      vec2 a = uEdgePts[i], b = uEdgePts[i + 1], ab = b - a;
      float h = clamp(dot(wp.xz - a, ab) / dot(ab, ab), 0.0, 1.0);
      eD = min(eD, length(wp.xz - a - ab * h));
    }
    float litter = smoothstep(7.5, 2.5, eD + (tFbm(wp.xz * 0.22 + 3.0, 3) - 0.5) * 6.0)
                 * smoothstep(-4.0, 4.0, wp.x) * smoothstep(50.0, 40.0, wp.x) * smoothstep(-26.0, -33.0, wp.z);
    litter *= smoothstep(0.28, 0.55, tFbm(wp.xz * 0.35 + 7.0, 3) + 0.2);
    brown = srgb(vec3(0.46, 0.30, 0.24)) * (0.7 + 0.6 * tNoise(wp.xz * 3.3 + 1.7));
    grass = mix(grass, brown, clamp(litter, 0.0, 1.0));
    // eroded brow: dark exposed soil and rock patches (2-4 m) within ~6 m of the cliff edge
    float soil = smoothstep(6.0, 1.5, eD + (tFbm(wp.xz * 0.4 + 2.0, 3) - 0.5) * 5.0) * smoothstep(0.42, 0.62, tFbm(wp.xz * 0.35 + 8.0, 3));
    grass = mix(grass, srgb(vec3(0.30, 0.26, 0.22)) * (0.75 + 0.5 * tNoise(wp.xz * 1.6 + 4.0)), soil * 0.85);
    // 0.5-1 m mottling (+-20 %), footprint-faded
    grass *= 1.0 + 0.4 * (tNoise(wp.xz * 1.4 + 9.9) - 0.5) * smoothstep(0.35, 0.15, foot) * smoothstep(12.0, 4.0, eD);
  }

  // ---------------- rock (sandstone / coffee rock) ----------------
  vec3 rock = vec3(0.0);
  float rockRough = 0.9;
  if (wRock > 1e-3) {
    // triplanar-ish: strata follow height, noise from the dominant planar projection
    vec3 an = abs(nG);
    // (biased toward the xy projection: the platform front faces +z, and its fluted outline flipped
    // the projection back and forth, printing vertical striations)
    bool sideX = an.x > an.z * 1.8;
    vec2 pp = an.y > max(an.x, an.z) ? wp.xz : (sideX ? wp.zy : wp.xy);
    float n1 = tFbm(pp * 0.35, 4);
    float n2 = tFbm(pp * 1.7 + 5.0, 3);
    // strata: weak, domain-warped bands (no layer-cake stripes)
    float yw = wp.y + (tFbm(pp * 0.25 + 2.0, 3) - 0.5) * 1.6;
    float strata = sin(yw * 5.5 + n1 * 6.0) * 0.5 + 0.5;
    float strata2 = sin(yw * 1.7 + n2 * 2.0 + wp.x * 0.02) * 0.5 + 0.5;
    vec3 c1 = srgb(vec3(0.72, 0.63, 0.56)); // grey-beige sandstone
    vec3 c2 = srgb(vec3(0.60, 0.51, 0.45)); // coffee rock
    vec3 c3 = srgb(vec3(0.76, 0.71, 0.62)); // pale weathered
    rock = mix(c2, c1, smoothstep(0.25, 0.75, n1));
    rock = mix(rock, c3, smoothstep(0.55, 0.8, n2) * 0.7);
    rock *= mix(0.96, 1.04, strata) * mix(0.95, 1.03, strata2);
    // bedding: 0.4-1.2 m horizontal bands on the faces (sandstone / coffee-rock layers)
    float bed = tFbm(vec2((sideX ? wp.z : wp.x) * 0.05, yw * 1.3 + 0.7), 3);
    rock *= mix(1.0, mix(0.8, 1.12, smoothstep(0.3, 0.7, bed)), smoothstep(0.75, 0.45, nG.y));
    // large weathering patches (darker stained / paler fresh rock, 5-15 m); weaker on the platform
    // (round 5: its face read blotchy / blocky against the reference's even, finely pitted grey)
    float platK = smoothstep(-118.0, -126.0, wp.z);
    rock *= mix(mix(0.72, 1.1, smoothstep(0.3, 0.7, tFbm(pp * 0.09 + 6.0, 2))), 1.0, 0.55 * platK);
    // honeycomb weathering (tafoni): dark cavities with pale rims on the faces
    float faceK = smoothstep(0.75, 0.45, nG.y);
    vec4 tf = tVoronoi(pp * 1.1 + vec2(3.1, 7.7));
    float cav = smoothstep(0.34 + 0.2 * tNoise(pp * 2.7), 0.1, tf.x) * smoothstep(0.55, 0.85, tFbm(pp * 0.35 + 4.0, 2));
    // (edge lines prefiltered: width >= 1.2 px, contrast scaled by w0 / w)
    float wT = max(0.06, 1.2 * foot * 1.1);
    float rimT = smoothstep(wT, 0.0, tf.y - tf.x) * (0.06 / wT);
    float tfK = faceK * smoothstep(0.3, 0.12, foot) * mix(0.55, 1.0, smoothstep(0.10, 0.05, foot));
    rock *= mix(1.0, 0.85, cav * tfK);
    rock *= mix(1.0, 1.2, rimT * tfK * (1.0 - cav));
    ao *= 1.0 - 0.35 * cav * faceK * wRock;
    // vertical joints every 3-8 m on the faces
    float jx = (sideX ? wp.z : wp.x) * 0.2 + (tNoise(pp * vec2(0.3, 0.08)) - 0.5) * 0.5;
    float joint = smoothstep(0.035, 0.0, abs(fract(jx + 0.3 * tHash12(vec2(floor(jx), 3.0))) - 0.5) - 0.46) * faceK;
    rock *= 1.0 - 0.05 * joint * smoothstep(0.4, 0.1, foot);
    // pale salt / lichen crust on ledges
    // (on the platform only its top: the lower benches of the stepped face stay face-coloured,
    // pale bench tops read as stacked columns)
    float topK = mix(1.0, smoothstep(7.0, 9.3, wp.y), smoothstep(-122.0, -132.0, wp.z));
    rock = mix(rock, c3 * 1.1, smoothstep(0.55, 0.8, nG.y) * smoothstep(0.5, 0.7, tNoise(pp * 1.3 + 2.0)) * 0.5 * (1.0 - faceK) * topK);
    // weathered, paler upward-facing rock tops
    rock = mix(rock, c3 * 1.12, smoothstep(0.7, 0.95, nG.y) * 0.55 * topK);
    rock *= mix(1.0, 0.94, smoothstep(0.6, 0.9, nG.y) * (1.0 - topK)); // bench tops: soil / weed-stained
    // lichen specks on upward faces
    float lich = smoothstep(0.72, 0.9, tNoise(wp.xz * 2.1 + 11.0)) * smoothstep(0.5, 0.9, nG.y);
    rock = mix(rock, srgb(vec3(0.62, 0.60, 0.50)), lich * 0.5);
    // cracks / pits (medium/low: skipped once they are sub-pixel, where only a ~1 % AO speckle remains)
#ifdef TERRAIN_LQ
    if (foot < 0.3)
#endif
    {
    vec2 wq = pp * 0.9 + (vec2(tNoise(pp * 0.6), tNoise(pp * 0.6 + 3.3)) - 0.5) * 1.6;
    vec4 vr = tVoronoi(wq);
    float wC = max(0.05, 1.2 * foot * 0.9);
    float crack = smoothstep(wC, 0.0, vr.y - vr.x) * (0.05 / wC) * smoothstep(0.35, 0.6, tNoise(pp * 0.8 + 9.0));
    rock *= 1.0 - 0.35 * crack * smoothstep(0.3, 0.05, foot);
    ao *= 1.0 - 0.2 * crack * wRock;
    }
    // faces: darker and cooler than the weathered tops; dark vertical water/iron streaks,
    // darker coffee rock toward the platform's east end
    float streak = tFbm(vec2((sideX ? wp.z : wp.x) * 0.8, wp.y * 0.25) + 2.3, 3);
    rock *= mix(1.0, 0.9, faceK) * (1.0 - 0.03 * faceK * smoothstep(0.55, 0.8, streak));
    // fractured joint blocks (1.5-3 m) with dark open joints, readable from the lookout
    vec2 bq = vec2(pp.x, pp.y * (faceK > 0.5 ? 1.8 : 1.0)) * 0.42;
    vec4 bk = tVoronoi(bq + (vec2(tNoise(bq * 1.7), tNoise(bq * 1.7 + 4.1)) - 0.5) * 0.5);
    rock *= mix(mix(0.88, 1.1, tHash12(bk.zw + 3.7)), mix(0.96, 1.04, tHash12(bk.zw + 3.7)), platK);
    float wJ = max(0.07, 1.2 * foot * 0.42);
    float bj = smoothstep(wJ, 0.0, bk.y - bk.x) * (0.07 / wJ) * smoothstep(0.3, 0.6, tNoise(bq * 0.9 + 5.5));
    rock *= 1.0 - 0.25 * bj * smoothstep(0.6, 0.12, foot);
    ao *= 1.0 - 0.15 * bj * wRock;
    rock = mix(rock, rock * vec3(1.0, 0.99, 0.97), faceK);
    // weathered micro-relief (0.1-1 m): pitted, granular sandstone with pale grains and dark pits,
    // footprint-filtered (fades before it is under ~2 px)
    float fMic = smoothstep(0.4, 0.14, foot), fMic2 = smoothstep(0.24, 0.09, foot);
    float mt = tFbm(pp * 1.6 + 1.3, 3);
    rock *= mix(1.0, 0.9 + 0.2 * mt, fMic);
    // fine sandstone grain (~0.33 m, 1.5-3 px at the platform), faded by its on-screen period
    rock *= 1.0 + 0.18 * (tNoise(pp * 3.0 + 17.0) - 0.5) * smoothstep(1.5, 3.0, 0.33 / foot);
    // thin bedding lines 0.4-0.8 m apart on the faces (sandstone / coffee-rock laminae)
    {
      float bb = yw * 1.7 + 0.35 * tNoise(pp * vec2(0.25, 0.6) + 3.0);
      float dB = abs(fract(bb) - 0.5) / 1.7;
      float wB = max(0.05, 1.2 * foot);
      rock *= 1.0 - (0.32 + 0.2 * platK) * smoothstep(wB, 0.0, dB) * (0.05 / wB) * faceK * smoothstep(0.3 - 0.25 * platK, 0.6, tNoise(pp * 0.3 + 6.6));
    }
    float pit = smoothstep(0.6, 0.78, tNoise(pp * 2.3 + 4.4));
    float grain = smoothstep(0.66, 0.85, tNoise(pp * 2.1 + 12.7));
    rock *= mix(1.0, (1.0 - 0.4 * pit) * (1.0 + 0.35 * grain), fMic2 * mix(0.6, 1.0, faceK));
    ao *= 1.0 - 0.25 * pit * fMic2 * wRock;
    rock *= mix(1.0, 0.82, smoothstep(45.0, 80.0, wp.x) * smoothstep(-100.0, -125.0, wp.z));
    // wet, darker base near the sea (spray zone), algae-dark just above the waterline
    float wet = smoothstep(3.0, 0.3, wp.y + (n2 - 0.5) * 1.6);
    rock = mix(rock, rock * srgb(vec3(0.8, 0.77, 0.7)), wet);
    // green-brown algae / weed band in the splash zone, dark wet rock at the waterline
    float alg = smoothstep(3.2, 1.6, wp.y + (n2 - 0.5) * 1.2) * smoothstep(-0.2, 0.9, wp.y) * smoothstep(0.3, 0.6, tNoise(pp * 0.9 + 3.3) + 0.2);
    rock = mix(rock, srgb(vec3(0.33, 0.29, 0.22)), alg * 0.35);
    float wet2 = smoothstep(0.8, 0.1, wp.y);
    rock = mix(rock, srgb(vec3(0.16, 0.15, 0.13)), wet2 * 0.6);
    rockRough = mix(mix(0.88, 0.55, wet), 0.3, wet2);
    // headland rim / cliff: darker weathered coffee rock and soil
    rock = mix(rock, srgb(vec3(0.30, 0.29, 0.28)) * (0.75 + 0.5 * n2), clamp(misc.z, 0.0, 1.0) * 0.8);
    // bare ground on the headland top (layout.bareRockAt, carried in aEdge on the fg mesh): the
    // lower-left brow knob (8-12 m, ~1 cm/px) and the band along the left cliff edge (12-35 m).
    // Reference (in the shade): dark, cool grey-brown ~(50-58, 55-62, 57-70), paler weathered crust
    // on the block tops, dark crevices / undercuts, dead litter, sparse green tufts. Every octave is
    // faded by the footprint of its own coordinates (the band is seen at 10-15 deg grazing).
    float bareK = wp.z > -60.0 ? clamp(vEdge, 0.0, 1.0) : 0.0;
    if (bareK > 0.0) {
      // (height mixed into the texture coordinates: the knob's steep faces get texture instead of
      // vertical smears)
      vec2 bq = wp.xz + vec2(0.6, -1.3) * wp.y;
      float fq = max(max(fw.x, fw.y), fwidth(wp.y) * 1.3); // m per pixel along the most compressed axis
      float o1 = tFbmF(bq * 1.9 + 3.0, 3, fq * 1.9);
      float o2 = tNoise(bq * 6.5 + 1.0) - 0.5;
      float o3 = tNoise(bq * 15.0 + 5.0) - 0.5;
      float g2 = smoothstep(0.5, 0.25, fq * 6.5), g3 = smoothstep(0.5, 0.25, fq * 15.0);
      float nearB = smoothstep(16.0, 11.0, dist); // the knob (rock, paler crust) vs the far band (soil / litter)
      vec3 bc = mix(srgb(vec3(0.37, 0.37, 0.33)), srgb(vec3(0.47, 0.44, 0.43)), nearB);
      // paler weathered crust in 0.2-0.6 m patches (mostly on the knob's block tops)
      float o1b = tFbmF(bq * 3.7 + 11.0, 2, fq * 3.7);
      bc = mix(bc, mix(srgb(vec3(0.56, 0.53, 0.53)), srgb(vec3(0.64, 0.61, 0.61)), nearB), smoothstep(0.5, 0.68, o1 * 0.6 + o1b * 0.4 + 0.3 * o2 * g2) * smoothstep(0.3, 0.7, nG.y) * mix(0.35, 0.5, nearB));
      bc *= max(0.25, 1.0 + 1.3 * o2 * g2 + 0.9 * o3 * g3);
      // knob: crumbly clutter at 8-20 cm (8-20 px), pale lichen-grey crust bits on dark rock, so it
      // reads rough rather than as smooth draped lumps (the reference rock is strongly mottled)
      {
        // (z frequency halved: the knob top is foreshortened ~2.4x, so the bits stay roughly round on
        // screen instead of printing as horizontal marble streaks)
        vec2 cq = vec2(bq.x, bq.y * 0.5);
        float cl = (tNoise(cq * 7.0 + 41.0) - 0.5) * g2 + (tNoise(cq * 16.0 + 3.0) - 0.5) * 0.6 * g3;
        float cm = smoothstep(0.03, 0.17, cl) * smoothstep(0.3, 0.6, tNoise(cq * 3.1 + 17.0));
        bc *= mix(1.0, mix(0.86, 1.6, cm), nearB);
      }
      // olive moss / grass mottling on the band (0.5-1 m), dark gaps
      bc = mix(bc, srgb(vec3(0.33, 0.37, 0.28)), smoothstep(0.45, 0.65, o1b) * (1.0 - nearB) * 0.6);
      bc *= mix(1.0, 0.7, smoothstep(0.42, 0.28, o1) * (1.0 - nearB));
      bc *= mix(1.0, 0.55, smoothstep(0.62, 0.25, nG.y)); // crevices / undercut faces
      // fine dark cracks / joints between crumbly blocks (knob only, prefiltered: >= ~1.5 px wide)
      {
        float cn = tNoise(bq * 5.2 + 31.0) * 0.7 + tNoise(bq * 10.5 + 7.0) * 0.3;
        float wc = max(0.04, fq * 5.2 * 1.5 * 0.5);
        bc *= 1.0 - 0.5 * smoothstep(wc, 0.0, abs(cn - 0.5)) * (0.04 / wc) * g2 * nearB;
      }
      // dead litter (dark twig debris) and sparse green tufts
      float lit = smoothstep(0.57, 0.7, tFbmF(bq * 3.1 + 17.0, 3, fq * 3.1));
      bc = mix(bc, srgb(vec3(0.25, 0.22, 0.2)), lit * 0.55);
      float tu = smoothstep(0.62, 0.7, tFbmF(bq * 4.3 + 9.0, 3, fq * 4.3) + 0.12 * o3 * g3) * smoothstep(0.4, 0.8, nG.y);
      bc = mix(bc, srgb(vec3(0.34, 0.40, 0.25)) * (0.85 + 0.5 * o2 * g2), tu * 0.85);
      rock = mix(rock, bc, bareK);
      rockRough = mix(rockRough, 0.92, bareK);
      ao *= 1.0 - 0.3 * bareK * smoothstep(0.7, 0.3, nG.y);
      vec3 bb = vec3(tNoise(bq * 6.5 + 2.0) - 0.5, 0.0, tNoise(bq * 6.5 + 6.0) - 0.5) * g2
              + vec3(o3, 0.0, tNoise(bq * 15.0 + 8.0) - 0.5) * 0.6 * g3;
      nW = normalize(nW + bb * mix(0.9, 1.6, nearB) * bareK);
    }
    // platform faces (in the dune/headland shade, lit by the bright sky): the east shelf lighter and
    // neutral-cool (reference mid-face ~(97,103,100)), the stepped west end darker (~(81,83,81))
    rock *= mix(vec3(1.0), mix(vec3(1.12, 1.1, 1.12), vec3(1.72, 1.74, 1.78), smoothstep(12.0, 22.0, wp.x)), smoothstep(0.7, 0.4, nG.y) * smoothstep(-110.0, -135.0, wp.z));
    rock *= mix(vec3(1.0), vec3(0.975, 1.0, 1.05), platK * faceK); // neutral-cool grey (reference B ~ R)
    // sunlit top lip: weathered pale crust along the platform's upper edge catching the low sun
    float lip = vEdge * smoothstep(0.55, 0.85, nG.y) * smoothstep(7.5, 9.0, wp.y) * step(wp.z, -100.0);
    rock = mix(rock, c3 * vec3(1.32, 1.24, 1.06), lip * mix(0.45, 0.85, vMisc.x));
    // platform top: rough salt-crusted, pitted surface (pale warm specks and dark pits, 2-4 px),
    // faded by its on-screen period
    {
      float crustK = smoothstep(0.5, 0.8, nG.y) * smoothstep(7.0, 9.0, wp.y) * smoothstep(-122.0, -132.0, wp.z);
      float cN = tNoise(pp * 2.0 + 21.0) * 0.65 + tNoise(pp * 3.1 + 5.0) * 0.35 * smoothstep(1.5, 3.0, 0.32 / foot);
      float cF = smoothstep(1.5, 3.0, 0.5 / foot);
      rock *= mix(1.0, mix(0.62, 1.35, smoothstep(0.25, 0.75, cN)), crustK * cF);
      rock = mix(rock, srgb(vec3(0.86, 0.82, 0.72)), crustK * smoothstep(0.66, 0.85, cN) * 0.6 * cF);
      rock *= mix(1.0, 1.12, crustK);
    }
    // bump
    float bs = 0.45 * smoothstep(0.5, 0.05, foot);
    vec3 bump = vec3(tNoise(pp * 1.9 + 1.0) - 0.5, tNoise(pp * 1.9 + 4.0) - 0.5, tNoise(pp * 1.9 + 7.0) - 0.5);
    bump += (vec3(tNoise(pp * 3.7 + 2.0), tNoise(pp * 3.7 + 5.0), tNoise(pp * 3.7 + 9.0)) - 0.5) * 0.8 * smoothstep(0.12, 0.05, foot);
    bump.y *= faceK;
    nW = normalize(nW + bump * bs * wRock);
    // platform faces: the 0.4 m heightfield grid staircases the steep, ledged faces, so the vertex
    // normals alternate steep / flat column by column (pale vertical striations under the sky
    // light). Damp the normal's vertical component there toward a typical face value.
    float platF = smoothstep(-122.0, -132.0, wp.z) * smoothstep(0.2, 1.5, wp.y) * (1.0 - topK) * wRock;
    nW.y = mix(nW.y, 0.3, 0.7 * platF * smoothstep(0.9, 0.5, nG.y));
    nW = normalize(nW);
  }

  // ---------------- sand ----------------
  vec3 sand = vec3(0.0);
  float sandRough = 0.95;
  if (wSand + wVeg > 1e-3) {
    float s = misc.y; // signed distance from the mean waterline (+ = land)
    float n = tFbm(wp.xz * 0.05, 3);
    // cool pale grey (the beach is in the dune shade: reference ~(154,169,177))
    vec3 dry = srgb(vec3(0.80, 0.795, 0.79));
    vec3 damp = srgb(vec3(0.70, 0.705, 0.71));
    vec3 wet = srgb(vec3(0.53, 0.55, 0.555));
    float wetK = smoothstep(14.0 + 6.0 * n, 2.0, s);
    sand = mix(dry, damp, smoothstep(26.0, 12.0, s + (n - 0.5) * 10.0));
    sand = mix(sand, wet, wetK);
    // swash-wet band: glossy, mirrors the bright sky at grazing angles (Fresnel from the PBR specular)
    sandRough = mix(mix(0.95, 0.35, wetK), 0.14, smoothstep(6.0, 2.5, s));
    // along-shore line features in (s, u) space, each prefiltered by the cross-shore footprint
    // (width w >= 1.5 px, contrast scaled by w0 / w so they fade instead of aliasing):
    // 4WD tyre ruts (twin tracks 1.7 m apart, wandering, fading in and out along the beach),
    // a darker strandline (weed / debris) at the last high tide, fine wind-ripple shading
    {
      float u = -wp.z;
      float rut = 0.0, band = 0.0;
      float wR = max(0.35, 1.5 * fsS);
      for (int i = 0; i < 9; i++) {
        float fi = float(i);
        float si = 8.0 + fi * 4.6 + 3.0 * tHash12(vec2(fi, 3.1)) + 6.0 * (tNoise(vec2(u * 0.004 + fi * 3.7, fi)) - 0.5) + 1.6 * (tNoise(vec2(u * 0.023, fi * 1.3 + 5.0)) - 0.5);
        float pres = smoothstep(0.3, 0.55, tNoise(vec2(u * 0.006 + fi * 5.1, 2.0 + fi))) * smoothstep(0.3, 0.5, tNoise(vec2(u * 0.035 + fi * 2.3, 9.0 + fi)));
        float d = min(abs(s - si), abs(s - si - 1.7));
        rut = max(rut, pres * smoothstep(wR, 0.0, d));
        // the churned 2.5 m track band itself (darker, survives the footprint as a streak)
        float wBd = max(1.25, fsS);
        band = max(band, pres * smoothstep(wBd, 0.4 * wBd, abs(s - si - 0.85)) * (1.25 / wBd));
      }
      float rk = smoothstep(5.0, 9.0, s) * smoothstep(62.0, 48.0, s);
      sand *= (1.0 - 0.42 * rut * (0.35 / wR) * rk) * (1.0 - 0.32 * band * rk);
      // churned soft sand between the tracks (darker, streaky)
      sand *= 1.0 - 0.07 * smoothstep(0.35, 0.75, tNoise(vec2(s * 0.45, u * 0.012))) * rk;
      // debris, footprints and broken track fragments on the upper beach and fore-dune toe: short
      // dark horizontal dashes on angular coordinates from the lookout (3-12 px long, 1-3 px tall;
      // periods >= 2.5 px so they never sparkle)
      {
        vec3 relD = wp - vec3(0.0, 35.0, 0.0);
        vec2 Pd = vec2(atan(relD.x, -relD.z), atan(relD.y, max(length(relD.xz), 1.0))) / uTPix;
        float dA = tNoise(vec2(Pd.x * 0.15, Pd.y * 0.4) + 11.0) * 0.7 + tNoise(vec2(Pd.x * 0.26, Pd.y * 0.4) + 3.3) * 0.3;
        float dM = smoothstep(0.66, 0.8, dA) * smoothstep(0.35, 0.6, tNoise(Pd * 0.025 + 1.1));
        float dz = smoothstep(14.0, 24.0, s) * smoothstep(sEdge + 2.0, sEdge - 8.0, s);
        sand *= 1.0 - 0.26 * dM * dz;
        sand *= 1.0 + 0.08 * smoothstep(0.55, 0.3, dA) * dz; // loose dry sand between them: brighter
      }
      float sl = 12.5 + 2.2 * (tNoise(vec2(u * 0.012, 7.7)) - 0.5) * 2.0;
      float wS = max(0.7, 1.5 * fsS);
      float strand = smoothstep(wS, 0.0, abs(s - sl)) * (0.7 / wS) * smoothstep(0.25, 0.55, tNoise(vec2(u * 0.05, 1.3)));
      sand *= 1.0 - 0.35 * strand;
      float rip = tNoise(vec2(s * 2.2 + tNoise(vec2(u * 0.3, s * 0.2)) * 1.5, u * 0.35));
      sand *= 1.0 + 0.1 * (rip - 0.5) * smoothstep(0.35, 0.15, max(fsS, foot)) * smoothstep(8.0, 14.0, s);
    }
    {
      // foot / tyre tracks and wind-ripple streaks seen at grazing angle: screen-space (angular from
      // the lookout) so they stay 2-4 px tall at any range and never alias
      vec3 relB = wp - vec3(0.0, 35.0, 0.0);
      vec2 Pb = vec2(atan(relB.x, -relB.z), atan(relB.y, max(length(relB.xz), 1.0))) * 330.0;
      float trkN = tNoise(vec2(Pb.x * 0.22, Pb.y * 1.1) + 2.2) * 0.6 + tNoise(vec2(Pb.x * 0.6, Pb.y * 1.4) + 7.1) * 0.4;
      float bz = smoothstep(3.0, 8.0, s) * smoothstep(60.0, 35.0, s);
      sand *= mix(1.0, (0.85 + 0.22 * smoothstep(0.2, 0.8, trkN)) * 0.95, bz);
    }
    // along-shore streaks / tracks at 1-3 m
    sand *= 0.93 + 0.14 * tNoise(vec2(s * 0.6, wp.z * 0.02 + 3.0)) * smoothstep(3.0, 0.4, foot);
    // darker damp band 3-12 m above the waterline
    sand *= mix(1.0, 0.82, smoothstep(2.0, 4.0, s) * smoothstep(13.0, 9.0, s + (n - 0.5) * 6.0));
    // vehicle tracks / trampled sand on the upper beach (Main Beach is a 4WD beach)
    float trk = smoothstep(0.43, 0.49, abs(fract((s + 3.0 * tNoise(vec2(wp.z * 0.004, 1.0))) / 7.0) - 0.5));
    sand *= 1.0 - 0.08 * trk * smoothstep(10.0, 18.0, s) * smoothstep(34.0, 26.0, s) * smoothstep(1.2, 0.2, foot);
    // sea floor: darker, deeper = darker
    // (wet-sand grey for the first 0.8 m below sea level, where the swash water is thin)
    float under = smoothstep(-0.8, -3.0, wp.y);
    sand = mix(sand, srgb(vec3(0.50, 0.46, 0.36)) * 0.7, under);
  }

  // ---------------- canopy (dune scrub / forest) ----------------
  // Crowns are spheres sitting on the ground, one per jittered xz cell (4.5 m scrub -> 11 m
  // forest), ray-traced per pixel against the view ray (4x4 cells, shifted toward the camera) so
  // they stay round and occlude each other even on hill faces seen at grazing angles. The hit
  // point gives a true sphere normal for the sun/sky lighting; crown-to-crown and crown-to-gap
  // sun shadows are tested against the same candidates. Faded to a prefiltered mean when the
  // crowns become sub-pixel.
  vec3 veg = vec3(0.0);
  float cov = 1.0;      // crown coverage at this pixel
  float vegSun = 1.0;
  vec3 vegN = nG;
  float vegW = 0.0;
  float detail = 0.0;
  float vegAO = 1.0;
  // (sEdge >= 20, and below sEdge - 6.1 the sand/scrub boundary below gives exactly
  // zero vegetation whatever the crowns do: no fbm / crown work there, identical result)
  if (wVeg > 1e-3 || (wSand > 1e-3 && misc.y > sEdge - 6.1)) {
    float inland = clamp((misc.y - 60.0) / 900.0, 0.0, 1.0);
    // scrub knoll at the beach end (reference: dark green bush crowns, yellow-green sunlit rims)
    float knK = smoothstep(1.35, 0.85, length((wp.xz - vec2(134.0, -200.0)) / vec2(20.0, 28.0)));
    float fk = smoothstep(60.0, 700.0, misc.y);
    float cell = mix(4.8, 12.5, fk);
    vec3 v = normalize(wp - cameraPosition);
    float tp = dot(wp - cameraPosition, v);
    float pw = tp * uTPix * 0.885; // pixel size at this depth (m; 0.0009 * tp at 718 rows)
    vec2 g = wp.xz / cell;
    vec2 vx = normalize(v.xz + 1e-5);
#ifdef TERRAIN_LQ
    // medium/low: 3x3 candidate crowns (no crown shadow march, so no candidate arrays)
    const int TC = 3;
    vec2 base = floor(g - vx * 0.7) - 1.0;
#else
    const int TC = 4;
    vec2 base = floor(g - vx * 1.2) - 1.0;
#endif
    float bestT = 1e9; vec3 bC = vec3(0.0); float bR = 1.0; float bD = 1e9; float bId = 0.0; float covAny = 0.0;
    // (resolved out to ~2.5 km: the near hills show individual 4-8 px crowns in the reference)
#ifdef TERRAIN_LQ
    detail = smoothstep(1.2, 3.0, cell * 0.47 / pw) * smoothstep(1600.0, 1000.0, tp);
#else
    detail = smoothstep(1.2, 3.0, cell * 0.47 / pw) * smoothstep(2700.0, 1900.0, tp);
#endif
    // where the view grazes the canopy (swale / crest at 1-4 deg) the jittered crown rows band into
    // horizontal streaks: the angular-space crown mosaic below replaces the trace there
    float gz = smoothstep(0.24, 0.08, abs(dot(v, nG))) * smoothstep(380.0, 620.0, tp) * smoothstep(2600.0, 1900.0, tp);
    detail *= 1.0 - gz;
    // Every per-crown term below is weighted by 'detail' (0 beyond 1 km or for sub-1.2 px crowns),
    // so the crown ray-trace, leaf noise and crown shadows are skipped there (identical result).
    vec3 H = wp, hn = nG; float leafA = 1.0, shd = 0.0;
    if (detail > 0.0) {
#ifndef TERRAIN_LQ
    vec3 Cs[16]; float Rs[16];
#endif
    // ragged crown outlines: the silhouette radius varies with the direction around the crown
    // (screen-plane angle), so bushes read as lumpy foliage masses instead of smooth pebbles
    vec3 rgt = normalize(cross(v, vec3(0.0, 1.0, 0.0))); vec3 upv = cross(rgt, v);
#ifdef TERRAIN_LQ
    const float ragK = 0.0;
#else
    float ragK = smoothstep(1.5, 4.0, cell * 0.47 / pw);
    // (deep in the shaded dune front the crown outlines are flattened away below (sfr): no ragged
    // outlines there, which also skips their per-candidate noise on that ~12 % of the screen)
    ragK *= 1.0 - smoothstep(-0.12, -0.2, dot(nG, normalize(uSunDir))) * smoothstep(250.0, 380.0, tp) * smoothstep(40.0, 28.0, wp.y) * (1.0 - knK);
#endif
    for (int j = 0; j < TC; j++) for (int i = 0; i < TC; i++) {
      vec2 id = base + vec2(float(i), float(j));
      vec2 cxz = (id + 0.15 + 0.7 * tHash22(id)) * cell;
      float hr = tHash12(id + 7.7);
      // clumping: dense bush masses / tree groups with clearings and gaps between them (~30-60 m)
      float gapN = tNoise(id * (cell / 34.0) + 2.3) * 0.65 + tNoise(id * (cell / 13.0) + 8.1) * 0.35;
      float R = cell * (0.40 + 0.36 * hr * hr) * mix(1.12, 0.78, gapN) * step(mix(0.03, 0.34, smoothstep(0.45, 0.8, gapN)), tHash12(id + 3.3));
      float gy = tGround(cxz);
      vec3 C = vec3(cxz.x, gy + mix(0.05, 0.6, tHash12(id + 5.1)) * R, cxz.y);
#ifndef TERRAIN_LQ
      int k = j * 4 + i; Cs[k] = C; Rs[k] = R;
#endif
      vec3 w = C - cameraPosition; float tc = dot(w, v); float d2 = dot(w, w) - tc * tc;
      vec3 pe = w - v * tc;
      vec2 o2 = vec2(dot(pe, rgt), dot(pe, upv)) / max(R, 1e-3);
      float Rr = R;
      if (ragK > 0.0) Rr *= mix(1.0, 0.76 + 0.4 * (tNoise(o2 * 2.3 + id * 7.31) * 0.7 + tNoise(o2 * 5.1 + id * 3.7) * 0.3), ragK);
      float Re = Rr + pw;
      if (d2 < Re * Re) {
        float th = tc - sqrt(max(Rr * Rr - d2, 0.0));
        if (th < tp + 0.5 * R) {
          covAny = max(covAny, smoothstep(Rr + pw, Rr - pw, sqrt(d2)));
          if (th < bestT) { bestT = th; bC = C; bR = R; bD = sqrt(d2); bId = hr; }
        }
      }
    }
    H = bestT < 1e8 ? cameraPosition + v * bestT : wp;
    hn = bestT < 1e8 ? normalize(H - bC + (tHash22(bC.xz * 0.37) - 0.5).xyx * vec3(0.9, 0.0, -0.9) * bR) : nG;
    // leaf-clump detail inside the crown (0.6-1 m): breaks the smooth sphere shading
    vec2 lq = vec2(H.x + 0.6 * H.y, H.z - 0.6 * H.y) * 1.3;
    float lc = tNoise(lq), lc2 = tNoise(lq * 2.1 + 3.7);
    // branch masses (~2.5 m): lumpy crowns once the 0.8 m leaf clumps are sub-3 px
    float lb = tNoise(lq * 0.3 + 5.5), lb2 = tNoise(lq * 0.3 + 1.9);
    float fLeaf = smoothstep(2.6, 5.0, 1.0 / pw), fBr = smoothstep(0.9, 2.2, 1.0 / pw);
    // (faded out once the clumps are ~1-3 px: sub-crown sun glints read as yellow speckle there)
    hn = normalize(hn + (vec3(lc, lc2, tNoise(lq + 9.1)) - 0.5) * 1.3 * fLeaf + (vec3(lb, 0.5, lb2) - 0.5) * 1.1 * fBr * (1.0 - fLeaf));
    hn = normalize(vec3(hn.x, max(hn.y, 0.2), hn.z)); // foliage: no dark sphere undersides
    leafA = mix(1.0, 0.7 + 0.6 * (lc * 0.65 + lc2 * 0.35), fLeaf);
    leafA *= mix(1.0, 0.6 + 0.8 * (lb * 0.6 + lb2 * 0.4), fBr * (1.0 - 0.5 * fLeaf));
    // sun shadow from the other crowns (and on the gaps between them)
    vec3 Ls = normalize(uSunDir);
#ifndef TERRAIN_LQ
    for (int k = 0; k < 16; k++) {
      vec3 w = Cs[k] - H; float ts = dot(w, Ls);
      if (ts > 0.2 * Rs[k] && distance(Cs[k], bC) > 0.01) {
        float d2 = dot(w, w) - ts * ts;
        shd = max(shd, smoothstep(Rs[k] * Rs[k] * 1.0, Rs[k] * Rs[k] * 0.55, d2));
      }
    }
#endif
    }
    cov = covAny;
    // Faces turned away from the 7 deg sun (the sea-facing dune front, dot(n, sun) ~ -0.2..-0.28):
    // the canopy there is shaded by the crowns upslope, so it gets no direct / wrapped /
    // transmitted sun at all; the crest and swale behind it (dot ~ +0.02..+0.14) stay lit.
    // (reference: a flat, dark, blue-grey scrub mass on the dune front below a broad golden crest
    // band). Crowns poking up at the shadow line keep a little light (their own normal).
    vec3 LsB = normalize(uSunDir);
    // angular coordinates from the (fixed) lookout, ~1 unit per pixel at 718 rows
    vec3 relS = wp - vec3(0.0, 35.0, 0.0);
    vec2 Ps = vec2(atan(relS.x, -relS.z), atan(relS.y, max(length(relS.xz), 1.0))) * 1020.0;
    float pxS = 1.0 / (1020.0 * uTPix); // pixels per Ps unit
    // ragged lower edge of the lit crest band: shrub clumps (~8 x 5 px) on the upper face poke
    // up into the sun
    float bfN = tNoise(Ps * vec2(0.12, 0.2) + 2.7) * 0.65 + tNoise(Ps * vec2(0.26, 0.36) + 8.3) * 0.35 * smoothstep(2.5, 4.0, pxS / 0.3);
    float bfD = dot(nG, LsB) + 0.1 * (dot(hn, LsB) - dot(nG, LsB)) * cov * detail + 0.1 * (bfN - 0.5);
    // the scrub at the dune toe (it reaches down to ~20 m above the waterline beyond ~0.6 km, on
    // the gentle lower slope) is in the shade of the dune front above it
    bfD -= 0.3 * smoothstep(72.0, 52.0, misc.y);
    float azR = Ps.x / 1020.0; // azimuth from the lookout (rad, + right)
    // the near crest band (in front of ~1.25 km) tapers out toward the near end of the beach: full
    // and thick to ~21 deg, thinning from below to ~25 deg, gone (in shade, like the dune front,
    // with only a pale rim) beyond ~26 deg (reference: ends at x ~1100-1120 at t = 0.5 at every
    // time); a broad ~80 px term varies its thickness along its length
    float nearC = smoothstep(1250.0, 1050.0, tp) * (1.0 - knK);
    bfD += 0.1 * (tNoise(Ps * vec2(0.012, 0.05) + 5.0) - 0.5) - 0.16 * smoothstep(0.37, 0.45, azR) * nearC;
    float bfK = mix(1.0, smoothstep(-0.25, -0.01, bfD), smoothstep(3200.0, 2400.0, tp) * smoothstep(120.0, 200.0, tp) * smoothstep(40.0, 28.0, wp.y) * (1.0 - knK));
    float azE = smoothstep(0.465, 0.425, azR + 0.04 * (bfN - 0.5));
    // (beyond the taper the crest scrub is not golden and only half lit, but it is not the dark
    // shaded front either: reference ~(98,108,106) there, like the swale but cooler)
    float azT = mix(1.0, azE, nearC * smoothstep(40.0, 28.0, wp.y));
    float bfK0 = bfK;
    bfK *= azT;
    // left of ~12 deg azimuth the far dune crests catch no golden light in the reference (grey-blue
    // ~(93,103,108) above the dark front; the golden crest band starts at ~13 deg)
    // (the near crest band itself, in front of ~1.1 km, only right of ~16.5 deg)
    float azM = mix(1.0, smoothstep(0.185, 0.235, azR) * mix(1.0, smoothstep(0.3, 0.33, azR), smoothstep(750.0, 900.0, tp) * smoothstep(1250.0, 1050.0, tp)), smoothstep(550.0, 750.0, tp) * smoothstep(2000.0, 1600.0, tp) * smoothstep(45.0, 30.0, wp.y));
    // back-dune crests beyond ~1.1 km (right of ~13 deg): the 3-5 m crowns stand above the baked
    // ground-level shadow of the low sun -> broken golden patches (~50 x 15 px; reference rows
    // 146-158 at x 870-1030, ~(117,118,104))
    float cbP = smoothstep(0.3, 0.5, tNoise(Ps * vec2(0.012, 0.06) + 7.3));
    // (applied after the face / azimuth masks: these crowns stand in the sun whatever the ground does)
    // (upper tier: ~14-21 deg azimuth only; right of it the reference back dunes are dark scrub)
    float azP = azR + 0.04 * (bfN - 0.5);
    float poke = cbP * smoothstep(950.0, 1100.0, tp) * smoothstep(2400.0, 2000.0, tp) * smoothstep(36.0, 29.0, wp.y)
               * smoothstep(0.22, 0.27, azP) * smoothstep(0.39, 0.34, azP) * smoothstep(-0.45, -0.25, dot(nG, LsB)) * smoothstep(14.0, 20.0, wp.y) * (1.0 - knK);
    // (the blurred bake gives the crest band a soft 6-row top edge; the reference edge is sharp;
    // crowns poke 2-4 px above the shadow line)
    float crR = smoothstep(350.0, 450.0, tp) * smoothstep(1300.0, 1100.0, tp) * smoothstep(40.0, 28.0, wp.y) * (1.0 - knK);
    float sunV = mix(vMisc.x, smoothstep(0.05, 0.35, vMisc.x + 0.3 * (tNoise(Ps * vec2(0.2, 0.3) + 1.7) - 0.5)), crR);
    // (upper tier: reference ~(114,115,101), dimmer than the main band but as golden)
    float vS = max(sunV * bfK * azM, 0.8 * poke);
    sunV = max(sunV, 0.45 * poke);
    bfK = max(bfK, poke);
    bfK0 = max(bfK0, poke);
    float bfL = bfK0 * mix(0.8, 1.0, azT); // direct-sun mask
    azM = max(azM, poke);
    gSunVis = sunV;
    float resolvedN = detail * smoothstep(2.0, 5.0, cell * 0.47 / pw);
    // dune scrub beyond the knoll: softer per-crown sun contrast (the hill forest keeps some)
    float farSoft = smoothstep(250.0, 600.0, tp) * (1.0 - 0.6 * smoothstep(800.0, 1300.0, tp));
    // (the shaded beach-front scrub band ~300-800 m reads as dark, flat, fine-textured masses in
    // the reference: weak per-crown modelling there, no pale crown tops)
    float nearBand = smoothstep(250.0, 350.0, tp) * smoothstep(900.0, 700.0, tp);
    // (1.1-1.8 km hill forest: weaker crown / gap contrast; reference hills are a smooth slate canopy)
    float hillSm = smoothstep(1100.0, 1800.0, tp);
    float gapAO = mix(mix(mix(0.72, 0.88, nearBand), 0.9, hillSm), 1.0, cov);
    float rimAO = bestT < 1e8 ? mix(mix(0.8, 0.95, nearBand), 1.0, smoothstep(-0.3, 0.5, dot(hn, nG))) : 1.0; // lower crown flanks
    float nWgt = max(mix(0.75, 0.15, farSoft) * (1.0 - 0.6 * nearBand), 0.8 * smoothstep(700.0, 1100.0, tp));
    // (also where the view grazes the canopy: sphere-normal modelling there reads as pebbles and
    // oblique streaks on the dune faces)
    float grazeF = smoothstep(0.3, 0.12, abs(dot(v, nG)));
    nWgt = min(nWgt, mix(1.0, 0.1, max(nearBand, grazeF)));
    // hill faces above ~45 m beyond ~0.9 km: the reference forest there is a smooth, cool grey-green
    // canopy, no rows of rounded sunlit crowns ('cauliflower' banding)
    float hM = smoothstep(42.0, 55.0, wp.y) * smoothstep(800.0, 1100.0, tp);
    nWgt *= 1.0 - 0.7 * hM;
    vegN = normalize(mix(nG, hn, nWgt * cov * resolvedN)); // small crowns: no per-crown sun glints
    vegN = normalize(mix(vegN, vec3(0.0, 1.0, 0.0), 0.55 * (1.0 - detail) * smoothstep(250.0, 500.0, misc.y)));
    vegSun = mix(0.8, 1.0 - mix(0.92, 0.2, farSoft) * (1.0 - 0.5 * hillSm) * shd, detail);
    vegAO = mix(0.7, gapAO * rimAO, detail) * 0.72; // dense foliage self-occlusion
    // colours: sun-tipped yellow-olive crowns, bluish-green shade, distance -> blue-grey
    float big = tFbm(wp.xz * 0.004 + 2.0, 3);
    float mid = tFbm(wp.xz * 0.02, 3);
    float stand = tFbm(wp.xz * 0.018 + 1.7, 2);
    vec3 olive = srgb(vec3(0.30, 0.355, 0.31));
    vec3 yellow = srgb(vec3(0.56, 0.54, 0.37));
    vec3 blue = srgb(vec3(0.285, 0.345, 0.35));
    vec3 dark = srgb(vec3(0.11, 0.14, 0.13));
    veg = mix(olive, blue, clamp(smoothstep(0.35, 0.75, big) * 0.5 + inland * 1.3, 0.0, 1.0));
    veg = mix(veg, yellow, smoothstep(0.5, 0.8, mid) * 0.3 * (1.0 - inland * 0.7));
    // cool green-teal forest (reference: B >= G > R in shade); the beach-front dune scrub is a
    // greyer olive
    veg *= mix(vec3(0.98, 0.95, 1.0), vec3(0.9, 0.97, 1.07), smoothstep(0.05, 0.3, inland));
    // sunlit scrub tops: golden-olive under the low sun (reference ~(115,113,96) on the backshore
    // and swale scrub), fading out inland where the forest stays cool
    vec3 golden = srgb(vec3(0.50, 0.47, 0.33));
    veg = mix(veg, veg * vec3(1.5, 1.2, 0.68), vS * (1.0 - 0.6 * inland));
    float resolved = detail * detail * smoothstep(3.0, 5.0, cell * 0.47 / pw);
    leafA = mix(leafA, 1.0, 0.5 * nearBand);
    veg *= mix(1.0, mix(0.74 + 0.52 * bId, 0.93 + 0.14 * bId, nearBand) * mix(1.0, leafA, cov), detail * mix(0.35, 1.0, resolved) * (1.0 - 0.65 * smoothstep(1200.0, 2200.0, tp)));
    // bush-mass / tree-group variation (~10-30 m): sage, olive and dark-green masses
    float massN = tNoise(wp.xz / 26.0 + 4.2) * 0.6 + tNoise(wp.xz / 9.0 + 1.1) * 0.4;
    veg *= mix(vec3(1.0), mix(vec3(0.72, 0.78, 0.74), vec3(1.16, 1.14, 1.04), smoothstep(0.25, 0.75, massN)), detail * (1.0 - 0.6 * nearBand) * (1.0 - 0.45 * smoothstep(1300.0, 2200.0, tp)));
    // sun-facing crown flanks catch the golden light: a soft tint on sunlit crowns only (bright
    // per-crown tips read as yellow speckle at this range, and in the dune shade they had no sun)
    float contK = 1.0 - 0.7 * smoothstep(500.0, 900.0, tp); // per-crown sun contrast beyond ~0.5 km
    veg = mix(veg, golden, smoothstep(0.0, 0.9, dot(hn, normalize(uSunDir))) * 0.22 * cov * resolved * vS * mix(1.0, 0.4, farSoft) * contK);
    float gapF = mix(0.42 + 0.3 * (1.0 - resolved) + 0.3 * nearBand, 0.8, vS * smoothstep(400.0, 700.0, tp));
    gapF = max(gapF, 0.7 * knK);
    gapF = max(gapF, 0.88 * nearBand);
    gapF += (0.9 - gapF) * 0.75 * smoothstep(1200.0, 2200.0, tp); // (reference far hills: smooth slate canopy)
    veg = mix(veg * 0.85, mix(mix(dark, veg, min(gapF, 0.9)), veg, cov), detail);
    float grp = tFbm(wp.xz * 0.05 + 9.1, 2);
    // near dune-scrub band behind the beach (~0.3-0.7 km, mostly in the dune shade): cooler grey-green
    // shrub masses with stronger group contrast (reference: mid ~(86,93,94), crowns 74-115)
    float nb = detail * smoothstep(200.0, 300.0, tp) * smoothstep(1100.0, 800.0, tp);
    veg *= mix(vec3(1.0), vec3(1.12, 0.95, 1.18) * mix(0.88, 1.12, smoothstep(0.3, 0.7, grp)), nb);
    // sun-facing crowns on its lit upper edge: golden tops
    veg = mix(veg, golden * 1.3, nb * vS * smoothstep(0.2, 0.8, dot(hn, normalize(uSunDir))) * cov * 0.55 * contK);
    // the sunlit crest band above the shaded dune front: warm golden-olive (reference peak
    // ~(127,126,106): R ~ G, B ~20 levels below)
    // (beyond ~1.1 km it continues as broken golden patches, ~50 x 15 px, on the sunlit back-dune
    // crests: reference ~(117,118,104) over rows 146-158 right of ~13 deg)
    float cbK = vS * smoothstep(300.0, 450.0, tp) * mix(1.0, cbP, smoothstep(1050.0, 1300.0, tp)) * smoothstep(2400.0, 1900.0, tp) * (1.0 - knK);
    // (reference band ~(123,119,100), p10-p90 95-130: brighter and warmer than the scrub around it)
    veg *= mix(vec3(1.0), vec3(1.63, 1.28, 1.08), cbK); // (reference band R - G ~ +3..4: slightly orange)
    // its texture: sunlit golden clump tops (~5-7 px) over darker gaps, seen from the lookout
    // (reference: lit clump masses 15-25 px wide over cooler shaded gaps, sparse bright crown tops;
    // a slightly rotated lattice so no axis-aligned comb)
    if (cbK > 1e-3) {
      vec2 Pr = mat2(0.83, -0.56, 0.56, 0.83) * (Ps * vec2(0.075, 0.12));
      float cm = tNoise(Pr + 4.1) * 0.75 + tNoise(Pr * 2.1 + 8.8) * 0.25;
      float cF = smoothstep(2.5, 4.5, pxS / 0.075);
      float m = mix(0.5, smoothstep(0.36, 0.64, cm), cF);
      // sparse bright crown tops (~4-5 px) on the lit masses
      vec2 Pt = mat2(0.83, -0.56, 0.56, 0.83) * (Ps * vec2(0.21, 0.25));
      float ctp = smoothstep(0.6, 0.84, tNoise(Pt + 6.6)) * m * smoothstep(2.5, 4.5, pxS / 0.21);
      vec3 cT = mix(vec3(0.91, 0.93, 0.98), vec3(1.09, 1.07, 1.0), m) * (1.0 + vec3(0.62, 0.56, 0.36) * ctp);
      // bristly twig / leaf grain (~2.5 x 3.5 px, +-16 %, faded by its on-screen period): the
      // reference lit scrub is crisp at 1-2 px
      // (pre-emphasised: the post's far-field softening halves 2-3 px detail this close to the horizon)
      // (the haze over the band halves albedo contrast, the post halves it again at 2-3 px)
      // (positively skewed: sparse bright sunlit twig tips, few dark holes)
      float gB = smoothstep(0.3, 0.7, tNoise(Ps * vec2(0.4, 0.28) + 2.9));
      cT *= 1.0 + (0.8 * gB * gB - 0.27) * smoothstep(1.8, 2.8, pxS / 0.4);
      veg *= mix(vec3(1.0), cT, cbK);
    }
    // far field: tree-group blotches on a camera-facing cylindrical projection (round, not smeared)
    {
      float dh = max(length(wp.xz), 1.0);
      // angular coordinates seen from the (fixed) lookout: round ~10 px groups on steep faces and
      // on flat ground seen at grazing angles alike (a height coordinate smears them into stripes)
      vec3 rel = wp - vec3(0.0, 35.0, 0.0);
      vec2 Pv = vec2(atan(rel.x, -rel.z), atan(rel.y, max(length(rel.xz), 1.0))) * 95.0;
      float fb = tFbm(Pv, 3);
      float fb2 = tNoise(Pv * 2.3 + 5.0);
      float farK = (1.0 - detail) * smoothstep(0.9, 3.5, 13.0 / pw);
      float fb3 = tNoise(Pv * 4.7 + 11.0);
      // crown-group texture: low contrast and mostly fine (2-5 px), so the far ridges read as
      // continuous hazy forest (strong ~10 px blotches made a band of repeated stands)
      veg *= mix(1.0, mix(0.85, 1.07, smoothstep(0.2, 0.8, fb * 0.4 + fb2 * 0.3 + fb3 * 0.3)), farK);
      gFarK = max(farK, 0.9 * detail * smoothstep(750.0, 1500.0, tp));
      veg *= mix(vec3(1.0), vec3(1.24, 1.16, 1.0), detail * smoothstep(750.0, 1400.0, tp));
      // crowns are volumes: their sun-facing sides catch light even on slopes turned from the sun.
      // Sunlit stands (the golden scrub swale / ridge crests): broad, soft ~40 px patches, only
      // gently textured by the crown groups
      float litBig = smoothstep(0.3, 0.72, tFbm(Pv * 0.28 + 2.0, 3));
      float lit = litBig * (0.8 + 0.2 * smoothstep(0.3, 0.7, fb));
      // (the golden crest band in front of ~1.1 km is continuously lit in the reference, not broken
      // into the broad lit / unlit far-field patches)
      lit = max(lit, smoothstep(0.2, 0.7, cbK) * smoothstep(1250.0, 1000.0, tp));
      vegSun *= mix(1.0, mix(0.75, 1.2, lit), farK);
      gFoliageSun = farK * 0.4 * lit * smoothstep(120.0, 300.0, misc.y);
      // (hill faces above ~45 m: weaker golden tops; reference ridge is cool grey-green)
      float hillG = 1.0 - 0.6 * smoothstep(40.0, 52.0, wp.y) * smoothstep(700.0, 900.0, tp);
      veg = mix(veg, golden, 0.35 * lit * farK * vS * hillG);
      // nearer far field (swale scrub, near hills, ~1-2.5 km; crowns 2-6 px): crown texture with
      // sunlit golden tops and shaded bluish gaps (reference swale: tops ~(134,132,114), gaps
      // ~(65,75,81)) instead of a smooth lit carpet; in shade the texture is mean-preserving so the
      // shaded hills keep their level
      float nearF = farK * smoothstep(2600.0, 1100.0, tp) * (1.0 - gz); // (grazing: the mosaic below)
      float ct = smoothstep(0.34, 0.66, fb * 0.5 + fb2 * 0.3 + fb3 * 0.2);
      // (weaker beyond ~1.1 km: the reference hill faces are a smooth slate canopy, ~40 % less 2-8 px
      // texture energy than this crown texture gave)
      float ctA = mix(1.0, 0.55, smoothstep(1000.0, 1500.0, tp));
      vegSun *= mix(1.0, mix(1.0 - 0.6 * ctA, 1.0 + 0.1 * ctA, ct), nearF);
      gFoliageSun *= mix(1.0, mix(1.0 - 0.7 * ctA, 1.0 + 0.2 * ctA, ct), nearF);
      float sw = nearF * clamp(lit * 1.3, 0.0, 1.0) * smoothstep(0.05, 0.6, vS) * hillG;
      veg *= mix(vec3(1.0), mix(mix(vec3(0.36, 0.4, 0.6), vec3(0.6, 0.65, 0.78), smoothstep(1300.0, 1700.0, tp)), mix(vec3(1.4, 1.22, 0.94), vec3(1.2, 1.12, 0.98), smoothstep(1300.0, 1700.0, tp)), ct), sw);
      veg *= mix(vec3(1.0), mix(vec3(0.86, 0.92, 1.04), vec3(1.14, 1.08, 0.96), ct), nearF * (1.0 - sw));
      gDbg = vec3(farK, lit, detail);
      // resolved crowns under the low back-light: grazing sun on the crown tops (wrapped) and light
      // transmitted through the sunlit foliage toward the camera -> golden crown tops and rims on
      // the sunlit dune crests and swale (reference: golden scrub band above the shaded dune face)
      vec3 Ls2 = normalize(uSunDir);
      float wrapT = clamp((dot(hn, Ls2) + 0.35) / 1.35, 0.0, 1.0);
      float trans = pow(clamp(dot(v, Ls2), 0.0, 1.0), 3.0) * smoothstep(-0.2, 0.6, hn.y);
      float fsC = cov * (1.0 - 0.6 * shd) * (0.4 * wrapT + 0.6 * trans);
      float fsG = 1.45 * (0.4 * clamp((dot(nG, Ls2) + 0.35) / 1.35, 0.0, 1.0) + 0.6 * pow(clamp(dot(v, Ls2), 0.0, 1.0), 3.0));
      gFoliageSun += detail * mix(fsG, fsC, contK) * smoothstep(40.0, 120.0, misc.y);
      // grazing-view crown mosaic: dune crests and the swale seen at 1-4 deg from the lookout, where
      // the per-pixel crown trace degenerates into horizontal smears. Round crowns on angular
      // coordinates from the lookout (6.5 x 5 px), each with a sunlit golden top and a dark shaded
      // underside, dark gaps between them (reference: golden scrub band above the shaded dune face)
      if (gz > 0.0) {
        vec3 relL = wp - vec3(0.0, 35.0, 0.0);
        vec2 Pg = vec2(atan(relL.x, -relL.z), atan(relL.y, max(length(relL.xz), 1.0))) * vec2(150.0, 200.0);
        Pg += (vec2(tNoise(Pg * 0.3), tNoise(Pg * 0.3 + 3.7)) - 0.5) * 1.4; // irregular clumps
        float n1 = tFbm(Pg, 2);
        // emboss: the value drops just above -> upper edge of a crown/clump -> catches the grazing sun
        float emb = n1 - tFbm(Pg + vec2(0.0, 0.3), 2);
        float dens = smoothstep(0.32, 0.62, n1);
        float top = smoothstep(0.0, 0.1, emb) * dens;
        float litM = smoothstep(0.1, 0.7, vS);
        float litMass = smoothstep(0.25, 0.7, tNoise(Pg * 0.07 + 2.0));
        // (beyond ~1 km, off the gold band: weaker crown mosaic; the reference far dunes / hill
        // faces are a smooth canopy, ~40 % less 2-8 px texture)
        float hfm = smoothstep(1000.0, 1600.0, tp) * (1.0 - cbK);
        vec3 vm = veg * mix(mix(0.78, 0.87, hfm), mix(1.05, 1.02, hfm), dens);
        vm = mix(vm, golden * 1.2, top * litM * mix(0.06, 0.15, litMass));
        // twigs / leaf clumps at 1.5-3 px (+-8 %), faded by their on-screen period
        float pxU = 1.0 / (200.0 * uTPix); // pixels per Pg unit
        float twig = (tNoise(Pg * 1.6 + 4.4) - 0.5) * smoothstep(1.5, 3.0, pxU / 1.6) + (tNoise(Pg * 2.4 + 1.7) - 0.5) * 0.6 * smoothstep(1.5, 3.0, pxU / 2.4);
        vm *= 1.0 + 0.2 * twig;
        veg = mix(veg, vm, gz);
        gFoliageSun = mix(gFoliageSun, (0.68 + 0.3 * top) * mix(0.8, 1.0, dens) * 0.8 * smoothstep(40.0, 120.0, misc.y), gz);
        vegSun *= mix(1.0, mix(mix(0.7, 0.84, hfm), 1.0, dens), gz);
        vegN = normalize(mix(vegN, vec3(0.0, 1.0, 0.0), 0.5 * gz));
      }
    }
    veg *= mix(0.72, 1.1, smoothstep(0.25, 0.75, stand));
    if (tp > 450.0) {
      // terrain creases from the height field (30 m Laplacian): darker gullies / hollows between
      // the tree groups, lighter convex crowns of the ridges and spurs (golden when sunlit)
      vec2 q = wp.xz;
      float lap = (tGround(q + vec2(30.0, 0.0)) + tGround(q - vec2(30.0, 0.0)) + tGround(q + vec2(0.0, 30.0)) + tGround(q - vec2(0.0, 30.0))) * 0.25 - tGround(q);
      float crease = clamp(lap / 4.0, -1.0, 1.0) * smoothstep(450.0, 800.0, tp);
      veg *= 1.0 - 0.2 * crease;
      veg *= mix(vec3(1.0), vec3(1.1, 1.04, 0.92), max(-crease, 0.0) * vS);
    }
    {
      // hills: chroma falls with range (reference hills are grey-green, G-R <= ~+9 levels), the
      // shaded 1-2 km slopes read lighter and more neutral (~(117,123,121)), the 2.5-4 km hills
      // darker blue-grey (~(107,116,121)); pale sandy blowouts on the upper hill slopes
      float hk = smoothstep(1100.0, 3200.0, tp);
      // (upper slopes / ridge tops of the 1.2-4 km hills: greyer still, slightly blue; the
      // reference ridges are grey-green with G - R <= ~+5 levels)
      hk = min(1.0, hk + 0.5 * smoothstep(30.0, 65.0, wp.y) * smoothstep(1100.0, 1800.0, tp));
      // (round 5: the shaded 1.5-4 km slopes are slate blue-grey in the reference, B >= G > R,
      // ~(102,110,111))
      veg = mix(veg, vec3(dot(veg, vec3(0.3, 0.59, 0.11))) * vec3(0.94, 0.97, 1.08), 0.62 * hk);
      veg *= mix(1.0, 1.26, smoothstep(850.0, 1300.0, tp) * smoothstep(2700.0, 1900.0, tp) * (1.0 - 0.6 * vS));
      veg *= mix(1.0, 0.86, smoothstep(2300.0, 3300.0, tp));
      // (mid hills / back dunes away from the sun, ~0.8-3 km: reference slate grey-green, B >= G)
      veg *= mix(vec3(1.0), vec3(0.97, 0.93, 1.12), smoothstep(700.0, 1200.0, tp) * smoothstep(0.46, 0.32, azR) * (1.0 - cbK));
      // (3-5 km hills left of ~10 deg: reference ~(117,124,126), less green than ours)
      veg *= mix(vec3(1.0), vec3(1.16, 1.03, 1.02), smoothstep(2500.0, 3500.0, tp) * smoothstep(6500.0, 4500.0, tp) * smoothstep(0.25, 0.1, azR));
      float blow = smoothstep(0.66, 0.8, tFbm(wp.xz * 0.004 + vec2(3.7, 1.2), 3)) * smoothstep(0.1, 0.3, 1.0 - nG.y)
                 * smoothstep(650.0, 900.0, misc.y) * smoothstep(0.35, 0.6, tNoise(wp.xz * 0.025 + 1.9));
      veg = mix(veg, srgb(vec3(0.74, 0.69, 0.60)), blow * 0.85);
    }
    // the scrub knoll / beach-end scrub (~230-350 m, in dune shadow): sage-grey bush masses,
    // lighter than the distant forest (reference ~(77,88,81))
    veg *= mix(vec3(1.6, 1.45, 1.45), vec3(1.0), smoothstep(260.0, 420.0, tp));
    veg *= mix(vec3(1.0), vec3(0.74, 0.9, 0.6), knK);
    // knoll bushes: leafy clump texture (0.5-0.9 m, faded by its on-screen size)
    veg *= 1.0 + knK * 0.5 * ((tNoise(H.xz * 1.9 + H.y * 1.3) - 0.5) * smoothstep(1.5, 3.0, 0.52 / pw) + 0.6 * (tNoise(H.xz * 1.1 - H.y + 4.0) - 0.5) * smoothstep(1.5, 3.0, 0.9 / pw));
    veg = mix(veg, srgb(vec3(0.52, 0.56, 0.26)), knK * vS * 0.45 * smoothstep(0.1, 0.8, dot(hn, normalize(uSunDir)) + 0.3) * cov);
    veg *= mix(1.0, mix(0.7, 1.08, smoothstep(0.3, 0.7, grp)), smoothstep(40.0, 5.0, foot) * (1.0 - detail));
    // no sun at all on the canopy of faces turned away from it (see bfK)
    // (hill faces turned from the sun: the reference near-right hill is a smooth cool grey-green)
    float hS = hM * smoothstep(-0.05, -0.2, dot(nG, LsB));
    gFoliageSun *= bfL * mix(0.3, 1.0, azM) * (1.0 - 0.25 * hM) * (1.0 - 0.55 * hS);
    vegSun *= bfL * mix(0.3, 1.0, azM) * (1.0 - 0.15 * hM) * (1.0 - 0.45 * hS);
    veg *= mix(vec3(1.0), vec3(0.94, 0.98, 1.05), hM);
    // near hill faces (~0.8-1.8 km): scattered dark tree clumps (~10 x 8 px) on a lighter hazy
    // canopy (reference near-right hill: dark crowns over pale gaps, negatively skewed texture)
    {
      float hT = hM * smoothstep(1900.0, 1500.0, tp) * (1.0 - cbK);
      if (hT > 0.0) {
        float cl = tNoise(Ps * vec2(0.1, 0.13) + 6.2) * 0.7 + tNoise(Ps * vec2(0.21, 0.26) + 1.4) * 0.3 * smoothstep(2.5, 4.0, pxS / 0.21);
        veg *= mix(1.0, 1.07 - 0.42 * smoothstep(0.52, 0.78, cl), hT * smoothstep(2.5, 4.5, pxS / 0.1));
      }
    }
    veg *= mix(vec3(0.88, 0.88, 0.95), vec3(1.0), azM);
    // Shaded dune-front scrub (~0.3-1.5 km): a dense, flat mass of low shrubs, not lumpy crowns
    // (reference ~(86,94,95) near, ~(75,82,85) further left; weak broad variation, fine texture of
    // small dark gaps between the shrubs and slight blue-grey haze). The per-crown albedo / AO
    // modelling is flattened toward a smooth base and the texture comes from angular coordinates
    // seen from the lookout (round on screen on the steep face), each octave faded by its
    // on-screen period.
    float sfrR = smoothstep(250.0, 380.0, tp) * smoothstep(3200.0, 2400.0, tp) * (1.0 - knK);
    float sfr = (1.0 - bfK0) * sfrR;
    gFrontShade = sfr * smoothstep(480.0, 700.0, tp) * mix(1.0, 0.7, smoothstep(1500.0, 2500.0, tp));
    gCrest = cbK;
    if (sfr > 0.0) {
      float lum = dot(veg, vec3(0.3, 0.59, 0.11));
      // broad shrub masses (~10-25 px, +-7 %), shrubs (~4-6 px), small dark gaps (~2.5-3.5 px)
      float mB = tNoise(Ps * vec2(0.05, 0.08) + 3.1) * 0.6 + tNoise(Ps * vec2(0.11, 0.16) + 7.7) * 0.4;
      float mS = tNoise(Ps * vec2(0.2, 0.28) + 1.3);
#ifdef TERRAIN_LQ
      float mG = 0.5, mE = 0.0;
#else
      float mG = tNoise(Ps * vec2(0.34, 0.42) + 5.9);
      // sky-lit upper edges of the shrub masses (value drops just above -> top edge): soft relief
      float mE = mS - tNoise((Ps + vec2(0.0, 1.6)) * vec2(0.2, 0.28) + 1.3);
#endif
      float fS = smoothstep(2.5, 4.5, pxS / 0.24), fG = smoothstep(2.0, 3.2, pxS / 0.38);
      // (fine octaves kept weak: the reference front is dark shrubs with occasional sky-lit tops,
      // not an even 1-4 px grain)
      float tex = 1.0 + 0.45 * (mB - 0.5) + (0.12 * (mS - 0.5) + 0.22 * mE) * fS * mix(1.5, 1.0, smoothstep(450.0, 700.0, tp)) - 0.12 * mix(0.1, smoothstep(0.64, 0.84, mG), fG);
#ifndef TERRAIN_LQ
      // leaf / twig grain at ~2 px (reference: crisp 1-px detail in the shaded scrub; faded by period)
      tex += 0.2 * (tNoise(Ps * vec2(0.36, 0.34) + 4.4) - 0.5) * smoothstep(1.8, 2.8, pxS / 0.36);
#endif
      // rounded bush masses (~6-8 m: ~20 x 14 px at 450 m, ~12 x 9 px beyond ~0.8 km): sky-lit
      // tops, darker undersides (reference: a bumpy canopy of individual shrubs, not a flat grain)
      float bN = smoothstep(500.0, 800.0, tp);
      // (each octave pair only where its weight is non-zero)
      float mM = 0.0, mMu = 0.0;
      if (bN < 1.0) { mM = tNoise(Ps * vec2(0.045, 0.065) + 9.2); mMu = tNoise((Ps + vec2(0.0, 4.0)) * vec2(0.045, 0.065) + 9.2); }
      if (bN > 0.0) { mM = mix(mM, tNoise(Ps * vec2(0.08, 0.11) + 2.4), bN); mMu = mix(mMu, tNoise((Ps + vec2(0.0, 2.6)) * vec2(0.08, 0.11) + 2.4), bN); }
      float fM = smoothstep(2.5, 4.5, pxS / 0.09);
      tex += (0.3 * (mM - mMu) + 0.12 * (mM - 0.5)) * fM;
      // sparse sky-lit bush tops (positively skewed texture)
      tex += (0.3 * smoothstep(0.62, 0.86, mM) * smoothstep(0.0, 0.08, mM - mMu) - 0.045) * fM;
      // (near end ~(88,95,96) at ~450 m; beyond ~0.8 km ~(79,89,92), grey-blue, G - R <= ~10)
      vec3 base = 1.3 * srgb(vec3(0.42, 0.405, 0.36)) * mix(0.9, 1.08, smoothstep(0.3, 0.7, stand)) * mix(vec3(1.08), vec3(0.56, 0.6, 0.97), smoothstep(500.0, 800.0, tp)) * vec3(0.95, 0.99, 1.1) * mix(vec3(1.0), vec3(0.95, 0.97, 1.24), smoothstep(450.0, 750.0, tp));
      veg = mix(veg, mix(base, vec3(lum) * vec3(0.97, 1.02, 1.03), 0.25) * tex, sfr * 0.85 * detail + sfr * 0.6 * (1.0 - detail));
      vegAO = mix(vegAO, 0.62, sfr * 0.85);
      vegN = normalize(mix(vegN, nG, sfr));
      // the shoulder just below the crest band (half-lit crowns, warm bounce from the lit crest):
      // lighter and warmer than the face below (reference ~(100,97,89) vs ~(75,83,86))
      veg *= mix(vec3(1.0), vec3(1.3, 1.18, 1.0), 4.0 * bfK0 * (1.0 - bfK0) * sfrR * azM);
    }
    // beyond the taper of the crest band: only a thin pale rim of dead / sun-caught shrubs on the
    // crest top (reference x ~1110-1190 at t = 0.5, ~(150,142,125), 1-3 rows)
    {
      float rimK = (1.0 - azE) * nearC * smoothstep(0.53, 0.49, azR) * smoothstep(0.4, 0.8, bfK0) * 4.0 * sunV * (1.0 - sunV) * smoothstep(40.0, 28.0, wp.y);
      rimK *= smoothstep(0.35, 0.6, tNoise(Ps * vec2(0.06, 0.2) + 3.9));
      veg = mix(veg, srgb(vec3(0.6, 0.57, 0.5)), 0.75 * rimK);
    }
#ifdef TERRAIN_SFRDBG
    veg = vec3(sfr, cbK, vMisc.x * bfK);
#endif
  }
  // sand/scrub boundary built from whole bushes: round blobs with a soft sandy fringe;
  // vegetation starts further inland (blowouts) at the near end of the beach
  if (misc.y > 0.0) {
    float mainW = wSand + wVeg;
    float s0 = sEdge;
    float dens = smoothstep(s0 - 5.0, s0 + 2.0, misc.y);
    float vf = max(smoothstep(s0 - 1.0, s0 + 7.0, misc.y), mix(0.55, cov, detail) * smoothstep(0.1, 0.5, dens));
    // fore-dune: sparse low spinifex / pigface clumps (~3 m) thickening toward the scrub, so the
    // sand -> scrub transition is soft and irregular (replaces the sub-pixel 1 m spinifex tufts)
    float fd = smoothstep(s0 - 15.0, s0 - 1.0, misc.y) * smoothstep(14.0, 24.0, misc.y);
    if (fd > 0.0) {
      // clumps on angular coordinates from the (fixed) lookout: round ~3-6 px on screen even on
      // the upper beach seen at grazing angles (world-space clumps smear into streaks there)
      vec3 rel = wp - vec3(0.0, 35.0, 0.0);
      vec2 Pa = vec2(atan(rel.x, -rel.z), atan(rel.y, max(length(rel.xz), 1.0))) * 340.0;
      float clump = smoothstep(0.98 - 0.2 * fd, 1.06 - 0.2 * fd, tNoise(Pa * 0.6 + 5.3) * 0.7 + tNoise(Pa * 1.2 + 1.1) * 0.3);
      sand = mix(sand * mix(1.0, 0.9, fd), srgb(vec3(0.37, 0.385, 0.31)) * (0.85 + 0.3 * tNoise(Pa * 1.1)), clump * min(1.0, fd * 2.0) * 0.3);
      // spinifex runners / wind-cut tussock rows: short dark dashes in rows along the dune face
      // (reference: 6-12 px long, 1-2 px tall; screen-space so they never alias into speckle)
      float dsh = tNoise(vec2(Pa.x * 0.42, Pa.y * 1.2) + 3.1) * 0.75 + tNoise(Pa * vec2(0.8, 1.2) + 7.9) * 0.25;
      float dash = smoothstep(0.68, 0.84, dsh) * smoothstep(0.25, 0.6, tNoise(Pa * 0.11 + 1.7) + 0.35 * fd);
      sand = mix(sand, srgb(vec3(0.34, 0.36, 0.31)), dash * smoothstep(0.0, 0.35, fd) * 0.5);
    }
    // scalloped erosion scarp just below the scrub line: a steep, shaded sand face
    {
      vec3 rel = wp - vec3(0.0, 35.0, 0.0);
      float ang = atan(rel.x, -rel.z) * 60.0;
      float scal = tNoise(vec2(ang, 0.5)) * 0.7 + tNoise(vec2(ang * 3.1, 2.5)) * 0.3;
      float sc = smoothstep(s0 - 9.0 + 5.0 * scal, s0 - 5.5 + 4.0 * scal, misc.y) * smoothstep(s0 + 1.0, s0 - 1.5, misc.y);
      sand *= mix(vec3(1.0), vec3(0.62, 0.64, 0.66), sc * smoothstep(10.0, 18.0, misc.y) * step(-700.0, wp.z) * 0.85);
      // upper fore-dune face below the scrub: greyer, sparsely vegetated sand
      sand *= mix(1.0, mix(0.86, 1.03, smoothstep(-760.0, -420.0, wp.z)), smoothstep(s0 - 16.0, s0 - 4.0, misc.y) * smoothstep(12.0, 20.0, misc.y));
    }
    // gaps between the edge crowns: shaded understory / litter (bright sand holes read as white
    // slivers and specks inside the scrub), a soft darker toe below the scrub line
    float toeF = 1.0 - 0.8 * smoothstep(-430.0, -350.0, wp.z); // (near end: bright sand up to the scrub)
    sand = mix(sand, srgb(vec3(0.27, 0.285, 0.27)), smoothstep(s0 - 5.0, s0 + 2.0, misc.y) * 0.85 * step(12.0, misc.y));
    sand *= mix(1.0, 0.82, smoothstep(s0 - 12.0, s0 - 4.0, misc.y) * smoothstep(12.0, 18.0, misc.y) * toeF);
    vegW = mainW * vf;
    wVeg = vegW; wSand = mainW * (1.0 - vf);
  }
  { float fv = wVeg / max(1e-3, wSand + wRock + wGrass + wVeg); nW = normalize(mix(nW, vegN, fv)); ao *= mix(1.0, vegAO, fv); }
  vegSun = mix(1.0, vegSun, wVeg / max(1e-3, wSand + wRock + wGrass + wVeg));
  gVegAmb = 1.0 + (0.5 + 0.35 * gFarK) * wVeg / max(1e-3, wSand + wRock + wGrass + wVeg);

  float wsum = max(1e-4, wSand + wRock + wGrass + wVeg);
  albedo = (sand * wSand + rock * wRock + grass * wGrass + veg * wVeg) / wsum;
  gVegSun = vegSun;
  gFoliageSun *= wVeg / max(1e-3, wSand + wRock + wGrass + wVeg);
  gVegF = wVeg / max(1e-3, wSand + wRock + wGrass + wVeg);
  gFrontShade *= gVegF;
  gCrest *= gVegF;
  gSunVis = mix(misc.x, gSunVis, gVegF);
  rough = (sandRough * wSand + rockRough * wRock + 0.95 * wGrass + 0.9 * wVeg) / wsum;
}
`;

// Light gains (direct, ambient). The sky module sets sun intensity (x PI) and scene.environment,
// so the physically based defaults are 1.
const TERRAIN_GAIN = { value: new THREE.Vector2(1.0, 1.2) };
// warm white balance of the (blue) sky ambient on land, matching the phone's colour response
// Land-only haze top-up target (per metre at sea level); set .value = 0 to disable.
export const TERRAIN_HAZE_TARGET = { value: 1.1e-4 };
const TERRAIN_TINT = { value: new THREE.Vector3(1.0, 1.0, 1.0) };
// pixel angle of the scene target (rad per pixel row), updated every frame: all footprint fades use it
const TERRAIN_PIX = { value: 2 * Math.tan(40.15 * Math.PI / 360) / 718 };
// crown-base height fields (half-float copies of the sun-bake grids: 5 m near, 20 m far), so every
// crown sits at a fixed height whatever pixel traces it (no sliding / shearing with the normal)
const TH = { F: { value: null }, C: { value: null }, Fa: { value: new THREE.Vector4() }, Fb: { value: new THREE.Vector2() },
  Ca: { value: new THREE.Vector4() }, Cb: { value: new THREE.Vector2() } };
function heightTex(g, dst, a, b) {
  const half = new Uint16Array(g.data.length);
  for (let i = 0; i < half.length; i++) half[i] = THREE.DataUtils.toHalfFloat(g.data[i]);
  const tex = new THREE.DataTexture(half, g.nx, g.nz, THREE.RedFormat, THREE.HalfFloatType);
  tex.minFilter = THREE.LinearFilter; tex.magFilter = THREE.LinearFilter; tex.generateMipmaps = false;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping; tex.needsUpdate = true;
  dst.value = tex;
  a.value.set(g.minX, g.minZ, (g.nx - 1) / ((g.maxX - g.minX) * g.nx), (g.nz - 1) / ((g.maxZ - g.minZ) * g.nz));
  b.value.set(0.5 / g.nx, 0.5 / g.nz);
}
// headland cliff edge behind the casuarinas (for the dead-grass / needle-litter band)
const EDGE_PTS = { value: (() => {
  const i0 = HEADLAND_OUTLINE.findIndex(([x, z]) => z < -36);
  return HEADLAND_OUTLINE.slice(i0, i0 + 9).map(([x, z]) => new THREE.Vector2(x, z));
})() };

function makeMaterial(ctx, farShadow = true) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0.0 });
  if (!farShadow) mat.userData.farShadow = false;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTerrainGain = TERRAIN_GAIN;
    shader.uniforms.uTerrainTint = TERRAIN_TINT;
    shader.uniforms.uTerrainHazeTarget = TERRAIN_HAZE_TARGET;
    shader.uniforms.uEdgePts = EDGE_PTS;
    shader.uniforms.uTPix = TERRAIN_PIX;
    shader.uniforms.uTHF = TH.F; shader.uniforms.uTHC = TH.C;
    shader.uniforms.uTHFa = TH.Fa; shader.uniforms.uTHFb = TH.Fb; shader.uniforms.uTHCa = TH.Ca; shader.uniforms.uTHCb = TH.Cb;
    shader.uniforms.uSkyZenith = ctx.uniforms.uSkyZenith;
    shader.uniforms.uSkyHorizon = ctx.uniforms.uSkyHorizon;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec4 aSurf;
attribute vec3 aMisc;
attribute float aEdge;
varying vec4 vSurf;
varying vec3 vMisc;
varying float vEdge;
varying vec3 vTWPos;
varying vec3 vTWNrm;
${CURVATURE_GLSL}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
vTWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
vTWNrm = normalize(mat3(modelMatrix) * objectNormal);
vSurf = aSurf; vMisc = aMisc; vEdge = aEdge;
transformed = earthCurve(transformed);`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec4 vSurf;
varying vec3 vMisc;
varying float vEdge;
varying vec3 vTWPos;
varying vec3 vTWNrm;
uniform float uTPix;
uniform sampler2D uTHF, uTHC;
uniform vec4 uTHFa, uTHCa;
uniform vec2 uTHFb, uTHCb;
float tGround(vec2 p){
  vec2 f = (p - uTHFa.xy) * uTHFa.zw;
  if (f.x > 0.0 && f.y > 0.0 && f.x < 0.994 && f.y < 0.996) return textureLod(uTHF, f + uTHFb, 0.0).r;
  return textureLod(uTHC, (p - uTHCa.xy) * uTHCa.zw + uTHCb, 0.0).r;
}
uniform vec2 uTerrainGain;
uniform vec3 uTerrainTint;
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizon;
uniform float uTerrainHazeTarget;
uniform vec2 uEdgePts[9];
${GLSL_NOISE}
${GLSL_SHADE}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
vec3 tAlbedo; float tRough; vec3 tNrm; float tAO;
terrainSurface(vTWPos, normalize(vTWNrm), vSurf, vMisc, tAlbedo, tRough, tNrm, tAO);
diffuseColor.rgb = tAlbedo;
#ifdef TERRAIN_GREY
diffuseColor.rgb = vec3(0.18);
#endif
#ifdef TERRAIN_SURF
diffuseColor.rgb = vSurf.xyz * 0.6 + vec3(0.0, 0.0, 0.0);
#endif
`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
roughnessFactor = tRough;`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
normal = normalize((viewMatrix * vec4(tNrm, 0.0)).xyz);`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
reflectedLight.directDiffuse *= uTerrainGain.x * gSunVis * mix(1.0, tAO, 0.6) * gVegSun;
reflectedLight.directDiffuse += diffuseColor.rgb * uSunColor * (uTerrainGain.x * gSunVis * gFoliageSun);
reflectedLight.directSpecular *= uTerrainGain.x * gSunVis * tAO * (1.0 - 0.8 * gVegF);`)
      .replace('#include <fog_fragment>', `{
  // Land aerial perspective (replaces the shared applyAtmosphere on terrain): the shared haze, but
  // (a) most of the low surf-spray veil is cut for targets inland of the beach (the reference dune
  // scrub at ~600 m is the darkest, least hazy land in the frame, the 1-3 km forest gets hazier
  // with range) and (b) a land-only top-up toward the measured hill extinction (TERRAIN_HAZE_TARGET).
  vec3 v = vTWPos - cameraPosition; float d = length(v); vec3 dir = v / max(d, 1e-4);
  vec3 od = atmosphereDepthV(vTWPos, dir, d);
  float sprayMask = (1.0 - smoothstep(HAZE_SPRAY_TOP * 0.6, HAZE_SPRAY_TOP * 1.5, vTWPos.y))
                  * smoothstep(-330.0, -170.0, vTWPos.x - hazeCoastX(vTWPos.z));
  od -= min(d, HAZE_SPRAY_RANGE) * sprayMask * HAZE_SPRAY * 0.7 * smoothstep(20.0, 90.0, vMisc.y);
  float extraD = max(0.0, uTerrainHazeTarget - uHazeDensity);
  float k = uHazeFalloff; float kdy = k * dir.y * d;
  od += HAZE_CHROMA * extraD * exp(-k * max(cameraPosition.y, 0.0)) * d * (abs(kdy) > 1e-4 ? (1.0 - exp(-kdy)) / kdy : 1.0);
  // the shaded dune-front scrub beyond ~0.5 km is the darkest, least hazy land in the reference
  // (~(66,76,82) at 650 m): most of the land top-up / spray veil is lifted there
  od *= 1.0 - 0.42 * gFrontShade;
  // the golden crest band stays vivid out to ~1 km in the reference (peak ~(141,133,108) at 900 m)
  od *= 1.0 - 0.3 * gCrest * smoothstep(600.0, 900.0, d);
  // pale glare veil over the lower slopes of the hills toward the sun (reference: lighter, hazier
  // lower slope under a cool grey-green ridge)
  float fwdV = smoothstep(0.75, 0.9, dot(normalize(v.xz + 1e-5), normalize(uSunDir.xz)));
  od *= 1.0 + 0.25 * fwdV * smoothstep(30.0, 42.0, vTWPos.y) * smoothstep(95.0, 70.0, vTWPos.y) * smoothstep(800.0, 1200.0, d);
  vec3 T = exp(-max(od, vec3(0.0)));
  vec3 al = atmosphereAirlight(dir) * mix(vec3(1.0), vec3(0.96, 1.0, 1.03), smoothstep(200.0, 800.0, d));
  // forward scatter over the land: the haze on the hills toward the sun (right) is brighter and more
  // neutral (reference: pale mid-hill haze / glare over the right-hand hills), away from it
  // (the far hills on the left) darker and blue-grey (reference ~(107,116,121))
  float fwd = smoothstep(0.5, 0.85, dot(normalize(dir.xz + 1e-5), normalize(uSunDir.xz)));
  // (round 5: away from the sun the reference hills / far dunes are slate blue-grey, B >= G > R)
  // (less cyan away from the sun: reference far-left hills ~(112,123,129), B - R <= ~+17)
  // (intermediate azimuths, the mid hills ~10-25 deg: slate, B > G; reference ~(116,124,127))
  al *= 1.0 + vec3(-0.02, -0.02, 0.07) * 4.0 * fwd * (1.0 - fwd) * smoothstep(700.0, 1600.0, d);
  // (high ridges toward the sun: darker, cooler veil; reference ridge ~(124,132,130))
  al *= mix(vec3(1.0), vec3(0.88, 0.9, 0.93), fwd * smoothstep(85.0, 130.0, vTWPos.y));
  al *= mix(vec3(1.0), mix(vec3(0.81, 0.74, 0.85) * mix(vec3(1.0), vec3(0.93, 0.86, 0.83), smoothstep(4500.0, 8000.0, d)), vec3(1.2, 1.15, 1.06), fwd), smoothstep(700.0, 1600.0, d));
  gl_FragColor.rgb = gl_FragColor.rgb * T + al * (1.0 - T);
}
#ifdef TERRAIN_SUNDBG
gl_FragColor.rgb = vec3(vMisc.x, gDbg.y, gDbg.x);
#endif
#ifdef TERRAIN_SFRDBG
gl_FragColor.rgb = tAlbedo;
#endif`)
      .replace('#include <aomap_fragment>', `#include <aomap_fragment>
{
  // own sky ambient from the shared sky colours (scene.environment is far too blue on land)
  vec3 skyAmb = mix(uSkyHorizon, uSkyZenith, 0.75) * uTerrainGain.y; // cosine-weighted sky irradiance
  vec3 gndAmb = vec3(0.10, 0.095, 0.07);
  float up = clamp(tNrm.y * 0.5 + 0.5, 0.0, 1.0);
  reflectedLight.indirectDiffuse = diffuseColor.rgb * mix(gndAmb, skyAmb, up) * tAO * uTerrainTint * gVegAmb;
}
reflectedLight.indirectSpecular *= tAO * uTerrainGain.y * mix(0.15, 1.0, smoothstep(0.9, 0.4, tRough));`);
  };
  mat.customProgramCacheKey = () => 'terrain-v3' + (farShadow ? '' : '-nofar');
  mat.defines = {};
  if (ctx.quality.tier !== 'high') mat.defines.TERRAIN_LQ = 1; // phones: no crown shadow march
  if (ctx.params.get('debug') === 'tgrey') mat.defines.TERRAIN_GREY = 1;
  if (ctx.params.get('debug') === 'tsurf') mat.defines.TERRAIN_SURF = 1;
  if (ctx.params.get('debug') === 'tsun') mat.defines.TERRAIN_SUNDBG = 1;
  if (ctx.params.get('debug') === 'tsfr') mat.defines.TERRAIN_SFRDBG = 1;
  return patchMaterialAtmosphere(mat, ctx.uniforms);
}

// ---------------------------------------------------------------------------------------------
export default async function create(ctx) {
  const { layout, scene } = ctx;
  const tier = ctx.quality.tier;
  const q = tier === 'high' ? 1 : tier === 'medium' ? 0.7 : 0.5;
  const yieldUI = () => new Promise((r) => setTimeout(r, 0));
  const tick = makeYielder();
  const t0 = performance.now();

  const sunDir = new THREE.Vector3().fromArray(ctx.config.sun.direction).normalize();
  ctx.progress(0.05, 'Headland and dunes');
  const sunVis = await makeSunVis(layout, sunDir, tick);
  heightTex(grids.fine, TH.F, TH.Fa, TH.Fb);
  heightTex(grids.coarse, TH.C, TH.Ca, TH.Cb);
  ctx.progress(0.25);
  await yieldUI();
  // progress within one build: maps its 0..1 onto the module's [a, b] range
  const prog = (a, b) => (f) => ctx.progress(a + (b - a) * f);

  const mat = makeMaterial(ctx);
  const matFar = makeMaterial(ctx, false);
  matFar.polygonOffset = true; matFar.polygonOffsetFactor = 1; matFar.polygonOffsetUnits = 2;

  // fine rectangles (x/z bounds). Coarser meshes skip triangles fully inside (shrunk by a margin).
  const FG = [-16, 52, -60, 8];
  const PL = [-26, 136, -180, -124];
  const inRect = (r, x, z, m) => x > r[0] + m && x < r[1] - m && z > r[2] + m && z < r[3] - m;

  const group = new THREE.Group();
  group.name = 'terrain';

  // foreground headland
  {
    const step = 0.3 / q;
    const { v, nx, nz } = rectVerts(FG[0], FG[1], FG[2], FG[3], step);
    // lower-left brow corner (~9 m from the eye, 1 cm/px): the blocky rock knob and its skyline need a
    // 4x finer grid than the 0.3 m fg grid (one fg cell is ~30 px there). The patch is snapped to fg
    // grid lines, the fg mesh skips the cells it covers, its border vertices take the fg mesh's own
    // (linear) edge heights (no T-junction cracks), and it is merged into the fg mesh (no extra draw).
    const sx = (FG[1] - FG[0]) / (nx - 1), sz = (FG[3] - FG[2]) / (nz - 1);
    const pi0 = Math.floor((-8.6 - FG[0]) / sx), pi1 = Math.ceil((-2.6 - FG[0]) / sx);
    const pj0 = Math.floor((-9.8 - FG[2]) / sz), pj1 = Math.ceil((-4.4 - FG[2]) / sz);
    const SUB = 4;
    const geoFg = await buildGeometry(layout, v, nx, nz, sunVis, (a) => {
      const i = a % nx, j = (a - i) / nx;
      return !(i >= pi0 && i < pi1 && j >= pj0 && j < pj1);
    }, false, false, tick, prog(0.25, 0.38));
    const pv = rectVerts(FG[0] + pi0 * sx, FG[0] + pi1 * sx, FG[2] + pj0 * sz, FG[2] + pj1 * sz, sx / SUB);
    const geoP = await buildGeometry(layout, pv.v, pv.nx, pv.nz, sunVis, null, false, false, tick);
    {
      const pp = geoP.attributes.position.array, fp = geoFg.attributes.position.array;
      const fh = (i, j) => fp[(j * nx + i) * 3 + 1];
      for (let j = 0; j < pv.nz; j++) for (let i = 0; i < pv.nx; i++) {
        if (i > 0 && i < pv.nx - 1 && j > 0 && j < pv.nz - 1) continue;
        const ci = pi0 + i / SUB, cj = pj0 + j / SUB;
        const i0 = Math.floor(ci), j0 = Math.floor(cj), fi = ci - i0, fj = cj - j0;
        const h = fi > 0 ? fh(i0, j0) * (1 - fi) + fh(i0 + 1, j0) * fi : fj > 0 ? fh(i0, j0) * (1 - fj) + fh(i0, j0 + 1) * fj : fh(i0, j0);
        pp[(j * pv.nx + i) * 3 + 1] = h;
      }
      geoP.computeVertexNormals();
      // the brow corner and the bare edge band lie in the shade in the reference (as the grass beside
      // them, grass.js sunMaskAt)
      for (const g of [geoFg, geoP]) {
        const p = g.attributes.position.array, mi = g.attributes.aMisc.array;
        const eg = g.attributes.aEdge.array;
        for (let k = 0; k < mi.length / 3; k++) mi[k * 3] *= (1 - 0.92 * smoothstep(-2.4, -3.2, p[k * 3]) * smoothstep(-11, -9.8, p[k * 3 + 2])) * (1 - 0.85 * eg[k]);
      }
    }
    const geo = mergeGeometries([geoFg, geoP]);
    geo.computeBoundingSphere(); geo.computeBoundingBox();
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = true; m.receiveShadow = true; m.name = 'terrain-fg';
    group.add(m);
  }
  ctx.progress(0.4); await yieldUI();

  // rock platform
  {
    const step = 0.4 / q;
    const { v, nx, nz } = rectVerts(PL[0], PL[1], PL[2], PL[3], step);
    const keep = (a, b, c, d, pos) => {
      const x = pos[a * 3], z = pos[a * 3 + 2];
      return !inRect(FG, x, z, 0.5);
    };
    const recess = { step, radius: 2.8, base: 0.22, gain: 0.6, mask: (x, z) => smoothstep(14, 22, x) * smoothstep(-122, -128, z) };
    const geo = await buildGeometry(layout, v, nx, nz, sunVis, keep, true, false, tick, prog(0.4, 0.55), recess);
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = true; m.receiveShadow = true; m.name = 'terrain-platform';
    group.add(m);
  }
  ctx.progress(0.55); await yieldUI();

  // polar rings
  const nAz = Math.round(680 * q);
  // radial ratio: 1.45 % per row in the near ring (to 1 km; 420 m on medium/low), 2.4 % beyond
  const ratio = 1 + 0.0145 / q, ratioFar = 1 + 0.024 / q;
  // near ring (to the first radius >= 420 m) and far ring share that row
  const radiiN = polarRadii(26, 45000, ratio);
  const split = radiiN.findIndex((r) => r >= (q < 1 ? 420 : 1000));
  const nearR = radiiN.slice(0, split + 1);
  const rings = [[nearR, true], [polarRadii(nearR[split], 45000, ratioFar), false]];
  for (const [rr, near] of rings) {
    const { v, nx, nz } = polarVerts(0, 0, -52, 64, rr, nAz);
    const keep = (a, b, c, d, pos) => {
      const inside = (k) => inRect(FG, pos[k * 3], pos[k * 3 + 2], 1.2) || inRect(PL, pos[k * 3], pos[k * 3 + 2], 1.2);
      return !(inside(a) && inside(b) && inside(c) && inside(d));
    };
    const geo = await buildGeometry(layout, v, nx, nz, sunVis, keep, true, true, tick, near ? prog(0.55, 0.75) : prog(0.75, 0.98), null, true);
    const m = new THREE.Mesh(geo, matFar);
    // (perf audit #11 checked: the near ring stays a shadow caster. Its per-vertex sun bake does
    // not replace the shadow map for the foreground: e.g. the high headland west of the
    // casuarinas shades the far brow strip, and ~70 % of the ring's above-sea triangles lie
    // inside the sun shadow frustum, which reaches 650 m sunward, so a caster subset saves little.)
    m.castShadow = near; m.receiveShadow = near; m.name = near ? 'terrain-polar-near' : 'terrain-polar-far';
    m.frustumCulled = false;
    group.add(m);
    ctx.progress(near ? 0.75 : 0.98); await yieldUI();
  }

  // two tiny people standing on the platform (image ~737,322 and ~750,318), ~150 m away
  {
    const parts = [];
    for (const [x, z, hgt, lean] of [[15.3, -150.3, 1.66, 0.04], [17.7, -151.5, 1.76, -0.06]]) {
      const y = layout.heightAt(x, z);
      const body = new THREE.CapsuleGeometry(0.2, hgt - 0.4 - 0.22, 3, 8);
      body.applyMatrix4(new THREE.Matrix4().makeRotationZ(lean).setPosition(x, y + (hgt - 0.22) / 2, z));
      const head = new THREE.SphereGeometry(0.11, 8, 6);
      head.translate(x - lean * (hgt - 0.1), y + hgt - 0.11, z);
      parts.push(body.toNonIndexed(), head.toNonIndexed());
    }
    const people = new THREE.Mesh(mergeGeometries(parts.map((g) => { for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k); return g; })),
      patchMaterialAtmosphere(new THREE.MeshStandardMaterial({ color: 0x1b222a, roughness: 0.85 }), ctx.uniforms));
    people.castShadow = true; people.name = 'platform-people';
    group.add(people);
  }

  scene.add(group);
  const stats = { meshes: 0, triangles: 0, vertices: 0, buildMs: Math.round(performance.now() - t0) };
  group.traverse((o) => {
    if (o.isMesh) { stats.meshes++; stats.vertices += o.geometry.attributes.position.count; stats.triangles += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3; }
  });
  if (ctx.params.has('tstats')) console.warn('[terrain] stats ' + JSON.stringify(stats));
  const bufSize = new THREE.Vector2();
  const updatePix = () => {
    ctx.renderer.getDrawingBufferSize(bufSize);
    const rows = Math.max(64, bufSize.y * (ctx.quality.scale || 1));
    TERRAIN_PIX.value = 2 * Math.tan((ctx.camera.fov || 40.15) * Math.PI / 360) / rows;
  };
  updatePix();
  return {
    group,
    stats,
    update() { updatePix(); },
  };
}
