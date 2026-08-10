/**
 * The shared flag scanner. Its contract is fidelity: `mc work`'s original
 * quirks preserved exactly for the legacy value flags, the strict `--model`
 * dance for the flags where silence is the failure mode.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { scanArgs } from '../../../src/mc/commands/flags.js';

const WORK_SPEC = {
  booleans: ['--json', '--apply', '--tmux'],
  values: ['--repo', '--from'],
  strictValues: ['--model'],
  toolSugar: true,
};

describe('scanArgs', () => {
  it('scans the full work grammar', () => {
    const { flags, positional, error } = scanArgs(
      ['add', 'api', '--repo', 'memoro-cli', '--json', '--model', 'opus', '--claude'],
      WORK_SPEC,
    );
    assert.equal(error, undefined);
    assert.deepEqual(positional, ['add', 'api']);
    assert.equal(flags.repo, 'memoro-cli');
    assert.equal(flags.json, true);
    assert.equal(flags.model, 'opus');
    assert.equal(flags.tool, 'claude');
    assert.equal(flags.apply, false);
    assert.equal(flags.from, null);
  });

  it('legacy value flags read the next positional, flags in between first', () => {
    const { flags, positional } = scanArgs(['--repo', '--json', 'memoro-cli', 'x'], WORK_SPEC);
    assert.equal(flags.json, true);
    assert.equal(flags.repo, 'memoro-cli');
    assert.deepEqual(positional, ['x']);
  });

  it('two pending value flags resolve in declared order, as they always have', () => {
    const { flags } = scanArgs(['--repo', '--from', 'first', 'second'], WORK_SPEC);
    assert.equal(flags.repo, 'first');
    assert.equal(flags.from, 'second');
  });

  it('a trailing legacy value flag is silently dropped, as it always was', () => {
    const { flags, error } = scanArgs(['x', '--repo'], WORK_SPEC);
    assert.equal(error, undefined);
    assert.equal(flags.repo, null);
  });

  it('strict flags refuse a missing value, trailing or flag-eaten', () => {
    assert.equal(scanArgs(['x', '--model'], WORK_SPEC).error, '--model needs a value');
    assert.equal(scanArgs(['--model', '--claude', 'x'], WORK_SPEC).error, '--model needs a value');
  });

  it('unknown flags refuse loudly', () => {
    assert.equal(scanArgs(['--models', 'x'], WORK_SPEC).error, 'unknown flag: --models');
    assert.equal(scanArgs(['--codex'], { booleans: [] }).error, 'unknown flag: --codex');
  });
});
