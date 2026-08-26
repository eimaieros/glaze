import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { Stage } from '../src/stage.js';

/**
 * The initialisation race.
 *
 * `glaze()` is meant to be called several times on one page — that is the
 * documented way to give different elements different effects — and every call
 * awaits `stage.init()`. `init()` used to have no re-entrancy guard: the
 * `ready` flag it checks on entry is only set at the very end, after three
 * awaits, so concurrent callers all sailed past it and each built its own
 * adapter, device and canvas.
 *
 * The result was total and silent. The last device to finish won
 * `stage.device`, while the Layers had already built their textures and bind
 * groups on an earlier one. Cross-device resources are a WebGPU validation
 * error, validation errors arrive asynchronously, and so `render()` returned
 * normally with nothing thrown, nothing logged, and nothing drawn. The demo
 * reported three effects running over a completely empty canvas.
 *
 * Fifty-nine tests passed throughout. Not one of them called `init()` twice.
 */

/** A GPU that counts how many times it was asked for hardware. */
function gpuDeMentira() {
  const contas = { adapters: 0, devices: 0 };
  const device = {
    lost: new Promise(() => {}),          // never resolves
    createTexture: () => ({ createView: () => ({}), destroy() {} }),
    createBuffer: () => ({ destroy() {} }),
    createSampler: () => ({}),
    createBindGroup: () => ({}),
    createShaderModule: () => ({}),
    createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }),
    createCommandEncoder: () => ({
      beginRenderPass: () => ({ setPipeline() {}, setBindGroup() {}, draw() {}, end() {} }),
      finish: () => ({}),
    }),
    queue: { copyExternalImageToTexture() {}, writeBuffer() {}, submit() {} },
    destroy() {},
  };
  return {
    contas,
    gpu: {
      getPreferredCanvasFormat: () => 'bgra8unorm',
      async requestAdapter() {
        contas.adapters++;
        // A real adapter request takes a turn or two of the event loop. Without
        // the delay the race this file exists for cannot happen.
        await new Promise((r) => setTimeout(r, 5));
        return {
          async requestDevice() {
            contas.devices++;
            await new Promise((r) => setTimeout(r, 5));
            return device;
          },
        };
      },
    },
  };
}

function palco() {
  const dom = new JSDOM('<!DOCTYPE html><body></body>', { pretendToBeVisual: true });
  const { gpu, contas } = gpuDeMentira();
  // jsdom cannot give a real webgpu context; a stub is enough to get past it.
  dom.window.HTMLCanvasElement.prototype.getContext = function () {
    return { configure() {}, getCurrentTexture: () => ({ createView: () => ({}) }) };
  };
  const stage = new Stage({ document: dom.window.document, navigator: { gpu } });
  return { stage, contas, doc: dom.window.document, dom };
}

test('three concurrent init() calls produce ONE device and ONE canvas', async () => {
  const { stage, contas, doc } = palco();

  // Exactly what the demo does: glaze() three times, each awaiting init().
  const r = await Promise.all([stage.init(), stage.init(), stage.init()]);

  assert.deepEqual(r, [true, true, true], 'every caller must still get true');
  assert.equal(contas.adapters, 1, `requested ${contas.adapters} adapters, must be 1`);
  assert.equal(contas.devices, 1, `created ${contas.devices} devices, must be 1`);
  assert.equal(doc.querySelectorAll('canvas').length, 1,
    'one canvas over the viewport is the whole architecture — see the README');
});

test('the layers all end up on the same device the stage renders with', async () => {
  const { stage } = palco();
  const durante = stage.init();                 // still in flight
  const tarde = stage.init();                   // a second glaze() call
  await Promise.all([durante, tarde]);

  // This is the property that actually broke: a Layer built while init was
  // running must share the device render() will use.
  assert.ok(stage.device, 'a device exists');
  const depois = await stage.init();
  assert.equal(depois, true);
  assert.equal(stage.ready, true);
});

test('ten callers are still one device', async () => {
  const { stage, contas, doc } = palco();
  await Promise.all(Array.from({ length: 10 }, () => stage.init()));
  assert.equal(contas.devices, 1);
  assert.equal(doc.querySelectorAll('canvas').length, 1);
});

test('a call after init resolved is free and reuses everything', async () => {
  const { stage, contas } = palco();
  await stage.init();
  const canvas = stage.canvas;
  await stage.init();
  assert.equal(contas.devices, 1);
  assert.equal(stage.canvas, canvas, 'the second call must not swap the canvas');
});

test('destroy() clears the memoised promise so a stage is not resurrected', async () => {
  const { stage, doc } = palco();
  await stage.init();
  stage.destroy();
  assert.equal(stage.ready, false);
  assert.equal(doc.querySelectorAll('canvas').length, 0, 'destroy removes its canvas');
  // A stale resolved promise here would report ready with a destroyed device.
  const outra = await stage.init();
  assert.equal(outra, true);
  assert.equal(doc.querySelectorAll('canvas').length, 1);
});

test('concurrent callers all see the same failure when there is no GPU', async () => {
  const dom = new JSDOM('<!DOCTYPE html><body></body>');
  const stage = new Stage({ document: dom.window.document, navigator: {} });
  const r = await Promise.all([stage.init(), stage.init(), stage.init()]);
  assert.deepEqual(r, [false, false, false]);
  assert.equal(stage.failed, 'no-webgpu');
  assert.equal(dom.window.document.querySelectorAll('canvas').length, 0,
    'a failed start must not leave a canvas over the content');
});

test('a failed adapter request does not leave a canvas behind either', async () => {
  const dom = new JSDOM('<!DOCTYPE html><body></body>');
  const stage = new Stage({
    document: dom.window.document,
    navigator: { gpu: { getPreferredCanvasFormat: () => 'bgra8unorm',
                        requestAdapter: async () => null } },
  });
  assert.equal(await stage.init(), false);
  assert.equal(stage.failed, 'no-adapter');
  assert.equal(dom.window.document.querySelectorAll('canvas').length, 0);
});
