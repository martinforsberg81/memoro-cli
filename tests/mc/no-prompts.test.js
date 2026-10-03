import assert from 'node:assert/strict';
import test from 'node:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { forbidCredentialPrompts, NO_PROMPT_ENV } from '../../src/mc/no-prompts.js';
import { runMc } from './_helpers/cli.js';

const NAMES = Object.keys(NO_PROMPT_ENV);

test('forbidCredentialPrompts sets the three names when they are unset', () => {
  const env = forbidCredentialPrompts({ PATH: '/usr/bin' });
  assert.deepEqual(env, {
    PATH: '/usr/bin',
    GIT_TERMINAL_PROMPT: '0',
    GH_PROMPT_DISABLED: '1',
    GCM_INTERACTIVE: 'never',
  });
});

test('forbidCredentialPrompts keeps a value the caller already set', () => {
  const env = forbidCredentialPrompts({ GIT_TERMINAL_PROMPT: '1' });
  assert.equal(env.GIT_TERMINAL_PROMPT, '1');
  assert.equal(env.GH_PROMPT_DISABLED, '1');
});

// The end that matters: a git that mc itself spawns sees the names. `mc gate`
// asks git for the worktree root first thing; the fake git records its
// environment and fails, so the verb stops there and touches nothing.
function fakeGit(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mc-no-prompts-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const out = join(dir, 'git-env.txt');
  const script = ['#!/bin/sh', ...NAMES.map((name) => `echo "${name}=\${${name}-unset}" >> "${out}"`), 'exit 1', ''].join('\n');
  writeFileSync(join(bin, 'git'), script);
  chmodSync(join(bin, 'git'), 0o755);
  const cleared = Object.fromEntries(NAMES.map((name) => [name, undefined]));
  return { dir, out, env: { ...cleared, PATH: `${bin}:/usr/bin:/bin` } };
}

function lastSeen(out) {
  const seen = {};
  for (const line of readFileSync(out, 'utf8').trim().split('\n')) {
    const [name, value] = line.split('=');
    seen[name] = value;
  }
  return seen;
}

test('a git that mc spawns is told not to ask for credentials', (t) => {
  const fake = fakeGit(t);
  const res = runMc(['gate'], { cwd: fake.dir, env: fake.env });
  assert.equal(res.status, 2, res.stderr);
  assert.deepEqual(lastSeen(fake.out), {
    GIT_TERMINAL_PROMPT: '0',
    GH_PROMPT_DISABLED: '1',
    GCM_INTERACTIVE: 'never',
  });
});

test('a value set before mc started reaches the child unchanged', (t) => {
  const fake = fakeGit(t);
  const res = runMc(['gate'], { cwd: fake.dir, env: { ...fake.env, GIT_TERMINAL_PROMPT: '1' } });
  assert.equal(res.status, 2, res.stderr);
  assert.equal(lastSeen(fake.out).GIT_TERMINAL_PROMPT, '1');
});
