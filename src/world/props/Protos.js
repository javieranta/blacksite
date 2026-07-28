import * as C from './parts/Containers.js';
import * as B from './parts/Barriers.js';
import * as I from './parts/Industrial.js';
import * as D from './parts/Debris.js';
import * as K from './parts/Clutter.js';
import * as SB from './parts/Sandbags.js';
import { triCount } from './GeoUtil.js';

/**
 * Prototype registry. OWNER: props agent.
 *
 * Builds every instanced geometry variant once, up front, and files it under a
 * family name so the dressing passes can ask for "a crate" and get one of
 * several genuinely different meshes. Anything that will appear more than a
 * handful of times lives here and therefore costs exactly one draw call no
 * matter how many of them the level ends up holding.
 */

export class Protos {
  constructor(batcher, mats, rng) {
    this.batcher = batcher;
    this.mats = mats;
    this.rng = rng;
    this.geo = new Map();
    this.families = new Map();
    this.tris = 0;
  }

  add(family, key, geo, matName, opts = {}) {
    if (!geo || !geo.attributes?.position?.count) return null;
    geo.computeBoundingBox();
    this.batcher.proto(key, geo, this.mats.get(matName), opts);
    this.geo.set(key, geo);
    if (!this.families.has(family)) this.families.set(family, []);
    this.families.get(family).push(key);
    this.tris += triCount(geo);
    return key;
  }

  get(key) { return this.geo.get(key); }
  family(name) { return this.families.get(name) ?? []; }
  pick(name, rng) {
    const list = this.family(name);
    return list.length ? list[(rng.next() * list.length) | 0] : null;
  }

  /** Build the whole library. */
  build() {
    const r = this.rng;
    const S = { solid: true, castShadow: true, receiveShadow: true };
    const LITTER = { solid: false, castShadow: false, receiveShadow: true };
    const DECOR = { solid: false, castShadow: true, receiveShadow: true };

    /* ------------------------------------------------------------ variants
     * Three weathering states each for concrete and timber. Assigning a
     * DIFFERENT material to each geometry variant means the variety is free:
     * the family already resolved to N InstancedMeshes, so N materials cost
     * exactly the same N draw calls but no longer look stamped from one mould.
     */
    const CV = this.mats.variants('concrete', [
      { key: 'bare', color: 0xe9e7e1 },
      { key: 'bleached', color: 0xfff8e6, roughness: 0.93, normal: 0.78 },
      { key: 'dirty', color: 0xb4afa2, normal: 1.25 },
    ]);
    const KV = this.mats.variants('crate', [
      { key: 'dry', color: 0xfff4de },
      { key: 'weathered', color: 0xd6cbb4, normal: 1.35 },
      { key: 'damp', color: 0xb3a996, roughness: 0.9, normal: 1.15 },
    ]);
    const RV = this.mats.variants('rubble', [
      { key: 'pale', color: 0xeeece5 },
      { key: 'grey', color: 0xc6c2b8 },
      { key: 'stained', color: 0xa89f8f, normal: 1.2 },
    ]);
    const cv = (i) => CV[i % CV.length] ?? 'concrete';
    const kv = (i) => KV[i % KV.length] ?? 'crate';
    const rv = (i) => RV[i % RV.length] ?? 'rubble';

    /* ------------------------------------------------------- containers */
    // Proto counts are unchanged from before the variant work: the variety is
    // bought with materials and per-instance colour, NOT with more meshes. A
    // solid proto costs one draw in the main pass plus one in every shadow
    // cascade, so five of them is 25 draws — too expensive to spend on wear.
    for (let i = 0; i < 3; i++) this.add('crate', `crate_${i}`, C.timberCrate(r.fork(10 + i)), kv(i), S);
    for (let i = 0; i < 2; i++) this.add('case', `case_${i}`, C.transitCase(r.fork(20 + i)), kv(i + 1), S);
    for (let i = 0; i < 2; i++) this.add('ammo', `ammo_${i}`, C.ammoBox(r.fork(30 + i)), kv(i), S);
    this.add('plasticCrate', 'pcrate_0', C.plasticCrate(r.fork(40)), kv(0), S);
    this.add('plasticCrate', 'pcrate_1', C.plasticCrate(r.fork(41)), kv(2), S);
    for (let i = 0; i < 2; i++) this.add('card', `card_${i}`, C.cardboardBox(r.fork(50 + i)), 'crate', S);
    for (let i = 0; i < 2; i++) this.add('pallet', `pallet_${i}`, C.pallet(r.fork(60 + i)), 'crate', S);
    for (let i = 0; i < 4; i++) this.add('drum', `drum_${i}`, C.oilDrum(r.fork(70 + i)), 'drum', S);
    this.add('jerry', 'jerry_0', C.jerryCan(r.fork(80)), 'crate', S);
    this.add('spool', 'spool_0', C.cableSpool(r.fork(90)), 'crate', S);
    for (let i = 0; i < 2; i++) {
      this.add('tarp', `tarp_${i}`, C.tarpDrape(r.fork(100 + i), {
        w: 1.5 + i * 0.5, d: 1.2 + i * 0.4, h: 0.9 + i * 0.25,
      }), 'tarp', S);
    }
    for (let i = 0; i < 2; i++) this.add('bundle', `bundle_${i}`, C.bundle(r.fork(110 + i)), 'tarp', DECOR);

    /* --------------------------------------------------------- barriers */
    for (let i = 0; i < 3; i++) {
      this.add('jersey', `jersey_${i}`, B.jerseyBarrier(r.fork(120 + i), { length: 1.88 + i * 0.24 }), cv(i), S);
    }
    this.add('chevron', 'chevron_0', B.barrierChevron(r.fork(130), 2.0), 'sign', LITTER);

    /* ------------------------------------------------------------ sandbags
     * Three genuinely different pillow forms, one hessian material. The old
     * squashed icosphere is gone; see parts/Sandbags.js for why the
     * cross-section, not the triangle count, is what makes these read.
     */
    /*
     * One material per bag form. The family already resolves to three
     * InstancedMeshes, so three materials cost exactly the same three draw calls
     * — and each can then carry its own albedo tint and normal strength, which
     * instanceColor cannot do. All three enable vertexColors because every
     * geometry sandbagBag returns carries the baked dust/damp attribute; the
     * merged sandbagHeap does NOT (mergeAll strips colours), so `sacks_0` below
     * stays on the plain hessian material.
     */
    const HV = this.mats.variants('hessian', [
      { key: 'dry', color: 0xfff4e2, normal: 2.0, vertex: true },
      { key: 'worn', color: 0xece2ce, normal: 2.4, vertex: true },
      { key: 'damp', color: 0xd2c9b5, normal: 2.2, vertex: true },
    ]);
    this.bagKeys = [];
    for (let i = 0; i < SB.BAG_VARIANTS; i++) {
      const k = this.add('sandbag', `sandbag_${i}`, SB.sandbagBag(r.fork(140 + i), i),
        HV[i] ?? 'hessian', S);
      if (k) this.bagKeys.push(k);
    }
    /** Pre-authored wall modules, laid out once so every wall interlocks. */
    this.wallModules = SB.buildWallModules(r.fork(146));

    for (let i = 0; i < 2; i++) {
      const h = B.hesco(r.fork(150 + i));
      this.add('hescoFill', `hesco_${i}`, h.fill, rv(i), S);
      this.add('hescoCage', `hescocage_${i}`, B.hescoCage(h.size.w, h.size.h), 'steel', DECOR);
    }
    for (let i = 0; i < 2; i++) this.add('cinder', `cinder_${i}`, B.cinderBlock(r.fork(160 + i)), cv(i * 2), S);
    for (let i = 0; i < 2; i++) this.add('brick', `brick_${i}`, B.brickStack(r.fork(170 + i)), rv(i), S);
    this.add('guardrail', 'guardrail_0', B.guardRail(r.fork(180), 3.2), 'steel', S);
    this.add('fencePost', 'fencepost_0', B.fencePost(r.fork(190), 2.1), 'steel', S);
    this.add('fenceRail', 'fencerail_0', B.fenceRail(2.4), 'steel', DECOR);
    for (let i = 0; i < 2; i++) {
      this.add('chainPanel', `chainpanel_${i}`, B.chainPanel(r.fork(200 + i), 2.4, 2.0), 'chainlink',
        { solid: false, castShadow: false, receiveShadow: false });
    }

    /* ------------------------------------------------------- industrial */
    for (let i = 0; i < 2; i++) {
      const h = I.hvacUnit(r.fork(210 + i));
      this.add('hvacSteel', `hvac_${i}`, h.steel, 'steel', S);
      this.add('hvacDark', `hvacdark_${i}`, h.dark, 'darkmetal', DECOR);
    }
    const gen = I.generator(r.fork(220));
    this.add('genSteel', 'gen_0', gen.steel, 'steel', S);
    this.add('genDark', 'gendark_0', gen.dark, 'darkmetal', DECOR);
    for (let i = 0; i < 2; i++) this.add('bottle', `bottle_${i}`, I.gasBottle(r.fork(230 + i)), 'steel', S);
    this.add('ladder', 'ladder_0', I.ladder(r.fork(240), 3.2), 'steel', S);
    this.add('duct', 'duct_0', I.ductRun(r.fork(250), 3.6), 'steel', DECOR);
    this.add('pipeBracket', 'pbracket_0', I.pipeBracket(0.06), 'steel', DECOR);
    this.add('junction', 'junction_0', I.junctionBox(r.fork(260)), 'darkmetal', DECOR);
    const vent = I.wallVent(r.fork(270));
    this.add('ventFrame', 'vent_0', vent.frame, 'steel', DECOR);
    this.add('ventFace', 'ventface_0', vent.face, 'sign', LITTER);

    // scaffolding kit — fixed lengths so it can be instanced hard
    this.add('tube200', 'tube200', I.scaffoldTube(2.0), 'steel', DECOR);
    this.add('tube240', 'tube240', I.scaffoldTube(2.4), 'steel', DECOR);
    this.add('tube140', 'tube140', I.scaffoldTube(1.4), 'steel', DECOR);
    this.add('tube280', 'tube280', I.scaffoldTube(2.8), 'steel', DECOR);
    this.add('plank', 'plank240', I.scaffoldPlank(r.fork(280), 2.4), 'crate', S);
    this.add('clamp', 'clamp_0', I.scaffoldClamp(), 'darkmetal', { solid: false, castShadow: false, receiveShadow: true });

    // lighting
    const lamp = I.wallLamp(r.fork(290));
    this.add('lampHousing', 'lamp_0', lamp.housing, 'steel', DECOR);
    this.add('lampLens', 'lamplens_0', lamp.lens, 'glow', LITTER);
    const flood = I.floodHead(r.fork(300));
    this.add('floodHousing', 'flood_0', flood.housing, 'steel', DECOR);
    this.add('floodLens', 'floodlens_0', flood.lens, 'glow', LITTER);
    const strip = I.stripLight(r.fork(310), 1.3);
    this.add('stripHousing', 'strip_0', strip.housing, 'steel', DECOR);
    this.add('stripLens', 'striplens_0', strip.lens, 'glow_cold', LITTER);
    this.add('mast', 'mast_0', I.lampMast(r.fork(320), 4.4), 'steel', S);

    /* ----------------------------------------------------------- debris */
    for (let i = 0; i < 4; i++) {
      this.add('rubble', `rubble_${i}`, D.rubbleChunk(r.fork(330 + i), 0.3 + i * 0.22), rv(i),
        i > 1 ? S : LITTER);
    }
    for (let i = 0; i < 2; i++) this.add('gravel', `gravel_${i}`, D.gravelPile(r.fork(340 + i)), rv(i + 1), LITTER);
    for (let i = 0; i < 2; i++) this.add('plankShard', `pshard_${i}`, D.plankShard(r.fork(350 + i)), kv(i), LITTER);
    for (let i = 0; i < 2; i++) this.add('scrap', `scrap_${i}`, D.metalScrap(r.fork(360 + i)), 'rusty', LITTER);
    for (let i = 0; i < 2; i++) this.add('tyre', `tyre_${i}`, D.tyre(r.fork(370 + i)), 'tyre', DECOR);
    this.add('bucket', 'bucket_0', D.bucket(r.fork(380)), 'steel', DECOR);
    for (let i = 0; i < 2; i++) this.add('offcut', `offcut_${i}`, D.pipeOffcut(r.fork(390 + i)), 'steel', LITTER);
    this.add('coil', 'coil_0', D.wireCoil(r.fork(400)), 'rubber', LITTER);
    for (let i = 0; i < 3; i++) this.add('weed', `weed_${i}`, D.weedTuft(r.fork(410 + i)), 'foliage', LITTER);
    for (let i = 0; i < 2; i++) this.add('paper', `paper_${i}`, D.paperScrap(r.fork(420 + i)), kv(i), LITTER);
    this.add('trash', 'trash_0', D.trashBag(r.fork(430)), 'rubber', DECOR);
    this.add('sacks', 'sacks_0', SB.sandbagHeap(r.fork(440)), 'hessian', S);
    this.add('board', 'board_0', D.leaningBoard(r.fork(450)), kv(1), DECOR);

    /* ------------------------------------------------------ tertiary clutter
     * The third tier of set dressing: grit, cans, card, snapped battens, bolt
     * spill. Everything here is castShadow:false on purpose — see Clutter.js.
     * These families are what the scatterClutter pass draws from, 1500-odd
     * instances across the level for about a dozen extra draw calls.
     */
    for (let i = 0; i < 2; i++) this.add('grit', `grit_${i}`, K.pebbleScatter(r.fork(500 + i)), rv(i), LITTER);
    for (let i = 0; i < 2; i++) this.add('drift', `drift_${i}`, K.fineDrift(r.fork(510 + i)), rv(i + 1), LITTER);
    for (let i = 0; i < 3; i++) this.add('chip', `chip_${i}`, K.concreteChip(r.fork(520 + i)), rv(i), LITTER);
    this.add('brickbit', 'brickbit_0', K.brickFragment(r.fork(530)), rv(2), LITTER);
    for (let i = 0; i < 2; i++) this.add('can', `can_${i}`, K.crushedCan(r.fork(540 + i)), 'rusty', LITTER);
    this.add('bolts', 'bolts_0', K.boltSpill(r.fork(550)), 'steel', LITTER);
    this.add('strap', 'strap_0', K.strapLoop(r.fork(560)), 'steel', LITTER);
    for (let i = 0; i < 2; i++) this.add('wirebit', `wirebit_${i}`, K.wireOffcut(r.fork(570 + i)), 'rubber', LITTER);
    for (let i = 0; i < 2; i++) this.add('batten', `batten_${i}`, K.battenBreak(r.fork(580 + i)), kv(i), LITTER);
    for (let i = 0; i < 2; i++) this.add('cardflat', `flatcard_${i}`, K.flatCard(r.fork(590 + i)), kv(i + 1), LITTER);
    for (let i = 0; i < 2; i++) this.add('papers', `papers_${i}`, K.paperDrift(r.fork(600 + i)), kv(0), LITTER);
    this.add('rag', 'rag_0', K.ragCloth(r.fork(610)), 'tarp', LITTER);
    this.add('bottleLitter', 'blitter_0', K.bottleLitter(r.fork(620)), kv(0), LITTER);
    this.add('marker', 'marker_0', K.markerSleeve(r.fork(630)), 'sign', LITTER);

    return this;
  }
}
