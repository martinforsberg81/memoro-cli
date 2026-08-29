/**
 * One world on the surface (decision mc-1, 2026-08-26).
 *
 * The runner and `mc brief` replaced the resident PM, so `mc pm` and
 * `mc pm-helper` answer instead of opening — one line, exit 2 — and the
 * whole `mc watch` programme is gone rather than dormant: its two legs
 * watched a world that no longer exists. `mc repo watch` is a different
 * mechanism and is untouched.
 *
 * A reader of `mc --help` should find no trace of either, so the help text
 * is asserted here as well as the dispatch: a verb that answers "dormant"
 * while the help still advertises it is the same confusion with extra steps.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runMcCli } from '../_helpers/mc-cli.js';

describe('the dormant verbs answer and stop', () => {
  for (const argv of [['pm'], ['pm', 'new'], ['pm-helper'], ['pm-helper', 'intake']]) {
    it(`mc ${argv.join(' ')} says so and exits 2`, () => {
      const result = runMcCli(argv);
      assert.equal(result.status, 2, `stdout:${result.stdout}\nstderr:${result.stderr}`);
      assert.match(result.stderr, new RegExp(`^mc ${argv[0]} is dormant — the runner and mc brief replaced it \\(decision mc-1\\)\\n$`, 'u'));
      assert.equal(result.stdout, '');
    });
  }
});

describe('mc watch is not a command any more', () => {
  it('is refused as unknown, with the list to look in', () => {
    const result = runMcCli(['watch', 'pm', 'status']);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /unknown command "watch"/u);
  });

  it('and mc repo watch, a different mechanism, still answers', () => {
    const result = runMcCli(['repo', 'watch', 'status', '--json']);
    assert.equal(result.status, 0, `stdout:${result.stdout}\nstderr:${result.stderr}`);
    assert.match(result.stdout, /"running"/u);
  });
});

describe('mc --help shows one world', () => {
  const help = () => runMcCli(['--help']).stdout;

  it('names neither pm nor pm-helper', () => {
    assert.doesNotMatch(help(), /mc pm/u);
  });

  it('names no watcher but the page and the repository one', () => {
    const lines = help().split('\n').filter((line) => /\bwatch\b/u.test(line));
    for (const line of lines) {
      // `mc --watch` is the page redrawn (decision mc-3), not a daemon; the
      // dead `mc watch` programme is what must leave no trace.
      assert.match(line, /mc repo watch|mc --watch|until ctrl-c/u, `unexpected watcher in the help: ${line}`);
    }
  });

  it('and still names the verbs that took the work over', () => {
    const text = help();
    assert.match(text, /mc brief/u);
    assert.match(text, /mc plan <name>/u);
    assert.match(text, /mc worker <name>/u);
  });
});
