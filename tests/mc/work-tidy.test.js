/**
 * `mc work tidy` (work-tidy.js): one list, decided purely, executed as given.
 *
 * 2026-09-26: an ad-hoc loop meant to remove orphaned transcripts deleted
 * nearly all of `~/.claude/projects`, `memory/` included. These tests are
 * mostly about what survives.
 */
import assert from 'node:assert/strict';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { parseArgs } from '../../src/mc/commands/work.js';
import { setLogPath } from '../../src/mc/logger.js';
import { areaOf, applyTidy, gatherTidyFacts, tidyPlan } from '../../src/mc/work-tidy.js';

setLogPath(join(mkdtempSync(join(tmpdir(), 'mc-tidy-log-')), 'mc.log'));

const NOW = Date.parse('2026-09-26T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const OLD = NOW - 30 * DAY;
const RECENT = NOW - 2 * DAY;
const ROOT = '/w';
const ID = (n) => `3f9d2c81-0000-4000-8000-${String(n).padStart(12, '0')}`;

function facts(parts = {}) {
  return {
    now: NOW, work_root: ROOT, projects_root: '/c/projects', register: [], areas: [], transcripts: [], leftovers: [], ...parts,
  };
}
const transcript = (n, over = {}) => ({
  path: `/c/projects/-p/${ID(n)}.jsonl`, id: ID(n), cwd: '/elsewhere', cwd_exists: true, mtime_ms: OLD, bytes: 10, ...over,
});
const removes = { remove: true, what: 'worktree and branch', landed_by: null };
const area = (name, over = {}) => ({
  name, path: `${ROOT}/${name}`, role_home: false, foreign: [], conversations: [],
  worktrees: [{ path: `${ROOT}/${name}/repo`, repo: 'repo', branch: name, bytes: 100, verdict: removes }],
  ...over,
});
const paths = (items) => items.map((item) => item.path);
const keptWhy = (plan, path) => plan.kept.find((item) => item.path === path)?.why;

describe('tidyPlan — transcripts, first match wins', () => {
  it('T1: no cwd is kept, quietly', () => {
    const plan = tidyPlan(facts({ transcripts: [transcript(1, { cwd: null, cwd_exists: null })] }));
    assert.deepEqual(plan.transcripts, []);
    assert.equal(plan.kept[0].rule, 'T1');
  });
  it('T1 missed: a cwd moves on to the next rule', () => {
    const plan = tidyPlan(facts({ transcripts: [transcript(1, { cwd: '/gone', cwd_exists: false })] }));
    assert.deepEqual(paths(plan.transcripts), [transcript(1).path]);
  });
  it('T2: touched within --days is kept, even when its directory is gone', () => {
    const plan = tidyPlan(facts({ transcripts: [transcript(1, { cwd: '/gone', cwd_exists: false, mtime_ms: RECENT })] }));
    assert.deepEqual(plan.transcripts, []);
    assert.equal(plan.kept[0].rule, 'T2');
  });
  it('T2 missed: --days decides what is recent', () => {
    const plan = tidyPlan(facts({ transcripts: [transcript(1, { cwd: '/gone', cwd_exists: false, mtime_ms: RECENT })] }), { days: 1 });
    assert.equal(plan.transcripts.length, 1);
  });
  it('T3: an old transcript whose directory is gone goes', () => {
    const plan = tidyPlan(facts({ transcripts: [transcript(1, { cwd: '/gone', cwd_exists: false })] }));
    assert.equal(plan.transcripts[0].why, 'its directory is gone');
  });
  it('T3 missed: a directory that could not be stat-ed keeps it and says so', () => {
    const plan = tidyPlan(facts({ transcripts: [transcript(1, { cwd: '/x', cwd_exists: null })] }));
    assert.deepEqual(plan.transcripts, []);
    assert.match(plan.kept[0].why, /^could not tell/u);
  });
  it('T4: inside the work root, every one but the area\'s latest goes', () => {
    const plan = tidyPlan(facts({
      transcripts: [
        transcript(1, { cwd: `${ROOT}/a/repo`, mtime_ms: OLD }),
        transcript(2, { cwd: `${ROOT}/a`, mtime_ms: OLD - DAY }),
        transcript(3, { cwd: `${ROOT}/a/repo/src`, mtime_ms: OLD - 2 * DAY }),
      ],
    }));
    assert.deepEqual(paths(plan.transcripts).sort(), [transcript(2).path, transcript(3).path]);
    assert.equal(plan.transcripts[0].why, 'older than 14 days and not a\'s latest');
    assert.equal(plan.kept.find((item) => item.path === transcript(1).path).rule, 'T4');
  });
  it('T4: the latest may be the recent one, and then every old one goes', () => {
    const plan = tidyPlan(facts({
      transcripts: [transcript(1, { cwd: `${ROOT}/a`, mtime_ms: RECENT }), transcript(2, { cwd: `${ROOT}/a`, mtime_ms: OLD })],
    }));
    assert.deepEqual(paths(plan.transcripts), [transcript(2).path]);
  });
  it('T4: plan/<programme> is one area, and areas are counted apart', () => {
    const plan = tidyPlan(facts({
      transcripts: [
        transcript(1, { cwd: `${ROOT}/plan/mc/wt-1`, mtime_ms: OLD }),
        transcript(2, { cwd: `${ROOT}/plan/mc/wt-2`, mtime_ms: OLD - DAY }),
        transcript(3, { cwd: `${ROOT}/plan/staff`, mtime_ms: OLD - DAY }),
      ],
    }));
    assert.deepEqual(paths(plan.transcripts), [transcript(2).path]);
    assert.equal(areaOf(`${ROOT}/plan/mc/x`, ROOT), 'plan/mc');
    assert.equal(areaOf(ROOT, ROOT), null);
    assert.equal(areaOf(`${ROOT}-other/x`, ROOT), null);
  });
  it('T5: an old transcript outside the work root whose directory exists is kept', () => {
    const plan = tidyPlan(facts({ transcripts: [transcript(1, { cwd: '/Users/x', cwd_exists: true })] }));
    assert.deepEqual(plan.transcripts, []);
    assert.equal(plan.kept[0].rule, 'T5');
  });
  it('an error reading a transcript keeps it', () => {
    const plan = tidyPlan(facts({ transcripts: [transcript(1, { error: 'EACCES', cwd: '/gone', cwd_exists: false })] }));
    assert.deepEqual(plan.transcripts, []);
    assert.equal(plan.kept[0].why, 'could not tell — EACCES');
  });
});

describe('tidyPlan — worktrees', () => {
  it('a landed worktree goes, and the emptied area with its conversations', () => {
    const conversations = [{ tool: 'claude-code', id: ID(9), path: `/c/projects/-w-a/${ID(9)}.jsonl`, bytes: 7 }];
    const plan = tidyPlan(facts({
      areas: [area('a', { conversations })],
      transcripts: [transcript(9, { cwd: `${ROOT}/a`, cwd_exists: true })],
    }));
    assert.deepEqual(paths(plan.worktrees), [`${ROOT}/a/repo`, `${ROOT}/a`]);
    assert.equal(plan.worktrees[1].bytes, 7);
    assert.deepEqual(plan.transcripts, [], 'a conversation going with its area is not listed twice');
  });
  it('the why names the pull request merged at the tip', () => {
    const plan = tidyPlan(facts({
      areas: [area('a', { worktrees: [{ path: `${ROOT}/a/r`, repo: 'r', bytes: 1, verdict: { ...removes, landed_by: { pr: 468 } } }] })],
    }));
    assert.equal(plan.worktrees[0].why, '#468 merged at this tip');
  });
  it('an area holding a non-git directory is kept whole and never released', () => {
    const plan = tidyPlan(facts({ areas: [area('runner', { foreign: ['log', 'scratch'] })] }));
    assert.deepEqual(plan.worktrees, []);
    assert.equal(keptWhy(plan, `${ROOT}/runner`), 'holds something that is not a git worktree');
  });
  it('a role home is kept', () => {
    const plan = tidyPlan(facts({ areas: [area('helper', { role_home: true })] }));
    assert.deepEqual(plan.worktrees, []);
    assert.equal(keptWhy(plan, `${ROOT}/helper`), 'a role home');
  });
  it('a register project with a ready step is kept; one with every step done is not', () => {
    const plan = tidyPlan(facts({
      register: [{ project: 'a', steps_left: 1 }, { project: 'b', steps_left: 0 }],
      areas: [area('a'), area('b')],
    }));
    assert.equal(keptWhy(plan, `${ROOT}/a`), 'project a has steps left');
    assert.deepEqual(paths(plan.worktrees), [`${ROOT}/b/repo`, `${ROOT}/b`]);
  });
  it('a worktree release keeps stays, and the area with it', () => {
    const plan = tidyPlan(facts({
      areas: [area('a', {
        worktrees: [
          { path: `${ROOT}/a/one`, repo: 'one', bytes: 5, verdict: removes },
          { path: `${ROOT}/a/two`, repo: 'two', bytes: 5, verdict: { remove: false, why: '3 uncommitted' } },
        ],
      })],
    }));
    assert.deepEqual(paths(plan.worktrees), [`${ROOT}/a/one`]);
    assert.equal(keptWhy(plan, `${ROOT}/a/two`), '3 uncommitted');
  });
  it('a directory verdict is never taken, and a worktree that errored is kept', () => {
    const plan = tidyPlan(facts({
      areas: [area('a', {
        worktrees: [
          { path: `${ROOT}/a/d`, repo: 'd', bytes: 5, verdict: { remove: true, what: 'directory' } },
          { path: `${ROOT}/a/e`, repo: 'e', bytes: 5, error: 'lsof reported no processes' },
        ],
      })],
    }));
    assert.deepEqual(plan.worktrees, []);
    assert.equal(keptWhy(plan, `${ROOT}/a/e`), 'could not tell — lsof reported no processes');
  });
});

describe('tidyPlan — leftovers', () => {
  it('an old <uuid>/ with no transcript goes; a recent one or one that errored stays', () => {
    const plan = tidyPlan(facts({
      leftovers: [
        { path: `/c/projects/-p/${ID(1)}`, newest_ms: OLD, bytes: 3 },
        { path: `/c/projects/-p/${ID(2)}`, newest_ms: RECENT, bytes: 3 },
        { path: `/c/projects/-p/${ID(3)}`, error: 'EACCES' },
      ],
    }));
    assert.deepEqual(paths(plan.leftovers), [`/c/projects/-p/${ID(1)}`]);
    assert.equal(plan.leftovers[0].why, 'left behind by an earlier delete');
  });
});

describe('--days', () => {
  it('defaults to 14, takes a whole number, and refuses 0', () => {
    assert.equal(parseArgs(['tidy']).days, 14);
    assert.equal(parseArgs(['tidy', '--days', '3']).days, 3);
    assert.ok(parseArgs(['tidy', '--days', '0']).error);
    assert.ok(parseArgs(['tidy', '--days', 'x']).error);
    assert.ok(parseArgs(['tidy', 'name']).error);
  });
});

/* ---------------------------------------------------------- filesystem */

function machine() {
  const root = mkdtempSync(join(tmpdir(), 'mc-tidy-'));
  const work = join(root, 'mc');
  const claude = join(root, 'claude');
  const projects = join(claude, 'projects');
  mkdirSync(work, { recursive: true });
  mkdirSync(projects, { recursive: true });
  const env = {
    ...process.env, MC_WORK_ROOT: work, CLAUDE_CONFIG_DIR: claude, CODEX_HOME: join(root, 'codex'),
  };
  const write = (path, text = 'x', at = OLD) => {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, text);
    utimesSync(path, new Date(at), new Date(at));
  };
  const age = (path, at = OLD) => utimesSync(path, new Date(at), new Date(at));
  const head = (cwd) => `${JSON.stringify({ type: 'user', cwd, message: { content: 'hi' } })}\n`;
  return { root, work, projects, env, write, age, head, cleanup: () => { chmodSync(root, 0o700); rmSync(root, { recursive: true, force: true }); } };
}

describe('gather and apply on a real tree', () => {
  it('runner/log under the work root survives', () => {
    const m = machine();
    try {
      m.write(join(m.work, 'runner', 'log', 'x'));
      m.write(join(m.work, 'proposals', 'p.md'));
      const plan = tidyPlan(gatherTidyFacts({ env: m.env, now: NOW }));
      assert.deepEqual(plan.worktrees, []);
      applyTidy(plan, { env: m.env });
      assert.ok(existsSync(join(m.work, 'runner', 'log', 'x')));
      assert.ok(existsSync(join(m.work, 'proposals', 'p.md')));
      assert.equal(keptWhy(plan, join(m.work, 'runner')), 'holds something that is not a git worktree');
    } finally { m.cleanup(); }
  });

  it('memory/ survives while an old transcript of a gone directory and its <uuid>/ go', () => {
    const m = machine();
    try {
      const dir = join(m.projects, '-Users-x-mc-gone-memoro');
      m.write(join(dir, 'memory', 'MEMORY.md'), '# memory');
      m.write(join(dir, `${ID(1)}.jsonl`), m.head(join(m.root, 'mc', 'gone', 'memoro')));
      m.write(join(dir, ID(1), 'subagents', 'a.jsonl'), 'y'.repeat(100));
      const plan = tidyPlan(gatherTidyFacts({ env: m.env, now: NOW }));
      assert.deepEqual(paths(plan.transcripts), [join(dir, `${ID(1)}.jsonl`)]);
      assert.ok(plan.transcripts[0].bytes >= 100, 'the <uuid>/ is counted');
      const outcome = applyTidy(plan, { env: m.env });
      assert.equal(outcome.removed.transcripts.length, 1);
      assert.equal(existsSync(join(dir, `${ID(1)}.jsonl`)), false);
      assert.equal(existsSync(join(dir, ID(1))), false);
      assert.ok(existsSync(join(dir, 'memory', 'MEMORY.md')), 'memory/ is never touched');
    } finally { m.cleanup(); }
  });

  it('a project directory beginning with - is walked as a path, and an emptied one goes', () => {
    const m = machine();
    try {
      const dir = join(m.projects, '-rf');
      m.write(join(dir, `${ID(2)}.jsonl`), m.head('/nonexistent/for/sure'));
      const outcome = applyTidy(tidyPlan(gatherTidyFacts({ env: m.env, now: NOW })), { env: m.env });
      assert.equal(outcome.removed.transcripts.length, 1);
      assert.equal(existsSync(dir), false);
      assert.ok(existsSync(m.projects));
    } finally { m.cleanup(); }
  });

  it('a leftover <uuid>/ goes; a same-aged notes/ beside it stays', () => {
    const m = machine();
    try {
      const dir = join(m.projects, '-Users-x');
      m.write(join(dir, ID(3), 'tool-results', 'r.txt'));
      m.age(join(dir, ID(3), 'tool-results'));
      m.age(join(dir, ID(3)));
      m.write(join(dir, 'notes', 'n.md'));
      m.age(join(dir, 'notes'));
      const plan = tidyPlan(gatherTidyFacts({ env: m.env, now: NOW }));
      assert.deepEqual(paths(plan.leftovers), [join(dir, ID(3))]);
      applyTidy(plan, { env: m.env });
      assert.equal(existsSync(join(dir, ID(3))), false);
      assert.ok(existsSync(join(dir, 'notes', 'n.md')));
    } finally { m.cleanup(); }
  });

  it('a leftover touched recently anywhere inside is kept', () => {
    const m = machine();
    try {
      const dir = join(m.projects, '-Users-x');
      m.write(join(dir, ID(4), 'deep', 'fresh.txt'), 'x', RECENT);
      m.age(join(dir, ID(4), 'deep'));
      m.age(join(dir, ID(4)));
      assert.deepEqual(tidyPlan(gatherTidyFacts({ env: m.env, now: NOW })).leftovers, []);
    } finally { m.cleanup(); }
  });

  it('an unreadable transcript is kept', { skip: process.getuid?.() === 0 }, () => {
    const m = machine();
    try {
      const dir = join(m.projects, '-Users-x');
      const path = join(dir, `${ID(5)}.jsonl`);
      m.write(path, m.head('/nonexistent/for/sure'));
      chmodSync(path, 0o000);
      const plan = tidyPlan(gatherTidyFacts({ env: m.env, now: NOW }));
      assert.deepEqual(plan.transcripts, []);
      applyTidy(plan, { env: m.env });
      chmodSync(path, 0o600);
      assert.ok(existsSync(path));
    } finally { m.cleanup(); }
  });

  it('an unreadable projects/ removes nothing', { skip: process.getuid?.() === 0 }, () => {
    const m = machine();
    try {
      const dir = join(m.projects, '-Users-x');
      m.write(join(dir, `${ID(6)}.jsonl`), m.head('/nonexistent/for/sure'));
      chmodSync(m.projects, 0o000);
      const plan = tidyPlan(gatherTidyFacts({ env: m.env, now: NOW }));
      chmodSync(m.projects, 0o700);
      assert.deepEqual(plan.transcripts, []);
      assert.ok(existsSync(join(dir, `${ID(6)}.jsonl`)));
    } finally { m.cleanup(); }
  });
});

describe('applyTidy executes the plan it is handed', () => {
  it('a transcript path that is not <uuid>.jsonl directly in a project directory is refused', () => {
    const m = machine();
    try {
      const stray = join(m.projects, '-p', 'memory', `${ID(7)}.jsonl`);
      m.write(stray);
      const outcome = applyTidy({
        projects_root: m.projects, worktrees: [], leftovers: [],
        transcripts: [{ path: stray, bytes: 1 }, { path: join(m.projects, '-p', 'MEMORY.jsonl'), bytes: 1 }],
      }, { env: m.env });
      assert.equal(outcome.failed.length, 2);
      assert.ok(existsSync(stray));
    } finally { m.cleanup(); }
  });

  it('a leftover that is not a <uuid>/ under projects/ is refused', () => {
    const m = machine();
    try {
      m.write(join(m.projects, '-p', 'memory', 'MEMORY.md'));
      const outcome = applyTidy({
        projects_root: m.projects, worktrees: [], transcripts: [],
        leftovers: [{ path: join(m.projects, '-p', 'memory'), bytes: 1 }, { path: join(m.projects, ID(8)), bytes: 1 }],
      }, { env: m.env });
      assert.equal(outcome.failed.length, 2);
      assert.ok(existsSync(join(m.projects, '-p', 'memory', 'MEMORY.md')));
    } finally { m.cleanup(); }
  });

  it('an area where release would now take more than the plan named is left whole', () => {
    const calls = [];
    const release = (name, { dryRun }) => {
      calls.push(dryRun);
      return { removed: [{ path: '/w/a/one', what: 'worktree and branch' }, { path: '/w/a/new', what: 'worktree and branch' }], conversations: [] };
    };
    const outcome = applyTidy({
      projects_root: '/c/projects', transcripts: [], leftovers: [],
      worktrees: [{ path: '/w/a/one', area: 'a', bytes: 1 }],
    }, { release });
    assert.deepEqual(calls, [true], 'the apply never ran');
    assert.match(outcome.failed[0].why, /\/w\/a\/new/u);
  });
});
