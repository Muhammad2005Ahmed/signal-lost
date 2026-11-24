// Audio: fully procedural Web Audio (no asset files). Ambient station drone that brightens
// with power, plus sound effects wired to the event bus. The AudioContext starts on the
// first user gesture (browser autoplay policy). Sound always starts ON; mute is only the HUD button
// and is never remembered (so it can never stay muted by accident).

import { on } from './events.js';
import { getPowerPercent } from './state.js';

const MASTER_LEVEL = 0.8;

let ctx = null;
let master = null;
let sfxBus = null;
let ambientBus = null;
let ambient = null; // { nodes..., stop() }
let noiseBuf = null;
let muted = false;
let wired = false;

function ensureContext() {
  if (ctx) return ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  ctx = new AC();
  master = ctx.createGain();
  master.gain.value = muted ? 0 : MASTER_LEVEL;
  master.connect(ctx.destination);
  sfxBus = ctx.createGain();
  sfxBus.gain.value = 0.9;
  sfxBus.connect(master);
  ambientBus = ctx.createGain();
  ambientBus.gain.value = 0;
  ambientBus.connect(master);

  // One second of white noise, reused by every noise-based sound
  noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return ctx;
}

/** Single enveloped oscillator note. */
function tone({ type = 'sine', freq = 440, freq2, dur = 0.15, vol = 0.15, attack = 0.005, delay = 0 }) {
  const t0 = ctx.currentTime + delay;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (freq2) osc.frequency.exponentialRampToValueAtTime(freq2, t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(vol, t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(sfxBus);
  osc.start(t0);
  osc.stop(t0 + dur + 0.05);
}

/** Band-passed noise whose centre frequency sweeps from `from` to `to`. */
function sweep({ from = 300, to = 2000, dur = 0.5, vol = 0.2, q = 1.2, delay = 0 }) {
  const t0 = ctx.currentTime + delay;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  src.loop = true;
  const f = ctx.createBiquadFilter();
  f.type = 'bandpass';
  f.Q.value = q;
  f.frequency.setValueAtTime(from, t0);
  f.frequency.exponentialRampToValueAtTime(to, t0 + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(vol, t0 + dur * 0.3);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(f).connect(g).connect(sfxBus);
  src.start(t0);
  src.stop(t0 + dur + 0.05);
}

const SFX = {
  hover: () => tone({ freq: 1400, dur: 0.04, vol: 0.04 }),
  tick: () => tone({ freq: 1200, dur: 0.05, vol: 0.06 }),
  click: () => tone({ type: 'triangle', freq: 880, freq2: 620, dur: 0.09, vol: 0.12 }),
  flicker: () => sweep({ from: 2400, to: 1800, dur: 0.07, vol: 0.07, q: 3 }),
  powerOn: () => {
    sweep({ from: 120, to: 1400, dur: 0.9, vol: 0.22, q: 0.8 });
    tone({ type: 'sawtooth', freq: 90, freq2: 360, dur: 0.8, vol: 0.08 });
    tone({ freq: 660, dur: 0.4, vol: 0.1, delay: 0.7 });
    tone({ freq: 990, dur: 0.5, vol: 0.1, delay: 0.85 });
  },
  whoosh: () => sweep({ from: 250, to: 2600, dur: 1.2, vol: 0.28, q: 0.9 }),
  error: () => {
    tone({ type: 'sawtooth', freq: 150, dur: 0.22, vol: 0.12 });
    tone({ type: 'sawtooth', freq: 110, dur: 0.3, vol: 0.12, delay: 0.12 });
  },
  chime: () => [660, 880, 1320].forEach((f, i) => tone({ freq: f, dur: 0.35, vol: 0.12, delay: i * 0.11 })),
  secret: () => {
    tone({ type: 'triangle', freq: 330, freq2: 335, dur: 0.9, vol: 0.12 });
    tone({ type: 'triangle', freq: 495, freq2: 500, dur: 1.1, vol: 0.1, delay: 0.15 });
    sweep({ from: 3000, to: 600, dur: 1.0, vol: 0.08, q: 4 });
  },
  win: () => [523, 659, 784, 1047].forEach((f, i) => tone({ type: 'triangle', freq: f, dur: 0.3, vol: 0.13, delay: i * 0.1 })),
  lose: () => tone({ type: 'sawtooth', freq: 330, freq2: 140, dur: 0.6, vol: 0.12 }),
};

/** Start the looping station drone (idempotent). Brightness follows power. */
function startAmbient() {
  if (!ctx || ambient) return;
  const low = ctx.createOscillator();
  low.type = 'sine';
  low.frequency.value = 55;
  const mid = ctx.createOscillator();
  mid.type = 'sawtooth';
  mid.frequency.value = 110.4; // 110 Hz: audible on laptop speakers (55 Hz is not)
  const hi = ctx.createOscillator();
  hi.type = 'triangle';
  hi.frequency.value = 220;
  const hiGain = ctx.createGain();
  hiGain.gain.value = 0;

  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 320;
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 0.12;
  const lfoDepth = ctx.createGain();
  lfoDepth.gain.value = 60;
  lfo.connect(lfoDepth).connect(lp.frequency);

  const hum = ctx.createBufferSource();
  hum.buffer = noiseBuf;
  hum.loop = true;
  const humFilter = ctx.createBiquadFilter();
  humFilter.type = 'lowpass';
  humFilter.frequency.value = 380;
  const humGain = ctx.createGain();
  humGain.gain.value = 0.35;

  low.connect(lp);
  mid.connect(lp);
  hi.connect(hiGain).connect(lp);
  lp.connect(ambientBus);
  hum.connect(humFilter).connect(humGain).connect(ambientBus);
  [low, mid, hi, lfo, hum].forEach((n) => n.start());

  ambient = { hiGain, lp, nodes: [low, mid, hi, lfo, hum] };
  setPower(getPowerPercent());
}

/** Brighter, fuller drone as more of the station is powered (0 to 100). */
function setPower(percent) {
  if (!ctx || !ambient) return;
  const p = Math.max(0, Math.min(100, percent)) / 100;
  const t = ctx.currentTime;
  // clearly audible from the start (0.22), fuller as power returns (up to 0.38), still below the SFX level
  ambientBus.gain.setTargetAtTime(0.22 + 0.16 * p, t, 0.6);
  ambient.hiGain.gain.setTargetAtTime(0.5 * p, t, 0.8);
  ambient.lp.frequency.setTargetAtTime(320 + 500 * p, t, 0.8);
}

function setMuted(v) {
  muted = !!v;
  if (master) master.gain.setTargetAtTime(muted ? 0 : MASTER_LEVEL, ctx.currentTime, 0.05);
}

export const audio = {
  /** Create/resume the context. Call from a user gesture (the start button does). */
  unlock() {
    if (!ensureContext()) return;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    startAmbient();
  },
  play(name) {
    if (!ctx || muted || ctx.state !== 'running') return;
    try { SFX[name]?.(); } catch (err) { console.warn('[audio] sfx failed', name, err); }
  },
  setPower,
  setMuted,
  toggleMute() { setMuted(!muted); return muted; },
  isMuted() { return muted; },
};

/** Wire event-bus sounds, autoplay unlock. Safe to call more than once. */
export function initAudio() {
  if (wired) return audio;
  wired = true;

  const unlockOnce = () => {
    audio.unlock();
    window.removeEventListener('pointerdown', unlockOnce);
    window.removeEventListener('keydown', unlockOnce);
  };
  window.addEventListener('pointerdown', unlockOnce);
  window.addEventListener('keydown', unlockOnce);

  document.addEventListener('visibilitychange', () => {
    if (!ctx) return;
    if (document.hidden) ctx.suspend().catch(() => {});
    else ctx.resume().catch(() => {});
  });

  on('room:power', () => {
    audio.play('powerOn');
    setPower(getPowerPercent());
  });
  on('achievement:unlock', ({ id }) => audio.play(id === 'hidden_beacon' ? 'secret' : 'chime'));
  on('game:win', () => audio.play('win'));
  on('game:lose', () => audio.play('lose'));
  on('xp:add', () => audio.play('tick'));
  on('chat:answer', ({ found }) => audio.play(found ? 'click' : 'error'));
  return audio;
}
