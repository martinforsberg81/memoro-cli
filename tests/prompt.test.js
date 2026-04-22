/**
 * Tests for prompt helpers — the ANSI-strip defensive layer and the
 * invariant that hidden input uses a muted Writable rather than raw mode.
 */

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { stripAnsi } from '../src/lib/prompt.js';

const here = dirname(fileURLToPath(import.meta.url));
const promptSource = readFileSync(join(here, '..', 'src', 'lib', 'prompt.js'), 'utf8');

describe('stripAnsi', () => {
  test('removes bracketed-paste markers', () => {
    assert.equal(
      stripAnsi('\x1b[200~mem_abcdef123456\x1b[201~'),
      'mem_abcdef123456',
    );
  });

  test('removes common CSI sequences', () => {
    assert.equal(stripAnsi('\x1b[2Kmem_abc'), 'mem_abc');
    assert.equal(stripAnsi('mem_\x1b[31mabc\x1b[0m'), 'mem_abc');
  });

  test('removes OSC sequences (BEL-terminated)', () => {
    assert.equal(stripAnsi('\x1b]0;title\x07mem_abc'), 'mem_abc');
  });

  test('passes plain text through unchanged', () => {
    assert.equal(stripAnsi('mem_0123456789abcdef'), 'mem_0123456789abcdef');
    assert.equal(stripAnsi(''), '');
    assert.equal(stripAnsi(null), '');
  });
});

describe('prompt.js implementation invariants', () => {
  test('uses MutedWritable for hidden input (not just raw mode)', () => {
    // Regression guard: terminals can echo pasted input before raw mode
    // kicks in, so we switched to a muted-output readline approach.
    assert.match(promptSource, /MutedWritable/, 'should define the muted Writable');
    assert.match(promptSource, /muted\.mute\(\)/, 'should mute before reading');
    assert.match(promptSource, /readline\.createInterface/, 'should use readline');
  });

  test('non-TTY falls through to promptLine (pipe support)', () => {
    assert.match(promptSource, /isTTY/, 'must detect non-TTY stdin');
    assert.match(promptSource, /promptLine/, 'must delegate to promptLine for piped input');
  });

  test('strips ANSI before returning the secret', () => {
    assert.match(promptSource, /stripAnsi\(answer\)/, 'must strip ANSI on return');
  });
});
