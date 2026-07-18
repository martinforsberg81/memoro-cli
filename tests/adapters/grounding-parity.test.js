/**
 * Tool-agnostic grounding contract.
 *
 * The server-owned User Profile + Coding Profile bundle must be delivered to
 * each adapter at session start. It must not become repo-owned instruction
 * truth in CLAUDE.md or AGENTS.md.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as claudeCode from '../../src/adapters/claude-code.js';
import * as codex from '../../src/adapters/codex.js';

describe('adapter grounding parity', () => {
  it('delivers the same profile context to Claude and Codex without materialising it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mc-grounding-parity-'));
    const bundle = [
      '# Session grounding',
      '',
      '## Memoro profile context',
      '',
      '### User Profile',
      '',
      '- Name: Martin',
      '',
      '### Coding Profile',
      '',
      '- Prefer Swedish collaboration.',
      '',
    ].join('\n');

    try {
      const claude = await claudeCode.writeGrounding(bundle, { cwd: dir });
      const codexTarget = await codex.writeGrounding(bundle, { cwd: dir });

      assert.equal(claude.message, bundle);
      assert.equal(codexTarget.message, bundle);
      assert.equal(claude.delivery, 'launch-args');
      assert.equal(codexTarget.delivery, 'startup-message');
      assert.ok(!existsSync(join(dir, 'CLAUDE.md')), 'Claude must not write profile context to CLAUDE.md');
      assert.ok(!existsSync(join(dir, 'AGENTS.md')), 'Codex must not write profile context to AGENTS.md');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
