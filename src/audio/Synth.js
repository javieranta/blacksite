/**
 * OWNER: audio agent.
 * Low-level WebAudio voice primitives. Everything here is synthesis — there is
 * not a single sample in the project. A "voice" is a short-lived chain
 * (source -> filters -> gain) scheduled on the audio clock and left to be
 * collected once it has finished; that is the idiomatic WebAudio one-shot.
 *
 * All builders take an absolute start time `t0` on the AudioContext clock so a
 * multi-layer gunshot lines up to the sample rather than to the render loop.
 */

/** exponentialRampToValueAtTime cannot reach 0; this is our audible floor. */
export const FLOOR = 1e-4;

/**
 * Deterministic white noise, two channels, decorrelated. One buffer is shared
 * by every noise voice in the game and read from a random offset, which is both
 * cheaper and more varied than generating noise per shot.
 */
export function whiteNoiseBuffer(ac, seconds = 3) {
  const len = Math.max(1, Math.floor(ac.sampleRate * seconds));
  const buf = ac.createBuffer(2, len, ac.sampleRate);
  let s = 0x9e3779b9;
  const rnd = () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) d[i] = rnd() * 2 - 1;
  }
  return buf;
}

/**
 * A soft-knee tanh-ish curve for the safety clipper on the master bus. Even
 * with a limiter in front, a dozen simultaneous impacts can overshoot; this
 * turns the overshoot into harmonic dirt instead of a digital crack.
 */
export function softClipCurve(samples = 2048, drive = 1.6) {
  const c = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    const x = (i / (samples - 1)) * 2 - 1;
    c[i] = Math.tanh(x * drive) / Math.tanh(drive);
  }
  return c;
}

/** Percussive gain envelope: near-instant attack, exponential decay. */
export function envGain(ac, t0, peak, attack, decay, linear = false) {
  const g = ac.createGain();
  const p = Math.max(FLOOR * 2, peak);
  g.gain.setValueAtTime(FLOOR, t0);
  g.gain.linearRampToValueAtTime(p, t0 + Math.max(0.0002, attack));
  if (linear) g.gain.linearRampToValueAtTime(0, t0 + attack + decay);
  else g.gain.exponentialRampToValueAtTime(FLOOR, t0 + attack + decay);
  return g;
}

function biquad(ac, type, freq, q, t0, freqTo, dur) {
  const f = ac.createBiquadFilter();
  f.type = type;
  f.Q.value = q;
  f.frequency.setValueAtTime(Math.max(20, freq), t0);
  if (freqTo && freqTo !== freq) {
    f.frequency.exponentialRampToValueAtTime(Math.max(20, freqTo), t0 + Math.max(0.005, dur));
  }
  return f;
}

/**
 * Filtered noise burst.
 * o: { t0, dur, gain, attack, type, freq, freqTo, q, hp, hpTo, lp, rate }
 * Returns the tail gain node so the caller can also feed a reverb send.
 */
export function noiseVoice(ac, noise, dest, o) {
  const t0 = o.t0;
  const dur = o.dur;
  const src = ac.createBufferSource();
  src.buffer = noise;
  src.playbackRate.value = o.rate ?? 1;
  // Looping means a 2s explosion tail is not silently truncated by the length of
  // the shared noise buffer, and white noise has no audible loop point.
  src.loop = true;
  src.loopStart = 0;
  src.loopEnd = noise.duration;

  let node = src;
  if (o.hp) {
    const hp = biquad(ac, 'highpass', o.hp, o.hpQ ?? 0.7, t0, o.hpTo, dur);
    node.connect(hp); node = hp;
  }
  if (o.freq) {
    const bp = biquad(ac, o.type ?? 'bandpass', o.freq, o.q ?? 1, t0, o.freqTo, dur);
    node.connect(bp); node = bp;
  }
  if (o.lp) {
    const lp = biquad(ac, 'lowpass', o.lp, o.lpQ ?? 0.6, t0, o.lpTo, dur);
    node.connect(lp); node = lp;
  }

  const g = envGain(ac, t0, o.gain ?? 0.5, o.attack ?? 0.0005, dur, o.linear);
  node.connect(g);
  g.connect(dest);

  src.start(t0, (o.offset ?? Math.random()) * noise.duration);
  src.stop(t0 + dur + 0.08);
  return g;
}

/**
 * Pitched voice with an exponential frequency sweep — the "boom" under a
 * gunshot, the sub of an explosion, the whine of a ricochet.
 * o: { t0, dur, f0, f1, gain, type, attack, q, lp }
 */
export function toneVoice(ac, dest, o) {
  const t0 = o.t0;
  const dur = o.dur;
  const osc = ac.createOscillator();
  osc.type = o.type ?? 'sine';
  osc.frequency.setValueAtTime(Math.max(15, o.f0), t0);
  if (o.f1 && o.f1 !== o.f0) {
    osc.frequency.exponentialRampToValueAtTime(Math.max(15, o.f1), t0 + dur);
  }
  let node = osc;
  if (o.lp) {
    const lp = biquad(ac, 'lowpass', o.lp, o.q ?? 0.7, t0, o.lpTo, dur);
    node.connect(lp); node = lp;
  }
  const g = envGain(ac, t0, o.gain ?? 0.3, o.attack ?? 0.001, dur, o.linear);
  node.connect(g);
  g.connect(dest);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
  return g;
}

/**
 * Metallic resonance: a handful of inharmonic sine partials with independent
 * decays. This is what makes an ejection port, a shell casing and a steel plate
 * sound like metal rather than like filtered noise.
 */
export function ringVoice(ac, dest, o) {
  const out = ac.createGain();
  out.gain.value = o.gain ?? 0.2;
  out.connect(dest);
  const freqs = o.freqs;
  for (let i = 0; i < freqs.length; i++) {
    const decay = (o.decay ?? 0.09) * (1 - i * 0.16);
    if (decay <= 0.005) continue;
    const osc = ac.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freqs[i] * (o.detune ?? 1);
    const g = envGain(ac, o.t0, 1 / (1 + i * 1.35), 0.0004, decay);
    osc.connect(g);
    g.connect(out);
    osc.start(o.t0);
    osc.stop(o.t0 + decay + 0.02);
  }
  return out;
}

/** Short, dry mechanical click — bolt, trigger, magazine catch. */
export function clickVoice(ac, noise, dest, o) {
  const g = noiseVoice(ac, noise, dest, {
    t0: o.t0,
    dur: o.dur ?? 0.012,
    gain: o.gain ?? 0.25,
    type: 'bandpass',
    freq: o.freq ?? 3200,
    q: o.q ?? 1.6,
    hp: 900,
    attack: 0.0003,
  });
  if (o.ring !== false) {
    ringVoice(ac, dest, {
      t0: o.t0,
      freqs: o.freqs ?? [o.freq ?? 3200, (o.freq ?? 3200) * 1.61, (o.freq ?? 3200) * 2.37],
      decay: o.ringDecay ?? 0.03,
      gain: (o.gain ?? 0.25) * 0.35,
    });
  }
  return g;
}

/** Deterministic-ish jitter so repeated cues never sound machine-stamped. */
export function vary(amount) {
  return 1 + (Math.random() * 2 - 1) * amount;
}
