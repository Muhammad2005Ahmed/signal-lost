// EDUCATION ROOM (Archive): a zero-gravity tunnel of floating holographic data logs from
// data/education.json, laid out as a timeline along a gentle helix. Locked until the ASTEROIDS
// mini-game is won. Scroll / drag / arrow keys fly the camera from log to log; click a log to open it.
// Contract: exports { init, enter, exit, update }.

import * as THREE from 'three';
import { gsap } from 'gsap';
import { on } from '../core/events.js';
import { getState } from '../core/state.js';
import { disposeObject } from '../core/scene.js';
import { openModal, closeModal } from '../ui/modal.js';
import { startAsteroids } from '../games/asteroids.js';
import logsData from '@data/education.json';

// ---------- constants ----------
const CARD_W = 3.0;
const CARD_H = 1.875; // 512x320 texture ratio
const SPACING = 4.2; // distance between logs along the tunnel
const CENTER_Y = 1.6;
const TUNNEL_R = 5.4;

const C_CYAN = new THREE.Color(0x00e5ff);
const C_ORANGE = new THREE.Color(0xff6b2c);
const _c = new THREE.Color();
const _v = new THREE.Vector3();

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const rad = (d) => (d * Math.PI) / 180;
/** Data placeholders written as "[MISSING ...]" count as empty. */
const real = (v) => (typeof v === 'string' && !v.startsWith('[MISSING') ? v : '');
/** Inline placeholders (inside a longer line) become readable text. */
const clean = (s) => String(s || '').replace(/\[MISSING[^\]]*\]/g, 'not added yet');
const nn = (i) => String(i + 1).padStart(2, '0');
const TYPE_LABEL = { education: 'EDUCATION', course: 'COURSE', experience: 'EXPERIENCE' };

const reduced = () => !!ctx?.reducedMotion;

// ---------- shaders ----------
const CARD_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

// Holographic log: scanlines, flicker, glowing border, brighter on hover
const CARD_FRAG = /* glsl */ `
varying vec2 vUv;
uniform sampler2D uMap;
uniform float uTime;
uniform float uHover;
uniform float uAlpha;
uniform vec3 uTint;
void main() {
  vec4 t = texture2D(uMap, vUv);
  float scan = 0.93 + 0.07 * sin(vUv.y * 220.0 - uTime * 2.0);
  float flick = 0.97 + 0.03 * sin(uTime * 31.0 + vUv.y * 3.0);
  vec2 e = min(vUv, 1.0 - vUv);
  float edge = 1.0 - smoothstep(0.0, 0.02, min(e.x, e.y));
  vec3 col = t.rgb * scan * flick * (1.0 + 0.45 * uHover) + uTint * edge * (0.6 + 0.9 * uHover);
  float a = max(t.a, edge * 0.9) * uAlpha;
  gl_FragColor = vec4(col, a);
}`;

// ---------- card texture (512x320) ----------
function wrap(g, text, maxW, maxLines) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (g.measureText(test).width > maxW && line) {
      lines.push(line);
      line = w;
    } else line = test;
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    let last = lines[maxLines - 1];
    while (last.length > 1 && g.measureText(`${last}...`).width > maxW) last = last.slice(0, -1);
    lines[maxLines - 1] = `${last}...`;
  }
  return lines;
}

/** mode: 'locked' | 'new' | 'viewed' */
function drawCard(card, mode) {
  const g = card.g;
  const log = card.log;
  const accent = card.empty ? '#FF6B2C' : '#00E5FF';
  g.clearRect(0, 0, 512, 320);
  g.fillStyle = 'rgba(4,14,24,0.92)';
  g.fillRect(0, 0, 512, 320);
  g.globalAlpha = 0.5;
  g.strokeStyle = accent;
  g.lineWidth = 2;
  g.strokeRect(10, 10, 492, 300);
  g.globalAlpha = 1;
  g.textBaseline = 'top';
  g.textAlign = 'left';

  if (mode === 'locked') {
    g.fillStyle = '#FF6B2C';
    g.font = '16px "Share Tech Mono", monospace';
    g.fillText(`LOG ${nn(card.index)} // ENCRYPTED`, 28, 24);
    g.font = '700 32px Orbitron, sans-serif';
    g.fillText('ACCESS DENIED', 28, 120);
    g.fillStyle = '#6f8c97';
    g.font = '17px "Share Tech Mono", monospace';
    g.fillText('Clear the debris field to decrypt.', 28, 176);
  } else {
    g.fillStyle = accent;
    g.font = '16px "Share Tech Mono", monospace';
    g.fillText(`LOG ${nn(card.index)} // ${TYPE_LABEL[log.type] || 'RECORD'}`, 28, 24);
    g.textAlign = 'right';
    g.fillStyle = card.empty ? '#FF6B2C' : '#9fc3cf';
    g.fillText(card.period || 'DATE NOT ADDED', 484, 24);
    g.textAlign = 'left';

    g.fillStyle = '#ffffff';
    g.font = '700 25px Orbitron, sans-serif';
    const titleLines = wrap(g, log.title, 456, 3);
    titleLines.forEach((l, i) => g.fillText(l, 28, 56 + i * 32));

    g.fillStyle = accent;
    g.font = '17px "Share Tech Mono", monospace';
    const instY = 56 + titleLines.length * 32 + 6;
    g.fillText(card.institution || 'INSTITUTION NOT ADDED', 28, instY);

    g.fillStyle = '#9fc3cf';
    g.font = '16px "Share Tech Mono", monospace';
    const descY = instY + 28;
    const maxLines = Math.max(1, Math.floor((276 - descY) / 20));
    wrap(g, card.summary, 456, maxLines).forEach((l, i) => g.fillText(l, 28, descY + i * 20));

    g.fillStyle = mode === 'viewed' ? '#00E5FF' : '#6f8c97';
    g.font = '14px "Share Tech Mono", monospace';
    g.fillText(mode === 'viewed' ? 'VIEWED' : 'CLICK TO OPEN', 28, 288);
  }
  card.tex.needsUpdate = true;
}

// ---------- builders ----------
function buildCard(log, index) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 320;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const empty = log.type === 'experience' && !real(log.description) && !(log.details || []).length;
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: tex },
      uTime: { value: 0 },
      uHover: { value: 0 },
      uAlpha: { value: 0 },
      uTint: { value: (empty ? C_ORANGE : C_CYAN).clone() },
    },
    vertexShader: CARD_VERT,
    fragmentShader: CARD_FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(CARD_W, CARD_H), mat);
  const tilt = new THREE.Group(); // pointer tilt and bobbing happen here, so the base placement stays clean
  tilt.add(mesh);
  const group = new THREE.Group();
  group.add(tilt);
  const institution = real(log.institution);
  const description = real(log.description);
  return {
    log, index, empty, id: `log:${log.id}`,
    period: real(log.period),
    institution,
    summary: description || 'Nothing added to this log yet.',
    canvas, g: canvas.getContext('2d'), tex, mat, mesh, tilt, group,
    pos: new THREE.Vector3(), base: 0,
    hoverK: 0, reveal: 0, viewed: false,
  };
}

/** Floating dust and a few drifting wireframe rocks: the "zero gravity" feel. */
function buildAmbient(root, length, mobile) {
  const n = mobile ? 220 : 520;
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    pos[i * 3] = (Math.random() - 0.5) * 22;
    pos[i * 3 + 1] = CENTER_Y + (Math.random() - 0.5) * 12;
    pos[i * 3 + 2] = 6 - Math.random() * (length + 14);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const dustMat = new THREE.PointsMaterial({ color: 0x7fe9ff, size: 0.05, transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending });
  const dust = new THREE.Points(geo, dustMat);
  dust.userData.noPick = true;

  const rocks = new THREE.Group();
  rocks.userData.noPick = true;
  const rockGeo = new THREE.IcosahedronGeometry(0.5, 0);
  const rockMat = new THREE.MeshBasicMaterial({ color: C_ORANGE.clone().multiplyScalar(0.8), wireframe: true, transparent: true, opacity: 0.35 });
  const count = mobile ? 5 : 10;
  const spins = [];
  for (let i = 0; i < count; i++) {
    const m = new THREE.Mesh(rockGeo, rockMat);
    const side = i % 2 ? 1 : -1;
    m.position.set(side * (5.5 + Math.random() * 4), CENTER_Y + (Math.random() - 0.5) * 7, 2 - Math.random() * (length + 8));
    m.scale.setScalar(0.5 + Math.random() * 1.6);
    m.rotation.set(Math.random() * 6, Math.random() * 6, 0);
    spins.push({ m, x: (Math.random() - 0.5) * 0.4, y: (Math.random() - 0.5) * 0.4 });
    rocks.add(m);
  }

  // Tunnel rings give depth while flying
  const ringPts = [];
  for (let i = 0; i <= 64; i++) ringPts.push(new THREE.Vector3(Math.cos((i / 64) * Math.PI * 2) * TUNNEL_R, Math.sin((i / 64) * Math.PI * 2) * TUNNEL_R, 0));
  const ringGeo = new THREE.BufferGeometry().setFromPoints(ringPts);
  const ringMat = new THREE.LineBasicMaterial({ color: C_CYAN, transparent: true, opacity: 0.1 });
  const rings = new THREE.Group();
  rings.userData.noPick = true;
  for (let z = 4; z > -(length + 12); z -= 6) {
    const r = new THREE.Line(ringGeo, ringMat);
    r.position.set(0, CENTER_Y, z);
    rings.add(r);
  }
  root.add(dust, rocks, rings);
  return { dust, spins, ringMat, dustMat };
}

/** Repair console: the clickable object that starts the asteroids game while the archive is dark. */
function buildConsole(root) {
  const group = new THREE.Group();
  group.position.set(0, 0.8, -3.4); // raised so it sits in the middle of the view
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(2.0, 1.1, 0.7),
    new THREE.MeshStandardMaterial({ color: 0x4a5f80, roughness: 0.5, metalness: 0.7 })
  );
  body.position.y = 0.55;

  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 128;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(1.7, 0.8), new THREE.MeshBasicMaterial({ map: tex }));
  screen.position.set(0, 0.62, 0.36);
  screen.rotation.x = -0.25;

  const ledMat = new THREE.MeshBasicMaterial({ color: C_ORANGE });
  const ledGeo = new THREE.BoxGeometry(0.16, 0.06, 0.04);
  [-0.5, 0, 0.5].forEach((x) => {
    const led = new THREE.Mesh(ledGeo, ledMat);
    led.position.set(x, 0.12, 0.36);
    group.add(led);
  });
  const light = new THREE.PointLight(C_ORANGE, 40, 10, 2);
  light.position.set(0, 2, 1);
  group.add(body, screen, light);
  root.add(group);

  const g = canvas.getContext('2d');
  const draw = (online) => {
    g.fillStyle = '#04121a';
    g.fillRect(0, 0, 256, 128);
    g.fillStyle = online ? '#00E5FF' : '#FF6B2C';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = '700 22px Orbitron, sans-serif';
    g.fillText(online ? 'POWER STABLE' : 'ARCHIVE OFFLINE', 128, 44);
    g.font = '16px "Share Tech Mono", monospace';
    g.fillText(online ? 'LOGS DECRYPTED' : 'CLICK TO CLEAR DEBRIS', 128, 86);
    tex.needsUpdate = true;
  };
  draw(false);
  return { group, ledMat, light, draw };
}

// ---------- runtime state ----------
let scene = null;
let ctx = null;
let H = null; // per-visit state; null while the room is not active

/** Place logs along the helix; rebuild the tethers that join them to the timeline spine. */
function layout() {
  H.cards.forEach((c, i) => {
    const side = i % 2 ? 1 : -1;
    const x = side * H.xAmp * (0.55 + 0.45 * Math.sin(i * 1.7));
    const y = CENTER_Y + Math.cos(i * 1.3) * 0.7;
    c.base = i * SPACING;
    c.pos.set(x, y, -i * SPACING - H.dist);
    c.group.position.copy(c.pos);
    c.group.rotation.set(0, -Math.atan2(x, H.dist) * 0.7, 0); // turn gently toward the flight path
  });

  if (H.tether) {
    H.root.remove(H.tether);
    disposeObject(H.tether);
  }
  const g = new THREE.Group();
  g.userData.noPick = true;
  const pts = [];
  H.cards.forEach((c) => pts.push(new THREE.Vector3(0, CENTER_Y, c.pos.z), c.pos.clone()));
  const last = H.cards[H.cards.length - 1];
  const spine = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, CENTER_Y, -H.dist + 1.5), new THREE.Vector3(0, CENTER_Y, last.pos.z - 2)]);
  g.add(new THREE.Line(spine, H.tetherMat));
  g.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), H.tetherMat));
  const nodeGeo = new THREE.SphereGeometry(0.07, 10, 8);
  H.cards.forEach((c) => {
    const n = new THREE.Mesh(nodeGeo, H.nodeMat);
    n.position.set(0, CENTER_Y, c.pos.z);
    g.add(n);
  });
  H.tether = g;
  H.root.add(g);
  H.maxScroll = (H.cards.length - 1) * SPACING;
  H.scroll.target = clamp(H.scroll.target, 0, H.maxScroll);
}

function fitCamera() {
  if (!H) return;
  const aspect = window.innerWidth / window.innerHeight;
  const fov = 60;
  H.cam.fov = fov;
  H.dist = clamp(3.6 / (Math.tan(rad(fov / 2)) * Math.min(aspect, 1.2)), 5.2, 9.5);
  H.xAmp = clamp(aspect * 1.4, 0.3, 2.4); // logs stay on screen in portrait
  ctx.camera.fov = fov;
  ctx.camera.updateProjectionMatrix();
  layout();
}

function nearestIndex() {
  return clamp(Math.round(H.scroll.v / SPACING), 0, H.cards.length - 1);
}

/** Fly to a log. */
function goTo(i) {
  H.scroll.target = clamp(i, 0, H.cards.length - 1) * SPACING;
  H.idle = 0;
}

// ---------- viewing logs ----------
function openLog(card) {
  const log = card.log;
  const keyboardUser = document.activeElement?.classList?.contains('a11y-proxy');
  ctx.audio.play('click');
  ctx.input.setEnabled(false); // the modal owns input until it closes
  const meta = [];
  if (!card.empty) {
    meta.push({ label: log.type === 'experience' ? 'COMPANY' : 'INSTITUTION', value: card.institution || 'Not added yet' });
    meta.push({ label: 'DURATION', value: card.period || 'Not added yet' });
  }
  openModal({
    kicker: `ARCHIVE LOG ${nn(card.index)} OF ${nn(H.cards.length - 1)} // ${TYPE_LABEL[log.type] || 'RECORD'}`,
    title: log.title,
    description: card.empty ? 'No work experience has been added to the archive yet.' : clean(log.description),
    meta,
    detailsTitle: log.details?.length ? 'Details' : undefined,
    details: (log.details || []).map(clean),
    onClose: () => {
      if (!H) return;
      ctx.input.setEnabled(true);
      if (keyboardUser) ctx.input.focus(card.id); // keyboard users return to the log they opened
    },
  });
  if (!card.viewed) {
    card.viewed = true;
    drawCard(card, 'viewed');
  }
}

function onCard(card) {
  if (!H || !H.unlocked) return;
  // A log far down the tunnel first flies into view; a second click opens it
  if (Math.abs(card.base - H.scroll.v) > SPACING * 0.45) {
    ctx.audio.play('tick');
    goTo(card.index);
  } else openLog(card);
}

// ---------- locked state and the asteroids game ----------
async function repair() {
  if (!H || H.unlocked || H.gameOpen) return;
  H.gameOpen = true;
  ctx.input.setEnabled(false);
  const won = await startAsteroids({ room: 'education' }); // emits game:win, room:power, xp:add itself
  if (!H) return;
  H.gameOpen = false;
  ctx.input.setEnabled(true);
  if (!won && !H.unlocked) ctx.input.toast('Archive still offline. Try again when ready.');
}

function onConsole() {
  if (!H) return;
  if (H.unlocked) ctx.input.toast('POWER STABLE. The archive is online.');
  else repair();
}

function updateHint() {
  const i = nearestIndex();
  H.hint.textContent = `LOG ${nn(i)} OF ${nn(H.cards.length - 1)}  |  SCROLL, DRAG OR USE ARROW KEYS`;
}

/** Decrypt the logs: each flickers in one after another. */
function unlock(animate = true, quiet = false) {
  if (H.unlocked) return;
  H.unlocked = true;
  H.console.draw(true);
  H.console.group.visible = false; // the console has done its job: keep the view clear
  ctx.input.setActive('console', false);
  H.hint.hidden = false;
  updateHint();
  H.cards.forEach((c, i) => {
    drawCard(c, c.viewed ? 'viewed' : 'new');
    ctx.input.setActive(c.id, true);
    if (animate && !reduced()) {
      c.reveal = 0;
      H.gctx.add(() => {
        const tl = gsap.timeline({ delay: 0.3 + Math.min(i, 5) * 0.14 });
        for (const [v, d] of [[1, 0.05], [0.1, 0.06], [0.9, 0.05], [0.2, 0.05], [1, 0.2]]) tl.to(c, { reveal: v, duration: d, ease: 'none' });
      });
    } else c.reveal = 1;
  });
  if (!quiet) ctx.input.toast('ARCHIVE ONLINE: data logs decrypted. Scroll to travel the timeline.', 4000);
}

// ---------- room contract ----------
export function init(sceneArg, ctxArg) {
  scene = sceneArg;
  ctx = ctxArg;
}

export function enter() {
  const state = getState();
  const root = new THREE.Group();
  scene.add(root);
  const length = Math.max(0, logsData.length - 1) * SPACING;
  const ambient = buildAmbient(root, length, ctx.isMobile);
  const consoleObj = buildConsole(root);
  root.add(new THREE.HemisphereLight(0x6a8ab0, 0x0b0f1a, 3));

  const cards = logsData.map((log, i) => {
    const c = buildCard(log, i);
    root.add(c.group);
    drawCard(c, 'locked');
    return c;
  });

  const hint = document.createElement('p');
  hint.className = 'timeline-hint';
  hint.hidden = true;
  document.body.appendChild(hint);

  H = {
    root, ambient, console: consoleObj, cards, hint,
    tetherMat: new THREE.LineBasicMaterial({ color: C_CYAN, transparent: true, opacity: 0.2 }),
    nodeMat: new THREE.MeshBasicMaterial({ color: C_CYAN.clone().multiplyScalar(1.6) }),
    tether: null,
    gctx: gsap.context(() => {}),
    offs: [],
    unlocked: false, gameOpen: false,
    dist: 6, xAmp: 2, maxScroll: 0, idle: 0, dragging: false, lastIdx: -1,
    scroll: { v: 0, target: 0 },
    ptr: { x: 0, y: 0 }, px: 0, py: 0, cur: { x: 0, y: 0 },
    cam: { fov: 60 },
    powerK: 0.2,
  };
  fitCamera(); // also lays the logs out
  ctx.stage.setBloom({ strength: 0.85, radius: 0.55, threshold: 0.85 });

  // Interactive objects, in logical Tab order: the console first, then the logs
  const input = ctx.input;
  input.setEnabled(true);
  input.register(consoleObj.group, {
    id: 'console',
    label: () => (H.unlocked ? 'ARCHIVE CONSOLE: power stable' : 'ARCHIVE CONSOLE: click to clear the debris field'),
    onClick: onConsole,
  });
  for (const c of cards) {
    input.register(c.group, {
      id: c.id,
      label: () => (H.unlocked ? `${c.log.title} [${c.viewed ? 'VIEWED' : 'NEW'}]` : `LOG ${nn(c.index)}: ENCRYPTED`),
      onClick: () => onCard(c),
      // Tabbing to a log flies the camera to it (mouse hover does not move the camera)
      onHover: (e, over) => {
        if (over && H?.unlocked && document.activeElement?.classList?.contains('a11y-proxy')) goTo(c.index);
      },
    });
    input.setActive(c.id, false);
  }

  // Pointer parallax, wheel / drag / keyboard travel
  const canvas = ctx.renderer.domElement;
  const overlayOpen = () => !!document.querySelector('.modal-backdrop, .game-overlay');
  let dragY = null;
  const onMove = (e) => {
    H.ptr.x = (e.clientX / window.innerWidth) * 2 - 1;
    H.ptr.y = -((e.clientY / window.innerHeight) * 2 - 1);
    if (!reduced()) {
      H.px = H.ptr.x;
      H.py = -H.ptr.y;
    }
  };
  const onWheel = (e) => {
    if (!H.unlocked || overlayOpen()) return;
    H.scroll.target = clamp(H.scroll.target + e.deltaY * 0.012, 0, H.maxScroll);
    H.idle = 0;
  };
  const onDown = (e) => { if (H.unlocked) dragY = e.clientY; };
  const onDrag = (e) => {
    if (dragY === null) return;
    const perPx = SPACING / (window.innerHeight * 0.4); // a 40%-of-screen swipe moves one log
    H.scroll.target = clamp(H.scroll.target + (dragY - e.clientY) * perPx, 0, H.maxScroll);
    dragY = e.clientY;
    H.idle = 0;
  };
  const onUp = () => { dragY = null; };
  const onKey = (e) => {
    if (!H.unlocked || overlayOpen() || e.altKey || e.ctrlKey || e.metaKey) return;
    const i = nearestIndex();
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight' || e.key === 'PageDown') goTo(i + 1);
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft' || e.key === 'PageUp') goTo(i - 1);
    else if (e.key === 'Home') goTo(0);
    else if (e.key === 'End') goTo(H.cards.length - 1);
    else return;
    e.preventDefault();
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('wheel', onWheel, { passive: true });
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onDrag);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
  document.addEventListener('keydown', onKey);
  H.offs.push(
    () => window.removeEventListener('pointermove', onMove),
    () => window.removeEventListener('wheel', onWheel),
    () => canvas.removeEventListener('pointerdown', onDown),
    () => canvas.removeEventListener('pointermove', onDrag),
    () => window.removeEventListener('pointerup', onUp),
    () => window.removeEventListener('pointercancel', onUp),
    () => document.removeEventListener('keydown', onKey),
    ctx.stage.onResize(fitCamera),
    on('room:power', ({ room }) => {
      if (room === 'education' && H) unlock(true);
    })
  );

  if (state.power.education) unlock(true, true);
  else input.toast('ARCHIVE OFFLINE. Use the console to clear the debris field and restore power.', 4500);
}

export function exit() {
  if (!H) return;
  closeModal();
  H.gctx.kill();
  for (const off of H.offs) off();
  H.hint.remove();
  ctx.input.clear();
  ctx.input.setEnabled(true); // the next room starts with input on
  scene.remove(H.root);
  disposeObject(H.root);
  ctx.camera.fov = 60;
  ctx.camera.updateProjectionMatrix();
  ctx.stage.setBloom({ strength: 0.9, radius: 0.55, threshold: 0.82 });
  H = null;
}

export function update(dt, t = 0) {
  if (!H) return;
  const cam = ctx.camera;
  const input = ctx.input;
  const tt = reduced() ? 0 : t; // freeze animation for reduced motion
  const k = 1 - Math.exp(-dt * 8);

  // Travel: ease toward the target, then snap to the nearest log shortly after the player stops
  H.idle += dt;
  if (H.unlocked && H.idle > 0.5) {
    const snap = Math.round(H.scroll.target / SPACING) * SPACING;
    H.scroll.target += (snap - H.scroll.target) * Math.min(1, dt * 4);
  }
  H.scroll.v += (H.scroll.target - H.scroll.v) * (1 - Math.exp(-dt * (reduced() ? 14 : 5)));
  const near = nearestIndex();
  if (near !== H.lastIdx) {
    H.lastIdx = near;
    if (H.unlocked) updateHint();
  }

  // Ambient glow ramps up when power returns
  H.powerK += ((H.unlocked ? 1 : 0.2) - H.powerK) * Math.min(1, dt * 2);
  H.tetherMat.opacity = 0.12 + 0.3 * H.powerK;
  H.ambient.ringMat.opacity = 0.05 + 0.1 * H.powerK;
  if (!reduced()) {
    H.ambient.dust.position.y = Math.sin(tt * 0.12) * 0.3;
    H.ambient.dust.rotation.z = tt * 0.01;
    for (const s of H.ambient.spins) {
      s.m.rotation.x += s.x * dt;
      s.m.rotation.y += s.y * dt;
    }
  }

  // Logs: fade by distance along the tunnel, hover glow, bobbing, pointer tilt
  H.cards.forEach((c, i) => {
    const rel = c.base - H.scroll.v; // 0 = focused, positive = still ahead, negative = passed
    const passed = rel < -SPACING * 0.2 ? clamp(1 + (rel + SPACING * 0.2) / (SPACING * 0.8), 0, 1) : 1;
    const far = 1 - 0.86 * clamp(rel / (SPACING * 3.5), 0, 1);
    const hov = input.isHovered(c.id) ? 1 : 0;
    const focus = Math.abs(rel) < SPACING * 0.4 ? 0.3 : 0;
    c.hoverK += (Math.max(hov, focus) - c.hoverK) * Math.min(1, dt * 10);
    const u = c.mat.uniforms;
    u.uTime.value = tt;
    u.uHover.value = c.hoverK;
    u.uAlpha.value = H.unlocked ? c.reveal * passed * far : 0.35 * passed * far;
    c.group.visible = u.uAlpha.value > 0.005;

    let ry = 0;
    let rx = 0;
    if (!reduced()) {
      if (hov) {
        c.group.getWorldPosition(_v).project(cam);
        ry = clamp((H.ptr.x - _v.x) * 0.5, -0.4, 0.4);
        rx = clamp(-(H.ptr.y - _v.y) * 0.35, -0.3, 0.3);
      } else {
        ry = Math.sin(tt * 0.5 + i) * 0.05;
      }
      // Zero-g drift: slow bobbing on all axes
      c.tilt.position.set(Math.sin(tt * 0.45 + i * 2.1) * 0.08, Math.sin(tt * 0.8 + i * 1.3) * 0.1, Math.sin(tt * 0.6 + i) * 0.06);
      c.tilt.rotation.z = Math.sin(tt * 0.6 + i * 1.7) * 0.025;
    }
    c.tilt.rotation.y += (ry - c.tilt.rotation.y) * k;
    c.tilt.rotation.x += (rx - c.tilt.rotation.x) * k;
    c.tilt.scale.setScalar((0.9 + 0.1 * c.reveal) * (1 + 0.06 * c.hoverK));
  });

  // Console: blinks orange while the archive is dark, steady cyan once repaired
  _c.copy(H.unlocked ? C_CYAN : C_ORANGE);
  H.console.ledMat.color.copy(_c).multiplyScalar(H.unlocked ? 1.6 : Math.sin(tt * 4) > 0 ? 1.8 : 0.3);
  H.console.light.color.copy(_c);

  // Camera flies along the helix: it follows the logs' sideways drift a little, plus pointer parallax
  H.cur.x += (H.px - H.cur.x) * k;
  H.cur.y += (H.py - H.cur.y) * k;
  const u = clamp(H.scroll.v / SPACING, 0, H.cards.length - 1);
  const i0 = Math.floor(u);
  const i1 = Math.min(H.cards.length - 1, i0 + 1);
  const f = u - i0;
  const fx = lerp(H.cards[i0].pos.x, H.cards[i1].pos.x, f);
  const fy = lerp(H.cards[i0].pos.y, H.cards[i1].pos.y, f);
  const camZ = -H.scroll.v;
  cam.position.set(fx * 0.4 + H.cur.x * 0.4, CENTER_Y + (fy - CENTER_Y) * 0.4 - H.cur.y * 0.2, camZ);
  cam.lookAt(fx * 0.6 + H.cur.x * 0.6, fy * 0.7 + CENTER_Y * 0.3, camZ - H.dist - 2);
}
