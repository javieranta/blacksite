import * as THREE from 'three';
import { VIEWMODEL } from '../WeaponData.js';
import { Mesher, boxG, cylG, prismG, rectProfile, octProfile, knurlG } from './Shapes.js';
import { buildRail, buildRailStub, buildOptic, RAIL_HEIGHT } from './Rail.js';

/**
 * OWNER: viewmodel agent.
 *
 * The three weapons in the loadout, assembled from real mechanical parts at real
 * proportions. Everything is metres in weapon space, origin at the centre of the
 * magwell, bore along -Z.
 *
 * ONE ASSEMBLY, THREE PROFILES. Every dimension that differs between the VK-7
 * carbine, the WRAITH-9 and the LANCET MK4 lives in `WeaponData.VIEWMODEL` and
 * arrives here as `L`. This file holds the *assembly* -- which part bolts to
 * which, and the offsets that are genuinely shared because the three weapons
 * share a lower receiver and a handguard section (see the invariants on that
 * table; the gloved hands are solved against those two surfaces, and Hands.js is
 * not this agent's file).
 */

/**
 * SIGHT HEIGHT AND STATION set how much weapon is on screen in ADS, and they are
 * the only levers the profile has for it. The ADS pose is computed, not authored:
 * ViewModel parks the exit pupil `optic.relief` in front of the eye and lets the
 * rest of the weapon fall where it falls, so the camera ends up `opticAxisY` high
 * and `pupilZ + relief` back. The round-9 review measured the carbine's housing at
 * 26% of frame width with housing plus receiver filling the bottom 45%; three
 * geometric changes fixed it, all still encoded in `VIEWMODEL.ar_vector`. A
 * physically smaller optic (a 28.8 mm round tube, so its widest dimension is its
 * only one); 33 mm of sight height over rail instead of 29, dropping the receiver
 * 41 px further below the sight line; and the optic moved to the
 * receiver-handguard junction. That last is the big lever -- eye relief is
 * measured from the pupil, so walking the optic forward walks the CAMERA forward,
 * and the stock, buffer tube, charging handle and the whole rear half of the lower
 * end up behind the near plane, clipped instead of smeared across the lower frame.
 *
 * @param {string} id weapon id from WeaponData
 */
export function layoutFor(id) {
  const P = VIEWMODEL[id] ?? VIEWMODEL.ar_vector;
  const L = { id: VIEWMODEL[id] ? id : 'ar_vector', ...P };
  L.railTop = L.railY + RAIL_HEIGHT;
  L.opticAxisY = L.railTop + P.optic.rise;
  L.opticZ = P.optic.z;
  return L;
}

/** The carbine's layout, kept as a named export for tools/opticcheck.mjs. */
export const LAYOUT = layoutFor('ar_vector');

/* Rotated-frame offset helper: place a detail relative to a raked parent. */
const _o = new THREE.Vector3();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _e2 = new THREE.Euler(0, 0, 0, 'YXZ');
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
/**
 * `lrx`/`lry`/`lrz` in `extra` are the part's OWN rake and they COMPOSE with the
 * frame's rather than replacing it — which is what lets the stock be authored once
 * and then folded 160 degrees for the SMG without every raked sub-part (sling
 * loop, adjustment lever, QD socket) snapping back to the weapon's own axes.
 */
function at(base, lx, ly, lz, extra) {
  _e.set(base.rx ?? 0, base.ry ?? 0, base.rz ?? 0, 'YXZ');
  _q.setFromEuler(_e);
  _o.set(lx, ly, lz).applyQuaternion(_q);
  const out = {
    x: base.x + _o.x, y: base.y + _o.y, z: base.z + _o.z,
    rx: base.rx ?? 0, ry: base.ry ?? 0, rz: base.rz ?? 0,
    ...extra,
  };
  if (extra && (extra.lrx || extra.lry || extra.lrz)) {
    _e2.set(extra.lrx ?? 0, extra.lry ?? 0, extra.lrz ?? 0, 'YXZ');
    _q2.setFromEuler(_e2).premultiply(_q);
    _e2.setFromQuaternion(_q2, 'YXZ');
    out.rx = _e2.x; out.ry = _e2.y; out.rz = _e2.z;
    delete out.lrx; delete out.lry; delete out.lrz;
  }
  return out;
}

/* ------------------------------------------------------------------ upper */

function upperReceiver(m, L) {
  const hw = L.upperW / 2, hh = L.upperH / 2;
  const mid = (L.upperZ0 + L.upperZ1) / 2, span = L.upperZ1 - L.upperZ0;
  m.use('steel');
  // One swept prism with a genuine through-hole for the ejection port: no floor,
  // so the bolt carrier behind it is actually visible and actually moves.
  //
  // The chamfer is 7.8 mm, not 4.6. "Chamfers that do not catch light" is a
  // resolution complaint as much as a shading one: a 4.6 mm bevel on a 40 mm box
  // is a 3 px strip at hipfire scale and cannot carry a highlight wide enough to
  // read as an edge. At 7.8 mm the four long edges become 45-degree facets 8-10 px
  // wide, each at a different angle to the key -- the cheapest legibility per
  // triangle anywhere on the gun.
  prismG(m, {
    y: L.upperY,
    profile: rectProfile(L.upperW, L.upperH, 0.0078),
    z0: L.upperZ0, z1: L.upperZ1,
    slots: {
      2: {
        spans: [{ a: L.upperZ0 + 0.0370, b: L.upperZ0 + 0.0910 }],
        halfW: 0.0108, depth: 0.0105, noFloor: true,
      },
    },
  });

  // Dark receiver interior so the port never reads as a see-through slot.
  m.use('bore');
  boxG(m, { x: -0.0045, y: L.upperY, z: mid - 0.0050,
    w: L.upperW - 0.0175, h: L.upperH - 0.0100, d: span - 0.0240, c: 0.0004, simple: true });

  m.use('steel');
  // brass deflector — the angled boss behind the port
  boxG(m, { x: hw - 0.0018, y: L.upperY + 0.0098, z: L.upperZ0 + 0.1020, rz: -0.44,
    w: 0.0105, h: 0.0230, d: 0.0250, c: 0.0013 });
  // ejection port cover, hanging open below the port
  boxG(m, { x: hw + 0.0012, y: L.upperY - 0.0195, z: L.upperZ0 + 0.0640, rz: -0.22,
    w: 0.0030, h: 0.0250, d: 0.0530, c: 0.0008 });
  cylG(m, { x: hw + 0.0006, y: L.upperY - 0.0088, z: L.upperZ0 + 0.0640, r0: 0.0018, len: 0.0560, seg: 8 });
  // forward assist
  boxG(m, { x: -(hw - 0.0018), y: L.upperY + 0.0122, z: L.upperZ1 - 0.0120,
    w: 0.0090, h: 0.0130, d: 0.0180, c: 0.0009 });
  cylG(m, { x: -(hw - 0.0008), y: L.upperY + 0.0122, z: L.upperZ1 - 0.0055,
    rz: Math.PI / 2, r0: 0.0056, len: 0.0080, seg: 12 });
  // charging-handle raceway shroud at the rear
  boxG(m, { x: 0, y: L.upperY + 0.0175, z: L.upperZ1 - 0.0040,
    w: L.upperW - 0.0100, h: 0.0110, d: 0.0140, c: 0.0010 });
  // Flat-top shoulders either side of the rail. In ADS the receiver's top face is
  // one 40 mm plane seen almost end-on, which has no shading gradient at all --
  // the one place on the weapon where "large flat slab" is fair. Two ribs split it
  // into three planes whose converging highlights carry the perspective.
  for (const s of [1, -1]) {
    boxG(m, { x: s * (hw - 0.0050), y: L.upperY + hh + 0.0017, z: mid,
      w: 0.0058, h: 0.0034, d: span - 0.0120, c: 0.0009, simple: true });
  }
  // takedown pin lugs
  for (const z of [L.upperZ0 + 0.0140, L.upperZ1 - 0.0080]) {
    boxG(m, { x: 0, y: L.upperY - hh - 0.0005, z,
      w: L.upperW - 0.0100, h: 0.0080, d: 0.0130, c: 0.0009 });
  }
}

/**
 * Relief and material breaks for the upper receiver's flanks.
 *
 * The round-9 hipfire frame had a 500 x 200 px trapezoid of uniform dark across
 * its middle: the upper's flank is the largest single surface pointed at the
 * camera and carried only the deflector and the forward assist. Two kinds of fix,
 * doing different jobs. EDGES give the key two planes at different angles -- a
 * panel step plus a vertical break at each takedown station splits one flank into
 * four tonal bands, which is what "edge highlights" means when you cannot edit the
 * shader. MATERIAL CHANGE gives a value step that survives any light direction: an
 * anodised panel over phosphate steel and a stippled thumb pad, so the flank
 * breaks up even in flat overcast where geometry alone gives nothing.
 */
function upperFlanks(m, L) {
  const hw = L.upperW / 2;
  const mid = (L.upperZ0 + L.upperZ1) / 2, span = L.upperZ1 - L.upperZ0;
  const flutes = span > 0.2300 ? 3 : 2;
  for (const s of [1, -1]) {
    m.use('steel');
    // Panel step: 3.0 mm proud and 5.6 mm tall, not 2.0 x 3.2. The first pass read
    // as a line rather than a step -- a relief has to be deep enough that its own
    // top face sits at a visibly different angle, or it is texture pretending to be
    // geometry.
    boxG(m, { x: s * (hw + 0.0014), y: L.upperY + 0.0126, z: mid + 0.0020,
      w: 0.0030, h: 0.0056, d: span - 0.0260, c: 0.0009, simple: true });
    // Vertical breaks at both takedown stations: the seams a real forging shows.
    for (const z of [L.upperZ0 + 0.0190, L.upperZ1 - 0.0150]) {
      boxG(m, { x: s * (hw + 0.0010), y: L.upperY - 0.0020, z,
        w: 0.0022, h: L.upperH - 0.0120, d: 0.0034, c: 0.0007, simple: true });
    }
    // Lightening flutes: machined, not moulded, relief. Long and few rather than
    // short and many -- at hipfire scale a 25 mm pocket is ~30 px and reads as a
    // blemish where a 46 mm one reads as a cut.
    m.use('alu');
    for (let i = 0; i < flutes; i++) {
      boxG(m, { x: s * (hw + 0.0007), y: L.upperY - 0.0090, z: L.upperZ0 + 0.0720 + i * 0.0560,
        w: 0.0016, h: 0.0116, d: 0.0460, c: 0.0006, cav: 0.55, simple: true });
    }
    // Anodised panel over the rear of the flank: a value step that does not
    // depend on the key light falling anywhere in particular.
    boxG(m, { x: s * (hw + 0.0011), y: L.upperY + 0.0044, z: L.upperZ1 - 0.0510,
      w: 0.0022, h: 0.0150, d: 0.0620, c: 0.0007, simple: true });
    m.use('grip');
    // Stippled patch where the support hand's thumb rides over the receiver.
    boxG(m, { x: s * (hw + 0.0012), y: L.upperY - 0.0016, z: L.upperZ0 + 0.0720,
      w: 0.0016, h: 0.0180, d: 0.0300, c: 0.0005, simple: true });
  }
}

/* -------------------------------------------------------------- handguard */

/**
 * THE 38 mm OCTAGON IS INVARIANT ACROSS THE LOADOUT; only its length changes.
 * `Hands.js` walks the support hand's four finger rows along this exact section at
 * a fixed offset and is another agent's file, so a fatter tube buries the
 * fingertips and a thinner one floats them. The SMG's handguard is short, not
 * slim: that is where its compactness comes from.
 */
function handguard(m, L) {
  const span = L.hgZ1 - L.hgZ0;
  m.use('alu');
  // M-LOK slots on a 34 mm pitch, cut as real recessed pockets by prismG. The
  // count follows the length — 2 on the SMG, 4 on the carbine, 5 on the LANCET.
  const mlok = [];
  const n = Math.max(1, Math.floor((span - 0.0430) / 0.0340) + 1);
  for (let i = 0; i < n; i++) {
    const a = L.hgZ0 + 0.0130 + i * 0.0340;
    mlok.push({ a, b: a + 0.0260 });
  }
  const slot = { spans: mlok, halfW: 0.0038, depth: 0.0026 };
  prismG(m, {
    y: L.boreY,
    profile: octProfile(0.0380, 0.0380, 0.44),
    z0: L.hgZ0, z1: L.hgZ1,
    slots: { 0: slot, 2: slot, 6: slot },
    capB: false,
  });
  // web carrying the top rail up to receiver height
  boxG(m, { x: 0, y: (0.0470 + L.railY) / 2, z: (L.hgZ0 + L.hgZ1) / 2,
    w: 0.0216, h: L.railY - 0.0470 + 0.0060, d: span - 0.0020, c: 0.0016 });
  // muzzle-end collar
  cylG(m, { x: 0, y: L.boreY, z: L.hgZ0 + 0.0032, r0: 0.0202, r1: 0.0202, len: 0.0064, seg: 16, c: 0.0009 });
  // barrel-nut shoulder at the receiver end
  cylG(m, { x: 0, y: L.boreY, z: L.hgZ1 - 0.0040, r0: 0.0206, len: 0.0080, seg: 16, c: 0.0010 });

  // handstop and QD sling socket
  const acc = L.acc;
  if (acc.stop !== null) {
    m.use('polymer');
    boxG(m, { x: 0, y: 0.0092, z: acc.stop, rx: -0.36, w: 0.0180, h: 0.0150, d: 0.0250, c: 0.0016 });
  }
  if (acc.qd !== null) {
    m.use('steel');
    cylG(m, { x: -0.0186, y: L.boreY - 0.0060, z: acc.qd, rz: Math.PI / 2, r0: 0.0052, len: 0.0044, seg: 12 });
    m.use('bore');
    cylG(m, { x: -0.0202, y: L.boreY - 0.0060, z: acc.qd, rz: Math.PI / 2, r0: 0.0026, len: 0.0030, seg: 10 });
  }
  // short accessory rail on the left flat
  if (acc.stub) {
    m.use('alu');
    buildRailStub(m, { x: -0.0182, y: L.boreY, rz: Math.PI / 2, z0: acc.stub[0], z1: acc.stub[1] });
  }
}

/* --------------------------------------------------------- barrel + muzzle */

function barrelGroup(m, L) {
  const B = L.bar, D = L.dev;
  m.use('steel');
  cylG(m, { x: 0, y: L.boreY, z: (B.z0 + B.z1) / 2, r0: B.r0, r1: B.r1,
    len: B.z1 - B.z0, seg: 16, c: 0.0010 });
  // Low-profile gas block with the tube running back under the rail — absent on
  // the WRAITH, which is a blowback 9 mm and physically has neither.
  if (B.gasY) {
    boxG(m, { x: 0, y: B.gasY, z: B.gasZ, w: 0.0186, h: 0.0176, d: 0.0290, c: 0.0014 });
    const t0 = B.gasZ + 0.0030, t1 = L.hgZ1 - 0.0250;
    cylG(m, { x: 0, y: B.gasY + 0.0038, z: (t0 + t1) / 2, r0: 0.0032, len: t1 - t0, seg: 10, capB: false });
  } else {
    // Blowback barrel nut where the gas block would be, so the barrel is not a
    // bare rod between the handguard lip and the muzzle device.
    knurlG(m, { x: 0, y: L.boreY, z: B.z0 + 0.0180, r0: B.r0 + 0.0034, len: 0.0090, seg: 14, teeth: 14, c: 0.0008 });
  }
  // Muzzle device: body, crush washer, knurled collar. Every station is anchored
  // to the barrel's muzzle end and scaled by the device's own length, so a 26 mm
  // birdcage and a 46 mm brake are the same six calls.
  const z0 = B.z0, dl = D.len;
  cylG(m, { x: 0, y: L.boreY, z: z0, r0: D.r * 0.894, len: 0.0060, seg: 16, c: 0.0009 });
  cylG(m, { x: 0, y: L.boreY, z: z0 - dl * 0.530, r0: D.r, r1: D.r * 0.955,
    len: dl * 0.947, seg: 18, c: 0.0011 });
  knurlG(m, { x: 0, y: L.boreY, z: z0 - dl * 0.132, r0: D.r * 1.015, len: 0.0055, seg: 18, teeth: D.teeth });
  // blast ports, cut as dark recesses top and sides
  m.use('bore');
  for (let i = 0; i < D.ports; i++) {
    const z = z0 - dl * 0.237 - i * dl * 0.237;
    boxG(m, { x: 0, y: L.boreY + D.r * 0.697, z, w: 0.0130, h: 0.0090, d: 0.0042, c: 0.0004, simple: true });
    boxG(m, { x: D.r * 0.697, y: L.boreY, z, rz: Math.PI / 2, w: 0.0110, h: 0.0090, d: 0.0042, c: 0.0004, simple: true });
    boxG(m, { x: -D.r * 0.697, y: L.boreY, z, rz: Math.PI / 2, w: 0.0110, h: 0.0090, d: 0.0042, c: 0.0004, simple: true });
  }
  // the bore itself
  cylG(m, { x: 0, y: L.boreY, z: z0 - dl * 0.868, r0: D.r * 0.379, len: 0.0150, seg: 14, capA: false });
}

/* ------------------------------------------------------------------ lower */

/**
 * SHARED ACROSS ALL THREE WEAPONS, and it has to be: `Hands.js` solves the firing
 * hand against `GRIP` at (0, -0.0742, 0.1178) with a 32.2 x 43.0 mm section,
 * walking each phalanx round that outline by chord length. Nothing here may become
 * weapon-dependent without a matching change in a file this agent does not own.
 */
function lowerReceiver(m, L) {
  m.use('polymer');
  // 8.6 mm chamfer, up from 5.5: same argument as the upper. The lower's flank
  // is the biggest surface on the weapon and its long edges have to be facets
  // wide enough to hold a highlight, not lines.
  prismG(m, { y: -0.0030, profile: rectProfile(0.0380, 0.0520, 0.0086), z0: -0.0420, z1: 0.1340 });
  // magwell throat and flared lip
  boxG(m, { x: 0, y: -0.0250, z: 0.0040, w: 0.0428, h: 0.0300, d: 0.0740, w1: 0.0408, c: 0.0022 });
  boxG(m, { x: 0, y: -0.0404, z: 0.0040, w: 0.0452, h: 0.0082, d: 0.0768, c: 0.0022 });
  // trigger guard loop
  boxG(m, { x: 0, y: -0.0400, z: 0.0552, w: 0.0286, h: 0.0250, d: 0.0064, c: 0.0014 });
  boxG(m, { x: 0, y: -0.0508, z: 0.0770, rx: 0.05, w: 0.0286, h: 0.0064, d: 0.0470, c: 0.0014 });
  // Pistol grip, raked back: local +Z runs down the grip. The 7 mm chamfer on a
  // 32 mm box is huge on purpose — it gives a genuinely rounded front strap, which
  // is what lets the firing hand's finger arc sit against it rather than stand off
  // a flat face.
  const grip = { x: 0, y: -0.0742, z: 0.1178, rx: Math.PI / 2 - 0.30 };
  boxG(m, { ...grip, w: 0.0322, h: 0.0430, d: 0.0980, w1: 0.0300, h1: 0.0396, c: 0.0070 });
  boxG(m, at(grip, 0, 0.0195, -0.0500, { w: 0.0300, h: 0.0180, d: 0.0150, c: 0.0022 }));
  m.use('grip');
  boxG(m, at(grip, 0.0158, 0.0010, 0.0040, { w: 0.0024, h: 0.0330, d: 0.0680, c: 0.0006, simple: true }));
  boxG(m, at(grip, -0.0158, 0.0010, 0.0040, { w: 0.0024, h: 0.0330, d: 0.0680, c: 0.0006, simple: true }));
  boxG(m, at(grip, 0, 0.0222, 0.0090, { w: 0.0240, h: 0.0024, d: 0.0620, c: 0.0006, simple: true }));
  m.use('rubber');
  boxG(m, at(grip, 0, 0.0000, 0.0510, { w: 0.0300, h: 0.0400, d: 0.0080, c: 0.0018 }));

  // controls
  m.use('steel');
  boxG(m, { x: 0, y: -0.0398, z: 0.0748, rx: 0.20, w: 0.0080, h: 0.0230, d: 0.0062, c: 0.0008 });
  boxG(m, { x: 0, y: -0.0492, z: 0.0788, rx: 0.95, w: 0.0080, h: 0.0110, d: 0.0068, c: 0.0008 });
  // safety selector both sides
  for (const s of [1, -1]) {
    cylG(m, { x: s * 0.0194, y: 0.0072, z: 0.0980, rz: Math.PI / 2, r0: 0.0062, len: 0.0044, seg: 12 });
    boxG(m, { x: s * 0.0208, y: 0.0060, z: 0.1090, rx: -0.40, w: 0.0034, h: 0.0110, d: 0.0210, c: 0.0007 });
  }
  // magazine release with its fence, and the bolt catch opposite
  cylG(m, { x: 0.0200, y: -0.0060, z: 0.0500, rz: Math.PI / 2, r0: 0.0058, len: 0.0052, seg: 12 });
  boxG(m, { x: 0.0196, y: -0.0060, z: 0.0500, w: 0.0026, h: 0.0170, d: 0.0170, c: 0.0007 });
  boxG(m, { x: -0.0202, y: -0.0040, z: 0.0330, w: 0.0038, h: 0.0130, d: 0.0300, c: 0.0008 });
  // takedown pins
  for (const z of [-0.0300, 0.1180]) {
    cylG(m, { x: 0.0192, y: 0.0060, z, rz: Math.PI / 2, r0: 0.0046, len: 0.0040, seg: 12 });
    cylG(m, { x: -0.0192, y: 0.0060, z, rz: Math.PI / 2, r0: 0.0046, len: 0.0040, seg: 12 });
  }
}

/**
 * Ribbed polymer rail cover over an unused stretch of Picatinny.
 *
 * Transverse ribs 3.4 mm proud on an 11 mm pitch plus two longitudinal beads, so
 * it reads as a ladder with a centre channel rather than as a plank -- which it
 * has to be, because in ADS this surface runs from the bottom edge of the frame
 * to the sight.
 */
function railCover(m, L, z0, z1) {
  if (z1 - z0 < 0.0140) return;
  boxG(m, { x: 0, y: L.railY + 0.0042, z: (z0 + z1) / 2,
    w: 0.0212, h: 0.0088, d: z1 - z0, c: 0.0014 });
  for (let z = z0 + 0.0070; z < z1 - 0.0045; z += 0.0110) {
    boxG(m, { x: 0, y: L.railY + 0.0082, z, w: 0.0206, h: 0.0034, d: 0.0046, c: 0.0008, simple: true });
  }
  for (const s of [1, -1]) {
    boxG(m, { x: s * 0.0082, y: L.railY + 0.0090, z: (z0 + z1) / 2,
      w: 0.0022, h: 0.0030, d: z1 - z0 - 0.0040, c: 0.0006, simple: true });
  }
}

/**
 * Relief for the lower receiver's flanks. Shared, for the same reason the lower
 * itself is.
 *
 * In the hipfire pose the lower's left side is the single largest surface aimed at
 * the camera, and it carried only a bolt catch and two takedown pins. So: a panel
 * step splitting the flank into two tonal bands, a recessed rollmark plate,
 * moulded ribs across the magwell flare, a stippled thumb patch and a QD socket on
 * a boss -- all 1.6-3.2 mm proud and below y = 0.014, so none of it is near the
 * sight line in ADS.
 */
function lowerFlanks(m) {
  for (const s of [1, -1]) {
    m.use('polymer');
    // One long edge does more for a big flat flank than any amount of surface
    // detail: it gives the key two planes at different angles.
    boxG(m, { x: s * 0.0192, y: 0.0118, z: 0.0460,
      w: 0.0022, h: 0.0034, d: 0.1620, c: 0.0006, simple: true });
    boxG(m, { x: s * 0.0192, y: -0.0150, z: 0.0800,
      w: 0.0022, h: 0.0030, d: 0.1000, c: 0.0006, simple: true });
    // Rollmark plate: raised border on the magwell, recessed field inside.
    boxG(m, { x: s * 0.0218, y: -0.0230, z: 0.0180,
      w: 0.0016, h: 0.0134, d: 0.0330, c: 0.0005, simple: true });
    // Moulded reinforcement ribs raked across the magwell flare.
    for (let i = 0; i < 3; i++) {
      boxG(m, { x: s * 0.0218, y: -0.0322, z: -0.0130 + i * 0.0152, rx: 0.55,
        w: 0.0018, h: 0.0028, d: 0.0190, c: 0.0005, simple: true });
    }
    m.use('grip');
    // Engraved data field, and a stippled thumb patch further back.
    boxG(m, { x: s * 0.0223, y: -0.0230, z: 0.0180,
      w: 0.0012, h: 0.0086, d: 0.0262, c: 0.0004, cav: 0.7, simple: true });
    boxG(m, { x: s * 0.0192, y: -0.0022, z: 0.0620,
      w: 0.0018, h: 0.0228, d: 0.0540, c: 0.0006, simple: true });
    // QD sling socket on a boss, ambidextrous.
    m.use('polymer');
    boxG(m, { x: s * 0.0196, y: 0.0086, z: 0.0900,
      w: 0.0034, h: 0.0170, d: 0.0170, c: 0.0010, simple: true });
    m.use('steel');
    cylG(m, { x: s * 0.0210, y: 0.0086, z: 0.0900, rz: Math.PI / 2,
      r0: 0.0058, len: 0.0040, seg: 12 });
    m.use('bore');
    cylG(m, { x: s * 0.0224, y: 0.0086, z: 0.0900, rz: Math.PI / 2,
      r0: 0.0028, len: 0.0028, seg: 10 });
  }
}

/* ------------------------------------------------------------------ stock */

/**
 * The stock, authored ONCE in a local frame whose origin sits on the bore at the
 * receiver's rear face with +Z running rearward, then placed by `L.stock`.
 *
 * That indirection is the whole trick behind three different rear silhouettes for
 * the price of one function. `zk`/`hk` stretch it (the LANCET is 30% longer and
 * 10% taller in the pad); `fold` hands off to `folder()` below.
 *
 * SILHOUETTE RELIEF — the stock's flanks and buttpad are the largest surfaces
 * aimed straight at the camera in hipfire, and a taper alone does not save them:
 * a big smooth quad under one key light reads as an untextured slab. What breaks
 * it is *edges*, geometry catching the key at a different angle than the panel
 * behind it — two full-length ribs and a vertical break per flank, a webbed toe,
 * a raised sling boss and three ridges proud of the buttpad face.
 */
function stock(m, L) {
  const S = L.stock, zk = S.zk, hk = S.hk;
  const b = { x: S.x, y: S.y, z: S.z, ry: S.ry };
  const P = (lx, ly, lz, e) => at(b, lx, ly * hk, lz * zk, e);

  if (S.fold) { folder(m, L, b, P); return; }

  m.use('steel');
  if (S.tube) {
    cylG(m, P(0, 0, 0.0400, { r0: 0.0140, len: 0.0800 * zk, seg: 16, c: 0.0010, capA: false }));
    // castle nut and end plate where the tube threads into the receiver
    knurlG(m, P(0, 0, 0.0065, { r0: 0.0166, len: 0.0080, seg: 16, teeth: 12 }));
  }

  m.use('polymer');
  // stock body: wider at the buttpad than at the tube, with a cheek shelf
  boxG(m, P(0, -0.0008, 0.0420, { w: 0.0322, h: 0.0500 * hk, d: 0.0680 * zk,
    w1: 0.0354, h1: 0.0602 * hk, c: 0.0054 }));
  if (S.cheek) {
    boxG(m, P(0, 0.0270, 0.0430, { w: 0.0262, h: 0.0130, d: 0.0600 * zk, w1: 0.0242, c: 0.0026 }));
  }
  if (S.riser) {
    /**
     * Adjustable cheek riser -- the only part on the weapon shaped by where the
     * shooter's face has to go, and so the fastest way to say "marksman". The
     * first pass made it a 28 x 17 x 62 mm box on two posts and the crop showed
     * exactly what the contract forbids: a smooth pale slab floating over the
     * stock with one visible leg. A comb is narrow (24 mm, no overhang on the
     * 32 mm body), shallow, and carries its own relief.
     */
    const rh = 0.0270 + S.riser;
    boxG(m, P(0, rh, 0.0450, { w: 0.0240, h: 0.0120, d: 0.0540 * zk, w1: 0.0224, c: 0.0034 }));
    for (const s of [1, -1]) {
      boxG(m, P(s * 0.0122, rh - 0.0016, 0.0450,
        { w: 0.0022, h: 0.0044, d: 0.0500 * zk, c: 0.0007, simple: true }));
    }
    m.use('grip');
    boxG(m, P(0, rh + 0.0072, 0.0450, { w: 0.0180, h: 0.0022, d: 0.0470 * zk, c: 0.0006, simple: true }));
    m.use('steel');
    // Two posts and the lock screw between them, so the comb reads as adjustable.
    for (const s of [1, -1]) {
      cylG(m, P(s * 0.0092, rh - 0.0060 - S.riser * 0.5, 0.0450, {
        lrx: Math.PI / 2, r0: 0.0026, len: S.riser + 0.0080, seg: 10,
      }));
    }
    knurlG(m, P(0, 0.0300, 0.0620, { lrz: Math.PI / 2, r0: 0.0044, len: 0.0060, seg: 12, teeth: 12 }));
    m.use('polymer');
  }
  // flank ribs and the vertical panel break at the pad end
  for (const s of [1, -1]) {
    boxG(m, P(s * 0.0170, 0.0152, 0.0420, { w: 0.0028, h: 0.0058, d: 0.0620 * zk, c: 0.0009, simple: true }));
    boxG(m, P(s * 0.0170, -0.0166, 0.0420, { w: 0.0028, h: 0.0058, d: 0.0620 * zk, c: 0.0009, simple: true }));
    boxG(m, P(s * 0.0176, -0.0008, 0.0648, { w: 0.0028, h: 0.0450 * hk, d: 0.0072, c: 0.0009, simple: true }));
  }
  // sling loop cast into the toe, and the toe hook itself
  boxG(m, P(0, -0.0334, 0.0660, { lrx: -0.30, w: 0.0260, h: 0.0340, d: 0.0140, c: 0.0018 }));
  boxG(m, P(0.0150, -0.0240, 0.0590, { w: 0.0060, h: 0.0230, d: 0.0130, c: 0.0016 }));
  boxG(m, P(-0.0150, -0.0240, 0.0590, { w: 0.0060, h: 0.0230, d: 0.0130, c: 0.0016 }));
  m.use('rubber');
  boxG(m, P(0, -0.0050, 0.0770, { w: 0.0332, h: 0.0680 * hk, d: 0.0140, c: 0.0026 }));
  // recoil ridges across the pad face
  for (let i = 0; i < 3; i++) {
    boxG(m, P(0, -0.0050 + (i - 1) * 0.0195, 0.0838,
      { w: 0.0296, h: 0.0056, d: 0.0036, c: 0.0010, simple: true }));
  }
  m.use('steel');
  // adjustment lever under the tube
  boxG(m, P(0, -0.0172, 0.0530, { lrx: 0.20, w: 0.0140, h: 0.0110, d: 0.0240, c: 0.0010 }));
  // QD sling socket on a raised boss + a short webbing tail so it reads as used
  boxG(m, P(0.0164, 0.0030, 0.0300, { w: 0.0044, h: 0.0180, d: 0.0180, c: 0.0012, simple: true }));
  cylG(m, P(0.0176, 0.0030, 0.0300, { lrz: Math.PI / 2, r0: 0.0062, len: 0.0044, seg: 12 }));
  m.use('bore');
  cylG(m, P(0.0196, 0.0030, 0.0300, { lrz: Math.PI / 2, r0: 0.0030, len: 0.0030, seg: 10 }));
  m.use('sleeve');
  boxG(m, P(0.0212, -0.0075, 0.0320, { lrz: 0.18, w: 0.0022, h: 0.0250, d: 0.0130, c: 0.0004, simple: true }));
  boxG(m, P(0.0212, -0.0190, 0.0390, { lrx: 0.55, lrz: 0.18, w: 0.0022, h: 0.0230, d: 0.0130, c: 0.0004, simple: true }));
}

/**
 * The WRAITH's side-folding stock, in the folded position.
 *
 * IT IS A SKELETON, AND THAT WAS A MEASURED DECISION. The first attempt simply
 * pointed `stock()`'s solid body at ry = -2.60. It halved the length correctly and
 * looked wrong: rotating a 32 x 50 x 68 mm block 150 degrees turns its largest
 * faces UP and LEFT, which is where the key is, so a part that reads dark on the
 * carbine arrived as a pale unbroken slab lying over the ejection port -- the
 * brightest thing on the weapon and the one surface with no relief on it. A real
 * side-folder is a frame: two struts and a buttplate. That fixes it three ways at
 * once -- a third of the projected area, no large planar face to catch the key,
 * and gaps the world shows through, which is the strongest cue that the stock is
 * folded rather than that the gun has a lump on it. It folds LEFT because the eye
 * sits 313 mm to the left of the bore; a right-side fold is never seen.
 */
function folder(m, L, b, P) {
  const S = L.stock;
  m.use('steel');
  // End plate, hinge boss and pin, in WEAPON space rather than the folded frame:
  // the hinge is what stays put when the stock swings, and it is what stops a
  // folded stock reading as one that snapped off.
  boxG(m, { x: 0, y: S.y, z: S.z + 0.0030, w: 0.0330, h: 0.0400, d: 0.0064, c: 0.0010 });
  boxG(m, { x: S.x, y: S.y, z: S.z + 0.0112, w: 0.0180, h: 0.0250, d: 0.0180, c: 0.0026 });
  cylG(m, { x: S.x, y: S.y, z: S.z + 0.0112, rx: Math.PI / 2, r0: 0.0044, len: 0.0290, seg: 12 });
  m.use('alu');
  // Latch catch further forward on the flank, where the folded arm clips home.
  boxG(m, { x: S.x + 0.0016, y: S.y - 0.0130, z: S.z - 0.0420, w: 0.0092, h: 0.0120, d: 0.0140, c: 0.0016 });

  m.use('steel');
  // Two struts, upper and lower, with a cross-brace and a webbed heel.
  for (const dy of [0.0138, -0.0138]) {
    boxG(m, P(0, dy, 0.0400, { w: 0.0070, h: 0.0076, d: 0.0800, c: 0.0016 }));
    boxG(m, P(0, dy, 0.0400, { w: 0.0086, h: 0.0026, d: 0.0740, c: 0.0006, simple: true }));
  }
  boxG(m, P(0, 0, 0.0680, { w: 0.0062, h: 0.0250, d: 0.0090, c: 0.0014 }));
  boxG(m, P(0, 0, 0.0180, { w: 0.0058, h: 0.0230, d: 0.0080, c: 0.0012 }));
  m.use('polymer');
  // Buttplate, and the moulded cheek pad the shooter's face rides when deployed.
  boxG(m, P(0, 0, 0.0790, { w: 0.0096, h: 0.0400, d: 0.0150, w1: 0.0104, c: 0.0022 }));
  m.use('rubber');
  boxG(m, P(0, 0, 0.0862, { w: 0.0076, h: 0.0380, d: 0.0058, c: 0.0016 }));
  m.use('grip');
  boxG(m, P(0, 0.0192, 0.0460, { w: 0.0072, h: 0.0022, d: 0.0520, c: 0.0006, simple: true }));
}

/* --------------------------------------------------------------- sub-groups */

function boltGroup(L) {
  const m = new Mesher();
  m.use('steel');
  // Bolt carrier — visible through the ejection port, and it travels.
  // Anchored to the FRONT of the receiver, not to its middle: the carrier has to
  // sit behind the ejection port on all three, and the port is cut a fixed
  // distance back from the barrel extension while the receiver's rear end moves.
  const cz0 = L.upperZ0 + 0.0720;
  boxG(m, { x: 0, y: L.boreY + 0.0020, z: cz0,
    w: L.upperW - 0.0168, h: 0.0215, d: 0.0820, c: 0.0014 });
  boxG(m, { x: 0, y: L.boreY + 0.0135, z: cz0, w: 0.0150, h: 0.0060, d: 0.0700, c: 0.0008 });
  cylG(m, { x: 0.0110, y: L.boreY + 0.0020, z: L.upperZ0 + 0.0390, rz: Math.PI / 2, r0: 0.0038, len: 0.0030, seg: 10 });
  // charging handle: shaft, T-grip, latch
  const cy = L.railY - 0.0068;
  boxG(m, { x: 0, y: cy, z: L.upperZ1 - 0.0100, w: 0.0150, h: 0.0062, d: 0.0420, c: 0.0008 });
  boxG(m, { x: 0, y: cy, z: L.upperZ1 + 0.0120, w: 0.0320, h: 0.0092, d: 0.0130, c: 0.0012 });
  boxG(m, { x: -0.0238, y: cy, z: L.upperZ1 + 0.0170, w: 0.0210, h: 0.0080, d: 0.0092, c: 0.0010 });
  const g = new THREE.Group();
  g.name = 'vm:bolt';
  return { group: g, geos: m.geometries(), tris: m.triangleCount() };
}

/**
 * The magazine.
 *
 * Local +Z runs *up* the magazine, so sweeping downward drops it out of the
 * magwell; the rake tilts the floorplate forward like a real polymer mag. A
 * non-zero `curve` hinges the lower 58% forward by that many radians, which is
 * what a 9 mm double-stack does and what makes the WRAITH read as a different
 * weapon from across the frame -- the magazine is the largest silhouette event on
 * the underside of all three.
 */
function magGroup(L) {
  const m = new Mesher();
  const M = L.mag;
  const rake = -Math.PI / 2 + 0.07;
  const base = { x: 0, y: -0.0290, z: 0.0035, rx: rake };
  const z1 = 0.0060, z0 = z1 - M.len;
  const prof = rectProfile(M.w, M.h, 0.0046);
  /**
   * Witness slots on BOTH flanks. The carbine only had the right-hand pair and the
   * camera never sees it -- the eye is 313 mm left of the bore, so the magazine's
   * LEFT flank is the surface being photographed, and it was the largest unbroken
   * dark rectangle on the weapon.
   */
  const wit = (from, sign) => {
    const spans = [];
    for (let i = 0; i < M.rows; i++) {
      const a = from + sign * (0.0140 + i * M.sp);
      spans.push({ a, b: a + 0.0110 });
    }
    return { spans, halfW: 0.0056, depth: 0.0019 };
  };
  m.use('polymer');
  let tip;
  if (!M.curve) {
    const s = wit(z1 - 0.0360, -1);
    prismG(m, { ...base, profile: prof, z0, z1, slots: { 2: s, 6: s } });
    tip = at(base, 0, 0, z0 - 0.0043);
  } else {
    /**
     * Two swept sections hinged at 58% of the length, the lower one raked forward
     * by `curve` radians. It overlaps the hinge by 6 mm so the joint
     * interpenetrates instead of opening a wedge — a curved magazine's seam is a
     * ridge, never a gap, and a gap at this scale is a hole straight through the
     * biggest part on the weapon's underside.
     */
    const split = z0 + M.len * 0.58;
    prismG(m, { ...base, profile: prof, z0: split, z1, capA: false });
    const low = at(base, 0, 0, split, { rx: rake + M.curve });
    const s = wit(-0.0140, -1);
    prismG(m, { ...low, profile: prof, z0: z0 - split, z1: 0.0060, capB: false,
      slots: { 2: s, 6: s } });
    tip = at(low, 0, 0, z0 - split - 0.0043);
  }
  // floorplate, then moulded ribs front and back so it is not a bare box
  boxG(m, { ...tip, w: M.w + 0.0028, h: M.h + 0.0030, d: 0.0102, c: 0.0020 });
  boxG(m, at(tip, 0, 0, 0.0098, { w: M.w + 0.0020, h: M.h + 0.0018, d: 0.0060, c: 0.0016 }));
  m.use('grip');
  for (let i = 0; i < 2; i++) {
    boxG(m, at(base, 0, (i ? 1 : -1) * (M.h * 0.5107), z0 + M.len * 0.4667,
      { w: M.w - 0.0042, h: 0.0022, d: M.len * 0.486, c: 0.0006, simple: true }));
  }
  m.use('rubber');
  boxG(m, at(tip, 0, -(M.h * 0.5357), 0.0038, { w: 0.0210, h: 0.0090, d: 0.0150, c: 0.0014 }));
  const g = new THREE.Group();
  g.name = 'vm:mag';
  return { group: g, geos: m.geometries(), tris: m.triangleCount() };
}

/* ------------------------------------------------------------------ build */

function attach(geos, mats, parent, prefix) {
  const out = [];
  for (const [key, geo] of geos) {
    const mesh = new THREE.Mesh(geo, mats[key] ?? mats.steel);
    mesh.name = `${prefix}:${key}`;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false;
    parent.add(mesh);
    out.push(mesh);
  }
  return out;
}

/**
 * @param mats material map from Materials.js
 * @param {string} [id] weapon id — defaults to the carbine
 * @returns {{ root, sight, muzzle, bolt, mag, optic, layout, id, meshes, triangles }}
 */
export function buildWeapon(mats, id = 'ar_vector') {
  const L = layoutFor(id);
  const root = new THREE.Group();
  root.name = `vm:weapon:${L.id}`;

  const m = new Mesher();
  upperReceiver(m, L);
  upperFlanks(m, L);
  handguard(m, L);
  barrelGroup(m, L);
  lowerReceiver(m, L);
  lowerFlanks(m);
  stock(m, L);

  // top rail, then the optic clamped into it
  m.use('alu');
  buildRail(m, { y: L.railY, z0: L.railZ0, z1: L.railZ1 });

  // Polymer rail covers, fore and aft of the mount. Not decoration: in ADS the
  // rear section runs from the bottom edge of the frame up to the sight and the
  // forward one runs to the vanishing point, and bare anodised teeth turn both
  // into a bright strobing comb across the lower third of the image — the same
  // grazing-incidence problem the eye relief was chosen to avoid, arriving by
  // another route. Ribbed polymer turns the same wedge into a converging ladder,
  // which is depth instead of glare, and covering unused rail is what a shooter
  // actually does.
  /**
   * `cover0` is declared per weapon rather than derived, because the support
   * hand's four finger rows sit at z -0.143..-0.0815 and they are solved against
   * an outline whose top is the COVER's top (y 0.0668), not the rail's (0.0627).
   * On the WRAITH the formula the carbine uses (railZ0 + 35 mm) would start the
   * cover at -0.121 and leave the two forward rows riding 4 mm of air over bare
   * Picatinny teeth.
   */
  m.use('polymer');
  const opticHalf = L.optic.depth / 2 + 0.0100;
  railCover(m, L, L.opticZ + opticHalf, L.railZ1 - 0.0040);
  railCover(m, L, L.cover0, L.opticZ - opticHalf);

  // folded back-up irons, front and rear. The rear one stands on the cover; the
  // front one sits ahead of it, on the rail's own front lip.
  m.use('steel');
  boxG(m, { x: 0, y: L.railTop + 0.0102, z: L.railZ1 - 0.0350, rx: 0.95, w: 0.0130, h: 0.0170, d: 0.0044, c: 0.0007 });
  boxG(m, { x: 0, y: L.railTop + 0.0040, z: L.iron0, rx: -0.95, w: 0.0130, h: 0.0170, d: 0.0044, c: 0.0007 });

  const optic = buildOptic(m, mats, {
    railTop: L.railTop, axisY: L.opticAxisY, z: L.opticZ, ...L.optic,
  });

  const meshes = attach(m.geometries(), mats, root, 'vm');
  let triangles = m.triangleCount();

  const bolt = boltGroup(L);
  meshes.push(...attach(bolt.geos, mats, bolt.group, 'vm:bolt'));
  root.add(bolt.group);
  triangles += bolt.tris;

  const mag = magGroup(L);
  meshes.push(...attach(mag.geos, mats, mag.group, 'vm:mag'));
  root.add(mag.group);
  triangles += mag.tris;

  // The eyecup shade is deliberately NOT added to `meshes`: that array doubles as
  // the weapon isolation mask in tools/handcheck.mjs and tools/loadoutcheck.mjs,
  // and a large translucent ring in it would corrupt those measurements. Rail.js
  // chains its teardown off the lens geometry instead.
  root.add(optic.lens, optic.reticle, optic.vignette);

  const sight = new THREE.Object3D();
  sight.position.copy(optic.sight);
  root.add(sight);

  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, L.boreY, L.bar.z0 - L.dev.len * 1.158);
  root.add(muzzle);

  // Where a spent case leaves the gun: the front lip of the ejection port.
  const ejectPort = new THREE.Vector3(L.upperW / 2 + 0.0030, L.upperY + 0.0060, L.upperZ0 + 0.0440);

  return {
    root, sight, muzzle, bolt: bolt.group, mag: mag.group, optic, ejectPort,
    layout: L, id: L.id, meshes, triangles,
  };
}
