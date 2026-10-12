// GPU FFT ocean (Tessendorf) with several cascades, evaluated analytically in time:
//   h(k,t) = h0(k) e^{-i w t} + conj(h0(-k)) e^{+i w t}   (crests move along +k)
// The spectrum (JONSWAP + cos^2s spreading) is generated once on the CPU from a seeded RNG,
// then every frame: 1 evolve pass (all cascades stacked vertically), log2(N) horizontal and
// log2(N) vertical Stockham radix-2 passes (MRT, 4 packed complex fields), and one assemble pass per
// cascade into half-float, mip-mapped, repeat-wrapped textures:
//   disp[c]  = (Dx, Dy, Dz, dDx/dz)
//   deriv[c] = (dDy/dx, dDy/dz, dDx/dx, dDz/dz)
// Angular frequencies are quantised to multiples of 2*pi/LOOP so the field is exactly periodic
// (time is passed modulo LOOP to keep float precision forever).
import * as THREE from 'three';
import { mulberry32 } from '../core/rng.js';

const G = 9.81;
export const OCEAN_LOOP = 1200; // seconds; every analytic ocean signal is periodic in this

function gaussPair(rand) {
  let u = 0, v = 0;
  while (u < 1e-12) u = rand();
  v = rand();
  const m = Math.sqrt(-2 * Math.log(u));
  return [m * Math.cos(2 * Math.PI * v), m * Math.sin(2 * Math.PI * v)];
}

function gammaFn(z) {
  // Lanczos approximation
  const p = [676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.PI / (Math.sin(Math.PI * z) * gammaFn(1 - z));
  z -= 1;
  let x = 0.99999999999980993;
  for (let i = 0; i < 8; i++) x += p[i] / (z + i + 1);
  const t = z + 7.5;
  return Math.sqrt(2 * Math.PI) * Math.pow(t, z + 0.5) * Math.exp(-t) * x;
}

// JONSWAP frequency spectrum S(w) [m^2 s]
function jonswap(w, U, F, gamma) {
  if (w <= 0) return 0;
  const alpha = 0.076 * Math.pow((U * U) / (F * G), 0.22);
  const wp = 22 * Math.pow((G * G) / (U * F), 1 / 3);
  const sigma = w <= wp ? 0.07 : 0.09;
  const r = Math.exp(-((w - wp) * (w - wp)) / (2 * sigma * sigma * wp * wp));
  return (alpha * G * G) / Math.pow(w, 5) * Math.exp(-1.25 * Math.pow(wp / w, 4)) * Math.pow(gamma, r);
}

export function buildSpectrum(opts) {
  const { N, cascades, U, fetch, gamma, spread, dir, seed, amp } = opts;
  const C = cascades.length;
  const data = new Float32Array(N * N * C * 4);
  const rand = mulberry32(seed);
  const baseAng = Math.atan2(dir[1], dir[0]);
  const s = spread;
  const Dnorm = gammaFn(s + 1) / (2 * Math.sqrt(Math.PI) * gammaFn(s + 0.5));
  const wpk = 22 * Math.pow((G * G) / (U * fetch), 1 / 3); // JONSWAP peak frequency
  let variance = 0;
  // the random amplitudes are always drawn on the 256^2 reference grid (same RNG sequence), and a
  // smaller N keeps the central band of it: the medium tier's waves are the high tier's waves
  // without the shortest chop, not a different sea
  const NR = Math.max(N, 256);
  const h0R = new Float32Array(NR * NR * 2);
  const h0 = new Float32Array(N * N * 2);
  for (let c = 0; c < C; c++) {
    const { L, kMin, kMax } = cascades[c];
    const dk = (2 * Math.PI) / L;
    for (let m = 0; m < NR; m++) {
      for (let n = 0; n < NR; n++) {
        const kx = (n < NR / 2 ? n : n - NR) * dk;
        const kz = (m < NR / 2 ? m : m - NR) * dk;
        const k = Math.hypot(kx, kz);
        const [g1, g2] = gaussPair(rand);
        let a = 0;
        if (k >= kMin && k < kMax && k > 0) {
          const w = Math.sqrt(G * k);
          const Sw = jonswap(w, U, fetch, gamma);
          const th = Math.atan2(kz, kx) - baseAng;
          // frequency-dependent spreading (Mitsuyasu-like): long-crested near the spectral peak
          // (s ~ 2.6x the base at the peak, falling as 1/f), short-crested (base s) only below ~3 m
          const sw = Math.max(s, s * 2.6 * Math.pow(Math.max(w / wpk, 1), -1.0));
          const Dn = sw === s ? Dnorm : gammaFn(sw + 1) / (2 * Math.sqrt(Math.PI) * gammaFn(sw + 0.5));
          const D = Dn * Math.pow(Math.abs(Math.cos(th / 2)), 2 * sw);
          const dwdk = G / (2 * w);
          let Sk = (Sw * D * dwdk) / k;
          Sk *= Math.exp(-((k * 0.012) * (k * 0.012))); // capillary cut
          const P = Sk * dk * dk * amp * amp;
          variance += P;
          a = Math.sqrt(P / 2);
        }
        const i = (m * NR + n) * 2;
        h0R[i] = g1 * a;
        h0R[i + 1] = g2 * a;
      }
    }
    for (let m = 0; m < N; m++) {
      const mr = ((m < N / 2 ? m : m - N) + NR) % NR;
      for (let n = 0; n < N; n++) {
        const nr = ((n < N / 2 ? n : n - N) + NR) % NR;
        const i = (m * N + n) * 2, j = (mr * NR + nr) * 2;
        h0[i] = h0R[j];
        h0[i + 1] = h0R[j + 1];
      }
    }
    for (let m = 0; m < N; m++) {
      for (let n = 0; n < N; n++) {
        const i = (m * N + n) * 2;
        const nm = (N - n) % N, mm = (N - m) % N;
        const j = (mm * N + nm) * 2;
        const o = ((c * N + m) * N + n) * 4;
        data[o] = h0[i];
        data[o + 1] = h0[i + 1];
        data[o + 2] = h0[j]; // conj(h0(-k))
        data[o + 3] = -h0[j + 1];
      }
    }
  }
  return { data, hs: 4 * Math.sqrt(variance) };
}

const QUAD_VS = /* glsl */ `
in vec3 position;
void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const EVOLVE_FS = /* glsl */ `
precision highp float; precision highp int; precision highp sampler2D;
uniform sampler2D tH0;
uniform float uT;
uniform float uLen[4];
uniform float uChop;
uniform float uW0;
uniform float uPre[4]; // per-cascade prescale (half-float ping-pong: keeps the small spectra above the fp16 floor)
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
#define N ${'${N}'}
vec2 cmul(vec2 a, vec2 b){ return vec2(a.x*b.x - a.y*b.y, a.x*b.y + a.y*b.x); }
vec2 mulI(vec2 a){ return vec2(-a.y, a.x); }
void main(){
  ivec2 p = ivec2(gl_FragCoord.xy);
  int c = p.y / N;
  int n = p.x, m = p.y - c * N;
  float L = uLen[c];
  float dk = 6.28318530718 / L;
  vec2 k = vec2(float(n < N/2 ? n : n - N), float(m < N/2 ? m : m - N)) * dk;
  float kl = length(k);
  vec4 h0 = texelFetch(tH0, p, 0);
  if (kl < 1e-6) { o0 = vec4(0.0); o1 = vec4(0.0); return; }
  float w = sqrt(9.81 * kl);
  w = floor(w / uW0 + 0.5) * uW0;
  float ph = mod(w * uT, 6.28318530718);
  vec2 e = vec2(cos(ph), sin(ph));
  // waves travel along +k (toward the beach): h0(k) e^{-iwt} + conj(h0(-k)) e^{+iwt}
  vec2 h = cmul(h0.xy, vec2(e.x, -e.y)) + cmul(h0.zw, e);
  h *= uPre[c];
  vec2 kn = k / kl;
  vec2 dx = mulI(h) * (-kn.x) * uChop;         // Dx = -i kx/k h
  vec2 dz = mulI(h) * (-kn.y) * uChop;
  vec2 dxdy = mulI(h) * k.x;                    // i kx h
  vec2 dzdy = mulI(h) * k.y;
  vec2 dxdx = h * (k.x * k.x / kl) * uChop;
  vec2 dzdz = h * (k.y * k.y / kl) * uChop;
  vec2 dzdx = h * (k.x * k.y / kl) * uChop;
  // pack pairs of real fields: A + iB
  vec2 P0 = dx + mulI(h);
  vec2 P1 = dz + mulI(dxdx);
  vec2 P2 = dxdy + mulI(dzdy);
  vec2 P3 = dzdz + mulI(dzdx);
  o0 = vec4(P0, P1);
  o1 = vec4(P2, P3);
}
`;

const FFT_FS = /* glsl */ `
precision highp float; precision highp int; precision highp sampler2D;
uniform sampler2D t0;
uniform sampler2D t1;
uniform int uNs;
uniform int uVert;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
#define N ${'${N}'}
vec2 cmul(vec2 a, vec2 b){ return vec2(a.x*b.x - a.y*b.y, a.x*b.y + a.y*b.x); }
void main(){
  ivec2 p = ivec2(gl_FragCoord.xy);
  int tile = (p.y / N) * N;
  int i = uVert == 1 ? p.y - tile : p.x;
  int Ns = uNs;
  int within = i % (2 * Ns);
  int b = i / (2 * Ns);
  int r = within >= Ns ? 1 : 0;
  int jm = within - r * Ns;
  int j = b * Ns + jm;
  ivec2 pa = uVert == 1 ? ivec2(p.x, tile + j) : ivec2(j, p.y);
  ivec2 pb = uVert == 1 ? ivec2(p.x, tile + j + N/2) : ivec2(j + N/2, p.y);
  float ang = 3.14159265359 * float(jm) / float(Ns); // inverse transform: +
  vec2 w = vec2(cos(ang), sin(ang));
  float sg = r == 0 ? 1.0 : -1.0;
  vec4 a0 = texelFetch(t0, pa, 0), b0 = texelFetch(t0, pb, 0);
  vec4 a1 = texelFetch(t1, pa, 0), b1 = texelFetch(t1, pb, 0);
  o0 = vec4(a0.xy + sg * cmul(b0.xy, w), a0.zw + sg * cmul(b0.zw, w));
  o1 = vec4(a1.xy + sg * cmul(b1.xy, w), a1.zw + sg * cmul(b1.zw, w));
}
`;

// Fuse two original Stockham butterflies. All samples and wave bands stay intact;
// the intermediate image needn't travel out to GPU memory between these stages.
const FFT4_FS = /* glsl */ `
precision highp float; precision highp int; precision highp sampler2D;
uniform sampler2D t0, t1;
uniform int uNs, uVert;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
#define N ${'${N}'}
vec2 cmul(vec2 a, vec2 b){ return vec2(a.x*b.x - a.y*b.y, a.x*b.y + a.y*b.x); }
vec4 butterfly(vec4 a, vec4 b, vec2 w, float sg){ return a + sg * vec4(cmul(b.xy,w),cmul(b.zw,w)); }
ivec2 address(int i, ivec2 p){ return uVert == 1 ? ivec2(p.x,(p.y/N)*N+i) : ivec2(i,p.y); }
vec4 fused(sampler2D tex, ivec2 p, int base, vec2 w0, vec2 w1, float s0, float s1){
  vec4 a=texelFetch(tex,address(base,p),0), b=texelFetch(tex,address(base+N/4,p),0);
  vec4 c=texelFetch(tex,address(base+N/2,p),0), d=texelFetch(tex,address(base+3*N/4,p),0);
  return butterfly(butterfly(a,c,w0,s0),butterfly(b,d,w0,s0),w1,s1);
}
void main(){
  ivec2 p=ivec2(gl_FragCoord.xy);
  int i=uVert==1 ? p.y%N : p.x;
  int within=i%(4*uNs), r1=within/(2*uNs), jm1=within%(2*uNs);
  int first=(i/(4*uNs))*(2*uNs)+jm1;
  int r0=(first%(2*uNs))/uNs, jm0=first%uNs;
  int base=(first/(2*uNs))*uNs+jm0;
  float a0=3.14159265359*float(jm0)/float(uNs), a1=3.14159265359*float(jm1)/float(2*uNs);
  vec2 w0=vec2(cos(a0),sin(a0)), w1=vec2(cos(a1),sin(a1));
  float s0=r0==0 ? 1. : -1., s1=r1==0 ? 1. : -1.;
  o0=fused(t0,p,base,w0,w1,s0,s1); o1=fused(t1,p,base,w0,w1,s0,s1);
}
`;

const ASSEMBLE_FS = /* glsl */ `
precision highp float; precision highp int; precision highp sampler2D;
uniform sampler2D t0;
uniform sampler2D t1;
uniform int uTile;
uniform float uPre[4];
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
#define N ${'${N}'}
void main(){
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 q = ivec2(p.x, p.y + uTile * N);
  vec4 a = texelFetch(t0, q, 0);
  vec4 b = texelFetch(t1, q, 0);
  // a = (Dx, Dy, Dz, dDx/dx), b = (dDy/dx, dDy/dz, dDz/dz, dDz/dx)
  float ip = 1.0 / uPre[uTile];
  o0 = vec4(a.x, a.y, a.z, b.w) * ip;
  o1 = vec4(b.x, b.y, a.w, b.z) * ip;
}
`;

export function createFFT(renderer, opts) {
  const N = opts.N;
  const cascades = opts.cascades;
  const C = cascades.length;
  const LOG = Math.round(Math.log2(N));
  const spec = buildSpectrum(opts);

  const h0Tex = new THREE.DataTexture(spec.data, N, N * C, THREE.RGBAFormat, THREE.FloatType);
  h0Tex.minFilter = h0Tex.magFilter = THREE.NearestFilter;
  h0Tex.needsUpdate = true;

  const fullFloat = renderer.extensions.has('EXT_color_buffer_float') && opts.fullFloat !== false;
  const rtOpts = {
    count: 2, type: fullFloat ? THREE.FloatType : THREE.HalfFloatType, format: THREE.RGBAFormat,
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
    depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
  };
  const ping = new THREE.WebGLRenderTarget(N, N * C, rtOpts);
  const pong = new THREE.WebGLRenderTarget(N, N * C, rtOpts);

  // anisotropic filtering of the displacement / derivative maps (grazing view): 4 on high, 2 otherwise
  const aniso = Math.max(1, Math.min(opts.aniso ?? 4, renderer.capabilities.getMaxAnisotropy()));
  // per-cascade prescale for the half-float fallback (fp16 has ~11 bits and a 6e-5 normal floor);
  // divided out again in ASSEMBLE, so the outputs are identical up to rounding
  const pre = fullFloat ? [1, 1, 1, 1] : [16, 64, 1024, 1];
  const outs = cascades.map(() => {
    const rt = new THREE.WebGLRenderTarget(N, N, {
      count: 2, type: THREE.HalfFloatType, format: THREE.RGBAFormat,
      minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
      wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping,
      depthBuffer: false, stencilBuffer: false, generateMipmaps: true, anisotropy: aniso,
    });
    for (const tx of rt.textures) {
      tx.wrapS = tx.wrapT = THREE.RepeatWrapping;
      tx.minFilter = THREE.LinearMipmapLinearFilter;
      tx.magFilter = THREE.LinearFilter;
      tx.generateMipmaps = true;
      tx.anisotropy = aniso;
    }
    return rt;
  });

  const sub = (s) => s.replaceAll('${N}', String(N));
  const mk = (fs, uniforms) => new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3, vertexShader: QUAD_VS, fragmentShader: sub(fs), uniforms,
    depthTest: false, depthWrite: false,
  });
  const lens = [0, 0, 0, 0];
  cascades.forEach((c, i) => { lens[i] = c.L; });
  const evolveMat = mk(EVOLVE_FS, {
    tH0: { value: h0Tex }, uT: { value: 0 }, uLen: { value: lens }, uChop: { value: -opts.choppiness }, // Tessendorf: lambda < 0 -> sharp crests, round troughs
    uW0: { value: (2 * Math.PI) / OCEAN_LOOP }, uPre: { value: pre },
  });
  const fftMat = mk(FFT_FS, { t0: { value: null }, t1: { value: null }, uNs: { value: 1 }, uVert: { value: 0 } });
  const fft4Mat = mk(FFT4_FS, { t0: { value: null }, t1: { value: null }, uNs: { value: 1 }, uVert: { value: 0 } });
  const asmMat = mk(ASSEMBLE_FS, { t0: { value: null }, t1: { value: null }, uTile: { value: 0 }, uPre: { value: pre } });

  const quad = new THREE.Mesh(
    new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3)),
    evolveMat,
  );
  quad.frustumCulled = false;
  const qScene = new THREE.Scene();
  qScene.add(quad);
  const qCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  function pass(mat, target) {
    quad.material = mat;
    renderer.setRenderTarget(target);
    renderer.render(qScene, qCam);
  }

  function update(t) {
    const prevRT = renderer.getRenderTarget();
    const prevAuto = renderer.autoClear;
    const prevShadow = renderer.shadowMap.autoUpdate;
    renderer.autoClear = false;
    renderer.shadowMap.autoUpdate = false;
    const tl = ((t % OCEAN_LOOP) + OCEAN_LOOP) % OCEAN_LOOP;
    evolveMat.uniforms.uT.value = tl;
    pass(evolveMat, ping);
    let src = ping, dst = pong;
    for (let vert = 0; vert < 2; vert++) {
      for (let s = 0; s < LOG;) {
        const paired = opts.radix2 !== true && s + 1 < LOG, mat = paired ? fft4Mat : fftMat;
        mat.uniforms.t0.value = src.textures[0];
        mat.uniforms.t1.value = src.textures[1];
        mat.uniforms.uNs.value = 1 << s;
        mat.uniforms.uVert.value = vert;
        pass(mat, dst); s += paired ? 2 : 1;
        const tmp = src; src = dst; dst = tmp;
      }
    }
    asmMat.uniforms.t0.value = src.textures[0];
    asmMat.uniforms.t1.value = src.textures[1];
    for (let c = 0; c < C; c++) {
      asmMat.uniforms.uTile.value = c;
      pass(asmMat, outs[c]);
    }
    renderer.setRenderTarget(prevRT);
    renderer.autoClear = prevAuto;
    renderer.shadowMap.autoUpdate = prevShadow;
  }

  return {
    update,
    dispose() {
      ping.dispose(); pong.dispose(); outs.forEach(rt => rt.dispose());
      h0Tex.dispose(); evolveMat.dispose(); fftMat.dispose(); fft4Mat.dispose(); asmMat.dispose(); quad.geometry.dispose();
    },
    disp: outs.map((rt) => rt.textures[0]),
    deriv: outs.map((rt) => rt.textures[1]),
    hs: spec.hs,
    lengths: cascades.map((c) => c.L),
  };
}
