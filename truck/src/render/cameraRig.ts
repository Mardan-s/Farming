import * as THREE from 'three';
import type { Truck } from '../sim/truck';
import type { World } from '../sim/world';
import { CARRIAGE_OUT, RAIL_LAT } from '../sim/road';
import { angleDiff, clamp, damp, lerp } from '../util';
import type { RigView } from './rig';

// Camera modes: chase (orbit with a finger), cab (driver's seat, look around), cinematic
// (roadside TV-style shots with a long lens) and a low wheel cam.

export type CamMode = 'chase' | 'cab' | 'cinematic' | 'wheel' | 'showcase' | 'free';
export const CAM_MODES: CamMode[] = ['chase', 'cab', 'cinematic', 'wheel'];

export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  mode: CamMode = 'chase';
  /** User orbit offsets, set by dragging. */
  yaw = 0;
  pitch = 0.26;
  dist = 23;
  lookYaw = 0;
  lookPitch = -0.2;
  private camYaw = 0;
  private idle = 0;
  private cine = { x: 0, y: 0, z: 0, s: -1, fov: 30, style: 0 };
  private look = new THREE.Vector3();
  private tmp = new THREE.Vector3();
  private shake = 0;

  constructor(aspect: number, private world: World) {
    this.camera = new THREE.PerspectiveCamera(60, aspect, 0.1, 9000);
  }

  /** Called while the user drags on the 3D view. */
  drag(dx: number, dy: number) {
    this.idle = 0;
    if (this.mode === 'cab') {
      this.lookYaw = clamp(this.lookYaw - dx * 0.006, -2.2, 2.2);
      this.lookPitch = clamp(this.lookPitch - dy * 0.005, -0.6, 0.5);
    } else {
      this.yaw -= dx * 0.008;
      this.pitch = clamp(this.pitch + dy * 0.005, -0.05, 1.2);
    }
  }

  zoom(f: number) {
    this.idle = 0;
    this.dist = clamp(this.dist * f, 9, 42);
  }

  next() {
    this.mode = CAM_MODES[(CAM_MODES.indexOf(this.mode) + 1) % CAM_MODES.length];
    this.cine.s = -1;
    this.lookYaw = 0;
    this.lookPitch = -0.2;
  }

  bump(amount: number) { this.shake = Math.min(1, this.shake + amount); }

  update(dt: number, t: Truck, rig: RigView, time: number) {
    const cam = this.camera;
    this.idle += dt;
    this.shake = Math.max(0, this.shake - dt * 2.5);
    const speedF = Math.min(1, Math.abs(t.speed) / 25);
    const root = rig.tractor.root;
    if (this.mode === 'free') {
      // Debug: the camera stays wherever it was put.
      cam.updateProjectionMatrix();
      return;
    }
    if (this.mode === 'cab') {
      rig.eye.getWorldPosition(this.tmp);
      cam.position.copy(this.tmp);
      // Head bob from bumps and a lean against acceleration.
      cam.position.y += Math.sin(time * 9) * 0.004 * speedF;
      const yaw = t.heading + this.lookYaw;
      if (this.idle > 4) { this.lookYaw = damp(this.lookYaw, 0, 1.5, dt); this.lookPitch = damp(this.lookPitch, -0.2, 1.5, dt); }
      const pitch = this.lookPitch - root.rotation.x;
      this.look.set(cam.position.x + Math.sin(yaw) * Math.cos(pitch), cam.position.y + Math.sin(pitch), cam.position.z + Math.cos(yaw) * Math.cos(pitch));
      cam.up.set(0, 1, 0);
      cam.lookAt(this.look);
      cam.rotateZ(-root.rotation.z * 0.6);
      cam.fov = damp(cam.fov, 64, 4, dt);
      cam.near = 0.05;
    } else if (this.mode === 'showcase') {
      // Slow orbit around the truck for the title screen.
      const a = time * 0.09 + 2.2;
      const c = t.tractorPoint(2.2, 0);
      const gy = root.position.y;
      cam.position.set(c.x + Math.sin(a) * 13.5, gy + 2.2 + Math.sin(time * 0.13) * 0.8, c.z + Math.cos(a) * 13.5);
      cam.position.y = Math.max(cam.position.y, this.world.groundHeight(cam.position.x, cam.position.z) + 1.2);
      this.look.set(c.x, gy + 2.1, c.z);
      cam.lookAt(this.look);
      cam.fov = 42;
      cam.near = 0.2;
    } else if (this.mode === 'cinematic') {
      this.cinematic(t, dt);
      cam.near = 0.5;
    } else if (this.mode === 'wheel') {
      const p = t.tractorPoint(WHEEL_CAM.along, WHEEL_CAM.side);
      const gy = this.world.groundHeight(p.x, p.z);
      cam.position.set(p.x, gy + 0.85, p.z);
      const back = t.trailerPoint(-2, 0);
      this.look.set(back.x, gy + 1.4, back.z);
      cam.lookAt(this.look);
      cam.fov = damp(cam.fov, 62, 4, dt);
      cam.near = 0.1;
    } else {
      // Chase: orbit around a point between cab and trailer, lagging behind the heading.
      this.camYaw += angleDiff(this.camYaw, t.heading) * (1 - Math.exp(-2.4 * dt));
      if (this.idle > 3) { this.yaw = damp(this.yaw, 0, 1.2, dt); this.pitch = damp(this.pitch, 0.26, 1.0, dt); }
      const focus = rig.trailer ? t.tractorPoint(-1.5, 0) : t.tractorPoint(2, 0);
      const fy = root.position.y + (rig.trailer ? 4.2 : 3.0);
      const yaw = this.camYaw + this.yaw;
      const d = this.dist * (1 + speedF * 0.12);
      const pitch = this.pitch;
      const x = focus.x - Math.sin(yaw) * Math.cos(pitch) * d;
      const z = focus.z - Math.cos(yaw) * Math.cos(pitch) * d;
      let y = fy + Math.sin(pitch) * d + 1.5;
      const gy = this.world.groundHeight(x, z) + 1.0;
      if (y < gy) y = gy;
      cam.position.set(x, y, z);
      this.look.set(focus.x + Math.sin(yaw) * 4, fy, focus.z + Math.cos(yaw) * 4);
      cam.lookAt(this.look);
      cam.fov = damp(cam.fov, 58 + speedF * 8, 3, dt);
      cam.near = 0.3;
    }
    if (this.shake > 0) {
      cam.position.x += (Math.random() - 0.5) * this.shake * 0.3;
      cam.position.y += (Math.random() - 0.5) * this.shake * 0.3;
    }
    cam.updateProjectionMatrix();
  }

  private cinematic(t: Truck, dt: number) {
    const cam = this.camera;
    const road = this.world.road;
    const hit = road.locate(t.x, t.z);
    const s = hit ? hit.s : 0;
    // Pick a new shot when the truck has passed the current one (or none yet).
    const passed = this.cine.s < 0 || road.delta(this.cine.s, s) > 45 || Math.hypot(this.cine.x - t.x, this.cine.z - t.z) > 260;
    if (passed) {
      const style = Math.floor(Math.random() * 3);
      const ahead = 90 + Math.random() * 90;
      const side = Math.random() < 0.65 ? 1 : -1;
      const lat = side > 0 ? RAIL_LAT + 4 + Math.random() * 16 : -(CARRIAGE_OUT + 4 + Math.random() * 12);
      const p = road.toWorld(s + ahead, lat, { x: 0, y: 0, z: 0 });
      const gy = this.world.groundHeight(p.x, p.z);
      this.cine = { x: p.x, y: Math.max(gy, p.y) + (style === 2 ? 14 + Math.random() * 10 : 1.2 + Math.random() * 3), z: p.z, s: s + ahead, fov: style === 0 ? 22 + Math.random() * 10 : 35 + Math.random() * 15, style };
    }
    cam.position.set(this.cine.x, this.cine.y, this.cine.z);
    const focus = t.tractorPoint(1.0, 0);
    const gy = this.world.groundHeight(focus.x, focus.z);
    this.look.lerp(this.tmp.set(focus.x, gy + 2.4, focus.z), passed ? 1 : 1 - Math.exp(-6 * dt));
    cam.lookAt(this.look);
    cam.fov = lerp(cam.fov, this.cine.fov, passed ? 1 : 1 - Math.exp(-2 * dt));
  }
}

const WHEEL_CAM = { along: 5.6, side: -1.75 };
