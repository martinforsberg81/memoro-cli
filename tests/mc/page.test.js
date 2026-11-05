/**
 * The page — the five sections `mc` prints, each built from fixtures, the
 * whole page rendered at three widths, and `collectPage` against a work root
 * made of real files with no git, no gh and no tmux.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { parseRuns } from '../../src/mc/brief-collect.js';
import { gateLockPath } from '../../src/mc/gate-lock.js';
import { mcHome } from '../../src/mc/paths.js';
import { modelsPath, readModels } from '../../src/mc/model-config.js';
import { diskSummary } from '../../src/mc/disk-pressure.js';
import {
  attachPrs, checksSection, collectPage, countNewErrors, dayByKind, dockerSection, intakeSection, mergePauses, mergePhase, mergesSection, newErrorLines,
  prsSection, programmesSection, readDigests, runnerSection, sessionsSection, mcSection,
} from '../../src/mc/page-collect.js';
import { intakeArchiveDir, intakeDir } from '../../src/mc/helper-collect.js';
import { actEnd, actStart, endRun, startRun } from '../../src/mc/language-runs.js';
import { QUEUED_DRAWN, colourFor, columnsFor, renderPage, renderPageLines } from '../../src/mc/page-render.js';
import { KIND_TONE, STATE_TONE } from '../../src/mc/page-grid.js';
import { controlPaths, drainLine, drainState } from '../../src/mc/run-control.js';
import { width } from '../../src/mc/status-render.js';
import { codeCommit, pageKey, restartPage, run as page } from '../../src/mc/commands/home.js';
import { RESTART } from '../../src/mc/page-live.js';
import { goalJson } from './_helpers/goal-file.js';

const NOW = new Date('2026-08-29T12:00:00Z');

/**
 * Goals as `goalsOf` gives them to PROGRAMMES: two programmes, one goal a
 * session is on, one open, one blocked on a person.
 */
const goalRow = (name, programme, { repos = ['memoro-cli'], stage = 'build', status = 'ready', running = false, last = { next: 'the next thing', comment: null } } = {}) => ({
  name, programme, repos, stage, status, phase: 1, held: false, sessions: 1, criteria: { met: 0, all: 1 },
  kind: 'goal', repo: repos[0], state: stage, progress: '1 sess', prs: [], carries: [],
  last, running, person: status === 'Martin', question: status === 'Martin' ? 'which one?' : null, problems: [],
});
const GOALS = [
  goalRow('docx-editor', 'docx-editing-surface', { repos: ['memoro'], running: true }),
  goalRow('mc-ui', 'mc'),
  goalRow('avatar-self-serve', 'assistant-avatar', { repos: ['memoro'], status: 'Martin' }),
];
const TSV = [
  'ts\tname\tkind\texit\tseconds\tpr\tturns\tinput\toutput\tcache_read\tcache_write\tsession\tnote',
  '2026-08-29T09:00:00Z\tdocx-editor\tstep\t0\t698\t10958\t49\t88\t36423\t3683298\t94528\ts2\tsuccess,open',
  '2026-08-29T10:00:00Z\tmc-ui\tstep\t0\t652\t440\t56\t96\t33172\t4724690\t118362\ts3\tsuccess,merged',
  '2026-08-29T11:00:00Z\tavatar-self-serve\ttriage\t142\t5400\t-\t-\t-\t-\t-\t-\t-\ttimeout',
].join('\n');
const ROWS = parseRuns(TSV).filter((row) => Date.parse(row.ts) >= Date.parse('2026-08-28T12:00:00Z'));
const live = () => true;

describe('SESSIONS', () => {
  const RUNNER = { pid: 4242, started: '2026-08-29T10:00:00Z' };
  const CURRENT = {
    name: 'mc-ui', kind: 'step', repo: 'memoro-cli', tool: 'claude', model: 'opus', check_in_minutes: 60, check_ins: 0,
    started: '2026-08-29T11:40:00Z', pid: 4242, worktree: '/w/mc-ui/memoro-cli',
  };

  it('carries the step, a pending STOP, the process and the day behind them', () => {
    const runner = runnerSection({
      runner: RUNNER, currents: [CURRENT], stop: true, rows: ROWS, now: NOW, alive: live,
    });
    assert.equal(runner.sessions[0].name, 'mc-ui');
    assert.equal(runner.sessions[0].elapsed_seconds, 1200);
    assert.deepEqual([runner.sessions[0].check_in_seconds, runner.sessions[0].check_ins], [3600, 0]);
    assert.equal(runner.stop, true);
    assert.equal(runner.process.alive, true);
    assert.equal(runner.stop_requested, null, 'a STOP with no time in it has no since');
    const timed = runnerSection({
      runner: RUNNER, currents: [CURRENT], stop: true, stopText: '2026-08-29T11:30:00.000Z\n', rows: ROWS, now: NOW, alive: live,
    });
    assert.deepEqual(timed.stop_requested, { at: '2026-08-29T11:30:00.000Z', age_seconds: 1800 });
    assert.equal(runner.day.steps, 3);
    assert.equal(runner.day.timeout, 1);
    assert.ok(runner.day.cost > 8 && runner.day.cost < 8.2, `≈ $8.07 list (cache writes at 2×): ${runner.day.cost}`);
  });

  /**
   * The runner runs three kinds of session (Martin, 2026-11-02): `plan`,
   * `build` of a project's step or of a goal, and `review`. Each row has its
   * kind as the first word, then what it works on, the repository, the model
   * and the clock — at 80 columns and at 120, with no line wider than the
   * terminal. `PLAN` is drawn from a fixture: the runner does not start plan
   * sessions yet (goal `headless-plan`).
   */
  it('draws one row per session, its kind first: PLAN, BUILD of a goal and of a project, REVIEW', () => {
    const lane = (over) => ({
      tool: 'claude', model: 'opus', check_in_minutes: 60, check_ins: 0, pid: 4242, worktree: '/w/x', ...over,
    });
    const runner = runnerSection({
      runner: RUNNER,
      currents: [
        lane({ name: 'goal:mc/runner-sessions', kind: 'build', variant: 'goal', repo: 'memoro-cli', lane: 0, started: '2026-08-29T11:00:00Z' }),
        lane({ name: 'docx-editor', kind: 'build', variant: 'project', repo: 'memoro', lane: 1, model: 'sonnet', started: '2026-08-29T11:40:00Z' }),
        lane({ name: 'goal:mc/review-and-land', kind: 'review', variant: 'goal', repo: 'memoro-cli', lane: 2, started: '2026-08-29T11:50:00Z' }),
        lane({ name: 'goal:mc/headless-plan', kind: 'plan', repo: 'memoro-cli', lane: 3, started: '2026-08-29T11:55:00Z' }),
        // A lane file from before the kinds: a project's `step`, read as its build.
        lane({ name: 'mc-ui', kind: 'step', repo: 'memoro-cli', lane: 4, started: '2026-08-29T11:58:00Z' }),
      ],
      rows: ROWS,
      lanes: { lanes: 6 },
      now: NOW,
      alive: live,
    });
    // `mc --json` has the shape the page draws from.
    // A goal's session is named as its goal row is, `mc/<goal>`.
    assert.deepEqual(runner.sessions.map((s) => [s.kind, s.variant, s.goal, s.name]), [
      ['build', 'project', null, 'docx-editor'],
      ['plan', null, 'mc/headless-plan', 'mc/headless-plan'],
      ['review', 'goal', 'mc/review-and-land', 'mc/review-and-land'],
      ['build', 'goal', 'mc/runner-sessions', 'mc/runner-sessions'],
      ['build', 'project', null, 'mc-ui'],
    ]);
    assert.ok(!('steps' in runner), 'the list is `sessions`');
    assert.deepEqual(runner.lanes.map((l) => l.session?.kind ?? null), ['build', 'build', 'review', 'plan', 'build', null]);
    for (const columns of [60, 80, 120]) {
      const lines = renderPageLines(pageData({ runner }), { columns, now: NOW });
      assert.ok(lines.every((line) => width(line) <= columns));
      assert.match(lines.join('\n'), /runner running · 5\/6 lanes/u);
      for (const name of ['mc/runner-sessions', 'docx-editor', 'mc/review-and-land', 'mc/headless-plan', 'mc-ui'])
        assert.equal(lines.filter((line) => line.includes(` · ${name} · `)).length, 1, name);
    }
  });

  /**
   * A project stacked over four pull requests has the first of them and `+3`
   * in the PR column, which every section has at the same x — never appended
   * after the room was measured, which ran an 80-column row over its edge
   * (review of e942e30).
   */
  it('puts a session\'s pull requests in the PR column: the first and +N, at 80 and 120 columns', () => {
    const runner = runnerSection({
      runner: RUNNER,
      currents: [{ name: 'docx-editor', kind: 'build', variant: 'project', repo: 'memoro', lane: 0, tool: 'claude', model: 'sonnet',
        check_in_minutes: 60, check_ins: 1, pid: 4242, worktree: '/w/x', started: '2026-08-29T11:40:00Z' }],
      rows: ROWS,
      lanes: { lanes: 2 },
      now: NOW,
      alive: live,
    });
    const prs = [14709, 14710, 14711, 14712].map((number) => ({ repo: 'memoro', number }));
    for (const session of runner.sessions) session.prs = prs;
    for (const columns of [80, 120]) {
      const lines = renderPageLines(pageData({ runner }), { columns, version: '0.7.11', now: NOW });
      for (const line of lines) assert.ok(width(line) <= columns, `${columns}: ${line}`);
      for (const number of [14709, 14710, 14711, 14712]) assert.ok(lines.some((line) => line.includes(`#${number}`)));
    }
  });

  /**
   * The day counts outcomes per kind. A row under an old word is the build or
   * review it was; what is not a session of the runner's kinds — a merge
   * round, the helper — is `other`, and is not counted as a session.
   */
  it('counts the day per kind, reading old rows as the kinds they were', () => {
    const row = (kind, note, exit = '0') => ({ kind, note, exit });
    // The notes as run.js writes them: the exit word, then where the step stands.
    const day = dayByKind([
      row('step', 'success,built'), row('step', 'timeout,built'), row('build-project', 'success,merged'),
      row('step', 'success,blocked'), row('goal', 'stalled'), row('build-goal', 'no-json', '143'),
      row('review', 'success,queued'), row('review-goal', 'success'),
      row('plan', 'success,open'), row('merge', 'success,merged'), row('helper', 'success'),
    ]);
    const counted = (over) => ({
      sessions: 0, merged: 0, queued: 0, built: 0, open: 0, red: 0, blocked: 0, failed: 0, timeout: 0, other: 0, ...over,
    });
    // A session that timed out but left its step built counts where it left it.
    assert.deepEqual(day.build, counted({ sessions: 6, built: 2, merged: 1, blocked: 1, timeout: 1, failed: 1 }));
    assert.deepEqual(day.review, counted({ sessions: 2, queued: 1, other: 1 }));
    assert.deepEqual(day.plan, counted({ sessions: 1, open: 1 }));
    assert.equal(day.other, 2);
    const runner = runnerSection({ rows: ROWS, now: NOW, alive: () => false });
    runner.day.by_kind = day;
    const dayAt = (columns) => renderPageLines(pageData({ runner }), { columns, now: NOW, expand: true }).find((l) => /^ {2}24 h /u.test(l));
    const counts = '  24 h · build 6 (1 merged, 2 built, 1 blocked, 1 failed, 1 timed out) · review 2 (1 queued) · plan 1 (1 open) · other 2';
    assert.equal(dayAt(160), `${counts} · ≈$8.07 list (opus, 2026-06)`);
    // Narrower, the cost gives way — its basis first, then itself — and the counts stay whole.
    assert.equal(dayAt(140), `${counts} · ≈$8.07 list`);
    assert.equal(dayAt(120), counts);
  });

  // The section is the machine and nothing else now: a person's session is
  // not the runner's business and is not carried here at all.
  it('carries no session a person opened', () => {
    const runner = runnerSection({ runner: RUNNER, rows: ROWS, now: NOW, alive: live });
    assert.ok(!('foreground' in runner));
    assert.ok(!('live' in runner));
  });

  // `mc run` drives one lane per repository at the same time, so the section
  // is a list: one line for memoro's step and one for memoro-cli's.
  it('carries one step per lane when two lanes are running', () => {
    const runner = runnerSection({
      runner: RUNNER,
      currents: [CURRENT, {
        name: 'docx-editor', kind: 'step', repo: 'memoro', tool: 'claude', model: 'opus',
        check_in_minutes: 60, check_ins: 0, started: '2026-08-29T11:50:00Z', pid: 4243, worktree: '/w/docx-editor/memoro',
      }],
      rows: ROWS,
      now: NOW,
      alive: live,
    });
    assert.deepEqual(runner.sessions.map((step) => step.repo), ['memoro', 'memoro-cli']);
    assert.deepEqual(runner.sessions.map((step) => step.name), ['docx-editor', 'mc-ui']);
  });

  /**
   * A lane exists between steps as much as during one, and the section drew a
   * row only where there was a step — so a lane waiting for its next project
   * and a lane whose process had died were the same absence.
   */
  it('carries every lane, numbered through, whether or not it has a step', () => {
    const runner = runnerSection({
      runner: RUNNER, currents: [CURRENT], rows: ROWS, now: NOW, alive: live,
    });
    // The steps fill from the top: a running row is its step's repository, and
    // an idle one is only a number.
    assert.deepEqual(runner.lanes.map((lane) => [lane.number, lane.repo, lane.session?.name ?? null]),
      [[1, 'memoro-cli', 'mc-ui'], [2, null, null]]);
    // The step on the lane is the one in `steps`, not a copy of it: there is
    // one of it, so the two cannot come to disagree.
    assert.equal(runner.lanes[0].session, runner.sessions[0]);
    // The lanes are the total, whatever repositories there are: a lane file
    // names the repository of the session in it.
    assert.deepEqual(runnerSection({ runner: RUNNER, currents: [CURRENT], repos: [], now: NOW, alive: live })
      .lanes.map((lane) => lane.repo), ['memoro-cli', null]);
    assert.deepEqual(runnerSection({ repos: ['memoro'], lanes: { lanes: 1 }, now: NOW, alive: () => false })
      .lanes, [{ number: 1, repo: null, lane: null, state: 'idle', session: null }]);
  });

  /**
   * `mc run lanes 2` puts two loops on every repository, and each writes its
   * own current file — `current-memoro.json` for lane 0, `current-memoro-1.json`
   * for lane 1 (`paths.currentFor`, run.js). The section drew one row per
   * repository and found the first step for it, so the second lane's step was
   * never on the page: on 2026-09-11 memoro had two steps in flight and RUNNER
   * showed one of them, over an idle memoro-cli that read like the other half.
   */
  it('carries as many lanes as the runner can fill, and both steps of one repository', () => {
    const second = {
      name: 'docx-editor', kind: 'step', repo: 'memoro-cli', lane: 1, tool: 'claude', model: 'sonnet', advisor: 'opus',
      check_in_minutes: 60, check_ins: 0, started: '2026-08-29T11:50:00Z', pid: 4242, worktree: '/w/docx-editor/memoro-cli',
    };
    const runner = runnerSection({
      runner: RUNNER, currents: [CURRENT, second], repos: ['memoro', 'memoro-cli'],
      lanes: { lanes: 3 }, now: NOW, alive: live,
    });
    // Three lanes in total are three rows, whatever the repositories. Oldest
    // step first, so a row moves only when one above it ends.
    assert.deepEqual(runner.lanes.map((lane) => [lane.number, lane.repo, lane.lane, lane.session?.name ?? null]), [
      [1, 'memoro-cli', 0, 'mc-ui'], [2, 'memoro-cli', 1, 'docx-editor'], [3, null, null, null],
    ]);
    assert.deepEqual(runner.setting, { lanes: 3 });
    // What the step is running on rides along: the advisor is on the row.
    assert.equal(runner.sessions.find((step) => step.name === 'docx-editor').advisor, 'opus');
    // A file past the setting is still a lane: the runner was started under a
    // higher count than the file holds now, and the file is the fact.
    const wider = runnerSection({
      runner: RUNNER, currents: [second], repos: ['memoro-cli'], lanes: { lanes: 1 }, now: NOW, alive: live,
    });
    assert.deepEqual(wider.lanes.map((lane) => [lane.number, lane.session?.name ?? null]), [[1, 'docx-editor']]);
    const over = runnerSection({
      runner: RUNNER, currents: [CURRENT, second], repos: ['memoro-cli'], lanes: { lanes: 1 }, now: NOW, alive: live,
    });
    assert.equal(over.lanes.length, 2, 'a step past the setting still has its row');


    const lines = renderPageLines(pageData({ runner }), { columns: 120, now: NOW, expand: true });
    assert.match(lines.join('\n'), /docx-editor · 10 min · claude · sonnet/u);
    assert.match(lines.join('\n'), /opus advisor/u);
    assert.match(lines.join('\n'), /runner running · 2\/3 lanes/u);
    assert.doesNotMatch(lines.join('\n'), /^ +3 +idle$/mu);
  });

  // step-credits: a lane on the API credit says so beside tool and model; one
  // on the plan, or a lane file from before billing was recorded, says nothing.
  it('shows credits beside tool and model for a lane on credits, and nothing for plan', () => {
    const lane = (billing) => ({
      name: 'docx-editor', kind: 'step', repo: 'memoro-cli', lane: 0, tool: 'claude', model: 'sonnet',
      check_in_minutes: 60, check_ins: 0, started: '2026-08-29T11:50:00Z', pid: 4242, worktree: '/w/docx-editor/memoro-cli',
      ...(billing === undefined ? {} : { billing }),
    });
    const rowFor = (billing) => {
      const runner = runnerSection({ runner: RUNNER, currents: [lane(billing)], repos: ['memoro-cli'], now: NOW, alive: live });
      return { runner, row: strip(rowWith(paintedPage(pageData({ runner })), 'docx-editor')) };
    };
    const credits = rowFor('credits');
    assert.equal(credits.runner.sessions[0].billing, 'credits');
    assert.match(credits.row, /sonnet · credits/u);
    for (const billing of ['plan', undefined]) {
      const plain = rowFor(billing);
      assert.equal(plain.runner.sessions[0].billing, billing ?? null);
      assert.match(plain.row, /sonnet/u);
      assert.doesNotMatch(plain.row, /credits/u);
    }
  });

  /**
   * The pid on a lane row was the runner's own: `current-memoro.json` and
   * `current-memoro-cli.json` both carry the pid of the one process that drives
   * both lanes, so the same number was drawn twice and killed nothing. The
   * repository is what tells the two rows apart.
   */
  it('summarizes occupied lanes at MC and retains activity without a duplicate session section', () => {
    const runner = runnerSection({ runner: RUNNER, currents: [CURRENT], rows: ROWS, now: NOW, alive: live });
    const lines = paintedPage(pageData({ runner }));
    assert.match(lines.map(strip).join('\n'), /mc-ui · 20 min/u);
    assert.match(lines.map(strip).join('\n'), /runner running · 1\/2 lanes/u);
    assert.doesNotMatch(lines.map(strip).join('\n'), /pid 4242|SESSIONS/u);
    assert.match(paintedPage(pageData()).map(strip).join('\n'), /runner not running.*mc run starts it/u);
  });

  /**
   * On 2026-09-20 a locked keychain made every `gh pr list` hang and the page
   * showed nothing of it. The round's `github.json` names each repository it
   * cannot ask; the section draws one line per repository while it does, with
   * the command that fixes it, and none once the round has asked again.
   */
  it('says which repository GitHub cannot be asked about, since when, and what fixes it', () => {
    const failing = (cause) => ({
      memoro: { since: '2026-08-29T08:20:00Z', last: '2026-08-29T11:50:00Z', attempts: 6, error: 'gh: timed out', cause },
    });
    const keychain = runnerSection({ runner: RUNNER, now: NOW, alive: live, github: failing('keychain') });
    assert.deepEqual(keychain.github.map((g) => [g.repo, g.since, g.cause, g.fix, g.next_ask]),
      [['memoro', '2026-08-29T08:20:00Z', 'keychain', 'security unlock-keychain', '2026-08-29T12:05:00Z']]);
    assert.ok(paintedPage(pageData({ runner: keychain })).some((line) => strip(line)
      === '    GitHub unreachable for memoro since 08:20Z (keychain locked) — run: security unlock-keychain'));

    const token = runnerSection({ runner: RUNNER, now: NOW, alive: live, github: failing('token') });
    assert.ok(paintedPage(pageData({ runner: token })).some((line) => strip(line)
      === '    GitHub unreachable for memoro since 08:20Z (gh token invalid) — run: gh auth login -h github.com'));

    // No diagnosis: the error is the reason, and no command is guessed at.
    const unknown = runnerSection({ runner: RUNNER, now: NOW, alive: live, github: failing(null) });
    assert.ok(paintedPage(pageData({ runner: unknown })).some((line) => strip(line)
      === '    GitHub unreachable for memoro since 08:20Z (gh: timed out)'));

    // Asked again and answered: the file is gone, and so is the line.
    const answered = runnerSection({ runner: RUNNER, now: NOW, alive: live, github: null });
    assert.deepEqual(answered.github, []);
    assert.ok(!paintedPage(pageData({ runner: answered })).some((line) => /GitHub unreachable/u.test(strip(line))));
  });

  // The runner's `disk.json`, while the disk under scratch holds new starts
  // back: the line it said, on the page; gone with the file.
  it('says the runner starts no step while the disk is too full', () => {
    const line = 'disk: 0.1 GiB free, below 5 GiB — no step started';
    const full = runnerSection({ runner: RUNNER, now: NOW, alive: live, disk: { at: '2026-08-29T11:50:00Z', free_bytes: 118 * 2 ** 20, line } });
    assert.equal(full.disk.line, line);
    assert.ok(paintedPage(pageData({ runner: full })).some((row) => strip(row).trim() === line));
    const room = runnerSection({ runner: RUNNER, now: NOW, alive: live, disk: null });
    assert.equal(room.disk, null);
    assert.ok(!paintedPage(pageData({ runner: room })).some((row) => /disk:/u.test(strip(row))));
  });

  // The disk policy (disk-pressure.js): measured free space, grey while
  // healthy; the last pass, its shortfall and the limit while under pressure.
  it('shows measured free space, and under pressure the last pass with measured beside estimated, its shortfall and the limit', () => {
    const state = {
      status: 'pressure', shortfall_bytes: 14e9, cooldown_until: '2026-08-29T12:05:00.000Z',
      last_cleanup: { at: '2026-08-29T12:00:00.000Z', trigger: 'monitor', outcome: 'shortfall', measured_delta_bytes: 1e9, estimate_bytes: 9e9, failed: false },
    };
    const read = (value) => () => JSON.stringify(value);
    const summary = (free, value) => diskSummary({ path: '/w/runner/scratch', stateDir: '/w/runner', read: read(value), freeBytes: () => free, nowMs: NOW.getTime() });
    const rows = (pressure) => paintedPage(pageData({ runner: runnerSection({ runner: RUNNER, now: NOW, alive: live, pressure }) })).map(strip).filter((row) => /disk:/u.test(row)).map((row) => row.trim());

    assert.deepEqual(rows(summary(45.29e9, null)), ['disk: 45.2 GB free (measured) — healthy; pressure below 30.0 GB, reserve 20.0 GB']);
    assert.deepEqual(rows(summary(26e9, state)), [
      'disk: 26.0 GB free (measured) — below 30.0 GB: new sessions, deploys and Docker starts wait',
      'disk: last pass 2026-08-29T12:00Z (monitor) shortfall: measured +1.0 GB, estimated 9.0 GB',
      'disk: 14.0 GB short of the 40.0 GB target; protected data is kept',
      'disk: next pass after 2026-08-29T12:05Z',
      'disk: this holds back mc\'s new work only; other apps and running work can still fill the disk',
    ]);
    assert.deepEqual(rows(summary(33e9, state)), [
      'disk: 33.0 GB free (measured) — healthy; pressure below 30.0 GB, reserve 20.0 GB',
      'disk: last pass 2026-08-29T12:00Z (monitor) shortfall: measured +1.0 GB, estimated 9.0 GB',
      'disk: 7.0 GB short of the 40.0 GB target; protected data is kept',
    ]);
    assert.equal(rows(summary(null, state))[0], 'disk: free space could not be measured — new sessions, deploys and Docker starts are refused');
  });

  // The runner's `memory.json`, the same way, beside the disk line.
  it('says the runner starts no step while memory is short, and only while the runner lives', () => {
    const line = 'memory: 12% free, below 20% — no step started';
    const memory = { at: '2026-08-29T11:50:00Z', free_percent: 12, line };
    const short = runnerSection({ runner: RUNNER, now: NOW, alive: live, memory });
    assert.equal(short.memory.line, line);
    assert.ok(paintedPage(pageData({ runner: short })).some((row) => strip(row).trim() === line));
    const room = runnerSection({ runner: RUNNER, now: NOW, alive: live, memory: null });
    assert.equal(room.memory, null);
    assert.ok(!paintedPage(pageData({ runner: room })).some((row) => /memory:/u.test(strip(row))));
    const gone = runnerSection({ runner: RUNNER, now: NOW, alive: () => false, memory });
    assert.ok(!paintedPage(pageData({ runner: gone })).some((row) => /memory:/u.test(strip(row))));
  });
});

/**
 * What is in production, drawn from the two readings that know it: the row
 * `mc deploy` wrote and the `/api/version` the helper cached. Fixtures only —
 * the page fetches nothing.
 */
describe('DEPLOY', () => {
  const SHA = '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9012';
  const OTHER = 'b3e65b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f00';
  const DEPLOYED = {
    started: '2026-08-29T09:40:00Z', ended: '2026-08-29T10:00:00Z', sha: SHA, build: '813',
    holder: 'martin@laptop', outcome: 'deployed', live_commit: SHA, live_build: '813',
    stopped_at: '', note: '',
  };
  const version = (commit, ageSeconds = 3600) => ({
    commit, short: commit.slice(0, 7), build: 23533, build_time: '2026-08-29T10:00:00Z',
    fetched: new Date(NOW.getTime() - ageSeconds * 1000).toISOString(), age_seconds: ageSeconds,
  });
  const section = (over = {}) => runnerSection({
    rows: [], now: NOW, alive: () => false, deploy: DEPLOYED, attempt: DEPLOYED, live: version(SHA), ...over,
  }).production;
  const line = (over = {}, at = {}) => paintedPage(pageData({ runner: runnerSection({ rows: [], now: NOW,
    alive: () => false, deploy: DEPLOYED, attempt: DEPLOYED, live: version(SHA), ...over }) }), at).join('\n');

  it('is the last deployed row, with its age — and the holder is not on the row', () => {
    const p = section();
    assert.equal(p.short, '1a2b3c4');
    assert.equal(p.build, '813');
    assert.equal(p.holder, 'martin@laptop');
    assert.equal(p.age_seconds, 7200);
    assert.equal(p.differs, false);
    assert.equal(p.running, null);
    assert.match(strip(line()), /RECORDED + 1a2b3c4 · deployed 2 h ago/u);
    // The holder is on the object and in `mc status`, and not on the line: it
    // is a hostname, it is bookkeeping, and it was being spent before what is
    // wrong (2026-09-06).
    assert.doesNotMatch(strip(line()), /martin@laptop/u);
  });

  /**
   * The two readings are the same commit at different lengths — `deploys.tsv`
   * writes the whole 40 characters and `/api/version` answers 7 — and `!==`
   * called every deploy this machine ever made a mismatch, in bold yellow, with
   * the same `919de24` printed on both sides of it.
   */
  it('does not call two shas that are the same commit a mismatch', () => {
    assert.equal(section({ live: version(SHA.slice(0, 7)) }).differs, false);
    assert.equal(section({ live: version(SHA.slice(0, 12)) }).differs, false);
    assert.equal(section({ live: version(SHA) }).differs, false);
    assert.equal(section({ live: version(OTHER.slice(0, 7)) }).differs, true);
    // Below git's own abbreviation a prefix matches too much to mean anything,
    // so nothing is compared and the two readings stand as they are.
    assert.equal(section({ live: version('1a2b3c') }).differs, true);
    assert.ok(!strip(line({ live: version(SHA.slice(0, 7)) })).includes('production answers'));
  });

  it('says in yellow when /api/version names another sha than the row', () => {
    const p = section({ live: version(OTHER) });
    assert.equal(p.differs, true);
    const drawn = line({ live: version(OTHER) });
    assert.match(strip(drawn), /LIVE + b3e65b6 · observed 60 min ago/u);
    assert.match(strip(drawn), /RECORDED + 1a2b3c4/u);
    assert.match(strip(drawn), /version mismatch/u);
    assert.match(rowWith(drawn.split('\n'), 'version mismatch'), /\x1b\[33m/u);
  });

  it('carries a deploy that is running now, and calls one that never came back late', () => {
    const started = new Date(NOW.getTime() - 5 * 60 * 1000).toISOString();
    const fresh = section({ attempt: { ...DEPLOYED, started, ended: '', sha: OTHER, outcome: 'running' } });
    assert.equal(fresh.running.short, 'b3e65b6');
    assert.equal(fresh.running.late, false);
    assert.match(strip(line({ attempt: { ...DEPLOYED, started, ended: '', sha: OTHER, outcome: 'running' } })),
      /ATTEMPT + b3e65b6 · running · 5 min ago/u);

    const old = { ...DEPLOYED, started: '2026-08-29T08:00:00Z', ended: '', sha: OTHER, outcome: 'running' };
    assert.equal(section({ attempt: old }).running.late, true);
    assert.match(strip(line({ attempt: old })), /ATTEMPT + b3e65b6 · no end recorded · 4 h ago/u);
  });

  it('reads a running deploy\'s pid from the record: alive is running however long, gone is late at once', () => {
    const started = new Date(NOW.getTime() - 5 * 60 * 1000).toISOString();
    const row = { ...DEPLOYED, started: '2026-08-29T08:00:00Z', ended: '', sha: OTHER, outcome: 'running', pid: '4242' };
    const alive = (pid) => pid === 4242;
    assert.equal(section({ attempt: row, alive }).running.late, false);
    assert.match(strip(line({ attempt: row, alive })), /ATTEMPT + b3e65b6 · running · 4 h ago/u);
    assert.equal(section({ attempt: { ...row, started }, alive: () => false }).running.late, true);

    // The first deploy there ever was, with nothing collected: still drawn.
    const first = section({ deploy: null, live: null, attempt: { ...row, started }, alive });
    assert.equal(first.running.short, 'b3e65b6');
    const drawn = paintedPage(pageData({
      runner: runnerSection({ rows: [], now: NOW, deploy: null, attempt: { ...row, started }, live: null, alive }),
    }));
    assert.match(strip(rowWith(drawn, 'ATTEMPT')), /ATTEMPT + b3e65b6 · running · 5 min ago/u);
  });

  /**
   * The width goes to what is wrong. `Deploy source preflight` — the one word
   * on the row that says where to look — was being clipped off the end at 100
   * columns while `by martin@laptop` sat in the middle of the line (2026-09-06).
   */
  it('says a deploy failed after the last good one, and where it stopped', () => {
    const failed = {
      ...DEPLOYED, started: '2026-08-29T11:00:00Z', ended: '2026-08-29T11:30:00Z', sha: OTHER,
      outcome: 'failed', live_commit: '', stopped_at: 'Deploy source preflight',
    };
    assert.equal(section({ attempt: failed }).failed.stopped_at, 'Deploy source preflight');
    for (const columns of [100, 120]) {
      assert.match(strip(line({ attempt: failed }, { columns })),
        /ATTEMPT + b3e65b6 · failed · 30 min ago\n +Deploy source preflight/u);
    }
  });

  it('retains a failed or refused first attempt even without a production reading', () => {
    for (const outcome of ['failed', 'refused']) {
      const attempt = { ...DEPLOYED, outcome, stopped_at: 'source preflight' };
      const p = section({ deploy: null, live: null, attempt });
      assert.equal(p.attempt.outcome, outcome);
      const text = strip(line({ deploy: null, live: null, attempt }));
      assert.match(text, /LIVE + unknown/u);
      assert.ok(text.includes(outcome));
      assert.match(text, /source preflight/u);
    }
  });

  it('says what production answers when mc has deployed nothing, and nothing at all when neither knows', () => {
    const p = section({ deploy: null, attempt: null });
    assert.equal(p.sha, null);
    assert.equal(p.differs, false, 'there is no row to differ from');
    assert.match(strip(line({ deploy: null, attempt: null })),
      /LIVE + 1a2b3c4 · observed 60 min ago/u);

    assert.equal(section({ deploy: null, attempt: null, live: null }), null);
    const quiet = paintedPage(pageData({ runner: runnerSection({ rows: [], now: NOW, alive: () => false }) }));
    assert.equal(quiet.filter((row) => strip(row).includes('production')).length, 0,
      'a machine that has never deployed and never collected says nothing about production');
    // The section is there all the same, as the desks are: one of it, always.
    assert.match(strip(rowWith(quiet, 'DEPLOY     ')), /^ {4}DEPLOY + memoro/u);
  });
});

describe('LANGUAGE — the cached readings, the last run, and an open gap', () => {
  const READ = (over = {}) => ({
    lang: 'sv', read_at: '2026-08-29T10:00:00Z', unresolved: 0, without_usable: 0, waiting_rows: 0, forms: 120000, ...over,
  });
  const LAST = {
    manifest: 'sv-forms-cutover', lang: 'sv', outcome: 'stopped', started: '2026-08-29T09:00:00Z',
    ended: '2026-08-29T11:00:00Z', dry_run: false,
  };
  const drawn = (language) => paintedPage(pageData({ language }));

  it('is not drawn when there is nothing to say — the empty page gains no line', () => {
    const empty = renderPageLines(pageData(), { columns: 120, now: NOW });
    const quiet = renderPageLines(pageData({
      language: { languages: [READ()], last_run: null, open_gap: null },
    }), { columns: 120, now: NOW });
    assert.ok(!empty.some((line) => line.includes('LANGUAGE')));
    assert.deepEqual(quiet, empty, 'a fresh reading with nothing waiting says nothing');
    // And a page without the key at all — an older `--json` — draws the same.
    const { language: _, ...without } = pageData();
    assert.deepEqual(renderPageLines(without, { columns: 120, now: NOW }), empty);
  });

  it('draws only the languages with something to say, and the last run on its heading', () => {
    const lines = drawn({
      languages: [
        READ({ lang: 'de' }),
        READ({ lang: 'fr', read_at: '2026-08-20T10:00:00Z' }),
        READ({ waiting_rows: 724, unresolved: 3 }),
      ],
      last_run: LAST,
      open_gap: null,
    });
    const head = rowWith(lines, 'LANGUAGE');
    assert.match(strip(head), /^ {4}LANGUAGE {2}last run sv-forms-cutover · stopped · 60 min ago +mc language$/u);
    assert.deepEqual(signature(head).split(' '), ['bold+cyan', 'yellow', 'white', 'white'],
      'a section title, and a stopped run waits on a person');
    assert.match(strip(rowWith(lines, 'rows waiting')), /^ {6}sv {2}3 unresolved selectors · 724 rows waiting · mc language promote · read 2 h ago$/u);
    assert.match(strip(rowWith(lines, ' fr ')), /^ {6}fr {2}read 9 d ago$/u, 'a reading a week old is worth taking again');
    assert.ok(!lines.some((line) => /^ {6}de /u.test(strip(line))), 'a fresh reading with nothing waiting is not drawn');
    // Language remains inside MERGE & DEPLOY, before MAINTENANCE.
    const text = lines.map(strip).join('\n');
    assert.ok(text.indexOf('\n  ┌─ MERGE & DEPLOY') < text.indexOf('\n    LANGUAGE'));
    assert.ok(text.indexOf('\n    LANGUAGE') < text.indexOf('\n  ┌─ MAINTENANCE'));
  });

  it('puts one red line above every section while a run is stopped inside a gap', () => {
    const lines = drawn({
      languages: [],
      last_run: LAST,
      open_gap: { manifest: 'sv-forms-cutover', act: 'purge-wiktionary-forms', says: 'sv has no forms', started: LAST.started },
    });
    const gap = rowWith(lines, 'mc language resume');
    assert.equal(strip(gap), '  language: sv-forms-cutover stopped after purge-wiktionary-forms — sv has no forms · mc language resume');
    assert.equal(signature(gap), 'red+bold');
    assert.ok(lines.indexOf(gap) < lines.findIndex((line) => strip(line).startsWith('  PROGRAMMES')), 'above every section');
  });

  it('is gathered from the cache and the run records, offline', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-page-language-'));
    const env = { MC_WORK_ROOT: root, MC_HOME: root };
    const dir = join(root, 'runner', 'log', 'language');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'status-sv.json'), JSON.stringify({
      lang: 'sv',
      at: '2026-08-29T10:00:00Z',
      reads: {
        selectors: { ok: true, unresolved: 3, without_usable: 40 },
        forms: { ok: true, forms: 120000 },
        grammar: { ok: true, status: 'ready', waiting: 724 },
        anchors: { ok: false, exit: 1 },
      },
    }));
    const run = startRun({ manifest: 'sv-forms-cutover', lang: 'sv', started: '2026-08-29T09:00:00Z' }, env);
    const row = actStart(run, {
      id: 'purge-wiktionary-forms', phase: 'execute', opens_gap: { until: 'ingest-saldo', says: 'sv has no forms' },
    }, env);
    actEnd(run, row, { outcome: 'done' }, env);
    endRun(run, { outcome: 'stopped' }, env);

    const data = await collectPage({
      claudeSettings: () => null,
      env,
      now: NOW,
      repos: [],
      offline: true,
      exec: async () => ({ ok: false, stdout: '' }),
      run: () => ({ status: 1, stdout: '' }),
      git: () => null,
      checkout: null,
      cache: {
        loadPrs: () => ({ prs: [], fetched: null, age_seconds: null }),
        savePrs: () => { throw new Error('savePrs on the offline page'); },
      },
    });
    assert.deepEqual(data.language.languages, [{
      lang: 'sv', read_at: '2026-08-29T10:00:00Z', unresolved: 3, without_usable: 40, waiting_rows: 724, forms: 120000,
    }]);
    assert.equal(data.language.last_run.manifest, 'sv-forms-cutover');
    assert.equal(data.language.last_run.outcome, 'stopped');
    assert.deepEqual(
      { ...data.language.open_gap, started: undefined },
      { manifest: 'sv-forms-cutover', act: 'purge-wiktionary-forms', says: 'sv has no forms', started: undefined },
    );
    assert.match(renderPage(data, { columns: 120, now: NOW }), /^ {2}language: sv-forms-cutover stopped after purge-wiktionary-forms — sv has no forms · mc language resume$/mu);
  });
});

describe('collectPage — the repositories it reads', () => {
  it('reads a bare repository, which has no .git under its path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-page-bare-'));
    const bare = join(root, 'repos', 'memoro.git');
    mkdirSync(bare, { recursive: true });
    const asked = [];
    try {
      await collectPage({
        claudeSettings: () => null,
        env: { MC_WORK_ROOT: root, MC_HOME: root },
        now: NOW,
        repos: [{ name: 'memoro', path: bare, git: bare, bare: true, checkout: null }],
        exec: async (cmd, args) => { if (cmd === 'git') asked.push(args[1]); return { ok: false, stdout: '' }; },
        run: () => ({ status: 1, stdout: '' }),
        git: () => null,
        checkout: null,
        cache: {
          loadPrs: () => ({ prs: [], fetched: null, age_seconds: null }),
          savePrs: () => { throw new Error('savePrs on the offline page'); },
        },
      });
      assert.deepEqual(asked, [bare], 'the bare repository is fetched (2026-10-25: none was, and the page had nothing)');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('DOCKER — one line from the state file', () => {
  const STATE = {
    at: NOW.toISOString(),
    runtime: { kind: 'orbstack', up: true },
    leases: [{ pid: 95259, run: 'merge #13803', repo: 'memoro' }, { pid: 41100, run: 'gate x', repo: 'x' }],
    inventory: { df: { images: { count: 10 } } },
    idle_stop: null,
  };
  const dockerRows = (lines) => lines.filter((line) => /^\s+docker ·/u.test(line)).map((line) => line.trimEnd());

  it('is not drawn when there is no state file', () => {
    const lines = renderPageLines(pageData(), { columns: 120, now: NOW });
    assert.deepEqual(dockerRows(lines), []);
    assert.deepEqual(renderPageLines(pageData({ docker: null }), { columns: 120, now: NOW }), lines,
      'a page with no docker reading draws the same lines as one without the key');
  });

  it('draws the runtime, the live lease, the images and the idle stop', () => {
    const docker = dockerSection({ state: STATE, now: NOW, alive: (pid) => pid === 95259 });
    assert.equal(docker.leases.length, 1, 'the lease whose pid is gone is not held');
    const lines = renderPageLines(pageData({ docker }), { columns: 120, now: NOW });
    assert.deepEqual(dockerRows(lines), ['  docker · orbstack up · 1 lease (merge #13803) · 10 images']);
  });

  it('an idle runtime mc started says when it stops', () => {
    const idle = { ...STATE, leases: [], idle_stop: new Date(NOW.getTime() + 8 * 60_000).toISOString() };
    const docker = dockerSection({ state: idle, now: NOW, alive: () => false });
    assert.equal(docker.idle_stop_seconds, 480);
    const lines = renderPageLines(pageData({ docker }), { columns: 120, now: NOW });
    assert.deepEqual(dockerRows(lines), ['  docker · orbstack up · 0 leases · 10 images · idle stop in 8 min']);
  });

  it('a stopped runtime is one short line', () => {
    const stopped = { at: NOW.toISOString(), runtime: { kind: 'orbstack', up: false }, leases: [] };
    const docker = dockerSection({ state: stopped, now: NOW, alive: () => false });
    const lines = renderPageLines(pageData({ docker }), { columns: 120, now: NOW });
    assert.deepEqual(dockerRows(lines), ['  docker · orbstack stopped']);
  });

  it('is gathered from the state file, offline, and runs no docker call', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-page-docker-'));
    const env = { MC_WORK_ROOT: root, MC_HOME: root };
    mkdirSync(join(root, 'docker'), { recursive: true });
    writeFileSync(join(root, 'docker', 'state.json'), JSON.stringify(STATE));
    const calls = [];

    const data = await collectPage({
      env,
      now: NOW,
      repos: [],
      offline: true,
      exec: async () => ({ ok: false, stdout: '' }),
      run: (cmd) => { calls.push(cmd); return { status: 1, stdout: '' }; },
      git: () => null,
      checkout: null,
      cache: {
        loadPrs: () => ({ prs: [], fetched: null, age_seconds: null }),
        savePrs: () => { throw new Error('savePrs on the offline page'); },
      },
    });
    assert.equal(data.docker.kind, 'orbstack');
    assert.deepEqual(calls.filter((cmd) => cmd === 'docker' || cmd === 'orbctl'), []);
  });
});

describe('SESSIONS', () => {
  const HELPER = {
    verb: 'helper', area: null, tool: 'claude', model: 'sonnet', pid: 99,
    started: '2026-08-27T12:00:00Z',
  };
  const PLAN = {
    verb: 'plan', area: 'plan/msr-core', tool: 'claude', model: 'opus', pid: 100,
    started: '2026-08-29T11:30:00Z',
  };

  it('gives each desk its own slot, and says so when nobody is at one', () => {
    const s = sessionsSection({ foreground: [HELPER, PLAN], now: NOW, alive: live });
    assert.equal(s.desks.helper.pid, 99);
    // A desk nobody is at is `null` rather than missing: the page draws the
    // row either way, and "is the helper running?" is answered both ways.
    assert.equal(s.desks.manager, null);
    assert.equal(s.count, 2);
  });

  // A planning session belongs to its programme, and PROGRAMMES draws it on
  // that programme's own row. It is keyed by programme here so that section
  // never has to know how `mc plan` spells an area.
  it('keys a planning session by its programme, as its owner', () => {
    const s = sessionsSection({ foreground: [HELPER, PLAN], now: NOW, alive: live });
    assert.equal(s.planning['msr-core'].pid, 100);
    assert.deepEqual(s.planning['msr-core'].owner, { kind: 'programme', name: 'msr-core' });
    assert.deepEqual(s.strays, []);
  });

  // Every session has an owner: a programme or a desk, and no third kind
  // (goal mc/no-work).
  it('gives every session an owner that is a programme or a desk', () => {
    const PROJECT = { verb: 'project', area: 'step/ui', programme: 'mc', tool: 'codex', pid: 101, started: '2026-08-29T11:00:00Z' };
    const s = sessionsSection({ foreground: [HELPER, PLAN, PROJECT, { verb: 'brief', pid: 102 }], now: NOW, alive: live });
    assert.deepEqual(s.desks.helper.owner, { kind: 'desk', name: 'helper' });
    assert.deepEqual(s.desks.manager.owner, { kind: 'desk', name: 'manager' });
    assert.deepEqual(s.programme_sessions.mc.map((item) => [item.pid, item.owner]), [[101, { kind: 'programme', name: 'mc' }]]);
    assert.equal(s.count, 4);
    assert.deepEqual(s.strays, []);
    assert.equal('others' in s, false);
  });

  // A `mc plan` from before the programme change carries a bare project name,
  // belongs to no programme and cannot be started again: a stray.
  it('makes a plan session with no programme a stray', () => {
    const s = sessionsSection({
      foreground: [{ ...PLAN, area: 'mc-test' }], now: NOW, alive: live,
    });
    assert.deepEqual(s.planning, {});
    assert.deepEqual(s.strays.map((item) => [item.kind, item.name, item.verb]), [['register', 'mc-test', 'plan']]);
    assert.equal(s.count, 0);
  });

  // The whole point of the section. `started` has been in the register since
  // it existed and nothing read it, so a session opened on Sunday was drawn
  // exactly like one opened twenty minutes ago.
  it('carries how long each session has been open', () => {
    const s = sessionsSection({ foreground: [HELPER, PLAN], now: NOW, alive: live });
    assert.equal(s.desks.helper.age_seconds, 2 * 24 * 60 * 60);
    assert.equal(s.planning['msr-core'].age_seconds, 1800);
  });

  it('counts a tmux session mc did not start for anyone as a stray, with its age', () => {
    const s = sessionsSection({
      live: [{ name: 'docx-editor', opened_ms: Date.parse('2026-08-29T11:00:00Z') }],
      now: NOW,
      alive: live,
    });
    assert.deepEqual(s.strays.map((item) => [item.kind, item.name, item.age_seconds]),
      [['tmux', 'mc-docx-editor', 3600]]);
  });

  // Oldest first: the one open longest is the one most likely to have been
  // forgotten.
  it('puts the oldest stray first, and a retired verb\'s entry among them', () => {
    const s = sessionsSection({
      foreground: [PLAN, { ...HELPER, verb: 'work', area: 'red' }],
      live: [{ name: 'docx-editor', opened_ms: Date.parse('2026-08-29T11:00:00Z') }],
      now: NOW,
      alive: live,
    });
    assert.deepEqual(s.strays.map((item) => item.name), ['red', 'mc-docx-editor']);
  });

  it('drops a registered session whose process is gone', () => {
    const s = sessionsSection({
      foreground: [{ verb: 'brief', pid: 99 }, { verb: 'plan', area: 'x', pid: 100 }],
      now: NOW,
      alive: (pid) => pid === 100,
    });
    assert.equal(s.desks.manager, null);
    assert.deepEqual(s.strays.map((item) => item.verb), ['plan']);
  });
});

describe('MERGES', () => {
  const LANDING = {
    repo: 'memoro', pr: 11651, pid: 4242, phase: 'running 17 test files',
    mode: 'merge', since: '2026-08-29T11:56:00Z', age_seconds: 240,
  };
  const job = (pr, extra = {}) => ({ repo: 'memoro', pr, since: '2026-08-29T11:50:00Z', state: 'queued', ...extra });
  const section = (extra = {}) => mergesSection({ now: NOW, merger: { pid: 4242 }, ...extra });
  const drawing = (merges, columns = 120, colour = false) => {
    const lines = renderPageLines(pageData({ merges }), { columns, colour });
    const start = lines.findIndex((line) => /MERGE/u.test(line));
    const end = lines.findIndex((line, i) => i > start && line.startsWith('  └'));
    return lines.slice(start, end);
  };

  it('draws each repository\'s queue in the grid, including idle, landing, waiting, paused and red', () => {
    const fixtures = [section(), section({ landing: LANDING }), section({ queued: [job(1)] }),
      section({ pauses: { memoro: { kind: 'deploy', reason: 'deploy' } }, queued: [job(1)] }),
      section({ queued: [job(2, { state: 'red', reason: 'tests red' })] })];
    for (const merges of fixtures) for (const columns of [60, 80, 120, 160]) {
      const lines = drawing(merges, columns);
      assert.ok(lines.some((line) => /memoro +/u.test(line)));
      assert.ok(lines.some((line) => /memoro-cli +/u.test(line)));
      assert.ok(lines.every((line) => width(line) <= columns));
    }
    assert.match(drawing(section()).join('\n'), /memoro + queue empty[\s\S]*idle/u);
  });

  it('puts counts on the heading, PR numbers in landing order on their repository row', () => {
    const merges = section({ queued: [job(3, { repo: 'memoro-cli' }), job(2), job(1, { since: '2026-08-29T11:00:00Z' })] });
    assert.deepEqual(merges.repos.map((repo) => repo.waiting.map((item) => item.pr)), [[1, 2], [3]]);
    const lines = drawing(merges);
    assert.match(lines.join('\n'), /memoro + 2 in queue: #1 #2/u);
    assert.deepEqual(lines.filter((line) => /in queue:/u.test(line)).flatMap((line) => line.match(/#\d+/gu) || []), ['#1', '#2', '#3']);
    assert.deepEqual(merges.queued.items.map((item) => item.wait_seconds), [3600, 600, 600]);
  });

  it('joins landing identity and queue age, excludes it from waiting, and translates phases', () => {
    const merges = section({ landing: LANDING, queued: [job(11651, { state: 'landing', branch: 'feature' }), job(11652)],
      prs: [{ repo: 'memoro', number: 11651, title: 'A title '.repeat(50) }] });
    const repo = merges.repos[0];
    assert.equal(repo.landing.queue_age_seconds, 600);
    assert.equal(repo.landing.phase_words, 'gate');
    assert.equal(repo.landing.name, 'feature');
    assert.equal(repo.waiting.length, 1);
    for (const columns of [60, 80, 120]) {
      const lines = drawing(merges, columns);
      assert.match(lines.join('\n'), /merging #11651 + \[━●·\] · gate · 4 min/u);
      assert.match(renderPageLines(pageData({ merges }), { columns, expand: true }).join('\n'), /feature/u);
      assert.match(lines.join('\n'), /1 in queue: #11652/u);
      assert.ok(lines.every((line) => width(line) <= columns));
    }
    assert.equal(mergePhase('rebase candidate'), 'rebase');
    assert.equal(mergePhase('merged origin/main into candidate'), 'rebase');
    assert.equal(mergePhase('squash merge'), 'landing');
    assert.equal(mergePhase('pr-tests'), 'gate');
    for (const [phase, bar] of [['rebase candidate', '[●··]'], ['running tests', '[━●·]'], ['squash merge', '[━━●]'], [null, '[···]']]) {
      const rows = drawing(section({ landing: { ...LANDING, phase } }));
      assert.ok(rows.find((line) => line.includes('merging #11651')).includes(bar), `observed phase ${phase}`);
    }
  });

  it('keeps two concurrent landing queues separate', () => {
    const merges = section({ landing: [LANDING, { ...LANDING, repo: 'memoro-cli', pr: 838 }] });
    const text = drawing(merges).join('\n');
    assert.match(text, /memoro + queue empty[\s\S]*merging #11651 + \[━●·\] · gate[\s\S]*memoro-cli + queue empty[\s\S]*merging #838 + \[━●·\] · gate/u);
  });

  it('keeps legacy batch members in their repository\'s round, never as waiting', () => {
    const started = '2026-08-29T11:56:00Z';
    const merges = section({ landing: LANDING, queued: [job(11651, { state: 'landing', started }),
      job(11652, { state: 'landing', started })] });
    assert.equal(merges.landings.length, 2);
    assert.equal(merges.repos[0].landings.length, 2);
    assert.equal(merges.repos[0].waiting.length, 0);
    const text = drawing(merges).join('\n');
    assert.match(text, /merging #11651 + \[━●·\] · gate/u);
    assert.match(text, /merging #11652 + \[···\] · landing/u);
    assert.match(text, /with #11651/u);
  });

  it('draws a queued pull request in words, never in symbols', () => {
    const merges = section({ queued: [job(10)] });
    const row = drawing(merges, 120, true).find((line) => strip(line).includes('#10'));
    assert.match(strip(row), /1 in queue: #10/u);
    assert.doesNotMatch(strip(row), /⏸|↻|→/u);
  });

  it('keeps a red inline, in red with grey detail; an entry an older merger left mending is waiting', () => {
    const merges = section({ queued: [job(1, { state: 'red', reason: 'tests red', answered: '2026-08-29T11:55:00Z' }),
      job(2, { state: 'mending', mend: { pid: 4242, started: '2026-08-29T11:54:00Z', reason: 'conflicts' } })] });
    const repo = merges.repos[0];
    assert.equal(repo.reds.length, 1);
    assert.equal('mending' in repo, false);
    assert.deepEqual(repo.waiting.map((item) => item.pr), [2]);
    const lines = drawing(merges, 120, true);
    assert.doesNotMatch(lines.join('\n'), /mending/u);
    assert.match(strip(rowWith(lines, 'failed #1')), /failed #1 + red · 5 min/u);
    assert.match(rowWith(lines, 'tests red'), /\x1b\[31m/u);
    assert.match(lines.map(strip).join('\n'), /1 in queue: #2/u);
  });


  it('does not draw a closed red or count a red as waiting', () => {
    const merges = section({ queued: [job(1, { state: 'red' }), job(2, { state: 'red' })],
      prs: [{ repo: 'memoro', number: 1 }] });
    assert.deepEqual(merges.repos[0].reds.map((item) => item.pr), [1]);
    assert.equal(merges.repos[0].waiting.length, 0);
  });

  it('shows red pause labels only on the heading, including a deploy on memoro alone', () => {
    for (const [kind, reason] of [['deploy', 'deploy'], ['gate', 'gate round'], ['lease', 'lease held']]) {
      const merges = section({ queued: [job(1)], pauses: { memoro: { kind, reason } } });
      assert.equal(merges.repos[0].state, 'paused');
      assert.equal(merges.repos[0].pause.kind, kind);
      const rows = drawing(merges, 60, true);
      assert.match(rowWith(rows, 'paused'), /\x1b\[31m/u);
      assert.ok(strip(rowWith(rows, 'paused')).includes(reason));
      assert.equal(merges.repos[1].pause, null);
    }
  });

  it('shows merger stopped in red when work remains and the merger is absent', () => {
    const merges = section({ merger: null, queued: [job(1)] });
    assert.equal(merges.repos[0].state, 'stopped');
    assert.match(rowWith(drawing(merges, 80, true), 'merger stopped'), /\x1b\[31m/u);
    assert.equal(section({ merger: null }).repos[0].state, 'idle');
  });

  it('treats a live merger pid on a queued job as live without merger.json', () => {
    const merges = section({ merger: null, queued: [job(1, { state: 'landing', merger: process.pid })], alive: (pid) => pid === process.pid });
    assert.equal(merges.repos[0].state, 'waiting');
    assert.equal(merges.repos[0].merger_stopped, false);
    assert.doesNotMatch(drawing(merges, 80, true).map(strip).join('\n'), /merger stopped/u);
  });

  it('keeps both pause reasons and the stopped merger visible when the facts coincide', () => {
    const merges = section({ merger: null, queued: [job(1), job(2, { repo: 'memoro-cli' })],
      pauses: { memoro: { kind: 'deploy', reason: 'deploy' }, 'memoro-cli': { kind: 'gate', reason: 'gate round' } } });
    for (const columns of [60, 80, 120]) {
      const rows = drawing(merges, columns, true);
      const text = rows.map(strip).join('\n');
      assert.match(text, /paused + deploy/u);
      assert.match(text, /paused + gate round/u);
      assert.equal(rows.filter((line) => strip(line).includes('merger stopped')).length, 2);
      assert.ok(rows.every((line) => width(line) <= columns));
    }
  });

  it('reads the same deploy, gate-lane and non-orphaned lease barriers as the merger', () => {
    const repos = [{ name: 'memoro', path: '/repos/memoro' }, { name: 'memoro-cli', path: '/repos/memoro-cli' }];
    const free = { repos, deploy: () => null, round: () => null, lease: () => null };
    assert.deepEqual(mergePauses({ ...free, deploy: () => ({ sha: 'abc' }) }), {
      memoro: { kind: 'deploy', reason: 'deploy', sha: 'abc' }, 'memoro-cli': null,
    });
    const calls = [];
    const pauses = mergePauses({ ...free, round: (lane) => { calls.push(lane); return lane === 'memoro-cli' ? { pid: 42 } : null; } });
    assert.deepEqual(calls, ['memoro', 'memoro-cli']);
    assert.equal(pauses['memoro-cli'].kind, 'gate');
    assert.equal(mergePauses({ ...free, lease: () => ({ held: true, holder: 'other' }) }).memoro.kind, 'lease');
    assert.equal(mergePauses({ ...free, lease: () => ({ held: true, orphaned: true }) }).memoro, null);
    assert.equal(mergePauses({ ...free, rounds: [LANDING], round: () => LANDING,
      lease: () => ({ held: true, holder: 'own round' }) }).memoro, null);
  });

  it('treats check rounds as pauses, never as PRs landing', () => {
    for (const mode of ['check', 'full', 'nightly']) {
      assert.equal(section({ landing: { ...LANDING, mode } }).repos[0].landing, null);
    }
    assert.equal(section({ landing: { ...LANDING, mode: 'docs' } }).repos[0].landing.pr, LANDING.pr);
    const dir = mkdtempSync(join(tmpdir(), 'mc-merge-pause-'));
    try {
      writeFileSync(gateLockPath(dir, 'memoro'), JSON.stringify({ ...LANDING, mode: 'check' }));
      const pauses = mergePauses({ root: dir, repos: [{ name: 'memoro', path: '/repos/memoro' }],
        alive: (pid) => pid === 4242, deploy: () => null, lease: () => null });
      assert.equal(pauses.memoro.kind, 'gate');
      assert.equal(mergePauses({ root: dir, repos: [{ name: 'memoro', path: '/repos/memoro' }],
        alive: () => false, deploy: () => null, lease: () => null }).memoro, null);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('puts all landed PRs, including manual and batch merges, in per-repo day counts and last landing', () => {
    const history = [
      { repo: 'memoro.git', at: '2026-08-29T09:55:00Z', duration_ms: 300000, merged: [1, 2], phase: 'end' },
      { repo: 'memoro-cli', at: '2026-08-28T11:00:00Z', merged: [3] },
      { repo: 'memoro', at: '2026-08-29T09:55:00Z', merged: [2] },
      { repo: 'memoro', at: '2026-08-29T10:00:00Z', phase: 'start' },
    ];
    const merges = section({ history });
    assert.deepEqual(merges.repos.map((repo) => repo.day_count), [2, 0]);
    assert.equal(merges.repos[0].last.age_seconds, 7200);
    const lines = renderPageLines(pageData({ merges }), { columns: 80, expand: true, now: NOW });
    assert.match(lines.join('\n'), /2 merges in 24 h · last 2 h ago/u);
    assert.match(lines.join('\n'), /0 merges in 24 h/u);
  });

  it('fits long queues, simultaneous pauses and large counts at 80 and 120 columns', () => {
    const merges = section({ queued: [...Array.from({ length: 30 }, (_, i) => job(13200 + i)),
      ...Array.from({ length: 8 }, (_, i) => job(13500 + i, { state: 'red', reason: `failure ${i}` }))],
      pauses: { memoro: { kind: 'deploy', reason: 'deploy' }, 'memoro-cli': { kind: 'gate', reason: 'gate round' } } });
    for (const columns of [60, 80, 120]) {
      const folded = drawing(merges, columns, true);
      assert.ok(folded.every((line) => width(line) <= columns));
      assert.match(folded.map(strip).join('\n'), /24 more queued/u);
      assert.deepEqual(folded.map(strip).filter((line) => /failed #\d+/u.test(line)).map((line) => line.match(/#\d+/u)[0]),
        Array.from({ length: 8 }, (_, i) => `#${13507 - i}`), 'all failures stay visible beyond the normal queue limit');
      assert.deepEqual(folded.map(strip).filter((line) => /in queue:|^ {17}#/u.test(line)).flatMap((line) => line.match(/#\d+/gu) || []),
        Array.from({ length: QUEUED_DRAWN }, (_, i) => `#${13200 + i}`));
      const all = renderPageLines(pageData({ merges }), { columns, expand: true, now: NOW });
      assert.deepEqual(all.filter((line) => /#\d+ +queued/u.test(line)).map((line) => line.match(/#\d+/u)[0]),
        Array.from({ length: 30 }, (_, i) => `#${13200 + i}`));
      assert.ok(all.every((line) => width(line) <= columns));
    }
  });

  it('draws only repos[], and carries that exact shape in JSON', () => {
    const merges = section({ queued: [job(1)] });
    const parsed = JSON.parse(JSON.stringify(merges));
    parsed.queued.items = [job(99)];
    assert.equal(parsed.repos[0].waiting[0].pr, 1);
    assert.match(drawing(parsed).join('\n'), /1 in queue: #1/u);
    assert.doesNotMatch(drawing(parsed).join(''), /#99/u);
    assert.deepEqual(mergesSection({ queued: null }).repos.map((repo) => repo.waiting), [[], []]);
  });
});


describe('INTAKE', () => {
  const DIGEST = [
    '# Errors and maintenance — 2026-08-29', '',
    'Baseline: `errors-2026-08-28.md`.', '',
    '## New since the last digest', '',
    '- ! `abc123` — 41x 500 — a loud one',
    '- · `def456` — 3x 500 — a quiet one', '',
    '## Error fingerprints', '',
    '- not counted, this is another section',
  ].join('\n');

  it('shows the latest recorded helper run even after a missed day, separately from Manager', () => {
    const intake = intakeSection({ now: NOW, proposals: ['2026-08-29-mc-one.md'], runs: [
      { kind: 'helper', ts: '2026-08-27T10:00:00Z', exit: '0' },
      { kind: 'intake', ts: '2026-08-29T11:00:00Z', exit: '0' },
      { kind: 'helper', ts: '2026-08-28T10:00:00Z', exit: '1' },
      { kind: 'helper', ts: '2026-08-26T10:00:00Z', exit: '0' },
    ] });
    assert.deepEqual(intake.last_run, { at: '2026-08-28T10:00:00Z', age_seconds: 93600, ok: false });
    const sessions = sessionsSection({ foreground: [
      { verb: 'manager', pid: 102, started: '2026-08-29T11:00:00Z', tool: 'claude', model: 'opus' },
    ], now: NOW, alive: () => true });
    const programmes = programmesSection({ programmes: ['mc'], proposalCounts: { mc: 2 } });
    for (const columns of [60, 80, 120, 160]) {
      const lines = renderPageLines(pageData({ intake, sessions, programmes }), { columns });
      const header = lines.slice(0, lines.findIndex((line) => line.includes('PROGRAMMES'))).join('\n');
      assert.match(header, /mc manager/u);
      assert.match(header, /MANAGER · ● open 60 min/u);
      assert.match(header, /3 proposals/u);
      assert.match(lines.find((line) => line.includes('helper not open')), /helper not open · last run 26 h ago failed/u);
      assert.ok(lines.every((line) => width(line) <= columns), `${columns} columns`);
    }
  });

  it('counts the bullets under "New since the last digest", and the loud ones apart', () => {
    assert.deepEqual(countNewErrors(DIGEST), { count: 2, loud: 1, first: false });
    assert.deepEqual(countNewErrors('## New since the last digest\n\n_nothing new_\n'), { count: 0, loud: 0, first: false });
    assert.equal(countNewErrors('## New since the last digest\n\n_first digest — no baseline_\n').first, true);
    assert.deepEqual(countNewErrors('nothing at all'), { count: 0, loud: 0, first: false });
  });

  it('names the digest, its age and the proposals waiting', () => {
    const intake = intakeSection({
      digests: [{ repo: 'memoro', name: 'errors-memoro-2026-08-29.md', text: `${DIGEST}\n<!-- mc-helper:state v1\nfingerprint abc123 41\nfingerprint def456 3\nfingerprint older 8\n-->`, mtime_ms: Date.parse('2026-08-29T10:00:00Z') }],
      proposals: ['2026-08-29-mc-one.md', '2026-08-29-two.md'],
      now: NOW,
    });
    assert.equal(intake.repos[0].repo, 'memoro');
    assert.equal(intake.repos[0].date, '2026-08-29');
    assert.equal(intake.repos[0].age_seconds, 7200);
    assert.equal(intake.repos[0].errors_total, 3);
    assert.equal(intake.repos[0].new_errors, 2);
    assert.equal(intake.repos[0].loud, 1);
    assert.equal(intake.proposals, 2);
    assert.deepEqual(intake.by_system, { mc: 1, memoro: 0, untagged: 1 });
    // What lies in proposals, as BRIEF says it: how far back the pile reaches
    // and the newest by name — read off the file names, never out of the files.
    assert.deepEqual(intake.proposal_files, { oldest: '2026-08-29', newest: '2026-08-29', newest_names: ['two', 'mc-one'] });
    const checks = checksSection({ repos: [{name: 'memoro', deps: {read_at: NOW.toISOString(), audit: {counts: {critical: 2, high: 4, moderate: 6, low: 8}}}}], now: NOW });
    const lines = renderPageLines(pageData({ intake, checks }), { columns: 100 });
    const repo = lines.indexOf('    ● memoro');
    assert.match(lines[repo + 1], /Errors 3 · new 2 · loud 1 · 2 h old/u);
    assert.ok(lines.some(line => /2 critical · 4 high · 6 moderate · 8 low/u.test(line)));
    const cli = lines.indexOf('    ● memoro-cli');
    assert.match(lines[cli + 1], /Errors \? · new \? · loud \? · no digest/u);
    assert.ok(lines.slice(cli).some(line => /1 proposal waiting/u.test(line)));
    assert.ok(lines.some((line) => /1 proposal · untagged 1/u.test(line)));
  });

  /**
   * The message leads. The digest writes the fingerprint first, so the clip at
   * 100 columns was eating the half of the line that makes somebody look —
   * a hash and a count survived, and *what happened* did not.
   */
  it('keeps the `!` lines themselves in their three parts, and names the first few', () => {
    const many = ['## New since the last digest', '',
      '- ! `one` — 90x 500 — the first',
      '- ! `two` — 80x 500 — the second',
      '- · `quiet` — 2x 500 — not loud',
      '- ! `three` — 70x 500 — the third',
      '- ! failing now, and not in the last digest — `gate-round-died (2)`',
    ].join('\n');
    assert.deepEqual(newErrorLines('- ! `a` — x').lines, [], 'a bullet outside the section is not a new error');
    const intake = intakeSection({ digests: [{ repo: 'memoro', name: 'errors-memoro-2026-08-29.md', text: many, mtime_ms: null }], named: 3 });
    assert.equal(intake.repos[0].new_errors, 5);
    assert.equal(intake.repos[0].loud, 4);
    assert.deepEqual(intake.repos[0].loud_lines, [
      { message: 'the first', fingerprint: 'one', count: '90x 500' },
      { message: 'the second', fingerprint: 'two', count: '80x 500' },
      { message: 'the third', fingerprint: 'three', count: '70x 500' },
    ]);
    assert.equal(intake.repos[0].more_loud, 1);
    // A condition that has just started failing is not `fingerprint — count —
    // message` and is all message, which is the right answer for it too.
    const condition = newErrorLines(many).lines.at(-1);
    assert.deepEqual([condition.message, condition.fingerprint, condition.count],
      ['failing now, and not in the last digest — `gate-round-died (2)`', null, null]);

    // The table counts the delta; full messages remain available in JSON.
    for (const columns of [60, 100, 160]) {
      const lines = renderPageLines(pageData({ intake }), { columns });
      assert.match(lines[lines.indexOf('    ● memoro') + 1], /Errors \? · new 5 · loud 4/u);
      assert.ok(lines.every((line) => width(line) <= columns));
    }
  });

  it('has no `!` lines to print on a quiet day', () => {
    const intake = intakeSection({
      digests: [{ repo: 'memoro', name: 'errors-memoro-2026-08-29.md', text: '## New since the last digest\n\n_nothing new_\n', mtime_ms: null }],
    });
    assert.deepEqual(intake.repos[0].loud_lines, []);
    const lines = renderPageLines(pageData({ intake }), { columns: 100 });
    assert.match(lines[lines.indexOf('    ● memoro') + 1], /Errors \? · new 0 · loud 0/u);
  });

  it('names today\'s digest with the digests present only in the archive', () => {
    // The section read `~/mc/intake/` alone and matched `errors-<date>.md`
    // alone, so it named a file from 2026-08-30 for six days and then said
    // *no digest yet* on a day the collect had run twice — the drain had
    // archived the two legacy files it was still matching.
    const root = mkdtempSync(join(tmpdir(), 'mc-page-intake-'));
    const env = { MC_WORK_ROOT: root };
    mkdirSync(intakeDir(env), { recursive: true });
    const archive = intakeArchiveDir(env, new Date('2026-08-29T09:00:00Z'));
    mkdirSync(archive, { recursive: true });
    writeFileSync(join(archive, 'errors-2026-08-25.md'), 'the legacy one');
    writeFileSync(join(archive, 'errors-memoro-cli-2026-08-29.md'), 'mc itself');
    writeFileSync(join(archive, 'errors-memoro-2026-08-29.md'), DIGEST);

    const found = readDigests(env);
    assert.deepEqual(found.map((d) => d.name), ['errors-memoro-2026-08-29.md', 'errors-memoro-cli-2026-08-29.md']);
    const intake = intakeSection({ digests: found, proposals: [], now: NOW });
    assert.equal(intake.repos[0].date, '2026-08-29');
    assert.equal(intake.repos[0].new_errors, 2);
    const lines = renderPageLines(pageData({ intake }), { columns: 100 });
    assert.ok(!lines.some((line) => /no digest yet/u.test(line)), 'the collect has run');
    // One row each, and neither repository is hidden behind the other.
    assert.match(lines[lines.indexOf('    ● memoro') + 1], /Errors \? · new 2 · loud 1/u);
    assert.ok(lines.includes('    ● memoro-cli'));
  });

  it('has no digest to name when nothing has been collected at all', () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-page-intake-'));
    assert.deepEqual(readDigests({ MC_WORK_ROOT: root }), []);
  });

  it('says there is no digest rather than a zero that looks like health', () => {
    const intake = intakeSection({ digests: [], proposals: [], now: NOW });
    assert.deepEqual(intake.repos, []);
    assert.equal(intake.digests, 0);
    const lines = renderPageLines(pageData({ intake }), { columns: 100 });
    for (const name of ['memoro', 'memoro-cli']) {
      const at = lines.indexOf(`    ● ${name}`);
      assert.ok(at > 0);
      assert.match(lines[at + 1], /Errors \? · new \? · loud \? · no digest/u);
      assert.match(lines[at + 3], /deps never read/u);
    }
  });
});

function pageData(over = {}) {
  return {
    runner: runnerSection({ rows: [], now: NOW, alive: () => false }),
    sessions: sessionsSection({ now: NOW, alive: () => false }),
    merges: mergesSection({}),
    intake: intakeSection({ digests: [], proposals: [], now: NOW }),
    programmes: programmesSection({}),
    language: { languages: [], last_run: null, open_gap: null },
    caches: { fresh: false, prs: { fetched: null, age_seconds: null, count: 0 } },
    notes: [],
    ...over,
  };
}

/** The whole page, with every section carrying something. */
const DATA = pageData({
  runner: runnerSection({
    runner: { pid: 4242, started: '2026-08-29T10:00:00Z' },
    currents: [{
      name: 'mc-ui', kind: 'step', repo: 'memoro-cli', tool: 'claude', model: 'opus', check_in_minutes: 60, check_ins: 0,
      started: '2026-08-29T11:40:00Z', pid: 4242, worktree: '/w/mc-ui/memoro-cli',
    }],
    stop: true,
    rows: ROWS,
    now: NOW,
    alive: live,
  }),
  sessions: sessionsSection({
    foreground: [{
      verb: 'helper', area: null, tool: 'claude', model: 'sonnet', pid: 99,
      started: '2026-08-29T11:00:00Z',
    }],
    live: [{ name: 'docx-editor', opened_ms: Date.parse('2026-08-29T11:00:00Z') }],
    now: NOW,
    alive: live,
  }),
  merges: mergesSection({
    queued: [{
      repo: 'memoro', pr: 10958, branch: 'docx-editor',
      since: '2026-08-29T09:10:00Z', holder: { name: 'martin@laptop' },
    }],
  }),
  intake: intakeSection({
    digests: [{
      repo: 'memoro',
      name: 'errors-memoro-2026-08-29.md',
      text: '## New since the last digest\n\n- ! `abc` — 41x 500 — loud\n',
      mtime_ms: Date.parse('2026-08-29T11:00:00Z'),
    }],
    proposals: ['a.md'],
    now: NOW,
  }),
  programmes: programmesSection({
    goalRows: GOALS,
    programmes: ['dormant-one'],
    sessionStrays: [{ kind: 'tmux', name: 'mc-docx-editor', verb: null, pid: null, age_seconds: 3600 }],
  }),
  language: {
    languages: [{
      lang: 'sv', read_at: '2026-08-29T10:00:00Z', unresolved: 0, without_usable: 0, waiting_rows: 724, forms: 120000,
    }],
    last_run: {
      manifest: 'sv-forms-cutover', lang: 'sv', outcome: 'done', started: '2026-08-28T09:00:00Z',
      ended: '2026-08-28T10:00:00Z', dry_run: false,
    },
    open_gap: null,
  },
  caches: { fresh: false, prs: { fetched: '2026-08-29T10:00:00Z', age_seconds: 7200, count: 1 } },
  notes: ['PRs from cache, 2 h old — --fresh asks GitHub', 'no runner/log/runs.tsv'],
});

describe('operational panels', () => {
  it('groups operational work in orange panels above system details without hiding blockers', () => {
    const disk = 'disk: 0.1 GiB free, below 5 GiB — no step started';
    const data = pageData({
      runner: { ...DATA.runner, process: { alive: true }, disk: { line: disk } },
      dev: { servers: [], queue: [], running: 0, leased: 0, queued: 0 },
      billing: 'codex plan available · remaining plan capacity is measured for the next session · claude credits next',
      language: { languages: [{ lang: 'sv', waiting_rows: 724, read_at: NOW.toISOString() }] },
      prs: { fetched: NOW.toISOString(), count: 2, items: [
        { repo: 'memoro', number: 99901, title: 'Loose change', owner: { kind: 'none' } },
        { repo: 'memoro', number: 99902, title: 'Attached change', programme: 'mc', owner: { kind: 'plan' } },
      ] },
      checks: { repos: [{ repo: 'memoro', test: { age_seconds: 3600, short: 'abc1234', red: 2 },
        deps: { age_seconds: 7200, short: 'def5678', critical: 1, high: 4 } }] },
    });
    for (const columns of [60, 80, 100, 120, 160]) for (const expand of [false, true]) {
      const lines = renderPageLines(data, { columns, expand, now: NOW });
      const painted = renderPageLines(data, { columns, expand, colour: true, now: NOW });
      assert.deepEqual(painted.map(strip), lines);
      assert.ok(lines.every(line => width(line) <= columns), `${columns} columns`);
      const titles = ['MERGE & DEPLOY', 'DEV', 'MAINTENANCE'];
      const panels = titles.map(title => lines.findIndex(line => line.startsWith(`  ┌─ ${title} `)));
      assert.ok(panels.every((at, i) => at >= 0 && (!i || at > panels[i - 1])), 'three panels in work order');
      for (const at of panels) assert.ok(painted[at].includes('\x1b[38;5;208m┌─ '), 'orange border');
      const footer = lines.findIndex(line => /^  ── SYSTEM /u.test(line));
      assert.ok(footer > panels[2]);
      for (const [text, start, end] of [
        ['PRs outside goals', panels[0], panels[1]], ['#99901', panels[0], panels[1]],
        ['724 rows waiting', panels[0], panels[1]], ['full test 60 min', panels[2], footer],
        ['deps 2 h', panels[2], footer], ['2 red', panels[2], footer],
        ['codex plan available', footer, lines.length], [disk, footer, lines.length],
      ]) assert.ok(lines.slice(start, end).some(line => line.includes(text)), text);
      assert.equal(lines.filter(line => line.includes('#99901')).length, 1);
      assert.ok(lines.slice(footer).map(line => line.trim()).join(' ').includes(data.billing), 'both provider routes survive billing wrapping');
      assert.ok(!lines.some(line => line.includes('#99902') || /^  (CHECKS|PULL REQUESTS) /u.test(line)));
      const programmes = lines.findIndex(line => line.startsWith('  PROGRAMMES'));
      assert.ok(lines.slice(0, programmes).some(line => line.includes('New sessions paused — low disk space')));
    }
  });
});

describe('the page', () => {
  it('prints the sections in order — what does not move first, what moves nearest the prompt', () => {
    const text = renderPage({
      ...DATA,
      billing: 'plan · available',
      mc: mcSection({ process: DATA.runner.process, commit: 'abc1234', main: 'def5678', behind: 2, now: NOW }),
    }, { columns: 120, version: '0.7.11', now: NOW });
    const at = ['PROGRAMMES', '┌─ MERGE & DEPLOY', '    LANGUAGE', '┌─ DEV', '┌─ MAINTENANCE', '── SYSTEM', 'MC  ', 'BILLING'].map(head => text.indexOf(`\n${head.startsWith('    ') ? head : `  ${head}`}`));
    assert.doesNotMatch(text, /^ {2}INTAKE/mu, 'the intake is what lies on the helper\'s desk');
    assert.ok(at.every((index, n) => index >= 0 && (n === 0 || index > at[n - 1])), text);
    assert.match(text, /MC {2}0\.7\.11/u);
    // What is true of the work: the session in flight, and the goals
    // PROGRAMMES counts open, waiting and blocked, in the same numbers.
    assert.match(text, /1 in flight · 2 ready · 0 blocked · 1 Martin/u);
    assert.doesNotMatch(text.split('\n')[1], /queued/u, 'the headline remains unchanged');
    // One row per lane, the repository first and the runner's own pid nowhere:
    // both lane files carry it, so it named neither of them.
    assert.doesNotMatch(text, /pid 4242/u);
    assert.match(text, /■ stopping since an unknown time/u);
    assert.match(text, /runner running · 1\/2 lanes/u);
    assert.match(text, /UNASSIGNED ACTIVITY/u);
    assert.match(text, /start takes over now/u);
    assert.match(text, /helper ● open 60 min · no run recorded · claude sonnet/u);
    assert.doesNotMatch(text, /^  (HELPER|BRIEF)\b/mu);
    // No WORK: every session is a programme's or a desk's, and a tmux session
    // nobody's is a stray under PROGRAMMES (goal mc/no-work).
    assert.doesNotMatch(text, /^ {2}WORK/mu);
    assert.match(text, /^ {7}not an area mc knows$/mu);
    assert.match(text, /^ {7}mc-docx-editor\s+tmux session · open 60 min$/mu);
    // Per kind: the two old `step` rows are builds, and the triage row is not a
    // session of the runner's kinds, so it is `other`.
    assert.doesNotMatch(text, /^  NEXT /mu);
    assert.doesNotMatch(text, /skipped \d/u, 'NEXT is the order and nothing else');
    assert.doesNotMatch(text, /DECISIONS/u);
    assert.match(text, /^ {6}Errors \? · new 1 · loud 1 · 60 min old$/mu);
    assert.match(text, /^ {7}1 proposal · untagged 1$/mu);
    // Goal titles retain their numbers; canonical metadata follows on a child row.
    assert.match(text, /^ +1 avatar-self-serve$/mu);
    assert.match(text, /^ +2 docx-editor$/mu);
    assert.match(text, /^ +3 mc-ui$/mu);
    assert.doesNotMatch(text, /on a decision/u, 'no project rollup under BRIEF');
    assert.doesNotMatch(text, /unplanned-workareas/u);
    // mc itself is the last line: how long the runner has been up, on what, and
    // that there is newer code than it runs. How old the PR cache is, which was
    // here, is `--json`'s.
    assert.match(text, /^ {2}MC {2}0\.7\.11 · update available — origin\/main def5678 is 2 commits ahead · mc run --update · runner up 120 min$/mu);
    // The commit the runner is on is the first thing the width takes, and the last it gives back.
    assert.match(renderPage({ ...DATA, mc: mcSection({ process: DATA.runner.process, commit: 'abc1234', behind: 0, now: NOW }) },
      { columns: 120, version: '0.7.11', now: NOW }), /^ {2}MC {2}0\.7\.11 · up to date · runner up 120 min · on abc1234$/mu);
    // For a step's length after an update two runners are alive, and the line names both.
    const overlap = mcSection({
      process: DATA.runner.process, commit: 'abc1234', behind: 0, now: NOW, pid: 9001,
      predecessor: { pid: 4242, steps: ['gmail-ready', 'claims-entity'] },
    });
    assert.match(renderPage({ ...DATA, mc: overlap }, { columns: 160, version: '0.7.11', now: NOW }),
      /^ {2}MC {2}0\.7\.11 · up to date · runner up 120 min · pid 9001 on abc1234 · pid 4242 finishing 2 sessions \(gmail-ready, claims-entity\)$/mu);
    assert.doesNotMatch(text, /--fresh asks GitHub/u);
    assert.match(text, /note: no runner\/log\/runs\.tsv/u);
    assert.ok(!/note: PRs from cache/u.test(text), 'the cache line already says it');
  });

  /**
   * `expand` draws the dormant programmes too, each on a heading of its own;
   * the goals keep their numbers either way.
   */
  it('draws every programme on expand, keeping the same goal numbers', () => {
    const names = (lines) => lines.map((line) => /^ +[123] (avatar-self-serve|docx-editor|mc-ui)$/u.exec(line)?.[1]).filter(Boolean);
    const folded = renderPageLines(DATA, { columns: 120, now: NOW });
    const all = renderPageLines(DATA, { columns: 120, now: NOW, expand: true });
    assert.deepEqual(names(all), ['avatar-self-serve', 'docx-editor', 'mc-ui']);
    assert.deepEqual(names(folded), ['avatar-self-serve', 'docx-editor', 'mc-ui']);
    assert.ok(folded.some((line) => /^ {2}▸ 1 dormant$/u.test(line)), folded.join('\n'));
    assert.ok(!folded.some((line) => /^ {2}┌─ dormant-one\s/u.test(line)));
    assert.ok(all.some((line) => /^ {2}┌─ dormant-one · 0 goals/u.test(line)), all.join('\n'));
  });

  /**
   * `a` at the menu, driven through `run` — the closure that renders is the one
   * the live loop refreshes through, so the mode has to survive the redraw
   * rather than live inside one call.
   */
  it('a expands programme and operational details together, then collapses them again', async () => {
    const shown = [];
    const asked = ['a', 'a', 'q'];
    const data = { ...DATA,
      merges: mergesSection({ merger: { pid: 7 }, now: NOW, queued: Array.from({ length: 9 }, (_, i) =>
        ({ repo: 'memoro', pr: 14000 + i, state: 'queued', since: '2026-08-29T11:50:00Z' })) }),
      dev: { running: 1, leased: 1, servers: [{ kind: 'slot', port: 8920, repo: 'memoro', state: 'leased',
        name: 'BUILD mc/preview', branch: 'goal/preview-only', url: 'http://localhost:8920' }], queue: [] },
    };
    const code = await page([], {
      collect: async () => data,
      stdout: { columns: 120, write: () => {} }, stderr: { write: () => {} }, env: {}, interactive: () => true,
      reader: { ask: async () => asked.shift() ?? null, show: (lines) => shown.push(lines.join('\n')) },
      checkAndPrintFreshInstall: async () => {},
    });
    assert.equal(code, 0);
    assert.equal(shown.length, 2);
    assert.match(shown[0], /^ {2}┌─ dormant-one · 0 goals/mu);
    assert.match(shown[0], /#14008 +queued/u);
    assert.match(shown[0], /goal\/preview-only/u);
    assert.doesNotMatch(shown[1], /dormant-one|#14008|goal\/preview-only/u);
    for (const text of shown) {
      assert.match(text, /BUILD.*mc-ui/u, 'live activity never collapses');
      assert.match(text, /stopping since an unknown time/u, 'runner stop remains visible');
    }
  });

  it('the menu writes priority through mc model and redraws the effective setting', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-page-priority-'));
    try {
      const env = { MC_WORK_ROOT: root };
      const shown = [];
      const output = [];
      const asked = ['priority codex', 'q'];
      const render = (providerPriority) => pageData({ providerPriority });
      const code = await page([], {
        env, collect: async () => render(readModels(env).providerPriority),
        stdout: { columns: 120, write: (line) => output.push(line) }, stderr: { write: () => {} }, interactive: () => true,
        reader: { ask: async () => asked.shift() ?? null, show: (lines, key) => shown.push({ text: lines.join('\n'), key }) },
        checkAndPrintFreshInstall: async () => {},
      });
      assert.equal(code, 0);
      assert.equal(readModels(env).providerPriority, 'codex');
      assert.match(output.join(''), /provider priority: codex/u);
      assert.match(shown[0].text, /PROVIDER PRIORITY  codex/u);
      assert.notEqual(shown[0].key, '');
      for (const columns of [80, 120]) {
        const lines = renderPageLines(render('codex'), { columns, now: NOW }).join('\n');
        assert.match(lines, /PROVIDER PRIORITY  codex/u);
      }
      assert.ok(!readFileSync(modelsPath(env), 'utf8').includes('claude-code'), 'the real command wrote only the priority setting');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  /**
   * A page left open while `~/mc/self` fast-forwards goes on drawing with the
   * code it started on — on 2026-10-26 that showed codex-models as `invalid —
   * steps[2].kind: unknown key` a day after the review kind landed. A draw
   * that finds the commit moved makes the next RESTART start mc again.
   */
  it('starts again on the new code when the commit mc runs from moves under it', async () => {
    const commits = ['aaaaaaaa1', 'aaaaaaaa1', 'bbbbbbbb2'];
    const asked = ['a', RESTART];
    const restarted = [];
    const code = await page([], {
      collect: async () => DATA,
      stdout: { columns: 120, write: () => {} },
      stderr: { write: () => {} },
      env: {},
      interactive: () => true,
      reader: { ask: async () => asked.shift() ?? null, show: () => {} },
      commit: () => commits.shift() ?? 'bbbbbbbb2',
      restartPage: (how) => { restarted.push(how); return 7; },
      checkAndPrintFreshInstall: async () => {},
    });
    assert.equal(code, 7, 'the new page\'s exit code is this one\'s');
    assert.deepEqual(restarted.map(({ from, to }) => [from, to]), [['aaaaaaaa1', 'bbbbbbbb2']]);
  });

  it('runs mc again with the same arguments, and the wrapper\'s fd 3 when it holds one', () => {
    const calls = [];
    const written = [];
    const spawn = (bin, args, options) => { calls.push({ bin, args, stdio: options.stdio }); return { status: 3 }; };
    const code = restartPage({
      stdout: { write: (text) => written.push(text) },
      env: { MC_EMIT_SHELL_DIRECTIVES: '1' },
      from: 'aaaaaaaa1',
      to: 'bbbbbbbb2',
      spawn,
      execve: null,
      argv: ['node', '/opt/homebrew/bin/mc', '--emit-shell-directives'],
    });
    assert.equal(code, 3);
    assert.deepEqual(calls[0].args, ['/opt/homebrew/bin/mc', '--emit-shell-directives']);
    assert.deepEqual(calls[0].stdio, ['inherit', 'inherit', 'inherit', 3]);
    assert.match(written.join(''), /mc moved from aaaaaaaa to bbbbbbbb under this page/u);

    // A wrapper flag with no descriptor behind it: the restart still happens, without it.
    const fallback = [];
    restartPage({
      stdout: { write: () => {} },
      env: { MC_EMIT_SHELL_DIRECTIVES: '1' },
      spawn: (bin, args, options) => {
        fallback.push(options.stdio.length);
        return options.stdio.length > 3 ? { error: new Error('EBADF'), status: null } : { status: 0 };
      },
      execve: null,
      argv: ['node', 'mc'],
    });
    assert.deepEqual(fallback, [4, 3]);
  });

  // A restart replaces the process and starts on an empty screen: one `mc` per
  // tab, and one page in its scrollback.
  const MOVED = 'mc: mc moved from aaaaaaaa to bbbbbbbb under this page — starting it again on the new code\n';
  const restartWith = (overrides) => {
    const written = [];
    const spawned = [];
    const code = restartPage({
      stdout: { write: (text) => written.push(text) },
      env: { MC_EMIT_SHELL_DIRECTIVES: '1' },
      from: 'aaaaaaaa1',
      to: 'bbbbbbbb2',
      spawn: (bin, args, options) => { spawned.push({ bin, args, stdio: options.stdio, env: options.env }); return { status: 5 }; },
      execve: null,
      argv: ['node', '/opt/homebrew/bin/mc', '--emit-shell-directives'],
      ...overrides,
    });
    return { code, written: written.join(''), spawned };
  };

  it('restartPage: a TTY stdout gets the screen and scrollback cleared before the moved line', () => {
    const written = [];
    restartWith({ stdout: { isTTY: true, write: (text) => written.push(text) } });
    assert.equal(written.join(''), `\x1b[H\x1b[2J\x1b[3J${MOVED}`);
  });

  it('restartPage: a stdout that is not a TTY gets no escape and the line as before', () => {
    const { written } = restartWith({});
    assert.equal(written, `\n${MOVED}`);
    assert.doesNotMatch(written, /\x1b/u);
  });

  it('restartPage: with execve, the process is replaced and nothing is spawned', () => {
    const execs = [];
    const env = Object.freeze({ MC_EMIT_SHELL_DIRECTIVES: '1', MC_HOME: '/h' });
    const { spawned } = restartWith({ env, execve: (...args) => { execs.push(args); } });
    // fd 3 does not survive Node's execve, so the new image is told nothing
    // about it: no wrapper flag, no wrapper variable, the rest as it was.
    assert.deepEqual(execs, [[process.execPath, [process.execPath, '/opt/homebrew/bin/mc'], { MC_HOME: '/h' }]]);
    assert.deepEqual(spawned, []);
  });

  it('restartPage: a real exec keeps the PID and starts the new image without the wrapper flag', (t) => {
    if (typeof process.execve !== 'function') return t.skip('no process.execve before Node 22.15');
    const module = new URL('../../src/mc/commands/home.js', import.meta.url).href;
    const after = "console.log(JSON.stringify({ pid: process.pid, flag: process.env.MC_EMIT_SHELL_DIRECTIVES ?? null, args: process.argv.slice(1) }));";
    const before = [
      `import { restartPage } from ${JSON.stringify(module)};`,
      'console.log(process.pid);',
      `restartPage({ stdout: process.stdout, from: 'aaaaaaaa1', to: 'bbbbbbbb2', argv: [process.execPath, '--input-type=module', '-e', ${JSON.stringify(after)}, '--emit-shell-directives'] });`,
      "throw new Error('execve returned');",
    ].join('\n');
    const out = spawnSync(process.execPath, ['--input-type=module', '-e', before], {
      env: { ...process.env, MC_EMIT_SHELL_DIRECTIVES: '1' }, encoding: 'utf8', timeout: 30000,
    });
    assert.equal(out.status, 0, out.stderr);
    const lines = out.stdout.trim().split('\n');
    const replaced = JSON.parse(lines.at(-1));
    assert.equal(replaced.pid, Number(lines[0]), 'the same process, replaced');
    assert.equal(replaced.flag, null);
    assert.ok(!replaced.args.includes('--emit-shell-directives'), replaced.args.join(' '));
  });

  it('restartPage: with execve undefined, mc is spawned and waited on as before', () => {
    // Node 22 before 22.15 has no `process.execve`: the default is undefined
    // there, and an undefined dependency falls to that default.
    const real = process.execve;
    process.execve = undefined;
    let result;
    try {
      result = restartWith({ execve: undefined });
    } finally {
      process.execve = real;
    }
    const { code, spawned } = result;
    assert.equal(code, 5);
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0].bin, process.execPath);
    assert.deepEqual(spawned[0].args, ['/opt/homebrew/bin/mc', '--emit-shell-directives']);
    assert.deepEqual(spawned[0].stdio, ['inherit', 'inherit', 'inherit', 3]);
    assert.deepEqual(spawned[0].env, { MC_EMIT_SHELL_DIRECTIVES: '1' });
  });

  it('restartPage: with an execve that throws, mc is spawned and waited on as before', () => {
    let tried = 0;
    const env = Object.freeze({ MC_EMIT_SHELL_DIRECTIVES: '1', MC_HOME: '/h' });
    const { code, spawned } = restartWith({ env, execve: () => { tried += 1; throw new Error('ENOEXEC'); } });
    assert.equal(tried, 1);
    assert.equal(code, 5);
    assert.equal(spawned.length, 1);
    assert.deepEqual(spawned[0].args, ['/opt/homebrew/bin/mc', '--emit-shell-directives']);
    assert.deepEqual(spawned[0].stdio, ['inherit', 'inherit', 'inherit', 3]);
    assert.equal(spawned[0].env, env, 'the failed exec must leave the wrapper environment intact for spawn');
  });

  it('reads no commit when mc is not running from a checkout, or git does not answer', () => {
    assert.equal(codeCommit({ checkout: null }), null);
    assert.equal(codeCommit({ checkout: '/x', spawn: () => ({ status: 128, stdout: '' }) }), null);
    assert.equal(codeCommit({ checkout: '/x', spawn: () => ({ status: 0, stdout: 'abc\n' }) }), 'abc');
  });

  it('fits the terminal it is printed in, from 60 columns to 160', () => {
    for (const columns of [40, 60, 100, 200]) {
      const wide = Math.max(60, Math.min(columns, 160));
      const lines = renderPageLines(DATA, { columns, version: '0.7.11', now: NOW });
      const over = lines.filter((line) => width(line) > wide);
      assert.deepEqual(over, [], `${columns} columns: ${over.join('\n')}`);
      assert.ok(lines.some((line) => /runner running/u.test(line)), `${columns} columns lost runner diagnostics`);
    }
  });

  it('colours only a terminal, and only when NO_COLOR is unset or empty', () => {
    assert.equal(colourFor({ isTTY: true }, {}), true);
    assert.equal(colourFor({ isTTY: true }, { NO_COLOR: '' }), true);
    assert.equal(colourFor({ isTTY: true }, { NO_COLOR: '1' }), false);
    // The convention is any non-empty value; `!== '1'` was the old bug.
    assert.equal(colourFor({ isTTY: true }, { NO_COLOR: 'true' }), false);
    assert.equal(colourFor({ isTTY: false }, {}), false);
    assert.equal(colourFor(undefined, {}), false);
    assert.equal(columnsFor({ columns: 12 }), 60);
    assert.equal(columnsFor({ columns: 400 }), 160);
    assert.equal(columnsFor({}), 100);
    const plain = renderPage(DATA, { columns: 100, colour: false, now: NOW });
    const painted = renderPage(DATA, { columns: 100, colour: true, now: NOW });
    assert.ok(!/\u001b\[/u.test(plain), 'a page that is not a terminal carries no escapes');
    assert.ok(/\u001b\[32m/u.test(painted), 'green is running');
  });

  it('--json is the object the renderer takes, one key per section', async () => {
    let out = '';
    const code = await page(['--json'], {
      collect: async () => DATA, stdout: { write: (s) => { out += s; } }, checkAndPrintFreshInstall: async () => {},
    });
    assert.equal(code, 0);
    const parsed = JSON.parse(out);
    assert.deepEqual(Object.keys(parsed), ['runner', 'sessions', 'merges', 'intake', 'programmes', 'language', 'caches', 'notes']);
    assert.equal(parsed.programmes.programmes[0].goals[0].name, 'avatar-self-serve');
    // Rendering the parsed JSON gives the same page: the two cannot drift.
    assert.equal(renderPage(parsed, { columns: 100, now: NOW }), renderPage(DATA, { columns: 100, now: NOW }));
  });
});

describe('collectPage', () => {
  /** A work root of real files — and no git, no gh, no tmux. */
  function workRootFixture() {
    const root = mkdtempSync(join(tmpdir(), 'mc-page-'));
    mkdirSync(join(root, 'runner', 'log'), { recursive: true });
    writeFileSync(join(root, 'runner', 'runner.json'), JSON.stringify({ pid: process.pid, started: '2026-08-29T10:00:00Z' }));
    writeFileSync(join(root, 'runner', 'current-memoro-cli.json'), JSON.stringify({
      name: 'mc-ui', kind: 'step', repo: 'memoro-cli', tool: 'claude', model: 'opus', check_in_minutes: 60, check_ins: 0,
      started: '2026-08-29T11:40:00Z', pid: process.pid, worktree: `${root}/mc-ui/memoro-cli`,
    }));
    writeFileSync(join(root, 'runner', 'current-memoro.json'), JSON.stringify({
      name: 'docx-editor', kind: 'step', repo: 'memoro', tool: 'claude', model: 'opus', check_in_minutes: 60, check_ins: 0,
      started: '2026-08-29T11:50:00Z', pid: process.pid, worktree: `${root}/docx-editor/memoro`,
    }));
    mkdirSync(join(root, 'runner', 'foreground'), { recursive: true });
    writeFileSync(join(root, 'runner', 'foreground', `${process.pid}.json`), JSON.stringify({
      verb: 'brief', area: 'brief', tool: 'claude', model: 'opus', pid: process.pid, started: '2026-08-29T11:00:00Z',
    }));
    writeFileSync(join(root, 'runner', 'log', 'runs.tsv'), TSV);
    // What `mc deploy` wrote, and what the helper's last collect heard from
    // `/api/version` — the page's whole knowledge of production, both offline.
    writeFileSync(join(root, 'runner', 'log', 'deploys.tsv'), [
      'started\tended\tsha\tbuild\tholder\toutcome\tlive_commit\tlive_build\tstopped_at\tnote',
      '2026-08-29T09:40:00Z\t2026-08-29T10:00:00Z\t1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9012\t813\tmartin@laptop\tdeployed\t1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9012\t813\t\t',
      '',
    ].join('\n'));
    writeFileSync(join(root, 'runner', 'version.json'), JSON.stringify({
      fetched: '2026-08-29T11:00:00Z',
      version: { commit: 'b3e65b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f00', build: 23533, build_time: '2026-08-29T09:50:00Z' },
    }));
    writeFileSync(join(root, 'runner', 'merges.json'), JSON.stringify([{
      repo: 'memoro-cli', pr: 674, branch: 'mc-ui', since: '2026-08-29T11:30:00Z', state: 'queued',
      holder: { name: 'martin@laptop' },
    }]));
    writeFileSync(join(root, 'queue.md'), '# the queue\nmc-ui\ndocx-editor\n');
    mkdirSync(join(root, 'proposals'), { recursive: true });
    mkdirSync(join(root, 'intake'), { recursive: true });
    writeFileSync(join(root, 'intake', 'errors-2026-08-29.md'), '# Errors\n\n## New since the last digest\n\n- ! `abc` — 41x 500 — loud\n');
    writeFileSync(join(root, 'proposals', '2026-08-29-one.md'), 'A proposal, with no heading — mc counts it either way.\n');
    for (const area of ['mc-ui', 'docx-editor']) mkdirSync(join(root, area, 'memoro-cli', '.git'), { recursive: true });
    // One goal under the programmes home: PROGRAMMES reads it from there.
    const goal = join(root, 'programs', 'mc', 'goals', 'mc-ui');
    mkdirSync(goal, { recursive: true });
    writeFileSync(join(goal, 'GOAL.json'), goalJson({ title: 'The page' }));
    writeFileSync(join(goal, 'LOG.md'), '');
    const programmeProposals = join(root, 'programs', 'mc', 'proposals');
    mkdirSync(join(programmeProposals, 'archive'), { recursive: true });
    writeFileSync(join(programmeProposals, '2026-08-29-mc-one.md'), 'one');
    writeFileSync(join(programmeProposals, '2026-08-29-mc-two.md'), 'two');
    writeFileSync(join(programmeProposals, 'archive', 'old.md'), 'archived');
    return root;
  }

  /**
   * `fresh: 'stale'` — the page at a terminal keeping its own pull requests
   * current: GitHub is asked only when the cache is five minutes old, only
   * for the repositories the runner's backoff does not hold, and what it
   * answers replaces those repositories' entries alone.
   */
  describe("fresh: 'stale'", () => {
    function staleFixture({ age = 3600, held = {} } = {}) {
      const root = workRootFixture();
      const repos = ['memoro', 'memoro-cli'].map((name) => {
        const path = join(root, 'repos', name);
        mkdirSync(join(path, '.git'), { recursive: true });
        return { name, path };
      });
      const gh = [];
      const merged = [];
      const run = (over = {}) => collectPage({
        claudeSettings: () => null,
        env: { MC_WORK_ROOT: root, MC_HOME: root },
        now: NOW,
        repos,
        fresh: 'stale',
        githubState: held,
        exec: async (cmd, args, opts) => {
          if (cmd !== 'gh') return { ok: true, stdout: '' };
          const name = opts.cwd.split('/').at(-1);
          gh.push(name);
          if (over.fails?.includes(name)) return { ok: false, stdout: '' };
          return { ok: true, stdout: JSON.stringify([{ number: name === 'memoro' ? 12901 : 822, headRefName: 'x' }]) };
        },
        run: () => ({ status: 1, stdout: '' }),
        git: () => null,
        checkout: null,
        cache: {
          loadPrs: () => ({ prs: [{ repo: 'memoro', number: 12900 }], fetched: '2026-08-29T11:00:00Z', age_seconds: age }),
          savePrs: () => { throw new Error('savePrs replaces every repository'); },
          mergePrs: ({ repos: answered, prs }) => {
            merged.push({ answered, numbers: prs.map((pr) => pr.number) });
            return { prs, fetched: NOW.toISOString(), age_seconds: 0 };
          },
        },
      });
      return { run, gh, merged };
    }

    it('leaves a cache younger than five minutes alone', async () => {
      const fx = staleFixture({ age: 120 });
      const data = await fx.run();
      assert.deepEqual(fx.gh, []);
      assert.equal(data.caches.prs.asked, false);
      assert.equal(data.caches.prs.age_seconds, 120);
    });

    it('asks every repository for an old cache, and merges what they answer', async () => {
      const fx = staleFixture();
      const data = await fx.run();
      assert.deepEqual(fx.gh.sort(), ['memoro', 'memoro-cli']);
      assert.deepEqual(fx.merged[0].answered.sort(), ['memoro', 'memoro-cli']);
      assert.deepEqual(fx.merged[0].numbers.sort(), [12901, 822].sort());
      assert.equal(data.caches.prs.asked, true);
      assert.equal(data.caches.prs.age_seconds, 0);
    });

    it('does not ask a repository the runner is backing off from', async () => {
      const fx = staleFixture({ held: { memoro: { since: '2026-08-29T11:58:00Z', last: '2026-08-29T11:59:00Z', attempts: 4 } } });
      const data = await fx.run();
      assert.deepEqual(fx.gh, ['memoro-cli']);
      assert.deepEqual(fx.merged[0].answered, ['memoro-cli']);
      assert.ok(data.notes.some((note) => /PRs for memoro from cache/u.test(note)));
    });

    it('keeps the cache when GitHub does not answer, and says so', async () => {
      const fx = staleFixture();
      const data = await fx.run({ fails: ['memoro', 'memoro-cli'] });
      assert.deepEqual(fx.merged, []);
      assert.equal(data.caches.prs.asked, true, 'a failed ask is an ask: the page holds off after it too');
      assert.equal(data.caches.prs.age_seconds, 3600);
      assert.ok(data.notes.some((note) => /gh pr list failed/u.test(note)));
    });
  });

  it('builds every section from the files, offline, without git, gh or tmux', async (t) => {
    const root = workRootFixture();
    // A merge round running on the machine while the suite runs: a live lock
    // under the process's own mc home, which is the real one whenever the
    // merger's MC_HOME reaches the suite. The page reads the home its `env`
    // names and sees none of it (2026-10-10 #13390, 2026-10-11 #13467). A
    // lock already there is a real round — the same case — and stays theirs.
    const lock = gateLockPath(mcHome(), 'memoro');
    let wrote = false;
    try {
      mkdirSync(mcHome(), { recursive: true });
      writeFileSync(lock, JSON.stringify({
        repo: `page-test-${process.pid}-${Date.now()}`, pr: 13467, pid: process.pid, since: '2026-08-29T11:50:00Z',
      }), { flag: 'wx' });
      wrote = true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    t.after(() => { if (wrote) rmSync(lock, { force: true }); });
    const asked = [];
    const data = await collectPage({
      claudeSettings: () => null,
      env: { MC_WORK_ROOT: root, MC_HOME: root },
      now: NOW,
      repos: [],
      exec: async (cmd) => { asked.push(cmd); return { ok: false, stdout: '' }; },
      run: (cmd) => { asked.push(cmd); return { status: 1, stdout: '' }; },
      git: () => null,
      // No checkout of mc's own: the MC line's three reads are another test's.
      checkout: null,
      cache: {
        loadPrs: () => ({ prs: [{ repo: 'memoro-cli', number: 440, headRefName: 'mc-ui' }], fetched: '2026-08-29T10:00:00Z', age_seconds: 7200 }),
        savePrs: () => { throw new Error('savePrs on the offline page'); },
      },
    });
    assert.deepEqual(asked, ['tmux'], 'the default page runs no fetch and no gh');
    assert.deepEqual(data.runner.sessions.map((step) => step.name), ['docx-editor', 'mc-ui'],
      'one current-<repo>.json per lane, and the page reads every one of them');
    assert.equal(data.sessions.desks.manager.verb, 'brief');
    assert.equal(data.runner.day.steps, 3);
    // The row and the cached version, read from the files and nothing fetched.
    assert.equal(data.runner.production.short, '1a2b3c4');
    assert.equal(data.runner.production.live.short, 'b3e65b6');
    assert.equal(data.runner.production.differs, true);
    assert.equal('next' in data, false, 'no project queue');
    // And beside it, `merges.json`: the merger's queue (ruling 30).
    assert.deepEqual(data.merges.queued.items.map((item) => [item.repo, item.pr, item.state]),
      [['memoro-cli', 674, 'queued']]);
    // No gate lock in the home `env` names, so nothing is landing — whatever
    // the process's own home holds.
    assert.equal(data.merges.landing, null);
    assert.equal(data.merges.landings.length, 0);
    assert.equal(data.intake.repos[0].new_errors, 1);
    assert.deepEqual(data.intake.repos[0].loud_lines, [{ message: 'loud', fingerprint: 'abc', count: '41x 500' }]);
    assert.equal(data.intake.proposals, 1);
    assert.equal(data.programmes.programmes.find((group) => group.programme === 'mc').proposals, 2,
      'the programme count includes its direct files, not its archive');
    let json = '';
    await page(['--json'], {
      collect: async () => data,
      stdout: { write: (text) => { json += text; } },
      checkAndPrintFreshInstall: async () => {},
    });
    assert.equal(JSON.parse(json).programmes.programmes.find((group) => group.programme === 'mc').proposals, 2,
      'mc --json carries the same programme count');
    assert.deepEqual(data.programmes.programmes.flatMap((g) => g.goals).map((goal) => [goal.programme, goal.name, goal.status]), [['mc', 'mc-ui', 'ready']]);
    assert.equal(data.prs.items.find((pr) => pr.number === 440).branch, 'mc-ui');
    assert.equal('no_workarea' in data.programmes, false);
    assert.equal('unplanned' in data.programmes, false);
    assert.equal('work' in data, false);
    assert.equal(data.caches.fresh, false);
    assert.equal(data.caches.prs.age_seconds, 7200);
    // The whole page renders from it without throwing.
    assert.match(renderPage(data, { columns: 100, now: NOW }), /PROGRAMMES/u);
  });

  it('collects repository pauses, merger liveness and landed PR history from the supplied homes', async (t) => {
    const root = workRootFixture();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const repos = ['memoro', 'memoro-cli'].map((name) => {
      const path = join(root, 'repos', name);
      mkdirSync(join(path, '.git'), { recursive: true });
      return { name, path };
    });
    writeFileSync(join(root, 'runner', 'merger.json'), JSON.stringify({ pid: process.pid }));
    writeFileSync(gateLockPath(root, 'memoro'), JSON.stringify({ pid: process.pid, mode: 'check' }));
    writeFileSync(join(root, 'gate-rounds.jsonl'), JSON.stringify({
      schema: 'mc-gate-round', phase: 'end', repo: 'memoro-cli.git', at: '2026-08-29T09:59:00Z', duration_ms: 60000, merged: [673],
    }) + '\n');
    const input = {
      claudeSettings: () => null, env: { MC_WORK_ROOT: root, MC_HOME: root }, repos, now: NOW, offline: true, checkout: null,
      exec: async () => ({ ok: false, stdout: '' }), run: () => ({ status: 1, stdout: '' }), git: () => null,
      cache: { loadPrs: () => ({ prs: [] }) },
    };
    const data = await collectPage(input);
    assert.equal(data.merges.repos[0].pause.kind, 'gate');
    assert.equal(data.merges.repos[0].landing, null, 'a check round is not a landing');
    assert.equal(data.merges.landings[0].mode, 'check', 'legacy status readers still see the measurement');
    assert.equal(data.merges.repos[1].day_count, 1);
    assert.deepEqual(data.merges.repos[1].last, { pr: 673, at: '2026-08-29T10:00:00.000Z', age_seconds: 7200 });
    assert.equal(data.merges.repos[1].merger_stopped, false);
    rmSync(join(root, 'runner', 'merger.json'));
    const stopped = await collectPage(input);
    assert.equal(stopped.merges.repos[1].merger_stopped, true);
  });

  it('--fresh fetches, asks GitHub and refills the PR cache', async () => {
    const root = workRootFixture();
    const asked = [];
    let saved = null;
    let fields = null;
    const data = await collectPage({
      claudeSettings: () => null,
      env: { MC_WORK_ROOT: root, MC_HOME: root },
      now: NOW,
      repos: [{ name: 'memoro-cli', path: process.cwd() }],
      fresh: true,
      exec: async (cmd, args) => {
        asked.push(`${cmd} ${args[0] === '-C' ? args[2] : args[0]}`);
        if (cmd === 'gh') fields = args[args.indexOf('--json') + 1];
        return { ok: true, stdout: cmd === 'gh' ? '[{"number":440,"headRefName":"mc-ui","baseRefName":"main","isDraft":false,"title":"The page"}]' : '' };
      },
      run: () => ({ status: 1, stdout: '' }),
      cache: {
        loadPrs: () => { throw new Error('loadPrs under --fresh'); },
        savePrs: ({ prs }) => { saved = prs; return { prs, fetched: '2026-08-29T12:00:00Z', age_seconds: 0 }; },
      },
    });
    assert.deepEqual(asked.sort(), ['gh pr', 'git fetch']);
    // The base and the draft flag ride along with the number: the round asks
    // the same question, and a stack is ordered by what each PR is based on.
    assert.equal(fields, 'number,headRefName,baseRefName,isDraft,title,updatedAt');
    assert.deepEqual(saved, [{ repo: 'memoro-cli', number: 440, headRefName: 'mc-ui', baseRefName: 'main', isDraft: false, title: 'The page' }]);
    assert.equal(data.caches.fresh, true);
    assert.equal(data.prs.items[0].number, 440);
  });

  /** Ruling 20: every ordinary page fetches `origin/main` first. */
  it('fetches origin for every present repository, unless --offline', async () => {
    const root = workRootFixture();
    const calls = [];
    const repos = [
      { name: 'memoro-cli', path: join(root, 'mc-ui', 'memoro-cli') },
      { name: 'memoro', path: join(root, 'docx-editor', 'memoro-cli') },
    ];
    const data = await collectPage({
      claudeSettings: () => null,
      env: { MC_WORK_ROOT: root, MC_HOME: root },
      now: NOW,
      repos,
      exec: async (cmd, args) => { calls.push([cmd, ...args].join(' ')); return { ok: true, stdout: '' }; },
      run: () => ({ status: 1, stdout: '' }),
      git: () => null,
      cache: {
        loadPrs: () => ({ prs: [], fetched: null, age_seconds: null }),
      },
    });
    assert.deepEqual(calls.sort(), [
      `git -C ${join(root, 'docx-editor', 'memoro-cli')} fetch -q origin`,
      `git -C ${join(root, 'mc-ui', 'memoro-cli')} fetch -q origin`,
    ]);
    assert.equal(data.caches.fetched, true);
  });

  it('--offline skips the fetch entirely', async () => {
    const root = workRootFixture();
    const calls = [];
    const repos = [{ name: 'memoro-cli', path: join(root, 'mc-ui', 'memoro-cli') }];
    const data = await collectPage({
      claudeSettings: () => null,
      env: { MC_WORK_ROOT: root, MC_HOME: root },
      now: NOW,
      repos,
      offline: true,
      exec: async (cmd, args) => { calls.push([cmd, ...args].join(' ')); return { ok: true, stdout: '' }; },
      run: () => ({ status: 1, stdout: '' }),
      git: () => null,
      cache: {
        loadPrs: () => ({ prs: [], fetched: null, age_seconds: null }),
      },
    });
    assert.deepEqual(calls, [], 'offline asks git nothing');
    assert.equal(data.caches.offline, true);
    assert.equal(data.caches.fetched, false);
  });
});

/* ------------------------------------------------------------- the palette */

const NAMES = {
  0: 'reset', 1: 'bold', 2: 'dim', 31: 'red', 32: 'green', 33: 'yellow', 34: 'blue', 35: 'magenta', 36: 'cyan', 37: 'white', 90: 'grey',
};
const ESC = String.fromCharCode(27);
const SGR = new RegExp(`${ESC}\\[([0-9;]*)m`, 'gu');
const strip = (line) => line.replace(SGR, '');

/**
 * A row's colours in order — `bold grey` for a painted name followed by a
 * painted count. The palette is a table, and this is how a test reads one
 * row of it back without pinning the escape bytes themselves.
 *
 * Primary text carries no escape at all (it is the terminal's own foreground),
 * so it leaves no run here: a row's signature is what the page painted *on
 * top of* the text, and a cell that vanishes from a signature is a cell that
 * went back to being read rather than coloured.
 */
function signature(line) {
  const out = [];
  let run = [];
  for (const match of line.matchAll(SGR)) {
    const name = NAMES[Number(match[1])];
    if (name === 'reset') { if (run.length) out.push(run.join('+')); run = []; continue; }
    if (name) run.push(name);
  }
  return out.join(' ');
}

/** The one row whose text contains `text`, painted. */
function rowWith(lines, text) {
  const found = lines.filter((line) => strip(line).includes(text));
  assert.equal(found.length, 1, `one row saying "${text}", found ${found.length}`);
  return found[0];
}

const paintedPage = (data, over = {}) => renderPageLines(data, {
  columns: 120, colour: true, version: '0.7.11', now: NOW, ...over,
});

describe('MC', () => {
  const draw = (mc, columns = 120) => rowWith(renderPageLines(pageData({ mc }), { columns, version: '0.7.11', now: NOW }), '  MC  ');
  const UP = { alive: true, up_seconds: 7200 };

  it('names hook drift and the verb that mends it', () => {
    assert.match(draw(mcSection({ process: UP, commit: 'abc1234', behind: 0, hooks: 'pre-tool on Bash|Write, want Bash|Write|Read', now: NOW }), 200), /^ {2}MC {2}0\.7\.11 · up to date · hooks: pre-tool on Bash\|Write, want Bash\|Write\|Read · mc hook install · runner up 120 min · on abc1234$/u);
    assert.equal('hooks' in mcSection({ process: UP, now: NOW }), false);
  });

  it('counts what origin/main has that the runner does not, from the runner\'s own commit', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-page-mc-'));
    mkdirSync(join(root, 'runner'), { recursive: true });
    writeFileSync(join(root, 'runner', 'runner.json'), JSON.stringify({ pid: 4242, started: '2026-08-29T10:00:00Z', commit: 'abc1234' }));
    writeFileSync(join(root, 'runner', 'UPDATE'), '2026-08-29T11:48:00.000Z\n');
    const asked = [];
    const data = await collectPage({
      claudeSettings: () => ({ hooks: {} }),
      env: { MC_WORK_ROOT: root, MC_HOME: root }, now: NOW, repos: [], offline: true, alive: live,
      run: () => ({ status: 1, stdout: '' }),
      checkout: '/code/memoro-cli',
      git: (cwd, args) => {
        if (cwd !== '/code/memoro-cli') return null;
        asked.push(args.join(' '));
        if (args[0] === 'rev-list') return '3';
        return args.at(-1) === 'HEAD' ? 'fff0000' : 'def5678';
      },
      cache: { loadPrs: () => ({ prs: [], fetched: null, age_seconds: null }), savePrs: () => ({}) },
    });
    // Measured from the commit the runner started on, not from the checkout's
    // HEAD: a checkout pulled by hand is new, and the runner beside it is not.
    assert.ok(asked.includes('rev-list --count abc1234..origin/main'), asked.join(' | '));
    assert.equal(data.mc.hooks, 'session-start not registered, pre-tool not registered, stop not registered');
    delete data.mc.hooks;
    assert.deepEqual(data.mc, {
      up_seconds: 7200, commit: 'abc1234', head: 'fff0000', main: 'def5678', behind: 3,
      update_requested: { at: '2026-08-29T11:48:00.000Z', age_seconds: 720, in_flight: [], lanes: 2 },
    });
  });

  it('says an update is available, that one was asked for, or that there is nothing to do', () => {
    assert.match(draw(mcSection({ process: UP, commit: 'abc1234', main: 'def5678', behind: 1, now: NOW })),
      /^ {2}MC {2}0\.7\.11 · update available — origin\/main def5678 is 1 commit ahead · mc run --update · runner up 120 min/u);
    // Asked for wins over available: the second is true until the handover, and
    // the first is the news.
    assert.match(draw(mcSection({ process: UP, commit: 'abc1234', behind: 1, updateText: '2026-08-29T11:48:00Z\n', now: NOW }), 200),
      /^ {2}MC {2}0\.7\.11 · draining since \d\d:\d\d \(12 min\) — nothing in flight, the handover comes at the next pick · runner up 120 min · on abc1234$/u);
    assert.match(draw(mcSection({ process: UP, commit: 'abc1234', behind: 0, now: NOW })),
      /^ {2}MC {2}0\.7\.11 · up to date · runner up 120 min · on abc1234$/u);
    // Nothing known is nothing said: an install with no checkout has no
    // origin/main to be behind.
    assert.match(draw(mcSection({ process: null, now: NOW })), /^ {2}MC {2}0\.7\.11 · runner not running$/u);
    // A narrow terminal keeps the state and loses the sentence.
    assert.match(draw(mcSection({ process: UP, behind: 4, main: 'def5678', now: NOW }), 60), /^ {2}MC {2}0\.7\.11 · update available · runner up 120 min$/u);
  });

  // The same line `mc run --update` prints (run-control.js `drainLine`), from
  // the same files: the lane a drain waits on, and for how long.
  it('says what a drain waits on, by lane and elapsed time', () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-page-drain-'));
    const dir = join(root, 'runner');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'UPDATE'), '2026-08-29T11:48:00.000Z\n');
    writeFileSync(join(dir, 'current-memoro-4.json'), JSON.stringify({ name: 'gmail-ready', step: 1, started: '2026-08-29T11:46:00Z' }));
    const drain = drainState({ paths: controlPaths(root), read: (path) => { try { return readFileSync(path, 'utf8'); } catch { return null; } }, list: readdirSync, now: NOW, lanes: 6 });
    const line = draw(mcSection({ process: UP, commit: 'abc1234', behind: 1, updateText: '2026-08-29T11:48:00Z\n', drain, now: NOW }), 200);
    assert.match(line, /^ {2}MC {2}0\.7\.11 · draining since \d\d:\d\d \(12 min\) — waiting on gmail-ready step 1 \(memoro#5, 14 min\); 5 lanes done · runner up 120 min · on abc1234$/u);
    assert.ok(line.includes(drainLine(drain)), 'the page draws the verb\'s own line');
  });

  it('a merger behind the checkout is named on the MC line', () => {
    const behind = draw({ commit: 'abc1234', head: 'def5678', behind: 0, behind_checkout: [{ name: 'merger', pid: 95259, commit: '3b51ff90' }] }, 200);
    assert.ok(behind.includes('merger pid 95259 on 3b51ff90 · checkout def5678'), behind);
    assert.ok(!draw({ commit: 'abc1234', head: 'def5678', behind: 0, behind_checkout: [] }, 200).includes('merger pid'));
    // A process on the checkout's own commit, in a longer spelling, is not behind.
    assert.deepEqual(mcSection({
      head: 'def5678', processes: [{ name: 'merger', pid: 1, commit: 'def5678aa' }, { name: 'repo watch', pid: 2, commit: '3b51ff90' }],
    }).behind_checkout, [{ name: 'repo watch', pid: 2, commit: '3b51ff90' }]);
  });

  it('gives the live loop a key that moves with a goal and not with a clock', () => {
    const key = (over) => pageKey(pageData({ programmes: programmesSection({ goalRows: GOALS, ...over }) }));
    assert.notEqual(key({}), key({ priority: () => 10 }), 'a priority change refreshes programme headings');
    assert.equal(key({}), key({ planning: { mc: { age_seconds: 60 } } }), 'a planning session getting older is not news');
    assert.notEqual(key({}), key({ goalRows: GOALS.map((goal) => ({ ...goal, running: true })) }), 'a goal the runner took is');
    assert.notEqual(key({}), key({ goalRows: GOALS.map((goal) => ({ ...goal, stage: 'review', state: 'review' })) }), 'a goal that moved is');
    assert.notEqual(key({}), key({ goalRows: GOALS.map((goal) => ({ ...goal, phase: 2 })) }), 'a phase move refreshes the tree');
    assert.notEqual(key({}), key({ goalRows: GOALS.map((goal) => ({ ...goal, title: 'New title' })) }), 'a title change refreshes the tree');
    const activity = (over = {}) => pageKey(pageData({ runner: { sessions: [{ goal: 'mc/one', kind: 'build', pid: 7,
      started: '2026-11-05T08:00:00Z', elapsed_seconds: 60, ...over }] } }));
    assert.equal(activity(), activity({ elapsed_seconds: 120 }), 'clock ticks do not reprint off-screen work');
    assert.notEqual(activity(), activity({ started: '2026-11-05T09:00:00Z' }), 'a replacement session is visible');
    assert.notEqual(activity(), activity({ check_ins: 1 }), 'a check-in is visible even off-screen');
    assert.equal(pageKey({}), '');
    assert.notEqual(pageKey({ providerPriority: 'codex' }), pageKey({ providerPriority: 'claude' }));
  });
});

describe('the palette', () => {
  // One line of the page per row, and the colours it carries. The text beside
  // each is what that row says at 120 columns; the plain page below is the
  // same page with the escapes taken out again.
  //
  // A name with no run against it is not an unpainted row: it is a name drawn
  // in the terminal's own foreground, which is what primary text is here. Every
  // Secondary information now uses ANSI white instead of dark grey; primary
  // text retains the terminal foreground and no row uses dim.


  it('paints nothing with the dim attribute, anywhere on the page', () => {
    // The palette's own floor: `ESC[2m` sat at or below the background on
    // Martin's terminal, so a row that carried it was a row nobody could read.
    for (const [index, line] of paintedPage(DATA).entries()) {
      assert.ok(!signature(line).split(' ').some((run) => run.split('+').includes('dim')),
        `row ${index} is drawn dim: ${strip(line)}`);
    }
  });

  it('paints every row of the page, and the same colour for the same meaning', () => {
    const lines = paintedPage(DATA);
    assert.ok(lines.some((line) => /\x1b\[31mMartin/u.test(line)));
    assert.ok(lines.some((line) => /\x1b\[32mready/u.test(line)));
    assert.match(rowWith(lines, 'PROGRAMMES'), /\x1b\[[0-9;]*36mPROGRAMMES/u);
    assert.ok(lines.some((line) => /^  ┌─ mc /u.test(strip(line))), 'programme boundary stays visible');
  });

  it('adds every escape outside the width: a coloured row is as wide as its plain twin', () => {
    for (const columns of [60, 80, 100, 120, 160]) {
      const wide = Math.max(60, Math.min(columns, 160));
      const plain = renderPageLines(DATA, { columns, version: '0.7.11', now: NOW });
      const painted = paintedPage(DATA, { columns });
      assert.equal(painted.length, plain.length, `${columns} columns: a different number of rows`);
      for (const [index, line] of painted.entries()) {
        assert.equal(strip(line), plain[index], `${columns} columns, row ${index}: the text moved`);
        assert.equal(width(line), width(plain[index]), `${columns} columns, row ${index}: a different width`);
        assert.ok(width(line) <= wide, `${columns} columns, row ${index}: over the margin`);
        // No clip ever cut an escape in half: every ESC still starts a whole
        // SGR sequence.
        const halves = line.split(ESC).slice(1).filter((part) => !/^\[[0-9;]*m/u.test(part));
        assert.deepEqual(halves, [], `${columns} columns, row ${index}: a cut escape`);
      }
    }
  });

  it('leaves the plain page exactly as it was: NO_COLOR and a pipe carry no escapes', () => {
    const plain = renderPage(DATA, { columns: 120, version: '0.7.11', now: NOW });
    assert.ok(!plain.includes(ESC), 'a page that is not a terminal carries no escapes');
    // What `NO_COLOR=1 mc` prints is the plain render, decided before a single
    // escape is chosen.
    assert.equal(colourFor({ isTTY: true }, { NO_COLOR: '1' }), false);
    assert.equal(renderPage(DATA, {
      columns: 120, version: '0.7.11', now: NOW, colour: colourFor({ isTTY: true }, { NO_COLOR: '1' }),
    }), plain);
  });

  it('--json carries no colour, terminal or not', async () => {
    let out = '';
    const code = await page(['--json'], {
      collect: async () => DATA,
      stdout: { isTTY: true, columns: 120, write: (s) => { out += s; } },
      env: {},
      checkAndPrintFreshInstall: async () => {},
    });
    assert.equal(code, 0);
    assert.ok(!out.includes(ESC), '--json is bytes for a program, never for an eye');
    assert.deepEqual(Object.keys(JSON.parse(out)), ['runner', 'sessions', 'merges', 'intake', 'programmes', 'language', 'caches', 'notes']);
  });

  it('gives a session kind one colour wherever a kind is printed', () => {
    // The runner's three kinds, `step` as the build it was before, and the
    // foreground verbs a lane file could name.
    for (const [kind, tone] of [['build', 'green'], ['step', 'green'], ['review', 'magenta'], ['plan', 'blue'], ['triage', 'blue'], ['brief', 'cyan']]) {
      const data = pageData({
        runner: runnerSection({
          runner: { pid: 4242, started: '2026-08-29T11:00:00Z' },
          currents: [{
            name: 'thing', kind, repo: 'memoro-cli', tool: 'claude', model: 'opus', check_in_minutes: 60, check_ins: 0,
            started: '2026-08-29T11:40:00Z', pid: 4242,
          }],
          now: NOW,
          alive: live,
        }),
      });
      const lines = paintedPage(data);
      const label = kind === 'step' ? 'BUILD' : kind.toUpperCase();
      const code = { green: 32, magenta: 35, blue: 34, cyan: 36 }[tone];
      assert.ok(rowWith(lines, label).includes(`\x1b[${code}m${label}\x1b[0m`), `activity says ${kind} in ${tone}`);
    }
  });


  it('turns the clock yellow past its first check-in, and never red', () => {
    const stepAt = (spent, checkIns = 0) => pageData({
      runner: runnerSection({
        runner: { pid: 4242, started: '2026-08-29T10:00:00Z' },
        currents: [{
          name: 'thing', kind: 'step', repo: 'memoro-cli', tool: 'claude', model: 'opus', check_in_minutes: 60, check_ins: checkIns,
          started: new Date(NOW.getTime() - spent * 1000).toISOString(), pid: 4242,
        }],
        now: NOW,
        alive: live,
      }),
    });
    const row = (spent, checkIns) => rowWith(paintedPage(stepAt(spent, checkIns)), 'BUILD');
    assert.doesNotMatch(row(600), /\x1b\[33m/u);
    assert.match(strip(row(47 * 60)), /47 min/u);
    assert.match(row(3600), /\x1b\[33m60 min/u);
    assert.match(row(600, 1), /\x1b\[33m10 min/u);
    assert.match(paintedPage(stepAt(600, 1)).map(strip).join('\n'), /1 check-in/u);
    assert.doesNotMatch(row(10 * 3600, 10), /\x1b\[31m|over budget/u);
  });

  it('says a quota answer in yellow while it is recent, and in grey once it is history', () => {
    const quota = (last) => {
      const rows = [{
        ts: last, name: 'thing', kind: 'step', exit: '1', seconds: '10', pr: '-', note: 'quota,timeout',
      }];
      const lines = paintedPage(pageData({ runner: runnerSection({ rows, now: NOW, alive: () => false }) }));
      return signature(rowWith(lines, 'quota: 1 answer(s)'));
    };
    assert.equal(quota('2026-08-29T11:00:00Z'), 'yellow', 'an hour ago is why the runner is idle');
    assert.equal(quota('2026-08-29T02:00:00Z'), 'white', 'ten hours ago is history');
  });

  // The two tables in `docs/technical/mc-ui.md` are the palette written down;
  // a colour changed in one place and not the other is a doc that lies, which
  // is worse than no doc at all. They are read against the tables the page
  // paints with (page-grid.js), not against the source's text.
  it('says the same colours in docs/technical/mc-ui.md as page-grid.js does', () => {
    const doc = readFileSync(new URL('../../docs/technical/mc-ui.md', import.meta.url), 'utf8');
    const inCode = (table) => Object.fromEntries(Object.entries(table).map(([key, styles]) => [key, styles.join(' ')]));
    const inDoc = (heading) => Object.fromEntries(
      [...new RegExp(`\\| ${heading} \\| colour \\|\\n\\|---\\|---\\|\\n([\\s\\S]*?)\\n\\n`, 'u').exec(doc)[1]
        .matchAll(/^\| `([\w-]+)` \| (.+?) \|$/gmu)].map(([, key, tone]) => [key, tone]),
    );
    assert.deepEqual(inDoc('kind'), inCode(KIND_TONE), 'the doc names another colour for a kind');
    assert.deepEqual(inDoc('state'), inCode(STATE_TONE), 'the doc names another colour for a state');
    // The two fallbacks are rows of their own in the doc, and they are the
    // colours `kindTone` and `stateTone` reach for when the table has no key.
    assert.ok(/\| any other kind \| grey \|/u.test(doc));
    assert.ok(/\| any other state, or none \| grey \|/u.test(doc));
    // And no row of any table in the document names a colour the page has
    // stopped drawing. The prose above them may still explain what `dim grey`
    // and `white` were; a table row saying so would be a table that lies.
    for (const line of doc.split('\n').filter((l) => l.startsWith('|'))) {
      assert.ok(!/\b(dim|white)\b/u.test(line), `a palette row still says dim or white: ${line}`);
    }
    assert.deepEqual(signature(rowWith(paintedPage(pageData({
      programmes: programmesSection({ strays: [{ name: 'jobbet', checkout: false, uncommitted: 0 }] }),
    })), 'jobbet')).split(' '), ['bold', 'white'],
    'a stray is its name and its facts in grey');
  });

  it('says nothing about a watch in the header — there is none', () => {
    assert.ok(!strip(paintedPage(DATA)[1]).includes('watch'));
  });
});

describe('CHECKS — the daily full test and deps, per repository', () => {
  const checks = checksSection({
    now: NOW,
    repos: [
      {
        name: 'memoro',
        nightly: { measured: { at: new Date(NOW.getTime() - 4 * 3600_000).toISOString(), commit: 'bc82e81aaaa', red: 2 } },
        deps: { read_at: new Date(NOW.getTime() - 40 * 3600_000).toISOString(), sha: '03d63ddbbbb', audit: { counts: { critical: 0, high: 12 } } },
      },
      { name: 'memoro-cli', nightly: { measured: null }, deps: null },
    ],
  });

  it('keeps when, of which commit, and what each reading found — null when it never ran', () => {
    assert.deepEqual(checks.repos[0].test, { at: checks.repos[0].test.at, age_seconds: 4 * 3600, short: 'bc82e81', red: 2 });
    assert.deepEqual({ ...checks.repos[0].deps, at: null }, { at: null, age_seconds: 40 * 3600, short: '03d63dd', critical: 0, high: 12, moderate: 0, low: 0 });
    assert.deepEqual(checks.repos[1], { repo: 'memoro-cli', test: null, deps: null });
  });

  it('draws one row per repository, above the MC line', () => {
    const lines = renderPageLines(pageData({ checks }), { columns: 120 }).map(strip);
    const at = lines.indexOf('    ● memoro');
    assert.ok(at > 0);
    assert.match(lines[at + 2], /full test 4 h · bc82e81 · 2 red/u);
    assert.match(lines[at + 3], /deps 40 h · 03d63dd/u);
    assert.match(lines[at + 4], /0 critical · 12 high/u);
    const cli = lines.indexOf('    ● memoro-cli');
    assert.match(lines[cli + 2], /full test never run/u);
    assert.match(lines[cli + 3], /deps never read/u);
    assert.ok(cli < lines.findIndex(line => line.startsWith('  ── SYSTEM ')));
  });
});

describe('PULL REQUESTS', () => {
  const PRS = [
    { repo: 'memoro', number: 12314, headRefName: 'docx-simple-toolbar-6', title: 'docx-simple-toolbar 4: G4 walk', updatedAt: '2026-09-29T12:00:00Z' },
    { repo: 'memoro', number: 13048, headRefName: 'goal/one-operation', title: 'one-operation: close-out', updatedAt: '2026-10-09T11:00:00Z' },
    { repo: 'memoro', number: 13167, headRefName: 'plan/trip-project-detail', title: 'Plan: trip-project-detail', updatedAt: '2026-10-09T04:00:00Z' },
    { repo: 'memoro', number: 12900, headRefName: 'remove-bookshop-recipes', title: 'Remove the Adlibris and Bokus site recipes', updatedAt: '2026-10-07T19:00:00Z' },
  ];
  const AT = new Date('2026-10-09T19:00:00Z');
  const worktrees = { memoro: [{ path: '/Users/m/mc/plan/entity-detail/memoro', branch: 'plan/trip-project-detail' }] };
  const build = () => {
    const pulls = prsSection({
      prs: PRS, worktrees, root: '/Users/m/mc', fetched: AT.toISOString(), ageSeconds: 60, now: AT,
    });
    const runner = runnerSection({ rows: [], now: AT, alive: () => false });
    runner.sessions = [{ name: 'goal:p/one-operation', repo: 'memoro', kind: 'build', variant: 'goal', goal: 'p/one-operation', elapsed_seconds: 300, tool: 'claude', model: 'opus' }];
    runner.lanes = [{ number: 1, repo: 'memoro', session: runner.sessions[0] }];
    attachPrs({ runner, pulls });
    return { pulls, runner };
  };

  it('says whose each pull request is, and how long it has been quiet', () => {
    const { pulls } = build();
    assert.equal(pulls.count, 4);
    assert.deepEqual(pulls.counts, { none: 3, plan: 1 });
    const by = Object.fromEntries(pulls.items.map((item) => [item.number, item]));
    assert.equal(by[12314].owner.kind, 'none');
    assert.equal('step' in by[12314], false, 'no pull request is a project step');
    assert.equal(by[12314].quiet_seconds, 10 * 86400 + 7 * 3600);
    assert.deepEqual(by[13167].owner, { kind: 'plan', name: 'entity-detail', path: '/Users/m/mc/plan/entity-detail/memoro' });
    assert.equal(by[12900].owner.kind, 'none');
  });

  it('a plan session in layout 2, under programs/, is its programme\'s too', () => {
    const path = '/Users/m/mc/programs/entity-detail/memoro';
    const pulls = prsSection({
      prs: PRS, worktrees: { memoro: [{ path, branch: 'plan/trip-project-detail' }] },
      root: '/Users/m/mc', fetched: AT.toISOString(), ageSeconds: 60, now: AT,
    });
    const item = pulls.items.find((pr) => pr.number === 13167);
    assert.deepEqual(item.owner, { kind: 'plan', name: 'entity-detail', path });
  });

  it('marks the one the merger is landing and the ones it has queued', () => {
    const pulls = prsSection({
      prs: PRS,
      merges: { landing: { repo: 'memoro', pr: 13048 }, queued: { items: [{ repo: 'memoro', pr: 12900 }] } },
      now: AT,
    });
    const by = Object.fromEntries(pulls.items.map((item) => [item.number, item.merging]));
    assert.deepEqual(by, { 13167: null, 13048: 'landing', 12900: 'queued', 12314: null });
  });

  it('puts a goal\'s pull request on its running lane, by the goal\'s branch', () => {
    const { pulls, runner } = build();
    assert.deepEqual(runner.sessions[0].prs.map((pr) => pr.number), [13048]);
    const lines = renderPageLines(pageData({ runner, prs: pulls }), { columns: 120, now: AT });
    assert.ok(lines.some((line) => /p\/one-operation · 5 min · claude · opus/u.test(line)), lines.join('\n'));
    assert.ok(lines.some((line) => line.includes('memoro#13048')));
    assert.equal(lines.filter(line => line.includes('#13048')).length, 1, 'session PR is not repeated among loose PRs');
  });

  it('lists every one the merger does not draw, the one nobody holds in yellow with the waiting mark', () => {
    const { pulls, runner } = build();
    const lines = renderPageLines(pageData({ runner, prs: pulls }), { columns: 140, now: AT });
    assert.ok(lines.some((line) => /3 open · 1 plan · 2 nobody's · mc prs$/u.test(line)), lines.join('\n'));
    assert.ok(lines.some((line) => /^ {4}· memoro {6}#13167 {2}Plan: trip-project-detail +plan entity-detail · quiet 15 h$/u.test(line)), lines.join('\n'));
    assert.ok(lines.some((line) => /^ {4}◆ memoro {6}#12900 {2}Remove the Adlibris and Bokus site recipes +nobody's · quiet 2 d$/u.test(line)), lines.join('\n'));
    const painted = renderPageLines(pageData({ runner, prs: pulls }), { columns: 140, colour: true, now: AT });
    const nobody = painted.find((line) => line.includes('#12900'));
    assert.ok(nobody.includes('\u001b[33m◆'), nobody);
  });

  it('mc prs: every one of them, grouped by whose it is', async () => {
    const { pulls } = build();
    let out = '';
    const { run } = await import('../../src/mc/commands/prs.js');
    const code = await run(['--offline'], {
      stdout: { write: (text) => { out += text; }, columns: 120 },
      env: { NO_COLOR: '1' },
      collect: async () => ({ prs: pulls, notes: [] }),
    });
    assert.equal(code, 0);
    const order = ['PLAN SESSIONS  1', "NOBODY'S  3"].map((head) => out.indexOf(head));
    assert.ok(order.every((n, i) => n > 0 && (i === 0 || n > order[i - 1])), out);
    assert.doesNotMatch(out, /ON A STEP/u);
  });
});
