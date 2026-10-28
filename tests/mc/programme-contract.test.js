import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { programmeRevisionProblems, validateProgrammeContract } from '../../src/mc/programme-contract.js';
import { programmeContract } from './autonomy-fixtures.js';

describe('programme contract snapshots', () => {
  it('accepts an approved revision and a separate next-revision draft without mutating either', () => {
    const approved = programmeContract();
    const draft = programmeContract({ revision: 2, based_on: 1, status: 'draft' });
    delete draft.approval;
    draft.scope.included.push('Another agreed implementation detail.');
    const before = structuredClone({ approved, draft });
    assert.deepEqual(validateProgrammeContract(approved), { ok: true, problems: [] });
    assert.deepEqual(validateProgrammeContract(draft), { ok: true, problems: [] });
    assert.deepEqual(programmeRevisionProblems(approved, draft), []);
    assert.deepEqual({ approved, draft }, before);
    assert.equal(approved.scope.included.length, 1);
  });

  it('requires explicit approval attribution, never treating a draft as approved', () => {
    for (const approval of [undefined, null, {}, { by: '', at: 'yesterday' }, { by: 'Martin', at: '2026' }]) {
      assert.equal(validateProgrammeContract(programmeContract({ approval })).ok, false);
    }
    assert.match(validateProgrammeContract(programmeContract({ status: 'draft' })).problems.join('\n'), /approval/u);
    assert.equal(validateProgrammeContract(programmeContract({ status: 'active' })).ok, false);
  });

  it('requires scope, specification, agreed authority and planned stopping points', () => {
    for (const patch of [
      { goal: [] }, { specification: [] }, { scope: {} }, { scope: { included: ['x'], excluded: [] } },
      { authority: {} }, { planned_stops: [] }, { planned_stops: [{ id: 'stop', condition: '' }] },
    ]) assert.equal(validateProgrammeContract(programmeContract(patch)).ok, false, JSON.stringify(patch));
    const contract = programmeContract();
    contract.planned_stops.push({ ...contract.planned_stops[0] });
    assert.match(validateProgrammeContract(contract).problems.join('\n'), /duplicate stop ID/u);
  });

  it('has only plan, step and independent report-only review responsibilities', () => {
    for (const [key, role] of [['goal_revision', 'step'], ['confirmation', 'review'], ['programme_revision', 'plan'], ['review', 'implement-repairs']]) {
      const contract = programmeContract();
      contract.authority[key] = role;
      assert.equal(validateProgrammeContract(contract).ok, false);
    }
    const contract = programmeContract();
    contract.authority.repair = 'repair-agent';
    assert.match(validateProgrammeContract(contract).problems.join('\n'), /authority.repair: unknown key/u);
  });

  it('requires stable unique criterion IDs and an explicit verification phase', () => {
    for (const patch of [{ id: '' }, { id: 1 }, { id: '../escape' }, { id: 'Not stable' }, { check: '' }, { verification: undefined }, { verification: 'deploy' }]) {
      const contract = programmeContract();
      Object.assign(contract.success_criteria[0], patch);
      assert.equal(validateProgrammeContract(contract).ok, false, JSON.stringify(patch));
    }
    const contract = programmeContract();
    contract.success_criteria.push({ ...contract.success_criteria[0] });
    assert.match(validateProgrammeContract(contract).problems.join('\n'), /duplicate criterion ID/u);
  });

  it('refuses malformed and unsupported contracts rather than normalizing them', () => {
    for (const value of [null, [], 1, 'contract', {}, programmeContract({ version: 2 }), programmeContract({ unexpected: true })]) {
      assert.equal(validateProgrammeContract(value).ok, false);
    }
    for (const revision of [0, -1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1]) {
      assert.equal(validateProgrammeContract(programmeContract({ revision })).ok, false);
    }
  });
});

describe('programme revision rules', () => {
  it('permits an identical approved snapshot but refuses rewriting any approved content', () => {
    const approved = programmeContract();
    assert.deepEqual(programmeRevisionProblems(approved, structuredClone(approved)), []);
    for (const field of ['goal', 'specification', 'scope', 'success_criteria', 'authority', 'planned_stops', 'approval']) {
      const changed = structuredClone(approved);
      if (Array.isArray(changed[field])) changed[field].reverse();
      if (field === 'goal' || field === 'specification') changed[field] = ['Different agreement.'];
      if (field === 'scope') changed.scope.included = ['More scope.'];
      if (field === 'success_criteria') changed.success_criteria[0].check = 'Different check';
      if (field === 'authority') changed.authority.confirmation = 'step';
      if (field === 'planned_stops') changed.planned_stops[0].condition = 'A different stop.';
      if (field === 'approval') changed.approval.by = 'Someone else';
      assert.notDeepEqual(programmeRevisionProblems(approved, changed), [], field);
    }
  });

  it('requires consecutive revisions, their exact base and unchanged programme identity', () => {
    const approved = programmeContract();
    assert.deepEqual(programmeRevisionProblems(approved, programmeContract({ revision: 2, based_on: 1 })), []);
    for (const patch of [{ revision: 3, based_on: 2 }, { revision: 2, based_on: 0 }, { revision: 2, based_on: 1, id: 'other' }]) {
      assert.notDeepEqual(programmeRevisionProblems(approved, programmeContract(patch)), []);
    }
    const draft = programmeContract({ status: 'draft' });
    delete draft.approval;
    assert.match(programmeRevisionProblems(draft, programmeContract({ revision: 2, based_on: 1 })).join('\n'), /current: must be an approved revision/u);
  });
});
