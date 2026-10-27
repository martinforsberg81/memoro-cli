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

import { parseRunArgs } from '../../src/mc/commands/run.js';
import { CLAUDE_MODELS, CODEX_MODELS, STEP_STATUSES } from '../../src/mc/plan-schema.js';
import { LANES_MAX, LANES_MIN } from '../../src/mc/lane-count.js';
import { REPO_NAMES, TOTAL_POLL_MS } from '../../src/mc/run.js';
import {
  AUTOCOMPACT_TOKENS, DEFAULT_CHECK_IN_MINUTES, DEFAULT_STALL_MINUTES, DEFAULT_TOOL, HELPER_HOUR_UTC, QUOTA_SLEEP_MS,
  RUNS_HEADER, SESSION_DEFAULTS,
} from '../../src/mc/run-plan.js';

const DOC = readFileSync(fileURLToPath(new URL('../../docs/technical/mc-run.md', import.meta.url)), 'utf8');

describe('docs/technical/mc-run.md says what the runner does', () => {
  it('states the shared quota sleep the code sleeps', () => {
    const match = /every lane sleeping (\d+)m/u.exec(DOC);
    assert.ok(match, 'the doc no longer states the quota sleep');
    assert.equal(Number(match[1]) * 60_000, QUOTA_SLEEP_MS);
  });

  it('says auto is plan only, so no mode but credits moves a session to the credit', () => {
    assert.match(DOC, /\*\*`auto`\*\* — plan only/u, 'the doc no longer says auto is plan only');
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
    const { step } = SESSION_DEFAULTS;
    assert.match(DOC, new RegExp(`\\*\\*\`model:\`\\*\\* — \`${step.model}\` by default for a step`, 'u'));
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

  it('says the runner orders its own handover only on a clean checkout that fast-forwards', () => {
    assert.match(DOC, /writes `runner\/UPDATE` itself/u);
    assert.match(DOC, /that checkout is clean and fast-forwards/u);
    assert.match(DOC, /once per origin\/main sha/u);
    assert.doesNotMatch(DOC, /`UPDATE` has no other writer/u);
  });

  it('says where a step that did not land stands — the register, not a held file — and keeps the argument list current', () => {
    const register = /### The register\n([\s\S]*?)\n## /u.exec(DOC);
    assert.ok(register, 'the section a reader looks in for where state lives is gone');
    assert.match(register[1], /`~\/mc\/runner\/projects\//u);
    assert.match(register[1], /`failed`/u);
    assert.match(register[1], /`mc step ready`/u);
    assert.deepEqual([...STEP_STATUSES], ['ready', 'running', 'landing', 'done', 'failed', 'blocked', 'built']);
    assert.ok(DOC.includes(`--autocompact ${AUTOCOMPACT_TOKENS}`), 'the argument list in the doc no longer shows the window');
    assert.ok(DOC.includes(`\`AUTOCOMPACT_TOKENS\` (${AUTOCOMPACT_TOKENS.toLocaleString('en-US').replace(/,/gu, ' ')})`));
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

  it('names the four step models on the tool that runs them, and the codex flag and effort override the runner passes', () => {
    const text = DOC.replace(/\s+/gu, ' ');
    const onTool = (models, tool) => `${models.map((model) => `\`${model}\``).join(' and ')} on ${tool}`;
    assert.ok(text.includes(onTool(CLAUDE_MODELS, 'claude')), 'the doc no longer pairs haiku and opus with claude');
    assert.ok(text.includes(onTool(CODEX_MODELS, 'codex')), 'the doc no longer pairs the Codex names with codex');
    assert.ok(text.includes('`codex exec -m <name>`'), 'the doc no longer says the Codex name goes to codex exec -m');
    assert.ok(text.includes('`-c model_reasoning_effort=<level>`'), 'the doc no longer says effort reaches codex as model_reasoning_effort');
    assert.match(DOC, /\[-m …\] \[-c model_reasoning_effort=…\]/u, 'the codex argument list no longer shows the effort override');
    assert.doesNotMatch(text, /Effort and advisor are claude's flags/u, 'the doc still calls effort claude-only');
  });
});
