import * as THREE from 'three';
import { isSafeMode } from './quality';

// Glossy paint, chrome and glass without physically based shading: plain Lambert materials with a
// small cube-map reflection mixed in. This is the classic reflection path every mobile GPU runs,
// and safe mode leaves it out entirely.

let cube: THREE.CubeTexture | null = null;
const shiny: { m: THREE.MeshLambertMaterial; base: number }[] = [];
const enabled = !isSafeMode();

/** A soft outdoor "studio": bright sky, a sunny band on the horizon, green-brown ground. */
function envCube() {
  if (cube) return cube;
  const face = (top: string, mid: string, bottom: string, sun = false) => {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d')!;
    const grad = g.createLinearGradient(0, 0, 0, 64);
    grad.addColorStop(0, top);
    grad.addColorStop(0.48, mid);
    grad.addColorStop(0.52, '#8c8a70');
    grad.addColorStop(1, bottom);
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    if (sun) {
      const r = g.createRadialGradient(40, 22, 0, 40, 22, 22);
      r.addColorStop(0, 'rgba(255,250,235,1)');
      r.addColorStop(1, 'rgba(255,250,235,0)');
      g.fillStyle = r;
      g.fillRect(0, 0, 64, 64);
    }
    return c;
  };
  const flat = (color: string) => {
    const c = document.createElement('canvas');
    c.width = c.height = 16;
    const g = c.getContext('2d')!;
    g.fillStyle = color;
    g.fillRect(0, 0, 16, 16);
    return c;
  };
  cube = new THREE.CubeTexture([
    face('#9cc6ea', '#e6eef2', '#4f6a3a', true), face('#9cc6ea', '#dfe8ee', '#4f6a3a'),
    flat('#b8d6f0'), flat('#3f5530'),
    face('#9cc6ea', '#e2ebf0', '#4f6a3a'), face('#9cc6ea', '#dde6ec', '#4f6a3a'),
  ]);
  cube.colorSpace = THREE.SRGBColorSpace;
  cube.needsUpdate = true;
  return cube;
}

const cache = new Map<string, THREE.MeshLambertMaterial>();

function make(key: string, params: THREE.MeshLambertMaterialParameters, reflectivity: number) {
  let m = cache.get(key);
  if (m) return m;
  m = new THREE.MeshLambertMaterial(params);
  if (enabled && reflectivity > 0) {
    m.envMap = envCube();
    m.combine = THREE.MixOperation;
    m.reflectivity = reflectivity;
    shiny.push({ m, base: reflectivity });
  }
  cache.set(key, m);
  return m;
}

/** Glossy body paint. */
export function paint(color: number, gloss = 0.14) {
  return make(`p${color}:${gloss}`, { color }, gloss);
}

/** Polished metal: exhausts, rims, hydraulic rams. */
export function chrome(color = 0xd4d7da) {
  return make(`c${color}`, { color }, 0.55);
}

/** Tinted cab glass that reflects the sky. */
export function glass(tint = 0x2c4450, opacity = 0.62) {
  return make(`g${tint}:${opacity}`, { color: tint, transparent: true, opacity, depthWrite: false }, 0.5);
}

/** Dims reflections at night so machines don't glow in the dark. */
export function setShineLight(day: number) {
  const k = 0.2 + 0.8 * day;
  for (const s of shiny) s.m.reflectivity = s.base * k;
}

/** Adds the reflection to an existing material (e.g. one with a texture). */
export function shineOn<T extends THREE.MeshLambertMaterial>(m: T, reflectivity: number): T {
  if (!enabled) return m;
  m.envMap = envCube();
  m.combine = THREE.MixOperation;
  m.reflectivity = reflectivity;
  shiny.push({ m, base: reflectivity });
  return m;
}
