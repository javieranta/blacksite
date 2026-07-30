import * as THREE from 'three';

/**
 * OWNER: weapons agent (private to src/weapons/grenades).
 * The frag's procedural model — split out of Grenades.js purely to keep that
 * file under the contract's ~700 line ceiling. Nothing else imports this.
 */

/* ------------------------------------------------------------------ geometry --
 * One merged buffer for the whole frag — body, fuse cap, safety lever — so a
 * grenade in flight is a single draw call.
 *
 * WHAT THE FIRST VERSION GOT WRONG, both found by magnifying a macro capture
 * rather than by reading the code:
 *   - it was 112 x 140 mm, roughly twice a real frag, and read as an egg;
 *   - the waffle grooves were displaced but the normals were still computed
 *     from the smooth ellipsoid, so the geometry had ribs the shading did not.
 *     Displacement without recomputed normals is invisible. `computeVertexNormals`
 *     on the finished buffer is what makes the ribs catch light.
 * Body is now 62 x 88 mm — an M67 — with 2 mm ribs in both axes.
 * Part albedo is carried in a vertex colour so one material covers all three.
 */
export function buildFragGeometry() {
  const RAD = 14, RINGS = 11;
  const R = 0.031, H = 0.044;
  const pos = [], uv = [], col = [], idx = [];

  // Linear-space albedo. Olive drab is a DARK paint: ~0.10 luminance. The first
  // pass used a bright cream from the forge's paint tile and the grenade lit up
  // brighter than the concrete it was lying on.
  const OLIVE = [0.062, 0.070, 0.044];
  const STEEL = [0.115, 0.120, 0.128];
  const LEVER = [0.098, 0.098, 0.092];

  let hash = 0x9e3779b9;
  const jitter = () => {
    hash = (Math.imul(hash ^ (hash >>> 15), 0x85ebca6b) >>> 0);
    return 1 + (((hash >>> 8) & 255) / 255 - 0.5) * 0.22;
  };

  const push = (x, y, z, u, v, c, k = 1) => {
    const j = jitter() * k;
    pos.push(x, y, z); uv.push(u, v);
    col.push(c[0] * j, c[1] * j, c[2] * j);
    return pos.length / 3 - 1;
  };

  // --- body: ribbed ovoid ---------------------------------------------------
  const base = [];
  for (let r = 0; r <= RINGS; r++) {
    const v = r / RINGS;
    const phi = v * Math.PI;
    const ring = [];
    for (let a = 0; a < RAD; a++) {
      const th = (a / RAD) * Math.PI * 2;
      // Waffle: vertical ribs every other segment, horizontal bands every other
      // ring. 3 mm at a 31 mm radius — a real frag's serration depth. Shallower
      // than this and the macro capture shows a smooth pebble.
      const rib = (a % 2 === 0 ? 1 : 0.905) * (r % 2 === 0 ? 1 : 0.945);
      const rr = Math.sin(phi) * R * rib;
      const y = -Math.cos(phi) * H;
      // Grooves sit in shadow and hold dirt: darken them in the albedo too.
      const k = rib < 0.98 ? 0.72 : 1;
      ring.push(push(
        Math.cos(th) * rr, y, Math.sin(th) * rr,
        (a / RAD) * 0.5, v * 0.3, OLIVE, k,
      ));
    }
    base.push(ring);
  }
  for (let r = 0; r < RINGS; r++) {
    for (let a = 0; a < RAD; a++) {
      const a2 = (a + 1) % RAD;
      idx.push(base[r][a], base[r + 1][a], base[r][a2]);
      idx.push(base[r][a2], base[r + 1][a], base[r + 1][a2]);
    }
  }

  // --- fuse cap: collar + striker head on the crown --------------------------
  const collar = [], capBot = [], capTop = [];
  for (let a = 0; a < 10; a++) {
    const th = (a / 10) * Math.PI * 2;
    const c = Math.cos(th), s = Math.sin(th);
    collar.push(push(c * 0.0125, H * 0.80, s * 0.0125, 0.6 + a / 10 * 0.1, 0.5, STEEL));
    capBot.push(push(c * 0.0098, H + 0.004, s * 0.0098, 0.6 + a / 10 * 0.1, 0.54, STEEL));
    capTop.push(push(c * 0.0098, H + 0.019, s * 0.0098, 0.6 + a / 10 * 0.1, 0.58, STEEL));
  }
  const crown = push(0, H + 0.021, 0, 0.65, 0.6, STEEL);
  for (let a = 0; a < 10; a++) {
    const a2 = (a + 1) % 10;
    idx.push(collar[a], capBot[a], collar[a2], collar[a2], capBot[a], capBot[a2]);
    idx.push(capBot[a], capTop[a], capBot[a2], capBot[a2], capTop[a], capTop[a2]);
    idx.push(capTop[a], crown, capTop[a2]);
  }

  // --- safety lever: a folded strap standing 4 mm off the body ---------------
  const L = [
    [0.0065, H + 0.017, 0.011], [-0.0065, H + 0.017, 0.011],
    [0.0065, H - 0.002, 0.035], [-0.0065, H - 0.002, 0.035],
    [0.0065, -0.014, 0.033], [-0.0065, -0.014, 0.033],
    [0.0065, -0.021, 0.024], [-0.0065, -0.021, 0.024],
  ].map((p) => push(p[0], p[1], p[2], 0.8, 0.5, LEVER));
  const quad = (a, b, c, d) => { idx.push(a, c, b, b, c, d); idx.push(b, c, a, d, c, b); };
  quad(L[0], L[1], L[2], L[3]);
  quad(L[2], L[3], L[4], L[5]);
  quad(L[4], L[5], L[6], L[7]);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  // The shading has to come from the ribbed surface that is actually there.
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  geo.name = 'frag';
  return geo;
}

/**
 * Albedo is vertex colour — olive drab with per-vertex wear and darkened
 * grooves — while the microsurface relief comes from the forge's procedurally
 * baked painted-metal normal tile.
 *
 * TWO MEASURED CORRECTIONS, both from probing the live material rather than
 * reading the recipe:
 *   1. The forge's *albedo* tile is a bright industrial paint. Borrowed as
 *      `map` it multiplied straight over the vertex colour and the frag read as
 *      a cream egg. Normals carry no colour, so only the normal tile is taken.
 *   2. The packed ORM tile reads AO 0.95 / roughness 0.40 / metalness 0.03 in
 *      the patch these UVs land on. Handing it authority made a 0.4-roughness
 *      dielectric, and at golden hour a curved 0.4-roughness surface turns its
 *      whole sunward hemisphere into one specular lobe — which is what the
 *      "blown out albedo" in the macro capture actually was. Olive drab paint
 *      is a 0.7-roughness surface, so roughness is set here, not sampled.
 *
 * The shared textures are used as-is (no `repeat` mutation — forge instances
 * belong to every wall in the level); the geometry's own UVs take a patch of
 * the tile instead, about one tile per 40 cm of surface.
 */
export function buildFragMaterial(forge) {
  const tex = forge?.texture?.('metal_painted');
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.70,
    metalness: 0.12,
    normalMap: tex?.normalMap ?? null,
  });
  if (tex?.normalMap) mat.normalScale.set(0.55, 0.55);
  mat.name = 'frag';
  mat.userData.surface = 'metal';
  return mat;
}
