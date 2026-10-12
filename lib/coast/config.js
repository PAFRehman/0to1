// Global art-direction constants shared by every module.
// World units are metres. +X = right (west), +Y = up, -Z = camera forward (south along Main Beach).
// Sea level is y = 0. Colours are sRGB hex unless stated otherwise.

const deg = Math.PI / 180;

function dirFromAngles(azimuthDeg, elevationDeg) {
  // azimuth 0 = -Z (camera forward), 90 = +X (right), 180 = +Z (behind the camera)
  const az = azimuthDeg * deg;
  const el = elevationDeg * deg;
  return [Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)];
}

export const CONFIG = {
  camera: {
    position: [0, 35, 0], // eye position (ground below is ~33.4 m)
    yawDeg: 0,
    pitchDeg: -12.36, // visible (earth-curved, 0.19 deg dip) horizon at image row ~148 of 718
    rollDeg: 0.2,
    // Reference framing is the 1276x718 phone video: hFOV 66 deg <=> vFOV 40.15 deg.
    vfovDeg: 40.15,
    near: 0.5,
    far: 60000,
  },

  sun: {
    // Low golden-hour sun off-frame to the right, slightly in front of the camera, behind the dune
    // line (analysis/sky_light.md: lit cloud flanks face right, camera-facing platform face and the
    // beach are in shade, shadows ~8x object height).
    azimuthDeg: 60,
    elevationDeg: 7,
    get direction() { return dirFromAngles(this.azimuthDeg, this.elevationDeg); },
    color: '#ffe5bf', // sRGB tint of direct light (lin 1.00, 0.78, 0.52)
    // Linear multiplier used by custom shaders (radiance = albedo * uSunColor * NdotL). The sky
    // module sets the DirectionalLight to PI * this (= 6.6, three.js irradiance units) so built-in
    // PBR materials agree; with the sky PMREM at environmentIntensity 1 this gives the measured
    // E_sun : E_sky(horizontal) of about 2.5 : 1.
    intensity: 2.1,
  },

  sky: {
    zenith: '#a4d0e4',
    horizon: '#e9e6d2',
  },

  // Aerial perspective / haze (see core/atmosphere.js; analysis/sky_light.md section 4)
  haze: {
    color: '#c6d3d8', // (legacy) near-haze tint; the airlight now comes from the horizon sky
    sunColor: '#3a2c1e', // extra forward-scatter glow toward the sun (sRGB, additive, subtle)
    density: 0.000018, // background marine haze extinction per metre at sea level (G channel)
    heightFalloff: 0.001, // per metre (1 km scale height)
    chroma: [0.84, 1.0, 1.32], // extinction ratio R,G,B (beta = 0.021, 0.025, 0.033 per km)
    spray: [0.00009, 0.0001, 0.00013], // spray veil over surf/beach: extra beta per metre (RGB)
    sprayRange: 1000, // ... applied to the first 1 km of the path
    sprayTop: 40, // ... below this height (m)
  },

  wind: {
    // Strong onshore wind: blowing from the sea (left, east/south-east) toward the land (+X).
    direction: [0.94, 0.34], // xz, normalised in wind.js (direction the wind blows TOWARD): from the ESE sea toward the land, slightly toward the camera
    speed: 12, // m/s mean (~25 kn)
    gustiness: 0.45,
  },

  ocean: {
    // wind sea (FFT): JONSWAP, measured from the reference (analysis/ocean.md)
    waveDir: [0.94, 0.34], // xz direction the waves travel toward (from the ESE, front-left)
    windSpeed: 14, // U10 m/s for the spectrum
    fetch: 100000, // m
    spread: 3, // cos^2s spreading (short-crested wind sea)
    cascades: [257, 43.7, 7.9], // tile sizes (m)
    choppiness: 1.3,
    fftAmp: 0.75,
    surfAmp: 1.0,
    whitecapJ: 0.86, // Jacobian (cascades 0+1) below which the chop breaks
    breakerJ: 0.83, // Jacobian of the long waves (cascade 0) below which a near-field crest spills
    slopeGain: 1.05, // shading-only normal exaggeration (sub-pixel roughness contrast)
    // body colours (sRGB hex, multiplied by bodyGain in linear)
    deep: '#184561',
    mid: '#579ca2',
    shallow: '#5896a0',
    crest: '#46b89c',
    milky: '#95b3c4',
    aerated: '#95bcc8',
    bodyGain: 1.0,
    foamSky: '#93c9ff',
    foamSkyGain: 1.1,
    foam: '#f4f6f2',
    reflScale: 0.36,
    fresnelMax: 0.4,
  },
};

export const DEG = deg;
export { dirFromAngles };
