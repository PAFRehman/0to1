// Post-processing: the phone-camera look (targets from analysis/sky_light.md section 6).
//
//   scene -> HDR target (half float, MSAA 4x on 'high', 2x on 'medium'/'low', size = canvas * dpr * quality.scale)
//         -> bloom pyramid (soft-threshold Karis prefilter on luminance at 1/2 res, dual-filter
//            down/up chain with falling level weights, 6/5/4 levels by tier)
//         -> composite to screen: lateral chromatic aberration (tiny), rotational motion blur
//            during fast pans (from camera.userData.angVel, 180-degree shutter at 30 fps), bloom,
//            exposure, faint vignette, ACES fitted tone curve (THE calibration contract every
//            module is tuned against: exposure 1, ACES fitted -> sRGB; see tonemap.js for the
//            exact inverse modules can use to hit measured sRGB targets), then in sRGB space:
//            phone ISP/codec detail response at the scale of one reference pixel (luma: small
//            texture gain, soft-clipped so glints/aliasing spikes and big edges get no halos;
//            chroma: 4:2:0-like softening), a near-identity grade (soft cap only above 0.95),
//            30 fps luminance grain fading out in bright areas and 8-bit dither.
//         Also in the composite: analytic sea-horizon softening (thin band, ~1.2 px gaussian).
//         Phone rhythm (pure functions of t): the 4-frame GOP makes every 4th frame a touch
//         crisper; phone ISP drift after each glance to the sea (P.ispUp / P.ispDn, see composite).
//   r4 (pass B, see ISP): codec chroma coring, water anti-striation (vertical Nyquist damping),
//         codec smear of low-contrast texture along the image motion during pans, post-glance
//         local tone mapping of the sky (cloud shadows pulled toward the local mean), then the
//         phone's temporal noise reduction (MCTF): the previous output, reprojected for the
//         camera rotation (5-tap Catmull-Rom), clamped to the current neighbourhood and blended
//         where the change is small (noise, aliasing crawl, low-contrast chop). Pass B writes a
//         ping-pong history target; a last tiny pass adds a STATIC 8-bit dither (the clip's sky
//         is codec-flat between frames) and writes the canvas.
//
// The scene target is ALWAYS multisampled, so alpha-to-coverage on foliage materials works.
//
// Everything is a pure function of the scene image, the camera pose and uTime (grain seed = frame
// index at 30 fps), so captures are deterministic. The MCTF history resets on the first frame,
// on resize and on any time jump (dt outside (0, 0.1 s)); capture renderAt(t) renders t-3/30..t, so
// its first frame resets the history (unless the previous capture ended 0-0.1 s before t-3/30)
// and a capture does not depend on what was rendered before it.
//
// URL flags (dev): ?post=raw   -> ACES + sRGB only (no bloom / grade / lens effects)
//                  ?post=nobloom, ?post=nograin, ?post=nosharp (no detail response) (comma separated)
import * as THREE from 'three';
import { ACES_GLSL } from './tonemap.js';
import { GLANCES } from '../camera/handheld.js';
import { createRawPost } from './raw.js';

const VERT = /* glsl */ `
in vec3 position;
out vec2 vUv;
void main(){ vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

// --- bloom -----------------------------------------------------------------------------------
// Prefilter: 13-tap-ish (4 bilinear taps in a box) downsample with a soft knee threshold on the
// max channel so only real highlights (sunlit foam, the bright horizon) feed the glow.
const PREFILTER = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D tSrc;
uniform vec2 uTexel;       // source texel size
uniform float uThreshold;
uniform float uKnee;
in vec2 vUv;
out vec4 fragColor;
vec3 soft(vec3 c){
  float br = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float rq = clamp(br - uThreshold + uKnee, 0.0, 2.0 * uKnee);
  rq = rq * rq / (4.0 * uKnee + 1e-5);
  float w = max(rq, br - uThreshold) / max(br, 1e-5);
  return c * w;
}
// NaN / Inf containment: a single non-finite or half-float-overflowing tap would otherwise turn
// the Karis weight into Inf*0 = NaN and spread through the whole pyramid as blocks
vec3 sane(vec3 c){ return (any(isnan(c)) || any(isinf(c))) ? vec3(0.0) : clamp(c, 0.0, 64.0); }
void main(){
  vec2 o = uTexel;
  vec3 a = sane(texture(tSrc, vUv + vec2(-o.x, -o.y)).rgb);
  vec3 b = sane(texture(tSrc, vUv + vec2( o.x, -o.y)).rgb);
  vec3 c = sane(texture(tSrc, vUv + vec2(-o.x,  o.y)).rgb);
  vec3 d = sane(texture(tSrc, vUv + vec2( o.x,  o.y)).rgb);
  // Karis-style weighting against fireflies (specular glints on the sea)
  const vec3 LW = vec3(0.2126, 0.7152, 0.0722);
  float wa = 1.0 / (1.0 + dot(a, LW));
  float wb = 1.0 / (1.0 + dot(b, LW));
  float wc = 1.0 / (1.0 + dot(c, LW));
  float wd = 1.0 / (1.0 + dot(d, LW));
  vec3 m = (a * wa + b * wb + c * wc + d * wd) / (wa + wb + wc + wd);
  m = min(m, vec3(64.0));
  fragColor = vec4(soft(m), 1.0);
}
`;

// Dual-filter (Kawase) downsample
const DOWN = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D tSrc;
uniform vec2 uTexel;
in vec2 vUv;
out vec4 fragColor;
void main(){
  vec2 o = uTexel;
  vec3 s = texture(tSrc, vUv).rgb * 4.0;
  s += texture(tSrc, vUv - o).rgb;
  s += texture(tSrc, vUv + o).rgb;
  s += texture(tSrc, vUv + vec2(o.x, -o.y)).rgb;
  s += texture(tSrc, vUv - vec2(o.x, -o.y)).rgb;
  fragColor = vec4(s / 8.0, 1.0);
}
`;

// Dual-filter upsample + add the finer level of the down chain
const UP = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D tSrc;   // coarser (being upsampled)
uniform sampler2D tBase;  // same-res level of the down chain
uniform vec2 uTexel;      // coarse texel
uniform float uBaseWeight;  // weight of this level's own (down chain) contribution
in vec2 vUv;
out vec4 fragColor;
void main(){
  vec2 o = uTexel * 0.5;
  vec3 s = vec3(0.0);
  s += texture(tSrc, vUv + vec2(-o.x * 2.0, 0.0)).rgb;
  s += texture(tSrc, vUv + vec2(-o.x, o.y)).rgb * 2.0;
  s += texture(tSrc, vUv + vec2(0.0, o.y * 2.0)).rgb;
  s += texture(tSrc, vUv + vec2(o.x, o.y)).rgb * 2.0;
  s += texture(tSrc, vUv + vec2(o.x * 2.0, 0.0)).rgb;
  s += texture(tSrc, vUv + vec2(o.x, -o.y)).rgb * 2.0;
  s += texture(tSrc, vUv + vec2(0.0, -o.y * 2.0)).rgb;
  s += texture(tSrc, vUv + vec2(-o.x, -o.y)).rgb * 2.0;
  fragColor = vec4(s / 12.0 + texture(tBase, vUv).rgb * uBaseWeight, 1.0);
}
`;

// --- pass A: HDR composite -> display sRGB (full output res, half float) ---------------------
// lens + scene-referred effects: lateral CA, pan motion blur, near-field defocus, horizon / far
// softening, bloom, exposure, vignette, ACES fitted (THE calibration contract) -> sRGB.
const COMPOSITE = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D tScene;
uniform sampler2D tBloom;
uniform vec2 uTexel;          // scene texel size
uniform vec2 uRes;            // output resolution (px)
uniform float uAspect;
uniform float uExposure;
uniform float uBloom;
uniform float uCA;            // lateral CA: fractional radial scale difference at the corner
uniform float uVignette;
uniform float uSharpRadius;   // one reference-video pixel, in scene texels
uniform float uRaw;
uniform vec2 uBlurVec;        // camera-rotation motion blur extent (uv units)
uniform float uBlurAmt;       // 0..1 fade-in of the blur
uniform vec3 uHzn;            // horizon line in output px: dist = dot(uHzn.xy, px) + uHzn.z
uniform float uHznW;          // output px per reference px
uniform float uHznSigma;      // horizon softening band sigma (reference px)
uniform float uFarSoft;       // far-field softening amount (0..1)
uniform float uLowCost;       // 1 when the scene target runs below 0.75 scale: cheaper composite
uniform vec3 uVeil;           // lens veiling glare (display-linear add)
in vec2 vUv;
out vec4 fragColor;
${ACES_GLSL}
// composite guard: never let a non-finite scene / bloom value reach the tone curve
vec3 sane(vec3 c){ return (any(isnan(c)) || any(isinf(c))) ? vec3(0.0) : max(c, vec3(0.0)); }

void main(){
  vec2 uv = vUv;
  if (uRaw > 0.5) {
    fragColor = vec4(linearToSRGB(ACESFitted(sane(texture(tScene, uv).rgb) * uExposure)), 1.0);
    return;
  }
  vec2 cc = uv - 0.5;
  vec2 ccA = cc * vec2(uAspect, 1.0);
  float r2 = dot(ccA, ccA) / (0.25 * (uAspect * uAspect + 1.0)); // 0 centre .. 1 corner

  // lateral chromatic aberration (red scaled out, blue scaled in), grows with r^2
  float ca = uCA * r2;
  vec3 c0;
  if (uLowCost > 0.5) c0 = texture(tScene, uv).rgb; // CA is sub-pixel at low scale anyway
  else {
    c0.r = texture(tScene, 0.5 + cc * (1.0 + ca)).r;
    c0.g = texture(tScene, uv).g;
    c0.b = texture(tScene, 0.5 + cc * (1.0 - ca)).b;
  }
  // rotational motion blur during the fast glance pan (180-degree shutter at 30 fps, ~1-2 px)
  if (uBlurAmt > 0.0) {
    vec3 mb = (c0 * 2.0 + texture(tScene, uv + uBlurVec * 0.5).rgb + texture(tScene, uv - uBlurVec * 0.5).rgb
        + texture(tScene, uv + uBlurVec * 0.25).rgb + texture(tScene, uv - uBlurVec * 0.25).rgb) / 6.0;
    c0 = mix(c0, mb, uBlurAmt);
  }
  c0 = sane(c0);

  // Far field: in the clip the sky->sea step spreads over 3-4 px and the distant surf / dunes /
  // hills are ~2x softer than our render (haze, sub-pixel waves, lens + codec). In this framing
  // everything near the horizon row is kilometres away, so soften by distance to the analytic
  // horizon line: a ~1.2 px gaussian across the line inside a thin band, plus a light 5-tap
  // blur that fades out ~60 px below / ~80 px above it.
  float hd = (dot(uHzn.xy, gl_FragCoord.xy) + uHzn.z) / uHznW; // reference px, + above
  // asymmetric: the clip's sky side of the step is soft, the sea side stays dark right below it
  float hsig = hd < 0.0 ? 1.3 : uHznSigma;
  float hw = exp(-0.5 * hd * hd / (hsig * hsig));
  if (hw > 0.02) {
    vec2 hn = uHzn.xy * uTexel * uSharpRadius; // one reference px along the line normal (uv)
    vec3 hb = c0 * 0.36 + (texture(tScene, uv + hn).rgb + texture(tScene, uv - hn).rgb) * 0.22
            + (texture(tScene, uv + 2.0 * hn).rgb + texture(tScene, uv - 2.0 * hn).rgb) * 0.09
            + (texture(tScene, uv + 3.0 * hn).rgb + texture(tScene, uv - 3.0 * hn).rgb) * 0.01;
    c0 = mix(c0, hb, hw);
  }
  float farW = uFarSoft * (hd < 0.0 ? smoothstep(2.0, 6.0, -hd) * (1.0 - smoothstep(10.0, 60.0, -hd)) : 1.0 - smoothstep(20.0, 80.0, hd));
  if (farW > 0.001) {
    vec2 so = uTexel * uSharpRadius;
    vec3 n = sane(texture(tScene, uv + vec2(so.x, 0.0)).rgb) + sane(texture(tScene, uv - vec2(so.x, 0.0)).rgb)
           + sane(texture(tScene, uv + vec2(0.0, so.y)).rgb) + sane(texture(tScene, uv - vec2(0.0, so.y)).rgb);
    c0 = mix(c0, (c0 * 4.0 + n) * 0.125, farW);
  }

  vec3 add = sane(texture(tBloom, uv).rgb) * uBloom;
  float vig = 1.0 - uVignette * r2 * (0.6 + 0.4 * r2);
  // + veiling glare of the phone lens (uniform display-linear floor, P.veil)
  fragColor = vec4(linearToSRGB(ACESFitted((c0 + add) * uExposure * vig) + uVeil), 1.0);
}
`;

// --- mid-band blur of the display image (half output res, separable gaussian) -----------------
// sigma = P.ispSigma reference px; 13 taps at 0.5 sigma spacing (+-3 sigma). The horizontal pass
// reads the full-res display image at half-res pixel centres (bilinear = 2x2 box prefilter).
const BLUR = /* glsl */ `
precision highp float;
precision highp sampler2D;
uniform sampler2D tSrc;
uniform vec2 uStep;           // uv offset of one tap (0.5 sigma along the pass direction)
in vec2 vUv;
out vec4 fragColor;
void main(){
  vec3 s = texture(tSrc, vUv).rgb;
  float wsum = 1.0;
  for (int i = 1; i <= 6; i++) {
    float w = exp(-0.125 * float(i * i));
    s += (texture(tSrc, vUv + uStep * float(i)).rgb + texture(tSrc, vUv - uStep * float(i)).rgb) * w;
    wsum += 2.0 * w;
  }
  fragColor = vec4(s / wsum, 1.0);
}
`;

// --- pass B: phone ISP + codec on the display image (to screen) --------------------------------
// Fitted on the full render vs the reference at t = 0.5 and 9 (work/r3_look/isp2.py): radially
// averaged luma power spectra in 7 regions (octave bands 0.08-0.5 cyc/px), detail percentiles,
// chroma high-pass and the median profile across isolated strong edges (no halos in the clip).
//   luma:  Nyquist band b1 = Y - cross5(1 px)   -> cored (small noise-like wiggles removed) and
//                                                   x uNyq (< 1: the clip's demosaic / codec softness)
//          mid band   b2 = cross5 - gauss(2.6 px) -> texture-only boost: + k * b2 * exp(-(b2/c)^2),
//                                                   peaks at ~5 levels, zero on big edges (no halos)
//   chroma: ~1.5 px blur (4:2:0 subsampling + codec chroma quantisation; clip chroma HP 0.3 vs 0.7)
// then a near-identity grade, the phone ISP drift after glances, 30 fps sensor grain, 8-bit dither.
const ISP = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D tLdr;       // display sRGB, output res
uniform sampler2D tBlur;      // gauss(ispSigma) of tLdr, half res
uniform vec2 uOutTexel;       // 1 / output res
uniform vec2 uRes;            // output res (px)
uniform float uTime;
uniform float uRaw;
uniform float uSharpRadius;   // one reference px in output px
uniform float uCamH;          // frame height of the emulated camera (px)
uniform float uNyq;           // Nyquist band gain
uniform float uCore;          // Nyquist band coring threshold (sRGB units)
uniform float uMidK;          // mid-band texture boost
uniform float uMidC;          // mid-band bump width (sRGB units)
uniform float uChromaSoft;    // 0 = keep chroma, 1 = fully blurred chroma
uniform float uChromaCore;    // codec chroma coring threshold (sRGB units)
uniform float uLandDesat;     // extra desaturation below the horizon band (fraction)
uniform float uGrain;
uniform float uCapKnee;
uniform float uCapWhite;
uniform vec3 uSlope;
uniform vec3 uOffset;
uniform vec3 uPower;
uniform float uSaturation;
uniform vec3 uShadowTint;
uniform vec3 uHighTint;
uniform float uIspUp;         // phone ISP drift after a glance: lift of the sea / horizon band (sRGB add)
uniform float uIspDn;         // ... and darkening of the foreground land (fraction)
uniform vec2 uIspSky;         // ... and of the sky above the band (fraction), cooler warm sky (R, sRGB)
uniform vec3 uHzn;            // horizon line in output px
uniform float uHznW;          // output px per reference px
uniform vec2 uSkyComp;        // post-glance local tone mapping of the sky: contrast compression, offset
uniform vec2 uSkyMeanStep;    // uv offset of the cloud-scale local mean taps (24 reference px)
uniform vec2 uPanVec;         // codec smear along the image motion: uv extent of the 5-tap bilateral line
uniform float uPanK;          // 0..1 pan strength (codec starvation)
uniform float uSeaV;          // vertical Nyquist damping on the water (anti-striation)
// phone temporal noise reduction (MCTF): previous output reprojected for the camera rotation
uniform sampler2D tHist;
uniform mat3 uReproj;         // R_prev^-1 * R_cur (camera space)
uniform vec2 uProj;           // projection scale (P00, P11)
uniform float uHistW;         // history weight this frame (0 = reset)
uniform float uHistK;         // motion-rejection threshold (sRGB luma units)
in vec2 vUv;
out vec4 fragColor;
const vec3 LW = vec3(0.2126, 0.7152, 0.0722);
float luma(vec3 c){ return dot(c, LW); }

// 5-tap Catmull-Rom history fetch: bilinear resampling of the history at a sub-pixel offset every
// frame would accumulate blur (a TAA-style soft image); bicubic keeps the static detail spectrum
vec3 histCR(vec2 uv){
  vec2 ts = vec2(textureSize(tHist, 0));
  vec2 sp = uv * ts;
  vec2 t1 = floor(sp - 0.5) + 0.5;
  vec2 f = sp - t1;
  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  vec2 w3 = f * f * (-0.5 + 0.5 * f);
  vec2 w12 = w1 + w2;
  vec2 p0 = (t1 - 1.0) / ts, p3 = (t1 + 2.0) / ts, p12 = (t1 + w2 / w12) / ts;
  vec3 r = texture(tHist, vec2(p12.x, p0.y)).rgb * (w12.x * w0.y)
         + texture(tHist, vec2(p0.x, p12.y)).rgb * (w0.x * w12.y)
         + texture(tHist, p12).rgb * (w12.x * w12.y)
         + texture(tHist, vec2(p3.x, p12.y)).rgb * (w3.x * w12.y)
         + texture(tHist, vec2(p12.x, p3.y)).rgb * (w12.x * w3.y);
  return r / (w12.x * w0.y + w0.x * w12.y + w12.x * w12.y + w3.x * w12.y + w12.x * w3.y);
}

// near-identity display grade in sRGB-encoded space (ASC-CDL style)
vec3 grade(vec3 s){
  // soft highlight cap above the knee (phone video rarely hard-clips)
  vec3 over = max(s - uCapKnee, 0.0);
  float span = max(uCapWhite - uCapKnee, 1e-4);
  s = min(s, vec3(uCapKnee)) + span * (1.0 - exp(-over / span));
  s = s * uSlope + uOffset;
  s = pow(max(s, vec3(0.0)), uPower);
  float y = dot(s, LW);
  s = mix(vec3(y), s, uSaturation);
  float hw = smoothstep(0.35, 0.9, y);
  s *= mix(uShadowTint, uHighTint, hw);
  return s;
}

// integer hash -> [0,1) (needs 32-bit uint wraparound: highp int above)
float hash(uvec3 v){
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return float(v.x & 0x00ffffffu) / 16777216.0;
}

void main(){
  vec2 uv = vUv;
  vec3 s0 = texture(tLdr, uv).rgb;
  if (uRaw > 0.5) { fragColor = vec4(clamp(s0, 0.0, 1.0), 1.0); return; }
  vec2 o = uOutTexel * uSharpRadius;
  vec3 n0 = texture(tLdr, uv + vec2(o.x, 0.0)).rgb;
  vec3 n1 = texture(tLdr, uv - vec2(o.x, 0.0)).rgb;
  vec3 n2 = texture(tLdr, uv + vec2(0.0, o.y)).rgb;
  vec3 n3 = texture(tLdr, uv - vec2(0.0, o.y)).rgb;
  vec3 d0 = texture(tLdr, uv + o * 1.25).rgb;
  vec3 d1 = texture(tLdr, uv - o * 1.25).rgb;
  vec3 d2 = texture(tLdr, uv + vec2(o.x, -o.y) * 1.25).rgb;
  vec3 d3 = texture(tLdr, uv + vec2(-o.x, o.y) * 1.25).rgb;
  vec3 bl = texture(tBlur, uv).rgb;
  vec3 cross = s0 * 0.4 + (n0 + n1 + n2 + n3) * 0.15;
  float y0 = luma(s0), y1 = luma(cross), y2 = luma(bl);
  float hd = (dot(uHzn.xy, gl_FragCoord.xy) + uHzn.z) / uHznW; // reference px, + above the horizon
  // the sky and the clouds are codec-soft in the clip: no ISP detail processing above the horizon band
  float land = 1.0 - smoothstep(15.0, 30.0, hd);
  float b1 = y0 - y1, b2 = y1 - y2;
  float b1c = b1 * (1.0 - exp(-(b1 * b1) / (uCore * uCore)));
  // (isolated bright specks keep their peak: the clip's sunlit foam / glints reach 238-255 at
  // pixel scale; bright LINES (foam streaks, crest lines) get the normal Nyquist gain, otherwise
  // they alias into 1-px stair-steps and striation)
  float yN = max(max(luma(n0), luma(n1)), max(luma(n2), luma(n3)));
  float speck = smoothstep(0.72, 0.86, y0) * smoothstep(0.0, 6.0 / 255.0, y0 - yN) * step(0.0, b2);
  float nyq = mix(uNyq, 1.0, max(speck, 0.5 * smoothstep(0.72, 0.86, y0)));
  float y = y0 + land * ((nyq - 1.0) * b1c - (b1 - b1c) + uMidK * b2 * exp(-(b2 * b2) / (uMidC * uMidC)));
  // water below the horizon: the render's finest wave-normal octaves alias into 1-2 px horizontal
  // striation the clip never shows (sea: vertical-frequency power +0.37 log, horizontal -0.25;
  // reviewer dirspec.py). Optical low-pass of the phone lens / demosaic: damp the vertical
  // Nyquist band where the image is blue-green water (not the white foam, the land or the sky).
  float seaK = uSeaV * smoothstep(0.03, 0.1, s0.b - s0.r) * (1.0 - smoothstep(-4.0, 2.0, hd)) * (1.0 - speck);
  y -= seaK * (y0 - 0.25 * (2.0 * y0 + luma(n2) + luma(n3)));
  // codec starvation during fast pans: low-contrast texture is quantised away along the motion
  // (the clip's hills / sea turn into horizontal tonal streaks at 1.3-2.6 px/frame) while strong
  // edges (foam, silhouettes) keep their shape: a 5-tap bilateral line filter along the motion
  if (uPanK > 0.0) {
    float ya = luma(texture(tLdr, uv + uPanVec).rgb), yb = luma(texture(tLdr, uv - uPanVec).rgb);
    float yc = luma(texture(tLdr, uv + 0.5 * uPanVec).rgb), yd = luma(texture(tLdr, uv - 0.5 * uPanVec).rgb);
    const float SK = 255.0 / 7.0; // 1 / (7 levels)
    vec4 dd = (vec4(ya, yb, yc, yd) - y0) * SK; // (no pow(): undefined for a negative base)
    vec4 ww = exp(-dd * dd);
    float wa = ww.x, wb = ww.y, wc = ww.z, wd = ww.w;
    float ys = (y0 + ya * wa + yb * wb + yc * wc + yd * wd) / (1.0 + wa + wb + wc + wd);
    y += (ys - y0) * uPanK * land;
  }
  // chroma: ~1.5 reference px blur (9 taps within 1.25 px, mixed with the 2.6 px gaussian)
  vec3 c9 = (s0 + n0 + n1 + n2 + n3 + d0 + d1 + d2 + d3) / 9.0;
  // + codec chroma quantisation: small chroma wiggles around the 2.6 px chroma are cored away (the
  // clip's sea chroma HP is 0.14-0.28 vs 0.9 here after the plain blur; strong chroma edges stay)
  vec3 cL = bl - y2;
  vec3 dC = (c9 - luma(c9)) - cL;
  float dC2 = dot(dC, dC);
  vec3 cB = cL + 0.55 * dC * (dC2 / (dC2 + uChromaCore * uChromaCore));
  vec3 srgb = vec3(y) + mix(s0 - y0, cB, uChromaSoft);
  srgb = grade(srgb);
  // below the horizon band the render still runs more saturated than the clip in most regions
  // at t 0.5 / 2 / 4 / 9 (sea mid +25 %, trees +20-25 %, platform, hills, dunes +10-40 %; far sea
  // and grass -3..-6 %); the sky and clouds match: a mild extra desaturation of the land and sea
  srgb = mix(vec3(dot(srgb, LW)), srgb, 1.0 - uLandDesat * land);
  float yB = y1;
  // phone ISP drift after a glance to the sea (reference time series, x 10-130): from t ~ 4.5 s
  // the horizon band and the far / mid sea are lifted (+20 levels at the glance peak, ~+12 held
  // for the rest of the clip, roughly neutral, a little warm at the peak) while the foreground
  // land / grass darkens ~12 %; the bright sky above ~50 px, the right-hand dunes and bright foam
  // do not move. Keyed spatially (distance to the horizon) and on blueness (sea, sky band).
  if (uIspUp + uIspDn > 0.0) {
    // key: below the line only the (saturated) sea, not the blue-grey hazy land; above it only
    // the bright horizon band, not the hills standing above the line on the right
    float blueK = mix(smoothstep(0.06, 0.16, srgb.b - srgb.r),
                      smoothstep(0.5, 0.62, yB) * smoothstep(-0.02, 0.03, srgb.b - srgb.r), smoothstep(-3.0, 3.0, hd));
    float upK = (1.0 - smoothstep(35.0, 80.0, hd)) * (1.0 - smoothstep(80.0, 240.0, -hd));
    float midK = smoothstep(0.12, 0.3, yB) * (1.0 - smoothstep(0.76, 0.88, yB));
    srgb += uIspUp * blueK * upK * midK * vec3(1.0, 0.96, 0.85);
    float fgK = smoothstep(150.0, 320.0, -hd) * (1.0 - smoothstep(0.0, 0.08, srgb.b - srgb.r)) * (1.0 - smoothstep(0.45, 0.75, yB));
    srgb *= 1.0 - uIspDn * fgK;
    // above the band the clip's sky dims ~4 % and the warm sun-side sky / cloud tops lose ~13
    // levels of red (the phone's white balance follows the blue sea)
    float skyK = smoothstep(25.0, 70.0, hd);
    // (the warm sun-side sky on the right only: the peach cloud tops keep their colour)
    float warmK = smoothstep(0.0, 0.07, srgb.r - srgb.b) * smoothstep(0.62, 0.8, gl_FragCoord.x / uRes.x);
    // local tone mapping of the sky after the glance (clip, t 0.5 -> 9, camera-tracked): the
    // clear sky and the cloud medians dim ~5 levels, cloud highlights only 3-6, but the cloud
    // SHADOWS lift +5..8 (C1 p2 174 -> 179, C2 166 -> 174): the shaded parts are pulled toward a
    // cloud-scale local mean (5 taps of the 2.6 px blur, +-24 reference px), then everything dims.
    if (uSkyComp.x > 0.0 && skyK > 0.0) {
      vec3 m = (bl + texture(tBlur, uv + vec2(uSkyMeanStep.x, 0.0)).rgb + texture(tBlur, uv - vec2(uSkyMeanStep.x, 0.0)).rgb
              + texture(tBlur, uv + vec2(0.0, uSkyMeanStep.y)).rgb + texture(tBlur, uv - vec2(0.0, uSkyMeanStep.y)).rgb) * 0.2;
      m = grade(m);
      float lift = uSkyComp.x * smoothstep(0.0, 0.03, luma(m) - luma(srgb));
      srgb = mix(srgb, m, lift * skyK);
    }
    srgb.r -= uIspSky.y * skyK * warmK;
    srgb *= 1.0 - uIspSky.x * skyK * (1.0 - 0.8 * warmK);
  }

  // sensor grain: luminance-only, at the size of a camera pixel, refreshed at 30 fps,
  // stronger in the shadows (read noise); bright sky keeps (almost) only the 8-bit dither — the
  // reference sky is codec-flat.
  float frame = floor(uTime * 30.0 + 0.5);
  vec2 gp = gl_FragCoord.xy * (uCamH / uRes.y);
  vec2 gi = floor(gp);
  vec2 gf = gp - gi; gf = gf * gf * (3.0 - 2.0 * gf);
  uint fr = uint(int(mod(frame, 65536.0)));
  float g00 = hash(uvec3(uvec2(ivec2(gi) + 4096), fr));
  float g10 = hash(uvec3(uvec2(ivec2(gi + vec2(1.0, 0.0)) + 4096), fr));
  float g01 = hash(uvec3(uvec2(ivec2(gi + vec2(0.0, 1.0)) + 4096), fr));
  float g11 = hash(uvec3(uvec2(ivec2(gi + vec2(1.0, 1.0)) + 4096), fr));
  float g = mix(mix(g00, g10, gf.x), mix(g01, g11, gf.x), gf.y) - 0.5;
  float L = luma(srgb);
  float gAmp = uGrain * (0.55 + 0.9 * (1.0 - L) * L * 2.0 + 0.4 * (1.0 - L)) * (1.0 - 0.8 * smoothstep(0.55, 0.8, L));
  srgb += g * gAmp;

  // phone temporal noise reduction (MCTF) + codec temporal smoothing: blend with the previous
  // output, reprojected for the camera rotation, where the change is small (noise, aliasing
  // crawl, low-contrast chop); large changes (moving foam, tossing foliage edges) are rejected.
  // History clamped to the current 3x3 neighbourhood (shifted by this pixel's ISP change).
  if (uHistW > 0.0) {
    vec2 ndc = uv * 2.0 - 1.0;
    vec3 dc = uReproj * vec3(ndc.x / uProj.x, ndc.y / uProj.y, -1.0);
    vec2 hv = (vec2(uProj.x * dc.x, uProj.y * dc.y) / max(-dc.z, 1e-4)) * 0.5 + 0.5;
    if (hv.x > 0.0 && hv.x < 1.0 && hv.y > 0.0 && hv.y < 1.0) {
      vec3 h = max(histCR(hv), vec3(0.0));
      vec3 sh = srgb - s0;
      vec3 mn = min(min(min(s0, n0), min(n1, n2)), min(min(n3, d0), min(d1, min(d2, d3)))) + sh - uHistK;
      vec3 mx = max(max(max(s0, n0), max(n1, n2)), max(max(n3, d0), max(d1, max(d2, d3)))) + sh + uHistK;
      float dy = (luma(h) - luma(srgb)) / uHistK;
      float w = uHistW * exp(-dy * dy);
      srgb = mix(srgb, clamp(h, mn, mx), w);
    }
  }
  fragColor = vec4(clamp(srgb, 0.0, 1.0), 1.0);
}
`;

// --- final pass: 8-bit dither (static pattern: the clip's flat sky does not shimmer) -> screen --
const OUT = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D tSrc;
uniform float uRaw;
in vec2 vUv;
out vec4 fragColor;
float hash(uvec3 v){
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return float(v.x & 0x00ffffffu) / 16777216.0;
}
void main(){
  vec3 c = texture(tSrc, vUv).rgb;
  if (uRaw < 0.5) c += (hash(uvec3(uvec2(gl_FragCoord.xy), 7u)) - 0.5) / 255.0;
  fragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}
`;

// Phone ISP drift envelopes [lift of sea / band, darkening of the foreground] as pure functions of
// t (180 s loop). Measured on the replayed glance (peak yaw at u ~ 6.25 s): rises 3.8-5.8 s, the
// lift relaxes to ~60 % by 8.5 s and holds, both fade out 20-40 s after the glance. The
// procedural glances (handheld.js GLANCES) reuse the shape, scaled by their amplitude.
const smooth01 = (a, b, x) => { const k = Math.min(1, Math.max(0, (x - a) / (b - a))); return k * k * (3 - 2 * k); };
function ispShape(x) {
  if (x <= 3.8 || x >= 40) return [0, 0, 0];
  const on = smooth01(3.8, 5.8, x) * (1 - smooth01(20, 40, x));
  const late = smooth01(6.3, 8.5, x);
  // [sea / band lift, foreground darkening, sky dimming (only after the peak)]
  return [on * (1 - 0.4 * late), on, on * late];
}
function ispEnvelope(t) {
  const u = ((t % 180) + 180) % 180;
  const e = ispShape(u);
  for (const [c, amp] of GLANCES) {
    const g = ispShape(u - c + 6.25);
    const k = Math.min(1, amp / 9.6);
    for (let i = 0; i < 3; i++) e[i] = Math.max(e[i], g[i] * k);
  }
  return e;
}

export default async function create(ctx) {
  const { renderer, quality } = ctx;
  const tier = quality.tier || 'high';
  const flags = new Set((ctx.params.get('post') || '').split(',').map((s) => s.trim()).filter(Boolean));
  const RAW = flags.has('raw');
  if (RAW) return createRawPost(ctx);
  // frame height of the emulated camera (px): every ISP / codec / grain scale below is defined in its
  // pixels. Default: the 718 px reference clip (a bigger screen shows the same soft phone image);
  // the video export passes ?camh=<output height> for a native-resolution camera.
  const camH = Number(ctx.params.get('camh'));
  const CAM_H = Number.isFinite(camH) && camH > 0 ? Math.min(16384, Math.max(120, camH)) : 718;

  // A float colour buffer is required for the HDR target. Without it, fail cleanly: main.js then
  // renders straight to the canvas with three's ACES (exposure 0.6 == our ACES fitted at 1).
  const ext = renderer.extensions;
  if (!(ext.has('EXT_color_buffer_float') || ext.has('EXT_color_buffer_half_float'))) {
    renderer.toneMappingExposure = 0.6;
    throw new Error('no float colour buffer: post disabled');
  }

  // renderer.info must not auto-reset (post issues ~12 render() calls per frame). Counters then
  // accumulate until someone resets them (main.js perf() resets once per frame, so it reads
  // whole-frame totals). `sceneInfo` = the scene pass alone (incl. shadow maps); `frameInfo` =
  // everything since the end of the previous frame (module passes in update(), scene, post).
  renderer.info.autoReset = false;
  const INFO_KEYS = ['calls', 'triangles', 'points', 'lines'];
  const sceneInfo = { calls: 0, triangles: 0, points: 0, lines: 0 };
  const frameInfo = { calls: 0, triangles: 0, points: 0, lines: 0 };
  const infoEnd = { calls: 0, triangles: 0, points: 0, lines: 0 };
  const infoPre = { calls: 0, triangles: 0, points: 0, lines: 0 };

  // MSAA is also what makes alpha-to-coverage foliage edges smooth: keep samples >= 2. Query the
  // sample counts the driver supports for RGBA16F renderbuffers; none -> throw (main falls back).
  const gl = renderer.getContext();
  let maxS = 4;
  try {
    const sl = gl.getInternalformatParameter(gl.RENDERBUFFER, gl.RGBA16F, gl.SAMPLES);
    maxS = sl && sl.length ? Math.max(...sl) : 0;
  } catch (e) { maxS = 0; }
  const samples = Math.min(tier === 'high' ? 4 : 2, maxS);
  if (samples < 1) {
    renderer.toneMappingExposure = 0.6;
    throw new Error('RGBA16F multisampling unsupported: post disabled');
  }
  // depth is only used for the scene pass itself (never sampled): skip the depth resolve / store
  const target = new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.HalfFloatType,
    samples,
    depthBuffer: true,
    resolveDepthBuffer: false,
    storeMultisampledDepthBuffer: false,
  });
  target.texture.minFilter = THREE.LinearFilter;
  target.texture.magFilter = THREE.LinearFilter;
  target.texture.generateMipmaps = false;
  {
    // framebuffer completeness (an unsupported float MSAA format would otherwise render black)
    const prevRT = renderer.getRenderTarget();
    renderer.setRenderTarget(target);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    renderer.setRenderTarget(prevRT);
    if (!ok) {
      target.dispose();
      renderer.toneMappingExposure = 0.6;
      throw new Error('HDR render target incomplete: post disabled');
    }
  }

  // bloom pyramid: level 0 = 1/2 res on every tier (4 bilinear taps at +-1 texel cover the full
  // 2x2 footprint: no sparkle flicker); lower tiers use fewer levels.
  const LEVELS = tier === 'high' ? 6 : tier === 'medium' ? 5 : 4;
  const START_DIV = 2;
  // per-level weights (fine -> coarse): tight halation, weak wide glow (no veil over the hills)
  const LEVEL_W = [1.0, 0.8, 0.6, 0.45, 0.3, 0.2];
  const mkRT = () => {
    const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
    rt.texture.minFilter = THREE.LinearFilter;
    rt.texture.magFilter = THREE.LinearFilter;
    rt.texture.generateMipmaps = false;
    return rt;
  };
  const down = Array.from({ length: LEVELS }, mkRT);
  const up = Array.from({ length: LEVELS - 1 }, mkRT);

  const mat = (frag, uniforms) => new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: VERT,
    fragmentShader: frag,
    uniforms,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });

  // Grade: near identity. Every module's radiance is calibrated against plain ACES fitted at
  // exposure 1 (tonemap.js); modules fix their own levels, post does not chase content.
  const P = {
    exposure: 1.0,
    bloomThreshold: 3.0, // luminance (HDR); sunlit foam ~3, sun-side sky 2.5-4
    bloomKnee: 1.0,
    bloom: 0.03,
    ca: 0.0008,
    vignette: 0.03, // analysis: no vignetting detectable (<3%)
    sharpRadius: 1.0, // in reference-video pixels
    // phone ISP / codec detail response (pass B, sRGB): fitted on full renders vs the clip at
    // t = 0.5 and 9 (spectra of 7 regions, detail percentiles, chroma HP, edge profiles).
    // Spectral error (log10 power, 0.08-0.5 cyc/px) 0.081 raw -> 0.054; chroma HP 1.2 -> 0.31
    // (clip 0.30); no overshoot on isolated edges (clip: none).
    ispSigma: 2.6, // mid-band gaussian (reference px)
    nyq: 0.72, // Nyquist band gain (demosaic / codec softness; 0.65 before the temporal filter)
    core: 2.5 / 255, // Nyquist band coring (noise-like wiggles below ~2.5 levels flattened)
    midK: 1.1, // texture-only mid-band boost, peaks at ~0.7 midC ...
    midC: 6.5 / 255, // ... and fades out on edges beyond ~2 midC (no halos)
    chromaSoft: 1.0,
    chromaCore: 8 / 255,
    grain: 0.006, // (x ~1.3: the temporal filter below averages part of it away, as in the phone)
    // phone temporal noise reduction (MCTF): history weight at 30 fps and the motion-rejection
    // threshold (reviewer temporal.py: frame-to-frame |dY| per unit of detail 1.3-1.8x the clip)
    hist30: 0.6,
    seaV: 0.35, // vertical Nyquist damping on the water (0..1)
    histK: 6.5 / 255,
    // post-glance sky local tone mapping (cloud contrast -15..-25 %, shadows +5..8 levels at t 9)
    skyComp: [0.4, 0],
    capKnee: 0.95,
    capWhite: 1.0,
    slope: [1.0, 1.0, 1.0],
    offset: [0.0, 0.0, 0.0],
    power: [1.0, 1.0, 1.0],
    saturation: 0.97, // CG content runs ~15 % more saturated than the clip (grass, sea); keep mild
    landDesat: 0.06, // extra, below the horizon band only (r4 region audit, 4 times)
    shadowTint: [1.0, 1.0, 1.0],
    highTint: [1.0, 1.004, 0.996], // nudges foam toward the reference's green-white, not warm
    // phone ISP drift after each glance to the sea (see composite): sea / band lift at the peak
    // (sRGB units) and foreground darkening (fraction); envelopes are pure functions of t
    ispUp: 0.075,
    ispDn: 0.12,
    ispSky: [0.04, 0.05],
    horizonDipDeg: 0.2, // where the rendered sea horizon sits (geometric dip 0.19 at 35 m; checked on renders to ~1 px)
    horizonSoft: 2.5, // band sigma in reference px
    farSoft: 0.8, // far-field (near-horizon) softening, see composite
    // veiling glare (display-linear add). Off: the clip's lighter darkest 1-5 % (p5 55 vs 44) are
    // all in the tree crowns (trees p5 42 vs 22 at t 0.5 and 9); sea, hills and grass match or are
    // darker in the clip, so a global lift is not justified (r3 look audit).
    veil: [0, 0, 0],
  };
  const _hA = new THREE.Vector3(), _hB = new THREE.Vector3();
  // horizon line in output pixels (gl_FragCoord space) from the current camera
  function horizonLine(camera, outW, outH, u) {
    const dip = P.horizonDipDeg * Math.PI / 180;
    const yaw = camera.rotation.y;
    const pt = (v, az) => v.set(-Math.sin(yaw + az) * Math.cos(dip), -Math.sin(dip), -Math.cos(yaw + az) * Math.cos(dip))
      .multiplyScalar(5000).add(camera.position).project(camera);
    pt(_hA, 0.35); pt(_hB, -0.35);
    if (_hA.z > 1 || _hB.z > 1) { u.set(0, 0, 1e6); return; }
    const ax = (_hA.x * 0.5 + 0.5) * outW, ay = (_hA.y * 0.5 + 0.5) * outH;
    const bx = (_hB.x * 0.5 + 0.5) * outW, by = (_hB.y * 0.5 + 0.5) * outH;
    let nx = -(by - ay), ny = bx - ax;
    const l = Math.hypot(nx, ny) || 1;
    nx /= l; ny /= l;
    u.set(nx, ny, -(nx * ax + ny * ay));
  }

  const prefilterMat = mat(PREFILTER, {
    tSrc: { value: target.texture },
    uTexel: { value: new THREE.Vector2() },
    uThreshold: { value: P.bloomThreshold },
    uKnee: { value: P.bloomKnee },
  });
  const downMat = mat(DOWN, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } });
  const upMat = mat(UP, {
    tSrc: { value: null },
    tBase: { value: null },
    uTexel: { value: new THREE.Vector2() },
    uBaseWeight: { value: 1.0 },
  });

  const noSharp = flags.has('nosharp');
  const compositeMat = mat(COMPOSITE, {
    tScene: { value: target.texture },
    tBloom: { value: null },
    uTexel: { value: new THREE.Vector2() },
    uRes: { value: new THREE.Vector2(1, 1) },
    uAspect: { value: 16 / 9 },
    uTime: ctx.uniforms.uTime,
    uExposure: { value: P.exposure },
    uBloom: { value: flags.has('nobloom') ? 0 : P.bloom },
    uCA: { value: P.ca },
    uVignette: { value: P.vignette },
    uSharpRadius: { value: 1 },
    uRaw: { value: RAW ? 1 : 0 },
    uBlurVec: { value: new THREE.Vector2() },
    uBlurAmt: { value: 0 },
    uHzn: { value: new THREE.Vector3(0, 0, 1e6) },
    uHznW: { value: 1 },
    uHznSigma: { value: P.horizonSoft },
    uFarSoft: { value: noSharp ? 0 : P.farSoft },
    uLowCost: { value: 0 },
    uVeil: { value: new THREE.Vector3(...P.veil) },
  });
  // display image (output res) and its half-res mid-band blur
  const ldrRT = mkRT();
  const blurRT = [mkRT(), mkRT()];
  const blurMat = mat(BLUR, { tSrc: { value: null }, uStep: { value: new THREE.Vector2() } });
  const ispMat = mat(ISP, {
    tLdr: { value: ldrRT.texture },
    tBlur: { value: blurRT[1].texture },
    uOutTexel: { value: new THREE.Vector2(1, 1) },
    uRes: compositeMat.uniforms.uRes,
    uTime: ctx.uniforms.uTime,
    uRaw: compositeMat.uniforms.uRaw,
    uSharpRadius: { value: 1 },
    uCamH: { value: CAM_H },
    uNyq: { value: noSharp ? 1 : P.nyq },
    uCore: { value: noSharp ? 1e-5 : P.core },
    uMidK: { value: noSharp ? 0 : P.midK },
    uMidC: { value: P.midC },
    uChromaSoft: { value: noSharp ? 0 : P.chromaSoft },
    uChromaCore: { value: P.chromaCore },
    uLandDesat: { value: P.landDesat },
    uGrain: { value: flags.has('nograin') ? 0 : P.grain },
    uCapKnee: { value: P.capKnee },
    uCapWhite: { value: P.capWhite },
    uSlope: { value: new THREE.Vector3(...P.slope) },
    uOffset: { value: new THREE.Vector3(...P.offset) },
    uPower: { value: new THREE.Vector3(...P.power) },
    uSaturation: { value: P.saturation },
    uShadowTint: { value: new THREE.Vector3(...P.shadowTint) },
    uHighTint: { value: new THREE.Vector3(...P.highTint) },
    uIspUp: { value: 0 },
    uIspDn: { value: 0 },
    uIspSky: { value: new THREE.Vector2() },
    uHzn: compositeMat.uniforms.uHzn,
    uHznW: compositeMat.uniforms.uHznW,
    uSkyComp: { value: new THREE.Vector2() },
    uSkyMeanStep: { value: new THREE.Vector2() },
    uPanVec: { value: new THREE.Vector2() },
    uPanK: { value: 0 },
    uSeaV: { value: noSharp ? 0 : P.seaV },
    tHist: { value: null },
    uReproj: { value: new THREE.Matrix3() },
    uProj: { value: new THREE.Vector2(1, 1) },
    uHistW: { value: 0 },
    uHistK: { value: P.histK },
  });
  // MCTF history: ping-pong output-res half-float targets (ISP output before dither)
  const histRT = [mkRT(), mkRT()];
  let histCur = 0, histValid = false, lastT = NaN;
  const _qPrev = new THREE.Quaternion(), _qCur = new THREE.Quaternion(), _qRel = new THREE.Quaternion();
  const _m4 = new THREE.Matrix4(), _pv = new THREE.Vector3(), _sv = new THREE.Vector3();
  const outMat = mat(OUT, { tSrc: { value: null }, uRaw: compositeMat.uniforms.uRaw });

  const quad = new THREE.Mesh(
    new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3)),
    compositeMat,
  );
  quad.frustumCulled = false;
  const postScene = new THREE.Scene();
  postScene.add(quad);
  const postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  let W = 1, H = 1;
  let lastKey = '';
  let lastOutKey = '';
  const blurStep = [0, 0];
  // fullscreen passes: the triangle covers every pixel, so no clear is needed
  const blit = (material, rt) => {
    quad.material = material;
    renderer.setRenderTarget(rt);
    renderer.render(postScene, postCam);
  };

  function setSize(w, h, dpr) {
    const s = quality.scale || 1;
    const nW = Math.max(1, Math.round(w * dpr * s));
    const nH = Math.max(1, Math.round(h * dpr * s));
    const cu = compositeMat.uniforms;
    cu.uRes.value.set(w * dpr, h * dpr);
    cu.uAspect.value = w / h;
    cu.uLowCost.value = s < 0.75 ? 1 : 0;
    const oW = Math.max(1, Math.round(w * dpr)), oH = Math.max(1, Math.round(h * dpr));
    const oKey = oW + 'x' + oH;
    if (oKey !== lastOutKey) {
      lastOutKey = oKey;
      ldrRT.setSize(oW, oH);
      histRT[0].setSize(oW, oH); histRT[1].setSize(oW, oH);
      histValid = false;
      const hW = Math.max(1, Math.round(oW / 2)), hH = Math.max(1, Math.round(oH / 2));
      blurRT[0].setSize(hW, hH); blurRT[1].setSize(hW, hH);
      const iu = ispMat.uniforms;
      iu.uOutTexel.value.set(1 / oW, 1 / oH);
      iu.uSharpRadius.value = Math.max(1, oH / CAM_H) * P.sharpRadius;
      // blur taps at 0.5 sigma (sigma in reference px -> uv)
      const sig = P.ispSigma * oH / CAM_H;
      blurStep[0] = (0.5 * sig) / oW; blurStep[1] = (0.5 * sig) / oH;
      const ms = 24 * oH / CAM_H;
      iu.uSkyMeanStep.value.set(ms / oW, ms / oH);
    }
    const key = nW + 'x' + nH;
    if (key === lastKey) return; // avoid reallocating every target when nothing changed
    lastKey = key;
    W = nW; H = nH;
    target.setSize(W, H);
    let bw = Math.max(1, Math.round(W / START_DIV)), bh = Math.max(1, Math.round(H / START_DIV));
    for (let i = 0; i < LEVELS; i++) {
      down[i].setSize(bw, bh);
      if (i < LEVELS - 1) up[i].setSize(bw, bh);
      bw = Math.max(1, bw >> 1); bh = Math.max(1, bh >> 1);
    }
    cu.uTexel.value.set(1 / W, 1 / H);
    // detail radius: one camera pixel (CAM_H px tall frame) in scene texels
    cu.uSharpRadius.value = Math.max(1, H / CAM_H) * P.sharpRadius;
  }

  function renderBloom() {
    // prefilter: scene -> down[0] (1/2 res): 4 bilinear taps at +-1 texel = the 2x2 footprint
    prefilterMat.uniforms.uTexel.value.set(1 / W, 1 / H);
    blit(prefilterMat, down[0]);
    for (let i = 1; i < LEVELS; i++) {
      const src = down[i - 1];
      downMat.uniforms.tSrc.value = src.texture;
      downMat.uniforms.uTexel.value.set(1 / src.width, 1 / src.height);
      blit(downMat, down[i]);
    }
    // up chain: up[i] = upsample(up[i+1]) + b_i * down[i]  ->  up[0] = sum_i b_i * down[i] with
    // the coarsest level at b = 1, so b_i = w_i / w_coarsest and the result is scaled back by
    // w_coarsest (bloomNorm) in the composite.
    let coarse = down[LEVELS - 1];
    for (let i = LEVELS - 2; i >= 0; i--) {
      upMat.uniforms.tSrc.value = coarse.texture;
      upMat.uniforms.tBase.value = down[i].texture;
      upMat.uniforms.uTexel.value.set(1 / coarse.width, 1 / coarse.height);
      upMat.uniforms.uBaseWeight.value = LEVEL_W[i] / LEVEL_W[LEVELS - 1];
      blit(upMat, up[i]);
      coarse = up[i];
    }
    compositeMat.uniforms.tBloom.value = up[0].texture;
  }
  const bloomNorm = LEVEL_W[LEVELS - 1];

  return {
    target,
    params: P,
    uniforms: compositeMat.uniforms,
    ispUniforms: ispMat.uniforms,
    sceneInfo,
    frameInfo,
    setSize,
    render(scene, camera) {
      // camera-rotation motion blur from the handheld rig's angular velocity (pure function of t)
      const av = camera.userData.angVel;
      const cu = compositeMat.uniforms;
      let panK = 0;
      if (av) {
        const fpx = H / (2 * Math.tan((camera.fov * Math.PI) / 360)); // focal length in scene px
        // short daylight shutter: in the clip the trees / rock platform keep 80-90 % of their
        // horizontal gradient energy during the glance (t 4 vs 0.5); only low-contrast texture
        // (hills 49 %, sea 61 %) is lost, to the codec (see the ISP pan smear)
        const shutter = 1 / 120;
        // image motion: yaw left (+) moves content right (+x); pitch up (+) moves content down
        const vx = fpx * av.yaw * Math.cos(camera.rotation.x) * shutter;
        const vy = -fpx * av.pitch * shutter;
        const px = Math.hypot(vx, vy);
        const x = Math.min(1, Math.max(0, (px - 0.2) / 0.3));
        cu.uBlurAmt.value = x * x * (3 - 2 * x);
        cu.uBlurVec.value.set(vx / W, vy / H);
        // codec starvation during fast pans: the clip's sea / rock detail (median |Y - gauss 1px|)
        // drops ~20-35 % while the image moves 1.3-2.6 ref px per frame (t 3.5-5.5, 6.5-8.5 s),
        // more than the 1 px shutter blur explains: bits go to motion, texture is quantised away
        const pf = (px / (shutter * 30)) * (CAM_H / H); // camera px per frame
        const k = Math.min(1, Math.max(0, (pf - 0.6) / 1.4));
        panK = k * k * (3 - 2 * k);
        // codec smear line: along the image motion, +-3 reference px at full pan strength
        const oH = cu.uRes.value.y, oW = cu.uRes.value.x;
        const L = 3 * (oH / CAM_H) / Math.max(px, 1e-6);
        ispMat.uniforms.uPanVec.value.set((vx * L) / oW, (vy * L) / oH);
      } else cu.uBlurAmt.value = 0;
      ispMat.uniforms.uPanK.value = noSharp || RAW ? 0 : panK;
      // codec + ISP rhythm, both pure functions of t:
      //  - 4-frame GOP: every 4th frame (the I-frame) is slightly crisper (camera.md: 7.5 Hz line)
      //  - local tone mapping follows the glance to the sea with a ~1.2 s lag
      const tt = ctx.uniforms.uTime.value;
      const fi = Math.round(tt * 30);
      const iu = ispMat.uniforms;
      if (!noSharp) {
        iu.uMidK.value = P.midK * ((((fi % 4) + 4) % 4) === 0 ? 1.06 : 0.98) * (1 - 0.6 * panK);
        iu.uNyq.value = P.nyq * (1 - 0.35 * panK);
        iu.uCore.value = P.core * (1 + 1.5 * panK);
      }
      const isp = ispEnvelope(tt);
      iu.uIspUp.value = RAW ? 0 : P.ispUp * isp[0];
      iu.uIspDn.value = RAW ? 0 : P.ispDn * isp[1];
      iu.uIspSky.value.set(P.ispSky[0] * isp[2], P.ispSky[1] * isp[1]).multiplyScalar(RAW ? 0 : 1);
      iu.uSkyComp.value.set(P.skyComp[0] * isp[2], P.skyComp[1] * isp[2]).multiplyScalar(RAW ? 0 : 1);
      const ri = renderer.info.render;
      if (ri.calls < infoEnd.calls) for (const k of INFO_KEYS) infoEnd[k] = 0; // reset externally
      for (const k of INFO_KEYS) infoPre[k] = ri[k];
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
      for (const k of INFO_KEYS) sceneInfo[k] = ri[k] - infoPre[k];
      const outW = cu.uRes.value.x, outH = cu.uRes.value.y;
      if (RAW) cu.uHzn.value.set(0, 0, 1e6);
      else horizonLine(camera, outW, outH, cu.uHzn.value);
      cu.uHznW.value = outH / CAM_H;
      const ac = renderer.autoClear;
      renderer.autoClear = false;
      if (!RAW) renderBloom();
      else cu.tBloom.value = target.texture;
      cu.uBloom.value = RAW || flags.has('nobloom') ? 0 : P.bloom * bloomNorm;
      // pass A: HDR -> display sRGB; mid-band blur (half res, H then V); pass B: ISP -> screen
      blit(compositeMat, ldrRT);
      if (!RAW) {
        blurMat.uniforms.tSrc.value = ldrRT.texture;
        blurMat.uniforms.uStep.value.set(blurStep[0], 0);
        blit(blurMat, blurRT[0]);
        blurMat.uniforms.tSrc.value = blurRT[0].texture;
        blurMat.uniforms.uStep.value.set(0, blurStep[1]);
        blit(blurMat, blurRT[1]);
      }
      // MCTF: camera rotation since the previous frame (camera-space reprojection); history reset
      // on the first frame, after a resize, a time jump (seek / capture) or a paused tab
      camera.matrixWorld.decompose(_pv, _qCur, _sv);
      const dtH = tt - lastT;
      const okH = histValid && dtH > 1e-4 && dtH < 0.1 && !RAW && tier !== 'low'; // (low tier: no MCTF taps)
      _qRel.copy(_qPrev).invert().multiply(_qCur);
      iu.uReproj.value.setFromMatrix4(_m4.makeRotationFromQuaternion(_qRel));
      iu.uProj.value.set(camera.projectionMatrix.elements[0], camera.projectionMatrix.elements[5]);
      iu.uHistW.value = okH ? Math.pow(P.hist30, 30 * dtH) : 0;
      iu.tHist.value = histRT[histCur].texture;
      const dst = histRT[1 - histCur];
      blit(ispMat, dst);
      outMat.uniforms.tSrc.value = dst.texture;
      blit(outMat, null);
      histCur = 1 - histCur; histValid = true; lastT = tt; _qPrev.copy(_qCur);
      renderer.autoClear = ac;
      for (const k of INFO_KEYS) { frameInfo[k] = ri[k] - infoEnd[k]; infoEnd[k] = ri[k]; }
    },
    dispose() {
      target.dispose();
      for (const rt of [...down, ...up, ldrRT, ...blurRT, ...histRT]) rt.dispose();
      for (const m of [prefilterMat, downMat, upMat, compositeMat, blurMat, ispMat, outMat]) m.dispose();
    },
  };
}
