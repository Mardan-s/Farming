import './style.css';
import * as THREE from 'three';
import { World } from './sim/world';
import { Game, Weather } from './sim/game';
import type { Job } from './sim/jobs';
import { SETTINGS, Settings, TIERS, Tier, isMobile, saveTier, savedTier } from './render/quality';
import { setMaxAniso } from './render/textures';
import { setClearcoat } from './render/materials';
import { Sky } from './render/sky';
import { Landscape } from './render/landscape';
import { Roadside } from './render/roadside';
import { Scenery } from './render/scenery';
import { Grass } from './render/grass';
import { updateCloudShadows } from './render/cloudShadows';
import { RigView } from './render/rig';
import { TrafficView } from './render/trafficView';
import { Rain, makeFx } from './render/fx';
import { CameraRig, CamMode } from './render/cameraRig';
import { TRUCK_MODELS } from './sim/trucks';
import { STATIONS } from './radio';
import { Post } from './render/post';
import { Hud } from './ui/hud';
import { Input, SteerMode } from './ui/input';
import { Audio, TrafficSound } from './audio';
import { clamp, lerp, smoothstep } from './util';

// Sun glints on near-mirror surfaces can exceed the half-float range and turn into infinities that
// bloom then smears over the whole screen. Clamp every material's output to a sane HDR maximum.
THREE.ShaderChunk.opaque_fragment = THREE.ShaderChunk.opaque_fragment.replace(
  'gl_FragColor = vec4( outgoingLight, diffuseColor.a );',
  'gl_FragColor = vec4( min( outgoingLight, vec3( 40.0 ) ), diffuseColor.a );',
);

const PREFS_KEY = 'eurohaul-prefs';
interface Prefs { steer: SteerMode; volume: number; fps: boolean }

function loadPrefs(): Prefs {
  const def: Prefs = { steer: 'wheel', volume: 0.8, fps: false };
  try { return { ...def, ...(JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<Prefs>) }; } catch { return def; }
}
function savePrefs(p: Prefs) { try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* storage unavailable */ } }

const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

/** Probes float render target support before the real renderer exists (it decides antialiasing). */
function probeFloat() {
  const c = document.createElement('canvas');
  const gl = c.getContext('webgl2');
  if (!gl) return false;
  const ok = !!(gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float'));
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  return ok;
}

function pickTier(canFloat: boolean): Tier {
  const saved = savedTier();
  if (saved) return saved;
  if (!canFloat) return 'low';
  const cores = navigator.hardwareConcurrency || 4;
  if (isMobile()) return cores >= 8 ? 'high' : cores >= 6 ? 'medium' : 'low';
  return 'high';
}

async function boot() {
  const prefs = loadPrefs();
  const canFloat = probeFloat();
  const tier = pickTier(canFloat);
  const cfg: Settings = { ...SETTINGS[tier] };
  if (!canFloat) { cfg.post = false; cfg.envMap = false; }
  const lampLights = tier === 'low' ? 0 : tier === 'medium' ? 2 : 4;

  const renderer = new THREE.WebGLRenderer({ antialias: !cfg.post, powerPreference: 'high-performance', stencil: false, preserveDrawingBuffer: location.search.includes('shot') });
  const basePR = Math.min(window.devicePixelRatio || 1, cfg.pixelRatio);
  renderer.setPixelRatio(basePR);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = cfg.shadowSize > 0;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  document.getElementById('game')!.appendChild(renderer.domElement);
  setMaxAniso(Math.min(8, renderer.capabilities.getMaxAnisotropy()));
  setClearcoat(cfg.clearcoat);

  const input = new Input();
  input.mode = prefs.steer;
  const audio = new Audio();
  audio.setVolume(prefs.volume);

  // Loading screen while the world is generated.
  const loadingHost = document.getElementById('ui')!;
  const loadEl = document.createElement('div');
  loadEl.className = 'loading';
  loadEl.innerHTML = '<div><div class="brand">Euro<br>Haul</div><div class="bar"><i></i></div><p>Loading…</p></div>';
  loadingHost.appendChild(loadEl);
  const progress = async (f: number, text: string) => {
    (loadEl.querySelector('.bar i') as HTMLElement).style.width = `${Math.round(f * 100)}%`;
    loadEl.querySelector('p')!.textContent = text;
    await frame();
  };
  try { await Promise.race([document.fonts.load('800 40px "Barlow Condensed"'), new Promise((r) => setTimeout(r, 1500))]); } catch { /* fonts optional */ }

  await progress(0.05, 'Surveying the Alps…');
  const world = new World(11, cfg.trees);
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x9fb6cc, 0.00032);
  await progress(0.3, 'Painting the sky…');
  const sky = new Sky(scene, cfg.shadowSize, cfg.shadowRange);
  if (cfg.envMap) sky.enableEnv(renderer);
  await progress(0.4, 'Shaping the valleys…');
  const land = new Landscape(world);
  scene.add(land.group);
  await progress(0.55, 'Laying asphalt…');
  const roadside = new Roadside(world);
  scene.add(roadside.group);
  await progress(0.7, 'Planting forests and building towns…');
  const scenery = new Scenery(world, tier === 'low', cfg.post && cfg.msaa > 0);
  scene.add(scenery.group);
  const grass = cfg.grass > 0 ? new Grass(world, cfg.grass, (x, z, out) => land.groundColor(x, z, out)) : null;
  if (grass) scene.add(grass.mesh);
  const crops = cfg.grass > 0 ? new Grass(world, Math.round(cfg.grass * 0.6), (x, z, out) => land.cropColor(x, z, out), true) : null;
  if (crops) scene.add(crops.mesh);
  await progress(0.85, 'Fuelling the truck…');

  let hud: Hud | null = null;
  const fx = makeFx();
  scene.add(fx.smoke.points, fx.spray.points, fx.sparks.points);
  const rain = new Rain(isMobile() ? 2200 : 3500);
  scene.add(rain.lines);
  const cam = new CameraRig(window.innerWidth / window.innerHeight, world);
  scene.add(cam.camera);

  const game = new Game(world, cfg.traffic, {
    toast: (t, k) => hud?.toast(t, k),
    crash: (s, x, y, z) => {
      audio.crash(s);
      cam.bump(Math.min(1, s * 1.5));
      for (let i = 0; i < 30 * Math.min(1, s + 0.3); i++) fx.sparks.emit(x, y, z, (Math.random() - 0.5) * 9, Math.random() * 6, (Math.random() - 0.5) * 9, 0.18, -0.1, 0.6 + Math.random() * 0.5, 1);
    },
    scrape: (x, z, sp) => {
      if (Math.random() < 0.6) {
        const y = world.groundHeight(x, z) + 0.6;
        for (let i = 0; i < 3; i++) fx.sparks.emit(x, y, z, (Math.random() - 0.5) * 4, Math.random() * 3, (Math.random() - 0.5) * 4, 0.12, -0.05, 0.4, Math.min(1, sp / 15));
      }
    },
    delivered: (d, job) => {
      audio.cash();
      rig.dropTrailer();
      roadside.setMarker(null);
      hud?.showReport(d, job, world.depots[job.to]);
    },
    arrived: (d) => {
      if (game.job?.to === d.id) hud?.toast(`Arrived at ${d.company} · park in the glowing bay`, 'good');
      else hud?.toast(`${d.company} · ${d.name}${d.fuel ? ' · fuel' : ''}`, 'info');
    },
    speedCam: (kmh, limit, fine) => {
      roadside.flash();
      audio.cameraClick();
      hud?.flash();
      hud?.toast(`Speed camera: ${kmh} km/h in a ${limit} zone · fine €${fine}`, 'bad');
    },
    trailerReady: (job) => {
      rig.setTrailer(job.cargo.trailer, job.livery);
      roadside.setMarker(world.depots[game.depotId], true);
    },
    coupled: (job) => {
      const d = world.depots[job.to];
      roadside.setMarker(d);
      audio.couple();
      hud?.toast(`Trailer coupled · deliver to ${d.name}`, 'good');
    },
  });
  game.onShift = () => audio.shiftHiss();
  audio.cylinders = TRUCK_MODELS[game.model].cylinders;
  audio.bigHorn = game.upgrades.has('horn');
  const rig = new RigView(scene, world, game.look, lampLights >= 2 ? 2 : 1, tier === 'ultra' ? 160 : tier === 'high' ? 120 : 0);
  const traffic = new TrafficView(scene, game.traffic, world.road);

  // Street lamps light the road around the truck at night with a few real point lights.
  const lampPool: THREE.PointLight[] = [];
  for (let i = 0; i < lampLights; i++) {
    const l = new THREE.PointLight(0xffcf9a, 0, 48, 1.6);
    scene.add(l);
    lampPool.push(l);
  }
  let lampT = 0;

  let post: Post | null = cfg.post ? new Post(renderer, scene, cam.camera, cfg.msaa) : null;
  const resize = (scale = 1) => {
    const w = window.innerWidth, h = window.innerHeight;
    const pr = basePR * scale;
    renderer.setPixelRatio(pr);
    renderer.setSize(w, h);
    post?.setSize(w, h, pr);
    cam.camera.aspect = w / h;
    cam.camera.updateProjectionMatrix();
    for (const p of [fx.smoke, fx.spray, fx.sparks]) p.setViewport(h * pr, cam.camera.fov);
  };
  let resScale = 1;
  const shotMode = location.search.includes('shot');
  window.addEventListener('resize', () => resize(resScale));
  window.visualViewport?.addEventListener('resize', () => resize(resScale));
  resize();

  // ---- HUD and actions
  let started = false;
  let camBefore: CamMode = 'chase';
  let paused = false;
  const lightsCycle = ['auto', 'on', 'high', 'off'] as const;
  const settings = { tier, steer: prefs.steer, time: null as number | null, weather: null as Weather | null, volume: prefs.volume, fps: prefs.fps, canFloat };
  hud = new Hud(game, input, {
    start: () => {
      started = true;
      audio.start();
      cam.mode = 'chase';
      hud!.showHud(true);
      if (!game.job && game.atDepot) setTimeout(() => hud!.showJobs(), 600);
    },
    cam: () => { cam.next(); rig.setInterior(cam.mode === 'cab'); hud!.toast(({ chase: 'Chase camera', cab: 'Cab view', cinematic: 'Cinematic camera', wheel: 'Wheel camera', showcase: 'Showcase', free: 'Free camera' } as const)[cam.mode]); },
    lights: () => {
      game.headMode = lightsCycle[(lightsCycle.indexOf(game.headMode) + 1) % lightsCycle.length];
      hud!.toast(({ auto: 'Headlights: auto', on: 'Headlights on', high: 'High beam', off: 'Headlights off' } as const)[game.headMode]);
      audio.click();
    },
    horn: (d) => { game.horn = d; },
    cruise: () => {
      const t = game.truck;
      if (t.cruise != null) { t.cruise = null; hud!.toast('Cruise control off'); }
      else if (t.speed > 8 && t.drive === 'D') { t.cruise = Math.round(t.speed * 3.6 / 5) * 5 / 3.6; hud!.toast(`Cruise control ${Math.round(t.cruise * 3.6)} km/h`, 'good'); }
      else hud!.toast('Cruise control works above 30 km/h');
      audio.click();
    },
    drive: (d) => {
      const t = game.truck;
      if (d !== t.drive && d !== 'N' && t.drive !== 'N' && Math.abs(t.speed) > 1) { hud!.toast('Stop before changing direction', 'bad'); return; }
      t.drive = d;
      if (d === 'R') t.gear = 1;
      audio.click();
    },
    ind: (side) => {
      game.hazard = false;
      if (side === 'L') { game.indL = !game.indL; game.indR = false; } else { game.indR = !game.indR; game.indL = false; }
      audio.click();
    },
    hazard: () => { game.hazard = !game.hazard; audio.click(); },
    radio: () => {
      audio.start();
      const st = audio.radio?.cycle() ?? -1;
      hud!.toast(st < 0 ? 'Radio off' : `${STATIONS[st].name} · ${STATIONS[st].genre}`, 'info');
      document.querySelector('[data-a="radio"]')?.classList.toggle('on', st >= 0);
    },
    roof: () => { game.roofLights = !game.roofLights; },
    accept: (job: Job) => { game.accept(job); },
    deliver: () => { game.deliver(); },
    refuel: () => game.refuel(),
    repair: () => game.repair(),
    cancelJob: () => { game.cancelJob(); rig.setTrailer(null); roadside.setMarker(null); },
    couple: () => game.couple(),
    crewCouple: () => game.crewCouple(),
    setTier: (t) => { saveTier(t); game.save(); location.reload(); },
    setSteer: (m) => {
      input.mode = m; prefs.steer = m; savePrefs(prefs);
      if (m === 'tilt') void input.enableTilt().then((ok) => { if (!ok) hud!.toast('Tilt steering needs motion access', 'bad'); else hud!.toast('Hold the phone level to centre'); });
    },
    setTime: (h) => { game.fixedHour = h; },
    setWeather: (w) => { game.fixedWeather = w; if (w) game.weather = w; },
    setColor: (c) => { game.color = c; rig.fit(game.look); game.save(); },
    setAccent: (c) => { game.accent = c; rig.fit(game.look); game.save(); },
    garage: (open) => {
      hud!.showHud(!open);
      if (open) { camBefore = cam.mode; cam.mode = 'showcase'; rig.setInterior(false); }
      else { cam.mode = camBefore; rig.setInterior(cam.mode === 'cab'); }
    },
    preview: (model) => rig.fit(model == null ? game.look : { ...game.look, model, chrome: game.look.chrome || !!TRUCK_MODELS[model].dressed, lightbar: game.look.lightbar || (!!TRUCK_MODELS[model].dressed && TRUCK_MODELS[model].style === 'cabover') }),
    chooseTruck: (id) => {
      const ok = game.chooseTruck(id);
      if (ok) { rig.fit(game.look); audio.cylinders = TRUCK_MODELS[game.model].cylinders; } else hud!.toast('Not enough money yet', 'bad');
      return ok;
    },
    buyUpgrade: (id) => { if (game.buyUpgrade(id)) { rig.fit(game.look); audio.bigHorn = game.upgrades.has('horn'); } },
    setVolume: (v) => { audio.setVolume(v); prefs.volume = v; savePrefs(prefs); },
    toggleFps: () => { prefs.fps = settings.fps; savePrefs(prefs); },
    fullscreen: () => {
      const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> };
      const req = el.requestFullscreen?.bind(el) ?? el.webkitRequestFullscreen?.bind(el);
      void req?.().then(() => (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }).lock?.('landscape')).catch(() => {});
    },
    reset: () => { try { localStorage.removeItem('eurohaul-save-v1'); } catch { /* ignore */ } location.reload(); },
    pause: (on) => { paused = on; },
  }, settings);
  if (prefs.steer === 'tilt') void input.enableTilt();

  input.onAction = (a) => {
    if (!started) return;
    const t = game.truck;
    if (a === 'cam') { cam.next(); rig.setInterior(cam.mode === 'cab'); }
    else if (a === 'lights') game.headMode = lightsCycle[(lightsCycle.indexOf(game.headMode) + 1) % lightsCycle.length];
    else if (a === 'horn-down') game.horn = true;
    else if (a === 'horn-up') game.horn = false;
    else if (a === 'reverse') { if (Math.abs(t.speed) < 1) { t.drive = 'R'; t.gear = 1; } }
    else if (a === 'neutral') t.drive = 'N';
    else if (a === 'drive') { if (t.speed > -1) t.drive = 'D'; }
    else if (a === 'cruise') t.cruise = t.cruise != null ? null : t.speed > 8 ? t.speed : null;
    else if (a === 'indL') { game.indL = !game.indL; game.indR = false; }
    else if (a === 'indR') { game.indR = !game.indR; game.indL = false; }
    else if (a === 'hazard') game.hazard = !game.hazard;
    else if (a === 'roof') game.roofLights = !game.roofLights;
    else if (a === 'menu') { if (hud!.overlayOpen) hud!.close(); else hud!.showMenu(); }
    else if (a === 'jobs' && game.atDepot && !game.job) hud!.showJobs();
    else if (a === 'action') { if (game.canCouple()) game.couple(); else if (game.canDeliver()) game.deliver(); }
  };

  // Orbit / look around by dragging the 3D view, pinch to zoom.
  const ptrs = new Map<number, { x: number; y: number }>();
  let pinch = 0;
  const canvas = renderer.domElement;
  canvas.addEventListener('pointerdown', (e) => { canvas.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY }); pinch = 0; audio.start(); });
  canvas.addEventListener('pointermove', (e) => {
    const p = ptrs.get(e.pointerId);
    if (!p) return;
    if (ptrs.size === 1) cam.drag(e.clientX - p.x, e.clientY - p.y);
    p.x = e.clientX; p.y = e.clientY;
    if (ptrs.size === 2) {
      const [a, b] = [...ptrs.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch) cam.zoom(pinch / d);
      pinch = d;
    }
  });
  rig.gpsSource = document.querySelector<HTMLCanvasElement>('.gps canvas');
  const up = (e: PointerEvent) => { ptrs.delete(e.pointerId); pinch = 0; };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('wheel', (e) => { cam.zoom(e.deltaY > 0 ? 1.08 : 0.92); }, { passive: true });

  // Spawn the rig and warm up the sky before showing anything.
  game.truck.update(0.016, { throttle: 0, brake: 1, steer: 0, handbrake: false });
  cam.mode = 'showcase';
  await progress(1, 'Ready');
  loadEl.classList.add('done');
  setTimeout(() => loadEl.remove(), 700);
  hud.showTitle();

  // ---- main loop
  let last = performance.now();
  let time = 0;
  let fpsAvg = 60, perfT = 0, perfFrames = 0, perfAcc = 0;
  const sunV = new THREE.Vector3();
  const sunScreen = new THREE.Vector2();
  const focus = new THREE.Vector3();
  const windV = new THREE.Vector3(1.2, 0, 0.6);
  const relWind = new THREE.Vector3();
  const camFwd = new THREE.Vector3();
  const carPos = { x: 0, y: 0, z: 0 };
  const carTan = { x: 0, y: 0, z: 0, tx: 0, tz: 1 };
  const joints: number[] = [];
  for (let s = world.river.s - world.bridgeHalf; s <= world.river.s + world.bridgeHalf; s += 38) joints.push(s);
  let lastFront = game.roadS;

  const loop = () => {
    requestAnimationFrame(loop);
    const now = performance.now();
    const rawDt = (now - last) / 1000;
    last = now;
    const dt = Math.min(0.05, rawDt);
    time += dt;
    const t = game.truck;
    try {
      if (started && !paused) {
        input.update(dt);
        game.update(dt, { throttle: input.throttle, brake: input.brake, steer: input.steer, handbrake: input.handbrake });
      } else if (!started) {
        game.update(dt, { throttle: 0, brake: 1, steer: 0, handbrake: true });
      }
    } catch (err) { console.error('[sim]', err); }

    const night = sky.night;
    focus.set(t.x, rig.tractor.root.position.y, t.z);
    sky.update(game.hours, game.cloud, game.rain, time, focus, cam.camera);
    if (cfg.envMap) sky.updateEnv(time);
    updateCloudShadows(time, game.cloud, sky.sunDir.y);
    const fog = scene.fog as THREE.FogExp2;
    fog.color.copy(sky.fogColor);
    fog.density = 0.00014 + game.cloud * 0.0001 + game.rain * 0.0015 + sky.night * 0.0001;
    renderer.toneMappingExposure = lerp(1.0, 1.5, night) * (1 + game.cloud * 0.12);
    roadside.roadMat.roughness = 1 - game.wet * 0.55;
    roadside.roadMat.color.setScalar(1 - game.wet * 0.35);

    const lights = {
      head: game.lightsOn(night), high: game.headMode === 'high', brake: t.braking > 0.05 ? Math.min(1, t.braking * 1.5) : 0,
      tail: game.lightsOn(night) || night > 0.2, indL: game.indL || game.hazard, indR: game.indR || game.hazard,
      reverse: t.drive === 'R', roof: game.roofLights || (night > 0.4 && game.lightsOn(night)),
    };
    rig.pickup = game.pickup;
    rig.update(dt, time, t, lights, night, game.rain, fx, game.wet);
    traffic.update(dt, night);
    land.update(time);
    const wind = 0.6 + game.rain * 1.4 + game.cloud * 0.4;
    scenery.update(time, night, cam.camera.position, wind);
    grass?.update(cam.camera, time, wind);
    crops?.update(cam.camera, time, wind * 1.3);
    roadside.update(time, night, cam.camera.position.distanceTo(focus));

    lampT -= dt;
    if (lampT <= 0 && lampPool.length) {
      lampT = 0.3;
      const near = roadside.lamps
        .map((l) => ({ l, d: (l.x - t.x) ** 2 + (l.z - t.z) ** 2 }))
        .sort((a, b) => a.d - b.d)
        .slice(0, lampPool.length);
      lampPool.forEach((pl, i) => {
        const n = near[i];
        if (n && n.d < 140 * 140) { pl.position.set(n.l.x, n.l.y, n.l.z); pl.intensity = night > 0.3 ? 420 : 0; }
        else pl.intensity = 0;
      });
    }

    relWind.copy(windV).multiplyScalar(1 + game.rain).sub(new THREE.Vector3(Math.sin(t.heading) * t.speed, 0, Math.cos(t.heading) * t.speed));
    fx.smoke.update(dt, windV);
    fx.spray.update(dt, windV);
    fx.sparks.update(dt, windV);
    rain.update(time, cam.camera.position, game.rain, relWind, 1 - night);

    cam.update(dt, t, rig, time);

    // Sun flare: where is the sun on screen, and is it in front of us?
    sunV.copy(cam.camera.position).addScaledVector(sky.sunDir, 1000).project(cam.camera);
    let sunAmt = 0;
    if (sunV.z < 1 && Math.abs(sunV.x) < 1.3 && Math.abs(sunV.y) < 1.3) {
      sunScreen.set((sunV.x + 1) / 2, (sunV.y + 1) / 2);
      sunAmt = smoothstep(-0.02, 0.1, sky.sunDir.y) * (1 - clamp(game.cloud * 1.2, 0, 0.95)) * (1 - smoothstep(0.85, 1.3, Math.max(Math.abs(sunV.x), Math.abs(sunV.y))));
      if (cam.mode === 'cab') sunAmt *= 0.6;
    }
    try {
      rig.renderMirrors(renderer, scene);
      if (post) post.rays = tier === 'high' || tier === 'ultra' ? 1 : 0;
      if (post) post.render(time, night, sunAmt > 0 ? sunScreen : null, sunAmt, sky.sun.color, game.wet);
      else renderer.render(scene, cam.camera);
    } catch (err) {
      // If the HDR pipeline fails on this GPU, fall back to direct rendering for good.
      console.error('[render]', err);
      if (post) { post = null; hud?.toast('Effects turned off for this device', 'bad'); }
    }

    audio.radio?.setPlace(cam.mode === 'cab', settings.volume);
    audio.update(dt, { rpm: t.rpm, load: t.load, speed: t.speed, rain: game.rain, horn: game.horn, braking: t.braking, indicator: (game.indL || game.indR || game.hazard) && started, interior: cam.mode === 'cab', reverse: t.drive === 'R' && started, night });
    // Traffic and honks are heard from the camera: panned left/right of where it looks.
    cam.camera.getWorldDirection(camFwd);
    const camRight = { x: -camFwd.z, z: camFwd.x };
    const rl = Math.hypot(camRight.x, camRight.z) || 1;
    const tvx = Math.sin(t.heading) * t.speed, tvz = Math.cos(t.heading) * t.speed;
    const near: TrafficSound[] = [];
    for (const c of game.traffic.cars) {
      if (Math.abs(world.road.delta(c.s, game.roadS)) > 120) continue;
      const p = world.road.toWorld(c.s, c.lat, carPos);
      const dx = p.x - cam.camera.position.x, dz = p.z - cam.camera.position.z, dist = Math.hypot(dx, dz) || 1;
      const tg = world.road.sample(c.s, carTan);
      const rvx = tg.tx * c.speed * c.dir - tvx, rvz = tg.tz * c.speed * c.dir - tvz;
      near.push({ pan: ((dx * camRight.x + dz * camRight.z) / rl) / dist, dist, closing: -(rvx * dx + rvz * dz) / dist, truck: c.kind === 'truck' });
    }
    audio.updateTraffic(near);
    for (const c of game.traffic.honks) {
      const p = world.road.toWorld(c.s, c.lat, carPos);
      const dx = p.x - cam.camera.position.x, dz = p.z - cam.camera.position.z, dist = Math.hypot(dx, dz) || 1;
      audio.honk(((dx * camRight.x + dz * camRight.z) / rl) / dist, dist);
    }
    game.traffic.honks = [];
    // Expansion joints on the viaduct: a thump for every axle of the rig.
    for (const js of joints) {
      const front = game.roadS + game.truck.wheelbase;
      if (world.road.delta(lastFront, js) > 0 && world.road.delta(front, js) <= 0 && Math.abs(world.road.delta(front, js)) < 20 && game.roadLat > 0) {
        audio.joint(Math.abs(t.speed), t.hasTrailer ? [0, 3.9, 12.54, 13.85, 15.16] : [0, 3.9]);
      }
    }
    lastFront = game.roadS + game.truck.wheelbase;

    fpsAvg = lerp(fpsAvg, 1 / Math.max(1e-3, rawDt), 0.05);
    hud!.update(dt, fpsAvg);

    // Dynamic resolution: trade pixels for frame rate on slower phones.
    perfT += rawDt; perfFrames++; perfAcc += rawDt;
    if (perfT > 2 && !shotMode) {
      const fps = perfFrames / perfAcc;
      perfT = 0; perfFrames = 0; perfAcc = 0;
      const prev = resScale;
      if (fps < 42 && resScale > 0.55) resScale = Math.max(0.55, resScale - 0.1);
      else if (fps > 57 && resScale < 1) resScale = Math.min(1, resScale + 0.05);
      if (prev !== resScale) resize(resScale);
    }
  };
  requestAnimationFrame(loop);
  (window as unknown as { __game: unknown }).__game = {
    game, cam, rig, renderer, scene, sky, grass, audio, TIERS,
    /** Debug helper: jump straight to a time of day and weather. */
    set: (o: { hours?: number; cloud?: number; rain?: number; wet?: number }) => {
      if (o.hours != null) { game.hours = o.hours; game.fixedHour = o.hours; }
      if (o.cloud != null) game.cloud = o.cloud;
      if (o.rain != null) game.rain = o.rain;
      if (o.wet != null) game.wet = o.wet;
      game.fixedWeather = o.rain ? 'rain' : o.cloud != null && o.cloud > 0.5 ? 'cloudy' : 'clear';
    },
  };
}

void boot();
