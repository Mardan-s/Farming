import { describe, expect, it } from 'vitest';
import { MINUTES_PER_DAY } from '../src/game/config';
import { planPasses } from '../src/game/coverage';
import { CellState } from '../src/game/field';
import { isSimplePolygon, rasterize } from '../src/game/geometry';
import { Game } from '../src/game/sim';

const SQUARE = [{ x: 16, y: 45 }, { x: 28, y: 45 }, { x: 28, y: 55 }, { x: 16, y: 55 }];

function run(game: Game, seconds: number, until?: () => boolean) {
  for (let t = 0; t < seconds; t += 0.05) {
    game.update(0.05);
    if (until?.()) return true;
  }
  return false;
}

describe('geometry', () => {
  it('rasterizes a square outline into its cells', () => {
    expect(rasterize(SQUARE)).toHaveLength(12 * 10);
  });

  it('rejects self-intersecting outlines', () => {
    const bowtie = [{ x: 0, y: 0 }, { x: 4, y: 4 }, { x: 4, y: 0 }, { x: 0, y: 4 }];
    expect(isSimplePolygon(bowtie)).toBe(false);
    expect(isSimplePolygon(SQUARE)).toBe(true);
  });
});

describe('coverage planner', () => {
  it('covers every band of a field with alternating passes', () => {
    const cells = rasterize(SQUARE);
    const passes = planPasses(cells, 'h', 3, { x: 0, y: 0 });
    expect(passes).toHaveLength(4); // 10 rows / width 3
    expect(passes[0].from.x).toBeLessThan(passes[0].to.x);
    expect(passes[1].from.x).toBeGreaterThan(passes[1].to.x);
  });
});

describe('field validation', () => {
  it('only allows fields on owned, open land', () => {
    const game = new Game();
    expect(game.createField([{ x: 40, y: 45 }, { x: 50, y: 45 }, { x: 50, y: 55 }, { x: 40, y: 55 }])).toMatch(/own/);
    expect(game.createField([{ x: 5, y: 45 }, { x: 15, y: 45 }, { x: 15, y: 50 }, { x: 5, y: 50 }])).toMatch(/farmyard/);
    expect(game.createField(SQUARE)).toBeNull();
    expect(game.createField([{ x: 20, y: 50 }, { x: 30, y: 50 }, { x: 30, y: 60 }, { x: 20, y: 60 }])).toMatch(/another field/);
  });
});

describe('full farming loop', () => {
  it('plows, seeds, grows, harvests, hauls and sells', () => {
    const game = new Game();
    const tractor = game.vehicles.find(v => v.kind === 'tractor')!;
    const combine = game.vehicles.find(v => v.kind === 'combine')!;
    expect(game.createField(SQUARE)).toBeNull();
    const field = [...game.world.fields.values()][0];

    expect(game.orderFieldOp(tractor.id, field.id, 'seed', 'wheat')).toMatch(/Plow/);
    expect(game.orderFieldOp(tractor.id, field.id, 'plow')).toBeNull();
    expect(run(game, 600, () => game.isIdle(tractor) && game.eligibleCount(field, 'plow') === 0)).toBe(true);
    expect(field.state.every(s => s === CellState.Plowed)).toBe(true);

    const moneyBefore = game.money;
    expect(game.orderFieldOp(tractor.id, field.id, 'seed', 'wheat')).toBeNull();
    expect(run(game, 600, () => game.eligibleCount(field, 'seed') === 0)).toBe(true);
    expect(game.money).toBeLessThan(moneyBefore);
    expect(game.toolOf(tractor)?.kind).toBe('seeder');

    // Let the crop ripen, and bring the tractor home.
    run(game, 60, () => game.isIdle(tractor) && tractor.steps.length === 0);
    game.clock += 3 * MINUTES_PER_DAY;
    expect(game.checkFieldOp(combine, field, 'harvest').ok).toBe(true);

    const earnedBefore = game.stats.earned;
    expect(game.orderFieldOp(combine.id, field.id, 'harvest')).toBeNull();
    const done = run(game, 1500, () =>
      game.eligibleCount(field, 'harvest', 'wheat') === 0 && combine.tank.amount === 0 && game.isIdle(tractor) && tractor.steps.length === 0);
    expect(done).toBe(true);
    expect(field.state.every(s => s === CellState.Stubble)).toBe(true);
    expect(game.stats.earned).toBeGreaterThan(earnedBefore);
    // Some cells grew weeds while we skipped ahead, costing up to 25% on those cells.
    expect(game.stats.soldLiters).toBeGreaterThan(120 * 95 * 0.75);
    expect(game.stats.soldLiters).toBeLessThanOrEqual(120 * 95 + 1);
  });

  it('round-trips through a save', () => {
    const game = new Game();
    game.createField(SQUARE);
    game.money = 1234;
    const { game: loaded } = Game.load(JSON.parse(JSON.stringify(game.save())));
    expect(loaded.money).toBe(1234);
    expect(loaded.world.fields.size).toBe(1);
    expect(loaded.vehicles).toHaveLength(2);
  });

  it('keeps growing at a slower, capped rate while the game is closed', () => {
    const game = new Game();
    const data = JSON.parse(JSON.stringify(game.save()));
    data.savedAt -= 60 * 60 * 1000; // closed for one real hour
    const { game: loaded, offline } = Game.load(data);
    // 3600 s * 8 game-min/s * 0.25 offline rate = 7200 min, capped at 2 days.
    expect(offline.minutes).toBe(2 * MINUTES_PER_DAY);
    expect(loaded.day).toBe(game.day + 2);
    expect(loaded.priceHistory.wheat.length).toBe(3);
  });
});

describe('field care', () => {
  function readyField(game: Game) {
    game.createField(SQUARE);
    const f = [...game.world.fields.values()][0];
    return f;
  }

  it('fertilizer, lime, rolling and weeds change the harvest', () => {
    const game = new Game();
    game.money = 1e6;
    const f = readyField(game);
    const tractor = game.vehicles[0];
    const combine = game.vehicles.find(v => v.kind === 'combine')!;
    game.buyItem('spreader');
    game.buyItem('roller');
    game.buyItem('sprayer');

    const job = (op: Parameters<Game['orderFieldOp']>[2], crop?: Parameters<Game['orderFieldOp']>[3], level?: number) => {
      expect(game.orderFieldOp(tractor.id, f.id, op, crop)).toBeNull();
      expect(run(game, 900, () => game.eligibleCount(f, op, undefined, level) === 0)).toBe(true);
    };
    job('plow');
    job('fertilize', undefined, 1);
    expect(f.fert.every(x => x === 1)).toBe(true);
    job('fertilize');
    expect(game.checkFieldOp(tractor, f, 'fertilize').ok).toBe(false);
    job('seed', 'wheat');
    job('roll');
    job('spray');
    expect(f.fert.every(x => x === 2)).toBe(true);
    // Soil still limed (2 harvests left), fertilized x2, rolled, weed-free: 1 + 0.3 + 0.05.
    expect(f.yieldFactor(0)).toBeCloseTo(1.35);

    game.clock += 3 * MINUTES_PER_DAY;
    expect(game.orderFieldOp(combine.id, f.id, 'harvest')).toBeNull();
    run(game, 1500, () => game.eligibleCount(f, 'harvest', 'wheat') === 0 && combine.tank.amount === 0 && tractor.steps.length === 0);
    expect(game.stats.soldLiters).toBeCloseTo(120 * 95 * 1.35, 0);
    // Season care resets, lime wears down.
    expect(f.fert[0]).toBe(0);
    expect(f.lime[0]).toBe(1);
  });

  it('weeds appear in unprotected crops and cost yield', () => {
    const game = new Game();
    const f = readyField(game);
    for (let i = 0; i < f.cells.length; i++) { f.state[i] = 2; f.crop[i] = 0; f.planted[i] = game.clock; }
    game.clock += 1.2 * MINUTES_PER_DAY; // past growth stage 2 for wheat
    run(game, 1.2);
    const weedy = f.cells.filter((_, i) => f.weeds[i] === 1).length;
    expect(weedy).toBeGreaterThan(f.cells.length * 0.4);
    const i = f.cells.findIndex((_, k) => f.weeds[k] === 1);
    expect(f.yieldFactor(i)).toBeCloseTo(0.75);
  });

  it('root crops need the root planter and root harvester', () => {
    const game = new Game();
    game.money = 1e6;
    const f = readyField(game);
    const tractor = game.vehicles[0];
    const combine = game.vehicles.find(v => v.kind === 'combine')!;
    f.state.fill(1);
    expect(game.checkFieldOp(tractor, f, 'seed', 'potato').reason).toMatch(/root planter/);
    game.buyItem('planter');
    expect(game.orderFieldOp(tractor.id, f.id, 'seed', 'potato')).toBeNull();
    run(game, 900, () => game.eligibleCount(f, 'seed') === 0);
    expect(game.toolOf(tractor)?.kind).toBe('planter');
    game.clock += 4 * MINUTES_PER_DAY;
    expect(game.checkFieldOp(combine, f, 'harvest').reason).toMatch(/root harvester/);
    game.buyItem('rootHarvester');
    const rh = game.vehicles.find(v => v.kind === 'rootHarvester')!;
    expect(game.orderFieldOp(rh.id, f.id, 'harvest')).toBeNull();
    run(game, 1500, () => game.eligibleCount(f, 'harvest') === 0 && rh.tank.amount === 0 && tractor.steps.length === 0);
    expect(game.stats.cropsHarvested).toContain('potato');
    expect(game.stats.soldLiters).toBeGreaterThan(0);
  });

  it('weather changes over time', () => {
    const game = new Game();
    const seen = new Set<string>();
    for (let d = 0; d < 20; d++) { game.clock += 180; game.update(0.01); seen.add(game.weather); }
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe('sharing implements', () => {
  it('borrows an implement from a parked tractor', () => {
    const game = new Game();
    game.money = 1e6;
    game.createField(SQUARE);
    const f = [...game.world.fields.values()][0];
    game.buyItem('tractor');
    const [t1, , t2] = game.vehicles;
    expect(game.orderFieldOp(t1.id, f.id, 'plow')).toBeNull();
    run(game, 900, () => game.eligibleCount(f, 'plow') === 0 && t1.steps.length === 0);
    expect(game.toolOf(t1)?.kind).toBe('plow');
    f.state.fill(3); // stubble again
    expect(game.orderFieldOp(t2.id, f.id, 'plow')).toBeNull();
    run(game, 900, () => game.eligibleCount(f, 'plow') === 0);
    expect(game.toolOf(t2)?.kind).toBe('plow');
    expect(game.toolOf(t1)).toBeUndefined();
  });
});
