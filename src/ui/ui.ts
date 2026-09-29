import {
  COMBINE_TANK, CROPS, CROP_DEFS, SHOP_ITEMS, SILO_CAP, SPEEDS, UPGRADES, parcelPrice, type CropId, type UpgradeId,
} from '../game/config';
import type { Pt } from '../game/geometry';
import { GOALS } from '../game/goals';
import type { Game, Op, Vehicle } from '../game/sim';
import { parcelRect } from '../game/world';
import { setMuted, sfx } from '../audio';
import type { TapInfo, ViewControls, ViewHost } from '../render3d/types';

type Panel =
  | { kind: 'home' }
  | { kind: 'vehicle'; id: number }
  | { kind: 'jobs'; vid: number; fid: number }
  | { kind: 'combineTarget'; tid: number; cid: number }
  | { kind: 'field'; fid: number }
  | { kind: 'draw' }
  | { kind: 'parcel'; index: number }
  | { kind: 'silo' };

type Modal = null | 'shop' | 'market' | 'fleet' | 'settings' | 'welcome' | 'confirm';

const $ = (sel: string) => document.querySelector(sel) as HTMLElement;
const money = (n: number) => `$${Math.round(n).toLocaleString()}`;
const liters = (n: number) => `${Math.round(n).toLocaleString()} L`;
const ha = (cells: number) => `${(cells * 0.01).toFixed(2)} ha`;
const vIcon = (v: Vehicle) => (v.kind === 'tractor' ? '🚜' : '🌾');

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
  private draftReason = '';
  private liveT = 0;
  private renderT = 0;
  private panelHtml = '';
  private modalHtml = '';
  private live = new Map<string, () => string>();
  private view!: ViewControls;
  private pending: { msg: string; yes: string; run: () => void } | null = null;

  constructor(private sim: Game, private onSave: () => void, private onReset: () => void) {
    this.buildShell();
    sim.events.on('toast', (msg: string, kind: string) => this.toast(msg, kind));
    sim.events.on('goal', (g: { title: string; reward: number }) => {
      sfx.goal();
      this.toast(`🏆 Goal complete: ${g.title} · +${money(g.reward)}`, 'goal');
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
      <div id="top">
        <div class="chip money"><span id="money"></span></div>
        <div class="chip clock"><span id="clock"></span></div>
        <button class="chip btn" data-act="speed" id="speed"></button>
        <div class="spacer"></div>
        <button class="chip btn icon" data-act="modal" data-arg="settings" aria-label="Settings">⚙️</button>
      </div>
      <div id="goal"></div>
      <div id="zoom">
        <button class="round" data-act="zoom" data-arg="1.25" aria-label="Zoom in">＋</button>
        <button class="round" data-act="zoom" data-arg="0.8" aria-label="Zoom out">－</button>
        <button class="round" data-act="rotate" data-arg="-0.785" aria-label="Rotate left">⟲</button>
        <button class="round" data-act="rotate" data-arg="0.785" aria-label="Rotate right">⟳</button>
        <button class="round" data-act="home" aria-label="Go to farmyard">🏠</button>
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
    this.live.set('money', () => money(this.sim.money));
    this.live.set('clock', () => {
      const t = this.sim.timeOfDay;
      const h = Math.floor(t / 60), m = Math.floor(t % 60);
      const icon = h >= 6 && h < 19 ? '☀️' : '🌙';
      return `${icon} Day ${this.sim.day} · ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    });
    this.live.set('speed', () => `⏩ ${SPEEDS[this.sim.speedIdx]}x`);
  }

  // ---------- SceneHost ----------

  onTap(info: TapInfo) {
    if (this.modal) return;
    if (this.drawMode) { this.addCorner(info.cx, info.cy); return; }
    const selV = this.selectedVehicle != null ? this.sim.vehicle(this.selectedVehicle) : undefined;

    if (info.vehicleId != null) {
      const tapped = this.sim.vehicle(info.vehicleId)!;
      if (selV && selV.kind === 'tractor' && tapped.kind === 'combine') {
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
      this.setPanel({ kind: 'jobs', vid: selV.id, fid: info.fieldId });
      return;
    }
    if (info.silo) { sfx.tap(); this.clearSelection(); this.setPanel({ kind: 'silo' }); return; }
    if (info.elevator) { sfx.tap(); this.openModal('market'); return; }
    if (info.fieldId >= 0) {
      sfx.tap();
      this.selectedVehicle = null;
      this.selectedField = info.fieldId;
      this.setPanel({ kind: 'field', fid: info.fieldId });
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

  // ---------- selection & panels ----------

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
      case 'zoom': this.view.zoomBy(parseFloat(arg)); break;
      case 'rotate': this.view.rotateBy(parseFloat(arg)); break;
      case 'home': this.view.centerOnCells(14, 52); break;
      case 'modal': sfx.tap(); this.openModal(arg as Modal); return;
      case 'closeModal': sfx.tap(); this.modal = null; this.render(true); return;
      case 'shopTab': this.shopTab = arg as typeof this.shopTab; sfx.tap(); break;
      case 'close': sfx.tap(); this.clearSelection(); this.setPanel({ kind: 'home' }); return;
      case 'back': {
        sfx.tap();
        const p = this.panel;
        if (p.kind === 'jobs') { this.selectedField = null; this.setPanel({ kind: 'vehicle', id: p.vid }); return; }
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
      case 'job': {
        const p = this.panel;
        if (p.kind !== 'jobs') return;
        const [op, crop] = arg.split(':') as [Op, CropId | undefined];
        const err = sim.orderFieldOp(p.vid, p.fid, op, crop || undefined);
        if (err) { sfx.error(); this.toast(err, 'bad'); return; }
        sfx.confirm();
        const v = sim.vehicle(p.vid)!;
        this.toast(`${vIcon(v)} ${v.name} is on its way to Field ${p.fid}`, 'info');
        this.selectedField = null;
        this.setPanel({ kind: 'vehicle', id: p.vid });
        return;
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
      case 'assign': {
        const p = this.panel;
        if (p.kind !== 'field') return;
        const id = parseInt(arg, 10);
        this.selectedVehicle = id;
        sfx.tap();
        this.setPanel({ kind: 'jobs', vid: id, fid: p.fid });
        return;
      }
      case 'deleteField': {
        const p = this.panel;
        if (p.kind !== 'field') return;
        this.ask(`Delete Field ${p.fid}? Any crops on it will be lost.`, 'Delete', () => {
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
        this.toast('🎉 New land purchased! Draw a field on it.', 'good');
        if (this.panel.kind === 'parcel') this.setPanel({ kind: 'home' });
        break;
      }
      case 'buyItem': {
        const err = sim.buyItem(arg as never);
        if (err) { sfx.error(); this.toast(err, 'bad'); return; }
        sfx.buy();
        this.toast(`🛒 Bought a new ${SHOP_ITEMS.find(s => s.id === arg)!.name.toLowerCase()} — it's in the farmyard`, 'good');
        break;
      }
      case 'buyUpgrade': {
        const err = sim.buyUpgrade(arg as UpgradeId);
        if (err) { sfx.error(); this.toast(err, 'bad'); return; }
        sfx.buy();
        this.toast(`⬆️ ${UPGRADES[arg as UpgradeId].name} upgraded!`, 'good');
        break;
      }
      case 'sellSilo': {
        const got = sim.sellSilo(arg as CropId);
        if (got > 0) this.toast(`💰 Sold ${CROP_DEFS[arg as CropId].name} for ${money(got)}`, 'good');
        break;
      }
      case 'deliverTo': sim.deliverTo = arg as 'silo' | 'sell'; sfx.tap(); break;
      case 'mute': sim.muted = !sim.muted; setMuted(sim.muted); sfx.tap(); break;
      case 'save': this.onSave(); this.toast('💾 Game saved', 'info'); break;
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
    this.toast(`🌱 Field ${id} created! Tap your tractor, then the field, to plow it.`, 'good');
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
    $('#goal').innerHTML = this.renderGoal();
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
  }

  /** Live values keyed like "vstatus:3", "vcargo:3", "fgrow:2". */
  private dynamicLive(key: string): (() => string) | undefined {
    const [k, idStr] = key.split(':');
    const id = parseInt(idStr, 10);
    const sim = this.sim;
    switch (k) {
      case 'vstatus': return () => sim.vehicle(id)?.status ?? '';
      case 'vcargo': return () => {
        const v = sim.vehicle(id); const c = v && sim.cargoOf(v);
        if (!c) return '';
        return c.cargo.amount > 0 && c.cargo.crop ? `${CROP_DEFS[c.cargo.crop].icon} ${liters(c.cargo.amount)} / ${liters(c.cap)}` : `Empty · ${liters(c.cap)}`;
      };
      case 'vcargobar': return () => {
        const v = sim.vehicle(id); const c = v && sim.cargoOf(v);
        return c ? String((c.cargo.amount / c.cap) * 100) : '0';
      };
      case 'fstate': return () => this.fieldStateText(id);
      case 'fbar': return () => {
        const f = sim.world.fields.get(id);
        if (!f) return '0';
        const s = f.summary(sim.clock);
        return String(s.ready ? 100 : s.growthPct);
      };
      case 'silo': return () => liters(sim.silo[idStr as CropId] ?? 0);
    }
    return undefined;
  }

  private fieldStateText(fid: number) {
    const f = this.sim.world.fields.get(fid);
    if (!f) return '';
    const s = f.summary(this.sim.clock);
    const parts: string[] = [];
    if (s.ready) parts.push(`✅ ${Math.round((s.ready / s.total) * 100)}% ready to harvest`);
    if (s.growing) {
      const crop = CROPS.find(c => s.cropCounts[c] > 0);
      parts.push(`${crop ? CROP_DEFS[crop].icon : '🌱'} Growing ${s.growthPct}%`);
    }
    if (s.plowed) parts.push(`🟫 ${Math.round((s.plowed / s.total) * 100)}% plowed, ready to seed`);
    if (s.grass) parts.push(`🟩 ${Math.round((s.grass / s.total) * 100)}% grass, needs plowing`);
    if (s.stubble) parts.push(`🟨 ${Math.round((s.stubble / s.total) * 100)}% stubble, needs plowing`);
    return parts.join(' · ');
  }

  private renderGoal() {
    const g = GOALS[this.sim.goalIdx];
    if (!g) return `<div class="goal-title">🏆 All goals complete — you're a master farmer!</div>`;
    const [cur, target] = g.progress(this.sim.stats);
    const pct = Math.min(100, (cur / target) * 100);
    return `
      <div class="goal-title">🎯 ${g.title} <span class="reward">+${money(g.reward)}</span></div>
      <div class="bar"><div style="width:${pct}%"></div></div>
      <div class="goal-hint">${g.hint}</div>`;
  }

  private renderPanel(): string {
    const p = this.panel;
    const sim = this.sim;
    switch (p.kind) {
      case 'home':
        return `
          <div class="sheet">
            <div class="hint">Tap a machine to give it a job · drag to move · pinch to zoom</div>
            <div class="actions">
              <button class="big" data-act="draw">✏️<span>New field</span></button>
              <button class="big" data-act="modal" data-arg="fleet">🚜<span>Fleet</span></button>
              <button class="big" data-act="modal" data-arg="shop">🏪<span>Shop</span></button>
              <button class="big" data-act="modal" data-arg="market">📈<span>Market</span></button>
            </div>
          </div>`;
      case 'draw': {
        const n = this.draft.length;
        const msg = n === 0
          ? 'Tap grid corners on your land to outline a field (at least 4). Tap the first corner again to finish.'
          : this.draftValid ? `Looks good: ${this.draftCells.length} cells (${ha(this.draftCells.length)}). Tap the first corner or Create.` : this.draftReason;
        return `
          <div class="sheet">
            <div class="title">✏️ Draw a field <span class="muted">${n} corner${n === 1 ? '' : 's'}</span></div>
            <div class="hint ${n && !this.draftValid ? 'warn' : ''}">${msg}</div>
            <div class="row">
              <button data-act="undo" ${n ? '' : 'disabled'}>↩️ Undo</button>
              <button data-act="cancelDraw">✕ Cancel</button>
              <button class="primary" data-act="createField" ${this.draftValid ? '' : 'disabled'}>✅ Create</button>
            </div>
          </div>`;
      }
      case 'vehicle': {
        const v = sim.vehicle(p.id);
        if (!v) return '';
        const tool = sim.toolOf(v);
        const cargo = sim.cargoOf(v);
        const toolName = tool ? { plow: '⛏️ Plow', seeder: '🌱 Seeder', wagon: '🛒 Grain wagon' }[tool.kind] : 'No tool';
        const hint = v.kind === 'tractor'
          ? 'Tap a field to plow or seed it · tap a combine to haul its grain'
          : 'Tap a field with a ripe crop to harvest it';
        return `
          <div class="sheet">
            <div class="title">${vIcon(v)} ${v.name} ${v.kind === 'tractor' ? `<span class="muted">${toolName}</span>` : ''}
              <button class="x" data-act="close" aria-label="Close">✕</button></div>
            <div class="status" data-live="vstatus:${v.id}"></div>
            ${cargo ? `<div class="cargo"><div class="bar"><div data-live="vcargobar:${v.id}" data-bar></div></div><span data-live="vcargo:${v.id}"></span></div>` : ''}
            <div class="hint">👉 ${hint}</div>
            <div class="row">
              <button data-act="follow" class="${this.follow ? 'on' : ''}">🎯 Follow</button>
              <button data-act="park">🏠 Park</button>
              ${cargo ? `<button data-act="deliver">⬇️ ${sim.deliverTo === 'sell' ? 'Sell' : 'To silo'}</button>` : ''}
              ${v.kind === 'tractor' && tool ? '<button data-act="unhitch">🔗 Unhitch</button>' : ''}
              ${v.kind === 'combine' ? `<button data-act="autoUnload" class="${v.autoUnload ? 'on' : ''}">🚜 Auto-haul ${v.autoUnload ? 'ON' : 'OFF'}</button>` : ''}
            </div>
          </div>`;
      }
      case 'jobs': {
        const v = sim.vehicle(p.vid);
        const f = sim.world.fields.get(p.fid);
        if (!v || !f) return '';
        const opts: string[] = [];
        const btn = (op: Op, label: string, crop?: CropId) => {
          const c = sim.checkFieldOp(v, f, op, crop);
          const sub = c.ok
            ? op === 'seed' && crop ? `${ha(c.cells)} · ~${money(c.cells * CROP_DEFS[crop].seedCostPerCell)} seed`
              : op === 'harvest' && c.crop ? `${CROP_DEFS[c.crop].name} · ${ha(c.cells)}` : ha(c.cells)
            : c.reason;
          return `<button class="job ${c.ok ? '' : 'off'}" data-act="job" data-arg="${op}:${crop ?? ''}" ${c.ok ? '' : 'disabled'}>
            <b>${label}</b><small>${sub}</small></button>`;
        };
        let seeds = '';
        if (v.kind === 'tractor') {
          opts.push(btn('plow', '⛏️ Plow'));
          const general = sim.checkFieldOp(v, f, 'seed');
          const crops = CROPS.map(c => {
            const d = CROP_DEFS[c];
            const ok = general.ok && sim.checkFieldOp(v, f, 'seed', c).ok;
            return `<button class="crop" data-act="job" data-arg="seed:${c}" ${ok ? '' : 'disabled'}>
              <span class="ico">${d.icon}</span><b>${d.name}</b>
              <small>${d.growDays} days · ${money(sim.prices[c])}</small></button>`;
          }).join('');
          seeds = `<div class="hint">🌱 Seed ${general.ok ? `${ha(general.cells)} — pick a crop (grow time · price per 1000 L):` : `— ${general.reason}`}</div>
            <div class="crops">${crops}</div>`;
        } else {
          opts.push(btn('harvest', '🌾 Harvest'));
        }
        return `
          <div class="sheet">
            <div class="title"><button class="x left" data-act="back" aria-label="Back">‹</button>
              ${vIcon(v)} ${v.name} → Field ${f.id} <span class="muted">${ha(f.cells.length)}</span></div>
            <div class="status" data-live="fstate:${f.id}"></div>
            <div class="jobs">${opts.join('')}</div>
            ${seeds}
          </div>`;
      }
      case 'combineTarget': {
        const t = sim.vehicle(p.tid), c = sim.vehicle(p.cid);
        if (!t || !c) return '';
        return `
          <div class="sheet">
            <div class="title"><button class="x left" data-act="back" aria-label="Back">‹</button>🚜 ${t.name} → ${c.name}</div>
            <div class="status">${c.tank.amount > 0 && c.tank.crop ? `Tank: ${CROP_DEFS[c.tank.crop].icon} ${liters(c.tank.amount)} / ${liters(COMBINE_TANK[sim.upgrades.header])}` : 'Tank is empty (the tractor will wait beside it)'}</div>
            <div class="jobs">
              <button class="job" data-act="unloadCombine"><b>🛒 Haul grain</b><small>Hitch the wagon, follow the combine, then ${sim.deliverTo === 'sell' ? 'sell' : 'store in the silo'}</small></button>
              <button class="job" data-act="selectCombine"><b>🌾 Select ${c.name}</b><small>Give the combine orders instead</small></button>
            </div>
          </div>`;
      }
      case 'field': {
        const f = sim.world.fields.get(p.fid);
        if (!f) return '';
        const machines = sim.vehicles.map(v =>
          `<button data-act="assign" data-arg="${v.id}">${vIcon(v)} ${v.name}</button>`).join('');
        return `
          <div class="sheet">
            <div class="title">🟩 Field ${f.id} <span class="muted">${ha(f.cells.length)}</span>
              <button class="x" data-act="close" aria-label="Close">✕</button></div>
            <div class="status" data-live="fstate:${f.id}"></div>
            <div class="bar grow"><div data-live="fbar:${f.id}" data-bar></div></div>
            <div class="hint">Send a machine to this field:</div>
            <div class="row wrap">${machines}</div>
            <div class="row"><button class="danger" data-act="deleteField">🗑️ Delete field</button></div>
          </div>`;
      }
      case 'parcel': {
        const price = parcelPrice(p.index);
        const r = parcelRect(p.index);
        const afford = sim.money >= price;
        return `
          <div class="sheet">
            <div class="title">🔒 Land for sale <button class="x" data-act="close" aria-label="Close">✕</button></div>
            <div class="status">${r.w} × ${r.h} plot (${ha(r.w * r.h)}) · <b>${money(price)}</b></div>
            <div class="row">
              <button data-act="close">Not now</button>
              <button class="primary" data-act="buyParcel" data-arg="${p.index}" ${afford ? '' : 'disabled'}>${afford ? `Buy for ${money(price)}` : `Need ${money(price - sim.money)} more`}</button>
            </div>
          </div>`;
      }
      case 'silo':
        return `
          <div class="sheet">
            <div class="title">🏚️ Farm silo <span class="muted">${liters(SILO_CAP)} per crop</span>
              <button class="x" data-act="close" aria-label="Close">✕</button></div>
            <div class="silo">${CROPS.map(c => `
              <div class="silo-row">
                <span>${CROP_DEFS[c].icon} ${CROP_DEFS[c].name}</span>
                <span data-live="silo:${c}"></span>
                <span class="muted">${money(sim.prices[c])}/1000 L</span>
                <button data-act="sellSilo" data-arg="${c}" ${sim.silo[c] > 0 ? '' : 'disabled'}>Sell</button>
              </div>`).join('')}</div>
            <div class="row"><button data-act="modal" data-arg="market">📈 Open market</button></div>
          </div>`;
    }
  }

  private renderModal(): string {
    const sim = this.sim;
    const head = (title: string) => `<div class="mhead"><h2>${title}</h2><button class="x" data-act="closeModal" aria-label="Close">✕</button></div>`;
    switch (this.modal) {
      case 'confirm':
        return `<div class="card small-card">
          <p>${this.pending?.msg ?? ''}</p>
          <div class="row">
            <button data-act="closeModal">Cancel</button>
            <button class="primary danger-fill" data-act="confirmYes">${this.pending?.yes ?? 'OK'}</button>
          </div>
        </div>`;
      case 'welcome':
        return `<div class="card">
          ${head('🌾 Welcome to your farm!')}
          <p>You own a plot of land, a tractor, a combine, and a few tools. Build a farming business:</p>
          <ol class="steps">
            <li><b>✏️ Draw a field</b> by tapping corners on the grid.</li>
            <li><b>🚜 Tap the tractor</b>, then tap the field, and choose <b>Plow</b>.</li>
            <li>Send it back to <b>seed</b> wheat, corn or soybeans.</li>
            <li>When the crop turns golden, <b>tap the combine</b> and harvest.</li>
            <li>Your tractor hauls the grain to the <b>sell point</b> automatically. 💰</li>
          </ol>
          <p class="muted">Machines drive themselves. Crops keep growing (slower) while you're away.</p>
          <button class="primary wide" data-act="closeModal">Let's farm!</button>
        </div>`;
      case 'fleet':
        return `<div class="card">
          ${head('🚜 Fleet')}
          <div class="list">${sim.vehicles.map(v => {
            const c = sim.cargoOf(v);
            return `<button class="item" data-act="select" data-arg="${v.id}">
              <span class="big-ico">${vIcon(v)}</span>
              <span class="grow"><b>${v.name}</b><small data-live="vstatus:${v.id}"></small>
              ${c ? `<small data-live="vcargo:${v.id}"></small>` : ''}</span><span>›</span></button>`;
          }).join('')}</div>
          <div class="muted small">Tools: ${sim.tools.map(t => ({ plow: '⛏️', seeder: '🌱', wagon: '🛒' }[t.kind])).join(' ')}</div>
        </div>`;
      case 'shop': {
        const tabs = `<div class="tabs">
          ${(['vehicles', 'upgrades', 'land'] as const).map(t => `<button data-act="shopTab" data-arg="${t}" class="${this.shopTab === t ? 'on' : ''}">${{ vehicles: '🚜 Machines', upgrades: '⬆️ Upgrades', land: '🗺️ Land' }[t]}</button>`).join('')}
        </div>`;
        let body = '';
        if (this.shopTab === 'vehicles') {
          body = SHOP_ITEMS.map(it => {
            const owned = it.id === 'tractor' || it.id === 'combine'
              ? sim.vehicles.filter(v => v.kind === it.id).length
              : sim.tools.filter(t => t.kind === it.id).length;
            return `<div class="item">
              <span class="big-ico">${it.icon}</span>
              <span class="grow"><b>${it.name}</b> <span class="muted">owned: ${owned}</span><small>${it.desc}</small></span>
              <button class="primary" data-act="buyItem" data-arg="${it.id}" ${sim.money >= it.cost ? '' : 'disabled'}>${money(it.cost)}</button>
            </div>`;
          }).join('');
        } else if (this.shopTab === 'upgrades') {
          body = (Object.keys(UPGRADES) as UpgradeId[]).map(id => {
            const u = UPGRADES[id];
            const lvl = sim.upgrades[id];
            const next = u.levels[lvl + 1];
            return `<div class="item">
              <span class="big-ico">${u.icon}</span>
              <span class="grow"><b>${u.name}</b> <span class="muted">Lv ${lvl + 1}/${u.levels.length}</span>
                <small>Now: ${u.levels[lvl].label}${next ? ` → Next: ${next.label}` : ''}</small></span>
              ${next ? `<button class="primary" data-act="buyUpgrade" data-arg="${id}" ${sim.money >= next.cost ? '' : 'disabled'}>${money(next.cost)}</button>` : '<span class="muted">MAX</span>'}
            </div>`;
          }).join('');
        } else {
          const plots = Array.from({ length: 12 }, (_, i) => i).filter(i => !sim.owned.has(i));
          body = plots.length ? plots.map(i => {
            const price = parcelPrice(i);
            const r = parcelRect(i);
            return `<div class="item">
              <span class="big-ico">🗺️</span>
              <span class="grow"><b>Plot ${i + 1}</b><small>${ha(r.w * r.h)} · row ${Math.floor(i / 4) + 1}, column ${(i % 4) + 1}</small></span>
              <button class="primary" data-act="buyParcel" data-arg="${i}" ${sim.money >= price ? '' : 'disabled'}>${money(price)}</button>
            </div>`;
          }).join('') : '<p>You own all the land! 🎉</p>';
        }
        return `<div class="card">${head('🏪 Shop')}<div class="muted">Balance: <b>${money(sim.money)}</b></div>${tabs}<div class="list">${body}</div></div>`;
      }
      case 'market': {
        const rows = CROPS.map(c => {
          const hist = sim.priceHistory[c];
          const base = CROP_DEFS[c].basePrice;
          const prev = hist.length > 1 ? hist[hist.length - 2] : hist[hist.length - 1];
          const cur = sim.prices[c];
          const trend = cur > prev ? '<span class="up">▲</span>' : cur < prev ? '<span class="down">▼</span>' : '<span class="muted">■</span>';
          const quality = cur >= base * 1.15 ? '<span class="tag good">Great price</span>' : cur <= base * 0.85 ? '<span class="tag bad">Low</span>' : '';
          return `<div class="item">
            <span class="big-ico">${CROP_DEFS[c].icon}</span>
            <span class="grow"><b>${CROP_DEFS[c].name}</b> ${quality}<small>Silo: <span data-live="silo:${c}"></span></small></span>
            ${this.sparkline(hist, base)}
            <span class="price">${trend} ${money(cur)}<small>/1000 L</small></span>
            <button data-act="sellSilo" data-arg="${c}" ${sim.silo[c] > 0 ? '' : 'disabled'}>Sell</button>
          </div>`;
        }).join('');
        return `<div class="card">
          ${head('📈 Grain market')}
          <div class="muted small">Prices change every in-game day. Store grain in the silo and sell when prices peak.</div>
          <div class="list">${rows}</div>
          <div class="hint">Harvested grain goes to:</div>
          <div class="tabs">
            <button data-act="deliverTo" data-arg="sell" class="${sim.deliverTo === 'sell' ? 'on' : ''}">💰 Sell point</button>
            <button data-act="deliverTo" data-arg="silo" class="${sim.deliverTo === 'silo' ? 'on' : ''}">🏚️ Farm silo</button>
          </div>
        </div>`;
      }
      case 'settings':
        return `<div class="card">
          ${head('⚙️ Settings')}
          <div class="list">
            <button class="item" data-act="mute"><span class="big-ico">${sim.muted ? '🔇' : '🔊'}</span><span class="grow"><b>Sound</b><small>${sim.muted ? 'Off' : 'On'}</small></span></button>
            <button class="item" data-act="save"><span class="big-ico">💾</span><span class="grow"><b>Save now</b><small>The game also saves automatically</small></span></button>
            <button class="item" data-act="modal" data-arg="welcome"><span class="big-ico">❓</span><span class="grow"><b>How to play</b></span></button>
            <button class="item danger" data-act="reset"><span class="big-ico">🗑️</span><span class="grow"><b>New farm</b><small>Erase progress and start over</small></span></button>
          </div>
          <div class="muted small">Day ${sim.day} · ${sim.world.fields.size} fields · ${sim.owned.size} plots · earned ${money(sim.stats.earned)} total</div>
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

  toast(msg: string, kind = 'info') {
    const box = $('#toasts');
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = msg;
    box.appendChild(el);
    while (box.children.length > 2) box.firstElementChild!.remove();
    setTimeout(() => el.classList.add('out'), 3200);
    setTimeout(() => el.remove(), 3700);
  }

  showWelcome() { this.openModal('welcome'); }
}
