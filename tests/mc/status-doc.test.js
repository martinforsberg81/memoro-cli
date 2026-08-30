/**
 * `docs/technical/mc-status.md` is `mc status <name>` written down: what it
 * prints, which file every fact comes from, and what the status board that
 * `mc status` used to print was before it went.
 *
 * A close-out note about a *retired* mechanism rots in a particular way: it
 * keeps naming files and verbs that have since been deleted, and nothing
 * fails. So the doc is pinned the way `run-doc` and `helper-doc` pin theirs —
 * every constant it states is read back out of the export it describes, and
 * every path it names must still be on disk.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { PRICES_DATED, estimateCost } from '../../src/mc/prices.js';
import { RUNNER_MODEL } from '../../src/mc/status-collect.js';
import { runMcCli } from './_helpers/mc-cli.js';

const root = new URL('../../', import.meta.url);
const DOC = readFileSync(fileURLToPath(new URL('docs/technical/mc-status.md', root)), 'utf8');

describe('docs/technical/mc-status.md says what mc status reads', () => {
  it('states the date the price table is published for', () => {
    assert.match(DOC, new RegExp(`PRICES_DATED = '${PRICES_DATED}'`, 'u'));
  });

  it('states the multipliers the estimate actually uses', () => {
    // A million cache-read tokens on the runner's model, priced two ways.
    const read = estimateCost({ cacheRead: 1e6 }, RUNNER_MODEL);
    const write = estimateCost({ cacheWrite: 1e6 }, RUNNER_MODEL);
    const input = estimateCost({ input: 1e6 }, RUNNER_MODEL);
    assert.equal(read / input, 0.1);
    assert.equal(write / input, 1.25);
    assert.match(DOC, /cache writes at 1\.25× input and cache reads at 0\.1× input/u);
  });

  it('names the model every runs.tsv row is priced as', () => {
    assert.match(DOC, new RegExp(`the runner's\\s+model, \`${RUNNER_MODEL}\``, 'u'));
  });

  it('names only files that exist', () => {
    const paths = new Set();
    for (const [, path] of DOC.matchAll(/`((?:src|tests|docs)\/[\w./<>-]+\.(?:js|md))`/gu)) {
      if (!path.includes('<')) paths.add(path);
    }
    assert.ok(paths.size >= 8, `the doc names too few files to be pinning anything: ${paths.size}`);
    for (const path of paths) {
      assert.ok(existsSync(fileURLToPath(new URL(path, root))), `the doc names ${path}, which is gone`);
    }
  });

  it('resolves the documents it links to', () => {
    const here = new URL('docs/technical/', root);
    for (const [, target] of DOC.matchAll(/\]\((?!https?:)([^)#]+)\)/gu)) {
      assert.ok(existsSync(fileURLToPath(new URL(target, here))), `broken link: ${target}`);
    }
  });

  it('quotes the sentence the bare verb actually prints', () => {
    // The doc names `mc --watch` and `--sessions` — it has to, that is what
    // the old board was — so the guard cannot be "never say the word". It is
    // this instead: the block the doc shows a reader is the block the verb
    // writes, and `tests/mc/status-project.test.js` runs every `mc …` in it.
    const quoted = /```\n(mc: mc status is now mc[\s\S]*?)```/u.exec(DOC);
    assert.ok(quoted, 'the doc no longer quotes what bare `mc status` says');
    const bare = runMcCli(['status'], {});
    assert.equal(bare.status, 2);
    assert.equal(quoted[1].trimEnd(), bare.stderr.trimEnd());
  });
});
