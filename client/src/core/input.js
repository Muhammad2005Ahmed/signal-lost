// Input: pointer raycasting, hover highlight state, click events and keyboard access.
// Keyboard users Tab through hidden proxy buttons (one per interactive object) and press
// Enter/Space; focus shows the same tooltip and highlight as mouse hover plus a focus ring.
// Press D anywhere (outside text fields) to print the game state to the console.

import * as THREE from 'three';
import { getState, getPowerPercent } from './state.js';

const _box = new THREE.Box3();
const _v = new THREE.Vector3();

/** True when the object and all its parents are visible. */
function visibleChain(obj) {
  for (let o = obj; o; o = o.parent) if (!o.visible) return false;
  return true;
}

/** Walk up from a hit object to the registered root and return its input id. */
function idOf(obj) {
  for (let o = obj; o; o = o.parent) if (o.userData && o.userData.inputId) return o.userData.inputId;
  return null;
}

/**
 * @param {{canvas: HTMLCanvasElement, camera: THREE.Camera}} opts
 */
export function createInput({ canvas, camera }) {
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const entries = new Map(); // id -> { id, root, label, onClick, onHover, button, hovered }
  let enabled = true;
  let dirty = false;
  let pointerInside = false;
  let hoverId = null;
  let focusId = null;
  let hoverTimer = 0;
  const pointer = { x: 0, y: 0 };
  let lastTipText = '';

  // ---- DOM helpers (tooltip, toast, focus ring, hidden keyboard layer) ----
  const mk = (tag, cls, attrs = {}) => {
    const el = document.createElement(tag);
    el.className = cls;
    for (const k in attrs) el.setAttribute(k, attrs[k]);
    document.body.appendChild(el);
    return el;
  };
  const layer = mk('div', 'a11y-layer', { id: 'a11y-layer', role: 'group', 'aria-label': 'Station controls' });
  const tip = mk('div', 'scene-tip', { 'aria-hidden': 'true' });
  const ring = mk('div', 'focus-ring', { 'aria-hidden': 'true' });
  const toastEl = mk('div', 'scene-toast', { role: 'status', 'aria-live': 'polite' });
  let toastTimer = 0;

  const labelOf = (e) => (typeof e.label === 'function' ? e.label(e) : e.label || e.id);

  function setNdc(ev) {
    const r = canvas.getBoundingClientRect();
    ndc.x = ((ev.clientX - r.left) / r.width) * 2 - 1;
    ndc.y = -((ev.clientY - r.top) / r.height) * 2 + 1;
    pointer.x = ev.clientX;
    pointer.y = ev.clientY;
  }

  /** Raycast against registered roots; returns the nearest entry id or null. */
  function pick() {
    const roots = [];
    for (const e of entries.values()) if (e.root.visible && e.active !== false) roots.push(e.root);
    if (!roots.length) return null;
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects(roots, true);
    for (const h of hits) {
      if (!visibleChain(h.object) || h.object.userData.noPick) continue;
      const id = idOf(h.object);
      if (id) return id;
    }
    return null;
  }

  /** Recompute each entry's hovered flag (pointer or keyboard focus) and notify changes. */
  function refreshHover() {
    for (const e of entries.values()) {
      const now = enabled && (e.id === hoverId || e.id === focusId);
      if (now !== e.hovered) {
        e.hovered = now;
        if (e.onHover) e.onHover(e, now);
      }
    }
    canvas.style.cursor = enabled && hoverId ? 'pointer' : 'default';
  }

  function activate(e) {
    if (!enabled || !e) return;
    if (e.onClick) e.onClick(e);
  }

  // ---- pointer events ----
  const onMove = (ev) => {
    pointerInside = true;
    dirty = true;
    setNdc(ev);
  };
  const onLeave = () => {
    pointerInside = false;
    if (hoverId !== null) {
      hoverId = null;
      refreshHover();
    }
  };
  // A drag (e.g. scrolling a room) must not count as a click
  const down = { x: 0, y: 0 };
  const onDown = (ev) => { down.x = ev.clientX; down.y = ev.clientY; };
  const onClickCanvas = (ev) => {
    if (!enabled) return;
    if (Math.hypot(ev.clientX - down.x, ev.clientY - down.y) > 10) return;
    setNdc(ev);
    const id = pick();
    if (id) activate(entries.get(id));
  };
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerleave', onLeave);
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('click', onClickCanvas);

  // ---- keyboard: debug key ----
  const onKey = (ev) => {
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const t = ev.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (ev.key && ev.key.toLowerCase() === 'd') {
      console.log('[SIGNAL LOST debug]', { ...getState(), powerPercent: getPowerPercent() });
    }
  };
  window.addEventListener('keydown', onKey);

  // ---- tooltip + focus ring positioning ----
  function screenRect(root) {
    _box.setFromObject(root);
    if (_box.isEmpty()) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, front = false;
    const { min, max } = _box;
    for (let i = 0; i < 8; i++) {
      _v.set(i & 1 ? max.x : min.x, i & 2 ? max.y : min.y, i & 4 ? max.z : min.z).project(camera);
      if (_v.z < 1) front = true;
      minX = Math.min(minX, _v.x); maxX = Math.max(maxX, _v.x);
      minY = Math.min(minY, _v.y); maxY = Math.max(maxY, _v.y);
    }
    if (!front) return null;
    const W = window.innerWidth, H = window.innerHeight;
    return {
      left: ((minX + 1) / 2) * W,
      right: ((maxX + 1) / 2) * W,
      top: ((1 - maxY) / 2) * H,
      bottom: ((1 - minY) / 2) * H,
    };
  }

  function updateOverlays() {
    const active = enabled ? entries.get(hoverId ?? focusId) : null;
    if (!active) {
      tip.classList.remove('show');
      ring.classList.remove('show');
      return;
    }
    const text = labelOf(active);
    if (text !== lastTipText) {
      tip.textContent = text;
      lastTipText = text;
    }
    let x = pointer.x + 16;
    let y = pointer.y + 18;
    const rect = focusId === active.id && hoverId === null ? screenRect(active.root) : null;
    if (rect) {
      x = (rect.left + rect.right) / 2 - tip.offsetWidth / 2;
      y = rect.top - tip.offsetHeight - 10;
    }
    x = Math.max(8, Math.min(window.innerWidth - tip.offsetWidth - 8, x));
    y = Math.max(8, Math.min(window.innerHeight - tip.offsetHeight - 8, y));
    tip.style.transform = `translate(${x}px, ${y}px)`;
    tip.classList.add('show');

    if (focusId) {
      const fr = screenRect(entries.get(focusId).root);
      if (fr) {
        ring.style.transform = `translate(${fr.left - 6}px, ${fr.top - 6}px)`;
        ring.style.width = `${fr.right - fr.left + 12}px`;
        ring.style.height = `${fr.bottom - fr.top + 12}px`;
        ring.classList.add('show');
      } else ring.classList.remove('show');
    } else ring.classList.remove('show');
  }

  return {
    /**
     * Make an object interactive.
     * @param {THREE.Object3D} root  raycast target (children included)
     * @param {{id:string, label:string|Function, onClick?:Function, onHover?:Function}} cfg
     * `onHover(entry, isOver)` fires for pointer hover and keyboard focus; entry.hovered mirrors it.
     */
    register(root, cfg) {
      this.unregister(cfg.id);
      root.userData.inputId = cfg.id;
      const entry = { ...cfg, root, hovered: false };
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'a11y-proxy';
      const sync = () => {
        const t = labelOf(entry);
        btn.textContent = t;
        btn.setAttribute('aria-label', t);
      };
      sync();
      btn.addEventListener('focus', () => { sync(); focusId = cfg.id; refreshHover(); });
      btn.addEventListener('blur', () => { if (focusId === cfg.id) { focusId = null; refreshHover(); } });
      btn.addEventListener('click', () => activate(entry)); // Enter / Space
      layer.appendChild(btn);
      entry.button = btn;
      entries.set(cfg.id, entry);
      return entry;
    },

    unregister(id) {
      const e = entries.get(id);
      if (!e) return;
      e.button.remove();
      delete e.root.userData.inputId;
      entries.delete(id);
      if (hoverId === id) hoverId = null;
      if (focusId === id) focusId = null;
    },

    clear() {
      for (const id of [...entries.keys()]) this.unregister(id);
      refreshHover();
    },

    isHovered(id) {
      return !!entries.get(id)?.hovered;
    },

    /** Move keyboard focus to an object's proxy button. */
    focus(id) {
      entries.get(id)?.button.focus({ preventScroll: true });
    },

    /** Enable or disable one object (greyed-out cards): no hover, click or keyboard focus. */
    setActive(id, active) {
      const e = entries.get(id);
      if (!e) return;
      e.active = !!active;
      e.button.disabled = !active;
      if (!active) {
        if (hoverId === id) hoverId = null;
        if (focusId === id) focusId = null;
        refreshHover();
      }
    },

    /** Disable during camera transitions so clicks and focus cannot stack. */
    setEnabled(v) {
      enabled = !!v;
      layer.inert = !enabled;
      if (!enabled) {
        hoverId = null;
        if (document.activeElement && layer.contains(document.activeElement)) document.activeElement.blur();
        focusId = null;
      }
      refreshHover();
    },

    /** Short message at the bottom of the screen (announced to screen readers). */
    toast(msg, ms = 2600) {
      toastEl.textContent = msg;
      toastEl.classList.add('show');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
    },

    /** Call every frame. */
    update(dt) {
      hoverTimer += dt;
      if (enabled && pointerInside && (dirty || hoverTimer > 0.12)) {
        dirty = false;
        hoverTimer = 0;
        const id = pick();
        if (id !== hoverId) {
          hoverId = id;
          refreshHover();
        }
      }
      updateOverlays();
    },

    dispose() {
      this.clear();
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('click', onClickCanvas);
      window.removeEventListener('keydown', onKey);
      clearTimeout(toastTimer);
      layer.remove();
      tip.remove();
      ring.remove();
      toastEl.remove();
    },
  };
}
