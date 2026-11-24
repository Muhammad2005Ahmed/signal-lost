// HUD and gamification layer: top bar (station power ring, rank badge + XP bar, oxygen meter, mute,
// objectives), rank-up banner, oxygen drain + collectible oxygen cells, the XP-depleted game over, and the final
// boss ("ALERT: ROGUE SIGNAL" overlay + ONE question answered through A.R.I.A).
// Call initHud(ctx) once after initProgress(). It also starts the achievements module.
// Exports: initHud, spawnOxygenCell.

import * as THREE from 'three';
import { gsap } from 'gsap';
import { on, emit } from '../core/events.js';
import { getState, update, reset, subscribe, getPowerPercent, getMeta, setMeta, RANKS } from '../core/state.js';
import { audio } from '../core/audio.js';
import { disposeObject } from '../core/scene.js';
import { openModal, closeModal } from './modal.js';
import { initAchievements } from './achievements.js';
import { openChat } from './chat.js';

// ---------- constants ----------
const DRAIN_EVERY_S = 6; // lose 1% oxygen every 6 seconds while the tab is visible
const ZERO_O2_XP_PENALTY = 20;
const REFILL_TO = 50;
const CELL_REFILL = 25; // percent restored by one oxygen cell
const CELL_LIFETIME_S = 30;
const RING_C = 2 * Math.PI * 18;
const ROOM_OBJECTIVES = [
  ['projects', 'Restore power to Engineering Bay'],
  ['skills', 'Restore power to Reactor Core'],
  ['education', 'Restore power to Archive'],
  ['about', 'Restore power to Crew Quarters'],
];
const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

let ctx = null;
let started = false; // true after the visitor entered the station (starts the oxygen clock)
let els = {};

// ---------- tiny DOM helpers ----------
function mk(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}
const svgNS = 'http://www.w3.org/2000/svg';
function svg(tag, attrs = {}) {
  const el = document.createElementNS(svgNS, tag);
  for (const k in attrs) el.setAttribute(k, attrs[k]);
  return el;
}
const toast = (text, ms) => ctx?.input?.toast?.(text, ms);
const overlayOpen = () => !!document.querySelector('.modal-backdrop, .game-overlay, .rogue-overlay');

function rankInfo(xp) {
  let i = 0;
  RANKS.forEach((r, idx) => { if (xp >= r.min) i = idx; });
  const cur = RANKS[i];
  const next = RANKS[i + 1] || null;
  return { i, cur, next, frac: next ? (xp - cur.min) / (next.min - cur.min) : 1 };
}

// =====================================================================================
// Top bar
// =====================================================================================
function speakerIcon(on_) {
  const s = svg('svg', { viewBox: '0 0 24 24', width: '18', height: '18', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
  s.append(svg('path', { d: 'M4 9v6h4l5 4V5L8 9H4z' }));
  if (on_) s.append(svg('path', { d: 'M16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11' }));
  else s.append(svg('path', { d: 'M17 9l5 6M22 9l-5 6' }));
  return s;
}

function buildBar() {
  const hud = document.getElementById('hud');
  hud.classList.add('hud--bar');

  // Station power ring
  const ring = mk('div', 'hud-item hud-power');
  ring.setAttribute('role', 'meter');
  ring.setAttribute('aria-label', 'Station power');
  ring.setAttribute('aria-valuemin', '0');
  ring.setAttribute('aria-valuemax', '100');
  const rs = svg('svg', { viewBox: '0 0 44 44', 'aria-hidden': 'true' });
  const bg = svg('circle', { class: 'ring-bg', cx: 22, cy: 22, r: 18 });
  const fg = svg('circle', { class: 'ring-fg', cx: 22, cy: 22, r: 18, 'stroke-dasharray': RING_C.toFixed(2), 'stroke-dashoffset': RING_C.toFixed(2), transform: 'rotate(-90 22 22)' });
  rs.append(bg, fg);
  const pct = mk('span', 'hud-power__pct', '0%');
  ring.append(rs, pct, mk('span', 'hud-cap hud-power__cap', 'POWER'));

  // Rank badge + XP bar
  const rankBox = mk('div', 'hud-item hud-rank');
  const badge = mk('span', 'rank-badge', 'CADET');
  const xp = mk('div', 'xp');
  const xpBar = mk('div', 'xp__bar');
  xpBar.setAttribute('role', 'progressbar');
  xpBar.setAttribute('aria-label', 'Experience points');
  xpBar.setAttribute('aria-valuemin', '0');
  const xpFill = mk('span', 'xp__fill');
  xpBar.append(xpFill);
  const xpText = mk('span', 'xp__text', 'XP 0');
  xp.append(xpBar, xpText);
  rankBox.append(badge, xp);

  // Oxygen meter
  const o2 = mk('div', 'hud-item hud-o2');
  o2.setAttribute('role', 'meter');
  o2.setAttribute('aria-label', 'Oxygen');
  o2.setAttribute('aria-valuemin', '0');
  o2.setAttribute('aria-valuemax', '100');
  const o2Fill = mk('span', 'o2__fill');
  const o2Bar = mk('div', 'o2__bar');
  o2Bar.append(o2Fill);
  const o2Pct = mk('span', 'o2__pct', '100%');
  o2.append(mk('span', 'hud-cap', 'O2'), o2Bar, o2Pct);

  // Buttons
  const muteBtn = mk('button', 'hud-btn');
  muteBtn.type = 'button';
  const syncMute = () => {
    const muted = audio.isMuted();
    muteBtn.replaceChildren(speakerIcon(!muted));
    muteBtn.setAttribute('aria-pressed', String(muted));
    muteBtn.setAttribute('aria-label', muted ? 'Unmute sound' : 'Mute sound');
    muteBtn.title = muted ? 'Unmute' : 'Mute';
  };
  muteBtn.addEventListener('click', () => { audio.toggleMute(); syncMute(); });
  syncMute();

  const ariaBtn = mk('button', 'hud-btn hud-btn--text hud-btn--aria', 'ASK A.R.I.A');
  ariaBtn.type = 'button';
  ariaBtn.setAttribute('aria-label', 'Open the A.R.I.A terminal (C)');
  ariaBtn.title = 'Ask A.R.I.A (C)';
  ariaBtn.addEventListener('click', () => openChat());

  const cvBtn = mk('button', 'hud-btn hud-btn--text', 'CV');
  cvBtn.type = 'button';
  cvBtn.setAttribute('aria-label', 'View or download the CV');
  cvBtn.disabled = true; // unlocked when the station is at 100% power (see render)
  cvBtn.addEventListener('click', () => { if (getPowerPercent() === 100) openCv(); });

  const objBtn = mk('button', 'hud-btn hud-btn--text', 'MISSION');
  objBtn.type = 'button';
  objBtn.setAttribute('aria-expanded', 'true');
  objBtn.setAttribute('aria-controls', 'hud-objectives');

  hud.append(ring, rankBox, o2, objBtn, ariaBtn, cvBtn, muteBtn);

  // Objectives panel
  const obj = mk('aside', 'hud-objectives');
  obj.id = 'hud-objectives';
  obj.setAttribute('aria-label', 'Mission objectives');
  const objList = mk('ul', 'hud-objectives__list');
  objList.setAttribute('aria-live', 'polite');
  obj.append(mk('p', 'hud-objectives__title', 'OBJECTIVES'), objList);
  hud.append(obj);
  const setObjOpen = (open) => {
    obj.hidden = !open;
    objBtn.setAttribute('aria-expanded', String(open));
  };
  objBtn.addEventListener('click', () => setObjOpen(obj.hidden));
  setObjOpen(window.innerWidth >= 768);

  els = { hud, cvBtn, ring, fg, pct, badge, xpBar, xpFill, xpText, rankBox, o2, o2Fill, o2Pct, muteBtn, objList, setObjOpen };
}

/** Draw everything that depends on the saved state. */
function render() {
  const st = getState();
  const power = Math.round(getPowerPercent());
  els.fg.setAttribute('stroke-dashoffset', (RING_C * (1 - power / 100)).toFixed(2));
  els.pct.textContent = `${power}%`;
  els.ring.setAttribute('aria-valuenow', String(power));
  els.ring.classList.toggle('is-full', power === 100);

  const r = rankInfo(st.xp);
  els.badge.textContent = r.cur.name.toUpperCase();
  els.badge.dataset.tier = String(r.i);
  els.xpFill.style.width = `${Math.round(r.frac * 100)}%`;
  els.xpText.textContent = r.next ? `XP ${st.xp} / ${r.next.min}` : `XP ${st.xp} MAX`;
  els.xpBar.setAttribute('aria-valuemax', String(r.next ? r.next.min : st.xp));
  els.xpBar.setAttribute('aria-valuenow', String(st.xp));

  const o2 = Math.round(st.oxygen);
  els.o2Fill.style.width = `${o2}%`;
  els.o2Pct.textContent = `${o2}%`;
  els.o2.setAttribute('aria-valuenow', String(o2));
  els.o2.classList.toggle('is-low', o2 < 30 && o2 >= 15);
  els.o2.classList.toggle('is-critical', o2 < 15);

  els.cvBtn.disabled = power < 100;
  els.cvBtn.title = power < 100 ? 'CV unlocks at 100% station power' : 'View or download the CV';

  renderObjectives(st);
  syncBoss();
}

function renderObjectives(st) {
  const items = ROOM_OBJECTIVES.map(([room, text]) => ({ text, done: !!st.power[room] }));
  const full = getPowerPercent() === 100;
  if (full) {
    items.push({ text: 'Ask A.R.I.A one question to trace the rogue signal', done: st.achievements.includes('verdict') });
  }
  if (st.beaconUnlocked) items.push({ text: 'Enter the Comms Tower and send a message', done: false });
  const key = items.map((it) => `${it.done ? 1 : 0}${it.text}`).join('|');
  if (key === els.objKey) return;
  els.objKey = key;
  els.objList.replaceChildren(
    ...items.map((it) => {
      const li = mk('li', it.done ? 'is-done' : '');
      li.append(mk('span', 'obj-mark', it.done ? '[x]' : '[ ]'), mk('span', 'obj-text', it.text));
      return li;
    })
  );
}

// =====================================================================================
// XP popup and rank-up banner
// =====================================================================================
let lastRank = 0;

function xpPopup(amount, reason) {
  if (!started || !Number.isFinite(amount) || amount <= 0) return;
  const el = mk('span', 'xp-pop', `+${amount} XP`);
  if (reason) el.title = reason;
  el.setAttribute('aria-hidden', 'true');
  els.rankBox.append(el);
  if (reducedMotion) return void setTimeout(() => el.remove(), 1200);
  gsap.fromTo(el, { y: 0, opacity: 0 }, { y: 22, opacity: 1, duration: 0.3, ease: 'power2.out' });
  gsap.to(el, { y: 34, opacity: 0, delay: 0.9, duration: 0.5, onComplete: () => el.remove() });
}

function rankBanner(name) {
  const el = mk('div', 'rank-banner');
  el.setAttribute('role', 'status');
  el.append(mk('p', 'rank-banner__kicker', '// RANK UP'), mk('p', 'rank-banner__name', name.toUpperCase()));
  document.body.append(el);
  audio.play('win');
  if (reducedMotion) return void setTimeout(() => el.remove(), 2600);
  gsap.timeline({ onComplete: () => el.remove() })
    .fromTo(el, { opacity: 0, scale: 0.7, y: -30 }, { opacity: 1, scale: 1, y: 0, duration: 0.6, ease: 'back.out(1.8)' })
    .fromTo(el.querySelector('.rank-banner__name'), { letterSpacing: '0.8em' }, { letterSpacing: '0.18em', duration: 0.9, ease: 'power3.out' }, '<')
    .to(el, { opacity: 0, y: -20, duration: 0.5, ease: 'power2.in' }, '+=1.9');
}

function checkRankUp() {
  const i = rankInfo(getState().xp).i;
  if (i > lastRank && started) rankBanner(RANKS[i].name);
  lastRank = i;
}

// =====================================================================================
// Oxygen: slow drain, emergency refill at zero, collectible cells
// =====================================================================================
let refilling = false;
let ended = false; // true once the game-over screen is up: everything stops

/** At 100% power the station is stable: oxygen is full and frozen, XP is never touched again. */
const oxygenLocked = () => getPowerPercent() === 100;

/** At 0% oxygen: -20 XP, then back to 50%. If that takes XP to zero the run is over. */
function checkOxygenZero() {
  if (ended || refilling) return;
  const st = getState();
  if (oxygenLocked()) {
    if (st.oxygen < 100) update({ oxygen: 100 }); // full oxygen, XP stays exactly where it was
    return;
  }
  if (st.oxygen > 0) return;
  refilling = true;
  const xp = Math.max(0, st.xp - ZERO_O2_XP_PENALTY);
  if (xp <= 0) {
    update({ xp: 0, oxygen: 0 });
    refilling = false;
    return showGameOver();
  }
  update({ xp, oxygen: REFILL_TO });
  refilling = false;
  audio.play('lose');
  toast(`OXYGEN DEPLETED: -${ZERO_O2_XP_PENALTY} XP. Emergency reserves engaged (${REFILL_TO}%).`, 4500);
}

/** XP is finished: popup, then back to the ENTER STATION page with a fresh run. */
function showGameOver() {
  if (ended) return;
  ended = true;
  document.querySelectorAll('.modal-backdrop, .game-overlay, .rogue-overlay').forEach((n) => n.remove());
  const title = mk('h2', 'rogue__title', 'XP DEPLETED');
  title.id = 'gameover-title';
  const text = mk('p', 'rogue__text', 'Your XP has run out and the station lost its power. Return to the entry console and try again.');
  text.id = 'gameover-desc';
  const btn = mk('button', 'btn btn--warn', 'BACK TO ENTER STATION');
  btn.type = 'button';
  const actions = mk('div', 'rogue__actions');
  actions.append(btn);
  const box = mk('div', 'rogue__box');
  box.append(mk('p', 'rogue__kicker', '// MISSION FAILED'), title, text, actions);
  const overlay = mk('div', 'rogue-overlay gameover-overlay');
  overlay.setAttribute('role', 'alertdialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'gameover-title');
  overlay.setAttribute('aria-describedby', 'gameover-desc');
  overlay.append(box);
  document.body.append(overlay);
  ctx.input.setEnabled(false);
  audio.play('lose');
  const restart = () => {
    reset();
    location.hash = 'play'; // the reload lands on the ENTER STATION panel
    location.reload();
  };
  btn.addEventListener('click', restart);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); restart(); }
  }, true);
  btn.focus();
}

function startDrain() {
  let last = performance.now();
  let acc = 0;
  setInterval(() => {
    const now = performance.now();
    const dt = Math.min((now - last) / 1000, 2); // never catch up after a pause
    last = now;
    if (!started || ended || document.hidden || oxygenLocked()) return; // only while the tab is visible and the station is not at 100%
    acc += dt;
    while (acc >= DRAIN_EVERY_S) {
      acc -= DRAIN_EVERY_S;
      const o2 = getState().oxygen;
      if (o2 > 0) update({ oxygen: Math.max(0, o2 - 1) });
    }
  }, 1000);
}

// ---- oxygen cell collectibles ----
const cells = new Set();
let cellSeq = 0;
let glowTex = null;

function getGlowTexture() {
  if (glowTex) return glowTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 2, 32, 32, 32);
  grad.addColorStop(0, 'rgba(120,255,255,0.9)');
  grad.addColorStop(0.4, 'rgba(0,229,255,0.35)');
  grad.addColorStop(1, 'rgba(0,229,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  glowTex = new THREE.CanvasTexture(c);
  glowTex.colorSpace = THREE.SRGBColorSpace;
  return glowTex;
}

function removeCell(cell, animate) {
  if (!cells.has(cell)) return;
  cells.delete(cell);
  cell.tl?.kill();
  gsap.killTweensOf([cell.group.scale, cell.group.position, cell.group.rotation]);
  ctx?.input?.unregister(cell.id);
  const finish = () => {
    cell.scene.remove(cell.group);
    disposeObject(cell.group);
  };
  if (animate && !reducedMotion) gsap.to(cell.group.scale, { x: 0.01, y: 0.01, z: 0.01, duration: 0.25, ease: 'back.in(2)', onComplete: finish });
  else finish();
}

/**
 * Drop a floating oxygen cell into the scene. Clicking it (or Tab + Enter) restores 25% oxygen.
 * It drifts and spins, and disappears after 30 seconds or when the visitor changes room.
 * @param {THREE.Scene} scene
 * @param {THREE.Vector3} position world position
 * @returns {{ id: string, remove: Function } | null} null if the HUD input is not ready yet
 */
export function spawnOxygenCell(scene, position) {
  if (!ctx?.input || !scene || !position) return null;
  const id = `oxygen-cell:${++cellSeq}`;
  const group = new THREE.Group();
  group.position.copy(position);

  const hdr = new THREE.Color(0x00e5ff).multiplyScalar(1.8);
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.13, 0.28, 4, 12), new THREE.MeshBasicMaterial({ color: hdr }));
  const band = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.025, 8, 24), new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff6b2c).multiplyScalar(1.6) }));
  band.rotation.x = Math.PI / 2;
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: getGlowTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.8 }));
  halo.scale.setScalar(1.1);
  halo.userData.noPick = true;
  const hit = new THREE.Mesh(new THREE.SphereGeometry(0.55, 8, 6), new THREE.MeshBasicMaterial({ visible: false })); // easy to click
  group.add(body, band, halo, hit);
  scene.add(group);

  const cell = { id, group, scene, tl: null, timer: 0 };
  cells.add(cell);

  ctx.input.register(group, {
    id,
    label: () => `OXYGEN CELL: collect for +${CELL_REFILL}% oxygen`,
    onClick: () => {
      if (!cells.has(cell)) return;
      const o2 = getState().oxygen;
      update({ oxygen: Math.min(100, o2 + CELL_REFILL) });
      audio.play('powerOn');
      toast(`OXYGEN CELL COLLECTED: +${CELL_REFILL}%`, 2200);
      clearTimeout(cell.timer);
      removeCell(cell, true);
    },
  });

  if (!reducedMotion) {
    cell.tl = gsap.timeline();
    cell.tl.fromTo(group.scale, { x: 0.01, y: 0.01, z: 0.01 }, { x: 1, y: 1, z: 1, duration: 0.5, ease: 'back.out(2)' });
    gsap.to(group.position, { y: position.y + 0.25, duration: 1.8, yoyo: true, repeat: -1, ease: 'sine.inOut' });
    gsap.to(group.rotation, { y: Math.PI * 2, z: 0.5, duration: 6, repeat: -1, ease: 'none' });
  }
  cell.timer = setTimeout(() => removeCell(cell, true), CELL_LIFETIME_S * 1000);
  return { id, remove: () => { clearTimeout(cell.timer); removeCell(cell, false); } };
}

/** A cell somewhere in front of the current camera view. */
function spawnCellInView() {
  const cam = ctx.camera;
  const dir = new THREE.Vector3();
  cam.getWorldDirection(dir);
  const right = new THREE.Vector3().crossVectors(dir, cam.up).normalize();
  const pos = cam.position.clone()
    .addScaledVector(dir, 6 + Math.random() * 2)
    .addScaledVector(right, (Math.random() - 0.5) * 5)
    .addScaledVector(cam.up, (Math.random() - 0.5) * 2);
  pos.y = Math.max(pos.y, 0.8);
  return spawnOxygenCell(ctx.stage.scene, pos);
}

function initCells() {
  // A cell appears shortly after each room change when oxygen is not full (or by chance), and
  // every 40 seconds while oxygen is low.
  on('room:enter', () => {
    for (const c of [...cells]) { clearTimeout(c.timer); removeCell(c, false); }
    setTimeout(() => {
      if (!started || ended || oxygenLocked() || cells.size || overlayOpen()) return;
      if (getState().oxygen <= 70 || Math.random() < 0.3) spawnCellInView();
    }, 2800);
  });
  setInterval(() => {
    if (started && !ended && !oxygenLocked() && !document.hidden && !cells.size && !overlayOpen() && getState().oxygen < 50) spawnCellInView();
  }, 40000);
}

// =====================================================================================
// Final boss: ROGUE SIGNAL. One question to A.R.I.A (any question she can answer from the station logs)
// traces the signal and unlocks the Comms Tower.
// =====================================================================================
const bossState = { offline: false, probed: false, alertShown: false, chatErrors: 0 };
let boss = null;

const bossActive = () => getPowerPercent() === 100 && !getState().achievements.includes('verdict');
const BOSS_NOTE = 'MISSION: the rogue signal can be traced with ONE question. Ask me anything about Muhammad.';

async function probeUplink() {
  if (bossState.probed) return;
  bossState.probed = true;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 3000);
  try {
    const res = await fetch('/api/health', { signal: ctrl.signal });
    bossState.offline = !res.ok;
  } catch {
    bossState.offline = true;
  } finally {
    clearTimeout(t);
  }
  renderBoss();
}

/** Small status card (no text field: the question is asked in the A.R.I.A terminal itself). */
function buildBossPanel() {
  const el = mk('section', 'boss-panel');
  el.id = 'boss-panel';
  el.setAttribute('aria-label', 'Rogue signal mission');
  el.hidden = true;
  const head = mk('p', 'boss-panel__title', 'ROGUE SIGNAL DETECTED');
  const note = mk('p', 'boss-panel__note');
  note.setAttribute('role', 'status');
  const traceBtn = mk('button', 'btn btn--warn boss-trace', 'TRACE ROGUE SIGNAL');
  traceBtn.type = 'button';
  traceBtn.addEventListener('click', () => (getMeta().bossAccepted ? openChat({ note: BOSS_NOTE }) : showRogueAlert()));
  const manualBtn = mk('button', 'btn boss-trace', 'TRACE MANUALLY (A.R.I.A OFFLINE)');
  manualBtn.type = 'button';
  manualBtn.hidden = true;
  manualBtn.addEventListener('click', completeBoss);
  el.append(head, note, traceBtn, manualBtn);
  els.hud.append(el);
  boss = { el, head, note, traceBtn, manualBtn };
}

function renderBoss() {
  if (!boss) return;
  const on_ = bossActive();
  boss.el.hidden = !on_;
  if (!on_) return;
  const accepted = getMeta().bossAccepted;
  boss.traceBtn.textContent = accepted ? 'OPEN A.R.I.A TERMINAL' : 'TRACE ROGUE SIGNAL';
  boss.note.textContent = accepted
    ? 'Ask A.R.I.A one question about Muhammad to trace the signal.'
    : 'Unknown transmission is jamming the station comms.';
  // Fallback so the game can never get stuck: the uplink is down or A.R.I.A keeps failing
  boss.manualBtn.hidden = !(accepted && (bossState.offline || bossState.chatErrors >= 2));
}

function completeBoss() {
  if (!bossActive()) return;
  // Unlock the beacon first, so the hub sees it when it reacts to the achievement
  update({ beaconUnlocked: true });
  emit('achievement:unlock', { id: 'verdict' });
  toast('ROGUE SIGNAL TRACED: the Comms Tower is unlocked.', 5000);
  render();
}

function syncBoss() {
  renderBoss();
}

// ---- alert overlay ----
function showRogueAlert() {
  if (document.querySelector('.rogue-overlay')) return;
  const previousFocus = document.activeElement;
  const title = mk('h2', 'rogue__title', 'ALERT: ROGUE SIGNAL');
  title.id = 'rogue-title';
  const text = mk('p', 'rogue__text', "An unknown transmission is jamming the station's comms. Ask A.R.I.A one question about Muhammad to trace its source.");
  text.id = 'rogue-desc';
  const go = mk('button', 'btn btn--warn', 'TRACE SIGNAL');
  go.type = 'button';
  const later = mk('button', 'btn', 'LATER');
  later.type = 'button';
  const box = mk('div', 'rogue__box');
  box.append(mk('p', 'rogue__kicker', '// INCOMING TRANSMISSION'), title, text, mk('div', 'rogue__actions', ''));
  box.lastChild.append(go, later);
  const overlay = mk('div', 'rogue-overlay');
  overlay.setAttribute('role', 'alertdialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'rogue-title');
  overlay.setAttribute('aria-describedby', 'rogue-desc');
  overlay.append(box);
  document.body.append(overlay);
  ctx.input.setEnabled(false);
  audio.play('error');
  audio.play('flicker');
  if (!reducedMotion) gsap.fromTo(box, { opacity: 0, scale: 0.9 }, { opacity: 1, scale: 1, duration: 0.4, ease: 'back.out(1.6)' });

  const close = (accept) => {
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
    ctx.input.setEnabled(true);
    if (accept) {
      setMeta({ bossAccepted: true });
      probeUplink();
      renderBoss();
      renderObjectives(getState());
      openChat({ note: BOSS_NOTE }); // the question is asked in the real A.R.I.A terminal
    } else if (previousFocus?.focus) previousFocus.focus({ preventScroll: true });
  };
  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close(false);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      (document.activeElement === go ? later : go).focus();
    }
  }
  document.addEventListener('keydown', onKey, true);
  go.addEventListener('click', () => close(true));
  later.addEventListener('click', () => close(false));
  go.focus();
}

/** Show the alert once per session when the station reaches 100% power (waits for modals and games to close). */
function maybeAlert(tries = 0) {
  if (!started || ended || bossState.alertShown || !bossActive() || getMeta().bossAccepted) return;
  if (overlayOpen() && tries < 30) return void setTimeout(() => maybeAlert(tries + 1), 1500);
  bossState.alertShown = true;
  showRogueAlert();
}

function initBoss() {
  buildBossPanel();
  on('room:power', () => setTimeout(() => maybeAlert(), 2500));
  on('room:enter', () => setTimeout(() => maybeAlert(), 1500)); // also covers returning visitors already at 100%
  // The first answer A.R.I.A finds in the logs after the mission was accepted completes it
  on('chat:answer', ({ found }) => {
    if (!getMeta().bossAccepted || !bossActive() || !found) return;
    setTimeout(completeBoss, 1800); // let the visitor read the answer first
  });
  window.addEventListener('aria:error', () => { bossState.chatErrors++; renderBoss(); });
  if (getMeta().bossAccepted) probeUplink();
}

// =====================================================================================
// CV (unlocked at 100% power)
// =====================================================================================
const CV_URL = '/cv/Muhammad_Ahmed_Resume.pdf';

function openCv() {
  const body = mk('div', 'cv-viewer');
  if (window.innerWidth >= 768) {
    const frame = document.createElement('iframe');
    frame.className = 'cv-frame';
    frame.src = `${CV_URL}#toolbar=0&view=FitH`;
    frame.title = 'Muhammad Ahmed CV (PDF)';
    body.append(frame);
  } else {
    body.append(mk('p', 'modal__text', 'Tap a button below to read or save the CV.'));
  }
  const row = mk('div', 'cv-actions');
  const dl = mk('a', 'btn', 'DOWNLOAD CV');
  dl.href = CV_URL;
  dl.download = 'Muhammad_Ahmed_CV.pdf';
  const view = mk('a', 'btn', 'OPEN IN NEW TAB');
  view.href = CV_URL;
  view.target = '_blank';
  view.rel = 'noopener noreferrer';
  row.append(dl, view);
  body.append(row);
  openModal({ kicker: 'PERSONNEL FILE', title: 'MUHAMMAD AHMED: CV', content: body });
  document.querySelector('.modal')?.classList.add('modal--wide');
}

// =====================================================================================
// Init
// =====================================================================================
export function initHud(context) {
  if (ctx) return;
  ctx = context;
  buildBar();
  initAchievements();
  lastRank = rankInfo(getState().xp).i;

  subscribe(() => {
    checkOxygenZero();
    checkRankUp();
    render();
  });
  on('xp:add', ({ amount, reason }) => xpPopup(amount, reason));
  // Objectives are open in the hub and tucked away inside rooms (the MISSION button toggles them)
  on('room:enter', ({ room }) => { started = true; els.setObjOpen(room === 'hub' && window.innerWidth >= 768); });

  initBoss();
  initCells();
  startDrain();
  render();
  checkOxygenZero(); // a save that was stored at 0%
}
