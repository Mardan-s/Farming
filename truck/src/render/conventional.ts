import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { MAT, box, cyl, mergeStatic, paint } from './materials';
import { cabDecal, grilleTexture, plateTexture } from './textures';
import { TRUCK_MODELS, TruckLook } from '../sim/trucks';
import { CabProfile, buildCab, panelTextures } from './cab';
import { HITCH_AHEAD } from '../sim/truck';
import { ARCH, CHECKER, HORN, LENS, Tractor, brushed, checker, insideMat, makeLightMats, shellPaint, wheel } from './vehicles';
import { buildInterior, isInteriorDetail } from './interior';

// An American-style long-nose ("conventional") sleeper tractor: the engine sits under a long
// sloping hood with the front fenders formed into it, a chrome grille stands at the front, and
// the cab and sleeper sit behind the front axle with an aero fairing over the roof. Tandem drive
// axles at the back.
//
// Local frame as for the cab-over: +z forward, +x is the LEFT side, y up, origin at the centre of
// the drive tandem on the ground.

const WB = 6.0;
const COWL_Z = 5.0;
const NOSE_Z = 7.25;
const CAB_Y0 = 1.05;
const CAB_BACK = 2.55;

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Hood half-section at a given z: centre top, round the shoulder, over the fender and down. */
function hoodSection(z: number) {
  const u = (z - COWL_Z) / (NOSE_Z - COWL_Z);
  let yTop = 2.03 - 0.23 * Math.pow(u, 1.2);
  if (u > 0.9) yTop -= ((u - 0.9) / 0.1) ** 2 * 0.07;
  const wT = 0.66 - 0.15 * u;
  const rS = 0.11, crown = 0.035;
  const ySeam = yTop - 0.27;
  // The fender: full width over the wheel, tucking in towards the bumper and back into the hood.
  const wF = wT + 0.02 + (1.235 - wT - 0.02) * smooth(5.08, 5.5, z) * (1 - 0.13 * smooth(6.85, NOSE_Z, z));
  const yFE = 1.24 + 0.08 * (1 - smooth(5.1, 5.6, z)) - 0.05 * smooth(6.8, NOSE_Z, z);
  const yBot = 0.82 + 0.06 * smooth(7.0, NOSE_Z, z);
  const pts: [number, number][] = [];
  for (let i = 0; i < 5; i++) { const x = ((wT - rS) * i) / 5; pts.push([x, yTop - crown * (x / wT) ** 2]); }
  const yS = yTop - crown * ((wT - rS) / wT) ** 2;
  for (let i = 0; i <= 4; i++) { const a = (Math.PI / 2) * (1 - i / 4); pts.push([wT - rS + Math.cos(a) * rS, yS - rS + Math.sin(a) * rS]); }
  pts.push([wT + 0.005, (yS - rS + ySeam) / 2]);
  // Rolling fender top: a quarter ellipse from the hood side out and down to the fender's edge.
  for (let i = 0; i <= 7; i++) {
    const a = (i / 7) * (Math.PI / 2);
    pts.push([wT + 0.01 + (wF - wT - 0.01) * Math.sin(a), ySeam - (ySeam - yFE) * (1 - Math.cos(a))]);
  }
  for (let i = 1; i <= 3; i++) pts.push([wF - 0.015 * i / 3, yFE - ((yFE - yBot) * i) / 3]);
  return pts;
}

function hoodGeometry(lod: boolean) {
  const rows = lod ? 14 : 44;
  const zs: number[] = [];
  for (let j = 0; j <= rows; j++) zs.push(COWL_Z + ((NOSE_Z - COWL_Z) * j) / rows);
  const half = hoodSection(COWL_Z).length;
  const per = half * 2 - 1;
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  const centres: { x: number; y: number; z: number }[][] = [];
  zs.forEach((z, j) => {
    const h = hoodSection(z);
    const ring: [number, number][] = [];
    for (let i = h.length - 1; i >= 1; i--) ring.push([-h[i][0], h[i][1]]);
    for (const p of h) ring.push(p);
    const row: { x: number; y: number; z: number }[] = [];
    ring.forEach(([x, y], i) => {
      // The grille end leans back a little at the top.
      const u = (z - COWL_Z) / (NOSE_Z - COWL_Z);
      const zz = z - 0.07 * (y - 1.3) * u ** 6;
      pos.push(x, y, zz);
      uv.push(i / (per - 1), j / rows);
      row.push({ x, y, z: zz });
    });
    centres.push(row);
  });
  for (let j = 0; j < rows; j++) for (let i = 0; i < per - 1; i++) {
    const a = centres[j][i], b = centres[j + 1][i + 1];
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, mz = (a.z + b.z) / 2;
    // Wheel-arch opening.
    if (Math.abs(mx) > 0.6 && (mz - WB) ** 2 + (my - 0.52) ** 2 < 0.64 ** 2) continue;
    const v00 = j * per + i, v10 = v00 + 1, v01 = v00 + per, v11 = v01 + 1;
    idx.push(v00, v10, v11, v00, v11, v01);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  // Make sure the faces point outwards (the top centre's normal should point up).
  const n = g.attributes.normal;
  const top = (Math.floor(rows / 2)) * per + (half - 1);
  if (n.getY(top) < 0) {
    for (let k = 0; k < idx.length; k += 3) { const t = idx[k + 1]; idx[k + 1] = idx[k + 2]; idx[k + 2] = t; }
    g.setIndex(idx);
    g.computeVertexNormals();
  }
  return { geo: g, front: centres[rows] };
}

/** A flat cap closing an outline (fan to its centroid), facing +z. */
function capGeometry(outline: { x: number; y: number; z: number }[]) {
  const c = outline.reduce((s, p) => ({ x: s.x + p.x / outline.length, y: s.y + p.y / outline.length, z: s.z + p.z / outline.length }), { x: 0, y: 0, z: 0 });
  const pos = [c.x, c.y, c.z];
  for (const p of outline) pos.push(p.x, p.y, p.z);
  const idx: number[] = [];
  for (let i = 1; i < outline.length; i++) idx.push(0, i, i + 1);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  if (g.attributes.normal.getZ(0) < 0) { for (let k = 0; k < idx.length; k += 3) { const t = idx[k + 1]; idx[k + 1] = idx[k + 2]; idx[k + 2] = t; } g.setIndex(idx); g.computeVertexNormals(); }
  return g;
}

/** A rounded bar along x whose ends sweep back (bumpers). */
function sweptBar(w: number, h: number, d: number, r: number, sweep: number, segs: number) {
  const s = new THREE.Shape();
  const hw = d / 2, hh = h / 2;
  s.moveTo(-hw + r, -hh);
  s.lineTo(hw - r, -hh); s.quadraticCurveTo(hw, -hh, hw, -hh + r);
  s.lineTo(hw, hh - r); s.quadraticCurveTo(hw, hh, hw - r, hh);
  s.lineTo(-hw + r, hh); s.quadraticCurveTo(-hw, hh, -hw, hh - r);
  s.lineTo(-hw, -hh + r); s.quadraticCurveTo(-hw, -hh, -hw + r, -hh);
  const g = new THREE.ExtrudeGeometry(s, { depth: w, steps: segs, bevelEnabled: false, curveSegments: 4 });
  // Shape x is the bar's depth (z), extrusion runs along the bar's length (x).
  g.translate(0, 0, -w / 2);
  g.rotateY(Math.PI / 2);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), f = Math.abs(x) / (w / 2);
    p.setZ(i, p.getZ(i) - sweep * Math.pow(f, 4));
  }
  g.computeVertexNormals();
  return g;
}

export function buildConventional(look: TruckLook, opts: { interior: boolean; lod?: boolean; plate?: string }): Tractor {
  const root = new THREE.Group();
  const chassis = new THREE.Group();
  const cab = new THREE.Group();
  root.add(chassis, cab);
  const lod = !!opts.lod;
  const M = look.model;
  const tall = M === 4;
  const lights = makeLightMats(lod);
  const accent = paint(look.accent, 0.4, 0.3);
  const body = paint(look.color, 0.45, 0.26);
  const bright = look.chrome ? MAT.chrome : MAT.alu;
  if (!CHECKER.map) { CHECKER.map = checker(); CHECKER.needsUpdate = true; }

  // ---------------------------------------------------------------- chassis
  for (const x of [-0.45, 0.45]) box(0.1, 0.26, 8.9, MAT.frame, x, 0.9, 2.95, chassis);
  for (const z of [-1.35, 0.0, 1.6, 3.4, 5.2, 6.7]) box(0.9, 0.1, 0.1, MAT.frame, 0, 0.88, z, chassis);
  const fifth = cyl(0.46, 0.46, 0.12, MAT.steel, 24);
  fifth.position.set(0, 1.18, HITCH_AHEAD);
  chassis.add(fifth);
  box(1.0, 0.12, 0.9, MAT.frame, 0, 1.08, HITCH_AHEAD, chassis);
  // Big round polished fuel tanks either side under the cab, on black straps.
  for (const side of [1, -1]) {
    const len = side > 0 ? 1.35 : 1.0, zc = side > 0 ? 3.62 : 3.8;
    const tank = cyl(0.31, 0.31, len, look.chrome ? MAT.chrome : brushed(), lod ? 14 : 32);
    tank.rotation.x = Math.PI / 2;
    tank.position.set(side * 0.93, 0.7, zc);
    chassis.add(tank);
    for (const e of [-1, 1]) {
      const end = new THREE.Mesh(new THREE.SphereGeometry(0.31, lod ? 12 : 28, 8, 0, Math.PI * 2, 0, Math.PI / 2), look.chrome ? MAT.chrome : brushed());
      end.scale.set(1, 0.18, 1);
      end.rotation.x = e * Math.PI / 2;
      end.position.set(side * 0.93, 0.7, zc + (e * len) / 2);
      chassis.add(end);
    }
    for (const dz of [-len * 0.32, len * 0.32]) {
      const strap = cyl(0.318, 0.318, 0.05, MAT.frame, lod ? 14 : 32);
      strap.rotation.x = Math.PI / 2;
      strap.position.set(side * 0.93, 0.7, zc + dz);
      chassis.add(strap);
    }
    const capT = cyl(0.06, 0.06, 0.05, MAT.chrome, 12); capT.position.set(side * 0.93, 1.03, zc + len * 0.2); chassis.add(capT);
    // Entry steps ahead of the tank: two treads in a black step box.
    box(0.06, 0.62, 0.42, MAT.frame, side * 1.2, 0.72, 4.55, chassis);
    for (const y of [0.5, 0.86]) {
      box(0.36, 0.05, 0.36, CHECKER, side * 1.05, y, 4.55, chassis);
      box(0.38, 0.03, 0.03, bright, side * 1.05, y + 0.03, 4.74, chassis);
    }
  }
  // Battery and tool box behind the right tank, DEF tank behind the left.
  const bb = new THREE.Mesh(new RoundedBoxGeometry(0.5, 0.48, 0.55, lod ? 1 : 2, 0.04), look.chrome ? MAT.chrome : MAT.alu);
  bb.position.set(-0.93, 0.72, 2.95);
  chassis.add(bb);
  const def = new THREE.Mesh(new RoundedBoxGeometry(0.45, 0.48, 0.4, lod ? 1 : 2, 0.08), MAT.white);
  def.position.set(0.93, 0.72, 3.03);
  chassis.add(def);
  if (!lod) {
    const defCap = cyl(0.05, 0.05, 0.04, new THREE.MeshStandardMaterial({ color: 0x1f5fd1, roughness: 0.4 }), 12); defCap.position.set(0.93, 0.98, 3.05); chassis.add(defCap);
    for (const x of [-0.24, 0.24]) { const tk = cyl(0.12, 0.12, 1.1, MAT.alu, 16); tk.rotation.x = Math.PI / 2; tk.position.set(x, 0.66, 2.3); chassis.add(tk); }
    const shaft = cyl(0.05, 0.05, 3.6, MAT.steel, 10); shaft.rotation.x = Math.PI / 2 - 0.04; shaft.position.set(0, 0.62, 2.7); chassis.add(shaft);
    const inter = cyl(0.045, 0.045, 1.3, MAT.steel, 10); inter.rotation.x = Math.PI / 2; inter.position.set(0, 0.56, 0); chassis.add(inter);
    for (const az of [-0.66, 0.66]) {
      box(1.55, 0.16, 0.16, MAT.frame, 0, 0.52, az, chassis);
      const diff = new THREE.Mesh(new THREE.SphereGeometry(0.21, 16, 10), MAT.frame); diff.position.set(0, 0.52, az); chassis.add(diff);
      for (const x of [-0.55, 0.55]) { const bag = cyl(0.12, 0.12, 0.28, MAT.rubber, 14); bag.position.set(x, 0.84, az - 0.25); chassis.add(bag); }
    }
    for (const x of [-0.55, 0.55]) box(0.1, 0.06, 2.1, MAT.steel, x, 0.68, 0, chassis);
    box(1.6, 0.12, 0.15, MAT.frame, 0, 0.5, WB, chassis);
    // Engine sump and transmission, just visible under the hood.
    box(0.7, 0.4, 1.4, MAT.frame, 0, 0.75, 5.7, chassis);
    box(0.5, 0.35, 0.8, MAT.frame, 0, 0.72, 4.6, chassis);
    // Deck plate between the rails behind the sleeper, with the air and electric lines.
    box(1.0, 0.03, 0.75, CHECKER, 0, 1.12, 2.0, chassis);
    for (const [x, col] of [[0.16, 0xc0281f], [-0.16, 0x1f4fd1], [0, 0x111111]] as const) {
      const pts: THREE.Vector3[] = [];
      for (let t = 0; t <= 1; t += 0.01) pts.push(new THREE.Vector3(x + Math.cos(t * 36) * 0.08, 2.3 - t * 1.05, 2.45 - t * 1.6 + Math.sin(t * 36) * 0.08));
      chassis.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 140, 0.017, 5), new THREE.MeshStandardMaterial({ color: col, roughness: 0.4 })));
    }
  }
  // Mud flaps behind the tandem on chrome hangers, and the rear lights on the last crossmember.
  for (const x of [-1, 1]) {
    box(0.7, 0.72, 0.02, MAT.rubber, x * 0.95, 0.5, -1.3, chassis);
    box(0.62, 0.05, 0.025, MAT.reflector, x * 0.95, 0.22, -1.312, chassis);
    const hanger = cyl(0.025, 0.025, 0.9, bright, 8); hanger.rotation.z = Math.PI / 2; hanger.position.set(x * 0.85, 0.9, -1.28); chassis.add(hanger);
    box(0.16, 0.08, 0.04, lights.tail, x * 0.62, 0.92, -1.42, chassis);
    box(0.07, 0.08, 0.04, x > 0 ? lights.indL : lights.indR, x * 0.75, 0.92, -1.42, chassis);
    box(0.06, 0.06, 0.04, lights.reverse, x * 0.5, 0.92, -1.42, chassis);
  }
  if (look.chrome) {
    // Polished quarter fenders over the tandem.
    for (const x of [-1, 1]) {
      const qf = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 0.66, 24, 1, true, Math.PI * 1.05, Math.PI * 0.45), MAT.chrome);
      qf.rotation.z = Math.PI / 2;
      qf.position.set(x * 0.96, 0.52, 0.66);
      chassis.add(qf);
    }
  }

  // ---------------------------------------------------------------- wheels
  const rimMat = look.chrome ? MAT.chrome : MAT.rim;
  const steer: THREE.Group[] = [], spin: THREE.Group[] = [];
  for (const side of [1, -1]) {
    const f = wheel(0.52, 0.36, side, rimMat, true, !lod);
    f.steer.position.set(side * 1.03, 0.52, WB);
    root.add(f.steer);
    steer.push(f.steer); spin.push(f.spin);
    if (!lod) {
      // Chrome hub cover on the steer wheels.
      const hub = new THREE.Mesh(new THREE.SphereGeometry(0.13, 18, 8, 0, Math.PI * 2, 0, Math.PI / 2), MAT.chrome);
      hub.rotation.z = -side * Math.PI / 2;
      hub.scale.set(1, 0.9, 1);
      hub.position.set(side * 0.18, 0, 0);
      f.spin.add(hub);
    }
    for (const az of [-0.66, 0.66]) for (const [x, dish] of [[1.12, true], [0.8, false]] as const) {
      const r = wheel(0.52, 0.3, side, dish ? rimMat : MAT.rimDark, dish, !lod);
      r.steer.position.set(side * x, 0.52, az);
      root.add(r.steer);
      spin.push(r.spin);
    }
    // Wheel-house liner inside the fender.
    const arch = new THREE.Mesh(new THREE.CylinderGeometry(0.64, 0.64, 0.62, 24, 1, true, -0.25, Math.PI + 0.5), ARCH);
    arch.rotation.z = Math.PI / 2;
    arch.position.set(side * 0.92, 0.52, WB);
    chassis.add(arch);
    box(0.6, 0.02, 0.45, ARCH, side * 0.92, 1.14, WB, chassis);
    // Black lip round the fender's wheel opening.
    const lipG = new THREE.TorusGeometry(0.655, 0.035, 6, lod ? 12 : 32, Math.PI + 0.5);
    lipG.rotateZ(-0.25);
    lipG.rotateY(Math.PI / 2);
    const lip = new THREE.Mesh(lipG, MAT.plastic);
    lip.scale.set(1, 1, 1);
    lip.position.set(side * 1.21, 0.52, WB);
    chassis.add(lip);
  }

  // ---------------------------------------------------------------- hood (fixed to the frame)
  const hood = hoodGeometry(lod);
  const hoodMat = body;
  chassis.add(new THREE.Mesh(hood.geo, hoodMat));
  const nose = new THREE.Mesh(capGeometry(hood.front), body);
  nose.position.z = -0.004;
  chassis.add(nose);
  const yTopF = hoodSection(NOSE_Z)[0][1] - 0.02;
  // Chrome grille: a surround, horizontal bars and a dark mesh behind, leaning back slightly.
  const grille = new THREE.Group();
  grille.position.set(0, 1.33, NOSE_Z + 0.03);
  grille.rotation.x = -0.12;
  chassis.add(grille);
  const gw = 0.94, gh = yTopF - 0.9 - 0.04;
  const gMesh = new THREE.Mesh(new THREE.PlaneGeometry(gw, gh), new THREE.MeshStandardMaterial({ map: grilleTexture(), roughness: 0.5, metalness: 0.5 }));
  gMesh.position.z = -0.03;
  grille.add(gMesh);
  const surround = (w: number, h: number, x: number, y: number) => {
    const m = new THREE.Mesh(new RoundedBoxGeometry(w, h, 0.07, lod ? 1 : 2, 0.025), MAT.chrome);
    m.position.set(x, y, 0);
    grille.add(m);
  };
  surround(gw + 0.1, 0.07, 0, gh / 2 + 0.02);
  surround(gw + 0.1, 0.07, 0, -gh / 2 - 0.02);
  surround(0.07, gh + 0.1, gw / 2 + 0.02, 0);
  surround(0.07, gh + 0.1, -gw / 2 - 0.02, 0);
  const bars = lod ? 4 : 11;
  for (let k = 1; k < bars; k++) box(gw, 0.022, 0.03, MAT.chrome, 0, -gh / 2 + (gh * k) / bars, 0.005, grille);
  if (!lod) {
    // Badge on the grille top and the bulldog-style hood emblem.
    const badge = new THREE.Mesh(new RoundedBoxGeometry(0.3, 0.07, 0.03, 2, 0.015), new THREE.MeshStandardMaterial({ color: 0x1b3d8a, metalness: 0.6, roughness: 0.3 }));
    badge.position.set(0, gh / 2 - 0.1, 0.04);
    grille.add(badge);
    box(0.32, 0.012, 0.035, MAT.chrome, 0, gh / 2 - 0.065, 0.045, grille);
    const orn = new THREE.Mesh(new RoundedBoxGeometry(0.06, 0.07, 0.22, 2, 0.02), MAT.chrome);
    orn.position.set(0, yTopF + 0.04, NOSE_Z - 0.18);
    chassis.add(orn);
  }
  // Headlamps: swept-back composite units in the fender fronts, with chrome bowls behind a clear lens.
  const headlightAnchor = new THREE.Object3D();
  headlightAnchor.position.set(0, 1.12, NOSE_Z + 0.1);
  chassis.add(headlightAnchor);
  for (const side of [1, -1]) {
    const lampG = new THREE.Group();
    lampG.position.set(side * 0.82, 1.12, NOSE_Z - 0.06);
    lampG.rotation.y = side * 0.36;
    chassis.add(lampG);
    const housing = new THREE.Mesh(new RoundedBoxGeometry(0.5, 0.22, 0.12, lod ? 1 : 2, 0.05), MAT.plastic);
    lampG.add(housing);
    if (!lod) {
      for (const dx of [-0.11, 0.11]) {
        const bowl = new THREE.Mesh(new THREE.SphereGeometry(0.085, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), MAT.chrome);
        bowl.rotation.x = Math.PI / 2;
        bowl.position.set(dx, 0, 0.065);
        bowl.scale.set(1, 0.45, 1);
        lampG.add(bowl);
        const proj = cyl(0.045, 0.045, 0.03, lights.head, 16);
        proj.rotation.x = Math.PI / 2;
        proj.position.set(dx, 0, 0.075);
        lampG.add(proj);
      }
      box(0.44, 0.018, 0.02, lights.drl, 0, -0.085, 0.07, lampG);
      const lens = new THREE.Mesh(new RoundedBoxGeometry(0.5, 0.22, 0.02, 2, 0.008), LENS);
      lens.position.z = 0.075;
      lampG.add(lens);
    } else {
      box(0.4, 0.14, 0.02, lights.head, 0, 0, 0.065, lampG);
    }
    // Amber corner marker wrapping round the fender side, and the turn signal under the lamp.
    box(0.03, 0.08, 0.2, side > 0 ? lights.indL : lights.indR, side * 1.2, 1.12, NOSE_Z - 0.45, chassis);
    box(0.2, 0.05, 0.02, side > 0 ? lights.indL : lights.indR, side * 0.86, 0.96, NOSE_Z - 0.04, chassis);
    // Hood-mounted convex mirrors on black stalks.
    if (!lod) {
      const stalk = cyl(0.012, 0.012, 0.42, MAT.plastic, 6);
      stalk.position.set(side * 1.12, 1.45, 6.95);
      stalk.rotation.z = -side * 0.35;
      chassis.add(stalk);
      const hm = cyl(0.085, 0.085, 0.05, MAT.plastic, 16);
      hm.rotation.x = Math.PI / 2;
      hm.position.set(side * 1.2, 1.64, 6.95);
      chassis.add(hm);
      const hg = cyl(0.075, 0.075, 0.005, MAT.mirror, 16);
      hg.rotation.x = Math.PI / 2;
      hg.position.set(side * 1.2, 1.64, 6.69);
      chassis.add(hg);
    }
  }
  // Hood side vents near the cowl and the model badge further forward.
  if (!lod) {
    const vent = new THREE.MeshStandardMaterial({ map: grilleTexture(), roughness: 0.6, metalness: 0.3 });
    const name = new THREE.MeshStandardMaterial({ map: cabDecal(TRUCK_MODELS[M].name, look.accent), transparent: true, alphaTest: 0.05, roughness: 0.35, metalness: 0.4, polygonOffset: true, polygonOffsetFactor: -2 });
    for (const side of [1, -1]) {
      const sec = hoodSection(5.4);
      const xs = sec[8][0] + 0.01;
      const v = new THREE.Mesh(new THREE.PlaneGeometry(0.55, 0.13), vent);
      v.position.set(side * xs, (sec[8][1] + sec[9][1]) / 2, 5.4);
      v.rotation.y = side * Math.PI / 2;
      chassis.add(v);
      const sec2 = hoodSection(6.35);
      const n = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 0.22), name);
      n.position.set(side * (sec2[8][0] + 0.012), (sec2[6][1] + sec2[9][1]) / 2, 6.35);
      n.rotation.y = side * Math.PI / 2;
      chassis.add(n);
    }
  }
  // Bumper: a heavy wrap-around bar (chrome on dressed trucks), with fog lamps and tow hooks.
  const bumperMat = look.chrome ? MAT.chrome : new THREE.MeshStandardMaterial({ color: 0xa4a9ae, metalness: 0.75, roughness: 0.32 });
  const bumper = new THREE.Mesh(sweptBar(2.5, 0.42, 0.3, 0.07, 0.4, lod ? 10 : 28), bumperMat);
  bumper.position.set(0, 0.68, NOSE_Z + 0.18);
  chassis.add(bumper);
  box(1.0, 0.04, 0.12, MAT.plastic, 0, 0.47, NOSE_Z + 0.12, chassis);
  for (const side of [1, -1]) {
    const fog = cyl(0.065, 0.065, 0.04, lights.head, 16);
    fog.rotation.x = Math.PI / 2;
    fog.position.set(side * 0.78, 0.68, NOSE_Z + 0.32);
    chassis.add(fog);
    if (!lod) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.07, 0.012, 6, 18), MAT.chrome);
      ring.position.set(side * 0.78, 0.68, NOSE_Z + 0.335);
      chassis.add(ring);
      const hook = new THREE.Mesh(new THREE.TorusGeometry(0.05, 0.016, 6, 12, Math.PI), MAT.frame);
      hook.rotation.x = Math.PI / 2;
      hook.position.set(side * 0.42, 0.48, NOSE_Z + 0.3);
      chassis.add(hook);
    }
  }
  if (opts.plate) {
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(0.52, 0.115), new THREE.MeshStandardMaterial({ map: plateTexture(opts.plate), roughness: 0.4 }));
    plate.position.set(0, 0.68, NOSE_Z + 0.335);
    chassis.add(plate);
  }

  // ---------------------------------------------------------------- cab and sleeper (air-sprung)
  const roof = 3.02;
  const prof: CabProfile = {
    winY0: 2.15, winY1: 2.84,
    zFront: [[CAB_Y0, COWL_Z - 0.03], [2.1, COWL_Z - 0.03], [2.15, COWL_Z - 0.05], [2.84, 4.5], [2.95, 4.36], [roof, 4.2]],
    halfW: [[CAB_Y0, 1.19], [2.84, 1.2], [2.97, 1.15], [roof, 1.05]],
    zBack: [[CAB_Y0, CAB_BACK + 0.03], [CAB_Y0 + 0.1, CAB_BACK], [roof - 0.08, CAB_BACK], [roof, CAB_BACK + 0.07]],
    rFront: [[CAB_Y0, 0.12], [2.15, 0.16], [2.5, 0.3], [2.84, 0.3], [roof, 0.2]],
    rBack: 0.2, doorBack: 3.85, arch: null, bow: 0.04, lettering: false,
  };
  const built = buildCab({ y0: CAB_Y0, H: roof - CAB_Y0, zBack: CAB_BACK, model: M, profile: prof }, lod);
  const shape = built.shape;
  const panel = panelTextures(shape, TRUCK_MODELS[M].name);
  const shellMat = shellPaint(look.color, panel, lod);
  cab.add(new THREE.Mesh(built.shell, shellMat));
  const glassMat = opts.interior ? MAT.glassCab : MAT.glass;
  const ws = new THREE.Mesh(built.windscreen, glassMat);
  cab.add(ws);
  const glass: THREE.Mesh[] = [ws];
  for (const g of built.sides) { const sw = new THREE.Mesh(g, glassMat); cab.add(sw); glass.push(sw); }
  const zf = (y: number, x = 0) => shape.frontZ(x, y);
  // Cowl panel between the hood and the windscreen, and the split windscreen's centre post.
  box(2.3, 0.14, 0.12, body, 0, 2.06, COWL_Z - 0.04, cab);
  const post = box(0.035, 0.75, 0.025, MAT.plastic, 0, 2.5, (zf(2.15) + zf(2.84)) / 2 + 0.03, cab);
  post.rotation.x = -Math.atan2(zf(2.15) - zf(2.84), 0.69);
  // Roof fairing over the sleeper (mid roof, or a tall raised roof on the Patriot).
  const top = tall ? 3.98 : 3.6;
  const fairProf: CabProfile = {
    winY0: top + 1, winY1: top + 2,
    zFront: [[roof - 0.04, 4.22], [roof + 0.12, 4.0], [top - 0.12, tall ? 3.25 : 3.2], [top, tall ? 3.0 : 2.95]],
    halfW: [[roof - 0.04, 1.16], [top - 0.14, 1.16], [top, 1.02]],
    zBack: [[roof - 0.04, CAB_BACK], [top - 0.12, CAB_BACK], [top, CAB_BACK + 0.12]],
    rFront: [[roof - 0.04, 0.24], [top, 0.32]],
    rBack: 0.18, doorBack: 0, arch: null, bow: 0.03, lettering: false,
  };
  const fair = buildCab({ y0: roof - 0.04, H: top - roof + 0.04, zBack: CAB_BACK, model: M, profile: fairProf }, true);
  cab.add(new THREE.Mesh(fair.shell, body));
  // Side extenders bridging the gap to the trailer.
  for (const side of [1, -1]) {
    const ext = new THREE.Mesh(new RoundedBoxGeometry(0.05, top - 1.35, 0.42, lod ? 1 : 2, 0.02), body);
    ext.position.set(side * 1.2, (top + 1.35) / 2, CAB_BACK - 0.18);
    cab.add(ext);
  }
  // Five amber marker lights across the windscreen header.
  for (let k = -2; k <= 2; k++) {
    const x = k * 0.32;
    const ml = new THREE.Mesh(new RoundedBoxGeometry(0.11, 0.05, 0.06, 1, 0.015), lights.marker);
    ml.position.set(x, roof - 0.02, zf(roof - 0.02, x) + 0.02);
    cab.add(ml);
  }
  // Drop visor (Patriot) with its own lamps.
  if (tall) {
    const visor = new THREE.Mesh(new RoundedBoxGeometry(2.3, 0.05, 0.38, lod ? 1 : 2, 0.02), look.chrome ? MAT.chrome : body);
    visor.position.set(0, 2.92, zf(2.92) + 0.17);
    visor.rotation.x = 0.22;
    cab.add(visor);
  }
  // Air horns on the roof, CB aerials on the mirrors.
  for (const x of [-0.25, 0.25]) {
    const horn = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.6, 14, 1, true), HORN);
    horn.rotation.x = -Math.PI / 2;
    horn.position.set(x, top + 0.07, 3.0);
    cab.add(horn);
  }
  const wsY0 = 2.15;
  // Wipers.
  const wipers: THREE.Group[] = [];
  if (!lod) {
    for (const px of [0.55, -0.55]) {
      const pivot = new THREE.Group();
      const py = wsY0 + 0.04;
      pivot.position.set(px, py, zf(py, px) + 0.03);
      pivot.rotation.x = shape.frontTilt(py);
      box(0.022, 0.62, 0.02, MAT.plastic, 0, 0.31, 0, pivot);
      box(0.024, 0.6, 0.02, MAT.rubber, 0.016, 0.33, 0.01, pivot);
      cab.add(pivot);
      pivot.rotation.z = Math.PI / 2 - 0.08;
      wipers.push(pivot);
    }
  }
  for (const side of [1, -1]) {
    const W = 1.2;
    // Door handle, grab handle up the A-pillar, sleeper luggage door outline handled by the texture.
    box(0.03, 0.05, 0.2, MAT.chrome, side * (W + 0.005), wsY0 - 0.14, 4.0, cab);
    const grab = cyl(0.016, 0.016, 0.8, MAT.chrome, 8);
    grab.position.set(side * (W + 0.03), 2.0, 4.9);
    cab.add(grab);
    // Accent stripe along the cab and sleeper.
    box(0.012, 0.07, COWL_Z - CAB_BACK - 0.3, accent, side * (W + 0.006), 1.55, (COWL_Z + CAB_BACK) / 2 - 0.05, cab);
    // West-coast mirrors: a tall glass on a tubular frame from the door, with a convex spot below.
    const mx = side * 1.47, mz = 4.72;
    const mBody = look.chrome ? MAT.chrome : MAT.plastic;
    for (const y of [2.18, 2.8]) {
      const arm = cyl(0.016, 0.016, 0.3, bright, 8);
      arm.rotation.z = Math.PI / 2;
      arm.position.set(side * 1.33, y, mz + 0.02);
      cab.add(arm);
    }
    const mh = new THREE.Mesh(new RoundedBoxGeometry(0.2, 0.52, 0.07, lod ? 1 : 2, 0.025), mBody);
    mh.position.set(mx, 2.5, mz);
    cab.add(mh);
    box(0.18, 0.49, 0.01, MAT.mirror, mx, 2.5, mz - 0.04, cab);
    const conv = cyl(0.09, 0.09, 0.05, mBody, 16);
    conv.rotation.x = Math.PI / 2;
    conv.position.set(mx, 2.08, mz);
    cab.add(conv);
    const convG = cyl(0.08, 0.08, 0.005, MAT.mirror, 16);
    convG.rotation.x = Math.PI / 2;
    convG.position.set(mx, 2.08, mz - 0.028);
    cab.add(convG);
    // Sleeper side: a small porthole window and a luggage door.
    if (!lod) {
      const port = new THREE.Mesh(new RoundedBoxGeometry(0.02, 0.3, 0.42, 2, 0.008), MAT.glass);
      port.position.set(side * (W + 0.002), 2.55, 3.2);
      cab.add(port);
      box(0.012, 0.42, 0.62, MAT.plastic, side * (W + 0.003), 1.42, 3.05, cab);
      box(0.014, 0.38, 0.58, shellMat, side * (W + 0.006), 1.42, 3.05, cab);
    }
  }
  // Exhaust stacks behind the sleeper, with perforated heat shields and mitred tips.
  const exhaustTip = new THREE.Object3D();
  const stackTop = top + 0.45;
  for (const x of [-1.08, 1.08]) {
    const stack = cyl(0.065, 0.065, stackTop - 0.9, MAT.chrome, 18);
    stack.position.set(x, (stackTop + 0.9) / 2, CAB_BACK - 0.16);
    chassis.add(stack);
    const shield = cyl(0.095, 0.095, 1.3, MAT.alu, 18);
    shield.position.set(x, 1.9, CAB_BACK - 0.16);
    chassis.add(shield);
    const tip = cyl(0.068, 0.068, 0.18, MAT.chrome, 18);
    tip.rotation.x = -0.6;
    tip.position.set(x, stackTop + 0.05, CAB_BACK - 0.2);
    chassis.add(tip);
    for (const y of [1.3, 2.5]) { const clamp = cyl(0.1, 0.1, 0.04, MAT.steel, 18); clamp.position.set(x, y, CAB_BACK - 0.16); chassis.add(clamp); }
  }
  exhaustTip.position.set(-1.08, stackTop + 0.1, CAB_BACK - 0.25);
  root.add(exhaustTip);

  // The cab interior (see interior.ts).
  let steeringWheel = new THREE.Group();
  let dashScreen: THREE.Mesh | null = null;
  let gpsScreen: THREE.Mesh | null = null;
  let eye = new THREE.Vector3(0.6, 2.6, 3.6);
  if (opts.interior) {
    const inner = buildInterior(shape, built.shell, { floor: CAB_Y0 + 0.1 });
    cab.add(inner.group);
    ({ steeringWheel, dashScreen, gpsScreen, eye } = inner);
  }

  const keep: THREE.Object3D[] = [steeringWheel, headlightAnchor, ...wipers, ...glass];
  if (dashScreen) keep.push(dashScreen);
  if (gpsScreen) keep.push(gpsScreen);
  mergeStatic(cab, keep);
  mergeStatic(chassis, [headlightAnchor]);
  const cabDetail: THREE.Object3D[] = [];
  cab.traverse((o) => { if (o instanceof THREE.Mesh && isInteriorDetail(o.material)) cabDetail.push(o); });
  root.traverse((o) => { if (o instanceof THREE.Mesh) { o.castShadow = !o.userData.noShadow && !insideMat(o.material); o.receiveShadow = true; } });
  for (const g of glass) g.castShadow = false;
  return {
    root, cab, steer, spin, steeringWheel, exhaustTip, glass, dashScreen, gpsScreen, lights, headlightAnchor,
    paintMat: shellMat, model: M, exterior: [], wipers, cabDetail,
    fit: {
      pivot: new THREE.Vector3(0, CAB_Y0, 3.8),
      eye,
      head: new THREE.Vector3(0.82, 1.12, NOSE_Z + 0.1),
      mirror: new THREE.Vector3(1.47, 2.5, 4.72),
      mirrorSize: [0.18, 0.49],
    },
  };
}
