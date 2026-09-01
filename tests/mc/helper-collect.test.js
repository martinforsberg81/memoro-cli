/**
 * `mc helper --collect` — the digest on stubbed script output and stubbed
 * routes, the delta against a previous digest, and the failure domains that
 * must stay separate: wrangler being unauthenticated costs the AI-provider
 * section and nothing else.
 *
 * The surface these fixtures imitate was measured against production on
 * 2026-08-29: `/admin/analysis` and `/admin/deploy/logs` answer a bearer
 * token, `/ping-d1` answers anyone, and `/api/admin/*` answers 401 to
 * everything but a browser session.
 *
 * No network, no model, no memoro checkout: every source is injected.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  analysisRows, collectHelper, computeDelta, deployState, digestName, errorRows, failingConditions,
  healthState, intakeDir, parseState, previousDigest, proposalsDir, readAdminToken, renderState,
} from '../../src/mc/helper-collect.js';

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

/**
 * The shape `deploy:index` has when the webhook is actually writing: newest
 * first, so the failure at the head is one that landed *after* the last
 * success — which is what `checkDeployAge` counts.
 */
const DEPLOY = {
  ok: true,
  logs: [
    { run_id: '32', status: 'failure', branch: 'main', timestamp: '2026-08-29T05:00:00.000Z', environment: 'production' },
    { run_id: '31', status: 'success', branch: 'main', timestamp: '2026-08-29T04:00:00.000Z', environment: 'production' },
    { run_id: '30', status: 'failure', branch: 'main', timestamp: '2026-08-28T20:00:00.000Z', environment: 'production' },
  ],
  total: 3,
};

const PING = { ok: true, d1: 'healthy', timings: { select1: 11, total: 43 }, slow: [] };

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
    if (path === '/admin/deploy/logs') return overrides.deploy ?? { ok: true, json: DEPLOY };
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
    assert.deepEqual(paths, ['/admin/analysis', '/admin/deploy/logs', '/ping-d1']);
    assert.ok(!paths.some((p) => p.startsWith('/api/admin/')), '/api/admin/* answers 401 to a bearer token');
  });

  it('sends the token to the admin routes and nothing to the public probe', async () => {
    const g = ground();
    const { calls } = await collect(g);
    assert.equal(calls.auth.get('/admin/analysis'), 'test-token');
    assert.equal(calls.auth.get('/admin/deploy/logs'), 'test-token');
    assert.equal(calls.auth.get('/ping-d1'), '', 'the D1 probe needs no credential');
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
    const result = await collect(g, { deploy: { ok: false, error: '/admin/deploy/logs returned 401' } });
    assert.match(result.text, /## Deploy\n\n_could not read: \/admin\/deploy\/logs returned 401_/u);
    assert.match(result.text, /\| `aaa111` \| 34 \|/u);
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
      renderState({ fingerprints: [{ fingerprint: 'ccc333', count: 2 }], failing: ['deploy-failures'] }),
    ].join('\n'));

    const result = await collect(g);
    assert.deepEqual(result.data.delta.fingerprints.map((f) => f.fingerprint), ['aaa111', 'bbb222']);
    assert.deepEqual(result.data.delta.failing, [], 'deploy-failures was already there yesterday');
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
    const result = await collect(g);
    assert.deepEqual(result.data.delta.fingerprints, []);
    assert.deepEqual(result.data.delta.failing, ['deploy-failures']);
    assert.match(result.text, /- ! `deploy-failures` — failing now, and not in the last digest/u);
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
    const result = await collect(g);
    const state = parseState(result.text);
    assert.deepEqual([...state.fingerprints.keys()], ['aaa111', 'bbb222', 'ccc333']);
    assert.equal(state.fingerprints.get('aaa111'), 34);
    assert.deepEqual([...state.failing], ['deploy-failures']);
  });
});

describe('mc helper --collect — the deploy section', () => {
  it('computes the age itself and names the last success', async () => {
    const g = ground();
    const section = (await collect(g)).text.split('## Deploy')[1];
    assert.match(section, /Last successful production deploy: 2026-08-29 04:00 \(main, run 31\)/u);
    assert.match(section, /Age: 2 h/u);
    assert.match(section, /1 production deploy\(s\) failed since that success/u);
    assert.match(section, /origin\/main in the local checkout: abc1234/u);
  });

  it('calls an empty index a silent webhook, not a healthy deploy', async () => {
    const g = ground();
    const result = await collect(g, { deploy: { ok: true, json: { ok: true, logs: [], message: 'No deployment logs yet' } } });
    assert.match(result.text, /\*\*The deploy log is empty\.\*\*/u);
    assert.match(result.text, /webhook is writing nothing/u);
    assert.deepEqual(parseState(result.text).failing, new Set(['deploy-webhook-silent']));
  });

  it('agrees with checkDeployAge about what stale means', () => {
    const old = { logs: [{ run_id: '9', status: 'success', branch: 'main', timestamp: '2026-08-25T00:00:00.000Z', environment: 'production' }] };
    const state = deployState(old, { now: NOW });
    assert.equal(state.ageHours, 102);
    assert.equal(state.stale, true);
    assert.equal(state.staleAfterHours, 36);
    assert.equal(deployState({ logs: DEPLOY.logs }, { now: NOW }).stale, false);
  });

  it('treats an entry without an environment as production', () => {
    const state = deployState({ logs: [{ run_id: '1', status: 'success', timestamp: '2026-08-29T05:00:00.000Z' }] }, { now: NOW });
    assert.equal(state.lastSuccess.run_id, '1');
    assert.equal(state.stale, false);
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

  it('names the conditions the delta watches', () => {
    assert.deepEqual(failingConditions({ deploy: { silent: true }, health: { d1: 'healthy' } }), ['deploy-webhook-silent']);
    assert.deepEqual(failingConditions({ deploy: { stale: true, consecutiveFailures: 2 }, health: { d1: 'healthy' } }),
      ['deploy-stale', 'deploy-failures']);
    assert.deepEqual(failingConditions({ deploy: { error: 'timed out' }, health: { error: 'timed out' } }), ['d1-unreachable']);
    assert.deepEqual(failingConditions({ deploy: { stale: false, consecutiveFailures: 0 }, health: { d1: 'error' } }), ['d1-unhealthy']);
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
    assert.equal(previousDigest(intakeDir(g.env), 'errors-memoro-2026-08-29.md').name, 'errors-memoro-2026-08-28.md');
    assert.equal(previousDigest(join(g.root, 'nowhere'), 'errors-memoro-2026-08-29.md'), null);
  });

  it('the two repositories never read each other\'s baseline', () => {
    const g = ground();
    mkdirSync(intakeDir(g.env), { recursive: true });
    for (const name of ['errors-memoro-2026-08-28.md', 'errors-memoro-cli-2026-08-27.md']) {
      writeFileSync(join(intakeDir(g.env), name), name);
    }
    // The whole reason the name carries the repository: a delta measured
    // against the other system's digest would call every fingerprint new.
    assert.equal(previousDigest(intakeDir(g.env), digestName(NOW), 'memoro').name, 'errors-memoro-2026-08-28.md');
    assert.equal(previousDigest(intakeDir(g.env), digestName(NOW, 'memoro-cli'), 'memoro-cli').name, 'errors-memoro-cli-2026-08-27.md');
  });

  it('memoro still finds the unprefixed digests it wrote before the rename', () => {
    const g = ground();
    mkdirSync(intakeDir(g.env), { recursive: true });
    // A day of delta would be lost if the rename orphaned yesterday's file:
    // the first run afterwards would find no baseline and report an ordinary
    // Tuesday's fingerprints as all new.
    writeFileSync(join(intakeDir(g.env), 'errors-2026-08-28.md'), 'legacy');
    assert.equal(previousDigest(intakeDir(g.env), digestName(NOW), 'memoro').name, 'errors-2026-08-28.md');
    // memoro-cli has no such history and must not adopt memoro's.
    assert.equal(previousDigest(intakeDir(g.env), digestName(NOW, 'memoro-cli'), 'memoro-cli'), null);
  });

  it('picks the newest by DATE, not by string order across the two name shapes', () => {
    const g = ground();
    mkdirSync(intakeDir(g.env), { recursive: true });
    writeFileSync(join(intakeDir(g.env), 'errors-2026-08-28.md'), 'legacy, newer');
    writeFileSync(join(intakeDir(g.env), 'errors-memoro-2026-08-26.md'), 'prefixed, older');
    // Sorted as strings, `errors-memoro-…` comes after `errors-…` whatever
    // the dates say, and the baseline would silently be the older file.
    assert.equal(previousDigest(intakeDir(g.env), digestName(NOW), 'memoro').name, 'errors-2026-08-28.md');
  });
});
