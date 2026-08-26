import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * The scroll-velocity filter, pinned to the input that actually broke it.
 *
 * WHY THIS FILE EXISTS. Every other test in this suite passed while the
 * library did nothing visible on a mouse. The filter was a symmetric low-pass
 * (`v = v*0.86 + delta*0.14`), a wheel notch is an impulse, and removing
 * impulses is what a low-pass filter is for — so one notch reached v≈0.23,
 * about ten pixels of warp on a 1024px image. Nobody could see it.
 *
 * It was never caught because the effect was only ever checked by scrolling a
 * trackpad, where motion is continuous and the filter behaves. Correctness
 * tests cannot find "technically running, visually nothing"; only a number
 * with a floor under it can.
 *
 * The filter is duplicated here rather than imported because it lives inside
 * the rAF closure in index.js, where there is no DOM-free way to reach it. The
 * duplication is checked: the last test in this file reads the real source and
 * fails if the constants drift from the ones asserted here.
 */

/** Exactly the recurrence in `start()` in src/index.js. */
function filtro(deltasPx) {
  let v = 0;
  const picos = [];
  for (const px of deltasPx) {
    const delta = px / 30;
    const alvo = delta > 1 ? 1 : delta < -1 ? -1 : delta;
    v = Math.abs(alvo) > Math.abs(v) ? alvo : v * 0.90 + alvo * 0.10;
    picos.push(v);
  }
  return picos;
}

/**
 * One wheel notch as a smooth-scroll library delivers it: the same 100px, but
 * animated over ~300ms with an ease instead of arriving in one frame.
 * `scroll-behavior: smooth`, Lenis and GSAP ScrollSmoother all produce this
 * shape, and between them they cover a large share of the sites anyone would
 * put this library on.
 */
function suave(distancia = 100, ms = 300, fps = 60) {
  const n = Math.round((ms / 1000) * fps);
  const pos = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    pos.push(distancia * (1 - Math.pow(1 - t, 3)));   // ease-out cubic
  }
  const deltas = [];
  for (let i = 0; i < n; i++) deltas.push(pos[i + 1] - pos[i]);
  return [...deltas, ...Array(20).fill(0)];
}

const pico = (d) => Math.max(...filtro(d).map(Math.abs));

/** What the displace effect actually moves, in pixels, at demo settings. */
const deslocamentoPx = (v, largura = 1024, strength = 0.7) =>
  strength * 0.06 * Math.min(Math.abs(v), 1) * largura;

/** One mouse-wheel notch: Chrome moves ~100px in a single frame, then stops. */
const RODA = [100, ...Array(20).fill(0)];
/** A trackpad: continuous, ~30px per frame. */
const TRACKPAD = [...Array(30).fill(30), ...Array(10).fill(0)];

test('one mouse-wheel notch produces a displacement you can actually see', () => {
  const v = pico(RODA);
  const px = deslocamentoPx(v);
  // The old filter gave 10px here. The floor is what this file is for.
  assert.ok(px >= 30,
    `a wheel notch must move the image at least 30px, got ${px.toFixed(1)}px (v=${v.toFixed(2)})`);
});

test('a light wheel notch is visible too, and smaller than a hard one', () => {
  const leve = pico([25, ...Array(20).fill(0)]);
  const forte = pico([100, ...Array(20).fill(0)]);
  assert.ok(deslocamentoPx(leve) >= 12, `a light notch should still register`);
  assert.ok(leve < forte, 'and a light notch must not look the same as a hard one');
});

/**
 * THE ONE THAT WOULD HAVE SAVED THREE ROUNDS OF DEBUGGING.
 *
 * Every earlier test in this file fed the filter a native scroll — one big
 * jump. Under a smooth-scroll library the same gesture arrives spread over
 * twenty frames, the busiest of which moves 16px rather than 100. Normalised
 * by 60 that was v=0.26 against v=1.00: a quarter of the effect, for an input
 * the user cannot tell apart from the other one.
 *
 * The demo had `scroll-behavior: smooth` in its own stylesheet. The two
 * velocity-driven effects looked broken and the progress-driven one looked
 * fine, which is exactly the symptom that got reported.
 */
test('a smooth-scrolled wheel notch is still clearly visible', () => {
  const v = pico(suave());
  const px = deslocamentoPx(v);
  assert.ok(px >= 20,
    `smooth scrolling must still move the image at least 20px, got ${px.toFixed(1)}px ` +
    `(v=${v.toFixed(2)}). Normalising by 60px/frame gave 11px here and the effect ` +
    `looked broken on every site using scroll-behavior:smooth or Lenis.`);
});

test('smooth scrolling reads as slower than native, but not as nothing', () => {
  const s = pico(suave());
  const n = pico(RODA);
  assert.ok(s < n, 'a smooth scroll is genuinely slower and should read that way');
  assert.ok(s > 0.45, `but not by four times over — got ${s.toFixed(2)}`);
});

test('trackpad response is preserved, not traded away', () => {
  // The fix must not fix the mouse by breaking the case that already worked.
  // The old filter peaked at 0.49 here; anything near that is fine.
  const v = pico(TRACKPAD);
  assert.ok(v > 0.40 && v <= 1.0, `trackpad peak drifted to ${v.toFixed(2)}`);
});

test('velocity is clamped to 1 however violently the page is scrolled', () => {
  assert.ok(pico([5000, 5000, 5000]) <= 1.0);
  assert.ok(pico([-5000, -5000]) <= 1.0);
});

test('scrolling up is as strong as scrolling down', () => {
  assert.equal(pico(RODA), pico(RODA.map((n) => -n)));
});

test('a still page settles to nothing, and stays there', () => {
  const v = filtro([...RODA, ...Array(120).fill(0)]);
  assert.ok(Math.abs(v.at(-1)) < 0.001, `did not settle: ${v.at(-1)}`);
  // A still page must be a pixel-identical image, or "costs nothing when
  // nothing is happening" is not true.
  assert.equal(deslocamentoPx(v.at(-1)) < 0.05, true);
});

test('release takes long enough to read as weight, not as a snap', () => {
  const v = filtro([100, ...Array(60).fill(0)]).map(Math.abs);
  const frames = v.findIndex((n, i) => i > 0 && n < 0.1);
  const ms = frames * 1000 / 60;
  assert.ok(ms > 200 && ms < 700, `settle took ${ms.toFixed(0)}ms — should feel weighted, not sticky`);
});

test('the attack is instant: the peak lands on the frame the page moved', () => {
  const v = filtro(RODA).map(Math.abs);
  assert.equal(v.indexOf(Math.max(...v)), 0,
    'a low-pass filter puts the peak several frames late, which is what hid this bug');
});

test('the constants here still match src/index.js', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  // A copy nothing compares is a second version waiting to drift.
  assert.match(src, /\(y - s\.lastScrollY\) \/ 30/, "normalisation divisor changed — smooth scrolling will regress");
  assert.match(src, /s\.velocity \* 0\.90 \+ alvo \* 0\.10/, 'release coefficients changed');
  assert.match(src, /Math\.abs\(alvo\) > Math\.abs\(s\.velocity\)\s*\n?\s*\? alvo/,
    'the fast-attack branch is gone — the wheel case will regress');
});
