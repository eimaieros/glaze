import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EFFECTS, getEffect } from '../src/effects.js';

test('an unknown effect throws at the call site, and says what exists', () => {
  assert.throws(() => getEffect('sparkle'), (err) => {
    assert.ok(err instanceof RangeError);
    // The message has to name the alternatives. "Unknown effect" alone sends
    // people to the source; naming them ends the problem in one read.
    for (const name of Object.keys(EFFECTS)) assert.match(err.message, new RegExp(name));
    return true;
  });
});

test('every effect returns its shader and its defaults', () => {
  for (const [name, e] of Object.entries(EFFECTS)) {
    assert.equal(typeof e.wgsl, 'string', `${name}: missing wgsl`);
    assert.equal(typeof e.defaults, 'object', `${name}: missing defaults`);
    assert.ok(e.defaults.strength > 0 && e.defaults.strength <= 1,
      `${name}: strength default must be in (0, 1]`);
  }
});

test('every effect contributes exactly one fragment entry point', () => {
  for (const [name, e] of Object.entries(EFFECTS)) {
    const fragments = (e.wgsl.match(/@fragment/g) || []).length;
    assert.equal(fragments, 1, `${name}: expected one @fragment, found ${fragments}`);
    assert.match(e.wgsl, /fn\s+fs\s*\(/, `${name}: entry point must be named fs`);
  }
});

/**
 * This is the test that keeps the design honest.
 *
 * The prelude in stage.js owns the uniform block, the sampler and the texture,
 * and the pipeline cache assumes every effect shares that one layout. An effect
 * that declares its own bindings would compile and then quietly collide. Better
 * to fail here, where the message can say why.
 */
test('no effect declares its own bindings or duplicates the prelude', () => {
  for (const [name, e] of Object.entries(EFFECTS)) {
    assert.doesNotMatch(e.wgsl, /@group\s*\(/,
      `${name}: bindings come from the prelude in stage.js, not from the effect`);
    assert.doesNotMatch(e.wgsl, /@vertex/,
      `${name}: the vertex stage is shared; effects contribute only fs`);
    assert.doesNotMatch(e.wgsl, /struct\s+Uniforms/,
      `${name}: the uniform block is declared once, in the prelude`);
  }
});

test('every effect samples the texture — an effect that ignores it is a bug', () => {
  for (const [name, e] of Object.entries(EFFECTS)) {
    assert.match(e.wgsl, /textureSample\s*\(\s*tex\s*,\s*samp/,
      `${name}: must sample the element's own texture`);
  }
});

test('sampling coordinates are clamped wherever they are offset', () => {
  // Reading outside 0..1 gives you the edge pixel smeared across the frame,
  // which looks like a rendering bug and is the most common mistake in this
  // kind of shader. If an effect adds an offset, it has to clamp.
  for (const [name, e] of Object.entries(EFFECTS)) {
    const offsets = e.wgsl.includes('uv +') || e.wgsl.includes('uv -');
    if (!offsets) continue;
    assert.match(e.wgsl, /clamp\(/, `${name}: offsets uv but never clamps`);
  }
});

test('the three shipped effects are present', () => {
  assert.deepEqual(Object.keys(EFFECTS).sort(), ['displace', 'reveal', 'rgb']);
});
