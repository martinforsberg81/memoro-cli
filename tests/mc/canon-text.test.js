/**
 * One home per rule (goal `agent-skills-text`, Martin 2026-11-02: "Vad besluten
 * är är inte det viktigaste. Det är var texten är.").
 *
 * A role (`canon/roles/<role>.md`) says what the role is for, what it owns and
 * how it ends. How to do a task — test and publish, resolve a conflict, write a
 * proposal — is a skill (`canon/skills/<task>/SKILL.md`), and a role names it
 * with `@skill` rather than repeating it. These tests hold that placement: a
 * sentence from each skill is in that skill's file and in no other canon file,
 * no role file repeats a skill's sentences, and every role names what it needs.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { canonRolesDir, instructionsFor, readCanonRole } from '../../src/mc/roles.js';
import { canonSkills, canonSkillsDir } from '../../src/mc/skills.js';

/** Canon text wraps at about 80 columns, so a phrase test crosses newlines. */
const phrase = (words) => new RegExp(words.split(' ').map((w) => w.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('\\s+'), 'u');

/** A sentence that defines each skill, from the body. */
const DEFINING = {
  'publish-and-merge': 'Never lower a threshold, or skip, weaken or delete a test to turn it green.',
  'merge-conflicts': 'Never chain `git commit` after `git merge`',
  git: 'The stack is shared, and push/pop has destroyed parallel work.',
  proposals: 'What you found that is not your job is a proposal',
  processes: 'know what it is before you signal it',
  'scratch-and-probes': 'Files that are not the change — probes, output, a PR body, a script — go in',
  'measure-the-app': 'Prove which tree is served before you measure.',
  'dev-servers': 'Dev servers start only through mc',
  'asking-martin': 'Never a menu of options.',
  memory: 'A rule about how to work is never a memory.',
  'writing-a-plan': 'A plan is written through the verbs; the files are mc',
  'writing-tests': 'A pinned number is a summary of a list, and the list is what to pin.',
};

const roleFiles = () => readdirSync(canonRolesDir()).filter((f) => f.endsWith('.md')).map((f) => join(canonRolesDir(), f));
const skillFiles = () => canonSkills().map((s) => join(canonSkillsDir(), s.name, 'SKILL.md'));
const read = (path) => readFileSync(path, 'utf8');
const rel = (path) => path.slice(path.indexOf('canon/'));
const body = (text) => text.replace(/^---\n[\s\S]*?\n---\n/u, '');
const flat = (text) => text.replace(/\s+/gu, ' ');

describe('one home per rule in canon/', () => {
  it('every canon skill has a defining sentence here, and none is missing from canon', () => {
    assert.deepEqual(canonSkills().map((s) => s.name).sort(), Object.keys(DEFINING).sort());
  });

  for (const [name, sentence] of Object.entries(DEFINING)) {
    it(`${name}: its defining sentence is in its own SKILL.md and in no other canon file`, () => {
      const re = phrase(sentence);
      const carriers = [...roleFiles(), ...skillFiles()].filter((path) => re.test(read(path))).map(rel);
      assert.deepEqual(carriers, [`canon/skills/${name}/SKILL.md`]);
    });
  }

  it('no role file repeats a sentence of any skill', () => {
    const roles = roleFiles().map((path) => [rel(path), flat(read(path))]);
    for (const path of skillFiles()) {
      const sentences = flat(body(read(path)))
        .split(/(?<=[.:!?])\s+/u)
        .map((s) => s.replace(/^[-#*\s]+/u, '').trim())
        .filter((s) => s.length >= 50);
      for (const sentence of sentences) {
        for (const [role, text] of roles) {
          assert.ok(!text.includes(sentence), `${role} repeats ${rel(path)}: "${sentence}"`);
        }
      }
    }
  });

  // Rules the review on 9fcf6d0 found stated twice: each has one home, and elsewhere a pointer.
  const RULES = {
    'publish-and-merge': [/admin override and no gate round/u, /pushes, opens the PR and queues it/u, /queues\s+nothing/u],
    processes: [/not yours to stop/u, /know what it is before you signal it/u],
    'writing-a-plan': [/mc project step add <project>/u],
    'writing-tests': [/pinned number is a summary/u, /scan reads what git tracks/u],
  };
  for (const [home, rules] of Object.entries(RULES)) {
    it(`${home}: the rules it owns are stated there and nowhere else in canon`, () => {
      for (const rule of rules) {
        const carriers = [...roleFiles(), ...skillFiles()].filter((path) => rule.test(flat(read(path)))).map(rel);
        assert.deepEqual(carriers, carriers.length ? [`canon/skills/${home}/SKILL.md`] : [], `${rule} in ${carriers.join(', ')}`);
      }
    });
  }

  // Martin 2026-11-03, after a plan session with full freedom left a branch
  // because a skill said branches were mc's: a skill says how a task is done
  // and what breaks, never who may do it. Who may is the role's; the one hard
  // boundary (a headless session's) is code, HEADLESS_RULES in src/mc/hooks.js.
  it('no skill says who may act: no permission language in canon/skills', () => {
    const PERMISSION = [
      /\bthe person's\b/iu, /\ba person's\b/iu, /\bMartin's (verb|act|word|call)/iu,
      /\bon (his|their|Martin's) word\b/iu, /\bstays? (his|theirs|Martin's)\b/iu,
      /\byour role's to say\b/iu, /\b(branch|worktree)[^.]* are mc's\b/iu, /\bnot yours\b/iu,
      /\bonly (Martin|the person|a person) (may|can|does)\b/iu,
    ];
    const found = [];
    for (const path of skillFiles()) {
      const text = flat(body(read(path)));
      for (const re of PERMISSION) {
        const hit = text.match(re);
        if (hit) found.push(`${rel(path)}: "${hit[0]}"`);
      }
    }
    assert.deepEqual(found, []);
  });

  it('a skill is a page at most', () => {
    for (const path of skillFiles()) {
      assert.ok(read(path).split('\n').length <= 60, `${rel(path)} is longer than a page`);
    }
  });
});

describe('every role names the skills it needs', () => {
  const BUILDS = ['build-session:goal', 'build-session:project', 'build-session:worker'];
  const ROLES = ['brief', ...BUILDS, 'review-session:goal', 'review-session:project', 'helper', 'intake', 'plan-session'];
  const named = (overlay) => [...overlay.matchAll(/^@skill[ \t]+([a-z0-9-]+)[ \t]*$/gmu)].map((m) => m[1]);

  it('names only skills canon ships, and every skill is named by some role', () => {
    const known = new Set(canonSkills().map((s) => s.name));
    const used = new Set();
    for (const role of ROLES) {
      for (const name of named(readCanonRole(role).overlay)) {
        assert.ok(known.has(name), `${role} names an unknown skill ${name}`);
        used.add(name);
      }
    }
    assert.deepEqual([...used].sort(), [...known].sort());
  });

  // The rules that were in every session's text: a finding is a proposal, and
  // a process you did not start is not yours.
  it('every role names the proposals skill; every role that runs commands names processes', () => {
    for (const role of ROLES) {
      const skills = named(readCanonRole(role).overlay);
      assert.ok(skills.includes('proposals'), `${role} does not name proposals`);
      if (role !== 'intake') assert.ok(skills.includes('processes'), `${role} does not name processes`);
    }
  });

  it('every role that changes code names publish-and-merge, git and scratch-and-probes', () => {
    for (const role of ['brief', ...BUILDS, 'plan-session', 'review-session:project']) {
      const skills = named(readCanonRole(role).overlay);
      for (const skill of ['publish-and-merge', 'git', 'scratch-and-probes']) assert.ok(skills.includes(skill), `${role} does not name ${skill}`);
    }
  });

  it('reaches the session as a pointer to the installed skill, not as its text', () => {
    const told = instructionsFor('claude-code', readCanonRole('build-session:project').overlay);
    assert.match(told, /Skill `mc-processes` \(/u);
    assert.doesNotMatch(told, /^@skill /mu);
    assert.doesNotMatch(told, phrase(DEFINING.processes));
  });
});
