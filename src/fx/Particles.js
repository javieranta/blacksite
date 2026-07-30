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
 * Emissive brightness runs far above 1.0 (a muzzle core is ~46) because PostFX
 * composites in linear HDR and tonemaps last; anything clamped to 1.0 ends up
 * darker than sunlit concrete and disappears in the grade.
 *
 * A discharge also fires a real pooled point light through the `lighting` seam.
 * Additive sprites brighten the pixels they cover and nothing else; without the
 * light the ground under the barrel, the crate beside it and the weapon itself
 * stay exactly as dark as they were, which is the single clearest tell that a
 * muzzle flash is a decal rather than an event.
 */

/**
 * Muzzle light. 5500K (a discharge is close to daylight white; the *smoke* is
 * what is orange), spiked and gone inside ~45 ms, with the cutoff pinned to 6 m
 * so it is a pool at the shooter's feet and not a second sun over the courtyard.
 * FlashPool derives its own cutoff from the peak intensity, which for a spike
 * this bright would reach 60 m — hence the explicit override on the returned
 * light. Peak is in candela: at 1.5 m that is ~19 lux against a golden-hour sun
 * of ~3.4, so it dominates locally and vanishes by the far side of the yard.
 */
const MUZZLE_LIGHT = { colour: 0xffe9d2, peak: 42, radius: 6.0, decay: 0.045 };
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
    // Registered before us, so this is resolved once rather than per shot.
    this.lighting = ctx.get('lighting');
    this.level = ctx.get('level');

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

    // The part no billboard can do: actually light the scene.
    const light = this.lighting?.flash?.(
      this._muzzle, MUZZLE_LIGHT.colour, MUZZLE_LIGHT.peak, MUZZLE_LIGHT.decay,
    );
    if (light) light.distance = MUZZLE_LIGHT.radius;
  }

  _onShell(e) {
    const o = this._o;
    // Spawn on the ejection port of the *drawn* weapon. The shooter's event
    // carries a point offset from the eye, which is metres out of place once the
    // viewmodel's own FOV is taken into account — brass appeared to leave from
    // open air well clear of the gun.
    if (this._ejectPosition(this._v)) {
      o.px = this._v.x; o.py = this._v.y; o.pz = this._v.z;
    } else {
      const p = e?.point ?? this._muzzle;
      o.px = p.x; o.py = p.y; o.pz = p.z;
    }
    const v = e?.velocity;
    o.vx = v?.x ?? 2.7; o.vy = v?.y ?? 1.9; o.vz = v?.z ?? -0.55;
    o.floorY = e?.floorY ?? this._groundY(o.px, o.pz);
    o.scale = 1;
    o.count = undefined;
    o.distance = 0;
    const tint = this.emitter.tint;
    tint[0] = 1; tint[1] = 1; tint[2] = 1;
    this.emitter.lod = 1;
    EFFECTS.shell(this.emitter, o);
  }

  /**
   * Ground height under a point, so brass has something to bounce off. One BVH
   * raycast per ejection (~10/s at cyclic rate) and no allocation — `heightAt`
   * returns a number.
   */
  _groundY(x, z) {
    if (!this.level?.heightAt) return undefined;
    const h = this.level.heightAt(x, z);
    // 6mm clearance: a case lying on concrete is not buried in it.
    return Number.isFinite(h) ? h + 0.006 : undefined;
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
   * Take a world point read off the viewmodel and move it to where the player
   * actually sees that part of the gun.
   *
   * Both cameras share a transform, so a point P in camera space is drawn by the
   * viewmodel camera at ndc = (P.xy / -P.z) / tan(vmFov/2), while a world sprite
   * at Q lands at (Q.xy / -Q.z) / tan(camFov/2). Holding z and equating the two
   * gives Q.xy = P.xy * tan(camFov/2) / tan(vmFov/2) — the WORLD tangent over the
   * VIEW tangent. The narrower viewmodel FOV magnifies, so the world sprite has
   * to move OUTWARD from the screen centre to catch up with the drawn gun.
   *
   * This ratio used to be the other way up, which pulled every muzzle effect
   * ~24% toward the crosshair instead of pushing it ~32% out: with an 80-degree
   * world FOV against the 65-degree viewmodel that is a compound error of 1.7x,
   * and it is why the flash sat in open air up and left of the barrel rather than
   * on the crown of it.
   */
  _viewToWorld(out) {
    const ctx = this.ctx;
    const cam = ctx.camera;
    this._mat.copy(cam.matrixWorld).invert();
    out.applyMatrix4(this._mat);
    const kv = Math.tan(THREE.MathUtils.degToRad(ctx.viewCamera.fov * 0.5));
    const kw = Math.tan(THREE.MathUtils.degToRad(cam.fov * 0.5));
    const k = kv > 1e-5 ? kw / kv : 1;
    out.x *= k; out.y *= k;
    out.applyMatrix4(cam.matrixWorld);
    return out;
  }

  /** Where the barrel actually is. */
  _muzzlePosition(out) {
    const muzzle = this.ctx.get('viewmodel')?.rig?.muzzle;
    if (!muzzle) {
      out.copy(this.ctx.camera.position).addScaledVector(this._muzzleDir, 0.55);
      return out;
    }
    muzzle.updateWorldMatrix(true, false);
    out.setFromMatrixPosition(muzzle.matrixWorld);
    return this._viewToWorld(out);
  }

  /**
   * Where a spent case leaves the gun. `rig.ejectPort` is a plain point in the
   * weapon's own frame — the front lip of the port — so it has to go through the
   * rig's world matrix and then the same lateral rescale as the muzzle.
   * @returns {boolean} false when there is no viewmodel to read it from.
   */
  _ejectPosition(out) {
    const rig = this.ctx.get('viewmodel')?.rig;
    if (!rig?.ejectPort || !rig.root) return false;
    rig.root.updateWorldMatrix(true, false);
    out.copy(rig.ejectPort).applyMatrix4(rig.root.matrixWorld);
    this._viewToWorld(out);
    return true;
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
