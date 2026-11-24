// Core 3D stage: renderer, camera, bloom post-processing, resize handling and the animation loop.
// Rooms never create their own renderer; they add objects to stage.scene and register an updater.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const MAX_PIXEL_RATIO = 2;

/** Free GPU memory held by an object tree: geometries, materials and textures. */
export function disposeObject(root) {
  root.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.isInstancedMesh) o.dispose();
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) {
      for (const key in m) {
        const v = m[key];
        if (v && v.isTexture) v.dispose();
      }
      if (m.uniforms) {
        for (const k in m.uniforms) {
          const v = m.uniforms[k].value;
          if (v && v.isTexture) v.dispose();
        }
      }
      m.dispose();
    }
  });
}

/**
 * Create the shared stage.
 * @param {HTMLCanvasElement} canvas
 * @param {{reducedMotion?: boolean}} [opts]
 */
export function createStage(canvas, opts = {}) {
  const isMobile = () => window.innerWidth < 768;
  let w = window.innerWidth;
  let h = window.innerHeight;
  let pixelRatio = Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO);

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false, // MSAA comes from the composer render target instead
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(w, h, false);
  renderer.setClearColor(0x05070d, 1);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x05070d);

  const camera = new THREE.PerspectiveCamera(60, w / h, 0.1, 400);
  camera.position.set(0, 1.7, 5.5);

  // Post-processing: scene -> bloom -> tone mapping / sRGB output
  const target = new THREE.WebGLRenderTarget(w * pixelRatio, h * pixelRatio, {
    type: THREE.HalfFloatType,
    samples: isMobile() ? 0 : 4,
  });
  const composer = new EffectComposer(renderer, target);
  composer.setPixelRatio(pixelRatio);
  composer.setSize(w, h);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 0.9, 0.55, 0.82);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  let bloomOn = true;

  // Per-frame callbacks: fn(dt, elapsedSeconds)
  const updaters = new Set();
  const failed = new WeakSet();
  const resizeListeners = new Set();

  function applySize() {
    w = window.innerWidth;
    h = window.innerHeight;
    renderer.setPixelRatio(pixelRatio);
    renderer.setSize(w, h, false);
    composer.setPixelRatio(pixelRatio);
    composer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    for (const fn of resizeListeners) fn(w, h);
  }

  let resizeQueued = false;
  function onResize() {
    if (resizeQueued) return;
    resizeQueued = true;
    requestAnimationFrame(() => {
      resizeQueued = false;
      pixelRatio = Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO);
      applySize();
    });
  }
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', onResize);

  canvas.addEventListener('webglcontextlost', (e) => e.preventDefault());

  // Adaptive quality: if frames stay slow, drop pixel ratio first, then bloom.
  let slowFrames = 0;
  function adapt(dt) {
    if (dt > 0.034) slowFrames++;
    else slowFrames = Math.max(0, slowFrames - 2);
    if (slowFrames < 90) return;
    slowFrames = 0;
    if (pixelRatio > 1) {
      pixelRatio = 1;
      applySize();
    } else if (bloomOn) {
      bloomOn = false;
    }
  }

  const clock = new THREE.Clock();
  let rafId = 0;
  let running = false;

  function frame() {
    rafId = requestAnimationFrame(frame);
    const dt = Math.min(clock.getDelta(), 0.1);
    const t = clock.elapsedTime;
    for (const fn of updaters) {
      try {
        fn(dt, t);
      } catch (err) {
        if (!failed.has(fn)) {
          failed.add(fn);
          console.error('[scene] updater threw', err);
        }
      }
    }
    if (bloomOn) composer.render(dt);
    else renderer.render(scene, camera);
    adapt(dt);
  }

  return {
    renderer,
    scene,
    camera,
    composer,
    bloom,
    reducedMotion: !!opts.reducedMotion,
    get isMobile() { return isMobile(); },
    get size() { return { width: w, height: h }; },

    /** Register a per-frame callback. Returns an unsubscribe function. */
    addUpdater(fn) {
      updaters.add(fn);
      return () => updaters.delete(fn);
    },
    removeUpdater(fn) { updaters.delete(fn); },

    /** Listen for viewport changes: fn(width, height). Returns an unsubscribe function. */
    onResize(fn) {
      resizeListeners.add(fn);
      return () => resizeListeners.delete(fn);
    },

    /** Tweak bloom live, e.g. setBloom({ strength: 2 }). */
    setBloom({ strength, radius, threshold, enabled } = {}) {
      if (strength !== undefined) bloom.strength = strength;
      if (radius !== undefined) bloom.radius = radius;
      if (threshold !== undefined) bloom.threshold = threshold;
      if (enabled !== undefined) bloomOn = !!enabled;
    },

    start() {
      if (running) return;
      running = true;
      clock.start();
      rafId = requestAnimationFrame(frame);
    },
    stop() {
      running = false;
      cancelAnimationFrame(rafId);
    },
    dispose() {
      this.stop();
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
      disposeObject(scene);
      composer.dispose();
      renderer.dispose();
    },
  };
}
