import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Registry } from '../src/registry.js';

/** A window with no scroll events and no IntersectionObserver — the worst case. */
function fakeWindow(w = 1000, h = 800) {
  return {
    innerWidth: w,
    innerHeight: h,
    addEventListener() {},
    removeEventListener() {},
  };
}

function item(rect) {
  return { el: { getBoundingClientRect: () => rect } };
}

const R = (left, top, width, height) => ({
  left, top, width, height, right: left + width, bottom: top + height,
});

test('clip space: an element filling the viewport maps to the full quad', () => {
  const r = new Registry({ window: fakeWindow(1000, 800) });
  const i = r.add(item(R(0, 0, 1000, 800)));
  r.measure();
  // Top-left is (-1, +1) and the quad spans the whole 2×2 clip cube.
  assert.deepEqual(i.clip.map((n) => +n.toFixed(4)), [-1, 1, 2, 2]);
});

test('clip space: a centred half-size element', () => {
  const r = new Registry({ window: fakeWindow(1000, 800) });
  const i = r.add(item(R(250, 200, 500, 400)));
  r.measure();
  assert.deepEqual(i.clip.map((n) => +n.toFixed(4)), [-0.5, 0.5, 1, 1]);
});

test('progress is 0 as the top edge touches the bottom of the viewport', () => {
  const r = new Registry({ window: fakeWindow(1000, 800) });
  const i = r.add(item(R(0, 800, 1000, 400)));
  r.measure();
  assert.equal(i.progress, 0);
});

test('progress is 1 once the bottom edge has left the top', () => {
  const r = new Registry({ window: fakeWindow(1000, 800) });
  const i = r.add(item(R(0, -400, 1000, 400)));
  r.measure();
  assert.equal(i.progress, 1);
});

test('progress is height-independent: a tall and a short element agree', () => {
  const r = new Registry({ window: fakeWindow(1000, 800) });
  // Both exactly halfway through their travel.
  const tall = r.add(item(R(0, (800 - 2000) / 2, 1000, 2000)));
  const short = r.add(item(R(0, (800 - 100) / 2, 1000, 100)));
  r.measure();
  assert.equal(+tall.progress.toFixed(4), 0.5);
  assert.equal(+short.progress.toFixed(4), 0.5);
});

test('offscreen elements are marked invisible and are not drawn', () => {
  const r = new Registry({ window: fakeWindow(1000, 800) });
  const above = r.add(item(R(0, -900, 1000, 400)));
  const below = r.add(item(R(0, 1600, 1000, 400)));
  r.measure();
  assert.equal(above.visible, false);
  assert.equal(below.visible, false);
});

test('a zero-size element is never visible', () => {
  const r = new Registry({ window: fakeWindow() });
  const i = r.add(item(R(0, 0, 0, 0)));
  r.measure();
  assert.equal(i.visible, false);
});

test('measure() reads nothing when the page has not moved', () => {
  const r = new Registry({ window: fakeWindow() });
  let reads = 0;
  r.add({ el: { getBoundingClientRect() { reads++; return R(0, 0, 10, 10); } } });

  r.measure();
  assert.equal(reads, 1, 'first measure reads');
  r.measure();
  r.measure();
  assert.equal(reads, 1, 'a still page costs zero layout reads');

  r.dirty = true;
  r.measure();
  assert.equal(reads, 2, 'scrolling makes it read again');
});

test('remove() takes the element out of the set', () => {
  const r = new Registry({ window: fakeWindow() });
  const i = r.add(item(R(0, 0, 10, 10)));
  assert.equal(r.items.size, 1);
  r.remove(i);
  assert.equal(r.items.size, 0);
});

// ── the element moves without the viewport moving ────────────────────────────

test('a ResizeObserver is wired up when the browser has one', () => {
  /**
   * Scroll and window-resize are both about the viewport. An element's rect can
   * change while the viewport sits perfectly still: a webfont lands and the
   * paragraph above reflows, a <details> opens, a grid reflows because a sibling
   * changed. Without this the quad stays where it last measured and the real
   * element moves out from under it — no error, no warning, wrong pixels until
   * the next scroll.
   */
  let observados = 0;
  /** @type {Function|null} */
  let disparar = null;
  class FakeRO {
    constructor(fn) { disparar = fn; }
    observe() { observados++; }
    unobserve() { observados--; }
    disconnect() { observados = 0; }
  }

  const win = { ...fakeWindow(), ResizeObserver: FakeRO };
  const r = new Registry({ window: win });
  const i = r.add(item(R(0, 0, 100, 100)));
  assert.equal(observados, 1, 'the element goes into the observer');

  r.measure();
  assert.equal(r.dirty, false, 'measured, so clean');

  disparar([{ target: i.el }]);
  assert.equal(r.dirty, true, 'a size change makes it dirty again');

  r.remove(i);
  assert.equal(observados, 0);
});

test('a browser without ResizeObserver still works', () => {
  // Safari shipped it late enough that a fallback is not hypothetical.
  const r = new Registry({ window: fakeWindow() });
  const i = r.add(item(R(0, 0, 100, 100)));
  r.measure();
  assert.equal(i.visible, true);
  r.destroy();
});

test('an element removed from the document is not drawn', () => {
  /**
   * A detached element still answers getBoundingClientRect() — with zeroes.
   * Left alone that is a degenerate quad at the top-left corner, which looks
   * like a rendering bug and is really a lifecycle one. Any framework that
   * swaps DOM on navigation produces this.
   */
  const r = new Registry({ window: fakeWindow() });
  const i = r.add(item(R(10, 10, 100, 100)));
  i.el.isConnected = true;
  r.measure();
  assert.equal(i.visible, true);

  i.el.isConnected = false;
  r.dirty = true;
  r.measure();
  assert.equal(i.visible, false, 'out of the document, out of the frame');
});
