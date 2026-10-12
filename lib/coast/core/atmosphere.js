// Aerial perspective shared by every surface so distant land, sea and sky blend consistently.
// Custom ShaderMaterials: include ATMOSPHERE_GLSL in the fragment shader (after declaring
// `uniform`s via the same chunk) and call `col = applyAtmosphere(col, vWorldPos);` last.
// Built-in materials: call patchMaterialAtmosphere(material, ctx.uniforms).
// Vertex shaders of large/distant geometry should apply earthCurve() to world positions.
import { CONFIG } from '../config.js';
import { ShaderChunk } from 'three';
import { SKY_CORE_GLSL, skyDisplayJS, SKY_V3 } from '../sky/skyModel.js';
import { FAR_SHADOW_GLSL } from '../sky/farShadow.js';

export const CURVATURE_GLSL = /* glsl */ `
// Earth curvature drop relative to the camera (R = 6371 km). Negligible near, ~31 m at 20 km.
vec3 earthCurve(vec3 wp){
  vec2 d = wp.xz - cameraPosition.xz;
  wp.y -= dot(d, d) * (1.0 / (2.0 * 6371000.0));
  return wp;
}
`;

// Aerial perspective model (owned by the sky module; analysis/sky_light.md section 4):
//  - background marine haze: chromatic extinction beta = uHazeDensity * HAZE_CHROMA at sea level
//    with exponential height falloff uHazeFalloff, integrated exactly along the view ray;
//  - spray veil over the surf zone / beach / dunes: extra chromatic beta on the first
//    HAZE_SPRAY_RANGE metres of the path, for targets below HAZE_SPRAY_TOP that lie landward of
//    ~250 m seaward of the beach waterline (the open sea on the left stays crisp);
//  - airlight = clear-sky colour ~0.5 deg above the horizon in the same azimuth (warm cream toward
//    the sun, grey-cyan away from it). The analysis measured the haze as a DISPLAY-space mix, so
//    the very bright, saturated sun-side horizon HDR is compressed and desaturated to the HDR value
//    that reproduces it (e.g. dunes at 0.5 km need ~(1.5,1.3,1.1), not the sky's (3.2,2.8,0.9));
//    plus a subtle forward-scatter glow toward the sun (uHazeSunColor).
// atmosphereAlong() keeps its vec4(inscatter, transmittance) signature (w = green transmittance);
// applyAtmosphere() applies the full per-channel transmittance.
export const ATMOSPHERE_GLSL = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uHazeColor;
uniform vec3 uHazeSunColor;
uniform float uHazeDensity;
uniform float uHazeFalloff;
${SKY_CORE_GLSL}
#ifndef ATMOSPHERE_FUNCS
#define ATMOSPHERE_FUNCS
const vec3 HAZE_CHROMA = vec3(${CONFIG.haze.chroma.map((v) => v.toFixed(4)).join(', ')});
const vec3 HAZE_SPRAY = vec3(${CONFIG.haze.spray.map((v) => v.toExponential(4)).join(', ')});
const float HAZE_SPRAY_RANGE = ${CONFIG.haze.sprayRange.toFixed(1)};
const float HAZE_SPRAY_TOP = ${CONFIG.haze.sprayTop.toFixed(1)};
// display-linear horizon sky 0.5 deg above the sea horizon, anti side / sun side
const vec3 HAZE_AIR_ANTI = ${SKY_V3(skyDisplayJS(0, 0.5))};
const vec3 HAZE_AIR_SUN = ${SKY_V3(skyDisplayJS(1, 0.5))};

// approximate beach waterline x(z) (layout.BEACH_WATERLINE, seen from the camera)
float hazeCoastX(float z){
  float d = -z;
  return d < 800.0 ? mix(100.0, 120.0, max(d, 0.0) / 800.0)
       : d < 1500.0 ? mix(120.0, 55.0, (d - 800.0) / 700.0)
       : d < 3000.0 ? mix(55.0, -130.0, (d - 1500.0) / 1500.0)
       : -130.0 - (d - 3000.0) * 0.12;
}

// per-channel optical depth camera -> worldPos (v = worldPos - cameraPosition, d = |v|)
vec3 atmosphereDepthV(vec3 worldPos, vec3 dir, float d){
  float k = uHazeFalloff;
  float h0 = max(cameraPosition.y, 0.0);
  float kdy = k * dir.y * d;
  float fogInt = uHazeDensity * exp(-k * h0) * d * (abs(kdy) > 1e-4 ? (1.0 - exp(-kdy)) / kdy : 1.0);
  float mask = (1.0 - smoothstep(HAZE_SPRAY_TOP * 0.6, HAZE_SPRAY_TOP * 1.5, worldPos.y))
             * smoothstep(-330.0, -170.0, worldPos.x - hazeCoastX(worldPos.z));
  float spray = min(d, HAZE_SPRAY_RANGE) * mask;
  return fogInt * HAZE_CHROMA + spray * HAZE_SPRAY;
}
vec3 atmosphereDepth(vec3 worldPos){
  vec3 v = worldPos - cameraPosition;
  float d = length(v);
  return atmosphereDepthV(worldPos, v / max(d, 1e-4), d);
}

// airlight for a (normalised) view direction
vec3 atmosphereAirlight(vec3 dir){
  float w = clamp((skyAzEq(dir) + 9.0) / 38.0, 0.0, 1.08);
  vec3 air = skyInvACES(mix(HAZE_AIR_ANTI, HAZE_AIR_SUN, w));
  float l = dot(air, vec3(0.2126, 0.7152, 0.0722));
  if (l > 1.0) {
    float L = 1.0 + 0.19 * (l - 1.0);
    air = mix(vec3(l), air, mix(1.0, 0.25, smoothstep(1.0, 2.2, l))) * (L / l);
  }
  float mu = max(dot(dir, uSunDir), 0.0);
  return air + uHazeSunColor * (pow(mu, 6.0) * 0.6 + pow(mu, 32.0) * 0.4);
}

// Airlight for a FINITE path to a land target (worldPos.y above the waves): the horizon colour
// above is the limit of an optically deep path; a path of a few km through the marine haze
// scatters sun + blue sky light and reads blue-grey (reference: hills at 3-10 km are B-G +5..+8,
// bluer than the cream sky just above them). Same luminance as the horizon airlight, blue-grey
// chroma (reference sRGB ~150,166,188), fading back to the horizon colour as od.g -> 2. The sea
// (y < 2 m) keeps the horizon colour so the sea horizon still melts into the sky.
vec3 atmosphereAirlight(vec3 dir, vec3 worldPos, float odg){
  vec3 air = atmosphereAirlight(dir);
  float k = smoothstep(2.0, 6.0, worldPos.y) * (1.0 - smoothstep(0.35, 2.0, odg));
  if (k <= 0.0) return air;
  float l = dot(air, vec3(0.2126, 0.7152, 0.0722));
  return mix(air, vec3(l) * vec3(0.816, 1.019, 1.345), k);
}

// Returns (inscattered colour, transmittance) for a view ray from the camera to worldPos.
vec4 atmosphereAlong(vec3 worldPos){
  vec3 v = worldPos - cameraPosition;
  float d = length(v);
  vec3 dir = v / max(d, 1e-4);
  vec3 od = atmosphereDepthV(worldPos, dir, d);
  return vec4(atmosphereAirlight(dir, worldPos, od.g), exp(-od.g));
}

vec3 applyAtmosphere(vec3 col, vec3 worldPos){
  vec3 v = worldPos - cameraPosition;
  float d = length(v);
  vec3 dir = v / max(d, 1e-4);
  vec3 od = atmosphereDepthV(worldPos, dir, d);
  // land targets inland of the beach: cut most of the surf-spray veil (the same cut the terrain's
  // own aerial perspective applies), so shrubs / trees on the dunes are not veiled in a pale,
  // height-banded sheet over the terrain they stand on
  float inland = smoothstep(20.0, 90.0, worldPos.x - hazeCoastX(worldPos.z)) * smoothstep(2.0, 6.0, worldPos.y);
  float sprayMask = (1.0 - smoothstep(HAZE_SPRAY_TOP * 0.6, HAZE_SPRAY_TOP * 1.5, worldPos.y))
                  * smoothstep(-330.0, -170.0, worldPos.x - hazeCoastX(worldPos.z));
  od -= min(d, HAZE_SPRAY_RANGE) * sprayMask * HAZE_SPRAY * 0.7 * inland;
  vec3 T = exp(-max(od, vec3(0.0)));
  return col * T + atmosphereAirlight(dir, worldPos, od.g) * (1.0 - T);
}
#endif
`;

// Replace three.js' fog with our aerial perspective on built-in materials (MeshStandardMaterial etc.).
// Also applies the static far-field sun shadow (sky/farShadow.js) to the directional light of lit
// built-in materials beyond the regular shadow-map box (beach / dunes in dune shadow), unless
// material.userData.farShadow === false or the material replaces lights_fragment_begin itself.
const FAR_LIGHTS_CHUNK = ShaderChunk.lights_fragment_begin.replace(
  'getDirectionalLightInfo( directionalLight, directLight );',
  'getDirectionalLightInfo( directionalLight, directLight );\n\t\tdirectLight.color *= farSunVisibility( vAtmoWorldPos, inverseTransformDirection( geometryNormal, viewMatrix ) );',
);
export function patchMaterialAtmosphere(material, uniforms) {
  const prev = material.onBeforeCompile;
  const farOK = material.userData.farShadow !== false && !!(uniforms.uFarShadowMap && uniforms.uFarShadowMatrix && uniforms.uFarShadowParams)
    && FAR_LIGHTS_CHUNK !== ShaderChunk.lights_fragment_begin;
  material.onBeforeCompile = (shader, renderer) => {
    if (prev) prev(shader, renderer);
    for (const k of ['uSunDir', 'uSunColor', 'uHazeColor', 'uHazeSunColor', 'uHazeDensity', 'uHazeFalloff']) {
      shader.uniforms[k] = uniforms[k];
    }
    const far = farOK && shader.fragmentShader.includes('#include <lights_fragment_begin>');
    if (far) {
      shader.uniforms.uFarShadowMap = uniforms.uFarShadowMap;
      shader.uniforms.uFarShadowMatrix = uniforms.uFarShadowMatrix;
      shader.uniforms.uFarShadowParams = uniforms.uFarShadowParams;
    }
    if (!shader.vertexShader.includes('vAtmoWorldPos')) {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vAtmoWorldPos;')
        .replace('#include <fog_vertex>', '#include <fog_vertex>\nvAtmoWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\n#ifdef USE_INSTANCING\nvAtmoWorldPos = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;\n#endif');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vAtmoWorldPos;\n' + ATMOSPHERE_GLSL + (far ? FAR_SHADOW_GLSL : ''))
        .replace('#include <lights_fragment_begin>', far ? FAR_LIGHTS_CHUNK : '#include <lights_fragment_begin>')
        .replace('#include <fog_fragment>', 'gl_FragColor.rgb = applyAtmosphere(gl_FragColor.rgb, vAtmoWorldPos);');
    }
  };
  const prevKey = material.customProgramCacheKey.bind(material);
  material.customProgramCacheKey = () => (farOK ? 'atmoF|' : 'atmo|') + prevKey();
  material.needsUpdate = true;
  return material;
}
