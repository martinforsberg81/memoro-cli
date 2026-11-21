/**
 * The verbs `mc programs` once had and has no more — `sign`, `return`, `drop`, `model` — exit 2 for every
 * caller and change nothing. These cases stood in `tests/mc/commands/plan.test.js` until `mc plan` went
 * (2026-11-21); the plan role's callers are taken out, since no session has that role.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { run as programs } from '../../src/mc/commands/programs.js';
import { newRecord, writeRecord } from '../../src/mc/programme-record.js';

function sink() {
  const out = { text: '' };
  return { out, write: (s) => { out.text += s; } };
}

describe('removed verbs exit 2', () => {
  it('refuses sign, return, drop and model with exit 2 and has no effects', async (t) => {
    const setupStart = performance.now();
    const root = mkdtempSync(join(tmpdir(), 'mc-sign-authority-'));
    try {
      const dir = join(root, 'programs', 'p');
      mkdirSync(dir, { recursive: true });
      writeRecord(dir, newRecord({ end: 'A signed result.', createdBy: 'person' }));
      const before = readFileSync(join(dir, 'PROGRAMME.json'), 'utf8');
      t.diagnostic(`sign authority fixture setup: ${(performance.now() - setupStart).toFixed(3)} ms`);
      for (const caller of [
        { MC_ROLE: 'manager' }, { MC_ROLE: 'build-session:goal', MC_GOAL: 'p/g' },
        { MC_ROLE: 'martin', MC_HEADLESS: '1' }, {}, { MC_ROLE: 'programme-review' },
      ]) {
        const stdout = sink(), stderr = sink();
        const code = await programs(['sign', 'p', '--reason', 'Cannot override caller authority'], {
          env: { MC_HOME: join(root, 'home'), MC_WORK_ROOT: root, ...caller }, stdout, stderr,
        });
        assert.equal(code, 2, JSON.stringify(caller));
        assert.match(stderr.out.text, /unknown flag: --reason|mc programs has no sign/u);
        assert.equal(stdout.out.text, '');
        assert.equal(readFileSync(join(dir, 'PROGRAMME.json'), 'utf8'), before);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

it('programme return and drop exit 2 without effects', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mc-return-authority-'));
  try {
    const dir = join(root, 'programs', 'p'); mkdirSync(dir, { recursive: true });
    const initial = newRecord({ end: 'A result.', createdBy: 'person' });
    writeRecord(dir, initial);
    for (const verb of ['return', 'drop']) {
      const record = initial;
      writeFileSync(join(dir, 'PROGRAMME.json'), JSON.stringify(record));
      const before = readFileSync(join(dir, 'PROGRAMME.json'), 'utf8');
      for (const caller of [{}, { MC_ROLE: 'manager' }, { MC_ROLE: 'build-session:goal', MC_GOAL: 'p/g' }, { MC_ROLE: 'martin', MC_HEADLESS: '1' }, { MC_ROLE: 'programme-review' }]) {
        const stdout = sink(), stderr = sink();
        assert.equal(await programs([verb, 'p', '--reason', 'Not authorized'], { env: { MC_HOME: join(root, 'home'), MC_WORK_ROOT: root, ...caller }, stdout, stderr }), 2, `${verb} ${JSON.stringify(caller)}`);
        assert.match(stderr.out.text, new RegExp(`unknown flag: --reason|mc programs has no ${verb}`, 'u'));
        assert.equal(stdout.out.text, '');
        assert.equal(readFileSync(join(dir, 'PROGRAMME.json'), 'utf8'), before);
        assert.deepEqual(readdirSync(dir), ['PROGRAMME.json']);
      }
      for (const args of [[verb, 'p'], [verb, 'p', '--reason', ' '], [verb, 'p', '--reason', 'r', '--bogus'], [verb, 'p', 'extra', '--reason', 'r']]) {
        assert.equal(await programs(args, { env: { MC_HOME: join(root, 'home'), MC_WORK_ROOT: root, MC_ROLE: 'martin' }, stdout: sink(), stderr: sink() }), 2, args.join(' '));
        assert.equal(readFileSync(join(dir, 'PROGRAMME.json'), 'utf8'), before);
        assert.deepEqual(readdirSync(dir), ['PROGRAMME.json']);
      }
    }
    assert.equal(await programs(['model', 'unexpected'], { env: { MC_WORK_ROOT: root }, stdout: sink(), stderr: sink() }), 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
