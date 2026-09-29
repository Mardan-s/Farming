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
    expect(game.stats.soldLiters).toBeCloseTo(120 * 95, 0);
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
