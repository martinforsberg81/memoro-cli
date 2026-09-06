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
  sharedRoleText,
} from '../../src/mc/roles.js';
import { discardWorkArea, releaseWorkArea } from '../../src/mc/work-area.js';

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

  it('claude gets the shared text and then the overlay, behind the profile', () => {
    assert.equal(
      instructionsFor('claude-code', 'PROFILE', 'OVERLAY'),
      `PROFILE\n\n---\n\n${SHARED}\n\n---\n\nOVERLAY`,
    );
    assert.equal(instructionsFor('claude-code', null, 'OVERLAY'), `${SHARED}\n\n---\n\nOVERLAY`);
  });

  it('codex gets the same body, on its own instruction channel', () => {
    assert.equal(
      instructionsFor('codex', 'PROFILE', 'OVERLAY'),
      `PROFILE\n\n---\n\n${SHARED}\n\n---\n\nOVERLAY`,
    );
  });

  it('is one body of text, whichever tool is asked', () => {
    assert.equal(
      instructionsFor('codex', 'PROFILE', 'OVERLAY'),
      instructionsFor('claude-code', 'PROFILE', 'OVERLAY'),
    );
  });

  // The parallel-operation guarantee: an ordinary area has no role, and a
  // conversation there is told the profile and nothing mc added.
  it('no overlay is no role, and no role is no shared text', () => {
    assert.equal(instructionsFor('claude-code', 'PROFILE', null), 'PROFILE');
    assert.equal(instructionsFor('codex', 'PROFILE', null), 'PROFILE');
  });

  it('nothing to say is nothing, for both', () => {
    assert.equal(instructionsFor('claude-code', null, null), null);
    assert.equal(instructionsFor('codex', null, null), null);
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
    for (const name of ['brief', 'helper', 'intake', 'repair', 'step', 'worker']) {
      const role = readCanonRole(name);
      assert.ok(role?.overlay, `${name} has no overlay`);
      assert.match(instructionsFor('claude-code', 'PROFILE', role.overlay), TURN_COST, name);
    }
  });

  // A file named `_common.md` in a catalogue directory is text, not a role:
  // `listRoles` would otherwise hand `mc roles list` a role named `_common`.
  it('is not mistaken for a role, even sitting in the catalogue', () => {
    const { env } = catalogue({ 'worker.md': WORKER_MD, [SHARED_ROLE_FILE]: SHARED });
    assert.deepEqual(listRoles(env).map((role) => role.name), ['worker']);
  });

  // The runner's only test that a role file is installed at all is the role's
  // own body — folding the shared text in ahead of it would make a missing
  // `repair.md` look present.
  it('stays out of a role\'s own overlay', () => {
    assert.doesNotMatch(readCanonRole('step').overlay, TURN_COST);
  });
});

/**
 * A passage two roles share, written once.
 *
 * `_common.md` is the text *every* role session is told, and the rules for
 * writing a `PLAN.json` are not that: the planning session and the brief write
 * plans, the other six do not, and telling a `step` session how to write a plan
 * it may never write is worse than telling it nothing. So the passage is its
 * own file, and each of the two names it on a line of its own.
 */
describe('a passage two roles share', () => {
  const PLAN_WRITING = '_plan-writing.md';
  // Three sentences that define it — one from each half of the passage.
  const DEFINING = [
    /A plan is instructions for a headless session that has read nothing else/u,
    /`readPlanText` prints every\nproblem at once/u,
    /A proposal that becomes a project is deleted in the same commit/u,
  ];
  const read = (file) => readFileSync(join(canonRolesDir(), file), 'utf8');

  it('is written in exactly one file, and neither role file holds a copy', () => {
    for (const sentence of DEFINING) {
      const carriers = readdirSync(canonRolesDir())
        .filter((file) => file.endsWith('.md'))
        .filter((file) => sentence.test(read(file)));
      assert.deepEqual(carriers, [PLAN_WRITING], `${sentence} is not in exactly ${PLAN_WRITING}`);
    }
    for (const file of ['plan.md', 'brief.md']) {
      assert.match(read(file), /^@include _plan-writing\.md$/mu, `${file} does not include the passage`);
    }
  });

  // It is not a role, for the same reason `_common.md` is not: `listRoles`
  // makes a role out of every `*.md` without a leading underscore.
  it('is text and not a role, even sitting in a catalogue', () => {
    assert.equal(parseRole(read(PLAN_WRITING)), null);
    const { env } = catalogue({ 'worker.md': WORKER_MD, [PLAN_WRITING]: read(PLAN_WRITING) });
    assert.deepEqual(listRoles(env).map((role) => role.name), ['worker']);
  });

  // Expanded at the one door, and not before it: `run.js` and `mc roles show`
  // read `overlay` as the role's own words.
  it('reaches a session through instructionsFor, and the marker does not', () => {
    for (const name of ['plan', 'brief']) {
      const { overlay } = readCanonRole(name);
      assert.match(overlay, /@include/u, `${name} should carry the marker in its own words`);
      const told = instructionsFor('claude-code', 'PROFILE', overlay);
      assert.doesNotMatch(told, /@include/u, `${name} was told an unexpanded marker`);
      assert.match(told, DEFINING[0], name);
    }
  });

  it('leaves a marker nobody can resolve standing, rather than dropping the rule', () => {
    assert.equal(expandRoleIncludes('a\n@include _nothing-here.md\nb'), 'a\n@include _nothing-here.md\nb');
    // Only an underscored name, so a role cannot include a role.
    assert.equal(expandRoleIncludes('@include step.md'), '@include step.md');
    // A line of its own, not a mention inside a sentence.
    assert.equal(expandRoleIncludes('see @include _plan-writing.md there'), 'see @include _plan-writing.md there');
  });
});

/**
 * The guard that stops a role shipping with nothing to say.
 *
 * `canon/roles/plan.md` was six lines of frontmatter and no body for months:
 * an `mc plan <programme>` session was told its model and `_common.md`, and
 * nothing about planning. Nothing failed, because nothing looked. This looks.
 *
 * A leading underscore is the convention that says "text, not a role" —
 * `_common.md` and the passages roles include — and it is the same filter
 * `listRoles` applies, so the two cannot drift apart.
 */
describe('every canon role has a body', () => {
  const files = readdirSync(canonRolesDir()).filter((file) => file.endsWith('.md')).sort();
  const roleFiles = files.filter((file) => !file.startsWith('_'));

  it('and the files that are not roles are exactly the underscored ones', () => {
    const shared = files.filter((file) => file.startsWith('_'));
    assert.ok(shared.includes(SHARED_ROLE_FILE), `${SHARED_ROLE_FILE} is missing from canon/roles/`);
    for (const file of shared) assert.equal(parseRole(readFileSync(join(canonRolesDir(), file), 'utf8')), null);
    assert.ok(roleFiles.length >= 7, `only ${roleFiles.length} canon roles`);
  });

  for (const file of roleFiles) {
    it(`${file} parses to a role with overlay text of its own`, () => {
      const role = readCanonRole(file.replace(/\.md$/u, ''));
      assert.ok(role, `${file} does not parse as a role`);
      assert.equal(typeof role.overlay, 'string', `${file} has no overlay body`);
      assert.ok(role.overlay.trim().length > 0, `${file} has an empty overlay body`);
    });
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
