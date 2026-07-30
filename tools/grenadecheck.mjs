#!/usr/bin/env node
/**
 * GRENADE ASSERTION HARNESS
 *
 * Every claim about the player grenade is measured against the LIVE system, not
 * against the source. The project's history is a list of confident conclusions
 * that were wrong because the instrument was wrong, so this file follows the
 * house rules:
 *
 *   - the trajectory is sampled from the running simulation, frame by frame,
 *     through a debug view the system itself publishes;
 *   - the detonation is detected from the actual 'explosion' event on the bus,
 *     not from a flag the thrower sets;
 *   - the "cover protects you" claim is checked through the SAME damage
 *     function the detonation uses, so a passing check cannot diverge from
 *     gameplay;
 *   - the key path is driven with real keydown/keyup on window, not by calling
 *     the throw method, because a bound key that nothing consumes is exactly
 *     the bug this feature started from.
 *
 * Checks
 *   1  system            weapons.grenades exists, starts with a finite count
 *   2  trajectory        deterministic throw: travels, bounces off geometry,
 *                        comes to rest, detonates within fuse + epsilon, and
 *                        raises exactly one 'explosion' with a sane payload
 *   3  keybind           KeyG down cooks, KeyG up throws, count decrements
 *   4  cover             blast damage through a wall is zero, in the open is not
 *   5  cook-off          holding past the fuse detonates on the player
 *   6  finite            no resupply: the count reaches zero and stays there
 *
 * Usage: node tools/grenadecheck.mjs [--url http://127.0.0.1:5180] [--verbose]
 * Exits non-zero if any check fails.
 */
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const URL_BASE = opt('url', 'http://127.0.0.1:5180');
const VERBOSE = args.includes('--verbose');

/** Courtyard: open ground ahead, hard cover within a few metres. */
const SPAWN = '6,1.9,14';
const YAW = 200;

const results = [];
const record = (name, ok, detail, lines = []) => {
  results.push({ name, ok, detail, lines });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  console.log(`      ${detail}`);
  for (const l of lines) console.log(`      ${l}`);
};

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=d3d11', '--disable-gpu-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text()); });

try {
  await page.goto(`${URL_BASE}/?tod=golden&hud=1&vm=0&pos=${SPAWN}&yaw=${YAW}&quality=low`,
    { waitUntil: 'domcontentloaded', timeout: 300000 });
  await page.waitForFunction('window.__ready === true', null, { timeout: 300000 });
  await page.waitForTimeout(1200);   // let the capsule settle on the ground

  // ---------------------------------------------------------------- 1 system --
  const sys = await page.evaluate(`(() => {
    const w = window.__blacksite.engine.systems.get('weapons');
    const g = w && w.grenades;
    if (!g) return { present: false };
    return {
      present: true,
      count: g.count,
      api: ['throwNow', 'beginCook', 'release', 'debug', 'damageAt']
        .filter((k) => typeof g[k] !== 'function'),
      fuse: g.constants ? g.constants.fuse : null,
      radius: g.constants ? g.constants.radius : null,
    };
  })()`);

  if (!sys.present) {
    record('1 system', false, 'weapons.grenades is not present — nothing consumes KeyG on the player side');
    throw new Error('no grenade system');
  }
  record('1 system', sys.api.length === 0 && sys.count > 0 && sys.count < 20,
    `count=${sys.count} fuse=${sys.fuse}s radius=${sys.radius}m`
    + (sys.api.length ? `  MISSING API: ${sys.api.join(',')}` : ''));

  // ------------------------------------------------------------ 2 trajectory --
  // Thrown flat and slightly up along -Z from head height: it must fly clear of
  // the thrower, fall, strike the courtyard slab and settle.
  const traj = await page.evaluate(async (cfg) => {
    const eng = window.__blacksite.engine;
    const g = eng.systems.get('weapons').grenades;
    const level = eng.systems.get('level');
    const exps = [];
    // TIME IS SIMULATION TIME. The fuse is counted down in fixedUpdate, and
    // Engine drops accumulated time when a frame overruns maxSubSteps, so wall
    // clock and sim clock diverge exactly when the scene is busy — i.e. during
    // an explosion. Timing a fuse on performance.now() measures the frame rate,
    // not the fuse.
    const t0 = eng.elapsed;
    eng.bus.on('explosion', (e) => exps.push({
      p: [e.point.x, e.point.y, e.point.z],
      radius: e.radius, damage: e.damage, t: eng.elapsed - t0, wall: performance.now(),
    }));
    const wall0 = performance.now();
    const i = g.throwNow(cfg.shot);
    const samples = [];
    await new Promise((res) => {
      const tick = () => {
        const d = g.debug(i);
        // `debug()` returns a SHARED record with a shared pos array — spreading
        // it copies the numbers but aliases the array, which made every sample
        // report the final position and turned "range" into "rest distance".
        samples.push({
          t: eng.elapsed - t0, active: d.active, rest: d.rest, bounces: d.bounces,
          travelled: d.travelled, fuse: d.fuse, speed: d.speed,
          pos: [d.pos[0], d.pos[1], d.pos[2]],
        });
        if (!d.active && samples.length > 3) return res();
        if (performance.now() - wall0 > cfg.timeoutMs) return res();
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    // Did it come to rest ON something, or through it? A short downward probe
    // from just above the rest point must find a surface within a body radius.
    let supported = null;
    const restS = samples.find((q) => q.rest) ?? samples[samples.length - 1];
    if (restS?.pos) {
      const o = new g.THREE.Vector3(restS.pos[0], restS.pos[1] + 0.25, restS.pos[2]);
      const hit = level.raycast(o, new g.THREE.Vector3(0, -1, 0), 0.6);
      supported = hit ? +(o.y - 0.25 - hit.point.y).toFixed(3) : null;
    }
    return {
      samples, exps, fuse: cfg.shot.fuse, supported,
      wallSeconds: +((performance.now() - wall0) / 1000).toFixed(2),
    };
  }, {
    shot: { origin: [6, 1.75, 14], dir: [0, 0.20, -1], speed: 15, fuse: 2.4, seed: 7 },
    timeoutMs: 6000,
  });

  const s = traj.samples;
  const first = s[0];
  const last = s[s.length - 1];
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  let maxRange = 0;
  let restSample = null;
  for (const q of s) {
    if (!q.pos) continue;
    maxRange = Math.max(maxRange, dist(q.pos, [6, 1.75, 14]));
    if (q.rest && !restSample) restSample = q;
  }
  const bounces = Math.max(...s.map((q) => q.bounces ?? 0));
  const travelled = Math.max(...s.map((q) => q.travelled ?? 0));
  const endPos = (restSample ?? last).pos;
  const near = traj.exps.filter((e) => endPos && dist(e.p, endPos) < 1.5);
  const det = near[0];
  // The fuse is decremented inside fixedUpdate, so it is measured against the
  // grenade's own remaining fuse — engine time (`det.t`) runs ahead of simulated
  // time whenever a frame overruns maxSubSteps, and timing a fuse against it
  // measures the frame rate instead. Engine time is still used one way: the
  // blast may never happen EARLY.
  let fuseAtEnd = 999;
  for (let i = s.length - 1; i >= 0; i--) if (s[i].active) { fuseAtEnd = s[i].fuse; break; }
  const fuseOk = det && fuseAtEnd <= 0.06 && det.t >= traj.fuse - 0.02;
  const payloadOk = det && det.radius >= 2 && det.radius <= 20
    && det.damage >= 10 && det.damage <= 400;
  const settled = !!restSample || (last.speed !== undefined && last.speed < 0.35);

  // Resting inside or below the floor is a tunnelling bug that "came to rest"
  // would otherwise report as a pass.
  const supportOk = traj.supported !== null && Math.abs(traj.supported) <= 0.09;

  const trajOk = maxRange >= 4 && bounces >= 1 && settled && fuseOk && payloadOk
    && near.length === 1 && supportOk;
  record('2 trajectory', trajOk,
    `range=${maxRange.toFixed(2)}m path=${travelled.toFixed(2)}m bounces=${bounces}`
    + ` rest=${settled ? `t+${(restSample?.t ?? last.t).toFixed(2)}s` : 'NEVER'}`
    + ` detonation with ${fuseAtEnd.toFixed(3)}s of a ${traj.fuse}s fuse left`
    + ` (engine time t+${det ? det.t.toFixed(2) : '—'}s, wall ${traj.wallSeconds}s)`,
    [
      `explosion events near the rest point: ${near.length} (need exactly 1),`
      + ` total on bus during window: ${traj.exps.length}`,
      det ? `payload radius=${det.radius} damage=${Math.round(det.damage)}` : 'no payload',
      `resting on geometry: probe gap ${traj.supported === null ? 'NO SURFACE UNDER IT' : `${traj.supported}m`}`
      + ` (needs |gap| <= 0.09 — the body radius)`,
      `launch ${first.pos ? first.pos.map((v) => v.toFixed(2)).join(',') : '?'}`
      + `  ->  rest ${endPos ? endPos.map((v) => v.toFixed(2)).join(',') : '?'}`,
      VERBOSE ? `y trace: ${s.filter((_, i) => i % 4 === 0).map((q) => (q.pos ? `${q.t.toFixed(1)}:${q.pos[1].toFixed(2)}` : 'x')).join(' ')}` : '',
    ].filter(Boolean));

  // --------------------------------------------------------------- 3 keybind --
  await page.evaluate(`window.__blacksite.engine.systems.get('weapons').grenades.reset(3)`);
  await page.waitForTimeout(120);
  const beforeKey = await page.evaluate(`window.__blacksite.engine.systems.get('weapons').grenades.count`);
  await page.keyboard.down('KeyG');
  await page.waitForTimeout(500);
  const cooking = await page.evaluate(`(() => {
    const g = window.__blacksite.engine.systems.get('weapons').grenades;
    return { cooking: g.cooking, fuseLeft: +g.fuseLeft.toFixed(2), count: g.count };
  })()`);
  await page.keyboard.up('KeyG');
  await page.waitForTimeout(400);
  const afterKey = await page.evaluate(`(() => {
    const g = window.__blacksite.engine.systems.get('weapons').grenades;
    return { cooking: g.cooking, count: g.count, live: g.liveCount, thrownFuse: g.debug(g.lastIndex).fuse };
  })()`);
  const keyOk = cooking.cooking && cooking.count === beforeKey
    && !afterKey.cooking && afterKey.count === beforeKey - 1 && afterKey.live >= 1
    && cooking.fuseLeft < sys.fuse;
  record('3 keybind', keyOk,
    `KeyG held 0.5s: cooking=${cooking.cooking} fuse=${cooking.fuseLeft}s`
    + ` -> released: count ${beforeKey}->${afterKey.count} live=${afterKey.live}`
    + ` remaining fuse on the thrown grenade=${afterKey.thrownFuse}s`,
    ['the cook clock must keep running after release — a cooked grenade is a short-fused one']);

  // ----------------------------------------------------------------- 4 cover --
  const cover = await page.evaluate(`(() => {
    const eng = window.__blacksite.engine;
    const g = eng.systems.get('weapons').grenades;
    const level = eng.systems.get('level');
    const THREE = g.THREE;
    const eye = [6, 1.6, 14];
    // Sweep the horizon for a wall 1..4 m away, and a clear bearing to match.
    let blocked = null, open = null;
    for (let a = 0; a < 64; a++) {
      const th = (a / 64) * Math.PI * 2;
      const d = new THREE.Vector3(Math.cos(th), 0, Math.sin(th));
      const o = new THREE.Vector3(eye[0], eye[1], eye[2]);
      const hit = level.raycast(o, d, 5.0);
      if (hit && hit.distance > 1.0 && hit.distance < 4.0 && !blocked) {
        blocked = { dist: +hit.distance.toFixed(2), point: [
          hit.point.x + d.x * 0.55, hit.point.y + 0.2, hit.point.z + d.z * 0.55] };
      }
      if (!hit && !open) {
        const r = (blocked ? blocked.dist : 2.5) + 0.55;
        open = { dist: r, point: [eye[0] + d.x * r, eye[1], eye[2] + d.z * r] };
      }
    }
    if (!blocked || !open) return { ok: false, reason: 'no wall/open pair found in the sweep' };
    return {
      ok: true,
      wallDist: blocked.dist,
      through: +g.damageAt(blocked.point, eye).toFixed(1),
      clear: +g.damageAt(open.point, eye).toFixed(1),
      openDist: +open.dist.toFixed(2),
    };
  })()`);
  const coverOk = cover.ok && cover.through === 0 && cover.clear > 0;
  record('4 cover', coverOk,
    cover.ok
      ? `wall at ${cover.wallDist}m: blast on the far side does ${cover.through} damage;`
        + ` an equal-range blast in the open does ${cover.clear}`
      : `could not measure: ${cover.reason}`,
    ['line of sight is what makes cover meaningful — a wall must zero the damage']);

  // -------------------------------------------------------------- 5 cook-off --
  const cookoff = await page.evaluate(async () => {
    const eng = window.__blacksite.engine;
    const g = eng.systems.get('weapons').grenades;
    const player = eng.systems.get('player');
    // Clear the sky of anything still in flight from the earlier checks, or
    // their detonations land inside this window and are counted as ours.
    g.reset(3);
    await new Promise((r) => setTimeout(r, 250));
    player.health = 100;
    const before = { count: g.count, hp: player.health };
    const cam = eng.camera.position;
    const exps = [];
    // Self-damage is measured from the 'player:damage' event, not from
    // player.health afterwards: a lethal blast kills the player, and whatever
    // handles death restores health — so sampling health later reads 100 and
    // concludes the grenade was harmless.
    // Filtered by origin: the enemies are alive and shooting throughout, so an
    // unfiltered list of player:damage events is mostly rifle rounds.
    const hits = [];
    const offD = eng.bus.on('player:damage', (e) => {
      const d = e.from
        ? Math.hypot(e.from.x - cam.x, e.from.y - cam.y, e.from.z - cam.z) : 999;
      if (d < 1.0) hits.push(Math.round(e.amount));
    });
    const offE = eng.bus.on('explosion', (e) => exps.push(
      Math.hypot(e.point.x - cam.x, e.point.y - cam.y, e.point.z - cam.z)));
    const t0 = eng.elapsed;
    const wall0 = performance.now();
    g.beginCook();
    await new Promise((res) => {
      const tick = () => {
        if (!g.cooking || performance.now() - wall0 > (g.constants.fuse + 4) * 1000) return res();
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    const sim = eng.elapsed - t0;
    await new Promise((r) => setTimeout(r, 150));
    offD(); offE();
    return {
      // THE fuse clock. Not wall time (frame rate), not eng.elapsed (which keeps
      // running when Engine drops accumulated time after a maxSubSteps overrun):
      // the fuse is decremented by h inside fixedUpdate, and `cookTime` sums the
      // same h, so this is the only number that can be compared to the fuse.
      cookTime: +g.cookTime.toFixed(3),
      sim: +sim.toFixed(2), wall: +((performance.now() - wall0) / 1000).toFixed(2),
      count: g.count, before, blasts: exps.length,
      blastsNear: exps.filter((d) => d < 1.0).length,
      nearest: exps.length ? +Math.min(...exps).toFixed(2) : null,
      damage: hits,
      fuse: g.constants.fuse,
    };
  });
  // Exactly one blast ON THE PLAYER. Other explosions may occur in the window —
  // the AI throws grenades too — so the count that matters is the local one.
  const onPlayer = cookoff.blastsNear;
  const cookOk = onPlayer === 1 && cookoff.nearest !== null && cookoff.nearest < 1.0
    && cookoff.count === cookoff.before.count - 1
    && cookoff.damage.length === 1 && cookoff.damage[0] > 60
    && Math.abs(cookoff.cookTime - cookoff.fuse) < 0.02;
  record('5 cook-off', cookOk,
    `held past the fuse: detonated after ${cookoff.cookTime}s of fuse`
    + ` (${cookoff.sim}s of engine time, ${cookoff.wall}s of wall clock,`
    + ` fuse ${cookoff.fuse}s) ${cookoff.nearest}m from the eye`
    + ` (${onPlayer} blast on the player, ${cookoff.blasts} anywhere),`
    + ` count ${cookoff.before.count}->${cookoff.count},`
    + ` self damage ${cookoff.damage.join('/') || 'NONE'} (only blast-origin hits counted)`,
    ['holding too long has to be punished or cooking is a free upgrade',
      `engine time ran ${(cookoff.sim - cookoff.cookTime).toFixed(2)}s ahead of simulated`
      + ` time and wall clock ${(cookoff.wall - cookoff.cookTime).toFixed(2)}s ahead:`
      + ' that gap is fixed-step time Engine dropped on overrunning frames']);

  // --------------------------------------------------------------- 6 finite --
  const finite = await page.evaluate(`(() => {
    const g = window.__blacksite.engine.systems.get('weapons').grenades;
    g.reset(2);
    const seq = [];
    for (let i = 0; i < 4; i++) {
      const before = g.count;
      const idx = g.throwNow({ origin: [6, 1.75, 14], dir: [0, 0.2, -1], speed: 12, fuse: 3, consume: true });
      seq.push([before, g.count, idx]);
    }
    return { seq, count: g.count };
  })()`);
  const finiteOk = finite.count === 0
    && finite.seq[0][1] === 1 && finite.seq[1][1] === 0
    && finite.seq[2][2] === -1 && finite.seq[3][2] === -1;
  record('6 finite', finiteOk,
    `four throws from a stock of two: counts ${finite.seq.map((r) => r[1]).join(',')},`
    + ` refused throws return index -1 (${finite.seq.map((r) => r[2]).join(',')})`,
    ['no resupply: the third throw must be refused, not silently free']);

  // ------------------------------------------------------- 8 muzzle-to-wall --
  // Releasing with your face against concrete must not post the grenade through
  // the wall, and must not leave it inside your own head either.
  const wall = await page.evaluate(async () => {
    const eng = window.__blacksite.engine;
    const g = eng.systems.get('weapons').grenades;
    const level = eng.systems.get('level');
    const player = eng.systems.get('player');
    const THREE = g.THREE;
    const cam = eng.camera;
    // Sweep for a wall, then stand 0.55 m off it, facing it.
    let best = null;
    for (let a = 0; a < 96; a++) {
      const th = (a / 96) * Math.PI * 2;
      const d = new THREE.Vector3(Math.cos(th), 0, Math.sin(th));
      const hit = level.raycast(cam.position.clone(), d, 8);
      if (hit && hit.distance > 1.2 && hit.distance < 6 && (!best || hit.distance < best.dist)) {
        best = { dist: hit.distance, d, point: hit.point.clone() };
      }
    }
    if (!best) return { ok: false, reason: 'no wall found' };
    // Do not derive a yaw from a bearing — the sign convention is a guess and a
    // wrong guess here silently tests nothing (the first version of this check
    // "passed the wall test" while facing open ground). Sweep the real camera
    // forward instead, one frame per candidate, and keep the yaw that looks at
    // a wall.
    const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    // Level the view FIRST. Earlier checks leave the camera pitched down, and a
    // pitched sweep hits the floor 4 m away and calls it a wall — which is how
    // this check managed to "find a wall" and then find nothing in front of it.
    eng.bus.emit('player:teleport', {
      position: player.position.clone(), yaw: player.yaw, pitch: 0,
    });
    await frame();
    const fwd = new THREE.Vector3();
    let found = null;
    for (let k = 0; k < 32 && !found; k++) {
      player.yaw = (k / 32) * Math.PI * 2;
      await frame();
      fwd.set(0, 0, -1).applyQuaternion(cam.quaternion);
      const h = level.raycast(cam.position.clone(), fwd, 8);
      // A wall, not a floor: the surface normal has to be roughly horizontal.
      if (h && h.distance > 1.2 && h.distance < 6 && Math.abs(h.normal.y) < 0.45) {
        found = { d: h.distance, point: h.point.clone() };
      }
    }
    if (!found) return { ok: false, reason: 'no wall along any camera forward' };
    const stand = found.point.clone().addScaledVector(fwd, -0.55);
    eng.bus.emit('player:teleport', {
      position: new THREE.Vector3(stand.x, player.position.y, stand.z),
      yaw: player.yaw, pitch: 0,
    });
    await frame();
    // Re-acquire from where we ACTUALLY ended up. Teleporting to a computed
    // point and assuming the wall is now 0.55 m ahead is the assumption that
    // made this check silently test open ground; measure instead. Keep the yaw
    // whose forward ray is shortest.
    let ahead = null;
    let bestYaw = player.yaw;
    for (let k = 0; k < 48; k++) {
      player.yaw = (k / 48) * Math.PI * 2;
      await frame();
      fwd.set(0, 0, -1).applyQuaternion(cam.quaternion);
      const h = level.raycast(cam.position.clone(), fwd, 4);
      if (h && Math.abs(h.normal.y) < 0.45 && (!ahead || h.distance < ahead.distance)) {
        ahead = { distance: h.distance };
        bestYaw = player.yaw;
      }
    }
    player.yaw = bestYaw;
    await frame();
    fwd.set(0, 0, -1).applyQuaternion(cam.quaternion);
    g.reset(3);
    g.beginCook();
    await new Promise((r) => setTimeout(r, 150));
    const i = g.release();
    const d = g.debug(i);
    const spawn = new THREE.Vector3(d.pos[0], d.pos[1], d.pos[2]);
    const fromEye = cam.position.distanceTo(spawn);
    // Is the spawn on our side of the wall, and is the path to it clear?
    const dir = spawn.clone().sub(cam.position).normalize();
    const blocked = level.raycast(cam.position.clone(), dir, fromEye - 0.01);
    return {
      ok: true,
      diag: {
        sweptWallAt: +found.d.toFixed(2),
        stand: stand.toArray().map((v) => +v.toFixed(2)),
        camAfter: cam.position.toArray().map((v) => +v.toFixed(2)),
        fwd: fwd.toArray().map((v) => +v.toFixed(2)),
      },
      wallAhead: ahead ? +ahead.distance.toFixed(3) : null,
      fromEye: +fromEye.toFixed(3),
      throughWall: !!blocked,
      insideHead: fromEye < 0.05,
    };
  });
  const wallOk = wall.ok && wall.wallAhead !== null
    && wall.fromEye < wall.wallAhead && !wall.throughWall && !wall.insideHead;
  record('8 muzzle-to-wall', wallOk,
    wall.ok
      ? `wall ${wall.wallAhead}m ahead: released grenade spawns ${wall.fromEye}m from the eye,`
        + ` through wall=${wall.throughWall}, inside head=${wall.insideHead}`
      : `could not measure: ${wall.reason}`,
    ['the spawn must be short of the wall and clear of the player, at any range',
      wall.diag ? JSON.stringify(wall.diag) : ''].filter(Boolean));

  // --------------------------------------------------------------- 9 cost --
  // What the system costs the frame. Measured, because "pooled meshes are free"
  // is exactly the kind of claim that turns out to be a hidden 6 draw calls.
  const cost = await page.evaluate(async () => {
    const eng = window.__blacksite.engine;
    const g = eng.systems.get('weapons').grenades;
    const frames = (n) => new Promise((res) => {
      let k = 0;
      const tick = () => (++k >= n ? res() : requestAnimationFrame(tick));
      requestAnimationFrame(tick);
    });
    const sample = async () => {
      await frames(12);
      const d = [], t = [];
      for (let i = 0; i < 12; i++) { await frames(1); d.push(eng.stats.drawCalls); t.push(eng.stats.triangles); }
      d.sort((a, b) => a - b); t.sort((a, b) => a - b);
      return { draws: d[6], tris: t[6] };
    };
    g.reset(3);
    await frames(4);
    const idle = await sample();
    // Three live, parked in front of the camera so they are certainly visible.
    const cam = eng.camera;
    const fwd = new g.THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    for (let i = 0; i < 3; i++) {
      const k = g.throwNow({ origin: [0, 0, 0], dir: [0, 0, -1], speed: 0.01, fuse: 999 });
      const rec = g.pool[k];
      rec.pos.copy(cam.position).addScaledVector(fwd, 1.2 + i * 0.25);
      rec.vel.set(0, 0, 0); rec.rest = true;
      rec.mesh.position.copy(rec.pos);
    }
    const live = await sample();
    g.reset(3);
    return { idle, live };
  });
  const dDraws = cost.live.draws - cost.idle.draws;
  const dTris = cost.live.tris - cost.idle.tris;
  // A live frag is 370 triangles, but it casts shadows, so renderer.info counts
  // it once per shadow cascade as well as once in the main pass — about six
  // draws and 1.3k triangles each. That is the price of the frag having a
  // shadow at all, and three in the air at once is the hard maximum (the stock
  // is three and there is no resupply). 24 draws of a 900 budget.
  const costOk = dDraws >= 0 && dDraws <= 24 && dTris >= 0 && dTris <= 5000;
  record('9 cost', costOk,
    `idle ${cost.idle.draws} draws / ${cost.idle.tris} tris  ->  three live`
    + ` ${cost.live.draws} draws / ${cost.live.tris} tris  (+${dDraws} draws, +${dTris} tris)`,
    [`that is ${(dDraws / 3).toFixed(1)} draws and ${Math.round(dTris / 3)} tris per airborne`
      + ' frag across the main pass and every shadow cascade; hidden pool members'
      + ' are skipped by the scene traversal and cost nothing']);

  // ------------------------------------------------------------ page errors --
  await page.waitForTimeout(300);
  record('7 clean', pageErrors.length === 0,
    pageErrors.length ? `${pageErrors.length} console/page errors: ${pageErrors[0].slice(0, 160)}`
      : 'no console or page errors during the whole run');
} catch (err) {
  record('harness', false, String(err.message).slice(0, 200));
}

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length ? 'FAIL' : 'PASS'} — ${results.length - failed.length}/${results.length} checks`
  + (failed.length ? `: ${failed.map((f) => f.name).join(', ')}` : ''));
process.exitCode = failed.length ? 1 : 0;
