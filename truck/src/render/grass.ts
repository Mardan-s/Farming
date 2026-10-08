import * as THREE from 'three';
import { CARRIAGE_OUT } from '../sim/road';
import { TERRAIN_CELL, TERRAIN_HALF, TERRAIN_RES, World } from '../sim/world';
import { mulberry32 } from '../util';
import { withCloudShadows } from './cloudShadows';

// A carpet of grass tufts that follows the camera. Instances live on a fixed world grid that
// wraps around the camera, so blades never slide or pop as you drive. The vertex shader lifts
// each tuft onto the terrain (height map texture), hides it on roads, yards, fields and water
// (mask texture), tints it like the ground beneath (colour texture) and sways it in the wind.

export class Grass {
  readonly mesh: THREE.Mesh;
  private uniforms: Record<string, THREE.IUniform>;

  constructor(world: World, count: number, tint: (x: number, z: number, out: THREE.Color) => THREE.Color, crops = false) {
    const R = Math.sqrt(count * (crops ? 0.5 : 0.22)) / 2;
    const rnd = mulberry32(crops ? 23 : 21);
    const pos: number[] = [], col: number[] = [], nor: number[] = [];
    // Crops: a clump of tall stalks with heavier, brighter heads.
    if (crops) for (let b = 0; b < 8; b++) {
      const a = rnd() * Math.PI * 2, r = rnd() * 0.22, h = 0.75 + rnd() * 0.35, w = 0.03;
      const cx = Math.cos(a) * r, cz = Math.sin(a) * r, lean = 0.04 + rnd() * 0.08;
      const px = -Math.sin(a) * w, pz = Math.cos(a) * w;
      // Stalk, then a fatter ear on top.
      pos.push(cx - px, 0, cz - pz, cx + px, 0, cz + pz, cx + Math.cos(a) * lean * 0.7, h * 0.78, cz + Math.sin(a) * lean * 0.7);
      col.push(0.45, 0.45, 0.4, 0.45, 0.45, 0.4, 0.95, 0.95, 0.9);
      const ex = cx + Math.cos(a) * lean * 0.7, ez = cz + Math.sin(a) * lean * 0.7;
      pos.push(ex - px * 2.2, h * 0.7, ez - pz * 2.2, ex + px * 2.2, h * 0.7, ez + pz * 2.2, cx + Math.cos(a) * lean, h, cz + Math.sin(a) * lean);
      col.push(1.05, 1.05, 1, 1.05, 1.05, 1, 1.35, 1.3, 1.15);
      for (let k = 0; k < 6; k++) nor.push(0, 1, 0);
    }
    // Grass: nine slim blades fanned around the centre.
    if (!crops) for (let b = 0; b < 9; b++) {
      const a = (b / 9) * Math.PI * 2 + rnd() * 0.6;
      const r = 0.04 + rnd() * 0.2, h = 0.3 + rnd() * 0.42, w = 0.05 + rnd() * 0.035;
      const cx = Math.cos(a) * r, cz = Math.sin(a) * r;
      const lean = 0.08 + rnd() * 0.18;
      const px = -Math.sin(a) * w, pz = Math.cos(a) * w;
      pos.push(cx - px, 0, cz - pz, cx + px, 0, cz + pz, cx + Math.cos(a) * lean, h, cz + Math.sin(a) * lean);
      const tip = 0.9 + rnd() * 0.6, dry = rnd() < 0.2 ? 1.35 : 1;
      col.push(0.3, 0.32, 0.26, 0.3, 0.32, 0.26, tip * dry * 1.1, tip, tip * 0.75);
      for (let k = 0; k < 3; k++) nor.push(0, 1, 0);
    }
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    const off = new Float32Array(count * 3);
    const side = Math.ceil(Math.sqrt(count)), step = (R * 2) / side;
    for (let i = 0; i < count; i++) {
      const gx = i % side, gz = Math.floor(i / side);
      off[i * 3] = (gx + rnd()) * step;
      off[i * 3 + 1] = (gz + rnd()) * step;
      off[i * 3 + 2] = rnd();
    }
    geo.setAttribute('aOffset', new THREE.InstancedBufferAttribute(off, 3));
    geo.instanceCount = count;

    this.uniforms = {
      uCam: { value: new THREE.Vector2() }, uR: { value: R }, uTime: { value: 0 }, uWind: { value: 1 },
      uHeight: { value: heightTexture(world) }, uMask: { value: crops ? fieldMask(world) : maskTexture(world) }, uTint: { value: tintTexture(tint) },
      uHalf: { value: TERRAIN_HALF }, uCell: { value: TERRAIN_CELL }, uRes: { value: TERRAIN_RES + 1 },
    };
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0, side: THREE.DoubleSide });
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, this.uniforms);
      sh.vertexShader = `
attribute vec3 aOffset;
uniform vec2 uCam;
uniform float uR, uTime, uWind, uHalf, uCell, uRes;
uniform sampler2D uHeight, uMask, uTint;
varying vec3 vTint;
` + sh.vertexShader.replace('#include <begin_vertex>', `
vec3 transformed = vec3(position);
vec2 wp = mod(aOffset.xy - uCam + uR, 2.0 * uR) - uR + uCam;
vec2 tuv = (wp + uHalf) / (2.0 * uHalf);
float mask = texture2D(uMask, tuv).r;
float fade = smoothstep(1.0, 0.45, length(wp - uCam) / uR);
float s = mask * fade * (0.65 + aOffset.z * 0.7);
float a = aOffset.z * 6.2831;
transformed.xz = mat2(cos(a), -sin(a), sin(a), cos(a)) * transformed.xz;
transformed *= s;
float sway = sin(uTime * 1.9 + wp.x * 0.27 + wp.y * 0.19) * 0.6 + sin(uTime * 3.3 + wp.x * 0.7) * 0.25 + sin(uTime * 1.1 + wp.x * 0.06 + wp.y * 0.045) * 0.8;
transformed.x += sway * 0.18 * uWind * transformed.y;
transformed.z += cos(uTime * 1.4 + wp.y * 0.3) * 0.1 * uWind * transformed.y;
vec2 huv = ((wp + uHalf) / uCell + 0.5) / uRes;
float hgt = texture2D(uHeight, huv).r;
transformed += vec3(wp.x, hgt - 0.04, wp.y);
vTint = texture2D(uTint, tuv).rgb;
`);
      sh.fragmentShader = 'varying vec3 vTint;\n' + sh.fragmentShader.replace('#include <color_fragment>', '#include <color_fragment>\n  diffuseColor.rgb *= vTint * 0.4;');
    };
    withCloudShadows(mat);
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
  }

  /** Centres the carpet a little ahead of the camera, where the eye is looking. */
  update(cam: THREE.Camera, time: number, wind: number) {
    cam.getWorldDirection(fwd);
    const lead = (this.uniforms.uR.value as number) * 0.55;
    const l = Math.hypot(fwd.x, fwd.z) || 1;
    (this.uniforms.uCam.value as THREE.Vector2).set(cam.position.x + (fwd.x / l) * lead, cam.position.z + (fwd.z / l) * lead);
    this.uniforms.uTime.value = time;
    this.uniforms.uWind.value = wind;
  }
}

const fwd = new THREE.Vector3();

/** White where a standing crop grows (not on ploughed or harvested fields). */
function fieldMask(world: World) {
  const S = 1024, k = S / (TERRAIN_HALF * 2);
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d')!;
  g.fillStyle = '#000';
  g.fillRect(0, 0, S, S);
  for (const f of world.fields) {
    if (f.kind === 'plowed' || f.kind === 'stubble') continue;
    g.fillStyle = f.kind === 'green' ? '#777' : '#fff';
    const x0 = (f.i0 * TERRAIN_CELL) * k, z0 = (f.j0 * TERRAIN_CELL) * k;
    g.fillRect(x0 + 2, z0 + 2, (f.i1 - f.i0) * TERRAIN_CELL * k - 4, (f.j1 - f.j0) * TERRAIN_CELL * k - 4);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  t.flipY = false;
  t.minFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  return t;
}

function heightTexture(world: World) {
  const n = TERRAIN_RES + 1;
  const data = new Uint16Array(n * n);
  for (let i = 0; i < n * n; i++) data[i] = THREE.DataUtils.toHalfFloat(world.heights[i]);
  const t = new THREE.DataTexture(data, n, n, THREE.RedFormat, THREE.HalfFloatType);
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

/** White where grass grows, black on asphalt, yards, fields, water and under buildings. */
function maskTexture(world: World) {
  const S = 1024, k = S / (TERRAIN_HALF * 2);
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d')!;
  const X = (x: number) => (x + TERRAIN_HALF) * k;
  g.fillStyle = '#fff';
  g.fillRect(0, 0, S, S);
  g.fillStyle = '#000';
  g.strokeStyle = '#000';
  const r = world.road;
  g.lineWidth = (CARRIAGE_OUT + 1.2) * 2 * k;
  g.lineJoin = 'round';
  g.beginPath();
  for (let i = 0; i <= r.n; i++) { const j = i % r.n; if (i === 0) g.moveTo(X(r.px[j]), X(r.pz[j])); else g.lineTo(X(r.px[j]), X(r.pz[j])); }
  g.stroke();
  const p = { x: 0, y: 0, z: 0 };
  for (const d of world.depots) {
    g.beginPath();
    const pts: [number, number][] = [];
    for (let s = -d.sHalf - 4; s <= d.sHalf + 4; s += 8) pts.push([s, CARRIAGE_OUT]);
    for (let s = d.sHalf + 4; s >= -d.sHalf - 4; s -= 8) pts.push([s, CARRIAGE_OUT + d.depth + 3]);
    pts.forEach(([s, lat], i) => { r.toWorld(d.s + s, lat, p); if (i === 0) g.moveTo(X(p.x), X(p.z)); else g.lineTo(X(p.x), X(p.z)); });
    g.closePath();
    g.fill();
  }
  for (const f of world.fields) {
    const x0 = -TERRAIN_HALF + f.i0 * TERRAIN_CELL, z0 = -TERRAIN_HALF + f.j0 * TERRAIN_CELL;
    g.fillRect(X(x0), X(z0), (f.i1 - f.i0) * TERRAIN_CELL * k, (f.j1 - f.j0) * TERRAIN_CELL * k);
  }
  for (const lk of world.lakes) { g.beginPath(); g.arc(X(lk.x), X(lk.z), lk.r * 1.25 * k, 0, 7); g.fill(); }
  const rv = world.river;
  g.lineWidth = 60 * k;
  g.beginPath(); g.moveTo(X(rv.x0), X(rv.z0)); g.lineTo(X(rv.x1), X(rv.z1)); g.stroke();
  for (const b of world.buildings) {
    g.save(); g.translate(X(b.x), X(b.z)); g.rotate(-b.rot);
    g.fillRect((-b.w / 2 - 1) * k, (-b.d / 2 - 1) * k, (b.w + 2) * k, (b.d + 2) * k);
    g.restore();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  t.flipY = false;
  t.minFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  return t;
}

function tintTexture(tint: (x: number, z: number, out: THREE.Color) => THREE.Color) {
  const S = 192;
  const data = new Uint8Array(S * S * 4);
  const c = new THREE.Color();
  for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
    const x = -TERRAIN_HALF + ((i + 0.5) / S) * TERRAIN_HALF * 2, z = -TERRAIN_HALF + ((j + 0.5) / S) * TERRAIN_HALF * 2;
    tint(x, z, c);
    const k = (j * S + i) * 4;
    // Stored x4 so dark linear greens keep precision in 8 bits.
    data[k] = Math.min(255, c.r * 4 * 255); data[k + 1] = Math.min(255, c.g * 4 * 255); data[k + 2] = Math.min(255, c.b * 4 * 255); data[k + 3] = 255;
  }
  const t = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}
