// ASTEROIDS mini-game ("Debris field"): dodge incoming asteroids in zero gravity for 30 seconds.
// Controls: arrow keys / WASD (drifting ship with inertia) or drag a finger / mouse on the board.
// Win: emits 'game:win', 'room:power', 'xp:add'. Lose (any collision): costs 5 oxygen, then retry or abort.

import { emit } from '../core/events.js';
import { getState, update } from '../core/state.js';
import { audio } from '../core/audio.js';

const TIME_LIMIT = 10; // seconds to survive
const OXYGEN_COST = 5;
const WIN_XP = 60;
const W = 640; // logical board size (scaled by CSS)
const H = 400;
const SHIP_R = 9; // drawn size
const HIT_R = 7; // forgiving collision radius for the ship
const ACCEL = 900; // px/s^2 from the arrow keys
const DRAG = 1.6; // slow velocity damping so the ship still drifts
const MAX_SPEED = 330;
const GRACE = 1.2; // seconds of invulnerability at the start
const MAX_ROCKS = 22;
const DODGE_POINTS = 5;
const SECOND_POINTS = 10;

const KEYS = {
  ArrowLeft: 'l', a: 'l', A: 'l',
  ArrowRight: 'r', d: 'r', D: 'r',
  ArrowUp: 'u', w: 'u', W: 'u',
  ArrowDown: 'd', s: 'd', S: 'd',
};

let active = null; // only one game at a time

/** Tiny DOM helper. */
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const k in props) {
    if (k === 'class') el.className = props[k];
    else if (k === 'text') el.textContent = props[k];
    else el.setAttribute(k, props[k]);
  }
  for (const kid of kids) if (kid) el.append(kid);
  return el;
}

const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/** An irregular rock polygon: radius jitter per vertex. */
function makeRock(ship, elapsed) {
  const r = rand(11, 30);
  const side = Math.floor(Math.random() * 4); // 0 top, 1 right, 2 bottom, 3 left
  const m = r + 6;
  let x;
  let y;
  if (side === 0) { x = rand(0, W); y = -m; }
  else if (side === 1) { x = W + m; y = rand(0, H); }
  else if (side === 2) { x = rand(0, W); y = H + m; }
  else { x = -m; y = rand(0, H); }
  // Aim near the ship with some spread, so the field is threatening but dodgeable
  const tx = ship.x + rand(-90, 90);
  const ty = ship.y + rand(-70, 70);
  const d = Math.hypot(tx - x, ty - y) || 1;
  const speed = rand(70, 120) + elapsed * 3.2; // gets faster as time passes
  const n = 9;
  return {
    x, y, r,
    vx: ((tx - x) / d) * speed,
    vy: ((ty - y) / d) * speed,
    rot: rand(0, Math.PI * 2),
    spin: rand(-1.5, 1.5),
    shape: Array.from({ length: n }, () => rand(0.75, 1.1)),
    counted: false,
  };
}

/**
 * Open the game. Resolves true when won, false if aborted.
 * @param {{room?: string}} [opts] room that receives power on a win
 */
export function startAsteroids({ room = 'education' } = {}) {
  if (active) return active.promise;

  const previousFocus = document.activeElement;
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  let resolveGame;
  const promise = new Promise((r) => { resolveGame = r; });

  // ---- DOM ----
  const timerFill = h('span', { class: 'game-timer-fill' });
  const timeText = h('span', { class: 'game-time', text: `${TIME_LIMIT}s` });
  const scoreText = h('span', { class: 'ast-score', text: 'SCORE 0' });
  const oxyText = h('span', { class: 'game-oxygen' });
  const canvas = h('canvas', { class: 'ast-board', 'aria-hidden': 'true' });
  const msg = h('p', { class: 'game-msg', role: 'status', 'aria-live': 'assertive' });
  const retryBtn = h('button', { class: 'btn', type: 'button', text: 'RETRY' });
  const abortBtn = h('button', { class: 'btn btn--warn', type: 'button', text: 'ABORT' });
  retryBtn.hidden = true;

  const panel = h(
    'div', { class: 'game-panel' },
    h('p', { class: 'game-kicker', text: '// DEBRIS FIELD' }),
    h('h2', { id: 'asteroids-title', text: 'Dodge the asteroids' }),
    h('p', { class: 'game-hint', text: `Survive ${TIME_LIMIT} seconds. Move with the arrow keys or WASD, or drag on the board. Any hit ends the run.` }),
    h('div', { class: 'game-hud' }, h('div', { class: 'game-timer' }, timerFill), timeText, scoreText, oxyText),
    canvas, msg,
    h('div', { class: 'game-actions' }, retryBtn, abortBtn)
  );
  const overlay = h('div', { class: 'game-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'asteroids-title' }, panel);
  document.body.appendChild(overlay);

  // Crisp canvas: backing store scaled by devicePixelRatio (max 2)
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);

  const stars = Array.from({ length: 60 }, () => ({ x: rand(0, W), y: rand(0, H), s: rand(0.5, 1.8), v: rand(4, 18) }));

  // ---- game state ----
  const ship = { x: W / 2, y: H / 2, vx: 0, vy: 0 };
  let rocks = [];
  let elapsed = 0;
  let remaining = TIME_LIMIT;
  let spawnT = 0;
  let dodged = 0;
  let score = 0;
  let running = false;
  let rafId = 0;
  let last = 0;
  let closed = false;
  const held = { l: false, r: false, u: false, d: false };
  let pointer = null; // { target: {x, y}, offX, offY } while dragging

  const refreshOxygen = () => { oxyText.textContent = `O2 ${Math.round(getState().oxygen)}%`; };
  const say = (t) => { msg.textContent = t; };

  function newAttempt() {
    Object.assign(ship, { x: W / 2, y: H / 2, vx: 0, vy: 0 });
    rocks = [];
    elapsed = 0;
    remaining = TIME_LIMIT;
    spawnT = 0.4;
    dodged = 0;
    score = 0;
    running = true;
    pointer = null;
    for (const k in held) held[k] = false;
    overlay.classList.remove('is-urgent', 'ast-hit');
    retryBtn.hidden = true;
    say('');
    refreshOxygen();
    last = performance.now();
    cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(tick);
    canvas.focus?.({ preventScroll: true });
  }

  function tick(now) {
    if (!running) return;
    rafId = requestAnimationFrame(tick);
    const dt = Math.min((now - last) / 1000, 0.05); // a hidden tab does not eat the clock
    last = now;
    step(dt);
    draw();
  }

  function step(dt) {
    elapsed += dt;
    remaining -= dt;
    score = Math.floor(elapsed * SECOND_POINTS) + dodged * DODGE_POINTS;
    timeText.textContent = `${Math.max(0, Math.ceil(remaining))}s`;
    timerFill.style.width = `${Math.max(0, (remaining / TIME_LIMIT) * 100)}%`;
    scoreText.textContent = `SCORE ${score}`;
    overlay.classList.toggle('is-urgent', remaining < 8);

    // Ship: finger/mouse drag follows the pointer; keys add thrust and keep drifting
    if (pointer) {
      const k = 1 - Math.exp(-dt * 20);
      const nx = clamp(pointer.target.x, SHIP_R, W - SHIP_R);
      const ny = clamp(pointer.target.y, SHIP_R, H - SHIP_R);
      ship.vx = (nx - ship.x) / Math.max(dt, 0.001) * k;
      ship.vy = (ny - ship.y) / Math.max(dt, 0.001) * k;
      ship.x += (nx - ship.x) * k;
      ship.y += (ny - ship.y) * k;
    } else {
      ship.vx += ((held.r ? 1 : 0) - (held.l ? 1 : 0)) * ACCEL * dt;
      ship.vy += ((held.d ? 1 : 0) - (held.u ? 1 : 0)) * ACCEL * dt;
      const damp = Math.exp(-DRAG * dt);
      ship.vx *= damp;
      ship.vy *= damp;
      const sp = Math.hypot(ship.vx, ship.vy);
      if (sp > MAX_SPEED) { ship.vx *= MAX_SPEED / sp; ship.vy *= MAX_SPEED / sp; }
      ship.x += ship.vx * dt;
      ship.y += ship.vy * dt;
      // Soft walls: bounce gently instead of leaving the board
      if (ship.x < SHIP_R) { ship.x = SHIP_R; ship.vx = Math.abs(ship.vx) * 0.4; }
      if (ship.x > W - SHIP_R) { ship.x = W - SHIP_R; ship.vx = -Math.abs(ship.vx) * 0.4; }
      if (ship.y < SHIP_R) { ship.y = SHIP_R; ship.vy = Math.abs(ship.vy) * 0.4; }
      if (ship.y > H - SHIP_R) { ship.y = H - SHIP_R; ship.vy = -Math.abs(ship.vy) * 0.4; }
    }

    // Spawning: faster and faster
    spawnT -= dt;
    if (spawnT <= 0 && rocks.length < MAX_ROCKS) {
      rocks.push(makeRock(ship, elapsed));
      spawnT = Math.max(0.28, 0.75 - elapsed * 0.015);
    }

    // Rocks: move, spin, score when they leave, collide with the ship
    for (let i = rocks.length - 1; i >= 0; i--) {
      const a = rocks[i];
      a.x += a.vx * dt;
      a.y += a.vy * dt;
      a.rot += a.spin * dt;
      const inside = a.x > -a.r && a.x < W + a.r && a.y > -a.r && a.y < H + a.r;
      if (inside) a.counted = true;
      if (!inside && a.counted) {
        // left the board after crossing it: that is a dodge
        dodged++;
        rocks.splice(i, 1);
        continue;
      }
      if (elapsed > GRACE && Math.hypot(a.x - ship.x, a.y - ship.y) < a.r * 0.9 + HIT_R) {
        lose();
        return;
      }
    }

    // Starfield drifts slowly (frozen for reduced motion)
    if (!reduced) {
      for (const s of stars) {
        s.y += s.v * dt;
        if (s.y > H) { s.y = 0; s.x = rand(0, W); }
      }
    }
    if (remaining <= 0) win();
  }

  function draw() {
    g.clearRect(0, 0, W, H);
    g.fillStyle = '#05090f';
    g.fillRect(0, 0, W, H);
    g.fillStyle = '#6f8c97';
    for (const s of stars) g.fillRect(s.x, s.y, s.s, s.s);

    // Asteroids
    g.lineWidth = 2;
    g.strokeStyle = '#FF6B2C';
    g.fillStyle = 'rgba(255,107,44,0.12)';
    for (const a of rocks) {
      g.beginPath();
      a.shape.forEach((k, i) => {
        const ang = a.rot + (i / a.shape.length) * Math.PI * 2;
        const px = a.x + Math.cos(ang) * a.r * k;
        const py = a.y + Math.sin(ang) * a.r * k;
        if (i === 0) g.moveTo(px, py);
        else g.lineTo(px, py);
      });
      g.closePath();
      g.fill();
      g.stroke();
    }

    // Ship: triangle pointing along its motion (up when still), blinking during the grace period
    const blink = elapsed < GRACE && Math.floor(elapsed * 10) % 2 === 0;
    if (!blink) {
      const sp = Math.hypot(ship.vx, ship.vy);
      const ang = sp > 20 ? Math.atan2(ship.vy, ship.vx) : -Math.PI / 2;
      g.save();
      g.translate(ship.x, ship.y);
      g.rotate(ang);
      g.shadowColor = '#00E5FF';
      g.shadowBlur = 12;
      g.fillStyle = '#00E5FF';
      g.beginPath();
      g.moveTo(SHIP_R + 3, 0);
      g.lineTo(-SHIP_R, SHIP_R * 0.75);
      g.lineTo(-SHIP_R * 0.5, 0);
      g.lineTo(-SHIP_R, -SHIP_R * 0.75);
      g.closePath();
      g.fill();
      g.restore();
    }
  }

  function win() {
    running = false;
    cancelAnimationFrame(rafId);
    draw();
    say(`DEBRIS FIELD CLEARED. SCORE ${score}`);
    audio.play('win');
    emit('game:win', { game: 'asteroids' });
    emit('room:power', { room });
    emit('xp:add', { amount: WIN_XP, reason: 'Asteroids mini-game' });
    setTimeout(() => close(true), 1300);
  }

  function lose() {
    running = false;
    cancelAnimationFrame(rafId);
    draw();
    overlay.classList.add('ast-hit');
    audio.play('error');
    update({ oxygen: Math.max(0, getState().oxygen - OXYGEN_COST) });
    refreshOxygen();
    emit('game:lose', { game: 'asteroids' });
    say(`HULL BREACH at ${Math.floor(elapsed)}s. SCORE ${score}. -${OXYGEN_COST} OXYGEN. Retry or abort.`);
    retryBtn.hidden = false;
    retryBtn.focus();
  }

  function close(won) {
    if (closed) return;
    closed = true;
    running = false;
    cancelAnimationFrame(rafId);
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('keyup', onKeyUp, true);
    window.removeEventListener('blur', releaseKeys);
    overlay.remove();
    active = null;
    if (previousFocus && previousFocus.focus) previousFocus.focus({ preventScroll: true });
    resolveGame(!!won);
  }

  // ---- input: touch / mouse drag. The ship keeps its offset from the finger, so it is never hidden under it ----
  const toBoard = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
  };
  canvas.addEventListener('pointerdown', (e) => {
    if (!running) return;
    e.preventDefault();
    canvas.setPointerCapture?.(e.pointerId);
    const p = toBoard(e);
    pointer = { id: e.pointerId, target: { x: ship.x, y: ship.y }, offX: ship.x - p.x, offY: ship.y - p.y };
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!pointer || e.pointerId !== pointer.id) return;
    const p = toBoard(e);
    pointer.target.x = p.x + pointer.offX;
    pointer.target.y = p.y + pointer.offY;
  });
  const endPointer = (e) => { if (pointer && e.pointerId === pointer.id) pointer = null; };
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);

  // ---- input: keyboard (arrows/WASD move, Escape aborts, Tab stays inside) ----
  function releaseKeys() { for (const k in held) held[k] = false; }
  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close(false);
    } else if (KEYS[e.key]) {
      e.preventDefault(); // stop the page from scrolling
      if (running) held[KEYS[e.key]] = true;
    } else if (e.key === 'Tab') {
      const f = [...overlay.querySelectorAll('button:not([hidden]):not(:disabled)')];
      if (!f.length) { e.preventDefault(); return; }
      const first = f[0];
      const lastEl = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); lastEl.focus(); }
      else if (!e.shiftKey && document.activeElement === lastEl) { e.preventDefault(); first.focus(); }
    }
  }
  function onKeyUp(e) {
    if (KEYS[e.key]) held[KEYS[e.key]] = false;
  }
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('keyup', onKeyUp, true);
  window.addEventListener('blur', releaseKeys);

  retryBtn.addEventListener('click', newAttempt);
  abortBtn.addEventListener('click', () => close(false));

  active = { promise };
  newAttempt();
  return promise;
}
