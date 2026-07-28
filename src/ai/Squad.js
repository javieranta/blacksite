import * as THREE from 'three';
import { AI, makeRng } from './AIConfig.js';

/**
 * OWNER: ai agent.
 *
 * Squad-level coordination. Individual combatants only know how to use cover and
 * shoot; everything that makes a fight feel *authored* lives here:
 *
 *   - one man is told to suppress (long exposures, long bursts) while another is
 *     given a flank route around the player's field of view,
 *   - contact reports propagate, so shooting one soldier wakes his section,
 *   - if the player stops moving behind cover, somebody cooks a grenade —
 *     the standard answer to a camper, and the reason a firefight develops
 *     instead of stalling.
 */

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();

export class Squad {
  constructor(ctx, nav, seed = 7) {
    this.ctx = ctx;
    this.nav = nav;
    this.rng = makeRng(seed);
    this.members = [];
    this.flankGoal = null;
    this._flank = new THREE.Vector3();
    this.roleCd = 0;
    this.grenadeCd = 5.0;
    this.playerStill = 0;
    this._lastPlayer = new THREE.Vector3();
    this.grenades = [];
    this.group = new THREE.Group();
    this.group.name = 'ai:ordnance';
    this.barkCd = 0;
  }

  init(materials) {
    // Three pooled frags. Hidden meshes cost nothing; a live one costs one draw.
    const geo = new THREE.IcosahedronGeometry(0.055, 1);
    for (let i = 0; i < 3; i++) {
      const mesh = new THREE.Mesh(geo, materials.gear);
      mesh.castShadow = true;
      mesh.visible = false;
      this.group.add(mesh);
      this.grenades.push({
        mesh, live: false, fuse: 0,
        pos: new THREE.Vector3(), vel: new THREE.Vector3(), spin: new THREE.Vector3(),
      });
    }
    this.ctx.scene.add(this.group);
  }

  add(c) {
    this.members.push(c);
    c.onFirstContact = () => this._contact(c);
  }

  get alive() { return this.members.reduce((n, m) => n + (m.dead ? 0 : 1), 0); }

  _contact(from) {
    this.bark(from, 'bark_contact');
    for (const m of this.members) {
      if (m === from || m.dead) continue;
      if (m.pos.distanceTo(from.pos) < AI.alertShareRadius) m.alert(from.lastSeen);
    }
  }

  bark(from, cue) {
    if (this.barkCd > 0 || !from) return;
    this.barkCd = 1.1 + this.rng() * 1.4;
    const audio = this.ctx.get('audio');
    if (audio) audio.play(cue, { position: from.bounds.center, volume: 0.85 });
    this.ctx.bus.emit('ai:bark', { actor: from, cue, position: from.bounds.center });
  }

  /* --------------------------------------------------------------- roles --- */

  update(dt, player) {
    this.barkCd -= dt;
    this.roleCd -= dt;
    this.grenadeCd -= dt;

    // Is the player camping? Reset the timer when they actually move.
    if (this._lastPlayer.lengthSq() === 0) this._lastPlayer.copy(player.position);
    if (this._lastPlayer.distanceTo(player.position) > AI.grenadeStaticDist) {
      this._lastPlayer.copy(player.position);
      this.playerStill = 0;
    } else {
      this.playerStill += dt;
    }

    if (this.roleCd <= 0) {
      this.roleCd = 1.7 + this.rng() * 0.8;
      this._assign(player);
    }
    if (this.grenadeCd <= 0 && this.playerStill > AI.grenadeStaticTime) this._tryGrenade(player);
    this._stepGrenades(dt, player);
  }

  _assign(player) {
    const live = this.members.filter((m) => !m.dead && m.alerted);
    if (!live.length) { this.flankGoal = null; return; }

    // Suppressor: whoever currently has eyes on and is closest to the fight.
    let suppressor = null, bestD = Infinity;
    for (const m of live) {
      if (!m.canSee) continue;
      const d = m.pos.distanceTo(player.position);
      if (d < bestD) { bestD = d; suppressor = m; }
    }

    // Flanker: someone who is NOT the suppressor, sent wide of the player's view.
    let flanker = null;
    if (live.length > 1) {
      let far = -1;
      for (const m of live) {
        if (m === suppressor) continue;
        const d = m.pos.distanceTo(player.position);
        if (d > far && d < 55) { far = d; flanker = m; }
      }
    }

    const goal = flanker ? this._flankNode(player, flanker) : -1;
    this.flankGoal = goal >= 0 ? this.nav.worldOf(goal, this._flank) : null;

    for (const m of live) {
      const prev = m.role;
      m.role = m === suppressor ? 'suppress' : (m === flanker && goal >= 0 ? 'flank' : 'hold');
      if (m.role === 'flank' && prev !== 'flank') {
        m.coverNode = -1;
        m.coverCd = 0;
        m._setGoal(this._flank);
        this.bark(m, 'bark_flank');
      } else if (m.role === 'suppress' && prev !== 'suppress') {
        this.bark(m, 'bark_suppress');
      }
    }
  }

  /**
   * A node roughly 60-120 degrees off the player's facing, at fighting range,
   * with cover when he gets there.
   */
  _flankNode(player, flanker) {
    const nav = this.nav;
    const yaw = player.yaw;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    let best = -1, bestScore = -1e9;
    const side = this.rng() < 0.5 ? 1 : -1;
    // Flank candidates live 11-34 m from the player, so ask the cover index for
    // that disc rather than walking every cover node on the level.
    const scratch = this._covScratch || (this._covScratch = new Int32Array(4096));
    const found = nav.coverNear(player.position.x, player.position.z, 34, scratch);
    for (let i = 0; i < found; i++) {
      const n = scratch[i];
      const nx = nav.wx(n), nz = nav.wz(n);
      const dx = nx - player.position.x, dz = nz - player.position.z;
      const d = Math.hypot(dx, dz);
      if (d < 11 || d > 34) continue;
      if (Math.abs(nav.wy(n) - player.position.y) > 6.5) continue;
      const dot = (dx * fx + dz * fz) / d;
      if (dot < -0.25 || dot > 0.62) continue;              // wide of his view cone
      const cross = (fx * dz - fz * dx) / d;
      if (cross * side < 0.25) continue;                     // commit to one side
      const travel = Math.hypot(nx - flanker.pos.x, nz - flanker.pos.z);
      if (travel > 46) continue;
      const score = nav.protection(n, player.position.x, player.position.z) * 3.0
        - travel * 0.06 - Math.abs(d - 20) * 0.05 + this.rng() * 0.6;
      if (score > bestScore) { bestScore = score; best = n; }
    }
    return best;
  }

  /* ------------------------------------------------------------ grenades --- */

  _tryGrenade(player) {
    const level = this.ctx.require('level');
    let thrower = null;
    for (const m of this.members) {
      if (m.dead || !m.alerted || m.reloadT >= 0) continue;
      const d = m.pos.distanceTo(player.position);
      if (d < AI.grenadeMin || d > AI.grenadeMax) continue;
      if (!m.canSee && m.lastSeenAge > 2.5) continue;
      thrower = m;
      break;
    }
    const g = this.grenades.find((x) => !x.live);
    if (!thrower || !g) return;

    this.grenadeCd = AI.grenadeCooldown;
    this.playerStill = 0;
    this.bark(thrower, 'bark_grenade');

    // Lob it: solve the launch speed for a 42-degree arc onto the target.
    g.pos.copy(thrower.anim.muzzle);
    _v1.subVectors(player.position, g.pos);
    const h = _v1.y;
    _v1.y = 0;
    const range = Math.max(2, _v1.length());
    _v1.divideScalar(range);
    const ang = 0.74;
    const gAcc = 19.5;
    const tanA = Math.tan(ang);
    const denom = 2 * Math.cos(ang) * Math.cos(ang) * (range * tanA - h);
    const speed = denom > 0.1 ? Math.sqrt((gAcc * range * range) / denom) : 12;
    g.vel.copy(_v1).multiplyScalar(Math.cos(ang) * speed);
    g.vel.y = Math.sin(ang) * speed;
    g.spin.set(this.rng() * 9, this.rng() * 9, this.rng() * 9);
    g.fuse = AI.grenadeFuse;
    g.live = true;
    g.mesh.visible = true;
    g.mesh.position.copy(g.pos);
    g.level = level;
    const audio = this.ctx.get('audio');
    if (audio) audio.play('shell_drop', { position: g.pos, volume: 0.5 });
  }

  _stepGrenades(dt, player) {
    const level = this.ctx.require('level');
    for (const g of this.grenades) {
      if (!g.live) continue;
      g.fuse -= dt;
      g.vel.y -= 19.5 * dt;
      _v2.copy(g.vel).multiplyScalar(dt);
      const step = _v2.length();
      if (step > 1e-4) {
        _v3.copy(_v2).divideScalar(step);
        const hit = level.raycast(g.pos, _v3, step + 0.06);
        if (hit) {
          g.pos.copy(hit.point).addScaledVector(hit.normal, 0.06);
          // Bounce with heavy energy loss — a frag does not roll far.
          const d = g.vel.dot(hit.normal);
          g.vel.addScaledVector(hit.normal, -2 * d).multiplyScalar(0.34);
        } else {
          g.pos.add(_v2);
        }
      }
      g.mesh.position.copy(g.pos);
      g.mesh.rotation.x += g.spin.x * dt;
      g.mesh.rotation.y += g.spin.y * dt;
      if (g.fuse <= 0) this._detonate(g, player);
    }
  }

  _detonate(g, player) {
    g.live = false;
    g.mesh.visible = false;
    const ctx = this.ctx;
    const level = ctx.require('level');
    ctx.bus.emit('explosion', { point: g.pos.clone(), radius: AI.grenadeRadius, damage: AI.grenadeDamage });
    const particles = ctx.get('particles');
    if (particles) {
      particles.spawn('explosion', { position: g.pos, scale: 1.4 });
      particles.spawn('dust', { position: g.pos, scale: 2.2 });
      particles.spawn('debris', { position: g.pos, scale: 1.4 });
    }
    const lighting = ctx.get('lighting');
    if (lighting?.flash) lighting.flash(g.pos, 0xffc888, 26, 0.35);
    const audio = ctx.get('audio');
    if (audio) audio.play('explosion', { position: g.pos });

    // Falloff plus a line-of-sight test, so cover actually saves the player.
    _v1.subVectors(player.eyePosition, g.pos);
    const d = _v1.length();
    // `d > 0.05` rather than just `d < radius`: a frag that comes to rest inside
    // the player's head would otherwise divide by ~0 and cast an infinite ray.
    if (d > 0.05 && d < AI.grenadeRadius) {
      _v1.divideScalar(d);
      if (!level.raycast(g.pos, _v1, d - 0.25)) {
        ctx.bus.emit('player:damage', {
          amount: AI.grenadeDamage * (1 - d / AI.grenadeRadius) ** 1.4,
          from: g.pos.clone(),
        });
      }
    }
    // Friendly fire on the squad, which stops them clustering next to the blast.
    for (const m of this.members) {
      if (m.dead) continue;
      const dm = m.bounds.center.distanceTo(g.pos);
      if (dm < AI.grenadeRadius) {
        m.applyDamage(AI.grenadeDamage * (1 - dm / AI.grenadeRadius), {
          part: 'chest', point: m.bounds.center,
          dir: _v2.subVectors(m.bounds.center, g.pos).normalize(),
        });
      }
    }
  }

  dispose() {
    for (const g of this.grenades) g.mesh.geometry.dispose();
    this.group.removeFromParent();
  }
}
