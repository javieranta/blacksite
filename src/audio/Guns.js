/**
 * OWNER: audio agent.
 * Gunfire synthesis. A convincing shot is four coupled layers:
 *
 *   1. TRANSIENT  — the muzzle blast wavefront. A very short, very bright
 *                   filtered noise burst with a sub-millisecond attack and an
 *                   exponential decay measured in single-digit milliseconds.
 *                   This is the layer the ear uses to judge "how big".
 *   2. BODY       — band-passed noise plus a pitched component that sweeps down.
 *                   The pitch is what separates 5.56 from 7.62; the noise band
 *                   is what separates a rifle from a firecracker.
 *   3. MECHANICAL — the action cycling. Two or three metallic transients offset
 *                   by a few milliseconds: bolt unlock, carrier travel, feed.
 *                   Only audible on your own weapon, which is exactly right.
 *   4. TAIL       — the environment answering back. A longer, darkening noise
 *                   decay whose length comes from the zone, plus the reverb send.
 *
 * Everything is derived from WeaponData so a new weapon gets a matching voice
 * without a new sound being authored.
 */
import { noiseVoice, toneVoice, ringVoice, clickVoice, vary } from './Synth.js';

/** Per-class voice character. Keyed by the cue names the rest of the build uses. */
const PROFILES = {
  fire_ar: {
    level: 1.00,
    crackFreq: 3350, crackQ: 0.85, crackDur: 0.026,
    bodyFreq: 540, bodyQ: 0.95, bodyDur: 0.115,
    subF0: 158, subF1: 62, subDur: 0.145, subGain: 0.52,
    tailDur: 0.40, tailGain: 0.30,
    mechFreq: 4300, mechGain: 0.20,
    boltRing: [2380, 3910, 5720],
  },
  fire_smg: {
    level: 0.84,
    crackFreq: 2950, crackQ: 0.8, crackDur: 0.019,
    bodyFreq: 740, bodyQ: 1.05, bodyDur: 0.078,
    subF0: 205, subF1: 96, subDur: 0.095, subGain: 0.38,
    tailDur: 0.27, tailGain: 0.24,
    mechFreq: 5200, mechGain: 0.24,
    boltRing: [3120, 4680, 6900],
  },
  fire_dmr: {
    level: 1.28,
    crackFreq: 2450, crackQ: 0.75, crackDur: 0.036,
    bodyFreq: 335, bodyQ: 0.9, bodyDur: 0.170,
    subF0: 112, subF1: 43, subDur: 0.230, subGain: 0.72,
    tailDur: 0.66, tailGain: 0.40,
    mechFreq: 3600, mechGain: 0.26,
    boltRing: [1840, 3020, 4410],
  },
};

const SCRATCH_RING = [0, 0, 0];
const SCRATCH = { ...PROFILES.fire_ar, boltRing: SCRATCH_RING };

/** Map a WeaponData entry onto a cue name. */
export function cueForWeapon(weapon) {
  if (!weapon) return 'fire_ar';
  if (weapon.class === 'smg') return 'fire_smg';
  if (weapon.class === 'marksman') return 'fire_dmr';
  return 'fire_ar';
}

export function gunProfile(cue) {
  return PROFILES[cue] ?? PROFILES.fire_ar;
}

/**
 * sc — shot context built by AudioEngine:
 *   { ac, noise, t0, out, far, dist, rapid, tailScale, weapon }
 * `out` is already distance-attenuated, air-filtered and panned; `far` is the
 * long rolling-thunder convolution bus.
 */
export function fireShot(sc, cue) {
  const base = gunProfile(cue);
  const { ac, noise, t0, out } = sc;
  const near = sc.dist < 28;
  const lvl = base.level;
  // Callers may ask for a detuned variant (the AI fires the same rifle model as
  // the player and would otherwise sound like a clone of them).
  // A module-scope scratch object avoids allocating a profile per shot; a cue is
  // built synchronously inside one call, so it can never be observed half-built.
  const P = sc.pitch ?? 1;
  let p = base;
  if (P !== 1) {
    p = SCRATCH;
    p.level = base.level;
    p.crackFreq = base.crackFreq * P; p.crackQ = base.crackQ; p.crackDur = base.crackDur;
    p.bodyFreq = base.bodyFreq * P; p.bodyQ = base.bodyQ; p.bodyDur = base.bodyDur;
    p.subF0 = base.subF0 * P; p.subF1 = base.subF1 * P;
    p.subDur = base.subDur; p.subGain = base.subGain;
    p.tailDur = base.tailDur; p.tailGain = base.tailGain;
    p.mechFreq = base.mechFreq * P; p.mechGain = base.mechGain;
    p.boltRing = SCRATCH_RING;
    for (let i = 0; i < base.boltRing.length; i++) SCRATCH_RING[i] = base.boltRing[i] * P;
  }

  if (near) {
    // ---- 1. transient crack -------------------------------------------------
    noiseVoice(ac, noise, out, {
      t0, dur: p.crackDur * vary(0.12), gain: 0.95 * lvl,
      type: 'bandpass', freq: p.crackFreq * vary(0.06), q: p.crackQ,
      hp: 1100, attack: 0.0004,
    });
    // A second, even shorter band an octave up gives the shot its "snap" and
    // stops the crack reading as a soft thud on small speakers.
    noiseVoice(ac, noise, out, {
      t0, dur: 0.007, gain: 0.5 * lvl,
      type: 'highpass', freq: 5200, q: 0.6, attack: 0.0002,
    });

    // ---- 2. body ------------------------------------------------------------
    noiseVoice(ac, noise, out, {
      t0: t0 + 0.0012, dur: p.bodyDur * vary(0.1), gain: 0.72 * lvl,
      type: 'bandpass', freq: p.bodyFreq * vary(0.05), freqTo: p.bodyFreq * 0.55,
      q: p.bodyQ, lp: 7200, lpTo: 1500, attack: 0.0009,
    });
    toneVoice(ac, out, {
      t0, dur: p.subDur, f0: p.subF0 * vary(0.05), f1: p.subF1,
      gain: p.subGain * lvl, type: 'triangle', lp: 900, attack: 0.0012,
    });

    // ---- 3. mechanical ------------------------------------------------------
    // Bolt unlock immediately, carrier arriving a few ms later, feed on the way
    // back. Suppressed to a single tick during sustained automatic fire, where
    // the ear cannot resolve the sequence anyway.
    const mg = p.mechGain * lvl;
    clickVoice(ac, noise, out, {
      t0: t0 + 0.0035, dur: 0.009, gain: mg, freq: p.mechFreq * vary(0.08),
      freqs: p.boltRing, ringDecay: 0.026,
    });
    if (!sc.rapid) {
      clickVoice(ac, noise, out, {
        t0: t0 + 0.0135 * vary(0.15), dur: 0.011, gain: mg * 0.8,
        freq: p.mechFreq * 0.72, freqs: p.boltRing, ringDecay: 0.034,
      });
      ringVoice(ac, out, {
        t0: t0 + 0.021, freqs: p.boltRing, decay: 0.05, gain: mg * 0.5, detune: vary(0.02),
      });
    }

    // ---- 4. tail ------------------------------------------------------------
    if (!sc.rapid) {
      noiseVoice(ac, noise, out, {
        t0: t0 + 0.012, dur: p.tailDur * (sc.tailScale ?? 1),
        gain: p.tailGain * lvl, type: 'lowpass', freq: 3400, freqTo: 380,
        q: 0.5, hp: 140, attack: 0.006,
      });
    }
    return;
  }

  // ---- Distant report -------------------------------------------------------
  // Far gunfire is not a quiet near gunshot. The blast wavefront arrives as a
  // thin, dry crack with almost no body, then the compound answers with a low
  // rolling decay that lasts far longer than the shot itself.
  const d = sc.dist;
  const spread = Math.min(1, (d - 28) / 160);
  noiseVoice(ac, noise, out, {
    t0, dur: 0.012 + spread * 0.02, gain: 0.9 * lvl,
    type: 'bandpass', freq: 1750 - spread * 700, q: 1.1,
    hp: 420, attack: 0.0004,
  });
  noiseVoice(ac, noise, out, {
    t0: t0 + 0.004, dur: 0.075 + spread * 0.08, gain: 0.34 * lvl,
    type: 'bandpass', freq: 380 - spread * 140, q: 0.8, lp: 2200, lpTo: 500,
    attack: 0.003,
  });
  toneVoice(ac, out, {
    t0, dur: 0.18 + spread * 0.2, f0: 96 - spread * 30, f1: 38,
    gain: 0.3 * lvl, type: 'sine', attack: 0.004,
  });
  // The roll. Long, dark, and fed hard into the distant convolution bus.
  if (sc.far) {
    noiseVoice(ac, noise, sc.far, {
      t0: t0 + 0.02, dur: 0.55 + spread * 1.1, gain: (0.5 + spread * 0.5) * lvl,
      type: 'lowpass', freq: 900 - spread * 500, freqTo: 150, q: 0.4,
      hp: 60, attack: 0.03,
    });
  }
}

/** Dry-fire: hammer falls on nothing. Two hard clicks, no ring-out. */
export function emptyClick(sc) {
  const { ac, noise, t0, out } = sc;
  clickVoice(ac, noise, out, { t0, dur: 0.008, gain: 0.34, freq: 2600, q: 2.2, ringDecay: 0.014 });
  clickVoice(ac, noise, out, { t0: t0 + 0.026, dur: 0.006, gain: 0.18, freq: 4100, q: 2.6, ringDecay: 0.01 });
}

/**
 * Reload as a timed mechanical performance rather than one blob: catch, mag
 * clearing the well, fresh mag seating, then (start of the sequence only) the
 * bolt. Timings scale with the weapon's reloadTime so audio and animation stay
 * in step whatever the weapon.
 */
export function reloadStart(sc, weapon) {
  const { ac, noise, t0, out } = sc;
  const T = (weapon?.reloadTime ?? 2.1) * 0.42;
  clickVoice(ac, noise, out, { t0, dur: 0.014, gain: 0.30, freq: 2900, q: 1.8, ringDecay: 0.03 });
  // Magazine sliding out of the well: a scrape, not a click.
  noiseVoice(ac, noise, out, {
    t0: t0 + 0.05, dur: 0.11, gain: 0.16,
    type: 'bandpass', freq: 1500, freqTo: 780, q: 1.2, hp: 500, attack: 0.012,
  });
  ringVoice(ac, out, { t0: t0 + 0.14, freqs: [1420, 2260, 3380], decay: 0.055, gain: 0.10 });
  // Rounds shifting in the magazine as it swings.
  noiseVoice(ac, noise, out, {
    t0: t0 + T * 0.55, dur: 0.07, gain: 0.09,
    type: 'bandpass', freq: 3600, q: 2.4, attack: 0.008,
  });
}

export function reloadEnd(sc, weapon) {
  const { ac, noise, t0, out } = sc;
  const empty = !!sc.empty;
  // Fresh magazine seating: a solid low thunk with a metallic edge.
  noiseVoice(ac, noise, out, {
    t0, dur: 0.06, gain: 0.34, type: 'bandpass', freq: 620, q: 1.1, lp: 4200, attack: 0.0008,
  });
  toneVoice(ac, out, { t0, dur: 0.075, f0: 190, f1: 96, gain: 0.26, type: 'triangle', lp: 700 });
  ringVoice(ac, out, { t0: t0 + 0.004, freqs: [1180, 1930, 2870], decay: 0.05, gain: 0.13 });
  clickVoice(ac, noise, out, { t0: t0 + 0.055, dur: 0.01, gain: 0.20, freq: 3400, q: 2.0, ringDecay: 0.022 });
  if (empty) {
    // Charging handle / bolt release only happens on an empty reload.
    const bt = t0 + 0.17;
    noiseVoice(ac, noise, out, {
      t0: bt, dur: 0.055, gain: 0.22, type: 'bandpass', freq: 2100, freqTo: 1200, q: 1.4, attack: 0.01,
    });
    clickVoice(ac, noise, out, { t0: bt + 0.062, dur: 0.013, gain: 0.36, freq: 2750, q: 1.5, ringDecay: 0.045 });
    ringVoice(ac, out, { t0: bt + 0.064, freqs: [1560, 2480, 3720, 5100], decay: 0.07, gain: 0.16 });
  }
  void weapon;
}

/**
 * Weapon swap: the outgoing weapon settling against the chest rig, a sling
 * running through a loop, and the incoming weapon being brought up and gripped.
 */
export function weaponSwitch(sc) {
  const { ac, noise, t0, out } = sc;
  noiseVoice(ac, noise, out, {
    t0, dur: 0.13, gain: 0.13, type: 'bandpass', freq: 1400, freqTo: 700, q: 0.9,
    hp: 380, attack: 0.012, linear: true,
  });
  ringVoice(ac, out, { t0: t0 + 0.03, freqs: [980, 1610, 2440], decay: 0.06, gain: 0.09 });
  clickVoice(ac, noise, out, { t0: t0 + 0.19, dur: 0.012, gain: 0.22, freq: 2600, q: 1.7, ringDecay: 0.04 });
  noiseVoice(ac, noise, out, {
    t0: t0 + 0.2, dur: 0.09, gain: 0.10, type: 'bandpass', freq: 3200, q: 1.6, attack: 0.01, linear: true,
  });
}

/** Shouldering / lowering the weapon: cloth, sling, a soft mechanical settle. */
export function adsMove(sc, into) {
  const { ac, noise, t0, out } = sc;
  noiseVoice(ac, noise, out, {
    t0, dur: 0.14, gain: 0.10,
    type: 'bandpass', freq: into ? 2600 : 1800, freqTo: into ? 900 : 2400,
    q: 0.7, hp: 400, attack: 0.02, linear: true,
  });
  ringVoice(ac, out, {
    t0: t0 + (into ? 0.09 : 0.02), freqs: [1900, 3100], decay: 0.02, gain: 0.05,
  });
}
