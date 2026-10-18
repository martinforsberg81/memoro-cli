/**
 * `mc merge <repo> <pr> --docs` — landing a documentation-only pull request
 * on a stubbed gh: docs-only merges; one file outside docs/ refuses with its
 * name; a script under docs/ refuses with its name; a draft refuses; a batch or --check with --docs is refused before
 * gh is asked; the old spelling points at the new verb.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { docsMergeLines, firstNonDoc, firstScript, runDocsMerge } from '../../src/mc/docs-merge.js';
import { run } from '../../src/mc/commands/merge.js';
import { registerPath } from '../../src/mc/register.js';
import { runMcCli } from './_helpers/mc-cli.js';

function stubGh({ files, state = 'OPEN', isDraft = false, mergeable = 'MERGEABLE', unknownFirst = 0, head = 'aaaa111', headAfter = head, branch = 'plan/mc', body = '' }) {
  const calls = [];
  let asked = 0;
  let merged = false;
  const gh = (args) => {
    calls.push(args);
    const json = (o) => ({ ok: true, stdout: JSON.stringify(o), stderr: '' });
    if (args[0] === 'pr' && args[1] === 'view') {
      const fields = args[4];
      if (fields === 'mergeable') { asked += 1; return json({ mergeable: asked <= unknownFirst ? 'UNKNOWN' : mergeable }); }
      if (fields === 'headRefOid') return json({ headRefOid: headAfter });
      if (fields === 'state,mergeCommit') return json({ state: merged ? 'MERGED' : 'OPEN', mergeCommit: merged ? { oid: 'abc1234def' } : null });
      return json({ number: 12, title: 'Plan: gate-word', state, isDraft, baseRefName: 'main', headRefName: branch, body, headRefOid: head, files: files.map((path) => ({ path })) });
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
    assert.deepEqual(calls.find((c) => c[1] === 'merge'), ['pr', 'merge', '12', '--squash', '--subject', 'Plan: gate-word (#12)', '--match-head-commit', 'aaaa111']);
    assert.match(docsMergeLines(report)[0], /^mc: merged #12 into main as abc1234 \(squash, docs only: 2 files under docs\/\)$/u);
  });

  it('refuses with drift, and does not merge, when the head moved after its files were checked', async () => {
    const { gh, calls } = stubGh({ files: ['docs/a.md'], headAfter: 'bbbb222' });
    const report = await runDocsMerge(opts(gh));
    assert.equal(report.ok, false);
    assert.equal(report.stopped_at, 'drift');
    assert.match(report.reason, /aaaa111/u);
    assert.match(report.reason, /bbbb222/u);
    assert.ok(!calls.some((c) => c[0] === 'pr' && c[1] === 'merge'));
  });

  it('refuses with read when gh gives no head', async () => {
    const { gh, calls } = stubGh({ files: ['docs/a.md'], head: null });
    const report = await runDocsMerge(opts(gh));
    assert.equal(report.stopped_at, 'read');
    assert.ok(!calls.some((c) => c[0] === 'pr' && c[1] === 'merge'));
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

  it('refuses a script under docs/, by name, pointing at the gate, before touching merge', async () => {
    const { gh, calls } = stubGh({ files: ['docs/project/x/PLAN.json', 'docs/project/x/instruments/probe.mjs'] });
    const report = await runDocsMerge(opts(gh));
    assert.equal(report.ok, false);
    assert.equal(report.merged, false);
    assert.equal(report.stopped_at, 'script');
    assert.match(report.reason, /#12 carries docs\/project\/x\/instruments\/probe\.mjs — a script is not a document; land it through the gate: mc merge <repo> 12$/u);
    assert.deepEqual(docsMergeLines(report), [`mc: NOT merged — ${report.reason}`]);
    assert.ok(!calls.some((c) => c[1] === 'merge'));
    for (const path of ['docs/a.js', 'docs/a.cjs', 'docs/b/a.ts']) assert.equal(firstScript([path]), path);
  });

  it('lands an all-documents pull request of .md and .json under docs/', async () => {
    const { gh, calls } = stubGh({ files: ['docs/project/x/PLAN.json', 'docs/project/x/README.md'] });
    const report = await runDocsMerge(opts(gh));
    assert.equal(report.ok, true);
    assert.equal(report.stopped_at, null);
    assert.ok(calls.some((c) => c[1] === 'merge'));
    assert.equal(firstScript(['docs/a.md', 'docs/b.json']), null);
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

  // msr-core-finish-measure steps 1 and 3 (#13772, #13784, 2026-10-18): the
  // session landed its docs pull request through --docs, the step stayed
  // `running`, and the runner, finding no open pull request on the deleted
  // branch, wrote it `failed`.
  describe('books the landing on the step whose pull request it is', () => {
    function landing({ branch, status = 'running', env = {}, body = '' }) {
      const root = mkdtempSync(join(tmpdir(), 'mc-docs-merge-'));
      mkdirSync(join(root, 'runner', 'projects'), { recursive: true });
      writeFileSync(registerPath(root, 'measure'), JSON.stringify({
        project: 'measure', repo: 'memoro', programme: 'msr-core', plan: 'docs/project/msr-core/measure/PLAN.json',
        steps: [
          { status: 'done', pr: 11, branch: 'measure-2', comments: [], attempts: 0 },
          { status, pr: null, branch: 'measure-3', comments: [], attempts: 0 },
        ],
      }));
      let out = '';
      const stdout = { write: (s) => { out += s; } };
      const { gh } = stubGh({ files: ['docs/project/msr-core/a.md'], branch, body });
      return run(['memoro', '12', '--docs'], {
        stdout, stderr: stdout, gh, root, env, lock: (_root, fn) => fn(),
        resolveRepoPath: async () => '/repo', now: () => new Date('2026-10-18T07:10:28Z'),
      }).then((code) => {
        const step = JSON.parse(readFileSync(registerPath(root, 'measure'), 'utf8')).steps[1];
        rmSync(root, { recursive: true, force: true });
        return { code, out, step };
      });
    }

    it('makes the step on the pull request\'s branch done, with the pull request and the landing', async () => {
      const { code, out, step } = await landing({ branch: 'measure-3' });
      assert.equal(code, 0);
      assert.equal(step.status, 'done');
      assert.equal(step.pr, 12);
      assert.equal(step.landed.sha, 'abc1234def');
      assert.match(out, /measure step 2 is done/u);
    });

    it('finds the step from MC_STEP when the session names it', async () => {
      const { step } = await landing({ branch: 'some-other-name', env: { MC_STEP: 'measure:1' } });
      assert.equal(step.status, 'done');
    });

    it('keeps what the body says it left undone, as the merger does', async () => {
      const { step } = await landing({ branch: 'measure-3', body: '## Remainder\n\nThe phone rows.' });
      assert.match(step.landed.remainder, /phone rows/u);
    });

    it('leaves a step the session has blocked as it is', async () => {
      const { step } = await landing({ branch: 'measure-3', status: 'blocked' });
      assert.equal(step.status, 'blocked');
    });

    it('books nothing for a planning session\'s pull request', async () => {
      const { code, out, step } = await landing({ branch: 'plan/msr-core' });
      assert.equal(code, 0);
      assert.equal(step.status, 'running');
      assert.doesNotMatch(out, /is done/u);
    });
  });

  it('mc repo merge only points at mc merge now', () => {
    const r = runMcCli(['repo', 'merge', 'x', '1']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /mc repo merge is now mc merge/u);
    assert.match(runMcCli(['--help']).stdout, /mc merge <repo> <pr> --docs/u);
    assert.doesNotMatch(runMcCli(['--help']).stdout, /mc repo merge/u);
  });
});
