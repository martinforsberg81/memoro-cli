/**
 * The ask reader (src/mc/ask-reader.js): the one session that answers `mc ask` when jev did not settle it.
 * The model, the tool, the session, the clock, the pid check and Git are injected (tests make no git call: the
 * listing Git would give is a model of `git ls-files`); the copy, the launch file and the removal are real files in
 * a temporary directory, and the hook that refuses a reserved act to the reader is the real `mc hook pre-tool`
 * entry. The copy against real Git is the independent probe of the goal's criterion 10, not a test.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import * as claude from '../../src/adapters/claude-code.js';
import {
  answerVerb, areaStandards, askDir, askReaderCall, askReaderPrompt, ASK_READER_ROLE, sectionOf, callDirOf, CALL_ENV, chooseAskReader, LAUNCH_FILE, LIMIT_MS, snapshotTree, TOKEN_ENV,
} from '../../src/mc/ask-reader.js';
import { DEFAULT_CATALOG } from '../../src/mc/model-config.js';
import { applyObservation, normaliseCapacity } from '../../src/mc/model-capacity.js';
import { TIMEOUT_EXIT } from '../../src/mc/run-plan.js';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'mc-cli.js');
const NOW = new Date('2026-11-15T10:00:00Z');
const AHEAD = '2026-11-15T15:00:00.000Z';
const SECRET = 'sk-live-SECRETVALUE123';
const TOKEN = 'b'.repeat(48);
const ID = 'call-fixture-01';
const OPTIONS = { a: 'Keep the wording', b: 'Change the wording' };
const DONE = { status: 0, stdout: '', stderr: '' };
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const sink = () => { const parts = []; return { write: (text) => parts.push(text), text: () => parts.join('') }; };
const win = (fraction_used, resets_at = AHEAD) => ({ fraction_used, resets_at });
const capacityOf = (claudeUsed, codexUsed) => {
  let state = applyObservation(normaliseCapacity(null), 'claude', { windows: { five_hour: win(claudeUsed), seven_day: win(claudeUsed) } }, NOW);
  state = applyObservation(state, 'codex', { windows: { primary: win(codexUsed), secondary: null }, models: [{ id: 'gpt-6.1-sol', efforts: ['high'] }] }, NOW);
  return state;
};
const BRIEF = '## Vad den säger\n\nSidan säger A.\n\n## Vad som föreslås\n\nB.\n\n## Vad som hittades\n\nC.\n';

/** A temporary root that can be removed after the copy made it read-only. */
function tmpRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'mc-ask-reader-test-'));
  t.after(() => { spawnSync('chmod', ['-R', 'u+w', root]); rmSync(root, { recursive: true, force: true }); });
  return root;
}

/**
 * A worktree on disk as Git would list it: a tracked file changed on disk, an untracked file, an ignored file that
 * the listing leaves out, and a secret in a note. `git` answers `ls-files` and records every call it is given.
 */
function worktree(root) {
  const dir = join(root, 'asker', 'memoro-cli');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, '.gitignore'), 'ignored.txt\n');
  writeFileSync(join(dir, 'src', 'a.txt'), 'dirty bytes\n');
  writeFileSync(join(dir, 'note.md'), `the key is ${SECRET}\n`);
  writeFileSync(join(dir, 'new.txt'), 'untracked bytes\n');
  writeFileSync(join(dir, 'ignored.txt'), 'ignored bytes\n');
  const calls = [];
  const git = (args) => {
    calls.push(args);
    return { status: 0, stdout: ['.gitignore', 'src/a.txt', 'note.md', 'new.txt'].join('\0') + '\0', stderr: '' };
  };
  return { dir, git, calls };
}

/** The call, its collaborators, and the files the call leaves. */
function setup(t, { session, trees = true, secrets = [SECRET] } = {}) {
  const root = tmpRoot(t);
  const { dir: source, git, calls } = worktree(root);
  const env = { PATH: process.env.PATH, HOME: root, MC_WORK_ROOT: root, MC_HOME: join(root, 'home'), MC_ROLE: 'build-session', MC_GOAL: 'p/g', MC_TOOL: 'claude', MC_MODEL: 'opus', MC_SCRATCH: join(root, 'scratch') };
  const rows = [];
  const deps = {
    now: () => NOW, alive: () => true, pid: 4242, id: () => ID, token: () => TOKEN, logRun: (row) => rows.push(row),
    catalog: { ...DEFAULT_CATALOG, providerPriority: 'auto' }, capacity: capacityOf(0.5, 0.5),
    launch: () => ({ ok: true, id: 'claude-code', shortName: 'claude', spec: { bin: '/fake/claude' }, adapter: claude }),
    billingRoute: () => ({ billing: 'plan' }), git,
    session: session ?? (async () => DONE),
  };
  const call = (extra = {}, over = {}) => askReaderCall({
    call: { question: 'Which wording?', options: OPTIONS, recommend: 'a' }, evidence: 'the asker looked', jevText: 'jev read two pages', goalName: 'p/g', programme: 'p',
    trees: trees ? [{ repo: 'memoro-cli', path: source }] : [], env, secrets, stderr: sink(), deps: { ...deps, ...extra }, ...over,
  });
  /** A session that records `argv` the way the reader's verb does, from the environment the call gave it. */
  const answers = (argv, { before = null, stdin = null } = {}) => async (spawned) => {
    if (before) before(spawned);
    const err = sink();
    const code = answerVerb({ argv, ctx: { stdout: sink(), stderr: err, env: spawned.env, now: NOW, readFile: () => stdin ?? BRIEF }, deps: { alive: () => true, now: NOW } });
    assert.equal(code, 0, err.text());
    return DONE;
  };
  return { root, source, env, rows, deps, call, answers, calls };
}

// -------------------------------------------------------------------------- the model

test('one way to ask: the reader is the decision list without the asker\'s own model, and the whole list when nothing else can run', () => {
  const catalog = { ...DEFAULT_CATALOG, providerPriority: 'auto' };
  const both = chooseAskReader({ catalog, capacity: capacityOf(0.5, 0.5), now: NOW, asker: { tool: 'claude', model: 'opus' } });
  assert.deepEqual([both.ok, both.candidate.tool, both.candidate.model], [true, 'codex', 'gpt-6.1-sol'], 'another model than the asker reads');
  const seen = [];
  const choose = (args) => { seen.push(args.catalog.decision.map((one) => one.model)); return { ok: true, candidate: args.catalog.decision[0] }; };
  chooseAskReader({ catalog, capacity: capacityOf(0.5, 0.5), now: NOW, asker: { tool: 'claude', model: 'opus' }, choose });
  chooseAskReader({ catalog, capacity: capacityOf(0.5, 0.5), now: NOW, asker: { tool: 'claude', model: 'fable' }, choose });
  chooseAskReader({ catalog, capacity: capacityOf(0.5, 0.5), now: NOW, asker: null, choose });
  assert.deepEqual(seen, [['gpt-6.1-sol'], ['opus', 'gpt-6.1-sol'], ['opus', 'gpt-6.1-sol']], 'the asker is taken out only when it is in the list');
  const empty = [];
  chooseAskReader({ catalog, capacity: capacityOf(0.5, 0.5), now: NOW, asker: { tool: 'claude', model: 'opus' }, choose: (args) => { empty.push(args.catalog.decision.length); return { ok: false, reason: 'none' }; } });
  assert.deepEqual(empty, [1, 2], 'when the others cannot run the whole list is asked');
});

// ------------------------------------------------------------------------ the copy

test('one way to ask: the copy holds the dirty bytes and the untracked file, not the ignored file, is read-only, redacts the key, and asks Git only to list', (t) => {
  const root = tmpRoot(t);
  const { dir: source, git, calls } = worktree(root);
  const into = join(root, 'copy');
  const done = snapshotTree({ source, into, secrets: [SECRET], git });
  assert.equal(done.ok, true);
  assert.equal(done.files, 4);
  assert.equal(readFileSync(join(into, 'src', 'a.txt'), 'utf8'), 'dirty bytes\n', 'the uncommitted change is copied as it is on disk');
  assert.equal(readFileSync(join(into, 'new.txt'), 'utf8'), 'untracked bytes\n', 'an untracked file is copied');
  assert.equal(existsSync(join(into, 'ignored.txt')), false, 'an ignored file is not');
  assert.equal(existsSync(join(into, '.git')), false, 'no Git state is copied');
  assert.equal(readFileSync(join(into, 'note.md'), 'utf8').includes(SECRET), false, 'a key-source value is redacted');
  assert.match(readFileSync(join(into, 'note.md'), 'utf8'), /^the key is \S*REDACTED/iu);
  assert.equal(statSync(join(into, 'src', 'a.txt')).mode & 0o222, 0, 'the copy is not writable');
  assert.deepEqual(calls, [['-C', source, 'ls-files', '-z', '--cached', '--others', '--exclude-standard']], 'the one Git call is a listing, in the source');
  assert.equal(readFileSync(join(source, 'src', 'a.txt'), 'utf8'), 'dirty bytes\n', 'the source is as it was');
});

test('one way to ask: the copy leaves out a file that is not text, too large, not a regular file or outside the tree, and fails when Git cannot list', (t) => {
  const root = tmpRoot(t);
  const { dir: source } = worktree(root);
  writeFileSync(join(source, 'binary.bin'), Buffer.from([0xff, 0xfe, 0x00, 0x80]));
  writeFileSync(join(source, 'big.txt'), 'x'.repeat(200));
  symlinkSync('/etc/hostname', join(source, 'link.txt'));
  const into = join(root, 'copy');
  const listing = (names) => () => ({ status: 0, stdout: `${names.join('\0')}\0`, stderr: '' });
  const done = snapshotTree({ source, into, secrets: [], maxBytes: 100, git: listing(['src/a.txt', 'binary.bin', 'big.txt', 'link.txt', 'gone.txt']) });
  assert.equal(done.ok, true);
  assert.equal(done.files, 1, 'a file gone from disk is skipped, not an error');
  assert.deepEqual(done.left.not_text, ['binary.bin']);
  assert.deepEqual(done.left.too_large, ['big.txt']);
  assert.deepEqual(done.left.not_a_file, ['link.txt']);
  for (const name of ['binary.bin', 'big.txt', 'link.txt', 'gone.txt']) assert.equal(existsSync(join(into, name)), false, name);
  const failed = snapshotTree({ source, into: join(root, 'other'), git: () => ({ status: 128, stdout: '', stderr: 'fatal: not a git repository' }) });
  assert.equal(failed.ok, false);
  assert.match(failed.reason, /git ls-files .* failed: fatal: not a git repository/u);
  const outside = snapshotTree({ source, into: join(root, 'third'), git: listing(['../escape.txt', 'src/a.txt']) });
  assert.deepEqual(outside.left.not_a_file, ['../escape.txt'], 'a name that leaves the copy is left out');
  assert.equal(existsSync(join(root, 'escape.txt')), false);
});

// ----------------------------------------------------------------------- the prompt

test('one way to ask: the prompt holds the question, the options with the recommendation, the evidence, what jev read and where the tree is', () => {
  const prompt = askReaderPrompt({
    id: ID, question: 'Which\nwording?', options: OPTIONS, recommend: 'a', evidence: 'looked at A', jevText: 'jev read X', goalName: 'p/g', readme: 'the programme page',
    documents: [{ path: 'docs/technical/x.md', label: 'standard', text: 'Rule one.' }], trees: [{ repo: 'memoro-cli' }], treeRoot: '/t/tree',
  });
  assert.match(prompt, new RegExp(`for goal p/g.*mc ask answer ${ID}`, 'u'));
  assert.match(prompt, /\/t\/tree\/memoro-cli/u);
  assert.match(prompt, /THE QUESTION\n\nWhich wording\?/u);
  assert.match(prompt, /a: Keep the wording {3}\(the asker recommends this\)\n {2}b: Change the wording\n/u);
  assert.match(prompt, /looked at A/u);
  assert.match(prompt, /WHAT JEV READ\n\njev read X/u);
  assert.match(prompt, /THE PROGRAMME PAGE\n\nthe programme page/u);
  assert.match(prompt, /DOCUMENT docs\/technical\/x\.md \(standard\)\n\nRule one\./u);
  const bare = askReaderPrompt({ id: ID, question: 'q', options: OPTIONS, recommend: 'b', evidence: '', jevText: '', trees: [], treeRoot: '/t/tree' });
  assert.match(bare, /nothing copied/u);
  assert.match(bare, /none supplied/u);
  assert.match(bare, /jev was not read/u);
  assert.doesNotMatch(bare, /THE GOAL|THE PROGRAMME PAGE/u);
});

test('one way to ask: the prompt carries the standards of the rule areas the goal has a stand on, read from the goal\'s worktree', (t) => {
  const root = tmpRoot(t);
  const goalDir = join(root, 'goals', 'g');
  const repo = join(goalDir, 'memoro-cli');
  mkdirSync(join(repo, '.mc'), { recursive: true });
  mkdirSync(join(repo, 'docs', 'technical'), { recursive: true });
  writeFileSync(join(repo, '.mc', 'areas.json'), JSON.stringify({ schema_version: 1, areas: [
    { id: 'reserved-acts', name: 'Reserved acts', covers: 'what headless may not do', standards: ['docs/technical/hooks.md', 'docs/technical/keys.md'], paths: ['src'], questions: [{ when: 'always', ask: 'which act?' }] },
    { id: 'ops', name: 'Operations', covers: 'the runner', standards: ['docs/technical/run.md'], paths: [], questions: [{ when: 'always', ask: 'which row?' }] },
  ] }));
  writeFileSync(join(repo, 'docs', 'technical', 'hooks.md'), '# Hooks\n\nIntro.\n\n## mc hook pre-tool\n\nThe pre-tool rule: a deploy is refused.\n\n### A sub part\n\nStill this section.\n\n## Another section\n\nNot this one.\n');
  const goal = { obligations: [
    { area: 'memoro-cli/reserved-acts', stand: 'touched', text: 'The reader can do less.', standard: 'memoro-cli/docs/technical/hooks.md#mc hook pre-tool' },
    { area: 'memoro-cli/ops', stand: 'untouched', text: 'No runner change.' },
    { area: 'memoro-cli/nowhere', stand: 'touched', text: 'An area no one declares.' },
  ] };
  const standards = areaStandards({ goal, goalDir });
  assert.deepEqual(standards.map((one) => [one.area, one.stand, one.pages]), [
    ['memoro-cli/reserved-acts', 'touched', ['docs/technical/hooks.md', 'docs/technical/keys.md']],
    ['memoro-cli/ops', 'untouched', ['docs/technical/run.md']],
    ['memoro-cli/nowhere', 'touched', []],
  ]);
  const prompt = askReaderPrompt({ id: ID, question: 'q', options: OPTIONS, recommend: 'a', evidence: '', jevText: '', goalName: 'p/g', standards, trees: [{ repo: 'memoro-cli' }], treeRoot: '/t/tree' });
  assert.match(prompt, /THE STANDARDS OF THE RULE AREAS THE GOAL HAS A STAND ON/u);
  assert.match(prompt, /AREA memoro-cli\/reserved-acts — touched: The reader can do less\.\n {2}its standards: \/t\/tree\/memoro-cli\/docs\/technical\/hooks\.md, \/t\/tree\/memoro-cli\/docs\/technical\/keys\.md\n/u);
  assert.match(prompt, /STANDARD memoro-cli\/docs\/technical\/hooks\.md#mc hook pre-tool \(the standard this stand names\)\n\n## mc hook pre-tool\n\nThe pre-tool rule: a deploy is refused\.\n\n### A sub part\n\nStill this section\.\n/u, 'the named section, with its sub-sections, is in the prompt');
  assert.doesNotMatch(prompt, /Not this one|Intro\./u, 'the rest of the page is not');
  assert.match(prompt, /AREA memoro-cli\/ops — untouched: No runner change\.\n {2}its standards: \/t\/tree\/memoro-cli\/docs\/technical\/run\.md\n/u);
  assert.match(prompt, /AREA memoro-cli\/nowhere — touched: An area no one declares\.\n {2}not read: memoro-cli declares no rule area nowhere/u);
  assert.equal(sectionOf('# A\n\n## B\n\nb\n', 'C'), null);
  assert.doesNotMatch(askReaderPrompt({ id: ID, question: 'q', options: OPTIONS, recommend: 'a', trees: [], treeRoot: '/t/tree' }), /THE STANDARDS OF THE RULE AREAS/u);
});

test('one way to ask: a stand\'s anchor names a heading with inline code by its text, and any heading by its GitHub-style slug', (t) => {
  const page = '# Hooks\n\n## `mc hook pre-tool`\n\nThe pre-tool rule.\n\n## One usage per verb\n\nOne usage.\n\n## Shared documents and the changelog\n\nThe changelog rule.\n\n## Other\n\nNot this.\n';
  assert.equal(sectionOf(page, 'mc hook pre-tool'), '## `mc hook pre-tool`\n\nThe pre-tool rule.', 'the heading\'s text with its code span stripped');
  assert.equal(sectionOf(page, '`mc hook pre-tool`'), '## `mc hook pre-tool`\n\nThe pre-tool rule.', 'the heading as written');
  assert.equal(sectionOf(page, 'mc-hook-pre-tool'), '## `mc hook pre-tool`\n\nThe pre-tool rule.', 'the slug of a heading with inline code');
  assert.equal(sectionOf(page, 'one-usage-per-verb'), '## One usage per verb\n\nOne usage.');
  assert.equal(sectionOf(page, 'shared-documents-and-the-changelog'), '## Shared documents and the changelog\n\nThe changelog rule.');
  assert.equal(sectionOf(page, 'one-usage'), null, 'a slug matches a whole heading, not a prefix of one');

  const root = tmpRoot(t);
  const goalDir = join(root, 'goals', 'g');
  const repo = join(goalDir, 'memoro-cli');
  mkdirSync(join(repo, '.mc'), { recursive: true });
  mkdirSync(join(repo, 'docs', 'technical'), { recursive: true });
  writeFileSync(join(repo, '.mc', 'areas.json'), JSON.stringify({ schema_version: 1, areas: [
    { id: 'reserved-acts', name: 'Reserved acts', covers: 'what headless may not do', standards: ['docs/technical/hooks.md'], paths: ['src'], questions: [{ when: 'always', ask: 'which act?' }] },
    { id: 'command-contract', name: 'Command contract', covers: 'usage', standards: ['docs/technical/hooks.md'], paths: ['src'], questions: [{ when: 'always', ask: 'which verb?' }] },
  ] }));
  writeFileSync(join(repo, 'docs', 'technical', 'hooks.md'), page);
  const standards = areaStandards({ goalDir, goal: { obligations: [
    { area: 'memoro-cli/reserved-acts', stand: 'touched', text: 'Refusals hold.', standard: 'memoro-cli/docs/technical/hooks.md#mc hook pre-tool' },
    { area: 'memoro-cli/command-contract', stand: 'touched', text: 'One usage.', standard: 'memoro-cli/docs/technical/hooks.md#one-usage-per-verb' },
  ] } });
  assert.deepEqual(standards.map((one) => [one.section?.text ?? null, one.problem]), [
    ['## `mc hook pre-tool`\n\nThe pre-tool rule.', null],
    ['## One usage per verb\n\nOne usage.', null],
  ]);
  const prompt = askReaderPrompt({ id: ID, question: 'q', options: OPTIONS, recommend: 'a', goalName: 'p/g', standards, trees: [{ repo: 'memoro-cli' }], treeRoot: '/t/tree' });
  assert.doesNotMatch(prompt, /has no section/u, 'the prompt does not say a section it found is missing');
});

// ---------------------------------------------------------------------- the launch

test('one way to ask: the reader is launched in the copy as the ask-reader role, headless, with the token only in its environment and its hash in the launch file', async (t) => {
  let seen = null;
  let during = null;
  const f = setup(t);
  const session = f.answers([ID, 'continue', 'a'], {
    before: (spawned) => {
      seen = spawned;
      const dir = callDirOf(f.env, ID);
      during = { launch: readFileSync(join(dir, LAUNCH_FILE), 'utf8'), tree: readFileSync(join(spawned.cwd, 'src', 'a.txt'), 'utf8'), note: readFileSync(join(spawned.cwd, 'note.md'), 'utf8') };
    },
  });
  const result = await f.call({ session });
  assert.equal(result.read, true, result.reason);
  assert.deepEqual([result.read, result.verdict.kind, result.verdict.key, result.tool, result.model], [true, 'continue', 'a', 'claude', 'opus']);
  assert.equal(seen.bin, '/fake/claude');
  assert.equal(seen.timeoutMs, LIMIT_MS);
  assert.equal(seen.group, true);
  assert.equal(seen.cwd, join(callDirOf(f.env, ID), 'tree', 'memoro-cli'), 'the reader works in the copy');
  assert.ok(seen.args.includes(join(callDirOf(f.env, ID), 'tree')), 'the copy is the one directory it may read besides its own');
  assert.deepEqual([seen.env.MC_ROLE, seen.env.MC_HEADLESS, seen.env.MC_TOOL, seen.env.MC_MODEL, seen.env[CALL_ENV], seen.env[TOKEN_ENV]], [ASK_READER_ROLE, '1', 'claude', 'opus', ID, TOKEN]);
  for (const key of ['MC_GOAL', 'MC_SCRATCH', 'MC_PROGRAMME', 'MC_REPO']) assert.equal(seen.env[key], undefined, `${key} is the asker's, not the reader's`);
  const launch = JSON.parse(during.launch);
  assert.equal(launch.token_sha256, sha256(TOKEN));
  assert.deepEqual([launch.id, launch.pid, launch.goal, launch.recommend, launch.options], [ID, 4242, 'p/g', 'a', OPTIONS]);
  assert.equal(during.launch.includes(TOKEN), false, 'the token is in no file');
  assert.equal(during.tree, 'dirty bytes\n');
  assert.equal(during.note.includes(SECRET), false, 'no key-source value in the copy');
  const prompt = JSON.stringify(seen.args);
  assert.ok(prompt.includes('Which wording?') && prompt.includes('jev read two pages') && prompt.includes('the asker looked'));
  assert.equal(prompt.includes(SECRET), false, 'no key-source value in the prompt');
  assert.equal(existsSync(callDirOf(f.env, ID)), false, 'the call directory and the copy are removed');
  assert.deepEqual(readdirSync(askDir(f.env)), []);
  const [row] = f.rows;
  assert.deepEqual([f.rows.length, row.kind, row.cls, row.tool, row.model, row.name, row.exit], [1, 'ask-reader', 'decision', 'claude', 'opus', 'ask:p/g', 0], 'one run row of kind ask-reader');
});

test('one way to ask: a call without a worktree launches in an empty tree, and a key in the launch file is redacted', async (t) => {
  const f = setup(t, { trees: false });
  let cwd = null;
  const result = await f.call({ session: f.answers([ID, 'continue', 'a'], { before: (spawned) => { cwd = spawned.cwd; } }) }, { call: { question: 'q', options: { a: 'x', b: `y ${SECRET}` }, recommend: 'a' } });
  assert.equal(result.read, true, result.reason);
  assert.equal(cwd, join(callDirOf(f.env, ID), 'tree'));
  const contained = [];
  const g = setup(t, { trees: false });
  await g.call({ session: async () => { contained.push(readFileSync(join(callDirOf(g.env, ID), LAUNCH_FILE), 'utf8')); return DONE; } }, { call: { question: 'q', options: { a: 'x', b: `y ${SECRET}` }, recommend: 'a' } });
  assert.equal(contained[0].includes(SECRET), false, 'the launch file holds no key-source value');
  assert.match(contained[0], /REDACTED/iu);
});

test('one way to ask: a reading that ends without a verdict, times out or cannot start is unread, with the reason and nothing launched when no model can run', async (t) => {
  const f = setup(t);
  const none = await f.call({ session: async () => ({ status: 1, stdout: '', stderr: 'boom' }) });
  assert.deepEqual([none.read, none.tool, none.model], [false, 'claude', 'opus']);
  assert.match(none.reason, /ended without a verdict \(exit 1\)/u);
  assert.equal(existsSync(callDirOf(f.env, ID)), false, 'the call directory is removed');
  assert.equal(f.rows.length, 1, 'a reading that ran is a run row');

  const g = setup(t);
  const late = await g.call({ session: async () => ({ status: TIMEOUT_EXIT, stdout: '', stderr: '', timedOut: true }) });
  assert.equal(late.read, false);
  assert.match(late.reason, /did not answer within ten minutes/u);

  const h = setup(t);
  let launched = false;
  const refused = await h.call({ session: async () => { launched = true; return DONE; }, route: () => ({ ok: false, reason: 'every list is exhausted' }) });
  assert.deepEqual([refused.read, launched, h.rows.length], [false, false, 0]);
  assert.match(refused.reason, /no reader can run: every list is exhausted/u);

  const i = setup(t);
  const missing = await i.call({ session: async () => { launched = true; return DONE; }, launch: () => ({ ok: false, hint: 'claude is not installed' }) });
  assert.match(missing.reason, /claude is unavailable: claude is not installed/u);
  const gone = await i.call({ role: () => null });
  assert.match(gone.reason, /the ask-reader role is missing/u);
  const dear = await i.call({ billingRoute: () => ({ billing: 'unavailable', why: 'no budget left' }) });
  assert.match(dear.reason, /no budget left/u);
  assert.equal(launched, false);
  assert.equal(existsSync(askDir(i.env)), false, 'nothing is made for a reading that cannot start');

  const j = setup(t);
  const leaky = await j.call({ session: async () => ({ status: 1, stdout: '', stderr: `exploded ${SECRET}` }), snapshot: () => ({ ok: false, reason: `copy failed ${SECRET}` }) });
  assert.equal(leaky.read, false);
  assert.equal(leaky.reason.includes(SECRET), false, 'a reason never holds a key-source value');
});

test('one way to ask: the call directory that cannot be removed is left and said, the reading still answers', async (t) => {
  const f = setup(t);
  const err = sink();
  const result = await f.call({ session: f.answers([ID, 'continue', 'a']), discard: () => { throw new Error('busy'); } }, { stderr: err });
  assert.equal(result.read, true, result.reason);
  assert.match(err.text(), /the ask reader's call directory .* is left in place — busy/u);
});

// ---------------------------------------------------------------------- the verdict

/** A call in flight: its launch file, written as the call writes it. */
function inFlight(t, over = {}) {
  const root = tmpRoot(t);
  const env = { MC_WORK_ROOT: root, MC_ROLE: ASK_READER_ROLE, [CALL_ENV]: ID, [TOKEN_ENV]: TOKEN };
  const dir = callDirOf(env, ID);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, LAUNCH_FILE), JSON.stringify({ id: ID, token_sha256: sha256(TOKEN), pid: 4242, start: NOW.toISOString(), options: OPTIONS, recommend: 'a', goal: 'p/g', ...over }));
  const verb = (argv, { env: given = env, now = NOW, alive = () => true, stdin = BRIEF } = {}) => {
    const out = sink(), err = sink();
    const code = answerVerb({ argv, ctx: { stdout: out, stderr: err, env: given, readFile: () => stdin, now }, deps: { alive } });
    return { code, out: out.text(), err: err.text() };
  };
  const recorded = () => JSON.parse(readFileSync(join(dir, LAUNCH_FILE), 'utf8')).verdict ?? null;
  return { env, dir, verb, recorded };
}

test('one way to ask: answer records one verdict — continue with the recommendation, with another key and its why, a defect, a text', (t) => {
  const f = inFlight(t);
  const ok = f.verb([ID, 'continue', 'a']);
  assert.deepEqual([ok.code, ok.out], [0, `mc: answer continue recorded for call ${ID}\n`]);
  assert.deepEqual(f.recorded(), { kind: 'continue', key: 'a', why: null });

  const g = inFlight(t);
  assert.equal(g.verb([ID, 'continue', 'b']).code, 2, 'a key that is not the recommendation needs its why');
  assert.equal(g.recorded(), null);
  assert.equal(g.verb([ID, 'continue', 'b', '--why', 'docs/technical/x.md says so\nin two lines']).code, 0);
  assert.deepEqual(g.recorded(), { kind: 'continue', key: 'b', why: 'docs/technical/x.md says so in two lines' });

  const h = inFlight(t);
  assert.equal(h.verb([ID, 'defect', '--part', 'C2', '--found', 'src/x.js:4 contradicts it']).code, 0);
  assert.deepEqual(h.recorded(), { kind: 'defect', part: 'C2', found: 'src/x.js:4 contradicts it' });

  const i = inFlight(t);
  assert.equal(i.verb([ID, 'text', '--inside', 'a', '--text', 'docs/x.md "Aim"', '--file', '-']).code, 0);
  assert.deepEqual(i.recorded(), { kind: 'text', inside: 'a', text: 'docs/x.md "Aim"', brief: BRIEF.trim() });
  const j = inFlight(t);
  assert.equal(j.verb([ID, 'text', '--none', '--text', 'docs/x.md "Aim"', '--file', '-']).code, 0);
  assert.equal(j.recorded().inside, null);
});

test('one way to ask: answer redacts a key-source value in the reader\'s own words before it writes the launch file', (t) => {
  const f = inFlight(t);
  const out = sink(), err = sink();
  const code = answerVerb({ argv: [ID, 'text', '--none', '--text', `docs/x.md ${SECRET}`, '--file', '-'], ctx: { stdout: out, stderr: err, env: f.env, now: NOW, readFile: () => BRIEF.replace('B.', `B ${SECRET}.`), secrets: [SECRET] }, deps: { alive: () => true } });
  assert.equal(code, 0, err.text());
  const written = readFileSync(join(f.dir, LAUNCH_FILE), 'utf8');
  assert.equal(written.includes(SECRET), false, 'neither the text nor the brief carries the key value');
  assert.match(f.recorded().brief, /B \S*REDACTED/iu, 'the brief is kept with the value replaced');
});

test('one way to ask: answer is refused, and writes nothing, for another role, call, token, a dead or old call, a second answer or a malformed form', (t) => {
  const f = inFlight(t);
  const refuse = (argv, opts, pattern) => {
    const done = f.verb(argv, opts);
    assert.equal(done.code, 2, argv.join(' '));
    assert.match(done.err, pattern);
    assert.equal(f.recorded(), null, `${argv.join(' ')} wrote nothing`);
  };
  refuse([ID, 'continue', 'a'], { env: { ...f.env, MC_ROLE: 'build-session' } }, /only the ask-reader session an mc ask call launched/u);
  refuse(['other-call-77', 'continue', 'a'], {}, /this session answers call call-fixture-01, not other-call-77/u);
  refuse(['x', 'continue', 'a'], {}, /the first word is the call id/u);
  refuse([ID, 'continue', 'a'], { env: { ...f.env, [TOKEN_ENV]: 'c'.repeat(48) } }, /the token is not the one this call was launched with/u);
  refuse([ID, 'continue', 'a'], { env: { ...f.env, [TOKEN_ENV]: '' } }, /no launch token/u);
  refuse([ID, 'continue', 'a'], { alive: () => false }, /the call is not live/u);
  refuse([ID, 'continue', 'a'], { now: new Date(NOW.getTime() + LIMIT_MS + 1) }, /the call is not live/u);
  refuse([ID, 'continue', 'z'], {}, /z is not one of the options \(a, b\)/u);
  refuse([ID, 'continue'], {}, /continue names an option key/u);
  refuse([ID, 'continue', 'a', 'extra'], {}, /unexpected words: extra/u);
  refuse([ID, 'maybe'], {}, /the second word is continue, defect or text/u);
  refuse([ID, 'defect', '--part', 'C2'], {}, /defect needs --part/u);
  refuse([ID, 'text', '--text', 'x', '--file', '-'], {}, /--inside <key> .* or --none, one of them/u);
  refuse([ID, 'text', '--inside', 'a', '--none', '--text', 'x', '--file', '-'], {}, /one of them/u);
  refuse([ID, 'text', '--inside', 'z', '--text', 'x', '--file', '-'], {}, /--inside z is not one of the options/u);
  refuse([ID, 'text', '--inside', 'a', '--file', '-'], {}, /--text names the text/u);
  refuse([ID, 'text', '--inside', 'a', '--text', 'x'], {}, /text needs --file/u);
  refuse([ID, 'text', '--inside', 'a', '--text', 'x', '--file', '-'], { stdin: '## Vad den säger\n\nbara en del\n' }, /lacks the part/u);
  refuse([ID, '--bogus'], {}, /./u);
  assert.equal(f.verb([ID, 'continue', 'a']).code, 0);
  const second = f.verb([ID, 'continue', 'a']);
  assert.equal(second.code, 2);
  assert.match(second.err, /an answer is already recorded \(continue\)/u);
  assert.deepEqual(f.recorded(), { kind: 'continue', key: 'a', why: null }, 'the first answer stands');
  assert.match(second.err, /The forms:/u, 'a refusal says the forms');

  const none = inFlight(t, { goal: null });
  const noGoal = none.verb([ID, 'defect', '--part', 'C2', '--found', 'x']);
  assert.equal(noGoal.code, 2);
  assert.match(noGoal.err, /no goal, so there is no goal defect/u);
  const dir = join(f.env.MC_WORK_ROOT, 'elsewhere');
  const lost = answerVerb({ argv: [ID, 'continue', 'a'], ctx: { stdout: sink(), stderr: sink(), env: { ...f.env, MC_WORK_ROOT: dir }, now: NOW }, deps: { alive: () => true } });
  assert.equal(lost, 2, 'a call with no launch file has no reading in progress');
});

// ------------------------------------------------------------------------ the hook

test('one way to ask: the real mc hook pre-tool refuses a deploy and a credentials command to the reader in its copy, and lets a read through', async (t) => {
  const f = setup(t);
  const asks = [];
  const hook = (spawned, command) => {
    const done = spawnSync('node', [CLI, 'hook', 'pre-tool'], {
      cwd: spawned.cwd, env: { ...spawned.env, MC_WORK_ROOT: f.root }, encoding: 'utf8',
      input: JSON.stringify({ cwd: spawned.cwd, tool_name: 'Bash', tool_input: { command } }),
    });
    assert.equal(done.status, 0, done.stderr);
    return done.stdout.trim() ? JSON.parse(done.stdout).hookSpecificOutput : null;
  };
  const session = async (spawned) => {
    assert.ok(spawned.cwd.startsWith(join(f.root, 'runner', 'ask', ID, 'tree')), 'the cwd is in the copy');
    assert.equal(spawned.env.MC_HEADLESS, '1');
    assert.equal(spawned.env.MC_ROLE, ASK_READER_ROLE);
    for (const command of ['mc deploy memoro', 'mc test token --set sk-live-NOTAREALKEY99', 'cd x && mc deploy memoro']) {
      const out = hook(spawned, command);
      asks.push([command, out?.permissionDecision]);
      assert.match(out?.permissionDecisionReason ?? '', /is refused to an unattended session/u, command);
    }
    asks.push(['mc goal show p/g', hook(spawned, 'mc goal show p/g')?.permissionDecision ?? 'allow']);
    return f.answers([ID, 'continue', 'a'])(spawned);
  };
  const result = await f.call({ session });
  assert.equal(result.read, true, result.reason);
  assert.deepEqual(asks.map((one) => one[1]), ['deny', 'deny', 'deny', 'allow']);
});

test('one way to ask: no line the reader writes to a file or the run row holds a key-source value', async (t) => {
  const f = setup(t);
  const result = await f.call({ session: async (spawned) => { void spawned; return { status: 1, stdout: SECRET, stderr: SECRET }; } });
  assert.equal(result.read, false);
  assert.equal(JSON.stringify(result).includes(SECRET), false);
  assert.equal(JSON.stringify(f.rows).includes(SECRET), false);
  assert.equal(lstatSync(askDir(f.env)).isDirectory(), true);
  chmodSync(askDir(f.env), 0o700);
});
