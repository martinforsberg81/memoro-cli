import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { __test__ } from '../../src/mc/coordinator-command.js';

describe('coordinator slash command body', () => {
  test('carries the managed marker so hook uninstall can clean it up', () => {
    assert.ok(__test__.COMMAND_BODY.includes(__test__.COMMAND_MARKER));
  });

  test('runs `mc sessions list` on slash-command invocation', () => {
    assert.match(__test__.COMMAND_BODY, /!\s*mc sessions list/);
  });

  test('instructs the LLM to present sessions as a numbered list', () => {
    assert.match(__test__.COMMAND_BODY, /numbered list/i);
  });

  test('documents the three coordinator actions with label-or-id', () => {
    assert.match(__test__.COMMAND_BODY, /mc sessions list/);
    assert.match(__test__.COMMAND_BODY, /mc sessions read <label\|id>/);
    assert.match(__test__.COMMAND_BODY, /mc sessions send <label\|id>/);
  });

  test('teaches the LLM to flag PAUSED sessions explicitly', () => {
    assert.match(__test__.COMMAND_BODY, /PAUSED/);
  });

  test('points users at /memoro-coordinator-suggest for next-step recs', () => {
    assert.match(__test__.COMMAND_BODY, /\/memoro-coordinator-suggest/);
  });

  test('has the required frontmatter description', () => {
    assert.match(__test__.COMMAND_BODY, /^---\ndescription:/);
  });
});

describe('coordinator-suggest slash command body', () => {
  test('carries the managed marker', () => {
    assert.ok(__test__.COMMAND_BODY_SUGGEST.includes(__test__.COMMAND_MARKER));
  });

  test('runs `mc sessions list` on invocation', () => {
    assert.match(__test__.COMMAND_BODY_SUGGEST, /!\s*mc sessions list/);
  });

  test('instructs the LLM to call mc sessions read per session', () => {
    assert.match(__test__.COMMAND_BODY_SUGGEST, /mc sessions read/);
  });

  test('requires numbered-list output with Doing + Next lines', () => {
    assert.match(__test__.COMMAND_BODY_SUGGEST, /numbered list/i);
    assert.match(__test__.COMMAND_BODY_SUGGEST, /Doing:/);
    assert.match(__test__.COMMAND_BODY_SUGGEST, /Next:/);
  });

  test('forbids the LLM from dispatching on its own', () => {
    assert.match(__test__.COMMAND_BODY_SUGGEST, /[Dd]o not dispatch/);
  });

  test('asks for a prioritisation at the end', () => {
    assert.match(__test__.COMMAND_BODY_SUGGEST, /prioritis/i);
  });
});
