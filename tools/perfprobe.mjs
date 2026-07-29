#!/usr/bin/env node
/**
 * Honest performance probe.
 *
 * The in-engine FPS counter divides frames by accumulated `dt`, and `dt` is
 * clamped to 0.1s in Engine._frame — so a real 5fps reports as 10fps and the
 * counter structurally cannot read below 10. Every "60fps" in this repo's
 * history came from that counter, at deviceScaleFactor 1.
 *
 * This measures real wall-clock frame intervals from inside the page via
 * requestAnimationFrame timestamps, and sweeps the configurations a real user
 * actually runs: device pixel ratio (a high-DPI display quadruples the pixel
 * count), quality preset, and with subsystems disabled to attribute cost.
 *
 * Usage: node tools/perfprobe.mjs [--dpr 1,2] [--seconds 6]
 */
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const SECONDS = parseFloat(opt('seconds', '6'));
const DPRS = opt('dpr', '1,2').split(',').map(Number);

/** Configurations to attribute cost. `q` is the quality preset. */
const CONFIGS = [
  { name: 'cinematic',          q: 'cinematic', extra: '' },
  { name: 'high',               q: 'high',      extra: '' },
  { name: 'medium',             q: 'medium',    extra: '' },
  { name: 'low',                q: 'low',       extra: '' },
  { name: 'cinematic no-post',  q: 'cinematic', extra: '&postfx=0' },
  { name: 'cinematic no-ai',    q: 'cinematic', extra: '&ai=0' },
  { name: 'low no-post no-ai',  q: 'low',       extra: '&postfx=0&ai=0' },
];

/**
 * Sample real frame intervals in-page. Returns percentiles in ms — the median
 * is what the game feels like, p95 is what makes it feel broken.
 */
const MEASURE = (secs) => `new Promise((resolve) => {
  const t = [];
  let last = performance.now();
  const end = last + ${secs} * 1000;
  const tick = (now) => {
    t.push(now - last);
    last = now;
    if (now < end) requestAnimationFrame(tick);
    else {
      t.sort((a, b) => a - b);
      const pick = (p) => t[Math.min(t.length - 1, Math.floor(t.length * p))];
      resolve({
        frames: t.length,
        median: +pick(0.5).toFixed(2),
        p95: +pick(0.95).toFixed(2),
        best: +t[0].toFixed(2),
        worst: +t[t.length - 1].toFixed(2),
      });
    }
  };
  requestAnimationFrame(tick);
})`;

console.log(`sampling ${SECONDS}s per config, real rAF intervals\n`);

for (const dpr of DPRS) {
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-gl=angle', '--use-angle=d3d11', '--enable-unsafe-swiftshader',
           '--disable-gpu-sandbox', '--ignore-gpu-blocklist'],
  });
  const page = await browser.newPage({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: dpr,
  });

  let gpu = null;
  console.log(`=== deviceScaleFactor ${dpr}  (renders at ${1920 * dpr}x${1080 * dpr}) ===`);
  console.log('config                   median   p95     fps   draws    tris');

  for (const c of CONFIGS) {
    const url = `http://127.0.0.1:5180/?tod=golden&hud=0&quality=${c.q}${c.extra}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 180000 });
    try {
      await page.waitForFunction('window.__ready === true', null, { timeout: 300000 });
    } catch {
      console.log(`${c.name.padEnd(24)} never became ready`);
      continue;
    }
    await page.waitForTimeout(1500);

    if (!gpu) {
      gpu = await page.evaluate(() => {
        const gl = document.createElement('canvas').getContext('webgl2');
        const d = gl?.getExtension('WEBGL_debug_renderer_info');
        return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'unknown';
      });
      console.log(`GPU: ${gpu}\n`);
      console.log('config                   median   p95     fps   draws    tris');
    }

    const m = await page.evaluate(MEASURE(SECONDS));
    const s = await page.evaluate('window.__blacksite.stats()').catch(() => ({}));
    const fps = (1000 / m.median).toFixed(0);
    console.log(
      `${c.name.padEnd(24)} ${String(m.median).padStart(6)}ms ${String(m.p95).padStart(6)}ms`
      + ` ${String(fps).padStart(5)} ${String(s.drawCalls ?? '?').padStart(7)}`
      + ` ${((s.triangles ?? 0) / 1e6).toFixed(2)}M`
      + `   [engine counter says ${s.fps ?? '?'}fps]`,
    );
  }
  console.log('');
  await browser.close();
}
