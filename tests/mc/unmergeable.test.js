/**
 * `~/mc/runner/unmergeable.json` — the rules, over the entries and nothing
 * else.
 *
 * The round's own use of them is in `tests/mc/run.test.js`, where a round that
 * cannot take main writes the file and a round that can drops it. These are
 * the edges: a file somebody hand-edited, two repositories with a workarea of
 * the same name, and the sentence a person reads.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  clearUnmergeable, describeUnmergeable, markUnmergeable, parseUnmergeable,
  unmergeableEntries, unmergeableFor,
} from '../../src/mc/unmergeable.js';

const entry = (over = {}) => ({
  project: 'docx-editor',
  repo: 'memoro',
  worktree: '/Users/x/mc/docx-editor/memoro',
  files: ['docs/technical/docx-editing-surface.md'],
  why: 'the PLAN.json is one of the conflicts and nothing could be handed the merge',
  since: '2026-09-05T04:00:53Z',
  ...over,
});

test('an unreadable or missing file is no entries, never a crash', () => {
  assert.deepEqual(parseUnmergeable(null), []);
  assert.deepEqual(parseUnmergeable('{'), []);
  assert.deepEqual(parseUnmergeable('{"project": "a"}'), [], 'an object is not a list of entries');
  assert.deepEqual(unmergeableEntries([{ repo: 'memoro' }, null, 'x']), [], 'an entry naming no project is not one');
});

test('an entry keeps the shape the reading expects, whatever the file says', () => {
  const [read] = unmergeableEntries([{ project: 'alpha', files: 'src/a.js' }]);
  assert.deepEqual(read, {
    project: 'alpha', repo: null, worktree: null, files: [],
    why: 'no session to hand the merge to', since: null,
  });
});

test('marking the same workarea again keeps the first round`s since, and takes this round`s files', () => {
  const first = markUnmergeable([], entry());
  const again = markUnmergeable(first, entry({
    files: ['docs/technical/docx-editing-surface.md', 'src/a.js'],
    since: '2026-09-05T06:25:55Z',
  }));
  assert.equal(again.length, 1);
  assert.equal(again[0].since, '2026-09-05T04:00:53Z', 'how long it has stood still is not this round`s fact');
  assert.deepEqual(again[0].files, ['docs/technical/docx-editing-surface.md', 'src/a.js'], 'but what it conflicts on is');
});

test('a workarea is a project in a repository, not a name', () => {
  const both = markUnmergeable(markUnmergeable([], entry()), entry({ repo: 'memoro-cli', worktree: '/Users/x/mc/docx-editor/memoro-cli' }));
  assert.equal(both.length, 2, 'one project can have a workarea in each repository');
  assert.equal(unmergeableFor(both, { project: 'docx-editor', repo: 'memoro-cli' }).worktree, '/Users/x/mc/docx-editor/memoro-cli');
  assert.equal(unmergeableFor(both, { project: 'docx-editor', repo: 'memoro' }).worktree, '/Users/x/mc/docx-editor/memoro');
  assert.equal(unmergeableFor(both, { project: 'other', repo: 'memoro' }), null);

  const left = clearUnmergeable(both, { project: 'docx-editor', repo: 'memoro' });
  assert.deepEqual(left.map((item) => item.repo), ['memoro-cli']);
  assert.deepEqual(clearUnmergeable(both, { project: 'nobody', repo: 'memoro' }), both, 'clearing what is not there changes nothing');
});

test('the sentence names the workarea and the files, three of them and a count', () => {
  assert.equal(
    describeUnmergeable(entry()),
    'origin/main could not be merged into /Users/x/mc/docx-editor/memoro: docs/technical/docx-editing-surface.md',
  );
  assert.match(
    describeUnmergeable(entry({ files: ['a.md', 'b.md', 'c.md', 'd.md', 'e.md'] })),
    /: a\.md, b\.md, c\.md \+2$/u,
  );
  // The brief clips this from the middle at 110 characters, so the files have
  // to be inside it: with the reason on the end they were what the clip ate.
  assert.ok(describeUnmergeable(entry()).length <= 110);
});
