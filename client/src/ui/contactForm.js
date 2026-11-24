// SEND DISTRESS SIGNAL TO EARTH: the contact form. Shared by the Comms Tower room (rooms/beacon.js)
// and the Quick Portfolio. POSTs to /api/contact { name, email, subject, message, website }.
//
// - Frontend validation: required fields, email regex, length limits, inline errors (aria-invalid + aria-describedby)
// - Hidden honeypot field `website` (must stay empty; bots that fill it get a fake success and nothing is sent)
// - Sends X-Form-Opened (when the form appeared) so the server can enforce its minimum time-to-submit;
//   a very fast submit just waits a moment ("aligning antenna") instead of failing
// - Success: a signal beam travels to Earth, then 'achievement:unlock' {id:'verdict'} if not unlocked yet
// - Errors: error toast (offline, rate limit, server problems) and inline messages from the server's field errors
//
// Exports: createContactForm(opts) -> { el, reset, focus, destroy }, validateFields, EMAIL_RE, LIMITS.

import '../styles/beacon.css';
import { getState, update } from '../core/state.js';
import { unlockAchievement } from './achievements.js';
import profile from '@data/profile.json';

const API_URL = '/api/contact';
const TIMEOUT_MS = 20000;
const MIN_FORM_MS = 3200; // the server wants at least 3 s; a little extra for clock differences
export const EMAIL_RE = /^[^\s@<>"',;]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;
export const LIMITS = {
  name: { min: 2, max: 80 },
  email: { max: 254 },
  subject: { min: 3, max: 120 },
  message: { min: 10, max: 2000 },
};
const FIELDS = [
  { id: 'name', label: 'YOUR NAME', autocomplete: 'name' },
  { id: 'email', label: 'YOUR EMAIL', autocomplete: 'email', inputmode: 'email' },
  { id: 'subject', label: 'SUBJECT', autocomplete: 'off' },
  { id: 'message', label: 'MESSAGE', textarea: true },
];
const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mk(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

/** Client-side validation. Returns { field: message } (empty object = valid). Same rules as the server. */
export function validateFields(v) {
  const e = {};
  const clean = (s) => String(s ?? '').trim();
  const name = clean(v.name);
  const email = clean(v.email);
  const subject = clean(v.subject);
  const message = clean(v.message);
  if (!name) e.name = 'Name is required.';
  else if (name.length < LIMITS.name.min || name.length > LIMITS.name.max) e.name = `Name must be ${LIMITS.name.min}-${LIMITS.name.max} characters.`;
  if (!email) e.email = 'Email is required.';
  else if (email.length > LIMITS.email.max || !EMAIL_RE.test(email)) e.email = 'Enter a valid email address.';
  if (!subject) e.subject = 'Subject is required.';
  else if (subject.length < LIMITS.subject.min || subject.length > LIMITS.subject.max) e.subject = `Subject must be ${LIMITS.subject.min}-${LIMITS.subject.max} characters.`;
  if (!message) e.message = 'Message is required.';
  else if (message.length < LIMITS.message.min) e.message = `Message needs at least ${LIMITS.message.min} characters.`;
  else if (message.length > LIMITS.message.max) e.message = `Message can be at most ${LIMITS.message.max} characters.`;
  return e;
}

// ---------- error toast (works in the game and in the Quick Portfolio) ----------
let toastEl = null;
let toastTimer = 0;
function showToast(text, ms = 6500) {
  if (!toastEl) {
    toastEl = mk('div', 'cf-toast');
    toastEl.setAttribute('role', 'alert');
    document.body.append(toastEl);
  }
  toastEl.textContent = text;
  toastEl.classList.add('is-show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl?.classList.remove('is-show'), ms);
}

/** The first time a message is sent: unlock 'verdict'. The game's progress module records it; elsewhere we do. */
function awardVerdict() {
  if (getState().achievements.includes('verdict')) return;
  unlockAchievement('verdict'); // emits 'achievement:unlock' {id:'verdict'}
  const s = getState();
  if (!s.achievements.includes('verdict')) update({ achievements: [...s.achievements, 'verdict'] });
}

/**
 * @param {{ onSuccess?: (info:{name:string,email:string}) => void, onToast?: (text:string) => void }} [opts]
 */
export function createContactForm({ onSuccess, onToast } = {}) {
  let opened = Date.now();
  let phase = 'idle'; // 'idle' | 'sending' | 'sent'
  let dead = false;
  const toast = (t) => (onToast ? onToast(t) : showToast(t));

  const root = mk('section', 'cf');
  root.setAttribute('aria-labelledby', 'cf-title');

  // ---------- form ----------
  const form = mk('form', 'cf__form');
  form.noValidate = true;
  form.setAttribute('novalidate', '');
  const title = mk('h2', 'cf__title', 'SEND DISTRESS SIGNAL TO EARTH');
  title.id = 'cf-title';
  const sub = mk('p', 'cf__sub', 'Your message is relayed straight to Muhammad. He will reply by email.');
  form.append(title, sub);

  const inputs = {};
  const errEls = {};
  for (const f of FIELDS) {
    const wrap = mk('div', 'cf__field');
    const id = `cf-${f.id}`;
    const label = mk('label', 'cf__label', f.label);
    label.htmlFor = id;
    const input = f.textarea ? mk('textarea', 'cf__input cf__input--area') : mk('input', 'cf__input');
    input.id = id;
    input.name = f.id;
    if (f.textarea) input.rows = 5;
    else input.type = 'text';
    if (f.inputmode) input.inputMode = f.inputmode;
    input.autocomplete = f.autocomplete || 'off';
    input.maxLength = f.textarea ? LIMITS.message.max + 200 : (LIMITS[f.id]?.max || 120) + 20; // soft cap: the validator explains overruns
    input.setAttribute('aria-required', 'true');
    input.setAttribute('aria-describedby', `${id}-err`);
    input.spellcheck = f.id === 'message';
    const err = mk('p', 'cf__err');
    err.id = `${id}-err`;
    wrap.append(label, input);
    if (f.textarea) {
      const count = mk('span', 'cf__count', `0 / ${LIMITS.message.max}`);
      count.setAttribute('aria-hidden', 'true');
      input.addEventListener('input', () => {
        const n = input.value.trim().length;
        count.textContent = `${n} / ${LIMITS.message.max}`;
        count.classList.toggle('is-over', n > LIMITS.message.max);
      });
      wrap.append(count);
    }
    wrap.append(err);
    form.append(wrap);
    inputs[f.id] = input;
    errEls[f.id] = err;
  }

  // Honeypot: off-screen, skipped by Tab and screen readers. Humans never fill it.
  const hpWrap = mk('div', 'cf__hp');
  hpWrap.setAttribute('aria-hidden', 'true');
  const hpLabel = mk('label', '', 'Website');
  hpLabel.htmlFor = 'cf-website';
  const hp = mk('input');
  hp.type = 'text';
  hp.id = 'cf-website';
  hp.name = 'website';
  hp.tabIndex = -1;
  hp.autocomplete = 'off';
  hpWrap.append(hpLabel, hp);

  const submit = mk('button', 'cf__send', 'TRANSMIT SIGNAL');
  submit.type = 'submit';
  const status = mk('p', 'cf__status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const direct = mk('p', 'cf__direct');
  direct.append('Prefer email? ');
  const mail = mk('a', '', profile.contact.email);
  mail.href = `mailto:${profile.contact.email}`;
  direct.append(mail);
  form.append(hpWrap, submit, status, direct);
  root.append(form);

  // ---------- helpers ----------
  const values = () => ({
    name: inputs.name.value,
    email: inputs.email.value,
    subject: inputs.subject.value,
    message: inputs.message.value,
  });

  function setError(id, text) {
    errEls[id].textContent = text || '';
    inputs[id].setAttribute('aria-invalid', text ? 'true' : 'false');
    inputs[id].classList.toggle('is-invalid', !!text);
  }
  function showErrors(errs, focusFirst = true) {
    let first = null;
    for (const f of FIELDS) {
      setError(f.id, errs[f.id]);
      if (errs[f.id] && !first) first = f.id;
    }
    if (first && focusFirst) inputs[first].focus();
    return first;
  }
  function setSending(on_, text = '') {
    phase = on_ ? 'sending' : 'idle';
    submit.disabled = on_;
    submit.textContent = on_ ? 'TRANSMITTING...' : 'TRANSMIT SIGNAL';
    form.setAttribute('aria-busy', String(on_));
    status.textContent = on_ ? text : '';
    for (const k in inputs) inputs[k].readOnly = on_;
  }

  // Validate a field when the visitor leaves it, and clear its error as soon as they fix it
  for (const f of FIELDS) {
    inputs[f.id].addEventListener('blur', () => {
      if (!inputs[f.id].value && !inputs[f.id].classList.contains('is-invalid')) return; // untouched
      setError(f.id, validateFields(values())[f.id]);
    });
    inputs[f.id].addEventListener('input', () => {
      if (inputs[f.id].classList.contains('is-invalid')) setError(f.id, validateFields(values())[f.id]);
    });
  }

  // ---------- success: the beam to Earth ----------
  function showSuccess({ name, email }) {
    phase = 'sent';
    const done = mk('div', 'cf-sent');
    done.setAttribute('role', 'status');
    const scene = mk('div', 'cf-sent__scene');
    scene.setAttribute('aria-hidden', 'true');
    const tower = mk('span', 'cf-sent__tower');
    const beam = mk('span', 'cf-sent__beam');
    beam.append(mk('span', 'cf-sent__pulse'));
    const earth = mk('span', 'cf-sent__earth');
    scene.append(tower, beam, earth);
    if (reducedMotion()) done.classList.add('is-static');
    const h = mk('h2', 'cf__title', 'SIGNAL RECEIVED ON EARTH');
    const p = mk('p', 'cf-sent__text', `Thank you, ${name}. Your transmission was delivered. Muhammad will reply to ${email}.`);
    const again = mk('button', 'cf__send cf__send--ghost', 'SEND ANOTHER SIGNAL');
    again.type = 'button';
    again.addEventListener('click', reset);
    done.append(scene, h, p, again);
    form.hidden = true;
    root.append(done);
    again.focus({ preventScroll: true });
  }

  function reset() {
    root.querySelector('.cf-sent')?.remove();
    form.hidden = false;
    form.reset();
    showErrors({}, false);
    inputs.message.dispatchEvent(new Event('input'));
    opened = Date.now();
    phase = 'idle';
    submit.disabled = false;
    submit.textContent = 'TRANSMIT SIGNAL';
    status.textContent = '';
    inputs.name.focus({ preventScroll: true });
  }

  // ---------- network ----------
  async function send(v) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Form-Opened': String(opened) },
        body: JSON.stringify({ name: v.name.trim(), email: v.email.trim(), subject: v.subject.trim(), message: v.message.trim(), website: '' }),
        signal: ctrl.signal,
      });
      const data = await res.json().catch(() => null);
      return { status: res.status, data };
    } finally {
      clearTimeout(timer);
    }
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (phase !== 'idle') return;
    const v = values();
    const errs = validateFields(v);
    if (showErrors(errs)) {
      toast('Check the highlighted fields and try again.');
      return;
    }
    if (hp.value.trim() !== '') return showSuccess({ name: v.name.trim(), email: v.email.trim() }); // bot: pretend, send nothing

    setSending(true, 'Sending...');
    const wait = MIN_FORM_MS - (Date.now() - opened);
    if (wait > 0) {
      status.textContent = 'ALIGNING ANTENNA...';
      await sleep(wait);
      if (dead) return;
    }
    status.textContent = 'TRANSMITTING TO EARTH...';

    let r;
    try {
      r = await send(v);
    } catch (err) {
      if (dead) return;
      setSending(false);
      toast(err?.name === 'AbortError'
        ? 'TRANSMISSION TIMED OUT. Nothing was sent. Please try again.'
        : `UPLINK OFFLINE. The server is not reachable, so nothing was sent. You can email ${profile.contact.email} instead.`);
      return;
    }
    if (dead) return;

    if (r.status === 200 && r.data?.ok === true) {
      setSending(false);
      showSuccess({ name: v.name.trim(), email: v.email.trim() });
      awardVerdict();
      onSuccess?.({ name: v.name.trim(), email: v.email.trim() });
      return;
    }

    setSending(false);
    const msg = r.data?.error || 'Something went wrong. Please try again.';
    if (r.data?.fields && typeof r.data.fields === 'object') showErrors(r.data.fields); // server-side field errors, inline
    else if (r.status === 400) opened = Date.now(); // expired or missing form session: start a fresh one
    toast(r.status === 429 ? msg : r.status >= 500 ? msg : `Not sent. ${msg}`);
  });

  return {
    el: root,
    reset,
    focus: () => inputs.name.focus({ preventScroll: true }),
    destroy() {
      dead = true;
      clearTimeout(toastTimer);
      toastEl?.remove();
      toastEl = null;
      root.remove();
    },
  };
}
