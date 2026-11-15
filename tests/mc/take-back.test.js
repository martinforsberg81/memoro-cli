/**
 * The release reading `mc deploy` makes (src/mc/take-back.js).
 *
 * The fault protected: a reading that works only in a working tree that happens
 * to hold memoro's script. `mc deploy` runs in the bare repository
 * `~/mc/repos/memoro.git`, which has no working tree and so no script, and the
 * script has to come from the commit the pick is. Every reading here is made in
 * a bare clone, and in a working tree whose checked-out commit lacks
 * `scripts/release/`, with a stand-in script that prints a fixed D6 object.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  REASONS_SHOWN, READING_SCRIPT, takeBackCells, takeBackLines, takeBackReading, whyCell,
} from '../../src/mc/take-back.js';

const git = (cwd, ...args) => execFileSync('git', args, {
  cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
}).trim();

const CAN = { schema_version: 1, can_take_back: true, reasons: [] };
const reasonOf = (n) => ({
  kind: 'migration-before',
  what: `migrations/05${String(n).padStart(2, '0')}_x.sql: \`auto before\``,
  file: `migrations/05${String(n).padStart(2, '0')}_x.sql`,
  commits: [{ sha: `abc00000${n}`, subject: `Add x${n}` }],
});
const cannotOf = (count) => ({
  schema_version: 1, can_take_back: false, reasons: Array.from({ length: count }, (_, i) => reasonOf(i + 1)),
});

/** A script that prints `body` (a string) and exits with `code`; the arguments it was run with go to stderr when it fails. */
const scriptPrinting = (body, code = 0) => `process.stdout.write(${JSON.stringify(body)});\nprocess.exit(${code});\n`;

describe('takeBackReading — the script as the pick has it, run from git alone', () => {
  let root;
  let scratch;
  let work; // a working tree on a commit with no scripts/release/
  let bare; // a bare clone of it
  const shas = {};

  /** Commit `files` (path → text) on top of the working tree and return the sha. */
  const commit = (files, message) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(work, path, '..'), { recursive: true });
      writeFileSync(join(work, path), text);
    }
    git(work, 'add', '-A');
    git(work, 'commit', '-q', '-m', message);
    return git(work, 'rev-parse', 'HEAD');
  };

  before(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'take-back-test-')));
    scratch = join(root, 'scratch');
    mkdirSync(scratch);
    work = join(root, 'work');
    mkdirSync(work);
    git(work, 'init', '-q', '-b', 'main');
    git(work, 'config', 'user.email', 'test@example.com');
    git(work, 'config', 'user.name', 'Test');
    shas.base = commit({ 'README.md': 'live\n' }, 'live');
    shas.can = commit({ [READING_SCRIPT]: scriptPrinting(JSON.stringify(CAN)) }, 'script: can');
    shas.cannot = commit({ [READING_SCRIPT]: scriptPrinting(JSON.stringify(cannotOf(2))) }, 'script: cannot');
    shas.many = commit({ [READING_SCRIPT]: scriptPrinting(JSON.stringify(cannotOf(7))) }, 'script: many');
    shas.exit = commit({ [READING_SCRIPT]: 'console.error("Error: git said no");\nprocess.exit(1);\n' }, 'script: exits 1');
    shas.junk = commit({ [READING_SCRIPT]: scriptPrinting('not json at all') }, 'script: junk');
    shas.mismatch = commit({
      [READING_SCRIPT]: scriptPrinting(JSON.stringify({ schema_version: 1, can_take_back: true, reasons: [reasonOf(1)] })),
    }, 'script: says can with a reason');
    shas.version = commit({ [READING_SCRIPT]: scriptPrinting(JSON.stringify({ ...CAN, schema_version: 2 })) }, 'script: version 2');
    shas.kind = commit({
      [READING_SCRIPT]: scriptPrinting(JSON.stringify({ schema_version: 1, can_take_back: false, reasons: [{ kind: 'vibes', what: 'x' }] })),
    }, 'script: unknown kind');
    shas.slow = commit({ [READING_SCRIPT]: 'setTimeout(() => {}, 30000);\n' }, 'script: sleeps');
    // The script reads where it stands and where git is: what it prints is what it was run with.
    shas.echo = commit({
      [READING_SCRIPT]: `
const arg = (name) => process.argv[process.argv.indexOf(name) + 1];
process.stdout.write(JSON.stringify({ schema_version: 1, can_take_back: false, reasons: [{
  kind: 'config', what: [arg('--repo'), arg('--from'), arg('--to'), process.cwd()].join('|'), file: 'x', commits: [],
}] }));
`,
    }, 'script: echoes its arguments');
    // The working tree's checked-out commit has no scripts/release/ at all.
    shas.bare_tip = shas.echo;
    git(work, 'rm', '-q', '-r', '--', 'scripts');
    git(work, 'commit', '-q', '-m', 'the tip has no script');
    shas.noscript = git(work, 'rev-parse', 'HEAD');
    bare = join(root, 'bare.git');
    git(root, 'clone', '-q', '--bare', work, bare);
  });

  after(() => rmSync(root, { recursive: true, force: true }));

  const leftovers = () => readdirSync(scratch);
  const read = (to, extra = {}, path = bare) => takeBackReading({ path, from: shas.base, to, scratch, ...extra });

  it('reads a release that can be taken back, in a bare repository, from the script the pick has', async () => {
    const reading = await read(shas.can);
    assert.deepEqual(reading, { made: true, can: true, reasons: [], why: '' });
    assert.deepEqual(leftovers(), [], 'the directory the script ran in is gone');
  });

  it('reads the same from a working tree whose checked-out commit has no script', async () => {
    assert.equal(existsSync(join(work, READING_SCRIPT)), false, 'the working tree really has none');
    const reading = await read(shas.cannot, {}, work);
    assert.equal(reading.made, true);
    assert.equal(reading.can, false);
    assert.equal(reading.reasons.length, 2);
    assert.deepEqual(leftovers(), []);
  });

  it('a release that cannot is its reasons, each with kind, what, file and the commits, and a why that names them', async () => {
    const reading = await read(shas.cannot);
    assert.equal(reading.made, true);
    assert.equal(reading.can, false);
    assert.deepEqual(reading.reasons[0], { ...reasonOf(1) });
    assert.equal(reading.why, whyCell(reading.reasons));
    assert.match(reading.why, /^migration-before: migrations\/0501_x\.sql: `auto before` \(abc000001\); migration-before: migrations\/0502_x\.sql/u);
  });

  it('runs the script with the repository, the range and its own directory — not the checkout it was asked in', async () => {
    const reading = await read(shas.echo);
    const [repo, from, to, cwd] = reading.reasons[0].what.split('|');
    assert.equal(repo, bare);
    assert.equal(from, shas.base);
    assert.equal(to, shas.echo);
    assert.match(cwd, /\/mc-take-back-/u);
    assert.notEqual(cwd, work);
    assert.deepEqual(leftovers(), []);
  });

  it('reads the script of the pick, not the tip: a pick before the script existed is not read', async () => {
    const reading = await read(shas.base);
    assert.equal(reading.made, false);
    assert.equal(reading.can, false);
    assert.match(reading.why, /^reading not made: .*scripts\/release\/reading\.mjs is not on /u);
    assert.deepEqual(leftovers(), []);
  });

  it('a pick whose tree lost scripts/ is not read either', async () => {
    const reading = await read(shas.noscript);
    assert.equal(reading.made, false);
    assert.match(reading.why, /^reading not made: /u);
    assert.deepEqual(leftovers(), []);
  });

  it('a script that exits non-zero is no reading, and says its line', async () => {
    const reading = await read(shas.exit);
    assert.equal(reading.made, false);
    assert.equal(reading.can, false);
    assert.equal(reading.why, 'reading not made: scripts/release/reading.mjs exited 1: Error: git said no');
    assert.deepEqual(leftovers(), []);
  });

  it('output that is not the contract is no reading: not JSON, a wrong version, an unknown kind, can and reasons that disagree', async () => {
    const whys = {};
    for (const name of ['junk', 'version', 'kind', 'mismatch']) {
      const reading = await read(shas[name]);
      assert.equal(reading.made, false, name);
      assert.equal(reading.can, false, name);
      assert.match(reading.why, /^reading not made: /u, name);
      whys[name] = reading.why;
    }
    assert.match(whys.junk, /no JSON/u);
    assert.match(whys.version, /schema_version/u);
    assert.match(whys.kind, /not \{kind, what/u);
    assert.match(whys.mismatch, /disagree/u);
    assert.deepEqual(leftovers(), []);
  });

  it('a script that does not finish is stopped, and the reading is not made', async () => {
    const started = Date.now();
    const reading = await read(shas.slow, { timeoutMs: 300 });
    assert.equal(reading.made, false);
    assert.match(reading.why, /^reading not made: scripts\/release\/reading\.mjs did not finish in 0 s and was stopped$/u);
    assert.ok(Date.now() - started < 5000, 'it did not wait for the script');
    assert.deepEqual(leftovers(), []);
  });

  it('no live commit is no range: not made, and nothing is exported', async () => {
    let exported = false;
    const reading = await takeBackReading({
      path: bare, from: null, to: shas.can, scratch, exportTree: () => { exported = true; return null; },
    });
    assert.equal(reading.made, false);
    assert.equal(reading.why, 'reading not made: no live commit is known, so there is no range to read');
    assert.equal(exported, false);
    assert.deepEqual(leftovers(), []);
  });

  it('a repository that is not one is not read, and nothing is left behind', async () => {
    const reading = await read(shas.can, {}, join(root, 'nowhere'));
    assert.equal(reading.made, false);
    assert.match(reading.why, /^reading not made: /u);
    assert.deepEqual(leftovers(), []);
  });
});

describe('what mc says and keeps of a reading', () => {
  const reasons = (n) => cannotOf(n).reasons;
  const reading = (n) => ({ made: true, can: false, reasons: reasons(n), why: whyCell(reasons(n)) });

  it('whyCell: up to five reasons on one line, the rest counted', () => {
    assert.equal(REASONS_SHOWN, 5);
    assert.equal(whyCell([]), '');
    assert.equal(whyCell(reasons(5)).split('; ').length, 5);
    assert.ok(!/and \d+ more/u.test(whyCell(reasons(5))));
    const six = whyCell(reasons(8));
    assert.equal(six.split('; ').length, 6);
    assert.match(six, /; and 3 more$/u);
    assert.ok(!six.includes('\n') && !six.includes('\t'), 'a cell of a tab-separated file');
  });

  it('takeBackCells: yes, no with the why, and empty when no reading was asked for', () => {
    assert.deepEqual(takeBackCells({ made: true, can: true, reasons: [], why: '' }), { take_back: 'yes', take_back_why: '' });
    assert.deepEqual(takeBackCells(reading(1)), { take_back: 'no', take_back_why: reading(1).why });
    assert.deepEqual(
      takeBackCells({ made: false, can: false, reasons: [], why: 'reading not made: x' }),
      { take_back: 'no', take_back_why: 'reading not made: x' },
    );
    assert.deepEqual(takeBackCells(null), { take_back: '', take_back_why: '' });
  });

  it('takeBackLines: one line for can, a headline and reasons with commits for cannot, a count for the rest, nothing for no reading', () => {
    assert.deepEqual(takeBackLines(null), []);
    assert.deepEqual(takeBackLines({ made: true, can: true, reasons: [], why: '' }).length, 1);
    const one = takeBackLines(reading(1));
    assert.equal(one[0], 'mc: this release cannot be taken back — 1 change makes it so:');
    assert.match(one[1], /^mc:   migration-before: migrations\/0501_x\.sql: `auto before` \(abc000001 Add x1\)$/u);
    const many = takeBackLines(reading(7));
    assert.equal(many.length, 1 + 5 + 1);
    assert.equal(many.at(-1), 'mc:   … and 2 more');
    const unmade = takeBackLines({ made: false, can: false, reasons: [], why: 'reading not made: x' });
    assert.deepEqual(unmade, ['mc: this release is read as one that cannot be taken back — reading not made: x']);
  });
});
