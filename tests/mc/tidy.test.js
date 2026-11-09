import { cwdsOfUser } from '../../src/mc/standing.js';
/**
 * `mc tidy` (tidy.js): one list, written first, decided purely, and each
 * entry asked again at removal.
 *
 * 2026-09-26: an ad-hoc loop meant to remove orphaned transcripts deleted
 * nearly all of `~/.claude/projects`, `memory/` included. These tests are
 * mostly about what survives.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import { parseArgs as parseTidyArgs, tidyCommand } from '../../src/mc/commands/tidy.js';
import { setLogPath } from '../../src/mc/logger.js';
import { diskSummary } from '../../src/mc/disk-pressure.js';
import { goalJson } from './_helpers/goal-file.js';
import { addGoalWorktree } from '../../src/mc/goals.js';
import { repoFileSlug } from '../../src/mc/repo-snapshot.js';
import { defaultRepos } from '../../src/mc/repos.js';
import { createExport } from '../../src/mc/scratch.js';
import { blobId as gitBlobId, gitModel } from './_helpers/git-model.js';
import {
  LIST_KEEP, PROGRAMME_TRANSCRIPT_KEEP_MS, applyTidy, areaOf, gatherTidyFacts, openFilesAmong, orphanSlug, outsideRoots, runTidy,
  staleGateCacheEntry, tidyPlan, tidyRoots,
} from '../../src/mc/tidy.js';

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
  it('mc tidy takes 14 by default, a whole number, at least 1, and no name', () => {
    for (const [parse, head] of [[parseTidyArgs, []]]) {
      assert.equal(parse([...head]).days, 14);
      assert.equal(parse([...head, '--days', '3']).days, 3);
      assert.ok(parse([...head, '--days', '0']).error);
      assert.ok(parse([...head, '--days', 'x']).error);
      assert.ok(parse([...head, 'name']).error);
    }
    assert.equal(parseTidyArgs(['--apply', '--json']).apply, true);
    assert.equal(parseTidyArgs(['--apply', '--json']).json, true);
  });
});

/* ---------------------------------------------------------- filesystem */

/**
 * A temp home: the work root, `~/.claude`, and `MC_REPOS_HOME` with both
 * repositories. git is faked: it lists each repository's worktrees and names
 * the repository that owns a compare tree.
 */
function machine() {
  const home = mkdtempSync(join(tmpdir(), 'mc-tidy-'));
  const work = join(home, 'mc');
  const claude = join(home, 'claude');
  const projects = join(claude, 'projects');
  const reposHome = join(home, 'repos');
  for (const dir of [work, projects, join(reposHome, 'memoro'), join(reposHome, 'memoro-cli')]) mkdirSync(dir, { recursive: true });
  const env = { ...process.env, HOME: home, MC_WORK_ROOT: work, CLAUDE_CONFIG_DIR: claude, CODEX_HOME: join(home, 'codex'), MC_REPOS_HOME: reposHome, MC_HOME: join(home, 'mchome') };
  const worktrees = { memoro: [], 'memoro-cli': [] };
  const nameOf = (cwd) => (cwd.endsWith('memoro-cli') ? 'memoro-cli' : 'memoro');
  const m = {
    home, work, projects, env, worktrees,
    worktreeState: {},
    cwds: [{ pid: 1, cwd: '/' }],
    released: [],
    pruned: [],
    fetches: [],
    fetchFails: false,
  };
  m.write = (path, text = 'x', at = OLD) => {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, text);
    utimesSync(path, new Date(at), new Date(at));
  };
  m.head = (cwd) => `${JSON.stringify({ type: 'user', cwd, message: { content: 'hi' } })}\n`;
  m.git = (cwd, args) => {
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
    filesOpen: (paths) => new Map(paths.map((path) => [path, []])),
    release: (wt) => { m.released.push(wt.path); rmSync(wt.path, { recursive: true }); return true; },
    removeWorktree: (owner, path) => { m.released.push(path); rmSync(path, { recursive: true }); return true; },
    prune: (repoPaths) => { m.pruned.push(...repoPaths); },
    ...over,
  });
  m.cleanup = () => rmSync(home, { recursive: true, force: true });
  return m;
}

/** A goal of programme `programme` in layout 2, with its GOAL.json at `stage` and `status`. */
function goal(m, name, stage = 'build', { programme = 'mc', status = 'ready', text = null } = {}) {
  m.write(join(m.work, 'programs', programme, 'goals', name, 'GOAL.json'), text ?? goalJson({ stage, status }), NOW);
}

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
      // The runner's run is no person's: a retired workarea that could go is listed and kept.
      assert.equal(keptOf(list, join(m.work, 'work', 'x')).rule, 'W');
      assert.match(keptOf(list, join(m.work, 'work', 'x')).why, /only a person's mc tidy --apply removes one/u);
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

/**
 * What is left under `~/mc/work/` after the workareas were retired: one that
 * may go, and one of each reason to stay. `inspect` answers per path, so each
 * area's checkout says its own thing.
 */
function retiredAreas(m) {
  const at = (name, repo = 'memoro') => join(m.work, 'work', name, repo);
  for (const name of ['landed', 'dirty', 'ahead', 'notes', 'busy']) m.write(join(at(name), '.git'), 'gitdir: /fake');
  m.write(join(m.work, 'work', 'landed', '.mc.json'), '{}');
  m.write(join(m.work, 'work', 'notes', 'notes.md'), 'mine');
  m.cwds = [{ pid: 1, cwd: '/' }, { pid: 77, cwd: join(m.work, 'work', 'busy') }];
  const state = { [at('dirty')]: { uncommitted: 3 }, [at('ahead')]: { unmerged_commits: 2, landed: 'ahead' } };
  const inspect = (path, name) => ({ ...m.inspect(path, name), ...state[path] });
  return { at, inspect };
}

describe('(U) a step area left from the retired project steps', () => {
  it('is listed with its verdict, and only a person\'s apply removes one', () => {
    const m = machine();
    try {
      for (const name of ['orphan', 'dirty-orphan']) m.write(join(m.work, 'step', name, 'memoro-cli', '.git'), 'gitdir: /fake');
      const dirty = join(m.work, 'step', 'dirty-orphan', 'memoro-cli');
      const inspect = (path, name) => ({ ...m.inspect(path, name), ...(path === dirty ? { uncommitted: 1 } : {}) });
      const { list } = runTidy(m.doors({ inspect, person: true }));
      assert.deepEqual(ruled(list, 'U').map((item) => [item.path, item.kind, item.why]),
        [[join(m.work, 'step', 'orphan'), 'orphan-step-area', 'a step area left from the retired project steps: memoro-cli landed with nothing uncommitted']]);
      assert.equal(keptOf(list, join(m.work, 'step', 'dirty-orphan')).why, 'a step area left from the retired project steps; memoro-cli: 1 uncommitted');
      // The runner's apply takes none of them.
      const runner = runTidy({ ...m.doors({ inspect }), apply: true });
      assert.deepEqual(ruled(runner.list, 'U'), []);
      assert.ok(existsSync(join(m.work, 'step', 'orphan', 'memoro-cli')));
      const person = runTidy({ ...m.doors({ inspect }), person: true, apply: true });
      assert.deepEqual(person.outcome.applied.map((item) => [item.path, item.ok]), [[join(m.work, 'step', 'orphan'), true]]);
      assert.equal(existsSync(join(m.work, 'step', 'orphan')), false);
    } finally { m.cleanup(); }
  });
});

describe('(W) what is left under ~/mc/work/', () => {
  it('without --apply lists every one, says why each stays or goes, and removes nothing', () => {
    const m = machine();
    try {
      const { at, inspect } = retiredAreas(m);
      const { list, outcome } = runTidy(m.doors({ inspect, person: true }));
      assert.equal(outcome, null);
      const area = (name) => join(m.work, 'work', name);
      assert.deepEqual(ruled(list, 'W').map((item) => [item.path, item.kind]), [[area('landed'), 'work-area']]);
      assert.equal(list.targets.find((item) => item.rule === 'W').why, 'a retired workarea: memoro landed with nothing uncommitted');
      assert.equal(keptOf(list, area('dirty')).why, 'memoro: 3 uncommitted');
      assert.equal(keptOf(list, area('ahead')).why, 'memoro: 2 commits main lacks');
      assert.equal(keptOf(list, area('notes')).why, 'it holds more than checkouts: notes.md');
      assert.equal(keptOf(list, area('busy')).why, 'process 77 stands in it');
      for (const name of ['landed', 'dirty', 'ahead', 'notes', 'busy']) {
        assert.equal(keptOf(list, area(name))?.rule ?? 'W', 'W', `${name} is listed under W`);
        assert.ok(existsSync(at(name)), `${name} is still there`);
      }
      assert.deepEqual(m.released, []);
    } finally { m.cleanup(); }
  });

  it('a person\'s --apply hands the landed one back to git and removes it, and leaves every other', () => {
    const m = machine();
    try {
      const { at, inspect } = retiredAreas(m);
      const { outcome } = runTidy({ ...m.doors({ inspect }), person: true, apply: true });
      assert.deepEqual(m.released, [at('landed')]);
      assert.equal(existsSync(join(m.work, 'work', 'landed')), false);
      assert.deepEqual(outcome.applied.map((item) => [item.path, item.ok]), [[join(m.work, 'work', 'landed'), true]]);
      for (const name of ['dirty', 'ahead', 'notes', 'busy']) assert.ok(existsSync(at(name)), `${name} is still there`);
    } finally { m.cleanup(); }
  });

  it('the runner\'s apply removes none of them', () => {
    const m = machine();
    try {
      const { at, inspect } = retiredAreas(m);
      const { list } = runTidy({ ...m.doors({ inspect }), apply: true });
      assert.deepEqual(ruled(list, 'W'), []);
      assert.deepEqual(m.released, []);
      assert.ok(existsSync(at('landed')));
    } finally { m.cleanup(); }
  });

  it('mc tidy is a person\'s unless MC_HEADLESS says it is a session\'s', async () => {
    const asked = [];
    const tidy = (opts) => { asked.push(opts.person); return { list: { targets: [], kept: [] }, listPath: '/l.json', outcome: null }; };
    const stdout = { write: () => {} };
    await tidyCommand({ apply: false, days: 14 }, { stdout, tidy, docker: async () => null, env: {} });
    await tidyCommand({ apply: false, days: 14 }, { stdout, tidy, docker: async () => null, env: { MC_HEADLESS: '1' } });
    assert.deepEqual(asked, [true, false]);
  });
});

/** A programme's own two checkouts under programs/ in layout 2, clean and landed. */
function checkoutsOf(m, programme = 'mc') {
  layout2(m);
  const area = join(m.work, 'programs', programme);
  for (const name of ['memoro', 'memoro-cli']) {
    m.write(join(area, name, '.git'), 'gitdir: /fake');
    ageTree(join(area, name), OLD);
  }
  return area;
}

/** A planning session of `programme` on record: a foreground `mc plan` (`pid`), or a lane file from before 2026-11-07 naming a runner plan session. */
function planRecord(m, { foreground = null, runner = null }) {
  if (foreground) m.write(join(m.work, 'runner', 'foreground', `${foreground.pid}.json`), JSON.stringify({ verb: 'plan', programme: foreground.programme, pid: foreground.pid }), NOW);
  if (runner) m.write(join(m.work, 'runner', `current-${runner.repo ?? 'memoro'}.json`), JSON.stringify({ kind: 'plan', programme: runner.programme, session_pid: runner.pid }), NOW);
}

describe('(I) a planning area\'s own checkouts, while no planning session of their programme runs and they are untouched', () => {
  it('a clean, landed checkout untouched for 72 hours is an (I) target, and the apply releases it through git', () => {
    const m = machine();
    try {
      const area = checkoutsOf(m);
      const { list, outcome } = runTidy({ ...m.doors(), apply: true });
      assert.deepEqual(list.targets.map((item) => [item.path, item.kind, item.rule]), [
        [join(area, 'memoro'), 'plan-checkout', 'I'], [join(area, 'memoro-cli'), 'plan-checkout', 'I'],
      ]);
      assert.equal(list.targets[0].why, 'no planning session of its programme is running, untouched for 72 hours; mc plan adds it back');
      assert.ok(list.targets.every((item) => item.bytes > 0), 'weighed, since the rule takes them');
      assert.deepEqual(m.released, [join(area, 'memoro'), join(area, 'memoro-cli')]);
      assert.equal(outcome.removed, 2);
      assert.equal(existsSync(join(area, 'memoro')), false);
    } finally { m.cleanup(); }
  });

  it('an open goal in the programme does not hold an idle checkout: the rule reads use, not goals', () => {
    for (const [stage, status] of [['build', 'ready'], ['review', 'ready'], ['merge', 'ready'], ['build', 'blocked'], ['build', 'Martin']]) {
      const m = machine();
      try {
        const area = checkoutsOf(m);
        goal(m, 'open', stage, { status });
        goal(m, 'landed', 'done');
        const { list } = runTidy(m.doors());
        assert.deepEqual(paths(ruled(list, 'I')), [join(area, 'memoro'), join(area, 'memoro-cli')], `${stage} · ${status}`);
      } finally { m.cleanup(); }
    }
  });

  it('every goal done or dropped lets both go; another programme\'s open goal does not hold them', () => {
    const m = machine();
    try {
      const area = checkoutsOf(m);
      goal(m, 'one', 'done');
      goal(m, 'two', 'dropped');
      goal(m, 'elsewhere', 'build', { programme: 'staff' });
      const { list } = runTidy(m.doors());
      assert.deepEqual(paths(ruled(list, 'I')), [join(area, 'memoro'), join(area, 'memoro-cli')]);
    } finally { m.cleanup(); }
  });

  it('a checkout touched within 72 hours is kept, exactly 72 hours is kept, and the age is waived in a pressure pass', () => {
    const m = machine();
    try {
      const area = checkoutsOf(m);
      m.write(join(area, 'memoro', 'notes.md'), 'x', NOW - 2 * HOUR);
      utimesSync(join(area, 'memoro'), new Date(NOW - 72 * HOUR), new Date(NOW - 72 * HOUR));
      utimesSync(join(area, 'memoro-cli'), new Date(NOW - 72 * HOUR), new Date(NOW - 72 * HOUR));
      const regular = runTidy(m.doors());
      assert.deepEqual(ruled(regular.list, 'I'), []);
      assert.equal(keptOf(regular.list, join(area, 'memoro')).why, 'touched within the last 72 hours');
      assert.equal(keptOf(regular.list, join(area, 'memoro-cli')).why, 'touched within the last 72 hours', 'exactly 72 hours is kept');
      const pressured = runTidy({ ...m.doors(), pressure: true });
      assert.deepEqual(paths(ruled(pressured.list, 'I')), [join(area, 'memoro'), join(area, 'memoro-cli')]);
      assert.match(pressured.list.targets[0].why, /pressure pass; age exception/u);
    } finally { m.cleanup(); }
  });

  it('a live foreground plan record keeps both, and says so; a runner lane file names no planning session (the runner starts none since 2026-11-07)', () => {
    const m = machine();
    try {
      const area = checkoutsOf(m);
      planRecord(m, { foreground: { pid: process.pid, programme: 'mc' } });
      const { list } = runTidy(m.doors());
      assert.deepEqual(ruled(list, 'I'), []);
      assert.equal(keptOf(list, join(area, 'memoro')).why, 'a foreground plan session of it is running');
      assert.equal(keptOf(list, join(area, 'memoro-cli')).why, 'a foreground plan session of it is running');
    } finally { m.cleanup(); }
    const n = machine();
    try {
      const area = checkoutsOf(n);
      planRecord(n, { runner: { pid: process.pid, programme: 'mc' } });
      const { list } = runTidy(n.doors());
      assert.deepEqual(paths(ruled(list, 'I')).sort(), [join(area, 'memoro'), join(area, 'memoro-cli')].sort(), 'a lane file from before, naming a plan kind, holds nothing');
    } finally { n.cleanup(); }
  });

  it('a plan record of a dead process, or of another programme, holds nothing', () => {
    const m = machine();
    try {
      const area = checkoutsOf(m);
      planRecord(m, { foreground: { pid: 2147483646, programme: 'mc' } });
      planRecord(m, { runner: { pid: 2147483646, programme: 'mc', repo: 'memoro-cli' } });
      planRecord(m, { foreground: { pid: process.pid, programme: 'staff' } });
      const { list } = runTidy(m.doors());
      assert.deepEqual(paths(ruled(list, 'I')), [join(area, 'memoro'), join(area, 'memoro-cli')]);
    } finally { m.cleanup(); }
  });

  it('a commit main lacks keeps that checkout only, with the commit count as its why', () => {
    const m = machine();
    try {
      const area = checkoutsOf(m);
      m.worktreeState.memoro = { unmerged_commits: 2, landed: 'ahead' };
      const { list } = runTidy(m.doors());
      assert.deepEqual(paths(ruled(list, 'I')), [join(area, 'memoro-cli')]);
      assert.equal(keptOf(list, join(area, 'memoro')).why, '2 commits main lacks');
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

  it('a planning session started between the list and the apply keeps both: the apply asks again', () => {
    const m = machine();
    try {
      checkoutsOf(m);
      const { listPath } = runTidy(m.doors());
      planRecord(m, { foreground: { pid: process.pid, programme: 'mc' } });
      const outcome = applyTidy({ listPath, ...m.doors() });
      assert.deepEqual(m.released, []);
      assert.equal(outcome.removed, 0);
      assert.equal(outcome.applied.length, 2);
      assert.ok(outcome.applied.every((item) => !item.ok && item.why === 're-check: a foreground plan session of it is running'), JSON.stringify(outcome.applied));
    } finally { m.cleanup(); }
  });

  it('outsideRoots accepts a checkout at <plan root>/<programme>/memoro and refuses another directory of the programme', () => {
    const m = machine();
    try {
      const area = checkoutsOf(m);
      m.write(join(area, 'other', '.git'), 'gitdir: /fake');
      const roots = tidyRoots(m.env);
      assert.equal(Object.hasOwn(roots, 'compare'), false);
      assert.deepEqual(tidyPlan(facts({ [['compare', '_worktrees'].join('')]: [{ path: join(m.home, 'compare', 'stray') }] })).targets, []);
      assert.equal(outsideRoots({ kind: 'plan-checkout', path: join(area, 'memoro') }, roots), null);
      assert.match(outsideRoots({ kind: 'plan-checkout', path: join(area, 'other') }, roots), /^not the shape a plan-checkout has/u);
    } finally { m.cleanup(); }
  });
});

/** `~/mc/runner/layout.json` saying layout 2 (ruling 51). */
function layout2(m) {
  m.write(join(m.work, 'runner', 'layout.json'), JSON.stringify({ schema: 'mc-layout', version: 2 }), NOW);
}

/** A registered, synthetic goal worktree and the Git/process answers it needs. */
function planGoalTree(m, { name = 'draft', stage = 'draft', status = 'ready', recent = false, ignored = '', dirty = '', own = '0', pushed = null, advertised = pushed !== null, cwd = '/', open = [], registration = true, metadata = null } = {}) {
  layout2(m);
  const dir = join(m.work, 'programs', 'mc', 'goals', name);
  const path = join(dir, 'memoro');
  const owner = join(m.home, 'repos', 'memoro');
  mkdirSync(owner, { recursive: true });
  const json = metadata ?? goalJson({ stage, status, repos: ['memoro'] });
  m.write(join(dir, 'GOAL.json'), json, recent ? NOW : OLD);
  m.write(join(dir, 'LOG.md'), '# Goal\n', recent ? NOW : OLD);
  m.write(join(path, '.git'), 'gitdir: /fake/admin/worktrees/draft\n', recent ? NOW : OLD);
  ageTree(dir, recent ? NOW : OLD);
  m.planGoalStates ||= new Map();
  m.planGoalStates.set(path, { name, owner, ignored, dirty, own, pushed, advertised, cwd, open, registration, branch: `goal/${name}`, head: 'a'.repeat(40) });
  m.cwds = [{ pid: 1, cwd: '/' }, ...[...m.planGoalStates.values()].filter((state) => state.cwd !== '/').map((state, index) => ({ pid: 9001 + index, cwd: state.cwd }))];
  const prior = m.git;
  const git = (at, args) => {
    if (args[0] === 'fetch') { m.fetches.push([at, ...args]); return m.fetchFails ? null : ''; }
    if (at === owner && args[0] === 'worktree' && args[1] === 'list') return `${owner}\n` + [...m.planGoalStates.values()].filter((state) => state.registration).map((state) => `worktree ${join(m.work, 'programs', 'mc', 'goals', state.name, 'memoro')}\nHEAD ${'a'.repeat(40)}\n`).join('\n');
    if (at === owner && args[0] === 'ls-remote') {
      const state = [...m.planGoalStates.values()].find((candidate) => args.at(-1) === `refs/heads/goal/${candidate.name}`);
      return state?.advertised ? `${'a'.repeat(40)}\trefs/heads/goal/${state.name}\n` : null;
    }
    const state = m.planGoalStates.get(at);
    if (state && args[0] === 'rev-parse' && args.includes('--abbrev-ref')) return state.branch;
    if (state && args[0] === 'rev-parse' && args.includes('HEAD')) return state.head;
    if (state && args[0] === 'rev-parse' && args.includes('--git-common-dir')) return owner;
    if (state && args[0] === 'status') return args.includes('--ignored=matching') ? state.ignored : state.dirty;
    if (state && args[0] === 'rev-list') {
      // Ahead of origin/main by `own`; on origin/goal/<name> by `pushed` (null: no such remote branch).
      if (args.includes('origin/main..HEAD')) return state.own;
      if (args.includes(`origin/goal/${state.name}..HEAD`)) return state.pushed;
      return null;
    }
    return prior(at, args);
  };
  return {
    dir, path, owner, metadata: json,
    doors: (over = {}) => m.doors({ repos: [{ name: 'memoro', path: owner }], git, openIn: (candidate) => m.planGoalStates.get(candidate)?.open || [], goalWorktreeLock: (fn) => fn(), ...over }),
  };
}

function ageTree(directory, at) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) if (entry.isDirectory()) ageTree(join(directory, entry.name), at);
  utimesSync(directory, new Date(at), new Date(at));
}

/** Every file and directory under `directory`, and `directory` itself, last touched at `at`. */
function ageEverything(directory, at) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) ageEverything(path, at);
    else utimesSync(path, new Date(at), new Date(at));
  }
  utimesSync(directory, new Date(at), new Date(at));
}

describe('(P) automatic plan goal worktree release', () => {
  it('selects a clean old plan checkout unattended and receipts its identity without changing goal documents or branch policy', () => {
    const m = machine();
    try {
      const f = planGoalTree(m);
      const docs = [readFileSync(join(f.dir, 'GOAL.json')), readFileSync(join(f.dir, 'LOG.md'))];
      const preview = runTidy(f.doors());
      const target = preview.list.targets.find((item) => item.kind === 'plan-goal-worktree');
      assert.deepEqual(preview.list.targets.filter((item) => item.kind === 'plan-goal-worktree').map((item) => item.path), [f.path], JSON.stringify(preview.list.kept.filter((item) => item.path.includes('/goals/'))));
      assert.equal(preview.list.person, false);
      assert.deepEqual([target.stage, target.status, target.branch, target.head, target.owner], ['draft', 'ready', 'goal/draft', 'a'.repeat(40), f.owner]);
      assert.equal(target.metadata, f.metadata);
      assert.ok(target.identity && target.activity < NOW - 72 * HOUR);
      const applied = applyTidy({ listPath: preview.listPath, ...f.doors() });
      assert.deepEqual(applied.applied.map((item) => [item.path, item.ok]), [[f.path, true]], JSON.stringify(applied.applied));
      assert.equal(existsSync(f.path), false);
      assert.deepEqual([readFileSync(join(f.dir, 'GOAL.json')), readFileSync(join(f.dir, 'LOG.md'))], docs);
      assert.equal(m.released.includes(f.path), true, 'removal uses the checkout-only worktree door');
    } finally { m.cleanup(); }
  });

  it('limits lock-held discovery to the selected goal and rechecks changes made at lock acquisition', () => {
    const m = machine();
    try {
      const first = planGoalTree(m, { name: 'first' });
      const second = planGoalTree(m, { name: 'second' });
      let locked = null;
      const locks = [];
      const unrelated = [];
      const base = first.doors();
      const doors = first.doors({
        git: (at, args) => {
          if (locked && at !== first.owner && at !== locked) { unrelated.push(['git', at]); throw new Error('unrelated Git inventory under runner lock'); }
          return base.git(at, args);
        },
        openIn: (at) => {
          if (locked && at !== locked && at !== dirname(locked)) { unrelated.push(['open', at]); throw new Error('unrelated open-file inventory under runner lock'); }
          return [];
        },
        filesOpen: () => { assert.equal(locked, null, 'generated-file inventory stays outside runner lock'); return new Map(); },
        goalWorktreeLock: (fn) => {
          locked = [first.path, second.path][locks.length];
          locks.push(locked);
          try { return fn(); } finally { locked = null; }
        },
        removeWorktree: (owner, path) => {
          assert.equal(locked, path, 'removal must share the candidate recheck lease');
          return base.removeWorktree(owner, path);
        },
      });
      const preview = runTidy(doors);
      assert.deepEqual(preview.list.targets.map((item) => item.path), [first.path, second.path]);
      const applied = applyTidy({ listPath: preview.listPath, ...doors });
      assert.deepEqual(applied.applied.map((item) => [item.path, item.ok]), [[first.path, true], [second.path, true]], JSON.stringify(applied.applied));
      assert.deepEqual(locks, [first.path, second.path]);
      assert.deepEqual(unrelated, [], 'unrelated inventory must not hold up allocation/admission');

      const race = planGoalTree(m, { name: 'race' });
      const state = m.planGoalStates.get(race.path);
      const previewRace = runTidy(race.doors());
      for (const change of ['head', 'stage', 'dirty', 'ignored', 'own', 'cwd', 'open']) {
        const result = applyTidy({ listPath: previewRace.listPath, ...race.doors({
          goalWorktreeLock: (fn) => {
            if (change === 'stage') m.write(join(race.dir, 'GOAL.json'), goalJson({ stage: 'build', repos: ['memoro'] }), OLD);
            else if (change === 'cwd') m.cwds.push({ pid: 90, cwd: race.dir });
            else state[change] = { head: 'b'.repeat(40), dirty: '?? note', ignored: '!! local.db', own: '1', open: [44] }[change];
            return fn();
          },
        }) });
        assert.deepEqual(result.applied.map((item) => [item.path, item.ok]), [[race.path, false]], change);
        assert.equal(existsSync(race.path), true, change);
        Object.assign(state, { head: 'a'.repeat(40), dirty: '', ignored: '', own: '0', open: [] });
        m.cwds = [{ pid: 1, cwd: '/' }];
        m.write(join(race.dir, 'GOAL.json'), race.metadata, OLD);
        ageTree(race.dir, OLD);
      }
    } finally { m.cleanup(); }
  });

  it('keeps a candidate at the 72-hour boundary in ordinary tidy, retains recent ones, and allows younger safe trees only in pressure', () => {
    const m = machine();
    try {
      const recent = planGoalTree(m, { name: 'recent', recent: true });
      const atBoundary = planGoalTree(m, { name: 'boundary' });
      // Bring the newest activity on the boundary goal exactly to the cutoff.
      utimesSync(join(atBoundary.dir, 'GOAL.json'), new Date(NOW - 72 * HOUR), new Date(NOW - 72 * HOUR));
      utimesSync(join(atBoundary.dir, 'LOG.md'), new Date(NOW - 72 * HOUR), new Date(NOW - 72 * HOUR));
      const regular = runTidy(recent.doors());
      assert.deepEqual(regular.list.targets.filter((item) => item.kind === 'plan-goal-worktree').map((item) => item.path), []);
      assert.equal(keptOf(regular.list, recent.path).why, 'goal/worktree touched within the last 72 hours');
      assert.equal(keptOf(regular.list, atBoundary.path).why, 'goal/worktree touched within the last 72 hours', 'exactly 72 hours is retained');
      const pressured = runTidy({ ...recent.doors(), pressure: true });
      assert.deepEqual(pressured.list.targets.filter((item) => item.kind === 'plan-goal-worktree').map((item) => item.path).sort(), [recent.path, atBoundary.path].sort());
      assert.match(pressured.list.targets.find((item) => item.path === recent.path).why, /pressure pass; age exception/u);
      const withoutPressureAuthority = applyTidy({ listPath: pressured.listPath, ...recent.doors() });
      assert.equal(withoutPressureAuthority.applied[0].ok, false, 'a pressure preview alone cannot authorize a younger apply');
      assert.equal(existsSync(recent.path), true);
      const pressureApply = runTidy({ ...recent.doors(), pressure: true, apply: true });
      assert.deepEqual(pressureApply.outcome.applied.filter((item) => item.ok).map((item) => item.path).sort(), [recent.path, atBoundary.path].sort());
    } finally { m.cleanup(); }
  });

  it('keeps invalid/missing metadata, non-plan stage, dirty, untracked, ignored, ahead, active and uncertain candidates', () => {
    const m = machine();
    try {
      const cases = [
        planGoalTree(m, { name: 'wrong-stage', stage: 'build' }),
        planGoalTree(m, { name: 'wrong-branch' }),
        planGoalTree(m, { name: 'dirty', dirty: ' M source.js\n' }),
        planGoalTree(m, { name: 'untracked', dirty: '?? note.txt\n' }),
        planGoalTree(m, { name: 'ignored', ignored: '!! local.db\n' }),
        planGoalTree(m, { name: 'ahead', own: '1' }),
        planGoalTree(m, { name: 'active', cwd: join(m.work, 'programs', 'mc', 'goals', 'active') }),
        planGoalTree(m, { name: 'open', open: [44] }),
        planGoalTree(m, { name: 'uncertain-owner', registration: false }),
      ];
      const invalid = planGoalTree(m, { name: 'invalid', metadata: '{not json' });
      const missing = planGoalTree(m, { name: 'missing' });
      unlinkSync(join(missing.dir, 'GOAL.json'));
      m.planGoalStates.get(cases[1].path).branch = 'main';
      const facts = runTidy(cases[0].doors()).list;
      assert.deepEqual(facts.targets.filter((item) => item.kind === 'plan-goal-worktree').map((item) => item.path), []);
      for (const item of [...cases, invalid, missing]) assert.ok(keptOf(facts, item.path) || facts.kept.some((entry) => entry.path === item.dir), item.path);
      for (const [item, reason] of [
        [cases[0], /stage is build/u], [cases[2], /tracked or untracked changes/u], [cases[3], /tracked or untracked changes/u],
        [cases[4], /ignored files/u], [cases[5], /commits beyond origin\/main/u], [cases[6], /live session cwd/u],
        [cases[7], /holds a goal\/worktree file open/u], [cases[8], /registered worktree/u],
      ]) assert.match(keptOf(facts, item.path).why, reason, item.path);
      const wrongBranch = runTidy(cases[1].doors()).list;
      assert.match(keptOf(wrongBranch, cases[1].path).why, /branch is main/u);
      assert.match(facts.kept.find((entry) => entry.path === invalid.dir).why, /metadata invalid/u);
      assert.match(facts.kept.find((entry) => entry.path === missing.dir).why, /metadata unreadable/u);

      const safe = planGoalTree(m, { name: 'safe' });
      const uncertain = runTidy(safe.doors({ cwds: () => { throw new Error('lsof unavailable'); } })).list;
      assert.deepEqual(uncertain.targets.filter((item) => item.kind === 'plan-goal-worktree').map((item) => item.path), []);
      assert.match(keptOf(uncertain, safe.path).why, /could not establish live session cwd evidence/u);
      const openUnknown = runTidy(safe.doors({ openIn: () => null })).list;
      assert.match(keptOf(openUnknown, safe.path).why, /open-file evidence is uncertain/u);
    } finally { m.cleanup(); }
  });

  it('does not count the attached dependency link as ignored files, and still keeps any other ignored entry', () => {
    const m = machine();
    try {
      const attached = planGoalTree(m, { name: 'attached', ignored: '!! node_modules/\n' });
      m.write(join(attached.path, 'node_modules', '.memoro-deps.json'), '{}\n', OLD);
      ageTree(attached.dir, OLD);
      const unmarked = planGoalTree(m, { name: 'unmarked', ignored: '!! node_modules/\n' });
      const mixed = planGoalTree(m, { name: 'mixed', ignored: '!! node_modules/\n!! .mc/local.json\n' });
      m.write(join(mixed.path, 'node_modules', '.memoro-deps.json'), '{}\n', OLD);
      ageTree(mixed.dir, OLD);
      const facts = runTidy(attached.doors()).list;
      assert.deepEqual(facts.targets.filter((item) => item.kind === 'plan-goal-worktree').map((item) => item.path), [attached.path]);
      assert.match(keptOf(facts, unmarked.path).why, /ignored files \(node_modules\/\)/u);
      assert.match(keptOf(facts, mixed.path).why, /ignored files \(\.mc\/local\.json\)/u);
    } finally { m.cleanup(); }
  });

  it('a checkout whose commits beyond origin/main are all on its pushed branch is released after one fetch of its owning repository; unpushed commits keep it', () => {
    const m = machine();
    try {
      const pushed = planGoalTree(m, { name: 'pushed', own: '2', pushed: '0' });
      const unpushed = planGoalTree(m, { name: 'unpushed', own: '2', pushed: '1' });
      const preview = runTidy(pushed.doors());
      assert.deepEqual(paths(ruled(preview.list, 'P')), [pushed.path], JSON.stringify(preview.list.kept.filter((item) => item.path.includes('/goals/'))));
      assert.match(preview.list.targets.find((item) => item.path === pushed.path).why, /2 commits, all on origin\/goal\//u);
      assert.match(keptOf(preview.list, unpushed.path).why, /commits beyond origin\/main \(2\) that are not on origin\/goal\//u);
      assert.deepEqual(m.fetches, [[pushed.owner, 'fetch', '-q', 'origin']], 'one fetch, at the owning repository and in no checkout');
      const applied = applyTidy({ listPath: preview.listPath, ...pushed.doors() });
      assert.deepEqual(applied.applied.map((item) => [item.path, item.ok]), [[pushed.path, true]], JSON.stringify(applied.applied));
      assert.deepEqual(m.released, [pushed.path], 'the pushed checkout leaves through the worktree door');
      assert.equal(existsSync(unpushed.path), true);
    } finally { m.cleanup(); }
  });

  it('a fetch that fails keeps an ahead checkout and says so, and a checkout with nothing beyond origin/main needs no fetch', () => {
    const m = machine();
    try {
      const ahead = planGoalTree(m, { name: 'ahead', own: '1', pushed: '0' });
      m.fetchFails = true;
      const failed = runTidy(ahead.doors()).list;
      assert.deepEqual(ruled(failed, 'P'), []);
      assert.match(keptOf(failed, ahead.path).why, /commits beyond origin\/main \(1\) and the fetch of origin failed/u, 'a remote branch that says 0 is no evidence once the fetch failed');
      assert.equal(m.fetches.length, 1);
    } finally { m.cleanup(); }
    const quiet = machine();
    try {
      const level = planGoalTree(quiet, { name: 'level', own: '0' });
      assert.deepEqual(paths(ruled(runTidy(level.doors()).list, 'P')), [level.path]);
      assert.deepEqual(quiet.fetches, [], 'nothing beyond origin/main, so no fetch');
    } finally { quiet.cleanup(); }
  });

  it('a stale tracking ref does not prove that the pushed branch still exists on origin', () => {
    const m = machine();
    try {
      const stale = planGoalTree(m, { name: 'stale', own: '1', pushed: '0', advertised: false });
      const facts = runTidy(stale.doors()).list;
      assert.deepEqual(ruled(facts, 'P'), []);
      assert.match(keptOf(facts, stale.path).why, /commits beyond origin\/main \(1\) that are not on origin\/goal\/stale/u);
      assert.deepEqual(m.fetches, [[stale.owner, 'fetch', '-q', 'origin']]);
    } finally { m.cleanup(); }
  });

  it('rebuildable ignored residue does not keep a checkout, and any other ignored entry still does', () => {
    const m = machine();
    try {
      const residue = planGoalTree(m, { name: 'residue', ignored: ['!! .venv-fonts/', '!! .wrangler/', '!! node_modules/', '!! public/dist/', '!! scripts/dev/local-schema.sql', '!! scripts/x/__pycache__/', '!! __pycache__/'].join('\n') + '\n' });
      m.write(join(residue.path, 'node_modules', '.memoro-deps.json'), '{}\n', OLD);
      ageTree(residue.dir, OLD);
      const local = planGoalTree(m, { name: 'local', ignored: '!! .wrangler/\n!! .mc/local.json\n' });
      const venv = planGoalTree(m, { name: 'venv', ignored: '!! scripts/admin/_venv/\n' });
      const facts = runTidy(residue.doors()).list;
      assert.deepEqual(paths(ruled(facts, 'P')), [residue.path], JSON.stringify(facts.kept.filter((item) => item.path.includes('/goals/'))));
      assert.match(keptOf(facts, local.path).why, /ignored files \(\.mc\/local\.json\)$/u);
      assert.doesNotMatch(keptOf(facts, local.path).why, /wrangler/u, 'the residue entry is not named');
      assert.match(keptOf(facts, venv.path).why, /ignored files \(scripts\/admin\/_venv\/\)$/u);
    } finally { m.cleanup(); }
  });

  it('rechecks metadata, stage, HEAD, identity and activity after preview, and suppresses a nested cache target', () => {
    const m = machine();
    try {
      const f = planGoalTree(m);
      const preview = runTidy(f.doors());
      const state = m.planGoalStates.get(f.path);
      state.head = 'b'.repeat(40);
      const changedHead = applyTidy({ listPath: preview.listPath, ...f.doors() });
      assert.equal(changedHead.applied[0].ok, false);
      assert.match(changedHead.applied[0].why, /HEAD|identity|activity/u);
      state.head = 'a'.repeat(40);
      const changedStage = runTidy(f.doors());
      m.write(join(f.dir, 'GOAL.json'), goalJson({ stage: 'build', status: 'ready', repos: ['memoro'] }), OLD);
      const stageRefused = applyTidy({ listPath: changedStage.listPath, ...f.doors() });
      assert.match(stageRefused.applied[0].why, /stage/u);
      m.write(join(f.dir, 'GOAL.json'), f.metadata, OLD);
      ageTree(f.dir, OLD);
      const changedMetadata = runTidy(f.doors());
      m.write(join(f.dir, 'GOAL.json'), goalJson({ stage: 'draft', status: 'blocked', repos: ['memoro'] }), OLD);
      ageTree(f.dir, OLD);
      assert.match(applyTidy({ listPath: changedMetadata.listPath, ...f.doors() }).applied[0].why, /metadata/u);
      m.write(join(f.dir, 'GOAL.json'), f.metadata, OLD);
      ageTree(f.dir, OLD);
      const changedIdentity = runTidy(f.doors());
      m.write(join(f.path, '.git'), 'gitdir: /fake/admin/worktrees/replaced\n', OLD);
      assert.match(applyTidy({ listPath: changedIdentity.listPath, ...f.doors() }).applied[0].why, /identity/u);
      m.write(join(f.path, '.git'), 'gitdir: /fake/admin/worktrees/draft\n', OLD);
      ageTree(f.dir, OLD);
      const changedActivity = runTidy(f.doors());
      utimesSync(join(f.dir, 'LOG.md'), new Date(NOW - HOUR), new Date(NOW - HOUR));
      assert.match(applyTidy({ listPath: changedActivity.listPath, ...f.doors() }).applied[0].why, /72 hours|activity/u);
      assert.deepEqual(m.released, []);
      assert.equal(existsSync(f.path), true);

      // A cache fact beneath a selected checkout contributes no duplicate removal or estimate.
      const second = planGoalTree(m, { name: 'nested' });
      const nestedFacts = gatherTidyFacts(second.doors());
      nestedFacts.cache_items = [{ path: join(second.path, 'DerivedData'), kind: 'spm-cache', active: false, open: [], newest_ms: OLD, bytes: 9, identity: 'nested' }];
      const plan = tidyPlan(nestedFacts);
      assert.deepEqual(plan.targets.filter((item) => item.path.startsWith(second.path)).map((item) => item.path), [second.path]);
    } finally { m.cleanup(); }
  });
});

describe('(P) goal checkouts that cannot start a session now: Martin, a later phase, a blocked goal kept', () => {
  it('releases a clean, old checkout of a goal waiting on Martin or in a later phase; keeps a current-phase goal, a blocked one, and a review that can run', () => {
    const m = machine();
    try {
      goal(m, 'lowest', 'build');
      const martin = planGoalTree(m, { name: 'martin', metadata: goalJson({ stage: 'build', status: 'Martin', repos: ['memoro'] }) });
      const later = planGoalTree(m, { name: 'later', metadata: goalJson({ stage: 'build', status: 'ready', phase: 2, repos: ['memoro'] }) });
      const current = planGoalTree(m, { name: 'current', metadata: goalJson({ stage: 'build', status: 'ready', repos: ['memoro'] }) });
      const blocked = planGoalTree(m, { name: 'blocked', metadata: goalJson({ stage: 'build', status: 'blocked', phase: 2, repos: ['memoro'] }) });
      const review = planGoalTree(m, { name: 'review', metadata: goalJson({ stage: 'review', status: 'ready', repos: ['memoro'] }) });
      const { list } = runTidy(martin.doors());
      assert.deepEqual(paths(ruled(list, 'P')).sort(), [martin.path, later.path].sort());
      assert.equal(list.targets.find((item) => item.path === martin.path).why, 'clean inactive goal checkout, status Martin, which waits on a person, untouched for 72 hours');
      assert.equal(list.targets.find((item) => item.path === later.path).why, 'clean inactive goal checkout, phase 2 is above the programme\'s lowest unfinished phase 1, untouched for 72 hours');
      assert.equal(keptOf(list, current.path).why, 'goal stage is build, not draft, and a session can start it');
      assert.equal(keptOf(list, blocked.path).why, 'goal is blocked: its checkout stays while its obstacle awaits an owner');
      assert.equal(keptOf(list, review.path).why, 'goal stage is review, not draft, and a session can start it');
    } finally { m.cleanup(); }
  });

  it('a later-phase goal waits for the phases below it: once the lower goal is done, its checkout is kept as a session can start', () => {
    const m = machine();
    try {
      goal(m, 'lowest', 'done');
      const later = planGoalTree(m, { name: 'later', metadata: goalJson({ stage: 'build', status: 'ready', phase: 2, repos: ['memoro'] }) });
      const { list } = runTidy(later.doors());
      assert.deepEqual(ruled(list, 'P'), [], 'phase 2 is the lowest unfinished now');
      assert.equal(keptOf(list, later.path).why, 'goal stage is build, not draft, and a session can start it');
    } finally { m.cleanup(); }
  });

  it('a real checkout of a later-phase goal is released by git worktree remove; its branch re-adds it at the same HEAD', () => {
    const m = machine();
    try {
      layout2(m);
      const run = (cwd, args) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' } });
      const origin = join(m.home, 'origin.git');
      const seed = join(m.home, 'seed');
      const owner = join(m.home, 'repos', 'memoro');
      const path = join(m.work, 'programs', 'mc', 'goals', 'real', 'memoro');
      mkdirSync(seed, { recursive: true });
      run(seed, ['init', '-q', '-b', 'main']);
      writeFileSync(join(seed, 'README.md'), 'a repository\n');
      run(seed, ['add', 'README.md']);
      run(seed, ['commit', '-q', '-m', 'first']);
      run(m.home, ['clone', '-q', '--bare', seed, origin]);
      run(m.home, ['clone', '-q', origin, owner]);
      // The runner's goal checkout: from origin/main, on goal/real, as addGoalWorktree makes it.
      assert.equal(run(owner, ['worktree', 'add', '-q', '-b', 'goal/real', path, 'origin/main']).status, 0);
      const head = run(path, ['rev-parse', 'HEAD']).stdout.trim();
      m.write(join(m.work, 'programs', 'mc', 'goals', 'real', 'GOAL.json'), goalJson({ stage: 'build', status: 'ready', phase: 2, repos: ['memoro'] }), OLD);
      m.write(join(m.work, 'programs', 'mc', 'goals', 'real', 'LOG.md'), '# Goal\n', OLD);
      goal(m, 'lowest', 'build');
      ageEverything(join(m.work, 'programs', 'mc', 'goals', 'real'), OLD);
      const doors = m.doors({
        repos: [{ name: 'memoro', path: owner }],
        git: (cwd, args) => { const r = run(cwd, args); return r.status === 0 ? r.stdout : null; },
        openIn: () => [],
        goalWorktreeLock: (fn) => fn(),
        removeWorktree: (repo, target) => run(repo, ['worktree', 'remove', target]).status === 0,
      });
      const preview = runTidy(doors);
      assert.deepEqual(paths(ruled(preview.list, 'P')), [path], JSON.stringify(preview.list.kept.filter((item) => item.path.includes('/goals/'))));
      const applied = applyTidy({ listPath: preview.listPath, ...doors });
      assert.deepEqual(applied.applied.map((item) => [item.path, item.ok]), [[path, true]], JSON.stringify(applied.applied));
      assert.equal(existsSync(path), false, 'the checkout is gone');
      assert.equal(run(owner, ['show-ref', '--verify', '--quiet', 'refs/heads/goal/real']).status, 0, 'the branch stays');
      const again = addGoalWorktree({
        git: (cwd, args) => { const r = run(cwd, args); return { ok: r.status === 0, stdout: r.stdout, stderr: r.stderr }; },
        bare: owner, path, goal: 'real',
      });
      assert.deepEqual([again.ok, again.existed, again.branch], [true, true, 'goal/real']);
      assert.equal(run(path, ['rev-parse', 'HEAD']).stdout.trim(), head, 'the same HEAD');
      assert.equal(run(path, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim(), 'goal/real');
    } finally { m.cleanup(); }
  });

  it('a modeled checkout with a commit pushed to origin/goal/<goal> is released, and its branch with the commit stays', () => {
    const m = machine();
    try {
      layout2(m);
      const run = (cwd, args) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' } });
      const origin = join(m.home, 'origin.git');
      const seed = join(m.home, 'seed');
      const owner = join(m.home, 'repos', 'memoro');
      const goals = join(m.work, 'programs', 'mc', 'goals');
      mkdirSync(seed, { recursive: true });
      run(seed, ['init', '-q', '-b', 'main']);
      writeFileSync(join(seed, 'README.md'), 'a repository\n');
      run(seed, ['add', 'README.md']);
      run(seed, ['commit', '-q', '-m', 'first']);
      run(m.home, ['clone', '-q', '--bare', seed, origin]);
      run(m.home, ['clone', '-q', origin, owner]);
      goal(m, 'lowest', 'build');
      // A goal checkout from origin/main on goal/<name>, as addGoalWorktree makes it.
      const checkout = (name) => {
        m.write(join(goals, name, 'GOAL.json'), goalJson({ stage: 'build', status: 'ready', phase: 2, repos: ['memoro'] }), OLD);
        m.write(join(goals, name, 'LOG.md'), '# Goal\n', OLD);
        const path = join(goals, name, 'memoro');
        assert.equal(run(owner, ['worktree', 'add', '-q', '-b', `goal/${name}`, path, 'origin/main']).status, 0);
        return path;
      };
      const commit = (path, file) => {
        writeFileSync(join(path, file), `${file}\n`);
        assert.equal(run(path, ['add', file]).status, 0);
        assert.equal(run(path, ['commit', '-q', '-m', file]).status, 0);
        return run(path, ['rev-parse', 'HEAD']).stdout.trim();
      };
      // `real` has its one commit pushed; `unpushed` has one pushed and one that is not.
      const real = checkout('real');
      const pushedHead = commit(real, 'pushed.txt');
      assert.equal(run(real, ['push', '-q', 'origin', 'goal/real']).status, 0);
      const unpushed = checkout('unpushed');
      commit(unpushed, 'first.txt');
      assert.equal(run(unpushed, ['push', '-q', 'origin', 'goal/unpushed']).status, 0);
      commit(unpushed, 'second.txt');
      ageEverything(join(goals, 'real'), OLD);
      ageEverything(join(goals, 'unpushed'), OLD);
      const doors = m.doors({
        repos: [{ name: 'memoro', path: owner }],
        git: (cwd, args) => { const r = run(cwd, args); return r.status === 0 ? r.stdout : null; },
        openIn: () => [],
        goalWorktreeLock: (fn) => fn(),
        removeWorktree: (repo, target) => run(repo, ['worktree', 'remove', target]).status === 0,
      });
      const preview = runTidy(doors);
      assert.deepEqual(paths(ruled(preview.list, 'P')), [real], JSON.stringify(preview.list.kept.filter((item) => item.path.includes('/goals/'))));
      assert.match(preview.list.targets.find((item) => item.path === real).why, /1 commit, all on origin\/goal\/real/u);
      assert.match(keptOf(preview.list, unpushed).why, /commits beyond origin\/main \(2\) that are not on origin\/goal\/unpushed/u);
      const applied = applyTidy({ listPath: preview.listPath, ...doors });
      assert.deepEqual(applied.applied.map((item) => [item.path, item.ok]), [[real, true]], JSON.stringify(applied.applied));
      assert.equal(existsSync(real), false, 'the checkout is gone');
      const ref = run(owner, ['show-ref', '--verify', 'refs/heads/goal/real']);
      assert.equal(ref.status, 0, 'the branch stays');
      assert.ok(ref.stdout.startsWith(pushedHead), 'and still names the pushed commit');
      const again = addGoalWorktree({
        git: (cwd, args) => { const r = run(cwd, args); return { ok: r.status === 0, stdout: r.stdout, stderr: r.stderr }; },
        bare: owner, path: real, goal: 'real',
      });
      assert.deepEqual([again.ok, again.existed, again.branch], [true, true, 'goal/real']);
      assert.equal(run(real, ['rev-parse', 'HEAD']).stdout.trim(), pushedHead, 'the same HEAD');
    } finally { m.cleanup(); }
  });
});

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

  it('X walks programs/: the goals directory is skipped, a merged worktree goes through the root check', () => {
    const m = machine();
    try {
      layout2(m);
      const area = join(m.work, 'programs', 'mc');
      for (const name of ['memoro', 'memoro-cli', 'wt-a']) m.write(join(area, name, '.git'), 'gitdir: /fake');
      goal(m, 'layout', 'build');
      const { list, outcome } = runTidy({ ...m.doors(), apply: true });
      assert.deepEqual(list.targets.map((item) => [item.path, item.kind, item.rule]), [[join(area, 'wt-a'), 'plan-worktree', 'X']]);
      assert.equal(keptOf(list, join(area, 'memoro')).rule, 'plan-checkout');
      assert.ok(![...list.targets, ...list.kept].some((item) => item.path.startsWith(join(area, 'goals'))), 'the goals directory is not a worktree');
      assert.deepEqual(outcome.applied.map((item) => [item.path, item.ok]), [[join(area, 'wt-a'), true]]);
      assert.ok(existsSync(join(area, 'goals', 'layout', 'GOAL.json')));
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
      const area = planArea(m);
      const { list, listPath, outcome } = runTidy(m.doors());
      assert.equal(outcome, null);
      assert.equal(listPath, join(m.work, 'runner', 'tidy', '20261012T120000Z.json'));
      const written = JSON.parse(readFileSync(listPath, 'utf8'));
      assert.deepEqual(written, list);
      assert.equal(written.rules_version, 12, 'rules version 12: the scratch-export kind under rule S');
      assert.equal(written.person, false, 'the list says whose run it was');
      assert.equal(written.pressure, false);
      for (const item of written.targets) assert.deepEqual(Object.keys(item).sort(), ['bytes', 'kind', 'path', 'rule', 'why']);
      for (const item of written.kept) assert.deepEqual(Object.keys(item).sort(), ['path', 'rule', 'why']);
      assert.ok(written.targets.length > 0, 'it has a target to list');
      assert.ok(existsSync(join(area, 'wt-a')), 'a dry run removes nothing');
      assert.equal(runTidy(m.doors()).listPath, join(m.work, 'runner', 'tidy', '20261012T120000Z-2.json'));
    } finally { m.cleanup(); }
  });

  it('the list is written before the first removal, and applied is appended to it', () => {
    const m = machine();
    try {
      // Two transcripts whose directory is gone (T3), each with its <uuid>/ beside it.
      const mine = [1, 2].flatMap((n) => {
        const file = join(m.projects, '-gone', `${ID(n)}.jsonl`);
        m.write(file, m.head(join(m.home, 'gone')));
        m.write(join(m.projects, '-gone', ID(n), 'tool.txt'));
        return [file, join(m.projects, '-gone', ID(n))];
      });
      const order = [];
      const write = (path, value) => { order.push(['write', value.applied ? 'applied' : 'list']); mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, JSON.stringify(value)); };
      const remove = (path) => { order.push(['remove', path]); rmSync(path, { recursive: true }); };
      const { listPath, outcome } = runTidy({ ...m.doors(), apply: true, write, remove });
      assert.deepEqual(order[0], ['write', 'list']);
      assert.deepEqual(order.at(-1), ['write', 'applied']);
      assert.ok(order.slice(1, -1).every(([what]) => what === 'remove'));
      for (const file of mine) assert.equal(existsSync(file), false, file);
      const written = JSON.parse(readFileSync(listPath, 'utf8'));
      assert.equal(written.applied.length, 2);
      assert.ok(written.applied.every((item) => item.ok));
      assert.equal(outcome.removed, 2);
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
      { path: '/w/work/x', rule: 'W', why: 'memoro: 3 uncommitted' },
      { path: '/w/programs/mc/memoro', rule: 'plan-checkout', why: 'its programme has a goal that is not finished' },
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
    assert.match(text, /W {2}\/w\/work\/x — memoro: 3 uncommitted/u, 'a retired workarea kept is said, with why');
    assert.doesNotMatch(text, /programs\/mc\/memoro/u, 'a checkout kept for an open goal is the ordinary case');
    assert.match(text, /list: \/w\/runner\/tidy\/l\.json/u);
  });

  it('--apply says what it freed and what the re-check kept; --json is the list', async () => {
    const outcome = { applied: [{ path: '/w/plan/mc/wt-a', ok: false, why: 're-check: 1 uncommitted' }], freed: 1.2e9, removed: 12, kept: 1 };
    const { out, stdout } = capture();
    assert.equal(await tidyCommand({ apply: true, days: 14 }, { stdout, tidy: () => ({ list, listPath: '/l.json', outcome }), docker: noDocker }), 1);
    assert.match(out.join(''), /freed 1\.20 GB in 12 items \(estimated from the list\), kept 1 on re-check/u);
    const json = capture();
    await tidyCommand({ json: true, days: 14 }, { stdout: json.stdout, tidy: () => ({ list, listPath: '/l.json', outcome: null }), docker: noDocker });
    assert.deepEqual(JSON.parse(json.out.join('')), list);
  });

  it('mc tidy shows only current disk state while --json keeps named cleanup and refusal history', async () => {
    const at = { at: '2026-10-12T11:00:00.000Z', trigger: 'monitor', measured_delta_bytes: 3e9, estimate_bytes: 11e9, failed: true };
    const refusal = { at: '2026-10-12T10:00:00.000Z', available_bytes: 25.3e9, reason: 'below 30 GB' };
    const cases = [
      [45e9, null, ['disk: 45.0 GB free (measured) — healthy; cleanup below 30.0 GB, reserve 20.0 GB']],
      [39.5e9, { status: 'healthy', shortfall_bytes: 0.5e9, last_cleanup: { ...at, outcome: 'shortfall' }, last_refusal: refusal }, [
        'disk: 39.5 GB free (measured) — healthy; cleanup below 30.0 GB, reserve 20.0 GB',
      ]],
      [20e9, { status: 'healthy', last_cleanup: { ...at, outcome: 'shortfall' }, last_refusal: refusal }, [
        'disk: 20.0 GB free (measured) — cleanup below 30.0 GB; new work allowed at 20.0 GB',
      ]],
      [17e9, { status: 'pressure', cooldown_until: '2026-10-12T12:05:00.000Z', last_cleanup: { ...at, outcome: 'shortfall' }, last_refusal: refusal }, [
        'disk: 17.0 GB free (measured) — below 20.0 GB: new sessions, deploys and Docker starts wait',
        'disk: next pass after 2026-10-12T12:05Z',
      ]],
      [17e9, { status: 'pressure', cooldown_until: '2026-10-12T11:59:00.000Z', last_cleanup: { ...at, outcome: 'shortfall' }, last_refusal: refusal }, [
        'disk: 17.0 GB free (measured) — below 20.0 GB: new sessions, deploys and Docker starts wait',
      ]],
      [null, { status: 'pressure', last_cleanup: { ...at, outcome: 'shortfall' }, last_refusal: refusal }, [
        'disk: free space could not be measured — new sessions, deploys and Docker starts are refused',
      ]],
    ];
    for (const [free, state, lines] of cases) {
      const disk = () => diskSummary({ path: '/w/runner/scratch', stateDir: '/w/runner', read: () => JSON.stringify(state), freeBytes: () => free, nowMs: NOW });
      const { out, stdout } = capture();
      await tidyCommand({ apply: false, days: 14 }, { stdout, tidy: () => ({ list, listPath: '/l.json', outcome: null }), docker: noDocker, disk });
      const said = out.join('').split('\n').filter((line) => line.startsWith('disk:'));
      assert.deepEqual(said, lines);
      const json = capture();
      await tidyCommand({ json: true, days: 14 }, { stdout: json.stdout, tidy: () => ({ list, listPath: '/l.json', outcome: null }), docker: noDocker, disk });
      const parsed = JSON.parse(json.out.join(''));
      assert.deepEqual([parsed.disk.available_bytes, parsed.disk.status, parsed.disk.last_cleanup?.measured_delta_bytes ?? null, parsed.disk.last_cleanup?.estimate_bytes ?? null, parsed.disk.last_cleanup?.failed ?? null, parsed.disk.last_refusal?.available_bytes ?? null],
        [free, free == null ? 'unknown' : free >= 30e9 ? 'healthy' : 'pressure', state?.last_cleanup ? 3e9 : null, state?.last_cleanup ? 11e9 : null, state?.last_cleanup ? true : null, state?.last_refusal?.available_bytes ?? null]);
      assert.deepEqual(parsed.targets, list.targets, 'the list is unchanged beside it');
    }
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

describe('(S) worktrees and DerivedData in ended runner sessions\' scratch directories', () => {
  /**
   * `~/mc/runner/scratch/` with one session directory per case. `git` answers
   * for each worktree by its path: status, HEAD and refs; the owning fake
   * repository records registrations, retained refs and removals.
   */
  function scratchMachine() {
    const m = machine();
    const root = tidyRoots(m.env).scratch;
    const answers = {};
    const opens = {};
    const removed = [];
    const refs = {};
    const refWrites = [];
    const actions = [];
    // The processes that exist, by pid, with their command lines: a runner pid is alive only when it is here.
    const processes = { 4242: 'node /opt/homebrew/bin/mc run', 5151: 'zsh -l' };
    const marker = (over = {}) => JSON.stringify({ schema: 'mc-scratch', version: 1, owner: 'runner', runner_pid: 4242, session: 'goal:mc/x', kind: 'build', stem: 's', started: '2026-10-12T08:00:00Z', ended: '2026-10-12T09:00:00Z', exit: 0, ...over });
    const area = (stem, { record = marker(), worktree = null, derived = false, evidence = true } = {}) => {
      const dir = join(root, stem);
      mkdirSync(dir, { recursive: true });
      if (record !== null) writeFileSync(join(dir, '.mc-scratch.json'), record);
      if (evidence) {
        writeFileSync(join(dir, 'gate.log'), 'red'); writeFileSync(join(dir, 'fault.patch'), 'diff');
        mkdirSync(join(m.work, 'runner', 'log'), { recursive: true });
        writeFileSync(join(m.work, 'runner', 'log', stem + '.json.err'), 'finished stderr');
        writeFileSync(join(m.work, 'runner', 'log', stem + '.jsonl'), 'finished stream');
      }
      if (worktree) {
        m.write(join(dir, 'replay', '.git'), 'gitdir: /fake', NOW);
        m.write(join(dir, 'replay', 'src.js'), 'x', NOW);
        answers[join(dir, 'replay')] = { status: '', refs: 'refs/heads/goal/x\n', head: 'a'.repeat(40), ...worktree };
      }
      if (derived) m.write(join(dir, 'DerivedData', 'Build', 'app.o'), 'o'.repeat(100), NOW);
      return dir;
    };
    const git = (cwd, args) => {
      const answer = answers[cwd];
      if (!answer) {
        if (args[0] === 'worktree' && args[1] === 'list') {
          return Object.entries(answers).filter(([, value]) => value.registered !== false).map(([path, value]) => 'worktree ' + path + '\nHEAD ' + value.head + '\n').join('\n');
        }
        if (args[0] === 'rev-parse' && args.includes('--verify')) return refs[cwd + ':' + args.at(-1)] ? refs[cwd + ':' + args.at(-1)] + '\n' : null;
        if (args[0] === 'update-ref') {
          const key = cwd + ':' + args[1];
          if (args[3] !== '0'.repeat(args[2].length) || refs[key]) return null;
          refs[key] = args[2]; refWrites.push([cwd, args[1], args[2], args[3]]); actions.push(['retain', cwd, args[1]]); return '';
        }
        return m.git(cwd, args);
      }
      if (args[0] === 'status') return answer.gitStatusFails ? null : answer.status;
      if (args[0] === 'rev-parse' && args.includes('--verify')) return answer.head + '\n';
      if (args[0] === 'for-each-ref') return answer.refs;
      if (args[0] === 'rev-parse' && args.includes('--git-common-dir')) return `${join(m.home, 'repos', 'memoro')}/.git\n`;
      return null;
    };
    const doors = (over = {}) => m.doors({
      git, openIn: (path) => (path in opens ? opens[path] : []),
      removeWorktree: (owner, path) => { removed.push([owner, path]); actions.push(['remove', owner, path]); rmSync(path, { recursive: true }); return true; },
      alive: (pid) => pid in processes,
      commandLine: (pid) => { if (!(pid in processes)) throw new Error(`no process ${pid}`); return processes[pid]; },
      ...over,
    });
    return { m, root, area, marker, answers, opens, removed, refs, refWrites, actions, doors, processes };
  }
  const exists = (path) => existsSync(path);

  it('an ended session\'s clean referenced worktree and DerivedData go; its logs, patch and record stay; every uncertain case stays with its reason', () => {
    const s = scratchMachine();
    try {
      const ended = s.area('ended', { worktree: {}, derived: true });
      const live = s.area('live', { derived: true });
      s.m.cwds = [{ pid: 1, cwd: '/' }, { pid: 50, cwd: join(live, 'sub') }];
      const running = s.area('running', { record: s.marker({ ended: undefined }), derived: true });
      const legacy = s.area('legacy', { record: null, derived: true, worktree: {} });
      mkdirSync(join(legacy, 'memory'), { recursive: true });
      writeFileSync(join(legacy, 'memory', 'MEMORY.md'), 'private note');
      writeFileSync(join(legacy, 'other-evidence.txt'), 'keep');
      const noReceipt = s.area('no-receipt', { record: null, worktree: {}, evidence: false });
      const unreadable = s.area('unreadable', { record: '{', derived: true });
      const foreign = s.area('foreign', { record: s.marker({ owner: 'person' }), derived: true });
      const dirty = s.area('dirty', { worktree: { status: ' M src.js\n' } });
      const orphan = s.area('orphan', { worktree: { refs: '' } });
      const open = s.area('open', { derived: true });
      s.opens[join(open, 'DerivedData')] = [77];
      const unknownOpen = s.area('unknown-open', { derived: true });
      s.opens[join(unknownOpen, 'DerivedData')] = null;

      const { list, outcome } = runTidy({ apply: true, ...s.doors() });
      assert.equal(list.person, false, 'ordinary unattended tidy selects rule S without person authority');
      assert.deepEqual(ruled(list, 'S').map((item) => [item.path, item.kind]).sort(), [
        [join(ended, 'DerivedData'), 'scratch-derived'], [join(ended, 'replay'), 'scratch-worktree'],
        [join(legacy, 'replay'), 'scratch-worktree'], [join(orphan, 'replay'), 'scratch-worktree'],
      ]);
      assert.equal(outcome.removed, 4);
      assert.deepEqual(s.removed, [
        [join(s.m.home, 'repos', 'memoro'), join(ended, 'replay')],
        [join(s.m.home, 'repos', 'memoro'), join(legacy, 'replay')],
        [join(s.m.home, 'repos', 'memoro'), join(orphan, 'replay')],
      ], 'every replay is removed through git in its actual owning repository');
      assert.ok(!exists(join(ended, 'replay')) && !exists(join(ended, 'DerivedData')));
      assert.ok(!exists(join(legacy, 'replay')) && exists(join(legacy, 'DerivedData')));
      const owner = join(s.m.home, 'repos', 'memoro');
      assert.deepEqual(s.refWrites, [[owner, 'refs/mc/retained-replay/' + 'a'.repeat(40), 'a'.repeat(40), '0'.repeat(40)]]);
      assert.ok(s.actions.findIndex((action) => action[0] === 'retain') < s.actions.findIndex((action) => action[2] === join(orphan, 'replay')), 'retention precedes detached worktree removal');
      for (const kept of ['gate.log', 'fault.patch', '.mc-scratch.json']) assert.ok(exists(join(ended, kept)), `${kept} stays`);
      for (const kept of ['gate.log', 'fault.patch']) assert.ok(exists(join(legacy, kept)), `legacy ${kept} stays`);
      for (const receipt of ['legacy.json.err', 'legacy.jsonl']) assert.ok(exists(join(s.m.work, 'runner', 'log', receipt)), `${receipt} stays`);
      for (const kept of ['memory/MEMORY.md', 'other-evidence.txt']) assert.ok(exists(join(legacy, kept)), `${kept} stays`);
      for (const receipt of ['ended.json.err', 'ended.jsonl']) assert.ok(exists(join(s.m.work, 'runner', 'log', receipt)), `${receipt} stays`);

      const why = (path) => keptOf(list, path)?.why;
      assert.equal(why(join(live, 'DerivedData')), 'process 50 stands in its scratch directory');
      assert.equal(why(join(running, 'DerivedData')), 'goal:mc/x has not recorded an end');
      assert.equal(why(join(legacy, 'DerivedData')), 'marker-less scratch data is not adopted');
      assert.match(why(join(noReceipt, 'replay')), /no-receipt\.json\.err/u);
      assert.match(why(join(unreadable, 'DerivedData')), /^its scratch directory's ownership record cannot be read/u);
      assert.equal(why(join(foreign, 'DerivedData')), 'its scratch directory\'s owner is not clear');
      assert.equal(why(join(dirty, 'replay')), '1 uncommitted change(s)');
      assert.equal(why(join(open, 'DerivedData')), 'process 77 holds a file open in it');
      assert.equal(why(join(unknownOpen, 'DerivedData')), 'error: could not tell whether a file in it is open');
      for (const dir of [live, running, legacy, unreadable, foreign, open, unknownOpen]) assert.ok(exists(join(dir, 'DerivedData')), `${dir} keeps its DerivedData`);
      for (const dir of [dirty, noReceipt]) assert.ok(exists(join(dir, 'replay', 'src.js')), `${dir} keeps its worktree`);
    } finally { s.m.cleanup(); }
  });

  it('a session with no recorded end counts as ended once its runner is gone, and a live runner, a standing process, an open file or an uncommitted change keeps it', () => {
    const s = scratchMachine();
    try {
      const gone = s.area('gone', { record: s.marker({ ended: undefined, runner_pid: 5150 }), worktree: {}, derived: true });
      const reused = s.area('reused', { record: s.marker({ ended: undefined, runner_pid: 5151 }), worktree: {} });
      const standing = s.area('standing', { record: s.marker({ ended: undefined, runner_pid: 5152 }), derived: true });
      s.m.cwds.push({ pid: 50, cwd: join(standing, 'sub') });
      const dirty = s.area('dirty', { record: s.marker({ ended: undefined, runner_pid: 5153 }), worktree: { status: ' M src.js\n' } });
      const open = s.area('open', { record: s.marker({ ended: undefined, runner_pid: 5154 }), derived: true });
      s.opens[join(open, 'DerivedData')] = [77];
      const live = s.area('live', { record: s.marker({ ended: undefined }), derived: true });

      const { list } = runTidy(s.doors());
      assert.deepEqual(ruled(list, 'S').map((item) => item.path).sort(), [join(gone, 'DerivedData'), join(gone, 'replay'), join(reused, 'replay')].sort());
      const targetOf = (path) => ruled(list, 'S').find((item) => item.path === path)?.why;
      assert.equal(targetOf(join(gone, 'DerivedData')), 'rebuildable DerivedData of session goal:mc/x, whose owning runner is gone (runner pid 5150 is not alive)');
      assert.equal(targetOf(join(gone, 'replay')), 'a clean worktree of session goal:mc/x, whose owning runner is gone (runner pid 5150 is not alive), its HEAD on refs/heads/goal/x');
      assert.equal(targetOf(join(reused, 'replay')), 'a clean worktree of session goal:mc/x, whose owning runner is gone (runner pid 5151 now runs zsh, not an mc runner), its HEAD on refs/heads/goal/x');
      assert.equal(keptOf(list, join(live, 'DerivedData'))?.why, 'goal:mc/x has not recorded an end');
      assert.equal(keptOf(list, join(standing, 'DerivedData'))?.why, 'process 50 stands in its scratch directory');
      assert.equal(keptOf(list, join(dirty, 'replay'))?.why, '1 uncommitted change(s)');
      assert.equal(keptOf(list, join(open, 'DerivedData'))?.why, 'process 77 holds a file open in it');
      for (const dir of [gone, reused, standing, dirty, open, live]) assert.ok(exists(dir), `${dir} is not removed by a list`);
    } finally { s.m.cleanup(); }
  });

  it('an lsof that fails, including partial stdout, keeps every one with the error', () => {
    const s = scratchMachine();
    try {
      const ended = s.area('ended', { worktree: {}, derived: true });
      const partial = cwdsOfUser({ run: () => { throw Object.assign(new Error('partial'), { stdout: 'p111\nn/elsewhere\n' }); } });
      assert.deepEqual([...partial], [{ pid: 111, cwd: '/elsewhere' }]);
      const { list } = runTidy({ apply: true, ...s.doors({ cwds: () => partial }) });
      assert.deepEqual(ruled(list, 'S'), []);
      assert.equal(keptOf(list, join(ended, 'DerivedData')).why, 'error: lsof could not say who stands in it');
      assert.ok(exists(join(ended, 'replay', 'src.js')) && exists(join(ended, 'DerivedData')));
    } finally { s.m.cleanup(); }
  });

  it('the apply refuses a target whose owner changed since the list, and one whose path escapes the scratch root through a symlink', () => {
    const s = scratchMachine();
    try {
      const ended = s.area('ended', { derived: true });
      const escaped = s.area('escaped', { record: null, worktree: {} });
      const outside = join(s.m.home, 'elsewhere');
      mkdirSync(outside, { recursive: true });
      writeFileSync(join(outside, '.mc-scratch.json'), s.marker());
      s.m.write(join(outside, 'DerivedData', 'keep.o'), 'o', NOW);
      const externalWorktree = join(outside, 'external-replay');
      symlinkSync(outside, join(s.root, 'escape'));

      const { list, listPath } = runTidy(s.doors());
      assert.deepEqual(ruled(list, 'S').map((item) => item.path).sort(), [join(ended, 'DerivedData'), join(s.root, 'escape', 'DerivedData'), join(escaped, 'replay')]);
      // Replace the listed checkout with a symlink to a real directory outside scratch.
      renameSync(join(escaped, 'replay'), externalWorktree);
      symlinkSync(externalWorktree, join(escaped, 'replay'));
      // Another session takes the directory over between the list and the apply.
      writeFileSync(join(ended, '.mc-scratch.json'), s.marker({ session: 'goal:mc/y', started: '2026-10-12T11:00:00Z' }));
      const { applied } = applyTidy({ listPath, ...s.doors() });
      const outcomeOf = (path) => applied.find((item) => item.path === path);
      assert.deepEqual(outcomeOf(join(ended, 'DerivedData')), { path: join(ended, 'DerivedData'), ok: false, why: 're-check: its scratch directory\'s owner changed since the list' });
      assert.deepEqual(outcomeOf(join(s.root, 'escape', 'DerivedData')).ok, false);
      assert.match(outcomeOf(join(s.root, 'escape', 'DerivedData')).why, /^refused: not under /u);
      assert.equal(outcomeOf(join(escaped, 'replay')).ok, false);
      assert.match(outcomeOf(join(escaped, 'replay')).why, /^refused: not under /u);
      assert.ok(exists(join(ended, 'DerivedData')) && exists(join(outside, 'DerivedData', 'keep.o')));
    } finally { s.m.cleanup(); }
  });

  it('legacy completion needs both exact regular receipts and refuses dirty, active or open sessions', () => {
    const s = scratchMachine();
    try {
      const clean = s.area('clean-legacy', { record: null, worktree: {} });
      const noErr = s.area('no-err', { record: null, worktree: {} });
      unlinkSync(join(s.m.work, 'runner', 'log', 'no-err.json.err'));
      const noStream = s.area('no-stream', { record: null, worktree: {} });
      unlinkSync(join(s.m.work, 'runner', 'log', 'no-stream.jsonl'));
      const invalidReceipt = s.area('invalid-receipt', { record: null, worktree: {} });
      const escapedReceipt = join(s.m.home, 'outside.jsonl');
      s.m.write(escapedReceipt, 'not an in-root receipt');
      unlinkSync(join(s.m.work, 'runner', 'log', 'invalid-receipt.jsonl'));
      symlinkSync(escapedReceipt, join(s.m.work, 'runner', 'log', 'invalid-receipt.jsonl'));
      const noRegistration = s.area('no-registration', { record: null, worktree: { registered: false } });
      const gitFailure = s.area('git-failure', { record: null, worktree: { gitStatusFails: true } });
      const dirty = s.area('dirty-legacy', { record: null, worktree: { status: '?? new.js\n' } });
      const open = s.area('open-legacy', { record: null, worktree: {} });
      s.opens[open] = [91];
      const unknownOpen = s.area('unknown-open-legacy', { record: null, worktree: {} });
      s.opens[unknownOpen] = null;
      const active = s.area('active-legacy', { record: null, worktree: {} });
      s.m.cwds.push({ pid: 92, cwd: join(active, 'replay', 'src') });

      const { list, outcome } = runTidy({ apply: true, ...s.doors() });
      for (const dir of [noErr, noStream, invalidReceipt, noRegistration, gitFailure, dirty, open, unknownOpen, active]) assert.ok(exists(join(dir, 'replay', 'src.js')), `${dir} keeps its worktree`);
      assert.deepEqual(ruled(list, 'S').map((item) => item.path), [join(clean, 'replay')]);
      assert.deepEqual(outcome.applied.map((item) => [item.path, item.ok]), [[join(clean, 'replay'), true]]);
      assert.match(keptOf(list, join(noErr, 'replay')).why, /no-err\.json\.err/u);
      assert.match(keptOf(list, join(noStream, 'replay')).why, /no-stream\.jsonl/u);
      assert.match(keptOf(list, join(invalidReceipt, 'replay')).why, /stream receipt is not a regular file/u);
      assert.match(keptOf(list, join(noRegistration, 'replay')).why, /does not register/u);
      assert.match(keptOf(list, join(gitFailure, 'replay')).why, /git status could not be read/u);
      assert.equal(keptOf(list, join(dirty, 'replay')).why, '1 uncommitted change(s)');
      assert.equal(keptOf(list, join(open, 'replay')).why, 'process 91 holds a file open in its scratch session');
      assert.match(keptOf(list, join(unknownOpen, 'replay')).why, /could not tell whether a file in its scratch session is open/u);
      assert.equal(keptOf(list, join(active, 'replay')).why, 'process 92 stands in its scratch directory');
    } finally { s.m.cleanup(); }
  });

  it('dry-run creates no retention ref; apply refuses a changed HEAD, session identity or receipt', () => {
    const s = scratchMachine();
    try {
      const legacy = s.area('legacy', { record: null, worktree: { refs: '' } });
      const { list, listPath } = runTidy(s.doors());
      assert.deepEqual(ruled(list, 'S').map((item) => item.path), [join(legacy, 'replay')]);
      assert.deepEqual(s.refs, {}, 'dry-run does not create any refs');
      s.answers[join(legacy, 'replay')].head = 'b'.repeat(40);
      const changedHead = applyTidy({ listPath, ...s.doors() });
      assert.equal(changedHead.applied[0].ok, false);
      assert.match(changedHead.applied[0].why, /HEAD/u);
      assert.ok(exists(join(legacy, 'replay', 'src.js')));

      s.answers[join(legacy, 'replay')].head = 'a'.repeat(40);
      const identityPlan = runTidy(s.doors());
      const gitEntry = join(legacy, 'replay', '.git');
      unlinkSync(gitEntry);
      writeFileSync(gitEntry, 'gitdir: /replacement');
      const staleIdentity = applyTidy({ listPath: identityPlan.listPath, ...s.doors() });
      assert.equal(staleIdentity.applied[0].ok, false);
      assert.match(staleIdentity.applied[0].why, /identity/u);
      assert.ok(exists(join(legacy, 'replay', 'src.js')));

      const sessionPlan = runTidy(s.doors());
      const previousSession = legacy + '-old';
      renameSync(legacy, previousSession);
      mkdirSync(legacy);
      renameSync(join(previousSession, 'replay'), join(legacy, 'replay'));
      const replacedSession = applyTidy({ listPath: sessionPlan.listPath, ...s.doors() });
      assert.equal(replacedSession.applied[0].ok, false);
      assert.match(replacedSession.applied[0].why, /identity/u);
      assert.ok(exists(join(legacy, 'replay', 'src.js')), 'the original replay under a replaced session survives');
      assert.ok(exists(join(previousSession, 'gate.log')), 'the previous session evidence survives');
      assert.deepEqual(s.removed, []);
      assert.deepEqual(s.refs, {}, 'a refused session replacement creates no retention refs');

      const refreshed = runTidy(s.doors());
      const receipt = join(s.m.work, 'runner', 'log', 'legacy.json.err');
      unlinkSync(receipt);
      writeFileSync(receipt, 'replacement receipt with different size');
      const stale = applyTidy({ listPath: refreshed.listPath, ...s.doors() });
      assert.equal(stale.applied[0].ok, false);
      assert.match(stale.applied[0].why, /receipt/u);
      assert.ok(exists(join(legacy, 'replay', 'src.js')));
    } finally { s.m.cleanup(); }
  });

  it('a failed retention or non-forced Git removal keeps the replay worktree', () => {
    const s = scratchMachine();
    try {
      const legacy = s.area('legacy', { record: null, worktree: { refs: '' } });
      const plan = runTidy(s.doors());
      const failingGit = (cwd, args) => {
        if (args[0] === 'update-ref') return null;
        return s.doors().git(cwd, args);
      };
      const notRetained = applyTidy({ listPath: plan.listPath, ...s.doors({ git: failingGit }) });
      assert.equal(notRetained.applied[0].ok, false);
      assert.match(notRetained.applied[0].why, /could not be retained/u);
      assert.ok(exists(join(legacy, 'replay', 'src.js')));

      const next = runTidy(s.doors());
      const refused = applyTidy({ listPath: next.listPath, ...s.doors({ removeWorktree: () => false }) });
      assert.deepEqual(refused.applied[0], { path: join(legacy, 'replay'), ok: false, why: 'git worktree remove refused' });
      assert.ok(exists(join(legacy, 'replay', 'src.js')));
    } finally { s.m.cleanup(); }
  });

  it('outsideRoots takes <scratch>/<stem>/<worktree> and <scratch>/<stem>/DerivedData, and nothing shallower or otherwise named', () => {
    const s = scratchMachine();
    try {
      const dir = s.area('ended', { worktree: {}, derived: true });
      const roots = tidyRoots(s.m.env);
      assert.equal(outsideRoots({ kind: 'scratch-worktree', path: join(dir, 'replay') }, roots), null);
      assert.equal(outsideRoots({ kind: 'scratch-derived', path: join(dir, 'DerivedData') }, roots), null);
      assert.match(outsideRoots({ kind: 'scratch-derived', path: join(dir, 'replay') }, roots), /^not the shape a scratch-derived has/u);
      assert.match(outsideRoots({ kind: 'scratch-worktree', path: dir }, roots), /^not the shape a scratch-worktree has/u);
    } finally { s.m.cleanup(); }
  });
});

describe('(F) old Wrangler logs, MC shots and Codex generated images', () => {
  function generated(m) {
    const logs = join(m.home, 'Library', 'Preferences', '.wrangler', 'logs');
    const shots = join(m.env.MC_HOME, 'shots');
    const codex = join(m.env.CODEX_HOME, 'generated_images');
    const oldLog = join(logs, 'old.log');
    const oldShot = join(shots, 'nested', 'old.png');
    const directShot = join(shots, 'direct.png');
    const boundaryShot = join(shots, 'nested', 'boundary.png');
    const oldGroup = join(codex, ID(70));
    const oldImage = join(oldGroup, 'image.webp');
    const recentGroup = join(codex, ID(71));
    const recentImage = join(recentGroup, 'new.jpeg');
    const recentMetadataGroup = join(codex, ID(72));
    const recentMetadataImage = join(recentMetadataGroup, 'old.png');
    const recentMetadata = join(recentMetadataGroup, 'metadata.json');
    for (const [path, at] of [[oldLog, OLD], [oldShot, OLD], [directShot, OLD], [boundaryShot, NOW - 72 * HOUR], [oldImage, OLD], [recentImage, RECENT], [recentMetadataImage, OLD], [recentMetadata, RECENT]]) m.write(path, 'not inspected', at);
    m.write(join(shots, '.browser-profile', 'cookie.png'), 'protected', OLD);
    m.write(join(shots, 'sessions', 'state.png'), 'protected', OLD);
    m.write(join(shots, 'nested', 'not-image.jpg'), 'protected', OLD);
    m.write(join(logs, 'nested', 'not-direct.log'), 'protected', OLD);
    m.write(join(oldGroup, 'metadata.json'), 'protected', OLD);
    m.write(join(recentGroup, 'new.jpeg'), 'not inspected', RECENT);
    utimesSync(oldGroup, new Date(OLD), new Date(OLD));
    utimesSync(recentGroup, new Date(RECENT), new Date(RECENT));
    utimesSync(recentMetadataGroup, new Date(OLD), new Date(OLD));
    return { logs, shots, codex, oldLog, oldShot, directShot, boundaryShot, oldGroup, oldImage, recentGroup, recentImage, recentMetadataImage, recentMetadata };
  }

  it('previews only old approved regular files, preserves the exact cutoff and recent Codex group, and does not mutate', () => {
    const m = machine();
    try {
      const f = generated(m);
      const { list } = runTidy(m.doors({ openIn: () => [] }));
      const selected = list.targets.filter((item) => item.rule === 'F');
      assert.deepEqual(selected.map((item) => item.path).sort(), [f.oldImage, f.oldLog, f.oldShot, f.directShot].sort());
      assert.ok(selected.every((item) => item.bytes > 0 && /older than 72 hours/u.test(item.why)));
      assert.equal(list.person, false, 'unattended passes still preview eligible file candidates');
      for (const path of [f.oldImage, f.oldLog, f.oldShot, f.directShot, f.boundaryShot, f.recentImage, f.recentMetadataImage, join(f.oldGroup, 'metadata.json'), join(f.shots, '.browser-profile', 'cookie.png'), join(f.shots, 'sessions', 'state.png'), join(f.shots, 'nested', 'not-image.jpg'), join(f.logs, 'nested', 'not-direct.log')]) assert.ok(existsSync(path), `${path} remains after preview`);
      assert.match(keptOf(list, f.boundaryShot).why, /last 72 hours/u);
      assert.match(keptOf(list, f.recentImage).why, /session group was touched/u);
      assert.match(keptOf(list, f.recentMetadataImage).why, /session group was touched/u);
    } finally { m.cleanup(); }
  });

  it('apply removes eligible files but refuses files touched, replaced or opened since the preview', () => {
    const m = machine();
    try {
      const f = generated(m);
      const preview = runTidy(m.doors({ openIn: () => [] }));
      assert.deepEqual(preview.list.targets.filter((item) => item.rule === 'F').map((item) => item.path).sort(), [f.oldImage, f.oldLog, f.oldShot, f.directShot].sort());
      utimesSync(f.oldLog, new Date(NOW - HOUR), new Date(NOW - HOUR));
      rmSync(f.oldShot);
      m.write(f.oldShot, 'replacement', OLD);
      const applying = applyTidy({ listPath: preview.listPath, ...m.doors({ openIn: (path) => path === f.oldGroup ? [77] : [] }) });
      const result = new Map(applying.applied.map((item) => [item.path, item]));
      assert.equal(result.get(f.directShot).ok, true);
      assert.equal(existsSync(f.directShot), false, 'the direct screenshot is removed from the written list');
      assert.equal(result.get(f.oldLog).ok, false);
      assert.match(result.get(f.oldLog).why, /touched in the last 72 hours/u);
      assert.equal(result.get(f.oldShot).ok, false);
      assert.match(result.get(f.oldShot).why, /identity changed/u);
      assert.equal(result.get(f.oldImage).ok, false);
      assert.match(result.get(f.oldImage).why, /process 77 holds/u);
      for (const path of [f.oldLog, f.oldShot, f.oldImage]) assert.ok(existsSync(path), `${path} is preserved`);
    } finally { m.cleanup(); }
  });

  it('deletes only regular in-root targets and keeps active or uncertain inventories', () => {
    const m = machine();
    try {
      const f = generated(m);
      const outside = join(m.home, 'outside.png');
      m.write(outside, 'outside', OLD);
      symlinkSync(outside, join(f.shots, 'nested', 'escape.png'));
      const dry = runTidy(m.doors({ openIn: () => [] }));
      assert.deepEqual(dry.list.targets.filter((item) => item.rule === 'F').map((item) => item.path).sort(), [f.oldImage, f.oldLog, f.oldShot, f.directShot].sort());
      const written = JSON.parse(readFileSync(dry.listPath, 'utf8'));
      written.targets.push({ path: join(f.shots, 'nested', 'escape.png'), kind: 'mc-shot', rule: 'F', why: 'injected escaped path', bytes: 1 });
      writeFileSync(dry.listPath, JSON.stringify(written));
      const result = applyTidy({ listPath: dry.listPath, ...m.doors({ openIn: (path) => path === f.logs ? null : [] }) });
      assert.equal(result.applied.find((item) => item.path === f.oldImage).ok, true);
      assert.equal(result.applied.find((item) => item.path === f.oldShot).ok, true);
      assert.equal(result.applied.find((item) => item.path === f.directShot).ok, true);
      assert.equal(result.applied.find((item) => item.path === f.oldLog).ok, false);
      assert.equal(result.applied.find((item) => item.path === join(f.shots, 'nested', 'escape.png')).ok, false);
      assert.ok(existsSync(f.oldLog) && existsSync(outside));
      assert.equal(existsSync(f.oldImage), false);
      assert.equal(existsSync(f.oldShot), false);
      assert.equal(existsSync(f.directShot), false);
      assert.ok(existsSync(f.oldGroup) && existsSync(join(f.oldGroup, 'metadata.json')), 'the Codex group directory and metadata stay');
      assert.match(outsideRoots({ kind: 'mc-shot', path: join(f.shots, 'nested', 'escape.png') }, tidyRoots(m.env)), /symbolic link/u);
    } finally { m.cleanup(); }
  });

  it('keeps an old image when a process cwd is inside its Codex session subtree', () => {
    const m = machine();
    try {
      const f = generated(m);
      m.cwds = [{ pid: 88, cwd: join(f.oldGroup, 'writer') }];
      const { list } = runTidy(m.doors({ openIn: () => [] }));
      assert.equal(list.targets.some((item) => item.path === f.oldImage), false);
      assert.match(keptOf(list, f.oldImage).why, /cwd in the approved subtree/u);
      assert.ok(existsSync(f.oldImage));
    } finally { m.cleanup(); }
  });

  it('skips missing approved roots and reports a generated-root read failure as kept', () => {
    const m = machine();
    try {
      const absent = gatherTidyFacts(m.doors({ openIn: () => [] }));
      assert.deepEqual(absent.generated_files, [], 'missing roots are ordinary and safe');
      const f = generated(m);
      const { list } = runTidy(m.doors({ openIn: () => [], readDir: (path, options) => {
        if (path === f.shots) throw new Error('EACCES');
        return readdirSync(path, options);
      } }));
      assert.equal(list.targets.some((item) => item.kind === 'mc-shot'), false);
      assert.match(keptOf(list, f.shots).why, /error: EACCES/u);
      assert.ok(existsSync(f.oldShot));
    } finally { m.cleanup(); }
  });
});

describe('(B) exact rebuildable caches', () => {
  const nativePaths = [
    'native-phone/derived', 'native-phone/packages/repositories', 'native-phone/packages/artifacts',
    'native-phone/authorization-home/Library/Caches/org.swift.swiftpm', 'native-phone/host/ios/App/App/public',
  ];
  function cacheMachine() {
    const m = machine();
    const dir = join(m.work, 'runner/scratch/ended');
    const marker = { schema: 'mc-scratch', version: 1, owner: 'runner', session: 'goal:phone/probe', stem: 'ended',
      started: new Date(NOW - 2 * HOUR).toISOString(), ended: new Date(NOW - HOUR).toISOString(), exit: 0 };
    m.write(join(dir, '.mc-scratch.json'), JSON.stringify(marker), NOW - HOUR);
    goal(m, 'probe', 'done', { programme: 'phone' });
    const native = nativePaths.map((rel) => join(dir, rel));
    const wt = join(m.work, 'self/memoro');
    m.worktrees.memoro.push(wt);
    const bundle = join(wt, '.wrangler/dev-server/measure/bundle');
    const shared = [
      join(m.home, 'Library/Caches/org.swift.swiftpm'), join(m.env.MC_HOME, 'build/ios-derived'),
      join(m.home, 'Library/Containers/com.apple.CoreDevice.CoreDeviceService/Data/Library/Caches/AppInstallationBinaryDeltas'),
      join(m.home, 'Library/Containers/com.apple.mediaanalysisd/Data/Library/Caches/com.apple.mediaanalysisd/com.apple.e5rt.e5bundlecache'),
    ];
    const targets = [...native, bundle, ...shared];
    for (const path of targets) {
      m.write(join(path, 'nested/output'), 'generated', OLD);
      for (const child of [join(path, 'nested'), path]) utimesSync(child, new Date(OLD), new Date(OLD));
    }
    const protectedPaths = ['build.log', 'fault.patch', 'native-phone/manifest.json', 'native-phone/host/ios/App/App/Probe.swift',
      'native-phone/host/public/source.js', 'native-phone/authorization-home/.netrc'].map((rel) => join(dir, rel));
    for (const path of protectedPaths) m.write(path, 'keep', OLD);
    m.write(join(wt, '.wrangler/dev-server/state/local.sqlite'), 'local data', OLD);
    m.write(join(wt, '.wrangler/dev-server/measure/generated.dev.vars'), 'settings', OLD);
    const doors = (over = {}) => m.doors({ openIn: () => [], servers: () => [], ...over });
    return { m, dir, marker, wt, native, bundle, shared, targets, protectedPaths, doors };
  }

  it('previews and removes only approved caches, retaining source, logs, ownership, credentials and local server data', () => {
    const s = cacheMachine();
    try {
      const preview = runTidy(s.doors());
      assert.deepEqual(ruled(preview.list, 'B').map((x) => x.path).sort(), [...s.targets].sort());
      assert.ok(s.targets.every(existsSync), 'preview does not delete');
      const goals = join(s.m.work, 'programs/phone/goals');
      mkdirSync(join(goals, '.archive')); renameSync(join(goals, 'probe'), join(goals, '.archive/probe'));
      const result = applyTidy({ listPath: preview.listPath, ...s.doors() });
      assert.ok(result.applied.filter((x) => s.targets.includes(x.path)).every((x) => x.ok));
      for (const path of s.targets) assert.equal(existsSync(path), false, path);
      for (const path of [...s.protectedPaths, join(s.dir, '.mc-scratch.json'),
        join(s.wt, '.wrangler/dev-server/state/local.sqlite'), join(s.wt, '.wrangler/dev-server/measure/generated.dev.vars')]) {
        assert.ok(existsSync(path), `${path} stays`);
      }
    } finally { s.m.cleanup(); }
  });

  it('removes a selected parent worktree without separately listing its nested bundle cache', () => {
    const s = cacheMachine();
    try {
      const area = join(tidyRoots(s.m.env).plan, 'idle'); mkdirSync(area, { recursive: true });
      const wt = join(area, 'memoro'); renameSync(s.wt, wt); s.m.worktrees.memoro = [wt];
      s.m.write(join(wt, '.git'), 'gitdir: /fake');
      ageEverything(wt, OLD);
      const bundle = join(wt, '.wrangler/dev-server/measure/bundle');
      const preview = runTidy(s.doors({ person: true }));
      assert.ok(preview.list.targets.some((x) => x.path === wt && x.rule === 'I'), 'the containing checkout is eligible');
      assert.equal(preview.list.targets.some((x) => x.path === bundle), false, 'the parent already accounts for this cache');
      const applied = applyTidy({ listPath: preview.listPath, ...s.doors() });
      assert.ok(applied.applied.every((x) => x.ok), 'removing the parent must not leave a false missing-cache failure');
      assert.equal(existsSync(wt), false);
      assert.equal(applied.kept, 0);
    } finally { s.m.cleanup(); }
  });

  it('retains native compilation evidence while its goal needs review and rechecks reopened goals at removal', () => {
    const s = cacheMachine();
    try {
      goal(s.m, 'probe', 'review', { programme: 'phone' });
      assert.deepEqual(ruled(runTidy(s.doors()).list, 'B').filter((x) => x.kind === 'native-cache'), [], 'an ended build session may still supply the next review');
      goal(s.m, 'probe', 'done', { programme: 'phone' });
      const preview = runTidy(s.doors());
      goal(s.m, 'probe', 'build', { programme: 'phone' });
      const applied = applyTidy({ listPath: preview.listPath, ...s.doors() });
      for (const path of s.native) {
        assert.equal(applied.applied.find((x) => x.path === path).ok, false, path);
        assert.ok(existsSync(path));
      }
    } finally { s.m.cleanup(); }
  });

  it('keeps native outputs without ended ownership, with active/open owners, and when process evidence is incomplete', () => {
    const s = cacheMachine();
    try {
      const cases = ['running', 'missing', 'malformed', 'foreign', 'version', 'future', 'active', 'open', 'uncertain', 'goal-missing', 'goal-invalid'];
      const paths = new Map();
      for (const name of cases) {
        const dir = join(s.m.work, 'runner/scratch', name);
        const path = join(dir, nativePaths[0]); paths.set(name, path);
        s.m.write(join(path, 'app.o'));
        const marker = { ...s.marker, stem: name };
        if (name === 'running') delete marker.ended;
        if (name === 'foreign') marker.owner = 'someone-else';
        if (name === 'version') marker.version = 2;
        if (name === 'future') marker.ended = new Date(NOW + HOUR).toISOString();
        if (name.startsWith('goal-')) marker.session = 'goal:phone/' + name;
        if (name === 'goal-invalid') goal(s.m, name, 'done', { programme: 'phone', text: '{invalid' });
        if (name !== 'missing') s.m.write(join(dir, '.mc-scratch.json'), name === 'malformed' ? '{broken' : JSON.stringify(marker));
      }
      s.m.cwds.push({ pid: 50, cwd: join(s.m.work, 'runner/scratch/active/other') });
      const { list } = runTidy(s.doors({ openIn: (path) => path.endsWith('/open') ? [51] : path.endsWith('/uncertain') ? null : [] }));
      assert.deepEqual(ruled(list, 'B').filter((x) => x.kind === 'native-cache').map((x) => x.path).sort(), [...s.native].sort());
      for (const [name, path] of paths) {
        assert.ok(existsSync(path), name);
        assert.ok(keptOf(list, path), name);
      }
      s.m.cwds = Object.assign([{ pid: 1, cwd: '/' }], { complete: false });
      assert.deepEqual(ruled(runTidy(s.doors()).list, 'B'), [], 'partial cwd evidence never proves inactivity');
    } finally { s.m.cleanup(); }
  });

  it('keeps warm shared caches, live dev bundles, open files and unknown inventories', () => {
    const s = cacheMachine();
    try {
      // A new nested file keeps the whole cache even when the root itself looks old.
      s.m.write(join(s.shared[2], 'new.bin'), 'new', NOW - 72 * HOUR);
      utimesSync(s.shared[2], new Date(OLD), new Date(OLD));
      s.m.cwds.push({ pid: 90, cwd: join(s.m.env.MC_HOME, 'build/memoro') });
      const { list } = runTidy(s.doors({
        servers: () => [{ pid: 91 }],
        openIn: (path) => {
          if (path === s.shared[0]) return [92];
          if (path === s.shared[3]) throw new Error('unreadable');
          return [];
        },
      }));
      for (const path of [s.bundle, ...s.shared]) {
        assert.ok(keptOf(list, path), path);
        assert.ok(existsSync(path), path);
      }
      assert.deepEqual(ruled(list, 'B').map((x) => x.path).sort(), [...s.native].sort());
      s.m.worktrees.memoro = [];
      assert.equal(ruled(runTidy(s.doors()).list, 'B').some((x) => x.path === s.bundle), false, 'unregistered worktrees are not adopted');
    } finally { s.m.cleanup(); }
  });

  it('rechecks ownership, complete cache identity, dev-server state and exact path boundaries at apply', () => {
    const s = cacheMachine();
    try {
      const preview = runTidy(s.doors());
      s.m.write(join(s.dir, '.mc-scratch.json'), JSON.stringify({ ...s.marker, session: 'goal:phone/new-owner' }));
      s.m.write(join(s.shared[0], 'nested/output'), 'changed', OLD);
      renameSync(s.shared[1], s.shared[1] + '.previous');
      s.m.write(join(s.shared[1], 'nested/output'), 'replacement', OLD);
      for (const p of [s.shared[1], join(s.shared[1], 'nested')]) utimesSync(p, new Date(OLD), new Date(OLD));
      const outside = join(s.m.home, 'outside'); s.m.write(join(outside, 'keep'), 'outside');
      rmSync(s.shared[2], { recursive: true }); symlinkSync(outside, s.shared[2]);
      // Even an in-root parent symlink is refused, not followed to the formerly approved cache.
      const parent = join(s.m.home, 'Library/Containers/com.apple.mediaanalysisd/Data/Library/Caches');
      renameSync(parent, parent + '.saved'); symlinkSync(parent + '.saved', parent);
      const written = JSON.parse(readFileSync(preview.listPath, 'utf8'));
      written.targets.push({ path: join(s.m.home, 'Library/Containers'), kind: 'device-delta-cache', rule: 'B' });
      writeFileSync(preview.listPath, JSON.stringify(written));
      const result = applyTidy({ listPath: preview.listPath, ...s.doors({ servers: () => [{ pid: 99 }] }) });
      for (const path of s.targets) {
        assert.equal(result.applied.find((x) => x.path === path).ok, false, path);
        assert.ok(existsSync(path), path);
      }
      assert.equal(result.applied.at(-1).ok, false, 'a forged parent target is not allowed');
      assert.equal(readFileSync(join(outside, 'keep'), 'utf8'), 'outside');
    } finally { s.m.cleanup(); }
  });

  it('refreshes activity again at each removal and unlinks inner cache symlinks without touching their targets', () => {
    const s = cacheMachine();
    try {
      const outside = join(s.m.home, 'outside.txt'); s.m.write(outside, 'keep');
      symlinkSync(outside, join(s.native[0], 'external-link'));
      let busy = false;
      const doors = s.doors({
        openIn: (path) => path === s.dir && busy ? [88] : [],
        remove: (path) => { rmSync(path, { recursive: true }); if (path === s.native[0]) busy = true; },
      });
      const preview = runTidy(doors);
      const result = applyTidy({ listPath: preview.listPath, ...doors });
      assert.equal(result.applied.find((x) => x.path === s.native[0]).ok, true);
      for (const path of s.native.slice(1)) {
        assert.equal(result.applied.find((x) => x.path === path).ok, false, path);
        assert.ok(existsSync(path));
      }
      assert.equal(readFileSync(outside, 'utf8'), 'keep');
    } finally { s.m.cleanup(); }
  });
});

describe('file-scoped screenshot open-file evidence', () => {
  it('cleans closed old shots despite unrelated subtree failures and preserves opened or uncertain files', () => {
    const m = machine();
    try {
      const root = join(m.env.MC_HOME, 'shots');
      const closed = join(root, 'old.png'); const opened = join(root, 'nested/open.png');
      const hidden = join(root, '.browser-profile/keep.png');
      for (const p of [closed, opened, hidden]) m.write(p);
      const doors = m.doors({
        openIn: () => { throw new Error('whole subtree cannot be inventoried'); },
        filesOpen: (paths) => {
          assert.deepEqual([...paths].sort(), [closed, opened].sort(), 'hidden profiles never enter lsof');
          return new Map([[closed, []], [opened, [77]]]);
        },
      });
      const preview = runTidy(doors);
      assert.deepEqual(ruled(preview.list, 'F').map((x) => x.path), [closed]);
      const uncertain = applyTidy({ listPath: preview.listPath, ...doors, filesOpen: () => null });
      assert.equal(uncertain.applied.find((x) => x.path === closed).ok, false);
      assert.ok(existsSync(closed) && existsSync(opened) && existsSync(hidden));
      const applied = applyTidy({ listPath: preview.listPath, ...doors });
      assert.equal(applied.applied.find((x) => x.path === closed).ok, true);
      assert.ok(!existsSync(closed) && existsSync(opened) && existsSync(hidden));
    } finally { m.cleanup(); }
  });

  it('bounds exact-file lsof batches, accepts mixed open/closed results and rejects malformed or failed evidence', () => {
    const m = machine();
    try {
      const paths = Array.from({ length: 105 }, (_, i) => join(m.home, i === 7 ? 'file\np777.png' : `file-${i}.png`));
      for (const p of paths) m.write(p);
      const calls = [];
      const opened = openFilesAmong(paths, { run: (cmd, args) => {
        assert.equal(cmd, 'lsof'); assert.ok(!args.includes('+D'));
        const files = args.slice(args.indexOf('--') + 1); calls.push(files);
        return calls.length === 1 ? { status: 1, stdout: `p42\0\nf19\0n${files[7]}\0\np43\0\nfmem\0n${files[7]}\0\n`, stderr: '' }
          : { status: 1, stdout: '', stderr: '' };
      } });
      assert.deepEqual(calls.map((x) => x.length), [100, 5]);
      assert.deepEqual([...opened].filter(([, pids]) => pids.length), [[paths[7], [42, 43]]]);
      const real = realpathSync(paths[0]);
      for (const result of [
        { status: 0, stdout: `p42\0n${real}\0`, stderr: 'partial inventory' },
        { status: 1, stdout: `p42\0n${real}\0`, stderr: 'partial inventory' },
        { status: 2, stdout: `p42\0n${real}\0` },
        { status: 0, stdout: `n${real}\0` },
        { status: 0, stdout: 'p42\0n/outside\0' },
        { status: 0, stdout: '' }, { status: 2 }, { error: new Error('timeout') },
      ]) assert.equal(openFilesAmong([paths[0]], { run: () => result }), null);
      assert.equal(openFilesAmong([paths[0]], { run: () => { throw new Error('spawn failed'); } }), null);
      assert.deepEqual(openFilesAmong([], { run: () => assert.fail('empty inventory spawns nothing') }), new Map());
    } finally { m.cleanup(); }
  });
});

describe('(S) registered source exports (scratch.js) in the routine and pressure passes', () => {
  /**
   * A tidy machine with the memoro-cli repository the model Git answers for. Each
   * session is a runner scratch directory; `exportIn` makes a real export in it,
   * `end` records the session's end. Runner pid 4242 is alive and runs `mc run`.
   */
  function exportMachine() {
    const m = machine();
    const git = gitModel();
    git.commit('one', { 'src/a.js': 'committed a\n', 'src/b.js': 'committed b\n' });
    const scratch = tidyRoots(m.env).scratch;
    const session = (stem, over = {}) => {
      const dir = join(scratch, stem);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, '.mc-scratch.json'), JSON.stringify({
        schema: 'mc-scratch', version: 1, owner: 'runner', runner_pid: 4242, session: `goal:mc/${stem}`, kind: 'build', stem, started: '2026-10-12T08:00:00Z', ...over,
      }));
      writeFileSync(join(dir, 'gate.log'), 'red');
      return dir;
    };
    const end = (dir) => {
      const marker = JSON.parse(readFileSync(join(dir, '.mc-scratch.json'), 'utf8'));
      writeFileSync(join(dir, '.mc-scratch.json'), JSON.stringify({ ...marker, ended: '2026-10-12T09:00:00Z', exit: 0 }));
    };
    const exportIn = (dir, paths = ['src']) => createExport({
      scratch: dir, env: m.env, repos: defaultRepos(m.env), repoName: 'memoro-cli', ref: 'HEAD', paths,
      git: { text: (cwd, args) => git.text(cwd, args), blobs: (cwd, shas) => git.blobs(cwd, shas) }, now: NOW,
    });
    const exportDoors = (over = {}) => m.doors({
      git: (cwd, args) => git.text(cwd, args),
      openIn: (path) => (m.openHeld?.[path] ?? []),
      alive: (pid) => pid === 4242,
      commandLine: () => 'node /opt/homebrew/bin/mc run',
      ...over,
    });
    return { m, git, scratch, session, end, exportIn, exportDoors, blobId: gitBlobId };
  }
  const present = (path) => existsSync(path);
  const targetsOf = (list, kind) => list.targets.filter((item) => item.kind === kind).map((item) => item.path).sort();

  it('a ready export of an ended session is the one export target: its tree goes, and its receipt, the session\'s evidence and a running session\'s export stay', async () => {
    const x = exportMachine();
    try {
      const ended = x.session('ended');
      const endedMade = await x.exportIn(ended);
      x.end(ended);
      const running = x.session('running');
      const runningMade = await x.exportIn(running);
      const { list, outcome } = runTidy({ apply: true, ...x.exportDoors() });
      assert.deepEqual(targetsOf(list, 'scratch-export'), [endedMade.path]);
      assert.equal(ruled(list, 'S').find((item) => item.kind === 'scratch-export').rule, 'S');
      assert.deepEqual(outcome.applied.filter((item) => item.path === endedMade.path).map((item) => item.ok), [true]);
      assert.equal(present(endedMade.path), false, 'the ended session\'s tree is gone');
      assert.equal(readFileSync(join(ended, 'gate.log'), 'utf8'), 'red', 'its evidence stays');
      assert.match(readFileSync(join(ended, '.mc-exports', `${endedMade.id}.json`), 'utf8'), /"state": "released"/u, 'its receipt stays');
      assert.equal(readFileSync(join(runningMade.path, 'src', 'a.js'), 'utf8'), 'committed a\n', 'the running session\'s tree is intact');
      assert.equal(keptOf(list, runningMade.path).why, 'goal:mc/running has not recorded an end');
    } finally { x.m.cleanup(); }
  });

  it('active, open, incomplete, unregistered, malformed and runner-crash exports: the exact targets, and every other byte survives', async () => {
    const x = exportMachine();
    try {
      const ok = x.session('ok'); const okMade = await x.exportIn(ok); x.end(ok);
      const live = x.session('live'); const liveMade = await x.exportIn(live); x.end(live);
      x.m.cwds.push({ pid: 50, cwd: join(liveMade.path, 'src') });
      const open = x.session('open'); const openMade = await x.exportIn(open); x.end(open);
      x.m.openHeld = { [openMade.path]: [77] };
      const incomplete = x.session('incomplete'); x.end(incomplete);
      const half = join(incomplete, 'exports', 'abcdef012345-0123456789abcdef');
      mkdirSync(half, { recursive: true }); writeFileSync(join(half, 'partial.js'), 'half');
      const unregistered = x.session('unregistered'); x.end(unregistered);
      mkdirSync(join(unregistered, 'exports', 'whatever'), { recursive: true }); writeFileSync(join(unregistered, 'exports', 'whatever', 'keep.txt'), 'mine');
      const malformed = x.session('malformed'); const malformedMade = await x.exportIn(malformed); x.end(malformed);
      writeFileSync(join(malformed, '.mc-exports', `${malformedMade.id}.json`), '{broken');
      const crashed = x.session('crashed', { runner_pid: 9999 }); const crashedMade = await x.exportIn(crashed);
      const running = x.session('running'); const runningMade = await x.exportIn(running);

      const { list, outcome } = runTidy({ apply: true, ...x.exportDoors() });
      assert.deepEqual(targetsOf(list, 'scratch-export'), [okMade.path, crashedMade.path].sort(), 'exactly the ready ended export and the crashed runner\'s export');
      assert.deepEqual(outcome.applied.filter((item) => [okMade.path, crashedMade.path].includes(item.path)).map((item) => [item.path, item.ok]).sort(), [[okMade.path, true], [crashedMade.path, true]].sort());
      assert.equal(keptOf(list, liveMade.path).why, 'process 50 stands in it');
      assert.equal(keptOf(list, openMade.path).why, 'process 77 holds a file open in it');
      assert.match(keptOf(list, malformedMade.path).why, /broken|JSON|Unexpected|receipt/u);
      assert.equal(keptOf(list, runningMade.path).why, 'goal:mc/running has not recorded an end');
      assert.equal(present(okMade.path), false);
      assert.equal(present(crashedMade.path), false, 'the runner that owned it is gone: its export goes');
      assert.equal(readFileSync(join(liveMade.path, 'src', 'a.js'), 'utf8'), 'committed a\n', 'the standing process\'s export keeps its bytes');
      assert.equal(readFileSync(join(openMade.path, 'src', 'a.js'), 'utf8'), 'committed a\n', 'the open file\'s export keeps its bytes');
      assert.equal(readFileSync(join(runningMade.path, 'src', 'a.js'), 'utf8'), 'committed a\n', 'the running session\'s export keeps its bytes');
      assert.equal(readFileSync(join(malformedMade.path, 'src', 'a.js'), 'utf8'), 'committed a\n', 'the malformed receipt\'s export keeps its bytes');
      assert.equal(readFileSync(join(half, 'partial.js'), 'utf8'), 'half', 'an incomplete directory is not a target');
      assert.equal(readFileSync(join(unregistered, 'exports', 'whatever', 'keep.txt'), 'utf8'), 'mine', 'an arbitrary exports directory is not a target');
      assert.equal(readFileSync(join(malformed, 'gate.log'), 'utf8'), 'red');
    } finally { x.m.cleanup(); }
  });

  it('the pressure pass selects exactly the routine pass\'s exports and weakens none of their safeguards', async () => {
    const x = exportMachine();
    try {
      const ok = x.session('ok'); const okMade = await x.exportIn(ok); x.end(ok);
      const live = x.session('live'); const liveMade = await x.exportIn(live);
      const half = join(x.session('incomplete'), 'exports', 'abcdef012345-0123456789abcdef');
      mkdirSync(half, { recursive: true });
      x.m.cwds.push({ pid: 50, cwd: join(liveMade.path, 'src') });
      const routine = runTidy({ apply: false, ...x.exportDoors() }).list;
      const pressure = runTidy({ apply: true, pressure: true, ...x.exportDoors() }).list;
      assert.deepEqual(targetsOf(pressure, 'scratch-export'), targetsOf(routine, 'scratch-export'));
      assert.deepEqual(targetsOf(pressure, 'scratch-export'), [okMade.path]);
      assert.equal(present(liveMade.path), true, 'a standing process keeps its export under pressure');
      assert.equal(present(half), true, 'an incomplete directory stays under pressure');
    } finally { x.m.cleanup(); }
  });

  it('an export changed between the list and the apply is retained with its reason: changed content, replaced receipt, or another owner', async () => {
    const x = exportMachine();
    try {
      const contentDir = x.session('content'); const contentMade = await x.exportIn(contentDir); x.end(contentDir);
      const receiptDir = x.session('receipt'); const receiptMade = await x.exportIn(receiptDir); x.end(receiptDir);
      const ownerDir = x.session('owner'); const ownerMade = await x.exportIn(ownerDir); x.end(ownerDir);
      const { listPath } = runTidy({ apply: false, ...x.exportDoors() });
      writeFileSync(join(contentMade.path, 'src', 'a.js'), 'Xommitted a\n');
      const receiptFile = join(receiptDir, '.mc-exports', `${receiptMade.id}.json`);
      writeFileSync(receiptFile, readFileSync(receiptFile, 'utf8').replace('"state": "ready"', '"state": "ready", "note": "edited"'));
      const ownerFile = join(ownerDir, '.mc-scratch.json');
      writeFileSync(ownerFile, JSON.stringify({ ...JSON.parse(readFileSync(ownerFile, 'utf8')), session: 'goal:mc/someone-else' }));
      const { applied } = applyTidy({ listPath, ...x.exportDoors() });
      const outcome = (path) => applied.find((item) => item.path === path);
      assert.equal(outcome(contentMade.path).ok, false);
      assert.match(outcome(contentMade.path).why, /changed content: src\/a\.js/u);
      assert.equal(outcome(receiptMade.path).ok, false);
      assert.match(outcome(receiptMade.path).why, /receipt, tree or dependency link changed/u);
      assert.equal(outcome(ownerMade.path).ok, false);
      assert.match(outcome(ownerMade.path).why, /owning session of this export changed/u);
      for (const kept of [contentMade.path, receiptMade.path, ownerMade.path]) assert.equal(present(kept), true, `${kept} survives`);
      assert.equal(readFileSync(join(contentMade.path, 'src', 'a.js'), 'utf8'), 'Xommitted a\n', 'the changed bytes are not overwritten');
    } finally { x.m.cleanup(); }
  });
});
