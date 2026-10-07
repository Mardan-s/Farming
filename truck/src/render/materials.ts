import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// Shared PBR materials and a geometry merger that turns a detailed model built from many parts
// into a handful of draw calls (one per material).

let clearcoat = true;
export function setClearcoat(on: boolean) { clearcoat = on; }

const paints = new Map<string, THREE.MeshStandardMaterial>();

/** Glossy automotive paint (clear-coated on high settings). */
export function paint(color: number, metallic = 0.35, rough = 0.32) {
  const key = `${color}-${metallic}-${rough}-${clearcoat}`;
  let m = paints.get(key);
  if (!m) {
    m = clearcoat
      ? new THREE.MeshPhysicalMaterial({ color, metalness: metallic, roughness: rough, clearcoat: 1, clearcoatRoughness: 0.06 })
      : new THREE.MeshStandardMaterial({ color, metalness: metallic, roughness: rough * 0.8 });
    paints.set(key, m);
  }
  return m;
}

export const MAT = {
  chrome: new THREE.MeshStandardMaterial({ color: 0xf4f6f8, metalness: 1, roughness: 0.08 }),
  alu: new THREE.MeshStandardMaterial({ color: 0xc8ccd0, metalness: 1, roughness: 0.3 }),
  steel: new THREE.MeshStandardMaterial({ color: 0x55595e, metalness: 0.7, roughness: 0.45 }),
  frame: new THREE.MeshStandardMaterial({ color: 0x1a1b1d, metalness: 0.4, roughness: 0.55 }),
  plastic: new THREE.MeshStandardMaterial({ color: 0x141518, metalness: 0, roughness: 0.6 }),
  plasticGrey: new THREE.MeshStandardMaterial({ color: 0x3c3f44, metalness: 0, roughness: 0.55 }),
  rubber: new THREE.MeshStandardMaterial({ color: 0x0c0c0d, metalness: 0, roughness: 0.92 }),
  rim: new THREE.MeshStandardMaterial({ color: 0xd9dde2, metalness: 1, roughness: 0.18 }),
  rimDark: new THREE.MeshStandardMaterial({ color: 0x2a2c30, metalness: 0.6, roughness: 0.4 }),
  glass: new THREE.MeshStandardMaterial({ color: 0x0a0f14, metalness: 0.9, roughness: 0.03, envMapIntensity: 1.4 }),
  /** See-through tinted glass for the player's cab, so the interior shows from outside. */
  glassCab: new THREE.MeshStandardMaterial({ color: 0x1c2730, metalness: 0.6, roughness: 0.03, transparent: true, opacity: 0.55, envMapIntensity: 1.6, depthWrite: false }),
  glassInside: new THREE.MeshStandardMaterial({ color: 0x9fb3c2, metalness: 0, roughness: 0.05, transparent: true, opacity: 0.1, depthWrite: false, side: THREE.DoubleSide }),
  mirror: new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 1, roughness: 0.02 }),
  interior: new THREE.MeshStandardMaterial({ color: 0x2a2826, metalness: 0, roughness: 0.85 }),
  interiorLight: new THREE.MeshStandardMaterial({ color: 0x6b655d, metalness: 0, roughness: 0.8 }),
  dash: new THREE.MeshStandardMaterial({ color: 0x2b2e33, metalness: 0.05, roughness: 0.62, side: THREE.DoubleSide }),
  reflector: new THREE.MeshStandardMaterial({ color: 0xff7a00, emissive: 0x401800, metalness: 0.2, roughness: 0.3 }),
  white: new THREE.MeshStandardMaterial({ color: 0xf2f3f5, metalness: 0.1, roughness: 0.5 }),
  roof: new THREE.MeshStandardMaterial({ color: 0x9da3aa, metalness: 0.2, roughness: 0.7 }),
  concrete: new THREE.MeshStandardMaterial({ color: 0xb9b6ae, metalness: 0, roughness: 0.9 }),
  galvanized: new THREE.MeshStandardMaterial({ color: 0xb4bac0, metalness: 0.85, roughness: 0.38 }),
  wood: new THREE.MeshStandardMaterial({ color: 0x7a5a3a, metalness: 0, roughness: 0.85 }),
};

/** Emissive "lamp" material whose glow is driven at runtime. */
export function lamp(color: number, base = 0x222222) {
  return new THREE.MeshStandardMaterial({ color: base, emissive: color, emissiveIntensity: 0, metalness: 0.1, roughness: 0.2 });
}

/** Box helper: centred at (x, y, z). */
export function box(w: number, h: number, d: number, mat: THREE.Material, x = 0, y = 0, z = 0, parent?: THREE.Object3D) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  parent?.add(m);
  return m;
}

export function cyl(rTop: number, rBot: number, h: number, mat: THREE.Material, seg = 16) {
  return new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBot, h, seg), mat);
}

function normalise(g: THREE.BufferGeometry, withColor: boolean) {
  let geo = g.index ? g.toNonIndexed() : g.clone();
  for (const name of Object.keys(geo.attributes)) {
    if (name !== 'position' && name !== 'normal' && name !== 'uv' && !(withColor && name === 'color')) geo.deleteAttribute(name);
  }
  if (!geo.attributes.normal) geo.computeVertexNormals();
  if (!geo.attributes.uv) geo.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(geo.attributes.position.count * 2), 2));
  if (withColor && !geo.attributes.color) {
    const c = new Float32Array(geo.attributes.position.count * 3).fill(1);
    geo.setAttribute('color', new THREE.Float32BufferAttribute(c, 3));
  }
  geo.morphAttributes = {};
  geo = geo as THREE.BufferGeometry;
  return geo;
}

/**
 * Bakes every static mesh under `root` into one mesh per material. Objects in `keep` (and
 * everything under them) stay as they are, so wheels and other moving parts still move.
 */
export function mergeStatic(root: THREE.Object3D, keep: THREE.Object3D[] = []) {
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const kept = new Set<THREE.Object3D>();
  for (const k of keep) k.traverse((o) => kept.add(o));
  const groups = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const victims: THREE.Mesh[] = [];
  const shadow = new Map<THREE.Material, boolean>();
  root.traverse((o) => {
    if (o === root || kept.has(o) || !(o instanceof THREE.Mesh) || o instanceof THREE.InstancedMesh) return;
    const mat = o.material as THREE.Material;
    if (Array.isArray(o.material)) return;
    const withColor = (mat as THREE.MeshStandardMaterial).vertexColors === true;
    const g = normalise(o.geometry, withColor);
    g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld));
    let list = groups.get(mat);
    if (!list) groups.set(mat, (list = []));
    list.push(g);
    shadow.set(mat, (shadow.get(mat) ?? false) || o.castShadow);
    victims.push(o);
  });
  for (const v of victims) {
    // Re-home kept children before the parent mesh goes away.
    for (const child of [...v.children]) if (kept.has(child)) root.attach(child);
    v.removeFromParent();
  }
  // Remove now-empty groups.
  const empties: THREE.Object3D[] = [];
  root.traverse((o) => { if (o !== root && !kept.has(o) && !(o instanceof THREE.Mesh) && o.children.length === 0 && o.type === 'Group') empties.push(o); });
  for (const e of empties) e.removeFromParent();
  for (const [mat, list] of groups) {
    const merged = mergeGeometries(list, false);
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, mat);
    mesh.castShadow = shadow.get(mat) ?? false;
    mesh.receiveShadow = true;
    root.add(mesh);
  }
  return root;
}
