// Boot sequence: loader screen -> start button -> hub.
// Creates the shared stage (scene.js), input (input.js), audio (audio.js) and asset loader
// (loader.js), then switches rooms on 'room:enter'. Room modules in src/rooms are lazy-loaded.

import '../styles/main.css';
import { gsap } from 'gsap';
import { emit, on } from './events.js';
import { getState, reset } from './state.js';
import { createStage } from './scene.js';
import { createInput } from './input.js';
import { initAudio, audio } from './audio.js';
import { createAssetLoader, waitForFonts } from './loader.js';
import { initProgress } from './progress.js';
import { initHud } from '../ui/hud.js';
import { initChat } from '../ui/chat.js';

// true: every visit starts from zero (the save is wiped on load). false: progress is kept between visits.
const FRESH_START_EVERY_VISIT = true;

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const $ = (id) => document.getElementById(id);

const loaderEl = $('loader');
const bootPanel = $('boot-panel');
const fillEl = $('loader-fill');
const barEl = bootPanel.querySelector('.loader__bar');
const logEl = $('loader-log');
const startBtn = $('start-btn');
const choiceEl = $('mode-choice');
const hudEl = $('hud');
const hudRoomEl = $('hud-room');

// Lazy room loaders found at build time: '../rooms/hub.js' -> () => import(...)
const roomLoaders = import.meta.glob('../rooms/*.js');

const ROOM_LABELS = {
  hub: 'Hub',
  about: 'Crew Quarters',
  projects: 'Engineering Bay',
  skills: 'Reactor Core',
  education: 'Archive',
  beacon: 'Comms Tower',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, reducedMotion ? 0 : ms));

function log(text, cls = '') {
  const li = document.createElement('li');
  li.textContent = text;
  if (cls) li.className = cls;
  logEl.appendChild(li);
}

function setProgress(p) {
  fillEl.style.width = `${p}%`;
  barEl.setAttribute('aria-valuenow', String(p));
}

/** Check the Express server through the Vite proxy. */
async function checkUplink() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3000);
  try {
    const res = await fetch('/api/health', { signal: ctrl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

let stage = null;
let ctx = null;
let activeRoom = null;
let activeName = null;
const roomCache = {};
let switchToken = 0;

/** Switch rooms. Any module requests travel by emitting 'room:enter'. */
async function switchRoom(name) {
  if (!name || name === activeName) return;
  const load = roomLoaders[`../rooms/${name}.js`];
  if (!load) {
    console.info(`[main] room "${name}" is not built yet, staying in "${activeName}"`);
    return;
  }
  const token = ++switchToken;
  hudRoomEl.textContent = (ROOM_LABELS[name] || name).toUpperCase();

  if (activeRoom?.exit) activeRoom.exit();
  activeRoom = null;
  activeName = name;

  try {
    if (!roomCache[name]) {
      const mod = await load();
      mod.init(stage.scene, ctx);
      roomCache[name] = mod;
    }
    if (token !== switchToken) return; // a newer switch won
    activeRoom = roomCache[name];
    activeRoom.enter();
  } catch (err) {
    console.error(`[main] failed to enter room "${name}"`, err);
  }
}

async function boot() {
  setProgress(5);
  if (FRESH_START_EVERY_VISIT) {
    reset();
    try { localStorage.removeItem('signal-lost-viewed-projects'); } catch { /* storage blocked */ }
  }
  log(FRESH_START_EVERY_VISIT ? '> New mission: fresh save' : '> Loading save data...');
  const s = getState();
  log(`  rank: ${s.rank} | xp: ${s.xp}`, 'ok');
  await sleep(200);
  setProgress(20);

  log('> Mounting renderer...');
  try {
    stage = createStage($('scene'), { reducedMotion });
  } catch (err) {
    console.error(err);
    log('  WebGL unavailable on this device', 'err');
    startBtn.textContent = 'WEBGL REQUIRED';
    offerQuick(); // no WebGL for the game: the quick portfolio is the next best thing
    return;
  }
  const input = createInput({ canvas: $('scene'), camera: stage.camera });
  const assets = createAssetLoader();
  initAudio();
  initProgress();
  ctx = {
    stage,
    camera: stage.camera,
    renderer: stage.renderer,
    composer: stage.composer,
    bloom: stage.bloom,
    input,
    assets,
    audio,
    reducedMotion,
    get isMobile() { return window.innerWidth < 768; },
    hasRoom: (name) => Boolean(roomLoaders[`../rooms/${name}.js`]),
    goTo: (room) => emit('room:enter', { room }),
  };
  initHud(ctx); // top bar, achievements, oxygen, boss quiz, leaderboard
  initChat({ input, canOpen: () => !hudEl.hidden }); // A.R.I.A terminal: C key works once the HUD is visible
  log('  renderer online', 'ok');
  setProgress(40);

  log('> Loading fonts and assets...');
  await waitForFonts();
  await assets.preload([]); // core assets are procedural; GLB/textures are added here later
  log('  assets ready', 'ok');
  setProgress(65);

  log('> Pinging station uplink...');
  const online = await checkUplink();
  log(online ? '  uplink established' : '  uplink offline (chat and contact disabled)', online ? 'ok' : 'warn');
  await sleep(200);
  setProgress(85);

  on('room:enter', ({ room }) => switchRoom(room));
  stage.addUpdater((dt, t) => {
    activeRoom?.update?.(dt, t);
    input.update(dt);
  });
  stage.start();

  setProgress(100);
  startBtn.disabled = false;
  startBtn.textContent = '[ ENTER STATION ]';
  startBtn.focus();
}

/** The click is the user gesture that unlocks audio. The station always starts with sound on. */
function startGame() {
  startBtn.disabled = true;
  audio.unlock();
  if (audio.isMuted()) audio.toggleMute();
  hudEl.hidden = false;
  gsap.to(loaderEl, {
    opacity: 0,
    duration: reducedMotion ? 0 : 0.7,
    ease: 'power2.out',
    onComplete: () => {
      loaderEl.hidden = true;
    },
  });
  emit('room:enter', { room: 'hub' });
}
startBtn.addEventListener('click', () => startGame());

/** Game mode: hide the choice, show the boot log and start booting. */
function chooseGame() {
  choiceEl.hidden = true;
  bootPanel.hidden = false;
  boot();
}

/** Quick portfolio: no game stage is created at all, so it opens instantly. */
async function chooseQuick() {
  const btn = $('mode-quick');
  btn.disabled = true;
  try {
    const { mountQuickPortfolio } = await import('../portfolio/quick.js');
    loaderEl.hidden = true;
    mountQuickPortfolio({
      onPlay: () => { location.hash = 'play'; location.reload(); },
    });
  } catch (err) {
    console.error('[main] quick portfolio failed to load', err);
    btn.disabled = false;
  }
}

/** Shown when the game cannot run (no WebGL): replace the dead start button with the quick portfolio. */
function offerQuick() {
  startBtn.disabled = false;
  startBtn.textContent = 'OPEN QUICK PORTFOLIO';
  startBtn.addEventListener('click', chooseQuick, { once: true });
}

$('mode-play').addEventListener('click', chooseGame);
$('mode-quick').addEventListener('click', chooseQuick);

// Deep links: /#play and /#quick skip the choice screen
const preset = location.hash.replace('#', '');
if (preset === 'play') chooseGame();
else if (preset === 'quick') chooseQuick();
else $('mode-play').focus();
