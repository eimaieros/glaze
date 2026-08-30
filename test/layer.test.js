import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Layer } from '../src/layer.js';
import { EFFECTS } from '../src/effects.js';

/**
 * The ordering test.
 *
 * README, demo and source comments all make the same promise: the element is
 * hidden only after its texture is uploaded. Until this file existed, nothing
 * checked it — the DOM tests never reach `load()`, because without a GPU the
 * stage stops before it gets there.
 *
 * So the GPU is faked. Not to pretend the shaders work, but to record the
 * exact order the calls happen in, which is the part that has to be right.
 */

/** A device that writes down what it was asked to do, and when. */
function recordingDevice(log) {
  const stub = (name) => (...a) => { log.push(name); return a; };
  return {
    createTexture: () => (log.push('createTexture'), { createView: () => ({}), destroy() {} }),
    createBuffer: () => (log.push('createBuffer'), { destroy() {} }),
    createSampler: () => ({}),
    createBindGroup: () => (log.push('createBindGroup'), {}),
    queue: {
      copyExternalImageToTexture: stub('upload'),
      writeBuffer: stub('writeBuffer'),
      submit: stub('submit'),
    },
  };
}

function fakeStage(log) {
  return {
    device: recordingDevice(log),
    pipeline: () => (log.push('pipeline'), { getBindGroupLayout: () => ({}) }),
  };
}

/** An <img>-shaped object that records when its visibility changes. */
function fakeImg(log, src = 'photo.jpg') {
  const style = {
    _v: '',
    get visibility() { return this._v; },
    set visibility(v) { this._v = v; log.push(`hide:${v}`); },
  };
  return { src, currentSrc: '', style, decode: async () => log.push('decode') };
}

/**
 * `GPUTextureUsage` and `GPUBufferUsage` are plain constant bitfields the
 * browser puts on the global. Node has neither, so they are declared here from
 * the spec — these are the real values, not placeholders.
 * https://www.w3.org/TR/webgpu/#namespacedef-gputextureusage
 */
globalThis.GPUTextureUsage ??= {
  COPY_SRC: 0x01, COPY_DST: 0x02, TEXTURE_BINDING: 0x04,
  STORAGE_BINDING: 0x08, RENDER_ATTACHMENT: 0x10,
};
globalThis.GPUBufferUsage ??= {
  MAP_READ: 0x0001, MAP_WRITE: 0x0002, COPY_SRC: 0x0004, COPY_DST: 0x0008,
  INDEX: 0x0010, VERTEX: 0x0020, UNIFORM: 0x0040, STORAGE: 0x0080,
  INDIRECT: 0x0100, QUERY_RESOLVE: 0x0200,
};

const originalCIB = globalThis.createImageBitmap;
afterEach(() => {
  if (originalCIB) globalThis.createImageBitmap = originalCIB;
  else delete globalThis.createImageBitmap;
});

test('the texture is uploaded before the element is hidden', async () => {
  const log = [];
  globalThis.createImageBitmap = async () => {
    log.push('createImageBitmap');
    return { width: 800, height: 600, close() {} };
  };

  const el = fakeImg(log);
  const layer = new Layer(el, fakeStage(log), EFFECTS.displace, 'displace', {});
  assert.equal(await layer.load(), true);

  // This is the assertion the whole library is built around.
  assert.ok(log.indexOf('upload') < log.indexOf('hide:hidden'),
    `upload must precede the hide. Order was: ${log.join(' → ')}`);
  assert.deepEqual(log, [
    'decode', 'createImageBitmap', 'createTexture', 'upload',
    'createBuffer', 'pipeline', 'createBindGroup', 'hide:hidden',
  ]);
});

test('hidden with visibility, never with display', async () => {
  const log = [];
  globalThis.createImageBitmap = async () => ({ width: 4, height: 4, close() {} });
  const el = fakeImg(log);
  await new Layer(el, fakeStage(log), EFFECTS.rgb, 'rgb', {}).load();

  // display:none would collapse the layout the quad is positioned from.
  assert.equal(el.style.visibility, 'hidden');
  assert.equal(el.style.display, undefined, 'display must never be touched');
});

test('a decode failure leaves the element completely alone', async () => {
  const log = [];
  globalThis.createImageBitmap = async () => { throw new Error('broken image'); };

  const el = fakeImg(log);
  const layer = new Layer(el, fakeStage(log), EFFECTS.reveal, 'reveal', {});

  assert.equal(await layer.load(), false, 'a broken image resolves false, it does not throw');
  assert.equal(el.style.visibility, '', 'and the image stays on screen');
  assert.ok(!log.some((l) => l.startsWith('hide:')), `nothing hid it. Log: ${log.join(' → ')}`);
});

/**
 * The hang.
 *
 * In Chrome, `HTMLImageElement.decode()` never settles while the document is
 * hidden — it does not resolve and it does not reject. `load()` awaited it
 * directly, so a page opened in a background tab (a middle-click, a restored
 * session, "open all bookmarks in new tabs") sat on that await forever: no
 * Layer was created, `start()` was never called, and glaze did nothing for the
 * rest of the page's life. "I opened it and nothing happens", exactly.
 *
 * Verified on the live demo: `decode()` hung past 2.5 seconds while
 * `createImageBitmap()` resolved normally on the very same element.
 *
 * try/catch cannot help here. A promise that never settles is not an error.
 */
test('a decode() that never settles does not stall the whole library', async () => {
  const log = [];
  globalThis.createImageBitmap = async () => ({ width: 4, height: 4, close() {} });

  const el = fakeImg(log);
  el.decode = () => new Promise(() => {});      // exactly what a hidden tab does

  const layer = new Layer(el, fakeStage(log), EFFECTS.displace, 'displace', {});
  const resultado = await Promise.race([
    layer.load(),
    new Promise((r) => setTimeout(() => r('PENDUROU'), 3000)),
  ]);

  assert.equal(resultado, true,
    'load() must give up on the decode and carry on — createImageBitmap does not need it');
  assert.equal(el.style.visibility, 'hidden', 'and the layer must have taken over');
});

test('a decode() that rejects is also survivable', async () => {
  const log = [];
  globalThis.createImageBitmap = async () => ({ width: 4, height: 4, close() {} });
  const el = fakeImg(log);
  el.decode = () => Promise.reject(new Error('EncodingError'));
  const layer = new Layer(el, fakeStage(log), EFFECTS.displace, 'displace', {});
  assert.equal(await layer.load(), true);
});

test('an element with no decode() at all still loads', async () => {
  const log = [];
  globalThis.createImageBitmap = async () => ({ width: 4, height: 4, close() {} });
  const el = fakeImg(log);
  delete el.decode;
  const layer = new Layer(el, fakeStage(log), EFFECTS.rgb, 'rgb', {});
  assert.equal(await layer.load(), true);
});

test('an image with no src is skipped before any GPU work', async () => {
  const log = [];
  const el = fakeImg(log, '');
  el.currentSrc = '';
  const layer = new Layer(el, fakeStage(log), EFFECTS.displace, 'displace', {});
  assert.equal(await layer.load(), false);
  assert.deepEqual(log, [], 'not one call should have been made');
});

test('currentSrc wins over src, because that is what the browser is showing', async () => {
  const log = [];
  globalThis.createImageBitmap = async () => ({ width: 2, height: 2, close() {} });
  // With a srcset the browser may have chosen a different file than `src`.
  // Uploading `src` would texture the wrong resolution.
  const el = fakeImg(log, 'small.jpg');
  el.currentSrc = 'large-2x.jpg';
  assert.equal(await new Layer(el, fakeStage(log), EFFECTS.rgb, 'rgb', {}).load(), true);
});

test('destroy() restores the exact visibility it found', async () => {
  const log = [];
  globalThis.createImageBitmap = async () => ({ width: 2, height: 2, close() {} });

  const el = fakeImg(log);
  el.style.visibility = 'visible';   // an author-set value, not the default
  log.length = 0;

  const layer = new Layer(el, fakeStage(log), EFFECTS.displace, 'displace', {});
  await layer.load();
  assert.equal(el.style.visibility, 'hidden');

  layer.destroy();
  assert.equal(el.style.visibility, 'visible',
    'restoring to "" instead of the previous value would silently change the page');
});

test('destroy() on a layer that never loaded does not touch the element', () => {
  const log = [];
  const el = fakeImg(log);
  new Layer(el, fakeStage(log), EFFECTS.displace, 'displace', {}).destroy();
  assert.deepEqual(log, []);
});

test('caller options override the effect defaults', async () => {
  const log = [];
  globalThis.createImageBitmap = async () => ({ width: 2, height: 2, close() {} });
  const layer = new Layer(fakeImg(log), fakeStage(log), EFFECTS.displace, 'displace',
    { strength: 0.9 });
  assert.equal(layer.opts.strength, 0.9);
  assert.equal(layer.opts.scale, EFFECTS.displace.defaults.scale, 'and the rest survive');
});

test('update() packs the uniforms in the order the shader reads them', async () => {
  const log = [];
  globalThis.createImageBitmap = async () => ({ width: 2, height: 2, close() {} });
  const layer = new Layer(fakeImg(log), fakeStage(log), EFFECTS.displace, 'displace',
    { strength: 0.25 });
  await layer.load();

  layer.clip = [-1, 1, 2, 2];
  layer.progress = 0.4;
  layer.aspect = 1.5;
  layer.update(12.5, -0.75, { x: 0.2, y: 0.8, near: 0.6 });

  // rect | progress, strength, seconds, velocity | aspect, pointerX, pointerY, near
  //      | scale (displace's only extra), then three unused slots
  // Rounded because the buffer is a Float32Array: 0.4 stores as 0.40000000596.
  const expected = [-1, 1, 2, 2, 0.4, 0.25, 12.5, -0.75, 1.5, 0.2, 0.8, 0.6,
                    EFFECTS.displace.defaults.scale, 0, 0, 0];
  assert.deepEqual([...layer.uniforms].map((n) => +n.toFixed(5)), expected);
});

test('adaptive quality reduces every effect strength, not only velocity', async () => {
  const log = [];
  globalThis.createImageBitmap = async () => ({ width: 2, height: 2, close() {} });
  const layer = new Layer(fakeImg(log), fakeStage(log), EFFECTS.reveal, 'reveal',
    { strength: 0.8 });
  await layer.load();

  // reveal is position-driven and ignores velocity. Scaling only velocity,
  // as the shared loop used to do, left this effect at full cost and strength.
  layer.update(1, 0.75, { x: 0, y: 0, near: 0 }, 0.45);
  assert.equal(+layer.uniforms[5].toFixed(5), 0.36);
  assert.equal(layer.uniforms[7], 0.75, 'velocity keeps its physical meaning');
});

test('a caller-supplied extra reaches the uniform buffer', () => {
  const log = [];
  globalThis.createImageBitmap = async () => ({ width: 2, height: 2, close() {} });
  const layer = new Layer(fakeImg(log), fakeStage(log), EFFECTS.displace, 'displace',
    { scale: 14 });
  layer.update(0, 0, { x: 0, y: 0, near: 0 });   // no load needed: nothing to write to yet
  layer.ready = true; layer.uniformBuffer = {};  // let update() run its packing
  layer.update(0, 0, { x: 0, y: 0, near: 0 });
  assert.equal(layer.uniforms[12], 14,
    'passing { scale: 14 } must land in u.opts.x — it used to be silently dropped');
});

test('update() before load() writes nothing', () => {
  const log = [];
  const layer = new Layer(fakeImg(log), fakeStage(log), EFFECTS.rgb, 'rgb', {});
  layer.update(1, 1, { x: 0, y: 0, near: 0 });
  assert.ok(!log.includes('writeBuffer'));
});

test('draw() before load() issues no commands', () => {
  const log = [];
  const layer = new Layer(fakeImg(log), fakeStage(log), EFFECTS.rgb, 'rgb', {});
  const pass = { setPipeline: () => log.push('setPipeline'), setBindGroup() {}, draw() {} };
  layer.draw(pass);
  assert.deepEqual(log, []);
});
