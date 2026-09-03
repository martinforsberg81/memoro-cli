/**
 * The record that has to exist whether or not anyone thought to look.
 *
 * Two properties are asserted here and they are the whole point of the file.
 *
 * One: every line of one invocation carries the same `run`. On 2026-08-30 two
 * merge rounds were killed from outside and the facts survived in three files
 * that nothing joined — a lease claim, a lease reap, and a round log that was
 * silent because it is written when a round ends. The id is what makes those
 * one story, so a test that lets it drift is a test that lets the incident
 * happen again.
 *
 * Two: the argument vector is reduced to shape, never content. `mc work send
 * <name> "<message>"` carries a person's words past this file, and the promise
 * of the log is that it holds identifiers, paths, codes and counts and nothing
 * else. That promise is only as good as the filter, so the filter is tested
 * with the message that would break it.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { invocationShape, log, logPath, resetRunId, runId, setLogPath } from '../../src/mc/logger.js';

function scratch() {
  return join(mkdtempSync(join(tmpdir(), 'mc-logger-')), 'mc.log');
}

function linesOf(path) {
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

describe('the run id', () => {
  it('is one id for the life of the process, on every line', () => {
    const path = scratch();
    setLogPath(path);
    try {
      resetRunId();
      log('one', { a: 1 });
      log('two', { b: 2 });
      const lines = linesOf(path);
      assert.equal(lines.length, 2);
      assert.equal(lines[0].run, lines[1].run);
      assert.match(lines[0].run, /^run_[0-9a-f]{12}$/u);
      assert.equal(lines[0].run, runId());
    } finally {
      setLogPath(null);
      rmSync(path, { force: true });
    }
  });

  it('a new run is a new id — two invocations are never conflated', () => {
    const first = runId();
    const second = resetRunId();
    assert.notEqual(first, second);
  });
});

describe('an invocation is recorded as shape, never as content', () => {
  it('keeps the verb, the subcommand, identifier positionals and flag names', () => {
    assert.deepEqual(invocationShape(['merge', 'memoro', '11082', '11085', '--check']), {
      verb: 'merge', sub: 'memoro', args: ['11082', '11085'], flags: ['--check'], argc: 5,
    });
  });

  it('drops a flag VALUE without inspecting it', () => {
    const shape = invocationShape(['work', 'add', 'red-floor', 'memoro-cli', '--from', 'origin/main']);
    assert.deepEqual(shape.flags, ['--from']);
    assert.ok(!shape.args.includes('origin/main'), 'a flag value is not a positional');
  });

  it('never records prose a person typed', () => {
    const shape = invocationShape(['repo', 'claim', 'memoro', 'fixa detta tack', '--force']);
    assert.deepEqual(shape, { verb: 'repo', sub: 'claim', args: [], flags: ['--force'], argc: 5 });
  });

  it('drops a one-word tail too — the verb list, not just the filter', () => {
    // A single word passes the identifier filter, which is exactly why the
    // free-text verbs drop their positionals outright rather than trusting it.
    const shape = invocationShape(['repo', 'claim', 'memoro', 'stop']);
    assert.deepEqual(shape.args, []);
  });

  it('drops prose that reaches a verb the list does not name', () => {
    const shape = invocationShape(['repo', 'claim', 'memoro', 'gate round for #11082']);
    assert.ok(!shape.args.some((a) => a.includes(' ')), 'nothing with a space is kept');
  });

  it('names the page when there is no verb', () => {
    assert.equal(invocationShape([]).verb, '(page)');
    assert.equal(invocationShape(['--json']).verb, '(page)');
    assert.deepEqual(invocationShape(['--json']).flags, ['--json']);
  });
});

describe('the logger never fails its caller', () => {
  it('an unwritable path is swallowed, not thrown', () => {
    setLogPath('/proc/definitely/not/writable/mc.log');
    try {
      assert.doesNotThrow(() => log('event', { a: 1 }));
    } finally {
      setLogPath(null);
    }
  });

  it('falls back to mc home when no override is set', () => {
    setLogPath(null);
    assert.match(logPath(), /logs\/mc\.log$/u);
  });
});
