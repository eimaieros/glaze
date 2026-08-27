# Contributing

Issues and pull requests are welcome. This is a small library maintained by one
person, so a short issue describing what you saw is worth more than a long one
speculating about why.

## Running it

```bash
npm install
npm test          # 86 tests, no browser and no GPU needed
npm run check     # types as well
```

Then open `demo/index.html` and `test/visual.html` through any static server —
they load ES modules, so `file://` will not work.

```bash
python3 -m http.server 5500
# → http://localhost:5500/demo/
# → http://localhost:5500/test/visual.html
```

## The one thing to know before changing a shader

**Node cannot run WebGPU.** The test suite can prove the library is correct; it
cannot prove anything is visible. Six separate times this library was reported
as doing nothing while every test passed — twice the code was right and the
demo's own imagery or stylesheet was hiding it.

So `test/visual.html` exists. It renders each effect in a real browser and
measures how much the pixels actually changed, with a floor under each number.
Run it after touching `src/effects.js` or the demo, and read the verdict.

Two measurements, because one was not enough:

- **pixel difference** — how much the image changed
- **hue shift** — how much its *colour* changed

The second was added after the first reported 54 out of 765 on an effect nobody
could see: the image was two shades of red, so the channels moved brightness
around without moving colour. If you add a metric, make sure it disagrees with
the code when the eye disagrees with the code.

## What a good pull request looks like

- Tests that fail before the change and pass after it.
- If it changes what something looks like, a number from `test/visual.html`.
- Comments that say *why*, not *what*. The source is full of these; they are
  the record of what went wrong, and they are worth more than the code.

## Conduct

Be decent. Assume the other person is doing their best with what they know.
Anything that would be unwelcome in a shared office is unwelcome here — mail
eimaieros@gmail.com if something needs handling privately.
