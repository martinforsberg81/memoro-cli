/**
 * `mc tidy` (tidy.js): one list, written first, decided purely, and each
 * entry asked again at removal.
 *
 * 2026-09-26: an ad-hoc loop meant to remove orphaned transcripts deleted
 * nearly all of `~/.claude/projects`, `memory/` included. These tests are
 * mostly about what survives.
 */
import assert from 'node:assert/strict';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { parseArgs as parseTidyArgs, tidyCommand } from '../../src/mc/commands/tidy.js';
import { parseArgs } from '../../src/mc/commands/work.js';
import { setLogPath } from '../../src/mc/logger.js';
import { registerPath } from '../../src/mc/register.js';
import { repoFileSlug } from '../../src/mc/repo-snapshot.js';
import {
  LIST_KEEP, PROGRAMME_TRANSCRIPT_KEEP_MS, applyTidy, areaOf, gatherTidyFacts, orphanSlug, outsideRoots, runTidy, sessionLogRe,
  staleGateCacheEntry, tidyPlan, tidyRoots,
} from '../../src/mc/tidy.js';
import * as workTidy from '../../src/mc/work-tidy.js';

setLogPath(join(mkdtempSync(join(tmpdir(), 'mc-tidy-log-')), 'mc.log'));

const NOW = Date.parse('2026-10-12T12:00:00Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const OLD = NOW - 30 * DAY;
const RECENT = NOW - 2 * DAY;
const ROOT = '/w';
const ID = (n) => `3f9d2c81-0000-4000-8000-${String(n).padStart(12, '0')}`;

function facts(parts = {}) {
  return { now: NOW, work_root: ROOT, projects_root: '/c/projects', transcripts: [], leftovers: [], ...parts };
}
const transcript = (n, over = {}) => ({
  path: `/c/projects/-p/${ID(n)}.jsonl`, id: ID(n), cwd: '/elsewhere', cwd_exists: true, mtime_ms: OLD, bytes: 10, ...over,
});
const paths = (items) => items.map((item) => item.path);
const keptOf = (list, path) => list.kept.find((item) => item.path === path);
const ruled = (list, rule) => list.targets.filter((item) => item.rule === rule);

describe('tidyPlan — loose transcripts (L), first match wins', () => {
  it('T1: no cwd is kept, quietly', () => {
    const plan = tidyPlan(facts({ transcripts: [transcript(1, { cwd: null, cwd_exists: null })] }));
    assert.deepEqual(plan.targets, []);
    assert.equal(plan.kept[0].rule, 'T1');
  });
  it('T2: touched within --days is kept, even when its directory is gone; --days decides', () => {
    const one = transcript(1, { cwd: '/gone', cwd_exists: false, mtime_ms: RECENT });
    assert.equal(tidyPlan(facts({ transcripts: [one] })).kept[0].rule, 'T2');
    assert.equal(tidyPlan(facts({ transcripts: [one] }), { days: 1 }).targets.length, 1);
  });
  it('T3: an old transcript whose directory is gone goes; one that could not be stat-ed is kept', () => {
    const plan = tidyPlan(facts({ transcripts: [transcript(1, { cwd: '/gone', cwd_exists: false }), transcript(2, { cwd: '/x', cwd_exists: null })] }));
    assert.deepEqual(plan.targets.map((item) => [item.rule, item.kind, item.why]), [['T3', 'transcript', 'its directory is gone']]);
    assert.equal(keptOf(plan, transcript(2).path).rule, 'error');
    assert.match(keptOf(plan, transcript(2).path).why, /^error: could not tell/u);
  });
  it('T4: inside the work root, every one but the area\'s latest goes', () => {
    const plan = tidyPlan(facts({
      transcripts: [
        transcript(1, { cwd: `${ROOT}/work/a/repo`, mtime_ms: OLD }),
        transcript(2, { cwd: `${ROOT}/work/a`, mtime_ms: OLD - DAY }),
        transcript(3, { cwd: `${ROOT}/work/a/repo/src`, mtime_ms: OLD - 2 * DAY }),
      ],
    }));
    assert.deepEqual(paths(plan.targets).sort(), [transcript(2).path, transcript(3).path]);
    assert.equal(plan.targets[0].why, 'older than 14 days and not work/a\'s latest');
    assert.equal(keptOf(plan, transcript(1).path).rule, 'T4');
    assert.equal(areaOf(`${ROOT}/plan/mc/x`, ROOT), 'plan/mc');
    assert.equal(areaOf(`${ROOT}/step/p/memoro`, ROOT), 'step/p');
    assert.equal(areaOf(`${ROOT}/legacy/memoro`, ROOT), 'legacy');
    assert.equal(areaOf(`${ROOT}/work`, ROOT), null);
    assert.equal(areaOf(ROOT, ROOT), null);
    assert.equal(areaOf(`${ROOT}-other/x`, ROOT), null);
  });
  it('T5: an old transcript outside the work root whose directory exists is kept', () => {
    assert.equal(tidyPlan(facts({ transcripts: [transcript(1, { cwd: '/Users/x' })] })).kept[0].rule, 'T5');
  });
  it('an error reading a transcript keeps it with the error', () => {
    const plan = tidyPlan(facts({ transcripts: [transcript(1, { error: 'EACCES', cwd: '/gone', cwd_exists: false })] }));
    assert.deepEqual(plan.targets, []);
    assert.deepEqual(plan.kept[0], { path: transcript(1).path, rule: 'error', why: 'error: EACCES' });
  });
  it('an old <uuid>/ with no transcript goes; a recent one or one that errored stays', () => {
    const plan = tidyPlan(facts({
      leftovers: [
        { path: `/c/projects/-p/${ID(1)}`, newest_ms: OLD, bytes: 3 },
        { path: `/c/projects/-p/${ID(2)}`, newest_ms: RECENT, bytes: 3 },
        { path: `/c/projects/-p/${ID(3)}`, error: 'EACCES' },
      ],
    }));
    assert.deepEqual(plan.targets.map((item) => [item.path, item.kind]), [[`/c/projects/-p/${ID(1)}`, 'leftover']]);
    assert.equal(keptOf(plan, `/c/projects/-p/${ID(3)}`).rule, 'error');
  });
});

describe('--days', () => {
  it('mc tidy and mc work tidy take the same: 14 by default, a whole number, at least 1, and no name', () => {
    for (const [parse, head] of [[parseTidyArgs, []], [parseArgs, ['tidy']]]) {
      assert.equal(parse([...head]).days, 14);
      assert.equal(parse([...head, '--days', '3']).days, 3);
      assert.ok(parse([...head, '--days', '0']).error);
      assert.ok(parse([...head, '--days', 'x']).error);
      assert.ok(parse([...head, 'name']).error);
    }
    assert.equal(parseTidyArgs(['--apply', '--json']).apply, true);
    assert.equal(parseTidyArgs(['--apply', '--json']).json, true);
  });
  it('register.log is not a session log, so tidy keeps it', () => {
    assert.equal(sessionLogRe('register').test('register.log'), false);
  });
  it('work-tidy.js is tidy.js', () => {
    assert.equal(workTidy.runTidy, runTidy);
    assert.equal(workTidy.tidyPlan, tidyPlan);
  });
});

/* ---------------------------------------------------------- filesystem */

const LOG_HEAD = '| date | programme | project | outcome | summary | doc | pointer |\n|---|---|---|---|---|---|---|\n';
const logRow = (project) => `| 2026-10-01 | mc | ${project} | done | it ended | none | - |\n`;

/**
 * A temp home: the work root, `~/.claude`, and `MC_REPOS_HOME` with both
 * repositories. git is faked: `main` holds what each repository's origin/main
 * has under `docs/project/`, and its project_log.md.
 */
function machine() {
  const home = mkdtempSync(join(tmpdir(), 'mc-tidy-'));
  const work = join(home, 'mc');
  const claude = join(home, 'claude');
  const projects = join(claude, 'projects');
  const reposHome = join(home, 'repos');
  for (const dir of [work, projects, join(reposHome, 'memoro'), join(reposHome, 'memoro-cli')]) mkdirSync(dir, { recursive: true });
  const env = { ...process.env, MC_WORK_ROOT: work, CLAUDE_CONFIG_DIR: claude, CODEX_HOME: join(home, 'codex'), MC_REPOS_HOME: reposHome, MC_HOME: join(home, 'mchome') };
  const main = { memoro: { tree: [], log: LOG_HEAD }, 'memoro-cli': { tree: [], log: LOG_HEAD } };
  const worktrees = { memoro: [], 'memoro-cli': [] };
  const nameOf = (cwd) => (cwd.endsWith('memoro-cli') ? 'memoro-cli' : 'memoro');
  const m = {
    home, work, projects, env, main, worktrees,
    gitFails: false,
    worktreeState: {},
    cwds: [{ pid: 1, cwd: '/' }],
    released: [],
    pruned: [],
  };
  m.write = (path, text = 'x', at = OLD) => {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, text);
    utimesSync(path, new Date(at), new Date(at));
  };
  m.head = (cwd) => `${JSON.stringify({ type: 'user', cwd, message: { content: 'hi' } })}\n`;
  m.register = (entry) => {
    const path = registerPath(work, entry.project);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, JSON.stringify(entry));
  };
  m.git = (cwd, args) => {
    if (m.gitFails) return null;
    const repo = main[nameOf(cwd)];
    if (args[0] === 'ls-tree') return repo.tree.join('\n');
    if (args[0] === 'show') return repo.log;
    if (args[0] === 'worktree') return [cwd, ...worktrees[nameOf(cwd)]].map((path) => `worktree ${path}\nHEAD abc\n`).join('\n');
    if (args[0] === 'rev-parse' && args.includes('--git-common-dir')) return `${join(reposHome, 'memoro')}/.git\n`;
    return null;
  };
  m.inspect = (path, name) => ({
    is_git: true, path, repo: name, branch: name, git_common_dir: '/fake/.git',
    uncommitted: 0, unmerged_commits: 0, landed: 'landed', ...m.worktreeState[name],
  });
  m.doors = (over = {}) => ({
    env, now: NOW, git: m.git, cwds: () => m.cwds, inspect: m.inspect, pullAtTip: () => null, command: () => 'claude',
    release: (wt) => { m.released.push(wt.path); rmSync(wt.path, { recursive: true }); return true; },
    prune: (repoPaths) => { m.pruned.push(...repoPaths); },
    ...over,
  });
  m.cleanup = () => rmSync(home, { recursive: true, force: true });
  return m;
}

/** A finished project, archived or not, with every file the runner leaves of it. */
function project(m, name, { programme = 'mc', archived = true, closeout = true, planOnMain = false, legacyArea = false, steps = [] } = {}) {
  // Layout 2: the project's directory under programs/, its CLOSEOUT.json beside its plan, its register STATE.json.
  const plan = existsSync(join(m.work, 'runner', 'layout.json')) ? join(m.work, 'programs', programme, name, 'PLAN.json') : null;
  if (plan) m.write(plan, '{}');
  if (plan && closeout) m.write(join(m.work, 'programs', programme, name, 'CLOSEOUT.json'), '{}');
  m.register({ project: name, repo: 'memoro-cli', programme, steps, ...(plan ? { plan } : {}) });
  const repo = m.main['memoro-cli'];
  if (archived) repo.log += logRow(name);
  if (closeout) repo.tree.push(`docs/project/${programme}/closeout/${name}.json`);
  if (planOnMain) repo.tree.push(`docs/project/${programme}/${name}/PLAN.json`);
  if (legacyArea) mkdirSync(join(m.work, name, 'memoro-cli'), { recursive: true });
  const files = {
    log: join(m.work, 'runner', 'log', `${name}-20261001T100000Z.jsonl`),
    err: join(m.work, 'runner', 'log', `${name}-20261001T100000Z.json.err`),
    closed: join(m.work, 'runner', 'log', 'closed', name, 'step-1.jsonl'),
    scratch: join(m.work, 'runner', 'scratch', `${name}-20261001T100000Z`, 'probe.txt'),
    register: registerPath(m.work, name),
  };
  for (const key of ['log', 'err', 'closed', 'scratch']) m.write(files[key]);
  return files;
}

describe('(P) a project archived with its closeout on main', () => {
  it('loses its register file, session logs, closed logs, scratch and transcripts — and ui-faults-2 keeps its own', () => {
    const m = machine();
    try {
      const mine = project(m, 'ui-faults');
      const other = project(m, 'ui-faults-2', { archived: false, closeout: false, planOnMain: true });
      const session = join(m.projects, '-mc-step-ui-faults-memoro-cli', `${ID(1)}.jsonl`);
      m.write(session, m.head(join(m.work, 'step', 'ui-faults', 'memoro-cli')), NOW - HOUR);
      const { list } = runTidy(m.doors());
      const p = ruled(list, 'P');
      assert.deepEqual(p.map((item) => item.path).sort(), [
        mine.log, mine.err, join(m.work, 'runner', 'log', 'closed', 'ui-faults'), join(m.work, 'runner', 'scratch', 'ui-faults-20261001T100000Z'), mine.register, session,
      ].sort());
      assert.equal(p.filter((item) => item.kind !== 'transcript').at(-1).kind, 'register', 'the register file last');
      for (const file of Object.values(other)) assert.ok(!p.some((item) => file === item.path || file.startsWith(`${item.path}/`)), `${file} is ui-faults-2's`);
      assert.equal(keptOf(list, other.register).rule, 'project');
    } finally { m.cleanup(); }
  });

  it('nothing goes without a closeout, with a legacy area, or with a step blocked on time', () => {
    const m = machine();
    try {
      const bare = project(m, 'no-closeout', { closeout: false });
      const legacy = project(m, 'legacy', { legacyArea: true });
      const waiting = project(m, 'waiting', {
        archived: false, closeout: false, planOnMain: true,
        steps: [{ status: 'blocked', blocked_by: { kind: 'time', name: '2026-10-20T00:00:00Z' } }],
      });
      const { list } = runTidy(m.doors());
      assert.deepEqual(ruled(list, 'P'), []);
      assert.equal(keptOf(list, bare.register).why, 'no closeout on origin/main');
      assert.equal(keptOf(list, legacy.register).why, 'an area for it still exists');
      assert.equal(keptOf(list, waiting.register).why, 'not archived: no row in project_log.md on origin/main');
    } finally { m.cleanup(); }
  });

  it('a repository git cannot answer for stops every purge', () => {
    const m = machine();
    try {
      const mine = project(m, 'ui-faults');
      m.gitFails = true;
      const { list } = runTidy(m.doors());
      assert.deepEqual(ruled(list, 'P'), []);
      assert.match(keptOf(list, mine.register).why, /^git could not answer/u);
    } finally { m.cleanup(); }
  });
});

describe('(P) a plan under ~/mc/programs/ is there while its file is', () => {
  it('plan_on_main is the file\'s existence, and origin/main\'s tree is not asked for it', () => {
    const m = machine();
    try {
      const here = join(m.home, 'programs', 'mc', 'here', 'PLAN.json');
      const gone = join(m.home, 'programs', 'mc', 'gone', 'PLAN.json');
      m.write(here);
      m.register({ project: 'here', repo: 'memoro-cli', programme: 'mc', plan: here, steps: [] });
      m.register({ project: 'gone', repo: 'memoro-cli', programme: 'mc', plan: gone, steps: [] });
      m.main['memoro-cli'].tree.push('docs/project/mc/gone/PLAN.json');
      const items = Object.fromEntries(gatherTidyFacts(m.doors()).projects.map((item) => [item.project, item]));
      assert.equal(items.here.plan_on_main, true);
      assert.equal(items.gone.plan_on_main, false, 'the repository has it, but the file under programs does not');
    } finally { m.cleanup(); }
  });
});

describe('(P) a plan under ~/mc/programs/ with its closeout beside it', () => {
  it('is a purge target once its row is on main and no area is left', () => {
    const m = machine();
    try {
      const plan = join(m.work, 'programs', 'mc', 'closed', 'PLAN.json');
      m.write(plan);
      m.write(join(m.work, 'programs', 'mc', 'closed', 'CLOSEOUT.json'));
      m.main['memoro-cli'].log += logRow('closed');
      m.register({ project: 'closed', repo: 'memoro-cli', programme: 'mc', plan, steps: [] });
      const { list } = runTidy(m.doors());
      assert.ok(ruled(list, 'P').some((item) => item.path === registerPath(m.work, 'closed')));
    } finally { m.cleanup(); }
  });

  it('without its CLOSEOUT.json the plan is still there, and the project is kept', () => {
    const m = machine();
    try {
      const plan = join(m.work, 'programs', 'mc', 'open', 'PLAN.json');
      m.write(plan);
      m.main['memoro-cli'].log += logRow('open');
      m.register({ project: 'open', repo: 'memoro-cli', programme: 'mc', plan, steps: [] });
      const { list } = runTidy(m.doors());
      assert.deepEqual(ruled(list, 'P'), []);
      assert.equal(keptOf(list, registerPath(m.work, 'open')).why, 'its plan directory is still on origin/main');
    } finally { m.cleanup(); }
  });
});

describe('(P) a project the runner has archived: its directory is under archive/projects/', () => {
  it('its session log and scratch go, and its STATE.json stays', () => {
    const m = machine();
    try {
      layout2(m);
      const dir = join(m.work, 'archive', 'projects', 'mc', 'moved');
      m.write(join(dir, 'PLAN.json'), '{}');
      m.write(join(dir, 'CLOSEOUT.json'), '{}');
      m.write(join(dir, 'STATE.json'), JSON.stringify({ project: 'moved', repo: 'memoro-cli', programme: 'mc', steps: [], criteria: [] }));
      m.main['memoro-cli'].log += logRow('moved');
      const log = join(m.work, 'runner', 'log', 'moved-20261001T100000Z.jsonl');
      const scratch = join(m.work, 'runner', 'scratch', 'moved-20261001T100000Z');
      m.write(log);
      m.write(join(scratch, 'probe.txt'));
      const { list } = runTidy(m.doors());
      const p = ruled(list, 'P').map((item) => item.path);
      assert.ok(p.includes(log), 'its session log is a P target');
      assert.ok(p.includes(scratch), 'its scratch directory is a P target');
      assert.ok(!list.targets.some((item) => item.path === join(dir, 'STATE.json')), 'its STATE.json is not a target');
      assert.equal(existsSync(join(dir, 'STATE.json')), true);
    } finally { m.cleanup(); }
  });
});

describe('(G) planning transcripts', () => {
  it('the newest of a directory stays at any age, and so does anything within 72 hours; memory/ is never listed', () => {
    const m = machine();
    try {
      assert.equal(PROGRAMME_TRANSCRIPT_KEEP_MS, 72 * HOUR);
      const mc = join(m.work, 'plan', 'mc');
      const staff = join(m.work, 'plan', 'staff');
      mkdirSync(mc, { recursive: true });
      mkdirSync(staff, { recursive: true });
      const one = join(m.projects, '-mc-plan-mc');
      const two = join(m.projects, '-mc-plan-staff');
      m.write(join(one, `${ID(1)}.jsonl`), m.head(mc), NOW - 5 * DAY);
      m.write(join(two, `${ID(2)}.jsonl`), m.head(staff), NOW - 10 * HOUR);
      m.write(join(two, `${ID(3)}.jsonl`), m.head(staff), NOW - 4 * DAY);
      m.write(join(two, `${ID(4)}.jsonl`), m.head(staff), NOW - 4 * DAY - HOUR);
      m.write(join(two, 'memory', 'MEMORY.md'), '# memory', OLD);
      const { list } = runTidy(m.doors());
      assert.deepEqual(paths(ruled(list, 'G')).sort(), [join(two, `${ID(3)}.jsonl`), join(two, `${ID(4)}.jsonl`)]);
      assert.equal(keptOf(list, join(one, `${ID(1)}.jsonl`)).why, 'the newest of its directory');
      assert.equal(keptOf(list, join(two, `${ID(2)}.jsonl`)).rule, 'G');
      const all = [...list.targets, ...list.kept].map((item) => item.path);
      assert.ok(!all.some((path) => path.includes('memory')), 'memory/ is never read');
    } finally { m.cleanup(); }
  });
});

/** A planning area of programme mc, its own checkouts, three extra worktrees, and a work area. */
function planArea(m) {
  const area = join(m.work, 'plan', 'mc');
  for (const name of ['memoro', 'memoro-cli', 'wt-a', 'wt-b', 'wt-c']) m.write(join(area, name, '.git'), 'gitdir: /fake');
  m.write(join(m.work, 'work', 'x', 'memoro', '.git'), 'gitdir: /fake');
  m.worktreeState['wt-b'] = { uncommitted: 2 };
  m.cwds = [{ pid: 1, cwd: '/' }, { pid: 4242, cwd: join(area, 'wt-c', 'src') }];
  return area;
}

describe('(X), (W), (S) and (R): areas and worktrees', () => {
  it('a merged clean worktree goes; dirty, in use, a checkout and a work area stay', () => {
    const m = machine();
    try {
      const area = planArea(m);
      m.worktrees.memoro.push('/private/tmp/claude-501/agent-1');
      const { list } = runTidy(m.doors());
      assert.deepEqual(list.targets.map((item) => [item.path, item.kind, item.rule]), [[join(area, 'wt-a'), 'plan-worktree', 'X']]);
      assert.equal(keptOf(list, join(area, 'wt-b')).why, '2 uncommitted');
      assert.equal(keptOf(list, join(area, 'wt-c')).why, 'in use by claude');
      assert.equal(keptOf(list, join(area, 'memoro')).rule, 'plan-checkout');
      assert.equal(keptOf(list, join(area, 'memoro-cli')).rule, 'plan-checkout');
      assert.equal(keptOf(list, join(m.work, 'work', 'x')).rule, 'work-area');
      assert.equal(keptOf(list, '/private/tmp/claude-501/agent-1').rule, 'foreign-worktree');
    } finally { m.cleanup(); }
  });

  it('an lsof that throws keeps every plan worktree', () => {
    const m = machine();
    try {
      const area = planArea(m);
      const { list } = runTidy(m.doors({ cwds: () => { throw new Error('lsof: not found'); } }));
      assert.deepEqual(ruled(list, 'X'), []);
      for (const name of ['wt-a', 'wt-b', 'wt-c']) assert.equal(keptOf(list, join(area, name)).rule, 'error');
    } finally { m.cleanup(); }
  });

  it('the apply removes the worktree through git, prunes both repositories, and leaves the rest', () => {
    const m = machine();
    try {
      const area = planArea(m);
      const { outcome } = runTidy({ ...m.doors(), apply: true });
      assert.deepEqual(m.released, [join(area, 'wt-a')]);
      assert.deepEqual(m.pruned, [join(m.home, 'repos', 'memoro'), join(m.home, 'repos', 'memoro-cli')]);
      assert.deepEqual({ removed: outcome.removed, kept: outcome.kept }, { removed: 1, kept: 0 });
      for (const name of ['memoro', 'memoro-cli', 'wt-b', 'wt-c']) assert.ok(existsSync(join(area, name)));
      assert.ok(existsSync(join(m.work, 'work', 'x', 'memoro')));
    } finally { m.cleanup(); }
  });
});

/** A programme's own two checkouts under programs/ in layout 2, clean and landed. */
function checkoutsOf(m, programme = 'mc') {
  layout2(m);
  const area = join(m.work, 'programs', programme);
  for (const name of ['memoro', 'memoro-cli']) m.write(join(area, name, '.git'), 'gitdir: /fake');
  return area;
}

describe('(I) a planning area\'s own checkouts, while their programme has no project that is not done', () => {
  it('a clean, landed checkout of an idle programme is an (I) target, and the apply releases it through git', () => {
    const m = machine();
    try {
      const area = checkoutsOf(m);
      const { list, outcome } = runTidy({ ...m.doors(), apply: true });
      assert.deepEqual(list.targets.map((item) => [item.path, item.kind, item.rule]), [
        [join(area, 'memoro'), 'plan-checkout', 'I'], [join(area, 'memoro-cli'), 'plan-checkout', 'I'],
      ]);
      assert.ok(list.targets.every((item) => item.bytes > 0), 'weighed, since the rule takes them');
      assert.deepEqual(m.released, [join(area, 'memoro'), join(area, 'memoro-cli')]);
      assert.equal(outcome.removed, 2);
      assert.equal(existsSync(join(area, 'memoro')), false);
    } finally { m.cleanup(); }
  });

  it('a draft in the programme keeps both, and says why', () => {
    const m = machine();
    try {
      const area = checkoutsOf(m);
      m.write(join(area, 'drafting', 'DRAFT.json'), '{}');
      const { list } = runTidy(m.doors());
      assert.deepEqual(ruled(list, 'I'), []);
      assert.equal(keptOf(list, join(area, 'memoro')).rule, 'plan-checkout');
      assert.equal(keptOf(list, join(area, 'memoro-cli')).why, 'its programme has a project that is not done');
    } finally { m.cleanup(); }
  });

  it('a sent plan whose step is not done keeps both', () => {
    const m = machine();
    try {
      const area = checkoutsOf(m);
      project(m, 'busy', { archived: false, closeout: false, steps: [{ status: 'ready' }] });
      const { list } = runTidy(m.doors());
      assert.deepEqual(ruled(list, 'I'), []);
      assert.equal(keptOf(list, join(area, 'memoro')).why, 'its programme has a project that is not done');
    } finally { m.cleanup(); }
  });

  it('a plan whose every step is done but whose criterion is not met keeps both: it is not done', () => {
    const m = machine();
    try {
      const area = checkoutsOf(m);
      const plan = join(area, 'waiting', 'PLAN.json');
      m.write(plan, '{}');
      m.register({ project: 'waiting', repo: 'memoro-cli', programme: 'mc', plan, steps: [{ status: 'done' }], criteria: [{ met: false }] });
      const { list } = runTidy(m.doors());
      assert.deepEqual(ruled(list, 'I'), []);
      assert.equal(keptOf(list, join(area, 'memoro-cli')).why, 'its programme has a project that is not done');
    } finally { m.cleanup(); }
  });

  it('a process standing in the programme\'s directory keeps both, though it stands in neither checkout', () => {
    const m = machine();
    try {
      const area = checkoutsOf(m);
      m.cwds = [{ pid: 1, cwd: '/' }, { pid: 4242, cwd: join(area, 'memoro-cli', 'src') }];
      const { list } = runTidy(m.doors());
      assert.deepEqual(ruled(list, 'I'), []);
      assert.equal(keptOf(list, join(area, 'memoro')).why, 'in use by claude');
      assert.equal(keptOf(list, join(area, 'memoro-cli')).why, 'in use by claude');
    } finally { m.cleanup(); }
  });

  it('an uncommitted change keeps that checkout only', () => {
    const m = machine();
    try {
      const area = checkoutsOf(m);
      m.worktreeState.memoro = { uncommitted: 3 };
      const { list } = runTidy(m.doors());
      assert.deepEqual(ruled(list, 'I').map((item) => item.path), [join(area, 'memoro-cli')]);
      assert.equal(keptOf(list, join(area, 'memoro')).why, '3 uncommitted');
    } finally { m.cleanup(); }
  });

  it('an lsof that fails keeps both, with the error', () => {
    const m = machine();
    try {
      const area = checkoutsOf(m);
      const { list } = runTidy(m.doors({ cwds: () => { throw new Error('lsof: not found'); } }));
      assert.deepEqual(ruled(list, 'I'), []);
      for (const name of ['memoro', 'memoro-cli']) {
        assert.equal(keptOf(list, join(area, name)).rule, 'error');
        assert.equal(keptOf(list, join(area, name)).why, 'error: lsof could not say who stands in it');
      }
    } finally { m.cleanup(); }
  });

  it('a draft that appears between the list and the apply keeps both: the apply asks again', () => {
    const m = machine();
    try {
      const area = checkoutsOf(m);
      const { listPath } = runTidy(m.doors());
      m.write(join(area, 'late', 'DRAFT.json'), '{}');
      const outcome = applyTidy({ listPath, ...m.doors() });
      assert.deepEqual(m.released, []);
      assert.equal(outcome.removed, 0);
      assert.equal(outcome.applied.length, 2);
      assert.ok(outcome.applied.every((item) => !item.ok && /^re-check: its programme has a project that is not done/u.test(item.why)), JSON.stringify(outcome.applied));
    } finally { m.cleanup(); }
  });

  it('outsideRoots accepts a checkout at <plan root>/<programme>/memoro and refuses another directory of the programme', () => {
    const m = machine();
    try {
      const area = checkoutsOf(m);
      m.write(join(area, 'other', '.git'), 'gitdir: /fake');
      const roots = tidyRoots(m.env);
      assert.equal(outsideRoots({ kind: 'plan-checkout', path: join(area, 'memoro') }, roots), null);
      assert.match(outsideRoots({ kind: 'plan-checkout', path: join(area, 'other') }, roots), /^not the shape a plan-checkout has/u);
    } finally { m.cleanup(); }
  });
});

/** `~/mc/runner/layout.json` saying layout 2 (ruling 51). */
function layout2(m) {
  m.write(join(m.work, 'runner', 'layout.json'), JSON.stringify({ schema: 'mc-layout', version: 2 }), NOW);
}

describe('layout 2: programs/, runner/step/ and runner/deps/', () => {
  it('every spelling is its own area, never one bucket for programs/ or runner/', () => {
    assert.equal(areaOf(`${ROOT}/programs/p`, ROOT), 'programs/p');
    assert.equal(areaOf(`${ROOT}/programs/p/project`, ROOT), 'programs/p');
    assert.equal(areaOf(`${ROOT}/runner/step/x/memoro`, ROOT), 'runner/step/x');
    assert.equal(areaOf(`${ROOT}/runner/deps/deps-a/memoro`, ROOT), 'runner/deps/deps-a');
    assert.equal(areaOf(`${ROOT}/programs`, ROOT), null);
    assert.equal(areaOf(`${ROOT}/runner/step`, ROOT), null);
    assert.equal(areaOf(`${ROOT}/runner/deps`, ROOT), null);
    assert.equal(areaOf(`${ROOT}/runner/log`, ROOT), 'runner', 'no area: the first segment, as before');
    assert.equal(areaOf(`${ROOT}/brief`, ROOT), 'brief');
  });

  it('a transcript standing in programs/<p> falls under G, and the newest of each programme stays', () => {
    const plan = tidyPlan(facts({
      transcripts: [
        transcript(1, { path: `/c/projects/-w-programs-a/${ID(1)}.jsonl`, cwd: `${ROOT}/programs/a`, mtime_ms: OLD }),
        transcript(2, { path: `/c/projects/-w-programs-a/${ID(2)}.jsonl`, cwd: `${ROOT}/programs/a`, mtime_ms: OLD - DAY }),
        transcript(3, { path: `/c/projects/-w-programs-b/${ID(3)}.jsonl`, cwd: `${ROOT}/programs/b/memoro`, mtime_ms: OLD - 2 * DAY }),
      ],
    }));
    assert.deepEqual(plan.targets.map((item) => [item.path, item.rule]), [[`/c/projects/-w-programs-a/${ID(2)}.jsonl`, 'G']]);
    assert.match(plan.targets[0].why, /\(programs\/a\)$/u);
    assert.equal(keptOf(plan, `/c/projects/-w-programs-a/${ID(1)}.jsonl`).why, 'the newest of its directory');
    assert.equal(keptOf(plan, `/c/projects/-w-programs-b/${ID(3)}.jsonl`).why, 'the newest of its directory');
  });

  it('T4 keeps the newest of each runner/step and runner/deps area, not one for all of runner/', () => {
    const plan = tidyPlan(facts({
      transcripts: [
        transcript(1, { cwd: `${ROOT}/runner/step/a/memoro`, mtime_ms: OLD }),
        transcript(2, { cwd: `${ROOT}/runner/step/a`, mtime_ms: OLD - DAY }),
        transcript(3, { cwd: `${ROOT}/runner/step/b/memoro`, mtime_ms: OLD - 2 * DAY }),
        transcript(4, { cwd: `${ROOT}/runner/deps/deps-a/memoro`, mtime_ms: OLD - 3 * DAY }),
      ],
    }));
    assert.deepEqual(paths(plan.targets), [transcript(2).path]);
    assert.equal(plan.targets[0].why, 'older than 14 days and not runner/step/a\'s latest');
    for (const n of [1, 3, 4]) assert.equal(keptOf(plan, transcript(n).path).rule, 'T4');
  });

  it('a transcript under runner/step/<x> falls under P once x is purged, its STATE.json never; a deps area\'s never does', () => {
    const m = machine();
    try {
      layout2(m);
      const mine = project(m, 'x');
      project(m, 'deps-a');
      const session = join(m.projects, '-mc-runner-step-x-memoro-cli', `${ID(1)}.jsonl`);
      const bump = join(m.projects, '-mc-runner-deps-deps-a-memoro', `${ID(2)}.jsonl`);
      m.write(session, m.head(join(m.work, 'runner', 'step', 'x', 'memoro-cli')), NOW - HOUR);
      m.write(bump, m.head(join(m.work, 'runner', 'deps', 'deps-a', 'memoro')), NOW - HOUR);
      const { list } = runTidy(m.doors());
      const p = paths(ruled(list, 'P'));
      assert.ok(p.includes(session));
      assert.equal(mine.register, join(m.work, 'programs', 'mc', 'x', 'STATE.json'));
      assert.ok(!p.includes(mine.register), 'a project\'s state is its knowledge (ruling 51)');
      for (const file of [mine.log, mine.err, join(m.work, 'runner', 'log', 'closed', 'x'), join(m.work, 'runner', 'scratch', 'x-20261001T100000Z')]) {
        assert.ok(p.includes(file), `${file} is still purged`);
      }
      assert.ok(!p.includes(bump), 'a deps area is no project\'s');
    } finally { m.cleanup(); }
  });

  it('a project whose runner/step area is still there is kept', () => {
    const m = machine();
    try {
      layout2(m);
      const mine = project(m, 'x');
      mkdirSync(join(m.work, 'runner', 'step', 'x', 'memoro-cli'), { recursive: true });
      const { list } = runTidy(m.doors());
      assert.equal(keptOf(list, mine.register).why, 'an area for it still exists');
    } finally { m.cleanup(); }
  });

  it('X walks programs/: a project\'s directory is skipped, a merged worktree goes through the root check', () => {
    const m = machine();
    try {
      layout2(m);
      const area = join(m.work, 'programs', 'mc');
      for (const name of ['memoro', 'memoro-cli', 'wt-a']) m.write(join(area, name, '.git'), 'gitdir: /fake');
      m.write(join(area, 'layout', 'PLAN.json'), '{}');
      const { list, outcome } = runTidy({ ...m.doors(), apply: true });
      assert.deepEqual(list.targets.map((item) => [item.path, item.kind, item.rule]), [[join(area, 'wt-a'), 'plan-worktree', 'X']]);
      assert.equal(keptOf(list, join(area, 'memoro')).rule, 'plan-checkout');
      assert.ok(![...list.targets, ...list.kept].some((item) => item.path.startsWith(join(area, 'layout'))), 'a project directory is not a worktree');
      assert.deepEqual(outcome.applied.map((item) => [item.path, item.ok]), [[join(area, 'wt-a'), true]]);
      assert.ok(existsSync(join(area, 'layout', 'PLAN.json')));
    } finally { m.cleanup(); }
  });
});

describe('(C) mc shot --compare trees under ~/.memoro/mc/compare/', () => {
  /** Three compare trees of memoro: one stale, one used today, one stale with a dev server in it. */
  function compares(m) {
    const root = join(m.home, 'mchome', 'compare');
    const tree = (name, at) => {
      const path = join(root, name);
      m.write(join(path, '.git'), 'gitdir: x', at);
      utimesSync(path, new Date(at), new Date(at));
      return path;
    };
    const paths = { stale: tree('memoro-a-1111111111', NOW - 2 * DAY), recent: tree('memoro-b-2222222222', NOW - 2 * HOUR), served: tree('memoro-c-3333333333', NOW - 3 * DAY) };
    // git lists them as memoro's worktrees; they are (C)'s, not foreign.
    m.worktrees.memoro.push(paths.stale, paths.recent, paths.served);
    m.removedWorktrees = [];
    const doors = (over = {}) => m.doors({
      servers: (dir) => (dir === paths.served ? [{ pid: 9 }] : []),
      removeWorktree: (owner, path) => { m.removedWorktrees.push([owner, path]); rmSync(path, { recursive: true }); return true; },
      ...over,
    });
    return { paths, doors };
  }

  it('one unused for a day with no dev server is listed; used today or served is kept, and none is foreign', () => {
    const m = machine();
    try {
      const { paths, doors } = compares(m);
      const { list } = runTidy(doors());
      assert.deepEqual(ruled(list, 'C').map((item) => [item.path, item.kind, item.owner]), [[paths.stale, 'compare-worktree', join(m.home, 'repos', 'memoro')]]);
      assert.equal(keptOf(list, paths.recent).why, 'used in the last day');
      assert.equal(keptOf(list, paths.served).why, 'a dev server runs in it (1)');
      assert.equal(list.kept.some((item) => item.rule === 'foreign-worktree'), false);
      // A dry run removes nothing.
      assert.deepEqual(m.removedWorktrees, []);
      assert.ok(existsSync(paths.stale));
    } finally { m.cleanup(); }
  });

  it('--apply removes it with git worktree remove in the repository that owns it', () => {
    const m = machine();
    try {
      const { paths, doors } = compares(m);
      const { outcome } = runTidy({ ...doors(), apply: true });
      assert.deepEqual(m.removedWorktrees, [[join(m.home, 'repos', 'memoro'), paths.stale]]);
      assert.equal(existsSync(paths.stale), false);
      assert.ok(existsSync(paths.recent) && existsSync(paths.served));
      assert.equal(outcome.applied.find((item) => item.path === paths.stale).ok, true);
    } finally { m.cleanup(); }
  });

  it('a tree git refuses to remove, or one whose server started since the list, stays', () => {
    const m = machine();
    try {
      const { paths, doors } = compares(m);
      const refused = runTidy({ ...doors({ removeWorktree: () => false }), apply: true });
      assert.equal(refused.outcome.applied.find((item) => item.path === paths.stale).why, 'git worktree remove refused');
      const { listPath } = runTidy(doors());
      const applied = applyTidy({ listPath, ...doors({ servers: () => [{ pid: 1 }] }) });
      assert.match(applied.applied.find((item) => item.path === paths.stale).why, /^re-check: a dev server runs in it/u);
      assert.ok(existsSync(paths.stale));
    } finally { m.cleanup(); }
  });

  it('a tree whose servers cannot be asked, or whose owner git cannot name, is kept with the error', () => {
    const m = machine();
    try {
      const { paths, doors } = compares(m);
      const { list } = runTidy(doors({ servers: () => { throw new Error('registry unreadable'); } }));
      assert.equal(keptOf(list, paths.stale).rule, 'error');
      const git = m.git;
      const owned = runTidy(doors({ git: (cwd, args) => (args[0] === 'rev-parse' ? null : git(cwd, args)) }));
      assert.match(keptOf(owned.list, paths.stale).why, /git could not name the repository/u);
    } finally { m.cleanup(); }
  });
});

describe('(K) slug directories no repository mc knows has, under the gate, its cache and the selection state', () => {
  /** The one repository the tests know: its bare path and its checkout. */
  const repos = (m) => [{ name: 'memoro', path: join(m.home, 'repos', 'memoro.git'), checkout: join(m.home, 'repos', 'memoro') }];

  /** A slug directory with one file in it, its directories last touched at `at` too: `newestMtime` reads them. */
  function slugTree(m, path, at = OLD) {
    m.write(join(path, 'node_modules', 'x.js'), 'x', at);
    for (const dir of [path, join(path, 'node_modules')]) utimesSync(dir, new Date(at), new Date(at));
    return path;
  }

  it('gatherTidyFacts names the slug directories of the three roots, and knows the ones a repository mc knows has', () => {
    const m = machine();
    try {
      const known = repoFileSlug(repos(m)[0].path);
      slugTree(m, join(m.work, 'gate', known));
      slugTree(m, join(m.work, 'gate', `${known}-freshen`));
      slugTree(m, join(m.work, 'gate', 'old-12345678'));
      slugTree(m, join(m.work, 'gate-cache', 'memoro-a66fc130'));
      slugTree(m, join(m.home, 'mchome', 'selection', 'memoro-1ee6756a'));
      m.write(join(m.work, 'gate', 'stray.txt'));
      const items = Object.fromEntries(gatherTidyFacts(m.doors({ repos: repos(m) })).cache_slugs.map((item) => [item.slug, item]));
      assert.deepEqual(Object.keys(items).sort(), [known, `${known}-freshen`, 'memoro-1ee6756a', 'memoro-a66fc130', 'old-12345678'].sort());
      assert.equal(items[known].known, true);
      assert.equal(items[`${known}-freshen`].known, true);
      assert.equal(items['old-12345678'].known, false);
      assert.deepEqual(items['old-12345678'].live, []);
      assert.equal(items['memoro-1ee6756a'].kind, 'selection-slug');
      assert.equal(items['memoro-1ee6756a'].path, join(m.home, 'mchome', 'selection', 'memoro-1ee6756a'));
      assert.equal(items['memoro-a66fc130'].kind, 'gate-cache-slug');
    } finally { m.cleanup(); }
  });

  it('a root that cannot be read gives no items, and the plan keeps the rest', () => {
    const m = machine();
    try {
      const facts = gatherTidyFacts(m.doors({ repos: repos(m) }));
      assert.deepEqual(facts.cache_slugs, []);
      assert.equal(facts.register_error, null);
    } finally { m.cleanup(); }
  });

  it('orphanSlug keeps a known slug, a slug with a process in it, and one touched within a day; it throws on an error', () => {
    const orphan = { path: '/x/gate/old-12345678', kind: 'gate-slug', slug: 'old-12345678', known: false, live: [], newest_ms: OLD, bytes: 0 };
    assert.deepEqual(orphanSlug({ ...orphan, known: true }, NOW), { target: false, why: 'a repository mc knows uses it' });
    assert.deepEqual(orphanSlug({ ...orphan, live: [42, 77] }, NOW), { target: false, why: 'process 42, 77 stands in it' });
    assert.deepEqual(orphanSlug({ ...orphan, newest_ms: NOW - HOUR }, NOW), { target: false, why: 'touched in the last day' });
    assert.deepEqual(orphanSlug(orphan, NOW), { target: true, why: 'no repository mc knows has the slug old-12345678' });
    assert.throws(() => orphanSlug({ ...orphan, error: 'EACCES: permission denied' }, NOW), /EACCES/u);
    assert.throws(() => orphanSlug({ ...orphan, live: null }, NOW), /could not tell whether a process stands in it/u);
  });

  it('tidyPlan removes one unknown slug under each root and keeps the known ones, by rule K', () => {
    const slug = (kind, name, over = {}) => ({ path: `/x/${kind}/${name}`, kind, slug: name, known: false, live: [], newest_ms: OLD, bytes: 7, ...over });
    const items = ['gate-cache-slug', 'gate-slug', 'selection-slug'].flatMap((kind) => [
      slug(kind, 'memoro.git-17111bc1', { known: true, newest_ms: null, bytes: 0 }),
      slug(kind, 'old-12345678'),
    ]);
    const plan = tidyPlan(facts({ cache_slugs: items }));
    assert.deepEqual(ruled(plan, 'K').map((item) => [item.path, item.kind, item.bytes]), [
      ['/x/gate-cache-slug/old-12345678', 'gate-cache-slug', 7],
      ['/x/gate-slug/old-12345678', 'gate-slug', 7],
      ['/x/selection-slug/old-12345678', 'selection-slug', 7],
    ]);
    for (const kind of ['gate-cache-slug', 'gate-slug', 'selection-slug']) {
      assert.equal(keptOf(plan, `/x/${kind}/memoro.git-17111bc1`).rule, 'K');
      assert.equal(keptOf(plan, `/x/${kind}/memoro.git-17111bc1`).why, 'a repository mc knows uses it');
    }
  });

  it('outsideRoots accepts a direct child of the selection root and refuses one nested two levels deep', () => {
    const m = machine();
    try {
      const roots = tidyRoots(m.env);
      const direct = join(roots.selection, 'memoro-1ee6756a');
      const nested = join(roots.selection, 'memoro-1ee6756a', 'deeper');
      mkdirSync(nested, { recursive: true });
      assert.equal(outsideRoots({ kind: 'selection-slug', path: direct }, roots), null);
      assert.match(outsideRoots({ kind: 'selection-slug', path: nested }, roots), /^not the shape a selection-slug has/u);
    } finally { m.cleanup(); }
  });

  it('--apply removes an unknown slug tree that is read-only inside, and keeps a known one', () => {
    const m = machine();
    try {
      const known = slugTree(m, join(m.work, 'gate', repoFileSlug(repos(m)[0].path)));
      const orphan = slugTree(m, join(m.work, 'gate', 'old-12345678'));
      const inner = join(orphan, 'node_modules');
      chmodSync(join(inner, 'x.js'), 0o444);
      chmodSync(inner, 0o555);
      chmodSync(orphan, 0o555);
      const { outcome } = runTidy({ ...m.doors({ repos: repos(m) }), apply: true });
      assert.equal(existsSync(orphan), false);
      assert.equal(outcome.applied.find((item) => item.path === orphan).ok, true);
      assert.ok(existsSync(known));
    } finally { m.cleanup(); }
  });
});

describe('(A) gate-cache entries under a known slug, by their last use', () => {
  const repos = (m) => [{ name: 'memoro', path: join(m.home, 'repos', 'memoro.git'), checkout: join(m.home, 'repos', 'memoro') }];
  const entry = (over = {}) => ({ path: '/x/gate-cache/memoro.git-17111bc1/k', key: 'k', staging: false, at: null, newest_ms: OLD, bytes: 0, ...over });

  /** A known slug's cache: one entry used two days ago, one whose meta says OLD, one with no meta, and a staging a killed store left. */
  function cacheOf(m) {
    const cache = join(m.work, 'gate-cache', repoFileSlug(repos(m)[0].path));
    const dirs = { used: join(cache, 'used'), idle: join(cache, 'idle'), bare: join(cache, 'bare'), staging: join(cache, 'killed.tmp-4242') };
    m.write(join(dirs.used, 'meta.json'), JSON.stringify({ key: 'used', at: NOW - 2 * DAY }));
    m.write(join(dirs.idle, 'meta.json'), JSON.stringify({ key: 'idle', at: OLD }));
    for (const dir of Object.values(dirs)) if (dir !== dirs.used) m.write(join(dir, 'node_modules', 'x.js'), 'x', OLD);
    for (const dir of Object.values(dirs)) utimesSync(dir, new Date(OLD), new Date(OLD));
    return dirs;
  }

  it('staleGateCacheEntry: used in the last fourteen days is kept, unused for fifteen is a target; meta.at beats the directory', () => {
    assert.deepEqual(staleGateCacheEntry(entry({ at: NOW - 13 * DAY }), NOW), { target: false, why: 'used in the last 14 days' });
    assert.deepEqual(staleGateCacheEntry(entry({ at: NOW - 15 * DAY }), NOW), { target: true, why: 'no round has used it for 15 days' });
    assert.equal(staleGateCacheEntry(entry({ at: NOW - HOUR, newest_ms: OLD }), NOW).target, false);
  });

  it('staleGateCacheEntry: without a meta its directory\'s mtime decides', () => {
    assert.deepEqual(staleGateCacheEntry(entry({ at: null, newest_ms: OLD }), NOW), { target: true, why: 'no round has used it for 30 days' });
  });

  it('staleGateCacheEntry: staging is a target once a day old, and kept while a store may be running', () => {
    assert.deepEqual(staleGateCacheEntry(entry({ staging: true, newest_ms: NOW - HOUR }), NOW), { target: false, why: 'a store may be running' });
    assert.deepEqual(staleGateCacheEntry(entry({ staging: true, newest_ms: NOW - 2 * DAY }), NOW), { target: true, why: 'a store that never finished' });
  });

  it('staleGateCacheEntry: an error throws, and a time that is not known is never a target', () => {
    assert.throws(() => staleGateCacheEntry(entry({ error: 'EACCES: permission denied' }), NOW), /EACCES/u);
    assert.throws(() => staleGateCacheEntry(entry({ at: null, newest_ms: null }), NOW), /could not tell when it was last used/u);
  });

  it('tidyPlan: a target is rule A under its kind, a keep is A, and an error keeps with its error', () => {
    const cache = (key, over = {}) => ({ path: `/x/gate-cache/memoro.git-17111bc1/${key}`, key, staging: key.includes('.tmp-'), at: null, newest_ms: OLD, bytes: 9, ...over });
    const plan = tidyPlan(facts({
      gate_cache_entries: [cache('used', { at: NOW - 2 * DAY }), cache('idle', { at: OLD }), cache('killed.tmp-4242'), cache('broken', { error: 'EACCES' })],
    }));
    assert.deepEqual(plan.targets.map((item) => [item.path, item.kind, item.rule, item.why, item.bytes]), [
      [cache('idle').path, 'gate-cache-entry', 'A', 'no round has used it for 30 days', 9],
      [cache('killed.tmp-4242').path, 'gate-cache-entry', 'A', 'a store that never finished', 9],
    ]);
    assert.equal(keptOf(plan, cache('used').path).rule, 'A');
    assert.equal(keptOf(plan, cache('used').path).why, 'used in the last 14 days');
    assert.deepEqual(keptOf(plan, cache('broken').path), { path: cache('broken').path, rule: 'error', why: 'error: EACCES' });
  });

  it('gatherTidyFacts judges every entry of a known slug: meta.at decides, a missing meta falls back to the mtime, staging by its age', () => {
    const m = machine();
    try {
      const { used, idle, bare, staging } = cacheOf(m);
      const items = Object.fromEntries(gatherTidyFacts(m.doors({ repos: repos(m) })).gate_cache_entries.map((item) => [item.key, item]));
      assert.equal(items.used.at, NOW - 2 * DAY);
      assert.equal(items.bare.at, null);
      assert.equal(items.bare.newest_ms, OLD);
      assert.equal(items['killed.tmp-4242'].staging, true);
      const { list } = runTidy(m.doors({ repos: repos(m) }));
      assert.deepEqual(ruled(list, 'A').map((item) => item.path).sort(), [idle, bare, staging].sort());
      assert.ok(ruled(list, 'A').every((item) => item.kind === 'gate-cache-entry' && item.bytes > 0));
      assert.equal(keptOf(list, used).rule, 'A');
      assert.equal(keptOf(list, used).why, 'used in the last 14 days');
    } finally { m.cleanup(); }
  });

  it('--apply removes a stale entry through rmTree, read-only files and all, and keeps the one used', () => {
    const m = machine();
    try {
      const { used, idle } = cacheOf(m);
      chmodSync(join(idle, 'node_modules', 'x.js'), 0o444);
      chmodSync(join(idle, 'node_modules'), 0o555);
      chmodSync(idle, 0o555);
      const { outcome } = runTidy({ ...m.doors({ repos: repos(m) }), apply: true });
      assert.equal(existsSync(idle), false);
      assert.equal(outcome.applied.find((item) => item.path === idle).ok, true);
      assert.ok(existsSync(used));
    } finally { m.cleanup(); }
  });

  it('outsideRoots accepts <gate-cache>/<slug>/<key> as an entry and refuses <gate-cache>/<slug> as one', () => {
    const m = machine();
    try {
      const roots = tidyRoots(m.env);
      const entryPath = join(roots.gate_cache, 'memoro-a66fc130', 'k1');
      mkdirSync(entryPath, { recursive: true });
      assert.equal(outsideRoots({ kind: 'gate-cache-entry', path: entryPath }, roots), null);
      assert.match(outsideRoots({ kind: 'gate-cache-entry', path: join(roots.gate_cache, 'memoro-a66fc130') }, roots), /^not the shape a gate-cache-entry has/u);
    } finally { m.cleanup(); }
  });
});

describe('the list file and the apply', () => {
  it('a dry run writes the list whole, every target and keep with its rule', () => {
    const m = machine();
    try {
      project(m, 'ui-faults');
      const { list, listPath, outcome } = runTidy(m.doors());
      assert.equal(outcome, null);
      assert.equal(listPath, join(m.work, 'runner', 'tidy', '20261012T120000Z.json'));
      const written = JSON.parse(readFileSync(listPath, 'utf8'));
      assert.deepEqual(written, list);
      assert.equal(written.rules_version, 5);
      for (const item of written.targets) assert.deepEqual(Object.keys(item).sort(), ['bytes', 'kind', 'path', 'rule', 'why']);
      for (const item of written.kept) assert.deepEqual(Object.keys(item).sort(), ['path', 'rule', 'why']);
      assert.ok(existsSync(registerPath(m.work, 'ui-faults')), 'a dry run removes nothing');
      assert.equal(runTidy(m.doors()).listPath, join(m.work, 'runner', 'tidy', '20261012T120000Z-2.json'));
    } finally { m.cleanup(); }
  });

  it('the list is written before the first removal, and applied is appended to it', () => {
    const m = machine();
    try {
      const mine = project(m, 'ui-faults');
      const order = [];
      const write = (path, value) => { order.push(['write', value.applied ? 'applied' : 'list']); mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, JSON.stringify(value)); };
      const remove = (path) => { order.push(['remove', path]); rmSync(path, { recursive: true }); };
      const { listPath, outcome } = runTidy({ ...m.doors(), apply: true, write, remove });
      assert.deepEqual(order[0], ['write', 'list']);
      assert.deepEqual(order.at(-1), ['write', 'applied']);
      assert.ok(order.slice(1, -1).every(([what]) => what === 'remove'));
      assert.equal(order.slice(1, -1).at(-1)[1], mine.register, 'the register file last');
      for (const file of Object.values(mine)) assert.equal(existsSync(file), false, file);
      const written = JSON.parse(readFileSync(listPath, 'utf8'));
      assert.equal(written.applied.length, 5);
      assert.ok(written.applied.every((item) => item.ok));
      assert.equal(outcome.removed, 5);
    } finally { m.cleanup(); }
  });

  it('a rule that flips between the list and the apply keeps its target', () => {
    const m = machine();
    try {
      const area = planArea(m);
      const { listPath } = runTidy(m.doors());
      m.worktreeState['wt-a'] = { uncommitted: 1 };
      const outcome = applyTidy({ listPath, ...m.doors() });
      assert.deepEqual(m.released, []);
      assert.ok(existsSync(join(area, 'wt-a')));
      assert.deepEqual(outcome.applied, [{ path: join(area, 'wt-a'), ok: false, why: 're-check: 1 uncommitted' }]);
      assert.equal(outcome.kept, 1);
    } finally { m.cleanup(); }
  });

  it('a hand-edited list naming a path outside the roots, or the wrong shape inside one, is refused', () => {
    const m = machine();
    try {
      const outside = join(m.home, 'elsewhere', 'precious.json');
      const memory = join(m.projects, '-p', 'memory', `${ID(7)}.jsonl`);
      const project_log = join(m.home, 'repos', 'memoro-cli', 'docs', 'project', 'project_log.md');
      for (const path of [outside, memory, project_log]) m.write(path);
      mkdirSync(join(m.work, 'runner', 'projects'), { recursive: true });
      const listPath = join(m.work, 'runner', 'tidy', '20261012T110000Z.json');
      m.write(listPath, JSON.stringify({
        at: 'x', rules_version: 1, kept: [],
        targets: [
          { path: outside, kind: 'register', rule: 'P', why: 'edited', bytes: 1 },
          { path: memory, kind: 'transcript', rule: 'T3', why: 'edited', bytes: 1 },
          { path: project_log, kind: 'session-log', rule: 'P', why: 'edited', bytes: 1 },
          { path: join(m.work, 'work'), kind: 'work-area', rule: 'W', why: 'edited', bytes: 1 },
        ],
      }));
      const outcome = applyTidy({ listPath, ...m.doors() });
      assert.equal(outcome.removed, 0);
      assert.ok(outcome.applied.every((item) => !item.ok && /^(refused|error): /u.test(item.why)), JSON.stringify(outcome.applied));
      for (const path of [outside, memory, project_log]) assert.ok(existsSync(path), path);
    } finally { m.cleanup(); }
  });

  it(`the newest ${LIST_KEEP} list files are kept`, () => {
    const m = machine();
    try {
      for (let n = 0; n < LIST_KEEP + 3; n += 1) m.write(join(m.work, 'runner', 'tidy', `202609${String(n + 1).padStart(2, '0')}T000000Z.json`), '{}');
      const { listPath } = runTidy({ ...m.doors(), apply: true });
      const left = readdirSync(join(m.work, 'runner', 'tidy')).sort();
      assert.equal(left.length, LIST_KEEP);
      assert.equal(left.at(-1), listPath.split('/').at(-1));
    } finally { m.cleanup(); }
  });
});

describe('the printout', () => {
  const list = {
    at: 'x', rules_version: 1, days: 14,
    targets: [
      ...Array.from({ length: 12 }, (_, n) => ({ path: `/c/projects/-p/${ID(n)}.jsonl`, kind: 'transcript', rule: 'T3', why: 'its directory is gone', bytes: 1e8 })),
      { path: '/w/plan/mc/wt-a', kind: 'plan-worktree', rule: 'X', why: '#12 merged at this tip', bytes: 2e9 },
    ],
    kept: [
      { path: '/w/work/x', rule: 'work-area', why: 'only mc work release or discard removes a work area' },
      { path: '/w/plan/mc/wt-b', rule: 'X', why: '2 uncommitted' },
    ],
  };
  const capture = () => { const out = []; return { out, stdout: { write: (text) => out.push(text) } }; };

  const noDocker = async () => null;

  it('a dry run gives counts and bytes per rule, the first ten targets, the keeps worth reading, and the list', async () => {
    const { out, stdout } = capture();
    const code = await tidyCommand({ apply: false, days: 14 }, { stdout, tidy: () => ({ list, listPath: '/w/runner/tidy/l.json', outcome: null }), docker: noDocker });
    const text = out.join('');
    assert.equal(code, 0);
    assert.match(text, /T3 +12 /u);
    assert.match(text, /X +1 /u);
    assert.match(text, /the first 10 of 13/u);
    assert.match(text, /X {2}\/w\/plan\/mc\/wt-b — 2 uncommitted/u);
    assert.doesNotMatch(text, /work\/x/u, 'a work area kept is the ordinary case');
    assert.match(text, /list: \/w\/runner\/tidy\/l\.json/u);
  });

  it('--apply says what it freed and what the re-check kept; --json is the list', async () => {
    const outcome = { applied: [{ path: '/w/plan/mc/wt-a', ok: false, why: 're-check: 1 uncommitted' }], freed: 1.2e9, removed: 12, kept: 1 };
    const { out, stdout } = capture();
    assert.equal(await tidyCommand({ apply: true, days: 14 }, { stdout, tidy: () => ({ list, listPath: '/l.json', outcome }), docker: noDocker }), 1);
    assert.match(out.join(''), /freed 1\.20 GB in 12 items, kept 1 on re-check/u);
    const json = capture();
    await tidyCommand({ json: true, days: 14 }, { stdout: json.stdout, tidy: () => ({ list, listPath: '/l.json', outcome: null }), docker: noDocker });
    assert.deepEqual(JSON.parse(json.out.join('')), list);
  });

  const pruned = (ok = true) => ({
    up: true, apply: true, reclaimable: null, reason: null,
    pruned: [{ what: 'images', ok, reclaimed: ok ? '12.4GB' : null, detail: ok ? null : 'daemon gone' }],
  });

  it('mc tidy asks Docker too, without starting it, and a failed prune exits 1', async () => {
    const asked = [];
    const docker = async (options) => { asked.push(options); return pruned(false); };
    const { out, stdout } = capture();
    const outcome = { applied: [], freed: 0, removed: 0, kept: 0 };
    assert.equal(await tidyCommand({ apply: true, days: 14 }, { stdout, tidy: () => ({ list, listPath: '/l.json', outcome }), docker }), 1);
    assert.deepEqual(asked, [{ apply: true }], 'no start: only --docker may start the runtime');
    assert.match(out.join(''), /docker: the images prune failed — daemon gone/u);
  });

  it('--docker runs Docker alone; with --apply it may start the runtime', async () => {
    let files = 0;
    const asked = [];
    const docker = async (options) => { asked.push(options); return pruned(); };
    const { out, stdout } = capture();
    const code = await tidyCommand({ apply: true, docker: true, days: 14 }, { stdout, tidy: () => { files += 1; }, docker });
    assert.equal(code, 0);
    assert.equal(files, 0, 'no list is written and no file removed');
    assert.equal(asked[0].apply, true);
    assert.equal(asked[0].start.run, 'mc tidy --docker');
    assert.match(out.join(''), /images unused for 3 days pruned — 12\.4GB reclaimed/u);

    const dry = capture();
    const stopped = { up: false, apply: false, reclaimable: null, pruned: [], reason: 'orbstack is not running' };
    assert.equal(await tidyCommand({ docker: true, days: 14 }, { stdout: dry.stdout, docker: async (options) => { asked.push(options); return stopped; } }), 0);
    assert.equal(asked[1].start, null, 'a dry run never starts it');
    assert.match(dry.out.join(''), /nothing pruned — orbstack is not running \(mc tidy --docker --apply starts it\)/u);
  });

  it('--docker takes --apply and --json, not --days', () => {
    assert.equal(parseTidyArgs(['--docker']).docker, true);
    assert.equal(parseTidyArgs(['--docker', '--apply']).apply, true);
    assert.ok(parseTidyArgs(['--docker', '--days', '3']).error);
    assert.equal(parseTidyArgs([]).docker, false);
  });
});
