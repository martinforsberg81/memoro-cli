/**
 * `mc helper` — the eye. The desk it once carried is `mc martin` now
 * (reach/helper-goes-into-the-desk): every call that names neither `--intake`
 * nor `--collect` is refused with exit 2 before it reads a role, makes a
 * directory or opens a session. `--intake` is collect, then the headless turn,
 * and `--collect` stops after the file.
 *
 * No model here: the turn is a stub.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { run } from '../../../src/mc/commands/helper.js';
import { describeDigest, unreadableSections } from '../../../src/mc/helper-collect.js';
import { describeTurn } from '../../../src/mc/helper-turn.js';
import { readCanonRole } from '../../../src/mc/roles.js';
import { canonSkillsDir } from '../../../src/mc/skills.js';

function sink() {
  const chunks = [];
  return { write: (text) => chunks.push(text), get text() { return chunks.join(''); } };
}

const RESULT = (data) => ({
  path: '/tmp/mc/intake/errors-2026-08-29.md',
  text: '# Errors and maintenance',
  data: {
    notes: [],
    errors: { rows: [], byStatus: {} },
    analysis: { rows: [] },
    provider: { reasons: [] },
    health: {},
    deploy: { stale: false },
    delta: { first: false, fingerprints: [], failing: [] },
    ...data,
  },
});

const TURN = (over = {}) => ({
  ok: true, note: 'success', tool: 'claude', model: 'sonnet', groundNotes: [],
  wrote: [], waiting: [], ...over,
});

/**
 * The inbox as the drain finds it, and where it puts a file afterwards. The
 * real `drainIntake` runs — only its filesystem and its turn are the test's —
 * so the loop, the order and the archive are measured rather than replaced.
 */
async function invoke(argv, data = {}, turn = TURN(), over = {}) {
  const stdout = sink();
  const stderr = sink();
  const seen = {};
  const turned = {};
  const opened = {};
  const { inbox = ['errors-2026-08-29.md'], ...rest } = over;
  const moved = [];
  const code = await run(argv, {
    stdout,
    stderr,
    collect: async (options) => { Object.assign(seen, options, { called: true }); return RESULT(data); },
    turn: async (options) => { Object.assign(turned, options, { called: true }); return turn; },
    files: () => inbox,
    move: (from, to) => { moved.push([from, to]); return true; },
    open: async (options) => { Object.assign(opened, options, { called: true }); return { ok: true, code: 0 }; },
    ...rest,
  });
  return { code, stdout: stdout.text, stderr: stderr.text, seen, turned, opened, moved };
}

describe('mc helper — the desk is mc martin', () => {
  // The refusal comes before anything is read or made: every seam the old desk used throws if touched.
  const TOUCHED = (name) => () => { throw new Error(`${name} must not be called by a refused call`); };
  const refused = (argv) => invoke(argv, {}, TURN(), {
    open: TOUCHED('open'), role: TOUCHED('role'), mkdir: TOUCHED('mkdir'), routes: TOUCHED('routes'),
    collect: TOUCHED('collect'), drain: TOUCHED('drain'), turn: TOUCHED('turn'),
  });

  it('refuses the bare verb with exit 2, names mc martin and says the eye is unchanged', async () => {
    const result = await refused([]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /the desk is mc martin/u);
    assert.match(result.stderr, /mc helper --collect and mc helper --intake are unchanged/u);
    assert.equal(result.stdout, '');
  });

  it('refuses every call that names neither --intake nor --collect, and opens, reads and makes nothing', async () => {
    for (const argv of [['--new'], ['--resume'], ['--resume', 'abc123'], ['--bg'], ['--local'], ['--codex'], ['--claude'], ['--model', 'fable'],
      ['--since', '2026-08-27'], ['--limit', '10'], ['--threshold', '3'], ['--codex', '--model', 'fable', '--new']]) {
      const result = await refused(argv);
      assert.equal(result.code, 2, `[${argv}] exits 2`);
      assert.match(result.stderr, /mc martin/u, `[${argv}] names the desk`);
      assert.match(result.stderr, /mc helper --intake/u, `[${argv}] names the eye`);
      assert.equal(result.stdout, '', `[${argv}] writes nothing on stdout`);
    }
  });

  it('the helper role and its launch prompt are gone', async () => {
    const module = await import('../../../src/mc/commands/helper.js');
    assert.equal(module.helperLaunch, undefined);
    assert.equal(readCanonRole('helper'), null);
  });

  it('the intake turn still wears its own role', () => {
    const intake = readCanonRole('intake');
    assert.equal(intake.model, 'sonnet');
    assert.match(intake.overlay, /^You are the intake turn/u);
    assert.match(readFileSync(join(canonSkillsDir(), 'proposals.md'), 'utf8'), /Never touch a proposal already waiting/u);
  });
});

describe('mc helper --intake', () => {
  it('collects and then drains the inbox, archiving each file after its turn', async () => {
    const result = await invoke(['--intake'], {}, TURN({
      wrote: [{ file: '2026-08-29-mc-expose-operations.md' }],
      waiting: [{ file: '2026-08-29-mc-expose-operations.md' }],
    }));
    assert.equal(result.code, 0);
    assert.equal(result.turned.called, true);
    assert.equal(result.opened.called, undefined, 'the intake half opens no session');
    // The file, not its text and not its path: the turn stands in the inbox
    // and opens it itself.
    assert.equal(result.turned.file, 'errors-2026-08-29.md');
    assert.equal(result.turned.digestText, undefined);
    assert.equal(result.moved.length, 1);
    assert.match(result.moved[0][0], /\/intake\/errors-2026-08-29\.md$/u);
    assert.match(result.moved[0][1], /\/runner\/log\/intake\/\d{4}-\d{2}-\d{2}\/errors-2026-08-29\.md$/u);
    assert.match(result.stdout, /errors-2026-08-29\.md: 1 proposal, 1 waiting \(\d+s, claude sonnet\)/u);
    assert.match(result.stdout, /2026-08-29-mc-expose-operations\.md/u);
    assert.match(result.stdout, /each programme's plan session reads its own — .*\/<programme>\/proposals/u);
  });

  /**
   * The cap is the runner's, and the verb's for the same reason: three turns is
   * a bounded wait, and an inbox somebody dropped forty screenshots into is not
   * a thing to hold a terminal open through.
   */
  it('takes three, oldest first, and says how many are still waiting', async () => {
    const taken = [];
    const result = await invoke(['--intake'], {}, TURN(), {
      inbox: ['errors-2026-08-30.md', 'note.md', 'errors-2026-08-28.md', 'errors-2026-08-29.md'],
      turn: async (options) => { taken.push(options.file); return TURN(); },
    });
    assert.deepEqual(taken, ['errors-2026-08-28.md', 'errors-2026-08-29.md', 'errors-2026-08-30.md']);
    assert.equal(result.moved.length, 3);
    assert.match(result.stdout, /1 more in the inbox — run it again to take the next 3/u);
  });

  it('--collect is the script half and never reaches the model', async () => {
    const result = await invoke(['--collect']);
    assert.equal(result.code, 0);
    assert.equal(result.seen.called, true);
    assert.equal(result.turned.called, undefined);
    assert.equal(result.opened.called, undefined);
  });

  it('--intake --collect stops after the file too', async () => {
    const result = await invoke(['--intake', '--collect']);
    assert.equal(result.code, 0);
    assert.equal(result.turned.called, undefined);
  });

  it('says a quiet day cost nothing, and is still a success', async () => {
    const result = await invoke(['--intake'], {}, TURN({ waiting: [{ file: 'old.md' }] }));
    assert.equal(result.code, 0);
    assert.match(result.stdout, /no proposal — nothing in the file warranted one \(1 still waiting\)/u);
    assert.doesNotMatch(result.stdout, /next brief/u);
  });

  it('fails when the turn did not finish, and says what the session said', async () => {
    const result = await invoke(['--intake'], {}, TURN({ ok: false, note: 'quota', stderr: 'x\nweekly limit reached' }));
    assert.equal(result.code, 1);
    assert.match(result.stderr, /the intake turn did not finish — quota/u);
    assert.match(result.stderr, /weekly limit reached/u);
  });

  it('passes --model through to the turn', async () => {
    const result = await invoke(['--intake', '--model', 'opus']);
    assert.equal(result.turned.model, 'opus');
  });

  it('repeats what the ground could not be read from', async () => {
    const result = await invoke(['--intake'], {}, TURN({ groundNotes: ['memoro: could not list plans on origin/main'] }));
    assert.match(result.stderr, /could not list plans on origin\/main/u);
  });

  it('collects and prints the path, the time and the delta', async () => {
    const result = await invoke(['--collect'], {
      delta: { first: false, fingerprints: [{ fingerprint: 'a', count: 40, loud: true }], failing: ['deploy-stale'] },
    });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /^mc: \/tmp\/mc\/intake\/errors-2026-08-29\.md \(\d+\.\ds\) — /u);
    assert.match(result.stdout, /1 new fingerprint, 1 above the threshold, 1 newly failing condition\n$/u);
  });

  it('says the first digest has no baseline instead of claiming a delta', async () => {
    const result = await invoke(['--collect'], {
      delta: { first: true, fingerprints: [], failing: [] },
      errors: { rows: [{ fingerprint: 'a' }, { fingerprint: 'b' }], byStatus: {} },
    });
    assert.match(result.stdout, /first digest, 2 fingerprints — no baseline yet/u);
  });

  it('complains on stderr about every section it could not read', async () => {
    const result = await invoke(['--collect'], {
      provider: { reasons: [], error: 'wrangler d1 execute failed (1)' },
      analysis: { rows: [], error: '/admin/analysis returned 401' },
    });
    assert.equal(result.code, 0, 'a partial digest is still a digest');
    assert.match(result.stderr, /AI-provider errors not read — wrangler d1 execute failed \(1\)/u);
    assert.match(result.stderr, /analysis items not read — \/admin\/analysis returned 401/u);
  });

  it('normalises --since and passes the numbers through', async () => {
    const result = await invoke(['--collect', '--since', '2026-08-27', '--limit', '10', '--threshold', '3']);
    assert.equal(result.code, 0);
    assert.equal(result.seen.since, '2026-08-27T00:00:00.000Z');
    assert.equal(result.seen.limit, 10);
    assert.equal(result.seen.threshold, 3);
  });

  it('refuses a date it cannot read and a count that is not one', async () => {
    assert.equal((await invoke(['--collect', '--since', 'yesterday'])).code, 2);
    assert.equal((await invoke(['--collect', '--limit', '0'])).code, 2);
    assert.equal((await invoke(['--collect', '--threshold', 'many'])).code, 2);
    assert.equal((await invoke(['--collect', 'extra'])).code, 2);
    assert.equal((await invoke(['--collect', '--purge'])).code, 2);
    assert.match((await invoke(['--collect', '--purge'])).stderr, /usage — mc helper/u);
  });

  it('says what the turn produced in one line', () => {
    assert.equal(describeTurn({ wrote: [], waiting: [] }), 'no proposal — nothing in the file warranted one (0 still waiting)');
    assert.equal(describeTurn({ wrote: [1, 2], waiting: [1, 2, 3] }), '2 proposals, 3 waiting');
    assert.equal(describeTurn({ wrote: [{ file: '2026-08-29-mc-a.md' }], waiting: [1] }), '1 proposal, 1 waiting');
    assert.equal(describeTurn({ wrote: [{ file: '2026-08-29-a.md' }], waiting: [1] }), '1 proposal, 1 waiting — proposal 2026-08-29-a.md names no system (mc|memoro)');
  });

  it('lists the unreadable sections by name', () => {
    const found = unreadableSections({
      errors: { error: 'a' }, analysis: {}, provider: { error: 'b' }, health: {}, deploy: {},
      services: { error: 'c' }, operations: { error: 'd' },
    });
    assert.deepEqual(found.map(([name]) => name), ['error fingerprints', 'AI-provider errors', 'service health', 'operations']);
  });

  it('describes a quiet day as nothing new', () => {
    const line = describeDigest({
      delta: { first: false, fingerprints: [], failing: [] },
      errors: { rows: [] },
    });
    assert.equal(line, '0 new fingerprints');
  });
});

/**
 * Both repositories, every time.
 *
 * memoro's production is the deployed service; memoro-cli's is this machine.
 * For a week only the first was collected, so every failure in mc itself was
 * found by a person noticing it — and sixteen gate rounds stopping on a held
 * lease in one day was a feeling rather than a number.
 */
describe('mc helper --intake — both repositories', () => {
  const both = async (argv, turn = TURN(), over = {}) => {
    const repos = [];
    const turnedRepos = [];
    const turnedFiles = [];
    const stdout = sink();
    const stderr = sink();
    // The two digests the collect just wrote, waiting in the inbox like
    // anything else somebody put there.
    const inbox = ['errors-memoro-2026-08-29.md', 'errors-memoro-cli-2026-08-29.md'];
    const code = await run(argv, {
      stdout,
      stderr,
      collect: async (options) => {
        repos.push(options.repo);
        return { ...RESULT({}), repo: options.repo, path: `/tmp/mc/intake/errors-${options.repo}-2026-08-29.md` };
      },
      turn: async (options) => { turnedRepos.push(options.repo); turnedFiles.push(options.file); return turn; },
      files: () => inbox,
      move: () => true,
      role: () => ROLE,
      mkdir: () => {},
      ...over,
    });
    return { code, repos, turnedRepos, turnedFiles, stdout: stdout.text, stderr: stderr.text };
  };

  it('--collect writes a digest for each repository, memoro first', async () => {
    const result = await both(['--collect']);
    assert.equal(result.code, 0);
    assert.deepEqual(result.repos, ['memoro', 'memoro-cli']);
    assert.match(result.stdout, /errors-memoro-2026-08-29\.md/u);
    assert.match(result.stdout, /errors-memoro-cli-2026-08-29\.md/u);
  });

  it('runs one turn per file, and lets the name say which repository it is', async () => {
    const result = await both(['--intake']);
    assert.deepEqual(result.turnedFiles, ['errors-memoro-2026-08-29.md', 'errors-memoro-cli-2026-08-29.md']);
    // `repo:` is the frontmatter key everything downstream routes on, and
    // `repoOfFile` reads it out of the collector's own names — the drain does
    // not carry it, because most of what an inbox holds has no repository in
    // its name at all.
    assert.deepEqual(result.turnedRepos, [undefined, undefined]);
    assert.match(result.stdout, /errors-memoro-2026-08-29\.md: no proposal/u);
    assert.match(result.stdout, /errors-memoro-cli-2026-08-29\.md: /u);
  });

  it('a turn that fails does not cost the next file its turn', async () => {
    let call = 0;
    const result = await both(['--intake'], TURN(), {
      turn: async () => {
        call += 1;
        return call === 1
          ? { ok: false, reason: 'quota', note: 'weekly limit reached', wrote: [], waiting: [] }
          : TURN();
      },
    });
    assert.equal(result.code, 1, 'the failure is still reported in the exit code');
    assert.match(result.stderr, /errors-memoro-2026-08-29\.md: the intake turn did not finish — weekly limit reached/u);
    assert.match(result.stdout, /errors-memoro-cli-2026-08-29\.md: /u, 'the second file still ran');
  });

  it('names the repository on every stderr line, so a failure can be attributed', async () => {
    const result = await both(['--collect'], TURN(), {
      collect: async (options) => ({
        ...RESULT({}), repo: options.repo, path: `/tmp/${options.repo}.md`,
        data: { ...RESULT({}).data, notes: ['wrangler is not logged in'] },
      }),
    });
    assert.match(result.stderr, /mc: memoro: wrangler is not logged in/u);
    assert.match(result.stderr, /mc: memoro-cli: wrangler is not logged in/u);
  });
});
