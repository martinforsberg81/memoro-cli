/**
 * `mc helper --collect` — the digest on stubbed script output and stubbed
 * routes, the delta against a previous digest, and the failure domains that
 * must stay separate: wrangler being unauthenticated costs the AI-provider
 * section and nothing else.
 *
 * The surface these fixtures imitate was measured against production on
 * 2026-08-29: `/admin/analysis` answers a bearer token, `/ping-d1` and
 * `/api/version` answer anyone, and `/api/admin/*` answers 401 to everything
 * but a browser session. `/admin/deploy/logs` was read here too until memoro
 * removed it with the GitHub deploy webhook behind it (2026-10-03).
 *
 * No network, no model, no memoro checkout: every source is injected.
 */
import assert from 'node:assert/strict';
import { sameCommit } from '../../src/mc/helper-collect.js';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { DEPLOYS_HEADER } from '../../src/mc/deploys.js';
import {
  analysisRows, collectHelper, computeDelta, deployState, digestName, errorRows, failingConditions,
  healthState, intakeArchiveDir, intakeDir, parseState, previousDigest, proposalsDir, readAdminToken, renderState,
  networkDown, NO_TOKEN, scriptFailure,
} from '../../src/mc/helper-collect.js';
import { readLiveVersion } from '../../src/mc/live-version.js';

const NOW = new Date('2026-08-29T06:00:00.000Z');

const SURVEY = {
  env: 'production',
  totalFingerprints: 3,
  returnedFingerprints: 3,
  byStatus: { new: { fingerprints: 2, occurrences: 41 }, resolved: { fingerprints: 1, occurrences: 2 } },
  topFingerprints: [
    { fingerprint: 'aaa111', normalizedMessage: 'D1_ERROR: no such column', count: 34, status: 'new', firstSeen: '2026-08-29T01:00:00Z', lastSeen: '2026-08-29T05:40:00Z' },
    { fingerprint: 'bbb222', normalizedMessage: 'fetch failed for usr_[redacted]', count: 7, status: 'new', firstSeen: '2026-08-28T22:00:00Z', lastSeen: '2026-08-29T04:00:00Z' },
    { fingerprint: 'ccc333', normalizedMessage: 'old and known', count: 2, status: 'resolved', firstSeen: '2026-08-20T00:00:00Z', lastSeen: '2026-08-28T09:00:00Z' },
  ],
};

const PROVIDER = {
  env: 'production',
  days: 1,
  reasons: [
    { provider: 'anthropic', model: 'claude-sonnet-5', task: 'distil', requestType: 'messages', status: 'error', errorCode: '400', providerErrorType: 'invalid_request_error', providerErrorMessage: 'too many tokens', callType: 'sync', calls: 12, firstSeen: '2026-08-29T02:00:00Z', lastSeen: '2026-08-29T05:00:00Z' },
  ],
};

const ANALYSIS = {
  ok: true,
  analyzedAt: '2026-08-28T02:03:01.959Z',
  errorsAnalyzed: 100,
  items: [
    { priority: 'critical', title: 'Distillation drops the last turn', category: 'bug', source_type: 'worker_error', occurrence_count: 34, affected_files: ['src/ai/distil.js'], source_refs: ['aaa111'], suggested_fix: 'Await the flush' },
  ],
};

const PING = { ok: true, d1: 'healthy', timings: { select1: 11, total: 43 }, slow: [] };

/** `/api/version` — public, three fields, and what the page reads afterwards. */
const LIVE_SHA = 'b3e65b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f00';
const VERSION = { commit: LIVE_SHA, build: 23533, build_time: '2026-08-29T04:05:00.000Z' };
/** The same answer from a build four days old: past the stale threshold. */
const OLD_VERSION = { ok: true, json: { ...VERSION, build_time: '2026-08-25T00:00:00.000Z' } };

/** A row of `deploys.tsv` as `mc deploy` writes one. */
const DEPLOYED_SHA = '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9012';
function deploysTsv(root, { sha = DEPLOYED_SHA, ended = '2026-08-29T05:00:00.000Z', live = sha } = {}) {
  mkdirSync(join(root, 'runner', 'log'), { recursive: true });
  writeFileSync(join(root, 'runner', 'log', 'deploys.tsv'), [
    DEPLOYS_HEADER.join('\t'),
    ['2026-08-29T04:50:00.000Z', ended, sha, '813', 'martin@laptop', 'deployed', live, '813', '', ''].join('\t'),
    '',
  ].join('\n'));
}

/** A work root plus a memoro checkout with the two admin scripts present. */
function ground() {
  const root = mkdtempSync(join(tmpdir(), 'mc-helper-'));
  const memoro = join(root, 'memoro');
  mkdirSync(join(memoro, 'scripts', 'admin'), { recursive: true });
  writeFileSync(join(memoro, 'scripts', 'admin', 'survey-errors.mjs'), '// stub\n');
  writeFileSync(join(memoro, 'scripts', 'admin', 'inspect-ai-provider-errors.mjs'), '// stub\n');
  return { root, memoro, env: { MC_WORK_ROOT: root, ADMIN_TOKEN: 'test-token' } };
}

/** Every source answering, and a record of what was asked of each. */
function stubs(overrides = {}) {
  const calls = { scripts: [], urls: [], auth: new Map() };
  const script = async (cwd, args) => {
    calls.scripts.push(args);
    if (args[0].includes('survey-errors')) return overrides.survey ?? { ok: true, json: SURVEY };
    return overrides.provider ?? { ok: true, json: PROVIDER };
  };
  const getJson = async (url, token) => {
    const path = new URL(url).pathname;
    calls.urls.push(url);
    calls.auth.set(path, token);
    if (path === '/admin/analysis') return overrides.analysis ?? { ok: true, json: ANALYSIS };
    if (path === '/api/version') return overrides.version ?? { ok: true, json: VERSION };
    return overrides.ping ?? { ok: true, json: PING };
  };
  const git = async () => (overrides.git === undefined ? 'abc1234 2026-08-28T20:00:00+02:00' : overrides.git);
  return { script, getJson, git, calls };
}

function collect(ground_, overrides = {}, options = {}) {
  const s = stubs(overrides);
  return collectHelper({
    env: ground_.env, now: NOW, memoro: ground_.memoro,
    script: s.script, getJson: s.getJson, git: s.git, ...options,
  }).then((result) => ({ ...result, calls: s.calls }));
}

describe('mc helper --collect — the sources', () => {
  it('reads production explicitly, never the local default', async () => {
    const g = ground();
    const { calls } = await collect(g);
    const survey = calls.scripts.find((args) => args[0].includes('survey-errors'));
    const provider = calls.scripts.find((args) => args[0].includes('inspect-ai-provider'));
    assert.equal(survey[survey.indexOf('--env') + 1], 'production');
    assert.equal(provider[provider.indexOf('--env') + 1], 'production');
  });

  it('uses the admin-token surface, not the session-admin one', async () => {
    const g = ground();
    const { calls } = await collect(g);
    const paths = calls.urls.map((u) => new URL(u).pathname).sort();
    assert.deepEqual(paths, ['/admin/analysis', '/api/version', '/ping-d1']);
    assert.ok(!paths.some((p) => p.startsWith('/api/admin/')), '/api/admin/* answers 401 to a bearer token');
  });

  it('sends the token to the admin routes and nothing to the public probe', async () => {
    const g = ground();
    const { calls } = await collect(g);
    assert.equal(calls.auth.get('/admin/analysis'), 'test-token');
    assert.equal(calls.auth.get('/ping-d1'), '', 'the D1 probe needs no credential');
    assert.equal(calls.auth.get('/api/version'), '', 'what production says it is, is public');
  });

  it('never asks for a route that writes', async () => {
    const g = ground();
    const { calls } = await collect(g);
    assert.ok(!calls.urls.some((u) => u.includes('/ping-kv')), '/ping-kv writes a probe key');
    assert.match((await collect(g)).text, /KV health is behind `\/ping-kv`, which writes a probe key/u);
  });

  it('passes --since through to the error survey', async () => {
    const g = ground();
    const { calls } = await collect(g, {}, { since: '2026-08-27T00:00:00.000Z' });
    const survey = calls.scripts.find((args) => args[0].includes('survey-errors'));
    assert.equal(survey[survey.indexOf('--since') + 1], '2026-08-27T00:00:00.000Z');
  });

  it('creates the intake and proposals directories on first run', async () => {
    const g = ground();
    const result = await collect(g);
    assert.equal(result.path, join(intakeDir(g.env), 'errors-memoro-2026-08-29.md'));
    assert.ok(readFileSync(result.path, 'utf8').startsWith('# Errors and maintenance'));
    // Two rooms, not one inside the other: the digest lands in intake, and
    // proposals is its own directory beside it, made ready the same way.
    assert.ok(existsSync(proposalsDir(g.env)), 'the proposals directory was not made');
    assert.notEqual(proposalsDir(g.env), join(intakeDir(g.env), 'proposals'));
  });

  it('says in the file itself why the operations projection is absent', async () => {
    const g = ground();
    const result = await collect(g);
    assert.match(result.text, /## Not readable/u);
    assert.match(result.text, /operations\/status.*session-admin/su);
    assert.match(result.text, /401/u);
  });
});

describe('mc helper --collect — the failure domains', () => {
  it('keeps wrangler failing to itself', async () => {
    const g = ground();
    const result = await collect(g, { provider: { ok: false, error: 'wrangler d1 execute failed (1)' } });
    assert.match(result.text, /## AI-provider errors\n\n_could not read: wrangler d1 execute failed \(1\)_/u);
    assert.match(result.text, /\| `aaa111` \| 34 \|/u);
    assert.match(result.text, /D1: \*\*healthy\*\*/u);
    assert.equal(result.data.errors.error, undefined);
  });

  it('says so per section when a route refuses, and still writes the file', async () => {
    const g = ground();
    const result = await collect(g, { analysis: { ok: false, error: '/admin/analysis returned 401' } });
    assert.match(result.text, /## Analysis items\n\n_could not read: \/admin\/analysis returned 401_/u);
    assert.match(result.text, /\| `aaa111` \| 34 \|/u);
  });

  it('names a failed script by its exit code and first meaningful line, not its last', async () => {
    const g = ground();
    // The two shapes measured in the digests: `wranglerD1Json`'s three writes,
    // the last a pretty-printed JSON dump whose final line is a lone `}`
    // (2026-08-30), and an uncaught exception, whose last line is Node's
    // version banner (2026-09-15). Real child processes, through the real runner.
    writeFileSync(join(g.memoro, 'scripts', 'admin', 'inspect-ai-provider-errors.mjs'), [
      "process.stderr.write('wrangler d1 execute failed (1)\\n');",
      "process.stderr.write('stderr: X [ERROR] Authentication error [code: 10000]\\n');",
      "process.stderr.write('stdout: {\\n  \"error\": {\\n    \"code\": 10000\\n  }\\n}\\n');",
      'process.exit(1);',
    ].join('\n'));
    writeFileSync(join(g.memoro, 'scripts', 'admin', 'survey-errors.mjs'),
      "\nthrow new Error('D1_ERROR: no such table: error_groups');\n");
    const s = stubs();
    const result = await collectHelper({ env: g.env, now: NOW, memoro: g.memoro, getJson: s.getJson, git: s.git });
    assert.match(result.text, /## AI-provider errors\n\n_could not read: exit 1: wrangler d1 execute failed \(1\)_/u);
    assert.match(result.text, /## Error fingerprints\n\n_could not read: exit 1: Error: D1_ERROR: no such table: error_groups_/u);
    assert.doesNotMatch(result.text, /could not read: \}_|could not read: Node\.js/u);
  });

  it('reports a missing checkout rather than digesting an empty database', async () => {
    const g = ground();
    const result = await collect({ ...g, memoro: join(g.root, 'nowhere') });
    assert.match(result.text, /> no memoro checkout at .*nowhere/u);
    assert.match(result.text, /## Error fingerprints\n\n_could not read: no memoro checkout/u);
    assert.match(result.text, /origin\/main: not read from a local checkout/u);
  });
});

describe('mc helper --collect — the delta', () => {
  it('calls nothing new on the first digest', async () => {
    const g = ground();
    const result = await collect(g);
    assert.equal(result.data.delta.first, true);
    assert.match(result.text, /## New since the last digest\n\n_first digest — no baseline_/u);
  });

  it('names only what the previous digest did not carry', async () => {
    const g = ground();
    mkdirSync(intakeDir(g.env), { recursive: true });
    writeFileSync(join(intakeDir(g.env), 'errors-2026-08-28.md'), [
      '# Errors and maintenance — 2026-08-28T06:00:00Z', '',
      renderState({ fingerprints: [{ fingerprint: 'ccc333', count: 2 }], failing: ['deploy-stale'] }),
    ].join('\n'));

    const result = await collect(g, { version: OLD_VERSION });
    assert.deepEqual(result.data.delta.fingerprints.map((f) => f.fingerprint), ['aaa111', 'bbb222']);
    assert.deepEqual(result.data.delta.failing, [], 'deploy-stale was already there yesterday');
    assert.match(result.text, /Baseline: `errors-2026-08-28\.md`/u);
    assert.match(result.text, /- ! `aaa111` — 34× new/u);
    assert.match(result.text, /- · `bbb222` — 7× new/u);
    assert.doesNotMatch(result.text.split('## Error fingerprints')[0], /ccc333/u);
  });

  it('marks a newly failing condition even when no fingerprint is new', async () => {
    const g = ground();
    mkdirSync(intakeDir(g.env), { recursive: true });
    writeFileSync(join(intakeDir(g.env), 'errors-2026-08-28.md'), renderState({
      fingerprints: SURVEY.topFingerprints.map((f) => ({ fingerprint: f.fingerprint, count: f.count })),
      failing: [],
    }));
    const result = await collect(g, { version: OLD_VERSION });
    assert.deepEqual(result.data.delta.fingerprints, []);
    assert.deepEqual(result.data.delta.failing, ['deploy-stale']);
    assert.match(result.text, /- ! `deploy-stale` — failing now, and not in the last digest/u);
  });

  it('says the machine reached nothing, not that D1 is down, when every request went unanswered', async () => {
    // 2026-09-15, 09-29 and 10-02: every fetch said `fetch failed` and the
    // digest still opened on `! d1-unreachable`; production was healthy.
    const g = ground();
    mkdirSync(intakeDir(g.env), { recursive: true });
    writeFileSync(join(intakeDir(g.env), 'errors-2026-08-28.md'), renderState({
      fingerprints: SURVEY.topFingerprints.map((f) => ({ fingerprint: f.fingerprint, count: f.count })),
      failing: [],
    }));
    const down = { ok: false, error: 'fetch failed', unreached: true };
    const result = await collect(g, { analysis: down, ping: down, version: down });
    assert.deepEqual(result.data.delta.failing, [], 'no request answered, so nothing was measured about D1');
    assert.doesNotMatch(result.text, /! `d1-unreachable`|failing d1-unreachable/u, 'neither in the alarm list nor the state');
    assert.match(result.text, /> This machine could not reach the network in this run: all 3 requests to production went unanswered \(fetch failed\)/u);
  });

  it('still raises d1-unreachable when anything else on the network answered', async () => {
    const g = ground();
    const down = { ok: false, error: 'fetch failed', unreached: true };
    const result = await collect(g, { ping: down, version: down });
    assert.deepEqual(failingConditions({ deploy: result.data.deploy, health: result.data.health }).includes('d1-unreachable'), true);
    assert.match(result.text, /failing d1-unreachable/u);
    assert.doesNotMatch(result.text, /could not reach the network/u);
  });

  it('does not call a refused request an unreached one', async () => {
    const g = ground();
    const result = await collect(g, {
      analysis: { ok: false, error: '/admin/analysis returned 503' },
      ping: { ok: false, error: '/ping-d1 returned 503' },
      version: { ok: false, error: '/api/version returned 503' },
    });
    assert.match(result.text, /failing d1-unreachable/u, 'production answered, so the network was reached');
    assert.doesNotMatch(result.text, /could not reach the network/u);
  });

  it('measures a second run on the same day against yesterday, not against itself', async () => {
    const g = ground();
    await collect(g);
    const again = await collect(g);
    assert.equal(again.data.previous, null, 'today\'s own file is not its own baseline');
    assert.equal(again.data.delta.first, true);
  });

  it('writes a state block the next digest can read back', async () => {
    const g = ground();
    const result = await collect(g, { version: OLD_VERSION });
    const state = parseState(result.text);
    assert.deepEqual([...state.fingerprints.keys()], ['aaa111', 'bbb222', 'ccc333']);
    assert.equal(state.fingerprints.get('aaa111'), 34);
    assert.deepEqual([...state.failing], ['deploy-stale']);
  });
});

describe('mc helper --collect — the deploy section', () => {
  it('reads no deploy log from production, only mc\'s record and /api/version', async () => {
    const g = ground();
    const { calls, text } = await collect(g);
    assert.ok(!calls.urls.some((u) => u.includes('/admin/deploy')), 'memoro removed /admin/deploy/logs');
    assert.doesNotMatch(text, /deploy log is empty|webhook|deploy:index/u);
    assert.doesNotMatch(text, /deploy-webhook-silent|deploy-failures/u);
  });

  it('takes the age from /api/version when mc has deployed nothing', async () => {
    const g = ground();
    const result = await collect(g);
    assert.equal(result.data.deploy.mc, null);
    assert.equal(result.data.deploy.age, 2, 'built 04:05, read 06:00');
    assert.equal(result.data.deploy.stale, false);
    const section = result.text.split('## Deploy')[1];
    assert.match(section, /- Age: 2 h\n/u);
    assert.match(section, /origin\/main in the local checkout: abc1234/u);
  });

  it('calls a deploy stale past the threshold, by the fresher of the two readings', () => {
    const live = { commit: LIVE_SHA, build: 1, buildTime: '2026-08-25T00:00:00.000Z' };
    const state = deployState(null, { now: NOW, live });
    assert.equal(state.age, 102);
    assert.equal(state.stale, true);
    assert.equal(state.staleAfterHours, 36);
    const row = { sha: DEPLOYED_SHA, ended: '2026-08-29T05:00:00.000Z', outcome: 'deployed' };
    const fresh = deployState(row, { now: NOW, live });
    assert.equal(fresh.age, 1, 'mc deployed an hour ago, whatever the build time says');
    assert.equal(fresh.stale, false);
  });

  it('says the age is unknown rather than stale when neither reading has a time', async () => {
    const g = ground();
    const result = await collect(g, { version: { ok: false, error: '/api/version returned 503' } });
    assert.equal(result.data.deploy.age, null);
    assert.equal(result.data.deploy.stale, false);
    assert.match(result.text, /- Age: unknown — neither mc's record nor `\/api\/version` gave a time/u);
    assert.doesNotMatch(result.text, /failing deploy-stale/u);
  });

  it('reads mc\'s own row', async () => {
    const g = ground();
    deploysTsv(g.root);
    const result = await collect(g);
    const state = result.data.deploy;
    assert.equal(state.mc.sha, DEPLOYED_SHA);
    assert.equal(state.mc.build, '813');
    assert.equal(state.mcAgeHours, 1);
    assert.equal(state.age, 1, 'the freshest of the two is what production is');
    const section = result.text.split('## Deploy')[1];
    assert.match(section, /mc's own last deploy: `1a2b3c4` build 813 — 2026-08-29 05:00 by martin@laptop, verified live `1a2b3c4` \(1 h ago\)/u);
  });

  it('says mc has deployed nothing rather than nothing at all', async () => {
    const g = ground();
    const section = (await collect(g)).text.split('## Deploy')[1];
    assert.match(section, /mc has deployed nothing itself/u);
  });

  it('names what production answers, and whether it is the sha mc shipped', async () => {
    const g = ground();
    deploysTsv(g.root);
    const section = (await collect(g)).text.split('## Deploy')[1];
    assert.match(section, /`\/api\/version`: build 23533 · `b3e65b6`, built 2026-08-29 04:05/u);
    assert.match(section, /\*\*Production is answering `b3e65b6`, not mc's last deploy `1a2b3c4`\.\*\*/u);
  });

  it('compares production with what mc\'s deploy verified live before the sha in its row', async () => {
    // 2026-09-19: the row said 017b4e7 and the script verified 8e431c6, and
    // production answering 8e431c6 is that deploy, not somebody else's.
    const g = ground();
    deploysTsv(g.root, { live: LIVE_SHA });
    const section = (await collect(g)).text.split('## Deploy')[1];
    assert.doesNotMatch(section, /Production is answering/u);
    assert.match(section, /mc's own last deploy: `1a2b3c4`.*verified live `b3e65b6`/u);
  });

  it('reads one commit at two lengths as one commit', () => {
    assert.equal(sameCommit('b3e65b6', 'b3e65b6f00aa11bb22cc33dd44ee55ff66778899'), true);
    assert.equal(sameCommit('b3e65b6', '1a2b3c4'), false);
    assert.equal(sameCommit('', 'b3e65b6'), false);
  });

  // The page is offline and instant, so this is the only place the answer is
  // fetched: what the helper heard, and when it heard it.
  it('caches /api/version where the page reads it', async () => {
    const g = ground();
    await collect(g);
    assert.deepEqual(readLiveVersion(g.env, NOW), {
      commit: LIVE_SHA,
      short: 'b3e65b6',
      build: 23533,
      build_time: '2026-08-29T04:05:00.000Z',
      fetched: NOW.toISOString(),
      age_seconds: 0,
    });
  });

  it('leaves the cache alone when the route does not answer', async () => {
    const g = ground();
    await collect(g, { version: { ok: false, error: '/api/version returned 503' } });
    assert.equal(readLiveVersion(g.env, NOW), null);
    assert.match((await collect(g, { version: { ok: false, error: '/api/version returned 503' } })).text,
      /`\/api\/version`: _could not read: \/api\/version returned 503_/u);
  });
});

describe('mc helper — the pure builders', () => {
  it('drops fingerprint-less rows and keeps the scrubbed message', () => {
    const rows = errorRows({ topFingerprints: [...SURVEY.topFingerprints, { fingerprint: '', count: 9 }] });
    assert.equal(rows.length, 3);
    assert.equal(rows[1].message, 'fetch failed for usr_[redacted]');
  });

  it('reads the analysis items the server already produced', () => {
    const rows = analysisRows(ANALYSIS);
    assert.equal(rows[0].priority, 'critical');
    assert.deepEqual(rows[0].refs, ['aaa111']);
    assert.deepEqual(analysisRows({ ok: true, items: [], message: 'No analysis available.' }), []);
  });

  it('reads D1 health from the public probe', () => {
    assert.deepEqual(healthState(PING), { d1: 'healthy', totalMs: 43, slow: [] });
    assert.equal(healthState({ ok: true, d1: 'error', timings: {} }).d1, 'error');
  });

  it('says how a script ended even when its stderr says nothing', () => {
    assert.equal(scriptFailure({ killed: true, signal: 'SIGTERM', code: null }, '', 180_000), 'timed out after 180 s, nothing on stderr');
    assert.equal(scriptFailure({ code: 2 }, '{\n}\n'), 'exit 2, nothing on stderr');
    assert.equal(scriptFailure({ code: 'ENOENT' }, ''), 'ENOENT, nothing on stderr');
  });

  it('counts only the requests that were asked, and only an unanswered one as down', () => {
    const down = { ok: false, error: 'fetch failed', unreached: true };
    const skipped = { ok: false, error: NO_TOKEN };
    assert.equal(networkDown([skipped, skipped, down, down]), true, 'no token: the two public probes decide');
    assert.equal(networkDown([skipped, skipped, down, { ok: true, json: {} }]), false);
    assert.equal(networkDown([skipped, skipped]), false, 'nothing asked is nothing measured');
    assert.deepEqual(failingConditions({ deploy: { error: 'x' }, health: { error: 'fetch failed' }, offline: true }), []);
  });

  it('names the conditions the delta watches', () => {
    assert.deepEqual(failingConditions({ deploy: { stale: true }, health: { d1: 'healthy' } }), ['deploy-stale']);
    assert.deepEqual(failingConditions({ deploy: { stale: false }, health: { error: 'timed out' } }), ['d1-unreachable']);
    assert.deepEqual(failingConditions({ deploy: { stale: false }, health: { d1: 'error' } }), ['d1-unhealthy']);
  });

  it('takes the threshold as the bar for `!`', () => {
    const previous = { name: 'errors-2026-08-28.md', text: renderState({ fingerprints: [] }) };
    const delta = computeDelta({ fingerprints: errorRows(SURVEY), previous, threshold: 5 });
    assert.deepEqual(delta.fingerprints.map((f) => f.loud), [true, true, false]);
  });

  it('reads the token from the environment before any file', () => {
    const g = ground();
    assert.equal(readAdminToken(g.memoro, { ADMIN_TOKEN: 'from-env' }), 'from-env');
    assert.equal(readAdminToken(g.memoro, {}), null, 'no file, no token, no throw');
  });

  it('names the digest by repository and date, and finds the newest earlier one', () => {
    const g = ground();
    assert.equal(digestName(NOW), 'errors-memoro-2026-08-29.md');
    assert.equal(digestName(NOW, 'memoro-cli'), 'errors-memoro-cli-2026-08-29.md');
    mkdirSync(intakeDir(g.env), { recursive: true });
    for (const name of ['errors-memoro-2026-08-26.md', 'errors-memoro-2026-08-28.md', 'notes.md']) {
      writeFileSync(join(intakeDir(g.env), name), name);
    }
    assert.equal(previousDigest(g.env, 'errors-memoro-2026-08-29.md').name, 'errors-memoro-2026-08-28.md');
    assert.equal(previousDigest({ MC_WORK_ROOT: join(g.root, 'nowhere') }, 'errors-memoro-2026-08-29.md'), null);
  });

  it('the two repositories never read each other\'s baseline', () => {
    const g = ground();
    mkdirSync(intakeDir(g.env), { recursive: true });
    for (const name of ['errors-memoro-2026-08-28.md', 'errors-memoro-cli-2026-08-27.md']) {
      writeFileSync(join(intakeDir(g.env), name), name);
    }
    // The whole reason the name carries the repository: a delta measured
    // against the other system's digest would call every fingerprint new.
    assert.equal(previousDigest(g.env, digestName(NOW), 'memoro').name, 'errors-memoro-2026-08-28.md');
    assert.equal(previousDigest(g.env, digestName(NOW, 'memoro-cli'), 'memoro-cli').name, 'errors-memoro-cli-2026-08-27.md');
  });

  it('memoro still finds the unprefixed digests it wrote before the rename', () => {
    const g = ground();
    mkdirSync(intakeDir(g.env), { recursive: true });
    // A day of delta would be lost if the rename orphaned yesterday's file:
    // the first run afterwards would find no baseline and report an ordinary
    // Tuesday's fingerprints as all new.
    writeFileSync(join(intakeDir(g.env), 'errors-2026-08-28.md'), 'legacy');
    assert.equal(previousDigest(g.env, digestName(NOW), 'memoro').name, 'errors-2026-08-28.md');
    // memoro-cli has no such history and must not adopt memoro's.
    assert.equal(previousDigest(g.env, digestName(NOW, 'memoro-cli'), 'memoro-cli'), null);
  });

  it('finds the baseline after the drain has archived it', () => {
    const g = ground();
    // The inbox drains: `runIntakeDrain` archives every file it takes, the
    // moment its turn ends. Yesterday's digest is therefore not in the inbox
    // on any day the backlog is clear, and a lookup that reads only the inbox
    // reports `first: true` for both repositories every day.
    mkdirSync(intakeDir(g.env), { recursive: true });
    const archive = intakeArchiveDir(g.env, new Date('2026-08-28T09:00:00Z'));
    mkdirSync(archive, { recursive: true });
    writeFileSync(join(archive, 'errors-memoro-2026-08-28.md'), 'archived');
    writeFileSync(join(archive, 'errors-memoro-cli-2026-08-27.md'), 'archived too');

    assert.equal(previousDigest(g.env, digestName(NOW), 'memoro').name, 'errors-memoro-2026-08-28.md');
    assert.equal(previousDigest(g.env, digestName(NOW, 'memoro-cli'), 'memoro-cli').name, 'errors-memoro-cli-2026-08-27.md');
  });

  it('prefers the inbox over the archive for the same date', () => {
    const g = ground();
    mkdirSync(intakeDir(g.env), { recursive: true });
    const archive = intakeArchiveDir(g.env, new Date('2026-08-28T09:00:00Z'));
    mkdirSync(archive, { recursive: true });
    writeFileSync(join(archive, 'errors-memoro-2026-08-28.md'), 'the filed copy');
    writeFileSync(join(intakeDir(g.env), 'errors-memoro-2026-08-28.md'), 'the live one');
    assert.equal(previousDigest(g.env, digestName(NOW), 'memoro').text, 'the live one');
  });

  it('picks the newest by DATE, not by string order across the two name shapes', () => {
    const g = ground();
    mkdirSync(intakeDir(g.env), { recursive: true });
    writeFileSync(join(intakeDir(g.env), 'errors-2026-08-28.md'), 'legacy, newer');
    writeFileSync(join(intakeDir(g.env), 'errors-memoro-2026-08-26.md'), 'prefixed, older');
    // Sorted as strings, `errors-memoro-…` comes after `errors-…` whatever
    // the dates say, and the baseline would silently be the older file.
    assert.equal(previousDigest(g.env, digestName(NOW), 'memoro').name, 'errors-2026-08-28.md');
  });
});
