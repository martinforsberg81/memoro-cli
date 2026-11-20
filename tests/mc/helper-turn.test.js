/**
 * `mc helper` — the turn: what it is told, what it is allowed to write, and
 * what it reports having written.
 *
 * No model and no network here. The session is a stub that writes a file
 * exactly where a real turn would, because the point of the measurement is
 * that `wrote` comes from the directory and not from what the turn said.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { proposalSystem } from '../../src/mc/brief-collect.js';
import { intakeArchiveDir, intakeDir } from '../../src/mc/helper-collect.js';
import { areaProposalsArchiveDir, areaProposalsDir, listAllProposals } from '../../src/mc/area-proposals.js';
import { collectProposalCounts, listingText as proposalsListing } from '../../src/mc/commands/proposals.js';
import {
  PROMPT_LIMIT_BYTES, describeTurn, drainIntake, helperGround, helperPrompt, programmeRoutes, repoOfFile, runHelperTurn,
} from '../../src/mc/helper-turn.js';
import { expandRoleIncludes, sharedRoleText } from '../../src/mc/roles.js';
import { getAdapter } from '../../src/adapters/index.js';
import { applyObservation, normaliseCapacity, writeCapacity } from '../../src/mc/model-capacity.js';
import { changeProviderPriority } from '../../src/mc/model-config.js';
import { writeBillingApi } from '../../src/mc/billing.js';
import { runnerDir } from '../../src/mc/paths.js';

const NOW = new Date('2026-08-29T06:00:00.000Z');
const FILE = 'errors-memoro-2026-08-29.md';
const ROLE = { name: 'helper', model: 'sonnet', tools: ['claude'], overlay: 'You are the helper turn.' };
const LAUNCH = {
  ok: true, id: 'claude-code', shortName: 'claude',
  adapter: { modelArgs: (model) => (model ? ['--model', model] : []) },
  spec: { bin: '/usr/bin/claude' },
};
const CLAUDE_JSON = JSON.stringify({ num_turns: 6, session_id: 'sess-1', subtype: 'success', usage: {} });

const PROPOSAL = `---
name: expose-operations
repo: memoro
kind: project
---

# The nightly outcomes reach no script

## Done when

The outcomes are a section in the digest.
`;

function env() {
  const root = mkdtempSync(join(tmpdir(), 'mc-turn-'));
  return { MC_WORK_ROOT: root, MC_REPOS_HOME: join(root, 'repos') };
}

/** The area the stub turn writes in: memoro's delivery page, where a finding about memoro with no clearer area goes. */
const DELIVERY = (e) => areaProposalsDir('memoro', 'delivery', e);

/** A session that writes what a real turn writes, and reports how it was called. */
function fakeSession(seen, { write = PROPOSAL, status = 0, timedOut = false, stdout = CLAUDE_JSON } = {}) {
  return async (call) => {
    Object.assign(seen, call);
    // The turn stands in `intake/` and writes into an area's `proposals/`
    // under `../areas/` — not inside the material it reads.
    const dir = join(call.cwd, '..', 'areas', 'memoro', 'delivery', 'proposals');
    if (write) { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, '2026-08-29-expose-operations.md'), write); }
    return { status, stdout, stderr: '', timedOut };
  };
}

const GROUND = async () => ({ goals: [], projectLog: null, notes: ['no docs/project/project_log.md on origin/main in memoro'] });

async function turn(overrides = {}, options = {}) {
  const e = options.env || env();
  const seen = {};
  const result = await runHelperTurn({
    env: e, now: NOW, file: options.file || join(intakeDir(e), FILE),
    tool: options.tool || null,
    deps: {
      role: () => ROLE, launch: () => LAUNCH,
      ground: GROUND, session: fakeSession(seen, options.session), ...overrides,
    },
  });
  return { result, seen, env: e };
}

describe('intake activity visibility', () => {
  it('registers a helper during the session and removes it on success or throw', async () => {
    for (const fails of [false, true]) {
      const e = env();
      const record = join(e.MC_WORK_ROOT, 'runner', 'foreground', `${process.pid}.json`);
      const exitListeners = process.listenerCount('exit');
      try {
        const pending = turn({ session: async () => {
          const active = JSON.parse(readFileSync(record, 'utf8'));
          assert.deepEqual([active.verb, active.tool, active.model], ['helper', 'claude', 'sonnet']);
          if (fails) throw new Error('session failed');
          return { status: 0, stdout: CLAUDE_JSON, stderr: '' };
        } }, { env: e, tool: 'claude' });
        if (fails) await assert.rejects(pending, /session failed/u);
        else await pending;
        assert.throws(() => readFileSync(record), { code: 'ENOENT' });
        assert.equal(process.listenerCount('exit'), exitListeners);
      } finally { rmSync(e.MC_WORK_ROOT, { recursive: true, force: true }); }
    }
  });
});

describe('the helper turn', () => {
  it('uses the saved Codex priority with the intake candidate and supported effort', async () => {
    let capacity = applyObservation(normaliseCapacity(null), 'claude', {
      windows: { five_hour: { fraction_used: 0.9, resets_at: '2026-08-29T13:00:00Z' }, seven_day: { fraction_used: 0.9, resets_at: '2026-09-05T12:00:00Z' } },
    }, NOW);
    capacity = applyObservation(capacity, 'codex', {
      windows: { primary: { fraction_used: 0.1, resets_at: '2026-08-29T13:00:00Z' } },
      models: [{ id: 'gpt-6-luna', efforts: ['high'] }],
    }, NOW);
    let seen;
    let priority = 'codex';
    const overrides = {
      catalog: () => ({ providerPriority: priority, fast: [{ tool: 'codex', model: 'gpt-6-luna', effort: 'high' }] }),
      capacity: () => capacity,
      launch: (tool) => ({ ...LAUNCH, id: tool === 'codex' ? 'codex' : 'claude-code', shortName: tool, adapter: getAdapter(tool === 'codex' ? 'codex' : 'claude-code') }),
      session: async (call) => { seen = call; return { status: 0, stdout: CLAUDE_JSON, stderr: '' }; },
    };
    const { result } = await turn(overrides);
    assert.equal(result.tool, 'codex');
    assert.equal(result.model, 'gpt-6-luna');
    assert.equal(result.providerPriority, 'codex');
    assert.match(result.routeWhy, /codex provider priority/u);
    assert.ok(seen.args.includes('model_reasoning_effort=high'));
    priority = 'claude';
    const next = await turn(overrides);
    assert.deepEqual([next.result.tool, next.result.model, next.result.providerPriority], ['claude', 'sonnet', 'claude']);
  });

  it('keeps an explicit intake tool ahead of saved priority', async () => {
    const capacity = applyObservation(normaliseCapacity(null), 'codex', {
      windows: { primary: { fraction_used: 0.1, resets_at: '2026-08-29T13:00:00Z' } },
      models: [{ id: 'gpt-6-luna', efforts: ['high'] }],
    }, NOW);
    const { result } = await turn({ catalog: () => ({ providerPriority: 'codex', fast: [{ tool: 'codex', model: 'gpt-6-luna', effort: 'high' }] }), capacity: () => capacity }, { tool: 'claude' });
    assert.equal(result.tool, 'claude');
    assert.equal(result.model, 'sonnet');
  });

  it('does not inherit its caller’s goal or step identity', async () => {
    const { seen } = await turn({}, { env: { ...env(), MC_ROLE: 'goal', MC_PROGRAMME: 'wrong', MC_GOAL: 'wrong/g', MC_STEP: 'p:0', MC_PROJECT: 'p' } });
    assert.equal(seen.env.MC_ROLE, 'intake');
    assert.equal(seen.env.MC_HEADLESS, '1');
    for (const key of ['MC_PROGRAMME', 'MC_GOAL', 'MC_STEP', 'MC_PROJECT']) assert.equal(seen.env[key], undefined);
  });

  it('runs the role\'s tool and model, standing in the intake directory', async () => {
    const { result, seen, env: e } = await turn();
    assert.equal(seen.bin, '/usr/bin/claude');
    assert.equal(seen.env.MC_ROLE, 'intake');
    assert.equal(seen.env.MC_PROGRAMME, undefined);
    assert.equal(seen.cwd, intakeDir(e), 'nothing outside ~/mc/intake is in reach');
    assert.equal(seen.timeoutMs, 10 * 60_000);
    assert.deepEqual(seen.args.slice(0, 2), ['-p', seen.args[1]]);
    assert.ok(seen.args.includes('--model') && seen.args[seen.args.indexOf('--model') + 1] === 'sonnet');
    assert.equal(result.model, 'sonnet');
    assert.equal(result.tool, 'claude');
    assert.equal(result.note, 'success');
    assert.equal(result.ok, true);
  });

  // Assembled by `instructionsFor` like every other launch: the text every
  // role session shares, then this role's own body, and nothing before them.
  it('carries the shared text and the role overlay in one instruction body', async () => {
    const { seen } = await turn();
    const at = seen.args.indexOf('--append-system-prompt');
    assert.ok(at > 0, 'claude takes instructions on --append-system-prompt');
    assert.equal(seen.args[at + 1], `${expandRoleIncludes(sharedRoleText())}\n\n---\n\nYou are the helper turn.`);
  });

  it('names the one file and leaves the reading to the turn', async () => {
    const { seen, env: e } = await turn();
    assert.ok(seen.args[1].includes(FILE), 'the file is named');
    assert.ok(!seen.args[1].includes(intakeDir(e)), 'by its bare name — the turn stands in the directory');
    assert.ok(!seen.args[1].includes('----- DIGEST -----'), 'nothing is pasted in for it');
  });

  it('takes a file whose name says nothing, and a name that is not a path', async () => {
    const dropped = await turn({}, { file: 'screenshot.png', session: { write: null } });
    assert.ok(dropped.seen.args[1].includes('screenshot.png'));
    assert.match(dropped.seen.args[1], /decide it from what you read/u);
    assert.equal(dropped.result.ok, true);
  });

  it('measures what was written instead of believing the turn', async () => {
    const { result } = await turn();
    assert.equal(result.wrote.length, 1);
    assert.equal(result.wrote[0].file, '2026-08-29-expose-operations.md');
    // The name is all mc knows about it. What it says is the reader's business.
    assert.equal(result.waiting.length, 1);

    const said = await turn({}, { session: { write: null } });
    assert.equal(said.result.wrote.length, 0, 'a turn that wrote nothing wrote nothing');
    assert.equal(said.result.ok, true, 'and that is not a failure');
  });

  it('counts only what this turn added, not what was already waiting', async () => {
    const e = env();
    mkdirSync(DELIVERY(e), { recursive: true });
    writeFileSync(join(DELIVERY(e), '2026-08-28-older.md'), '# An older proposal\n');
    const { result } = await turn({}, { env: e, session: { write: PROPOSAL } });
    assert.deepEqual(result.wrote.map((p) => [p.area, p.file]), [['memoro/delivery', '2026-08-29-expose-operations.md']]);
    assert.deepEqual(result.waiting.map((p) => p.file), ['2026-08-28-older.md', '2026-08-29-expose-operations.md']);
    assert.ok(result.wrote[0].path.startsWith(DELIVERY(e)));
  });

  it('names the directory it may write in, which is this machine\'s and not the default', async () => {
    const e = env();
    const { seen } = await turn({}, { env: e });
    assert.ok(seen.args[1].includes(`\`${join(e.MC_WORK_ROOT, 'areas')}/<repo>/<area>/proposals/\``), 'the turn is told where it may write');
  });

  it('tells the turn what is already proposed, so it does not propose it twice', async () => {
    const e = env();
    mkdirSync(DELIVERY(e), { recursive: true });
    writeFileSync(join(DELIVERY(e), '2026-08-28-older.md'), '# An older proposal\n');
    const { seen } = await turn({}, { env: e });
    assert.match(seen.args[1], /PROPOSALS ALREADY WAITING[\s\S]*2026-08-28-older\.md/u);
  });

  it('reports a missing role and a missing tool rather than running nothing', async () => {
    const noRole = await turn({ role: () => null });
    assert.deepEqual([noRole.result.ok, noRole.result.reason], [false, 'no-role']);
    const noTool = await turn({ launch: () => ({ ok: false, hint: 'claude not in PATH' }) });
    assert.deepEqual([noTool.result.ok, noTool.result.reason], [false, 'no-tool']);
    assert.equal(noTool.result.note, 'claude not in PATH');
  });

  it('is not ok when the session timed out or failed', async () => {
    const timedOut = await turn({}, { session: { status: 142, timedOut: true, write: null } });
    assert.equal(timedOut.result.ok, false);
    assert.equal(timedOut.result.note, 'timeout');
    const failed = await turn({}, { session: { status: 1, stdout: 'not json', write: null } });
    assert.equal(failed.result.ok, false);
    assert.equal(failed.result.note, 'no-json');
  });

  it('on agy a finished session is a SUCCESS result: a failed result or an empty stdout at exit 0 is not ok, and json output is priced for the model launched', async () => {
    const agy = { ok: true, id: 'antigravity-cli', shortName: 'agy', adapter: getAdapter('antigravity-cli'), spec: { bin: '/usr/bin/agy' } };
    const result = (status, extra = {}) => JSON.stringify({ conversation_id: 'c1', status, response: 'done', num_turns: 2, usage: { input_tokens: 10415, output_tokens: 657, cache_read_tokens: 8113 }, ...extra });
    const run = (stdout) => runHelperTurn({ env: env(), now: NOW, file: FILE, model: 'gemini-4-argon-high', tool: 'agy', deps: { role: () => ROLE, launch: () => agy, ground: GROUND, session: fakeSession({}, { write: null, stdout }) } });
    const good = await run(result('SUCCESS'));
    assert.deepEqual([good.ok, good.note], [true, 'success']);
    assert.ok(Math.abs(good.cost - 0.0282113) < 1e-9, 'priced as the model launched: 10415 uncached input, 657 output, 8113 cached' + ` (got ${good.cost})`);
    const failed = await run(result('ERROR', { error: 'the model stopped' }));
    assert.deepEqual([failed.ok, failed.note], [false, 'failed']);
    const empty = await run('');
    assert.deepEqual([empty.ok, empty.note], [false, 'failed']);
  });

  it('passes a model asked for on the command line over the role\'s', async () => {
    const e = env();
    const seen = {};
    await runHelperTurn({
      env: e, now: NOW, file: FILE, model: 'opus',
      deps: { role: () => ROLE, launch: () => LAUNCH, ground: GROUND, session: fakeSession(seen, { write: null }) },
    });
    assert.equal(seen.args[seen.args.indexOf('--model') + 1], 'opus');
  });
});

describe('what the turn is told', () => {
  const GOALS = [{ programme: 'mc', goal: 'mc-helper', stage: 'build', status: 'ready', title: 'The helper', next: 'Step 2 — the proposal turn' }];

  it('names the date, the file to write and the directory to write it in', () => {
    const prompt = helperPrompt({ file: FILE, now: NOW });
    assert.match(prompt, /Today is 2026-08-29/u);
    assert.match(prompt, /2026-08-29-<mc\|memoro>-<slug>\.md/u);
    assert.match(prompt, /or none at all/u);
  });

  /**
   * The whole of step 2: one file by name, read by the turn, one outcome for
   * that file alone. A prompt that pasted the file in could not carry a
   * screenshot, and one that asked for "the proposals" would get two.
   */
  it('names one file and asks for one outcome about it', () => {
    const prompt = helperPrompt({ file: '/Users/m/mc/intake/note.txt', now: NOW });
    assert.match(prompt, /One file in the directory you are standing in is yours this turn:\n\n {4}note\.txt\n/u);
    assert.ok(!prompt.includes('/Users/m/mc/intake/'), 'the path is not the instruction — the name is');
    assert.match(prompt, /Read it — yourself, and whole —/u);
    assert.match(prompt, /One file, one outcome: either \*\*one\*\* proposal/u);
    assert.match(prompt, /Not two from one file/u);
  });

  it('tells the turn to say when it could not read the file whole', () => {
    const prompt = helperPrompt({ file: 'huge.log', now: NOW });
    assert.match(prompt, /past your tool's read limit[\s\S]*a proposal that names the limit, or no proposal/u);
  });

  it('says which repository a digest is, and leaves any other file to the turn', () => {
    assert.match(helperPrompt({ file: FILE, now: NOW }), /It is \*\*memoro\*\*'s, so a proposal you write about it is named `2026-08-29-memoro-<slug>\.md`/u);
    assert.match(helperPrompt({ file: 'errors-memoro-cli-2026-08-29.md', now: NOW }), /`2026-08-29-mc-<slug>\.md`/u);
    // What a person dropped in belongs to whichever system the contents say,
    // and the turn is the only reader that can tell.
    const dropped = helperPrompt({ file: 'screenshot.png', now: NOW });
    assert.ok(!dropped.includes('is named `2026-08-29-'), 'no system is asserted for it');
    assert.match(dropped, /Nothing in that name says which system[\s\S]*put it in the name/u);
    // And a caller that knows better than the name — the collector — is obeyed.
    assert.match(helperPrompt({ file: 'screenshot.png', repo: 'memoro-cli', now: NOW }), /`2026-08-29-mc-<slug>\.md`/u);
  });

  it('carries the goals not finished and the project log as the ground to judge against', () => {
    const prompt = helperPrompt({
      file: FILE, goals: GOALS, projectLog: '| 2026-08-26 | msr-core | main-red-fix |', now: NOW,
    });
    assert.match(prompt, /\| mc \/ mc-helper \| build · ready \| The helper \| Step 2 — the proposal turn \|/u);
    assert.match(prompt, /PROJECT LOG \(closed projects\)[\s\S]*main-red-fix/u);
  });

  it('keeps the newest project-log rows and stays under the spawn limit when the log is large', () => {
    const rows = Array.from({ length: 4000 }, (_, i) => `| 2026-11-${String(i).padStart(4, '0')} | prog | project-${i} | delivered | ${'x'.repeat(80)} |`);
    const prompt = helperPrompt({ file: FILE, goals: GOALS, projectLog: rows.join('\n'), now: NOW });
    assert.ok(Buffer.byteLength(prompt, 'utf8') <= PROMPT_LIMIT_BYTES, `prompt is ${Buffer.byteLength(prompt, 'utf8')} bytes`);
    assert.match(prompt, /project-3999 \|/u);
    assert.ok(!prompt.includes('| project-0 |'), 'the oldest row is left out');
    assert.match(prompt, /older rows omitted; the whole log is `docs\/project\/project_log\.md` on origin\/main/u);
  });

  it('says a source is absent rather than leaving a section that reads as empty', () => {
    const prompt = helperPrompt({ file: FILE, now: NOW });
    assert.match(prompt, /GOALS NOT FINISHED -----\n_none read_/u);
    assert.match(prompt, /PROJECT LOG \(closed projects\) -----\n_none read_/u);
    assert.match(prompt, /PROPOSALS ALREADY WAITING -----\n_none_/u);
  });
});

describe('the system a proposal\'s name carries', () => {
  it('is read from the name alone', () => {
    assert.equal(proposalSystem('2026-10-18-mc-merger-gate.md'), 'mc');
    assert.equal(proposalSystem('/x/proposals/2026-10-18-memoro-sms-send.md'), 'memoro');
    assert.equal(proposalSystem('2026-10-18-mcp-thing.md'), null);
    assert.equal(proposalSystem('2026-10-18-merger-gate.md'), null);
    assert.equal(proposalSystem('notes.md'), null);
    assert.equal(proposalSystem(null), null);
  });
});

describe('which system a file in the inbox belongs to', () => {
  it('is read from the collector\'s own names and from no others', () => {
    assert.equal(repoOfFile('/w/intake/errors-memoro-2026-08-29.md'), 'memoro');
    assert.equal(repoOfFile('errors-memoro-cli-2026-08-29.md'), 'memoro-cli');
    // The unprefixed name from before memoro-cli had a digest of its own.
    assert.equal(repoOfFile('errors-2026-08-29.md'), 'memoro');
    assert.equal(repoOfFile('screenshot.png'), null);
    assert.equal(repoOfFile('errors-memoro-2026-08-29.md.bak'), null);
    assert.equal(repoOfFile(''), null);
  });
});

describe('the ground', () => {
  function repos() {
    const root = mkdtempSync(join(tmpdir(), 'mc-ground-'));
    mkdirSync(join(root, 'memoro', '.git'), { recursive: true });
    return { root, repos: [{ name: 'memoro', path: join(root, 'memoro') }, { name: 'gone', path: join(root, 'gone') }] };
  }

  const goal = (name, stage, next) => ({
    programme: 'mc', goal: name, stage, status: 'ready', title: `The ${name} goal`, log: [{ next: 'earlier' }, { next }],
  });

  it('lists the goals not finished, each with its last next action, and reads the project log on origin/main', async () => {
    const { repos: list } = repos();
    const asked = [];
    const git = async (cwd, args) => {
      asked.push(args[0]);
      if (args[0] === 'fetch') return '';
      if (args[1] === 'origin/main:docs/project/project_log.md') return '| 2026-08-26 | msr-core |';
      if (args[1] === 'origin/main:.mc/areas.json') return JSON.stringify({ schema_version: 1, areas: [
        { id: 'trust', name: 'Trust', covers: 'Keys.', standards: [], paths: [], questions: [], page: 'docs/technical/areas/trust.md' },
        { id: 'keys', name: 'Keys', covers: 'Keys again.', standards: [], paths: [], questions: [], page: 'docs/technical/areas/trust.md' },
      ] });
      return null;
    };
    const goals = () => [goal('mc-x', 'build', 'Step 2'), goal('mc-gone', 'done', 'nothing')];
    const ground = await helperGround({ env: {}, repos: list, git, goals });
    assert.deepEqual(ground.areas, ['memoro/trust'], 'the area pages memoro declares on origin/main, one per page');
    assert.equal(ground.goals.length, 1, 'a finished goal is not listed');
    assert.deepEqual(ground.goals[0], { programme: 'mc', goal: 'mc-x', stage: 'build', status: 'ready', title: 'The mc-x goal', next: 'Step 2' });
    assert.match(ground.projectLog, /msr-core/u);
    assert.deepEqual(ground.notes, []);
    assert.equal(asked.includes('ls-tree'), false, 'no repository is listed');
  });

  it('notes the project log it could not read instead of pretending it is empty', async () => {
    const { repos: list } = repos();
    const ground = await helperGround({ env: {}, repos: list, git: async () => null, goals: () => [] });
    assert.deepEqual(ground.goals, []);
    assert.equal(ground.projectLog, null);
    assert.deepEqual(ground.notes, ['no docs/project/project_log.md on origin/main in memoro']);
  });
});

/**
 * The drain, on a real filesystem: real files in a real inbox, really moved.
 * The session is still a stub — the point of the measurement is where the file
 * ends up, and a model would only make that slower to find out.
 */
describe('draining the inbox', () => {
  const ARCHIVE = (e) => join(intakeArchiveDir(e, NOW));

  function inbox(names) {
    const e = env();
    mkdirSync(intakeDir(e), { recursive: true });
    // An archive already, and a directory rather than a file: it is skipped,
    // not drained and not moved.
    mkdirSync(join(intakeDir(e), 'decisions-archive'), { recursive: true });
    writeFileSync(join(intakeDir(e), 'decisions-archive', 'mc-2.md'), '# answered\n');
    for (const name of names) writeFileSync(join(intakeDir(e), name), `# ${name}\n`);
    return e;
  }

  const drain = (e, over = {}) => drainIntake({
    env: e, now: () => NOW, deps: { turn: async () => ({ ok: true, wrote: [], waiting: [] }), ...over },
  });

  it('takes the oldest files first, one turn each, and archives every one', async () => {
    const e = inbox(['note.md', 'errors-memoro-cli-2026-08-27.md', 'errors-memoro-2026-08-26.md']);
    const taken = [];
    const out = await drain(e, { turn: async ({ file }) => { taken.push(file); return { ok: true, wrote: [], waiting: [] }; } });

    assert.deepEqual(taken, ['errors-memoro-2026-08-26.md', 'errors-memoro-cli-2026-08-27.md', 'note.md']);
    assert.deepEqual(out.done.map((d) => d.archived), [true, true, true]);
    assert.equal(out.left, 0);
    assert.deepEqual(readdirSync(intakeDir(e)), ['decisions-archive'], 'nothing but the archive is left');
    assert.deepEqual(readdirSync(ARCHIVE(e)).sort(), ['errors-memoro-2026-08-26.md', 'errors-memoro-cli-2026-08-27.md', 'note.md']);
    assert.equal(readFileSync(join(ARCHIVE(e), 'note.md'), 'utf8'), '# note.md\n', 'moved, not deleted');
  });

  /**
   * The rule the whole thing rests on: a turn whose session came back non-zero
   * has still had its turn, and the file goes to the archive anyway. A file put
   * back is a file every round after this one takes again, and again.
   */
  it('archives a file whose session returned non-zero', async () => {
    const e = inbox(['errors-memoro-2026-08-26.md']);
    const out = await drainIntake({
      env: e,
      now: () => NOW,
      deps: {
        turn: (options) => runHelperTurn({
          ...options,
          deps: {
            role: () => ROLE, launch: () => LAUNCH, ground: GROUND,
            session: async () => ({ status: 1, stdout: 'not json', stderr: 'claude: fatal', timedOut: false }),
          },
        }),
      },
    });
    assert.equal(out.done[0].turn.ok, false, 'the turn failed');
    assert.equal(out.done[0].turn.note, 'no-json');
    assert.equal(out.done[0].archived, true);
    assert.deepEqual(readdirSync(intakeDir(e)), ['decisions-archive']);
    assert.equal(readFileSync(join(ARCHIVE(e), 'errors-memoro-2026-08-26.md'), 'utf8'), '# errors-memoro-2026-08-26.md\n');
  });

  it('archives a file whose turn threw, and names it as having thrown', async () => {
    const e = inbox(['a-2026-08-26.md']);
    const out = await drain(e, { turn: async () => { throw new Error('claude died'); } });
    assert.deepEqual([out.done[0].turn.ok, out.done[0].turn.reason], [false, 'turn-threw']);
    assert.equal(readdirSync(ARCHIVE(e))[0], 'a-2026-08-26.md');
  });

  it('takes no more than the limit, and says how many are left', async () => {
    const e = inbox(['a-2026-08-26.md', 'b-2026-08-27.md', 'c-2026-08-28.md']);
    const out = await drain(e, {});
    assert.equal(out.done.length, 3, 'INTAKE_PER_ROUND by default');

    const e2 = inbox(['a-2026-08-26.md', 'b-2026-08-27.md']);
    const one = await drainIntake({ env: e2, now: () => NOW, limit: 1, deps: { turn: async () => ({ ok: true, wrote: [] }) } });
    assert.deepEqual(one.done.map((d) => d.file), ['a-2026-08-26.md']);
    assert.equal(one.left, 1);
    assert.deepEqual(readdirSync(intakeDir(e2)).sort(), ['b-2026-08-27.md', 'decisions-archive']);
  });

  it('stops between files when asked, and never inside one', async () => {
    const e = inbox(['a-2026-08-26.md', 'b-2026-08-27.md', 'c-2026-08-28.md']);
    const out = await drain(e, { stop: () => true });
    assert.equal(out.done.length, 1);
    assert.equal(out.done[0].archived, true, 'the file it did take is still archived');
    assert.equal(out.left, 2);
  });

  it('is an empty answer for an inbox with nothing in it', async () => {
    const e = env();
    const out = await drain(e, {});
    assert.deepEqual(out.done, []);
    assert.equal(out.left, 0);
  });
});

describe('proposals per area', () => {
  const programme = (e, name, readme) => {
    mkdirSync(join(e.MC_WORK_ROOT, 'programs', name), { recursive: true });
    if (readme !== undefined) writeFileSync(join(e.MC_WORK_ROOT, 'programs', name, 'README.md'), readme);
  };

  it('lists every area\'s proposals/ on disk, by area then name, and no archive, no root and no programme folder', () => {
    const e = env();
    assert.deepEqual(listAllProposals(e), [], 'no areas home is no proposals, not an error');
    mkdirSync(areaProposalsArchiveDir('memoro-cli', 'system', e), { recursive: true });
    mkdirSync(areaProposalsDir('memoro', 'trust', e), { recursive: true });
    // An area folder whose page is no longer declared is still listed: listing reads the disk, not git.
    mkdirSync(areaProposalsDir('memoro', 'retired-page', e), { recursive: true });
    writeFileSync(join(areaProposalsDir('memoro-cli', 'system', e), '2026-08-28-mc-own.md'), 'x\n');
    writeFileSync(join(areaProposalsDir('memoro-cli', 'system', e), '2026-08-27-mc-older.md'), 'x\n');
    writeFileSync(join(areaProposalsDir('memoro', 'trust', e), '2026-08-29-memoro-keys.md'), 'x\n');
    writeFileSync(join(areaProposalsDir('memoro', 'retired-page', e), '2026-08-20-memoro-old.md'), 'x\n');
    // A name is all mc reads: a file with no heading counts, a file that is not markdown does not.
    writeFileSync(join(areaProposalsDir('memoro', 'trust', e), 'notes.txt'), 'not markdown\n');
    writeFileSync(join(areaProposalsArchiveDir('memoro-cli', 'system', e), '2026-08-01-mc-declined.md'), 'Utfall: ej aktuellt — no\n');
    mkdirSync(join(e.MC_WORK_ROOT, 'proposals'), { recursive: true });
    writeFileSync(join(e.MC_WORK_ROOT, 'proposals', '2026-08-26-mc-root.md'), 'x\n');
    mkdirSync(join(e.MC_WORK_ROOT, 'programs', 'mc', 'proposals'), { recursive: true });
    writeFileSync(join(e.MC_WORK_ROOT, 'programs', 'mc', 'proposals', '2026-08-26-mc-programme.md'), 'x\n');
    assert.equal(areaProposalsArchiveDir('memoro-cli', 'system', e), join(e.MC_WORK_ROOT, 'areas', 'memoro-cli', 'system', 'proposals', 'archive'));
    assert.deepEqual(listAllProposals(e).map((p) => [p.area, p.file]), [
      ['memoro-cli/system', '2026-08-27-mc-older.md'],
      ['memoro-cli/system', '2026-08-28-mc-own.md'],
      ['memoro/retired-page', '2026-08-20-memoro-old.md'],
      ['memoro/trust', '2026-08-29-memoro-keys.md'],
    ]);
  });

  it('mc proposals counts them by area, with each area\'s path and the total', () => {
    const e = env();
    for (const [repo, slug, file] of [['memoro-cli', 'system', '2026-08-28-mc-a.md'], ['memoro-cli', 'system', '2026-08-29-mc-b.md'], ['memoro', 'trust', '2026-08-29-memoro-c.md']]) {
      mkdirSync(areaProposalsDir(repo, slug, e), { recursive: true });
      writeFileSync(join(areaProposalsDir(repo, slug, e), file), 'x\n');
    }
    mkdirSync(areaProposalsArchiveDir('memoro', 'trust', e), { recursive: true });
    writeFileSync(join(areaProposalsArchiveDir('memoro', 'trust', e), '2026-08-01-memoro-done.md'), 'Utfall: x\n');
    const summary = collectProposalCounts(e);
    assert.deepEqual(summary, { total: 3, areas: [
      { area: 'memoro-cli/system', count: 2, path: areaProposalsDir('memoro-cli', 'system', e) },
      { area: 'memoro/trust', count: 1, path: areaProposalsDir('memoro', 'trust', e) },
    ] });
    assert.equal(proposalsListing(summary), 'proposals — 3 waiting\n  memoro-cli/system  2\n  memoro/trust       1\n  Total              3\n');
  });

  it('gives the turn the programmes as ground, and the areas with the two fallbacks as where a proposal goes', () => {
    const e = env();
    programme(e, 'mc', '# mc\n\nmc itself: the runner, the verbs and the page.\n\nMore.\n');
    programme(e, 'quiet');
    const routes = programmeRoutes(e);
    assert.deepEqual(routes, [
      { name: 'mc', line: 'mc itself: the runner, the verbs and the page.' },
      { name: 'quiet', line: '(no description)' },
    ]);
    const prompt = helperPrompt({ file: FILE, now: NOW, programmes: routes, areas: ['memoro/trust'], env: { MC_WORK_ROOT: '/w' } });
    assert.match(prompt, /----- PROGRAMMES -----\n- mc — mc itself: the runner, the verbs and the page\.\n- quiet — \(no description\)\n/u);
    assert.ok(prompt.includes('A proposal goes in the `proposals/` of the area it concerns: `/w/areas/<repo>/<area>/proposals/`, '
      + 'where `<repo>/<area>` is one of `memoro-cli/system`, `memoro/delivery`, `memoro/trust`. With no clear area it goes to '
      + '`memoro-cli/system` when mc would change and to `memoro/delivery` when memoro would change.'), prompt);
    assert.ok(!prompt.includes('/w/proposals'), 'no ownerless root is named');
    assert.ok(!/<programme>\/proposals/u.test(prompt), 'no programme is a place for a proposal');
    assert.ok(!/archive/u.test(prompt), 'no archive is named or read');
  });

  it('groups the proposals already waiting by area', () => {
    const prompt = helperPrompt({
      file: FILE, now: NOW,
      proposals: [{ area: 'memoro/trust', file: 'b.md' }, { area: 'memoro-cli/system', file: 'a.md' }, { area: 'memoro/trust', file: 'c.md' }],
    });
    assert.match(prompt, /PROPOSALS ALREADY WAITING -----\narea memoro-cli\/system:\n- a\.md\narea memoro\/trust:\n- b\.md\n- c\.md$/u);
  });

  it('finds a proposal the turn wrote in an area and says which area it went to', async () => {
    const e = env();
    programme(e, 'mc', 'mc itself.\n');
    const system = areaProposalsDir('memoro-cli', 'system', e);
    mkdirSync(system, { recursive: true });
    writeFileSync(join(system, '2026-08-28-mc-older.md'), 'x\n');
    const seen = {};
    const result = await runHelperTurn({
      env: e, now: NOW, file: FILE,
      deps: {
        role: () => ROLE, launch: () => LAUNCH, ground: GROUND,
        session: async (call) => {
          Object.assign(seen, call);
          writeFileSync(join(system, '2026-08-29-mc-routed.md'), PROPOSAL);
          return { status: 0, stdout: CLAUDE_JSON, stderr: '', timedOut: false };
        },
      },
    });
    assert.match(seen.args[1], /- mc — mc itself\./u);
    assert.match(seen.args[1], /area memoro-cli\/system:\n- 2026-08-28-mc-older\.md/u);
    assert.match(seen.args[1], /one of `memoro-cli\/system`, `memoro\/delivery`\./u, 'the areas on disk and the fallbacks, when the ground read none');
    assert.deepEqual(result.wrote.map((p) => [p.area, p.file]), [['memoro-cli/system', '2026-08-29-mc-routed.md']]);
    assert.equal(result.waiting.length, 2);
    assert.equal(describeTurn(result), '1 proposal to area memoro-cli/system, 2 waiting');
  });
});

describe('the proposal a turn leaves behind', () => {
  it('is a file a person and the brief can both read', async () => {
    const { env: e } = await turn();
    const text = readFileSync(join(DELIVERY(e), '2026-08-29-expose-operations.md'), 'utf8');
    assert.match(text, /^---\nname: expose-operations\nrepo: memoro\nkind: project\n---\n/u);
    assert.match(text, /## Done when/u);
  });
});

it('preserves the API reserve decision for an unusable subscription and refuses API off', async t => {
  const now = new Date('2026-11-05T18:00:00Z');
  const e = env();
  t.after(() => rmSync(e.MC_WORK_ROOT, { recursive: true, force: true }));
  changeProviderPriority(e, 'codex');
  const root = runnerDir(e);
  const fullClaude = applyObservation(normaliseCapacity(null), 'claude', {
    windows: { five_hour: { fraction_used: 1, resets_at: '2026-11-05T22:00:00Z' } },
  }, now);
  for (const observation of [
    { models: [] },
    { models: [{ id: 'gpt-6-luna', efforts: ['low'] }] },
    { models: [{ id: 'gpt-6-luna', efforts: ['high'] }], observed_at: '2026-11-01T18:00:00Z' },
  ]) {
    const capacity = applyObservation(fullClaude, 'codex', {
      windows: { primary: { fraction_used: 0.1, resets_at: '2026-11-05T22:00:00Z' } },
      models: observation.models,
    }, new Date(observation.observed_at || now));
    writeCapacity(capacity, { root });
    const calls = [];
    const options = {
      file: FILE,
      env: e, now, tool: null,
      deps: {
        role: () => ROLE, ground: GROUND,
        launch: tool => ({ ok: true, id: tool === 'codex' ? 'codex' : 'claude-code', shortName: tool,
          adapter: getAdapter(tool === 'codex' ? 'codex' : 'claude-code'), spec: { bin: '/fake/provider' } }),
        session: async call => { calls.push(call); return { status: 0, stdout: '{"type":"turn.completed","usage":{}}', stderr: '' }; },
      },
    };
    writeBillingApi('codex', true, { root });
    const result = await runHelperTurn(options);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].bin, process.execPath, 'API reserve must not launch the unusable subscription directly');
    assert.match(calls[0].args[0], /billing-gateway-session\.js$/u);
    assert.deepEqual(calls[0].args.slice(1, 4), ['codex', 'gpt-6-luna', '/fake/provider']);
    assert.equal(result.billing, 'credits');
    assert.match(result.routeWhy, /API reserve/u);
    writeBillingApi('codex', false, { root });
    const off = await runHelperTurn(options);
    assert.equal(off.ok, false);
    assert.match(off.reason, /codex API off/u);
    assert.equal(calls.length, 1, 'API off must launch neither API nor an unusable subscription');
  }
});
