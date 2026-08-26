#!/usr/bin/env node
/**
 * Measure the bundle, and hold the README to what it says.
 *
 * WHY THIS EXISTS.
 *
 * The README carried a minified size in two places — a badge and a sentence.
 * Both were true when they were written. Then a module was added, and both
 * quietly became false.
 *
 * Nobody lied and nobody noticed, which is the whole problem with a number
 * typed into prose: it is a measurement with no instrument behind it, and it
 * starts decaying the moment it is written. The same failure, on a bigger
 * number, is how this project spent months claiming a Lighthouse score it did
 * not have.
 *
 * This is the instrument. It bundles what a consumer actually gets, measures
 * it, and fails if the README disagrees. The tolerance is deliberately tight:
 * a claim allowed to be a kilobyte wrong is not a claim.
 *
 *   npm run size          check
 *   node tools/tamanho.js --fix    rewrite the README with the real numbers
 */

import { build } from 'esbuild';
import { gzipSync } from 'node:zlib';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const README = join(raiz, 'README.md');

/** Kilobytes to one decimal, the way the README writes them. */
const kb = (bytes) => Math.round((bytes / 1024) * 10) / 10;

async function medir() {
  // bundle:true, because the number that matters is what a consumer ships,
  // not the size of one file out of seven. write:false keeps it in memory, so
  // a failed run cannot leave a stray artefact behind in the repository.
  const out = await build({
    entryPoints: [join(raiz, 'src', 'index.js')],
    bundle: true,
    minify: true,
    format: 'esm',
    write: false,
    logLevel: 'silent',
  });
  const bytes = out.outputFiles[0].contents;
  return { min: kb(bytes.length), gzip: kb(gzipSync(bytes, { level: 9 }).length) };
}

const PADRAO = /(\d+\.\d+) KB minified, (\d+\.\d+) KB gzipped/;

const real = await medir();
const readme = readFileSync(README, 'utf8');
const m = readme.match(PADRAO);

if (!m) {
  console.error('tamanho: nao encontrei "X KB minified, Y KB gzipped" no README.');
  process.exit(1);
}
const dito = { min: Number(m[1]), gzip: Number(m[2]) };

if (process.argv.includes('--fix')) {
  const novo = readme
    .replaceAll(`${dito.min} KB minified`, `${real.min} KB minified`)
    .replaceAll(`minified-${dito.min}%20KB`, `minified-${real.min}%20KB`)
    .replace(PADRAO, `${real.min} KB minified, ${real.gzip} KB gzipped`);
  writeFileSync(README, novo);
  console.log(`tamanho: README posto a ${real.min} KB / ${real.gzip} KB gzip`);
  process.exit(0);
}

// 0.2 KB is about two hundred bytes: enough to absorb a different esbuild
// patch release, not enough to hide a new module.
const TOL = 0.2;
if (Math.abs(real.min - dito.min) > TOL || Math.abs(real.gzip - dito.gzip) > TOL) {
  console.error(
    `tamanho: o README diz ${dito.min} KB / ${dito.gzip} KB gzip; ` +
    `a medicao diz ${real.min} KB / ${real.gzip} KB gzip.\n` +
    '        Corrige com:  node tools/tamanho.js --fix'
  );
  process.exit(1);
}
console.log(`tamanho: ${real.min} KB minificado, ${real.gzip} KB gzip — bate certo com o README`);
