import * as THREE from 'three';
import { makeDescriptor } from './ParticleBatch.js';
import { SPRITE } from './SpriteAtlas.js';

/**
 * OWNER: fx agent.
 *
 * The named effect library. Every entry is a plain function that fills the
 * shared descriptor and pushes instances into one of the two batches — no
 * objects are created while the game runs, so a 30-round burst allocates
 * nothing at all.
 *
 * Colours are stored pre-converted to the renderer's working space (linear
 * sRGB) at module load. Emissive effects run brightness multipliers far above
 * 1.0 on purpose: PostFX composites in HDR and tonemaps at the very end, so a
 * flash clamped to 1.0 would come out DIMMER than sunlit concrete.
 */

const _c = new THREE.Color();
/** hex → linear-sRGB triplet, once, at load. */
function lin(hex) {
  _c.set(hex);
  return [_c.r, _c.g, _c.b];
}

const C = {
  hotWhite: lin(0xfff6e6),
  flash: lin(0xffcf8a),
  fire: lin(0xff8a2e),
  fireDeep: lin(0xc23a08),
  ember: lin(0xff6a18),
  smokeWarm: lin(0xa89c8c),
  smokeCool: lin(0x8d949c),
  // Smoke still inside the flash envelope: lit by the discharge, not by the
  // sky. It has to start here and cool through smokeWarm to smokeCool, which is
  // what makes a puff look like it was born hot rather than sprayed grey.
  smokeLit: lin(0xffb072),
  smokeDark: lin(0x2e2c2a),
  smokeMid: lin(0x565452),
  dust: lin(0xbfb4a2),
  bloodBright: lin(0x9e2a1e),
  bloodDark: lin(0x3a0d0a),
  glass: lin(0xd6ecf4),
  water: lin(0xc8e2ea),
  waterDeep: lin(0x4d7c8a),
  steel: lin(0xd8dde4),
  brass: lin(0xffd27a),
  black: lin(0x000000),
  white: lin(0xffffff),
};

/** Fast, allocation-free xorshift so effects are reproducible per seed. */
export class Emitter {
  constructor(alphaBatch, additiveBatch) {
    this.A = alphaBatch;
    this.B = additiveBatch;
    this.P = makeDescriptor();
    this.tint = [1, 1, 1];
    this.lod = 1;
    this._s = 0x9e3779b9;
    // Scratch basis + direction (never reallocated).
    this.d = new Float32Array(3);
    this.t = new Float32Array(3);
    this.b = new Float32Array(3);
  }

  rnd() {
    let x = this._s;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    this._s = x >>> 0;
    return (this._s & 0xffffff) / 0x1000000;
  }

  range(a, b) { return a + (b - a) * this.rnd(); }
  sym(a) { return (this.rnd() * 2 - 1) * a; }

  /**
   * Instance count for an effect's primary emitter: the caller's override or the
   * effect's own default, times the effect scale, times the distance LOD the
   * system set for this spawn. A dust plume 90m away does not need 16 sprites.
   */
  count(base, o) {
    return Math.max(1, Math.round((o.count ?? base) * (o.scale ?? 1) * this.lod));
  }

  /** As `count`, for secondary emitters that must not read the override. */
  countN(base, o) {
    return Math.max(1, Math.round(base * (o.scale ?? 1) * this.lod));
  }

  /** Reset the descriptor to inert defaults, then set the sprite tile. */
  reset(tile) {
    const p = this.P;
    p.x = 0; p.y = 0; p.z = 0;
    p.vx = 0; p.vy = 0; p.vz = 0;
    p.life = 1;
    p.s0 = 0.2; p.s1 = 0.24; p.s2 = 0.1;
    p.rot = this.rnd() * Math.PI * 2; p.spin = 0;
    p.tile = tile; p.stretch = 0; p.soft = 0.6; p.bright = 1;
    p.r0 = 1; p.g0 = 1; p.b0 = 1; p.a0 = 1;
    p.r1 = 1; p.g1 = 1; p.b1 = 1; p.a1 = 1;
    p.r2 = 1; p.g2 = 1; p.b2 = 1; p.a2 = 0;
    p.grav = 0; p.drag = 0; p.turb = 0;
    p.floorY = -1e9; p.bounce = 0;
    return p;
  }

  size(s0, s1, s2) {
    const p = this.P; p.s0 = s0; p.s1 = s1; p.s2 = s2; return p;
  }

  /** 3-key colour ramp from pre-linearised triplets. */
  ramp(c0, a0, c1, a1, c2, a2) {
    const p = this.P;
    p.r0 = c0[0]; p.g0 = c0[1]; p.b0 = c0[2]; p.a0 = a0;
    p.r1 = c1[0]; p.g1 = c1[1]; p.b1 = c1[2]; p.a1 = a1;
    p.r2 = c2[0]; p.g2 = c2[1]; p.b2 = c2[2]; p.a2 = a2;
    return p;
  }

  /** As `ramp`, modulated by the surface tint the caller handed in. */
  rampT(c0, a0, c1, a1, c2, a2) {
    this.ramp(c0, a0, c1, a1, c2, a2);
    const p = this.P; const t = this.tint;
    p.r0 *= t[0]; p.g0 *= t[1]; p.b0 *= t[2];
    p.r1 *= t[0]; p.g1 *= t[1]; p.b1 *= t[2];
    p.r2 *= t[0]; p.g2 *= t[1]; p.b2 *= t[2];
    return p;
  }

  at(x, y, z) { const p = this.P; p.x = x; p.y = y; p.z = z; return p; }
  jitter(r) {
    const p = this.P;
    p.x += this.sym(r); p.y += this.sym(r); p.z += this.sym(r);
    return p;
  }

  /** Orthonormal basis around a direction, cached in this.t / this.b. */
  basis(nx, ny, nz) {
    const d = this.d;
    const l = Math.hypot(nx, ny, nz) || 1;
    d[0] = nx / l; d[1] = ny / l; d[2] = nz / l;
    let ax = 0; let ay = 1; let az = 0;
    if (Math.abs(d[1]) > 0.94) { ax = 1; ay = 0; az = 0; }
    const t = this.t; const b = this.b;
    t[0] = ay * d[2] - az * d[1];
    t[1] = az * d[0] - ax * d[2];
    t[2] = ax * d[1] - ay * d[0];
    const tl = Math.hypot(t[0], t[1], t[2]) || 1;
    t[0] /= tl; t[1] /= tl; t[2] /= tl;
    b[0] = d[1] * t[2] - d[2] * t[1];
    b[1] = d[2] * t[0] - d[0] * t[2];
    b[2] = d[0] * t[1] - d[1] * t[0];
  }

  /** Velocity in a cone around the cached basis. `spread` in radians. */
  cone(spread, speed) {
    const th = spread * Math.sqrt(this.rnd());
    const ph = this.rnd() * Math.PI * 2;
    const st = Math.sin(th); const ct = Math.cos(th);
    const cp = Math.cos(ph); const sp = Math.sin(ph);
    const d = this.d; const t = this.t; const b = this.b;
    const p = this.P;
    p.vx = (d[0] * ct + (t[0] * cp + b[0] * sp) * st) * speed;
    p.vy = (d[1] * ct + (t[1] * cp + b[1] * sp) * st) * speed;
    p.vz = (d[2] * ct + (t[2] * cp + b[2] * sp) * st) * speed;
    return p;
  }

  /** Offset the spawn point along the cached basis (tangential disc). */
  disc(radius) {
    const a = this.rnd() * Math.PI * 2;
    const r = radius * Math.sqrt(this.rnd());
    const t = this.t; const b = this.b;
    const p = this.P;
    p.x += (t[0] * Math.cos(a) + b[0] * Math.sin(a)) * r;
    p.y += (t[1] * Math.cos(a) + b[1] * Math.sin(a)) * r;
    p.z += (t[2] * Math.cos(a) + b[2] * Math.sin(a)) * r;
    return p;
  }

  a() { this.A.push(this.P); }
  fx() { this.B.push(this.P); }
}

/**
 * Scratch option bag for effects that chain into other effects. Composing by
 * object spread would allocate on every impact, which is exactly what the
 * no-garbage rule forbids.
 */
const _sub = {
  px: 0, py: 0, pz: 0, nx: 0, ny: 1, nz: 0, dx: 0, dy: -1, dz: 0,
  count: 0, scale: 1, floorY: undefined, distance: 0,
};
function sub(o, count, scale) {
  _sub.px = o.px; _sub.py = o.py; _sub.pz = o.pz;
  _sub.nx = o.nx ?? 0; _sub.ny = o.ny ?? 1; _sub.nz = o.nz ?? 0;
  _sub.dx = o.dx ?? 0; _sub.dy = o.dy ?? -1; _sub.dz = o.dz ?? 0;
  _sub.count = count;
  _sub.scale = scale;
  _sub.floorY = o.floorY;
  return _sub;
}

/** Reflect `i` (incoming, unit) about `n` (unit) into `out`. */
function reflect(out, ix, iy, iz, nx, ny, nz) {
  const d = 2 * (ix * nx + iy * ny + iz * nz);
  out[0] = ix - d * nx; out[1] = iy - d * ny; out[2] = iz - d * nz;
}
const _refl = new Float32Array(3);

/**
 * Every effect: (E, o) where `o` is the caller's option bag —
 *   position {x,y,z} · normal · direction · scale · count · floorY · distance
 * Options are read defensively; a missing normal means "up".
 */
export const EFFECTS = {
  // ── weapon ────────────────────────────────────────────────────────────────
  /**
   * A discharge is not one card. It is a compact incandescent core at the bore,
   * two or three flame petals rolled at random so no two shots are the same
   * shape, unburnt powder thrown forward as motion-stretched sparks, and a puff
   * of smoke that is born lit by the flash and cools to grey over half a second.
   * The light it casts on the world is not here — `Particles._onFire` fires a
   * real pooled point light, because no amount of additive billboard makes the
   * ground brighter.
   *
   * Deliberately SMALL: this sits ~0.5 m from the lens, so every centimetre of
   * sprite is a large number of screen pixels and a large fill-rate bill.
   */
  muzzle(E, o) {
    const { px, py, pz } = o;
    const dx = o.dx; const dy = o.dy; const dz = o.dz;
    const s = o.scale;

    E.basis(dx, dy, dz);

    // Incandescent core at the bore — small, white-hot, three frames of life.
    E.reset(SPRITE.GLOW);
    E.at(px + dx * 0.02, py + dy * 0.02, pz + dz * 0.02);
    E.size(0.055 * s, 0.085 * s, 0.030 * s);
    E.ramp(C.hotWhite, 1, C.hotWhite, 0.95, C.flash, 0);
    E.P.life = 0.030; E.P.bright = 46; E.P.soft = 0.05;
    E.fx();

    // The starburst that reads as "muzzle flash" at a glance. Rolled per shot
    // and kept smaller than the core-plus-petals envelope so it decorates the
    // shape rather than being the whole of it.
    E.reset(SPRITE.STAR);
    E.at(px, py, pz);
    E.size(0.062 * s, 0.115 * s, 0.045 * s);
    E.ramp(C.hotWhite, 1, C.flash, 0.85, C.fire, 0);
    E.P.life = 0.038; E.P.bright = 22; E.P.soft = 0.05;
    E.P.rot = E.rnd() * 6.283;
    E.fx();

    // 2-3 flame petals: tongues of burning propellant leaving the crown. They
    // start a few centimetres down the bore line and are pushed forward hard, so
    // they extend PAST the star's envelope — that asymmetric reach along the
    // barrel axis is the difference between a discharge and a sticker. Motion
    // stretch elongates each one along its own velocity, so no two shots are the
    // same silhouette.
    const petals = 2 + ((E.rnd() * 2) | 0);
    for (let i = 0; i < petals; i++) {
      const along = E.range(0.030, 0.110);
      E.reset(SPRITE.STREAK);
      E.at(px + dx * along, py + dy * along, pz + dz * along);
      E.cone(E.range(0.10, 0.45), E.range(4.0, 11.0) * s);
      const w = E.range(0.040, 0.075) * s;
      E.size(w, w * 1.5, w * 0.35);
      E.ramp(C.hotWhite, 1, C.fire, 0.85, C.fireDeep, 0);
      E.P.life = E.range(0.040, 0.075); E.P.bright = E.range(15, 24);
      E.P.stretch = E.range(0.020, 0.036); E.P.soft = 0.05; E.P.drag = 9;
      E.P.rot = E.rnd() * 6.283;
      E.fx();
    }

    // Unburnt powder thrown forward out of the barrel.
    const sparks = 7 + ((E.rnd() * 4) | 0);
    for (let i = 0; i < sparks; i++) {
      E.reset(SPRITE.STREAK);
      E.at(px, py, pz);
      E.cone(0.38, E.range(6, 19) * s);
      E.size(0.020 * s, 0.016 * s, 0.004 * s);
      E.ramp(C.hotWhite, 1, C.ember, 0.9, C.fireDeep, 0);
      E.P.life = E.range(0.10, 0.32); E.P.bright = 14; E.P.stretch = 0.024;
      E.P.grav = 0.55; E.P.drag = 3.2; E.P.soft = 0.08;
      E.fx();
    }

    for (let i = 0; i < 3; i++) {
      E.reset(SPRITE.EMBER);
      E.at(px, py, pz);
      E.cone(0.8, E.range(0.6, 2.6) * s);
      E.size(0.020 * s, 0.016 * s, 0.008 * s);
      E.ramp(C.flash, 1, C.ember, 0.85, C.fireDeep, 0);
      E.P.life = E.range(0.25, 0.7); E.P.bright = 7;
      E.P.grav = -0.10; E.P.drag = 1.6; E.P.turb = 2.2; E.P.soft = 0.1;
      E.fx();
    }

    // The smoke is what actually sells a discharge — it lingers, it drifts, and
    // it is the only part still on screen by the next round. Small, short-lived
    // and moving *away*: muzzle smoke sits half a metre from the lens, where a
    // big sprite is a full-screen fill-rate bill. It starts inside the flash
    // envelope (smokeLit) and cools through warm to grey as it expands.
    for (let i = 0; i < 3; i++) {
      E.reset(SPRITE.WISP);
      E.at(px + dx * 0.16, py + dy * 0.16, pz + dz * 0.16);
      E.cone(0.42, E.range(2.4, 5.0) * s);
      E.P.vy += E.range(0.15, 0.6);
      E.size(0.030 * s, 0.11 * s, 0.20 * s);
      E.ramp(C.smokeLit, 0.50, C.smokeWarm, 0.26, C.smokeCool, 0);
      E.P.life = E.range(0.28, 0.55); E.P.drag = 2.4; E.P.turb = 1.9;
      E.P.grav = -0.05; E.P.spin = E.sym(1.6); E.P.soft = 0.5;
      E.a();
    }
    for (let i = 0; i < 2; i++) {
      E.reset(SPRITE.SMOKE);
      E.at(px + dx * 0.34, py + dy * 0.34, pz + dz * 0.34);
      E.cone(0.6, E.range(1.2, 3.0) * s);
      E.P.vy += E.range(0.2, 0.7);
      E.size(0.055 * s, 0.16 * s, 0.28 * s);
      E.ramp(C.smokeLit, 0.34, C.smokeWarm, 0.18, C.smokeCool, 0);
      E.P.life = E.range(0.45, 0.85); E.P.drag = 1.9; E.P.turb = 1.4;
      E.P.grav = -0.06; E.P.spin = E.sym(1.1); E.P.soft = 0.7;
      E.a();
    }
  },

  tracer(E, o) {
    const dist = o.distance ?? 60;
    const speed = 340;
    E.basis(o.dx, o.dy, o.dz);
    // Bright core.
    E.reset(SPRITE.STREAK);
    E.at(o.px, o.py, o.pz);
    E.cone(0.004, speed);
    E.size(0.045, 0.038, 0.020);
    E.ramp(C.hotWhite, 1, C.flash, 1, C.fire, 0.2);
    E.P.life = Math.min(0.6, dist / speed);
    E.P.bright = 11; E.P.stretch = 0.021; E.P.soft = 0.12;
    E.fx();
    // Wider, dimmer sheath so the streak has a glow instead of a hard edge.
    E.reset(SPRITE.STREAK);
    E.at(o.px, o.py, o.pz);
    E.cone(0.004, speed);
    E.size(0.14, 0.12, 0.06);
    E.ramp(C.fire, 0.5, C.fire, 0.4, C.fireDeep, 0);
    E.P.life = Math.min(0.6, dist / speed);
    E.P.bright = 2.6; E.P.stretch = 0.019; E.P.soft = 0.2;
    E.fx();
  },

  /**
   * One spent case. Real dimensions: a 5.56x45 is 44.7 mm long and 9.6 mm across
   * the base, and the CASING sprite fills 88% of its tile, so a 51 mm quad puts
   * the brass at true size. It used to be a 30 mm square blob, which at half a
   * metre from the lens is what made it read as wide as the magazine.
   *
   * `o.vx/vy/vz` arrive already rotated into world space from the weapon's
   * `ejectVelocity` (local right/up/forward m/s) — out, up and slightly back.
   */
  shell(E, o) {
    E.reset(SPRITE.CASING);
    E.at(o.px, o.py, o.pz);
    E.jitter(0.005);
    // Multiplicative scatter, not additive: a shot-to-shot spread of +-12%
    // keeps the ejection *pattern* while stopping every case tracing one line.
    E.P.vx = (o.vx ?? 2.7) * E.range(0.88, 1.12);
    E.P.vy = (o.vy ?? 1.9) * E.range(0.88, 1.12);
    E.P.vz = (o.vz ?? -0.55) * E.range(0.88, 1.12);
    E.size(0.051, 0.051, 0.051);
    E.ramp(C.brass, 1, C.brass, 1, C.brass, 0);
    E.P.life = 2.2;
    // Brass is a polished metal in direct sun and the sprite carries no lighting
    // of its own, so it needs a push past 1.0 to sit in the same exposure as the
    // concrete around it rather than reading as a dull grey chip.
    E.P.bright = 2.1;
    // End over end about the long axis, the way brass leaves a port.
    E.P.spin = E.range(12, 24) * (E.rnd() > 0.5 ? 1 : -1);
    // The world runs an arcade gravity of -22 m/s^2, which is right for a player
    // and wrong for a 12-gram case: at that rate the brass is gone before the
    // eye follows it. 0.45 puts it back at roughly real 9.9.
    E.P.grav = 0.45; E.P.drag = 0.08; E.P.soft = 0.10;
    // Low restitution plus the batch's own tangential and spin damping gives a
    // short hop and a settle rather than a rubber ball.
    E.P.floorY = o.floorY ?? -1e9;
    E.P.bounce = o.floorY !== undefined ? 0.24 : 0;
    E.a();
  },

  // ── surface response ──────────────────────────────────────────────────────
  sparks(E, o) {
    const n = E.count(16, o);
    reflect(_refl, o.dx, o.dy, o.dz, o.nx, o.ny, o.nz);
    E.basis(_refl[0] * 0.7 + o.nx * 0.6, _refl[1] * 0.7 + o.ny * 0.6, _refl[2] * 0.7 + o.nz * 0.6);
    for (let i = 0; i < n; i++) {
      E.reset(SPRITE.STREAK);
      E.at(o.px, o.py, o.pz);
      E.cone(0.85, E.range(3.5, 15));
      E.size(E.range(0.016, 0.032), 0.020, 0.004);
      E.ramp(C.hotWhite, 1, C.ember, 0.95, C.fireDeep, 0);
      E.P.life = E.range(0.22, 0.85);
      E.P.bright = E.range(11, 20); E.P.stretch = 0.024;
      E.P.grav = 1.0; E.P.drag = 1.5; E.P.soft = 0.08;
      E.P.floorY = o.floorY ?? -1e9; E.P.bounce = o.floorY !== undefined ? 0.42 : 0;
      E.fx();
    }
    // A short-lived hot pop at the point of contact.
    E.reset(SPRITE.GLOW);
    E.at(o.px + o.nx * 0.02, o.py + o.ny * 0.02, o.pz + o.nz * 0.02);
    E.size(0.10, 0.22, 0.05);
    E.ramp(C.hotWhite, 1, C.fire, 0.7, C.fireDeep, 0);
    E.P.life = 0.075; E.P.bright = 20; E.P.soft = 0.05;
    E.fx();
  },

  dust(E, o) {
    const s = o.scale ?? 1;
    const n = E.count(7, o);
    E.basis(o.nx, o.ny, o.nz);
    for (let i = 0; i < n; i++) {
      E.reset(SPRITE.DUST);
      E.at(o.px, o.py, o.pz);
      E.disc(0.05 * s);
      E.cone(1.05, E.range(0.7, 3.4) * s);
      E.size(0.04 * s, 0.19 * s, 0.42 * s);
      E.rampT(C.dust, 0.52, C.dust, 0.30, C.dust, 0);
      E.P.life = E.range(0.4, 1.05); E.P.drag = 2.6; E.P.turb = 1.2;
      E.P.grav = 0.07; E.P.spin = E.sym(1.4); E.P.soft = 1.0;
      E.a();
    }
    // Powder: fine grains that hang after the plume has gone.
    for (let i = 0; i < Math.max(2, (n * 0.35) | 0); i++) {
      E.reset(SPRITE.GRIT);
      E.at(o.px, o.py, o.pz);
      E.cone(0.9, E.range(1.5, 5.5) * s);
      E.size(0.05 * s, 0.07 * s, 0.05 * s);
      E.rampT(C.dust, 0.75, C.dust, 0.5, C.dust, 0);
      E.P.life = E.range(0.35, 0.9); E.P.grav = 0.8; E.P.drag = 2.2; E.P.soft = 0.3;
      E.a();
    }
  },

  smoke_puff(E, o) {
    const s = o.scale ?? 1;
    const n = E.count(10, o);
    E.basis(o.nx ?? 0, o.ny ?? 1, o.nz ?? 0);
    for (let i = 0; i < n; i++) {
      E.reset(SPRITE.SMOKE);
      E.at(o.px, o.py, o.pz);
      E.disc(0.18 * s);
      E.cone(1.2, E.range(0.3, 1.7) * s);
      E.P.vy += E.range(0.15, 0.7) * s;
      E.size(0.20 * s, 0.75 * s, 1.5 * s);
      E.rampT(C.smokeMid, 0.42, C.smokeCool, 0.26, C.smokeCool, 0);
      E.P.life = E.range(1.1, 2.6); E.P.drag = 1.5; E.P.turb = 1.0;
      E.P.grav = -0.045; E.P.spin = E.sym(0.7); E.P.soft = 1.6;
      E.a();
    }
  },

  debris(E, o) {
    const s = o.scale ?? 1;
    const n = E.count(7, o);
    reflect(_refl, o.dx, o.dy, o.dz, o.nx, o.ny, o.nz);
    E.basis(_refl[0] * 0.5 + o.nx, _refl[1] * 0.5 + o.ny, _refl[2] * 0.5 + o.nz);
    for (let i = 0; i < n; i++) {
      E.reset(SPRITE.CHUNK);
      E.at(o.px, o.py, o.pz);
      E.cone(0.95, E.range(2.2, 7.5) * s);
      const sz = E.range(0.018, 0.055) * s;
      E.size(sz, sz, sz * 0.9);
      E.rampT(C.white, 1, C.white, 1, C.white, 0.55);
      E.P.life = E.range(0.9, 2.1); E.P.grav = 1; E.P.drag = 0.35;
      E.P.spin = E.sym(16); E.P.soft = 0.25;
      E.P.floorY = o.floorY ?? -1e9; E.P.bounce = o.floorY !== undefined ? 0.3 : 0;
      E.a();
    }
  },

  blood(E, o) {
    const s = o.scale ?? 1;
    // Mist sprays back along the surface normal, blended with the round's line
    // of travel so a shot from the side throws to the side.
    E.basis(o.dx * 0.4 + o.nx * 0.9, o.dy * 0.4 + o.ny * 0.9, o.dz * 0.4 + o.nz * 0.9);
    const mist = E.countN(5, o);
    for (let i = 0; i < mist; i++) {
      E.reset(SPRITE.MIST);
      E.at(o.px, o.py, o.pz);
      E.cone(1.0, E.range(0.8, 3.2) * s);
      E.size(0.07 * s, 0.26 * s, 0.44 * s);
      E.ramp(C.bloodBright, 0.62, C.bloodDark, 0.34, C.bloodDark, 0);
      E.P.life = E.range(0.35, 0.8); E.P.drag = 3.2; E.P.grav = 0.25; E.P.soft = 0.7;
      E.a();
    }
    const drops = E.countN(11, o);
    for (let i = 0; i < drops; i++) {
      E.reset(SPRITE.DROPLET);
      E.at(o.px, o.py, o.pz);
      E.cone(0.9, E.range(2.5, 8) * s);
      E.size(E.range(0.012, 0.030) * s, 0.020 * s, 0.012 * s);
      E.ramp(C.bloodBright, 0.95, C.bloodDark, 0.85, C.bloodDark, 0.2);
      E.P.life = E.range(0.35, 0.85); E.P.grav = 1; E.P.drag = 0.6;
      E.P.stretch = 0.010; E.P.soft = 0.15;
      E.a();
    }
  },

  glass(E, o) {
    const s = o.scale ?? 1;
    reflect(_refl, o.dx, o.dy, o.dz, o.nx, o.ny, o.nz);
    E.basis(_refl[0] * 0.6 + o.nx * 0.8, _refl[1] * 0.6 + o.ny * 0.8, _refl[2] * 0.6 + o.nz * 0.8);
    const shards = E.countN(15, o);
    for (let i = 0; i < shards; i++) {
      E.reset(SPRITE.SHARD);
      E.at(o.px, o.py, o.pz);
      E.cone(1.0, E.range(2.0, 7.0) * s);
      const sz = E.range(0.025, 0.075) * s;
      E.size(sz, sz, sz);
      E.ramp(C.glass, 0.95, C.glass, 0.9, C.glass, 0.3);
      E.P.life = E.range(0.9, 1.9); E.P.grav = 1; E.P.drag = 0.5;
      E.P.spin = E.sym(19); E.P.bright = 1.6; E.P.soft = 0.2;
      E.P.floorY = o.floorY ?? -1e9; E.P.bounce = o.floorY !== undefined ? 0.25 : 0;
      E.a();
    }
    const glints = E.countN(6, o);
    for (let i = 0; i < glints; i++) {
      E.reset(SPRITE.FLARE);
      E.at(o.px, o.py, o.pz);
      E.cone(1.1, E.range(1.5, 5.0) * s);
      E.size(0.05 * s, 0.09 * s, 0.02 * s);
      E.ramp(C.hotWhite, 0.9, C.glass, 0.6, C.glass, 0);
      E.P.life = E.range(0.10, 0.30); E.P.bright = 9; E.P.grav = 0.8; E.P.soft = 0.06;
      E.fx();
    }
    EFFECTS.dust(E, sub(o, 4, 0.5 * s));
  },

  water_splash(E, o) {
    const s = o.scale ?? 1;
    E.basis(o.nx ?? 0, o.ny ?? 1, o.nz ?? 0);
    for (let i = 0; i < 2; i++) {
      E.reset(SPRITE.CROWN);
      E.at(o.px, o.py, o.pz);
      E.cone(0.16, E.range(1.4, 3.0) * s);
      E.size(0.16 * s, 0.42 * s, 0.30 * s);
      E.ramp(C.water, 0.85, C.water, 0.55, C.waterDeep, 0);
      E.P.life = E.range(0.3, 0.55); E.P.grav = 1; E.P.drag = 1.4; E.P.soft = 0.5;
      E.a();
    }
    const wdrops = E.countN(14, o);
    for (let i = 0; i < wdrops; i++) {
      E.reset(SPRITE.DROPLET);
      E.at(o.px, o.py, o.pz);
      E.cone(0.85, E.range(2.0, 6.5) * s);
      E.size(E.range(0.012, 0.032) * s, 0.018 * s, 0.010 * s);
      E.ramp(C.water, 0.85, C.water, 0.7, C.waterDeep, 0.1);
      E.P.life = E.range(0.3, 0.75); E.P.grav = 1; E.P.drag = 0.5;
      E.P.stretch = 0.008; E.P.bright = 1.3; E.P.soft = 0.12;
      E.a();
    }
    for (let i = 0; i < 4; i++) {
      E.reset(SPRITE.MIST);
      E.at(o.px, o.py, o.pz);
      E.cone(1.2, E.range(0.5, 2.0) * s);
      E.size(0.10 * s, 0.30 * s, 0.5 * s);
      E.ramp(C.water, 0.35, C.water, 0.2, C.water, 0);
      E.P.life = E.range(0.4, 0.9); E.P.drag = 2.6; E.P.soft = 0.9;
      E.a();
    }
  },

  ember(E, o) {
    const s = o.scale ?? 1;
    const n = E.count(8, o);
    E.basis(o.nx ?? 0, o.ny ?? 1, o.nz ?? 0);
    for (let i = 0; i < n; i++) {
      E.reset(SPRITE.EMBER);
      E.at(o.px, o.py, o.pz);
      E.disc(0.25 * s);
      E.cone(0.9, E.range(0.4, 2.2) * s);
      E.P.vy += E.range(0.2, 1.1);
      E.size(0.014 * s, 0.020 * s, 0.006 * s);
      // Flickers because the mid key is brighter than either end.
      E.ramp(C.ember, 0.85, C.flash, 1, C.fireDeep, 0);
      E.P.life = E.range(1.0, 2.8); E.P.bright = E.range(4, 8);
      E.P.grav = -0.055; E.P.drag = 0.45; E.P.turb = 2.6; E.P.soft = 0.1;
      E.fx();
    }
  },

  explosion(E, o) {
    const s = o.scale ?? 1;
    E.basis(0, 1, 0);

    // Core: a couple of frames of genuinely blinding light.
    for (let i = 0; i < 3; i++) {
      E.reset(SPRITE.STAR);
      E.at(o.px, o.py, o.pz);
      E.jitter(0.25 * s);
      E.size(0.9 * s, 2.4 * s, 1.2 * s);
      E.ramp(C.hotWhite, 1, C.flash, 0.9, C.fire, 0);
      E.P.life = E.range(0.10, 0.20); E.P.bright = 55; E.P.soft = 0.4;
      E.P.spin = E.sym(2.5);
      E.fx();
    }
    for (let i = 0; i < 9; i++) {
      E.reset(SPRITE.GLOW);
      E.at(o.px, o.py, o.pz);
      E.cone(1.4, E.range(2, 11) * s);
      E.size(0.35 * s, 1.1 * s, 0.5 * s);
      E.ramp(C.flash, 1, C.fire, 0.85, C.fireDeep, 0);
      E.P.life = E.range(0.16, 0.42); E.P.bright = 24; E.P.drag = 3.2;
      E.P.grav = -0.25; E.P.soft = 0.6;
      E.fx();
    }
    E.reset(SPRITE.RING);
    E.at(o.px, o.py + 0.1 * s, o.pz);
    E.size(0.4 * s, 3.2 * s, 5.5 * s);
    E.ramp(C.hotWhite, 0.8, C.fire, 0.35, C.fireDeep, 0);
    E.P.life = 0.30; E.P.bright = 16; E.P.soft = 0.8;
    E.fx();

    // Smoke column — the part that stays in frame.
    const cloud = E.countN(16, o);
    for (let i = 0; i < cloud; i++) {
      E.reset(SPRITE.SMOKE);
      E.at(o.px, o.py, o.pz);
      E.jitter(0.4 * s);
      E.cone(1.5, E.range(1.0, 6.0) * s);
      E.P.vy += E.range(0.8, 3.2) * s;
      E.size(0.5 * s, 1.9 * s, 3.6 * s);
      E.ramp(C.smokeDark, 0.72, C.smokeMid, 0.42, C.smokeCool, 0);
      E.P.life = E.range(1.8, 4.0); E.P.drag = 1.35; E.P.turb = 1.5;
      E.P.grav = -0.10; E.P.spin = E.sym(0.7); E.P.soft = 2.2;
      E.a();
    }
    // Dust ring hugging the ground.
    const ring = E.countN(13, o);
    for (let i = 0; i < ring; i++) {
      E.reset(SPRITE.DUST);
      E.at(o.px, o.py, o.pz);
      const a = E.rnd() * Math.PI * 2;
      const sp = E.range(4, 11) * s;
      E.P.vx = Math.cos(a) * sp; E.P.vz = Math.sin(a) * sp;
      E.P.vy = E.range(0.2, 1.4);
      E.size(0.3 * s, 1.4 * s, 2.6 * s);
      E.rampT(C.dust, 0.6, C.dust, 0.34, C.dust, 0);
      E.P.life = E.range(1.0, 2.4); E.P.drag = 2.1; E.P.turb = 1.1;
      E.P.grav = 0.04; E.P.spin = E.sym(0.9); E.P.soft = 1.8;
      E.a();
    }
    const d = sub(o, 16, s * 1.6);
    d.py = o.py + 0.15 * s; d.nx = 0; d.ny = 1; d.nz = 0; d.dx = 0; d.dy = -1; d.dz = 0;
    EFFECTS.debris(E, d);
    const em = sub(o, 18, s);
    em.py = o.py + 0.2 * s; em.nx = 0; em.ny = 1; em.nz = 0;
    EFFECTS.ember(E, em);
  },
};

export { C as FX_COLOURS };
