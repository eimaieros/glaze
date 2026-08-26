# Security

## Reporting

Email **eimaieros@gmail.com**, or open a
[private advisory](https://github.com/eimaieros/glaze/security/advisories/new).
I will reply within a week. If you have not heard back in two, assume the mail
went astray and open a normal issue saying only that you are waiting.

## What this library touches

Worth knowing before you look, because it narrows the surface a lot:

- **No network.** It makes no requests of any kind.
- **No storage.** No cookies, no `localStorage`, no `IndexedDB`.
- **No dependencies at runtime.** Nothing to inherit a vulnerability from. The
  only devDependencies are TypeScript and jsdom, and neither ships.
- **No `eval`, no `Function`, no `innerHTML`.** Nothing is constructed from a
  string and executed.

It does two things that are worth a second look:

1. **It compiles WGSL you can supply.** `EFFECTS.name = { wgsl }` is a
   documented extension point, and the string goes to
   `device.createShaderModule`. Shader source is not JavaScript and cannot
   reach the page, but a shader you did not write is still code you did not
   write — treat it the way you would treat any third-party snippet.

2. **It reads your images into GPU textures** via `createImageBitmap`, which is
   subject to the usual CORS rules. A cross-origin image without permissive
   headers will make it throw, and glaze degrades to leaving that element
   alone. It never bypasses that check.

## Supported versions

The `main` branch. There is no release train to backport to yet, so a fix goes
out as a new commit and, when there is one, a new tag.
