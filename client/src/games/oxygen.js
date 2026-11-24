// OXYGEN mini-game ("Reactor stabilizer"): a bar sweeps along a track; stop it inside the
// green zone 5 times within 40 seconds. Each success speeds the bar up and narrows the zone;
// a miss costs 3 seconds. Keyboard (Space/Enter), mouse and touch all work.
// Win: emits 'game:win', 'room:power', 'xp:add'. Lose: costs 5 oxygen, then retry or abort.

import { emit } from '../core/events.js';
import { getState, update } from '../core/state.js';
import { audio } from '../core/audio.js';

const TIME_LIMIT = 40; // seconds
const NEEDED = 5; // successful stops to win
const MISS_PENALTY = 3; // seconds lost on a miss
const OXYGEN_COST = 5;
const WIN_XP = 60;
const START_SPEED = 0.6; // track lengths per second
const SPEED_GAIN = 1.15; // per success
const START_ZONE = 0.2; // fraction of the track
const ZONE_SHRINK = 0.88; // per success

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

/**
 * Open the game. Resolves true when won, false if aborted.
 * @param {{room?: string}} [opts] room that receives power on a win
 */
export function startOxygen({ room = 'skills' } = {}) {
  if (active) return active.promise;

  const previousFocus = document.activeElement;
  let resolveGame;
  const promise = new Promise((r) => { resolveGame = r; });

  // ---- DOM ----
  const timerFill = h('span', { class: 'game-timer-fill' });
  const timeText = h('span', { class: 'game-time', text: `${TIME_LIMIT}s` });
  const oxyText = h('span', { class: 'game-oxygen' });
  const pips = Array.from({ length: NEEDED }, () => h('span', { class: 'stab-pip' }));
  const zoneEl = h('div', { class: 'stab-zone' });
  const markerEl = h('div', { class: 'stab-marker' });
  const track = h('div', { class: 'stab-track', 'aria-hidden': 'true' }, zoneEl, markerEl);
  const stabBtn = h('button', { class: 'btn stab-btn', type: 'button', text: 'STABILIZE (SPACE)' });
  const msg = h('p', { class: 'game-msg', role: 'status', 'aria-live': 'assertive' });
  const retryBtn = h('button', { class: 'btn', type: 'button', text: 'RETRY' });
  const abortBtn = h('button', { class: 'btn btn--warn', type: 'button', text: 'ABORT' });
  retryBtn.hidden = true;

  const panel = h(
    'div', { class: 'game-panel' },
    h('p', { class: 'game-kicker', text: '// REACTOR STABILIZER' }),
    h('h2', { id: 'oxygen-title', text: 'Stabilize the core' }),
    h('p', { class: 'game-hint', text: `Stop the bar inside the green zone ${NEEDED} times. Press Space or Enter, click, or tap. A miss costs ${MISS_PENALTY} seconds.` }),
    h('div', { class: 'game-hud' }, h('div', { class: 'game-timer' }, timerFill), timeText, oxyText),
    h('div', { class: 'stab-pips', role: 'img', 'aria-label': 'Stabilization progress' }, ...pips),
    track, stabBtn, msg,
    h('div', { class: 'game-actions' }, retryBtn, abortBtn)
  );
  const overlay = h('div', { class: 'game-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'oxygen-title' }, panel);
  document.body.appendChild(overlay);

  // ---- game state ----
  let pos = 0; // marker position, 0..1
  let dir = 1;
  let speed = START_SPEED;
  let zone = { start: 0.4, width: START_ZONE };
  let hits = 0;
  let remaining = TIME_LIMIT;
  let running = false;
  let rafId = 0;
  let last = 0;
  let lastStop = 0;
  let closed = false;

  const refreshOxygen = () => { oxyText.textContent = `O2 ${Math.round(getState().oxygen)}%`; };
  const say = (t) => { msg.textContent = t; };

  function flash(el, cls) {
    el.classList.remove(cls);
    void el.getBoundingClientRect(); // restart the CSS animation
    el.classList.add(cls);
  }

  function placeZone() {
    zoneEl.style.left = `${zone.start * 100}%`;
    zoneEl.style.width = `${zone.width * 100}%`;
  }

  /** New zone away from the marker so the next stop is never free. */
  function newZone() {
    const width = START_ZONE * ZONE_SHRINK ** hits;
    let start = Math.random() * (1 - width);
    for (let i = 0; i < 10 && Math.abs(start + width / 2 - pos) < 0.2; i++) start = Math.random() * (1 - width);
    zone = { start, width };
    placeZone();
  }

  function newAttempt() {
    pos = 0;
    dir = 1;
    speed = START_SPEED;
    hits = 0;
    remaining = TIME_LIMIT;
    running = true;
    pips.forEach((p) => p.classList.remove('is-on'));
    retryBtn.hidden = true;
    stabBtn.disabled = false;
    say('');
    newZone();
    refreshOxygen();
    last = performance.now();
    cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(tick);
    stabBtn.focus({ preventScroll: true });
  }

  function tick(now) {
    if (!running) return;
    rafId = requestAnimationFrame(tick);
    const dt = Math.min((now - last) / 1000, 0.1); // a hidden tab does not eat the clock
    last = now;
    pos += dir * speed * dt;
    if (pos >= 1) { pos = 1; dir = -1; }
    else if (pos <= 0) { pos = 0; dir = 1; }
    markerEl.style.left = `${pos * 100}%`;
    remaining -= dt;
    timeText.textContent = `${Math.max(0, Math.ceil(remaining))}s`;
    timerFill.style.width = `${Math.max(0, (remaining / TIME_LIMIT) * 100)}%`;
    overlay.classList.toggle('is-urgent', remaining < 10);
    if (remaining <= 0) lose();
  }

  /** Player input: stop the bar and judge the position. */
  function stop() {
    const now = performance.now();
    if (!running || now - lastStop < 120) return; // ignore key repeat and double taps
    lastStop = now;
    if (pos >= zone.start && pos <= zone.start + zone.width) {
      hits++;
      pips[hits - 1].classList.add('is-on');
      audio.play('click');
      flash(zoneEl, 'is-hit');
      say(`STABILIZED ${hits} OF ${NEEDED}`);
      if (hits >= NEEDED) { win(); return; }
      speed *= SPEED_GAIN;
      newZone();
    } else {
      remaining -= MISS_PENALTY;
      audio.play('error');
      flash(markerEl, 'is-miss');
      say(`MISSED: -${MISS_PENALTY} SECONDS`);
    }
  }

  function win() {
    running = false;
    cancelAnimationFrame(rafId);
    stabBtn.disabled = true;
    say('REACTOR STABILIZED');
    emit('game:win', { game: 'oxygen' });
    emit('room:power', { room });
    emit('xp:add', { amount: WIN_XP, reason: 'Oxygen mini-game' });
    setTimeout(() => close(true), 1100);
  }

  function lose() {
    running = false;
    cancelAnimationFrame(rafId);
    stabBtn.disabled = true;
    update({ oxygen: Math.max(0, getState().oxygen - OXYGEN_COST) });
    refreshOxygen();
    emit('game:lose', { game: 'oxygen' });
    say(`CORE UNSTABLE. -${OXYGEN_COST} OXYGEN. Retry or abort.`);
    retryBtn.hidden = false;
    retryBtn.focus();
  }

  function close(won) {
    if (closed) return;
    closed = true;
    running = false;
    cancelAnimationFrame(rafId);
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
    active = null;
    if (previousFocus && previousFocus.focus) previousFocus.focus({ preventScroll: true });
    resolveGame(!!won);
  }

  // ---- input: mouse + touch (pointerdown fires instantly on both) ----
  for (const el of [track, stabBtn]) {
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      stop();
    });
  }
  stabBtn.addEventListener('click', (e) => e.preventDefault()); // pointerdown already handled it

  // ---- input: keyboard (Space/Enter stop the bar, Escape aborts, Tab stays inside) ----
  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close(false);
    } else if (e.key === ' ' || e.key === 'Enter') {
      const onOtherButton = e.target.closest?.('button') && e.target !== stabBtn;
      if (onOtherButton || !running) return; // let Retry / Abort work normally
      e.preventDefault();
      if (!e.repeat) stop();
    } else if (e.key === 'Tab') {
      const f = [...overlay.querySelectorAll('button:not([hidden]):not(:disabled)')];
      if (!f.length) return;
      const first = f[0];
      const lastEl = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); lastEl.focus(); }
      else if (!e.shiftKey && document.activeElement === lastEl) { e.preventDefault(); first.focus(); }
    }
  }
  document.addEventListener('keydown', onKey, true);

  retryBtn.addEventListener('click', newAttempt);
  abortBtn.addEventListener('click', () => close(false));

  active = { promise };
  newAttempt();
  return promise;
}
