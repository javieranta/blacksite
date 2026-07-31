import * as THREE from 'three';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';

import { Builder } from './level/GeoKit.js';
import { L, buildGround, buildCanopy, buildCourtyard, buildPumpHouse, buildNorthYard, buildServiceYard } from './level/Compound.js';
import { buildPerimeter } from './level/Perimeter.js';
import { buildWestHall, buildAdminBlock } from './level/Interiors.js';
import { buildTerrain, buildMidDistance, buildSkyline, buildRidge, terrainHeight } from './level/Backdrop.js';
import { buildOutfield } from './level/Outfield.js';
import { buildGroundworks, groundworkMaterials } from './level/Groundworks.js';
import { buildForeground } from './level/Foreground.js';
import { towerMaterials } from './level/Towers.js';

// three-mesh-bvh install. Meshes without a boundsTree fall back to the stock
// raycast, so Props' geometry keeps working untouched.
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

/**
 * OWNER: level agent.
 * CONTRACT — the single source of truth for world collision:
 *   level.colliders   : THREE.Group — EVERY solid mesh must be added here
 *                       (Props adds to it too). BVH-accelerated.
 *   level.addCollider(mesh)
 *   level.raycast(origin, dir, maxDist) -> { point, normal, distance, object, surface } | null
 *   level.spawnPoints : THREE.Vector3[]
 *   level.enemySpawns : THREE.Vector3[]
 *   level.bounds      : THREE.Box3
 *
 * EXTRA SEAMS this system publishes (additive — nobody has to use them):
 *   level.apertures    : [{ position, normal, width, height, kind }] — every
 *                        window, rooflight, clerestory and shutter opening in
 *                        the map. Lighting can hang volumetric shafts on these.
 *   level.lightAnchors : [{ position, colour, intensity, distance, kind }] —
 *                        where the level wants artificial light. Handed to
 *                        lighting.addPoint() if that exists, otherwise realised
 *                        locally so the interior is never black.
 *   level.levels       : named floor heights (yard / courtyard / catwalk deck).
 *   level.heightAt(x,z): ground height query (BVH raycast down).
 *
 * THE MAP — "Site 9", a decommissioned industrial research compound, ~94x86m
 * inside a perimeter wall:
 *   - a contested central courtyard on two levels with hard cover, a drainage
 *     channel as a leading line and a loading dock,
 *   - two flanking interior routes: the WEST HALL (fully enclosed, glazed
 *     clerestory + three rooflights) and the ADMIN BLOCK (three storeys),
 *   - an elevated ring: service-yard pipe gantry at 4.7m, stair tower, catwalk
 *     bridge into the admin block,
 *   - a north industrial yard carrying the landmark silhouette (27m stack,
 *     elevated tank, silo bank, pipe bridge),
 *   - and a closed horizon: terrain to 880m, a mid-distance industrial band and
 *     two ridge layers, so the world never ends inside the frame.
 */
export class Level {
  constructor() {
    this.name = 'level';
    this.colliders = new THREE.Group();
    this.colliders.name = 'colliders';
    this.decor = new THREE.Group();
    this.decor.name = 'level:decor';

    this.levels = L;
    this.spawnPoints = [
      new THREE.Vector3(6, 1.78, 14),        // courtyard, looking at the stack
      new THREE.Vector3(2, L.yard + 1.78, 2),
      new THREE.Vector3(-12, L.yard + 1.78, 6),
    ];
    this.enemySpawns = [
      new THREE.Vector3(16, 1.78, 30),
      new THREE.Vector3(-1, 1.78, 33),
      new THREE.Vector3(21, L.deck + 1.78, 24),
      new THREE.Vector3(13, 1.78, 40),
      new THREE.Vector3(24, 1.98, 26),
    ];
    this.apertures = [];
    this.lightAnchors = [];
    /**
     * KEEP-CLEAR VOLUMES — the circulation the player must be able to walk.
     *
     * Every stair flight, landing and walkway in the map, as world-space AABBs
     * that reach PLAYER.height above the walking surface. Nothing may occupy
     * them: not level geometry, and not scattered props.
     *
     * This exists because the traversal suite found three separate routes
     * blocked not by the level but by prop instances snapped onto surfaces the
     * level had just created — a sandbag emplacement across the stair tower's
     * head landing, a pallet stack at the foot of the dock steps, and another
     * sandbag stack on the admin tower's bottom treads. Props is welcome to put
     * cover ON a catwalk; it may not put it across the only way up.
     *
     * `tools/traversal.mjs` audits these volumes and names whatever it finds in
     * them. Any system that scatters instances should subtract them first:
     *     const clear = ctx.get('level')?.keepClear ?? [];
     */
    this.keepClear = [];
    /**
     * Climbable ladder volumes, filled by `ladder()` in level/Modules.js.
     * PlayerController tests the capsule against these to enter its climb state.
     * Ladders existed as geometry in eight places for eleven rounds while being
     * completely unclimbable, because nothing connected the two.
     */
    this.ladders = [];
    this.bounds = new THREE.Box3(
      new THREE.Vector3(-44, -4, -28),
      new THREE.Vector3(54, 34, 62),
    );

    this.meshes = [];
    this._ray = new THREE.Raycaster();
    this._ray.firstHitOnly = true;
    this._down = new THREE.Vector3(0, -1, 0);
    this._probe = new THREE.Vector3();
    this._lights = [];
  }

  init(ctx) {
    this.ctx = ctx;
    const forge = ctx.require('forge');
    ctx.scene.add(this.colliders);
    ctx.scene.add(this.decor);

    const t0 = performance.now();
    const b = new Builder();
    // Level-local materials (road paint, standing water). They are derived from
    // the forge's procedural bakes, so they cost no extra texture upload — only
    // the material object — and they stay out of the shared library because
    // nothing but the level ever asks for them.
    this._localMats = { ...groundworkMaterials(forge), ...towerMaterials(forge) };
    for (const [name, mat] of Object.entries(this._localMats)) b.material(name, mat);

    const w = {
      apertures: this.apertures,
      lightAnchors: this.lightAnchors,
      spawnPoints: this.spawnPoints,
      enemySpawns: this.enemySpawns,
      keepClear: this.keepClear,
      ladders: this.ladders,
    };
    this._declareCirculation();

    // ---- surroundings first, so the horizon exists before the compound does
    buildTerrain(b, w);
    buildRidge(b, w);
    buildSkyline(b, w);
    buildMidDistance(b, w);
    buildOutfield(b, w);

    // ---- the compound
    buildGround(b, w);
    buildPerimeter(b, w);
    buildServiceYard(b, w);
    buildCourtyard(b, w);
    buildCanopy(b, w);
    buildPumpHouse(b, w);
    buildNorthYard(b, w);
    buildWestHall(b, w);
    buildAdminBlock(b, w);

    // ---- the ground plane, then the near-camera framing layer. Both are laid
    // out against the compound above and must run after it.
    buildGroundworks(b, w);
    buildForeground(b, w);

    // ---- bake: merge per (zone, material, shadow flags) and build BVHs
    const zones = b.zoneStats();
    const baked = b.bake(forge);
    for (const m of baked.solid) {
      // maxDepth 48: the merged ground buckets are wide and near-planar, which
      // is the worst case for a median split and overflows the 40 default.
      m.geometry.computeBoundsTree({ targetLeafSize: 12, maxDepth: 48 });
      this.addCollider(m);
      this.meshes.push(m);
    }
    for (const m of baked.loose) {
      this.decor.add(m);
      this.meshes.push(m);
    }

    // The builder accumulates climb volumes as it lays ladders down; hand them
    // to the controller now that the geometry they describe actually exists.
    if (b.ladders?.length) this.ladders.push(...b.ladders);

    this._realiseLights(ctx);

    if (b.rejected.size) {
      console.warn('[level] dropped non-finite geometry:', [...b.rejected].map(([k, n]) => `${k} x${n}`).join(', '));
    }
    const tris = Math.round(b.triangles);
    console.info(
      `[level] Site 9 baked: ${tris.toLocaleString()} tris in ${baked.solid.length + baked.loose.length}`
      + ` meshes (${baked.solid.length} solid), ${this.apertures.length} apertures,`
      + ` ${this.lightAnchors.length} light anchors, ${this.ladders.length} ladders,`
      + ` ${Math.round(performance.now() - t0)}ms`,
    );
    console.info('[level] tris by zone:', zones.map(([z, n]) => `${z} ${Math.round(n / 100) / 10}k`).join('  '));
  }

  /**
   * The level asks for artificial light. `lightAnchors` is the full data set and
   * Lighting is welcome to consume all of it however it likes. What we actually
   * REALISE is capped hard: every extra point light widens every material's
   * shader, so 48 of them costs minutes of shader compilation and kills the
   * frame. Anchors carry a priority so the ones that matter (enclosed
   * interiors, the entry canopy) win the budget.
   */
  _realiseLights(ctx) {
    const MAX_REALISED_LIGHTS = 8;
    const lighting = ctx.get('lighting');
    const ranked = this.lightAnchors
      .map((a, i) => ({ a, i, p: a.priority ?? 0 }))
      .sort((u, v) => (v.p - u.p) || (u.i - v.i))
      .slice(0, MAX_REALISED_LIGHTS);
    for (const { a } of ranked) {
      const light = new THREE.PointLight(a.colour ?? 0xffe8c8, a.intensity ?? 4, a.distance ?? 16, 2);
      light.position.copy(a.position);
      light.castShadow = false;
      light.name = `level:${a.kind ?? 'lamp'}`;
      a.light = light;
      let taken = false;
      if (lighting && typeof lighting.addPoint === 'function') {
        try { taken = lighting.addPoint(light) != null; } catch { taken = false; }
      }
      if (!taken) this.decor.add(light);
      this._lights.push(light);
    }
  }

  /**
   * The walkable circulation, declared once by hand against the geometry that
   * builds it. Each entry is the swept capsule corridor of a route: the plan
   * footprint the player occupies, from the lowest tread to PLAYER.height above
   * the highest one.
   *
   * Hand-authored rather than derived, deliberately. Deriving it from the stair
   * calls would make it agree with the geometry by construction and therefore
   * prove nothing; written out separately it is a second opinion, and when the
   * two disagree the traversal suite says so.
   */
  _declareCirculation() {
    const H = 1.78;
    const put = (name, x0, x1, y0, y1, z0, z1) => this.keepClear.push({
      name,
      box: new THREE.Box3(new THREE.Vector3(x0, y0, z0), new THREE.Vector3(x1, y1 + H, z1)),
    });
    // main stair tower, x = 23.2
    put('stair tower flight 1', 22.45, 23.95, 0.0, 2.41, 9.2, 13.1);
    put('stair tower half landing', 22.25, 24.15, 2.40, 2.41, 13.1, 14.6);
    put('stair tower flight 2', 22.45, 23.95, 2.40, 4.71, 14.3, 18.2);
    put('stair tower head landing', 21.80, 24.40, 4.70, 4.71, 18.2, 20.0);
    // catwalk ring
    put('ring: admin bridge', 20.20, 21.80, 4.70, 4.71, 10.0, 15.9);
    put('ring: north leg', 20.20, 21.80, 4.70, 4.71, 15.9, 28.4);
    put('ring: west leg', 13.20, 20.20, 4.70, 4.71, 26.8, 28.4);
    put('ring: yard leg', 9.00, 30.00, 4.70, 4.71, 1.2, 2.8);
    // east route: dock steps, dock apron, dock fire stair
    put('dock steps', 20.05, 22.10, 0.0, 1.21, 18.2, 19.8);
    put('dock apron to the fire stair', 22.10, 25.60, 1.20, 1.21, 18.0, 22.0);
    put('dock fire stair', 23.50, 24.90, 1.20, 4.71, 21.1, 26.8);
    put('dock fire stair head', 21.80, 24.80, 4.70, 4.71, 26.8, 28.4);
    // plant deck switchback
    put('plant deck flight 1', 10.90, 12.30, -0.35, 2.18, -5.8, -1.6);
    put('plant deck half landing', 11.20, 14.60, 2.17, 2.18, -7.8, -5.8);
    put('plant deck flight 2', 13.50, 14.90, 2.17, 4.70, -6.6, -2.4);
    put('plant deck link', 13.50, 14.90, 4.70, 4.71, -2.4, 2.0);
    // crate climb (informal, so only the ramp and plinth are protected)
    put('crate climb ramp', 9.30, 11.90, 0.0, 0.56, 29.1, 33.6);
  }

  addCollider(mesh) {
    this.colliders.add(mesh);
    return mesh;
  }

  /**
   * BVH-accelerated world query. Ballistics calls this on every shot and every
   * penetration step, so it must not allocate more than the hit record.
   */
  raycast(origin, dir, maxDist = 500) {
    this._ray.set(origin, dir);
    this._ray.near = 0;
    this._ray.far = maxDist;
    const hits = this._ray.intersectObject(this.colliders, true);
    if (!hits.length) return null;
    let h = hits[0];
    for (let i = 1; i < hits.length; i++) if (hits[i].distance < h.distance) h = hits[i];
    const forge = this.ctx.require('forge');
    const normal = h.face
      ? h.face.normal.clone().transformDirection(h.object.matrixWorld).normalize()
      : new THREE.Vector3(0, 1, 0);
    if (normal.dot(dir) > 0) normal.negate();
    return {
      point: h.point.clone(),
      normal,
      distance: h.distance,
      object: h.object,
      surface: forge.surfaceOf(h.object.material),
    };
  }

  /** Ground height at a column, for spawn placement and AI. -Infinity if void. */
  heightAt(x, z, from = 40) {
    this._probe.set(x, from, z);
    const hit = this.raycast(this._probe, this._down, from + 60);
    return hit ? hit.point.y : terrainHeight(x, z);
  }

  dispose() {
    for (const m of this.meshes) {
      m.geometry.disposeBoundsTree?.();
      m.geometry.dispose();
    }
    for (const l of this._lights) l.parent?.remove(l);
    for (const m of Object.values(this._localMats ?? {})) m.dispose();
    this._localMats = null;
    this.meshes.length = 0;
    this.colliders.clear();
    this.decor.clear();
  }
}
