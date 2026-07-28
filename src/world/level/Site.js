import { rng } from './GeoKit.js';

/**
 * OWNER: level agent.
 * Site datum. Every module in the level reads its floor heights and its extents
 * from here, so a change of level propagates instead of drifting.
 *
 * Levels:  service yard / hall floor  y = -0.35
 *          courtyard + north yard     y =  0.00
 *          catwalk / gantry deck      y =  4.70
 */
export const L = {
  yard: -0.35,
  courtY: 0.0,
  deck: 4.70,
  wallH: 4.6,
  perim: { x0: -42, x1: 52, z0: -26, z1: 60 },
  court: { x0: -3, x1: 26, z0: 8, z1: 42 },
};

/** Tile a rectangle with chamfered paving pads — real joints, no infinite plane. */
export function pave(b, x0, x1, z0, z1, o = {}) {
  const cell = o.cell ?? 10;
  const y = o.y ?? 0;
  const nx = Math.max(1, Math.round((x1 - x0) / cell));
  const nz = Math.max(1, Math.round((z1 - z0) / cell));
  const r = rng(o.seed ?? 991);
  const t = o.thick ?? 0.5;
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < nz; j++) {
      const w = (x1 - x0) / nx, d = (z1 - z0) / nz;
      const cx = x0 + (i + 0.5) * w, cz = z0 + (j + 0.5) * d;
      const k = r();
      const mat = o.mat ?? (k < 0.22 ? 'concrete_wet' : 'concrete');
      b.box(mat, cx, y - t / 2, cz, w - 0.05, t, d - 0.05, {
        zone: o.zone ?? 'ground', bevel: 0.05, seg: o.seg ?? 6,
        jitter: o.jitter ?? 0.012, jitterFreq: 0.35, cast: false,
      });
    }
  }
}
