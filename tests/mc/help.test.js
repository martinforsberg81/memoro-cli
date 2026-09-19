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

import { VERB_MODULES, runModule } from '../../src/mc-verbs.js';
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
    ...Object.keys(VERB_MODULES),
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
      //
      // `dev` was the fourteenth name on this list until 2026-09-05, and it is
      // the one the cut got wrong — not about this repository, where nothing
      // reached it, but past its edge, where memoro's `npm run dev` called it
      // on every start. It is back as three verbs and belongs in the help, so
      // it is asserted in the list above instead of forbidden here. What is
      // still gone are the ten sub-verbs it used to carry: `ensure`, `plan`,
      // `status`, `logs`, `stop` and `restart` among them.
      'doctor', 'migrate', 'setup', 'install-shell', 'auth', 'tool-auth',
      'connections', 'github', 'coding-profile', 'deps',
      'cloud-session', 'cloud-runtime', 'security',
    ];
    for (const gone of ['mc dev ensure', 'mc dev plan', 'mc dev stop', 'mc dev restart', 'mc dev logs', 'mc dev status', 'mc deps', 'mc storage']) {
      assert.doesNotMatch(result.stdout, new RegExp(`\\b${gone}\\b`, 'u'), `${gone} went with the cut and is not coming back`);
    }
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

describe('mc <verb> --help', () => {
  it('every verb in the dispatcher table exports a usage that starts with "usage"', async () => {
    for (const [verb, path] of Object.entries(VERB_MODULES)) {
      const module = await import(new URL(`../../src/${path}`, import.meta.url));
      assert.equal(typeof module.usage, 'function', `${verb} exports no usage()`);
      assert.match(module.usage(), /^usage/u, `${verb}'s usage does not start with "usage"`);
    }
  });

  it('answers --help and -h on stdout with exit 0, and never calls run', async () => {
    for (const [verb, path] of Object.entries(VERB_MODULES)) {
      const { usage } = await import(new URL(`../../src/${path}`, import.meta.url));
      for (const flag of ['--help', '-h']) {
        let out = '';
        const code = await runModule(path, [flag], { stdout: { write: (text) => { out += text; } } });
        assert.equal(code, 0, `${verb} ${flag}`);
        assert.ok(out.startsWith('usage'), `${verb} ${flag} printed no usage`);
        assert.equal(out, usage().endsWith('\n') ? usage() : `${usage()}\n`);
      }
    }
  });

  it('prints the whole usage for a multi-form verb whatever sub-verb came first', async () => {
    let out = '';
    const code = await runModule(VERB_MODULES.test, ['dev', '--help'], { stdout: { write: (text) => { out += text; } } });
    const { usage } = await import('../../src/mc/commands/test.js');
    assert.equal(code, 0);
    assert.equal(out, usage());
  });

  it('the real binary: mc test dev --help is stdout, exit 0, silent on stderr', () => {
    const result = runMc(['test', 'dev', '--help']);
    assert.equal(result.status, 0, `stderr:${result.stderr}`);
    assert.match(result.stdout, /^usage/u);
    assert.equal(result.stderr, '');
  });
});
