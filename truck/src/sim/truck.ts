import { angleDiff, clamp, damp } from '../util';

// Truck dynamics: a 4x2 tractor with an articulated semi-trailer.
// Lateral motion is kinematic (wheels don't slide sideways), longitudinal motion has an engine
// torque curve, a 12-speed automated gearbox, air brakes, engine brake, drag and hill grades.

export const WHEELBASE = 3.9;
/** Fifth wheel sits this far ahead of the drive axle. */
export const HITCH_AHEAD = 0.45;
/** Kingpin to the centre of the trailer's axle group. */
export const TRAILER_LEN = 10.4;
export const TRACTOR_MASS = 8200;
export const TRAILER_MASS = 6800;
export const WHEEL_R = 0.52;
export const FUEL_CAP = 600;
export const SPEED_LIMITER = 25; // 90 km/h, as on real European trucks

const RATIOS = [14.9, 11.7, 9.1, 7.1, 5.6, 4.4, 3.4, 2.7, 2.1, 1.7, 1.3, 1.0];
const REVERSE_RATIO = 13.5;
const FINAL = 2.8;
const IDLE = 600;
const RED = 2150;

export function engineTorque(rpm: number) {
  if (rpm < 1000) return 1700 + ((rpm - 600) / 400) * 800;
  if (rpm < 1450) return 2500;
  if (rpm < 1900) return 2500 - ((rpm - 1450) / 450) * 650;
  return Math.max(0, 1850 - ((rpm - 1900) / 250) * 1850);
}

export type Drive = 'D' | 'N' | 'R';

export interface TruckInput {
  throttle: number;
  brake: number;
  /** -1 full left .. +1 full right */
  steer: number;
  handbrake: boolean;
}

export class Truck {
  /** Drive axle centre. */
  x = 0;
  z = 0;
  /** Forward = (sin heading, cos heading). */
  heading = 0;
  trailerHeading = 0;
  /** Trailer axle-group centre. */
  tx = 0;
  tz = 0;
  speed = 0;
  /** Road wheel angle (rad), positive = right. */
  wheelAngle = 0;
  rpm = IDLE;
  gear = 1;
  drive: Drive = 'D';
  shiftTimer = 0;
  cargoMass = 0;
  hasTrailer = true;
  fuel = FUEL_CAP * 0.8;
  odometer = 0;
  /** 0..1 */
  damage = 0;
  /** Smoothed longitudinal acceleration, used for cab pitch and the dashboard. */
  accel = 0;
  /** Engine load 0..1 for sound and exhaust. */
  load = 0;
  braking = 0;
  /** Lateral acceleration (m/s²), positive when pushed right. */
  latAccel = 0;
  wheelSpin = 0;
  cruise: number | null = null;
  /** Gradient along the heading (rise / run), set by the game from the ground. */
  grade = 0;
  offroad = false;

  get mass() { return TRACTOR_MASS + (this.hasTrailer ? TRAILER_MASS + this.cargoMass : 0); }
  get kmh() { return Math.abs(this.speed) * 3.6; }
  get articulation() { return angleDiff(this.trailerHeading, this.heading); }

  place(x: number, z: number, heading: number) {
    this.x = x; this.z = z; this.heading = heading; this.trailerHeading = heading;
    this.speed = 0; this.wheelAngle = 0; this.gear = 1; this.cruise = null;
    this.alignTrailer();
  }

  alignTrailer() {
    const kx = this.x + Math.sin(this.heading) * HITCH_AHEAD, kz = this.z + Math.cos(this.heading) * HITCH_AHEAD;
    this.tx = kx - Math.sin(this.trailerHeading) * TRAILER_LEN;
    this.tz = kz - Math.cos(this.trailerHeading) * TRAILER_LEN;
  }

  /** Largest wheel angle that keeps sideways acceleration sane at this speed. */
  maxWheelAngle(v = this.speed) {
    const a = Math.abs(v) < 0.5 ? 0.62 : Math.atan((WHEELBASE * 3.6) / (v * v));
    return Math.min(0.62, a);
  }

  update(dt: number, inp: TruckInput) {
    const m = this.mass;
    const v = this.speed;
    // Cruise control holds a set speed with a gentle PI-ish blend; touching the brake cancels it.
    let throttle = clamp(inp.throttle, 0, 1);
    let brake = clamp(inp.brake, 0, 1);
    if (this.cruise != null) {
      if (brake > 0.05 || this.drive !== 'D') this.cruise = null;
      else {
        const err = this.cruise - v;
        throttle = Math.max(throttle, clamp(err * 0.6 + 0.35, 0, 1));
        if (err < -1.2) brake = Math.max(brake, clamp(-err * 0.08, 0, 0.4));
      }
    }
    if (this.fuel <= 0) throttle = 0;
    // Hill hold: standing still with no throttle keeps the brakes on, so the rig never creeps.
    if (throttle < 0.02 && Math.abs(v) < 0.4) brake = Math.max(brake, 0.5);

    // Steering: the wheel follows the input at a finite rate, limited by speed.
    const target = clamp(inp.steer, -1, 1) * this.maxWheelAngle();
    const rate = 1.1;
    this.wheelAngle += clamp(target - this.wheelAngle, -rate * dt, rate * dt);

    // Gearbox (automated manual). In D it picks gears by rpm; shifting cuts power briefly.
    const ratioOf = (g: number) => (this.drive === 'R' ? REVERSE_RATIO : RATIOS[g - 1]);
    const wheelRpm = (Math.abs(v) / WHEEL_R) * (60 / (2 * Math.PI));
    if (this.drive === 'D') {
      if (this.shiftTimer <= 0) {
        const r = wheelRpm * ratioOf(this.gear) * FINAL;
        const up = 1350 + throttle * 400;
        if (r > up && this.gear < RATIOS.length) { this.gear++; this.shiftTimer = 0.35; }
        else if (r < 950 && this.gear > 1) {
          // Skip-shift down to the gear that lands near 1300 rpm.
          let g = this.gear - 1;
          while (g > 1 && wheelRpm * RATIOS[g - 1] * FINAL < 1100) g--;
          this.gear = g; this.shiftTimer = 0.3;
        }
        if (Math.abs(v) < 1.5 && this.gear > 2 && throttle > 0) this.gear = Math.abs(v) < 0.5 ? 1 : 2;
      }
    }
    this.shiftTimer -= dt;
    const ratio = this.drive === 'N' ? 0 : ratioOf(this.gear);
    const coupled = ratio > 0 && this.shiftTimer <= 0;
    const geared = wheelRpm * ratio * FINAL;
    // Clutch slip below idle keeps the engine alive when pulling away.
    const targetRpm = coupled ? Math.max(IDLE + throttle * 500 * (geared < IDLE ? 1 : 0), geared) : IDLE + throttle * 1300;
    this.rpm = damp(this.rpm, clamp(targetRpm, IDLE, RED), coupled ? 18 : 6, dt);

    // Forces along the heading. `dir` is +1 for forward drive, -1 for reverse.
    const dir = this.drive === 'R' ? -1 : 1;
    let drive = 0;
    if (coupled && this.drive !== 'N') {
      const limiter = this.drive === 'D' && v > SPEED_LIMITER ? 0 : 1;
      const torque = engineTorque(this.rpm) * throttle * limiter;
      drive = Math.min((torque * ratio * FINAL * 0.9) / WHEEL_R, 72000) * dir;
      // Engine braking when off the throttle in gear.
      if (throttle < 0.05 && Math.abs(v) > 1) drive -= Math.sign(v) * (this.rpm / RED) * 9000;
    }
    const g = 9.81;
    const roll = (this.offroad ? 0.06 : 0.0065) * m * g;
    const aero = 0.5 * 1.2 * 0.62 * 10 * v * v;
    const gradeF = -m * g * Math.sin(Math.atan(this.grade));
    const brakeF = brake * 0.55 * m * g + (inp.handbrake ? 0.4 * m * g : 0);
    let force = drive + gradeF;
    // Resistive forces oppose motion and can't push the truck backwards on their own.
    const resist = roll + aero + brakeF;
    let a = force / m;
    const vNext = v + a * dt;
    const resistDv = (resist / m) * dt;
    if (Math.abs(vNext) <= resistDv && Math.abs(force) <= resist) this.speed = 0;
    else this.speed = vNext - Math.sign(vNext || v) * resistDv;
    if (this.drive === 'R') this.speed = Math.max(this.speed, -6);
    a = (this.speed - v) / Math.max(dt, 1e-4);
    this.accel = damp(this.accel, a, 6, dt);
    this.braking = brake;
    this.load = coupled ? clamp(throttle * (engineTorque(this.rpm) / 2500), 0, 1) : throttle * 0.3;
    this.fuel = Math.max(0, this.fuel - (0.0008 + this.load * (this.rpm / 1500) * 0.011) * dt);

    // Kinematic bicycle model for the tractor, trailer pulled from the kingpin (sub-stepped).
    const steps = 4;
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      const sp = this.speed;
      const yaw = -(sp * Math.tan(this.wheelAngle)) / WHEELBASE;
      this.heading += yaw * h;
      this.x += Math.sin(this.heading) * sp * h;
      this.z += Math.cos(this.heading) * sp * h;
      if (this.hasTrailer) {
        const kx = this.x + Math.sin(this.heading) * HITCH_AHEAD, kz = this.z + Math.cos(this.heading) * HITCH_AHEAD;
        // The trailer axle only rolls along its own heading; its direction is then whatever points at the kingpin.
        const fx = Math.sin(this.trailerHeading), fz = Math.cos(this.trailerHeading);
        const kvx = Math.sin(this.heading) * sp + Math.cos(this.heading) * yaw * HITCH_AHEAD;
        const kvz = Math.cos(this.heading) * sp - Math.sin(this.heading) * yaw * HITCH_AHEAD;
        const along = kvx * fx + kvz * fz;
        this.tx += fx * along * h;
        this.tz += fz * along * h;
        let th = Math.atan2(kx - this.tx, kz - this.tz);
        // A jack-knife stops at the cab's back wall.
        const art = angleDiff(th, this.heading);
        if (Math.abs(art) > 1.45) th = this.heading - Math.sign(art) * 1.45;
        this.trailerHeading = th;
        this.tx = kx - Math.sin(th) * TRAILER_LEN;
        this.tz = kz - Math.cos(th) * TRAILER_LEN;
      }
    }
    this.latAccel = damp(this.latAccel, this.speed * this.speed * Math.tan(this.wheelAngle) / WHEELBASE, 5, dt);
    this.wheelSpin += (this.speed / WHEEL_R) * dt;
    this.odometer += Math.abs(this.speed) * dt;
  }

  /** Called on a collision: scrubs speed and adds damage based on impact speed. */
  impact(relSpeed: number, keep = 0.3) {
    const dmg = Math.max(0, relSpeed - 1.5) * 0.006;
    this.damage = Math.min(1, this.damage + dmg);
    this.speed *= keep;
    this.cruise = null;
    return dmg;
  }

  /** World point on the tractor/trailer: along = metres forward of the drive axle, side = metres to the right. */
  tractorPoint(along: number, side: number) {
    const s = Math.sin(this.heading), c = Math.cos(this.heading);
    return { x: this.x + s * along - c * side, z: this.z + c * along + s * side };
  }
  trailerPoint(along: number, side: number) {
    const s = Math.sin(this.trailerHeading), c = Math.cos(this.trailerHeading);
    return { x: this.tx + s * along - c * side, z: this.tz + c * along + s * side };
  }
}
