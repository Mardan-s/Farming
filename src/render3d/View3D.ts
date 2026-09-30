import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { QUALITY, getQuality, isSafeMode, setSafeMode } from './quality';
import {
  COMBINE_LEN, CROP_DEFS, ELEVATOR, HEADER_OFFSET, MAP_H, MAP_W, PARCEL_COLS, PARCEL_H, PARCEL_ORIGIN, PARCEL_ROWS,
  PARCEL_W, PUMP, ROAD, SELL_UNLOAD, SILO_POS, SILO_RADIUS, SILO_UNLOAD, TOOL_LEN, WAGON_CAP, YARD, YARD_GATE, parcelPrice,
  type Op, type ToolKind, type Weather,
} from '../game/config';
import { CellState, type Field } from '../game/field';
import type { Pt } from '../game/geometry';
import { isHarvester, type Game, type Vehicle } from '../game/sim';
import { setEngine, setRain, sfx } from '../audio';
import { PARCEL_COUNT, inRect, parcelRect } from '../game/world';
import { Crops } from './crops';
import { Ground } from './ground';
import { T, buildTiles } from './groundTiles';
import { disposeSprite, tagSprite, textSprite } from './labels';
import {
  box, buildCombine, buildElevator, buildFarmhouse, buildRootHarvester, buildShed, buildSilo, buildTool, buildTractor, buildTrees, setHeader,
  type ToolModel, type VehicleModel,
} from './models';
import { Particles } from './particles';
import { cloudUniforms } from './ground';
import {
  Birds, blob, blobField, buildBales, buildHeadlights, buildLamp, buildMoon, buildMountains, buildPond, buildPowerLine,
  buildStars, buildWildEdges, buildWindmill, mergeStatic, type Pond,
} from './scenery';
import type { TapInfo, ViewControls, ViewHost } from './types';

const PITCH = THREE.MathUtils.degToRad(55);
const CHASE_PITCH = THREE.MathUtils.degToRad(24);
const RAIN_DROPS = 1500;
const CLOUD: Record<Weather, number> = { sun: 0, cloudy: 0.55, rain: 0.8, storm: 1 };
const RAIN: Record<Weather, number> = { sun: 0, cloudy: 0, rain: 0.6, storm: 1 };
/** Implements fold narrower when driving on the road. */
const FOLDED: Partial<Record<ToolKind, number>> = { seeder: 3, roller: 2.4, weeder: 2.4, sprayer: 2.2 };
/** Particle look per job. */
const WORK_FX: Record<Exclude<Op, 'harvest'>, { color: number; size: [number, number]; up: number; life: number; alpha: number; n: number; spread?: number }> = {
  plow: { color: 0x8a6a48, size: [0.25, 0.9], up: 0.6, life: 1.4, alpha: 0.45, n: 3 },
  seed: { color: 0xd9c7a0, size: [0.1, 0.3], up: 0.3, life: 0.8, alpha: 0.5, n: 2 },
  fertilize: { color: 0xf4f4f0, size: [0.05, 0.07], up: 1.2, life: 0.7, alpha: 0.95, n: 5, spread: 4 },
  lime: { color: 0xe8e6de, size: [0.3, 1.1], up: 0.5, life: 1.6, alpha: 0.5, n: 4, spread: 2.5 },
  roll: { color: 0xa08a6a, size: [0.2, 0.6], up: 0.3, life: 1, alpha: 0.3, n: 2 },
  weed: { color: 0x6f8f3a, size: [0.06, 0.1], up: 1, life: 0.6, alpha: 0.9, n: 3 },
  spray: { color: 0xcfe6ff, size: [0.15, 0.5], up: 0.1, life: 0.9, alpha: 0.35, n: 5 },
};
const FOV = 38;
/** The pond south of the road, near the farm. */
const POND = { x: 25, z: 72.2, rx: 5.2, rz: 2.6 };

interface VehicleView { model: VehicleModel; lx: number; ly: number; emitT: number; bubble: THREE.Sprite; pipeAngle: number; lights: THREE.Group }

/** Flat strip following a polyline, lying on the ground. */
function ribbon(points: Pt[], closed: boolean, width: number, y: number) {
  const pos: number[] = [];
  const n = points.length;
  const segs = closed ? n : n - 1;
  const hw = width / 2;
  for (let i = 0; i < segs; i++) {
    const a = points[i], b = points[(i + 1) % n];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const px = (-dy / len) * hw, py = (dx / len) * hw;
    const ex = (dx / len) * hw, ey = (dy / len) * hw; // extend ends to close joints
    const A = [a.x - ex + px, y, a.y - ey + py], B = [a.x - ex - px, y, a.y - ey - py];
    const C = [b.x + ex - px, y, b.y + ey - py], D = [b.x + ex + px, y, b.y + ey + py];
    pos.push(...A, ...C, ...B, ...A, ...D, ...C); // counter-clockwise from above
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return g;
}

export class View3D implements ViewControls {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(FOV, 1, 1, 500);
  private target = new THREE.Vector3(17, 0, 51);
  private dist = 30;
  private yaw = 0;
  private pitch = PITCH;
  private chaseDist = 13;
  private wasDriving = false;
  private snow = 0;
  private pond!: Pond;
  private waterBase = new THREE.Color(0x3f7fa8);
  private rotor!: THREE.Object3D;
  private birds!: Birds;
  private stars!: THREE.Points;
  private moon!: ReturnType<typeof buildMoon>;
  private mountains!: ReturnType<typeof buildMountains>;
  private lamp!: ReturnType<typeof buildLamp>;
  private night = 0;
  private cloudDrift = new THREE.Vector2(0.13, 0.41);
  private hillMats: THREE.MeshLambertMaterial[] = [];
  private snowTint = -1;
  private readonly snowColor = new THREE.Color(0xe4eaf0);
  private sun = new THREE.DirectionalLight(0xffffff, 2.6);
  private hemi = new THREE.HemisphereLight(0xb8d4ff, 0x4a5a3a, 1.1);
  private q = QUALITY[getQuality()];
  private ground: Ground;
  private safe = isSafeMode();
  private crops = new Crops(this.q.plantDensity, this.q.grassDensity, this.safe);
  private skyMesh = new Sky();
  private cloudDome!: THREE.Mesh;
  private pmrem!: THREE.PMREMGenerator;
  private envScene = new THREE.Scene();
  private envRT: THREE.WebGLRenderTarget | null = null;
  private envT = 99;
  private envDome: THREE.Mesh | null = null;
  private sunDir = new THREE.Vector3(0, 1, 0);
  private particles = new Particles();
  private stageCache = new Map<number, Int8Array>();
  private vViews = new Map<number, VehicleView>();
  private tViews = new Map<number, ToolModel>();
  private pickables: THREE.Object3D[] = [];
  private fieldGroup = new THREE.Group();
  private parcelGroup = new THREE.Group();
  private draftGroup = new THREE.Group();
  private grid: THREE.LineSegments;
  private draftCells: THREE.InstancedMesh;
  private draftSig = '';
  private firstCorner: THREE.Mesh | null = null;
  private ring: THREE.Mesh;
  private route: THREE.Line;
  private popups: { s: THREE.Sprite; t: number; base: THREE.Vector3 }[] = [];
  private lastSel: number | null = null;
  private time = 0;
  private sweepT = 0;
  private flushT = 0;
  private raycaster = new THREE.Raycaster();
  private groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private pointers = new Map<number, { x: number; y: number }>();
  private drag: { id: number; sx: number; sy: number; moved: boolean } | null = null;
  private pinch: { d: number; a: number; dist: number; yaw: number } | null = null;
  private skyDay = new THREE.Color(0xa9d6f2);
  private skyDusk = new THREE.Color(0xf2a66e);
  private skyNight = new THREE.Color(0x0e1633);
  private sky = new THREE.Color();
  private skyGrey = new THREE.Color(0x8e99a2);
  private cloud = 0;
  private rainLevel = 0;
  private wet = 0;
  private flash = 0;
  private flashEcho = 0;
  private nextBolt = 3;
  private rainAudioT = 0;
  private rain!: THREE.LineSegments;
  private rainPos = new Float32Array(RAIN_DROPS * 6);
  private fieldSigs = new Map<number, string>();

  constructor(parent: HTMLElement, private sim: Game, private host: ViewHost) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    // If any shader fails on this device, save and reload in safe mode (no custom shaders).
    this.renderer.debug.onShaderError = (gl, program, vs, fs) => {
      const log = [gl.getProgramInfoLog(program), gl.getShaderInfoLog(vs), gl.getShaderInfoLog(fs)].filter(Boolean).join(' | ');
      console.error('Shader failed:', log);
      if (!this.safe) {
        setSafeMode(log || 'shader error');
        this.safe = true;
        this.host.onGraphicsFailure?.();
      }
    };
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.q.pixelRatio));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.78;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    parent.appendChild(this.renderer.domElement);

    this.scene.fog = new THREE.Fog(this.skyDay, 60, 160);
    this.scene.add(this.hemi, this.sun, this.sun.target);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(this.q.shadowMap, this.q.shadowMap);
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.02;

    this.ground = new Ground(buildTiles(), this.renderer.capabilities.getMaxAnisotropy(), this.q.detailGround && !this.safe);
    this.scene.add(this.ground.group, this.crops.group, this.particles.points, this.fieldGroup, this.parcelGroup, this.draftGroup);
    this.paintAll();
    this.buildScenery();
    if (!this.safe) this.buildSky();
    this.buildHills();
    this.syncGrass();

    this.grid = this.buildGrid();
    this.grid.visible = false;
    this.scene.add(this.grid);
    this.draftCells = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(0.94, 0.94).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x7dff7a, transparent: true, opacity: 0.35, depthWrite: false , polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }),
      4000,
    );
    this.draftCells.count = 0;
    this.draftCells.frustumCulled = false;
    this.draftCells.renderOrder = 3;
    this.scene.add(this.draftCells);

    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(0.85, 1.02, 48).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffe066, transparent: true, opacity: 0.95, depthWrite: false , polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }),
    );
    this.ring.renderOrder = 4;
    this.ring.visible = false;
    this.route = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 0.5, gapSize: 0.35, transparent: true, opacity: 0.8 }));
    this.route.frustumCulled = false;
    this.scene.add(this.ring, this.route);

    this.redrawParcels();
    this.redrawFields();
    this.buildRain();

    sim.events.on('cell', (fid: number, i: number) => {
      const f = sim.world.fields.get(fid);
      if (f) this.paintFieldCell(f, i);
    });
    sim.events.on('fields', () => { this.syncFieldTiles(); this.redrawFields(); this.syncGrass(); });
    sim.events.on('parcels', () => this.redrawParcels());
    sim.events.on('money', (x: number, y: number, amount: number) => this.moneyPopup(x, y, amount));

    this.setupInput();
    // Labels drawn before the web fonts arrive use a fallback face; redraw once they're in.
    document.fonts?.ready.then(() => { this.redrawFields(); this.redrawParcels(); });
    window.addEventListener('resize', () => this.resize());
    this.resize();
    // Start with about 26 cells visible across the screen.
    const halfH = Math.atan(Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * this.camera.aspect);
    this.dist = THREE.MathUtils.clamp(26 / (2 * Math.tan(halfH)), 18, 60);
    host.attach(this);

    let last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      this.frame(dt);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  // ---------- ground & crops ----------

  private baseTile(x: number, y: number): number {
    if (inRect(x, y, ROAD)) {
      if (y === ROAD.y) return T.RoadTop;
      if (y === ROAD.y + ROAD.h - 1) return T.RoadBottom;
      return T.Road;
    }
    if (inRect(x, y, YARD) || inRect(x, y, ELEVATOR)) return T.Gravel;
    return T.Grass0 + (((x * 7 + y * 13) ^ (x * y)) & 3);
  }

  private fieldTile(f: Field, i: number, stage: number): number {
    const v = f.axis === 'v';
    switch (f.state[i]) {
      case CellState.Grass: return T.Meadow;
      case CellState.Plowed: return v ? T.PlowV : T.PlowH;
      case CellState.Seeded:
        if (f.rolled[i]) return v ? T.RolledV : T.RolledH;
        if (stage <= 0) return v ? T.SeedV : T.SeedH;
        return stage >= 2 ? (v ? T.CanopyV : T.CanopyH) : (v ? T.PlowV : T.PlowH);
      default: {
        const crop = f.cropAt(i);
        if (crop && CROP_DEFS[crop].root) return v ? T.RolledV : T.RolledH; // dug-over bare soil
        const stalks = crop ? CROP_DEFS[crop].look.stalks : false;
        return stalks ? (v ? T.StalkV : T.StalkH) : (v ? T.StrawV : T.StrawH);
      }
    }
  }

  private paintAll() {
    for (let y = 0; y < MAP_H; y++) for (let x = 0; x < MAP_W; x++) this.ground.set(x, y, this.baseTile(x, y));
    this.syncFieldTiles();
  }

  private syncFieldTiles() {
    this.stageCache.clear();
    for (let y = 0; y < MAP_H; y++) {
      for (let x = 0; x < MAP_W; x++) {
        if (this.sim.world.fieldIdAt(x, y) >= 0) continue;
        this.ground.set(x, y, this.baseTile(x, y));
        this.crops.clear(x, y);
      }
    }
    for (const f of this.sim.world.fields.values()) {
      this.stageCache.set(f.id, new Int8Array(f.cells.length).fill(-9));
      for (let i = 0; i < f.cells.length; i++) this.paintFieldCell(f, i);
    }
  }

  private paintFieldCell(f: Field, i: number) {
    const stage = f.stage(i, this.sim.growth);
    const cache = this.stageCache.get(f.id);
    if (cache) cache[i] = f.state[i] === CellState.Seeded ? stage : -1 - f.state[i];
    const c = f.cells[i];
    this.ground.set(c.x, c.y, this.fieldTile(f, i, stage));
    this.crops.update(f, i, stage);
  }

  /** Short field label: number plus icons for what the field needs. */
  private fieldMarks(f: Field) {
    const s = f.summary(this.sim.growth);
    const marks: string[] = [];
    if (s.ready) marks.push('#c9961e'); // ripe
    if (s.weedy > s.total * 0.05) marks.push('#8a4a9a'); // weeds
    if (s.needLime > s.total * 0.2) marks.push('#8d8d86'); // needs lime
    return marks;
  }

  private fieldLabel(f: Field) { return `${f.id}|${this.fieldMarks(f).join(',')}`; }

  private sweepGrowth() {
    let relabel = false;
    for (const f of this.sim.world.fields.values()) {
      const sig = this.fieldLabel(f);
      if (this.fieldSigs.get(f.id) !== sig) relabel = true;
    }
    if (relabel) this.redrawFields();
    for (const f of this.sim.world.fields.values()) {
      const cache = this.stageCache.get(f.id);
      if (!cache) continue;
      for (let i = 0; i < f.cells.length; i++) {
        if (f.state[i] !== CellState.Seeded) continue;
        if (cache[i] !== f.stage(i, this.sim.growth)) this.paintFieldCell(f, i);
      }
    }
  }

  // ---------- scenery ----------

  private syncGrass() {
    const w = this.sim.world;
    this.crops.syncGrass((x, y) => w.fieldIdAt(x, y) < 0 && !w.blocked[y * MAP_W + x]);
  }

  private buildSky() {
    this.skyMesh.scale.setScalar(450);
    const u = this.skyMesh.material.uniforms;
    u.turbidity.value = 4;
    u.rayleigh.value = 1.4;
    u.mieCoefficient.value = 0.004;
    u.mieDirectionalG.value = 0.82;
    this.scene.add(this.skyMesh);
    // Grey cloud cover that fades in with bad weather.
    this.cloudDome = new THREE.Mesh(
      new THREE.SphereGeometry(440, 24, 12),
      new THREE.MeshBasicMaterial({ color: 0x9aa4ac, side: THREE.BackSide, transparent: true, opacity: 0, fog: false, depthWrite: false }),
    );
    this.scene.add(this.cloudDome);
    if (this.q.envMap) {
      // Reflections come from a soft, capped gradient rather than the physical sky:
      // the real sky is very bright near the sun and overflows half-float targets on
      // many mobile GPUs, which turns every lit surface black.
      this.pmrem = new THREE.PMREMGenerator(this.renderer);
      this.envDome = new THREE.Mesh(new THREE.SphereGeometry(50, 32, 16), new THREE.ShaderMaterial({
        side: THREE.BackSide,
        uniforms: { top: { value: new THREE.Color() }, horizon: { value: new THREE.Color() }, bottom: { value: new THREE.Color() } },
        vertexShader: 'varying vec3 vDir; void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        fragmentShader: `uniform vec3 top; uniform vec3 horizon; uniform vec3 bottom; varying vec3 vDir;
          void main() {
            float y = vDir.y;
            vec3 c = y > 0.0 ? mix(horizon, top, pow(y, 0.6)) : mix(horizon, bottom, pow(-y, 0.4));
            gl_FragColor = vec4(clamp(c, 0.0, 1.5), 1.0);
          }`,
      }));
      this.envScene.add(this.envDome);
    }
  }

  /** Rolling hills around the map so the world doesn't end at a flat edge. */
  private buildHills() {
    const group = new THREE.Group();
    const geo = new THREE.IcosahedronGeometry(1, 2);
    let seed = 42;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const cx = MAP_W / 2, cz = MAP_H / 2;
    for (let i = 0; i < 46; i++) {
      const a = (i / 46) * Math.PI * 2 + rnd() * 0.1;
      const rx = MAP_W * 0.75 + 28 + rnd() * 40, rz = MAP_H * 0.9 + 28 + rnd() * 40;
      const r = 22 + rnd() * 28;
      const color = new THREE.Color().setHSL(0.26 + rnd() * 0.06, 0.38, 0.28 + rnd() * 0.1);
      const hillMat = new THREE.MeshLambertMaterial({ color, flatShading: true });
      hillMat.userData.base = new THREE.Color(color);
      this.hillMats.push(hillMat);
      const hill = new THREE.Mesh(geo, hillMat);
      hill.position.set(cx + Math.cos(a) * rx, -r * 0.55, cz + Math.sin(a) * rz);
      hill.scale.set(r, r * (0.55 + rnd() * 0.35), r * (0.8 + rnd() * 0.4));
      hill.receiveShadow = true;
      group.add(hill);
    }
    this.scene.add(group);
  }

  private buildScenery() {
    const silo = buildSilo(SILO_RADIUS * 0.9);
    silo.position.set(SILO_POS.x, 0, SILO_POS.y);
    silo.userData.pick = 'silo';
    const shed = buildShed(4.6, 3);
    shed.position.set(YARD.x + YARD.w - 2.8, 0, YARD.y + 2.2);
    const house = buildFarmhouse();
    house.position.set(YARD.x - 2.5, 0, YARD.y + 3);
    house.rotation.y = Math.PI / 2;
    const elev = buildElevator(ELEVATOR.w, ELEVATOR.h);
    elev.position.set(ELEVATOR.x + ELEVATOR.w / 2, 0, ELEVATOR.y + ELEVATOR.h / 2);
    elev.userData.pick = 'elevator';
    // Diesel pump beside the silo.
    const pump = new THREE.Group();
    box(pump, 0.5, 1.1, 0.4, 0xc8392b, 0, 0.55, 0);
    box(pump, 0.54, 0.22, 0.44, 0xf2efe6, 0, 1.0, 0);
    box(pump, 0.08, 0.5, 0.08, 0x2b2b2b, 0.3, 0.6, 0);
    box(pump, 1.3, 0.08, 1.1, 0x9a9a92, 0, 0.04, 0);
    pump.position.set(PUMP.x, 0, PUMP.y);
    pump.traverse(o => { o.castShadow = true; });
    // Pickable buildings stay separate; the rest is baked into a few draw calls.
    const statics = new THREE.Group();
    statics.add(shed, house, pump);
    this.scene.add(silo, elev, mergeStatic(statics));
    const ground = (w: number, d: number, x: number, z: number, o = 0.9) => { const b = blob(w, d, o); b.position.set(x, 0.035, z); this.scene.add(b); };
    ground(SILO_RADIUS * 2.8, SILO_RADIUS * 2.8, SILO_POS.x, SILO_POS.y);
    ground(6, 4.4, YARD.x + YARD.w - 2.8, YARD.y + 2.2);
    ground(4.2, 3.6, YARD.x - 2.3, YARD.y + 3);
    ground(ELEVATOR.w + 1.5, ELEVATOR.h + 1.5, ELEVATOR.x + ELEVATOR.w / 2, ELEVATOR.y + ELEVATOR.h / 2, 0.7);
    ground(1.4, 1.2, PUMP.x, PUMP.y);
    this.pickables.push(silo, elev);

    // Fence around the farmyard.
    const fence = new THREE.Group();
    const postMat = new THREE.MeshLambertMaterial({ color: 0x7a5a3a });
    const edges: [number, number, number, number][] = [
      [YARD.x, YARD.y, YARD.x + YARD.w, YARD.y], [YARD.x, YARD.y, YARD.x, YARD.y + YARD.h],
      // East side, with a gate toward the fields.
      [YARD.x + YARD.w, YARD.y, YARD.x + YARD.w, YARD_GATE.y0], [YARD.x + YARD.w, YARD_GATE.y1, YARD.x + YARD.w, YARD.y + YARD.h],
    ];
    for (const [x0, y0, x1, y1] of edges) {
      const len = Math.hypot(x1 - x0, y1 - y0);
      const rail = new THREE.Mesh(new THREE.BoxGeometry(len, 0.06, 0.05), postMat);
      rail.position.set((x0 + x1) / 2, 0.45, (y0 + y1) / 2);
      rail.rotation.y = -Math.atan2(y1 - y0, x1 - x0);
      rail.castShadow = true;
      fence.add(rail);
      for (let t = 0; t <= len; t += 1.5) {
        const p = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.6, 0.08), postMat);
        p.position.set(x0 + ((x1 - x0) * t) / len, 0.3, y0 + ((y1 - y0) * t) / len);
        p.castShadow = true;
        fence.add(p);
      }
    }
    // Gate posts.
    for (const gy of [YARD_GATE.y0, YARD_GATE.y1]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.16, 1.0, 0.16), postMat);
      post.position.set(YARD.x + YARD.w, 0.5, gy);
      post.castShadow = true;
      fence.add(post);
    }
    this.scene.add(mergeStatic(fence));

    // Road center dashes.
    const dashGeo = new THREE.PlaneGeometry(1, 0.12).rotateX(-Math.PI / 2);
    const dashes = new THREE.InstancedMesh(dashGeo, new THREE.MeshLambertMaterial({ color: 0xf2d15c }), Math.ceil(MAP_W / 2));
    const m = new THREE.Matrix4();
    for (let i = 0; i < dashes.count; i++) {
      m.makeTranslation(i * 2 + 0.5, 0.01, ROAD.y + ROAD.h / 2);
      dashes.setMatrixAt(i, m);
    }
    dashes.receiveShadow = true;
    this.scene.add(dashes);

    // Trees on the map border.
    let seed = 1234;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const trees: { x: number; z: number; s: number; v: number }[] = [];
    for (let y = -6; y < MAP_H + 6; y += 1.7) {
      for (let x = -6; x < MAP_W + 6; x += 1.7) {
        const inParcels = x >= PARCEL_ORIGIN.x - 0.8 && x < PARCEL_ORIGIN.x + PARCEL_COLS * PARCEL_W + 0.8 &&
          y >= PARCEL_ORIGIN.y - 0.8 && y < PARCEL_ORIGIN.y + PARCEL_ROWS * PARCEL_H + 0.8;
        const onRoad = y >= ROAD.y - 0.8 && y < ROAD.y + ROAD.h + 0.8;
        const nearHouse = x > YARD.x - 5 && x < YARD.x && y > YARD.y && y < YARD.y + 12;
        const nearPond = ((x - POND.x) / (POND.rx + 2.2)) ** 2 + ((y - POND.z) / (POND.rz + 2)) ** 2 < 1;
        const nearBales = x > 32 && x < 41 && y > ROAD.y + ROAD.h && y < ROAD.y + ROAD.h + 4;
        const roadside = y >= ROAD.y + ROAD.h && y < ROAD.y + ROAD.h + 2.2;
        if (inParcels || onRoad || nearHouse || nearPond || nearBales || roadside || rnd() < 0.3) continue;
        trees.push({ x: x + (rnd() - 0.5) * 0.9, z: y + (rnd() - 0.5) * 0.9, s: 0.75 + rnd() * 0.6, v: rnd() });
      }
    }
    this.scene.add(buildTrees(trees));
    this.scene.add(blobField(trees.map(t => ({ x: t.x, z: t.z, r: 0.75 * t.s }))));

    this.buildDressing();

    const label = (x: number, y: number, h: number, text: string) => {
      const s = tagSprite(text, 1.1, { accent: '#5a503f' });
      s.position.set(x, h, y);
      this.scene.add(s);
    };
    label(SILO_POS.x, SILO_POS.y, 5.2, 'Silo');
    label(SELL_UNLOAD.x, ELEVATOR.y + 1, 7.6, 'Sell point');
  }

  /** Pond, windmill, hay, power line, wild edges, lamp, birds, sky extras and mountains. */
  private buildDressing() {
    this.pond = buildPond(POND.x, POND.z, POND.rx, POND.rz);
    this.scene.add(this.pond.group);
    const mill = buildWindmill();
    mill.group.position.set(YARD.x - 3, 0, YARD.y + 9.5);
    mill.group.rotation.y = 0.6;
    this.rotor = mill.rotor;
    const mb = blob(2.2, 2.2);
    mb.position.set(YARD.x - 3, 0.035, YARD.y + 9.5);
    const millBase = new THREE.Group();
    millBase.add(mill.group);
    mill.group.remove(mill.rotor);
    mill.group.updateMatrixWorld(true);
    const rotorHolder = new THREE.Group();
    rotorHolder.position.copy(mill.group.position);
    rotorHolder.rotation.copy(mill.group.rotation);
    rotorHolder.add(mill.rotor);
    this.scene.add(mergeStatic(millBase), rotorHolder, mb);
    const by = ROAD.y + ROAD.h + 1.6;
    this.scene.add(buildBales([
      { x: 33.5, z: by, a: 0.2, stacked: true }, { x: 34.9, z: by + 0.2, a: 0.1 }, { x: 36.4, z: by - 0.1, a: -0.2 },
      { x: 38.6, z: by + 0.9, a: 1.2 }, { x: 35.6, z: by + 1.5, a: 0.4 },
    ]));
    this.scene.add(mergeStatic(buildPowerLine(2, MAP_W - 2, ROAD.y + ROAD.h + 0.6, 9)));
    // Wild strip south of the road, and along the west and north edges.
    const spots: { x: number; z: number }[] = [];
    for (let i = 0; i < 150; i++) {
      const x = 1 + Math.random() * (MAP_W - 2), z = ROAD.y + ROAD.h + 1.2 + Math.random() * 3.5;
      const inPond = ((x - POND.x) / (POND.rx + 1.2)) ** 2 + ((z - POND.z) / (POND.rz + 1)) ** 2 < 1;
      if (!inPond && !(x > 32 && x < 41)) spots.push({ x, z });
    }
    for (let i = 0; i < 70; i++) spots.push({ x: 0.3 + Math.random() * 2.3, z: 3 + Math.random() * 40 });
    for (let i = 0; i < 90; i++) spots.push({ x: 4 + Math.random() * (MAP_W - 8), z: 0.3 + Math.random() * 2.3 });
    this.scene.add(buildWildEdges(spots));
    this.lamp = buildLamp();
    this.lamp.group.position.set(YARD.x + 0.6, 0, YARD.y + YARD.h - 0.6);
    this.scene.add(this.lamp.group);
    this.birds = new Birds(MAP_W / 2, MAP_H / 2);
    this.stars = buildStars();
    this.moon = buildMoon();
    this.mountains = buildMountains(MAP_W / 2, MAP_H / 2);
    this.scene.add(this.birds.mesh, this.stars, this.moon.group, this.mountains.group);
  }

  private buildGrid() {
    const pos: number[] = [];
    for (let x = 0; x <= MAP_W; x++) pos.push(x, 0.03, 0, x, 0.03, ROAD.y);
    for (let y = 0; y <= ROAD.y; y++) pos.push(0, 0.03, y, MAP_W, 0.03, y);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    return new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.22 }));
  }

  private clearGroup(g: THREE.Group) {
    for (const child of [...g.children]) {
      if (child instanceof THREE.Sprite) { disposeSprite(child); continue; }
      if (child instanceof THREE.Mesh) child.geometry.dispose();
      g.remove(child);
    }
  }

  redrawParcels() {
    this.clearGroup(this.parcelGroup);
    const shade = new THREE.MeshBasicMaterial({ color: 0x0b1608, transparent: true, opacity: 0.32, depthWrite: false , polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
    const border = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, depthWrite: false , polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
    for (let i = 0; i < PARCEL_COUNT; i++) {
      const r = parcelRect(i);
      const pts = [{ x: r.x, y: r.y }, { x: r.x + r.w, y: r.y }, { x: r.x + r.w, y: r.y + r.h }, { x: r.x, y: r.y + r.h }];
      if (this.sim.owned.has(i)) {
        const b = new THREE.Mesh(ribbon(pts, true, 0.08, 0.025), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.18, depthWrite: false , polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }));
        this.parcelGroup.add(b);
        continue;
      }
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(r.w, r.h).rotateX(-Math.PI / 2), shade);
      plane.position.set(r.x + r.w / 2, 0.02, r.y + r.h / 2);
      plane.renderOrder = 2;
      this.parcelGroup.add(plane, new THREE.Mesh(ribbon(pts.map(p => ({ x: p.x + (p.x > r.x ? -0.2 : 0.2), y: p.y + (p.y > r.y ? -0.2 : 0.2) })), true, 0.14, 0.03), border));
      const s = tagSprite(`$${parcelPrice(i).toLocaleString()}`, 2.6, { eyebrow: 'For sale' });
      s.position.set(r.x + r.w / 2, 1.5, r.y + r.h / 2);
      this.parcelGroup.add(s);
    }
  }

  redrawFields() {
    this.clearGroup(this.fieldGroup);
    const sel = this.host.selectedField;
    for (const f of this.sim.world.fields.values()) {
      const selected = f.id === sel;
      const mat = new THREE.MeshBasicMaterial({ color: selected ? 0xffe066 : 0xffffff, transparent: true, opacity: selected ? 1 : 0.55, depthWrite: false , polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
      const line = new THREE.Mesh(ribbon(f.poly, true, selected ? 0.22 : 0.12, 0.04), mat);
      line.renderOrder = 3;
      this.fieldGroup.add(line);
      const label = this.fieldLabel(f);
      this.fieldSigs.set(f.id, label);
      const s = tagSprite(`${f.id}`, selected ? 1.6 : 1.25, { marks: this.fieldMarks(f), accent: selected ? '#a8731a' : '#3b6a34' });
      void label;
      s.position.set(f.center.x, 1.8, f.center.y);
      this.fieldGroup.add(s);
    }
    this.lastSel = sel;
  }

  private updateDraft() {
    const on = this.host.drawMode;
    this.grid.visible = on;
    const pts = this.host.draft;
    const sig = on ? `${JSON.stringify(pts)}|${this.host.draftValid}|${this.host.draftCells.length}` : '';
    if (sig === this.draftSig) {
      if (this.firstCorner) this.firstCorner.scale.setScalar(1 + Math.sin(this.time * 6) * 0.25);
      return;
    }
    this.draftSig = sig;
    this.clearGroup(this.draftGroup);
    this.firstCorner = null;
    const cells = on ? this.host.draftCells : [];
    const valid = this.host.draftValid;
    (this.draftCells.material as THREE.MeshBasicMaterial).color.setHex(valid ? 0x7dff7a : 0xff6b6b);
    const m = new THREE.Matrix4();
    this.draftCells.count = Math.min(cells.length, 4000);
    for (let i = 0; i < this.draftCells.count; i++) {
      m.makeTranslation(cells[i].x + 0.5, 0.05, cells[i].y + 0.5);
      this.draftCells.setMatrixAt(i, m);
    }
    this.draftCells.instanceMatrix.needsUpdate = true;
    if (!on) return;
    if (pts.length > 1) {
      const mat = new THREE.MeshBasicMaterial({ color: valid ? 0xffffff : 0xffb3b3, depthWrite: false , polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
      const line = new THREE.Mesh(ribbon(pts, false, 0.14, 0.07), mat);
      line.renderOrder = 4;
      this.draftGroup.add(line);
      if (pts.length >= 4) {
        const close = new THREE.Mesh(ribbon([pts[pts.length - 1], pts[0]], false, 0.08, 0.07), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5, depthWrite: false , polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }));
        this.draftGroup.add(close);
      }
    }
    pts.forEach((p, i) => {
      const dot = new THREE.Mesh(new THREE.CylinderGeometry(i === 0 ? 0.3 : 0.22, i === 0 ? 0.3 : 0.22, 0.12, 20), new THREE.MeshLambertMaterial({ color: i === 0 ? 0xffe066 : 0xffffff }));
      dot.position.set(p.x, 0.08, p.y);
      this.draftGroup.add(dot);
      if (i === 0 && pts.length >= 4) this.firstCorner = dot;
    });
  }

  // ---------- camera & input ----------

  private resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.fov = w < h ? 52 : FOV; // wider lens in portrait so fields fit
    this.camera.updateProjectionMatrix();
    const buf = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.particles.uniforms.uScale.value = buf.y / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)));
  }

  private updateCamera() {
    this.target.x = THREE.MathUtils.clamp(this.target.x, 0, MAP_W);
    this.target.z = THREE.MathUtils.clamp(this.target.z, 0, MAP_H);
    const d = this.sim.drivenId != null ? this.chaseDist : this.dist;
    const p = this.pitch;
    this.camera.position.set(
      this.target.x + Math.sin(this.yaw) * Math.cos(p) * d,
      Math.sin(p) * d,
      this.target.z + Math.cos(this.yaw) * Math.cos(p) * d,
    );
    this.camera.lookAt(this.target);
    const fog = this.scene.fog as THREE.Fog;
    fog.near = d * 1.6;
    fog.far = d * 4.5;
  }

  zoomBy(f: number) {
    if (this.sim.drivenId != null) this.chaseDist = THREE.MathUtils.clamp(this.chaseDist / f, 6, 30);
    else this.dist = THREE.MathUtils.clamp(this.dist / f, 7, 110);
  }
  rotateBy(r: number) { this.yaw += r; }
  centerOnCells(x: number, y: number) { this.target.set(x, 0, y); }

  private groundAt(sx: number, sy: number): THREE.Vector3 | null {
    this.raycaster.setFromCamera(new THREE.Vector2((sx / window.innerWidth) * 2 - 1, -(sy / window.innerHeight) * 2 + 1), this.camera);
    const out = new THREE.Vector3();
    return this.raycaster.ray.intersectPlane(this.groundPlane, out);
  }

  /** Grid position to CSS pixels (used by tests). */
  cellsToScreen(x: number, y: number) {
    const v = new THREE.Vector3(x, 0, y).project(this.camera);
    return { x: ((v.x + 1) / 2) * window.innerWidth, y: ((1 - v.y) / 2) * window.innerHeight };
  }

  private setupInput() {
    const el = this.renderer.domElement;
    el.style.touchAction = 'none';
    el.addEventListener('pointerdown', e => {
      el.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        this.pinch = { d: Math.hypot(b.x - a.x, b.y - a.y), a: Math.atan2(b.y - a.y, b.x - a.x), dist: this.dist, yaw: this.yaw };
        this.drag = null;
      } else if (this.pointers.size === 1) {
        this.drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, moved: false };
      }
    });
    el.addEventListener('pointermove', e => {
      const prev = this.pointers.get(e.pointerId);
      if (!prev) return;
      const cur = { x: e.clientX, y: e.clientY };
      if (this.pinch && this.pointers.size >= 2) {
        const before = [...this.pointers.values()];
        const midBefore = { x: (before[0].x + before[1].x) / 2, y: (before[0].y + before[1].y) / 2 };
        this.pointers.set(e.pointerId, cur);
        const [a, b] = [...this.pointers.values()];
        const d = Math.hypot(b.x - a.x, b.y - a.y);
        const ang = Math.atan2(b.y - a.y, b.x - a.x);
        if (this.sim.drivenId != null) {
          this.zoomBy(this.pinch.d / d > 1 ? 0.98 : 1.02);
          return;
        }
        this.dist = THREE.MathUtils.clamp(this.pinch.dist * (this.pinch.d / d), 7, 110);
        this.yaw = this.pinch.yaw + (ang - this.pinch.a);
        this.updateCamera();
        const midAfter = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        this.panBy(midBefore, midAfter);
        return;
      }
      const dr = this.drag;
      if (dr && dr.id === e.pointerId) {
        if (!dr.moved && Math.hypot(cur.x - dr.sx, cur.y - dr.sy) > 8) dr.moved = true;
        if (dr.moved && this.sim.drivenId == null) this.panBy(prev, cur);
      }
      this.pointers.set(e.pointerId, cur);
    });
    const up = (e: PointerEvent) => {
      if (!this.pointers.has(e.pointerId)) return;
      this.pointers.delete(e.pointerId);
      if (this.pinch) {
        if (this.pointers.size < 2) this.pinch = null;
        this.drag = null;
        return;
      }
      const dr = this.drag;
      this.drag = null;
      if (dr && dr.id === e.pointerId && !dr.moved && this.sim.drivenId == null) this.handleTap(e.clientX, e.clientY);
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('wheel', e => {
      e.preventDefault();
      this.zoomBy(e.deltaY > 0 ? 0.88 : 1.14);
    }, { passive: false });
  }

  private panBy(from: { x: number; y: number }, to: { x: number; y: number }) {
    this.updateCamera();
    const a = this.groundAt(from.x, from.y), b = this.groundAt(to.x, to.y);
    if (!a || !b) return;
    this.target.x += a.x - b.x;
    this.target.z += a.z - b.z;
    this.updateCamera();
  }

  private handleTap(sx: number, sy: number) {
    this.raycaster.setFromCamera(new THREE.Vector2((sx / window.innerWidth) * 2 - 1, -(sy / window.innerHeight) * 2 + 1), this.camera);
    let vehicleId: number | null = null;
    let pick: string | undefined;
    const hit = this.raycaster.intersectObjects(this.pickables, true)[0];
    for (let o: THREE.Object3D | null = hit?.object ?? null; o; o = o.parent) {
      if (o.userData.vehicleId != null) { vehicleId = o.userData.vehicleId; break; }
      if (o.userData.toolId != null) {
        const t = this.sim.tool(o.userData.toolId);
        if (t?.attachedTo != null) vehicleId = t.attachedTo;
        break;
      }
      if (o.userData.pick) { pick = o.userData.pick; break; }
    }
    const g = this.groundAt(sx, sy);
    const cx = g ? g.x : -1, cy = g ? g.z : -1;
    if (vehicleId == null && g) vehicleId = this.nearestVehicle(cx, cy);
    const ix = Math.floor(cx), iy = Math.floor(cy);
    const info: TapInfo = {
      cx, cy, vehicleId,
      silo: pick === 'silo' || Math.hypot(cx - SILO_POS.x, cy - SILO_POS.y) < SILO_RADIUS,
      elevator: pick === 'elevator' || inRect(ix, iy, ELEVATOR),
      parcel: this.sim.world.parcelAt(ix, iy),
      fieldId: this.sim.world.fieldIdAt(ix, iy),
    };
    this.host.onTap(info);
  }

  private nearestVehicle(x: number, y: number): number | null {
    let best: number | null = null, bestD = Infinity;
    for (const v of this.sim.vehicles) {
      const d = Math.hypot(v.x - x, v.y - y);
      if (d < (isHarvester(v) ? 1.6 : 1.1) && d < bestD) { best = v.id; bestD = d; }
    }
    return best;
  }

  // ---------- per frame ----------

  private frame(dt: number) {
    this.time += dt;
    this.sim.update(dt);
    this.sweepT += dt;
    if (this.sweepT > 0.3) { this.sweepT = 0; this.sweepGrowth(); }
    this.flushT += dt;
    if (this.flushT > 0.06) { this.flushT = 0; this.ground.flush(); }
    if (this.lastSel !== this.host.selectedField) this.redrawFields();
    const driven = this.sim.driven;
    if (driven) {
      // Chase camera: low behind the machine, looking a little ahead of it.
      const k = Math.min(1, dt * 4);
      const fx = Math.cos(driven.heading), fz = Math.sin(driven.heading);
      const look = 2.5 + Math.max(0, driven.speed) * 0.6;
      this.target.x += (driven.x + fx * look - this.target.x) * k;
      this.target.z += (driven.y + fz * look - this.target.z) * k;
      const want = Math.atan2(-fx, -fz);
      let dy = want - this.yaw;
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      this.yaw += dy * Math.min(1, dt * (this.wasDriving ? 2.5 : 6));
      this.pitch += (CHASE_PITCH - this.pitch) * Math.min(1, dt * 3);
      this.wasDriving = true;
    } else {
      if (this.wasDriving) { this.wasDriving = false; this.dist = Math.max(this.dist, 22); }
      this.pitch += (PITCH - this.pitch) * Math.min(1, dt * 3);
    }
    this.updateEngine(driven);
    this.parcelGroup.visible = !driven;
    if (!driven && this.host.follow && this.host.selectedVehicle != null) {
      const v = this.sim.vehicle(this.host.selectedVehicle);
      if (v) {
        const k = Math.min(1, dt * 3);
        this.target.x += (v.x - this.target.x) * k;
        this.target.z += (v.y - this.target.z) * k;
      }
    }
    this.updateCamera();
    this.syncTools();
    this.syncVehicles(dt);
    this.updateSelection();
    this.updateDraft();
    this.updateWeather(dt);
    this.updateLighting();
    this.updateEnvironment(dt);
    this.crops.tick(this.time);
    this.updateDressing(dt);
    this.updatePopups(dt);
    this.particles.update(dt);
    this.renderer.render(this.scene, this.camera);
    this.host.frame(dt);
  }

  private updateDressing(dt: number) {
    const w = this.sim.weather;
    // Cloud shadows drift with the wind; stronger on broken-cloud days, faint when overcast.
    this.cloudDrift.x += dt * 0.0022;
    this.cloudDrift.y += dt * 0.0009;
    cloudUniforms.uCloudOff.value.copy(this.cloudDrift);
    const want = (w === 'sun' ? 0.26 : w === 'cloudy' ? 0.38 : 0.12) * (1 - this.night) * (1 - this.snow * 0.5);
    cloudUniforms.uCloudAmt.value += (want - cloudUniforms.uCloudAmt.value) * Math.min(1, dt);
    // Water: ripples slide, and the surface picks up the sky color.
    this.pond.ripples.offset.x += dt * 0.012;
    this.pond.ripples.offset.y += dt * 0.006;
    this.pond.water.color.copy(this.waterBase).lerp(this.sky, 0.45).multiplyScalar(0.55 + 0.45 * (1 - this.night));
    this.pond.water.emissive.setHex(this.snow > 0.6 ? 0x6c7f8c : 0x0d2a3c).multiplyScalar(1 - this.night * 0.8);
    this.rotor.rotation.x -= dt * (w === 'storm' ? 6 : w === 'rain' ? 3.5 : 1.8);
    this.birds.update(this.time, this.night < 0.4 && w !== 'rain' && w !== 'storm' && this.snow < 0.5);
    this.lamp.set(this.night);
  }

  private engineT = 0;
  private updateEngine(v: Vehicle | undefined) {
    this.engineT += 1 / 60;
    if (this.engineT < 0.1) return;
    this.engineT = 0;
    if (!v) { setEngine(0, 0); return; }
    const load = v.working ? 1 : 0;
    setEngine(1, Math.min(1, Math.abs(v.speed) / 4) * 0.7 + load * 0.3);
  }

  private updateLighting() {
    const h = this.sim.timeOfDay / 60;
    // 0 at night, 1 in full day, with dawn/dusk ramps.
    const day = h < 5 || h >= 21 ? 0 : h < 7.5 ? (h - 5) / 2.5 : h < 18 ? 1 : (21 - h) / 3;
    const dusk = Math.max(0, 1 - Math.abs(day - 0.45) / 0.45) * (h > 12 ? 1 : 0.6);
    this.sky.copy(this.skyNight).lerp(this.skyDay, day).lerp(this.skyDusk, dusk * 0.45 * (1 - this.cloud));
    this.sky.lerp(this.skyGrey.clone().multiplyScalar(0.25 + 0.75 * day), this.cloud * 0.75);
    if (this.flash > 0) this.sky.lerp(new THREE.Color(0xdfe6ff), this.flash * 0.3);
    this.scene.background = this.sky;
    (this.scene.fog as THREE.Fog).color.copy(this.sky);

    // Sun path: rises in the east (-x), sets in the west, low in the south.
    const ang = ((h - 6) / 12) * Math.PI;
    const elev = Math.sin(ang);
    const sunDir = new THREE.Vector3(-Math.cos(ang), Math.max(-0.3, elev) * 0.9, 0.45).normalize();
    this.sunDir.copy(sunDir);
    if (this.safe) {
      this.skyMesh.visible = false;
    } else {
    const u = this.skyMesh.material.uniforms;
    u.sunPosition.value.copy(sunDir);
    u.turbidity.value = 4 + this.cloud * 12;
    u.rayleigh.value = 1.4 - this.cloud * 0.9;
    this.skyMesh.position.copy(this.camera.position);
    this.cloudDome.position.copy(this.camera.position);
    const dome = this.cloudDome.material as THREE.MeshBasicMaterial;
    dome.opacity = this.cloud * 0.85;
    dome.color.copy(this.skyGrey).multiplyScalar(0.2 + 0.8 * day);
    }

    // Light comes from the sun by day and a cool moon at night.
    const lightDir = day > 0.05 ? new THREE.Vector3(sunDir.x, Math.max(0.35, sunDir.y), sunDir.z).normalize()
      : new THREE.Vector3(0.4, 0.8, -0.3).normalize();
    this.sun.intensity = (0.7 + day * 2.55) * (1 - 0.7 * this.cloud);
    this.sun.color.setHex(0x9fb2ff).lerp(new THREE.Color(0xfff0d8), day).lerp(new THREE.Color(0xffa860), dusk * 0.55);
    this.hemi.intensity = (0.55 + day * 0.55) * (1 - 0.15 * this.cloud) + this.flash * 0.7;
    this.scene.environmentIntensity = (0.2 + day * 0.25) * (1 - 0.3 * this.cloud);
    this.sun.position.copy(this.target).addScaledVector(lightDir, 60);
    this.sun.target.position.copy(this.target);
    const s = THREE.MathUtils.clamp(this.dist * 0.95, 14, 55);
    const cam = this.sun.shadow.camera;
    if (cam.right !== s) {
      cam.left = -s; cam.right = s; cam.top = s; cam.bottom = -s;
      cam.near = 1; cam.far = 140;
      cam.updateProjectionMatrix();
    }
    this.ground.setSnow(this.snow, day);
    this.night = 1 - day;
    (this.stars.material as THREE.PointsMaterial).opacity = Math.max(0, this.night - 0.35) * 1.4 * (1 - this.cloud);
    const moonDir = new THREE.Vector3(-sunDir.x, Math.max(0.25, -sunDir.y + 0.35), -sunDir.z + 0.3).normalize();
    this.moon.group.position.copy(this.camera.position).addScaledVector(moonDir, 360);
    this.moon.glow.opacity = this.night * 0.35 * (1 - this.cloud);
    this.moon.disc.opacity = this.night * (1 - this.cloud * 0.8);
    this.mountains.far.color.copy(this.sky).lerp(new THREE.Color(0x6f879c).multiplyScalar(0.35 + 0.65 * day), 0.32 * (1 - this.cloud * 0.5));
    this.mountains.near.color.copy(this.sky).lerp(new THREE.Color(0x4d6b58).multiplyScalar(0.3 + 0.7 * day), 0.5 * (1 - this.cloud * 0.4));
    if (this.snow > 0.3) {
      this.mountains.far.color.lerp(new THREE.Color(0xdfe6ee).multiplyScalar(0.4 + 0.6 * day), this.snow * 0.3);
      this.mountains.near.color.lerp(new THREE.Color(0xd4dce4).multiplyScalar(0.4 + 0.6 * day), this.snow * 0.35);
    }
    const st = Math.round(this.snow * 30);
    if (st !== this.snowTint) {
      this.snowTint = st;
      for (const m of this.hillMats) m.color.copy(m.userData.base).lerp(this.snowColor, this.snow * 0.8);
    }
    const night = 1 - day;
    for (const v of this.vViews.values()) v.model.lights.emissiveIntensity = night > 0.5 ? 2.5 : 0;
  }

  /** Re-bakes sky reflections every few seconds so machines pick up the light. */
  private updateEnvironment(dt: number) {
    if (!this.q.envMap) return;
    this.envT += dt;
    if (this.envT < 4) return;
    this.envT = 0;
    const u = (this.envDome!.material as THREE.ShaderMaterial).uniforms;
    u.horizon.value.copy(this.sky);
    u.top.value.copy(this.sky).multiplyScalar(0.8).lerp(new THREE.Color(0x4f86c6), 0.3);
    u.bottom.value.setHex(0x3a4a2c).multiplyScalar(0.3 + 0.7 * Math.min(1, this.sky.g * 1.5));
    const rt = this.pmrem.fromScene(this.envScene, 0, 1, 100);
    this.envRT?.dispose();
    this.envRT = rt;
    this.scene.environment = rt.texture;
  }

  private buildRain() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.rainPos, 3));
    g.setDrawRange(0, 0);
    this.rain = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0xb8cbe0, transparent: true, opacity: 0.55 }));
    this.rain.frustumCulled = false;
    this.scene.add(this.rain);
    for (let i = 0; i < RAIN_DROPS; i++) this.respawnDrop(i, Math.random() * 20);
  }

  private respawnDrop(i: number, y: number) {
    const x = this.target.x + (Math.random() - 0.5) * 60;
    const z = this.target.z + (Math.random() - 0.5) * 60;
    this.rainPos.set([x, y, z, x - 0.12, y - 0.8, z + 0.04], i * 6);
  }

  private updateWeather(dt: number) {
    const w = this.sim.weather;
    this.cloud += (CLOUD[w] - this.cloud) * Math.min(1, dt * 0.35);
    this.rainLevel += (RAIN[w] - this.rainLevel) * Math.min(1, dt * 0.5);
    this.wet += (this.sim.wetness - this.wet) * Math.min(1, dt * 2);
    const winter = this.sim.season === 'winter';
    this.snow += ((winter ? 1 : 0) - this.snow) * Math.min(1, dt * 0.6);
    this.ground.setWetness(winter ? 0 : this.wet);
    const flakes = this.snow > 0.5;
    const rm = this.rain.material as THREE.LineBasicMaterial;
    rm.color.setHex(flakes ? 0xffffff : 0xb8cbe0);
    rm.opacity = flakes ? 0.9 : 0.55;
    const active = Math.floor(RAIN_DROPS * this.rainLevel);
    const p = this.rainPos;
    const fall = (flakes ? 3.5 : 24) * dt;
    for (let i = 0; i < active; i++) {
      const k = i * 6;
      p[k + 1] -= fall; p[k + 4] -= fall;
      const drift = flakes ? Math.sin(this.time * 1.3 + i) * 0.6 * dt : fall * 0.15;
      p[k] -= drift; p[k + 3] -= drift;
      if (flakes) { p[k + 3] = p[k] + 0.09; p[k + 4] = p[k + 1] - 0.09; p[k + 5] = p[k + 2] + 0.05; }
      const far = Math.abs(p[k] - this.target.x) > 32 || Math.abs(p[k + 2] - this.target.z) > 32;
      if (p[k + 4] < 0 || far) {
        if (!flakes && p[k + 4] < 0 && Math.random() < 0.3) {
          this.particles.emit(p[k + 3], 0.05, p[k + 5], 0, 0.6, 0, { color: 0xcfe0f0, life: 0.25, size: [0.05, 0.12], alpha: 0.6, gravity: 4 });
        }
        this.respawnDrop(i, 16 + Math.random() * 6);
      }
    }
    this.rain.geometry.setDrawRange(0, active * 2);
    this.rain.geometry.getAttribute('position').needsUpdate = true;
    // Lightning during storms.
    this.nextBolt -= dt;
    if (w === 'storm' && !flakes && this.nextBolt <= 0) {
      this.flash = 1;
      this.flashEcho = Math.random() < 0.5 ? 0.18 : 0;
      this.nextBolt = 5 + Math.random() * 9;
      setTimeout(() => sfx.thunder(), 500 + Math.random() * 1200);
    }
    // A soft flash that fades out, with at most one short after-flash (no strobing).
    this.flash = Math.max(0, this.flash - dt * 3);
    if (this.flashEcho > 0) {
      this.flashEcho -= dt;
      if (this.flashEcho <= 0) this.flash = Math.max(this.flash, 0.5);
    }
    this.rainAudioT += dt;
    if (this.rainAudioT > 0.5) { this.rainAudioT = 0; setRain(flakes ? 0 : this.rainLevel); }
  }

  private syncTools() {
    for (const [id, view] of this.tViews) {
      if (!this.sim.tools.some(t => t.id === id)) { view.root.removeFromParent(); this.tViews.delete(id); }
    }
    for (const t of this.sim.tools) {
      const holder = t.attachedTo != null ? this.sim.vehicle(t.attachedTo) : undefined;
      const working = holder ? this.sim.toolWorking(t) : false;
      const full = t.kind === 'wagon' || t.kind === 'spreader' ? 1 : this.sim.toolWidth(t.kind);
      const width = working ? full : Math.min(full, FOLDED[t.kind] ?? full);
      let view = this.tViews.get(t.id);
      if (!view || view.width !== width) {
        if (view) { view.root.removeFromParent(); this.pickables.splice(this.pickables.indexOf(view.root), 1); }
        view = buildTool(t.kind, width);
        view.root.userData.toolId = t.id;
        view.root.add(blob(TOOL_LEN[t.kind] + 0.5, width + 0.5, 0.8));
        this.scene.add(view.root);
        this.pickables.push(view.root);
        this.tViews.set(t.id, view);
      }
      const moved = Math.hypot(t.x - view.root.position.x, t.y - view.root.position.z);
      view.root.position.set(t.x, 0, t.y);
      view.root.rotation.y = -t.heading;
      for (const w of view.wheels) w.rotation.z -= moved / w.userData.radius;
      if (view.fill) {
        const f = Math.min(1, t.load.amount / WAGON_CAP[this.sim.upgrades.wagon]);
        view.fill.visible = f > 0.01;
        view.fill.scale.y = Math.max(0.01, f * 0.52);
        view.fill.position.y = 0.45 + view.fill.scale.y / 2;
        if (t.load.crop) (view.fill.material as THREE.MeshLambertMaterial).color.setHex(CROP_DEFS[t.load.crop].color);
      }
    }
  }

  private syncVehicles(dt: number) {
    for (const [id, view] of this.vViews) {
      if (!this.sim.vehicles.some(v => v.id === id)) { view.model.root.removeFromParent(); disposeSprite(view.bubble); this.vViews.delete(id); }
    }
    for (const v of this.sim.vehicles) {
      let view = this.vViews.get(v.id);
      if (!view) {
        const model = v.kind === 'tractor' ? buildTractor()
          : v.kind === 'rootHarvester' ? buildRootHarvester() : buildCombine(this.sim.toolWidth('header'));
        model.root.userData.vehicleId = v.id;
        const bubble = tagSprite('Tank full', 0.9);
        bubble.visible = false;
        this.scene.add(model.root, bubble);
        this.pickables.push(model.root);
        const big = isHarvester(v);
        const shadow = blob(big ? 3.8 : 2.3, big ? 2.8 : 1.7);
        const lights = buildHeadlights(big ? 9 : 7, big ? 2.2 : 0.9);
        model.root.add(shadow, lights);
        view = { model, lx: v.x, ly: v.y, emitT: 0, bubble, pipeAngle: Math.PI * 0.94, lights };
        this.vViews.set(v.id, view);
      }
      const m = view.model;
      const moved = Math.hypot(v.x - view.lx, v.y - view.ly);
      view.lx = v.x;
      view.ly = v.y;
      m.root.position.set(v.x, 0, v.y);
      m.root.rotation.y = -v.heading;
      m.body.position.y = v.moving ? Math.abs(Math.sin(this.time * 22 + v.id)) * 0.015 : 0;
      for (const w of m.wheels) w.rotation.z -= moved / w.userData.radius;
      if (v.kind === 'combine') setHeader(m, this.sim.toolWidth('header'));
      if (isHarvester(v)) {
        if (v.working && m.reel) m.reel.rotation.z -= dt * 5;
        const want = v.unloadingTo != null ? Math.PI / 2 : Math.PI * 0.94;
        view.pipeAngle += (want - view.pipeAngle) * Math.min(1, dt * 3);
        m.pipe!.rotation.y = view.pipeAngle;
      }
      view.bubble.visible = v.waiting;
      view.lights.visible = this.night > 0.45 && (v.moving || v.steps.length > 0 || this.sim.drivenId === v.id);
      view.bubble.position.set(v.x, (isHarvester(v) ? 2.8 : 1.9) + Math.sin(this.time * 5) * 0.1, v.y);
      this.emitVehicleFx(v, view, dt);
    }
  }

  private emitVehicleFx(v: Vehicle, view: VehicleView, dt: number) {
    view.emitT += dt;
    if (view.emitT < 0.045) return;
    view.emitT = 0;
    const P = this.particles;
    const dx = Math.cos(v.heading), dz = Math.sin(v.heading);
    const lx = dz, lz = -dx;
    const rand = (s: number) => (Math.random() - 0.5) * s;
    if (v.working === 'harvest' && v.kind === 'rootHarvester') {
      for (let i = 0; i < 3; i++) {
        const o = rand(2);
        P.emit(v.x + dx * HEADER_OFFSET + lx * o, 0.2, v.y + dz * HEADER_OFFSET + lz * o, rand(0.8), 0.8 + Math.random() * 0.5, rand(0.8),
          { color: 0x6b4a2f, life: 0.9, size: [0.08, 0.2], alpha: 0.9, gravity: 2 });
      }
      P.emit(v.x - dx * 1.2, 0.3, v.y - dz * 1.2, rand(0.5), 0.4, rand(0.5), { color: 0x8a6a48, life: 1.4, size: [0.3, 0.9], alpha: 0.35 });
    } else if (v.working === 'harvest') {
      const w = this.sim.toolWidth('header');
      for (let i = 0; i < 2; i++) {
        const o = rand(w);
        P.emit(v.x + dx * HEADER_OFFSET + lx * o, 0.5, v.y + dz * HEADER_OFFSET + lz * o, rand(0.6), 0.6 + Math.random() * 0.6, rand(0.6),
          { color: 0xf0d27a, life: 0.8, size: [0.08, 0.16], alpha: 0.9, gravity: 1.2 });
      }
      // Straw and chaff blown out the back.
      P.emit(v.x - dx * COMBINE_LEN * 0.55, 0.8, v.y - dz * COMBINE_LEN * 0.55, -dx * 1.5 + rand(1), 0.6, -dz * 1.5 + rand(1),
        { color: 0xe6cf8a, life: 1.2, size: [0.12, 0.4], alpha: 0.7, gravity: 0.4 });
    } else if (v.working) {
      const t = this.sim.toolOf(v);
      if (t) {
        const fx = WORK_FX[v.working];
        const w = this.sim.toolWidth(t.kind);
        const tx = Math.cos(t.heading), tz = Math.sin(t.heading);
        for (let i = 0; i < fx.n; i++) {
          const o = fx.spread ? rand(0.4) : rand(w);
          const bx = t.x - tx * TOOL_LEN[t.kind] * 0.5 + tz * o, bz = t.y - tz * TOOL_LEN[t.kind] * 0.5 - tx * o;
          // Spreaders throw material sideways across their working width.
          const side = fx.spread ? (Math.random() - 0.5) * fx.spread * 2 : rand(0.5);
          P.emit(bx, fx.spread ? 0.35 : 0.18, bz, tz * side - tx * 0.4, fx.up * (0.6 + Math.random() * 0.6), -tx * side - tz * 0.4,
            { color: fx.color, life: fx.life, size: fx.size, alpha: fx.alpha, gravity: fx.spread ? 2.5 : -0.05 });
        }
      }
    } else if (v.moving && Math.random() < 0.35) {
      P.emit(v.x - dx * 0.9, 0.1, v.y - dz * 0.9, rand(0.3), 0.3, rand(0.3), { color: 0xa08a6a, life: 1, size: [0.2, 0.6], alpha: 0.3 });
    }
    if (v.moving && v.kind === 'tractor' && Math.random() < 0.5) {
      P.emit(v.x + dx * 0.58 + lx * 0.14, 1.12, v.y + dz * 0.58 + lz * 0.14, rand(0.1), 0.7, rand(0.1),
        { color: 0x6a6a6a, life: 1.1, size: [0.08, 0.4], alpha: 0.35, gravity: -0.1 });
    }
    // Grain stream from the combine pipe into the wagon.
    if (isHarvester(v) && v.unloadingTo != null && Math.abs(view.pipeAngle - Math.PI / 2) < 0.2) {
      const tip = view.model.pipe!.localToWorld(new THREE.Vector3(1.9, -0.15, 0));
      const crop = this.sim.vehicle(v.unloadingTo) && this.sim.toolOf(this.sim.vehicle(v.unloadingTo)!)?.load.crop;
      for (let i = 0; i < 3; i++) {
        P.emit(tip.x + rand(0.08), tip.y, tip.z + rand(0.08), rand(0.2), -0.5, rand(0.2),
          { color: crop ? CROP_DEFS[crop].color : 0xf2c230, life: 0.45, size: [0.12, 0.1], alpha: 1, gravity: 6 });
      }
    }
    const step = v.steps[0];
    if (step?.t === 'unload') {
      const p = step.dest === 'sell' ? SELL_UNLOAD : SILO_UNLOAD;
      const crop = this.sim.cargoOf(v)?.cargo.crop;
      if (crop) {
        for (let i = 0; i < 3; i++) {
          P.emit(p.x + rand(1), 1 + Math.random() * 0.3, p.y + rand(0.6), rand(0.4), -0.3, rand(0.4),
            { color: CROP_DEFS[crop].color, life: 0.5, size: [0.14, 0.1], alpha: 1, gravity: 5 });
        }
      }
    }
  }

  private updateSelection() {
    const sel = this.host.selectedVehicle != null ? this.sim.vehicle(this.host.selectedVehicle) : undefined;
    this.ring.visible = !!sel;
    this.route.visible = false;
    if (!sel) return;
    const r = (isHarvester(sel) ? 1.8 : 1.2) * (1 + Math.sin(this.time * 6) * 0.05);
    this.ring.scale.setScalar(r);
    this.ring.position.set(sel.x, 0.06, sel.y);
    const target = this.routeTarget(sel);
    if (target && Math.hypot(target.x - sel.x, target.y - sel.y) > 1) {
      this.route.geometry.setFromPoints([new THREE.Vector3(sel.x, 0.1, sel.y), new THREE.Vector3(target.x, 0.1, target.y)]);
      this.route.computeLineDistances();
      this.route.visible = true;
    }
  }

  private routeTarget(v: Vehicle): Pt | null {
    const s = v.steps[0];
    if (!s) return null;
    if (s.t === 'goto') return s;
    if (s.t === 'work' && s.path && s.idx != null && s.path[s.idx]) return s.path[s.idx];
    if (s.t === 'follow') { const c = this.sim.vehicle(s.combineId); return c ? this.sim.unloadSpot(c) : null; }
    return null;
  }

  private moneyPopup(x: number, y: number, amount: number) {
    const pos = amount >= 0;
    const s = textSprite(`${pos ? '+' : '-'}$${Math.round(Math.abs(amount)).toLocaleString()}`, 1, { color: pos ? '#8dff7a' : '#ff8a80' });
    s.position.set(x, 3, y);
    this.scene.add(s);
    this.popups.push({ s, t: 0, base: s.scale.clone() });
  }

  private updatePopups(dt: number) {
    for (const p of this.popups) {
      p.t += dt;
      p.s.position.y += dt * 1.2;
      const k = 0.6 + 0.4 * Math.min(1, p.t / 0.25);
      p.s.scale.set(p.base.x * k, p.base.y * k, 1);
      p.s.material.opacity = p.t < 1.2 ? 1 : Math.max(0, 1 - (p.t - 1.2) / 0.8);
    }
    this.popups = this.popups.filter(p => {
      if (p.t < 2) return true;
      disposeSprite(p.s);
      return false;
    });
  }
}
