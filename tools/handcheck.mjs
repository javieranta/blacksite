#!/usr/bin/env node
/**
 * Pixel-level assertion that the first-person hands are actually on screen.
 *
 * WHY THIS EXISTS. Three consecutive rounds "fixed" the missing hands and three
 * consecutive reviews found the rifle still floating with nothing gripping it.
 * One of those rounds verified, correctly, that the hand geometry existed, had
 * 4808 triangles, carried the right materials, was `visible === true` and
 * projected to pixel (1166, 908) — and the hands were still not in the picture,
 * because the fingers were 18 mm clear of the grip in empty air and the support
 * hand was buried inside the handguard rail.
 *
 * Every one of those checks was about the scene graph. None of them was about
 * the image. So this harness asserts on the image: it isolates the hand meshes,
 * renders them alone, and counts the pixels they actually cover.
 *
 * It reports three numbers per view:
 *   handsPct   share of frame the hands cover when rendered alone
 *   weaponPct  same for the weapon, as a control — if this is also 0 the
 *              isolation itself is broken rather than the hands being absent
 *   gripOverlap share of the hands' pixels that fall inside the weapon's
 *              silhouette. Hands floating in space next to the gun score a high
 *              handsPct and a near-zero overlap, which is exactly the failure
 *              mode that shipped twice.
 *
 * ─── ROUND 10: THE HARNESS PASSED WHILE THE HAND WAS A CAPSULE CHAIN ───────
 *
 * Every number above was green in round 9 and the review still called the hand
 * "a stack of unskinned PVC capsules … every joint capped by a teal ring". Both
 * of those are properties of the SHAPE and the COLOUR of the mask, and this file
 * only ever measured its AREA and its POSITION. A harness cannot fail on a defect
 * it does not have a number for, so two numbers were added, chosen so that the
 * round-9 build fails them:
 *
 *   blobs      connected components in the isolated hand mask, ignoring specks
 *              under MIN_BLOB_PX. A hand is one closed surface, so two hands are
 *              two blobs; the round-9 hand was ~40 loose primitives with air
 *              between them and measured 12-16. This is the number that makes
 *              "one continuous skinned mesh" an assertion instead of an
 *              intention. It cannot be passed by moving the pieces closer —
 *              touching silhouettes merge, which is the point.
 *
 *   cyanPct    share of hand pixels sitting in the cyan/teal hue band with real
 *              saturation. The cause was found by A/B rather than guessed: with
 *              the viewmodel's cool fill and rim lights zeroed the figure falls
 *              from 1.62% to 0.12%, so the teal is Fresnel rim-specular of a
 *              #93a5c6 fill on the grazing silhouette band of every separate
 *              cylinder. One continuous surface has one silhouette; forty nested
 *              capsules have forty, and they land mid-hand where they read as
 *              pipe couplings.
 *
 * ─── ROUND 11: THE HARNESS PASSED WHILE THE GLOVE WAS WAX ─────────────────
 *
 * Round 10 shipped one continuous skinned surface with no teal, and every number
 * here went green again. The review still refused it: "pale, waxy, entirely
 * smooth digits with no weave, stitching, seams or knuckle pads — they read as
 * bare wax, not a glove." Area, position, component count and hue say nothing
 * about whether a surface has any LOCAL CONTRAST, so a perfectly flat diffuse
 * blob passes all four. The fifth number closes that:
 *
 *   detail     mean luminance gradient across a 3px baseline, over the hand mask
 *              eroded 3px so the silhouette cannot contribute, normalised by the
 *              mask's own mean luminance. It is a scale-free measure of "how much
 *              is going on inside this shape".
 *
 *              The bar is RELATIVE, against the weapon measured the same way in
 *              the same frame. That is deliberate. An absolute bar would be a
 *              number about the tone curve, the exposure and the film grain as
 *              much as about the material, and this project has already been
 *              burnt twice by absolute pixel tests (the 63%-coverage brightness
 *              threshold, the "60fps" from a clamped dt). The weapon is agreed by
 *              the reviewer to be materially detailed; the hands are in the same
 *              scene under the same lights and the same post chain. So the honest
 *              question is "does the glove carry a comparable share of its own
 *              value in local detail", and detailRatio answers exactly that.
 *
 *   nrmShare   the fractional detail GAINED by doubling normalScale on the hand
 *              materials. This is the A/B that tells apart the two ways a glove
 *              can be flat: an under-authored texture, versus a texture that is
 *              fine and a SHADER that is throwing it away. Round 10's glove tile
 *              measures 8.1 degrees of RMS weave tilt offline — the map is there —
 *              so without this number the obvious conclusion ("author more
 *              relief") would have been the wrong fix for the third time in this
 *              project's history.
 *
 *              IT IS A DOUBLING, NOT A ZEROING, AND THAT COST A ROUND TO LEARN.
 *              The first version of this number compared the hands against
 *              normalScale forced to 0, and reported ~0 for three consecutive
 *              builds including ones where a normalScale sweep clearly showed the
 *              map working. The comparison was confounded: `normalScale = 0` also
 *              zeroes the normal DERIVATIVES, which switches off the
 *              Kaplanyan/Tokuyoshi roughness widening in Materials.js, which
 *              SHARPENS the specular lobe and puts local contrast back. The two
 *              effects very nearly cancelled, and the instrument read "the normal
 *              map does nothing" about a normal map that was doing something.
 *              A sweep gave it away — detail was linear in normalScale from 1.6
 *              upward and the ns=0 point sat far above that line, which is not a
 *              shape any single mechanism produces.
 *
 *              Doubling keeps the widening active on both sides, so the only
 *              thing that differs is the perturbation. Same reason the two grabs
 *              are taken back to back: the post chain drifts slowly across a long
 *              variant list, and a drift of a few percent is the size of the
 *              signal being measured.
 *
 * ─── AND AN INSTRUMENT BUG FOUND WHILE ADDING THEM ────────────────────────
 *
 * `grab()` drove a SINGLE frame. The post chain accumulates temporally, so one
 * frame after a visibility change is a blend of the old and new images. It did
 * not matter much for a coverage threshold with 3x of headroom; it wrecks any
 * hue measurement, and it silently invalidated a first attempt at the A/B above,
 * which reported byte-identical means for every variant and would have been read
 * as "the lights are not the cause". Every grab now settles for FRAMES frames.
 * (The same A/B also has to stub `_syncLights`, which rewrites the light
 * intensities from the sky every frame and quietly undid the experiment.)
 *
 * Usage: node tools/handcheck.mjs [--views viewmodel-hip,viewmodel-ads]
 * Exits non-zero if any view fails the thresholds.
 */
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };

const VIEWS = {
  'viewmodel-hip': 'tod=golden&pos=6,1.7,14&yaw=200&pitch=-0.02&vm=1',
  'viewmodel-ads': 'tod=golden&pos=6,1.7,14&yaw=200&pitch=-0.02&vm=1&ads=1',
};
const want = (opt('views', 'viewmodel-hip,viewmodel-ads')).split(',').map((s) => s.trim());

/** Hands must cover at least this share of frame, and mostly sit on the weapon. */
const MIN_HANDS_PCT = 0.8;
const MIN_GRIP_OVERLAP = 0.25;
/** Hand pixels that survive into the composite — the metric that matters. */
const MIN_VISIBLE_PCT = 0.6;
/**
 * Two hands are two closed surfaces. Four is the slack allowed for a fingertip
 * that a nearer finger happens to cut in two in screen space; a capsule chain
 * cannot get anywhere near it.
 */
const MAX_BLOBS = 4;
/** A blob smaller than this is an antialiasing speck, not a limb. 1920x1080. */
const MIN_BLOB_PX = 90;
/**
 * Share of hand pixels allowed in the cyan band. Zeroing the cool fill and rim
 * lights takes the round-9 build to 0.12%, so 0.40% leaves room for the genuine
 * thin rim a single silhouette produces and none for a row of couplings.
 */
const MAX_CYAN_PCT = 0.40;
/** No single hand pixel may be a saturated teal. */
const MAX_CYAN_SAT = 0.34;
/**
 * TEXTURE DETAIL. Both bars have to be cleared.
 *
 * `detail` is mean |dL| over a 3px baseline divided by mean L, x100, inside the
 * eroded hand mask. `detailRatio` is that over the same figure for the weapon.
 * The round-10 build measures 3.0-3.5 detail against a weapon at 9-11, i.e. a
 * ratio near 0.30: the glove carries a third of the local contrast per unit
 * brightness that the gun it is holding does, which is the measurable form of
 * "reads as bare wax". A woven, stitched, padded glove is not as busy as a rail
 * with a tooth every 10 mm, so the bar is 0.55 rather than 1.0.
 */
const MIN_DETAIL = 5.2;
const MIN_DETAIL_RATIO = 0.55;
/**
 * Doubling normalScale must buy at least this much extra local contrast. A glove
 * whose only relief is painted into the albedo shades like printed cloth — which
 * is exactly what round 10 looked like at 6x, a flat hatch with no light response
 * anywhere on it, and which measures 0.015 here. A live map measures 0.10-0.13.
 */
const MIN_NRM_SHARE = 0.075;

/**
 * Renders three isolations and returns pixel coverage for each.
 *
 * Isolation works by walking the two scenes and toggling `visible`, then driving
 * one frame by hand. The engine's own rAF loop is stopped first: in headless
 * Chromium it is paced by a virtual clock and would otherwise queue a normal
 * frame over the isolated one before readPixels sampled it.
 */
const PROBE = `(() => {
  const eng = window.__blacksite.engine;
  const vm = eng.systems.get('viewmodel');
  if (!vm) return { error: 'no viewmodel system' };
  if (!vm.hands || !vm.rig) return { error: 'viewmodel exposes no .hands/.rig handles' };

  const gl = eng.renderer.getContext();
  const W = eng.renderer.domElement.width;
  const H = eng.renderer.domElement.height;
  const buf = new Uint8Array(W * H * 4);

  const handMeshes = vm.hands.meshes || [];
  const rigMeshes = vm.rig.meshes || [];

  // Save state we are about to trample.
  const saved = {
    sceneVisible: eng.scene.visible,
    background: eng.scene.background,
    hands: handMeshes.map((m) => m.visible),
    rig: rigMeshes.map((m) => m.visible),
  };

  eng.stop();

  /**
   * Grab the raw framebuffer with the given visibility.
   *
   * An absolute "brighter than black" test does not work here: even with the
   * world hidden, the post chain's grade lift, film grain and vignette put every
   * pixel above zero, so a naive threshold reported 63% coverage and a
   * full-frame bounding box for BOTH hands and weapon. Coverage is therefore
   * measured as a DIFFERENCE against a baseline frame with nothing visible,
   * which cancels any constant floor the chain adds.
   */
  const FRAMES = 14;
  const grab = (showHands, showRig) => {
    eng.scene.visible = false;          // hide the world
    eng.scene.background = null;        // and the sky fill
    const pick = typeof showHands === 'function' ? showHands : () => showHands;
    handMeshes.forEach((m) => { m.visible = pick(m); });
    rigMeshes.forEach((m) => { m.visible = showRig; });
    // Settle the temporal accumulation. One frame is a cross-fade of the
    // previous visibility state and this one — tolerable for an area threshold,
    // fatal for a hue one.
    for (let k = 0; k < FRAMES; k++) eng._frame();
    const out = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, out);
    return out;
  };

  const baseline = grab(false, false);

  /** Mask of pixels that differ from the empty baseline. */
  const maskOf = (frame) => {
    const mask = new Uint8Array(W * H);
    let count = 0, minX = W, maxX = -1, minY = H, maxY = -1;
    for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
      const d = Math.abs(frame[p] - baseline[p])
        + Math.abs(frame[p + 1] - baseline[p + 1])
        + Math.abs(frame[p + 2] - baseline[p + 2]);
      if (d > 24) {
        mask[i] = 1; count++;
        const x = i % W, y = (i / W) | 0;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
    return { mask, count, box: count ? [minX, minY, maxX, maxY] : null };
  };

  const handsFrame = grab(true, false);
  const handsOnly = maskOf(handsFrame);
  const weaponIsoFrame = grab(false, true);
  const weaponOnly = maskOf(weaponIsoFrame);

  /**
   * LOCAL CONTRAST inside a mask.
   *
   * Two decisions here are the difference between measuring the material and
   * measuring something else entirely:
   *
   *   ERODE FIRST. A silhouette against the cleared background is the largest
   *   gradient in the image by an order of magnitude. Without erosion this
   *   number is a perimeter-to-area ratio — it would rank a hand made of forty
   *   separate capsules as the MOST detailed one, which is precisely backwards.
   *   Three erosion passes clear the antialiased rim plus the 3px sampling
   *   baseline.
   *
   *   SAMPLE AT 3px, NOT 1px. The post chain lays film grain over everything at
   *   one-pixel scale. A 1px gradient is therefore mostly a grain meter and
   *   would hand a flat surface a passing score for free. Weave, stitching and
   *   pad rims on a first-person hand all live at 3-10px, above the grain and
   *   below the shape.
   */
  const detailOf = (frame, m) => {
    let mask = m;
    for (let pass = 0; pass < 3; pass++) {
      const e = new Uint8Array(mask.length);
      for (let i = 0; i < mask.length; i++) {
        if (!mask[i]) continue;
        const x = i % W, y = (i / W) | 0;
        if (x === 0 || y === 0 || x === W - 1 || y === H - 1) continue;
        if (mask[i - 1] && mask[i + 1] && mask[i - W] && mask[i + W]) e[i] = 1;
      }
      mask = e;
    }
    const L = (p) => 0.2126 * frame[p] + 0.7152 * frame[p + 1] + 0.0722 * frame[p + 2];
    let n = 0, sumL = 0, sumG = 0;
    const D = 3;
    for (let y = D; y < H - D; y++) {
      for (let x = D; x < W - D; x++) {
        const i = y * W + x;
        if (!mask[i]) continue;
        const c = L(i * 4);
        const gx = Math.abs(L((i + D) * 4) - L((i - D) * 4));
        const gy = Math.abs(L((i + D * W) * 4) - L((i - D * W) * 4));
        n++; sumL += c; sumG += (gx + gy) * 0.5;
      }
    }
    const mean = n ? sumL / n : 0;
    return {
      px: n,
      mean: +mean.toFixed(2),
      detail: n && mean > 1 ? +((sumG / n / mean) * 100).toFixed(2) : 0,
    };
  };

  const handDetail = detailOf(handsFrame, handsOnly.mask);
  const weaponDetail = detailOf(weaponIsoFrame, weaponOnly.mask);

  /**
   * THE GLOVE, ON ITS OWN.
   *
   * The full hand mask is roughly half FOREARM — the sleeve tube runs to the
   * bottom-left corner of the frame and is the single largest piece of the rig
   * on screen. That is fine for coverage and blob counting and wrong for a
   * material assertion, because the review's complaint is about the glove and
   * the fingers, and averaging the glove together with 25 000 px of ripstop
   * dilutes any change to it by half before the number is even formed. The hip
   * view is where that bites: it reported a normal-map response of +0.03 while
   * the ADS view, where the support hand fills the mask, reported +0.14 for the
   * identical materials.
   *
   * So the detail numbers are taken over the glove zones only — the hand proper
   * and its cuff, not the sleeve.
   */
  const isGlove = (m) => !/:sleeve$/.test(m.name);
  const gloveFrame = grab(isGlove, false);
  const gloveMask = maskOf(gloveFrame);
  const gloveDetail = detailOf(gloveFrame, gloveMask.mask);

  /**
   * A/B: how much of that detail is the NORMAL MAP?
   *
   * Forcing normalScale to zero on every hand material and re-rendering isolates
   * the shading contribution from the albedo contribution. onBeforeCompile is
   * not re-run (normalScale is a live uniform), so this costs one extra settle
   * and nothing else. Materials are shared between the two hands, so they are
   * de-duplicated before being trampled and restored from the same list.
   */
  const handMats = [...new Set(handMeshes.filter(isGlove).map((m) => m.material))]
    .filter((m) => m && m.normalScale);
  const savedNS = handMats.map((m) => m.normalScale.clone());
  handMats.forEach((m, i) => m.normalScale.set(savedNS[i].x * 2, savedNS[i].y * 2));
  const flatDetail = detailOf(grab(isGlove, false), gloveMask.mask);
  handMats.forEach((m, i) => m.normalScale.copy(savedNS[i]));
  // Re-take the reference immediately after, so the pair is adjacent in time.
  const refDetail = detailOf(grab(isGlove, false), gloveMask.mask);

  /**
   * CONNECTED COMPONENTS of the hand mask.
   *
   * Iterative 4-connected flood fill over an explicit stack — a recursive fill
   * over 2 million pixels blows the JS stack, and a "count 8-connected instead"
   * shortcut was rejected because diagonal touching is exactly how a chain of
   * loose capsules can fake continuity in one frame and not the next.
   *
   * Blobs under MIN_BLOB_PX are dropped: a one-pixel antialiasing island off a
   * fingertip is not a detached limb, and counting it would make the assertion
   * fail for a reason nobody can see, which is its own kind of useless.
   */
  const blobStats = (() => {
    const mask = handsOnly.mask;
    const seen = new Uint8Array(mask.length);
    const stack = new Int32Array(mask.length);
    const sizes = [];
    for (let start = 0; start < mask.length; start++) {
      if (!mask[start] || seen[start]) continue;
      let sp = 0, area = 0;
      stack[sp++] = start; seen[start] = 1;
      let bx0 = W, bx1 = -1, by0 = H, by1 = -1;
      while (sp > 0) {
        const i = stack[--sp];
        area++;
        const x = i % W, y = (i / W) | 0;
        if (x < bx0) bx0 = x; if (x > bx1) bx1 = x;
        if (y < by0) by0 = y; if (y > by1) by1 = y;
        if (x > 0 && mask[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; stack[sp++] = i - 1; }
        if (x < W - 1 && mask[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; stack[sp++] = i + 1; }
        if (y > 0 && mask[i - W] && !seen[i - W]) { seen[i - W] = 1; stack[sp++] = i - W; }
        if (y < H - 1 && mask[i + W] && !seen[i + W]) { seen[i + W] = 1; stack[sp++] = i + W; }
      }
      sizes.push({ area, box: [bx0, by0, bx1, by1] });
    }
    sizes.sort((a, b) => b.area - a.area);
    const kept = sizes.filter((s) => s.area >= 90);
    return {
      blobs: kept.length,
      specks: sizes.length - kept.length,
      largest: kept.slice(0, 8).map((s) => s.area),
      strays: kept.slice(2).map((s) => [s.area, s.box]).slice(0, 8),
    };
  })();

  /**
   * HUE of the hand pixels. Measured on the isolated frame so the level's own
   * blue-grey concrete cannot be counted as glove.
   *
   * The band is 0.36..0.62 in hue — green-cyan through blue — with a saturation
   * floor so the whole cool half of a neutral grey does not qualify, and a value
   * floor because the darkest antialiased silhouette pixels of ANY object sit in
   * the post chain's cool black and would otherwise dominate the count. That
   * value floor is not a nicety: without it the worst-saturation reading came
   * back as 0.95 for every variant of the A/B, pointing at edge pixels of the
   * background rather than at the artefact.
   */
  const hueStats = (() => {
    const mask = handsOnly.mask;
    let n = 0, cyan = 0, worst = 0, wpx = null;
    for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
      if (!mask[i]) continue;
      n++;
      const r = handsFrame[p] / 255, g = handsFrame[p + 1] / 255, b = handsFrame[p + 2] / 255;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
      if (mx < 0.26 || d < 1e-6) continue;
      const s = d / mx;
      if (s <= 0.16) continue;
      let hh;
      if (mx === r) hh = ((g - b) / d + 6) % 6;
      else if (mx === g) hh = (b - r) / d + 2;
      else hh = (r - g) / d + 4;
      hh /= 6;
      if (hh < 0.36 || hh > 0.62) continue;
      cyan++;
      if (s > worst) {
        worst = s;
        wpx = [i % W, H - 1 - ((i / W) | 0), handsFrame[p], handsFrame[p + 1], handsFrame[p + 2]];
      }
    }
    /**
     * THE SAME MEASUREMENT ON INTERIOR PIXELS ONLY.
     *
     * Not a replacement for the bar above — a control for it. The mask's own rim
     * is one pixel of hand antialiased against a cleared background that the post
     * chain has left a cool near-black, so an edge pixel is a BLEND and its hue
     * is a property of the compositor rather than of the glove. The existing
     * metric already carries a value floor at 0.26 for exactly this reason, and
     * the peak-saturation outlier now sits at value 0.263 — one thousandth above
     * that floor, and it does not move when the glove's occlusion, its chroma
     * boost or its grazing specular are changed, which no material-driven pixel
     * would do. Eroding three pixels settles whether that reading is the surface
     * or the seam between the surface and nothing.
     */
    let mask2 = mask;
    for (let pass = 0; pass < 3; pass++) {
      const e = new Uint8Array(mask2.length);
      for (let i = 0; i < mask2.length; i++) {
        if (!mask2[i]) continue;
        const x = i % W, y = (i / W) | 0;
        if (x === 0 || y === 0 || x === W - 1 || y === H - 1) continue;
        if (mask2[i - 1] && mask2[i + 1] && mask2[i - W] && mask2[i + W]) e[i] = 1;
      }
      mask2 = e;
    }
    let n2 = 0, cyan2 = 0, worst2 = 0;
    for (let i = 0, p = 0; i < mask2.length; i++, p += 4) {
      if (!mask2[i]) continue;
      n2++;
      const r = handsFrame[p] / 255, g = handsFrame[p + 1] / 255, b = handsFrame[p + 2] / 255;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
      if (mx < 0.26 || d < 1e-6) continue;
      const sv = d / mx;
      if (sv <= 0.16) continue;
      let hh;
      if (mx === r) hh = ((g - b) / d + 6) % 6;
      else if (mx === g) hh = (b - r) / d + 2;
      else hh = (r - g) / d + 4;
      hh /= 6;
      if (hh < 0.36 || hh > 0.62) continue;
      cyan2++;
      if (sv > worst2) worst2 = sv;
    }
    return {
      cyanPct: n ? +((cyan / n) * 100).toFixed(3) : 0,
      cyanSat: +worst.toFixed(3),
      cyanWorst: wpx,
      cyanPctIn: n2 ? +((cyan2 / n2) * 100).toFixed(3) : 0,
      cyanSatIn: +worst2.toFixed(3),
    };
  })();

  /**
   * THE METRIC THAT ACTUALLY MATTERS.
   *
   * Isolated coverage only proves the hands rasterise somewhere. It does not
   * prove the player can SEE them: hands drawn behind the receiver, or buried
   * inside the handguard, occupy pixels in isolation and contribute nothing to
   * the composite. That is precisely how two rebuilds passed their authors'
   * checks and failed the review.
   *
   * So diff the real composite (hands + weapon) against weapon-only. Whatever
   * changes is hand actually visible to the player.
   */
  const bothFrame = grab(true, true);
  const weaponFrame = grab(false, true);
  let visible = 0, vMinX = W, vMaxX = -1, vMinY = H, vMaxY = -1;
  for (let i = 0, p = 0; i < W * H; i++, p += 4) {
    const d = Math.abs(bothFrame[p] - weaponFrame[p])
      + Math.abs(bothFrame[p + 1] - weaponFrame[p + 1])
      + Math.abs(bothFrame[p + 2] - weaponFrame[p + 2]);
    if (d > 24) {
      visible++;
      const x = i % W, y = (i / W) | 0;
      if (x < vMinX) vMinX = x; if (x > vMaxX) vMaxX = x;
      if (y < vMinY) vMinY = y; if (y > vMaxY) vMaxY = y;
    }
  }

  // How much of the hands lands on the weapon's silhouette. Low overlap with a
  // healthy handsPct means hands rendering somewhere other than on the grip.
  let overlap = 0;
  for (let i = 0; i < handsOnly.mask.length; i++) {
    if (handsOnly.mask[i] && weaponOnly.mask[i]) overlap++;
  }

  // Restore.
  eng.scene.visible = saved.sceneVisible;
  eng.scene.background = saved.background;
  handMeshes.forEach((m, i) => { m.visible = saved.hands[i]; });
  rigMeshes.forEach((m, i) => { m.visible = saved.rig[i]; });
  eng.start();

  const total = W * H;
  return {
    resolution: W + 'x' + H,
    handMeshCount: handMeshes.length,
    rigMeshCount: rigMeshes.length,
    handTriangles: vm.hands.triangles ?? null,
    handsPct: +((handsOnly.count / total) * 100).toFixed(3),
    weaponPct: +((weaponOnly.count / total) * 100).toFixed(3),
    handsBox: handsOnly.box,
    weaponBox: weaponOnly.box,
    gripOverlap: handsOnly.count ? +(overlap / handsOnly.count).toFixed(3) : 0,
    visiblePct: +((visible / total) * 100).toFixed(3),
    visibleBox: visible ? [vMinX, vMinY, vMaxX, vMaxY] : null,
    occludedShare: handsOnly.count ? +(1 - visible / handsOnly.count).toFixed(3) : 1,
    detail: gloveDetail.detail,
    detailPx: gloveDetail.px,
    handDetailAll: handDetail.detail,
    handMean: handDetail.mean,
    weaponDetail: weaponDetail.detail,
    weaponMean: weaponDetail.mean,
    detailRatio: weaponDetail.detail
      ? +(gloveDetail.detail / weaponDetail.detail).toFixed(3) : 0,
    detailFlatN: flatDetail.detail,
    detailRef: refDetail.detail,
    nrmShare: refDetail.detail
      ? +(flatDetail.detail / refDetail.detail - 1).toFixed(3) : 0,
    // Value separation, kept from round 9 and re-asserted here so a detail fix
    // cannot quietly pay for itself by darkening the glove into the receiver.
    valueSep: weaponDetail.mean > 1
      ? +(handDetail.mean / weaponDetail.mean).toFixed(3) : 0,
    ...blobStats,
    ...hueStats,
  };
})()`;

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=d3d11', '--disable-gpu-sandbox', '--ignore-gpu-blocklist'],
});

let failed = false;
for (const view of want) {
  const q = VIEWS[view];
  if (!q) { console.log(`${view}: unknown view`); continue; }
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  try {
    await page.goto(`http://127.0.0.1:5180/?freeze=1&hud=0&quality=cinematic&${q}`,
      { waitUntil: 'domcontentloaded', timeout: 300000 });
    await page.waitForFunction('window.__ready === true', null, { timeout: 300000 });
    await page.waitForTimeout(900);

    const r = await page.evaluate(PROBE);
    if (r.error) { console.log(`${view}: ${r.error}`); failed = true; await page.close(); continue; }

    const okCtl = r.weaponPct > 0.1;
    const okHands = r.handsPct >= MIN_HANDS_PCT;
    const okVisible = r.visiblePct >= MIN_VISIBLE_PCT;
    const okBlobs = r.blobs <= MAX_BLOBS;
    const okCyan = r.cyanPct <= MAX_CYAN_PCT && r.cyanSat <= MAX_CYAN_SAT;
    const okDetail = r.detail >= MIN_DETAIL && r.detailRatio >= MIN_DETAIL_RATIO;
    const okNrm = r.nrmShare >= MIN_NRM_SHARE;
    const okValue = r.valueSep >= 1.45;
    if (!okHands || !okVisible || !okCtl || !okBlobs || !okCyan
      || !okDetail || !okNrm || !okValue) failed = true;

    console.log(`\n=== ${view} (${r.resolution}) ===`);
    console.log(`  hand meshes ${r.handMeshCount}, ${r.handTriangles} tris; weapon meshes ${r.rigMeshCount}`);
    console.log(`  ${okCtl ? 'ok  ' : 'FAIL'} weapon coverage    ${r.weaponPct}%  box ${JSON.stringify(r.weaponBox)}   (control)`);
    console.log(`  ${okHands ? 'ok  ' : 'FAIL'} hands rasterise    ${r.handsPct}%  box ${JSON.stringify(r.handsBox)}   (isolated)`);
    console.log(`  ${okVisible ? 'PASS' : 'FAIL'} hands VISIBLE      ${r.visiblePct}%  box ${JSON.stringify(r.visibleBox)}   (need >= ${MIN_VISIBLE_PCT}% in the composite)`);
    console.log(`       occluded share ${r.occludedShare} of hand pixels hidden behind the weapon`);
    console.log(`  ${okBlobs ? 'PASS' : 'FAIL'} ONE SURFACE        ${r.blobs} connected blobs (need <= ${MAX_BLOBS}), ${r.specks} sub-${MIN_BLOB_PX}px specks`);
    console.log(`       blob areas ${JSON.stringify(r.largest)}`);
    if (r.strays.length) console.log(`       detached extras [area,[x0,y0,x1,y1]] ${JSON.stringify(r.strays)}`);
    console.log(`  ${okCyan ? 'PASS' : 'FAIL'} NO TEAL RINGS      ${r.cyanPct}% of hand pixels in the cyan band`
      + ` (need <= ${MAX_CYAN_PCT}%), peak saturation ${r.cyanSat} (need <= ${MAX_CYAN_SAT})`);
    if (r.cyanWorst) console.log(`       worst pixel at (${r.cyanWorst[0]}, ${r.cyanWorst[1]}) rgb(${r.cyanWorst.slice(2).join(', ')})`);
    console.log(`       interior only (3px eroded, silhouette blend excluded):`
      + ` ${r.cyanPctIn}%, peak ${r.cyanSatIn}`);
    console.log(`  ${okDetail ? 'PASS' : 'FAIL'} MATERIAL DETAIL    glove ${r.detail} over ${r.detailPx} eroded px`
      + ` (need >= ${MIN_DETAIL}); weapon ${r.weaponDetail}, ratio ${r.detailRatio} (need >= ${MIN_DETAIL_RATIO})`);
    console.log(`       whole rig incl. sleeve ${r.handDetailAll}`);
    console.log(`  ${okNrm ? 'PASS' : 'FAIL'} NORMAL MAP LANDS   +${r.nrmShare} detail from doubling`
      + ` normalScale (${r.detailRef} -> ${r.detailFlatN}, need >= +${MIN_NRM_SHARE})`);
    console.log(`  ${okValue ? 'PASS' : 'FAIL'} VALUE SEPARATION   hand mean ${r.handMean} vs weapon ${r.weaponMean}`
      + ` = ${r.valueSep}x (need >= 1.45)`);
    if (!okDetail) console.log('  -> the glove has no local contrast: no weave, no seams, no pad rims, no'
      + ' crease darkening. A flat diffuse surface at this scale reads as wax, not fabric.');
    if (!okNrm) console.log('  -> whatever detail there is, is PAINTED. The normal map is contributing almost'
      + ' nothing on screen — look at the shader clamping it, not at the texture.');
    if (!okCtl) console.log('  -> the isolation itself is broken; every number below it is meaningless');
    else if (!okHands) console.log('  -> hands do not rasterise at all');
    else if (!okVisible) console.log('  -> hands rasterise but are OCCLUDED — drawn behind or inside the weapon.'
      + ' This is why two "rebuilds" passed their authors\' checks and failed review.');
    if (!okBlobs) console.log('  -> the hand is not a hand, it is a pile of separate primitives with air'
      + ' between them. Rebuild it as one skinned surface; moving the pieces closer will not pass this.');
    if (!okCyan) console.log('  -> saturated cool rings on the hand. These are Fresnel rim specular of the'
      + ' viewmodel fill light on the grazing band of every separate capsule, and they read as PVC couplings.');
  } catch (err) {
    console.log(`${view}: ${String(err.message).slice(0, 140)}`);
    failed = true;
  }
  await page.close();
}

await browser.close();
console.log(`\n${failed ? 'FAIL' : 'PASS'} — hands ${failed ? 'are NOT correctly on screen' : 'are on screen and on the weapon'}`);
process.exitCode = failed ? 1 : 0;
