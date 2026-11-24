// Achievements: definitions come from data/achievements.json.
//  - core/progress.js saves an unlocked id once and awards its XP once.
//  - This module shows the toasts (one at a time, queued) and owns the rules that need timing or counting:
//      first_contact (first time the station is entered) and speedrunner (full power within 3 minutes of the
//      first start). Chat achievements (chatterbox, linguist) are counted and unlocked by ui/chat.js.
// Sound: core/audio.js already plays a chime on every 'achievement:unlock'.
// Call initAchievements() once at boot, after initProgress().

import { gsap } from 'gsap';
import { on, emit } from '../core/events.js';
import { getState, getMeta, setMeta } from '../core/state.js';
import defs from '@data/achievements.json';

const SPEEDRUN_MS = 3 * 60 * 1000;
const SHOW_MS = 3800;
const POWER_ROOMS = ['about', 'projects', 'skills', 'education'];
const byId = new Map(defs.map((d) => [d.id, d]));
const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

let started = false;
let host = null;
const queue = [];
let showing = false;
const shown = new Set();

/** All achievement definitions. */
export function getAchievementDefs() {
  return defs.slice();
}

/** Emit an unlock for a known id that is not unlocked yet (safe to call repeatedly). */
export function unlockAchievement(id) {
  if (byId.has(id) && !getState().achievements.includes(id)) emit('achievement:unlock', { id });
}

// ---------- toast queue ----------
function mk(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

function pump() {
  if (showing || !queue.length) return;
  showing = true;
  const def = queue.shift();
  const el = mk('div', 'ach-toast');
  const icon = mk('span', 'ach-toast__icon', def.icon || '★');
  icon.setAttribute('aria-hidden', 'true');
  const body = mk('div', 'ach-toast__body');
  body.append(
    mk('p', 'ach-toast__kicker', 'ACHIEVEMENT UNLOCKED'),
    mk('p', 'ach-toast__title', def.title),
    mk('p', 'ach-toast__text', def.description)
  );
  el.append(icon, body, mk('span', 'ach-toast__xp', `+${def.xp} XP`));
  host.append(el);

  const done = () => {
    el.remove();
    showing = false;
    pump();
  };
  if (reducedMotion) {
    setTimeout(done, SHOW_MS);
    return;
  }
  gsap.timeline({ onComplete: done })
    .fromTo(el, { x: 60, opacity: 0 }, { x: 0, opacity: 1, duration: 0.45, ease: 'back.out(1.6)' })
    .fromTo(icon, { scale: 0.4, rotate: -25 }, { scale: 1, rotate: 0, duration: 0.5, ease: 'back.out(2.5)' }, '<0.1')
    .to(el, { x: 60, opacity: 0, duration: 0.35, ease: 'power2.in' }, `+=${SHOW_MS / 1000}`);
}

// ---------- rules ----------
export function initAchievements() {
  if (started) return;
  started = true;

  host = mk('div', 'ach-toasts');
  host.setAttribute('role', 'status');
  host.setAttribute('aria-live', 'polite');
  document.body.appendChild(host);

  // Already-unlocked ids never toast again (even if some module re-emits them)
  for (const id of getState().achievements) shown.add(id);

  on('achievement:unlock', ({ id }) => {
    const def = byId.get(id);
    if (!def) {
      console.warn(`[achievements] unknown id "${id}"`);
      return;
    }
    if (shown.has(id)) return;
    shown.add(id);
    queue.push(def);
    pump();
  });

  // Entering the station for the first time: starts the speedrun clock
  on('room:enter', () => {
    if (!getMeta().startedAt) setMeta({ startedAt: Date.now() });
    unlockAchievement('first_contact');
  });

  // Full power within 3 minutes of the first start
  on('room:power', ({ room }) => {
    const m = getMeta();
    if (m.speedChecked) return;
    const power = getState().power;
    if (!POWER_ROOMS.every((r) => power[r] || r === room)) return;
    setMeta({ speedChecked: true });
    if (m.startedAt && Date.now() - m.startedAt <= SPEEDRUN_MS) unlockAchievement('speedrunner');
  });

}
