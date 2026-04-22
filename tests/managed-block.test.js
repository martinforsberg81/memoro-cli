import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  upsertManagedBlock,
  removeManagedBlock,
  readManagedBlock,
} from '../src/lib/managed-block.js';

describe('upsertManagedBlock', () => {
  test('inserts a block into an empty file', () => {
    const out = upsertManagedBlock('', 'hello');
    assert.match(out, /^<!-- memoro:managed:portrait-coding:begin -->\nhello\n<!-- memoro:managed:portrait-coding:end -->/);
  });

  test('appends to non-empty content with a separator', () => {
    const before = 'existing user content\n';
    const out = upsertManagedBlock(before, 'hi');
    assert.ok(out.startsWith('existing user content'));
    assert.match(out, /<!-- memoro:managed:portrait-coding:begin -->\nhi\n<!-- memoro:managed:portrait-coding:end -->/);
  });

  test('replaces an existing block idempotently', () => {
    let content = '';
    content = upsertManagedBlock(content, 'first');
    content = upsertManagedBlock(content, 'second');
    content = upsertManagedBlock(content, 'third');
    assert.ok(content.includes('third'));
    assert.ok(!content.includes('first'));
    assert.ok(!content.includes('second'));
    // Only one block in the file
    const matches = content.match(/memoro:managed:portrait-coding:begin/g) || [];
    assert.equal(matches.length, 1);
  });

  test('preserves hand-edited content outside the block', () => {
    const hand = '# My CLAUDE.md\n\n## Project rules\n- use tabs not spaces\n';
    let content = upsertManagedBlock(hand, 'lens body v1');
    content = upsertManagedBlock(content, 'lens body v2');
    assert.ok(content.includes('# My CLAUDE.md'));
    assert.ok(content.includes('use tabs not spaces'));
    assert.ok(content.includes('lens body v2'));
    assert.ok(!content.includes('lens body v1'));
  });
});

describe('removeManagedBlock', () => {
  test('removes the block, leaves surrounding content intact', () => {
    const hand = '# Top\n';
    const withBlock = upsertManagedBlock(hand, 'lens body');
    const cleaned = removeManagedBlock(withBlock);
    assert.ok(cleaned.startsWith('# Top'));
    assert.ok(!cleaned.includes('memoro:managed'));
  });

  test('returns original content if no block present', () => {
    const content = '# nothing here\n';
    assert.equal(removeManagedBlock(content), content);
  });

  test('handles empty input', () => {
    assert.equal(removeManagedBlock(''), '');
    assert.equal(removeManagedBlock(null), '');
  });
});

describe('readManagedBlock', () => {
  test('extracts the block body', () => {
    const withBlock = upsertManagedBlock('pre\n', 'the body');
    assert.equal(readManagedBlock(withBlock), 'the body');
  });

  test('returns null if no block', () => {
    assert.equal(readManagedBlock('no block'), null);
  });
});
