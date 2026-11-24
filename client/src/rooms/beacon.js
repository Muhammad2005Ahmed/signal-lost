// BEACON ROOM (Comms Tower = contact). A wireframe radio tower with a dish aimed at Earth.
// Locked until state.beaconUnlocked (set when the player traces the rogue signal with A.R.I.A).
// Unlocked: the tower glows cyan, the dish pulses signal rings, and the contact form
// "SEND DISTRESS SIGNAL TO EARTH" (ui/contactForm.js) sits beside it. A successful send fires a
// 3D beam from the dish to Earth. Everything built in enter() is disposed in exit().
// Contract: exports { init, enter, exit, update }.

import * as THREE from 'three';
import { gsap } from 'gsap';
import { getState, subscribe, getPowerPercent } from '../core/state.js';
import { disposeObject } from '../core/scene.js';
import { createContactForm } from '../ui/contactForm.js';
import '../styles/beacon.css';

// ---------- constants ----------
const C_CYAN = new THREE.Color(0x00e5ff);
const C_ORANGE = new THREE.Color(0xff6b2c);
const _c = new THREE.Color();
const UP = new THREE.Vector3(0, 1, 0);
const TOWER_H = 9;
const DISH_Y = 9.5;
const FEED_LEN = 0.85;
const EARTH_POS = new THREE.Vector3(-5, 10.5, -18);
const EARTH_R = 2.4;
const BASE_BLOOM = { strength: 0.9, radius: 0.55, threshold: 0.82 };

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const reduced = () => !!ctx?.reducedMotion;

let scene = null;
let ctx = null;
let H = null; // per-visit state; null while the room is not active

// ---------- builders ----------
function buildStars(root) {
  const n = 700;
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const r = 70 + Math.random() * 20;
    const th = Math.random() * Math.PI * 2;
    const ph = Math.acos(2 * Math.random() - 1);
    pos[i * 3] = r * Math.sin(ph) * Math.cos(th);
    pos[i * 3 + 1] = Math.abs(r * Math.cos(ph)) * 0.8 + 2; // upper hemisphere only
    pos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th) - 20;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const stars = new THREE.Points(g, new THREE.PointsMaterial({ color: 0xbfefff, size: 0.45, sizeAttenuation: true, transparent: true, opacity: 0.85, depthWrite: false }));
  root.add(stars);
  return stars;
}

function buildGround(root) {
  const group = new THREE.Group();
  const disc = new THREE.Mesh(new THREE.CircleGeometry(11, 56), new THREE.MeshStandardMaterial({ color: 0x0a1220, roughness: 0.92, metalness: 0.2 }));
  disc.rotation.x = -Math.PI / 2;
  const grid = new THREE.GridHelper(22, 22, 0x0b6a78, 0x0a3340);
  grid.position.y = 0.02;
  const rim = new THREE.Mesh(new THREE.RingGeometry(10.6, 11, 72), new THREE.MeshBasicMaterial({ color: C_CYAN, transparent: true, opacity: 0.35, side: THREE.DoubleSide }));
  rim.rotation.x = -Math.PI / 2;
  rim.position.y = 0.03;
  const pad = new THREE.Mesh(new THREE.CylinderGeometry(2.1, 2.4, 0.3, 6), new THREE.MeshStandardMaterial({ color: 0x0f1826, roughness: 0.55, metalness: 0.6 }));
  pad.position.y = 0.15;
  group.add(disc, grid, rim, pad);
  root.add(group);
  return group;
}

/** Lattice tower: four tapered legs, square rings and X bracing, drawn as line segments. */
function buildTower(root) {
  const levels = 6;
  const base = 1.3;
  const top = 0.4;
  const pts = [];
  const at = (lvl, i) => {
    const y = (lvl / levels) * TOWER_H + 0.3;
    const w = lerp(base, top, lvl / levels);
    const [sx, sz] = [[-1, -1], [1, -1], [1, 1], [-1, 1]][i];
    return [sx * w, y, sz * w];
  };
  for (let l = 0; l <= levels; l++) {
    for (let i = 0; i < 4; i++) {
      const a = at(l, i);
      const b = at(l, (i + 1) % 4);
      pts.push(...a, ...b); // ring
      if (l < levels) {
        const a2 = at(l + 1, i);
        const b2 = at(l + 1, (i + 1) % 4);
        pts.push(...a, ...a2); // leg
        pts.push(...a, ...b2, ...b, ...a2); // X brace on this face
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  const mat = new THREE.LineBasicMaterial({ color: C_ORANGE.clone(), transparent: true, opacity: 0.5 });
  const lines = new THREE.LineSegments(geo, mat);

  // mid platform and mast
  const deck = new THREE.Mesh(new THREE.CylinderGeometry(1.0, 1.0, 0.1, 6), new THREE.MeshStandardMaterial({ color: 0x1a2638, roughness: 0.6, metalness: 0.6 }));
  deck.position.y = 5.2;
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.1, 1.4, 8), new THREE.MeshStandardMaterial({ color: 0x9aa7b5, roughness: 0.5, metalness: 0.5 }));
  mast.position.y = TOWER_H + 0.75;

  // warning lamp on top
  const lampMat = new THREE.MeshBasicMaterial({ color: C_ORANGE.clone() });
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.14, 12, 10), lampMat);
  lamp.position.y = TOWER_H + 1.55;

  const group = new THREE.Group();
  group.add(lines, deck, mast, lamp);
  root.add(group);
  return { group, mat, lampMat };
}

/** Parabolic dish whose +Y axis points at Earth. Returns the group and the feed tip in root space. */
function buildDish(root) {
  const group = new THREE.Group();
  group.position.set(0, DISH_Y, 0);
  const R = 1.25;
  const bowlGeo = new THREE.SphereGeometry(R, 32, 14, 0, Math.PI * 2, Math.PI * 0.68, Math.PI * 0.32); // cap around the bottom pole
  bowlGeo.translate(0, R, 0); // pole at the origin, the bowl opens upwards (+Y)
  const bowl = new THREE.Mesh(bowlGeo, new THREE.MeshStandardMaterial({ color: 0xcfd8e3, roughness: 0.4, metalness: 0.55, side: THREE.DoubleSide }));
  const strut = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, FEED_LEN, 6), new THREE.MeshStandardMaterial({ color: 0x9aa7b5 }));
  strut.position.y = FEED_LEN / 2;
  const feedMat = new THREE.MeshBasicMaterial({ color: C_ORANGE.clone() });
  const feed = new THREE.Mesh(new THREE.SphereGeometry(0.09, 12, 10), feedMat);
  feed.position.y = FEED_LEN;
  const hit = new THREE.Mesh(new THREE.SphereGeometry(1.5, 8, 6), new THREE.MeshBasicMaterial({ visible: false }));
  hit.position.y = 0.5;
  group.add(bowl, strut, feed, hit);

  // aim the dish axis (+Y) at Earth
  const dir = EARTH_POS.clone().sub(group.position).normalize();
  group.quaternion.setFromUnitVectors(UP, dir);

  // three signal rings that expand along the dish axis
  const rings = [];
  for (let i = 0; i < 3; i++) {
    const m = new THREE.MeshBasicMaterial({ color: C_CYAN, transparent: true, opacity: 0, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false });
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.85, 1, 48), m);
    ring.rotation.x = -Math.PI / 2; // ring plane perpendicular to the dish axis
    ring.position.y = FEED_LEN + 0.2;
    group.add(ring);
    rings.push(ring);
  }
  root.add(group);
  const tip = group.position.clone().add(dir.clone().multiplyScalar(FEED_LEN));
  return { group, feedMat, rings, tip, dir };
}

function buildEarth(root) {
  const group = new THREE.Group();
  group.position.copy(EARTH_POS);
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x1a5fb4, emissive: 0x06224a, emissiveIntensity: 0.6, roughness: 0.85 });
  const body = new THREE.Mesh(new THREE.SphereGeometry(EARTH_R, 40, 28), bodyMat);
  const net = new THREE.Mesh(new THREE.IcosahedronGeometry(EARTH_R * 1.025, 2), new THREE.MeshBasicMaterial({ color: C_CYAN, wireframe: true, transparent: true, opacity: 0.22 }));
  const glow = new THREE.Mesh(
    new THREE.SphereGeometry(EARTH_R * 1.22, 32, 20),
    new THREE.MeshBasicMaterial({ color: 0x3aa0ff, transparent: true, opacity: 0.16, side: THREE.BackSide, blending: THREE.AdditiveBlending, depthWrite: false })
  );
  group.add(body, net, glow);
  root.add(group);
  return { group, bodyMat, spin: body };
}

/** The success beam: a thin glowing cylinder that grows from the dish to Earth, with a bright head. */
function buildBeam(root, dish) {
  const mat = new THREE.MeshBasicMaterial({ color: 0x9ff6ff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 1, 10), mat);
  mesh.visible = false;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.28, 14, 10), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
  head.visible = false;
  const to = EARTH_POS.clone().sub(dish.tip);
  const len = to.length() - EARTH_R * 1.05;
  const dir = to.normalize();
  mesh.quaternion.setFromUnitVectors(UP, dir);
  root.add(mesh, head);
  return { mesh, head, mat, len, dir, start: dish.tip.clone(), k: 0, alpha: 0 };
}

// ---------- camera: the tower sits left of the form on wide screens, above the sheet on phones ----------
function fitCamera() {
  if (!H) return;
  const cam = ctx.camera;
  const w = window.innerWidth;
  const aspect = w / window.innerHeight;
  cam.fov = 55;
  cam.aspect = aspect;
  cam.updateProjectionMatrix();
  if (w < 768) {
    // fit the whole tower into the top third of the screen
    const hh = 18.5;
    const d = hh / Math.tan(THREE.MathUtils.degToRad(cam.fov / 2));
    H.cam.base.set(0, -5.9, d);
    H.cam.look.set(0, -5.9, 0);
  } else {
    const sx = clamp(aspect * 2.1, 3, 5);
    H.cam.base.set(sx, 4.2, 15.5);
    H.cam.look.set(sx, 4.9, 0);
  }
}

// ---------- locked / unlocked ----------
function buildLockedPanel() {
  const st = getState();
  const wrap = document.createElement('div');
  wrap.className = 'beacon-locked';
  const h = document.createElement('h2');
  h.textContent = 'COMMS TOWER LOCKED';
  const p = document.createElement('p');
  p.textContent = 'A rogue signal is jamming the beacon. Trace it to open the channel to Earth.';
  const ol = document.createElement('ol');
  const items = [
    [`Restore power to all four rooms (${Math.round(getPowerPercent())}%)`, getPowerPercent() >= 100],
    ["Trace the rogue signal: ask A.R.I.A one question", st.beaconUnlocked],
  ];
  for (const [text, done] of items) {
    const li = document.createElement('li');
    li.textContent = `${done ? '[x]' : '[ ]'} ${text}`;
    if (done) li.className = 'is-done';
    ol.append(li);
  }
  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'cf__send cf__send--ghost';
  back.textContent = 'BACK TO HUB';
  back.addEventListener('click', () => ctx.goTo('hub'));
  wrap.append(h, p, ol, back);
  return wrap;
}

function mountPanel() {
  H.panel.replaceChildren();
  H.form?.destroy();
  H.form = null;
  H.panel.classList.toggle('is-locked', !H.unlocked);
  if (!H.unlocked) {
    H.panel.setAttribute('aria-label', 'Comms Tower locked');
    H.panel.append(buildLockedPanel());
    return;
  }
  H.panel.setAttribute('aria-label', 'Contact form');
  H.form = createContactForm({
    onSuccess: () => fireBeam(),
    onToast: (t) => ctx.input.toast(t, 5000),
  });
  H.panel.append(H.form.el);
}

/** Switch to the unlocked look (cyan tower, signal rings, form). */
function unlock(animate) {
  if (H.unlocked) return;
  H.unlocked = true;
  mountPanel();
  ctx.input.setActive('dish', true);
  if (animate && !reduced()) H.gctx.add(() => gsap.to(H, { power: 1, duration: 1.4, ease: 'power2.out' }));
  else H.power = 1;
  if (animate) ctx.input.toast('COMMS TOWER ONLINE. Send your signal to Earth.', 4000);
}

/** Fire the 3D beam from the dish to Earth (after a successful send). */
function fireBeam() {
  if (!H) return;
  const b = H.beam;
  const flash = () => {
    ctx.stage.setBloom({ strength: 1.6, radius: 0.7, threshold: 0.7 });
    H.gctx.add(() => {
      gsap.fromTo(H.earth.bodyMat, { emissiveIntensity: 2.4 }, { emissiveIntensity: 0.6, duration: 1.6, ease: 'power2.out' });
      gsap.delayedCall(1.8, () => ctx.stage.setBloom(BASE_BLOOM));
    });
  };
  b.mesh.visible = true;
  b.head.visible = true;
  b.mesh.material.opacity = 0.85;
  b.head.material.opacity = 1;
  if (reduced()) {
    b.k = 1;
    flash();
    H.gctx.add(() => gsap.delayedCall(2.5, () => { b.mesh.visible = false; b.head.visible = false; }));
    return;
  }
  b.k = 0;
  H.gctx.add(() => {
    gsap.timeline()
      .to(b, { k: 1, duration: 1.5, ease: 'power2.in', onComplete: flash })
      .to([b.mesh.material, b.head.material], { opacity: 0, duration: 0.9, delay: 1.1 })
      .add(() => { b.mesh.visible = false; b.head.visible = false; });
  });
}

// ---------- room contract ----------
export function init(sceneArg, ctxArg) {
  scene = sceneArg;
  ctx = ctxArg;
}

export function enter() {
  const root = new THREE.Group();
  scene.add(root);
  const stars = buildStars(root);
  const ground = buildGround(root);
  const tower = buildTower(root);
  const dish = buildDish(root);
  const earth = buildEarth(root);
  const beam = buildBeam(root, dish);
  root.add(new THREE.HemisphereLight(0x6a8ab0, 0x0b0f1a, 2.2));
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.position.set(12, 14, 10);
  root.add(sun);

  const panel = document.createElement('section');
  panel.className = 'beacon-panel';
  // Keys typed in the form must not reach game shortcuts (M = mute, ...). Escape still goes back to the hub.
  panel.addEventListener('keydown', (e) => { if (e.key !== 'Escape') e.stopPropagation(); });
  document.body.appendChild(panel);

  H = {
    root, stars, ground, tower, dish, earth, beam, panel,
    form: null,
    unlocked: false,
    power: 0, // 0 = dead orange, 1 = online cyan
    gctx: gsap.context(() => {}),
    offs: [],
    cam: { base: new THREE.Vector3(), look: new THREE.Vector3() },
    ptr: { x: 0, y: 0 }, cur: { x: 0, y: 0 },
  };
  fitCamera();
  ctx.stage.setBloom(BASE_BLOOM);

  // The dish is the only 3D object to click; the form itself is plain HTML
  const input = ctx.input;
  input.setEnabled(true);
  input.register(dish.group, {
    id: 'dish',
    label: () => (H?.unlocked ? 'COMMS DISH: aligned to Earth. Use the form to send a signal.' : 'COMMS DISH: offline'),
    onClick: () => {
      ctx.audio.play('click');
      if (H.unlocked) {
        input.toast('DISH ALIGNED TO EARTH. Fill in the form and transmit.');
        H.form?.focus();
      } else {
        input.toast('COMMS TOWER LOCKED. Trace the rogue signal first.', 3500);
      }
    },
  });
  input.setActive('dish', false);

  const onMove = (e) => {
    if (reduced()) return;
    H.ptr.x = (e.clientX / window.innerWidth) * 2 - 1;
    H.ptr.y = (e.clientY / window.innerHeight) * 2 - 1;
  };
  window.addEventListener('pointermove', onMove);
  H.offs.push(
    () => window.removeEventListener('pointermove', onMove),
    ctx.stage.onResize(fitCamera),
    // If the beacon unlocks while the player is standing here, switch on live
    subscribe((s) => { if (H && !H.unlocked && s.beaconUnlocked) unlock(true); })
  );

  if (getState().beaconUnlocked) unlock(false);
  else {
    mountPanel();
    input.toast('COMMS TOWER LOCKED. Trace the rogue signal to open the channel.', 4500);
  }
}

export function exit() {
  if (!H) return;
  H.gctx.kill();
  for (const off of H.offs) off();
  H.form?.destroy();
  H.panel.remove();
  ctx.input.clear();
  ctx.input.setEnabled(true); // the next room starts with input on
  scene.remove(H.root);
  disposeObject(H.root);
  ctx.camera.fov = 60;
  ctx.camera.updateProjectionMatrix();
  ctx.stage.setBloom(BASE_BLOOM);
  H = null;
}

export function update(dt, t = 0) {
  if (!H) return;
  const tt = reduced() ? 0 : t;
  const p = H.power;

  // tower colour: dead orange -> online cyan
  _c.copy(C_ORANGE).lerp(C_CYAN, p);
  H.tower.mat.color.copy(_c);
  H.tower.mat.opacity = 0.5 + 0.45 * p;
  H.dish.feedMat.color.copy(_c).multiplyScalar(1.4);
  const blink = H.unlocked ? 0.75 + 0.25 * Math.sin(tt * 3) : Math.sin(tt * 2) > 0.2 ? 1 : 0.12; // locked: slow warning blink
  H.tower.lampMat.color.copy(_c).multiplyScalar(blink * 1.5);

  // signal rings from the dish (only while online)
  H.dish.rings.forEach((ring, i) => {
    const ph = reduced() ? i / 3 : (tt * 0.45 + i / 3) % 1;
    ring.scale.setScalar(1 + ph * 5);
    ring.material.opacity = p * (1 - ph) * 0.55;
  });

  // Earth and stars drift slowly
  if (!reduced()) {
    H.earth.spin.rotation.y += dt * 0.06;
    H.stars.rotation.y += dt * 0.004;
  }

  // beam: grows from the dish towards Earth
  const b = H.beam;
  if (b.mesh.visible) {
    const len = Math.max(0.001, b.len * b.k);
    b.mesh.scale.set(1, len, 1);
    b.mesh.position.copy(b.start).addScaledVector(b.dir, len / 2);
    b.head.position.copy(b.start).addScaledVector(b.dir, len);
    b.head.scale.setScalar(1 + 0.25 * Math.sin(tt * 30));
  }

  // camera: fixed shot with a little pointer parallax
  H.cur.x += (H.ptr.x - H.cur.x) * Math.min(1, dt * 3);
  H.cur.y += (H.ptr.y - H.cur.y) * Math.min(1, dt * 3);
  const cam = ctx.camera;
  cam.position.set(H.cam.base.x + H.cur.x * 0.7, H.cam.base.y - H.cur.y * 0.35, H.cam.base.z);
  cam.lookAt(H.cam.look.x + H.cur.x * 0.3, H.cam.look.y, H.cam.look.z);
}
