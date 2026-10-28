/** The explicit, audited exception to a sent plan's ordinary edit freeze. */
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultRepos } from '../brief-collect.js';
import { writeJsonAtomic } from '../atomic-write.js';
import { amendedPlan, amendmentStanding } from '../plan-amend.js';
import { NAME_RE } from '../plan-schema.js';
import { findProjectDir, legacyMutationProblem, withPlanLock, writePlanFile } from '../plan-write.js';
import { readEntry, realLock, whoAmI } from '../register.js';
import { programsHome } from '../paths.js';

const digest = text => createHash('sha256').update(text).digest('hex');

/** List bounded open PRs; refuse truncation rather than miss a project branch. */
export function openProjectPrs(repo, project, entry, spawn = spawnSync) {
  const result = spawn('gh', ['pr', 'list', '--state', 'open', '--limit', '1000',
    '--json', 'number,headRefName'], { cwd: repo.path, encoding: 'utf8', timeout: 60_000 });
  if (result.status !== 0) throw new Error(result.stderr?.trim() || 'cannot list open pull requests');
  let rows;
  try { rows = JSON.parse(result.stdout); } catch { throw new Error('open pull request lookup returned invalid JSON'); }
  if (!Array.isArray(rows) || rows.length >= 1000
    || rows.some(row => !Number.isInteger(row?.number) || typeof row.headRefName !== 'string')) {
    throw new Error('open pull request lookup is incomplete');
  }
  const branches = new Set(entry.steps.map(step => step.branch).filter(Boolean));
  const numbers = new Set(entry.steps.map(step => step.pr).filter(Boolean));
  return rows.filter(row => row.headRefName === project || row.headRefName.startsWith(`${project}-`)
    || branches.has(row.headRefName) || numbers.has(row.number));
}

export function runAmend(scanned, deps) {
  const { env, root, stdout, stderr } = deps;
  const [verb, project, ...extra] = scanned.positional;
  const path = scanned.flags['amendment-file'];
  const reason = scanned.flags.reason?.trim();
  if (verb !== 'amend' || !NAME_RE.test(project || '') || extra.length || !path || !reason) {
    stderr.write('mc: amend needs <project> --amendment-file <json> --reason "<authorization>"\n');
    return 2;
  }
  if (env.MC_STEP) {
    stderr.write('mc: a step session cannot amend a project; use the planning session\n');
    return 1;
  }
  const home = deps.home || programsHome(env);
  const found = findProjectDir(home, project);
  if (!found?.sent) { stderr.write(`mc: ${project} needs a sent plan; use the draft verbs before send\n`); return 1; }
  const closed = join(found.dir, 'CLOSEOUT.json');
  const readText = deps.readPlanText || (file => readFileSync(file, 'utf8'));
  const readState = () => readEntry(root, project, deps.io);
  try {
    if (existsSync(closed)) throw new Error('an archived project cannot be amended');
    const beforeText = readText(found.file);
    const before = JSON.parse(beforeText);
    const unsupported = legacyMutationProblem(found.file, before);
    if (unsupported) throw new Error(unsupported);
    const entry = readState();
    amendmentStanding(before, entry);
    if (entry.project !== project || entry.repo !== before.repo) throw new Error('the register project and repository must match the plan');
    const next = amendedPlan(before, entry, JSON.parse(readText(path)));
    const repo = (deps.repos || defaultRepos(env)).find(candidate => candidate.name === before.repo);
    if (!repo) throw new Error(`unknown repository ${before.repo}`);
    const pulls = (deps.openProjectPrs || openProjectPrs)(repo, project, entry);
    if (!Array.isArray(pulls)) throw new Error('open pull request lookup is incomplete');
    if (pulls.length) throw new Error(`${pulls.map(pr => `#${pr.number}`).join(', ')} is open — land or close it before amending`);

    // Remote IO is finished before taking either lock. Refuse a concurrent
    // plan/state change, and hold the register lock through the atomic commit.
    // This verb never writes the register, its criteria or a step's ready state.
    const lockState = deps.io?.lock || ((where, fn) => realLock(where, fn, { strict: true }));
    const auditPath = join(found.dir, 'amendments', `${randomUUID()}.json`);
    (deps.planLock || withPlanLock)(found.dir, () => lockState(root, () => {
      if (existsSync(closed) || readText(found.file) !== beforeText
        || JSON.stringify(readState()) !== JSON.stringify(entry)) {
        throw new Error('the plan or register changed during review — read it and amend again');
      }
      amendmentStanding(before, entry);
      const afterText = `${JSON.stringify(next, null, 2)}\n`;
      // Durable authorization precedes the only authoritative write. A failed
      // plan write leaves this as an attempt, not a false claim of completion:
      // the recorded digest identifies exactly which plan it authorized.
      (deps.writeAudit || writeJsonAtomic)(auditPath, {
        schema: 'mc-plan-amendment', version: 1, project, at: deps.now,
        reason, by: (deps.by || whoAmI)(),
        before_sha256: digest(beforeText), after_sha256: digest(afterText),
        before, after: next,
      });
      writePlanFile(found.file, next, { write: deps.writeAmendedPlan || writeJsonAtomic });
    }));
    stdout.write(`mc: ${project} amended — still blocked; release separately with mc step ready\nauthorization: ${auditPath}\n`);
    return 0;
  } catch (error) {
    stderr.write(`mc: ${error.message}\n`);
    return 1;
  }
}
