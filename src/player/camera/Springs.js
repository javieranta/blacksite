/**
 * OWNER: camera-feel agent.
 *
 * Two integrators, because a camera needs both kinds of motion:
 *
 *  - `smoothDamp` — the critically damped, unconditionally stable exponential
 *    approach used by every DCC tool. No overshoot, no instability at any dt.
 *    Right for FOV, amplitudes and blends.
 *  - `springStep` — a genuinely underdamped mass-spring, substepped so it stays
 *    stable at a 100 ms frame. Right for recoil and sway, where the overshoot
 *    *is* the effect.
 *
 * Both operate on plain `{ x, v }` records allocated once by the caller.
 */

const MAX_SUB = 1 / 240;

/** @typedef {{x:number, v:number}} SpringState */

/**
 * Critically damped approach. `smoothTime` is roughly the time to cover most of
 * the distance. Stable for any dt.
 * @param {SpringState} s
 */
export function smoothDamp(s, target, smoothTime, dt) {
  if (dt <= 0) return s.x;
  const omega = 2 / Math.max(0.0001, smoothTime);
  const x = omega * dt;
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = s.x - target;
  const temp = (s.v + omega * change) * dt;
  s.v = (s.v - omega * temp) * exp;
  s.x = target + (change + temp) * exp;
  if (Math.abs(s.x - target) < 1e-6 && Math.abs(s.v) < 1e-5) { s.x = target; s.v = 0; }
  return s.x;
}

/**
 * Mass-spring-damper toward `target`, substepped at 240 Hz so a long frame
 * cannot blow it up. `damping` is the damping ratio: < 1 overshoots.
 * @param {SpringState} s
 */
export function springStep(s, target, stiffness, damping, dt) {
  const c = 2 * Math.sqrt(stiffness) * damping;
  let left = dt;
  let guard = 0;
  while (left > 1e-6 && guard++ < 48) {
    const h = left > MAX_SUB ? MAX_SUB : left;
    left -= h;
    s.v += (-(s.x - target) * stiffness - s.v * c) * h;
    s.x += s.v * h;
  }
  return s.x;
}

/** Frame-rate-correct exponential lerp toward a target. */
export function approach(current, target, rate, dt) {
  return target + (current - target) * Math.exp(-rate * dt);
}
