# glaze

**GPU effects over the DOM you already have.** Point it at an image, get a
WebGPU shader driven by scroll. If anything fails, the page keeps its images.

No dependencies. 13.6 KB minified, 5.6 KB gzipped. Ships TypeScript types.

```js
glaze('#hero img', { effect: 'displace' });
```

[**Live demo →**](https://rodrigofigueiredo.dev/glaze/)

---

## Why this exists

Scroll-driven shader effects are everywhere in award-winning web design and
almost nowhere in production, and the reason is not that they are hard to
write. It's that every implementation I could find starts by removing your
content.

The usual shape is: hide the image, mount a canvas, upload a texture, draw.
Between step one and step four there is a gap — the decode — during which the
visitor sees a hole. On a fast laptop with a warm cache that gap is invisible.
On a mid-range Android phone on a cold cache it is hundreds of milliseconds of
missing content, and if the decode fails it is permanent.

Then there is WebGPU itself. It is new: Safari only enabled it by default in
Safari 26.0, in September 2025, and on iOS that means iOS 26 or nothing.
Firefox shipped it on Windows in 141 and on Apple Silicon in 145. Anyone who
has not updated their OS in the last year has no WebGPU at all — and a library
that assumes it gives those visitors a blank page instead of a slow one.

glaze inverts both. The texture is uploaded **first**, and the element is
hidden only once there is something to replace it with. Every failure path —
no WebGPU, no adapter, a device lost mid-session, an image that will not
decode, `prefers-reduced-motion` — ends in the same place: the original DOM,
untouched and visible.

---

## Install

Straight from the repository — no npm release yet:

```bash
npm install github:eimaieros/glaze
```

Or copy `src/` into your project. It's ES modules with no dependencies, so
there is nothing to build.

## Use

```js
import { glaze } from 'glaze';

glaze('figure img', { effect: 'displace', strength: 0.6 });
```

That's the whole API. A CSS selector, an element, or any iterable of elements.

```js
const g = glaze(document.querySelectorAll('.work img'), { effect: 'reveal' });

g.active;     // did it actually start? false on machines without WebGPU
g.elements;   // the Layers it created — empty if it degraded
g.destroy();  // puts every element back exactly as it was found
```

Call it as many times as you like with different effects. There is still one
canvas, one device and one animation loop underneath.

### With a smooth-scroll library

Lenis, GSAP ScrollSmoother and friends do not scroll the page — they hold it at
`scrollY = 0` and translate it. `window.scrollY` therefore barely moves, and a
velocity-driven effect sees almost nothing. Feed glaze your scroller's own
velocity instead:

```js
const lenis = new Lenis();

glaze('figure img', {
  effect: 'displace',
  velocity: () => lenis.velocity / 30,   // normalise so ~1.0 is a brisk scroll
});
```

Return `null` on any frame to hand the reading back to glaze.

The same hook is what lets the demo hold an effect open so you can look at it.
That is worth knowing about, because a velocity-driven effect only exists while
the page is moving: by the time you have focused on the image you have stopped
scrolling, and it is gone. `reveal` holds its state because it is driven by
position, which is why it reads instantly and the other two were repeatedly
reported as broken when they were working.

```js
let held = false;
glaze('#hero img', { effect: 'displace', velocity: () => (held ? 1 : null) });
```

### With framebudget

Pass a [framebudget](https://github.com/eimaieros/framebudget) instance and
glaze turns itself down when the device is struggling — `reduced` scales the
effect back to 45%, `minimal` gives the page its plain `<img>` elements back and
stops drawing. It keeps watching, and takes over again when there is headroom.

```js
import { FrameBudget } from 'framebudget';

const fb = new FrameBudget({ target: 60 }).start();
glaze('figure img', { effect: 'displace', budget: fb });
```

---

## Effects

| name | driven by | options | what it does |
|---|---|---|---|
| `displace` | scroll velocity | `strength`, `scale` | liquid warp along the direction of travel, weighted to the edges so the subject stays legible |
| `reveal` | scroll progress | `strength` | directional mask with a torn, noisy leading edge — an alternative to the opacity fade |
| `rgb` | scroll velocity | `strength` | vertical chromatic split |

`scale` is the spatial frequency of the warp — how many ripples fit across the
image. It defaults to 9; below about 4 the whole frame drifts as one piece and
you cannot see anything happening, above about 14 it stops reading as a
material and starts reading as interference.

### These effects need something to move

`displace` and `rgb` move pixels around. `reveal` changes them. That difference
decides whether you can see anything, and it is a property of **your image**,
not of the library.

Move pixels around inside a smooth gradient and you get back the same smooth
gradient. There is nothing there to move. Measured on this demo, same shader,
same parameters, same scroll velocity — average change per pixel, out of 765:

| source image | `displace` | `rgb` | `reveal` |
|---|---|---|---|
| smooth gradient, sparse lines | **6.6** | **5.0** | 168 |
| dense line work, fine detail | **67** | **69** | 192 |

Ten times more visible, with no code change at all. The demo shipped with
the first kind of image, and for three rounds of debugging two of the three
effects looked broken.

So: use these on photographs, textures, type, artwork — anything with detail at
the scale the warp moves things. On a soft gradient or a heavily blurred image,
reach for `reveal`, which does not depend on what is underneath.

### And they must reach the middle of the frame

Both velocity effects weight themselves by distance from the centre, which is
right for a warp — it keeps the subject of a photograph legible. But
`smoothstep(0, k, length(uv - 0.5))` is **zero** at the centre and about 0.18 a
fifth of the way out, so almost the whole middle of the image was getting
almost nothing. That is where the eye rests, and it is where people were
looking when they said nothing was happening.

Measured in the central third of the image, at the same scroll speed:

| | centre, no floor | centre, with floor |
|---|---|---|
| `displace` | 38.9 | **62.0** |
| `rgb` | 24.1 | **54.0** |

Both floors cost nothing — no extra cropping, no extra work. Raising the
displacement amount instead reached only 49.4 and doubled the crop. The floor
was the lever the whole time; the amount never was.

Writing another one is a single WGSL function:

```js
import { EFFECTS } from 'glaze';

EFFECTS.pinch = {
  defaults: { strength: 0.5 },
  wgsl: `
@fragment
fn fs(@location(0) uv : vec2f) -> @location(0) vec4f {
  let d = uv - 0.5;
  let k = 1.0 - u.params.y * 0.2 * length(d);
  return textureSample(tex, samp, clamp(0.5 + d * k, vec2f(0.0), vec2f(1.0)));
}`,
};
```

The uniform block, the texture bindings, the vertex stage and the noise
helpers all come from the prelude in `stage.js`. An effect contributes `fn fs`
and nothing else — see [The prelude](#the-prelude) below for why.

Available in every `fs`:

```
u.params.x   scroll progress: 0 as the element enters, 1 as it leaves
u.params.y   strength, 0..1, straight from the caller
u.params.z   seconds since start
u.params.w   scroll velocity, normalised and signed
u.extra.x    aspect ratio (w/h)
u.extra.yz   pointer position in element space
u.extra.w    pointer proximity, 1 at the centre, 0 outside
u.opts.xyzw  this effect's own parameters, in the order it declared them
uv           0..1 across the element, y down
fbm(p)       4-octave value noise
```

An effect with parameters of its own lists them in `extras`, and they arrive in
`u.opts` in that order:

```js
EFFECTS.pinch = {
  defaults: { strength: 0.5, amount: 0.2 },
  extras: ['amount'],          // → u.opts.x
  wgsl: /* … u.opts.x … */,
};
```

Anything in `defaults` other than `strength` **must** appear in `extras`.
`displace` shipped advertising a `scale` default that the shader hard-coded and
never read, so `{ scale: 8 }` did nothing at all, silently — there is now a test
that fails on any option that isn't wired to something.

---

## A canvas only holds its content for one frame

This is the thing that took longest to see, and it is the reason the middle
three rows of that table exist.

A WebGPU canvas is not a picture you paint once. The swap-chain texture is
presented and released at the end of the frame, so a canvas nobody redraws goes
blank. Measured on the live demo: 5899 painted samples immediately after
`render()`, and **zero** fifty milliseconds later.

While the loop is running that is invisible — every frame repaints. The moment
it stops, the canvas empties, and if the elements are still hidden the page is
left with holes where its images were. And the loop stops for entirely ordinary
reasons:

- framebudget reports `minimal`, and glaze deliberately draws nothing
- the tab goes to the background, and Chrome suspends `requestAnimationFrame`
- the GPU device is lost

The first of those was the worst. The code read
`if (tier === 'minimal') { render([]); return; }` — so on a device already
struggling, at the exact moment you least want to break someone's page, glaze
deleted every image it had taken over. The library's one promise, inverted by
the branch that existed to keep it.

So every path that stops producing frames now hands the DOM back first:

```js
function suspender(s) {
  s.suspenso = true;
  for (const item of s.items) item.mostrarDom();  // real images, on screen
  s.stage.render([]);                            // only then, clear
}
```

The order is asserted by a test. Clearing first would leave one frame with
neither the canvas content nor the images.

---

## The promise that never settles

`HTMLImageElement.decode()` is the polite way to prepare an image: it resolves
once the bitmap is ready, so `createImageBitmap` does not block the main thread
on a synchronous decode. `load()` awaited it directly.

In Chrome, **`decode()` never settles while the document is hidden.** Not
resolved, not rejected — never. Verified on the live demo: `decode()` was still
pending after 2.5 seconds while `createImageBitmap()` resolved normally on the
very same element, in the same tick.

So a page opened in a background tab — a middle-click, a restored session,
"open all bookmarks in new tabs" — sat on that await forever. No Layer was
created, `start()` was never called, and glaze did nothing at all for the rest
of the page's life. The most literal possible version of "I opened it and
nothing happens".

`try/catch` is no help: a promise that never settles is not an error. The only
defence is a deadline.

```js
await Promise.race([
  this.el.decode(),
  new Promise((resolve) => setTimeout(resolve, 250)),
]);
```

The decode was always an optimisation — `createImageBitmap` does not require it
and works either way — so anything slower than a frame or two is not worth
waiting for.

---

## The four decisions worth explaining

### 1. Upload the texture before hiding the element

This is the entire reason the library exists, so it is worth being precise
about the ordering:

```js
bitmap = await createImageBitmap(this.el);   // decode
device.queue.copyExternalImageToTexture(…);  // upload
// …only now:
this.el.style.visibility = 'hidden';
```

If `createImageBitmap` throws — a broken URL, a CORS-tainted image, a decoder
that gives up — `load()` returns `false` and the element is never touched. One
bad image degrades to "that one has no effect", not to a hole in the page and
not to an exception that takes its siblings down with it.

`visibility: hidden` rather than `display: none` because the layout has to stay
exactly as it was. The quad is positioned from the element's own
`getBoundingClientRect()`, so the moment the element stops occupying space the
effect has nothing left to align to.

### 2. One canvas, not one per element

The obvious design is a canvas per image. It is what most tutorials do and it
falls over on a real page.

Each canvas is a separate GPU context with its own swap chain, its own command
submissions and its own compositing layer. Browsers cap how many live contexts
a page may hold — the limit is unspecified and around a dozen in practice — and
long before you reach the cap the compositor is doing more work than the
effects are worth.

So: one canvas fixed over the viewport, one device, and every element drawn as
a quad positioned at that element's screen rect. The twentieth image costs one
more draw call, not one more GPU context.

The price is that something now has to keep every quad aligned to a DOM rect it
does not own, across scroll and resize. That bookkeeping is `registry.js`, and
it is the real work of this library.

### 3. Read all the layout, then write all the layout

Asking an element for `getBoundingClientRect()` forces the browser to flush
pending style and layout. Once per frame that is almost free. In a loop with a
write between each read, the browser recomputes layout every iteration — twelve
images become twelve full layout passes per frame, no single function looks
slow in a profile, and the page crawls.

`measure()` therefore reads every rect in one pass and touches nothing else.

The second half is not measuring at all. Scroll and resize set a dirty flag;
frames where the flag is clear reuse the last measurement, so a still page
costs zero layout reads. There is a test that asserts exactly that, because it
is the kind of thing that quietly regresses.

Progress is deliberately height-independent:

```js
const span = vh + r.height;
item.progress = clamp01((vh - r.top) / span);
```

Divide by the element height alone and a tall image appears to lag a small one
through the same scroll — they animate over different spans. Dividing by
viewport-plus-element makes every element travel 0→1 over the same gesture.

### 4. Velocity attacks fast, releases slow, and is measured in seconds

```js
const dt   = clamp(now - last, 1, 100);              // ms
const alvo = clamp(scrolled / (dt / 1000) / 1800, -1, 1);
const decay = Math.pow(0.90, dt / 16.667);
s.velocity = Math.abs(alvo) > Math.abs(s.velocity)
  ? alvo                                             // attack: now
  : s.velocity * decay + alvo * (1 - decay);         // release: ~370ms
```

**Per second, not per frame.** The obvious version asks how far the page moved
since the previous frame and calls 60px a full-strength scroll. That silently
ties the effect to the monitor — the same physical flick, measured:

| refresh rate | busiest frame | velocity |
|---|---|---|
| 60 Hz | 33px | 1.00 |
| 71 Hz | 27px | 0.90 |
| 102 Hz | 20px | 0.66 |
| 144 Hz | 14px | **0.48** |

Half the effect on a better screen, for an identical gesture. Dividing by
elapsed time gives 1.00 on all four, and the decay is corrected the same way so
the settle feels identical at any rate. The `dt` is clamped at 100ms so a
stalled frame is not read as a violent flick on the frame after it.

This was symmetric at first — `v = v*0.86 + delta*0.14` — and that one line made
the whole library look broken on a mouse.

A symmetric filter of that shape is a low-pass filter. A wheel notch is an
impulse: Chrome moves about 100px in a single frame and then nothing. Removing
impulses is precisely what a low-pass filter is for, so one notch only ever
reached `v ≈ 0.23` — about ten pixels of warp on a 1024px image. One percent.
Nobody could see it, and the demo looked like it did nothing at all.

It survived because it was only ever checked on a trackpad, where scrolling is
continuous and the filter behaves perfectly. The input it was tuned for was the
input that hid the defect.

Rising instantly to the peak and decaying from there leaves the trackpad case
where it was (0.49 → 0.50) and gives four times the response to a wheel
(0.23 → 1.00). The release still supplies the weight; zeroing on stop makes the
effect snap off, which reads as a bug of its own.

`test/velocity.test.js` now asserts a wheel notch moves the image at least 30px,
because no correctness test can tell "running" apart from "running and
invisible" — only a number with a floor under it can.

The corollary matters more than either: because the velocity-driven effects
scale by `abs(velocity)`, a still page is a still image. The GPU work goes to
approximately nothing when the user isn't doing anything, which is when most
scroll libraries are still burning battery.

---

## The prelude

Every effect is compiled against a shared prelude that declares the uniform
block, the sampler, the texture and the vertex stage. Effects may not declare
their own bindings, and there is a test that fails if one tries:

```js
assert.doesNotMatch(e.wgsl, /@group\s*\(/,
  `${name}: bindings come from the prelude in stage.js, not from the effect`);
```

That is not style policing. The pipeline cache keys on the effect name and
assumes a single bind group layout across all of them; an effect with its own
`@group(0) @binding(0)` would compile cleanly and then collide at runtime, in a
way that is very hard to read back from a corrupted frame. Better to fail in
the test suite, where the message can say why.

---

## Behaviour under absence

| condition | what happens |
|---|---|
| no WebGPU | `init()` resolves `false`, nothing is created, images stay |
| no adapter | same, `stage.failed === 'no-adapter'` |
| no canvas context | canvas is removed again, images stay |
| device lost mid-session | elements restored, canvas removed, `ready` flips false |
| image fails to decode | that element is skipped, the others still run |
| `decode()` never settles | given up on after 250ms — see below |
| `prefers-reduced-motion` | returns an inert handle, nothing is touched |
| framebudget says `minimal` | elements restored, canvas cleared, loop keeps watching |
| tab goes to the background | elements restored — Chrome suspends rAF entirely |
| tab comes back | elements hidden again, drawing resumes |
| unknown effect name | throws `RangeError` — a typo is a bug, not a degradation |

The last row is the one asymmetry, and it's on purpose. Missing hardware is a
fact about the visitor; `effect: 'displac'` is a fact about your code, and it
should fail on every machine rather than only on the ones without a GPU. It
throws at the call site, before any async work, and the message names the
effects that do exist. TypeScript consumers get it earlier still:

```
Type '"displac"' is not assignable to type '"displace" | "reveal" | "rgb"'.
Did you mean '"displace"'?
```

---

## API

```ts
glaze(target, options?) => { destroy(): void, elements: Layer[], active: boolean }
```

| option | default | |
|---|---|---|
| `effect` | `'displace'` | `'displace' \| 'reveal' \| 'rgb'`, or a key you added to `EFFECTS` |
| `strength` | per effect | `0..1` |
| `budget` | `null` | a framebudget instance |
| `respectReducedMotion` | `true` | set `false` only if the effect is the content |

Also exported: `EFFECTS`, `Stage`, `Layer`, `destroyAll()`.

---

## Tests

```bash
npm test          # 83 tests, no browser, no GPU
open test/visual.html   # the part Node cannot check: is anything visible?
npm run check     # types + tests
```

Node has no GPU and no WebGPU, which is the harshest environment this library
will ever meet — so the tests run there deliberately.

| file | what it holds down |
|---|---|
| `layer.test.js` | the ordering guarantee: a recording fake device asserts `upload` happens before `hide` |
| `velocity.test.js` | wheel and smooth-scrolled notches must both produce visible displacement |
| `visual.html` | renders each effect in a real browser and measures how much it changed the pixels |
| `arranque.test.js` | concurrent `init()` calls share one device and one canvas |
| `suspender.test.js` | every path that stops drawing restores the elements first |
| `dom.test.js` | the same promise in real jsdom, which also has no `matchMedia` and no `IntersectionObserver` |
| `registry.test.js` | clip-space arithmetic, height-independent progress, zero layout reads on a still page |
| `effects.test.js` | the structural rules the shared pipeline layout depends on |
| `degradation.test.js` | every row of the absence table above |

Each guard was checked by breaking it on purpose: hiding the element before the
upload, swapping `visibility` for `display`, giving an effect its own
`@group(0)`, deleting the dirty-flag early return, making `init()` throw instead
of returning `false`, restoring the low-pass velocity filter, and putting
`scale` back in `defaults` without wiring it, removing the re-entrancy guard
from `init()`, putting the render-nothing branch back in the `minimal` tier, and
awaiting `decode()` directly again. All ten were caught, by the test that names
the problem.

What none of them can cover is whether the shaders look right. That is what
`demo/` is for, and there is no substitute for opening it.

---

## Browser support

WebGPU: Chrome/Edge 113+ (121+ on Android), Safari 26.0+ on macOS Tahoe 26 /
iOS 26 / iPadOS 26, Firefox 141+ on Windows and 145+ on Apple Silicon.
Everywhere else the page renders as an ordinary page, which is the point.

## Licence

MIT © Rodrigo Figueiredo
