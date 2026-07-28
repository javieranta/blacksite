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
    this._localMats = groundworkMaterials(forge);
    for (const [name, mat] of Object.entries(this._localMats)) b.material(name, mat);

    const w = {
      apertures: this.apertures,
      lightAnchors: this.lightAnchors,
      spawnPoints: this.spawnPoints,
      enemySpawns: this.enemySpawns,
    };

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

    this._realiseLights(ctx);

    if (b.rejected.size) {
      console.warn('[level] dropped non-finite geometry:', [...b.rejected].map(([k, n]) => `${k} x${n}`).join(', '));
    }
    const tris = Math.round(b.triangles);
    console.info(
      `[level] Site 9 baked: ${tris.toLocaleString()} tris in ${baked.solid.length + baked.loose.length}`
      + ` meshes (${baked.solid.length} solid), ${this.apertures.length} apertures,`
      + ` ${this.lightAnchors.length} light anchors, ${Math.round(performance.now() - t0)}ms`,
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
