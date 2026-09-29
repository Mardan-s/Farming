import './style.css';
import { unlockAudio } from './audio';
import { SAVE_KEY } from './game/config';
import { Game, type OfflineReport } from './game/sim';
import { View3D } from './render3d/View3D';
import { UI } from './ui/ui';

function readSave() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

const saved = readSave();
let sim = new Game();
let offline: OfflineReport | null = null;
if (saved) {
  try {
    const res = Game.load(saved);
    sim = res.game;
    offline = res.offline;
  } catch (e) {
    console.error('Could not load save, starting fresh', e);
  }
}

let resetting = false;
function save() {
  if (resetting) return;
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(sim.save())); } catch { /* storage unavailable */ }
}
function reset() {
  resetting = true;
  try { localStorage.removeItem(SAVE_KEY); } catch { /* storage unavailable */ }
  location.reload();
}

const ui = new UI(sim, save, reset);
const view = new View3D(document.getElementById('game')!, sim, ui);

window.addEventListener('pointerdown', unlockAudio, { capture: true });
window.addEventListener('contextmenu', e => e.preventDefault());
document.addEventListener('visibilitychange', () => { if (document.hidden) save(); });
window.addEventListener('pagehide', save);
setInterval(save, 15000);

if (!saved) {
  ui.showWelcome();
} else if (offline && offline.minutes >= 60) {
  const hours = Math.round(offline.minutes / 60);
  setTimeout(() => ui.toast(`🌙 Welcome back! ${hours} farm hour${hours === 1 ? '' : 's'} passed while you were away — your crops kept growing.`, 'good'), 600);
}

// Handy for debugging from the console and browser tests.
(window as unknown as { farm: unknown }).farm = { sim, view };
