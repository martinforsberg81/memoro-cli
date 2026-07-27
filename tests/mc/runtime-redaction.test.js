import assert from 'node:assert/strict';
import test from 'node:test';

import { redactCredentialText } from '../../src/mc/runtime-redaction.js';

test('runtime text redaction removes credential-shaped values from free text', () => {
  const canaries = [
    'mem_runtime_canary_123456',
    'sk-runtime-canary-123456',
    'ghs_runtime_canary_123456',
    'cap_runtime_canary_123456',
    'opaque-bearer.canary/123',
    'assigned-canary-123',
  ];
  const text = [
    `runtime=${canaries[0]}`,
    `provider ${canaries[1]}`,
    `github ${canaries[2]}`,
    `capability ${canaries[3]}`,
    `Authorization: Bearer ${canaries[4]}`,
    `refresh_token=${canaries[5]}`,
  ].join(' ');

  const redacted = redactCredentialText(text);

  for (const canary of canaries) assert.equal(redacted.includes(canary), false);
  assert.match(redacted, /Bearer \[redacted\]/);
  assert.match(redacted, /refresh_token=\[redacted\]/);
});

test('runtime text redaction preserves ordinary status text and bounds output', () => {
  assert.equal(redactCredentialText('workspace ready'), 'workspace ready');
  assert.equal(redactCredentialText('x'.repeat(20), 8), 'xxxxxxxx');
});
