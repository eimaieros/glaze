#!/usr/bin/env node
/**
 * Count the tests, and hold the docs to what they say.
 *
 * WHY THIS EXISTS.
 *
 * tools/tamanho.js was written because the README stated a bundle size that
 * nobody was re-measuring, and it drifted. The test count is the same claim in
 * a different unit, and it drifted the same way: README said 86 while
 * CONTRIBUTING said 83, in the same repository, on the same commit.
 *
 * Neither number was a lie when it was typed. That is the point. A number in
 * prose is a measurement with no instrument behind it, and the fix is not to
 * correct it once — it is to make the next drift impossible to commit.
 *
 *   npm run contagem                    run the suite and check the docs
 *   node tools/contagem.js saida.tap    check against a run that already
 *                                       happened (what CI does — no reason to
 *                                       execute the suite twice)
 *   node tools/contagem.js --fix        rewrite the docs with the real number
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Every place the repository states a test count, and how it writes it. */
const ALEGACOES = [
  { ficheiro: 'README.md', padrao: /(\d+) tests, no browser, no GPU/ },
  { ficheiro: 'CONTRIBUTING.md', padrao: /(\d+) tests, no browser and no GPU/ },
];

const argumentos = process.argv.slice(2);
const corrigir = argumentos.includes('--fix');
const ficheiroTap = argumentos.find((a) => !a.startsWith('--'));

/**
 * The number of passing tests, from whatever `node --test` printed.
 *
 * TWO FORMATS, AND THE REASON IS A BUG THIS CAUGHT.
 *
 *   TAP reporter    # pass 37
 *   spec reporter   ℹ pass 37
 *
 * The first version of this only knew the TAP form, because the CI step asked
 * for TAP. It went red on Node 24 and green on Node 22, off the same commit.
 *
 * The cause: `npm test -- --test-reporter=tap` puts the flag AFTER the file
 * arguments, and Node 24 ignores a node option in that position where Node 22
 * honoured it. So Node 24 was quietly running the spec reporter while the
 * workflow step was called "Tests, with the TAP kept".
 *
 * The step now passes the flag before the files, which fixes the cause. This
 * reads both anyway: counting tests should not depend on which reporter ran.
 */
function contar(saida) {
  const passou = saida.match(/^(?:#|ℹ)\s*pass (\d+)$/m);
  if (!passou) {
    console.error('contagem: nao encontrei "pass N" na saida dos testes.');
    console.error('        Ultimas linhas:');
    console.error(saida.trimEnd().split('\n').slice(-6).map((l) => '        ' + l).join('\n'));
    process.exit(1);
  }
  const falhados = saida.match(/^(?:#|ℹ)\s*fail (\d+)$/m);
  if (falhados && Number(falhados[1]) > 0) {
    console.error(`contagem: ${falhados[1]} testes a falhar — corrige isso primeiro.`);
    process.exit(1);
  }
  return Number(passou[1]);
}

/** Run the suite and return its TAP. spawnSync, not execFileSync, because a
 *  failing suite is a case this script reports on — not an exception to throw
 *  a stack trace about over the message explaining what went wrong. */
function correr() {
  // The shell expands `test/*.test.js` in package.json; here there is no shell,
  // and passing the bare directory is not the same thing on every Node version.
  const ficheiros = readdirSync(join(raiz, 'test'))
    .filter((f) => f.endsWith('.test.js'))
    .map((f) => join('test', f))
    .sort();
  if (!ficheiros.length) {
    console.error('contagem: nao ha ficheiros de teste em test/.');
    process.exit(1);
  }
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...ficheiros], {
    cwd: raiz,
    encoding: 'utf8',
  });
  return r.stdout || '';
}

const tap = ficheiroTap ? readFileSync(ficheiroTap, 'utf8') : correr();

const real = contar(tap);

let errado = 0;
for (const { ficheiro, padrao } of ALEGACOES) {
  const caminho = join(raiz, ficheiro);
  if (!existsSync(caminho)) continue;

  const texto = readFileSync(caminho, 'utf8');
  const m = texto.match(padrao);
  if (!m) {
    console.error(`contagem: ${ficheiro} deixou de dizer quantos testes ha (${padrao}).`);
    errado++;
    continue;
  }

  const dito = Number(m[1]);
  if (dito === real) continue;

  if (corrigir) {
    writeFileSync(caminho, texto.replace(padrao, (s) => s.replace(String(dito), String(real))));
    console.log(`contagem: ${ficheiro} ${dito} -> ${real}`);
  } else {
    console.error(`contagem: ${ficheiro} diz ${dito} testes; sao ${real}.`);
    errado++;
  }
}

if (errado) {
  console.error('        Corrige com:  node tools/contagem.js --fix');
  process.exit(1);
}
if (!corrigir) console.log(`contagem: ${real} testes — bate certo com a documentacao`);
