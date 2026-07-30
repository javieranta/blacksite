import * as THREE from 'three';
import { LightCones } from './LightCones.js';

/**
 * OWNER: lighting agent.
 *
 * The artificial light rig — the thing that makes a night frame readable.
 *
 * What changed and why
 * --------------------
 * This used to place its own ring of six sodium masts. That was blind: it ran
 * inside Lighting.init, which is *before* Level.init, so the collider group it
 * probed for clearance was always empty and the ring landed wherever the maths
 * said. Meanwhile Level publishes 22 hand-placed `lightAnchors` — floods on the
 * perimeter, wallpacks by doors, lamps over the courtyard, highbays inside the
 * west hall — and hands each one to `lighting.addPoint()`. Those are in the right
 * places. What they were missing was photometry: a fixture arrived with an
 * authored intensity and a 20-26 m cutoff, no colour temperature, no shadow, and
 * no connection to the time of day, so at midnight a wall lamp glowed and threw
 * nothing onto the column it was bolted to, and at midday it glowed just the
 * same.
 *
 * So this class no longer places lights. It *adopts* them:
 *
 *   colour        a real Planckian colour temperature per fixture type —
 *                 2700 K for sodium-replacement lamps and wallpacks, 4000 K for
 *                 interior highbays, 4300 K for perimeter floods
 *   falloff       inverse square (decay 2) with the windowed cutoff set from the
 *                 fixture type rather than whatever the level author guessed:
 *                 a wallpack reaches 9 m, a flood 45 m
 *   intensity     candela peaks scaled off the authored value, then multiplied
 *                 by the rig's dimmer, so the whole artificial rig fades up as
 *                 the sun goes down instead of burning at noon
 *   shadows       a 512 cubemap on the highest-value fixtures, baked once and
 *                 never refreshed — these are static fixtures over static
 *                 geometry, so a per-frame refresh would buy nothing and cost
 *                 six face renders per light per frame
 *
 * Why not a cubemap on *every* fixture: each shadow-casting point light costs a
 * fragment-shader texture unit, and the D3D11 backend gives 16 total. Four
 * cascaded directional maps plus an environment map plus a full PBR texture set
 * already accounts for most of them, so the budget below is deliberately small
 * and picks the fixtures that frame the play space.
 *
 * If nothing is ever adopted (a level that publishes no anchors) `_ensureRig()`
 * builds a self-contained fallback: procedural masts, luminaire housings and
 * emissive lenses as three instanced meshes, plus their lights. Night is never
 * a black rectangle.
 */

/** Planckian locus, sRGB. */
const TEMP = {
  k2200: 0xff9138,
  k2700: 0xffa957,
  k3000: 0xffb46b,
  k4000: 0xffd1a3,
  k4300: 0xffd5ac,
};

/** A cool fixture stays cool: fluorescents and LED packs are not sodium. */
const COOL = 0xdce8ff;

/**
 * Per-fixture photometry. `peak` is absolute candela at full dim, because the
 * authored intensities in the level range from 3 to 70 for fixtures of the same
 * physical type and a gain on top of that just propagates the inconsistency.
 * `reach` is the windowed cutoff — real falloff is inverse square either way.
 */
const FIXTURES = {
  flood:    { colour: TEMP.k4300, peak: 240, reach: 46, shadowScore: 0.4 },
  lamp:     { colour: TEMP.k2700, peak: 62,  reach: 13, shadowScore: 1.0 },
  wallpack: { colour: TEMP.k2700, peak: 30,  reach: 9,  shadowScore: 1.25 },
  highbay:  { colour: TEMP.k4000, peak: 105, reach: 18, shadowScore: 0.8 },
  beacon:   { colour: null,       peak: 0,   reach: 26, shadowScore: 0.0 },
  strip:    { colour: COOL,       peak: 46,  reach: 11, shadowScore: 0.5 },
  fallback: { colour: TEMP.k2700, peak: 40,  reach: 14, shadowScore: 0.9 },
};

/** Fragment-shader texture units are the hard limit here, not fill rate. */
const MAX_SHADOW_LIGHTS = 3;
const SHADOW_MAP_SIZE = 512;

/** Yard-mast placement, metres. */
const MAST_OFFSET = 5.4;      // step off the spawn point it is seeded from
const MAST_CLEARANCE = 11;    // keep away from fixtures the level already placed
const MAST_SPACING = 13;      // keep masts from pooling on top of each other

const SODIUM = TEMP.k2200;
const FLUORO = 0xc4e2ff;

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _euler = new THREE.Euler();
const _pos = new THREE.Vector3();
const _scale = new THREE.Vector3(1, 1, 1);
const _lightPos = new THREE.Vector3();

export class Practicals {
  constructor(ctx, fallbackCount = 5) {
    this.ctx = ctx;
    this.fallbackCount = fallbackCount;
    this.group = new THREE.Group();
    this.group.name = 'practicals';
    ctx.scene.add(this.group);

    /** @type {{light:THREE.PointLight, peak:number, spec:object, owned:boolean}[]} */
    this.units = [];
    this._byLight = new Map();
    this._dim = 0;
    this._target = 0;
    this._shadowsAssigned = false;
    this._rigKey = null;
    this._fallbackBuilt = false;
    this._wantsRig = false;
    this._grace = 0;
    this._lensMats = [];

    /**
     * Per-preset photometric trim, from the rig.
     *
     * `_reachMul` shrinks every fixture's windowed cutoff and `_peakMul` raises
     * its candela. Together they trade coverage for contrast, which is the whole
     * difference between "the yard is lit" and "there are lamps in the yard": at
     * the authored reaches a 46 m flood and a 13 m lamp overlap across the entire
     * play space, so the ground carries a continuous artificial wash with no gaps
     * in it — a second flat fill, just a warm one. Pulling the reach in and the
     * peak up puts the same light on the ground under each fixture and takes it
     * away from between them.
     */
    this._reachMul = 1;
    this._peakMul = 1;

    this.cones = new LightCones(ctx);
    this._conesBuilt = false;
  }

  // --- adoption --------------------------------------------------------------

  /**
   * Take photometric ownership of a light another system created.
   * @param {THREE.PointLight} light
   */
  adopt(light) {
    if (!light || !light.isPointLight || this._byLight.has(light)) return;
    const kind = this._kindOf(light);
    const spec = FIXTURES[kind] ?? FIXTURES.fallback;

    // A fixture the author made cold stays cold; everything else gets the
    // fixture type's colour temperature.
    const tint = new THREE.Color();
    if (spec.colour === null) tint.copy(light.color);
    else if (light.color.b > light.color.r * 0.96) tint.setHex(COOL);
    else tint.setHex(spec.colour);
    const m = Math.max(tint.r, tint.g, tint.b) || 1;
    tint.multiplyScalar(1 / m);

    const peak = spec.peak > 0 ? spec.peak : Math.max(2, light.intensity);
    light.decay = 2;
    light.distance = spec.reach * this._reachMul;
    // Leave `intensity` at the full-on figure for good: see _applyOne for why
    // the dimmer travels through the colour instead.
    light.intensity = peak;

    const unit = { light, peak, spec, tint, owned: false };
    this.units.push(unit);
    this._byLight.set(light, unit);
    this._shadowsAssigned = false;
    this._conesBuilt = false;
    this._applyOne(unit);
  }

  release(light) {
    const unit = this._byLight.get(light);
    if (!unit) return;
    this._byLight.delete(light);
    const i = this.units.indexOf(unit);
    if (i >= 0) this.units.splice(i, 1);
    this._shadowsAssigned = false;
  }

  /**
   * Recover the fixture kind. Level tags every anchor with a `kind` and back-
   * references the light it created, which is the authoritative answer; the name
   * and then the geometry are fallbacks for lights from anywhere else.
   */
  _kindOf(light) {
    const anchors = this.ctx.get('level')?.lightAnchors;
    if (anchors) {
      for (let i = 0; i < anchors.length; i++) {
        if (anchors[i].light === light && FIXTURES[anchors[i].kind]) return anchors[i].kind;
      }
    }
    const n = (light.name || '').toLowerCase();
    for (const k in FIXTURES) if (k !== 'fallback' && n.includes(k)) return k;

    light.getWorldPosition(_lightPos);
    if (_lightPos.y > 7.5 && light.distance > 36) return 'flood';
    if (_lightPos.y > 5.6) return 'highbay';
    if (light.distance > 0 && light.distance <= 14) return 'wallpack';
    return 'lamp';
  }

  // --- rig / dimming ---------------------------------------------------------

  /**
   * @param {object} rig LightRigs entry
   * @param {string} key preset key
   */
  setRig(rig, key) {
    this._rigKey = key;
    this._wantsRig = rig.practicals > 0;
    this._target = THREE.MathUtils.clamp(rig.practicals, 0, 1);
    this._dim = this._target;
    const reach = rig.practicalReach ?? 1;
    const peak = rig.practicalPeak ?? 1;
    // A reach change moves every cone's geometry, so the cone rig has to be
    // rebuilt rather than just re-dimmed.
    if (reach !== this._reachMul) this._conesBuilt = false;
    this._reachMul = reach;
    this._peakMul = peak;
    this.cones.setRig(rig.cones);
    this._apply();
  }

  /** @param {number} dim 0..1 master dimmer (scripted blackouts, generators) */
  setDim(dim) {
    this._target = THREE.MathUtils.clamp(dim, 0, 1);
  }

  update(dt, camera) {
    // Level realises its anchors during its own init, which runs after ours, so
    // "nobody gave us any fixtures" is only true once the world has had a chance
    // to. Give it a few frames before deciding to build the fallback rig.
    if (this._grace < 4) {
      this._grace++;
      if (this._grace === 4) {
        this._ensureRig();
        this._apply();
      }
    }

    if (Math.abs(this._target - this._dim) > 1e-4) {
      // Sodium warms up rather than snapping on — cheap, and it reads.
      const k = 1 - Math.exp(-dt * 3.2);
      this._dim += (this._target - this._dim) * k;
      if (Math.abs(this._target - this._dim) < 1e-3) this._dim = this._target;
      this._apply();
    }
    if (!this._shadowsAssigned && this.units.length) this._assignShadows(camera);
    if (!this._conesBuilt && this.units.length && this._grace >= 4) {
      this._conesBuilt = true;
      this.cones.build(this.units);
    }
    this.cones.update(this._dim, camera);
  }

  _apply() {
    for (let i = 0; i < this.units.length; i++) this._applyOne(this.units[i]);
    const e = 0.06 + 7.4 * this._dim;
    for (let i = 0; i < this._lensMats.length; i++) {
      this._lensMats[i].emissiveIntensity = e * (i === 1 ? 0.85 : 1);
    }
  }

  /**
   * The day/night dimmer is applied to the light's COLOUR, not its intensity.
   *
   * That is not a stylistic choice, it is an ownership one. Props drives its
   * wall fixtures every frame — `light.intensity = base * wobble * dip`, a
   * tired-ballast flicker — and Props updates after Lighting does, so anything
   * this class writes to `intensity` is overwritten before the frame is drawn.
   * Radiometrically `colour * intensity` is one product, so scaling the colour
   * dims the fixture exactly as scaling the intensity would, and it travels
   * through a channel no other system writes. The flicker survives, the schedule
   * survives, and neither system has to know about the other.
   *
   * `intensity` is still set once at adoption, to the fixture's full-on candela,
   * so that a system which samples it as a baseline (Props does, immediately
   * after calling addPoint) captures the right number.
   */
  _applyOne(unit) {
    if (unit.spec.peak > 0) unit.light.intensity = unit.peak;
    unit.light.distance = unit.spec.reach * this._reachMul;
    // `_peakMul` rides the colour for the same reason the dimmer does: Props
    // rewrites `intensity` every frame for its flickering wall fixtures and
    // updates after Lighting, so anything written there is gone before the frame
    // is drawn. `colour * intensity` is one product to the shader, and colour is
    // a channel no other system touches. Components above 1 are fine — a
    // THREE.Color is a plain float3 multiplier here, not a display value.
    unit.light.color.copy(unit.tint).multiplyScalar(this._dim * this._peakMul);
  }

  // --- shadows ---------------------------------------------------------------

  /**
   * Hand a 512 cubemap to the few fixtures that earn one, and bake it exactly
   * once. Scoring prefers wallpacks and courtyard lamps near the play space
   * over perimeter floods: a flood's shadow is 45 m of near-parallel rays that
   * nobody reads, whereas a wallpack's is the pool of light on the ground and
   * the hard edge up the column it is mounted to.
   */
  _assignShadows(camera) {
    this._shadowsAssigned = true;
    const centre = _lightPos.set(0, 0, 0);
    if (camera) camera.getWorldPosition(centre);

    const ranked = this.units
      .filter((u) => u.spec.shadowScore > 0 && u.peak > 1)
      .map((u) => {
        u.light.getWorldPosition(_pos);
        const d = Math.max(4, _pos.distanceTo(centre));
        return { u, score: (u.spec.shadowScore * 60) / d };
      })
      .sort((a, b) => b.score - a.score);

    for (let i = 0; i < ranked.length; i++) {
      const light = ranked[i].u.light;
      const want = i < MAX_SHADOW_LIGHTS;
      if (want === light.castShadow) continue;
      light.castShadow = want;
      if (want) {
        light.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
        // Three leaves a point shadow camera at far = 500 regardless of the
        // light's cutoff. Left alone, every one of the six faces would draw the
        // entire compound and the depth range would be useless.
        light.shadow.camera.near = 0.25;
        light.shadow.camera.far = Math.max(4, light.distance);
        light.shadow.camera.updateProjectionMatrix();
        light.shadow.bias = -0.0035;
        light.shadow.normalBias = 0.035;
        light.shadow.radius = 2.2;
        // Static fixtures over static geometry: bake once, never refresh.
        light.shadow.autoUpdate = false;
        light.shadow.needsUpdate = true;
      } else if (light.shadow.map) {
        light.shadow.map.dispose();
        light.shadow.map = null;
      }
    }
  }

  // --- yard rig ---------------------------------------------------------------

  /**
   * Build the yard rig: procedural masts with luminaire housings and emissive
   * lenses, one point light each, as three instanced meshes.
   *
   * This is not a fallback for a level with no lights — the level has plenty. It
   * is a fill for where they *are*. Every fixture the level publishes is bolted
   * to a building: floods on the perimeter wall, wallpacks by doors, highbays
   * inside the west hall. None of them are in the middle of the courtyard, which
   * is where the player stands and where the camera looks, so a night frame
   * framed on the yard contained no fixture at all and had nothing to read but
   * moonlight. Open ground is lit by masts in the open ground; that is what this
   * places, seeded from the level's own spawn and engagement points so the pools
   * land where the fight happens.
   */
  _ensureRig() {
    if (this._fallbackBuilt) return;
    this._fallbackBuilt = true;
    const sites = this._yardSites(this.fallbackCount);
    const count = sites.length;
    if (count === 0) return;

    const mastGeo = this._mastGeometry();
    const headGeo = this._headGeometry();
    const lensGeo = this._lensGeometry();

    this.mastMat = new THREE.MeshStandardMaterial({ color: 0x2b2e33, roughness: 0.62, metalness: 0.75 });
    this.headMat = new THREE.MeshStandardMaterial({ color: 0x3a3d42, roughness: 0.48, metalness: 0.8 });
    const mkLens = (hex) => new THREE.MeshStandardMaterial({
      color: 0x120b04, roughness: 0.28, metalness: 0.0,
      emissive: new THREE.Color(hex), emissiveIntensity: 0,
    });
    this.lensMatWarm = mkLens(SODIUM);
    this.lensMatCold = mkLens(FLUORO);
    this._lensMats = [this.lensMatWarm, this.lensMatCold];

    const isCold = (i) => i % 3 === 2;
    const coldCount = sites.filter((_, i) => isCold(i)).length;
    const warmCount = count - coldCount;

    this.mast = new THREE.InstancedMesh(mastGeo, this.mastMat, count);
    this.head = new THREE.InstancedMesh(headGeo, this.headMat, count);
    this.lensWarm = new THREE.InstancedMesh(lensGeo, this.lensMatWarm, Math.max(1, warmCount));
    this.lensCold = new THREE.InstancedMesh(lensGeo.clone(), this.lensMatCold, Math.max(1, coldCount));
    this.lensWarm.count = warmCount;
    this.lensCold.count = coldCount;
    for (const im of [this.mast, this.head, this.lensWarm, this.lensCold]) {
      im.receiveShadow = true;
      im.frustumCulled = false;
      this.group.add(im);
    }
    this.mast.castShadow = true;
    this.head.castShadow = true;

    let warmI = 0;
    let coldI = 0;
    for (let i = 0; i < count; i++) {
      const s = sites[i];
      _euler.set(0, s.yaw, 0);
      _q.setFromEuler(_euler);
      _pos.set(s.x, s.y, s.z);
      _m.compose(_pos, _q, _scale);
      this.mast.setMatrixAt(i, _m);
      this.head.setMatrixAt(i, _m);

      const cold = isCold(i);
      if (cold) this.lensCold.setMatrixAt(coldI++, _m);
      else this.lensWarm.setMatrixAt(warmI++, _m);

      const l = new THREE.PointLight(cold ? TEMP.k4000 : TEMP.k2700, 0, cold ? 13 : 15, 2);
      l.name = `practical-${cold ? 'strip' : 'lamp'}-${i}`;
      l.castShadow = false;
      l.position.set(
        s.x + Math.sin(s.yaw) * 1.05,
        s.y + 4.62,
        s.z + Math.cos(s.yaw) * 1.05,
      );
      this.group.add(l);
      const spec = cold ? FIXTURES.strip : FIXTURES.lamp;
      const unit = {
        light: l, peak: spec.peak, spec,
        tint: new THREE.Color(cold ? COOL : TEMP.k2700), owned: true,
      };
      this.units.push(unit);
      this._byLight.set(l, unit);
    }
    this.mast.instanceMatrix.needsUpdate = true;
    this.head.instanceMatrix.needsUpdate = true;
    this.lensWarm.instanceMatrix.needsUpdate = true;
    this.lensCold.instanceMatrix.needsUpdate = true;
    this._shadowsAssigned = false;
  }

  /**
   * Candidate mast positions, in priority order:
   *   1. offsets around the level's engagement points (enemy spawns), because
   *      that is where the player will be looking and shooting;
   *   2. offsets around the player spawn points;
   *   3. a ring inside the level bounds, if the level publishes neither.
   *
   * A candidate is rejected if it is within MAST_CLEARANCE of an already-adopted
   * fixture (no point double-lighting a doorway), if it is inside a collider, or
   * if the ground under it is not flat enough to stand a 5 m mast on.
   */
  _yardSites(count) {
    const level = this.ctx.get('level');
    const anchors = [];
    for (const p of level?.enemySpawns ?? []) anchors.push(p);
    for (const p of level?.spawnPoints ?? []) anchors.push(p);
    if (anchors.length === 0) {
      const bounds = level?.bounds;
      const extent = bounds
        ? Math.min(34, Math.max(12, Math.min(bounds.max.x - bounds.min.x, bounds.max.z - bounds.min.z) * 0.24))
        : 20;
      for (let i = 0; i < count * 2; i++) {
        const a = (i / (count * 2)) * Math.PI * 2 + 0.42;
        anchors.push(new THREE.Vector3(Math.cos(a) * extent, 0, Math.sin(a) * extent));
      }
    }

    const sites = [];
    for (let i = 0; i < anchors.length && sites.length < count; i++) {
      const a = anchors[i];
      // Step off the spawn itself so the mast is cover-adjacent, not on top of
      // the player, and alternate the side so the pools do not line up.
      const ang = 0.9 + i * 2.399;
      const x = a.x + Math.cos(ang) * MAST_OFFSET;
      const z = a.z + Math.sin(ang) * MAST_OFFSET;

      let clear = true;
      for (let u = 0; u < this.units.length && clear; u++) {
        this.units[u].light.getWorldPosition(_pos);
        const dx = _pos.x - x;
        const dz = _pos.z - z;
        if (dx * dx + dz * dz < MAST_CLEARANCE * MAST_CLEARANCE) clear = false;
      }
      for (let s = 0; s < sites.length && clear; s++) {
        const dx = sites[s].x - x;
        const dz = sites[s].z - z;
        if (dx * dx + dz * dz < MAST_SPACING * MAST_SPACING) clear = false;
      }
      if (!clear) continue;

      const y = level?.heightAt ? clampGround(level.heightAt(x, z)) : 0;
      // A mast wants flat ground: if the four corners of its base disagree by
      // more than a step height it is on a stair, a barrier or a roof edge.
      if (level?.heightAt) {
        const h0 = clampGround(level.heightAt(x + 0.7, z));
        const h1 = clampGround(level.heightAt(x - 0.7, z));
        const h2 = clampGround(level.heightAt(x, z + 0.7));
        const h3 = clampGround(level.heightAt(x, z - 0.7));
        const spread = Math.max(h0, h1, h2, h3) - Math.min(h0, h1, h2, h3);
        if (spread > 0.45) continue;
      }
      // Aim the outreach arm back toward the anchor it was seeded from.
      sites.push({ x, y, z, yaw: Math.atan2(a.x - x, a.z - z) });
    }
    return sites;
  }

  // --- procedural fixture geometry ------------------------------------------

  _mastGeometry() {
    // Tapered mast with a base flange and a short outreach arm, merged by hand
    // into one buffer so the whole fixture is a single instanced draw.
    const parts = [];
    const mast = new THREE.CylinderGeometry(0.062, 0.11, 4.9, 10, 1, true);
    mast.translate(0, 2.45, 0);
    parts.push(mast);
    const flange = new THREE.CylinderGeometry(0.19, 0.24, 0.16, 10);
    flange.translate(0, 0.08, 0);
    parts.push(flange);
    const arm = new THREE.CylinderGeometry(0.05, 0.055, 1.15, 8);
    arm.rotateZ(Math.PI / 2);
    arm.rotateY(-Math.PI / 2);
    arm.translate(0, 4.86, 0.55);
    parts.push(arm);
    return mergeGeometries(parts);
  }

  _headGeometry() {
    const shell = new THREE.BoxGeometry(0.42, 0.2, 0.72);
    shell.translate(0, 4.79, 1.05);
    const cap = new THREE.BoxGeometry(0.3, 0.1, 0.5);
    cap.translate(0, 4.9, 1.05);
    return mergeGeometries([shell, cap]);
  }

  _lensGeometry() {
    const lens = new THREE.BoxGeometry(0.34, 0.05, 0.6);
    lens.translate(0, 4.675, 1.05);
    return lens;
  }

  dispose() {
    this.cones.dispose();
    for (const u of this.units) {
      if (u.light.shadow?.map) { u.light.shadow.map.dispose(); u.light.shadow.map = null; }
      if (u.owned) u.light.dispose();
    }
    this.units.length = 0;
    this._byLight.clear();
    if (this._fallbackBuilt) {
      this.mast.geometry.dispose();
      this.head.geometry.dispose();
      this.lensWarm.geometry.dispose();
      this.lensCold.geometry.dispose();
      this.mastMat.dispose();
      this.headMat.dispose();
      this.lensMatWarm.dispose();
      this.lensMatCold.dispose();
    }
    this.group.removeFromParent();
  }
}

const clampGround = (y) => (Number.isFinite(y) && y > -20 && y < 20 ? y : 0);

/**
 * Minimal position/normal/uv/index merge. three's BufferGeometryUtils lives in
 * examples/jsm; keeping a 30-line local version avoids depending on a path that
 * other systems may or may not have imported.
 */
function mergeGeometries(geos) {
  let vCount = 0;
  let iCount = 0;
  for (const g of geos) {
    vCount += g.attributes.position.count;
    iCount += g.index ? g.index.count : g.attributes.position.count;
  }
  const pos = new Float32Array(vCount * 3);
  const nrm = new Float32Array(vCount * 3);
  const uv = new Float32Array(vCount * 2);
  const idx = new Uint32Array(iCount);
  let vo = 0;
  let io = 0;
  for (const g of geos) {
    const p = g.attributes.position;
    const n = g.attributes.normal;
    const t = g.attributes.uv;
    pos.set(p.array.subarray(0, p.count * 3), vo * 3);
    if (n) nrm.set(n.array.subarray(0, n.count * 3), vo * 3);
    if (t) uv.set(t.array.subarray(0, t.count * 2), vo * 2);
    if (g.index) {
      const gi = g.index.array;
      for (let i = 0; i < gi.length; i++) idx[io + i] = gi[i] + vo;
      io += gi.length;
    } else {
      for (let i = 0; i < p.count; i++) idx[io + i] = i + vo;
      io += p.count;
    }
    vo += p.count;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeBoundingSphere();
  return out;
}
