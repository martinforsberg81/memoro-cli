import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { __test__ } from '../../src/mc/coordinator-command.js';

describe('coordinator command body', () => {
  test('carries the managed marker so hook uninstall can clean it up', () => {
    assert.ok(__test__.COMMAND_BODY.includes(__test__.COMMAND_MARKER));
  });

  test('runs `mc sessions list` on slash-command invocation', () => {
    assert.match(__test__.COMMAND_BODY, /!\s*mc sessions list/);
  });

  test('documents the three coordinator actions', () => {
    assert.match(__test__.COMMAND_BODY, /mc sessions list/);
    assert.match(__test__.COMMAND_BODY, /mc sessions read/);
    assert.match(__test__.COMMAND_BODY, /mc sessions send/);
  });

  test('has the required frontmatter description', () => {
    assert.match(__test__.COMMAND_BODY, /^---\ndescription:/);
  });
});
