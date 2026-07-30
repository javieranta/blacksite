import * as THREE from 'three';
import { bakeWeaponTextures, disposeWeaponTextures } from './Textures.js';

/**
 * OWNER: viewmodel agent.
 *
 * Material zones for the weapon and hands, plus the curvature-driven edge-wear
 * shader that ties them together.
 *
 * EDGE WEAR
 *   Shapes.js tags every chamfer strip with `aEdge` = 1 and feathers it to 0
 *   across the adjoining face. That attribute is a curvature proxy: it is high
 *   exactly where a real part's finish rubs through first. In the shader it
 *   blends albedo toward bare metal, drops roughness (bare metal is smoother
 *   than a phosphate coating) and raises metalness, broken up by a sample of the
 *   albedo map so the wear line is never a perfect stripe.
 *
 *   `aCav` marks pocket floors and recesses; the viewmodel is composited after
 *   the screen-space AO pass, so cavities need their own darkening or the M-LOK
 *   slots and the ejection port read as flat paint.
 *
 * Down-facing surfaces get a small extra darkening and up-facing surfaces a
 * little settled dust — a two-line stand-in for a bent-normal AO bake that does
 * a surprising amount of work on a first-person weapon.
 */

const WEAR_VERT_HEAD = /* glsl */`
attribute float aEdge;
attribute float aCav;
varying float vEdge;
varying float vCav;
varying vec3 vObjN;
`;

const WEAR_FRAG_HEAD = /* glsl */`
uniform vec3 uWearCol;
uniform float uWearAmt;
uniform float uWearRough;
uniform float uWearMetal;
uniform float uCavAmt;
uniform float uGrime;
uniform float uRoughFloor;
uniform vec2 uNrmFade;
uniform float uNrmTilt;
varying float vEdge;
varying float vCav;
varying vec3 vObjN;
`;

function applyWear(mat, o) {
  const uni = {
    uWearCol: { value: new THREE.Color(o.wearColour) },
    uWearAmt: { value: o.wearAmount },
    uWearRough: { value: o.wearRough },
    uWearMetal: { value: o.wearMetal },
    uCavAmt: { value: o.cavity ?? 0.55 },
    uGrime: { value: o.grime ?? 0.35 },
    // Hard specular-antialiasing floor. The Toksvig pass in Textures.js raises
    // roughness per mip from the normal variance it measured, but the *shader*
    // can still undercut it: edge wear pulls roughness down toward bare metal on
    // every chamfer, and a chamfer strip is exactly where the normal map, the
    // geometric silhouette and the specular lobe all land in the same pixel.
    // Below ~0.32 that pixel sparkles no matter what the maps say.
    uRoughFloor: { value: o.roughFloor ?? 0.34 },
    // Texture footprint, in tile units per pixel, over which the normal-map
    // perturbation fades out to the geometric normal. One tile is 30 mm of
    // surface (Shapes.TEX_M), so 0.010 is roughly a pixel on a first-person
    // weapon held at 350 mm and 0.055 is what a surface raked hard away from the
    // camera produces. The window used to start at 0.022, which on a viewmodel
    // meant it never opened at all: the gun is *magnified*, so every footprint
    // was below the lower bound and the fade was dead code exactly where the
    // artefact it exists to kill was worst.
    uNrmFade: { value: new THREE.Vector2(0.010, 0.055) },
    // Hard ceiling on the angle between the sampled normal and the geometric
    // one, as a chord length: 0.20 is about 11.5 degrees. This is the backstop
    // for the shadow-terminator stipple (see Textures.js). Texture-side clamps
    // bound the *authored* facet, but a mip that averaged two opposing normals,
    // an anisotropic tap that missed, and normalScale multiplying on top can all
    // land past it; this cannot be exceeded by anything.
    uNrmTilt: { value: o.tilt ?? 0.20 },
  };
  mat.userData.wear = uni;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uni);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${WEAR_VERT_HEAD}`)
      .replace('#include <beginnormal_vertex>',
        '#include <beginnormal_vertex>\n  vObjN = normalize( objectNormal );')
      .replace('#include <begin_vertex>',
        '#include <begin_vertex>\n  vEdge = aEdge;\n  vCav = aCav;');

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${WEAR_FRAG_HEAD}`)
      .replace('#include <map_fragment>', /* glsl */`
        #include <map_fragment>
        // Breakup for the wear line. This was sampled at 3.1x the albedo rate,
        // which on any part small enough for its whole face to be flagged as an
        // edge — the optic hood walls, the bezel, the rail teeth — painted a
        // high-frequency light/dark mottle over the entire surface and made
        // machined aluminium read as porous cast rock. At 1.35x the breakup is
        // patches rather than grain, and the contrast range is halved so the
        // wear stays a variation on the finish instead of replacing it.
        float wBrk = texture2D( map, vMapUv * 1.35 ).g;
        // How many tiles of texture this pixel covers. Everything that has to
        // fade with minification keys off this one number.
        float wFoot = max( length( dFdx( vMapUv ) ), length( dFdy( vMapUv ) ) );
        float wFade = 1.0 - smoothstep( uNrmFade.x, uNrmFade.y, wFoot );
        float wAmt = clamp( vEdge * uWearAmt * ( 0.55 + 0.85 * wBrk )
          * mix( 0.5, 1.0, wFade ), 0.0, 1.0 );
        float wUp = clamp( vObjN.y, 0.0, 1.0 );
        float wDn = clamp( -vObjN.y, 0.0, 1.0 );
        diffuseColor.rgb = mix( diffuseColor.rgb, uWearCol, wAmt );
        diffuseColor.rgb *= 1.0 - uCavAmt * vCav;
        diffuseColor.rgb *= 1.0 - 0.20 * wDn;
        diffuseColor.rgb += uGrime * wUp * wBrk * vec3( 0.0105, 0.0098, 0.0086 );
      `)
      .replace('#include <roughnessmap_fragment>', /* glsl */`
        #include <roughnessmap_fragment>
        roughnessFactor = clamp(
          mix( roughnessFactor, uWearRough, wAmt ) + vCav * 0.10 + wUp * uGrime * 0.45,
          uRoughFloor, 1.0 );
      `)
      .replace('#include <metalnessmap_fragment>', /* glsl */`
        #include <metalnessmap_fragment>
        metalnessFactor = mix( metalnessFactor, uWearMetal, wAmt );
      `)
      // NORMAL-MAP LOD FADE + specular antialiasing.
      //
      // Toksvig in Textures.js fixes variance the *mip chain* hides. It cannot
      // fix variance the *rasteriser* hides: a stock flank raked away from the
      // camera has a pixel footprint hundreds of texels long in one direction,
      // well past what 16x anisotropy resolves. An A/B with normalScale forced
      // to zero proved that is what was left after the texture rebuild — and it
      // survived roughness being pinned at 1.0, so it was never the specular
      // lobe at all. It is the *diffuse* term: those faces sit on the sun's
      // terminator, where N·L is near zero and a couple of degrees of normal
      // wobble is the whole difference between lit and unlit. No roughness
      // treatment can touch that; the perturbation itself has to go away.
      //
      // So the normal map fades back to the geometric normal as the footprint
      // grows. Detail is full strength where it can be resolved and gone where
      // it cannot, which is also the right answer for distance.
      .replace('#include <normal_fragment_maps>', /* glsl */`
        #include <normal_fragment_maps>
        {
          normal = normalize( mix( nonPerturbedNormal, normal, wFade ) );
          #if NUM_DIR_LIGHTS > 0
          {
            // TERMINATOR GUARD — the actual cure.
            //
            // Amplitude reduction and tilt clamping both attack the symptom. The
            // mechanism is this: on a face whose *geometric* normal is within a
            // few degrees of perpendicular to the sun, N·L is within a hair of
            // zero, and the sun is two orders of magnitude brighter than the
            // ambient the face is otherwise lit by. A normal-map perturbation of
            // even five degrees therefore does not shade that face — it decides,
            // per texel, whether the texel is in daylight or not. The output is a
            // binary maximum-contrast checker, and it is why neither roughness
            // nor mip filtering ever touched it.
            //
            // So the perturbation is scaled by how much it is allowed to move
            // N·L *relative to the value N·L already has*. On a face turned into
            // the key, N·L is 0.8 and a 10 degree wobble moves it by 0.18 — a
            // fifth, which is exactly the surface relief the map is for, and the
            // limit passes it through untouched. On a face raked to 10 degrees
            // off the sun, N·L is 0.17 and the identical wobble moves it by the
            // same 0.18 — the whole value, twice over — so the limit cuts the
            // perturbation to a third and the texture stops deciding which texels
            // are in daylight. Detail exactly where light can show it, flat where
            // light could only turn it into noise. Each light is weighted by its
            // own luminance, so the key governs the budget and the fill, rim and
            // bounce, which carry no contrast, cost nothing.
            vec3 nP = normal;
            float aSum = 0.0, dSum = 0.0;
            #if NUM_POINT_LIGHTS > 0
            // The muzzle flash is a point light 400 mm off the barrel at 22
            // intensity, which for two frames a shot is by far the brightest
            // thing lighting this weapon — and it rakes the receiver top at a
            // near-perfect grazing angle. Leaving it out of the budget is why
            // the hipfire frame came out clean and the firing frame did not.
            for ( int i = 0; i < NUM_POINT_LIGHTS; i ++ ) {
              vec3 lv = pointLights[ i ].position + vViewPosition;
              float lDist = length( lv );
              vec3 ld = lv / max( lDist, 1e-4 );
              vec3 lc = pointLights[ i ].color;
              float lum = max( lc.r, max( lc.g, lc.b ) )
                * getDistanceAttenuation( lDist, pointLights[ i ].distance, pointLights[ i ].decay );
              float nlG = dot( nonPerturbedNormal, ld );
              aSum += lum * ( 0.045 * max( nlG, 0.0 ) + 0.003 );
              dSum += lum * abs( dot( nP, ld ) - nlG );
            }
            #endif
            for ( int i = 0; i < NUM_DIR_LIGHTS; i ++ ) {
              vec3 lc = directionalLights[ i ].color;
              vec3 ld = directionalLights[ i ].direction;
              float lum = max( lc.r, max( lc.g, lc.b ) );
              float nlG = dot( nonPerturbedNormal, ld );
              aSum += lum * ( 0.045 * max( nlG, 0.0 ) + 0.003 );
              dSum += lum * abs( dot( nP, ld ) - nlG );
            }
            // Because dSum is evaluated per pixel, this is a slope limiter and
            // not a global fade: a texel whose perturbation is already inside
            // the budget comes through at 1.0 untouched, and only the outliers —
            // which are precisely the sparkling texels — get pulled back. The
            // surface keeps its texture and loses its spikes.
            normal = normalize( mix( nonPerturbedNormal, nP,
              dSum > 1e-5 ? min( 1.0, aSum / dSum ) : 1.0 ) );
          }
          #endif
          // TILT CEILING. Everything above is a *statistical* bound: the bake
          // targets an RMS slope, the mip chain averages, the fade blends. None
          // of them bound the worst case, and on the shadow terminator only the
          // worst case matters — one texel tilted far enough to catch the sun is
          // one blown pixel in a black field, and a field of them is the stipple
          // this whole chain exists to remove. Clamping the chord between the
          // shading normal and the geometric normal is the one operation that
          // makes "how wrong can a pixel be" a number rather than a hope.
          vec3 dTilt = normal - nonPerturbedNormal;
          float dLen = length( dTilt );
          if ( dLen > uNrmTilt ) dTilt *= uNrmTilt / dLen;
          normal = normalize( nonPerturbedNormal + dTilt );
          // Kaplanyan/Tokuyoshi: widen the lobe by whatever normal variance is
          // still crossing a pixel after the fade and the clamp.
          vec3 dNx = dFdx( normal );
          vec3 dNy = dFdy( normal );
          float varN = 0.5 * ( dot( dNx, dNx ) + dot( dNy, dNy ) );
          roughnessFactor = min( 1.0,
            sqrt( roughnessFactor * roughnessFactor + min( 2.0 * varN, 0.30 ) ) );
        }
      `);
  };
  return mat;
}

function zone(set, o) {
  const m = new THREE.MeshStandardMaterial({
    color: o.tint ?? 0xffffff,
    map: set.map,
    normalMap: set.normalMap,
    roughnessMap: set.orm,
    metalnessMap: set.orm,
    aoMap: set.orm,
    aoMapIntensity: o.ao ?? 0.85,
    roughness: 1.0,
    metalness: 1.0,
    normalScale: new THREE.Vector2(o.normal ?? 1, o.normal ?? 1),
    envMapIntensity: o.env ?? 1.0,
    dithering: true,
  });
  m.name = `vm:${o.name}`;
  return applyWear(m, o);
}

/**
 * Build every material zone. Called once from ViewModel.init.
 * @returns {{ mats: Record<string, THREE.Material>, sets: object }}
 */
export function buildWeaponMaterials() {
  const sets = bakeWeaponTextures();

  const mats = {
    // Phosphate steel — barrel, upper, bolt, controls, muzzle device.
    // 0.85 normal scale, not 1.05: the map already carries its relief at a
    // calibrated RMS tilt, and scaling a normal map up past 1 re-introduces the
    // steep facets the calibration exists to prevent.
    steel: zone(sets.steel, {
      name: 'steel', normal: 0.58, env: 0.90, ao: 0.9, roughFloor: 0.40, tilt: 0.10,
      wearColour: 0x7d7a73, wearAmount: 0.62, wearRough: 0.44, wearMetal: 1.0,
      cavity: 0.60, grime: 0.30,
    }),
    // Polymer lower, stock, magazine body.
    polymer: zone(sets.polymer, {
      name: 'polymer', normal: 0.62, env: 0.55, ao: 1.0, roughFloor: 0.58, tilt: 0.10,
      wearColour: 0x5a5c62, wearAmount: 0.62, wearRough: 0.58, wearMetal: 0.06,
      cavity: 0.55, grime: 0.40,
    }),
    // Stippled polymer: grip panels and magazine flats.
    grip: zone(sets.stipple, {
      // Moulded checkering is genuine, coherent relief rather than noise, so it
      // gets a looser tilt ceiling than any other zone — a diamond that cannot
      // tilt does not read as a diamond.
      name: 'grip', normal: 0.78, env: 0.5, ao: 1.0, roughFloor: 0.52, tilt: 0.15,
      wearColour: 0x63656b, wearAmount: 0.50, wearRough: 0.52, wearMetal: 0.05,
      cavity: 0.5, grime: 0.30,
    }),
    // Hard-anodised aluminium: rail, handguard, optic housing, mount.
    // Rail and handguard. Wear is deliberately restrained here: the rail has an
    // edge every 10 mm, and at full strength every one of them lights up and the
    // whole thing reads as a bright comb across the lower half of an ADS frame.
    alu: zone(sets.alu, {
      name: 'alu', normal: 0.58, env: 0.85, ao: 0.9, roughFloor: 0.46, tilt: 0.09,
      wearColour: 0x86837c, wearAmount: 0.32, wearRough: 0.46, wearMetal: 1.0,
      cavity: 0.62, grime: 0.26,
    }),
    // Moulded rubber: eyecup, buttpad, overmould.
    rubber: zone(sets.rubber, {
      name: 'rubber', normal: 0.72, env: 0.35, ao: 1.0, roughFloor: 0.70, tilt: 0.15,
      wearColour: 0x3a3a3c, wearAmount: 0.40, wearRough: 0.70, wearMetal: 0.02,
      cavity: 0.5, grime: 0.25,
    }),
    // Tactical glove.
    glove: zone(sets.glove, {
      // Wear tint tracks the base: the glove's albedo was raised to 0.075 linear
      // so it reads lighter than the weapon, and a 0x4a453e wear colour on top of
      // that is a *darkening* at the seams instead of the scuffed highlight it is
      // meant to be.
      name: 'glove', normal: 0.82, env: 0.40, ao: 1.0, roughFloor: 0.74, tilt: 0.18,
      wearColour: 0xa39a8b, wearAmount: 0.34, wearRough: 0.74, wearMetal: 0.02,
      cavity: 0.45, grime: 0.45,
    }),
    // Knuckle pads / palm reinforcement — same rubber, tuned harder.
    pad: zone(sets.rubber, {
      name: 'pad', normal: 0.70, env: 0.5, ao: 1.0, roughFloor: 0.58, tilt: 0.15,
      wearColour: 0x4c4c4e, wearAmount: 0.55, wearRough: 0.58, wearMetal: 0.03,
      cavity: 0.5, grime: 0.30,
    }),
    // Uniform sleeve.
    sleeve: zone(sets.sleeve, {
      name: 'sleeve', normal: 0.75, env: 0.35, ao: 1.0, roughFloor: 0.76, tilt: 0.18,
      wearColour: 0xb0aa93, wearAmount: 0.30, wearRough: 0.78, wearMetal: 0.01,
      cavity: 0.45, grime: 0.55,
    }),
    // Fired brass. The glossiest zone on the weapon: a case is a 10 mm object in
    // flight, so its highlight is a moving point, not a field. Still floored at
    // 0.34 — a tumbling case crosses the terminator several times a second, and
    // at 0.28 each crossing produced a frame of confetti.
    brass: zone(sets.brass, {
      name: 'brass', normal: 0.45, env: 1.2, ao: 1.0, roughFloor: 0.34, tilt: 0.09,
      wearColour: 0xd8bd7c, wearAmount: 0.7, wearRough: 0.30, wearMetal: 1.0,
      cavity: 0.4, grime: 0.15,
    }),
  };

  // Bore / interior blackness: no wear, no env, just a hole. Matte and
  // dielectric, not semi-gloss steel — as a semi-gloss it caught the key light
  // and painted the inside of the optic housing a bright orange, which is the
  // one thing the interior of a sight can never be.
  mats.bore = new THREE.MeshStandardMaterial({
    color: 0x050607, roughness: 0.94, metalness: 0.0, envMapIntensity: 0.06,
  });
  mats.bore.name = 'vm:bore';

  return { mats, sets };
}

export function disposeWeaponMaterials(mats, sets) {
  for (const m of Object.values(mats)) m.dispose?.();
  if (sets) disposeWeaponTextures(sets);
}
