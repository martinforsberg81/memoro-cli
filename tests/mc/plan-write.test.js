import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  BANNED_WORDS,
  CODEX_REVIEW_RUNNER,
  DEPENDENCY_WORDS,
  DRAFT_FILE,
  MODELS,
  REVIEW_STEP,
  bannedWords,
  checkWords,
  dependencyWords,
  draftProblems,
  findArchivedProjectDir,
  findProjectDir,
  instructionParagraphs,
  readDraftOrPlan,
  sendProblems,
  testDirectories,
  withPlanLock,
  withReviewStep,
  writePlanFile,
} from '../../src/mc/plan-write.js';
import { PLAN_SCHEMA, PLAN_VERSION, validatePlan } from '../../src/mc/plan-schema.js';

const scratch = () => mkdtempSync(join(tmpdir(), 'plan-write-'));

function draft(overrides = {}) {
  return {
    schema: PLAN_SCHEMA,
    version: PLAN_VERSION,
    repo: 'memoro-cli',
    goal: ['A smoke plan.'],
    contract: ['Nothing.'],
    out_of_scope: ['Everything else.'],
    documents: [],
    success_criteria: [],
    steps: [],
    ...overrides,
  };
}

function complete(overrides = {}) {
  return draft({
    success_criteria: [{ met: false, criterion: 'It runs.', check: 'true' }],
    steps: [
      { title: 'One', status: 'ready', done_when: 'it runs', instruction: ['Do the thing.'], runner: { model: 'haiku', effort: 'high' } },
      { title: 'Two', status: 'ready', done_when: 'it runs again', instruction: ['Do the other thing.'], runner: { model: 'opus' } },
    ],
    ...overrides,
  });
}

test('DRAFT_FILE, MODELS and the two word patterns are what the verbs share', () => {
  assert.equal(DRAFT_FILE, 'DRAFT.json');
  assert.deepEqual(MODELS, ['haiku', 'opus', 'gpt-6.1-sol', 'gpt-6.1-luna']);
  assert.ok(Object.isFrozen(MODELS));
  assert.ok(BANNED_WORDS.test('Martin'));
  assert.ok(DEPENDENCY_WORDS.test('--on-project x'));
});

test('bannedWords names a person, or a manual step, wherever it is written', () => {
  assert.deepEqual(bannedWords('Martin reads it, by hand, Manually, for a person.'), ['Martin', 'by hand', 'Manually', 'a person']);
  assert.deepEqual(bannedWords('the review of the person-picker'), []);
  assert.deepEqual(bannedWords('a personal review'), []);
  assert.deepEqual(bannedWords(undefined), []);
  assert.deepEqual(bannedWords(42), []);
});

test('checkWords names a check that cannot run from the step\'s own branch, whatever its case', () => {
  assert.deepEqual(checkWords('After the deploy; after deploy; once deployed; IN PRODUCTION; not a step\'s; his phone; his IPHONE; his mobile; at his terminal.'), [
    'After the deploy', 'after deploy', 'once deployed', 'IN PRODUCTION', 'not a step\'s', 'his phone', 'his IPHONE', 'his mobile', 'at his terminal',
  ]);
  assert.deepEqual(checkWords('node --test tests/x.test.js'), []);
  assert.deepEqual(checkWords(undefined), []);
});

test('dependencyWords names a dependency written in prose', () => {
  assert.deepEqual(dependencyWords('wait with --on-project x, then blocked_by'), ['--on-project', 'blocked_by']);
  assert.deepEqual(dependencyWords('wait for --after mc:x'), []);
  assert.deepEqual(dependencyWords(null), []);
});

test('testDirectories names a directory given to node --test, and no file, glob or flag', () => {
  assert.deepEqual(testDirectories('node --test tests/a.test.js tests/assistant/background'), ['tests/assistant/background']);
  assert.deepEqual(testDirectories("`node --test 'tests/x/**/*.test.js'` passes"), []);
  assert.deepEqual(testDirectories('`node --test tests/a.test.js` passes with tests/b'), []);
  assert.deepEqual(testDirectories('node --test --test-name-pattern=x tests/a.test.js && ls docs/x'), []);
  assert.deepEqual(testDirectories('node --test'), []);
  assert.deepEqual(testDirectories(undefined), []);
  assert.deepEqual(testDirectories('node --test tests/x/'), ['tests/x/']);
});

test('findProjectDir finds a draft, a sent plan, and nothing', () => {
  const home = scratch();
  try {
    mkdirSync(join(home, 'mc', 'drafted'), { recursive: true });
    writeFileSync(join(home, 'mc', 'drafted', DRAFT_FILE), '{}');
    mkdirSync(join(home, 'ops', 'sent'), { recursive: true });
    writeFileSync(join(home, 'ops', 'sent', 'PLAN.json'), '{}');

    const drafted = findProjectDir(home, 'drafted');
    assert.deepEqual(drafted, { programme: 'mc', dir: join(home, 'mc', 'drafted'), file: join(home, 'mc', 'drafted', DRAFT_FILE), sent: false });

    const sent = findProjectDir(home, 'sent');
    assert.deepEqual(sent, { programme: 'ops', dir: join(home, 'ops', 'sent'), file: join(home, 'ops', 'sent', 'PLAN.json'), sent: true });

    assert.equal(findProjectDir(home, 'nothing'), null);
    assert.equal(findProjectDir(home, '../drafted'), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('findArchivedProjectDir finds a project the runner moved to the archive, and not a draft-only directory', () => {
  const archive = scratch();
  try {
    mkdirSync(join(archive, 'mc', 'moved'), { recursive: true });
    writeFileSync(join(archive, 'mc', 'moved', 'PLAN.json'), '{}');
    writeFileSync(join(archive, 'mc', 'moved', 'CLOSEOUT.json'), '{}');
    mkdirSync(join(archive, 'ops', 'drafted'), { recursive: true });
    writeFileSync(join(archive, 'ops', 'drafted', DRAFT_FILE), '{}');

    assert.deepEqual(findArchivedProjectDir(archive, 'moved'), {
      programme: 'mc',
      dir: join(archive, 'mc', 'moved'),
      file: join(archive, 'mc', 'moved', 'PLAN.json'),
    });
    assert.equal(findArchivedProjectDir(archive, 'drafted'), null);
    assert.equal(findArchivedProjectDir(archive, 'nothing'), null);
    assert.equal(findArchivedProjectDir(archive, '../moved'), null);
  } finally {
    rmSync(archive, { recursive: true, force: true });
  }
});

test('draftProblems is empty for a draft with nothing yet in its criteria and steps, and keeps every other problem', () => {
  assert.deepEqual(draftProblems(draft()), []);
  const { goal, ...withoutGoal } = draft();
  assert.ok(draftProblems(withoutGoal).some((problem) => problem.startsWith('goal:')));
});

test('sendProblems is empty for a complete plan, and names each thing that stops a send', () => {
  assert.deepEqual(sendProblems(complete()), []);

  const noModel = complete();
  delete noModel.steps[0].runner;
  assert.deepEqual(sendProblems(noModel), ['steps[1].runner.model: haiku, opus, gpt-6.1-sol or gpt-6.1-luna']);

  const sonnet = complete();
  sonnet.steps[1].runner.model = 'sonnet';
  assert.deepEqual(sendProblems(sonnet), ['steps[2].runner.model: haiku, opus, gpt-6.1-sol or gpt-6.1-luna']);

  const planModel = complete({ runner: { model: 'haiku' } });
  assert.deepEqual(sendProblems(planModel), ['runner.model: a plan names no model — each step names its own (ruling 42)']);

  const martin = complete();
  martin.steps[0].done_when = 'Martin checks it';
  assert.deepEqual(sendProblems(martin), ['steps[1].done_when: names Martin — a step\'s end is a check, never a person\'s']);

  const byHand = complete();
  byHand.success_criteria[0].check = 'by hand';
  assert.deepEqual(sendProblems(byHand), ['success_criteria[1].check: names by hand — a check is a command']);

  const onProject = complete();
  onProject.steps[1].instruction = ['Do it.', 'Wait with --on-project mc'];
  assert.deepEqual(sendProblems(onProject), ['steps[2]: a dependency goes in --after <repo>:<project>']);
});

test('sendProblems takes a codex plan with its Codex models, and refuses a Claude model on it', () => {
  const codexPlan = complete({ runner: { tool: 'codex' } });
  codexPlan.steps[0].runner.model = 'gpt-6.1-luna';
  codexPlan.steps[1].runner.model = 'gpt-6.1-sol';
  assert.deepEqual(sendProblems(codexPlan), []);

  codexPlan.steps[1].runner.model = 'opus';
  assert.deepEqual(sendProblems(codexPlan), ['steps[1].runner.model: opus is a Claude model — a codex plan names gpt-6.1-sol or gpt-6.1-luna']);
});

test('withReviewStep runs the review on gpt-6.1-sol at high effort on a codex plan, and on opus everywhere else', () => {
  assert.deepEqual(withReviewStep(complete()).steps.at(-1), REVIEW_STEP);

  const codexPlan = complete({ runner: { tool: 'codex' } });
  codexPlan.steps[0].runner.model = 'gpt-6.1-luna';
  codexPlan.steps[1].runner.model = 'gpt-6.1-sol';
  const sent = withReviewStep(codexPlan);
  assert.deepEqual(sent.steps.at(-1), { ...REVIEW_STEP, runner: { ...CODEX_REVIEW_RUNNER } });
  assert.deepEqual(validatePlan(sent).problems, []);
  assert.deepEqual(REVIEW_STEP.runner, { model: 'opus', effort: 'high' }, 'the constant is the claude review, untouched');
});

test('sendProblems refuses a check that says it runs after the deploy, and a criterion that names a person', () => {
  const ownCheck = complete();
  ownCheck.success_criteria[0].check = 'Martin\'s own check after the deploy; not a step\'s.';
  assert.deepEqual(sendProblems(ownCheck), [
    'success_criteria[1].check: names Martin — a check is a command',
    'success_criteria[1].check: says after the deploy, not a step\'s — a check runs from the step\'s own branch, before the merge (ruling 35 waits on a deploy with mc step blocked --after-deploy, not with a criterion)',
  ]);

  const named = complete();
  named.success_criteria[0].criterion = 'Martin sees the card';
  assert.deepEqual(sendProblems(named), ['success_criteria[1].criterion: names Martin — a criterion is measured by its check, never by a person']);
});

test('withPlanLock runs fn holding the lock, and removes the lock after', () => {
  const dir = scratch();
  try {
    const lock = join(dir, '.lock');
    const result = withPlanLock(dir, () => {
      assert.equal(readFileSync(lock, 'utf8'), String(process.pid));
      return 'done';
    });
    assert.equal(result, 'done');
    assert.equal(existsSync(lock), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('withPlanLock takes over a lock whose pid is dead', () => {
  const dir = scratch();
  try {
    writeFileSync(join(dir, '.lock'), '99999');
    let ran = false;
    withPlanLock(dir, () => { ran = true; }, { alive: () => false });
    assert.equal(ran, true);
    assert.equal(existsSync(join(dir, '.lock')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('withPlanLock throws, naming the holder, when a live pid holds the lock past waitMs', () => {
  const dir = scratch();
  try {
    writeFileSync(join(dir, '.lock'), '4242');
    let ran = false;
    assert.throws(
      () => withPlanLock(dir, () => { ran = true; }, { alive: () => true, waitMs: 50 }),
      (error) => error.message === `${dir} is being written by pid 4242 — try again`,
    );
    assert.equal(ran, false);
    assert.equal(readFileSync(join(dir, '.lock'), 'utf8'), '4242');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readDraftOrPlan parses a file, and throws naming it when it is not JSON', () => {
  assert.deepEqual(readDraftOrPlan('/x/DRAFT.json', { read: () => '{"goal":["a"]}' }), { goal: ['a'] });
  assert.throws(
    () => readDraftOrPlan('/x/DRAFT.json', { read: () => '{nope' }),
    (error) => error.message.startsWith('/x/DRAFT.json is not JSON: '),
  );
});

test('writePlanFile writes the plan whole and returns it', () => {
  const dir = scratch();
  try {
    const file = join(dir, 'sub', 'PLAN.json');
    const plan = complete();
    assert.equal(writePlanFile(file, plan), plan);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), plan);

    const seen = [];
    writePlanFile('/x/DRAFT.json', plan, { write: (path, value) => seen.push([path, value]) });
    assert.deepEqual(seen, [['/x/DRAFT.json', plan]]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('instructionParagraphs cuts at blank lines and keeps a list whole', () => {
  assert.deepEqual(instructionParagraphs('A.\n\nB\n- c\n- d\n\n\n'), ['A.', 'B\n- c\n- d']);
  assert.deepEqual(instructionParagraphs(undefined), []);
});
