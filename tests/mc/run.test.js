import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createRunner, runLoop } from '../../src/mc/run.js';

/**
 * A whole runner on fakes: a work root in memory, two repositories whose
 * origin/main carries PLAN.md files, git/gh/tmux answered from tables, and
 * a "session" that returns what the test says. Nothing starts, nothing is
 * written outside `files`.
 */
function fixture({ plans = {}, queue = '', session, gh = {}, dirty = [], live = [], areas = {}, conflicts = {}, stages = {}, roles = true, livePids = [], now = '2026-08-29T10:00:00Z', runs = null, collect = okCollect, helperTurn = okTurn, projectLog = {}, archive = {}, landed = [], removeFails = [], heads = {}, openPrs = {}, prsFail = [], refs = {}, rounds = {}, rebaseFails = [], prFiles = {} } = {}) {
  const root = '/w';
  const files = { [`${root}/queue.md`]: queue };
  if (runs != null) files[`${root}/runner/log/runs.tsv`] = runs;
  const dirs = new Set([root]);
  const env = { MC_WORK_ROOT: root, MC_REPOS_HOME: '/home' };
  const repos = { memoro: '/home/memoro', 'memoro-cli': '/home/memoro-cli' };
  for (const repo of Object.keys(repos)) files[`${repos[repo]}/.git`] = '';
  // Areas that already exist: name -> { repo, planText } — the plan is on the branch too.
  for (const [name, area] of Object.entries(areas)) {
    files[`${root}/${name}/${area.repo}/.git`] = '';
    dirs.add(`${root}/${name}`);
    // The checkout itself, not only its `.git`: `runStep` asks whether the
    // worktree is there before it makes one, and an area whose directory does
    // not exist was quietly re-created from origin/main — which overwrote the
    // very plan the fixture had put on its branch.
    dirs.add(`${root}/${name}/${area.repo}`);
    if (area.plan) {
      files[`${root}/${name}/${area.repo}/docs/project/${area.programme}/${name}/PLAN.json`] = area.plan;
      dirs.add(`${root}/${name}/${area.repo}/docs/project`);
    }
    for (const [file, text] of Object.entries(area.decisions || {})) {
      files[`${root}/${name}/decisions/${file}`] = text;
      dirs.add(`${root}/${name}/decisions`);
    }
  }
  const log = [];
  const calls = { git: [], gh: [], sessions: [], added: [], removed: [], collects: [], turns: [], rm: [], moved: [], rmdirs: [], checkouts: [], rounds: [], docsRounds: [] };
  /** `/w/runner/archive/<repo>` — the worktree the runner archives in. */
  const archiveRoot = `${root}/runner/archive`;
  // A snapshot of the work root taken inside every session call — the only
  // way to see the files that exist only while a step is in flight.
  const duringSession = [];
  const deps = {
    env,
    now: () => new Date(now),
    sleep: async () => {},
    tmuxHas: (name) => live.includes(name.replace(/^mc-/u, '')),
    // The liveness test the loop's own refusal uses. A table, not `ps`: a
    // fixture pid that happened to be a real process on the machine running
    // the suite would make these tests answer to something outside them.
    alive: (pid) => livePids.includes(Number(pid)),
    exists: (p) => p in files || dirs.has(p),
    read: (p) => files[p] ?? null,
    list: (p) => {
      if (p === root) return Object.keys(areas);
      const prefix = `${p}/`;
      const seen = new Set();
      for (const key of Object.keys(files)) if (key.startsWith(prefix)) seen.add(key.slice(prefix.length).split('/')[0]);
      return [...seen];
    },
    write: (p, t) => { files[p] = t; },
    append: (p, t) => { files[p] = (files[p] || '') + t; },
    // Closing a workarea moves everything it kept and then takes the empty
    // folder: both are recorded, so a test can say what was moved where.
    move: (from, to) => {
      const prefix = `${from}/`;
      let moved = false;
      for (const key of Object.keys(files)) {
        if (key !== from && !key.startsWith(prefix)) continue;
        files[key === from ? to : to + key.slice(from.length)] = files[key];
        delete files[key];
        moved = true;
      }
      for (const dir of [...dirs]) if (dir === from || dir.startsWith(prefix)) { dirs.delete(dir); dirs.add(to + dir.slice(from.length)); moved = true; }
      calls.moved.push([from, to]);
      return moved;
    },
    rmdir: (p) => {
      dirs.delete(p);
      calls.rmdirs.push(p);
      return true;
    },
    writeJson: (p, v) => { files[p] = `${JSON.stringify(v, null, 2)}\n`; },
    remove: (p) => { if (!(p in files)) return false; delete files[p]; calls.removed.push(p); return true; },
    pid: 4242,
    addWorktree: ({ name, repo }) => {
      const repoName = repo.split('/').at(-1);
      calls.added.push(name);
      files[`${root}/${name}/${repoName}/.git`] = '';
      dirs.add(`${root}/${name}`);
      const text = plans[repoName]?.[name];
      if (text) {
        files[`${root}/${name}/${repoName}/docs/project/prog/${name}/PLAN.json`] = text;
        dirs.add(`${root}/${name}/${repoName}/docs/project`);
      }
      return { ok: true, path: `${root}/${name}/${repoName}` };
    },
    collect: async (options) => { calls.collects.push(options); return collect(options); },
    helperTurn: async (options) => { calls.turns.push(options); return helperTurn(options); },
    // The one door, faked: `rounds` is what `mc merge`'s round reports back,
    // keyed by pull request number. The default is the happy one — landed, on
    // main — because every test that is not about the merge wants that and
    // none of them wants to say so.
    mergeRound: async (options) => {
      calls.rounds.push(options);
      const said = rounds[options.pr] || {};
      return {
        ok: true, merged: true, merged_into: 'main', default_branch: 'main', off_default: false,
        stopped_at: null, reason: null, ...said,
      };
    },
    docsMerge: async (options) => {
      calls.docsRounds.push(options);
      const a = archive[Object.keys(archive).find((r) => options.repoPath.endsWith(`/${r}`)) || ''] || {};
      return a.mergeFails
        ? { ok: false, merged: false, stopped_at: 'merge', reason: 'nope', pr: { number: options.pr } }
        : { ok: true, merged: true, merged_into: 'main', pr: { number: options.pr } };
    },
    profile: async () => 'PROFILE',
    role: (kind) => (roles ? { name: kind, overlay: `ROLE ${kind}` } : null),
    // `modelArgs` guards on a missing model exactly as both real adapters do:
    // no model named means no flag, not `--model null`.
    launch: (tool) => ({ ok: true, id: tool === 'codex' ? 'codex' : 'claude-code', shortName: tool, adapter: { modelArgs: (m) => (m ? ['--model', m] : []) }, spec: { bin: `/bin/${tool}` } }),
    session: (call) => { calls.sessions.push(call); duringSession.push(structuredClone(files)); return session(call); },
    log: (line) => log.push(line),
    git: (cwd, args) => {
      calls.git.push([cwd, ...args]);
      const repoName = Object.keys(repos).find((r) => cwd === repos[r]);
      // The three sides git holds in the index while a merge is in progress:
      // `:1:` the merge base, `:2:` ours, `:3:` theirs. `stages` is per
      // workarea, per path — a file it does not name is one git cannot show.
      if (args[0] === 'show' && /^:[123]:/u.test(args[1] || '')) {
        const [, stage, path] = args[1].match(/^:([123]):(.*)$/u);
        const held = (stages[cwd.split('/')[2]] || {})[path];
        return held ? { ok: true, stdout: held[Number(stage)] ?? '' } : { ok: false, stdout: '' };
      }
      if (args[0] === 'ls-tree' && repoName) {
        return { ok: true, stdout: Object.keys(plans[repoName] || {}).map((n) => `docs/project/prog/${n}/PLAN.json`).join('\n') };
      }
      if (args[0] === 'show' && repoName) {
        // The project log is read straight off origin/main at the end of a
        // round: it is what says a folder was a project once its plan has gone.
        if (args[1].endsWith(':docs/project/project_log.md')) {
          return { ok: true, stdout: projectLog[repoName] ?? '' };
        }
        const name = args[1].split('/').at(-2);
        return { ok: true, stdout: (plans[repoName] || {})[name] };
      }
      // `git worktree add -b <branch> <path> origin/main` in a repository:
      // origin/main checked out, which here is its plans and its project log.
      // `git worktree remove <path>` — the checkout is handed back, so its
      // files go with it and the folder above is left holding its filing.
      // `--force` is the archive worktree being taken down, which the archive
      // tests read the files of afterwards; only a workarea's is emptied here.
      if (args[0] === 'worktree' && args[1] === 'remove' && args[2] !== '--force') {
        const prefix = `${args.at(-1)}/`;
        for (const key of Object.keys(files)) if (key.startsWith(prefix)) delete files[key];
        for (const dir of [...dirs]) if (dir === args.at(-1) || dir.startsWith(prefix)) dirs.delete(dir);
        return { ok: !removeFails.includes(args.at(-1).split('/')[2]), stdout: '' };
      }
      if (args[0] === 'worktree' && args[1] === 'add' && repoName) {
        const path = args[4];
        for (const [name, text] of Object.entries(plans[repoName] || {})) files[`${path}/docs/project/prog/${name}/PLAN.json`] = text;
        files[`${path}/docs/project/project_log.md`] = projectLog[repoName] ?? '';
        return { ok: true, stdout: '' };
      }
      if (args[0] === 'rm') {
        const prefix = `${cwd}/${args.at(-1)}/`;
        calls.rm.push(args.at(-1));
        for (const key of Object.keys(files)) if (key.startsWith(prefix)) delete files[key];
        return { ok: true, stdout: '' };
      }
      if (args[0] === 'remote') return { ok: true, stdout: `git@github.com:o/${repoName || 'r'}.git` };
      if (args[0] === 'log') return { ok: true, stdout: 'abc1234' };
      if (args[0] === 'status') return { ok: true, stdout: dirty.some((d) => cwd.includes(`/${d}/`)) ? ' M x' : '' };
      if (args[0] === 'merge' && args.includes('origin/main')) {
        const name = cwd.split('/')[2];
        return conflicts[name] ? { ok: false, stdout: '', stderr: 'CONFLICT' } : { ok: true, stdout: '' };
      }
      if (args[0] === 'diff') return { ok: true, stdout: (conflicts[cwd.split('/')[2]] || []).join('\n') };
      // `rev-parse -q --verify MERGE_HEAD` is the reconcile check and answers
      // no; `rev-parse origin/main^{tree}` is branchLanded's base.
      if (args[0] === 'rev-parse') {
        if (args[1] === 'origin/main^{tree}') return { ok: true, stdout: 'basetree' };
        // `rev-parse --abbrev-ref HEAD` in a workarea's checkout: the branch
        // it actually sits on. `heads` names the ones that are not the folder.
        if (args[1] === '--abbrev-ref') {
          const head = heads[cwd.split('/')[2]];
          return head ? { ok: true, stdout: head } : { ok: false, stdout: '' };
        }
        return { ok: false, stdout: '' };
      }
      if (args[0] === 'merge-tree') return { ok: true, stdout: landed.includes(args.at(-1)) ? 'basetree' : 'othertree' };
      // Where a stacked branch left its base, and the replay onto the squash
      // that landed under it. `rebaseFails` names the branches that conflict.
      if (args[0] === 'merge-base') return { ok: true, stdout: `forked-${args.at(-1)}` };
      if (args[0] === 'rebase') return { ok: !rebaseFails.includes(args.at(-1)), stdout: '', stderr: 'CONFLICT' };
      // The branches that already exist, local and on the remote — what
      // `<name>-<n>` has to step over. `refs` names them per workarea.
      if (args[0] === 'for-each-ref') return { ok: true, stdout: (refs[cwd.split('/')[2]] || []).join('\n') };
      if (args[0] === 'ls-remote') return { ok: true, stdout: (refs[cwd.split('/')[2]] || []).map((b) => `deadbee\trefs/heads/${b}`).join('\n') };
      if (args[0] === 'checkout' && args.includes('-b')) { calls.checkouts.push([cwd, args[args.indexOf('-b') + 1]]); heads[cwd.split('/')[2]] = args[args.indexOf('-b') + 1]; return { ok: true, stdout: '' }; }
      // `git branch --show-current`: the branch the workarea stands on, which
      // is the folder's name unless `heads` says otherwise.
      if (args[0] === 'branch') return { ok: true, stdout: heads[cwd.split('/')[2]] || cwd.split('/')[2] };
      return { ok: true, stdout: '', stderr: '' };
    },
    gh: (cwd, args) => {
      calls.gh.push([cwd, ...args]);
      // The archive PR: opened in `/w/runner/archive/<repo>`, and asked for
      // in the repository itself ("is one still open from an earlier round?").
      const repoName = Object.keys(repos).find((r) => cwd === repos[r]);
      if (repoName) {
        // Which files a merged pull request changed, asked of GitHub in the
        // repository itself after the gate landed it — `prFiles` per number,
        // and a pull request nobody named changed nothing interesting.
        if (args[1] === 'view' && args.includes('files')) {
          return { ok: true, stdout: (prFiles[Number(args[2])] || ['README.md']).join('\n') };
        }
        // The round's own question: every open PR of the repository, asked
        // once beside the fetch in `queue()`.
        if (args.includes('--limit')) {
          if (prsFail.includes(repoName)) return { ok: false, stdout: '', stderr: 'gh: not logged in' };
          return { ok: true, stdout: JSON.stringify(openPrs[repoName] || []) };
        }
        const stale = archive[repoName]?.openFromEarlierRound;
        return { ok: true, stdout: stale ? String(stale) : '' };
      }
      if (cwd.startsWith(`${archiveRoot}/`)) {
        const a = archive[cwd.slice(archiveRoot.length + 1)] || {};
        const number = a.number ?? 900;
        if (args[1] === 'create') return a.createFails ? { ok: false, stdout: '', stderr: 'no' } : { ok: true, stdout: `https://github.com/o/r/pull/${number}\n` };
        if (args[1] === 'list') return { ok: true, stdout: String(number) };
        if (args[1] === 'view' && args.includes('mergeable')) return { ok: true, stdout: 'MERGEABLE' };
        if (args[1] === 'view' && args.includes('title')) return { ok: true, stdout: 'Archive' };
        if (args[1] === 'merge') return a.mergeFails ? { ok: false, stdout: '', stderr: 'nope' } : { ok: true, stdout: '' };
        return { ok: true, stdout: '' };
      }
      // A workarea's own checkout: what this project has open *now*, asked
      // again after the session because the session is what changed it.
      // `gh[name]` is one pull request or a stack of them; a head nobody named
      // is the branch the workarea stands on.
      const name = cwd.split('/')[2];
      const opened = [gh[name]].flat().filter(Boolean).map((pr) => ({
        number: pr.number,
        title: pr.title || 't',
        isDraft: Boolean(pr.isDraft),
        headRefName: pr.head || heads[name] || name,
        baseRefName: pr.base || 'main',
      }));
      if (args[1] === 'list') return { ok: true, stdout: JSON.stringify(opened) };
      if (args[1] === 'edit') return { ok: true, stdout: '' };
      return { ok: true, stdout: '' };
    },
  };
  return { deps, files, log, calls, root, duringSession };
}

/** The helper's two halves, faked: a digest that was written and a turn that ran. */
const okCollect = async () => ({
  path: '/w/intake/errors-2026-08-29.md',
  text: '# digest',
  data: {
    delta: { first: false, fingerprints: [{ fingerprint: 'abc', count: 41, loud: true }], failing: [] },
    errors: { rows: [{ fingerprint: 'abc' }] },
    notes: [],
    analysis: {}, provider: {}, health: {}, deploy: {},
  },
});
const okTurn = async () => ({
  ok: true, status: 0, note: 'success', turns: '3', session: 'hsid',
  input: '10', output: '20', cacheRead: '30', cacheWrite: '40',
  wrote: [{ file: '2026-08-29-a.md', title: 'A' }], waiting: [{ file: '2026-08-29-a.md' }], groundNotes: [],
});

/** runs.tsv rows as objects, header and all. */
function runRows(files) {
  const tsv = files['/w/runner/log/runs.tsv'] || '';
  const lines = tsv.split('\n').filter(Boolean);
  if (!lines.length) return [];
  const header = lines[0].split('\t');
  return lines.slice(1).map((line) => Object.fromEntries(line.split('\t').map((cell, i) => [header[i], cell])));
}

/**
 * A plan as the runner now reads it: `PLAN.json`, one step, and a status that
 * belongs to the step rather than to the file. `plan()` is every fixture below
 * — the frontmatter strings these replaced could say `status: ready` while
 * saying nothing a session could act on, which is the fault the schema exists
 * to stop.
 */
function plan({ status = 'ready', title = 'The one step', done_when = 'do x', runner, steps, documents = [] } = {}) {
  const stopped = status === 'blocked';
  return JSON.stringify({
    schema: 'mc-plan',
    version: 1,
    goal: ['One thing is true when this is done.'],
    contract: ['Not without Martin.'],
    out_of_scope: ['Everything else.'],
    success_criteria: [{ met: false, criterion: 'It is done.', check: 'The row is in runs.tsv.' }],
    documents,
    ...(runner ? { runner } : {}),
    steps: steps || [{
      title,
      status,
      done_when,
      instruction: status === 'done' ? [] : ['Do the one step.'],
      pr: null,
      blocked_by: stopped ? { kind: 'decision', name: 'prog-1' } : null,
    }],
  }, null, 2);
}

const ready = plan();
const okSession = (json = {}) => () => ({ status: 0, stdout: JSON.stringify({ subtype: 'success', num_turns: 4, session_id: 'sid', usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 }, ...json }), stderr: '', timedOut: false });

test('queue: queue.md first, then plans on origin/main of both repositories', () => {
  const f = fixture({ queue: 'b\n# c\n', plans: { memoro: { a: ready, b: ready }, 'memoro-cli': { 'mc-run': ready } } });
  const runner = createRunner({ deps: f.deps });
  assert.deepEqual(runner.queue().names, ['b', 'a', 'mc-run']);
});

test('one step: worktree made from origin/main, session through the adapter, PR merged, row logged', async () => {
  const f = fixture({ plans: { memoro: { alpha: ready } }, session: okSession(), gh: { alpha: { number: 77, title: 'Alpha step' } } });
  const runner = createRunner({ deps: f.deps });
  const r = await runner.round({ once: true });
  assert.equal(r.ran, 1);
  assert.deepEqual(f.calls.added, ['alpha']);
  const [call] = f.calls.sessions;
  assert.equal(call.bin, '/bin/claude');
  assert.equal(call.cwd, '/w/alpha/memoro');
  assert.equal(call.timeoutMs, 90 * 60_000);
  assert.deepEqual(call.args.slice(2, 6), ['--model', 'opus', '--permission-mode', 'acceptEdits']);
  assert.match(call.args[1], /`alpha` workarea of memoro[\s\S]*----- PLAN\.json -----\n\{/u);
  assert.match(call.args[1], /Your step is `steps\[0\]` — 1, "The one step"/u);
  assert.match(call.args[call.args.indexOf('--append-system-prompt') + 1], /^PROFILE\n\n---\n\nROLE step$/u);
  assert.deepEqual(f.calls.rounds.map((c) => [c.repoPath, c.pr]), [['/home/memoro', 77]], 'landed through mc merge, not gh pr merge');
  const rows = f.files['/w/runner/log/runs.tsv'].trim().split('\n');
  assert.equal(rows[0].split('\t').length, 14);
  assert.equal(rows[1], '2026-08-29T10:00:00Z\talpha\tstep\t0\t0\t77\t4\t1\t2\t3\t4\tsid\tsuccess,merged\t0');
  assert.ok(f.files['/w/alpha-20260829T100000Z.json'] === undefined);
  assert.ok('/w/runner/log/alpha-20260829T100000Z.json' in f.files);
  assert.match(f.files['/w/runner/log/runner.log'], /alpha: merged #77 into main through the gate\n.*alpha: step done rc=0 0s pr=77 turns=4 note=success,merged land=0s/u);
});

test('skips: dirty worktree, a blocked step', async () => {
  const waiting = plan({ status: 'blocked' });
  const f = fixture({
    plans: { memoro: { dirty: ready, wait: waiting } },
    dirty: ['dirty'], session: okSession(),
  });
  const runner = createRunner({ deps: f.deps });
  const r = await runner.round();
  assert.equal(r.ran, 0);
  assert.equal(f.calls.sessions.length, 0);
  const log = f.files['/w/runner/log/runner.log'];
  assert.match(log, /dirty: dirty worktree \(.+\) — skipped every round until it is committed or stashed in \/w\/dirty\/memoro/u, 'the machine gets its own line, with the files and the way out');
  assert.match(log, /skipped 1 \(blocked 1\)/u, 'the plan gets a count');
  assert.doesNotMatch(log, /wait: /u, 'and no line of its own — the page already draws it');
});

/**
 * A session somebody has open in the workarea is not the runner's business.
 *
 * It used to be: a live `mc-<name>` tmux session skipped the project. That was
 * a second, undeclared way to stop work — whether a step ran depended on which
 * terminals happened to be open, which is nowhere in the plan and nothing the
 * next round remembers. A project the runner should leave alone says so where
 * every other such fact is written down, by being `blocked` in its own
 * PLAN.json (Martin, 2026-09-02).
 */
test('a live tmux session in the workarea does not stop the step', async () => {
  const f = fixture({
    plans: { memoro: { live: ready } },
    live: ['live'], session: okSession(),
  });
  const runner = createRunner({ deps: f.deps });
  const r = await runner.round();
  assert.equal(r.ran, 1);
  assert.equal(f.calls.sessions.length, 1);
  const log = f.files['/w/runner/log/runner.log'];
  assert.doesNotMatch(log, /live tmux session, skip/u);
  assert.match(log, /live: step starting/u);
});


/**
 * The round asks GitHub before it acts. The plan on origin/main and the plan
 * in the worktree both say `ready` while the step's work sits in an open pull
 * request — on 2026-09-02T04:33 that started a 120-minute Opus session to
 * rebuild `action-window` step 4 while step 4's work was open as #11241.
 */
test('an open pull request on a `<name>-<n>` branch ends that project\'s round, with a line naming it', async () => {
  const f = fixture({
    plans: { memoro: { alpha: ready } },
    openPrs: { memoro: [{ number: 11246, headRefName: 'alpha-4', baseRefName: 'main', isDraft: false, title: 'Step 4' }] },
    session: okSession(),
  });
  const runner = createRunner({ deps: f.deps });
  const r = await runner.round({ once: true });
  assert.equal(r.ran, 0);
  assert.equal(f.calls.sessions.length, 0, 'no session is spent on work that is already open');
  assert.match(f.files['/w/runner/log/runner.log'], /alpha: #11246 is open \(Step 4\) — not starting a step/u);
  assert.doesNotMatch(f.files['/w/runner/log/runs.tsv'] || '', /\talpha\t/u, 'a skip is not a run');
});

test('a pull request on another project\'s branch is not this project\'s', async () => {
  const f = fixture({
    plans: { memoro: { mc: ready, 'mc-cut': ready } },
    queue: 'mc-cut\nmc\n',
    openPrs: { memoro: [{ number: 51, headRefName: 'mc-cut-2', baseRefName: 'main', title: 'Cut' }] },
    session: okSession(),
    gh: { mc: { number: 60, title: 'Mc' } },
  });
  const runner = createRunner({ deps: f.deps });
  await runner.round({ once: true });
  assert.deepEqual(f.calls.sessions.map((c) => c.cwd), ['/w/mc/memoro'], 'mc-cut stops; mc runs');
  const log = f.files['/w/runner/log/runner.log'];
  assert.match(log, /mc-cut: #51 is open \(Cut\) — not starting a step/u);
  assert.doesNotMatch(log, /^.*\bmc: #51\b/mu);
});

/**
 * The push-guard (push-guard.js, D-0164) asks the same question at the wrong
 * end: after ninety minutes of work. `action-window` stood on a branch
 * origin/main had already swallowed and whose remote was deleted.
 */
test('a workarea whose branch has already landed is moved to `<name>-<n>` before the session starts', async () => {
  const f = fixture({
    areas: { beta: { repo: 'memoro', programme: 'prog', plan: ready } },
    plans: { memoro: { beta: ready } },
    landed: ['beta'], refs: { beta: ['beta', 'beta-2'] },
    session: okSession(), gh: { beta: { number: 88, title: 'Beta step' } },
  });
  const runner = createRunner({ deps: f.deps });
  await runner.round({ once: true });
  assert.deepEqual(f.calls.checkouts, [['/w/beta/memoro', 'beta-3']], 'beta and beta-2 are taken');
  assert.equal(f.calls.sessions.length, 1, 'the session runs, from a branch it can push');
  const order = f.calls.git.filter((c) => c[0] === '/w/beta/memoro').findIndex((c) => c.includes('checkout'));
  assert.ok(order >= 0 && f.calls.sessions.length === 1);
  assert.match(f.files['/w/runner/log/runner.log'], /beta: beta has already landed — moved to beta-3 from origin\/main/u);
  assert.match(f.files['/w/runner/log/runs.tsv'], /\tbeta\tstep\t0\t0\t88\t/u);
});

test('a workarea whose branch carries work is left exactly where it is', async () => {
  const f = fixture({
    areas: { beta: { repo: 'memoro', programme: 'prog', plan: ready } },
    plans: { memoro: { beta: ready } },
    landed: [], session: okSession(), gh: { beta: { number: 88, title: 'Beta step' } },
  });
  const runner = createRunner({ deps: f.deps });
  await runner.round({ once: true });
  assert.deepEqual(f.calls.checkouts, []);
  assert.equal(f.calls.sessions.length, 1);
});

/**
 * Not knowing what is open is what bought the 04:33 session. An idle round
 * costs ten minutes of sleep, so the round that cannot ask starts nothing.
 */
test('a repository GitHub could not be asked starts nothing, and says so', async () => {
  const f = fixture({
    plans: { memoro: { alpha: ready }, 'memoro-cli': { 'mc-run': ready } },
    prsFail: ['memoro'], session: okSession(), gh: { 'mc-run': { number: 5, title: 'Run' } },
  });
  const runner = createRunner({ deps: f.deps });
  await runner.round({ once: true });
  assert.deepEqual(f.calls.sessions.map((c) => c.cwd), ['/w/mc-run/memoro-cli'], 'the other repository is unaffected');
  const log = f.files['/w/runner/log/runner.log'];
  assert.match(log, /memoro: GitHub could not be asked what is open \(gh: not logged in\)/u);
  assert.match(log, /alpha: what is open on GitHub is unknown this round, skip/u);
});

test('the round asks GitHub once per repository, beside the fetch it already pays for', async () => {
  const f = fixture({ plans: { memoro: { alpha: ready }, 'memoro-cli': { 'mc-run': ready } } });
  const runner = createRunner({ deps: f.deps });
  const asked = runner.queue();
  const lists = f.calls.gh.filter((c) => c.includes('--limit'));
  assert.deepEqual(lists.map((c) => c[0]), ['/home/memoro', '/home/memoro-cli']);
  assert.deepEqual(asked.prs, []);
  assert.deepEqual(asked.prsFailed, []);
});

/**
 * The plan conflict, resolved by the plan's own rule and not by a session.
 *
 * 29 of the 166 conflicting files measured in runner.log were a plan, always
 * in this shape: main carries the plan a later round wrote to, the branch
 * carries the same plan with its own step edited. The rule itself is
 * plan-merge.js and is tested there; what these two ask is what the round
 * does with it — that the merge finishes and the project gets its ordinary
 * step, and that a plan the rule refuses is still left in progress.
 */
const PLAN_AT = 'docs/project/prog/c/PLAN.json';

function planStages({ bothOnStepOne = false } = {}) {
  const twoSteps = [
    { title: 'One', status: 'ready', done_when: 'x', instruction: ['Do x.'], comments: [], pr: null, blocked_by: null },
    { title: 'Two', status: 'ready', done_when: 'y', instruction: ['Do y.'], comments: [], pr: null, blocked_by: null },
  ];
  const base = JSON.parse(plan({ steps: twoSteps }));
  const main = structuredClone(base);
  main.steps[0] = { ...main.steps[0], status: 'done', pr: 601, comments: ['Step one landed.'] };
  main.success_criteria[0] = { ...main.success_criteria[0], met: true };
  const branch = structuredClone(base);
  const at = bothOnStepOne ? 0 : 1;
  branch.steps[at] = { ...branch.steps[at], comments: ['What this branch found.'] };
  const text = (value) => `${JSON.stringify(value, null, 2)}\n`;
  return { base: text(base), branch: text(branch), main: text(main) };
}

test('a PLAN.json whose two sides changed different steps is merged by the runner, and the project gets its step', async () => {
  const three = planStages();
  const f = fixture({
    areas: { c: { repo: 'memoro', programme: 'prog', plan: three.branch } },
    plans: { memoro: { c: three.main } },
    conflicts: { c: [PLAN_AT] },
    stages: { c: { [PLAN_AT]: { 1: three.base, 2: three.branch, 3: three.main } } },
    session: okSession(), gh: { c: { number: 90, title: 'Step two' } },
  });
  const runner = createRunner({ deps: f.deps });
  await runner.round({ once: true });

  const merged = JSON.parse(f.files['/w/c/memoro/docs/project/prog/c/PLAN.json']);
  assert.deepEqual(merged.steps.map((s) => [s.status, s.pr]), [['done', 601], ['ready', null]], "main's step 1 survived");
  assert.deepEqual(merged.steps.map((s) => s.comments[0]), ['Step one landed.', 'What this branch found.'], 'and so did the branch\'s step 2');
  assert.deepEqual(merged.success_criteria.map((c) => c.met), [true]);
  assert.ok(f.calls.git.some((c) => c[0] === '/w/c/memoro' && c[1] === 'add' && c.at(-1) === PLAN_AT), 'the resolution is staged');
  assert.ok(f.calls.git.some((c) => c[0] === '/w/c/memoro' && c[1] === 'commit'), 'and the merge is committed, in the runner');

  assert.equal(f.calls.sessions.length, 1, 'one session, and it is the step');
  const [call] = f.calls.sessions;
  assert.match(call.args[call.args.indexOf('--append-system-prompt') + 1], /ROLE step$/u);
  assert.match(call.args[1], /Your step is `steps\[1\]` — 2, "Two"/u);
  assert.match(f.files['/w/runner/log/runs.tsv'], /\tc\tstep\t/u);
  const log = f.files['/w/runner/log/runner.log'];
  assert.match(log, /c: docs\/project\/prog\/c\/PLAN\.json resolved by the plan's own rule — steps\[0\] from main, steps\[1\] from this branch/u);
  assert.doesNotMatch(log, /c: merge conflict in:/u);
});

test('a PLAN.json whose two sides changed the same step is left in progress, with the reason', async () => {
  const three = planStages({ bothOnStepOne: true });
  const f = fixture({
    areas: { c: { repo: 'memoro', programme: 'prog', plan: three.branch } },
    plans: { memoro: { c: three.main } },
    conflicts: { c: [PLAN_AT] },
    stages: { c: { [PLAN_AT]: { 1: three.base, 2: three.branch, 3: three.main } } },
    session: okSession(),
  });
  const runner = createRunner({ deps: f.deps });
  await runner.round({ once: true });

  assert.equal(f.files['/w/c/memoro/docs/project/prog/c/PLAN.json'], three.branch, 'the file is untouched — a refusal writes nothing');
  assert.ok(!f.calls.git.some((c) => c[1] === 'add' && c.at(-1) === PLAN_AT), 'and stages nothing');
  const log = f.files['/w/runner/log/runner.log'];
  assert.match(log, /c: docs\/project\/prog\/c\/PLAN\.json is not resolvable by the plan's rule — steps\[0\]: changed on this branch and on main both/u);
  assert.match(log, /c: merge conflict in: docs\/project\/prog\/c\/PLAN\.json/u);
});

test('a conflicting merge of origin/main becomes a reconcile step with the files named', async () => {
  const f = fixture({ areas: { c: { repo: 'memoro', programme: 'prog', plan: ready } }, plans: { memoro: { c: ready } }, conflicts: { c: ['docs/project/project_log.md'] }, session: okSession() });
  const runner = createRunner({ deps: f.deps });
  await runner.round();
  const call = f.calls.sessions[0];
  assert.match(call.args[1], /stopped on\nconflicts in: docs\/project\/project_log\.md/u);
  assert.match(call.args[call.args.indexOf('--append-system-prompt') + 1], /ROLE reconcile$/u);
  assert.match(f.files['/w/runner/log/runs.tsv'], /\tc\treconcile\t/u);
});

/**
 * The runner runs plans; it does not write them. There used to be a `triage`
 * kind here that started a headless session, invented the PLAN.md and landed
 * it on main by itself (Martin, 2026-08-29: "JAG TAR FRAM PLANER I EN mc plan
 * SESSION").
 */
test('a workarea with no plan is not in the queue, and gets no step and no skip line', async () => {
  const f = fixture({ areas: { fresh: { repo: 'memoro' } }, queue: 'fresh\n', session: okSession() });
  const runner = createRunner({ deps: f.deps });
  assert.deepEqual(runner.queue().names, [], 'queue.md named it; it has no plan, so it is not queued');
  await runner.round();
  assert.equal(f.calls.sessions.length, 0);
  assert.deepEqual(runRows(f.files).filter((r) => r.kind !== 'helper'), []);
  const log = f.files['/w/runner/log/runner.log'] || '';
  assert.doesNotMatch(log, /fresh: /u, 'no skip line — nobody reads it');
  // The two lines it does get are the two places somebody looks: the queue
  // says why the name left it, and the workarea is written for `mc brief`.
  assert.match(log, /queue: dropped "fresh" — no plan on main/u);
  assert.equal(f.files['/w/queue.md'], '', 'the queue empties itself');
  assert.match(f.files['/w/intake/unplanned-workareas.md'], /\| fresh \| memoro \|/u);
});

test('a quota answer is logged as quota, not merged, and the runner sleeps 30 minutes', async () => {
  const slept = [];
  const f = fixture({ plans: { memoro: { q: ready } }, gh: { q: { number: 5 } }, session: () => ({ status: 1, stdout: JSON.stringify({ subtype: 'success', num_turns: 1, result: "You've hit your weekly limit" }), stderr: '', timedOut: false }) });
  f.deps.sleep = async (ms) => { slept.push(ms); };
  const runner = createRunner({ deps: f.deps });
  await runner.round({ once: true });
  assert.match(f.files['/w/runner/log/runs.tsv'], /\tq\tstep\t1\t0\t5\t1\t.*\tquota\t-\n/u);
  assert.equal(f.calls.rounds.length, 0);
  assert.ok(slept.includes(30 * 60 * 1000));
});

test('a timed-out session is logged as timeout with exit 142', async () => {
  const f = fixture({ plans: { memoro: { t: ready } }, session: () => ({ status: 142, stdout: '', stderr: '', timedOut: true }) });
  const runner = createRunner({ deps: f.deps });
  await runner.round({ once: true });
  assert.match(f.files['/w/runner/log/runs.tsv'], /\tt\tstep\t142\t0\t-\t-\t-\t-\t-\t-\t-\ttimeout\t-\n/u);
});

/**
 * The landing, since 2026-09-02: `mc merge`'s own round and nothing else.
 *
 * What these replace is the old `mergePr` — `gh pr merge --squash` after
 * waiting for `mergeable`, with a sync-and-retry when it failed. It landed
 * without the gate, and it never read the base: at 13:00 that day it squashed
 * #11250 into the branch of #11249 and logged `success,merged` while `main`
 * received nothing.
 */
test('a red gate leaves the pull request open and says so in the row', async () => {
  const f = fixture({
    plans: { memoro: { m: ready } }, gh: { m: { number: 9 } }, session: okSession(),
    rounds: { 9: { ok: false, merged: false, merged_into: null, stopped_at: 'red', reason: 'two tests the change reaches are red' } },
  });
  const runner = createRunner({ deps: f.deps });
  await runner.round({ once: true });
  assert.equal(f.calls.rounds.length, 1);
  assert.match(f.files['/w/runner/log/runs.tsv'], /\tsuccess,open,gate-red\t\d+\n/u);
  assert.match(f.files['/w/runner/log/runner.log'], /m: #9 left open — two tests the change reaches are red/u);
});

/* ------------------------------------------------------- held before merge */

/**
 * `~/mc/runner/held.json` — which pull requests the runner would not land, and
 * why.
 *
 * Until now that fact lived in a runner.log line and a runs.tsv note, and
 * every one of those projects stood still until a person read the log: seven
 * of them in one evening (2026-09-03..04, #11274, #11275, #11276, #11300,
 * #11301, #559, #561). It is mc's own state beside `runner.json` — never a
 * status in a plan.
 */
const heldFile = (files) => JSON.parse(files['/w/runner/held.json'] || '[]');

test('a pull request the gate would not land is written to held.json with its reason', async () => {
  const f = fixture({
    plans: { memoro: { m: ready } }, gh: { m: { number: 9 } }, session: okSession(),
    rounds: { 9: { ok: false, merged: false, merged_into: null, stopped_at: 'red', reason: 'two tests the change reaches are red' } },
  });
  await createRunner({ deps: f.deps }).round({ once: true });
  assert.deepEqual(heldFile(f.files), [{
    project: 'm', repo: 'memoro', pr: 9, branch: 'm',
    reason: 'two tests the change reaches are red', note: 'open,gate-red',
    since: '2026-08-29T10:00:00Z', repairs: 0,
  }]);
});

test('a held pull request that lands leaves the file', async () => {
  const f = fixture({ plans: { memoro: { m: ready } } });
  f.files['/w/runner/held.json'] = JSON.stringify([
    { project: 'm', repo: 'memoro', pr: 9, branch: 'm', reason: 'two tests red', note: 'open,gate-red', since: '2026-08-28T10:00:00Z', repairs: 1 },
    { project: 'other', repo: 'memoro-cli', pr: 9, branch: 'other', reason: 'still red', note: 'open,gate-red', since: '2026-08-28T10:00:00Z', repairs: 0 },
  ]);
  const runner = createRunner({ deps: f.deps });
  const repo = runner.repos.find((r) => r.name === 'memoro');
  const landed = await runner.landProject('/w/m/memoro', repo, 'm', [{ number: 9, headRefName: 'm', baseRefName: 'main' }]);
  assert.equal(landed.note, 'merged');
  // The other repository's #9 is a different pull request: two repositories
  // number their own, so a number alone was never an identity.
  assert.deepEqual(heldFile(f.files).map((entry) => [entry.repo, entry.pr]), [['memoro-cli', 9]]);
});

test('a held pull request somebody merged or closed by hand leaves the file the next round', async () => {
  const entries = [
    { project: 'gone', repo: 'memoro', pr: 500, branch: 'gone', reason: 'two tests red', note: 'open,gate-red', since: '2026-08-28T10:00:00Z', repairs: 0 },
    { project: 'still', repo: 'memoro', pr: 501, branch: 'still', reason: 'two tests red', note: 'open,gate-red', since: '2026-08-28T11:00:00Z', repairs: 0 },
  ];
  const f = fixture({
    plans: { memoro: { m: ready } },
    openPrs: { memoro: [{ number: 501, headRefName: 'still', baseRefName: 'main', isDraft: false, title: 'Step' }] },
  });
  f.files['/w/runner/held.json'] = JSON.stringify(entries);
  createRunner({ deps: f.deps }).queue();
  assert.deepEqual(heldFile(f.files).map((entry) => entry.pr), [501]);
  assert.match(f.files['/w/runner/log/runner.log'], /held: gone #500 is no longer open — no longer held before merge/u);

  // A repository GitHub could not be asked for is unknown, not empty: nothing
  // is dropped because the network was down.
  const blind = fixture({ plans: { memoro: { m: ready } }, prsFail: ['memoro', 'memoro-cli'] });
  blind.files['/w/runner/held.json'] = JSON.stringify(entries);
  createRunner({ deps: blind.deps }).queue();
  assert.deepEqual(heldFile(blind.files).map((entry) => entry.pr), [500, 501]);
});

test('a session that changed more of the plan than its step is held, with the problems as the reason', async () => {
  const path = '/w/m/memoro/docs/project/prog/m/PLAN.json';
  const f = fixture({
    plans: { memoro: { m: ready } },
    gh: { m: { number: 9 } },
    session: (call) => {
      const after = JSON.parse(f.files[path]);
      after.goal = ['Something else entirely.'];
      f.files[path] = JSON.stringify(after, null, 2);
      return okSession()(call);
    },
  });
  await createRunner({ deps: f.deps }).round({ once: true });
  assert.equal(f.calls.rounds.length, 0, 'a trespassing session lands nothing');
  assert.deepEqual(heldFile(f.files).map((entry) => [entry.project, entry.pr, entry.note, entry.reason]), [[
    'm', 9, 'plan-trespass',
    'the session changed more of the plan than its step: goal: a step session does not change it',
  ]]);
});

test('a session that timed out with its pull request open is held too', async () => {
  const f = fixture({
    plans: { memoro: { t: ready } }, gh: { t: { number: 5 } },
    session: () => ({ status: 142, stdout: '', stderr: '', timedOut: true }),
  });
  await createRunner({ deps: f.deps }).round({ once: true });
  assert.deepEqual(heldFile(f.files).map((entry) => [entry.pr, entry.note, entry.reason]),
    [[5, 'timeout', 'the session timed out with the pull request open']]);
});

/* ------------------------------------------------------------- the repair */

/**
 * A held pull request gets one repair session — the shape `reconcile` already
 * has, for a different stop. Before this, `inFlight` refused the project every
 * round because the pull request was open, and the project stood still until a
 * person read runner.log, fixed the branch by hand and ran `mc merge`.
 *
 * One repair per pull request and no loop: still held after it, and it is the
 * brief's.
 */
const heldEntry = (over = {}) => ({
  project: 'm', repo: 'memoro', pr: 9, branch: 'm', reason: 'two tests the change reaches are red',
  note: 'open,gate-red', since: '2026-09-03T10:00:00Z', repairs: 0, ...over,
});
const heldRound = (entries, over = {}) => {
  const f = fixture({
    plans: { memoro: { m: ready } },
    openPrs: { memoro: [{ number: 9, headRefName: 'm', baseRefName: 'main', isDraft: false, title: 'Step' }] },
    gh: { m: { number: 9, title: 'Step' } },
    session: okSession(),
    ...over,
  });
  f.files['/w/runner/held.json'] = JSON.stringify(entries);
  return f;
};

test('a held pull request runs a repair session, told the pull request, the branch and what the gate saw', async () => {
  const f = heldRound([heldEntry({
    red: ['tests/a.test.js > one', 'tests/b.test.js > two'],
    gates: [{ name: 'sql:pr-ci', output: 'admission missing for 0042_x.sql' }],
  })]);
  await createRunner({ deps: f.deps }).round({ once: true });

  assert.equal(f.calls.sessions.length, 1, 'the open pull request is a repair, not a skip');
  const [call] = f.calls.sessions;
  assert.equal(call.cwd, '/w/m/memoro');
  assert.match(call.args[1], /pull request #9 the runner would not land/u);
  assert.match(call.args[1], /on branch\n`m`/u);
  assert.match(call.args[1], /two tests the change reaches are red/u);
  assert.match(call.args[1], /tests\/b\.test\.js > two/u);
  assert.match(call.args[1], /admission missing for 0042_x\.sql/u);
  assert.match(call.args[call.args.indexOf('--append-system-prompt') + 1], /ROLE repair$/u);
  assert.match(f.files['/w/runner/log/runner.log'], /m: #9 is held before merge — one repair session: two tests the change reaches are red/u);

  // The repair is counted before the session runs, not after: a session killed
  // on its budget still had its one turn.
  assert.equal(JSON.parse(f.duringSession[0]['/w/runner/held.json'])[0].repairs, 1);

  // It came back green, so the runner lands it through the same gate that
  // refused it — and nothing holds it any more.
  const [row] = runRows(f.files);
  assert.equal(row.kind, 'repair');
  assert.equal(row.note, 'success,merged');
  assert.deepEqual(f.calls.rounds.map((c) => c.pr), [9]);
  assert.deepEqual(heldFile(f.files), []);
});

test('a pull request still held after its repair waits for the brief — no second repair', async () => {
  const f = heldRound([heldEntry({ repairs: 1 })]);
  await createRunner({ deps: f.deps }).round({ once: true });
  assert.equal(f.calls.sessions.length, 0, 'one repair per pull request, and no loop');
  assert.equal(f.calls.rounds.length, 0);
  assert.match(f.files['/w/runner/log/runner.log'], /m: #9 is held before merge after a repair — the brief's/u);
  assert.deepEqual(heldFile(f.files).map((entry) => [entry.pr, entry.repairs]), [[9, 1]]);
});

test('a repair that stays red is held again, with the gate\'s new reason and its repair still counted', async () => {
  const f = heldRound([heldEntry()], {
    rounds: { 9: { ok: false, merged: false, merged_into: null, stopped_at: 'red', reason: 'one test is still red' } },
  });
  await createRunner({ deps: f.deps }).round({ once: true });
  assert.equal(f.calls.sessions.length, 1);
  assert.deepEqual(heldFile(f.files).map((entry) => [entry.pr, entry.reason, entry.repairs, entry.since]),
    [[9, 'one test is still red', 1, '2026-09-03T10:00:00Z']], 'held again keeps how long it has stood still, and that it had its repair');
});

/**
 * A trespass is the one hold whose repair cannot be judged by the plan it was
 * handed: that plan *is* the trespass. The baseline is the plan on
 * origin/main, which is the one the trespassing step began from — its work has
 * not landed, or it would not be held.
 */
test('a repair of a plan trespass is judged against origin/main, so a trespass it did not undo does not land', async () => {
  const trespassed = JSON.parse(ready);
  trespassed.goal = ['Something else entirely.'];
  const f = heldRound([heldEntry({ note: 'plan-trespass', reason: 'the session changed more of the plan than its step: goal: a step session does not change it' })], {
    areas: { m: { repo: 'memoro', programme: 'prog', plan: JSON.stringify(trespassed, null, 2) } },
  });
  await createRunner({ deps: f.deps }).round({ once: true });
  assert.match(f.calls.sessions[0].args[1], /The problems above are the plan boundary/u);
  assert.equal(f.calls.rounds.length, 0, 'a trespass the repair left in place lands nothing');
  assert.equal(runRows(f.files)[0].note, 'plan-trespass');
  assert.deepEqual(heldFile(f.files).map((entry) => [entry.note, entry.repairs]), [['plan-trespass', 1]]);
});

test('a repair that undoes the trespass lands', async () => {
  const path = '/w/m/memoro/docs/project/prog/m/PLAN.json';
  const trespassed = JSON.parse(ready);
  trespassed.goal = ['Something else entirely.'];
  const f = heldRound([heldEntry({ note: 'plan-trespass', reason: 'the session changed more of the plan than its step' })], {
    areas: { m: { repo: 'memoro', programme: 'prog', plan: JSON.stringify(trespassed, null, 2) } },
  });
  f.deps.session = (call) => {
    f.calls.sessions.push(call);
    f.files[path] = ready;
    return okSession()(call);
  };
  await createRunner({ deps: f.deps }).round({ once: true });
  assert.equal(runRows(f.files)[0].note, 'success,merged');
  assert.deepEqual(heldFile(f.files), []);
});

test('a merge that landed somewhere other than main is not recorded as merged', async () => {
  const f = fixture({
    plans: { memoro: { m: ready } }, gh: { m: { number: 11250 } }, session: okSession(),
    rounds: { 11250: { ok: true, merged: true, merged_into: 'msr-track-3-capture-command', off_default: true } },
  });
  const runner = createRunner({ deps: f.deps });
  await runner.round({ once: true });
  assert.match(f.files['/w/runner/log/runs.tsv'], /\tsuccess,off-main\t\d+\n/u);
  assert.match(f.files['/w/runner/log/runner.log'], /#11250 was merged into msr-track-3-capture-command, NOT main/u);
});

test('a pull request aimed at a branch that is nobody head lands nothing', async () => {
  const f = fixture({
    plans: { memoro: { m: ready } }, gh: { m: { number: 11250, base: 'msr-track-3-capture-command' } }, session: okSession(),
  });
  const runner = createRunner({ deps: f.deps });
  await runner.round({ once: true });
  assert.equal(f.calls.rounds.length, 0, 'nothing is handed to the merge round');
  assert.match(f.files['/w/runner/log/runs.tsv'], /\tsuccess,open,not-a-stack\t\d+\n/u);
  assert.match(f.files['/w/runner/log/runner.log'], /#11250 is aimed at msr-track-3-capture-command — none of them is aimed at main — landing none of them/u);
  // Nothing else is going to land it either, so it is held with the reason
  // rather than left to a log line.
  assert.deepEqual(heldFile(f.files).map((entry) => [entry.pr, entry.note]), [[11250, 'open,not-a-stack']]);
});

test('a stack is landed bottom first, each one above it retargeted and replayed', async () => {
  const f = fixture({
    plans: { memoro: { m: ready } },
    gh: { m: [{ number: 3, head: 'm-3', base: 'm-2' }, { number: 1, head: 'm', base: 'main' }, { number: 2, head: 'm-2', base: 'm' }] },
    session: okSession(),
  });
  const runner = createRunner({ deps: f.deps });
  await runner.round({ once: true });
  assert.deepEqual(f.calls.rounds.map((c) => c.pr), [1, 2, 3], 'bottom first, whatever order GitHub listed them in');
  assert.deepEqual(f.calls.rounds.map((c) => c.repoPath), ['/home/memoro', '/home/memoro', '/home/memoro']);
  assert.deepEqual(f.calls.git.filter((c) => c[1] === 'rebase').map((c) => c.slice(1)), [
    ['rebase', '--onto', 'origin/main', 'forked-origin/m-2', 'm-2'],
    ['rebase', '--onto', 'origin/main', 'forked-origin/m-3', 'm-3'],
  ]);
  assert.ok(f.calls.gh.some((c) => c.includes('edit') && c.includes('2') && c.includes('--base') && c.includes('main')));
  assert.match(f.files['/w/runner/log/runs.tsv'], /\tsuccess,merged\t\d+\n/u);
});

test('a stacked branch that conflicts after the one below lands is aborted, not resolved', async () => {
  const f = fixture({
    plans: { memoro: { m: ready } },
    gh: { m: [{ number: 1, head: 'm', base: 'main' }, { number: 2, head: 'm-2', base: 'm' }] },
    session: okSession(), rebaseFails: ['m-2'], conflicts: { m: ['a.js'] },
  });
  const runner = createRunner({ deps: f.deps });
  await runner.round({ once: true });
  assert.deepEqual(f.calls.rounds.map((c) => c.pr), [1], 'the one above it is not handed to the gate');
  assert.ok(f.calls.git.some((c) => c[1] === 'rebase' && c[2] === '--abort'));
  assert.match(f.files['/w/runner/log/runs.tsv'], /\tsuccess,open,stack-stopped\t\d+\n/u);
  assert.match(f.files['/w/runner/log/runner.log'], /m-2 conflicts with what just landed in: a\.js/u);
});

test('two pull requests aimed at main are not a stack and nothing lands', async () => {
  const f = fixture({
    plans: { memoro: { m: ready } },
    gh: { m: [{ number: 1, head: 'm', base: 'main' }, { number: 2, head: 'm-2', base: 'main' }] },
    session: okSession(),
  });
  const runner = createRunner({ deps: f.deps });
  await runner.round({ once: true });
  assert.equal(f.calls.rounds.length, 0);
  assert.match(f.files['/w/runner/log/runner.log'], /#1 and #2 are both aimed at main — two stacks, not one/u);
});

test('run.js has no gh pr merge left in it', () => {
  const source = readFileSync(new URL('../../src/mc/run.js', import.meta.url), 'utf8');
  assert.equal(/\[\s*'pr',\s*'merge'/u.test(source), false, 'the runner lands through mc merge and nothing else');
});

test('tool and model come from the project frontmatter', async () => {
  const codexPlan = plan({ runner: { tool: 'codex', model: 'o3', budget_minutes: 20 } });
  const f = fixture({ plans: { 'memoro-cli': { cx: codexPlan } }, session: () => ({ status: 0, stdout: '', stderr: '', timedOut: false }) });
  const runner = createRunner({ deps: f.deps });
  await runner.round({ once: true });
  const [call] = f.calls.sessions;
  assert.equal(call.bin, '/bin/codex');
  assert.equal(call.cwd, '/w/cx/memoro-cli');
  assert.equal(call.timeoutMs, 20 * 60_000);
  assert.deepEqual(call.args.slice(0, 6), ['exec', '--json', '--sandbox', 'danger-full-access', '--model', 'o3']);
});

test('a codex plan that names no model gets none, and the log says so', async () => {
  const codexPlan = plan({ runner: { tool: 'codex' } });
  const f = fixture({ plans: { 'memoro-cli': { cx: codexPlan } }, session: () => ({ status: 0, stdout: '', stderr: '', timedOut: false }) });
  const runner = createRunner({ deps: f.deps });
  await runner.round({ once: true });
  const [call] = f.calls.sessions;
  // `opus` is claude's alias; codex would die on it before reading the plan.
  assert.equal(call.args.includes('--model'), false);
  assert.equal(call.args.includes('opus'), false);
  assert.match(f.files['/w/runner/log/runner.log'], /cx: step starting \(codex own default model, 90 min\)/u);
});

test('STOP file: the loop exits after the step it is in, and refuses to start while it exists', async () => {
  const f = fixture({ plans: { memoro: { a: ready, b: ready } }, session: okSession() });
  const inner = f.deps.session;
  f.deps.session = (call) => { f.files['/w/runner/STOP'] = ''; return inner(call); };
  assert.equal(await runLoop({ rounds: 0, deps: f.deps }), 0);
  assert.equal(f.calls.sessions.length, 1);
  assert.match(f.files['/w/runner/log/runner.log'], /runner exit on STOP after a/u);
  assert.equal(await runLoop({ rounds: 1, deps: f.deps }), 2);
});

/**
 * `runner.json` as a claim that is checked. Measured 2026-09-02: two runners
 * were alive in one work root and each handed `runner-open-prs` step 3 to a
 * session in the same worktree, 100 seconds apart — because `markRunner()`
 * writes the file without ever reading it, so the second runner overwrote the
 * first and nothing anywhere said two were running.
 */
test('runLoop: a second runner refuses to start while the first is alive, and names the pid', async () => {
  const f = fixture({ plans: { memoro: { a: ready } }, session: okSession(), livePids: [7777] });
  f.files['/w/runner/runner.json'] = `${JSON.stringify({ pid: 7777, started: '2026-08-29T06:33:25Z' }, null, 2)}\n`;
  assert.equal(await runLoop({ rounds: 1, deps: f.deps }), 2);
  assert.equal(f.calls.sessions.length, 0, 'a refused runner started a step anyway');
  const log = f.files['/w/runner/log/runner.log'];
  assert.match(log, /a runner is already running — pid 7777, started 2026-08-29T06:33:25Z/u);
  assert.match(log, /mc run stop ends it · mc run --update restarts it on the newest code/u);
  assert.equal(/runner start \(mc run/u.test(log), false, 'it announced a start it did not make');
  // The holder's own file is left exactly as it was: the refusal must not be
  // the thing that makes the first runner invisible.
  assert.deepEqual(JSON.parse(f.files['/w/runner/runner.json']), { pid: 7777, started: '2026-08-29T06:33:25Z' });
});

test('runLoop: --once is refused by the same check — one worktree, one session', async () => {
  const f = fixture({ plans: { memoro: { a: ready } }, session: okSession(), livePids: [7777] });
  f.files['/w/runner/runner.json'] = `${JSON.stringify({ pid: 7777 }, null, 2)}\n`;
  assert.equal(await runLoop({ once: true, deps: f.deps }), 2);
  assert.equal(f.calls.sessions.length, 0);
  assert.match(f.files['/w/runner/log/runner.log'], /a runner is already running — pid 7777\n/u);
});

test('runLoop: a runner.json naming a pid that is gone is cleared, not a wall', async () => {
  const f = fixture({ plans: { memoro: { a: ready } }, session: okSession() });
  f.files['/w/runner/runner.json'] = `${JSON.stringify({ pid: 7777, started: '2026-08-29T06:33:25Z' }, null, 2)}\n`;
  f.files['/w/runner/current-memoro.json'] = '{}';
  assert.equal(await runLoop({ rounds: 1, deps: f.deps }), 0);
  assert.equal(f.calls.sessions.length, 1, "a killed runner's leftovers stopped the next one from running");
  assert.match(f.files['/w/runner/log/runner.log'], /cleared runner\.json — the pid it named \(7777\) is gone/u);
  assert.equal('/w/runner/current-memoro.json' in f.files, false, 'the killed runner\'s in-flight file outlived it');
});

/**
 * `mc run --update` from the runner's side: the file is read where STOP is
 * read — between rounds — and the round in flight is never cut short for it.
 */
test('UPDATE file: the loop finishes its round, then hands over to a new process', async () => {
  const f = fixture({ plans: { memoro: { a: ready } }, session: okSession() });
  const inner = f.deps.session;
  f.deps.session = (call) => { f.files['/w/runner/UPDATE'] = ''; return inner(call); };
  const handovers = [];
  f.deps.handOver = async ({ paths, say }) => {
    handovers.push(paths.update);
    say('update: handed over to pid 9001 — this runner is done');
    return { ok: true, pid: 9001 };
  };
  assert.equal(await runLoop({ rounds: 0, deps: f.deps }), 0);
  // One step ran, the round finished, and only then was the handover made.
  assert.equal(f.calls.sessions.length, 1);
  assert.deepEqual(handovers, ['/w/runner/UPDATE']);
  assert.match(f.files['/w/runner/log/runner.log'], /memoro: round 1 done \(1 ran\)\n[\s\S]*handed over to pid 9001/u);
  // The runner it handed to has written its own runner.json by now: this one
  // must not remove it on the way out.
  assert.equal('/w/runner/runner.json' in f.files, false);
  assert.equal(f.calls.removed.includes('/w/runner/runner.json'), true);
  const after = f.calls.removed.lastIndexOf('/w/runner/runner.json');
  assert.equal(f.calls.removed.slice(after + 1).includes('/w/runner/runner.json'), false,
    'runner.json was cleared a second time, after the new runner had written it');
});

test('UPDATE file: the successor starts with no refusal — runner.json is cleared before it', async () => {
  // The failure this guard could plausibly introduce: the handover starts a
  // second `mc run` while the first is still alive, on purpose. It works only
  // because `runLoop` clears runner.json *before* calling handOver, so the
  // successor reads no holder. This drives the real `handOver` and starts a
  // real successor loop from `respawn`.
  const f = fixture({ plans: { memoro: { a: ready } }, session: okSession(), livePids: [4242] });
  const inner = f.deps.session;
  f.deps.session = (call) => { f.files['/w/runner/UPDATE'] = ''; return inner(call); };
  let successor = null;
  let holderAtRespawn = null;
  f.deps.respawn = () => {
    holderAtRespawn = f.files['/w/runner/runner.json'] ?? null;
    successor = runLoop({ once: true, deps: { ...f.deps, pid: 9001, session: inner } });
    return 9001;
  };
  assert.equal(await runLoop({ rounds: 0, deps: f.deps }), 0);
  assert.equal(holderAtRespawn, null, 'the successor was started while runner.json still named the runner handing over');
  assert.equal(await successor, 0, 'the successor refused to start');
  const log = f.files['/w/runner/log/runner.log'];
  assert.equal(/a runner is already running/u.test(log), false, 'the handover tripped the holder refusal');
  // `respawn` starts the successor before `handOver` gets to say it handed
  // over, so the successor's own start line is the earlier of the two.
  assert.match(log, /runner start \(mc run, merge=1 rounds=0 once=1\)[\s\S]*handed over to pid 9001/u);
});

test('UPDATE file: a handover that does not start keeps this runner going', async () => {
  const f = fixture({ plans: { memoro: { a: ready } }, session: okSession(), runs: null });
  f.files['/w/runner/UPDATE'] = '';
  f.deps.handOver = async ({ say }) => { say('update: the new runner did not start'); return { ok: false }; };
  assert.equal(await runLoop({ rounds: 1, deps: f.deps }), 0);
  assert.match(f.files['/w/runner/log/runner.log'], /runner exit after 1 round/u);
});

/**
 * The other writer of UPDATE, and the only one that is not a person: a
 * landing that changed mc's own code.
 *
 * Measured 2026-09-02 — a step migrated every plan on both mains, the runner
 * re-read them with the `plan-schema.js` it had loaded at process start, they
 * did not parse, and the session was logged `plan-trespass` for it. The round
 * that produced the change cannot be saved; the next one can.
 */
test('a landing that changed src/mc/ writes UPDATE itself', async () => {
  const f = fixture({
    plans: { 'memoro-cli': { m: ready } }, gh: { m: { number: 9 } }, session: okSession(),
    prFiles: { 9: ['src/mc/plan-schema.js', 'tests/mc/plan-schema.test.js'] },
  });
  await createRunner({ deps: f.deps }).round({ once: true });
  assert.match(f.files['/w/runner/log/runs.tsv'], /\tsuccess,merged\t\d+\n/u, 'it landed as usual');
  assert.ok('/w/runner/UPDATE' in f.files, 'the runner merged its own code and asked for nothing');
  assert.match(f.files['/w/runner/log/runner.log'], /m: #9 changed mc's own code \(src\/mc\/plan-schema\.js\) — UPDATE written/u);
  // GitHub's own file list for the merged pull request, not the gate's report
  // and not a local diff — the same question `mc merge --docs` asks.
  assert.deepEqual(
    f.calls.gh.filter((call) => call[1] === 'pr' && call[2] === 'view'),
    [['/home/memoro-cli', 'pr', 'view', '9', '--json', 'files', '-q', '.files[].path']],
  );
});

test('a landing that changed canon/ writes UPDATE too — the roles are quoted into the next prompt', async () => {
  const f = fixture({
    plans: { 'memoro-cli': { m: ready } }, gh: { m: { number: 9 } }, session: okSession(),
    prFiles: { 9: ['canon/roles/step.md'] },
  });
  await createRunner({ deps: f.deps }).round({ once: true });
  assert.ok('/w/runner/UPDATE' in f.files);
});

test('a landing that touched neither src/mc/ nor canon/ writes nothing', async () => {
  const f = fixture({
    plans: { 'memoro-cli': { m: ready } }, gh: { m: { number: 9 } }, session: okSession(),
    // The near misses on purpose: a prefix is a prefix, so `src/mcp/` is not
    // `src/mc/` and `canonical.md` is not `canon/`. A handover costs a fresh
    // process, and most memoro-cli landings are these.
    prFiles: { 9: ['docs/technical/mc-run.md', 'src/mcp/server.js', 'canonical.md', 'tests/mc/run.test.js'] },
  });
  await createRunner({ deps: f.deps }).round({ once: true });
  assert.match(f.files['/w/runner/log/runs.tsv'], /\tsuccess,merged\t\d+\n/u);
  assert.equal('/w/runner/UPDATE' in f.files, false, 'a handover was asked for that nothing needed');
  assert.equal(/UPDATE written/u.test(f.files['/w/runner/log/runner.log']), false);
});

test('a landing whose files GitHub will not name asks for no update, and says why', async () => {
  const f = fixture({ plans: { 'memoro-cli': { m: ready } }, gh: { m: { number: 9 } }, session: okSession() });
  const inner = f.deps.gh;
  f.deps.gh = (cwd, args) => (args[1] === 'view' && args.includes('files')
    ? { ok: false, stdout: '', stderr: 'gh: not logged in' }
    : inner(cwd, args));
  await createRunner({ deps: f.deps }).round({ once: true });
  assert.equal('/w/runner/UPDATE' in f.files, false);
  assert.match(f.files['/w/runner/log/runner.log'], /could not be asked which files #9 changed \(gh: not logged in\) — no update requested/u);
});

test('STOP already written: the code lands, and the next runner reads it because it is a new process', async () => {
  const f = fixture({
    plans: { 'memoro-cli': { m: ready } }, gh: { m: { number: 9 } }, session: okSession(),
    prFiles: { 9: ['src/mc/run.js'] },
  });
  const inner = f.deps.session;
  f.deps.session = (call) => { f.files['/w/runner/STOP'] = ''; return inner(call); };
  await createRunner({ deps: f.deps }).round({ once: true });
  assert.equal('/w/runner/UPDATE' in f.files, false, 'an UPDATE left for whoever starts the next runner by hand');
  assert.match(f.files['/w/runner/log/runner.log'], /STOP is written — the next runner starts on it anyway/u);
});

test('the loop hands over after a round that landed mc own code, with nobody typing --update', async () => {
  const f = fixture({
    plans: { 'memoro-cli': { m: ready } }, gh: { m: { number: 9 } }, session: okSession(),
    prFiles: { 9: ['src/mc/run.js'] },
  });
  const handovers = [];
  f.deps.handOver = async ({ paths, say }) => {
    handovers.push(paths.update);
    say('update: handed over to pid 9001 — this runner is done');
    return { ok: true, pid: 9001 };
  };
  assert.equal(await runLoop({ rounds: 1, deps: f.deps }), 0);
  assert.deepEqual(handovers, ['/w/runner/UPDATE'], 'the round boundary reader never saw the flag');
  // The round finished first: the flag is written while the landing happens
  // and read between rounds, never mid-session.
  const log = f.files['/w/runner/log/runner.log'];
  assert.match(log, /UPDATE written[\s\S]*round 1 done \([0-9]+ ran\)\n.*handed over to pid 9001/u);
  // Once, however many times the lane came back to the same project: the
  // flag is a file, and a second write would be a second line saying so.
  assert.equal(log.match(/UPDATE written/gu).length, 1);
});

test('runLoop: --rounds 1 does one pass and exits; --once exits after the first step', async () => {
  const f = fixture({ plans: { memoro: { a: ready, b: ready } }, session: okSession() });
  assert.equal(await runLoop({ rounds: 1, deps: f.deps }), 0);
  assert.equal(f.calls.sessions.length, 2);
  assert.match(f.files['/w/runner/log/runner.log'], /round 1 done \(2 ran\)\n.*runner exit after 1 round/u);
  const g = fixture({ plans: { memoro: { a: ready, b: ready } }, session: okSession() });
  assert.equal(await runLoop({ once: true, deps: g.deps }), 0);
  assert.equal(g.calls.sessions.length, 1);
});

test('current-<repo>.json exists only while the step is in flight, and runner.json only while the loop runs', async () => {
  const f = fixture({ plans: { memoro: { alpha: ready } }, session: okSession(), gh: { alpha: { number: 77 } } });
  assert.equal(await runLoop({ once: true, deps: f.deps }), 0);

  const during = f.duringSession[0];
  assert.deepEqual(JSON.parse(during['/w/runner/current-memoro.json']), {
    name: 'alpha', kind: 'step', repo: 'memoro', lane: 0, tool: 'claude', model: 'opus', budget_minutes: 90,
    started: '2026-08-29T10:00:00Z', pid: 4242, worktree: '/w/alpha/memoro',
  });
  assert.deepEqual(JSON.parse(during['/w/runner/runner.json']), { pid: 4242, started: '2026-08-29T10:00:00Z' });

  // ...and both are gone once the step and the loop are over.
  assert.equal('/w/runner/current-memoro.json' in f.files, false);
  assert.equal('/w/runner/runner.json' in f.files, false);
});

test('the current file carries the project frontmatter, and is removed even when the session throws', async () => {
  const codexPlan = plan({ runner: { tool: 'codex', model: 'o3', budget_minutes: 20 } });
  const f = fixture({ plans: { 'memoro-cli': { cx: codexPlan } }, session: () => { throw new Error('boom'); } });
  const runner = createRunner({ deps: f.deps });
  await assert.rejects(runner.round({ once: true }), /boom/u);
  assert.deepEqual(JSON.parse(f.duringSession[0]['/w/runner/current-memoro-cli.json']), {
    name: 'cx', kind: 'step', repo: 'memoro-cli', lane: 0, tool: 'codex', model: 'o3', budget_minutes: 20,
    started: '2026-08-29T10:00:00Z', pid: 4242, worktree: '/w/cx/memoro-cli',
  });
  assert.equal('/w/runner/current-memoro-cli.json' in f.files, false);
});

/* ---------------------------------------------------------------- lanes */

/**
 * One lane per repository, both inside the one `mc run` process. The steps
 * of memoro and memoro-cli never touch — different main branches, different
 * worktrees, different PRs — so a round is as slow as the slower repository
 * rather than as slow as both.
 */
test('two lanes: a memoro step and a memoro-cli step are in flight at the same time', async () => {
  const inFlight = new Set();
  const seen = [];
  let release = () => {};
  const both = new Promise((resolve) => { release = resolve; });
  const f = fixture({
    plans: { memoro: { alpha: ready }, 'memoro-cli': { beta: ready } },
    session: async (call) => {
      inFlight.add(call.cwd);
      seen.push([...inFlight].sort());
      if (inFlight.size === 2) release();
      await both;
      inFlight.delete(call.cwd);
      return okSession()();
    },
  });
  const guard = setTimeout(release, 5000);
  await createRunner({ deps: f.deps }).round();
  clearTimeout(guard);

  assert.deepEqual(seen.at(-1), ['/w/alpha/memoro', '/w/beta/memoro-cli'], 'both sessions were running at once');
  // And each lane said so in its own file, both present at the same moment.
  const during = f.duringSession.at(-1);
  assert.equal(JSON.parse(during['/w/runner/current-memoro.json']).name, 'alpha');
  assert.equal(JSON.parse(during['/w/runner/current-memoro-cli.json']).name, 'beta');
  assert.match(f.files['/w/runner/log/runner.log'], /lanes: memoro \(1\), memoro-cli \(1\)/u);
});

test('the queue is split by repository, and Martin\'s order holds within a lane', () => {
  const f = fixture({
    queue: 'mc-run\nalpha\n',
    plans: { memoro: { alpha: ready, gamma: ready }, 'memoro-cli': { 'mc-run': ready } },
  });
  const runner = createRunner({ deps: f.deps });
  const { names, plans } = runner.queue();
  assert.deepEqual(names, ['mc-run', 'alpha', 'gamma']);
  assert.deepEqual(runner.splitLanes(names, plans), [
    { repo: 'memoro-cli', names: ['mc-run'] },
    { repo: 'memoro', names: ['alpha', 'gamma'] },
  ]);
});

test('one repository with ready plans is one lane, and a round is what it was', async () => {
  const f = fixture({ plans: { memoro: { a: ready, b: ready } }, session: okSession() });
  await createRunner({ deps: f.deps }).round();
  assert.deepEqual(f.calls.sessions.map((call) => call.cwd), ['/w/a/memoro', '/w/b/memoro']);
  assert.doesNotMatch(f.files['/w/runner/log/runner.log'], /lanes:/u, 'nothing to say about lanes when there is one');
});

/**
 * What a round *touches*. The plans are already in hand when a lane starts —
 * `queue()` read them off origin/main — so a project its own plan refuses is
 * passed over before a worktree, a `git status` or a fetch is spent on it.
 * The round of 2026-09-02T18:17 spent 51 seconds walking 38 projects to
 * start one, 21 of them blocked on a decision nothing can answer.
 */
test('the plan is asked before git: only the ready project\'s workarea is touched', async () => {
  const stopped = plan({ status: 'blocked' });
  const names = Array.from({ length: 20 }, (unused, i) => `stopped-${String(i + 1).padStart(2, '0')}`);
  const plans = { memoro: { zeta: ready } };
  for (const name of names) plans.memoro[name] = stopped;
  const f = fixture({ plans, session: okSession() });
  const r = await createRunner({ deps: f.deps }).round();

  assert.equal(r.ran, 1);
  assert.deepEqual(f.calls.sessions.map((call) => call.cwd), ['/w/zeta/memoro']);
  // The whole point: every git call under the work root belongs to `zeta`.
  const touched = [...new Set(f.calls.git.map((call) => call[0]).filter((cwd) => cwd.startsWith('/w/')))];
  assert.deepEqual(touched, ['/w/zeta/memoro'], `git was asked about ${touched.join(', ')}`);
  assert.deepEqual(f.calls.added, ['zeta'], 'no workarea is made for a project the plan already refuses');
  // And the twenty are one line, not twenty.
  const log = f.files['/w/runner/log/runner.log'];
  assert.match(log, /skipped 20 \(blocked 20\)/u);
  for (const name of names) assert.doesNotMatch(log, new RegExp(`${name}: `, 'u'));
});

/**
 * The filter is re-applied, not computed once: `runLane` re-reads the plans
 * after a step merges, and the plan that merge advanced is the one that
 * decides whether the lane stays.
 */
test('a plan that stopped while the lane stayed on it is not stepped again', async () => {
  const plans = { memoro: { go: ready } };
  const f = fixture({
    plans,
    gh: { go: { number: 7 } },
    // What the step did: the plan it edited says `blocked` from now on.
    session: (call) => { plans.memoro.go = plan({ status: 'blocked' }); return okSession()(call); },
  });
  const r = await createRunner({ deps: f.deps }).round();

  assert.equal(r.ran, 1);
  assert.equal(f.calls.sessions.length, 1, 'the lane stayed on a project whose plan had stopped');
  const log = f.files['/w/runner/log/runner.log'];
  assert.match(log, /skipped 1 \(blocked 1\)/u, 'the lane let go, counted like any other refusal on the plan');
  assert.doesNotMatch(log, /staying on go/u);
});

/**
 * What a round *says*. A plan-shaped refusal is already drawn by `mc status`'s
 * QUEUE, from the same `kindFor` — so the twenty-first `blocked on decision
 * plan-review` in runner.log is a line nobody reads, and it buries the ones
 * somebody must (Martin, 2026-09-02).
 */
test('a round that can start nothing says so in one line, not one line per project', async () => {
  const stopped = plan({ status: 'blocked' });
  const names = Array.from({ length: 20 }, (unused, i) => `stopped-${String(i + 1).padStart(2, '0')}`);
  const plans = { memoro: {} };
  for (const name of names) plans.memoro[name] = stopped;
  const f = fixture({ plans, session: okSession() });
  const r = await createRunner({ deps: f.deps }).round();

  assert.equal(r.ran, 0);
  assert.equal(f.calls.sessions.length, 0);
  const lines = (f.files['/w/runner/log/runner.log'] || '').trim().split('\n');
  const summary = lines.filter((line) => /skipped \d/u.test(line));
  assert.equal(summary.length, 1, `one line, not ${summary.length}`);
  assert.match(summary[0], /skipped 20 \(blocked 20\)$/u);
  for (const name of names) assert.doesNotMatch(lines.join('\n'), new RegExp(`${name}: `, 'u'));
});

test('the reasons are counted in the shape the page uses, and a plan that does not parse is named', async () => {
  const f = fixture({
    plans: {
      memoro: {
        wait: plan({ status: 'blocked' }),
        broken: '{ "schema": "mc-plan"',
        alsobroken: 'not json at all',
      },
    },
    session: okSession(),
  });
  await createRunner({ deps: f.deps }).round();

  // Reasons in the order the queue met them; `done` is not among them because
  // a plan that says done is archived before the lane starts.
  const log = f.files['/w/runner/log/runner.log'];
  assert.match(log, /skipped 3 \(unparseable 2, blocked 1\) — the plans that do not parse: alsobroken, broken$/mu);
});

/**
 * The other half of the same rule: a project passed over for something about
 * this machine rather than about its plan keeps its own named line. A dirty
 * worktree is usually somebody's unfinished work about to be stepped on;
 * nothing else records any of these.
 */
test('a skip that is about the machine keeps its own line: dirty, in flight, unpushable', async () => {
  const f = fixture({
    plans: {
      memoro: {
        dirt: ready, flight: ready, stuck: ready, wait: plan({ status: 'blocked' }),
      },
    },
    dirty: ['dirt'],
    openPrs: { memoro: [{ number: 11246, headRefName: 'flight-2', baseRefName: 'main', isDraft: false, title: 'Step 2' }] },
    landed: ['stuck'], refs: { stuck: ['stuck'] },
    session: okSession(),
  });
  // The branch `stuck` stands on has landed, and the one it would move to
  // cannot be made — a session there could not push what it wrote.
  const git = f.deps.git;
  f.deps.git = (cwd, args) => (args[0] === 'checkout' && cwd === '/w/stuck/memoro'
    ? { ok: false, stdout: '', stderr: 'no' }
    : git(cwd, args));

  const r = await createRunner({ deps: f.deps }).round();

  assert.equal(r.ran, 0);
  assert.equal(f.calls.sessions.length, 0);
  const log = f.files['/w/runner/log/runner.log'];
  assert.match(log, /dirt: dirty worktree \(.+\) — skipped every round/u);
  assert.match(log, /flight: #11246 is open \(Step 2\) — not starting a step/u);
  assert.match(log, /stuck: stuck has landed and stuck-2 could not be made, skip/u);
  // And the one refusal that is on the plan is the only one counted.
  assert.match(log, /skipped 1 \(blocked 1\)$/mu);
});

/**
 * The 5-hour Claude quota is one budget for both lanes: the lane that is
 * refused sleeps, and the other joins that same sleep rather than spending a
 * session to be told the same thing.
 */
test('a quota answer in one lane pauses the other, and there is one sleep, not two', async () => {
  const events = [];
  let releaseA = () => {};
  const aGate = new Promise((resolve) => { releaseA = resolve; });
  const quota = { status: 1, stdout: JSON.stringify({ subtype: 'success', num_turns: 1, result: "You've hit your weekly limit" }), stderr: '', timedOut: false };
  const f = fixture({
    plans: { memoro: { q: ready }, 'memoro-cli': { a: ready, b: ready } },
    session: async (call) => {
      const name = call.cwd.split('/')[2];
      events.push(`start ${name}`);
      if (name === 'a') await aGate;
      return name === 'q' ? quota : okSession()();
    },
  });
  f.deps.sleep = async (ms) => {
    if (ms !== 30 * 60 * 1000) return;
    events.push('sleep');
    releaseA();
    // Long enough for the other lane to finish its step and want the next
    // one; it must not get one until this sleep is over.
    await new Promise((resolve) => { setTimeout(resolve, 5); });
    events.push('woke');
  };
  await createRunner({ deps: f.deps }).round();

  assert.equal(events.filter((event) => event === 'sleep').length, 1, 'one sleep for both lanes');
  assert.ok(events.indexOf('start b') > events.indexOf('woke'),
    `the other lane waited out the quota sleep: ${events.join(', ')}`);
  assert.match(f.files['/w/runner/log/runner.log'], /quota\/rate limit seen — every lane sleeping 30m/u);
});

test('STOP ends both lanes after the step each is in', async () => {
  const f = fixture({
    plans: { memoro: { a: ready, a2: ready }, 'memoro-cli': { b: ready, b2: ready } },
    session: okSession(),
  });
  const inner = f.deps.session;
  f.deps.session = async (call) => { f.files['/w/runner/STOP'] = ''; return inner(call); };
  assert.equal(await runLoop({ rounds: 0, deps: f.deps }), 0);
  assert.equal(f.calls.sessions.length, 2, 'one step in each lane, and no more');
  assert.deepEqual(f.calls.sessions.map((call) => call.cwd).sort(), ['/w/a/memoro', '/w/b/memoro-cli']);
  assert.match(f.files['/w/runner/log/runner.log'], /runner exit on STOP after a\b/u);
  assert.match(f.files['/w/runner/log/runner.log'], /runner exit on STOP after b\b/u);
});

/* ------------------------------------------------------------- the helper */

/**
 * `mc helper` is the one thing in a round that is not a step. It opens no
 * worktree and touches no branch: what proves it ran is its row in runs.tsv,
 * and that row is also the gate — there is no second stamp file to fall out
 * of step with it.
 */
test('the helper runs once per calendar day, logged as kind helper with helper in the name', async () => {
  const f = fixture({ plans: { memoro: { alpha: ready } }, session: okSession(), gh: { alpha: { number: 7 } } });
  const runner = createRunner({ deps: f.deps });
  await runner.round();
  const first = runRows(f.files).filter((r) => r.kind === 'helper');
  // One row per repository: memoro's production is the deployed service,
  // memoro-cli's is this machine, and a single row could not say which of
  // them failed.
  assert.equal(first.length, 2);
  assert.deepEqual(
    first.map((r) => ({ name: r.name, exit: r.exit, pr: r.pr, note: r.note })),
    [
      { name: 'helper', exit: '0', pr: '-', note: 'memoro,success,1-proposals' },
      { name: 'helper', exit: '0', pr: '-', note: 'memoro-cli,success,1-proposals' },
    ],
  );
  assert.equal(first[0].turns, '3', 'the turn is a model call and its usage is logged like a step');
  assert.equal(first[0].cache_read, '30');
  assert.deepEqual(f.calls.collects.map((c) => c.repo), ['memoro', 'memoro-cli']);

  await runner.round();
  assert.equal(runRows(f.files).filter((r) => r.kind === 'helper').length, 2, 'a second round the same day does not run it again');
  assert.equal(f.calls.collects.length, 2);
  assert.ok(f.log.some((line) => /already ran today/u.test(line)) === false, 'the gate is silent — nobody reads a skip line');
});

test('the helper waits for 05:00Z, and runs in the first round after it', async () => {
  const early = fixture({ now: '2026-08-29T04:59:00Z' });
  await createRunner({ deps: early.deps }).round();
  assert.equal(early.calls.collects.length, 0);
  assert.equal(runRows(early.files).length, 0);

  const late = fixture({ now: '2026-08-29T05:00:00Z' });
  await createRunner({ deps: late.deps }).round();
  assert.equal(late.calls.collects.length, 2, 'both repositories, once the day has started');
});

test('yesterday\'s helper row does not count as today\'s', async () => {
  const yesterday = 'ts\tname\tkind\texit\tseconds\tpr\tturns\tinput\toutput\tcache_read\tcache_write\tsession\tnote\n'
    + '2026-08-28T06:00:00Z\thelper\thelper\t0\t120\t-\t3\t-\t-\t-\t-\t-\tsuccess,0-proposals\n';
  const f = fixture({ runs: yesterday });
  await createRunner({ deps: f.deps }).round();
  assert.equal(f.calls.collects.length, 2);
  assert.equal(runRows(f.files).filter((r) => r.kind === 'helper').length, 3, 'yesterday\'s one row plus today\'s two');
});

/**
 * A failed collect is a logged fact, not a retry loop: production being
 * unreachable at 05:00 must not cost twenty attempts before noon.
 */
test('a failed collect is logged and never retried within the day', async () => {
  const f = fixture({ collect: async () => { throw new Error('wrangler is not logged in'); } });
  const runner = createRunner({ deps: f.deps });
  await runner.round();
  const row = runRows(f.files).find((r) => r.kind === 'helper');
  assert.equal(row.note, 'collect-failed');
  assert.equal(row.exit, '1');
  assert.equal(f.calls.turns.length, 0, 'no turn is run over a digest that was never written');
  assert.ok(f.log.some((line) => /memoro: the collect step failed — wrangler is not logged in/u.test(line)));

  await runner.round();
  assert.equal(f.calls.collects.length, 2, 'both were tried once; neither is retried today');
});

/**
 * One repository failing must not silence the other. memoro's collect needs
 * wrangler and the network; memoro-cli's reads four files on this disk. They
 * do not share a failure domain, and the digest has always reported per
 * section rather than failing as a unit for exactly that reason.
 */
test('a repository whose collect throws does not cost the other its digest', async () => {
  const f = fixture({
    collect: async (options) => {
      if (options.repo === 'memoro') throw new Error('wrangler is not logged in');
      return { path: '/w/intake/errors-memoro-cli-2026-08-29.md', text: '# mc itself', repo: 'memoro-cli', data: { delta: { first: true, fingerprints: [], failing: [] }, errors: { rows: [] }, notes: [] } };
    },
  });
  await createRunner({ deps: f.deps }).round();
  const rows = runRows(f.files).filter((r) => r.kind === 'helper');
  assert.equal(rows.length, 1, 'the repository that worked still logged its turn');
  assert.match(rows[0].note, /^memoro-cli,/u);
  assert.equal(f.calls.turns.length, 1, 'a turn ran over the digest that was written');
  assert.ok(f.log.some((line) => /memoro: the collect step failed/u.test(line)));
});

test('a turn that did not finish is logged under its own reason, and still counts as the day\'s run', async () => {
  const f = fixture({ helperTurn: async () => ({ ok: false, reason: 'no-tool', note: 'claude is not on PATH', wrote: [] }) });
  const runner = createRunner({ deps: f.deps });
  await runner.round();
  const row = runRows(f.files).find((r) => r.kind === 'helper');
  assert.equal(row.note, 'memoro,no-tool');
  assert.equal(row.exit, '1');
  await runner.round();
  assert.equal(f.calls.collects.length, 2);
});

test('--once is one step and no helper', async () => {
  const f = fixture({ plans: { memoro: { alpha: ready } }, session: okSession(), gh: { alpha: { number: 7 } } });
  await createRunner({ deps: f.deps }).round({ once: true });
  assert.equal(f.calls.collects.length, 0, '--once exists to watch one step, not to call production');
  assert.equal(runRows(f.files).filter((r) => r.kind === 'helper').length, 0);
});

test('a STOP file stops the helper as well as the steps', async () => {
  const f = fixture();
  f.files['/w/runner/STOP'] = '';
  await createRunner({ deps: f.deps }).round();
  assert.equal(f.calls.collects.length, 0);
});

/* ----------------------------------------------------------- archiving */

/**
 * A plan that reaches `done` is archived (Martin, 2026-08-29: "När en plan
 * är DONE ska den arkiveras. Punkt."). The runner used to answer a done plan
 * with a skip line and nothing else — measured on 2026-08-29, ten directories
 * under `docs/project/` in the two repositories held a plan that said `done`,
 * and `docs/plans/`, the directory `docs/project/` replaced, had reached 656
 * files the same way.
 */
// A finished project names the note it left behind: the archiver reads the
// row's doc cell out of the plan's own documents.
const done = (title = 'Close-out') => plan({
  status: 'done',
  title,
  documents: [{ label: 'What now exists', path: 'docs/technical/d.md' }],
});
const LOG_HEAD = '# Project log\n\n## Log\n\n| date | programme | project | outcome | summary | doc | pointer |\n|---|---|---|---|---|---|---|\n';

test('a done plan is archived in the round it is read: directory removed, row written, one PR merged', async () => {
  const f = fixture({
    plans: { memoro: { over: done('The rule'), alpha: ready } },
    projectLog: { memoro: LOG_HEAD },
    session: okSession(),
  });
  await createRunner({ deps: f.deps }).round();

  const wt = '/w/runner/archive/memoro';
  assert.deepEqual(f.calls.rm, ['docs/project/prog/over'], 'the project directory, and nothing else');
  assert.equal(`${wt}/docs/project/prog/over/PLAN.json` in f.files, false);
  assert.equal(`${wt}/docs/project/prog/alpha/PLAN.json` in f.files, true, 'every other directory is untouched');

  const row = f.files[`${wt}/docs/project/project_log.md`].trim().split('\n').at(-1);
  assert.equal(row, '| 2026-08-29 | prog | over | delivered | The rule | [docs/technical/d.md](../technical/d.md) | abc1234 |');

  assert.ok(f.calls.gh.some((c) => c[0] === wt && c[2] === 'create' && c.includes('Archive 1 done project: over')));
  assert.deepEqual(f.calls.docsRounds.map((c) => [c.repoPath, c.pr]), [[wt, 900]], 'the archive PR lands through mc merge --docs');
  assert.ok(f.calls.git.some((c) => c[0] === '/home/memoro' && c[1] === 'worktree' && c[2] === 'remove'), 'the archive worktree is taken down again');

  const runnerLog = f.files['/w/runner/log/runner.log'];
  assert.match(runnerLog, /archive: memoro prog\/over removed — row added to project_log\.md/u);
  assert.doesNotMatch(runnerLog, /over: status done, skip/u, 'the plan is gone, so there is no skip line to read');
  assert.deepEqual(f.calls.sessions.map((call) => call.cwd), ['/w/alpha/memoro'], 'the ready plan still had its step');
});

test('a row its close-out already wrote is kept: only the directory goes, and there is still exactly one row', async () => {
  const already = `${LOG_HEAD}| 2026-08-01 | prog | mc-ui | delivered | Made bare mc the one page. | [docs/technical/mc-ui.md](../technical/mc-ui.md) | [#430](https://github.com/o/r/pull/430) |\n`;
  const f = fixture({
    plans: { 'memoro-cli': { 'mc-ui': done() } },
    projectLog: { 'memoro-cli': already },
    session: okSession(),
  });
  await createRunner({ deps: f.deps }).round();
  const text = f.files['/w/runner/archive/memoro-cli/docs/project/project_log.md'];
  assert.equal(text, already, 'the row is preferred, never rewritten');
  assert.equal(text.split('\n').filter((line) => line.includes('| mc-ui |')).length, 1);
  assert.deepEqual(f.calls.rm, ['docs/project/prog/mc-ui']);
  assert.match(f.files['/w/runner/log/runner.log'], /archive: memoro-cli prog\/mc-ui removed — row already written/u);
});

test('a programme left empty by its last project goes with it; the log and the prose beside it stay', async () => {
  const f = fixture({
    plans: { memoro: { one: done(), two: done() } },
    projectLog: { memoro: LOG_HEAD },
    session: okSession(),
  });
  await createRunner({ deps: f.deps }).round();
  const wt = '/w/runner/archive/memoro';
  assert.deepEqual(f.calls.rm.sort(), ['docs/project/prog/one', 'docs/project/prog/two']);
  assert.deepEqual(Object.keys(f.files).filter((p) => p.startsWith(`${wt}/docs/project/prog/`)), [],
    'nothing of the programme is left, so the directory is gone with its last project');
  assert.equal(`${wt}/docs/project/project_log.md` in f.files, true);
  assert.equal(f.files[`${wt}/docs/project/project_log.md`].split('\n').filter((l) => l.startsWith('| 2026-08-29')).length, 2);
  assert.ok(f.calls.gh.some((c) => c[2] === 'create' && c.includes('Archive 2 done projects: one, two')), 'one PR for the repository');
});

test('a project with no docs/technical note is recorded in intake, and archived all the same', async () => {
  const f = fixture({
    plans: { memoro: { thin: plan({ status: 'done', title: 'Step 1' }) } },
    projectLog: { memoro: LOG_HEAD },
    session: okSession(),
  });
  await createRunner({ deps: f.deps }).round();
  assert.deepEqual(f.calls.rm, ['docs/project/prog/thin'], 'a thin note never stops an archive');
  const intake = f.files['/w/intake/undocumented-closures.md'];
  assert.match(intake, /# Projects archived with no docs\/technical\/ note/u);
  assert.match(intake, /\| 2026-08-29 \| memoro \| prog \| thin \| abc1234 \|/u);
  assert.match(f.files['/w/runner/log/runner.log'], /archive: thin names no docs\/technical\/ note — recorded for mc brief/u);
});

test('an archive PR still open from an earlier round holds the next one off', async () => {
  const f = fixture({
    plans: { memoro: { over: done() } },
    archive: { memoro: { openFromEarlierRound: 812 } },
    session: okSession(),
  });
  await createRunner({ deps: f.deps }).round();
  assert.deepEqual(f.calls.rm, [], 'nothing is removed twice');
  assert.ok(!f.calls.git.some((c) => c[1] === 'worktree' && c[2] === 'add'));
  assert.match(f.files['/w/runner/log/runner.log'], /archive: memoro #812 is still open from an earlier round — not opening another/u);
});

test('both repositories archive in the same round, one PR each', async () => {
  const f = fixture({
    plans: { memoro: { a: done() }, 'memoro-cli': { b: done() } },
    projectLog: { memoro: LOG_HEAD, 'memoro-cli': LOG_HEAD },
    archive: { memoro: { number: 901 }, 'memoro-cli': { number: 902 } },
    session: okSession(),
  });
  await createRunner({ deps: f.deps }).round();
  const created = f.calls.gh.filter((c) => c[2] === 'create').map((c) => c[0]);
  assert.deepEqual(created.sort(), ['/w/runner/archive/memoro', '/w/runner/archive/memoro-cli']);
  assert.equal(f.calls.sessions.length, 0, 'nothing was ready, so nothing else happened');
});

test('--once is one step and no archiving', async () => {
  const f = fixture({ plans: { memoro: { over: done(), alpha: ready } }, session: okSession(), gh: { alpha: { number: 7 } } });
  await createRunner({ deps: f.deps }).round({ once: true });
  assert.deepEqual(f.calls.rm, [], '--once exists to watch one step, not to change main');
  assert.deepEqual(f.calls.sessions.map((call) => call.cwd), ['/w/alpha/memoro']);
});

/* ------------------------------------------------------------- closing */

/**
 * A workarea outlives its plan for the reason a done plan used to outlive
 * its project: nothing removed it. Measured 2026-08-29, `~/mc` held seven
 * workareas whose plan said `done` and whose last step had merged weeks
 * earlier — and sixteen with no plan on main at all.
 *
 * The plan goes first, then the workarea: a folder is never removed while
 * the plan that explains it is still on main.
 */
const RUNS_HEAD = 'ts\tname\tkind\texit\tseconds\tpr\tturns\tinput\toutput\tcache_read\tcache_write\tsession\tnote\n';
const ranRow = (name, note = 'success,merged') => `2026-08-28T10:00:00Z\t${name}\tstep\t0\t10\t77\t4\t1\t2\t3\t4\tsid\t${note}\n`;

test('a workarea whose plan left main this round is closed: worktree handed back, branch deleted, filing moved', async () => {
  const f = fixture({
    plans: { memoro: { over: done() } },
    areas: { over: { repo: 'memoro', programme: 'prog', plan: done(), decisions: { 'prog-1.md': '# q\n' } } },
    projectLog: { memoro: LOG_HEAD },
    runs: RUNS_HEAD + ranRow('over'),
    session: okSession(),
  });
  await createRunner({ deps: f.deps }).round();

  assert.ok(f.calls.git.some((c) => c[0] === '/home/memoro' && c[1] === 'worktree' && c[2] === 'remove' && c[3] === '/w/over/memoro'));
  assert.ok(f.calls.git.some((c) => c[0] === '/home/memoro' && c[1] === 'branch' && c[2] === '-D' && c[3] === 'over'));
  // Nothing is deleted: what the folder kept beside its checkout is moved.
  assert.deepEqual(f.calls.moved, [['/w/over/decisions', '/w/runner/log/closed/over/decisions']]);
  assert.equal(f.files['/w/runner/log/closed/over/decisions/prog-1.md'], '# q\n');
  assert.deepEqual(f.calls.rmdirs, ['/w/over']);
  assert.match(f.files['/w/runner/log/runner.log'],
    /close: over removed — worktree, branch over, 1 file\(s\) moved to runner\/log\/closed\/over\//u);
});

test('a done workarea with an uncommitted change is kept, and says why', async () => {
  const f = fixture({
    plans: { memoro: { over: done() } },
    areas: { over: { repo: 'memoro', programme: 'prog', plan: done() } },
    projectLog: { memoro: LOG_HEAD },
    runs: RUNS_HEAD + ranRow('over'),
    dirty: ['over'],
    session: okSession(),
  });
  await createRunner({ deps: f.deps }).round();
  assert.deepEqual(f.calls.rmdirs, []);
  assert.equal('/w/over/memoro/.git' in f.files, true, 'the checkout is untouched');
  assert.match(f.files['/w/runner/log/runner.log'], /close: over kept — an uncommitted change/u);
});

/**
 * The runner squash-merges, so a finished branch reads as "ahead" of main
 * forever. The last row in runs.tsv is what says the step landed — and a row
 * that does not end `merged` is a step that is still open.
 */
test('a done workarea whose last step is still open is kept', async () => {
  const f = fixture({
    plans: { memoro: { over: done() } },
    areas: { over: { repo: 'memoro', programme: 'prog', plan: done() } },
    projectLog: { memoro: LOG_HEAD },
    runs: RUNS_HEAD + ranRow('over', 'success,open'),
    session: okSession(),
  });
  await createRunner({ deps: f.deps }).round();
  assert.deepEqual(f.calls.rmdirs, []);
  assert.match(f.files['/w/runner/log/runner.log'], /close: over kept — the last run says success,open/u);
});

/**
 * The plan goes first and the workarea second, and they used to have to happen
 * in the same round: with the plan already archived, the folder read as one
 * nothing explains and no machine ever looked at it again. Measured 2026-08-30,
 * the one round that archived three projects was cut short by STOP before it
 * reached the closing.
 */
test('a workarea whose plan an earlier round archived is closed on the strength of the project log', async () => {
  const logged = `${LOG_HEAD}| 2026-08-29 | prog | gone | delivered | It shipped. | - | #12 |\n`;
  const f = fixture({
    // No plan on main at all: an earlier round already took it off.
    plans: { memoro: {} },
    areas: { gone: { repo: 'memoro' } },
    projectLog: { memoro: logged },
    runs: RUNS_HEAD + ranRow('gone'),
    session: okSession(),
  });
  await createRunner({ deps: f.deps }).round();
  assert.deepEqual(f.calls.rmdirs, ['/w/gone']);
  assert.match(f.files['/w/runner/log/runner.log'], /close: gone removed — worktree, branch gone/u);
  // ...and it is not also filed as a folder nobody can explain.
  assert.doesNotMatch(f.files['/w/intake/unplanned-workareas.md'], /\| gone \|/u);
});

/**
 * What keeps that widening from taking anything it should not. A folder named
 * after an archived project but with no runner step behind it is somebody's,
 * not the runner's.
 */
test('a folder sharing an archived name, with no runner step, is kept and filed as unexplained', async () => {
  const logged = `${LOG_HEAD}| 2026-08-29 | prog | gone | delivered | It shipped. | - | #12 |\n`;
  const f = fixture({
    plans: { memoro: {} },
    areas: { gone: { repo: 'memoro' } },
    projectLog: { memoro: logged },
    runs: RUNS_HEAD,
    session: okSession(),
  });
  await createRunner({ deps: f.deps }).round();
  assert.deepEqual(f.calls.rmdirs, []);
  assert.match(f.files['/w/runner/log/runner.log'], /close: gone kept — no runner step to point at/u);
});

test('an archive PR that did not merge keeps the workarea: the plan is still on main', async () => {
  const f = fixture({
    plans: { memoro: { over: done() } },
    areas: { over: { repo: 'memoro', programme: 'prog', plan: done() } },
    projectLog: { memoro: LOG_HEAD },
    archive: { memoro: { mergeFails: true } },
    runs: RUNS_HEAD + ranRow('over'),
    session: okSession(),
  });
  await createRunner({ deps: f.deps }).round();
  assert.deepEqual(f.calls.rmdirs, []);
  assert.match(f.files['/w/runner/log/runner.log'], /close: over kept — its plan is still on main/u);
});

test('a workarea no project explains is never removed, and is written to intake with whether its branch landed', async () => {
  const f = fixture({
    areas: {
      'msr-track-1': { repo: 'memoro' },
      'mc-repo': { repo: 'memoro-cli' },
    },
    dirty: ['msr-track-1'],
    landed: ['mc-repo'],
    session: okSession(),
  });
  await createRunner({ deps: f.deps }).round();
  assert.deepEqual(f.calls.rmdirs, [], 'only Martin can say whether an unplanned workarea is finished');
  const intake = f.files['/w/intake/unplanned-workareas.md'];
  assert.match(intake, /# Workareas with no project on main/u);
  assert.match(intake, /\| mc-repo \| memoro-cli \| 0 \| abc1234 \| landed \|/u);
  assert.match(intake, /\| msr-track-1 \| memoro \| 1 \| abc1234 \| ahead \|/u);
  assert.match(f.files['/w/runner/log/runner.log'], /close: 2 workarea\(s\) with no project on main/u);
});

test('the branch is asked of the worktree, not guessed from the folder name', async () => {
  // The sixteen workareas from before the plan world were made by hand and
  // need not be named after their branch: msr-track-1 sits on
  // `msr-track1-skin`. Guessing left the one column that says whether
  // anything would be lost reading `unknown` for most of the file.
  const f = fixture({
    areas: { 'msr-track-1': { repo: 'memoro' } },
    heads: { 'msr-track-1': 'msr-track1-skin' },
    landed: ['msr-track1-skin'],
    session: okSession(),
  });
  await createRunner({ deps: f.deps }).round();
  assert.match(f.files['/w/intake/unplanned-workareas.md'], /\| msr-track-1 \| memoro \| 0 \| abc1234 \| landed \|/u);
});

test('a live workarea is never closed, however done its plan is', async () => {
  const f = fixture({
    plans: { memoro: { over: done() } },
    areas: { over: { repo: 'memoro', programme: 'prog', plan: done() } },
    projectLog: { memoro: LOG_HEAD },
    runs: RUNS_HEAD + ranRow('over'),
    live: ['over'],
    session: okSession(),
  });
  await createRunner({ deps: f.deps }).round();
  assert.deepEqual(f.calls.rmdirs, []);
  assert.match(f.files['/w/runner/log/runner.log'], /close: over kept — a live tmux session/u);
});

/**
 * A plan on origin/main the schema refuses. `chooseKind` answers `unparseable`
 * and `runStep` logs it — to `runner.log`, where `new-user`'s line went every
 * round for a day while the project stopped existing as far as any board
 * showed. The round writes it beside the workareas with no project instead.
 */
test('a plan that does not parse gets a row in ~/mc/intake/, not a line nobody reads', async () => {
  const broken = JSON.stringify({ ...JSON.parse(ready), goal: [] }, null, 2);
  const f = fixture({
    plans: { memoro: { 'new-user': broken, alpha: ready } },
    session: okSession(),
    gh: { alpha: { number: 7 } },
  });
  await createRunner({ deps: f.deps }).round();
  const intake = f.files['/w/intake/unreadable-plans.md'];
  assert.match(intake, /\| new-user \| memoro \| goal: at least one paragraph/u);
  assert.doesNotMatch(intake, /\| alpha \|/u, 'a plan that parses is not in the table');
  assert.match(f.files['/w/runner/log/runner.log'], /new-user: the plan does not parse on origin\/main/u);
});

/** The table is a picture of now, so a plan somebody fixed leaves it by itself. */
test('the unreadable table is rewritten whole each round', async () => {
  const f = fixture({ plans: { memoro: { alpha: ready } }, session: okSession(), gh: { alpha: { number: 7 } } });
  f.files['/w/intake/unreadable-plans.md'] = 'stale\n';
  await createRunner({ deps: f.deps }).round();
  assert.doesNotMatch(f.files['/w/intake/unreadable-plans.md'], /stale/u);
});

test('--once closes nothing', async () => {
  const f = fixture({
    plans: { memoro: { over: done(), alpha: ready } },
    areas: { over: { repo: 'memoro', programme: 'prog', plan: done() } },
    runs: RUNS_HEAD + ranRow('over'),
    session: okSession(),
    gh: { alpha: { number: 7 } },
  });
  await createRunner({ deps: f.deps }).round({ once: true });
  assert.deepEqual(f.calls.rmdirs, []);
  assert.equal('/w/intake/unplanned-workareas.md' in f.files, false);
});

/* --------------------------------------------------------------- queue */

/**
 * `~/mc/queue.md` is a strict list (Martin, 2026-08-29: "ett träsk — där ska
 * INTE finnas någonting annat än en lista över vad som ska köras"). The
 * 2026-08-29 file had seven comment lines and twenty names that were already
 * done or had no plan on main.
 */
test('queue.md is rewritten to names only, and a name leaves it the moment its step has run', async () => {
  const f = fixture({
    queue: '# the queue\n\n## Martin\nalpha\nover\nghost\nbeta\n',
    plans: { memoro: { alpha: ready, beta: ready, over: done() } },
    projectLog: { memoro: LOG_HEAD },
    areas: { over: { repo: 'memoro', programme: 'prog', plan: done() } },
    runs: RUNS_HEAD + ranRow('over'),
    session: okSession(),
    gh: { alpha: { number: 7 }, beta: { number: 8 } },
  });
  await createRunner({ deps: f.deps }).round();
  const log = f.files['/w/runner/log/runner.log'];
  assert.match(log, /queue: dropped "# the queue" — not a project name/u);
  assert.match(log, /queue: dropped "## Martin" — not a project name/u);
  assert.match(log, /queue: dropped "over" — the plan is done/u);
  assert.match(log, /queue: dropped "ghost" — no plan on main/u);
  assert.equal(f.files['/w/queue.md'], '', 'every name that was left had its step, so the file is empty');
});

test('a name whose project was skipped stays in the queue', async () => {
  const f = fixture({
    queue: 'alpha\nwait\n',
    plans: { memoro: { alpha: ready, wait: plan({ status: 'blocked' }) } },
    session: okSession(),
    gh: { alpha: { number: 7 } },
  });
  await createRunner({ deps: f.deps }).round();
  assert.equal(f.files['/w/queue.md'], 'wait\n', 'it has not had its step, so it keeps its place');
});

/**
 * The runner holds the machine awake — for a real run, not for a watched one.
 *
 * The rules live in stay-awake.js and are asserted there. What this asserts is
 * the wiring: that the loop actually asks, that it asks once, before the first
 * round rather than after it, and that `--once` — a person watching a single
 * step — does not hold anything.
 */
test('runLoop: an unattended run holds the machine awake; --once does not', async () => {
  const held = [];
  const f = fixture({ plans: { memoro: { a: ready } }, session: okSession() });
  f.deps.keepAwake = (options) => {
    held.push({ ...options, roundsSoFar: f.calls.sessions.length });
    return { ok: true, pid: 9, flags: ['-i', '-m', '-s'], note: 'held' };
  };
  f.deps.onACPower = () => true;
  assert.equal(await runLoop({ rounds: 1, deps: f.deps }), 0);
  assert.equal(held.length, 1, 'asked once, not once per round');
  assert.equal(held[0].pid, process.pid);
  assert.equal(held[0].onAC, true);
  assert.equal(held[0].roundsSoFar, 0, 'held before the first step, not after it');
  assert.match(f.files['/w/runner/log/runner.log'], /staying awake \(caffeinate -i -m -s pid 9\)/u);

  const g = fixture({ plans: { memoro: { a: ready } }, session: okSession() });
  const watched = [];
  g.deps.keepAwake = (options) => { watched.push(options); return { ok: true, pid: 9, flags: [], note: '' }; };
  assert.equal(await runLoop({ once: true, deps: g.deps }), 0);
  assert.deepEqual(watched, [], '--once is somebody watching; it holds nothing');
});

test('runLoop: a machine that will not stay awake still runs, and says so', async () => {
  const f = fixture({ plans: { memoro: { a: ready } }, session: okSession() });
  f.deps.keepAwake = () => ({ ok: false, reason: 'caffeinate-missing', flags: [], note: 'caffeinate could not be run' });
  f.deps.onACPower = () => null;
  assert.equal(await runLoop({ rounds: 1, deps: f.deps }), 0, 'the run is not blocked by it');
  assert.equal(f.calls.sessions.length, 1);
  assert.match(f.files['/w/runner/log/runner.log'], /NOT staying awake \(caffeinate-missing\)/u);
});

test('runLoop: --no-caffeinate is obeyed', async () => {
  const f = fixture({ plans: { memoro: { a: ready } }, session: okSession() });
  const asked = [];
  f.deps.keepAwake = (options) => { asked.push(options); return { ok: true, pid: 1, flags: [], note: '' }; };
  assert.equal(await runLoop({ rounds: 1, awake: false, deps: f.deps }), 0);
  assert.deepEqual(asked, []);
});

/**
 * The unattended loop: each repository's lane runs its own rounds. memoro's
 * step is slow here; memoro-cli's second step must start — and its lane's
 * round must end — while memoro's first is still in its session. Until
 * 2026-09-03 both lanes shared one round, and memoro-cli's second step
 * would have waited for memoro's session to end.
 */
test('runLoop: lanes run their own rounds — memoro-cli does not wait for memoro', async () => {
  const f = fixture({ plans: { memoro: { a: ready }, 'memoro-cli': { x: ready, y: ready } }, session: okSession() });
  const inner = f.deps.session;
  const events = [];
  let release = null;
  const memoroMayFinish = new Promise((resolve) => { release = resolve; });
  let cliSteps = 0;
  f.deps.session = async (call) => {
    const name = call.cwd.split('/')[2];
    events.push(`${name}: start`);
    if (call.cwd.endsWith('/memoro')) {
      await memoroMayFinish;
      events.push(`${name}: end`);
      return inner(call);
    }
    cliSteps += 1;
    // The second memoro-cli step ends the run for everyone, and only then
    // is memoro's session allowed to finish.
    if (cliSteps === 2) { f.files['/w/runner/STOP'] = ''; release(); }
    events.push(`${name}: end`);
    return inner(call);
  };
  assert.equal(await runLoop({ rounds: 0, deps: f.deps }), 0);
  const started = events.filter((e) => e.endsWith(': start')).map((e) => e.split(':')[0]);
  assert.deepEqual(started.sort(), ['a', 'x', 'y'], `every step started: ${events.join(', ')}`);
  assert.ok(events.indexOf('y: start') < events.indexOf('a: end'), `memoro-cli's second step waited for memoro's first: ${events.join(', ')}`);
  const log = f.files['/w/runner/log/runner.log'];
  assert.match(log, /y: step done[\s\S]*a: step done/u, "memoro-cli's second step did not finish before memoro's first");
  assert.match(log, /runner exit on STOP \(remove/u);
  // A lane's round never runs the whole-queue chores: queue.md is tidied and
  // the workareas closed by the chore loop, from both repositories' plans.
  assert.equal(/memoro-cli: lanes:/u.test(log), false);
});

/**
 * `mc-test`'s sessions opened three pull requests from `test-architecture-*`
 * branches (2026-09-03). The runner knew the project's PRs only by the
 * project's name, so it landed none of them, saw none as in flight, and ran
 * the next step on top of them. The branch the worktree stands on is the
 * project's, whatever the session called it.
 */
test('a pull request from the branch the worktree stands on is the project\'s, whatever it is called', async () => {
  const f = fixture({
    plans: { memoro: { alpha: ready } },
    heads: { alpha: 'test-arch' },
    gh: { alpha: { number: 77, title: 'Renamed', head: 'test-arch' } },
    session: okSession(),
  });
  const runner = createRunner({ deps: f.deps });
  await runner.round({ once: true });
  assert.equal(f.calls.sessions.length, 1, 'the PR was not named after the project, so nothing stopped the step');
  const log = f.files['/w/runner/log/runner.log'];
  assert.match(log, /alpha: #77 is on test-arch, not a branch named after the project — landing it anyway/u);
  assert.match(f.files['/w/runner/log/runs.tsv'], /\talpha\tstep\t0\t\d+\t77\t/u, 'the row names the PR');
});

/**
 * The gate lock and the repository lease refuse a second round; the runner
 * used to log `left open` and move on, which parked the project behind its
 * own open pull request. A refused round is a live round that ends in
 * minutes, so the landing waits and asks again.
 */
test('a landing that meets another round waits for it, and lands', async () => {
  const f = fixture({ plans: { memoro: { alpha: ready } }, gh: { alpha: { number: 70, title: 'Step' } }, session: okSession() });
  let asked = 0;
  f.deps.mergeRound = async () => {
    asked += 1;
    if (asked < 3) return { ok: false, merged: false, stopped_at: asked === 1 ? 'busy' : 'lease', reason: asked === 1 ? 'another gate round is running on this machine (pid 9)' : '/home/memoro is held by beta for “merge round for #71”' };
    return { ok: true, merged: true, merged_into: 'main', default_branch: 'main', off_default: false, stopped_at: null, reason: null };
  };
  let slept = 0;
  f.deps.sleep = async () => { slept += 1; };
  const runner = createRunner({ deps: f.deps });
  await runner.round({ once: true });
  assert.equal(asked, 3, 'the round was asked again after each refusal');
  assert.ok(slept >= 2, 'it waited between the asks');
  const log = f.files['/w/runner/log/runner.log'];
  assert.match(log, /alpha: merge #70 — waiting for the gate: another gate round is running on this machine \(pid 9\)/u);
  assert.match(log, /alpha: merge #70 — waited \d+s for the gate/u);
  assert.match(log, /alpha: merged #70 into main through the gate/u);
  assert.match(f.files['/w/runner/log/runs.tsv'], /\talpha\tstep\t.*\tsuccess,merged\t/u);
});

test('a landing refused for any other reason is left open, as before', async () => {
  const f = fixture({ plans: { memoro: { alpha: ready } }, gh: { alpha: { number: 70, title: 'Step' } }, session: okSession(), rounds: { 70: { ok: false, merged: false, stopped_at: 'red', reason: '2 tests red' } } });
  const runner = createRunner({ deps: f.deps });
  await runner.round({ once: true });
  assert.equal(f.calls.rounds.length, 1, 'a red round is not asked again');
  assert.match(f.files['/w/runner/log/runner.log'], /alpha: #70 left open — 2 tests red/u);
});

/**
 * `mc run lanes 2`: two loops on one repository, each taking every second
 * name, each with a current file of its own. Neither waits for the other.
 */
test('runLoop: lanes above one split a repository\'s names, and never hold the same project', async () => {
  const f = fixture({ plans: { memoro: { a: ready, b: ready, c: ready } }, session: okSession() });
  const inner = f.deps.session;
  const seen = [];
  let started = 0;
  f.deps.session = async (call) => {
    started += 1;
    seen.push({ name: call.cwd.split('/')[2], currents: Object.keys(f.files).filter((k) => /\/runner\/current-/u.test(k)).sort() });
    if (started === 3) f.files['/w/runner/STOP'] = '';
    return inner(call);
  };
  f.deps.laneCount = () => 2;
  assert.equal(await runLoop({ rounds: 0, deps: f.deps }), 0);
  const names = seen.map((s) => s.name).sort();
  assert.deepEqual(names, ['a', 'b', 'c'], `every project ran once: ${JSON.stringify(seen)}`);
  const both = seen.find((s) => s.currents.length === 2);
  assert.ok(both, `two steps were in flight at once: ${JSON.stringify(seen)}`);
  assert.deepEqual(both.currents, ['/w/runner/current-memoro-1.json', '/w/runner/current-memoro.json']);
  const log = f.files['/w/runner/log/runner.log'];
  assert.match(log, /lanes: 2 per repository/u);
  assert.match(log, /memoro#2: round 1 done \(1 ran\)/u, 'the second lane closed a round of its own');
  assert.match(log, /runner exit on STOP after c/u, 'the first lane walked a then c and left on STOP');
});

/**
 * UPDATE is honoured at the quiet moment, not at the first idle round. A lane
 * that read UPDATE after an idle round used to leave its loop and wait for the
 * busy lane's whole step, taking no work — memoro-cli sat half an hour with a
 * ready plan on main (2026-09-04). It keeps taking rounds until nothing is in
 * flight anywhere.
 */
test('runLoop: an UPDATE drains — no lane starts a step, the ones in flight finish, then the handover', async () => {
  const plans = { memoro: { a: ready }, 'memoro-cli': {} };
  const f = fixture({ plans, session: okSession() });
  const inner = f.deps.session;
  const events = [];
  let ticks = 0;
  f.deps.session = async (call) => {
    const name = call.cwd.split('/')[2];
    events.push(`${name}: start`);
    if (call.cwd.endsWith('/memoro')) {
      // Mid-step: an update is asked for, and a memoro-cli plan lands on main.
      // The idle memoro-cli lanes see both, and start nothing.
      f.files['/w/runner/UPDATE'] = '';
      plans['memoro-cli'].x = ready;
      // Let the other lanes poll a few times against the pending UPDATE.
      while (ticks < 6) await new Promise((resolve) => { setImmediate(resolve); });
    }
    events.push(`${name}: end`);
    return inner(call);
  };
  // A sleep that yields a macrotask, not a resolved promise: the draining
  // lanes poll in a loop, and a no-op sleep would spin them in microtasks
  // and starve the `setImmediate` the memoro session is waiting on.
  f.deps.sleep = () => new Promise((resolve) => { setImmediate(() => { ticks += 1; resolve(); }); });
  const handovers = [];
  f.deps.handOver = async ({ say }) => { handovers.push(events.slice()); say('update: handed over to pid 9001 — this runner is done'); return { ok: true, pid: 9001 }; };
  assert.equal(await runLoop({ rounds: 0, deps: f.deps }), 0);
  assert.equal(events.indexOf('x: start'), -1, `a lane started a step under a pending UPDATE: ${events.join(', ')}`);
  assert.equal(handovers.length, 1, 'the update handed over');
  assert.deepEqual(handovers[0], ['a: start', 'a: end'], 'the handover came after the step in flight had ended');
  const log = f.files['/w/runner/log/runner.log'];
  assert.match(log, /memoro-cli: UPDATE — taking no new step; handing over when every lane is done/u);
});

/**
 * One project, one lane. A lane that stays on a project after a merge and
 * another lane's round that reads the same project as ready would both start
 * it — two sessions in one worktree. The claim is in the process.
 */
test('a project already in flight in one lane is skipped by another', async () => {
  const f = fixture({ plans: { memoro: { a: ready } }, session: okSession() });
  const inner = f.deps.session;
  let release = null;
  const held = new Promise((resolve) => { release = resolve; });
  f.deps.session = async (call) => { await held; return inner(call); };
  const runner = createRunner({ deps: f.deps });
  const world = runner.queue();
  const first = runner.runStep('a', world, { lane: 0 });
  await new Promise((resolve) => { setImmediate(resolve); });
  const second = await runner.runStep('a', world, { lane: 1 });
  assert.equal(second, 'skipped');
  assert.match(f.files['/w/runner/log/runner.log'], /a: in flight in another lane, skip/u);
  release();
  await first;
  assert.equal(f.calls.sessions.length, 1, 'one session, not two');
  const third = await runner.runStep('a', world, { lane: 1 });
  assert.notEqual(third, 'skipped', 'the claim is released when the step is over');
});
