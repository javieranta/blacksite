import * as THREE from 'three';
import { Rand } from './props/Rand.js';
import { PropMaterials } from './props/Materials.js';
import { Batcher } from './props/Kit.js';
import { SurfaceProbe, Placer } from './props/Surfaces.js';
import { Protos } from './props/Protos.js';
import { derelictPickup, derelictVan } from './props/parts/Vehicles.js';
import {
  depot, checkpoint, utility, wreck, construction, fenceRun, sandbagWall,
} from './props/Clusters.js';
import { WallDresser } from './props/WallDress.js';
import {
  scatterLitter, scatterWeeds, scatterClutter, foregroundRing, coverForCamera,
} from './props/Scatter.js';
import { ContactPass } from './props/Contact.js';
import { FloatSweep } from './props/Float.js';
import { LevelFloatPass } from './props/LevelFloat.js';
import { capPlaceholderBags } from './props/parts/BagCap.js';
import { buildBackdrop } from './props/parts/Backdrop.js';
import { groundMarks, apronClutter, contactPatches } from './props/parts/GroundDress.js';
import { groundIncident } from './props/parts/GroundIncident.js';

/**
 * OWNER: props agent.
 * CONTRACT:
 *   Adds set-dressing meshes. Solid props MUST be registered via
 *   ctx.require('level').addCollider(mesh). Non-solid dressing goes straight
 *   onto ctx.scene.
 *   props.instanced : InstancedMesh registry — use instancing for anything
 *   appearing >8 times (draw-call budget is 900).
 *
 * HOW IT WORKS
 *   1. MATERIALS  — a procedural PBR foundry (canvas + noise fields) produces
 *      albedo/normal/roughness/metalness for every surface family. Two texture
 *      atlases (containers, signage) keep the material count, and therefore the
 *      draw-call count, low. Zero external assets.
 *   2. PROBE      — a private BVH snapshot of level.colliders. The props system
 *      never assumes where the world is; it raycasts to find out.
 *   3. PROTOS     — every repeating prop is built once as 1-4 seeded geometry
 *      variants and drawn as an InstancedMesh.
 *   4. DRESSING   — themed clusters (depot / checkpoint / utility / wreck /
 *      construction) at surveyed sites, wall + ceiling runs attached by raycast,
 *      then a density-field litter pass in the gaps.
 *   5. VALIDATION — Placer re-probes every placement's bounding-box base and
 *      rejects anything with more than a 1 cm gap. The count is reported.
 */

const CONFIG = {
  seed: 0x1c0ffee,
  sampleStep: 2.3,
  sampleRadius: 54,
  minSlope: 0.86,
  spawnClear: 4.0,
  cameraClear: 2.15,
  siteCount: 31,
  siteSeparation: 5.6,
  heroSiteCount: 10,
  /**
   * Interiors get more sites than they used to. The review found a factory floor
   * whose entire dressing was one water bottle; eight themed sites across every
   * interior in the level was simply not enough to fill a hall that size.
   */
  interiorSiteCount: 15,
  litterBudget: 560,
  weedBudget: 340,
  /**
   * Tertiary clutter. ~40-80 items per 100 m² over the dressed envelope, laid
   * down in knots rather than evenly — see Scatter.scatterClutter.
   */
  clutterBudget: 1550,
  fenceRuns: 4,
  maxPointLights: 6,
  /**
   * Open-apron dressing. The density-field scatter is near zero in the middle
   * of a yard by construction, so the bare ground in the mid-frame needs its own
   * pass: marks (tyre tracks, scuffs, oil) plus wind-blown streak litter and
   * grit banked against every kerb the probe can find.
   */
  apronBudget: 340,
  kerbDriftBudget: 200,
  tyreTracks: 12,
  /**
   * The distance band, 95-330 m. Everything out there is silhouette and costs
   * four merged draw calls in total — see props/parts/Backdrop.js.
   */
  backdrop: true,
  /** Canonical shoot-rig camera positions (tools/shoot.mjs VIEWS, read-only). */
  heroPoints: [
    { x: 6, y: 1.7, z: 14 },
    { x: -8, y: 1.7, z: -4 },
    { x: 2, y: 1.4, z: 3 },
    { x: 20, y: 1.7, z: 0 },
    { x: 0, y: 6.5, z: 0 },
    { x: 4, y: 1.7, z: 6 },
  ],
};

const THEMES = { depot, checkpoint, utility, wreck, construction };

export class Props {
  constructor() {
    this.name = 'props';
    /** @type {Map<string, THREE.InstancedMesh>} */
    this.instanced = new Map();
    this.stats = null;
    this._lights = [];
    this._glow = null;
    this._glowCold = null;
    this._t = 0;
  }

  init(ctx) {
    this.ctx = ctx;
    const t0 = performance.now();
    try {
      this._build(ctx);
      this.buildMs = performance.now() - t0;
      ctx.bus.emit('props:ready', { stats: this.stats });
    } catch (err) {
      // A prop failure must never take the page down — the contract requires a
      // clean console for the whole build, so degrade instead of throwing.
      console.warn('[props] dressing pass failed, level will be under-dressed:', err);
    }
  }

  _build(ctx) {
    const level = ctx.require('level');
    const rng = new Rand(CONFIG.seed);

    // 1 — materials
    this.mats = new PropMaterials(ctx).build();

    // 2 — probe the world we have been given
    this.probe = new SurfaceProbe(ctx, level);
    const probed = this.probe.build();
    if (!probed) {
      console.warn('[props] no collider geometry to dress — level may still be a stub');
    }

    this.batcher = new Batcher(ctx.scene, level);
    this.placer = new Placer(this.probe, this.batcher, rng.fork(7));

    // 3 — prototypes
    this.protos = new Protos(this.batcher, this.mats, rng.fork(11)).build();
    const vehicles = [
      derelictPickup(rng.fork(1001)),
      derelictVan(rng.fork(1002)),
    ];

    const api = {
      ctx, rng: rng.fork(21), probe: this.probe, placer: this.placer,
      batcher: this.batcher, mats: this.mats, protos: this.protos, vehicles,
    };
    this.api = api;

    // 4 — reserve the canonical camera positions and the player spawn BEFORE
    //     anything is placed, so no prop can ever spawn inside the camera.
    const heroes = this._heroPoints();
    for (const h of heroes) this.probe.claim(h.x, h.z, CONFIG.cameraClear);
    for (const s of level.spawnPoints ?? []) this.probe.claim(s.x, s.z, CONFIG.spawnClear);

    // 5 — survey
    const { samples, anchors } = this._survey(level, heroes);

    // 6 — themed clusters
    const sites = this._chooseSites(samples, heroes, api.rng);
    for (const site of sites) {
      // Probes for this cluster start just above its own floor, so a depot on a
      // mezzanine is not silently snapped onto the roof over it.
      this.placer.floorHint = site.y + 1.7;
      THEMES[site.theme](api, site);
    }
    this.placer.floorHint = null;

    // 7 — fences and rails across open ground
    let fences = 0;
    for (const s of api.rng.shuffle(samples.slice())) {
      if (fences >= CONFIG.fenceRuns) break;
      if (s.wallDist < 5 || !this.probe.isFree(s.x, s.z, 3)) continue;
      const yaw = api.rng.range(0, Math.PI * 2);
      this.placer.floorHint = s.y + 1.7;
      fenceRun(api, s.x, s.z, yaw, api.rng.int(3, 6));
      this.placer.floorHint = null;
      fences++;
    }
    for (const s of api.rng.shuffle(samples.slice())) {
      if (!this.probe.isFree(s.x, s.z, 2.4)) continue;
      if (s.wallDist < 4 || !api.rng.bool(0.06)) continue;
      this.placer.put('guardrail_0', this.protos.get('guardrail_0'), {
        x: s.x, z: s.z, yaw: api.rng.range(0, Math.PI * 2),
        tilt: api.rng.jit(0.02), tiltDir: api.rng.range(0, 6.28),
        align: 0.8, tint: api.rng.range(0.88, 1.08), radius: 1.4, from: s.y + 1.7,
      });
      break;
    }

    // 8 — walls, ceilings, floor markings
    this.walls = new WallDresser(api);
    const wallStats = this.walls.run(anchors);
    const ceilStats = this.walls.ceilings(api.rng.shuffle(samples.slice()));
    const marks = this.walls.floorMarks(api.rng.shuffle(samples.slice()));

    // 9 — mid-ground cover and foreground framing at every canonical camera,
    //     then global litter. Cover goes first so it gets the good ground.
    let cover = 0;
    for (const h of heroes) {
      if (coverForCamera(api, h, (x, z, yaw) => sandbagWall(api, x, z, yaw))) cover++;
    }
    let fg = 0;
    for (const h of heroes) fg += foregroundRing(api, h, { count: h.primary ? 11 : 8 });
    const litter = scatterLitter(api, samples, { budget: CONFIG.litterBudget });
    const weeds = scatterWeeds(api, samples, { budget: CONFIG.weedBudget });
    // Tertiary clutter runs last so it can nestle against everything already
    // placed. It ignores occupancy on purpose — grit belongs at the foot of a
    // crate, not two metres away from it — but never enters a camera position.
    const clutter = scatterClutter(api, samples, {
      budget: CONFIG.clutterBudget, keepOut: heroes, keepOutRadius: CONFIG.cameraClear * 0.85,
    });

    // 9b — the open apron. Marks first (they are what a bare slab is actually
    //      missing), then streak litter and kerb drifts.
    const marksStats = groundMarks(api, samples, {
      tracks: CONFIG.tyreTracks, driftBudget: CONFIG.kerbDriftBudget,
    });
    const apron = apronClutter(api, samples, { budget: CONFIG.apronBudget });

    // 9b2 — GROUND INCIDENT. The marks pass above only ever draws four kinds of
    //       dark stain; a large pale slab needs value breaks in both directions,
    //       a high-frequency element to judge scale by, grit banked where grit
    //       actually collects, and something crossing it. All of it lands in the
    //       merged decal batch or on prototypes that already exist, so the whole
    //       pass costs no draw calls. See parts/GroundIncident.js.
    const incident = groundIncident(api, samples);

    // 9c — the distance band. Independent of everything above; it only needs the
    //      probe, and it lives entirely outside the level's own footprint.
    let backdrop = null;
    if (CONFIG.backdrop) {
      const b = this.probe.bounds;
      const inner = Math.min(150, Math.max(90,
        Math.max(Math.abs(b.min.x), Math.abs(b.max.x), Math.abs(b.min.z), Math.abs(b.max.z)) + 26));
      backdrop = buildBackdrop(
        { ...api, rng: rng.fork(4242) },
        { inner, baseY: this.probe.ground(0, 0)?.point.y ?? 0 },
      );
    }

    // 10 — THE CONTACT GUARANTEE. Two passes: every ground-flagged instance is
    //      re-seated against the real mesh or deleted, and then EVERY remaining
    //      instance that is not declared ATTACHED has to prove it is resting on
    //      the world or on the top of a prop that itself passed. That is what
    //      makes "no prop may float, ever" a property of the system rather than
    //      a thing somebody remembered to check. Must run before build().
    this.contact = new ContactPass(this.probe);
    const contactStats = this.contact.run(this.batcher);
    this.contact.audit(this.batcher);

    // 10a — THE FLOAT SWEEP. ContactPass exempts every ATTACHED instance by
    //       declaration and never sees merged geometry at all, so those two
    //       populations — 600-odd fixtures and every pipe, cable and sign — were
    //       simply never asked whether they are touching anything. This pass
    //       asks all of them, by raycast, and deletes what cannot answer.
    //       Must run before contactPatches so the patches sit under final
    //       transforms, and before build() so deletions are still cheap.
    this.floats = new FloatSweep(this.probe);
    const floatStats = this.floats.run(this.batcher, api);

    // 10a2 — THE WORLD FLOAT AUDIT. Everything above only ever looks at props.
    //        Four consecutive reviews reported floating rusted plates and three
    //        props agents fixed the props system; the plates stayed, because the
    //        offenders are LEVEL geometry and one of them is not even a collider
    //        (see props/LevelFloat.js for the pixel-level identification). This
    //        pass measures the world the same way the float sweep measures props
    //        and gives every unsupported island a visible tie. Must run before
    //        build() so the ties land in the existing merged batches.
    this.levelFloats = new LevelFloatPass(this.probe);
    const worldFloat = this.levelFloats.run(level, this.batcher, this.mats, rng.fork(8181), heroes);

    // 10a3 — PLACEHOLDER SANDBAG REPLACEMENT. The "smooth pale mass" the review
    //        keeps rejecting is not this system's sandbag kit: it is three
    //        squashed spheres per revetment in the level's courtyard, and an
    //        instance dump proved that ZERO of the 331 props sandbags are in the
    //        hero frame at all. Props cannot delete the spheres, but it can lay a
    //        real parapet of real bags over them. See parts/BagCap.js.
    const bagCap = capPlaceholderBags(api, this.levelFloats.islandsOfSurface(level, 'fabric'));

    // 10b — soft contact patches under the shadowless litter, now that every
    //       transform is final. One quad each, one shared merged batch.
    const patches = contactPatches(api, this.batcher);

    // 11 — resolve to GPU buffers
    const built = this.batcher.build();
    this.instanced = this.batcher.instanced;

    // 12 — local lighting on the fixtures nearest the hero framings
    this._lights = this.walls.makeLights(CONFIG.maxPointLights, heroes);
    this._glow = this.mats.get('glow');
    this._glowCold = this.mats.get('glow_cold');
    this._glowBase = this._glow.emissiveIntensity;
    this._glowColdBase = this._glowCold.emissiveIntensity;

    // 13 — let the level rebuild any acceleration structure now that props exist
    level.rebuildCollision?.();

    const p = this.placer.report();
    this.stats = {
      drawMeshes: built.instancedMeshes + built.mergedMeshes,
      instancedMeshes: built.instancedMeshes,
      mergedMeshes: built.mergedMeshes,
      instances: built.instances,
      triangles: built.triangles,
      samples: samples.length,
      wallAnchors: anchors.length,
      sites: sites.length,
      interiorSamples: samples.reduce((n, s) => n + (s.enclosure >= 0.6 ? 1 : 0), 0),
      placed: p.placed,
      rejectedFloating: p.floating,
      rejectedNoGround: p.noGround,
      rejectedOccupied: p.occupied,
      rejectedSteep: p.steep,
      rejectedBuried: p.buried,
      rejectedOverhang: p.overhang,
      litter, weeds, foreground: fg, marks, fences, cover,
      clutter: clutter.made, clutterKnots: clutter.knots,
      apron,
      tyreTracks: marksStats.tracks,
      scuffs: marksStats.scuffs,
      oilStains: marksStats.stains,
      kerbDrifts: marksStats.drifts,
      openSamples: marksStats.openSamples,
      ...incident,
      decalQuads: marksStats.quads + patches + incident.quads,
      contactPatches: patches,
      backdrop,
      contactChecked: contactStats.checked,
      contactReseated: contactStats.reseated,
      contactMoved: contactStats.moved,
      contactDropped: contactStats.dropped,
      contactWorstFloat: +contactStats.worstBefore.toFixed(3),
      contactWorstLeft: +contactStats.worstAfter.toFixed(4),
      contactLoose: contactStats.loose,
      contactOnWorld: contactStats.onWorld,
      contactOnProp: contactStats.onProp,
      contactOrphaned: contactStats.orphaned,
      contactExempt: contactStats.exempt,
      floatChecked: floatStats.checked,
      floatReseated: floatStats.reseated,
      floatAnchored: floatStats.anchored,
      floatDeleted: floatStats.deleted,
      floatMergedChecked: floatStats.mergedChecked,
      floatMergedDeleted: floatStats.mergedDeleted,
      floatGrounded: floatStats.grounded,
      floatHung: floatStats.hung,
      floatWorst: +floatStats.worstFloat.toFixed(3),
      floatWorstLeft: +floatStats.worstLeft.toFixed(4),
      worldIslands: worldFloat.clusters,
      worldSuspects: worldFloat.suspects,
      worldResting: worldFloat.resting,
      worldAttached: worldFloat.attached,
      worldBraced: worldFloat.braced,
      worldOrphaned: worldFloat.unbraceable,
      worldOverBudget: worldFloat.overBudget,
      bagCapRuns: bagCap.runs,
      bagCapBlobs: bagCap.blobs,
      bagCapBags: bagCap.bags,
      hessianFromForge: !!this.mats.hessianFromForge,
      ...wallStats, ...ceilStats,
      pointLights: this._lights.length,
      probeTriangles: this.probe.triangles ?? 0,
    };

    console.info(
      `[props] ${this.stats.placed} props + ${clutter.made + apron} clutter in `
      + `${this.stats.drawMeshes} draw meshes (${this.stats.instances} instances, `
      + `${(this.stats.triangles / 1000).toFixed(0)}k tris) — placement rejected `
      + `${this.stats.rejectedFloating} floating / ${this.stats.rejectedNoGround} unsupported; `
      + `hessian from ${this.stats.hessianFromForge ? 'forge' : 'local painter'}.`,
    );
    // The contact numbers are the verifiable part of the "nothing floats" claim,
    // so they are logged on their own line and in full.
    console.info(
      `[props] contact: re-seated ${contactStats.reseated}/${contactStats.checked} ground props `
      + `(${contactStats.moved} moved >4mm, worst float found ${contactStats.worstBefore.toFixed(3)}m, `
      + `worst left ${contactStats.worstAfter.toFixed(4)}m) · `
      + `audited ${contactStats.loose} non-ground instances: `
      + `${contactStats.onWorld} on the world, ${contactStats.onProp} on another prop, `
      + `${contactStats.orphaned} orphaned and deleted (${contactStats.exempt} declared ATTACHED) · `
      + `${contactStats.dropped} deleted in total · ${patches} contact patches drawn.`,
    );
    // The float sweep is the guarantee that covers what the contact pass exempts.
    // These four numbers are the proof it ran.
    console.info(
      `[props] float sweep: CHECKED ${floatStats.checked + floatStats.mergedChecked} loose props `
      + `(${floatStats.checked} instances + ${floatStats.mergedChecked} merged pieces) · `
      + `RESEATED ${floatStats.reseated} onto the surface beneath them · `
      + `DELETED ${floatStats.deleted + floatStats.mergedDeleted} as floating `
      + `(${floatStats.deleted} instances, ${floatStats.mergedDeleted} merged: `
      + `${this.floats.deletionSummary()}) · `
      + `${floatStats.grounded} resting, ${floatStats.anchored} bolted within `
      + `18cm of a surface, ${floatStats.hung} given visible drop rods. `
      + `Worst float found ${floatStats.worstFloat.toFixed(3)}m, worst left `
      + `${floatStats.worstLeft.toFixed(4)}m.`,
    );
    // The world float audit. These numbers are the answer to "why did three
    // rounds of props-side reseat passes not remove the floating plates".
    console.info(`[props] world float audit: ${this.levelFloats.summary()}.`);
    console.info(
      `[props] placeholder sandbags: found ${bagCap.blobs} level-authored bag blob(s) in `
      + `${bagCap.runs} parapet run(s) and laid ${bagCap.bags} real bags over them `
      + '(0 extra draw calls � existing sandbag prototypes).',
    );
    if (this.levelFloats.report.length) {
      console.info(`[props] world float audit — braced: ${this.levelFloats.report.join(' | ')}.`);
    }
    if (this.levelFloats.orphans.length) {
      console.warn(
        '[props] world float audit — LEVEL-OWNED geometry still floating with nothing in '
        + 'reach to fasten to (props cannot invent support that is not there): '
        + `${this.levelFloats.orphans.join(' | ')}.`,
      );
    }
    if (backdrop) {
      console.info(
        `[props] backdrop: ${backdrop.pylons} pylons, ${backdrop.tanks} tanks, `
        + `${backdrop.towers} water tower(s), ${backdrop.chimneys} chimneys, `
        + `${backdrop.sheds} sheds, ${backdrop.trees} treeline panels · `
        + `apron: ${marksStats.tracks} tyre tracks, ${marksStats.scuffs} scuffs, `
        + `${marksStats.stains} stains, ${marksStats.drifts} kerb drifts, ${apron} streak litter.`,
      );
    }
    console.info(
      `[props] ground incident over ${marksStats.openSamples} open-ground samples: `
      + `${incident.drifts} banked grit pieces in ${incident.gritWashes} drifts, `
      + `${incident.puddles} dried puddles, ${incident.cracks} crack nets, `
      + `${incident.blooms} dust blooms, ${incident.bayMarks} worn bay marks, `
      + `${incident.wallWash} wall-base washes, ${incident.oilPools} oil pools, `
      + `${incident.floorCables} floor cable runs — ${incident.quads} extra decal quads, `
      + `0 extra draw calls.`,
    );
    this._auditWorld(level);
  }

  /** Camera positions worth composing for: the shoot rig's, plus any ?pos=. */
  _heroPoints() {
    const pts = CONFIG.heroPoints.map((p, i) => ({ ...p, primary: i === 0 }));
    try {
      const params = new URLSearchParams(location.search);
      if (params.has('pos')) {
        const [x, y, z] = params.get('pos').split(',').map(Number);
        if ([x, y, z].every(Number.isFinite)) {
          const existing = pts.find((p) => Math.hypot(p.x - x, p.z - z) < 1.5);
          if (existing) existing.primary = true;
          else pts.push({ x, y, z, primary: true });
        }
      }
    } catch { /* no URL context — fine */ }
    return pts;
  }

  /**
   * Grid-probe the world for standable ground and note the nearest wall at each
   * sample. ~2000 down-rays plus ~8 lateral rays each; against the private BVH
   * that is a few milliseconds.
   */
  _survey(level, heroes) {
    const b = this.probe.bounds;
    const R = CONFIG.sampleRadius;
    const step = CONFIG.sampleStep;
    const minX = Math.max(b.min.x + 1, -R), maxX = Math.min(b.max.x - 1, R);
    const minZ = Math.max(b.min.z + 1, -R), maxZ = Math.min(b.max.z - 1, R);
    const samples = [];
    const anchorCells = new Map();
    const jitter = new Rand(CONFIG.seed ^ 0x5f3a);

    const column = [];
    for (let x = minX; x <= maxX; x += step) {
      for (let z = minZ; z <= maxZ; z += step) {
        const px = x + jitter.jit(step * 0.32);
        const pz = z + jitter.jit(step * 0.32);

        let skip = false;
        for (const s of level.spawnPoints ?? []) {
          if (Math.hypot(s.x - px, s.z - pz) < CONFIG.spawnClear * 0.6) { skip = true; break; }
        }
        if (skip) continue;

        // Walk the whole vertical stack: roof, upper floors, ground.
        this.probe.stack(px, pz, column);
        for (let i = 0; i < column.length; i++) {
          const hit = column[i];
          if (hit.normal.y < CONFIG.minSlope) continue;
          const above = i > 0 ? column[i - 1].point.y : Infinity;
          const headroom = above - hit.point.y;
          if (headroom < 2.05) continue;               // crawl space, not a floor
          const indoor = Number.isFinite(above) && headroom < 14;

          const w = this.probe.wall(px, hit.point.y + 1.1, pz, 7, 8, jitter.range(0, 0.6));
          samples.push({
            x: px, z: pz, y: hit.point.y, surface: hit.surface,
            level: i, indoor, headroom,
            wallDist: w ? w.distance : 99,
            wallPoint: w ? w.point : null,
            wallNormal: w ? w.normal : null,
            enclosure: w ? w.hits / w.rays : 0,
            wall: w,
          });

          if (w && w.distance < 2.6) {
            const key = `${Math.round(w.point.x / 2.4)},${Math.round(w.point.z / 2.4)},${i}`;
            if (!anchorCells.has(key)) {
              anchorCells.set(key, { point: w.point, normal: w.normal, y: hit.point.y, indoor });
            }
          }
        }
      }
    }
    void heroes;
    return { samples, anchors: [...anchorCells.values()] };
  }

  /** Pick well-separated cluster sites, biased toward the hero framings. */
  _chooseSites(samples, heroes, rng) {
    const sites = [];
    const tryAdd = (s, theme) => {
      for (const o of sites) {
        if (Math.hypot(o.x - s.x, o.z - s.z) < CONFIG.siteSeparation) return false;
      }
      let clear = true;
      for (const h of heroes) {
        if (Math.hypot(h.x - s.x, h.z - s.z) < 3.2) { clear = false; break; }
      }
      if (!clear) return false;
      const wallish = s.wallDist < 3.4;
      const chosen = theme ?? (wallish
        ? rng.pick(['depot', 'utility', 'utility', 'depot', 'construction'])
        : rng.pick(['checkpoint', 'wreck', 'construction', 'checkpoint', 'depot']));
      sites.push({
        x: s.x, z: s.z, y: s.y, theme: chosen,
        radius: rng.range(2.5, 4.3),
        wall: s.wall && s.wallDist < 3.4 ? s.wall : null,
        lineYaw: s.wallNormal && s.wallDist < 3.4
          ? Math.atan2(-s.wallNormal.z, s.wallNormal.x)
          : rng.range(0, Math.PI * 2),
      });
      return true;
    };

    // near-hero sites first so the canonical shots have mid-ground content
    const near = samples.filter((s) => heroes.some((h) => {
      const d = Math.hypot(h.x - s.x, h.z - s.z);
      return d > 5 && d < 17;
    }));
    rng.shuffle(near);
    for (const s of near) {
      if (sites.length >= CONFIG.heroSiteCount) break;
      tryAdd(s);
    }

    // Then the most enclosed ground we found — interiors read as abandoned sets
    // if only the exteriors get dressed, and an empty hall is the worst offender.
    const indoors = samples
      .filter((s) => s.enclosure >= 0.6)
      .sort((a, b) => b.enclosure - a.enclosure)
      .slice(0, 160);
    rng.shuffle(indoors);
    let added = 0;
    for (const s of indoors) {
      if (added >= CONFIG.interiorSiteCount) break;
      if (tryAdd(s, rng.pick(['depot', 'utility', 'depot', 'construction']))) added++;
    }
    const rest = rng.shuffle(samples.slice());
    for (const s of rest) {
      if (sites.length >= CONFIG.siteCount) break;
      tryAdd(s);
    }
    return sites;
  }

  /**
   * Post-build audit.
   *
   * The prop half of this used to re-probe every placement's bounding-box base.
   * That is now redundant AND weaker than what ContactPass already did: the
   * contact pass measures the real mesh footprint, corrects the transform and
   * deletes anything it cannot ground, so by the time we get here `floating` is
   * zero by construction and its own `worstAfter` is the honest residual.
   *
   * What remains is the advisory sweep over colliders the LEVEL contributed.
   * Those are not ours to move; flagging them is the whole point.
   */
  _auditWorld(level) {
    const box = new THREE.Box3();
    const cs = this.contact?.stats;
    const checked = cs?.checked ?? 0;
    const floatingProps = cs && cs.worstAfter > 0.01 ? 1 : 0;
    const worst = cs?.worstAfter ?? 0;

    // Advisory sweep over the level's own colliders. Only prop-sized objects
    // sitting near the floor are judged — walls, roofs and catwalks are supposed
    // to be off the ground, so flagging them would be noise.
    let foreignFloating = 0;
    const suspects = [];
    for (const child of level.colliders?.children ?? []) {
      if (!child.isMesh || child.isInstancedMesh) continue;
      if (child.name.startsWith('prop:')) continue;
      child.updateMatrixWorld(true);
      const geo = child.geometry;
      if (!geo?.attributes?.position) continue;
      if (!geo.boundingBox) geo.computeBoundingBox();
      box.copy(geo.boundingBox).applyMatrix4(child.matrixWorld);
      const size = box.getSize(new THREE.Vector3());
      if (Math.max(size.x, size.y, size.z) > 5) continue;
      const cx = (box.min.x + box.max.x) / 2;
      const cz = (box.min.z + box.max.z) / 2;
      const g = this.probe.ground(cx, cz, box.min.y - 0.02);
      if (!g) continue;
      const gap = box.min.y - g.point.y;
      if (gap > 0.01 && gap < 2.5) {
        foreignFloating++;
        if (suspects.length < 5) suspects.push(`${child.name || 'unnamed'}@${cx.toFixed(1)},${cz.toFixed(1)} gap ${gap.toFixed(2)}m`);
      }
    }

    this.stats.auditChecked = checked;
    this.stats.auditFloatingProps = floatingProps;
    this.stats.auditWorstGap = +worst.toFixed(3);
    this.stats.auditFloatingLevel = foreignFloating;
    if (floatingProps > 0) {
      console.warn(
        `[props] contact audit: ${floatingProps}/${checked} ground-placed props show a `
        + `>1cm gap (worst ${worst.toFixed(2)}m).`,
      );
    }
    if (foreignFloating > 0) {
      console.warn(
        `[props] contact audit (advisory): ${foreignFloating} prop-sized NON-PROP collider(s) `
        + `float above the floor — owned by the level system, not fixed here: ${suspects.join('; ')}`,
      );
    }
  }

  /**
   * Subtle life in the fixtures. Allocation-free: only scalar writes to existing
   * lights and to the two shared emissive materials.
   */
  update(dt) {
    if (!this._lights.length && !this._glow) return;
    this._t += dt;
    const t = this._t;
    for (let i = 0; i < this._lights.length; i++) {
      const L = this._lights[i];
      const s = L.seed;
      // two incommensurate sines plus a rare dropout reads as a tired ballast
      const wobble = 0.93 + 0.07 * Math.sin(t * (2.1 + s * 0.03) + s);
      const dip = Math.sin(t * 0.37 + s) > 0.985 ? 0.35 : 1;
      L.light.intensity = L.base * wobble * dip;
    }
    if (this._glow) {
      this._glow.emissiveIntensity = this._glowBase * (0.95 + 0.05 * Math.sin(t * 1.31));
      this._glowCold.emissiveIntensity = this._glowColdBase * (0.94 + 0.06 * Math.sin(t * 5.7 + 1.1));
    }
  }

  dispose() {
    for (const L of this._lights) {
      L.light.parent?.remove(L.light);
      L.light.dispose?.();
    }
    this._lights.length = 0;
    this.batcher?.dispose();
    this.probe?.dispose();
    this.mats?.dispose();
    this.instanced.clear();
  }
}
