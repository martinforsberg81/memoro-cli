/**
 * Every name `mc --help` and a verb's usage put in a synopsis is one the code
 * answers. Independent of the help interceptor in `runModule`, which would
 * answer `mc work invented --help` too: a subcommand word or a flag must be a
 * literal in its verb's handler or the local modules that handler imports.
 *
 * This proves a name exists in the code that serves the verb, not that every
 * combination parses; the runner's synopses go through its real parser in
 * help-shared.test.js.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { VERB_MODULES } from '../../src/mc-verbs.js';
import { HELP_TEXT } from '../../src/mc/help-text.js';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../../src');
const read = (path) => readFileSync(path, 'utf8');

/** A module and every local module it imports, statically or lazily. */
function closure(file, seen = new Set()) {
  if (seen.has(file) || !existsSync(file)) return seen;
  seen.add(file);
  for (const match of read(file).matchAll(/(?:from|import\()\s*['"](\.{1,2}\/[^'"]+)['"]/gu)) {
    closure(resolve(dirname(file), match[1]), seen);
  }
  return seen;
}

const sourceOf = (path) => [...closure(resolve(SRC, path))].map(read).join('\n');
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const camel = (flag) => flag.replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());

/**
 * Synopsis lines only: a reference row (two spaces, then mc), a usage head, or
 * a usage continuation (eight spaces). Descriptions start after two spaces.
 */
export function synopses(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    const match = /^(?: {2}|usage\s*[—:]\s*| {8})mc ([a-z-]+|--[a-z-]+)(.*)$/u.exec(line);
    if (!match) continue;
    const synopsis = match[2].split(/ {2,}/u)[0].trim();
    const words = [];
    for (let word of synopsis.split(/\s+/u).filter(Boolean)) {
      // [list] and <dev|prod> are finite alternatives; <name> ends the literal path.
      if (/^\[[a-z][a-z-]*\]$/u.test(word) || /^<[a-z][a-z-]*(?:\|[a-z][a-z-]*)+>$/u.test(word)) word = word.slice(1, -1);
      if (!/^[a-z][a-z-]*(?:\|[a-z][a-z-]*)*$/u.test(word)) break;
      words.push(...word.split('|'));
    }
    const flags = [...synopsis.matchAll(/(?:^|[\s[|(])--([a-z][a-z-]*)/gu)].map((flag) => flag[1]);
    rows.push({ line: line.trim(), verb: match[1], words, flags });
  }
  return rows;
}

const PAGE_FLAGS = (() => {
  const match = /const pageFlags = new Set\(\[([^\]]*)\]\)/u.exec(read(resolve(SRC, 'mc-cli.js')));
  assert.ok(match, 'the page flags were not found in mc-cli.js');
  return new Set([...match[1].matchAll(/'(--[a-z-]+)'/gu)].map((flag) => flag[1]));
})();

const VAULT_VERBS = (() => {
  const table = /const VERBS = \{([\s\S]*?)\n\};/u.exec(read(resolve(SRC, 'cli/vault.js')));
  assert.ok(table, 'vault dispatch table not found');
  return [...table[1].matchAll(/^\s*'?([a-z-]+)'?:\s*\{ handler:/gmu)].map((match) => match[1]);
})();

/** The names in `text` that no code answers. Empty when every one is routed. */
export function unrouted(text, sources) {
  const problems = [];
  for (const { line, verb, words, flags } of synopses(text)) {
    if (verb.startsWith('--')) {
      // The top-level page flags and --version, answered in mc-cli.js itself.
      for (const flag of [verb.slice(2), ...flags]) {
        if (!PAGE_FLAGS.has(`--${flag}`) && flag !== 'version') problems.push(`mc --${flag}: not a top-level flag  (${line})`);
      }
      continue;
    }
    if (verb === 'vault') {
      for (const word of words) if (!VAULT_VERBS.includes(word)) problems.push(`mc vault ${word}: not in the vault table  (${line})`);
      continue;
    }
    const source = sources[verb];
    if (source === undefined) { problems.push(`mc ${verb}: not routed by mc-verbs.js  (${line})`); continue; }
    for (const word of words) {
      if (!new RegExp(`['"\`]${escape(word)}['"\`]|\\b${escape(word)}\\s*:`, 'u').test(source)) {
        problems.push(`mc ${verb} ${word}: no handler names it  (${line})`);
      }
    }
    for (const flag of flags) {
      const pattern = `['"\`]--${escape(flag)}['"\`=]|['"\`]${escape(flag)}['"\`]|\\b${escape(camel(flag))}\\b`;
      if (!new RegExp(pattern, 'u').test(source)) problems.push(`mc ${verb} --${flag}: no handler reads it  (${line})`);
    }
  }
  return problems;
}

const SOURCES = Object.fromEntries(Object.entries(VERB_MODULES).map(([verb, path]) => [verb, sourceOf(path)]));

describe('every name in the help is routed', () => {
  it('the long help names only verbs, subcommands and flags the code answers', () => {
    const rows = synopses(HELP_TEXT);
    assert.ok(rows.length > 120, `only ${rows.length} synopsis rows found`);
    for (const verb of [...Object.keys(VERB_MODULES), 'vault', '--json', '--version']) {
      assert.ok(rows.some((row) => row.verb === verb), `the walker found no row for ${verb}`);
    }
    assert.deepEqual(unrouted(HELP_TEXT, SOURCES), []);
  });

  it('each verb usage names only what its handler answers', async () => {
    for (const [verb, path] of Object.entries(VERB_MODULES)) {
      const { usage } = await import(new URL(`../../src/${path}`, import.meta.url));
      assert.deepEqual(unrouted(usage(), SOURCES), [], verb);
    }
  });

  it('names every vault verb in the long help, and only those', () => {
    const block = /^ {2}mc vault <verb> +(.*(?:\n {36}.*)*)/mu.exec(HELP_TEXT);
    assert.ok(block, 'the vault row is gone');
    const listed = /vault: ([a-z, -]+)\./u.exec(block[1].split(/\s+/u).join(' '))[1].split(/,\s*/u);
    assert.deepEqual([...listed].sort(), [...VAULT_VERBS].sort());
  });

  it('catches invented verbs, subcommands, flags and vault verbs', () => {
    for (const row of [
      '  mc programme <name>              invented verb',
      '  mc session-control               removed verb',
      '  mc models                        plural typo',
      '  mc work frobnicate <name>        invented subcommand',
      '  mc goal show <name> --fictional  invented flag',
      '  mc run --sprint 2                invented runner flag',
      '  mc vault frobnicate              invented vault verb',
      '  mc --fictional                   invented page flag',
      'usage — mc step haunted <project>',
      '        mc project criterion vanish <project> <n>',
    ]) {
      assert.notDeepEqual(unrouted(row, SOURCES), [], row);
    }
  });

  it('reads alternatives and stops at placeholders and descriptions', () => {
    assert.deepEqual(synopses('  mc shot login <dev|prod>         log in')[0].words, ['shot', 'login', 'dev', 'prod'].slice(1));
    assert.deepEqual(synopses('  mc goal open|blocked|done [<g>] [--reason "…"]  status')[0], {
      line: 'mc goal open|blocked|done [<g>] [--reason "…"]  status', verb: 'goal', words: ['open', 'blocked', 'done'], flags: ['reason'],
    });
    assert.deepEqual(synopses('          mc run start|stop controls the runner'), []);
    assert.deepEqual(synopses('                                    mc can see'), []);
  });
});
