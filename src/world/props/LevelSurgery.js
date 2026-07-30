import * as THREE from 'three';

/**
 * GEOMETRY SURGERY for the seat pass. OWNER: props agent.
 *
 * WHY THIS FILE EXISTS
 *   Seven rounds of "floating rusted plates" were all attacked the same way: find
 *   the float, then DRAW something next to it — a wire, a stud, a bracket. That
 *   approach cannot remove the defect, because the defect is the daylight, and a
 *   wire drawn across a 24 cm gap leaves the 24 cm gap. Round 9's own console
 *   proves it: "tied to a surface 0.28m away", and tools/floatcheck.mjs still
 *   measured 0.236 m of clear sky round the same island afterwards.
 *
 *   The only thing that removes daylight is moving the geometry until it touches,
 *   or removing the geometry. That is what this file does.
 *
 * WHAT IT IS ALLOWED TO TOUCH
 *   Props does not edit another agent's SOURCE. It does own the frame it renders,
 *   and the frame is the deliverable. So this operates on buffers, in place, at
 *   build time:
 *     · a plain Mesh — translate exactly the vertices of the island's own
 *       triangles inside `geometry.attributes.position`. Level meshes are merged
 *       per zone and material, so one mesh holds hundreds of unrelated pieces;
 *       moving the whole mesh would move a courtyard to reseat a plate. Only the
 *       island's own vertices move.
 *     · an InstancedMesh — recompose that one instance's matrix.
 *
 * THE GUARD THAT MAKES IT SAFE
 *   A vertex shared between an island triangle and a triangle OUTSIDE the island
 *   cannot be moved without tearing the neighbour. Every edit therefore proves
 *   first that the island's vertex set is disjoint from the rest of the mesh's
 *   vertex set; if it is not, the island is reported and left alone rather than
 *   quietly mangled. Same rule for instances: an instance is only movable if the
 *   island contains all of its triangles.
 *
 * Cost: proportional to the geometry actually edited — tens of pieces, not the
 * 1.16 M triangles the audit measures. Zero per frame, zero draw calls.
 */

const _m = new THREE.Matrix4();
const _t = new THREE.Matrix4();
const _inv = new THREE.Matrix4();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();

/**
 * A "piece": every triangle of one island that comes from one mesh (and, for an
 * InstancedMesh, from one instance).
 *
 * @typedef {{mesh: THREE.Mesh, instance: number, faces: number[]}} Piece
 */

/** Triangles a mesh's geometry holds, per instance. */
export function triCountOf(mesh) {
  const geo = mesh.geometry;
  const idx = geo.index;
  return ((idx ? idx.count : geo.attributes.position.count) / 3) | 0;
}

/**
 * Can this piece be moved without disturbing anything else in its mesh?
 *
 * Returns a reason string when it cannot, so the caller can report the island
 * instead of silently skipping it. Silent skips are how a pass reports success
 * over objects it never touched.
 */
export function pieceMovable(piece, sharedGeometry) {
  const { mesh, faces } = piece;
  if (mesh.isInstancedMesh) {
    // All-or-nothing: a partial instance means the island boundary runs through
    // the middle of a prototype, which no matrix edit can express.
    return faces.length === triCountOf(mesh) ? null : 'instance shared across islands';
  }
  const geo = mesh.geometry;
  const pos = geo.attributes.position;
  const idx = geo.index;
  const total = (idx ? idx.count : pos.count) / 3;
  /*
   * WHOLE-MESH ISLAND: move the OBJECT, not its vertices.
   *
   * This case has to be tested before the shared-geometry guard, and the last
   * float in the level is why. The lighting system's lamp heads are separate
   * Meshes sharing one BufferGeometry, so the guard refused them — and the pair at
   * (1.66, 4.77, 14.31), 12.5 cm apart with nothing else in reach, was the single
   * SEVERE float tools/floatcheck.mjs had left. When the island IS the whole mesh
   * there is nothing to tear: nudging the object's transform is both safer than a
   * buffer edit and correct for shared geometry.
   */
  if (faces.length >= total) { piece.whole = true; return null; }
  if (sharedGeometry.has(mesh.geometry)) return 'geometry shared by several meshes';

  // Mark the island's vertices, then look for any other triangle using one.
  const mine = new Uint8Array(pos.count);
  for (const f of faces) {
    for (let k = 0; k < 3; k++) mine[idx ? idx.getX(f + k) : f + k] = 1;
  }
  const inIsland = new Set(faces);
  for (let f = 0; f + 2 < (idx ? idx.count : pos.count); f += 3) {
    if (inIsland.has(f)) continue;
    for (let k = 0; k < 3; k++) {
      if (mine[idx ? idx.getX(f + k) : f + k]) return 'vertices shared with neighbouring geometry';
    }
  }
  return null;
}

/**
 * World-space delta -> the mesh's local frame.
 *
 * Differencing two transformed points rather than transforming the delta itself
 * is what keeps this correct when the mesh carries a translation as well as a
 * rotation, which every level mesh under a positioned group does.
 */
function localDelta(mesh, dx, dy, dz, out) {
  _inv.copy(mesh.matrixWorld).invert();
  /*
   * DO NOT WRITE INTO `out` BEFORE THE SUBTRACTION.
   *
   * This read `_v.set(0,0,0)...; _v2.set(d)...; return out.copy(_v2).sub(_v)` and
   * the only caller passes `_v` as `out`. So `out.copy(_v2)` overwrote the
   * transformed origin held in `_v`, and `.sub(_v)` then subtracted the vector
   * from itself: EVERY plain-mesh translation was exactly zero.
   *
   * The pass logged "SEATED 2.26x1.18x0.12 [deck|metal_rusted] by 0.101m" and
   * tools/floatcheck.mjs measured the same island at the same place with the same
   * 0.105 m of daylight afterwards — a fix that reported success and changed
   * nothing, which is the exact failure mode this whole task exists to break.
   * Instanced props moved correctly the whole time, which is why the numbers
   * improved a little and hid it.
   */
  _v3.set(0, 0, 0).applyMatrix4(_inv);
  _v2.set(dx, dy, dz).applyMatrix4(_inv);
  return out.copy(_v2).sub(_v3);
}

/** Translate one piece by a world-space delta. */
export function movePiece(piece, dx, dy, dz) {
  const { mesh, faces } = piece;
  if (mesh.isInstancedMesh) {
    mesh.getMatrixAt(piece.instance, _m);
    // world = meshWorld * inst, and we want world' = T(d) * world, so
    // inst' = inv(meshWorld) * T(d) * meshWorld * inst.
    _t.makeTranslation(dx, dy, dz);
    _inv.copy(mesh.matrixWorld).invert();
    _m.premultiply(mesh.matrixWorld).premultiply(_t).premultiply(_inv);
    mesh.setMatrixAt(piece.instance, _m);
    mesh.instanceMatrix.needsUpdate = true;
    return;
  }
  if (piece.whole) {
    // The island is the entire mesh: shift its transform. Works for geometry
    // shared with other meshes, which vertex edits cannot.
    const parent = mesh.parent;
    if (parent) {
      _inv.copy(parent.matrixWorld).invert();
      _v3.set(0, 0, 0).applyMatrix4(_inv);
      _v2.set(dx, dy, dz).applyMatrix4(_inv);
      mesh.position.add(_v2.sub(_v3));
    } else mesh.position.set(mesh.position.x + dx, mesh.position.y + dy, mesh.position.z + dz);
    mesh.updateMatrix();
    mesh.updateMatrixWorld(true);
    return;
  }
  const geo = mesh.geometry;
  const pos = geo.attributes.position;
  const idx = geo.index;
  localDelta(mesh, dx, dy, dz, _v);
  const seen = new Set();
  for (const f of faces) {
    for (let k = 0; k < 3; k++) {
      const vi = idx ? idx.getX(f + k) : f + k;
      if (seen.has(vi)) continue;
      seen.add(vi);
      pos.setXYZ(vi, pos.getX(vi) + _v.x, pos.getY(vi) + _v.y, pos.getZ(vi) + _v.z);
    }
  }
  pos.needsUpdate = true;
}

/**
 * Remove one piece from the frame.
 *
 * Collapsing every triangle to a single point is preferred over deleting index
 * entries: it costs no reallocation, keeps every downstream offset valid, and a
 * zero-area triangle rasterises nothing and casts nothing. The draw call and its
 * cost are unchanged, which is exactly what a set-dressing pass should spend to
 * remove something that should not be there.
 */
export function removePiece(piece) {
  const { mesh, faces } = piece;
  if (mesh.isInstancedMesh) {
    mesh.getMatrixAt(piece.instance, _m);
    const e = _m.elements;
    // Keep the translation, zero the basis: a degenerate instance, still inside
    // the mesh's bounding sphere so culling behaviour does not change.
    for (const i of [0, 1, 2, 4, 5, 6, 8, 9, 10]) e[i] = 0;
    mesh.setMatrixAt(piece.instance, _m);
    mesh.instanceMatrix.needsUpdate = true;
    return;
  }
  if (piece.whole) { mesh.visible = false; return; }
  const geo = mesh.geometry;
  const pos = geo.attributes.position;
  const idx = geo.index;
  for (const f of faces) {
    const v0 = idx ? idx.getX(f) : f;
    const x = pos.getX(v0), y = pos.getY(v0), z = pos.getZ(v0);
    for (let k = 0; k < 3; k++) {
      const vi = idx ? idx.getX(f + k) : f + k;
      pos.setXYZ(vi, x, y, z);
    }
  }
  pos.needsUpdate = true;
}

/**
 * Refresh the bounds of everything that was edited.
 *
 * MUST be called, and it is the reason this is a function rather than a comment:
 * three.js frustum-culls and fits shadow cascades from the cached boundingSphere,
 * so a mesh whose vertices moved but whose sphere did not will pop out of the
 * shadow map at some camera angles and not others. That failure is intermittent
 * by construction, which makes it exactly the kind a screenshot round misses.
 */
export function refreshBounds(meshes) {
  for (const mesh of meshes) {
    if (mesh.isInstancedMesh) {
      mesh.computeBoundingSphere?.();
      continue;
    }
    // A whole-mesh move only changed the transform, and recomputing geometry
    // bounds it shares with other meshes would be wasted work — but it is also
    // harmless, and telling the two apart here would need state this does not
    // have. Geometry bounds are recomputed either way; they are cheap.
    mesh.geometry.computeBoundingBox();
    mesh.geometry.computeBoundingSphere();
  }
}

/** geometries referenced by more than one mesh in the walked set. */
export function sharedGeometries(meshes) {
  const count = new Map();
  for (const m of meshes) count.set(m.geometry, (count.get(m.geometry) ?? 0) + 1);
  const shared = new Set();
  for (const [g, n] of count) if (n > 1) shared.add(g);
  return shared;
}
