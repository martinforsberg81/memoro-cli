/**
 * `mc helper --intake` — the model half: one headless turn that reads **one
 * file** from the inbox and writes a proposal or nothing, and nothing else.
 *
 * `~/mc/intake/` is an inbox. The collect step (`helper-collect.js`) puts one
 * digest a day per repository in it without a model, and Martin puts whatever
 * he has in it by hand. This is the turn that empties it one file at a time: a
 * fresh, headless session with the `intake` role from `canon/roles/intake.md`,
 * standing in `~/mc/intake/`, given one filename and asked for one outcome —
 * one `~/mc/proposals/<date>-<slug>.md`, or none.
 *
 * The bare `mc helper` is the other half of the verb and is not here: it is a
 * session with Martin in it, taking his own reports (`commands/helper.js`).
 * Both write into the same `proposals/`, and neither reads the other.
 *
 * The file is **named**, not inlined. Everything else the turn judges against
 * is in the prompt — the project log, every plan on main with the step it is
 * on, and the proposals already waiting — because the repositories are
 * elsewhere on the disk and a turn that cannot reach them cannot accidentally
 * write in them either. The file itself is the exception, and it has to be:
 * a screenshot has no text to inline, and the inbox is defined by Martin being
 * able to drop anything in it. It is in the directory the turn stands in, so
 * naming it is enough. What it may write is one directory, and the role says
 * so in the same words as this comment.
 *
 * A proposal is not a plan and not a queue entry. Martin moves it into
 * `queue.md` at the next brief, or drops it; `mc brief --collect` lists what
 * is waiting. That is why the file has a fixed frontmatter — the brief has
 * to be able to say what kind of thing each one is without a model.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';

import { resolveLaunch } from '../adapters/index.js';
import { defaultRepos, listProposals, planFields } from './brief-collect.js';
import { intakeDir, proposalsDir } from './helper-collect.js';
import { loadProfile, profileArgs } from './portrait.js';
import { instructionsFor, readCanonRole } from './roles.js';
import { headlessArgs, readSessionOutput, TIMEOUT_EXIT } from './run-plan.js';

/** One turn over one file. Ten minutes is four times the longest measured. */
export const DEFAULT_TURN_MINUTES = 10;

/**
 * The role this turn wears. It is `intake`, not `helper`: `helper` is the
 * session Martin sits in, and one name for two different jobs is how a role
 * file ends up trying to be both.
 */
export const INTAKE_ROLE = 'intake';

/** The project log the turn is given, if the repository that keeps one is here. */
export const PROJECT_LOG = join('docs', 'project', 'project_log.md');

/* ------------------------------------------------------------------ prompt */

const clip = (text, max = 110) => {
  const one = String(text || '').replace(/\s+/gu, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

/**
 * Which system a file in the inbox belongs to, when its name says so. The
 * collector's own digests do — `errors-<repo>-<date>.md`, and the unprefixed
 * `errors-<date>.md` from before memoro-cli had a digest of its own. Anything
 * a person dropped in does not, and gets `null`: the turn decides that one
 * from what it reads, which is the only reader that can.
 */
export function repoOfFile(file) {
  const name = basename(String(file || ''));
  const match = /^errors-(memoro-cli|memoro)-\d{4}-\d{2}-\d{2}\.md$/u.exec(name);
  if (match) return match[1];
  return /^errors-\d{4}-\d{2}-\d{2}\.md$/u.test(name) ? 'memoro' : null;
}

/**
 * What the turn is told: the name of the one file that is its business, and
 * the ground to judge it against — what is already planned, what was already
 * closed, and what is already proposed.
 *
 * The file is named rather than inlined. It sits in the directory the turn
 * stands in, so a name is enough to open it, and it is the only form that
 * works for a file that is not text.
 */
export function helperPrompt({ file, proposalsPath = proposalsDir(), projectLog = null, plans = [], proposals = [], repo = null, now = new Date() }) {
  const date = now.toISOString().slice(0, 10);
  const name = basename(String(file || ''));
  // `repo:` is the frontmatter key everything downstream routes on. A turn
  // left to infer it from a digest's contents would get it right most days,
  // and the days it did not would be a proposal filed against the wrong
  // system — so a file whose name says which repository it is keeps saying so.
  const known = repo || repoOfFile(name);
  const out = [
    `Today is ${date}. One file in the directory you are standing in is yours this turn:`,
    '',
    `    ${name}`,
    '',
    'Read it — yourself, and whole — and decide what, if anything, is worth doing about it.',
    'The ground to judge it against is below: what is already planned, what was already closed,',
    'and what is already proposed.',
    '',
  ];
  if (known) {
    out.push(`It is **${known}**'s, so a proposal you write about it has \`repo: ${known}\` in its frontmatter.`);
    out.push(known === 'memoro-cli'
      ? 'memoro-cli has no server: its production is this machine — mc itself, its runner, its verbs and the logs it keeps about its own rounds.'
      : 'memoro\'s production is the deployed service.');
  } else {
    out.push('Nothing in that name says which system the file belongs to, so decide it from what you read and say which',
      'in the proposal: `memoro` is the deployed service, `memoro-cli` is mc itself on this machine.');
  }
  out.push(
    '',
    `One file, one outcome: either **one** proposal in \`${proposalsPath}\`, named \`${date}-<slug>.md\`,`,
    'or none at all. Not two from one file — one report is one proposal — and no proposal is the right',
    'answer whenever the file does not warrant one. Say in one line which you did and why, then stop.',
    '',
    'If you cannot read the file whole — it is past your tool\'s read limit, or in a form you cannot open —',
    'say so rather than judging it from its head: either a proposal that names the limit, or no proposal',
    'with that as the reason in your line.',
    '',
    '----- PLANS ON MAIN -----',
  );
  if (!plans.length) out.push('_none read_');
  else {
    out.push('| repo | programme / project | status | next |', '|---|---|---|---|');
    for (const p of plans) out.push(`| ${p.repo} | ${p.programme} / ${p.project} | ${p.status || '?'} | ${clip(p.next || '—')} |`);
  }
  out.push('', '----- PROJECT LOG (closed projects) -----', projectLog || '_none read_');
  out.push('', '----- PROPOSALS ALREADY WAITING -----');
  if (!proposals.length) out.push('_none_');
  else for (const p of proposals) out.push(`- ${p.file}`);
  return out.join('\n');
}

/* -------------------------------------------------------------------- turn */

/** What the turn produced, in the one line a runner log and a person share. */
export function describeTurn({ wrote = [], waiting = [] }) {
  if (!wrote.length) return `no proposal — nothing in the file warranted one (${waiting.length} still waiting)`;
  return `${wrote.length} proposal${wrote.length === 1 ? '' : 's'}, ${waiting.length} waiting`;
}

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
 * Run the turn over one file in the inbox. `file` is that file — a path or a
 * bare name; only the name reaches the prompt, because the turn stands in the
 * directory it is in. Returns what happened, never throws: a missing role, a
 * missing tool and a session that failed are all outcomes the caller prints,
 * because the runner logs this the same way it logs a step.
 *
 * `wrote` is measured, not claimed — the proposals directory before and
 * after. A turn that said it wrote a file and did not is reported as having
 * written none.
 */
export async function runHelperTurn({
  env = process.env,
  now = new Date(),
  file,
  model = null,
  // Null means the name decides, and if the name does not say, the turn does.
  repo = null,
  minutes = DEFAULT_TURN_MINUTES,
  deps = {},
} = {}) {
  const role = (deps.role || readCanonRole)(INTAKE_ROLE);
  if (!role?.overlay) {
    return { ok: false, reason: 'no-role', note: `canon/roles/${INTAKE_ROLE}.md is missing from this install` };
  }
  const launch = (deps.launch || resolveLaunch)(role.tools?.[0] || 'claude');
  if (!launch?.ok) {
    return { ok: false, reason: 'no-tool', note: launch?.hint || launch?.reason || 'no tool to run the turn' };
  }

  const dir = intakeDir(env);
  const proposals = proposalsDir(env);
  mkdirSync(proposals, { recursive: true });
  const before = new Set((deps.list || listProposals)(proposals).map((p) => p.file));

  const ground = await (deps.ground || helperGround)({ env });
  const prompt = helperPrompt({
    file, proposalsPath: proposals, projectLog: ground.projectLog, plans: ground.plans,
    proposals: [...before].map((name) => ({ file: name, title: '' })), repo, now,
  });
  const profile = await (deps.profile || (() => loadProfile({ env })))();
  const instructions = instructionsFor(launch.id, profile, role.overlay);
  const args = headlessArgs({
    toolId: launch.id, adapter: launch.adapter, model: model || role.model, instructions, prompt, profileArgs,
  });

  const result = await (deps.session || realSession)({
    bin: launch.spec.bin, args, cwd: dir, timeoutMs: minutes * 60_000, env,
  });
  const read = readSessionOutput({
    toolId: launch.id, stdout: result.stdout, stderr: result.stderr, exitCode: result.status, timedOut: result.timedOut,
  });
  const after = (deps.list || listProposals)(proposals);
  const wrote = after.filter((p) => !before.has(p.file));
  return {
    ok: result.status === 0 && !result.timedOut,
    status: result.status,
    note: read.note,
    quota: read.quota,
    turns: read.turns,
    session: read.session,
    // What it cost, in the same columns runs.tsv keeps for a step: the daily
    // turn is a model call the page's day line should be able to price.
    input: read.input,
    output: read.output,
    cacheRead: read.cacheRead,
    cacheWrite: read.cacheWrite,
    stdout: result.stdout,
    stderr: result.stderr,
    model: model || role.model,
    tool: launch.shortName || launch.id,
    wrote,
    waiting: after,
    groundNotes: ground.notes || [],
  };
}
