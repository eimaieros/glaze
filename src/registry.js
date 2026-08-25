/**
 * Keeps every effected element's quad aligned to the DOM rect it is standing
 * in for, and decides which ones are worth drawing.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE: read all the layout, then write all the
 * layout. Never alternate.
 *
 * Asking an element for `getBoundingClientRect()` forces the browser to flush
 * pending style and layout work. Do that once and it costs almost nothing. Do
 * it in a loop, with a write in between each read, and the browser recomputes
 * layout on every iteration — twelve images become twelve full layout passes
 * per frame, no single function looks slow in a profile, and the page crawls.
 * (framebudget ships a detector for exactly this; that is where the rule came
 * from.) So `measure()` reads every rect in one pass and touches nothing else.
 *
 * The second job is not measuring at all when nothing has moved. Scroll and
 * resize set a dirty flag; frames where the flag is clear reuse the last
 * measurement. On a still page the per-frame layout cost is zero.
 */

/**
 * Anything with a DOM element and somewhere to put the numbers. Kept structural
 * rather than importing Layer, so the registry stays testable without a GPU.
 * @typedef {{
 *   el: HTMLElement, rect?: DOMRect|null, progress?: number,
 *   visible?: boolean, onScreen?: boolean, clip?: number[], aspect?: number
 * }} Tracked
 */

export class Registry {
  /** @param {{ window?: any }} [opts] */
  constructor(opts = {}) {
    this.win = opts.window ?? globalThis;
    /** @type {Set<any>} */
    this.items = new Set();
    this.dirty = true;
    /** @type {IntersectionObserver|null} */
    this._io = null;
    this._onScroll = () => { this.dirty = true; };

    if (typeof this.win.addEventListener === 'function') {
      // `passive` matters: without it the browser must wait for the handler
      // before it can scroll, and a scroll listener becomes a scroll stutter.
      this.win.addEventListener('scroll', this._onScroll, { passive: true });
      this.win.addEventListener('resize', this._onScroll, { passive: true });
    }

    /**
     * Off-screen elements are skipped entirely — no uniform write, no draw.
     * The margin keeps a screen of slack on each side so an element is already
     * being drawn by the time it scrolls into view, instead of popping in.
     */
    if (typeof this.win.IntersectionObserver === 'function') {
      this._io = new this.win.IntersectionObserver(
        /** @param {IntersectionObserverEntry[]} entries */
        (entries) => {
          for (const e of entries) {
            const item = [...this.items].find((i) => i.el === e.target);
            if (item) item.onScreen = e.isIntersecting;
          }
          this.dirty = true;
        },
        { rootMargin: '100% 0px' }
      );
    }
  }

  /** @param {any} item @returns {any} */
  add(item) {
    item.onScreen = true;
    this.items.add(item);
    this._io?.observe(item.el);
    this.dirty = true;
    return item;
  }

  /** @param {any} item */
  remove(item) {
    this._io?.unobserve(item.el);
    this.items.delete(item);
  }

  /**
   * One batched read of every rect. Called at most once per frame, and only
   * when something has actually moved.
   */
  measure() {
    if (!this.dirty) return;
    const vh = this.win.innerHeight || 0;
    const vw = this.win.innerWidth || 0;

    // Pass 1 — read. Nothing in this loop writes to the DOM.
    for (const item of this.items) {
      if (!item.onScreen) { item.visible = false; continue; }
      const r = item.el.getBoundingClientRect();
      item.rect = r;
      item.visible = r.bottom > 0 && r.top < vh && r.width > 0 && r.height > 0;

      /**
       * progress: 0 as the element's top edge touches the bottom of the
       * viewport, 1 as its bottom edge leaves the top. Independent of element
       * height, so a tall image and a small thumbnail animate over the same
       * span of scrolling rather than the tall one appearing to lag.
       */
      const span = vh + r.height;
      item.progress = span > 0 ? clamp01((vh - r.top) / span) : 0;

      // Clip space, computed here so the draw loop does no arithmetic on rects.
      item.clip = [
        (r.left / vw) * 2 - 1,
        1 - (r.top / vh) * 2,
        (r.width / vw) * 2,
        (r.height / vh) * 2,
      ];
      item.aspect = r.height > 0 ? r.width / r.height : 1;
    }

    this.dirty = false;
  }

  destroy() {
    if (typeof this.win.removeEventListener === 'function') {
      this.win.removeEventListener('scroll', this._onScroll);
      this.win.removeEventListener('resize', this._onScroll);
    }
    this._io?.disconnect();
    this.items.clear();
  }
}

/** @param {number} n */
const clamp01 = (n) => (n < 0 ? 0 : n > 1 ? 1 : n);
