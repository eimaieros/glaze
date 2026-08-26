# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] — 2026-08-26

First public version.

### Added

- `glaze(target, options)` — one function. A selector, an element, or any
  iterable of elements.
- Three effects: `displace` (velocity-driven liquid warp), `reveal`
  (progress-driven torn mask), `rgb` (velocity-driven chromatic split).
- `EFFECTS` is open: a new effect is one WGSL `fn fs` plus its defaults.
- `velocity` option, for pages driven by Lenis, GSAP ScrollSmoother or any
  scroller that transforms the page instead of scrolling it.
- `budget` option, for degrading under load with
  [framebudget](https://github.com/eimaieros/framebudget).
- TypeScript declarations generated from JSDoc and verified against a
  consumer project.
- `test/visual.html` — renders each effect in a real browser and measures
  whether it is actually visible.

### The six bugs found after it first "worked"

Kept here because they are the reason several of the design decisions look the
way they do, and because every one of them passed the whole test suite.

- **Three GPU devices instead of one.** `init()` had no re-entrancy guard, so
  three concurrent `glaze()` calls each built their own device and canvas. The
  layers ended up holding textures from one device while `render()` used
  another — a WebGPU validation error, delivered asynchronously, so nothing
  threw and nothing drew.
- **The canvas holds its content for exactly one frame.** Measured: 5898
  painted samples immediately after `render()`, zero fifty milliseconds later.
  Every path that stops drawing now restores the real `<img>` elements first —
  including `framebudget`'s `minimal` tier, which previously cleared the canvas
  and left the page with holes on precisely the devices least able to cope.
- **`decode()` never settles in a background tab.** Not resolved, not rejected.
  A page opened in a background tab created no layers at all, for the rest of
  its life. It is raced against a 250ms deadline now; `try/catch` cannot help
  with a promise that never settles.
- **Scroll velocity was normalised per frame.** The same physical gesture read
  1.00 at 60Hz and 0.48 at 144Hz. It is pixels per second now, and the decay is
  frame-rate corrected to match.
- **The velocity filter was a low-pass filter.** A wheel notch is an impulse,
  and removing impulses is what a low-pass filter does — one notch reached
  v≈0.23, about ten pixels of warp. Fast attack, slow release now.
- **`scale` was advertised and ignored.** It sat in the effect's defaults while
  the shader hard-coded the value. There is now a test that fails on any option
  not wired to something, and a second one for the same lie in the type layer.

### And twice the code was right

- The demo's own stylesheet set `scroll-behavior: smooth`, which spreads a
  wheel notch over 300ms and quartered the velocity the shaders received.
- The demo's own imagery was a soft gradient. Displacing pixels inside a smooth
  gradient returns the same smooth gradient: measured 6.6 out of 765, against
  67 on the same shader over dense line work.

[Unreleased]: https://github.com/eimaieros/glaze/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/eimaieros/glaze/releases/tag/v0.1.0
