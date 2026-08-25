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

/** @typedef {{ wgsl: string, defaults: Record<string, number> }} Effect */

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
    defaults: { strength: 0.5, scale: 3.0 },
    wgsl: /* wgsl */ `
@fragment
fn fs(@location(0) uv : vec2f) -> @location(0) vec4f {
  let t = u.params.z;
  let vel = u.params.w;
  let s = u.params.y;

  // Two noise fields at different rates so the warp never repeats visibly.
  let p = vec2f(uv.x * u.extra.x, uv.y) * 3.0;
  let nx = fbm(p + vec2f(t * 0.10, t * 0.06));
  let ny = fbm(p + vec2f(-t * 0.08, t * 0.11) + 17.0);

  // Velocity drives the amount. A still page is an untouched image — which is
  // the whole point: the effect has to cost nothing when nothing is happening.
  let amount = s * 0.06 * clamp(abs(vel), 0.0, 1.0);
  let dir = vec2f(nx - 0.5, ny - 0.5) * 2.0;

  // Displacement is stronger away from the centre, so edges move and the
  // subject of the photo stays legible.
  let edge = smoothstep(0.0, 0.55, length(uv - 0.5));
  let warped = uv + dir * amount * edge;

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
  let amount = u.params.y * 0.015 * vel;

  // Split vertically, because scrolling is vertical. Splitting on x here is the
  // mistake that makes this effect look pasted on.
  let off = vec2f(0.0, amount) * smoothstep(0.0, 0.7, length(uv - 0.5));

  let r = textureSample(tex, samp, clamp(uv + off, vec2f(0.0), vec2f(1.0))).r;
  let g = textureSample(tex, samp, uv);
  let b = textureSample(tex, samp, clamp(uv - off, vec2f(0.0), vec2f(1.0))).b;
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
