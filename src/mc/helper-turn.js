/**
 * `mc helper` — the model half: one headless turn that reads the digest and
 * writes proposals, and nothing else.
 *
 * The collect step (`helper-collect.js`) gathers what production is saying
 * into `~/mc/intake/errors-<date>.md` without a model. This is the turn that
 * reads it: a fresh, headless session with the `helper` role from
 * `canon/roles/helper.md`, standing in `~/mc/intake/`, whose only output is
 * zero or more `~/mc/intake/proposals/<date>-<slug>.md`.
 *
 * Everything the turn judges from is in its prompt — the digest, the project
 * log, every PLAN.md on main with its status and `next:`, and the proposals
 * already waiting. It is given the material rather than sent to find it: the
 * repositories are elsewhere on the disk, and a turn that cannot reach them
 * cannot accidentally write in them either. What it may write is one
 * directory, and the role says so in the same words as this comment.
 *
 * A proposal is not a plan and not a queue entry. Martin moves it into
 * `queue.md` at the next brief, or drops it; `mc brief --collect` lists what
 * is waiting. That is why the file has a fixed frontmatter — the brief has
 * to be able to say what kind of thing each one is without a model.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { resolveLaunch } from '../adapters/index.js';
import { defaultRepos, planFields, scanProposals } from './brief-collect.js';
import { intakeDir, proposalsDir } from './helper-collect.js';
import { loadProfile, profileArgs } from './portrait.js';
import { readCanonRole } from './roles.js';
import { headlessArgs, readSessionOutput, TIMEOUT_EXIT } from './run-plan.js';

/** One turn over one digest. Ten minutes is four times the longest measured. */
export const DEFAULT_TURN_MINUTES = 10;

/** The project log the turn is given, if the repository that keeps one is here. */
export const PROJECT_LOG = join('docs', 'project', 'project_log.md');

/* ------------------------------------------------------------------ prompt */

const clip = (text, max = 110) => {
  const one = String(text || '').replace(/\s+/gu, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

/**
 * What the turn is told. The digest whole — it is the evidence, and clipping
 * it would make the turn guess — then the ground it judges against: what is
 * already planned, what was already closed, and what is already proposed.
 */
export function helperPrompt({ digestPath, digestText, proposalsPath = proposalsDir(), projectLog = null, plans = [], proposals = [], now = new Date() }) {
  const date = now.toISOString().slice(0, 10);
  const out = [
    `Today is ${date}. Below is today's digest, \`${digestPath}\`, and the ground to judge it against.`,
    'Decide what — if anything — is worth doing about it, and write the proposals your role describes',
    `into \`${proposalsPath}\`, named \`${date}-<slug>.md\`. Write no file at all if nothing warrants one,`,
    'and say in one line what you decided either way. Then stop.',
    '',
    '----- DIGEST -----',
    digestText,
    '',
    '----- PLANS ON MAIN -----',
  ];
  if (!plans.length) out.push('_none read_');
  else {
    out.push('| repo | programme / project | status | next |', '|---|---|---|---|');
    for (const p of plans) out.push(`| ${p.repo} | ${p.programme} / ${p.project} | ${p.status || '?'} | ${clip(p.next || '—')} |`);
  }
  out.push('', '----- PROJECT LOG (closed projects) -----', projectLog || '_none read_');
  out.push('', '----- PROPOSALS ALREADY WAITING -----');
  if (!proposals.length) out.push('_none_');
  else for (const p of proposals) out.push(`- ${p.file} — ${clip(p.title, 90)}`);
  return out.join('\n');
}

/* -------------------------------------------------------------------- turn */

function realSession({ bin, args, cwd, timeoutMs, env }) {
  return new Promise((resolve) => {
    execFile(bin, args, { cwd, env, encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGTERM', maxBuffer: 64 << 20 }, (error, stdout, stderr) => {
      const timedOut = error?.killed === true || error?.signal === 'SIGTERM';
      resolve({
        status: timedOut ? TIMEOUT_EXIT : (error?.code ?? 0),
        stdout: stdout || '',
        stderr: stderr || (error && !timedOut ? String(error.message) : ''),
        timedOut,
      });
    });
  });
}

function realGit(cwd, args) {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 20_000 }, (error, stdout) => resolve(error ? null : stdout.trimEnd()));
  });
}

/**
 * The ground the turn judges the digest against, read from the two main
 * checkouts on origin/main. A repository that is not here is simply absent —
 * the turn is told what it was given, never that a list is complete.
 */
export async function helperGround({ env = process.env, repos = defaultRepos(env), git = realGit } = {}) {
  const present = repos.filter((repo) => existsSync(join(repo.path, '.git')));
  await Promise.all(present.map((repo) => git(repo.path, ['fetch', '-q', 'origin'])));
  const plans = [];
  const notes = [];
  for (const repo of present) {
    const listed = await listPlansOnMain(repo, git);
    if (listed === null) notes.push(`${repo.name}: could not list plans on origin/main`);
    else plans.push(...listed);
  }
  let projectLog = null;
  for (const repo of present) {
    const text = await git(repo.path, ['show', `origin/main:${PROJECT_LOG}`]);
    if (text) projectLog = projectLog ? `${projectLog}\n\n${text}` : text;
  }
  if (!projectLog) notes.push(`no ${PROJECT_LOG} on origin/main in ${present.map((r) => r.name).join(', ') || 'any checkout'}`);
  return { plans, projectLog, notes };
}

/**
 * `listPlans` in brief-collect.js reads the same trees with a synchronous
 * git; the helper's git is async so the two checkouts are read side by side,
 * which is the whole reason this walks the tree itself.
 */
async function listPlansOnMain(repo, git) {
  const tree = await git(repo.path, ['ls-tree', '-r', '--name-only', 'origin/main', '--', 'docs/project']);
  if (tree == null) return null;
  const paths = tree.split('\n').filter((path) => {
    const parts = path.split('/');
    return parts.length === 5 && parts[4] === 'PLAN.md';
  });
  const texts = await Promise.all(paths.map((path) => git(repo.path, ['show', `origin/main:${path}`])));
  return paths.map((path, i) => {
    const parts = path.split('/');
    const fields = planFields(texts[i] || '');
    return {
      repo: repo.name, programme: parts[2], project: parts[3], path,
      status: fields.status ?? null, next: fields.next ?? null,
    };
  });
}

/**
 * Run the turn over a digest. Returns what happened, never throws: a missing
 * role, a missing tool and a session that failed are all outcomes the caller
 * prints, because the runner logs this the same way it logs a step.
 *
 * `wrote` is measured, not claimed — the proposals directory before and
 * after. A turn that said it wrote a file and did not is reported as having
 * written none.
 */
export async function runHelperTurn({
  env = process.env,
  now = new Date(),
  digestPath,
  digestText,
  model = null,
  minutes = DEFAULT_TURN_MINUTES,
  deps = {},
} = {}) {
  const role = (deps.role || readCanonRole)('helper');
  if (!role?.overlay) {
    return { ok: false, reason: 'no-role', note: 'canon/roles/helper.md is missing from this install' };
  }
  const launch = (deps.launch || resolveLaunch)(role.tools?.[0] || 'claude');
  if (!launch?.ok) {
    return { ok: false, reason: 'no-tool', note: launch?.hint || launch?.reason || 'no tool to run the turn' };
  }

  const dir = intakeDir(env);
  const proposals = proposalsDir(env);
  mkdirSync(proposals, { recursive: true });
  const before = new Set((deps.list || scanProposals)(proposals).map((p) => p.file));

  const ground = await (deps.ground || helperGround)({ env });
  const prompt = helperPrompt({
    digestPath, digestText, proposalsPath: proposals, projectLog: ground.projectLog, plans: ground.plans,
    proposals: [...before].map((file) => ({ file, title: '' })), now,
  });
  const instructions = [await (deps.profile || (() => loadProfile({ env })))(), role.overlay].filter(Boolean).join('\n\n---\n\n');
  const args = headlessArgs({
    toolId: launch.id, adapter: launch.adapter, model: model || role.model, instructions, prompt, profileArgs,
  });

  const result = await (deps.session || realSession)({
    bin: launch.spec.bin, args, cwd: dir, timeoutMs: minutes * 60_000, env,
  });
  const read = readSessionOutput({
    toolId: launch.id, stdout: result.stdout, stderr: result.stderr, exitCode: result.status, timedOut: result.timedOut,
  });
  const after = (deps.list || scanProposals)(proposals);
  const wrote = after.filter((p) => !before.has(p.file));
  return {
    ok: result.status === 0 && !result.timedOut,
    status: result.status,
    note: read.note,
    quota: read.quota,
    turns: read.turns,
    session: read.session,
    stdout: result.stdout,
    stderr: result.stderr,
    model: model || role.model,
    tool: launch.shortName || launch.id,
    wrote,
    waiting: after,
    groundNotes: ground.notes || [],
  };
}
