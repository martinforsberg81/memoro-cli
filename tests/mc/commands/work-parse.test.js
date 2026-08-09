/**
 * `mc work` argument grammar around `--model`.
 *
 * The flag has to coexist with a grammar that is mostly positional — names,
 * verbs, conversation ids, and with `--tmux` a whole task in free words — so
 * what is worth pinning is that the value never leaks into any of those, and
 * that a line without the flag parses exactly as it did before.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseArgs } from '../../../src/mc/commands/work.js';

describe('mc work parseArgs and --model', () => {
  it('reads the value and keeps it out of the positionals', () => {
    const opts = parseArgs(['api', 'new', '--model', 'opus']);
    assert.equal(opts.error, undefined);
    assert.equal(opts.verb, 'open');
    assert.equal(opts.name, 'api');
    assert.equal(opts.pick, 'new');
    assert.equal(opts.model, 'opus');
  });

  it('with --tmux the task keeps its words and the model stays a flag', () => {
    const opts = parseArgs(['api', 'fix', 'the', 'bug', '--tmux', '--model', 'gpt-5.3-codex']);
    assert.equal(opts.error, undefined);
    assert.equal(opts.verb, 'open');
    assert.equal(opts.task, 'fix the bug');
    assert.equal(opts.model, 'gpt-5.3-codex');
  });

  it('a --model nothing follows is an error, not a silent default', () => {
    const opts = parseArgs(['api', 'new', '--model']);
    assert.equal(opts.error, '--model needs a value');
  });

  it('a --model followed by a flag is the same error, not a misbound word', () => {
    // Without the guard, '--claude' is eaten as a flag and the first task
    // word 'fix' silently becomes the model.
    const opts = parseArgs(['api', '--tmux', '--model', '--claude', 'fix', 'the', 'bug']);
    assert.equal(opts.error, '--model needs a value');
  });

  // Parallel-operation guarantee: the grammar without the flag is untouched.
  it('a line without the flag parses exactly as before', () => {
    const opts = parseArgs(['api', 'new', '--claude']);
    assert.equal(opts.error, undefined);
    assert.equal(opts.verb, 'open');
    assert.equal(opts.name, 'api');
    assert.equal(opts.pick, 'new');
    assert.equal(opts.tool, 'claude');
    assert.equal(opts.model, null);
    const verb = parseArgs(['add', 'api', 'memoro-cli', 'main']);
    assert.equal(verb.verb, 'add');
    assert.equal(verb.repo, 'memoro-cli');
    assert.equal(verb.branch, 'main');
    assert.equal(verb.model, null);
  });

  it('unknown flags still refuse loudly', () => {
    assert.equal(parseArgs(['api', '--models', 'opus']).error, 'unknown flag: --models');
  });
});
