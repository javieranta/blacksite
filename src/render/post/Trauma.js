import { SHAKE, HURT } from './PostConstants.js';

/**
 * OWNER: postfx agent.
 *
 * Screen trauma and damage feedback.
 *
 * Shake is *not* random jitter. Random per-frame offsets read as a rendering
 * bug because consecutive frames are uncorrelated — the eye sees tearing, not
 * force. Real shake is a smooth signal: gradient (Perlin-style) noise sampled
 * along three decorrelated 1-D lanes, amplitude following trauma², and — the
 * part everyone forgets — *frequency falling as the trauma decays*, so an
 * impact starts as a sharp rattle and ends as a slow settle.
 *
 * Everything here is allocation-free after construction.
 */

const PERM_SIZE = 512;

/** Deterministic gradient table for 1-D Perlin noise. */
function buildGradients(seed) {
  const grad = new Float32Array(PERM_SIZE);
  let a = seed >>> 0;
  for (let i = 0; i < PERM_SIZE; i++) {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    grad[i] = (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  }
  return grad;
}

const GRAD = buildGradients(0x9e3779b9);

const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);

/** Classic 1-D Perlin: gradient dot distance, quintic-faded, in [-1,1]. */
function perlin1(x) {
  const i0 = Math.floor(x);
  const t = x - i0;
  const g0 = GRAD[i0 & (PERM_SIZE - 1)];
  const g1 = GRAD[(i0 + 1) & (PERM_SIZE - 1)];
  const n0 = g0 * t;
  const n1 = g1 * (t - 1);
  return (n0 + (n1 - n0) * fade(t)) * 2.0;
}

/** Two octaves — enough body to feel physical, cheap enough to be free. */
function fbm1(x) {
  return perlin1(x) * 0.72 + perlin1(x * 2.17 + 31.7) * 0.28;
}

export class Trauma {
  constructor() {
    /** 0..1 accumulated trauma. Displacement uses trauma². */
    this.trauma = 0;
    this._time = 0;
    this._decay = SHAKE.decay;

    /** Damage flash, 0..1. */
    this.hurt = 0;

    /** Output, read by PostFX. Reused every frame — never reallocated. */
    this.offsetX = 0;
    this.offsetY = 0;
    this.roll = 0;
    this.zoom = 1;
  }

  /**
   * @param {number} amount 0..1 — how hard. 0.25 footstep, 0.45 gunshot, 0.9 explosion.
   * @param {number} duration seconds the trauma should take to fall away.
   */
  add(amount = 0.4, duration = 0.15) {
    this.trauma = Math.min(1, Math.max(this.trauma, amount));
    // Convert "duration" into a decay rate rather than tracking a timer, so
    // overlapping shakes compose instead of restarting each other.
    if (duration > 0.001) this._decay = Math.min(SHAKE.decay * 2.5, 1 / duration);
  }

  /** @param {number} intensity 0..1 red-edge pulse strength. */
  damage(intensity = 0.6) {
    this.hurt = Math.min(HURT.maxStrength, Math.max(this.hurt, intensity));
  }

  update(dt) {
    this._time += dt;

    if (this.hurt > 0) {
      this.hurt = Math.max(0, this.hurt - dt * HURT.decay);
    }

    if (this.trauma <= 0) {
      this.offsetX = 0;
      this.offsetY = 0;
      this.roll = 0;
      this.zoom = 1;
      return;
    }

    this.trauma = Math.max(0, this.trauma - dt * this._decay);
    if (this.trauma <= 0) {
      this._decay = SHAKE.decay;
      this.offsetX = 0;
      this.offsetY = 0;
      this.roll = 0;
      this.zoom = 1;
      return;
    }

    const s = this.trauma * this.trauma;            // trauma² — the standard curve
    const freq = SHAKE.freqCold + (SHAKE.freqHot - SHAKE.freqCold) * this.trauma;
    const t = this._time * freq;

    // Three decorrelated lanes so x, y and roll never move in lockstep.
    this.offsetX = fbm1(t) * SHAKE.maxOffset * s;
    this.offsetY = fbm1(t + 137.31) * SHAKE.maxOffset * s;
    this.roll = fbm1(t * 0.72 + 913.7) * SHAKE.maxRoll * s;
    // Zoom in slightly so the shifted frame never samples outside the buffer.
    this.zoom = 1 - SHAKE.zoom * s;
  }

  get active() {
    return this.trauma > 0 || this.hurt > 0;
  }
}
