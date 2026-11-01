import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { test } from 'node:test';

test('a suite never inherits the identity of the session that started its gate', () => {
  const names = ['MC_AUTONOMOUS_RUN', 'MC_AUTONOMOUS_ROLE', 'MC_PROGRAMME', 'MC_PROJECT'];
  const script = `process.stdout.write(JSON.stringify(${JSON.stringify(names)}.filter(name => name in process.env)))`;
  const run = spawnSync(process.execPath, ['--import', resolve('tests/_isolate-home.mjs'), '-e', script], {
    encoding: 'utf8', env: { ...process.env, ...Object.fromEntries(names.map(name => [name, 'step'])) } });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), []);
});
