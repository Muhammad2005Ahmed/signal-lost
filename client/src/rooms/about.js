// ABOUT ROOM (Crew Quarters): a holographic crew profile built from data/about.json. The astronaut
// hologram stands in the middle; the bio, focus, hobbies and base cards float around it.
// Everything personal stays encrypted until the CODEBREAKER mini-game is won.
// Wide screens: cards form an arc around the hologram. Portrait screens: one scrolling column.
// Contract: exports { init, enter, exit, update }.

import * as THREE from 'three';
import { gsap } from 'gsap';
import { on } from '../core/events.js';
import { getState } from '../core/state.js';
import { disposeObject } from '../core/scene.js';
import { openModal, closeModal } from '../ui/modal.js';
import { startCodebreaker } from '../games/codebreaker.js';
import aboutData from '@data/about.json';

// ---------- constants ----------
const CARD_W = 3.0;
const CARD_H = 1.875; // 512x320 texture ratio
const ARC_SCALE = 1.2; // cards are bigger in the arc layout (they sit farther from the camera)
const ARC_R = 6.5;
const ARC_Y = 2.1;
const COL_Y = 2.3;
const ROW_STEP = 2.3;
const PORTRAIT = 0.9; // aspect ratio below which the single column is used

const C_CYAN = new THREE.Color(0x00e5ff);
const C_ORANGE = new THREE.Color(0xff6b2c);
const _c = new THREE.Color();
const _v = new THREE.Vector3();

const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
/** Data placeholders written as "[MISSING ...]" count as empty. */
const real = (v) => (typeof v === 'string' && !v.startsWith('[MISSING') ? v : '');
/** Inline placeholders (inside a longer line) become readable text. */
const clean = (s) => String(s || '').replace(/\[MISSING[^\]]*\]/g, 'not added yet');
const nn = (i) => String(i + 1).padStart(2, '0');
const KIND_LABEL = { bio: 'BIOGRAPHY', focus: 'FOCUS', hobbies: 'HOBBIES', location: 'LOCATION' };

const reduced = () => !!ctx?.reducedMotion;

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
  float scan = 0.93 + 0.07 * sin(vUv.y * 220.0 - uTime * 2.0);
  float flick = 0.97 + 0.03 * sin(uTime * 31.0 + vUv.y * 3.0);
  vec2 e = min(vUv, 1.0 - vUv);
  float edge = 1.0 - smoothstep(0.0, 0.02, min(e.x, e.y));
  vec3 col = t.rgb * scan * flick * (1.0 + 0.45 * uHover) + uTint * edge * (0.6 + 0.9 * uHover);
  float a = max(t.a, edge * 0.9) * uAlpha;
  gl_FragColor = vec4(col, a);
}`;

// Curved back wall: faint moving grid
const WALL_FRAG = /* glsl */ `
varying vec2 vUv;
uniform float uTime;
uniform float uPower;
void main() {
  vec2 d = abs(fract(vUv * vec2(60.0, 14.0)) - 0.5);
  float line = smoothstep(0.46, 0.5, max(d.x, d.y));
  float sweep = pow(max(0.0, sin((vUv.y * 3.0 - uTime * 0.15) * 6.2831)), 8.0);
  vec3 col = vec3(0.012, 0.028, 0.045) + vec3(0.0, 0.9, 1.0) * (line * 0.10 + sweep * 0.03) * (0.35 + 0.65 * uPower);
  gl_FragColor = vec4(col, 1.0);
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

/** mode: 'locked' | 'new' | 'viewed'. Personal text is only drawn once unlocked. */
function drawCard(card, mode) {
  const g = card.g;
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

  if (mode === 'locked') {
    g.fillStyle = '#FF6B2C';
    g.font = '16px "Share Tech Mono", monospace';
    g.fillText(`CREW FILE ${nn(card.index)} // ENCRYPTED`, 28, 24);
    g.font = '700 32px Orbitron, sans-serif';
    g.fillText('ACCESS DENIED', 28, 120);
    g.fillStyle = '#6f8c97';
    g.font = '17px "Share Tech Mono", monospace';
    g.fillText('Break the access code to open.', 28, 176);
  } else {
    g.fillStyle = accent;
    g.font = '16px "Share Tech Mono", monospace';
    g.fillText(`CREW FILE ${nn(card.index)} // ${KIND_LABEL[card.data.kind] || 'RECORD'}`, 28, 24);

    g.fillStyle = '#ffffff';
    g.font = '700 27px Orbitron, sans-serif';
    const titleLines = wrap(g, card.data.title, 456, 2);
    titleLines.forEach((l, i) => g.fillText(l, 28, 54 + i * 34));

    g.fillStyle = card.empty ? '#FF6B2C' : '#9fc3cf';
    g.font = '17px "Share Tech Mono", monospace';
    const y0 = 54 + titleLines.length * 34 + 12;
    const maxLines = Math.floor((272 - y0) / 22);
    wrap(g, card.empty ? 'Nothing has been added to this file yet.' : card.text, 456, maxLines).forEach((l, i) => g.fillText(l, 28, y0 + i * 22));

    g.fillStyle = mode === 'viewed' ? '#00E5FF' : '#6f8c97';
    g.font = '14px "Share Tech Mono", monospace';
    g.fillText(mode === 'viewed' ? 'VIEWED' : 'CLICK TO OPEN', 28, 288);
  }
  card.tex.needsUpdate = true;
}

// ---------- builders ----------
function buildCard(data, index) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 320;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const text = real(data.text);
  const empty = !text;
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: tex },
      uTime: { value: 0 },
      uHover: { value: 0 },
      uAlpha: { value: 0 },
      uTint: { value: (empty ? C_ORANGE : C_CYAN).clone() },
    },
    vertexShader: UV_VERT,
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
  return {
    data, index, empty, text, id: `about:${data.id}`,
    canvas, g: canvas.getContext('2d'), tex, mat, mesh, tilt, group,
    hoverK: 0, reveal: 0, viewed: false,
  };
}

function buildRoom(root) {
  // Curved back wall behind the cards, a floor grid and a glowing deck ring
  const wallMat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uPower: { value: 0 } },
    vertexShader: UV_VERT,
    fragmentShader: WALL_FRAG,
    side: THREE.BackSide,
  });
  const wall = new THREE.Mesh(new THREE.CylinderGeometry(12, 12, 9, 64, 1, true, Math.PI - rad(75), rad(150)), wallMat);
  wall.position.y = 3.2;
  wall.userData.noPick = true;
  const grid = new THREE.GridHelper(30, 30, 0x00e5ff, 0x0a3a44);
  grid.material.transparent = true;
  grid.material.opacity = 0.3;
  grid.userData.noPick = true;
  const ringMat = new THREE.MeshBasicMaterial({ color: C_CYAN.clone(), transparent: true, opacity: 0.5, side: THREE.DoubleSide });
  const deck = new THREE.Mesh(new THREE.RingGeometry(1.15, 1.25, 64), ringMat);
  deck.rotation.x = -Math.PI / 2;
  deck.position.y = 0.01;
  deck.userData.noPick = true;
  root.add(wall, grid, deck);
  return { wallMat, ringMat };
}

/** Placeholder astronaut hologram (1.8 units tall, feet at y=0, facing +Z). The real GLB can replace it later. */
function buildFigure(root) {
  const group = new THREE.Group();
  const lineMat = new THREE.MeshBasicMaterial({ color: C_CYAN.clone().multiplyScalar(1.5), wireframe: true, transparent: true, opacity: 0.55 });
  const fillMat = new THREE.MeshBasicMaterial({ color: C_CYAN, transparent: true, opacity: 0.08, depthWrite: false });
  const visorMat = new THREE.MeshBasicMaterial({ color: C_ORANGE.clone().multiplyScalar(1.4), transparent: true, opacity: 0.8 });
  const parts = [
    [new THREE.CapsuleGeometry(0.3, 0.55, 4, 12), 0.95], // torso
    [new THREE.SphereGeometry(0.3, 16, 12), 1.5], // helmet
  ];
  for (const [geo, y] of parts) {
    const a = new THREE.Mesh(geo, lineMat);
    const b = new THREE.Mesh(geo, fillMat);
    a.position.y = b.position.y = y;
    group.add(a, b);
  }
  const visor = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 8, -Math.PI / 2.4, Math.PI / 1.2, Math.PI / 3, Math.PI / 2.2), visorMat);
  visor.position.set(0, 1.5, 0.12);
  visor.rotation.y = Math.PI / 2;
  const pack = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.55, 0.22), lineMat);
  pack.position.set(0, 1.0, -0.32);
  const legGeo = new THREE.CapsuleGeometry(0.11, 0.4, 3, 8);
  const legL = new THREE.Mesh(legGeo, lineMat);
  const legR = new THREE.Mesh(legGeo, lineMat);
  legL.position.set(-0.14, 0.3, 0);
  legR.position.set(0.14, 0.3, 0);
  const armGeo = new THREE.CapsuleGeometry(0.08, 0.5, 3, 8);
  const armL = new THREE.Mesh(armGeo, lineMat);
  const armR = new THREE.Mesh(armGeo, lineMat);
  armL.position.set(-0.42, 1.0, 0);
  armR.position.set(0.42, 1.0, 0);
  armL.rotation.z = 0.15;
  armR.rotation.z = -0.15;
  group.add(visor, pack, legL, legR, armL, armR);

  // Light beam rising from the deck
  const beamMat = new THREE.MeshBasicMaterial({ color: C_CYAN, transparent: true, opacity: 0.05, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending });
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.15, 3.6, 32, 1, true), beamMat);
  beam.position.y = 1.8;
  beam.userData.noPick = true;
  root.add(group, beam);
  return { group, beam, lineMat, fillMat, visorMat, beamMat };
}

/** Name plate floating above the hologram. Draws a locked version until the file is decrypted. */
function buildPlate(root) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 160;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 0.75), mat);
  mesh.position.set(0, 2.45, 0);
  mesh.userData.noPick = true;
  root.add(mesh);
  const g = canvas.getContext('2d');
  const draw = (unlocked) => {
    g.clearRect(0, 0, 512, 160);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    if (unlocked) {
      const hd = aboutData.header;
      g.fillStyle = '#ffffff';
      g.font = '700 38px Orbitron, sans-serif';
      g.fillText(hd.name.toUpperCase(), 256, 40);
      g.fillStyle = '#00E5FF';
      g.font = '22px "Share Tech Mono", monospace';
      g.fillText(hd.line, 256, 88);
      g.fillStyle = '#9fc3cf';
      g.font = '16px "Share Tech Mono", monospace';
      g.fillText(hd.tagline, 256, 124, 480);
    } else {
      g.fillStyle = '#FF6B2C';
      g.font = '700 30px Orbitron, sans-serif';
      g.fillText('CREW FILE LOCKED', 256, 56);
      g.font = '18px "Share Tech Mono", monospace';
      g.fillText('IDENTITY ENCRYPTED', 256, 104);
    }
    tex.needsUpdate = true;
  };
  draw(false);
  return { mesh, mat, draw };
}

/** Terminal: the clickable object that starts the codebreaker game while the quarters are locked. */
function buildTerminal(root) {
  const group = new THREE.Group();
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
    g.fillText(online ? 'FILE DECRYPTED' : 'CREW FILE LOCKED', 128, 44);
    g.font = '16px "Share Tech Mono", monospace';
    g.fillText(online ? 'ACCESS GRANTED' : 'CLICK TO BREAK CODE', 128, 86);
    tex.needsUpdate = true;
  };
  draw(false);
  return { group, ledMat, light, draw };
}

// ---------- runtime state ----------
let scene = null;
let ctx = null;
let H = null; // per-visit state; null while the room is not active

/** Arc around the hologram on wide screens, a single scrolling column on portrait ones. */
function layout() {
  const n = H.cards.length;
  const column = H.mode === 'column';
  const cardW = CARD_W * ARC_SCALE;
  const step = n > 1 ? deg(2 * Math.asin(Math.min(1, (cardW + 0.35) / (2 * ARC_R)))) : 0;
  H.cards.forEach((c, i) => {
    if (column) {
      c.group.position.set(0, COL_Y - i * ROW_STEP, -6.5);
      c.group.rotation.set(0, 0, 0);
      c.group.scale.setScalar(1);
    } else {
      const ang = (i - (n - 1) / 2) * step;
      c.group.position.set(ARC_R * Math.sin(rad(ang)), ARC_Y + (i % 2 ? 0.3 : -0.1), -ARC_R * Math.cos(rad(ang)));
      c.group.rotation.set(0, -rad(ang), 0); // face the camera
      c.group.scale.setScalar(ARC_SCALE);
    }
  });
  H.arcHalf = n > 1 ? ARC_R * Math.sin(rad(((n - 1) / 2) * step)) + cardW / 2 : cardW / 2;
  H.arcDepth = n > 1 ? ARC_R * Math.cos(rad(((n - 1) / 2) * step)) : ARC_R;
  H.maxScroll = column ? Math.max(0, (n - 1) * ROW_STEP) : 0;
  H.scroll.target = clamp(H.scroll.target, 0, H.maxScroll);
  H.figure.group.visible = false; // figure removed on purpose
  H.beam.visible = false; // beam removed with the figure
  H.plate.mesh.visible = false; // name plate removed on purpose
  H.terminal.group.position.set(column ? 0 : -2.2, column ? 1.0 : 0, column ? -3.2 : 0.4);
  H.terminal.group.rotation.y = column ? 0 : 0.35;
  H.root.updateMatrixWorld(true);
}

function fitCamera() {
  if (!H) return;
  const aspect = window.innerWidth / window.innerHeight;
  const mode = aspect < PORTRAIT ? 'column' : 'arc';
  const fov = mode === 'column' ? 62 : 55;
  if (mode !== H.mode) {
    H.mode = mode;
    layout();
  }
  H.cam.fov = fov;
  // Arc: pull back until the whole arc fits horizontally
  if (mode === 'arc') H.cam.z = clamp((H.arcHalf * 1.08) / (Math.tan(rad(fov / 2)) * aspect) - H.arcDepth, 4.5, 15);
  else H.cam.z = -0.5;
  ctx.camera.fov = fov;
  ctx.camera.updateProjectionMatrix();
}

// ---------- viewing cards ----------
function openCard(card) {
  const d = card.data;
  const keyboardUser = document.activeElement?.classList?.contains('a11y-proxy');
  ctx.audio.play('click');
  ctx.input.setEnabled(false); // the modal owns input until it closes
  openModal({
    kicker: `CREW FILE ${nn(card.index)} OF ${nn(H.cards.length - 1)} // ${KIND_LABEL[d.kind] || 'RECORD'}`,
    title: d.title,
    description: card.empty ? 'This file has not been filled in yet.' : card.text,
    detailsTitle: d.details?.length ? 'Details' : undefined,
    details: (d.details || []).map(clean),
    onClose: () => {
      if (!H) return;
      ctx.input.setEnabled(true);
      if (keyboardUser) ctx.input.focus(card.id); // keyboard users return to the card they opened
    },
  });
  if (!card.viewed) {
    card.viewed = true;
    drawCard(card, 'viewed');
  }
}

// ---------- locked state and the codebreaker game ----------
async function repair() {
  if (!H || H.unlocked || H.gameOpen) return;
  H.gameOpen = true;
  ctx.input.setEnabled(false);
  const won = await startCodebreaker({ room: 'about' }); // emits game:win, room:power, xp:add itself
  if (!H) return;
  H.gameOpen = false;
  ctx.input.setEnabled(true);
  if (!won && !H.unlocked) ctx.input.toast('Crew file still locked. Try again when ready.');
}

function onTerminal() {
  if (!H) return;
  if (H.unlocked) ctx.input.toast('ACCESS GRANTED. The crew files are open.');
  else repair();
}

/** Decrypt the cards: each flickers in one after another. */
function unlock(animate = true, quiet = false) {
  if (H.unlocked) return;
  H.unlocked = true;
  H.terminal.draw(true);
  H.terminal.group.visible = false; // the console has done its job: keep the view clear
  ctx.input.setActive('terminal', false);
  H.plate.draw(true);
  H.cards.forEach((c, i) => {
    drawCard(c, c.viewed ? 'viewed' : 'new');
    ctx.input.setActive(c.id, true);
    if (animate && !reduced()) {
      c.reveal = 0;
      H.gctx.add(() => {
        const tl = gsap.timeline({ delay: 0.3 + i * 0.15 });
        for (const [v, d] of [[1, 0.05], [0.1, 0.06], [0.9, 0.05], [0.2, 0.05], [1, 0.15]]) tl.to(c, { reveal: v, duration: d, ease: 'none' });
      });
    } else c.reveal = 1;
  });
  H.figure.avatar?.wave(); // the crew member greets you when the files open
  if (!quiet) ctx.input.toast('CREW QUARTERS ONLINE: profile files decrypted.', 3500);
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
  const { wallMat, ringMat } = buildRoom(root);
  const figure = buildFigure(root);
  figure.group.visible = false; // the wireframe hologram is hidden on purpose (no figure in Crew Quarters)
  figure.beam.visible = false;
  const plate = buildPlate(root);
  plate.mesh.visible = false; // the floating name text is removed on purpose
  const terminal = buildTerminal(root);
  root.add(new THREE.HemisphereLight(0x6a8ab0, 0x0b0f1a, 3));

  const cards = aboutData.cards.map((d, i) => {
    const c = buildCard(d, i);
    root.add(c.group);
    drawCard(c, 'locked'); // personal text is not drawn until the game is won
    return c;
  });

  H = {
    root, wallMat, ringMat, figure, beam: figure.beam, plate, terminal, cards,
    gctx: gsap.context(() => {}),
    offs: [],
    unlocked: false, gameOpen: false,
    mode: '', arcHalf: 0, arcDepth: 0, maxScroll: 0,
    scroll: { v: 0, target: 0 },
    ptr: { x: 0, y: 0 }, px: 0, py: 0, cur: { x: 0, y: 0 },
    cam: { z: 6, fov: 55 },
    look: new THREE.Vector3(),
    powerK: 0.2,
  };
  fitCamera(); // lays the cards out
  ctx.stage.setBloom({ strength: 0.9, radius: 0.55, threshold: 0.8 });

  // Interactive objects, in logical Tab order: the terminal first, then the cards
  const input = ctx.input;
  input.setEnabled(true);
  input.register(terminal.group, {
    id: 'terminal',
    label: () => (H.unlocked ? 'CREW TERMINAL: access granted' : 'CREW TERMINAL: click to break the access code'),
    onClick: onTerminal,
  });
  for (const c of cards) {
    input.register(c.group, {
      id: c.id,
      label: () => (H.unlocked ? `${c.data.title} [${c.viewed ? 'VIEWED' : 'NEW'}]` : `CREW FILE ${nn(c.index)}: ENCRYPTED`),
      onClick: () => {
        if (H.unlocked) openCard(c);
      },
    });
    input.setActive(c.id, false);
  }

  // Pointer parallax / tilt, wheel + drag scrolling for the portrait column
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
    if (H.mode !== 'column' || document.querySelector('.modal-backdrop, .game-overlay')) return;
    H.scroll.target = clamp(H.scroll.target + e.deltaY * 0.004, 0, H.maxScroll);
  };
  const onDown = (e) => { if (H.mode === 'column') dragY = e.clientY; };
  const onDrag = (e) => {
    if (dragY === null) return;
    const perPx = (2 * 6 * Math.tan(rad(H.cam.fov / 2))) / window.innerHeight; // world units per pixel at card depth
    H.scroll.target = clamp(H.scroll.target + (dragY - e.clientY) * perPx, 0, H.maxScroll);
    dragY = e.clientY;
  };
  const onUp = () => { dragY = null; };
  // Portrait column: Up / Down arrows move one card at a time
  const onKey = (e) => {
    if (!H.unlocked || H.maxScroll <= 0 || e.altKey || e.ctrlKey || e.metaKey) return;
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
  window.addEventListener('pointercancel', onUp);
  H.offs.push(
    () => window.removeEventListener('pointermove', onMove),
    () => window.removeEventListener('wheel', onWheel),
    () => canvas.removeEventListener('pointerdown', onDown),
    () => canvas.removeEventListener('pointermove', onDrag),
    () => window.removeEventListener('pointerup', onUp),
    () => document.removeEventListener('keydown', onKey),
    () => window.removeEventListener('pointercancel', onUp),
    ctx.stage.onResize(fitCamera),
    on('room:power', ({ room }) => {
      if (room === 'about' && H) unlock(true);
    })
  );

  if (state.power.about) unlock(true, true);
  else input.toast('CREW QUARTERS LOCKED. Use the terminal to break the access code.', 4500);
}

export function exit() {
  if (!H) return;
  closeModal();
  H.gctx.kill();
  for (const off of H.offs) off();
  ctx.input.clear();
  ctx.input.setEnabled(true); // the next room starts with input on
  H.figure.avatar?.dispose(); // shared model: must leave the room before disposeObject
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

  // The room brightens when the files are decrypted
  H.powerK += ((H.unlocked ? 1 : 0.2) - H.powerK) * Math.min(1, dt * 2);
  H.wallMat.uniforms.uTime.value = tt;
  H.wallMat.uniforms.uPower.value = H.powerK;
  H.ringMat.opacity = 0.25 + 0.5 * H.powerK;

  // Hologram: slow turn and gentle float; orange while locked, cyan once decrypted
  const f = H.figure;
  if (f.avatar) {
    f.avatar.update(dt);
    f.group.rotation.y = reduced() ? 0 : Math.sin(tt * 0.4) * 0.45; // a person sways toward you, no full spin
    f.group.position.y = 0.05; // standing on the deck
  } else {
    f.group.rotation.y = tt * 0.35;
    f.group.position.y = reduced() ? 0.05 : 0.05 + Math.sin(tt * 0.9) * 0.05;
  }
  _c.copy(H.unlocked ? C_CYAN : C_ORANGE);
  const flick = H.unlocked ? 1 : 0.7 + 0.3 * Math.sin(tt * 19) * Math.sin(tt * 5.3);
  f.lineMat.color.copy(_c).multiplyScalar(1.5 * flick);
  f.fillMat.color.copy(_c);
  f.beamMat.color.copy(_c);
  f.beamMat.opacity = (0.03 + 0.04 * H.powerK) * flick;
  H.plate.mesh.position.y = 2.45 + (reduced() ? 0 : Math.sin(tt * 0.9 + 1) * 0.05);

  // Cards: hover glow, mouse tilt, zero-g bobbing
  H.cards.forEach((c, i) => {
    const hov = input.isHovered(c.id) ? 1 : 0;
    c.hoverK += (hov - c.hoverK) * Math.min(1, dt * 10);
    const u = c.mat.uniforms;
    u.uTime.value = tt;
    u.uHover.value = c.hoverK;
    u.uAlpha.value = H.unlocked ? c.reveal : 0.35;

    let ry = 0;
    let rx = 0;
    if (!reduced()) {
      if (hov) {
        c.group.getWorldPosition(_v).project(cam);
        ry = clamp((H.ptr.x - _v.x) * 0.5, -0.4, 0.4);
        rx = clamp(-(H.ptr.y - _v.y) * 0.35, -0.3, 0.3);
      } else {
        ry = Math.sin(tt * 0.5 + i) * 0.03;
      }
      c.tilt.position.y = Math.sin(tt * 0.8 + i * 1.3) * 0.06;
    }
    c.tilt.rotation.y += (ry - c.tilt.rotation.y) * k;
    c.tilt.rotation.x += (rx - c.tilt.rotation.x) * k;
    c.tilt.scale.setScalar(1 + 0.06 * c.hoverK);
  });

  // Terminal: blinks orange while locked, steady cyan once unlocked
  _c.copy(H.unlocked ? C_CYAN : C_ORANGE);
  H.terminal.ledMat.color.copy(_c).multiplyScalar(H.unlocked ? 1.6 : Math.sin(tt * 4) > 0 ? 1.8 : 0.3);
  H.terminal.light.color.copy(_c);

  // Camera: pointer parallax; in the portrait column it also scrolls
  H.scroll.v += (H.scroll.target - H.scroll.v) * (1 - Math.exp(-dt * 8));
  H.cur.x += (H.px - H.cur.x) * k;
  H.cur.y += (H.py - H.cur.y) * k;
  if (H.mode === 'column') {
    const y = COL_Y - H.scroll.v;
    cam.position.set(H.cur.x * 0.5, y - H.cur.y * 0.2, H.cam.z);
    H.look.set(H.cur.x * 0.8, y - H.cur.y * 0.4, -8);
  } else {
    cam.position.set(H.cur.x * 1.2, 2.4 - H.cur.y * 0.4, H.cam.z);
    H.look.set(0, 1.9, -2);
  }
  cam.lookAt(H.look);
}
