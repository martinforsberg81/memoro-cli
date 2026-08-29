/**
 * `docs/technical/mc-run.md` is the lanes written down: it exists so somebody
 * who has never read run.js can say what a lane owns, what it writes and what
 * the two lanes share. That only holds while the numbers in it are the numbers
 * in the code, and a doc that names a default goes stale silently.
 *
 * So the doc is pinned, the same way `tests/mc/helper-doc.test.js` pins the
 * helper's note: every constant the prose states is read back out of it and
 * compared with the export it claims to describe.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { REPO_NAMES } from '../../src/mc/run.js';
import { DEFAULT_BUDGET_MINUTES, QUOTA_SLEEP_MS } from '../../src/mc/run-plan.js';

const DOC = readFileSync(fileURLToPath(new URL('../../docs/technical/mc-run.md', import.meta.url)), 'utf8');

describe('docs/technical/mc-run.md says what the runner does', () => {
  it('states the shared quota sleep the code sleeps', () => {
    const match = /every lane sleeping (\d+)m/u.exec(DOC);
    assert.ok(match, 'the doc no longer states the quota sleep');
    assert.equal(Number(match[1]) * 60_000, QUOTA_SLEEP_MS);
  });

  it('states the default budget a lane would have blocked on', () => {
    assert.equal(DEFAULT_BUDGET_MINUTES, 90, 'the doc says "ninety minutes, by default"');
    assert.match(DOC, /ninety minutes, by default/u);
  });

  it('names the two repositories that are the two lanes', () => {
    assert.equal(REPO_NAMES.length, 2, 'a third repository needs a line in the doc too');
    for (const repo of REPO_NAMES) assert.ok(DOC.includes(repo), `the doc does not name ${repo}`);
  });

  it('names the files a lane writes, and the one the runner writes once', () => {
    assert.match(DOC, /`~\/mc\/runner\/current-<repo>\.json`/u);
    assert.match(DOC, /`~\/mc\/runner\/runner\.json` stays one/u);
    assert.match(DOC, /`~\/mc\/runner\/STOP`/u);
  });
});
