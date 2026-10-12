import * as THREE from 'three';
import { ACES_GLSL } from './tonemap.js';

/** The existing mobile display transform in one pass, without unused bloom/history buffers. */
export function createRawPost({ renderer, quality }) {
  const gl = renderer.getContext();
  let supported = 0;
  try { supported = Math.max(0, ...gl.getInternalformatParameter(gl.RENDERBUFFER, gl.RGBA16F, gl.SAMPLES)); } catch { /* no multisampling */ }
  const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: Math.min(2, supported), depthBuffer: true, resolveDepthBuffer: false, storeMultisampledDepthBuffer: false });
  target.texture.minFilter = target.texture.magFilter = THREE.LinearFilter;
  target.texture.generateMipmaps = false;
  const material = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3, depthTest: false, depthWrite: false,
    uniforms: { tScene: { value: target.texture } },
    vertexShader: 'in vec3 position; out vec2 vUv; void main(){ vUv = position.xy * .5 + .5; gl_Position = vec4(position.xy, 0., 1.); }',
    fragmentShader: `precision highp float; precision highp int;
      uniform sampler2D tScene; in vec2 vUv; out vec4 fragColor;
      ${ACES_GLSL}
      void main(){ vec3 c=texture(tScene,vUv).rgb;
        c=(any(isnan(c))||any(isinf(c)))?vec3(0.):max(c,vec3(0.));
        fragColor=vec4(clamp(linearToSRGB(ACESFitted(c)),0.,1.),1.);
      }`,
  });
  const geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  const quad = new THREE.Mesh(geometry, material); quad.frustumCulled = false;
  const scene = new THREE.Scene(); scene.add(quad);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  renderer.info.autoReset = false;
  return {
    target,
    setSize(w, h, dpr) { target.setSize(Math.max(1, Math.round(w * dpr * (quality.scale || 1))), Math.max(1, Math.round(h * dpr * (quality.scale || 1)))); },
    render(world, view) {
      renderer.setRenderTarget(target); renderer.render(world, view);
      const clear = renderer.autoClear; renderer.autoClear = false;
      renderer.setRenderTarget(null); renderer.render(scene, camera); renderer.autoClear = clear;
    },
    dispose() { target.dispose(); geometry.dispose(); material.dispose(); },
  };
}
