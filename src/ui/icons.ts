// Hand-drawn line icons (24x24, stroked in currentColor) so the UI never relies on emoji.

const P: Record<string, string> = {
  tractor: '<circle cx="7" cy="16" r="4"/><circle cx="7" cy="16" r="1.2"/><circle cx="18" cy="17.5" r="2.5"/><path d="M3.5 12.5 4 9h6l1-5h4.5l.5 5h3l2 4.5M11 16h4.5M17 4V2.5"/>',
  combine: '<path d="M3 13.5V7h11v6.5M14 9h3l3.5 4.5v.5"/><circle cx="7" cy="16.5" r="3"/><circle cx="16.5" cy="17.5" r="2"/><path d="M6 7V4h5v3M20.5 14H22M2 13.5h1"/>',
  rootHarvester: '<path d="M3 13V7h9l2 3h4v3"/><circle cx="6.5" cy="16.5" r="2.5"/><circle cx="15.5" cy="16.5" r="2.5"/><path d="M18 13l3.5 2.5M4 7l2-3h5M9 13h4"/>',
  wagon: '<path d="M3 8h14l-1.5 7h-11z"/><circle cx="7" cy="17.5" r="2"/><circle cx="13" cy="17.5" r="2"/><path d="M16.5 12H21"/>',
  field: '<path d="M3 20 7 6h10l4 14z"/><path d="M9.5 6 8 20M14.5 6l1.5 14M12 6v14"/>',
  newField: '<path d="M3 21h7M3 17h3M3 13h1"/><path d="M14.5 3.5l6 6-9.5 9.5H5v-6z"/><path d="M12.5 5.5l6 6"/>',
  plow: '<path d="M4 4h11M7 4v3M11 4v3M15 4l5 2"/><path d="M7 7c-1.5 4 1 8.5 6 9.5M11 7c-1 3.5 1 6.5 6 7.5"/>',
  seed: '<path d="M12 21v-8"/><path d="M12 13c0-4 3-6 7-6 0 4-3 6-7 6zM12 11c0-3-2-5-6-5 0 3 2 5 6 5z"/><path d="M8 21h8"/>',
  fertilize: '<path d="M7 8l1-4h8l1 4-1 12H8z"/><path d="M8.5 8h7"/><circle cx="11" cy="12.5" r=".9"/><circle cx="13.5" cy="15.5" r=".9"/><circle cx="10.5" cy="17" r=".9"/>',
  lime: '<path d="M4 17l3-7 5-3 6 2 2 6-4 4H7z"/><path d="M9 11l3 2 5-1M12 13v6"/>',
  roll: '<rect x="3" y="11" width="11" height="7" rx="3.5"/><path d="M6 11v7M11 11v7M14 14.5h3l3.5-6"/>',
  weed: '<path d="M12 21V11"/><path d="M12 16 7.5 12.5M12 14l4.5-3.5M12 19l-3.5-1.5"/><path d="M12 11c-1.5-1-2-3-1-5l1-2 1 2c1 2 .5 4-1 5z"/>',
  spray: '<path d="M4 6h9v4H4zM13 8h3.5M8.5 10v2"/><path d="M6 16l-1 2M8.5 15v3M11 16l1 2M7 20.5l-.3.8M10 20.5l.3.8"/>',
  harvest: '<path d="M12 22V9"/><path d="M12 9c-2-1-3-3-3-5 2 1 3 3 3 5zM12 9c2-1 3-3 3-5-2 1-3 3-3 5zM12 14c-2-1-3-3-3-5 2 1 3 3 3 5zM12 14c2-1 3-3 3-5-2 1-3 3-3 5zM12 19c-2-1-3-3-3-5 2 1 3 3 3 5zM12 19c2-1 3-3 3-5-2 1-3 3-3 5z"/>',
  shop: '<path d="M4.5 10.5V20h15v-9.5M3 10l2-6h14l2 6"/><path d="M3 10c0 2 3.6 2 3.6 0 0 2 3.6 2 3.6 0 0 2 3.6 2 3.6 0 0 2 3.6 2 3.6 0 0 2 3.6 2 3.6 0"/><path d="M10 20v-5h4v5"/>',
  market: '<path d="M4 20V4M4 20h16"/><path d="M7 15l4-4 3 3 5-6"/><path d="M16 8h3v3"/>',
  fleet: '<path d="M3 11 12 4l9 7v9H3z"/><path d="M8 20v-6h8v6M8 14l8 6M16 14l-8 6"/>',
  silo: '<path d="M6 21V8a6 6 0 0 1 12 0v13M4 21h16M6 12h12M6 16h12"/>',
  settings: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v3M12 18.5v3M4.6 4.6l2.1 2.1M17.3 17.3l2.1 2.1M2.5 12h3M18.5 12h3M4.6 19.4l2.1-2.1M17.3 6.7l2.1-2.1"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  chevron: '<path d="M9 5l7 7-7 7"/>',
  home: '<path d="M3 11 12 4l9 7"/><path d="M5.5 9.5V20h13V9.5M10 20v-6h4v6"/>',
  compass: '<circle cx="12" cy="12" r="9"/><path d="M12 5.5l2.5 6.5h-5z" fill="currentColor"/><path d="M12 18.5 9.5 12h5z"/>',
  speed: '<path d="M4 6l7 6-7 6zM12.5 6l7 6-7 6z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
  cloudy: '<circle cx="8" cy="8" r="3"/><path d="M8 3v1M3 8h1M4.5 4.5l.7.7"/><path d="M7 19h10a4 4 0 0 0 0-8 5 5 0 0 0-9.6 1.5A3.3 3.3 0 0 0 7 19z"/>',
  rain: '<path d="M7 15h10a4 4 0 0 0 0-8 5 5 0 0 0-9.6 1.5A3.3 3.3 0 0 0 7 15z"/><path d="M8 18l-1 2.5M12 18l-1 2.5M16 18l-1 2.5"/>',
  storm: '<path d="M7 14h10a4 4 0 0 0 0-8 5 5 0 0 0-9.6 1.5A3.3 3.3 0 0 0 7 14z"/><path d="M12.5 14l-2.5 4h3l-2 4"/>',
  coin: '<circle cx="12" cy="12" r="9"/><path d="M14.5 8.5c-.5-1-1.5-1.5-2.5-1.5-1.7 0-3 1-3 2.3 0 3.2 6 1.8 6 5 0 1.3-1.3 2.2-3 2.2-1.2 0-2.3-.6-2.8-1.6M12 5.5v13"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="1.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6"/>',
  flag: '<path d="M5 21V3.5M5 4h11l-2 4 2 4H5"/>',
  check: '<path d="M4.5 12.5l5 5 10-11"/>',
  warn: '<path d="M12 3.5 2.5 20h19z"/><path d="M12 10v4.5M12 17.2v.3"/>',
  follow: '<circle cx="12" cy="12" r="6.5"/><circle cx="12" cy="12" r="1.5"/><path d="M12 2v3.5M12 18.5V22M2 12h3.5M18.5 12H22"/>',
  park: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9.5 17V7h3.2a3 3 0 0 1 0 6H9.5"/>',
  unload: '<path d="M12 3v11M7.5 9.5 12 14l4.5-4.5"/><path d="M4 14v6h16v-6"/>',
  unhitch: '<path d="M9 7.5 10.5 6a3.5 3.5 0 0 1 5 5L14 12.5M10 16.5 8.5 18a3.5 3.5 0 0 1-5-5L5 11.5"/><path d="M4 4l2.5 2.5M20 20l-2.5-2.5M16 3v2.5M3 16h2.5"/>',
  sound: '<path d="M4 9.5h4l5-4v13l-5-4H4z"/><path d="M16 9a4.5 4.5 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11"/>',
  mute: '<path d="M4 9.5h4l5-4v13l-5-4H4z"/><path d="M16.5 9.5l5 5M21.5 9.5l-5 5"/>',
  quality: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 16l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z"/>',
  save: '<path d="M5 4h11l3 3v13H5z"/><path d="M8 4v5h7V4M8 20v-6h8v6"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.7v.5M12 17.2v.3"/>',
  upgrade: '<path d="M12 20V6M6.5 11.5 12 6l5.5 5.5M5 3.5h14"/>',
  map: '<path d="M3 6.5 9 4l6 2.5L21 4v13.5L15 20l-6-2.5L3 20z"/><path d="M9 4v13.5M15 6.5V20"/>',
  undo: '<path d="M9 7 4 12l5 5"/><path d="M4 12h10a6 6 0 0 1 0 12"/>',
  wheel: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.2"/><path d="M3.5 10.5 9.8 12M14.2 12l6.3-1.5M12 14.2V21"/>',
  fuel: '<path d="M5 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16M3.5 21h13M7.5 7.5h5"/><path d="M15 9h2l2 2.5V17a1.5 1.5 0 0 1-3 0v-3h-1"/>',
  wrench: '<path d="M14.5 6.5a4 4 0 0 0 5 5L12 19a2.1 2.1 0 0 1-3-3l7.5-7.5a4 4 0 0 1-2-2z"/><path d="M14.5 6.5 17 4l3 3-2.5 2.5"/>',
  bank: '<path d="M3 9.5 12 4l9 5.5M4.5 20h15M3 22h18"/><path d="M6 11v7M10 11v7M14 11v7M18 11v7"/>',
  snow: '<path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9"/><path d="M10 4.5 12 6l2-1.5M10 19.5 12 18l2 1.5M4.8 10l2.2-.5-.4-2.3M19.2 14l-2.2.5.4 2.3M4.8 14l2.2.5-.4 2.3M19.2 10l-2.2-.5.4-2.3"/>',
  drop: '<path d="M12 3.5c3 4 6 7.2 6 10.5a6 6 0 0 1-12 0c0-3.3 3-6.5 6-10.5z"/>',
  exit: '<path d="M10 4H5v16h5M14.5 8l4 4-4 4M18.5 12H9"/>',
  lower: '<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M4 20h16"/>',
  raise: '<path d="M12 15V4M7.5 8.5 12 4l4.5 4.5M4 20h16"/>',
  gas: '<rect x="7" y="3" width="10" height="18" rx="2"/><path d="M9.5 7h5M9.5 10h5M9.5 13h5M9.5 16h5"/>',
  brake: '<rect x="4" y="7" width="16" height="10" rx="2"/><path d="M8 10v4M12 10v4M16 10v4"/>',
  // crops
  wheat: '<path d="M12 22V9"/><path d="M12 9c-2-1-3-3-3-5 2 1 3 3 3 5zM12 9c2-1 3-3 3-5-2 1-3 3-3 5zM12 14c-2-1-3-3-3-5 2 1 3 3 3 5zM12 14c2-1 3-3 3-5-2 1-3 3-3 5zM12 19c-2-1-3-3-3-5 2 1 3 3 3 5zM12 19c2-1 3-3 3-5-2 1-3 3-3 5z"/>',
  barley: '<path d="M12 22V9"/><path d="M12 9c-2-1-3-3-3-5 2 1 3 3 3 5zM12 9c2-1 3-3 3-5-2 1-3 3-3 5zM12 14c-2-1-3-3-3-5 2 1 3 3 3 5zM12 14c2-1 3-3 3-5-2 1-3 3-3 5z"/><path d="M9 4 7 1.5M15 4l2-2.5M9 9 6.5 6.5M15 9l2.5-2.5"/>',
  oats: '<path d="M12 22V3"/><path d="M12 6c-3 0-4 2-4 4.5M12 6c3 0 4 2 4 4.5M12 12c-3 0-4 2-4 4.5M12 12c3 0 4 2 4 4.5"/><ellipse cx="8" cy="11.5" rx="1.1" ry="1.9"/><ellipse cx="16" cy="11.5" rx="1.1" ry="1.9"/><ellipse cx="8" cy="17.5" rx="1.1" ry="1.9"/><ellipse cx="16" cy="17.5" rx="1.1" ry="1.9"/>',
  corn: '<path d="M12 3c3 2 4 6 4 10s-2 8-4 8-4-4-4-8 1-8 4-10z"/><path d="M10 8h4M9.5 12h5M10 16h4M12 3v18"/><path d="M8 13c-3 1-4 4-4 8M16 13c3 1 4 4 4 8"/>',
  soy: '<path d="M6 18c-2-4 2-12 8-14 3-1 5 1 4 4-2 6-8 12-12 10z"/><circle cx="10" cy="14" r="1.3"/><circle cx="13" cy="10.5" r="1.3"/><circle cx="16" cy="7" r="1.1"/>',
  canola: '<circle cx="12" cy="8.5" r="1.6"/><path d="M12 6.9c0-2 1-3 0-4.4-1 1.4 0 2.4 0 4.4zM13.6 8.5c2 0 3 1 4.4 0-1.4-1-2.4 0-4.4 0zM12 10.1c0 2-1 3 0 4.4 1-1.4 0-2.4 0-4.4zM10.4 8.5c-2 0-3-1-4.4 0 1.4 1 2.4 0 4.4 0z"/><path d="M12 14.5V22M12 18.5l-3.5-2M12 20l3-1.5"/>',
  sunflower: '<circle cx="12" cy="9" r="3"/><path d="M12 3v1.5M12 13.5V15M6 9h1.5M16.5 9H18M7.8 4.8l1 1M15.2 12.2l1 1M7.8 13.2l1-1M15.2 5.8l1-1"/><path d="M12 15v7M12 19.5c-2-2-4-2-5-1M12 18c2-2 4-2 5-1"/>',
  potato: '<path d="M5 13c-1-5 4-9 9-8s6 5 5 9-5 6-9 5-4-2-5-6z"/><circle cx="9" cy="11" r=".8"/><circle cx="14" cy="9.5" r=".8"/><circle cx="12.5" cy="14.5" r=".8"/>',
  sugarbeet: '<path d="M8 10c0 5 3 9 4 12 1-3 4-7 4-12a4 4 0 0 0-8 0z"/><path d="M12 6c-1-2-3-4-6-4 0 2 2 4 5 4zM12 6c1-2 3-4 6-4 0 2-2 4-5 4zM12 6V3"/><path d="M10 11h2M11 14h3"/>',
};

export type IconName = keyof typeof P;

export function icon(name: string, cls = '') {
  const body = P[name] ?? P.field;
  return `<svg class="ico ${cls}" viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
}

/** Icon names for game concepts. */
export const OP_ICON: Record<string, string> = {
  plow: 'plow', seed: 'seed', harvest: 'harvest', fertilize: 'fertilize', lime: 'lime', roll: 'roll', weed: 'weed', spray: 'spray',
};
export const TOOL_ICON: Record<string, string> = {
  plow: 'plow', seeder: 'seed', wagon: 'wagon', spreader: 'fertilize', roller: 'roll', weeder: 'weed', sprayer: 'spray', planter: 'potato',
};
export const VEHICLE_ICON: Record<string, string> = { tractor: 'tractor', combine: 'combine', rootHarvester: 'rootHarvester' };
export const CROP_ICON: Record<string, string> = {
  wheat: 'wheat', corn: 'corn', soy: 'soy', barley: 'barley', oats: 'oats', canola: 'canola', sunflower: 'sunflower', potato: 'potato', sugarbeet: 'sugarbeet',
};
export const WEATHER_ICON: Record<string, string> = { sun: 'sun', cloudy: 'cloudy', rain: 'rain', storm: 'storm' };
export const SHOP_ICON: Record<string, string> = { ...VEHICLE_ICON, ...TOOL_ICON };
export const UPGRADE_ICON: Record<string, string> = { plow: 'plow', seeder: 'seed', header: 'combine', wagon: 'wagon', engine: 'tractor' };

/** Removes a leading emoji from messages written for the old UI. */
export function stripEmoji(text: string) {
  return text.replace(/^(?:\p{Extended_Pictographic}|\p{Emoji_Presentation})️?\s*/u, '');
}
