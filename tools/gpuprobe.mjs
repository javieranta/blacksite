#!/usr/bin/env node
/**
 * GPU-time probe.
 *
 * WHY THIS EXISTS. Headless Chromium has no swap chain, so requestAnimationFrame
 * is paced by a virtual 60Hz clock and never blocks on GPU completion. A scene
 * that takes 200ms of GPU time still reports 16.7ms rAF intervals and "60fps".
 * Every frame-rate figure in this project's history came from that, which is why
 * the game measured as smooth here while being unplayable on a real display.
 *
 * This measures actual GPU cost two ways:
 *   1. EXT_disjoint_timer_query_webgl2 where available — true GPU nanoseconds.
 *   2. Otherwise a forced pipeline flush: render, then a 1x1 readPixels, which
 *      blocks the CPU until the GPU has finished the frame. Wall-clock around
 *      that is a sound lower bound on GPU cost.
 *
 * Two things this probe got wrong before, both fixed here and both large enough
 * to have inverted its conclusions:
 *
 *   1. It drove eng._frame() by hand but never stopped Engine.start()'s own rAF
 *      loop, which in headless Chromium is paced by a virtual 60Hz clock and
 *      kept queueing whole extra frames between the manual ones. The composer
 *      chain ran ~2.4x per "frame" it believed it was timing — and because that
 *      inflation is a roughly fixed amount of wall time rather than a fixed
 *      multiple, it compressed the gap between fast and slow configs. That is
 *      where "'low' is only 11% faster than 'high'" came from; measured with the
 *      loop stopped, 'low' is about twice as fast as 'high'.
 *   2. It reported the CANVAS size as the buffer. PostFX renders the whole chain
 *      at RENDER.resolutionScale x the canvas, so every preset appeared to
 *      render at 1920x1080 when 'low' was really rendering at 1344x756.
 *
 * Usage: node tools/gpuprobe.mjs [--frames 40] [--dpr 1,2] [--repeats 3]
 */
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const FRAMES = parseInt(opt('frames', '40'), 10);
const DPRS = opt('dpr', '1,2').split(',').map(Number);
/** Interleaved passes over the config list — see the round-robin note below. */
const REPEATS = parseInt(opt('repeats', '3'), 10);

const CONFIGS = [
  { name: 'cinematic',         q: 'cinematic', extra: '' },
  { name: 'high',              q: 'high',      extra: '' },
  { name: 'medium',            q: 'medium',    extra: '' },
  { name: 'low',               q: 'low',       extra: '' },
  { name: 'high, no post',     q: 'high',      extra: '&postfx=0' },
  { name: 'high, no ai',       q: 'high',      extra: '&ai=0' },
  { name: 'low, no post/ai',   q: 'low',       extra: '&postfx=0&ai=0' },
];

/** Render `n` frames, each forced to complete, and return ms percentiles. */
const MEASURE = (n) => `(async () => {
  const eng = window.__blacksite.engine;
  const gl = eng.renderer.getContext();
  const px = new Uint8Array(4);
  const samples = [];
  const js = [];
  const flush = [];

  // STOP THE ENGINE'S OWN rAF LOOP FIRST.
  //
  // Driving eng._frame() by hand does NOT stop Engine.start()'s
  // requestAnimationFrame loop, and in headless Chromium that loop is paced by a
  // virtual 60Hz clock which never blocks on the GPU — so it keeps queueing
  // whole extra frames in the gaps between our manual ones, and readPixels then
  // waits for all of them. Measured with tools/passprobe.mjs, the composer chain
  // ran 2.4x per "frame" this function believed it was timing. Every number this
  // probe printed before this line existed was that inflated.
  eng.stop();
  try {

  for (let i = 0; i < ${n}; i++) {
    const t0 = performance.now();
    eng._frame();
    const t1 = performance.now();
    // readPixels blocks until the GPU has drained the command queue for this
    // frame — this is what converts async GPU work into measurable wall time.
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const t2 = performance.now();
    samples.push(t2 - t0);
    js.push(t1 - t0);
    flush.push(t2 - t1);
    await new Promise((r) => setTimeout(r, 0));
  }

  // Drop the first few: shader/pipeline warm-up, not steady state.
  const med = (a) => { const s = a.slice(5).sort((x, y) => x - y); return s[s.length >> 1]; };
  const s = samples.slice(5).sort((a, b) => a - b);
  const pick = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
  const canvas = eng.renderer.domElement;
  const postfx = eng.systems.get('postfx');
  // The canvas is NOT the buffer the scene is rendered into: PostFX runs the
  // whole chain at RENDER.resolutionScale x the canvas. Reporting the canvas
  // made every preset look like it rendered at 1920x1080.
  const bw = postfx && postfx._bufW ? postfx._bufW : canvas.width;
  const bh = postfx && postfx._bufH ? postfx._bufH : canvas.height;
  return {
    median: +pick(0.5).toFixed(1),
    p95: +pick(0.95).toFixed(1),
    best: +s[0].toFixed(1),
    js: +med(js).toFixed(1),
    flush: +med(flush).toFixed(1),
    buffer: bw + 'x' + bh,
    canvas: canvas.width + 'x' + canvas.height,
    pixels: +(bw * bh / 1e6).toFixed(2),
  };

  } finally { eng.start(); }
})()`;

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=d3d11', '--disable-gpu-sandbox', '--ignore-gpu-blocklist'],
});

const HEAD = 'config                 buffer        Mpx    median      p95       js    flush    -> fps';

let gpuName = null;
for (const dpr of DPRS) {
  console.log(`\n=== deviceScaleFactor ${dpr} ===`);

  /**
   * ROUND-ROBIN, NOT ONE CONFIG AT A TIME.
   *
   * This GPU throttles under sustained load: measured back to back in a fixed
   * order, whichever config runs first wins. A straight sequential sweep put
   * 'cinematic' at 66ms and 'high' at 103ms — cinematic is strictly more work
   * than high, so that ordering artefact was larger than every real difference
   * in the table. Cycling through the configs REPEATS times and taking the
   * median of each config's repeats spreads the thermal ramp evenly across all
   * of them.
   */
  const runs = new Map(CONFIGS.map((c) => [c.name, []]));

  for (let rep = 0; rep < REPEATS; rep++) {
    // Rotate the starting point each repeat so no config is always measured on
    // a cold GPU.
    const order = CONFIGS.map((_, i) => CONFIGS[(i + rep) % CONFIGS.length]);
    for (const c of order) {
      const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: dpr });
      try {
        await page.goto(`http://127.0.0.1:5180/?tod=golden&hud=0&freeze=1&pos=6,1.7,14&yaw=200&pitch=-0.04`
          + `&quality=${c.q}${c.extra}`, { waitUntil: 'domcontentloaded', timeout: 300000 });
        try {
          await page.waitForFunction('window.__ready === true', null, { timeout: 300000 });
        } catch { console.log(`${c.name.padEnd(22)} never ready`); continue; }
        await page.waitForTimeout(800);

        if (!gpuName) {
          gpuName = await page.evaluate(() => {
            const gl = document.createElement('canvas').getContext('webgl2');
            const d = gl?.getExtension('WEBGL_debug_renderer_info');
            return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'unknown';
          });
          console.log(`GPU: ${gpuName}`);
          console.log(`${REPEATS} interleaved repeats x ${FRAMES} frames per config, simulation frozen.\n`);
        }

        runs.get(c.name).push(await page.evaluate(MEASURE(FRAMES)));
      } catch (err) {
        // A late HMR reload can destroy the execution context mid-measure.
        console.log(`${c.name.padEnd(22)} measure failed: ${String(err.message).slice(0, 60)}`);
      } finally {
        await page.close();
      }
    }
  }

  console.log(HEAD);
  const med = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];
  for (const c of CONFIGS) {
    const rs = runs.get(c.name);
    if (!rs.length) { console.log(`${c.name.padEnd(22)} no samples`); continue; }
    const m = {
      median: med(rs.map((r) => r.median)),
      p95: med(rs.map((r) => r.p95)),
      js: med(rs.map((r) => r.js)),
      flush: med(rs.map((r) => r.flush)),
      buffer: rs[0].buffer,
      pixels: rs[0].pixels,
    };
    const spread = rs.length > 1
      ? `  (${Math.min(...rs.map((r) => r.median)).toFixed(0)}-${Math.max(...rs.map((r) => r.median)).toFixed(0)}ms over ${rs.length})`
      : '';
    console.log(
      `${c.name.padEnd(22)} ${m.buffer.padEnd(12)} ${String(m.pixels).padStart(5)}`
      + ` ${String(m.median.toFixed(1)).padStart(8)}ms ${String(m.p95.toFixed(1)).padStart(7)}ms`
      + ` ${String(m.js.toFixed(1)).padStart(7)}ms ${String(m.flush.toFixed(1)).padStart(6)}ms`
      + ` ${String((1000 / m.median).toFixed(0)).padStart(7)}${spread}`,
    );
  }
}
await browser.close();
