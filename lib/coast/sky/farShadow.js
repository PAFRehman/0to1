// Static far-field sun shadow (owned by the sky module).
//
// The main DirectionalLight shadow map only covers the foreground box (x -60..130, z -160..10).
// Beyond it the beach, dunes, surf and the water north of the platform are in dune / terrain
// shadow in the reference (analysis/sky_light.md section 3) but would be fully sunlit. Sun and
// terrain are static, so one orthographic depth map rendered from the sun ONCE (lazily, on the
// first frame, after terrain has been created) covers x -520..920, z -2100..60 (~0.7 m / texel).
//
// Casters: meshes with userData.farShadowCaster === true, or whose name starts with 'terrain'.
// Consumers (custom shaders): include FAR_SHADOW_GLSL, put ctx.uniforms.uFarShadowMap /
// uFarShadowMatrix / uFarShadowParams into the material's uniforms (the same objects), and
// multiply the direct sun term by farSunVisibility(worldPos, worldNormal). It returns 1 inside the
// near shadow box (the regular shadow map handles that), outside the far box and before the
// bake has run.
import * as THREE from 'three';

export const FAR_SHADOW_BOX = { minX: -520, maxX: 920, minY: -5, maxY: 140, minZ: -2100, maxZ: 60 };
const NEAR_BOX = { minX: -60, maxX: 130, minZ: -160, maxZ: 10 };

export const FAR_SHADOW_GLSL = /* glsl */ `
#ifndef FAR_SHADOW_FUNCS
#define FAR_SHADOW_FUNCS
uniform sampler2D uFarShadowMap;
uniform mat4 uFarShadowMatrix;
uniform vec4 uFarShadowParams; // on (0/1), depth bias (depth units per metre), texel size, debug
float farSunVisibility(vec3 wp, vec3 n){
  if (uFarShadowParams.x < 0.5) return 1.0;
  // the near shadow map is valid inside the foreground box: fade the far map out there
  vec2 dn = max(vec2(${NEAR_BOX.minX + 10}.0, ${NEAR_BOX.minZ + 10}.0) - wp.xz, wp.xz - vec2(${NEAR_BOX.maxX - 10}.0, ${NEAR_BOX.maxZ - 10}.0));
  float outNear = smoothstep(0.0, 10.0, max(dn.x, dn.y));
  if (outNear <= 0.0) return 1.0;
  if (uFarShadowParams.w > 0.5) return 1.0 - outNear; // debug: everything outside the near box in shadow
  vec4 c = uFarShadowMatrix * vec4(wp + n * 1.2, 1.0);
  vec3 p = c.xyz / c.w;
  if (p.x <= 0.0 || p.y <= 0.0 || p.x >= 1.0 || p.y >= 1.0 || p.z >= 1.0) return 1.0;
  float z = p.z - uFarShadowParams.y * 1.5;
  float t = uFarShadowParams.z;
  float v = step(z, texture(uFarShadowMap, p.xy).r) * 2.0
          + step(z, texture(uFarShadowMap, p.xy + vec2(t, 0.0)).r)
          + step(z, texture(uFarShadowMap, p.xy - vec2(t, 0.0)).r)
          + step(z, texture(uFarShadowMap, p.xy + vec2(0.0, t)).r)
          + step(z, texture(uFarShadowMap, p.xy - vec2(0.0, t)).r);
  return mix(1.0, v / 6.0, outNear);
}
#endif
`;

export function createFarShadow(renderer, uniforms, sunDir, size = 2048) {
  const rt = new THREE.WebGLRenderTarget(size, size, { depthBuffer: true, stencilBuffer: false });
  rt.depthTexture = new THREE.DepthTexture(size, size);
  rt.depthTexture.type = THREE.UnsignedIntType;
  rt.depthTexture.minFilter = THREE.NearestFilter;
  rt.depthTexture.magFilter = THREE.NearestFilter;

  // orthographic camera looking along -sunDir, fitted to the far box
  const B = FAR_SHADOW_BOX;
  const center = new THREE.Vector3((B.minX + B.maxX) / 2, (B.minY + B.maxY) / 2, (B.minZ + B.maxZ) / 2);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 2);
  cam.position.copy(center).addScaledVector(sunDir, 3000);
  cam.up.set(0, 1, 0);
  cam.lookAt(center);
  cam.updateMatrixWorld();
  const inv = cam.matrixWorldInverse;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  const v = new THREE.Vector3();
  for (let i = 0; i < 8; i++) {
    v.set(i & 1 ? B.maxX : B.minX, i & 2 ? B.maxY : B.minY, i & 4 ? B.maxZ : B.minZ).applyMatrix4(inv);
    minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x);
    minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y);
    minZ = Math.min(minZ, v.z); maxZ = Math.max(maxZ, v.z);
  }
  cam.left = minX; cam.right = maxX; cam.bottom = minY; cam.top = maxY;
  // casters up to ~1.5 km sun-ward of the box (dune ridges, the knoll, the headland)
  cam.near = Math.max(1, -maxZ - 1500); cam.far = -minZ + 10;
  cam.updateProjectionMatrix();
  cam.layers.set(7);

  const bias = new THREE.Matrix4().set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
  const matrix = new THREE.Matrix4().multiplyMatrices(bias, cam.projectionMatrix).multiply(cam.matrixWorldInverse);

  uniforms.uFarShadowMap = { value: rt.depthTexture };
  uniforms.uFarShadowMatrix = { value: matrix };
  uniforms.uFarShadowParams = { value: new THREE.Vector4(0, 1 / (cam.far - cam.near), 1 / size, 0) };

  let done = false;
  const depthMat = new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide });
  return {
    camera: cam,
    renderTarget: rt,
    dispose() { rt.dispose(); rt.depthTexture?.dispose(); depthMat.dispose(); },
    // render once, after the casters exist
    bake(scene) {
      if (done) return;
      done = true;
      const casters = [];
      scene.traverse((o) => {
        if (!o.isMesh || o.isInstancedMesh) return;
        if (o.userData.farShadowCaster === true || (o.userData.farShadowCaster !== false && /^terrain/.test(o.name || ''))) {
          casters.push(o);
          o.layers.enable(7);
        }
      });
      if (!casters.length) { done = false; return; }
      const prevTarget = renderer.getRenderTarget();
      const prevOverride = scene.overrideMaterial;
      const prevBg = scene.background;
      const prevAuto = renderer.autoClear;
      const prevShadowAuto = renderer.shadowMap.autoUpdate;
      scene.overrideMaterial = depthMat;
      scene.background = null;
      renderer.shadowMap.autoUpdate = false;
      renderer.autoClear = true;
      renderer.setRenderTarget(rt);
      renderer.render(scene, cam);
      renderer.setRenderTarget(prevTarget);
      renderer.autoClear = prevAuto;
      renderer.shadowMap.autoUpdate = prevShadowAuto;
      scene.overrideMaterial = prevOverride;
      scene.background = prevBg;
      for (const o of casters) o.layers.disable(7);
      uniforms.uFarShadowParams.value.x = 1;
    },
  };
}
