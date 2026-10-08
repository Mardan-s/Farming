import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mulberry32 } from '../util';

// The driver's controls in real 3D: an American-style gauge panel (each dial in its own chrome
// bezel and cup, behind glass, with a live needle), banks of rocker switches with printed labels
// and pilot LEDs, ridged rotary knobs, eyeball vents, the ignition key and a four-spoke wheel.
//
// Everything is built in "panel space": a group whose +z faces the driver, +x is the driver's
// right and +y is up. facePanel() makes one.

export type GaugeId = 'tach' | 'speedo' | 'water' | 'oil' | 'volts' | 'trans' | 'air1' | 'air2' | 'fuel' | 'def';
export interface Gauge { needle: THREE.Object3D; a0: number; a1: number }
export interface Cockpit {
  gauges: Record<GaugeId, Gauge>;
  lcd: THREE.Mesh;
  telltales: THREE.Mesh;
}

// ------------------------------------------------------------------ shared materials and textures

const canvas = (w: number, h: number) => {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return [c, c.getContext('2d')!] as const;
};
const tex = (c: HTMLCanvasElement) => {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
};

let shared: ReturnType<typeof makeShared> | null = null;
/** Every material made here, so the cab knows these parts are interior-only. */
const owned = new Set<THREE.Material>();
export function isCockpitMaterial(m: THREE.Material) { return owned.has(m); }
const own = <T extends THREE.Material>(m: T) => { owned.add(m); return m; };
/** Backlit materials (dial faces, switch legends): their glow follows the panel lights. */
const backlit: THREE.MeshStandardMaterial[] = [];

function makeShared() {
  const std = (p: THREE.MeshStandardMaterialParameters) => own(new THREE.MeshStandardMaterial(p));
  // Fine pebble grain for the panel plastics.
  const [gc, gg] = canvas(128, 128);
  const rnd = mulberry32(9);
  gg.fillStyle = '#808080'; gg.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 2600; i++) { const v = 100 + rnd() * 70; gg.fillStyle = `rgb(${v},${v},${v})`; gg.beginPath(); gg.arc(rnd() * 128, rnd() * 128, 0.6 + rnd() * 1.2, 0, 7); gg.fill(); }
  const grainN = new THREE.CanvasTexture(gc);
  grainN.wrapS = grainN.wrapT = THREE.RepeatWrapping;
  grainN.repeat.set(6, 6);
  return {
    panel: std({ color: 0x1a1b1e, roughness: 0.72, bumpMap: grainN, bumpScale: 0.6 }),
    panelLight: std({ color: 0x3a3c41, roughness: 0.6, bumpMap: grainN, bumpScale: 0.5 }),
    cup: std({ color: 0x070809, roughness: 0.5, side: THREE.DoubleSide }),
    chrome: std({ color: 0xf2f4f7, metalness: 1, roughness: 0.12 }),
    satin: std({ color: 0xa9aeb5, metalness: 0.95, roughness: 0.3 }),
    black: std({ color: 0x0c0d0f, roughness: 0.45 }),
    rocker: std({ color: 0x121316, roughness: 0.35 }),
    knob: std({ color: 0x151619, roughness: 0.42 }),
    needle: std({ color: 0xff4a12, emissive: 0xff3a0a, emissiveIntensity: 0.9, roughness: 0.4 }),
    white: std({ color: 0xe9ebee, roughness: 0.4 }),
    glass: own(new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 0, roughness: 0.04, transparent: true, opacity: 0.05, envMapIntensity: 0.7, depthWrite: false })),
    ledOn: std({ color: 0x40200a, emissive: 0xffa21a, emissiveIntensity: 2.4 }),
    ledGreen: std({ color: 0x0b3010, emissive: 0x3cff6a, emissiveIntensity: 1.8 }),
    ledOff: std({ color: 0x1c1a17, roughness: 0.4 }),
    yellow: std({ color: 0xf2c200, roughness: 0.32 }),
    red: std({ color: 0xc8161d, roughness: 0.32 }),
  };
}
export function cockpitMats() { return (shared ??= makeShared()); }

/** Panel and switch-legend backlight (0 by day, 1 at night). */
export function setPanelLights(night: number) {
  for (const m of backlit) m.emissiveIntensity = 0.12 + night * 0.85;
}

const dialCache = new Map<string, THREE.MeshStandardMaterial>();

interface DialSpec { min: number; max: number; major: number; minor: number; label: string; sub?: string; red?: [number, number]; fmt?: (v: number) => string; sweep: [number, number]; inner?: { max: number; major: number } }

/** A dial face: black, white graduations and numerals, a red band and the legend. */
function dialMaterial(id: string, d: DialSpec) {
  const cached = dialCache.get(id);
  if (cached) return cached;
  const S = id === 'tach' || id === 'speedo' ? 512 : 256;
  const [c, g] = canvas(S, S);
  const cx = S / 2, R = S * 0.47;
  const face = g.createRadialGradient(cx, cx * 0.8, S * 0.05, cx, cx, R);
  face.addColorStop(0, '#1a1d22'); face.addColorStop(1, '#060708');
  g.fillStyle = face; g.beginPath(); g.arc(cx, cx, R + 6, 0, Math.PI * 2); g.fill();
  const [a0, a1] = d.sweep;
  const ang = (v: number) => a0 + ((a1 - a0) * (v - d.min)) / (d.max - d.min);
  if (d.red) { g.strokeStyle = '#d8141b'; g.lineWidth = S * 0.035; g.beginPath(); g.arc(cx, cx, R * 0.86, ang(d.red[0]), ang(d.red[1])); g.stroke(); }
  for (let v = d.min; v <= d.max + 1e-6; v += d.minor) {
    const a = ang(v);
    const big = Math.abs((v - d.min) / d.major - Math.round((v - d.min) / d.major)) < 1e-6;
    g.strokeStyle = big ? '#f4f6f8' : '#b6bcc4'; g.lineWidth = big ? S * 0.016 : S * 0.007;
    const r0 = R * (big ? 0.78 : 0.84);
    g.beginPath(); g.moveTo(cx + Math.cos(a) * r0, cx + Math.sin(a) * r0); g.lineTo(cx + Math.cos(a) * R * 0.93, cx + Math.sin(a) * R * 0.93); g.stroke();
    if (big) {
      g.fillStyle = '#f4f6f8'; g.font = `700 ${Math.round(S * (S > 300 ? 0.085 : 0.12))}px "Barlow", "Helvetica Neue", Arial, sans-serif`;
      g.textAlign = 'center'; g.textBaseline = 'middle';
      const rr = R * (S > 300 ? 0.62 : 0.56);
      g.fillText(d.fmt ? d.fmt(v) : String(v), cx + Math.cos(a) * rr, cx + Math.sin(a) * rr);
    }
  }
  // A second, inner scale (mph on the speedometer).
  if (d.inner) {
    g.fillStyle = '#ff9a3c'; g.font = `600 ${Math.round(S * 0.045)}px "Barlow", Arial, sans-serif`;
    for (let v = 0; v <= d.inner.max; v += d.inner.major) {
      const a = ang((v / d.inner.max) * d.max);
      g.fillText(String(v), cx + Math.cos(a) * R * 0.44, cx + Math.sin(a) * R * 0.44);
    }
  }
  g.fillStyle = '#c9d0d8'; g.font = `600 ${Math.round(S * (S > 300 ? 0.05 : 0.085))}px "Barlow", Arial, sans-serif`;
  g.textAlign = 'center';
  g.fillText(d.label, cx, cx + R * (S > 300 ? 0.36 : 0.42));
  if (d.sub) { g.fillStyle = '#7f8995'; g.font = `500 ${Math.round(S * (S > 300 ? 0.036 : 0.07))}px "Barlow", Arial, sans-serif`; g.fillText(d.sub, cx, cx + R * (S > 300 ? 0.5 : 0.62)); }
  const t = tex(c);
  const m = own(new THREE.MeshStandardMaterial({ map: t, emissive: 0xffffff, emissiveMap: t, emissiveIntensity: 0.12, roughness: 0.55 }));
  backlit.push(m);
  dialCache.set(id, m);
  return m;
}

const BIG: [number, number] = [Math.PI * 0.75, Math.PI * 2.25];
const SMALL: [number, number] = [Math.PI * 0.85, Math.PI * 2.15];
const DIALS: Record<GaugeId, DialSpec> = {
  tach: { min: 0, max: 30, major: 5, minor: 1, label: 'RPM', sub: 'x100', red: [21, 30], sweep: BIG },
  speedo: { min: 0, max: 140, major: 20, minor: 5, label: 'km/h', sub: 'mph', sweep: BIG, inner: { max: 80, major: 20 } },
  water: { min: 40, max: 120, major: 40, minor: 10, label: 'WATER', sub: '°C', red: [105, 120], sweep: SMALL },
  oil: { min: 0, max: 100, major: 50, minor: 10, label: 'OIL', sub: 'PSI', red: [0, 10], sweep: SMALL },
  volts: { min: 8, max: 18, major: 5, minor: 1, label: 'VOLTS', sweep: SMALL, red: [8, 11] },
  trans: { min: 40, max: 160, major: 60, minor: 20, label: 'TRANS', sub: '°C', red: [130, 160], sweep: SMALL },
  air1: { min: 0, max: 150, major: 50, minor: 10, label: 'PRIMARY', sub: 'AIR PSI', red: [0, 60], sweep: SMALL },
  air2: { min: 0, max: 150, major: 50, minor: 10, label: 'SECONDARY', sub: 'AIR PSI', red: [0, 60], sweep: SMALL },
  fuel: { min: 0, max: 4, major: 2, minor: 1, label: 'FUEL', red: [0, 0.5], fmt: (v) => ['E', '', '½', '', 'F'][v] ?? '', sweep: SMALL },
  def: { min: 0, max: 4, major: 2, minor: 1, label: 'DEF', fmt: (v) => ['E', '', '½', '', 'F'][v] ?? '', sweep: SMALL },
};

/** Maps a value to a needle rotation for that gauge. */
export function needleAngle(id: GaugeId, v: number) {
  const d = DIALS[id];
  const f = Math.min(1, Math.max(0, (v - d.min) / (d.max - d.min)));
  // Canvas angles run clockwise (y down); in the panel they run the other way.
  return -(d.sweep[0] + (d.sweep[1] - d.sweep[0]) * f);
}

// ------------------------------------------------------------------ switch legends

const LEGENDS = [
  'HEAD', 'FOG', 'MARKER', 'BEACON', 'MIRROR\nHEAT', 'DIM', 'WORK\nLIGHT', 'HAZARD',
  'A/C', 'DIFF\nLOCK', 'ENGINE\nBRAKE', 'HI / LO', 'FIFTH\nWHEEL', 'PTO', 'DUMP\nAIR', 'AXLE\nLIFT',
  'SET', 'RES', '+', '−', 'CANCEL', 'MODE', 'VOL', 'TALK',
  'FAN', 'TEMP', 'VENT', 'RECIRC', 'DEFROST', 'MAX', 'SEAT\nHEAT', 'USB',
];
let legendTex: THREE.CanvasTexture | null = null;
let legendMat: THREE.MeshStandardMaterial | null = null;
function legends() {
  if (legendMat) return legendMat;
  const cw = 128, ch = 64, cols = 8;
  const [c, g] = canvas(cw * cols, ch * Math.ceil(LEGENDS.length / cols));
  g.fillStyle = '#101114'; g.fillRect(0, 0, c.width, c.height);
  LEGENDS.forEach((txt, i) => {
    const x = (i % cols) * cw, y = Math.floor(i / cols) * ch;
    g.fillStyle = '#16171a'; g.fillRect(x + 2, y + 2, cw - 4, ch - 4);
    g.fillStyle = '#eef0f3'; g.textAlign = 'center'; g.textBaseline = 'middle';
    const lines = txt.split('\n');
    g.font = `700 ${lines.length > 1 ? 20 : txt.length > 3 ? 24 : 34}px "Barlow Condensed", "Arial Narrow", Arial, sans-serif`;
    lines.forEach((l, k) => g.fillText(l, x + cw / 2, y + ch / 2 + (k - (lines.length - 1) / 2) * 22));
  });
  legendTex = tex(c);
  legendMat = own(new THREE.MeshStandardMaterial({ map: legendTex, emissive: 0xffffff, emissiveMap: legendTex, emissiveIntensity: 0.12, roughness: 0.4 }));
  backlit.push(legendMat);
  return legendMat;
}
/** A small plane showing one legend from the atlas. */
export function legendPlaneOf(label: string, w: number, h: number) { return legendPlane(label, w, h); }
function legendPlane(label: string, w: number, h: number) {
  const i = Math.max(0, LEGENDS.indexOf(label));
  const cols = 8, rows = Math.ceil(LEGENDS.length / cols);
  const g = new THREE.PlaneGeometry(w, h);
  const u0 = (i % cols) / cols, v1 = 1 - Math.floor(i / cols) / rows, u1 = u0 + 1 / cols, v0 = v1 - 1 / rows;
  const uv = g.attributes.uv;
  for (let k = 0; k < uv.count; k++) uv.setXY(k, uv.getX(k) ? u1 : u0, uv.getY(k) ? v1 : v0);
  return new THREE.Mesh(g, legends());
}

// ------------------------------------------------------------------ building blocks

function rb(w: number, h: number, d: number, r: number, mat: THREE.Material, parent: THREE.Object3D, x: number, y: number, z: number) {
  const m = new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 2, Math.min(r, w / 2.05, h / 2.05, d / 2.05)), mat);
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}
function disc(r: number, h: number, mat: THREE.Material, parent: THREE.Object3D, x: number, y: number, z: number, seg = 24) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, seg), mat);
  m.rotation.x = Math.PI / 2;
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}

/** A group facing the driver: +z towards them, +x to their right, tilted back by `tilt`. */
export function facePanel(parent: THREE.Object3D, pos: THREE.Vector3, yaw: number, tilt: number) {
  const g = new THREE.Group();
  g.position.copy(pos);
  g.rotation.order = 'YXZ';
  g.rotation.set(-tilt, Math.PI + yaw, 0);
  parent.add(g);
  return g;
}

/** One gauge at (x, y) in panel space: cup, face, needle, cap, chrome bezel and glass. */
function gauge(p: THREE.Group, id: GaugeId, x: number, y: number, r: number): Gauge {
  const M = cockpitMats();
  const cupG = new THREE.CylinderGeometry(r + 0.004, r + 0.002, 0.022, 40, 1, true);
  const cupM = new THREE.Mesh(cupG, M.cup);
  cupM.rotation.x = Math.PI / 2;
  cupM.position.set(x, y, -0.011);
  p.add(cupM);
  const face = new THREE.Mesh(new THREE.CircleGeometry(r + 0.002, 48), dialMaterial(id, DIALS[id]));
  face.position.set(x, y, -0.02);
  p.add(face);
  const pivot = new THREE.Group();
  pivot.position.set(x, y, -0.014);
  p.add(pivot);
  const needle = new THREE.Mesh(new THREE.BoxGeometry(r * 1.05, r > 0.05 ? 0.0045 : 0.003, 0.002), M.needle);
  needle.position.x = r * 0.36;
  pivot.add(needle);
  disc(r > 0.05 ? 0.011 : 0.006, 0.006, M.black, p, x, y, -0.011, 16);
  const bez = new THREE.Mesh(new THREE.TorusGeometry(r + 0.004, r > 0.05 ? 0.0055 : 0.0035, 8, 48), M.chrome);
  bez.position.set(x, y, 0.0);
  p.add(bez);
  const glass = new THREE.Mesh(new THREE.CircleGeometry(r + 0.004, 40), M.glass);
  glass.position.set(x, y, 0.002);
  p.add(glass);
  return { needle: pivot, a0: DIALS[id].sweep[0], a1: DIALS[id].sweep[1] };
}

/** A rocker switch bank: bezel plate, rockers rocked on or off, a legend and a pilot LED each. */
export function rockerBank(p: THREE.Group, labels: string[], on: boolean[], x: number, y: number, cols: number) {
  const M = cockpitMats();
  const sw = 0.03, sh = 0.044, gap = 0.006;
  const rows = Math.ceil(labels.length / cols);
  const W = cols * (sw + gap) + gap, H = rows * (sh + gap) + gap;
  rb(W + 0.008, H + 0.008, 0.012, 0.004, M.black, p, x, y, -0.004);
  labels.forEach((l, i) => {
    const cx = x - W / 2 + gap + sw / 2 + (i % cols) * (sw + gap);
    const cy = y + H / 2 - gap - sh / 2 - Math.floor(i / cols) * (sh + gap);
    const rk = new THREE.Group();
    rk.position.set(cx, cy, 0.006);
    rk.rotation.x = on[i] ? -0.16 : 0.16;
    p.add(rk);
    rb(sw, sh, 0.012, 0.004, M.rocker, rk, 0, 0, 0);
    const leg = legendPlane(l, sw * 0.86, sw * 0.43);
    leg.position.set(0, sh * 0.16, 0.0062);
    rk.add(leg);
    const led = new THREE.Mesh(new THREE.PlaneGeometry(0.009, 0.004), on[i] ? M.ledOn : M.ledOff);
    led.position.set(0, -sh * 0.3, 0.0062);
    rk.add(led);
  });
}

/** A ridged rotary knob with a white pointer line. */
export function knob(p: THREE.Group, x: number, y: number, r: number, turn = 0) {
  const M = cockpitMats();
  const g = new THREE.CylinderGeometry(r, r * 1.06, r * 0.9, 36, 1);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const px = pos.getX(i), pz = pos.getZ(i), a = Math.atan2(pz, px);
    const rr = Math.hypot(px, pz);
    if (rr > r * 0.5) { const k = 1 + 0.06 * Math.max(0, Math.cos(a * 18)); pos.setX(i, px * k); pos.setZ(i, pz * k); }
  }
  g.computeVertexNormals();
  const k = new THREE.Mesh(g, M.knob);
  k.rotation.x = Math.PI / 2;
  k.position.set(x, y, r * 0.45);
  p.add(k);
  disc(r * 1.25, 0.004, M.satin, p, x, y, 0.001, 32);
  const mark = rb(0.003, r * 0.7, 0.002, 0.001, M.white, p, x, y, r * 0.9 + 0.001);
  mark.position.set(x + Math.sin(turn) * r * 0.45, y + Math.cos(turn) * r * 0.45, r * 0.9 + 0.002);
  mark.rotation.z = -turn;
}

/** A round eyeball vent with louvres. */
export function vent(p: THREE.Group, x: number, y: number, r: number) {
  const M = cockpitMats();
  const ring = new THREE.Mesh(new THREE.TorusGeometry(r, r * 0.16, 8, 32), M.satin);
  ring.position.set(x, y, 0.004);
  p.add(ring);
  const ball = new THREE.Mesh(new THREE.SphereGeometry(r * 0.95, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2), M.black);
  ball.rotation.x = Math.PI / 2;
  ball.position.set(x, y, -r * 0.5);
  ball.scale.set(1, 0.6, 1);
  p.add(ball);
  for (let k = -2; k <= 2; k++) rb(r * 1.7, 0.003, r * 0.4, 0.001, M.panelLight, p, x, y + k * r * 0.3, 0.0);
  rb(r * 0.18, r * 0.5, r * 0.25, 0.002, M.satin, p, x, y - r * 0.05, 0.012);
}

/** Ignition switch with the key in it and a key ring hanging down. */
export function ignition(p: THREE.Group, x: number, y: number) {
  const M = cockpitMats();
  disc(0.02, 0.012, M.chrome, p, x, y, 0.004, 24);
  disc(0.013, 0.014, M.black, p, x, y, 0.008, 18);
  const key = rb(0.006, 0.04, 0.012, 0.002, M.black, p, x, y, 0.022);
  key.rotation.z = 0.5;
  rb(0.026, 0.03, 0.008, 0.006, M.black, p, x + 0.012, y + 0.018, 0.03).rotation.z = 0.5;
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.014, 0.0018, 6, 20), M.chrome);
  ring.position.set(x + 0.018, y - 0.022, 0.03);
  ring.rotation.y = 0.5;
  p.add(ring);
  const tag = rb(0.022, 0.05, 0.004, 0.006, own(new THREE.MeshStandardMaterial({ color: 0xc8161d, roughness: 0.6 })), p, x + 0.02, y - 0.06, 0.03);
  tag.rotation.z = 0.12;
  const key2 = rb(0.006, 0.032, 0.002, 0.001, M.satin, p, x + 0.008, y - 0.045, 0.026);
  key2.rotation.z = -0.3;
}

/** Push-pull brake valve knob: yellow diamond (parking) or red octagon (trailer supply). */
export function brakeKnob(p: THREE.Group, x: number, y: number, kind: 'park' | 'trailer') {
  const M = cockpitMats();
  const sides = kind === 'park' ? 4 : 8, r = kind === 'park' ? 0.034 : 0.028, rot = kind === 'park' ? 0 : Math.PI / 8;
  const shp = new THREE.Shape();
  for (let k = 0; k < sides; k++) { const a = rot + (k / sides) * Math.PI * 2; const px = Math.cos(a) * r, py = Math.sin(a) * r; if (k) shp.lineTo(px, py); else shp.moveTo(px, py); }
  const g = new THREE.ExtrudeGeometry(shp, { depth: 0.022, bevelEnabled: true, bevelSize: 0.005, bevelThickness: 0.005, bevelSegments: 2 });
  const m = new THREE.Mesh(g, kind === 'park' ? M.yellow : M.red);
  m.position.set(x, y, 0.045);
  p.add(m);
  const stem = disc(0.006, 0.05, M.satin, p, x, y, 0.022, 10);
  void stem;
  disc(0.016, 0.006, M.chrome, p, x, y, 0.003, 18);
}

// ------------------------------------------------------------------ the gauge panel

/** The full instrument panel. `p` is a facePanel group centred on the binnacle. */
export function buildCluster(p: THREE.Group): Cockpit {
  const M = cockpitMats();
  // Backing panel with a soft-grain finish and a satin surround.
  rb(0.9, 0.3, 0.03, 0.02, M.panel, p, 0, -0.005, -0.047);
  const gauges = {} as Record<GaugeId, Gauge>;
  gauges.tach = gauge(p, 'tach', -0.135, 0.022, 0.078);
  gauges.speedo = gauge(p, 'speedo', 0.135, 0.022, 0.078);
  const small: [GaugeId, number, number][] = [
    ['water', -0.27, 0.07], ['oil', -0.27, -0.025], ['volts', -0.36, 0.07], ['trans', -0.36, -0.025],
    ['air1', 0.27, 0.07], ['air2', 0.27, -0.025], ['fuel', 0.36, 0.07], ['def', 0.36, -0.025],
  ];
  for (const [id, x, y] of small) gauges[id] = gauge(p, id, x, y, 0.036);
  // Driver information display between the big dials.
  rb(0.082, 0.112, 0.012, 0.006, M.black, p, 0, 0.03, -0.012);
  const lcd = new THREE.Mesh(new THREE.PlaneGeometry(0.068, 0.096), new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }));
  lcd.position.set(0, 0.03, -0.005);
  p.add(lcd);
  // Warning-light strip along the bottom (drawn live by the rig).
  rb(0.6, 0.032, 0.01, 0.004, M.black, p, 0, -0.112, -0.012);
  const telltales = new THREE.Mesh(new THREE.PlaneGeometry(0.59, 0.026), new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }));
  telltales.position.set(0, -0.112, -0.006);
  p.add(telltales);
  // Trip buttons and the panel dimmer.
  for (let k = 0; k < 3; k++) disc(0.007, 0.006, M.black, p, -0.06 + k * 0.06, -0.075, -0.008, 12);
  return { gauges, lcd, telltales };
}

// ------------------------------------------------------------------ steering wheel

/** Four-spoke truck wheel with a stitched leather rim, thumb controls and the horn pad. */
export function buildWheel(inner: THREE.Group, leather: THREE.Material) {
  const M = cockpitMats();
  const R = 0.245;
  // Leather rim with a stitch line round the inside (UV v = 0.5 is the inner edge of the torus).
  const [c, g] = canvas(1024, 64);
  g.fillStyle = '#1b1b1e'; g.fillRect(0, 0, 1024, 64);
  const rnd = mulberry32(4);
  for (let i = 0; i < 3000; i++) { const v = 22 + rnd() * 14; g.fillStyle = `rgb(${v},${v},${v + 2})`; g.fillRect(rnd() * 1024, rnd() * 64, 2, 2); }
  g.strokeStyle = '#6a6a70'; g.lineWidth = 2;
  for (let x = 0; x < 1024; x += 8) { g.beginPath(); g.moveTo(x, 28); g.lineTo(x + 5, 36); g.stroke(); }
  const rimTex = tex(c);
  rimTex.wrapS = THREE.RepeatWrapping;
  const rimMat = own(new THREE.MeshStandardMaterial({ map: rimTex, roughness: 0.5, normalMap: (leather as THREE.MeshStandardMaterial).normalMap ?? null }));
  const rimG = new THREE.TorusGeometry(R, 0.022, 16, 96);
  const rp = rimG.attributes.position;
  for (let i = 0; i < rp.count; i++) {
    const x = rp.getX(i), y = rp.getY(i), a = Math.atan2(y, x), r0 = Math.hypot(x, y);
    const grip = 1 + 0.28 * Math.max(0, Math.cos(2 * (a - 0.15))) ** 6 + 0.28 * Math.max(0, Math.cos(2 * (a + 0.15))) ** 6;
    const k = (R + (r0 - R) * grip) / r0;
    rp.setXYZ(i, x * k, y * k, rp.getZ(i) * grip);
  }
  rimG.computeVertexNormals();
  inner.add(new THREE.Mesh(rimG, rimMat));
  // Four spokes: two near-horizontal carrying the thumb pads, two down to the bottom.
  for (const a of [0.22, Math.PI - 0.22, -Math.PI / 2 - 0.62, -Math.PI / 2 + 0.62]) {
    const sp = new THREE.Mesh(new RoundedBoxGeometry(0.16, 0.042, 0.022, 2, 0.01), M.panelLight);
    sp.position.set(Math.cos(a) * 0.15, Math.sin(a) * 0.15, -0.012);
    sp.rotation.z = a;
    inner.add(sp);
  }
  // Thumb pads: cruise on the left, audio and display on the right.
  const pad = (x: number, labels: string[]) => {
    const g2 = new THREE.Group();
    g2.position.set(x, 0.03, 0.004);
    inner.add(g2);
    rb(0.062, 0.05, 0.012, 0.006, M.black, g2, 0, 0, 0);
    labels.forEach((l, i) => {
      const bx = (i % 2 ? 0.014 : -0.014), by = i < 2 ? 0.011 : -0.011;
      rb(0.024, 0.017, 0.006, 0.003, M.rocker, g2, bx, by, 0.007);
      const lp = legendPlane(l, 0.02, 0.01);
      lp.position.set(bx, by, 0.0102);
      g2.add(lp);
    });
  };
  pad(-0.13, ['SET', 'RES', '+', '−']);
  pad(0.13, ['VOL', 'MODE', 'TALK', 'CANCEL']);
  // Horn pad with the badge.
  const hub = new THREE.Mesh(new RoundedBoxGeometry(0.15, 0.12, 0.06, 4, 0.028), leather);
  hub.position.z = 0.008;
  inner.add(hub);
  const badge = new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.024, 0.006, 6), M.chrome);
  badge.rotation.x = Math.PI / 2;
  badge.position.z = 0.04;
  inner.add(badge);
  disc(0.017, 0.004, own(new THREE.MeshStandardMaterial({ color: 0x1b3d8a, metalness: 0.5, roughness: 0.3 })), inner, 0, 0, 0.044, 6);
}
