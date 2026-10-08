import * as THREE from 'three';
import { clamp, lerp, smoothstep } from '../util';

// Procedural sky dome (gradient atmosphere, sun and moon, drifting clouds, stars), the sun/moon
// directional light with a shadow box that follows the truck, ambient light, fog colour, and an
// image-based-lighting environment map baked from the sky so paint and glass reflect it.

const vert = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p;
}`;

const frag = /* glsl */ `
uniform vec3 sunDir;
uniform vec3 moonDir;
uniform vec3 zenith;
uniform vec3 horizon;
uniform vec3 sunColor;
uniform float sunUp;
uniform float night;
uniform float cloud;
uniform float time;
varying vec3 vDir;

float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = p * 2.03 + vec2(1.7, 9.2); a *= 0.5; }
  return s;
}

void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  vec3 col = mix(horizon, zenith, pow(max(h, 0.0), 0.42));
  if (h < 0.0) col = mix(horizon, horizon * 0.55, clamp(-h * 3.0, 0.0, 1.0));
  float sd = max(dot(d, sunDir), 0.0);
  // Mie forward scattering around the sun and a warm band along the horizon at dusk.
  col += sunColor * (pow(sd, 5.0) * 0.22 + pow(sd, 48.0) * 0.5) * sunUp;
  col += sunColor * pow(1.0 - abs(h), 8.0) * pow(sd, 2.0) * 0.35 * sunUp;
  col += sunColor * smoothstep(0.99935, 0.99965, sd) * 40.0 * sunUp * (1.0 - cloud * 0.8);
  float md = dot(d, moonDir);
  col += vec3(0.85, 0.9, 1.0) * smoothstep(0.99955, 0.99975, md) * 4.0 * night;
  col += vec3(0.18, 0.22, 0.35) * pow(max(md, 0.0), 30.0) * 0.4 * night;
  if (h > 0.0) {
    if (night > 0.01) {
      vec3 sp = d * 220.0;
      vec3 cell = floor(sp);
      float r = hash(cell.xy + cell.z * 17.13);
      float star = step(0.9965, r) * smoothstep(0.42, 0.0, length(fract(sp) - 0.5));
      float tw = 0.6 + 0.4 * sin(time * 3.0 + r * 80.0);
      col += vec3(0.9, 0.95, 1.0) * star * tw * night * 3.0 * (1.0 - cloud) * smoothstep(0.0, 0.2, h);
      // Faint milky way band.
      float band = exp(-pow(dot(d, normalize(vec3(0.3, 0.5, 0.8))) * 4.0, 2.0));
      col += vec3(0.05, 0.06, 0.09) * band * fbm(d.xz * 9.0) * night * (1.0 - cloud);
    }
    vec2 uv = d.xz / (h + 0.08) * 0.8 + vec2(time * 0.004, time * 0.0015);
    float detail = fbm(uv * 3.1 + 7.0);
    float n = fbm(uv) * 0.82 + detail * 0.18;
    float cov = mix(0.6, 0.2, cloud);
    float c = smoothstep(cov, cov + 0.2, n);
    float thick = smoothstep(cov, cov + 0.45, n);
    // March a step towards the sun: less cloud that way means a brightly lit edge.
    vec2 toSun = normalize(sunDir.xz + vec2(1e-4)) * 0.07;
    float n2 = fbm(uv + toSun) * 0.82 + detail * 0.18;
    float lightPath = clamp((n - n2) * 5.0 + 0.55, 0.0, 1.0);
    vec3 bright = sunColor * 1.6 * sunUp + zenith * 0.35 + vec3(0.05, 0.06, 0.09) * night;
    vec3 dark = zenith * 0.4 + horizon * 0.38 + vec3(0.02);
    vec3 lit = mix(dark, bright, clamp(lightPath * (1.0 - thick * 0.6) + 0.2, 0.0, 1.0));
    lit += sunColor * pow(sd, 8.0) * 1.4 * sunUp * (1.0 - thick);
    lit = mix(lit, dark * 0.85, cloud * 0.55);
    col = mix(col, lit, c * smoothstep(0.0, 0.15, h) * 0.97);
  }
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export class Sky {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  readonly sunDir = new THREE.Vector3();
  readonly moonDir = new THREE.Vector3();
  readonly fogColor = new THREE.Color();
  /** 0 = day, 1 = full night. */
  night = 0;
  /** Sine of the sun's elevation. */
  sunElev = 0;
  private envScene = new THREE.Scene();
  private pmrem: THREE.PMREMGenerator | null = null;
  private envRT: THREE.WebGLRenderTarget | null = null;
  private lastEnv = { elev: -9, cloud: -9, t: -99 };

  constructor(private scene: THREE.Scene, shadowSize: number, private shadowRange: number) {
    this.material = new THREE.ShaderMaterial({
      vertexShader: vert, fragmentShader: frag, side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false,
      uniforms: {
        sunDir: { value: new THREE.Vector3(0, 1, 0) }, moonDir: { value: new THREE.Vector3(0, -1, 0) },
        zenith: { value: new THREE.Color() }, horizon: { value: new THREE.Color() }, sunColor: { value: new THREE.Color() },
        sunUp: { value: 1 }, night: { value: 0 }, cloud: { value: 0 }, time: { value: 0 },
      },
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(4000, 48, 24), this.material);
    this.mesh.renderOrder = -1000;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
    this.envScene.add(new THREE.Mesh(this.mesh.geometry, this.material));

    this.sun = new THREE.DirectionalLight(0xffffff, 3);
    this.sun.castShadow = shadowSize > 0;
    this.sun.shadow.mapSize.set(shadowSize, shadowSize);
    const c = this.sun.shadow.camera;
    c.left = -shadowRange; c.right = shadowRange; c.top = shadowRange; c.bottom = -shadowRange;
    c.near = 1; c.far = 600;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.04;
    scene.add(this.sun, this.sun.target);
    this.hemi = new THREE.HemisphereLight(0xbfd8ff, 0x3a3a2a, 0.6);
    scene.add(this.hemi);
  }

  enableEnv(renderer: THREE.WebGLRenderer) {
    this.pmrem = new THREE.PMREMGenerator(renderer);
  }

  /**
   * hours: 0..24. cloud: 0..1. Positions the light around `focus` (the truck).
   */
  update(hours: number, cloud: number, rain: number, time: number, focus: THREE.Vector3, camera: THREE.Camera) {
    // Sun path: rises in the east (+x) at 6:00, peaks at noon in the south, sets at 18:00 in the west.
    const a = ((hours - 6) / 12) * Math.PI;
    const sunE = clamp(Math.sin(a) * 1.05, -1, 1);
    this.sunDir.set(Math.cos(a), sunE * 0.9 + 0.02, 0.45).normalize();
    this.moonDir.set(-this.sunDir.x, -this.sunDir.y, -0.3 + this.sunDir.z * 0.2).normalize();
    const e = this.sunDir.y;
    this.sunElev = e;
    const day = smoothstep(-0.02, 0.32, e);
    const dusk = smoothstep(-0.16, 0.04, e);
    this.night = 1 - smoothstep(-0.18, 0.02, e);

    const nightZ = new THREE.Color(0.0035, 0.006, 0.018), nightH = new THREE.Color(0.016, 0.024, 0.05);
    const duskZ = new THREE.Color(0.16, 0.24, 0.5), duskH = new THREE.Color(1.15, 0.52, 0.24);
    const dayZ = new THREE.Color(0.05, 0.19, 0.62), dayH = new THREE.Color(0.52, 0.7, 0.93);
    const zen = nightZ.clone().lerp(duskZ, dusk).lerp(dayZ, day);
    const hor = nightH.clone().lerp(duskH, dusk).lerp(dayH, day);
    // Overcast skies turn grey and darker.
    const grey = new THREE.Color(0.5, 0.53, 0.57).multiplyScalar(lerp(0.03, 1, smoothstep(-0.12, 0.25, e)));
    const overcast = cloud * 0.75 + rain * 0.2;
    zen.lerp(grey, overcast);
    hor.lerp(grey.clone().multiplyScalar(1.15), overcast * 0.9);
    const sunCol = new THREE.Color(1.0, 0.45, 0.18).lerp(new THREE.Color(1.0, 0.94, 0.86), smoothstep(0.02, 0.4, e));

    const u = this.material.uniforms;
    (u.sunDir.value as THREE.Vector3).copy(this.sunDir);
    (u.moonDir.value as THREE.Vector3).copy(this.moonDir);
    (u.zenith.value as THREE.Color).copy(zen);
    (u.horizon.value as THREE.Color).copy(hor);
    (u.sunColor.value as THREE.Color).copy(sunCol);
    u.sunUp.value = smoothstep(-0.06, 0.04, e);
    u.night.value = this.night;
    u.cloud.value = clamp(cloud + rain * 0.3, 0, 1);
    u.time.value = time;
    this.mesh.position.copy(camera.position);
    this.fogColor.copy(hor).lerp(zen, 0.15);

    // Key light: the sun by day, a cool moon by night.
    const sunI = smoothstep(-0.03, 0.18, e) * 3.4 * (1 - overcast * 0.72);
    const moonI = this.night * 0.32 * (1 - cloud * 0.6);
    const useSun = e > -0.04;
    const dir = useSun ? this.sunDir : this.moonDir;
    this.sun.color.copy(useSun ? sunCol : new THREE.Color(0.62, 0.72, 1.0));
    this.sun.intensity = useSun ? sunI : moonI;
    // Snap the shadow box to its texel grid so shadows don't shimmer as the truck moves.
    const texel = (this.shadowRange * 2) / this.sun.shadow.mapSize.x;
    const fx = Math.round(focus.x / texel) * texel, fz = Math.round(focus.z / texel) * texel;
    this.sun.target.position.set(fx, focus.y, fz);
    this.sun.position.set(fx + dir.x * 300, focus.y + Math.max(0.08, dir.y) * 300, fz + dir.z * 300);
    this.sun.target.updateMatrixWorld();
    this.hemi.color.copy(zen).lerp(hor, 0.5).multiplyScalar(1.0);
    this.hemi.groundColor.setRGB(0.22, 0.2, 0.15).multiplyScalar(lerp(0.05, 1, day));
    this.hemi.intensity = lerp(0.35, 1.0, day) * (this.pmrem ? 0.45 : 1) + overcast * 0.5 * day;
  }

  /** Re-bakes the reflection map when the sky has changed enough to notice. */
  updateEnv(time: number) {
    if (!this.pmrem) return;
    const u = this.material.uniforms;
    const el = this.sunDir.y, cl = u.cloud.value as number;
    if (Math.abs(el - this.lastEnv.elev) < 0.015 && Math.abs(cl - this.lastEnv.cloud) < 0.05 && time - this.lastEnv.t < 20) return;
    this.lastEnv = { elev: el, cloud: cl, t: time };
    const rt = this.pmrem.fromScene(this.envScene, 0.02, 1, 8000);
    this.envRT?.dispose();
    this.envRT = rt;
    this.scene.environment = rt.texture;
    this.scene.environmentIntensity = lerp(0.04, 1.0, smoothstep(-0.12, 0.3, el));
  }
}
