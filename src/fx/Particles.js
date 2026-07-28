import * as THREE from 'three';
import { WORLD } from '../core/Constants.js';
import { ParticleBatch } from './particles/ParticleBatch.js';
import { buildSpriteAtlas, ATLAS_COLS, ATLAS_ROWS } from './particles/SpriteAtlas.js';
import { Emitter, EFFECTS } from './particles/Effects.js';

/**
 * OWNER: particles agent.
 * CONTRACT:
 *   particles.spawn(effectName, { position, normal, direction, scale, colour })
 *   Effect names other systems will call (all must exist):
 *     'muzzle', 'smoke_puff', 'sparks', 'dust', 'debris', 'blood',
 *     'shell', 'tracer', 'explosion', 'glass', 'water_splash', 'ember'
 *
 * ── how it works ──────────────────────────────────────────────────────────────
 * Two GPU-instanced batches — one additive (flash, sparks, embers, tracers) and
 * one alpha-blended (smoke, dust, debris, blood) — so the whole FX layer is TWO
 * draw calls no matter how much is on screen. Particles live in flat typed
 * arrays; death is a swap with the last live element, which keeps the live set
 * contiguous so `instanceCount` draws exactly what is alive. Nothing is
 * allocated after init: not a Vector3, not an options object, not a closure.
 *
 * Soft particles: the fragment shader samples the post-processing chain's stable
 * depth copy and fades coverage as the billboard approaches the geometry behind
 * it. Without this, every smoke puff shows the hard straight line where its quad
 * intersects the ground — the single clearest tell of billboard smoke.
 *
 * Sparks, tracers, debris and casings are motion-stretched: the quad is
 * elongated along the screen-space velocity and anchored so its head sits on the
 * particle, which is what turns a dot into a streak.
 *
 * Emissive brightness runs far above 1.0 (a muzzle core is ~42) because PostFX
 * composites in linear HDR and tonemaps last; anything clamped to 1.0 ends up
 * darker than sunlit concrete and disappears in the grade.
 */
export class Particles {
  constructor() {
    this.name = 'particles';

    this.time = 0;
    this.stats = { alpha: 0, additive: 0, dropped: 0 };

    // Flat option bag reused by every spawn() call.
    this._o = {
      px: 0, py: 0, pz: 0,
      nx: 0, ny: 1, nz: 0,
      dx: 0, dy: -1, dz: 0,
      vx: 0, vy: 0, vz: 0,
      scale: 1, count: undefined, floorY: undefined, distance: 0,
    };

    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector2();
    this._mat = new THREE.Matrix4();
    this._col = new THREE.Color();
    this._muzzle = new THREE.Vector3();
    this._muzzleDir = new THREE.Vector3(0, 0, -1);
    this._muzzleAge = 99;
    this._fogColour = new THREE.Color(0x9fb4c6);
  }

  init(ctx) {
    this.ctx = ctx;

    const t0 = performance.now();
    this.atlas = buildSpriteAtlas(1024);

    this.alpha = new ParticleBatch({
      capacity: 8192,
      additive: false,
      atlas: this.atlas,
      cols: ATLAS_COLS,
      rows: ATLAS_ROWS,
      name: 'fx:particles:alpha',
    });
    this.additive = new ParticleBatch({
      capacity: 12288,
      additive: true,
      atlas: this.atlas,
      cols: ATLAS_COLS,
      rows: ATLAS_ROWS,
      name: 'fx:particles:additive',
    });
    this._batches = [this.alpha, this.additive];

    this.group = new THREE.Group();
    this.group.name = 'fx:particles';
    this.group.add(this.alpha.mesh);
    this.group.add(this.additive.mesh);
    ctx.scene.add(this.group);

    this.emitter = new Emitter(this.alpha, this.additive);

    // ── seams ────────────────────────────────────────────────────────────────
    ctx.bus.on('weapon:fire', (e) => this._onFire(e));
    ctx.bus.on('shell:eject', (e) => this._onShell(e));
    // The tracer needs both ends of the flight path, and only the impact knows
    // the far end — so it is spawned here rather than at the trigger pull.
    ctx.bus.on('hit:surface', (e) => this._onHitTracer(e));
    ctx.bus.on('fx:spawn', (e) => { if (e?.effect) this.spawn(e.effect, e); });

    console.info(
      `[particles] sprite atlas + ${this.alpha.capacity + this.additive.capacity}`
      + ` particle pool in ${Math.round(performance.now() - t0)}ms`,
    );
  }

  // ──────────────────────────────────────────────────────────── public API ──

  /**
   * @param {string} effect one of the names in the contract
   * @param {object} opts   position/normal/direction: THREE.Vector3-like
   *                        scale: number · colour: hex|THREE.Color · count
   *                        floorY: bounce plane · velocity: for 'shell'
   */
  spawn(effect, opts) {
    const fn = EFFECTS[effect];
    if (!fn) return;
    const o = this._o;

    const p = opts?.position;
    o.px = p?.x ?? 0; o.py = p?.y ?? 0; o.pz = p?.z ?? 0;

    const n = opts?.normal;
    o.nx = n?.x ?? 0; o.ny = n?.y ?? 1; o.nz = n?.z ?? 0;

    const d = opts?.direction;
    o.dx = d?.x ?? -o.nx; o.dy = d?.y ?? -o.ny; o.dz = d?.z ?? -o.nz;

    const v = opts?.velocity;
    o.vx = v?.x ?? 0; o.vy = v?.y ?? 0; o.vz = v?.z ?? 0;

    o.scale = opts?.scale ?? 1;
    o.count = opts?.count;
    o.floorY = opts?.floorY;
    o.distance = opts?.distance ?? 0;

    const tint = this.emitter.tint;
    if (opts?.colour !== undefined && opts.colour !== null) {
      if (opts.colour.isColor) this._col.copy(opts.colour);
      else this._col.set(opts.colour);
      tint[0] = this._col.r; tint[1] = this._col.g; tint[2] = this._col.b;
    } else {
      tint[0] = 1; tint[1] = 1; tint[2] = 1;
    }

    // Distance LOD. A plume 90m out gets a third of the sprites; past 150m
    // nothing but explosions is worth a draw at all.
    const cam = this.ctx.camera.position;
    const dist = Math.hypot(o.px - cam.x, o.py - cam.y, o.pz - cam.z);
    if (dist > 150 && effect !== 'explosion') return;
    let lod = dist > 90 ? 0.34 : dist > 40 ? 0.62 : dist > 18 ? 0.85 : 1;
    // Fill-rate valve: sustained automatic fire into one wall would otherwise
    // stack plume on plume until the frame is nothing but blended smoke.
    const busy = this.alpha.count;
    if (busy > 200) lod *= Math.max(0.3, 1 - (busy - 200) / 640);
    this.emitter.lod = lod;

    fn(this.emitter, o);
  }

  /** Live particle count across both batches. */
  get live() {
    return this.alpha.count + this.additive.count;
  }

  // ───────────────────────────────────────────────────────────── weapon fx ──

  _onFire(e) {
    const dir = e?.dir;
    if (dir) this._muzzleDir.copy(dir).normalize();
    this._muzzlePosition(this._muzzle);
    this._muzzleAge = 0;

    const o = this._o;
    o.px = this._muzzle.x; o.py = this._muzzle.y; o.pz = this._muzzle.z;
    o.dx = this._muzzleDir.x; o.dy = this._muzzleDir.y; o.dz = this._muzzleDir.z;
    o.scale = 1; o.count = undefined; o.floorY = undefined;
    const tint = this.emitter.tint;
    tint[0] = 1; tint[1] = 1; tint[2] = 1;
    this.emitter.lod = 1;
    EFFECTS.muzzle(this.emitter, o);
  }

  _onShell(e) {
    const p = e?.point ?? this._muzzle;
    const o = this._o;
    o.px = p.x; o.py = p.y; o.pz = p.z;
    const v = e?.velocity;
    o.vx = v?.x ?? 1.7; o.vy = v?.y ?? 1.5; o.vz = v?.z ?? 0.4;
    o.floorY = e?.floorY;
    o.scale = 1;
    this.emitter.lod = 1;
    EFFECTS.shell(this.emitter, o);
  }

  /** A tracer only makes sense between a muzzle we just saw and this impact. */
  _onHitTracer(e) {
    if (this._muzzleAge > 0.2 || !e?.point) return;
    const m = this._muzzle;
    const dx = e.point.x - m.x;
    const dy = e.point.y - m.y;
    const dz = e.point.z - m.z;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1.0) return;
    const o = this._o;
    o.px = m.x; o.py = m.y; o.pz = m.z;
    o.dx = dx / len; o.dy = dy / len; o.dz = dz / len;
    o.distance = len;
    o.scale = 1;
    this.emitter.lod = 1;
    EFFECTS.tracer(this.emitter, o);
  }

  /**
   * Where the barrel actually is. The viewmodel lives in its own scene with a
   * narrower FOV, so a point taken straight from it projects nearer the screen
   * centre than the gun the player sees. Rescaling the lateral offset by the
   * ratio of the two half-FOV tangents puts world-space smoke exactly on the
   * drawn muzzle instead of a few dozen pixels inside it.
   */
  _muzzlePosition(out) {
    const ctx = this.ctx;
    const muzzle = ctx.get('viewmodel')?.rig?.muzzle;
    const cam = ctx.camera;
    if (!muzzle) {
      out.copy(cam.position).addScaledVector(this._muzzleDir, 0.55);
      return out;
    }
    muzzle.updateWorldMatrix(true, false);
    out.setFromMatrixPosition(muzzle.matrixWorld);
    this._mat.copy(cam.matrixWorld).invert();
    out.applyMatrix4(this._mat);
    const kv = Math.tan(THREE.MathUtils.degToRad(ctx.viewCamera.fov * 0.5));
    const kw = Math.tan(THREE.MathUtils.degToRad(cam.fov * 0.5));
    const k = kw > 1e-5 ? kv / kw : 1;
    out.x *= k; out.y *= k;
    out.applyMatrix4(cam.matrixWorld);
    return out;
  }

  // ───────────────────────────────────────────────────────────── per-frame ──

  update(dt, ctx) {
    if (dt > 0) {
      this.time += dt;
      this._muzzleAge += dt;
      const g = WORLD.gravity;
      this.alpha.simulate(dt, g, this.time);
      this.additive.simulate(dt, g, this.time);
    }

    this._syncUniforms(ctx);

    this.alpha.flush();
    this.additive.flush();

    this.stats.alpha = this.alpha.count;
    this.stats.additive = this.additive.count;
    this.stats.dropped = this.alpha.dropped + this.additive.dropped;
  }

  _syncUniforms(ctx) {
    const cam = ctx.camera;
    const post = ctx.get('postfx');
    const composer = post?.enabled ? post.composer : null;
    let depth = null;
    let w = 0;
    let h = 0;
    if (composer) {
      depth = composer.stableDepthTexture ?? null;
      const buf = composer.inputBuffer;
      if (buf) { w = buf.width; h = buf.height; }
    }
    if (!w || !h) {
      const s = ctx.renderer.getDrawingBufferSize(this._v2);
      w = s.x; h = s.y;
      if (!composer) depth = null;
    }
    for (const b of this._batches) b.setDepth(depth, w, h, cam.near, cam.far);

    const fog = ctx.scene.fog;
    if (fog && fog.isFogExp2) {
      this._fogColour.copy(fog.color);
      for (const b of this._batches) b.setFog(this._fogColour, fog.density);
    }
  }

  dispose() {
    this.group?.removeFromParent();
    for (const b of this._batches ?? []) b.dispose();
    this.atlas?.dispose();
  }
}
