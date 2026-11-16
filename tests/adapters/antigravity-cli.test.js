/**
 * The agy adapter's headless argument list (D4), through the one
 * `headlessArgs` every launch builds with. No agy binary runs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import * as agy from '../../src/adapters/antigravity-cli.js';
import { declared } from '../../src/adapters/index.js';
import { interactiveToolRefusal } from '../../src/mc/interactive-tool.js';
import { headlessArgs } from '../../src/mc/run-plan.js';

const ROLES = new URL('../../canon/roles/', import.meta.url);
const MAX_ARG_STRLEN = 128 * 1024;
const build = (options) => headlessArgs({ toolId: 'antigravity-cli', adapter: agy, model: 'gemini-4-argon-high', effort: 'high', instructions: 'ROLE TEXT', prompt: 'THE TASK', profileArgs: (_tool, text) => [text], ...options });

test('a session: instructions lead the one -p argument behind the separator, stream-json, the model slug as given and no effort flag', () => {
  const args = build({});
  assert.deepEqual(args, ['-p', `ROLE TEXT${agy.INSTRUCTIONS_SEPARATOR}THE TASK`, '--output-format', 'stream-json', '--dangerously-skip-permissions', '--disable-slash-commands', '--model', 'gemini-4-argon-high']);
});

test('a resume names the conversation and sends the task alone: the conversation already holds the instructions', () => {
  const args = build({ resume: 'conv-7' });
  assert.equal(args[1], 'THE TASK');
  assert.deepEqual(args.slice(args.indexOf('--conversation')), ['--conversation', 'conv-7']);
  assert.deepEqual(agy.resumeArgs({ sessionId: 'conv-7', model: 'gemini-4-argon-high' }), ['--conversation', 'conv-7', '--model', 'gemini-4-argon-high']);
  assert.equal(agy.resumeArgs({}), null);
});

test('reading session: stream false prints the one json object, and the declared --add-dir position is a real token of the list', () => {
  const args = build({ stream: false });
  assert.equal(args[args.indexOf('--output-format') + 1], 'json');
  const at = args.indexOf(agy.ALLOWED_DIR.before);
  assert.ok(at > 0, 'the splice point exists');
  const spliced = [...args];
  spliced.splice(at, 0, agy.ALLOWED_DIR.flag, '/checkout');
  assert.deepEqual(spliced.slice(at - 1, at + 3), [args[at - 1], '--add-dir', '/checkout', '--output-format'], 'the flag and its directory land before --output-format, after the prompt');
  assert.equal(spliced[1], args[1], 'the prompt stays the -p value');
});

test('the largest role instruction today, with the shared text and a 20 KB task, fits one argv element', () => {
  const sizes = readdirSync(ROLES).filter((name) => name.endsWith('.md')).map((name) => [name, readFileSync(join(ROLES.pathname, name), 'utf8')]);
  const [, largest] = sizes.reduce((a, b) => (Buffer.byteLength(b[1]) > Buffer.byteLength(a[1]) ? b : a));
  const shared = readFileSync(join(ROLES.pathname, 'all-sessions.md'), 'utf8');
  const args = build({ instructions: `${shared}\n\n${largest}`, prompt: 'x'.repeat(20 * 1024) });
  const bytes = Buffer.byteLength(args[1], 'utf8');
  assert.ok(bytes > 20 * 1024 + 10_000, `the instruction is really in the argument (${bytes} bytes)`);
  assert.ok(bytes < MAX_ARG_STRLEN / 2, `${bytes} bytes against ${MAX_ARG_STRLEN}: room for the task to grow`);
});

test('interactive forms: one -i argument leads with the marker, then instructions, separator and prompt; a resume names the conversation and no instructions', () => {
  const marker = '<!-- mc-launch-v1 {"n":"x"} -->';
  assert.deepEqual(agy.interactiveArgs({ model: 'm1', instructions: 'ROLE', prompt: 'TASK', marker }), ['--model', 'm1', '-i', `${marker}\n\nROLE${agy.INSTRUCTIONS_SEPARATOR}TASK`]);
  assert.deepEqual(agy.interactiveArgs({ instructions: 'ROLE' }), ['-i', 'ROLE'], 'no marker, no prompt: the instructions alone');
  assert.deepEqual(agy.interactiveArgs({ prompt: 'TASK' }), ['-i', 'TASK']);
  assert.deepEqual(agy.interactiveArgs({}), [], 'neither is plain agy');
  assert.deepEqual(agy.interactiveArgs({ resume: 'c-1', model: 'm1', instructions: 'ROLE', prompt: 'TASK', marker }), ['--conversation', 'c-1', '--model', 'm1']);
  assert.equal(agy.INTERACTIVE_ARGS, agy.interactiveArgs);
});

test('declarations: the terminal driver, no background or remote control, and every mechanism an interactive session asks the registry for', () => {
  const id = 'antigravity-cli';
  assert.equal(declared(id, 'PERSISTENT_DRIVER'), 'terminal');
  assert.deepEqual({ ...declared(id, 'SERVER_SESSION') }, { mechanism: 'tty', name: 'Antigravity' });
  assert.equal(declared(id, 'BACKGROUND'), false);
  assert.equal(declared(id, 'REMOTE_CONTROL'), false);
  assert.equal(declared(id, 'PLAN_MODEL'), 'gemini-4-argon-high');
  assert.deepEqual(['FOLDER_TRUST', 'IDENTITY_READER', 'MODEL_READER', 'TAIL_READER', 'CONVERSATION_SOURCE'].map((key) => declared(id, key)), ['agy-trust', 'launch-log', 'agy-step', 'agy-tail', 'agy-brain']);
  assert.deepEqual({ ...declared(id, 'CONVERSATION_DELETE') }, { mechanism: 'agy-conversation', failed: 'conversation-delete-failed' });
  assert.deepEqual({ ...declared(id, 'COST_SOURCE') }, { files: 'agy-brain', reader: 'agy-steps', option: 'agyDir' });
  assert.equal(declared(id, 'SKILLS_DIR')({}, '/h'), '/h/.gemini/antigravity-cli/skills');
  assert.deepEqual({ ...declared(id, 'HOOKS') }, { dialect: 'agy-hooks', file: declared(id, 'HOOKS').file, entry: 'mc', matcher: 'run_command|read_file|view_file|edit_file|write_to_file', tool: 'agy' });
  assert.equal(declared(id, 'HOOKS').file({}, '/h'), '/h/.gemini/config/hooks.json');
  assert.equal(interactiveToolRefusal('agy'), null, 'agy is offered an interactive session');
});
