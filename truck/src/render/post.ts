import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';

// HDR post-processing: bloom on lamps and the sun, then a cinematic grade with lens flare,
// subtle chromatic aberration at the edges, vignette and film grain.

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uTime: { value: 0 },
    uAspect: { value: 1 },
    uSun: { value: new THREE.Vector2(0.5, 0.5) },
    uSunAmt: { value: 0 },
    uSunCol: { value: new THREE.Color(1, 0.8, 0.6) },
    uVignette: { value: 0.32 },
    uCA: { value: 0.0007 },
    uGrain: { value: 0.035 },
    uSat: { value: 1.08 },
    uWet: { value: 0 },
    uRays: { value: 0 },
  },
  vertexShader: /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
uniform sampler2D tDiffuse;
uniform float uTime, uAspect, uSunAmt, uVignette, uCA, uGrain, uSat, uWet, uRays;
uniform vec2 uSun;
uniform vec3 uSunCol;
varying vec2 vUv;
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
float disc(vec2 p, vec2 c, float r, float soft) {
  vec2 d = p - c; d.x *= uAspect;
  return smoothstep(r, r * soft, length(d));
}
void main() {
  vec2 cuv = vUv - 0.5;
  float r2 = dot(cuv, cuv);
  vec2 off = cuv * r2 * uCA * 8.0;
  vec3 col;
  col.r = texture2D(tDiffuse, vUv + off).r;
  col.g = texture2D(tDiffuse, vUv).g;
  col.b = texture2D(tDiffuse, vUv - off).b;
  // Lens flare: ghosts mirrored through the centre, a halo ring and an anamorphic streak.
  if (uSunAmt > 0.001) {
    vec2 axis = vec2(0.5) - uSun;
    vec3 fl = vec3(0.0);
    fl += vec3(1.0, 0.55, 0.25) * disc(vUv, uSun + axis * 0.55, 0.035, 0.2) * 0.22;
    fl += vec3(0.4, 0.8, 1.0) * disc(vUv, uSun + axis * 0.95, 0.07, 0.6) * 0.12;
    fl += vec3(0.7, 1.0, 0.6) * disc(vUv, uSun + axis * 1.35, 0.025, 0.1) * 0.25;
    fl += vec3(1.0, 0.6, 0.9) * disc(vUv, uSun + axis * 1.7, 0.11, 0.85) * 0.08;
    vec2 d = vUv - uSun; d.x *= uAspect;
    float ring = smoothstep(0.02, 0.0, abs(length(d) - 0.32)) * 0.06;
    float streak = exp(-abs(d.y) * 260.0) * exp(-abs(d.x) * 2.2) * 0.5;
    float glare = exp(-length(d) * 7.0) * 0.35;
    fl += vec3(0.6, 0.75, 1.0) * ring + vec3(0.75, 0.85, 1.0) * streak + uSunCol * glare;
    col += fl * uSunAmt;
  }
  // God rays: march towards the sun and gather the bright sky showing between trees and peaks.
  if (uRays > 0.0 && uSunAmt > 0.001) {
    vec2 stepV = (uSun - vUv) / 22.0;
    vec2 p = vUv;
    float acc = 0.0, w = 1.0;
    for (int i = 0; i < 22; i++) {
      p += stepV;
      vec3 s = texture2D(tDiffuse, clamp(p, 0.0, 1.0)).rgb;
      acc += max(0.0, dot(s, vec3(0.3, 0.55, 0.15)) - 0.7) * w;
      w *= 0.93;
    }
    col += uSunCol * acc * 0.12 * uRays * uSunAmt;
  }
  // Grade: gentle S-curve and saturation.
  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(l), col, uSat - uWet * 0.15);
  col = col * col * (3.0 - 2.0 * col) * 0.35 + col * 0.65;
  // Vignette and film grain.
  vec2 v = cuv; v.x *= uAspect * 0.8;
  col *= mix(1.0, smoothstep(0.95, 0.2, length(v)), uVignette);
  col += (hash(vUv * 1000.0 + fract(uTime) * 61.0) - 0.5) * uGrain;
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`,
};

export class Post {
  readonly composer: EffectComposer;
  readonly bloom: UnrealBloomPass;
  readonly grade: ShaderPass;
  private renderPass: RenderPass;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, msaa: number) {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const rt = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: msaa });
    this.composer = new EffectComposer(renderer, rt);
    this.renderPass = new RenderPass(scene, camera);
    this.composer.addPass(this.renderPass);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), 0.4, 0.55, 0.92);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.grade = new ShaderPass(GradeShader);
    this.composer.addPass(this.grade);
  }

  rays = 0;

  setCamera(camera: THREE.Camera) { this.renderPass.camera = camera; }

  setSize(w: number, h: number, pixelRatio: number) {
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(w, h);
    this.grade.uniforms.uAspect.value = w / h;
  }

  render(time: number, night: number, sunScreen: THREE.Vector2 | null, sunAmt: number, sunCol: THREE.Color, wet: number) {
    this.bloom.strength = 0.3 + night * 0.3;
    this.bloom.threshold = night > 0.5 ? 0.85 : 0.95;
    const u = this.grade.uniforms;
    u.uTime.value = time;
    u.uSunAmt.value = sunScreen ? sunAmt : 0;
    if (sunScreen) (u.uSun.value as THREE.Vector2).copy(sunScreen);
    (u.uSunCol.value as THREE.Color).copy(sunCol);
    u.uWet.value = wet;
    u.uRays.value = this.rays;
    u.uGrain.value = 0.025 + night * 0.03;
    this.composer.render();
  }
}
