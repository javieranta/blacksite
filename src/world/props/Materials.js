import * as THREE from 'three';
import { Textures } from './Textures.js';
import {
  makeSet, makeAtlas, cratePainters, drumPainters, buildSignAtlas,
  buildChainLink, buildFoliage, TILING,
} from './TexPainters.js';
import { buildTreeline, buildPlume, buildDecalAtlas } from './paint/Extras.js';
import { buildGrimeAtlas } from './paint/GrimeAtlas.js';
import { WEAVE_UV as SANDBAG_WEAVE_UV } from './parts/Sandbags.js';

/**
 * The prop material set. OWNER: props agent.
 *
 * Materials are built from the procedural foundry, then reconciled with
 * MaterialForge: the forge's albedo tint / surface classification is respected
 * where it exists, but the maps are ours so props stay fully textured no matter
 * what state the forge is in. Every material carries
 * `userData.surface` (a Constants.SURFACES key) so ballistics and impact FX can
 * classify a hit even when the forge does not know the material.
 */

const ATLAS = 1024;

export class PropMaterials {
  constructor(ctx) {
    this.ctx = ctx;
    this.tex = new Textures(ctx.renderer);
    /** @type {Map<string, THREE.Material>} */
    this.map = new Map();
    this.forge = ctx.get('forge');
    this._forgeNames = null;
    /** Texture clones we own and must dispose. */
    this._clones = [];
  }

  /** Pull the forge's colour/roughness intent if the named material exists. */
  _forgeTint(forgeName) {
    if (!this._forgeHas(forgeName)) return null;
    const m = this.forge?.get?.(forgeName);
    if (!m || !m.color) return null;
    return m.color;
  }

  /**
   * Does the forge genuinely own this name?
   *
   * `forge.get` falls back to concrete for anything it does not know, so asking
   * it for a material that does not exist yet silently returns a concrete slab.
   * Every request has to be gated on the name list instead.
   */
  _forgeHas(name) {
    if (!this.forge?.names) return false;
    if (!this._forgeNames) this._forgeNames = new Set(this.forge.names());
    return this._forgeNames.has(name);
  }

  /**
   * The forge's map set for `name`, re-scaled so one tile spans `spanM` metres
   * of the prop's own UV space.
   *
   * The forge bakes its repeats for the level's 2 m world-space UV projection;
   * prop geometry carries its own boxUV scale, so the maps have to be cloned at
   * a new repeat. Clones share the Source, so this costs a texture descriptor
   * and not one byte of VRAM.
   *
   * @param {string} name    forge material name
   * @param {number} uvPerM  the prop's boxUV scale, in UV units per metre
   * @returns {object|null}  { map, normalMap, roughnessMap, metalnessMap }
   */
  _forgeMaps(name, uvPerM) {
    if (!this._forgeHas(name)) return null;
    const src = this.forge.texture(name);
    if (!src?.map) return null;
    const spanM = this.forge.uvScale?.(name) ?? 0.25;
    // one tile should cover spanM metres = spanM * uvPerM UV units
    const repeat = 1 / Math.max(1e-3, spanM * uvPerM);
    const out = {};
    for (const [slot, tex] of Object.entries(src)) {
      if (!tex) continue;
      const c = tex.clone();
      c.repeat.set(repeat, repeat);
      c.wrapS = c.wrapT = THREE.RepeatWrapping;
      c.needsUpdate = true;
      this._clones.push(c);
      out[slot] = c;
    }
    return out;
  }

  _std(name, opts, surface, forgeName) {
    const m = new THREE.MeshStandardMaterial(opts);
    m.name = `prop_${name}`;
    m.userData.surface = surface;
    m.userData.forgeName = forgeName ?? null;
    const tint = forgeName ? this._forgeTint(forgeName) : null;
    if (tint && opts.map) {
      // Nudge our albedo toward the forge's intent without washing out the paint.
      m.color.copy(tint).lerp(new THREE.Color(0xffffff), 0.9);
    }
    this.map.set(name, m);
    return m;
  }

  build() {
    const T = this.tex;

    // --- containers: one 4x4 atlas covers every crate, case and box variant ---
    const crate = makeAtlas(T, ATLAS, cratePainters(), { normalStrength: 1.7, seed: 1201 });
    this._std('crate', {
      ...crate, roughness: 1, metalness: 1, normalScale: new THREE.Vector2(1.1, 1.1),
    }, 'wood', 'wood_plank');

    // --- drums: cylindrical wrap atlas (2x2) ---
    const drum = makeAtlas(T, 1024, drumPainters(), { normalStrength: 1.5, seed: 733, cols: 2 });
    this._std('drum', {
      ...drum, roughness: 1, metalness: 1, normalScale: new THREE.Vector2(1.0, 1.0),
    }, 'metal', 'metal_painted');

    // --- tiling surfaces ---
    const mk = (key, painter, size, surface, forgeName, extra = {}, normalStrength = 2.0) => {
      const set = makeSet(T, size, painter, { normalStrength, seed: key.length * 977 + size });
      return this._std(key, { ...set, roughness: 1, metalness: 1, ...extra }, surface, forgeName);
    };

    /*
     * HESSIAN. The forge owns a `hessian` bake (1969 px/m over a 26 cm tile,
     * i.e. 5 px per real jute thread) which is finer than anything the prop
     * foundry can paint, so ask for it by name and use its maps if they are
     * there. They are re-scaled to the sandbag's own boxUV in _forgeMaps, and
     * they are dropped into OUR MeshStandardMaterial rather than used through
     * forge.get(): the forge's material is world-space-projected and per-bag
     * instanceColor tinting has to survive, which is what puts the damp bags at
     * the foot of a wall a different colour from the bleached ones on top.
     * If the forge does not have it yet, the local painter stands in.
     */
    const forgeHessian = this._forgeMaps('hessian', SANDBAG_WEAVE_UV);
    if (forgeHessian) {
      this._std('hessian', {
        ...forgeHessian, roughness: 1, metalness: 1,
        normalScale: new THREE.Vector2(2.0, 2.0),
      }, 'fabric', 'hessian');
    } else {
      mk('hessian', TILING.hessian, 512, 'fabric', 'fabric', {
        normalScale: new THREE.Vector2(2.4, 2.4),
      }, 3.6);
    }
    this.hessianFromForge = !!forgeHessian;
    mk('burlap', TILING.burlap, 256, 'sand', 'fabric', { normalScale: new THREE.Vector2(1.4, 1.4) }, 2.6);
    mk('concrete', TILING.concrete, 512, 'concrete', 'concrete', { normalScale: new THREE.Vector2(0.9, 0.9) }, 1.2);
    mk('steel', TILING.steel, 512, 'metal', 'metal_painted', { normalScale: new THREE.Vector2(0.9, 0.9) }, 1.6);
    mk('rusty', TILING.rustyMetal, 512, 'metal', 'metal_rusted', { normalScale: new THREE.Vector2(1.5, 1.5) }, 2.6);
    mk('tarp', TILING.tarp, 512, 'fabric', 'fabric', {
      side: THREE.DoubleSide, normalScale: new THREE.Vector2(1.3, 1.3),
    }, 2.2);
    mk('vehicle', TILING.vehiclePaint, 512, 'metal', 'metal_painted', { normalScale: new THREE.Vector2(1.0, 1.0) }, 1.8);
    mk('tyre', TILING.tyre, 256, 'fabric', 'fabric', { normalScale: new THREE.Vector2(1.6, 1.6) }, 2.8);
    mk('rubble', TILING.rubble, 512, 'concrete', 'concrete', { normalScale: new THREE.Vector2(1.1, 1.1) }, 1.8);

    // --- signage: one transparent atlas, alpha-tested so it still shadows ---
    const signMap = buildSignAtlas(T, ATLAS);
    this._std('sign', {
      map: signMap, transparent: false, alphaTest: 0.45, roughness: 0.72, metalness: 0.05,
      side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    }, 'metal', 'metal_painted');

    // --- chain-link + foliage cut-outs ---
    const clMap = buildChainLink(T, 256);
    this._std('chainlink', {
      map: clMap, alphaMap: clMap, transparent: false, alphaTest: 0.42,
      roughness: 0.62, metalness: 0.75, side: THREE.DoubleSide, color: 0xb0b6bc,
    }, 'metal', 'metal_painted');

    const folMap = buildFoliage(T, 256);
    this._std('foliage', {
      map: folMap, alphaMap: folMap, transparent: false, alphaTest: 0.4,
      roughness: 0.95, metalness: 0, side: THREE.DoubleSide, color: 0xcfc7a0,
    }, 'fabric', 'fabric');

    // --- machinery trim + cable, both textured: an untextured secondary
    //     material is just as obvious as an untextured hero one ---------------
    mk('darkmetal', TILING.darkSteel, 512, 'metal', 'metal_painted', { normalScale: new THREE.Vector2(1.1, 1.1) }, 1.9);
    mk('rubber', TILING.cable, 256, 'fabric', 'fabric', { normalScale: new THREE.Vector2(1.5, 1.5) }, 2.4);

    // --- plain helpers (glass, glow) ----------------------------------------
    this._std('glass', {
      color: 0x9fb6bd, roughness: 0.12, metalness: 0.0, transparent: true, opacity: 0.42,
    }, 'glass', 'glass');

    const glow = this._std('glow', {
      color: 0x2a2a28, roughness: 0.35, metalness: 0.0,
      emissive: new THREE.Color(0xffd9a0), emissiveIntensity: 6.0,
    }, 'glass', 'glass');
    glow.toneMapped = true;

    const glowCold = this._std('glow_cold', {
      color: 0x2b2f31, roughness: 0.3, metalness: 0.0,
      emissive: new THREE.Color(0xcfe4ff), emissiveIntensity: 4.5,
    }, 'glass', 'glass');
    glowCold.toneMapped = true;

    /* --- the distance band ------------------------------------------------
     * Everything Backdrop.js builds sits 90-340 m out and is read through the
     * sky system's aerial perspective, so it needs almost no surface detail —
     * but "almost none" is not "none": the concrete and steel maps are shared
     * at a coarse tile so a silo still has form lines and a pylon still has a
     * value break along its leg. Three materials, three draw calls, no shadows.
     */
    this.variants('concrete', [{ key: 'far', color: 0xc4ccd4, roughness: 0.97, normal: 0.35 }]);
    this.variants('steel', [{ key: 'far', color: 0x99a3ad, roughness: 0.85, normal: 0.4 }]);

    const treeMap = buildTreeline(T, 1024, 256);
    this._std('treeline', {
      // NOTE: no alphaMap. three reads alphaMap from the GREEN channel, and a
      // dark green tree canopy has almost none, so an alphaMap here would
      // discard the whole billboard. The canvas already carries straight alpha
      // in `map`, which is what alphaTest tests.
      map: treeMap, transparent: false, alphaTest: 0.34,
      roughness: 0.99, metalness: 0, side: THREE.DoubleSide, color: 0x9aa48d,
    }, 'fabric', 'fabric');

    const plumeMap = buildPlume(T, 256);
    this._std('haze', {
      map: plumeMap, transparent: true, opacity: 0.42,
      depthWrite: false, roughness: 1, metalness: 0, side: THREE.DoubleSide,
      color: 0xdfe6ec,
    }, 'fabric', 'fabric');

    /* --- ground decals ----------------------------------------------------
     * Tyre tracks, scuffs, oil and — the load-bearing one — soft contact
     * patches under litter that is too small to be worth a shadow-cascade draw
     * call. One merged batch, one draw call, and several hundred pieces of
     * debris stop reading as though they hover.
     */
    const decalMap = buildDecalAtlas(T, 1024);
    this._std('decal', {
      map: decalMap, transparent: true, opacity: 1,
      depthWrite: false, roughness: 0.94, metalness: 0, side: THREE.FrontSide,
      polygonOffset: true, polygonOffsetFactor: -5, polygonOffsetUnits: -5,
      color: 0xffffff,
      /*
       * Every quad in the decal batch carries a flat colour (see
       * GroundDress.mergeQuads), so one atlas cell can be an oil pool, a damp
       * patch or a pale dust bloom without a second texture or a second draw
       * call. Nothing else is allowed into this batch — a geometry without a
       * `color` attribute would render black.
       */
      vertexColors: true,
    }, 'concrete', 'concrete');

    /* --- standing water ---------------------------------------------------
     * THE ONE THING THE DECAL BATCH CANNOT DO. Every ground mark in this system
     * shares one material at roughness 0.94, so a "puddle" could only ever be a
     * slightly bluer patch of matte concrete — which is why three rounds of
     * adding puddle decals did not produce anything a reviewer would call a
     * puddle. Water is not an albedo change, it is a ROUGHNESS change: near-zero
     * roughness over a dark base, so it picks up the sky and the sun and reads as
     * wet from any angle.
     *
     * Same atlas, same alpha shapes, one extra draw call for the whole level.
     */
    this._std('wet', {
      map: decalMap, transparent: true, opacity: 1,
      depthWrite: false, roughness: 0.05, metalness: 0.0, side: THREE.FrontSide,
      polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6,
      color: 0x20262c, vertexColors: true, envMapIntensity: 1.35,
    }, 'concrete', 'concrete_wet');

    /* --- the grime / AO multiply layer -------------------------------------
     * THE DEFECT IT EXISTS FOR
     *   "the bottom 30% of interior, the centre deck of combat and hud ... are
     *    uniform slabs carrying a noise grain and a couple of seam lines — no
     *    decals, no grime gradient at wall bases, no drainage staining".
     *
     * WHY IT CANNOT BE ANOTHER `decal` BATCH
     *   The decal material alpha-blends: inside a mark, the slab's own albedo,
     *   normal detail and grain are REPLACED in proportion to alpha. That is
     *   correct for a stain sitting on top of concrete and wrong for dirt,
     *   which is a modulation OF the concrete. It is also why the round-9 try
     *   at broad soft washes measured worse rather than better (see the note in
     *   parts/GroundIncident.slabIncident): a big soft alpha-blended cell lays a
     *   flat value over the detail it was supposed to enrich.
     *
     * THE BLEND
     *   premultiplied source, srcFactor = DST_COLOR, dstFactor = 1 - SRC_ALPHA:
     *
     *       out = dst * (a * rgb) + dst * (1 - a) = dst * mix(1, rgb, a)
     *
     *   This is the same resolution the impact system already uses for bullet
     *   holes (src/fx/impacts/DecalAtlas.js, "MULTIPLY tiles"), for the same
     *   reason stated there: "A lit quad pasted on top would flatten all of it."
     *
     *   i.e. a true tinted multiply with a per-fragment strength. Every bit of
     *   texture, normal shading and shadow underneath survives inside the mark,
     *   so a grime quad can be six metres across and still not read as a
     *   sticker. Destination alpha is explicitly left alone (ZERO/ONE) so the
     *   post chain's composite is unaffected.
     *
     * COST
     *   MeshBasicMaterial: no lights, no shadow lookups, one texture fetch. This
     *   is the cheapest fragment in the build, which is what makes a layer this
     *   large affordable at all — the same coverage in the lit decal material
     *   took the combat framing under 1 fps when it was tried.
     */
    const grimeMap = buildGrimeAtlas(T, 1024);
    const grime = new THREE.MeshBasicMaterial({
      map: grimeMap,
      transparent: true,
      premultipliedAlpha: true,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.DstColorFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
      depthWrite: false,
      side: THREE.FrontSide,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      vertexColors: true,
      /*
       * NO FOG. The fog chunk mixes the fragment toward the fog COLOUR, and this
       * fragment is a multiplier, not a radiance — fogging it would blend the
       * multiplier toward a bright grey and quietly darken the whole distance
       * band. Grime is only ever written inside the survey radius, where the
       * aerial perspective on the surface beneath it is doing that job already.
       */
      fog: false,
      toneMapped: false,
    });
    grime.name = 'prop_grime';
    grime.userData.surface = 'concrete';
    grime.userData.forgeName = null;
    this.map.set('grime', grime);

    return this;
  }

  get(name) {
    return this.map.get(name) ?? this.map.get('concrete');
  }

  /**
   * Register weathering variants of an existing material.
   *
   * The review's finding was that identical Jersey barriers and identical crates
   * are instanced with zero variation in wear. Per-instance colour (instanceColor)
   * can shift albedo but NOT roughness — one InstancedMesh is one roughness
   * value — so genuine wear variation needs more than one material. Cloning is
   * cheap here: a clone shares the parent's textures, so three variants cost
   * three draw calls and zero extra VRAM, and each gets its own albedo tint,
   * roughness and normal strength.
   *
   * @param {string} name   existing material key
   * @param {Array<{key:string, color?:number, roughness?:number, metalness?:number, normal?:number}>} specs
   * @returns {string[]} the new material keys, in order
   */
  variants(name, specs) {
    const src = this.map.get(name);
    if (!src) return [];
    const keys = [];
    for (const sp of specs) {
      const full = `${name}#${sp.key}`;
      if (this.map.has(full)) { keys.push(full); continue; }
      const m = src.clone();
      m.name = `prop_${full}`;
      m.userData.surface = src.userData.surface;
      m.userData.forgeName = src.userData.forgeName;
      if (sp.color != null) m.color.setHex(sp.color);
      if (sp.roughness != null) m.roughness = sp.roughness;
      if (sp.metalness != null) m.metalness = sp.metalness;
      if (sp.normal != null && m.normalScale) m.normalScale.setScalar(sp.normal);
      /*
       * Opt a variant into per-vertex albedo. three multiplies vertexColor and
       * instanceColor into the same diffuse term, so a family can carry BOTH
       * within-object weathering (baked into the geometry) and object-to-object
       * variation (per instance). ONLY set this on a variant whose every
       * geometry carries a `color` attribute — a missing attribute reads as
       * (0,0,0) and the prop renders black.
       */
      if (sp.vertex) m.vertexColors = true;
      this.map.set(full, m);
      keys.push(full);
    }
    return keys;
  }

  dispose() {
    for (const m of this.map.values()) m.dispose();
    for (const t of this._clones) t.dispose();
    this._clones.length = 0;
    this.map.clear();
    this.tex.dispose();
  }
}
