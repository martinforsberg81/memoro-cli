/**
 * `mc deploy` — the reading, the one question, and the script under the lease.
 *
 * Nothing real is behind any of it: git, the version endpoint, the nightly
 * history, the prompt and `npm run deploy` are all handed in. The lease is
 * the exception and deliberately so — it is the claim this verb exists to
 * make, and the test harness already points MC_HOME at a throwaway directory,
 * so the real `repo-lease.js` is used and read back mid-deploy.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { deployPlan, lastDeployRow, parseDeployArgs, planLines, run } from '../../../src/mc/commands/deploy.js';
import { claimLease, readLease, releaseLease } from '../../../src/mc/repo-lease.js';

const SHA = '1a2b3c4d5e6f70819293a4b5c6d7e8f900112233';
const LIVE = '9f8e7d6c5b4a39281706f5e4d3c2b1a099887766';
const PATH = '/tmp/does-not-exist/memoro';
const REPOS = [{ name: 'memoro', path: PATH }, { name: 'memoro-cli', path: '/tmp/does-not-exist/memoro-cli' }];

function io() {
  const out = { stdout: '', stderr: '' };
  return { out, stdout: { write: (s) => { out.stdout += s; } }, stderr: { write: (s) => { out.stderr += s; } } };
}

/** git as the verb uses it: fetch, rev-parse, log, rev-list. */
function fakeGit({ sha = SHA, counts = {}, subject = 'the change that would ship', fetch = true } = {}) {
  const calls = [];
  const git = (cwd, args) => {
    calls.push({ cwd, args });
    if (args[0] === 'fetch') return fetch ? '' : null;
    if (args[0] === 'rev-parse') return sha;
    if (args[0] === 'log') return subject;
    if (args[0] === 'rev-list') {
      const range = args.at(-1);
      return Object.hasOwn(counts, range) ? String(counts[range]) : null;
    }
    return null;
  };
  git.calls = calls;
  return git;
}

const noNightly = () => ({ runs: 0, last: null, measured: null, red: [] });
const nightlyOn = (commit, red = 0) => () => ({
  runs: 1, last: null, red: [],
  measured: { at: '2026-09-03T02:00:00Z', outcome: red ? 'failed' : 'passed', commit, tests: 900, red },
});

function deps(extra = {}) {
  return {
    env: { ...process.env },
    repos: REPOS,
    git: fakeGit({ counts: { [`${LIVE}..${SHA}`]: 6 } }),
    fetchVersion: async () => ({ commit: LIVE, build: 812, build_time: '2026-09-01T10:00:00Z' }),
    lastDeploy: () => null,
    nightly: nightlyOn(SHA),
    interactive: () => true,
    ask: () => 'y',
    spawnDeploy: async () => ({ code: 0 }),
    ...extra,
  };
}

beforeEach(() => { releaseLease({ repoPath: PATH, force: true }); });

describe('mc deploy — the arguments', () => {
  it('takes --dry-run and --json, and nothing positional', () => {
    assert.deepEqual(parseDeployArgs(['--dry-run']), { dryRun: true, json: false, help: false });
    assert.match(parseDeployArgs(['memoro']).error, /takes no arguments \(memoro\)/u);
    assert.match(parseDeployArgs(['--force']).error, /unknown flag: --force/u);
  });

  it('refuses a stray argument with usage, exit 2', async () => {
    const { out, stdout, stderr } = io();
    assert.equal(await run(['memoro'], { ...deps(), stdout, stderr }), 2);
    assert.match(out.stderr, /mc deploy \[--dry-run\]/u);
  });
});

describe('mc deploy — what it says before it asks', () => {
  it('names the sha, the last deployed sha and the gap', async () => {
    const plan = await deployPlan({
      path: PATH,
      env: {},
      git: fakeGit({ counts: { [`${LIVE}..${SHA}`]: 6 } }),
      fetchVersion: async () => ({ commit: LIVE, build: 812, build_time: '2026-09-01T10:00:00Z' }),
      lastDeploy: () => null,
      nightly: nightlyOn(SHA),
    });
    assert.equal(plan.sha, SHA);
    assert.equal(plan.last.sha, LIVE);
    assert.equal(plan.last.source, 'api/version');
    assert.equal(plan.gap, 6);
    const text = planLines(plan).join('\n');
    assert.match(text, new RegExp(`would deploy memoro ${SHA}`, 'u'));
    assert.match(text, /live now 9f8e7d6 \(build 812\) — api\/version/u);
    assert.match(text, /6 commits would ship/u);
  });

  it('prefers the row mc wrote over what production says it is', async () => {
    const plan = await deployPlan({
      path: PATH,
      env: {},
      git: fakeGit({ counts: { [`${LIVE}..${SHA}`]: 2 } }),
      fetchVersion: async () => { throw new Error('must not be asked'); },
      lastDeploy: () => ({ sha: LIVE, build: '77', ended: '2026-09-02T08:00:00Z', outcome: 'deployed' }),
      nightly: noNightly,
    });
    assert.equal(plan.last.source, 'deploys.tsv');
    assert.equal(plan.gap, 2);
  });

  it('says plainly when the nightly measured another tree, and still asks', async () => {
    const older = 'abc1234000000000000000000000000000000000';
    const { out, stdout, stderr } = io();
    let asked = 0;
    const code = await run([], {
      ...deps({
        git: fakeGit({ counts: { [`${LIVE}..${SHA}`]: 6, [`${older}..${SHA}`]: 6 } }),
        nightly: nightlyOn(older),
        ask: () => { asked += 1; return 'y'; },
      }),
      stdout,
      stderr,
    });
    assert.equal(code, 0);
    assert.equal(asked, 1);
    assert.match(out.stdout, /the nightly measured abc1234, 6 commits ago; this tree was not measured whole/u);
  });

  it('says the nightly measured this tree when it did', async () => {
    const { out, stdout, stderr } = io();
    await run(['--dry-run'], { ...deps(), stdout, stderr });
    assert.match(out.stdout, /the nightly measured this tree 1a2b3c4 — 0 red/u);
  });

  it('--dry-run stops before the question, takes no lease and runs nothing', async () => {
    const { out, stdout, stderr } = io();
    let asked = 0;
    let ran = 0;
    const code = await run(['--dry-run'], {
      ...deps({ ask: () => { asked += 1; return 'y'; }, spawnDeploy: async () => { ran += 1; return { code: 0 }; } }),
      stdout,
      stderr,
    });
    assert.equal(code, 0);
    assert.equal(asked, 0);
    assert.equal(ran, 0);
    assert.equal(readLease(PATH).held, false);
    assert.match(out.stdout, /--dry-run — nothing was deployed/u);
  });

  it('--json is the same reading as one object', async () => {
    const { out, stdout, stderr } = io();
    await run(['--dry-run', '--json'], { ...deps(), stdout, stderr });
    const json = JSON.parse(out.stdout);
    assert.equal(json.sha, SHA);
    assert.equal(json.gap, 6);
    assert.equal(json.dry_run, true);
    assert.equal(json.nightly.this_tree, true);
  });
});

describe('mc deploy — the question', () => {
  it('asks once, naming the sha, and a no runs nothing', async () => {
    const { out, stdout, stderr } = io();
    const asks = [];
    let ran = 0;
    const code = await run([], {
      ...deps({
        ask: (prompt) => { asks.push(prompt); return 'n'; },
        spawnDeploy: async () => { ran += 1; return { code: 0 }; },
      }),
      stdout,
      stderr,
    });
    assert.equal(code, 1);
    assert.deepEqual(asks, ['deploy 1a2b3c4 to production? [y/N]']);
    assert.equal(ran, 0);
    assert.equal(readLease(PATH).held, false);
    assert.match(out.stdout, /nothing was deployed/u);
  });

  it('Enter is a no: only y or yes deploys', async () => {
    let ran = 0;
    for (const answer of [null, '', 'no', 'sure', 'Y']) {
      const { stdout, stderr } = io();
      // eslint-disable-next-line no-await-in-loop
      const code = await run([], {
        ...deps({ ask: () => answer, spawnDeploy: async () => { ran += 1; return { code: 0 }; } }),
        stdout,
        stderr,
      });
      assert.equal(code, answer === 'Y' ? 0 : 1, `answer ${JSON.stringify(answer)}`);
    }
    assert.equal(ran, 1);
  });

  it('without a terminal it deploys nothing and exits 2', async () => {
    const { out, stdout, stderr } = io();
    let ran = 0;
    const code = await run([], {
      ...deps({ interactive: () => false, spawnDeploy: async () => { ran += 1; return { code: 0 }; } }),
      stdout,
      stderr,
    });
    assert.equal(code, 2);
    assert.equal(ran, 0);
    assert.match(out.stderr, /no terminal here to ask/u);
  });
});

describe('mc deploy — the script under the lease', () => {
  it('runs npm run deploy in memoro with the environment and the terminal, lease held, then released', async () => {
    const { stdout, stderr } = io();
    const seen = [];
    const env = { ...process.env, MEMORO_DEPLOY_CONTAINERS: 'always' };
    const code = await run([], {
      ...deps({ env }),
      stdout,
      stderr,
      spawnDeploy: async (options) => {
        seen.push({ ...options, lease: readLease(PATH) });
        return { code: 0 };
      },
    });
    assert.equal(code, 0);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].cwd, PATH);
    assert.equal(seen[0].env.MEMORO_DEPLOY_CONTAINERS, 'always');
    assert.equal(seen[0].lease.held, true);
    assert.equal(seen[0].lease.errand, `deploy ${SHA}`);
    assert.equal(readLease(PATH).held, false);
  });

  it('returns the script\'s exit code, and releases the lease anyway', async () => {
    const { out, stdout, stderr } = io();
    const code = await run([], { ...deps({ spawnDeploy: async () => ({ code: 17 }) }), stdout, stderr });
    assert.equal(code, 17);
    assert.equal(readLease(PATH).held, false);
    assert.match(out.stderr, /npm run deploy exited 17/u);
  });

  it('releases the lease when the spawn itself throws', async () => {
    const { stdout, stderr } = io();
    await assert.rejects(run([], {
      ...deps({ spawnDeploy: async () => { throw new Error('spawn blew up'); } }),
      stdout,
      stderr,
    }), /spawn blew up/u);
    assert.equal(readLease(PATH).held, false);
  });

  it('refuses when somebody else holds the repository, and runs nothing', async () => {
    claimLease({ repoPath: PATH, errand: 'gate round #591', holder: { name: 'runner', kind: 'work-area' } });
    const { out, stdout, stderr } = io();
    let ran = 0;
    const code = await run([], {
      ...deps({ spawnDeploy: async () => { ran += 1; return { code: 0 }; } }),
      stdout,
      stderr,
    });
    assert.equal(code, 1);
    assert.equal(ran, 0);
    assert.match(out.stderr, /is held by runner/u);
    assert.match(out.stderr, /nothing was deployed/u);
    assert.equal(readLease(PATH).holder, 'runner');
  });

  it('says so and deploys nothing when the checkout has no origin/main', async () => {
    const { out, stdout, stderr } = io();
    const code = await run([], { ...deps({ git: fakeGit({ sha: null }) }), stdout, stderr });
    assert.equal(code, 1);
    assert.match(out.stderr, /has no origin\/main/u);
  });
});

describe('the last deploy mc made', () => {
  it('is the last deployed row of deploys.tsv, keyed by its header', () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-deploy-tsv-'));
    mkdirSync(join(root, 'runner', 'log'), { recursive: true });
    writeFileSync(join(root, 'runner', 'log', 'deploys.tsv'), [
      'started\tended\tsha\tbuild\tholder\toutcome',
      `2026-09-01T09:00:00Z\t2026-09-01T09:12:00Z\t${LIVE}\t77\tmartin\tdeployed`,
      `2026-09-02T09:00:00Z\t2026-09-02T09:01:00Z\t${SHA}\t\tmartin\tfailed`,
      '',
    ].join('\n'));
    const row = lastDeployRow({ MC_WORK_ROOT: root });
    assert.equal(row.sha, LIVE);
    assert.equal(row.build, '77');
  });

  it('is nothing at all when there is no file yet', () => {
    assert.equal(lastDeployRow({ MC_WORK_ROOT: mkdtempSync(join(tmpdir(), 'mc-deploy-empty-')) }), null);
  });
});
