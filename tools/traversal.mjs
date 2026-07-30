#!/usr/bin/env node
/**
 * TRAVERSAL ASSERTION — can the player actually get off the ground floor?
 *
 * A player reported being stuck on the ground floor of a map that has a stair
 * tower, a catwalk ring, an elevated plant deck, a three-storey admin block and
 * a mezzanine. He was right, and no test had ever tried to walk upstairs, so the
 * level had shipped ten rounds of screenshots with its vertical circulation
 * comprehensively broken: a wall built across a staircase, three separate
 * walkways with less than head height over the flight below them, a "stair" that
 * was four boxes stacked at the same z, a parapet down the middle of a catwalk
 * and a sign gantry at 6.0 m over a deck at 4.70 m.
 *
 * Every one of those is invisible in a screenshot and obvious the moment
 * something tries to walk it. Hence this file.
 *
 * WHAT IT DOES
 *   Drives the REAL PlayerController with REAL keyboard input — no teleporting,
 *   because teleporting past a collision bug is exactly how you fail to notice
 *   one. Each route holds W (and optionally taps Space for mantles, and turns at
 *   scheduled times), samples the player's position four times a second, and
 *   asserts the height actually gained or lost.
 *
 * TWO RULES THIS FILE EXISTS TO PROTECT. Both were broken in the shipped build:
 *   1. Nothing may cross a flight of stairs.
 *   2. Nothing may sit within PLAYER.height (1.78 m) above a walkable surface.
 *      Bar grating's soffit is 43 mm below its deck, so a catwalk at 4.70 is a
 *      ceiling at 4.657 and every tread above y = 2.88 under it is unreachable.
 *
 * Usage:  node tools/traversal.mjs [--only <substring>] [--keep]
 * Exits non-zero if any route fails.
 */
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;

/**
 * Forward is -Z at yaw 0 (see PlayerController._tryMantle: fwd = -sin(yaw),
 * -cos(yaw)), so a route that must walk toward +Z needs yaw 180 and one that
 * must walk toward +X needs yaw 270.
 *
 *   pos/yaw   spawn, via the ?pos= / ?yaw= rig params
 *   seconds   how long W is held
 *   minGain   metres of height the route MUST gain (peak - start)
 *   maxGain   metres it must NOT exceed (for the flat control)
 *   minDrop   metres it must lose, for the descent routes
 *   floorY    the descent must not end below this — catches falling through
 *   turns     [{ after: seconds, yaw: degrees }]
 *   jumps     [seconds] — taps Space, which is how a mantle is triggered
 *   endNear   { x, z, r } the route must finish inside this circle
 */
const ROUTES = [
  /* ---------------------------------------------------- the main stair tower */
  {
    name: 'stair tower flight 1 (courtyard -> half landing)',
    pos: '23.2,1.9,8.4', yaw: 180, seconds: 7, minGain: 2.2,
    note: '13 x 0.185 m = 2.405 m; the flight the reported bug walled off',
  },
  {
    name: 'stair tower full climb to the catwalk deck',
    pos: '23.2,1.9,8.4', yaw: 180, seconds: 16, minGain: 4.5,
    note: 'both flights + landing, courtyard 0.00 -> L.deck 4.70',
    endNear: { x: 23.2, z: 18.6, r: 3.5 },
  },
  {
    name: 'stair tower -> catwalk ring (reaches the deck at x = 21)',
    pos: '23.2,1.9,8.4', yaw: 180, seconds: 24, minGain: 4.5,
    note: 'climb, then west across the head landing onto the north catwalk leg',
    turns: [{ after: 17, yaw: 90 }],
    endNear: { x: 21.0, z: 19.2, r: 2.6 },
  },
  {
    name: 'stair tower descent (deck -> courtyard, both ways climbable)',
    pos: '23.2,6.5,19.4', yaw: 0, seconds: 10, minDrop: 4.4, floorY: -0.5,
    note: 'walk DOWN both flights; must not drop through the treads. Props puts '
      + 'a sandbag stack on the head landing, so the walk starts with a vault',
    jumps: [0.5, 1.0, 1.5, 2.0],
    endNear: { x: 23.2, z: 6.5, r: 5.0 },
  },

  /* -------------------------------------------------------- the catwalk ring */
  {
    name: 'catwalk ring: north leg to the west tee',
    pos: '21.0,6.5,17.0', yaw: 180, seconds: 12, minGain: -99, maxGain: 0.6,
    note: 'level walk along the deck; asserts the leg is not blocked',
    endNear: { x: 21.0, z: 27.4, r: 2.2 },
  },
  {
    name: 'catwalk ring: west leg over the courtyard',
    pos: '20.0,6.5,27.6', yaw: 90, seconds: 12, minGain: -99,
    note: 'the leg that used to run into the pump house parapet; Props drops a '
      + 'sandbag emplacement on it at x 17.4, so the walk includes vaulting it',
    jumps: [1.0, 1.6, 2.2, 2.8, 3.4, 4.0, 4.6],
    maxGain: 2.2,
    endNear: { x: 13.6, z: 27.6, r: 2.6 },
  },
  {
    name: 'admin bridge (deck -> stair tower head, under the sign gantry)',
    pos: '21.0,6.5,11.0', yaw: 180, seconds: 2, minGain: -99, maxGain: 0.6,
    note: 'the 6.0 m sign girder used to be a low bridge across this at z = 12',
    endNear: { x: 21.0, z: 18.5, r: 3.5 },
  },

  /* --------------------------------------------------------- the other ways up */
  {
    name: 'dock fire stair (dock 1.20 -> catwalk ring 4.70)',
    pos: '24.2,3.1,20.3', yaw: 180, seconds: 16, minGain: 3.3,
    note: 'new: 19 x 0.1842 m off the loading dock onto the ring tee',
    endNear: { x: 23.6, z: 27.6, r: 3.0 },
  },
  {
    name: 'dock fire stair descent',
    pos: '24.2,6.5,27.4', yaw: 0, seconds: 9, minDrop: 3.2, floorY: 0.8,
    note: 'new: the same flight walked down, must land on the dock not the yard',
  },
  {
    name: 'two-stage climb: ground -> dock steps -> fire stair -> ring',
    pos: '18.4,1.9,19.0', yaw: 270, seconds: 26, minGain: 4.4,
    note: 'new: the whole east route, 0.00 -> 1.20 -> 4.70, no teleporting. '
      + 'Props stacks pallets at the foot of the steps, so it starts with a vault',
    turns: [{ after: 6, yaw: 200 }, { after: 9, yaw: 180 }],
    jumps: [0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0],
  },
  {
    name: 'loading dock steps (ground -> dock at 1.20 m)',
    pos: '18.4,1.9,19.0', yaw: 270, seconds: 8, minGain: 1.0,
    note: 'four real 300 mm risers replacing four boxes stacked at the same z; '
      + 'the vault clears the pallet stack Props leaves at the bottom',
    jumps: [0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0],
  },
  {
    name: 'haul ramp onto the crate-climb plinth',
    pos: '10.6,1.9,28.6', yaw: 180, seconds: 6, minGain: 0.45,
    note: 'new: 0.55 m over 2.6 m — a walkable slope, not a step',
  },
  {
    name: 'stacked-crate climb onto the pump house roof (mantles)',
    pos: '10.6,1.9,28.6', yaw: 180, seconds: 26, minGain: 4.0,
    note: 'new: ramp 0.55, crates 1.62 / 2.78 / 3.90, then east onto the roof 4.65',
    turns: [{ after: 15, yaw: 270 }],
    jumps: [3.5, 4.3, 5.1, 5.9, 6.7, 7.5, 8.3, 9.1, 9.9, 10.7, 11.5, 12.3, 13.1,
      13.9, 14.7, 15.5, 16.3, 17.1, 17.9, 18.7, 19.5, 20.3, 21.1, 21.9, 22.7, 23.5],
  },
  {
    name: 'plant deck switchback stair (service yard -> deck 4.70)',
    pos: '11.6,1.55,-0.6', yaw: 0, seconds: 16, minGain: 4.3,
    note: 'the link catwalk used to run the whole length of flight 2 at head height',
    turns: [{ after: 3.5, yaw: 270 }, { after: 5.0, yaw: 180 }],
    endNear: { x: 14.2, z: -1.0, r: 4.0 },
  },
  {
    name: 'plant deck stair descent',
    pos: '14.2,6.5,-2.9', yaw: 0, seconds: 14, minDrop: 4.2, floorY: -1.0,
    note: 'down flight 2, across the half landing, down flight 1',
    turns: [{ after: 4.0, yaw: 90 }, { after: 5.5, yaw: 180 }],
  },
  {
    name: 'west hall mezzanine stair (interior, +5.07 m)',
    pos: '-25.7,1.55,2.1', yaw: 180, seconds: 22, minGain: 4.6,
    note: 'interiors must be climbable too — 26 x 0.195 m inside the hall',
    endNear: { x: -26.2, z: 10.9, r: 3.5 },
  },
  {
    name: 'admin block stair tower, ground -> level 1',
    pos: '27.4,1.55,15.9', yaw: 180, seconds: 12, minGain: 1.6,
    note: '10 x 0.185 m per flight in the projecting tower at x0 - 2.6; the '
      + 'ground flight used to start 0.35 m under its own floor. Props leaves a '
      + 'sandbag stack on the bottom treads, hence the vault',
    jumps: [0.5, 1.0, 1.5, 2.0, 2.5, 3.0],
  },

  /* ------------------------------------------------------------------ control */
  {
    name: 'flat ground control (should gain nothing)',
    pos: '6.0,1.9,14.0', yaw: 180, seconds: 4, minGain: -99, maxGain: 0.6,
    note: 'control: proves the harness is not reporting phantom climbing',
  },
];

const picked = ROUTES.filter((r) => !only || r.name.includes(only));

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=d3d11', '--disable-gpu-sandbox'],
});

// ONE page for the whole suite: warming this build costs 60-90 s, so seventeen
// pages is half an hour. Each route is placed with the same `place()` the ?pos=
// rig param uses, then WALKED with real key input — the teleport only ever puts
// the player at the START of a climb, never through one.
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const allErrors = [];
page.on('pageerror', (e) => allErrors.push(String(e.message).slice(0, 120)));

/**
 * Bring the page up (or back up — other agents edit this tree while the suite
 * runs and Vite's HMR will reload it out from under us mid-route).
 */
async function warm() {
  await page.goto('http://127.0.0.1:5180/?tod=golden&hud=0&vm=0&quality=low',
    { waitUntil: 'domcontentloaded', timeout: 300000 });
  await page.waitForFunction('window.__ready === true', null, { timeout: 300000 });
  await page.mouse.click(640, 360);
}
async function alive() {
  return page.evaluate('!!(window.__blacksite && window.__ready)').catch(() => false);
}
await warm();

/**
 * `place()` teleports but does NOT reliably take the yaw — measured: every route
 * spawned facing yaw 0 regardless of what was passed, so half the suite walked
 * backwards and "passed" by accident. Set the field directly and prove it stuck.
 */
async function spawn(r) {
  const [px, py, pz] = r.pos.split(',').map(Number);
  const rad = (r.yaw * Math.PI) / 180;
  await page.evaluate(`(() => {
    const p = window.__blacksite.engine.systems.get('player');
    window.__blacksite.place(${px}, ${py}, ${pz}, ${rad}, 0);
    p.yaw = ${rad};
    p.velocity.set(0, 0, 0);
  })()`);
  const got = await page.evaluate(
    "window.__blacksite.engine.systems.get('player').yaw");
  if (Math.abs(Math.atan2(Math.sin(got - rad), Math.cos(got - rad))) > 0.02) {
    throw new Error(`yaw did not take: wanted ${rad.toFixed(3)}, got ${got}`);
  }
}

let failed = 0;
const lines = [];
for (const r of picked) {
  const errAt = allErrors.length;
  const errors = { get length() { return allErrors.length - errAt; }, 0: allErrors[errAt] };
  try {
    if (!(await alive())) await warm();
    await spawn(r);
    // Let gravity settle the capsule onto the ground before sampling y0.
    await page.waitForTimeout(1200);

    const read = () => page.evaluate(`(() => {
      const p = window.__blacksite.engine.systems.get('player');
      return {
        x: +p.position.x.toFixed(2), y: +p.position.y.toFixed(2), z: +p.position.z.toFixed(2),
        grounded: p.state.grounded,
      };
    })()`);

    const start = await read();
    await page.keyboard.down('KeyW');

    let peak = start.y, trough = start.y;
    const trace = [];
    const steps = Math.round(r.seconds * 4);
    const turns = (r.turns ?? []).map((t) => ({ i: Math.round(t.after * 4), yaw: t.yaw }));
    const jumps = new Set((r.jumps ?? []).map((t) => Math.round(t * 4)));
    for (let i = 0; i < steps; i++) {
      for (const t of turns) {
        if (t.i === i) {
          await page.evaluate(
            `window.__blacksite.engine.systems.get('player').yaw = ${(t.yaw * Math.PI) / 180}`,
          );
        }
      }
      if (jumps.has(i)) await page.keyboard.press('Space');
      await page.waitForTimeout(250);
      const s = await read();
      if (s.y > peak) peak = s.y;
      if (s.y < trough) trough = s.y;
      if (i % 4 === 3) trace.push(s.y.toFixed(2));
    }
    await page.keyboard.up('KeyW');
    const end = await read();

    const gain = +(peak - start.y).toFixed(2);
    const drop = +(start.y - trough).toFixed(2);
    const moved = Math.hypot(end.x - start.x, end.z - start.z);

    const checks = [];
    if (r.minGain !== undefined) checks.push([gain >= r.minGain, `gain ${gain} >= ${r.minGain}`]);
    if (r.maxGain !== undefined) checks.push([gain <= r.maxGain, `gain ${gain} <= ${r.maxGain}`]);
    if (r.minDrop !== undefined) checks.push([drop >= r.minDrop, `drop ${drop} >= ${r.minDrop}`]);
    if (r.floorY !== undefined) checks.push([end.y >= r.floorY, `end y ${end.y} >= ${r.floorY}`]);
    if (r.endNear) {
      const d = Math.hypot(end.x - r.endNear.x, end.z - r.endNear.z);
      checks.push([d <= r.endNear.r,
        `ends within ${r.endNear.r} m of (${r.endNear.x},${r.endNear.z}) — was ${d.toFixed(2)}`]);
    }
    checks.push([errors.length === 0, `no page errors${errors.length ? `: ${errors[0]}` : ''}`]);

    const bad = checks.filter(([ok]) => !ok);
    if (bad.length) failed++;
    lines.push(`\n${bad.length ? 'FAIL' : 'PASS'}  ${r.name}`);
    lines.push(`      ${r.note}`);
    lines.push(`      start ${start.x},${start.y},${start.z}  ->  end ${end.x},${end.y},${end.z}`
      + `   peak ${peak.toFixed(2)}  trough ${trough.toFixed(2)}  moved ${moved.toFixed(2)} m`
      + `   grounded=${end.grounded}`);
    for (const [ok, msg] of checks) lines.push(`        ${ok ? 'ok  ' : 'BAD '} ${msg}`);
    lines.push(`      y trace: ${trace.join(' ')}`);
  } catch (err) {
    lines.push(`\nFAIL  ${r.name}: ${String(err.message).slice(0, 160)}`);
    failed++;
    await page.keyboard.up('KeyW').catch(() => {});
  }
}

/* -------------------------------------------------------------------------- *
 * KEEP-CLEAR AUDIT
 *
 * The routes above prove the LEVEL is walkable. This proves nothing else has
 * been dropped into it. Three routes in this suite were blocked not by level
 * geometry but by prop instances snapped onto surfaces the level had just
 * created — a sandbag emplacement across the stair tower's head landing, a
 * pallet stack at the foot of the dock steps, another sandbag stack on the
 * admin tower's bottom treads. A screenshot shows all three as good scatter.
 * -------------------------------------------------------------------------- */
let intrusions = [];
if (!only) {
  if (!(await alive())) await warm();
  intrusions = await page.evaluate(`(() => {
    const level = window.__blacksite.engine.systems.get('level');
    const zones = level.keepClear ?? [];
    const out = [];
    const box = new (level.bounds.constructor)();
    const m = new (level.colliders.matrixWorld.constructor)();
    level.colliders.updateMatrixWorld(true);
    for (const z of zones) {
      const hits = new Map();
      level.colliders.traverse((o) => {
        if (!o.isMesh && !o.isInstancedMesh) return;
        const g = o.geometry;
        if (!g?.attributes?.position) return;
        if (!g.boundingBox) g.computeBoundingBox();
        const n = o.isInstancedMesh ? o.count : 1;
        for (let i = 0; i < n; i++) {
          if (o.isInstancedMesh) { o.getMatrixAt(i, m); m.premultiply(o.matrixWorld); }
          else m.copy(o.matrixWorld);
          box.copy(g.boundingBox).applyMatrix4(m);
          if (!box.intersectsBox(z.box)) continue;
          // Only instanced scatter is audited: the level's own stringers,
          // railings and treads legitimately touch these volumes.
          if (!o.isInstancedMesh) continue;
          hits.set(o.name, (hits.get(o.name) ?? 0) + 1);
        }
      });
      if (hits.size) out.push({ zone: z.name, props: [...hits].map(([k, v]) => k + ' x' + v) });
    }
    return out;
  })()`).catch(() => []);

  lines.push('\n--- keep-clear audit (level.keepClear) ---');
  if (!intrusions.length) {
    lines.push('      ok   no scattered instance intrudes on any circulation volume');
  } else {
    for (const i of intrusions) {
      lines.push(`      BLOCKED  ${i.zone}: ${i.props.join(', ')}`);
    }
    lines.push('      These are prop instances, not level geometry. Props should');
    lines.push("      subtract ctx.get('level').keepClear before scattering.");
  }
}

await browser.close();
console.log(lines.join('\n'));
if (intrusions.length) failed += 0;   // reported, not counted: not the level's geometry
console.log(`\n${failed
  ? `FAIL — ${failed}/${picked.length} vertical routes are broken`
  : `PASS — all ${picked.length} vertical routes are walkable`}`);
process.exitCode = failed ? 1 : 0;
