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
 * The second job is not measuring at all when nothing has moved. Scroll, window
 * resize and ResizeObserver set a dirty flag; frames where the flag is clear
 * reuse the last measurement. On a still page the per-frame layout cost is zero.
 *
 * Those three cover different things and all three are needed. Scroll and window
 * resize are about the viewport moving under the element. ResizeObserver is
 * about the element's own box changing while the viewport sits still — a font
 * loading, an accordion opening, a grid reflowing. Miss that third one and the
 * quad silently drifts off the image it is standing in for.
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
    /** @type {ResizeObserver|null} */
    this._ro = null;
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

    /**
     * THE CASE SCROLL AND RESIZE DO NOT COVER.
     *
     * The dirty flag was set by exactly two events, and both are about the
     * viewport. But an element's rect can change while the viewport sits
     * perfectly still:
     *
     *   - a webfont finishes loading and the paragraph above the image reflows
     *   - a `<details>` opens, an accordion expands, a filter removes a card
     *   - a CSS grid reflows because a sibling's content changed
     *   - the image itself gets its intrinsic size once it decodes, and a
     *     container with `height: auto` grows underneath it
     *
     * In every one of those the quad stays where it last measured and the real
     * element moves out from under it. There is no error, no warning, and
     * nothing in a test catches it — the effect is simply drawn in the wrong
     * place, and it stays wrong until the next scroll. The font case is the
     * nastiest, because it happens once, early, on exactly the first load a
     * visitor sees and never again on a warm cache.
     *
     * `ResizeObserver` fires for the element's own box changing. It does not
     * fire for an element merely *moving*, which is why the scroll listener
     * stays: between them they cover size and position.
     */
    if (typeof this.win.ResizeObserver === 'function') {
      this._ro = new this.win.ResizeObserver(() => { this.dirty = true; });
    }
  }

  /** @param {any} item @returns {any} */
  add(item) {
    item.onScreen = true;
    this.items.add(item);
    this._io?.observe(item.el);
    this._ro?.observe(item.el);
    this.dirty = true;
    return item;
  }

  /** @param {any} item */
  remove(item) {
    this._io?.unobserve(item.el);
    this._ro?.unobserve(item.el);
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

    // During prerendering and some embedded-webview transitions the viewport
    // can briefly be 0×0. Dividing by it produces Infinity in the uniform
    // buffer; skip both layout reads and drawing until resize marks us dirty.
    if (vw <= 0 || vh <= 0) {
      for (const item of this.items) item.visible = false;
      this.dirty = false;
      return;
    }

    // Pass 1 — read. Nothing in this loop writes to the DOM.
    for (const item of this.items) {
      if (!item.onScreen) { item.visible = false; continue; }

      /**
       * An element detached from the document still answers
       * getBoundingClientRect() — with zeroes. Left alone that becomes a
       * degenerate quad drawn at the top-left corner of the screen, which
       * looks like a rendering bug and is actually a lifecycle one. Common in
       * any framework that replaces DOM on navigation.
       */
      if (item.el.isConnected === false) { item.visible = false; continue; }

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
    this._ro?.disconnect();
    this.items.clear();
  }
}

/** @param {number} n */
const clamp01 = (n) => (n < 0 ? 0 : n > 1 ? 1 : n);
