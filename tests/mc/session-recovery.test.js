import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { reconcilePreviousSession, retireSettledSession } from '../../src/mc/session-recovery.js';

const NO_PROCESS = 2 ** 31 - 2;
const binding = run_id => ({ programme_id: 'mc', project_id: 'goal', goal_revision: 1, run_id });

function closedSession(t, run_id) {
  const root = mkdtempSync(join(tmpdir(), 'mc-session-recovery-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const gitDir = join(root, 'git');
  const snapshot = join(root, 'run', 'snapshot');
  mkdirSync(gitDir);
  mkdirSync(snapshot, { recursive: true });
  writeFileSync(join(snapshot, 'checkpoint.json'), '{}');
  writeFileSync(join(gitDir, 'mc-autonomous-session.json'), JSON.stringify({ run_id, binding: binding(run_id),
    cwd: join(root, 'moved-on'), pid: NO_PROCESS, process_closed: true, snapshot, unreconciled_tools: false, control_persisted: true }));
  return { gitDir, root };
}

it('a closed session whose attempt is on record does not hold the run after it', t => {
  const { gitDir } = closedSession(t, 'first');
  assert.equal(reconcilePreviousSession(gitDir).ok, false);
  assert.equal(reconcilePreviousSession(gitDir, { settled: ['other'] }).ok, false);
  assert.equal(reconcilePreviousSession(gitDir, { settled: ['first'] }).ok, true);
});

it('a settled session still holds the tree while its process group is alive', t => {
  const { gitDir } = closedSession(t, 'first');
  const path = join(gitDir, 'mc-autonomous-session.json');
  const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
  t.after(() => process.kill(-child.pid));
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), pid: child.pid }));
  assert.deepEqual(reconcilePreviousSession(gitDir, { settled: ['first'] }),
    { ok: false, reason: 'previous-process-group-alive', pid: child.pid });
});

it('a build taking over a diagnosed tree retires only a settled manifest', t => {
  const { gitDir, root } = closedSession(t, 'first');
  retireSettledSession(gitDir, ['other']);
  assert.equal(existsSync(join(gitDir, 'mc-autonomous-session.json')), true);
  retireSettledSession(gitDir, ['first']);
  assert.equal(existsSync(join(gitDir, 'mc-autonomous-session.json')), false);
  assert.equal(existsSync(join(root, 'run', 'retired-manifest.json')), true);
  assert.equal(reconcilePreviousSession(gitDir).ok, true);
});
