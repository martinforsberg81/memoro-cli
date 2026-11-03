/**
 * Roles: the file format, the catalogue, the mark on an area, and what a
 * conversation is told.
 *
 * The parallel-operation guarantees live here as much as anywhere: an
 * ordinary area has no mark and gets no overlay, codex conversations get
 * exactly today's delivery even inside a role's area, and the reserved names
 * are a fixed, small set.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  RESERVED_ROLE_NAMES,
  SHARED_ROLE_FILE,
  areaRole,
  areaRoleName,
  canonRolesDir,
  expandRoleIncludes,
  instructionsFor,
  listRoles,
  markAreaRole,
  parseRole,
  readCanonRole,
  readRole,
  reservedRoleHint,
  reservedRoleName,
  isPassageFile,
  partNames,
  roleFileText,
  selectParts,
  sharedRoleText,
} from '../../src/mc/roles.js';
import { PLAN_ROLE, REVIEW_ROLE } from '../../src/mc/goals.js';
import { BUILD_ROLES } from '../../src/mc/run-plan.js';

/** Every way a session is started on a canon role, by the role name it runs. */
const STARTS = [PLAN_ROLE, BUILD_ROLES.goal, REVIEW_ROLE];
import { discardWorkArea, releaseWorkArea } from '../../src/mc/work-area.js';
import { canonSkillsDir } from '../../src/mc/skills.js';

const WORKER_MD = `---
name: worker
model: fable
singleton: false
tools: claude, codex
---
You are a worker. Escalate to the PM.`;

function catalogue(files = { 'worker.md': WORKER_MD }) {
  const dir = mkdtempSync(join(tmpdir(), 'mc-roles-'));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return { dir, env: { MC_ROLES_DIR: dir } };
}

describe('role files', () => {
  it('frontmatter for mc, overlay text for the conversation', () => {
    const role = parseRole(WORKER_MD);
    assert.equal(role.name, 'worker');
    assert.equal(role.model, 'fable');
    assert.equal(role.singleton, false);
    assert.deepEqual(role.tools, ['claude', 'codex']);
    assert.equal(role.overlay, 'You are a worker. Escalate to the PM.');
  });

  it('the filename names a role that does not name itself', () => {
    const role = parseRole('---\nmodel: opus\nsingleton: true\n---\nBody.', 'pm-helper');
    assert.equal(role.name, 'pm-helper');
    assert.equal(role.singleton, true);
    assert.deepEqual(role.tools, []);
  });

  it('no frontmatter is no role, not a role with defaults', () => {
    assert.equal(parseRole('just some markdown'), null);
    assert.equal(parseRole(''), null);
    assert.equal(parseRole(null), null);
  });

  it('cache is 5m only when the role says exactly that, an hour otherwise (ruling 40)', () => {
    assert.equal(parseRole('---\nname: a\ncache: 5m\n---\nBody.').cache, '5m');
    assert.equal(parseRole('---\nname: a\n---\nBody.').cache, '1h');
    assert.equal(parseRole('---\nname: a\ncache: 10m\n---\nBody.').cache, '1h');
    assert.equal(parseRole(WORKER_MD).cache, '1h');
  });

  it('the canon build role runs on 5m and plan on an hour', () => {
    assert.equal(readCanonRole(BUILD_ROLES.goal).cache, '5m');
    assert.equal(readCanonRole('plan-session').cache, '1h');
  });

  it('the canon review role parses, runs on opus and five minutes, and is the review\'s own words', () => {
    const role = readCanonRole(REVIEW_ROLE);
    assert.equal(role.name, REVIEW_ROLE);
    assert.equal(role.model, 'opus');
    assert.equal(role.singleton, false);
    assert.equal(role.cache, '5m');
    assert.match(role.overlay, /You review one goal: headless, nobody watching/u);
  });

  it('a CRLF checkout is still a role', () => {
    const role = parseRole(WORKER_MD.replace(/\n/gu, '\r\n'));
    assert.equal(role.name, 'worker');
    assert.equal(role.model, 'fable');
    assert.equal(role.overlay, 'You are a worker. Escalate to the PM.');
  });

  it('the catalogue lists what is defined and reads one whole', () => {
    const { dir, env } = catalogue();
    const roles = listRoles(env);
    assert.equal(roles.length, 1);
    assert.equal(roles[0].name, 'worker');
    assert.equal(roles[0].path, join(dir, 'worker.md'));
    const worker = readRole('worker', env);
    assert.equal(worker.overlay, 'You are a worker. Escalate to the PM.');
    assert.equal(readRole('pm', env), null);
  });

  it('a catalogue that does not exist is empty, not an error', () => {
    assert.deepEqual(listRoles({ MC_ROLES_DIR: '/nowhere/at/all' }), []);
  });
});

describe('the mark on an area', () => {
  it('is written once and read back, and a missing definition says so', () => {
    const { env } = catalogue();
    const area = mkdtempSync(join(tmpdir(), 'mc-area-'));
    assert.equal(areaRoleName(area), null);
    assert.equal(areaRole(area, env), null);
    markAreaRole(area, 'worker');
    assert.equal(areaRoleName(area), 'worker');
    assert.equal(areaRole(area, env).overlay, 'You are a worker. Escalate to the PM.');
    markAreaRole(area, 'vanished');
    const missing = areaRole(area, env);
    assert.equal(missing.missing, true);
    assert.equal(missing.name, 'vanished');
  });

  it('survives a release that keeps the area', () => {
    // Releasing an area with a stray user file keeps the area — and must
    // keep its role: an area silently demoted runs every future
    // conversation without the overlay and cannot even warn about it.
    const workRoot = mkdtempSync(join(tmpdir(), 'mc-workroot-'));
    const env = {
      ...process.env,
      MC_WORK_ROOT: workRoot,
      CLAUDE_CONFIG_DIR: join(workRoot, 'claude'),
      CODEX_HOME: join(workRoot, 'codex'),
    };
    const area = join(workRoot, 'w');
    mkdirSync(area);
    markAreaRole(area, 'worker');
    writeFileSync(join(area, 'notes.txt'), 'still mine');
    const survived = releaseWorkArea('w', { env, dryRun: false });
    assert.equal(survived.removed.length, 0);
    assert.equal(areaRoleName(area), 'worker');
    // And an area holding nothing but its own mark is releasable: the mark
    // must not keep an otherwise-empty area alive.
    const area2 = join(workRoot, 'w2');
    mkdirSync(area2);
    markAreaRole(area2, 'worker');
    releaseWorkArea('w2', { env, dryRun: false });
    assert.equal(areaRoleName(area2), null);
  });

  it('goes out with the area when the area is discarded', () => {
    const workRoot = mkdtempSync(join(tmpdir(), 'mc-workroot-'));
    const env = { ...process.env, MC_WORK_ROOT: workRoot };
    const area = join(workRoot, 'w');
    mkdirSync(area);
    markAreaRole(area, 'worker');
    const result = discardWorkArea('w', { env, dryRun: false });
    assert.equal(result.removes_area, true);
    assert.equal(areaRoleName(area), null);
  });
});

describe('what a conversation is told', () => {
  const SHARED = sharedRoleText();

  it('claude gets the shared text and then the overlay, and nothing in front', () => {
    assert.equal(instructionsFor('claude-code', 'OVERLAY'), `${SHARED}\n\n---\n\nOVERLAY`);
  });

  it('codex gets the same body, on its own instruction channel', () => {
    assert.equal(
      instructionsFor('codex', 'OVERLAY'),
      `${SHARED}\n\n---\n\nOVERLAY`,
    );
  });

  it('is one body of text, whichever tool is asked', () => {
    assert.equal(
      instructionsFor('codex', 'OVERLAY'),
      instructionsFor('claude-code', 'OVERLAY'),
    );
  });

  // The parallel-operation guarantee: an ordinary area has no role, and a
  // conversation there is told nothing mc added — no instructions at all.
  it('no overlay is no role, and no role is no instructions', () => {
    assert.equal(instructionsFor('claude-code', null), null);
    assert.equal(instructionsFor('codex', null), null);
  });
});

/**
 * The rules that hold for every role session, written once.
 *
 * The turn-cost rule was in six role files — four byte-identical copies and
 * two variants — which is six places for one rule to drift.
 */
describe('the text every role session shares', () => {
  const SHARED = sharedRoleText();
  const TURN_COST = /A turn is the unit of cost/u;

  it('is written in exactly one file in the catalogue mc ships', () => {
    assert.match(SHARED, TURN_COST);
    const carriers = readdirSync(canonRolesDir())
      .filter((file) => file.endsWith('.md'))
      .filter((file) => TURN_COST.test(readFileSync(join(canonRolesDir(), file), 'utf8')));
    assert.deepEqual(carriers, [SHARED_ROLE_FILE]);
  });

  it('reaches every canon role that has a body of its own', () => {
    for (const name of ['brief', 'helper', 'intake', ...STARTS]) {
      const role = readCanonRole(name);
      assert.ok(role?.overlay, `${name} has no overlay`);
      assert.match(instructionsFor('claude-code', role.overlay), TURN_COST, name);
    }
  });

  // 2026-10-10: a step session ran `kill` on the merger's test process,
  // taking it for its own hung test. The rule is the `processes` skill now,
  // and the build session is pointed at it.
  it('points a build session at the rule to know a process before signalling it', () => {
    const told = instructionsFor('claude-code', readCanonRole(BUILD_ROLES.goal).overlay);
    assert.match(told, /Skill `mc-processes`/u);
    assert.match(readFileSync(join(canonSkillsDir(), 'processes', 'SKILL.md'), 'utf8'), /know what it is before you signal it/u);
  });

  // A file named `all-sessions.md` in a catalogue directory is text, not a role:
  // `listRoles` would otherwise hand `mc roles list` a role named `all-sessions`.
  it('is not mistaken for a role, even sitting in the catalogue', () => {
    const { env } = catalogue({ 'worker.md': WORKER_MD, [SHARED_ROLE_FILE]: SHARED });
    assert.deepEqual(listRoles(env).map((role) => role.name), ['worker']);
  });

  // The runner's only test that a role file is installed at all is the role's
  // own body — folding the shared text in ahead of it would make a missing
  // role file look present.
  it('stays out of a role\'s own overlay', () => {
    assert.doesNotMatch(readCanonRole(BUILD_ROLES.goal).overlay, TURN_COST);
  });
});

/**
 * The verb files, each written once (Martin, 2026-11-03: a role says what the
 * session is for, a verb file how the verb is used).
 *
 * `all-sessions.md` is the text *every* role session is told; how `mc goal` is
 * used is not that. The plan session and the brief write goals and a build
 * session does not, and telling a build session how to write a goal it may
 * never write is worse than telling it nothing. So each verb is its own file,
 * and a role names it on a line of its own.
 */
describe('the verb files', () => {
  const VERBS = ['goal-verb.md'];
  // Sentences that define each file, from different parts of it.
  const DEFINING = {
    'goal-verb.md': [/a plan session finishes it to `merging`/u, /\*\*Written by verbs\.\*\*/u],
  };
  const read = (file) => readFileSync(join(canonRolesDir(), file), 'utf8');

  it('each sentence is written in exactly one file, and no role file holds a copy', () => {
    const carriers = (sentence) => readdirSync(canonRolesDir())
      .filter((file) => file.endsWith('.md'))
      .filter((file) => sentence.test(read(file)));
    for (const [file, sentences] of Object.entries(DEFINING)) {
      for (const sentence of sentences) assert.deepEqual(carriers(sentence), [file], `${sentence} is not in exactly ${file}`);
    }
    for (const file of ['plan-session.md', 'brief.md']) {
      assert.match(read(file), /^@include goal-verb\.md$/mu, `${file} does not include goal-verb.md`);
    }
  });

  // It is not a role, for the same reason `all-sessions.md` is not.
  it('is text and not a role, even sitting in a catalogue', () => {
    for (const file of VERBS) {
      assert.equal(parseRole(read(file)), null, file);
      assert.equal(isPassageFile(file), true, file);
    }
    const { env } = catalogue({ 'worker.md': WORKER_MD, 'goal-verb.md': read('goal-verb.md') });
    assert.deepEqual(listRoles(env).map((role) => role.name), ['worker']);
  });

  // Expanded at the one door, and not before it: `run.js` and `mc roles show`
  // read `overlay` as the role's own words.
  it('reaches a session through instructionsFor, and the marker does not', () => {
    for (const name of ['plan-session', 'brief']) {
      const { overlay } = readCanonRole(name);
      assert.match(overlay, /@include/u, `${name} should carry the marker in its own words`);
      const told = instructionsFor('claude-code', overlay);
      assert.doesNotMatch(told, /@include/u, `${name} was told an unexpanded marker`);
      for (const sentence of DEFINING['goal-verb.md']) assert.match(told, sentence, name);
    }
  });

  it('leaves a marker nobody can resolve standing, rather than dropping the rule', () => {
    assert.equal(expandRoleIncludes('a\n@include nothing-verb.md\nb'), 'a\n@include nothing-verb.md\nb');
    // Only a verb file, so a role cannot include a role.
    assert.equal(expandRoleIncludes('@include build-session.md'), '@include build-session.md');
    // A line of its own, not a mention inside a sentence.
    assert.equal(expandRoleIncludes('see @include goal-verb.md there'), 'see @include goal-verb.md there');
  });
});

/**
 * The guard that stops a role shipping with nothing to say.
 *
 * `canon/roles/plan.md` was six lines of frontmatter and no body for months:
 * an `mc plan <programme>` session was told its model and the shared text,
 * and nothing about planning. Nothing failed, because nothing looked. This
 * looks — at every role, and at every part a start of it runs.
 */
describe('every canon role has a body', () => {
  const files = readdirSync(canonRolesDir()).filter((file) => file.endsWith('.md')).sort();
  const roleFiles = files.filter((file) => !isPassageFile(file));

  it('and the files that are not roles are the shared text and the verb files', () => {
    const passages = files.filter((file) => isPassageFile(file));
    assert.deepEqual(passages, [SHARED_ROLE_FILE, 'goal-verb.md']);
    for (const file of passages) assert.equal(parseRole(readFileSync(join(canonRolesDir(), file), 'utf8')), null);
  });

  for (const file of roleFiles) {
    const name = file.replace(/\.md$/u, '');
    const { parts } = readCanonRole(name);
    for (const ref of parts.length ? parts.map((part) => `${name}:${part}`) : [name]) {
      it(`${ref} parses to a role with overlay text of its own`, () => {
        const role = readCanonRole(ref);
        assert.ok(role, `${ref} does not parse as a role`);
        assert.equal(typeof role.overlay, 'string', `${ref} has no overlay body`);
        assert.ok(role.overlay.trim().length > 0, `${ref} has an empty overlay body`);
        assert.doesNotMatch(instructionsFor('claude-code', role.overlay), /^@(part|end|include)\b/mu, ref);
      });
    }
  }
});

describe('reserved names', () => {
  // One name, and it points at its own door. `pm` and `pm-helper` were
  // reserved beside it for a pair of roles that no longer exist; they are
  // ordinary names again, and `mc work pm` makes an ordinary workarea.
  it('is the fixed set, each pointing at its own door', () => {
    assert.deepEqual([...RESERVED_ROLE_NAMES], ['helper']);
    for (const name of RESERVED_ROLE_NAMES) assert.equal(reservedRoleName(name), true);
    assert.equal(reservedRoleName('worker-1'), false);
    assert.equal(reservedRoleName('pm'), false);
    assert.equal(reservedRoleName('pm-helper'), false);
    // The bare verb owns `~/mc/helper/`, so that is the command to name.
    assert.match(reservedRoleHint('helper'), /mc helper\)/u);
  });

  it('guards case-insensitively — the filesystems mostly are', () => {
    for (const name of ['Helper', 'HELPER']) {
      assert.equal(reservedRoleName(name), true, name);
    }
    assert.match(reservedRoleHint('HELPER'), /mc helper\)/u);
  });
});

describe('the role catalogue', () => {
  // A role that goes is removed on purpose, and one that arrives is added on
  // purpose: `repair.md` went with ruling 21; `mend.md` with the goal
  // `headless-plan` (2026-11-02); plan, build and review became one file each,
  // and the passages verb files, with `plan-session-roles` (2026-11-03).
  it('is exactly the roles and verb files mc ships', () => {
    assert.deepEqual(readdirSync(canonRolesDir()).sort(), [
      'all-sessions.md', 'brief.md', 'build-session.md', 'goal-verb.md', 'helper.md', 'intake.md', 'plan-session.md', 'review-session.md',
    ]);
  });
});

/**
 * Parts: one role file, started more than one way, and each start told its
 * own part and the shared words, never another start's.
 */
describe('a role\'s parts', () => {
  const BODY = 'shared\n@part a\nonly a\n@end\n@part a b\na and b\n@end\n@part b\nonly b\n@end\ntail';

  it('keeps the shared words and every part that names the start, in file order', () => {
    assert.equal(selectParts(BODY, ['a']), 'shared\nonly a\na and b\ntail');
    assert.equal(selectParts(BODY, ['b']), 'shared\na and b\nonly b\ntail');
    assert.equal(selectParts(BODY, []), 'shared\ntail');
    assert.deepEqual(partNames(BODY), ['a', 'b']);
  });

  it('names the role <file>:<part>, and a part the file does not have is no role', () => {
    const text = `---\nname: thing\n---\n${BODY}`;
    assert.equal(parseRole(text, null, 'a').name, 'thing:a');
    assert.equal(parseRole(text, null, 'c'), null);
    assert.equal(parseRole(text).overlay, 'shared\ntail');
    assert.equal(readCanonRole('build-session:nothing'), null);
    assert.equal(readCanonRole('plan-session:goal'), null);
  });

  it('an area still marked worker carries no canon role: mc worker and its part are gone', () => {
    const area = mkdtempSync(join(tmpdir(), 'mc-area-'));
    markAreaRole(area, 'worker');
    const role = areaRole(area, { MC_ROLES_DIR: '/nowhere/at/all' });
    assert.equal(role.missing, true);
    assert.equal(readCanonRole('build-session:worker'), null);
    assert.equal(readCanonRole('build-session:project'), null);
    assert.equal(roleFileText(BUILD_ROLES.goal), 'canon/roles/build-session.md (part goal)');
  });
});

/**
 * One build role, started three ways: a goal, a project's step, a worker. What
 * is true of every headless build is written once, in a part both the goal and
 * the project start run; the worker, at a person's terminal, is not told it.
 */
describe('the build role', () => {
  const ONE_BRANCH = /One branch, built to the end/u;
  const WHEN_ENDS = /When the session ends/u;
  const OWN = {
    'build-session:goal': /You are a build session on one goal/u,
  };
  const told = (ref) => instructionsFor('claude-code', readCanonRole(ref).overlay);

  it('each start is told its own part and no other start\'s', () => {
    for (const [ref, own] of Object.entries(OWN)) {
      assert.match(told(ref), own, ref);
      for (const [other, words] of Object.entries(OWN)) if (other !== ref) assert.doesNotMatch(told(ref), words, `${ref} told ${other}'s part`);
    }
  });

  it('a headless build is told what every build shares', () => {
    for (const ref of [BUILD_ROLES.goal]) {
      assert.match(told(ref), ONE_BRANCH, ref);
      assert.match(told(ref), WHEN_ENDS, ref);
      assert.match(told(ref), /a finished part that reads well as a first pass is not a\s+reason to stop/u, ref);
    }
  });

  it('write what every build shares once', () => {
    const carriers = readdirSync(canonRolesDir()).filter((file) => file.endsWith('.md'))
      .filter((file) => ONE_BRANCH.test(readFileSync(join(canonRolesDir(), file), 'utf8')));
    assert.deepEqual(carriers, ['build-session.md']);
  });

  it('tell no session to merge origin/main except for a conflict the merger reported', () => {
    for (const ref of Object.keys(OWN)) {
      const text = told(ref);
      assert.doesNotMatch(text, /Bring it to\s+`origin\/main`/u, ref);
      assert.doesNotMatch(text, /git fetch origin && git merge origin\/main/u, ref);
      const merges = text.split(/\n\s*\n/u).filter((paragraph) => /merge\s+`?origin\/main`?|merging\s+`origin\/main`/u.test(paragraph) && !/never\s+`git fetch`/u.test(paragraph));
      for (const paragraph of merges) assert.match(paragraph, /merger/u, `${ref}: ${paragraph}`);
    }
  });
});

describe('the review role', () => {
  it('a goal review is told its own part, and has no project part left', () => {
    const goal = instructionsFor('claude-code', readCanonRole(REVIEW_ROLE).overlay);
    assert.match(goal, /You review one goal/u);
    assert.equal(readCanonRole('review-session:project'), null);
    // The goal review never builds.
    assert.doesNotMatch(goal, /Skill `mc-writing-tests`/u);
  });
});
