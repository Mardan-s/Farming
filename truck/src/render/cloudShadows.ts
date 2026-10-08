import * as THREE from 'three';
import { mulberry32 } from '../util';

// Soft cloud shadows drifting over the land. Patched into the ground, road, crop and grass
// materials: a tiling noise texture scrolled with the wind darkens what's under a cloud.

const S = 256;
function cloudTexture() {
  const data = new Uint8Array(S * S * 4);
  const rnd = mulberry32(5);
  const oct = [8, 16, 32].map((p) => { const a = new Float32Array(p * p); for (let i = 0; i < a.length; i++) a[i] = rnd(); return { p, a }; });
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    let v = 0, amp = 0.55;
    for (const { p, a } of oct) {
      const gx = (x / S) * p, gy = (y / S) * p, ix = Math.floor(gx), iy = Math.floor(gy), fx = gx - ix, fy = gy - iy;
      const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
      const A = a[(iy % p) * p + (ix % p)], B = a[(iy % p) * p + ((ix + 1) % p)], C = a[((iy + 1) % p) * p + (ix % p)], D = a[((iy + 1) % p) * p + ((ix + 1) % p)];
      v += amp * (A + (B - A) * ux + (C - A) * uy + (A - B - C + D) * ux * uy);
      amp *= 0.5;
    }
    const k = (y * S + x) * 4;
    data[k] = data[k + 1] = data[k + 2] = Math.min(255, (v / 0.96) * 255);
    data[k + 3] = 255;
  }
  const t = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

export const cloudUniforms = {
  uCloudTex: { value: null as THREE.Texture | null },
  uCloudOff: { value: new THREE.Vector2() },
  /** Fraction of the sky covered; 0 = no shadows. */
  uCloudCover: { value: 0.3 },
  /** How dark a shadow is (fades out when the sun is low or down). */
  uCloudDark: { value: 0.45 },
};

/** Adds cloud shadows to a standard material, keeping any onBeforeCompile it already has. */
export function withCloudShadows<T extends THREE.Material>(mat: T): T {
  if (!cloudUniforms.uCloudTex.value) cloudUniforms.uCloudTex.value = cloudTexture();
  const prev = mat.onBeforeCompile.bind(mat);
  // Programs are cached by this key; keep it distinct from the material's other patches.
  const prevKey = mat.customProgramCacheKey();
  mat.customProgramCacheKey = () => prevKey + '|clouds';
  mat.onBeforeCompile = (sh, r) => {
    prev(sh, r);
    Object.assign(sh.uniforms, cloudUniforms);
    sh.vertexShader = 'varying vec2 vCloudXZ;\n' + sh.vertexShader.replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\n  vCloudXZ = (modelMatrix * vec4(transformed, 1.0)).xz;');
    sh.fragmentShader = 'varying vec2 vCloudXZ;\nuniform sampler2D uCloudTex;\nuniform vec2 uCloudOff;\nuniform float uCloudCover, uCloudDark;\n' + sh.fragmentShader.replace('#include <opaque_fragment>', `
  float cn = texture2D(uCloudTex, vCloudXZ / 1400.0 + uCloudOff).r;
  float cs = smoothstep(1.0 - uCloudCover, 1.0 - uCloudCover + 0.18, cn);
  outgoingLight *= 1.0 - cs * uCloudDark;
  #include <opaque_fragment>`);
  };
  mat.needsUpdate = true;
  return mat;
}

export function updateCloudShadows(time: number, cover: number, sunElev: number) {
  cloudUniforms.uCloudOff.value.set(time * 0.0016, time * 0.0007);
  cloudUniforms.uCloudCover.value = cover > 0.85 ? 0 : cover * 0.75;
  cloudUniforms.uCloudDark.value = 0.5 * Math.max(0, Math.min(1, (sunElev - 0.02) * 5));
}
