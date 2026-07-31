import * as THREE from 'three';
import { VIEWMODEL } from './WeaponData.js';
import { buildWeapon } from './viewmodel/Weapon.js';
import { buildHands } from './viewmodel/Hands.js';
import { buildWeaponMaterials, disposeWeaponMaterials } from './viewmodel/Materials.js';
import { MuzzleFlash } from './viewmodel/Flash.js';

/**
 * OWNER: viewmodel agent. This is the single most-looked-at object in the game —
 * a quarter of every gameplay pixel, for an entire session.
 *
 * CONTRACT
 *   Builds geometry into ctx.viewScene (rendered with ctx.viewCamera, near 0.005).
 *   listens: 'weapon:fire', 'weapon:reload', 'weapon:switch', 'viewmodel:visible',
 *            'weapon:force'
 *   reads:   ctx.get('weapons').state, ctx.get('player').state / .velocity,
 *            ctx.get('sky').sunDirection / sunColour / preset
 *   calls:   ctx.get('lighting').flash(pos, colour, intensity, life)
 *
 * WHAT IS HERE
 *   viewmodel/Shapes.js     chamfered primitive kit + swept prisms with real
 *                           recessed pockets, tagged with a curvature proxy
 *   viewmodel/Textures.js   procedural PBR bakery (albedo / normal / ORM)
 *   viewmodel/Materials.js  material zones + the edge-wear shader
 *   viewmodel/Rail.js       one-mesh Picatinny with a real cross-section, AND
 *                           `buildOptic` — the 1x tube sight, its rings, turrets
 *                           and the transmittance glass. `Weapon.js` imports the
 *                           optic from here.
 *   viewmodel/Weapon.js     the carbine assembly
 *   viewmodel/Optic.js      DEAD. The older open-emitter reflex sight. Nothing
 *                           imports it; read Rail.js for the shipping optic.
 *   viewmodel/Hands.js      gloved hands on a nested matrix skeleton
 *   viewmodel/Flash.js      four-layer additive muzzle flash + discharge light
 *
 * ADS ALIGNMENT
 *   The rig exposes a `sight` anchor at the optic's exit pupil, and the ADS pose
 *   is *computed* from it: adsPos = -sightLocal - (0, 0, EYE_RELIEF). The reticle
 *   therefore lands exactly on the view axis no matter how the optic geometry is
 *   edited. Hand-tuning that offset is how ADS ends up subtly off-centre.
 *
 *   EYE_RELIEF also decides how much of the weapon is *behind* the camera in
 *   ADS. At 82 mm the whole stock, the receiver's rear 90 mm and the firing hand
 *   are all past the near plane, so they are clipped rather than smeared across
 *   the lower half of the frame at grazing incidence.
 */

/**
 * Poses are in camera space: -Z forward, +X right, +Y up. The weapon is authored
 * with its origin at the magwell, so the hip pose pushes it down and right far
 * enough that the rail sits below the crosshair, and yaws the muzzle *inward* so
 * the weapon reads as a diagonal from the bottom-right corner toward the centre.
 * That inward yaw is what makes a hipfire pose look aimed rather than parked.
 *
 * SCREEN FOOTPRINT — solved against measured screen-space extents, not by eye.
 *   The round-6 pose measured x 1016..1434, y 678..1234 at 1080p: 154 px below
 *   the bottom edge, with the magazine, the pistol grip and the entire firing
 *   hand outside the frame. That is what "the rifle floats detached" meant — the
 *   half of the weapon a hand could be holding was not being photographed. The
 *   carbine's pose now measures 1040..1468 x 624..1079, the whole weapon in
 *   frame on a 29-degree diagonal out of the lower-right corner, with only the
 *   forearms leaving it. Positive yaw walks the stock right while bringing the
 *   muzzle to centre: it strengthens the diagonal and costs image area at once.
 *   Per weapon, because a 358 mm SMG and a 718 mm marksman rifle cannot share
 *   one — see `VIEWMODEL[id].pose`.
 */
const ADS_ROT = new THREE.Euler(0, 0, 0, 'YXZ');

/**
 * How far in front of the camera the exit pupil is parked in ADS. Per weapon —
 * `VIEWMODEL[id].optic.relief` — because it is a property of the SIGHT, not of
 * the rig: the WRAITH's 20 mm dot wants the eye closer (76 mm) and the LANCET's
 * 31 mm prism scope wants it further (90 mm). What follows is the derivation for
 * the carbine's 82 mm, and the reasoning transfers to the other two unchanged.
 *
 * This number and the optic's own depth are the two halves of the same problem.
 * A sight 115 mm from the eye reads *small*, and the instinct when the sight
 * picture looks wrong is to push it further away — but distance shrinks the
 * clear window and the housing together, so a housing that was too heavy stays
 * too heavy and simply gets smaller. What actually fixes the sight picture is
 * making the housing thin (see Optic.js), and once it is thin the optic wants to
 * come closer, not further. 82 mm opens the 26.8 x 23.2 mm window to about
 * 245 x 212 px at 1080p inside a 293 x 261 px frame — a 24 px surround, thin
 * enough to read as a hood rather than as a housing, with every pixel inside it
 * showing the same world at the same exposure as the pixels outside.
 *
 * It is not smaller than that because eye relief is a shared control: the same
 * number that shrinks the optic shrinks the receiver ramp under it, and pulling
 * the eye in to 62 mm — which gave a superb sight picture on its own — put the
 * top of the receiver across the entire bottom third of the frame as one smooth
 * grey wedge. 82 mm is where both halves of the composition are right.
 */

/**
 * Holster/draw dip. `WeaponSystem.state.switchProgress` runs 0 -> 0.5 over the
 * outgoing weapon's `holsterTime` and 0.5 -> 1 over the incoming weapon's
 * `drawTime`, so those two fields already drive this curve and there is no second
 * timer here to fall out of step with them. At the midpoint the weapon is 24 cm
 * below the hip pose and rolled 40 degrees muzzle-down, which is far enough out of
 * frame that the geometry swap at `weapon:switch` — which lands exactly there —
 * is never photographed mid-change.
 */
const SWITCH_DROP = 0.2400;

/** Lowered carry used while sprinting. */
const SPRINT_POS = new THREE.Vector3(0.1520, -0.2680, -0.3300);
const SPRINT_ROT = new THREE.Euler(-0.1600, -0.5200, 0.2900, 'YXZ');

/** Reload: the gun rolls in toward the support hand while the mag drops. */
const RELOAD_TIME = 2.15;

/**
 * `?vmpose=<yaw>` holds the weapon broadside at a fixed distance so the asset
 * itself can be reviewed rather than the composition. Yaw is in radians; the
 * default 1.15 is a three-quarter view of the ejection-port side.
 */
const INSPECT_POS = new THREE.Vector3(0.010, -0.020, -0.640);

/** Desaturation target for the viewmodel fill and rim. See `_syncLights`. */
const WHITE = new THREE.Color(1, 1, 1);

export class ViewModel {
  constructor() {
    this.name = 'viewmodel';
    this.visible = true;

    this._t = 0;
    this._recoil = 0;          // 0..1 impulse envelope
    this._recoilVel = 0;       // settle spring
    this._boltT = 1;           // 1 = closed
    this._reloadT = -1;        // <0 = not reloading
    this._forced = { ads: false, firing: false };
    this._breath = 0;

    /**
     * Live copies of the hip pose. Held on the instance rather than read from
     * the module constants so the composition can be swept from the debug rig
     * inside a single page load — a pose is a *screen-space* result of six
     * coupled numbers, and converging it one edit-and-reload at a time is how
     * it stayed cropped against two frame edges for six rounds.
     */
    this.hipPos = new THREE.Vector3();
    this.hipRot = new THREE.Euler(0, 0, 0, 'YXZ');
    /** Which weapon's geometry is currently built. See `_swap`. */
    this.weaponId = null;
    this._pendingId = null;

    // Scratch — update() must not allocate.
    this._pos = new THREE.Vector3();
    this._rot = new THREE.Euler(0, 0, 0, 'YXZ');
    this._adsPos = new THREE.Vector3();
    this._sightLocal = new THREE.Vector3();
    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._q2 = new THREE.Quaternion();
    this._eye = new THREE.Vector3();
    this._camInv = new THREE.Matrix4();
  }

  init(ctx) {
    this.ctx = ctx;
    this.weapons = ctx.get('weapons');
    this.player = ctx.get('player');
    this.lighting = ctx.get('lighting');

    const built = buildWeaponMaterials();
    this.materials = built.mats;
    this._texSets = built.sets;

    this.root = new THREE.Group();
    this.root.name = 'viewmodel';
    // The viewmodel is authored in *camera* space, but CameraRig copies the world
    // camera transform onto ctx.viewCamera every frame — so a root parented
    // straight to viewScene ends up at the world origin, far outside the 12 m
    // view far-plane, and silently culls. Parent to the camera instead (and put
    // the camera in the scene so traversal reaches us).
    if (!ctx.viewCamera.parent) ctx.viewScene.add(ctx.viewCamera);
    ctx.viewCamera.add(this.root);

    /**
     * The hands are built ONCE and re-parented across weapon changes, never
     * rebuilt. They are solved against the pistol grip and the handguard section,
     * both of which `WeaponData.VIEWMODEL` declares invariant across the loadout,
     * so a rebuild would burn 4800 triangles of skinning work and a skeleton
     * rebind to arrive at exactly the pose it already has — and would invalidate
     * `_artic`, whose cached bind quaternions are the only thing keeping the
     * solved contact pose from being overwritten every frame.
     */
    const hands = buildHands(this.materials);
    this.hands = hands;

    /**
     * ALL THREE WEAPONS ARE BUILT HERE, ONCE, AND THE SWITCH IS A RE-PARENT.
     *
     * The obvious implementation is to call `buildWeapon(id)` inside the
     * `weapon:switch` handler and dispose the outgoing rig. It works, it leaks
     * nothing, and it is wrong: `buildWeapon` measures 43.6 ms for the carbine,
     * 36.4 for the WRAITH and 49.3 for the LANCET on this machine, all CPU, before
     * the driver has uploaded a single buffer. That is a three-frame hitch on a
     * 16.7 ms budget, landing on the exact keypress the player is watching — and
     * this project already has a worst-frame problem at 34-37 ms against a 16 ms
     * median, so adding another spike is the one thing the brief rules out.
     *
     * Building all three costs ~130 ms once, inside `init`, next to a texture bake
     * that already takes seconds, and buys a switch that allocates nothing and
     * disposes nothing. The inactive rigs are removed from the scene graph
     * entirely rather than merely hidden, so they cost nothing at traversal
     * either; what they cost is about 8 MB of vertex buffers, which is the
     * cheapest trade on offer here.
     *
     * tools/loadoutcheck.mjs measures the frame times across a live switch and
     * gates the difference against an idle window, which is the assertion that
     * would have caught the rebuild version.
     */
    this._rigs = {};
    for (const id of Object.keys(VIEWMODEL)) this._rigs[id] = buildWeapon(this.materials, id);
    const startId = VIEWMODEL[this.weapons?.current?.id] ? this.weapons.current.id : 'ar_vector';
    const rig = this._rigs[startId];
    this.rig = rig;
    this.weaponId = startId;
    this.root.add(rig.root);
    rig.root.add(hands.group);
    this._applyProfile(rig);

    /**
     * Articulation set: the bones this system rotates at runtime, with their bind
     * rotations cached so a delta is applied to the bind pose rather than
     * replacing it.
     *
     * The hands are bound already wrapped (see Hands.js), so every bone's local
     * rotation at rest is the solved contact pose, not identity. Writing
     * `bone.rotation.x = k` would therefore throw away the solve — the one thing
     * six rounds were spent getting right. `rotateX` on top of a restored bind
     * quaternion is the only safe form, and the cache is what makes it restorable.
     *
     * Built once, here: `update` must not allocate.
     */
    this._artic = [];
    const grab = (side, name, kind) => {
      const b = hands.rigs[side]?.byName?.[name];
      if (b) this._artic.push({ b, bind: b.quaternion.clone(), kind });
    };
    // Trigger finger, all three phalanges — the squeeze.
    for (const k of ['a', 'b', 'c']) grab('right', `f0${k}`, 'trigger');
    // The other three fingers of the firing hand tighten under recoil.
    for (let i = 1; i < 4; i++) grab('right', `f${i}a`, 'grip');
    // Support hand opens a little during the reload roll.
    for (let i = 0; i < 4; i++) grab('left', `f${i}a`, 'support');

    // ---- muzzle flash ------------------------------------------------------
    this.flash = new MuzzleFlash(ctx.viewCamera);

    // ---- view-scene light rig ----------------------------------------------
    // Lighting hands viewScene an environment map but no key light, so the gun
    // would arrive lit by ambient only — flat, with no specular to catch the
    // chamfers. viewScene *is* camera space, so a directional light's direction
    // is simply the world sun rotated into the camera's frame; that keeps the
    // weapon's highlight consistent with the world key at every time of day.
    this.vmKey = new THREE.DirectionalLight(0xfff0d8, 2.4);
    this.vmKey.name = 'vm:key';
    this.vmFill = new THREE.DirectionalLight(0x9fb4cc, 0.55);
    this.vmFill.name = 'vm:fill';
    // A rim from behind-right separates the receiver from the background.
    this.vmRim = new THREE.DirectionalLight(0xbcd0e8, 0.85);
    this.vmRim.name = 'vm:rim';
    this.vmRim.position.set(-0.55, 0.62, 1.0);
    /**
     * Warm wrap from below. Raised from 0.30 and warmed, because the hands live on
     * the weapon's underside and far flank: this is the only light in the rig
     * aimed at them that carries any warmth at all, and without it their entire
     * chroma comes from a sky-coloured fill (see `_syncLights`).
     */
    this.vmBounce = new THREE.DirectionalLight(0x7c6446, 0.46);
    this.vmBounce.name = 'vm:bounce';
    this.vmBounce.position.set(0.2, -1, 0.35);
    /**
     * WARM WRAP. A hemisphere light, and the last piece of the cyan fix.
     *
     * After the fill and rim were desaturated, the pixels still failing the hue
     * assertion were the DARKEST ones — deep-shadow hand pixels around value 0.26
     * lit only by the environment probe, which is a PMREM of the sky and therefore
     * blue. Blue irradiance times a warm albedo lands neutral for exactly the
     * reason the fill did (see `_syncLights`), and no amount of desaturating the
     * directional lights reaches those pixels because no directional light is
     * lighting them. A hemisphere light does: its lower half is a warm dust bounce
     * aimed up at the underside of everything — which is where the hands are — and
     * it is DIFFUSE ONLY, so unlike every other lever here it cannot add a grazing
     * specular of its own. It is also what a low sun over dusty concrete does.
     */
    this.vmWrap = new THREE.HemisphereLight(0xa8b4c4, 0x8b6d48, 0.42);
    this.vmWrap.name = 'vm:wrap';
    ctx.viewScene.add(this.vmKey, this.vmFill, this.vmRim, this.vmBounce, this.vmWrap);

    /**
     * ---- NO SHELL CASINGS HERE. THIS SYSTEM DOES NOT EJECT BRASS. -----------
     *
     * A pool of eight brass MESHES used to live here, parented to `viewCamera`.
     * The model was never wrong (39 mm, correct 5.56 case); the SCENE was.
     * `viewScene` composites over the world with no shared depth buffer and the
     * meshes ran `frustumCulled = false`, so a case 0.85 m from the lens drew on
     * top of a building 47 m behind it — which reads as a metre-long object lying
     * downrange. tools/fxcheck.mjs measured 7.03 m apparent length, 80 samples
     * above the eye plane. And it was pure DUPLICATION: `WeaponSystem` already
     * emits `shell:eject`, and `Particles._onShell` spawns a depth-tested
     * billboard case in the WORLD scene that measures 0.48 m and 0 samples above
     * the eye plane. Every shot threw two cases and one of them was broken.
     * The fix was a deletion, not a tuning pass.
     */

    ctx.bus.on('viewmodel:visible', ({ visible }) => { this.visible = visible; });
    ctx.bus.on('weapon:fire', () => this._onFire());
    ctx.bus.on('weapon:reload', () => { this._reloadT = 0; });
    /**
     * THE ROOT CAUSE THIS SYSTEM SHIPPED WITH FOR SIX ROUNDS.
     *
     * This handler used to be `() => { this._reloadT = 0; }` and nothing else,
     * while `buildWeapon()` ran once in `init`. Keys 1/2/3 therefore changed the
     * name, the ammo, the RPM, the spread model and the recoil pattern — and
     * rendered the same carbine every time. The player's report was "there is no
     * alternative gun", for three guns that were already in the build.
     *
     * `WeaponSystem` emits this at the END of the holster stage, i.e. at
     * switchProgress 0.5, which is the frame the weapon is furthest out of shot.
     * Swapping the geometry here rather than on the keypress is what makes the
     * change invisible; deferring it to the next `update` would put it one frame
     * into the draw, where it is not.
     */
    ctx.bus.on('weapon:switch', ({ to }) => {
      this._reloadT = 0;
      if (to?.id) this._swap(to.id);
    });
    ctx.bus.on('weapon:force', ({ ads, firing }) => {
      if (ads !== undefined) this._forced.ads = !!ads;
      if (firing !== undefined) this._forced.firing = !!firing;
    });

    // Asset-review pose. Reading the query string directly keeps the shared
    // screenshot rig untouched; it is inert unless the parameter is present.
    if (typeof location !== 'undefined') {
      const q = new URLSearchParams(location.search);
      const p = q.get('vmpose');
      if (p !== null) this._inspect = p === '' ? 1.15 : parseFloat(p);
      if (Number.isNaN(this._inspect)) this._inspect = 1.15;
      /**
       * `?vmstate=sprint|reload|walk` forces a pose the rig cannot otherwise
       * reach. `?ads` and `?fire` already exist; sprint and reload did not, which
       * means the hands were only ever reviewed in the one frozen hipfire frame
       * and "do they hold in every pose?" was answered by argument rather than by
       * a photograph. Reload also needs a phase, so `vmphase=0..1` picks a point
       * in the 2.15 s animation (default 0.38, where the magazine is clear of the
       * well and the weapon is at maximum roll).
       */
      this._state = q.get('vmstate');
      const ph = parseFloat(q.get('vmphase'));
      this._phase = Number.isNaN(ph) ? 0.38 : ph;
      /**
       * `?weapon=0|1|2` or `?weapon=smg_wraith` selects a loadout slot before the
       * first frame, which is what lets a screenshot of the WRAITH be a screenshot
       * and not a recording of a switch animation.
       *
       * It goes through `WeaponSystem` rather than swapping this system's
       * geometry alone, so the ammo counter, the weapon name and the fire-mode
       * readout in the HUD follow — those all read `weapons.current`, and a
       * viewmodel-only override would have produced screenshots of a WRAITH
       * labelled VK-7. `_applySlot` is the only entry point that system exposes
       * for an instant change; a `weapon:select` event on the bus would be the
       * cleaner seam and is noted as a request to the weapons agent.
       */
      const wq = q.get('weapon');
      if (wq !== null && this.weapons) {
        const order = this.weapons.slots.map((s) => s.id);
        const i = /^\d+$/.test(wq) ? +wq : order.indexOf(wq);
        if (i >= 0 && i < order.length && this.weapons._applySlot) {
          this.weapons._applySlot(i);
          this.weapons.state.slot = i;
          this._swap(this.weapons.current.id);
        }
      }
    }

    // Sit at rest before the first frame so a frozen page is already posed.
    this._applyPose(0, null, 0);
  }

  // -------------------------------------------------------------------------

  /**
   * Adopt a rig's weapon profile: hip pose, and the ADS pose computed from that
   * weapon's own sight anchor and eye relief.
   *
   * The ADS pose is DERIVED, never authored — `adsPos = -sightLocal - (0,0,relief)`
   * — which is what makes the reticle land on the view axis for a 20 mm dot, a
   * 24 mm dot and a 31 mm prism scope from one expression. Hand-tuning three
   * offsets is how three weapons end up with two of them subtly off-centre.
   */
  _applyProfile(rig) {
    const P = VIEWMODEL[rig.id] ?? VIEWMODEL.ar_vector;
    this.hipPos.fromArray(P.pose.hip);
    this.hipRot.set(P.pose.rot[0], P.pose.rot[1], P.pose.rot[2], 'YXZ');
    this._sightLocal.copy(rig.sight.position);
    this._adsPos.set(
      -this._sightLocal.x,
      -this._sightLocal.y,
      -this._sightLocal.z - P.optic.relief,
    );
    this.triangles = rig.triangles + (this.hands?.triangles ?? 0);
  }

  /**
   * Put a different weapon in the player's hands. Four object references and a
   * re-parent — no geometry is built, uploaded, disposed or allocated, which is
   * the whole reason all three rigs exist before this is ever called.
   *
   * The hands move across rather than being rebuilt: they are solved against the
   * pistol grip and the handguard section, both declared invariant across the
   * loadout, so the pose they already hold is the pose they should hold on the
   * incoming weapon. `_artic`'s cached bind quaternions therefore stay valid too.
   */
  _swap(id) {
    const rig = this._rigs?.[id];
    if (!rig || rig === this.rig) return;
    rig.root.add(this.hands.group);
    this.root.add(rig.root);
    this.rig.root.removeFromParent();
    this.rig = rig;
    this.weaponId = id;
    this._applyProfile(rig);
    this._boltT = 1;
  }

  /**
   * Materials and textures are SHARED and are torn down once, by `dispose`. What
   * is per-rig — every BufferGeometry in `rig.meshes` plus the optic's four loose
   * objects — is released here; the eyecup shade's geometry and material are
   * chained off the lens geometry's own dispose event (Rail.js), so releasing the
   * lens releases them too.
   */
  _disposeRig(rig) {
    for (const mesh of rig.meshes) mesh.geometry.dispose();
    rig.optic.lens.geometry.dispose();
    rig.optic.reticle.geometry.dispose();
    rig.optic.lensMat.dispose();
    rig.optic.reticleMat.dispose();
  }

  _onFire() {
    this._recoil = 1;
    this._recoilVel = 0;
    this._boltT = 0;
    this.flash.trigger();
    // A muzzle flash is a light, not just a sprite — let the world see it.
    if (this.lighting?.flash) {
      this.rig.muzzle.updateWorldMatrix(true, false);
      this._v.setFromMatrixPosition(this.rig.muzzle.matrixWorld);
      this.lighting.flash(this._v, 0xffd2a0, 8, 0.055);
    }
  }

  /**
   * Rotate the world sun into camera space so the weapon's key light tracks the
   * scene's. Allocation-free: reuses `_q` and `_v`.
   */
  _syncLights(ctx) {
    const sky = ctx.get('sky');
    if (!sky?.sunDirection) return;
    this._q.copy(ctx.camera.quaternion).invert();
    this._v.copy(sky.sunDirection).applyQuaternion(this._q);
    this.vmKey.position.copy(this._v).multiplyScalar(4);
    if (sky.sunColour) this.vmKey.color.copy(sky.sunColour);
    // Track the preset's own intensity but compress it hard — a viewmodel lit at
    // full sun intensity blows out long before the world does.
    const lit = Math.max(0, sky.sunDirection.y);
    this.vmKey.intensity = 0.55 + Math.min(2.6, (sky.preset?.intensity ?? 3) * 0.55) * (0.35 + lit * 0.65);
    // Fill from the opposite side, tinted by the sky.
    this.vmFill.position.set(-this._v.x, Math.abs(this._v.y) * 0.5 + 0.5, -this._v.z).multiplyScalar(4);
    /**
     * THE FILL IS DESATURATED, AND THIS IS THE LARGER HALF OF THE TEAL-RING FIX.
     *
     * Copying the sky colour straight onto the fill and rim looks physically
     * honest and is the reason the gloves photographed cyan for three rounds. The
     * arithmetic at golden hour: sky #93a5c6 is linear (0.292, 0.376, 0.565) and
     * the glove's albedo is linear (0.195, 0.152, 0.101) — red:blue 1.92,
     * deliberately, so the hands could not read as more receiver. Multiplied:
     *
     *     diffuse = (0.0569, 0.0572, 0.0573)      red:blue 0.99
     *
     * The fill's chroma cancels the albedo's EXACTLY, so every surface lit mainly
     * by the fill — every surface of a hand hanging under a weapon — arrives
     * neutral, and the smallest specular then tips it green-cyan, because specular
     * on a dielectric is not tinted by albedo. That is the mechanism, and it is
     * why the geometry rebuild alone did not remove it.
     *
     * So the fill keeps the sky's hue *direction* and loses most of its
     * saturation, the rim keeps more (a thin cool separation edge is worth
     * having), and the warm bounce from below comes up. Doses are measured, not
     * judged: handcheck's cyan share went 1.62% -> 0.486% at fill 0.58 / rim 0.30,
     * so both went up one step and the fabric zones' specular ceiling came down
     * with them. The rim needed the larger increase — the firing hand's fingertips
     * sit on the grip's LEFT flank, facing the rim, and that is where the worst
     * remaining pixel was.
     */
    if (sky.skyColour) {
      /**
       * Both doses went up one more step when the support forearm was bulked for
       * realism. A thicker limb presents a WIDER grazing band to the rim, which
       * is precisely where this artefact lives, so the same tuning that passed on
       * a thin arm put peak saturation at 0.373 against a 0.34 ceiling — the
       * count was still fine at 0.166% of 0.4%, so it was the hottest few pixels
       * on the new forearm's silhouette, not a general regression.
       */
      this.vmFill.color.copy(sky.skyColour).lerp(WHITE, 0.82);
      this.vmRim.color.copy(sky.skyColour).lerp(WHITE, 0.72);
    }
    const amb = sky.preset?.ambient ?? 0.4;
    this.vmFill.intensity = 0.35 + amb * 0.55;
    this.vmRim.intensity = 0.45 + amb * 0.85;
    // Sky half tracks the preset; ground half stays warm dust at every time of day,
    // because that is what the ground under this level is.
    this.vmWrap.color.copy(this.vmFill.color);
    /**
     * Raised with the bulked forearm. The residual cyan in ADS is on the DARKEST
     * hand pixels — the ones lit only by the blue sky probe, which no amount of
     * desaturating the directional lights can reach, because no directional light
     * is lighting them. The warm lower hemisphere is the only lever that touches
     * those, and a thicker arm simply has more surface sitting in that shadow.
     */
    this.vmWrap.intensity = 0.28 + amb * 0.62;
  }

  update(dt, ctx) {
    this.root.visible = this.visible;
    if (!this.visible) {
      this.flash.group.visible = false;
      return;
    }

    this._t += dt;
    this._syncLights(ctx);

    const st = this.weapons?.state;
    const pst = this.player?.state;

    // ---- ADS ---------------------------------------------------------------
    let ads = st?.adsProgress ?? 0;
    if (this._forced.ads) ads = 1;

    // ---- recoil / bolt -----------------------------------------------------
    if (this._forced.firing) {
      // Hold a readable mid-event pose instead of letting it decay away.
      this._recoil = 0.62;
      this._boltT = 0.45;
      this.flash.hold(0.74);
    } else {
      // Critically damped settle: a hard impulse then a soft return, which reads
      // as mass. A plain linear decay reads as an animation curve.
      const k = 128, c = 20;
      this._recoilVel += (-k * this._recoil - c * this._recoilVel) * dt;
      this._recoil += this._recoilVel * dt;
      if (Math.abs(this._recoil) < 0.0008 && Math.abs(this._recoilVel) < 0.01) {
        this._recoil = 0; this._recoilVel = 0;
      }
      this._boltT = Math.min(1, this._boltT + dt * 17.0);
    }

    if (this._reloadT >= 0) {
      this._reloadT += dt;
      if (this._reloadT > RELOAD_TIME) this._reloadT = -1;
    }

    this._applyPose(ads, pst, dt);
    this._articulate();
    this._updateFlash(dt, ads);
  }

  /**
   * Deform the gloved hands on their skeletons.
   *
   * Amplitudes are deliberately small — 3 to 6 degrees. The point is not
   * animation, it is that the hand is a skinned surface and therefore CAN deform:
   * a fist that tightens by a few degrees as the weapon kicks reads as grip, and a
   * capsule chain physically cannot do it without opening a gap at every joint.
   * Large amplitudes would also risk walking the solved contact pose off the
   * weapon, and that pose is the expensive thing here.
   *
   * Allocation-free: the bind quaternions are cached and `rotateX` writes in place.
   */
  _articulate() {
    if (!this._artic.length) return;
    const r = Math.max(0, Math.min(1, this._recoil));
    const rel = this._reloadT >= 0
      ? Math.sin(Math.min(1, (this._reloadT / RELOAD_TIME) * 1.6) * Math.PI)
      : 0;
    for (const a of this._artic) {
      a.b.quaternion.copy(a.bind);
      if (a.kind === 'trigger') a.b.rotateX(0.055 * r);
      else if (a.kind === 'grip') a.b.rotateX(0.038 * r);
      else a.b.rotateX(-0.085 * rel);
    }
  }

  _applyPose(ads, pst = null, dt = 0) {
    const rig = this.rig;
    const sway = 1 - ads * 0.86;          // ADS damps the idle motion right down
    const t = this._t;

    if (this._inspect !== undefined) {
      this._pos.copy(INSPECT_POS);
      this._rot.set(0.10, this._inspect, 0.04);
      this.root.position.copy(this._pos);
      this.root.rotation.copy(this._rot);
      rig.bolt.position.z = 0;
      rig.mag.position.set(0, 0, 0);
      rig.mag.rotation.set(0, 0, 0);
      this.rig.optic.reticleMat.uniforms.uInt.value = 5.4;
      return;
    }

    // ---- base pose: hip <-> ADS, with a sprint carry on top ----------------
    const forcedSprint = this._state === 'sprint';
    if (this._state === 'reload') this._reloadT = this._phase * RELOAD_TIME;
    const sprint = forcedSprint || (pst?.sprinting && ads < 0.05) ? 1 : 0;
    this._pos.copy(this.hipPos).lerp(this._adsPos, ads);
    this._rot.set(
      THREE.MathUtils.lerp(this.hipRot.x, ADS_ROT.x, ads),
      THREE.MathUtils.lerp(this.hipRot.y, ADS_ROT.y, ads),
      THREE.MathUtils.lerp(this.hipRot.z, ADS_ROT.z, ads),
    );
    if (sprint) {
      this._pos.lerp(SPRINT_POS, 0.85);
      this._rot.x = THREE.MathUtils.lerp(this._rot.x, SPRINT_ROT.x, 0.85);
      this._rot.y = THREE.MathUtils.lerp(this._rot.y, SPRINT_ROT.y, 0.85);
      this._rot.z = THREE.MathUtils.lerp(this._rot.z, SPRINT_ROT.z, 0.85);
    }

    // ---- breathing ---------------------------------------------------------
    // A slow 0.22 Hz cycle with a held top: the weapon rises on the inhale and
    // settles a touch faster than it rose. Damped hard but never fully off in
    // ADS, because a perfectly still weapon reads as a static mesh.
    this._breath = Math.sin(t * 1.38);
    const br = this._breath * (0.28 + 0.72 * sway);
    this._pos.y += br * 0.0026;
    this._pos.z += Math.cos(t * 1.38) * 0.0012 * (0.25 + 0.75 * sway);
    this._rot.x += br * 0.0055;

    // ---- idle sway (two incommensurate frequencies so it never loops) ------
    this._pos.x += (Math.sin(t * 0.83) * 0.0040 + Math.sin(t * 1.71) * 0.0015) * sway;
    this._pos.y += (Math.cos(t * 1.13) * 0.0032 + Math.sin(t * 2.31) * 0.0011) * sway;
    this._rot.z += Math.sin(t * 0.67) * 0.0115 * sway;
    this._rot.y += Math.cos(t * 0.51) * 0.0090 * sway;

    // ---- walk cycle --------------------------------------------------------
    const speed = pst ? Math.min(1, (this.player?.velocity?.length?.() ?? 0) / 5.2) : 0;
    if (speed > 0.02) {
      const w = t * (sprint ? 13.0 : 9.0);
      // A figure-eight, not a circle: the vertical runs at twice the lateral
      // frequency because each stride has two footfalls.
      this._pos.x += Math.sin(w) * 0.0100 * speed * sway;
      this._pos.y += Math.abs(Math.cos(w)) * -0.0086 * speed * sway;
      this._rot.z += Math.sin(w) * 0.0290 * speed * sway;
      this._rot.x += Math.cos(w * 2) * 0.0075 * speed * sway;
    }

    // ---- recoil: straight back, muzzle up, slight roll ---------------------
    const r = Math.max(0, this._recoil);
    const rr = r * r;
    this._pos.z += r * 0.0290 * (1 - ads * 0.48);
    this._pos.y += rr * 0.0055;
    this._pos.x += r * 0.0042 * (1 - ads * 0.6);
    this._rot.x -= r * 0.1150 * (1 - ads * 0.42);
    this._rot.z += r * 0.0230;
    this._rot.y -= r * 0.0140 * (1 - ads * 0.7);

    // ---- holster / draw ----------------------------------------------------
    /**
     * Read straight off `WeaponSystem.state.switchProgress`, which is itself
     * `t / holsterTime` then `t / drawTime` — so the WRAITH's 0.21 s stow and
     * 0.34 s draw are genuinely quicker than the LANCET's 0.32 / 0.52, without a
     * duplicate timer here that could disagree with the system deciding when the
     * weapon may fire again. Squared on the way down and eased on the way up: a
     * draw that arrives slower than it left is what gives the swap any weight.
     */
    const st2 = this.weapons?.state;
    if (st2?.switching) {
      const p = st2.switchProgress ?? 0;
      const d = p < 0.5 ? (p * 2) ** 1.7 : 1 - THREE.MathUtils.smoothstep(p, 0.5, 1);
      this._pos.y -= d * SWITCH_DROP;
      this._pos.z += d * 0.0900;
      this._pos.x += d * 0.0450;
      this._rot.x -= d * 0.7000;
      this._rot.z += d * 0.3600;
    }

    // ---- reload: drop the mag, tilt the gun in -----------------------------
    if (this._reloadT >= 0) {
      const p = this._reloadT / RELOAD_TIME;
      const tilt = Math.sin(Math.min(1, p * 1.6) * Math.PI);
      this._rot.z += tilt * 0.5200;
      this._rot.x += tilt * 0.2600;
      this._rot.y += tilt * 0.1800;
      this._pos.y -= tilt * 0.0520;
      this._pos.x += tilt * 0.0180;
      // Magazine out for the middle half of the animation, and it falls away
      // rather than sinking straight down.
      const out = THREE.MathUtils.smoothstep(p, 0.12, 0.34)
        * (1 - THREE.MathUtils.smoothstep(p, 0.58, 0.82));
      rig.mag.position.y = -out * 0.1750;
      rig.mag.position.z = out * 0.0180;
      rig.mag.rotation.z = out * 0.3200;
      rig.mag.rotation.x = out * 0.1400;
      rig.mag.visible = out < 0.97;
      // The bolt is locked back for the first half of a dry reload.
      if (p < 0.62) this._boltT = Math.min(this._boltT, 0.15);
    } else {
      rig.mag.position.set(0, 0, 0);
      rig.mag.rotation.set(0, 0, 0);
      rig.mag.visible = true;
    }

    this.root.position.copy(this._pos);
    this.root.rotation.copy(this._rot);

    // ---- bolt travel -------------------------------------------------------
    // 0 = fully rearward. Back fast, forward a touch slower.
    rig.bolt.position.z = (1 - this._boltT) * 0.0420;

    // ---- reticle parallax --------------------------------------------------
    // A collimated dot does not walk with eye position the way a magnified
    // reticle does, but it *does* drift toward the edge of the window as the eye
    // moves off axis — which is exactly what you want visible in hipfire, and
    // exactly zero in ADS because the ADS pose puts the eye on the axis.
    const ret = this.rig.optic.reticleMat.uniforms;
    this._q2.setFromEuler(this._rot).invert();
    this._eye.copy(this._pos).negate().applyQuaternion(this._q2);
    const win = this.rig.optic.window;
    const k = 0.058;
    ret.uOff.value.set(
      THREE.MathUtils.clamp(this._eye.x * k, -win.w * 0.40, win.w * 0.40),
      THREE.MathUtils.clamp((this._eye.y - rig.layout.opticAxisY) * k, -win.h * 0.40, win.h * 0.40),
    );
    ret.uInt.value = 5.4 + ads * 1.2;
  }

  /** Position the flash at the muzzle, expressed in camera space. */
  _updateFlash(dt, ads) {
    this._q2.setFromEuler(this._rot);
    this._v.copy(this.rig.muzzle.position).applyQuaternion(this._q2).add(this._pos);
    this._v2.set(0, 0, -1).applyQuaternion(this._q2);
    this.flash.update(dt, this._v, this._v2);
    // Down the barrel in ADS the flash sits dead centre; pull it back a little
    // so the plume does not wash the reticle out completely.
    this.flash.group.scale.setScalar(1 - ads * 0.18);
  }

  resize(w, h, ctx) {
    // The viewmodel FOV is deliberately narrower than the world FOV so the gun
    // keeps its proportions on ultrawide displays.
    ctx.viewCamera.fov = 65;
    ctx.viewCamera.updateProjectionMatrix();
  }

  dispose() {
    this.root.removeFromParent();
    for (const id of Object.keys(this._rigs)) this._disposeRig(this._rigs[id]);
    for (const mesh of this.hands.meshes) mesh.geometry.dispose();
    this.flash.dispose();
    disposeWeaponMaterials(this.materials, this._texSets);
  }
}
