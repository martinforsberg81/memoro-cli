/**
 * One root per kind of area (ruling 39): `mc work <name>` lives under
 * `~/mc/work/`, the runner's areas under `~/mc/step/`, and whatever else
 * stands directly under `~/mc` is a stray the page shows and nobody touches.
 *
 * A name typed at `mc work` that exists only as a runner area opens that area
 * and says so; release and discard refuse it, because a runner area closes
 * with its project.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'mc-work-layout-'));
const mc = join(root, 'mc');
process.env.MC_WORK_ROOT = mc;
process.env.MC_HOME = join(root, 'home');
process.env.PATH = '/usr/bin:/bin';
mkdirSync(join(root, 'home'), { recursive: true, mode: 0o700 });
mkdirSync(join(mc, 'step', 'retention', 'memoro-cli', '.git'), { recursive: true });

const { openArea, runVerb } = await import('../../src/mc/commands/work.js');
const { workAreaName } = await import('../../src/mc/paths.js');
const { listStepAreas, listStrays, listWorkAreas } = await import('../../src/mc/work-area.js');
const { registerPath } = await import('../../src/mc/register.js');

function sink() {
  const out = { text: '', write(chunk) { out.text += chunk; } };
  return out;
}

describe('mc work resolves a name to work/ first, then the runner', () => {
  it('a new name is work/<name>, to be created', () => {
    assert.deepEqual(workAreaName('fresh', { root: mc }), { name: 'work/fresh', runner: false });
  });

  it('a name that exists only as step/<project> opens that area, and says so', async () => {
    const stdout = sink();
    const stderr = sink();
    let asked = null;
    const occupants = (paths) => { asked = paths; return []; };
    await openArea('retention', { pick: 'new' }, { stdout, stderr, occupants });
    assert.match(stderr.text, /opening the runner's area for retention — .*mc\/step\/retention/u);
    assert.equal(asked[0], join(mc, 'step', 'retention'));
    assert.equal(existsSync(join(mc, 'work', 'retention')), false);
  });

  it('release and discard refuse a runner area, with exit 2', async () => {
    for (const verb of ['release', 'discard']) {
      const stderr = sink();
      const code = await runVerb({ verb, name: 'retention' }, { stdout: sink(), stderr });
      assert.equal(code, 2, verb);
      assert.match(stderr.text, /retention is a runner area — it closes with its project/u);
    }
    assert.ok(existsSync(join(mc, 'step', 'retention', 'memoro-cli', '.git')));
  });

  it('work/<name> wins over a runner area of the same name', () => {
    mkdirSync(join(mc, 'work', 'retention'), { recursive: true });
    try {
      assert.deepEqual(workAreaName('retention', { root: mc }), { name: 'work/retention', runner: false });
    } finally { rmSync(join(mc, 'work', 'retention'), { recursive: true, force: true }); }
  });

  it('listWorkAreas enumerates work/ and nothing else', () => {
    mkdirSync(join(mc, 'work', 'alpha'), { recursive: true });
    mkdirSync(join(mc, 'legacy-area'), { recursive: true });
    try {
      assert.deepEqual(listWorkAreas(process.env, { conversations: false, git: false }).map((area) => area.name), ['work/alpha']);
    } finally {
      rmSync(join(mc, 'work', 'alpha'), { recursive: true, force: true });
      rmSync(join(mc, 'legacy-area'), { recursive: true, force: true });
    }
  });
});

describe('listStepAreas in layout 2', () => {
  it('lists runner/step/<project> by project, and no area directly under the root', () => {
    const two = mkdtempSync(join(tmpdir(), 'mc-step-areas-2-'));
    try {
      mkdirSync(join(two, 'runner'), { recursive: true });
      writeFileSync(join(two, 'runner', 'layout.json'), JSON.stringify({ schema: 'mc-layout', version: 2 }));
      mkdirSync(join(two, 'runner', 'step', 'x', 'memoro', '.git'), { recursive: true });
      mkdirSync(join(two, 'x', 'memoro', '.git'), { recursive: true });
      mkdirSync(join(two, 'y', 'memoro-cli', '.git'), { recursive: true });
      mkdirSync(join(two, 'step', 'z', 'memoro', '.git'), { recursive: true });
      assert.deepEqual(listStepAreas({ root: two }), [{ name: 'x', path: join(two, 'runner', 'step', 'x'), repos: ['memoro'] }]);
    } finally { rmSync(two, { recursive: true, force: true }); }
  });
});

describe('listStrays', () => {
  it('a checkout under a name no kind knows is a stray; mc\'s own homes are not', () => {
    const strayRoot = mkdtempSync(join(tmpdir(), 'mc-strays-'));
    try {
      mkdirSync(join(strayRoot, 'jobbet', 'memoro', '.git'), { recursive: true });
      mkdirSync(join(strayRoot, 'runner'), { recursive: true });
      mkdirSync(join(strayRoot, 'step', 'p'), { recursive: true });
      mkdirSync(join(strayRoot, 'work', 'w'), { recursive: true });
      mkdirSync(join(strayRoot, '.cache'), { recursive: true });
      // A legacy runner area of a project in the register is the runner's.
      mkdirSync(join(strayRoot, 'oldproj', 'memoro-cli', '.git'), { recursive: true });
      const register = registerPath(strayRoot, 'oldproj');
      mkdirSync(join(register, '..'), { recursive: true });
      writeFileSync(register, '{}\n');
      // A role home is mc worker's.
      mkdirSync(join(strayRoot, 'helper2'), { recursive: true });
      writeFileSync(join(strayRoot, 'helper2', '.mc-role'), 'worker\n');

      assert.deepEqual(listStrays({ root: strayRoot }).map((dir) => dir.name), ['jobbet']);
    } finally { rmSync(strayRoot, { recursive: true, force: true }); }
  });
});

process.on('exit', () => { try { rmSync(root, { recursive: true, force: true }); } catch { /* gone */ } });
