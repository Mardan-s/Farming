import * as THREE from 'three';

/** A camera-facing text label; `height` is its size in world units. */
/** Paper-tag label like the UI: cream card, ink text, optional colored marks after the text. */
export function tagSprite(text: string, height: number, opts: { eyebrow?: string; marks?: string[]; accent?: string } = {}) {
  const fontPx = 64;
  const font = `700 ${fontPx}px 'Zilla Slab', Rockwell, Georgia, serif`;
  const small = `700 26px Karla, 'Segoe UI', sans-serif`;
  const ctx0 = document.createElement('canvas').getContext('2d')!;
  ctx0.font = font;
  const marks = opts.marks ?? [];
  const textW = ctx0.measureText(text).width;
  ctx0.font = small;
  const eyeW = opts.eyebrow ? ctx0.measureText(opts.eyebrow.toUpperCase()).width + opts.eyebrow.length * 3 : 0;
  const w = Math.ceil(Math.max(textW + marks.length * 34, eyeW) + 44);
  const h = opts.eyebrow ? 118 : 90;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#f1e9d6';
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = '#b3a17b';
  ctx.lineWidth = 3;
  ctx.strokeRect(1.5, 1.5, w - 3, h - 3);
  ctx.fillStyle = opts.accent ?? '#a3402c';
  ctx.fillRect(0, 0, 8, h);
  let y = 14;
  if (opts.eyebrow) {
    ctx.font = small;
    ctx.fillStyle = '#8a7e69';
    ctx.textBaseline = 'top';
    ctx.letterSpacing = '3px';
    ctx.fillText(opts.eyebrow.toUpperCase(), 24, y);
    ctx.letterSpacing = '0px';
    y += 30;
  }
  ctx.font = font;
  ctx.fillStyle = '#2a241b';
  ctx.textBaseline = 'top';
  ctx.fillText(text, 24, y);
  marks.forEach((m, i) => {
    ctx.fillStyle = m;
    ctx.beginPath();
    ctx.arc(24 + textW + 22 + i * 34, y + 34, 11, 0, Math.PI * 2);
    ctx.fill();
  });
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  sprite.scale.set((height * w) / h, height, 1);
  sprite.renderOrder = 10;
  return sprite;
}

export function textSprite(text: string, height: number, opts: { color?: string; bg?: string; bold?: boolean } = {}) {
  const lines = text.split('\n');
  const fontPx = 64;
  const font = `${opts.bold === false ? 600 : 800} ${fontPx}px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif`;
  const measure = document.createElement('canvas').getContext('2d')!;
  measure.font = font;
  const w = Math.max(...lines.map(l => measure.measureText(l).width)) + 48;
  const lineH = fontPx * 1.2;
  const h = lineH * lines.length + 24;
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(w);
  canvas.height = Math.ceil(h);
  const ctx = canvas.getContext('2d')!;
  if (opts.bg) {
    ctx.fillStyle = opts.bg;
    const r = 26;
    ctx.beginPath();
    ctx.roundRect(0, 0, canvas.width, canvas.height, r);
    ctx.fill();
  }
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  lines.forEach((l, i) => {
    const y = 12 + lineH * (i + 0.5);
    if (!opts.bg) {
      ctx.lineWidth = 12;
      ctx.strokeStyle = 'rgba(20,30,15,0.85)';
      ctx.strokeText(l, canvas.width / 2, y);
    }
    ctx.fillStyle = opts.color ?? '#ffffff';
    ctx.fillText(l, canvas.width / 2, y);
  });
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  const worldH = height * lines.length;
  sprite.scale.set((worldH * canvas.width) / canvas.height, worldH, 1);
  sprite.renderOrder = 10;
  return sprite;
}

export function disposeSprite(s: THREE.Sprite) {
  s.material.map?.dispose();
  s.material.dispose();
  s.removeFromParent();
}
