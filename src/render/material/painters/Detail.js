/**
 * OWNER: material-forge agent.
 *
 * Metal, timber, glazing, cloth — plus the shared high-frequency detail-normal
 * field that every family blends in at ~0.25 m world tiling for close range.
 * Same painter contract as painters/Concrete.js.
 */

import {
  hash2, vnoise, fbm, ridged, grains, stones,
  smoothstep, clamp01, lerp,
} from '../Noise.js';

/** Metres across one baked tile, per family. */
export const TILE_M = {
  metal_painted: 2.0,
  metal_bare: 1.2,
  metal_rusted: 1.6,
  wood_plank: 2.4,
  glass: 2.4,
  fabric: 2.0,
  // 0.26 m across 96 threads = a 2.7 mm thread pitch, which is what a woven
  // hessian sack actually measures. See `hessian` below for why the tile is this
  // small and why there is a second, coarser band inside it.
  hessian: 0.26,
  detail: 0.25,
};

/* --------------------------------------------------------- painted steel ---- */

/**
 * Industrial enamel over steel: roller/spray orange-peel, brush drag along the
 * length, chalked-out UV fade, chips that expose primer then bare metal, and
 * dirt in the low spots. The paint is a dielectric (metalness ~0.03) with a
 * semi-gloss roughness band — the specular lobe is what gives a handrail its
 * length-wise gradient instead of reading as flat grey card.
 */
export function metal_painted(u, v, o) {
  const peel = fbm(u, v, 90, 90, 3, 6017);            // orange-peel, ~22 mm
  const drag = fbm(u, v, 3, 70, 3, 6029);             // brush drag along U
  const chalk = fbm(u, v, 5, 5, 3, 6037);             // UV chalking
  const dirt = smoothstep(0.46, 0.92, fbm(u, v, 7, 7, 3, 6041));
  const breakUp = ridged(u, v, 13, 13, 3, 6059);
  // Sparse: paint fails at edges and impact points, it does not craze into a
  // lace veil across the whole panel.
  const chip = smoothstep(0.805, 0.925, breakUp);
  const deep = smoothstep(0.885, 0.965, breakUp);
  const scratch = smoothstep(0.62, 0.94, fbm(u, v, 34, 5, 2, 6071));
  const runs = smoothstep(0.70, 0.95, fbm(u, v, 26, 3, 2, 6079));

  // Base coat: a cool industrial grey-blue, chalked and dirtied.
  const shade = 1 + (drag - 0.5) * 0.115 + (peel - 0.5) * 0.055 + (chalk - 0.5) * 0.075;
  let pr = 0.292 * shade, pg = 0.324 * shade, pb = 0.366 * shade;
  pr *= 1 - dirt * 0.20; pg *= 1 - dirt * 0.20; pb *= 1 - dirt * 0.22;
  pr += chalk * 0.030; pg += chalk * 0.030; pb += chalk * 0.026;

  // Chips: red-oxide primer first, then bare steel in the deepest breaks.
  const prim = clamp01(chip - deep * 0.7);
  let r = lerp(pr, 0.322, prim), g = lerp(pg, 0.176, prim), b = lerp(pb, 0.128, prim);
  const steel = 0.395 + (peel - 0.5) * 0.075;
  r = lerp(r, steel * 1.02, deep); g = lerp(g, steel * 1.00, deep); b = lerp(b, steel * 0.99, deep);
  r += scratch * 0.035; g += scratch * 0.036; b += scratch * 0.038;

  o.r = r; o.g = g; o.b = b;
  o.h = 0.5 + (peel - 0.5) * 0.075 + (drag - 0.5) * 0.045 + runs * 0.05
    - chip * 0.20 - deep * 0.24 - scratch * 0.04;
  // 0.30 semi-gloss enamel -> 0.62 chalked/dirty -> 0.38 bare steel
  o.rough = clamp01(0.300 + chalk * 0.115 + dirt * 0.185 + (peel - 0.5) * 0.075
    + prim * 0.22 - deep * 0.02 - scratch * 0.06);
  o.metal = clamp01(0.03 + deep * 0.92 + scratch * 0.30);
  o.ao = clamp01(1 - chip * 0.20 - deep * 0.14 - dirt * 0.10);
}

/* ------------------------------------------------------------- bare steel --- */

/**
 * Galvanised / mill-finish steel: spangle crystals from the zinc bath, a
 * directional brush grain along U, drag scratches, handling scuffs and a light
 * bloom of white zinc oxide. metalness stays at 1.0 and roughness sits in the
 * 0.22-0.44 band, which is what gives it a directional, gradient-bearing
 * highlight rather than the broad uniform sheen of a painted tube.
 */
export function metal_bare(u, v, o) {
  const brush = fbm(u, v, 2, 180, 3, 7013);           // fine grain along U
  const brush2 = fbm(u, v, 4, 60, 2, 7019);
  const spangle = stones(u, v, 46, 7027, 0.85);       // 26 mm zinc crystals
  const scratch = smoothstep(0.66, 0.96, fbm(u, v, 40, 4, 3, 7031));
  const gouge = smoothstep(0.86, 0.98, fbm(u, v, 14, 3, 2, 7039));
  const oxide = smoothstep(0.52, 0.92, fbm(u, v, 6, 6, 3, 7043));
  const dirt = smoothstep(0.60, 0.95, fbm(u, v, 9, 9, 2, 7049));
  const facet = (spangle.id - 0.5);                   // each crystal catches light differently

  let l = 0.512 + (brush - 0.5) * 0.055 + (brush2 - 0.5) * 0.030 + facet * 0.045;
  l += scratch * 0.055 + gouge * 0.045;
  l *= 1 - dirt * 0.16;
  l = lerp(l, l * 0.90 + 0.075, oxide * 0.7);         // chalky zinc bloom

  o.r = l * 0.988; o.g = l * 0.996; o.b = l * 1.012;
  o.h = 0.5 + (brush - 0.5) * 0.045 + spangle.dome * 0.035
    - smoothstep(0.08, 0.0, spangle.edge) * 0.05 - gouge * 0.16 + scratch * 0.03;
  // Anisotropic-looking band: rough across the grain, smooth along it.
  o.rough = clamp01(0.245 + (brush - 0.5) * 0.135 + oxide * 0.30 + dirt * 0.11
    - scratch * 0.055 + gouge * 0.10);
  o.metal = clamp01(1.0 - oxide * 0.20 - dirt * 0.10);
  o.ao = clamp01(1 - gouge * 0.16 - dirt * 0.07 - smoothstep(0.07, 0.0, spangle.edge) * 0.10);
}

/* ---------------------------------------------------------- weathered steel - */

/**
 * Corroded steel. Rust is authored as a *layered* oxide: mill-scale steel
 * underneath, a lamellar flake field (a partitioning cell structure, so scale
 * plates butt against each other), pitting inside the mature areas and bleed
 * running down from every front. Frequencies are kept high and the blooms
 * deliberately un-distinctive, because a big characterful blob is exactly what
 * makes a 1.6 m tile announce itself as a repeat.
 */
export function metal_rusted(u, v, o) {
  const bloom = fbm(u, v, 9, 9, 3, 8083);
  const front = ridged(u, v, 15, 15, 3, 8089);
  const flake = stones(u, v, 78, 8101, 0.8);          // 20 mm scale plates
  const micro = fbm(u, v, 150, 150, 2, 8109);
  const brush = fbm(u, v, 3, 120, 2, 8113);           // mill grain on bare steel
  const bleed = smoothstep(0.40, 0.92, fbm(u, v, 22, 3, 2, 8117));
  // Pits eat through where a scale plate has lifted clean off.
  const pit = smoothstep(0.90, 1.0, flake.id) * (0.4 + 0.6 * flake.dome);

  const rust = clamp01(smoothstep(0.40, 0.80, bloom * 0.62 + front * 0.46)
    + bleed * 0.20 + (flake.id - 0.5) * 0.10);
  const mature = clamp01(rust * 0.65 + flake.id * 0.45 + (micro - 0.5) * 0.25);

  // Bare, blued mill-scale steel under the oxide.
  const sl = 0.352 + (brush - 0.5) * 0.085 + (micro - 0.5) * 0.05;
  // Oxide: dark iron-brown through to a dusty ochre scab. Kept well short of
  // saturated orange — warm light will push it there on its own.
  const rr = lerp(0.188, 0.452, mature), rg = lerp(0.130, 0.296, mature), rb = lerp(0.104, 0.212, mature);

  o.r = lerp(sl * 1.010, rr, rust);
  o.g = lerp(sl * 1.000, rg, rust);
  o.b = lerp(sl * 1.020, rb, rust);
  o.r *= 1 - pit * 0.30; o.g *= 1 - pit * 0.32; o.b *= 1 - pit * 0.32;

  o.h = 0.56 + rust * 0.075 + flake.dome * 0.085 * rust + (micro - 0.5) * 0.075
    - smoothstep(0.09, 0.0, flake.edge) * 0.16 * rust
    - pit * 0.34 - smoothstep(0.72, 1.0, front) * 0.16;
  o.rough = clamp01(lerp(0.300 + (brush - 0.5) * 0.10, 0.900, rust) + pit * 0.05 - flake.dome * 0.03);
  o.metal = clamp01(lerp(0.960, 0.090, rust) - pit * 0.05);
  o.ao = clamp01(1 - rust * 0.16 - pit * 0.28 - smoothstep(0.08, 0.0, flake.edge) * 0.22 * rust);
}

/* ------------------------------------------------------------------ timber -- */

/** Sawn softwood: staggered planks, stretched grain, knots, checks, nail heads. */
export function wood_plank(u, v, o) {
  const PLANKS = 4;                                   // 150 mm boards on a 2.4 m tile
  const row = Math.floor(v * PLANKS);
  const fv = v * PLANKS - row;
  const off = hash2(row, 0, 9211);
  const uu = (u + off) % 1;
  const seed = 9151 + row * 137;

  const grain = fbm(uu, fv, 3, 40, 4, seed);
  const ring = Math.abs(Math.sin((fv * 5.2 + grain * 2.8) * Math.PI));
  const fibre = fbm(uu, fv, 8, 170, 2, seed + 7);
  const knot = smoothstep(0.84, 0.97, grains(uu, fv, 3, seed + 11, 0.28));
  const check = smoothstep(0.80, 0.95, fbm(uu, fv, 2, 90, 2, seed + 13));  // surface splits
  const grey = smoothstep(0.40, 0.90, fbm(uu, fv, 5, 5, 3, seed + 17));    // UV silvering
  const seam = smoothstep(0.045, 0.0, Math.min(fv, 1 - fv));
  const nail = grains(uu, fv, 5, seed + 19, 0.055);
  const nailHit = smoothstep(0.35, 0.95, nail);

  let l = 0.285 + ring * 0.105 + (fibre - 0.5) * 0.070 + (grain - 0.5) * 0.055;
  l *= 1 - knot * 0.42 - check * 0.16;
  let r = l * 1.315, g = l * 1.000, b = l * 0.645;
  // weathered timber loses its resin and goes silver-grey
  const gy = grey * 0.62;
  r = lerp(r, l * 1.02 + 0.075, gy); g = lerp(g, l * 1.02 + 0.078, gy); b = lerp(b, l * 1.00 + 0.076, gy);
  r *= 1 - seam * 0.76; g *= 1 - seam * 0.78; b *= 1 - seam * 0.78;
  // galvanised nail head
  r = lerp(r, 0.44, nailHit * 0.85); g = lerp(g, 0.45, nailHit * 0.85); b = lerp(b, 0.47, nailHit * 0.85);

  o.r = r; o.g = g; o.b = b;
  o.h = 0.60 + ring * 0.115 + (fibre - 0.5) * 0.155 - seam * 0.55 - knot * 0.16
    - check * 0.26 - nailHit * 0.10;
  o.rough = clamp01(0.760 + (fibre - 0.5) * 0.12 + knot * 0.08 + grey * 0.10
    + check * 0.06 - nailHit * 0.36);
  o.metal = nailHit * 0.80;
  o.ao = clamp01(1 - seam * 0.58 - knot * 0.22 - check * 0.22 - nailHit * 0.10);
}

/* ------------------------------------------------------------------- glass -- */

/**
 * The dirt layer of a glazed unit. The optics — Fresnel opacity, IOR, per-pane
 * state — are done in the shader patch; this bake only carries grime, limescale
 * runs, dust bloom and the faint roller distortion of float glass.
 */
export function glass(u, v, o) {
  const grime = fbm(u, v, 6, 6, 4, 10239);
  const run = smoothstep(0.44, 0.94, fbm(u, v, 30, 3, 3, 10241));   // rain runs
  const scale = smoothstep(0.62, 0.95, fbm(u, v, 18, 9, 3, 10247)); // limescale
  const dust = fbm(u, v, 70, 70, 2, 10251);
  const roller = fbm(u, v, 3, 22, 2, 10253);          // float-line distortion
  const film = clamp01(grime * 0.55 + run * 0.34 + dust * 0.16 - 0.16);

  const l = 0.905 + (roller - 0.5) * 0.020;
  let r = l * 0.955, g = l * 0.985, b = l * 1.000;
  // grime is a warm brown-grey; limescale a cold chalky white
  r = lerp(r, 0.315, film * 0.72); g = lerp(g, 0.300, film * 0.72); b = lerp(b, 0.272, film * 0.72);
  r = lerp(r, 0.86, scale * 0.5); g = lerp(g, 0.88, scale * 0.5); b = lerp(b, 0.89, scale * 0.5);

  o.r = r; o.g = g; o.b = b;
  o.h = 0.5 + (roller - 0.5) * 0.06 + run * 0.05 + scale * 0.05;
  o.rough = clamp01(0.045 + film * 0.44 + scale * 0.26 + run * 0.10);
  o.metal = 0;
  o.ao = clamp01(1 - film * 0.16 - scale * 0.08);
}

/* ------------------------------------------------------------------ fabric -- */

/** Coarse woven polypropylene — tarpaulins, sacking, debris netting. */
export function fabric(u, v, o) {
  const W = 60;
  const wu = 0.5 + 0.5 * Math.sin(u * W * Math.PI * 2);
  const wv = 0.5 + 0.5 * Math.sin(v * W * Math.PI * 2);
  const cell = (Math.floor(u * W) + Math.floor(v * W)) & 1;
  const weave = cell ? wu : wv;
  const slub = vnoise(u, v, W, 1, 11257);             // thread-to-thread variation
  const fade = fbm(u, v, 4, 4, 4, 11259);
  const fuzz = fbm(u, v, 150, 150, 2, 11263);
  const stain = smoothstep(0.54, 0.86, fbm(u, v, 8, 8, 3, 11269));
  const wear = smoothstep(0.82, 0.96, ridged(u, v, 9, 9, 3, 11273));  // abraded ridges

  let l = 0.226 + (fade - 0.5) * 0.105 + weave * 0.075 + (fuzz - 0.5) * 0.05
    + (slub - 0.5) * 0.035;
  l *= 1 - stain * 0.28;
  l += wear * 0.055;

  o.r = l * 1.155; o.g = l * 1.075; o.b = l * 0.875;
  o.h = 0.5 + (weave - 0.5) * 0.40 + (fuzz - 0.5) * 0.10 + (slub - 0.5) * 0.06 - wear * 0.10;
  o.rough = clamp01(0.925 + (fuzz - 0.5) * 0.06 - stain * 0.05 + wear * 0.05);
  o.metal = 0;
  o.ao = clamp01(1 - (1 - weave) * 0.28 - stain * 0.10 - wear * 0.08);
}

/* ----------------------------------------------------------------- hessian -- */

/**
 * Woven hessian — sandbags, sacking, jute.
 *
 * The failure this replaces: `fabric` above is a *coated* polypropylene tarp
 * weave, and dressing a sandbag in it produced a smooth segmented sausage with a
 * plastic sheen. Three things are wrong with using a noise-based weave for
 * hessian, and all three are fixed here.
 *
 *  1. **The weave is deterministic, not noise.** Two perpendicular bands of
 *     flat-topped thread crowns on a plain-weave parity — `(iu + iv) & 1` picks
 *     which of the two is on top at each crossing, so the warp genuinely passes
 *     over and under the weft instead of both being averaged into a bumpy mush.
 *     That over-under alternation is the entire visual signature of woven cloth.
 *  2. **There are two thread scales.** The 2.7 mm thread band carries the weave;
 *     a 10.8 mm yarn-bundle band carries the coarse basket structure. A consumer
 *     that projects UVs at a tighter `tile` than the contract's 2 m shrinks the
 *     thread band below the pixel — the bundle band is what keeps the surface
 *     reading as cloth when that happens.
 *  3. **It is matte.** Roughness sits at 0.85-0.93 with no clearcoat and no
 *     sheen, because jute has no specular lobe worth the name. The albedo is a
 *     dusty desaturated tan with damp blotching, not saturated yellow.
 *
 * Dust accumulation on the *upward* faces is a world-space term and therefore
 * lives in SurfaceShader (the `hessian` class runs a high dust weight); a bake
 * cannot know which way a bag is facing.
 */
export function hessian(u, v, o) {
  const W = 96;                                       // 2.7 mm thread pitch
  const tu = u * W, tv = v * W;
  const iu = Math.floor(tu), iv = Math.floor(tv);
  const fu = tu - iu, fv = tv - iv;

  // Flat-topped crown: sin alone gives a ridge, sin(2-sin) gives a cord with a
  // shoulder, which is what a spun thread looks like in section.
  const su = Math.sin(fu * Math.PI), sv = Math.sin(fv * Math.PI);
  const cu = su * (2 - su), cv = sv * (2 - sv);
  const warpTop = ((iu + iv) & 1) === 0;

  // Per-thread thickness (slub) and the ply twist running along each thread.
  // Both frequencies are integer multiples of the tile, so the weave wraps.
  const slubU = 0.74 + 0.52 * hash2(iu, 0, 11801);
  const slubV = 0.74 + 0.52 * hash2(0, iv, 11807);
  const twU = 0.5 + 0.5 * Math.sin((tv * 3 + hash2(iu, 0, 11813) * 8) * Math.PI);
  const twV = 0.5 + 0.5 * Math.sin((tu * 3 + hash2(0, iv, 11819) * 8) * Math.PI);

  const hw = cu * slubU * (warpTop ? 0.86 : 0.30) + twU * cu * 0.055;
  const hf = cv * slubV * (warpTop ? 0.30 : 0.86) + twV * cv * 0.055;
  // The interstice: only where *both* threads are at their gap does the weave
  // actually open into a pinhole.
  const gap = smoothstep(0.52, 0.94, (1 - cu) * (1 - cv));

  const bundle = fbm(u, v, 24, 24, 2, 11821);         // 10.8 mm yarn bundles
  const fuzz = fbm(u, v, 260, 260, 2, 11827);         // loose fibre
  const fade = fbm(u, v, 5, 5, 3, 11833);             // sun bleach / soiling
  const stain = smoothstep(0.50, 0.88, fbm(u, v, 9, 9, 3, 11839));
  const dustField = clamp01(fbm(u, v, 3, 3, 2, 11843) * 0.85 - 0.16);
  const crown = clamp01((hw + hf) * 0.62);

  let l = 0.398 + crown * 0.070 + (fade - 0.5) * 0.115 + (fuzz - 0.5) * 0.050
    + (slubU + slubV - 2) * 0.030 + (bundle - 0.5) * 0.065;
  l *= 1 - stain * 0.26;

  let r = l * 1.070, g = l * 1.010, b = l * 0.888;
  // Damp blotching goes cool grey-brown; it does not simply darken the tan.
  r = lerp(r, l * 0.860, stain * 0.55);
  g = lerp(g, l * 0.855, stain * 0.55);
  b = lerp(b, l * 0.845, stain * 0.55);
  // Dust lifts and desaturates rather than tinting.
  r = lerp(r, 0.552, dustField * 0.24);
  g = lerp(g, 0.538, dustField * 0.24);
  b = lerp(b, 0.500, dustField * 0.24);

  o.r = r; o.g = g; o.b = b;
  o.h = clamp01(0.205 + (hw + hf) * 0.300 + (bundle - 0.5) * 0.100
    + (fuzz - 0.5) * 0.055 - gap * 0.135);
  o.rough = clamp01(0.882 + (fuzz - 0.5) * 0.045 + stain * 0.035
    - crown * 0.022 + dustField * 0.022);
  o.metal = 0;
  o.ao = clamp01(1 - (1 - crown) * 0.34 - gap * 0.30 - stain * 0.08);
}

/* ------------------------------------------------------- shared detail map -- */

/**
 * The close-range micro-relief field, height only. Tiled at 0.25 m in world
 * space by the shader patch, a 512² bake resolves ~0.5 mm per texel — which is
 * the scale at which sand grains, pores and micro-fracture actually live. This
 * is the single term that stops a surface going smooth-and-plastic when the
 * camera is a metre away, and it is shared by every family so it costs one
 * upload.
 */
export function detail(u, v, o) {
  // The dominant term is 12 mm aggregate: that is the scale a base map at
  // 250 px/m physically cannot resolve, and the scale the eye reads as "stone"
  // from a metre away. The finer octaves keep it from going smooth at 30 cm.
  const g = stones(u, v, 20, 12301, 0.65);            // 12.5 mm aggregate
  const g2 = stones(u, v, 74, 12309, 0.5);            // 3.4 mm grit
  const pore = grains(u, v, 60, 12313, 0.16);         // 3 mm pores
  const micro = fbm(u, v, 300, 300, 2, 12317);
  const scr = smoothstep(0.78, 0.98, fbm(u, v, 90, 9, 2, 12323));

  o.h = 0.5
    + g.dome * 0.30 - smoothstep(0.13, 0.0, g.edge) * 0.26
    + g2.dome * 0.15 - smoothstep(0.10, 0.0, g2.edge) * 0.12
    + (micro - 0.5) * 0.20
    - pore * 0.40
    - scr * 0.08;
  o.r = 0.5; o.g = 0.5; o.b = 0.5;
  o.rough = 0.9; o.metal = 0; o.ao = 1;
}
