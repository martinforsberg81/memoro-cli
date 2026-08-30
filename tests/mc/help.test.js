/**
 * `mc --help` lists the verbs that exist, and only those.
 *
 * What stood here pinned the help text of mc's earlier life as a session
 * manager: `mc new`, `mc attach`, `mc end`, `mc cleanup`, `mc delete`,
 * `mc gc`, `mc sessions send`. Fourteen of those verbs were cut on
 * 2026-08-30 — zero internal dependents, unreachable from the page, and not
 * called once in the log — so three of its four tests were describing a
 * product that no longer ships.
 *
 * The assertion that replaces them is the one that would have caught the
 * drift in the first place: every verb the dispatcher routes appears in the
 * help, and every verb the help mentions is routed. A help text and a route
 * table that can disagree will.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { runMc } from './_helpers/cli.js';

/**
 * Verbs that are routed and deliberately absent from the help.
 *
 * `mc pm` and `mc pm-helper` are the PM's own doors, and
 * tests/mc/commands/dormant.test.js asserts the help shows one world and does
 * not name them. That is a decision, not drift, so it is written down here
 * rather than allowed to weaken the rule for everything else.
 */
const DELIBERATELY_UNLISTED = new Set(['pm', 'pm-helper']);

/** The verbs `src/mc-cli.js` routes, read out of its own table. */
function routedVerbs() {
  const source = readFileSync(fileURLToPath(new URL('../../src/mc-cli.js', import.meta.url)), 'utf8');
  const table = /const modules = \{([\s\S]*?)\};/u.exec(source);
  assert.ok(table, 'the dispatcher no longer has a modules table to read');
  return [...table[1].matchAll(/^\s+'?([a-z-]+)'?:/gmu)].map((m) => m[1]);
}

describe('mc --help', () => {
  it('mentions every verb the dispatcher routes', () => {
    const result = runMc(['--help']);
    assert.equal(result.status, 0, `stderr:${result.stderr}`);
    for (const verb of routedVerbs()) {
      if (DELIBERATELY_UNLISTED.has(verb)) continue;
      assert.match(result.stdout, new RegExp(`\\bmc ${verb}\\b`, 'u'), `${verb} is routed and not in the help`);
    }
  });

  it('mentions no verb that was cut', () => {
    const result = runMc(['--help']);
    const gone = [
      'new', 'open', 'resume', 'rename', 'cd', 'attach', 'restart',
      'end', 'delete', 'cleanup', 'gc', 'storage', 'sessions',
    ];
    for (const verb of gone) {
      assert.doesNotMatch(result.stdout, new RegExp(`\\bmc ${verb}\\b`, 'u'), `${verb} was cut and is still in the help`);
    }
  });

  it('does not expose internal plan shorthand', () => {
    const result = runMc(['--help']);
    assert.equal(result.status, 0, `stderr:${result.stderr}`);
    assert.doesNotMatch(result.stdout, /§\d/u);
    assert.doesNotMatch(result.stdout, /\bMVP\b/u);
  });
});
