// The trucks you can own and the garage upgrades for them.

export interface TruckModel {
  id: number;
  name: string;
  hp: number;
  /** Peak engine torque in N·m. */
  torque: number;
  cylinders: number;
  price: number;
  blurb: string;
  /** Front axle to drive axle (tandem centre), m. */
  wheelbase: number;
  /** Bumper, m ahead of the drive axle. */
  front: number;
  /** Flat-fronted European cab-over, or American long-nose conventional. */
  style: 'cabover' | 'conventional';
  /** Factory chrome and roof light bar. */
  dressed?: boolean;
}

export const TRUCK_MODELS: TruckModel[] = [
  { id: 0, name: 'Valor 460', hp: 460, torque: 2500, cylinders: 6, price: 0, blurb: 'Honest straight-six workhorse with a sleeper cab.', wheelbase: 3.9, front: 5.3, style: 'cabover' },
  { id: 1, name: 'Titan 580', hp: 580, torque: 3000, cylinders: 6, price: 32000, blurb: 'High roof, big grille and the grunt for steep passes.', wheelbase: 3.9, front: 5.3, style: 'cabover' },
  { id: 2, name: 'Apex V8 750', hp: 750, torque: 3500, cylinders: 8, price: 78000, blurb: 'Flagship V8. Chrome everywhere, twin stacks, light bar, that sound.', wheelbase: 3.9, front: 5.3, style: 'cabover', dressed: true },
  { id: 3, name: 'Liberty 505', hp: 505, torque: 2600, cylinders: 6, price: 0, blurb: 'Long-nose sleeper: sloping hood, chrome grille, twin stacks.', wheelbase: 6.0, front: 7.6, style: 'conventional' },
  { id: 4, name: 'Patriot 625', hp: 625, torque: 3200, cylinders: 6, price: 54000, blurb: 'Raised-roof long-nose with a visor, polished tanks and chrome everywhere.', wheelbase: 6.0, front: 7.6, style: 'conventional', dressed: true },
];

/** Garage order: the long-noses first. */
export const GARAGE_ORDER = [3, 4, 0, 1, 2];

export interface Upgrade { id: UpgradeId; name: string; price: number; detail: string }
export type UpgradeId = 'engine1' | 'engine2' | 'chrome' | 'lightbar' | 'horn';

export const UPGRADES: Upgrade[] = [
  { id: 'engine1', name: 'Engine tune · stage 1', price: 6000, detail: '+10% torque' },
  { id: 'engine2', name: 'Engine tune · stage 2', price: 14000, detail: '+20% torque (needs stage 1)' },
  { id: 'chrome', name: 'Chrome pack', price: 3500, detail: 'Polished bumper trim, mirrors, rims and tank' },
  { id: 'lightbar', name: 'Roof light bar', price: 2200, detail: 'Six amber spots across the roof' },
  { id: 'horn', name: 'Triple air horn', price: 1500, detail: 'Loud enough to wake the valley' },
];

export const ACCENTS = [0xf2f2f2, 0x111214, 0xffb020, 0x1f6fd1, 0xc9a227, 0xd9342b, 0x2e9e4f];

/** How a truck looks, as handed to the renderer. */
export interface TruckLook { model: number; color: number; accent: number; chrome: boolean; lightbar: boolean }

export function torqueScale(model: number, upgrades: Set<UpgradeId>) {
  const base = TRUCK_MODELS[model].torque / 2500;
  return base * (upgrades.has('engine2') ? 1.2 : upgrades.has('engine1') ? 1.1 : 1);
}
