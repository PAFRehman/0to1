// Handheld phone-camera motion: a pure, seamless function of time (period 180 s).
//
// Measured from the reference clip (analysis/camera.md: pure-rotation + focal fit of all 411
// frames against frame 0 on static land features). Findings reproduced here:
//   - electronically stabilised phone: no tremor, no FOV change, eased "floaty" motion
//   - 0-2.9 s slow drift, 2.9-9.5 s deliberate ~9.6 deg glance LEFT to the sea and back,
//     roll banking with yaw rate, pitch creeping up ~1.3 deg, slow return by 13.8 s
//
// Structure of one 180 s loop (u = t mod 180):
//   u in [0, 13]      exact replay of the measured track (Catmull-Rom through 0.25 s samples),
//                     so renders at t in [0, 13.75] line up with the reference frames
//   u in [13, 17.5]   cross-fade into the procedural rig
//   u in [17.5, 174]  procedural rig: slow drifts (every frequency k/180 Hz, so the loop is
//                     exact), faint sway and three different glances at the sea (u ~ 52, 101,
//                     146 s) varying in amplitude, speed and pitch, so the move never looks canned
//   u in [174, 180]   cross-fade back into the start of the measured track (C1-continuous)
// Deltas are applied on top of the calibrated base pose in config.camera (= frame 0).
// Tiny positional sway (+-3 cm) gives the 1-3 px foreground parallax measured on the grass.
// Optional pointer parallax (<0.3 deg) outside capture mode.
import { CONFIG, DEG } from '../config.js';

const DT = 0.25;
// deltas relative to frame 0, degrees (analysis/camera_track_0.25s.csv)
const YAW = [0.000, -0.037, -0.086, -0.150, -0.228, -0.302, -0.354, -0.391, -0.412, -0.404, -0.359, -0.257, -0.015, 0.401, 0.898, 1.513, 2.320, 3.199, 4.018, 4.893, 5.968, 7.096, 8.069, 8.890, 9.489, 9.609, 9.310, 8.671, 7.668, 6.576, 5.670, 4.835, 4.041, 3.415, 2.990, 2.659, 2.381, 2.191, 2.073, 2.000, 1.960, 1.944, 1.933, 1.907, 1.848, 1.756, 1.630, 1.472, 1.256, 1.020, 0.807, 0.621, 0.449, 0.323, 0.256, 0.240];
const PITCH = [0.000, 0.034, 0.084, 0.135, 0.213, 0.294, 0.353, 0.415, 0.479, 0.552, 0.629, 0.706, 0.793, 0.883, 0.955, 1.016, 1.080, 1.135, 1.175, 1.202, 1.206, 1.184, 1.185, 1.187, 1.208, 1.209, 1.190, 1.188, 1.194, 1.214, 1.230, 1.254, 1.309, 1.372, 1.436, 1.505, 1.586, 1.653, 1.696, 1.727, 1.740, 1.750, 1.755, 1.760, 1.773, 1.781, 1.774, 1.760, 1.735, 1.695, 1.656, 1.593, 1.511, 1.416, 1.329, 1.293];
const ROLL = [0.000, 0.025, 0.034, 0.059, 0.060, 0.053, 0.057, 0.076, 0.104, 0.123, 0.127, 0.155, 0.194, 0.228, 0.276, 0.344, 0.393, 0.407, 0.429, 0.450, 0.469, 0.500, 0.443, 0.369, 0.204, 0.111, 0.100, 0.108, 0.192, 0.284, 0.398, 0.528, 0.639, 0.761, 0.838, 0.896, 0.925, 0.933, 0.929, 0.894, 0.879, 0.849, 0.827, 0.820, 0.822, 0.838, 0.875, 0.905, 0.912, 0.919, 0.886, 0.876, 0.846, 0.820, 0.799, 0.790];
const N = YAW.length;
const T_END = (N - 1) * DT; // 13.75 s
const LOOP = 180;
// absolute frame-0 pose measured in the clip (the procedural rig below is written in absolute
// measured angles; converting with these keeps it consistent with the replayed deltas)
const PITCH0 = -12.27, ROLL0 = 0.08;
const TAU = 1.2; // s, damping of the track's velocity extrapolation beyond its ends

function catmull(a, u) {
  const x = u / DT;
  const i = Math.min(N - 2, Math.max(0, Math.floor(x)));
  const f = x - i;
  const p0 = a[Math.max(0, i - 1)], p1 = a[i], p2 = a[i + 1], p3 = a[Math.min(N - 1, i + 2)];
  const f2 = f * f, f3 = f2 * f;
  return 0.5 * (2 * p1 + (-p0 + p2) * f + (2 * p0 - 5 * p1 + 4 * p2 - p3) * f2 + (-p0 + 3 * p1 - 3 * p2 + p3) * f3);
}

// measured track, extended smoothly beyond both ends (damped linear extrapolation)
function track(a, u) {
  if (u <= 0) {
    const v0 = (a[1] - a[0]) / DT;
    return a[0] - v0 * TAU * (1 - Math.exp(u / TAU));
  }
  if (u >= T_END) {
    const v1 = (a[N - 1] - a[N - 2]) / DT;
    return a[N - 1] + v1 * TAU * (1 - Math.exp(-(u - T_END) / TAU));
  }
  return catmull(a, u);
}

const TWO_PI = Math.PI * 2;
const Wk = (k) => (TWO_PI * k) / LOOP;
const smooth = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };

// asymmetric-Gaussian glance to the sea (analysis fit of the measured one), centred on c:
// amp = peak yaw (deg), sl/sr = rise/fall widths (s), plus the slow partial return lobe
function glance(u, c, amp, sl, sr) {
  const d = u - c;
  const s = d < 0 ? sl : sr;
  const k = amp / 9.3;
  return amp * Math.exp(-0.5 * (d / s) ** 2) + 2.35 * k * Math.exp(-0.5 * ((d - 3.2 * sr) / (1.75 * sr)) ** 2);
}
// the three glances of one loop: [centre, amplitude, rise, fall, pitch lift]
export const GLANCES = [
  [52.0, 9.3, 1.30, 1.20, 0.10],
  [101.5, 5.4, 1.85, 1.65, -0.25],
  [146.0, 7.4, 1.10, 1.45, 0.35],
];
function glances(u) {
  let y = 0, p = 0;
  for (const [c, a, sl, sr, pl] of GLANCES) {
    y += glance(u, c, a, sl, sr);
    p += pl * Math.exp(-0.5 * ((u - c - 0.8) / 2.2) ** 2);
  }
  return [y, p];
}

// procedural rig (analysis/camera.md "recommended procedural rig"), absolute degrees
function rig(u, out) {
  const [g, gp] = glances(u);
  const gv = (glances(u + 0.01)[0] - glances(u - 0.01)[0]) / 0.02;
  out.yaw = 0.70 * Math.sin(Wk(9) * u) + 0.35 * Math.sin(Wk(21) * u) + 0.22 * Math.sin(Wk(4) * u + 1.3)
    + 0.05 * Math.sin(Wk(111) * u + 0.9) + 0.025 * Math.sin(Wk(213) * u + 4.2) + g;
  out.pitch = -11.4 + 0.62 * Math.sin(Wk(6) * u + 4.71) + 0.24 * Math.sin(Wk(27) * u + 4.71)
    + 0.15 * Math.sin(Wk(11) * u + 2.0)
    + 0.012 * Math.sin(Wk(123) * u + 0.4) + 0.006 * Math.sin(Wk(249) * u + 1.3) + gp;
  out.roll = 0.5 + 0.33 * Math.sin(Wk(6) * u + 4.71) + 0.14 * Math.sin(Wk(24) * u + 4.2)
    + 0.08 * Math.sin(Wk(5) * u + 0.7)
    + 0.02 * Math.sin(Wk(141) * u + 5) + 0.04 * gv;
  return out;
}

// pose deltas (degrees) relative to the calibrated base pose — a pure function of t
export function poseAt(t, out = {}) {
  let u = t % LOOP;
  if (u < 0) u += LOOP;
  // weight of the measured track: 1 on [0,13], fades out by 17.5, fades back in over [174,180]
  const w = u < 30 ? 1 - smooth(13.0, 17.5, u) : smooth(LOOP - 6, LOOP, u);
  const ut = u < 30 ? u : u - LOOP; // track time (negative on the approach to the wrap)
  const r = rig(u, {});
  const py = r.yaw, pp = r.pitch - PITCH0, pr = r.roll - ROLL0;
  out.yaw = w * track(YAW, ut) + (1 - w) * py;
  out.pitch = w * track(PITCH, ut) + (1 - w) * pp;
  out.roll = w * track(ROLL, ut) + (1 - w) * pr;
  // positional sway (metres), everywhere (k/180 Hz -> periodic)
  out.x = 0.03 * Math.sin(Wk(12) * u + 1.0);
  out.y = 0.02 * Math.sin(Wk(9) * u + 2.5);
  out.z = 0.02 * Math.sin(Wk(15) * u + 0.3);
  return out;
}

export default async function create(ctx) {
  const { camera, capture } = ctx;
  const cam = CONFIG.camera;
  const base = { x: cam.position[0], y: cam.position[1], z: cam.position[2] };
  const pose = {}, prev = {};

  // gentle pointer parallax (interactive only)
  const ptr = { x: 0, y: 0, sx: 0, sy: 0 };
  if (!capture && typeof window !== 'undefined') {
    window.addEventListener('pointermove', (e) => {
      ptr.x = (e.clientX / Math.max(1, window.innerWidth)) * 2 - 1;
      ptr.y = (e.clientY / Math.max(1, window.innerHeight)) * 2 - 1;
    }, { passive: true });
    const reset = () => { ptr.x = 0; ptr.y = 0; };
    document.documentElement.addEventListener('pointerleave', reset);
    window.addEventListener('blur', reset);
  }

  camera.userData.angVel = { yaw: 0, pitch: 0, roll: 0 }; // rad/s (post may use it for motion blur)

  return {
    poseAt,
    update(t, dt) {
      poseAt(t, pose);
      poseAt(t - 1 / 60, prev);
      let py = 0, pp = 0;
      if (!capture) {
        const k = 1 - Math.exp(-(dt || 0.016) * 1.5);
        ptr.sx += (ptr.x - ptr.sx) * k;
        ptr.sy += (ptr.y - ptr.sy) * k;
        py = -ptr.sx * 0.3;
        pp = -ptr.sy * 0.2;
      }
      camera.position.set(base.x + pose.x, base.y + pose.y, base.z + pose.z);
      camera.rotation.order = 'YXZ';
      camera.rotation.set(
        (cam.pitchDeg + pose.pitch + pp) * DEG,
        (cam.yawDeg + pose.yaw + py) * DEG,
        (cam.rollDeg + pose.roll) * DEG,
      );
      const av = camera.userData.angVel;
      av.yaw = (pose.yaw - prev.yaw) * DEG * 60;
      av.pitch = (pose.pitch - prev.pitch) * DEG * 60;
      av.roll = (pose.roll - prev.roll) * DEG * 60;
    },
  };
}
