import { prismG } from './Shapes.js';

/**
 * OWNER: viewmodel agent.
 *
 * MIL-STD-1913 style top rail, built as one continuous mesh with a real
 * cross-section rather than a row of extruded cuboids.
 *
 * The cross-section is what makes it read: a narrow base, a flare out to the
 * widest point, then 45-degree clamping shoulders angling back in to a narrow
 * top flat, with a chamfer at every transition. Seen from the shooter's eye in
 * ADS the rail is a long grazing surface, and those angled shoulders are what
 * break it into three distinct tonal bands instead of one flat grey ladder.
 *
 * The recoil grooves are genuine cuts: the lower body sweeps the full length and
 * carries the groove floor, and each tooth is a separate prism *in the same
 * mesh* whose end caps are the groove walls. One draw call, real geometry.
 */

/** Lower body: base to groove floor. CCW, `[x, y, edgeFlag]`. */
const LOWER = [
  [-0.00740, 0.00000, 0.9],
  [0.00740, 0.00000, 0.9],
  [0.00860, 0.00130, 1.0],
  [0.00980, 0.00340, 1.0],
  [-0.00980, 0.00340, 1.0],
  [-0.00860, 0.00130, 1.0],
];

/** Tooth: groove floor up over the clamping shoulders to the top flat. */
const TOOTH = [
  [-0.00980, 0.00325, 0.35],
  [0.00980, 0.00325, 0.35],
  [0.00980, 0.00400, 1.0],
  [0.00800, 0.00630, 1.0],
  [0.00700, 0.00670, 0.85],
  [-0.00700, 0.00670, 0.85],
  [-0.00800, 0.00630, 1.0],
  [-0.00980, 0.00400, 1.0],
];

export const RAIL_HEIGHT = 0.00670;
export const RAIL_PITCH = 0.01000;
const TOOTH_LEN = 0.00480;

/**
 * @param m Mesher (material already selected by the caller)
 * @param o { y, z0, z1 } rail base height and span in weapon space
 * @returns the z positions of the groove centres, so mounts can drop a recoil
 *          lug into one instead of floating above the rail.
 */
export function buildRail(m, o) {
  const grooves = [];
  prismG(m, { y: o.y, profile: LOWER, z0: o.z0, z1: o.z1 });

  // Teeth run front to back; a partial tooth at the very end looks wrong, so
  // stop as soon as a whole one no longer fits.
  let z = o.z0 + 0.0012;
  let prevEnd = null;
  while (z + TOOTH_LEN <= o.z1 - 0.0012) {
    prismG(m, { y: o.y, profile: TOOTH, z0: z, z1: z + TOOTH_LEN });
    if (prevEnd !== null) grooves.push((prevEnd + z) * 0.5);
    prevEnd = z + TOOTH_LEN;
    z += RAIL_PITCH;
  }
  return grooves;
}

/**
 * A short accessory rail section — used for the offset light mount and the
 * folded front sight base. Same cross-section, so it matches the top rail.
 */
export function buildRailStub(m, o) {
  prismG(m, { x: o.x ?? 0, y: o.y, z: 0, rx: o.rx ?? 0, ry: o.ry ?? 0, rz: o.rz ?? 0,
    profile: LOWER, z0: o.z0, z1: o.z1 });
  let z = o.z0 + 0.0010;
  while (z + TOOTH_LEN <= o.z1 - 0.0010) {
    prismG(m, { x: o.x ?? 0, y: o.y, rx: o.rx ?? 0, ry: o.ry ?? 0, rz: o.rz ?? 0,
      profile: TOOTH, z0: z, z1: z + TOOTH_LEN });
    z += RAIL_PITCH;
  }
}
