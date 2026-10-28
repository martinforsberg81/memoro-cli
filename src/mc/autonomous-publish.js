/** V2 finish transaction. Preparing a publication is not a normal process
 * exit. Only the trusted runner can commit the handoff after children settle. */
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { readAutonomousState, readProgrammeState, saveAutonomousPublication, currentAutonomousEvidence } from './autonomous-state.js';
import { captureWorktree, findPublicationReceipt, sameContent } from './session-gate-evidence.js';
import { checksHash, fullCoverage, readGreenReceipt } from './gate-greens.js';
import { persistSessionResult, validateSessionResult } from './session-handoff.js';
import { reconcilePreviousSession, reconcileSessionGate, sessionGit, sessionGitDir } from './session-recovery.js';
import { AUTONOMOUS_PR_MARK, markAutonomousPr } from './autonomous-pr.js';
import { runTool } from './child-async.js';
import { takeClaim, releaseClaim } from './resource-claim.js';
import { mcHome } from './paths.js';
import { run as gateCommand, publicationGateSelection } from './commands/gate.js';
import { run as publishCommand } from './commands/publish.js';

const git = (cwd, args) => sessionGit(cwd, args).trim();
const read = options => readAutonomousState(options.root, options.programme, options.project);
function owned(options) {
  const state = read(options);
  if (options.actor?.role !== 'step' || !isDeepStrictEqual(state.active_run, options.actor)) throw new Error('active step run ownership required');
  const binding = state.session_control?.binding;
  if (state.session_control?.phase !== 'closing' || !['running', 'closing', 'publishing'].includes(state.phase)
    || binding?.run_id !== options.actor.run_id || binding.goal_revision !== state.goal_revision
    || binding.programme_revision !== state.programme_revision) throw new Error('finish requires closing control on the current assignment');
  if (git(options.cwd, ['branch', '--show-current']) !== state.ownership.branch) throw new Error('branch ownership mismatch');
  const agreement = readProgrammeState(options.root, options.programme).approved.find(item => item.revision === state.programme_revision);
  const assignmentPath = join(options.root, 'programs', options.programme, options.project, 'PLAN.json');
  if (!isDeepStrictEqual(JSON.parse(readFileSync(assignmentPath, 'utf8')), state.contract)) throw new Error('sent assignment changed');
  return { state, context: { assignment: state.contract, programme: agreement, runId: options.actor.run_id } };
}
function criteria(state, result) {
  const latest = new Map(currentAutonomousEvidence(state).builder.map(item => [item.criterion_id, item]));
  for (const item of result.handoff.evidence) {
    const recorded = latest.get(item.criterion_id);
    if (recorded?.status !== 'verified' || recorded.reference !== item.reference) throw new Error('handoff criterion updates require current verified builder evidence');
  }
}
function save(options, publication) {
  const { state } = owned(options);
  return saveAutonomousPublication(options.root, options.programme, options.project,
    { actor: options.actor, revision: state.revision, publication }).publication;
}
function claim(options) {
  const path = join(sessionGitDir(options.cwd), 'mc-autonomous-finish.claim');
  const held = takeClaim(path, { pid: process.pid, run_id: options.actor.run_id });
  if (!held.ok) throw new Error('publication already owned or ownership unknown');
  return () => releaseClaim(path, held.marker);
}
async function receiptFor(options, publication, deps) {
  const { state } = owned(options);
  const requirements = await (deps.requirements || publicationGateSelection)(options.cwd, options.env);
  git(options.cwd, ['merge-base', '--is-ancestor', requirements.base, 'HEAD']);
  const content = captureWorktree(options.cwd);
  const receipt = readGreenReceipt({ root: mcHome(options.env), repo: state.contract.repo, repository: content.repository,
    run: publication.gate_run, sessionRun: options.actor.run_id, goalRevision: state.goal_revision,
    configuration: requirements.configuration });
  if (!receipt || !fullCoverage(receipt.coverage) || !sameContent(content, receipt)
    || receipt.base !== requirements.base || checksHash(receipt.coverage) !== checksHash(requirements.selection)) {
    throw new Error('normal finish requires matching current content and complete relevant green gate evidence');
  }
  const settled = reconcileSessionGate(sessionGitDir(options.cwd));
  if (!settled.ok) throw new Error(`gate completion unknown: ${settled.reason}`);
  return { receipt, requirements, content };
}
function assertCommit(options, publication) {
  if (git(options.cwd, ['rev-parse', 'HEAD']) !== publication.head
    || git(options.cwd, ['rev-parse', 'HEAD^{tree}']) !== publication.tree
    || git(options.cwd, ['status', '--porcelain'])) throw new Error('committed publication content changed');
}

/** Model-callable prepare: always uses mc gate's complete affected selection.
 * Input contains interpretation and references, never observed gate/push facts. */
export async function finishAutonomousPublication(options, input, deps = {}) {
  options = { env: process.env, ...options };
  const { state: initial, context } = owned(options);
  if (options.revision !== initial.revision) throw new Error('stale state revision');
  if (!input || Object.keys(input).sort().join(',') !== 'body,goal_revision,message,result,title'
    || input.goal_revision !== initial.goal_revision
    || !['message', 'title', 'body'].every(key => typeof input[key] === 'string') || !input.message.trim() || !input.title.trim()) throw new Error('invalid finish input or assignment revision');
  input = structuredClone(input);
  if (input.result?.handoff?.published_sha !== null) throw new Error('finish input cannot claim a published SHA');
  const validation = validateSessionResult({ ...input.result, handoff: { ...input.result.handoff,
    published_sha: git(options.cwd, ['rev-parse', 'HEAD']) } }, context);
  if (!validation.ok || !['continue', 'review-ready'].includes(input.result.outcome)) throw new Error(`invalid normal finish result: ${validation.problems.join('; ')}`);
  criteria(initial, input.result);
  const release = claim(options);
  try {
    let publication = initial.publication?.run_id === options.actor.run_id ? initial.publication : null;
    if (publication && !isDeepStrictEqual(publication.input, input)) throw new Error('publication intent cannot change during retry');
    if (!publication) publication = save(options, { run_id: options.actor.run_id, goal_revision: initial.goal_revision,
      programme_revision: initial.programme_revision, branch: initial.ownership.branch, pr: initial.ownership.pr,
      phase: 'started', input });
    if (publication.phase === 'started') {
      let output = '';
      const status = await (deps.gate || gateCommand)(['--json'], { cwd: options.cwd, env: options.env,
        stdout: { write: text => { output += text; } }, stderr: deps.stderr || process.stderr,
        measurementBinding: { session_run: options.actor.run_id, goal_revision: initial.goal_revision } });
      if (status !== 0) throw new Error('relevant session gate did not complete green');
      let path;
      try { path = JSON.parse(output).evidence.path; } catch { throw new Error('gate produced no completed evidence'); }
      const run = basename(path).replace(/\.json$/u, '');
      if (path !== join(mcHome(options.env), 'gate-evidence', `${run}.json`)) throw new Error('gate evidence location is invalid');
      publication = { ...publication, gate_run: run };
      const checked = await receiptFor(options, publication, deps);
      publication = save(options, { ...publication, phase: 'gate_verified', tree: checked.receipt.tree });
    }
    await receiptFor(options, publication, deps);
    if (publication.phase === 'gate_verified') {
      // A crash after commit but before the phase write finds the same tree;
      // it neither resets the checkout nor requires an empty commit.
      if (git(options.cwd, ['rev-parse', 'HEAD^{tree}']) !== publication.tree) {
        git(options.cwd, ['add', '-A']);
        if (git(options.cwd, ['write-tree']) !== publication.tree) throw new Error('staged content differs from measured tree');
        git(options.cwd, ['commit', '-m', input.message]);
      }
      publication = { ...publication, head: git(options.cwd, ['rev-parse', 'HEAD']) };
      assertCommit(options, publication);
      publication = save(options, { ...publication, phase: 'committed' });
    }
    assertCommit(options, publication);
    await receiptFor(options, publication, deps);
    const marker = pr => markAutonomousPr({ root: options.root, repo: initial.contract.repo, branch: publication.branch,
      programme: options.programme, project: options.project, pr });
    const marked = marker(publication.pr);
    if (publication.pr === null && marked.pr !== null) publication = save(options, { ...publication, pr: marked.pr });
    // Even retries go through mc publish's non-force push and observed remote
    // head/PR checks. Its existing-PR lookup prevents duplicate creation.
    const code = await (deps.publish || publishCommand)(['--title', input.title, '--body', input.body, '--no-merge'], {
      ...deps.publishDeps, cwd: options.cwd, env: options.env,
      stdout: deps.stdout || process.stdout, stderr: deps.stderr || process.stderr,
      autonomousPublication: { branch: publication.branch, pr: publication.pr,
        async onPushed(head) {
          if (head !== publication.head) throw new Error('head changed before push confirmation');
          await receiptFor(options, publication, deps); assertCommit(options, publication);
          if (publication.phase === 'committed') publication = save(options, { ...publication, phase: 'pushed' });
        },
        async onLocated(number) {
          marker(number);
          if (publication.pr === null) publication = save(options, { ...publication, pr: number });
        },
        async onResolved(pr) {
          marker(pr.number);
          if (publication.phase === 'pushed') publication = save(options, { ...publication, phase: 'pr_resolved', pr: pr.number });
        },
      },
    });
    if (code !== 0) throw new Error('autonomous publication failed; owner and local commits retained');
    return publication;
  } finally { release(); }
}

/** Runner-only: successful transport completion and quiescent children are
 * separate from model interpretation. This still grants no continuation/merge. */
export async function completeAutonomousPublication(options, processResult, deps = {}) {
  options = { env: process.env, ...options };
  const release = claim(options);
  try {
    const { state, context } = owned(options);
    let publication = state.publication;
    if (!publication || publication.run_id !== options.actor.run_id || !['pr_resolved', 'handoff_committed'].includes(publication.phase)) throw new Error('confirmed publication required');
    if (!processResult?.normal_exit || !processResult.recovery_ready || !processResult.control_persisted
      || processResult.status !== 0 || processResult.interrupted || processResult.signal) throw new Error('successful settled process completion required');
    const previous = reconcilePreviousSession(sessionGitDir(options.cwd));
    if (!previous.ok) throw new Error(`session is not quiescent: ${previous.reason}`);
    try {
      const manifest = JSON.parse(readFileSync(join(sessionGitDir(options.cwd), 'mc-autonomous-session.json'), 'utf8'));
      if (manifest.run_id !== options.actor.run_id || !isDeepStrictEqual(manifest.binding, state.session_control.binding)) throw new Error('process completion belongs to another run/assignment');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const { receipt, requirements } = await receiptFor(options, publication, deps);
    assertCommit(options, publication);
    const pushed = git(options.cwd, ['ls-remote', '--heads', 'origin', publication.branch]).split(/\s+/u)[0];
    if (pushed !== publication.head) throw new Error('remote no longer holds the measured commit');
    const askGh = deps.gh || deps.publishDeps?.gh || ((args) => runTool('gh', args, { cwd: options.cwd }));
    const response = await askGh(['pr', 'view', String(publication.pr), '--json', 'number,state,headRefName,headRefOid,baseRefName,body']);
    let pr;
    try { pr = JSON.parse(response.stdout); } catch { /* refused below */ }
    if (!(response.ok === true || response.status === 0) || pr?.number !== publication.pr || pr.state !== 'OPEN'
      || pr.headRefName !== publication.branch || pr.headRefOid !== publication.head || pr.baseRefName !== 'main'
      || !pr.body?.includes(AUTONOMOUS_PR_MARK)) throw new Error('existing PR publication is no longer confirmed');
    const result = structuredClone(publication.input.result);
    result.handoff.published_sha = publication.head;
    criteria(state, result);
    const evidence = { cwd: options.cwd, head: publication.head, pushed, run: receipt.run,
      evidenceRoot: mcHome(options.env), configuration: requirements.configuration, selection: requirements.selection };
    if (!findPublicationReceipt({ ...evidence, root: evidence.evidenceRoot, repo: state.contract.repo,
      sessionRun: options.actor.run_id, goalRevision: state.goal_revision })) throw new Error('publication evidence changed');
    const previousRun = state.runs.filter(run => run.role === 'step' && run.run_id !== options.actor.run_id).at(-1)?.run_id ?? null;
    const handoff = persistSessionResult({ root: options.root, ...context, result, publication: evidence,
      ownership: state.ownership, expectedPreviousRun: previousRun, completion: { exit_code: 0, interrupted: false } }, deps.handoffDeps);
    if (publication.phase !== 'handoff_committed') publication = save(options, { ...publication,
      phase: 'handoff_committed', handoff: handoff.artifact });
    return publication;
  } finally { release(); }
}
