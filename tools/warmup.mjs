#!/usr/bin/env node
/**
 * WARM-UP PROFILE — why the first minute is sluggish.
 *
 * A player reports the game is "super sluggish" for about a minute after load and
 * then settles. The hypothesis is lazy shader compilation: WebGL links a program
 * the first time a given material/light/shadow permutation is actually drawn, and
 * a link is a SYNCHRONOUS main-thread stall of a few hundred milliseconds under
 * ANGLE/D3D11. So the cost is not paid at load — it is paid, one hitch at a time,
 * as you walk around and new permutations enter view.
 *
 * This samples the engine over 90 s and correlates three things:
 *   programs   renderer.info.programs.length — how many are linked so far
 *   cpuMs      JavaScript time in the frame, which is where a compile stall lands
 *   frameMs    wall-clock interval between frames
 * If the program count climbs while cpuMs spikes, the hypothesis is confirmed and
 * the fix is to pre-compile during the loading screen.
 *
 * Headless has no swap chain, so frameMs is unreliable here — but a compile stall
 * blocks the CPU, so cpuMs catches it regardless. That is the signal to read.
 *
 * Usage: node tools/warmup.mjs [--seconds 90]
 */
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const SECONDS = parseFloat(opt('seconds', '90'));

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=d3d11', '--disable-gpu-sandbox', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });

// Deliberately NOT frozen: the simulation must run so AI, particles, weapons and
// the adaptive governor all do their real first-minute work.
await page.goto('http://127.0.0.1:5180/?tod=golden&hud=0&quality=cinematic',
  { waitUntil: 'domcontentloaded', timeout: 300000 });

const t0 = Date.now();
await page.waitForFunction('window.__ready === true', null, { timeout: 300000 });
const readyAt = (Date.now() - t0) / 1000;
console.log(`__ready after ${readyAt.toFixed(1)}s\n`);
console.log('  t(s)  programs   cpuMs  worstMs   fps   preset');

const samples = [];
const step = 2;
for (let t = 0; t < SECONDS; t += step) {
  // Sweep the camera so fresh material/light permutations keep entering view —
  // this is what a walking player does and what triggers lazy compiles.
  await page.evaluate(`(() => {
    const p = window.__blacksite.engine.systems.get('player');
    if (p) p.yaw += 0.55;
  })()`);
  await page.waitForTimeout(step * 1000);
  const s = await page.evaluate(`(() => {
    const e = window.__blacksite.engine;
    const q = e.systems.get('quality');
    return {
      programs: e.renderer.info.programs ? e.renderer.info.programs.length : -1,
      cpuMs: e.stats.cpuMs, worstMs: e.stats.worstMs, fps: e.stats.fps,
      preset: q ? q.info.preset : '?',
      geometries: e.renderer.info.memory.geometries,
      textures: e.renderer.info.memory.textures,
    };
  })()`);
  samples.push({ t: t + step, ...s });
  console.log(`${String(t + step).padStart(6)} ${String(s.programs).padStart(9)}`
    + ` ${String(s.cpuMs).padStart(7)} ${String(s.worstMs).padStart(8)}`
    + ` ${String(s.fps).padStart(5)}   ${s.preset}`);
}

const first = samples[0];
const last = samples[samples.length - 1];
const peakCpu = samples.reduce((a, s) => (s.cpuMs > a.cpuMs ? s : a), samples[0]);
console.log(`\nprograms  ${first.programs} -> ${last.programs}  (+${last.programs - first.programs} linked after ready)`);
console.log(`textures  ${first.textures} -> ${last.textures}`);
console.log(`geometry  ${first.geometries} -> ${last.geometries}`);
console.log(`peak cpuMs ${peakCpu.cpuMs} at t=${peakCpu.t}s (programs ${peakCpu.programs})`);
console.log(`settled cpuMs ${last.cpuMs}, worst ${last.worstMs}`);
if (last.programs > first.programs + 3) {
  console.log('\nVERDICT: programs are still being linked after load — lazy shader'
    + '\ncompilation is the sluggishness. Fix by pre-compiling during the boot screen.');
} else {
  console.log('\nVERDICT: program count is stable after ready; look elsewhere'
    + '\n(texture upload, BVH build, adaptive governor, GC).');
}

await browser.close();
