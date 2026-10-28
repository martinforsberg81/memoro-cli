import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AUTONOMOUS_EXECUTION_ENABLED, autonomousRevisionProblems, criteriaForPhase,
  evidenceForRevision, validateAutonomousEvidence, validateAutonomousProject,
} from '../../src/mc/autonomous-project.js';
import { autonomousEvidence, autonomousProject, attribution, programmeContract } from './autonomy-fixtures.js';

describe('the explicit autonomous project contract', () => {
  it('accepts a v2 goal without fixed steps, but grants no launch capability', () => {
    const project = autonomousProject();
    const before = structuredClone(project);
    assert.deepEqual(validateAutonomousProject(project), { ok: true, problems: [] });
    assert.equal('steps' in project, false);
    assert.equal(AUTONOMOUS_EXECUTION_ENABLED, false);
    assert.deepEqual(project, before);
  });

  it('requires explicit schema/version/kind, repository and both revisions', () => {
    for (const patch of [
      { schema: 'other' }, { version: 1 }, { version: 3 }, { version: '2' }, { execution: null },
      { execution: {} }, { execution: { kind: 'fixed' } }, { execution: { kind: 'autonomous', enabled: true } },
      { project_id: '' }, { repo: undefined }, { programme: null }, { programme: {} },
      { programme: { id: 'test-programme', revision: '1' } }, { goal_revision: 0 },
      { goal_revision: Number.MAX_SAFE_INTEGER + 1 }, { goal_revision: 1.5 },
      { steps: [] }, { steps: [{ status: 'ready' }] }, { repair_role: 'mend' },
    ]) assert.equal(validateAutonomousProject(autonomousProject(patch)).ok, false, JSON.stringify(patch));
    for (const value of [null, [], {}, false, 2]) assert.equal(validateAutonomousProject(value).ok, false);
  });

  it('requires instructions, boundaries, measurable criteria and stable unique IDs', () => {
    for (const patch of [{ goal: [] }, { instruction: [] }, { contract: [] }, { out_of_scope: [] }, { success_criteria: [] }, { documents: null }]) {
      assert.equal(validateAutonomousProject(autonomousProject(patch)).ok, false);
    }
    for (const patch of [{ id: undefined }, { id: 1 }, { id: 'Not an ID' }, { instruction: [] }, { check: '' }, { verification: 'unknown' }, { met: true }]) {
      const project = autonomousProject();
      Object.assign(project.success_criteria[0], patch);
      assert.equal(validateAutonomousProject(project).ok, false, JSON.stringify(patch));
    }
    const project = autonomousProject();
    project.success_criteria[1].id = project.success_criteria[0].id;
    assert.match(validateAutonomousProject(project).problems.join('\n'), /duplicate criterion ID/u);
  });

  it('resolves only the referenced approved programme, never a draft or another revision', () => {
    const project = autonomousProject();
    assert.equal(validateAutonomousProject(project, { programme: programmeContract() }).ok, true);
    const draft = programmeContract({ status: 'draft' });
    delete draft.approval;
    for (const programme of [null, draft, programmeContract({ revision: 2, based_on: 1 }), programmeContract({ id: 'other-programme' })]) {
      assert.equal(validateAutonomousProject(project, { programme }).ok, false);
    }
  });

  it('separates premerge from after-integration checks without declaring the goal confirmed', () => {
    const project = autonomousProject();
    assert.deepEqual(criteriaForPhase(project, 'premerge').map((c) => c.id), ['schema']);
    assert.deepEqual(criteriaForPhase(project, 'after-integration').map((c) => c.id), ['integration']);
    assert.throws(() => criteriaForPhase(project, 'all'), /verification phase/u);
    assert.throws(() => criteriaForPhase({}, 'premerge'), /version/u);
    assert.equal(evidenceForRevision(project, autonomousEvidence()).confirmation, null);
  });
});

describe('goal revisions and evidence identity', () => {
  it('advances goals exactly once while retaining project/repository/programme ownership', () => {
    const project = autonomousProject();
    const next = autonomousProject({ goal_revision: 2 });
    next.success_criteria.reverse();
    next.success_criteria[1].criterion = 'Reworded criterion with its stable ID.';
    assert.deepEqual(autonomousRevisionProblems(project, next), []);
    for (const patch of [{ goal_revision: 1 }, { goal_revision: 3 }, { project_id: 'other' }, { repo: 'memoro' }, { programme: { id: 'other', revision: 1 } }]) {
      assert.notDeepEqual(autonomousRevisionProblems(project, { ...next, ...patch }), []);
    }
    assert.notDeepEqual(autonomousRevisionProblems(autonomousProject({ programme: { id: 'test-programme', revision: 2 } }), next), []);
    assert.deepEqual(autonomousRevisionProblems(project, { ...next, programme: { id: 'test-programme', revision: 2 } }), []);
  });

  it('matches evidence by stable ID, not text or position, and keeps attribution/history unchanged', () => {
    const project = autonomousProject();
    const evidence = autonomousEvidence();
    const before = structuredClone(evidence);
    project.success_criteria.reverse();
    project.success_criteria[1].criterion = 'Different display text.';
    const current = evidenceForRevision(project, evidence);
    assert.deepEqual(current.builder, evidence.builder);
    assert.equal(current.builder[0].criterion_id, 'schema');
    assert.equal(current.builder[0].run_id, 'step-run-1');
    assert.deepEqual(evidence, before);
  });

  it('invalidates old-revision observations and confirmation without deleting their history', () => {
    const confirmation = { ...attribution(), id: 'confirmation-1', run_id: 'plan-run-1', role: 'plan', reference: 'decisions/confirmation-1.json' };
    const evidence = autonomousEvidence({ confirmation });
    const before = structuredClone(evidence);
    assert.deepEqual(evidenceForRevision(autonomousProject(), evidence).confirmation, confirmation);
    for (const project of [autonomousProject({ goal_revision: 2 }), autonomousProject({ programme: { id: 'test-programme', revision: 2 } })]) {
      assert.deepEqual(evidenceForRevision(project, evidence), { builder: [], reviews: [], confirmation: null });
    }
    assert.deepEqual(evidence, before);
    assert.equal(evidence.builder[0].goal_revision, 1);
    assert.equal(evidence.reviews[0].programme_revision, 1);
  });

  it('does not reuse another project or programme\'s evidence, or a removed criterion\'s progress', () => {
    const evidence = autonomousEvidence();
    for (const project of [autonomousProject({ project_id: 'other-project' }), autonomousProject({ programme: { id: 'other-programme', revision: 1 } })]) {
      assert.deepEqual(evidenceForRevision(project, evidence), { builder: [], reviews: [], confirmation: null });
    }
    const project = autonomousProject();
    project.success_criteria[0].id = 'replacement';
    assert.deepEqual(evidenceForRevision(project, evidence).builder, []);
  });

  it('preserves failed/unknown work as such, separately from independent findings', () => {
    const evidence = autonomousEvidence();
    evidence.builder[0].status = 'failed';
    evidence.builder[0].reference = null;
    evidence.reviews[0].findings = ['The check does not cover recovery.'];
    evidence.reviews[0].criteria[0].status = 'finding';
    const current = evidenceForRevision(autonomousProject(), evidence);
    assert.equal(current.builder[0].status, 'failed');
    assert.deepEqual(current.reviews[0].findings, evidence.reviews[0].findings);
    assert.equal(current.confirmation, null);
  });

  it('requires attributable observations and explicit planner confirmation, never a builder/review met flag', () => {
    assert.deepEqual(validateAutonomousEvidence(autonomousEvidence()), { ok: true, problems: [] });
    const bad = [];
    for (const patch of [{ run_id: '' }, { project_id: undefined }, { programme_id: undefined }, { goal_revision: 0 }, { criterion_id: '' }, { reference: null }, { status: 'green' }, { met: true }]) {
      const evidence = autonomousEvidence();
      Object.assign(evidence.builder[0], patch); bad.push(evidence);
    }
    for (const role of ['step', 'review', 'repair']) bad.push(autonomousEvidence({ confirmation: { ...attribution(), id: 'confirm', run_id: 'run-1', role, reference: 'decision.json' } }));
    const duplicate = autonomousEvidence();
    duplicate.reviews[0].id = duplicate.builder[0].id; bad.push(duplicate);
    const incomplete = autonomousEvidence();
    incomplete.reviews[0].criteria = []; bad.push(incomplete);
    const unknown = autonomousEvidence();
    unknown.reviews[0].criteria[0].status = 'green'; bad.push(unknown);
    for (const value of [null, {}, { builder: [], reviews: [] }, ...bad]) {
      assert.equal(validateAutonomousEvidence(value).ok, false, JSON.stringify(value));
    }
    assert.throws(() => evidenceForRevision(autonomousProject(), bad[0]), /run_id/u);
  });
});
