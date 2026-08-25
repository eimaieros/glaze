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
 *   onPointer?: (e: PointerEvent) => void,
 *   onResize?: () => void,
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

  /** @param {number} now */
  const frame = (now) => {
    s.raf = requestAnimationFrame(frame);

    /**
     * Scroll velocity, normalised so that ~60px in a frame reads as 1.0, then
     * decayed rather than zeroed. Zeroing it the instant scrolling stops makes
     * the effect snap off; the decay is what makes it feel like it has weight.
     */
    const y = window.scrollY;
    const delta = (y - s.lastScrollY) / 60;
    s.lastScrollY = y;
    s.velocity = s.velocity * 0.86 + delta * 0.14;
    s.pointer.near *= 0.97;

    // The tier from framebudget, if the caller gave us one. `minimal` means the
    // device is already struggling: the correct amount of decoration is none.
    const tier = s.budget?.tier;
    if (tier === 'minimal') { s.stage.render([]); return; }
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

/** @param {Shared} s */
function stop(s) {
  if (!s.running) return;
  cancelAnimationFrame(s.raf);
  if (s.onPointer) window.removeEventListener('pointermove', s.onPointer);
  if (s.onResize) window.removeEventListener('resize', s.onResize);
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
