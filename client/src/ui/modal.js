// Accessible modal dialog mounted in #modal-root. One modal at a time.
// Esc, the close button and a click on the backdrop all close it; Tab stays inside;
// focus returns to whatever opened it. All text is inserted with textContent (no HTML injection).

let current = null; // { root, onClose, previousFocus, keyHandler }

const isWebLink = (href) => /^https?:\/\//i.test(href || '');

function mk(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

/** Segmented level bar, e.g. 4 of 5 segments lit. Exposed to screen readers as a meter. */
function buildMeter({ label, value, max }) {
  const wrap = mk('div', 'meter');
  wrap.setAttribute('role', 'meter');
  wrap.setAttribute('aria-label', label);
  wrap.setAttribute('aria-valuemin', '0');
  wrap.setAttribute('aria-valuemax', String(max));
  wrap.setAttribute('aria-valuenow', String(value));
  wrap.append(mk('span', 'meter__label', label));
  const bar = mk('span', 'meter__bar');
  for (let i = 0; i < max; i++) bar.append(mk('span', i < value ? 'meter__seg is-on' : 'meter__seg'));
  wrap.append(bar, mk('span', 'meter__value', `${value} / ${max}`));
  return wrap;
}

export function isModalOpen() {
  return !!current;
}

/**
 * Open a modal.
 * @param {{
 *   kicker?: string, title: string, description?: string,
 *   meter?: {label:string, value:number, max:number},
 *   meta?: {label:string, value:string}[], details?: string[], detailsTitle?: string, content?: Node,
 *   chipsTitle?: string, chips?: string[],
 *   links?: {label:string, href:string}[], onClose?: Function
 * }} cfg
 */
export function openModal(cfg) {
  if (current) closeModal();
  const mount = document.getElementById('modal-root') || document.body;
  const previousFocus = document.activeElement;

  const backdrop = mk('div', 'modal-backdrop');
  const dialog = mk('div', 'modal');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'modal-title');
  dialog.tabIndex = -1;

  const close = mk('button', 'btn modal__close', 'CLOSE');
  close.type = 'button';
  close.setAttribute('aria-label', 'Close dialog');

  if (cfg.kicker) dialog.append(mk('p', 'modal__kicker', cfg.kicker));
  const title = mk('h2', 'modal__title', cfg.title);
  title.id = 'modal-title';
  dialog.append(title);
  if (cfg.description) dialog.append(mk('p', 'modal__text', cfg.description));
  if (cfg.meter) dialog.append(buildMeter(cfg.meter));

  if (cfg.meta?.length) {
    const dl = mk('dl', 'modal__meta');
    for (const m of cfg.meta) dl.append(mk('dt', '', m.label), mk('dd', '', m.value));
    dialog.append(dl);
  }
  if (cfg.details?.length) {
    if (cfg.detailsTitle) dialog.append(mk('p', 'modal__sub', cfg.detailsTitle));
    const ul = mk('ul', 'modal__list');
    for (const d of cfg.details) ul.append(mk('li', '', d));
    dialog.append(ul);
  }
  if (cfg.content instanceof Node) dialog.append(cfg.content); // custom body (e.g. the leaderboard)
  if (cfg.chips?.length) {
    if (cfg.chipsTitle) dialog.append(mk('p', 'modal__sub', cfg.chipsTitle));
    const ul = mk('ul', 'chips');
    ul.setAttribute('aria-label', cfg.chipsTitle || 'Technologies');
    for (const c of cfg.chips) ul.append(mk('li', 'chip', c));
    dialog.append(ul);
  }

  const actions = mk('div', 'modal__actions');
  for (const l of cfg.links || []) {
    if (!isWebLink(l.href)) continue;
    const a = mk('a', 'btn', l.label);
    a.href = l.href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    actions.append(a);
  }
  actions.append(close);
  dialog.append(actions);
  backdrop.append(dialog);
  mount.append(backdrop);

  const keyHandler = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation(); // do not also trigger the hub's Escape = back
      closeModal();
    } else if (e.key === 'Tab') {
      const f = [...dialog.querySelectorAll('a[href], button')];
      if (!f.length) return;
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  };
  document.addEventListener('keydown', keyHandler, true);
  close.addEventListener('click', closeModal);
  backdrop.addEventListener('pointerdown', (e) => { if (e.target === backdrop) closeModal(); });

  current = { root: backdrop, onClose: cfg.onClose, previousFocus, keyHandler };
  requestAnimationFrame(() => backdrop.classList.add('is-open'));
  dialog.focus({ preventScroll: true });
}

export function closeModal() {
  if (!current) return;
  const { root, onClose, previousFocus, keyHandler } = current;
  current = null;
  document.removeEventListener('keydown', keyHandler, true);
  root.remove();
  if (previousFocus && previousFocus.focus) previousFocus.focus({ preventScroll: true });
  if (onClose) onClose();
}
