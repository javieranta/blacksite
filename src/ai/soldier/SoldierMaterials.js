import * as THREE from 'three';

/**
 * OWNER: ai agent.
 *
 * Procedural material set for the combatants. Nothing is downloaded: every map
 * is arithmetic baked into a DataTexture, same discipline as the level's
 * MaterialForge (which bakes *world* surfaces — soldier kit needs its own
 * painters: multi-tone camouflage, nylon webbing, phosphated gun steel).
 *
 * Four families -> four SkinnedMesh draw calls per combatant:
 *   fatigue  four-colour camouflage ripstop, sub-surface-ish soft roughness
 *   gear     black/olive nylon + moulded polymer (carrier, pouches, helmet, boots)
 *   steel    phosphate gun metal with wear on edges
 *   visor    smoked polycarbonate (goggles + optic glass)
 *
 * Every map wraps, so parts can scale their UVs freely without a visible seam.
 */

/* ------------------------------------------------------------------ noise --- */

function hash2(ix, iy, seed) {
  let h = Math.imul(ix | 0, 374761393) ^ Math.imul(iy | 0, 668265263) ^ Math.imul(seed | 0, 362437);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
const wrap = (a, b) => ((a % b) + b) % b;
const sm = (t) => t * t * (3 - 2 * t);
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const lerp = (a, b, t) => a + (b - a) * t;
const sstep = (e0, e1, x) => { const t = clamp01((x - e0) / (e1 - e0 || 1e-6)); return t * t * (3 - 2 * t); };

function vnoise(u, v, fx, fy, seed) {
  const x = u * fx, y = v * fy;
  const ix = Math.floor(x), iy = Math.floor(y);
  const sx = sm(x - ix), sy = sm(y - iy);
  const x0 = wrap(ix, fx), x1 = wrap(ix + 1, fx);
  const y0 = wrap(iy, fy), y1 = wrap(iy + 1, fy);
  return lerp(
    lerp(hash2(x0, y0, seed), hash2(x1, y0, seed), sx),
    lerp(hash2(x0, y1, seed), hash2(x1, y1, seed), sx),
    sy,
  );
}

function fbm(u, v, f, oct, seed, gain = 0.5) {
  let amp = 1, sum = 0, norm = 0, a = f;
  for (let i = 0; i < oct; i++) {
    sum += amp * vnoise(u, v, a, a, seed + i * 1013);
    norm += amp;
    amp *= gain;
    a = Math.max(1, Math.round(a * 2));
  }
  return sum / norm;
}

/* ----------------------------------------------------------------- bakers --- */

/**
 * Painters write, per texel: albedo rgb, a height value (for the normal map),
 * ao, roughness and metalness. Returned as three DataTextures.
 */
function bake(size, paint) {
  const alb = new Uint8Array(size * size * 4);
  const orm = new Uint8Array(size * size * 4);
  const hgt = new Float32Array(size * size);
  const px = { r: 0, g: 0, b: 0, h: 0.5, ao: 1, rough: 0.6, metal: 0 };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      px.r = px.g = px.b = 0.5; px.h = 0.5; px.ao = 1; px.rough = 0.6; px.metal = 0;
      paint(px, (x + 0.5) / size, (y + 0.5) / size);
      alb[i * 4] = clamp01(px.r) * 255;
      alb[i * 4 + 1] = clamp01(px.g) * 255;
      alb[i * 4 + 2] = clamp01(px.b) * 255;
      alb[i * 4 + 3] = 255;
      orm[i * 4] = clamp01(px.ao) * 255;
      orm[i * 4 + 1] = clamp01(px.rough) * 255;
      orm[i * 4 + 2] = clamp01(px.metal) * 255;
      orm[i * 4 + 3] = 255;
      hgt[i] = px.h;
    }
  }
  return { alb, orm, hgt };
}

function normalsFromHeight(h, size, strength) {
  const out = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const l = h[y * size + wrap(x - 1, size)], r = h[y * size + wrap(x + 1, size)];
      const d = h[wrap(y - 1, size) * size + x], u = h[wrap(y + 1, size) * size + x];
      let nx = (l - r) * strength, ny = (d - u) * strength, nz = 1;
      const inv = 1 / Math.hypot(nx, ny, nz);
      nx *= inv; ny *= inv; nz *= inv;
      const i = (y * size + x) * 4;
      out[i] = (nx * 0.5 + 0.5) * 255;
      out[i + 1] = (ny * 0.5 + 0.5) * 255;
      out[i + 2] = (nz * 0.5 + 0.5) * 255;
      out[i + 3] = 255;
    }
  }
  return out;
}

function tex(data, size, srgb) {
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

/* ---------------------------------------------------------------- painters -- */

/** Four-tone blotch camouflage with a ripstop weave underneath. */
/**
 * Palette.
 *
 * The first pass was a warm khaki/sand family, and photographed against this
 * level it was a mistake: the yard is pale warm concrete, so tan fatigues put
 * the soldiers at almost exactly the ground's value AND its hue, and the figures
 * dissolved into the deck. Value separation is not a post-process, it starts in
 * the albedo. Pulled roughly 25% darker and swung green-grey, so the men sit
 * clearly below and cool of everything they stand on, at every time of day. The
 * sand tone survives only as a sparse highlight — it is what stops the pattern
 * turning into a flat dark blob at range.
 */
const CAMO = [
  [0.186, 0.190, 0.152],   // olive drab base
  [0.118, 0.132, 0.104],   // deep olive
  [0.068, 0.078, 0.068],   // shadow green
  [0.246, 0.230, 0.178],   // sand highlight
  [0.046, 0.048, 0.046],   // near-black speckle
];

function paintFatigue(px, u, v) {
  // Two warped fbm fields thresholded into blotches — the standard way real
  // multi-tone patterns are generated, and it never repeats visibly. The base
  // frequency is deliberately low: the parts scale their UVs by ~2, so a blob
  // lands at roughly a hand's width on the body, which is what real DPM-family
  // patterns do. Small speckle alone reads as noise, not camouflage.
  const wu = u + (fbm(u, v, 2, 3, 71) - 0.5) * 0.20;
  const wv = v + (fbm(u, v, 2, 3, 907) - 0.5) * 0.20;
  const a = fbm(wu, wv, 2, 4, 11);
  const b = fbm(wu, wv, 4, 3, 523);
  let c = CAMO[0];
  if (a < 0.44) c = CAMO[1];
  if (a < 0.32) c = CAMO[2];
  // Sand is an accent, not a third of the garment: raised from 0.545 so the
  // light blotches stay sparse enough to read as pattern rather than base tone.
  if (a > 0.605 && b > 0.47) c = CAMO[3];
  const speck = fbm(u, v, 14, 2, 3313);
  const isSpeck = speck > 0.72 && b < 0.54;
  if (isSpeck) c = CAMO[4];

  // Ripstop: a 1x1 grid of reinforcing threads plus a fine plain weave.
  const wf = 148;
  const weave = Math.sin(u * wf * Math.PI * 2) * Math.sin(v * wf * Math.PI * 2);
  const rip = (Math.abs(((u * 34) % 1) - 0.5) < 0.055 || Math.abs(((v * 34) % 1) - 0.5) < 0.055) ? 1 : 0;
  const dust = fbm(u, v, 9, 3, 4441);
  const shade = 1 + weave * 0.045 + rip * 0.05 + (dust - 0.5) * 0.13;

  px.r = c[0] * shade; px.g = c[1] * shade; px.b = c[2] * shade;
  px.h = 0.5 + weave * 0.16 + rip * 0.34 + (dust - 0.5) * 0.1;
  px.rough = 0.80 + (1 - dust) * 0.12 - weave * 0.03;
  px.metal = 0.0;
  px.ao = 0.86 + weave * 0.05 + (dust - 0.5) * 0.09 - rip * 0.02;
}

/** Nylon webbing / cordura + moulded polymer: the carrier, pouches, helmet, boots. */
function paintGear(px, u, v) {
  const base = fbm(u, v, 5, 3, 617);
  // Coyote-brown cordura rather than black: kit that is a shade lighter and
  // warmer than the uniform is what separates a plate carrier from a torso at
  // 60 m. Solid black gear collapses the whole figure into one silhouette.
  const tone = 0.082 + base * 0.052;
  const weave = Math.abs(Math.sin(u * 96 * Math.PI)) * Math.abs(Math.sin(v * 96 * Math.PI));
  const cord = Math.sin((u * 62 + v * 8) * Math.PI * 2);   // cordura twill bias
  const scuff = sstep(0.62, 0.86, fbm(u, v, 12, 3, 8081));
  const grain = fbm(u, v, 40, 2, 2027);

  px.r = tone * (1 + cord * 0.12) * 1.22 + scuff * 0.055 + grain * 0.02;
  px.g = tone * (1 + cord * 0.10) * 1.02 + scuff * 0.05 + grain * 0.02;
  px.b = tone * (1 + cord * 0.10) * 0.70 + scuff * 0.030 + grain * 0.015;
  px.h = 0.5 + weave * 0.3 + cord * 0.1 + (grain - 0.5) * 0.14;
  px.rough = 0.62 + (1 - weave) * 0.2 - scuff * 0.22;
  px.metal = 0.02 + scuff * 0.05;
  px.ao = 0.82 + weave * 0.12 - scuff * 0.03;
}

/** Phosphate-finish gun steel: fine grain, machining marks, polished wear. */
function paintSteel(px, u, v) {
  const grain = fbm(u, v * 0.4, 34, 3, 991);
  const mach = Math.sin(v * 210 * Math.PI) * 0.5 + 0.5;
  const wear = sstep(0.58, 0.9, fbm(u, v, 8, 3, 7717));
  const pit = sstep(0.78, 0.94, fbm(u, v, 44, 2, 131));
  const tone = 0.052 + grain * 0.032 + wear * 0.10;
  px.r = tone; px.g = tone * 1.02; px.b = tone * 1.09;
  px.h = 0.5 + (grain - 0.5) * 0.3 + mach * 0.08 - pit * 0.5;
  px.rough = 0.56 - wear * 0.30 + (1 - grain) * 0.12 + pit * 0.2;
  px.metal = 0.86 + wear * 0.12;
  px.ao = 0.9 - pit * 0.25;
}

/* ------------------------------------------------------------------- rim --- */

/**
 * Silhouette separation.
 *
 * A soldier in dark khaki standing against pale concrete at 40 m is a grey
 * smudge: the albedo contrast is there but the *edge* is not, and an edge is what
 * the eye finds a threat by. Every shooter that reads well solves this the same
 * way — a view-dependent rim term that lights the grazing edge of the body
 * regardless of where the sun is, so the outline separates from whatever is
 * behind it.
 *
 * Implemented as an additive Fresnel injected into `totalEmissiveRadiance` after
 * `<aomap_fragment>`, which is the last point at which `geometryNormal` and
 * `geometryViewDir` are still in scope and before `outgoingLight` is summed.
 * Emissive rather than a light so it costs no shadow map, no light slot and no
 * per-enemy draw — one extra dot product and a pow in the fragment shader.
 *
 * The strength ramps *up* with distance: at 3 m a rim reads as cheap plastic, at
 * 40 m it is the only thing keeping the man visible. So near bodies get 30% and
 * distant ones the full term, which is also why this does not fight the
 * close-quarters critique.
 */
function applyRim(material, { colour, strength, power, near = 7, far = 44, minStrength = 0.30 }) {
  const u = {
    uRimColour: { value: new THREE.Color(colour) },
    uRimStrength: { value: strength },
    uRimPower: { value: power },
    uRimRange: { value: new THREE.Vector2(near, far) },
    uRimMin: { value: minStrength },
  };
  material.userData.rim = u;
  material.userData.rimBase = strength;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', `
        uniform vec3 uRimColour;
        uniform float uRimStrength;
        uniform float uRimPower;
        uniform vec2 uRimRange;
        uniform float uRimMin;
        void main() {`)
      .replace('#include <aomap_fragment>', `
        #include <aomap_fragment>
        {
          float rimF = 1.0 - abs( dot( geometryNormal, geometryViewDir ) );
          rimF = pow( clamp( rimF, 0.0, 1.0 ), uRimPower );
          float rimD = smoothstep( uRimRange.x, uRimRange.y, length( vViewPosition ) );
          totalEmissiveRadiance += uRimColour * ( rimF * uRimStrength * mix( uRimMin, 1.0, rimD ) );
        }`);
  };
  // Two materials that differ only in a uniform must not share a program cache
  // entry, and one that has been patched must never collide with one that has
  // not.
  material.customProgramCacheKey = () => `soldier-rim-${material.name}`;
  return material;
}

/**
 * Re-tune the rim for a time of day.
 *
 * The rim is an ABSOLUTE addition to `totalEmissiveRadiance`, so it is deaf to
 * both the light rig and the exposure — and the night preset moves both, hard,
 * in the same direction. Night carries a sky luminance of 0.0055 against
 * golden's 0.09 (16x darker) *and* opens the shutter to exposure 2.05 against
 * golden's 1.06 (2x brighter). A rim authored to be a subtle grazing edge at
 * golden hour therefore lands roughly thirty times hotter, relative to the
 * scene, at night — which is exactly what the night capture showed: figures
 * outlined in bright blue-white against surfaces sitting in near-black.
 *
 * So the strength is scaled by the actual radiance the figure is standing in,
 * then divided back out by the exposure the frame will be developed at. What was
 * a fixed number of nits becomes a fixed *ratio* to the scene, which is the only
 * definition of "a rim light" that survives a change of time of day.
 *
 * Called from EnemyAI on every `lighting:rig`.
 */
export function setRimEnvironment(materials, rig) {
  if (!rig) return 1;
  const lum = Math.max(1e-4, rig.skyLuminance ?? 0.09);
  const exposure = Math.max(0.05, rig.exposure ?? 1);
  // Reference point is the golden rig the rim was originally dialled in against.
  const rel = Math.pow(lum / 0.09, 0.55) * (1.06 / exposure);
  const k = Math.min(1.15, Math.max(0.06, rel));
  for (const name of ['fatigue', 'gear', 'steel']) {
    const m = materials[name];
    const u = m?.userData?.rim;
    if (u) u.uRimStrength.value = (m.userData.rimBase ?? u.uRimStrength.value) * k;
  }
  /**
   * The visor carries the same absolute-emissive problem — a lit lens on a man
   * standing in the dark — but it cannot simply be scaled to zero with the rig.
   * Smoked polycarbonate at roughness 0.10 has almost no diffuse response, so
   * with the emissive gone it renders as a pure black hole where the face is,
   * and a head with a hole in it is a worse artefact than a slightly hot lens.
   * A quarter of the term is kept as a floor, which is physically defensible as
   * the ambient the lens picks up off the wearer's own face.
   */
  if (materials.visor) {
    materials.visor.emissiveIntensity = 0.5 * (0.30 + 0.70 * Math.min(1, k * 1.4));
  }
  return k;
}

/* --------------------------------------------------------------- assembly --- */

const FAMILIES = {
  fatigue: { paint: paintFatigue, size: 256, normal: 1.5, extra: { roughness: 1, metalness: 1 } },
  gear:    { paint: paintGear,    size: 256, normal: 2.1, extra: { roughness: 1, metalness: 1 } },
  steel:   { paint: paintSteel,   size: 128, normal: 2.4, extra: { roughness: 1, metalness: 1, envMapIntensity: 1.35 } },
};

/**
 * Builds the shared material set. One instance is created for the whole squad —
 * all combatants share these materials and their textures.
 */
export function buildSoldierMaterials() {
  const t0 = performance.now();
  const out = {};
  const disposables = [];

  for (const [name, f] of Object.entries(FAMILIES)) {
    const { alb, orm, hgt } = bake(f.size, f.paint);
    const map = tex(alb, f.size, true);
    const nrm = tex(normalsFromHeight(hgt, f.size, f.normal), f.size, false);
    const ormT = tex(orm, f.size, false);
    disposables.push(map, nrm, ormT);
    const m = new THREE.MeshStandardMaterial({
      map, normalMap: nrm, aoMap: ormT, roughnessMap: ormT, metalnessMap: ormT,
      normalScale: new THREE.Vector2(1, 1),
      // Per-part albedo multipliers live in the geometry's colour attribute —
      // see KIT in SoldierRig.js. This is what buys a helmet, a plate carrier,
      // pouches, pads, gloves and boots six different values out of one texture
      // and one draw call.
      vertexColors: true,
      ...f.extra,
    });
    m.name = `soldier:${name}`;
    m.userData.surface = name === 'steel' ? 'metal' : 'fabric';
    // Cool sky-toned rim: it has to separate the figure at every time of day, so
    // it cannot be keyed to the sun's colour. Fabric takes a broad soft edge,
    // gun steel a tighter brighter one — the same split a real grazing highlight
    // makes between cloth and metal.
    applyRim(m, name === 'steel'
      ? { colour: 0xbcd0e4, strength: 0.85, power: 3.2 }
      : { colour: 0xa8bed6, strength: 0.62, power: 2.5 });
    out[name] = m;
  }

  // Smoked polycarbonate: goggle lens + optic glass. Opaque-but-dark reads far
  // better at distance than real transparency (no sort order, no depth fight)
  // and picks up a hard specular highlight from the sun, which is the whole
  // point of a visor in a silhouette.
  const visor = new THREE.MeshStandardMaterial({
    color: 0x0a0d11, roughness: 0.10, metalness: 0.34,
    emissive: 0x0a1a20, emissiveIntensity: 0.5, envMapIntensity: 2.1,
    vertexColors: true,
  });
  visor.name = 'soldier:visor';
  visor.userData.surface = 'glass';
  out.visor = visor;

  out.dispose = () => {
    for (const t of disposables) t.dispose();
    for (const k of ['fatigue', 'gear', 'steel', 'visor']) out[k]?.dispose();
  };
  out.bakeMs = Math.round(performance.now() - t0);
  return out;
}

export const MATERIAL_ORDER = ['fatigue', 'gear', 'steel', 'visor'];
