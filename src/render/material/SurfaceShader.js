import * as THREE from 'three';

/**
 * OWNER: material-forge agent.
 *
 * Everything a baked tile physically cannot know, injected into the standard
 * three lit shader with `onBeforeCompile`:
 *
 *  1. **Close-range detail normal.** One shared 0.5 mm/texel field sampled in
 *     world space at ~0.25 m, blended on top of the family's own normal and
 *     faded out with distance so it adds grain up close without shimmering at
 *     range. This is the term that stops a 200 px/m wall going smooth and
 *     plastic when the camera is a metre from it.
 *
 *  2. **Tile break.** Two world-space value-noise fields — one macro (tens of
 *     metres, the tonal drift of a big pour) and one at a prime-ratio scale to
 *     the tile itself — multiply the albedo. A repeat you can still find but no
 *     longer *read* is the goal.
 *
 *  3. **Ledge-driven run-off.** Grime is not a texture property, it is a
 *     function of where water goes. Streaks are seeded per vertical column and
 *     hang *below* each storey line, only on faces whose world normal is near
 *     vertical; pale dust settles on up-facing faces; the baked AO channel
 *     doubles as a crevice mask so dirt collects in joints and pits.
 *
 *  4. **Optional layers.** A wet/pooling term (world-space, so puddles do not
 *     tile), a rust layer masked by crevice + up-facing + run-off for metals,
 *     and a glazing model with Fresnel-driven opacity and per-pane state.
 *
 * The world-space triplanar frame reconstructed here deliberately mirrors
 * `GeoKit.projectUV`'s dominant-axis projection, so injected detail lands in the
 * same UV space as the baked maps and the two agree about which way is "up".
 */

/* --------------------------------------------------------------- GLSL bits --- */

const NOISE = /* glsl */`
float fwHash(vec2 p) {
  p = fract(p * vec2(443.8975, 441.4232));
  p += dot(p, p + 19.19);
  return fract(p.x * p.y);
}
float fwNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(fwHash(i), fwHash(i + vec2(1.0, 0.0)), f.x),
             mix(fwHash(i + vec2(0.0, 1.0)), fwHash(i + vec2(1.0, 1.0)), f.x), f.y);
}
`;

const VERT_PARS = /* glsl */`
varying vec3 vFwPos;
varying vec3 vFwNrm;
varying vec2 vFwUV;
varying vec3 vFwT;
varying vec3 vFwB;
`;

/**
 * The dominant-axis choice is made *per vertex*, exactly as GeoKit.projectUV
 * does it, and interpolated. Branching per fragment instead would make the UV
 * discontinuous across the 45° boundary, and the derivative spike that produces
 * shows up as a blurred seam ring around every pipe and tower.
 */
const VERT_BODY = /* glsl */`
  vFwPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
  vFwNrm = normalize(mat3(modelMatrix) * objectNormal);
  vec3 fwA = abs(vFwNrm);
  if (fwA.y >= fwA.x && fwA.y >= fwA.z) {
    vFwUV = vFwPos.xz; vFwT = vec3(1.0, 0.0, 0.0); vFwB = vec3(0.0, 0.0, 1.0);
  } else if (fwA.x >= fwA.z) {
    vFwUV = vFwPos.zy; vFwT = vec3(0.0, 0.0, 1.0); vFwB = vec3(0.0, 1.0, 0.0);
  } else {
    vFwUV = vFwPos.xy; vFwT = vec3(1.0, 0.0, 0.0); vFwB = vec3(0.0, 1.0, 0.0);
  }
`;

/** Shared frame + masks. Declared in main()'s scope so later blocks can reuse. */
const FRAME = /* glsl */`
  vec2 fwUV = vFwUV;
  vec3 fwT = normalize(vFwT), fwB = normalize(vFwB);
  float fwDist = length(cameraPosition - vFwPos);
  float fwUp = clamp(vFwNrm.y, 0.0, 1.0);
  // Vertical faces streak; soffits and undersides do not.
  float fwWall = (1.0 - smoothstep(0.30, 0.72, fwUp))
               * (1.0 - smoothstep(-0.30, -0.72, vFwNrm.y));
  float fwMac = fwNoise(fwUV * uFwMacro.x) * 0.62 + fwNoise(fwUV * uFwMacro.x * 2.7 + 11.3) * 0.38;
  float fwBrk = fwNoise(fwUV * uFwMacro.z + 47.1) * 0.68 + fwNoise(fwUV * uFwMacro.z * 3.1 + 7.7) * 0.32;
`;

/** Run-off / dust / crevice masks. `fwCrev` needs the baked AO channel. */
const GRIME_MASK = (hasAO) => /* glsl */`
  float fwSy = vFwPos.y / uFwGrime.y;
  float fwBand = floor(fwSy);
  float fwAxis = (vFwPos.x + vFwPos.z) * 0.7071;
  float fwCol = fwNoise(vec2(fwAxis * 2.7, fwBand * 13.0));
  float fwColW = fwNoise(vec2(fwAxis * 0.75, fwBand * 5.0));
  float fwStreak = smoothstep(0.38, 0.90, fwCol * 0.62 + fwColW * 0.48)
                 * exp(-(1.0 - fract(fwSy)) * 3.1) * fwWall;
  float fwDust = fwUp * fwUp * (0.30 + 0.70 * fwNoise(fwUV * 0.55 + 3.7));
  float fwCrev = ${hasAO ? '1.0 - texture2D( aoMap, vAoMapUv ).r' : '0.0'};
`;

/**
 * Distance compensation. A base map's mip chain *must* flatten with range —
 * that is what a mip chain is for — so past ~20 m a wall is running on albedo
 * variation the texture no longer carries and it collapses toward flat grey.
 * These two world-space bands are analytic, so they do not flatten: a 2.4 m and
 * a 0.9 m feature keep their contrast at 60 m, which is the scale at which a
 * concrete elevation reads as cast panels rather than a painted card.
 */
const FAR_APPLY = /* glsl */`
  float fwFar = smoothstep(uFwFar.x, uFwFar.y, fwDist);
  float fwPanel = fwNoise(fwUV * 0.42 + 19.7) * 0.60 + fwNoise(fwUV * 1.15 + 5.3) * 0.40;
  diffuseColor.rgb *= 1.0 + (fwPanel - 0.5) * uFwFar.z * fwFar;
`;

const GRIME_APPLY = /* glsl */`
  diffuseColor.rgb *= 1.0 + (fwMac - 0.5) * uFwMacro.y + (fwBrk - 0.5) * uFwMacro.w;
  float fwGrime = clamp(fwStreak * uFwGrime.x + fwCrev * uFwGrime.w, 0.0, 1.0);
  diffuseColor.rgb = mix(diffuseColor.rgb, uFwGrimeCol * (0.72 + 0.56 * fwMac), fwGrime);
  diffuseColor.rgb = mix(diffuseColor.rgb, uFwDustCol, clamp(fwDust * uFwGrime.z, 0.0, 1.0));
`;

const WET_APPLY = /* glsl */`
  float fwPool = smoothstep(0.40, 0.80,
      fwNoise(fwUV * uFwWet.y) * 0.64 + fwNoise(fwUV * uFwWet.y * 2.3 + 5.1) * 0.36);
  float fwWet = fwPool * uFwWet.x * (0.30 + 0.70 * fwUp);
  diffuseColor.rgb *= 1.0 - fwWet * 0.40;
`;

const RUST_APPLY = /* glsl */`
  float fwRust = clamp(fwCrev * uFwRust.y + fwUp * uFwRust.z + fwStreak * uFwRust.w - uFwRust.x, 0.0, 1.0);
  fwRust *= smoothstep(0.30, 0.78, fwNoise(fwUV * 1.9 + 3.3) * 0.7 + fwBrk * 0.4);
  diffuseColor.rgb = mix(diffuseColor.rgb, uFwRustCol * (0.68 + 0.64 * fwBrk), fwRust);
`;

/**
 * Glazing.
 *
 * The failure this replaces: a facade of panes that all sampled the same
 * infinitely-distant environment, at the same low opacity, with the same grime,
 * reads as one flat pale-blue sheet — which is exactly what it looked like.
 * Three things break that up.
 *
 *  1. **Four pane states, not two.** clean / filthy / cracked / missing, hashed
 *     per world-space cell. A missing pane is the important one: it is a dark
 *     opening with a real interior behind it, and one hole in a grid of twenty
 *     destroys the "printed sheet" reading instantly.
 *  2. **Grime is world-space, not pane-space.** The film runs across cell
 *     borders and down the elevation, because rain does.
 *  3. **A box-projected reflection** (see GLASS_ENV) so each pane looks at a
 *     *different* part of the environment.
 *
 * `transmission` is deliberately not used. three implements it with a full extra
 * scene render into a transmission target every frame; at this scene's 750-draw
 * budget that is a second frame's worth of work for five window boxes. Fresnel
 * opacity plus a parallax-corrected reflection buys the same read for a handful
 * of ALU.
 */
const GLASS_APPLY = /* glsl */`
  vec2 fwCell = fwUV / uFwGlass.zw;
  vec2 fwCi = floor(fwCell), fwCf = fract(fwCell);
  float fwSt = fwHash(fwCi + 0.37);
  // Soft cell inset: a grime film has a feathered edge, a broken pane does not.
  float fwIn = smoothstep(0.0, 0.11, fwCf.x) * smoothstep(0.0, 0.11, fwCf.y)
             * smoothstep(0.0, 0.11, 1.0 - fwCf.x) * smoothstep(0.0, 0.11, 1.0 - fwCf.y);
  float fwGone = smoothstep(0.900, 0.918, fwSt);
  float fwCrackP = smoothstep(0.775, 0.792, fwSt) * (1.0 - smoothstep(0.884, 0.900, fwSt));
  float fwFilth = smoothstep(0.430, 0.560, fwSt) * (1.0 - smoothstep(0.760, 0.778, fwSt)) * fwIn;

  // Impact star: radial fractures plus one ring, from a per-pane impact point.
  vec2 fwCk = fwCf - vec2(fwHash(fwCi + 5.1), fwHash(fwCi + 8.3)) * 0.56 - 0.22;
  float fwRad = length(fwCk);
  float fwAng = atan(fwCk.y, fwCk.x) * 0.15915;
  float fwSpoke = abs(fract(fwAng * 11.0 + fwNoise(vec2(fwAng * 24.0, 3.1)) * 0.45) - 0.5);
  float fwCrack = smoothstep(0.070, 0.014, fwSpoke) * smoothstep(0.70, 0.06, fwRad);
  fwCrack = max(fwCrack,
    smoothstep(0.040, 0.008, abs(fract(fwRad * 6.0 + 0.5) - 0.5)) * smoothstep(0.62, 0.05, fwRad) * 0.8);
  fwCrack *= fwCrackP;

  // World-space film: rain runs and limescale, unaware of the pane grid.
  float fwFilm = clamp(fwStreak * 1.3 + (fwMac - 0.35) * 0.55, 0.0, 1.0) * (0.35 + 0.65 * fwFilth);
  vec3 fwView = normalize(cameraPosition - vFwPos);
  float fwNdv = clamp(abs(dot(normalize(vFwNrm), fwView)), 0.0, 1.0);
  float fwFres = 0.04 + 0.96 * pow(1.0 - fwNdv, 5.0);

  // Per-batch tint: float glass is not one colour across a whole elevation.
  diffuseColor.rgb *= vec3(0.94 + fwHash(fwCi + 1.9) * 0.12,
                           0.96 + fwHash(fwCi + 4.3) * 0.09, 1.0);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.070, 0.072, 0.062), fwFilth * 0.55);
  diffuseColor.rgb = mix(diffuseColor.rgb, uFwDustCol * 0.72, fwFilm * 0.42);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.86, 0.90, 0.94), fwCrack * 0.8);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.014, 0.016, 0.018), fwGone);
  diffuseColor.rgb *= 1.0 + (fwBrk - 0.5) * 0.10;

  diffuseColor.a = clamp(
      uFwGlass.x + fwFilth * uFwGlass.y + fwFilm * 0.16 + fwFres * 0.80 + fwCrack * 0.55,
      0.0, 1.0);
  // A missing pane is not transparent — it is a hole with a dark interior.
  diffuseColor.a = mix(diffuseColor.a, 0.86, fwGone);
`;

/**
 * Box-projected environment reflection. An infinitely distant cube map hands
 * every pane on an elevation the same sample; intersecting the reflection ray
 * with a compound-sized box gives each pane its own parallax, so the horizon
 * slides across the facade and near geometry lands where it should.
 *
 * Divided by alpha because the blend multiplies the whole fragment by it, and a
 * reflection is *added* light — it must not fade out just because the pane is
 * clean. Clamped at 0.30 so a near-transparent pane cannot detonate the value.
 */
const GLASS_ENV = /* glsl */`
#if defined( USE_ENVMAP ) && defined( ENVMAP_TYPE_CUBE_UV )
  {
    vec3 fwVd = normalize(vFwPos - cameraPosition);
    vec3 fwGn = normalize(vFwNrm);
    vec3 fwRd = reflect(fwVd, fwGn);
    vec3 fwRi = 1.0 / (fwRd + vec3(1e-5));
    vec3 fwHi = max((uFwBoxMin - vFwPos) * fwRi, (uFwBoxMax - vFwPos) * fwRi);
    float fwTn = max(min(min(fwHi.x, fwHi.y), fwHi.z), 0.5);
    vec3 fwDir = normalize((vFwPos + fwRd * fwTn) - uFwBoxMid);
    vec3 fwEnv = textureCubeUV(envMap, envMapRotation * fwDir, roughnessFactor).rgb;
    reflectedLight.indirectSpecular += fwEnv * envMapIntensity * uFwGlass2.x * fwFres
      * (1.0 - fwGone) / max(diffuseColor.a, 0.30);
  }
#endif
`;

const DETAIL_APPLY = /* glsl */`
  float fwFade = 1.0 - smoothstep(uFwDetail.z, uFwDetail.w, fwDist);
  vec3 fwDn = texture2D(uFwDetailMap, fwUV * uFwDetail.x).xyz * 2.0 - 1.0;
  float fwDs = uFwDetail.y * fwFade;
  mat3 fwVM = mat3(viewMatrix);
  normal = normalize(normal + (fwVM * fwT) * (fwDn.x * fwDs) + (fwVM * fwB) * (fwDn.y * fwDs));
  // The Z channel doubles as a micro-cavity term: a normal that has tilted away
  // from the surface is a facet flank or the gap between two grains, and both
  // sit darker and rougher than the grain tops. Free — the tap already happened.
  // Squared fade: the cavity darkening is an albedo change, and albedo detail
  // that outlives its own normal detail is what turns a distant wall to stucco.
  float fwCav = (1.0 - clamp(fwDn.z, 0.0, 1.0)) * fwFade * fwFade;
  diffuseColor.rgb *= 1.0 - fwCav * uFwDetail.y * 0.45;
  roughnessFactor = clamp(roughnessFactor + fwCav * 0.12, 0.03, 1.0);
`;

/**
 * Screen-space specular anti-aliasing (Kaplanyan's normal-variance term).
 *
 * The baked Toksvig chain fixes minification of the *base* maps, but three other
 * sources of sub-pixel normal variance survive it: geometric curvature on a
 * 30 mm handrail tube, the world-space detail normal injected above, and the
 * 45°-corner derivative spike on a catwalk lattice. All three produce the same
 * artefact — a specular lobe narrower than the pixel footprint's normal cone —
 * and all three are cured by widening the lobe to match. Two derivatives and a
 * sqrt, applied after the normal is final and before it is ever shaded.
 *
 * `uFwSpec.y` also lands the hard roughness floor on the shaded value, so a
 * consumer that overrides `roughness` on a clone cannot reintroduce the mirror.
 */
const SPEC_AA = /* glsl */`
  vec3 fwNdx = dFdx(normal), fwNdy = dFdy(normal);
  float fwNvar = 0.5 * (dot(fwNdx, fwNdx) + dot(fwNdy, fwNdy));
  float fwKr = min(2.0 * fwNvar * uFwSpec.x, 0.22);
  roughnessFactor = clamp(sqrt(roughnessFactor * roughnessFactor + fwKr), uFwSpec.y, 1.0);
`;

/* -------------------------------------------------------------- the patch --- */

const DEFAULTS = {
  detail: null,        // { map, tiling, strength, near, far }
  macro: [1 / 26, 0.16, 1 / 6.7, 0.09],   // scale, strength, breakScale, breakStrength
  grime: [0.55, 3.6, 0.10, 0.30],         // streak, storeyHeight, dust, crevice
  rough: [0.16, 0.10, 0.06],              // += grime, += streak, += dust
  grimeColour: 0x2a2823,
  dustColour: 0x9a968c,
  wet: null,           // [amount, scale]
  rust: null,          // [bias, crevWeight, upWeight, streakWeight] + colour
  rustColour: 0x6b3a1c,
  glass: null,         // [baseOpacity, filthOpacity, paneW, paneH]
  glassRefl: 1.35,     // weight of the box-projected reflection
  hasAO: true,
  specAA: 0.70,        // screen-space normal-variance -> roughness strength
  roughFloor: 0.22,    // hard shaded-roughness floor
  far: [18, 62, 0.26], // distance compensation: [near m, far m, albedo gain]
};

/**
 * The environment-reflection proxy box, in world metres. Sized to the compound:
 * the ground plane at y = -0.5 and a lid above the cooling towers, so a pane
 * reflects sky above the horizon and yard below it with correct parallax.
 * A single shared box is the right trade — per-building probes would need a
 * per-mesh uniform, and this is a facade reflection, not a mirror.
 */
const ENV_BOX = { min: [-78, -0.5, -78], max: [78, 52, 78], mid: [0, 13, 0] };

function insert(src, anchor, code) {
  const token = `#include <${anchor}>`;
  if (!src.includes(token)) return src;
  return src.replace(token, `${token}\n${code}`);
}

/**
 * Patch a standard/physical material with the forge's world-space surface
 * layers. Returns the material.
 */
export function patchSurface(material, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const key = [
    'fw1',
    o.detail ? 'd' : '-',
    o.wet ? 'w' : '-',
    o.rust ? 'r' : '-',
    o.glass ? 'g' : '-',
    o.hasAO ? 'a' : '-',
  ].join('');

  const uniforms = {
    uFwDetail: new THREE.Vector4(
      o.detail ? 1 / (o.detail.tiling ?? 0.25) : 4,
      o.detail?.strength ?? 0.6,
      o.detail?.near ?? 9,
      o.detail?.far ?? 26,
    ),
    uFwMacro: new THREE.Vector4(...o.macro),
    uFwGrime: new THREE.Vector4(...o.grime),
    uFwRough: new THREE.Vector4(o.rough[0], o.rough[1], o.rough[2], 0),
    uFwSpec: new THREE.Vector2(o.specAA, o.roughFloor),
    uFwFar: new THREE.Vector3(...o.far),
    uFwGrimeCol: new THREE.Color(o.grimeColour),
    uFwDustCol: new THREE.Color(o.dustColour),
  };
  if (o.detail) uniforms.uFwDetailMap = o.detail.map;
  if (o.wet) uniforms.uFwWet = new THREE.Vector2(...o.wet);
  if (o.rust) {
    uniforms.uFwRust = new THREE.Vector4(...o.rust);
    uniforms.uFwRustCol = new THREE.Color(o.rustColour);
  }
  if (o.glass) {
    uniforms.uFwGlass = new THREE.Vector4(...o.glass);
    uniforms.uFwGlass2 = new THREE.Vector2(o.glassRefl, 0);
    uniforms.uFwBoxMin = new THREE.Vector3(...ENV_BOX.min);
    uniforms.uFwBoxMax = new THREE.Vector3(...ENV_BOX.max);
    uniforms.uFwBoxMid = new THREE.Vector3(...ENV_BOX.mid);
  }

  material.onBeforeCompile = (shader) => {
    for (const [name, value] of Object.entries(uniforms)) {
      shader.uniforms[name] = { value };
    }

    shader.vertexShader = insert(
      `${VERT_PARS}\n${shader.vertexShader}`, 'project_vertex', VERT_BODY,
    );

    const pars = `${VERT_PARS}
uniform vec4 uFwDetail;
uniform vec4 uFwMacro;
uniform vec4 uFwGrime;
uniform vec4 uFwRough;
uniform vec2 uFwSpec;
uniform vec3 uFwFar;
uniform vec3 uFwGrimeCol;
uniform vec3 uFwDustCol;
${o.detail ? 'uniform sampler2D uFwDetailMap;' : ''}
${o.wet ? 'uniform vec2 uFwWet;' : ''}
${o.rust ? 'uniform vec4 uFwRust;\nuniform vec3 uFwRustCol;' : ''}
${o.glass ? `uniform vec4 uFwGlass;
uniform vec2 uFwGlass2;
uniform vec3 uFwBoxMin;
uniform vec3 uFwBoxMax;
uniform vec3 uFwBoxMid;` : ''}
${NOISE}`;

    let albedo = `${FRAME}\n${GRIME_MASK(o.hasAO)}`;
    if (o.glass) albedo += GLASS_APPLY;
    else {
      albedo += GRIME_APPLY;
      albedo += FAR_APPLY;
      if (o.wet) albedo += WET_APPLY;
      if (o.rust) albedo += RUST_APPLY;
    }

    let rough = '';
    if (o.glass) {
      rough = `
  roughnessFactor = clamp(roughnessFactor + fwFilth * 0.26 + fwFilm * 0.14
    + fwCrack * 0.34 + fwGone * 0.70, 0.02, 1.0);
  metalnessFactor *= 1.0 - fwGone * 0.9;`;
    } else {
      rough = `
  roughnessFactor = clamp(roughnessFactor + fwGrime * uFwRough.x + fwStreak * uFwRough.y
    + clamp(fwDust * uFwGrime.z, 0.0, 1.0) * uFwRough.z
    + (fwPanel - 0.5) * 0.10 * fwFar, 0.03, 1.0);`;
      if (o.wet) rough += `
  roughnessFactor = mix(roughnessFactor, 0.075, fwWet);`;
      if (o.rust) rough += `
  roughnessFactor = clamp(mix(roughnessFactor, 0.88, fwRust), 0.03, 1.0);
  metalnessFactor = mix(metalnessFactor, 0.14, fwRust);`;
    }

    shader.fragmentShader = pars + '\n' + shader.fragmentShader;
    shader.fragmentShader = insert(shader.fragmentShader, 'map_fragment', albedo);
    shader.fragmentShader = insert(shader.fragmentShader, 'metalnessmap_fragment', rough);
    // Order matters: the detail normal must land before the variance is measured,
    // and both must land before anything shades with `roughnessFactor`.
    shader.fragmentShader = insert(
      shader.fragmentShader, 'normal_fragment_maps',
      (o.detail ? DETAIL_APPLY : '') + SPEC_AA,
    );
    if (o.glass) {
      shader.fragmentShader = insert(shader.fragmentShader, 'aomap_fragment', GLASS_ENV);
    }
  };

  // All patched materials share one code path per variant, so the program cache
  // key must be the variant — not the default (which hashes the function body
  // and would otherwise recompile a fresh program for every material).
  material.customProgramCacheKey = () => key;
  material.needsUpdate = true;
  return material;
}
