import * as THREE from 'three';
import type { Building, World } from '../sim/world';
import { TERRAIN_HALF } from '../sim/world';
import { mulberry32 } from '../util';
import { corrugated, facade, leafTexture } from './textures';
import { withCloudShadows } from './cloudShadows';
import { foliageAtlas, leafyBroadleaf, leafyBush, leafyConifer, leafyPoplar } from './trees';

// Forests (instanced, chunked for culling, swaying in the wind), towns (merged into a few big
// meshes with windows that light up at night) and wind turbines with turning rotors.

const windUniforms = { uTime: { value: 0 }, uWind: { value: 1 } };

function windy(mat: THREE.MeshStandardMaterial) {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = windUniforms.uTime;
    sh.uniforms.uWind = windUniforms.uWind;
    sh.vertexShader = 'uniform float uTime;\nuniform float uWind;\n' + sh.vertexShader.replace('#include <begin_vertex>', `
#include <begin_vertex>
#ifdef USE_INSTANCING
  vec3 ip = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
  float ph = ip.x * 0.043 + ip.z * 0.061;
  float sway = sin(uTime * 1.25 + ph) * 0.6 + sin(uTime * 2.9 + ph * 1.7) * 0.25;
  float bend = max(0.0, transformed.y - 1.5);
  transformed.x += sway * 0.012 * bend * uWind;
  transformed.z += cos(uTime * 1.05 + ph) * 0.008 * bend * uWind;
#endif`);
  };
  return mat;
}

/** Points normals away from a centre so a lumpy crown shades like a soft, round canopy. */
function softNormals(g: THREE.BufferGeometry, cx: number, cy: number, cz: number, upBias = 0.35) {
  const p = g.attributes.position, n = g.attributes.normal;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.set(p.getX(i) - cx, (p.getY(i) - cy) + upBias, p.getZ(i) - cz).normalize();
    n.setXYZ(i, v.x, v.y, v.z);
  }
}

function colorize(g: THREE.BufferGeometry, fn: (x: number, y: number, z: number, c: THREE.Color) => void) {
  const p = g.attributes.position;
  const arr = new Float32Array(p.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    fn(p.getX(i), p.getY(i), p.getZ(i), c);
    arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
}

function jitter(g: THREE.BufferGeometry, amt: number, seed: number) {
  const rnd = mulberry32(seed);
  const p = g.attributes.position;
  const seen = new Map<string, [number, number, number]>();
  for (let i = 0; i < p.count; i++) {
    const key = `${p.getX(i).toFixed(3)},${p.getY(i).toFixed(3)},${p.getZ(i).toFixed(3)}`;
    let d = seen.get(key);
    if (!d) { d = [(rnd() - 0.5) * amt, (rnd() - 0.5) * amt, (rnd() - 0.5) * amt]; seen.set(key, d); }
    p.setXYZ(i, p.getX(i) + d[0], p.getY(i) + d[1], p.getZ(i) + d[2]);
  }
}

function mergeAll(parts: THREE.BufferGeometry[]) {
  const geos = parts.map((g) => (g.index ? g.toNonIndexed() : g));
  let n = 0;
  for (const g of geos) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), col = new Float32Array(n * 3), uv = new Float32Array(n * 2);
  let o = 0;
  for (const g of geos) {
    pos.set(g.attributes.position.array as Float32Array, o * 3);
    nor.set(g.attributes.normal.array as Float32Array, o * 3);
    col.set(g.attributes.color.array as Float32Array, o * 3);
    if (g.attributes.uv) uv.set(g.attributes.uv.array as Float32Array, o * 2);
    o += g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.computeBoundingSphere();
  return out;
}

function trunk(h: number, r: number) {
  const g = new THREE.CylinderGeometry(r * 0.65, r, h, 7, 1, true);
  g.translate(0, h / 2, 0);
  colorize(g, (_x, y, _z, c) => c.setRGB(0.05 + y * 0.004, 0.035, 0.022));
  return g;
}

function conifer(seed: number) {
  const parts: THREE.BufferGeometry[] = [trunk(3.2, 0.26)];
  const tiers = [[3.1, 5.2, 2.3], [2.55, 4.6, 4.7], [1.95, 4.0, 7.1], [1.3, 3.4, 9.3]];
  tiers.forEach(([r, h, y], k) => {
    const g = new THREE.ConeGeometry(r, h, 10, 2, true);
    g.translate(0, y + h / 2, 0);
    jitter(g, 0.35, seed + k);
    softNormals(g, 0, y + h * 0.15, 0, 0.6);
    colorize(g, (x, yy, z, c) => {
      const out = Math.hypot(x, z) / r;
      const t = (yy - y) / h;
      c.setRGB(0.016 + out * 0.012, 0.05 + out * 0.03 + t * 0.012, 0.022 + out * 0.008);
    });
    parts.push(g);
  });
  return mergeAll(parts);
}

function broadleaf(seed: number, detail: number) {
  const rnd = mulberry32(seed);
  const parts: THREE.BufferGeometry[] = [trunk(3.6, 0.3)];
  const blobs = [[0, 6.6, 0, 3.6], [1.9, 5.6, 0.6, 2.4], [-1.7, 5.9, -0.8, 2.5], [0.3, 8.4, -0.4, 2.3], [-0.5, 5.2, 1.9, 2.1]];
  blobs.forEach(([x, y, z, r], k) => {
    const g = new THREE.IcosahedronGeometry(r, k === 0 ? detail : 0);
    g.scale(1, 0.85, 1);
    g.translate(x, y, z);
    jitter(g, 0.5, seed + k * 7);
    const tint = 0.85 + rnd() * 0.3;
    colorize(g, (px, py, pz, c) => {
      const up = (py - 4) / 6;
      const out = Math.hypot(px, pz) / 4;
      c.setRGB((0.04 + up * 0.03) * tint, (0.085 + up * 0.05 + out * 0.02) * tint, 0.025 * tint);
    });
    parts.push(g);
  });
  const all = mergeAll(parts);
  // Shade the whole crown as one rounded mass, leave the trunk alone.
  const p = all.attributes.position, n = all.attributes.normal;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    if (p.getY(i) < 3.3 && Math.hypot(p.getX(i), p.getZ(i)) < 0.4) continue;
    v.set(p.getX(i), p.getY(i) - 6.0 + 1.2, p.getZ(i)).normalize();
    n.setXYZ(i, v.x, v.y, v.z);
  }
  return all;
}

function poplar(seed: number, detail: number) {
  const parts: THREE.BufferGeometry[] = [trunk(2.4, 0.22)];
  const g = new THREE.IcosahedronGeometry(1, detail);
  g.scale(1.7, 7.5, 1.7);
  g.translate(0, 9, 0);
  jitter(g, 0.4, seed);
  softNormals(g, 0, 8.5, 0, 0.3);
  colorize(g, (_x, y, _z, c) => c.setRGB(0.035 + (y - 2) * 0.002, 0.08 + (y - 2) * 0.004, 0.028));
  parts.push(g);
  return mergeAll(parts);
}

// ------------------------------------------------------------------ buildings

interface GeoParts { pos: number[]; nor: number[]; uv: number[]; col: number[] }
const parts = (): GeoParts => ({ pos: [], nor: [], uv: [], col: [] });

function quad(o: GeoParts, a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, uvs: number[], color: THREE.Color) {
  // a-b-c-d counter-clockwise when seen from the front.
  const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(d, a)).normalize();
  for (const [p, k] of [[a, 0], [b, 1], [c, 2], [a, 0], [c, 2], [d, 3]] as const) {
    o.pos.push(p.x, p.y, p.z);
    o.nor.push(n.x, n.y, n.z);
    o.uv.push(uvs[k * 2], uvs[k * 2 + 1]);
    o.col.push(color.r, color.g, color.b);
  }
}

function tri(o: GeoParts, a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, color: THREE.Color) {
  const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).normalize();
  for (const p of [a, b, c]) { o.pos.push(p.x, p.y, p.z); o.nor.push(n.x, n.y, n.z); o.uv.push(0.02, 0.02); o.col.push(color.r, color.g, color.b); }
}

function toGeo(o: GeoParts) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(o.pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(o.nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(o.uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(o.col, 3));
  g.computeBoundingSphere();
  return g;
}

export class Scenery {
  readonly group = new THREE.Group();
  private treeChunks: { far: THREE.InstancedMesh; near: THREE.InstancedMesh | null; cx: number; cz: number; half: number }[] = [];
  private windowMat: THREE.MeshStandardMaterial;
  private rotors: THREE.InstancedMesh | null = null;
  private blink: THREE.MeshStandardMaterial;

  constructor(private world: World, lowDetail: boolean, msaa = false) {
    this.buildTrees(lowDetail ? 0 : 1, !lowDetail, msaa);
    this.windowMat = this.buildTowns();
    this.blink = new THREE.MeshStandardMaterial({ color: 0x330000, emissive: 0xff1010, emissiveIntensity: 0 });
    this.buildTurbines();
  }

  private buildTrees(detail: number, leafy: boolean, coverage: boolean) {
    const bushFar = new THREE.IcosahedronGeometry(1.1, 0);
    bushFar.scale(1, 0.75, 1);
    bushFar.translate(0, 0.75, 0);
    colorize(bushFar, (_x, y, _z, c) => c.setRGB(0.04 + y * 0.02, 0.08 + y * 0.03, 0.03));
    const farGeos = [conifer(3), broadleaf(5, detail), poplar(7, detail), bushFar];
    const farMat = windy(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0, map: leafTexture() }));
    const nearGeos = leafy ? [leafyConifer(3), leafyBroadleaf(5), leafyPoplar(7), leafyBush(9)] : null;
    const nearMat = leafy ? windy(new THREE.MeshStandardMaterial({ vertexColors: true, map: foliageAtlas(), alphaTest: 0.45, alphaToCoverage: coverage, side: THREE.DoubleSide, roughness: 0.78, metalness: 0 })) : null;
    const CELLS = 8, size = (TERRAIN_HALF * 2) / CELLS;
    const buckets = new Map<string, typeof this.world.trees>();
    for (const t of this.world.trees) {
      const ci = Math.min(CELLS - 1, Math.floor((t.x + TERRAIN_HALF) / size)), cj = Math.min(CELLS - 1, Math.floor((t.z + TERRAIN_HALF) / size));
      const key = `${ci},${cj},${t.kind}`;
      let list = buckets.get(key);
      if (!list) buckets.set(key, (list = []));
      list.push(t);
    }
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    const col = new THREE.Color();
    const make = (geo: THREE.BufferGeometry, mat: THREE.Material, list: typeof this.world.trees, kind: number) => {
      const mesh = new THREE.InstancedMesh(geo, mat, list.length);
      const r2 = mulberry32(list.length * 13 + kind);
      list.forEach((t, i) => {
        q.setFromAxisAngle(up, t.rot);
        const sx = t.s * (0.9 + r2() * 0.2);
        s.set(sx, t.s, sx);
        p.set(t.x, t.y - 0.3, t.z);
        mesh.setMatrixAt(i, m.compose(p, q, s));
        const v = 0.8 + r2() * 0.4;
        col.setRGB(v * (0.95 + r2() * 0.15), v, v * (0.9 + r2() * 0.1));
        if (kind === 1 && r2() < 0.12) col.setRGB(1.5, 1.15, 0.6); // the odd early-autumn tree
        mesh.setColorAt(i, col);
      });
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.computeBoundingSphere();
      this.group.add(mesh);
      return mesh;
    };
    for (const [key, list] of buckets) {
      const [ci, cj, kind] = key.split(',').map(Number);
      const far = make(farGeos[kind], farMat, list, kind);
      const near = nearGeos && nearMat ? make(nearGeos[kind], nearMat, list, kind) : null;
      if (near) near.visible = false;
      this.treeChunks.push({ far, near, cx: -TERRAIN_HALF + (ci + 0.5) * size, cz: -TERRAIN_HALF + (cj + 0.5) * size, half: size / 2 });
    }
  }

  private buildTowns() {
    const walls = parts(), roofs = parts(), metal = parts(), plain = parts();
    const tmp = new THREE.Color();
    for (const b of this.world.buildings) this.building(b, walls, roofs, metal, plain, tmp);
    const facadeMap = facade(false), litMap = facade(true);
    const wallMat = withCloudShadows(new THREE.MeshStandardMaterial({ vertexColors: true, map: facadeMap, emissive: 0xffffff, emissiveMap: litMap, emissiveIntensity: 0, roughness: 0.85 }));
    const roofMat = withCloudShadows(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75, metalness: 0.05 }));
    const metalMat = new THREE.MeshStandardMaterial({ vertexColors: true, map: corrugated('#d8dce0'), roughness: 0.5, metalness: 0.15 });
    const plainMat = new THREE.MeshStandardMaterial({ vertexColors: true, map: corrugated('#ffffff', 64), roughness: 0.9 });
    for (const [o, mat] of [[walls, wallMat], [roofs, roofMat], [metal, metalMat], [plain, plainMat]] as const) {
      if (!o.pos.length) continue;
      const mesh = new THREE.Mesh(toGeo(o), mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.group.add(mesh);
    }
    return wallMat;
  }

  private building(b: Building, walls: GeoParts, roofs: GeoParts, metal: GeoParts, plain: GeoParts, tmp: THREE.Color) {
    const c = Math.cos(b.rot), s = Math.sin(b.rot);
    const P = (lx: number, ly: number, lz: number) => new THREE.Vector3(b.x + lx * c + lz * s, b.y + ly, b.z - lx * s + lz * c);
    const hw = b.w / 2, hd = b.d / 2, h = b.h;
    const wallCol = new THREE.Color(b.kind === 'warehouse' ? 0xd9dde2 : b.color).convertSRGBToLinear();
    const roofCol = new THREE.Color(b.roof).convertSRGBToLinear();
    const target = b.kind === 'warehouse' ? metal : b.kind === 'barn' ? plain : walls;
    const T = 9;
    // Four walls, each facing outwards.
    const sides: [number, number, number, number, number][] = [
      [-hw, hd, hw, hd, b.w], [hw, -hd, -hw, -hd, b.w], [hw, hd, hw, -hd, b.d], [-hw, -hd, -hw, hd, b.d],
    ];
    for (const [x0, z0, x1, z1, len] of sides) {
      const u = b.kind === 'warehouse' ? len / 6 : len / T, v = b.kind === 'warehouse' ? 1 : h / T;
      quad(target, P(x0, 0, z0), P(x1, 0, z1), P(x1, h, z1), P(x0, h, z0), [0, 0, u, 0, u, v, 0, v], target === walls ? wallCol : tmp.copy(wallCol));
    }
    if (b.kind === 'warehouse') {
      // Company stripe and a row of loading dock doors on the side facing the yard (local +x).
      const stripe = new THREE.Color(b.color).convertSRGBToLinear();
      quad(metal, P(hw + 0.05, h - 2.2, hd + 0.05), P(hw + 0.05, h - 2.2, -hd - 0.05), P(hw + 0.05, h - 0.6, -hd - 0.05), P(hw + 0.05, h - 0.6, hd + 0.05), [0, 0, 1, 0, 1, 0.1, 0, 0.1], stripe);
      for (let z = -hd + 6; z < hd - 4; z += 8) {
        const door = new THREE.Color(0.3, 0.32, 0.34);
        quad(metal, P(hw + 0.06, 1.2, z + 1.6), P(hw + 0.06, 1.2, z - 1.6), P(hw + 0.06, 4.6, z - 1.6), P(hw + 0.06, 4.6, z + 1.6), [0, 0, 0.5, 0, 0.5, 1, 0, 1], door);
      }
    }
    const flat = b.kind === 'block' || b.kind === 'office' || b.kind === 'warehouse';
    if (flat) {
      quad(roofs, P(-hw, h, -hd), P(-hw, h, hd), P(hw, h, hd), P(hw, h, -hd), [0, 0, 1, 0, 1, 1, 0, 1], tmp.setRGB(0.08, 0.08, 0.085));
      const pc = new THREE.Color(0.2, 0.2, 0.21);
      for (const [x0, z0, x1, z1] of sides) quad(roofs, P(x0, h, z0), P(x1, h, z1), P(x1, h + 0.6, z1), P(x0, h + 0.6, z0), [0, 0, 1, 0, 1, 1, 0, 1], pc);
      if (b.kind !== 'warehouse') {
        // Rooftop plant.
        const r = mulberry32(b.seed);
        const bx = (r() - 0.5) * b.w * 0.5, bz = (r() - 0.5) * b.d * 0.5;
        for (const [x0, z0, x1, z1] of [[-1.2, 1.2, 1.2, 1.2], [1.2, -1.2, -1.2, -1.2], [1.2, 1.2, 1.2, -1.2], [-1.2, -1.2, -1.2, 1.2]]) {
          quad(roofs, P(bx + x0, h, bz + z0), P(bx + x1, h, bz + z1), P(bx + x1, h + 2, bz + z1), P(bx + x0, h + 2, bz + z0), [0, 0, 1, 0, 1, 1, 0, 1], pc);
        }
      }
      return;
    }
    // Pitched roof, ridge along local z, with overhangs.
    const rh = b.kind === 'church' ? b.w * 0.75 : b.kind === 'barn' ? b.w * 0.32 : b.w * 0.5;
    const o = 0.45;
    const under = new THREE.Color(0.06, 0.05, 0.045);
    quad(roofs, P(-hw - o, h - 0.25, -hd - o), P(-hw - o, h - 0.25, hd + o), P(0, h + rh, hd + o), P(0, h + rh, -hd - o), [0, 0, 1, 0, 1, 1, 0, 1], roofCol);
    quad(roofs, P(hw + o, h - 0.25, hd + o), P(hw + o, h - 0.25, -hd - o), P(0, h + rh, -hd - o), P(0, h + rh, hd + o), [0, 0, 1, 0, 1, 1, 0, 1], roofCol);
    // Roof undersides so the eaves aren't see-through from below.
    quad(roofs, P(-hw - o, h - 0.27, hd + o), P(-hw - o, h - 0.27, -hd - o), P(0, h + rh - 0.02, -hd - o), P(0, h + rh - 0.02, hd + o), [0, 0, 1, 0, 1, 1, 0, 1], under);
    quad(roofs, P(hw + o, h - 0.27, -hd - o), P(hw + o, h - 0.27, hd + o), P(0, h + rh - 0.02, hd + o), P(0, h + rh - 0.02, -hd - o), [0, 0, 1, 0, 1, 1, 0, 1], under);
    tri(target, P(-hw, h, hd), P(hw, h, hd), P(0, h + rh, hd), wallCol);
    tri(target, P(hw, h, -hd), P(-hw, h, -hd), P(0, h + rh, -hd), wallCol);
    if (b.kind === 'house') {
      const r = mulberry32(b.seed);
      const cx = (r() - 0.5) * b.w * 0.4, cz = (r() - 0.5) * b.d * 0.5;
      const brick = new THREE.Color(0.25, 0.08, 0.05);
      const ch = h + rh * (1 - Math.abs(cx) / hw) + 0.9;
      for (const [x0, z0, x1, z1] of [[-0.35, 0.35, 0.35, 0.35], [0.35, -0.35, -0.35, -0.35], [0.35, 0.35, 0.35, -0.35], [-0.35, -0.35, -0.35, 0.35]]) {
        quad(roofs, P(cx + x0, h, cz + z0), P(cx + x1, h, cz + z1), P(cx + x1, ch, cz + z1), P(cx + x0, ch, cz + z0), [0, 0, 1, 0, 1, 1, 0, 1], brick);
      }
    }
    if (b.kind === 'church') {
      // Bell tower with a tall spire at the front.
      const tz = hd + 2.2, th = h + 15, tw = 2.4;
      const tower: [number, number, number, number][] = [[-tw, tz + tw, tw, tz + tw], [tw, tz - tw, -tw, tz - tw], [tw, tz + tw, tw, tz - tw], [-tw, tz - tw, -tw, tz + tw]];
      for (const [x0, z0, x1, z1] of tower) quad(walls, P(x0, 0, z0), P(x1, 0, z1), P(x1, th, z1), P(x0, th, z0), [0.02, 0.02, 0.02, 0.02, 0.02, 0.02, 0.02, 0.02], wallCol);
      const apex = P(0, th + 13, tz);
      const corners = [P(-tw - 0.2, th, tz + tw + 0.2), P(tw + 0.2, th, tz + tw + 0.2), P(tw + 0.2, th, tz - tw - 0.2), P(-tw - 0.2, th, tz - tw - 0.2)];
      const spire = new THREE.Color(0.12, 0.2, 0.17);
      for (let k = 0; k < 4; k++) tri(roofs, corners[k], corners[(k + 1) % 4], apex, spire);
    }
  }

  private buildTurbines() {
    const ts = this.world.turbines;
    if (!ts.length) return;
    const white = new THREE.MeshStandardMaterial({ color: 0xf1f3f5, roughness: 0.45, metalness: 0.1 });
    const tower = new THREE.CylinderGeometry(1.2, 2.3, 80, 18);
    tower.translate(0, 40, 0);
    const nac = new THREE.BoxGeometry(3.2, 3.4, 10);
    nac.translate(0, 81.5, -1.5);
    const towerMesh = new THREE.InstancedMesh(tower, white, ts.length);
    const nacMesh = new THREE.InstancedMesh(nac, white, ts.length);
    const light = new THREE.InstancedMesh(new THREE.BoxGeometry(0.6, 0.4, 0.6), this.blink, ts.length);
    const rotor = new THREE.BufferGeometry();
    {
      const blades: THREE.BufferGeometry[] = [];
      for (let k = 0; k < 3; k++) {
        const bl = new THREE.BoxGeometry(2.6, 39, 0.5);
        const p = bl.attributes.position;
        for (let i = 0; i < p.count; i++) if (p.getY(i) > 0) { p.setX(i, p.getX(i) * 0.25); p.setZ(i, p.getZ(i) * 0.4); }
        bl.translate(0.6, 21, 0);
        bl.rotateZ((k / 3) * Math.PI * 2);
        blades.push(bl.toNonIndexed());
      }
      const hub = new THREE.SphereGeometry(1.7, 14, 10);
      hub.scale(1, 1, 1.6);
      blades.push(hub.toNonIndexed());
      let n = 0;
      for (const b of blades) n += b.attributes.position.count;
      const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3);
      let o = 0;
      for (const b of blades) { pos.set(b.attributes.position.array as Float32Array, o * 3); nor.set(b.attributes.normal.array as Float32Array, o * 3); o += b.attributes.position.count; }
      rotor.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      rotor.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    }
    this.rotors = new THREE.InstancedMesh(rotor, white, ts.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1);
    ts.forEach((t, i) => {
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), t.rot);
      m.compose(new THREE.Vector3(t.x, t.y - 0.5, t.z), q, one);
      towerMesh.setMatrixAt(i, m);
      nacMesh.setMatrixAt(i, m);
      light.setMatrixAt(i, new THREE.Matrix4().compose(new THREE.Vector3(t.x, t.y + 83.4, t.z), q, one));
    });
    for (const mesh of [towerMesh, nacMesh, this.rotors]) { mesh.castShadow = true; mesh.receiveShadow = true; }
    for (const mesh of [towerMesh, nacMesh, light, this.rotors]) { mesh.computeBoundingSphere(); this.group.add(mesh); }
    this.updateRotors(0);
    // Instanced bounding spheres must cover the moving rotors too.
    this.rotors.computeBoundingSphere();
  }

  private updateRotors(time: number) {
    if (!this.rotors) return;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), q2 = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1);
    const fwd = new THREE.Vector3();
    this.world.turbines.forEach((t, i) => {
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), t.rot);
      q2.setFromAxisAngle(new THREE.Vector3(0, 0, 1), time * 1.6 + t.phase);
      fwd.set(Math.sin(t.rot), 0, Math.cos(t.rot)).multiplyScalar(4.4);
      m.compose(new THREE.Vector3(t.x + fwd.x, t.y + 81.5, t.z + fwd.z), q.multiply(q2), one);
      this.rotors!.setMatrixAt(i, m);
    });
    this.rotors.instanceMatrix.needsUpdate = true;
  }

  update(time: number, night: number, cam: THREE.Vector3, wind: number) {
    windUniforms.uTime.value = time;
    windUniforms.uWind.value = wind;
    this.windowMat.emissiveIntensity = night * 1.6;
    this.blink.emissiveIntensity = night > 0.2 && Math.sin(time * 3) > 0.6 ? 8 : 0;
    this.updateRotors(time);
    for (const c of this.treeChunks) {
      // Distance to the chunk's nearest edge: leafy cards up close, solid crowns further out.
      const dx = Math.max(0, Math.abs(c.cx - cam.x) - c.half), dz = Math.max(0, Math.abs(c.cz - cam.z) - c.half);
      const d = Math.hypot(dx, dz);
      const near = !!c.near && d < 260;
      if (c.near) c.near.visible = near;
      c.far.visible = !near && d < 2500;
    }
  }
}
