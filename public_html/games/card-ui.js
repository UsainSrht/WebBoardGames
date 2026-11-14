/** Small DOM helpers shared by the card games (Go Fish, Papaz Kacti). */

const flights = new Set();
const timeouts = new Set();

export const reduced = () => !!window.WBG?.prefs?.reduceMotion || !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export const centerOf = (el) => {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return r.width || r.height ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
};

/** Fly a card (html) from one point to another. Calls onEnd when it lands (or at once when motion is reduced). */
export function fly({ html, from, to, w = 52, delay = 0, duration = 460, spin = 0, onEnd }) {
  if (!from || !to || reduced()) { onEnd?.(); return; }
  const h = w * 1.4;
  const el = document.createElement('div');
  el.style.cssText = `position:fixed;left:${from.x - w / 2}px;top:${from.y - h / 2}px;width:${w}px;height:${h}px;z-index:60;pointer-events:none;opacity:0;will-change:transform`;
  el.innerHTML = html;
  document.body.appendChild(el);
  flights.add(el);
  const anim = el.animate(
    [
      { transform: 'translate(0,0) rotate(0deg) scale(1)', opacity: 1 },
      { transform: `translate(${to.x - from.x}px,${to.y - from.y}px) rotate(${spin}deg) scale(.9)`, opacity: 1 }
    ],
    { duration, delay, easing: 'cubic-bezier(.2,.8,.3,1)', fill: 'both' }
  );
  anim.onfinish = anim.oncancel = () => { el.remove(); flights.delete(el); onEnd?.(); };
}

/** setTimeout that is cancelled by clearAll(). */
export function later(fn, ms) {
  const id = setTimeout(() => { timeouts.delete(id); fn(); }, ms);
  timeouts.add(id);
  return id;
}

/** A short floating label (speech bubble) next to an element. */
export function bubble(el, text, { tone = 'brand', ms = 1700 } = {}) {
  const c = centerOf(el);
  if (!c) return;
  const b = document.createElement('div');
  const colors = { brand: 'bg-brand-500 text-white', warn: 'bg-amber-400 text-ink-900', good: 'bg-emerald-500 text-white', bad: 'bg-rose-600 text-white' };
  b.className = `${colors[tone] || colors.brand} pointer-events-none fixed z-50 max-w-[16rem] -translate-x-1/2 -translate-y-full rounded-xl px-3 py-1.5 text-center text-xs font-bold shadow-lg animate-pop`;
  b.style.left = `${Math.min(Math.max(c.x, 90), window.innerWidth - 90)}px`;
  b.style.top = `${el.getBoundingClientRect().top - 4}px`;
  b.textContent = text;
  document.body.appendChild(b);
  later(() => b.remove(), ms);
  flights.add(b);
  later(() => flights.delete(b), ms);
}

export function clearAll() {
  for (const t of timeouts) clearTimeout(t);
  timeouts.clear();
  for (const el of flights) el.remove();
  flights.clear();
}
