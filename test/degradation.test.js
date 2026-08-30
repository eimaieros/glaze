import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { glaze, destroyAll } from '../src/index.js';
import { Stage } from '../src/stage.js';

/**
 * Everything here is about the same promise: when glaze cannot run, the page
 * is left exactly as it was. These run in Node, with no GPU and no DOM, which
 * is the harshest version of that environment.
 */

afterEach(() => { destroyAll(); delete globalThis.matchMedia; });

test('no matching elements: returns an inert handle instead of throwing', () => {
  globalThis.matchMedia = () => ({ matches: false });
  const g = glaze([]);
  assert.equal(g.active, false);
  assert.deepEqual(g.elements, []);
  assert.doesNotThrow(() => g.destroy(), 'destroy must be safe on the inert path');
});

test('a bad effect name throws even when there is nothing to draw', () => {
  globalThis.matchMedia = () => ({ matches: false });
  // The typo is a programming error and should surface on every machine, not
  // only on the ones that happen to have WebGPU.
  assert.throws(() => glaze([{}], { effect: 'nope' }), RangeError);
});

test('prefers-reduced-motion: does nothing at all', () => {
  globalThis.matchMedia = (q) => ({ matches: /prefers-reduced-motion/.test(q) });
  const el = { style: { visibility: '' } };
  const g = glaze([el], { effect: 'displace' });
  assert.equal(g.active, false);
  assert.equal(el.style.visibility, '', 'the element must not be touched');
});

test('a matchMedia implementation that throws degrades safely', () => {
  globalThis.matchMedia = () => { throw new Error('webview not ready'); };
  const el = { style: { visibility: '' } };
  assert.doesNotThrow(() => glaze([el], { effect: 'displace' }));
  assert.equal(el.style.visibility, '');
});

test('numeric effect options are validated synchronously', () => {
  const el = { style: { visibility: '' } };
  assert.throws(() => glaze([el], { strength: Number.NaN }), RangeError);
  assert.throws(() => glaze([el], { strength: 1.1 }), RangeError);
  assert.throws(() => glaze([el], { effect: 'displace', scale: Infinity }), RangeError);
});

test('respectReducedMotion: false is honoured', () => {
  globalThis.matchMedia = () => ({ matches: true });
  // It still will not start without a GPU, but it must get past the motion
  // gate — otherwise the option is decorative.
  const g = glaze([{ style: {} }], { effect: 'rgb', respectReducedMotion: false });
  assert.deepEqual(g.elements, []);
});

test('Stage.init resolves false without WebGPU rather than throwing', async () => {
  const s = new Stage({ document: null });
  const ok = await s.init();
  assert.equal(ok, false);
  assert.equal(s.ready, false);
  assert.equal(s.failed, 'no-webgpu', 'the reason is recorded, not swallowed');
});

test('Stage.init is idempotent once it has failed', async () => {
  const s = new Stage({ document: null });
  assert.equal(await s.init(), false);
  assert.equal(await s.init(), false, 'a second call must not retry or throw');
});

test('Stage caps the pixel ratio', () => {
  const s = new Stage();
  assert.equal(s.maxPixelRatio, 2);
  // 3× phone screens mean 9× the fragments for a difference nobody can see,
  // and these shaders are fragment-bound.
  const custom = new Stage({ maxPixelRatio: 1 });
  assert.equal(custom.maxPixelRatio, 1);
  assert.throws(() => new Stage({ maxPixelRatio: 0 }), RangeError);
  assert.throws(() => new Stage({ maxPixelRatio: Infinity }), RangeError);
});

test('Stage.resize and destroy are safe before init', () => {
  const s = new Stage({ document: null });
  assert.doesNotThrow(() => s.resize());
  assert.doesNotThrow(() => s.destroy());
});

test('render() is a no-op before the stage is ready', () => {
  const s = new Stage({ document: null });
  assert.doesNotThrow(() => s.render([{ visible: true, draw() { throw new Error('drew!'); } }]));
});

test('destroyAll is safe when glaze never started', () => {
  assert.doesNotThrow(() => destroyAll());
  assert.doesNotThrow(() => destroyAll());
});
