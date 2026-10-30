import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateProgrammeMetadata } from '../../src/mc/programme-metadata.js';
const programmeContract = (overrides = {}) => ({ schema: 'mc-programme', version: 1, id: 'test-programme', revision: 1, based_on: 0, status: 'approved', approval: { by: 'Martin' }, ...overrides });

test('programme metadata keeps identity and a brief source, without an approval schema', () => {
  const metadata = { id: 'test-programme', brief: 'docs/project/test-programme/' };
  const before = structuredClone(metadata);
  assert.deepEqual(validateProgrammeMetadata(metadata), { ok: true, problems: [] });
  assert.deepEqual(metadata, before);
  for (const value of [null, [], {}, { ...metadata, id: '../escape' }, { ...metadata, brief: '' },
    { ...metadata, approval: { by: 'Martin' } }, { ...metadata, status: 'draft' }, { ...metadata, revision: 1 }]) {
    assert.equal(validateProgrammeMetadata(value).ok, false, JSON.stringify(value));
  }
});

test('old draft and approved programme contracts are unsupported, not metadata', () => {
  const approved = programmeContract();
  const draft = programmeContract({ status: 'draft' }); delete draft.approval;
  for (const old of [approved, draft, { ...approved, brief: 'docs/project/test-programme/' }]) {
    const before = structuredClone(old);
    assert.equal(validateProgrammeMetadata(old).ok, false);
    assert.deepEqual(old, before);
  }
});
