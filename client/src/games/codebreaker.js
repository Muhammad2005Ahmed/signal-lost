// CODEBREAKER mini-game: a Wordle-style game with 5-letter technology words and 6 attempts.
// Feedback per letter: green = right spot, yellow = in the word but wrong spot, gray = not in the word.
// Input: physical keyboard or the on-screen keyboard (mouse and touch). Guesses must be real words.
// Win: emits 'game:win', 'room:power', 'xp:add'. Lose: costs 5 oxygen, then retry (new word) or abort.

import { emit } from '../core/events.js';
import { getState, update } from '../core/state.js';
import { audio } from '../core/audio.js';

const LEN = 5;
const MAX_TRIES = 6;
const OXYGEN_COST = 5;
const WIN_XP = 60;
const FLIP_MS = 260; // delay between tiles when a row is revealed

// Secret words: exactly 15 five-letter answers. Each has a category and a clue, so the player always knows
// WHAT to find and from WHICH category (the categories are mixed on purpose, not only technology).
export const WORDS = [
  { word: 'LINUX', cat: 'TECHNOLOGY', clue: 'Open-source operating system whose mascot is a penguin' },
  { word: 'ROBOT', cat: 'TECHNOLOGY', clue: 'A programmable machine that does tasks automatically' },
  { word: 'LASER', cat: 'TECHNOLOGY', clue: 'A narrow, powerful beam of light used in scanners and surgery' },
  { word: 'PIXEL', cat: 'TECHNOLOGY', clue: 'The smallest dot that makes up a screen image' },
  { word: 'CLOUD', cat: 'TECHNOLOGY', clue: 'Internet servers where files are stored instead of your own disk' },
  { word: 'ORBIT', cat: 'SPACE', clue: 'The curved path a planet takes around a star' },
  { word: 'COMET', cat: 'SPACE', clue: 'An icy space rock that grows a glowing tail near the Sun' },
  { word: 'VENUS', cat: 'SPACE', clue: 'The second planet from the Sun, the hottest one' },
  { word: 'EARTH', cat: 'SPACE', clue: 'The home planet this station sends its signals to' },
  { word: 'TIGER', cat: 'ANIMAL', clue: 'A big striped cat that hunts in the jungle' },
  { word: 'EAGLE', cat: 'ANIMAL', clue: 'A large bird of prey with very sharp eyesight' },
  { word: 'PIZZA', cat: 'FOOD', clue: 'A round baked dish with cheese and tomato, from Italy' },
  { word: 'MANGO', cat: 'FOOD', clue: 'A sweet tropical fruit called the king of fruits in Pakistan' },
  { word: 'INDUS', cat: 'GEOGRAPHY', clue: 'The longest river of Pakistan' },
  { word: 'PARIS', cat: 'GEOGRAPHY', clue: 'Capital city of France, home of the Eiffel Tower' },
];
export const ANSWERS = WORDS.map((w) => w.word);

const ROWS = ['QWERTYUIOP', 'ASDFGHJKL', 'ZXCVBNM'];
const RANK = { absent: 1, present: 2, correct: 3 }; // keyboard keeps each letter's best result

let active = null; // only one game at a time
let lastWord = '';
const ANY_FIVE = /^[A-Z]{5}$/; // any 5 letters is a valid guess: the clue, not a dictionary, is the challenge

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

/** Wordle scoring with correct handling of repeated letters (two passes). */
export function scoreGuess(guess, answer) {
  const res = Array(LEN).fill('absent');
  const left = {};
  for (let i = 0; i < LEN; i++) {
    if (guess[i] === answer[i]) res[i] = 'correct';
    else left[answer[i]] = (left[answer[i]] || 0) + 1;
  }
  for (let i = 0; i < LEN; i++) {
    if (res[i] === 'correct') continue;
    if (left[guess[i]] > 0) { res[i] = 'present'; left[guess[i]]--; }
  }
  return res;
}

function pickWord() {
  let w;
  do { w = WORDS[Math.floor(Math.random() * WORDS.length)]; } while (w.word === lastWord && WORDS.length > 1);
  lastWord = w.word;
  return w;
}

/**
 * Open the game. Resolves true when won, false if aborted.
 * @param {{room?: string}} [opts] room that receives power on a win
 */
export function startCodebreaker({ room = 'about' } = {}) {
  if (active) return active.promise;

  const previousFocus = document.activeElement;
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  let resolveGame;
  const promise = new Promise((r) => { resolveGame = r; });

  // ---- DOM ----
  const tryText = h('span', { class: 'game-time' });
  const oxyText = h('span', { class: 'game-oxygen' });
  const rowEls = Array.from({ length: MAX_TRIES }, (_, r) =>
    h('div', { class: 'cb-row', role: 'group', 'aria-label': `Attempt ${r + 1}` },
      ...Array.from({ length: LEN }, () => h('span', { class: 'cb-tile', 'aria-label': 'empty' })))
  );
  const board = h('div', { class: 'cb-board', role: 'group', 'aria-label': 'Guess board', tabindex: '-1' }, ...rowEls);
  const keyEls = {};
  const kbRows = ROWS.map((letters, ri) => {
    const row = h('div', { class: 'cb-kbrow' });
    if (ri === 2) row.append(makeKey('ENTER', 'Enter', true));
    for (const ch of letters) row.append(makeKey(ch, ch));
    if (ri === 2) row.append(makeKey('DEL', 'Backspace', true));
    return row;
  });
  function makeKey(label, value, wide = false) {
    const b = h('button', { class: `cb-key${wide ? ' is-wide' : ''}`, type: 'button', tabindex: '-1', 'data-key': value, text: label });
    if (value === 'Enter') b.setAttribute('aria-label', 'Enter, submit guess');
    if (value === 'Backspace') b.setAttribute('aria-label', 'Delete letter');
    if (value.length === 1) keyEls[value] = b;
    return b;
  }
  const kb = h('div', { class: 'cb-kb' }, ...kbRows);
  // The clue box: category + what to find + the first letter (so the puzzle is fair for any category)
  const catText = h('span', { class: 'cb-clue__cat' });
  const clueText = h('span', { class: 'cb-clue__text' });
  const clueBox = h('p', { class: 'game-hint cb-clue', role: 'status' }, h('strong', { text: 'CATEGORY: ' }), catText, h('br'), h('strong', { text: 'FIND: ' }), clueText);
  const msg = h('p', { class: 'game-msg', role: 'status', 'aria-live': 'assertive' });
  const retryBtn = h('button', { class: 'btn', type: 'button', text: 'RETRY' });
  const abortBtn = h('button', { class: 'btn btn--warn', type: 'button', text: 'ABORT' });
  retryBtn.hidden = true;

  const panel = h(
    'div', { class: 'game-panel cb-panel' },
    h('p', { class: 'game-kicker', text: '// ENCRYPTED CREW FILE' }),
    h('h2', { id: 'codebreaker-title', text: 'Break the access code' }),
    h('p', { class: 'game-hint', text: `Find the secret ${LEN}-letter word in ${MAX_TRIES} tries. Green: right letter, right spot. Yellow: right letter, wrong spot. Gray: not in the word.` }),
    clueBox,
    h('div', { class: 'game-hud' }, tryText, oxyText),
    board, msg, kb,
    h('div', { class: 'game-actions' }, retryBtn, abortBtn)
  );
  const overlay = h('div', { class: 'game-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'codebreaker-title' }, panel);
  document.body.appendChild(overlay);

  // ---- game state ----
  let answer = '';
  let row = 0;
  let current = '';
  let busy = false; // true while a row is being revealed or the game is over
  let over = false;
  let closed = false;
  let guesses = [];
  const timers = [];

  const later = (fn, ms) => { timers.push(setTimeout(fn, ms)); };
  const say = (t) => { msg.textContent = t; };
  const refresh = () => {
    tryText.textContent = `TRY ${Math.min(row + 1, MAX_TRIES)} / ${MAX_TRIES}`;
    oxyText.textContent = `O2 ${Math.round(getState().oxygen)}%`;
  };
  const tiles = (r) => [...rowEls[r].children];

  function newAttempt() {
    timers.splice(0).forEach(clearTimeout);
    const pick = pickWord();
    answer = pick.word;
    catText.textContent = pick.cat;
    clueText.textContent = `${pick.clue}. Starts with ${answer[0]}.`;
    row = 0;
    current = '';
    busy = false;
    over = false;
    guesses = [];
    for (const r of rowEls) {
      for (const t of r.children) {
        t.textContent = '';
        t.className = 'cb-tile';
        t.setAttribute('aria-label', 'empty');
      }
    }
    for (const k of Object.values(keyEls)) k.className = 'cb-key';
    retryBtn.hidden = true;
    say('');
    refresh();
    board.focus({ preventScroll: true });
  }

  function shake(text) {
    say(text);
    audio.play('error');
    const el = rowEls[row];
    el.classList.remove('is-shake');
    void el.getBoundingClientRect(); // restart the CSS animation
    el.classList.add('is-shake');
  }

  function typeLetter(ch) {
    if (busy || current.length >= LEN) return;
    current += ch;
    const t = tiles(row)[current.length - 1];
    t.textContent = ch;
    t.classList.add('is-filled');
    t.setAttribute('aria-label', ch);
    say('');
    audio.play('tick');
  }

  function backspace() {
    if (busy || !current.length) return;
    const t = tiles(row)[current.length - 1];
    t.textContent = '';
    t.classList.remove('is-filled');
    t.setAttribute('aria-label', 'empty');
    current = current.slice(0, -1);
    say('');
  }

  function submit() {
    if (busy) return;
    // Input validation: full length, a real word, not already tried
    if (current.length < LEN) return shake('NOT ENOUGH LETTERS');
    if (!ANY_FIVE.test(current)) return shake('LETTERS ONLY');
    if (guesses.includes(current)) return shake('ALREADY TRIED');

    busy = true;
    const guess = current;
    guesses.push(guess);
    const result = scoreGuess(guess, answer);
    const ts = tiles(row);
    const thisRow = row;
    ts.forEach((t, i) => {
      later(() => {
        t.classList.add('is-reveal', `is-${result[i]}`);
        t.setAttribute('aria-label', `${guess[i]}, ${result[i] === 'correct' ? 'correct spot' : result[i] === 'present' ? 'wrong spot' : 'not in word'}`);
        const key = keyEls[guess[i]];
        const prev = key.dataset.state;
        if (!prev || RANK[result[i]] > RANK[prev]) {
          key.dataset.state = result[i];
          key.className = `cb-key is-${result[i]}`;
        }
        audio.play('tick');
      }, reduced ? 0 : i * FLIP_MS);
    });
    later(() => finishRow(guess, thisRow), reduced ? 30 : LEN * FLIP_MS + 150);
  }

  function finishRow(guess, thisRow) {
    if (guess === answer) return win(thisRow + 1);
    row++;
    current = '';
    if (row >= MAX_TRIES) return lose();
    busy = false;
    say(`${MAX_TRIES - row} ${MAX_TRIES - row === 1 ? 'TRY' : 'TRIES'} LEFT`);
    refresh();
  }

  function win(tries) {
    over = true;
    refresh();
    say(`CODE CRACKED: ${answer} (${tries} ${tries === 1 ? 'try' : 'tries'})`);
    audio.play('win');
    emit('game:win', { game: 'codebreaker' });
    emit('room:power', { room });
    emit('xp:add', { amount: WIN_XP, reason: 'Codebreaker mini-game' });
    later(() => close(true), 1500);
  }

  function lose() {
    over = true;
    update({ oxygen: Math.max(0, getState().oxygen - OXYGEN_COST) });
    refresh();
    emit('game:lose', { game: 'codebreaker' });
    say(`ACCESS DENIED. The code was ${answer}. -${OXYGEN_COST} OXYGEN. Retry or abort.`);
    retryBtn.hidden = false;
    retryBtn.focus();
  }

  function close(won) {
    if (closed) return;
    closed = true;
    timers.splice(0).forEach(clearTimeout);
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
    active = null;
    if (previousFocus && previousFocus.focus) previousFocus.focus({ preventScroll: true });
    resolveGame(!!won);
  }

  /** Route one key press (physical or on-screen). */
  function press(key) {
    if (over) return;
    if (key === 'Enter') submit();
    else if (key === 'Backspace') backspace();
    else if (/^[A-Za-z]$/.test(key)) typeLetter(key.toUpperCase());
  }

  // ---- input: on-screen keyboard (mouse + touch). pointerdown keeps focus off the keys. ----
  kb.addEventListener('pointerdown', (e) => { if (e.target.closest('.cb-key')) e.preventDefault(); });
  kb.addEventListener('click', (e) => {
    const k = e.target.closest('.cb-key');
    if (k) press(k.dataset.key);
  });

  // ---- input: physical keyboard (Escape aborts, Tab stays inside) ----
  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close(false);
    } else if (e.key === 'Tab') {
      const f = [...overlay.querySelectorAll('.game-actions button:not([hidden]):not(:disabled)')];
      e.preventDefault();
      if (!f.length) return;
      const i = f.indexOf(document.activeElement);
      f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus();
    } else if (e.ctrlKey || e.metaKey || e.altKey) {
      // leave browser shortcuts alone
    } else if (e.key === 'Enter' || e.key === ' ') {
      // Retry / Abort handle their own Enter and Space
      if (e.target.closest?.('button')) return;
      if (e.key === 'Enter') { e.preventDefault(); press('Enter'); }
    } else if (e.key === 'Backspace' || /^[A-Za-z]$/.test(e.key)) {
      e.preventDefault();
      if (!e.repeat || e.key === 'Backspace') press(e.key);
    }
  }
  document.addEventListener('keydown', onKey, true);

  retryBtn.addEventListener('click', newAttempt);
  abortBtn.addEventListener('click', () => close(false));

  active = { promise };
  newAttempt();
  return promise;
}
