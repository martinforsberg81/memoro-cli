import assert from 'node:assert/strict';
import test from 'node:test';

import { buildProbeReport } from '../../scripts/security/credential-boundary-probe.mjs';

function generation(number) {
  return {
    generation: number,
    replacement: { verified: true, code: number === 1 ? 'initial_generation_no_predecessor' : 'previous_generation_removed' },
    setup: { code: 'generation_ready' },
    negative_control: { detected: true, code: 'negative_control_detected' },
    isolated_probe: { schema: 1 },
    isolated_violations: [],
    output_contains_canary: false,
    teardown: {
      removed: true,
      credential_domain_removed: true,
      socket_removed: true,
      temp_domain_removed: true,
      code: 'generation_domain_removed',
    },
    pass: true,
  };
}

test('credential-boundary report records two generation teardown and replacement outcomes without values', () => {
  const report = buildProbeReport({
    host: 'test',
    codexVersion: 'codex-cli test',
    generations: [generation(1), generation(2)],
  });

  assert.equal(report.schema, 2);
  assert.equal(report.generation_count, 2);
  assert.equal(report.pass, true);
  assert.equal(report.generations[0].teardown.code, 'generation_domain_removed');
  assert.equal(report.generations[1].replacement.code, 'previous_generation_removed');
  assert.equal(JSON.stringify(report).includes('mc_canary_'), false);
});
