// PROJECTS ROOM (Engineering Bay): a holographic corkboard wall of project cards from
// data/projects.json. Locked until the WIRES mini-game is won. Cards tilt toward the mouse,
// open a modal on click, and can be searched/filtered. Viewing every project unlocks the
// 'curious_mind' achievement. Contract: exports { init, enter, exit, update }.

import * as THREE from 'three';
import { gsap } from 'gsap';
import { emit, on } from '../core/events.js';
import { getState } from '../core/state.js';
import { disposeObject } from '../core/scene.js';
import { openModal, closeModal } from '../ui/modal.js';
import { startWires } from '../games/wires.js';
import projectsData from '@data/projects.json';

// ---------- constants ----------
const CARD_W = 3.2;
const CARD_H = 2.0; // 1024x640 texture ratio
const COL_STEP = 3.5; // distance between card centres in a row
const ROW_STEP = 2.35;
const FOV = 50;
const VIEWED_KEY = 'signal-lost-viewed-projects';

// FIT-MATH-START (pure math, no three.js: tested separately)
/** Columns, camera distance and camera height so the card grid fills the screen below the top UI. */
function computeFit(aspect, n) {
  const cols = Math.max(1, Math.min(aspect >= 1.55 ? 3 : aspect >= 0.9 ? 2 : 1, n));
  const rows = Math.ceil(n / cols);
  const t = Math.tan((FOV * Math.PI) / 360);
  const gridW = (cols - 1) * COL_STEP + CARD_W;
  const visRows = Math.min(rows, 2); // rows that must fit on screen at once
  const span = (visRows - 1) * ROW_STEP + CARD_H;
  const dW = gridW / (0.84 * 2 * t * aspect); // grid fills ~84% of the width
  const dH = span / (0.68 * 2 * t); // and at most ~68% of the height
  const dist = Math.max(5, dW, dH);
  const visH = 2 * dist * t;
  // top ~27% of the screen belongs to the HUD and search bar: push the block down into the rest
  const baseY = -((visRows - 1) * ROW_STEP) / 2 + 0.12 * visH;
  return { cols, rows, gridW, dist, baseY, maxScroll: Math.max(0, (rows - visRows) * ROW_STEP) };
}
// FIT-MATH-END

const C_CYAN = new THREE.Color(0x00e5ff);
const C_ORANGE = new THREE.Color(0xff6b2c);
const _c = new THREE.Color();
const _v = new THREE.Vector3();

const rad = (d) => (d * Math.PI) / 180;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
/** Data placeholders written as "[MISSING ...]" count as empty. */
const real = (v) => (typeof v === 'string' && !v.startsWith('[MISSING') ? v : '');

// ---------- shaders ----------
const UV_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

// Holographic card: scanlines, flicker, glowing border, brighter on hover
const CARD_FRAG = /* glsl */ `
varying vec2 vUv;
uniform sampler2D uMap;
uniform float uTime;
uniform float uHover;
uniform float uAlpha;
uniform vec3 uTint;
void main() {
  vec4 t = texture2D(uMap, vUv);
  float scan = 0.97 + 0.03 * sin(vUv.y * 90.0 - uTime * 1.5);
  float flick = 0.99 + 0.01 * sin(uTime * 31.0 + vUv.y * 3.0);
  vec2 e = min(vUv, 1.0 - vUv);
  float edge = 1.0 - smoothstep(0.0, 0.012, min(e.x, e.y));
  // text is scaled to stay under the bloom threshold, so it never smears
  vec3 col = t.rgb * 0.82 * scan * flick * (1.0 + 0.12 * uHover) + uTint * edge * (0.5 + 0.7 * uHover);
  float a = max(t.a, edge * 0.9) * uAlpha;
  gl_FragColor = vec4(col, a);
}`;

// Backdrop wall: faint moving grid
const WALL_FRAG = /* glsl */ `
varying vec2 vUv;
uniform float uTime;
uniform float uPower;
uniform vec2 uSize;
void main() {
  vec2 d = abs(fract(vUv * uSize / 0.8) - 0.5);
  float line = smoothstep(0.46, 0.5, max(d.x, d.y));
  float sweep = pow(max(0.0, sin((vUv.y * 3.0 - uTime * 0.15) * 6.2831)), 8.0);
  vec3 col = vec3(0.012, 0.028, 0.045) + vec3(0.0, 0.9, 1.0) * (line * 0.08 + sweep * 0.02) * (0.35 + 0.65 * uPower);
  float fadeX = smoothstep(0.0, 0.08, vUv.x) * smoothstep(1.0, 0.92, vUv.x);
  gl_FragColor = vec4(col * fadeX, 1.0);
}`;

// ---------- viewed-project persistence (separate from the fixed game-state shape) ----------
function loadViewed() {
  try {
    const raw = JSON.parse(localStorage.getItem(VIEWED_KEY) || '[]');
    return new Set(Array.isArray(raw) ? raw.filter((x) => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}
function saveViewed(set) {
  try { localStorage.setItem(VIEWED_KEY, JSON.stringify([...set])); } catch { /* storage blocked */ }
}

// ---------- card texture drawing (1024x640) ----------
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

/** mode: 'locked' | 'new' | 'viewed'. Canvas is 1024x640 so text stays sharp on screen. */
function drawCard(card, mode) {
  const g = card.g;
  const accent = card.secret ? '#FF6B2C' : '#00E5FF';
  const M = 48; // left margin
  g.clearRect(0, 0, 1024, 640);
  g.fillStyle = 'rgba(4,14,24,0.97)';
  g.fillRect(0, 0, 1024, 640);
  g.globalAlpha = 0.55;
  g.strokeStyle = accent;
  g.lineWidth = 4;
  g.strokeRect(16, 16, 992, 608);
  g.globalAlpha = 1;
  g.textBaseline = 'top';
  const num = String(card.index + 1).padStart(2, '0');

  if (mode === 'locked') {
    g.fillStyle = '#FF6B2C';
    g.font = '28px "Share Tech Mono", monospace';
    g.fillText(`FILE ${num} // ENCRYPTED`, M, 44);
    g.font = '700 60px Orbitron, sans-serif';
    g.fillText('ACCESS DENIED', M, 240);
    g.fillStyle = '#6f8c97';
    g.font = '32px "Share Tech Mono", monospace';
    g.fillText('Restore bay power to decrypt.', M, 340);
  } else {
    g.fillStyle = accent;
    g.font = '28px "Share Tech Mono", monospace';
    g.fillText(`FILE ${num}${card.secret ? ' // HIDDEN' : ''}`, M, 44);

    g.fillStyle = '#ffffff';
    g.font = '700 54px Orbitron, sans-serif';
    const titleLines = wrap(g, card.project.title, 928, 2);
    titleLines.forEach((l, i) => g.fillText(l, M, 92 + i * 64));

    g.fillStyle = '#b4d4de';
    g.font = '34px "Share Tech Mono", monospace';
    const descY = 92 + titleLines.length * 64 + 18;
    wrap(g, card.project.shortDescription, 928, titleLines.length === 1 ? 5 : 4).forEach((l, i) => g.fillText(l, M, descY + i * 42));

    // up to three tech chips along the bottom
    g.font = '27px "Share Tech Mono", monospace';
    let x = M;
    for (const tech of (card.project.tech || []).slice(0, 3)) {
      const w = g.measureText(tech).width + 30;
      if (x + w > 976) break;
      g.strokeStyle = accent;
      g.globalAlpha = 0.7;
      g.lineWidth = 3;
      g.strokeRect(x, 502, w, 46);
      g.globalAlpha = 1;
      g.fillStyle = accent;
      g.fillText(tech, x + 15, 511);
      x += w + 14;
    }
    g.fillStyle = mode === 'viewed' ? '#00E5FF' : '#8aa8b3';
    g.font = '26px "Share Tech Mono", monospace';
    g.fillText(mode === 'viewed' ? 'VIEWED' : 'CLICK TO OPEN', M, 574);
  }
  card.tex.needsUpdate = true;
}

// ---------- builders ----------
function buildBackdrop(root) {
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uPower: { value: 0 }, uSize: { value: new THREE.Vector2(10, 6) } },
    vertexShader: UV_VERT,
    fragmentShader: WALL_FRAG,
  });
  // flat panel just behind the cards; sized in layout()
  const wall = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
  wall.position.z = -0.45;
  wall.userData.noPick = true;
  root.add(wall);
  return { wallMat: mat, wall };
}

function buildCard(project, index) {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 640;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = Math.min(8, ctx?.renderer?.capabilities?.getMaxAnisotropy?.() || 4);
  const secret = !!project.secret;
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: tex },
      uTime: { value: 0 },
      uHover: { value: 0 },
      uAlpha: { value: 0 },
      uTint: { value: (secret ? C_ORANGE : C_CYAN).clone() },
    },
    vertexShader: UV_VERT,
    fragmentShader: CARD_FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(CARD_W, CARD_H), mat);
  const tilt = new THREE.Group(); // mouse tilt happens here, so the base placement stays clean
  tilt.add(mesh);
  const group = new THREE.Group();
  group.add(tilt);
  return {
    project, index, secret, id: `project:${project.id}`,
    canvas, g: canvas.getContext('2d'), tex, mat, mesh, tilt, group,
    pin: null, hoverK: 0, reveal: 0, dimK: 1, dimTarget: 1,
    viewed: false, matches: true,
  };
}

/** Breaker panel: the clickable object that starts the wires game while the bay is dark. */
function buildPanel(root) {
  const group = new THREE.Group();
  group.position.set(0, 0, 0); // placed in front of the camera by layout()
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
  const light = new THREE.PointLight(C_ORANGE, 30, 8, 2);
  light.position.set(0, 1.6, 1.2);
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
    g.fillText(online ? 'POWER STABLE' : 'BAY OFFLINE', 128, 44);
    g.font = '16px "Share Tech Mono", monospace';
    g.fillText(online ? 'ARCHIVE ONLINE' : 'CLICK TO REPAIR', 128, 86);
    tex.needsUpdate = true;
  };
  draw(false);
  return { group, ledMat, light, draw };
}

// ---------- runtime state ----------
let scene = null;
let ctx = null;
let H = null; // per-visit state; null while the room is not active

const reduced = () => !!ctx?.reducedMotion;
const nn = (i) => String(i + 1).padStart(2, '0');

/** Strings between neighbouring pins: the corkboard look. Only inside a row, so nothing crosses. */
function buildStrings() {
  if (H.strings) {
    H.root.remove(H.strings);
    disposeObject(H.strings);
  }
  H.stringMat = new THREE.LineBasicMaterial({ color: C_CYAN, transparent: true, opacity: 0.2 });
  const g = new THREE.Group();
  g.userData.noPick = true;
  const add = (a, b, sag) => {
    const mid = a.clone().lerp(b, 0.5);
    mid.y -= sag;
    const curve = new THREE.QuadraticBezierCurve3(a, mid, b);
    g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(curve.getPoints(20)), H.stringMat));
  };
  const pts = H.cards.map((c) => c.pin.getWorldPosition(new THREE.Vector3()));
  for (let i = 0; i < pts.length - 1; i++) {
    if (H.fit.cols === 1) {
      const bottom = pts[i].clone();
      bottom.y -= CARD_H + 0.12; // card bottom edge to the next pin
      add(bottom, pts[i + 1], 0.04);
    } else if (Math.floor(i / H.fit.cols) === Math.floor((i + 1) / H.fit.cols)) add(pts[i], pts[i + 1], 0.14);
  }
  H.strings = g;
  H.root.add(g);
}

/** Flat grid at z=0; every row is centred (so a short last row sits in the middle). */
function layout() {
  const n = H.cards.length;
  const f = H.fit;
  H.cards.forEach((c, i) => {
    const row = Math.floor(i / f.cols);
    const inRow = Math.min(f.cols, n - row * f.cols);
    const col = i - row * f.cols;
    c.group.position.set((col - (inRow - 1) / 2) * COL_STEP, -row * ROW_STEP, 0);
    c.group.rotation.set(0, 0, 0);
  });
  // backdrop covers the whole grid with a margin
  const wallW = f.gridW + 3;
  const wallH = (f.rows - 1) * ROW_STEP + CARD_H + 3;
  H.wall.scale.set(wallW, wallH, 1);
  H.wall.position.y = -((f.rows - 1) * ROW_STEP) / 2;
  H.wallMat.uniforms.uSize.value.set(wallW, wallH);
  // breaker console floats in front of the cards, near the centre of the view, while locked
  H.panel.group.position.set(0, f.baseY - 0.38 - 0.55, f.dist - 3.4);
  H.root.updateMatrixWorld(true);
  buildStrings();
  H.maxScroll = f.maxScroll;
  H.scroll.target = clamp(H.scroll.target, 0, H.maxScroll);
}

function fitCamera() {
  if (!H) return;
  const f = computeFit(window.innerWidth / window.innerHeight, H.cards.length);
  H.fit = f;
  ctx.camera.fov = FOV;
  ctx.camera.updateProjectionMatrix();
  layout(); // cheap, so just redo it on every resize
}

// ---------- search / filter ----------
function buildSearchBar() {
  const bar = document.createElement('div');
  bar.className = 'archive-bar';
  bar.setAttribute('role', 'search');
  const label = document.createElement('label');
  label.htmlFor = 'archive-q';
  label.textContent = 'SEARCH THE ARCHIVES';
  const input = document.createElement('input');
  input.id = 'archive-q';
  input.type = 'search';
  input.placeholder = 'Search the archives...';
  input.autocomplete = 'off';
  input.maxLength = 60;
  const chips = document.createElement('ul');
  chips.className = 'chips';
  chips.setAttribute('aria-label', 'Filter by technology');
  const count = document.createElement('p');
  count.className = 'archive-count';
  count.setAttribute('aria-live', 'polite');

  // "ALL" plus the six most common technologies
  const freq = new Map();
  for (const c of H.cards) for (const t of c.project.tech || []) freq.set(t, (freq.get(t) || 0) + 1);
  const top = [...freq.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 6).map((e) => e[0]);
  const buttons = [];
  for (const tag of [null, ...top]) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip chip-btn';
    b.textContent = tag || 'ALL';
    b.setAttribute('aria-pressed', String(tag === null));
    b.addEventListener('click', () => {
      H.tag = tag;
      buttons.forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      applyFilter();
    });
    li.append(b);
    chips.append(li);
    buttons.push(b);
  }
  input.addEventListener('input', () => {
    H.query = input.value;
    applyFilter();
  });
  bar.append(label, input, chips, count);
  document.body.appendChild(bar);
  return { bar, input, buttons, count };
}

function setSearchEnabled(on) {
  H.search.input.disabled = !on;
  H.search.input.placeholder = on ? 'Search the archives...' : 'Locked: restore bay power first';
  H.search.buttons.forEach((b) => { b.disabled = !on; });
}

/** Dim cards that do not match; matching ones stay clickable. */
function applyFilter() {
  const terms = H.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  let shown = 0;
  for (const c of H.cards) {
    const p = c.project;
    const hay = [p.title, p.shortDescription, real(p.role), (p.tech || []).join(' ')].join(' ').toLowerCase();
    const textOk = terms.every((t) => hay.includes(t));
    const tagOk = !H.tag || (p.tech || []).some((t) => t.toLowerCase() === H.tag.toLowerCase());
    c.matches = textOk && tagOk;
    if (c.matches) shown++;
    c.dimTarget = c.matches ? 1 : 0.15;
    if (H.unlocked) ctx.input.setActive(c.id, c.matches);
  }
  H.search.count.textContent = !H.unlocked
    ? 'Archive locked: restore bay power.'
    : shown ? `${shown} of ${H.cards.length} files` : 'No matching files in the archive.';
}

// ---------- viewing projects ----------
function markViewed(card) {
  if (card.viewed) return;
  card.viewed = true;
  H.viewed.add(card.project.id);
  saveViewed(H.viewed);
  drawCard(card, 'viewed');
  checkAllViewed();
}

/** Every non-secret project opened -> 'curious_mind' (the hidden bonus file is optional). */
function checkAllViewed() {
  const required = H.cards.filter((c) => !c.secret);
  if (H.curiousSent || !required.length || !required.every((c) => H.viewed.has(c.project.id))) return;
  H.curiousSent = true;
  if (getState().achievements.includes('curious_mind')) return;
  emit('achievement:unlock', { id: 'curious_mind' });
  H.pendingToast = 'ACHIEVEMENT UNLOCKED: CURIOUS MIND. Every project viewed.';
}

function openProject(card) {
  const p = card.project;
  const link = real(p.link);
  const role = real(p.role);
  const keyboardUser = document.activeElement?.classList?.contains('a11y-proxy');
  ctx.audio.play('click');
  ctx.input.setEnabled(false); // the modal owns input until it closes
  const meta = [];
  if (role) meta.push({ label: 'ROLE', value: role });
  if (!link) meta.push({ label: 'LINK', value: 'Not published yet' });
  openModal({
    kicker: `FILE ${nn(card.index)} OF ${String(H.cards.length).padStart(2, '0')}`,
    title: p.title,
    description: p.shortDescription,
    meta,
    chips: p.tech || [],
    links: link ? [{ label: 'OPEN PROJECT', href: link }] : [],
    onClose: () => {
      if (!H) return;
      ctx.input.setEnabled(true);
      if (keyboardUser) ctx.input.focus(card.id); // keyboard users return to the card they opened
      if (H.pendingToast) {
        ctx.input.toast(H.pendingToast, 3500);
        H.pendingToast = '';
      }
    },
  });
  markViewed(card);
}

// ---------- locked state and the wires game ----------
async function repair() {
  if (!H || H.unlocked || H.gameOpen) return;
  H.gameOpen = true;
  ctx.input.setEnabled(false);
  const won = await startWires({ room: 'projects' }); // emits game:win, room:power, xp:add itself
  if (!H) return;
  H.gameOpen = false;
  ctx.input.setEnabled(true);
  if (!won && !H.unlocked) ctx.input.toast('Panel still offline. Try again when ready.');
}

function onPanel() {
  if (!H) return;
  if (H.unlocked) ctx.input.toast('POWER STABLE. The project archive is online.');
  else repair();
}

/** Decrypt the cards: each flickers in one after another. */
function unlock(animate = true, quiet = false) {
  if (H.unlocked) return;
  H.unlocked = true;
  H.panel.draw(true);
  H.panel.group.visible = false; // the console has done its job: keep the view clear
  ctx.input.setActive('panel', false);
  setSearchEnabled(true);
  H.cards.forEach((c, i) => {
    drawCard(c, c.viewed ? 'viewed' : 'new');
    ctx.input.setActive(c.id, true);
    if (animate && !reduced()) {
      c.reveal = 0;
      H.gctx.add(() => {
        const tl = gsap.timeline({ delay: 0.3 + i * 0.12 });
        for (const [v, d] of [[1, 0.05], [0.1, 0.06], [0.9, 0.05], [0.2, 0.05], [1, 0.15]]) tl.to(c, { reveal: v, duration: d, ease: 'none' });
      });
    } else c.reveal = 1;
  });
  applyFilter();
  if (!quiet) ctx.input.toast('ENGINEERING BAY ONLINE: project archive decrypted.', 3500);
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
  const { wallMat, wall } = buildBackdrop(root);
  const panel = buildPanel(root);
  root.add(new THREE.HemisphereLight(0x6a8ab0, 0x0b0f1a, 3));

  // The hidden project only appears after the Easter egg was found in the hub
  const visible = projectsData.filter((p) => !p.secret || state.achievements.includes('hidden_beacon'));
  const viewed = loadViewed();
  const pinGeo = new THREE.SphereGeometry(0.06, 12, 8);
  const pinMat = new THREE.MeshBasicMaterial({ color: C_CYAN.clone().multiplyScalar(1.6) });
  const cards = visible.map((p, i) => {
    const c = buildCard(p, i);
    c.viewed = viewed.has(p.id);
    c.pin = new THREE.Mesh(pinGeo, pinMat);
    c.pin.position.set(0, CARD_H / 2 + 0.18, 0.03);
    c.group.add(c.pin);
    root.add(c.group);
    drawCard(c, 'locked');
    return c;
  });

  H = {
    root, wallMat, wall, panel, cards, viewed, fit: null,
    gctx: gsap.context(() => {}),
    offs: [],
    unlocked: false, gameOpen: false, curiousSent: false, pendingToast: '',
    query: '', tag: null, maxScroll: 0,
    scroll: { v: 0, target: 0 },
    ptr: { x: 0, y: 0 }, px: 0, py: 0, cur: { x: 0, y: 0 },
    look: new THREE.Vector3(),
    powerK: 0.2,
    strings: null, stringMat: null, search: null,
  };
  H.search = buildSearchBar();
  setSearchEnabled(false);
  fitCamera(); // also lays the cards out
  ctx.stage.setBloom({ strength: 0.35, radius: 0.4, threshold: 0.9 });

  // Interactive objects, in logical Tab order: the panel first, then the cards
  const input = ctx.input;
  input.setEnabled(true);
  input.register(panel.group, {
    id: 'panel',
    label: () => (H.unlocked ? 'POWER PANEL: bay power stable' : 'POWER PANEL: click to repair'),
    onClick: onPanel,
  });
  for (const c of cards) {
    input.register(c.group, {
      id: c.id,
      label: () => (H.unlocked ? `${c.project.title} [${c.viewed ? 'VIEWED' : 'NEW'}]` : `FILE ${nn(c.index)}: ENCRYPTED`),
      onClick: () => {
        if (H.unlocked && c.matches) openProject(c);
      },
      // Tabbing to a card scrolls it into view
      onHover: (e, over) => {
        if (over && H?.unlocked && document.activeElement?.classList?.contains('a11y-proxy')) {
          H.scroll.target = clamp(Math.floor(c.index / H.fit.cols) * ROW_STEP, 0, H.maxScroll);
        }
      },
    });
    input.setActive(c.id, false);
  }
  applyFilter();

  // Pointer parallax / tilt, wheel + drag scrolling for the single-column phone layout
  const canvas = ctx.renderer.domElement;
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
    if (!H.unlocked) return; // nothing to scroll to while the bay is dark
    if (document.querySelector('.modal-backdrop, .game-overlay')) return;
    H.scroll.target = clamp(H.scroll.target + e.deltaY * 0.006, 0, H.maxScroll);
  };
  const onDown = (e) => { dragY = e.clientY; };
  const onDrag = (e) => {
    if (dragY === null || !H.unlocked) return;
    const perPx = (2 * H.fit.dist * Math.tan(rad(FOV / 2))) / window.innerHeight; // world units per pixel at card depth
    H.scroll.target = clamp(H.scroll.target + (dragY - e.clientY) * perPx, 0, H.maxScroll);
    dragY = e.clientY;
  };
  const onUp = () => { dragY = null; };
  // Up / Down arrows (or Page Up / Down) move one row of cards at a time
  const onKey = (e) => {
    if (!H.unlocked || H.maxScroll <= 0 || e.altKey || e.ctrlKey || e.metaKey || e.target?.tagName === 'INPUT') return;
    if (document.querySelector('.modal-backdrop, .game-overlay, .rogue-overlay')) return;
    const row = Math.round(H.scroll.target / ROW_STEP);
    if (e.key === 'ArrowDown' || e.key === 'PageDown') H.scroll.target = clamp((row + 1) * ROW_STEP, 0, H.maxScroll);
    else if (e.key === 'ArrowUp' || e.key === 'PageUp') H.scroll.target = clamp((row - 1) * ROW_STEP, 0, H.maxScroll);
    else return;
    e.preventDefault();
  };
  document.addEventListener('keydown', onKey);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('wheel', onWheel, { passive: true });
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onDrag);
  window.addEventListener('pointerup', onUp);
  H.offs.push(
    () => window.removeEventListener('pointermove', onMove),
    () => window.removeEventListener('wheel', onWheel),
    () => canvas.removeEventListener('pointerdown', onDown),
    () => canvas.removeEventListener('pointermove', onDrag),
    () => window.removeEventListener('pointerup', onUp),
    () => document.removeEventListener('keydown', onKey),
    ctx.stage.onResize(fitCamera),
    on('room:power', ({ room }) => {
      if (room === 'projects' && H) unlock(true);
    })
  );

  if (state.power.projects) unlock(true, true);
  else input.toast('ENGINEERING BAY OFFLINE. Repair the power panel to decrypt the archive.', 4500);
}

export function exit() {
  if (!H) return;
  closeModal();
  H.gctx.kill();
  for (const off of H.offs) off();
  H.search.bar.remove();
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
  const tt = reduced() ? 0 : t; // freeze shader animation for reduced motion

  // Backdrop brightens as the bay powers up
  H.powerK += ((H.unlocked ? 1 : 0.2) - H.powerK) * Math.min(1, dt * 2);
  H.wallMat.uniforms.uTime.value = tt;
  H.wallMat.uniforms.uPower.value = H.powerK;
  H.stringMat.opacity = 0.2 + 0.4 * H.powerK;

  // Cards: hover glow, dimming for filtered-out files, mouse tilt
  const k = 1 - Math.exp(-dt * 8);
  H.cards.forEach((c, i) => {
    const hov = input.isHovered(c.id) ? 1 : 0;
    c.hoverK += (hov - c.hoverK) * Math.min(1, dt * 10);
    c.dimK += (c.dimTarget - c.dimK) * Math.min(1, dt * 6);
    const u = c.mat.uniforms;
    u.uTime.value = tt;
    u.uHover.value = c.hoverK;
    u.uAlpha.value = H.unlocked ? c.reveal * c.dimK : 0.35;

    let ry = 0;
    let rx = 0;
    if (!reduced()) {
      if (hov) {
        // Turn the card's face toward the pointer
        c.group.getWorldPosition(_v).project(cam);
        ry = clamp((H.ptr.x - _v.x) * 0.5, -0.4, 0.4);
        rx = clamp(-(H.ptr.y - _v.y) * 0.35, -0.3, 0.3);
      } else {
      }
      c.tilt.position.y = Math.sin(tt * 0.8 + i * 1.3) * 0.02;
    }
    c.tilt.rotation.y += (ry - c.tilt.rotation.y) * k;
    c.tilt.rotation.x += (rx - c.tilt.rotation.x) * k;
    c.tilt.scale.setScalar(1 + 0.04 * c.hoverK);
  });

  // Breaker panel: blinks orange while the bay is dark, steady cyan once repaired
  _c.copy(H.unlocked ? C_CYAN : C_ORANGE);
  H.panel.ledMat.color.copy(_c).multiplyScalar(H.unlocked ? 1.6 : Math.sin(tt * 4) > 0 ? 1.8 : 0.3);
  H.panel.light.color.copy(_c);

  // Camera: straight at the flat wall, gentle parallax, vertical scroll by rows
  H.scroll.v += (H.scroll.target - H.scroll.v) * (1 - Math.exp(-dt * 8));
  H.cur.x += (H.px - H.cur.x) * k;
  H.cur.y += (H.py - H.cur.y) * k;
  const y = H.fit.baseY - H.scroll.v;
  const cx = H.cur.x * 0.35;
  const cy = y - H.cur.y * 0.12;
  cam.position.set(cx, cy, H.fit.dist);
  H.look.set(cx, cy, 0);
  cam.lookAt(H.look);
}
