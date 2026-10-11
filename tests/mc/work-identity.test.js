/**
 * Who is asking, read from where they stand — and the shape of the work root
 * that answer depends on (ruling 39): `step/<project>` for the runner's areas,
 * `work/<name>` for `mc work`'s, and areas from before `step/` directly under
 * the root.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { STEP_HOME, WORK_HOME, stepAreaName, stepHome, workHome } from '../../src/mc/paths.js';
import { listStepAreas } from '../../src/mc/work-area.js';
import { currentHolder } from '../../src/mc/work-identity.js';

describe('currentHolder', () => {
  const root = mkdtempSync(join(tmpdir(), 'mc-identity-'));
  const env = { MC_WORK_ROOT: root };
  after(() => rmSync(root, { recursive: true, force: true }));
  const at = (...parts) => { const dir = join(root, ...parts); mkdirSync(dir, { recursive: true }); return dir; };

  it('a runner area under step/ holds by its project name', () => {
    assert.deepEqual(currentHolder({ cwd: at('step', 'alpha', 'memoro'), env }), { name: 'alpha', kind: 'work-area' });
  });

  it('a work area under work/ holds by its name', () => {
    assert.deepEqual(currentHolder({ cwd: at('work', 'foo'), env }), { name: 'foo', kind: 'work-area' });
  });

  it('an area directly under the root holds by its own name, as before', () => {
    assert.deepEqual(currentHolder({ cwd: at('legacy', 'memoro-cli'), env }), { name: 'legacy', kind: 'work-area' });
  });

  it('standing in step/ or work/ itself is a shell, not an area', () => {
    assert.equal(currentHolder({ cwd: at('step'), env }).kind, 'shell');
    assert.equal(currentHolder({ cwd: at('work'), env }).kind, 'shell');
  });
});

describe('stepAreaName and listStepAreas', () => {
  const tree = (paths) => {
    const set = new Set(paths);
    const exists = (path) => set.has(path);
    const list = (dir) => [...new Set(paths.filter((p) => p.startsWith(`${dir}/`)).map((p) => p.slice(dir.length + 1).split('/')[0]))];
    return { exists, list };
  };

  it('names the homes and their paths', () => {
    assert.equal(STEP_HOME, 'step');
    assert.equal(WORK_HOME, 'work');
    assert.equal(stepHome({ MC_WORK_ROOT: '/w' }), '/w/step');
    assert.equal(workHome({ MC_WORK_ROOT: '/w' }), '/w/work');
  });

  it('is step/<p> for a new project, and <p> for an area already directly under the root', () => {
    const fs = tree(['/w/old/memoro/.git', '/w/step/new/memoro/.git']);
    assert.equal(stepAreaName('new', { root: '/w', ...fs }), 'step/new');
    assert.equal(stepAreaName('none', { root: '/w', ...fs }), 'step/none');
    assert.equal(stepAreaName('old', { root: '/w', ...fs }), 'old');
  });

  it('a directory under the root with no checkout in it is not a legacy area', () => {
    const fs = tree(['/w/empty/notes.md']);
    assert.equal(stepAreaName('empty', { root: '/w', ...fs }), 'step/empty');
  });

  it('lists step/ and legacy areas by project, never the homes themselves', () => {
    const fs = tree([
      '/w/step/new/memoro/.git',
      '/w/old/memoro-cli/.git',
      '/w/plan/mc/memoro/.git',
      '/w/work/foo/memoro/.git',
      '/w/brief/today.md',
      '/w/.hidden/memoro/.git',
    ]);
    assert.deepEqual(listStepAreas({ root: '/w', ...fs }), [
      { name: 'new', path: '/w/step/new', repos: ['memoro'] },
      { name: 'old', path: '/w/old', repos: ['memoro-cli'] },
    ]);
  });

  it('a project with both is read where stepAreaName puts it: the legacy one', () => {
    const fs = tree(['/w/step/both/memoro/.git', '/w/both/memoro/.git']);
    assert.deepEqual(listStepAreas({ root: '/w', ...fs }), [{ name: 'both', path: '/w/both', repos: ['memoro'] }]);
    assert.equal(stepAreaName('both', { root: '/w', ...fs }), 'both');
  });
});
