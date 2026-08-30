import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Layer } from '../src/layer.js';
import { EFFECTS } from '../src/effects.js';

/**
 * The promise that was not true.
 *
 * A WebGPU canvas holds its content for exactly one frame: the swap-chain
 * texture is presented and released, so a canvas nobody redraws goes blank.
 * That is fine while the loop runs and ruinous the moment it stops — and it
 * stops for completely ordinary reasons:
 *
 *   - framebudget reports `minimal`, and the loop deliberately draws nothing
 *   - the tab goes to the background, and Chrome suspends rAF outright
 *   - the GPU device is lost
 *
 * In every one of those the canvas emptied while the elements were still
 * `visibility: hidden`, so the page was left with holes where its images had
 * been. On a struggling device — the exact case framebudget exists to handle —
 * glaze deleted the content it promises never to touch.
 *
 * Measured on the live page: 5899 painted samples immediately after render,
 * 0 painted samples fifty milliseconds later.
 *
 * The rule these tests hold down: whenever glaze stops producing frames, the
 * real elements go back on screen first.
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

const palcoFalso = () => ({
  device: {
    createTexture: () => ({ createView: () => ({}), destroy() {} }),
    createBuffer: () => ({ destroy() {} }),
    createSampler: () => ({}),
    createBindGroup: () => ({}),
    queue: { copyExternalImageToTexture() {}, writeBuffer() {} },
  },
  pipeline: () => ({ getBindGroupLayout: () => ({}) }),
});

function imgFalsa(visibilidadeInicial = '') {
  return {
    src: 'foto.jpg', currentSrc: '',
    style: { visibility: visibilidadeInicial },
    decode: async () => {},
  };
}

async function camadaCarregada(visibilidadeInicial = '') {
  globalThis.createImageBitmap = async () => ({ width: 8, height: 8, close() {} });
  const el = imgFalsa(visibilidadeInicial);
  const L = new Layer(el, palcoFalso(), EFFECTS.displace, 'displace', {});
  assert.equal(await L.load(), true);
  return { L, el };
}

test('a loaded layer has taken the element over', async () => {
  const { L, el } = await camadaCarregada();
  assert.equal(el.style.visibility, 'hidden');
  assert.equal(L.domVisivel, false);
});

test('mostrarDom() puts the image back on screen', async () => {
  const { L, el } = await camadaCarregada();
  L.mostrarDom();
  assert.equal(el.style.visibility, '', 'the page must show its own image again');
  assert.equal(L.domVisivel, true);
});

test('and it restores the value the page had, not a blank', async () => {
  const { L, el } = await camadaCarregada('visible');
  L.mostrarDom();
  assert.equal(el.style.visibility, 'visible',
    'an author-set visibility must survive a suspend/resume cycle');
});

test('esconderDom() takes it back once frames resume', async () => {
  const { L, el } = await camadaCarregada();
  L.mostrarDom();
  L.esconderDom();
  assert.equal(el.style.visibility, 'hidden');
  assert.equal(L.domVisivel, false);
});

test('a full suspend/resume cycle leaves no trace', async () => {
  const { L, el } = await camadaCarregada('inherit');
  for (let i = 0; i < 5; i++) { L.mostrarDom(); L.esconderDom(); }
  L.mostrarDom();
  assert.equal(el.style.visibility, 'inherit');
});

test('both are idempotent — a repeated suspend must not lose the original', async () => {
  const { L, el } = await camadaCarregada('visible');
  L.mostrarDom(); L.mostrarDom(); L.mostrarDom();
  assert.equal(el.style.visibility, 'visible');
  L.esconderDom(); L.esconderDom();
  assert.equal(el.style.visibility, 'hidden');
});

test('destroy() while suspended does not re-hide the element', async () => {
  const { L, el } = await camadaCarregada('visible');
  L.mostrarDom();
  L.destroy();
  assert.equal(el.style.visibility, 'visible',
    'tearing down a suspended layer must leave the image showing');
});

test('destroy() while active still restores the element', async () => {
  const { L, el } = await camadaCarregada('visible');
  L.destroy();
  assert.equal(el.style.visibility, 'visible');
});

test('neither touches an element that never loaded', () => {
  const el = imgFalsa('visible');
  const L = new Layer(el, palcoFalso(), EFFECTS.rgb, 'rgb', {});
  L.mostrarDom(); L.esconderDom();
  assert.equal(el.style.visibility, 'visible');
});

/**
 * The wiring, read out of the source. These branches only run inside the rAF
 * closure, where there is no DOM-free way to reach them — but their absence is
 * exactly the bug, so their presence is worth asserting directly.
 */
test('every path that stops drawing hands the DOM back first', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');

  assert.match(src, /tier === 'minimal'\s*\)\s*\{\s*suspender\(s\)/,
    'framebudget minimal must suspend, not just render nothing');
  assert.doesNotMatch(src, /tier === 'minimal'[^\n]*stage\.render\(\[\]\); return/,
    'the old render-nothing branch is back — it deletes the images');
  assert.match(src, /visibilitychange/,
    'a hidden tab suspends rAF; the DOM has to come back');
  assert.match(src, /stage\.onLost = \(\) => \{ suspender\(s\); stop\(s\); \}/,
    'a lost device restores the images and stops the now-useless loop');
  assert.match(src, /if \(!s\.stage\.ready\) \{ suspender\(s\); return; \}/,
    'the next scheduled frame must not resume after a lost device');

  // Order matters: show the elements, then clear the canvas. The other way
  // round leaves one frame with neither.
  const corpo = src.match(/function suspender\(s\)[\s\S]*?\n}/)[0];
  assert.ok(corpo.indexOf('mostrarDom') < corpo.indexOf('stage.render'),
    'suspender() must restore the DOM before clearing the canvas');
});
