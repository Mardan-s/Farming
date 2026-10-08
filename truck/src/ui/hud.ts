import type { Game, Weather } from '../sim/game';
import type { Delivery, Job } from '../sim/jobs';
import type { Depot } from '../sim/world';
import { FUEL_CAP } from '../sim/truck';
import { formatMoney } from '../util';
import { ACCENTS, GARAGE_ORDER, TRUCK_MODELS, UPGRADES, UpgradeId } from '../sim/trucks';
import type { Tier } from '../render/quality';
import { ICON, WHEEL_SVG } from './icons';
import { Input, SteerMode } from './input';
import { Minimap } from './minimap';

// The on-screen HUD and all menus. Everything is plain DOM over the WebGL canvas.

export interface HudActions {
  start(): void;
  cam(): void;
  lights(): void;
  horn(down: boolean): void;
  cruise(): void;
  drive(d: 'D' | 'N' | 'R'): void;
  ind(side: 'L' | 'R'): void;
  hazard(): void;
  radio(): void;
  roof(): void;
  accept(job: Job): void;
  deliver(): void;
  refuel(): void;
  repair(): void;
  cancelJob(): void;
  couple(): void;
  crewCouple(): void;
  setTier(t: Tier): void;
  setSteer(m: SteerMode): void;
  setTime(h: number | null): void;
  setWeather(w: Weather | null): void;
  setColor(c: number): void;
  setAccent(c: number): void;
  garage(open: boolean): void;
  preview(model: number | null): void;
  chooseTruck(id: number): boolean;
  buyUpgrade(id: UpgradeId): void;
  setVolume(v: number): void;
  toggleFps(): void;
  fullscreen(): void;
  reset(): void;
  pause(on: boolean): void;
}

const h = (html: string) => {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild as HTMLElement;
};

const PAINTS = [0xb3141b, 0xf2f2f2, 0x0d2f6b, 0x111214, 0xe07a10, 0x2c6e3f, 0x6a1b9a, 0xc9a227];

export interface HudSettings { tier: Tier; steer: SteerMode; time: number | null; weather: Weather | null; volume: number; fps: boolean; canFloat: boolean }

export class Hud {
  readonly root: HTMLElement;
  private hud: HTMLElement;
  private minimap: Minimap;
  private el: Record<string, HTMLElement> = {};
  private overlay: HTMLElement | null = null;
  private actionsKey = '';
  private last: Record<string, string> = {};
  private mapT = 0;
  paused = false;

  /** In the cab view the dashboard shows speed and gear, so the HUD gets out of its way. */
  setCabView(on: boolean) {
    if (this.hud.classList.contains('cabview') !== on) this.hud.classList.toggle('cabview', on);
  }

  constructor(private game: Game, input: Input, private act: HudActions, private settings: HudSettings) {
    this.root = document.getElementById('ui')!;
    this.hud = h(`<div class="hud hidden">
      <div class="gps glass"><canvas></canvas><div class="info"><b data-k="dist">—</b><span data-k="eta"></span></div><div class="job-line" data-k="job">No cargo · pick a job at the depot</div></div>
      <div class="topright">
        <div class="wallet glass"><div class="money" data-k="money"></div><div class="lvl"><i data-k="xp"></i></div><small data-k="level"></small></div>
        <button class="ib glass" data-a="cam" aria-label="Camera">${ICON.camera}</button>
        <button class="ib glass" data-a="menu" aria-label="Menu">${ICON.menu}</button>
      </div>
      <div class="toasts"></div>
      <div class="actions"></div>
      <div class="cluster glass">
        <div class="limit" data-k="limit">90</div>
        <div class="speed" data-k="speedbox"><b data-k="speed">0</b><small>KM/H</small></div>
        <div class="gearbox">
          <div class="gear" data-k="gear">D1</div>
          <div class="rpm"><i data-k="rpm"></i></div>
          <div class="bars"><span>${ICON.fuel.replace('<svg', '<svg width="11" height="11"')}<em data-k="fuel"></em></span><span>${ICON.wrench.replace('<svg', '<svg width="11" height="11"')}<em data-k="dmg"></em></span></div>
          <div class="cruise-tag" data-k="cruise"></div>
        </div>
      </div>
      <div class="wheel" data-k="wheel"><div class="rim">${WHEEL_SVG}</div></div>
      <div class="arrows" data-k="arrows" style="display:none"><button class="glass" data-k="aL">${ICON.left}</button><button class="glass" data-k="aR">${ICON.right}</button></div>
      <div class="rail-left">
        <button class="ib glass blinkL" data-a="indL" aria-label="Left indicator">${ICON.left}</button>
        <button class="ib glass" data-a="hazard" aria-label="Hazard lights">${ICON.hazard}</button>
        <button class="ib glass blinkR" data-a="indR" aria-label="Right indicator">${ICON.right}</button>
      </div>
      <div class="rail">
        <button class="ib glass" data-a="lights" aria-label="Headlights">${ICON.light}</button>
        <button class="ib glass" data-a="horn" aria-label="Horn">${ICON.horn}</button>
        <button class="ib glass" data-a="cruise" aria-label="Cruise control">${ICON.cruise}</button>
        <button class="ib glass" data-a="radio" aria-label="Radio">${ICON.radio}</button>
        <div class="drive-sel glass"><button data-d="R">R</button><button data-d="N">N</button><button data-d="D">D</button></div>
      </div>
      <div class="pedals">
        <div class="pedal brake glass" data-k="brake">BRAKE</div>
        <div class="pedal gas glass" data-k="gas">GAS</div>
      </div>
      <div class="fps glass" data-k="fps" style="display:none"></div>
    </div>`);
    this.root.appendChild(this.hud);
    this.hud.querySelectorAll<HTMLElement>('[data-k]').forEach((e) => (this.el[e.dataset.k!] = e));
    this.minimap = new Minimap(this.hud.querySelector('.gps canvas')!, game.world);
    input.bindWheel(this.el.wheel, this.el.wheel.querySelector('.rim')!);
    input.bindPedal(this.el.gas, 'gas');
    input.bindPedal(this.el.brake, 'brake');
    input.bindArrow(this.el.aL, -1);
    input.bindArrow(this.el.aR, 1);
    this.hud.querySelectorAll<HTMLElement>('[data-a]').forEach((b) => {
      const a = b.dataset.a!;
      if (a === 'horn') {
        b.addEventListener('pointerdown', () => act.horn(true));
        b.addEventListener('pointerup', () => act.horn(false));
        b.addEventListener('pointercancel', () => act.horn(false));
        b.addEventListener('pointerleave', () => act.horn(false));
        return;
      }
      b.addEventListener('click', () => {
        if (a === 'cam') act.cam();
        else if (a === 'menu') this.showMenu();
        else if (a === 'lights') act.lights();
        else if (a === 'cruise') act.cruise();
        else if (a === 'indL') act.ind('L');
        else if (a === 'indR') act.ind('R');
        else if (a === 'hazard') act.hazard();
        else if (a === 'radio') act.radio();
      });
    });
    this.hud.querySelectorAll<HTMLElement>('[data-d]').forEach((b) => b.addEventListener('click', () => act.drive(b.dataset.d as 'D' | 'N' | 'R')));
    this.applySteerMode(settings.steer);
    const rot = h(`<div class="rotate armed"><div>${ICON.phone}<h3 style="margin:0 0 6px;font:800 24px var(--num)">Turn your phone sideways</h3><p style="color:var(--muted);margin:0 0 16px;font-size:14px">Euro Haul is built for landscape.</p><button class="btn small ghost">Play anyway</button></div></div>`);
    rot.querySelector('button')!.addEventListener('click', () => rot.classList.remove('armed'));
    this.root.appendChild(rot);
  }

  applySteerMode(m: SteerMode) {
    this.el.wheel.style.display = m === 'buttons' ? 'none' : '';
    this.el.wheel.classList.toggle('tilt', m === 'tilt');
    this.el.arrows.style.display = m === 'buttons' ? 'flex' : 'none';
  }

  showHud(on: boolean) { this.hud.classList.toggle('hidden', !on); }

  private set(k: string, v: string) {
    if (this.last[k] === v) return;
    this.last[k] = v;
    this.el[k].textContent = v;
  }

  /** White camera-flash over the whole screen. */
  flash() {
    const f = h('<div class="camflash"></div>');
    this.root.appendChild(f);
    setTimeout(() => f.remove(), 700);
  }

  toast(text: string, kind: 'good' | 'bad' | 'info' = 'info') {
    const box = this.hud.querySelector('.toasts')!;
    const t = h(`<div class="toast glass ${kind}"></div>`);
    t.textContent = text;
    box.appendChild(t);
    while (box.children.length > 3) box.firstElementChild!.remove();
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 450); }, 2600);
  }

  update(dt: number, fps: number) {
    const g = this.game, t = g.truck;
    const kmh = Math.round(t.kmh);
    this.set('speed', String(kmh));
    this.el.speedbox.classList.toggle('over', kmh > g.speedLimit + 3);
    this.set('limit', String(g.speedLimit));
    this.set('gear', t.drive === 'D' ? `D${t.gear}` : t.drive);
    this.el.rpm.style.width = `${Math.round((t.rpm / 2200) * 100)}%`;
    this.set('fuel', `${Math.round((t.fuel / FUEL_CAP) * 100)}%`);
    this.set('dmg', `${Math.round(t.damage * 100)}%`);
    this.set('cruise', t.cruise != null ? `CRUISE ${Math.round(t.cruise * 3.6)}` : '');
    this.set('money', formatMoney(g.money));
    const lv = g.level;
    this.set('level', `LEVEL ${lv.level} · ${g.deliveries} DELIVERIES`);
    this.el.xp.style.width = `${Math.round((lv.into / lv.need) * 100)}%`;
    if (g.job) {
      const d = g.world.depots[g.job.to];
      const dist = g.routeDistance();
      this.set('dist', dist > 950 ? `${(dist / 1000).toFixed(1)} km` : `${Math.round(dist / 10) * 10} m`);
      const left = g.job.deadline - g.jobTime;
      this.set('eta', left > 0 ? `${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, '0')} left` : 'LATE');
      this.setHTML('job', `${g.job.cargo.name} → <strong>${d.name}</strong>`);
    } else {
      this.set('dist', g.atDepot ? g.atDepot.name : 'A' + (Math.floor(g.roadS / 1000) + 1));
      this.set('eta', '');
      this.setHTML('job', g.atDepot ? `${g.atDepot.company} depot` : 'No cargo · head to a depot');
    }
    this.hud.querySelector('[data-a="lights"]')!.classList.toggle('on', g.headMode === 'on' || g.headMode === 'high');
    this.hud.querySelector('[data-a="lights"]')!.classList.toggle('on-green', g.headMode === 'auto');
    this.hud.querySelector('[data-a="cruise"]')!.classList.toggle('on-green', t.cruise != null);
    this.hud.querySelector('[data-a="hazard"]')!.classList.toggle('on', g.hazard);
    this.hud.querySelector('[data-a="indL"]')!.classList.toggle('on', g.indL && !g.hazard);
    this.hud.querySelector('[data-a="indR"]')!.classList.toggle('on', g.indR && !g.hazard);
    this.hud.querySelectorAll<HTMLElement>('[data-d]').forEach((b) => b.classList.toggle('on', b.dataset.d === t.drive));
    this.updateActions();
    this.mapT -= dt;
    if (this.mapT <= 0) { this.mapT = 1 / 20; this.minimap.draw(g); }
    if (this.settings.fps) { this.el.fps.style.display = ''; this.set('fps', `${Math.round(fps)} FPS`); } else this.el.fps.style.display = 'none';
  }

  private setHTML(k: string, v: string) {
    if (this.last[k] === v) return;
    this.last[k] = v;
    this.el[k].innerHTML = v;
  }

  /** Context buttons that appear while standing in a depot. */
  private updateActions() {
    const g = this.game;
    const list: [string, string, string, boolean][] = [];
    const stopped = Math.abs(g.truck.speed) < 0.5;
    if (g.pickup && g.canCouple()) list.push(['couple', ICON.flag, 'Couple trailer', false]);
    if (g.pickup && g.atDepot && stopped && !g.canCouple()) list.push(['crew', ICON.wrench, 'Yard crew couples it · €150', true]);
    if (g.atDepot && stopped) {
      if (g.canDeliver()) list.push(['deliver', ICON.flag, g.parkedInBay() ? 'Deliver · parking bonus' : 'Deliver cargo', false]);
      if (!g.job) list.push(['jobs', ICON.box, 'Job board', false]);
      list.push(['garage', ICON.wrench, 'Garage', true]);
      if (g.canRefuel()) list.push(['refuel', ICON.fuel, `Refuel ~${formatMoney(Math.ceil(((FUEL_CAP - g.truck.fuel) * 1.45) / 10) * 10)}`, true]);
      if (g.canRepair()) list.push(['repair', ICON.wrench, `Repair ${formatMoney(g.repairCost())}`, true]);
    }
    const key = list.map((l) => l[0] + l[2]).join('|');
    if (key === this.actionsKey) return;
    this.actionsKey = key;
    const box = this.hud.querySelector('.actions')!;
    box.innerHTML = '';
    for (const [id, icon, label, alt] of list) {
      const b = h(`<button class="act ${alt ? 'alt' : ''}">${icon}<span></span></button>`);
      b.querySelector('span')!.textContent = label;
      b.addEventListener('click', () => {
        if (id === 'deliver') this.act.deliver();
        else if (id === 'couple') this.act.couple();
        else if (id === 'crew') this.act.crewCouple();
        else if (id === 'jobs') this.showJobs();
        else if (id === 'refuel') this.act.refuel();
        else if (id === 'repair') this.act.repair();
        else if (id === 'garage') this.showGarage();
      });
      box.appendChild(b);
    }
  }

  // ---------------------------------------------------------------- overlays

  private open(el: HTMLElement, pause = true) {
    this.close();
    this.overlay = el;
    this.root.appendChild(el);
    if (pause) { this.paused = true; this.act.pause(true); }
  }

  close() {
    if (this.overlay) { this.overlay.remove(); this.overlay = null; }
    if (this.paused) { this.paused = false; this.act.pause(false); }
  }

  get overlayOpen() { return !!this.overlay; }

  showLoading() {
    const el = h(`<div class="loading"><div><div class="brand">Euro<br>Haul</div><div class="bar"><i></i></div><p>Building the motorway…</p></div></div>`);
    this.root.appendChild(el);
    return {
      progress: (f: number, text: string) => { (el.querySelector('.bar i') as HTMLElement).style.width = `${Math.round(f * 100)}%`; el.querySelector('p')!.textContent = text; },
      done: () => { el.classList.add('done'); setTimeout(() => el.remove(), 700); },
    };
  }

  showTitle() {
    const g = this.game;
    const el = h(`<div class="overlay clear"><div class="title">
      <div class="brand">Euro<br>Haul</div>
      <div class="tag">Haul freight between five Alpine towns. Real truck physics, day and night, rain, traffic — on your phone.</div>
      <div class="row">
        <button class="btn" data-x="go">Start driving</button>
        <button class="btn ghost small" data-x="fs">${'Full screen'}</button>
        <button class="btn ghost small" data-x="settings">Settings</button>
      </div>
      <div class="stats"><div><b>${formatMoney(g.money)}</b>Bank</div><div><b>${g.level.level}</b>Level</div><div><b>${g.deliveries}</b>Deliveries</div><div><b>${Math.round(g.km)}</b>km driven</div></div>
    </div></div>`);
    el.querySelector('[data-x="go"]')!.addEventListener('click', () => { this.close(); this.act.start(); });
    el.querySelector('[data-x="fs"]')!.addEventListener('click', () => this.act.fullscreen());
    el.querySelector('[data-x="settings"]')!.addEventListener('click', () => this.showMenu(true));
    this.open(el, false);
  }

  showJobs() {
    const g = this.game;
    const here = g.atDepot ?? g.world.depots[g.depotId];
    const el = h(`<div class="overlay"><div class="panel jobs-panel">
      <div class="panel-head"><div><h2>${here.company}</h2><div class="sub">${here.name} depot · choose a delivery</div></div><button class="x">${ICON.close}</button></div>
      <div class="jobs-body"><canvas class="jobmap"></canvas><div class="jobs"></div></div>
    </div></div>`);
    const list = el.querySelector('.jobs')!;
    const canvas = el.querySelector('canvas') as HTMLCanvasElement;
    const icon = (k: string) => (k === 'tanker' ? ICON.tank : k === 'reefer' ? ICON.snow : ICON.box);
    g.offers.forEach((job, i) => {
      const to = g.world.depots[job.to];
      const card = h(`<button class="jobcard"><div class="ico">${icon(job.cargo.trailer)}</div><div><b></b><div class="meta"></div></div><div class="pay">${formatMoney(job.pay)}<small>${(job.distance / 1000).toFixed(1)} km</small></div></button>`);
      card.querySelector('b')!.innerHTML = `${job.cargo.name}${job.cargo.fragile ? '<span class="tagf">FRAGILE</span>' : ''}`;
      card.querySelector('.meta')!.textContent = `${(job.mass / 1000).toFixed(1)} t · to ${to.name} (${to.company}) · ${Math.round(job.deadline / 60)} min`;
      card.addEventListener('pointerenter', () => Minimap.drawFull(canvas, g.world, g, { from: job.from, to: job.to }));
      card.addEventListener('click', () => { this.close(); this.act.accept(job); });
      list.appendChild(card);
      if (i === 0) requestAnimationFrame(() => Minimap.drawFull(canvas, g.world, g, { from: job.from, to: job.to }));
    });
    el.querySelector('.x')!.addEventListener('click', () => this.close());
    this.open(el);
  }

  showReport(d: Delivery, job: Job, depot: Depot) {
    const line = (label: string, v: number, cls = '') => `<div class="line ${cls}"><span>${label}</span><span class="${v < 0 ? 'neg' : v > 0 && cls !== 'total' ? 'pos' : ''}">${v < 0 ? '−' : ''}${formatMoney(Math.abs(v))}</span></div>`;
    const el = h(`<div class="overlay"><div class="panel report">
      <h2>Delivered!</h2><div class="sub">${job.cargo.name} · ${(job.mass / 1000).toFixed(1)} t to ${depot.company}, ${depot.name}</div>
      ${line('Freight rate', d.base)}
      ${d.parking ? line('Parked in the bay', d.parking) : ''}
      ${d.damage ? line('Cargo damage', d.damage) : ''}
      ${d.late ? line('Late delivery', d.late) : ''}
      ${line('Total', d.total, 'total')}
      <div class="sub" style="margin-top:8px">+${d.xp} XP</div>
      <div class="foot"><button class="btn" data-x="next">Next job</button><button class="btn ghost" data-x="drive">Just drive</button></div>
    </div></div>`);
    el.querySelector('[data-x="next"]')!.addEventListener('click', () => this.showJobs());
    el.querySelector('[data-x="drive"]')!.addEventListener('click', () => this.close());
    this.open(el);
  }

  /** Dealer and workshop. The 3D view orbits the truck while this is open. */
  showGarage(tab: 'trucks' | 'upgrades' | 'paint' = 'trucks') {
    const g = this.game;
    let previewing: number | null = null;
    const el = h(`<div class="overlay side"><div class="panel garage">
      <div class="panel-head"><div><h2>Garage</h2><div class="sub" data-g="cash"></div></div><button class="x">${ICON.close}</button></div>
      <div class="seg tabs">${(['trucks', 'upgrades', 'paint'] as const).map((t) => `<button data-t="${t}" class="${t === tab ? 'on' : ''}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}</div>
      <div class="gbody"></div>
    </div></div>`);
    const body = el.querySelector('.gbody') as HTMLElement;
    const bar = (v: number, max: number) => `<span class="meter"><i style="width:${Math.round((v / max) * 100)}%"></i></span>`;
    const render = () => {
      (el.querySelector('[data-g="cash"]') as HTMLElement).textContent = `${formatMoney(g.money)} in the bank`;
      if (tab === 'trucks') {
        body.innerHTML = GARAGE_ORDER.map((id) => TRUCK_MODELS[id]).map((m) => {
          const owned = g.owned.includes(m.id), current = g.model === m.id, sel = (previewing ?? g.model) === m.id;
          const btn = current ? '<span class="tagok">DRIVING</span>' : owned ? `<button class="btn small" data-buy="${m.id}">Drive this</button>` : `<button class="btn small" data-buy="${m.id}" ${g.money < m.price ? 'disabled' : ''}>Buy ${formatMoney(m.price)}</button>`;
          return `<div class="tcard ${sel ? 'sel' : ''}" data-m="${m.id}"><div class="trow"><b>${m.name}</b>${btn}</div>
            <div class="meta">${m.blurb}</div>
            <div class="stats2"><span>Power ${m.hp} hp</span>${bar(m.hp, 760)}<span>Torque ${m.torque} N·m</span>${bar(m.torque, 3600)}</div></div>`;
        }).join('');
        body.querySelectorAll<HTMLElement>('[data-m]').forEach((c) => c.addEventListener('click', () => {
          previewing = Number(c.dataset.m);
          this.act.preview(previewing === g.model ? null : previewing);
          render();
        }));
        body.querySelectorAll<HTMLElement>('[data-buy]').forEach((b) => b.addEventListener('click', (e) => {
          e.stopPropagation();
          if (this.act.chooseTruck(Number(b.dataset.buy))) { previewing = null; this.act.preview(null); }
          render();
        }));
      } else if (tab === 'upgrades') {
        body.innerHTML = UPGRADES.map((u) => {
          const has = g.upgrades.has(u.id) || (u.id === 'chrome' && g.look.chrome) || (u.id === 'lightbar' && g.look.lightbar);
          return `<div class="tcard"><div class="trow"><b>${u.name}</b>${has ? '<span class="tagok">FITTED</span>' : `<button class="btn small" data-u="${u.id}" ${g.money < u.price ? 'disabled' : ''}>${formatMoney(u.price)}</button>`}</div><div class="meta">${u.detail}</div></div>`;
        }).join('');
        body.querySelectorAll<HTMLElement>('[data-u]').forEach((b) => b.addEventListener('click', () => { this.act.buyUpgrade(b.dataset.u as UpgradeId); render(); }));
      } else {
        const sw = (list: number[], cur: number, key: string) => `<div class="swatches">${list.map((c) => `<button data-${key}="${c}" class="${c === cur ? 'on' : ''}" style="background:#${c.toString(16).padStart(6, '0')}"></button>`).join('')}</div>`;
        body.innerHTML = `<div class="tcard"><b>Cab paint</b>${sw(PAINTS, g.color, 'c')}</div><div class="tcard"><b>Stripes and trim</b>${sw(ACCENTS, g.accent, 'a')}</div><div class="meta" style="padding:4px 2px">Paint jobs are free at any depot.</div>`;
        body.querySelectorAll<HTMLElement>('[data-c]').forEach((b) => b.addEventListener('click', () => { this.act.setColor(Number(b.dataset.c)); render(); }));
        body.querySelectorAll<HTMLElement>('[data-a]').forEach((b) => b.addEventListener('click', () => { this.act.setAccent(Number(b.dataset.a)); render(); }));
      }
    };
    el.querySelectorAll<HTMLElement>('[data-t]').forEach((b) => b.addEventListener('click', () => {
      tab = b.dataset.t as typeof tab;
      el.querySelectorAll('[data-t]').forEach((x) => x.classList.toggle('on', x === b));
      if (previewing != null) { previewing = null; this.act.preview(null); }
      render();
    }));
    el.querySelector('.x')!.addEventListener('click', () => { this.act.preview(null); this.act.garage(false); this.close(); });
    render();
    this.open(el);
    this.act.garage(true);
  }

  showMenu(fromTitle = false) {
    const s = this.settings;
    const g = this.game;
    const seg = (key: string, opts: [string, string][], cur: string) =>
      `<div class="seg" data-seg="${key}">${opts.map(([v, l]) => `<button data-v="${v}" class="${v === cur ? 'on' : ''}">${l}</button>`).join('')}</div>`;
    const el = h(`<div class="overlay"><div class="panel">
      <div class="panel-head"><div><h2>${fromTitle ? 'Settings' : 'Paused'}</h2><div class="sub">${formatMoney(g.money)} · level ${g.level.level} · ${g.deliveries} deliveries</div></div><button class="x">${ICON.close}</button></div>
      <div class="setting"><span>Graphics<small>${s.canFloat ? 'Ultra adds 4K shadows and more trees' : 'This GPU can’t do HDR effects; Low is safest'}</small></span>${seg('tier', [['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['ultra', 'Ultra']], s.tier)}</div>
      <div class="setting"><span>Steering</span>${seg('steer', [['wheel', 'Wheel'], ['tilt', 'Tilt'], ['buttons', 'Buttons']], s.steer)}</div>
      <div class="setting"><span>Time of day</span>${seg('time', [['live', 'Live'], ['6.6', 'Dawn'], ['12', 'Noon'], ['17.55', 'Sunset'], ['23', 'Night']], s.time == null ? 'live' : String(s.time))}</div>
      <div class="setting"><span>Weather</span>${seg('weather', [['live', 'Live'], ['clear', 'Clear'], ['cloudy', 'Cloudy'], ['rain', 'Rain']], s.weather ?? 'live')}</div>
      <div class="setting"><span>Truck paint</span><div class="swatches">${PAINTS.map((c) => `<button data-c="${c}" class="${c === g.color ? 'on' : ''}" style="background:#${c.toString(16).padStart(6, '0')}"></button>`).join('')}</div></div>
      <div class="setting"><span>Sound</span><input type="range" min="0" max="1" step="0.05" value="${s.volume}"></div>
      <div class="setting"><span>Show FPS</span>${seg('fps', [['off', 'Off'], ['on', 'On']], s.fps ? 'on' : 'off')}</div>
      <div class="setting"><span>Keys<small>WASD / arrows · Space handbrake · R/N/F gears · C camera · L lights · H horn · K cruise · Q/E indicators</small></span></div>
      <div class="setting">${g.job && !fromTitle ? '<button class="btn ghost small" data-x="cancel">Cancel job (25% fee)</button>' : '<span></span>'}<span style="display:flex;gap:8px"><button class="btn ghost small" data-x="reset">Reset progress</button>${fromTitle ? '' : '<button class="btn small" data-x="resume">Resume</button>'}</span></div>
    </div></div>`);
    el.querySelectorAll<HTMLElement>('[data-seg]').forEach((sg) => {
      sg.querySelectorAll<HTMLElement>('button').forEach((b) => b.addEventListener('click', () => {
        sg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
        const v = b.dataset.v!;
        const key = sg.dataset.seg;
        if (key === 'tier') this.act.setTier(v as Tier);
        if (key === 'steer') { s.steer = v as SteerMode; this.act.setSteer(s.steer); this.applySteerMode(s.steer); }
        if (key === 'time') { s.time = v === 'live' ? null : Number(v); this.act.setTime(s.time); }
        if (key === 'weather') { s.weather = v === 'live' ? null : (v as Weather); this.act.setWeather(s.weather); }
        if (key === 'fps') { s.fps = v === 'on'; this.act.toggleFps(); }
      }));
    });
    el.querySelectorAll<HTMLElement>('[data-c]').forEach((b) => b.addEventListener('click', () => {
      el.querySelectorAll('[data-c]').forEach((x) => x.classList.toggle('on', x === b));
      this.act.setColor(Number(b.dataset.c));
    }));
    el.querySelector('input')!.addEventListener('input', (e) => { s.volume = Number((e.target as HTMLInputElement).value); this.act.setVolume(s.volume); });
    el.querySelector('[data-x="cancel"]')?.addEventListener('click', () => { this.act.cancelJob(); this.close(); });
    // Two taps to reset, so nobody wipes their career by accident (and no browser dialogs needed).
    const resetBtn = el.querySelector('[data-x="reset"]') as HTMLElement;
    resetBtn.addEventListener('click', () => {
      if (resetBtn.dataset.armed) { this.act.reset(); return; }
      resetBtn.dataset.armed = '1';
      resetBtn.textContent = 'Tap again to reset';
      setTimeout(() => { delete resetBtn.dataset.armed; resetBtn.textContent = 'Reset progress'; }, 3000);
    });
    const done = () => { if (fromTitle) this.showTitle(); else this.close(); };
    el.querySelector('[data-x="resume"]')?.addEventListener('click', done);
    el.querySelector('.x')!.addEventListener('click', done);
    this.open(el, !fromTitle);
  }
}
