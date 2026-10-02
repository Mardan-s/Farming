import { onGuardError } from '../guard';
import {
  CROPS, CROP_DEFS, FUEL_CAP, LOAN_DAILY_RATE, LOAN_MAX, LOAN_STEP, OP_DEFS, SEASON_NAMES, SHOP_ITEMS, SILO_CAP, SPEEDS,
  UPGRADES, WAGE_PER_SEC, WEATHER_DEFS, parcelPrice,
  type CropId, type UpgradeId,
} from '../game/config';
import type { Field } from '../game/field';
import type { Pt } from '../game/geometry';
import { GOALS } from '../game/goals';
import { ANIMAL_DEFS, ANIMAL_KINDS, PRODUCTS, PRODUCT_DEFS, type AnimalKind } from '../game/animals';
import { TOOL_NAMES, VEHICLE_NAMES, isHarvester, plantWindow, type Game, type Ledger, type Need, type Op, type Vehicle } from '../game/sim';
import { parcelRect } from '../game/world';
import { setMuted, sfx } from '../audio';
import { getQuality, isSafeMode, setQuality, setSafeMode, type Quality } from '../render3d/quality';
import type { TapInfo, ViewControls, ViewHost } from '../render3d/types';
import {
  CROP_ICON, OP_ICON, SHOP_ICON, TOOL_ICON, UPGRADE_ICON, VEHICLE_ICON, WEATHER_ICON, icon, stripEmoji,
} from './icons';

type FieldView = 'todo' | 'more' | 'plant' | 'machines';

type Panel =
  | { kind: 'home' }
  | { kind: 'vehicle'; id: number }
  | { kind: 'combineTarget'; tid: number; cid: number }
  | { kind: 'field'; fid: number; vid?: number; view: FieldView }
  | { kind: 'draw' }
  | { kind: 'parcel'; index: number }
  | { kind: 'silo' }
  | { kind: 'pen'; id: number }
  | { kind: 'place'; animal: AnimalKind };

type Modal = null | 'shop' | 'market' | 'fleet' | 'settings' | 'welcome' | 'confirm' | 'finance';

const $ = (sel: string) => document.querySelector(sel) as HTMLElement;
const money = (n: number) => `$${Math.round(n).toLocaleString()}`;
const liters = (n: number) => `${Math.round(n).toLocaleString()} L`;
const ha = (cells: number) => `${(cells * 0.01).toFixed(2)} ha`;
const vIco = (v: Vehicle) => icon(VEHICLE_ICON[v.kind]);
const cap1 = (t: string) => t[0].toUpperCase() + t.slice(1);
const pad2 = (n: number) => String(n).padStart(2, '0');
const roundTo = (n: number, step: number) => Math.round(n / step) * step;
const ANIMAL_ICON: Record<AnimalKind, string> = { chicken: 'chicken', cow: 'cow', pig: 'pig', sheep: 'sheep' };

const TOAST_ICON: Record<string, string> = { good: 'check', bad: 'warn', info: 'flag', goal: 'flag' };

export class UI implements ViewHost {
  drawMode = false;
  draft: Pt[] = [];
  draftCells: Pt[] = [];
  draftValid = false;
  selectedVehicle: number | null = null;
  selectedField: number | null = null;
  follow = false;

  private panel: Panel = { kind: 'home' };
  private modal: Modal = null;
  private shopTab: 'vehicles' | 'animals' | 'upgrades' | 'land' = 'vehicles';
  private placeAt: { x: number; y: number } | null = null;
  private goalOpen: boolean;
  private draftReason = '';
  private liveT = 0;
  private renderT = 0;
  private panelHtml = '';
  private modalHtml = '';
  private goalHtml = '';
  private wxKey = '';
  private live = new Map<string, () => string>();
  private view!: ViewControls;
  private pending: { msg: string; yes: string; run: () => void } | null = null;
  private driveKey = '';
  private panelKey = '';
  private modalKey = '';
  private plantBy: 'hire' | 'drive' = 'hire';
  private stick = { id: -1, cx: 0, cy: 0, steer: 0, throttle: 0 };
  private marketCrop: CropId | null = null;
  private keys = new Set<string>();

  constructor(private sim: Game, private onSave: () => void, private onReset: () => void) {
    this.goalOpen = sim.goalIdx < 3; // helper text only while learning
    this.buildShell();
    sim.events.on('toast', (msg: string, kind: string) => this.toast(msg, kind));
    sim.events.on('goal', (g: { title: string; reward: number }) => {
      sfx.goal();
      this.toast(`Goal complete: ${g.title} · +${money(g.reward)}`, 'goal');
      $('#goal').classList.add('pop');
      setTimeout(() => $('#goal').classList.remove('pop'), 700);
    });
    sim.events.on('money', (_x: number, _y: number, amt: number) => { if (amt > 0) sfx.cash(); });
    sim.events.on('drive', () => this.syncDriving());
    sim.events.on('bump', () => sfx.bump());
    sim.events.on('handover', (_vid: number, fid: number, op: Op, err: string | null) => {
      sfx.select();
      const what = op === 'seed' ? `plant ${CROP_DEFS[sim.driveCrop].name.toLowerCase()}` : OP_DEFS[op].name.toLowerCase();
      this.toast(err ? `You're at Field ${fid}. ${err}` : `Your turn: push the stick up to ${what} Field ${fid}. The tool is already down.`, err ? 'bad' : 'info', 'wheel');
    });
    sim.events.on('season', (season: string) => {
      const msg: Record<string, string> = {
        spring: 'Spring is here. Plant wheat, barley, oats, corn, soybeans, sunflowers, potatoes or beets.',
        summer: 'Summer. Corn, soybeans, oats and sunflowers can still go in.',
        autumn: 'Autumn. Sow wheat, barley and canola now; they wait out the winter.',
        winter: 'Winter. Nothing grows until spring. Plow, lime and sell from the silo.',
      };
      this.toast(msg[season] ?? season, 'info', season === 'winter' ? 'snow' : 'sun');
    });
    setMuted(sim.muted);
  }

  attach(view: ViewControls) {
    this.view = view;
    onGuardError((where, err) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.toast(`Something broke (${where}: ${msg.slice(0, 90)}). The game kept running. Please send a screenshot of this.`, 'bad', undefined, 12000);
    });
    if (isSafeMode()) setTimeout(() => this.toast('Simple graphics are on because your phone couldn\u2019t run the full effects. You can retry in Settings.', 'info', 'quality'), 1500);
  }

  private reloading = false;
  onGraphicsFailure() {
    if (this.reloading) return;
    this.reloading = true;
    this.onSave();
    location.reload();
  }

  // ---------- shell ----------

  private buildShell() {
    document.getElementById('ui')!.innerHTML = `
      <header id="top">
        <div class="strip">
          <button class="cell money" data-act="modal" data-arg="finance" aria-label="Finances">${icon('coin')}<span id="money" class="fig"></span></button>
          <button class="cell clock" data-act="forecast" aria-label="Weather forecast"><span id="wx"></span><span id="clock" class="fig"></span></button>
          <button class="cell speed" data-act="speed" aria-label="Game speed">${icon('speed')}<span id="speed" class="fig"></span></button>
          <button class="cell gear" data-act="modal" data-arg="settings" aria-label="Settings">${icon('settings')}</button>
        </div>
        <button id="goal" data-act="goal"></button>
      </header>
      <div id="mapctl">
        <button data-act="zoom" data-arg="1.25" aria-label="Zoom in">${icon('plus')}</button>
        <button data-act="zoom" data-arg="0.8" aria-label="Zoom out">${icon('minus')}</button>
        <button data-act="rotate" data-arg="0.785" aria-label="Rotate view">${icon('compass')}</button>
        <button data-act="home" aria-label="Go to farmyard">${icon('home')}</button>
      </div>
      <div id="toasts"></div>
      <div id="drive" class="hidden">
        <div class="dr-gauges">
          <span class="dr-g"><b class="fig" data-live="dspeed"></b><small>km/h</small></span>
          <span class="dr-g wide">${icon('fuel')}<span class="gauge-bar"><span data-live="dfuel" data-bar></span></span></span>
          <span class="dr-g wide" id="dr-cargo">${icon('wagon')}<span class="gauge-bar"><span data-live="dcargo" data-bar></span></span></span>
        </div>
        <p class="dr-status" data-live="dstatus"></p>
        <div class="dr-actions" id="dr-actions"></div>
        <div class="stick" id="stick" aria-label="Drive: push up to go, pull back to brake and reverse, left and right to steer">
          <span class="stick-label up">Go</span><span class="stick-label down">Back</span>
          <span class="stick-knob"></span>
        </div>
      </div>
      <div id="panel"></div>
      <div id="modal" class="hidden"></div>`;
    const root = document.getElementById('ui')!;
    root.addEventListener('pointerdown', e => { this.downEl = e.target as Node; }, true);
    window.addEventListener('pointerdown', e => { if (!root.contains(e.target as Node)) this.downEl = null; }, true);
    root.addEventListener('click', e => {
      const el = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
      if (!el || el.hasAttribute('disabled')) return;
      // A tap on the map can open a sheet right under the finger; the browser's follow-up click
      // must not press whatever button just appeared there. Only presses that started on the
      // button count (keyboard clicks have no pointer and are fine).
      if (e.detail !== 0 && !(this.downEl && el.contains(this.downEl))) return;
      this.act(el.dataset.act!, el.dataset.arg ?? '');
    });
    this.live.set('money', () => (this.sim.money < 0 ? '-' : '') + money(Math.abs(this.sim.money)).slice(1));
    this.live.set('clock', () => {
      const t = this.sim.timeOfDay;
      return `${this.sim.seasonName} ${this.sim.seasonDay} · ${pad2(Math.floor(t / 60))}:${pad2(Math.floor(t % 60))}`;
    });
    this.live.set('dspeed', () => String(Math.round(Math.abs(this.sim.driven?.speed ?? 0) * 7)));
    this.live.set('dfuel', () => { const v = this.sim.driven; return v ? String((v.fuel / FUEL_CAP[v.kind]) * 100) : '0'; });
    this.live.set('dcargo', () => { const v = this.sim.driven; const c = v && this.sim.cargoOf(v); return c ? String((c.cargo.amount / c.cap) * 100) : '0'; });
    this.live.set('dstatus', () => stripEmoji(this.sim.driven?.status ?? ''));
    this.setupDriveControls();
    this.live.set('speed', () => `${SPEEDS[this.sim.speedIdx]}×`);
  }

  // ---------- ViewHost ----------

  private downEl: Node | null = null;

  onTap(info: TapInfo) {
    if (this.modal || this.sim.drivenId != null) return;
    if (this.drawMode) { this.addCorner(info.cx, info.cy); return; }
    if (this.panel.kind === 'place') { this.movePlacement(info.cx, info.cy); return; }
    const selV = this.selectedVehicle != null ? this.sim.vehicle(this.selectedVehicle) : undefined;

    if (info.vehicleId != null) {
      const tapped = this.sim.vehicle(info.vehicleId)!;
      if (selV && selV.kind === 'tractor' && isHarvester(tapped)) {
        sfx.tap();
        this.setPanel({ kind: 'combineTarget', tid: selV.id, cid: tapped.id });
        return;
      }
      sfx.select();
      this.selectVehicle(tapped.id);
      return;
    }
    if (selV && info.fieldId >= 0) {
      sfx.tap();
      this.selectedField = info.fieldId;
      this.setPanel({ kind: 'field', fid: info.fieldId, vid: selV.id, view: 'todo' });
      return;
    }
    if (info.silo) { sfx.tap(); this.clearSelection(); this.setPanel({ kind: 'silo' }); return; }
    if (info.penId >= 0) {
      sfx.tap();
      this.clearSelection();
      this.setPanel({ kind: 'pen', id: info.penId });
      const pen = this.sim.pen(info.penId);
      if (pen) this.view.panTo(pen.x + ANIMAL_DEFS[pen.kind].w / 2, pen.y + ANIMAL_DEFS[pen.kind].h / 2);
      return;
    }
    if (info.elevator) { sfx.tap(); this.openModal('market'); return; }
    if (info.fieldId >= 0) {
      sfx.tap();
      this.selectedVehicle = null;
      this.selectedField = info.fieldId;
      this.setPanel({ kind: 'field', fid: info.fieldId, view: 'todo' });
      this.focusField(info.fieldId);
      return;
    }
    if (info.parcel >= 0 && !this.sim.owned.has(info.parcel)) {
      sfx.tap();
      this.clearSelection();
      this.setPanel({ kind: 'parcel', index: info.parcel });
      return;
    }
    this.clearSelection();
    this.setPanel({ kind: 'home' });
  }

  private focusField(fid: number) {
    const f = this.sim.world.fields.get(fid);
    if (f && this.sideSheet) this.view.panTo(f.center.x, f.center.y);
  }

  frame(dt: number) {
    this.liveT += dt;
    this.renderT += dt;
    if (this.renderT > 0.4) { this.renderT = 0; this.render(); }
    if (this.liveT > 0.15) { this.liveT = 0; this.updateLive(); this.renderDriveActions(); }
    if (this.sim.drivenId != null) this.applyDriveInput();
  }

  // ---------- driving ----------

  /** One joystick: up drives forward, down brakes then reverses, left and right steer. */
  private setupDriveControls() {
    const stick = $('#stick');
    const knob = stick.querySelector('.stick-knob') as HTMLElement;
    const moveKnob = (dx: number, dy: number) => { knob.style.transform = `translate(${dx}px, ${dy}px)`; };
    const track = (e: PointerEvent) => {
      const r = stick.getBoundingClientRect().width / 2 - 26;
      let dx = e.clientX - this.stick.cx, dy = e.clientY - this.stick.cy;
      const len = Math.hypot(dx, dy);
      if (len > r) { dx *= r / len; dy *= r / len; }
      const dead = (v: number) => (Math.abs(v) < 0.15 ? 0 : (v - Math.sign(v) * 0.15) / 0.85);
      this.stick.steer = dead(dx / r);
      this.stick.throttle = dead(-dy / r);
      moveKnob(dx, dy);
    };
    stick.addEventListener('pointerdown', e => {
      stick.setPointerCapture(e.pointerId);
      const r = stick.getBoundingClientRect();
      this.stick = { id: e.pointerId, cx: r.left + r.width / 2, cy: r.top + r.height / 2, steer: 0, throttle: 0 };
      stick.classList.add('on');
      track(e);
      e.preventDefault();
    });
    stick.addEventListener('pointermove', e => { if (e.pointerId === this.stick.id) track(e); });
    const release = (e: PointerEvent) => {
      if (e.pointerId !== this.stick.id) return;
      this.stick = { id: -1, cx: 0, cy: 0, steer: 0, throttle: 0 };
      moveKnob(0, 0);
      stick.classList.remove('on');
    };
    stick.addEventListener('pointerup', release);
    stick.addEventListener('pointercancel', release);
    stick.addEventListener('lostpointercapture', release);
    // Keyboard driving on PC: WASD or arrows, E for the implement, Esc to leave.
    window.addEventListener('keydown', e => {
      if (this.sim.drivenId == null) return;
      this.keys.add(e.key.toLowerCase());
      if (e.key === 'e' || e.key === 'E') this.act('implement', '');
      if (e.key === 'Escape') this.act('exitDrive', '');
    });
    window.addEventListener('keyup', e => this.keys.delete(e.key.toLowerCase()));
  }

  private applyDriveInput() {
    const k = this.keys;
    let steer = this.stick.steer;
    if (k.has('a') || k.has('arrowleft')) steer = -1;
    if (k.has('d') || k.has('arrowright')) steer = 1;
    let throttle = this.stick.throttle;
    if (k.has('w') || k.has('arrowup')) throttle = 1;
    if (k.has('s') || k.has('arrowdown')) throttle = -1;
    this.sim.setDriveInput(steer, throttle);
  }

  private syncDriving() {
    const on = this.sim.drivenId != null;
    document.body.classList.toggle('driving', on);
    $('#drive').classList.toggle('hidden', !on);
    this.driveKey = '';
    if (on) {
      this.selectedVehicle = null;
      this.selectedField = null;
      this.follow = false;
      this.panel = { kind: 'home' };
      this.modal = null;
    }
    this.render(true);
  }

  private renderDriveActions() {
    const sim = this.sim;
    const ctx = sim.driveContext();
    const v = sim.driven;
    if (!ctx || !v) return;
    const cargo = sim.cargoOf(v);
    const key = JSON.stringify([ctx, sim.driveCrop, sim.driveSpread, !!cargo, sim.money >= sim.repairCost(v)]);
    if (key === this.driveKey) return;
    this.driveKey = key;
    $('#dr-cargo').style.display = cargo ? '' : 'none';
    const b = (act: string, ico: string, label: string, cls = '') => `<button class="${cls}" data-act="${act}">${icon(ico)}<span>${label}</span></button>`;
    const out: string[] = [];
    if (ctx.op) {
      out.push(b('implement', ctx.lowered ? 'raise' : 'lower', ctx.lowered ? `Raise ${isHarvester(v) ? 'header' : 'tool'}` : ctx.opLabel, ctx.lowered ? 'on' : 'primary'));
      if (ctx.op === 'seed') out.push(b('driveCrop', CROP_ICON[sim.driveCrop], CROP_DEFS[sim.driveCrop].name));
      if (ctx.op === 'fertilize' || ctx.op === 'lime') out.push(b('driveSpread', ctx.op, ctx.op === 'fertilize' ? 'Fertilizer' : 'Lime'));
    }
    if (ctx.unload) out.push(b('dUnload', 'unload', ctx.unload === 'sell' ? 'Sell load' : 'Into silo', 'primary'));
    if (ctx.refuel) out.push(b('dRefuel', 'fuel', 'Refuel', 'primary'));
    if (ctx.load) out.push(b('dLoad', 'silo', 'Load feed', 'primary'));
    if (ctx.feedPen != null) out.push(b('dFeed', 'wagon', 'Feed animals', 'primary'));
    if (ctx.hitch) out.push(b('dHitch', 'unhitch', ctx.hitch === 'hitch' ? `Hitch ${ctx.hitchName}` : `Drop ${ctx.hitchName}`));
    out.push(b('exitDrive', 'exit', 'Get out'));
    $('#dr-actions').innerHTML = out.join('');
  }

  // ---------- selection & actions ----------

  private selectVehicle(id: number) {
    this.selectedVehicle = id;
    this.selectedField = null;
    this.setPanel({ kind: 'vehicle', id });
  }

  private clearSelection() {
    this.selectedVehicle = null;
    this.selectedField = null;
    this.follow = false;
  }

  private setPanel(p: Panel) {
    this.panel = p;
    this.render(true);
  }

  private openModal(m: Modal) {
    this.modal = m;
    this.render(true);
  }

  private act(action: string, arg: string) {
    const sim = this.sim;
    switch (action) {
      case 'speed':
        sim.speedIdx = (sim.speedIdx + 1) % SPEEDS.length;
        sfx.tap();
        break;
      case 'goal': this.goalOpen = !this.goalOpen; sfx.tap(); break;
      case 'zoom': this.view.zoomBy(parseFloat(arg)); break;
      case 'rotate': this.view.rotateBy(parseFloat(arg)); sfx.tap(); break;
      case 'forecast': {
        const hours = Math.max(1, Math.round((sim.weatherChangeAt - sim.clock) / 60));
        const winter = sim.season === 'winter';
        const name = (w: typeof sim.weather) => winter && (w === 'rain' || w === 'storm') ? (w === 'rain' ? 'Snow' : 'Blizzard') : WEATHER_DEFS[w].name;
        const wet = sim.tooWet ? ' Crops are too wet to harvest.' : sim.wetness > 0.05 ? ' Crops are drying.' : '';
        this.toast(`${name(sim.weather)} now. ${name(sim.weatherNext)} in about ${hours} h.${wet}`, 'info', WEATHER_ICON[sim.weatherNext]);
        sfx.tap();
        return;
      }
      case 'home': this.view.centerOnCells(14, 52); break;
      case 'modal': sfx.tap(); this.openModal(arg as Modal); return;
      case 'closeModal': sfx.tap(); this.modal = null; this.marketCrop = null; this.render(true); return;
      case 'shopTab': this.shopTab = arg as typeof this.shopTab; sfx.tap(); break;
      case 'close': sfx.tap(); this.clearSelection(); this.setPanel({ kind: 'home' }); return;
      case 'back': {
        sfx.tap();
        const p = this.panel;
        if (p.kind === 'field' && p.view !== 'todo') { this.setPanel({ ...p, view: 'todo' }); return; }
        if (p.kind === 'field' && p.vid != null) { this.selectedField = null; this.selectVehicle(p.vid); return; }
        if (p.kind === 'combineTarget') { this.setPanel({ kind: 'vehicle', id: p.tid }); return; }
        this.setPanel({ kind: 'home' });
        return;
      }
      case 'draw':
        sfx.select();
        this.clearSelection();
        this.drawMode = true;
        this.draft = [];
        this.updateDraft();
        this.setPanel({ kind: 'draw' });
        return;
      case 'undo': this.draft.pop(); this.updateDraft(); sfx.tap(); break;
      case 'cancelDraw':
        sfx.tap();
        this.drawMode = false; this.draft = []; this.updateDraft();
        this.setPanel({ kind: 'home' });
        return;
      case 'createField': this.finishDraft(); return;
      case 'select': {
        const id = parseInt(arg, 10);
        const v = sim.vehicle(id);
        this.modal = null;
        if (v) { sfx.select(); this.selectVehicle(id); this.view.centerOnCells(v.x, v.y); }
        return;
      }
      case 'need': {
        const p = this.panel;
        if (p.kind !== 'field') return;
        if (arg === 'seed') { sfx.tap(); this.setPanel({ ...p, view: 'plant' }); return; }
        this.startJob(p.fid, arg as Op, undefined, p.vid);
        return;
      }
      case 'plant': {
        const p = this.panel;
        if (p.kind !== 'field') return;
        if (this.plantBy === 'drive') this.startDriveJob(p.fid, 'seed', arg as CropId, p.vid);
        else this.startJob(p.fid, 'seed', arg as CropId, p.vid);
        return;
      }
      case 'plantBy': this.plantBy = arg as 'hire' | 'drive'; sfx.tap(); break;
      case 'driveJob': {
        const p = this.panel;
        if (p.kind === 'field') this.startDriveJob(p.fid, arg as Op, undefined, p.vid);
        return;
      }
      case 'fieldView': {
        const p = this.panel;
        if (p.kind === 'field') { sfx.tap(); this.setPanel({ ...p, view: arg as FieldView }); }
        return;
      }
      case 'pickMachine': {
        const p = this.panel;
        if (p.kind !== 'field') return;
        const vid = arg ? parseInt(arg, 10) : undefined;
        this.selectedVehicle = vid ?? null;
        sfx.tap();
        this.setPanel({ ...p, vid, view: 'todo' });
        return;
      }
      case 'buyFor': {
        const item = SHOP_ITEMS.find(i => i.id === arg);
        const err = sim.buyItem(arg as never);
        if (err) { sfx.error(); this.toast(err === 'Not enough money' ? `Not enough money for a ${item?.name.toLowerCase()}.` : err, 'bad'); return; }
        sfx.buy();
        this.toast(`Bought a ${item?.name.toLowerCase()}. It's waiting in the farmyard.`, 'good');
        break;
      }
      case 'unloadCombine': {
        const p = this.panel;
        if (p.kind !== 'combineTarget') return;
        const err = sim.orderUnloadCombine(p.tid, p.cid);
        if (err) { sfx.error(); this.toast(err, 'bad'); return; }
        sfx.confirm();
        this.setPanel({ kind: 'vehicle', id: p.tid });
        return;
      }
      case 'selectCombine': {
        const p = this.panel;
        if (p.kind === 'combineTarget') { sfx.select(); this.selectVehicle(p.cid); }
        return;
      }
      case 'drive': {
        if (this.selectedVehicle == null) return;
        const err = sim.startDriving(this.selectedVehicle);
        if (err) { sfx.error(); this.toast(err, 'bad'); return; }
        sfx.select();
        if (!sim.stats.drivenCells) this.toast('Push the stick up to drive, pull it back to brake or reverse, and tilt it to steer. Lower the tool to work as you go.', 'info', 'wheel');
        return;
      }
      case 'exitDrive': sfx.tap(); sim.stopDriving(); return;
      case 'implement': {
        const err = sim.toggleImplement();
        if (err) { sfx.error(); this.toast(err, 'bad'); } else sfx.tap();
        this.driveKey = '';
        return;
      }
      case 'driveCrop': {
        const v = sim.driven;
        const root = v && sim.toolOf(v)?.kind === 'planter';
        const list = CROPS.filter(c => !!CROP_DEFS[c].root === !!root);
        const next = list[(list.indexOf(sim.driveCrop) + 1) % list.length];
        sim.driveCrop = next;
        if (!sim.canPlant(next)) this.toast(`${CROP_DEFS[next].name} is planted in ${plantWindow(next)}.`, 'info', CROP_ICON[next]);
        if (sim.implDown) { sim.implDown = false; }
        sfx.tap();
        return;
      }
      case 'driveSpread': sim.driveSpread = sim.driveSpread === 'fertilize' ? 'lime' : 'fertilize'; sim.implDown = false; sfx.tap(); return;
      case 'dHitch': { const err = sim.driverHitch(); if (err) { sfx.error(); this.toast(err, 'bad'); } else sfx.confirm(); return; }
      case 'dUnload': { const err = sim.driverUnload(); if (err) { sfx.error(); this.toast(err, 'bad'); } else sfx.confirm(); return; }
      case 'dRefuel': { const err = sim.driverRefuel(); if (err) { sfx.error(); this.toast(err, 'bad'); } else sfx.confirm(); return; }
      case 'repair': {
        const v = this.selectedVehicle != null ? sim.vehicle(this.selectedVehicle) : undefined;
        if (!v) return;
        const cost = sim.repairCost(v);
        const err = sim.repair(v.id);
        if (err) { sfx.error(); this.toast(err, 'bad'); return; }
        sfx.buy();
        this.toast(`${v.name} repaired for ${money(cost)}.`, 'good', 'wrench');
        break;
      }
      case 'refuel': {
        if (this.selectedVehicle == null) return;
        const err = sim.orderRefuel(this.selectedVehicle);
        if (err) { sfx.error(); this.toast(err, 'bad'); } else sfx.confirm();
        break;
      }
      case 'borrow': { const err = sim.borrow(); if (err) { sfx.error(); this.toast(err, 'bad'); } else sfx.cash(); break; }
      case 'repay': { const err = sim.repay(); if (err) { sfx.error(); this.toast(err, 'bad'); } else sfx.tap(); break; }
      case 'follow': this.follow = !this.follow; sfx.tap(); break;
      case 'park': if (this.selectedVehicle != null) { sim.orderPark(this.selectedVehicle); sfx.tap(); } break;
      case 'deliver': {
        if (this.selectedVehicle == null) return;
        const err = sim.orderDeliver(this.selectedVehicle);
        if (err) { sfx.error(); this.toast(err, 'bad'); } else sfx.confirm();
        break;
      }
      case 'unhitch': {
        if (this.selectedVehicle == null) return;
        const err = sim.orderDetach(this.selectedVehicle);
        if (err) { sfx.error(); this.toast(err, 'bad'); } else sfx.tap();
        break;
      }
      case 'autoUnload': {
        const v = this.selectedVehicle != null ? sim.vehicle(this.selectedVehicle) : undefined;
        if (v) { v.autoUnload = !v.autoUnload; sfx.tap(); }
        break;
      }
      case 'deleteField': {
        const p = this.panel;
        if (p.kind !== 'field') return;
        this.ask(`Delete Field ${p.fid}? Any crops on it will be lost.`, 'Delete field', () => {
          sim.deleteField(p.fid);
          this.clearSelection();
          this.setPanel({ kind: 'home' });
        });
        return;
      }
      case 'buyParcel': {
        const i = parseInt(arg, 10);
        const err = sim.buyParcel(i);
        if (err) { sfx.error(); this.toast(err, 'bad'); return; }
        sfx.buy();
        this.toast('Land bought. Draw a field on it.', 'good');
        if (this.panel.kind === 'parcel') this.setPanel({ kind: 'home' });
        break;
      }
      case 'buyItem': {
        const err = sim.buyItem(arg as never);
        if (err) { sfx.error(); this.toast(err, 'bad'); return; }
        sfx.buy();
        this.toast(`Bought a ${SHOP_ITEMS.find(s => s.id === arg)!.name.toLowerCase()}. It's waiting in the farmyard.`, 'good');
        break;
      }
      case 'buyUpgrade': {
        const err = sim.buyUpgrade(arg as UpgradeId);
        if (err) { sfx.error(); this.toast(err, 'bad'); return; }
        sfx.buy();
        this.toast(`${UPGRADES[arg as UpgradeId].name} upgraded.`, 'good');
        break;
      }
      case 'sellSilo': {
        const got = sim.sellSilo(arg as CropId);
        if (got > 0) this.toast(`Sold ${CROP_DEFS[arg as CropId].name.toLowerCase()} for ${money(got)}.`, 'good');
        break;
      }
      case 'marketCrop': this.marketCrop = (arg || null) as CropId | null; sfx.tap(); break;
      case 'priceAlert': {
        const c = arg as CropId;
        const on = sim.togglePriceAlert(c);
        sfx.tap();
        if (on) this.toast(`We'll tell you when ${CROP_DEFS[c].name.toLowerCase()} sells high (${money(sim.highPrice(c))} or more).`, 'info', 'market');
        break;
      }
      case 'placePen': {
        const k = arg as AnimalKind;
        sfx.select();
        this.modal = null;
        this.clearSelection();
        this.placeAt = null;
        this.draftCells = [];
        this.draftValid = false;
        this.draftReason = '';
        this.setPanel({ kind: 'place', animal: k });
        this.toast(`Tap your land where the ${ANIMAL_DEFS[k].pen.toLowerCase()} should go.`, 'info', ANIMAL_ICON[k]);
        return;
      }
      case 'cancelPlace': sfx.tap(); this.placeAt = null; this.draftCells = []; this.setPanel({ kind: 'home' }); return;
      case 'buildPen': {
        const p = this.panel;
        if (p.kind !== 'place' || !this.placeAt) return;
        const err = sim.buildPen(p.animal, this.placeAt.x, this.placeAt.y);
        if (err) { sfx.error(); this.toast(err, 'bad'); return; }
        sfx.buy();
        const pen = sim.pens[sim.pens.length - 1];
        this.placeAt = null;
        this.draftCells = [];
        this.toast(`${ANIMAL_DEFS[p.animal].pen} built! ${ANIMAL_DEFS[p.animal].start} ${ANIMAL_DEFS[p.animal].plural.toLowerCase()} moved in.`, 'good', ANIMAL_ICON[p.animal]);
        this.setPanel({ kind: 'pen', id: pen.id });
        return;
      }
      case 'penFeed': {
        const p = this.panel;
        if (p.kind !== 'pen') return;
        const err = sim.orderFeed(p.id);
        if (err) { sfx.error(); this.toast(err, 'bad'); } else { sfx.confirm(); this.toast('A worker is loading feed at the silo.', 'info', 'wagon'); }
        break;
      }
      case 'penAuto': { const pen = this.panel.kind === 'pen' ? sim.pen(this.panel.id) : undefined; if (pen) { pen.autoFeed = !pen.autoFeed; sfx.tap(); } break; }
      case 'penBuy': { const err = this.panel.kind === 'pen' ? sim.buyAnimal(this.panel.id) : 'No pen'; if (err) { sfx.error(); this.toast(err, 'bad'); } else sfx.buy(); break; }
      case 'penSellAnimal': { const err = this.panel.kind === 'pen' ? sim.sellAnimal(this.panel.id) : 'No pen'; if (err) { sfx.error(); this.toast(err, 'bad'); } else sfx.cash(); break; }
      case 'penSell': {
        const p = this.panel;
        if (p.kind !== 'pen') return;
        const got = sim.sellProduce(p.id);
        if (got > 0) this.toast(`Sold for ${money(got)}.`, 'good', 'coin'); else { sfx.error(); this.toast('Nothing to sell yet.', 'bad'); }
        break;
      }
      case 'sellProduct': {
        let got = 0;
        for (const pen of sim.pens) if (ANIMAL_DEFS[pen.kind].product === arg) got += sim.sellProduce(pen.id);
        if (got > 0) this.toast(`Sold ${PRODUCT_DEFS[arg as keyof typeof PRODUCT_DEFS].name.toLowerCase()} for ${money(got)}.`, 'good', 'coin');
        break;
      }
      case 'penDemolish': {
        const p = this.panel;
        if (p.kind !== 'pen') return;
        const pen = sim.pen(p.id);
        if (!pen) return;
        this.ask(`Pull down the ${ANIMAL_DEFS[pen.kind].pen.toLowerCase()}? Its ${pen.animals} ${ANIMAL_DEFS[pen.kind].plural.toLowerCase()} will be sold.`, 'Pull down', () => {
          for (let i = pen.animals; i > 0; i--) sim.sellAnimal(pen.id);
          sim.sellProduce(pen.id);
          sim.demolishPen(pen.id);
          this.setPanel({ kind: 'home' });
        });
        return;
      }
      case 'dFeed': { const err = sim.driverFeed(); if (err) { sfx.error(); this.toast(err, 'bad'); } else sfx.confirm(); return; }
      case 'dLoad': { const err = sim.driverLoad(); if (err) { sfx.error(); this.toast(err, 'bad'); } else sfx.confirm(); return; }
      case 'deliverTo': sim.deliverTo = arg as 'silo' | 'sell'; sfx.tap(); break;
      case 'quality':
        if (arg === getQuality()) return;
        setQuality(arg as Quality);
        this.onSave();
        location.reload();
        return;
      case 'fullGraphics':
        setSafeMode(null);
        this.onSave();
        location.reload();
        return;
      case 'landscape': {
        this.modal = null;
        this.render(true);
        void this.goLandscape();
        return;
      }
      case 'mute': sim.muted = !sim.muted; setMuted(sim.muted); sfx.tap(); break;
      case 'save': this.onSave(); this.toast('Game saved.', 'info'); break;
      case 'reset':
        this.ask('Start a brand new farm? Your current progress will be erased.', 'Start over', () => this.onReset());
        return;
      case 'confirmYes': {
        const run = this.pending?.run;
        this.pending = null;
        this.modal = null;
        sfx.tap();
        run?.();
        break;
      }
    }
    this.render(true);
  }

  /** Full screen and locked sideways where the browser allows it; otherwise, a hint to rotate. */
  private async goLandscape() {
    sfx.tap();
    const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> };
    try {
      if (!document.fullscreenElement) {
        if (el.requestFullscreen) await el.requestFullscreen({ navigationUI: 'hide' });
        else await el.webkitRequestFullscreen?.();
      }
      const o = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
      if (o?.lock) await o.lock('landscape');
      else throw new Error('no lock');
    } catch {
      if (window.innerWidth < window.innerHeight) this.toast('Turn your phone sideways (switch on auto-rotate). The game is laid out for landscape too.', 'info', 'rotate');
    }
  }

  /** Landscape phones show sheets in a side panel; the 3D view keeps what you tapped beside it. */
  /** In portrait, lift the picture so the pen stays visible above its sheet. */
  get bottomCover() {
    if (this.panel.kind !== 'pen' || this.sideSheet || this.sim.drivenId != null) return 0;
    const now = performance.now();
    if (now - this.coverAt > 400) {
      this.coverAt = now;
      const sh = document.querySelector('#panel .sheet') as HTMLElement | null;
      this.cover = sh ? sh.getBoundingClientRect().height : 0;
    }
    return this.cover;
  }
  private cover = 0;
  private coverAt = 0;

  get sideSheet() {
    const land = window.innerWidth > window.innerHeight && window.innerHeight <= 600;
    return land && this.sim.drivenId == null && this.panel.kind !== 'home' && this.panel.kind !== 'draw';
  }

  private ask(msg: string, yes: string, run: () => void) {
    this.pending = { msg, yes, run };
    this.openModal('confirm');
  }

  /** Sends a machine (the chosen one, or the best free one) to do a job on a field. */
  private startJob(fid: number, op: Op, crop: CropId | undefined, vid?: number) {
    const sim = this.sim;
    const f = sim.world.fields.get(fid);
    if (!f) return;
    const pick = vid != null ? { vehicle: sim.vehicle(vid) } : sim.bestVehicleFor(f, op, crop);
    if (!pick.vehicle) { sfx.error(); this.toast(pick.reason ?? 'No machine available.', 'bad'); return; }
    const err = sim.orderFieldOp(pick.vehicle.id, fid, op, crop);
    if (err) { sfx.error(); this.toast(err, 'bad'); return; }
    sfx.confirm();
    const what = op === 'seed' && crop ? `plant ${CROP_DEFS[crop].name.toLowerCase()}` : OP_DEFS[op].name.toLowerCase();
    this.toast(`${pick.vehicle.name} is heading to Field ${fid} to ${what}.`, 'info', VEHICLE_ICON[pick.vehicle.kind]);
    this.selectedVehicle = null;
    this.setPanel({ kind: 'field', fid, view: 'todo' });
  }

  /** A worker brings the machine and tool to the field for free, then hands you the wheel. */
  private startDriveJob(fid: number, op: Op, crop: CropId | undefined, vid?: number) {
    const sim = this.sim;
    const f = sim.world.fields.get(fid);
    if (!f) return;
    const pick = vid != null ? { vehicle: sim.vehicle(vid) } : sim.bestVehicleFor(f, op, crop);
    if (!pick.vehicle) { sfx.error(); this.toast(pick.reason ?? 'No machine available.', 'bad'); return; }
    const err = sim.orderDriveJob(pick.vehicle.id, fid, op, crop);
    if (err) { sfx.error(); this.toast(err, 'bad'); return; }
    sfx.confirm();
    const at = Math.hypot(pick.vehicle.x - f.center.x, pick.vehicle.y - f.center.y) > 12;
    this.toast(at ? `${pick.vehicle.name} is on its way to Field ${fid}. You take the wheel when it gets there.` : `Your turn: push the stick up.`, 'info', 'wheel');
    this.clearSelection();
    this.selectedVehicle = pick.vehicle.id;
    this.follow = true;
    this.setPanel({ kind: 'vehicle', id: pick.vehicle.id });
  }

  get placing() { return this.panel.kind === 'place'; }

  /** Centers the pen footprint on the tapped spot and checks it. */
  private movePlacement(cx: number, cy: number) {
    const p = this.panel;
    if (p.kind !== 'place') return;
    const d = ANIMAL_DEFS[p.animal];
    const x = Math.round(cx - d.w / 2), y = Math.round(cy - d.h / 2);
    this.placeAt = { x, y };
    const cells: Pt[] = [];
    for (let yy = y; yy < y + d.h; yy++) for (let xx = x; xx < x + d.w; xx++) cells.push({ x: xx, y: yy });
    this.draftCells = cells;
    const res = this.sim.world.validatePen(p.animal, x, y, this.sim.owned);
    this.draftValid = res.ok;
    this.draftReason = res.reason ?? '';
    sfx.corner();
    this.render(true);
  }

  // ---------- field drawing ----------

  private addCorner(cx: number, cy: number) {
    const p = { x: Math.round(cx), y: Math.round(cy) };
    const first = this.draft[0];
    if (first && this.draft.length >= 4 && Math.hypot(first.x - cx, first.y - cy) < 0.9) {
      this.finishDraft();
      return;
    }
    const last = this.draft[this.draft.length - 1];
    if (last && last.x === p.x && last.y === p.y) return;
    this.draft.push(p);
    sfx.corner();
    this.updateDraft();
    this.render(true);
  }

  private updateDraft() {
    if (this.draft.length >= 3) {
      const res = this.sim.world.validateOutline(this.draft, this.sim.owned);
      this.draftCells = res.cells;
      this.draftValid = res.ok;
      this.draftReason = res.reason ?? '';
    } else {
      this.draftCells = [];
      this.draftValid = false;
      this.draftReason = this.draft.length === 0 ? '' : `Add ${4 - this.draft.length} more corner${this.draft.length === 3 ? '' : 's'}`;
    }
  }

  private finishDraft() {
    const err = this.sim.createField(this.draft);
    if (err) { sfx.error(); this.toast(err, 'bad'); return; }
    sfx.confirm();
    this.drawMode = false;
    this.draft = [];
    this.updateDraft();
    const id = Math.max(...this.sim.world.fields.keys());
    this.toast(`Field ${id} is ready. Tap it to see what it needs.`, 'good', 'field');
    this.setPanel({ kind: 'home' });
  }

  // ---------- rendering ----------

  private render(force = false) {
    const panelHtml = this.sim.drivenId != null ? '' : this.renderPanel();
    if (force || panelHtml !== this.panelHtml) {
      if (panelHtml !== this.panelHtml) {
        // Only slide a sheet in when a different one opens; live refreshes swap it in place.
        const p = this.panel;
        const key = `${p.kind}:${'id' in p ? p.id : ''}:${'fid' in p ? p.fid : ''}:${'view' in p ? p.view : ''}`;
        this.swap($('#panel'), panelHtml, key === this.panelKey);
        this.panelKey = key;
      }
      this.panelHtml = panelHtml;
    }
    const modalHtml = this.modal ? this.renderModal() : '';
    if (modalHtml !== this.modalHtml) {
      const m = $('#modal');
      const key = `${this.modal}:${this.shopTab}:${this.marketCrop ?? ''}`;
      this.swap(m, modalHtml, key === this.modalKey && !m.classList.contains('hidden'));
      m.classList.toggle('hidden', !this.modal);
      this.modalHtml = modalHtml;
      this.modalKey = key;
    }
    const goalHtml = this.renderGoal();
    if (goalHtml !== this.goalHtml) { $('#goal').innerHTML = goalHtml; this.goalHtml = goalHtml; }
    $('#goal').classList.toggle('open', this.goalOpen);
    this.updateLive();
  }

  /** Replaces a container's HTML, keeping scroll positions and skipping the entry animation on refreshes. */
  private swap(box: HTMLElement, html: string, refresh: boolean) {
    const scroll = refresh ? [...box.querySelectorAll<HTMLElement>('.sheet, .card, .packets')].map(el => [el.scrollTop, el.scrollLeft]) : [];
    box.innerHTML = html;
    if (!refresh) return;
    box.querySelectorAll<HTMLElement>('.sheet, .card').forEach(el => el.classList.add('still'));
    box.querySelectorAll<HTMLElement>('.sheet, .card, .packets').forEach((el, i) => {
      if (scroll[i]) { el.scrollTop = scroll[i][0]; el.scrollLeft = scroll[i][1]; }
    });
  }

  private updateLive() {
    document.querySelectorAll<HTMLElement>('[data-live]').forEach(el => {
      const key = el.dataset.live!;
      const fn = this.live.get(key) ?? this.dynamicLive(key);
      if (!fn) return;
      const val = fn();
      if (el.dataset.bar != null) {
        const w = `${Math.max(0, Math.min(100, parseFloat(val)))}%`;
        if (el.style.width !== w) el.style.width = w;
      } else if (el.textContent !== val) {
        el.textContent = val;
      }
    });
    for (const id of ['money', 'clock', 'speed']) {
      const el = document.getElementById(id);
      const val = this.live.get(id)!();
      if (el && el.textContent !== val) el.textContent = val;
    }
    const h = this.sim.timeOfDay / 60;
    const w = this.sim.weather;
    const wx = this.sim.season === 'winter' && (w === 'rain' || w === 'storm') ? 'snow'
      : w === 'sun' && (h < 6 || h >= 19) ? 'moon' : WEATHER_ICON[w];
    $('#top .money').classList.toggle('neg', this.sim.money < 0);
    if (wx !== this.wxKey) { this.wxKey = wx; $('#wx').innerHTML = icon(wx); }
  }

  /** Live values keyed like "vstatus:3". */
  private dynamicLive(key: string): (() => string) | undefined {
    const [k, idStr] = key.split(':');
    const id = parseInt(idStr, 10);
    const sim = this.sim;
    const summary = () => sim.world.fields.get(id)?.summary(sim.growth);
    switch (k) {
      case 'vstatus': return () => stripEmoji(sim.vehicle(id)?.status ?? '');
      case 'vcargo': return () => {
        const v = sim.vehicle(id); const c = v && sim.cargoOf(v);
        if (!c) return '';
        return c.cargo.amount > 0 && c.cargo.crop ? `${CROP_DEFS[c.cargo.crop].name} ${liters(c.cargo.amount)} / ${liters(c.cap)}` : `Empty · holds ${liters(c.cap)}`;
      };
      case 'vcargobar': return () => {
        const v = sim.vehicle(id); const c = v && sim.cargoOf(v);
        return c ? String((c.cargo.amount / c.cap) * 100) : '0';
      };
      case 'fstate': return () => this.fieldStateText(id);
      case 'fbar': return () => { const s = summary(); return s ? String(s.ready ? 100 : s.growthPct) : '0'; };
      case 'fyield': return () => `${summary()?.yieldPct ?? 100}%`;
      case 'ffert': return () => `${(summary()?.fertAvg ?? 0).toFixed(1)} / 2`;
      case 'flime': return () => { const s = summary(); return s && s.needLime ? `${Math.round((s.needLime / s.total) * 100)}% sour` : 'OK'; };
      case 'fweeds': return () => { const s = summary(); return s && s.weedy ? `${Math.round((s.weedy / s.total) * 100)}%` : 'None'; };
      case 'silo': return () => liters(sim.silo[idStr as CropId] ?? 0);
      case 'panimals': return () => { const p = sim.pen(id); return p ? `${p.animals} / ${ANIMAL_DEFS[p.kind].cap}` : ''; };
      case 'phappy': return () => `${Math.round(sim.pen(id)?.happiness ?? 0)}%`;
      case 'pfeed': return () => { const p = sim.pen(id); if (!p) return ''; const days = sim.penFeedDays(p); return p.food <= 0 ? 'Empty' : days > 99 ? 'Plenty' : `${days.toFixed(1)} d`; };
      case 'pstored': return () => { const p = sim.pen(id); if (!p) return ''; const pd = PRODUCT_DEFS[ANIMAL_DEFS[p.kind].product]; return `${Math.floor(p.stored).toLocaleString()} ${pd.unit}`; };
      case 'ptrough': return () => { const p = sim.pen(id); return p ? `${liters(p.food)} / ${liters(ANIMAL_DEFS[p.kind].trough)}` : ''; };
      case 'pfeedsilo': return () => { const p = sim.pen(id); return p ? liters(sim.feedInSilo(p.kind)) : ''; };
      case 'prate': return () => { const p = sim.pen(id); if (!p) return ''; const d = ANIMAL_DEFS[p.kind]; const units = p.animals * d.perDay; return `${units < 10 ? units.toFixed(1) : Math.round(units)} ${PRODUCT_DEFS[d.product].unit} (${money(units * sim.productPrices[d.product])})`; };
      case 'pstatus': return () => {
        const p = sim.pen(id);
        if (!p) return '';
        const d = ANIMAL_DEFS[p.kind];
        if (p.animals <= 0) return 'Empty. Buy some animals.';
        if (p.food <= 0) return `Out of feed! The ${d.plural.toLowerCase()} have stopped producing.`;
        if (p.food < d.trough * 0.2) return 'Feed is running low.';
        if (p.stored >= d.storage - 0.5) return 'Storage full: sell before it goes to waste.';
        return p.happiness > 75 ? `Well fed and happy.` : 'Settling in.';
      };
      case 'vfuel': return () => { const v = sim.vehicle(id); return v ? `${Math.round(v.fuel)} / ${FUEL_CAP[v.kind]} L` : ''; };
      case 'vcond': return () => { const v = sim.vehicle(id); return v ? `${Math.round(v.condition)}%` : ''; };
    }
    return undefined;
  }

  private fieldStateText(fid: number) {
    const f = this.sim.world.fields.get(fid);
    if (!f) return '';
    const s = f.summary(this.sim.growth);
    const pct = (n: number) => `${Math.round((n / s.total) * 100)}%`;
    const crop = CROPS.find(c => s.cropCounts[c] > 0);
    const parts: string[] = [];
    if (crop) parts.push(CROP_DEFS[crop].name);
    if (s.ready) parts.push(`${pct(s.ready)} ripe`);
    if (s.damaged) parts.push(`${pct(s.damaged)} flattened by storms`);
    if (s.growing) parts.push(`growing, ${s.growthPct}% of the way${this.sim.season === 'winter' ? ' (resting for winter)' : ''}`);
    if (s.plowed) parts.push(`${pct(s.plowed)} plowed, ready to plant`);
    if (s.grass) parts.push(`${pct(s.grass)} grass`);
    if (s.stubble) parts.push(`${pct(s.stubble)} stubble`);
    return parts.join(' · ');
  }

  /** A rubber-stamp word for the field's main state. */
  private fieldStamp(f: Field) {
    const s = f.summary(this.sim.growth);
    if (s.ready) return '<span class="stamp red">Ripe</span>';
    if (s.growing) return '<span class="stamp green">Growing</span>';
    if (s.plowed) return '<span class="stamp brown">Plowed</span>';
    if (s.stubble) return '<span class="stamp brown">Stubble</span>';
    return '<span class="stamp green">Grass</span>';
  }

  private renderGoal() {
    const g = GOALS[this.sim.goalIdx];
    if (!g) return `<span class="g-row">${icon('flag')}<span class="g-title">Every goal complete</span></span>`;
    const [cur, target] = g.progress(this.sim.stats);
    const pct = Math.min(100, (cur / target) * 100);
    const count = target >= 1000 ? `${Math.round(pct)}%` : `${Math.min(cur, target)}/${target}`;
    return `
      <span class="g-row">${icon('flag')}<span class="g-title">${g.title}</span><span class="g-count fig">${count}</span></span>
      <span class="g-bar"><span style="width:${pct}%"></span></span>
      <span class="g-more">${g.hint} <b class="fig">Reward ${money(g.reward)}</b></span>`;
  }

  private sheetHead(eyebrow: string, title: string, opts: { back?: boolean; stamp?: string; ico?: string } = {}) {
    return `<header class="sh-head">
      ${opts.back ? `<button class="sq" data-act="back" aria-label="Back">${icon('back')}</button>` : opts.ico ? `<span class="sh-ico">${icon(opts.ico)}</span>` : ''}
      <div class="sh-title"><small class="eyebrow">${eyebrow}</small><h3>${title}</h3></div>
      ${opts.stamp ?? ''}
      <button class="sq" data-act="close" aria-label="Close">${icon('close')}</button>
    </header>`;
  }

  private renderPanel(): string {
    const p = this.panel;
    const sim = this.sim;
    switch (p.kind) {
      case 'home':
        return `
          <nav class="tabbar">
            <button data-act="draw">${icon('newField')}<span>Draw field</span></button>
            <button data-act="modal" data-arg="fleet">${icon('fleet')}<span>Fleet</span></button>
            <button data-act="modal" data-arg="shop">${icon('shop')}<span>Shop</span></button>
            <button data-act="modal" data-arg="market">${icon('market')}<span>Market</span></button>
          </nav>`;
      case 'draw': {
        const n = this.draft.length;
        const msg = n === 0
          ? 'Tap the grid corners of your field on land you own. Four corners or more, then tap the first corner again.'
          : this.draftValid ? `${this.draftCells.length} cells, ${ha(this.draftCells.length)}. Tap the first corner or Create.` : this.draftReason;
        return `
          <section class="sheet">
            <header class="sh-head"><span class="sh-ico">${icon('newField')}</span>
              <div class="sh-title"><small class="eyebrow">New field</small><h3>${n} corner${n === 1 ? '' : 's'}</h3></div></header>
            <p class="note ${n && !this.draftValid ? 'warn' : ''}">${msg}</p>
            <div class="btnrow">
              <button data-act="undo" ${n ? '' : 'disabled'}>${icon('undo')}Undo</button>
              <button data-act="cancelDraw">${icon('close')}Cancel</button>
              <button class="primary" data-act="createField" ${this.draftValid ? '' : 'disabled'}>${icon('check')}Create</button>
            </div>
          </section>`;
      }
      case 'vehicle': {
        const v = sim.vehicle(p.id);
        if (!v) return '';
        const tool = sim.toolOf(v);
        const cargo = sim.cargoOf(v);
        return `
          <section class="sheet">
            ${this.sheetHead(VEHICLE_NAMES[v.kind], v.name, { ico: VEHICLE_ICON[v.kind] })}
            ${v.kind === 'tractor' ? `<p class="meta">${tool ? `${icon(TOOL_ICON[tool.kind])}${cap1(TOOL_NAMES[tool.kind])} hitched` : 'No implement hitched'}</p>` : ''}
            <p class="status" data-live="vstatus:${v.id}"></p>
            ${cargo ? `<div class="gauge"><div class="gauge-bar"><span data-live="vcargobar:${v.id}" data-bar></span></div><span class="fig small" data-live="vcargo:${v.id}"></span></div>` : ''}
            <dl class="soil two">
              <div><dt>${icon('fuel')}Fuel</dt><dd class="fig" data-live="vfuel:${v.id}"></dd></div>
              <div><dt>${icon('wrench')}Condition</dt><dd class="fig" data-live="vcond:${v.id}"></dd></div>
            </dl>
            <div class="btnrow">
              <button class="primary" data-act="drive">${icon('wheel')}Drive</button>
              ${v.fuel < FUEL_CAP[v.kind] * 0.9 ? `<button data-act="refuel">${icon('fuel')}Refuel</button>` : ''}
              ${v.condition < 90 ? `<button data-act="repair" ${sim.money >= sim.repairCost(v) ? '' : 'disabled'}>${icon('wrench')}Repair <span class="fig">${money(sim.repairCost(v))}</span></button>` : ''}
            </div>
            <div class="btnrow">
              <button data-act="follow" class="${this.follow ? 'on' : ''}">${icon('follow')}Follow</button>
              <button data-act="park">${icon('park')}Park</button>
              ${cargo ? `<button data-act="deliver">${icon('unload')}${sim.deliverTo === 'sell' ? 'Sell load' : 'To silo'}</button>` : ''}
              ${v.kind === 'tractor' && tool ? `<button data-act="unhitch">${icon('unhitch')}Unhitch</button>` : ''}
              ${isHarvester(v) ? `<button data-act="autoUnload" class="${v.autoUnload ? 'on' : ''}">${icon('wagon')}Auto-haul ${v.autoUnload ? 'on' : 'off'}</button>` : ''}
            </div>
          </section>`;
      }
      case 'combineTarget': {
        const t = sim.vehicle(p.tid), c = sim.vehicle(p.cid);
        if (!t || !c) return '';
        const tank = c.tank.amount > 0 && c.tank.crop ? `${CROP_DEFS[c.tank.crop].name}, ${liters(c.tank.amount)} of ${liters(sim.cargoOf(c)!.cap)}` : 'empty';
        return `
          <section class="sheet">
            ${this.sheetHead('Haul crop', `${t.name} → ${c.name}`, { back: true })}
            <p class="status">Tank is ${tank}.</p>
            <div class="ledger">
              <button class="lrow" data-act="unloadCombine"><span class="lr-ico">${icon('wagon')}</span>
                <span class="lr-main"><span class="lr-line"><b>Haul the crop</b><i></i></span><small>Hitch the wagon, drive alongside, then ${sim.deliverTo === 'sell' ? 'sell it' : 'store it in the silo'}.</small></span>${icon('chevron', 'go')}</button>
              <button class="lrow" data-act="selectCombine"><span class="lr-ico">${vIco(c)}</span>
                <span class="lr-main"><span class="lr-line"><b>Give ${c.name} orders</b><i></i></span><small>Select the harvester instead.</small></span>${icon('chevron', 'go')}</button>
            </div>
          </section>`;
      }
      case 'field': return this.renderField(p);
      case 'place': {
        const d = ANIMAL_DEFS[p.animal];
        const msg = !this.placeAt ? `Tap your land to place it (${d.w} × ${d.h} cells). The gate and feed trough face down the screen.`
          : this.draftValid ? `Looks good. Build here for ${money(d.penCost)}?` : this.draftReason;
        return `<section class="sheet">
          <header class="sh-head"><span class="sh-ico">${icon(ANIMAL_ICON[p.animal])}</span>
            <div class="sh-title"><small class="eyebrow">Build</small><h3>${d.pen}</h3></div></header>
          <p class="note ${this.placeAt && !this.draftValid ? 'warn' : ''}">${msg}</p>
          <div class="btnrow">
            <button data-act="cancelPlace">${icon('close')}Cancel</button>
            <button class="primary" data-act="buildPen" ${this.placeAt && this.draftValid && sim.money >= d.penCost ? '' : 'disabled'}>${icon('check')}Build</button>
          </div>
        </section>`;
      }
      case 'pen': return this.renderPen(p.id);
      case 'parcel': {
        const price = parcelPrice(p.index);
        const r = parcelRect(p.index);
        const afford = sim.money >= price;
        return `
          <section class="sheet">
            ${this.sheetHead('Land for sale', `Plot ${p.index + 1}`, { ico: 'map' })}
            <div class="ledger compact">
              <div class="lrow static"><span class="lr-main"><span class="lr-line"><b>Size</b><i></i><span class="fig">${r.w} × ${r.h} · ${ha(r.w * r.h)}</span></span></span></div>
              <div class="lrow static"><span class="lr-main"><span class="lr-line"><b>Price</b><i></i><span class="fig">${money(price)}</span></span></span></div>
            </div>
            <div class="btnrow">
              <button data-act="close">Not now</button>
              <button class="primary" data-act="buyParcel" data-arg="${p.index}" ${afford ? '' : 'disabled'}>${afford ? `Buy for ${money(price)}` : `Need ${money(price - sim.money)} more`}</button>
            </div>
          </section>`;
      }
      case 'silo':
        return `
          <section class="sheet">
            ${this.sheetHead('Farm silo', `Holds ${liters(SILO_CAP)} per crop`, { ico: 'silo' })}
            <div class="ledger compact">${CROPS.map(c => `
              <div class="lrow static"><span class="lr-ico">${icon(CROP_ICON[c])}</span>
                <span class="lr-main"><span class="lr-line"><b>${CROP_DEFS[c].name}</b><i></i><span class="fig" data-live="silo:${c}"></span></span>
                <small>${money(sim.prices[c])} per 1,000 L today</small></span>
                <button class="mini" data-act="sellSilo" data-arg="${c}" ${sim.silo[c] > 0 ? '' : 'disabled'}>Sell</button></div>`).join('')}</div>
          </section>`;
    }
  }

  private renderPen(id: number) {
    const sim = this.sim;
    const pen = sim.pen(id);
    if (!pen) return '';
    const d = ANIMAL_DEFS[pen.kind];
    const pd = PRODUCT_DEFS[d.product];
    const hungry = pen.food <= 0;
    const stamp = hungry ? '<span class="stamp red">Hungry</span>' : pen.happiness > 75 ? '<span class="stamp green">Happy</span>' : '<span class="stamp brown">Content</span>';
    const price = sim.productPrices[d.product];
    const run = sim.vehicles.find(v => v.steps.some(st => (st.t === 'load' || st.t === 'unload') && st.penId === id));
    return `<section class="sheet">
      ${this.sheetHead(`${d.plural} · ${d.w}×${d.h}`, d.pen, { ico: ANIMAL_ICON[pen.kind], stamp })}
      <p class="status" data-live="pstatus:${id}"></p>
      <dl class="soil">
        <div><dt>${d.plural}</dt><dd class="fig" data-live="panimals:${id}"></dd></div>
        <div><dt>Happy</dt><dd class="fig" data-live="phappy:${id}"></dd></div>
        <div><dt>Feed</dt><dd class="fig" data-live="pfeed:${id}"></dd></div>
        <div><dt>${pd.name}</dt><dd class="fig" data-live="pstored:${id}"></dd></div>
      </dl>
      <div class="ledger">
        <div class="lrow static"><span class="lr-ico">${icon('wagon')}</span>
          <span class="lr-main"><span class="lr-line"><b>Feed trough</b><i></i><span class="fig" data-live="ptrough:${id}"></span></span>
          <small>Eats ${d.diet.map(c => CROP_DEFS[c].name.toLowerCase()).join(', ')} from your silo (in the silo now: <span class="fig" data-live="pfeedsilo:${id}"></span>). ${run ? `<b class="who">${run.name} is bringing feed.</b>` : 'Drive a wagon here yourself, or send a worker.'}</small>
          <span class="job-btns">
            <button class="primary" data-act="penFeed" ${run ? 'disabled' : ''}>${icon('fleet')}<span>Bring feed</span></button>
            <button data-act="penAuto" class="${pen.autoFeed ? 'on' : ''}">${icon('check')}<span>Auto-feed ${pen.autoFeed ? 'on' : 'off'}</span></button>
          </span></span></div>
        <div class="lrow static"><span class="lr-ico">${icon(pd.icon)}</span>
          <span class="lr-main"><span class="lr-line"><b>${pd.name}</b><i></i><span class="fig">${money(price)} / ${pd.unit === 'L' ? 'L' : pd.unit === 'kg' ? 'kg' : pd.unit.replace(/s$/, '')}</span></span>
          <small>About <span class="fig" data-live="prate:${id}"></span> a day when fed and happy.</small></span>
          <button class="mini" data-act="penSell">Sell</button></div>
        <div class="lrow static"><span class="lr-ico">${icon(ANIMAL_ICON[pen.kind])}</span>
          <span class="lr-main"><span class="lr-line"><b>Buy or sell ${d.plural.toLowerCase()}</b><i></i><span class="fig">${money(d.animalCost)}</span></span>
          <small>Happy ${d.plural.toLowerCase()} ${d.breedDays ? 'raise young on their own' : 'give piglets you can sell'}. Room for ${d.cap}.</small>
          <span class="job-btns">
            <button class="primary" data-act="penBuy" ${pen.animals < d.cap && sim.money >= d.animalCost ? '' : 'disabled'}>${icon('plus')}<span>Buy one</span></button>
            <button data-act="penSellAnimal" ${pen.animals > 0 ? '' : 'disabled'}>${icon('minus')}<span>Sell one <span class="fig">${money(d.animalCost * 0.6)}</span></span></button>
          </span></span></div>
      </div>
      <div class="btnrow"><button class="danger" data-act="penDemolish">${icon('trash')}Pull down</button></div>
    </section>`;
  }

  private needRow(f: Field, n: Need, vid: number | undefined, next: boolean) {
    const sim = this.sim;
    const d = OP_DEFS[n.op];
    const title = n.op === 'seed' ? 'Plant a crop' : d.name;
    const head = (side: string, who: string) => `<span class="lr-ico">${icon(OP_ICON[n.op])}</span>
      <span class="lr-main"><span class="lr-line"><b>${title}</b><i></i>${side}</span>
        <small>${n.why}</small>${who}</span>
      ${next ? '<span class="stamp-mini">Next</span>' : ''}`;
    if (n.op === 'seed') {
      return `<button class="lrow ${next ? 'next' : ''}" data-act="need" data-arg="seed">${head('', '<small class="who">Choose a crop</small>')}</button>`;
    }
    const v = vid != null ? sim.vehicle(vid) : undefined;
    const check = v ? sim.checkFieldOp(v, f, n.op) : undefined;
    const pick = v ? (check!.ok ? { vehicle: v } : { reason: check!.reason }) : sim.bestVehicleFor(f, n.op);
    const supplies = d.costPerCell ? `<span class="fig">${money(roundTo(sim.eligibleCount(f, n.op) * d.costPerCell, 10))}</span>` : '';
    if (pick.vehicle) {
      const est = sim.estimateJob(pick.vehicle, f, n.op);
      return `<div class="lrow job ${next ? 'next' : ''}">
        ${head(supplies, `<small class="who">${pick.vehicle.name}</small>`)}
        <span class="job-btns">
          <button class="primary" data-act="need" data-arg="${n.op}">${icon('fleet')}<span>Hire <span class="fig">${money(roundTo(est.wage, 10))}</span></span></button>
          <button data-act="driveJob" data-arg="${n.op}">${icon('wheel')}<span>Drive</span></button>
        </span></div>`;
    }
    if ('buy' in pick && pick.buy) {
      const item = SHOP_ITEMS.find(i => i.id === pick.buy)!;
      return `<button class="lrow ${next ? 'next' : ''}" data-act="buyFor" data-arg="${item.id}">
        ${head(`<span class="fig">${money(item.cost)}</span>`, `<small class="who"><span class="warn">Buy a ${item.name.toLowerCase()} first</span></small>`)}</button>`;
    }
    return `<div class="lrow ${next ? 'next' : ''}">${head(supplies, `<small class="who"><span class="warn">${pick.reason}</span></small>`)}</div>`;
  }

  private renderField(p: Extract<Panel, { kind: 'field' }>): string {
    const sim = this.sim;
    const f = sim.world.fields.get(p.fid);
    if (!f) return '';
    const v = p.vid != null ? sim.vehicle(p.vid) : undefined;
    let needs = sim.fieldNeeds(f);
    if (v) needs = needs.filter(n => (n.op === 'harvest') === (v.kind !== 'tractor'));
    const head = `
      ${this.sheetHead(`Field · ${ha(f.cells.length)}`, `No. ${f.id}`, { back: p.view !== 'todo' || !!v, ico: 'field', stamp: this.fieldStamp(f) })}
      ${v ? `<p class="meta">${vIco(v)}Orders for <b>${v.name}</b> <button class="link" data-act="pickMachine" data-arg="">any machine</button></p>` : ''}
      <p class="status" data-live="fstate:${f.id}"></p>
      <dl class="soil">
        <div><dt>Yield</dt><dd class="fig" data-live="fyield:${f.id}"></dd></div>
        <div><dt>Fertilizer</dt><dd class="fig" data-live="ffert:${f.id}"></dd></div>
        <div><dt>Lime</dt><dd class="fig" data-live="flime:${f.id}"></dd></div>
        <div><dt>Weeds</dt><dd class="fig" data-live="fweeds:${f.id}"></dd></div>
      </dl>`;
    if (p.view === 'plant') {
      const cells = sim.eligibleCount(f, 'seed');
      const crops = CROPS.map(c => {
        const d = CROP_DEFS[c];
        const noPlanter = d.root && !sim.tools.some(t => t.kind === 'planter');
        const season = sim.canPlant(c);
        return `<button class="packet ${season ? '' : 'off'}" data-act="plant" data-arg="${c}" ${noPlanter || !season ? 'disabled' : ''}>
          ${icon(CROP_ICON[c], 'packet-ico')}<b>${d.name}</b>
          <span class="pk-row"><span>Grows</span><span class="fig">${d.growDays} d</span></span>
          <span class="pk-row"><span>Sells</span><span class="fig">${money(sim.prices[c])}</span></span>
          <span class="pk-row"><span>Seed</span><span class="fig">${noPlanter ? '—' : money(cells * d.seedCostPerCell)}</span></span>
          <span class="pk-row"><span>Plant</span><span class="fig">${d.seasons.map(x => SEASON_NAMES[x].slice(0, 3)).join('/')}</span></span>
          ${!season ? `<small class="warn">Not in ${sim.seasonName.toLowerCase()}</small>` : noPlanter ? '<small class="warn">Needs root planter</small>' : ''}</button>`;
      }).join('');
      const by = `<div class="tabs"><button data-act="plantBy" data-arg="hire" class="${this.plantBy === 'hire' ? 'on' : ''}">Hire a worker</button><button data-act="plantBy" data-arg="drive" class="${this.plantBy === 'drive' ? 'on' : ''}">Drive myself</button></div>`;
      return `<section class="sheet">${head}${by}<p class="note">Pick a crop for ${sim.seasonName.toLowerCase()}. Prices are per 1,000 L.</p><div class="packets">${crops}</div></section>`;
    }
    if (p.view === 'machines') {
      const list = sim.vehicles.map(m => `<button class="lrow" data-act="pickMachine" data-arg="${m.id}">
        <span class="lr-ico">${vIco(m)}</span><span class="lr-main"><span class="lr-line"><b>${m.name}</b><i></i></span><small data-live="vstatus:${m.id}"></small></span>${icon('chevron', 'go')}</button>`).join('');
      return `<section class="sheet">${head}<p class="note">Which machine should work this field?</p><div class="ledger">${list}</div></section>`;
    }
    if (p.view === 'more') {
      const rest = needs.slice(3).map(n => this.needRow(f, n, p.vid, false)).join('');
      return `<section class="sheet">${head}
        ${rest ? `<div class="ledger">${rest}</div>` : '<p class="note">No other jobs for this field right now.</p>'}
        <div class="btnrow"><button class="danger" data-act="deleteField">${icon('trash')}Delete field</button></div></section>`;
    }
    const top = needs.slice(0, 3).map((n, i) => this.needRow(f, n, p.vid, i === 0)).join('');
    return `<section class="sheet">${head}
      ${top ? `<div class="ledger">${top}</div>` : '<p class="note">Nothing to do right now. The crop is growing; come back when it’s ripe.</p>'}
      <div class="btnrow">
        <button data-act="fieldView" data-arg="more">More jobs${needs.length > 3 ? ` (${needs.length - 3})` : ''}</button>
        ${v ? '' : `<button data-act="fieldView" data-arg="machines">${icon('tractor')}Choose machine</button>`}
      </div></section>`;
  }

  private renderModal(): string {
    const sim = this.sim;
    const head = (eyebrow: string, title: string) => `<header class="sh-head">
      <div class="sh-title"><small class="eyebrow">${eyebrow}</small><h3>${title}</h3></div>
      <button class="sq" data-act="closeModal" aria-label="Close">${icon('close')}</button></header>`;
    switch (this.modal) {
      case 'confirm':
        return `<div class="card small-card">
          <p class="lead">${this.pending?.msg ?? ''}</p>
          <div class="btnrow">
            <button data-act="closeModal">Cancel</button>
            <button class="primary danger-fill" data-act="confirmYes">${this.pending?.yes ?? 'OK'}</button>
          </div>
        </div>`;
      case 'finance': {
        const row = (label: string, key: keyof Ledger, sign: 1 | -1) => {
          const a = sim.ledger.today[key], b = sim.ledger.yesterday[key];
          const f = (n: number) => n ? `${sign < 0 ? '-' : '+'}${money(n)}` : '—';
          return `<div class="lrow static"><span class="lr-main"><span class="lr-line"><b>${label}</b><i></i><span class="fig">${f(a)}</span><span class="fig dim">${f(b)}</span></span></span></div>`;
        };
        const net = (l: Ledger) => l.sales - l.fuel - l.wages - l.repairs - l.interest - l.supplies;
        const n0 = net(sim.ledger.today), n1 = net(sim.ledger.yesterday);
        return `<div class="card">
          ${head('Farm accounts', `Balance <span class="fig">${sim.money < 0 ? '-' : ''}${money(Math.abs(sim.money))}</span>`)}
          <div class="lrow static cols"><span class="lr-main"><span class="lr-line"><small>Day ${sim.day}</small><i></i><small class="fig">Today</small><small class="fig dim">Yesterday</small></span></span></div>
          <div class="ledger compact">
            ${row('Sales', 'sales', 1)}
            ${row('Wages', 'wages', -1)}
            ${row('Fuel', 'fuel', -1)}
            ${row('Seed & supplies', 'supplies', -1)}
            ${row('Repairs', 'repairs', -1)}
            ${row('Loan interest', 'interest', -1)}
            <div class="lrow static total"><span class="lr-main"><span class="lr-line"><b>Net</b><i></i><span class="fig ${n0 < 0 ? 'warn' : ''}">${n0 < 0 ? '-' : '+'}${money(Math.abs(n0))}</span><span class="fig dim">${n1 < 0 ? '-' : '+'}${money(Math.abs(n1))}</span></span></span></div>
          </div>
          <p class="note">Hired workers cost ${money(WAGE_PER_SEC * 60)} a minute while they work. Drive a machine yourself and it's free.</p>
          <p class="eyebrow gap">Bank loan</p>
          <div class="lrow static"><span class="lr-ico">${icon('bank')}</span><span class="lr-main"><span class="lr-line"><b>Owed</b><i></i><span class="fig">${money(sim.loan)}</span></span>
            <small>${(LOAN_DAILY_RATE * 100).toFixed(1)}% interest a day · up to ${money(LOAN_MAX)}</small></span></div>
          <div class="btnrow">
            <button data-act="repay" ${sim.loan > 0 && sim.money >= Math.min(LOAN_STEP, sim.loan) ? '' : 'disabled'}>Repay ${money(Math.min(LOAN_STEP, sim.loan || LOAN_STEP))}</button>
            <button class="primary" data-act="borrow" ${sim.loan + LOAN_STEP <= LOAN_MAX ? '' : 'disabled'}>Borrow ${money(LOAN_STEP)}</button>
          </div>
        </div>`;
      }
      case 'welcome':
        return `<div class="card">
          ${head('Harvest Valley', 'Your farm')}
          <p class="lead">You own a plot of land, a tractor, a combine and a few implements. Here's how a season works:</p>
          <ol class="steps">
            <li><b>Draw a field</b> by tapping grid corners on your land.</li>
            <li><b>Tap the field.</b> It lists what it needs; tap <b>Plow</b> and a tractor goes.</li>
            <li>Tap it again and <b>plant a crop</b>.</li>
            <li>When it turns golden, <b>harvest</b>. A tractor hauls the grain to the sell point.</li>
            <li>Or tap a machine and <b>Drive</b> it yourself: hired workers cost wages, you don't.</li>
          </ol>
          <p class="note">Each crop has planting seasons and nothing grows in winter. Rain stops the combines, and storms flatten ripe crops left standing. Machines burn fuel (the pump is by the silo) and wear out. Build <b>animal pens</b> from the Shop: they eat grain from your silo and give eggs, milk, wool and piglets.</p>
          <div class="btnrow">
            <button class="primary" data-act="closeModal">Start farming</button>
            <button data-act="landscape">${icon('rotate')}Play in landscape</button>
          </div>
        </div>`;
      case 'fleet':
        return `<div class="card">
          ${head('Fleet', `${sim.vehicles.length} machines`)}
          <div class="ledger">${sim.vehicles.map(v => {
            const c = sim.cargoOf(v);
            return `<button class="lrow" data-act="select" data-arg="${v.id}">
              <span class="lr-ico">${vIco(v)}</span>
              <span class="lr-main"><span class="lr-line"><b>${v.name}</b><i></i></span><small data-live="vstatus:${v.id}"></small>
              ${c ? `<small class="fig" data-live="vcargo:${v.id}"></small>` : ''}</span>${icon('chevron', 'go')}</button>`;
          }).join('')}</div>
          <p class="eyebrow gap">Implements</p>
          <div class="toolbelt">${sim.tools.map(t => `<span title="${cap1(TOOL_NAMES[t.kind])}">${icon(TOOL_ICON[t.kind])}</span>`).join('')}</div>
        </div>`;
      case 'shop': {
        const tabs = `<div class="tabs">
          ${(['vehicles', 'animals', 'upgrades', 'land'] as const).map(t => `<button data-act="shopTab" data-arg="${t}" class="${this.shopTab === t ? 'on' : ''}">${{ vehicles: 'Machines', animals: 'Animals', upgrades: 'Upgrades', land: 'Land' }[t]}</button>`).join('')}
        </div>`;
        let body = '';
        if (this.shopTab === 'vehicles') {
          body = SHOP_ITEMS.map(it => {
            const owned = it.id === 'tractor' || it.id === 'combine' || it.id === 'rootHarvester'
              ? sim.vehicles.filter(v => v.kind === it.id).length
              : sim.tools.filter(t => t.kind === it.id).length;
            return `<div class="lrow static">
              <span class="lr-ico">${icon(SHOP_ICON[it.id])}</span>
              <span class="lr-main"><span class="lr-line"><b>${it.name}</b><i></i><span class="own">owned ${owned}</span></span><small>${it.desc}</small></span>
              <button class="price" data-act="buyItem" data-arg="${it.id}" ${sim.money >= it.cost ? '' : 'disabled'}>${money(it.cost)}</button>
            </div>`;
          }).join('');
        } else if (this.shopTab === 'animals') {
          body = ANIMAL_KINDS.map(k => {
            const d = ANIMAL_DEFS[k];
            const owned = sim.pens.filter(p => p.kind === k).length;
            const pd = PRODUCT_DEFS[d.product];
            return `<div class="lrow static">
              <span class="lr-ico">${icon(ANIMAL_ICON[k])}</span>
              <span class="lr-main"><span class="lr-line"><b>${d.pen}</b><i></i><span class="own">${owned ? `built ${owned}` : `${d.w}×${d.h}`}</span></span>
                <small>${d.start} ${d.plural.toLowerCase()} included (room for ${d.cap}). They eat ${d.diet.slice(0, 3).map(c => CROP_DEFS[c].name.toLowerCase()).join(', ')}… and give ${pd.name.toLowerCase()}.</small></span>
              <button class="price" data-act="placePen" data-arg="${k}" ${sim.money >= d.penCost ? '' : 'disabled'}>${money(d.penCost)}</button>
            </div>`;
          }).join('');
        } else if (this.shopTab === 'upgrades') {
          body = (Object.keys(UPGRADES) as UpgradeId[]).map(id => {
            const u = UPGRADES[id];
            const lvl = sim.upgrades[id];
            const next = u.levels[lvl + 1];
            return `<div class="lrow static">
              <span class="lr-ico">${icon(UPGRADE_ICON[id])}</span>
              <span class="lr-main"><span class="lr-line"><b>${u.name}</b><i></i><span class="own">level ${lvl + 1} of ${u.levels.length}</span></span>
                <small>${u.levels[lvl].label}${next ? ` → ${next.label}` : ' · maxed out'}</small></span>
              ${next ? `<button class="price" data-act="buyUpgrade" data-arg="${id}" ${sim.money >= next.cost ? '' : 'disabled'}>${money(next.cost)}</button>` : ''}
            </div>`;
          }).join('');
        } else {
          const plots = Array.from({ length: 12 }, (_, i) => i).filter(i => !sim.owned.has(i));
          body = plots.length ? plots.map(i => {
            const price = parcelPrice(i);
            const r = parcelRect(i);
            return `<div class="lrow static">
              <span class="lr-ico">${icon('map')}</span>
              <span class="lr-main"><span class="lr-line"><b>Plot ${i + 1}</b><i></i><span class="own">${ha(r.w * r.h)}</span></span><small>Row ${Math.floor(i / 4) + 1}, column ${(i % 4) + 1}</small></span>
              <button class="price" data-act="buyParcel" data-arg="${i}" ${sim.money >= price ? '' : 'disabled'}>${money(price)}</button>
            </div>`;
          }).join('') : '<p class="note">You own all the land.</p>';
        }
        return `<div class="card">${head('Shop', `Balance <span class="fig">${money(sim.money)}</span>`)}${tabs}<div class="ledger">${body}</div></div>`;
      }
      case 'market': {
        if (this.marketCrop) return this.renderCropPrices(this.marketCrop);
        const rows = CROPS.map(c => {
          const hist = sim.priceHistory[c];
          const base = CROP_DEFS[c].basePrice;
          const prev = hist.length > 1 ? hist[hist.length - 2] : hist[hist.length - 1];
          const cur = sim.prices[c];
          const trend = cur > prev ? '<span class="up">▲</span>' : cur < prev ? '<span class="down">▼</span>' : '';
          const tag = cur >= base * 1.15 ? '<span class="stamp-mini green">High</span>' : cur <= base * 0.85 ? '<span class="stamp-mini">Low</span>' : '';
          return `<div class="lrow static tap" data-act="marketCrop" data-arg="${c}" role="button" tabindex="0">
            <span class="lr-ico">${icon(CROP_ICON[c])}</span>
            <span class="lr-main"><span class="lr-line"><b>${CROP_DEFS[c].name}</b>${tag}${sim.priceAlerts.includes(c) ? `<span class="bell" title="Price alert on">${icon('flag')}</span>` : ''}<i></i><span class="fig">${trend}${money(cur)}</span></span>
              <small>In silo <span class="fig" data-live="silo:${c}"></span></small></span>
            ${this.sparkline(hist, base)}
            <button class="mini" data-act="sellSilo" data-arg="${c}" ${sim.silo[c] > 0 ? '' : 'disabled'}>Sell</button>
          </div>`;
        }).join('');
        return `<div class="card">
          ${head('Grain market', 'Prices per 1,000 L')}
          <p class="note">Prices move every day. Tap a crop to see its price history and get told when it sells high.</p>
          <div class="ledger">${rows}</div>
          ${sim.pens.length ? `<p class="eyebrow gap">Farm produce</p><div class="ledger">${PRODUCTS.filter(pr => sim.pens.some(pen => ANIMAL_DEFS[pen.kind].product === pr)).map(pr => {
            const pd = PRODUCT_DEFS[pr];
            const have = sim.pens.filter(pen => ANIMAL_DEFS[pen.kind].product === pr).reduce((a, pen) => a + Math.floor(pen.stored), 0);
            return `<div class="lrow static"><span class="lr-ico">${icon(pd.icon)}</span>
              <span class="lr-main"><span class="lr-line"><b>${pd.name}</b><i></i><span class="fig">${money(sim.productPrices[pr])}</span></span><small>${have.toLocaleString()} ${pd.unit} stored</small></span>
              ${this.sparkline(sim.productHistory[pr], pd.basePrice)}
              <button class="mini" data-act="sellProduct" data-arg="${pr}" ${have > 0 ? '' : 'disabled'}>Sell</button></div>`;
          }).join('')}</div>` : ''}
          <p class="eyebrow gap">Harvests go to</p>
          <div class="tabs">
            <button data-act="deliverTo" data-arg="sell" class="${sim.deliverTo === 'sell' ? 'on' : ''}">Sell point</button>
            <button data-act="deliverTo" data-arg="silo" class="${sim.deliverTo === 'silo' ? 'on' : ''}">Farm silo</button>
          </div>
        </div>`;
      }
      case 'settings':
        return `<div class="card">
          ${head('Settings', `Day ${sim.day}`)}
          <div class="ledger">
            <button class="lrow" data-act="mute"><span class="lr-ico">${icon(sim.muted ? 'mute' : 'sound')}</span><span class="lr-main"><span class="lr-line"><b>Sound</b><i></i><span class="own">${sim.muted ? 'off' : 'on'}</span></span></span></button>
            <div class="lrow static"><span class="lr-ico">${icon('quality')}</span><span class="lr-main"><span class="lr-line"><b>Graphics</b><i></i></span><small>Lower it if the game feels slow. The game reloads.</small></span></div>
          </div>
          ${isSafeMode() ? `<div class="ledger"><button class="lrow" data-act="fullGraphics"><span class="lr-ico">${icon('warn')}</span><span class="lr-main"><span class="lr-line"><b>Simple graphics are on</b><i></i></span><small>Your phone couldn\u2019t run the full effects. Tap to try them again.</small></span></button></div>` : ''}
          <div class="tabs">${(['low', 'medium', 'high'] as Quality[]).map(q => `<button data-act="quality" data-arg="${q}" class="${getQuality() === q ? 'on' : ''}">${cap1(q)}</button>`).join('')}</div>
          <div class="ledger">
            <button class="lrow" data-act="landscape"><span class="lr-ico">${icon('rotate')}</span><span class="lr-main"><span class="lr-line"><b>Play in landscape</b><i></i></span><small>Full screen, turned sideways. Menus open at the side.</small></span></button>
            <button class="lrow" data-act="save"><span class="lr-ico">${icon('save')}</span><span class="lr-main"><span class="lr-line"><b>Save now</b><i></i></span><small>The game also saves by itself.</small></span></button>
            <button class="lrow" data-act="modal" data-arg="welcome"><span class="lr-ico">${icon('help')}</span><span class="lr-main"><span class="lr-line"><b>How to play</b><i></i></span></span></button>
            <button class="lrow danger" data-act="reset"><span class="lr-ico">${icon('trash')}</span><span class="lr-main"><span class="lr-line"><b>New farm</b><i></i></span><small>Erase progress and start over.</small></span></button>
          </div>
          <p class="note fig">${sim.world.fields.size} fields · ${sim.owned.size} plots · ${money(sim.stats.earned)} earned</p>
        </div>`;
      default:
        return '';
    }
  }

  /** One crop's price page: two-week chart, highs and lows, and a price alert. */
  private renderCropPrices(c: CropId) {
    const sim = this.sim;
    const d = CROP_DEFS[c];
    const hist = sim.priceHistory[c];
    const cur = sim.prices[c];
    const base = d.basePrice;
    const high = sim.highPrice(c);
    const hi = Math.max(...hist), lo = Math.min(...hist);
    const avg = hist.reduce((a, b) => a + b, 0) / hist.length;
    const vs = Math.round((cur / base - 1) * 100);
    const alert = sim.priceAlerts.includes(c);
    const verdict = cur >= high ? '<span class="stamp green">Sell now</span>' : cur <= base * 0.85 ? '<span class="stamp red">Hold</span>' : '<span class="stamp brown">Fair</span>';
    // Chart geometry.
    const W = 320, H = 150, L = 38, R = 8, T = 10, B = 22;
    const ymin = Math.min(lo, base * 0.8) * 0.97, ymax = Math.max(hi, high) * 1.03;
    const X = (i: number) => L + (hist.length < 2 ? (W - L - R) : (i / (hist.length - 1)) * (W - L - R));
    const Y = (p: number) => T + (1 - (p - ymin) / (ymax - ymin)) * (H - T - B);
    const pts = hist.map((p, i) => `${X(i).toFixed(1)},${Y(p).toFixed(1)}`).join(' ');
    const area = `${X(0).toFixed(1)},${H - B} ${pts} ${X(hist.length - 1).toFixed(1)},${H - B}`;
    const ticks = [ymin + (ymax - ymin) * 0.1, (ymin + ymax) / 2, ymax - (ymax - ymin) * 0.1]
      .map(p => `<text x="${L - 5}" y="${Y(p) + 3.5}" text-anchor="end">${Math.round(p)}</text><line class="grid" x1="${L}" x2="${W - R}" y1="${Y(p)}" y2="${Y(p)}"/>`).join('');
    const days = hist.map((_, i) => i).filter(i => i === 0 || i === hist.length - 1 || (hist.length > 6 && i === Math.floor((hist.length - 1) / 2)))
      .map(i => `<text x="${X(i)}" y="${H - 6}" text-anchor="${i === 0 ? 'start' : i === hist.length - 1 ? 'end' : 'middle'}">${i === hist.length - 1 ? 'Today' : `${hist.length - 1 - i} d ago`}</text>`).join('');
    const dots = hist.map((p, i) => p >= high ? `<circle class="hot" cx="${X(i)}" cy="${Y(p)}" r="3.2"/>` : '').join('');
    const chart = `<svg class="pchart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${d.name} price over the last ${hist.length} days">
      ${ticks}
      <rect class="band" x="${L}" y="${T}" width="${W - L - R}" height="${Math.max(0, Y(high) - T)}"/>
      <line class="base" x1="${L}" x2="${W - R}" y1="${Y(base)}" y2="${Y(base)}"/>
      <text class="lbl" x="${L + 4}" y="${Y(base) + 12}">usual ${money(base)}</text>
      <text class="lbl hot" x="${W - R - 2}" y="${Math.max(T + 10, Y(high) - 4)}" text-anchor="end">high ${money(high)}+</text>
      <polygon class="area" points="${area}"/>
      <polyline class="line" points="${pts}"/>
      ${dots}
      <circle class="now" cx="${X(hist.length - 1)}" cy="${Y(cur)}" r="4.5"/>
      ${days}
    </svg>`;
    const stat = (label: string, v: string) => `<div><dt>${label}</dt><dd class="fig">${v}</dd></div>`;
    return `<div class="card">
      <header class="sh-head">
        <button class="sq" data-act="marketCrop" data-arg="" aria-label="Back">${icon('back')}</button>
        <span class="sh-ico">${icon(CROP_ICON[c])}</span>
        <div class="sh-title"><small class="eyebrow">Per 1,000 L</small><h3>${d.name} <span class="fig">${money(cur)}</span></h3></div>
        ${verdict}
        <button class="sq" data-act="closeModal" aria-label="Close">${icon('close')}</button>
      </header>
      <p class="note">${vs >= 0 ? `${vs}% above` : `${-vs}% below`} the usual price. ${cur >= high ? 'That\u2019s a high price: a good day to sell.' : `It counts as high at ${money(high)}.`}</p>
      ${chart}
      <dl class="soil">
        ${stat('Today', money(cur))}${stat(`${hist.length}-day high`, money(hi))}${stat('Low', money(lo))}${stat('Average', money(avg))}
      </dl>
      <div class="ledger">
        <button class="lrow ${alert ? 'next' : ''}" data-act="priceAlert" data-arg="${c}"><span class="lr-ico">${icon('flag')}</span>
          <span class="lr-main"><span class="lr-line"><b>Price alert</b><i></i><span class="own">${alert ? 'on' : 'off'}</span></span>
          <small>Get a message the day ${d.name.toLowerCase()} sells for ${money(high)} or more.</small></span></button>
        <div class="lrow static"><span class="lr-ico">${icon('silo')}</span>
          <span class="lr-main"><span class="lr-line"><b>In your silo</b><i></i><span class="fig" data-live="silo:${c}"></span></span>
          <small>Worth ${money((sim.silo[c] / 1000) * cur)} today</small></span>
          <button class="mini" data-act="sellSilo" data-arg="${c}" ${sim.silo[c] > 0 ? '' : 'disabled'}>Sell</button></div>
      </div>
    </div>`;
  }

  private sparkline(hist: number[], base: number) {
    if (hist.length < 2) return '<svg class="spark" viewBox="0 0 60 24"></svg>';
    const lo = Math.min(...hist, base * 0.8), hi = Math.max(...hist, base * 1.2);
    const pts = hist.map((p, i) => `${(i / (hist.length - 1)) * 60},${22 - ((p - lo) / (hi - lo)) * 20}`).join(' ');
    const by = 22 - ((base - lo) / (hi - lo)) * 20;
    return `<svg class="spark" viewBox="0 0 60 24"><line x1="0" x2="60" y1="${by}" y2="${by}" class="base"/><polyline points="${pts}"/></svg>`;
  }

  toast(msg: string, kind = 'info', ico?: string, ms = 3200) {
    const box = $('#toasts');
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.innerHTML = `${icon(ico ?? TOAST_ICON[kind] ?? 'flag')}<span></span>`;
    el.querySelector('span')!.textContent = stripEmoji(msg);
    box.appendChild(el);
    while (box.children.length > 2) box.firstElementChild!.remove();
    setTimeout(() => el.classList.add('out'), ms);
    setTimeout(() => el.remove(), ms + 500);
  }

  showWelcome() { this.openModal('welcome'); }
}
