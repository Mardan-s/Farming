import * as THREE from 'three';

const N = 1200;

/** One draw call for all dust, chaff, exhaust and grain particles. */
export class Particles {
  readonly points: THREE.Points;
  private pos = new Float32Array(N * 3);
  private vel = new Float32Array(N * 3);
  private col = new Float32Array(N * 3);
  private alpha = new Float32Array(N);
  private size = new Float32Array(N);
  private life = new Float32Array(N);
  private maxLife = new Float32Array(N).fill(1);
  private s0 = new Float32Array(N);
  private s1 = new Float32Array(N);
  private a0 = new Float32Array(N);
  private grav = new Float32Array(N);
  private next = 0;
  private c = new THREE.Color();
  readonly uniforms = { uScale: { value: 400 } };

  constructor() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    g.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1));
    g.setAttribute('size', new THREE.BufferAttribute(this.size, 1));
    const m = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      vertexShader: `
        attribute float alpha; attribute float size; attribute vec3 color;
        uniform float uScale; varying float vA; varying vec3 vC;
        void main() {
          vA = alpha; vC = color;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = size * uScale / -mv.z;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        varying float vA; varying vec3 vC;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          if (d > 0.5) discard;
          gl_FragColor = vec4(vC, vA * (1.0 - d * 2.0));
        }`,
    });
    this.points = new THREE.Points(g, m);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
  }

  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number,
    opts: { color: number; life: number; size: [number, number]; alpha: number; gravity?: number }) {
    const i = this.next;
    this.next = (this.next + 1) % N;
    this.pos.set([x, y, z], i * 3);
    this.vel.set([vx, vy, vz], i * 3);
    this.c.setHex(opts.color);
    this.col.set([this.c.r, this.c.g, this.c.b], i * 3);
    this.life[i] = this.maxLife[i] = opts.life;
    this.s0[i] = opts.size[0];
    this.s1[i] = opts.size[1];
    this.a0[i] = opts.alpha;
    this.grav[i] = opts.gravity ?? 0;
  }

  update(dt: number) {
    for (let i = 0; i < N; i++) {
      if (this.life[i] <= 0) { this.alpha[i] = 0; continue; }
      this.life[i] -= dt;
      const t = 1 - Math.max(0, this.life[i]) / this.maxLife[i];
      this.vel[i * 3 + 1] -= this.grav[i] * dt;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.size[i] = this.s0[i] + (this.s1[i] - this.s0[i]) * t;
      this.alpha[i] = this.a0[i] * (1 - t);
    }
    const g = this.points.geometry;
    for (const name of ['position', 'color', 'alpha', 'size']) g.getAttribute(name).needsUpdate = true;
  }
}
