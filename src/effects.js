/**
 * The effects.
 *
 * An effect is data, not a class: a name, a WGSL fragment function, and its
 * default parameters. Adding one is writing `fn fs` and nothing else — the
 * uniform block, the texture bindings, the vertex stage and the noise helpers
 * all come from the prelude in `stage.js`.
 *
 * That constraint is deliberate. The moment effects can define their own
 * bindings, every effect can get the bindings wrong, and the pipeline cache in
 * `stage.js` stops being able to assume a single layout.
 *
 * Available to every `fs`:
 *   u.params.x  scroll progress through the viewport, 0 at entry, 1 at exit
 *   u.params.y  strength, 0..1, straight from the caller
 *   u.params.z  seconds since start
 *   u.params.w  scroll velocity, normalised and signed
 *   u.extra.x   aspect ratio (w/h)
 *   u.extra.yz  pointer position in element space
 *   u.extra.w   pointer proximity, 1 at the centre, 0 outside
 *   uv          0..1 across the element, y down
 *   fbm(p)      4-octave value noise
 */

/**
 * @typedef {object} Effect
 * @property {string} wgsl A fragment stage containing `fn fs`.
 * @property {Record<string, number>} defaults
 * @property {string[]} [extras]
 *   The names of this effect's own scalar parameters, in the order they land
 *   in `u.opts.xyzw`. Anything in `defaults` other than `strength` must appear
 *   here, or it is advertised to callers and then silently ignored.
 */

/**
 * `@satisfies` and not `@type`: it checks every entry has the right shape while
 * keeping the literal keys, so `effect: 'displace'` autocompletes and a typo is
 * a compile error for TypeScript consumers rather than a runtime throw.
 * @satisfies {Record<string, Effect>}
 */
export const EFFECTS = {
  /**
   * Liquid displacement driven by scroll velocity. The signature effect: the
   * image stays still until the page moves, then warps in the direction of
   * travel and settles.
   */
  displace: {
    /**
     * `scale` is the spatial frequency of the warp, and it is the difference
     * between an effect and a rounding error. At 3.0 - the value this shipped
     * with - the noise field has three cycles across the image, so the whole
     * frame slides gently in one direction and nobody notices anything
     * happened. At 9.0 the contour lines visibly ripple and the image reads as
     * liquid, which is the point. Past ~14 it stops looking like a material
     * and starts looking like interference.
     */
    defaults: { strength: 0.5, scale: 9.0 },
    extras: ['scale'],
    wgsl: /* wgsl */ `
@fragment
fn fs(@location(0) uv : vec2f) -> @location(0) vec4f {
  let t = u.params.z;
  let vel = u.params.w;
  let s = u.params.y;

  // Two noise fields at different rates so the warp never repeats visibly.
  let p = vec2f(uv.x * u.extra.x, uv.y) * max(u.opts.x, 0.5);
  let nx = fbm(p + vec2f(t * 0.10, t * 0.06));
  let ny = fbm(p + vec2f(-t * 0.08, t * 0.11) + 17.0);

  // Velocity drives the amount. A still page is an untouched image — which is
  // the whole point: the effect has to cost nothing when nothing is happening.
  let amount = s * 0.08 * clamp(abs(vel), 0.0, 1.0);
  let dir = vec2f(nx - 0.5, ny - 0.5) * 2.0;

  /* Displacement is stronger away from the centre, so edges move and the
     subject of the photo stays legible — but with a floor under it.

     Without the 0.4, smoothstep is 0 at the centre and about 0.18 a fifth of
     the way out, so the effect is nearly absent across the whole middle of
     the frame: exactly where the eye rests, and exactly where people looked
     when they said nothing was happening. Measured in the central third,
     adding the floor took the change from 38.9 to 62.0 at no extra cost,
     while raising the amount instead only reached 49.4 and doubled the crop.
     The floor is the lever; the amount is not. */
  let edge = 0.4 + 0.6 * smoothstep(0.0, 0.55, length(uv - 0.5));

  /* Sample from an inset rectangle so the displacement always has real pixels
     to pull from. Without this, a fast scroll pushes the sample past 1.0, the
     clamp below repeats the edge pixel, and a smeared band appears down the
     side of the image - which reads as a broken renderer, not as an effect.

     The inset is sized to the worst case the strength allows, not to this
     frame's displacement. Sizing it per-frame would make the crop breathe
     with scroll speed, and the image would appear to zoom while you scroll.
     At strength 0 the inset is 0, so nothing is cropped. */
  let inset = s * 0.08;
  let base = uv * (1.0 - 2.0 * inset) + inset;
  let warped = base + dir * amount * edge;

  return textureSample(tex, samp, clamp(warped, vec2f(0.0), vec2f(1.0)));
}`,
  },

  /**
   * A directional reveal with a soft, noisy edge, driven by scroll progress.
   * Replaces the usual opacity fade, which always looks like a loading state.
   */
  reveal: {
    defaults: { strength: 1.0 },
    wgsl: /* wgsl */ `
@fragment
fn fs(@location(0) uv : vec2f) -> @location(0) vec4f {
  // Map progress so the reveal completes while the element is comfortably in
  // view, rather than finishing as it leaves the top of the screen.
  let p = clamp((u.params.x - 0.15) / 0.45, 0.0, 1.0);

  let grain = fbm(vec2f(uv.x * u.extra.x, uv.y) * 4.0);
  // The mask travels bottom-to-top; the noise makes the edge tear rather than
  // sweep, which reads as material instead of as a CSS transition.
  let mask = smoothstep(0.0, 0.35, p * 1.35 - (1.0 - uv.y) - grain * 0.35 * u.params.y);

  var c = textureSample(tex, samp, uv);
  // The leading edge is brighter, so the reveal has a direction you can see.
  let lead = smoothstep(0.0, 0.12, mask) * (1.0 - smoothstep(0.12, 0.4, mask));
  c = vec4f(c.rgb + lead * 0.25 * u.params.y, c.a);
  return c * mask;
}`,
  },

  /**
   * Chromatic split on scroll velocity. Cheap, instantly recognisable, and the
   * one effect where restraint matters most — past about 0.4 it stops looking
   * like optics and starts looking like a broken screen.
   */
  rgb: {
    defaults: { strength: 0.35 },
    wgsl: /* wgsl */ `
@fragment
fn fs(@location(0) uv : vec2f) -> @location(0) vec4f {
  let vel = clamp(u.params.w, -1.0, 1.0);
  /* 0.05, up from 0.015 then 0.03. At the first value the default strength
     moved the red and blue taps three pixels apart on a 576px image, which is
     not an effect, it is a rounding error. */
  let amount = u.params.y * 0.05 * vel;

  // Split vertically, because scrolling is vertical. Splitting on x here is the
  // mistake that makes this effect look pasted on.
  /* Same floor as displace, and here it matters more. Weighting a chromatic
     split towards the edges is self-defeating: the split IS what you want to
     look at, so pushing it out of the middle of the frame hides the whole
     effect. Measured in the central third, this took the change from 24.1 to
     54.0. Real lenses do aberrate more at the edges, so the gradient stays -
     it just no longer starts from nothing. */
  let w = 0.45 + 0.55 * smoothstep(0.0, 0.7, length(uv - 0.5));
  let off = vec2f(0.0, amount) * w;

  // Same inset as displace, and for the same reason: the red and blue taps
  // move in opposite directions, so without it one of them always smears the
  // top or bottom edge on a fast scroll. See the note in the displace effect.
  let inset = u.params.y * 0.05;
  let base = uv * (1.0 - 2.0 * inset) + inset;

  let r = textureSample(tex, samp, clamp(base + off, vec2f(0.0), vec2f(1.0))).r;
  let g = textureSample(tex, samp, base);
  let b = textureSample(tex, samp, clamp(base - off, vec2f(0.0), vec2f(1.0))).b;
  return vec4f(r, g.g, b, g.a);
}`,
  },
};

/**
 * @param {string} name
 * @returns {Effect}
 */
export function getEffect(name) {
  const e = /** @type {Record<string, Effect>} */ (EFFECTS)[name];
  if (!e) {
    throw new RangeError(
      `glaze: unknown effect "${name}". Available: ${Object.keys(EFFECTS).join(', ')}`
    );
  }
  return e;
}
