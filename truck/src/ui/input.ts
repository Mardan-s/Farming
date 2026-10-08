import { clamp, damp } from '../util';

// Touch, tilt and keyboard input merged into one set of driving controls.

export type SteerMode = 'wheel' | 'tilt' | 'buttons';

const WHEEL_LOCK = 140; // degrees of on-screen wheel rotation for full lock

export class Input {
  steer = 0;
  throttle = 0;
  brake = 0;
  handbrake = false;
  mode: SteerMode = 'wheel';
  /** Rotation of the on-screen wheel, degrees. */
  wheelDeg = 0;
  private wheelHeld = false;
  private wheelLast = 0;
  private gasHeld = false;
  private brakeHeld = false;
  private leftHeld = false;
  private rightHeld = false;
  private keys = new Set<string>();
  private tilt = 0;
  private tiltZero: number | null = null;
  private tiltBound = false;
  onAction: (a: string) => void = () => {};

  constructor() {
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      const k = e.key.toLowerCase();
      this.keys.add(k);
      const map: Record<string, string> = { c: 'cam', l: 'lights', h: 'horn-down', r: 'reverse', n: 'neutral', f: 'drive', k: 'cruise', q: 'indL', e: 'indR', x: 'hazard', escape: 'menu', enter: 'action', j: 'jobs', b: 'roof' };
      if (map[k]) this.onAction(map[k]);
      if (k.startsWith('arrow') || k === ' ') e.preventDefault();
    });
    window.addEventListener('keyup', (e) => {
      const k = e.key.toLowerCase();
      this.keys.delete(k);
      if (k === 'h') this.onAction('horn-up');
    });
    window.addEventListener('blur', () => this.keys.clear());
  }

  bindWheel(el: HTMLElement, rim: HTMLElement) {
    const center = () => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
    const ang = (e: PointerEvent) => { const c = center(); return (Math.atan2(e.clientY - c.y, e.clientX - c.x) * 180) / Math.PI; };
    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture(e.pointerId);
      this.wheelHeld = true;
      this.wheelLast = ang(e);
    });
    el.addEventListener('pointermove', (e) => {
      if (!this.wheelHeld) return;
      const a = ang(e);
      let d = a - this.wheelLast;
      if (d > 180) d -= 360;
      if (d < -180) d += 360;
      this.wheelLast = a;
      this.wheelDeg = clamp(this.wheelDeg + d, -WHEEL_LOCK, WHEEL_LOCK);
    });
    const up = () => { this.wheelHeld = false; };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    this.rim = rim;
  }
  private rim: HTMLElement | null = null;

  bindPedal(el: HTMLElement, which: 'gas' | 'brake') {
    const set = (v: boolean) => {
      if (which === 'gas') this.gasHeld = v; else this.brakeHeld = v;
      el.classList.toggle('down', v);
    };
    el.addEventListener('pointerdown', (e) => { el.setPointerCapture(e.pointerId); set(true); });
    el.addEventListener('pointerup', () => set(false));
    el.addEventListener('pointercancel', () => set(false));
  }

  bindArrow(el: HTMLElement, side: -1 | 1) {
    const set = (v: boolean) => { if (side < 0) this.leftHeld = v; else this.rightHeld = v; el.classList.toggle('down', v); };
    el.addEventListener('pointerdown', (e) => { el.setPointerCapture(e.pointerId); set(true); });
    el.addEventListener('pointerup', () => set(false));
    el.addEventListener('pointercancel', () => set(false));
  }

  /** Tilt steering needs permission on iOS, which must be asked from a tap. */
  async enableTilt() {
    const DOE = (window as unknown as { DeviceOrientationEvent?: { requestPermission?: () => Promise<string> } }).DeviceOrientationEvent;
    if (DOE?.requestPermission) {
      try { if ((await DOE.requestPermission()) !== 'granted') return false; } catch { return false; }
    }
    if (!this.tiltBound) {
      this.tiltBound = true;
      window.addEventListener('deviceorientation', (e) => {
        const angle = (screen.orientation?.angle ?? (window as unknown as { orientation?: number }).orientation ?? 0) as number;
        let v = 0;
        if (angle === 90) v = e.beta ?? 0;
        else if (angle === 270 || angle === -90) v = -(e.beta ?? 0);
        else v = e.gamma ?? 0;
        if (this.tiltZero == null) this.tiltZero = v;
        this.tilt = v - this.tiltZero;
      });
    }
    this.tiltZero = null;
    return true;
  }

  recenterTilt() { this.tiltZero = null; }

  update(dt: number) {
    const k = this.keys;
    const kLeft = k.has('a') || k.has('arrowleft'), kRight = k.has('d') || k.has('arrowright');
    const kGas = k.has('w') || k.has('arrowup'), kBrake = k.has('s') || k.has('arrowdown');
    this.handbrake = k.has(' ');
    // Steering sources: keyboard and buttons ramp, the wheel springs back when let go, tilt is direct.
    let target: number | null = null;
    if (kLeft || kRight || this.leftHeld || this.rightHeld) {
      target = (kRight || this.rightHeld ? 1 : 0) - (kLeft || this.leftHeld ? 1 : 0);
      this.steer = damp(this.steer, target, target === 0 ? 8 : 3.2, dt);
    } else if (this.mode === 'tilt' && this.tiltBound) {
      this.steer = damp(this.steer, clamp(this.tilt / 28, -1, 1), 12, dt);
    } else {
      if (!this.wheelHeld) this.wheelDeg = damp(this.wheelDeg, 0, 5, dt);
      this.steer = this.wheelDeg / WHEEL_LOCK;
    }
    if (this.mode !== 'wheel' || target != null) this.wheelDeg = this.steer * WHEEL_LOCK;
    if (this.rim) this.rim.style.transform = `rotate(${this.wheelDeg}deg)`;
    const gas = kGas || this.gasHeld, br = kBrake || this.brakeHeld;
    this.throttle = damp(this.throttle, gas ? 1 : 0, gas ? 5 : 12, dt);
    this.brake = damp(this.brake, br ? 1 : 0, br ? 7 : 14, dt);
    if (this.throttle < 0.01) this.throttle = 0;
    if (this.brake < 0.01) this.brake = 0;
  }
}
