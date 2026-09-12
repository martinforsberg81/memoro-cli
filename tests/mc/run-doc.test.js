/**
 * `docs/technical/mc-run.md` is the runner written down: it exists so somebody
 * who has never read run.js can say what a round does, what a step is, what
 * the two lanes share and what the runner writes. That only holds while the
 * numbers in it are the numbers in the code, and a doc that names a default
 * goes stale silently.
 *
 * So the doc is pinned, the same way `tests/mc/helper-doc.test.js` pins the
 * helper's note: every constant the prose states is read back out of it and
 * compared with the export it claims to describe.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { REPAIRS_BEFORE_BRIEF } from '../../src/mc/brief-collect.js';
import { parseRunArgs } from '../../src/mc/commands/run.js';
import { STEP_STATUSES } from '../../src/mc/plan-schema.js';
import { LANES_MAX, LANES_MIN } from '../../src/mc/lane-count.js';
import { REPO_NAMES, TOTAL_POLL_MS } from '../../src/mc/run.js';
import {
  AUTOCOMPACT_TOKENS, DEFAULT_CHECK_IN_MINUTES, DEFAULT_STALL_MINUTES, DEFAULT_TOOL, HELPER_HOUR_UTC, MC_OWN_TREES, QUOTA_SLEEP_MS,
  RUNS_HEADER, SESSION_DEFAULTS,
} from '../../src/mc/run-plan.js';

const DOC = readFileSync(fileURLToPath(new URL('../../docs/technical/mc-run.md', import.meta.url)), 'utf8');

describe('docs/technical/mc-run.md says what the runner does', () => {
  it('states the shared quota sleep the code sleeps', () => {
    const match = /every lane sleeping (\d+)m/u.exec(DOC);
    assert.ok(match, 'the doc no longer states the quota sleep');
    assert.equal(Number(match[1]) * 60_000, QUOTA_SLEEP_MS);
  });

  it('states the poll a lane held back by the total sleeps, and the bounds both numbers take', () => {
    const match = /polls every (\d+) s/u.exec(DOC);
    assert.ok(match, 'the doc no longer states the total-cap poll');
    assert.equal(Number(match[1]) * 1000, TOTAL_POLL_MS);
    assert.match(DOC, new RegExp(`${LANES_MIN} to ${LANES_MAX}`, 'u'), 'the doc no longer states the bounds on a lane count');
  });

  it('states the check-in and stall defaults, and no wall-clock budget', () => {
    const checkIn = /`check_in_minutes:`\*\* — (\d+) minutes by default/u.exec(DOC);
    const stall = /`stall_minutes:`\*\* — (\d+) minutes by default/u.exec(DOC);
    assert.ok(checkIn, 'the doc no longer states the check-in default');
    assert.ok(stall, 'the doc no longer states the stall default');
    assert.equal(Number(checkIn[1]), DEFAULT_CHECK_IN_MINUTES);
    assert.equal(Number(stall[1]), DEFAULT_STALL_MINUTES);
    assert.doesNotMatch(DOC, /budget_minutes/u, 'the key is gone from the schema (ruling 18)');
  });

  it('names the two repositories that are the two lanes', () => {
    assert.equal(REPO_NAMES.length, 2, 'a third repository needs a line in the doc too');
    for (const repo of REPO_NAMES) assert.ok(DOC.includes(repo), `the doc does not name ${repo}`);
  });

  it('names the files a lane writes, and the one the runner writes once', () => {
    assert.match(DOC, /`current-<repo>\.json`/u);
    assert.match(DOC, /`runner\.json`\*\* stays one/u);
    assert.match(DOC, /`~\/mc\/runner\/STOP`/u);
  });

  it('states the compaction window a claude session gets', () => {
    assert.ok(DOC.includes(`--autocompact ${AUTOCOMPACT_TOKENS}`), 'the argument list in the doc no longer shows the window');
    assert.ok(DOC.includes(`\`AUTOCOMPACT_TOKENS\` (${AUTOCOMPACT_TOKENS.toLocaleString('en-US').replace(/,/gu, ' ')})`));
  });

  it('states the tool, model, effort and advisor a session gets when its plan names none', () => {
    assert.match(DOC, new RegExp(`\\*\\*\`tool:\`\\*\\* — \`${DEFAULT_TOOL}\` by default`, 'u'));
    const { step, repair } = SESSION_DEFAULTS;
    assert.match(DOC, new RegExp(`\\*\\*\`model:\`\\*\\* — \`${step.model}\` by default for a step, \`${repair.model}\` for a repair`, 'u'));
    // The table under *The session*, one row per kind, as the code has them.
    const cell = (value) => (value ? `\`${value}\`` : 'none');
    for (const [kind, d] of Object.entries(SESSION_DEFAULTS)) {
      assert.ok(DOC.includes(`| ${kind} | ${cell(d.model)} | ${cell(d.effort)} | ${cell(d.advisor)} |`), `the doc's table has no row for ${kind} as the code sets it`);
    }
    assert.ok(DOC.includes('[--effort …] [--advisor …]'), 'the argument list no longer shows the two flags');
  });

  it('lists the runs.tsv columns in the order the row is written', () => {
    const columns = DOC.replace(/\s+/gu, ' ');
    assert.ok(columns.includes(RUNS_HEADER.join(' ')), 'the doc no longer lists the runs.tsv columns');
  });

  it('states the hour the day\'s helper becomes due', () => {
    assert.match(DOC, new RegExp(`after ${String(HELPER_HOUR_UTC).padStart(2, '0')}:00Z`, 'u'));
  });

  it('sends a reader looking for a supervisor to `mc run --update`, and to no script', () => {
    assert.doesNotMatch(DOC, /runner-loop/u, 'the shell supervisor is deleted — the doc must not send anyone to it');
    const beside = /## What runs beside it\n([\s\S]*?)\n## /u.exec(DOC);
    assert.ok(beside, 'the section a reader looks in for a supervisor is gone entirely');
    assert.match(beside[1], /`mc run --update`/u);
  });

  it('names the trees whose landing hands the runner over, and no others', () => {
    const merge = /### The merge\n([\s\S]*?)\n## /u.exec(DOC);
    assert.ok(merge, 'the section that describes the landing is gone');
    for (const tree of MC_OWN_TREES) assert.ok(merge[1].includes(`\`${tree}\``), `the doc does not name ${tree}`);
    // A widened list is the failure this pins: the next tree added to the code
    // has to be argued for in the prose too.
    assert.equal(MC_OWN_TREES.length, 2, 'a third tree needs its own paragraph here');
    assert.match(merge[1], /writes `runner\/UPDATE` itself/u);
  });

  it('warns a reader of runs.tsv about a trespass on a step that changed the rules', () => {
    assert.match(DOC, /`plan-trespass` on a step that changed the runner's\n  own rules is worth checking before it is believed/u);
  });

  it('says what a held pull request is, when its repair runs, and where it stops', () => {
    const held = /### Held before merge\n([\s\S]*?)\n## /u.exec(DOC);
    assert.ok(held, 'the section a reader looks in for a pull request the runner would not land is gone');
    assert.match(held[1], /`~\/mc\/runner\/held\.json`/u, 'the section no longer names the file');
    assert.match(held[1], /`repair` session/u, 'the section no longer names the kind a held pull request gets');
    // The one-repair rule is the contract's, and the brief is what takes the
    // second: a doc that says "one" while the code allows two is the drift
    // this pins.
    assert.equal(REPAIRS_BEFORE_BRIEF, 1, 'the doc says a held pull request gets one repair');
    assert.match(held[1], /`repairs >= 1` is a skip again/u);
    assert.match(held[1], /the brief's/u, 'the section no longer says where the repair stops');
    // And that it is mc's own state: a fourth step status would make the
    // paragraph that promises there is none wrong.
    assert.deepEqual([...STEP_STATUSES], ['ready', 'done', 'blocked']);
    assert.match(held[1], /never a status in a `PLAN\.json`/u);
  });

  it('states the flag defaults the command parses', () => {
    const defaults = parseRunArgs([]);
    assert.equal(defaults.once, false);
    assert.equal(defaults.merge, true);
    assert.equal(defaults.idleSleep, 600);
    assert.match(DOC, /takes the next step of the next project until STOP/u);
    assert.match(DOC, /600 s by default/u);
    assert.match(DOC, /`--no-merge`\s+leaves the pull requests open/u);
    // The flag is gone and the doc says so, in the same words the verb answers
    // it with (`RETIRED_ROUNDS`, commands/run.js).
    assert.match(DOC, /`--rounds <n>` was retired with the round/u);
    assert.match(parseRunArgs(['--rounds', '2']).error, /a round no longer exists/u);
  });
});
