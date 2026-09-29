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

/** The map ground, split into chunks so a changed cell only re-uploads one small texture. */
export class Ground {
  readonly group = new THREE.Group();
  private chunks: Chunk[] = [];
  private mats: THREE.MeshLambertMaterial[] = [];
  private wetness = -1;
  private cols = Math.ceil(MAP_W / CHUNK);
  private current = new Int16Array(MAP_W * MAP_H).fill(-1);

  constructor(private tiles: HTMLCanvasElement[], anisotropy: number) {
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
        const mat = new THREE.MeshLambertMaterial({ map: tex });
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
      new THREE.MeshLambertMaterial({ color: 0x5e9c42 }),
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
