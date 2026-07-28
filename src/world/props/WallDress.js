import * as THREE from 'three';
import { pipeRoute } from './parts/Industrial.js';
import { catenary, tubeAlong, boxUV, boxUV01, atlasRemap } from './GeoUtil.js';
import { SIGN } from './Atlas.js';
import { local, baseMatrix, signQuad } from './Clusters.js';

/**
 * Wall, ceiling and floor dressing. OWNER: props agent.
 *
 * Long unbroken wall runs are the other half of the greybox read — a 20 m
 * concrete face with nothing on it looks like a test level regardless of how good
 * the concrete is. Everything here is attached by raycast against the real wall
 * surface at the exact height it will be mounted, so a fixture can never end up
 * hanging in air off the end of a short wall.
 */

const _m = new THREE.Matrix4();
const _v = new THREE.Vector3();
const _n = new THREE.Vector3();
const _t = new THREE.Vector3();

/** Yaw that maps local +Z onto a wall normal. */
const yawToNormal = (n) => Math.atan2(n.x, n.z);

/**
 * Confirm there is wall at (x,z,height) facing `normal`, and return the exact
 * surface point. This is the check that stops fixtures floating off wall ends.
 */
export function faceAt(probe, x, z, normal, height, reach = 0.85) {
  _v.set(x + normal.x * reach, height, z + normal.z * reach);
  _n.set(-normal.x, 0, -normal.z);
  const hit = probe.cast(_v, _n, reach * 2);
  if (!hit) return null;
  // The surface must face the SAME way as the anchor, not merely be parallel to
  // it. Accepting |dot| mounts fixtures on the far face of a thin wall, which
  // renders as a mirrored sign seen through the geometry.
  if (hit.normal.dot(normal) < 0.7) return null;
  if (Math.abs(hit.normal.y) > 0.45) return null;
  return hit;
}

export class WallDresser {
  constructor(api) {
    this.api = api;
    this.lampSpots = [];
  }

  /** Main pass over the surveyed wall anchors. */
  run(anchors) {
    const { rng } = this.api;
    const shuffled = rng.shuffle(anchors.slice());
    let pipes = 0, signs = 0, lamps = 0, boxes = 0, vents = 0;

    for (const a of shuffled) {
      const roll = rng.next();

      // pipe / conduit runs — the highest-value wall dressing there is
      if (roll < 0.34 && pipes < 26) {
        if (this.pipeRun(a, rng.range(1.1, 2.9), rng.bool(0.45) ? 'rusty' : 'steel')) pipes++;
      }
      // wall lamp
      if (rng.bool(0.34) && lamps < 34) {
        if (this.lamp(a)) lamps++;
      }
      // signage
      if (rng.bool(0.5) && signs < 46) {
        if (this.sign(a)) signs++;
      }
      // junction box + conduit drop
      if (rng.bool(0.26) && boxes < 24) {
        if (this.junction(a)) boxes++;
      }
      // extract vent
      if (rng.bool(0.16) && vents < 14) {
        if (this.vent(a)) vents++;
      }
    }

    this.cables(shuffled);
    return { pipes, signs, lamps, boxes, vents };
  }

  /** A pipe that follows the wall until the wall stops. */
  pipeRun(anchor, height, matName) {
    const { probe, rng } = this.api;
    const n = anchor.normal;
    _t.set(-n.z, 0, n.x);                        // wall tangent
    const dirSign = rng.bool(0.5) ? 1 : -1;
    const radius = rng.range(0.035, 0.085);
    const offset = radius + rng.range(0.05, 0.13);
    const step = rng.range(1.0, 1.6);
    const points = [];
    const brackets = [];

    for (let i = 0; i < 9; i++) {
      const px = anchor.point.x + _t.x * dirSign * i * step;
      const pz = anchor.point.z + _t.z * dirSign * i * step;
      const hit = faceAt(probe, px, pz, n, height);
      if (!hit) break;
      points.push(new THREE.Vector3(
        hit.point.x + n.x * offset,
        height + Math.sin(i * 1.7) * 0.012,
        hit.point.z + n.z * offset,
      ));
      brackets.push(hit);
    }
    if (points.length < 3) return false;

    // an elbow down the wall at the end, sometimes
    if (rng.bool(0.4)) {
      const last = points[points.length - 1];
      const drop = Math.max(0.4, height - rng.range(0.35, 1.1));
      points.push(new THREE.Vector3(last.x, drop, last.z));
    }

    const geo = pipeRoute(points, radius, rng);
    this.api.batcher.merge(matName, geo, this.api.mats.get(matName),
      { solid: true, castShadow: true, receiveShadow: true });

    for (let i = 0; i < brackets.length; i += 2) {
      const h = brackets[i];
      local(this.api, 'pbracket_0',
        baseMatrix(h.point.x, points[i].y, h.point.z, Math.atan2(-n.z, n.x)),
        0, 0, 0, 0, 0, 0, rng.range(0.9, 1.05));
    }
    // pipe ident band
    if (rng.bool(0.3) && points.length > 2) {
      const p = points[1];
      _m.makeTranslation(0, 0, radius + 0.006).premultiply(
        baseMatrix(p.x, p.y, p.z, yawToNormal(n)),
      );
      signQuad(this.api, SIGN.pipeBand, radius * 3.4, radius * 2.4, _m);
    }
    return true;
  }

  /** Wall-pack lamp with its emissive lens, and a real point light for a few. */
  lamp(anchor) {
    const { probe, rng } = this.api;
    const n = anchor.normal;
    const h = rng.range(2.5, 3.6);
    const hit = faceAt(probe, anchor.point.x, anchor.point.z, n, h);
    if (!hit) return false;
    const hn = hit.normal;                       // orient to the real surface
    const yaw = yawToNormal(hn);
    const base = baseMatrix(hit.point.x + hn.x * 0.02, h, hit.point.z + hn.z * 0.02, yaw);
    local(this.api, 'lamp_0', base, 0, 0, 0, 0, 0, 0, rng.range(0.9, 1.05));
    local(this.api, 'lamplens_0', base, 0, 0, 0);
    this.lampSpots.push({
      x: hit.point.x + hn.x * 0.35, y: h - 0.06, z: hit.point.z + hn.z * 0.35, warm: true,
    });
    return true;
  }

  /** Warning / identification signage bolted flat to the wall. */
  sign(anchor) {
    const { probe, rng } = this.api;
    const n = anchor.normal;
    const cells = [
      SIGN.warning, SIGN.highVoltage, SIGN.noEntry, SIGN.radiation, SIGN.authorised,
      SIGN.bio, SIGN.exit, SIGN.fuel, SIGN.muster, SIGN.number07, SIGN.sector,
      SIGN.hazardBand, SIGN.chevron,
    ];
    const cell = rng.pick(cells);
    const big = cell === SIGN.number07 || cell === SIGN.sector;
    const size = big ? rng.range(0.9, 1.6) : rng.range(0.42, 0.78);
    const h = big ? rng.range(1.9, 2.9) : rng.range(1.3, 2.2);
    const jitterT = rng.range(-1.2, 1.2);
    _t.set(-n.z, 0, n.x);
    const hit = faceAt(probe, anchor.point.x + _t.x * jitterT, anchor.point.z + _t.z * jitterT, n, h);
    if (!hit) return false;
    _m.makeTranslation(0, 0, 0.018).premultiply(
      baseMatrix(hit.point.x, h, hit.point.z, yawToNormal(hit.normal) + rng.jit(0.02)),
    );
    signQuad(this.api, cell, size, size * (big ? 1 : rng.range(0.85, 1.15)), _m);
    return true;
  }

  /** Junction box with a conduit drop to the floor. */
  junction(anchor) {
    const { probe, rng } = this.api;
    const n = anchor.normal;
    const h = rng.range(1.2, 2.1);
    const hit = faceAt(probe, anchor.point.x, anchor.point.z, n, h);
    if (!hit) return false;
    const hn = hit.normal;
    local(this.api, 'junction_0',
      baseMatrix(hit.point.x + hn.x * 0.07, h, hit.point.z + hn.z * 0.07, yawToNormal(hn)),
      0, 0, 0, 0, 0, 0, rng.range(0.92, 1.06));

    // conduit down to the ground
    const g = probe.ground(hit.point.x + hn.x * 0.12, hit.point.z + hn.z * 0.12, h);
    if (g) {
      const pts = [
        new THREE.Vector3(hit.point.x + hn.x * 0.09, h - 0.2, hit.point.z + hn.z * 0.09),
        new THREE.Vector3(hit.point.x + hn.x * 0.09, (h + g.point.y) * 0.5, hit.point.z + hn.z * 0.09),
        new THREE.Vector3(hit.point.x + hn.x * 0.09, g.point.y + 0.12, hit.point.z + hn.z * 0.09),
        new THREE.Vector3(hit.point.x + hn.x * 0.28, g.point.y + 0.03, hit.point.z + hn.z * 0.28),
      ];
      const geo = tubeAlong(pts, 0.024, 6);
      boxUV(geo, 2.5);
      this.api.batcher.merge('darkmetal', geo, this.api.mats.get('darkmetal'),
        { solid: false, castShadow: true, receiveShadow: true });
    }
    return true;
  }

  vent(anchor) {
    const { probe, rng } = this.api;
    const n = anchor.normal;
    const h = rng.range(2.0, 3.2);
    const hit = faceAt(probe, anchor.point.x, anchor.point.z, n, h);
    if (!hit) return false;
    const hn = hit.normal;
    const base = baseMatrix(hit.point.x + hn.x * 0.005, h, hit.point.z + hn.z * 0.005, yawToNormal(hn));
    local(this.api, 'vent_0', base, 0, 0, 0, 0, 0, 0, rng.range(0.9, 1.06));
    local(this.api, 'ventface_0', base, 0, 0, 0);
    return true;
  }

  /**
   * Hanging cable runs between anchors. Catenary sag is what makes a cable read
   * as a cable — a straight line reads as a modelling mistake.
   */
  cables(anchors) {
    const { rng, probe } = this.api;
    let made = 0;
    for (let i = 0; i < anchors.length && made < 26; i++) {
      const a = anchors[i];
      const b = anchors[(i + 1 + ((rng.next() * 5) | 0)) % anchors.length];
      if (a === b) continue;
      const h1 = rng.range(2.6, 4.2);
      const fa = faceAt(probe, a.point.x, a.point.z, a.normal, h1);
      if (!fa) continue;
      const fb = faceAt(probe, b.point.x, b.point.z, b.normal, h1 + rng.jit(0.5));
      if (!fb) continue;
      const p1 = new THREE.Vector3(fa.point.x + a.normal.x * 0.1, h1, fa.point.z + a.normal.z * 0.1);
      const p2 = new THREE.Vector3(fb.point.x + b.normal.x * 0.1, h1 + rng.jit(0.4), fb.point.z + b.normal.z * 0.1);
      const span = p1.distanceTo(p2);
      if (span < 2.5 || span > 11) continue;
      const strands = rng.int(1, 3);
      for (let s = 0; s < strands; s++) {
        _t.set(-a.normal.z, 0, a.normal.x).multiplyScalar((s - (strands - 1) / 2) * 0.06);
        const pts = catenary(
          p1.clone().add(_t),
          p2.clone().add(_t),
          rng.range(0.09, 0.2), 9,
        );
        const geo = tubeAlong(pts, rng.range(0.013, 0.024), 5);
        boxUV(geo, 3);
        this.api.batcher.merge('rubber', geo, this.api.mats.get('rubber'),
          { solid: false, castShadow: false, receiveShadow: false });
      }
      made++;
    }
    return made;
  }

  /** Ceiling fixtures: strip lights and ducting where there is a ceiling. */
  ceilings(samples) {
    const { rng, probe } = this.api;
    let lights = 0, ducts = 0;
    for (const s of samples) {
      if (lights >= 22 && ducts >= 10) break;
      const c = probe.ceiling(s.x, s.y + 0.6, s.z, 7);
      if (!c) continue;
      const height = c.point.y;
      if (height - s.y < 2.2) continue;
      if (rng.bool(0.35) && lights < 22) {
        const yaw = rng.range(0, Math.PI * 2);
        const base = baseMatrix(s.x, height - 0.07, s.z, yaw);
        local(this.api, 'strip_0', base, 0, 0, 0, 0, 0, 0, rng.range(0.92, 1.05));
        local(this.api, 'striplens_0', base, 0, 0, 0);
        this.lampSpots.push({ x: s.x, y: height - 0.2, z: s.z, warm: false });
        lights++;
      }
      if (rng.bool(0.18) && ducts < 10) {
        const yaw = rng.bool(0.5) ? 0 : Math.PI / 2;
        local(this.api, 'duct_0', baseMatrix(s.x, height - 0.28, s.z, yaw), 0, 0, 0, 0, 0, 0,
          rng.range(0.92, 1.06));
        ducts++;
      }
    }
    return { lights, ducts };
  }

  /** Painted floor markings. These read strongly from any elevated view. */
  floorMarks(samples) {
    const { rng } = this.api;
    let made = 0;
    for (const s of samples) {
      if (made >= 26) break;
      if (!rng.bool(0.1)) continue;
      if (s.wallDist < 1.2) continue;
      const cell = rng.pick([SIGN.keepClear, SIGN.hazardBand, SIGN.sector, SIGN.number07, SIGN.chevron]);
      const w = rng.range(0.8, 1.7);
      const geo = new THREE.PlaneGeometry(w, w * rng.range(0.55, 1.0));
      atlasRemap(boxUV01(geo), cell[0], cell[1], 4, 4);
      geo.rotateX(-Math.PI / 2);
      // Painted markings run along the traffic direction, so align to the nearest
      // wall's tangent rather than spinning them at random.
      const along = s.wallNormal
        ? Math.atan2(-s.wallNormal.z, s.wallNormal.x) + rng.jit(0.06)
        : rng.pick([0, Math.PI / 2, Math.PI, -Math.PI / 2]) + rng.jit(0.05);
      geo.rotateY(along);
      geo.translate(s.x + rng.jit(0.6), s.y + 0.014, s.z + rng.jit(0.6));
      this.api.batcher.merge('sign', geo, this.api.mats.get('sign'),
        { solid: false, castShadow: false, receiveShadow: true });
      made++;
    }
    return made;
  }

  /**
   * Register a limited number of real point lights on the lamps closest to the
   * canonical camera positions. Lights are expensive; the emissive lens material
   * carries the rest of the read via bloom.
   */
  makeLights(maxLights, heroPoints) {
    const { ctx, rng } = this.api;
    const lighting = ctx.get('lighting');
    const scored = this.lampSpots.map((s) => {
      let best = Infinity;
      for (const h of heroPoints) {
        const d = (s.x - h.x) ** 2 + (s.z - h.z) ** 2;
        if (d < best) best = d;
      }
      return { s, d: best };
    }).sort((a, b) => a.d - b.d);

    const lights = [];
    for (let i = 0; i < Math.min(maxLights, scored.length); i++) {
      const { s } = scored[i];
      const colour = s.warm ? 0xffc98a : 0xd6e8ff;
      const l = new THREE.PointLight(colour, s.warm ? 4.2 : 3.0, s.warm ? 11 : 9, 2);
      l.position.set(s.x, s.y, s.z);
      l.castShadow = false;
      if (lighting?.addPoint) lighting.addPoint(l);
      else ctx.scene.add(l);
      lights.push({ light: l, base: l.intensity, seed: rng.range(0, 100), warm: s.warm });
    }
    return lights;
  }
}
