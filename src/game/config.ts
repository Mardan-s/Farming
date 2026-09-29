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
];

export function slotPos(slots: { x: number; y: number }[], i: number) {
  const base = slots[i % slots.length];
  const layer = Math.floor(i / slots.length);
  return { x: base.x + layer * 0.6, y: base.y - layer * 0.6 };
}

// Time: game minutes advanced per real second at 1x speed.
export const GAME_MIN_PER_SEC = 8;
export const MINUTES_PER_DAY = 1440;
export const SPEEDS = [1, 2, 5];
export const OFFLINE_RATE = 0.25; // fraction of 1x speed while the app is closed
export const OFFLINE_CAP_MIN = 2 * MINUTES_PER_DAY;

// Order matters: saves store crops by index, so only append new crops.
export type CropId = 'wheat' | 'corn' | 'soy' | 'barley' | 'oats' | 'canola' | 'sunflower';
export const CROPS: CropId[] = ['wheat', 'corn', 'soy', 'barley', 'oats', 'canola', 'sunflower'];

export interface CropDef {
  name: string;
  icon: string;
  growDays: number; // in-game days from seeding to ready
  yieldPerCell: number; // liters
  seedCostPerCell: number; // $
  basePrice: number; // $ per 1000 L
  color: number; // grain color
  /** 3D look: dense grain carpet or distinct rows, height in cells, and colors per growth stage. */
  look: {
    style: 'grain' | 'row';
    height: number;
    stages: [number, number, number, number]; // sprout, young, mature (or flowering), ripe
    stalks?: boolean; // leaves tall stalk stubble after harvest
  };
}

export const CROP_DEFS: Record<CropId, CropDef> = {
  wheat: { name: 'Wheat', icon: '🌾', growDays: 2, yieldPerCell: 95, seedCostPerCell: 4, basePrice: 330, color: 0xe2bf5a,
    look: { style: 'grain', height: 0.42, stages: [0x9ccf55, 0x80b845, 0x6aa33a, 0xe3bd4f] } },
  corn: { name: 'Corn', icon: '🌽', growDays: 3, yieldPerCell: 130, seedCostPerCell: 6, basePrice: 300, color: 0xf2c230,
    look: { style: 'row', height: 1.05, stages: [0x62b04a, 0x479f3c, 0x3a8f33, 0xcfb25e], stalks: true } },
  soy: { name: 'Soybeans', icon: '🫘', growDays: 2.5, yieldPerCell: 72, seedCostPerCell: 5, basePrice: 520, color: 0xc9a86a,
    look: { style: 'row', height: 0.32, stages: [0x7cc254, 0x62b045, 0x4f9e3b, 0xb88f42] } },
  barley: { name: 'Barley', icon: '🍺', growDays: 1.75, yieldPerCell: 100, seedCostPerCell: 4, basePrice: 300, color: 0xd9c27e,
    look: { style: 'grain', height: 0.36, stages: [0xa6d160, 0x93c257, 0x86b456, 0xdcc98a] } },
  oats: { name: 'Oats', icon: '🥣', growDays: 1.5, yieldPerCell: 80, seedCostPerCell: 3, basePrice: 360, color: 0xe6dcb0,
    look: { style: 'grain', height: 0.4, stages: [0x93c979, 0x82b86f, 0x77aa6c, 0xe0d6a6] } },
  canola: { name: 'Canola', icon: '🌼', growDays: 2.75, yieldPerCell: 70, seedCostPerCell: 6, basePrice: 600, color: 0x2e2a20,
    look: { style: 'grain', height: 0.55, stages: [0x6fb85a, 0x5aa850, 0xf5d62a, 0x6b6a33] } },
  sunflower: { name: 'Sunflowers', icon: '🌻', growDays: 3.5, yieldPerCell: 75, seedCostPerCell: 6, basePrice: 640, color: 0x3b3328,
    look: { style: 'row', height: 1.2, stages: [0x6cb44e, 0x4f9f3e, 0xf2c21b, 0x5e4a2a], stalks: true } },
};

export function emptyCropRecord<T>(value: () => T): Record<CropId, T> {
  return Object.fromEntries(CROPS.map(c => [c, value()])) as Record<CropId, T>;
}

export type VehicleKind = 'tractor' | 'combine';
export type ToolKind = 'plow' | 'seeder' | 'wagon';

// Vehicle geometry (cells). Tools hitch behind the tractor.
export const TRACTOR_LEN = 1.6;
export const TRACTOR_WID = 1.0;
export const COMBINE_LEN = 2.4;
export const COMBINE_WID = 1.5;
export const HEADER_OFFSET = 1.55; // header center ahead of combine center
export const HITCH_OFFSET = 0.8; // hitch point behind tractor center
export const TOOL_LEN: Record<ToolKind, number> = { plow: 1.1, seeder: 1.1, wagon: 2.0 };
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
  { id: 'tractor', name: 'Tractor', icon: '🚜', cost: 14000, desc: 'Pulls a plow, seeder or wagon. More tractors = work in parallel.' },
  { id: 'combine', name: 'Combine', icon: '🌾', cost: 32000, desc: 'Harvests ready crops into its grain tank.' },
  { id: 'plow', name: 'Plow', icon: '⛏️', cost: 3000, desc: 'Turns grass and stubble into plowed soil.' },
  { id: 'seeder', name: 'Seeder', icon: '🌱', cost: 4500, desc: 'Plants wheat, corn or soybeans on plowed soil.' },
  { id: 'wagon', name: 'Grain wagon', icon: '🛒', cost: 3500, desc: 'Carries grain from combines to the silo or sell point.' },
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
