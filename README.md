# Harvest Valley

A 3D farming game for mobile (PC later), seen from an angled top-down camera. It's inspired by Farming Simulator but built for touch. Tap a field job and a hired worker does it, or jump into any machine and drive it yourself.

## How to play

1. **Draw a field.** Tap **Draw field**, then tap at least 4 grid corners on land you own. Tap the first corner again, or press **Create**.
2. **Tap the field.** It shows a short to-do list of what it needs right now, like Plow, Plant, Weeds or Harvest, with the most important job first. Each job has two buttons: **Hire** (shows the wage) sends the best free machine with a worker, who fetches the right implement from the farmyard. **Drive** has a worker bring the machine and tool to the corner of the field for free and line it up on the first row with the tool down, then hands you the wheel. If you're missing a machine, the card offers to buy it. **More** lists the other jobs, and **Choose machine** lets you pick one yourself.
3. **Plant.** Pick a crop from the swipeable crop picker: **wheat, barley, oats, corn, soybeans, canola, sunflowers, potatoes** or **sugar beets**. Each has its own grow time, yield and price.
4. **Grow.** Crops grow as real plants that sway in the wind. They keep growing while the game is closed, but slower.
5. **Harvest.** When the field turns golden, tap it and choose **Harvest**.
6. **Haul and sell.** When the combine's tank fills up, a free tractor hitches the grain wagon, drives beside the combine to catch the grain, and takes it to the sell point, or to your silo if you chose that in the Market.

**Field care** raises your yield. The field panel shows it as a percentage:
- 🧪 **Fertilize** (spreader): up to 2 passes per crop, +15% each.
- 🪨 **Lime** (spreader): soil turns sour every few harvests; unlimed soil loses 15%.
- 🛞 **Roll** (roller): right after seeding, +5%.
- 🌿 **Weeds** spread into growing crops and cost 25%. Pull them with a **weeder** while the crop is young, or use a **sprayer** at any stage.

**Root crops:** potatoes and sugar beets need the **root planter** and the self-propelled **root harvester**. Tractors borrow implements from other parked tractors automatically.

**Drive it yourself.** Tap a machine, then **Drive**. The camera drops behind it. One joystick does it all: push up to drive, pull back to brake and reverse, tilt left or right to steer. You bump into buildings, fences and trees. On PC, use WASD or the arrow keys, E for the implement and Esc to get out. **Lower** the tool or header to work the ground you drive over. The buttons change with where you are: **Hitch** a tool behind you (or drop yours anywhere; workers will fetch it from there), **Sell load** at the sell point, **Into silo** at the silo, **Refuel** at the pump. Pull a wagon alongside a harvester to take its grain.

**Running costs.** Hired workers are paid for every second they work, and each job row shows an estimate. You don't pay yourself. Machines burn diesel (the pump is next to the silo; workers top up by themselves) and wear out: under 30% condition they slow down, so repair them from the machine's card. Tap your balance for the farm accounts (today vs. yesterday) and a bank loan with daily interest.

**Seasons.** Each season lasts 4 days: spring, summer, autumn, winter. Every crop has planting seasons (wheat, barley and canola can be sown in autumn), and nothing grows in winter, when snow covers the farm.

**Weather that matters.** Rain soaks the crop, and combines can't cut until the sun dries it. Thunderstorms flatten ripe crops (−40% yield on those cells), especially crops left standing long after they ripen. Tap the clock for the forecast and harvest before a storm.

**Pathfinding.** Hired workers follow the road's center lane, leave the farmyard through its gate, and drive around buildings and other fields instead of across them.

**Market.** Tap a crop in the Market for its two-week price chart, highs and lows, and a **price alert** that messages you the day it sells high (15% over its usual price).

**Day and night.** Daylight lasts about 2½ minutes at 1×, and nights pass in about 20 seconds.

**Landscape.** Tap **Play in landscape** (welcome screen or Settings) to go full screen and lock the phone sideways where the browser allows it. Menus open in a side panel, and the camera shifts so the field or machine you tapped stays in view beside it.

**Machines come alive.** Mounted implements lift on the hitch for the road and drop with a hydraulic hiss to work; tools unfold, spreader discs spin, the wagon tips its box to unload with grain pouring out the back. The combine's header drops to cut, its tank visibly fills and beeps when full, and the auger pours grain. Beacons flash on the job, exhaust puffs harder under load, the machine you drive pitches when accelerating and braking, and nearby machines rumble, crops rustle under the header and grain hisses as it pours.

**Animals.** Open the Shop's **Animals** tab and build a **chicken coop**, **cow barn**, **pig sty** or **sheep pasture** (tap your land to place it; the grid shows green where it fits). Each comes with a few animals. They eat grain from your silo: tap the pen and press **Bring feed**, and a worker hitches a wagon, loads feed at the silo and tips it into the trough, or turn on **Auto-feed** and they'll do it whenever the trough runs low. You can also drive a wagon yourself: **Load feed** at the silo, then **Feed animals** at the pen's gate. Fed animals get happy, and happy animals produce more (eggs, milk, wool, piglets) and raise young. Sell produce from the pen or the Market's **Farm produce** section, where prices move daily. Hungry animals stop producing and get miserable. Animals wander, graze, peck, crowd the trough when it's empty, lie down at night and call out when you're close.

Grow the farm: buy **land plots**, more **machines**, and **upgrades** (wider plows and seeders, bigger combine tanks and wagons, faster tractors). The **market** price for each crop changes daily. Store grain in the silo and sell when prices spike.

Controls: drag to pan, pinch or scroll to zoom, twist two fingers (or use ⟲ ⟳) to rotate, and ⏩ to speed up time.

## Tech

- TypeScript + [Three.js](https://threejs.org/) + Vite
- Every model is built in code and there are no asset files: machines have lugged tires on dished rims with chrome hubs, sloped hoods with vents and badges, glass cabs with seats, steering wheels, mirrors and work lights, three-point linkages, headers with guard teeth, auger flighting and spring-tined reels; front (tractor) or rear (combine) wheels steer as they turn
- Glossy paint, chrome and glass use a small cube-map reflection on Lambert materials (dimmed at night, off in safe mode); corrugated steel, clapboard siding and shingles are canvas textures
- Crops, weeds and meadow grass are individual instanced plants with a wind shader, batched per map chunk
- Physical sky, tone mapping, sun shadows, drifting cloud shadows, soft contact shadows, distant mountain ridges, day/night with stars, moon, headlight beams and a yard lamp, rain, snow and lightning; a safe graphics mode turns on by itself if a shader fails
- Animals are instanced, vertex-colored low-poly herds (one draw call per pen) with per-animal coats
- World dressing: a pond with rippling water, reeds and lily pads, a spinning farm windmill, hay bales, power lines, bushes, rocks, wildflowers and birds
- Static scenery and machine parts are baked into one mesh per material, keeping draw calls low on phones
- Low/Medium/High graphics setting (in Settings)
- The build is a single self-contained `dist/index.html` that runs anywhere, including from a file
- Progress autosaves to `localStorage`

```
src/game/      simulation (pure TS): fields, vehicles, jobs, driving, seasons, weather, costs, market, saving
src/render3d/  Three.js view: camera, ground chunks, instanced crops, models, particles
src/ui/        DOM HUD, bottom sheet, modals
tests/         Vitest tests, including a headless full farming loop
```

## Euro Haul (truck game)

A second game lives in `truck/`: **Euro Haul**, a mobile-first truck driving sim in the spirit of Euro Truck Simulator. Haul freight along an Alpine motorway loop between five depots (Valmont, Nordhaven, Rivabella, Brennwald, Lac Doré).

**How to play.** Pick a job on the depot's job board: cargo, weight, destination, pay and time limit. The loaded trailer (curtain-sider, reefer, container or tanker) waits in a green-lit bay: reverse squarely under it and the fifth wheel locks on (or pay the yard crew €150 to do it). Drive to the destination, where an orange bay and a light beam mark the spot. Stop anywhere in the yard and tap **Deliver**, or back the trailer neatly into the bay for a 10% parking bonus. Damage (barrier hits, crashes) and lateness cut the pay, and fragile cargo is extra sensitive. Collisions with traffic also cost a fine, and speed cameras guard the 80 km/h zones through each town. Refuel and repair at depots.

**Garage.** Save up for the **Titan 580** (€32,000) and the **Apex V8 750** (€78,000), each with its own cab, grille, power and engine sound. Fit engine tunes, a chrome pack, a roof light bar and a triple air horn, and repaint the cab and stripes at any depot.

**Radio.** Three stations of music generated live in the browser: Alpen FM (lo-fi), Autobahn Wave (synthwave) and Route 66 (blues). It plays clear in the cab and muffled outside.

**Controls (touch).** An on-screen steering wheel you turn with a finger (or **Tilt** or **Buttons** steering in Settings), **GAS** and **BRAKE** pedals, **R/N/D**, headlights (auto, on, high beam, off), horn, cruise control, indicators and hazards. Drag the view to look around and pinch to zoom. The camera button cycles chase, cab (live dashboard gauges), cinematic TV shots and wheel cam. **Keyboard:** WASD/arrows, Space handbrake, R/N/F gears, C camera, L lights, H horn, K cruise, Q/E indicators, Esc menu.

**Driving model.** A 460 hp-class diesel torque curve, 12-speed automated gearbox with skip-shifts, air brakes, engine braking, hill hold, a 90 km/h speed limiter, aero drag, rolling resistance and real hill grades (heavy loads slow down on climbs). The trailer is a kinematic articulated model, so it cuts corners and jack-knifes if you reverse carelessly. Speed-dependent steering lock keeps highway driving stable.

**World and graphics.** Everything is generated at startup, with no asset files:
- 8.5 km dual-carriageway loop with lane markings, a concrete median barrier, guard rails, delineators, street lights near towns, overhead exit gantries, speed signs and speed cameras, and a tall viaduct over a river gorge
- Terrain with fields (wheat, rapeseed, sunflowers…), lakes, forests, hedgerows, wind turbines, towns with churches and apartment blocks, and a ring of snow-capped mountains
- AI traffic (cars, vans and other trucks) that follows lanes, overtakes, keeps right, signals and brakes for you
- Procedural sky with sun, moon, stars, a milky way and drifting lit clouds; day/night cycle; clear, cloudy and rain weather with wet roads, spray and rain streaks
- HDR pipeline: image-based reflections baked from the sky, clear-coat paint, PCF soft shadows, bloom, lens flare, colour grading, vignette and film grain; headlight beams and street lamps light the road at night
- A GPU grass carpet around the camera, and wheat, rapeseed and sunflower crops rippling in the fields
- Leafy trees made from painted foliage cards up close (broadleafs, firs, poplars, hedges), cheaper solid crowns in the distance
- Moving cloud shadows, god rays through trees and peaks, and live rear-view mirrors in the cab (High and Ultra)
- Synthesised audio: a sample-level diesel (every cylinder firing modelled, with exhaust and chassis resonance, combustion knock, injector clatter and a spooling turbo; the V8 fires unevenly for its burble) running in an AudioWorklet; tyre roar and tread hum, wind, rain hiss and roof drumming, a multi-tone air horn, reverse beeper, indicator relay, gearshift clunks, air-brake sighs, brake squeal, expansion joints on the viaduct, passing traffic with pan and doppler, drivers honking when you cut them up, birds by day and crickets at night. Sitting in the cab muffles the outside world

**Phones.** Graphics tiers (Low, Medium, High, Ultra) are picked automatically from the device and can be changed in Settings. Dynamic resolution keeps the frame rate up, and Low skips the HDR pipeline on GPUs that can't render to float targets. Play in landscape; the title screen has a full-screen button.

```
truck/src/sim/     simulation (pure TS): road network, terrain, truck physics, traffic, jobs, game rules
truck/src/render/  Three.js view: sky, landscape, roadside, scenery, grass, vehicles, effects, cameras, post
truck/src/ui/      HUD, touch controls, sat-nav, menus
```

## Develop

```bash
npm install
npm run dev        # local dev server
npm test           # unit + simulation tests
npm run build      # typecheck + single-file builds: dist/index.html and dist/truck/index.html
npm run dev:truck  # dev server for Euro Haul
```

## Roadmap ideas

- Contracts, more animals and more machines
- Wrap for the iOS/Android stores (Capacitor) and PC (Electron/Steam)
