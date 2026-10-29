/** Shared isolated admission/outcome fixture. No test registration or real gate run. */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, git, completion } from './autonomous-publication-fixture.js';
import { reviewer } from './autonomous-state-fixture.js';
import { settlePublishedBuild } from '../../src/mc/autonomous-recovery.js';
import { prepareAutonomousReview, completeAutonomousReview } from '../../src/mc/autonomous-review.js';
import { mutateAutonomousProject } from '../../src/mc/autonomous-state.js';
import { autonomousMergeDoor } from '../../src/mc/autonomous-pr.js';
import { queueMerge } from '../../src/mc/merger.js';
import { runMergeRound } from '../../src/mc/repo-merge.js';
import { publicationGateSelection } from '../../src/mc/commands/gate.js';
import { captureWorktree, gateReceipt, persistGateReceipt } from '../../src/mc/session-gate-evidence.js';

export const clean = () => ({ criteria: [
  { criterion_id: 'schema', status: 'verified', evidence: ['Measured schema.'], uncertainty: [] },
  { criterion_id: 'integration', status: 'deferred', evidence: ['Requires integration.'], uncertainty: [] },
], defects: [], uncertainty: [] });

export async function ready(t, { result = clean(), beforeReview = null, review = true } = {}) {
  const f = fixture(t);
  // A real selector/declaration, used by publication AND merge admission. It
  // only lists checks; no test process or gate is started inside this fixture.
  mkdirSync(join(f.cwd, '.mc'));
  writeFileSync(join(f.cwd, '.mc/test.json'), JSON.stringify({ select: 'node select.mjs', select_why: 'Isolated fixture selector.',
    pr_tests_flags: [], select_changed_path: true, select_changed_path_why: 'Fixture supports changed paths.' }));
  writeFileSync(join(f.cwd, 'select.mjs'), 'console.log(JSON.stringify({files:["schema.test.js"],commands:[]}));\n');
  f.deps.requirements = () => publicationGateSelection(f.cwd, f.env);
  f.deps.gate = async (args, call) => {
    const required = await f.deps.requirements(); const content = captureWorktree(f.cwd);
    const receipt = gateReceipt({ measurement: { repo: 'memoro-cli', run: 'admission-gate', ...call.measurementBinding,
      configuration: required.configuration, candidate: content, base: required.base }, before: content, after: content,
      result: { ok: true, code: 0, coverage: required.selection, execution: { tests: { exit: 0, finished: true,
        totals: { tests: 1, pass: 1, fail: 0, cancelled: 0 } }, commands: [] } },
      started: '2026-10-28T12:00:00Z', ended: '2026-10-28T12:01:00Z' });
    const path = persistGateReceipt({ root: f.env.MC_HOME, receipt });
    call.stdout.write(JSON.stringify({ evidence: { path } })); return 0;
  };
  f.edit(); await f.finish(); await settlePublishedBuild(f.options(), completion, f.deps);
  if (beforeReview) beforeReview(f);
  const options = { root: f.root, programme: f.programme, project: f.project, actor: reviewer, cwd: f.cwd,
    model: f.stateNow().reviewer_model };
  if (review) {
    prepareAutonomousReview(options);
    mutateAutonomousProject(f.root, f.programme, f.project, 'report', result, { actor: reviewer, revision: f.stateNow().revision });
    completeAutonomousReview(options, { status: 0 });
  }
  const door = extra => autonomousMergeDoor({ root: f.root, repoPath: f.cwd, pr: 42, env: f.env, gh: f.gh, ...extra });
  const patch = change => { const state = f.stateNow(); change(state); writeFileSync(f.paths.project, JSON.stringify(state)); };
  return { ...f, door, patch, options };
}
export const queue = (f, autonomous) => queueMerge({ root: f.root, repo: 'memoro-cli', repoPath: f.cwd, pr: 42,
  branch: f.project, env: f.env, autonomous, start: () => ({ pid: null, started: false }) });
export const receiptPath = f => join(f.env.MC_HOME, 'gate-evidence', 'admission-gate.json');
export function moveMain(f, path) {
  const branch = git(f.cwd, 'branch', '--show-current'); git(f.cwd, 'switch', '-q', 'main');
  if (path !== 'empty') {
    const file = join(f.cwd, path); mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, 'Main movement.\n');
    git(f.cwd, 'add', path);
  }
  git(f.cwd, 'commit', '--allow-empty', '-qm', 'Move main'); git(f.cwd, 'push', '-q', 'origin', 'main');
  const head = git(f.cwd, 'rev-parse', 'HEAD'); git(f.cwd, 'switch', '-q', branch); return head;
}

// Real leased merge round; adapters stand in for GitHub and gate execution,
// not for git ancestry, content, ownership, reports or gate receipt validation.
export function round(f, { duringGate = () => {}, ticket = undefined, measuredHead = undefined, unadmitted = false, mergeReply = 'ok' } = {}) {
  let merged = false; const calls = []; const head = f.stateNow().publication.head;
  const gh = (args, options) => {
    calls.push(args);
    if (args[1] === 'merge') { assert.equal(args.at(-1), head); merged = true; return { status: mergeReply === 'ok' ? 0 : 1, stdout: '', stderr: mergeReply === 'ok' ? '' : 'reply lost' }; }
    if (args.at(-1) === 'state,mergedAt' && mergeReply !== 'ok') return mergeReply === 'unknown'
      ? { status: 1, stderr: 'readback unavailable' } : { status: 0, stdout: JSON.stringify({ state: 'MERGED' }) };
    if (args.at(-1) === 'headRefOid') return { status: 0, stdout: JSON.stringify({ headRefOid: head }) };
    if (args.at(-1) === 'mergeCommit') return { status: 0, stdout: JSON.stringify({ mergeCommit: { oid: head } }) };
    return f.gh(args, options);
  };
  const run = async () => {
    const base = git(f.cwd, 'rev-parse', 'origin/main');
    const report = await runMergeRound({ repoPath: f.cwd, pr: 42, root: f.env.MC_HOME, env: f.env, gh,
      autonomous: ticket, holder: { name: 'fixture-merger' }, installs: () => [], mergeLog: null,
      gate: async call => {
        if (unadmitted) assert.equal(call.evidence, undefined);
        else { assert.equal(call.evidence.run, 'admission-gate'); assert.equal(call.evidence.sessionRun, f.stateNow().publication.run_id); }
        await duringGate(call);
        return { ok: true, stopped_at: null, reason: null, pr: { number: 42, base: 'main', head: f.project, head_sha: measuredHead === undefined ? head : measuredHead },
          base: { commit: base }, candidate: { red: [], totals: { tests: 1, fail: 0 } }, extra_gates: [] };
      }, sleep: async () => {} });
    return { report, merged, calls };
  };
  return run();
}

