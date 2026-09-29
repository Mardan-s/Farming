import * as THREE from 'three';

/** A camera-facing text label; `height` is its size in world units. */
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
