/**
 * One effected element: its texture, its uniforms, its draw call.
 *
 * Called a Layer rather than an Element on purpose — `Element` is a DOM global,
 * and a class of that name in a library about DOM elements produces .d.ts files
 * where the same word means two different things.
 *
 * THE ORDER OF OPERATIONS HERE IS THE WHOLE FEATURE.
 *
 * The element is only hidden *after* its texture has decoded and uploaded. Get
 * that backwards — hide first, upload later — and every visitor sees a hole
 * where the image should be for as long as the decode takes, which on a cold
 * cache and a slow phone is not a frame or two. The image is the content; the
 * effect is decoration. Decoration never gets to remove content, not even
 * briefly.
 *
 * `visibility: hidden` and not `display: none`, because the layout has to stay
 * exactly as it was: the quad is positioned from the element's own rect, so the
 * moment the element stops occupying space the effect has nothing to align to.
 */

const UNIFORM_BYTES = 64; // 4 × vec4f — rect, params, extra, opts

export class Layer {
  /**
   * @param {HTMLImageElement} el
   * @param {import('./stage.js').Stage} stage
   * @param {{ wgsl: string, defaults: Record<string, number>, extras?: string[] }} effect
   * @param {string} effectName
   * @param {Record<string, any>} opts
   */
  constructor(el, stage, effect, effectName, opts) {
    this.el = el;
    this.stage = stage;
    this.effect = effect;
    this.effectName = effectName;
    this.opts = { ...effect.defaults, ...opts };
    /**
     * The effect's own scalar parameters, in the order it declared them; they
     * land in `u.opts.xyzw`. Before this existed, `displace` advertised a
     * `scale` default that the shader hard-coded and never read — passing
     * `{ scale: 8 }` did nothing at all, silently. An option that lies is
     * worse than a missing one.
     */
    this.extras = (effect.extras ?? []).slice(0, 4);

    this.ready = false;
    this.visible = false;
    this.onScreen = true;
    /** @type {DOMRect|null} */
    this.rect = null;
    this.clip = [0, 0, 0, 0];
    this.progress = 0;
    this.aspect = 1;

    /** @type {GPUTexture|null} */
    this.texture = null;
    /** @type {GPUBindGroup|null} */
    this.bindGroup = null;
    /** @type {GPUBuffer|null} */
    this.uniformBuffer = null;
    /** @type {GPURenderPipeline|null} */
    this.pipeline = null;
    this.uniforms = new Float32Array(16);
    this._previousVisibility = '';
  }

  /**
   * Decodes the source image and uploads it. Resolves `false` — rather than
   * throwing — when there is nothing usable to draw, because a broken image is
   * an ordinary thing on the web and should degrade to "no effect", not to a
   * crash that takes the other elements down with it.
   * @returns {Promise<boolean>}
   */
  async load() {
    const device = this.stage.device;
    if (!device) return false;

    const src = this.el.currentSrc || this.el.src;
    if (!src) return false;

    let bitmap;
    try {
      // `decode()` first so the bitmap is ready without blocking the main
      // thread on a synchronous decode inside createImageBitmap.
      if (this.el.decode) { try { await this.el.decode(); } catch { /* cached-error images */ } }
      bitmap = await createImageBitmap(this.el, { colorSpaceConversion: 'none' });
    } catch {
      return false;
    }

    const texture = device.createTexture({
      label: `glaze:${this.effectName}`,
      size: [bitmap.width, bitmap.height, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING
           | GPUTextureUsage.COPY_DST
           | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    device.queue.copyExternalImageToTexture(
      { source: bitmap },
      { texture },
      [bitmap.width, bitmap.height]
    );
    bitmap.close?.();
    this.texture = texture;

    const uniformBuffer = device.createBuffer({
      size: UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.uniformBuffer = uniformBuffer;

    const pipeline = this.stage.pipeline(this.effectName, this.effect.wgsl);
    this.bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniformBuffer } },
        { binding: 1, resource: device.createSampler({ magFilter: 'linear', minFilter: 'linear' }) },
        { binding: 2, resource: texture.createView() },
      ],
    });
    this.pipeline = pipeline;

    // Only now. See the note at the top of this file.
    this._previousVisibility = this.el.style.visibility;
    this.el.style.visibility = 'hidden';
    this.ready = true;
    return true;
  }

  /**
   * @param {number} time seconds
   * @param {number} velocity normalised, signed
   * @param {{x:number,y:number,near:number}} pointer
   */
  update(time, velocity, pointer) {
    const device = this.stage.device;
    if (!this.ready || !device || !this.uniformBuffer) return;
    const u = this.uniforms;
    u[0] = this.clip[0]; u[1] = this.clip[1]; u[2] = this.clip[2]; u[3] = this.clip[3];
    u[4] = this.progress;
    u[5] = this.opts.strength ?? 0.5;
    u[6] = time;
    u[7] = velocity;
    u[8] = this.aspect;
    u[9] = pointer.x;
    u[10] = pointer.y;
    u[11] = pointer.near;
    for (let i = 0; i < 4; i++) {
      const chave = this.extras[i];
      u[12 + i] = chave ? (this.opts[chave] ?? 0) : 0;
    }
    device.queue.writeBuffer(this.uniformBuffer, 0, u);
  }

  /** @param {GPURenderPassEncoder} pass */
  draw(pass) {
    if (!this.ready || !this.pipeline || !this.bindGroup) return;
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.draw(4);
  }

  /** Puts the DOM element back exactly as it was found. */
  destroy() {
    if (this.ready) this.el.style.visibility = this._previousVisibility;
    this.texture?.destroy?.();
    this.uniformBuffer?.destroy?.();
    this.ready = false;
  }
}
