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
}

export const TRUCK_MODELS: TruckModel[] = [
  { id: 0, name: 'Valor 460', hp: 460, torque: 2500, cylinders: 6, price: 0, blurb: 'Honest straight-six workhorse with a sleeper cab.' },
  { id: 1, name: 'Titan 580', hp: 580, torque: 3000, cylinders: 6, price: 32000, blurb: 'High roof, big grille and the grunt for steep passes.' },
  { id: 2, name: 'Apex V8 750', hp: 750, torque: 3500, cylinders: 8, price: 78000, blurb: 'Flagship V8. Chrome everywhere, twin stacks, light bar, that sound.' },
];

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
