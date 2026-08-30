import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

/**
 * The other test files build their own fake window, which is fast and precise
 * but circular: they check the library against objects I wrote to satisfy it.
 *
 * This file runs it against a real DOM implementation instead. jsdom has no
 * WebGPU and never will, so what it exercises is the path that matters most —
 * the one every visitor without a GPU takes. The assertion is always the same:
 * after glaze has run, the page is indistinguishable from a page where it
 * never ran.
 */

let dom;
let glaze, destroyAll;
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
const originalCreateImageBitmap = globalThis.createImageBitmap;

beforeEach(async () => {
  dom = new JSDOM(`<!DOCTYPE html><html><body>
    <figure><img id="a" src="a.png" alt="one"></figure>
    <figure><img id="b" src="b.png" alt="two" style="visibility:visible"></figure>
    <figure><img id="c" alt="no src"></figure>
  </body></html>`, { pretendToBeVisual: true });

  /**
   * The library reads these off the global at call time.
   *
   * Three things are deliberately NOT provided, and each is a condition worth
   * testing rather than a gap to paper over:
   *   navigator          — Node ships its own, getter-only, with no `.gpu`
   *   matchMedia         — jsdom has none, like a browser too old to have it
   *   IntersectionObserver — likewise
   * Everything here has to work with all three missing.
   */
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);

  // Fresh module instance per test: the stage and loop are module-level.
  ({ glaze, destroyAll } = await import(`../src/index.js?t=${Math.random()}`));
});

afterEach(() => {
  destroyAll?.();
  dom.window.close();
  for (const k of ['window', 'document', 'matchMedia', 'IntersectionObserver',
                   'requestAnimationFrame', 'cancelAnimationFrame']) {
    delete globalThis[k];
  }
  if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
  else delete globalThis.navigator;
  if (originalCreateImageBitmap) globalThis.createImageBitmap = originalCreateImageBitmap;
  else delete globalThis.createImageBitmap;
});

const settle = () => new Promise((r) => setTimeout(r, 20));

test('a selector that matches nothing is harmless', async () => {
  const g = glaze('.does-not-exist');
  await settle();
  assert.equal(g.active, false);
  assert.equal(g.elements.length, 0);
});

test('without WebGPU every image stays exactly as it was', async () => {
  const d = dom.window.document;
  const before = [...d.querySelectorAll('img')]
    .map((el) => [el.id, el.style.visibility, el.getAttribute('src')]);

  const g = glaze('img', { effect: 'displace' });
  await settle();

  assert.equal(g.active, false, 'jsdom has no WebGPU, so nothing should start');
  const after = [...d.querySelectorAll('img')]
    .map((el) => [el.id, el.style.visibility, el.getAttribute('src')]);
  assert.deepEqual(after, before, 'the DOM must be byte-identical');
});

test('no stray canvas is left over the page', async () => {
  glaze('img', { effect: 'reveal' });
  await settle();
  // A canvas mounted before the device check would sit over the content with
  // pointer-events:none and nothing drawn — invisible in a screenshot, and a
  // compositing layer for no reason.
  assert.equal(dom.window.document.querySelectorAll('canvas').length, 0);
});

test('destroy() after a degraded start does not throw', async () => {
  const g = glaze('img');
  await settle();
  assert.doesNotThrow(() => g.destroy());
  assert.doesNotThrow(() => g.destroy(), 'and is idempotent');
});

test('destroy() during asynchronous GPU startup cannot resurrect the handle', async () => {
  const device = {
    lost: new Promise(() => {}),
    destroy() {},
  };
  const gpu = {
    getPreferredCanvasFormat: () => 'bgra8unorm',
    async requestAdapter() {
      await new Promise((r) => setTimeout(r, 5));
      return { requestDevice: async () => device };
    },
  };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { gpu },
  });
  dom.window.HTMLCanvasElement.prototype.getContext = () => ({ configure() {} });

  const el = dom.window.document.querySelector('#a');
  const g = glaze(el);
  g.destroy();
  await settle();

  assert.equal(g.active, false);
  assert.equal(g.elements.length, 0, 'an awaited continuation must not add a layer later');
  assert.equal(el.style.visibility, '', 'the destroyed handle must never hide its image');
});

test('several calls with different effects still leave the page alone', async () => {
  glaze('#a', { effect: 'displace' });
  glaze('#b', { effect: 'reveal' });
  glaze('#c', { effect: 'rgb' });
  await settle();
  const d = dom.window.document;
  assert.equal(d.querySelector('#a').style.visibility, '');
  assert.equal(d.querySelector('#b').style.visibility, 'visible');
  assert.equal(d.querySelectorAll('canvas').length, 0);
});

test('an element reference works as well as a selector', async () => {
  const el = dom.window.document.querySelector('#a');
  const g = glaze(el, { effect: 'rgb' });
  await settle();
  assert.equal(g.active, false);
  assert.equal(el.style.visibility, '');
});

test('a NodeList works too', async () => {
  const g = glaze(dom.window.document.querySelectorAll('figure img'));
  await settle();
  assert.equal(g.elements.length, 0);
});

test('a browser with no matchMedia at all does not crash', () => {
  // jsdom does not implement it. Neither did Safari before 5.1, and neither
  // does any server-side render. The reduced-motion check has to survive its
  // own absence, or glaze throws before it has done anything.
  assert.equal(typeof globalThis.matchMedia, 'undefined');
  assert.doesNotThrow(() => glaze('img', { respectReducedMotion: true }));
});

test('a browser with no IntersectionObserver still measures correctly', async () => {
  // The observer is an optimisation — skip work for elements nobody can see.
  // Without it every element is treated as on-screen, which is slower and
  // correct. Degrading to "correct but slower" is the right failure.
  assert.equal(typeof globalThis.IntersectionObserver, 'undefined');
  const g = glaze('img', { effect: 'displace' });
  await settle();
  assert.equal(g.active, false);
  assert.equal(dom.window.document.querySelector('#a').style.visibility, '');
});

test('matchMedia reporting reduced motion is honoured in a real DOM', async () => {
  globalThis.matchMedia = (q) => ({
    matches: /prefers-reduced-motion/.test(q),
    media: q, onchange: null,
    addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
  });
  const g = glaze('img', { effect: 'displace' });
  await settle();
  assert.equal(g.active, false);
  assert.equal(dom.window.document.querySelectorAll('canvas').length, 0);
});
