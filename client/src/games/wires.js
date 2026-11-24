// WIRES mini-game: connect 4 coloured wires from the left plugs to the matching right sockets
// within 40 seconds. Works with mouse drag, touch drag, tap-tap and the keyboard (Tab + Enter).
// Win: emits 'game:win', 'room:power', 'xp:add'. Lose: costs 5 oxygen, then retry or abort.

import { emit } from '../core/events.js';
import { getState, update } from '../core/state.js';
import { audio } from '../core/audio.js';

const TIME_LIMIT = 40; // seconds
const OXYGEN_COST = 5;
const WIN_XP = 60;
const SVG_NS = 'http://www.w3.org/2000/svg';
const W = 640;
const H = 380;
const LX = 70; // left plug x
const RX = 570; // right socket x
const rowY = (i) => 62 + i * 86;

const COLORS = [
  { hex: '#00E5FF', name: 'cyan' },
  { hex: '#FF6B2C', name: 'orange' },
  { hex: '#FFD23F', name: 'yellow' },
  { hex: '#FF3EA5', name: 'magenta' },
];

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
function s(tag, props = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const k in props) el.setAttribute(k, props[k]);
  return el;
}

function shuffleOrder() {
  const a = [0, 1, 2, 3];
  do {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
  } while (a.every((v, i) => v === i)); // never hand out the solved layout
  return a;
}

const wirePath = (x1, y1, x2, y2) => `M${x1} ${y1} C${x1 + 210} ${y1}, ${x2 - 210} ${y2}, ${x2} ${y2}`;

/**
 * Open the game. Resolves true when won, false if aborted.
 * @param {{room?: string}} [opts] room that receives power on a win
 */
export function startWires({ room = 'projects' } = {}) {
  if (active) return active.promise;

  const previousFocus = document.activeElement;
  let resolveGame;
  const promise = new Promise((r) => { resolveGame = r; });

  // ---- DOM ----
  const timerFill = h('span', { class: 'game-timer-fill' });
  const timeText = h('span', { class: 'game-time', text: `${TIME_LIMIT}s` });
  const oxyText = h('span', { class: 'game-oxygen' });
  const msg = h('p', { class: 'game-msg', role: 'status', 'aria-live': 'assertive' });
  const retryBtn = h('button', { class: 'btn', type: 'button', text: 'RETRY' });
  const abortBtn = h('button', { class: 'btn btn--warn', type: 'button', text: 'ABORT' });
  retryBtn.hidden = true;

  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'game-svg', role: 'group', 'aria-label': 'Wire panel' });
  const wiresLayer = s('g');
  const termLayer = s('g');
  svg.append(s('rect', { x: 20, y: 10, width: W - 40, height: H - 20, rx: 10, class: 'game-board' }), wiresLayer, termLayer);

  const panel = h(
    'div', { class: 'game-panel' },
    h('p', { class: 'game-kicker', text: '// POWER PANEL' }),
    h('h2', { id: 'wires-title', text: 'Reroute power' }),
    h('p', { class: 'game-hint', text: 'Drag each wire to the socket of the same colour, or tap a plug then a socket. Keyboard: Tab to a plug, press Enter, then Tab to a socket and press Enter.' }),
    h('div', { class: 'game-hud' }, h('div', { class: 'game-timer' }, timerFill), timeText, oxyText),
    svg, msg,
    h('div', { class: 'game-actions' }, retryBtn, abortBtn)
  );
  const overlay = h('div', { class: 'game-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'wires-title' }, panel);
  document.body.appendChild(overlay);

  // ---- game state ----
  let rightOrder = [];
  let connections = new Map(); // left index -> right slot
  let selected = null; // left index chosen by tap or keyboard
  let drag = null; // { i, x, y, sx, sy, moved }
  let remaining = TIME_LIMIT;
  let running = false;
  let rafId = 0;
  let last = 0;
  let closed = false;
  const termEls = { left: [], right: [] };

  const refreshOxygen = () => { oxyText.textContent = `O2 ${Math.round(getState().oxygen)}%`; };

  function svgPoint(e) {
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    return pt.matrixTransform(svg.getScreenCTM().inverse());
  }

  function drawWire(i, x2, y2, extra = '') {
    const c = COLORS[i].hex;
    const d = wirePath(LX, rowY(i), RX === x2 ? RX : x2, y2);
    const g = s('g', { class: `game-wire ${extra}` });
    g.append(
      s('path', { d, stroke: '#05070D', 'stroke-width': 13, fill: 'none', 'stroke-linecap': 'round' }),
      s('path', { d, stroke: c, 'stroke-width': 7, fill: 'none', 'stroke-linecap': 'round' }),
      s('path', { d, stroke: '#ffffff', 'stroke-opacity': 0.35, 'stroke-width': 2, fill: 'none', 'stroke-linecap': 'round' })
    );
    wiresLayer.appendChild(g);
  }

  function renderWires() {
    wiresLayer.replaceChildren();
    for (const [i, j] of connections) drawWire(i, RX, rowY(j));
    if (drag) drawWire(drag.i, drag.x, drag.y, 'dragging');
  }

  function updateLabels() {
    termEls.left.forEach((g, i) => {
      const linked = connections.has(i);
      g.setAttribute('aria-label', `Left plug, ${COLORS[i].name} wire, ${linked ? 'connected' : selected === i ? 'selected' : 'not connected'}`);
      g.classList.toggle('is-selected', selected === i);
      g.classList.toggle('is-done', linked);
    });
    termEls.right.forEach((g, j) => {
      const linked = [...connections.values()].includes(j);
      g.setAttribute('aria-label', `Right socket, ${COLORS[rightOrder[j]].name}, ${linked ? 'connected' : 'open'}`);
      g.classList.toggle('is-done', linked);
    });
  }

  function flash(el) {
    el.classList.remove('is-error');
    void el.getBoundingClientRect(); // restart the CSS animation
    el.classList.add('is-error');
  }

  function say(text) { msg.textContent = text; }

  function tryConnect(i, j) {
    if (!running || connections.has(i) || [...connections.values()].includes(j)) return;
    if (rightOrder[j] !== i) {
      audio.play('error');
      flash(termEls.right[j]);
      flash(termEls.left[i]);
      say('WRONG SOCKET. Match the colours.');
      return;
    }
    connections.set(i, j);
    selected = null;
    audio.play('click');
    say('');
    renderWires();
    updateLabels();
    if (connections.size === COLORS.length) win();
  }

  function buildTerminals() {
    termLayer.replaceChildren();
    termEls.left = [];
    termEls.right = [];
    COLORS.forEach((c, i) => {
      const g = s('g', { class: 'game-term', tabindex: 0, role: 'button', 'data-side': 'left', 'data-idx': i });
      g.append(
        s('circle', { cx: LX, cy: rowY(i), r: 30, fill: 'transparent' }), // generous touch target
        s('circle', { cx: LX, cy: rowY(i), r: 17, fill: '#0a1018', stroke: c.hex, 'stroke-width': 4, class: 'game-plug' }),
        s('circle', { cx: LX, cy: rowY(i), r: 6, fill: c.hex })
      );
      termLayer.appendChild(g);
      termEls.left.push(g);
    });
    rightOrder.forEach((ci, j) => {
      const c = COLORS[ci];
      const g = s('g', { class: 'game-term', tabindex: 0, role: 'button', 'data-side': 'right', 'data-idx': j });
      g.append(
        s('circle', { cx: RX, cy: rowY(j), r: 30, fill: 'transparent' }),
        s('rect', { x: RX - 15, y: rowY(j) - 15, width: 30, height: 30, rx: 5, fill: '#0a1018', stroke: c.hex, 'stroke-width': 4, class: 'game-plug' }),
        s('rect', { x: RX - 5, y: rowY(j) - 5, width: 10, height: 10, rx: 2, fill: c.hex })
      );
      termLayer.appendChild(g);
      termEls.right.push(g);
    });
  }

  function newAttempt() {
    rightOrder = shuffleOrder();
    connections = new Map();
    selected = null;
    drag = null;
    remaining = TIME_LIMIT;
    running = true;
    retryBtn.hidden = true;
    say('');
    buildTerminals();
    renderWires();
    updateLabels();
    refreshOxygen();
    last = performance.now();
    cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(tick);
    termEls.left[0].focus({ preventScroll: true });
  }

  function tick(now) {
    if (!running) return;
    rafId = requestAnimationFrame(tick);
    const dt = Math.min((now - last) / 1000, 0.1); // paused tabs do not eat the clock
    last = now;
    remaining -= dt;
    const shown = Math.max(0, Math.ceil(remaining));
    timeText.textContent = `${shown}s`;
    timerFill.style.width = `${Math.max(0, (remaining / TIME_LIMIT) * 100)}%`;
    overlay.classList.toggle('is-urgent', remaining < 10);
    if (remaining <= 0) lose();
  }

  function win() {
    running = false;
    cancelAnimationFrame(rafId);
    say('POWER RESTORED');
    emit('game:win', { game: 'wires' });
    emit('room:power', { room });
    emit('xp:add', { amount: WIN_XP, reason: 'Wires mini-game' });
    setTimeout(() => close(true), 1100);
  }

  function lose() {
    running = false;
    cancelAnimationFrame(rafId);
    drag = null;
    renderWires();
    update({ oxygen: Math.max(0, getState().oxygen - OXYGEN_COST) });
    refreshOxygen();
    emit('game:lose', { game: 'wires' });
    say(`CIRCUIT OVERLOAD. -${OXYGEN_COST} OXYGEN. Retry or abort.`);
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

  // ---- input: pointer (mouse + touch) ----
  svg.addEventListener('pointerdown', (e) => {
    if (!running) return;
    const t = e.target.closest('[data-side]');
    if (!t) return;
    const side = t.dataset.side;
    const idx = Number(t.dataset.idx);
    if (side === 'right') {
      if (selected !== null) tryConnect(selected, idx);
      return;
    }
    if (connections.has(idx)) return;
    e.preventDefault();
    const p = svgPoint(e);
    drag = { i: idx, x: p.x, y: p.y, sx: p.x, sy: p.y, moved: false };
    svg.setPointerCapture(e.pointerId);
    renderWires();
  });
  svg.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const p = svgPoint(e);
    drag.x = p.x;
    drag.y = p.y;
    if (Math.hypot(p.x - drag.sx, p.y - drag.sy) > 8) drag.moved = true;
    renderWires();
  });
  const endDrag = (e) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    const hit = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-side="right"]');
    if (d.moved && hit) tryConnect(d.i, Number(hit.dataset.idx));
    else if (!d.moved) selected = selected === d.i ? null : d.i; // plain tap selects the plug
    renderWires();
    updateLabels();
  };
  svg.addEventListener('pointerup', endDrag);
  svg.addEventListener('pointercancel', () => { drag = null; renderWires(); });

  // ---- input: keyboard ----
  svg.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const t = e.target.closest?.('[data-side]');
    if (!t || !running) return;
    e.preventDefault();
    const idx = Number(t.dataset.idx);
    if (t.dataset.side === 'left') {
      if (!connections.has(idx)) selected = selected === idx ? null : idx;
      updateLabels();
    } else if (selected !== null) {
      tryConnect(selected, idx);
    }
  });

  // Escape aborts; Tab stays inside the dialog
  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close(false);
    } else if (e.key === 'Tab') {
      const f = [...overlay.querySelectorAll('button:not([hidden]), [tabindex="0"]')];
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
