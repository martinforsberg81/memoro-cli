/**
 * `mc helper` — the verb, which is now two doors.
 *
 * The bare verb is the desk: a fresh foreground session in `~/mc/helper/`
 * with the `helper` role, and nothing collected, nothing read, no digest.
 * `--intake` is the old bare verb — collect, then the headless turn — and
 * `--collect` still stops after the file. The one thing worth holding down
 * hardest is that the desk reaches neither the collect step nor the model,
 * and that `--intake` still does both.
 *
 * No model here: the turn and the opener are stubs.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { helperLaunch, run } from '../../../src/mc/commands/helper.js';
import { describeDigest, unreadableSections } from '../../../src/mc/helper-collect.js';
import { describeTurn } from '../../../src/mc/helper-turn.js';
import { readCanonRole } from '../../../src/mc/roles.js';

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
    deploy: { silent: false, stale: false, consecutiveFailures: 0 },
    delta: { first: false, fingerprints: [], failing: [] },
    ...data,
  },
});

const TURN = (over = {}) => ({
  ok: true, note: 'success', tool: 'claude', model: 'sonnet', groundNotes: [],
  wrote: [], waiting: [], ...over,
});

const ROLE = { name: 'helper', model: 'sonnet', tools: ['claude', 'codex'], overlay: 'You are the helper: the desk…' };

async function invoke(argv, data = {}, turn = TURN(), over = {}) {
  const stdout = sink();
  const stderr = sink();
  const seen = {};
  const turned = {};
  const opened = {};
  const made = [];
  const code = await run(argv, {
    stdout,
    stderr,
    collect: async (options) => { Object.assign(seen, options, { called: true }); return RESULT(data); },
    turn: async (options) => { Object.assign(turned, options, { called: true }); return turn; },
    open: async (options) => { Object.assign(opened, options, { called: true }); return { ok: true, code: 0 }; },
    role: () => ROLE,
    mkdir: (path) => made.push(path),
    ...over,
  });
  return { code, stdout: stdout.text, stderr: stderr.text, seen, turned, opened, made };
}

describe('mc helper — the desk', () => {
  it('opens a fresh foreground session in ~/mc/helper/, and collects nothing', async () => {
    const result = await invoke([]);
    assert.equal(result.code, 0);
    assert.equal(result.seen.called, undefined, 'the desk reads no digest');
    assert.equal(result.turned.called, undefined, 'the desk runs no headless turn');
    assert.equal(result.opened.called, true);
    assert.match(result.opened.areaRoot, /\/helper$/u);
    assert.equal(result.opened.worktree.path, result.opened.areaRoot);
    assert.equal(result.opened.worktree.is_git, false);
    assert.equal(result.opened.pick, 'new');
    assert.equal(result.opened.verb, 'helper');
    assert.equal(result.opened.tool, 'claude');
    assert.equal(result.opened.defaultModel, 'sonnet');
    assert.match(result.opened.overlay, /^You are the helper/u);
  });

  /**
   * Both directories are made before the session starts: the room it stands
   * in, and the one place it is allowed to write. A session told to write
   * into a path that does not exist has one avoidable way to fail.
   */
  it('makes its room and the proposals directory first, and says where both are', async () => {
    const result = await invoke([]);
    assert.equal(result.made.length, 2);
    assert.match(result.made[0], /\/helper$/u);
    assert.match(result.made[1], /\/proposals$/u);
    assert.match(result.stdout, /tell it what is broken; proposals land in .*\/proposals/u);
  });

  it('takes the tool sugar and a model, like every other session verb', async () => {
    const result = await invoke(['--codex', '--model', 'fable']);
    assert.equal(result.opened.tool, 'codex');
    assert.equal(result.opened.model, 'fable');
  });

  /**
   * `--since` on the bare verb is somebody asking the desk for a digest
   * window. Silently ignoring it would open a session that is not the one
   * they asked for; the refusal says which door has that flag.
   */
  it('refuses the digest flags, and names the door they belong to', async () => {
    const result = await invoke(['--since', '2026-08-27']);
    assert.equal(result.code, 2);
    assert.equal(result.opened.called, undefined);
    assert.match(result.stderr, /--since is the digest's flag — say mc helper --intake --since/u);
    for (const flag of [['--limit', '10'], ['--threshold', '3']]) {
      assert.equal((await invoke(flag)).code, 2);
    }
  });

  it('stops rather than opening a session with no role to wear', async () => {
    const result = await invoke([], {}, TURN(), { role: () => null });
    assert.equal(result.code, 1);
    assert.equal(result.opened.called, undefined);
    assert.match(result.stderr, /the helper role is missing from this install/u);
  });

  it('opens by asking, and carries the date its filenames need', () => {
    const launch = helperLaunch({
      proposalsPath: '/work/proposals', role: ROLE, now: new Date('2026-08-30T09:00:00Z'),
    });
    assert.match(launch.prompt, /^Today is 2026-08-30\./u);
    assert.match(launch.prompt, /`\/work\/proposals` as `2026-08-30-<slug>\.md`/u);
    assert.match(launch.prompt, /Open by asking what he has\. Write nothing until you have it\./u);
    assert.equal(launch.model, 'sonnet');
  });
});

describe('the helper role', () => {
  it('ships with mc, on a cheap model, and is the desk — not the digest reader', () => {
    const role = readCanonRole('helper');
    assert.equal(role.model, 'sonnet');
    // What the desk must know and cannot derive: it takes Martin's own
    // reports, it adds, and it does not fix. A role no longer describes the
    // other role's session — neither can act on the other's existence.
    assert.match(role.overlay, /desk Martin walks up to/u);
    assert.match(role.overlay, /do not fix it/u);
    assert.match(role.overlay, /do not touch the proposals already waiting/u);
    assert.doesNotMatch(role.overlay, /You are not the intake turn/u);
  });

  /**
   * The frontmatter is the contract with `mc brief --collect`, which has to
   * say what kind of thing each proposal is without a model. Both roles that
   * write one dictate the same four keys, so the shape is asserted here as
   * well as in the intake role's own test.
   */
  // mc parses nothing out of a proposal any more, so the role dictates no
  // shape for a parser's sake. What it still has to say is where the file
  // goes and what its name looks like, because those two are mc's — the
  // directory it counts, and the date its ordering relies on.
  it('names where a proposal goes and what it is called, and dictates no format', () => {
    const { overlay } = readCanonRole('helper');
    assert.match(overlay, /~\/mc\/proposals\//u);
    assert.match(overlay, /<date>-<slug>\.md/u);
  });

  it('is a different role from the one the intake turn wears', () => {
    const intake = readCanonRole('intake');
    assert.equal(intake.model, 'sonnet');
    assert.match(intake.overlay, /^You are the intake turn/u);
    assert.notEqual(intake.overlay, readCanonRole('helper').overlay);
  });
});

describe('mc helper --intake', () => {
  it('collects and then runs the turn over the digest it just wrote', async () => {
    const result = await invoke(['--intake'], {}, TURN({
      wrote: [{ file: '2026-08-29-expose-operations.md' }],
      waiting: [{ file: '2026-08-29-expose-operations.md' }],
    }));
    assert.equal(result.code, 0);
    assert.equal(result.turned.called, true);
    assert.equal(result.opened.called, undefined, 'the intake half opens no session');
    // The file, not its text: the turn opens it itself.
    assert.equal(result.turned.file, '/tmp/mc/intake/errors-2026-08-29.md');
    assert.equal(result.turned.digestText, undefined);
    assert.match(result.stdout, /1 proposal, 1 waiting \(\d+\.\ds, claude sonnet\)/u);
    assert.match(result.stdout, /2026-08-29-expose-operations\.md/u);
    assert.match(result.stdout, /read them at the next brief/u);
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
      deploy: { error: '/admin/deploy/logs returned 401' },
    });
    assert.equal(result.code, 0, 'a partial digest is still a digest');
    assert.match(result.stderr, /AI-provider errors not read — wrangler d1 execute failed \(1\)/u);
    assert.match(result.stderr, /deploy logs not read — \/admin\/deploy\/logs returned 401/u);
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
  });

  it('lists the unreadable sections by name', () => {
    const found = unreadableSections({
      errors: { error: 'a' }, analysis: {}, provider: { error: 'b' }, health: {}, deploy: {},
    });
    assert.deepEqual(found.map(([name]) => name), ['error fingerprints', 'AI-provider errors']);
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
    const stdout = sink();
    const stderr = sink();
    const code = await run(argv, {
      stdout,
      stderr,
      collect: async (options) => {
        repos.push(options.repo);
        return { ...RESULT({}), repo: options.repo, path: `/tmp/mc/intake/errors-${options.repo}-2026-08-29.md` };
      },
      turn: async (options) => { turnedRepos.push(options.repo); return turn; },
      role: () => ROLE,
      mkdir: () => {},
      ...over,
    });
    return { code, repos, turnedRepos, stdout: stdout.text, stderr: stderr.text };
  };

  it('--collect writes a digest for each repository, memoro first', async () => {
    const result = await both(['--collect']);
    assert.equal(result.code, 0);
    assert.deepEqual(result.repos, ['memoro', 'memoro-cli']);
    assert.match(result.stdout, /errors-memoro-2026-08-29\.md/u);
    assert.match(result.stdout, /errors-memoro-cli-2026-08-29\.md/u);
  });

  it('runs one turn per digest, each told which repository it is reading', async () => {
    const result = await both(['--intake']);
    // `repo:` is the frontmatter key everything downstream routes on. A
    // single turn over both digests would have to guess it.
    assert.deepEqual(result.turnedRepos, ['memoro', 'memoro-cli']);
    assert.match(result.stdout, /memoro: 0 proposals?|memoro: no proposal/u);
    assert.match(result.stdout, /memoro-cli: /u);
  });

  it('a turn that fails does not cost the other repository its turn', async () => {
    let call = 0;
    const result = await both(['--intake'], TURN(), {
      turn: async (options) => {
        call += 1;
        return call === 1
          ? { ok: false, reason: 'quota', note: 'weekly limit reached', wrote: [], waiting: [] }
          : { ...TURN(), repo: options.repo };
      },
    });
    assert.equal(result.code, 1, 'the failure is still reported in the exit code');
    assert.match(result.stderr, /memoro: the intake turn did not finish — weekly limit reached/u);
    assert.match(result.stdout, /memoro-cli: /u, 'the second repository still ran');
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
