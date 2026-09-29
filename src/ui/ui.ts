import {
  CROPS, CROP_DEFS, OP_DEFS, SHOP_ITEMS, SILO_CAP, SPEEDS, UPGRADES, WEATHER_DEFS, parcelPrice,
  type CropId, type UpgradeId,
} from '../game/config';
import type { Field } from '../game/field';
import type { Pt } from '../game/geometry';
import { GOALS } from '../game/goals';
import { TOOL_NAMES, VEHICLE_NAMES, isHarvester, type Game, type Need, type Op, type Vehicle } from '../game/sim';
import { parcelRect } from '../game/world';
import { setMuted, sfx } from '../audio';
import { getQuality, setQuality, type Quality } from '../render3d/quality';
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
  | { kind: 'silo' };

type Modal = null | 'shop' | 'market' | 'fleet' | 'settings' | 'welcome' | 'confirm';

const $ = (sel: string) => document.querySelector(sel) as HTMLElement;
const money = (n: number) => `$${Math.round(n).toLocaleString()}`;
const liters = (n: number) => `${Math.round(n).toLocaleString()} L`;
const ha = (cells: number) => `${(cells * 0.01).toFixed(2)} ha`;
const vIco = (v: Vehicle) => icon(VEHICLE_ICON[v.kind]);
const cap1 = (t: string) => t[0].toUpperCase() + t.slice(1);
const pad2 = (n: number) => String(n).padStart(2, '0');

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
  private shopTab: 'vehicles' | 'upgrades' | 'land' = 'vehicles';
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
    setMuted(sim.muted);
  }

  attach(view: ViewControls) { this.view = view; }

  // ---------- shell ----------

  private buildShell() {
    document.getElementById('ui')!.innerHTML = `
      <header id="top">
        <div class="strip">
          <span class="cell money">${icon('coin')}<span id="money" class="fig"></span></span>
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
      <div id="panel"></div>
      <div id="modal" class="hidden"></div>`;
    const root = document.getElementById('ui')!;
    root.addEventListener('click', e => {
      const el = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
      if (!el || el.hasAttribute('disabled')) return;
      this.act(el.dataset.act!, el.dataset.arg ?? '');
    });
    this.live.set('money', () => money(this.sim.money).slice(1));
    this.live.set('clock', () => {
      const t = this.sim.timeOfDay;
      return `Day ${this.sim.day} · ${pad2(Math.floor(t / 60))}:${pad2(Math.floor(t % 60))}`;
    });
    this.live.set('speed', () => `${SPEEDS[this.sim.speedIdx]}×`);
  }

  // ---------- ViewHost ----------

  onTap(info: TapInfo) {
    if (this.modal) return;
    if (this.drawMode) { this.addCorner(info.cx, info.cy); return; }
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
    if (info.elevator) { sfx.tap(); this.openModal('market'); return; }
    if (info.fieldId >= 0) {
      sfx.tap();
      this.selectedVehicle = null;
      this.selectedField = info.fieldId;
      this.setPanel({ kind: 'field', fid: info.fieldId, view: 'todo' });
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

  frame(dt: number) {
    this.liveT += dt;
    this.renderT += dt;
    if (this.renderT > 0.4) { this.renderT = 0; this.render(); }
    if (this.liveT > 0.15) { this.liveT = 0; this.updateLive(); }
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
        const now = WEATHER_DEFS[sim.weather], next = WEATHER_DEFS[sim.weatherNext];
        this.toast(`${now.name} now. ${next.name} in about ${hours} h.`, 'info', WEATHER_ICON[sim.weatherNext]);
        sfx.tap();
        return;
      }
      case 'home': this.view.centerOnCells(14, 52); break;
      case 'modal': sfx.tap(); this.openModal(arg as Modal); return;
      case 'closeModal': sfx.tap(); this.modal = null; this.render(true); return;
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
        if (p.kind === 'field') this.startJob(p.fid, 'seed', arg as CropId, p.vid);
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
      case 'deliverTo': sim.deliverTo = arg as 'silo' | 'sell'; sfx.tap(); break;
      case 'quality':
        if (arg === getQuality()) return;
        setQuality(arg as Quality);
        this.onSave();
        location.reload();
        return;
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
    const panelHtml = this.renderPanel();
    if (force || panelHtml !== this.panelHtml) {
      if (panelHtml !== this.panelHtml) $('#panel').innerHTML = panelHtml;
      this.panelHtml = panelHtml;
    }
    const modalHtml = this.modal ? this.renderModal() : '';
    if (modalHtml !== this.modalHtml) {
      const m = $('#modal');
      m.innerHTML = modalHtml;
      m.classList.toggle('hidden', !this.modal);
      this.modalHtml = modalHtml;
    }
    const goalHtml = this.renderGoal();
    if (goalHtml !== this.goalHtml) { $('#goal').innerHTML = goalHtml; this.goalHtml = goalHtml; }
    $('#goal').classList.toggle('open', this.goalOpen);
    this.updateLive();
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
    const wx = this.sim.weather === 'sun' && (h < 6 || h >= 19) ? 'moon' : WEATHER_ICON[this.sim.weather];
    if (wx !== this.wxKey) { this.wxKey = wx; $('#wx').innerHTML = icon(wx); }
  }

  /** Live values keyed like "vstatus:3". */
  private dynamicLive(key: string): (() => string) | undefined {
    const [k, idStr] = key.split(':');
    const id = parseInt(idStr, 10);
    const sim = this.sim;
    const summary = () => sim.world.fields.get(id)?.summary(sim.clock);
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
    }
    return undefined;
  }

  private fieldStateText(fid: number) {
    const f = this.sim.world.fields.get(fid);
    if (!f) return '';
    const s = f.summary(this.sim.clock);
    const pct = (n: number) => `${Math.round((n / s.total) * 100)}%`;
    const crop = CROPS.find(c => s.cropCounts[c] > 0);
    const parts: string[] = [];
    if (crop) parts.push(CROP_DEFS[crop].name);
    if (s.ready) parts.push(`${pct(s.ready)} ripe`);
    if (s.growing) parts.push(`growing, ${s.growthPct}% of the way`);
    if (s.plowed) parts.push(`${pct(s.plowed)} plowed, ready to plant`);
    if (s.grass) parts.push(`${pct(s.grass)} grass`);
    if (s.stubble) parts.push(`${pct(s.stubble)} stubble`);
    return parts.join(' · ');
  }

  /** A rubber-stamp word for the field's main state. */
  private fieldStamp(f: Field) {
    const s = f.summary(this.sim.clock);
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

  private needRow(f: Field, n: Need, vid: number | undefined, next: boolean) {
    const sim = this.sim;
    const d = OP_DEFS[n.op];
    const title = n.op === 'seed' ? 'Plant a crop' : d.name;
    let side = '';
    let who = '';
    let action = `data-act="need" data-arg="${n.op}"`;
    if (n.op === 'seed') {
      who = 'Choose a crop';
    } else {
      const v = vid != null ? sim.vehicle(vid) : undefined;
      const check = v ? sim.checkFieldOp(v, f, n.op) : undefined;
      const pick = v ? (check!.ok ? { vehicle: v } : { reason: check!.reason }) : sim.bestVehicleFor(f, n.op);
      if (d.costPerCell) side = `<span class="fig">${money(sim.eligibleCount(f, n.op) * d.costPerCell)}</span>`;
      if (pick.vehicle) {
        who = `${pick.vehicle.name} will go`;
      } else if ('buy' in pick && pick.buy) {
        const item = SHOP_ITEMS.find(i => i.id === pick.buy)!;
        action = `data-act="buyFor" data-arg="${item.id}"`;
        who = `<span class="warn">Buy a ${item.name.toLowerCase()} first</span>`;
        side = `<span class="fig">${money(item.cost)}</span>`;
      } else {
        action = 'disabled';
        who = `<span class="warn">${pick.reason}</span>`;
      }
    }
    return `<button class="lrow ${next ? 'next' : ''}" ${action}>
      <span class="lr-ico">${icon(OP_ICON[n.op])}</span>
      <span class="lr-main"><span class="lr-line"><b>${title}</b><i></i>${side}</span>
        <small>${n.why}</small><small class="who">${who}</small></span>
      ${next ? '<span class="stamp-mini">Next</span>' : icon('chevron', 'go')}</button>`;
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
        return `<button class="packet" data-act="plant" data-arg="${c}" ${noPlanter ? 'disabled' : ''}>
          ${icon(CROP_ICON[c], 'packet-ico')}<b>${d.name}</b>
          <span class="pk-row"><span>Grows</span><span class="fig">${d.growDays} d</span></span>
          <span class="pk-row"><span>Sells</span><span class="fig">${money(sim.prices[c])}</span></span>
          <span class="pk-row"><span>Seed</span><span class="fig">${noPlanter ? '—' : money(cells * d.seedCostPerCell)}</span></span>
          ${noPlanter ? '<small class="warn">Needs root planter</small>' : ''}</button>`;
      }).join('');
      return `<section class="sheet">${head}<p class="note">Pick a crop. Prices are per 1,000 L.</p><div class="packets">${crops}</div></section>`;
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
      case 'welcome':
        return `<div class="card">
          ${head('Harvest Valley', 'Your farm')}
          <p class="lead">You own a plot of land, a tractor, a combine and a few implements. Here's how a season works:</p>
          <ol class="steps">
            <li><b>Draw a field</b> by tapping grid corners on your land.</li>
            <li><b>Tap the field.</b> It lists what it needs; tap <b>Plow</b> and a tractor goes.</li>
            <li>Tap it again and <b>plant a crop</b>.</li>
            <li>When it turns golden, <b>harvest</b>. A tractor hauls the grain to the sell point.</li>
          </ol>
          <p class="note">For bigger harvests: fertilize twice, lime the soil every few harvests, roll after planting and keep weeds out. Crops keep growing, more slowly, while you're away.</p>
          <button class="primary wide" data-act="closeModal">Start farming</button>
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
          ${(['vehicles', 'upgrades', 'land'] as const).map(t => `<button data-act="shopTab" data-arg="${t}" class="${this.shopTab === t ? 'on' : ''}">${{ vehicles: 'Machines', upgrades: 'Upgrades', land: 'Land' }[t]}</button>`).join('')}
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
        const rows = CROPS.map(c => {
          const hist = sim.priceHistory[c];
          const base = CROP_DEFS[c].basePrice;
          const prev = hist.length > 1 ? hist[hist.length - 2] : hist[hist.length - 1];
          const cur = sim.prices[c];
          const trend = cur > prev ? '<span class="up">▲</span>' : cur < prev ? '<span class="down">▼</span>' : '';
          const tag = cur >= base * 1.15 ? '<span class="stamp-mini green">High</span>' : cur <= base * 0.85 ? '<span class="stamp-mini">Low</span>' : '';
          return `<div class="lrow static">
            <span class="lr-ico">${icon(CROP_ICON[c])}</span>
            <span class="lr-main"><span class="lr-line"><b>${CROP_DEFS[c].name}</b>${tag}<i></i><span class="fig">${trend}${money(cur)}</span></span>
              <small>In silo <span class="fig" data-live="silo:${c}"></span></small></span>
            ${this.sparkline(hist, base)}
            <button class="mini" data-act="sellSilo" data-arg="${c}" ${sim.silo[c] > 0 ? '' : 'disabled'}>Sell</button>
          </div>`;
        }).join('');
        return `<div class="card">
          ${head('Grain market', 'Prices per 1,000 L')}
          <p class="note">Prices move every day. Keep grain in the silo and sell when a price is high.</p>
          <div class="ledger">${rows}</div>
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
          <div class="tabs">${(['low', 'medium', 'high'] as Quality[]).map(q => `<button data-act="quality" data-arg="${q}" class="${getQuality() === q ? 'on' : ''}">${cap1(q)}</button>`).join('')}</div>
          <div class="ledger">
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

  private sparkline(hist: number[], base: number) {
    if (hist.length < 2) return '<svg class="spark" viewBox="0 0 60 24"></svg>';
    const lo = Math.min(...hist, base * 0.8), hi = Math.max(...hist, base * 1.2);
    const pts = hist.map((p, i) => `${(i / (hist.length - 1)) * 60},${22 - ((p - lo) / (hi - lo)) * 20}`).join(' ');
    const by = 22 - ((base - lo) / (hi - lo)) * 20;
    return `<svg class="spark" viewBox="0 0 60 24"><line x1="0" x2="60" y1="${by}" y2="${by}" class="base"/><polyline points="${pts}"/></svg>`;
  }

  toast(msg: string, kind = 'info', ico?: string) {
    const box = $('#toasts');
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.innerHTML = `${icon(ico ?? TOAST_ICON[kind] ?? 'flag')}<span></span>`;
    el.querySelector('span')!.textContent = stripEmoji(msg);
    box.appendChild(el);
    while (box.children.length > 2) box.firstElementChild!.remove();
    setTimeout(() => el.classList.add('out'), 3200);
    setTimeout(() => el.remove(), 3700);
  }

  showWelcome() { this.openModal('welcome'); }
}
