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
uniform float uSpecF90;
uniform vec3 uWearCol;
uniform float uWearAmt;
uniform float uWearRough;
uniform float uWearMetal;
uniform float uCavAmt;
uniform float uGrime;
uniform float uRoughFloor;
uniform vec2 uNrmFade;
uniform float uNrmTilt;
uniform float uTermBudget;
uniform float uAoDetail;
uniform float uCavSat;
uniform float uOccFloor;
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
    uNrmFade: { value: new THREE.Vector2(...(o.fade ?? [0.010, 0.055])) },
    // Hard ceiling on the angle between the sampled normal and the geometric
    // one, as a chord length: 0.20 is about 11.5 degrees. This is the backstop
    // for the shadow-terminator stipple (see Textures.js). Texture-side clamps
    // bound the *authored* facet, but a mip that averaged two opposing normals,
    // an anisotropic tap that missed, and normalScale multiplying on top can all
    // land past it; this cannot be exceeded by anything.
    uNrmTilt: { value: o.tilt ?? 0.20 },
    /**
     * TERMINATOR-GUARD BUDGET — how far the normal map is allowed to move N·L,
     * as a fraction of the value N·L already has. It was hard-coded at 0.045 and
     * that number is now a per-zone uniform, because 0.045 is right for the
     * weapon and it was silently deleting the entire glove.
     *
     * Measured, not argued. tools/handcheck.mjs renders the hands isolated, then
     * re-renders them with normalScale forced to 0, and diffs the local-contrast
     * of the two. Round 10 scored nrmShare = -0.023 on the hip view and -0.012 on
     * ADS: turning the normal map completely OFF changed the hands by less than
     * the frame-to-frame noise. Every scrap of relief the reviewer could not find
     * was in fact being computed and then thrown away one line before it reached
     * the light.
     *
     * The guard is still correct where it came from. Its target is a *world*
     * surface lying on a low sun's terminator, where N·L is near zero, the sun is
     * two orders of magnitude brighter than the ambient, and a few degrees of
     * perturbation therefore decides per texel whether a pixel is in daylight —
     * a binary maximum-contrast checker. None of that describes a glove: the
     * hands are in `viewScene`, lit by a compressed four-light rig plus a
     * hemisphere wrap with no shadowing and no sun-versus-black step anywhere in
     * it, and they are the nearest and most magnified surface in the frame. So
     * the fabric zones get a budget an order of magnitude larger and the metal
     * zones keep 0.045 unchanged.
     */
    uTermBudget: { value: o.term ?? 0.045 },
    /**
     * Extra AO contrast, applied to the map's own R channel.
     *
     * `aoMap` multiplies INDIRECT light only — and indirect is very nearly the
     * only light the hands receive, because they sit on the weapon's underside
     * and far flank where the key never reaches. That makes the AO channel, not
     * the normal map, the highest-authority detail channel on this particular
     * surface, and the one place where a weave that a directional light cannot
     * shade still gets to be visible. Gamma-shaping it in the shader keeps the
     * bake's authored value while letting each zone dial how deep its own
     * micro-occlusion reads.
     */
    uAoDetail: { value: o.aoDetail ?? 1.0 },
    /** How far the multiple-scatter chroma boost goes in a cavity. */
    uCavSat: { value: o.cavSat ?? 0.0 },
    /**
     * FLOOR ON HOW DARK OCCLUSION MAY DRIVE A PIXEL.
     *
     * Deepening the glove's weave interstices and seam channels bought most of
     * this round's material detail and cost the cyan assertion: peak hand
     * saturation went 0.279 -> 0.377 against a 0.34 bar. The two are the same
     * event. A hand pixel dark enough that the environment probe is its only
     * remaining light takes its colour from the probe, the probe is a PMREM of
     * the sky, and the result is teal on a tan glove — the third time this exact
     * mechanism has been diagnosed in this file.
     *
     * The lever that costs nothing is the FLOOR rather than the depth. All of the
     * detail lives in the contrast between a yarn float and the hole beside it,
     * and none of it lives in the last 20% of the hole's darkness — which is
     * where every pixel that fails the hue test is. Clamping the occlusion
     * product keeps the full authored contrast above the floor and refuses to
     * hand any pixel over to the sky entirely.
     */
    uOccFloor: { value: o.occFloor ?? 0.0 },
    /**
     * GRAZING-ANGLE SPECULAR CEILING — the fabric zones' half of the teal-ring
     * fix, and the half that geometry cannot do.
     *
     * MeshStandardMaterial hard-codes `material.specularF90 = 1.0`, i.e. every
     * surface becomes a perfect mirror at grazing incidence. For metal that is
     * right. For a woven glove it is badly wrong, and it was measured: with the
     * viewmodel's cool #93a5c6 fill and rim zeroed, the share of hand pixels in
     * the cyan hue band fell from 1.62% to 0.12%. A dielectric's specular is NOT
     * tinted by albedo, so wherever Fresnel went to 1 the surface painted itself
     * pure light colour — a saturated cool band on a tan glove.
     *
     * Real rough cloth does not do that: at grazing incidence the microfacet
     * shadowing/masking term eats most of the reflection, which is exactly what
     * measured cloth BRDFs show and exactly what the single-scatter GGX in
     * three.js omits. Capping F90 at 0.22-0.42 for the fabric zones restores it —
     * leather highest, since a hide palm genuinely does keep a sheen, ripstop
     * lowest. This is a physical correction, not a hack, and it is why the weapon's
     * zones are left at 1.0: their grazing highlights are correct and load-bearing.
     *
     * It is also only one third of the fix. The other two thirds are in
     * ViewModel._syncLights (the fill's chroma was cancelling the glove's albedo
     * exactly) and in Hands.js (forty capsules meant forty grazing bands instead of
     * one). Measured together, hip-view cyan share went 1.62% -> 0.006%.
     */
    uSpecF90: { value: o.specF90 ?? 1.0 },
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
        // Occlusion from the AO map, gamma-shaped and floored. Sampled here
        // because the albedo needs it too (multiple-scatter chroma, below) and
        // aomap_fragment runs after the lights, far too late for that.
        #ifdef USE_AOMAP
          float uAoTex = max( pow( texture2D( aoMap, vAoMapUv ).r, uAoDetail ), uOccFloor );
        #endif
        diffuseColor.rgb = mix( diffuseColor.rgb, uWearCol, wAmt );
        /**
         * CAVITY DARKENING, AND THE CHROMA THAT HAS TO COME WITH IT.
         *
         * A neutral multiply is wrong inside a fold and it caused a measured
         * regression: deepening the glove's occlusion took the ADS peak cyan
         * saturation from 0.279 to 0.368, past the 0.34 bar. The mechanism is the
         * same one this project has now hit three times — a hand pixel dark
         * enough that the environment probe is its only light gets its colour
         * from the probe, and the probe is a PMREM of the sky.
         *
         * The physically right answer is not to darken less. Light in a crevice
         * bounces off the surface several times before it leaves, so it is
         * multiplied by the albedo repeatedly: a deep fold in a brown glove is
         * BROWNER than the flat beside it, not greyer. Boosting chroma about the
         * pixel's own luminance is that effect, and it defends the darkest
         * pixels against a blue light by making the surface they are made of more
         * strongly coloured exactly where they are darkest.
         */
        diffuseColor.rgb *= max( 1.0 - uCavAmt * vCav, uOccFloor );
        {
          // Occlusion comes from two places and both need the same treatment:
          // vCav is the geometry's own creases and seams, the AO map is the
          // texture's weave interstices and seam channels. Deepening the second
          // is what caused the regression, so leaving it out would fix half of
          // it and the ADS frame is lit by the other half.
          float occ = clamp( vCav, 0.0, 1.0 );
          #ifdef USE_AOMAP
            occ = max( occ, 1.0 - uAoTex );
          #endif
          float cLum = dot( diffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
          diffuseColor.rgb = max( vec3( 0.0 ), mix( diffuseColor.rgb,
            vec3( cLum ) + ( diffuseColor.rgb - vec3( cLum ) ) * 2.05,
            occ * uCavSat ) );
        }
        diffuseColor.rgb *= 1.0 - 0.20 * wDn;
        diffuseColor.rgb += uGrime * wUp * wBrk * vec3( 0.0105, 0.0098, 0.0086 );
      `)
      // AO CONTRAST. `aoMap` multiplies indirect light, and indirect is nearly
      // all the light the hands get. Pushing the map's R channel through a gamma
      // deepens the weave, the seam channels and the crease valleys in exactly
      // the term that is doing the lighting, which is the one detail channel on
      // this surface that no clamp downstream can take away.
      .replace('#include <aomap_fragment>', /* glsl */`
        #ifdef USE_AOMAP
          float ambientOcclusion = ( uAoTex - 1.0 ) * aoMapIntensity + 1.0;
          reflectedLight.indirectDiffuse *= ambientOcclusion;
          #if defined( USE_ENVMAP ) && defined( STANDARD )
            float dotNVao = saturate( dot( geometryNormal, geometryViewDir ) );
            reflectedLight.indirectSpecular *= computeSpecularOcclusion(
              dotNVao, ambientOcclusion, material.roughness );
          #endif
        #endif
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
      // Applied after three.js has filled `material`, so it overrides the
      // hard-coded specularF90 = 1.0 without touching anything else in the BRDF.
      // Metal zones pass 1.0 and compile to the identical shader.
      .replace('#include <lights_physical_fragment>', /* glsl */`
        #include <lights_physical_fragment>
        material.specularF90 = mix( material.specularF90, uSpecF90, 1.0 - metalnessFactor );
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
              aSum += lum * ( uTermBudget * max( nlG, 0.0 ) + 0.003 );
              dSum += lum * abs( max( dot( nP, ld ), 0.0 ) - max( nlG, 0.0 ) );
            }
            #endif
            #if NUM_HEMI_LIGHTS > 0
            // The hemisphere wrap is the brightest thing on the underside of the
            // hands and it has NO terminator at all — its irradiance varies
            // smoothly with N over the whole sphere, so a perturbed normal can
            // never make a pixel of it jump from lit to unlit. Leaving it out of
            // aSum meant the budget was being sized from lights that barely
            // reach the glove while the light that actually does was ignored.
            for ( int i = 0; i < NUM_HEMI_LIGHTS; i ++ ) {
              vec3 hc = hemisphereLights[ i ].skyColor + hemisphereLights[ i ].groundColor;
              aSum += max( hc.r, max( hc.g, hc.b ) ) * uTermBudget * 0.5;
            }
            #endif
            for ( int i = 0; i < NUM_DIR_LIGHTS; i ++ ) {
              vec3 lc = directionalLights[ i ].color;
              vec3 ld = directionalLights[ i ].direction;
              float lum = max( lc.r, max( lc.g, lc.b ) );
              float nlG = dot( nonPerturbedNormal, ld );
              aSum += lum * ( uTermBudget * max( nlG, 0.0 ) + 0.003 );
              dSum += lum * abs( max( dot( nP, ld ), 0.0 ) - max( nlG, 0.0 ) );
            }
            /**
             * THE max(.,0) ON BOTH SIDES OF dSum IS NOT COSMETIC. It is the
             * difference between this guard bounding an artefact and this guard
             * deleting the hands.
             *
             * dSum used to accumulate abs( dot(nP,ld) - nlG ) -- the raw change
             * in N·L. But the diffuse term does not use N·L, it uses
             * max(N·L, 0): a light BEHIND a surface contributes nothing to it, and
             * perturbing the normal from -0.50 to -0.30 changes that nothing into
             * nothing. The old form charged the full 0.20 to the budget anyway.
             *
             * On the weapon that is a rounding error, because its lit faces are
             * lit. On the hands it is fatal, and measurably so. The glove sits on
             * the weapon's underside and far flank with the key BEHIND it, so for
             * most hand pixels the brightest light in the rig had nlG < 0: it put
             * only its 0.003 floor into aSum while putting its entire luminance
             * times the whole perturbation into dSum. The ratio aSum/dSum
             * collapsed to a few percent and the normal map was multiplied away.
             *
             * That is exactly what tools/handcheck.mjs measured as nrmShare ~= 0
             * across three separate builds, and what tools/_nrmab.mjs then showed
             * to be non-linear in normalScale — tripling the scale moved the
             * result 10% while doubling it moved nothing, which is the signature
             * of an ABSOLUTE cap on the perturbation rather than a scale on it.
             * With the clamp on both sides the cap is sized from the light that
             * is actually lighting the pixel, and a light that is not lighting it
             * no longer gets a vote.
             *
             * The protection it exists for is untouched: the stipple case is a
             * face at nlG ~= 0, where max(nlG,0) is 0 either way and the budget
             * is still the 0.003 floor.
             */
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
    /**
     * Tactical glove, woven back.
     *
     * `env` is 0.95, not 0.40, and that is not a cosmetic bump — it is half the
     * legibility fix. The hands sit on the weapon's underside and far flank, so
     * they are barely touched by the key and are lit mostly by indirect light;
     * throttling their environment response to 0.40 was throttling the only light
     * they actually receive. It was measured: the glove's albedo is 5x the
     * polymer's, and the frame was showing a 1.15x step. The weapon zones stay
     * where they are (steel 0.90, polymer 0.55) because their bright faces are the
     * ones taking the key, and lifting those would just cancel the separation
     * again.
     *
     * `grime` down from 0.45 to 0.26: the grime term adds a fixed dust colour on
     * up-facing surfaces, which on a now-much-lighter glove is a desaturating wash
     * that pulls the hue back toward the weapon's neutral — exactly the property
     * being fought for.
     */
    /**
     * FABRIC IS NOT METAL, AND THE CLAMPS ARE FOR METAL.
     *
     * `term`, `tilt` and `fade` here are all an order of magnitude looser than
     * any weapon zone, and each one is loose because it was measured to be
     * costing detail rather than buying stability:
     *
     *   term 0.55 (was the hard-coded 0.045). The terminator guard sizes the
     *   normal map's budget from how far it may move N·L. Its target is a world
     *   surface on a low sun's terminator; a glove in `viewScene` has no such
     *   light anywhere in its rig, so the budget was throttling a map that had
     *   no artefact to cause. tools/_nrmab.mjs: releasing it alone is worth more
     *   than the LOD fade and the tilt ceiling combined.
     *
     *   tilt 0.45 (was 0.18, i.e. 10 degrees). Woven cloth genuinely has 25-degree
     *   local slopes; a ceiling below its authored relief does not soften the
     *   weave, it deletes it and leaves the mean.
     *
     *   fade [0.035, 0.16] (was [0.010, 0.055]). The window is a footprint in
     *   TILES per pixel, and the glove's UVs are far denser than the weapon's —
     *   a finger is 1.4 tiles around and about 25 px wide, so a normal
     *   foreground pixel already sat a third of the way into a fade window that
     *   was calibrated on a rifle at 350 mm. The hands are the closest surface in
     *   the frame; they should be the LAST thing to fade, not the first.
     *
     * `aoDetail` 2.6 is the other half, and on this surface it is the larger
     * half: AO multiplies indirect light, indirect is nearly all the light the
     * hands get, and the same A/B measured a gamma on the AO channel as worth
     * roughly twice what the normal map is worth. `ao` goes to 1.0 for the same
     * reason. Both cost mean luminance, which is why Textures.gloveFabric lifts
     * its base value 8% — the round-9 value separation is paid for, not spent.
     */
    glove: zone(sets.glove, {
      name: 'glove', normal: 1.50, env: 0.70, ao: 1.0, roughFloor: 0.45, tilt: 0.70,
      occFloor: 0.46, cavSat: 0.90, specF90: 0.09, term: 1.10, aoDetail: 2.6, fade: [0.070, 0.340],
      wearColour: 0xd6c4a2, wearAmount: 0.30, wearRough: 0.70, wearMetal: 0.02,
      cavity: 0.55, grime: 0.26,
    }),
    /**
     * Palm and finger-pad leather. Smoother than the fabric and slightly deeper,
     * so the two materials part along the metacarpal line under any light — the
     * seam that gives the palm's curvature something to be read against.
     */
    leather: zone(sets.leather, {
      name: 'leather', normal: 1.25, env: 0.82, ao: 1.0, roughFloor: 0.40, tilt: 0.62,
      occFloor: 0.48, cavSat: 0.85, specF90: 0.30, term: 1.10, aoDetail: 2.2, fade: [0.070, 0.340],
      wearColour: 0xe2cfa8, wearAmount: 0.38, wearRough: 0.40, wearMetal: 0.03,
      cavity: 0.50, grime: 0.20,
    }),
    /**
     * Wrist cuff. Its whole job is to be a THIRD material between the glove and
     * the sleeve, so its numbers are chosen to sit between theirs on every axis
     * that reads: value (Textures.gloveCuff), roughness (0.80-0.90, the mattest
     * zone on the rig) and environment response (0.60, between the glove's 0.95
     * and the sleeve's 0.50). A band that split the difference on only one of
     * those would read as a shadow on the sleeve rather than as a garment part.
     */
    cuff: zone(sets.cuff, {
      name: 'cuff', normal: 1.25, env: 0.48, ao: 1.0, roughFloor: 0.66, tilt: 0.66,
      occFloor: 0.44, cavSat: 0.80, specF90: 0.12, term: 1.10, aoDetail: 2.4, fade: [0.070, 0.340],
      wearColour: 0xa89a80, wearAmount: 0.26, wearRough: 0.80, wearMetal: 0.01,
      cavity: 0.55, grime: 0.34,
    }),
    /**
     * Knuckle armour and finger pads. Its own rubber, ~4x the glove rather than
     * the weapon buttpad's near-black: at 13:1 the knuckle row stops being four
     * knuckles and becomes four holes.
     */
    pad: zone(sets.padrubber, {
      name: 'pad', normal: 1.25, env: 0.68, ao: 1.0, roughFloor: 0.55, tilt: 0.62,
      occFloor: 0.50, cavSat: 0.55, specF90: 0.30, term: 1.10, aoDetail: 2.2, fade: [0.070, 0.340],
      wearColour: 0x8e8578, wearAmount: 0.42, wearRough: 0.54, wearMetal: 0.03,
      cavity: 0.50, grime: 0.28,
    }),
    // Uniform sleeve. Deliberately NOT given the glove's environment boost: the
    // forearm has to stay the dark end of the shape (see Textures.ripstop).
    sleeve: zone(sets.sleeve, {
      name: 'sleeve', normal: 1.25, env: 0.50, ao: 1.0, roughFloor: 0.76, tilt: 0.66,
      occFloor: 0.44, cavSat: 0.80, specF90: 0.13, term: 1.10, aoDetail: 2.3, fade: [0.070, 0.340],
      wearColour: 0xb0aa93, wearAmount: 0.30, wearRough: 0.78, wearMetal: 0.01,
      cavity: 0.45, grime: 0.40,
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
