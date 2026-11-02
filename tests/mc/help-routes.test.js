/**
 * Every form `mc --help` and a verb's usage write is one the verb's own parser
 * takes. Independent of the help interceptor in `runModule`, which would
 * answer `mc work invented --help` too.
 *
 * Each synopsis — the head rows, every `mc` row under it and the `[--flag]`
 * lines that continue one — is expanded into command lines: the required
 * words with a sample for each placeholder, then once more for every optional
 * part and every alternative. Each line goes through what the handler reads
 * its arguments with: its exported parser where it has one, or else the
 * scanner with the spec the handler scans that subcommand with (its exported
 * `ROUTES`). No text of the help, and nothing in command-help.js, decides
 * what is routed.
 *
 * Then every `--flag` a usage names anywhere, prose included, must be one
 * that verb's parser knows on at least one of its forms.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { VERB_MODULES } from '../../src/mc-verbs.js';
import { HELP_TEXT } from '../../src/mc/help-text.js';
import { commandReference, commandUsage } from '../../src/mc/command-help.js';
import { scanArgs } from '../../src/mc/commands/flags.js';
import { parseRunArgs } from '../../src/mc/commands/run.js';
import { parseArgs as parseWork } from '../../src/mc/commands/work.js';
import { parseArgs as parseDev } from '../../src/mc/commands/dev.js';
import { parseArgs as parseRepo, parseMergeArgs } from '../../src/mc/commands/repo.js';
import { parseWatchArgs } from '../../src/mc/commands/merge.js';
import { parseEnvironmentArgs, parseNightlyArgs, TOKEN_FLAGS } from '../../src/mc/commands/test.js';
import { parseBuildArgs } from '../../src/mc/commands/build.js';
import { parseDeployArgs } from '../../src/mc/commands/deploy.js';
import { parseArgs as parseTidy } from '../../src/mc/commands/tidy.js';
import { parseArgs as parseLog } from '../../src/mc/commands/log.js';
import { parseArgs as parseWorker } from '../../src/mc/commands/worker.js';
import { parseArgs as parseRoles } from '../../src/mc/commands/roles.js';
import { parseArgs as parseDocker } from '../../src/mc/commands/docker.js';
import { parseArgs as parsePlan } from '../../src/mc/commands/plan.js';
import { scanStepArgs } from '../../src/mc/commands/step.js';
import { parsePageArgs } from '../../src/mc/commands/home.js';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../../src');
const read = (path) => readFileSync(path, 'utf8');

const VAULT_VERBS = (() => {
  const table = /const VERBS = \{([\s\S]*?)\n\};/u.exec(read(resolve(SRC, 'cli/vault.js')));
  assert.ok(table, 'vault dispatch table not found');
  return [...table[1].matchAll(/^\s*'?([a-z-]+)'?:\s*\{ handler:/gmu)].map((match) => match[1]);
})();

/* ------------------------------------------------------------ the parsers */

const errorOf = (result) => result?.error ?? null;

/**
 * A verb read through `ROUTES`: the longest leading words that name a route,
 * then `*` when a first word names something, then `''` for the bare verb.
 */
function routed(routes, argv) {
  for (const width of [2, 1]) {
    const key = argv.slice(0, width).join(' ');
    if (argv.length >= width && !argv.slice(0, width).some((word) => word.startsWith('-')) && Object.hasOwn(routes, key) && key) {
      return errorOf(scanArgs(argv.slice(width), routes[key]));
    }
  }
  // A word that begins a longer route is that route's noun, not a name: mc project criterion <what>.
  if (argv[0] && Object.keys(routes).some((route) => route.startsWith(`${argv[0]} `))) return `no subcommand ${argv.slice(0, 2).join(' ')}`;
  const key = argv[0] !== undefined && !argv[0].startsWith('-') ? '*' : '';
  if (!Object.hasOwn(routes, key)) return key === '*' ? `no subcommand ${argv[0]}` : 'not without a subcommand';
  return errorOf(scanArgs(argv, routes[key]));
}

/** What each verb's handler reads its arguments with. */
const PARSERS = {
  run: (argv) => errorOf(parseRunArgs(argv)),
  work: (argv) => errorOf(parseWork(argv)),
  dev: (argv) => errorOf(parseDev(argv, { cwd: '/', callerWorktree: () => '/worktree' })),
  repo: (argv) => errorOf(parseRepo(argv)),
  merge: (argv) => (argv[0] === 'watch'
    ? errorOf(parseWatchArgs(argv.slice(1)))
    : errorOf(parseMergeArgs(argv, { docs: true, watch: true, admin: true }))),
  test: (argv) => {
    if (argv[0] === 'nightly') return errorOf(parseNightlyArgs(argv.slice(1)));
    if (argv[0] === 'dev' || argv[0] === 'prod') return errorOf(parseEnvironmentArgs(argv[0], argv.slice(1)));
    if (argv[0] === 'token') return errorOf(scanArgs(argv.slice(1), TOKEN_FLAGS));
    return errorOf(parseMergeArgs(argv, { full: true }));
  },
  build: (argv) => errorOf(parseBuildArgs(argv)),
  deploy: (argv) => errorOf(parseDeployArgs(argv)),
  tidy: (argv) => errorOf(parseTidy(argv)),
  log: (argv) => errorOf(parseLog(argv)),
  worker: (argv) => errorOf(parseWorker(argv)),
  roles: (argv) => errorOf(parseRoles(argv)),
  docker: (argv) => errorOf(parseDocker(argv)),
  plan: (argv) => errorOf(parsePlan(argv)),
  step: (argv) => errorOf(scanStepArgs(argv)),
  vault: (argv) => (VAULT_VERBS.includes(argv[0]) || argv.length === 0 ? null : `no vault verb ${argv[0]}`),
};

const ROUTED = {};
for (const [verb, path] of Object.entries(VERB_MODULES)) {
  if (PARSERS[verb]) continue;
  const { ROUTES } = await import(new URL(`../../src/${path}`, import.meta.url));
  assert.ok(ROUTES, `${verb} has neither a parser here nor exported ROUTES`);
  ROUTED[verb] = ROUTES;
  PARSERS[verb] = (argv) => routed(ROUTES, argv);
}

/** The page's own flags, as mc-cli.js routes them; --version is answered before it. */
const PAGE = (argv) => (argv[0] === '--version' && argv.length === 1 ? null : errorOf(parsePageArgs(argv)));

/** null when `mc <verb> <argv…>` parses, else what the parser said. */
export function parses(verb, argv) {
  if (verb.startsWith('--')) return PAGE([verb, ...argv]);
  const parser = PARSERS[verb];
  if (!parser) return `mc ${verb}: not routed by mc-verbs.js`;
  return parser(argv);
}

/* ---------------------------------------------------- the synopsis grammar */

/** Samples for placeholders a parser checks; any other is `x`. */
const SAMPLE = {
  pr: '7', n: '3', m: '2', s: '5', seconds: '5', min: '5', h: '2', ms: '600', build: '12', sha: 'abc1234',
  iso: '2026-01-01T00:00:00Z', lang: 'sv', verb: 'status', list: 'sv,fr', 't,r,b,l': '47,0,34,0', v: 'iphone',
};
/** Words in brackets that describe rather than name: the forms they stand for are walked on their own rows. */
const DESCRIPTIVE = new Set(['same flags', 'step flags']);

function sample(token) {
  const bare = token.replace(/(?:\.\.\.|…)$/u, '');
  if (/^"[^"]*"$/u.test(bare)) return 'x';
  // `<pr>...` is a second one: a different number.
  if (bare !== token && /^<[a-z]+>$/u.test(bare) && /^\d+$/u.test(SAMPLE[bare.slice(1, -1)] ?? '')) return String(Number(SAMPLE[bare.slice(1, -1)]) + 1);
  return bare.replace(/<([^<>]+)>/gu, (_, name) => SAMPLE[name] ?? (/^[a-z]+(?:\|[a-z]+)+$/u.test(name) ? name.split('|')[0] : 'x'));
}

/** A token's alternatives: `a|b`, `<dev|prod>`, `--codex|--claude`, `<id>|--all`. */
function choices(token) {
  const literal = /^<([a-z]+(?:\|[a-z]+)+)>$/u.exec(token);
  if (literal) return literal[1].split('|').map((word) => SAMPLE[word] ?? word);
  const parts = [];
  let depth = 0;
  let current = '';
  for (const char of token) {
    if (char === '<') depth += 1;
    if (char === '>') depth -= 1;
    if (char === '|' && depth === 0) { parts.push(current); current = ''; continue; }
    current += char;
  }
  parts.push(current);
  return parts.map(sample);
}

function tokenize(synopsis) {
  const text = synopsis
    .replace(/<[^<>]*>/gu, (placeholder) => placeholder.replace(/\s+/gu, '_'))
    .replace(/"[^"]*"/gu, '"x"')
    // A bracket glued to a word is an optional suffix of that word: <css>[@end], <repo>[,<repo>].
    .replace(/(?<=[^\s[|])\[[^\]\s]*\]/gu, '');
  const tokens = [];
  for (const word of text.split(/\s+/u).filter(Boolean)) {
    let core = word;
    while (core.startsWith('[')) { tokens.push('['); core = core.slice(1); }
    let closing = 0;
    while (core.endsWith(']')) { closing += 1; core = core.slice(0, -1); }
    if (core) tokens.push(core);
    for (let index = 0; index < closing; index += 1) tokens.push(']');
  }
  return tokens;
}

const isFlag = (token) => token.startsWith('--');

/** A sequence of units: a word, a flag with its values, an optional group, or alternatives. */
function parseSequence(tokens, at = 0) {
  const units = [];
  let index = at;
  while (index < tokens.length && tokens[index] !== ']') {
    const token = tokens[index];
    if (token === '[') {
      const [inner, end] = parseSequence(tokens, index + 1);
      index = end + 1;
      const words = inner.map((unit) => unit.text).join(' ');
      if (!DESCRIPTIVE.has(words)) units.push({ kind: 'optional', inner });
      continue;
    }
    if (token === '|') {
      const left = units.pop();
      const [right, next] = parseUnit(tokens, index + 1);
      index = next;
      if (!left || !right) continue;
      // `--measure <css> | @<name>`: a bare word is another value of the flag before it.
      const other = left.kind === 'flag' && right.kind === 'word' ? { ...left, values: [right.text] } : right;
      const alternatives = left.kind === 'alternatives' ? [...left.alternatives, other] : [left, other];
      units.push({ kind: 'alternatives', alternatives });
      continue;
    }
    const [unit, next] = parseUnit(tokens, index);
    units.push(unit);
    index = next;
  }
  return [units, index];
}

function parseUnit(tokens, index) {
  const token = tokens[index];
  if (token === undefined || token === ']') return [null, index];
  if (token === '[') {
    const [inner, end] = parseSequence(tokens, index + 1);
    return [{ kind: 'optional', inner }, end + 1];
  }
  if (isFlag(token)) {
    const values = [];
    let next = index + 1;
    while (next < tokens.length && !['[', ']', '|'].includes(tokens[next]) && !isFlag(tokens[next])
      && (/[<"]/u.test(tokens[next]) || /^[a-z]+(?:\|[a-z]+)+$/u.test(tokens[next]))) {
      values.push(tokens[next]);
      next += 1;
    }
    return [{ kind: 'flag', flag: token, values, text: [token, ...values].join(' ') }, next];
  }
  return [{ kind: 'word', text: token }, index + 1];
}

/** Every variant of one unit; the first is its default. */
function unitVariants(unit) {
  if (unit.kind === 'word') return choices(unit.text).map((word) => (word ? [word] : []));
  if (unit.kind === 'flag') {
    const flags = choices(unit.flag);
    const values = unit.values.map(choices);
    const out = flags.map((flag) => [flag, ...values.map((options) => options[0])]);
    values.forEach((options, at) => options.slice(1).forEach((option) => {
      out.push([flags[0], ...values.map((others, other) => (other === at ? option : others[0]))]);
    }));
    return out;
  }
  if (unit.kind === 'optional') return [[], ...sequenceVariants(unit.inner)];
  return unit.alternatives.flatMap(unitVariants);
}

/** The default line, then one line for each choice made otherwise, one at a time. */
function sequenceVariants(units) {
  const each = units.map(unitVariants);
  const base = each.map((variants) => variants[0]);
  const lines = [base.flat()];
  each.forEach((variants, at) => variants.slice(1).forEach((variant) => {
    lines.push(base.map((part, other) => (other === at ? variant : part)).flat());
  }));
  return lines;
}

/** The command lines a synopsis stands for. */
export function expand(synopsis) {
  return sequenceVariants(parseSequence(tokenize(synopsis))[0]);
}

/* --------------------------------------------------------- the help's rows */

const ROW = /^(?: {2,8}|usage\s*[—:]\s*)mc ([a-z][a-z-]*|--[a-z-]+)(.*)$/u;
const PIPED = /^ {2,8}\S.*\| mc ([a-z][a-z-]*)(.*)$/u;
const CONTINUED = /^ {8,16}(\[--.*)$/u;
const synopsisOf = (rest) => rest.split(/ {2,}/u)[0].trim();

/**
 * The synopsis rows of a text: each `mc <verb> …` row (a usage head, a row
 * under it, a reference row) with the `[--flag]` lines that continue it.
 */
export function synopses(text) {
  const rows = [];
  let last = null;
  for (const line of text.split('\n')) {
    const match = ROW.exec(line) || PIPED.exec(line);
    if (match) {
      last = { line: line.trim(), verb: match[1], synopsis: synopsisOf(match[2]) };
      rows.push(last);
      continue;
    }
    const continued = CONTINUED.exec(line);
    if (continued && last) {
      last.synopsis = `${last.synopsis} ${synopsisOf(continued[1])}`;
      last.line = `${last.line} ${line.trim()}`;
      continue;
    }
    if (!/^ {30,}/u.test(line)) last = null;
  }
  return rows;
}

/** Each row of `text` some line of which its verb's parser refuses. Empty when every one parses. */
export function unrouted(text) {
  const problems = [];
  for (const { line, verb, synopsis } of synopses(text)) {
    for (const argv of expand(synopsis)) {
      const error = parses(verb, argv);
      if (error) problems.push(`mc ${verb} ${argv.join(' ')}: ${error}  (${line})`);
    }
  }
  return problems;
}

/* ---------------------------------------------------- flags named in prose */

/** Flags a usage names that belong to another program, said where they are. */
const FOREIGN = {
  hook: ['--test'], // node --test, which the pre-tool hook turns into mc gate
  deps: ['--package-lock-only'], // the npm flag bump runs npm with
};

/** Whether `flag` is one `verb` reads on some form its help writes. */
function knows(verb, flag, forms) {
  if (ROUTED[verb]) {
    return Object.values(ROUTED[verb]).some((spec) => [
      ...(spec.booleans || []), ...(spec.values || []), ...(spec.strictValues || []), ...(spec.repeatable || []),
      ...(spec.toolSugar ? ['--codex', '--claude'] : []),
    ].includes(flag));
  }
  return forms.some((argv) => [[flag], [flag, '3'], [flag, 'x']].some((extra) => {
    const error = parses(verb, [...argv, ...extra]);
    return error === null || (error.includes(flag) && !error.startsWith('unknown flag'));
  }));
}

/** Which verb a flag on this line is said of: the `mc <verb>` whose clause holds it, else the usage's own. */
function ownerOf(line, at, own) {
  let owner = own;
  for (const mention of line.matchAll(/\bmc ([a-z][a-z-]*)/gu)) {
    if (mention.index > at || !Object.hasOwn(VERB_MODULES, mention[1])) continue;
    const clause = line.slice(mention.index, at);
    owner = /[,;—()→]|\.(?:\s|$)/u.test(clause) ? own : mention[1];
  }
  return owner;
}

/** Every flag a verb's usage names that the verb it is said of does not know. */
export function unknownFlags(verb, text) {
  const forms = (verbOf) => synopses(commandUsage(verbOf)).filter((row) => row.verb === verbOf).flatMap((row) => expand(row.synopsis));
  const problems = [];
  for (const line of text.split('\n')) {
    for (const match of line.matchAll(/(?<![\w-])--[a-z][a-z-]*/gu)) {
      const owner = ownerOf(line, match.index, verb);
      if (FOREIGN[owner]?.includes(match[0])) continue;
      if (!knows(owner, match[0], forms(owner))) problems.push(`mc ${owner} ${match[0]}: not a flag it reads  (${line.trim()})`);
    }
  }
  return problems;
}

/** The top-level help without the verbs' usage it embeds: the page and its own rows. */
const OWN_TEXT = Object.keys(VERB_MODULES).reduce((text, verb) => text.replace(commandReference(verb), ''), HELP_TEXT);

describe('every name in the help is routed', () => {
  it('each verb usage writes only forms its own parser takes', () => {
    let lines = 0;
    for (const verb of Object.keys(VERB_MODULES)) {
      const rows = synopses(commandUsage(verb));
      assert.ok(rows.some((row) => row.verb === verb), `the walker found no row for ${verb}`);
      lines += rows.flatMap((row) => expand(row.synopsis)).length;
      assert.deepEqual(unrouted(commandUsage(verb)), [], verb);
    }
    assert.ok(lines > 300, `only ${lines} command lines were walked`);
  });

  it('the page and the long help write only forms the parsers take', () => {
    for (const verb of ['run', 'gate', 'shot', 'test', 'goal', 'vault', '--json', '--version']) {
      assert.ok(synopses(OWN_TEXT).some((row) => row.verb === verb), `the walker found no page row for ${verb}`);
    }
    assert.deepEqual(unrouted(HELP_TEXT), []);
  });

  it('each verb usage names, in prose too, only flags the verb it speaks of reads', () => {
    for (const verb of Object.keys(VERB_MODULES)) assert.deepEqual(unknownFlags(verb, commandUsage(verb)), [], verb);
  });

  it('names every vault verb in the long help, and only those', () => {
    const block = /^ {2}mc vault <verb> +(.*(?:\n {36}.*)*)/mu.exec(HELP_TEXT);
    assert.ok(block, 'the vault row is gone');
    const listed = /vault: ([a-z, -]+)\./u.exec(block[1].split(/\s+/u).join(' '))[1].split(/,\s*/u);
    assert.deepEqual([...listed].sort(), [...VAULT_VERBS].sort());
  });

  it('documents in IN FULL every subcommand a handler routes', () => {
    const documented = new Set(synopses(HELP_TEXT).flatMap(({ verb, synopsis }) => expand(synopsis)
      .flatMap((argv) => [`${verb} ${argv.slice(0, 2).join(' ')}`, ...argv.map((word) => `${verb} ${word}`)])));
    for (const [verb, routes] of Object.entries(ROUTED)) {
      for (const key of Object.keys(routes)) {
        if (key === '' || key === '*') continue;
        assert.ok(documented.has(`${verb} ${key}`), `mc ${verb} ${key} is routed but not in IN FULL`);
      }
    }
    let tables = 0;
    for (const [verb, path] of Object.entries(VERB_MODULES)) {
      const source = read(resolve(SRC, path));
      for (const table of source.matchAll(/^const [A-Z_]*(?:VERBS|WORDS|SUBCOMMANDS) = \[([^\]]*)\]/gmu)) {
        tables += 1;
        for (const [, word] of table[1].matchAll(/'([a-z][a-z-]*)'/gu)) {
          // A moved verb answers with where it went; it is not documented as a form.
          if (source.includes(`mc ${verb} ${word} is now`)) continue;
          assert.ok(documented.has(`${verb} ${word}`), `mc ${verb} ${word} is routed but not in IN FULL`);
        }
      }
    }
    assert.ok(tables >= 5, `only ${tables} dispatch tables found`);
  });

  it('catches what the parsers refuse: invented verbs, subcommands, flags and combinations', () => {
    for (const row of [
      '  mc programme <name>              invented verb',
      '  mc session-control               removed verb',
      '  mc models                        plural typo',
      '  mc dev archive                   invented subcommand',
      '  mc work add <name> <repo> --testflight   another verb\'s flag',
      '  mc run start --force             a flag only stop takes',
      '  mc run start|stop [--force]      the same, through alternatives',
      '  mc goal show <programme>/<goal> --fictional  invented flag',
      '  mc goal frobnicate               invented subcommand',
      '  mc project criterion vanish <project> <n>',
      '  mc step done <project> <n> --fictional',
      '  mc run --sprint 2                invented runner flag',
      '  mc vault frobnicate              invented vault verb',
      '  mc --fictional                   invented page flag',
      '  mc hook frobnicate',
      '  mc language frobnicate',
      'usage — mc shot <dev|prod> <target>   a PNG\n          [--fictional]               invented, on a continuation line',
      'usage — mc log [<run>] [--failures]\n              [--verb <verb>] [--fictional] [--json]',
      'usage — mc shot next [<id>] [--keep]',
    ]) {
      assert.notDeepEqual(unrouted(row), [], row);
    }
  });

  it('catches a flag named in prose that the verb does not read, and attributes one said of another verb', () => {
    assert.notDeepEqual(unknownFlags('shot', '                                      --fictional/--scroll, in order'), []);
    assert.notDeepEqual(unknownFlags('log', '--open lists gate rounds; --fictional names the files.'), []);
    assert.deepEqual(unknownFlags('hook', 'npm run dev* → mc test dev --here --url, a scratch'), []);
    assert.notDeepEqual(unknownFlags('hook', 'npm run dev* → mc test dev --here --fictional, a scratch'), []);
    assert.deepEqual(unknownFlags('publish', 'as mc merge <repo> <pr> does — not with --no-merge, --json or --branch.'), []);
  });

  it('expands placeholders, alternatives and optional parts into command lines', () => {
    assert.deepEqual(expand('<repo> <pr> [<pr>...] [--check] [--json]'), [['x', '7'], ['x', '7', '8'], ['x', '7', '--check'], ['x', '7', '--json']]);
    assert.deepEqual(expand('start|stop [--force]'), [['start'], ['stop'], ['start', '--force']]);
    assert.deepEqual(expand('blocked [<project> <n>] --on <decision> | --on-project <project>'), [
      ['blocked', '--on', 'x'], ['blocked', 'x', '3', '--on', 'x'], ['blocked', '--on-project', 'x'],
    ]);
    assert.deepEqual(expand('[--measure <css> | @<name>]'), [[], ['--measure', 'x'], ['--measure', '@x']]);
    assert.deepEqual(expand('[--open [--theme light|dark]] [same flags]'), [[], ['--open'], ['--open', '--theme', 'light'], ['--open', '--theme', 'dark']]);
    assert.deepEqual(synopses('          mc run start|stop controls the runner'), []);
    assert.deepEqual(synopses('                                    mc can see'), []);
    assert.deepEqual(synopses('mc merge queues each pull request, in order'), []);
    assert.equal(synopses('usage — mc log [<run>]\n              [--verb <verb>] [--json]')[0].synopsis, '[<run>] [--verb <verb>] [--json]');
  });
});
