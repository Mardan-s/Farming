import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { MAT, cyl } from './materials';
import { normalFromCanvas } from './textures';
import { CabShape } from './cab';
import { brakeKnob, buildCluster, isCockpitMaterial, buildWheel, cockpitMats, Cockpit, facePanel, ignition, knob, legendPlaneOf, rockerBank, vent } from './cockpit';
import { mulberry32 } from '../util';

// The cab interior, fitted to any cab shell. The walls, pillars and headliner are the shell itself
// seen from inside (so they follow the real shape and window openings); everything else is placed
// from three reference points: the foot of the windscreen, the floor and the sleeper's back wall.

export interface InteriorBuild {
  group: THREE.Group;
  steeringWheel: THREE.Group;
  dashScreen: THREE.Mesh;
  gpsScreen: THREE.Mesh;
  cockpit: Cockpit;
  eye: THREE.Vector3;
}

// ------------------------------------------------------------------ materials

const canvas = (w: number, h: number) => {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return [c, c.getContext('2d')!] as const;
};
const texOf = (c: HTMLCanvasElement, srgb = true, rep = true) => {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (rep) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
};
const rep = (t: THREE.Texture, u: number, v: number) => { t.repeat.set(u, v); return t; };

/** Grey noise height field: fine grain for plastics and leather. */
function grainCanvas(size: number, scale: number, seed: number) {
  const [c, g] = canvas(size, size);
  const img = g.createImageData(size, size);
  const rnd = mulberry32(seed);
  const cells = new Float32Array(size * size);
  // Cheap cellular grain: a few blurred passes of white noise.
  for (let i = 0; i < cells.length; i++) cells[i] = rnd();
  for (let pass = 0; pass < scale; pass++) {
    const nxt = new Float32Array(cells.length);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      let s = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += cells[((y + dy + size) % size) * size + ((x + dx + size) % size)];
      nxt[y * size + x] = s / 9;
    }
    cells.set(nxt);
  }
  let lo = 1, hi = 0;
  for (const v of cells) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  for (let i = 0; i < cells.length; i++) { const v = ((cells[i] - lo) / (hi - lo)) * 255; img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255; }
  g.putImageData(img, 0, 0);
  return c;
}

interface Mats {
  wall: THREE.MeshStandardMaterial;
  dashTop: THREE.MeshStandardMaterial;
  dash: THREE.MeshStandardMaterial;
  trim: THREE.MeshStandardMaterial;
  light: THREE.MeshStandardMaterial;
  leather: THREE.MeshStandardMaterial;
  seat: THREE.MeshStandardMaterial;
  floor: THREE.MeshStandardMaterial;
  carpet: THREE.MeshStandardMaterial;
  quilt: THREE.MeshStandardMaterial;
  sheet: THREE.MeshStandardMaterial;
  curtain: THREE.MeshStandardMaterial;
  wood: THREE.MeshStandardMaterial;
  alu: THREE.MeshStandardMaterial;
  black: THREE.MeshStandardMaterial;
  switches: THREE.MeshStandardMaterial;
  speaker: THREE.MeshStandardMaterial;
  paper: THREE.MeshStandardMaterial;
  yellow: THREE.MeshStandardMaterial;
  red: THREE.MeshStandardMaterial;
  green: THREE.MeshStandardMaterial;
  cup: THREE.MeshStandardMaterial;
  radio: THREE.MeshStandardMaterial;
}
let mats: Mats | null = null;
const all = new Set<THREE.Material>();

export function isInteriorMaterial(m: THREE.Material) { return all.has(m) || isCockpitMaterial(m); }

/** Interior parts too small to matter through the windows: hidden outside the cab view. */
export function isInteriorDetail(m: THREE.Material | THREE.Material[]) {
  if (Array.isArray(m) || !mats) return false;
  if (isCockpitMaterial(m)) return true;
  if (!all.has(m)) return false;
  return m !== mats.wall && m !== mats.seat && m !== mats.leather && m !== mats.dashTop && m !== mats.dash;
}

/** Strength of the bounced daylight inside the cab (0 at night). */
export function setCabAmbient(v: number) {
  if (!mats) return;
  for (const m of Object.values(mats)) if (!m.userData.lit) m.emissiveIntensity = v;
}

function interiorMats(shape: CabShape): Mats {
  if (mats) return mats;
  const grain = normalFromCanvas(grainCanvas(256, 2, 11), 2.2);
  grain.wrapS = grain.wrapT = THREE.RepeatWrapping;
  const leatherN = normalFromCanvas(grainCanvas(256, 3, 23), 4);
  leatherN.wrapS = leatherN.wrapT = THREE.RepeatWrapping;

  // Inside of the shell: dark trim below the waist, grey pillars, a light fabric headliner on top.
  const [wc, wg] = canvas(16, 512);
  const Y = (t: number) => (1 - t) * 512;
  const t0 = shape.win.t0, t1 = shape.win.t1;
  wg.fillStyle = '#2b2c2f'; wg.fillRect(0, 0, 16, 512);
  wg.fillStyle = '#55565a'; wg.fillRect(0, Y(t1 + 0.02), 16, Y(t0 - 0.03) - Y(t1 + 0.02));
  wg.fillStyle = '#a49e93'; wg.fillRect(0, 0, 16, Y(t1 + 0.03));
  wg.fillStyle = '#1d1e20'; wg.fillRect(0, Y(t0 - 0.03), 16, 4);
  const wallMap = texOf(wc, true, false);

  const seatC = (() => {
    // Woven centre panel with quilted stitching, darker leatherette around it.
    const [c, g] = canvas(256, 256);
    g.fillStyle = '#2a2c31'; g.fillRect(0, 0, 256, 256);
    const rnd = mulberry32(5);
    for (let i = 0; i < 9000; i++) { const v = 34 + rnd() * 22; g.fillStyle = `rgb(${v},${v + 1},${v + 6})`; g.fillRect(rnd() * 256, rnd() * 256, 2, 1); }
    g.strokeStyle = 'rgba(0,0,0,0.6)'; g.lineWidth = 3;
    for (let y = 32; y < 256; y += 48) { g.beginPath(); g.moveTo(0, y); g.lineTo(256, y); g.stroke(); }
    g.strokeStyle = 'rgba(150,150,160,0.35)'; g.lineWidth = 1; g.setLineDash([3, 3]);
    for (let y = 32; y < 256; y += 48) for (const o of [-5, 5]) { g.beginPath(); g.moveTo(0, y + o); g.lineTo(256, y + o); g.stroke(); }
    return c;
  })();
  const seatMap = texOf(seatC);
  const seatN = normalFromCanvas(seatC, 3);
  seatN.wrapS = seatN.wrapT = THREE.RepeatWrapping;

  const floorC = (() => {
    const [c, g] = canvas(128, 128);
    g.fillStyle = '#18191b'; g.fillRect(0, 0, 128, 128);
    for (let x = 0; x < 128; x += 8) { g.fillStyle = '#26272a'; g.fillRect(x, 0, 3, 128); }
    return c;
  })();
  const floorN = normalFromCanvas(floorC, 3);
  floorN.wrapS = floorN.wrapT = THREE.RepeatWrapping;

  const quiltC = (() => {
    const [c, g] = canvas(256, 256);
    g.fillStyle = '#3d4a5c'; g.fillRect(0, 0, 256, 256);
    g.strokeStyle = '#2b3542'; g.lineWidth = 4;
    for (let k = -256; k < 512; k += 42) { g.beginPath(); g.moveTo(k, 0); g.lineTo(k + 256, 256); g.stroke(); g.beginPath(); g.moveTo(k + 256, 0); g.lineTo(k, 256); g.stroke(); }
    return c;
  })();

  const curtainC = (() => {
    const [c, g] = canvas(256, 8);
    for (let x = 0; x < 256; x++) { const v = 52 + Math.sin(x / 6) * 20; g.fillStyle = `rgb(${v},${v - 6},${v - 14})`; g.fillRect(x, 0, 1, 8); }
    return c;
  })();

  const switchesC = (() => {
    // A rocker-switch bank: black rockers with little white pictograms and amber tell-tales.
    const [c, g] = canvas(512, 64);
    g.fillStyle = '#0d0e10'; g.fillRect(0, 0, 512, 64);
    const icons = ['☀', '❄', '⚠', '◐', '⛽', '⚙', '☼', '♨'];
    for (let k = 0; k < 8; k++) {
      const x = 8 + k * 63;
      g.fillStyle = '#1d1f23'; g.fillRect(x, 6, 54, 52);
      g.fillStyle = '#2a2d32'; g.fillRect(x + 3, 9, 48, 22);
      g.fillStyle = '#e8e8e8'; g.font = '20px sans-serif'; g.textAlign = 'center'; g.fillText(icons[k], x + 27, 50);
      g.fillStyle = k % 3 === 0 ? '#ffae2b' : '#30343a'; g.fillRect(x + 21, 12, 12, 4);
    }
    return c;
  })();
  const switchMap = texOf(switchesC, true, false);

  const speakerC = (() => {
    const [c, g] = canvas(128, 128);
    g.fillStyle = '#121315'; g.fillRect(0, 0, 128, 128);
    g.fillStyle = '#050506';
    for (let y = 4; y < 128; y += 7) for (let x = (y % 14 ? 4 : 7); x < 128; x += 7) { g.beginPath(); g.arc(x, y, 2, 0, 7); g.fill(); }
    return c;
  })();

  const paperC = (() => {
    const [c, g] = canvas(256, 340);
    g.fillStyle = '#f3f1ea'; g.fillRect(0, 0, 256, 340);
    g.fillStyle = '#20242c'; g.font = 'bold 18px sans-serif'; g.fillText('BILL OF LADING', 18, 34);
    g.font = '11px sans-serif';
    for (let k = 0; k < 16; k++) { g.fillStyle = k % 4 === 0 ? '#555' : '#999'; g.fillRect(18, 56 + k * 16, 80 + ((k * 53) % 140), 3); }
    g.strokeStyle = '#2050c0'; g.lineWidth = 2; g.beginPath(); g.moveTo(140, 310); g.bezierCurveTo(160, 290, 180, 330, 230, 300); g.stroke();
    return c;
  })();

  const radioC = (() => {
    const [c, g] = canvas(256, 64);
    g.fillStyle = '#05080a'; g.fillRect(0, 0, 256, 64);
    g.fillStyle = '#58c8ff'; g.font = 'bold 26px monospace'; g.fillText('CH 19', 12, 40);
    g.fillStyle = '#ffb347'; g.font = '16px monospace'; g.fillText('101.7 FM', 140, 38);
    return c;
  })();

  const std = (p: THREE.MeshStandardMaterialParameters) => {
    const m = new THREE.MeshStandardMaterial(p);
    // Bounced daylight: each surface glows faintly with its own colour (driven by setCabAmbient).
    if (!p.emissive) { m.emissive.set(0xffffff); m.emissiveMap = m.map ?? null; if (!m.map) m.emissive.copy(m.color); m.emissiveIntensity = 0.2; }
    else m.userData.lit = true;
    all.add(m);
    return m;
  };
  mats = {
    wall: std({ map: wallMap, normalMap: grain, normalScale: new THREE.Vector2(0.3, 0.3), roughness: 0.85, side: THREE.BackSide }),
    dashTop: std({ color: 0x1c1d20, normalMap: grain, normalScale: new THREE.Vector2(0.5, 0.5), roughness: 0.8, side: THREE.DoubleSide }),
    dash: std({ color: 0x34363b, normalMap: grain, normalScale: new THREE.Vector2(0.4, 0.4), roughness: 0.62, side: THREE.DoubleSide }),
    trim: std({ color: 0x2a2b2f, normalMap: grain, normalScale: new THREE.Vector2(0.4, 0.4), roughness: 0.6 }),
    light: std({ color: 0x8c877e, normalMap: grain, normalScale: new THREE.Vector2(0.3, 0.3), roughness: 0.85 }),
    leather: std({ color: 0x17171a, normalMap: leatherN, normalScale: new THREE.Vector2(0.6, 0.6), roughness: 0.45 }),
    seat: std({ map: seatMap, normalMap: seatN, normalScale: new THREE.Vector2(0.8, 0.8), roughness: 0.9 }),
    floor: std({ color: 0x1b1c1e, normalMap: rep(floorN, 6, 6), roughness: 0.92 }),
    carpet: std({ color: 0x3a3a3c, normalMap: grain, roughness: 1 }),
    quilt: std({ map: rep(texOf(quiltC), 2, 2), roughness: 0.95 }),
    sheet: std({ color: 0xcfcac0, roughness: 0.95 }),
    curtain: std({ map: rep(texOf(curtainC), 3, 1), roughness: 0.95, side: THREE.DoubleSide }),
    wood: std({ color: 0x5b3a22, roughness: 0.4, metalness: 0.05 }),
    alu: std({ color: 0xb8bcc2, metalness: 0.9, roughness: 0.32 }),
    black: std({ color: 0x0e0f11, roughness: 0.45 }),
    switches: std({ map: switchMap, roughness: 0.5 }),
    speaker: std({ map: rep(texOf(speakerC), 1, 1), roughness: 0.8 }),
    paper: std({ map: texOf(paperC, true, false), roughness: 0.9 }),
    yellow: std({ color: 0xf2c200, roughness: 0.35 }),
    red: std({ color: 0xc8161d, roughness: 0.35 }),
    green: std({ color: 0x2f7d3a, roughness: 0.7 }),
    cup: std({ color: 0xf2efe8, roughness: 0.6 }),
    radio: std({ map: texOf(radioC, true, false), emissive: 0xffffff, emissiveMap: texOf(radioC, true, false), emissiveIntensity: 0.9, roughness: 0.3 }),
  };
  return mats;
}

// ------------------------------------------------------------------ geometry helpers

function rbox(w: number, h: number, d: number, r: number, mat: THREE.Material, parent: THREE.Object3D, x: number, y: number, z: number) {
  const m = new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 2, Math.min(r, w / 2.05, h / 2.05, d / 2.05)), mat);
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}

const rb2 = (w: number, h: number, d: number, r: number, mat: THREE.Material, parent: THREE.Object3D, x: number, y: number, z: number) => rbox(w, h, d, r, mat, parent, x, y, z);
function disc2(r: number, h: number, mat: THREE.Material, parent: THREE.Object3D, x: number, y: number, z: number) {
  const m = cyl(r, r, h, mat, 18);
  m.rotation.x = Math.PI / 2;
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}

/** Extrudes a side profile (z, y pairs) across x, with rounded edges: seat backs, cushions, bunks. */
function profileSolid(pts: [number, number][], width: number, bevel: number, mat: THREE.Material) {
  const s = new THREE.Shape();
  pts.forEach(([z, y], i) => (i ? s.lineTo(z, y) : s.moveTo(z, y)));
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: width - bevel * 2, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 3, curveSegments: 6 });
  g.translate(0, 0, -(width - bevel * 2) / 2);
  // Shape x is the solid's z, extrusion depth runs along x.
  g.rotateY(-Math.PI / 2);
  const m = new THREE.Mesh(g, mat);
  return m;
}

function smoothPts(pts: [number, number][], n = 8): [number, number][] {
  const curve = new THREE.CatmullRomCurve3(pts.map(([a, b]) => new THREE.Vector3(a, b, 0)), true, 'centripetal');
  return curve.getPoints(pts.length * n).map((p) => [p.x, p.y] as [number, number]);
}

// ------------------------------------------------------------------ the interior

export function buildInterior(shape: CabShape, shellGeo: THREE.BufferGeometry, opts: { floor: number }): InteriorBuild {
  const M = interiorMats(shape);
  const group = new THREE.Group();
  const spec = shape.spec;
  const yW = shape.yAt(shape.win.t0);
  const yTopWin = shape.yAt(shape.win.t1);
  const roof = spec.y0 + spec.H;
  const floor = opts.floor;
  const halfW = shape.halfW(shape.win.t0) - 0.05;
  const zBack = spec.zBack + 0.06;
  const glassZ = (x: number, y: number) => shape.frontZ(x, y) - 0.05;
  const zW0 = glassZ(0, yW);
  const DRIVER = 0.6;
  const depthAt = (x: number) => {
    const base = 0.6 - 0.04 * Math.max(0, -x) / halfW;
    return base * (1 - 0.45 * THREE.MathUtils.smoothstep(Math.abs(x), halfW * 0.78, halfW));
  };
  const lip = zW0 - depthAt(DRIVER);
  const eye = new THREE.Vector3(DRIVER, yW + 0.44, lip - 0.74);
  const cushionY = eye.y - 0.8;
  const seatZ = eye.z + 0.06;

  // --- walls, pillars and headliner: the shell seen from the inside, pulled in a little
  {
    const g = shellGeo.clone();
    const p = g.attributes.position, n = g.attributes.normal;
    for (let i = 0; i < p.count; i++) p.setXYZ(i, p.getX(i) - n.getX(i) * 0.035, p.getY(i) - n.getY(i) * 0.035, p.getZ(i) - n.getZ(i) * 0.035);
    g.computeVertexNormals();
    group.add(new THREE.Mesh(g, M.wall));
  }

  // --- floor: rubber mat in the cab, carpet in the sleeper
  {
    const ring = shape.ring(shape.tAt(floor + 0.02));
    const s = new THREE.Shape();
    ring.slice(0, -1).forEach((p, i) => { const x = p.x * 0.97, z = p.z; if (i) s.lineTo(x, z); else s.moveTo(x, z); });
    const g = new THREE.ShapeGeometry(s, 4);
    const pa = g.attributes.position;
    for (let i = 0; i < pa.count; i++) { const x = pa.getX(i), z = pa.getY(i); pa.setXYZ(i, x, floor, z); }
    g.computeVertexNormals();
    if (g.attributes.normal.getY(0) < 0) { const ix = g.index!; for (let k = 0; k < ix.count; k += 3) { const a = ix.getX(k + 1); ix.setX(k + 1, ix.getX(k + 2)); ix.setX(k + 2, a); } g.computeVertexNormals(); }
    const uv = g.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, pa.getX(i) / 2, pa.getZ(i) / 2);
    group.add(new THREE.Mesh(g, M.floor));
    // Engine tunnel hump between the seats.
    const hump = rbox(0.56, 0.16, Math.max(0.3, lip - 0.15 - (seatZ - 0.1)), 0.07, M.floor, group, 0, floor + 0.07, (lip - 0.15 + seatZ - 0.1) / 2);
    void hump;
  }

  // --- dashboard: one sculpted moulding lofted across the cab, following the windscreen's foot
  {
    const N = 56;
    const profile = (x: number): [number, number][] => {
      const D = depthAt(x);
      // A dip in front of the driver so the instrument binnacle sits low under the screen line.
      const dip = 0.16 * THREE.MathUtils.smoothstep(1 - Math.abs(x - DRIVER) / 0.5, 0, 0.45);
      const low = Math.max(-0.66, floor - yW + 0.55);
      return [
        [0, -0.015], [-0.2, -0.005], [-(D - 0.12), 0.02 - dip * 0.6], [-(D - 0.04), 0.012 - dip], [-D, -0.035 - dip],
        [-(D - 0.015), -0.12 - dip], [-(D - 0.09), -0.36], [-(D - 0.2), low],
      ];
    };
    const P = profile(0).length;
    const pos: number[] = [], uv: number[] = [];
    const lipPts: THREE.Vector3[] = [];
    for (let i = 0; i <= N; i++) {
      const x = -halfW + (2 * halfW * i) / N;
      const z0 = glassZ(x, yW);
      profile(x).forEach(([dz, dy], j) => {
        pos.push(x, yW + dy, z0 + dz);
        uv.push(x * 2, j / (P - 1));
        if (j === 4) lipPts.push(new THREE.Vector3(x, yW + dy + 0.012, z0 + dz - 0.006));
      });
    }
    const top: number[] = [], face: number[] = [];
    for (let i = 0; i < N; i++) for (let j = 0; j < P - 1; j++) {
      const a = i * P + j, b = a + P;
      (j < 4 ? top : face).push(a, b, a + 1, b, b + 1, a + 1);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex([...top, ...face]);
    g.addGroup(0, top.length, 0);
    g.addGroup(top.length, face.length, 1);
    g.computeVertexNormals();
    group.add(new THREE.Mesh(g, [M.dashTop, M.dash]));
    // Brushed trim strip along the lip.
    group.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(lipPts), 80, 0.007, 5), M.alu));
    // Demister vents at the windscreen's foot.
    for (let k = -5; k <= 5; k++) {
      const x = k * 0.2;
      const v = rbox(0.14, 0.008, 0.04, 0.003, M.black, group, x, yW - 0.005, glassZ(x, yW) - 0.1);
      v.rotation.x = 0.05;
    }
  }

  // --- instrument panel under a hooded binnacle (see cockpit.ts; the rig drives the needles)
  const clusterZ = lip + 0.1, clusterY = yW - 0.015;
  const clusterPanel = facePanel(group, new THREE.Vector3(DRIVER, clusterY, clusterZ), 0, 0.38);
  const cockpit = buildCluster(clusterPanel);
  const dashScreen = cockpit.lcd;
  {
    const hood = new THREE.Mesh(new THREE.CylinderGeometry(0.56, 0.56, 0.26, 40, 1, true, -Math.PI * 0.3, Math.PI * 0.6), M.dashTop);
    hood.rotation.x = Math.PI / 2 - 0.25;
    hood.scale.set(1, 1, 0.34);
    hood.position.set(DRIVER, clusterY - 0.03, clusterZ - 0.04);
    group.add(hood);
  }
  // Below the panel: the ignition key and a vent on the dash face.
  {
    const x = DRIVER - 0.3;
    const face = facePanel(group, new THREE.Vector3(x, yW - 0.24, glassZ(x, yW) - depthAt(x) + 0.0), 0, 0.15);
    ignition(face, 0, 0);
    vent(face, 0.1, 0.02, 0.04);
  }
  // Left wing by the door: lighting switches, the headlamp knob and a vent.
  {
    const x = Math.min(DRIVER + 0.38, halfW - 0.16);
    const face = facePanel(group, new THREE.Vector3(x, yW - 0.3, glassZ(x, yW) - depthAt(x) - 0.03), 0.3, 0.12);
    rockerBank(face, ['HEAD', 'FOG', 'MARKER', 'BEACON', 'MIRROR\nHEAT', 'DIM'], [true, false, true, false, true, false], 0, -0.03, 3);
    knob(face, -0.08, 0.07, 0.022, 0.8);
    vent(face, 0.05, 0.075, 0.04);
  }
  // Passenger-side vents.
  for (const x of [-DRIVER, -halfW + 0.12]) {
    const face = facePanel(group, new THREE.Vector3(x, yW - 0.12, glassZ(x, yW) - depthAt(x) + 0.0), x < -0.8 ? -0.45 : 0, 0.1);
    vent(face, 0, 0, 0.042);
  }

  // --- steering wheel: a big flat truck wheel on a tilting column
  const steeringWheel = new THREE.Group();
  steeringWheel.position.set(DRIVER, yW + 0.03, lip - 0.24);
  steeringWheel.rotation.x = -0.72;
  group.add(steeringWheel);
  {
    const wheelInner = new THREE.Group();
    steeringWheel.add(wheelInner);
    buildWheel(wheelInner, M.leather);
    // Column shroud, the turn-signal stalk on the left and the gear/engine-brake stalk on the right.
    const col = cyl(0.055, 0.07, 0.32, M.trim, 18);
    col.rotation.x = Math.PI / 2;
    col.position.set(0, 0, -0.18);
    steeringWheel.add(col);
    for (const s of [1, -1]) {
      const st = cyl(0.007, 0.005, 0.17, M.black, 8);
      st.rotation.z = s * Math.PI / 2 + s * 0.15;
      st.position.set(s * 0.11, 0.02, -0.11);
      steeringWheel.add(st);
      const tip = cyl(0.011, 0.011, 0.045, M.black, 12);
      tip.rotation.z = s * Math.PI / 2 + s * 0.15;
      tip.position.set(s * 0.2, 0.034, -0.11);
      steeringWheel.add(tip);
      const band = cyl(0.0115, 0.0115, 0.006, s > 0 ? M.alu : cockpitMats().ledOn, 12);
      band.rotation.z = s * Math.PI / 2 + s * 0.15;
      band.position.set(s * 0.185, 0.032, -0.11);
      steeringWheel.add(band);
    }
  }

  // --- centre stack: radio, heater, a rocker bank, the US-style air brake knobs, power sockets
  {
    const stack = facePanel(group, new THREE.Vector3(0.02, yW - 0.3, glassZ(0.02, yW) - depthAt(0.02) - 0.03), -0.3, 0.06);
    rb2(0.46, 0.62, 0.3, 0.04, M.dash, stack, 0, 0, -0.16);
    const C = cockpitMats();
    // Radio head unit with a lit display, presets and two knobs.
    rb2(0.38, 0.1, 0.02, 0.008, C.black, stack, 0, 0.22, 0.0);
    const disp = new THREE.Mesh(new THREE.PlaneGeometry(0.18, 0.042), M.radio);
    disp.position.set(-0.02, 0.235, 0.011);
    stack.add(disp);
    for (let k = 0; k < 6; k++) rb2(0.024, 0.014, 0.008, 0.003, C.rocker, stack, -0.085 + k * 0.026, 0.192, 0.012);
    knob(stack, -0.155, 0.22, 0.016, 0.4);
    knob(stack, 0.15, 0.22, 0.016, -1.0);
    // Heater: fan, temperature and mode knobs.
    rb2(0.38, 0.09, 0.012, 0.006, C.panel, stack, 0, 0.1, -0.002);
    knob(stack, -0.12, 0.1, 0.026, -0.6);
    knob(stack, 0, 0.1, 0.026, 0.3);
    knob(stack, 0.12, 0.1, 0.026, 1.2);
    for (const [x, l] of [[-0.12, 'FAN'], [0, 'TEMP'], [0.12, 'VENT']] as const) {
      const lp = legendPlaneOf(l, 0.05, 0.016);
      lp.position.set(x, 0.062, 0.006);
      stack.add(lp);
    }
    rockerBank(stack, ['A/C', 'DIFF\nLOCK', 'ENGINE\nBRAKE', 'HI / LO', 'FIFTH\nWHEEL', 'HAZARD', 'WORK\nLIGHT', 'AXLE\nLIFT'], [true, false, true, false, false, false, false, false], 0, -0.02, 4);
    // Parking brake (yellow diamond) and trailer air supply (red octagon), with their plates.
    rb2(0.3, 0.1, 0.01, 0.006, C.panel, stack, 0, -0.165, 0.0);
    brakeKnob(stack, 0.07, -0.16, 'park');
    brakeKnob(stack, -0.07, -0.16, 'trailer');
    // 12 V socket and USB ports, and a coffee in the holder.
    disc2(0.012, 0.01, C.chrome, stack, 0.09, -0.25, 0.004);
    disc2(0.008, 0.012, C.black, stack, 0.09, -0.25, 0.006);
    for (const x of [0.13, 0.155]) rb2(0.014, 0.007, 0.006, 0.002, C.black, stack, x, -0.25, 0.004);
    const cupB = cyl(0.04, 0.035, 0.11, M.cup, 20); cupB.position.set(-0.13, -0.24, 0.05); stack.add(cupB);
    const lid = cyl(0.042, 0.042, 0.015, M.black, 20); lid.position.set(-0.13, -0.18, 0.05); stack.add(lid);
    const sleeve = cyl(0.041, 0.038, 0.045, new THREE.MeshStandardMaterial({ color: 0x7a5232, roughness: 0.9 }), 20); sleeve.position.set(-0.13, -0.24, 0.05); stack.add(sleeve);
    all.add(sleeve.material as THREE.Material);
  }

  // --- glovebox and a satnav on a suction mount
  rbox(0.55, 0.22, 0.03, 0.02, M.dash, group, -0.62, yW - 0.24, glassZ(-0.62, yW) - depthAt(-0.62) + 0.06).rotation.x = -0.25;
  rbox(0.16, 0.025, 0.02, 0.008, M.alu, group, -0.62, yW - 0.15, glassZ(-0.62, yW) - depthAt(-0.62) + 0.035);
  const gpsZ = glassZ(0.08, yW) - 0.32;
  const gpsBody = rbox(0.2, 0.13, 0.025, 0.012, M.black, group, 0.08, yW + 0.1, gpsZ);
  gpsBody.rotation.order = 'YXZ';
  gpsBody.rotation.set(-0.25, -0.3, 0);
  const arm = cyl(0.008, 0.008, 0.12, M.black, 6);
  arm.position.set(0.1, yW + 0.03, gpsZ + 0.05);
  arm.rotation.x = 0.6;
  group.add(arm);
  const gpsScreen = new THREE.Mesh(new THREE.PlaneGeometry(0.17, 0.1), new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }));
  gpsScreen.position.set(0.08 + Math.sin(0.3) * 0.014, yW + 0.1, gpsZ - Math.cos(0.3) * 0.014);
  gpsScreen.rotation.order = 'YXZ';
  gpsScreen.rotation.set(-0.25, Math.PI - 0.3, 0);
  group.add(gpsScreen);
  // Sunglasses on the dash and a clipboard of paperwork on the passenger seat.
  {
    const gl = new THREE.Group();
    gl.position.set(-0.35, yW + 0.012, glassZ(-0.35, yW) - 0.3);
    gl.rotation.y = 0.4;
    group.add(gl);
    for (const s of [-1, 1]) { const l = cyl(0.026, 0.026, 0.004, M.black, 14); l.position.set(s * 0.035, 0, 0); gl.add(l); }
    rbox(0.13, 0.004, 0.004, 0.001, M.alu, gl, 0, 0.002, -0.025);
  }

  // --- seats: air-ride pedestal, sculpted cushion and back with leather bolsters, armrests
  for (const side of [1, -1]) {
    const x = side * DRIVER;
    const seat = new THREE.Group();
    seat.position.set(x, cushionY, seatZ);
    group.add(seat);
    const pedestal = cushionY - floor - 0.1;
    rbox(0.42, 0.06, 0.42, 0.02, MAT.frame, seat, 0, -pedestal + 0.03 - 0.07, 0);
    const bellows = cyl(0.11, 0.12, pedestal - 0.1, MAT.rubber, 16);
    bellows.position.set(0, -pedestal / 2 - 0.05, 0);
    seat.add(bellows);
    rbox(0.46, 0.05, 0.46, 0.02, MAT.frame, seat, 0, -0.08, 0);
    // Cushion: fabric centre between raised leather bolsters, with a rolled front edge.
    const cush = profileSolid(smoothPts([[0.26, -0.06], [0.28, 0.02], [0.2, 0.06], [-0.24, 0.05], [-0.26, -0.05]], 6), 0.36, 0.03, M.seat);
    seat.add(cush);
    for (const s of [-1, 1]) {
      const bol = profileSolid(smoothPts([[0.25, -0.06], [0.26, 0.05], [0.12, 0.1], [-0.24, 0.08], [-0.25, -0.05]], 6), 0.09, 0.025, M.leather);
      bol.position.x = s * 0.22;
      seat.add(bol);
    }
    // Back: a lumbar-curved shell leaning back about 15 degrees, bolstered, with a headrest.
    const back = new THREE.Group();
    back.position.set(0, 0.04, -0.24);
    back.rotation.x = -0.24;
    seat.add(back);
    const bp: [number, number][] = [[0.0, 0.0], [0.07, 0.18], [0.05, 0.4], [0.03, 0.66], [-0.09, 0.68], [-0.1, 0.0]];
    back.add(profileSolid(smoothPts(bp, 6), 0.4, 0.03, M.seat));
    for (const s of [-1, 1]) {
      const bol = profileSolid(smoothPts([[0.03, 0.02], [0.12, 0.2], [0.1, 0.45], [0.05, 0.62], [-0.1, 0.64], [-0.1, 0.0]], 6), 0.1, 0.03, M.leather);
      bol.position.x = s * 0.23;
      back.add(bol);
    }
    const head = rbox(0.3, 0.2, 0.11, 0.05, M.leather, back, 0, 0.82, -0.02);
    void head;
    for (const s of [-0.08, 0.08]) { const post = cyl(0.007, 0.007, 0.12, M.alu, 6); post.position.set(s, 0.7, -0.02); back.add(post); }
    // Fold-down armrest on the inboard side.
    rbox(0.07, 0.07, 0.34, 0.03, M.leather, seat, -side * 0.3, 0.2, 0.0);
    // Seat belt from the B-pillar.
    const belt = rbox(0.05, 0.72, 0.008, 0.002, MAT.rubber, seat, side * 0.18, 0.36, -0.15);
    belt.rotation.z = side * 0.5;
    belt.rotation.x = -0.24;
  }
  // Clipboard on the passenger seat.
  {
    const cb = new THREE.Group();
    cb.position.set(-DRIVER + 0.02, cushionY + 0.125, seatZ + 0.06);
    cb.rotation.set(-Math.PI / 2 + 0.05, 0, 0.5);
    group.add(cb);
    const board = new THREE.Mesh(new THREE.BoxGeometry(0.23, 0.31, 0.006), new THREE.MeshStandardMaterial({ color: 0x6b4a2b, roughness: 0.8 }));
    all.add(board.material as THREE.Material);
    cb.add(board);
    const sheet = new THREE.Mesh(new THREE.PlaneGeometry(0.21, 0.28), M.paper);
    sheet.position.z = 0.004;
    cb.add(sheet);
    rbox(0.08, 0.02, 0.012, 0.004, M.alu, cb, 0, 0.14, 0.006);
  }

  // --- pedals
  {
    const acc = rbox(0.09, 0.26, 0.025, 0.01, MAT.rubber, group, DRIVER + 0.12, floor + 0.12, lip - 0.08);
    acc.rotation.x = -0.9;
    const brake = rbox(0.13, 0.09, 0.025, 0.01, MAT.rubber, group, DRIVER - 0.08, floor + 0.2, lip - 0.12);
    brake.rotation.x = -0.4;
    const arm2 = cyl(0.012, 0.012, 0.32, MAT.frame, 6);
    arm2.position.set(DRIVER - 0.08, floor + 0.36, lip - 0.06);
    arm2.rotation.x = 0.4;
    group.add(arm2);
  }

  // --- doors: moulded trim with armrest, pull handle, window switches, speaker and map pocket
  for (const side of [1, -1]) {
    const x = side * (halfW + 0.005);
    const zF = glassZ(side * halfW, yW) - 0.18, zB = shape.doorBack + 0.06;
    const len = zF - zB, zc = (zF + zB) / 2;
    if (len < 0.3) continue;
    const ph = yW - 0.03 - (floor + 0.05);
    rbox(0.06, ph, len, 0.025, M.trim, group, x, floor + 0.05 + ph / 2, zc);
    rbox(0.05, 0.12, len * 0.7, 0.02, M.light, group, x - side * 0.03, yW - 0.13, zc + 0.02);
    rbox(0.1, 0.06, len * 0.45, 0.025, M.leather, group, x - side * 0.07, yW - 0.27, zc - len * 0.05);
    rbox(0.03, 0.03, 0.18, 0.012, M.alu, group, x - side * 0.06, yW - 0.18, zc + len * 0.18);
    for (let k = 0; k < 2; k++) rbox(0.03, 0.012, 0.045, 0.004, M.black, group, x - side * 0.1, yW - 0.235, zc - len * 0.2 + k * 0.06);
    const spk = new THREE.Mesh(new THREE.CircleGeometry(0.085, 24), M.speaker);
    spk.position.set(x - side * 0.035, floor + 0.32, zc + len * 0.25);
    spk.rotation.y = -side * Math.PI / 2;
    group.add(spk);
    rbox(0.05, 0.16, len * 0.5, 0.02, M.dash, group, x - side * 0.04, floor + 0.2, zc - len * 0.12);
    // Grab handle on the A-pillar.
    const gh = cyl(0.014, 0.014, 0.42, M.black, 8);
    gh.position.set(side * (halfW - 0.07), (yW + yTopWin) / 2, glassZ(side * (halfW - 0.1), (yW + yTopWin) / 2) - 0.12);
    gh.rotation.x = shape.frontTilt((yW + yTopWin) / 2);
    group.add(gh);
  }

  // --- overhead console with CB radio and clock, sun visors and an air freshener
  {
    const cy = Math.min(yTopWin + 0.07, roof - 0.17);
    const front = shape.frontZ(0, cy - 0.11) - 0.09;
    const depth = 0.42;
    rbox(2 * halfW - 0.18, 0.2, depth, 0.05, M.light, group, 0, cy, front - depth / 2);
    for (const x of [-0.65, 0.65]) rbox(0.62, 0.15, 0.02, 0.02, M.trim, group, x, cy - 0.005, front - depth - 0.002);
    rbox(0.32, 0.08, 0.03, 0.01, M.black, group, 0, cy - 0.04, front - depth - 0.01);
    const cb = new THREE.Mesh(new THREE.PlaneGeometry(0.12, 0.03), M.radio);
    cb.position.set(-0.05, cy - 0.04, front - depth - 0.027);
    cb.rotation.y = Math.PI;
    group.add(cb);
    for (const x of [0.08, 0.12]) { const k = cyl(0.01, 0.01, 0.02, M.alu, 10); k.rotation.x = Math.PI / 2; k.position.set(x, cy - 0.04, front - depth - 0.03); group.add(k); }
    // CB handset on its hook, with a coiled cord.
    rbox(0.04, 0.08, 0.03, 0.012, M.black, group, -0.42, cy - 0.06, front - depth - 0.03);
    const coil: THREE.Vector3[] = [];
    for (let t = 0; t <= 1; t += 0.005) coil.push(new THREE.Vector3(-0.42 + Math.cos(t * 80) * 0.012, cy - 0.1 - t * 0.12 + Math.sin(t * Math.PI) * -0.05, front - depth - 0.03 + Math.sin(t * 80) * 0.012));
    group.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(coil), 240, 0.003, 4), M.black));
    // Sun visors flipped up against the header.
    for (const x of [DRIVER, -DRIVER]) {
      const v = rbox(0.62, 0.025, 0.26, 0.012, M.light, group, x, cy - 0.12, shape.frontZ(x, cy - 0.12) - 0.2);
      v.rotation.x = 0.22;
    }
    // Pine-tree air freshener on a string.
    const strY = cy - 0.1;
    const str = cyl(0.0015, 0.0015, 0.16, M.black, 4);
    str.position.set(0.18, strY - 0.08, front - depth + 0.02);
    group.add(str);
    const tree = new THREE.Shape();
    tree.moveTo(0, 0.09); tree.lineTo(0.03, 0.05); tree.lineTo(0.015, 0.05); tree.lineTo(0.04, 0.0); tree.lineTo(0.02, 0.0); tree.lineTo(0.05, -0.05); tree.lineTo(0.008, -0.05); tree.lineTo(0.008, -0.07); tree.lineTo(-0.008, -0.07); tree.lineTo(-0.008, -0.05); tree.lineTo(-0.05, -0.05); tree.lineTo(-0.02, 0.0); tree.lineTo(-0.04, 0.0); tree.lineTo(-0.015, 0.05); tree.lineTo(-0.03, 0.05); tree.closePath();
    const tm = new THREE.Mesh(new THREE.ShapeGeometry(tree), M.green);
    (M.green as THREE.MeshStandardMaterial).side = THREE.DoubleSide;
    tm.position.set(0.18, strY - 0.25, front - depth + 0.02);
    tm.rotation.y = 0.6;
    group.add(tm);
  }

  // --- sleeper: a made-up bunk, curtain, cabinets and a fridge
  {
    const seatBack = seatZ - 0.42;
    const bunkD = Math.max(0.5, Math.min(0.85, seatBack - zBack));
    const bz = zBack + bunkD / 2;
    const by = floor + 0.46;
    const bw = 2 * halfW - 0.1;
    rbox(bw, 0.4, bunkD, 0.03, M.trim, group, 0, floor + 0.2, bz);
    rbox(0.4, 0.3, 0.02, 0.02, M.light, group, -0.5, floor + 0.2, bz + bunkD / 2 + 0.005);
    rbox(0.18, 0.025, 0.02, 0.008, M.alu, group, -0.5, floor + 0.3, bz + bunkD / 2 + 0.02);
    rbox(bw, 0.16, bunkD - 0.04, 0.06, M.sheet, group, 0, by + 0.08, bz);
    rbox(bw * 0.62, 0.05, bunkD - 0.02, 0.025, M.quilt, group, bw * 0.17, by + 0.18, bz + 0.01);
    rbox(0.5, 0.11, 0.32, 0.05, M.sheet, group, -bw / 2 + 0.32, by + 0.21, bz);
    // Cabinets across the back wall above the bunk.
    const cabY = Math.min(roof - 0.35, by + 0.95);
    rbox(bw, 0.36, 0.34, 0.03, M.light, group, 0, cabY, zBack + 0.17);
    for (const x of [-0.6, 0, 0.6]) {
      rbox(0.56, 0.3, 0.02, 0.02, M.trim, group, x, cabY, zBack + 0.345);
      rbox(0.14, 0.02, 0.02, 0.006, M.alu, group, x, cabY - 0.11, zBack + 0.36);
    }
    // Reading lights.
    for (const x of [-0.8, 0.8]) { const l = cyl(0.03, 0.03, 0.01, new THREE.MeshStandardMaterial({ color: 0xffe9c4, emissive: 0xffe9c4, emissiveIntensity: 0.6 }), 12); l.position.set(x, cabY - 0.185, zBack + 0.25); group.add(l); }
    // The privacy curtain, mostly drawn back to the passenger side.
    const ch = roof - 0.1 - by;
    const curtain = new THREE.Mesh(new THREE.PlaneGeometry(0.32, ch, 10, 1), M.curtain);
    const cp = curtain.geometry.attributes.position;
    for (let i = 0; i < cp.count; i++) cp.setZ(i, Math.sin(cp.getX(i) * 60) * 0.025);
    curtain.geometry.computeVertexNormals();
    curtain.position.set(-halfW + 0.18, by + ch / 2, bz + bunkD / 2 + 0.03);
    group.add(curtain);
    const rail = cyl(0.008, 0.008, bw, M.alu, 6);
    rail.rotation.z = Math.PI / 2;
    rail.position.set(0, roof - 0.12, bz + bunkD / 2 + 0.03);
    group.add(rail);
  }

  group.traverse((o) => { if (o instanceof THREE.Mesh) { o.castShadow = false; o.receiveShadow = true; } });
  return { group, steeringWheel, dashScreen, gpsScreen, eye, cockpit };
}
