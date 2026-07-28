import * as THREE from 'three';
import { Mesher, boxG, cylG, prismG, rectProfile, octProfile, knurlG } from './Shapes.js';
import { buildRail, buildRailStub, RAIL_HEIGHT } from './Rail.js';
import { buildOptic } from './Optic.js';

/**
 * OWNER: viewmodel agent.
 *
 * The VK-7 VECTOR: a 5.56 carbine assembled from real mechanical parts at real
 * proportions. Everything is metres in weapon space, origin at the centre of the
 * magwell, bore along -Z.
 *
 * Why this layout and not an eyeballed one: the ADS pose is *computed* from the
 * optic's exit pupil (see ViewModel), so every height in LAYOUT propagates into
 * where the weapon sits on screen. Sight height over rail sets how much receiver
 * you see under the reticle; rail length behind the optic sets whether the rail
 * grazes the camera and smears across the lower half of the frame — which is
 * exactly what went wrong in the previous revision. The rail now ends 20 mm
 * behind the ADS eye point, so its near end is clipped rather than stretched.
 */

export const LAYOUT = {
  boreY: 0.0300,
  upperY: 0.0335,
  upperW: 0.0400,
  upperH: 0.0450,
  railY: 0.0560,
  railZ0: -0.2050,
  railZ1: 0.1500,
  hgZ0: -0.2050,
  hgZ1: -0.0600,
};
LAYOUT.railTop = LAYOUT.railY + RAIL_HEIGHT;
LAYOUT.opticAxisY = LAYOUT.railTop + 0.0290;
LAYOUT.opticZ = -0.0300;

/* Rotated-frame offset helper: place a detail relative to a raked parent. */
const _o = new THREE.Vector3();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _q = new THREE.Quaternion();
function at(base, lx, ly, lz, extra) {
  _e.set(base.rx ?? 0, base.ry ?? 0, base.rz ?? 0, 'YXZ');
  _q.setFromEuler(_e);
  _o.set(lx, ly, lz).applyQuaternion(_q);
  return {
    x: base.x + _o.x, y: base.y + _o.y, z: base.z + _o.z,
    rx: base.rx ?? 0, ry: base.ry ?? 0, rz: base.rz ?? 0,
    ...extra,
  };
}

/* ------------------------------------------------------------------ upper */

function upperReceiver(m, L) {
  m.use('steel');
  // One swept prism with a genuine through-hole for the ejection port: no floor,
  // so the bolt carrier behind it is actually visible and actually moves.
  prismG(m, {
    y: L.upperY,
    profile: rectProfile(L.upperW, L.upperH, 0.0046),
    z0: -0.0620, z1: 0.1520,
    slots: {
      2: { spans: [{ a: -0.0250, b: 0.0290 }], halfW: 0.0108, depth: 0.0105, noFloor: true },
    },
  });

  // Dark receiver interior so the port never reads as a see-through slot.
  m.use('bore');
  boxG(m, { x: -0.0045, y: L.upperY, z: 0.0400, w: 0.0225, h: 0.0350, d: 0.1900, c: 0.0004, simple: true });

  m.use('steel');
  // brass deflector — the angled boss behind the port
  boxG(m, { x: 0.0182, y: L.upperY + 0.0098, z: 0.0400, rz: -0.44,
    w: 0.0105, h: 0.0230, d: 0.0250, c: 0.0013 });
  // ejection port cover, hanging open below the port
  boxG(m, { x: 0.0212, y: L.upperY - 0.0195, z: 0.0020, rz: -0.22,
    w: 0.0030, h: 0.0250, d: 0.0530, c: 0.0008 });
  cylG(m, { x: 0.0206, y: L.upperY - 0.0088, z: 0.0020, r0: 0.0018, len: 0.0560, seg: 8 });
  // forward assist
  boxG(m, { x: -0.0182, y: L.upperY + 0.0122, z: 0.1400, w: 0.0090, h: 0.0130, d: 0.0180, c: 0.0009 });
  cylG(m, { x: -0.0192, y: L.upperY + 0.0122, z: 0.1465, rz: Math.PI / 2, r0: 0.0056, len: 0.0080, seg: 12 });
  // charging-handle raceway shroud at the rear
  boxG(m, { x: 0, y: L.upperY + 0.0175, z: 0.1480, w: 0.0300, h: 0.0110, d: 0.0140, c: 0.0010 });
  // Flat-top shoulders either side of the rail. In ADS the receiver's top face
  // runs from the bottom edge of the frame to the sight as one 40 mm-wide plane
  // seen almost end-on, and a single plane at that incidence has no shading
  // gradient at all — it is the one place on the weapon where "large flat slab"
  // is a fair description. Two ribs split it into three planes whose converging
  // highlights carry the perspective.
  for (const s of [1, -1]) {
    boxG(m, { x: s * 0.0150, y: L.upperY + 0.0242, z: 0.0450,
      w: 0.0058, h: 0.0034, d: 0.2020, c: 0.0009, simple: true });
  }
  // takedown pin lugs
  for (const z of [-0.0480, 0.1440]) {
    boxG(m, { x: 0, y: L.upperY - 0.0230, z, w: 0.0300, h: 0.0080, d: 0.0130, c: 0.0009 });
  }
}

/* -------------------------------------------------------------- handguard */

function handguard(m, L) {
  m.use('alu');
  // Four M-LOK slots per face, cut as real recessed pockets by prismG.
  const mlok = [];
  for (let i = 0; i < 4; i++) {
    const a = -0.1920 + i * 0.0340;
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
    w: 0.0216, h: L.railY - 0.0470 + 0.0060, d: L.hgZ1 - L.hgZ0 - 0.0020, c: 0.0016 });
  // muzzle-end collar
  cylG(m, { x: 0, y: L.boreY, z: L.hgZ0 + 0.0032, r0: 0.0202, r1: 0.0202, len: 0.0064, seg: 16, c: 0.0009 });
  // barrel-nut shoulder at the receiver end
  cylG(m, { x: 0, y: L.boreY, z: L.hgZ1 - 0.0040, r0: 0.0206, len: 0.0080, seg: 16, c: 0.0010 });

  // handstop and QD sling socket
  m.use('polymer');
  boxG(m, { x: 0, y: 0.0092, z: -0.1660, rx: -0.36, w: 0.0180, h: 0.0150, d: 0.0250, c: 0.0016 });
  m.use('steel');
  cylG(m, { x: -0.0186, y: L.boreY - 0.0060, z: -0.1500, rz: Math.PI / 2, r0: 0.0052, len: 0.0044, seg: 12 });
  m.use('bore');
  cylG(m, { x: -0.0202, y: L.boreY - 0.0060, z: -0.1500, rz: Math.PI / 2, r0: 0.0026, len: 0.0030, seg: 10 });
  // short accessory rail on the left flat
  m.use('alu');
  buildRailStub(m, { x: -0.0182, y: L.boreY, rz: Math.PI / 2, z0: -0.1900, z1: -0.1420 });
}

/* --------------------------------------------------------- barrel + muzzle */

function barrelGroup(m, L) {
  m.use('steel');
  cylG(m, { x: 0, y: L.boreY, z: -0.2470, r0: 0.0092, r1: 0.0102, len: 0.0980, seg: 16, c: 0.0010 });
  // low-profile gas block with the tube running back under the rail
  boxG(m, { x: 0, y: 0.0424, z: -0.2178, w: 0.0186, h: 0.0176, d: 0.0290, c: 0.0014 });
  cylG(m, { x: 0, y: 0.0462, z: -0.1500, r0: 0.0032, len: 0.1300, seg: 10, capB: false });
  // muzzle brake: body, crush washer, knurled collar
  cylG(m, { x: 0, y: L.boreY, z: -0.2960, r0: 0.0118, len: 0.0060, seg: 16, c: 0.0009 });
  cylG(m, { x: 0, y: L.boreY, z: -0.3160, r0: 0.0132, r1: 0.0126, len: 0.0360, seg: 18, c: 0.0011 });
  knurlG(m, { x: 0, y: L.boreY, z: -0.3010, r0: 0.0134, len: 0.0055, seg: 18, teeth: 20 });
  // blast ports, cut as dark recesses top and sides
  m.use('bore');
  for (let i = 0; i < 3; i++) {
    const z = -0.3050 - i * 0.0090;
    boxG(m, { x: 0, y: L.boreY + 0.0092, z, w: 0.0130, h: 0.0090, d: 0.0042, c: 0.0004, simple: true });
    boxG(m, { x: 0.0092, y: L.boreY, z, rz: Math.PI / 2, w: 0.0110, h: 0.0090, d: 0.0042, c: 0.0004, simple: true });
    boxG(m, { x: -0.0092, y: L.boreY, z, rz: Math.PI / 2, w: 0.0110, h: 0.0090, d: 0.0042, c: 0.0004, simple: true });
  }
  // the bore itself
  cylG(m, { x: 0, y: L.boreY, z: -0.3290, r0: 0.0050, len: 0.0150, seg: 14, capA: false });
}

/* ------------------------------------------------------------------ lower */

function lowerReceiver(m, L) {
  m.use('polymer');
  prismG(m, { y: -0.0030, profile: rectProfile(0.0380, 0.0520, 0.0055), z0: -0.0420, z1: 0.1340 });
  // magwell throat and flared lip
  boxG(m, { x: 0, y: -0.0250, z: 0.0040, w: 0.0428, h: 0.0300, d: 0.0740, w1: 0.0408, c: 0.0022 });
  boxG(m, { x: 0, y: -0.0404, z: 0.0040, w: 0.0452, h: 0.0082, d: 0.0768, c: 0.0022 });
  // trigger guard loop
  boxG(m, { x: 0, y: -0.0400, z: 0.0552, w: 0.0286, h: 0.0250, d: 0.0064, c: 0.0014 });
  boxG(m, { x: 0, y: -0.0508, z: 0.0770, rx: 0.05, w: 0.0286, h: 0.0064, d: 0.0470, c: 0.0014 });
  // Pistol grip, raked back: local +Z runs down the grip. The chamfer is huge on
  // purpose — 7 mm off a 32 mm box gives a genuinely rounded front strap, which
  // is what lets the firing hand's circular finger arc actually sit against it
  // instead of standing off a flat face.
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
 * Not decoration: bare anodised teeth at grazing incidence turn into a bright
 * strobing comb, and covering unused rail is what a shooter actually does. The
 * transverse ribs are 3.4 mm proud on an 11 mm pitch and the two longitudinal
 * beads run the whole length, so the cover reads as a ladder with a centre
 * channel rather than as a plank — which is what it has to be, because in ADS
 * this surface runs from the bottom edge of the frame to the sight.
 */
function railCover(m, L, z0, z1) {
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
 * Relief for the lower receiver's flanks.
 *
 * The lower is a 38 x 52 x 176 mm swept box, and in the hipfire pose its left
 * side is the single largest surface aimed at the camera — bigger than the stock
 * flank the previous revision fixed, and until now carrying nothing but a bolt
 * catch and two takedown pins across 90 cm² of moulding. A dark surface that
 * size with no edges on it reads as an untextured plane no matter what the
 * material does, because there is nothing for the key light to break against.
 *
 * What goes on a real polymer lower, and therefore what is here: a longitudinal
 * panel step that splits the flank into two tonal bands, a recessed rollmark
 * plate on the magwell, moulded reinforcement ribs across the magwell flare, a
 * stippled grip patch where the support hand's thumb sits, and a QD sling socket
 * on a raised boss. Everything is 1.6-3.2 mm proud and sits below y = 0.014, so
 * none of it is anywhere near the sight line in ADS.
 */
function lowerFlanks(m) {
  for (const s of [1, -1]) {
    m.use('polymer');
    // The panel step. One long edge does more for a big flat flank than any
    // amount of surface detail: it gives the key two planes at different angles.
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
 * Collapsed stock. Deliberately short: a full-length stock puts the buttpad only
 * 13 cm from the eye in the hipfire pose, where extreme perspective turns it
 * into a wall across the bottom-right corner. Real viewmodels compress the rear
 * of the weapon for exactly this reason, and this one is now 12 mm shorter again.
 *
 * SILHOUETTE RELIEF
 *   The stock's flanks and buttpad are the largest surfaces aimed straight at
 *   the camera in hipfire, and a taper on its own does not save them: a big
 *   smooth quad lit by one key light reads as an untextured slab however good
 *   the material is. What breaks it is *edges* — geometry whose faces catch the
 *   key at a different angle than the panel behind it. So: two full-length ribs
 *   and a vertical break per flank, a webbed toe, a raised sling-mount boss, and
 *   three recoil ridges standing proud of the buttpad face.
 */
function stock(m, L) {
  m.use('steel');
  cylG(m, { x: 0, y: 0.0300, z: 0.1720, r0: 0.0140, len: 0.0800, seg: 16, c: 0.0010, capA: false });
  // castle nut and end plate where the tube threads into the receiver
  knurlG(m, { x: 0, y: 0.0300, z: 0.1385, r0: 0.0166, len: 0.0080, seg: 16, teeth: 12 });
  m.use('polymer');
  // stock body: wider at the buttpad than at the tube, with a cheek shelf
  boxG(m, { x: 0, y: 0.0292, z: 0.1740, w: 0.0322, h: 0.0500, d: 0.0680, w1: 0.0354, h1: 0.0602, c: 0.0034 });
  boxG(m, { x: 0, y: 0.0570, z: 0.1750, w: 0.0262, h: 0.0130, d: 0.0600, w1: 0.0242, c: 0.0026 });
  // flank ribs and the vertical panel break at the pad end
  for (const s of [1, -1]) {
    boxG(m, { x: s * 0.0170, y: 0.0452, z: 0.1740, w: 0.0028, h: 0.0058, d: 0.0620, c: 0.0009, simple: true });
    boxG(m, { x: s * 0.0170, y: 0.0134, z: 0.1740, w: 0.0028, h: 0.0058, d: 0.0620, c: 0.0009, simple: true });
    boxG(m, { x: s * 0.0176, y: 0.0292, z: 0.1968, w: 0.0028, h: 0.0450, d: 0.0072, c: 0.0009, simple: true });
  }
  // sling loop cast into the toe, and the toe hook itself
  boxG(m, { x: 0, y: -0.0034, z: 0.1980, rx: -0.30, w: 0.0260, h: 0.0340, d: 0.0140, c: 0.0018 });
  boxG(m, { x: 0.0150, y: 0.0060, z: 0.1910, w: 0.0060, h: 0.0230, d: 0.0130, c: 0.0016 });
  boxG(m, { x: -0.0150, y: 0.0060, z: 0.1910, w: 0.0060, h: 0.0230, d: 0.0130, c: 0.0016 });
  m.use('rubber');
  boxG(m, { x: 0, y: 0.0250, z: 0.2090, w: 0.0332, h: 0.0680, d: 0.0140, c: 0.0026 });
  // recoil ridges across the pad face
  for (let i = 0; i < 3; i++) {
    boxG(m, { x: 0, y: 0.0250 + (i - 1) * 0.0195, z: 0.2158, w: 0.0296, h: 0.0056, d: 0.0036, c: 0.0010, simple: true });
  }
  m.use('steel');
  // adjustment lever under the tube
  boxG(m, { x: 0, y: 0.0128, z: 0.1850, rx: 0.20, w: 0.0140, h: 0.0110, d: 0.0240, c: 0.0010 });
  // QD sling socket on a raised boss + a short webbing tail so it reads as used
  boxG(m, { x: 0.0164, y: 0.0330, z: 0.1620, w: 0.0044, h: 0.0180, d: 0.0180, c: 0.0012, simple: true });
  cylG(m, { x: 0.0176, y: 0.0330, z: 0.1620, rz: Math.PI / 2, r0: 0.0062, len: 0.0044, seg: 12 });
  m.use('bore');
  cylG(m, { x: 0.0196, y: 0.0330, z: 0.1620, rz: Math.PI / 2, r0: 0.0030, len: 0.0030, seg: 10 });
  m.use('sleeve');
  boxG(m, { x: 0.0212, y: 0.0225, z: 0.1640, rz: 0.18, w: 0.0022, h: 0.0250, d: 0.0130, c: 0.0004, simple: true });
  boxG(m, { x: 0.0212, y: 0.0110, z: 0.1710, rx: 0.55, rz: 0.18, w: 0.0022, h: 0.0230, d: 0.0130, c: 0.0004, simple: true });
}

/* --------------------------------------------------------------- sub-groups */

function boltGroup(mats) {
  const m = new Mesher();
  const L = LAYOUT;
  m.use('steel');
  // bolt carrier — visible through the ejection port, and it travels
  boxG(m, { x: 0, y: L.boreY + 0.0020, z: 0.0100, w: 0.0232, h: 0.0215, d: 0.0820, c: 0.0014 });
  boxG(m, { x: 0, y: L.boreY + 0.0135, z: 0.0100, w: 0.0150, h: 0.0060, d: 0.0700, c: 0.0008 });
  cylG(m, { x: 0.0110, y: L.boreY + 0.0020, z: -0.0230, rz: Math.PI / 2, r0: 0.0038, len: 0.0030, seg: 10 });
  // charging handle: shaft, T-grip, latch
  boxG(m, { x: 0, y: 0.0492, z: 0.1420, w: 0.0150, h: 0.0062, d: 0.0420, c: 0.0008 });
  boxG(m, { x: 0, y: 0.0492, z: 0.1640, w: 0.0320, h: 0.0092, d: 0.0130, c: 0.0012 });
  boxG(m, { x: -0.0238, y: 0.0492, z: 0.1690, w: 0.0210, h: 0.0080, d: 0.0092, c: 0.0010 });
  const g = new THREE.Group();
  g.name = 'vm:bolt';
  return { group: g, geos: m.geometries(), tris: m.triangleCount() };
}

function magGroup(mats) {
  const m = new Mesher();
  // Local +Z runs *up* the magazine, so sweeping -0.135..0 drops it out of the
  // magwell; the rake tilts the floorplate forward like a real polymer mag.
  const rake = -Math.PI / 2 + 0.07;
  const base = { x: 0, y: -0.0290, z: 0.0035, rx: rake };
  const witness = [];
  for (let i = 0; i < 3; i++) witness.push({ a: -0.0900 + i * 0.0230, b: -0.0790 + i * 0.0230 });
  m.use('polymer');
  prismG(m, {
    ...base,
    profile: rectProfile(0.0272, 0.0560, 0.0046),
    z0: -0.1215, z1: 0.0060,
    slots: { 2: { spans: witness, halfW: 0.0056, depth: 0.0019 } },
  });
  // floorplate, then moulded ribs front and back so it is not a bare box
  boxG(m, at(base, 0, 0, -0.1258, { w: 0.0300, h: 0.0590, d: 0.0102, c: 0.0020 }));
  boxG(m, at(base, 0, 0, -0.1160, { w: 0.0292, h: 0.0578, d: 0.0060, c: 0.0016 }));
  m.use('grip');
  for (let i = 0; i < 2; i++) {
    const sy = i ? 1 : -1;
    boxG(m, at(base, 0, sy * 0.0286, -0.0620, { w: 0.0230, h: 0.0022, d: 0.0620, c: 0.0006, simple: true }));
  }
  m.use('rubber');
  boxG(m, at(base, 0, -0.0300, -0.1220, { w: 0.0210, h: 0.0090, d: 0.0150, c: 0.0014 }));
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
 * @returns {{ root, sight, muzzle, bolt, mag, optic, meshes, triangles }}
 */
export function buildWeapon(mats) {
  const L = LAYOUT;
  const root = new THREE.Group();
  root.name = 'vm:weapon';

  const m = new Mesher();
  upperReceiver(m, L);
  handguard(m, L);
  barrelGroup(m, L);
  lowerReceiver(m, L);
  lowerFlanks(m);
  stock(m, L);

  // top rail, then the optic clamped into it
  m.use('alu');
  buildRail(m, { y: L.railY, z0: L.railZ0, z1: L.railZ1 });

  // Polymer rail cover over the stretch behind the optic. Not decoration: in ADS
  // that section runs from the bottom edge of the frame straight up to the
  // sight, and bare anodised teeth turn it into a bright strobing comb across
  // the lower third of the image — the same grazing-incidence problem the eye
  // relief was chosen to avoid, arriving by a different route. Covering unused
  // rail is what a shooter actually does, and it reads as a dark ribbed ramp.
  m.use('polymer');
  railCover(m, L, L.opticZ + 0.0290, L.railZ1 - 0.0040);
  // A second section forward of the mount. In ADS this is the stretch that runs
  // from the bottom of the frame to the vanishing point, and left bare it was a
  // 700 px wedge of anodised aluminium with the sun raking along its brushing —
  // one smooth bright plank across the lower third of the hero shot. Ribbed
  // polymer turns the same wedge into a converging ladder, which is depth
  // instead of glare.
  railCover(m, L, -0.1700, L.opticZ - 0.0180);

  // folded back-up irons, front and rear. The rear one stands on the cover.
  m.use('steel');
  boxG(m, { x: 0, y: L.railTop + 0.0102, z: 0.1150, rx: 0.95, w: 0.0130, h: 0.0170, d: 0.0044, c: 0.0007 });
  boxG(m, { x: 0, y: L.railTop + 0.0040, z: -0.1780, rx: -0.95, w: 0.0130, h: 0.0170, d: 0.0044, c: 0.0007 });

  const optic = buildOptic(m, mats, {
    railTop: L.railTop, axisY: L.opticAxisY, z: L.opticZ,
  });

  const meshes = attach(m.geometries(), mats, root, 'vm');
  let triangles = m.triangleCount();

  const bolt = boltGroup(mats);
  meshes.push(...attach(bolt.geos, mats, bolt.group, 'vm:bolt'));
  root.add(bolt.group);
  triangles += bolt.tris;

  const mag = magGroup(mats);
  meshes.push(...attach(mag.geos, mats, mag.group, 'vm:mag'));
  root.add(mag.group);
  triangles += mag.tris;

  root.add(optic.lens, optic.reticle);

  const sight = new THREE.Object3D();
  sight.position.copy(optic.sight);
  root.add(sight);

  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, L.boreY, -0.3400);
  root.add(muzzle);

  // Where a spent case leaves the gun: the front lip of the ejection port.
  const ejectPort = new THREE.Vector3(0.0230, L.upperY + 0.0060, -0.0180);

  return {
    root, sight, muzzle, bolt: bolt.group, mag: mag.group, optic, ejectPort,
    meshes, triangles,
  };
}
