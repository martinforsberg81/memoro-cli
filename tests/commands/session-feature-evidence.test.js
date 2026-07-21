import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { buildSessionFeatureEvidence } from '../../src/commands/session.js';

const SESSION_SOURCE = readFileSync(
  new URL('../../src/commands/session.js', import.meta.url),
  'utf8',
);

test('session payload never receives the separate coding feature evidence stream', () => {
  assert.doesNotMatch(SESSION_SOURCE, /payload\.coding_features\s*=/);
  assert.doesNotMatch(SESSION_SOURCE, /payload\.coding_feature_evidence\s*=/);
  assert.match(SESSION_SOURCE, /publishCodingFeatureEvidence\(codingFeatureEvidence/);
  assert.ok(
    SESSION_SOURCE.indexOf("'/api/sessions/external'")
      < SESSION_SOURCE.lastIndexOf('publishCodingFeatureEvidence(codingFeatureEvidence'),
    'normalized evidence must publish only after the session upload succeeds',
  );
});

test('session upload derives evidence identity without carrying local paths', () => {
  const records = buildSessionFeatureEvidence({
    source_id: 'local:martins-mac',
    coding_session_id: 'sess_123456',
    repo_hint: '/Users/martin/private/repo',
  }, {
    repo_manifest: { name: '@private/package' },
    coding_features: [{
      feature_id: 'web.abort_signal_composition',
      evidence_codes: ['api:AbortSignal.any', 'api:AbortSignal.timeout'],
      files_observed: 1,
    }],
  }, {
    sessionCwd: '/Users/martin/work/memoro',
    observedAt: '2026-07-21T10:00:00Z',
  });

  assert.equal(records.length, 1);
  assert.equal(records[0].repo, 'memoro');
  assert.equal(JSON.stringify(records).includes('/Users/martin'), false);
});

test('session upload degrades a detector accessor failure to no evidence', () => {
  const annotations = {};
  Object.defineProperty(annotations, 'coding_features', {
    get() { throw new Error('broken detector'); },
  });
  assert.deepEqual(buildSessionFeatureEvidence({
    source_id: 'local:mac',
    session_id: 'external_123',
  }, annotations, {
    sessionCwd: '/repo/memoro',
  }), []);
});
