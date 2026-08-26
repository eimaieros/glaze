import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * The scroll-velocity filter, pinned to every input that has broken it.
 *
 * WHY THIS FILE EXISTS. Every other test in this suite passed while the
 * library did nothing visible. Three separate times. Correctness tests cannot
 * tell "running" apart from "running and invisible"; only a number with a
 * floor under it can.
 *
 * The three failures, in order:
 *
 *   1. A symmetric low-pass filter (`v = v*0.86 + delta*0.14`). A wheel notch
 *      is an impulse, and removing impulses is what a low-pass filter does, so
 *      one notch reached v≈0.23. Only ever tested on a trackpad, where motion
 *      is continuous and the filter behaves — the input it was tuned for was
 *      the input that hid it.
 *
 *   2. Normalising per frame. `delta = (y - last) / 60` asks how far the page
 *      moved since the previous frame, which silently makes the effect weaker
 *      on a better monitor: the same physical flick gave v=1.00 at 60Hz and
 *      v=0.48 at 144Hz. The reporter's screen ran at 71Hz.
 *
 *   3. Smooth scrolling. `scroll-behavior: smooth`, Lenis and ScrollSmoother
 *      spread one notch over ~300ms, so no single frame moves very far.
 *
 * The filter is duplicated here rather than imported because it lives inside
 * the rAF closure in index.js, where there is no DOM-free way to reach it. The
 * duplication is checked: the last test reads the real source and fails if the
 * constants drift.
 */

/** Exactly the recurrence in `start()` in src/index.js. */
function filtro(amostras) {
  let v = 0;
  const picos = [];
  for (const [px, dtMs] of amostras) {
    const dt = Math.min(Math.max(dtMs, 1), 100);
    let alvo = px / (dt / 1000) / 1800;
    alvo = alvo > 1 ? 1 : alvo < -1 ? -1 : alvo;
    const decay = Math.pow(0.90, dt / 16.667);
    v = Math.abs(alvo) > Math.abs(v) ? alvo : v * decay + alvo * (1 - decay);
    picos.push(v);
  }
  return picos;
}

const pico = (a) => Math.max(...filtro(a).map(Math.abs));

/** What `displace` actually moves, in pixels, at the demo's settings. */
const deslocamentoPx = (v, largura = 1024, strength = 0.7) =>
  strength * 0.06 * Math.min(Math.abs(v), 1) * largura;

/** A gesture as [pixels, milliseconds] pairs, sampled at a given refresh rate. */
function gesto({ distancia = 100, ms = 140, fps = 60, suave = true }) {
  const dt = 1000 / fps;
  const n = Math.max(1, Math.round((ms / 1000) * fps));
  const amostras = [];
  if (!suave) {
    amostras.push([distancia, dt]);
  } else {
    const pos = [];
    for (let i = 0; i <= n; i++) pos.push(distancia * (1 - Math.pow(1 - i / n, 3)));
    for (let i = 0; i < n; i++) amostras.push([pos[i + 1] - pos[i], dt]);
  }
  for (let i = 0; i < 40; i++) amostras.push([0, dt]);
  return amostras;
}

test('one native wheel notch produces a displacement you can actually see', () => {
  const px = deslocamentoPx(pico(gesto({ suave: false })));
  assert.ok(px >= 30, `a wheel notch must move the image at least 30px, got ${px.toFixed(1)}px`);
});

test('a smooth-scrolled notch is still clearly visible', () => {
  const px = deslocamentoPx(pico(gesto({ ms: 300 })));
  assert.ok(px >= 20,
    `smooth scrolling must still move the image at least 20px, got ${px.toFixed(1)}px. ` +
    `Per-frame normalisation gave 11px here and the effect looked broken on every ` +
    `site using scroll-behavior:smooth or Lenis.`);
});

/**
 * THE ONE THE REPORTER'S MACHINE NEEDED.
 *
 * A 144Hz monitor samples the same gesture more often, so each frame moves
 * less. Under per-frame normalisation that halved the effect for identical
 * input — the same flick read 1.00 at 60Hz and 0.48 at 144Hz. Dividing by
 * elapsed time makes the reading a property of the gesture instead of the
 * hardware.
 */
test('refresh rate does not change the reading', () => {
  const taxas = [60, 71, 90, 102, 120, 144, 165];
  const vs = taxas.map((fps) => pico(gesto({ fps })));
  const menor = Math.min(...vs), maior = Math.max(...vs);
  assert.ok(maior - menor < 0.05,
    `the same gesture read ${menor.toFixed(2)}–${maior.toFixed(2)} across ` +
    `${taxas.join('/')}Hz. It must not depend on the monitor:\n  ` +
    taxas.map((f, i) => `${f}Hz → ${vs[i].toFixed(2)}`).join('\n  '));
});

test('and every refresh rate is above the visible floor', () => {
  for (const fps of [60, 71, 102, 144, 165]) {
    const px = deslocamentoPx(pico(gesto({ fps })));
    assert.ok(px >= 30, `${fps}Hz only moved the image ${px.toFixed(1)}px`);
  }
});

test('the settle takes the same real time at any refresh rate', () => {
  const tempos = [];
  for (const fps of [60, 90, 120, 144]) {
    const dt = 1000 / fps;
    // A full second of idle, in that display's frames — enough to settle at
    // any rate. An earlier version sampled a fixed 40 frames, which is 667ms
    // at 60Hz but only 278ms at 144Hz, and the test failed on arithmetic of
    // its own making rather than on anything the library did.
    const amostras = [...gesto({ fps, suave: false }), ...Array(fps).fill([0, dt])];
    const v = filtro(amostras).map(Math.abs);
    const frames = v.findIndex((n, i) => i > 0 && n < 0.1);
    assert.notEqual(frames, -1, `${fps}Hz never settled`);
    tempos.push(frames * dt);
  }
  for (const ms of tempos) {
    assert.ok(ms > 200 && ms < 700, `settled in ${ms.toFixed(0)}ms`);
  }
  const spread = Math.max(...tempos) - Math.min(...tempos);
  assert.ok(spread < 40,
    `the settle took ${tempos.map((t) => t.toFixed(0)).join('/')}ms across refresh rates`);
});

test('a slow drag reads as slower than a flick', () => {
  const lento = pico(gesto({ distancia: 40, ms: 400 }));
  const rapido = pico(gesto({ distancia: 400, ms: 140 }));
  assert.ok(lento < rapido, 'speed must still be legible as speed');
  assert.ok(lento > 0.05, `a slow drag should register something, got ${lento.toFixed(3)}`);
});

test('velocity is clamped to 1 however violently the page is scrolled', () => {
  assert.ok(pico([[5000, 16], [5000, 16]]) <= 1.0);
  assert.ok(pico([[-5000, 16], [-5000, 16]]) <= 1.0);
});

test('scrolling up is as strong as scrolling down', () => {
  const baixo = gesto({ suave: false });
  const cima = baixo.map(([px, dt]) => [-px, dt]);
  assert.equal(pico(baixo), pico(cima));
});

test('a still page settles to nothing, and stays there', () => {
  const v = filtro([...gesto({ suave: false }), ...Array(200).fill([0, 16.7])]);
  assert.ok(Math.abs(v.at(-1)) < 0.001, `did not settle: ${v.at(-1)}`);
  assert.ok(deslocamentoPx(v.at(-1)) < 0.05,
    'a still page must be a pixel-identical image, or the whole pitch is false');
});

test('the attack is instant: the peak lands on the frame the page moved', () => {
  const v = filtro(gesto({ suave: false })).map(Math.abs);
  assert.equal(v.indexOf(Math.max(...v)), 0,
    'a low-pass filter puts the peak several frames late, which is what hid this first');
});

test('a stalled frame cannot produce a fake spike', () => {
  // A 2-second stall then a 40px scroll is 20px/s, not 2400px/s. The dt clamp
  // stops a long gap being read as a violent flick on the frame after it.
  const v = pico([[40, 2000], [0, 16.7]]);
  assert.ok(v < 0.4, `a stalled frame read as v=${v.toFixed(2)}`);
});

test('the constants here still match src/index.js', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  // A copy nothing compares is a second version waiting to drift.
  assert.match(src, /\/ \(dtMs \/ 1000\) \/ 1800/,
    'velocity is no longer pixels per second — the monitor dependence is back');
  assert.match(src, /Math\.pow\(0\.90, dtMs \/ 16\.667\)/,
    'the decay is no longer frame-rate corrected');
  assert.match(src, /Math\.abs\(alvo\) > Math\.abs\(s\.velocity\)\s*\n?\s*\? alvo/,
    'the fast-attack branch is gone — the wheel case will regress');
  assert.match(src, /Math\.min\(Math\.max\(now - s\.lastNow, 1\), 100\)/,
    'the dt clamp is gone — a stalled frame will read as a flick');
});
