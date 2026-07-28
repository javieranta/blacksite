/**
 * OWNER: viewmodel agent.
 *
 * Compatibility facade. The rig used to be one file; it is now split across
 * Shapes / Textures / Materials / Rail / Optic / Weapon / Hands / Flash, each
 * under the module size limit. Anything that imported `buildWeapon` or
 * `buildHands` from here still works.
 */
export { buildWeapon, LAYOUT } from './Weapon.js';
export { buildHands } from './Hands.js';
export { buildWeaponMaterials, disposeWeaponMaterials } from './Materials.js';

