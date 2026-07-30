import * as THREE from 'three';

/**
 * OWNER: lighting agent.
 *
 * Stops metal specular from clipping to paper white over large continuous areas.
 *
 * The failure this exists to fix
 * ------------------------------
 * In `interior` and `vertical` the top edge of every horizontal pipe run and
 * railing rendered as an unbroken band of 255,255,255. That is worse than a
 * sparkle: a sparkle is a wrong pixel, a clipped band is a *missing surface* —
 * the whole top third of the cylinder resolves to one value, so its curvature,
 * its rust and its silhouette against the wall behind it all disappear.
 *
 * A horizontal cylinder is the worst case in the whole project and it is worth
 * understanding why: the set of points on a cylinder whose half-vector aligns
 * with a *directional* source is a LINE running the full length of the cylinder.
 * So the highlight is not a dot that can be dismissed as a sparkle — it is
 * intrinsically a stripe as long as the pipe, and if it clips, it clips as a
 * stripe. Every horizontal pipe and every handrail in this level is that case.
 *
 * ROUND 8: the previous version of this patch was measured and it was placed in
 * the wrong part of the tone curve
 * -----------------------------------------------------------------------------
 * The clamp was live (`specularClampActive() === true`), the roughness floor was
 * live, and the band was still 255. Three separate mistakes, all of them about
 * *where* on the tone curve the numbers sat rather than about whether the code
 * ran.
 *
 * PostFX owns tone mapping: `colour *= meteredExposure; colour = acesFilmic(colour)`
 * with Hill's fitted RRT+ODT, then an sRGB transfer. That composition is a fixed
 * function, so the scene-linear value `v` at which a neutral pixel reaches a
 * given 8-bit code is computable. Solving `rrtOdtFit(v) = srgbDecode(byte/255)`:
 *
 *      v = 1.05  ->  byte 214        v = 7.1   ->  byte 250
 *      v = 2.3   ->  byte 235        v = 11.0  ->  byte 252
 *      v = 4.2   ->  byte 245        v = 16.9  ->  byte 254
 *
 * (`v` is scene-linear × metered exposure. Interior/vertical meter at roughly
 * 1.0-1.4, so `v` and the scene-linear specular value are within 40% of each
 * other there.)
 *
 * Against that table, the old settings:
 *
 *   1. KNEE 2.6 was already at byte ~238. The compression was "protecting" a
 *      range that the tone mapper had all but finished compressing on its own.
 *   2. CEILING 9.0 is byte ~251, so a highlight pinned exactly at the ceiling —
 *      i.e. every highlight, because the unclamped values are 10-80x the ceiling —
 *      still reads as white. The entire knee-to-ceiling span, the thing that was
 *      supposed to be a readable gradient, occupied 13 code values.
 *   3. The two terms were clamped SEPARATELY, so `directSpecular` could reach the
 *      ceiling and `indirectSpecular` could reach it as well: the actual ceiling
 *      on what gets drawn was 18, not 9, which is byte 254.
 *
 * Measured on the round-7 capture of `interior`, at y = 762 across the
 * foreground pipe: two unbroken runs of 176 and 221 pixels at or above 252, in a
 * band 18 px tall whose lower boundary is a hard step. That is the plateau.
 *
 * So: one rolloff on the SUM, with the knee inside the part of the curve that
 * still separates values and the ceiling low enough that the brightest metal in
 * frame lands near byte 245 rather than on the clip. A highlight is still the
 * brightest thing in the image — it just has a gradient in it again.
 *
 * The three corrections
 * --------------------
 * 1. ROUGHNESS FLOOR. Industrial steel that has been outdoors is never smoother
 *    than about 1/3, but nothing stops a roughness map from writing 0.12, and at
 *    0.12 the GGX lobe is 1.3 deg wide with a peak D of 245 — it delivers the
 *    source's radiance almost undiluted to a band of pixels. Metals get a floor;
 *    dielectrics keep three's own 0.0525, because wet paint and glass are
 *    legitimately smooth and do not have this problem (their specular colour is
 *    0.04, not 1.0).
 *
 * 2. NORMAL-VARIANCE FILTERING (geometric specular antialiasing, Kaplanyan et
 *    al. 2016 / Filament's formulation). Where the shading normal turns quickly
 *    across one pixel, a single sample of a narrow lobe is an unbounded estimator:
 *    it either hits the lobe and returns hundreds, or misses it and returns
 *    nothing. Widening the lobe by the screen-space normal variance converts that
 *    into an average over the footprint. This is the correction that fixes the
 *    *stripe*, not just its brightness: on a cylinder the normal sweeps fastest
 *    exactly where the highlight is, so this is precisely where roughness gets
 *    widened, and the stripe gains a soft falloff instead of a hard step. It also
 *    removes the crawl on thin railings at distance, where a 1 px wide bar
 *    contains a full 180 deg of normal sweep.
 *
 * 3. HEADROOM. Even at a correct roughness the environment carries a solar disc
 *    of tens to hundreds of units of radiance and a mirror-ish metal reflects a
 *    large fraction of it. The rolloff is linear below the knee (so ordinary
 *    dielectric highlights are untouched and bit-identical) and approaches the
 *    ceiling asymptotically above it, C1 continuous at the knee, so there is no
 *    visible seam where it engages.
 *
 * The compression is applied to the RGB triple as a whole — magnitude is scaled,
 * hue is not — so a warm sodium highlight stays warm instead of desaturating to
 * white as it brightens, which is the other half of why the old bands read as
 * paper.
 *
 * Where it hooks
 * --------------
 * `lights_physical_fragment` for the roughness floor and the variance filter, and
 * `aomap_fragment` for the rolloff. Both are chunks no other patch in this
 * project touches: ShadowShaderPatch owns `shadowmap_pars_fragment` +
 * `lights_fragment_begin`, IrradiancePatch owns `envmap_physical_pars_fragment` +
 * `lights_fragment_maps`, and Sky owns the four `fog_*` chunks. The rolloff
 * helper itself goes in `common`, which is included by every program in both
 * stages — which is exactly why the *derivative* half lives inline in
 * `lights_physical_fragment` instead: `dFdx` does not exist in a vertex shader,
 * and putting it in `common` would fail to compile every program in the project.
 *
 * `aomap_fragment` is the right seam for the rolloff because it is the last chunk
 * that can still see `reflectedLight` split into diffuse and specular — one line
 * later `opaque_fragment` has summed them and the specular term is no longer
 * separable. It also means the clamp lands after ambient occlusion has already
 * attenuated indirect specular, so an occluded highlight is measured at the value
 * it will actually be drawn at.
 */

const ROUGH_ANCHOR = 'material.roughness = max( roughnessFactor, 0.0525 );';

const ORIGINAL = { common: null, physical: null, aomap: null };
let appliedSignature = null;
let patchOk = false;

const f = (n) => Number(n).toFixed(4);

/**
 * The rolloff, on the SUM of the two specular terms.
 *
 * Taking the sum is the whole point: `directSpecular` and `indirectSpecular` are
 * added together one chunk later, so a ceiling that either one may reach
 * independently is not a ceiling on anything the viewer can see. The scale
 * factor is then applied to both, which preserves their ratio — an
 * environment-dominated highlight stays environment-coloured and a sun-dominated
 * one stays sun-coloured.
 */
function buildCommon(o) {
  return /* glsl */`

// ---------------------------------------------------------------------------
// BLACKSITE specular headroom — src/render/lighting/SpecularClampPatch.js
// ---------------------------------------------------------------------------
#define BS_SPEC_KNEE ${f(o.knee)}
#define BS_SPEC_SPAN ${f(o.span)}
#define BS_SPEC_DEBUG ${o.debug | 0}

void blacksiteSpecHeadroom( inout vec3 direct, inout vec3 indirect ) {
	#if BS_SPEC_DEBUG == 1
		indirect = vec3( 0.0 );          // isolate direct (sun/practical) specular
	#elif BS_SPEC_DEBUG == 2
		direct = vec3( 0.0 );            // isolate indirect (environment) specular
	#elif BS_SPEC_DEBUG == 3
		direct = vec3( 0.0 );            // no specular at all — is the band specular?
		indirect = vec3( 0.0 );
		return;
	#endif
	vec3 sum = direct + indirect;
	float m = max( sum.r, max( sum.g, sum.b ) );
	if ( m <= BS_SPEC_KNEE ) return;
	// Logarithmic knee. Value and first derivative both match the identity line
	// at m == BS_SPEC_KNEE, so there is no contour where it engages, and it is
	// strictly monotonic with no asymptote — which is the whole reason it is a log
	// and not the asymptotic ceiling this used to be. An asymptote turns every
	// value past ~3x the span into the SAME output, and a highlight whose values
	// are all equal is a plateau no matter how low you put it. A log keeps 8x of
	// input separation as ~1.8x of output separation forever, so the rust, the
	// weld seams and the curvature inside the highlight all survive.
	float compressed = BS_SPEC_KNEE + BS_SPEC_SPAN * log( 1.0 + ( m - BS_SPEC_KNEE ) / BS_SPEC_SPAN );
	float k = compressed / m;
	direct *= k;
	indirect *= k;
}
`;
}

/**
 * Roughness floor plus the normal-variance widening, inlined into
 * `lights_physical_fragment` because it needs screen-space derivatives.
 *
 * `normal` is in scope here: `normal_fragment_begin` and `normal_fragment_maps`
 * both run earlier in the same function, so this filters the *shaded* normal
 * including whatever the normal map did to it — which is the version the BRDF is
 * about to use, and therefore the correct one to measure the variance of.
 *
 * SIGMA2 = 1/(2*pi) is the screen-space filter variance for a pixel footprint;
 * KAPPA caps how much roughness the filter may add, so a busy normal map cannot
 * turn a polished handrail into plaster. `roughness*roughness` is the GGX alpha
 * (three squares perceptual roughness once more inside D_GGX), so the variance is
 * added in alpha space, which is where it is linear.
 */
function buildRoughness(o) {
  const floorExpr = 'mix( 0.0525, ' + f(o.metalRoughnessFloor) + ', metalnessFactor )';
  let out = 'material.roughness = max( roughnessFactor, ' + floorExpr + ' );';
  if (o.normalVarianceKappa > 0) {
    out += /* glsl */`
	// BLACKSITE geometric specular AA — see lighting/SpecularClampPatch.js
	{
		vec3 bsDNdx = dFdx( normal );
		vec3 bsDNdy = dFdy( normal );
		float bsVariance = 0.15915494 * ( dot( bsDNdx, bsDNdx ) + dot( bsDNdy, bsDNdy ) );
		float bsKernel = min( 2.0 * bsVariance, ${f(o.normalVarianceKappa)} );
		material.roughness = sqrt( saturate( material.roughness * material.roughness + bsKernel ) );
	}`;
  }
  return out;
}

function buildAO() {
  return ORIGINAL.aomap + /* glsl */`
// BLACKSITE specular headroom — see lighting/SpecularClampPatch.js
blacksiteSpecHeadroom( reflectedLight.directSpecular, reflectedLight.indirectSpecular );
`;
}

/**
 * @param {{knee:number, span:number, metalRoughnessFloor:number,
 *          normalVarianceKappa:number, debug?:number}} opts
 * @returns {boolean} true if the chunks changed (callers must recompile materials)
 */
export function applySpecularClamp(opts) {
  const sig = [
    f(opts.knee), f(opts.span), f(opts.metalRoughnessFloor),
    f(opts.normalVarianceKappa ?? 0), (opts.debug | 0),
  ].join('|');
  if (appliedSignature === sig) return false;

  if (ORIGINAL.common === null) {
    ORIGINAL.common = THREE.ShaderChunk.common;
    ORIGINAL.physical = THREE.ShaderChunk.lights_physical_fragment;
    ORIGINAL.aomap = THREE.ShaderChunk.aomap_fragment;
  }

  if (!ORIGINAL.physical.includes(ROUGH_ANCHOR)
    || !ORIGINAL.aomap.includes('reflectedLight')) {
    // three moved the chunk out from under us. Leave stock specular in place
    // rather than emitting a shader that will not link.
    console.warn('[lighting] specular clamp anchors not found; leaving stock specular (three drift?)');
    patchOk = false;
    appliedSignature = sig;
    return false;
  }

  THREE.ShaderChunk.common = ORIGINAL.common + buildCommon(opts);
  THREE.ShaderChunk.lights_physical_fragment =
    ORIGINAL.physical.replace(ROUGH_ANCHOR, buildRoughness(opts));
  THREE.ShaderChunk.aomap_fragment = buildAO();

  appliedSignature = sig;
  patchOk = true;
  return true;
}

export function specularClampActive() {
  return patchOk;
}

export function revertSpecularClamp() {
  if (ORIGINAL.common === null) return;
  THREE.ShaderChunk.common = ORIGINAL.common;
  THREE.ShaderChunk.lights_physical_fragment = ORIGINAL.physical;
  THREE.ShaderChunk.aomap_fragment = ORIGINAL.aomap;
  appliedSignature = null;
  patchOk = false;
}
