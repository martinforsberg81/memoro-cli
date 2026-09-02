/**
 * One session per workplace (D-0154).
 *
 * PM started a session in an area whose worktree belonged to a person's own
 * session — started from their terminal, invisible to mc's background
 * naming — and the new session's `checkout -b` switched the branch under
 * them mid-work. The repo lease protects the merge queue and says nothing
 * about who is sitting in a worktree. So opening a workplace asks who is
 * standing in it, the way the status board does, and refuses a second
 * session with the way through named.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'mc-occupied-'));
process.env.MC_WORK_ROOT = join(root, 'work');
process.env.MC_HOME = join(root, 'home');
process.env.PATH = '/usr/bin:/bin';
mkdirSync(join(root, 'home'), { recursive: true, mode: 0o700 });

const { openArea, parseArgs } = await import('../../src/mc/commands/work.js');

function sink() {
  const out = { text: '', write(chunk) { out.text += chunk; } };
  return out;
}

describe('a workplace somebody is sitting in is not opened twice', () => {
  it('refuses when a tool mc did not start here is standing in the area, and names it', async () => {
    const stdout = sink();
    const stderr = sink();
    const asked = [];
    const occupants = (paths) => { asked.push(paths); return [{ pid: 4242, name: 'claude', directory: join(root, 'work', 'alpha') }]; };
    const code = await openArea('alpha', { pick: 'new' }, { stdout, stderr, occupants });
    assert.equal(code, 1, stderr.text);
    assert.match(stderr.text, /alpha is occupied — claude \(pid 4242\) is working in .*alpha, started outside mc/u);
    assert.match(stderr.text, /one session per workplace \(D-0154\)/u);
    assert.match(stderr.text, /mc work alpha --anyway/u);
    // The area and everything under it was asked about, not just the worktree.
    assert.deepEqual(asked, [[join(root, 'work', 'alpha')]]);
  });

  it('says how many more when there are several', async () => {
    const stderr = sink();
    const occupants = () => [
      { pid: 1, name: 'claude', directory: join(root, 'work', 'alpha') },
      { pid: 2, name: 'codex', directory: join(root, 'work', 'alpha') },
    ];
    await openArea('alpha', { pick: 'new' }, { stdout: sink(), stderr, occupants });
    assert.match(stderr.text, /and 1 more/u);
  });

  it('--anyway is the stated way through, and it is a flag the grammar knows', async () => {
    assert.equal(parseArgs(['alpha', '--anyway']).anyway, true);
    assert.equal(parseArgs(['alpha']).anyway, false);
    const stderr = sink();
    const occupants = () => [{ pid: 4242, name: 'claude', directory: join(root, 'work', 'alpha') }];
    // With no tool on the PATH the open fails later, on its own terms — the
    // point is that it got past the occupancy question.
    await openArea('alpha', { pick: 'new', anyway: true }, { stdout: sink(), stderr, occupants });
    assert.doesNotMatch(stderr.text, /is occupied/u);
  });

  it('an empty workplace is opened as it always was — the question is asked and answered', async () => {
    const stderr = sink();
    let asked = 0;
    await openArea('alpha', { pick: 'new' }, { stdout: sink(), stderr, occupants: () => { asked += 1; return []; } });
    assert.equal(asked, 1);
    assert.doesNotMatch(stderr.text, /is occupied/u);
  });
});

process.on('exit', () => { try { rmSync(root, { recursive: true, force: true }); } catch { /* gone */ } });
