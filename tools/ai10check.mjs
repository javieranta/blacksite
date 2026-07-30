#!/usr/bin/env node
/**
 * Assertions on the three combatant defects that no existing harness could see:
 * pose/orientation cloning, the muzzle flash reading as a face, and the cyan rim.
 *
 * WHY THIS EXISTS, AND WHAT WAS WRONG WITH THE OBVIOUS VERSION OF EACH TEST
 * ------------------------------------------------------------------------
 * tools/aicheck.mjs already asserts pose distinctness, and it PASSED on every
 * view of the build the review called "only two poses across roughly ten figures
 * and all squared to camera". So the first job here was not to add a test, it was
 * to work out why the existing one could not fail. Three reasons, all of them the
 * same mistake in different clothes — measuring something adjacent to the defect:
 *
 *  1. It compared `bone.rotation` Euler triples. Euler components are not a
 *     metric: the arm bones are written by an IK solve whose result depends on
 *     where the man is standing relative to his target, so two men in an
 *     identical stance at different points on the map produce large Euler
 *     differences for free. The measured pairwise RMS was 0.13-0.50 rad against a
 *     0.045 threshold — a comfortable pass, carried almost entirely by the aim
 *     geometry rather than by the stance. This harness compares QUATERNIONS, as
 *     true geodesic angles per joint, and reports the stance joints separately
 *     from the arms so aim differences cannot launder a shared stance.
 *
 *  2. It never measured ORIENTATION AT ALL, which is the specific thing the
 *     review complained about. Every combatant took the same `AI.bladeAngle` off
 *     the same bearing to the same player, so the squad's facing spread was
 *     exactly zero — and a zero could not show up in a test that only looked at
 *     joints. `yawSpread` below is that number. On the build under review it is
 *     0.000 rad by construction; it cannot be faked by any amount of joint
 *     jitter.
 *
 *  3. Its layout threshold was 0.012 body-heights. A body-height is ~200 px in
 *     these views, so 0.012 is two pixels: noise clears it. A threshold that
 *     noise clears is not a threshold.
 *
 * THE FLASH TEST. The obvious assertion — "flash world position within 0.3 m of
 * the muzzle and more than 0.4 m from the head bone" — was written first and it
 * PASSED on the unfixed build, at 0.022 m from the muzzle and 0.68-1.03 m from
 * the head. It passes because the flash is not in fact mis-parented; the review's
 * diagnosis was wrong even though the artefact is real. What is actually wrong is
 * in the IMAGE: a man aiming at the camera has his barrel foreshortened to
 * nothing, so his muzzle projects within ~70 px of his head on a 170 px figure,
 * and the flash card was up to 0.82 m across with an additive core, so the glow
 * covered him from chest to helmet. Hence both tests here: the world-space one as
 * a parenting regression guard, and a SCREEN-space one that measures the rendered
 * flash's own bright-pixel centroid against the projected head, in body-heights,
 * which is the only frame in which the reported defect exists.
 *
 * THE CYAN TEST. "No pixel on a combatant falls in the saturated cyan hue band"
 * is unusable as written, and measuring it proved so: with the rim term ablated
 * completely, 22.4% of a combatant's pixels at 28 m still land in that band, and
 * 4.5% do at 7 m. That is not an artefact — it is a blue midday sky reflected in
 * a body, and aerial perspective on a distant figure, both of which the contract
 * explicitly asks for. A raw hue count therefore fails the correct build and
 * cannot distinguish it from the broken one. So the metric is DIFFERENTIAL: the
 * frame is captured with the rim on and again with it forced to zero, and what is
 * asserted is the cyan the RIM ITSELF ADDS. On the unfixed build that was the
 * whole of the night figures' cyan (1.57/1.91/2.11% -> 0.13/0/0%); after the fix
 * it is 0.0%.
 *
 * Usage: node tools/ai10check.mjs [--views ai-close,...] [--diag]
 * Exits non-zero if any view fails.
 */
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const has = (n) => args.includes('--' + n);

const VIEWS = {
  'ai-close':       'tod=golden&pos=4,1.7,6&yaw=195&pitch=-0.02&vm=0&aistage=6&aiyaw=40',
  'ai-close-mid':   'tod=midday&pos=4,1.7,6&yaw=195&pitch=-0.02&vm=0&aistage=7&aiyaw=25',
  'ai-close-night': 'tod=night&pos=6,1.7,14&yaw=200&pitch=-0.04&vm=0&aistage=6&aiyaw=40',
  'combat':         'tod=golden&pos=4,1.7,6&yaw=195&pitch=-0.02&vm=0&fire=1',
};
const want = (opt('views', 'ai-close,ai-close-mid,ai-close-night')).split(',').map((s) => s.trim());

/* ------------------------------------------------------------- thresholds --- */

/** Below this a body is too small in frame for any of these numbers to mean much. */
const MIN_PIXELS = 400;

/**
 * POSE. `stanceAngle` is the mean geodesic angle between two men's corresponding
 * stance joints (pelvis, spine, chest, neck, head, both legs) — the arms are
 * excluded because they are an IK result driven by where the target is, not by
 * the man. 0.10 rad is 5.7 degrees averaged over eleven joints: two riflemen who
 * genuinely stand differently are far past it, and a persona that only rescales
 * shared constants lands under it.
 */
const MIN_STANCE_ANGLE = 0.10;
/**
 * ORIENTATION. Standard deviation of body facing measured RELATIVE to each man's
 * own bearing to the camera, so a squad spread around a courtyard is not credited
 * with variety it does not have. A shared blade constant gives exactly 0.000.
 * 0.12 rad (7 deg) is the floor; the spread between the most and least bladed man
 * must also be a visible 0.35 rad (20 deg).
 */
const MIN_YAW_STDEV = 0.12;
const MIN_YAW_RANGE = 0.35;

/** FLASH, world space — a pure parenting regression guard. */
const MAX_FLASH_TO_MUZZLE = 0.30;
const MIN_FLASH_TO_HEAD = 0.40;
/**
 * FLASH, screen space.
 *
 * THE FIRST VERSION OF THIS THRESHOLD WAS WRONG, in the opposite direction to
 * every other bug in this project's history: it demanded something geometrically
 * impossible and therefore failed a build that was correct.
 *
 * It required the flash centroid to be at least 0.28 body-heights from the
 * projected head. But work out what that asks for. A rifleman engaging the camera
 * has his bore pointing AT the lens, so the 0.55 m of weapon between his chest and
 * his muzzle foreshortens to nothing and all that survives in projection is the
 * lateral and vertical offset of the barrel from his skull — about 0.20-0.25 m, or
 * 0.11-0.14 body-heights. No correct build can ever score 0.28 on a man shooting
 * down the lens; the measured 0.088-0.19 was the right answer. Moving the flash
 * further down the bore does not help either, because along-bore motion is almost
 * parallel to the view ray and barely changes the projected position at all.
 *
 * The review's complaint is not about a distance. It is that the flash was a
 * face-sized additive glow whose bright area COVERED the head, so it read as
 * issuing from his face rather than from a weapon. That is `onHeadPct` — the share
 * of the flash's own bright pixels that land inside the projected head hitbox —
 * and it is both physically achievable and a direct encoding of the defect: a
 * 0.30 m flash offset from the skull overlaps it hardly at all, while the 0.82 m
 * card it replaced swallowed the helmet whole.
 *
 * The distance is kept as a gate too, but at a floor that only a genuinely
 * head-parented flash can fail — such a flash scores ~0.00, not 0.09.
 */
const MIN_FLASH_HEAD_SCREEN = 0.05;
const MAX_FLASH_ON_HEAD_PCT = 12;

/**
 * CYAN. Share of a combatant's pixels that the rim term moves INTO the saturated
 * cyan band. 0.35% allows for dither and a few edge pixels; the unfixed build put
 * 1.6-2.1% of every night figure there, and 100% of that was the rim.
 *
 * A percentage ALONE is not enough, and the first run of this test proved it by
 * failing a body it should have passed: a man at 28 m covers ~500 px, so one pixel
 * is 0.2% and a five-pixel dither difference between two captures reported 0.988%
 * — nearly three times the threshold, from five pixels. Both conditions must now
 * be met, so the verdict cannot be decided by quantisation on a small figure.
 */
const MAX_RIM_CYAN_PCT = 0.35;
/**
 * 40 px, and the number is set by what each build actually measures rather than
 * by taste. The two captures either side of the ablation are separate frames, so
 * auto-exposure drift flips a handful of borderline pixels across the hue and
 * saturation boundaries; on a 600 px figure at 22 m that noise floor is ~26 px,
 * which is 4% and would fail a correct build. The defect it has to catch is much
 * larger than the noise: the same figure on the unfixed build put 14.75% of its
 * pixels in the band from the rim, or 82 px. 40 sits comfortably between the two.
 */
const MIN_RIM_CYAN_PX = 40;

/* ------------------------------------------------------------------ probe --- */

const PROBE = `(async (SELFTEST) => {
  const eng = window.__blacksite.engine;
  const ai = eng.systems.get('ai');
  if (!ai) return { error: 'no ai system' };
  const live = ai.enemies.filter((c) => !c.dead && c.meshes && c.meshes.length);
  if (!live.length) return { error: 'no live combatants' };

  /**
   * Stand the staged shooters down and let the existing flashes, FX cards and
   * recoil decay before anything is measured — otherwise a wall-clock flash is
   * being born and dying throughout the capture, and neither the cyan diff nor
   * the flash isolation is reproducible. Same correction as tools/aicheck.mjs.
   */
  const savedShooters = ai._shooters ? ai._shooters.splice(0, ai._shooters.length) : [];
  await new Promise((r) => setTimeout(r, 500));

  eng.stop();
  const savedPaused = eng.paused;
  eng.paused = true;
  for (let i = 0; i < 10; i++) eng._frame();

  const gl = eng.renderer.getContext();
  const W = eng.renderer.domElement.width;
  const H = eng.renderer.domElement.height;
  const N = W * H;
  const grab = () => {
    eng._frame();
    const o = new Uint8Array(N * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, o);
    return o;
  };
  const lumAt = (f, p) => (0.2126 * f[p] + 0.7152 * f[p + 1] + 0.0722 * f[p + 2]) / 255;

  const V3 = Object.getPrototypeOf(eng.camera.position).constructor;
  const _pv = new V3();
  /** World -> framebuffer pixel, y UP (gl.readPixels returns rows bottom-up). */
  const project = (v) => {
    _pv.copy(v).applyMatrix4(eng.camera.matrixWorldInverse);
    if (_pv.z > -eng.camera.near) return null;
    _pv.applyMatrix4(eng.camera.projectionMatrix);
    return [(_pv.x * 0.5 + 0.5) * W, (_pv.y * 0.5 + 0.5) * H];
  };

  const bodyBox = (c) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, any = false;
    for (const hb of c.hitboxes) {
      const m = c.bones[hb.bone].matrixWorld;
      for (let s = 0; s < 8; s++) {
        _pv.set(hb.centre.x + (s & 1 ? hb.half.x : -hb.half.x),
          hb.centre.y + (s & 2 ? hb.half.y : -hb.half.y),
          hb.centre.z + (s & 4 ? hb.half.z : -hb.half.z)).applyMatrix4(m);
        const p = project(_pv);
        if (!p) continue;
        any = true;
        if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0];
        if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1];
      }
    }
    if (!any) return null;
    return [Math.max(0, (x0 | 0) - 5), Math.max(0, (y0 | 0) - 5),
      Math.min(W - 1, Math.ceil(x1) + 5), Math.min(H - 1, Math.ceil(y1) + 5)];
  };

  /**
   * TRUE barrel tip, off the rendered geometry rather than off a constant.
   * Reading RIG.muzzleLocal would make the flash test circular: the same number
   * that positions the flash would also be defining where the muzzle "is", so a
   * wrong constant would pass. Every vertex of the steel mesh rigidly skinned to
   * the right hand is pushed through the bind inverse and the furthest one down
   * the bore is taken.
   */
  const tipOf = (c) => {
    const handR = c.bones[9];
    let tip = null, tipZ = Infinity;
    for (const m of c.meshes) {
      const g = m.geometry;
      const si = g.getAttribute('skinIndex');
      const sw = g.getAttribute('skinWeight');
      const pos = g.getAttribute('position');
      if (!si || !pos || !/steel/.test(m.material.name || '')) continue;
      const bi = m.skeleton.boneInverses[9];
      for (let i = 0; i < pos.count; i++) {
        if (si.getX(i) !== 9 || sw.getX(i) < 0.9) continue;
        const v = new V3().fromBufferAttribute(pos, i).applyMatrix4(bi);
        if (v.z < tipZ) { tipZ = v.z; tip = v.clone(); }
      }
    }
    return tip ? tip.applyMatrix4(handR.matrixWorld) : null;
  };

  /** Saturated cyan: hue 150-210 deg, saturation >= 0.20, value >= 0.10. */
  const isCyan = (r, g, b) => {
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    if (mx < 0.10 || d / mx < 0.20) return false;
    let h;
    if (mx === r) h = 60 * (((g - b) / d) % 6);
    else if (mx === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
    if (h < 0) h += 360;
    return h >= 150 && h <= 210;
  };

  /* ---- per-man silhouette masks, from the real frame -------------------- */
  const F = grab();
  const rows = [];
  for (const c of live) {
    const bb = bodyBox(c);
    const dist = +Math.sqrt(c.bounds.center.distanceToSquared(eng.camera.position)).toFixed(2);
    if (!bb) { rows.push({ id: c.id, px: 0, dist }); continue; }
    for (const m of c.meshes) m.visible = false;
    const Bf = grab();
    for (const m of c.meshes) m.visible = true;
    const mask = new Uint8Array(N);
    let n = 0, y0 = H, y1 = -1;
    for (let y = bb[1]; y <= bb[3]; y++) {
      for (let x = bb[0]; x <= bb[2]; x++) {
        const k = y * W + x, p = k * 4;
        const d = Math.abs(F[p] - Bf[p]) + Math.abs(F[p + 1] - Bf[p + 1])
          + Math.abs(F[p + 2] - Bf[p + 2]);
        if (d <= 20) continue;
        mask[k] = 1; n++;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
    rows.push({ id: c.id, px: n, dist, mask, bh: y1 - y0 + 1, bb });
  }

  /* ---- cyan, attributed to the rim by ablation -------------------------- */
  const cyanOn = rows.map((r) => {
    if (!r.mask) return 0;
    let cy = 0;
    for (let k = 0; k < N; k++) if (r.mask[k] && isCyan(F[k * 4], F[k * 4 + 1], F[k * 4 + 2])) cy++;
    return cy;
  });
  const savedRim = [];
  for (const name of ['fatigue', 'gear', 'steel']) {
    const u = ai.materials[name]?.userData?.rim;
    if (u) { savedRim.push([u, u.uRimStrength.value]); u.uRimStrength.value = 0; }
  }
  const Fno = grab();
  const cyanOff = rows.map((r) => {
    if (!r.mask) return 0;
    let cy = 0;
    for (let k = 0; k < N; k++) {
      if (r.mask[k] && isCyan(Fno[k * 4], Fno[k * 4 + 1], Fno[k * 4 + 2])) cy++;
    }
    return cy;
  });
  for (const [u, v] of savedRim) u.uRimStrength.value = v;

  /* ---- flash: spawn one deliberately, then isolate it in the image ------ */
  // Kill every card first so only the one under test is on screen.
  for (const it of ai.fx.items) { it.life = 0; it.card.visible = false; it.spike.visible = false; }
  const flashes = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i], c = live[i];
    if (!r.mask || r.px < 200) { flashes.push(null); continue; }
    const tip = tipOf(c);
    const head = new V3().setFromMatrixPosition(c.bones[5].matrixWorld);
    for (const it of ai.fx.items) { it.life = 0; it.card.visible = false; it.spike.visible = false; }
    /**
     * SELF-TEST. With SELFTEST on, the flash is deliberately spawned at the HEAD
     * bone instead of the muzzle — i.e. the exact defect the review described. An
     * assertion nobody has ever seen fail is not evidence of anything, and this
     * project's history is largely a history of tests that could not fail, so the
     * flash gate ships with a switch that reproduces the bug on demand:
     *   node tools/ai10check.mjs --selftest      must report FAIL
     * If it reports PASS, this harness is broken and its verdicts are worthless.
     */
    ai.fx.spawn(SELFTEST ? head : c.anim.muzzle, c.anim.muzzleDir, 1);
    ai.fx.update(0, eng.camera);
    const card = ai.fx.items.find((it) => it.card.visible);
    const cardPos = card ? card.card.position.clone() : null;

    const A = grab();
    ai.fx.group.visible = false;
    const Bg = grab();
    ai.fx.group.visible = true;

    const hp = project(head);
    const mp = project(c.anim.muzzle);

    /**
     * TWO CORRECTIONS, and the first version of this was confidently wrong.
     *
     * A whole-frame diff at a threshold of 24 reported 2741, 2746, 2715, 2665 and
     * 2574 flash pixels for men at 7.2, 7.4, 7.2, 27.6 and 28.3 m — a flash four
     * times further away covering the same area — and put the centroid 8.2
     * body-heights from the distant men's heads, i.e. at the middle of the frame.
     * The card is additive and not tone-mapped, so hiding it changes what
     * AutoExposurePass meters and EVERY pixel in the frame moves. The diff was
     * measuring the exposure change, and the "flash centroid" was the centroid of
     * the image.
     *
     * So: the diff is bounded to a window around the projected muzzle, and the
     * threshold is raised to 60 so a small multiplicative exposure shift cannot
     * clear it. The window is +-3.5 body-heights, which is seven times the
     * head-to-muzzle distance under test — wide enough that it cannot manufacture
     * the answer, narrow enough to exclude the rest of the frame.
     */
    /**
     * The head's own projected box, so the test can ask the question the review
     * actually asks: does the flash land ON HIS FACE. A distance alone cannot,
     * and gating on distance was a mistake the first version of this file made —
     * see MIN_FLASH_HEAD_SCREEN.
     */
    let hb0 = null;
    for (const hb of c.hitboxes) {
      if (hb.name !== 'head') continue;
      const m = c.bones[hb.bone].matrixWorld;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let s = 0; s < 8; s++) {
        _pv.set(hb.centre.x + (s & 1 ? hb.half.x : -hb.half.x),
          hb.centre.y + (s & 2 ? hb.half.y : -hb.half.y),
          hb.centre.z + (s & 4 ? hb.half.z : -hb.half.z)).applyMatrix4(m);
        const p = project(_pv);
        if (!p) continue;
        if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0];
        if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1];
      }
      if (x1 > x0) hb0 = [x0, y0, x1, y1];
    }

    let sx = 0, sy = 0, sw2 = 0, np = 0, onHead = 0;
    if (mp) {
      const rad = Math.max(40, r.bh * 3.5);
      const wx0 = Math.max(0, (mp[0] - rad) | 0), wx1 = Math.min(W - 1, (mp[0] + rad) | 0);
      const wy0 = Math.max(0, (mp[1] - rad) | 0), wy1 = Math.min(H - 1, (mp[1] + rad) | 0);
      for (let y = wy0; y <= wy1; y++) {
        for (let x = wx0; x <= wx1; x++) {
          const p = (y * W + x) * 4;
          const d = Math.abs(A[p] - Bg[p]) + Math.abs(A[p + 1] - Bg[p + 1])
            + Math.abs(A[p + 2] - Bg[p + 2]);
          if (d <= 60) continue;
          // Weight by what the flash ADDED, not by absolute brightness, so a
          // sunlit wall inside the window cannot pull the centroid.
          const w = Math.max(0, lumAt(A, p) - lumAt(Bg, p));
          if (w <= 0) continue;
          sx += x * w; sy += y * w; sw2 += w; np++;
          if (hb0 && x >= hb0[0] && x <= hb0[2] && y >= hb0[1] && y <= hb0[3]) onHead++;
        }
      }
    }
    flashes.push({
      cardPos, tip, head,
      dCardMuzzle: cardPos ? +cardPos.distanceTo(c.anim.muzzle).toFixed(3) : null,
      dCardTip: cardPos && tip ? +cardPos.distanceTo(tip).toFixed(3) : null,
      dCardHead: cardPos ? +cardPos.distanceTo(head).toFixed(3) : null,
      dMuzzleTip: tip ? +c.anim.muzzle.distanceTo(tip).toFixed(3) : null,
      flashPx: np,
      onHeadPct: np ? +((onHead / np) * 100).toFixed(1) : 0,
      screenHead: sw2 > 0 && hp
        ? +(Math.hypot(sx / sw2 - hp[0], sy / sw2 - hp[1]) / Math.max(1, r.bh)).toFixed(3) : null,
      screenMuzzle: sw2 > 0 && mp
        ? +(Math.hypot(sx / sw2 - mp[0], sy / sw2 - mp[1]) / Math.max(1, r.bh)).toFixed(3) : null,
    });
  }
  for (const it of ai.fx.items) { it.life = 0; it.card.visible = false; it.spike.visible = false; }

  /* ---- pose signature: quaternions, stance joints separated from arms --- */
  // 1 pelvis 2 spine 3 chest 4 neck 5 head, 14-19 legs.
  const STANCE = [1, 2, 3, 4, 5, 14, 15, 16, 17, 18, 19];
  const ARMS = [6, 7, 8, 9, 10, 11, 12, 13];
  const sig = (c, idx) => idx.map((i) => {
    const q = c.bones[i].quaternion;
    return [q.x, q.y, q.z, q.w];
  });

  /**
   * Body facing relative to this man's own bearing to the camera. An absolute yaw
   * spread would credit a squad spread around a courtyard with variety it has not
   * got; what matters is how differently they each blade off their own threat
   * line, which is the number a shared AI.bladeAngle pins to zero.
   */
  const relYaw = live.map((c) => {
    const dx = eng.camera.position.x - c.pos.x, dz = eng.camera.position.z - c.pos.z;
    let a = c.group.rotation.y - Math.atan2(-dx, -dz);
    while (a > Math.PI) a -= Math.PI * 2;
    while (a < -Math.PI) a += Math.PI * 2;
    return +a.toFixed(4);
  });

  eng.paused = savedPaused;
  for (const s of savedShooters) ai._shooters.push(s);
  eng.start();

  return {
    resolution: W + 'x' + H,
    combatants: rows.map((r, i) => ({
      id: r.id, px: r.px, dist: r.dist, bh: r.bh ?? 0,
      cyanOn: cyanOn[i], cyanOff: cyanOff[i],
      rimCyanPct: r.px ? +((Math.max(0, cyanOn[i] - cyanOff[i]) / r.px) * 100).toFixed(3) : 0,
      cyanOnPct: r.px ? +((cyanOn[i] / r.px) * 100).toFixed(2) : 0,
      flash: flashes[i] ? {
        dCardMuzzle: flashes[i].dCardMuzzle, dCardTip: flashes[i].dCardTip,
        dCardHead: flashes[i].dCardHead, dMuzzleTip: flashes[i].dMuzzleTip,
        flashPx: flashes[i].flashPx, onHeadPct: flashes[i].onHeadPct,
        screenHead: flashes[i].screenHead, screenMuzzle: flashes[i].screenMuzzle,
      } : null,
      relYaw: relYaw[i],
      stance: sig(live[i], STANCE),
      arms: sig(live[i], ARMS),
    })),
  };
})`;

/* ------------------------------------------------------------------- host --- */

/** Mean geodesic angle, in radians, between corresponding joint quaternions. */
function quatAngle(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    let d = a[i][0] * b[i][0] + a[i][1] * b[i][1] + a[i][2] * b[i][2] + a[i][3] * b[i][3];
    d = Math.min(1, Math.abs(d));
    s += 2 * Math.acos(d);
  }
  return s / a.length;
}

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=d3d11', '--disable-gpu-sandbox', '--ignore-gpu-blocklist'],
});

let failed = false;
const summary = [];
for (const view of want) {
  const q = VIEWS[view];
  if (!q) { console.log(`${view}: unknown view`); failed = true; continue; }
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => { console.log(`  [page error] ${e.message.slice(0, 160)}`); failed = true; });
  try {
    await page.goto(`http://127.0.0.1:5180/?freeze=1&hud=0&quality=cinematic&taa=0&${q}`,
      { waitUntil: 'domcontentloaded', timeout: 300000 });
    await page.waitForFunction('window.__ready === true', null, { timeout: 300000 });
    await page.waitForTimeout(1400);

    const r = await page.evaluate(`(${PROBE})(${has('selftest') ? 'true' : 'false'})`);
    if (r.error) { console.log(`${view}: ${r.error}`); failed = true; await page.close(); continue; }

    const judged = r.combatants.filter((c) => c.px >= MIN_PIXELS);
    console.log(`\n=== ${view} (${r.resolution}) — ${r.combatants.length} combatants,`
      + ` ${judged.length} at >=${MIN_PIXELS}px ===`);
    if (judged.length < 2) {
      console.log('  FAIL fewer than two combatants are large enough in frame to compare');
      failed = true; await page.close(); continue;
    }

    console.log('   id   dist     px   relYaw   cyan%   rimCyan%  flashPx  fl>tip  fl>head'
      + '  scr>head  onHead%');
    for (const c of judged) {
      const f = c.flash || {};
      console.log(`  ${String(c.id).padStart(3)} ${String(c.dist).padStart(6)}`
        + ` ${String(c.px).padStart(6)} ${String(c.relYaw).padStart(8)}`
        + ` ${String(c.cyanOnPct).padStart(7)} ${String(c.rimCyanPct).padStart(10)}`
        + ` ${String(f.flashPx ?? '-').padStart(8)} ${String(f.dCardTip ?? '-').padStart(7)}`
        + ` ${String(f.dCardHead ?? '-').padStart(8)} ${String(f.screenHead ?? '-').padStart(9)}`
        + ` ${String(f.onHeadPct ?? '-').padStart(8)}`);
    }

    /* ---- (a) pose signature + orientation ------------------------------- */
    const clones = [];
    let minStance = Infinity, minArms = Infinity;
    for (let i = 0; i < judged.length; i++) {
      for (let j = i + 1; j < judged.length; j++) {
        const sa = quatAngle(judged[i].stance, judged[j].stance);
        const ar = quatAngle(judged[i].arms, judged[j].arms);
        if (sa < minStance) minStance = sa;
        if (ar < minArms) minArms = ar;
        if (sa < MIN_STANCE_ANGLE) clones.push([judged[i].id, judged[j].id, sa, ar]);
        if (has('diag')) {
          console.log(`    pose ${judged[i].id}-${judged[j].id}: stance ${sa.toFixed(4)} rad,`
            + ` arms ${ar.toFixed(4)} rad`);
        }
      }
    }
    const ys = judged.map((c) => c.relYaw);
    const mean = ys.reduce((a, b) => a + b, 0) / ys.length;
    const stdev = Math.sqrt(ys.reduce((a, b) => a + (b - mean) ** 2, 0) / ys.length);
    const range = Math.max(...ys) - Math.min(...ys);

    const okPose = clones.length === 0;
    const okYaw = stdev >= MIN_YAW_STDEV && range >= MIN_YAW_RANGE;

    /* ---- (b) flash ------------------------------------------------------ */
    const withFlash = judged.filter((c) => c.flash && c.flash.flashPx >= 40);
    const badWorld = withFlash.filter((c) => !(c.flash.dCardTip <= MAX_FLASH_TO_MUZZLE)
      || !(c.flash.dCardHead >= MIN_FLASH_TO_HEAD));
    const badScreen = withFlash.filter((c) => !(c.flash.screenHead >= MIN_FLASH_HEAD_SCREEN)
      || c.flash.onHeadPct > MAX_FLASH_ON_HEAD_PCT);
    const okFlash = withFlash.length > 0 && badWorld.length === 0 && badScreen.length === 0;

    /* ---- (c) cyan ------------------------------------------------------- */
    const badCyan = judged.filter((c) => c.rimCyanPct > MAX_RIM_CYAN_PCT
      && (c.cyanOn - c.cyanOff) >= MIN_RIM_CYAN_PX);
    const okCyan = badCyan.length === 0;

    if (!okPose || !okYaw || !okFlash || !okCyan) failed = true;

    console.log(`  ${okPose ? 'PASS' : 'FAIL'} pose signature       ${clones.length} cloned pair(s) of`
      + ` ${(judged.length * (judged.length - 1)) / 2}; closest stance`
      + ` ${minStance === Infinity ? '-' : minStance.toFixed(4)} rad (need ${MIN_STANCE_ANGLE}),`
      + ` closest arms ${minArms === Infinity ? '-' : minArms.toFixed(4)} rad`);
    for (const c of clones) {
      console.log(`       -> ${c[0]} and ${c[1]} share a stance: ${c[2].toFixed(4)} rad mean joint angle`);
    }
    console.log(`  ${okYaw ? 'PASS' : 'FAIL'} body orientation     stdev ${stdev.toFixed(3)} rad`
      + ` (need ${MIN_YAW_STDEV}), range ${range.toFixed(3)} rad (need ${MIN_YAW_RANGE})`
      + ` over ${judged.length} men, measured off each man's own bearing to camera`);
    console.log(`  ${okFlash ? 'PASS' : 'FAIL'} muzzle flash         ${withFlash.length} measurable;`
      + ` world ${badWorld.length} bad (need <=${MAX_FLASH_TO_MUZZLE} m to the barrel tip,`
      + ` >=${MIN_FLASH_TO_HEAD} m from the head bone), screen ${badScreen.length} bad`
      + ` (need >=${MIN_FLASH_HEAD_SCREEN} body-heights from the projected head and`
      + ` <=${MAX_FLASH_ON_HEAD_PCT}% of its bright pixels on the head)`);
    for (const c of badScreen) {
      console.log(`       -> ${c.id} flash centroid ${c.flash.screenHead} body-heights from his head,`
        + ` ${c.flash.onHeadPct}% of it ON the head — this is the "fires out of his face" read`);
    }
    console.log(`  ${okCyan ? 'PASS' : 'FAIL'} rim cyan             worst ${
      Math.max(0, ...judged.map((c) => c.rimCyanPct)).toFixed(3)}% / ${
      Math.max(0, ...judged.map((c) => c.cyanOn - c.cyanOff))} px of body pixels moved into the`
      + ` saturated cyan band BY THE RIM (need <=${MAX_RIM_CYAN_PCT}% or <${MIN_RIM_CYAN_PX} px)`);
    for (const c of badCyan) {
      console.log(`       -> ${c.id} rim adds ${c.rimCyanPct}% cyan (${c.cyanOn - c.cyanOff} px)`);
    }
    summary.push({ view, okPose, okYaw, okFlash, okCyan });
  } catch (err) {
    console.log(`${view}: ${String(err.message).slice(0, 220)}`);
    failed = true;
  }
  await page.close();
}

await browser.close();
console.log('');
for (const s of summary) {
  console.log(`  ${s.view.padEnd(16)} pose ${s.okPose ? 'PASS' : 'FAIL'}`
    + `  orientation ${s.okYaw ? 'PASS' : 'FAIL'}  flash ${s.okFlash ? 'PASS' : 'FAIL'}`
    + `  cyan ${s.okCyan ? 'PASS' : 'FAIL'}`);
}
console.log(`${failed ? 'FAIL' : 'PASS'} — combatants ${failed
  ? 'are NOT correct' : 'differ in stance and facing, flash at the muzzle, no cyan rim'}`);
process.exitCode = failed ? 1 : 0;
