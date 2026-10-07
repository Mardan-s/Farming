import * as THREE from 'three';

export type Tier = 'low' | 'medium' | 'high' | 'ultra';
export const TIERS: Tier[] = ['low', 'medium', 'high', 'ultra'];

export interface Settings {
  /** Upper bound on device pixel ratio. */
  pixelRatio: number;
  shadowSize: number;
  /** Post-processing chain (bloom, grading, flares). Needs float render targets. */
  post: boolean;
  msaa: number;
  envMap: boolean;
  trees: number;
  traffic: number;
  clearcoat: boolean;
  grass: number;
  shadowRange: number;
}

export const SETTINGS: Record<Tier, Settings> = {
  low: { pixelRatio: 1, shadowSize: 1024, post: false, msaa: 0, envMap: false, trees: 2600, traffic: 14, clearcoat: false, grass: 0, shadowRange: 34 },
  medium: { pixelRatio: 1.5, shadowSize: 2048, post: true, msaa: 4, envMap: true, trees: 4500, traffic: 16, clearcoat: false, grass: 9000, shadowRange: 40 },
  high: { pixelRatio: 2, shadowSize: 2048, post: true, msaa: 4, envMap: true, trees: 7000, traffic: 20, clearcoat: true, grass: 16000, shadowRange: 46 },
  ultra: { pixelRatio: 3, shadowSize: 4096, post: true, msaa: 4, envMap: true, trees: 10000, traffic: 26, clearcoat: true, grass: 26000, shadowRange: 55 },
};

const KEY = 'eurohaul-tier';

export function isMobile() {
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.userAgent));
}

export function savedTier(): Tier | null {
  try {
    const t = localStorage.getItem(KEY);
    return TIERS.includes(t as Tier) ? (t as Tier) : null;
  } catch { return null; }
}

export function saveTier(t: Tier) {
  try { localStorage.setItem(KEY, t); } catch { /* storage unavailable */ }
}

/**
 * Bloom, reflections and the HDR pipeline render into half-float targets. Many Android GPUs
 * can't render to those, so without the extension we fall back to a direct, tone-mapped render.
 */
export function canRenderFloat(renderer: THREE.WebGLRenderer) {
  const ext = renderer.extensions;
  return ext.has('EXT_color_buffer_float') || ext.has('EXT_color_buffer_half_float');
}

export function defaultTier(renderer: THREE.WebGLRenderer): Tier {
  const saved = savedTier();
  if (saved) return saved;
  if (!canRenderFloat(renderer)) return 'low';
  const cores = navigator.hardwareConcurrency || 4;
  if (isMobile()) return cores >= 8 ? 'high' : cores >= 6 ? 'medium' : 'low';
  return 'high';
}
