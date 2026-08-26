/**
 * `mc merge <repo> <pr> --docs` — landing a documentation-only pull request
 * on a stubbed gh: docs-only merges; one file outside docs/ refuses with its
 * name; a draft refuses; a batch or --check with --docs is refused before
 * gh is asked; the old spelling points at the new verb.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { docsMergeLines, firstNonDoc, runDocsMerge } from '../../src/mc/docs-merge.js';
import { run } from '../../src/mc/commands/merge.js';
import { runMcCli } from './_helpers/mc-cli.js';

function stubGh({ files, state = 'OPEN', isDraft = false, mergeable = 'MERGEABLE', unknownFirst = 0 }) {
  const calls = [];
  let asked = 0;
  let merged = false;
  const gh = (args) => {
    calls.push(args);
    const json = (o) => ({ ok: true, stdout: JSON.stringify(o), stderr: '' });
    if (args[0] === 'pr' && args[1] === 'view') {
      const fields = args[4];
      if (fields === 'mergeable') { asked += 1; return json({ mergeable: asked <= unknownFirst ? 'UNKNOWN' : mergeable }); }
      if (fields === 'state,mergeCommit') return json({ state: merged ? 'MERGED' : 'OPEN', mergeCommit: merged ? { oid: 'abc1234def' } : null });
      return json({ number: 12, title: 'Plan: gate-word', state, isDraft, baseRefName: 'main', files: files.map((path) => ({ path })) });
    }
    if (args[0] === 'pr' && args[1] === 'merge') { merged = true; return { ok: true, stdout: '', stderr: '' }; }
    return { ok: false, stdout: '', stderr: 'unexpected' };
  };
  return { gh, calls };
}

const opts = (gh) => ({ repoPath: '/repo', pr: 12, gh, sleep: async () => {}, now: () => new Date('2026-08-26T06:00:00Z') });

describe('runDocsMerge', () => {
  it('lands a docs-only pull request with the squash subject and reads the commit back', async () => {
    const { gh, calls } = stubGh({ files: ['docs/project/mc/gate-word/PLAN.md', 'docs/project/mc/mc.md'], unknownFirst: 1 });
    const report = await runDocsMerge(opts(gh));
    assert.equal(report.ok, true);
    assert.equal(report.merged, true);
    assert.equal(report.merge_commit, 'abc1234def');
    assert.deepEqual(calls.find((c) => c[1] === 'merge'), ['pr', 'merge', '12', '--squash', '--subject', 'Plan: gate-word (#12)']);
    assert.match(docsMergeLines(report)[0], /^mc: merged #12 into main as abc1234 \(squash, docs only: 2 files under docs\/\)$/u);
  });

  it('refuses one file outside docs/, by name, before touching merge', async () => {
    const { gh, calls } = stubGh({ files: ['docs/project/x/PLAN.md', 'src/mc/paths.js'] });
    const report = await runDocsMerge(opts(gh));
    assert.equal(report.ok, false);
    assert.equal(report.stopped_at, 'not-docs');
    assert.match(report.reason, /touches src\/mc\/paths\.js — outside docs\//u);
    assert.ok(!calls.some((c) => c[1] === 'merge'));
    assert.equal(firstNonDoc(['docs/a.md']), null);
  });

  it('refuses a draft, a closed one, and a conflicting one', async () => {
    assert.equal((await runDocsMerge(opts(stubGh({ files: ['docs/a.md'], isDraft: true }).gh))).stopped_at, 'draft');
    assert.equal((await runDocsMerge(opts(stubGh({ files: ['docs/a.md'], state: 'MERGED' }).gh))).stopped_at, 'state');
    assert.equal((await runDocsMerge(opts(stubGh({ files: ['docs/a.md'], mergeable: 'CONFLICTING' }).gh))).stopped_at, 'conflicting');
  });
});

describe('mc merge --docs, the verb', () => {
  it('refuses a batch and --check with --docs before asking gh', async () => {
    let err = '';
    const stderr = { write: (s) => { err += s; } };
    assert.equal(await run(['repo', '1', '2', '--docs'], { stderr, stdout: stderr }), 2);
    assert.match(err, /one pull request at a time/u);
    assert.equal(await run(['repo', '1', '--docs', '--check'], { stderr, stdout: stderr }), 2);
    assert.match(err, /nothing to check/u);
  });

  it('runs the docs round on the resolved repository and prints the line', async () => {
    let out = '';
    const stdout = { write: (s) => { out += s; } };
    const { gh } = stubGh({ files: ['docs/a.md'] });
    const code = await run(['memoro', '#12', '--docs'], {
      stdout, stderr: stdout, gh, resolveRepoPath: async (name) => (name === 'memoro' ? '/repo' : null),
    });
    assert.equal(code, 0);
    assert.match(out, /merged #12 into main/u);
  });

  it('mc repo merge only points at mc merge now', () => {
    const r = runMcCli(['repo', 'merge', 'x', '1']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /mc repo merge is now mc merge/u);
    assert.match(runMcCli(['--help']).stdout, /mc merge <repo> <pr> --docs/u);
    assert.doesNotMatch(runMcCli(['--help']).stdout, /mc repo merge/u);
  });
});
