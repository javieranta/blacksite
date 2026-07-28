import * as THREE from 'three';
import { SharedDataTexture } from './SharedUniforms.js';

/**
 * OWNER: sky-atmosphere agent.
 *
 * A single-scattering atmospheric model, evaluated on the CPU into a small
 * half-float lookup table. Rayleigh + Mie + ozone, exponential density shells,
 * a real transmittance-to-sun integral and an isotropic multiple-scattering
 * approximation. Not a curve fit: the deep-blue zenith, the red horizon at
 * sunset, the forward-scatter brightening around the sun and the blue twilight
 * band all fall out of the integral instead of being hand-painted.
 *
 * WHY A CPU LUT AND NOT A SHADER
 * ------------------------------
 * The table is consumed by two very different clients:
 *   1. the sky dome, which needs it per sky pixel, and
 *   2. *every fogged material in the scene*, which needs it per opaque pixel to
 *      evaluate aerial perspective.
 * Client 2 is the reason it cannot be a render target: three's
 * `cloneUniforms` refuses to share render-target textures, so a shared sampler
 * has to be a `DataTexture`. Building it on the CPU also means Sky can query the
 * exact same radiance in JS for the fog colour, the IBL hint and `skyColour` —
 * the sky, the fog and the lighting are then three readings of one number and
 * can never drift apart.
 *
 * PARAMETERISATION
 * ----------------
 * For a horizontally uniform atmosphere the sky radiance depends on only two
 * angles: the view elevation and the angle to the light. So:
 *   u = sqrt( gamma / PI )      gamma = angle between view and sun
 *   v = 0.5 + 0.5 * sign(y) * sqrt(|y|)      y = view direction .y
 * The sqrt on u spends texels where the Mie lobe is sharp; the sqrt on v spends
 * them at the horizon, where the gradient is steepest. 96x48 is then plenty —
 * the function is smooth once the sun disc is excluded (the disc is drawn
 * analytically by the dome, it is deliberately *not* in this table).
 *
 * Rows below the horizon hold lit-ground radiance seen through the intervening
 * air, which is what gives the IBL's lower hemisphere its bounce and what the
 * fog uses when you look down a long street at a distant object.
 */

export const LUT_W = 96;
export const LUT_H = 48;

/* --------------------------------------------------------------- constants -- */

const Rg = 6360e3;              // ground radius (m)
const Ra = 6460e3;              // top of atmosphere (m)
const H_RAYLEIGH = 8000;
const H_MIE = 1200;

// Rayleigh scattering at sea level, per metre, for ~(680, 550, 440) nm.
const BR = [5.802e-6, 13.558e-6, 33.100e-6];
// Mie scattering / extinction at sea level for a clear-ish aerosol load.
const BM_SCATTER = 3.996e-6;
const BM_EXTINCT = 4.400e-6;
// Ozone absorption — small, but it is the entire reason twilight is blue and
// not brown, so it earns its place.
const BO = [0.650e-6, 1.881e-6, 0.085e-6];

const EYE_ALT = 250;            // observer altitude (m) — keeps the horizon sane
const VIEW_STEPS = 22;
const SUN_STEPS = 14;
const SUN_TABLE = 48;

const INV_PI = 1 / Math.PI;

function ozoneDensity(h) {
  return Math.max(0, 1 - Math.abs(h - 25000) / 15000);
}

function smoothstep(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/* ------------------------------------------------------------------- model -- */

export class Atmosphere {
  constructor() {
    this.width = LUT_W;
    this.height = LUT_H;

    /** Linear radiance, kept for CPU queries (fog colour, IBL hints). */
    this.linear = new Float32Array(LUT_W * LUT_H * 3);
    this._half = new Uint16Array(LUT_W * LUT_H * 4);

    this.texture = new SharedDataTexture(this._half, LUT_W, LUT_H,
      THREE.RGBAFormat, THREE.HalfFloatType);
    this.texture.name = 'sky-radiance-lut';
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.wrapS = THREE.ClampToEdgeWrapping;
    this.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.texture.generateMipmaps = false;
    this.texture.colorSpace = THREE.LinearSRGBColorSpace;
    this.texture.needsUpdate = true;

    // Scratch — rebuilds happen off the hot path but still never allocate.
    this._sunT = new Float32Array(SUN_TABLE * 3);
    this._ts = [0, 0, 0];
    this._tsHigh = [0, 0, 0];
    this._tau = [0, 0, 0];
    this._acc = [0, 0, 0];
    this._L = [0, 0, 0];
    this._skyIrr = [0, 0, 0];
    this._dir = [0, 0, 0];
    this._q = new THREE.Color();

    /** Filled by build(): useful aggregates the rest of the system reads. */
    this.zenith = new THREE.Color();
    this.horizonAvg = new THREE.Color();
    this.average = new THREE.Color();
    this.groundAvg = new THREE.Color();
  }

  /* ----------------------------------------------------------- transmittance */

  /** Optical transmittance from altitude `h` to space along `L`, per channel. */
  _buildSunTable(lx, ly, lz) {
    const T = this._sunT;
    for (let i = 0; i < SUN_TABLE; i++) {
      const f = i / (SUN_TABLE - 1);
      const h = f * f * (Ra - Rg);
      const r0 = Rg + h;
      // Does the ray to the light clip the planet?
      const b = r0 * ly;
      const cG = r0 * r0 - Rg * Rg;
      if (ly < 0 && b * b >= cG) {
        T[i * 3] = 0; T[i * 3 + 1] = 0; T[i * 3 + 2] = 0;
        continue;
      }
      const cA = r0 * r0 - Ra * Ra;
      const tTop = -b + Math.sqrt(Math.max(b * b - cA, 0));
      let o0 = 0, o1 = 0, o2 = 0;
      for (let s = 0; s < SUN_STEPS; s++) {
        const a = (s / SUN_STEPS) ** 2 * tTop;
        const bb = ((s + 1) / SUN_STEPS) ** 2 * tTop;
        const tm = (a + bb) * 0.5, ds = bb - a;
        const px = lx * tm, py = r0 + ly * tm, pz = lz * tm;
        const hh = Math.max(0, Math.sqrt(px * px + py * py + pz * pz) - Rg);
        const rR = Math.exp(-hh / H_RAYLEIGH);
        const rM = Math.exp(-hh / H_MIE);
        const rO = ozoneDensity(hh);
        o0 += (BR[0] * rR + BM_EXTINCT * rM + BO[0] * rO) * ds;
        o1 += (BR[1] * rR + BM_EXTINCT * rM + BO[1] * rO) * ds;
        o2 += (BR[2] * rR + BM_EXTINCT * rM + BO[2] * rO) * ds;
      }
      T[i * 3] = Math.exp(-o0);
      T[i * 3 + 1] = Math.exp(-o1);
      T[i * 3 + 2] = Math.exp(-o2);
    }
  }

  _sunTransmittance(h, out) {
    const f = Math.sqrt(Math.min(1, Math.max(0, h / (Ra - Rg)))) * (SUN_TABLE - 1);
    const i = Math.min(SUN_TABLE - 2, Math.floor(f));
    const t = f - i;
    const a = i * 3, b = a + 3;
    const T = this._sunT;
    out[0] = T[a] + (T[b] - T[a]) * t;
    out[1] = T[a + 1] + (T[b + 1] - T[a + 1]) * t;
    out[2] = T[a + 2] + (T[b + 2] - T[a + 2]) * t;
    return out;
  }

  /* ---------------------------------------------------------------- integral */

  /**
   * In-scattered radiance along a view ray, for one light. Adds into `out`.
   * `p` carries the per-preset aerosol / multiple-scattering knobs.
   */
  _scatter(dx, dy, dz, lx, ly, lz, irr, p, out) {
    const mieScale = p.mieScale;
    const bmS = BM_SCATTER * mieScale;
    const bmE = BM_EXTINCT * mieScale;

    const r0 = Rg + EYE_ALT;
    const b = r0 * dy;
    const cA = r0 * r0 - Ra * Ra;
    const tTop = -b + Math.sqrt(Math.max(b * b - cA, 0));
    const cG = r0 * r0 - Rg * Rg;
    let tMax = tTop;
    let groundHit = false;
    if (dy < 0) {
      const disc = b * b - cG;
      if (disc >= 0) {
        const tG = -b - Math.sqrt(disc);
        if (tG > 0) { tMax = tG; groundHit = true; }
      }
    }

    const cosG = dx * lx + dy * ly + dz * lz;
    const phaseR = 0.0596831 * (1 + cosG * cosG);
    const g = p.mieG;
    const denom = 1 + g * g - 2 * g * cosG;
    const phaseM = 0.1193662 * (1 - g * g) * (1 + cosG * cosG) /
      ((2 + g * g) * Math.pow(Math.max(denom, 1e-4), 1.5));

    // Isotropic multiple-scattering strength. The transmittance is sampled high
    // in the column rather than at the sample altitude for two reasons: there is
    // still sunlit air up there after the ground terminator has passed, which is
    // what keeps twilight from collapsing to black; and multiply-scattered light
    // physically comes from up there, so it has NOT travelled the long reddened
    // slant path near the ground. Sampling it low was turning the whole dusk sky
    // brown instead of leaving the high dome ozone-blue.
    const psi = p.multiScatter * (0.22 + 0.78 * smoothstep(-0.22, 0.32, ly));
    this._sunTransmittance(16000, this._tsHigh);

    const tau = this._tau;
    tau[0] = 0; tau[1] = 0; tau[2] = 0;
    let l0 = 0, l1 = 0, l2 = 0;

    for (let s = 0; s < VIEW_STEPS; s++) {
      const a0 = (s / VIEW_STEPS) ** 2 * tMax;
      const a1 = ((s + 1) / VIEW_STEPS) ** 2 * tMax;
      const tm = (a0 + a1) * 0.5, ds = a1 - a0;
      if (ds <= 0) continue;

      const px = dx * tm, py = r0 + dy * tm, pz = dz * tm;
      const h = Math.max(0, Math.sqrt(px * px + py * py + pz * pz) - Rg);
      const rR = Math.exp(-h / H_RAYLEIGH);
      const rM = Math.exp(-h / H_MIE);
      const rO = ozoneDensity(h);

      const ts = this._sunTransmittance(h, this._ts);

      // Midpoint transmittance from the eye to this sample.
      const e0 = BR[0] * rR + bmE * rM + BO[0] * rO;
      const e1 = BR[1] * rR + bmE * rM + BO[1] * rO;
      const e2 = BR[2] * rR + bmE * rM + BO[2] * rO;
      const t0 = Math.exp(-(tau[0] + e0 * ds * 0.5));
      const t1 = Math.exp(-(tau[1] + e1 * ds * 0.5));
      const t2 = Math.exp(-(tau[2] + e2 * ds * 0.5));
      tau[0] += e0 * ds; tau[1] += e1 * ds; tau[2] += e2 * ds;

      const sR = rR * phaseR, sM = rM * phaseM;
      l0 += irr[0] * t0 * ds * (ts[0] * (BR[0] * sR + bmS * sM)
        + psi * this._tsHigh[0] * (BR[0] * rR + bmS * rM));
      l1 += irr[1] * t1 * ds * (ts[1] * (BR[1] * sR + bmS * sM)
        + psi * this._tsHigh[1] * (BR[1] * rR + bmS * rM));
      l2 += irr[2] * t2 * ds * (ts[2] * (BR[2] * sR + bmS * sM)
        + psi * this._tsHigh[2] * (BR[2] * rR + bmS * rM));
    }

    if (groundHit) {
      // Lambertian ground, lit by this light plus the sky irradiance measured on
      // the previous pass, then seen through the air we just integrated.
      const ts = this._sunTransmittance(0, this._ts);
      const mu = Math.max(0, ly);
      const alb = p.groundAlbedo;
      const sky = this._skyIrr;
      // Lambertian: L = albedo * E_horizontal / PI.
      l0 += Math.exp(-tau[0]) * alb[0] * INV_PI * (irr[0] * mu * ts[0] + sky[0]);
      l1 += Math.exp(-tau[1]) * alb[1] * INV_PI * (irr[1] * mu * ts[1] + sky[1]);
      l2 += Math.exp(-tau[2]) * alb[2] * INV_PI * (irr[2] * mu * ts[2] + sky[2]);
    }

    out[0] += l0; out[1] += l1; out[2] += l2;
  }

  /* ------------------------------------------------------------------ build */

  /**
   * @param {object} p atmosphere parameters. See SkyPresets.js for the shape.
   *
   * Ordering matters. The sun transmittance table depends on the light
   * direction, so it is rebuilt once per light per hemisphere rather than per
   * texel (that mistake costs three orders of magnitude). The upper hemisphere
   * is integrated first because the ground bounce in the lower hemisphere needs
   * a sky irradiance to reflect.
   */
  build(p) {
    this.linear.fill(0);
    this._skyIrr[0] = 0; this._skyIrr[1] = 0; this._skyIrr[2] = 0;

    const sun = p.sunDir, moon = p.moonDir;
    const lit = (e) => e[0] > 1e-5 || e[1] > 1e-5 || e[2] > 1e-5;
    const hasSun = lit(p.sunIrradiance);
    const hasMoon = lit(p.moonIrradiance);
    const mid = LUT_H >> 1;

    if (hasSun) {
      this._buildSunTable(sun.x, sun.y, sun.z);
      this._rows(mid, LUT_H, sun, sun, p.sunIrradiance, p);
    }
    if (hasMoon) {
      this._buildSunTable(moon.x, moon.y, moon.z);
      this._rows(mid, LUT_H, sun, moon, p.moonIrradiance, p);
    }

    this._integrateSkyIrradiance(p);

    if (hasSun) {
      this._buildSunTable(sun.x, sun.y, sun.z);
      this._rows(0, mid, sun, sun, p.sunIrradiance, p);
    }
    if (hasMoon) {
      this._buildSunTable(moon.x, moon.y, moon.z);
      this._rows(0, mid, sun, moon, p.moonIrradiance, p);
    }

    this._grade(p);
    this._encode();
    this._aggregate();
  }

  /** Integrate one light into rows [j0, j1). Accumulates into `linear`. */
  _rows(j0, j1, sun, light, irr, p) {
    const lin = this.linear;
    const L = this._L;
    for (let j = j0; j < j1; j++) {
      const v = (j + 0.5) / LUT_H;
      const k = 2 * v - 1;
      const y = Math.sign(k) * k * k;
      const horiz = Math.sqrt(Math.max(0, 1 - y * y));

      for (let i = 0; i < LUT_W; i++) {
        const u = (i + 0.5) / LUT_W;
        const cosG = Math.cos(u * u * Math.PI);

        // Reconstruct a view direction at elevation `y` whose angle to the sun
        // is gamma. Where that pairing is geometrically impossible the closest
        // achievable direction is used — those cells are never sampled by a real
        // view ray, they only exist to keep the bilinear filter well fed.
        this._directionFor(y, horiz, cosG, sun, this._dir);
        const d = this._dir;

        L[0] = 0; L[1] = 0; L[2] = 0;
        this._scatter(d[0], d[1], d[2], light.x, light.y, light.z, irr, p, L);

        const o = (j * LUT_W + i) * 3;
        lin[o] += L[0]; lin[o + 1] += L[1]; lin[o + 2] += L[2];
      }
    }
  }

  /**
   * A view direction with elevation `y` at angle `acos(cosG)` from the sun.
   * Solves for the azimuth in the sun's frame; clamps when out of range.
   */
  _directionFor(y, horiz, cosG, sun, out) {
    const sy = sun.y;
    const sh = Math.sqrt(Math.max(0, 1 - sy * sy));
    if (sh < 1e-4 || horiz < 1e-6) {
      // Sun at the zenith (or straight-up view): azimuth is irrelevant.
      out[0] = horiz; out[1] = y; out[2] = 0;
      return out;
    }
    // cosG = y*sy + horiz*sh*cos(dAz)
    const c = Math.min(1, Math.max(-1, (cosG - y * sy) / (horiz * sh)));
    const dAz = Math.acos(c);
    // Sun's horizontal bearing.
    const bx = sun.x / sh, bz = sun.z / sh;
    const cs = Math.cos(dAz), sn = Math.sin(dAz);
    out[0] = horiz * (bx * cs - bz * sn);
    out[1] = y;
    out[2] = horiz * (bz * cs + bx * sn);
    return out;
  }

  /** Cosine-weighted hemispherical irradiance of the rows built so far. */
  _integrateSkyIrradiance(p) {
    const sun = p.sunDir;
    let r = 0, g = 0, b = 0, wsum = 0;
    const NE = 8, NA = 16;
    for (let e = 0; e < NE; e++) {
      const th = ((e + 0.5) / NE) * Math.PI * 0.5;
      const y = Math.cos(th), sinT = Math.sin(th);
      for (let a = 0; a < NA; a++) {
        const az = ((a + 0.5) / NA) * Math.PI * 2;
        const dx = sinT * Math.cos(az), dz = sinT * Math.sin(az);
        const cosG = dx * sun.x + y * sun.y + dz * sun.z;
        this.radiance(y, cosG, this._acc);
        const w = y * sinT;
        r += this._acc[0] * w; g += this._acc[1] * w; b += this._acc[2] * w;
        wsum += w;
      }
    }
    const norm = wsum > 0 ? Math.PI / wsum : 0;
    this._skyIrr[0] = r * norm; this._skyIrr[1] = g * norm; this._skyIrr[2] = b * norm;
  }

  /** Art-direction pass: gain, tint, desaturation and the overcast override. */
  _grade(p) {
    const lin = this.linear;
    const [gr, gg, gb] = p.tint;
    const gain = p.exposure;
    const desat = p.desaturate;
    const ovc = p.overcast;
    const [or_, og, ob] = p.overcastTint;
    const ovcLevel = p.overcastLevel;
    const [ar, ag, ab] = p.airglow;

    for (let j = 0; j < LUT_H; j++) {
      const v = (j + 0.5) / LUT_H;
      const k = 2 * v - 1;
      const y = Math.sign(k) * k * k;
      for (let i = 0; i < LUT_W; i++) {
        const o = (j * LUT_W + i) * 3;
        let r = lin[o] * gain * gr;
        let g = lin[o + 1] * gain * gg;
        let b = lin[o + 2] * gain * gb;

        if (desat > 0) {
          const lum = r * 0.2126 + g * 0.7152 + b * 0.0722;
          r += (lum - r) * desat; g += (lum - g) * desat; b += (lum - b) * desat;
        }

        if (ovc > 0) {
          // A real overcast deck is a luminous grey dome: brightest overhead,
          // falling off toward the horizon where you look through more of it.
          // Fade the override out below the horizon so the lit-ground radiance
          // that feeds the IBL's lower hemisphere survives.
          const f = ovcLevel * (0.58 + 0.42 * Math.pow(Math.max(0, y), 0.6));
          const t = ovc * (1 - Math.min(1, Math.max(0, -y / 0.30)));
          r += (or_ * f - r) * t;
          g += (og * f - g) * t;
          b += (ob * f - b) * t;
        }

        // Airglow / light pollution: a faint floor that keeps night from
        // clipping to black and gives the horizon a hint of sodium.
        if (ar > 0 || ab > 0) {
          const w = 0.55 + 0.45 * (1 - Math.min(1, Math.abs(y)));
          r += ar * w; g += ag * w; b += ab * w;
        }

        lin[o] = Math.max(0, r);
        lin[o + 1] = Math.max(0, g);
        lin[o + 2] = Math.max(0, b);
      }
    }
  }

  _encode() {
    const lin = this.linear, half = this._half;
    const toHalf = THREE.DataUtils.toHalfFloat;
    for (let n = 0, m = 0; n < LUT_W * LUT_H; n++, m += 3) {
      const o = n * 4;
      half[o] = toHalf(Math.min(4096, lin[m]));
      half[o + 1] = toHalf(Math.min(4096, lin[m + 1]));
      half[o + 2] = toHalf(Math.min(4096, lin[m + 2]));
      half[o + 3] = 15360; // 1.0
    }
    this.texture.needsUpdate = true;
  }

  _aggregate() {
    const lin = this.linear;
    // Zenith is the top row, averaged over gamma.
    let r = 0, g = 0, b = 0;
    const top = (LUT_H - 1) * LUT_W * 3;
    for (let i = 0; i < LUT_W; i++) {
      r += lin[top + i * 3]; g += lin[top + i * 3 + 1]; b += lin[top + i * 3 + 2];
    }
    this.zenith.setRGB(r / LUT_W, g / LUT_W, b / LUT_W, THREE.LinearSRGBColorSpace);

    const hj = LUT_H >> 1;
    r = 0; g = 0; b = 0;
    for (let i = 0; i < LUT_W; i++) {
      const o = (hj * LUT_W + i) * 3;
      r += lin[o]; g += lin[o + 1]; b += lin[o + 2];
    }
    this.horizonAvg.setRGB(r / LUT_W, g / LUT_W, b / LUT_W, THREE.LinearSRGBColorSpace);

    // Solid-angle weighted hemisphere averages. Rows are uniform in
    // v = sqrt(|y|), so dy/dv = 2*sqrt(|y|) is the measure that turns a row sum
    // back into an honest average — without it the sqrt mapping triple-counts
    // the horizon and every "average sky" reads far too bright.
    r = 0; g = 0; b = 0;
    let gr = 0, gg = 0, gb = 0, wUp = 0, wDn = 0;
    for (let j = 0; j < LUT_H; j++) {
      const v = (j + 0.5) / LUT_H;
      const k = 2 * v - 1;
      const w = 2 * Math.abs(k);
      for (let i = 0; i < LUT_W; i++) {
        const o = (j * LUT_W + i) * 3;
        if (j >= hj) { r += lin[o] * w; g += lin[o + 1] * w; b += lin[o + 2] * w; wUp += w; }
        else { gr += lin[o] * w; gg += lin[o + 1] * w; gb += lin[o + 2] * w; wDn += w; }
      }
    }
    wUp = wUp || 1; wDn = wDn || 1;
    this.average.setRGB(r / wUp, g / wUp, b / wUp, THREE.LinearSRGBColorSpace);
    this.groundAvg.setRGB(gr / wDn, gg / wDn, gb / wDn, THREE.LinearSRGBColorSpace);
  }

  /* ------------------------------------------------------------------ query */

  /** Bilinear CPU read of the table. `out` is a 3-array. */
  radiance(dirY, cosG, out) {
    const gamma = Math.acos(Math.min(1, Math.max(-1, cosG)));
    let u = Math.sqrt(Math.min(1, gamma * INV_PI)) * LUT_W - 0.5;
    const s = dirY < 0 ? -1 : 1;
    let v = (0.5 + 0.5 * s * Math.sqrt(Math.min(1, Math.abs(dirY)))) * LUT_H - 0.5;
    u = Math.min(LUT_W - 1, Math.max(0, u));
    v = Math.min(LUT_H - 1, Math.max(0, v));
    const i0 = Math.floor(u), j0 = Math.floor(v);
    const i1 = Math.min(LUT_W - 1, i0 + 1), j1 = Math.min(LUT_H - 1, j0 + 1);
    const fu = u - i0, fv = v - j0;
    const lin = this.linear;
    for (let c = 0; c < 3; c++) {
      const a = lin[(j0 * LUT_W + i0) * 3 + c], b = lin[(j0 * LUT_W + i1) * 3 + c];
      const d = lin[(j1 * LUT_W + i0) * 3 + c], e = lin[(j1 * LUT_W + i1) * 3 + c];
      out[c] = (a + (b - a) * fu) + ((d + (e - d) * fu) - (a + (b - a) * fu)) * fv;
    }
    return out;
  }

  /** Radiance in a world-space direction, written into a THREE.Color. */
  radianceInto(colour, dir, sunDir) {
    const cosG = dir.x * sunDir.x + dir.y * sunDir.y + dir.z * sunDir.z;
    this.radiance(dir.y, cosG, this._acc);
    colour.setRGB(this._acc[0], this._acc[1], this._acc[2], THREE.LinearSRGBColorSpace);
    return colour;
  }

  dispose() {
    this.texture.dispose();
  }
}
