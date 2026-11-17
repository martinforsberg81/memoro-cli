/**
 * `mc publish` — the publication sequence (`canon/tasks/publish-and-merge.md`), each rule a check.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { describedBody, managerGuard, messageParts, publishLines, readBody, refusal } from '../../src/mc/publish.js';
import { pushBranch, repoName, run } from '../../src/mc/commands/publish.js';
import { checkAgainstMain } from '../../src/mc/main-conflict.js';
import { goalField, goalJson } from './_helpers/goal-file.js';

/** The merge check's answer when the branch merges cleanly and the fetch works. */
const CLEAN_MAIN = { fetch: { ok: true, text: '' }, paths: [] };

describe('readBody and describedBody', () => {
  it('readBody and describedBody round-trip, and a second publish changes nothing', () => {
    const commits = [{ sha: 'def5678aaaa', subject: 'Fix it', body: 'Why.\n\nCo-Authored-By: x' }];
    const once = describedBody({ text: 'Intro', described: 'abc1234', commits });
    const read = readBody(once);
    assert.deepEqual(read, { text: 'Intro', described: 'abc1234' });
    assert.match(once, /- `def5678` Fix it\n {2}Why\./u);
    assert.doesNotMatch(once, /Co-Authored-By/u);
    assert.equal(describedBody({ ...read, commits }), once);
  });
});

describe('refusal', () => {
  it('refuses main, a dirty tree, and a remote branch that moved — and nothing else', () => {
    assert.match(refusal({ branch: 'main', localHead: 'a' }), /on main/u);
    assert.match(refusal({ branch: 'HEAD', localHead: 'a' }), /on HEAD/u);
    const dirty = refusal({ branch: 'x', dirty: [' M a.js', '?? b.js'], localHead: 'a' });
    assert.match(dirty, /not clean/u);
    assert.match(dirty, /\n {2} M a\.js\n {2}\?\? b\.js$/u);
    assert.match(refusal({ branch: 'x', dirty: Array.from({ length: 12 }, (_, i) => `?? f${i}`), localHead: 'a' }), /… and 2 more/u);
    assert.match(refusal({ branch: 'x', remoteHead: 'bbbbbbb1', localHead: 'a', remoteIsAncestor: false }), /origin\/x is at bbbbbbb.*never force/u);
    assert.equal(refusal({ branch: 'x', remoteHead: 'b', localHead: 'a', remoteIsAncestor: true }), null);
    assert.equal(refusal({ branch: 'x', remoteHead: null, localHead: 'a' }), null);
  });
});

describe('messageParts and publishLines', () => {
  it('splits a commit message into subject and body', () => {
    assert.deepEqual(messageParts('Subject line\n\nBody one\nBody two\n\n'), { title: 'Subject line', body: 'Body one\nBody two' });
    assert.deepEqual(messageParts('Only subject'), { title: 'Only subject', body: '' });
  });

  it('prints the number, the URL, the head and the next line', () => {
    const pr = { number: 7, url: 'https://x/pull/7', headRefOid: 'abcdef0123', baseRefName: 'main', mergeStateStatus: 'CLEAN', mergeable: 'MERGEABLE' };
    assert.deepEqual(publishLines({ pr, localHead: 'abcdef0123456', branch: 'step-x', pushed: true, created: true, repo: 'memoro' }), [
      '#7 https://x/pull/7',
      'opened from step-x → main; pushed abcdef0',
      'state clean, mergeable',
      'next: mc merge memoro 7',
    ]);
    const stale = publishLines({ pr: { ...pr, headRefOid: '9999999', mergeStateStatus: 'UNKNOWN' }, localHead: 'abcdef0', branch: 'b', pushed: false, created: false, repo: 'memoro-cli' });
    assert.equal(stale[1], 'already open from b → main; nothing to push abcdef0 — GitHub holds 9999999, not the head that was pushed: read gh pr view 7');
    assert.deepEqual(stale.slice(2), ['next: mc merge memoro-cli 7']);
  });

  it('names the repository from origin\'s URL', () => {
    assert.equal(repoName('git@github.com:martin/memoro.git', '/w/x'), 'memoro');
    assert.equal(repoName('https://github.com/martin/memoro-cli', '/w/x'), 'memoro-cli');
    assert.equal(repoName('', '/w/memoro-cli'), 'memoro-cli');
  });
});

describe('mc publish', () => {
  function fixture({ branch = 'step-x', status = '', remote = '', prs = [], created = 'https://x/pull/9\n', body = '', log = '', check = CLEAN_MAIN } = {}) {
    const out = { stdout: '', stderr: '', gh: [], pushed: [], pushOpts: [], merged: [] };
    const git = (args) => {
      const key = args.join(' ');
      if (key === 'rev-parse --show-toplevel') return '/w/x';
      if (key === 'rev-parse --abbrev-ref HEAD') return branch;
      if (key === 'rev-parse HEAD') return 'aaaaaaa1111';
      if (key === 'status --porcelain') return status;
      if (key.startsWith('ls-remote')) return remote;
      if (key.startsWith('merge-base --is-ancestor')) return '';
      if (key === 'remote get-url origin') return 'git@github.com:m/memoro.git';
      if (key === 'log -1 --format=%B') return 'The subject\n\nThe body.\n';
      if (key === 'symbolic-ref --short refs/remotes/origin/HEAD') return 'origin/main';
      if (key.startsWith('check-ref-format')) return args.at(-1).includes('..') ? null : args.at(-1);
      if (key.startsWith('rev-list')) return 'aaaaaaa1111';
      if (key.startsWith('log --reverse')) return log;
      return null;
    };
    const gh = (args) => {
      out.gh.push(args);
      if (args[1] === 'list') return { ok: true, stdout: JSON.stringify(prs), text: '' };
      if (args[1] === 'create') return { ok: true, stdout: created, text: '' };
      if (args[1] === 'edit') return { ok: true, stdout: '', text: '' };
      if (args[1] === 'view' && args[4] === 'body') return { ok: true, stdout: JSON.stringify({ body }), text: '' };
      if (args[1] === 'view') return { ok: true, stdout: JSON.stringify({ number: Number(args[2]), url: `https://x/pull/${args[2]}`, headRefOid: 'aaaaaaa1111', baseRefName: 'main', mergeStateStatus: 'UNKNOWN', mergeable: 'UNKNOWN' }), text: '' };
      return { ok: false, stdout: '', text: 'unexpected' };
    };
    const deps = {
      env: {},
      stdout: { write: (s) => { out.stdout += s; } }, stderr: { write: (s) => { out.stderr += s; } },
      cwd: '/w/x', git, gh, push: (name, opts) => { out.pushed.push(name); out.pushOpts.push(opts); return { ok: true, text: '' }; },
      merge: async (argv, { stdout }) => { out.merged.push(argv); stdout.write(`queued for the merger: ${argv.join(' ')}\n`); return 0; },
      mainCheck: () => check,
    };
    return { out, deps };
  }

  it('a fetch that fails is a warning, and the branch is checked against the origin/main it holds: published', async () => {
    const { out, deps } = fixture({ check: { fetch: { ok: false, text: 'could not read from remote' }, paths: [] } });
    assert.equal(await run(['--no-merge'], deps), 0);
    assert.equal(out.stderr, 'mc: warning: git fetch origin failed (could not read from remote) — checked against the origin/main already held\n');
    assert.deepEqual(out.pushed, ['step-x']);
  });

  // The manager's publish guard (D6): the diff against origin/main is read through git, the verdict is managerGuard's.
  function asManager(deps, files) {
    const real = deps.git;
    deps.env = { MC_ROLE: 'manager' };
    deps.git = (args) => {
      const key = args.join(' ');
      if (key === 'merge-base origin/main HEAD') return 'base1';
      if (key === 'diff --name-only --no-renames base1 HEAD') return Object.keys(files).join('\n');
      const shown = key.match(/^show (base1|HEAD):(.+)$/u);
      if (shown) return files[shown[2]]?.[shown[1] === 'HEAD' ? 1 : 0] ?? null;
      return real(args);
    };
    return deps;
  }
  const PAGE = (aim, decisions, store = 'x') => `# memoro-cli\n\n## Aim\n\n${aim}\n\n## Decisions\n\n${decisions}\n\n## Store\n\n${store}\n`;
  const DECIDED = '- Merging waits for a review. Martin, 2026-11-10, programme mc.\n  It never merges itself.\n- An undated line.\n';

  it('manager: a branch that changes a file outside docs/technical/ is refused, exit 2, one mc: line, nothing pushed, queued or opened', async () => {
    const { out, deps } = fixture();
    assert.equal(await run([], asManager(deps, { 'src/mc/run.js': ['a', 'b'], 'docs/technical/mc-run.md': ['a', 'b'] })), 2);
    assert.match(out.stderr, /^mc: the manager publishes only what its role may change — src\/mc\/run\.js is outside docs\/technical\//u);
    assert.equal(out.stderr.trim().split('\n').length, 1);
    assert.deepEqual([out.pushed, out.gh, out.merged], [[], [], []]);
  });

  it('manager: docs/technical/memoro-me.md is refused; the changes the role may make publish', async () => {
    const refused = fixture();
    assert.equal(await run([], asManager(refused.deps, { 'docs/technical/memoro-me.md': ['a', 'b'] })), 2);
    assert.match(refused.out.stderr, /docs\/technical\/memoro-me\.md is Martin's own text/u);
    const allowed = fixture();
    assert.equal(await run(['--no-merge'], asManager(allowed.deps, {
      'docs/technical/mc-run.md': ['old\n', 'new\n'],
      'docs/technical/areas/x.md': [PAGE('Aim.', DECIDED, 'old'), PAGE('Aim.', DECIDED, 'new')],
    })), 0, allowed.out.stderr);
    assert.deepEqual(allowed.out.pushed, ['step-x']);
  });

  it('manager: a changed ## Aim or ## Decisions of an area page is refused, ## Store is the manager\'s to change', async () => {
    for (const [heading, after] of [['Aim', PAGE('A new aim.', DECIDED)], ['Decisions', PAGE('Aim.', `${DECIDED}- A new decision.\n`)]]) {
      const { out, deps } = fixture();
      assert.equal(await run([], asManager(deps, { 'docs/technical/areas/x.md': [PAGE('Aim.', DECIDED), after] })), 2);
      assert.match(out.stderr, new RegExp(`docs/technical/areas/x\\.md changes its ## ${heading}`, 'u'));
      assert.deepEqual(out.pushed, []);
    }
    const { out, deps } = fixture();
    assert.equal(await run(['--no-merge'], asManager(deps, { 'docs/technical/areas/x.md': [PAGE('Aim.', DECIDED, 'old'), PAGE('Aim.', DECIDED, 'new')] })), 0, out.stderr);
  });

  it('manager: removing or altering a line of a block with a dated decision of Martin\'s is refused, wherever it stands; an undated block is free', async () => {
    const FILE = 'docs/technical/mc-run.md';
    const doc = `# Run\n\nThe runner starts it.\nMartin, 2026-11-12 decided that.\nIt holds.\n\n${DECIDED}`;
    for (const after of [
      doc.replace('It never merges itself.', 'It merges when it likes.'),
      doc.replace('  It never merges itself.\n', ''),
      doc.replace('- Merging waits for a review. Martin, 2026-11-10, programme mc.', '- Merging waits. Martin, 2026-11-10, programme mc.'),
      doc.replace('It holds.\n', ''),
      doc.replace(/- Merging[\s\S]*never merges itself\.\n/u, ''),
    ]) {
      const { out, deps } = fixture();
      assert.equal(await run([], asManager(deps, { [FILE]: [doc, after] })), 2, after);
      assert.match(out.stderr, /removes or alters a line of a dated decision of Martin's/u);
    }
    // Adding lines, rewording the undated list item and a decision with no date are not what the rule keeps.
    const free = fixture();
    assert.equal(await run(['--no-merge'], asManager(free.deps, { [FILE]: [doc, doc.replace('- An undated line.', '- A reworded line.').replace('It holds.', 'It holds.\nMore.')] })), 0, free.out.stderr);
    assert.equal(managerGuard([{ path: FILE, before: 'Martin decided that.\n', after: 'Gone.\n' }]), null);
  });

  // D2: an older dated decision of Martin's is superseded by a later one on the same page that stands unchanged; only then may it be
  // corrected (its citation kept) or removed. Everything else stays his.
  it('manager: a line superseded by a later dated decision of his is corrected or removed; every other change to it is refused', async () => {
    const OLD = '- Merging waits for a review. Martin, 2026-11-10, programme mc.\n  It never merges itself.\n';
    const CORRECTED = '- Merging waits for a review. Martin, 2026-11-10, programme mc.\n  It merges when a review passes.\n';
    const LATER = '- The review is a gate. Martin, 2026-11-12, programme mc.\n';
    const AREA = 'docs/technical/areas/x.md';
    const FILE = 'docs/technical/mc-run.md';
    const doc = (decisions) => `# Run\n\n${decisions}`;
    const guard = (path, before, after) => managerGuard([{ path, before, after }]);
    // (a) corrected with its citation kept, on an area page's ## Decisions and on another page of docs/technical/; (b) removed.
    assert.equal(guard(AREA, PAGE('Aim.', OLD + LATER), PAGE('Aim.', CORRECTED + LATER)), null);
    assert.equal(guard(FILE, doc(OLD + LATER), doc(CORRECTED + LATER)), null);
    assert.equal(guard(AREA, PAGE('Aim.', OLD + LATER), PAGE('Aim.', LATER)), null);
    assert.equal(guard(FILE, doc(OLD + LATER), doc(LATER)), null);
    const allowed = fixture();
    assert.equal(await run(['--no-merge'], asManager(allowed.deps, { [AREA]: [PAGE('Aim.', OLD + LATER), PAGE('Aim.', CORRECTED + LATER)] })), 0, allowed.out.stderr);
    assert.deepEqual(allowed.out.pushed, ['step-x']);
    // (c) the same correction with no later dated block is refused.
    assert.match(guard(AREA, PAGE('Aim.', OLD), PAGE('Aim.', CORRECTED)), /docs\/technical\/areas\/x\.md removes or alters a line of a dated decision of Martin's/u);
    assert.match(guard(FILE, doc(OLD), doc(CORRECTED)), /docs\/technical\/mc-run\.md removes or alters/u);
    // (d) the later block changed too: the older one has no later block kept unchanged.
    assert.match(guard(AREA, PAGE('Aim.', OLD + LATER), PAGE('Aim.', CORRECTED + LATER.replace('is a gate', 'is optional'))), /removes or alters/u);
    // (e) the older block's citation changed.
    assert.match(guard(AREA, PAGE('Aim.', OLD + LATER), PAGE('Aim.', CORRECTED.replace('programme mc', 'programme other') + LATER)), /docs\/technical\/areas\/x\.md changes its ## Decisions/u);
    // (f) a new block added to ## Decisions.
    assert.match(guard(AREA, PAGE('Aim.', OLD + LATER), PAGE('Aim.', CORRECTED + LATER + '- A new decision. Martin, 2026-11-13, programme mc.\n')), /docs\/technical\/areas\/x\.md changes its ## Decisions/u);
    // (g) ## Aim changed.
    assert.match(guard(AREA, PAGE('Aim.', OLD + LATER), PAGE('A new aim.', CORRECTED + LATER)), /docs\/technical\/areas\/x\.md changes its ## Aim/u);
  });

  it('manager: a diff that cannot be read refuses; a role other than the manager is not guarded', async () => {
    const unreadable = fixture();
    assert.equal(await run([], unreadable.deps = { ...unreadable.deps, env: { MC_ROLE: 'manager' } }), 2);
    assert.match(unreadable.out.stderr, /^mc: the manager's publish cannot read what the branch changes against origin\/main/u);
    assert.deepEqual(unreadable.out.pushed, []);
    for (const role of ['plan', 'build', 'review', undefined]) {
      const { out, deps } = fixture();
      deps.env = role ? { MC_ROLE: role } : {};
      deps.git = ((real) => (args) => (args[0] === 'diff' ? 'src/mc/run.js\ndocs/technical/memoro-me.md' : real(args)))(deps.git);
      assert.equal(await run(['--no-merge'], deps), 0, `${role}: ${out.stderr}`);
      assert.deepEqual(out.pushed, ['step-x']);
    }
  });

  it('a branch whose merge with origin/main conflicts is refused before anything is pushed, and the path is named', async () => {
    const { out, deps } = fixture({ check: { fetch: { ok: true, text: '' }, paths: ['canon/tasks/scratch-and-probes.md'] } });
    assert.equal(await run([], deps), 1);
    assert.equal(out.stderr, 'mc: the branch conflicts with origin/main in canon/tasks/scratch-and-probes.md — rebase onto origin/main, then run this again\n');
    assert.deepEqual([out.pushed, out.gh, out.merged], [[], [], []]);
  });

  it('pushes, creates the pull request from the last commit, views it once, and queues it for the merger', async () => {
    const { out, deps } = fixture();
    assert.equal(await run([], deps), 0);
    assert.deepEqual(out.pushed, ['step-x']);
    assert.deepEqual(out.gh.map((a) => a.slice(0, 2)), [['pr', 'list'], ['pr', 'create'], ['pr', 'view']]);
    assert.deepEqual(out.gh[1], ['pr', 'create', '--base', 'main', '--head', 'step-x', '--title', 'The subject', '--body', 'The body.\n\n<!-- mc:described aaaaaaa1111 -->']);
    assert.equal(out.stdout, '#9 https://x/pull/9\nopened from step-x → main; pushed aaaaaaa\nqueued for the merger: memoro 9\n');
    assert.deepEqual(out.merged, [['memoro', '9']]);
  });

  it('the merge\'s answer is the publish\'s: an unmet criterion is exit 1 after the PR exists', async () => {
    const { out, deps } = fixture();
    deps.merge = async (argv, { stderr }) => { stderr.write('mc: unmet-criteria — criterion 2\n'); return 1; };
    assert.equal(await run([], deps), 1);
    assert.match(out.stdout, /^#9 /u);
    assert.equal(out.stderr, 'mc: unmet-criteria — criterion 2\n');
  });

  it('--no-merge and --json queue nothing and say what to run next', async () => {
    const plain = fixture();
    assert.equal(await run(['--no-merge'], plain.deps), 0);
    assert.deepEqual(plain.out.merged, []);
    assert.match(plain.out.stdout, /\nnext: mc merge memoro 9\n$/u);
    const json = fixture();
    assert.equal(await run(['--json'], json.deps), 0);
    assert.deepEqual(json.out.merged, []);
  });

  it('a pull request from a mend/deploy- branch is recorded for the deploy repair, per repository, before it is queued', async () => {
    const { out, deps } = fixture({ branch: 'mend/deploy-0123456789ab' });
    const recorded = [];
    deps.publishDeployMend = (entry) => { recorded.push(entry); assert.deepEqual(out.merged, [], 'recorded before the merger is asked'); };
    assert.equal(await run([], deps), 0);
    assert.deepEqual(recorded.map(({ repo, branch, pr }) => ({ repo, branch, pr })), [{ repo: 'memoro', branch: 'mend/deploy-0123456789ab', pr: 9 }]);
    assert.deepEqual(out.merged, [['memoro', '9']]);
  });

  it('a branch that is not a deploy repair records nothing for one; a record that cannot be written stops the publish before the queue', async () => {
    const plain = fixture();
    plain.deps.publishDeployMend = () => assert.fail('only a mend/deploy- branch is a deploy repair');
    assert.equal(await run([], plain.deps), 0);
    const broken = fixture({ branch: 'mend/deploy-0123456789ab' });
    broken.deps.publishDeployMend = () => { throw new Error('disk full'); };
    assert.equal(await run([], broken.deps), 1);
    assert.match(broken.out.stderr, /^mc: deploy-mend ownership not recorded: disk full\n$/u);
    assert.deepEqual(broken.out.merged, []);
  });

  it('a head GitHub does not hold yet is not queued', async () => {
    const { out, deps } = fixture();
    const gh = deps.gh;
    deps.gh = (args) => {
      const answer = gh(args);
      if (args[1] === 'view' && args[4] !== 'body') return { ...answer, stdout: JSON.stringify({ ...JSON.parse(answer.stdout), headRefOid: 'ccccccc' }) };
      return answer;
    };
    assert.equal(await run([], deps), 0);
    assert.deepEqual(out.merged, []);
    assert.match(out.stdout, /GitHub holds ccccccc[^\n]*\nnext: mc merge memoro 9\n$/u);
  });

  describe('the goal a pull request carries (goal-lifecycle)', () => {
    const HOME = '/programs';
    const GDIR = `${HOME}/ios/goals/asc`;
    const GOAL = goalJson({ stage: 'review', repos: ['memoro', 'memoro-cli'], title: 'asc' });
    /** A goal file model beside the publish fixture. */
    const withGoal = (over = {}) => {
      const f = fixture(over.fixture);
      const files = { [`${GDIR}/GOAL.json`]: over.goal ?? GOAL, [`${GDIR}/LOG.md`]: '' };
      Object.assign(f.deps, {
        home: HOME, now: () => new Date('2026-11-03T09:00:00Z'),
        readGoal: (path) => files[path] ?? null, writeGoal: (path, text) => { files[path] = text; },
        listGoals: (path) => (path === HOME ? ['ios'] : path === `${HOME}/ios/goals` ? ['asc'] : []),
        ...over.deps,
      });
      return { ...f, files };
    };

    it('--goal writes the pull request into the goal\'s prs, with an entry, and still queues it', async () => {
      const f = withGoal({ goal: goalJson({ stage: 'merge', repos: ['memoro', 'memoro-cli'], title: 'asc' }) });
      assert.equal(await run(['--goal', 'ios/asc'], f.deps), 0, f.out.stderr);
      assert.deepEqual(goalField(f.files[`${GDIR}/GOAL.json`], 'prs'), ['memoro#9']);
      assert.match(f.files[`${GDIR}/LOG.md`], /· person · merge · ready\n\nDone: published memoro#9\n/u);
      assert.match(f.out.stdout, /goal ios\/asc carries memoro#9 — done when every pull request it carries has landed\n/u);
      assert.deepEqual(f.out.merged, [['memoro', '9']]);
    });

    for (const stage of ['draft', 'build', 'review', 'finish']) {
      it(`a goal in ${stage} is not queued, with or without --no-merge: one line names the goal, its stage and mc goal stage merge`, async () => {
        for (const extra of [[], ['--no-merge']]) {
          const f = withGoal({ goal: goalJson({ stage, repos: ['memoro'], title: 'asc' }) });
          assert.equal(await run(['--goal', 'ios/asc', ...extra], f.deps), 0, f.out.stderr);
          assert.deepEqual(f.out.merged, []);
          assert.match(f.out.stdout, new RegExp(`goal ios/asc is in stage ${stage} — a goal's pull request reaches the merger only in stage merge; mc goal stage merge ios/asc hands it over — not queued\\n$`, 'u'));
          assert.doesNotMatch(f.out.stdout, /next: mc merge/u);
          assert.doesNotMatch(f.out.stdout, /queued for the merger/u);
        }
      });
    }

    it('a goal whose stage cannot be read queues nothing, and says so', async () => {
      const f = withGoal({ goal: '{ not json' });
      assert.equal(await run(['--goal', 'ios/asc'], f.deps), 0, f.out.stderr);
      assert.deepEqual(f.out.merged, []);
      assert.match(f.out.stdout, /goal ios\/asc is in a stage mc cannot read.*mc goal stage merge ios\/asc hands it over — not queued\n$/u);
    });

    it('under --json, next names mc goal stage merge <programme>/<goal> for a goal before merge, and mc merge for one in merge', async () => {
      const early = withGoal({ goal: goalJson({ stage: 'build', repos: ['memoro'], title: 'asc' }) });
      assert.equal(await run(['--goal', 'ios/asc', '--json'], early.deps), 0, early.out.stderr);
      assert.equal(JSON.parse(early.out.stdout).next, 'mc goal stage merge ios/asc');
      assert.deepEqual(early.out.merged, []);
      const merge = withGoal({ goal: goalJson({ stage: 'merge', repos: ['memoro'], title: 'asc' }) });
      assert.equal(await run(['--goal', 'ios/asc', '--json'], merge.deps), 0, merge.out.stderr);
      assert.equal(JSON.parse(merge.out.stdout).next, 'mc merge memoro 9');
    });

    it('a goal in merge queues, and a publication that carries no goal queues, as before', async () => {
      const merge = withGoal({ goal: goalJson({ stage: 'merge', repos: ['memoro'], title: 'asc' }) });
      assert.equal(await run(['--goal', 'ios/asc'], merge.deps), 0, merge.out.stderr);
      assert.deepEqual(merge.out.merged, [['memoro', '9']]);
      const none = withGoal({ goal: goalJson({ stage: 'build', repos: ['memoro'], title: 'asc' }) });
      assert.equal(await run([], none.deps), 0, none.out.stderr);
      assert.deepEqual(none.out.merged, [['memoro', '9']]);
    });

    it('--goal with a build session\'s environment writes the entry with · by build', async () => {
      const f = withGoal({ deps: { env: { MC_TOOL: 'claude', MC_ROLE: 'build-session:goal' } } });
      assert.equal(await run(['--goal', 'ios/asc'], f.deps), 0, f.out.stderr);
      assert.match(f.files[`${GDIR}/LOG.md`], /· claude · review · ready · by build\n\nDone: published memoro#9\n/u);
    });

    it('MC_GOAL, the goal worktree it stands in, or a goal/<g> branch name the goal too', async () => {
      const byEnv = withGoal({ deps: { env: { MC_GOAL: 'ios/asc' } } });
      assert.equal(await run([], byEnv.deps), 0, byEnv.out.stderr);
      assert.deepEqual(goalField(byEnv.files[`${GDIR}/GOAL.json`], 'prs'), ['memoro#9']);
      const byPath = withGoal({ deps: { cwd: `${GDIR}/memoro` } });
      assert.equal(await run([], byPath.deps), 0, byPath.out.stderr);
      assert.deepEqual(goalField(byPath.files[`${GDIR}/GOAL.json`], 'prs'), ['memoro#9']);
      const byBranch = withGoal({ fixture: { branch: 'goal/asc' } });
      assert.equal(await run([], byBranch.deps), 0, byBranch.out.stderr);
      assert.deepEqual(goalField(byBranch.files[`${GDIR}/GOAL.json`], 'prs'), ['memoro#9']);
    });

    it('no goal named, none written; a --goal that is no goal is refused before the push', async () => {
      const none = withGoal();
      assert.equal(await run([], none.deps), 0);
      assert.deepEqual(goalField(none.files[`${GDIR}/GOAL.json`], 'prs'), []);
      const wrong = withGoal();
      assert.equal(await run(['--goal', 'ios/nope'], wrong.deps), 2);
      assert.match(wrong.out.stderr, /--goal ios\/nope is not a goal/u);
      assert.deepEqual(wrong.out.pushed, []);
    });
  });

  it('finds the open pull request rather than opening a second, edits it only when asked, and skips a push the remote already has', async () => {
    const same = fixture({ remote: 'aaaaaaa1111\trefs/heads/step-x', prs: [{ number: 4, url: 'https://x/pull/4' }], body: 'Intro\n\n<!-- mc:described aaaaaaa1111 -->' });
    assert.equal(await run([], same.deps), 0);
    assert.deepEqual(same.out.pushed, []);
    assert.deepEqual(same.out.gh.map((a) => a[1]), ['list', 'view', 'view']);
    assert.match(same.out.stdout, /^#4 .*\nalready open from step-x → main; nothing to push aaaaaaa\nqueued for the merger: memoro 4\n$/u);
    const edited = fixture({ remote: 'bbbbbbb\trefs/heads/step-x', prs: [{ number: 4, url: 'https://x/pull/4' }] });
    assert.equal(await run(['--title', 'New', '--body', 'B'], edited.deps), 0);
    assert.deepEqual(edited.out.pushed, ['step-x']);
    assert.deepEqual(edited.out.gh[1], ['pr', 'edit', '4', '--title', 'New', '--body', 'B\n\n<!-- mc:described aaaaaaa1111 -->']);
  });

  it('on an open pull request --body edits the body alone', async () => {
    const edited = fixture({ remote: 'bbbbbbb\trefs/heads/step-x', prs: [{ number: 4, url: 'https://x/pull/4' }] });
    assert.equal(await run(['--body', 'B'], edited.deps), 0);
    assert.deepEqual(edited.out.gh[1], ['pr', 'edit', '4', '--body', 'B\n\n<!-- mc:described aaaaaaa1111 -->']);
  });

  it('--body-file reads the body from the file, on a new pull request and on an open one', async () => {
    const read = (path) => (path === 'b.md' ? 'File body.' : null);
    const created = fixture();
    assert.equal(await run(['--body-file', 'b.md'], { ...created.deps, read }), 0);
    assert.deepEqual(created.out.gh[1], ['pr', 'create', '--base', 'main', '--head', 'step-x', '--title', 'The subject', '--body', 'File body.\n\n<!-- mc:described aaaaaaa1111 -->']);
    const edited = fixture({ remote: 'bbbbbbb\trefs/heads/step-x', prs: [{ number: 4, url: 'https://x/pull/4' }] });
    assert.equal(await run(['--body-file', 'b.md'], { ...edited.deps, read }), 0);
    assert.deepEqual(edited.out.gh[1], ['pr', 'edit', '4', '--body', 'File body.\n\n<!-- mc:described aaaaaaa1111 -->']);
  });

  it('--title edits the title alone, --base the base alone', async () => {
    const marked = 'Intro\n\n<!-- mc:described aaaaaaa1111 -->';
    const titled = fixture({ remote: 'bbbbbbb\trefs/heads/step-x', prs: [{ number: 4, url: 'https://x/pull/4' }], body: marked });
    assert.equal(await run(['--title', 'T'], titled.deps), 0);
    assert.deepEqual(titled.out.gh[2], ['pr', 'edit', '4', '--title', 'T']);
    const based = fixture({ remote: 'bbbbbbb\trefs/heads/step-x', prs: [{ number: 4, url: 'https://x/pull/4' }], body: marked });
    assert.equal(await run(['--base', 'release'], based.deps), 0);
    assert.deepEqual(based.out.gh[2], ['pr', 'edit', '4', '--base', 'release']);
  });

  it('an open pull request with later commits gets them under After the description, and only the body is edited', async () => {
    const later = fixture({ remote: 'bbbbbbb\trefs/heads/step-x', prs: [{ number: 4, url: 'https://x/pull/4' }], body: 'Intro\n\n<!-- mc:described ccccccc -->', log: 'ddddddd0000\x1fFix\x1f\x1e' });
    assert.equal(await run([], later.deps), 0);
    assert.deepEqual(later.out.gh[2], ['pr', 'edit', '4', '--body', 'Intro\n\n## After the description\n\n- `ddddddd` Fix\n\n<!-- mc:described ccccccc -->']);
    assert.equal(later.out.gh.filter((a) => a[1] === 'edit').length, 1);
    assert.match(later.out.stdout, /description at ccccccc; 1 later commit under "After the description"/u);
  });

  it('nothing after the mark: no edit', async () => {
    const marked = fixture({ remote: 'bbbbbbb\trefs/heads/step-x', prs: [{ number: 4, url: 'https://x/pull/4' }], body: 'Intro\n\n<!-- mc:described ccccccc -->' });
    assert.equal(await run([], marked.deps), 0);
    assert.deepEqual(marked.out.gh.map((a) => a[1]), ['list', 'view', 'view']);
  });

  it('a new pull request aims at --base when given', async () => {
    const { out, deps } = fixture();
    assert.equal(await run(['--base', 'release'], deps), 0);
    assert.deepEqual(out.gh[1], ['pr', 'create', '--base', 'release', '--head', 'step-x', '--title', 'The subject', '--body', 'The body.\n\n<!-- mc:described aaaaaaa1111 -->']);
  });

  it('refuses main and a dirty tree before touching the network; --json is the snapshot', async () => {
    const main = fixture({ branch: 'main' });
    assert.equal(await run([], main.deps), 1);
    assert.deepEqual([main.out.pushed, main.out.gh], [[], []]);
    assert.match(main.out.stderr, /on main/u);
    const dirty = fixture({ status: ' M a.js' });
    assert.equal(await run([], dirty.deps), 1);
    assert.match(dirty.out.stderr, /not clean[\s\S]* M a\.js/u);
    const json = fixture();
    assert.equal(await run(['--json'], json.deps), 0);
    const parsed = JSON.parse(json.out.stdout);
    assert.deepEqual([parsed.number, parsed.created, parsed.pushed, parsed.next], [9, true, true, 'mc merge memoro 9']);
    assert.equal(await run(['extra'], fixture().deps), 2);
  });

  it('--branch is gone with the mend: refused before the network, from a branch or a detached HEAD', async () => {
    for (const branch of ['other', 'HEAD']) {
      const f = fixture({ branch });
      assert.equal(await run(['--branch', 'step-x'], f.deps), 2);
      assert.deepEqual([f.out.pushed, f.out.gh], [[], []]);
    }
    const calls = [];
    const spawn = (cmd, args) => { calls.push([cmd, ...args]); return { status: 0, stdout: '', stderr: '' }; };
    assert.equal(pushBranch('/w/x', 'step-x', { spawn, stderr: { write() {} } }).ok, true);
    assert.deepEqual(calls, [['git', 'push', '-u', 'origin', 'step-x']]);
  });

  it('a detached HEAD is refused', async () => {
    const { out, deps } = fixture({ branch: 'HEAD' });
    assert.equal(await run([], deps), 1);
    assert.match(out.stderr, /on HEAD/u);
    assert.deepEqual([out.pushed, out.gh], [[], []]);
  });

  describe('against a modelled origin/main', () => {
    // One modelled origin and one clone, built once: `step-x` edits shared.md, which main edits
    // later (a conflict once the clone fetches); `step-y` is behind main and edits only other.md.
    let root;
    let workX;
    let workY;
    const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
    const write = (dir, name, text) => writeFileSync(join(dir, name), text);
    const commit = (dir, subject) => git(dir, ['commit', '-q', '-am', subject]);

    before(() => {
      root = mkdtempSync(join(tmpdir(), 'mc-publish-main-'));
      const origin = join(root, 'origin.git');
      const seed = join(root, 'seed');
      workX = join(root, 'work-x');
      workY = join(root, 'work-y');
      git(root, ['init', '-q', '--bare', '-b', 'main', origin]);
      git(root, ['init', '-q', '-b', 'main', seed]);
      write(seed, 'shared.md', 'one\ntwo\n');
      write(seed, 'other.md', 'x\n');
      git(seed, ['add', '.']);
      git(seed, ['commit', '-q', '-m', 'base']);
      git(seed, ['remote', 'add', 'origin', origin]);
      git(seed, ['push', '-q', 'origin', 'main']);
      git(seed, ['push', '-q', 'origin', 'main:release']);
      git(root, ['clone', '-q', origin, workX]);
      git(workX, ['checkout', '-q', '-b', 'step-x']);
      write(workX, 'shared.md', 'BRANCH\ntwo\n');
      commit(workX, 'branch edits the shared line');
      git(root, ['clone', '-q', origin, workY]);
      git(workY, ['checkout', '-q', '-b', 'step-y']);
      write(workY, 'other.md', 'y\n');
      commit(workY, 'branch edits another file');
      write(seed, 'shared.md', 'MAIN\ntwo\n');
      git(seed, ['commit', '-q', '-am', 'main edits the shared line']);
      git(seed, ['push', '-q', 'origin', 'main']);
    });

    after(() => rmSync(root, { recursive: true, force: true }));

    // The merge check is the real one, on the clone; GitHub, the push and the merger stay the fixture's.
    it('a branch that conflicts with origin/main, fetched just now, is refused: exit 1, the path named, nothing pushed or opened', async () => {
      const { out, deps } = fixture({ branch: 'step-x', check: checkAgainstMain(workX) });
      assert.equal(await run([], deps), 1);
      assert.equal(out.stderr, 'mc: the branch conflicts with origin/main in shared.md — rebase onto origin/main, then run this again\n');
      assert.deepEqual([out.pushed, out.gh, out.merged], [[], [], []]);
    });

    // origin/release is the base before main's edit: the branch that conflicts with main is clean against it.
    // The check is asked for the base publish was given, and the real merge check answers against that base.
    it('--base names the branch the merge is checked against: asked for release, clean against origin/release, so published', async () => {
      const { out, deps } = fixture({ branch: 'step-x' });
      const asked = [];
      deps.mainCheck = (dir, opts) => { asked.push(opts); return checkAgainstMain(workX, opts); };
      assert.equal(await run(['--base', 'release', '--no-merge'], deps), 0, out.stderr);
      assert.deepEqual(asked, [{ base: 'release' }]);
      assert.deepEqual(out.pushed, ['step-x']);
      assert.equal(out.stderr, '');
    });

    it('without --base the check is asked for main, as before', async () => {
      const { deps } = fixture({ branch: 'step-y' });
      const asked = [];
      deps.mainCheck = (dir, opts) => { asked.push(opts); return CLEAN_MAIN; };
      assert.equal(await run(['--no-merge'], deps), 0);
      assert.deepEqual(asked, [{ base: 'main' }]);
    });

    it('a branch only behind origin/main, with no conflict, publishes as before', async () => {
      const { out, deps } = fixture({ branch: 'step-y', check: checkAgainstMain(workY) });
      assert.equal(await run(['--no-merge'], deps), 0, out.stderr);
      assert.deepEqual(out.pushed, ['step-y']);
      assert.equal(out.stderr, '');
    });
  });
});

describe('pushBranch', () => {
  const thin = { status: 1, stdout: '', stderr: ' ! [remote rejected] step-x -> step-x (Internal Server Error)\nerror: failed to push some refs' };
  function fake(answers) {
    const out = { calls: [], stderr: '' };
    const spawn = (cmd, args) => { out.calls.push([cmd, ...args]); return answers[out.calls.length - 1]; };
    return { out, opts: { spawn, stderr: { write: (s) => { out.stderr += s; } } } };
  }

  it('pushes again once with --no-thin when GitHub rejects the thin pack, and says so', () => {
    const { out, opts } = fake([thin, { status: 0, stdout: '', stderr: 'To github.com:m/memoro.git' }]);
    assert.deepEqual(pushBranch('/w/x', 'step-x', opts), { ok: true, text: 'To github.com:m/memoro.git' });
    assert.deepEqual(out.calls, [['git', 'push', '-u', 'origin', 'step-x'], ['git', 'push', '--no-thin', '-u', 'origin', 'step-x']]);
    assert.equal(out.stderr, 'mc: GitHub rejected the thin pack; pushed again with --no-thin\n');
  });

  it('fails as before when the retry is rejected too, and retries no other failure', () => {
    const both = fake([thin, thin]);
    assert.deepEqual(pushBranch('/w/x', 'step-x', both.opts), { ok: false, text: thin.stderr.trim() });
    assert.equal(both.out.calls.length, 2);
    const other = fake([{ status: 128, stdout: '', stderr: 'fatal: could not read from remote repository' }]);
    assert.deepEqual(pushBranch('/w/x', 'step-x', other.opts), { ok: false, text: 'fatal: could not read from remote repository' });
    assert.equal(other.out.calls.length, 1);
    assert.equal(other.out.stderr, '');
  });
});
