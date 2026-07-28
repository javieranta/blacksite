/**
 * OWNER: audio agent.
 * Procedural voice — the squad barks the AI already calls ('bark_contact',
 * 'bark_flank', 'bark_suppress', 'bark_grenade', 'bark_reload', 'bark_death').
 *
 * These are not words and are not meant to be. They are a source-filter model of
 * shouted speech: a buzzy glottal source at a shouting fundamental, driven
 * through three resonant formant filters whose centres move per syllable, then
 * squeezed through a radio channel (band-limited 340 Hz - 2.9 kHz, driven into
 * soft clipping, topped and tailed with squelch). The result reads as "someone
 * on the net just called something out" without a single recorded syllable —
 * which is exactly the register the game wants and is not a licensing risk.
 *
 * A death bark skips the radio chain: it is a body, not a transmission.
 */
import { envGain, noiseVoice, softClipCurve, vary } from './Synth.js';

/**
 * f0      : shouting fundamental, Hz
 * syl     : [duration, pitchScale, formantSet] per syllable
 * formants: index into FORMANTS
 * gap     : silence between syllables
 */
const FORMANTS = [
  [700, 1220, 2600],   // open   "ah"
  [430, 1980, 2790],   // front  "eh"
  [320, 2300, 3000],   // close  "ee"
  [560, 900, 2500],    // back   "oh"
  [270, 850, 2240],    // closed "oo"
];

const BARKS = {
  bark_contact:  { f0: 158, drive: 2.6, gain: 0.46, syl: [[0.13, 1.0, 0], [0.10, 1.18, 1], [0.19, 0.86, 3]] },
  bark_flank:    { f0: 146, drive: 2.3, gain: 0.40, syl: [[0.11, 0.95, 1], [0.15, 1.10, 0], [0.12, 0.88, 4]] },
  bark_suppress: { f0: 168, drive: 3.0, gain: 0.48, syl: [[0.16, 1.12, 0], [0.13, 0.94, 3]] },
  bark_grenade:  { f0: 186, drive: 3.2, gain: 0.52, syl: [[0.10, 1.22, 2], [0.20, 1.02, 0]] },
  bark_reload:   { f0: 132, drive: 2.0, gain: 0.34, syl: [[0.12, 0.98, 1], [0.10, 1.06, 4], [0.14, 0.86, 3]] },
  bark_death:    { f0: 108, drive: 1.4, gain: 0.50, radio: false, syl: [[0.22, 0.9, 0], [0.30, 0.62, 4]] },
};

let CURVE = null;

export function isBark(name) {
  return name.startsWith('bark_');
}

export function bark(sc, name) {
  const spec = BARKS[name] ?? BARKS.bark_contact;
  const { ac, noise, t0, out } = sc;
  const pitch = (sc.pitch ?? 1) * vary(0.05);
  const radio = spec.radio !== false;

  // ---- channel ------------------------------------------------------------
  let head = ac.createGain();
  head.gain.value = spec.gain;
  if (radio) {
    if (!CURVE) CURVE = softClipCurve(1024, 2.2);
    const hp = ac.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 340; hp.Q.value = 0.9;
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 2900; lp.Q.value = 1.1;
    const shaper = ac.createWaveShaper();
    shaper.curve = CURVE;
    const drive = ac.createGain();
    drive.gain.value = spec.drive;
    head.connect(drive); drive.connect(hp); hp.connect(lp); lp.connect(shaper); shaper.connect(out);
  } else {
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 2200; lp.Q.value = 0.7;
    head.connect(lp); lp.connect(out);
  }

  // ---- squelch ------------------------------------------------------------
  let total = 0;
  for (let i = 0; i < spec.syl.length; i++) total += spec.syl[i][0] + 0.045;
  if (radio) {
    noiseVoice(ac, noise, out, {
      t0, dur: 0.028, gain: 0.05, type: 'bandpass', freq: 2100, q: 1.4, attack: 0.001,
    });
    noiseVoice(ac, noise, out, {
      t0: t0 + total + 0.02, dur: 0.05, gain: 0.045,
      type: 'bandpass', freq: 1700, freqTo: 900, q: 1.2, attack: 0.002,
    });
  }

  // ---- syllables ----------------------------------------------------------
  let t = t0 + (radio ? 0.035 : 0.005);
  for (let s = 0; s < spec.syl.length; s++) {
    const [dur, pScale, fIdx] = spec.syl[s];
    const f = FORMANTS[fIdx];
    const base = spec.f0 * pScale * pitch;

    const osc = ac.createOscillator();
    osc.type = 'sawtooth';
    // Shouted speech falls in pitch across a syllable; the drop is what makes
    // it read as a shout rather than a hum.
    osc.frequency.setValueAtTime(base * 1.06, t);
    osc.frequency.exponentialRampToValueAtTime(base * 0.88, t + dur);

    const env = envGain(ac, t, 1, 0.012, dur, true);
    osc.connect(env);

    for (let k = 0; k < 3; k++) {
      const bp = ac.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = f[k] * (0.97 + Math.random() * 0.06);
      bp.Q.value = 5 + k * 3;
      const g = ac.createGain();
      g.gain.value = [1, 0.55, 0.3][k];
      env.connect(bp); bp.connect(g); g.connect(head);
    }
    // Breath — real shouting is not a pure buzz.
    noiseVoice(ac, noise, head, {
      t0: t, dur, gain: 0.09, type: 'bandpass', freq: f[1], q: 2.2, attack: 0.02, linear: true,
    });

    osc.start(t);
    osc.stop(t + dur + 0.03);
    t += dur + 0.045;
  }
}
