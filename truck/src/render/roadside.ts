import * as THREE from 'three';
import { BARRIER_HALF, CARRIAGE_OUT, MEDIAN_HALF, RAIL_LAT, laneLat } from '../sim/road';
import type { Depot, World } from '../sim/world';
import { bayOffsets, yardProps } from '../sim/yard';
import { MAT, box, cyl, lamp, mergeStatic } from './materials';
import { ROAD_TEX_LEN, ROAD_TEX_W, asphalt, concrete, depotBoard, gantrySign, groundDetail, radial, speedSign } from './textures';
import { buildTrailer } from './vehicles';

// The motorway itself and everything along it: asphalt, verges, the concrete median barrier,
// guard rails, delineator posts, street lights, overhead direction signs, and the depot yards.

interface Col { lat: number; dy?: number; u: number; terrain?: boolean; color?: THREE.Color }

/** Builds a strip along road samples [i0, i1] with the given cross-section columns. */
function strip(world: World, i0: number, i1: number, cols: Col[], vLen: number, skip?: (s: number) => boolean) {
  const road = world.road;
  const rows = i1 - i0 + 1, nc = cols.length;
  const pos = new Float32Array(rows * nc * 3), uv = new Float32Array(rows * nc * 2);
  const color = cols.some((c) => c.color) ? new Float32Array(rows * nc * 3) : null;
  for (let r = 0; r < rows; r++) {
    const i = (i0 + r) % road.n;
    const s = (i0 + r) * road.step;
    const px = road.px[i], pz = road.pz[i], py = road.py[i], tx = road.tx[i], tz = road.tz[i];
    for (let c = 0; c < nc; c++) {
      const col = cols[c];
      const x = px - tz * col.lat, z = pz + tx * col.lat;
      const y = col.terrain ? world.terrainHeight(x, z) + 0.05 : py + (col.dy ?? 0);
      const k = r * nc + c;
      pos[k * 3] = x; pos[k * 3 + 1] = y; pos[k * 3 + 2] = z;
      uv[k * 2] = col.u; uv[k * 2 + 1] = s / vLen;
      if (color) { const cc = col.color ?? new THREE.Color(1, 1, 1); color[k * 3] = cc.r; color[k * 3 + 1] = cc.g; color[k * 3 + 2] = cc.b; }
    }
  }
  const idx: number[] = [];
  for (let r = 0; r < rows - 1; r++) {
    if (skip && skip((i0 + r + 0.5) * road.step)) continue;
    for (let c = 0; c < nc - 1; c++) {
      const a = r * nc + c, b = a + 1, d = a + nc, e = d + 1;
      idx.push(a, b, d, b, e, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  if (color) g.setAttribute('color', new THREE.BufferAttribute(color, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

export interface LampSpot { x: number; y: number; z: number }

export class Roadside {
  readonly group = new THREE.Group();
  readonly lampHeads: THREE.MeshStandardMaterial;
  readonly lamps: LampSpot[] = [];
  readonly reflectors: THREE.MeshStandardMaterial;
  private marker: THREE.Group;
  private markerBeam: THREE.Mesh;
  private markerRing: THREE.MeshStandardMaterial;
  private canopyLight: THREE.MeshStandardMaterial;
  private windowsLit: THREE.MeshStandardMaterial[] = [];

  constructor(private world: World) {
    const road = world.road;
    this.lampHeads = lamp(0xffd9a0, 0xb8b0a0);
    this.reflectors = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xff8a20, emissiveIntensity: 0.2, roughness: 0.3 });
    this.canopyLight = lamp(0xffffff, 0xdddddd);
    const tex = asphalt();
    const roadMat = new THREE.MeshStandardMaterial({ map: tex.map, roughnessMap: tex.roughness, normalMap: tex.normal, normalScale: new THREE.Vector2(0.6, 0.6), roughness: 1, metalness: 0 });
    this.roadMat = roadMat;
    const detail = groundDetail();
    const vergeMat = new THREE.MeshStandardMaterial({ vertexColors: true, map: detail.map, roughness: 0.95 });
    vergeMat.onBeforeCompile = (sh) => {
      sh.fragmentShader = sh.fragmentShader.replace('#include <map_fragment>', '#ifdef USE_MAP\n diffuseColor.rgb *= texture2D(map, vMapUv).rgb * 2.0;\n#endif');
    };
    const barrierMat = new THREE.MeshStandardMaterial({ color: 0xb5b2aa, roughness: 0.85, map: concrete(12, 0.62, false) });
    const railMat = new THREE.MeshStandardMaterial({ color: 0xc1c6cc, metalness: 0.85, roughness: 0.32, side: THREE.DoubleSide });
    const uIn = -MEDIAN_HALF / ROAD_TEX_W;
    const gravel = new THREE.Color(0.19, 0.175, 0.15), grass = new THREE.Color(0.1, 0.13, 0.05), dirt = new THREE.Color(0.13, 0.13, 0.08);
    const CH = 100;
    for (let i0 = 0; i0 < road.n; i0 += CH) {
      const i1 = Math.min(road.n, i0 + CH);
      for (const side of [1, -1]) {
        const g = strip(world, i0, i1, side > 0
          ? [{ lat: 0, u: uIn }, { lat: CARRIAGE_OUT, u: 1, dy: -0.06 }]
          : [{ lat: -CARRIAGE_OUT, u: 1, dy: -0.06 }, { lat: 0, u: uIn }], ROAD_TEX_LEN);
        const m = new THREE.Mesh(g, roadMat);
        m.receiveShadow = true;
        this.group.add(m);
        const verge = strip(world, i0, i1, side > 0
          ? [{ lat: CARRIAGE_OUT - 0.02, dy: -0.07, u: 0, color: gravel }, { lat: CARRIAGE_OUT + 1.4, dy: -0.2, u: 0.2, color: dirt }, { lat: CARRIAGE_OUT + 4.5, u: 1, terrain: true, color: grass }]
          : [{ lat: -CARRIAGE_OUT - 4.5, u: 1, terrain: true, color: grass }, { lat: -CARRIAGE_OUT - 1.4, dy: -0.2, u: 0.2, color: dirt }, { lat: -CARRIAGE_OUT + 0.02, dy: -0.07, u: 0, color: gravel }], 7,
        side > 0 ? (s) => world.depotAt(s, CARRIAGE_OUT + 1) !== null : undefined);
        const vm = new THREE.Mesh(verge, vergeMat);
        vm.receiveShadow = true;
        this.group.add(vm);
        // Guard rail (W-beam) with gaps at depot entrances.
        const R = side * RAIL_LAT;
        const rail = strip(world, i0, i1, [
          { lat: R, dy: 0.52, u: 0 }, { lat: R - side * 0.07, dy: 0.6, u: 0.25 }, { lat: R, dy: 0.68, u: 0.5 }, { lat: R - side * 0.07, dy: 0.76, u: 0.75 }, { lat: R, dy: 0.84, u: 1 },
        ], 4, side > 0 ? (s) => world.railGap(s) : undefined);
        const rm = new THREE.Mesh(rail, railMat);
        rm.castShadow = true;
        rm.receiveShadow = true;
        this.group.add(rm);
      }
      const barrier = strip(world, i0, i1, [
        { lat: -BARRIER_HALF, dy: 0, u: 0 }, { lat: -0.26, dy: 0.08, u: 0.1 }, { lat: -0.11, dy: 0.33, u: 0.3 }, { lat: -0.085, dy: 0.82, u: 0.48 },
        { lat: 0.085, dy: 0.82, u: 0.52 }, { lat: 0.11, dy: 0.33, u: 0.7 }, { lat: 0.26, dy: 0.08, u: 0.9 }, { lat: BARRIER_HALF, dy: 0, u: 1 },
      ], 3);
      const bm = new THREE.Mesh(barrier, barrierMat);
      bm.castShadow = true;
      bm.receiveShadow = true;
      this.group.add(bm);
    }
    this.buildPosts();
    this.buildLamps();
    this.buildSigns();
    for (const d of world.depots) this.buildYard(d);
    const m = this.buildMarker();
    this.marker = m.group;
    this.markerBeam = m.beam;
    this.markerRing = m.ring;
  }

  readonly roadMat: THREE.MeshStandardMaterial;

  private instanced(geo: THREE.BufferGeometry, mat: THREE.Material, mats: THREE.Matrix4[], shadow = true) {
    const m = new THREE.InstancedMesh(geo, mat, mats.length);
    mats.forEach((x, i) => m.setMatrixAt(i, x));
    m.castShadow = shadow;
    m.receiveShadow = true;
    m.computeBoundingSphere();
    this.group.add(m);
    return m;
  }

  private place(s: number, lat: number, dy: number, yaw = 0, sc = 1) {
    const road = this.world.road;
    const p = road.toWorld(s, lat, { x: 0, y: 0, z: 0 });
    const t = road.sample(s, { x: 0, y: 0, z: 0, tx: 0, tz: 1 });
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(t.tx, t.tz) + yaw);
    return new THREE.Matrix4().compose(new THREE.Vector3(p.x, p.y + dy, p.z), q, new THREE.Vector3(sc, sc, sc));
  }

  private buildPosts() {
    const road = this.world.road;
    const posts: THREE.Matrix4[] = [], delin: THREE.Matrix4[] = [], refl: THREE.Matrix4[] = [];
    for (let s = 0; s < road.length; s += 4) {
      for (const side of [1, -1]) {
        if (side > 0 && this.world.railGap(s)) continue;
        posts.push(this.place(s, side * (RAIL_LAT + 0.12), 0.32));
      }
    }
    for (let s = 0; s < road.length; s += 50) {
      for (const side of [1, -1]) {
        if (side > 0 && this.world.railGap(s)) continue;
        delin.push(this.place(s, side * (RAIL_LAT + 0.7), 0.55));
        refl.push(this.place(s, side * (RAIL_LAT + 0.7), 0.95, side > 0 ? Math.PI : 0));
      }
    }
    this.instanced(new THREE.BoxGeometry(0.1, 0.65, 0.14), MAT.galvanized, posts);
    this.instanced(new THREE.BoxGeometry(0.12, 1.1, 0.12), MAT.white, delin);
    this.instanced(new THREE.BoxGeometry(0.13, 0.1, 0.13), this.reflectors, refl, false);
  }

  private buildLamps() {
    const road = this.world.road;
    const poles: THREE.Matrix4[] = [], heads: THREE.Matrix4[] = [];
    const pole = new THREE.Group();
    const p = cyl(0.09, 0.14, 11, MAT.galvanized, 10);
    p.position.y = 5.5;
    pole.add(p);
    for (const side of [1, -1]) {
      const arm = cyl(0.05, 0.05, 2.4, MAT.galvanized, 6);
      arm.rotation.z = Math.PI / 2 - side * 0.15;
      arm.position.set(side * 1.15, 10.9, 0);
      pole.add(arm);
    }
    mergeStatic(pole);
    const poleGeo = (pole.children[0] as THREE.Mesh).geometry;
    for (const d of this.world.depots) {
      for (let off = -520; off <= 420; off += 42) {
        const s = d.s + off;
        poles.push(this.place(s, 0, 0.8));
        for (const side of [1, -1]) {
          heads.push(this.place(s, side * 2.3, 10.75));
          const w = road.toWorld(s, side * 2.3, { x: 0, y: 0, z: 0 });
          this.lamps.push({ x: w.x, y: w.y + 10.4, z: w.z });
        }
      }
    }
    // Arms are built along local x, which place() lines up across the road.
    this.instanced(poleGeo, MAT.galvanized, poles);
    this.instanced(new THREE.BoxGeometry(0.42, 0.12, 0.85), this.lampHeads, heads, false);
  }

  private buildSigns() {
    const road = this.world.road;
    const deps = this.world.depots;
    const signLat = (laneLat(1, 0) + laneLat(1, 1)) / 2;
    deps.forEach((d, k) => {
      const next = deps[(k + 1) % deps.length];
      for (const before of [1000, 450]) {
        const s = d.s - before;
        const g = new THREE.Group();
        const distNext = Math.round((road.ahead(s, next.s)) / 100) / 10;
        const tex = gantrySign([[d.name, before >= 1000 ? '1 km' : '500 m'], [next.name, `${distNext} km`]], 'EXIT ' + (k + 1));
        const panel = new THREE.Mesh(new THREE.PlaneGeometry(8.2, 3.1), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.45, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0 }));
        this.signMats.push(panel.material as THREE.MeshStandardMaterial);
        panel.position.set(0, 5.6, 0.12);
        g.add(panel);
        const back = box(8.3, 3.2, 0.1, MAT.alu, 0, 5.6, 0.04);
        g.add(back);
        g.applyMatrix4(this.place(s, signLat, 0, Math.PI));
        this.group.add(g);
        // Gantry: two posts and a truss across the carriageway. Turned to face traffic, local +x is +lat.
        const span = RAIL_LAT + 1.2 - 0.6;
        const truss = new THREE.Group();
        for (const lat of [0.6, RAIL_LAT + 1.2]) {
          const post = cyl(0.18, 0.2, 7.6, MAT.galvanized, 10);
          post.position.set(lat - signLat, 3.8, 0);
          truss.add(post);
        }
        for (const y of [7.1, 7.6]) truss.add(box(span + 0.6, 0.12, 0.12, MAT.galvanized, 0.6 + span / 2 - signLat, y, 0));
        mergeStatic(truss);
        truss.applyMatrix4(this.place(s, signLat, 0, Math.PI));
        this.group.add(truss);
      }
    });
    // Speed limit signs on the right shoulder.
    const tex = speedSign(90);
    const signMat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.4, transparent: true, alphaTest: 0.5 });
    const plates: THREE.Matrix4[] = [], poles: THREE.Matrix4[] = [];
    for (let s = 300; s < road.length; s += 1300) {
      if (this.world.railGap(s)) continue;
      plates.push(this.place(s, RAIL_LAT + 1.3, 2.4, Math.PI));
      poles.push(this.place(s, RAIL_LAT + 1.3, 1.2));
    }
    this.instanced(new THREE.CircleGeometry(0.42, 32), signMat, plates, false);
    this.instanced(new THREE.CylinderGeometry(0.04, 0.04, 2.4, 8), MAT.galvanized, poles);
  }

  private signMats: THREE.MeshStandardMaterial[] = [];

  private buildYard(d: Depot) {
    const road = this.world.road;
    const i0 = Math.floor((d.s - d.sHalf) / road.step), i1 = Math.ceil((d.s + d.sHalf) / road.step);
    const yardMat = new THREE.MeshStandardMaterial({ map: concrete(d.id + 3, 0.42), roughness: 0.85 });
    yardMat.map!.repeat.set(1, 1);
    const g = strip(this.world, i0 < 0 ? i0 + road.n : i0, (i0 < 0 ? i0 + road.n : i0) + (i1 - i0), [
      { lat: CARRIAGE_OUT - 0.05, dy: -0.02, u: 0 }, { lat: CARRIAGE_OUT + d.depth, dy: -0.02, u: d.depth / 12 },
    ], 12);
    const ym = new THREE.Mesh(g, yardMat);
    ym.receiveShadow = true;
    ym.renderOrder = 1;
    yardMat.polygonOffset = true;
    yardMat.polygonOffsetFactor = -1;
    this.group.add(ym);

    // Bay markings.
    const lineMat = new THREE.MeshStandardMaterial({ color: 0xe9e9e2, roughness: 0.7, polygonOffset: true, polygonOffsetFactor: -3 });
    const bays = new THREE.Group();
    for (const off of bayOffsets(d)) {
      for (const [ds, dl, len, w] of [[0, -2.2, 18, 0.15], [0, 2.2, 18, 0.15], [-9, 0, 0.15, 4.4], [9, 0, 0.15, 4.4]] as const) {
        const m = new THREE.Mesh(new THREE.PlaneGeometry(w, len), lineMat);
        m.rotation.x = -Math.PI / 2;
        m.applyMatrix4(this.place(d.s + off + ds, d.bayLat + dl, 0.01));
        bays.add(m);
      }
    }
    this.group.add(bays);

    // Fence around the back and sides of the yard.
    const fenceTex = fenceTexture();
    const fenceMat = new THREE.MeshStandardMaterial({ map: fenceTex, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.6, metalness: 0.3 });
    const back = CARRIAGE_OUT + d.depth + 0.4;
    const path: { x: number; y: number; z: number }[] = [];
    const push = (s: number, lat: number) => { const p = road.toWorld(s, lat, { x: 0, y: 0, z: 0 }); path.push(p); };
    push(d.s - d.sHalf, RAIL_LAT);
    for (let s = d.s - d.sHalf; s <= d.s + d.sHalf + 0.01; s += 4) push(s, back);
    push(d.s + d.sHalf, RAIL_LAT);
    this.group.add(new THREE.Mesh(fenceGeometry(path, 2.3), fenceMat));

    // Company board at the entrance.
    const board = new THREE.Group();
    const bt = depotBoard(d.name, d.company, d.color);
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(7, 1.75), new THREE.MeshStandardMaterial({ map: bt, roughness: 0.4, emissive: 0xffffff, emissiveMap: bt, emissiveIntensity: 0 }));
    this.signMats.push(panel.material as THREE.MeshStandardMaterial);
    panel.position.set(0, 4.2, 0.08);
    board.add(panel);
    box(7.1, 1.85, 0.12, MAT.alu, 0, 4.2, 0, board);
    for (const x of [-2.8, 2.8]) { const p = cyl(0.1, 0.1, 5, MAT.galvanized, 8); p.position.set(x, 2.5, 0); board.add(p); }
    board.applyMatrix4(this.place(d.s - d.sHalf - 6, RAIL_LAT + 3.5, 0, Math.PI));
    this.group.add(board);

    for (const pr of yardProps(d)) {
      if (pr.kind === 'trailer') {
        const t = buildTrailer(pr.trailer, pr.livery, { lod: true });
        t.root.applyMatrix4(this.place(pr.s - 5.2, pr.lat, 0));
        this.group.add(t.root);
        // Parked trailers stand on their landing legs.
      } else if (pr.kind === 'canopy') {
        const c = new THREE.Group();
        box(11, 0.7, 20, MAT.white, 0, 6.2, 0, c);
        box(11.1, 0.35, 20.1, new THREE.MeshStandardMaterial({ color: d.color, roughness: 0.4 }), 0, 6.0, 0, c);
        for (const [x, z] of [[-4.6, -6], [-4.6, 6], [4.6, -6], [4.6, 6]]) { const p = cyl(0.22, 0.22, 5.9, MAT.white, 12); p.position.set(x, 2.95, z); c.add(p); }
        for (const z of [-6, -2, 2, 6]) box(8, 0.04, 0.5, this.canopyLight, 0, 5.84, z, c);
        c.applyMatrix4(this.place(pr.s, pr.lat, 0, Math.PI / 2));
        this.group.add(c);
      } else if (pr.kind === 'island') {
        const c = new THREE.Group();
        box(1.3, 0.2, 6.4, MAT.concrete, 0, 0.1, 0, c);
        for (const z of [-1.6, 1.6]) {
          box(0.6, 1.9, 0.9, MAT.white, 0, 1.15, z, c);
          box(0.62, 0.35, 0.92, new THREE.MeshStandardMaterial({ color: d.color, roughness: 0.4 }), 0, 1.9, z, c);
          box(0.3, 0.4, 0.02, new THREE.MeshStandardMaterial({ color: 0x0a1a10, emissive: 0x44ff88, emissiveIntensity: 0.6 }), 0.32, 1.4, z, c);
        }
        mergeStatic(c);
        c.applyMatrix4(this.place(pr.s, pr.lat, 0));
        this.group.add(c);
      } else {
        const c = new THREE.Group();
        const p = cyl(0.14, 0.22, 16, MAT.galvanized, 10); p.position.y = 8; c.add(p);
        box(2.4, 0.5, 0.5, MAT.galvanized, 0, 16, 0, c);
        for (const x of [-0.8, 0, 0.8]) box(0.5, 0.06, 0.3, this.lampHeads, x, 15.72, 0.2, c);
        c.applyMatrix4(this.place(pr.s, pr.lat, 0, Math.PI));
        this.group.add(c);
        const w = road.toWorld(pr.s, pr.lat - 6, { x: 0, y: 0, z: 0 });
        this.lamps.push({ x: w.x, y: w.y + 14, z: w.z });
      }
    }
  }

  private buildMarker() {
    const group = new THREE.Group();
    const beamMat = new THREE.MeshBasicMaterial({ map: beamTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, color: 0xffa040, fog: false });
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.2, 120, 24, 1, true), beamMat);
    beam.position.y = 60;
    group.add(beam);
    const ring = new THREE.MeshStandardMaterial({ color: 0x331a00, emissive: 0xff9a2a, emissiveIntensity: 3, polygonOffset: true, polygonOffsetFactor: -4 });
    for (const [dl, ds, w, l] of [[-2.25, 0, 0.3, 18.6], [2.25, 0, 0.3, 18.6], [0, -9.2, 4.8, 0.3], [0, 9.2, 4.8, 0.3]]) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, l), ring);
      m.rotation.x = -Math.PI / 2;
      m.position.set(-dl, 0.03, ds);
      group.add(m);
    }
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: radial('rgba(255,170,60,1)'), color: 0xffffff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
    glow.scale.set(14, 14, 1);
    glow.position.y = 4;
    group.add(glow);
    group.visible = false;
    this.group.add(group);
    return { group, beam, ring };
  }

  /** Highlights the delivery bay at the job's destination (or hides it). */
  setMarker(d: Depot | null) {
    this.marker.visible = !!d;
    if (!d) return;
    this.marker.matrixAutoUpdate = true;
    const m = this.place(d.bayS, d.bayLat, 0);
    m.decompose(this.marker.position, this.marker.quaternion, this.marker.scale);
  }

  update(time: number, night: number, camDist: number) {
    this.lampHeads.emissiveIntensity = night > 0.3 ? 3.2 : 0;
    this.canopyLight.emissiveIntensity = night > 0.3 ? 3 : 0.2;
    this.reflectors.emissiveIntensity = 0.2 + night * 2.5;
    for (const m of this.signMats) m.emissiveIntensity = night * 0.35;
    for (const m of this.windowsLit) m.emissiveIntensity = night;
    if (this.marker.visible) {
      this.markerRing.emissiveIntensity = 2 + Math.sin(time * 4) * 1.4;
      (this.markerBeam.material as THREE.MeshBasicMaterial).opacity = Math.min(1, 0.25 + camDist / 400);
    }
  }
}

function fenceTexture() {
  const W = 256, H = 128;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d')!;
  g.strokeStyle = 'rgba(40,70,50,1)';
  g.lineWidth = 2;
  for (let k = -H; k < W + H; k += 12) {
    g.beginPath(); g.moveTo(k, 0); g.lineTo(k + H, H); g.stroke();
    g.beginPath(); g.moveTo(k + H, 0); g.lineTo(k, H); g.stroke();
  }
  g.fillStyle = 'rgba(30,55,40,1)';
  g.fillRect(0, 0, W, 6); g.fillRect(0, H - 6, W, 6);
  g.fillRect(0, 0, 8, H);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

function fenceGeometry(path: { x: number; y: number; z: number }[], h: number) {
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  let u = 0;
  path.forEach((p, i) => {
    if (i > 0) u += Math.hypot(p.x - path[i - 1].x, p.z - path[i - 1].z) / 2.6;
    pos.push(p.x, p.y, p.z, p.x, p.y + h, p.z);
    uv.push(u, 0, u, 1);
    if (i > 0) { const a = (i - 1) * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function beamTexture() {
  const c = document.createElement('canvas');
  c.width = 4; c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createLinearGradient(0, 0, 0, 128);
  grad.addColorStop(0, 'rgba(255,255,255,0)');
  grad.addColorStop(0.7, 'rgba(255,255,255,0.12)');
  grad.addColorStop(1, 'rgba(255,255,255,0.45)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 4, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

