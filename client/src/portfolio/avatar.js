// 3D avatar for the Quick Portfolio hero: a Mixamo character (FBX) with its greeting animation.
// Own small WebGL canvas (transparent background), so the big background scene is untouched.
// The FBX loader is imported only when the hero mounts. Missing/invalid file: the box is removed and the page is unchanged.
// File: client/public/models/avatar.fbx (served as /models/avatar.fbx). Returns { destroy }.

import * as THREE from 'three';

const URL_FBX = '/models/avatar.fbx';
const HEIGHT = 1.8; // the model is scaled to this height (Mixamo FBX is in centimetres)

export function mountAvatar(box, { reduced = false, mobile = false } = {}) {
  let disposed = false;
  let raf = 0;
  let renderer = null;
  let model = null;
  let mixer = null;
  let visible = true;
  let io = null;
  const cleanups = [];

  const fail = (err) => {
    console.warn('[avatar] not shown:', err?.message || err);
    box.remove();
  };

  (async () => {
    const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js');
    const fbx = await new FBXLoader().loadAsync(URL_FBX);
    if (disposed) return;

    // ---- renderer, scene, camera ----
    const canvas = document.createElement('canvas');
    box.append(canvas);
    renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: !mobile, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, mobile ? 1.5 : 1.75));
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50);

    // ---- model: feet on y=0, centred, scaled to HEIGHT ----
    model = fbx;
    const box3 = new THREE.Box3().setFromObject(model);
    const size = box3.getSize(new THREE.Vector3());
    const k = HEIGHT / (size.y || 1);
    model.scale.multiplyScalar(k);
    box3.setFromObject(model);
    const center = box3.getCenter(new THREE.Vector3());
    model.position.x -= center.x;
    model.position.z -= center.z;
    model.position.y -= box3.min.y;
    model.rotation.y = -0.3; // turned a little toward the text on its left
    model.traverse((o) => {
      if (o.isMesh || o.isSkinnedMesh) {
        o.frustumCulled = false; // skinned meshes can be culled wrongly while animating
        (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => { if (m?.map) m.map.colorSpace = THREE.SRGBColorSpace; });
      }
    });
    scene.add(model);

    // ---- lights: soft key, cyan rim from behind, warm fill ----
    scene.add(new THREE.HemisphereLight(0xcfefff, 0x0a1220, 1.6));
    const key = new THREE.DirectionalLight(0xffffff, 2.4);
    key.position.set(-2, 3, 4);
    const rim = new THREE.DirectionalLight(0x00e5ff, 2.2);
    rim.position.set(3, 2, -3);
    const fill = new THREE.DirectionalLight(0xff6b2c, 0.5);
    fill.position.set(3, 0.5, 2);
    scene.add(key, rim, fill);

    // ---- animation: the greeting clip, looped with a pause (still pose when motion is reduced) ----
    if (fbx.animations?.length) {
      mixer = new THREE.AnimationMixer(model);
      const action = mixer.clipAction(fbx.animations[0]);
      action.play();
      if (reduced) {
        action.time = fbx.animations[0].duration * 0.45;
        mixer.update(0);
        action.paused = true;
      }
    }

    // ---- sizing ----
    const resize = () => {
      const w = box.clientWidth || 300;
      const h = box.clientHeight || 400;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      const dist = (HEIGHT / 2 / Math.tan((camera.fov * Math.PI) / 360)) * 1.18;
      camera.position.set(0, HEIGHT * 0.52, dist);
      camera.lookAt(0, HEIGHT * 0.5, 0);
      camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(box);
    cleanups.push(() => ro.disconnect());

    // render only while the hero is on screen and the tab is visible
    io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; }, { threshold: 0 });
    io.observe(box);
    const clock = new THREE.Clock();
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const dt = Math.min(clock.getDelta(), 0.1);
      if (!visible || document.hidden) return;
      if (mixer && !reduced) mixer.update(dt);
      renderer.render(scene, camera);
    };
    if (reduced) renderer.render(scene, camera);
    loop();
    box.classList.add('is-ready');
  })().catch(fail);

  return {
    destroy() {
      disposed = true;
      cancelAnimationFrame(raf);
      io?.disconnect();
      cleanups.forEach((fn) => fn());
      mixer?.stopAllAction();
      model?.traverse((o) => {
        o.geometry?.dispose();
        (Array.isArray(o.material) ? o.material : o.material ? [o.material] : []).forEach((m) => {
          for (const key of Object.keys(m)) if (m[key]?.isTexture) m[key].dispose();
          m.dispose();
        });
      });
      renderer?.dispose();
      box.remove();
    },
  };
}
