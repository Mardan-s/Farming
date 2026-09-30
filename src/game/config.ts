// Core tuning values. All world distances are in grid cells.

export const CELL_PX = 32;

export const MAP_W = 118;
export const MAP_H = 70;

// Land parcels form a grid inside the map.
export const PARCEL_ORIGIN = { x: 3, y: 3 };
export const PARCEL_W = 28;
export const PARCEL_H = 20;
export const PARCEL_COLS = 4;
export const PARCEL_ROWS = 3;
export const START_PARCEL = 8; // bottom-left (row 2, col 0)

export interface Rect { x: number; y: number; w: number; h: number }

export const YARD: Rect = { x: 4, y: 44, w: 10, h: 18 };
/** Opening in the yard's east fence, toward the fields (rows y0..y1-1). */
export const YARD_GATE = { y0: 48, y1: 51 };
export const ROAD: Rect = { x: 0, y: 63, w: MAP_W, h: 3 };
export const ELEVATOR: Rect = { x: 103, y: 56, w: 12, h: 7 };

export const SILO_POS = { x: 7, y: 47 };
export const SILO_RADIUS = 2.2;
export const SILO_UNLOAD = { x: 10.2, y: 47.5 };
export const SELL_UNLOAD = { x: 109, y: 64.5 };

export const VEHICLE_SLOTS = [
  { x: 6.5, y: 51.5 }, { x: 10, y: 51.5 }, { x: 13.5, y: 51.5 },
  { x: 6.5, y: 54.5 }, { x: 10, y: 54.5 }, { x: 13.5, y: 54.5 },
];
export const TOOL_SLOTS = [
  { x: 6, y: 57.5 }, { x: 9.5, y: 57.5 }, { x: 13, y: 57.5 },
  { x: 6, y: 60.5 }, { x: 9.5, y: 60.5 }, { x: 13, y: 60.5 },
  { x: 10.6, y: 49.4 }, { x: 16.5, y: 57.5 }, { x: 16.5, y: 60.5 },
];

export function slotPos(slots: { x: number; y: number }[], i: number) {
  const base = slots[i % slots.length];
  const layer = Math.floor(i / slots.length);
  return { x: base.x + layer * 0.6, y: base.y - layer * 0.6 };
}

// Time: game minutes advanced per real second at 1x speed.
export const GAME_MIN_PER_SEC = 8; // average over a whole day
export const MINUTES_PER_DAY = 1440;
/** Daylight runs slowly and nights fly by: about 2.5 real minutes of day, 20 seconds of night at 1x. */
export const DAY_START = 6 * 60;
export const DAY_END = 20 * 60;
export const DAY_MIN_PER_SEC = 5.6;
export const NIGHT_MIN_PER_SEC = 30;
export function minutesPerSec(clock: number) {
  const t = ((clock % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return t >= DAY_START && t < DAY_END ? DAY_MIN_PER_SEC : NIGHT_MIN_PER_SEC;
}
export const SPEEDS = [1, 2, 5];
export const OFFLINE_RATE = 0.25; // fraction of 1x speed while the app is closed
export const OFFLINE_CAP_MIN = 2 * MINUTES_PER_DAY;

// Order matters: saves store crops by index, so only append new crops.
export type CropId = 'wheat' | 'corn' | 'soy' | 'barley' | 'oats' | 'canola' | 'sunflower' | 'potato' | 'sugarbeet';
export const CROPS: CropId[] = ['wheat', 'corn', 'soy', 'barley', 'oats', 'canola', 'sunflower', 'potato', 'sugarbeet'];

export interface CropDef {
  name: string;
  icon: string;
  growDays: number; // in-game days from seeding to ready
  yieldPerCell: number; // liters
  seedCostPerCell: number; // $
  basePrice: number; // $ per 1000 L
  color: number; // grain color
  /** Root crops need the root planter and root harvester instead of the seeder and combine. */
  root?: boolean;
  /** Seasons in which this crop can be planted. */
  seasons: Season[];
  /** 3D look: dense grain carpet or distinct rows, height in cells, and colors per growth stage. */
  look: {
    style: 'grain' | 'row';
    height: number;
    stages: [number, number, number, number]; // sprout, young, mature (or flowering), ripe
    heads?: [number, number, number, number]; // ears, tassels, flowers per stage; defaults to stages
    plant: 'grain' | 'corn' | 'sunflower' | 'bush' | 'canola';
    stalks?: boolean; // leaves tall stalk stubble after harvest
  };
}

export const CROP_DEFS: Record<CropId, CropDef> = {
  wheat: { name: 'Wheat', icon: '🌾', growDays: 2, yieldPerCell: 95, seedCostPerCell: 4, basePrice: 330, color: 0xe2bf5a, seasons: ['spring', 'autumn'],
    look: { style: 'grain', plant: 'grain', height: 0.42, stages: [0x8cc24e, 0x74ad40, 0x5f9a36, 0xcfa944], heads: [0x8cc24e, 0x7fb448, 0xa2c65c, 0xecc65a] } },
  corn: { name: 'Corn', icon: '🌽', growDays: 3, yieldPerCell: 130, seedCostPerCell: 6, basePrice: 300, color: 0xf2c230, seasons: ['spring', 'summer'],
    look: { style: 'row', plant: 'corn', height: 1.05, stages: [0x5aa845, 0x44983a, 0x378a31, 0xc4a560], heads: [0x5aa845, 0x44983a, 0xd6c65e, 0xc79f4c], stalks: true } },
  soy: { name: 'Soybeans', icon: '🫘', growDays: 2.5, yieldPerCell: 72, seedCostPerCell: 5, basePrice: 520, color: 0xc9a86a, seasons: ['spring', 'summer'],
    look: { style: 'row', plant: 'bush', height: 0.34, stages: [0x72bb50, 0x5aa843, 0x4a973a, 0xb08a40] } },
  barley: { name: 'Barley', icon: '🍺', growDays: 1.75, yieldPerCell: 100, seedCostPerCell: 4, basePrice: 300, color: 0xd9c27e, seasons: ['spring', 'autumn'],
    look: { style: 'grain', plant: 'grain', height: 0.36, stages: [0x9acb5c, 0x88bb52, 0x7aac4e, 0xd4bf80], heads: [0x9acb5c, 0x8cbf55, 0xaacb6a, 0xe8d69a] } },
  oats: { name: 'Oats', icon: '🥣', growDays: 1.5, yieldPerCell: 80, seedCostPerCell: 3, basePrice: 360, color: 0xe6dcb0, seasons: ['spring', 'summer'],
    look: { style: 'grain', plant: 'grain', height: 0.4, stages: [0x8cc574, 0x7ab46a, 0x6ea566, 0xd6cc98], heads: [0x8cc574, 0x80b86e, 0xa8c98c, 0xefe5bb] } },
  canola: { name: 'Canola', icon: '🌼', growDays: 2.75, yieldPerCell: 70, seedCostPerCell: 6, basePrice: 600, color: 0x2e2a20, seasons: ['autumn', 'spring'],
    look: { style: 'grain', plant: 'canola', height: 0.55, stages: [0x68b256, 0x55a34c, 0x4f9a46, 0x6b6a33], heads: [0x68b256, 0x5fae52, 0xf7dc2a, 0x5a5530] } },
  sunflower: { name: 'Sunflowers', icon: '🌻', growDays: 3.5, yieldPerCell: 75, seedCostPerCell: 6, basePrice: 640, color: 0x3b3328, seasons: ['spring', 'summer'],
    look: { style: 'row', plant: 'sunflower', height: 1.2, stages: [0x62ae4a, 0x4a9a3c, 0x43903a, 0x6b5a2e], heads: [0x62ae4a, 0x5ca044, 0xf5c518, 0x3a2a18], stalks: true } },
  potato: { name: 'Potatoes', icon: '🥔', growDays: 3, yieldPerCell: 320, seedCostPerCell: 14, basePrice: 145, color: 0xc9a36a, seasons: ['spring'], root: true,
    look: { style: 'row', plant: 'bush', height: 0.4, stages: [0x66b04e, 0x52a044, 0x46953c, 0x8f8440], heads: [0x66b04e, 0x52a044, 0xe4d6ef, 0x8f8440] } },
  sugarbeet: { name: 'Sugar beets', icon: '🍠', growDays: 3.5, yieldPerCell: 380, seedCostPerCell: 9, basePrice: 115, color: 0xeadfca, seasons: ['spring'], root: true,
    look: { style: 'row', plant: 'bush', height: 0.46, stages: [0x5aa848, 0x46983f, 0x3b8b38, 0x6f9c42] } },
};

export function emptyCropRecord<T>(value: () => T): Record<CropId, T> {
  return Object.fromEntries(CROPS.map(c => [c, value()])) as Record<CropId, T>;
}

export type Season = 'spring' | 'summer' | 'autumn' | 'winter';
export const SEASONS: Season[] = ['spring', 'summer', 'autumn', 'winter'];
export const SEASON_DAYS = 4;
export const SEASON_NAMES: Record<Season, string> = { spring: 'Spring', summer: 'Summer', autumn: 'Autumn', winter: 'Winter' };

export type VehicleKind = 'tractor' | 'combine' | 'rootHarvester';

// Running costs.
export const FUEL_CAP: Record<VehicleKind, number> = { tractor: 260, combine: 420, rootHarvester: 400 };
/** Liters per real second: idling, driving, working. */
export const FUEL_USE = { idle: 0.02, drive: 0.16, work: 0.32 };
export const FUEL_PRICE = 1.6;
export const WAGE_PER_SEC = 4; // hired worker, per real second of work at 1x
export const WEAR_PER_SEC = { drive: 0.012, work: 0.035 }; // condition % per second
export const REPAIR_COST_PER_PCT: Record<VehicleKind, number> = { tractor: 28, combine: 60, rootHarvester: 55 };
export const LOAN_STEP = 10000;
export const LOAN_MAX = 150000;
export const LOAN_DAILY_RATE = 0.008;
export const PUMP = { x: 5.2, y: 49.8 };
/** Harvesting stops above this wetness (0..1); rain wets crops, sun dries them. */
export const WET_LIMIT = 0.3;
/** Wetness change per game minute for each kind of weather. */
export const WET_RATE: Record<Weather, number> = { sun: -0.0025, cloudy: -0.0008, rain: 0.004, storm: 0.007 };
export const REFUEL_RATE = 45; // liters per second at the pump
/** Storm damage: yield left on flattened cells, and the chance per second of flattening a ripe cell. */
export const STORM_YIELD = 0.6;
export const STORM_CHANCE = { ripe: 0.004, overripe: 0.03 };
export const OVERRIPE_DAYS = 0.75;
export type ToolKind = 'plow' | 'seeder' | 'wagon' | 'spreader' | 'roller' | 'weeder' | 'sprayer' | 'planter';

/** Every field job. Tractor jobs name the implement they need. */
export type Op = 'plow' | 'seed' | 'harvest' | 'fertilize' | 'lime' | 'roll' | 'weed' | 'spray';

export const OP_DEFS: Record<Op, { name: string; verb: string; icon: string; tool?: ToolKind; costPerCell?: number; desc: string }> = {
  plow: { name: 'Plow', verb: 'Plowing', icon: '⛏️', tool: 'plow', desc: 'Turns grass and stubble into soil. Clears weeds.' },
  fertilize: { name: 'Fertilize', verb: 'Fertilizing', icon: '🧪', tool: 'spreader', costPerCell: 3, desc: 'Up to 2 passes per crop, +15% yield each.' },
  lime: { name: 'Lime', verb: 'Liming', icon: '🪨', tool: 'spreader', costPerCell: 2, desc: 'Soil turns sour every few harvests. Unlimed soil loses 15%.' },
  seed: { name: 'Seed', verb: 'Seeding', icon: '🌱', desc: 'Plant a crop on plowed soil.' },
  roll: { name: 'Roll', verb: 'Rolling', icon: '🛞', tool: 'roller', desc: 'Firm the soil right after seeding for +5% yield.' },
  weed: { name: 'Weed', verb: 'Weeding', icon: '🌿', tool: 'weeder', desc: 'Pulls weeds from young crops (first two growth stages).' },
  spray: { name: 'Spray', verb: 'Spraying', icon: '💦', tool: 'sprayer', costPerCell: 2.5, desc: 'Herbicide kills weeds at any growth stage.' },
  harvest: { name: 'Harvest', verb: 'Harvesting', icon: '🌾', desc: 'Collect a ripe crop.' },
};

export const FIXED_TOOL_WIDTH: Partial<Record<ToolKind | 'rootHeader', number>> = {
  spreader: 6, roller: 4, weeder: 4, sprayer: 8, planter: 2, rootHeader: 2,
};
export const ROOT_TANK = 20000;
export const ROOT_SPEED = 2.2;
export const FERT_BONUS = 0.15;
export const LIME_PENALTY = 0.15;
export const WEED_PENALTY = 0.25;
export const ROLL_BONUS = 0.05;
export const LIME_HARVESTS = 3; // harvests before a cell needs lime again

export type Weather = 'sun' | 'cloudy' | 'rain' | 'storm';
export const WEATHER_DEFS: Record<Weather, { name: string; icon: string; next: [Weather, number][] }> = {
  sun: { name: 'Sunny', icon: '☀️', next: [['sun', 0.6], ['cloudy', 0.36], ['rain', 0.04]] },
  cloudy: { name: 'Cloudy', icon: '⛅', next: [['sun', 0.48], ['cloudy', 0.42], ['rain', 0.09], ['storm', 0.01]] },
  rain: { name: 'Rain', icon: '🌧️', next: [['cloudy', 0.6], ['sun', 0.3], ['rain', 0.1]] },
  storm: { name: 'Thunderstorm', icon: '⛈️', next: [['cloudy', 0.55], ['rain', 0.45]] },
};
/** Game hours each kind of weather lasts, [min, max]. Rain and storms pass quickly. */
export const WEATHER_HOURS: Record<Weather, [number, number]> = { sun: [3, 9], cloudy: [3, 9], rain: [1.5, 4], storm: [1.5, 4] };

// Vehicle geometry (cells). Tools hitch behind the tractor.
export const TRACTOR_LEN = 1.6;
export const TRACTOR_WID = 1.0;
export const COMBINE_LEN = 2.4;
export const COMBINE_WID = 1.5;
export const HEADER_OFFSET = 1.55; // header center ahead of combine center
export const HITCH_OFFSET = 0.8; // hitch point behind tractor center
export const TOOL_LEN: Record<ToolKind, number> = {
  plow: 1.1, seeder: 1.1, wagon: 2.0, spreader: 1.0, roller: 1.0, weeder: 0.9, sprayer: 1.4, planter: 1.3,
};
export const WORK_SPEED_FACTOR = 0.7;
export const COMBINE_WORK_FACTOR = 0.5;
export const COMBINE_SPEED = 2.6;

export interface UpgradeDef {
  name: string;
  icon: string;
  levels: { cost: number; label: string }[];
}

export type UpgradeId = 'plow' | 'seeder' | 'header' | 'wagon' | 'engine';

export const UPGRADES: Record<UpgradeId, UpgradeDef> = {
  plow: { name: 'Plow width', icon: '⛏️', levels: [
    { cost: 0, label: '2 rows' }, { cost: 4000, label: '3 rows' }, { cost: 9000, label: '4 rows' }] },
  seeder: { name: 'Seeder width', icon: '🌱', levels: [
    { cost: 0, label: '3 rows' }, { cost: 5000, label: '4 rows' }, { cost: 12000, label: '6 rows' }] },
  header: { name: 'Combine header & tank', icon: '🌾', levels: [
    { cost: 0, label: '3 rows · 12,000 L' }, { cost: 8000, label: '4 rows · 18,000 L' }, { cost: 18000, label: '6 rows · 28,000 L' }] },
  wagon: { name: 'Wagon capacity', icon: '🛒', levels: [
    { cost: 0, label: '16,000 L' }, { cost: 3000, label: '24,000 L' }, { cost: 7000, label: '36,000 L' }] },
  engine: { name: 'Tractor engine', icon: '⚙️', levels: [
    { cost: 0, label: 'Standard' }, { cost: 5000, label: 'Turbo (+20%)' }, { cost: 11000, label: 'V8 (+45%)' }] },
};

export const PLOW_WIDTH = [2, 3, 4];
export const SEEDER_WIDTH = [3, 4, 6];
export const HEADER_WIDTH = [3, 4, 6];
export const COMBINE_TANK = [12000, 18000, 28000];
export const WAGON_CAP = [16000, 24000, 36000];
export const TRACTOR_SPEED = [3.2, 3.85, 4.65];

export const SHOP_ITEMS: { id: VehicleKind | ToolKind; name: string; icon: string; cost: number; desc: string }[] = [
  { id: 'tractor', name: 'Tractor', icon: '🚜', cost: 14000, desc: 'Pulls every implement. More tractors can work at the same time.' },
  { id: 'combine', name: 'Combine', icon: '🌾', cost: 32000, desc: 'Harvests ready crops into its grain tank.' },
  { id: 'plow', name: 'Plow', icon: '⛏️', cost: 3000, desc: 'Turns grass and stubble into plowed soil.' },
  { id: 'seeder', name: 'Seeder', icon: '🌱', cost: 4500, desc: 'Plants grain, oilseed and bean crops on plowed soil.' },
  { id: 'wagon', name: 'Grain wagon', icon: '🛒', cost: 3500, desc: 'Carries grain from combines to the silo or sell point.' },
  { id: 'spreader', name: 'Spreader', icon: '🧪', cost: 5000, desc: 'Spreads fertilizer or lime, 6 rows wide.' },
  { id: 'roller', name: 'Roller', icon: '🛞', cost: 3500, desc: 'Firms freshly seeded soil for a small yield bonus.' },
  { id: 'weeder', name: 'Weeder', icon: '🌿', cost: 4000, desc: 'Pulls weeds from young crops for free.' },
  { id: 'sprayer', name: 'Sprayer', icon: '💦', cost: 6500, desc: 'Sprays herbicide at any growth stage, 8 rows wide.' },
  { id: 'planter', name: 'Root planter', icon: '🥔', cost: 9000, desc: 'Plants potatoes and sugar beets.' },
  { id: 'rootHarvester', name: 'Root harvester', icon: '🚜', cost: 45000, desc: 'Self-propelled harvester for potatoes and sugar beets.' },
];

export const START_MONEY = 6000;
export const SILO_CAP = 150000;
export const AUTO_UNLOAD_THRESHOLD = 0.6;
export const UNLOAD_RATE = 1800; // liters per second
export const SAVE_KEY = 'farming-save-v1';

export function parcelPrice(index: number): number {
  const col = index % PARCEL_COLS;
  const row = Math.floor(index / PARCEL_COLS);
  const startCol = START_PARCEL % PARCEL_COLS;
  const startRow = Math.floor(START_PARCEL / PARCEL_COLS);
  const dist = Math.abs(col - startCol) + Math.abs(row - startRow);
  return 8000 + dist * 4500 + (index === 11 ? -3000 : 0);
}
