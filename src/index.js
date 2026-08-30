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
 *   lastNow: number,
 *   velocitySource: (() => number|null)|null,
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
    lastNow: 0,
    velocitySource: null,
  };
  return shared;
}

const prefersReducedMotion = () => {
  try {
    return typeof matchMedia === 'function' &&
      matchMedia('(prefers-reduced-motion: reduce)').matches === true;
  } catch {
    // Embedded webviews sometimes expose matchMedia before it is usable.
    // Accessibility detection is an enhancement, never a reason to remove DOM.
    return false;
  }
};

/**
 * @param {string|HTMLElement|Iterable<HTMLElement>} target
 * @param {object} [options]
 * @param {keyof typeof EFFECTS} [options.effect='displace']
 * @param {number} [options.strength] 0..1
 * @param {{tier?: string}} [options.budget]
 *   A framebudget instance. Like `velocity`, this is a property of the shared
 *   loop rather than of these elements: there is one loop for the whole page,
 *   so the last call that passes one wins. Pass it once.
 * @param {() => number|null} [options.velocity]
 *   Supply your own scroll velocity, normalised to -1..1, instead of letting
 *   glaze read `window.scrollY`. Required if you use a smooth-scroll library
 *   that transforms the page rather than scrolling it — Lenis, GSAP
 *   ScrollSmoother — because `window.scrollY` barely moves on those.
 *   Return `null` on any frame to hand the reading back to glaze.
 *
 *   Also a property of the shared loop, not of these elements — the last call
 *   that passes one wins. That is a consequence of there being a single
 *   animation loop for the page, which is the point of the architecture.
 * @param {number} [options.scale]
 *   `displace` only: the spatial frequency of the warp. Effect-specific
 *   parameters have to be listed here to reach TypeScript callers — this one
 *   was in the README and in the effect's defaults while `tsc` rejected it,
 *   which is the same lie as an option the shader never reads, one layer up.
 *   A custom effect with its own `extras` needs a cast at the call site.
 * @param {boolean} [options.respectReducedMotion=true]
 * @returns {{ destroy(): void, elements: Layer[], active: boolean }}
 */
export function glaze(target, options = {}) {
  const {
    effect: effectName = 'displace',
    respectReducedMotion = true,
    budget = null,
    velocity = null,
    ...rest
  } = options;

  const nodes = resolve(target);
  const inert = { destroy() {}, elements: [], active: false };

  // Validate the effect name even on the inert path. A typo should fail loudly
  // at the call site, not silently do nothing on the machines without WebGPU.
  const effect = getEffect(effectName);
  const numericOptions = /** @type {Record<string, unknown>} */ (rest);
  const strength = numericOptions.strength;
  if (strength !== undefined &&
      (typeof strength !== 'number' || !Number.isFinite(strength) || strength < 0 || strength > 1)) {
    throw new RangeError('glaze: strength must be a finite number between 0 and 1');
  }
  for (const name of effect.extras ?? []) {
    const value = numericOptions[name];
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) {
      throw new RangeError(`glaze: ${name} must be a finite number`);
    }
  }

  if (!nodes.length) return inert;
  if (respectReducedMotion && prefersReducedMotion()) return inert;

  const s = getShared();
  if (budget) s.budget = budget;
  if (velocity) s.velocitySource = velocity;

  /** @type {Layer[]} */
  const created = [];
  let destroyed = false;
  /** @type {Layer|null} */
  let pending = null;

  (async () => {
    try {
      const ok = await s.stage.init();
      if (!ok || destroyed) return; // no WebGPU, or the caller already left

      for (const node of nodes) {
        if (destroyed) break;
        pending = new Layer(/** @type {HTMLImageElement} */ (node), s.stage, effect, effectName, rest);
        const loaded = await pending.load();
        if (!loaded) { pending = null; continue; }
        // destroy() may run while decode/upload is awaiting. Never let an
        // already-destroyed handle hide an image or join the shared loop later.
        if (destroyed) {
          pending.destroy();
          pending = null;
          continue;
        }
        s.registry.add(pending);
        s.items.add(pending);
        created.push(pending);
        pending = null;
      }
      if (s.items.size) start(s);
    } catch (error) {
      // A browser/GPU implementation can still throw somewhere an individual
      // feature probe did not predict. Restore every element owned by this
      // handle and contain the failure instead of creating an unhandled
      // rejection with an image left hidden.
      pending?.destroy();
      pending = null;
      for (const item of created) {
        s.registry.remove(item);
        s.items.delete(item);
        item.destroy();
      }
      created.length = 0;
      if (!s.items.size) stop(s);
      globalThis.console?.warn?.('[glaze] effect disabled after an unexpected error', error);
    }
  })();

  return {
    elements: created,
    get active() { return !destroyed && s.stage.ready && created.some((item) => item.ready); },
    destroy() {
      destroyed = true;
      pending?.destroy();
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
  s.lastNow = s.t0;
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

  // A lost device cannot recover inside this stage. Restore the DOM and cancel
  // the shared loop instead of spending one rAF callback per frame forever.
  s.stage.onLost = () => { suspender(s); stop(s); };

  if (document.hidden) suspender(s);

  /** @param {number} now */
  const frame = (now) => {
    s.raf = requestAnimationFrame(frame);

    // Devices may be lost between any two frames. onLost restores the DOM,
    // and this guard prevents the next scheduled frame from hiding it again.
    if (!s.stage.ready) { suspender(s); return; }

    /**
     * Scroll velocity in pixels per second, normalised so 1800px/s reads as
     * 1.0. A caller with its own scroller (Lenis, GSAP ScrollSmoother, a
     * virtualised list) can supply `velocity` instead and bypass all of this.
     *
     * PER SECOND, NOT PER FRAME — and that took three rewrites to get right.
     *
     * The first version was `delta = (y - last) / 60`, which asks "how far did
     * the page move since the last frame" and calls 60px a full-strength
     * scroll. That silently ties the effect to the monitor. The same physical
     * flick measured on real hardware:
     *
     *     60 Hz   33px in the busiest frame   v = 1.00
     *     71 Hz   27px                        v = 0.90
     *    102 Hz   20px                        v = 0.66
     *    144 Hz   14px                        v = 0.48
     *
     * Half the effect on a good monitor, for the identical gesture. Dividing
     * by elapsed time instead gives 1.00 on all four, which is the only
     * defensible answer — the user moved the page at a speed, and speed is
     * distance over time.
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
     * The decay is what gives it weight; zeroing on stop makes the effect snap
     * off. It is also frame-rate corrected, for the same reason as above.
     */
    const y = window.scrollY;
    const dtMs = Math.min(Math.max(now - s.lastNow, 1), 100);
    s.lastNow = now;

    // A source may return null or undefined to mean "you take it from here",
    // so a caller can override velocity only some of the time without having
    // to reimplement the scroll reading themselves.
    let alvo = s.velocitySource ? s.velocitySource() : null;
    if (typeof alvo !== 'number' || Number.isNaN(alvo)) {
      alvo = (y - s.lastScrollY) / (dtMs / 1000) / 1800;
    }
    s.lastScrollY = y;
    alvo = alvo > 1 ? 1 : alvo < -1 ? -1 : alvo;

    // 0.90 per frame at 60fps, held constant in real time so the settle feels
    // the same on a 144Hz screen as on a 60Hz one.
    const decay = Math.pow(0.90, dtMs / 16.667);
    s.velocity = Math.abs(alvo) > Math.abs(s.velocity)
      ? alvo                                          // attack: now
      : s.velocity * decay + alvo * (1 - decay);      // release: ~370ms
    s.pointer.near *= Math.pow(0.97, dtMs / 16.667);

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
    const strengthScale = tier === 'reduced' ? 0.45 : 1;

    s.registry.measure();

    const t = (now - s.t0) / 1000;
    for (const item of s.items) {
      if (!item.visible) continue;
      item.update(t, s.velocity, s.pointer, strengthScale);
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
