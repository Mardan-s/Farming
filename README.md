# Harvest Valley

A 3D farming game for mobile (PC later), seen from an angled top-down camera. It's inspired by Farming Simulator but built for touch. You never drive by hand: tap a machine, tap a job, and it does the work.

## How to play

1. **Draw a field.** Tap ✏️ **New field**, then tap at least 4 grid corners on land you own. Tap the first corner again, or press **Create**.
2. **Plow.** Tap the tractor, tap the field, and choose **Plow**. The tractor drives to the farmyard, hitches the plow, and plows the field in rows.
3. **Seed.** Send the tractor back and pick a crop: **wheat, barley, oats, corn, soybeans, canola** or **sunflowers**. Each has its own grow time, yield and price. The tractor swaps to the seeder by itself.
4. **Grow.** Crops grow through visible stages. They keep growing while the game is closed, but slower.
5. **Harvest.** When the field turns golden, tap the combine and then the field.
6. **Haul and sell.** When the combine's tank fills up, a free tractor hitches the grain wagon, drives beside the combine to catch the grain, and takes it to the sell point, or to your silo if you chose that in the Market.

Grow the farm: buy **land plots**, more **machines**, and **upgrades** (wider plows and seeders, bigger combine tanks and wagons, faster tractors). The **market** price for each crop changes daily. Store grain in the silo and sell when prices spike.

Controls: drag to pan, pinch or scroll to zoom, twist two fingers (or use ⟲ ⟳) to rotate, and ⏩ to speed up time.

## Tech

- TypeScript + [Three.js](https://threejs.org/) + Vite
- Every model is low-poly geometry built in code, and ground textures are drawn on canvases, so there are no asset files
- Crops are instanced 3D rows that grow taller at each stage; there is real-time sun shadow and a day/night cycle
- The build is a single self-contained `dist/index.html` that runs anywhere, including from a file
- Progress autosaves to `localStorage`

```
src/game/      simulation (pure TS, no Phaser): fields, vehicles, jobs, market, saving
src/render3d/  Three.js view: camera, ground chunks, instanced crops, models, particles
src/ui/        DOM HUD, bottom sheet, modals
tests/         Vitest tests, including a headless full farming loop
```

## Develop

```bash
npm install
npm run dev        # local dev server
npm test           # unit + simulation tests
npm run build      # typecheck + single-file build into dist/
```

## Roadmap ideas

- Roads and pathfinding around fields
- Fertilizer, weeds, and crop yield quality
- More crops (canola, sunflowers, potatoes), livestock, and contracts
- Wrap for the iOS/Android stores (Capacitor) and PC (Electron/Steam)
