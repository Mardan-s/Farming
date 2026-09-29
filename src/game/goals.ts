export interface Stats {
  plowed: number;
  seeded: number;
  harvested: number;
  soldLiters: number;
  earned: number;
  cropsHarvested: string[];
  upgrades: number;
  parcels: number;
  fields: number;
  vehiclesBought: number;
}

export function newStats(): Stats {
  return { plowed: 0, seeded: 0, harvested: 0, soldLiters: 0, earned: 0, cropsHarvested: [], upgrades: 0, parcels: 1, fields: 0, vehiclesBought: 0 };
}

export interface Goal {
  title: string;
  hint: string;
  reward: number;
  progress: (s: Stats) => [number, number];
}

export const GOALS: Goal[] = [
  { title: 'Draw your first field', hint: 'Tap ✏️ Field, then tap at least 4 grid corners on your land.', reward: 500, progress: s => [s.fields, 1] },
  { title: 'Plow the field', hint: 'Tap the tractor, then tap your field and choose Plow.', reward: 400, progress: s => [s.plowed, 60] },
  { title: 'Plant a crop', hint: 'Tap the tractor, tap the plowed field and pick a seed.', reward: 400, progress: s => [s.seeded, 60] },
  { title: 'Harvest your crop', hint: 'When the crop turns golden, tap the combine, then the field.', reward: 600, progress: s => [s.harvested, 60] },
  { title: 'Sell some grain', hint: 'The tractor hauls grain to the sell point automatically.', reward: 600, progress: s => [Math.min(s.soldLiters, 5000), 5000] },
  { title: 'Buy more land', hint: 'Tap a locked plot on the map or open the Shop.', reward: 2500, progress: s => [s.parcels - 1, 1] },
  { title: 'Buy an upgrade', hint: 'Shop → Upgrades makes your machines wider and faster.', reward: 1500, progress: s => [s.upgrades, 1] },
  { title: 'Harvest 4 different crops', hint: 'Try barley, oats, canola or sunflowers — each has its own price.', reward: 3000, progress: s => [s.cropsHarvested.length, 4] },
  { title: 'Grow your fleet', hint: 'Buy a second tractor or combine to work in parallel.', reward: 4000, progress: s => [s.vehiclesBought, 1] },
  { title: 'Earn $100,000', hint: 'Watch the market — sell when prices are high.', reward: 10000, progress: s => [Math.min(s.earned, 100000), 100000] },
];
