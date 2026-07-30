import * as THREE from 'three';
import { Rand } from '../Rand.js';

/**
 * GRIME ATLAS — the dirt/AO multiply layer, 4x4, rows 3 and 2 used.
 *
 * WHY A SECOND ATLAS AND A SECOND MATERIAL
 *   Every mark in buildDecalAtlas is drawn with normal alpha blending, which
 *   REPLACES what is underneath in proportion to alpha. That is right for a
 *   stain and wrong for dirt: laying a 6 m alpha-blended wash over a slab
 *   flattens the slab's own grain and normal detail inside the wash, which is
 *   the opposite of the intent — and is exactly why the round-9 attempt at
 *   broad cells MEASURED worse (see the note in GroundIncident.slabIncident).
 *
 *   Dirt and ambient occlusion are MULTIPLIES. The material that draws this
 *   atlas blends as `dst * mix(1, rgb, a)` (see Materials.js 'grime'), so a
 *   grime quad scales the radiance already in the buffer and every bit of
 *   underlying texture, normal detail and shadow survives inside it. It can
 *   therefore be large and strong without ever looking like a sticker.
 *
 *   RGB is the colour the surface is multiplied TOWARD; ALPHA is the strength
 *   mask and does the feathering. Both are per-quad modulated by the vertex
 *   colour, so eight cells cover the whole vocabulary.
 *
 *   [0,3] soft pool      [1,3] wall-base edge   [2,3] rust bleed  [3,3] mottle A
 *   [0,2] mottle B       [1,2] worn lane        [2,2] drain sink  [3,2] tight foot
 */
export function buildGrimeAtlas(T, size = 1024) {
  const A = T.canvas(size);
  const g = A.g;
  const cs = size / 4;
  const rng = new Rand(5521);
  g.clearRect(0, 0, size, size);

  const cell = (col, row, draw) => {
    g.save();
    g.translate(col * cs, (3 - row) * cs);
    draw();
    g.restore();
  };

  /** A radial darkening whose alpha falls to zero well inside the cell. */
  const pool = (peak, tight, tone) => {
    const c0 = cs * 0.5;
    const gg = g.createRadialGradient(c0, c0, 0, c0, c0, cs * 0.5);
    gg.addColorStop(0, `rgba(${tone},${peak})`);
    gg.addColorStop(tight, `rgba(${tone},${(peak * 0.42).toFixed(3)})`);
    gg.addColorStop(1, `rgba(${tone},0)`);
    g.fillStyle = gg;
    g.fillRect(0, 0, cs, cs);
  };

  // --- [0,3] soft pool: general dirt collecting round the base of things
  cell(0, 3, () => {
    pool(0.50, 0.46, '46,43,39');
    // break the perfect circle so a hundred of them do not read as a hundred circles
    g.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 26; i++) {
      const a = rng.range(0, Math.PI * 2);
      const r = cs * rng.range(0.16, 0.46);
      const rr = cs * rng.range(0.06, 0.17);
      const gg = g.createRadialGradient(cs * 0.5 + Math.cos(a) * r, cs * 0.5 + Math.sin(a) * r, 0,
        cs * 0.5 + Math.cos(a) * r, cs * 0.5 + Math.sin(a) * r, rr);
      gg.addColorStop(0, `rgba(0,0,0,${rng.range(0.15, 0.5)})`);
      gg.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gg;
      g.beginPath(); g.arc(cs * 0.5 + Math.cos(a) * r, cs * 0.5 + Math.sin(a) * r, rr, 0, Math.PI * 2);
      g.fill();
    }
    g.globalCompositeOperation = 'source-over';
  });

  /*
   * --- [1,3] wall-base edge
   * Dark at the CANVAS TOP of the cell, gone by 65% down. Laid with
   * yaw = along + PI/2 and the quad centre pushed out from the wall by half its
   * depth, that top edge lands exactly in the wall/floor joint — the same
   * convention the lit wall-base wash uses, so the two register.
   */
  cell(1, 3, () => {
    const gg = g.createLinearGradient(0, 0, 0, cs);
    gg.addColorStop(0, 'rgba(40,37,34,0.66)');
    gg.addColorStop(0.18, 'rgba(44,41,37,0.40)');
    gg.addColorStop(0.52, 'rgba(50,47,42,0.14)');
    gg.addColorStop(0.80, 'rgba(54,50,45,0.02)');
    gg.addColorStop(1, 'rgba(54,50,45,0)');
    g.fillStyle = gg;
    g.fillRect(0, 0, cs, cs);
    // uneven reach: dirt does not stop on a straight line
    for (let i = 0; i < 34; i++) {
      const x = cs * rng.next();
      const h = cs * rng.range(0.14, 0.60);
      const sg = g.createLinearGradient(0, 0, 0, h);
      sg.addColorStop(0, `rgba(34,31,28,${rng.range(0.10, 0.30)})`);
      sg.addColorStop(1, 'rgba(38,35,32,0)');
      g.fillStyle = sg;
      g.fillRect(x, 0, cs * rng.range(0.01, 0.05), h);
    }
    g.globalCompositeOperation = 'destination-out';
    const fx = g.createLinearGradient(0, 0, cs, 0);
    fx.addColorStop(0, 'rgba(0,0,0,1)');
    fx.addColorStop(0.10, 'rgba(0,0,0,0)');
    fx.addColorStop(0.90, 'rgba(0,0,0,0)');
    fx.addColorStop(1, 'rgba(0,0,0,1)');
    g.fillStyle = fx; g.fillRect(0, 0, cs, cs);
    g.globalCompositeOperation = 'source-over';
  });

  // --- [2,3] rust bleed: warm, directional, runs from the canvas-top edge
  cell(2, 3, () => {
    for (let i = 0; i < 26; i++) {
      const x = cs * rng.range(0.12, 0.88);
      const h = cs * rng.range(0.30, 0.92);
      const w = cs * rng.range(0.015, 0.07);
      const sg = g.createLinearGradient(0, 0, 0, h);
      sg.addColorStop(0, `rgba(104,52,22,${rng.range(0.22, 0.48)})`);
      sg.addColorStop(0.5, `rgba(122,66,30,${rng.range(0.08, 0.20)})`);
      sg.addColorStop(1, 'rgba(130,74,36,0)');
      g.fillStyle = sg;
      g.fillRect(x, 0, w, h);
    }
    const band = g.createLinearGradient(0, 0, 0, cs * 0.5);
    band.addColorStop(0, 'rgba(96,50,22,0.28)');
    band.addColorStop(1, 'rgba(110,60,28,0)');
    g.fillStyle = band; g.fillRect(0, 0, cs, cs * 0.5);
    g.globalCompositeOperation = 'destination-out';
    const fx = g.createLinearGradient(0, 0, cs, 0);
    fx.addColorStop(0, 'rgba(0,0,0,1)');
    fx.addColorStop(0.14, 'rgba(0,0,0,0)');
    fx.addColorStop(0.86, 'rgba(0,0,0,0)');
    fx.addColorStop(1, 'rgba(0,0,0,1)');
    g.fillStyle = fx; g.fillRect(0, 0, cs, cs);
    g.globalCompositeOperation = 'source-over';
  });

  /*
   * --- [3,3] and [0,2] mottle
   * THE CELL THAT MOVES THE NUMBER. A slab reads flat when every 32-px block
   * has the same mean as its neighbours; noise does not change that, because
   * noise averages out inside a block. These two cells are deliberately LOW
   * frequency and nothing else — four or five overlapping lobes across three
   * metres — so a quad of one lands as a single value shift over a whole patch
   * of floor. Two variants at different weights, laid over each other at random
   * scales and rotations, never repeat visibly.
   */
  const mottle = (tone, lobes, peak) => {
    for (let i = 0; i < lobes; i++) {
      const a = rng.range(0, Math.PI * 2);
      const r = cs * rng.range(0.02, 0.26);
      const px = cs * 0.5 + Math.cos(a) * r, py = cs * 0.5 + Math.sin(a) * r;
      const rr = cs * rng.range(0.20, 0.42);
      const gg = g.createRadialGradient(px, py, 0, px, py, rr);
      gg.addColorStop(0, `rgba(${tone},${(peak * rng.range(0.7, 1)).toFixed(3)})`);
      gg.addColorStop(0.6, `rgba(${tone},${(peak * 0.4).toFixed(3)})`);
      gg.addColorStop(1, `rgba(${tone},0)`);
      g.fillStyle = gg;
      g.save();
      g.translate(px, py); g.rotate(rng.range(0, 3.14)); g.scale(1, rng.range(0.55, 1));
      g.translate(-px, -py);
      g.beginPath(); g.arc(px, py, rr, 0, Math.PI * 2); g.fill();
      g.restore();
    }
    // hard clamp to zero at the cell edge — a mottle quad must never show a seam
    g.globalCompositeOperation = 'destination-out';
    const f = g.createRadialGradient(cs * 0.5, cs * 0.5, cs * 0.31, cs * 0.5, cs * 0.5, cs * 0.5);
    f.addColorStop(0, 'rgba(0,0,0,0)');
    f.addColorStop(1, 'rgba(0,0,0,1)');
    g.fillStyle = f; g.fillRect(0, 0, cs, cs);
    g.globalCompositeOperation = 'source-over';
  };
  cell(3, 3, () => mottle('54,51,47', 6, 0.42));
  cell(0, 2, () => mottle('72,63,50', 5, 0.34));

  /*
   * --- [1,2] worn traffic lane
   * A long soft band, darkest along its middle, running the length of the cell.
   * Laid end to end along a route it gives the floor a direction and a history
   * of use, and it is the only broad cell whose shape is not a blob.
   */
  cell(1, 2, () => {
    const gg = g.createLinearGradient(0, 0, cs, 0);
    gg.addColorStop(0, 'rgba(50,47,43,0)');
    gg.addColorStop(0.22, 'rgba(48,45,41,0.20)');
    gg.addColorStop(0.5, 'rgba(44,41,38,0.34)');
    gg.addColorStop(0.78, 'rgba(48,45,41,0.20)');
    gg.addColorStop(1, 'rgba(50,47,43,0)');
    g.fillStyle = gg; g.fillRect(0, 0, cs, cs);
    for (let i = 0; i < 40; i++) {
      const x = cs * rng.range(0.2, 0.8);
      g.strokeStyle = `rgba(38,35,32,${rng.range(0.05, 0.18)})`;
      g.lineWidth = cs * rng.range(0.006, 0.03);
      g.beginPath();
      g.moveTo(x, 0);
      g.quadraticCurveTo(x + cs * rng.jit(0.06), cs * 0.5, x + cs * rng.jit(0.09), cs);
      g.stroke();
    }
    g.globalCompositeOperation = 'destination-out';
    const fy = g.createLinearGradient(0, 0, 0, cs);
    fy.addColorStop(0, 'rgba(0,0,0,1)');
    fy.addColorStop(0.10, 'rgba(0,0,0,0)');
    fy.addColorStop(0.90, 'rgba(0,0,0,0)');
    fy.addColorStop(1, 'rgba(0,0,0,1)');
    g.fillStyle = fy; g.fillRect(0, 0, cs, cs);
    g.globalCompositeOperation = 'source-over';
  });

  /*
   * --- [2,2] drain sink
   * The dish of dirt that forms around a floor drain: darkest in a ring just
   * outside the grate, with the wash marks of everything that ever ran into it
   * converging from outside. Paired with the lit drain-cover decal.
   */
  cell(2, 2, () => {
    const c0 = cs * 0.5;
    const gg = g.createRadialGradient(c0, c0, cs * 0.06, c0, c0, cs * 0.48);
    gg.addColorStop(0, 'rgba(30,28,25,0.56)');
    gg.addColorStop(0.34, 'rgba(38,35,31,0.40)');
    gg.addColorStop(0.72, 'rgba(46,43,39,0.16)');
    gg.addColorStop(1, 'rgba(50,47,42,0)');
    g.fillStyle = gg; g.fillRect(0, 0, cs, cs);
    for (let i = 0; i < 20; i++) {
      const a = rng.range(0, Math.PI * 2);
      g.strokeStyle = `rgba(34,31,28,${rng.range(0.10, 0.30)})`;
      g.lineWidth = cs * rng.range(0.008, 0.032);
      g.beginPath();
      g.moveTo(c0 + Math.cos(a) * cs * 0.48, c0 + Math.sin(a) * cs * 0.48);
      g.lineTo(c0 + Math.cos(a + rng.jit(0.2)) * cs * 0.10, c0 + Math.sin(a + rng.jit(0.2)) * cs * 0.10);
      g.stroke();
    }
    g.globalCompositeOperation = 'destination-out';
    const f = g.createRadialGradient(c0, c0, cs * 0.34, c0, c0, cs * 0.5);
    f.addColorStop(0, 'rgba(0,0,0,0)');
    f.addColorStop(1, 'rgba(0,0,0,1)');
    g.fillStyle = f; g.fillRect(0, 0, cs, cs);
    g.globalCompositeOperation = 'source-over';
  });

  // --- [3,2] tight foot: the hard contact darkening right under an object
  cell(3, 2, () => pool(0.78, 0.30, '26,24,22'));

  const t = T.colorTex(A.c, 1);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}
