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
 * drift in the first place: every verb either router routes appears in the
 * help, and every verb the help mentions is routed. A help text and a route
 * table that can disagree will.
 *
 * Both tables, because mc has two. `src/mc-cli.js` holds the page and its
 * verbs; `src/bin-mc.js` held the capability dispatcher, and reading only the
 * first is how thirteen capability verbs stayed routed and undocumented for
 * as long as they did.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { runMc } from './_helpers/cli.js';

/**
 * Verbs that are routed and deliberately absent from the help.
 *
 * Empty, and worth keeping empty: `mc pm` and `mc pm-helper` stood here until
 * they were removed outright. An entry is a decision written down rather than
 * drift allowed to weaken the rule for everything else — it is not a place to
 * park a verb nobody wants to document.
 */
const DELIBERATELY_UNLISTED = new Set([]);

/** One router's table, read out of its own source. */
function tableVerbs(file, declaration) {
  const source = readFileSync(fileURLToPath(new URL(`../../src/${file}`, import.meta.url)), 'utf8');
  const table = new RegExp(`const ${declaration} = \\{([\\s\\S]*?)\\n\\s*\\};`, 'u').exec(source);
  assert.ok(table, `${file} no longer has a ${declaration} table to read`);
  return [...table[1].matchAll(/^\s+'?([a-z-]+)'?:/gmu)].map((m) => m[1]);
}

/** Every verb mc routes: the page's own table, and the capability table. */
function routedVerbs() {
  return [
    ...tableVerbs('mc-cli.js', 'modules'),
    ...tableVerbs('bin-mc.js', 'CAPABILITIES'),
  ];
}

describe('mc --help', () => {
  it('mentions every verb either router routes', () => {
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
      // The verb list, cut 2026-09-03: the two V1 maintenance verbs and the
      // thirteen capability verbs, every one of them a door into machinery
      // the page does not reach.
      'doctor', 'migrate', 'setup', 'install-shell', 'auth', 'tool-auth',
      'connections', 'github', 'coding-profile', 'dev', 'deps',
      'cloud-session', 'cloud-runtime', 'security',
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
