/**
 * `docs/technical/mc-merge.md` is the close-out doc for the landing verb: it
 * exists so somebody who has never opened `docs-merge.js` can say what each
 * form does, what the docs form refuses and what it never touches. That only
 * holds while the numbers and names in the prose are the ones in the code.
 *
 * So the doc is pinned, the same way `tests/mc/helper-doc.test.js` pins the
 * helper's note and `tests/mc/run-doc.test.js` the runner's: every constant
 * it states is read back out of the prose and compared with the export it
 * claims to describe.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { DOCS_PREFIX, MERGEABILITY_TRIES, MERGEABILITY_WAIT_MS, runDocsMerge } from '../../src/mc/docs-merge.js';

const DOC = readFileSync(fileURLToPath(new URL('../../docs/technical/mc-merge.md', import.meta.url)), 'utf8');

const WORDS = { twelve: 12, five: 5 };

describe('docs/technical/mc-merge.md says what the code does', () => {
  it('states the mergeability wait the code waits', () => {
    const match = /(\w+) (\w+)-second turns/u.exec(DOC);
    assert.ok(match, 'the doc no longer states the mergeability wait');
    assert.equal(WORDS[match[1]], MERGEABILITY_TRIES);
    assert.equal(WORDS[match[2]] * 1000, MERGEABILITY_WAIT_MS);
    // And the ~60 s the same sentence promises the reader.
    assert.equal((MERGEABILITY_TRIES * MERGEABILITY_WAIT_MS) / 1000, 60);
  });

  it('states the prefix the docs form refuses outside of', () => {
    assert.match(DOC, /every file is under `docs\/`/u);
    assert.equal(DOCS_PREFIX, 'docs/');
  });

  it('states the round-log mode a docs round is written under', async () => {
    const gh = (args) => {
      if (args[1] === 'view' && args.at(-1).includes('files')) {
        return { ok: true, stdout: JSON.stringify({ number: 7, title: 'Plan: x', state: 'OPEN', isDraft: false, baseRefName: 'main', files: [{ path: 'docs/project/x/PLAN.md' }] }), stderr: '' };
      }
      if (args[1] === 'view' && args.at(-1) === 'mergeable') return { ok: true, stdout: '{"mergeable":"MERGEABLE"}', stderr: '' };
      if (args[1] === 'view') return { ok: true, stdout: '{"state":"MERGED","mergeCommit":{"oid":"abc1234"}}', stderr: '' };
      return { ok: true, stdout: '', stderr: '' };
    };
    const report = await runDocsMerge({ repoPath: '/tmp/repo', pr: 7, gh });
    assert.equal(report.ok, true);
    assert.match(DOC, new RegExp(`\`mode: ${report.mode}\``, 'u'));
  });

  it('names the source files it points the reader at', () => {
    for (const path of ['src/mc/docs-merge.js', 'src/mc/repo-merge.js', 'src/mc/repo-gate.js', 'src/mc/repo-round-log.js', 'src/mc/commands/merge.js']) {
      assert.match(DOC, new RegExp(path.replaceAll('/', '\\/'), 'u'), `the doc no longer points at ${path}`);
    }
  });
});
