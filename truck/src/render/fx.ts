import * as THREE from 'three';
import { radial, smokeSprite } from './textures';

// Particle effects: exhaust smoke, road spray in the rain, sparks when scraping barriers,
// and rain streaks around the camera.

const pVert = /* glsl */ `
attribute float aSize;
attribute float aAlpha;
varying float vAlpha;
uniform float uScale;
void main() {
  vAlpha = aAlpha;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * uScale / max(0.5, -mv.z);
  gl_Position = projectionMatrix * mv;
}`;
const pFrag = /* glsl */ `
uniform sampler2D uMap;
uniform vec3 uColor;
varying float vAlpha;
void main() {
  vec4 t = texture2D(uMap, gl_PointCoord);
  gl_FragColor = vec4(uColor * t.rgb, t.a * vAlpha);
  #include <colorspace_fragment>
}`;

export class Particles {
  readonly points: THREE.Points;
  private pos: Float32Array;
  private vel: Float32Array;
  private size: Float32Array;
  private alpha: Float32Array;
  private age: Float32Array;
  private life: Float32Array;
  private grow: Float32Array;
  private a0: Float32Array;
  private next = 0;
  readonly material: THREE.ShaderMaterial;

  constructor(private count: number, map: THREE.Texture, color: THREE.Color, additive: boolean, private drag = 0.6, private gravity = 0) {
    this.pos = new Float32Array(count * 3);
    this.vel = new Float32Array(count * 3);
    this.size = new Float32Array(count);
    this.alpha = new Float32Array(count);
    this.age = new Float32Array(count).fill(1e9);
    this.life = new Float32Array(count).fill(1);
    this.grow = new Float32Array(count);
    this.a0 = new Float32Array(count);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    this.material = new THREE.ShaderMaterial({
      vertexShader: pVert, fragmentShader: pFrag, transparent: true, depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      uniforms: { uMap: { value: map }, uColor: { value: color }, uScale: { value: 400 } },
    });
    this.points = new THREE.Points(g, this.material);
    this.points.frustumCulled = false;
  }

  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, size: number, grow: number, life: number, alpha: number) {
    const i = this.next;
    this.next = (this.next + 1) % this.count;
    this.pos.set([x, y, z], i * 3);
    this.vel.set([vx, vy, vz], i * 3);
    this.size[i] = size;
    this.grow[i] = grow;
    this.age[i] = 0;
    this.life[i] = life;
    this.a0[i] = alpha;
    this.alpha[i] = alpha;
  }

  update(dt: number, wind: THREE.Vector3) {
    const k = Math.exp(-this.drag * dt);
    for (let i = 0; i < this.count; i++) {
      if (this.age[i] > this.life[i]) { this.alpha[i] = 0; continue; }
      this.age[i] += dt;
      const t = this.age[i] / this.life[i];
      const j = i * 3;
      this.vel[j] = this.vel[j] * k + wind.x * (1 - k);
      this.vel[j + 1] = this.vel[j + 1] * k - this.gravity * dt;
      this.vel[j + 2] = this.vel[j + 2] * k + wind.z * (1 - k);
      this.pos[j] += this.vel[j] * dt;
      this.pos[j + 1] += this.vel[j + 1] * dt;
      this.pos[j + 2] += this.vel[j + 2] * dt;
      this.size[i] += this.grow[i] * dt;
      this.alpha[i] = this.a0[i] * (1 - t) * Math.min(1, t * 8);
    }
    const g = this.points.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.aSize.needsUpdate = true;
    g.attributes.aAlpha.needsUpdate = true;
  }

  setViewport(heightPx: number, fov: number) {
    this.material.uniforms.uScale.value = heightPx / (2 * Math.tan((fov * Math.PI) / 360));
  }
}

const rainVert = /* glsl */ `
attribute float aEnd;
uniform vec3 uCam;
uniform float uTime;
uniform vec3 uFall;
varying float vA;
void main() {
  vec3 box = vec3(70.0, 36.0, 70.0);
  vec3 p = position;
  p.y = mod(p.y - uTime * 13.0, box.y);
  p.x = mod(p.x - uCam.x + uTime * uFall.x * 0.0, box.x) - box.x * 0.5 + uCam.x;
  p.z = mod(p.z - uCam.z, box.z) - box.z * 0.5 + uCam.z;
  p.y += uCam.y - box.y * 0.45;
  p += uFall * aEnd * 0.045;
  vA = 1.0 - aEnd * 0.7;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`;
const rainFrag = /* glsl */ `
uniform vec3 uColor;
uniform float uAmount;
varying float vA;
void main() { gl_FragColor = vec4(uColor, 0.32 * vA * uAmount); }`;

export class Rain {
  readonly lines: THREE.LineSegments;
  readonly material: THREE.ShaderMaterial;

  constructor(count = 3000) {
    const pos = new Float32Array(count * 6), end = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      const x = Math.random() * 70, y = Math.random() * 36, z = Math.random() * 70;
      pos.set([x, y, z, x, y, z], i * 6);
      end[i * 2 + 1] = 1;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aEnd', new THREE.BufferAttribute(end, 1));
    this.material = new THREE.ShaderMaterial({
      vertexShader: rainVert, fragmentShader: rainFrag, transparent: true, depthWrite: false,
      uniforms: { uCam: { value: new THREE.Vector3() }, uTime: { value: 0 }, uFall: { value: new THREE.Vector3(0, -13, 0) }, uColor: { value: new THREE.Color(0.7, 0.75, 0.8) }, uAmount: { value: 0 } },
    });
    this.lines = new THREE.LineSegments(g, this.material);
    this.lines.frustumCulled = false;
    this.lines.visible = false;
  }

  update(time: number, cam: THREE.Vector3, amount: number, relWind: THREE.Vector3, brightness: number) {
    this.lines.visible = amount > 0.02;
    const u = this.material.uniforms;
    (u.uCam.value as THREE.Vector3).copy(cam);
    u.uTime.value = time;
    u.uAmount.value = amount;
    (u.uFall.value as THREE.Vector3).set(-relWind.x * 0.6, -13, -relWind.z * 0.6);
    (u.uColor.value as THREE.Color).setScalar(0.25 + brightness * 0.55);
  }
}

export function makeFx() {
  const smoke = new Particles(260, smokeSprite(), new THREE.Color(0.32, 0.32, 0.33), false, 0.9, -0.6);
  const spray = new Particles(400, smokeSprite(), new THREE.Color(0.75, 0.78, 0.8), false, 1.6, 1.5);
  const sparks = new Particles(220, radial('rgba(255,200,120,1)'), new THREE.Color(3, 1.6, 0.6), true, 0.4, 9.8);
  return { smoke, spray, sparks };
}
