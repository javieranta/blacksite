#!/usr/bin/env node
/**
 * SURFACECHECK — does the floor carry a SURFACE STORY, or just grain?
 *
 * WHY THIS EXISTS, AND WHY groundcheck.mjs WAS NOT ENOUGH
 *   tools/groundcheck.mjs already ablates the authored ground content and reports
 *   `coverage`, `meanDelta` and `blockStd`. It PASSES on the round-10 build. The
 *   reviewer, looking at the same frames, still wrote:
 *
 *     "the bottom 30% of interior, the centre deck of combat and hud ... are
 *      uniform slabs carrying a noise grain and a couple of seam lines"
 *
 *   Both are true, because `blockStd` is the mean of the WITHIN-block standard
 *   deviations. That statistic is maximised by high-frequency detail: a speckle
 *   normal map, an aggregate albedo, a shadow stripe crossing a block. It is
 *   almost completely blind to the thing the eye actually calls flatness, which
 *   is that every block has the SAME MEAN as its neighbours. A slab covered in
 *   perfect noise scores well on blockStd and reads as a uniform slab.
 *
 *   So the instrument here is the complementary statistic:
 *
 *     MACRO SPREAD = the standard deviation ACROSS 32-px block MEANS.
 *
 *   Noise grain contributes ~0 to it (it averages out inside each block). Large
 *   authored content — a grime gradient at a wall base, an oil pool, a tyre
 *   track, a drainage stain — is exactly what moves it.
 *
 * ATTRIBUTION. Macro spread on its own still cannot tell an oil stain from a
 * shadow stripe or from a prop standing on the floor, so every number is
 * measured TWICE: once as rendered, once with the authored ground meshes hidden.
 * The difference is the part this system is responsible for. That is the gate.
 *
 * THE THIRD NUMBER, and the most legible one:
 *     DEAD BLOCKS = the share of 32-px blocks the authored content does not move
 *     by even 1/255. "62% of the floor has nothing on it" is the reviewer's
 *     sentence, in a number.
 *
 * WHY THE HEADLINE NUMBER IS A LOG RESIDUAL AND NOT RAW MACRO SPREAD
 *   The first cut of this tool gated on the raw std across block means. Two
 *   things were wrong with it, and both were found by running it against a real
 *   fix rather than by reasoning:
 *
 *   1. It is dominated by LIGHTING, not by surface. The lower third of the
 *      interior framing contains a sunlit floor, a wall in shadow and a shaft of
 *      light; its raw block-mean spread is ~50/255 before any authored content
 *      exists at all. Content worth several units of spread disappears into that.
 *
 *   2. It punishes exactly the right fix. Dirt is a MULTIPLY. Multiplying a
 *      region by 0.85 scales its standard deviation by 0.85 as well, so a
 *      correctly-built grime layer that darkens the floor unevenly can still
 *      REDUCE absolute spread — measured, -1.79 on a build that had just gone
 *      from 99.3% to 4.8% dead blocks. Gating on that number would have rejected
 *      the fix and sent the next round chasing the wrong thing.
 *
 *   So the gate is the std of the block means of LOG luminance, with the local
 *   5x5-block trend subtracted:
 *
 *     log      a uniform multiply is a constant offset in log space and cancels;
 *              only SPATIALLY VARYING modulation survives, which is the
 *              definition of surface story.
 *     detrend  removes the sun/shade gradient and the wall, leaving the
 *              32-160 px band — the scale at which a slab reads as uniform.
 *
 *   Raw macro spread is still reported, because it is what a reviewer's eye
 *   integrates; it is simply not the thing to gate on.
 *
 * Usage:
 *   node tools/surfacecheck.mjs                       # interior, combat, hero-golden
 *   node tools/surfacecheck.mjs --views interior,vertical,silhouette-dusk
 *   node tools/surfacecheck.mjs --json tools/out/surface.json
 *
 * The region measured is per view and is not a flag — see REGIONS below.
 * Exits non-zero when either gate fails on any view.
 */
import fs from 'node:fs';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };

/**
 * The framings the review named. `hud` renders the same world as `combat` once
 * the viewmodel is off, so it is covered by `combat` and is not shot twice.
 */
const VIEWS = {
  interior: 'tod=midday&pos=-8,1.7,-4&yaw=90&pitch=0',
  combat: 'tod=golden&pos=4,1.7,6&yaw=195&pitch=-0.02',
  'hero-golden': 'tod=golden&pos=6,1.7,14&yaw=200&pitch=-0.04',
  vertical: 'tod=morning&pos=0,6.5,0&yaw=45&pitch=-0.55',
  'silhouette-dusk': 'tod=dusk&pos=20,1.7,0&yaw=270&pitch=0.02',
};
const want = opt('views', 'interior,combat,hero-golden').split(',').map((s) => s.trim());

/**
 * THE REGION MEASURED, PER VIEW — and this is not a convenience, it is the
 * difference between measuring the defect and measuring something else.
 *
 * The first cut used one band, "the lower third", for every framing. It reads
 * correctly for interior, where the review's words were literally "the bottom
 * 30% of interior". It is wrong for hero-golden, whose lower third is a
 * foreground ring of pallets and steel plate standing in shadow — 84% of those
 * blocks contain no floor at all, so no amount of floor content can ever move
 * them and the tool reports a permanent, unfixable FAIL. A gate that cannot be
 * satisfied by fixing the defect is not a gate, it is noise.
 *
 * Each rectangle below is the region the round-10 review named, in normalised
 * coordinates with y measured UP FROM THE BOTTOM of the frame (readPixels
 * order). Quoted phrases are the review's.
 */
const REGIONS = {
  interior: { x0: 0.04, x1: 0.96, y0: 0.00, y1: 0.30 },        // "bottom 30% of interior"
  combat: { x0: 0.05, x1: 0.72, y0: 0.02, y1: 0.40 },          // "the centre deck of combat and hud"
  hud: { x0: 0.05, x1: 0.72, y0: 0.02, y1: 0.40 },
  vertical: { x0: 0.02, x1: 0.55, y0: 0.00, y1: 0.42 },        // "the bottom-left of vertical"
  /*
   * "the centre ground and left facade". NOTE for whoever reads a FAIL here:
   * this rectangle is roughly half VERTICAL surface — the blockhouse and the
   * admin-block facade stand right through it — and the props surface-story
   * pass only writes horizontal ground. A high dead-block count on this view is
   * therefore partly a true finding (nothing on the facade) and partly the
   * region including geometry no ground pass can ever reach.
   */
  'silhouette-dusk': { x0: 0.18, x1: 0.85, y0: 0.10, y1: 0.44 },
  // Not named by the review; the mid-ground apron is this framing's flat
  // expanse, and it is carried as a control.
  'hero-golden': { x0: 0.15, x1: 0.78, y0: 0.15, y1: 0.46 },
};

/* --------------------------------- gates --------------------------------- */
/**
 * Calibrated against the round-10 build, which is the DEFECT. Measured there,
 * over the lower third of each frame:
 *
 *   interior      authored texture 0.0x, 99.3% dead blocks
 *   hero-golden   authored texture 0.1x, 91.1% dead blocks
 *   combat        authored texture 5.x,  73.6% dead blocks
 *
 * combat already carried real content and still read as flat, which is what
 * fixes the level of the gates: content has to be PRESENT (dead blocks) as well
 * as VARIED (texture). Either one alone passes a floor the review rejected.
 */
const MIN_AUTHORED_TEXTURE = 0.9; // detrended log-block-mean std x100, authored share
const MAX_DEAD_BLOCKS = 45;       // % of blocks the authored content never touches

const PROBE = `(R) => {
  const eng = window.__blacksite.engine;
  const gl = eng.renderer.getContext();
  const W = eng.renderer.domElement.width, H = eng.renderer.domElement.height;
  /**
   * Everything this props system draws onto the ground. prop:decal and prop:wet
   * are the merged mark batches; the rest are the three-dimensional half of the
   * same job. Nothing else in the scene is touched, so the diff can only be the
   * authored surface content.
   */
  const GROUND = /^prop:(decal|grime|wet|grit|chip|brickbit|drift|rubble|litter|leaf|paper|papers|cardflat|shard|gravel|puddle|bolt|nut|washer|crumb)/i;

  const targets = [];
  eng.scene.traverse((n) => { if ((n.isMesh || n.isInstancedMesh) && GROUND.test(n.name || '')) targets.push(n); });
  const saved = targets.map((m) => m.visible);

  eng.stop();
  const grab = () => {
    eng._frame();
    const out = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, out);
    return out;
  };
  const withIt = grab();
  targets.forEach((m) => { m.visible = false; });
  const without = grab();
  targets.forEach((m, i) => { m.visible = saved[i]; });
  eng.start();

  // readPixels is bottom-up: the on-screen lower band is the LOW y rows.
  const y0 = Math.floor(H * R.y0), y1 = Math.floor(H * R.y1);
  const x0 = Math.floor(W * R.x0), x1 = Math.floor(W * R.x1);
  const lum = (b, i) => 0.2126 * b[i] + 0.7152 * b[i + 1] + 0.0722 * b[i + 2];

  const B = 32;
  const COLS = Math.floor((x1 - x0) / B);
  const ROWS = Math.floor((y1 - y0) / B);
  /** Block means of luminance, and of log luminance, as COLS x ROWS grids. */
  const meansOf = (buf, log) => {
    const out = [];
    for (let br = 0; br < ROWS; br++) {
      for (let bc = 0; bc < COLS; bc++) {
        const by = y0 + br * B, bx = x0 + bc * B;
        let s = 0;
        for (let y = by; y < by + B; y++) {
          for (let x = bx; x < bx + B; x++) {
            const v = lum(buf, (y * W + x) * 4);
            s += log ? Math.log(1 + v) : v;
          }
        }
        out.push(s / (B * B));
      }
    }
    return out;
  };
  /**
   * Subtract the local 5x5-block trend. What is left is variation at the
   * 32-160 px scale: the scale at which a slab reads as a uniform slab, with the
   * sun/shade gradient and the wall taken out.
   */
  const detrend = (grid) => {
    const R = 2;
    const out = new Array(grid.length);
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        let s = 0, n = 0;
        for (let dr = -R; dr <= R; dr++) {
          const rr = r + dr; if (rr < 0 || rr >= ROWS) continue;
          for (let dc = -R; dc <= R; dc++) {
            const cc = c + dc; if (cc < 0 || cc >= COLS) continue;
            s += grid[rr * COLS + cc]; n++;
          }
        }
        out[r * COLS + c] = grid[r * COLS + c] - s / n;
      }
    }
    return out;
  };
  /** Mean WITHIN-block std — the statistic groundcheck reports, for comparison. */
  const withinOf = (buf) => {
    let acc = 0, n = 0;
    for (let by = y0; by + B <= y1; by += B) {
      for (let bx = x0; bx + B <= x1; bx += B) {
        let s = 0, s2 = 0;
        for (let y = by; y < by + B; y++) {
          for (let x = bx; x < bx + B; x++) {
            const v = lum(buf, (y * W + x) * 4);
            s += v; s2 += v * v;
          }
        }
        const m = s / (B * B);
        acc += Math.sqrt(Math.max(0, s2 / (B * B) - m * m));
        n++;
      }
    }
    return n ? acc / n : 0;
  };
  const std = (a) => {
    if (!a.length) return 0;
    let s = 0; for (const v of a) s += v;
    const m = s / a.length;
    let s2 = 0; for (const v of a) s2 += (v - m) * (v - m);
    return Math.sqrt(s2 / a.length);
  };

  const mWith = meansOf(withIt, false), mWithout = meansOf(without, false);
  const tWith = std(detrend(meansOf(withIt, true))) * 100;
  const tWithout = std(detrend(meansOf(without, true))) * 100;
  let dead = 0, moveSum = 0;
  for (let i = 0; i < mWith.length; i++) {
    const d = Math.abs(mWith[i] - mWithout[i]);
    moveSum += d;
    if (d < 1.0) dead++;
  }

  // Per-pixel coverage, kept so this tool can be read next to groundcheck.
  let px = 0, moved = 0, sum = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * W + x) * 4;
      px++;
      const d = Math.abs(lum(withIt, i) - lum(without, i));
      if (d > 2) { moved++; sum += d; }
    }
  }

  return {
    resolution: W + 'x' + H,
    meshes: targets.length,
    blocks: mWith.length,
    textureWith: +tWith.toFixed(2),
    textureWithout: +tWithout.toFixed(2),
    macroWith: +std(mWith).toFixed(2),
    macroWithout: +std(mWithout).toFixed(2),
    withinWith: +withinOf(withIt).toFixed(2),
    withinWithout: +withinOf(without).toFixed(2),
    blockMove: +(moveSum / Math.max(1, mWith.length)).toFixed(2),
    deadBlocks: +((dead / Math.max(1, mWith.length)) * 100).toFixed(1),
    coverage: +((moved / Math.max(1, px)) * 100).toFixed(2),
    meanDelta: +(sum / Math.max(1, moved)).toFixed(2),
  };
}`;

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=d3d11', '--disable-gpu-sandbox', '--ignore-gpu-blocklist'],
});

let failed = false;
const out = {};
for (const view of want) {
  const q = VIEWS[view];
  if (!q) { console.log(`${view}: unknown view`); continue; }
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  try {
    await page.goto(`http://127.0.0.1:5180/?freeze=1&hud=0&vm=0&quality=cinematic&${q}`,
      { waitUntil: 'domcontentloaded', timeout: 600000 });
    await page.waitForFunction('window.__ready === true', null, { timeout: 600000 });
    await page.waitForTimeout(900);
    const r = await page.evaluate(`(${PROBE})(${JSON.stringify(REGIONS[view] ?? REGIONS.interior)})`);
    out[view] = r;
    const authored = +(r.textureWith - r.textureWithout).toFixed(2);
    r.authoredTexture = authored;
    r.authoredMacro = +(r.macroWith - r.macroWithout).toFixed(2);
    const okTex = authored >= MIN_AUTHORED_TEXTURE;
    const okDead = r.deadBlocks <= MAX_DEAD_BLOCKS;
    if (!okTex || !okDead) failed = true;
    const R = REGIONS[view] ?? REGIONS.interior;
    console.log(`\n=== ${view} (${r.resolution}) — x ${R.x0}-${R.x1}, y ${R.y0}-${R.y1} up from the `
      + `bottom, ${r.blocks} blocks of 32px, ${r.meshes} ground meshes ablated ===`);
    console.log(`  ${okTex ? 'PASS' : 'FAIL'} authored surface texture  ${authored.toFixed(2)}  `
      + `(${r.textureWith} rendered - ${r.textureWithout} ablated)   need >= ${MIN_AUTHORED_TEXTURE}`);
    console.log(`  ${okDead ? 'PASS' : 'FAIL'} dead blocks              ${r.deadBlocks}%  of blocks the `
      + `authored content moves by < 1/255   need <= ${MAX_DEAD_BLOCKS}%`);
    console.log(`       raw macro spread ${r.authoredMacro}/255 (${r.macroWith} vs ${r.macroWithout}) — `
      + 'lighting-dominated, reported not gated; a multiply layer scales it down by design');
    console.log(`       mean block shift ${r.blockMove}/255 · per-pixel coverage ${r.coverage}% `
      + `at ${r.meanDelta}/255`);
    console.log(`       WITHIN-block std ${r.withinWith} (ablated ${r.withinWithout}) — this is `
      + 'groundcheck\'s number; grain and shadow stripes, not content');
    if (!okTex) {
      console.log('  -> the marks are high-frequency only: they change pixels, they do not change '
        + 'the VALUE of one patch of floor relative to the next, which is what reads as flat');
    }
  } catch (err) {
    console.log(`${view}: ${String(err.message).slice(0, 200)}`);
    failed = true;
  }
  await page.close();
}
await browser.close();

const jsonOut = opt('json', null);
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(out, null, 1));
console.log(`\n${failed ? 'FAIL' : 'PASS'} — the floor ${failed
  ? 'is a uniform slab with grain on it'
  : 'carries authored large-scale surface variation'}`);
process.exitCode = failed ? 1 : 0;
