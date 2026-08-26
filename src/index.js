import { Stage } from './stage.js';
import { Registry } from './registry.js';
import { Layer } from './layer.js';
import { getEffect, EFFECTS } from './effects.js';

export { EFFECTS } from './effects.js';
export { Stage } from './stage.js';
export { Layer } from './layer.js';

/**
 * glaze — GPU effects over the DOM you already have.
 *
 * ```js
 * import { glaze } from 'glaze';
 * glaze('#hero img', { effect: 'displace' });
 * ```
 *
 * THE ONE PROMISE: if anything goes wrong, the page keeps its images.
 *
 * No WebGPU, no adapter, a device that dies mid-session, an image that fails to
 * decode, `prefers-reduced-motion` — every one of those paths ends with the
 * original DOM untouched and visible. That is not defensive politeness, it is
 * the difference between a library you can put on a client's site and one you
 * can only put in a demo. Safari only enabled WebGPU by default in 26.0, which
 * on iOS means iOS 26: plenty of real visitors still have none of it.
 */

/**
 * @typedef {{
 *   stage: Stage, registry: Registry, items: Set<Layer>,
 *   running: boolean, raf: number, t0: number,
 *   lastScrollY: number, velocity: number,
 *   pointer: { x: number, y: number, near: number },
 *   budget: { tier?: string }|null,
 *   suspenso: boolean,
 *   onPointer?: (e: PointerEvent) => void,
 *   onResize?: () => void,
 *   onVisibilidade?: () => void,
 * }} Shared
 */

/** One stage, one canvas, one loop, however many times glaze() is called. */
/** @type {Shared|null} */
let shared = null;

/** @returns {Shared} */
function getShared() {
  if (shared) return shared;
  shared = {
    stage: new Stage(),
    registry: new Registry(),
    items: new Set(),
    running: false,
    raf: 0,
    t0: 0,
    lastScrollY: 0,
    velocity: 0,
    pointer: { x: 0.5, y: 0.5, near: 0 },
    budget: null,
    suspenso: false,
  };
  return shared;
}

const prefersReducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * @param {string|HTMLElement|Iterable<HTMLElement>} target
 * @param {object} [options]
 * @param {keyof typeof EFFECTS} [options.effect='displace']
 * @param {number} [options.strength] 0..1
 * @param {{tier?: string}} [options.budget] a framebudget FrameBudget instance, optional
 * @param {boolean} [options.respectReducedMotion=true]
 * @returns {{ destroy(): void, elements: Layer[], active: boolean }}
 */
export function glaze(target, options = {}) {
  const {
    effect: effectName = 'displace',
    respectReducedMotion = true,
    budget = null,
    ...rest
  } = options;

  const nodes = resolve(target);
  const inert = { destroy() {}, elements: [], active: false };

  // Validate the effect name even on the inert path. A typo should fail loudly
  // at the call site, not silently do nothing on the machines without WebGPU.
  const effect = getEffect(effectName);

  if (!nodes.length) return inert;
  if (respectReducedMotion && prefersReducedMotion()) return inert;

  const s = getShared();
  if (budget) s.budget = budget;

  /** @type {Layer[]} */
  const created = [];

  (async () => {
    const ok = await s.stage.init();
    if (!ok) return; // no WebGPU. The images are already on screen. Done.

    for (const node of nodes) {
      const item = new Layer(/** @type {HTMLImageElement} */ (node), s.stage, effect, effectName, rest);
      const loaded = await item.load();
      if (!loaded) continue;
      s.registry.add(item);
      s.items.add(item);
      created.push(item);
    }
    if (s.items.size) start(s);
  })();

  return {
    elements: created,
    get active() { return s.stage.ready; },
    destroy() {
      for (const item of created) {
        s.registry.remove(item);
        s.items.delete(item);
        item.destroy();
      }
      if (!s.items.size) stop(s);
    },
  };
}

/**
 * @param {string|HTMLElement|Iterable<HTMLElement>} target
 * @returns {HTMLElement[]}
 */
function resolve(target) {
  if (typeof target === 'string') {
    if (typeof document === 'undefined') return [];
    return [...document.querySelectorAll(target)].map((n) => /** @type {HTMLElement} */ (n));
  }
  if (target && typeof (/** @type {any} */ (target)[Symbol.iterator]) === 'function') {
    return [.../** @type {Iterable<HTMLElement>} */ (target)];
  }
  return target ? [/** @type {HTMLElement} */ (target)] : [];
}

/** @param {Shared} s */
function start(s) {
  if (s.running) return;
  s.running = true;
  s.t0 = performance.now();
  s.lastScrollY = window.scrollY;

  s.onPointer = (e) => {
    s.pointer.x = e.clientX / window.innerWidth;
    s.pointer.y = e.clientY / window.innerHeight;
    s.pointer.near = 1;
  };
  window.addEventListener('pointermove', s.onPointer, { passive: true });

  s.onResize = () => s.stage.resize();
  window.addEventListener('resize', s.onResize, { passive: true });

  /**
   * Chrome suspends requestAnimationFrame outright in a hidden tab, so the
   * canvas is presented once and then goes blank while the elements are still
   * hidden. Nobody is looking at a hidden tab, but something might be: an OS
   * window thumbnail, a print, a screenshot, a link-preview crawler. Handing
   * the DOM back costs one property write per element.
   */
  s.onVisibilidade = () => (document.hidden ? suspender(s) : retomar(s));
  document.addEventListener('visibilitychange', s.onVisibilidade);

  // A lost device means no more frames will ever be produced by this stage.
  s.stage.onLost = () => suspender(s);

  if (document.hidden) suspender(s);

  /** @param {number} now */
  const frame = (now) => {
    s.raf = requestAnimationFrame(frame);

    /**
     * Scroll velocity, normalised so ~30px in one frame — about 1800px/s —
     * reads as 1.0.
     *
     * THIRTY, NOT SIXTY, BECAUSE OF SMOOTH SCROLLING. The first version
     * assumed a wheel notch arrives as one 100px jump, which is true only of
     * native scrolling. `scroll-behavior: smooth`, Lenis, GSAP ScrollSmoother
     * and every other smooth-scroll library animate that same notch over
     * ~300ms instead, so the page moves about 16px in the busiest frame
     * rather than 100. Normalised by 60 that is v=0.26 — a quarter of the
     * effect, for input the user cannot tell apart.
     *
     * The demo had `scroll-behavior: smooth` in its own stylesheet, which is
     * how this hid: the two velocity-driven effects looked broken while the
     * progress-driven one looked fine, because progress does not care how
     * fast you got there.
     *
     * At 30 a smooth-scrolled notch reaches 0.53 and anything faster
     * saturates, which is the right trade: expressive enough to feel like
     * speed, low enough that the common case is visible at all.
     *
     * FAST ATTACK, SLOW RELEASE — and the asymmetry is the whole point.
     *
     * This started as a symmetric filter (`v = v*0.86 + delta*0.14`), which is
     * a low-pass filter, and it made the library look broken on a mouse. A
     * wheel notch is an impulse: Chrome moves ~100px in a single frame and
     * then nothing. Removing impulses is exactly what a low-pass filter does,
     * so one notch only ever reached v≈0.23 — about ten pixels of displacement
     * on a 1024px image. One percent. Invisible.
     *
     * It measured fine on a trackpad, where scrolling is continuous, which is
     * how it survived: the case it was tuned for was the case that hid it.
     *
     * Rising instantly to the peak and decaying from there gives the same
     * trackpad response (0.49 -> 0.50) and four times the response to a wheel
     * (0.23 -> 1.00). The decay is still what gives it weight; zeroing on stop
     * makes the effect snap off.
     */
    const y = window.scrollY;
    const delta = (y - s.lastScrollY) / 30;
    s.lastScrollY = y;
    const alvo = delta > 1 ? 1 : delta < -1 ? -1 : delta;
    s.velocity = Math.abs(alvo) > Math.abs(s.velocity)
      ? alvo                                  // attack: this frame's motion, now
      : s.velocity * 0.90 + alvo * 0.10;      // release: ~370ms back to rest
    s.pointer.near *= 0.97;

    /**
     * The tier from framebudget, if the caller gave us one. `minimal` means
     * the device is already struggling and the correct amount of decoration
     * is none — but "none" has to mean the plain images, not empty boxes.
     *
     * This used to be `s.stage.render([]); return;`, which cleared the canvas
     * and left every element hidden. On a struggling device, at the exact
     * moment you least want to break someone's page, glaze deleted all the
     * images. Rendering nothing is only a safe fallback if the DOM comes back
     * first.
     */
    const tier = s.budget?.tier;
    if (tier === 'minimal') { suspender(s); return; }
    if (s.suspenso) retomar(s);
    const scale = tier === 'reduced' ? 0.45 : 1;

    s.registry.measure();

    const t = (now - s.t0) / 1000;
    for (const item of s.items) {
      if (!item.visible) continue;
      const base = item.opts.strength ?? 0.5;
      item.opts.strength = base;
      item.update(t, s.velocity * scale, s.pointer);
    }
    s.stage.render(s.items);
  };
  s.raf = requestAnimationFrame(frame);
}

/**
 * Stop drawing and give the page its elements back.
 *
 * Always in that order. The canvas is cleared only after the real images are
 * on screen again, so there is never a frame with neither.
 * @param {Shared} s
 */
function suspender(s) {
  if (s.suspenso) return;
  s.suspenso = true;
  for (const item of s.items) item.mostrarDom();
  s.stage.render([]);
}

/** @param {Shared} s */
function retomar(s) {
  if (!s.suspenso) return;
  s.suspenso = false;
  for (const item of s.items) item.esconderDom();
  // The page may have scrolled or resized while we were not looking.
  s.registry.dirty = true;
}

/** @param {Shared} s */
function stop(s) {
  if (!s.running) return;
  cancelAnimationFrame(s.raf);
  if (s.onPointer) window.removeEventListener('pointermove', s.onPointer);
  if (s.onResize) window.removeEventListener('resize', s.onResize);
  if (s.onVisibilidade) document.removeEventListener('visibilitychange', s.onVisibilidade);
  s.running = false;
}

/** Tears down everything glaze created. Mostly for hot reload and tests. */
export function destroyAll() {
  if (!shared) return;
  for (const item of shared.items) item.destroy();
  shared.items.clear();
  stop(shared);
  shared.registry.destroy();
  shared.stage.destroy();
  shared = null;
}

export default glaze;
