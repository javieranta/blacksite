#!/usr/bin/env node
/**
 * Which GPU does the browser actually use — and what does the game really cost
 * on it?
 *
 * This machine is a hybrid-graphics laptop: an NVIDIA RTX 5090 Laptop GPU
 * alongside Intel integrated graphics, with the Intel adapter driving the panel.
 * Headless Chromium picked the Intel one, which is why the game measured at
 * 6fps. A real browser window may or may not do the same, and that single fact
 * changes the entire optimisation target.
 *
 * Runs HEADED on purpose. A headed window has a real swap chain, so
 * requestAnimationFrame is paced by actual presentation and finally reflects GPU
 * load — unlike headless, where rAF runs on a virtual 60Hz clock and reports a
 * flat 60fps no matter what.
 *
 * Usage: node tools/whichgpu.mjs [--seconds 6]
 */
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const SECONDS = parseFloat(opt('seconds', '6'));

/**
 * Launch variants. `default` is the closest thing to what a user's own Chrome
 * does; the others test whether the discrete GPU can be forced.
 */
const VARIANTS = [
  { name: 'default (as a user runs it)', args: [] },
  { name: 'angle=d3d11', args: ['--use-angle=d3d11'] },
  { name: 'force high-performance', args: ['--force_high_performance_gpu'] },
  { name: 'angle=d3d11 + high-perf', args: ['--use-angle=d3d11', '--force_high_performance_gpu'] },
];

const RENDERER = `(() => {
  const out = {};
  for (const pref of ['default', 'high-performance', 'low-power']) {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2', pref === 'default' ? {} : { powerPreference: pref });
    if (!gl) { out[pref] = 'no context'; continue; }
    const d = gl.getExtension('WEBGL_debug_renderer_info');
    out[pref] = d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'masked';
  }
  return out;
})()`;

/** Real presented-frame intervals. Meaningful only in a headed window. */
const MEASURE = (secs) => `new Promise((resolve) => {
  const t = [];
  let last = performance.now();
  const end = last + ${secs} * 1000;
  const tick = (now) => {
    t.push(now - last); last = now;
    if (now < end) requestAnimationFrame(tick);
    else {
      const s = t.slice(10).sort((a, b) => a - b);
      const pick = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
      resolve({ frames: s.length, median: +pick(0.5).toFixed(1), p95: +pick(0.95).toFixed(1) });
    }
  };
  requestAnimationFrame(tick);
})`;

for (const v of VARIANTS) {
  let browser;
  try {
    browser = await chromium.launch({ headless: false, args: v.args });
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });

    await page.goto('about:blank');
    const r = await page.evaluate(RENDERER);
    const short = (s) => String(s).replace(/^ANGLE \(/, '').replace(/\)$/, '').slice(0, 78);

    console.log(`\n--- ${v.name} ---`);
    console.log(`  default          : ${short(r.default)}`);
    console.log(`  high-performance : ${short(r['high-performance'])}`);
    console.log(`  low-power        : ${short(r['low-power'])}`);

    // Only bother timing the game on the variant a user would actually get.
    if (v.name.startsWith('default')) {
      await page.goto('http://127.0.0.1:5180/?tod=golden&hud=0&quality=high',
        { waitUntil: 'domcontentloaded', timeout: 300000 });
      await page.waitForFunction('window.__ready === true', null, { timeout: 300000 });
      await page.waitForTimeout(2000);
      const inGame = await page.evaluate(`(() => {
        const gl = window.__blacksite.engine.renderer.getContext();
        const d = gl.getExtension('WEBGL_debug_renderer_info');
        return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'masked';
      })()`);
      console.log(`  THE GAME'S CONTEXT: ${short(inGame)}`);
      const m = await page.evaluate(MEASURE(SECONDS));
      console.log(`  real presented frames: median ${m.median}ms (${(1000 / m.median).toFixed(0)}fps),`
        + ` p95 ${m.p95}ms  [${m.frames} frames, headed = real swap chain]`);
    }
    await browser.close();
  } catch (err) {
    console.log(`\n--- ${v.name} ---\n  failed: ${String(err.message).slice(0, 120)}`);
    await browser?.close().catch(() => {});
  }
}
