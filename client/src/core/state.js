// Global game state, persisted to localStorage under 'signal-lost-save'.
// The state shape is fixed by the project contract. Extra bookkeeping that is not part of that
// shape (first-start time, boss-quiz step, leaderboard name) lives in a separate 'signal-lost-meta' key.
// subscribe(fn) lets the HUD react to every change (oxygen is changed directly by mini-games).

const STORAGE_KEY = 'signal-lost-save';
const META_KEY = 'signal-lost-meta';
const POWER_ROOMS = ['about', 'projects', 'skills', 'education'];
export const RANKS = [
  { name: 'Cadet', min: 0 },
  { name: 'Technician', min: 100 },
  { name: 'Engineer', min: 250 },
  { name: 'Commander', min: 450 },
  { name: 'Station Legend', min: 700 },
];

const defaults = () => ({
  xp: 0,
  rank: 'Cadet',
  oxygen: 100,
  power: { about: false, projects: false, skills: false, education: false },
  achievements: [],
  questionsAsked: 0,
  minigamesWon: [],
  beaconUnlocked: false,
});

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

function rankFor(xp) {
  let name = RANKS[0].name;
  for (const r of RANKS) if (xp >= r.min) name = r.name;
  return name;
}

// Validate any object against the state shape; also recomputes rank from xp.
function sanitize(raw) {
  const s = defaults();
  if (!raw || typeof raw !== 'object') return s;
  if (Number.isFinite(raw.xp)) s.xp = Math.max(0, Math.floor(raw.xp));
  if (Number.isFinite(raw.oxygen)) s.oxygen = clamp(raw.oxygen, 0, 100);
  if (raw.power && typeof raw.power === 'object') {
    for (const k of POWER_ROOMS) s.power[k] = raw.power[k] === true;
  }
  if (Array.isArray(raw.achievements)) s.achievements = [...new Set(raw.achievements.filter((a) => typeof a === 'string'))];
  if (Array.isArray(raw.minigamesWon)) s.minigamesWon = [...new Set(raw.minigamesWon.filter((g) => typeof g === 'string'))];
  if (Number.isFinite(raw.questionsAsked)) s.questionsAsked = Math.max(0, Math.floor(raw.questionsAsked));
  s.beaconUnlocked = raw.beaconUnlocked === true;
  s.rank = rankFor(s.xp);
  return s;
}

function load() {
  try {
    const text = localStorage.getItem(STORAGE_KEY);
    return sanitize(text ? JSON.parse(text) : null);
  } catch {
    return defaults(); // corrupt save or storage blocked
  }
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* storage full or blocked: keep playing without persistence */
  }
}

let state = load();

// ---- change notifications ----
const subs = new Set();

/** Call fn(freshState) after every update() or reset(). Returns an unsubscribe function. */
export function subscribe(fn) {
  subs.add(fn);
  return () => subs.delete(fn);
}

function notify() {
  for (const fn of [...subs]) {
    try {
      fn(getState()); // fresh copy per subscriber, so nested updates are seen by later ones
    } catch (err) {
      console.error('[state] subscriber threw', err);
    }
  }
}

// ---- meta (outside the contract shape) ----
const metaDefaults = () => ({ startedAt: 0, speedChecked: false, bossAccepted: false, bossStep: 0, playerName: '' });

function sanitizeMeta(raw) {
  const m = metaDefaults();
  if (!raw || typeof raw !== 'object') return m;
  if (Number.isFinite(raw.startedAt) && raw.startedAt > 0) m.startedAt = raw.startedAt;
  m.speedChecked = raw.speedChecked === true;
  m.bossAccepted = raw.bossAccepted === true;
  if (Number.isFinite(raw.bossStep)) m.bossStep = clamp(Math.floor(raw.bossStep), 0, 5);
  if (typeof raw.playerName === 'string') m.playerName = raw.playerName.slice(0, 16);
  return m;
}

let meta = (() => {
  try {
    return sanitizeMeta(JSON.parse(localStorage.getItem(META_KEY) || 'null'));
  } catch {
    return metaDefaults();
  }
})();

/** Extra bookkeeping: { startedAt, speedChecked, bossAccepted, bossStep, playerName }. */
export function getMeta() {
  return { ...meta };
}

/** Merge into the meta record and persist it. */
export function setMeta(partial = {}) {
  meta = sanitizeMeta({ ...meta, ...partial });
  try {
    localStorage.setItem(META_KEY, JSON.stringify(meta));
  } catch {
    /* storage blocked: meta lives in memory only */
  }
  return getMeta();
}

/** Returns a copy of the current state (mutating it has no effect). */
export function getState() {
  return structuredClone(state);
}

/** Merge a partial state. `power` is merged key by key; rank is always derived from xp. */
export function update(partial = {}) {
  const next = { ...state, ...partial };
  if (partial.power) next.power = { ...state.power, ...partial.power };
  state = sanitize(next);
  save();
  notify();
  return getState();
}

/** Wipe progress back to defaults. */
export function reset() {
  state = defaults();
  save();
  setMeta(metaDefaults());
  notify();
  return getState();
}

/** Power % = powered rooms / 4 * 100. */
export function getPowerPercent() {
  return (POWER_ROOMS.filter((k) => state.power[k]).length / POWER_ROOMS.length) * 100;
}
