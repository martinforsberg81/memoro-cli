/**
 * Task skills: canon's skills installed for Claude Code and Codex under `mc-`,
 * a programme's SKILL.md as `mc-programme-<programme>`, `@skill` in a role, and
 * `mc roles check` naming drift. Every path is a temporary home.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { runMcCli } from './_helpers/mc-cli.js';
import { instructionsFor } from '../../src/mc/roles.js';
import {
  canonSkills, canonSkillsDir, expandRoleSkills, parseSkill, skillStatus, skillTargets, syncSkills,
} from '../../src/mc/skills.js';

function home() {
  const root = mkdtempSync(join(tmpdir(), 'mc-skills-'));
  const env = { HOME: root, CLAUDE_CONFIG_DIR: '', MC_WORK_ROOT: join(root, 'mc') };
  mkdirSync(join(root, 'mc', 'programs'), { recursive: true });
  return { root, env, claude: join(root, '.claude', 'skills'), codex: join(root, '.agents', 'skills') };
}

function canonFixture(skills) {
  const dir = mkdtempSync(join(tmpdir(), 'mc-skills-canon-'));
  for (const [name, text] of Object.entries(skills)) {
    mkdirSync(join(dir, name));
    writeFileSync(join(dir, name, 'SKILL.md'), text);
  }
  return dir;
}

const skill = (name, description = `Use for ${name}.`, body = `# ${name}\n`) => `---\nname: ${name}\ndescription: ${description}\n---\n${body}`;

describe('canon skills', () => {
  it('publish-and-merge ships and parses', () => {
    const text = readFileSync(join(canonSkillsDir(), 'publish-and-merge', 'SKILL.md'), 'utf8');
    const parsed = parseSkill(text);
    assert.equal(parsed?.name, 'publish-and-merge');
    assert.match(parsed.description, /mc gate.*mc publish.*mc merge/u);
    assert.deepEqual(canonSkills().filter((s) => s.invalid), [], 'every canon skill parses');
  });

  it('a canon skill without name or description is invalid, and is not installed', () => {
    const canonDir = canonFixture({
      good: skill('good'),
      nameless: '---\ndescription: Use when.\n---\nbody\n',
      undescribed: '---\nname: undescribed\n---\nbody\n',
    });
    const found = canonSkills({ dir: canonDir });
    assert.deepEqual(found.filter((s) => s.invalid).map((s) => s.name), ['nameless', 'undescribed']);
    const { env, claude } = home();
    syncSkills(env, { canonDir });
    assert.deepEqual(readdirSync(claude), ['mc-good']);
    assert.equal(skillStatus(env, { canonDir }).invalid.length, 2);
  });
});

describe('the sync', () => {
  it('installs for Claude and Codex, rewrites a changed one, removes a stale mc-* one, leaves the rest', () => {
    const { env, claude, codex } = home();
    assert.deepEqual(skillTargets(env).map((t) => t.dir), [claude, codex]);
    const canonDir = canonFixture({ one: skill('one'), two: skill('two') });
    mkdirSync(join(claude, 'mine'), { recursive: true });
    writeFileSync(join(claude, 'mine', 'SKILL.md'), skill('mine'));
    mkdirSync(join(codex, 'mc-gone'), { recursive: true });
    writeFileSync(join(codex, 'mc-gone', 'SKILL.md'), skill('mc-gone'));

    const first = syncSkills(env, { canonDir });
    assert.deepEqual(first.map((r) => `${r.tool} ${r.name} ${r.did}`).sort(), [
      'claude mc-one installed', 'claude mc-two installed',
      'codex mc-gone removed', 'codex mc-one installed', 'codex mc-two installed',
    ]);
    const installed = readFileSync(join(codex, 'mc-one', 'SKILL.md'), 'utf8');
    assert.match(installed, /^---\nname: mc-one\ndescription: Use for one\.\n---\n/u);
    assert.deepEqual(syncSkills(env, { canonDir }), [], 'a second run changes nothing');

    writeFileSync(join(claude, 'mc-one', 'SKILL.md'), 'edited by hand\n');
    writeFileSync(join(claude, 'mc-two', 'extra.md'), 'left over\n');
    assert.deepEqual(skillStatus(env, { canonDir }).rows.filter((r) => r.state !== 'ok').map((r) => `${r.name} ${r.state}`), ['mc-one drift', 'mc-two drift']);
    syncSkills(env, { canonDir });
    assert.equal(readFileSync(join(claude, 'mc-one', 'SKILL.md'), 'utf8'), installed);
    assert.equal(existsSync(join(claude, 'mc-two', 'extra.md')), false);

    assert.equal(readFileSync(join(claude, 'mine', 'SKILL.md'), 'utf8'), skill('mine'), 'a skill without the prefix is untouched');
    assert.equal(existsSync(join(codex, 'mc-gone')), false);
  });

  it('a programme with SKILL.md gets mc-programme-<programme>; one without gets nothing', () => {
    const { env, root, claude, codex } = home();
    const canonDir = canonFixture({});
    mkdirSync(join(root, 'mc', 'programs', 'memoro'));
    writeFileSync(join(root, 'mc', 'programs', 'memoro', 'SKILL.md'), '# Memoro\n\nDeploys go through mc deploy.\n');
    mkdirSync(join(root, 'mc', 'programs', 'bare'));
    syncSkills(env, { canonDir });
    for (const dir of [claude, codex]) {
      assert.deepEqual(readdirSync(dir), ['mc-programme-memoro']);
      const parsed = parseSkill(readFileSync(join(dir, 'mc-programme-memoro', 'SKILL.md'), 'utf8'));
      assert.equal(parsed.name, 'mc-programme-memoro');
      assert.match(parsed.description, /programme "memoro"/u);
      assert.match(parsed.body, /Deploys go through mc deploy\./u);
    }
  });

  it('a programme whose SKILL.md is removed loses its install', () => {
    const { env, root, claude } = home();
    const canonDir = canonFixture({});
    const file = join(root, 'mc', 'programs', 'p', 'SKILL.md');
    mkdirSync(join(root, 'mc', 'programs', 'p'));
    writeFileSync(file, '---\nname: anything\ndescription: Its own words.\n---\nbody\n');
    syncSkills(env, { canonDir });
    assert.match(readFileSync(join(claude, 'mc-programme-p', 'SKILL.md'), 'utf8'), /programme "p".* Its own words\./u);
    rmSync(file);
    syncSkills(env, { canonDir });
    assert.deepEqual(readdirSync(claude), []);
  });
});

describe('@skill in a role', () => {
  it('resolves to a pointer at the installed skill, per tool; an unknown name stays', () => {
    const { env } = home();
    const text = 'Before.\n@skill publish-and-merge\n@skill no-such-skill\nAfter.';
    const claude = expandRoleSkills(text, { tool: 'claude', env });
    assert.match(claude, /^Skill `mc-publish-and-merge` \(~\/\.claude\/skills\/mc-publish-and-merge\/SKILL\.md\): How a change/mu);
    assert.match(claude, /^@skill no-such-skill$/mu);
    assert.doesNotMatch(claude, /^## `mc gate`/mu, 'a pointer, not the text');
    assert.match(expandRoleSkills(text, { tool: 'codex', env }), /~\/\.agents\/skills\/mc-publish-and-merge\/SKILL\.md/u);
  });

  it('instructionsFor resolves it as it resolves @include', () => {
    const out = instructionsFor('claude', 'You are a test role.\n\n@skill publish-and-merge');
    assert.match(out, /Skill `mc-publish-and-merge`/u);
    assert.doesNotMatch(out, /^@skill publish-and-merge$/mu);
  });
});

describe('mc roles check and mc skills', () => {
  it('names skill drift, missing and stale, and sync clears it', () => {
    const { env, claude } = home();
    const base = { ...env, MC_HOME: join(env.HOME, 'mc-home'), MC_ROLES_DIR: join(env.HOME, 'roles') };
    const before = runMcCli(['roles', 'check'], base);
    assert.equal(before.status, 0, before.stderr);
    assert.match(before.stdout, /mc-publish-and-merge\s+missing \(canon\)/u);

    assert.equal(runMcCli(['skills', 'sync'], base).status, 0);
    writeFileSync(join(claude, 'mc-publish-and-merge', 'SKILL.md'), 'changed\n');
    mkdirSync(join(claude, 'mc-old'));
    const drift = runMcCli(['roles', 'check', '--json'], base);
    const rows = JSON.parse(drift.stdout).skills.rows.filter((r) => r.tool === 'claude' && r.state !== 'ok');
    assert.deepEqual(rows.map((r) => `${r.name} ${r.state}`), ['mc-publish-and-merge drift', 'mc-old stale']);
    assert.match(runMcCli(['roles', 'check'], base).stdout, /mc-publish-and-merge\s+drift/u);

    assert.equal(runMcCli(['skills', 'sync'], base).status, 0);
    const after = runMcCli(['skills'], base);
    assert.doesNotMatch(after.stdout, /drift|stale|missing/u);
  });
});
