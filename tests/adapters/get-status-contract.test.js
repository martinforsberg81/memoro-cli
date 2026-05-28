/**
 * Contract test for the `mc auth status` adapter surface (§11a).
 *
 * Every adapter that wants a row in `mc auth status` exports:
 *   - TOOL_NAME: string
 *   - STATUS_TIMEOUT_MS: number > 0
 *   - getStatus(opts?): Promise<{ installed, version, authenticated, hint, detailLines }>
 *
 * Rules tested here:
 *   - shape: types match expectations
 *   - hint invariant: when `authenticated` is null or false, `hint` must be
 *     non-null user-facing text. This is the rule that stops shipping
 *     "auth probe not implemented" placeholders into status output.
 *
 * Every adapter is exercised with stub deps so the test never depends on
 * the host having `claude` / `codex` on PATH.
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import * as claudeCode from '../../src/adapters/claude-code.js';
import * as codex from '../../src/adapters/codex.js';

const ADAPTERS = { 'claude-code': claudeCode, 'codex': codex };

function assertStatusShape(s, ctx) {
  assert.equal(typeof s.installed, 'boolean', `${ctx}: installed must be boolean`);
  assert.ok(s.version === null || typeof s.version === 'string', `${ctx}: version must be string|null`);
  assert.ok(
    s.authenticated === null || typeof s.authenticated === 'boolean',
    `${ctx}: authenticated must be true|false|null`,
  );
  if (s.authenticated === null || s.authenticated === false) {
    assert.ok(
      typeof s.hint === 'string' && s.hint.length > 0,
      `${ctx}: hint required when authenticated is null/false`,
    );
  }
  assert.ok(Array.isArray(s.detailLines), `${ctx}: detailLines must be an array`);
}

describe('adapter getStatus contract', () => {
  for (const [id, mod] of Object.entries(ADAPTERS)) {
    describe(id, () => {
      test('exports TOOL_NAME + STATUS_TIMEOUT_MS', () => {
        assert.equal(typeof mod.TOOL_NAME, 'string');
        assert.ok(mod.TOOL_NAME.length > 0);
        assert.equal(typeof mod.STATUS_TIMEOUT_MS, 'number');
        assert.ok(mod.STATUS_TIMEOUT_MS > 0);
        assert.equal(typeof mod.getStatus, 'function');
      });

      test('not-installed branch returns valid shape with hint', async () => {
        const s = await mod.getStatus({
          which: () => null,
          versionProbe: () => null,
          credentialsExist: () => false,
        });
        assert.equal(s.installed, false);
        assertStatusShape(s, `${id}/not-installed`);
        assert.ok(s.hint, 'not-installed must carry an install hint');
      });

      test('installed-and-authed branch returns valid shape', async () => {
        const s = await mod.getStatus({
          which: () => '/usr/local/bin/fake',
          versionProbe: () => '1.2.3',
          credentialsExist: () => true,
        });
        assert.equal(s.installed, true);
        assert.equal(s.version, '1.2.3');
        assertStatusShape(s, `${id}/installed`);
      });
    });
  }
});

describe('claude-code adapter — auth signal via credentials file existence', () => {
  test('authenticated:true when credentials file exists', async () => {
    const s = await claudeCode.getStatus({
      which: () => '/fake/claude',
      versionProbe: () => '2.1.152',
      credentialsExist: () => true,
    });
    assert.equal(s.authenticated, true);
    assert.equal(s.hint, null);
  });

  test('authenticated:false (with hint) when credentials file missing', async () => {
    const s = await claudeCode.getStatus({
      which: () => '/fake/claude',
      versionProbe: () => '2.1.152',
      credentialsExist: () => false,
    });
    assert.equal(s.authenticated, false);
    assert.ok(s.hint && /sign-in|complete/i.test(s.hint));
  });
});

describe('codex adapter — shallow probe with friendly hint', () => {
  test('installed → authenticated:null + friendly action hint', async () => {
    const s = await codex.getStatus({
      which: () => '/fake/codex',
      versionProbe: () => '0.5.0',
    });
    assert.equal(s.installed, true);
    assert.equal(s.authenticated, null);
    assert.ok(s.hint && /codex/i.test(s.hint));
    // The hint must not leak impl-jargon per coordinator decision.
    assert.ok(!/not implemented/i.test(s.hint), 'no impl-jargon in user-facing hint');
  });
});
