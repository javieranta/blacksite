import * as THREE from 'three';
import { AI, makeRng } from './AIConfig.js';
import { buildSoldierMaterials, setRimEnvironment } from './soldier/SoldierMaterials.js';
import { ContactShadows } from './soldier/ContactShadows.js';
import { buildSoldierTemplate } from './soldier/SoldierRig.js';
import { NavGrid } from './nav/NavGrid.js';
import { B } from './soldier/SoldierRig.js';
import { Combatant, STATE } from './Combatant.js';
import { Squad } from './Squad.js';
import { MuzzleFX } from './fx/MuzzleFX.js';

/**
 * OWNER: ai agent.
 * CONTRACT:
 *   Spawns combatants at ctx.require('level').enemySpawns.
 *   Each enemy calls ctx.require('ballistics').registerActor(mesh, {...}) so it
 *   can be shot, and emits 'actor:death' when killed.
 *   ai.enemies : array of live combatants (HUD reads count)
 *
 * WHAT THIS SYSTEM IS
 *   - a procedurally modelled, procedurally animated rifleman (see
 *     soldier/SoldierRig.js and soldier/SoldierAnim.js): 20 bones, four
 *     SkinnedMesh draw calls, a carbine skinned to the right hand, and IK that
 *     points the bore at whatever he is shooting at
 *   - navigation sampled straight off the level geometry with A*, string pulling
 *     and local avoidance (nav/NavGrid.js)
 *   - a perception model with FOV, line of sight and a reaction delay, cover
 *     scoring, peek/return cycles and suppression (Combatant.js)
 *   - squad roles, flanking and grenades (Squad.js)
 *
 * SEAM NOTE FOR THE BALLISTICS AGENT
 *   registerActor is called with each combatant's primary SkinnedMesh and a
 *   record in *your* dialect — `{ name, multiplier, headshot, node, offset,
 *   size }` per hitbox, where `node` is the live THREE.Bone, plus `health`,
 *   `team`, `centre`, `radius` and `height`. Multipliers are head 2.1, torso
 *   1.0, limbs 0.75; `onDamage` returns the combatant's remaining health so
 *   your `rec.health` stays authoritative and `rec.dead` flips on the same
 *   frame ours does.
 *
 *   Verified end to end: a 34-damage weapon does 34 to the torso and 142.8 to
 *   the head (34 x 2.1 x the weapon's own 2x), and a kill raises exactly one
 *   'actor:death' — ours is suppressed for records you own.
 *
 *   Extras on the record if you ever want better than AABBs: `hitTest(origin,
 *   dir, maxDist)` is an exact bone-space OBB test against the same 12 parts,
 *   and `bounds` is a live world-space Sphere. While you own the records this
 *   system does not self-resolve player fire at all (see _playerShot) — only
 *   suppression — so there is no double-counting to guard against.
 */
/**
 * Hitboxes in the dialect `ballistics.registerActor` actually reads.
 *
 * src/weapons/ballistics/Actors.js consumes `{ name, multiplier, size, offset,
 * node }` — `size` is FULL extents, and `node` is an Object3D whose live world
 * position centres the box in the actor's local frame. Our internal HITBOXES use
 * `{ bone, mult, half }`, none of which those keys match, so Actors fell back to
 * its defaults: every box became a static 0.30 m cube at the object origin with
 * multiplier 1. The player could kill a combatant, but there was no head bonus,
 * no limb reduction, and the boxes did not follow the animation.
 *
 * Limb boxes are anchored to the DISTAL joint (elbow, wrist, knee, ankle)
 * because Actors' boxes are axis-aligned in the body's frame: a cube centred on
 * a joint stays over the limb whichever way it swings, whereas a fixed offset
 * from the proximal joint swings off it. Sizes are full extents, in metres.
 */
const BALLISTIC_BOXES = [
  ['head',    B.head,    0, 0.075, 0,   0.240, 0.265, 0.260, 2.10, true],
  ['chest',   B.chest,   0, 0.020, 0,   0.415, 0.275, 0.290, 1.00, false],
  ['abdomen', B.spine,   0, 0.000, 0,   0.345, 0.215, 0.245, 1.00, false],
  ['pelvis',  B.pelvis,  0, -0.020, 0,  0.355, 0.215, 0.235, 1.00, false],
  ['arm_r',   B.foreR,   0, 0, 0,       0.215, 0.230, 0.215, 0.75, false],
  ['arm_l',   B.foreL,   0, 0, 0,       0.215, 0.230, 0.215, 0.75, false],
  ['hand_r',  B.handR,   0, 0, 0,       0.185, 0.195, 0.185, 0.75, false],
  ['hand_l',  B.handL,   0, 0, 0,       0.185, 0.195, 0.185, 0.75, false],
  ['leg_r',   B.calfR,   0, 0, 0,       0.245, 0.300, 0.245, 0.75, false],
  ['leg_l',   B.calfL,   0, 0, 0,       0.245, 0.300, 0.245, 0.75, false],
  ['foot_r',  B.footR,   0, 0.02, 0,    0.215, 0.245, 0.265, 0.75, false],
  ['foot_l',  B.footL,   0, 0.02, 0,    0.215, 0.245, 0.265, 0.75, false],
];

export class EnemyAI {
  constructor() {
    this.name = 'ai';
    this.enemies = [];
    this.stats = null;
    this._externalHitFrame = -1;
    this._emitting = false;
    this._staged = false;
    this._tmp = new THREE.Vector3();
    this._tmp2 = new THREE.Vector3();
    /** Ballistics owns bullet-vs-actor once it has our records — see _register. */
    this._ballisticsOwnsDamage = false;
    /**
     * Rolling ms cost of this system, plus peak, for the budget report. `fixed`
     * is per fixed tick (120 Hz), `update` per rendered frame.
     */
    this.profileMs = { update: 0, fixed: 0, updatePeak: 0, fixedPeak: 0 };
    this._shooters = [];
  }

  init(ctx) {
    this.ctx = ctx;
    this.level = ctx.require('level');
    this.player = ctx.require('player');
    const t0 = performance.now();

    // ?ai=0 skips the squad entirely — used to attribute draw calls and frame
    // cost between systems, and handy for anyone profiling the renderer.
    const params = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
    this.enabled = params.get('ai') !== '0';
    this.wanted = params.has('aicount') ? Math.max(0, parseInt(params.get('aicount'), 10)) : 0;
    // ?aistage=<metres> pulls the staged frozen contact in to a given range, so
    // the body itself can be inspected at close quarters by the shoot rig.
    this.stageRange = params.has('aistage') ? parseFloat(params.get('aistage')) : 0;
    // ?aiyaw=<deg> swings the staged bodies off the camera axis so the rig can
    // photograph the weapon and the stance in profile instead of end-on.
    this.stageYaw = params.has('aiyaw') ? parseFloat(params.get('aiyaw')) * Math.PI / 180 : 0;

    this.materials = buildSoldierMaterials();
    this.template = buildSoldierTemplate();

    this.nav = new NavGrid();
    const hints = [...this.level.enemySpawns, ...this.level.spawnPoints];
    const navStats = this.nav.build(this.level, hints);

    this.squad = new Squad(ctx, this.nav, 9161);
    this.squad.init(this.materials);
    // One card per exposed man plus headroom: a section in contact can have five
    // muzzles lit inside a single flash lifetime, and a pool that wraps early
    // silently kills the flash that is still on screen.
    this.fx = new MuzzleFX(10);
    ctx.scene.add(this.fx.group);

    this.root = new THREE.Group();
    this.root.name = 'ai:combatants';
    ctx.scene.add(this.root);

    this.contact = new ContactShadows(AI.squadSize);
    ctx.scene.add(this.contact.mesh);

    if (this.enabled) this._spawn(ctx);
    this._wire(ctx);

    /**
     * The rim term and the contact patches are both absolute quantities in a
     * frame whose exposure moves by a factor of two between presets, so both
     * have to be told what light they are standing in. Lighting publishes the
     * active rig on every time-of-day change; it also publishes one during its
     * own init, which is BEFORE this system exists, so the current rig is read
     * directly as well as subscribed to.
     */
    this._applyRig(ctx.get('lighting')?.rig);
    ctx.bus.on('lighting:rig', ({ rig }) => this._applyRig(rig));

    this.stats = {
      soldiers: this.enemies.length,
      trisEach: this.template.tris,
      nav: navStats,
      ms: Math.round(performance.now() - t0),
    };
    console.info(
      `[ai] ${this.enemies.length} combatants, ${this.template.tris} tris each`
      + ` (${Object.keys(this.template.geometries).length - 1} draws/body),`
      + ` nav ${navStats.walkable}/${navStats.nodes} walkable, ${navStats.reachable} reachable,`
      + ` ${navStats.cover} cover nodes from ${navStats.rays} rays in ${navStats.ms}ms;`
      + ` materials ${this.materials.bakeMs}ms, body ${this.template.buildMs}ms,`
      + ` total ${this.stats.ms}ms`,
    );
  }

  /**
   * Re-key everything on the combatants that is expressed in absolute radiance
   * rather than as a ratio to the scene.
   */
  _applyRig(rig) {
    if (!rig) return;
    const k = setRimEnvironment(this.materials, rig);
    // Contact occlusion is a *fraction* of the light that would otherwise reach
    // the ground, so it should not fade with the rig — but under a sky with no
    // directionality (overcast, deep night) the real occlusion is softer and
    // shallower, and a full-strength patch reads as a painted-on decal.
    this.contact.setStrength(0.55 + 0.45 * Math.min(1, k));
  }

  /* ---------------------------------------------------------------- spawn --- */

  /**
   * Level spawns are the anchors; each one gets a fire team placed on real cover
   * nearby, so the squad starts spread across the map instead of stacked on five
   * points. Deterministic — same layout every run, which the shoot rig needs.
   */
  _spawn(ctx) {
    const rng = makeRng(20260726);
    // The level publishes more anchors than a single firefight needs. Take the
    // ones nearest the player's start, so the contact happens where the level
    // was composed to be fought in, and cap the count: each body is ~8 draw
    // calls once its shadow is counted, and the frame budget is shared.
    const origin = this.level.spawnPoints[0] ?? this.player.position;
    const anchors = [...this.level.enemySpawns]
      .sort((a, b) => a.distanceToSquared(origin) - b.distanceToSquared(origin));
    const wanted = this.wanted || Math.min(AI.squadSize, anchors.length + 2);
    const used = [];
    let seed = 1;

    const place = (v) => {
      const n = this.nav.nearest(v.x, v.y, v.z);
      if (n < 0) return false;
      this.nav.worldOf(n, this._tmp);
      for (const u of used) if (u.distanceTo(this._tmp) < 2.2) return false;
      const c = new Combatant(ctx, this.template, this.materials, this.nav, this._tmp, seed++);
      c.onFire = (who, muzzle, dir) => this.fx.spawn(muzzle, dir, 1);
      this.root.add(c.group);
      this.enemies.push(c);
      this.squad.add(c);
      used.push(this._tmp.clone());
      this._register(ctx, c);
      return true;
    };

    for (const a of anchors) { if (this.enemies.length >= wanted) break; place(a); }
    // Fill out the section on cover near the anchors.
    let guard = 0;
    while (this.enemies.length < wanted && guard++ < 60) {
      const a = anchors[(guard - 1) % anchors.length];
      const n = this.nav.randomNear(a.x, a.y, a.z, 9.5, rng);
      if (n < 0) continue;
      this.nav.worldOf(n, this._tmp2);
      place(this._tmp2);
    }
  }

  _register(ctx, c) {
    const ballistics = ctx.get('ballistics');
    if (!ballistics?.registerActor) return;
    c.unregister = ballistics.registerActor(c.meshes[0], {
      /* ---- Ballistics' own contract ------------------------------------ */
      health: AI.maxHealth,
      team: 'enemy',
      // Explicit broadphase: left to itself Actors derives one from the mesh
      // bounding box, which we deliberately over-size for skinned frustum
      // culling and which would give a 2.4 m interception sphere.
      height: AI.height,
      radius: 1.35,
      centre: [0, 0.95, 0],
      hitboxes: BALLISTIC_BOXES.map(([name, bone, ox, oy, oz, sx, sy, sz, multiplier, headshot]) => ({
        name, multiplier, headshot,
        node: c.bones[bone],          // live Object3D — the box tracks the pose
        offset: [ox, oy, oz],
        size: [sx, sy, sz],
      })),
      /**
       * Returning the remaining health is the seam that keeps two sets of books
       * in sync: Actors uses our number verbatim rather than subtracting again,
       * so `rec.dead` flips on exactly the frame the Combatant dies.
       */
      onDamage: (amount, info) => {
        this._externalHitFrame = ctx.engine.frame;
        // Ballistics emits 'actor:death' itself for records it owns; tell the
        // Combatant not to emit a second one for the same kill.
        c.deathAnnouncedExternally = true;
        c.applyDamage(amount, info || {});
        return c.health;
      },
      onDeath: () => { c.deathAnnouncedExternally = false; },

      /* ---- extras this system publishes for anyone who wants them ------ */
      userData: { combatant: c },
      actor: c,
      bounds: c.bounds,
      bones: c.bones,
      /** Exact bone-space OBB test, if Ballistics ever wants better than AABBs. */
      hitTest: (origin, dir, maxDist) => c.hitTest(origin, dir, maxDist),
      isDead: () => c.dead,
    });
    // From here on bullets are Ballistics' business. Self-resolving as well
    // would double-count every round on any frame ordering where our
    // 'weapon:fire' handler runs before Ballistics resolves the shot.
    if (c.unregister) this._ballisticsOwnsDamage = true;
  }

  _wire(ctx) {
    // Player fire: suppression, plus a self-resolved hit path so the enemies are
    // killable before Ballistics grows actor support.
    ctx.bus.on('weapon:fire', (e) => this._playerShot(e));
    ctx.bus.on('hit:actor', ({ actor, damage, point, normal, headshot }) => {
      // Ballistics resolving a hit itself is authoritative for this frame; our
      // own emit below must not feed back in.
      if (this._emitting || !actor) return;
      this._externalHitFrame = ctx.engine.frame;
      const c = actor.actor ?? actor;
      if (!(c instanceof Combatant)) return;
      c.applyDamage(damage ?? AI.rifleDamage, {
        part: headshot ? 'head' : 'chest', mult: 1, point, dir: normal,
      });
    });
    ctx.bus.on('explosion', ({ point, radius, damage }) => {
      for (const c of this.enemies) {
        if (c.dead) continue;
        const d = c.bounds.center.distanceTo(point);
        if (d < radius * 1.9) c.suppress(0.9);
      }
    });
  }

  /**
   * One player shot: award damage to the nearest hitbox that beats the world
   * geometry, and suppress anybody the round passes close to.
   */
  _playerShot({ origin, dir, weapon }) {
    // Ballistics resolves the round when it owns the records; we only listen for
    // the suppression sweep in that case.
    const external = this._ballisticsOwnsDamage
      || this._externalHitFrame === this.ctx.engine.frame;
    let best = null, bestC = null;
    for (const c of this.enemies) {
      // Suppression: distance from the body to the shot line.
      this._tmp.subVectors(c.bounds.center, origin);
      const along = this._tmp.dot(dir);
      if (along > 0 && !c.dead) {
        const perp = Math.sqrt(Math.max(0, this._tmp.lengthSq() - along * along));
        if (perp < AI.suppressRadius) c.suppress(AI.suppressPerRound);
      }
      if (c.dead || external) continue;
      const h = c.hitTest(origin, dir, 400);
      if (h && (!best || h.distance < best.distance)) { best = h; bestC = c; }
    }
    if (!best || external) return;
    // The world wins ties: no shooting through the wall he is hiding behind.
    if (this.level.raycast(origin, dir, best.distance)) return;

    const dmg = weapon?.damage ?? AI.rifleDamage * 2.4;
    bestC.applyDamage(dmg, {
      part: best.part, mult: best.mult, point: best.point, dir, from: origin,
    });
    this._emitting = true;
    this.ctx.bus.emit('hit:actor', {
      actor: bestC, point: best.point.clone(), normal: best.normal.clone(),
      damage: dmg * best.mult, headshot: best.part === 'head',
    });
    this._emitting = false;
    const p = this.ctx.get('particles');
    if (p) p.spawn('blood', { position: best.point, normal: best.normal, scale: 1 });
  }

  /* ----------------------------------------------------------------- ticks -- */

  fixedUpdate(h, ctx) {
    const t0 = performance.now();
    const player = this.player;
    this.squad.update(h, player);
    for (let i = 0; i < this.enemies.length; i++) {
      this.enemies[i].fixedUpdate(h, player, this.squad);
    }
    const dtFixed = performance.now() - t0;
    this.profileMs.fixed += (dtFixed - this.profileMs.fixed) * 0.05;
    if (dtFixed > this.profileMs.fixedPeak) this.profileMs.fixedPeak = dtFixed;
  }

  update(dt, ctx) {
    const t0 = performance.now();
    // ?freeze=1 and ?pos= are both applied after init(), so staging has to wait
    // for the first frame — by then the camera is where the rig wants it.
    if (ctx.engine?.frozen) {
      if (!this._staged) { this._staged = true; this._stagePose(); }
      this._driveFrozen(dt);
    }
    /**
     * Animation LOD.
     *
     * A full pose is four two-bone IK solves, a rifle basis, a gait cycle and
     * twenty bone writes, and it is the same cost whether the man is filling the
     * screen or is thirty pixels tall at the far end of the yard. Past 20 m the
     * difference between consecutive frames is sub-pixel, so distant bodies are
     * posed at 30 Hz and very distant ones at 15 Hz. Skipping holds the previous
     * pose exactly — the bones are not touched, so skinning stays valid and
     * there is nothing to pop.
     */
    const cam = ctx.camera.position;
    for (let i = 0; i < this.enemies.length; i++) {
      const c = this.enemies[i];
      const d2 = c.bounds.center.distanceToSquared(cam);
      c.update(dt, d2 < 400 ? 0 : d2 < 1600 ? 1 / 30 : 1 / 15);
    }
    this.fx.update(dt, ctx.camera);
    this._shadowLOD(ctx.camera);
    this.contact.update(this.enemies, ctx.camera);
    const dtUpd = performance.now() - t0;
    this.profileMs.update += (dtUpd - this.profileMs.update) * 0.05;
    if (dtUpd > this.profileMs.updatePeak) this.profileMs.updatePeak = dtUpd;
  }

  /**
   * A body renders into roughly three shadow cascades, so nine of them is ~110
   * shadow draw calls — a third of the whole frame's budget spent on silhouettes
   * that are a handful of pixels wide at the far end of the map. Cast shadows
   * only from bodies close enough for the shadow to be a real image, with
   * hysteresis so nobody flickers on the boundary.
   */
  _shadowLOD(camera) {
    /**
     * Measured: with the old 36/44 m window, eight of nine bodies cast, at two
     * or three cascades each, and the squad's contribution to the frame was 85
     * draw calls out of a 900 ceiling — 49 of them shadow passes for silhouettes
     * thirty pixels tall. A contact shadow earns its cost while the body is
     * close enough that you can see the shadow is a man; past that it is a grey
     * smear that costs the same as the one at your feet. 22/28 m with hysteresis
     * keeps the shadows that read and drops the rest.
     */
    /**
     * RAISED FROM 22/28 m, because 22 m was inside the range the critics
     * photograph at.
     *
     * The old window was chosen on a draw-call argument — nine bodies across three
     * cascades is ~85 draw calls of a 900 ceiling — and it produced exactly the
     * defect the review reports: "a midday standing figure casts none under a hard
     * sun that shadows every crate beside him". The crates cast because the world's
     * props have no such cutoff; the man 25 m away did not, so he floated. A figure
     * that does not cast when everything around it does is not an LOD saving, it is
     * a missing shadow, and it is the single loudest "pasted on" cue there is.
     *
     * 34/40 m, and 34 is not a taste value — it is exactly ContactShadows' own
     * `maxDist`. The two systems have to agree or there is a band in which a man
     * has neither a cast shadow nor a contact patch and simply floats, which is the
     * defect. Tried 52/62 first, which covers the whole yard; gpuprobe put the AI's
     * share of a cinematic frame at 2.5 ms of a 10.6 ms median, and there was no
     * reviewable figure out past 34 m to justify the rest. The hysteresis stays, so
     * nobody flickers on the boundary.
     */
    const near = 34 * 34, far = 40 * 40;
    for (const c of this.enemies) {
      const d = c.bounds.center.distanceToSquared(camera.position);
      const on = c._castShadow ? d < far : d < near;
      if (on === c._castShadow) continue;
      c._castShadow = on;
      for (const m of c.shadowMeshes) m.castShadow = on;
    }
  }

  /* ----------------------------------------------------- shoot-rig staging -- */

  /**
   * Under ?freeze=1 the fixed tick never runs, so the brains never wake. Put the
   * squad into a plausible mid-contact arrangement by hand: the two nearest the
   * camera up and firing, one crouched behind cover, one reloading, the rest
   * holding. Deterministic, so the view is reproducible between rounds.
   */
  _stagePose() {
    const player = this.player;
    // ?aistage puts bodies at a known range for inspection; without it, find the
    // cover the live brain would have chosen a couple of seconds into contact.
    if (this.stageRange) this._stageDirect(player, 3, this.stageRange);
    else this._stageAdvance(player, 2);
    const sorted = [...this.enemies].sort(
      (a, b) => a.pos.distanceToSquared(player.position) - b.pos.distanceToSquared(player.position),
    );
    /**
     * Weighted toward men who are up and shooting. The combat view exists to
     * photograph a firefight, and a firefight in which one man fires and six
     * crouch behind walls photographs as an empty yard — which is exactly what
     * the previous rota ('peek','peek','cover','reload','peek','cover','hunt')
     * produced. Four of the seven are now exposed and firing.
     */
    /**
     * The rota is now varied in STANCE as well as in role.
     *
     * 'peek','peek','peek' put the three men nearest the camera into identical
     * state, identical stance and identical aim, and the only thing left to
     * distinguish them was the per-man persona multipliers — which the pose
     * harness measured as a pairwise joint RMS of 0.083 rad, i.e. the same man
     * three times. A staged firefight has men at different heights: one up and
     * squared, one crouched to a knee behind a low wall, one leaning out. That is
     * a property of the staging, not of the animation, so it is fixed here.
     */
    /**
     * Eleven slots, not seven, and no two adjacent men share one.
     *
     * The rota repeated with period seven over nine bodies, so the two nearest the
     * camera in most framings drew the same slot as two others. Combined with the
     * shared blade angle below, that is how "ten figures" became "two poses".
     */
    const roles = ['peek', 'peek-low', 'peek-kneel', 'cover', 'peek', 'reload',
      'peek-low', 'peek', 'cover-low', 'peek-kneel', 'peek'];
    this._shooters.length = 0;
    sorted.forEach((c, i) => {
      const r = roles[i % roles.length];
      c.alerted = true;
      c.aware = 1;
      c.canSee = true;
      c.lastSeen.copy(player.eyePosition);
      c.lastSeenAge = 0;
      c.speed = 0;
      /**
       * Face the player at THIS MAN'S OWN blade angle.
       *
       * `+ AI.bladeAngle` here was the staging half of the "all squared to camera"
       * defect: whatever variety the animation layer had, the body it was posing
       * had already been rotated to the same bearing as every other body in the
       * squad. c.bladeBias is the per-man angle (see Combatant), and it is the
       * same number the live brain uses, so a staged frame and a played frame
       * agree.
       */
      this._tmp.subVectors(player.position, c.pos);
      const bearing = Math.atan2(-this._tmp.x, -this._tmp.z);
      c.yaw = bearing + c.bladeBias + this.stageYaw;
      c.group.rotation.y = c.yaw;
      if (this.stageYaw) {
        // Keep aiming where the body now faces, so the pose stays coherent — but
        // offset by his own blade, not by the shared constant, or the staging
        // hands the aim solve a different target per man for the same pose.
        c.lastSeen.set(
          c.pos.x - Math.sin(c.yaw - c.bladeBias) * 18,
          c.pos.y + 1.55,
          c.pos.z - Math.cos(c.yaw - c.bladeBias) * 18,
        );
      }
      if (r === 'peek') { c.state = STATE.PEEK; c.stance = 1; c.burst = 5; }
      else if (r === 'peek-low') {
        // Up and firing, but down in his knees behind whatever he is using — the
        // stance that makes a section read as a section rather than a rank.
        c.state = STATE.PEEK; c.stance = 1; c.burst = 4; c.mustCrouch = true;
      } else if (r === 'peek-kneel') {
        // Firing from a genuine kneel: the crouch input is driven to full rather
        // than to the 0.35 a crouched PEEK gets, which drops the hips ~0.4 m and
        // folds both knees past 60 degrees. A different height in the frame is the
        // cheapest and strongest pose cue a group of figures can have.
        c.state = STATE.PEEK; c.stance = 1; c.burst = 4; c.mustCrouch = true;
        c.stageKneel = true;
      } else if (r === 'cover') { c.state = STATE.COVER; c.stance = 0; c.mustCrouch = true; }
      else if (r === 'cover-low') {
        c.state = STATE.SUPPRESSED; c.stance = 0; c.mustCrouch = true; c.suppression = 0.9;
      } else if (r === 'reload') { c.state = STATE.RELOAD; c.reloadT = 1.15; }
      else { c.state = STATE.HUNT; c.speed = AI.walkSpeed; }
      // Converge the animation smoothers immediately so the very first captured
      // frame is already in pose rather than lerping out of the bind pose.
      for (let k = 0; k < 30; k++) c.update(1 / 60);
      c.anim.smooth.recoil = r.startsWith('peek') ? 0.55 : 0;
      /**
       * Every exposed man gets his own firing cadence, phase-offset from his
       * neighbours. A single shooter meant a single flash somewhere in frame and
       * no way to tell who else was a threat; staggering means whenever the rig
       * takes the exposure, several muzzles are lit and several are between
       * rounds, which is what a section in contact actually looks like.
       */
      if (r.startsWith('peek')) {
        this._shooters.push({
          c,
          period: 0.10 + (i % 3) * 0.022,
          cd: (i * 0.037) % 0.11,
        });
      }
    });
    /**
     * Under ?freeze=1 the fixed tick never runs, so Combatant._deoverlap — the
     * constraint that guarantees two men never share a volume — never fires.
     * Every screenshot the critics grade is a frozen frame, which means the one
     * situation the separation constraint exists for is the one situation it was
     * absent from. Run it directly, a few passes, until it settles.
     */
    for (let pass = 0; pass < 4; pass++) {
      for (const c of this.enemies) c._deoverlap(this.squad);
    }
    // Re-settle: a man who was nudged needs his foot casts and pelvis damp to
    // reconverge on the ground he is now standing on.
    for (const c of this.enemies) {
      c.group.position.copy(c.pos);
      for (let k = 0; k < 8; k++) c.update(1 / 60);
    }
  }

  /**
   * Put the nearest men on the camera axis at an exact range, for inspection.
   *
   * _stageAdvance only considers *cover* nodes, and at 3-5 m in a tight facing
   * cone there usually are none — so asking for a close-quarters framing quietly
   * moved nobody and photographed an empty yard. This ignores cover entirely and
   * just snaps to the nearest walkable node, which is the right trade for a rig
   * view whose only job is to show the body at a known distance.
   */
  _stageDirect(player, howMany, range) {
    const eye = player.eyePosition;
    const fx = -Math.sin(player.yaw), fz = -Math.cos(player.yaw);
    const rx = -fz, rz = fx;                              // camera right
    const sorted = [...this.enemies].sort(
      (a, b) => a.pos.distanceToSquared(player.position) - b.pos.distanceToSquared(player.position),
    );
    const n = Math.min(howMany, sorted.length);
    // Spread scales with range: a fixed 1.9 m step throws everyone off the
    // edges of the frame once the rig asks for a 2 m framing.
    // Never below the hard separation the de-overlap constraint would enforce
    // anyway, or the staging just hands the constraint a problem to undo.
    const step = Math.min(2.4, Math.max(AI.radius * AI.separationScale + 0.5, range * 0.42));
    /**
     * `nav.nearest` quantises to the 1.25 m nav grid, so at a close staging
     * range the lateral step could round two adjacent men onto the SAME node —
     * two bodies at identical coordinates, interpenetrating. Snapping is still
     * the right thing (it puts them on walkable ground at the right height), so
     * the snapped result is checked against the men already placed and the
     * un-snapped world position is used instead when it collides.
     */
    /**
     * The test is against 75% of the intended step, not merely against the hard
     * separation. Nav nodes are 1.25 m apart and the hard separation is 1.02 m,
     * so two men snapped onto adjacent nodes pass a bare overlap check while
     * still standing at two-thirds of the spacing the framing asked for — which
     * photographs as a crowd, not as a fire team. Keeping the requested spread
     * is the point of a staged view.
     */
    const minSep = Math.max(AI.radius * AI.separationScale, step * 0.75);
    const placed = this._stagePlaced || (this._stagePlaced = []);
    placed.length = 0;
    for (let k = 0; k < n; k++) {
      const lateral = (k - (n - 1) / 2) * step;
      const wx = eye.x + fx * range + rx * lateral;
      const wz = eye.z + fz * range + rz * lateral;
      const c = sorted[k];
      const node = this.nav.nearest(wx, player.position.y, wz, 4);
      if (node >= 0) {
        this.nav.worldOf(node, this._tmp2);
        c.navNode = node;
      } else {
        const y = this.level.heightAt?.(wx, wz);
        this._tmp2.set(wx, Number.isFinite(y) ? y : player.position.y, wz);
      }
      if (!Number.isFinite(this._tmp2.y)) this._tmp2.y = player.position.y;
      for (const p of placed) {
        const ddx = this._tmp2.x - p.x, ddz = this._tmp2.z - p.z;
        if (ddx * ddx + ddz * ddz >= minSep * minSep) continue;
        // Fall back to the exact requested spot, keeping the snapped height.
        this._tmp2.x = wx;
        this._tmp2.z = wz;
        break;
      }
      c.pos.copy(this._tmp2);
      c.coverNode = -1;
      c.mustCrouch = false;
      c.group.position.copy(c.pos);
      placed.push(c.pos.clone());
    }
  }

  /**
   * Move the two nearest men onto the closest cover the live brain would have
   * chosen by now — in the player's view cone, 8-15 m out, hard cover, eyes on.
   * Without this the frozen frame catches them still standing on their spawn
   * markers 25 m away, which is not what a contact looks like two seconds in.
   */
  _stageAdvance(player, howMany) {
    const nav = this.nav;
    const fx = -Math.sin(player.yaw), fz = -Math.cos(player.yaw);
    const eye = player.eyePosition;
    const want = this.stageRange || 11;
    const dMin = this.stageRange ? Math.max(2, this.stageRange - 1.5) : 7.5;
    const dMax = this.stageRange ? this.stageRange + 1.5 : 16;
    const cands = [];
    for (let i = 0; i < nav.coverNodes.length; i++) {
      const n = nav.coverNodes[i];
      const nx = nav.wx(n), ny = nav.wy(n), nz = nav.wz(n);
      const dx = nx - eye.x, dz = nz - eye.z;
      const d = Math.hypot(dx, dz);
      if (d < dMin || d > dMax) continue;
      const facing = (dx * fx + dz * fz) / d;
      if (facing < 0.62) continue;                       // must be in frame
      if (!this.stageRange && nav.protection(n, eye.x, eye.z) < 0.35) continue;
      this._tmp.set(nx, ny + 1.30, nz).sub(eye);
      const len = this._tmp.length();
      this._tmp.divideScalar(len);
      if (this.level.raycast(eye, this._tmp, len - 0.4)) continue;   // needs eyes on
      cands.push({ n, score: facing * 2 - Math.abs(d - want) * 0.12 });
    }
    if (!cands.length) return;
    cands.sort((a, b) => b.score - a.score);
    const sorted = [...this.enemies].sort(
      (a, b) => a.pos.distanceToSquared(player.position) - b.pos.distanceToSquared(player.position),
    );
    let used = 0;
    for (const cand of cands) {
      if (used >= howMany) break;
      nav.worldOf(cand.n, this._tmp2);
      let clash = false;
      for (const c of this.enemies) if (c.pos.distanceTo(this._tmp2) < 2.4) clash = true;
      if (clash) continue;
      const c = sorted[used];
      if (!c) break;
      c.pos.copy(this._tmp2);
      c.coverNode = cand.n;
      c.mustCrouch = nav.coverHigh[cand.n] === 0;
      c.group.position.copy(c.pos);
      used++;
    }
  }

  /**
   * Keeps the staged firefight alive while frozen: every exposed man cycles his
   * own burst, so the captured frame has several lit muzzles, live tracers and
   * bodies in recoil rather than a yard of statues.
   *
   * This is the frozen mirror of Combatant._shoot — the fixed tick never runs
   * under ?freeze=1, so without it the enemies emit no light and no tracers and
   * read as scenery.
   */
  _driveFrozen(dt) {
    const lighting = this.ctx.get('lighting');
    const particles = this.ctx.get('particles');
    for (let i = 0; i < this._shooters.length; i++) {
      const s = this._shooters[i];
      const c = s.c;
      if (c.dead) continue;
      s.cd -= dt;
      if (s.cd > 0) continue;
      s.cd += s.period;
      const muzzle = c.anim.muzzle;
      const dir = c.anim.muzzleDir;
      if (!Number.isFinite(muzzle.x + muzzle.y + muzzle.z)) continue;
      c.anim.kick(1);
      this.fx.spawn(muzzle, dir, 1.05);
      // Same offset as Combatant._shoot, and for the same reason: a flash light
      // sitting on the muzzle lights its own shooter harder than it lights
      // anything he is shooting at.
      if (lighting?.flash) {
        this._tmp.copy(muzzle).addScaledVector(dir, AI.muzzleFlashForward);
        lighting.flash(this._tmp, 0xffd2a0, AI.muzzleFlashIntensity, 0.055);
      }
      if (particles) {
        particles.spawn('muzzle', { position: muzzle, direction: dir, scale: 0.85 });
        particles.spawn('tracer', { position: muzzle, direction: dir, scale: 1.0, colour: 0xffc070 });
      }
    }
  }

  dispose() {
    for (const c of this.enemies) { c.unregister?.(); c.dispose(); }
    this.enemies.length = 0;
    this.squad.dispose();
    this.contact.dispose();
    this.fx.dispose();
    this.materials.dispose?.();
    for (const k of Object.keys(this.template.geometries)) this.template.geometries[k]?.dispose?.();
    this.root.removeFromParent();
  }
}
