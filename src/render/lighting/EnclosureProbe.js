import * as THREE from 'three';

/**
 * OWNER: lighting agent.
 *
 * "Is the camera inside a building?", as a 0..1 value, from an upward fan of
 * raycasts against the level's collider group. Nothing else in the project can
 * answer this — there is no level-side volume tag — and the lighting rig needs it
 * because an interior wants a completely different scattering medium from open
 * sky (see LightRigs.interior) and the window-portal emitters must idle at zero
 * outdoors.
 *
 * ROUND 8: this used to be five rays inside a 25 deg cap, thresholded on coverage
 * alone, and it could not tell the open yard from the west hall. That was written
 * up as a limitation that needed a level-side volume tag to fix. It does not — the
 * signal a ray fan carries and the old test threw away is HOW FAR UP the blocker
 * is. Measured at every shot position with 16 rays over a 45 deg cap and a 26 m
 * reach:
 *
 *                              coverage   mean hit distance
 *   hero (6,1.7,14)              0.000        —
 *   vertical (0,6.5,0)           0.063       4.8 m
 *   silhouette (20,1.7,0)        0.250       3.6 m
 *   combat (4,1.7,6)             0.563       2.4 m   <- gantry overhead, outdoors
 *   material-closeup (2,1.4,3)   1.000       3.0 m   <- pipe rack overhead, outdoors
 *   west hall (-8,1.7,-4)        0.625       8.3 m   <- an actual ceiling
 *
 * Coverage alone cannot separate those: `material-closeup` fills the fan
 * completely and is unambiguously outdoors, while the hall — whose roof has large
 * openings — fills only 5/8 of it. Mean hit distance separates them cleanly and
 * with a wide margin: every outdoor position in the shot list is under something
 * 2.4-4.8 m up, the hall's ceiling is 8.3 m up, and nothing sits in between. So
 * the test is coverage x ceiling height, and it now returns exactly 1.0 for the
 * hall and exactly 0.0 for all five outdoor framings.
 *
 * This mattered more in round 8 than it had before, because the interior medium
 * is now ~15x stronger: with the old probe, `material-closeup` read as enclosed
 * and the frame went milky — the sky lost its clouds and the far towers lost their
 * contrast. That regression is what sent this back for a real fix rather than for
 * a smaller number.
 *
 * Cost: 16 raycasts against the collider group, 0.5 ms measured, fired every
 * 0.24 s — about 0.2% of one core. Between fires the value eases toward the last
 * measurement, so walking through a doorway ramps the medium instead of snapping
 * it. Nothing here allocates after construction.
 */

/** Metres. A hit further up than this is a crane or a tower, not a ceiling. */
const ROOF_REACH = 26;
/** Blocked fraction of the fan at which the camera starts to count as enclosed. */
const ROOF_OPEN = 0.30;
/** Blocked fraction at which it counts as fully enclosed. */
const ROOF_SEALED = 0.62;
/** Metres. A blocker this close overhead is an object you are under, not a room. */
const CEILING_NEAR = 4.5;
/** Metres. At or above this, the blocker is a building's ceiling. */
const CEILING_FAR = 7.5;
/** Seconds between fans. */
const INTERVAL = 0.24;
/** Ease rate toward the last measurement, per second. */
const EASE = 2.4;

/**
 * Low-discrepancy spiral over a spherical cap of half-angle `deg`, centred on +Y.
 * Deterministic, so the numbers in the table above are reproducible.
 */
function buildFan(deg, count) {
  const out = [];
  const cosMax = Math.cos(THREE.MathUtils.degToRad(deg));
  for (let i = 0; i < count; i++) {
    const t = (i + 0.5) / count;
    const cy = 1 - t * (1 - cosMax);
    const r = Math.sqrt(Math.max(0, 1 - cy * cy));
    const a = i * 2.39996323;   // golden angle
    out.push(new THREE.Vector3(r * Math.cos(a), cy, r * Math.sin(a)).normalize());
  }
  return out;
}

const FAN = buildFan(45, 16);

export class EnclosureProbe {
  constructor() {
    /** Eased 0..1 enclosure. This is the number the rig blends media with. */
    this.value = 0;
    /** The most recent raw measurement. */
    this.target = 0;
    /** Diagnostics: the last fan's blocked fraction and mean hit distance. */
    this.coverage = 0;
    this.meanDepth = 0;

    this._timer = 0;
    this._origin = new THREE.Vector3();
    this._ray = new THREE.Raycaster();
    this._ray.firstHitOnly = true;
    /** Reused hit buffer: intersectObject allocates a fresh array otherwise. */
    this._hits = [];
  }

  /**
   * @param {number} dt seconds
   * @param {THREE.Camera} camera
   * @param {THREE.Object3D|null|undefined} colliders the level's collider group
   * @returns {number} the eased enclosure value
   */
  update(dt, camera, colliders) {
    this._timer -= dt;
    if (this._timer > 0) {
      const k = 1 - Math.exp(-dt * EASE);
      this.value += (this.target - this.value) * k;
      return this.value;
    }
    this._timer = INTERVAL;

    if (!colliders || colliders.children.length === 0) {
      this.target = 0;
      this.coverage = 0;
      this.meanDepth = 0;
      return this.value;
    }

    camera.getWorldPosition(this._origin);
    this._origin.y += 0.4;
    let covered = 0;
    let depthSum = 0;
    const hits = this._hits;
    for (let i = 0; i < FAN.length; i++) {
      this._ray.set(this._origin, FAN[i]);
      this._ray.near = 0.5;
      this._ray.far = ROOF_REACH;
      hits.length = 0;
      this._ray.intersectObject(colliders, true, hits);
      if (hits.length) { covered++; depthSum += hits[0].distance; }
    }
    hits.length = 0;

    this.coverage = covered / FAN.length;
    this.meanDepth = covered > 0 ? depthSum / covered : 0;

    // 0 below ROOF_OPEN of the fan blocked, 1 at ROOF_SEALED and above.
    const cov = THREE.MathUtils.clamp(
      (this.coverage - ROOF_OPEN) / (ROOF_SEALED - ROOF_OPEN), 0, 1,
    );
    // How far up whatever is blocking the fan sits. Averaging over HITS ONLY — a
    // ray that reaches open sky contributes nothing to the mean — is what makes
    // this the right test: if the thing above you is close, you are under an
    // object, not inside a room, however completely it fills the fan.
    const ceiling = THREE.MathUtils.clamp(
      (this.meanDepth - CEILING_NEAR) / (CEILING_FAR - CEILING_NEAR), 0, 1,
    );
    this.target = cov * ceiling;
    return this.value;
  }
}
