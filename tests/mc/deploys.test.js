/**
 * `deploys.tsv` — the record `mc deploy` leaves, read and written.
 *
 * Everything here runs against a real file in a throwaway work root, because
 * the file *is* the mechanism: what a test of a faked writer would prove is
 * that the fake was called.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEPLOYS_HEADER, deploysPath, lastAttempt, lastDeploy, parseDeploys,
  readDeploys, recordEnd, recordRefusal, recordStart,
} from '../../src/mc/deploys.js';

const SHA = '1a2b3c4d5e6f70819293a4b5c6d7e8f900112233';
const OLD = '9f8e7d6c5b4a39281706f5e4d3c2b1a099887766';

function root() {
  return { MC_WORK_ROOT: mkdtempSync(join(tmpdir(), 'mc-deploys-')) };
}

function lines(env) {
  return readFileSync(deploysPath(env), 'utf8').split('\n').filter((line) => line.trim());
}

describe('deploys.tsv — the writes', () => {
  it('writes the header once, and the starting row says running with no end', () => {
    const env = root();
    recordStart({ sha: SHA, holder: 'martin@laptop' }, env);
    recordStart({ sha: OLD, holder: 'martin@laptop' }, env);
    const text = lines(env);
    assert.equal(text.length, 3);
    assert.equal(text[0], DEPLOYS_HEADER.join('\t'));
    const rows = readDeploys(env);
    assert.equal(rows[0].sha, SHA);
    assert.equal(rows[0].outcome, 'running');
    assert.equal(rows[0].holder, 'martin@laptop');
    assert.equal(rows[0].ended, '');
    assert.match(rows[0].started, /^\d{4}-\d\d-\d\dT/u);
  });

  it('completes the row it started rather than adding a second one', () => {
    const env = root();
    const first = recordStart({ sha: OLD, holder: 'martin' }, env);
    recordEnd(first, { outcome: 'deployed', build: '812', live_commit: OLD, live_build: '812' }, env);
    const key = recordStart({ sha: SHA, holder: 'martin' }, env);
    recordEnd(key, { outcome: 'deployed', build: '813', live_commit: SHA, live_build: '813' }, env);

    const rows = readDeploys(env);
    assert.equal(rows.length, 2);
    assert.equal(rows[1].sha, SHA);
    assert.equal(rows[1].outcome, 'deployed');
    assert.equal(rows[1].build, '813');
    assert.equal(rows[1].live_commit, SHA);
    assert.match(rows[1].ended, /^\d{4}-\d\d-\d\dT/u);
    assert.equal(rows[1].started, key.started);
    // The first row is untouched by the second deploy's completion.
    assert.equal(rows[0].build, '812');
  });

  it('a failure keeps the step it stopped at, and the reason', () => {
    const env = root();
    const key = recordStart({ sha: SHA, holder: 'martin' }, env);
    recordEnd(key, { outcome: 'failed', stopped_at: 'wrangler deploy', note: 'exit 1 — npx wrangler deploy exited 1' }, env);
    const row = lastAttempt(env);
    assert.equal(row.outcome, 'failed');
    assert.equal(row.stopped_at, 'wrangler deploy');
    assert.equal(row.live_commit, '');
    assert.match(row.note, /wrangler deploy exited 1/u);
  });

  it('a refusal is one whole row, begun and ended at once', () => {
    const env = root();
    recordRefusal({ sha: SHA, holder: 'martin', note: 'answered no at the question' }, env);
    const row = lastAttempt(env);
    assert.equal(row.outcome, 'refused');
    assert.equal(row.note, 'answered no at the question');
    assert.equal(row.started, row.ended);
    assert.equal(row.build, '');
  });

  it('never lets a tab or a newline in a note break the columns', () => {
    const env = root();
    recordRefusal({ sha: SHA, holder: 'martin', note: 'held by runner\tgate round\nsecond line' }, env);
    assert.equal(lines(env).length, 2);
    assert.equal(lastAttempt(env).note, 'held by runner gate round second line');
  });

  it('completes a row whose start was never written, rather than losing the deploy', () => {
    const env = root();
    const row = recordEnd({ started: '2026-09-04T10:00:00Z', sha: SHA }, { outcome: 'deployed', build: '900' }, env);
    assert.equal(row.sha, SHA);
    assert.equal(lastDeploy(env).build, '900');
  });

  it('keeps the header the file already has, and drops what it has no room for', () => {
    const env = root();
    mkdirSync(join(env.MC_WORK_ROOT, 'runner', 'log'), { recursive: true });
    writeFileSync(deploysPath(env), 'started\tended\tsha\tbuild\tholder\toutcome\n');
    const key = recordStart({ sha: SHA, holder: 'martin' }, env);
    recordEnd(key, { outcome: 'deployed', build: '77', stopped_at: 'nowhere' }, env);
    const text = lines(env);
    assert.equal(text[0], 'started\tended\tsha\tbuild\tholder\toutcome');
    assert.equal(text[1].split('\t').length, 6);
    const row = lastDeploy(env);
    assert.equal(row.build, '77');
    assert.equal(row.stopped_at, undefined);
  });
});

describe('deploys.tsv — the reader', () => {
  it('is nothing at all when there is no file yet', () => {
    const env = root();
    assert.deepEqual(readDeploys(env), []);
    assert.equal(lastDeploy(env), null);
    assert.equal(lastAttempt(env), null);
  });

  it('is the last deployed row, keyed by the header the file carries', () => {
    const env = root();
    mkdirSync(join(env.MC_WORK_ROOT, 'runner', 'log'), { recursive: true });
    writeFileSync(deploysPath(env), [
      'started\tended\tsha\tbuild\tholder\toutcome',
      `2026-09-01T09:00:00Z\t2026-09-01T09:12:00Z\t${OLD}\t77\tmartin\tdeployed`,
      `2026-09-02T09:00:00Z\t2026-09-02T09:01:00Z\t${SHA}\t\tmartin\tfailed`,
      '',
    ].join('\n'));
    const row = lastDeploy(env);
    assert.equal(row.sha, OLD);
    assert.equal(row.build, '77');
    // The failure is still the last thing that happened.
    assert.equal(lastAttempt(env).outcome, 'failed');
  });

  it('a deploy that is running now is not what is live', () => {
    const env = root();
    const key = recordStart({ sha: OLD, holder: 'martin' }, env);
    recordEnd(key, { outcome: 'deployed', build: '77' }, env);
    recordStart({ sha: SHA, holder: 'martin' }, env);
    assert.equal(lastDeploy(env).sha, OLD);
    assert.equal(lastAttempt(env).outcome, 'running');
  });

  it('parses nothing out of nothing', () => {
    assert.deepEqual(parseDeploys(''), []);
    assert.deepEqual(parseDeploys('started\tended\tsha\n'), []);
  });
});
