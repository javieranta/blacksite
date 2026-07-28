import { shade, rgba } from './Textures.js';
import { Rand } from './Rand.js';

/**
 * The actual paint jobs. Every prop surface in the game is drawn by one of these.
 * OWNER: props agent.
 *
 * Each painter writes three layers:
 *   g  — albedo (sRGB canvas)
 *   hg — height (grayscale; drives the derived normal map)
 *   sg — spec: green = roughness, blue = metalness
 * so a single painter fully specifies a PBR surface with no external input.
 */

/** Fill a rect of the spec layer with explicit roughness/metalness. */
export function spec(sg, x, y, w, h, rough, metal = 0) {
  sg.fillStyle = `rgb(0,${Math.round(rough * 255)},${Math.round(metal * 255)})`;
  sg.fillRect(x, y, w, h);
}

/**
 * Build a full map set from a painter.
 * @param {import('./Textures.js').Textures} T
 */
export function makeSet(T, size, painter, {
  repeat = 1, normalStrength = 2.0, seed = 1,
} = {}) {
  const A = T.canvas(size), H = T.canvas(size), S = T.canvas(size);
  H.g.fillStyle = '#808080'; H.g.fillRect(0, 0, size, size);
  spec(S.g, 0, 0, size, size, 0.85, 0);
  painter({ g: A.g, hg: H.g, sg: S.g, size, s: size, T, rng: new Rand(seed) });
  const field = T.readHeight(H.c);
  return {
    map: T.colorTex(A.c, repeat),
    normalMap: T.normalFromHeight(field, size, normalStrength),
    roughnessMap: T.dataTex(S.c, repeat),
    metalnessMap: T.dataTex(S.c, repeat),
  };
}

/** Run cell painters into a cols×rows atlas. */
export function makeAtlas(T, size, painters, { normalStrength = 1.8, seed = 7, cols = 4 } = {}) {
  const cs = size / cols;
  return makeSet(T, size, ({ g, hg, sg, T: t, rng }) => {
    for (let i = 0; i < painters.length; i++) {
      const col = i % cols, row = (i / cols) | 0;
      const x = col * cs, y = row * cs;
      for (const c of [g, hg, sg]) { c.save(); c.beginPath(); c.rect(x, y, cs, cs); c.clip(); c.translate(x, y); }
      painters[i]({ g, hg, sg, s: cs, T: t, rng: rng.fork(i * 31 + 3) });
      for (const c of [g, hg, sg]) c.restore();
    }
  }, { normalStrength, seed });
}

/* ============================== CRATE ATLAS ============================== */

const woodSide = (colour, text, sub) => ({ g, hg, sg, s, T, rng }) => {
  T.planks(g, hg, 0, 0, s, s, { count: 6, vertical: false, colour, rng });
  spec(sg, 0, 0, s, s, 0.88, 0);
  T.overlay(g, s, T.grain(128, 21, { baseFreq: 10, contrast: 0.5 }), 0.35, 'overlay', s / 256);
  T.overlay(hg, s, T.grain(128, 21, { baseFreq: 10, contrast: 0.6 }), 0.5, 'overlay', s / 256);
  // corner reinforcement bands
  g.fillStyle = 'rgba(60,52,44,0.85)';
  g.fillRect(0, 0, s * 0.055, s); g.fillRect(s * 0.945, 0, s * 0.055, s);
  hg.fillStyle = '#d0d0d0';
  hg.fillRect(0, 0, s * 0.055, s); hg.fillRect(s * 0.945, 0, s * 0.055, s);
  spec(sg, 0, 0, s * 0.055, s, 0.55, 0.75);
  spec(sg, s * 0.945, 0, s * 0.055, s, 0.55, 0.75);
  T.rivets(g, hg, s * 0.027, s * 0.1, s * 0.027, s * 0.9, { count: 5, r: s * 0.012 });
  T.rivets(g, hg, s * 0.972, s * 0.1, s * 0.972, s * 0.9, { count: 5, r: s * 0.012 });
  T.stencil(g, s * 0.12, s * 0.3, s * 0.76, s * 0.2, text, { rng, size: s * 0.13, colour: '#ded6c2' });
  if (sub) T.stencil(g, s * 0.12, s * 0.56, s * 0.76, s * 0.13, sub, { rng, size: s * 0.075, colour: '#c9b98f' });
  T.scuffs(g, 0, 0, s, s, { rng, count: 30 });
  T.streaks(g, 0, 0, s, s, { rng, count: 5, alpha: 0.16 });
  T.groundGrime(g, 0, 0, s, s, 0.22);
};

const caseSide = (colour, text, band) => ({ g, hg, sg, s, T, rng }) => {
  T.fillRamp(g, 0, 0, s, s, shade(colour, 0.12), shade(colour, -0.16));
  spec(sg, 0, 0, s, s, 0.62, 0.15);
  T.overlay(g, s, T.grain(128, 44, { baseFreq: 14, contrast: 0.4 }), 0.3, 'overlay', s / 256);
  // recessed panel
  g.strokeStyle = 'rgba(0,0,0,0.5)'; g.lineWidth = s * 0.012;
  g.strokeRect(s * 0.1, s * 0.12, s * 0.8, s * 0.76);
  hg.fillStyle = '#a8a8a8'; hg.fillRect(0, 0, s, s);
  hg.fillStyle = '#6a6a6a'; hg.fillRect(s * 0.1, s * 0.12, s * 0.8, s * 0.76);
  if (band) {
    T.stripes(g, 0, s * 0.06, s, s * 0.055, { a: band, b: '#22221f', width: s * 0.05 });
  }
  T.stencil(g, s * 0.14, s * 0.38, s * 0.72, s * 0.24, text, { rng, size: s * 0.15, colour: '#e6e2d0' });
  T.rust(g, hg, 0, 0, s, s, { rng, count: 3 });
  T.scuffs(g, 0, 0, s, s, { rng, count: 24 });
  T.groundGrime(g, 0, 0, s, s, 0.3);
};

export function cratePainters() {
  return [
    // row 0 — timber
    woodSide('#a8825a', 'MK-7', '24 RDS  LOT 118'),
    woodSide('#b89262', 'DRY', 'KEEP UPRIGHT'),
    ({ g, hg, sg, s, T, rng }) => {                       // wood lid
      T.planks(g, hg, 0, 0, s, s, { count: 4, vertical: true, colour: '#ac8a5f', rng });
      spec(sg, 0, 0, s, s, 0.9, 0);
      g.fillStyle = 'rgba(58,48,38,0.8)';
      g.fillRect(0, s * 0.14, s, s * 0.06); g.fillRect(0, s * 0.8, s, s * 0.06);
      hg.fillStyle = '#d8d8d8';
      hg.fillRect(0, s * 0.14, s, s * 0.06); hg.fillRect(0, s * 0.8, s, s * 0.06);
      T.rivets(g, hg, s * 0.08, s * 0.17, s * 0.92, s * 0.17, { count: 6, r: s * 0.011 });
      T.rivets(g, hg, s * 0.08, s * 0.83, s * 0.92, s * 0.83, { count: 6, r: s * 0.011 });
      T.overlay(g, s, T.grain(128, 5, { baseFreq: 9 }), 0.34, 'overlay', s / 256);
      T.scuffs(g, 0, 0, s, s, { rng, count: 20 });
    },
    ({ g, hg, sg, s, T, rng }) => {                       // plywood
      g.fillStyle = '#b4915e'; g.fillRect(0, 0, s, s);
      spec(sg, 0, 0, s, s, 0.86, 0);
      T.overlay(g, s, T.grain(256, 61, { baseFreq: 3, octaves: 4, contrast: 1.4 }), 0.5, 'overlay', s / 256);
      T.overlay(hg, s, T.grain(256, 61, { baseFreq: 3, octaves: 4 }), 0.45, 'overlay', s / 256);
      g.strokeStyle = 'rgba(80,60,36,0.5)'; g.lineWidth = 1;
      for (let i = 0; i < 7; i++) {
        g.beginPath();
        const y = rng.range(0, s);
        g.moveTo(0, y);
        g.bezierCurveTo(s * 0.3, y + rng.jit(s * 0.1), s * 0.7, y + rng.jit(s * 0.1), s, y + rng.jit(s * 0.05));
        g.stroke();
      }
      T.stencil(g, s * 0.2, s * 0.44, s * 0.6, s * 0.14, 'B-2', { rng, size: s * 0.1, colour: 'rgba(40,40,44,0.7)' });
      T.groundGrime(g, 0, 0, s, s, 0.4);
    },
    // row 1 — hard cases
    caseSide('#5e6650', 'FIELD-04', null),
    caseSide('#5a6250', '17', '#c8a52a'),
    ({ g, hg, sg, s, T, rng }) => {                       // case lid
      T.fillRamp(g, 0, 0, s, s, '#6a7359', '#4e5644');
      spec(sg, 0, 0, s, s, 0.6, 0.18);
      hg.fillStyle = '#909090'; hg.fillRect(0, 0, s, s);
      for (let i = 0; i < 5; i++) {
        const y = s * (0.14 + i * 0.18);
        g.fillStyle = 'rgba(255,255,255,0.06)'; g.fillRect(s * 0.08, y, s * 0.84, s * 0.035);
        g.fillStyle = 'rgba(0,0,0,0.35)'; g.fillRect(s * 0.08, y + s * 0.035, s * 0.84, s * 0.02);
        hg.fillStyle = '#c8c8c8'; hg.fillRect(s * 0.08, y, s * 0.84, s * 0.035);
      }
      T.scuffs(g, 0, 0, s, s, { rng, count: 30 });
      T.rust(g, hg, 0, 0, s, s, { rng, count: 2 });
    },
    ({ g, hg, sg, s, T, rng }) => {                       // cardboard
      g.fillStyle = '#a8834f'; g.fillRect(0, 0, s, s);
      spec(sg, 0, 0, s, s, 0.95, 0);
      T.overlay(g, s, T.grain(128, 8, { baseFreq: 22, contrast: 0.5 }), 0.28, 'overlay', s / 256);
      g.fillStyle = 'rgba(220,214,196,0.75)';
      g.fillRect(s * 0.44, 0, s * 0.11, s);
      g.fillStyle = 'rgba(0,0,0,0.18)'; g.fillRect(s * 0.44, 0, s * 0.01, s);
      hg.fillStyle = '#909090'; hg.fillRect(s * 0.44, 0, s * 0.11, s);
      T.stencil(g, s * 0.05, s * 0.62, s * 0.34, s * 0.12, 'DRY', { rng, size: s * 0.075, colour: 'rgba(40,36,32,0.75)' });
      T.streaks(g, 0, 0, s, s, { rng, count: 4, colour: '60,44,26', alpha: 0.2 });
      T.groundGrime(g, 0, 0, s, s, 0.45);
    },
    // row 2 — ammunition / plastic
    ({ g, hg, sg, s, T, rng }) => {                       // ammo crate side
      T.fillRamp(g, 0, 0, s, s, '#53604a', '#3c4634');
      spec(sg, 0, 0, s, s, 0.55, 0.35);
      hg.fillStyle = '#8a8a8a'; hg.fillRect(0, 0, s, s);
      g.fillStyle = '#c9a62c'; g.fillRect(0, s * 0.2, s, s * 0.045);
      hg.fillStyle = '#a0a0a0'; hg.fillRect(0, s * 0.2, s, s * 0.045);
      T.stencil(g, s * 0.06, s * 0.42, s * 0.88, s * 0.16, '7.62 LINK', { rng, size: s * 0.1, colour: '#e2ddc8' });
      T.stencil(g, s * 0.06, s * 0.66, s * 0.5, s * 0.1, 'LOT 4471', { rng, size: s * 0.06, colour: '#cfc7ad' });
      T.rivets(g, hg, s * 0.06, s * 0.88, s * 0.94, s * 0.88, { count: 7, r: s * 0.013 });
      T.rust(g, hg, 0, 0, s, s, { rng, count: 4 });
      T.scuffs(g, 0, 0, s, s, { rng, count: 26 });
    },
    ({ g, hg, sg, s, T, rng }) => {                       // ammo crate lid
      T.fillRamp(g, 0, 0, s, s, '#556149', '#45503c');
      spec(sg, 0, 0, s, s, 0.55, 0.35);
      hg.fillStyle = '#8a8a8a'; hg.fillRect(0, 0, s, s);
      g.fillStyle = 'rgba(0,0,0,0.4)'; g.fillRect(s * 0.12, s * 0.4, s * 0.76, s * 0.2);
      hg.fillStyle = '#5a5a5a'; hg.fillRect(s * 0.12, s * 0.4, s * 0.76, s * 0.2);
      g.fillStyle = '#8f9498'; g.fillRect(s * 0.3, s * 0.44, s * 0.4, s * 0.12);
      hg.fillStyle = '#e0e0e0'; hg.fillRect(s * 0.3, s * 0.44, s * 0.4, s * 0.12);
      spec(sg, s * 0.3, s * 0.44, s * 0.4, s * 0.12, 0.35, 0.9);
      T.rust(g, hg, 0, 0, s, s, { rng, count: 3 });
      T.scuffs(g, 0, 0, s, s, { rng, count: 22 });
    },
    ({ g, hg, sg, s, T, rng }) => {                       // plastic crate side
      g.fillStyle = '#6e7378'; g.fillRect(0, 0, s, s);
      spec(sg, 0, 0, s, s, 0.42, 0);
      hg.fillStyle = '#808080'; hg.fillRect(0, 0, s, s);
      for (let i = 0; i < 6; i++) {
        const y = s * (0.1 + i * 0.14);
        g.fillStyle = 'rgba(0,0,0,0.35)'; g.fillRect(s * 0.1, y, s * 0.8, s * 0.05);
        hg.fillStyle = '#4a4a4a'; hg.fillRect(s * 0.1, y, s * 0.8, s * 0.05);
        g.fillStyle = 'rgba(255,255,255,0.07)'; g.fillRect(s * 0.1, y + s * 0.05, s * 0.8, s * 0.012);
      }
      T.overlay(g, s, T.grain(128, 12, { baseFreq: 18, contrast: 0.4 }), 0.2, 'overlay', s / 256);
      T.groundGrime(g, 0, 0, s, s, 0.5);
      T.scuffs(g, 0, 0, s, s, { rng, count: 18 });
    },
    ({ g, hg, sg, s, T, rng }) => {                       // plastic crate lid
      g.fillStyle = '#787d82'; g.fillRect(0, 0, s, s);
      spec(sg, 0, 0, s, s, 0.44, 0);
      hg.fillStyle = '#808080'; hg.fillRect(0, 0, s, s);
      g.strokeStyle = 'rgba(0,0,0,0.3)'; g.lineWidth = s * 0.02;
      for (let i = 1; i < 4; i++) {
        g.beginPath(); g.moveTo(0, s * i / 4); g.lineTo(s, s * i / 4); g.stroke();
        g.beginPath(); g.moveTo(s * i / 4, 0); g.lineTo(s * i / 4, s); g.stroke();
      }
      T.overlay(g, s, T.grain(128, 15, { baseFreq: 16 }), 0.22, 'overlay', s / 256);
      T.groundGrime(g, 0, 0, s, s, 0.3);
      T.scuffs(g, 0, 0, s, s, { rng, count: 14 });
    },
    // row 3 — sheet goods
    ({ g, hg, sg, s, T, rng }) => {                       // pallet pine
      T.planks(g, hg, 0, 0, s, s, { count: 3, vertical: true, colour: '#b9a179', rng, gap: 0.03 });
      spec(sg, 0, 0, s, s, 0.93, 0);
      T.overlay(g, s, T.grain(128, 33, { baseFreq: 26, contrast: 0.7 }), 0.4, 'overlay', s / 256);
      T.overlay(hg, s, T.grain(128, 33, { baseFreq: 26 }), 0.5, 'overlay', s / 256);
      T.streaks(g, 0, 0, s, s, { rng, count: 6, colour: '52,40,26', alpha: 0.18 });
      T.groundGrime(g, 0, 0, s, s, 0.55);
    },
    ({ g, hg, sg, s, T, rng }) => {                       // painted steel panel
      T.fillRamp(g, 0, 0, s, s, '#5d666f', '#454d55');
      spec(sg, 0, 0, s, s, 0.44, 0.85);
      hg.fillStyle = '#909090'; hg.fillRect(0, 0, s, s);
      T.rivets(g, hg, s * 0.06, s * 0.06, s * 0.94, s * 0.06, { count: 8, r: s * 0.014 });
      T.rivets(g, hg, s * 0.06, s * 0.94, s * 0.94, s * 0.94, { count: 8, r: s * 0.014 });
      T.rivets(g, hg, s * 0.06, s * 0.06, s * 0.06, s * 0.94, { count: 8, r: s * 0.014 });
      T.rivets(g, hg, s * 0.94, s * 0.06, s * 0.94, s * 0.94, { count: 8, r: s * 0.014 });
      T.rust(g, hg, 0, 0, s, s, { rng, count: 5 });
      T.streaks(g, 0, 0, s, s, { rng, count: 9, alpha: 0.24 });
      T.scuffs(g, 0, 0, s, s, { rng, count: 30 });
    },
    ({ g, hg, sg, s, T, rng }) => {                       // heavily rusted steel
      g.fillStyle = '#6b4a33'; g.fillRect(0, 0, s, s);
      spec(sg, 0, 0, s, s, 0.82, 0.55);
      T.overlay(g, s, T.cells(128, 9, { cells: 7 }), 0.4, 'overlay', s / 256);
      T.overlay(hg, s, T.cells(128, 9, { cells: 7 }), 0.6, 'overlay', s / 256);
      T.rust(g, hg, 0, 0, s, s, { rng, count: 12, colour: '#8a5228', dark: '#39200f' });
      // surviving paint flakes
      for (let i = 0; i < 9; i++) {
        g.fillStyle = rgba('#5a6b62', rng.range(0.25, 0.6));
        const x = rng.range(0, s), y = rng.range(0, s), w = rng.range(s * 0.06, s * 0.28);
        g.beginPath(); g.ellipse(x, y, w, w * rng.range(0.4, 1), rng.range(0, 3), 0, Math.PI * 2); g.fill();
      }
      T.streaks(g, 0, 0, s, s, { rng, count: 12, colour: '46,26,12', alpha: 0.3 });
    },
    ({ g, hg, sg, s, T, rng }) => {                       // grubby white plastic / fibreglass
      g.fillStyle = '#c6c3ba'; g.fillRect(0, 0, s, s);
      spec(sg, 0, 0, s, s, 0.5, 0);
      T.overlay(g, s, T.grain(128, 77, { baseFreq: 12, contrast: 0.35 }), 0.25, 'overlay', s / 256);
      g.fillStyle = 'rgba(200,60,40,0.8)';
      g.fillRect(s * 0.12, s * 0.34, s * 0.76, s * 0.03);
      T.stencil(g, s * 0.1, s * 0.42, s * 0.8, s * 0.14, 'CAUTION', { rng, size: s * 0.1, colour: 'rgba(40,36,34,0.85)' });
      T.streaks(g, 0, 0, s, s, { rng, count: 8, colour: '50,44,32', alpha: 0.22 });
      T.groundGrime(g, 0, 0, s, s, 0.5);
      T.scuffs(g, 0, 0, s, s, { rng, count: 20 });
    },
  ];
}

/* ============================== DRUM ATLAS =============================== */
/** 2x2 atlas of cylindrical drum wraps. u wraps the barrel, v runs up it. */
export function drumPainters() {
  const body = (base, labelCol, text, rustAmt) => ({ g, hg, sg, s, T, rng }) => {
    T.fillRamp(g, 0, 0, s, s, shade(base, 0.14), shade(base, -0.2));
    spec(sg, 0, 0, s, s, 0.5, 0.7);
    hg.fillStyle = '#808080'; hg.fillRect(0, 0, s, s);
    // rolling hoops (v bands)
    for (const v of [0.3, 0.62]) {
      g.fillStyle = 'rgba(0,0,0,0.35)'; g.fillRect(0, s * v, s, s * 0.055);
      g.fillStyle = 'rgba(255,255,255,0.1)'; g.fillRect(0, s * v, s, s * 0.014);
      hg.fillStyle = '#dedede'; hg.fillRect(0, s * v, s, s * 0.055);
    }
    // painted label band
    g.fillStyle = labelCol; g.fillRect(0, s * 0.38, s, s * 0.2);
    T.stencil(g, 0, s * 0.4, s, s * 0.16, text, { rng, size: s * 0.1, colour: '#1c1c1e' });
    T.rust(g, hg, 0, 0, s, s, { rng, count: rustAmt, colour: '#7d4a26', dark: '#3a2110' });
    T.streaks(g, 0, 0, s, s, { rng, count: 9, colour: '52,32,18', alpha: 0.15, len: 0.9 });
    T.overlay(g, s, T.grain(128, 5, { baseFreq: 16, contrast: 0.4 }), 0.22, 'overlay', s / 256);
    T.scuffs(g, 0, 0, s, s, { rng, count: 34 });
    T.groundGrime(g, 0, 0, s, s, 0.2);
  };
  return [
    body('#4a7ba4', '#e2ddd0', 'DIESEL', 4),
    body('#a3654c', '#cbb144', 'WASTE', 9),
    body('#6e7860', '#e2ddd0', 'JP-8', 6),
    body('#bd5842', '#eae6da', 'FLAM', 7),
  ];
}

/* ============================== SIGN ATLAS =============================== */
/** Transparent 4x4 atlas: signage, wall stencils, floor markings, labels. */
export function buildSignAtlas(T, size = 1024) {
  const cols = 4, cs = size / cols;
  const A = T.canvas(size);
  const g = A.g;
  g.clearRect(0, 0, size, size);
  const rng = new Rand(90210);
  const cell = (i, fn) => {
    const x = (i % cols) * cs, y = ((i / cols) | 0) * cs;
    g.save(); g.beginPath(); g.rect(x, y, cs, cs); g.clip(); g.translate(x, y);
    fn(cs, rng.fork(i * 17));
    g.restore();
  };
  const plate = (s, fill, stroke) => {
    g.fillStyle = fill; g.fillRect(s * 0.06, s * 0.06, s * 0.88, s * 0.88);
    if (stroke) { g.strokeStyle = stroke; g.lineWidth = s * 0.035; g.strokeRect(s * 0.08, s * 0.08, s * 0.84, s * 0.84); }
  };
  const wear = (s, r, amount = 40) => {
    g.save();
    g.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < amount; i++) {
      g.beginPath();
      g.arc(r.range(0, s), r.range(0, s), r.range(0.5, s * 0.02), 0, Math.PI * 2);
      g.fill();
    }
    g.restore();
  };
  const label = (s, txt, px, py, sz, col = '#15161a') => {
    g.fillStyle = col;
    g.font = `bold ${sz}px sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(txt, px, py);
  };

  // 0 warning triangle
  cell(0, (s, r) => {
    g.fillStyle = '#e8bf1c';
    g.beginPath(); g.moveTo(s * 0.5, s * 0.08); g.lineTo(s * 0.95, s * 0.88); g.lineTo(s * 0.05, s * 0.88); g.closePath(); g.fill();
    g.strokeStyle = '#17181c'; g.lineWidth = s * 0.05; g.stroke();
    label(s, '!', s * 0.5, s * 0.63, s * 0.44);
    wear(s, r, 30);
  });
  // 1 DANGER HIGH VOLTAGE
  cell(1, (s, r) => {
    plate(s, '#d8d3c6', '#b02a20');
    g.fillStyle = '#b02a20'; g.fillRect(s * 0.08, s * 0.08, s * 0.84, s * 0.26);
    label(s, 'DANGER', s * 0.5, s * 0.22, s * 0.17, '#f2eee2');
    label(s, 'HIGH', s * 0.5, s * 0.52, s * 0.15);
    label(s, 'VOLTAGE', s * 0.5, s * 0.72, s * 0.13);
    wear(s, r, 45);
  });
  // 2 no entry
  cell(2, (s, r) => {
    g.fillStyle = '#c22a22';
    g.beginPath(); g.arc(s * 0.5, s * 0.5, s * 0.42, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#e8e4da'; g.fillRect(s * 0.16, s * 0.42, s * 0.68, s * 0.16);
    wear(s, r, 34);
  });
  // 3 radiation trefoil
  cell(3, (s, r) => {
    plate(s, '#e5c320', '#1a1a1c');
    g.fillStyle = '#1a1a1c';
    g.beginPath(); g.arc(s * 0.5, s * 0.5, s * 0.09, 0, Math.PI * 2); g.fill();
    for (let i = 0; i < 3; i++) {
      const a0 = i * (Math.PI * 2 / 3) - 0.5, a1 = a0 + 1.05;
      g.beginPath();
      g.arc(s * 0.5, s * 0.5, s * 0.36, a0, a1);
      g.arc(s * 0.5, s * 0.5, s * 0.15, a1, a0, true);
      g.closePath(); g.fill();
    }
    wear(s, r, 40);
  });
  // 4 chevron arrows
  cell(4, (s, r) => {
    for (let i = 0; i < 3; i++) {
      g.fillStyle = i % 2 ? '#e8e2d2' : '#c8422a';
      g.beginPath();
      const x = s * (0.1 + i * 0.28);
      g.moveTo(x, s * 0.2); g.lineTo(x + s * 0.24, s * 0.5); g.lineTo(x, s * 0.8);
      g.lineTo(x + s * 0.1, s * 0.5); g.closePath(); g.fill();
    }
    wear(s, r, 30);
  });
  // 5 big stencil number
  cell(5, (s, r) => {
    g.fillStyle = 'rgba(228,224,210,0.9)';
    g.font = `bold ${s * 0.8}px monospace`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('07', s * 0.5, s * 0.54);
    wear(s, r, 90);
  });
  // 6 authorised personnel
  cell(6, (s, r) => {
    plate(s, '#2c4a7a', '#dcd8ca');
    label(s, 'AUTHORISED', s * 0.5, s * 0.34, s * 0.11, '#eae6d8');
    label(s, 'PERSONNEL', s * 0.5, s * 0.52, s * 0.11, '#eae6d8');
    label(s, 'ONLY', s * 0.5, s * 0.7, s * 0.11, '#eae6d8');
    wear(s, r, 42);
  });
  // 7 biohazard-ish quarantine
  cell(7, (s, r) => {
    plate(s, '#d8842a', '#1c1c1e');
    label(s, 'BIO', s * 0.5, s * 0.34, s * 0.2);
    label(s, 'CONTROL', s * 0.5, s * 0.62, s * 0.13);
    wear(s, r, 38);
  });
  // 8 hazard stripe band
  cell(8, (s, r) => {
    T.stripes(g, 0, s * 0.2, s, s * 0.6, { a: '#d8b219', b: '#1b1b1d', width: s * 0.1, angle: -0.62 });
    wear(s, r, 60);
  });
  // 9 KEEP CLEAR floor stencil
  cell(9, (s, r) => {
    g.fillStyle = 'rgba(226,220,200,0.85)';
    g.font = `bold ${s * 0.19}px monospace`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('KEEP', s * 0.5, s * 0.38);
    g.fillText('CLEAR', s * 0.5, s * 0.62);
    wear(s, r, 110);
  });
  // 10 exit sign
  cell(10, (s, r) => {
    plate(s, '#1d5b34', '#e2e0d4');
    label(s, 'EXIT', s * 0.5, s * 0.5, s * 0.24, '#eef0e4');
    wear(s, r, 26);
  });
  // 11 fuel point
  cell(11, (s, r) => {
    plate(s, '#b8302a', '#e8e2d2');
    label(s, 'FUEL', s * 0.5, s * 0.36, s * 0.19, '#f0ece0');
    label(s, 'NO FLAME', s * 0.5, s * 0.66, s * 0.1, '#f0ece0');
    wear(s, r, 40);
  });
  // 12 pipe ident band
  cell(12, (s, r) => {
    g.fillStyle = '#2a6a9a'; g.fillRect(0, s * 0.3, s, s * 0.4);
    g.fillStyle = '#e6e2d4';
    g.font = `bold ${s * 0.13}px sans-serif`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('COOLANT', s * 0.5, s * 0.5);
    wear(s, r, 34);
  });
  // 13 muster point
  cell(13, (s, r) => {
    plate(s, '#1f6b4f', '#e2e0d4');
    label(s, 'MUSTER', s * 0.5, s * 0.38, s * 0.14, '#eef0e4');
    label(s, 'POINT B', s * 0.5, s * 0.62, s * 0.13, '#eef0e4');
    wear(s, r, 30);
  });
  // 14 grate / vent louvre (opaque, used as a wall detail decal)
  cell(14, (s) => {
    g.fillStyle = '#2b2e32'; g.fillRect(s * 0.05, s * 0.05, s * 0.9, s * 0.9);
    for (let i = 0; i < 9; i++) {
      const y = s * (0.1 + i * 0.09);
      g.fillStyle = '#585d63'; g.fillRect(s * 0.08, y, s * 0.84, s * 0.045);
      g.fillStyle = '#15171a'; g.fillRect(s * 0.08, y + s * 0.045, s * 0.84, s * 0.03);
    }
  });
  // 15 sector marking
  cell(15, (s, r) => {
    g.fillStyle = 'rgba(216,178,25,0.9)';
    g.font = `bold ${s * 0.34}px monospace`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('SEC', s * 0.5, s * 0.36);
    g.fillText('B-4', s * 0.5, s * 0.68);
    wear(s, r, 80);
  });

  return T.colorTex(A.c, 1);
}

/* Tiling surface painters live in ./paint/Tiling.js — this file was over the
 * module size limit. Re-exported here so every existing importer of TILING
 * keeps working unchanged. */
export { TILING } from './paint/Tiling.js';


/* ============================ ALPHA CUT-OUTS ============================= */

/** Chain-link diamond mesh with an alpha channel. */
export function buildChainLink(T, size = 256) {
  const A = T.canvas(size);
  const g = A.g;
  g.clearRect(0, 0, size, size);
  g.strokeStyle = '#9aa1a8';
  g.lineWidth = Math.max(2, size / 56);
  g.lineCap = 'round';
  const step = size / 6;
  for (let i = -6; i <= 12; i++) {
    g.beginPath(); g.moveTo(i * step, 0); g.lineTo(i * step + size, size); g.stroke();
    g.beginPath(); g.moveTo(i * step, size); g.lineTo(i * step + size, 0); g.stroke();
  }
  // rust the wire a little
  g.globalCompositeOperation = 'source-atop';
  g.globalAlpha = 0.4;
  T.overlay(g, size, T.grain(128, 71, { baseFreq: 6, contrast: 1.2 }), 0.6, 'multiply', size / 128);
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'source-over';
  const t = T.colorTex(A.c, 1);
  t.repeat.set(1, 1);
  return t;
}

/** Weed / dry-grass tuft billboard, 2x2 atlas, transparent. */
export function buildFoliage(T, size = 256) {
  const A = T.canvas(size);
  const g = A.g;
  const rng = new Rand(4242);
  g.clearRect(0, 0, size, size);
  const cs = size / 2;
  for (let c = 0; c < 4; c++) {
    const ox = (c % 2) * cs, oy = ((c / 2) | 0) * cs;
    const blades = 16 + ((c * 5) % 9);
    for (let i = 0; i < blades; i++) {
      const bx = ox + cs * rng.range(0.2, 0.8);
      const by = oy + cs * 0.97;
      const h = cs * rng.range(0.35, 0.86);
      const bend = cs * rng.jit(0.28);
      const col = rng.bool(0.45) ? '#6d6a3a' : rng.bool(0.5) ? '#565f33' : '#8a7d4a';
      g.strokeStyle = col;
      g.lineWidth = cs * rng.range(0.012, 0.03);
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(bx, by);
      g.quadraticCurveTo(bx + bend * 0.4, by - h * 0.6, bx + bend, by - h);
      g.stroke();
    }
  }
  return T.colorTex(A.c, 1);
}
