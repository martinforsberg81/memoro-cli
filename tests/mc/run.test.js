import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { createRunner, runLoop } from '../../src/mc/run.js';

/**
 * A whole runner on fakes: a work root in memory, two repositories whose
 * origin/main carries PLAN.md files, git/gh/tmux answered from tables, and
 * a "session" that returns what the test says. Nothing starts, nothing is
 * written outside `files`.
 */
function fixture({ plans = {}, queue = '', session, gh = {}, dirty = [], live = [], areas = {}, conflicts = {}, roles = true, now = '2026-08-29T10:00:00Z', runs = null, collect = okCollect, helperTurn = okTurn, projectLog = {}, archive = {}, landed = [], removeFails = [], heads = {} } = {}) {
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
    if (area.plan) {
      files[`${root}/${name}/${area.repo}/docs/project/${area.programme}/${name}/PLAN.md`] = area.plan;
      dirs.add(`${root}/${name}/${area.repo}/docs/project`);
    }
    for (const [file, text] of Object.entries(area.decisions || {})) {
      files[`${root}/${name}/decisions/${file}`] = text;
      dirs.add(`${root}/${name}/decisions`);
    }
  }
  const log = [];
  const calls = { git: [], gh: [], sessions: [], added: [], removed: [], collects: [], turns: [], rm: [], moved: [], rmdirs: [] };
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
        files[`${root}/${name}/${repoName}/docs/project/prog/${name}/PLAN.md`] = text;
        dirs.add(`${root}/${name}/${repoName}/docs/project`);
      }
      return { ok: true, path: `${root}/${name}/${repoName}` };
    },
    collect: async (options) => { calls.collects.push(options); return collect(options); },
    helperTurn: async (options) => { calls.turns.push(options); return helperTurn(options); },
    profile: async () => 'PROFILE',
    role: (kind) => (roles ? { name: kind, overlay: `ROLE ${kind}` } : null),
    launch: (tool) => ({ ok: true, id: tool === 'codex' ? 'codex' : 'claude-code', shortName: tool, adapter: { modelArgs: (m) => ['--model', m] }, spec: { bin: `/bin/${tool}` } }),
    session: (call) => { calls.sessions.push(call); duringSession.push(structuredClone(files)); return session(call); },
    log: (line) => log.push(line),
    git: (cwd, args) => {
      calls.git.push([cwd, ...args]);
      const repoName = Object.keys(repos).find((r) => cwd === repos[r]);
      if (args[0] === 'ls-tree' && repoName) {
        return { ok: true, stdout: Object.keys(plans[repoName] || {}).map((n) => `docs/project/prog/${n}/PLAN.md`).join('\n') };
      }
      if (args[0] === 'show' && repoName) {
        const name = args[1].split('/').at(-2);
        return { ok: true, stdout: plans[repoName][name] };
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
        for (const [name, text] of Object.entries(plans[repoName] || {})) files[`${path}/docs/project/prog/${name}/PLAN.md`] = text;
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
      if (args[0] === 'branch') return { ok: true, stdout: cwd.split('/')[2] };
      return { ok: true, stdout: '', stderr: '' };
    },
    gh: (cwd, args) => {
      calls.gh.push([cwd, ...args]);
      // The archive PR: opened in `/w/runner/archive/<repo>`, and asked for
      // in the repository itself ("is one still open from an earlier round?").
      const repoName = Object.keys(repos).find((r) => cwd === repos[r]);
      if (repoName) {
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
      const name = cwd.split('/')[2];
      const pr = gh[name];
      if (args[1] === 'list') return { ok: true, stdout: pr ? String(pr.number) : '' };
      if (args[1] === 'view' && args.includes('mergeable')) return { ok: true, stdout: pr?.mergeable || 'MERGEABLE' };
      if (args[1] === 'view' && args.includes('title')) return { ok: true, stdout: pr?.title || 't' };
      if (args[1] === 'merge') return pr?.mergeFails ? { ok: false, stdout: '', stderr: 'nope' } : { ok: true, stdout: '' };
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

const ready = '---\nstatus: ready\nnext: "do x"\n---\n# X\n';
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
  assert.deepEqual(call.args.slice(2, 6), ['--model', 'opus', '--permission-mode', 'auto']);
  assert.match(call.args[1], /`alpha` workarea of memoro[\s\S]*----- PLAN\.md -----\n---\nstatus: ready/u);
  assert.match(call.args[call.args.indexOf('--append-system-prompt') + 1], /^PROFILE\n\n---\n\nROLE step$/u);
  assert.ok(f.calls.gh.some((c) => c.includes('merge') && c.includes('Alpha step (#77)')));
  const rows = f.files['/w/runner/log/runs.tsv'].trim().split('\n');
  assert.equal(rows[0].split('\t').length, 13);
  assert.equal(rows[1], '2026-08-29T10:00:00Z\talpha\tstep\t0\t0\t77\t4\t1\t2\t3\t4\tsid\tsuccess,merged');
  assert.ok(f.files['/w/alpha-20260829T100000Z.json'] === undefined);
  assert.ok('/w/runner/log/alpha-20260829T100000Z.json' in f.files);
  assert.match(f.files['/w/runner/log/runner.log'], /alpha: merged #77\n.*alpha: step done rc=0 0s pr=77 turns=4 note=success,merged/u);
});

test('skips: live tmux session, dirty worktree, waiting-decision', async () => {
  const waiting = '---\nstatus: waiting-decision\n---\n';
  const f = fixture({
    plans: { memoro: { live: ready, dirty: ready, wait: waiting } },
    live: ['live'], dirty: ['dirty'], session: okSession(),
  });
  const runner = createRunner({ deps: f.deps });
  const r = await runner.round();
  assert.equal(r.ran, 0);
  assert.equal(f.calls.sessions.length, 0);
  const log = f.files['/w/runner/log/runner.log'];
  assert.match(log, /live: live tmux session, skip/u);
  assert.match(log, /dirty: dirty worktree, skip/u);
  assert.match(log, /wait: status waiting-decision, skip/u);
});

/**
 * The runner has nothing to do with decisions (Martin, 2026-08-29). It used
 * to grep every decisions directory under the work root for a `Beslut` line
 * naming this project or its programme, and start the project when it found
 * one. A plan comes back by being set `ready`, and by nothing else.
 */
test('an answered decision file does not start a waiting-decision project', async () => {
  const waiting = '---\nstatus: waiting-decision\n---\n# W\n';
  const f = fixture({
    areas: {
      other: { repo: 'memoro', decisions: { 'prog-1.md': '# q\n\n**Beslut:** A\n' } },
      wait: { repo: 'memoro', programme: 'prog', plan: waiting },
    },
    plans: { memoro: { wait: waiting } },
    session: okSession(),
  });
  await createRunner({ deps: f.deps }).round();
  assert.equal(f.calls.sessions.length, 0, 'nothing starts');
  assert.match(f.files['/w/runner/log/runner.log'], /wait: status waiting-decision, skip/u);
  assert.equal(f.files['/w/other/decisions/prog-1.md'], '# q\n\n**Beslut:** A\n', 'and the runner does not touch the file either');
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
  assert.match(f.files['/w/runner/log/runs.tsv'], /\tq\tstep\t1\t0\t5\t1\t.*\tquota\n/u);
  assert.ok(!f.calls.gh.some((c) => c.includes('merge')));
  assert.ok(slept.includes(30 * 60 * 1000));
});

test('a timed-out session is logged as timeout with exit 142', async () => {
  const f = fixture({ plans: { memoro: { t: ready } }, session: () => ({ status: 142, stdout: '', stderr: '', timedOut: true }) });
  const runner = createRunner({ deps: f.deps });
  await runner.round({ once: true });
  assert.match(f.files['/w/runner/log/runs.tsv'], /\tt\tstep\t142\t0\t-\t-\t-\t-\t-\t-\t-\ttimeout\n/u);
});

test('merge that fails syncs main in, pushes, retries once; still failing leaves it open', async () => {
  const f = fixture({ plans: { memoro: { m: ready } }, gh: { m: { number: 9, mergeFails: true } }, session: okSession() });
  const runner = createRunner({ deps: f.deps });
  await runner.round({ once: true });
  assert.equal(f.calls.gh.filter((c) => c.includes('merge')).length, 2);
  assert.ok(f.calls.git.some((c) => c.includes('push')));
  assert.match(f.files['/w/runner/log/runs.tsv'], /success,open\n/u);
  assert.match(f.files['/w/runner/log/runner.log'], /m: #9 left open — could not merge/u);
});

test('tool and model come from the project frontmatter', async () => {
  const codexPlan = '---\nstatus: ready\ntool: codex\nmodel: o3\nbudget_minutes: 20\n---\n';
  const f = fixture({ plans: { 'memoro-cli': { cx: codexPlan } }, session: () => ({ status: 0, stdout: '', stderr: '', timedOut: false }) });
  const runner = createRunner({ deps: f.deps });
  await runner.round({ once: true });
  const [call] = f.calls.sessions;
  assert.equal(call.bin, '/bin/codex');
  assert.equal(call.cwd, '/w/cx/memoro-cli');
  assert.equal(call.timeoutMs, 20 * 60_000);
  assert.deepEqual(call.args.slice(0, 5), ['exec', '--json', '--full-auto', '--model', 'o3']);
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
    name: 'alpha', kind: 'step', repo: 'memoro', tool: 'claude', model: 'opus', budget_minutes: 90,
    started: '2026-08-29T10:00:00Z', pid: 4242, worktree: '/w/alpha/memoro',
  });
  assert.deepEqual(JSON.parse(during['/w/runner/runner.json']), { pid: 4242, started: '2026-08-29T10:00:00Z' });

  // ...and both are gone once the step and the loop are over.
  assert.equal('/w/runner/current-memoro.json' in f.files, false);
  assert.equal('/w/runner/runner.json' in f.files, false);
});

test('the current file carries the project frontmatter, and is removed even when the session throws', async () => {
  const codexPlan = '---\nstatus: ready\ntool: codex\nmodel: o3\nbudget_minutes: 20\n---\n';
  const f = fixture({ plans: { 'memoro-cli': { cx: codexPlan } }, session: () => { throw new Error('boom'); } });
  const runner = createRunner({ deps: f.deps });
  await assert.rejects(runner.round({ once: true }), /boom/u);
  assert.deepEqual(JSON.parse(f.duringSession[0]['/w/runner/current-memoro-cli.json']), {
    name: 'cx', kind: 'step', repo: 'memoro-cli', tool: 'codex', model: 'o3', budget_minutes: 20,
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
  assert.equal(first.length, 1);
  assert.deepEqual(
    { name: first[0].name, exit: first[0].exit, pr: first[0].pr, note: first[0].note },
    { name: 'helper', exit: '0', pr: '-', note: 'success,1-proposals' },
  );
  assert.equal(first[0].turns, '3', 'the turn is a model call and its usage is logged like a step');
  assert.equal(first[0].cache_read, '30');

  await runner.round();
  assert.equal(runRows(f.files).filter((r) => r.kind === 'helper').length, 1, 'a second round the same day does not run it again');
  assert.equal(f.calls.collects.length, 1);
  assert.ok(f.log.some((line) => /already ran today/u.test(line)) === false, 'the gate is silent — nobody reads a skip line');
});

test('the helper waits for 05:00Z, and runs in the first round after it', async () => {
  const early = fixture({ now: '2026-08-29T04:59:00Z' });
  await createRunner({ deps: early.deps }).round();
  assert.equal(early.calls.collects.length, 0);
  assert.equal(runRows(early.files).length, 0);

  const late = fixture({ now: '2026-08-29T05:00:00Z' });
  await createRunner({ deps: late.deps }).round();
  assert.equal(late.calls.collects.length, 1);
});

test('yesterday\'s helper row does not count as today\'s', async () => {
  const yesterday = 'ts\tname\tkind\texit\tseconds\tpr\tturns\tinput\toutput\tcache_read\tcache_write\tsession\tnote\n'
    + '2026-08-28T06:00:00Z\thelper\thelper\t0\t120\t-\t3\t-\t-\t-\t-\t-\tsuccess,0-proposals\n';
  const f = fixture({ runs: yesterday });
  await createRunner({ deps: f.deps }).round();
  assert.equal(f.calls.collects.length, 1);
  assert.equal(runRows(f.files).filter((r) => r.kind === 'helper').length, 2);
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
  assert.ok(f.log.some((line) => /collect step failed — wrangler is not logged in/u.test(line)));

  await runner.round();
  assert.equal(f.calls.collects.length, 1);
});

test('a turn that did not finish is logged under its own reason, and still counts as the day\'s run', async () => {
  const f = fixture({ helperTurn: async () => ({ ok: false, reason: 'no-tool', note: 'claude is not on PATH', wrote: [] }) });
  const runner = createRunner({ deps: f.deps });
  await runner.round();
  const row = runRows(f.files).find((r) => r.kind === 'helper');
  assert.equal(row.note, 'no-tool');
  assert.equal(row.exit, '1');
  await runner.round();
  assert.equal(f.calls.collects.length, 1);
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
const done = (next = 'Step 3 — close-out') => `---\nstatus: done\nnext: "${next}"\n---\n# D\n\nSee \`docs/technical/d.md\`.\n`;
const LOG_HEAD = '# Project log\n\n## Log\n\n| date | programme | project | outcome | summary | doc | pointer |\n|---|---|---|---|---|---|---|\n';

test('a done plan is archived in the round it is read: directory removed, row written, one PR merged', async () => {
  const f = fixture({
    plans: { memoro: { over: done('Step 2 — the rule'), alpha: ready } },
    projectLog: { memoro: LOG_HEAD },
    session: okSession(),
  });
  await createRunner({ deps: f.deps }).round();

  const wt = '/w/runner/archive/memoro';
  assert.deepEqual(f.calls.rm, ['docs/project/prog/over'], 'the project directory, and nothing else');
  assert.equal(`${wt}/docs/project/prog/over/PLAN.md` in f.files, false);
  assert.equal(`${wt}/docs/project/prog/alpha/PLAN.md` in f.files, true, 'every other directory is untouched');

  const row = f.files[`${wt}/docs/project/project_log.md`].trim().split('\n').at(-1);
  assert.equal(row, '| 2026-08-29 | prog | over | delivered | Step 2 — the rule | [docs/technical/d.md](../technical/d.md) | abc1234 |');

  assert.ok(f.calls.gh.some((c) => c[0] === wt && c[2] === 'create' && c.includes('Archive 1 done project: over')));
  assert.ok(f.calls.gh.some((c) => c[0] === wt && c[2] === 'merge' && c.includes('900')), 'the runner merges it like any other PR');
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
    plans: { memoro: { thin: '---\nstatus: done\nnext: "Step 1"\n---\n# thin\n' } },
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

test('a workarea with no plan on main is never removed, and is written to intake with whether its branch landed', async () => {
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
  assert.match(intake, /# Workareas with no plan on main/u);
  assert.match(intake, /\| mc-repo \| memoro-cli \| 0 \| abc1234 \| landed \|/u);
  assert.match(intake, /\| msr-track-1 \| memoro \| 1 \| abc1234 \| ahead \|/u);
  assert.match(f.files['/w/runner/log/runner.log'], /close: 2 workarea\(s\) with no plan on main/u);
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
    plans: { memoro: { alpha: ready, wait: '---\nstatus: waiting-decision\n---\n# W\n' } },
    session: okSession(),
    gh: { alpha: { number: 7 } },
  });
  await createRunner({ deps: f.deps }).round();
  assert.equal(f.files['/w/queue.md'], 'wait\n', 'it has not had its step, so it keeps its place');
});
