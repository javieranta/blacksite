import * as THREE from 'three';

/**
 * OWNER: lighting agent.
 *
 * One analytic model of the sky-plus-ground radiance sphere, shared by
 * everything in the rig that needs to know "how much light arrives from this
 * direction":
 *
 *   - EnvironmentBuilder bakes it into an equirect HDR -> PMREM (the fallback
 *     IBL, used when Sky publishes nothing);
 *   - IrradiancePatch projects it to spherical harmonics and injects the
 *     result into every material's indirect-diffuse term.
 *
 * Why it is not just a vertical gradient
 * --------------------------------------
 * A sky that only varies with altitude gives every vertical surface in the
 * world the *same* fill, whatever direction it faces. That is what makes a dusk
 * frame paint one salmon value onto the north, south, east and west faces of
 * every building alike. Real atmospheric radiance is strongly azimuthal: Mie
 * forward scattering piles warm light into the ~60 deg around the sun's
 * bearing, and the anti-sun hemisphere stays Rayleigh-blue and much dimmer. The
 * lower the sun, the more extreme the split — which is exactly why a low sun
 * gives warm sunward faces and cold shadow-side faces without any per-object
 * work at all.
 *
 * So the model is: altitude gradient x azimuthal warm/cool split x a
 * forward-scattering aureole, over a lower hemisphere that is a *lit ground*
 * (albedo x incident irradiance, brighter on the sunward side because that is
 * where the sunlit ground is) with a single interreflection term folded in.
 *
 * Radiance is returned in the same arbitrary-but-consistent units the sky dome
 * is authored in, so `GAIN` below lines up with Sky.IBL_GAIN.
 */

/** Matches Sky.IBL_GAIN: the dome is authored for display, an IBL needs radiance. */
export const RADIANCE_GAIN = 3.2;

const _c = new THREE.Color();

export class SkyRadianceModel {
  constructor() {
    this.zenith = new THREE.Color();
    this.horizonWarm = new THREE.Color();
    this.horizonCool = new THREE.Color();
    this.sun = new THREE.Color();
    this.groundBase = new THREE.Color();
    /** Hemispherical irradiance arriving on an up-facing surface. */
    this.skyIrradiance = new THREE.Color();
    /** Radiance of the notional lit ground (the lower hemisphere's average). */
    this.groundRadiance = new THREE.Color();

    this.sx = 0; this.sy = 1; this.sz = 0;
    this.shl = 1;
    this.zl = 0.2; this.hl = 0.25;
    this.disc = 0;
    this.azGamma = 1; this.azAmp = 0.2;
    this.glow = 0.1;
    this.lowSun = 0;
    this._out = [0, 0, 0];
  }

  /**
   * @param {object} rig LightRigs entry
   * @param {THREE.Vector3} sunDir normalised, pointing towards the sun
   * @param {THREE.Color} sunColour linear-ish sun tint
   * @param {number} sunIntensity irradiance of the key light
   * @param {THREE.Color|null} skyHint zenith colour Sky published, if any
   * @param {THREE.Color|null} horizonHint horizon/fog colour Sky published
   */
  configure(rig, sunDir, sunColour, sunIntensity, skyHint, horizonHint) {
    this.zenith.setHex(rig.zenith);
    if (skyHint) this.zenith.lerp(skyHint, 0.5);
    this.horizonWarm.setHex(rig.horizon);
    if (horizonHint) this.horizonWarm.lerp(horizonHint, 0.35);
    // The anti-sun horizon is the zenith blue lightened by depth of atmosphere,
    // never the sun's tint — that is the whole point of the split.
    this.horizonCool.copy(this.zenith).lerp(_c.setHex(0x7d9ac6), 0.38);
    this.sun.copy(sunColour);

    this.sx = sunDir.x; this.sy = sunDir.y; this.sz = sunDir.z;
    this.shl = Math.max(1e-4, Math.hypot(sunDir.x, sunDir.z));

    this.zl = rig.skyLuminance;
    this.hl = rig.horizonLuminance;
    this.disc = rig.sunDiscLuminance;

    // 0 for a high sun, 1 once the sun is on the horizon.
    const lowSun = 1 - THREE.MathUtils.clamp(Math.max(this.sy, 0) / 0.34, 0, 1);
    this.lowSun = lowSun;
    this.azGamma = THREE.MathUtils.lerp(0.85, 2.7, lowSun);
    this.azAmp = THREE.MathUtils.lerp(0.20, 0.95, lowSun) * (rig.azimuthalSplit ?? 1);
    this.glow = this.disc > 0 ? 0.05 + 0.30 * lowSun : 0;

    // ---- lit-ground radiance (the lower hemisphere) -------------------------
    // Average sky radiance, then its hemispherical irradiance E = PI * Lavg.
    const wz = 0.42;
    const avgR = this.zenith.r * this.zl * wz + this.horizonMixR() * this.hl * (1 - wz);
    const avgG = this.zenith.g * this.zl * wz + this.horizonMixG() * this.hl * (1 - wz);
    const avgB = this.zenith.b * this.zl * wz + this.horizonMixB() * this.hl * (1 - wz);
    this.skyIrradiance.setRGB(Math.PI * avgR, Math.PI * avgG, Math.PI * avgB);

    const albedo = _c.setHex(rig.groundAlbedo);
    const cosSun = Math.max(this.sy, 0);
    // One interreflection: light that leaves the ground, hits a wall and comes
    // back. Cheap, and it is what stops enclosed yards reading as cut-outs.
    const bounce2 = 1 + (albedo.r + albedo.g + albedo.b) / 3 * 0.42;
    const gr = albedo.r * (this.sun.r * sunIntensity * cosSun + this.skyIrradiance.r) / Math.PI * bounce2;
    const gg = albedo.g * (this.sun.g * sunIntensity * cosSun + this.skyIrradiance.g) / Math.PI * bounce2;
    const gb = albedo.b * (this.sun.b * sunIntensity * cosSun + this.skyIrradiance.b) / Math.PI * bounce2;
    this.groundBase.setRGB(gr, gg, gb);
    this.groundRadiance.copy(this.groundBase);
    return this;
  }

  // Azimuth-averaged horizon colour, used for the coarse irradiance estimate.
  horizonMixR() { return (this.horizonWarm.r + this.horizonCool.r) * 0.5; }
  horizonMixG() { return (this.horizonWarm.g + this.horizonCool.g) * 0.5; }
  horizonMixB() { return (this.horizonWarm.b + this.horizonCool.b) * 0.5; }

  /**
   * Radiance arriving from direction (dx,dy,dz) — must be normalised. Writes
   * into and returns an internal 3-array; no allocation, so this is safe to
   * call a hundred thousand times inside a bake loop.
   * @returns {number[]} [r,g,b]
   */
  radiance(dx, dy, dz) {
    const out = this._out;
    const up = dy > 0 ? dy : 0;
    const t = Math.pow(1 - up, 5);

    // --- azimuthal warm/cool split ------------------------------------------
    const hl2 = Math.hypot(dx, dz);
    const cosAz = hl2 > 1e-5 ? (dx * this.sx + dz * this.sz) / (hl2 * this.shl) : 0;
    const sunward = 0.5 + 0.5 * cosAz;
    const w = Math.pow(sunward, this.azGamma);

    const hr = this.horizonCool.r + (this.horizonWarm.r - this.horizonCool.r) * w;
    const hg = this.horizonCool.g + (this.horizonWarm.g - this.horizonCool.g) * w;
    const hb = this.horizonCool.b + (this.horizonWarm.b - this.horizonCool.b) * w;

    // Brightness follows the same split: the sunward horizon is where the long
    // optical path is lit, the anti-sun horizon is where the earth's shadow is.
    const hlDir = this.hl * (1 - this.azAmp * 0.55 + this.azAmp * 1.1 * w);
    const lum = this.zl + (hlDir - this.zl) * t;

    let r = (this.zenith.r + (hr - this.zenith.r) * t) * lum;
    let g = (this.zenith.g + (hg - this.zenith.g) * t) * lum;
    let b = (this.zenith.b + (hb - this.zenith.b) * t) * lum;

    // --- forward-scattering aureole + solar disc -----------------------------
    if (this.disc > 0) {
      const cosA = dx * this.sx + dy * this.sy + dz * this.sz;
      if (cosA > 0) {
        const c2 = cosA * cosA;
        const c4 = c2 * c2;
        const c28 = Math.pow(cosA, 28);
        const aur = c28 * this.glow * 7.0 + c4 * this.glow * 1.15;
        r += this.sun.r * aur;
        g += this.sun.g * aur;
        b += this.sun.b * aur;
        if (cosA > 0.99925) {
          const k = Math.min(1, (cosA - 0.99925) / 0.00075);
          const d = this.disc * (0.35 + 0.65 * Math.sqrt(k));
          r += this.sun.r * d;
          g += this.sun.g * d;
          b += this.sun.b * d;
        }
      }
    }

    // --- lit ground, blended across a soft horizon band ---------------------
    const gw = THREE.MathUtils.smoothstep(-dy, -0.035, 0.055);
    if (gw > 0) {
      // The sunward half of the ground is the half you can see sunlight on.
      const gGain = 1 - this.azAmp * 0.34 + this.azAmp * 0.80 * w;
      const gr = this.groundBase.r * gGain;
      const gg = this.groundBase.g * gGain;
      const gb = this.groundBase.b * gGain;
      r = r * (1 - gw) + gr * gw;
      g = g * (1 - gw) + gg * gw;
      b = b * (1 - gw) + gb * gw;
    }

    out[0] = r; out[1] = g; out[2] = b;
    return out;
  }

  /**
   * Project the sphere onto 9 real spherical-harmonic bands per channel and
   * fold in the Lambertian convolution constants (Ramamoorthi & Hanrahan 2001),
   * so evaluating the result against a normal yields irradiance directly.
   *
   * The basis is evaluated on world (x,y,z) with z as the nominal polar axis.
   * Which axis is polar is irrelevant as long as projection and evaluation
   * agree, and they are the two halves of this one file plus its patch.
   *
   * @param {number} lat latitude samples (theta)
   * @returns {{coeff: Float32Array, dc: Float32Array}} 27 packed floats + the
   *          band-0 term on its own, so callers can keep or drop the DC level.
   */
  projectSH(lat = 64) {
    const lon = lat * 2;
    const L = new Float64Array(27);
    const y = new Float64Array(9);
    const dTheta = Math.PI / lat;
    const dPhi = (Math.PI * 2) / lon;

    for (let iy = 0; iy < lat; iy++) {
      const theta = (iy + 0.5) * dTheta;
      const sinT = Math.sin(theta);
      const dy = Math.cos(theta);
      const dw = sinT * dTheta * dPhi;
      for (let ix = 0; ix < lon; ix++) {
        const phi = (ix + 0.5) * dPhi - Math.PI;
        const dx = sinT * Math.sin(phi);
        const dz = sinT * Math.cos(phi);
        const c = this.radiance(dx, dy, dz);

        // Real SH basis, bands 0..2.
        y[0] = 0.2820948;
        y[1] = 0.4886025 * dy;
        y[2] = 0.4886025 * dz;
        y[3] = 0.4886025 * dx;
        y[4] = 1.0925484 * dx * dy;
        y[5] = 1.0925484 * dy * dz;
        y[6] = 0.3153916 * (3 * dz * dz - 1);
        y[7] = 1.0925484 * dx * dz;
        y[8] = 0.5462742 * (dx * dx - dy * dy);
        for (let k = 0; k < 9; k++) {
          const yk = y[k] * dw;
          L[k * 3] += c[0] * yk;
          L[k * 3 + 1] += c[1] * yk;
          L[k * 3 + 2] += c[2] * yk;
        }
      }
    }

    // Lambertian convolution + basis normalisation folded into the coefficient,
    // and a mild band-2 window to suppress ringing into negative lobes.
    const A = [3.1415927, 2.0943951, 2.0943951, 2.0943951,
      0.7853982, 0.7853982, 0.7853982, 0.7853982, 0.7853982];
    const BASIS = [0.2820948, 0.4886025, 0.4886025, 0.4886025,
      1.0925484, 1.0925484, 0.3153916, 1.0925484, 0.5462742];
    const WINDOW = [1, 1, 1, 1, 0.86, 0.86, 0.86, 0.86, 0.86];

    const coeff = new Float32Array(27);
    for (let k = 0; k < 9; k++) {
      const s = A[k] * BASIS[k] * WINDOW[k];
      coeff[k * 3] = L[k * 3] * s;
      coeff[k * 3 + 1] = L[k * 3 + 1] * s;
      coeff[k * 3 + 2] = L[k * 3 + 2] * s;
    }
    const dc = new Float32Array([coeff[0], coeff[1], coeff[2]]);
    return { coeff, dc };
  }
}
