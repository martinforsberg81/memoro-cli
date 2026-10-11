/**
 * The language run record: one JSON file per run under the throwaway
 * MC_WORK_ROOT, read back by the deploy, the page and `resume`.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, it } from 'node:test';

import {
  actEnd, actStart, closeAbandoned, doneExecutes, endRun, lastRun, liveRun, openGap, readRuns, runAlive, runsDir,
  startRun,
} from '../../src/mc/language-runs.js';

let env;

beforeEach(() => {
  env = { MC_WORK_ROOT: mkdtempSync(join(tmpdir(), 'mc-language-runs-')) };
});

const GAP = { until: 'sync-forms', says: 'production has no forms until sync-forms writes them' };

function wrote(run, id, { opens_gap = null, outcome = 'done' } = {}) {
  actEnd(run, actStart(run, { id, phase: 'execute', opens_gap }, env), { outcome }, env);
}

describe('language-runs', () => {
  it('writes the run before anything starts, and every act row as it changes', () => {
    const run = startRun({ manifest: 'sv-forms', lang: 'sv', sha: 'abc', pid: 4242, started: '2026-10-10T08:00:00.000Z' }, env);
    assert.deepEqual(readdirSync(runsDir(env)), ['2026-10-10T08-00-00-000Z-sv-forms.json']);
    const row = actStart(run, { id: 'purge', phase: 'execute' }, env);
    assert.equal(readRuns(env)[0].acts[0].outcome, 'running', 'running before the child starts');
    actEnd(run, row, { outcome: 'done', observed: { remaining: 0 } }, env);
    endRun(run, { outcome: 'done' }, env);
    const [back] = readRuns(env);
    assert.equal(back.outcome, 'done');
    assert.deepEqual(back.acts[0].observed, { remaining: 0 });
    assert.ok(back.ended);
  });

  it('a run is alive while running, unended, and its process is there', () => {
    const run = startRun({ manifest: 'sv-forms', lang: 'sv', pid: 4242 }, env);
    assert.equal(runAlive(run, { alive: () => true }), true);
    assert.equal(runAlive(run, { alive: () => false }), false);
    assert.equal(liveRun(env, { alive: (pid) => pid === 4242 }).manifest, 'sv-forms');
    endRun(run, { outcome: 'stopped' }, env);
    assert.equal(liveRun(env, { alive: () => true }), null);
  });

  it('closeAbandoned marks a dead running run failed, its running act with it, and leaves a live one', () => {
    const dead = startRun({ manifest: 'a', lang: 'sv', pid: 1111, started: '2026-10-10T08:00:00.000Z' }, env);
    actStart(dead, { id: 'purge', phase: 'execute' }, env);
    startRun({ manifest: 'b', lang: 'sv', pid: 2222, started: '2026-10-10T09:00:00.000Z' }, env);
    const closed = closeAbandoned({ alive: (pid) => pid === 2222 }, env);
    assert.deepEqual(closed.map((run) => run.manifest), ['a']);
    const [a, b] = readRuns(env);
    assert.equal(a.outcome, 'failed');
    assert.match(a.note, /never came back/u);
    assert.equal(a.acts[0].outcome, 'failed');
    assert.equal(b.outcome, 'running');
  });

  it('lastRun is the newest, of a manifest when named', () => {
    startRun({ manifest: 'a', lang: 'sv', started: '2026-10-10T08:00:00.000Z' }, env);
    startRun({ manifest: 'b', lang: 'sv', started: '2026-10-10T09:00:00.000Z' }, env);
    assert.equal(lastRun(env).manifest, 'b');
    assert.equal(lastRun(env, { manifest: 'a' }).manifest, 'a');
    assert.equal(lastRun(env, { manifest: 'c' }), null);
  });

  it('openGap is a done opens_gap act whose until has not been written, across a resume', () => {
    const first = startRun({ manifest: 'sv-forms', lang: 'sv', started: '2026-10-10T08:00:00.000Z' }, env);
    wrote(first, 'ingest');
    assert.equal(openGap(env), null);
    wrote(first, 'purge', { opens_gap: GAP });
    endRun(first, { outcome: 'stopped' }, env);
    const gap = openGap(env);
    assert.equal(gap.act, 'purge');
    assert.equal(gap.says, GAP.says);
    assert.equal(gap.run.started, first.started);

    // A dry run writes nothing and does not hide the gap.
    endRun(startRun({ manifest: 'sv-forms', lang: 'sv', dryRun: true, started: '2026-10-10T08:30:00.000Z' }, env), { outcome: 'done' }, env);
    assert.equal(openGap(env).act, 'purge');

    const resumed = startRun({ manifest: 'sv-forms', lang: 'sv', resumes: first.started, started: '2026-10-10T09:00:00.000Z' }, env);
    assert.deepEqual([...doneExecutes(resumed, readRuns(env))].sort(), ['ingest', 'purge']);
    wrote(resumed, 'sync-forms');
    assert.equal(openGap(env), null);
  });
});

/**
 * The runner never calls `mc language` and no role tells a session to: it is
 * Martin's verb, like `mc deploy`. Only the verb, its help and its record name it.
 */
describe('mc language is Martin\'s verb', () => {
  it('no source but the verb and its help, and no role, names a language run', () => {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    // The page and `mc deploy --dry-run` name `promote` and `resume` as the
    // verb Martin types next, as the help does; neither runs it.
    const allowed = new Set([
      'src/mc/commands/language.js', 'src/mc/help-text.js', 'src/mc/language-runs.js',
      'src/mc/page-render.js', 'src/mc/commands/deploy.js',
    ]);
    const files = execFileSync('git', ['ls-files', 'src', 'canon'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
    const naming = files.filter((file) => !allowed.has(file)
      && /\bmc language (run|resume|promote)\b|\['language',/u.test(readFileSync(join(root, file), 'utf8')));
    assert.deepEqual(naming, []);
  });
});
