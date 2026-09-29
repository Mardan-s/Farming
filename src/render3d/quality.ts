export type Quality = 'low' | 'medium' | 'high';

const KEY = 'farming-quality';

function guess(): Quality {
  const cores = navigator.hardwareConcurrency || 4;
  const mobile = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
  if (cores <= 4) return 'low';
  return mobile ? 'medium' : 'high';
}

export function getQuality(): Quality {
  try {
    const q = localStorage.getItem(KEY);
    if (q === 'low' || q === 'medium' || q === 'high') return q;
  } catch { /* storage unavailable */ }
  return guess();
}

export function setQuality(q: Quality) {
  try { localStorage.setItem(KEY, q); } catch { /* storage unavailable */ }
}

// envMap stays off: baking reflections (PMREM) needs half-float render targets, which many
// Android GPUs don't support, and it corrupted every lit surface (black or white screens).
export const QUALITY = {
  low: { pixelRatio: 1, shadowMap: 1024, plantDensity: 0.5, grassDensity: 0, envMap: false, detailGround: true },
  medium: { pixelRatio: 1.5, shadowMap: 2048, plantDensity: 0.75, grassDensity: 0.35, envMap: false, detailGround: true },
  high: { pixelRatio: 2, shadowMap: 2048, plantDensity: 1, grassDensity: 0.7, envMap: false, detailGround: true },
};
