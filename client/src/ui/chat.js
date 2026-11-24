// A.R.I.A TERMINAL: the station AI chat panel. Shared by the game and the Quick Portfolio.
//
// Opens from: the C key, the HUD "A.R.I.A" button, the hub terminal, the astronaut avatar, or any
// caller of openChat(). Talks to POST /api/chat { message, lang } -> { answer, found, sources }.
//
// Features: typewriter answers, a "processing" state, quick-question chips, source chips
// ("DATA LOG: projects.md") that open the matching project or a snippet popup, a lie-detector style
// confidence meter, a red LOG NOT FOUND state, voice input (Web Speech API, EN / UR) and optional
// spoken answers. Accessible: role=dialog, a live log region, focus trap, Esc closes, reduced motion.
//
// Events: emits 'chat:answer' {found, sources}, 'avatar:talk' {state}, 'achievement:unlock' {id}.
// Counts state.questionsAsked and unlocks 'chatterbox' (5 questions) and 'linguist' (Urdu question).
//
// Exports: initChat, openChat, closeChat, toggleChat, isChatOpen, destroyChat, detectLang.

import '../styles/chat.css';
import { emit, on } from '../core/events.js';
import { getState, update } from '../core/state.js';
import { openModal } from './modal.js';
import projects from '@data/projects.json';
import achievementDefs from '@data/achievements.json';

// ---------- constants ----------
const API_URL = '/api/chat';
const HEALTH_URL = '/api/health';
const TIMEOUT_MS = 30000;
const MIN_LEN = 2;
const MAX_LEN = 500;
// Cosine scores from the server are mapped onto 0-100%: CONF_LOW is "barely relevant" (the server's
// default cut-off), CONF_HIGH is "almost certainly the right log". Tune together with RAG_MIN_SCORE.
const CONF_LOW = 0.35;
const CONF_HIGH = 0.75;
const SEGMENTS = 20;
const URDU_RE = /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/;
const STT_LANGS = [
  { code: 'en-US', short: 'EN', name: 'English' },
  { code: 'ur-PK', short: 'UR', name: 'Urdu' },
];
const GREETING = "Signal acquired. I am A.R.I.A, the station's AI. My records cover Muhammad's education, projects and skills. Ask me anything.";
const QUICK = [
  { label: 'What projects has he built?', ask: 'What projects has Muhammad built?' },
  { label: 'Skills?', ask: 'What skills does Muhammad have?' },
  { label: 'Education?', ask: "What is Muhammad's education?" },
  { label: 'تعلیم؟', ask: 'محمد احمد کی تعلیم کیا ہے؟' },
  { label: 'Skills kya hain?', ask: 'Muhammad ki skills kya hain?' },
];
const ERRORS = {
  offline: 'UPLINK OFFLINE. You seem to be offline. Check your connection and retry.',
  network: 'UPLINK LOST. The station server is not responding. Retry in a moment.',
  timeout: 'TRANSMISSION TIMED OUT. Signal too weak. Retry.',
  rate: 'TOO MANY TRANSMISSIONS. Wait a minute, then ask again.',
  unavailable: "A.R.I.A's memory core is not loaded on the server yet. Try again later.",
  upstream: 'The language core is busy. Retry in a few seconds.',
  invalid: `That message was rejected. Use ${MIN_LEN} to ${MAX_LEN} characters.`,
  server: 'Station server error. Retry in a moment.',
};

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

// ---------- small helpers ----------
function mk(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const store = {
  get(key, fallback) {
    try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, value); } catch { /* storage blocked: preference lives in memory only */ }
  },
};

/** 'ur' when the text contains Arabic-script (Urdu) characters, otherwise 'en'. */
export function detectLang(text) {
  return URDU_RE.test(String(text || '')) ? 'ur' : 'en';
}

// Roman Urdu = Urdu written in English letters ("Muhammad ki education kya hai?")
const ROMAN_UR = new Set(('kya hai hain kon kaun kahan kaise kese kyun kyon kitna kitne kitni batao bataye batao mujhe mujhay tum aap ' +
  'uska uski uske unka unki unke woh wo yeh ye nahi nahin aur wala wali wale karta karti karte parhta parhta sakta chahiye ' +
  'baare bare mein main hota hoti kiya kia ka ki ke ko se par bhi tha thi hoon ho kuch sab apna apni').split(/\s+/));
/** True when most words of a Latin-script text are common Roman Urdu words (needs 2+ hits). */
export function isRomanUrdu(text) {
  const words = String(text || '').toLowerCase().match(/[a-z]+/g) || [];
  if (words.length < 2 || URDU_RE.test(text)) return false;
  const hits = words.filter((w) => ROMAN_UR.has(w)).length;
  return hits >= 2 && hits / words.length >= 0.3;
}

/** Best retrieval score -> 0-100 confidence. */
function confidenceOf(sources) {
  const best = sources.reduce((m, s) => Math.max(m, Number(s.score) || 0), 0);
  return Math.round(clamp((best - CONF_LOW) / (CONF_HIGH - CONF_LOW), 0, 1) * 100);
}
const levelOf = (pct) => (pct < 40 ? 'LOW' : pct < 70 ? 'MEDIUM' : 'HIGH');

/** 'projects-3' -> 'projects.md' */
const fileOf = (source) => `${String(source.id || source.title || 'log').replace(/-\d+$/, '')}.md`;

/** One chip per knowledge file, keeping every matching snippet for the popup. */
function groupSources(sources) {
  const map = new Map();
  for (const s of sources) {
    const file = fileOf(s);
    if (!map.has(file)) map.set(file, { file, items: [] });
    map.get(file).items.push(s);
  }
  return [...map.values()];
}

// ---------- module state ----------
let S = null;
const announced = new Set();

// =====================================================================================
// Build the panel
// =====================================================================================
function buildUI() {
  const root = mk('div', 'aria');
  root.id = 'aria-terminal';
  root.hidden = true;

  const backdrop = mk('div', 'aria__backdrop');
  const win = mk('section', 'aria__win');
  win.setAttribute('role', 'dialog');
  win.setAttribute('aria-modal', 'true');
  win.setAttribute('aria-labelledby', 'aria-title');
  win.tabIndex = -1;

  // header
  const led = mk('span', 'aria__led');
  led.setAttribute('aria-hidden', 'true');
  const title = mk('h2', 'aria__title', 'A.R.I.A TERMINAL');
  title.id = 'aria-title';
  const ledText = mk('span', 'aria__state', 'STANDBY');
  const tools = mk('div', 'aria__tools');
  const langBtn = mk('button', 'aria__tool', 'EN');
  langBtn.type = 'button';
  const voiceBtn = mk('button', 'aria__tool', 'VOICE OFF');
  voiceBtn.type = 'button';
  const closeBtn = mk('button', 'aria__tool aria__tool--close', 'X');
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', 'Close terminal (Esc)');
  tools.append(langBtn, voiceBtn, closeBtn);
  const head = mk('header', 'aria__head');
  head.append(led, title, ledText, tools);

  // message log: aria-live announces each new message once
  const log = mk('div', 'aria__log');
  log.setAttribute('role', 'log');
  log.setAttribute('aria-live', 'polite');
  log.setAttribute('aria-relevant', 'additions');
  log.setAttribute('aria-label', 'Conversation with A.R.I.A');
  log.tabIndex = 0;

  // quick questions
  const chips = mk('ul', 'aria__chips');
  chips.setAttribute('aria-label', 'Quick questions');
  const chipBtns = QUICK.map((q) => {
    const li = mk('li');
    const b = mk('button', 'aria__chip', q.label);
    b.type = 'button';
    if (detectLang(q.label) === 'ur') { b.lang = 'ur'; b.dir = 'rtl'; }
    b.addEventListener('click', () => ask(q.ask));
    li.append(b);
    chips.append(li);
    return b;
  });

  // input row
  const form = mk('form', 'aria__form');
  form.noValidate = true;
  const input = mk('input', 'aria__input');
  input.type = 'text';
  input.maxLength = MAX_LEN;
  input.autocomplete = 'off';
  input.autocapitalize = 'sentences';
  input.spellcheck = false;
  input.enterKeyHint = 'send';
  input.dir = 'auto';
  input.placeholder = 'Ask about projects, skills, education...';
  input.setAttribute('aria-label', 'Your question for A.R.I.A');
  const micBtn = mk('button', 'aria__btn aria__btn--mic', 'MIC');
  micBtn.type = 'button';
  micBtn.setAttribute('aria-pressed', 'false');
  micBtn.setAttribute('aria-label', 'Start voice input');
  const sendBtn = mk('button', 'aria__btn aria__btn--send', 'SEND');
  sendBtn.type = 'submit';
  form.append(input, micBtn, sendBtn);

  const status = mk('p', 'aria__status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const hint = mk('p', 'aria__hint', 'ENTER send  |  C open  |  ESC close');

  win.append(head, log, chips, form, status, hint);
  root.append(backdrop, win);
  (document.getElementById('chat-root') || document.body).append(root);

  S = {
    root, win, log, input, sendBtn, micBtn, langBtn, voiceBtn, closeBtn, led, ledText, status, chipBtns, form,
    open: false,
    busy: false,
    welcomed: false,
    lastQuestion: '',
    typing: null,
    recognition: null,
    listening: false,
    sttIndex: Math.max(0, STT_LANGS.findIndex((l) => l.code === store.get('aria-stt-lang', 'en-US'))),
    voiceOn: store.get('aria-voice', '0') === '1',
    health: 'unknown', // 'online' | 'offline' | 'unknown'
    healthAt: 0,
    prevFocus: null,
    inputApi: null,
    canOpen: () => true,
    statusTimer: 0,
    offs: [],
  };
  return S;
}

// =====================================================================================
// Status, header and message helpers
// =====================================================================================
function setLed(kind, text) {
  S.led.className = `aria__led is-${kind}`;
  S.ledText.textContent = text;
}

function refreshLed() {
  if (S.busy) return setLed('busy', 'PROCESSING');
  if (S.listening) return setLed('busy', 'LISTENING');
  if (S.health === 'offline') return setLed('off', 'OFFLINE');
  if (S.health === 'online') return setLed('on', 'ONLINE');
  setLed('idle', 'STANDBY');
}

/** Short message under the input (validation, microphone problems). Clears itself. */
function say(text, ms = 6000) {
  clearTimeout(S.statusTimer);
  S.status.textContent = text;
  if (text && ms) S.statusTimer = setTimeout(() => { S.status.textContent = ''; }, ms);
}

function scrollDown(force = false) {
  const l = S.log;
  if (force || l.scrollHeight - l.scrollTop - l.clientHeight < 90) l.scrollTop = l.scrollHeight;
}

/** Reveals text character by character. Returns { skip() }. Reduced motion shows it at once. */
function typeInto(el, text, onDone) {
  const chars = Array.from(text);
  if (reducedMotion() || chars.length === 0) {
    el.textContent = text;
    onDone?.();
    return { skip() {} };
  }
  const cps = clamp(chars.length / 2.5, 45, 140); // longer answers type faster, ~2.5 s at most
  const t0 = performance.now();
  let raf = 0;
  let finished = false;
  el.classList.add('is-typing');
  const finish = () => {
    if (finished) return;
    finished = true;
    cancelAnimationFrame(raf);
    el.textContent = text;
    el.classList.remove('is-typing');
    scrollDown();
    onDone?.();
  };
  const tick = (now) => {
    const n = Math.min(chars.length, Math.floor(((now - t0) / 1000) * cps));
    el.textContent = chars.slice(0, n).join('');
    scrollDown();
    if (n >= chars.length) finish();
    else raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return { skip: finish };
}

function addUser(text) {
  const row = mk('div', 'aria-msg aria-msg--user');
  const who = mk('span', 'aria-msg__who', 'YOU >');
  const p = mk('p', 'aria-msg__text', text);
  if (detectLang(text) === 'ur') { p.lang = 'ur'; p.dir = 'rtl'; }
  row.append(who, p);
  S.log.append(row);
  scrollDown(true);
}

/** A system line (greeting-less notices, achievements, errors). kind: 'info' | 'error' | 'ok'. */
function addSystem(text, kind = 'info', onRetry = null) {
  const row = mk('div', `aria-msg aria-msg--sys is-${kind}`);
  row.append(mk('span', 'aria-msg__who', kind === 'error' ? 'ERROR' : 'SYSTEM'), mk('p', 'aria-msg__text', text));
  if (onRetry) {
    const b = mk('button', 'aria__chip aria-msg__retry', 'RETRY');
    b.type = 'button';
    b.addEventListener('click', () => { row.remove(); onRetry(); });
    row.append(b);
  }
  S.log.append(row);
  scrollDown(true);
  return row;
}

function addProcessing() {
  const row = mk('div', 'aria-msg aria-msg--bot aria-msg--wait');
  row.append(mk('span', 'aria-msg__who', 'A.R.I.A >'));
  const p = mk('p', 'aria-msg__text');
  p.append(mk('span', 'aria-msg__wait', 'processing'), mk('span', 'aria-msg__dots', '...'));
  const sr = mk('span', 'sr-only', 'A.R.I.A is processing your question.');
  row.append(p, sr);
  S.log.append(row);
  scrollDown(true);
  return row;
}

// ---------- confidence meter (lie-detector style) ----------
function buildMeter(pct) {
  const wrap = mk('div', 'aria-conf');
  wrap.setAttribute('role', 'meter');
  wrap.setAttribute('aria-label', 'Answer confidence');
  wrap.setAttribute('aria-valuemin', '0');
  wrap.setAttribute('aria-valuemax', '100');
  wrap.setAttribute('aria-valuenow', String(pct));
  wrap.setAttribute('aria-valuetext', `${pct} percent, ${levelOf(pct).toLowerCase()}`);
  const bar = mk('span', 'aria-conf__bar');
  const segs = [];
  for (let i = 0; i < SEGMENTS; i++) {
    const seg = mk('span', `aria-conf__seg ${i < 7 ? 'is-low' : i < 14 ? 'is-mid' : 'is-high'}`);
    bar.append(seg);
    segs.push(seg);
  }
  const value = mk('span', 'aria-conf__val', `${pct}% ${levelOf(pct)}`);
  wrap.append(mk('span', 'aria-conf__label', 'CONFIDENCE'), bar, value);

  const lit = Math.round((pct / 100) * SEGMENTS);
  const paint = (n) => segs.forEach((s, i) => s.classList.toggle('is-on', i < n));
  if (reducedMotion()) {
    paint(lit);
  } else {
    // needle sweeps up, overshoots a little and settles, like a polygraph
    const peak = Math.min(SEGMENTS, lit + 3);
    const path = [];
    for (let i = 0; i <= peak; i++) path.push(i);
    for (let i = peak - 1; i >= lit; i--) path.push(i);
    let k = 0;
    const timer = setInterval(() => {
      paint(path[k++]);
      if (k >= path.length || !wrap.isConnected) clearInterval(timer);
    }, 32);
  }
  return wrap;
}

// ---------- source chips ----------
const norm = (s) => String(s || '').toLowerCase();

/** The first visible (non-secret) project mentioned in a group of retrieved snippets. */
function findProject(group) {
  const hay = group.items.map((s) => `${s.title} ${s.snippet}`).map(norm);
  return projects.find((p) => !p.secret && hay.some((h) => h.includes(norm(p.title)))) || null;
}

function openSource(group) {
  const kicker = `DATA LOG: ${group.file}`;
  const proj = findProject(group);
  if (proj) {
    const meta = [];
    if (proj.badge) meta.push({ label: 'Type', value: proj.badge });
    if (proj.role) meta.push({ label: 'Role', value: proj.role });
    openModal({
      kicker,
      title: proj.title,
      description: proj.shortDescription,
      meta,
      chipsTitle: 'Technologies',
      chips: proj.tech || [],
      links: proj.link ? [{ label: 'OPEN LINK', href: proj.link }] : [],
    });
    return;
  }
  const body = mk('div', 'aria-snip');
  for (const s of group.items) {
    const block = mk('blockquote', 'aria-snip__item');
    block.append(
      mk('p', 'aria-snip__title', s.title || group.file),
      mk('p', 'aria-snip__text', s.snippet || ''),
      mk('p', 'aria-snip__score', `MATCH ${Math.round(clamp(((Number(s.score) || 0) - CONF_LOW) / (CONF_HIGH - CONF_LOW), 0, 1) * 100)}%`)
    );
    body.append(block);
  }
  openModal({ kicker, title: 'LOG EXTRACT', description: 'The part of the station log A.R.I.A used for this answer.', content: body });
}

function buildSources(sources) {
  const groups = groupSources(sources);
  if (!groups.length) return null;
  const ul = mk('ul', 'aria-srcs');
  ul.setAttribute('aria-label', 'Sources');
  for (const g of groups) {
    const li = mk('li');
    const b = mk('button', 'aria-src', `DATA LOG: ${g.file}`);
    b.type = 'button';
    b.title = g.items.map((s) => s.title).filter(Boolean).join(' | ');
    b.setAttribute('aria-haspopup', 'dialog');
    b.addEventListener('click', () => openSource(g));
    li.append(b);
    ul.append(li);
  }
  return ul;
}

// ---------- answers ----------
function addAnswer({ answer, found, sources }) {
  const row = mk('div', `aria-msg aria-msg--bot ${found ? '' : 'is-missing'}`);
  if (!found) row.append(mk('p', 'aria-msg__alert', 'LOG NOT FOUND'));
  row.append(mk('span', 'aria-msg__who', 'A.R.I.A >'));
  const text = mk('p', 'aria-msg__text');
  const urdu = detectLang(answer) === 'ur';
  if (urdu) { text.lang = 'ur'; text.dir = 'rtl'; }
  // Screen readers get the full text once; the typewriter copy is hidden from them
  const sr = mk('span', 'sr-only', answer);
  const typed = mk('span', 'aria-msg__typed');
  typed.setAttribute('aria-hidden', 'true');
  text.append(sr, typed);
  row.append(text);
  S.log.append(row);
  scrollDown(true);

  const finishRow = () => {
    if (found) {
      const foot = mk('div', 'aria-msg__foot');
      foot.append(buildMeter(confidenceOf(sources)));
      // No DATA LOG chips: they are backend file names and mean nothing to a visitor
      row.append(foot);
    }
    scrollDown();
  };
  S.typing?.skip();
  const handle = typeInto(typed, answer, finishRow);
  S.typing = handle;
  row.addEventListener('click', () => handle.skip()); // click to skip the typewriter
  speak(answer, urdu ? 'ur-PK' : S.lastRoman || isRomanUrdu(answer) ? 'roman' : 'en-US');
}

// =====================================================================================
// Achievements and counters
// =====================================================================================
/** Unlock once. The game's progress module records it; the Quick Portfolio has none, so record it here. */
function unlock(id) {
  if (getState().achievements.includes(id)) return;
  const xpBefore = getState().xp;
  emit('achievement:unlock', { id });
  const s = getState();
  if (!s.achievements.includes(id)) update({ achievements: [...s.achievements, id] });
  const def = achievementDefs.find((d) => d.id === id);
  if (def && !announced.has(id)) {
    announced.add(id);
    const gained = getState().xp - xpBefore;
    addSystem(`ACHIEVEMENT UNLOCKED: ${def.title}${gained > 0 ? ` (+${gained} XP)` : ''}`, 'ok');
  }
}

function countQuestion() {
  const n = getState().questionsAsked + 1;
  update({ questionsAsked: n });
  if (n >= 5) unlock('chatterbox');
}

// =====================================================================================
// Network
// =====================================================================================
class ChatError extends Error {
  constructor(kind) {
    super(kind);
    this.kind = kind;
  }
}

async function postChat(message, lang) {
  if (navigator.onLine === false) throw new ChatError('offline');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, lang }),
      signal: ctrl.signal,
    });
  } catch (err) {
    throw new ChatError(err?.name === 'AbortError' ? 'timeout' : 'network');
  } finally {
    clearTimeout(timer);
  }
  let data = null;
  try { data = await res.json(); } catch { /* not JSON: a proxy error page or an empty body */ }

  if (!res.ok) {
    const code = data?.error;
    if (res.status === 429 || code === 'rate_limited') throw new ChatError('rate');
    if (res.status === 400 || code === 'invalid_message') throw new ChatError('invalid');
    if (code === 'no_index' || code === 'no_key') throw new ChatError('unavailable');
    if (code === 'upstream') throw new ChatError('upstream');
    if (!data && res.status >= 500) throw new ChatError('network'); // dev proxy with the server stopped
    throw new ChatError('server');
  }
  if (!data || typeof data.answer !== 'string' || typeof data.found !== 'boolean') throw new ChatError('server');
  const sources = (Array.isArray(data.sources) ? data.sources : [])
    .filter((s) => s && typeof s === 'object')
    .map((s) => ({
      id: String(s.id ?? ''),
      title: String(s.title ?? ''),
      snippet: String(s.snippet ?? ''),
      score: Number(s.score) || 0,
    }));
  return { answer: data.answer, found: data.found, sources: data.found ? sources : [] };
}

/** Quietly check the server when the terminal opens, so the header LED is honest. */
async function probeHealth() {
  if (Date.now() - S.healthAt < 15000) return;
  S.healthAt = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3000);
  try {
    const res = await fetch(HEALTH_URL, { signal: ctrl.signal });
    S.health = res.ok ? 'online' : 'offline';
  } catch {
    S.health = 'offline';
  } finally {
    clearTimeout(timer);
  }
  if (S) refreshLed();
}

// =====================================================================================
// Asking
// =====================================================================================
function setBusy(busy) {
  S.busy = busy;
  S.input.disabled = busy;
  S.sendBtn.disabled = busy;
  S.micBtn.disabled = busy;
  S.chipBtns.forEach((b) => { b.disabled = busy; });
  S.win.setAttribute('aria-busy', String(busy));
  refreshLed();
}

/** Ask A.R.I.A. `retry` re-sends the last question without repeating the user bubble. */
async function ask(raw, { retry = false } = {}) {
  if (!S || S.busy) return;
  const text = String(raw || '').replace(/\s+/g, ' ').trim();
  if (text.length < MIN_LEN) return say(`Type at least ${MIN_LEN} characters.`);
  if (text.length > MAX_LEN) return say(`Keep it under ${MAX_LEN} characters.`);

  const roman = isRomanUrdu(text);
  S.lastRoman = roman;
  const lang = roman ? 'ur' : detectLang(text); // API contract stays 'en' | 'ur'; the server also spots Roman Urdu
  S.lastQuestion = text;
  S.input.value = '';
  say('');
  stopSpeaking();
  S.typing?.skip();
  if (!retry) addUser(text);
  if (lang === 'ur') unlock('linguist'); // an Urdu or Roman Urdu question is detected
  setBusy(true);
  const wait = addProcessing();

  let data;
  try {
    data = await postChat(text, lang);
    S.health = 'online';
  } catch (err) {
    wait.remove();
    if (!S) return; // the panel was destroyed while waiting
    const kind = err instanceof ChatError ? err.kind : 'server';
    if (kind === 'offline' || kind === 'network') S.health = 'offline';
    window.dispatchEvent(new CustomEvent('aria:error', { detail: { kind } })); // the HUD offers a manual fallback after repeats
    addSystem(ERRORS[kind] || ERRORS.server, 'error', kind === 'invalid' ? null : () => ask(S.lastQuestion, { retry: true }));
    setBusy(false);
    if (S.open) S.input.focus({ preventScroll: true });
    return;
  }

  wait.remove();
  if (!S) return;
  setBusy(false);
  addAnswer(data);
  countQuestion();
  emit('chat:answer', { found: data.found, sources: data.sources });
  emit('avatar:talk', { state: data.found ? 'talk' : 'shrug' });
  if (S.open) S.input.focus({ preventScroll: true });
}

// =====================================================================================
// Voice: speech recognition (input) and speech synthesis (answers)
// =====================================================================================
const SpeechRec = typeof window !== 'undefined' ? window.SpeechRecognition || window.webkitSpeechRecognition : null;
const synth = typeof window !== 'undefined' ? window.speechSynthesis : null;

const MIC_ERRORS = {
  'not-allowed': 'Microphone blocked. Allow microphone access in the browser and try again.',
  'service-not-allowed': 'Microphone blocked. Allow microphone access in the browser and try again.',
  'no-speech': 'I heard nothing. Tap MIC and speak again.',
  'audio-capture': 'No microphone was found.',
  network: 'Voice input needs an internet connection.',
  'language-not-supported': "This browser's speech engine does not support that language.",
};

function syncVoiceUi() {
  const lang = STT_LANGS[S.sttIndex];
  S.langBtn.textContent = lang.short;
  S.langBtn.setAttribute('aria-label', `Voice input language: ${lang.name}. Activate to switch.`);
  S.langBtn.title = `Voice input language: ${lang.name}`;
  S.voiceBtn.textContent = S.voiceOn ? 'VOICE ON' : 'VOICE OFF';
  S.voiceBtn.setAttribute('aria-pressed', String(S.voiceOn));
  S.voiceBtn.setAttribute('aria-label', S.voiceOn ? 'Spoken answers on. Activate to mute.' : 'Spoken answers off. Activate to turn on.');
  S.micBtn.classList.toggle('is-live', S.listening);
  S.micBtn.setAttribute('aria-pressed', String(S.listening));
  S.micBtn.setAttribute('aria-label', S.listening ? 'Stop voice input' : `Start voice input (${lang.name})`);
  S.micBtn.textContent = S.listening ? 'STOP' : 'MIC';
}

function stopListening() {
  if (S?.recognition) {
    try { S.recognition.abort(); } catch { /* already stopped */ }
  }
}

function startListening() {
  if (!SpeechRec || S.busy || S.listening) return;
  stopSpeaking();
  const rec = new SpeechRec();
  rec.lang = STT_LANGS[S.sttIndex].code;
  rec.interimResults = true;
  rec.continuous = false;
  rec.maxAlternatives = 1;
  let finalText = '';
  let error = '';
  rec.onstart = () => {
    S.listening = true;
    S.recognition = rec;
    S.input.value = '';
    say('LISTENING... speak your question.', 0);
    syncVoiceUi();
    refreshLed();
  };
  rec.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) finalText += r[0].transcript;
      else interim += r[0].transcript;
    }
    S.input.value = `${finalText}${interim}`.trim().slice(0, MAX_LEN);
  };
  rec.onerror = (e) => { error = e.error || 'error'; };
  rec.onend = () => {
    const wasMine = S.recognition === rec;
    if (wasMine) S.recognition = null;
    S.listening = false;
    syncVoiceUi();
    refreshLed();
    if (!wasMine) return;
    const text = S.input.value.trim();
    if (error && error !== 'aborted') {
      say(MIC_ERRORS[error] || 'Voice input failed. Try again or type your question.');
    } else if (error === 'aborted') {
      say('');
    } else if (text) {
      say('');
      ask(text);
    } else {
      say("I didn't catch that. Tap MIC and try again.");
    }
  };
  try {
    rec.start();
  } catch {
    say('Voice input could not start. Try again.');
  }
}

function stopSpeaking() {
  speakSeq++;
  try { ttsAudio?.pause(); ttsAudio = null; } catch { /* no audio */ }
  try { synth?.cancel(); } catch { /* speech not available */ }
}

let speakSeq = 0;
let ttsAudio = null;

/** Browser voice. 'roman' (Roman Urdu) is read with a Hindi voice: same sounds, and Latin letters read correctly. */
function speakBrowser(text, lang) {
  if (!synth) return;
  try {
    synth.cancel();
    const code = lang === 'roman' ? 'hi-IN' : lang;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = code;
    const voices = synth.getVoices();
    const voice = voices.find((v) => v.lang?.toLowerCase().replace('_', '-') === code.toLowerCase()) || voices.find((v) => v.lang?.toLowerCase().startsWith(code.slice(0, 2)));
    if (lang === 'ur-PK' && !voice) return; // no Urdu voice installed: better silent than wrong
    if (voice) u.voice = voice;
    u.rate = 1;
    synth.speak(u);
  } catch { /* ignore speech failures */ }
}

/** English: browser voice. Urdu and Roman Urdu: natural Urdu voice from the server (Gemini speech), browser voice as fallback. */
async function speak(text, lang) {
  if (!S?.voiceOn || !S.open || !text) return;
  const my = ++speakSeq;
  if (lang === 'en-US') return speakBrowser(text, lang);
  try {
    const res = await fetch('/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }), signal: AbortSignal.timeout(25000) });
    if (!res.ok) throw new Error(`tts ${res.status}`);
    const url = URL.createObjectURL(await res.blob());
    if (my !== speakSeq || !S?.voiceOn || !S.open) return URL.revokeObjectURL(url); // the visitor moved on
    stopSpeaking();
    ttsAudio = new Audio(url);
    ttsAudio.onended = () => URL.revokeObjectURL(url);
    await ttsAudio.play();
  } catch {
    if (my === speakSeq) speakBrowser(text, lang);
  }
}

// =====================================================================================
// Open / close, keyboard
// =====================================================================================
const focusables = () =>
  [...S.win.querySelectorAll('button, input, [href], [tabindex]:not([tabindex="-1"])')].filter(
    (el) => !el.disabled && el.getClientRects().length > 0
  );

/** Escape closes, Tab stays inside the terminal. A source popup on top handles its own keys. */
function onDocKey(e) {
  if (!S?.open || document.querySelector('.modal-backdrop')) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation(); // do not also trigger the hub's Escape = back
    closeChat();
  } else if (e.key === 'Tab') {
    const f = focusables();
    if (!f.length) return;
    const first = f[0];
    const last = f[f.length - 1];
    if (!S.win.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
    else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
}

/** The C key opens the terminal, unless the visitor is typing or something else is on screen. */
function onHotkey(e) {
  if (e.key?.toLowerCase() !== 'c' || e.repeat || e.ctrlKey || e.metaKey || e.altKey || !S || S.open) return;
  const t = e.target;
  if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) return;
  if (document.querySelector('.modal-backdrop, .game-overlay, .rogue-overlay')) return;
  const loader = document.getElementById('loader');
  if (loader && !loader.hidden) return;
  if (!S.canOpen()) return;
  e.preventDefault();
  openChat();
}

function welcome() {
  S.welcomed = true;
  const row = mk('div', 'aria-msg aria-msg--bot');
  row.append(mk('span', 'aria-msg__who', 'A.R.I.A >'));
  const text = mk('p', 'aria-msg__text');
  const sr = mk('span', 'sr-only', GREETING);
  const typed = mk('span', 'aria-msg__typed');
  typed.setAttribute('aria-hidden', 'true');
  text.append(sr, typed);
  row.append(text);
  S.log.append(row);
  S.typing = typeInto(typed, GREETING);
  row.addEventListener('click', () => S.typing?.skip());
}

/** Open the terminal. `{ ask }` also sends a first question; `{ note }` adds a system line (mission text). */
export function openChat(opts = {}) {
  if (!S) initChat();
  if (!S.open) {
    S.prevFocus = document.activeElement;
    S.open = true;
    S.root.hidden = false;
    S.inputApi?.setEnabled(false); // the 3D scene must not react while the terminal is open
    requestAnimationFrame(() => S.root.classList.add('is-open'));
    document.addEventListener('keydown', onDocKey, true);
    if (!S.welcomed) welcome();
    probeHealth();
    refreshLed();
    syncVoiceUi();
    S.input.focus({ preventScroll: true });
  }
  if (opts.note) addSystem(opts.note, 'info');
  if (opts.ask) ask(opts.ask);
}

export function closeChat() {
  if (!S || !S.open) return;
  S.open = false;
  stopListening();
  stopSpeaking();
  S.typing?.skip();
  S.root.classList.remove('is-open');
  S.root.hidden = true;
  document.removeEventListener('keydown', onDocKey, true);
  S.inputApi?.setEnabled(true);
  const back = S.prevFocus;
  S.prevFocus = null;
  if (back && back.isConnected && back.focus) back.focus({ preventScroll: true });
}

export function toggleChat() {
  if (S?.open) closeChat();
  else openChat();
}

export const isChatOpen = () => !!S?.open;

/**
 * Create the panel (hidden) and register the C key. Safe to call more than once.
 * @param {{ input?: object, canOpen?: () => boolean }} [opts]
 *   input: the game's input object (its setEnabled() is used to freeze the 3D scene while open)
 *   canOpen: return false while the C key should do nothing (for example before the game starts)
 */
export function initChat(opts = {}) {
  if (!S) {
    buildUI();
    S.offs.push(on('achievement:unlock', ({ id }) => {
      if (id === 'verdict') addSystem('ROGUE SIGNAL TRACED. The Comms Tower is unlocked: close this terminal and enter it from the hub.', 'ok');
    }));
    const on_ = (target, ev, fn, o) => {
      target.addEventListener(ev, fn, o);
      S.offs.push(() => target.removeEventListener(ev, fn, o));
    };
    on_(S.form, 'submit', (e) => { e.preventDefault(); ask(S.input.value); });
    on_(S.closeBtn, 'click', closeChat);
    on_(S.root.querySelector('.aria__backdrop'), 'pointerdown', closeChat);
    // Keys typed inside the terminal must not reach game shortcuts (M = mute, Escape = back, ...)
    on_(S.root, 'keydown', (e) => e.stopPropagation());
    on_(S.langBtn, 'click', () => {
      S.sttIndex = (S.sttIndex + 1) % STT_LANGS.length;
      store.set('aria-stt-lang', STT_LANGS[S.sttIndex].code);
      stopListening();
      syncVoiceUi();
      say(`Voice input language: ${STT_LANGS[S.sttIndex].name}.`, 3000);
    });
    on_(S.voiceBtn, 'click', () => {
      S.voiceOn = !S.voiceOn;
      store.set('aria-voice', S.voiceOn ? '1' : '0');
      if (!S.voiceOn) stopSpeaking();
      syncVoiceUi();
    });
    on_(S.micBtn, 'click', () => (S.listening ? stopListening() : startListening()));
    on_(window, 'keydown', onHotkey);
    on_(window, 'pagehide', stopSpeaking);
    on_(window, 'online', () => { S.healthAt = 0; if (S.open) probeHealth(); });
    on_(window, 'offline', () => { S.health = 'offline'; refreshLed(); });
    // Features the browser lacks are hidden instead of failing later
    if (!SpeechRec) { S.micBtn.hidden = true; S.langBtn.hidden = true; }
    if (!synth) S.voiceBtn.hidden = true;
    syncVoiceUi();
    refreshLed();
  }
  if (opts.input) S.inputApi = opts.input;
  if (typeof opts.canOpen === 'function') S.canOpen = opts.canOpen;
  return { open: openChat, close: closeChat };
}

/** Remove the panel and every listener (used when the Quick Portfolio unmounts). */
export function destroyChat() {
  if (!S) return;
  closeChat();
  stopListening();
  S.offs.forEach((off) => off());
  S.root.remove();
  S = null;
}
