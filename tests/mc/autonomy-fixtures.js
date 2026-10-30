// Historical pre-ruling-60 fixture, retained until the legacy scenarios move.
const PROGRAMME_AUTHORITY = Object.freeze({
  programme_revision: 'foreground-plan', goal_revision: 'plan', confirmation: 'plan',
  implementation: 'step', review: 'report-only',
});

export function programmeContract(overrides = {}) {
  return {
    schema: 'mc-programme', version: 1, id: 'test-programme', revision: 1, based_on: 0,
    status: 'approved', approval: { by: 'Martin', at: '2026-10-28T12:00:00Z' },
    goal: ['Deliver the agreed capability.'], specification: ['The CLI owns versioned contracts.'],
    scope: { included: ['CLI contracts and tests.'], excluded: ['Deployment and credentials.'] },
    success_criteria: [{ id: 'contracts', criterion: 'Contracts are explicit.', check: 'mc gate tests/mc/programme-contract.test.js', verification: 'premerge' }],
    authority: { ...PROGRAMME_AUTHORITY },
    planned_stops: [{ id: 'design-review', condition: 'Stop before activating autonomous execution.' }],
    ...overrides,
  };
}

export function autonomousProject(overrides = {}) {
  return {
    schema: 'mc-plan', version: 2, project_id: 'test-project', repo: 'memoro-cli',
    execution: { kind: 'autonomous' }, programme: { id: 'test-programme', revision: 1 }, goal_revision: 1,
    goal: ['Implement explicit contracts.'], instruction: ['Build and verify the contracts without enabling execution.'],
    contract: ['Keep v1 projects unchanged.'], out_of_scope: ['Launching autonomous sessions.'],
    success_criteria: [
      { id: 'schema', criterion: 'The schema validates.', instruction: ['Validate the opt-in contract.'], check: 'mc gate tests/mc/autonomous-project.test.js', verification: 'premerge' },
      { id: 'integration', criterion: 'The integrated CLI reads it.', instruction: ['Check after integration.'], check: 'Read the installed CLI status.', verification: 'after-integration' },
    ],
    documents: [], ...overrides,
  };
}

export function attribution(overrides = {}) {
  return { project_id: 'test-project', programme_id: 'test-programme', programme_revision: 1, goal_revision: 1, ...overrides };
}

export function autonomousEvidence(overrides = {}) {
  return {
    builder: [{ ...attribution(), id: 'build-proof', run_id: 'step-run-1', criterion_id: 'schema', status: 'verified', reference: 'evidence/build-proof.json' }],
    reviews: [{
      ...attribution(), id: 'review-proof', run_id: 'review-run-1', reference: 'reports/review-proof.json', findings: [],
      criteria: [
        { criterion_id: 'schema', status: 'verified', reference: 'reports/review-proof.json#schema' },
        { criterion_id: 'integration', status: 'deferred', reference: 'Requires integration, not a premerge condition.' },
      ],
    }],
    confirmation: null, ...overrides,
  };
}
