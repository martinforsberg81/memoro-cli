/**
 * `mc deploy` — the reading, the one question, the script under the lease, and
 * the row it leaves behind.
 *
 * Nothing real is behind any of it: git, the version endpoint, the nightly
 * history, the prompt and `npm run deploy` are all handed in. The lease and
 * the record are the exceptions and deliberately so — they are what this verb
 * exists to leave behind, and MC_HOME and MC_WORK_ROOT both point at throwaway
 * directories here, so the real `repo-lease.js` and the real `deploys.tsv` are
 * written and read back.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  deployPlan, parseDeployArgs, planLines, readScriptOutput, run, spawnDeployDefault,
} from '../../../src/mc/commands/deploy.js';
import { lastAttempt, lastDeploy, readDeploys } from '../../../src/mc/deploys.js';
import { claimLease, readLease, releaseLease } from '../../../src/mc/repo-lease.js';

const SHA = '1a2b3c4d5e6f70819293a4b5c6d7e8f900112233';
const LIVE = '9f8e7d6c5b4a39281706f5e4d3c2b1a099887766';
const PATH = '/tmp/does-not-exist/memoro';
const REPOS = [{ name: 'memoro', path: PATH }, { name: 'memoro-cli', path: '/tmp/does-not-exist/memoro-cli' }];

/** The colours `deploy.mjs` prints its landmarks in, so the parsing is tested
 * against the bytes rather than against a cleaned-up version of them. */
const CYAN = '\u001B[36m'; const RESET = '\u001B[0m'; const DIM = '\u001B[2m';
const GREEN = '\u001B[32m'; const BOLD = '\u001B[1m'; const RED = '\u001B[31m';
const stepLine = (label) => `\n${CYAN}▸ ${label}${RESET}\n`;

/** A `deploy.mjs` that gets as far as `stopAt` and then either finishes or
 * falls over, printing what the real one prints on the way. */
function fakeScript({ steps = [], build = '23533', commit = SHA, verify = true, code = 0, failure = '' } = {}) {
  return async ({ onOutput }) => {
    for (const label of steps) onOutput(stepLine(label));
    if (code === 0) {
      if (verify) onOutput(`${DIM}  Live /api/version verified: build ${build} · ${commit}${RESET}\n`);
      onOutput(`\n${GREEN}${BOLD}✓ Deploy complete${RESET} ${DIM}build ${build} · ${commit}${RESET}\n`);
    } else {
      onOutput(`\n${RED}✗ Deploy failed${RESET}\n${DIM}${failure}${RESET}\n`);
    }
    return { code };
  };
}

const FULL_RUN = ['Deploy source preflight', 'wrangler deploy', 'wrangler deploy (tail-worker)', 'Verify live version'];

let work = null;

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
    env: { ...process.env, MC_WORK_ROOT: work },
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

beforeEach(() => {
  releaseLease({ repoPath: PATH, force: true });
  // A work root per test: the record is written for real, and one test's rows
  // are not another's.
  work = mkdtempSync(join(tmpdir(), 'mc-deploy-work-'));
});

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
    const env = { ...process.env, MC_WORK_ROOT: work, MEMORO_DEPLOY_CONTAINERS: 'always' };
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

describe('mc deploy — the record', () => {
  it('writes the row before the script starts, and completes it when it ends', async () => {
    const { out, stdout, stderr } = io();
    let midway = null;
    const script = fakeScript({ steps: FULL_RUN, build: '23533', commit: SHA });
    const code = await run([], {
      ...deps({
        holder: { name: 'martin@laptop', kind: 'shell' },
        spawnDeploy: async (options) => {
          // What a second terminal would see while the deploy is running.
          midway = lastAttempt({ MC_WORK_ROOT: work });
          return script(options);
        },
      }),
      stdout,
      stderr,
    });
    assert.equal(code, 0);

    assert.equal(midway.outcome, 'running');
    assert.equal(midway.sha, SHA);
    assert.equal(midway.holder, 'martin@laptop');
    assert.equal(midway.ended, '');

    const rows = readDeploys({ MC_WORK_ROOT: work });
    assert.equal(rows.length, 1, 'the same row, completed — not a second one');
    assert.equal(rows[0].started, midway.started);
    assert.equal(rows[0].outcome, 'deployed');
    assert.equal(rows[0].build, '23533');
    assert.equal(rows[0].live_commit, SHA);
    assert.equal(rows[0].live_build, '23533');
    assert.equal(rows[0].stopped_at, '');
    assert.equal(rows[0].note, '');
    assert.match(rows[0].ended, /^\d{4}-\d\d-\d\dT/u);
    assert.match(out.stdout, /deployed — build 23533 · 1a2b3c4 verified live/u);
  });

  it('a script that dies at wrangler deploy leaves a row that says where', async () => {
    const { out, stdout, stderr } = io();
    const code = await run([], {
      ...deps({
        spawnDeploy: fakeScript({
          steps: ['Deploy source preflight', 'Dependency preflight', 'wrangler deploy'],
          code: 1,
          failure: 'npx wrangler deploy exited 1',
        }),
      }),
      stdout,
      stderr,
    });
    assert.equal(code, 1);
    const row = lastAttempt({ MC_WORK_ROOT: work });
    assert.equal(row.outcome, 'failed');
    assert.equal(row.stopped_at, 'wrangler deploy');
    assert.equal(row.live_commit, '');
    assert.equal(row.build, '');
    assert.match(row.note, /exit 1 — npx wrangler deploy exited 1/u);
    assert.equal(lastDeploy({ MC_WORK_ROOT: work }), null, 'a failure is not what is live');
    assert.match(out.stderr, /exited 1 at wrangler deploy/u);
  });

  it('says so when a green deploy verified no live version', async () => {
    const { stdout, stderr } = io();
    await run([], { ...deps({ spawnDeploy: fakeScript({ steps: FULL_RUN, verify: false }) }), stdout, stderr });
    const row = lastDeploy({ MC_WORK_ROOT: work });
    assert.equal(row.outcome, 'deployed');
    assert.equal(row.build, '23533', 'the banner still says what shipped');
    assert.equal(row.live_commit, '', 'but nothing was verified against production');
    assert.match(row.note, /verified no live version/u);
  });

  it('a no at the question is a refused row, so the brief sees a deploy somebody meant', async () => {
    const { stdout, stderr } = io();
    await run([], { ...deps({ ask: () => 'n', holder: { name: 'martin', kind: 'shell' } }), stdout, stderr });
    const row = lastAttempt({ MC_WORK_ROOT: work });
    assert.equal(row.outcome, 'refused');
    assert.equal(row.sha, SHA);
    assert.equal(row.holder, 'martin');
    assert.match(row.note, /answered no/u);
    assert.equal(row.started, row.ended);
  });

  it('no terminal is a refused row too', async () => {
    const { stdout, stderr } = io();
    assert.equal(await run([], { ...deps({ interactive: () => false }), stdout, stderr }), 2);
    assert.match(lastAttempt({ MC_WORK_ROOT: work }).note, /no terminal/u);
  });

  it('a held repository is a refused row naming who holds it', async () => {
    claimLease({ repoPath: PATH, errand: 'gate round #591', holder: { name: 'runner', kind: 'work-area' } });
    const { stdout, stderr } = io();
    await run([], { ...deps(), stdout, stderr });
    const row = lastAttempt({ MC_WORK_ROOT: work });
    assert.equal(row.outcome, 'refused');
    assert.match(row.note, /held by runner — gate round #591/u);
  });

  it('--dry-run deploys nothing and records nothing', async () => {
    const { stdout, stderr } = io();
    await run(['--dry-run'], { ...deps(), stdout, stderr });
    assert.deepEqual(readDeploys({ MC_WORK_ROOT: work }), []);
  });

  it('the row it wrote is what the next reading calls live', async () => {
    const { stdout, stderr } = io();
    await run([], { ...deps({ spawnDeploy: fakeScript({ steps: FULL_RUN, build: '900' }) }), stdout, stderr });

    // No `lastDeploy` in deps this time: the verb's own default is the reader
    // in deploys.js, and it is reading the file the deploy above wrote.
    const second = deps({ git: fakeGit({ counts: { [`${SHA}..${SHA}`]: 0 } }) });
    delete second.lastDeploy;
    const { out, stdout: out2, stderr: err2 } = io();
    await run(['--dry-run'], { ...second, stdout: out2, stderr: err2 });
    assert.match(out.stdout, /live now 1a2b3c4 \(build 900\) — deploys\.tsv/u);
    assert.match(out.stdout, /nothing new would ship/u);
  });
});

describe('the spawn itself', () => {
  // The one place a real `npm run deploy` is started, against a package.json
  // that only prints. Everything the row keeps comes through this pipe, and a
  // tee that captured without echoing would leave the person watching a blank
  // terminal for twenty minutes — which no faked spawn could ever show.
  it('echoes the script to the terminal and captures it at the same time', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mc-deploy-spawn-'));
    const line = '\\n\\u001b[36m▸ wrangler deploy\\u001b[0m\\n';
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'not-really-memoro',
      private: true,
      scripts: { deploy: `node -e "process.stdout.write('${line}'); process.exit(3)"` },
    }));
    let captured = '';
    const { out, stdout, stderr } = io();
    const result = await spawnDeployDefault({
      cwd: dir, env: process.env, onOutput: (chunk) => { captured += chunk; }, stdout, stderr,
    });
    assert.equal(result.code, 3);
    assert.match(captured, /▸ wrangler deploy/u);
    assert.match(out.stdout, /▸ wrangler deploy/u);
    assert.equal(readScriptOutput(captured).stopped_at, 'wrangler deploy');
  });
});

describe('what the script said', () => {
  it('reads the step it stopped at and the version it verified, through the colours', () => {
    const said = readScriptOutput([
      stepLine('wrangler deploy'),
      stepLine('Verify live version'),
      `${DIM}  Live /api/version verified: build 23533 · ${SHA}${RESET}\n`,
      `\n${GREEN}${BOLD}✓ Deploy complete${RESET} ${DIM}build 23533 · ${SHA}${RESET}\n`,
    ].join(''));
    assert.equal(said.stopped_at, 'Verify live version');
    assert.equal(said.live_commit, SHA);
    assert.equal(said.live_build, '23533');
    assert.equal(said.build, '23533');
    assert.equal(said.verified, true);
  });

  it('keeps the failure message under ✗ Deploy failed', () => {
    const said = readScriptOutput(`${stepLine('Dependency preflight')}\n${RED}✗ Deploy failed${RESET}\n${DIM}npm run deps:ensure exited 1${RESET}\n`);
    assert.equal(said.stopped_at, 'Dependency preflight');
    assert.equal(said.failure, 'npm run deps:ensure exited 1');
    assert.equal(said.verified, false);
  });

  it('is empty cells and not a crash when the script says none of it', () => {
    assert.deepEqual(readScriptOutput('some other tool wrote this\n'), {
      stopped_at: '', build: '', live_commit: '', live_build: '', verified: false, failure: '',
    });
    assert.equal(readScriptOutput('').stopped_at, '');
    assert.equal(readScriptOutput(null).build, '');
  });
});
