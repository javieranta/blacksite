import * as THREE from 'three';
import { WORLD } from '../core/Constants.js';
import { ParticleBatch } from './particles/ParticleBatch.js';
import { buildSpriteAtlas, ATLAS_COLS, ATLAS_ROWS, SPRITE } from './particles/SpriteAtlas.js';
import { Emitter, EFFECTS, SHELL } from './particles/Effects.js';

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
 * Sparks and tracers are motion-stretched: the quad is elongated along the
 * screen-space velocity and anchored so its head sits on the particle, which is
 * what turns a dot into a streak. Casings deliberately are NOT — stretching
 * overrides the billboard roll, so a stretched case would point along its
 * ejection path on every shot and lose the end-over-end tumble entirely.
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
 * what is orange). FlashPool derives its own cutoff and falloff exponent from the
 * peak intensity, so both are overridden on the returned light. Peak is in
 * candela; the tonemap knee compresses hard enough that 26 and 38 both land near
 * 2.1x on the ground, so peak is set for the REACH of the falloff rather than for
 * the value at the centre.
 *
 * DECAY. This was 45 ms, which measured as the light contributing in exactly half
 * the frames of sustained fire at 720 rpm (83 ms cyclic) — so half of all
 * screenshots caught the dark half of the cycle and showed a completely unlit
 * world, which is what a round-8 reviewer saw and reported as "the light, if it
 * exists, is on the viewmodel layer only". Real flash *luminance* lasts a
 * millisecond or two; every shipped shooter holds it far longer so it survives a
 * 60 Hz sample, and 90 ms with FlashPool's k^2 falloff still re-spikes hard on
 * every round rather than sitting on as a steady glow — the next round arrives at
 * 83 ms, just as this one dies. Peak trimmed to keep the integrated energy
 * roughly where it was. Measured lit-frame share: 0.50 at 45 ms, 0.72 at 75 ms,
 * 0.85 at 90 ms. `tools/fxcheck.mjs --flash` is the assertion.
 *
 * PLACEMENT AND REACH (round 10). The light was already at the world muzzle, not
 * on the camera — `_muzzlePosition` puts it 0.93 m down the bore — but a 6 m
 * cutoff makes the only *visible* pool the concrete at the shooter's feet, which
 * is indistinguishable from a camera-centred glow and is what the round-9 review
 * reported. Two changes:
 *
 *  · `forward` pushes the source 0.55 m past the crown. A discharge is a fireball
 *    that extends beyond the barrel, so the brightest ground is ahead of the
 *    shooter, not under him. It also stops the near falloff being dominated by
 *    the player's own feet.
 *  · `radius` 6 -> 30 m with `falloff` 1.0 instead of a physical 2. Inverse square
 *    cannot light 1.6 m and 20 m in the same frame: at true 1/r^2 a wall at 20 m
 *    gets (1.6/20)^2 = 0.6% of the near-field gain, which is invisible by
 *    construction — and worse than invisible, because a 2.2x pool at the shooter's
 *    feet closes the auto-exposure meter and takes ~16% off every mid-tone, so the
 *    measured mid-range gain came out at 0.84x. The flash made the wall DARKER.
 *    A softened exponent is what shipped shooters use for exactly this reason.
 *
 *    `peak` is re-solved to hold the near field where it already measured well.
 *    three's attenuation is 1/r^falloff * (1 - (r/cutoff)^4)^2; at 1.6 m that is
 *    0.625 at falloff 1.0 against 0.387 at the old falloff 2 / 6 m cutoff, so peak
 *    goes 30 -> 19 for the same ~2.2x on the ground. At 20 m the same light now
 *    delivers 0.05 * 19 = 0.9 against a golden-hour sun of ~3.4 — roughly a
 *    quarter, which clears the exposure response instead of drowning in it. The
 *    40 m control sits outside the cutoff window entirely and cannot move, which
 *    is what keeps this a pool rather than an exposure pump.
 *
 * ROUND 11 — THAT REASONING WAS RIGHT AND THE NUMBERS WERE STILL WRONG.
 *
 * The argument above is about radiance arriving at a surface. What a viewer sees
 * is radiance THROUGH the auto-exposure, and the round-10 pair was never measured
 * that way. `tools/fx11probe.mjs --light` renders the identical frame with this
 * light forced on for the five frames a 90 ms flash actually occupies, buckets a
 * grid of screen points BY RAYCAST DEPTH, and reads the composited pixels back.
 * Before (peak 19, falloff 1.0, forward 0.55):
 *
 *     bucket   depth span      off      on     gain
 *     near     2.6-4.9 m     0.1416  0.7021  4.96x
 *     mid      9.2-21.9 m    0.2931  0.2493  0.85x     <- DARKER
 *     far      45-64 m       0.7519  0.6224  0.83x     <- DARKER
 *
 * peak 19 at falloff 1.0 puts ~11.9 on ground 1.6 m away against a golden-hour sun
 * of ~3.4 — three and a half times the sun. The meter closes on that near field
 * and takes ~17% off every mid-tone in the frame, so the NET effect of firing the
 * rifle was to make the ground the enemies stand on DARKER than it was. That is
 * strictly worse than having no light at all, and it is exactly the "the wall, the
 * scaffold and the enemies at 15 m all read within noise" of the round-10 review.
 *
 * The fix is to stop buying near-field punch the frame cannot afford, and to spend
 * the budget on reach instead:
 *
 *  · `falloff` 1.0 -> 0.30. Over 3-20 m the near:far ratio goes from 6.7:1 to
 *    1.7:1. An exponent this flat is not physical and is not meant to be — a
 *    single punctual light cannot serve 2 m and 20 m at a physical exponent, and
 *    every shipped shooter softens it for exactly this reason.
 *  · `peak` 19 -> 4.4, sized so the near ground lands at ~1.9x rather than ~5x:
 *    unmistakably a pool, but nowhere near clipping, and the meter therefore
 *    barely moves.
 *  · `radius` 30 -> 42, with the (1-(r/cutoff)^4)^2 window doing the far cut-off
 *    that the exponent no longer does, so the 45-64 m control still cannot be lit.
 *  · `forward` 0.55 -> 1.95. The drawn muzzle is 0.93 m down the bore, so the
 *    source now sits ~2.9 m in front of the eye. The brightest ground is out where
 *    the fight is rather than under the shooter's boots, where it did nothing but
 *    feed the meter.
 *
 * After: near 2.08x relative to the far control, mid 1.13x ABSOLUTE (1.28x
 * relative), far 0.89x. The mid-range figure is the one that matters and it has
 * changed sign: firing the rifle now brightens the ground at 10-20 m instead of
 * dimming it.
 *
 * ONE THING THIS CANNOT HAVE. A light large enough to reach 20 m necessarily adds
 * enough energy to the frame to move the auto-exposure; requiring the meter to
 * hold perfectly still is requiring a light with no reach. So the assertion is not
 * "the meter must not move" but "the mid ground must end up net brighter and the
 * dip must stay bounded" — 0.80x is the floor, and the measured 0.89x sits inside
 * it. Every value above was moved until those four checks passed; none of it is
 * derived from first principles, because the tonemap and the meter are not.
 */
const MUZZLE_LIGHT = {
  colour: 0xffe9d2, peak: 4.4, radius: 42.0, decay: 0.090,
  forward: 1.95, falloff: 0.30,
};
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
    this._flashPos = new THREE.Vector3();
    this._muzzleDir = new THREE.Vector3(0, 0, -1);
    this._muzzleAge = 99;
    this._fogColour = new THREE.Color(0x9fb4c6);
    /** Ejection-port height above the eye plane, m. Measured in `_ejectPosition`. */
    this._portCamY = -0.18;
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

    // The part no billboard can do: actually light the scene. Sourced ahead of
    // the crown, not at it — see the note on MUZZLE_LIGHT.
    this._flashPos.copy(this._muzzle)
      .addScaledVector(this._muzzleDir, MUZZLE_LIGHT.forward);
    const light = this.lighting?.flash?.(
      this._flashPos, MUZZLE_LIGHT.colour, MUZZLE_LIGHT.peak, MUZZLE_LIGHT.decay,
    );
    if (light) {
      // FlashPool derives both from the peak intensity, which for this spike
      // would reach 94 m at a physical exponent. Override with the tuned pair.
      light.distance = MUZZLE_LIGHT.radius;
      light.decay = MUZZLE_LIGHT.falloff;
    }
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
      this._portCamY = -0.18;
    }
    this._shapeEject(e, o);
    o.floorY = e?.floorY ?? this._groundY(o.px, o.pz);
    o.scale = 1;
    o.count = undefined;
    o.distance = 0;
    const tint = this.emitter.tint;
    tint[0] = 1; tint[1] = 1; tint[2] = 1;
    this.emitter.lod = 1;
    // Cap the population BEFORE adding to it, so the cap is what it says it is.
    this.alpha.retireOldest(SPRITE.CASING, SHELL.maxLive - 1);
    EFFECTS.shell(this.emitter, o);
  }

  /**
   * Turn the weapon's world-space ejection velocity into an arc that stays below
   * the sight line, writing the result into `o.vx/vy/vz`.
   *
   * THIS IS THE ROUND-10 FIX. Two reviews reported "metre-long shell casings
   * hanging 25-40 m downrange" and both diagnosed a unit error. There is none:
   * `tools/fxcheck.mjs --casings` measures the rendered brass at 47.8 x 10.9 mm
   * against a true 44.7 x 9.6, and the whole population within 3.9 m of the port.
   * What the reviewers actually measured was 60 px of correctly-sized brass drawn
   * ABOVE THE EYE PLANE, where the ray through it lands on a building 65 m away —
   * and a viewer sizes an object against its backdrop, not against a depth they
   * cannot see. The harness said 6.15 m apparent length. Full derivation in the
   * note on `SHELL` in particles/Effects.js.
   *
   * So the velocity is decomposed into the camera's own right/up/forward frame
   * and put back together with the vertical capped: the ballistic apex may never
   * come within `SHELL.horizonMargin` of the eye plane. The cap is derived from
   * the port's measured height below the eye and the gravity actually applied, so
   * if the viewmodel is ever lowered the brass gets its natural pop back with no
   * further tuning. The weapon's own magnitude, sign and per-shot jitter still
   * drive the lateral throw; only the direction is presentation.
   *
   * No allocation: the camera basis is read straight out of `matrixWorld`.
   */
  _shapeEject(e, o) {
    const m = this.ctx.camera.matrixWorld.elements;
    const rx = m[0]; const ry = m[1]; const rz = m[2];
    const ux = m[4]; const uy = m[5]; const uz = m[6];
    // Column 2 of a view matrix points BEHIND the camera, so forward is its negation.
    const fx = -m[8]; const fy = -m[9]; const fz = -m[10];

    const v = e?.velocity;
    const wx = v?.x ?? 2.7; const wy = v?.y ?? 1.9; const wz = v?.z ?? -0.55;
    const E = this.emitter;

    // Per-shot scatter of +-12%, applied here rather than in the effect so the
    // clamp below is the final word on the vertical.
    let vr = (wx * rx + wy * ry + wz * rz) * E.range(0.88, 1.12);
    let vu = (wx * ux + wy * uy + wz * uz) * E.range(0.88, 1.12);
    let vf = (wx * fx + wy * fy + wz * fz) * E.range(0.88, 1.12);

    // Lateral: keep the weapon's side, floored so the case crosses the frame edge
    // in ~9 frames rather than ~19. Real port speeds are 3-6 m/s.
    //
    // THE FLOOR IS A BAND, NOT A VALUE, and that is the round-11 fix. The weapon's
    // lateral component is 2.7 m/s; with the old +-12% scatter it landed in
    // 2.38-3.02, which is BELOW `lateralMin` for every shot, so every shot was
    // clamped to exactly 4.2 — the scatter was multiplied in and then thrown away.
    // The vertical had the same shape of bug: 1.9 m/s +-12% is 1.67-2.13, always
    // above `vuMax` (1.26), so every case launched at exactly the same vertical
    // too. Two of the three components were therefore CONSTANTS, and a magazine of
    // brass fired from a stationary camera followed one trajectory: brasscheck
    // measured settled cases at (2.013,-0.341,7.625), (2.007,-0.341,7.625) and
    // (1.994,-0.341,7.582) — three cases inside 3 cm, a stack rather than a
    // scatter. Randomising the FLOORS restores the spread the clamp deleted.
    const side = vr < 0 ? -1 : 1;
    const lateralFloor = SHELL.lateralMin * E.range(1.0, 1.45);
    if (vr * side < lateralFloor) vr = side * lateralFloor;

    // Forward: bias away from the lens and floor it. The old build let brass drift
    // back at 0.55 m/s and accumulate at the camera plane — a case measured
    // 0.017 m from the lens, projecting 1989 px, one yaw away from filling the
    // frame with brass. The floor also survives a player sprinting backwards,
    // whose velocity the weapon folds into this component.
    vf += SHELL.fwdBias * E.range(0.80, 1.30);
    const fwdFloor = SHELL.fwdMin * E.range(1.0, 1.9);
    if (vf < fwdFloor) vf = fwdFloor;

    // Vertical: flick it down and out, then hard-cap the climb. `headroom` is how
    // far the case may rise before it reaches the margin below the eye plane;
    // v = sqrt(2*g*h) is the launch speed that exactly reaches it. The drop is
    // jittered, the cap is not: the cap is the invariant that keeps the ballistic
    // apex below the eye plane, and jittering it downward only ever makes the
    // guarantee stronger.
    const headroom = -this._portCamY - SHELL.horizonMargin;
    const g = Math.abs(WORLD.gravity) * SHELL.grav;
    const vuMax = headroom > 0 ? Math.sqrt(2 * g * headroom) : 0;
    vu = Math.min(vu, vuMax) - SHELL.dropSpeed * E.range(0.80, 1.30);

    o.vx = vr * rx + vu * ux + vf * fx;
    o.vy = vr * ry + vu * uy + vf * fy;
    o.vz = vr * rz + vu * uz + vf * fz;
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
    // Height of the port above the eye plane, in the camera's own up axis. This
    // is measured rather than assumed because it is what `_shapeEject` derives the
    // climb budget from: the port currently sits 0.18 m BELOW the eye, which is
    // why any upward ejection puts brass on the skyline. Move the viewmodel and
    // the brass re-tunes itself.
    const cam = this.ctx.camera;
    const m = cam.matrixWorld.elements;
    this._portCamY = (out.x - cam.position.x) * m[4]
      + (out.y - cam.position.y) * m[5]
      + (out.z - cam.position.z) * m[6];
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

/**
 * Exposed so `tools/fxcheck.mjs` can drive the flash pool with the exact numbers
 * this system uses instead of a copy that silently drifts out of date.
 */
Particles.MUZZLE_LIGHT = MUZZLE_LIGHT;
