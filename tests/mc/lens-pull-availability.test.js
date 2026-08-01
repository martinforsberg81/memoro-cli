import assert from 'node:assert/strict';
import test from 'node:test';

import { isLensUnavailable } from '../../src/commands/lens.js';

// `memoro-cli lens pull` runs as a Claude Code SessionStart hook, so anything
// it treats as an error is reported to the user on every single launch. Only a
// settled "no external lens for this account" may be swallowed.
test('lens pull swallows only a 404 and still surfaces every real failure', () => {
  const refusal = (status) => Object.assign(new Error(`Memoro ${status}`), { status });

  assert.equal(isLensUnavailable(refusal(404)), true);

  for (const status of [400, 401, 403, 409, 429, 500, 502, 503]) {
    assert.equal(
      isLensUnavailable(refusal(status)),
      false,
      `HTTP ${status} is a real failure and must not be silenced`,
    );
  }

  // A transport error carries no status and must never be mistaken for an
  // absent lens — that would hide the server being unreachable.
  assert.equal(isLensUnavailable(new Error('network down')), false);
  assert.equal(isLensUnavailable(null), false);
  assert.equal(isLensUnavailable(undefined), false);
  // A string status must not pass a loose comparison.
  assert.equal(isLensUnavailable({ status: '404' }), false);
});
