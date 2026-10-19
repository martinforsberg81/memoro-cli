/**
 * `ios-builds.tsv`: the row written before the build and completed after it,
 * the build still running, and the last binary that shipped.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  IOS_BUILDS_HEADER, iosBuildsPath, lastShipped, readIosBuilds, recordEnd, recordStart, runningIosBuild,
} from '../../src/mc/ios-builds.js';

function freshEnv() {
  return { MC_WORK_ROOT: mkdtempSync(join(tmpdir(), 'mc-ios-builds-')) };
}

describe('ios-builds.tsv', () => {
  it('lives in the runner log and is made with the header', () => {
    const env = freshEnv();
    assert.equal(iosBuildsPath(env), join(env.MC_WORK_ROOT, 'runner', 'log', 'ios-builds.tsv'));
    recordStart({ sha: 'a'.repeat(40), kind: 'device', pid: 42 }, env);
    const [header] = readFileSync(iosBuildsPath(env), 'utf8').split('\n');
    assert.equal(header, IOS_BUILDS_HEADER.join('\t'));
  });

  it('completes the row recordStart wrote, by its key', () => {
    const env = freshEnv();
    const key = recordStart({ sha: 'b'.repeat(40), kind: 'device', live_commit: 'b'.repeat(40), pid: 7 }, env);
    assert.equal(readIosBuilds(env)[0].outcome, 'running');
    recordEnd(key, { outcome: 'installed', version: '1.2', build: '40', artifact: '/tmp/App.app' }, env);
    const rows = readIosBuilds(env);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].outcome, 'installed');
    assert.equal(rows[0].build, '40');
    assert.equal(rows[0].kind, 'device');
    assert.ok(rows[0].ended);
  });

  it('writes an unmatched end as a row of its own', () => {
    const env = freshEnv();
    recordEnd({ started: '2026-10-18T10:00:00.000Z', sha: 'c'.repeat(40) }, { outcome: 'failed', kind: 'testflight' }, env);
    const rows = readIosBuilds(env);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].outcome, 'failed');
    assert.equal(rows[0].started, '2026-10-18T10:00:00.000Z');
  });

  it('runningIosBuild is the last running row whose process lives', () => {
    const env = freshEnv();
    recordStart({ sha: 'd'.repeat(40), kind: 'device', pid: 100 }, env);
    recordStart({ sha: 'e'.repeat(40), kind: 'testflight', pid: 200 }, env);
    assert.equal(runningIosBuild(env, { alive: (pid) => pid === 100 })?.sha, 'd'.repeat(40));
    assert.equal(runningIosBuild(env, { alive: () => false }), null);
    const key = { started: readIosBuilds(env)[0].started, sha: 'd'.repeat(40) };
    recordEnd(key, { outcome: 'installed' }, env);
    assert.equal(runningIosBuild(env, { alive: (pid) => pid === 100 }), null);
  });

  it('lastShipped is the later of an uploaded TestFlight build and a seed', () => {
    const env = freshEnv();
    assert.equal(lastShipped(env), null);
    recordStart({ sha: '1'.repeat(40), kind: 'seed', build: '38', outcome: 'uploaded', ended: 'x' }, env);
    assert.equal(lastShipped(env).build, '38');
    recordStart({ sha: '2'.repeat(40), kind: 'device', build: '39', outcome: 'installed', ended: 'x' }, env);
    recordStart({ sha: '3'.repeat(40), kind: 'testflight', build: '40', outcome: 'built', ended: 'x' }, env);
    assert.equal(lastShipped(env).build, '38', 'a device build or an IPA never uploaded is not shipped');
    recordStart({ sha: '4'.repeat(40), kind: 'testflight', build: '41', outcome: 'uploaded', ended: 'x' }, env);
    assert.equal(lastShipped(env).build, '41');
  });
});
