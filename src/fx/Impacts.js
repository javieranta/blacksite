import * as THREE from 'three';
import { SURFACES } from '../core/Constants.js';
import { DecalField, DecalProjector } from './impacts/DecalField.js';
import { buildDecalAtlas, DECAL, DECAL_COLS, DECAL_ROWS } from './impacts/DecalAtlas.js';

/**
 * OWNER: impacts agent.
 * CONTRACT:
 *   listens: 'hit:surface', 'hit:actor', 'explosion'
 *   impacts.decal(point, normal, type, size) — also usable directly
 *
 * Every round that lands has to do four things at once, or it reads as a decal
 * stuck to a wall: throw the right debris, mark the surface, make a noise, and —
 * for anything hot — light its surroundings. This system is the table that maps
 * `Constants.SURFACES` onto that combination.
 *
 * Decals are projected, not pasted: see impacts/DecalField.js. Two fields hold
 * them — a multiply field (holes, craters, scorch, blood: these darken and let
 * the surface keep its own lighting and normal detail) and an additive field
 * (the pale powder rim around a concrete crater, the white web in cracked glass,
 * the heat still glowing in fresh steel). One draw call each.
 */

/** Per-surface response, keyed 1:1 with Constants.SURFACES. */
const RESPONSE = {
  concrete: {
    dust: 1.0, debris: 5, sparks: 1,
    patch: 0.34, hole: DECAL.HOLE_CONCRETE,
    rim: DECAL.RING_PALE, rimOpacity: 0.55,
    audio: 'impact_concrete',
  },
  metal: {
    dust: 0.25, debris: 2, sparks: 20,
    patch: 0.26, hole: DECAL.HOLE_METAL,
    rim: DECAL.BURN_GLOW, rimOpacity: 1.0, rimLife: 1.1,
    flash: { colour: 0xffc484, intensity: 3.0, decay: 0.07 },
    audio: 'impact_metal',
  },
  wood: {
    dust: 0.7, debris: 9, sparks: 0,
    patch: 0.32, hole: DECAL.HOLE_WOOD,
    rim: DECAL.SPLINTER_PALE, rimOpacity: 0.45,
    audio: 'impact_wood',
  },
  dirt: {
    dust: 1.35, debris: 5, sparks: 0,
    patch: 0.40, hole: DECAL.CRATER_SOFT, tinted: true,
    rim: DECAL.CRATER_RIM, rimOpacity: 0.32,
    audio: 'impact_dirt',
  },
  sand: {
    dust: 1.7, debris: 3, sparks: 0,
    patch: 0.48, hole: DECAL.CRATER_SOFT, tinted: true,
    rim: DECAL.CRATER_RIM, rimOpacity: 0.5,
    audio: 'impact_sand',
  },
  glass: {
    dust: 0.3, debris: 0, sparks: 0, effect: 'glass', shatter: true,
    patch: 0.55, hole: DECAL.GLASS_CRUSH,
    rim: DECAL.GLASS_WEB, rimOpacity: 0.85,
    audio: 'impact_glass',
  },
  fabric: {
    dust: 0.5, debris: 2, sparks: 0,
    patch: 0.28, hole: DECAL.SCUFF,
    audio: 'impact_fabric',
  },
  flesh: {
    dust: 0, debris: 0, sparks: 0, effect: 'blood',
    patch: 0.42, hole: DECAL.BLOOD,
    rim: DECAL.SHEEN, rimOpacity: 0.30,
    audio: 'impact_flesh',
  },
  water: {
    dust: 0, debris: 0, sparks: 0, effect: 'water_splash',
    audio: 'impact_water',
  },
};

export class Impacts {
  constructor() {
    this.name = 'impacts';

    this._v = new THREE.Vector3();
    this._n = new THREE.Vector3();
    this._d = new THREE.Vector3();
    this._origin = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this._col = new THREE.Color();
    this._opts = {
      position: null, normal: null, direction: null,
      scale: 1, colour: null, count: undefined, floorY: undefined,
    };
    this._firePayload = { origin: null, dir: null, weapon: null, seed: 0 };

    this._rigFire = false;
    this._rigMode = '';
    this._fireTimer = 0;
    this._demoTimer = 0;
    this._emitting = false;
    this._externalFire = 0;
    this._seed = 1;
    this._time = 0;
    this.stats = { decals: 0, decalsAdd: 0 };
  }

  init(ctx) {
    this.ctx = ctx;
    this.particles = ctx.require('particles');
    this.level = ctx.get('level');
    this.lighting = ctx.get('lighting');
    this.audio = ctx.get('audio');

    const t0 = performance.now();
    this.atlas = buildDecalAtlas(1024);
    this.projector = new DecalProjector();

    this.mul = new DecalField({
      capacity: 224,
      additive: false,
      atlas: this.atlas,
      cols: DECAL_COLS,
      rows: DECAL_ROWS,
      name: 'fx:decals:multiply',
    });
    this.add = new DecalField({
      capacity: 144,
      additive: true,
      atlas: this.atlas,
      cols: DECAL_COLS,
      rows: DECAL_ROWS,
      name: 'fx:decals:additive',
      strength: 0.85,
    });
    this.group = new THREE.Group();
    this.group.name = 'fx:decals';
    this.group.add(this.mul.mesh);
    this.group.add(this.add.mesh);
    ctx.scene.add(this.group);

    ctx.bus.on('hit:surface', (e) => this.onSurface(e));
    ctx.bus.on('hit:actor', (e) => this.onActor(e));
    ctx.bus.on('explosion', (e) => this.onExplosion(e));
    ctx.bus.on('weapon:fire', () => {
      if (!this._emitting) this._externalFire = 0.6;
    });

    // Rig hooks. `?fire=1` asks for a firing pose but nothing in the engine
    // actually pulls the trigger, so the screenshot rig would capture a
    // firefight with no firefight in it. Driving the real fire path (rather than
    // faking the visuals) means the capture shows exactly what the game does.
    const params = new URLSearchParams(location.search);
    const fx = params.get('fx') ?? '';
    if ((params.has('fire') && params.get('fire') !== '0') || fx) {
      this._rigFire = true;
      this._rigMode = fx || 'fire';
    }

    console.info(
      `[impacts] decal atlas + ${this.mul.capacity}+${this.add.capacity} projected`
      + ` decal slots in ${Math.round(performance.now() - t0)}ms`,
    );
  }

  // ─────────────────────────────────────────────────────────────── surfaces ──

  onSurface(e) {
    if (!e?.point) return;
    const key = RESPONSE[e.surface] ? e.surface : 'concrete';
    const r = RESPONSE[key];
    const def = SURFACES[key] ?? SURFACES.concrete;
    const point = e.point;
    const normal = this._n.copy(e.normal ?? this._v.set(0, 1, 0)).normalize();
    const inc = this._d.copy(e.incoming ?? normal).normalize();
    if (e.incoming === undefined) inc.negate();
    const energy = e.energy ?? 1;

    const cam = this.ctx.camera.position;
    const dist = cam.distanceTo(point);
    const flat = normal.y > 0.5;

    const o = this._opts;
    o.position = point;
    o.normal = normal;
    o.direction = inc;
    o.floorY = flat ? point.y : undefined;
    o.colour = null;
    o.count = undefined;
    o.scale = 1;

    // ── particles ───────────────────────────────────────────────────────────
    if (r.effect) {
      o.scale = 1;
      this.particles.spawn(r.effect, o);
    }
    if (r.sparks > 0) {
      o.count = Math.round(r.sparks * (0.55 + 0.45 * energy));
      o.scale = 1;
      this.particles.spawn('sparks', o);
      o.count = undefined;
      if (r.flash && dist < 45) {
        this.lighting?.flash?.(point, r.flash.colour, r.flash.intensity, r.flash.decay);
      }
    }
    if (r.dust > 0) {
      o.colour = this._surfaceTint(def.colour, 1.06);
      o.scale = r.dust * (0.75 + 0.35 * energy);
      this.particles.spawn('dust', o);
      o.colour = null;
      o.scale = 1;
    }
    if (r.debris > 0) {
      o.colour = this._surfaceTint(def.colour, 0.62);
      o.count = r.debris;
      this.particles.spawn('debris', o);
      o.colour = null;
      o.count = undefined;
    }

    // ── decals ──────────────────────────────────────────────────────────────
    // Beyond ~70m a bullet hole is sub-pixel; spend the slot on something
    // closer. Both layers share ONE projection — 25 rays per round, not 50.
    if (dist < 70 && r.patch !== undefined) {
      const jitter = 0.84 + this._rnd() * 0.34;
      if (this._project(point, normal, r.patch * jitter)) {
        if (r.hole !== undefined) {
          this._write(this.mul, r.hole, r.tinted ? def.colour : 0xffffff, 42, 1);
        }
        if (r.rim !== undefined) {
          this._write(this.add, r.rim, 0xffffff, r.rimLife ?? 30, r.rimOpacity ?? 0.5);
        }
      }
    }

    if (r.shatter) {
      this.ctx.bus.emit('fx:shatter', { point, normal, surface: 'glass' });
    }

    this.audio?.play?.(r.audio, { position: point, volume: 0.9, pitch: 0.94 + this._rnd() * 0.12 });
  }

  onActor(e) {
    if (!e?.point) return;
    const point = e.point;
    const normal = this._n.copy(e.normal ?? this._v.set(0, 1, 0)).normalize();
    const o = this._opts;
    o.position = point;
    o.normal = normal;
    o.direction = normal;
    o.colour = null;
    o.count = undefined;
    o.floorY = undefined;
    o.scale = e.headshot ? 1.7 : 1;
    this.particles.spawn('blood', o);

    // Spray onto whatever is behind the body — the wall tells the story, not
    // the mist, which is gone in half a second.
    if (this.level?.raycast) {
      const dir = this._d;
      if (e.incoming) dir.copy(e.incoming).normalize();
      else dir.copy(normal).negate();
      const hit = this.level.raycast(this._v.copy(point).addScaledVector(dir, 0.05), dir, 3.2);
      if (hit && this._project(hit.point, hit.normal,
        (e.headshot ? 0.75 : 0.5) * (0.85 + this._rnd() * 0.3))) {
        this._write(this.mul, DECAL.BLOOD, 0xffffff, 55, 1);
        this._write(this.add, DECAL.SHEEN, 0xff9a88, 26, 0.32);
      }
    }
    this.audio?.play?.('impact_flesh', { position: point, volume: 1 });
    this.audio?.play?.('hitmarker', { volume: 0.6 });
  }

  onExplosion(e) {
    if (!e?.point) return;
    const point = e.point;
    const radius = e.radius ?? 6;
    const s = THREE.MathUtils.clamp(radius / 4.5, 0.5, 2.6);

    let groundY = point.y;
    if (this.level?.heightAt) {
      const h = this.level.heightAt(point.x, point.z);
      if (Number.isFinite(h)) groundY = h;
    }

    const o = this._opts;
    o.position = point;
    o.normal = this._n.set(0, 1, 0);
    o.direction = this._d.set(0, -1, 0);
    o.colour = null;
    o.count = undefined;
    o.scale = s;
    o.floorY = groundY;
    this.particles.spawn('explosion', o);

    // A blast is the brightest light in the level for a quarter of a second.
    this.lighting?.flash?.(
      this._v.set(point.x, point.y + 0.6 * s, point.z), 0xffb066, 40 * s, 0.32,
    );

    // Scorch the ground under it.
    if (Math.abs(point.y - groundY) < radius * 0.9) {
      this._v.set(point.x, groundY, point.z);
      this._n.set(0, 1, 0);
      if (this._project(this._v, this._n, radius * 1.15)) {
        this._write(this.mul, DECAL.SCORCH, 0xffffff, 90, 1);
        this._write(this.add, DECAL.CRATER_RIM, 0xffe8c8, 70, 0.30);
      }
    }

    this.audio?.play?.('explosion', { position: point, volume: 1 });
  }

  /**
   * Public decal seam.
   * @param {THREE.Vector3} point
   * @param {THREE.Vector3} normal
   * @param {string|number} type  a DECAL tile index, or a surface key
   * @param {number} size metres
   */
  decal(point, normal, type = 'concrete', size = 0.2) {
    let tile = type;
    let field = this.mul;
    if (typeof type === 'string') {
      tile = RESPONSE[type]?.hole ?? DECAL.HOLE_SMALL;
    }
    if (tile === DECAL.GLASS_WEB || tile === DECAL.RING_PALE || tile === DECAL.BURN_GLOW
      || tile === DECAL.SHEEN || tile === DECAL.DUST_SMUDGE || tile === DECAL.SPLINTER_PALE
      || tile === DECAL.CRATER_RIM) {
      field = this.add;
    }
    if (!this._project(point, normal, size)) return false;
    this._write(field, tile, 0xffffff, 45, 1);
    return true;
  }

  // ──────────────────────────────────────────────────────────────── helpers ──

  /** Snap a patch onto the world once; every layer then shares it. */
  _project(point, normal, size) {
    const target = this.level?.colliders;
    if (!target) return false;
    return this.projector.project(target, point, normal, size, this._rnd() * Math.PI * 2);
  }

  _write(field, tile, tint, life, opacity) {
    this._col.set(tint);
    field.write(this.projector, tile, this._col.r, this._col.g, this._col.b, life, opacity);
  }

  /** Surface albedo as a particle tint, with a brightness trim. */
  _surfaceTint(hex, gain) {
    this._col.set(hex ?? 0x9a9691).multiplyScalar(gain);
    return this._col;
  }

  _rnd() {
    this._seed = (Math.imul(this._seed, 1664525) + 1013904223) >>> 0;
    return this._seed / 4294967296;
  }

  // ───────────────────────────────────────────────────────────── per-frame ──

  update(dt, ctx) {
    if (dt > 0) {
      this._time += dt;
      this._externalFire = Math.max(0, this._externalFire - dt);
      this.mul.update(dt);
      this.add.update(dt);
      if (this._rigFire) this._driveRig(dt, ctx);
    }
    const fog = ctx.scene.fog;
    const density = fog?.isFogExp2 ? fog.density : 0;
    this.mul.flush(density);
    this.add.flush(density);
    this.stats.decals = this.mul.live;
    this.stats.decalsAdd = this.add.live;
  }

  /**
   * Screenshot-rig / debug driver. `?fire=1` (or `?fx=fire|impacts|explosion|
   * smoke`) runs a live firefight through the real event path. It stands down
   * the instant something else starts emitting 'weapon:fire' so it can never
   * double up with the weapon system.
   */
  _driveRig(dt, ctx) {
    if (this._externalFire > 0) return;
    const mode = this._rigMode;

    if (mode === 'explosion') {
      this._demoTimer -= dt;
      if (this._demoTimer <= 0) {
        this._demoTimer = 2.2;
        this._v.copy(ctx.camera.position);
        this._dir.set(0, 0, -1).applyQuaternion(ctx.camera.quaternion);
        this._v.addScaledVector(this._dir, 11);
        if (this.level?.heightAt) {
          const h = this.level.heightAt(this._v.x, this._v.z);
          if (Number.isFinite(h)) this._v.y = h + 0.8;
        }
        ctx.bus.emit('explosion', { point: this._v.clone(), radius: 6, damage: 90 });
      }
      return;
    }

    if (mode === 'smoke') {
      this._demoTimer -= dt;
      if (this._demoTimer <= 0) {
        this._demoTimer = 0.12;
        this._v.copy(ctx.camera.position);
        this._dir.set(0, 0, -1).applyQuaternion(ctx.camera.quaternion);
        this._v.addScaledVector(this._dir, 6.5);
        this._v.y -= 1.2;
        const o = this._opts;
        o.position = this._v; o.normal = this._n.set(0, 1, 0);
        o.direction = this._d.set(0, -1, 0);
        o.colour = null; o.count = 4; o.scale = 1.5; o.floorY = undefined;
        this.particles.spawn('smoke_puff', o);
        o.count = undefined;
      }
      return;
    }

    this._fireTimer -= dt;
    if (this._fireTimer > 0) return;
    this._fireTimer = 0.085;

    const cam = ctx.camera;
    this._origin.copy(cam.position);
    this._dir.set(0, 0, -1).applyQuaternion(cam.quaternion);
    if (mode === 'impacts') {
      // Walk the rounds into the ground a few metres out so decals, dust and
      // craters can be inspected close up.
      this._dir.y -= 0.16;
      this._dir.x += (this._rnd() - 0.5) * 0.05;
    } else {
      this._dir.x += (this._rnd() - 0.5) * 0.016;
      this._dir.y += (this._rnd() - 0.5) * 0.012;
    }
    this._dir.normalize();

    const p = this._firePayload;
    p.origin = this._origin;
    p.dir = this._dir;
    p.weapon = ctx.get('weapons')?.current ?? null;
    p.seed = (p.seed + 1) | 0;
    this._emitting = true;
    ctx.bus.emit('weapon:fire', p);
    this._emitting = false;
  }

  dispose() {
    this.group?.removeFromParent();
    this.mul?.dispose();
    this.add?.dispose();
    this.atlas?.dispose();
  }
}
