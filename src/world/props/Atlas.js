/**
 * Atlas cell lookup tables. OWNER: props agent.
 *
 * Painters fill the canvas top-down; UV space runs bottom-up (CanvasTexture
 * flips Y), so a painter at canvas row `r` of `rows` lives in UV row
 * `rows - 1 - r`. These tables do that conversion once so no geometry builder
 * has to think about it.
 */

/** 4x4 container atlas — [col, uvRow]. */
export const CRATE = {
  woodA: [0, 3], woodB: [1, 3], woodLid: [2, 3], plywood: [3, 3],
  caseA: [0, 2], caseB: [1, 2], caseLid: [2, 2], cardboard: [3, 2],
  ammoSide: [0, 1], ammoLid: [1, 1], plasticSide: [2, 1], plasticLid: [3, 1],
  pallet: [0, 0], steelPainted: [1, 0], steelRust: [2, 0], whitePlastic: [3, 0],
};

/** 4x4 signage atlas — [col, uvRow]. */
export const SIGN = {
  warning: [0, 3], highVoltage: [1, 3], noEntry: [2, 3], radiation: [3, 3],
  chevron: [0, 2], number07: [1, 2], authorised: [2, 2], bio: [3, 2],
  hazardBand: [0, 1], keepClear: [1, 1], exit: [2, 1], fuel: [3, 1],
  pipeBand: [0, 0], muster: [1, 0], louvre: [2, 0], sector: [3, 0],
};

/** 2x2 drum atlas — [col, uvRow]. */
export const DRUM = {
  diesel: [0, 1], waste: [1, 1], jp8: [0, 0], flam: [1, 0],
};

/** 2x2 foliage atlas — [col, uvRow]. */
export const FOLIAGE = [[0, 1], [1, 1], [0, 0], [1, 0]];
