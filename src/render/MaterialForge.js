import * as THREE from 'three';
import { bakeFamily, bakeDetailNormal, SIZES, TILE_M } from './material/TextureBake.js';
import { patchSurface } from './material/SurfaceShader.js';
import { CLASSES, RECIPES, ALIASES } from './material/Recipes.js';

/**
 * OWNER: material-forge agent.
 * CONTRACT — other systems only ever call:
 *   forge.get(name)            -> THREE.Material (cached, shared)
 *   forge.texture(name)        -> { map, normalMap, roughnessMap, metalnessMap, aoMap }
 *   forge.surfaceOf(material)  -> surface key from Constants.SURFACES
 *   forge.uvScale(name)        -> metres the tile spans at the level's default
 *                                2 m UV projection (for texel-density matching)
 *   forge.names()              -> every material name, frozen set first
 *
 * Everything is generated procedurally — wrapped value/voronoi fields baked to
 * DataTextures in render/material/ — so there is not one downloaded byte in the
 * material library.
 *
 * ## How a material is built
 *
 * Each *family* bakes albedo + tangent-space normal + a packed ORM texture
 * (R=AO, G=roughness, B=metalness). That packing is the glTF convention and is
 * exactly the channel layout three samples for aoMap / roughnessMap /
 * metalnessMap, so one upload drives all three slots. `roughness` and
 * `metalness` stay at 1.0 on purpose: three multiplies the scalar by the map
 * channel, so 1.0 hands full authority to the texture.
 *
 * Each *material* then picks a family, a UV scale and a shader-layer profile.
 * Several materials share one bake — a Jersey barrier and a 40 m cooling tower
 * can draw from the same painter and still not sample the same frequency,
 * because the UV scale differs. That is the whole point of the split.
 *
 * ## Texel density
 *
 * The level projects UVs in world space at `tile` metres per repeat
 * (GeoKit.projectUV, default 2 m). A material's `repeat` is therefore
 * `2 / tileMetres / uvMul`, which makes the baked tile span exactly
 * `tileMetres * uvMul` metres wherever the level used the default projection —
 * and lets the level's own per-geometry `tile` act as a deliberate per-asset
 * multiplier on top. Every floor family lands between 256 and 274 px/m so
 * adjacent ground surfaces no longer look like two different games.
 */

export class MaterialForge {
  constructor() {
    this.name = 'forge';
    /** @type {Map<string, THREE.Material>} */
    this.materials = new Map();
    /** @type {Map<string, object>} */
    this.textures = new Map();
    /** @type {Map<string, number>} */
    this.scales = new Map();
    this._surface = new WeakMap();
    this._baked = new Map();
    this._clones = [];
    this._detail = null;
  }

  init(ctx) {
    this.ctx = ctx;
    // The bake is CPU-bound, so the lower quality presets take a smaller set:
    // halving the edge quarters the work and the VRAM.
    const rs = ctx?.quality?.resolutionScale ?? 1;
    const scale = rs >= 0.95 ? 1 : rs >= 0.8 ? 0.75 : 0.5;
    // Floor of 4. three clamps the request to the hardware maximum at upload, so
    // asking for more than the device has is free — whereas *under*-asking (a
    // headless or software context that reports 1) reintroduces exactly the
    // grazing-angle speckle the Toksvig chain exists to remove.
    const aniso = Math.max(4, Math.min(16, ctx?.renderer?.capabilities?.getMaxAnisotropy?.() ?? 8));
    const t0 = performance.now();

    this._detail = bakeDetailNormal(this._size('detail', scale), aniso);

    for (const [name, recipe] of Object.entries(RECIPES)) {
      this._build(name, recipe, scale, aniso);
    }
    // Aliases share the target's material instance outright — no second upload,
    // no second program, and `surfaceOf` still answers correctly.
    for (const [alias, target] of Object.entries(ALIASES)) {
      const m = this.materials.get(target);
      if (!m) continue;
      this.materials.set(alias, m);
      this.textures.set(alias, this.textures.get(target));
      this.scales.set(alias, this.scales.get(target));
    }

    // `mip |N|` is the average normal length four levels down the chain. It is
    // the number the roughness regularisation runs on: 1.00 would mean the
    // family has no high-frequency normal content at all, and anything under
    // ~0.90 is a family that would sparkle without the Toksvig compensation.
    const lens = [...this._baked.entries()]
      .map(([k, s]) => `${k} ${s.normalLen.toFixed(3)}`).join(', ');
    console.info(
      `[forge] ${this.materials.size} materials from ${this._baked.size + 1} procedural`
      + ` bakes in ${Math.round(performance.now() - t0)}ms`
      + ` (detail field ${this._detail.size}² @ ${TILE_M.detail} m, ${this._detail.mips} mips,`
      + ` aniso ${aniso}) — mip |N|: ${lens}`,
    );
  }

  _size(family, scale) {
    const base = SIZES[family] ?? 512;
    if (scale >= 1) return base;
    return Math.max(128, Math.round((base * scale) / 32) * 32);
  }

  /** Families are cached, so two materials sharing a painter share the upload. */
  _bake(family, scale, aniso) {
    let set = this._baked.get(family);
    if (!set) {
      set = bakeFamily(family, this._size(family, scale), aniso);
      this._baked.set(family, set);
    }
    return set;
  }

  /**
   * Clone a family's maps so this material can carry its own repeat. Clones
   * share the underlying `Source`, so three uploads the pixels exactly once —
   * the clone costs a descriptor, not a texture.
   */
  _mapsAt(set, repeat) {
    if (Math.abs(repeat - 1) < 1e-4) {
      return { map: set.map, normalMap: set.normalMap, orm: set.orm };
    }
    const out = {};
    for (const k of ['map', 'normalMap', 'orm']) {
      const c = set[k].clone();
      c.repeat.set(repeat, repeat);
      c.needsUpdate = true;
      this._clones.push(c);
      out[k] = c;
    }
    return out;
  }

  _build(name, recipe, scale, aniso) {
    const { family, surface, uv = 1, cls = 'concrete', colour, extra } = recipe;
    const set = this._bake(family, scale, aniso);
    const spec = CLASSES[cls] ?? CLASSES.concrete;

    // repeat maps the baked tile onto `TILE_M * uv` metres of world surface,
    // given the level's default 2 m UV projection.
    const spanM = set.tile * uv;
    const repeat = 2 / spanM;
    const maps = this._mapsAt(set, repeat);

    const Ctor = spec.physical ? THREE.MeshPhysicalMaterial : THREE.MeshStandardMaterial;
    const m = new Ctor({
      map: maps.map,
      normalMap: maps.normalMap,
      // One packed texture, three slots — three reads .r / .g / .b respectively.
      aoMap: maps.orm,
      roughnessMap: maps.orm,
      metalnessMap: maps.orm,
      roughness: 1.0,
      metalness: 1.0,
      normalScale: new THREE.Vector2(spec.normalScale, spec.normalScale),
      ...(spec.material ?? {}),
      ...(extra ?? {}),
    });
    if (colour !== undefined) m.color.setHex(colour);
    m.name = name;
    m.userData.surface = surface;
    m.userData.spanM = spanM;

    patchSurface(m, {
      ...spec.shader,
      detail: spec.shader.detail
        ? { map: this._detail.normalMap, ...spec.shader.detail }
        : null,
    });

    this.materials.set(name, m);
    this.scales.set(name, spanM);
    this.textures.set(name, {
      map: maps.map, normalMap: maps.normalMap,
      roughnessMap: maps.orm, metalnessMap: maps.orm, aoMap: maps.orm,
    });
    this._surface.set(m, surface);
  }

  get(name) {
    return this.materials.get(name) ?? this.materials.get('concrete');
  }

  /** The raw map set, for anyone who wants to build their own material. */
  texture(name) {
    return this.textures.get(name) ?? this.textures.get('concrete');
  }

  /** Metres of world surface one texture tile covers. */
  uvScale(name) {
    return this.scales.get(name) ?? 4;
  }

  names() {
    return [...this.materials.keys()];
  }

  surfaceOf(material) {
    if (!material) return 'concrete';
    return material.userData?.surface ?? this._surface.get(material) ?? 'concrete';
  }

  dispose() {
    // Aliases share instances, so dedupe before disposing.
    for (const m of new Set(this.materials.values())) m.dispose();
    for (const c of this._clones) c.dispose();
    for (const set of this._baked.values()) {
      set.map.dispose(); set.normalMap.dispose(); set.orm.dispose();
    }
    this._detail?.normalMap.dispose();
    this.materials.clear();
    this.textures.clear();
    this.scales.clear();
    this._clones.length = 0;
    this._baked.clear();
  }
}
