/**
 * Tests for `resolveLaunch` (adapters/index.js) — the adapter-routed
 * launcher resolution the wrap-mode launcher consumes (Grounding Phase 3).
 *
 * resolveLaunch maps a tool name (short OR adapter ID) to the live adapter
 * + its launchSpec, and FAILS HIGH with a precise reason on every failure
 * mode (unknown / planned / missing-bin) rather than a silent no-op. These
 * are pure-ish and run in-process (Pattern 4).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { resolveLaunch } from '../../src/adapters/index.js';
import * as claudeCode from '../../src/adapters/claude-code.js';
import * as codex from '../../src/adapters/codex.js';
import { resolveEffectivePolicy } from '../../src/mc/policy.js';

describe('resolveLaunch', () => {
  it('resolves claude short name to the claude-code adapter + spec', () => {
    const r = resolveLaunch('claude');
    assert.equal(r.ok, true);
    assert.equal(r.id, 'claude-code');
    assert.equal(r.shortName, 'claude');
    assert.ok(r.adapter, 'live adapter attached');
    assert.equal(r.spec.bin, 'claude');
    assert.equal(r.spec.heartbeatSource, 'claude-code');
  });

  it('accepts the adapter ID form too (claude-code)', () => {
    const r = resolveLaunch('claude-code');
    assert.equal(r.ok, true);
    assert.equal(r.id, 'claude-code');
  });

  it('unknown tool fails high with reason=unknown + a hint', () => {
    const r = resolveLaunch('nonsense');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'unknown');
    assert.match(r.hint, /unknown tool/i);
  });

  it('planned-but-unimplemented tool fails high with reason=planned', () => {
    const r = resolveLaunch('gemini');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'planned');
    assert.equal(r.id, 'gemini-cli');
    assert.match(r.hint, /not implemented/i);
  });

  it('empty / null input fails high (never silently succeeds)', () => {
    assert.equal(resolveLaunch('').ok, false);
    assert.equal(resolveLaunch(null).ok, false);
    assert.equal(resolveLaunch(undefined).ok, false);
  });

  it('codex resolves when its binary is found', () => {
    // resolveLaunch calls the adapter's launchSpec() with no args, which
    // uses the real binary resolver. We can't assume codex is installed in
    // CI, so just assert the contract: either ok with a bin, or a clean
    // missing-bin failure — never a throw, never a silent pass.
    const r = resolveLaunch('codex');
    assert.equal(typeof r.ok, 'boolean');
    if (r.ok) {
      assert.equal(r.id, 'codex');
      assert.ok(r.spec.bin, 'ok implies a resolved binary');
      assert.equal(r.spec.heartbeatSource, 'codex');
    } else {
      assert.equal(r.reason, 'missing-bin');
      assert.match(r.hint, /codex/i);
    }
  });
});

describe('codex launchSpec — binary resolution', () => {
  it('returns bin=null + an install hint when the real binary is missing', () => {
    const spec = codex.launchSpec({ resolveBinary: () => null });
    assert.equal(spec.bin, null);
    assert.match(spec.installHint, /codex/i);
    assert.equal(spec.heartbeatSource, 'codex');
  });

  it('uses the resolved binary when present', () => {
    const spec = codex.launchSpec({ resolveBinary: () => '/usr/local/bin/codex' });
    assert.equal(spec.bin, '/usr/local/bin/codex');
  });

  it('args() preserves native resume subcommands and leaves startup message for PTY delivery', () => {
    const spec = codex.launchSpec({ resolveBinary: () => '/x/codex' });
    assert.deepEqual(spec.args(['resume', 'cx_123'], { startupMessage: 'grounding' }), ['resume', 'cx_123']);
  });

  it('resumeArgs uses Codex native resume by id', () => {
    assert.deepEqual(codex.resumeArgs({ sessionId: 'cx_123' }), ['resume', 'cx_123']);
  });

  it('args() allows empty launches; grounding is delivered through the owned PTY', () => {
    const spec = codex.launchSpec({ resolveBinary: () => '/x/codex' });
    assert.deepEqual(spec.args([]), []);
    assert.equal(spec.startupMessageDelivery, 'deferred-pty');
  });

  it('args() does not render default policy placeholders into launch flags', () => {
    const spec = codex.launchSpec({ resolveBinary: () => '/x/codex' });
    const effectivePolicy = resolveEffectivePolicy({ entry: { tool: 'codex' } });
    assert.deepEqual(spec.args([], { effectivePolicy }), []);
  });

  it('args() renders explicit workspace and approval policy without consuming the startup prompt', () => {
    const spec = codex.launchSpec({ resolveBinary: () => '/x/codex' });
    const effectivePolicy = resolveEffectivePolicy({
      entry: {
        tool: 'codex',
        policy: { permissions: { workspace: 'worktree', approval: 'never' } },
      },
    });
    assert.deepEqual(spec.args(['resume', 'cx_123'], {
      startupMessage: 'grounding',
      effectivePolicy,
    }), [
      'resume',
      'cx_123',
      '--sandbox',
      'workspace-write',
      '--ask-for-approval',
      'never',
    ]);
  });

  it('does not throw when the resolver throws (fails to bin=null)', () => {
    const spec = codex.launchSpec({ resolveBinary: () => { throw new Error('boom'); } });
    assert.equal(spec.bin, null);
  });
});

describe('codex renderPolicy', () => {
  it('maps explicit mc permissions to Codex launch args', () => {
    const effectivePolicy = resolveEffectivePolicy({
      entry: {
        tool: 'codex',
        policy: { permissions: { workspace: 'read-only', approval: 'on-request' } },
      },
    });
    assert.deepEqual(codex.renderPolicy(effectivePolicy), {
      launchArgs: ['--sandbox', 'read-only', '--ask-for-approval', 'on-request'],
      env: {},
      artefacts: [],
      support: codex.POLICY_SUPPORT,
      warnings: [],
    });
  });

  it('never renders Codex danger-full-access, even if workspace=full is configured', () => {
    const effectivePolicy = resolveEffectivePolicy({
      entry: {
        tool: 'codex',
        policy: { permissions: { workspace: 'full' } },
      },
    });
    const rendered = codex.renderPolicy(effectivePolicy);
    assert.deepEqual(rendered.launchArgs, ['--sandbox', 'workspace-write']);
    assert.ok(!rendered.launchArgs.includes('danger-full-access'));
    assert.match(rendered.warnings[0], /never grants full tool access/);
  });
});

describe('claude-code launchSpec — grounding args', () => {
  it('appends grounding through --append-system-prompt without dropping resume args', () => {
    const spec = claudeCode.launchSpec();
    assert.deepEqual(spec.args(['--resume'], { startupMessage: 'grounding' }), [
      '--resume',
      '--append-system-prompt',
      'grounding',
    ]);
    assert.equal(spec.startupMessageDelivery, 'launch-args');
  });

  it('resumeArgs uses Claude native resume by id', () => {
    assert.deepEqual(claudeCode.resumeArgs({ sessionId: 'cl_123' }), ['--resume', 'cl_123']);
  });
});
