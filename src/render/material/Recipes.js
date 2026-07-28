import * as THREE from 'three';

/**
 * OWNER: material-forge agent.
 *
 * The material library's declaration layer: what each name is made of, how big
 * its tile is in the world, and which shader-layer profile it wears.
 *
 * ## Frozen names
 * `concrete concrete_wet metal_painted metal_rusted wood_plank dirt sand glass
 * fabric plaster asphalt` are load-bearing for the rest of the codebase and must
 * always resolve. Everything else is an *additive* variant: a consumer that asks
 * for `concrete_tower` instead of `concrete` gets a surface authored for a 40 m
 * radius instead of a 3 m wall panel, and one that asks for `concrete_barrier`
 * gets a cast unit with no panel joints on it.
 *
 * ## uv
 * A multiplier on the family's authored tile size. `uv: 1.7` on a 3.5 m poured
 * tile means the pattern spans 6 m of wall — 3 m form panels rather than
 * 1.75 m ones. This is the knob that stops a Jersey barrier and a cooling tower
 * sampling the same frequency.
 */

/* ------------------------------------------------------------- shader class - */

/**
 * A class bundles the three-material type, the normal-map gain and the
 * world-space shader layers. Anything omitted falls back to SurfaceShader's
 * DEFAULTS, so a class only states what it changes.
 */
export const CLASSES = {
  /** Vertical cast concrete: full ledge run-off, crevice grime, dust on ledges. */
  concrete: {
    normalScale: 1.05,
    shader: {
      detail: { tiling: 0.25, strength: 0.78, near: 7, far: 20 },
      macro: [1 / 26, 0.15, 1 / 6.9, 0.10],
      grime: [0.62, 3.6, 0.13, 0.34],
      rough: [0.16, 0.12, 0.05],
      far: [18, 62, 0.30],
      roughFloor: 0.30,
      grimeColour: 0x2b2823,
      dustColour: 0xa8a39a,
    },
  },

  /** Big-radius shells — towers, silos, chimneys. Broader macro drift, more dust. */
  shell: {
    normalScale: 1.0,
    shader: {
      detail: { tiling: 0.25, strength: 0.62, near: 7, far: 19 },
      macro: [1 / 48, 0.17, 1 / 11.0, 0.09],
      grime: [0.70, 4.4, 0.16, 0.30],
      rough: [0.16, 0.14, 0.05],
      // A cooling tower is first read at 60 m and last read at 200 m, so its
      // distance band starts further out and pushes harder than a wall's.
      far: [26, 130, 0.34],
      roughFloor: 0.30,
      grimeColour: 0x282722,
      dustColour: 0xa5a099,
    },
  },

  /** Horizontal cast concrete: pads, aprons, copings. No wall streaking. */
  slab: {
    normalScale: 1.0,
    shader: {
      detail: { tiling: 0.25, strength: 0.80, near: 8, far: 22 },
      macro: [1 / 30, 0.17, 1 / 7.3, 0.11],
      grime: [0.18, 3.6, 0.10, 0.30],
      rough: [0.14, 0.08, 0.05],
      far: [18, 62, 0.24],
      roughFloor: 0.30,
      grimeColour: 0x2a2822,
      dustColour: 0xa9a49b,
    },
  },

  /** The same slab, wet: world-space pools, so puddles never tile. */
  slab_wet: {
    normalScale: 0.9,
    shader: {
      detail: { tiling: 0.25, strength: 0.58, near: 7, far: 20 },
      macro: [1 / 30, 0.15, 1 / 7.3, 0.10],
      grime: [0.16, 3.6, 0.05, 0.26],
      rough: [0.12, 0.06, 0.03],
      wet: [0.92, 1 / 3.4],
      far: [18, 62, 0.22],
      roughFloor: 0.10,
      grimeColour: 0x24241f,
      dustColour: 0x9d9a94,
    },
  },

  /** Painted interior finishes. Little rain, plenty of crevice and ledge dust. */
  interior: {
    normalScale: 0.85,
    shader: {
      detail: { tiling: 0.25, strength: 0.50, near: 7, far: 20 },
      macro: [1 / 18, 0.13, 1 / 5.1, 0.08],
      grime: [0.26, 3.2, 0.20, 0.44],
      rough: [0.14, 0.08, 0.06],
      far: [16, 55, 0.22],
      roughFloor: 0.28,
      grimeColour: 0x2e2b26,
      dustColour: 0xb0aca2,
    },
  },

  /** Bituminous surfacing: 30 m macro mask, prime-ratio break, no wall streaks. */
  asphalt: {
    normalScale: 1.15,
    shader: {
      detail: { tiling: 0.14, strength: 0.68, near: 8, far: 22 },
      macro: [1 / 30, 0.20, 1 / 9.3, 0.13],
      grime: [0.10, 3.6, 0.07, 0.28],
      rough: [0.12, 0.05, 0.06],
      far: [16, 70, 0.20],
      roughFloor: 0.28,
      grimeColour: 0x1e1d1b,
      dustColour: 0x8e8a82,
    },
  },

  /** Loose ground — terrain, spoil, sand. */
  ground: {
    normalScale: 1.15,
    shader: {
      detail: { tiling: 0.30, strength: 0.85, near: 9, far: 24 },
      macro: [1 / 34, 0.19, 1 / 8.1, 0.12],
      grime: [0.0, 3.6, 0.0, 0.22],
      rough: [0.08, 0.0, 0.0],
      far: [16, 80, 0.18],
      roughFloor: 0.42,
      grimeColour: 0x2a2419,
      dustColour: 0xa79878,
    },
  },

  /**
   * Industrial paint over steel. A dielectric with a clearcoat, so the specular
   * lobe gives a handrail a length-wise gradient instead of reading as flat
   * grey card, and a rust layer masked by crevice + up-facing + run-off so the
   * corrosion appears where water actually sits.
   */
  paint: {
    physical: true,
    normalScale: 0.95,
    material: {
      clearcoat: 0.34, clearcoatRoughness: 0.40,
      anisotropy: 0.22, envMapIntensity: 1.15,
    },
    shader: {
      detail: { tiling: 0.10, strength: 0.24, near: 5, far: 15 },
      macro: [1 / 12, 0.13, 1 / 3.7, 0.09],
      grime: [0.42, 3.0, 0.12, 0.30],
      rough: [0.14, 0.10, 0.06],
      rust: [0.44, 1.40, 0.52, 0.82],
      far: [14, 55, 0.20],
      roughFloor: 0.24,
      specAA: 0.90,
      rustColour: 0x67432c,
      grimeColour: 0x24221e,
      dustColour: 0x9c9890,
    },
  },

  /** Galvanised / mill-finish steel: metalness 1, roughness 0.22-0.45, aligned. */
  bare: {
    physical: true,
    normalScale: 0.80,
    material: { anisotropy: 0.50, envMapIntensity: 1.35 },
    shader: {
      detail: { tiling: 0.10, strength: 0.18, near: 5, far: 14 },
      macro: [1 / 10, 0.10, 1 / 3.1, 0.07],
      grime: [0.30, 3.0, 0.10, 0.26],
      rough: [0.10, 0.08, 0.05],
      rust: [0.66, 1.05, 0.40, 0.66],
      far: [12, 50, 0.18],
      // Galvanised steel is the worst offender in the whole library: a narrow
      // lobe over a spangle-crystal normal. It gets the strongest regularisation.
      roughFloor: 0.26,
      specAA: 1.05,
      rustColour: 0x66452f,
      grimeColour: 0x26241f,
      dustColour: 0x9e9a92,
    },
  },

  /** Corroded steel — the bake carries the oxide, the shader grows it. */
  rusted: {
    physical: true,
    normalScale: 1.30,
    material: { anisotropy: 0.26, envMapIntensity: 1.05 },
    shader: {
      detail: { tiling: 0.11, strength: 0.30, near: 5, far: 16 },
      macro: [1 / 9, 0.15, 1 / 2.9, 0.11],
      grime: [0.36, 3.0, 0.10, 0.24],
      rough: [0.10, 0.08, 0.04],
      rust: [0.58, 1.10, 0.42, 0.72],
      far: [12, 50, 0.22],
      roughFloor: 0.26,
      specAA: 0.95,
      rustColour: 0x6a4733,
      grimeColour: 0x241f1a,
      dustColour: 0x9a9188,
    },
  },

  /** Timber. */
  wood: {
    normalScale: 1.15,
    shader: {
      detail: { tiling: 0.18, strength: 0.40, near: 6, far: 18 },
      macro: [1 / 14, 0.14, 1 / 4.3, 0.10],
      grime: [0.34, 3.2, 0.14, 0.30],
      rough: [0.12, 0.10, 0.05],
      far: [14, 50, 0.22],
      roughFloor: 0.32,
      grimeColour: 0x2a231b,
      dustColour: 0xa39a8c,
    },
  },

  /**
   * Glazing. Transmissive-looking without a transmission pass: metalness 0,
   * IOR 1.5, a low roughness band and a strong env contribution give real
   * reflections, while a Fresnel term drives per-fragment opacity so the pane
   * goes near-mirror at grazing incidence. Per-pane state (clean / filthy /
   * boarded) is a world-space cell hash.
   */
  glass: {
    physical: true,
    normalScale: 0.32,
    material: {
      metalness: 0.0,
      ior: 1.5,
      specularIntensity: 1.0,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
      // Down from 1.5: the parallax-corrected reflection in GLASS_ENV is now the
      // dominant specular term, and leaving the infinite-cube path at full
      // strength on top of it just re-flattens the facade.
      envMapIntensity: 0.45,
      // No clearcoat. A second smooth lobe over glass adds a broad uniform
      // sheen — precisely the "flat pale sheet" this material is being fixed for.
      clearcoat: 0.0,
    },
    shader: {
      hasAO: false,
      // [base opacity, filth opacity, pane width m, pane height m]
      glass: [0.085, 0.40, 1.15, 1.25],
      glassRefl: 1.55,
      macro: [1 / 9, 0.09, 1 / 2.9, 0.06],
      grime: [0.34, 3.4, 0.0, 0.0],
      roughFloor: 0.045,
      specAA: 0.30,
      dustColour: 0x8d9096,
    },
  },

  /** Coated PP tarpaulin — sheen gives the grazing-angle lift a sheet has. */
  fabric: {
    physical: true,
    normalScale: 1.30,
    material: {
      sheen: 0.45, sheenRoughness: 0.85, sheenColor: 0xb9b0a0,
      side: THREE.DoubleSide, envMapIntensity: 0.9,
    },
    shader: {
      detail: { tiling: 0.12, strength: 0.22, near: 5, far: 14 },
      macro: [1 / 8, 0.14, 1 / 2.7, 0.10],
      grime: [0.24, 3.0, 0.12, 0.24],
      rough: [0.08, 0.05, 0.03],
      far: [12, 40, 0.16],
      roughFloor: 0.45,
      grimeColour: 0x272219,
      dustColour: 0xa09786,
    },
  },

  /**
   * Hessian sacking.
   *
   * Standard, not physical, and that is the point: no clearcoat, no sheen, no
   * anisotropy. Jute has no specular lobe worth modelling, and every one of
   * those terms was contributing to the plastic look. The environment
   * contribution is dropped to 0.45 for the same reason — a sandbag under a
   * bright sky should pick up bounce, not gloss.
   *
   * The shared stone detail-normal is switched off (`detail: null`): the weave
   * in the bake *is* the micro-relief, and laying 12 mm aggregate over cloth is
   * how the surface stopped reading as cloth. Dust weight is the highest in the
   * library, because a bag that has sat in a yard collects it on top.
   */
  hessian: {
    normalScale: 1.42,
    material: { envMapIntensity: 0.45 },
    shader: {
      detail: null,
      macro: [1 / 6.5, 0.17, 1 / 2.1, 0.13],
      grime: [0.20, 2.6, 0.46, 0.30],
      rough: [0.05, 0.03, 0.02],
      far: [10, 38, 0.18],
      roughFloor: 0.72,
      specAA: 0.45,
      grimeColour: 0x2b2519,
      dustColour: 0xbeb49d,
    },
  },
};

/* ---------------------------------------------------------------- materials - */

/**
 * name -> { family, surface, uv, cls, colour?, extra? }
 *
 * `surface` must be a key of Constants.SURFACES — it drives impact FX, decals,
 * ballistic penetration and footstep audio, so a new variant of concrete still
 * reports `concrete`.
 */
export const RECIPES = {
  // ---- frozen names
  concrete:      { family: 'precast',       surface: 'concrete', uv: 1.0,  cls: 'concrete' },
  // Same family and span as `concrete`, so the world-locked joint grid runs
  // straight through a wet pad into the dry one beside it; only the water differs.
  concrete_wet:  { family: 'precast',       surface: 'concrete', uv: 1.0,  cls: 'slab_wet' },
  metal_painted: { family: 'metal_painted', surface: 'metal',    uv: 1.0,  cls: 'paint' },
  metal_rusted:  { family: 'metal_rusted',  surface: 'metal',    uv: 1.0,  cls: 'rusted' },
  wood_plank:    { family: 'wood_plank',    surface: 'wood',     uv: 1.0,  cls: 'wood' },
  dirt:          { family: 'dirt',          surface: 'dirt',     uv: 1.0,  cls: 'ground' },
  sand:          { family: 'sand',          surface: 'sand',     uv: 1.0,  cls: 'ground' },
  glass:         { family: 'glass',         surface: 'glass',    uv: 1.0,  cls: 'glass' },
  // `fabric` is the frozen name the level uses for sacks and bagged goods, so it
  // resolves to hessian, not to the coated tarpaulin weave it used to get. A
  // tarpaulin now has its own name below.
  fabric:        { family: 'hessian',       surface: 'fabric',   uv: 1.0,  cls: 'hessian' },
  plaster:       { family: 'interior',      surface: 'concrete', uv: 0.92, cls: 'interior',
    colour: 0xfffaf0 },
  asphalt:       { family: 'asphalt',       surface: 'concrete', uv: 1.0,  cls: 'asphalt' },

  // ---- concrete by asset class (additive; see the report for adoption notes)
  /** Architectural cladding, 2 m panels — the default. */
  concrete_precast:  { family: 'precast', surface: 'concrete', uv: 1.0,  cls: 'concrete' },
  /** Large façades: 3 m panels so a 20 m elevation reads at the right scale. */
  concrete_panel:    { family: 'precast', surface: 'concrete', uv: 1.5,  cls: 'concrete' },
  /** Board-formed in-situ walls: lift lines and a 583 mm form-tie grid. */
  concrete_poured:   { family: 'poured',  surface: 'concrete', uv: 1.0,  cls: 'concrete' },
  /** Cooling towers, silos, chimneys — 6 m form panels, darker than the sky. */
  concrete_tower:    { family: 'poured',  surface: 'concrete', uv: 1.7,  cls: 'shell',
    colour: 0xe2e5e6 },
  /** Cast units with no panel grid: barriers, kerbs, copings, plinths. */
  concrete_unit:     { family: 'unit',    surface: 'concrete', uv: 1.0,  cls: 'slab' },
  /** Small units — a 1.7 m tile keeps a Jersey barrier off a wall's frequency. */
  concrete_barrier:  { family: 'unit',    surface: 'concrete', uv: 0.85, cls: 'slab' },
  /** Paving pads and aprons, float finished. */
  concrete_pad:      { family: 'unit',    surface: 'concrete', uv: 1.3,  cls: 'slab' },
  /** Soffits and ceiling slabs: board-formed, tight tile, dust on the ledges. */
  concrete_ceiling:  { family: 'poured',  surface: 'concrete', uv: 0.8,  cls: 'interior' },
  /** Painted interior walls — brighter, flatter, no rain streaking. */
  concrete_interior: { family: 'interior', surface: 'concrete', uv: 1.0, cls: 'interior',
    colour: 0xf0f2f4 },

  // ---- ground
  /** Older, more polished surfacing for secondary yards. */
  asphalt_worn:  { family: 'asphalt', surface: 'concrete', uv: 1.35, cls: 'asphalt',
    colour: 0xfafcff },

  // ---- metal
  /** Galvanised handrail / grating steel: bright, directional, barely rusted. */
  metal_galv:    { family: 'metal_bare', surface: 'metal', uv: 1.0, cls: 'bare',
    colour: 0xf6f9ff },
  /** Mill-finish structural steel — coarser grain for bigger sections. */
  metal_steel:   { family: 'metal_bare', surface: 'metal', uv: 1.5, cls: 'bare' },

  // ---- cloth
  /**
   * Sandbags. A tighter tile than `fabric` puts the thread pitch at 2.3 mm,
   * which is what a filled hessian sack measures at arm's length.
   * The props agent owns the bag meshes and currently bakes its own `hessian`
   * texture set; `forge.get('hessian')` is here for it to adopt.
   */
  hessian:       { family: 'hessian', surface: 'fabric', uv: 0.85, cls: 'hessian' },
  /** Bulk sacking and bagged goods — a looser weave over a bigger form. */
  sacking:       { family: 'hessian', surface: 'fabric', uv: 1.35, cls: 'hessian' },
  /** Coated polypropylene sheet: tarps, debris netting, covers. */
  tarpaulin:     { family: 'fabric',  surface: 'fabric', uv: 1.0,  cls: 'fabric' },
};

/** Extra names that resolve to an existing material instance. */
export const ALIASES = {
  concrete_wall: 'concrete',
  concrete_slab: 'concrete_pad',
  metal: 'metal_painted',
  concrete_dry: 'concrete',
};
