// Tiny pub/sub event bus shared by every module.
// Known events:
//  'room:enter' {room}        'room:power' {room}
//  'xp:add' {amount, reason}  'achievement:unlock' {id}
//  'game:win' {game}          'game:lose' {game}
//  'chat:answer' {found, sources}   'avatar:talk' {state}

const KNOWN = new Set([
  'room:enter', 'room:power', 'xp:add', 'achievement:unlock',
  'game:win', 'game:lose', 'chat:answer', 'avatar:talk',
]);

const listeners = new Map();

/** Subscribe. Returns an unsubscribe function. */
export function on(event, handler) {
  if (import.meta.env?.DEV && !KNOWN.has(event)) console.warn(`[events] unknown event "${event}"`);
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(handler);
  return () => off(event, handler);
}

/** Unsubscribe a handler. */
export function off(event, handler) {
  listeners.get(event)?.delete(handler);
}

/** Publish an event. One failing handler never blocks the others. */
export function emit(event, payload = {}) {
  if (import.meta.env?.DEV && !KNOWN.has(event)) console.warn(`[events] unknown event "${event}"`);
  const set = listeners.get(event);
  if (!set) return;
  for (const handler of [...set]) {
    try {
      handler(payload);
    } catch (err) {
      console.error(`[events] handler for "${event}" threw`, err);
    }
  }
}
