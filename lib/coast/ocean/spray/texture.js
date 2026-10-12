// Procedural sprite atlas for the spray: 2 x 2 cells of density (R8, mip-mapped).
//   cell 0: cloudy puff (thin spray, salt haze)
//   cell 1: water curtain: fibrous vertical fall streaks with see-through gaps and a crisp, denser
//           upper rim (the sheet a surge throws up a rock face; +v is up)
//   cell 2: droplet streaks: a torn core and many short vertical droplet trails around it
//   cell 3: torn, wind-streaked wisp (stretched along u: spindrift, crest-lip veil)
// Density is remapped so the shader can "dissolve" a sprite over its life (a *= smoothstep(age, age
// + 0.25, d)): the thin parts go first, so sheets tear into holes instead of fading as solid blobs.
// Every cell falls to exactly 0 well inside its border and the shader samples only the inner 80 %
// of each cell (a gutter), so no sprite edge or mip bleed ever shows.
import { valueNoise2, hash2 } from '../../core/rng.js';

function fbm(x, y, oct, seed) {
  let s = 0, a = 0.5, n = 0;
  for (let i = 0; i < oct; i++) {
    s += a * valueNoise2(x + seed * 17.31, y - seed * 9.13);
    n += a; x = x * 2.03 + 5.1; y = y * 2.03 - 3.7; a *= 0.5;
  }
  return s / n;
}
const sm = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };

export function createSprayAtlas(THREE, cell = 128) {
  const N = cell * 2;
  const data = new Uint8Array(N * N);
  const tmp = new Float32Array(cell * cell);
  for (let c = 0; c < 4; c++) {
    const ox = (c & 1) * cell, oy = (c >> 1) * cell;
    let mx = 0;
    // droplet trails (cell 2): short vertical streaks, denser toward the middle
    const drops = [];
    if (c === 2) {
      for (let k = 0; k < 90; k++) {
        const a = hash2(k, 901) * Math.PI * 2, r = Math.sqrt(hash2(k, 902)) * 0.78;
        drops.push([Math.cos(a) * r, Math.sin(a) * r * 0.9, 0.008 + 0.018 * hash2(k, 903) ** 2, 0.05 + 0.16 * hash2(k, 905), 0.25 + 0.4 * hash2(k, 904)]);
      }
    }
    for (let y = 0; y < cell; y++) {
      for (let x = 0; x < cell; x++) {
        let u = ((x + 0.5) / cell) * 2 - 1, v = ((y + 0.5) / cell) * 2 - 1;
        if (c === 3) { u *= 0.62; v *= 1.45; } // wisp: elongated along u
        // domain warp: lumpy, never round
        const wx = fbm(u * 1.6 + 3.1, v * 1.6, 3, c + 11) - 0.5, wy = fbm(u * 1.6 - 2.3, v * 1.6 + 7.7, 3, c + 21) - 0.5;
        const uu = u + 0.55 * wx, vv = v + 0.55 * wy;
        const r = Math.sqrt(uu * uu + vv * vv);
        const base = Math.max(0, 1 - r);
        let d;
        if (c === 0) {
          const f = fbm(u * 2.4 + 1.3, v * 2.4 - 4.1, 5, c + 1);
          d = base ** 1.3 * (0.35 + 1.1 * f);
        } else if (c === 1) {
          // curtain: envelope wider than tall at the top, ragged bottom; fibres along v
          const ux = u + 0.25 * wx;
          const env = sm(1.0, 0.55, Math.abs(ux)) * sm(-0.95, -0.1, v + 0.35 * (fbm(u * 3.0, 2.0, 3, 51) - 0.5)) * sm(0.95, 0.55, v + 0.3 * wy);
          const fib = fbm(ux * 9.0 + 2.0, v * 1.3 - 1.0, 4, 61);          // vertical fibres
          const fib2 = fbm(ux * 22.0 - 4.0, v * 2.2 + 3.0, 3, 71);        // fine fibres
          const holes = sm(0.3, 0.62, fbm(u * 3.2 + 7.0, v * 2.4, 4, 81) + 0.25 * (v + 0.2)); // more gaps lower down
          const rim = Math.exp(-Math.pow((v - (0.45 + 0.25 * wy)) / 0.12, 2)) * (0.6 + 0.6 * fbm(ux * 6.0, 0.5, 3, 91));
          const body = fbm(u * 2.2 + 9.0, v * 1.4, 4, 95);
          d = env * (0.3 * sm(0.3, 0.7, body) + sm(0.32, 0.75, 0.65 * fib + 0.35 * fib2) * (0.35 + 0.65 * holes) + 0.4 * rim);
        } else if (c === 2) {
          const f = fbm(u * 3.0 + 1.3, v * 1.6 - 4.1, 5, c + 1);
          d = base ** 1.3 * sm(0.2, 0.65, f + 0.3 * base) * 1.6;
          for (const [px, py, pr, pl, pa] of drops) {
            const dx = Math.abs(u - px) / pr, dy = (v - py) / pl;
            // trail: bright head (top), fading tail below
            if (dx < 1.6 && dy > -1.2 && dy < 0.25) d += pa * sm(1.6, 0.4, dx) * sm(-1.2, -0.2, dy) * sm(0.25, 0.0, dy);
          }
        } else {
          const f = fbm(u * 2.4 + 1.3, v * 2.4 - 4.1, 5, c + 1);
          d = base ** 1.2 * sm(0.25, 0.8, f + 0.25 * base) * (0.6 + 0.5 * fbm(u * 1.2, v * 7.0, 3, 41));
        }
        // hard guarantee: zero at and near the cell border
        const rr = c === 3 ? Math.sqrt(u * u + v * v) / 0.72 : Math.max(Math.abs(u), Math.abs(v)) * 0.55 + Math.sqrt(u * u + v * v) * 0.45;
        d *= sm(0.97, 0.78, rr);
        tmp[y * cell + x] = d;
        if (d > mx) mx = d;
      }
    }
    for (let y = 0; y < cell; y++) {
      for (let x = 0; x < cell; x++) {
        data[(oy + y) * N + ox + x] = Math.round(Math.min(1, tmp[y * cell + x] / mx) * 255);
      }
    }
  }
  const tex = new THREE.DataTexture(data, N, N, THREE.RedFormat, THREE.UnsignedByteType);
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}
