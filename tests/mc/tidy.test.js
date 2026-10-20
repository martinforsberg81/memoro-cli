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
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { parseArgs as parseTidyArgs, tidyCommand } from '../../src/mc/commands/tidy.js';
import { parseArgs } from '../../src/mc/commands/work.js';
import { setLogPath } from '../../src/mc/logger.js';
import { registerPath } from '../../src/mc/register.js';
import {
  LIST_KEEP, PROGRAMME_TRANSCRIPT_KEEP_MS, applyTidy, areaOf, gatherTidyFacts, runTidy, sessionLogRe, tidyPlan,
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
    mkdirSync(join(work, 'runner', 'projects'), { recursive: true });
    writeFileSync(registerPath(work, entry.project), JSON.stringify(entry));
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
  m.register({ project: name, repo: 'memoro-cli', programme, steps });
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
      assert.equal(written.rules_version, 1);
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
    pruned: [{ what: 'images', ok, reclaimed: ok ? '12.4GB' : null, detail: ok ? null : 'daemon gone' }, { what: 'build cache', ok: true, reclaimed: '2.1GB', detail: null }],
  });

  it('mc tidy asks Docker too, without starting it, and a failed prune exits 1', async () => {
    const asked = [];
    const docker = async (options) => { asked.push(options); return pruned(false); };
    const { out, stdout } = capture();
    const outcome = { applied: [], freed: 0, removed: 0, kept: 0 };
    assert.equal(await tidyCommand({ apply: true, days: 14 }, { stdout, tidy: () => ({ list, listPath: '/l.json', outcome }), docker }), 1);
    assert.deepEqual(asked, [{ apply: true }], 'no start: only --docker may start the runtime');
    assert.match(out.join(''), /docker: the images prune failed — daemon gone/u);
    assert.match(out.join(''), /docker: build cache unused for 3 days pruned — 2\.1GB reclaimed/u);
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
