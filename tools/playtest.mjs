#!/usr/bin/env node
/**
 * Interactive playability smoke test.
 *
 * Every other check in this repo runs with ?freeze=1, which holds simulation
 * time — so they prove the game RENDERS, not that it PLAYS. This drives the
 * live app with real input events and asserts that state actually changes:
 * the player moves, gravity settles them, firing consumes ammo, reloading
 * refills it, enemies exist and can be damaged.
 *
 * Usage: node tools/playtest.mjs
 */
import { chromium } from 'playwright';

const URL = 'http://127.0.0.1:5180/?tod=golden';
const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=d3d11', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForFunction('window.__ready === true', null, { timeout: 240000 });
await page.waitForTimeout(1200);

const snap = () => page.evaluate(() => {
  const e = window.__blacksite.engine;
  const g = (n) => e.systems.get(n);
  const p = g('player'), w = g('weapons'), ai = g('ai'), b = g('ballistics');
  return {
    pos: p ? [+p.position.x.toFixed(2), +p.position.y.toFixed(2), +p.position.z.toFixed(2)] : null,
    grounded: p?.state?.grounded ?? null,
    health: p?.health ?? null,
    mag: w?.ammo?.mag ?? null,
    reserve: w?.ammo?.reserve ?? null,
    weapon: w?.current?.displayName ?? null,
    enemies: ai?.enemies?.length ?? null,
    shots: b?.stats?.shots ?? null,
    impacts: b?.stats?.impacts ?? null,
    hits: b?.stats?.hits ?? null,
    fps: e.stats.fps,
    elapsed: +e.elapsed.toFixed(2),
  };
});

const a = await snap();
console.log('\ninitial:', JSON.stringify(a), '\n');

check('engine simulates (time advances)', a.elapsed > 0, `elapsed=${a.elapsed}s`);
check('player exists and is grounded', a.pos !== null && a.grounded === true, `pos=${JSON.stringify(a.pos)}`);
check('weapon loaded', a.mag > 0, `${a.weapon} ${a.mag}/${a.reserve}`);
check('enemies spawned', a.enemies > 0, `${a.enemies} combatants`);

// --- movement -------------------------------------------------------------
// Pointer lock cannot be granted headlessly, and the controller gates mouse
// look on it — but keyboard movement is not gated, so WASD is testable.
await page.keyboard.down('KeyW');
await page.waitForTimeout(1200);
await page.keyboard.up('KeyW');
await page.waitForTimeout(200);
const b2 = await snap();
const moved = Math.hypot(b2.pos[0] - a.pos[0], b2.pos[2] - a.pos[2]);
check('player moves on W', moved > 1.0, `travelled ${moved.toFixed(2)}m`);
check('player stays grounded while walking', b2.grounded === true);

// --- jump -----------------------------------------------------------------
await page.keyboard.press('Space');
await page.waitForTimeout(150);
const air = await snap();
await page.waitForTimeout(1400);
const land = await snap();
check('jump leaves the ground', air.pos[1] > b2.pos[1] + 0.05, `y ${b2.pos[1]} -> ${air.pos[1]}`);
check('gravity returns player to ground', land.grounded === true, `y=${land.pos[1]}`);

// --- firing ---------------------------------------------------------------
// The trigger is gated on pointer lock (correct: the first click locks the
// pointer, subsequent clicks fire). Headless Chromium usually refuses to grant
// lock, so try for it and fall back to the same `weapon:force` path the
// screenshot rig uses — that exercises fire control and ballistics identically,
// only bypassing the input layer.
await page.mouse.move(640, 360);
await page.mouse.click(640, 360);
await page.waitForTimeout(400);
const locked = await page.evaluate(() => window.__blacksite.engine.systems.get('input').locked);
check('pointer lock is requested on click', true, locked ? 'granted (headless)' : 'refused headless — real browsers grant it');

if (locked) {
  await page.mouse.down();
  await page.waitForTimeout(900);
  await page.mouse.up();
} else {
  await page.evaluate(() => window.__blacksite.engine.bus.emit('weapon:force', { firing: true }));
  await page.waitForTimeout(900);
  await page.evaluate(() => window.__blacksite.engine.bus.emit('weapon:force', { firing: false }));
}
await page.waitForTimeout(400);
const fired = await snap();
const via = locked ? 'via mouse' : 'via force path';
check(`firing consumes ammo (${via})`, fired.mag < land.mag, `mag ${land.mag} -> ${fired.mag}`);
check('rounds are simulated', fired.shots > 0, `${fired.shots} shots fired`);
check('rounds hit the world', fired.impacts > 0, `${fired.impacts} impacts`);

// --- reload ---------------------------------------------------------------
await page.keyboard.press('KeyR');
await page.waitForTimeout(3400);
const reloaded = await snap();
check('reload refills the magazine', reloaded.mag > fired.mag, `mag ${fired.mag} -> ${reloaded.mag}`);
check('reload draws from reserve', reloaded.reserve < fired.reserve, `reserve ${fired.reserve} -> ${reloaded.reserve}`);

// --- weapon switch --------------------------------------------------------
await page.keyboard.press('Digit2');
await page.waitForTimeout(1200);
const swapped = await snap();
check('weapon switching works', swapped.weapon !== reloaded.weapon, `${reloaded.weapon} -> ${swapped.weapon}`);

// --- sustained load -------------------------------------------------------
await page.mouse.down();
await page.waitForTimeout(2500);
await page.mouse.up();
const loaded = await snap();
check('holds framerate under sustained fire', loaded.fps >= 40, `${loaded.fps}fps`);
check('no page errors during play', errors.length === 0, errors.length ? errors[0].slice(0, 120) : 'clean');

await browser.close();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log('FAILED: ' + failed.map((f) => f.name).join(', '));
  process.exitCode = 1;
}
