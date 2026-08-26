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
  // kind of shader. If an effect moves its sample, it has to clamp.
  for (const [name, e] of Object.entries(EFFECTS)) {
    if (!/(base|uv)\s*[+-]\s/.test(e.wgsl)) continue;
    assert.match(e.wgsl, /clamp\(/, `${name}: offsets its sample but never clamps`);
  }
});

/**
 * Clamping stops the read going out of bounds; it does NOT stop it looking
 * wrong. Once a sample is clamped you get the edge pixel repeated down the
 * side of the image, and on the live demo that was a visible pink band on
 * every fast scroll — the exact defect the test above claims to prevent.
 *
 * The fix is to never need the clamp: sample from a rectangle inset by the
 * most the effect can possibly displace, so there are always real pixels to
 * pull from. This test exists because the clamp test passed the whole time
 * the smear was on screen.
 */
test('effects that displace also inset, so the clamp is never reached', () => {
  // Only effects that clamp a *sampling coordinate* are in scope. `reveal`
  // clamps its progress value, which has nothing to do with edge smearing —
  // an earlier version of this test failed it, which is worth remembering:
  // a guard that fires on the wrong thing gets disabled, not fixed.
  const clampsUmaAmostra = (w) => /textureSample\s*\([^)]*clamp\s*\(/.test(w);

  for (const [name, e] of Object.entries(EFFECTS)) {
    if (!clampsUmaAmostra(e.wgsl)) continue;
    assert.match(e.wgsl, /let\s+inset\s*=/,
      `${name}: clamps a moved sample but never insets — the clamp will smear the edge`);
    assert.match(e.wgsl, /uv\s*\*\s*\(1\.0\s*-\s*2\.0\s*\*\s*inset\)\s*\+\s*inset/,
      `${name}: inset must remap uv into the safe rectangle`);
    // Per-frame insets make the crop breathe with scroll speed, which reads
    // as the image zooming. The inset may depend on strength, never on
    // velocity (params.w) or time (params.z).
    const linha = e.wgsl.match(/let\s+inset\s*=.*/)[0];
    assert.doesNotMatch(linha, /params\.[zw]|vel|\bt\b/,
      `${name}: the inset must be constant per element, not per frame — got: ${linha.trim()}`);
  }
});

/**
 * Every advertised option must actually reach the shader.
 *
 * `displace` shipped with `defaults: { strength: 0.5, scale: 3.0 }` while the
 * shader hard-coded the 3.0 and never read `scale` anywhere. Passing
 * `{ scale: 8 }` did nothing, silently, and the option was in the defaults
 * where anyone would find it. Nothing in the suite noticed, because every test
 * asked whether the code was correct and none asked whether the API told the
 * truth.
 */
test('every default an effect advertises is wired to something', () => {
  const COMPONENTES = ['x', 'y', 'z', 'w'];

  for (const [name, e] of Object.entries(EFFECTS)) {
    const extras = e.extras ?? [];
    assert.ok(extras.length <= 4,
      `${name}: only four extra params fit in u.opts, got ${extras.length}`);

    for (const chave of Object.keys(e.defaults)) {
      // `strength` is universal: the prelude puts it in params.y for everyone.
      if (chave === 'strength') {
        assert.match(e.wgsl, /u\.params\.y/, `${name}: declares strength but never reads it`);
        continue;
      }
      const i = extras.indexOf(chave);
      assert.notEqual(i, -1,
        `${name}: "${chave}" is in defaults but not in extras — it will be silently ignored`);
      assert.ok(e.wgsl.includes(`u.opts.${COMPONENTES[i]}`),
        `${name}: "${chave}" maps to u.opts.${COMPONENTES[i]}, which the shader never reads`);
    }

    for (const chave of extras) {
      assert.ok(chave in e.defaults,
        `${name}: "${chave}" is in extras with no default — callers get 0 if they omit it`);
    }
  }
});

/**
 * The centre of the frame must get a real share of the effect.
 *
 * `displace` and `rgb` both weight themselves towards the edges. That is a
 * good idea for a warp — it keeps the subject of a photograph legible — but
 * `smoothstep(0, k, length(uv - 0.5))` is *zero* at the centre and about 0.18
 * a fifth of the way out, so most of the frame got almost nothing. Which is
 * where people look, and why two of three effects were repeatedly reported as
 * doing nothing.
 *
 * Measured in the central third of the image: adding a floor took `displace`
 * from 38.9 to 62.0 and `rgb` from 24.1 to 54.0, at no extra cost in cropping.
 * Raising the amount instead reached only 49.4 and doubled the crop. The floor
 * is the lever.
 */
test('edge weighting never falls to zero in the middle of the frame', () => {
  for (const [name, e] of Object.entries(EFFECTS)) {
    // Only effects that weight by distance from centre are in scope.
    const pesos = [...e.wgsl.matchAll(/([\d.]+)\s*\+\s*([\d.]+)\s*\*\s*smoothstep\([^)]*length\(uv - 0\.5\)\)/g)];
    const cru = /(?<![\d.]\s\+\s)(?:^|[^*]\s)smoothstep\(0\.0,\s*[\d.]+,\s*length\(uv - 0\.5\)\)/m.test(e.wgsl);

    if (!e.wgsl.includes('length(uv - 0.5)')) continue;

    assert.ok(pesos.length > 0,
      `${name}: weights by distance from the centre with no floor — the middle ` +
      `of the frame gets nothing, which is where people look`);

    for (const [, piso] of pesos) {
      assert.ok(Number(piso) >= 0.3,
        `${name}: the centre only gets ${piso} of the effect; it needs at least 0.3 to be seen`);
    }
    assert.ok(!cru, `${name}: an unfloored smoothstep on the centre distance is back`);
  }
});

test('the three shipped effects are present', () => {
  assert.deepEqual(Object.keys(EFFECTS).sort(), ['displace', 'reveal', 'rgb']);
});
