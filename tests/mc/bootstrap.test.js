/** Tool bootstrap (mc-contract §7): install + custody sign-in planning. */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
  TOOL_PACKAGES,
  installPlanFor,
  hydratePlanFor,
  installTool,
} from '../../src/mc/bootstrap.js';

describe('bootstrap planning', () => {
  test('official package names are pinned (supply-chain lock)', () => {
    assert.equal(TOOL_PACKAGES.claude.packageName, '@anthropic-ai/claude-code');
    assert.equal(TOOL_PACKAGES.codex.packageName, '@openai/codex');
  });

  test('install plan covers exactly the known, missing tools', () => {
    const plan = installPlanFor({
      claude: { installed: false },
      codex: { installed: true, authenticated: null },
      gemini: { installed: false }, // no official target — never planned
    });
    assert.deepEqual(plan.map((p) => p.tool), ['claude']);
    assert.equal(plan[0].command, 'npm install -g @anthropic-ai/claude-code');
  });

  test('hydrate plan targets installed tools that are explicitly signed out', () => {
    const plan = hydratePlanFor({
      claude: { installed: true, authenticated: false },
      codex: { installed: true, authenticated: null }, // unknown → left alone
    });
    assert.deepEqual(plan.map((p) => p.tool), ['claude']);
  });

  test('empty/missing statuses plan nothing', () => {
    assert.deepEqual(installPlanFor({}), []);
    assert.deepEqual(hydratePlanFor({}), []);
  });
});

describe('installTool', () => {
  function fakeSpawn(exitCode, errorInstead = null) {
    return (cmd, args, opts) => {
      fakeSpawn.last = { cmd, args, opts };
      const child = new EventEmitter();
      queueMicrotask(() => {
        if (errorInstead) child.emit('error', errorInstead);
        else child.emit('close', exitCode);
      });
      return child;
    };
  }

  test('runs npm install -g on the pinned package with inherited stdio', async () => {
    const res = await installTool(TOOL_PACKAGES.claude, { spawnImpl: fakeSpawn(0) });
    assert.deepEqual(res, { ok: true, tool: 'claude' });
    assert.equal(fakeSpawn.last.cmd, 'npm');
    assert.deepEqual(fakeSpawn.last.args, ['install', '-g', '@anthropic-ai/claude-code']);
    assert.equal(fakeSpawn.last.opts.stdio, 'inherit');
  });

  test('nonzero exit and spawn errors both resolve as failures (never throw)', async () => {
    const failed = await installTool(TOOL_PACKAGES.codex, { spawnImpl: fakeSpawn(1) });
    assert.equal(failed.ok, false);
    assert.match(failed.error, /code 1/);
    const errored = await installTool(TOOL_PACKAGES.codex, {
      spawnImpl: fakeSpawn(0, new Error('npm missing')),
    });
    assert.equal(errored.ok, false);
    assert.match(errored.error, /npm missing/);
  });
});
