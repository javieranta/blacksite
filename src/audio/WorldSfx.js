/**
 * OWNER: audio agent.
 * Everything that is not a gunshot: bullet impacts per surface, footsteps per
 * surface, ejected brass, explosions, rounds passing close, and the dry UI cues.
 *
 * Surface voices are built from the same table the FX and ballistics systems
 * read (Constants.SURFACES) so a surface that penetrates easily also sounds soft,
 * and one that sparks also rings. The per-surface tables below add the acoustic
 * information that table does not carry: resonant frequencies and decay times.
 */
import { SURFACES } from '../core/Constants.js';
import { noiseVoice, toneVoice, ringVoice, clickVoice, vary } from './Synth.js';

/**
 * band  : centre frequency of the impact's noise body
 * q     : how resonant / "tuned" that body is
 * dur    : body decay
 * ring  : inharmonic partials that keep ringing after the hit (empty = dead)
 * ringT : ring decay
 * thumpF: pitched low component (0 = none)
 * step  : { band, q, dur, gain } for footfalls on this surface
 */
const VOICES = {
  concrete: { band: 1750, q: 1.0, dur: 0.055, ring: [], ringT: 0, thumpF: 128, gain: 0.60,
    step: { band: 2400, q: 1.1, dur: 0.045, gain: 0.30, thumpF: 95 } },
  metal:    { band: 3100, q: 1.4, dur: 0.045, ring: [1620, 2740, 4310, 6120], ringT: 0.20, thumpF: 180, gain: 0.62,
    step: { band: 2900, q: 1.6, dur: 0.05, gain: 0.32, thumpF: 150, ring: [1180, 2050, 3260], ringT: 0.13 } },
  wood:     { band: 900, q: 1.5, dur: 0.075, ring: [420, 760, 1310], ringT: 0.055, thumpF: 105, gain: 0.55,
    step: { band: 1250, q: 1.7, dur: 0.06, gain: 0.29, thumpF: 88, ring: [340, 610], ringT: 0.045 } },
  dirt:     { band: 620, q: 0.7, dur: 0.09, ring: [], ringT: 0, thumpF: 82, gain: 0.48,
    step: { band: 1100, q: 0.6, dur: 0.075, gain: 0.26, thumpF: 70 } },
  sand:     { band: 3900, q: 0.5, dur: 0.13, ring: [], ringT: 0, thumpF: 0, gain: 0.40,
    step: { band: 4200, q: 0.45, dur: 0.11, gain: 0.24, thumpF: 0 } },
  glass:    { band: 5200, q: 1.2, dur: 0.10, ring: [2960, 4870, 7240, 9100], ringT: 0.16, thumpF: 0, gain: 0.58,
    step: { band: 5400, q: 1.3, dur: 0.09, gain: 0.30, thumpF: 0, ring: [3300, 5600], ringT: 0.11 } },
  fabric:   { band: 1050, q: 0.6, dur: 0.055, ring: [], ringT: 0, thumpF: 74, gain: 0.34,
    step: { band: 1400, q: 0.5, dur: 0.05, gain: 0.18, thumpF: 62 } },
  flesh:    { band: 480, q: 0.9, dur: 0.065, ring: [], ringT: 0, thumpF: 96, gain: 0.62,
    step: { band: 700, q: 0.7, dur: 0.05, gain: 0.20, thumpF: 80 } },
  water:    { band: 2400, q: 0.55, dur: 0.16, ring: [], ringT: 0, thumpF: 0, gain: 0.5,
    step: { band: 2100, q: 0.5, dur: 0.14, gain: 0.30, thumpF: 0 } },
};

const FALLBACK = VOICES.concrete;

export function surfaceVoice(surface) {
  return VOICES[surface] ?? FALLBACK;
}

/** Bullet striking a surface. */
export function impact(sc, surface) {
  const v = surfaceVoice(surface);
  const s = SURFACES[surface] ?? SURFACES.concrete;
  const { ac, noise, t0, out } = sc;
  const hard = s.hardness;
  const P = sc.pitch ?? 1;

  // Contact transient: brightness and shortness track hardness.
  noiseVoice(ac, noise, out, {
    t0, dur: 0.004 + (1 - hard) * 0.006, gain: 0.55 * v.gain,
    type: 'highpass', freq: (2600 + hard * 5200) * P, attack: 0.0002,
  });
  // Body.
  noiseVoice(ac, noise, out, {
    t0: t0 + 0.0008, dur: v.dur * vary(0.18), gain: v.gain,
    type: 'bandpass', freq: v.band * P * vary(0.1), freqTo: v.band * P * 0.5,
    q: v.q, attack: 0.0004,
  });
  // Low thump — mass behind the surface.
  if (v.thumpF) {
    toneVoice(ac, out, {
      t0, dur: 0.05 + (1 - hard) * 0.05, f0: v.thumpF * P * vary(0.08), f1: v.thumpF * P * 0.45,
      gain: 0.26 * v.gain, type: 'sine', attack: 0.0008,
    });
  }
  // Resonance for materials that ring.
  if (v.ring.length) {
    ringVoice(ac, out, {
      t0: t0 + 0.001, freqs: v.ring, decay: v.ringT,
      gain: 0.22 * v.gain, detune: P * vary(0.03),
    });
  }
  // Spall / dust puff for soft, dusty materials.
  if (s.dust > 0.5) {
    noiseVoice(ac, noise, out, {
      t0: t0 + 0.006, dur: 0.06 + s.dust * 0.09, gain: 0.10 * s.dust,
      type: 'bandpass', freq: 4200, q: 0.5, attack: 0.01, linear: true,
    });
  }
  // Ricochet whine off hard, sparking surfaces.
  if (s.sparks > 0.4 && Math.random() < 0.45) {
    toneVoice(ac, out, {
      t0: t0 + 0.004, dur: 0.17 * vary(0.3), f0: 3400 * vary(0.2), f1: 900,
      gain: 0.11, type: 'sine', attack: 0.002,
    });
  }
  if (surface === 'glass') {
    // Shards falling away after the hole is punched.
    for (let i = 0; i < 4; i++) {
      clickVoice(ac, noise, out, {
        t0: t0 + 0.04 + i * 0.045 * vary(0.5), dur: 0.006, gain: 0.07,
        freq: 6400 * vary(0.25), q: 3.0, freqs: [4900, 7600, 10200], ringDecay: 0.03,
      });
    }
  }
}

/** Round striking a body. Wetter, duller, with a bone crack on a headshot. */
export function fleshHit(sc, headshot) {
  const { ac, noise, t0, out } = sc;
  noiseVoice(ac, noise, out, {
    t0, dur: 0.035, gain: 0.62, type: 'bandpass', freq: 520, freqTo: 230, q: 0.85, attack: 0.0004,
  });
  toneVoice(ac, out, { t0, dur: 0.07, f0: 104, f1: 46, gain: 0.34, type: 'sine', lp: 400 });
  noiseVoice(ac, noise, out, {
    t0: t0 + 0.002, dur: 0.09, gain: 0.20, type: 'bandpass', freq: 1650, q: 0.6, attack: 0.004,
  });
  if (headshot) {
    noiseVoice(ac, noise, out, {
      t0, dur: 0.012, gain: 0.5, type: 'bandpass', freq: 3900, q: 1.3, hp: 1800, attack: 0.0002,
    });
    ringVoice(ac, out, { t0, freqs: [1240, 2180, 3460], decay: 0.045, gain: 0.14 });
  }
}

/** Footfall. Weight scales the low component, surface picks the character. */
export function footstep(sc, surface, weight = 1) {
  const v = surfaceVoice(surface);
  const st = v.step;
  const { ac, noise, t0, out } = sc;
  const P = sc.pitch ?? 1;
  noiseVoice(ac, noise, out, {
    t0, dur: st.dur * vary(0.2), gain: st.gain * weight,
    type: 'bandpass', freq: st.band * P * vary(0.12), freqTo: st.band * P * 0.45, q: st.q,
    attack: 0.0016, lp: 9000,
  });
  if (st.thumpF) {
    toneVoice(ac, out, {
      t0, dur: 0.055, f0: st.thumpF * P * vary(0.1), f1: st.thumpF * P * 0.5,
      gain: 0.20 * weight, type: 'sine', attack: 0.002,
    });
  }
  if (st.ring) {
    ringVoice(ac, out, {
      t0, freqs: st.ring, decay: st.ringT, gain: 0.07 * weight, detune: P * vary(0.04),
    });
  }
  // Gear: sling, magazines, plate carrier. This is most of what makes a footstep
  // read as a soldier rather than a shoe.
  noiseVoice(ac, noise, out, {
    t0: t0 + 0.018 * vary(0.4), dur: 0.05, gain: 0.055 * weight,
    type: 'bandpass', freq: 5200, q: 1.4, attack: 0.006,
  });
}

/**
 * Ricochet. Ballistics emits 'hit:ricochet' when a round deflects instead of
 * penetrating, and the descending whine of a tumbling, spinning bullet is one of
 * the most recognisable sounds in the genre.
 */
export function ricochet(sc) {
  const { ac, noise, t0, out } = sc;
  const f = 3600 * vary(0.28);
  noiseVoice(ac, noise, out, {
    t0, dur: 0.008, gain: 0.42, type: 'highpass', freq: 4200, attack: 0.0002,
  });
  toneVoice(ac, out, {
    t0: t0 + 0.002, dur: 0.34 * vary(0.35), f0: f, f1: f * 0.22,
    gain: 0.20, type: 'sine', attack: 0.0016,
  });
  // A second, detuned partial makes the whine warble the way a spinning round does.
  toneVoice(ac, out, {
    t0: t0 + 0.004, dur: 0.26 * vary(0.3), f0: f * 1.49, f1: f * 0.36,
    gain: 0.10, type: 'sine', attack: 0.003,
  });
  noiseVoice(ac, noise, out, {
    t0: t0 + 0.003, dur: 0.16, gain: 0.10,
    type: 'bandpass', freq: f * 0.8, freqTo: f * 0.25, q: 4.0, attack: 0.004, linear: true,
  });
}

/** Ejected brass hitting the ground: two or three bright metallic bounces. */
export function shellDrop(sc, calibre) {
  const { ac, noise, t0, out } = sc;
  const base = calibre === '9mm' ? 5400 : calibre === '7.62' ? 3600 : 4400;
  let t = t0;
  let amp = 0.16;
  for (let i = 0; i < 4; i++) {
    const f = base * vary(0.14);
    clickVoice(ac, noise, out, {
      t0: t, dur: 0.007, gain: amp, freq: f, q: 2.6,
      freqs: [f * 0.62, f, f * 1.47, f * 2.13], ringDecay: 0.075 * (1 - i * 0.18),
    });
    t += (0.055 + i * 0.038) * vary(0.25);
    amp *= 0.52;
  }
}

/** A round passing close enough to hear the shockwave. Doppler in the sweep. */
export function whizby(sc) {
  const { ac, noise, t0, out } = sc;
  noiseVoice(ac, noise, out, {
    t0, dur: 0.085, gain: 0.30,
    type: 'bandpass', freq: 2600 * vary(0.2), freqTo: 620, q: 3.2, attack: 0.008, linear: true,
  });
  toneVoice(ac, out, {
    t0: t0 + 0.006, dur: 0.06, f0: 1500 * vary(0.15), f1: 480, gain: 0.09, type: 'sine', attack: 0.005,
  });
}

/**
 * Explosion. Sub sweep for the pressure wave, a wide noise body, debris, and a
 * long dark tail. The caller ducks the rest of the mix around it.
 */
export function explosion(sc, radius = 6) {
  const { ac, noise, t0, out } = sc;
  const size = Math.min(2.2, radius / 6);
  toneVoice(ac, out, {
    t0, dur: 0.75 * size, f0: 96 * (1 / size), f1: 22, gain: 0.95, type: 'sine', attack: 0.004,
  });
  noiseVoice(ac, noise, out, {
    t0, dur: 0.02, gain: 0.85, type: 'highpass', freq: 2200, attack: 0.0004,
  });
  noiseVoice(ac, noise, out, {
    t0: t0 + 0.002, dur: 0.34 * size, gain: 0.8,
    type: 'bandpass', freq: 420, freqTo: 120, q: 0.5, lp: 5200, lpTo: 700, attack: 0.002,
  });
  noiseVoice(ac, noise, out, {
    t0: t0 + 0.03, dur: 1.9 * size, gain: 0.34,
    type: 'lowpass', freq: 1400, freqTo: 90, q: 0.4, hp: 45, attack: 0.05,
  });
  // Debris raining down.
  for (let i = 0; i < 9; i++) {
    clickVoice(ac, noise, out, {
      t0: t0 + 0.12 + Math.random() * 0.7 * size, dur: 0.008, gain: 0.05,
      freq: 2400 * vary(0.5), q: 2.0, ringDecay: 0.02,
    });
  }
}

/** Non-spatial UI confirmation: two-tone, dry, short. Kill variant drops a fifth. */
export function hitmarker(sc, kind = 'hit') {
  const { ac, noise, t0, out } = sc;
  const f = kind === 'kill' ? 1180 : kind === 'head' ? 2450 : 1900;
  clickVoice(ac, noise, out, { t0, dur: 0.006, gain: 0.16, freq: f, q: 3.4, ring: false });
  ringVoice(ac, out, {
    t0, freqs: kind === 'kill' ? [720, 1080, 1620] : [f, f * 1.5],
    decay: kind === 'kill' ? 0.14 : 0.05, gain: kind === 'kill' ? 0.13 : 0.09,
  });
  if (kind === 'kill') {
    ringVoice(ac, out, { t0: t0 + 0.075, freqs: [960, 1440], decay: 0.11, gain: 0.09 });
  }
}

/** Body hitting the deck. */
export function bodyFall(sc) {
  const { ac, noise, t0, out } = sc;
  toneVoice(ac, out, { t0, dur: 0.16, f0: 78, f1: 34, gain: 0.4, type: 'sine', attack: 0.004 });
  noiseVoice(ac, noise, out, {
    t0, dur: 0.13, gain: 0.28, type: 'bandpass', freq: 380, q: 0.7, lp: 2600, attack: 0.003,
  });
  noiseVoice(ac, noise, out, {
    t0: t0 + 0.02, dur: 0.1, gain: 0.08, type: 'bandpass', freq: 4600, q: 1.2, attack: 0.008,
  });
}
