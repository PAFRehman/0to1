// The display transform every module is calibrated against, plus its exact inverse.
//
// CONTRACT: materials output linear HDR radiance; post maps it to the screen with
//   display = ACESFitted(radiance * exposure), exposure = 1, then the sRGB OETF.
// The grade applied after it is (near) identity, so to make a surface appear at a measured sRGB
// value from the reference, emit invACES(srgbToLinear(target)). Grey response for orientation:
//   HDR 0.05 -> 31, 0.1 -> 58, 0.18 -> 91, 0.3 -> 127, 0.5 -> 165, 0.8 -> 195, 1.0 -> 206,
//   1.5 -> 223, 2 -> 232, 3 -> 240, 4 -> 245, 6 -> 249 (sRGB 8-bit)
// e.g. sunlit foam (241,239,217) needs (3.03, 2.80, 1.04), shaded foam (200,215,215) needs
// (0.83, 1.22, 1.23), deep sea (87,118,136) needs (0.16, 0.27, 0.35) — see invAcesSRGB8() below.
//
// GLSL: `ACES_GLSL` defines ACESFitted(vec3), invACESFitted(vec3), srgbToLinear(vec3),
// linearToSRGB(vec3). The inverse is closed-form (the RRT/ODT fit is a per-channel rational
// function solved as a quadratic, the two matrices are inverted exactly).

export const ACES_GLSL = /* glsl */ `
const mat3 ACES_IN = mat3(0.59719,0.07600,0.02840, 0.35458,0.90834,0.13383, 0.04823,0.01566,0.83777);
const mat3 ACES_OUT = mat3(1.60475,-0.10208,-0.00327, -0.53108,1.10813,-0.07276, -0.07367,-0.00605,1.07602);
vec3 RRTAndODTFit(vec3 v){ vec3 a = v*(v+0.0245786)-0.000090537; vec3 b = v*(0.983729*v+0.4329510)+0.238081; return a/b; }
vec3 ACESFitted(vec3 c){ return clamp(ACES_OUT * RRTAndODTFit(ACES_IN * c), 0.0, 1.0); }
// inverse of the rational fit: (y*0.983729-1) v^2 + (y*0.432951-0.0245786) v + (y*0.238081+0.000090537) = 0
vec3 invRRTAndODTFit(vec3 y){
  y = clamp(y, 0.0, 0.9999);
  vec3 A = y * 0.983729 - 1.0, B = y * 0.4329510 - 0.0245786, C = y * 0.238081 + 0.000090537;
  return (-B - sqrt(max(B * B - 4.0 * A * C, 0.0))) / (2.0 * A);
}
vec3 invACESFitted(vec3 d){ return max(inverse(ACES_IN) * invRRTAndODTFit(inverse(ACES_OUT) * clamp(d, 0.0, 0.999)), 0.0); }
vec3 srgbToLinear(vec3 c){ return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
vec3 linearToSRGB(vec3 c){ c = max(c, vec3(0.0)); return mix(c*12.92, 1.055*pow(c, vec3(1.0/2.4))-0.055, step(0.0031308, c)); }
`;

const IN = [[0.59719, 0.35458, 0.04823], [0.07600, 0.90834, 0.01566], [0.02840, 0.13383, 0.83777]];
const OUT = [[1.60475, -0.53108, -0.07367], [-0.10208, 1.10813, -0.00605], [-0.00327, -0.07276, 1.07602]];
const mul = (m, v) => [0, 1, 2].map((i) => m[i][0] * v[0] + m[i][1] * v[1] + m[i][2] * v[2]);
function inv3(m) {
  const [a, b, c] = m[0], [d, e, f] = m[1], [g, h, i] = m[2];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [
    [A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
    [C / det, -(a * h - b * g) / det, (a * e - b * d) / det],
  ];
}
const IN_INV = inv3(IN), OUT_INV = inv3(OUT);
const fit = (v) => (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.432951) + 0.238081);
const invFit = (y) => {
  y = Math.min(0.9999, Math.max(0, y));
  const A = y * 0.983729 - 1, B = y * 0.432951 - 0.0245786, C = y * 0.238081 + 0.000090537;
  return (-B - Math.sqrt(Math.max(0, B * B - 4 * A * C))) / (2 * A);
};
const clamp01 = (x) => Math.min(1, Math.max(0, x));

/** linear HDR [r,g,b] -> display-linear [0..1] */
export function acesFitted(rgb) { return mul(OUT, mul(IN, rgb).map(fit)).map(clamp01); }
/** display-linear [0..1] -> linear HDR radiance */
export function invAcesFitted(d) {
  return mul(IN_INV, mul(OUT_INV, d.map((x) => Math.min(0.999, clamp01(x)))).map(invFit)).map((x) => Math.max(0, x));
}
export const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
export const linearToSRGB = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
/** measured sRGB 8-bit colour from the reference -> HDR radiance a material must output */
export function invAcesSRGB8(r, g, b) { return invAcesFitted([r, g, b].map((x) => srgbToLinear(x / 255))); }
/** HDR radiance -> sRGB 8-bit as shown on screen (before grain) */
export function displaySRGB8(rgb) { return acesFitted(rgb).map((x) => Math.round(linearToSRGB(x) * 255)); }
