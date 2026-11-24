// Asset loading: one LoadingManager shared by GLTFLoader (+ Draco) and TextureLoader.
// Reports progress to any listener or progress bar. Textures are clamped to 1024px.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

const MAX_TEXTURE = 1024;
const GLB_BUDGET_BYTES = 5 * 1024 * 1024;

/** Downscale a loaded texture image so neither side exceeds MAX_TEXTURE. */
function clampTexture(tex) {
  const img = tex.image;
  if (!img || !img.width || (img.width <= MAX_TEXTURE && img.height <= MAX_TEXTURE)) return tex;
  const scale = MAX_TEXTURE / Math.max(img.width, img.height);
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(img.width * scale));
  c.height = Math.max(1, Math.round(img.height * scale));
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  tex.image = c;
  tex.needsUpdate = true;
  return tex;
}

/** Resolve once web fonts are ready (or after a timeout) so canvas text uses Orbitron. */
export async function waitForFonts(timeoutMs = 2500) {
  if (!document.fonts) return;
  const ready = Promise.all([
    document.fonts.load('700 32px Orbitron'),
    document.fonts.load('16px "Share Tech Mono"'),
  ]).catch(() => {});
  await Promise.race([ready, new Promise((r) => setTimeout(r, timeoutMs))]);
}

export function createAssetLoader() {
  const manager = new THREE.LoadingManager();
  const listeners = new Set();
  const progress = { loaded: 0, total: 0, ratio: 0, url: '' };

  function notify(url, loaded, total) {
    progress.url = url;
    progress.loaded = loaded;
    progress.total = total;
    progress.ratio = total > 0 ? loaded / total : 1;
    for (const fn of listeners) fn({ ...progress });
  }
  manager.onStart = (url, l, t) => notify(url, l, t);
  manager.onProgress = (url, l, t) => notify(url, l, t);
  manager.onLoad = () => notify('', progress.total, progress.total);
  manager.onError = (url) => console.error(`[loader] failed to load ${url}`);

  // Draco decoder files are copied to /public/draco by scripts/copy-draco.mjs
  const draco = new DRACOLoader(manager);
  draco.setDecoderPath('/draco/');
  const gltfLoader = new GLTFLoader(manager);
  gltfLoader.setDRACOLoader(draco);
  const textureLoader = new THREE.TextureLoader(manager);

  /** Warn in dev when a GLB is over the size budget. */
  async function checkSize(url) {
    if (!import.meta.env?.DEV) return;
    try {
      const res = await fetch(url, { method: 'HEAD' });
      const size = Number(res.headers.get('content-length')) || 0;
      if (size > GLB_BUDGET_BYTES) console.warn(`[loader] ${url} is ${(size / 1048576).toFixed(1)} MB (budget 5 MB total)`);
    } catch { /* size check is best effort */ }
  }

  return {
    manager,

    /** Subscribe to progress: fn({loaded,total,ratio,url}). Returns an unsubscribe function. */
    onProgress(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    /** Mirror progress into a bar element and its fill element. */
    bindProgressUI({ fill, bar }) {
      return this.onProgress(({ ratio }) => {
        const pct = Math.round(ratio * 100);
        if (fill) fill.style.width = `${pct}%`;
        if (bar) bar.setAttribute('aria-valuenow', String(pct));
      });
    },

    loadGLTF(url) {
      checkSize(url);
      return gltfLoader.loadAsync(url);
    },

    async loadTexture(url, { srgb = true } = {}) {
      const tex = await textureLoader.loadAsync(url);
      if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
      return clampTexture(tex);
    },

    /**
     * Load a list of {type:'gltf'|'texture', url}. Failures are logged, never thrown.
     * Resolves with a Map of url -> result. An empty list resolves immediately.
     */
    async preload(list = []) {
      const results = new Map();
      await Promise.all(
        list.map(async ({ type, url }) => {
          try {
            results.set(url, type === 'gltf' ? await this.loadGLTF(url) : await this.loadTexture(url));
          } catch (err) {
            console.warn(`[loader] preload skipped ${url}`, err);
          }
        })
      );
      return results;
    },

    dispose() {
      draco.dispose();
      listeners.clear();
    },
  };
}
