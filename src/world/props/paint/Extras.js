import * as THREE from 'three';
import { Rand } from '../Rand.js';

/**
 * Textures for the distance band and for ground decals. OWNER: props agent.
 *
 * Split out of TexPainters.js purely for file size — these are painters in
 * exactly the same sense, they just serve the two passes that were added in
 * round 5 (Backdrop.js and GroundDress.js) rather than the prop kit.
 */


/**
 * Treeline billboard, one wide strip.
 *
 * The far horizon of the round-5 combat shot was a flat white fence and nothing
 * else — no silhouette between the perimeter and the sky, which is what makes a
 * level read as a map rather than a place. A treeline is the cheapest thing that
 * fixes it: broken, organic, and it sits at exactly the frequency the eye uses
 * to judge distance. Painted as a strip so one quad carries eight or nine crowns
 * and the band never repeats visibly.
 */
export function buildTreeline(T, w = 1024, h = 256) {
  const A = T.canvasWH(w, h);
  const g = A.g;
  const rng = new Rand(9911);
  g.clearRect(0, 0, w, h);

  const crown = (cx, base, r, tint) => {
    // A crown is a clump of overlapping blobs with a ragged upper edge; a
    // smooth ellipse reads as a balloon at any distance.
    for (let i = 0; i < 16; i++) {
      const a = rng.range(0, Math.PI * 2);
      const rr = r * rng.range(0.30, 0.62);
      const px = cx + Math.cos(a) * r * rng.range(0, 0.85);
      const py = base - r * rng.range(0.15, 1.05) - rr * 0.2;
      g.fillStyle = tint(rng.next());
      g.beginPath();
      g.ellipse(px, py, rr, rr * rng.range(0.7, 1.05), rng.jit(0.5), 0, Math.PI * 2);
      g.fill();
    }
  };

  const dark = (t) => `rgb(${34 + (t * 26) | 0},${41 + (t * 30) | 0},${30 + (t * 20) | 0})`;
  const lit = (t) => `rgb(${58 + (t * 44) | 0},${66 + (t * 46) | 0},${44 + (t * 30) | 0})`;

  // back rank first, then a lit front rank — two ranks give the band depth
  for (let i = 0; i < 13; i++) {
    crown(w * (i + rng.jit(0.35)) / 13, h * 0.92, h * rng.range(0.28, 0.44), dark);
  }
  for (let i = 0; i < 10; i++) {
    crown(w * (i + 0.5 + rng.jit(0.4)) / 10, h * 0.99, h * rng.range(0.34, 0.56), lit);
  }
  // trunk line so the band has a base rather than floating
  g.fillStyle = 'rgba(38,40,32,0.92)';
  g.fillRect(0, h * 0.93, w, h * 0.07);
  for (let i = 0; i < 22; i++) {
    const x = rng.range(0, w);
    g.fillRect(x, h * 0.80, Math.max(1, w * 0.0022), h * 0.15);
  }

  const t = T.colorTex(A.c, 1);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

/**
 * Chimney plume / dust haze billboard. A vertical soft column with fbm bitten
 * out of it, so a stack has something rising off it instead of a hard-edged
 * cigar. Alpha only matters — the material tints it.
 */
export function buildPlume(T, size = 256) {
  const A = T.canvas(size);
  const g = A.g;
  g.clearRect(0, 0, size, size);
  const grd = g.createRadialGradient(size * 0.5, size * 0.72, size * 0.04, size * 0.5, size * 0.6, size * 0.52);
  grd.addColorStop(0, 'rgba(255,255,255,0.92)');
  grd.addColorStop(0.45, 'rgba(248,250,252,0.44)');
  grd.addColorStop(1, 'rgba(240,246,250,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, size, size);
  // billow: punch fbm through the alpha so the edge is torn, not feathered
  g.globalCompositeOperation = 'destination-out';
  const rng = new Rand(3311);
  for (let i = 0; i < 90; i++) {
    const a = rng.range(0, Math.PI * 2);
    const r = Math.sqrt(rng.next()) * size * 0.5;
    const px = size * 0.5 + Math.cos(a) * r;
    const py = size * 0.62 + Math.sin(a) * r * 0.95;
    const rr = size * rng.range(0.03, 0.12);
    const gg = g.createRadialGradient(px, py, 0, px, py, rr);
    gg.addColorStop(0, `rgba(0,0,0,${rng.range(0.25, 0.7)})`);
    gg.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gg;
    g.beginPath(); g.arc(px, py, rr, 0, Math.PI * 2); g.fill();
  }
  g.globalCompositeOperation = 'source-over';
  const t = T.colorTex(A.c, 1);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

/**
 * Ground-decal atlas, 4x4, straight alpha. Cells are addressed [col, row] with
 * row 3 at the TOP of the canvas (v grows upward), matching atlasRemap.
 *
 *   [0,3] tyre track   [1,3] scuff smear   [2,3] oil      [3,3] contact patch
 *   [0,2] dried puddle [1,2] crack net     [2,2] pale dust bloom
 *   [3,2] wall-base wash
 *   [0,1] grit wash    [1,1] paint splash
 *
 * WHY THE ATLAS GREW
 *   The round-5 courtyard is a pale, uniform slab across the middle of the
 *   frame, and the four marks the old atlas carried are all DARK and all roughly
 *   the same frequency. Flatness in a large light surface is not fixed by adding
 *   more of the same stain: it needs a value break in BOTH directions (the pale
 *   dust bloom and the efflorescence in the grit wash are lighter than the slab),
 *   a high-frequency element the eye can use to judge scale (the crack net and
 *   the grit wash), and something that reads as drainage rather than as spillage
 *   (the puddle ring and the wall-base wash).
 *
 * The contact patch is still the load-bearing one: several hundred pieces of
 * small litter are drawn without shadow casting (they are not worth a
 * shadow-cascade draw call each), and an unshadowed object on a flat floor reads
 * as hovering. One merged batch puts every one of them back on the ground.
 *
 * 1024 px over 4x4 keeps each cell at exactly the 256 px it had at 512/2x2.
 */
export function buildDecalAtlas(T, size = 1024) {
  const A = T.canvas(size);
  const g = A.g;
  const cs = size / 4;
  const rng = new Rand(7717);
  g.clearRect(0, 0, size, size);

  /** Move the origin to cell (col,row); row 3 is the top canvas row. */
  const cell = (col, row, draw) => {
    g.save();
    g.translate(col * cs, (3 - row) * cs);
    draw();
    g.restore();
  };

  // --- tyre track [0,3], runs vertically through the cell
  /*
   * A tyre track is a FILM of rubber and dust, not a painted stripe. The first
   * cut of this cell used ~0.25 base alpha with hard cell edges and it read in
   * the shot as black gaffer tape laid across the concrete. Everything here is
   * therefore weak — peak alpha 0.20 — and every one of the four cell edges is
   * feathered to zero so a strip has no boundary of its own at all.
   */
  g.save();
  const tread = 11;
  for (let i = 0; i < tread; i++) {
    const x = cs * (0.30 + (i / tread) * 0.40);
    for (let y = 0; y < cs; y += cs / 30) {
      g.fillStyle = `rgba(30,27,24,${rng.range(0.10, 0.20)})`;
      g.fillRect(x, y + rng.jit(1.5), cs * 0.024, cs * rng.range(0.014, 0.026));
    }
  }
  g.fillStyle = 'rgba(34,31,28,0.085)';
  g.fillRect(cs * 0.27, 0, cs * 0.46, cs);
  // dust pushed out either side of the contact patch
  for (const sgn of [-1, 1]) {
    const sm = g.createLinearGradient(cs * (0.5 + sgn * 0.23), 0, cs * (0.5 + sgn * 0.40), 0);
    sm.addColorStop(0, 'rgba(40,36,31,0.07)');
    sm.addColorStop(1, 'rgba(40,36,31,0)');
    g.fillStyle = sm;
    g.fillRect(sgn > 0 ? cs * 0.5 : 0, 0, cs * 0.5, cs);
  }
  // feather all four edges to nothing
  g.globalCompositeOperation = 'destination-out';
  const fadeX = g.createLinearGradient(0, 0, cs, 0);
  fadeX.addColorStop(0, 'rgba(0,0,0,1)');
  fadeX.addColorStop(0.14, 'rgba(0,0,0,0)');
  fadeX.addColorStop(0.86, 'rgba(0,0,0,0)');
  fadeX.addColorStop(1, 'rgba(0,0,0,1)');
  g.fillStyle = fadeX;
  g.fillRect(0, 0, cs, cs);
  const fadeY = g.createLinearGradient(0, 0, 0, cs);
  fadeY.addColorStop(0, 'rgba(0,0,0,1)');
  fadeY.addColorStop(0.10, 'rgba(0,0,0,0)');
  fadeY.addColorStop(0.90, 'rgba(0,0,0,0)');
  fadeY.addColorStop(1, 'rgba(0,0,0,1)');
  g.fillStyle = fadeY;
  g.fillRect(0, 0, cs, cs);
  g.globalCompositeOperation = 'source-over';
  g.restore();

  // --- scuff smear [1,3]
  cell(1, 3, () => {
    for (let i = 0; i < 40; i++) {
      const y = cs * rng.range(0.15, 0.85);
      g.strokeStyle = `rgba(40,37,33,${rng.range(0.03, 0.13)})`;
      g.lineWidth = cs * rng.range(0.004, 0.02);
      g.beginPath();
      g.moveTo(cs * rng.range(0.05, 0.3), y);
      g.quadraticCurveTo(cs * 0.5, y + cs * rng.jit(0.08), cs * rng.range(0.7, 0.96), y + cs * rng.jit(0.05));
      g.stroke();
    }
  });

  // --- oil stain [2,3]
  cell(2, 3, () => {
    for (let i = 0; i < 7; i++) {
      const px = cs * (0.5 + rng.jit(0.16));
      const py = cs * (0.5 + rng.jit(0.16));
      const rr = cs * rng.range(0.12, 0.34);
      const gg = g.createRadialGradient(px, py, 0, px, py, rr);
      gg.addColorStop(0, `rgba(16,14,13,${rng.range(0.26, 0.46)})`);
      gg.addColorStop(0.6, 'rgba(22,20,18,0.16)');
      gg.addColorStop(1, 'rgba(24,22,20,0)');
      g.fillStyle = gg;
      g.beginPath(); g.arc(px, py, rr, 0, Math.PI * 2); g.fill();
    }
  });

  // --- soft contact patch [3,3]
  cell(3, 3, () => {
    const cg = g.createRadialGradient(cs * 0.5, cs * 0.5, 0, cs * 0.5, cs * 0.5, cs * 0.48);
    cg.addColorStop(0, 'rgba(10,10,11,0.52)');
    cg.addColorStop(0.42, 'rgba(12,12,13,0.24)');
    cg.addColorStop(1, 'rgba(16,16,16,0)');
    g.fillStyle = cg;
    g.fillRect(0, 0, cs, cs);
  });

  /*
   * --- dried puddle [0,2]
   * What survives a puddle is not the water, it is the TIDE MARK: a dark damp
   * core, a bright ring of silt where the edge sat longest, and a scatter of
   * grit dropped out of suspension. Three concentric bands, all weak.
   */
  cell(0, 2, () => {
    const px = cs * 0.5, py = cs * 0.5;
    const R = cs * 0.44;
    for (let ring = 0; ring < 3; ring++) {
      const rr = R * (1 - ring * 0.22);
      const gg = g.createRadialGradient(px, py, rr * 0.55, px, py, rr);
      gg.addColorStop(0, 'rgba(38,36,33,0.09)');
      gg.addColorStop(0.72, `rgba(28,26,24,${0.18 - ring * 0.03})`);
      gg.addColorStop(0.90, `rgba(200,194,176,${0.20 - ring * 0.04})`);
      gg.addColorStop(1, 'rgba(200,194,176,0)');
      g.fillStyle = gg;
      g.save();
      g.translate(px, py);
      g.rotate(ring * 0.7);
      g.scale(1, 0.78 + ring * 0.08);
      g.translate(-px, -py);
      g.beginPath(); g.arc(px, py, rr, 0, Math.PI * 2); g.fill();
      g.restore();
    }
    for (let i = 0; i < 90; i++) {
      const a = rng.range(0, Math.PI * 2);
      const r = R * Math.sqrt(rng.next()) * 0.9;
      g.fillStyle = `rgba(74,68,58,${rng.range(0.05, 0.18)})`;
      g.fillRect(px + Math.cos(a) * r, py + Math.sin(a) * r * 0.8,
        cs * rng.range(0.004, 0.012), cs * rng.range(0.004, 0.010));
    }
  });

  /*
   * --- crack net [1,2]
   * Hairline shrinkage cracking. This is the only mark in the set with genuinely
   * high spatial frequency, which is what a big flat slab needs most: without it
   * the eye has nothing to measure the surface against and reads it as a plane.
   */
  cell(1, 2, () => {
    const walk = (x, y, a, len, w, depth) => {
      let px = x, py = y, ang = a;
      g.strokeStyle = `rgba(48,44,39,${0.46 - depth * 0.10})`;
      g.lineWidth = Math.max(0.6, w);
      g.beginPath();
      g.moveTo(px, py);
      const steps = 7;
      for (let i = 0; i < steps; i++) {
        ang += rng.jit(0.55);
        px += Math.cos(ang) * (len / steps);
        py += Math.sin(ang) * (len / steps);
        g.lineTo(px, py);
      }
      g.stroke();
      if (depth < 2 && len > cs * 0.09) {
        walk(px, py, ang + rng.range(0.5, 1.2), len * rng.range(0.35, 0.6), w * 0.6, depth + 1);
        walk(px, py, ang - rng.range(0.5, 1.2), len * rng.range(0.3, 0.55), w * 0.6, depth + 1);
      }
    };
    for (let i = 0; i < 5; i++) {
      walk(cs * rng.range(0.1, 0.9), cs * rng.range(0.1, 0.9),
        rng.range(0, Math.PI * 2), cs * rng.range(0.22, 0.40), cs * 0.008, 0);
    }
    // feather the cell edges so a crack decal has no rectangle around it
    g.globalCompositeOperation = 'destination-out';
    const f = g.createRadialGradient(cs * 0.5, cs * 0.5, cs * 0.24, cs * 0.5, cs * 0.5, cs * 0.5);
    f.addColorStop(0, 'rgba(0,0,0,0)');
    f.addColorStop(1, 'rgba(0,0,0,1)');
    g.fillStyle = f;
    g.fillRect(0, 0, cs, cs);
    g.globalCompositeOperation = 'source-over';
  });

  /*
   * --- pale dust bloom [2,2]
   * LIGHTER than the concrete under it: wind-drifted dust, lime bloom and dried
   * cement wash. Every other mark in the atlas darkens, and a slab covered only
   * in darkening marks still reads as one flat value with dirt on it.
   */
  cell(2, 2, () => {
    for (let i = 0; i < 9; i++) {
      const px = cs * (0.5 + rng.jit(0.24));
      const py = cs * (0.5 + rng.jit(0.24));
      const rr = cs * rng.range(0.14, 0.40);
      const gg = g.createRadialGradient(px, py, 0, px, py, rr);
      gg.addColorStop(0, `rgba(228,222,205,${rng.range(0.22, 0.40)})`);
      gg.addColorStop(0.55, 'rgba(222,216,199,0.16)');
      gg.addColorStop(1, 'rgba(216,210,193,0)');
      g.fillStyle = gg;
      g.beginPath(); g.arc(px, py, rr, 0, Math.PI * 2); g.fill();
    }
  });

  /*
   * --- wall-base wash [3,2]
   * A vertical gradient: dark and dirty at one edge, gone by the middle. Laid
   * along the foot of a wall it reads as run-off staining, which is the single
   * most reliable cue that a floor and a wall actually meet.
   */
  cell(3, 2, () => {
    const gg = g.createLinearGradient(0, 0, 0, cs);
    gg.addColorStop(0, 'rgba(28,26,23,0.30)');
    gg.addColorStop(0.30, 'rgba(34,31,28,0.15)');
    gg.addColorStop(0.72, 'rgba(40,37,33,0.04)');
    gg.addColorStop(1, 'rgba(40,37,33,0)');
    g.fillStyle = gg;
    g.fillRect(0, 0, cs, cs);
    for (let i = 0; i < 30; i++) {
      const x = cs * rng.next();
      const h = cs * rng.range(0.20, 0.72);
      const sg = g.createLinearGradient(0, 0, 0, h);
      sg.addColorStop(0, `rgba(26,24,21,${rng.range(0.08, 0.20)})`);
      sg.addColorStop(1, 'rgba(30,28,25,0)');
      g.fillStyle = sg;
      g.fillRect(x, 0, cs * rng.range(0.006, 0.030), h);
    }
    g.globalCompositeOperation = 'destination-out';
    const fx = g.createLinearGradient(0, 0, cs, 0);
    fx.addColorStop(0, 'rgba(0,0,0,1)');
    fx.addColorStop(0.12, 'rgba(0,0,0,0)');
    fx.addColorStop(0.88, 'rgba(0,0,0,0)');
    fx.addColorStop(1, 'rgba(0,0,0,1)');
    g.fillStyle = fx;
    g.fillRect(0, 0, cs, cs);
    g.globalCompositeOperation = 'source-over';
  });

  /*
   * --- grit wash [0,1]
   * A speckle of individual aggregate grains, dark and light together. Laid in a
   * drift against a kerb it costs two triangles and does the job that would
   * otherwise need three hundred instanced pebbles.
   */
  cell(0, 1, () => {
    for (let i = 0; i < 700; i++) {
      const px = cs * rng.next();
      const py = cs * rng.next();
      // density falls off toward the cell edge so a drift has a soft boundary
      const d = Math.hypot(px - cs * 0.5, py - cs * 0.5) / (cs * 0.5);
      if (rng.next() < d * d * 1.15) continue;
      const light = rng.bool(0.42);
      const a = rng.range(0.10, 0.42) * (1 - d * 0.6);
      g.fillStyle = light
        ? `rgba(212,205,186,${a})`
        : `rgba(58,52,44,${a})`;
      const s = cs * rng.range(0.004, 0.016);
      g.fillRect(px, py, s, s * rng.range(0.7, 1.3));
    }
  });

  /*
   * --- paint splash / faded line fragment [1,1]
   * A broken remnant of a painted bay line. Level markings are crisp; what a
   * yard actually has is 40% of a line with the rest worn off.
   */
  cell(1, 1, () => {
    g.fillStyle = 'rgba(226,208,120,0.42)';
    for (let i = 0; i < 5; i++) {
      const y = cs * rng.range(0.28, 0.62);
      g.fillRect(cs * rng.range(0, 0.6), y, cs * rng.range(0.12, 0.40), cs * rng.range(0.05, 0.10));
    }
    // scrub most of it away again
    g.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 60; i++) {
      const px = cs * rng.next(), py = cs * rng.next();
      const rr = cs * rng.range(0.02, 0.10);
      const gg = g.createRadialGradient(px, py, 0, px, py, rr);
      gg.addColorStop(0, `rgba(0,0,0,${rng.range(0.3, 0.9)})`);
      gg.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gg;
      g.beginPath(); g.arc(px, py, rr, 0, Math.PI * 2); g.fill();
    }
    g.globalCompositeOperation = 'source-over';
  });

  return T.colorTex(A.c, 1);
}
