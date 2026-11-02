/** Help after a subcommand is still help, never an error or an operation. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { VERB_MODULES, runModule } from '../../src/mc-verbs.js';
import { HELP_TEXT } from '../../src/mc/help-text.js';
import { runMc } from './_helpers/cli.js';
import { run as vaultRun } from '../../src/cli/vault.js';

/** Literal command prefixes, expanding alternatives but not inventing names. */
function prefixes(text, verb) {
  const result = new Set(['']);
  for (const line of text.split('\n')) {
    const match = /^\s*(?:usage\s*[—:]\s*)?mc ([a-z-]+)\b(.*)$/u.exec(line);
    if (match?.[1] !== verb) continue;
    let paths = [''];
    for (let word of match[2].trim().split(/\s+/u)) {
      // [list] and <dev|prod> are finite alternatives, <name> is not.
      if (/^\[[a-z-]+\]$/u.test(word) || /^<[a-z-]+(?:\|[a-z-]+)+>$/u.test(word)) word = word.slice(1, -1);
      if (!/^[a-z-]+(?:\|[a-z-]+)*$/u.test(word)) break;
      paths = paths.flatMap((path) => word.split('|').map((part) => `${path} ${part}`.trim()));
      for (const path of paths) result.add(path);
    }
  }
  return [...result].map((path) => path ? path.split(' ') : []);
}

describe('help after documented subcommands', () => {
  it('walks both the long help and each handler usage, with --help and -h', async () => {
    const seen = new Set();
    for (const [verb, path] of Object.entries(VERB_MODULES)) {
      const { usage } = await import(new URL(`../../src/${path}`, import.meta.url));
      for (const args of prefixes(`${HELP_TEXT}\n${usage()}`, verb)) {
        seen.add([verb, ...args].join(' '));
        for (const flag of ['--help', '-h']) {
          let out = '';
          const code = await runModule(path, [...args, flag], { stdout: { write: (text) => { out += text; } } });
          assert.equal(code, 0, `mc ${verb} ${args.join(' ')} ${flag}`);
          assert.equal(out, usage().endsWith('\n') ? usage() : `${usage()}\n`);
        }
      }
    }
    for (const command of ['work add', 'run lanes', 'project criterion add', 'project step edit', 'goal blocked', 'repo watch start', 'shot login prod']) {
      assert.ok(seen.has(command), `the walker missed ${command}`);
    }
  });

  it('answers every vault subcommand before a handler can read credentials or write', async () => {
    const source = readFileSync(new URL('../../src/cli/vault.js', import.meta.url), 'utf8');
    const table = /const VERBS = \{([\s\S]*?)\n\};/u.exec(source);
    assert.ok(table, 'vault dispatch table not found');
    const verbs = [...table[1].matchAll(/^\s*'?([a-z-]+)'?:\s*\{ handler:/gmu)].map((match) => match[1]);
    assert.ok(verbs.length > 20, 'the vault walker missed its dispatch table');
    const original = console.log;
    let out;
    console.log = (...parts) => { out += `${parts.join(' ')}\n`; };
    try {
      for (const verb of verbs) {
        for (const flag of ['--help', '-h']) {
          out = '';
          const code = await vaultRun([verb, flag], {
            get portal() { throw new Error('help tried to read credentials'); },
          });
          assert.equal(code, 0, `vault ${verb} ${flag}`);
          assert.match(out, /USAGE\n/u);
          assert.match(out, new RegExp(`^  ${verb}\\s`, 'mu'));
        }
      }
    } finally {
      console.log = original;
    }
  });

  it('the binary prints usage on stdout with exit 0 and no stderr', () => {
    for (const args of [['work', 'add'], ['run', 'lanes'], ['project', 'criterion', 'met'], ['goal', 'log'], ['vault', 'set'], ['vault', 'recovery']]) {
      const result = runMc([...args, '--help']);
      assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
      assert.match(result.stdout, /usage|USAGE/u);
      assert.equal(result.stderr, '');
    }
  });
});
