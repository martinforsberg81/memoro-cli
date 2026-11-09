/** Observable discovery, migration and lazy resource loading in isolated homes. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { preloadVerbs, runVerb } from './_helpers/mc-verb.js';
import { instructionsFor, readCanonRole } from '../../src/mc/roles.js';
import { parseSkill, skillStatus, skillTargets, syncSkills, wantedSkills } from '../../src/mc/skills.js';

await preloadVerbs('roles', 'skills');

function home() {
  const root = mkdtempSync(join(tmpdir(), 'mc-skills-'));
  const env = { HOME: root, CLAUDE_CONFIG_DIR: '', MC_WORK_ROOT: join(root, 'mc') };
  mkdirSync(join(root, 'mc', 'programs'), { recursive: true });
  return { root, env, targets: skillTargets(env).map((t) => t.dir) };
}

const read = (path) => readFileSync(path, 'utf8');
function write(path, text) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
}
function legacy(dir, name) {
  const path = join(dir, name, 'SKILL.md');
  write(path, `---\nname: ${name}\ndescription: Old mc guidance.\n---\n<!-- Installed by mc from canon/skills/old/SKILL.md. mc rewrites this file; change the source. -->\nOld body.\n`);
  return path;
}
function entries(dir) {
  return readdirSync(dir, { recursive: true }).filter((path) => path.split('/').at(-1) === 'SKILL.md').sort();
}

// Minimal real bundle, so source failures can be exercised without editing canon.
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mc-skill-source-'));
  write(join(root, 'SKILL.md'), '---\nname: mc\ndescription: Work in mc.\n---\nRead tasks/test.md.\n');
  write(join(root, 'tasks/test.md'), '---\nname: test\ndescription: Test a change.\n---\nRun mc gate.\n');
  return root;
}

describe('the mc bundle', () => {
  it('migrates both tools to one entrypoint, preserves unrelated skills, repairs drift and is idempotent', () => {
    const { env, targets } = home();
    for (const dir of targets) {
      legacy(dir, 'mc-publish-and-merge');
      legacy(dir, 'mc-programme-old');
      write(join(dir, 'mine/SKILL.md'), 'personal skill');
      write(join(dir, 'mc-personal/SKILL.md'), 'unmarked personal skill');
      symlinkSync(join(env.HOME, 'not-a-skill'), join(dir, 'mc-link'));
    }
    const changed = syncSkills(env);
    for (const tool of ['claude', 'codex']) {
      assert.deepEqual(changed.filter((row) => row.tool === tool).map(({ name, did }) => [name, did]), [
        ['mc', 'installed'], ['mc-programme-old', 'removed'], ['mc-publish-and-merge', 'removed'],
      ]);
    }
    for (const dir of targets) {
      assert.deepEqual(entries(dir), ['mc-personal/SKILL.md', 'mc/SKILL.md', 'mine/SKILL.md']);
      assert.equal(parseSkill(read(join(dir, 'mc/SKILL.md'))).name, 'mc');
      assert.equal(read(join(dir, 'mine/SKILL.md')), 'personal skill');
      assert.equal(read(join(dir, 'mc-personal/SKILL.md')), 'unmarked personal skill');
      const task = join(dir, 'mc/tasks/git.md');
      write(task, 'changed task');
      write(join(dir, 'mc/obsolete.md'), 'obsolete');
      syncSkills(env);
      assert.match(read(task), /Never `git stash`/u);
      assert.equal(existsSync(join(dir, 'mc/obsolete.md')), false);
    }
    assert.deepEqual(syncSkills(env), []);
    assert.ok(skillStatus(env).rows.every((row) => row.state === 'ok'));
  });

  it('keeps existing guidance when the source is invalid or replacement is refused', () => {
    const { env, targets } = home();
    const root = fixture();
    const old = legacy(targets[0], 'mc-old');
    const before = read(old);
    write(join(root, 'SKILL.md'), 'invalid');
    assert.throws(() => syncSkills(env, { root }), /must name mc/u);
    assert.equal(read(old), before);
    assert.equal(existsSync(join(targets[0], 'mc')), false);
    assert.equal(existsSync(targets[1]), false);

    write(join(targets[0], 'mc/SKILL.md'), 'my own mc skill');
    assert.throws(() => syncSkills(env), /unowned mc skill/u);
    assert.equal(read(old), before);
    assert.equal(read(join(targets[0], 'mc/SKILL.md')), 'my own mc skill');
    rmSync(join(targets[0], 'mc'), { recursive: true });
    symlinkSync(join(env.HOME, 'missing-target'), join(targets[0], 'mc'));
    assert.throws(() => syncSkills(env), /unowned mc skill/u);
    assert.equal(read(old), before);

    // The second home is refused before the first is written, so no legacy guidance moves.
    unlinkSync(join(targets[0], 'mc')); // rmSync leaves a dangling symlink in place
    const second = legacy(targets[1], 'mc-old2');
    const secondBefore = read(second);
    write(join(targets[1], 'mc/SKILL.md'), 'their own mc skill');
    assert.throws(() => syncSkills(env), (error) => error.message === `refusing to replace an unowned mc skill: ${join(targets[1], 'mc')}`);
    assert.equal(read(old), before);
    assert.equal(read(second), secondBefore);
    assert.equal(existsSync(join(targets[0], 'mc')), false);
    assert.equal(read(join(targets[1], 'mc/SKILL.md')), 'their own mc skill');
    rmSync(join(targets[1], 'mc'), { recursive: true });
    assert.deepEqual(syncSkills(env).map(({ tool, name, did }) => [tool, name, did]), [
      ['claude', 'mc', 'installed'], ['claude', 'mc-old', 'removed'],
      ['codex', 'mc', 'installed'], ['codex', 'mc-old2', 'removed'],
    ]);
    assert.deepEqual(syncSkills(env), []);
  });

  it('refuses nested entrypoints before they can advertise more skills', () => {
    const { env, targets } = home();
    const root = fixture();
    write(join(root, 'roles/extra/SKILL.md'), 'unexpected entrypoint');
    assert.throws(() => syncSkills(env, { root }), /nested skill entrypoint/u);
    assert.equal(existsSync(targets[0]), false);
  });

  it('routes programme context to its README without copying it into the skill bundle', () => {
    const { env, root, targets } = home();
    const readme = join(root, 'mc/programs/p/README.md');
    write(readme, 'Current programme context.\n');
    // An old source must never be installed as another copy of programme context.
    write(join(root, 'mc/programs/p/SKILL.md'), 'Obsolete programme context.\n');
    legacy(targets[0], 'mc-programme-p');
    syncSkills(env);
    for (const dir of targets) {
      assert.deepEqual(entries(dir), ['mc/SKILL.md']);
      assert.equal(existsSync(join(dir, 'mc/programmes')), false);
      assert.equal(existsSync(join(dir, 'mc-programme-p')), false);
      const router = read(join(dir, 'mc/SKILL.md'));
      assert.ok(router.includes('~/mc/programs/<programme>/README.md'));
      assert.doesNotMatch(router, /Current programme context|Obsolete programme context/u);
    }
    assert.equal(read(readme), 'Current programme context.\n');
    write(readme, 'Updated programme context.\n');
    assert.deepEqual(syncSkills(env), [], 'README edits need no skill regeneration');
  });

  it('installs every routed reference, including test details and verb pointers, for either tool', () => {
    const { env, targets } = home();
    env.CLAUDE_CONFIG_DIR = join(env.HOME, 'custom-claude');
    syncSkills(env);
    const files = wantedSkills(env)[0].files;
    for (const match of files['SKILL.md'].matchAll(/\]\(([^)]+\.md)\)/gu)) {
      assert.ok(files[match[1]], `unresolved router link ${match[1]}`);
    }
    assert.ok(files['tasks/references/test-strategy.md']);
    for (const tool of ['claude-code', 'codex']) {
      const told = instructionsFor(tool, readCanonRole('plan').overlay);
      const paths = [...told.matchAll(/`(~\/[^`]+\.md)`/gu)].map((m) => m[1]).filter((path) => path.includes('/skills/mc/'));
      assert.ok(paths.some((path) => path.endsWith('/mc/SKILL.md')));
      assert.ok(paths.some((path) => path.endsWith('/mc/verbs/goal.md')));
      for (const path of paths) {
        // instructionsFor uses process.env; map its tool target to the fixture.
        const resource = path.slice(path.indexOf('/mc/') + 4);
        const target = tool === 'codex' ? targets[1] : join(env.CLAUDE_CONFIG_DIR, 'skills');
        assert.ok(existsSync(join(target, 'mc', resource)), path);
      }
      assert.doesNotMatch(told, /Skills this role uses:|mc-publish-and-merge|\*\*Written by verbs\.\*\*/u);
    }
  });

  it('reports bundle and legacy drift through the command, and sync clears it', async () => {
    const { env, targets } = home();
    const base = { ...env, MC_HOME: join(env.HOME, 'mc-home'), MC_ROLES_DIR: join(env.HOME, 'roles') };
    const before = await runVerb(['roles', 'check'], base);
    assert.equal(before.status, 0, before.stderr);
    assert.match(before.stdout, /mc\s+missing \(canon\)/u);
    assert.equal((await runVerb(['skills', 'sync'], base)).status, 0);
    write(join(targets[0], 'mc/tasks/git.md'), 'changed');
    legacy(targets[0], 'mc-old');
    const drift = await runVerb(['skills', '--json'], base);
    assert.deepEqual(JSON.parse(drift.stdout).rows.filter((r) => r.tool === 'claude').map((r) => [r.name, r.state]), [
      ['mc', 'drift'], ['mc-old', 'stale'],
    ]);
    assert.equal((await runVerb(['skills', 'sync'], base)).status, 0);
    assert.doesNotMatch((await runVerb(['skills'], base)).stdout, /drift|stale|missing/u);
  });
});
