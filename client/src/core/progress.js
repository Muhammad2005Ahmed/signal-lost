// Progression rules: turns game events into saved state.
//  xp:add             -> adds XP (rank is derived by state.js)
//  achievement:unlock -> saves the id once and awards that achievement's XP
//  room:power         -> marks the room powered; 'full_power' at all four (the beacon unlocks via the boss quiz in ui/hud.js)
//  game:win           -> records the mini-game and unlocks its achievement (survivor needs oxygen + asteroids)
// Call initProgress() once at boot.

import { on, emit } from './events.js';
import { getState, update } from './state.js';
import achievements from '@data/achievements.json';

const POWER_ROOMS = ['about', 'projects', 'skills', 'education'];
const WIN_ACHIEVEMENT = { wires: 'wire_master', codebreaker: 'code_breaker' };
let started = false;

export function initProgress() {
  if (started) return;
  started = true;

  on('xp:add', ({ amount }) => {
    if (!Number.isFinite(amount) || amount <= 0) return;
    update({ xp: getState().xp + amount });
  });

  on('achievement:unlock', ({ id }) => {
    const s = getState();
    if (!id || s.achievements.includes(id)) return;
    update({ achievements: [...s.achievements, id] });
    const a = achievements.find((x) => x.id === id);
    if (a) emit('xp:add', { amount: a.xp, reason: a.title });
  });

  on('room:power', ({ room }) => {
    if (!POWER_ROOMS.includes(room) || getState().power[room]) return;
    update({ power: { [room]: true } });
    emit('achievement:unlock', { id: 'power_up' });
    if (POWER_ROOMS.every((r) => getState().power[r])) {
      emit('achievement:unlock', { id: 'full_power' });
    }
  });

  on('game:win', ({ game }) => {
    const s = getState();
    const won = s.minigamesWon.includes(game) ? s.minigamesWon : [...s.minigamesWon, game];
    if (won !== s.minigamesWon) update({ minigamesWon: won });
    if (WIN_ACHIEVEMENT[game]) emit('achievement:unlock', { id: WIN_ACHIEVEMENT[game] });
    // Survivor needs both survival games
    if (won.includes('oxygen') && won.includes('asteroids')) emit('achievement:unlock', { id: 'survivor' });
  });
}
