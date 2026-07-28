/**
 * OWNER: ui agent.
 * Hand-authored vector numerals for the ammo readout.
 *
 * The build ships zero external assets, which means zero webfonts, which means
 * the one number the player reads under pressure cannot be trusted to a font
 * that may or may not exist on the machine. So the digits are drawn: a stencil
 * numeral set on a 100x160 grid, stroked rather than filled, with every corner
 * chamfered at 45 degrees the way stencil-cut signage is. Stroked geometry also
 * keeps the weight visually identical to the 1px hairlines elsewhere in the HUD.
 */

/** Path data per digit, drawn on viewBox "0 0 100 160". */
export const DIGIT_PATHS = [
  /* 0 */ 'M32 12 H68 L86 30 V130 L68 148 H32 L14 130 V30 Z',
  /* 1 */ 'M24 40 L52 12 V148 M22 148 H84',
  /* 2 */ 'M14 34 L34 12 H66 L86 32 V56 L16 148 H86',
  /* 3 */ 'M16 12 H84 L50 66 H66 L86 86 V128 L68 148 H32 L14 130',
  /* 4 */ 'M64 148 V16 L14 104 H86',
  /* 5 */ 'M86 12 H30 L16 66 H60 L86 88 V128 L66 148 H30 L14 134',
  /* 6 */ 'M78 14 H36 L14 40 V130 L32 148 H68 L86 130 V96 L68 78 H28 L14 92',
  /* 7 */ 'M14 12 H86 L44 148',
  /* 8 */ 'M32 12 H68 L86 30 V60 L68 78 H32 L14 60 V30 Z M32 78 L14 96 V130 L32 148 H68 L86 130 V96 L68 78',
  /* 9 */ 'M22 148 H64 L86 124 V30 L68 12 H32 L14 30 V64 L32 82 H72 L86 68',
];

const SVG_NS = 'http://www.w3.org/2000/svg';

/** One digit slot: an <svg> whose single path is swapped as the value changes. */
export function makeDigit() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 100 160');
  svg.setAttribute('preserveAspectRatio', 'xMidYMax meet');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', DIGIT_PATHS[0]);
  svg.appendChild(path);
  return { svg, path, value: -1 };
}

/** Sets a slot to a digit 0-9, or hides it when `digit` is null. */
export function setDigit(slot, digit) {
  if (digit === null) {
    if (slot.value !== null) { slot.value = null; slot.svg.style.display = 'none'; }
    return;
  }
  if (slot.value === digit) return;
  slot.value = digit;
  slot.svg.style.display = '';
  slot.path.setAttribute('d', DIGIT_PATHS[digit]);
}

export { SVG_NS };
