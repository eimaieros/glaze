/**
 * The stage: one canvas, one device, one render pass, all the effects.
 *
 * WHY ONE CANVAS AND NOT ONE PER ELEMENT.
 * The obvious design is a canvas per image — it is what almost every WebGL
 * effect tutorial does, and it falls over on a real page. Each canvas is a
 * separate GPU context with its own swap chain, its own command submissions
 * and its own compositing layer. Browsers cap how many live contexts a page
 * may hold (the limit is not specified and is around a dozen in practice), and
 * long before you hit the cap the compositor is doing more work than the
 * effects are worth.
 *
 * So: one canvas fixed over the viewport, one device, and every registered
 * element drawn as a quad positioned at that element's screen rect. Adding the
 * twentieth image costs one more draw call, not one more GPU context.
 *
 * The cost of this choice is that the stage has to track scroll and resize and
 * keep every quad aligned to a DOM rect it does not own. That bookkeeping is
 * `registry.js`, and it is the real work of this library.
 */

/**
 * The prelude every effect is compiled with: the uniform block, the texture
 * bindings, and the vertex stage. An effect file contributes only `fn fs`.
 *
 * Keeping the layout here rather than in each effect means a new effect is one
 * function and cannot get the bindings wrong.
 */
const VERTEX = /* wgsl */ `
struct Uniforms {
  // x, y, w, h of the element's rect, already in clip space.
  rect   : vec4f,
  // x: scroll progress 0..1  y: strength 0..1  z: seconds  w: scroll velocity
  params : vec4f,
  // x: aspect ratio  y,z: pointer in element space  w: pointer proximity 0..1
  extra  : vec4f,
};
@group(0) @binding(0) var<uniform> u    : Uniforms;
@group(0) @binding(1) var           samp : sampler;
@group(0) @binding(2) var           tex  : texture_2d<f32>;

/* Value noise. Cheap, and good enough for displacement — the eye cannot tell
   this from gradient noise once it is warping an image. */
fn hash21(p : vec2f) -> f32 {
  var q = fract(p * vec2f(123.34, 456.21));
  q += dot(q, q + 45.32);
  return fract(q.x * q.y);
}
fn noise(p : vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u2 = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i + vec2f(0.0, 0.0)), hash21(i + vec2f(1.0, 0.0)), u2.x),
             mix(hash21(i + vec2f(0.0, 1.0)), hash21(i + vec2f(1.0, 1.0)), u2.x), u2.y);
}
fn fbm(p : vec2f) -> f32 {
  var v = 0.0; var a = 0.5; var q = p;
  for (var i = 0; i < 4; i++) { v += a * noise(q); q *= 2.0; a *= 0.5; }
  return v;
}

struct VSOut {
  @builtin(position) pos : vec4f,
  @location(0)       uv  : vec2f,
};

@vertex
fn vs(@builtin(vertex_index) i : u32) -> VSOut {
  // Two triangles as one strip, in unit space, then mapped into u.rect.
  var unit = array<vec2f, 4>(
    vec2f(0.0, 0.0), vec2f(1.0, 0.0),
    vec2f(0.0, 1.0), vec2f(1.0, 1.0),
  );
  let p = unit[i];
  var out : VSOut;
  out.pos = vec4f(u.rect.x + p.x * u.rect.z,
                  u.rect.y - p.y * u.rect.w,
                  0.0, 1.0);
  out.uv  = p;
  return out;
}
`;

export class Stage {
  /**
   * @param {object} [opts]
   * @param {Document} [opts.document]
   * @param {number}   [opts.maxPixelRatio] Hard cap on devicePixelRatio.
   */
  constructor(opts = {}) {
    this.doc = opts.document ?? (typeof document !== 'undefined' ? document : null);
    /**
     * Capped at 2 deliberately. A 3x phone screen means 9x the fragments for a
     * difference almost nobody can see, and these shaders are fragment-bound.
     */
    this.maxPixelRatio = opts.maxPixelRatio ?? 2;

    /** @type {GPUDevice|null} */
    this.device = null;
    /** @type {GPUCanvasContext|null} */
    this.context = null;
    /** @type {HTMLCanvasElement|null} */
    this.canvas = null;
    /** @type {GPUTextureFormat|null} */
    this.format = null;
    /** @type {Map<string, GPURenderPipeline>} one pipeline per effect */
    this.pipelines = new Map();
    this.ready = false;
    /** @type {string|null} why it gave up, for anyone debugging a blank page */
    this.failed = null;
    /** @type {((info: GPUDeviceLostInfo) => void)|null} */
    this.onLost = null;
  }

  /**
   * Sets up the device and canvas.
   *
   * Returns `false` rather than throwing when WebGPU is unavailable. Absence of
   * a GPU is not an error — it is roughly fifteen percent of visitors, and the
   * correct response is that the page keeps working with its plain images.
   * Throwing here would push that decision onto every caller.
   *
   * @returns {Promise<boolean>}
   */
  async init() {
    if (this.ready) return true;
    if (this.failed) return false;

    const nav = typeof navigator !== 'undefined' ? navigator : null;
    const doc = this.doc;
    if (!nav?.gpu || !doc) {
      this.failed = 'no-webgpu';
      return false;
    }

    /** @type {GPUDevice} */
    let device;
    try {
      const adapter = await nav.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (!adapter) { this.failed = 'no-adapter'; return false; }
      device = await adapter.requestDevice();
    } catch (e) {
      this.failed = String(e);
      return false;
    }
    this.device = device;

    /**
     * A device can be lost at any time — driver reset, tab backgrounded on some
     * mobile GPUs, the OS reclaiming memory. If that happens we tear the canvas
     * down and let the DOM show through again. A frozen last frame stuck over
     * the real content is worse than no effect at all.
     */
    device.lost.then((info) => {
      this.failed = `device-lost: ${info.reason}`;
      this.ready = false;
      this.canvas?.remove();
      this.onLost?.(info);
    });

    const c = doc.createElement('canvas');
    c.setAttribute('aria-hidden', 'true');
    c.style.cssText =
      'position:fixed;inset:0;width:100%;height:100%;' +
      'pointer-events:none;z-index:1';
    doc.body.appendChild(c);

    // A context can still come back null — a canvas that is already using a 2d
    // context, or a browser that reports gpu support and then refuses one.
    const ctx = c.getContext('webgpu');
    if (!ctx) {
      c.remove();
      this.failed = 'no-context';
      return false;
    }

    this.canvas = c;
    this.context = ctx;
    this.format = nav.gpu.getPreferredCanvasFormat();
    ctx.configure({
      device,
      format: this.format,
      alphaMode: 'premultiplied',
    });

    this.resize();
    this.ready = true;
    return true;
  }

  /** Matches the drawing buffer to the viewport, at the capped pixel ratio. */
  resize() {
    if (!this.canvas) return;
    const dpr = Math.min(globalThis.devicePixelRatio || 1, this.maxPixelRatio);
    const w = Math.max(1, Math.floor(globalThis.innerWidth * dpr));
    const h = Math.max(1, Math.floor(globalThis.innerHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  /**
   * Builds (and caches) the pipeline for an effect.
   * @param {string} name
   * @param {string} fragment WGSL source containing `fn fs(...)`.
   */
  pipeline(name, fragment) {
    const found = this.pipelines.get(name);
    if (found) return found;

    const device = this.device;
    // Reaching here without a device is a caller bug, not a missing GPU: the
    // missing-GPU path returns false from init() and never gets this far.
    if (!device) throw new Error('glaze: pipeline() called before init() succeeded');

    const module = device.createShaderModule({
      label: `glaze:${name}`,
      code: VERTEX + '\n' + fragment,
    });

    const p = device.createRenderPipeline({
      label: `glaze:${name}`,
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: {
        module,
        entryPoint: 'fs',
        targets: [{
          format: this.format ?? 'bgra8unorm',
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
          },
        }],
      },
      primitive: { topology: 'triangle-strip' },
    });

    this.pipelines.set(name, p);
    return p;
  }

  /**
   * Draws one frame.
   * @param {Iterable<{visible:boolean, draw:(pass:GPURenderPassEncoder)=>void}>} items
   */
  render(items) {
    const { device, context } = this;
    if (!this.ready || !device || !context) return;
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: context.getCurrentTexture().createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });
    for (const item of items) {
      if (item.visible) item.draw(pass);
    }
    pass.end();
    device.queue.submit([encoder.finish()]);
  }

  destroy() {
    this.canvas?.remove();
    this.pipelines.clear();
    this.device?.destroy?.();
    this.ready = false;
  }
}
