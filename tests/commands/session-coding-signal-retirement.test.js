import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const ROOT = resolve(import.meta.dirname, '..', '..');
const SESSION_SOURCE = readFileSync(resolve(ROOT, 'src/commands/session.js'), 'utf8');
const ANNOTATE_SOURCE = readFileSync(resolve(ROOT, 'src/lib/annotate.js'), 'utf8');

test('session upload keeps projection but has no feature detector or evidence publication', () => {
  assert.equal(existsSync(resolve(ROOT, 'src/lib/coding-feature-evidence.js')), false);
  assert.doesNotMatch(SESSION_SOURCE, /codingFeatureEvidence|publishCodingFeatureEvidence|coding-feature-evidence/);
  assert.doesNotMatch(ANNOTATE_SOURCE, /coding_features|detectCodingFeatures/);
  assert.match(SESSION_SOURCE, /attachAutomaticSessionProjection/);
  assert.match(SESSION_SOURCE, /'\/api\/sessions\/external'/);
});
