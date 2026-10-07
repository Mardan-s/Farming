import * as THREE from 'three';
import { TERRAIN_CELL, TERRAIN_HALF, TERRAIN_RES, World } from '../sim/world';
import { CARRIAGE_OUT } from '../sim/road';
import { fbm, mulberry32, ridged, smoothstep } from '../util';
import { fieldTexture, groundDetail, waterNormal } from './textures';
import { withCloudShadows } from './cloudShadows';

// Terrain (chunked for culling), farm fields, lakes, round bales and the distant mountain ring.

/** Adds two-scale detail texturing to a vertex-coloured standard material (kills visible tiling). */
function detailShader(mat: THREE.MeshStandardMaterial) {
  mat.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace('#include <map_fragment>', `
#ifdef USE_MAP
  vec4 d1 = texture2D(map, vMapUv);
  vec4 d2 = texture2D(map, vMapUv * 0.171 + 0.37);
  diffuseColor.rgb *= clamp(d1.rgb * d2.rgb * 4.2, 0.0, 2.0);
#endif`);
  };
}

export class Landscape {
  readonly group = new THREE.Group();
  readonly water: THREE.Mesh[] = [];
  private waterNormal: THREE.Texture | null = null;

  constructor(private world: World) {
    const detail = groundDetail();
    const terrainMat = new THREE.MeshStandardMaterial({ vertexColors: true, map: detail.map, normalMap: detail.normal, normalScale: new THREE.Vector2(0.55, 0.55), roughness: 0.96, metalness: 0 });
    detailShader(terrainMat);
    withCloudShadows(terrainMat);
    this.buildTerrain(terrainMat);
    this.buildFields();
    this.buildLakes();
    this.buildMountains();
    this.buildBales();
  }

  /** Crop colour at a point (linear), for the swaying crop carpet. */
  cropColor(x: number, z: number, out: THREE.Color) {
    const i = (x + TERRAIN_HALF) / TERRAIN_CELL, j = (z + TERRAIN_HALF) / TERRAIN_CELL;
    const f = this.world.fields.find((f) => i >= f.i0 - 1 && i <= f.i1 + 1 && j >= f.j0 - 1 && j <= f.j1 + 1);
    const c: Record<string, [number, number, number]> = { wheat: [0.42, 0.3, 0.1], rapeseed: [0.62, 0.52, 0.04], green: [0.08, 0.17, 0.04], sunflower: [0.09, 0.15, 0.04] };
    const v = f ? c[f.kind] ?? c.green : c.green;
    return out.setRGB(v[0], v[1], v[2]);
  }

  /** Ground colour at a point, used to tint the grass so it matches the terrain beneath. */
  groundColor(x: number, z: number, out: THREE.Color) {
    return this.terrainColor(x, z, this.world.terrainHeight(x, z), 0.95, out);
  }

  private terrainColor(x: number, z: number, h: number, ny: number, out: THREE.Color) {
    const n = fbm(x / 180, z / 180, 3, 41), n2 = fbm(x / 47, z / 47, 2, 43), n3 = fbm(x / 600, z / 600, 2, 47);
    // Lush green to dry, yellowed meadow, with large-scale variation and darker hollows.
    out.setRGB(0.075 + n * 0.025, 0.14 + n * 0.035, 0.035);
    const dry = smoothstep(0.0, 0.45, n2 * 0.6 + n3 * 0.6);
    out.lerp(new THREE.Color(0.16, 0.16, 0.065), dry * 0.75);
    const lush = smoothstep(0.1, 0.5, -n3);
    out.lerp(new THREE.Color(0.05, 0.12, 0.03), lush * 0.6);
    const forest = fbm(x / 520, z / 520, 3, this.world.seed + 21);
    if (forest > 0.12) out.multiplyScalar(0.72);
    // Rock on steep ground and high ridges, snow on the peaks.
    const rock = smoothstep(0.86, 0.7, ny) + smoothstep(110, 170, h) * 0.6;
    if (rock > 0) out.lerp(new THREE.Color(0.2, 0.19, 0.17), Math.min(1, rock));
    const snow = smoothstep(190, 240, h) * smoothstep(0.55, 0.8, ny);
    if (snow > 0) out.lerp(new THREE.Color(0.85, 0.88, 0.92), snow);
    return out;
  }

  private buildTerrain(mat: THREE.Material) {
    const R = TERRAIN_RES, W = R + 1, H = this.world.heights;
    const CH = 8, per = R / CH;
    const col = new THREE.Color();
    // Normals from the full height field so chunk seams match.
    const nrm = new Float32Array(W * W * 3);
    for (let j = 0; j <= R; j++) for (let i = 0; i <= R; i++) {
      const hl = H[j * W + Math.max(0, i - 1)], hr = H[j * W + Math.min(R, i + 1)];
      const hd = H[Math.max(0, j - 1) * W + i], hu = H[Math.min(R, j + 1) * W + i];
      const nx = hl - hr, nz = hd - hu, ny = 2 * TERRAIN_CELL;
      const l = Math.hypot(nx, ny, nz);
      nrm.set([nx / l, ny / l, nz / l], (j * W + i) * 3);
    }
    for (let cj = 0; cj < CH; cj++) for (let ci = 0; ci < CH; ci++) {
      const n = per + 1;
      const pos = new Float32Array(n * n * 3), nor = new Float32Array(n * n * 3), uv = new Float32Array(n * n * 2), colr = new Float32Array(n * n * 3);
      for (let b = 0; b < n; b++) for (let a = 0; a < n; a++) {
        const i = ci * per + a, j = cj * per + b, k = b * n + a;
        const x = -TERRAIN_HALF + i * TERRAIN_CELL, z = -TERRAIN_HALF + j * TERRAIN_CELL, h = H[j * W + i];
        pos.set([x, h, z], k * 3);
        const ni = (j * W + i) * 3;
        nor.set([nrm[ni], nrm[ni + 1], nrm[ni + 2]], k * 3);
        uv.set([x / 7, z / 7], k * 2);
        this.terrainColor(x, z, h, nrm[ni + 1], col);
        // Gravel and worn grass right next to the motorway.
        const r = this.world.road.locate(x, z);
        if (r) {
          const e = Math.abs(r.lat) - CARRIAGE_OUT;
          if (e < 6) col.lerp(new THREE.Color(0.17, 0.16, 0.13), smoothstep(6, 1, e) * 0.45);
        }
        colr.set([col.r, col.g, col.b], k * 3);
      }
      const idx: number[] = [];
      for (let b = 0; b < per; b++) for (let a = 0; a < per; a++) {
        const v00 = b * n + a, v10 = v00 + 1, v01 = v00 + n, v11 = v01 + 1;
        idx.push(v00, v11, v10, v00, v01, v11);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
      g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      g.setAttribute('color', new THREE.BufferAttribute(colr, 3));
      g.setIndex(idx);
      g.computeBoundingSphere();
      const m = new THREE.Mesh(g, mat);
      m.receiveShadow = true;
      this.group.add(m);
    }
  }

  private buildFields() {
    const byKind = new Map<string, THREE.BufferGeometry[]>();
    const W = TERRAIN_RES + 1, H = this.world.heights;
    for (const f of this.world.fields) {
      const nI = f.i1 - f.i0 + 1, nJ = f.j1 - f.j0 + 1;
      const pos: number[] = [], uv: number[] = [], nor: number[] = [], idx: number[] = [];
      const ca = Math.cos(f.angle), sa = Math.sin(f.angle);
      for (let b = 0; b < nJ; b++) for (let a = 0; a < nI; a++) {
        const i = f.i0 + a, j = f.j0 + b;
        const x = -TERRAIN_HALF + i * TERRAIN_CELL, z = -TERRAIN_HALF + j * TERRAIN_CELL;
        pos.push(x, H[j * W + i] + 0.08, z);
        uv.push((x * ca - z * sa) / 8, (x * sa + z * ca) / 8);
        nor.push(0, 1, 0);
      }
      for (let b = 0; b < nJ - 1; b++) for (let a = 0; a < nI - 1; a++) {
        const v00 = b * nI + a, v10 = v00 + 1, v01 = v00 + nI, v11 = v01 + 1;
        idx.push(v00, v11, v10, v00, v01, v11);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
      g.setIndex(idx);
      g.computeVertexNormals();
      let list = byKind.get(f.kind);
      if (!list) byKind.set(f.kind, (list = []));
      list.push(g);
    }
    for (const [kind, list] of byKind) {
      const mat = withCloudShadows(new THREE.MeshStandardMaterial({ map: fieldTexture(kind), roughness: 0.92, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
      for (const g of list) {
        const m = new THREE.Mesh(g, mat);
        m.receiveShadow = true;
        this.group.add(m);
      }
    }
  }

  private buildLakes() {
    this.waterNormal = waterNormal();
    this.waterNormal.repeat.set(10, 10);
    const mat = new THREE.MeshStandardMaterial({ color: 0x0b2a33, roughness: 0.06, metalness: 0.1, normalMap: this.waterNormal, normalScale: new THREE.Vector2(0.35, 0.35), envMapIntensity: 1.3 });
    this.buildRiver(mat);
    for (const lk of this.world.lakes) {
      const m = new THREE.Mesh(new THREE.CircleGeometry(lk.r * 1.32, 64), mat);
      m.rotation.x = -Math.PI / 2;
      m.position.set(lk.x, lk.level, lk.z);
      m.receiveShadow = true;
      this.group.add(m);
      this.water.push(m);
    }
  }

  /** The river winding along the valley floor under the viaduct. */
  private buildRiver(mat: THREE.Material) {
    const r = this.world.river;
    const len = Math.hypot(r.x1 - r.x0, r.z1 - r.z0) - 120;
    const g = new THREE.PlaneGeometry(len, 34, 120, 1);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) p.setY(i, p.getY(i) + Math.sin(p.getX(i) / 90) * 12);
    const m = new THREE.Mesh(g, mat);
    m.rotation.x = -Math.PI / 2;
    m.rotation.z = -Math.atan2(r.z1 - r.z0, r.x1 - r.x0);
    m.position.set((r.x0 + r.x1) / 2 + ((r.x1 - r.x0) / Math.hypot(r.x1 - r.x0, r.z1 - r.z0)) * 60, r.level, (r.z0 + r.z1) / 2 + ((r.z1 - r.z0) / Math.hypot(r.x1 - r.x0, r.z1 - r.z0)) * 60);
    this.group.add(m);
  }

  private buildMountains() {
    const segA = 512, segR = 44, r0 = 2300, r1 = 6400;
    const pos: number[] = [], colr: number[] = [], uv: number[] = [], idx: number[] = [];
    const c = new THREE.Color();
    const hAt = (a: number, t: number) => {
      // Big massifs (low-frequency) carved by sharper ridges, with eroded valleys between.
      const ax = Math.cos(a), az = Math.sin(a);
      const massif = fbm(ax * 1.6 + 3, az * 1.6 + t * 0.8, 3, 11) * 0.5 + 0.5;
      const ridge = ridged(ax * 4.2 + 10, az * 4.2 + t * 2.2, 5, 7);
      const rise = smoothstep(0, 0.3, t) * (1 - smoothstep(0.8, 1, t) * 0.4);
      return 40 + rise * (120 + massif * 520 + ridge * massif * 520);
    };
    for (let j = 0; j <= segR; j++) {
      const t = (j / segR) ** 1.3, r = r0 + (r1 - r0) * t;
      for (let i = 0; i <= segA; i++) {
        const a = (i / segA) * Math.PI * 2;
        const x = Math.cos(a) * r, z = Math.sin(a) * r;
        const h = hAt(a, t) + fbm(x / 160, z / 160, 3, 8) * 25 * smoothstep(0, 0.3, t);
        pos.push(x, h, z);
        uv.push(x / 60, z / 60);
        // Slope from neighbouring samples decides forest, rock and snow.
        const hn = hAt(a + 0.012, t), hr = hAt(a, Math.min(1, t + 0.03));
        const slope = Math.min(1, (Math.abs(hn - h) / (r * 0.012) + Math.abs(hr - h) / ((r1 - r0) * 0.03)) * 0.6);
        const snow = smoothstep(420, 560, h) * (1 - smoothstep(0.75, 1, slope) * 0.7);
        const rock = Math.max(smoothstep(200, 330, h), smoothstep(0.45, 0.8, slope));
        c.setRGB(0.045, 0.085, 0.035).lerp(new THREE.Color(0.15, 0.14, 0.13), rock).lerp(new THREE.Color(0.85, 0.88, 0.93), snow);
        colr.push(c.r, c.g, c.b);
      }
    }
    for (let j = 0; j < segR; j++) for (let i = 0; i < segA; i++) {
      const a = j * (segA + 1) + i, b = a + 1, d = a + segA + 1, e = d + 1;
      idx.push(a, d, b, b, d, e);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(colr, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    const detail = groundDetail();
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0, map: detail.map });
    detailShader(mat);
    const m = new THREE.Mesh(g, withCloudShadows(mat));
    m.receiveShadow = false;
    this.group.add(m);
  }

  private buildBales() {
    const rnd = mulberry32(17);
    const geo = new THREE.CylinderGeometry(0.75, 0.75, 1.2, 18);
    geo.rotateZ(Math.PI / 2);
    const fields = this.world.fields.filter((f) => f.kind === 'stubble');
    const count = fields.length * 14;
    if (!count) return;
    const mesh = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ color: 0xc9b06a, roughness: 0.95 }), count);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(1, 1, 1), p = new THREE.Vector3();
    let k = 0;
    for (const f of fields) {
      for (let n = 0; n < 14; n++) {
        const x = -TERRAIN_HALF + (f.i0 + 1 + rnd() * (f.i1 - f.i0 - 2)) * TERRAIN_CELL;
        const z = -TERRAIN_HALF + (f.j0 + 1 + rnd() * (f.j1 - f.j0 - 2)) * TERRAIN_CELL;
        p.set(x, this.world.terrainHeight(x, z) + 0.72, z);
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rnd() * Math.PI);
        mesh.setMatrixAt(k++, m.compose(p, q, s));
      }
    }
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.computeBoundingSphere();
    this.group.add(mesh);
  }

  update(time: number) {
    if (this.waterNormal) this.waterNormal.offset.set(time * 0.006, time * 0.004);
  }
}
