import * as THREE from 'three';
import { MAP_H, MAP_W } from '../game/config';
import { TILE } from './groundTiles';

const CHUNK = 16;

interface Chunk {
  x0: number;
  y0: number;
  ctx: CanvasRenderingContext2D;
  tex: THREE.CanvasTexture;
  dirty: boolean;
}

/** Smooth value noise, tiling, used to break up the repeated tiles. */
function noiseTexture() {
  const N = 128;
  const grid = new Float32Array(16 * 16).map(() => Math.random());
  const data = new Uint8Array(N * N * 4);
  const smooth = (t: number) => t * t * (3 - 2 * t);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      let v = 0, amp = 0.5, freq = 1, norm = 0;
      for (let o = 0; o < 4; o++) {
        const gx = (x / N) * 16 * freq, gy = (y / N) * 16 * freq;
        const x0 = Math.floor(gx), y0 = Math.floor(gy);
        const fx = smooth(gx - x0), fy = smooth(gy - y0);
        const g = (i: number, j: number) => grid[((j % 16) + 16) % 16 * 16 + ((i % 16) + 16) % 16];
        const a = g(x0, y0) + (g(x0 + 1, y0) - g(x0, y0)) * fx;
        const b = g(x0, y0 + 1) + (g(x0 + 1, y0 + 1) - g(x0, y0 + 1)) * fx;
        v += (a + (b - a) * fy) * amp;
        norm += amp;
        amp *= 0.5;
        freq *= 2;
      }
      const c = Math.round((v / norm) * 255);
      data.set([c, c, c, 255], (y * N + x) * 4);
    }
  }
  const tex = new THREE.DataTexture(data, N, N);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/** Large patches of lighter/darker ground plus fine grain, in world space. */
function addDetail(mat: THREE.MeshStandardMaterial, noise: THREE.Texture) {
  mat.onBeforeCompile = shader => {
    shader.uniforms.uNoise = { value: noise };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vWorldXZ;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWorldXZ = (modelMatrix * vec4(transformed, 1.0)).xz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D uNoise;\nvarying vec2 vWorldXZ;')
      .replace('#include <map_fragment>', `#include <map_fragment>
        float macro = texture2D(uNoise, vWorldXZ * 0.012).r;
        float mid = texture2D(uNoise, vWorldXZ * 0.06 + 0.37).r;
        float fine = texture2D(uNoise, vWorldXZ * 0.9).r;
        diffuseColor.rgb *= 0.78 + macro * 0.3 + (mid - 0.5) * 0.16 + (fine - 0.5) * 0.12;`);
  };
}

/** The map ground, split into chunks so a changed cell only re-uploads one small texture. */
export class Ground {
  readonly group = new THREE.Group();
  private chunks: Chunk[] = [];
  private mats: THREE.MeshStandardMaterial[] = [];
  private wetness = -1;
  private cols = Math.ceil(MAP_W / CHUNK);
  private current = new Int16Array(MAP_W * MAP_H).fill(-1);

  constructor(private tiles: HTMLCanvasElement[], anisotropy: number, detailed: boolean) {
    const detail = detailed ? noiseTexture() : null;
    const rows = Math.ceil(MAP_H / CHUNK);
    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < this.cols; cx++) {
        const x0 = cx * CHUNK, y0 = cy * CHUNK;
        const w = Math.min(CHUNK, MAP_W - x0), h = Math.min(CHUNK, MAP_H - y0);
        const canvas = document.createElement('canvas');
        canvas.width = w * TILE;
        canvas.height = h * TILE;
        const tex = new THREE.CanvasTexture(canvas);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = anisotropy;
        const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95, metalness: 0 });
        if (detail) addDetail(mat, detail);
        this.mats.push(mat);
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
        mesh.rotation.x = -Math.PI / 2;
        mesh.position.set(x0 + w / 2, 0, y0 + h / 2);
        mesh.receiveShadow = true;
        this.group.add(mesh);
        this.chunks.push({ x0, y0, ctx: canvas.getContext('2d')!, tex, dirty: true });
      }
    }
    // Endless meadow beyond the map edge.
    const outside = new THREE.Mesh(
      new THREE.PlaneGeometry(900, 900),
      new THREE.MeshStandardMaterial({ color: 0x5e9c42, roughness: 1 }),
    );
    outside.rotation.x = -Math.PI / 2;
    outside.position.set(MAP_W / 2, -0.02, MAP_H / 2);
    outside.receiveShadow = true;
    this.group.add(outside);
  }

  set(x: number, y: number, tileId: number) {
    const k = y * MAP_W + x;
    if (this.current[k] === tileId) return;
    this.current[k] = tileId;
    const c = this.chunks[Math.floor(y / CHUNK) * this.cols + Math.floor(x / CHUNK)];
    c.ctx.drawImage(this.tiles[tileId], (x - c.x0) * TILE, (y - c.y0) * TILE);
    c.dirty = true;
  }

  /** Darkens the ground after rain (0 dry .. 1 soaked). */
  setWetness(w: number) {
    const q = Math.round(w * 50) / 50;
    if (q === this.wetness) return;
    this.wetness = q;
    const shade = 1 - 0.3 * q;
    for (const m of this.mats) m.color.setRGB(shade, shade, shade * 1.02);
  }

  /** Uploads changed chunks to the GPU; call once per frame. */
  flush() {
    for (const c of this.chunks) {
      if (!c.dirty) continue;
      c.dirty = false;
      c.tex.needsUpdate = true;
    }
  }
}
