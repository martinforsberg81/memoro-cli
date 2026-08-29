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
function fixture({ plans = {}, queue = '', session, gh = {}, dirty = [], live = [], areas = {}, conflicts = {}, roles = true } = {}) {
  const root = '/w';
  const files = { [`${root}/queue.md`]: queue };
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
  const calls = { git: [], gh: [], sessions: [], added: [] };
  // A snapshot of the work root taken inside every session call — the only
  // way to see the files that exist only while a step is in flight.
  const duringSession = [];
  const deps = {
    env,
    now: () => new Date('2026-08-29T10:00:00Z'),
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
    writeJson: (p, v) => { files[p] = `${JSON.stringify(v, null, 2)}\n`; },
    remove: (p) => { delete files[p]; },
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
      if (args[0] === 'status') return { ok: true, stdout: dirty.some((d) => cwd.includes(`/${d}/`)) ? ' M x' : '' };
      if (args[0] === 'merge' && args.includes('origin/main')) {
        const name = cwd.split('/')[2];
        return conflicts[name] ? { ok: false, stdout: '', stderr: 'CONFLICT' } : { ok: true, stdout: '' };
      }
      if (args[0] === 'diff') return { ok: true, stdout: (conflicts[cwd.split('/')[2]] || []).join('\n') };
      if (args[0] === 'rev-parse') return { ok: false, stdout: '' };
      if (args[0] === 'branch') return { ok: true, stdout: cwd.split('/')[2] };
      return { ok: true, stdout: '', stderr: '' };
    },
    gh: (cwd, args) => {
      calls.gh.push([cwd, ...args]);
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

test('skips: live tmux session, dirty worktree, waiting-decision without an answer, done', async () => {
  const waiting = '---\nstatus: waiting-decision\n---\n';
  const f = fixture({
    plans: { memoro: { live: ready, dirty: ready, wait: waiting, over: '---\nstatus: done\n---\n' } },
    live: ['live'], dirty: ['dirty'], session: okSession(),
  });
  const runner = createRunner({ deps: f.deps });
  const r = await runner.round();
  assert.equal(r.ran, 0);
  assert.equal(f.calls.sessions.length, 0);
  const log = f.files['/w/runner/log/runner.log'];
  assert.match(log, /live: live tmux session, skip/u);
  assert.match(log, /dirty: dirty worktree, skip/u);
  assert.match(log, /wait: waiting-decision \(no Beslut line yet\), skip/u);
  assert.match(log, /over: status done, skip/u);
});

test('waiting-decision runs as a step once a decision file for the programme carries **Beslut:**', async () => {
  const waiting = '---\nstatus: waiting-decision\n---\n# W\n';
  const f = fixture({
    areas: {
      other: { repo: 'memoro', decisions: { 'prog-1.md': '# q\n\n**Beslut:** A\n', 'prog-2.md': '# q2\n' } },
      wait: { repo: 'memoro', programme: 'prog', plan: waiting },
    },
    plans: { memoro: { wait: waiting } },
    session: okSession(),
  });
  const runner = createRunner({ deps: f.deps });
  await runner.round();
  assert.equal(f.calls.sessions.length, 1);
  const prompt = f.calls.sessions[0].args[1];
  assert.match(prompt, /Decisions answered by Martin[\s\S]*\/w\/other\/decisions\/prog-1\.md/u);
  assert.doesNotMatch(prompt, /prog-2\.md/u);
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

test('no plan in the worktree is a triage step', async () => {
  const f = fixture({ areas: { fresh: { repo: 'memoro' } }, queue: 'fresh\n', session: okSession() });
  const runner = createRunner({ deps: f.deps });
  await runner.round();
  assert.match(f.calls.sessions[0].args[1], /There is no\n`docs\/project\/\*\/fresh\/PLAN\.md` yet/u);
  assert.match(f.files['/w/runner/log/runs.tsv'], /\tfresh\ttriage\t/u);
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

test('current.json exists only while the step is in flight, and runner.json only while the loop runs', async () => {
  const f = fixture({ plans: { memoro: { alpha: ready } }, session: okSession(), gh: { alpha: { number: 77 } } });
  assert.equal(await runLoop({ once: true, deps: f.deps }), 0);

  const during = f.duringSession[0];
  assert.deepEqual(JSON.parse(during['/w/runner/current.json']), {
    name: 'alpha', kind: 'step', tool: 'claude', model: 'opus', budget_minutes: 90,
    started: '2026-08-29T10:00:00Z', pid: 4242, worktree: '/w/alpha/memoro',
  });
  assert.deepEqual(JSON.parse(during['/w/runner/runner.json']), { pid: 4242, started: '2026-08-29T10:00:00Z' });

  // ...and both are gone once the step and the loop are over.
  assert.equal('/w/runner/current.json' in f.files, false);
  assert.equal('/w/runner/runner.json' in f.files, false);
});

test('current.json carries the project frontmatter, and is removed even when the session throws', async () => {
  const codexPlan = '---\nstatus: ready\ntool: codex\nmodel: o3\nbudget_minutes: 20\n---\n';
  const f = fixture({ plans: { 'memoro-cli': { cx: codexPlan } }, session: () => { throw new Error('boom'); } });
  const runner = createRunner({ deps: f.deps });
  await assert.rejects(runner.round({ once: true }), /boom/u);
  assert.deepEqual(JSON.parse(f.duringSession[0]['/w/runner/current.json']), {
    name: 'cx', kind: 'step', tool: 'codex', model: 'o3', budget_minutes: 20,
    started: '2026-08-29T10:00:00Z', pid: 4242, worktree: '/w/cx/memoro-cli',
  });
  assert.equal('/w/runner/current.json' in f.files, false);
});
