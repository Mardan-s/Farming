// Flat ground tiles drawn in code. Crops themselves are 3D meshes on top.

export const TILE = 24;

export enum T {
  Grass0, Grass1, Grass2, Grass3, Meadow,
  PlowH, PlowV, SeedH, SeedV, StrawH, StrawV, StalkH, StalkV,
  Gravel, Road, RoadTop, RoadBottom, RolledH, RolledV,
}
const COUNT = T.RolledV + 1;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function tile(draw: (ctx: CanvasRenderingContext2D) => void) {
  const c = document.createElement('canvas');
  c.width = c.height = TILE;
  draw(c.getContext('2d')!);
  return c;
}

function speckle(ctx: CanvasRenderingContext2D, seed: number, n: number, colors: string[], w = 1, h = 2) {
  const r = rng(seed);
  for (let i = 0; i < n; i++) {
    ctx.fillStyle = colors[Math.floor(r() * colors.length)];
    ctx.fillRect(r() * TILE, r() * TILE, w, h + r() * h);
  }
}

/** Soil with furrows every 6px so neighbouring tiles line up. */
function soil(ctx: CanvasRenderingContext2D, vertical: boolean, seed: number) {
  ctx.fillStyle = '#7a5334';
  ctx.fillRect(0, 0, TILE, TILE);
  for (let k = 0; k < TILE; k += 6) {
    ctx.fillStyle = '#5b3d25';
    if (vertical) ctx.fillRect(k + 4, 0, 2, TILE); else ctx.fillRect(0, k + 4, TILE, 2);
    ctx.fillStyle = '#936a47';
    if (vertical) ctx.fillRect(k + 1, 0, 1, TILE); else ctx.fillRect(0, k + 1, TILE, 1);
  }
  speckle(ctx, seed, 12, ['#5b3d25', '#936a47'], 1, 1);
}

function straw(ctx: CanvasRenderingContext2D, vertical: boolean, stalks: boolean) {
  ctx.fillStyle = stalks ? '#b9a06c' : '#d3bf8a';
  ctx.fillRect(0, 0, TILE, TILE);
  speckle(ctx, stalks ? 5 : 6, 30, ['#b89c66', '#e6d6a6', '#a98d5c'], 2, 1);
  const r = rng(9);
  for (let row = 3; row < TILE; row += 6) {
    for (let a = 1; a < TILE; a += 3) {
      ctx.fillStyle = stalks ? '#7e6538' : '#efe2b4';
      const j = (r() - 0.5) * 1.5;
      if (vertical) ctx.fillRect(row + j - 1, a, stalks ? 2 : 1, stalks ? 2 : 2);
      else ctx.fillRect(a, row + j - 1, stalks ? 2 : 2, stalks ? 2 : 1);
    }
  }
}

export function buildTiles(): HTMLCanvasElement[] {
  const tiles: HTMLCanvasElement[] = new Array(COUNT);
  for (let v = 0; v < 4; v++) {
    tiles[T.Grass0 + v] = tile(ctx => {
      ctx.fillStyle = '#65a646';
      ctx.fillRect(0, 0, TILE, TILE);
      speckle(ctx, 100 + v, 30, ['#579539', '#78b755', '#5f9f40', '#83c05f']);
    });
  }
  tiles[T.Meadow] = tile(ctx => {
    ctx.fillStyle = '#76b650';
    ctx.fillRect(0, 0, TILE, TILE);
    speckle(ctx, 999, 34, ['#66a445', '#8bc562', '#9ccd6f', '#6fab49']);
  });
  tiles[T.PlowH] = tile(ctx => soil(ctx, false, 1));
  tiles[T.PlowV] = tile(ctx => soil(ctx, true, 2));
  for (const vertical of [false, true]) {
    tiles[vertical ? T.SeedV : T.SeedH] = tile(ctx => {
      soil(ctx, vertical, 3);
      for (let row = 3; row < TILE; row += 6) {
        for (let a = 1; a < TILE; a += 3) {
          ctx.fillStyle = '#d2b287';
          if (vertical) ctx.fillRect(row, a, 1, 1); else ctx.fillRect(a, row, 1, 1);
        }
      }
    });
    // Rolled: flattened, lighter soil with the seed rows pressed in.
    tiles[vertical ? T.RolledV : T.RolledH] = tile(ctx => {
      ctx.fillStyle = '#8a6443';
      ctx.fillRect(0, 0, TILE, TILE);
      speckle(ctx, 4, 16, ['#7a5536', '#9c7552'], 1, 1);
      for (let k = 0; k < TILE; k += 6) {
        ctx.fillStyle = '#6f4c30';
        if (vertical) ctx.fillRect(k + 3, 0, 1, TILE); else ctx.fillRect(0, k + 3, TILE, 1);
      }
    });
    tiles[vertical ? T.StrawV : T.StrawH] = tile(ctx => straw(ctx, vertical, false));
    tiles[vertical ? T.StalkV : T.StalkH] = tile(ctx => straw(ctx, vertical, true));
  }
  tiles[T.Gravel] = tile(ctx => {
    ctx.fillStyle = '#b1a38a';
    ctx.fillRect(0, 0, TILE, TILE);
    speckle(ctx, 7, 50, ['#a0927a', '#c4b79e', '#948670', '#d0c4ab'], 2, 1);
  });
  const road = (edge: 'top' | 'bottom' | null) => tile(ctx => {
    ctx.fillStyle = '#56595d';
    ctx.fillRect(0, 0, TILE, TILE);
    speckle(ctx, 11, 30, ['#4e5155', '#63676b'], 1, 1);
    ctx.fillStyle = '#ece6d4';
    if (edge === 'top') ctx.fillRect(0, 2, TILE, 2);
    if (edge === 'bottom') ctx.fillRect(0, TILE - 4, TILE, 2);
  });
  tiles[T.Road] = road(null);
  tiles[T.RoadTop] = road('top');
  tiles[T.RoadBottom] = road('bottom');
  return tiles;
}
