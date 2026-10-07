import type { Game } from '../sim/game';
import type { World } from '../sim/world';

// The sat-nav: a heading-up map around the truck with the route to the destination glowing
// orange, and a full overview map used on the job board.

function hex(c: number) { return '#' + c.toString(16).padStart(6, '0'); }

export class Minimap {
  private ctx: CanvasRenderingContext2D;
  private pts: { x: number; z: number; s: number }[] = [];

  constructor(private canvas: HTMLCanvasElement, private world: World) {
    this.ctx = canvas.getContext('2d')!;
    const r = world.road;
    for (let i = 0; i <= r.n; i += 3) {
      const k = i % r.n;
      this.pts.push({ x: r.px[k], z: r.pz[k], s: i * r.step });
    }
  }

  private fit() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.round(this.canvas.clientWidth * dpr), h = Math.round(this.canvas.clientHeight * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    return { w, h, dpr };
  }

  draw(game: Game) {
    const { w, h, dpr } = this.fit();
    const g = this.ctx, t = game.truck;
    const scale = (0.36 - Math.min(1, Math.abs(t.speed) / 25) * 0.14) * dpr;
    const cx = w / 2, cy = h * 0.62;
    const sn = Math.sin(t.heading), cs = Math.cos(t.heading);
    const P = (x: number, z: number) => {
      const dx = x - t.x, dz = z - t.z;
      const f = dx * sn + dz * cs, r = -dx * cs + dz * sn;
      return [cx + r * scale, cy - f * scale] as const;
    };
    const bg = g.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, '#0e1620'); bg.addColorStop(1, '#0a0f15');
    g.fillStyle = bg; g.fillRect(0, 0, w, h);
    // Lakes and towns for orientation.
    g.fillStyle = 'rgba(40,90,130,0.55)';
    for (const lk of this.world.lakes) { const [x, y] = P(lk.x, lk.z); g.beginPath(); g.arc(x, y, lk.r * scale, 0, 7); g.fill(); }
    g.fillStyle = 'rgba(255,255,255,0.05)';
    for (const d of this.world.depots) { const c = this.world.depotCenter(d); const [x, y] = P(c.x, c.z); g.beginPath(); g.arc(x, y, 230 * scale, 0, 7); g.fill(); }
    const radius = (Math.max(w, h) / scale) * 0.9;
    const near = (p: { x: number; z: number }) => Math.abs(p.x - t.x) < radius && Math.abs(p.z - t.z) < radius;
    const stroke = (filter: (p: { s: number }) => boolean, color: string, width: number) => {
      g.strokeStyle = color; g.lineWidth = width * dpr; g.lineCap = 'round'; g.lineJoin = 'round';
      g.beginPath();
      let pen = false;
      for (const p of this.pts) {
        if (!near(p) || !filter(p)) { pen = false; continue; }
        const [x, y] = P(p.x, p.z);
        if (pen) g.lineTo(x, y); else { g.moveTo(x, y); pen = true; }
      }
      g.stroke();
    };
    stroke(() => true, '#2a3644', 9);
    stroke(() => true, '#45556a', 5);
    if (game.job) {
      const L = this.world.road.length, from = game.roadS, to = this.world.depots[game.job.to].s;
      const ahead = (s: number) => { const d = ((s - from) % L + L) % L; return d <= ((to - from) % L + L) % L; };
      g.shadowColor = 'rgba(255,140,30,0.9)'; g.shadowBlur = 8 * dpr;
      stroke((p) => ahead(p.s), '#ff9a1f', 4.5);
      g.shadowBlur = 0;
    }
    for (const d of this.world.depots) {
      const c = this.world.depotCenter(d);
      const [x, y] = P(c.x, c.z);
      const dest = game.job?.to === d.id;
      g.fillStyle = dest ? '#ffad1f' : hex(d.color);
      g.strokeStyle = '#0a0f15'; g.lineWidth = 2 * dpr;
      g.beginPath(); g.arc(x, y, (dest ? 7 : 5) * dpr, 0, 7); g.fill(); g.stroke();
      if (dest) { g.fillStyle = '#fff'; g.font = `700 ${10 * dpr}px Barlow, sans-serif`; g.textAlign = 'center'; g.fillText(d.name, x, y - 11 * dpr); }
    }
    g.fillStyle = 'rgba(255,255,255,0.6)';
    for (const c of game.traffic.cars) {
      const p = this.world.road.toWorld(c.s, c.lat, tmp);
      if (!near(p)) continue;
      const [x, y] = P(p.x, p.z);
      g.fillRect(x - 1.2 * dpr, y - 1.2 * dpr, 2.4 * dpr, 2.4 * dpr);
    }
    // The truck.
    g.save(); g.translate(cx, cy);
    g.fillStyle = '#ffad1f'; g.strokeStyle = '#1a1205'; g.lineWidth = 2 * dpr;
    g.beginPath(); g.moveTo(0, -11 * dpr); g.lineTo(8 * dpr, 9 * dpr); g.lineTo(0, 4 * dpr); g.lineTo(-8 * dpr, 9 * dpr); g.closePath();
    g.fill(); g.stroke(); g.restore();
  }

  /** Whole-map overview, optionally previewing a route from one depot to another. */
  static drawFull(canvas: HTMLCanvasElement, world: World, game: Game, route?: { from: number; to: number }) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(canvas.clientWidth * dpr); canvas.height = Math.round(canvas.clientHeight * dpr);
    const g = canvas.getContext('2d')!;
    const w = canvas.width, h = canvas.height;
    const r = world.road;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < r.n; i++) { minX = Math.min(minX, r.px[i]); maxX = Math.max(maxX, r.px[i]); minZ = Math.min(minZ, r.pz[i]); maxZ = Math.max(maxZ, r.pz[i]); }
    const sc = Math.min((w * 0.86) / (maxX - minX), (h * 0.8) / (maxZ - minZ));
    const P = (x: number, z: number) => [w / 2 + (x - (minX + maxX) / 2) * sc, h / 2 + (z - (minZ + maxZ) / 2) * sc] as const;
    g.fillStyle = '#0b1118'; g.fillRect(0, 0, w, h);
    g.fillStyle = 'rgba(40,90,130,0.5)';
    for (const lk of world.lakes) { const [x, y] = P(lk.x, lk.z); g.beginPath(); g.arc(x, y, lk.r * sc, 0, 7); g.fill(); }
    const line = (from: number, len: number, color: string, width: number) => {
      g.strokeStyle = color; g.lineWidth = width * dpr; g.lineCap = 'round'; g.lineJoin = 'round';
      g.beginPath();
      for (let d = 0; d <= len; d += 12) { const p = r.sample(from + d, tmp2); const [x, y] = P(p.x, p.z); if (d === 0) g.moveTo(x, y); else g.lineTo(x, y); }
      g.stroke();
    };
    line(0, r.length, '#2f3b4a', 7);
    if (route) {
      const a = world.depots[route.from].s, b = world.depots[route.to].s;
      g.shadowColor = 'rgba(255,140,30,0.9)'; g.shadowBlur = 10 * dpr;
      line(a, r.ahead(a, b), '#ff9a1f', 4);
      g.shadowBlur = 0;
    }
    g.textAlign = 'center';
    for (const d of world.depots) {
      const c = world.depotCenter(d);
      const [x, y] = P(c.x, c.z);
      const hl = route && (route.to === d.id || route.from === d.id);
      g.fillStyle = hl ? '#ffad1f' : hex(d.color);
      g.beginPath(); g.arc(x, y, (hl ? 6 : 4.5) * dpr, 0, 7); g.fill();
      g.fillStyle = hl ? '#fff' : '#9aa8b8';
      g.font = `${hl ? 700 : 500} ${11 * dpr}px Barlow, sans-serif`;
      g.fillText(d.name, x, y - 9 * dpr);
    }
    const [tx, ty] = P(game.truck.x, game.truck.z);
    g.fillStyle = '#fff'; g.beginPath(); g.arc(tx, ty, 3.5 * dpr, 0, 7); g.fill();
  }
}

const tmp = { x: 0, y: 0, z: 0 };
const tmp2 = { x: 0, y: 0, z: 0, tx: 0, tz: 1 };
