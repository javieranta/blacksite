import { shade, rgba } from '../Textures.js';

/**
 * Tiling PBR surface painters. OWNER: props agent.
 *
 * Split out of TexPainters.js to keep both files inside the module size limit.
 * Each entry is a painter with the same contract as everything in TexPainters:
 * it receives { g (albedo ctx), hg (height ctx), sg (spec ctx), s (size), T
 * (texture foundry), rng } and must write all three layers, because the normal
 * map is derived from `hg` and the shading has to agree with the paint.
 *
 * `spec` is duplicated here rather than imported from TexPainters: importing it
 * back from the module that re-exports TILING would make the pair circular, and
 * a four-line helper is not worth a third file.
 */

/** Fill a rect of the spec layer with explicit roughness/metalness. */
function spec(sg, x, y, w, h, rough, metal = 0) {
  sg.fillStyle = `rgb(0,${Math.round(rough * 255)},${Math.round(metal * 255)})`;
  sg.fillRect(x, y, w, h);
}

/* ============================ TILING SURFACES ============================ */

export const TILING = {
  /**
   * Hessian / burlap — a real plain weave, not a stripe pattern.
   *
   * The old painter drew two sets of parallel stripes at 9% alpha, which is why
   * sandbags read as smooth stones: there was nothing in the normal map for a
   * highlight to break up. A plain weave is an over/under checker: at cell
   * (i, j) the warp thread crosses OVER the weft when (i+j) is even and UNDER
   * when it is odd. Drawing the under-thread first and the over-thread second,
   * per cell, produces the interlocked basket relief in the height layer — and
   * because albedo, height and roughness are all painted from the same passes,
   * the shading and the paint agree.
   *
   * SCALE IS THE WHOLE GAME HERE. A first attempt used a physically honest 3 mm
   * thread. At 3 m that is a third of a pixel, the mip chain averaged the weave
   * to flat grey, and the bags went back to reading as smooth slabs — the exact
   * defect this was written to fix. Games exaggerate: the tile covers ~18 cm
   * (Sandbags.WEAVE_UV) at 15 threads, so a thread is ~1.2 cm and still carries
   * a visible highlight break at 5 m. Contrast is pushed hard for the same
   * reason — a subtle normal map is an invisible one.
   */
  hessian: ({ g, hg, sg, s, T, rng }) => {
    const THREADS = 15;
    const p = s / THREADS;
    const base = '#8d7748';
    g.fillStyle = base; g.fillRect(0, 0, s, s);
    hg.fillStyle = '#1e1e1e'; hg.fillRect(0, 0, s, s);   // gaps sit deep
    spec(sg, 0, 0, s, s, 0.88, 0);                        // cloth roughness

    // per-thread slub: jute is spun unevenly, and that unevenness is most of
    // what stops the weave looking like a printed grid
    const warpW = [], weftW = [], warpTone = [], weftTone = [];
    for (let i = 0; i < THREADS; i++) {
      warpW.push(p * rng.range(0.66, 0.88));
      weftW.push(p * rng.range(0.64, 0.86));
      warpTone.push(rng.range(-0.18, 0.2));
      weftTone.push(rng.range(-0.2, 0.18));
    }
    const tone = (t) => {
      const v = Math.round(150 + t * 105);
      return `rgb(${Math.min(255, v)},${Math.round(v * 0.86)},${Math.round(v * 0.56)})`;
    };
    // Over-threads go near-white, under-threads mid: the derived normal then has
    // a real gradient at every crossing instead of a whisper.
    const hTone = (t, over) => {
      const v = Math.round((over ? 244 : 132) + t * 34);
      return `rgb(${v},${v},${v})`;
    };

    // A thread is drawn as a rounded ridge: a wide dark base then a narrower
    // bright crown. Two rects per thread is all it takes to make the height
    // field curve instead of step, and a stepped height field is what produces
    // the plastic, embossed look.
    const drawWarp = (i, j, over) => {
      const w = warpW[i];
      const x0 = i * p + (p - w) / 2, y0 = j * p - p * 0.07, h = p * 1.14;
      g.fillStyle = tone(warpTone[i] + (over ? 0.2 : -0.16));
      g.fillRect(x0, y0, w, h);
      hg.fillStyle = hTone(warpTone[i] - 0.5, over);
      hg.fillRect(x0, y0, w, h);
      hg.fillStyle = hTone(warpTone[i], over);
      hg.fillRect(x0 + w * 0.24, y0, w * 0.52, h);
      if (over) spec(sg, x0, j * p, w, p, 0.8, 0);
    };
    const drawWeft = (i, j, over) => {
      const w = weftW[j];
      const x0 = i * p - p * 0.07, y0 = j * p + (p - w) / 2, wd = p * 1.14;
      g.fillStyle = tone(weftTone[j] + (over ? 0.18 : -0.18));
      g.fillRect(x0, y0, wd, w);
      hg.fillStyle = hTone(weftTone[j] - 0.5, over);
      hg.fillRect(x0, y0, wd, w);
      hg.fillStyle = hTone(weftTone[j], over);
      hg.fillRect(x0, y0 + w * 0.24, wd, w * 0.52);
      if (over) spec(sg, i * p, y0, p, w, 0.8, 0);
    };

    for (let j = 0; j < THREADS; j++) {
      for (let i = 0; i < THREADS; i++) {
        const warpOver = ((i + j) & 1) === 0;
        if (warpOver) { drawWeft(i, j, false); drawWarp(i, j, true); }
        else { drawWarp(i, j, false); drawWeft(i, j, true); }
      }
    }

    // loose fibres pulled out of the weave — the tell of worn sacking
    g.lineWidth = hg.lineWidth = Math.max(1, p * 0.14);
    for (let i = 0; i < 26; i++) {
      const x = rng.range(0, s), y = rng.range(0, s);
      const a = rng.range(0, Math.PI * 2), len = rng.range(p * 1.5, p * 5);
      g.strokeStyle = 'rgba(214,192,146,0.5)';
      hg.strokeStyle = 'rgba(226,226,226,0.55)';
      for (const c of [g, hg]) {
        c.beginPath(); c.moveTo(x, y);
        c.quadraticCurveTo(x + Math.cos(a) * len * 0.5 + p, y + Math.sin(a) * len * 0.5,
          x + Math.cos(a) * len, y + Math.sin(a) * len);
        c.stroke();
      }
    }

    // dust settled in the weave, then damp staining
    T.overlay(g, s, T.grain(128, 41, { baseFreq: 3, contrast: 1.1 }), 0.4, 'overlay', s / 128);
    T.overlay(hg, s, T.grain(128, 41, { baseFreq: 3 }), 0.14, 'overlay', s / 128);
    T.streaks(g, 0, 0, s, s, { rng, count: 9, colour: '54,42,24', alpha: 0.2, len: 0.9 });
    T.rust(g, hg, 0, 0, s, s, { rng, count: 3, colour: '#8a7148', dark: '#5f4d2c' });
  },

  /** Kept for the older bagged-goods props that want a finer sacking weave. */
  burlap: ({ g, hg, sg, s, T, rng }) => {
    g.fillStyle = '#a9946a'; g.fillRect(0, 0, s, s);
    spec(sg, 0, 0, s, s, 0.9, 0);
    hg.fillStyle = '#707070'; hg.fillRect(0, 0, s, s);
    const w = Math.max(2, s / 48);
    for (let i = 0; i < s; i += w * 2) {
      g.fillStyle = 'rgba(0,0,0,0.18)'; g.fillRect(i, 0, w, s);
      g.fillStyle = 'rgba(255,244,214,0.16)'; g.fillRect(i + w, 0, w, s);
      hg.fillStyle = '#4a4a4a'; hg.fillRect(i, 0, w, s);
      hg.fillStyle = '#bcbcbc'; hg.fillRect(i + w, 0, w, s);
    }
    for (let i = 0; i < s; i += w * 2) {
      g.fillStyle = 'rgba(0,0,0,0.16)'; g.fillRect(0, i, s, w);
      hg.fillStyle = 'rgba(70,70,70,0.75)'; hg.fillRect(0, i, s, w);
      hg.fillStyle = 'rgba(190,190,190,0.5)'; hg.fillRect(0, i + w, s, w);
    }
    T.overlay(g, s, T.grain(128, 41, { baseFreq: 5, contrast: 0.8 }), 0.3, 'overlay', s / 256);
    T.overlay(hg, s, T.grain(128, 41, { baseFreq: 5 }), 0.4, 'overlay', s / 256);
    T.rust(g, hg, 0, 0, s, s, { rng, count: 3, colour: '#8a7148', dark: '#5f4d2c' });
  },

  concrete: ({ g, hg, sg, s, T, rng }) => {
    g.fillStyle = '#a5a199'; g.fillRect(0, 0, s, s);
    spec(sg, 0, 0, s, s, 0.9, 0);
    // Fine sand grain only in the height layer. Low-frequency blobs in a height
    // map become bubble-wrap once they hit a normal map, so the big tonal
    // variation lives in the albedo and nowhere else.
    T.overlay(g, s, T.cells(512, 3, { cells: 52 }), 0.2, 'overlay', 1);
    T.overlay(hg, s, T.cells(512, 3, { cells: 52 }), 0.3, 'overlay', 1);
    T.overlay(g, s, T.grain(256, 19, { baseFreq: 5, octaves: 5, contrast: 0.9 }), 0.26, 'overlay', s / 256);
    T.overlay(hg, s, T.grain(256, 19, { baseFreq: 26, octaves: 3 }), 0.35, 'overlay', s / 256);
    // form-board lines and pour seams
    g.strokeStyle = 'rgba(90,86,80,0.35)';
    hg.strokeStyle = 'rgba(70,70,70,0.7)';
    g.lineWidth = hg.lineWidth = Math.max(1, s / 340);
    for (let i = 0; i < 3; i++) {
      const y = rng.range(0, s);
      g.beginPath(); g.moveTo(0, y); g.lineTo(s, y + rng.jit(3)); g.stroke();
      hg.beginPath(); hg.moveTo(0, y); hg.lineTo(s, y + rng.jit(3)); hg.stroke();
    }
    // chips exposing aggregate
    for (let i = 0; i < 22; i++) {
      const x = rng.range(0, s), y = rng.range(0, s), r = rng.range(s * 0.004, s * 0.014);
      g.fillStyle = rgba('#7d7871', rng.range(0.35, 0.7));
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
      hg.fillStyle = 'rgba(70,70,70,0.7)';
      hg.beginPath(); hg.arc(x, y, r, 0, Math.PI * 2); hg.fill();
    }
    T.streaks(g, 0, 0, s, s, { rng, count: 12, colour: '46,42,36', alpha: 0.13 });
    T.groundGrime(g, 0, 0, s, s, 0.3);
  },

  steel: ({ g, hg, sg, s, T, rng }) => {
    T.fillRamp(g, 0, 0, s, s, '#8d949b', '#6d747c');
    spec(sg, 0, 0, s, s, 0.4, 0.92);
    hg.fillStyle = '#808080'; hg.fillRect(0, 0, s, s);
    T.overlay(g, s, T.cells(128, 23, { cells: 5 }), 0.24, 'overlay', s / 256);
    T.overlay(g, s, T.grain(128, 31, { baseFreq: 20, contrast: 0.5 }), 0.22, 'overlay', s / 256);
    T.overlay(hg, s, T.grain(128, 31, { baseFreq: 20 }), 0.3, 'overlay', s / 256);
    T.rust(g, hg, 0, 0, s, s, { rng, count: 6, colour: '#7a4a28', dark: '#3a2110' });
    T.streaks(g, 0, 0, s, s, { rng, count: 8, colour: '48,30,16', alpha: 0.2 });
    T.scuffs(g, 0, 0, s, s, { rng, count: 40 });
  },

  rustyMetal: ({ g, hg, sg, s, T, rng }) => {
    g.fillStyle = '#6a4630'; g.fillRect(0, 0, s, s);
    spec(sg, 0, 0, s, s, 0.85, 0.5);
    T.overlay(g, s, T.cells(256, 13, { cells: 9 }), 0.42, 'overlay', s / 256);
    T.overlay(hg, s, T.cells(256, 13, { cells: 9 }), 0.6, 'overlay', s / 256);
    T.rust(g, hg, 0, 0, s, s, { rng, count: 16, colour: '#8a5228', dark: '#3a2010' });
    for (let i = 0; i < 12; i++) {
      g.fillStyle = rgba('#4e5b52', rng.range(0.2, 0.55));
      g.beginPath();
      g.ellipse(rng.range(0, s), rng.range(0, s), rng.range(s * 0.03, s * 0.16), rng.range(s * 0.02, s * 0.1), rng.range(0, 3), 0, Math.PI * 2);
      g.fill();
    }
    T.streaks(g, 0, 0, s, s, { rng, count: 14, colour: '44,24,10', alpha: 0.3 });
  },

  tarp: ({ g, hg, sg, s, T, rng }) => {
    g.fillStyle = '#5c6350'; g.fillRect(0, 0, s, s);
    spec(sg, 0, 0, s, s, 0.86, 0);
    hg.fillStyle = '#808080'; hg.fillRect(0, 0, s, s);
    const w = Math.max(2, s / 96);
    for (let i = 0; i < s; i += w * 3) {
      g.fillStyle = 'rgba(0,0,0,0.1)'; g.fillRect(i, 0, w, s);
      g.fillStyle = 'rgba(0,0,0,0.1)'; g.fillRect(0, i, s, w);
      hg.fillStyle = 'rgba(96,96,96,0.7)'; hg.fillRect(i, 0, w, s);
      hg.fillStyle = 'rgba(96,96,96,0.7)'; hg.fillRect(0, i, s, w);
    }
    T.overlay(g, s, T.grain(256, 67, { baseFreq: 3, octaves: 5, contrast: 1.3 }), 0.4, 'overlay', s / 256);
    T.overlay(hg, s, T.grain(256, 67, { baseFreq: 3, octaves: 5 }), 0.55, 'overlay', s / 256);
    T.streaks(g, 0, 0, s, s, { rng, count: 10, colour: '34,30,20', alpha: 0.22 });
    T.rust(g, hg, 0, 0, s, s, { rng, count: 5, colour: '#4a4a34', dark: '#242418' });
  },

  vehiclePaint: ({ g, hg, sg, s, T, rng }) => {
    T.fillRamp(g, 0, 0, s, s, '#6d7360', '#4e5445');
    spec(sg, 0, 0, s, s, 0.52, 0.35);
    hg.fillStyle = '#808080'; hg.fillRect(0, 0, s, s);
    T.overlay(g, s, T.grain(256, 88, { baseFreq: 4, octaves: 5, contrast: 0.9 }), 0.3, 'overlay', s / 256);
    T.rust(g, hg, 0, 0, s, s, { rng, count: 10, colour: '#7d4a26', dark: '#38200f' });
    T.streaks(g, 0, 0, s, s, { rng, count: 16, colour: '40,26,14', alpha: 0.26, len: 0.95 });
    // dust film low down
    const grd = g.createLinearGradient(0, s, 0, s * 0.35);
    grd.addColorStop(0, 'rgba(150,132,98,0.5)');
    grd.addColorStop(1, 'rgba(150,132,98,0)');
    g.fillStyle = grd; g.fillRect(0, 0, s, s);
    T.scuffs(g, 0, 0, s, s, { rng, count: 44 });
  },

  tyre: ({ g, hg, sg, s, T, rng }) => {
    g.fillStyle = '#1d1e20'; g.fillRect(0, 0, s, s);
    spec(sg, 0, 0, s, s, 0.92, 0);
    hg.fillStyle = '#606060'; hg.fillRect(0, 0, s, s);
    for (let i = 0; i < 16; i++) {
      const x = (i / 16) * s;
      g.fillStyle = '#2b2d30'; g.fillRect(x, 0, s / 32, s);
      hg.fillStyle = '#c0c0c0'; hg.fillRect(x, 0, s / 32, s);
      g.fillStyle = '#26282a';
      g.fillRect(x + s / 40, (i % 2) * s / 8, s / 26, s / 5);
      hg.fillStyle = '#e0e0e0';
      hg.fillRect(x + s / 40, (i % 2) * s / 8, s / 26, s / 5);
    }
    T.overlay(g, s, T.grain(128, 99, { baseFreq: 18, contrast: 0.4 }), 0.3, 'overlay', s / 256);
    T.rust(g, hg, 0, 0, s, s, { rng, count: 3, colour: '#5a4a34', dark: '#2a2318' });
  },

  rubble: ({ g, hg, sg, s, T, rng }) => {
    g.fillStyle = '#9c968c'; g.fillRect(0, 0, s, s);
    spec(sg, 0, 0, s, s, 0.95, 0);
    T.overlay(g, s, T.cells(256, 55, { cells: 22 }), 0.3, 'overlay', s / 256);
    T.overlay(hg, s, T.cells(256, 55, { cells: 22 }), 0.45, 'overlay', s / 256);
    T.overlay(g, s, T.grain(128, 57, { baseFreq: 16, contrast: 0.7 }), 0.28, 'overlay', s / 256);
    for (let i = 0; i < 30; i++) {
      g.fillStyle = rgba(rng.bool(0.55) ? '#b8b2a6' : '#77726a', rng.range(0.25, 0.6));
      g.beginPath();
      g.ellipse(rng.range(0, s), rng.range(0, s), rng.range(s * 0.006, s * 0.022), rng.range(s * 0.006, s * 0.022), 0, 0, Math.PI * 2);
      g.fill();
    }
    T.groundGrime(g, 0, 0, s, s, 0.35);
  },

  darkSteel: ({ g, hg, sg, s, T, rng }) => {
    T.fillRamp(g, 0, 0, s, s, '#454b52', '#31363c');
    spec(sg, 0, 0, s, s, 0.46, 0.88);
    hg.fillStyle = '#808080'; hg.fillRect(0, 0, s, s);
    T.overlay(g, s, T.grain(128, 61, { baseFreq: 9, contrast: 0.8 }), 0.3, 'overlay', s / 256);
    T.overlay(hg, s, T.grain(128, 61, { baseFreq: 9 }), 0.35, 'overlay', s / 256);
    // shot-blast speckle + chipped paint showing bare metal
    for (let i = 0; i < 30; i++) {
      g.fillStyle = rgba('#8d949b', rng.range(0.15, 0.5));
      const x = rng.range(0, s), y = rng.range(0, s), r = rng.range(s * 0.004, s * 0.018);
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    }
    T.rust(g, hg, 0, 0, s, s, { rng, count: 5, colour: '#6d4325', dark: '#301b0d' });
    T.streaks(g, 0, 0, s, s, { rng, count: 7, colour: '38,24,12', alpha: 0.2 });
    T.scuffs(g, 0, 0, s, s, { rng, count: 36 });
  },

  cable: ({ g, hg, sg, s, T, rng }) => {
    g.fillStyle = '#26262a'; g.fillRect(0, 0, s, s);
    spec(sg, 0, 0, s, s, 0.68, 0);
    hg.fillStyle = '#808080'; hg.fillRect(0, 0, s, s);
    // helical winding ridges
    g.save(); hg.save();
    g.translate(s / 2, s / 2); g.rotate(0.35); g.translate(-s / 2, -s / 2);
    hg.translate(s / 2, s / 2); hg.rotate(0.35); hg.translate(-s / 2, -s / 2);
    const w = Math.max(2, s / 26);
    for (let i = -s; i < s * 2; i += w * 2) {
      g.fillStyle = 'rgba(255,255,255,0.05)'; g.fillRect(i, -s, w, s * 3);
      g.fillStyle = 'rgba(0,0,0,0.35)'; g.fillRect(i + w, -s, w, s * 3);
      hg.fillStyle = '#c8c8c8'; hg.fillRect(i, -s, w, s * 3);
      hg.fillStyle = '#3a3a3a'; hg.fillRect(i + w, -s, w, s * 3);
    }
    g.restore(); hg.restore();
    T.overlay(g, s, T.grain(128, 17, { baseFreq: 14, contrast: 0.5 }), 0.25, 'overlay', s / 256);
    T.streaks(g, 0, 0, s, s, { rng, count: 5, colour: '70,64,52', alpha: 0.18 });
  },

  glow: ({ g, sg, s }) => {
    g.fillStyle = '#fff3d8'; g.fillRect(0, 0, s, s);
    spec(sg, 0, 0, s, s, 0.3, 0);
  },
};
