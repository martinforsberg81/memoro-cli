import test, { describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runMc, parseJsonOrNull } from './_helpers/cli.js';
import { makeTempRepo } from './_helpers/git-fixture.js';
import { writeRegistry, makeEntry } from './_helpers/registry-fixture.js';

describe('mc spawn — session fabric', () => {
  let repo, pidDir;
  beforeEach(() => {
    repo = makeTempRepo({ name: 'spawn' });
    pidDir = mkdtempSync(join(tmpdir(), 'mc-spawn-pid-'));
    mkdirSync(repo.mcHome, { recursive: true });
    writeFileSync(join(repo.mcHome, '.setup-done-v1'), 'test\n');
  });
  afterEach(() => {
    repo.cleanup();
    try { rmSync(pidDir, { recursive: true, force: true }); } catch {}
  });

  test('missing args → exit 2 + usage', () => {
    const r = runMc(['spawn'], {
      cwd: repo.dir,
      env: { MC_HOME: repo.mcHome, MC_ORPHAN_PID_DIR: pidDir, HOME: repo.root },
    });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /usage|Usage/);
  });

  test('live happy path creates a tracked project session with a brief', () => {
    const r = runMc([
      'spawn',
      'i18n',
      'Build the locale picker and report status back',
      '--scope',
      'French UI locale',
      '--codex',
      '--json',
    ], {
      cwd: repo.dir,
      env: {
        MC_HOME: repo.mcHome,
        MC_ORPHAN_PID_DIR: pidDir,
        HOME: repo.root,
        MC_SESSION_NAME: 'coord',
      },
    });
    assert.equal(r.status, 0, r.stderr);
    const payload = parseJsonOrNull(r.stdout);
    assert.equal(payload.name, 'i18n');
    assert.equal(payload.parent, 'coord');
    assert.equal(payload.kind, 'project');
    assert.equal(payload.role, 'project');
    assert.equal(payload.tool, 'codex');
    assert.equal(payload.scope, 'French UI locale');
    assert.equal(payload.launched, false);

    const reg = JSON.parse(readFileSync(join(repo.mcHome, 'registry.json'), 'utf8'));
    const entry = reg.entries.find((e) => e.name === 'i18n');
    assert.equal(entry.kind, 'project');
    assert.equal(entry.parent, 'coord');
    assert.equal(entry.focus, 'French UI locale');
    assert.equal(entry.scope, 'French UI locale');
    assert.equal(entry.branch, 'sess/i18n');
    assert.ok(existsSync(entry.worktree_path));

    const brief = readFileSync(entry.brief_path, 'utf8');
    assert.match(brief, /Project session brief/);
    assert.match(brief, /Parent coordinator: coord/);
    assert.match(brief, /Focus: French UI locale/);
    assert.doesNotMatch(brief, /MEMORO\.md/);
    assert.match(brief, /Build the locale picker/);
  });

  test('legacy project entries migrate to flat V1 sessions without a tree mode', () => {
    writeRegistry(repo.mcHome, [
      makeEntry({ name: 'coord', kind: 'work', parent: null, branch: 'sess/coord', tool: 'claude' }),
      makeEntry({
        name: 'i18n',
        kind: 'project',
        parent: 'coord',
        branch: 'sess/i18n',
        tool: 'codex',
        scope: 'French UI locale',
      }),
    ]);

    const plain = runMc(['list'], {
      cwd: repo.dir,
      env: { MC_HOME: repo.mcHome, MC_ORPHAN_PID_DIR: pidDir, HOME: repo.root },
    });
    assert.equal(plain.status, 0, plain.stderr);
    assert.match(plain.stdout, /coord/);
    assert.match(plain.stdout, /i18n/);

    const tree = runMc(['list', '--tree'], {
      cwd: repo.dir,
      env: { MC_HOME: repo.mcHome, MC_ORPHAN_PID_DIR: pidDir, HOME: repo.root },
    });
    assert.equal(tree.status, 2);
    assert.match(tree.stderr, /unknown flag: --tree/);
  });
});
