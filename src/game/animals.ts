import { MINUTES_PER_DAY, type CropId } from './config';

// Animals live in pens on your land. They eat feed from a trough (grain from your silo,
// hauled by wagon), produce something to sell every day, and breed when they're happy.

export type AnimalKind = 'chicken' | 'cow' | 'pig' | 'sheep';
export const ANIMAL_KINDS: AnimalKind[] = ['chicken', 'cow', 'pig', 'sheep'];
export type Product = 'eggs' | 'milk' | 'piglets' | 'wool';
export const PRODUCTS: Product[] = ['eggs', 'milk', 'piglets', 'wool'];

export interface AnimalDef {
  name: string; // one animal
  plural: string;
  pen: string; // building name
  /** Pen footprint in cells; the building sits along the back (top) edge. */
  w: number;
  h: number;
  penCost: number;
  animalCost: number;
  /** Most animals the pen holds, and how many come with it. */
  cap: number;
  start: number;
  /** Liters of feed per animal per day, which crops count as feed, and the trough size. */
  feedPerDay: number;
  diet: CropId[];
  trough: number;
  product: Product;
  /** Product units per animal per day at full happiness, and how many the pen can store. */
  perDay: number;
  storage: number;
  /** Days for a pair of happy animals to raise one more (0 = doesn't breed by itself). */
  breedDays: number;
}

export const ANIMAL_DEFS: Record<AnimalKind, AnimalDef> = {
  chicken: {
    name: 'Chicken', plural: 'Chickens', pen: 'Chicken coop', w: 7, h: 6, penCost: 6000, animalCost: 30, cap: 40, start: 10,
    feedPerDay: 4, diet: ['wheat', 'barley', 'oats', 'corn', 'soy', 'sunflower', 'canola'], trough: 1200,
    product: 'eggs', perDay: 1, storage: 800, breedDays: 3,
  },
  cow: {
    name: 'Cow', plural: 'Cows', pen: 'Cow barn', w: 11, h: 9, penCost: 24000, animalCost: 1400, cap: 12, start: 4,
    feedPerDay: 60, diet: ['corn', 'barley', 'oats', 'soy', 'wheat', 'sugarbeet'], trough: 9000,
    product: 'milk', perDay: 25, storage: 4000, breedDays: 8,
  },
  pig: {
    name: 'Pig', plural: 'Pigs', pen: 'Pig sty', w: 9, h: 7, penCost: 14000, animalCost: 420, cap: 16, start: 4,
    feedPerDay: 28, diet: ['corn', 'potato', 'soy', 'wheat', 'barley', 'sugarbeet'], trough: 5000,
    product: 'piglets', perDay: 0.2, storage: 24, breedDays: 0,
  },
  sheep: {
    name: 'Sheep', plural: 'Sheep', pen: 'Sheep pasture', w: 11, h: 9, penCost: 9000, animalCost: 300, cap: 16, start: 5,
    feedPerDay: 10, diet: ['oats', 'barley', 'wheat', 'corn', 'sugarbeet'], trough: 2000,
    product: 'wool', perDay: 1.5, storage: 400, breedDays: 6,
  },
};

export const PRODUCT_DEFS: Record<Product, { name: string; unit: string; basePrice: number; icon: string }> = {
  eggs: { name: 'Eggs', unit: 'eggs', basePrice: 3, icon: 'egg' },
  milk: { name: 'Milk', unit: 'L', basePrice: 1.7, icon: 'milk' },
  piglets: { name: 'Piglets', unit: 'piglets', basePrice: 180, icon: 'pig' },
  wool: { name: 'Wool', unit: 'kg', basePrice: 6, icon: 'wool' },
};

export interface Pen {
  id: number;
  kind: AnimalKind;
  /** Top-left cell of the footprint. */
  x: number;
  y: number;
  animals: number;
  food: number; // liters in the trough
  stored: number; // product units waiting to be sold
  happiness: number; // 0..100
  breed: number; // progress toward the next birth, in animals
  autoFeed: boolean;
}

export function penRect(p: Pen) {
  const d = ANIMAL_DEFS[p.kind];
  return { x: p.x, y: p.y, w: d.w, h: d.h };
}

/** Where a wagon stops to tip feed into the trough: just outside the front fence, in the middle. */
export function feedPoint(p: Pen) {
  const d = ANIMAL_DEFS[p.kind];
  return { x: p.x + d.w / 2, y: p.y + d.h + 0.9 };
}

/** The open yard inside the fence, where animals roam (the building takes the back strip). */
export function penYard(p: Pen) {
  const d = ANIMAL_DEFS[p.kind];
  const back = buildingDepth(p.kind);
  return { x0: p.x + 0.7, x1: p.x + d.w - 0.7, y0: p.y + back + 0.5, y1: p.y + d.h - 0.8 };
}

export function buildingDepth(kind: AnimalKind) {
  return kind === 'chicken' ? 2.2 : kind === 'cow' ? 3.6 : kind === 'pig' ? 2.6 : 2.6;
}

export interface PenEvents {
  born(p: Pen, n: number): void;
  hungry(p: Pen): void;
}

/**
 * Advances a pen by some game minutes: animals eat, produce while fed, get happier or
 * unhappier, and (if happy, with room) raise young.
 */
export function tickPen(p: Pen, minutes: number, ev: PenEvents) {
  const d = ANIMAL_DEFS[p.kind];
  const days = minutes / MINUTES_PER_DAY;
  if (p.animals <= 0 || days <= 0) return;
  const need = p.animals * d.feedPerDay * days;
  const eaten = Math.min(need, p.food);
  const wasFed = p.food > 0;
  p.food -= eaten;
  const fedShare = need > 0 ? eaten / need : 1;
  // Happiness drifts toward its target: fed with room to move is best.
  const crowded = p.animals / d.cap > 0.9 ? 85 : 100;
  const target = fedShare > 0.99 ? crowded : fedShare * 40;
  const rate = 35 * days;
  p.happiness += Math.max(-rate, Math.min(rate, target - p.happiness));
  // Production while fed, scaled by happiness.
  const mult = fedShare * (0.5 + 0.5 * p.happiness / 100);
  p.stored = Math.min(d.storage, p.stored + p.animals * d.perDay * days * mult);
  if (wasFed && p.food <= 0) ev.hungry(p);
  // Breeding.
  if (d.breedDays > 0 && p.happiness > 70 && p.animals >= 2 && p.animals < d.cap) {
    p.breed += (p.animals / 2) * (days / d.breedDays) * (p.happiness / 100);
    if (p.breed >= 1) {
      const n = Math.min(Math.floor(p.breed), d.cap - p.animals);
      p.breed -= Math.floor(p.breed);
      if (n > 0) {
        p.animals += n;
        ev.born(p, n);
      }
    }
  }
}

/** Liters per day the whole pen eats. */
export function dailyFeed(p: Pen) {
  return p.animals * ANIMAL_DEFS[p.kind].feedPerDay;
}
