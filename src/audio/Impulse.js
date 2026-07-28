/**
 * OWNER: audio agent.
 * Procedural impulse responses for the convolution reverbs. No IR files — each
 * response is synthesised from a noise tail, a time-varying one-pole low-pass
 * (so the tail darkens as it decays, the way real air and absorption behave) and
 * a set of discrete early-reflection taps that give the space its size and
 * character before the diffuse tail arrives.
 */

/** Rooms the mixer can be in. Values are physically motivated, then tuned by ear. */
export const ZONES = {
  /** Open concrete yard between tall structures: hard slapback, long bright tail. */
  exterior: {
    seconds: 2.6,
    rt60: 1.45,
    predelay: 0.019,
    hf0: 8200,
    hf1: 900,
    density: 0.55,
    wet: 0.30,
    taps: [
      [0.021, 0.62, -0.7], [0.034, 0.48, 0.55], [0.052, 0.40, 0.2],
      [0.078, 0.31, -0.35], [0.113, 0.24, 0.7], [0.168, 0.17, -0.15],
      [0.242, 0.11, 0.4],
    ],
  },
  /** Enclosed room / corridor: dense early field, dark and short. */
  interior: {
    seconds: 1.6,
    rt60: 0.78,
    predelay: 0.005,
    hf0: 5600,
    hf1: 620,
    density: 0.95,
    wet: 0.46,
    taps: [
      [0.0061, 0.70, -0.5], [0.0104, 0.62, 0.45], [0.0152, 0.55, 0.15],
      [0.0209, 0.47, -0.6], [0.0284, 0.40, 0.35], [0.0371, 0.33, -0.2],
      [0.0488, 0.26, 0.6], [0.0642, 0.20, -0.4], [0.0851, 0.15, 0.1],
    ],
  },
  /**
   * Not a room — the "rolling thunder" bus. Only the distant-report layer feeds
   * this, and it is what turns a far gunshot into a crack followed by a long
   * decay bouncing off everything in the compound.
   */
  distant: {
    seconds: 3.6,
    rt60: 2.55,
    predelay: 0.045,
    hf0: 2300,
    hf1: 240,
    density: 0.4,
    wet: 1.0,
    taps: [
      [0.11, 0.44, -0.8], [0.19, 0.36, 0.7], [0.31, 0.28, -0.3],
      [0.47, 0.20, 0.5], [0.68, 0.13, -0.6], [0.95, 0.08, 0.25],
    ],
  },
};

function onePoleCoeff(cutoff, sampleRate) {
  return 1 - Math.exp((-2 * Math.PI * cutoff) / sampleRate);
}

/**
 * Build a stereo impulse response for one zone. The two channels use different
 * noise sequences so the tail is properly wide instead of a mono blob sitting in
 * the middle of the image.
 */
export function buildImpulse(ac, zone, seed = 0x2545f491) {
  const sr = ac.sampleRate;
  const len = Math.max(64, Math.floor(sr * zone.seconds));
  const buf = ac.createBuffer(2, len, sr);
  const decayK = -6.907755 / (zone.rt60 * sr); // ln(1e-3) over RT60 in samples
  const preDelaySamples = Math.floor(zone.predelay * sr);

  let s = seed >>> 0;
  const rnd = () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };

  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    let lp = 0;
    let hp = 0;
    // Diffuse tail: gated noise (density < 1 thins it into discrete grains,
    // which is what makes a big outdoor space sound sparse and slappy).
    for (let i = preDelaySamples; i < len; i++) {
      const t = (i - preDelaySamples) / sr;
      const env = Math.exp(decayK * (i - preDelaySamples));
      let x = rnd() * 2 - 1;
      if (zone.density < 1 && rnd() > zone.density) x *= 0.15;
      x *= env;
      // Time-varying low-pass: cutoff glides hf0 -> hf1 across the tail.
      const k = Math.min(1, t / zone.seconds);
      const cutoff = zone.hf0 * Math.pow(zone.hf1 / zone.hf0, k);
      const a = onePoleCoeff(cutoff, sr);
      lp += a * (x - lp);
      // Gentle high-pass so convolution does not pump the sub band.
      hp += 0.0016 * (lp - hp);
      d[i] = lp - hp;
    }
    // Early reflections on top — these carry the geometry of the space.
    for (let k = 0; k < zone.taps.length; k++) {
      const [time, gain, pan] = zone.taps[k];
      const idx = preDelaySamples + Math.floor(time * sr);
      if (idx + 8 >= len) continue;
      const side = c === 0 ? 1 - Math.max(0, pan) : 1 + Math.min(0, pan);
      const amp = gain * (0.55 + 0.45 * side);
      // A tap is not a single sample: smear it over ~1.2ms so it reads as a
      // reflection off a real wall rather than a click.
      const smear = Math.floor(sr * 0.0012);
      for (let j = 0; j < smear; j++) {
        const w = 1 - j / smear;
        d[idx + j] += (rnd() * 2 - 1) * amp * w * w;
      }
    }
  }

  // Normalise to a predictable send level so zone switches do not jump.
  let peak = 0;
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) { const a = Math.abs(d[i]); if (a > peak) peak = a; }
  }
  if (peak > 0) {
    const norm = 0.72 / peak;
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] *= norm;
    }
  }
  return buf;
}
