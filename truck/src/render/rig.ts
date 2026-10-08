import * as THREE from 'three';
import type { TrailerKind } from '../sim/jobs';
import { HITCH_AHEAD, TRAILER_LEN, Truck, WHEELBASE } from '../sim/truck';
import type { World } from '../sim/world';
import { clamp, damp } from '../util';
import { MAT } from './materials';
import type { TruckLook } from '../sim/trucks';
import { LightState, Trailer, Tractor, applyLights, buildTrailer, buildTractor, setCabAmbient } from './vehicles';
import type { Particles } from './fx';

// The player's rig on screen: places the tractor and trailer on the ground, animates the cab
// suspension, wheels and steering wheel, drives the lights, headlight beams and exhaust.

function beamTexture() {
  const c = document.createElement('canvas');
  c.width = 8; c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createLinearGradient(0, 0, 0, 128);
  // Canvas top maps to the narrow end at the lamp, fading out down the road.
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.4, 'rgba(255,255,255,0.35)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 8, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class RigView {
  tractor!: Tractor;
  trailer: Trailer | null = null;
  private parked: Trailer | null = null;
  private cabPivot = new THREE.Group();
  heads: THREE.SpotLight[] = [];
  private beams: THREE.Mesh[] = [];
  private beamMat: THREE.MeshBasicMaterial;
  private blink = 0;
  private smokeT = 0;
  readonly dashCanvas: HTMLCanvasElement;
  private dashTex: THREE.CanvasTexture;
  private dashT = 0;
  private interiorView = false;
  /** Canvas mirrored onto the dashboard sat-nav (the HUD minimap). */
  gpsSource: HTMLCanvasElement | null = null;
  private gpsTex: THREE.CanvasTexture | null = null;
  private gpsT = 0;
  private wipePh = 0;
  /** Cab-local eye position for the driver's view. */
  readonly eye = new THREE.Object3D();
  private v = new THREE.Vector3();
  /** A trailer standing in the yard waiting to be coupled. */
  pickup: { x: number; z: number; heading: number } | null = null;

  constructor(private scene: THREE.Scene, private world: World, look: TruckLook, private headlights: number, mirrorRes = 0) {
    this.mirrorRes = mirrorRes;
    this.beamMat = new THREE.MeshBasicMaterial({ map: beamTexture(), color: 0xfff0d8, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false });
    this.dashCanvas = document.createElement('canvas');
    this.dashCanvas.width = 512; this.dashCanvas.height = 200;
    this.dashTex = new THREE.CanvasTexture(this.dashCanvas);
    this.dashTex.colorSpace = THREE.SRGBColorSpace;
    this.fit(look);
  }

  /** Builds (or rebuilds, after a purchase or new paint) the player's tractor. */
  fit(look: TruckLook) {
    const old = this.tractor;
    const pose = old ? { p: old.root.position.clone(), r: old.root.rotation.clone() } : null;
    if (old) { this.scene.remove(old.root); dispose(old.root); }
    this.tractor = buildTractor(look, { interior: true, plate: 'EH·2026' });
    if (pose) { this.tractor.root.position.copy(pose.p); this.tractor.root.rotation.copy(pose.r); }
    // Re-pivot the cab around its floor so pitch and roll look like cab suspension.
    const cab = this.tractor.cab;
    this.cabPivot = new THREE.Group();
    this.tractor.root.add(this.cabPivot);
    this.cabPivot.position.set(0, 1.25, 3.9);
    this.cabPivot.add(cab);
    cab.position.set(0, -1.25, -3.9);
    this.eye.position.set(0.62, 2.98, 3.98);
    cab.add(this.eye);
    this.scene.add(this.tractor.root);
    this.heads = [];
    this.beams = [];
    const offsets = this.headlights >= 2 ? [0.86, -0.86] : this.headlights === 1 ? [0] : [];
    for (const x of offsets) {
      const l = new THREE.SpotLight(0xfff1dc, 0, 170, 0.4, 0.75, 1.0);
      l.position.set(x, 1.55, 5.35);
      l.target.position.set(x * 0.4, 0, 60);
      cab.add(l, l.target);
      this.heads.push(l);
    }
    for (const x of [0.86, -0.86]) {
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 5.5, 26, 20, 1, true), this.beamMat);
      beam.rotation.x = -Math.PI / 2 + 0.06;
      beam.position.set(x, 1.0, 5.3 + 13);
      cab.add(beam);
      this.beams.push(beam);
    }
    if (this.tractor.dashScreen) (this.tractor.dashScreen.material as THREE.MeshBasicMaterial).map = this.dashTex;
    this.gpsTex = null;
    // Live rear-view mirrors: a small camera at each main mirror renders into the glass.
    this.mirrors = [];
    if (this.mirrorRes) {
      const winY = 1.25 + 1.15 + ([2.6, 2.85, 3.0][this.tractor.model] - 1.15) * 0.42 + 0.02;
      for (const side of [1, -1]) {
        const rt = new THREE.WebGLRenderTarget(this.mirrorRes, Math.round(this.mirrorRes * 2.6), { type: THREE.HalfFloatType });
        rt.texture.repeat.set(-1, 1);
        rt.texture.offset.set(1, 0);
        const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.18, 0.58), new THREE.MeshBasicMaterial({ map: rt.texture }));
        screen.position.set(side * 1.66, winY + 0.05, 4.878);
        screen.rotation.y = Math.PI;
        screen.visible = false;
        cab.add(screen);
        const c = new THREE.PerspectiveCamera(26, 0.18 / 0.58, 0.5, 900);
        c.position.set(side * 1.7, winY + 0.05, 4.85);
        c.lookAt(new THREE.Vector3(side * 2.15, winY - 0.6, -10));
        cab.add(c);
        this.mirrors.push({ rt, screen, cam: c });
      }
    }
    this.setInterior(this.interiorView);
  }

  /** Resolution of the live mirrors (0 = off). */
  mirrorRes = 0;
  private mirrors: { rt: THREE.WebGLRenderTarget; screen: THREE.Mesh; cam: THREE.PerspectiveCamera }[] = [];
  private mirrorFrame = 0;

  /** Renders one mirror per frame, alternating sides, when you're in the cab. */
  renderMirrors(renderer: THREE.WebGLRenderer, scene: THREE.Scene) {
    if (!this.interiorView || !this.mirrors.length) return;
    const m = this.mirrors[this.mirrorFrame++ % this.mirrors.length];
    const prevTarget = renderer.getRenderTarget();
    const autoShadow = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate = false;
    for (const x of this.mirrors) x.screen.visible = false;
    renderer.setRenderTarget(m.rt);
    renderer.render(scene, m.cam);
    renderer.setRenderTarget(prevTarget);
    renderer.shadowMap.autoUpdate = autoShadow;
    for (const x of this.mirrors) x.screen.visible = true;
  }

  setTrailer(kind: TrailerKind | null, livery = 0) {
    if (this.trailer) { this.scene.remove(this.trailer.root); dispose(this.trailer.root); }
    this.trailer = kind ? buildTrailer(kind, livery) : null;
    if (this.trailer) this.scene.add(this.trailer.root);
  }

  /** Leaves the current trailer standing where it is (after a delivery). */
  dropTrailer() {
    if (this.parked) { this.scene.remove(this.parked.root); dispose(this.parked.root); }
    this.parked = this.trailer;
    this.trailer = null;
  }

  setInterior(on: boolean) {
    this.interiorView = on;
    for (const g of this.tractor.glass) g.material = on ? MAT.glassInside : MAT.glassCab;
    for (const b of this.beams) b.visible = !on;
    for (const m of this.mirrors ?? []) m.screen.visible = on;
    for (const o of this.tractor.exterior) o.visible = !on;
  }

  update(dt: number, time: number, t: Truck, lights: LightState, night: number, fog: number, fx: { smoke: Particles; spray: Particles }, wet: number) {
    const w = this.world;
    const root = this.tractor.root;
    // --- tractor on the ground
    const fr = t.tractorPoint(WHEELBASE, 0), lf = t.tractorPoint(WHEELBASE * 0.5, 1.1), rt = t.tractorPoint(WHEELBASE * 0.5, -1.1);
    const hR = w.groundHeight(t.x, t.z), hF = w.groundHeight(fr.x, fr.z);
    const hL = w.groundHeight(lf.x, lf.z), hRt = w.groundHeight(rt.x, rt.z);
    root.position.set(t.x, hR, t.z);
    root.rotation.order = 'YXZ';
    root.rotation.set(-Math.atan2(hF - hR, WHEELBASE), t.heading, Math.atan2(hL - hRt, 2.2));
    t.grade = (hF - hR) / WHEELBASE;
    // Cab suspension: dive under braking, squat on throttle, lean out of turns, idle shake.
    const shake = Math.sin(time * (t.rpm / 60) * Math.PI * 2 * 3) * 0.0012 * (1.3 - Math.min(1, Math.abs(t.speed) / 10));
    this.cabPivot.rotation.x = damp(this.cabPivot.rotation.x, clamp(-t.accel * 0.007, -0.045, 0.05) + shake, 6, dt);
    this.cabPivot.rotation.z = damp(this.cabPivot.rotation.z, clamp(-t.latAccel * 0.011, -0.05, 0.05), 5, dt);
    for (const s of this.tractor.steer) s.rotation.y = -t.wheelAngle;
    for (const s of this.tractor.spin) s.rotation.x = t.wheelSpin;
    const sw = this.tractor.steeringWheel.children[0];
    if (sw) sw.rotation.z = t.wheelAngle * 15;

    // --- an uncoupled trailer stands level on its landing legs
    if (this.trailer && !t.hasTrailer && this.pickup) {
      const tr = this.trailer.root, p = this.pickup;
      tr.position.set(p.x, w.groundHeight(p.x, p.z), p.z);
      tr.rotation.set(0, p.heading, 0);
      applyLights(this.trailer.lights, { head: false, high: false, brake: 0, tail: false, indL: false, indR: false, reverse: false, roof: false }, night);
    }
    // --- trailer hangs off the fifth wheel
    if (this.trailer && t.hasTrailer) {
      const tr = this.trailer.root;
      root.updateMatrixWorld(true);
      const king = this.v.set(0, 1.22, HITCH_AHEAD).applyMatrix4(root.matrixWorld);
      const l = t.trailerPoint(0, 1.0), r = t.trailerPoint(0, -1.0);
      const hA = w.groundHeight(t.tx, t.tz);
      const hl = w.groundHeight(l.x, l.z), hr = w.groundHeight(r.x, r.z);
      tr.position.set(t.tx, hA, t.tz);
      tr.rotation.order = 'YXZ';
      tr.rotation.set(-Math.atan2(king.y - 1.22 - hA, TRAILER_LEN), t.trailerHeading, Math.atan2(hl - hr, 2.0) - t.latAccel * 0.004);
      for (const s of this.trailer.spin) s.rotation.x = t.wheelSpin;
      applyLights(this.trailer.lights, lights, night);
    }
    if (this.parked) applyLights(this.parked.lights, { head: false, high: false, brake: 0, tail: false, indL: false, indR: false, reverse: false, roof: false }, night);

    // --- lights
    this.blink = (this.blink + dt) % 0.8;
    const on = this.blink < 0.4;
    const ls: LightState = { ...lights, indL: lights.indL && on, indR: lights.indR && on };
    applyLights(this.tractor.lights, ls, night);
    if (this.trailer) applyLights(this.trailer.lights, ls, night);
    for (const h of this.heads) {
      h.intensity = lights.head ? (lights.high ? 1100 : 480) : 0;
      h.angle = lights.high ? 0.32 : 0.42;
      h.target.position.y = lights.high ? 1.2 : 0;
    }
    this.beamMat.opacity = lights.head && !this.interiorView ? 0.008 * night * (1 + fog * 4) : 0;

    // --- exhaust smoke, heavier and darker under load
    this.smokeT += dt * (3 + t.load * 26);
    if (this.smokeT > 1) {
      this.smokeT -= Math.floor(this.smokeT);
      root.updateMatrixWorld(true);
      const p = this.tractor.exhaustTip.getWorldPosition(this.v);
      const vx = Math.sin(t.heading) * t.speed * 0.5, vz = Math.cos(t.heading) * t.speed * 0.5;
      fx.smoke.emit(p.x, p.y, p.z, vx, 1.6 + t.load * 2, vz, 0.5, 1.6 + t.load, 2.4, 0.08 + t.load * 0.28);
    }
    // --- road spray behind the wheels when the road is wet
    if (wet > 0.2 && Math.abs(t.speed) > 7) {
      const n = Math.min(4, Math.floor(wet * Math.abs(t.speed) * 0.12) + 1);
      for (let k = 0; k < n; k++) {
        const src = this.trailer && k % 2 ? t.trailerPoint(-1.4, (Math.random() - 0.5) * 2.2) : t.tractorPoint(-0.7, (Math.random() - 0.5) * 2.2);
        const gy = w.groundHeight(src.x, src.z);
        fx.spray.emit(src.x, gy + 0.4, src.z, Math.sin(t.heading) * t.speed * 0.35 + (Math.random() - 0.5) * 2, 1 + Math.random(), Math.cos(t.heading) * t.speed * 0.35, 1.2, 4.5, 1.1, 0.12 * wet);
      }
    }
    this.dashT -= dt;
    if (this.dashT <= 0 && this.interiorView) { this.dashT = 0.1; this.drawDash(t); }
    if (this.interiorView) setCabAmbient(0.04 + (1 - night) * 0.3);
    // Sat-nav: shows the same map as the HUD.
    this.gpsT -= dt;
    const gps = this.tractor.gpsScreen;
    if (gps && this.gpsSource && this.interiorView && this.gpsT <= 0 && this.gpsSource.width > 0) {
      this.gpsT = 0.2;
      if (!this.gpsTex || this.gpsTex.image !== this.gpsSource) {
        this.gpsTex = new THREE.CanvasTexture(this.gpsSource);
        this.gpsTex.colorSpace = THREE.SRGBColorSpace;
        const m = gps.material as THREE.MeshBasicMaterial;
        m.map = this.gpsTex;
        m.color.setScalar(0.85);
        m.needsUpdate = true;
      }
      this.gpsTex.needsUpdate = true;
    }
    // Wipers sweep while it rains (faster in a downpour) and park when it stops.
    const wipers = this.tractor.wipers;
    if (wipers.length) {
      if (fog > 0.15 || this.wipePh % 1 > 0.02) this.wipePh += dt * (fog > 0.6 ? 1.3 : 0.8);
      const a = Math.sin((this.wipePh % 1) * Math.PI) * 1.45;
      for (const wp of wipers) wp.rotation.z = Math.PI / 2 - 0.08 - a;
    }
  }

  private drawDash(t: Truck) {
    const g = this.dashCanvas.getContext('2d')!;
    const W = 512, H = 200;
    g.fillStyle = '#05070a'; g.fillRect(0, 0, W, H);
    const gauge = (cx: number, value: number, max: number, label: string, unit: string, redFrom: number) => {
      const r = 82, a0 = Math.PI * 0.75, a1 = Math.PI * 2.25;
      g.lineWidth = 6; g.strokeStyle = '#1d2733'; g.beginPath(); g.arc(cx, 105, r, a0, a1); g.stroke();
      g.strokeStyle = '#ff3b30'; g.beginPath(); g.arc(cx, 105, r, a0 + (a1 - a0) * (redFrom / max), a1); g.stroke();
      g.fillStyle = '#9fb3c8';
      for (let k = 0; k <= 10; k++) {
        const a = a0 + ((a1 - a0) * k) / 10;
        g.fillRect(cx + Math.cos(a) * (r - 14) - 1.5, 105 + Math.sin(a) * (r - 14) - 1.5, 3, 3);
      }
      const a = a0 + (a1 - a0) * Math.min(1, value / max);
      g.strokeStyle = '#ff8a1f'; g.lineWidth = 4; g.beginPath(); g.moveTo(cx, 105); g.lineTo(cx + Math.cos(a) * (r - 8), 105 + Math.sin(a) * (r - 8)); g.stroke();
      g.fillStyle = '#e8f1ff'; g.font = '700 30px "Barlow Condensed", sans-serif'; g.textAlign = 'center';
      g.fillText(label, cx, 150);
      g.font = '600 13px "Barlow", sans-serif'; g.fillStyle = '#6f8296'; g.fillText(unit, cx, 168);
    };
    gauge(100, t.kmh, 125, String(Math.round(t.kmh)), 'km/h', 90);
    gauge(412, t.rpm, 2500, (t.rpm / 1000).toFixed(1), 'x1000 rpm', 2000);
    g.textAlign = 'center';
    g.fillStyle = '#ffb347'; g.font = '800 44px "Barlow Condensed", sans-serif';
    g.fillText(t.drive === 'D' ? `D${t.gear}` : t.drive, 256, 92);
    g.fillStyle = '#6f8296'; g.font = '600 14px "Barlow", sans-serif';
    g.fillText(`FUEL ${Math.round(t.fuel)} L`, 256, 128);
    if (t.cruise != null) { g.fillStyle = '#3dd68c'; g.fillText(`CRUISE ${Math.round(t.cruise * 3.6)}`, 256, 150); }
    this.dashTex.needsUpdate = true;
  }
}

function dispose(o: THREE.Object3D) {
  o.traverse((x) => { if (x instanceof THREE.Mesh) x.geometry.dispose(); });
}
