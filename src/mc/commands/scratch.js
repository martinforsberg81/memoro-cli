/**
 * `mc scratch` — a source export in the runner session's scratch directory
 * (scratch.js; docs/technical/mc-tidy.md, "Registered source exports").
 *
 *   mc scratch export --repo <repo> --ref <ref> --path <path>… [--attach-deps <dir>] [--json]
 *   mc scratch release <id> [--apply] [--json]
 *   mc scratch sweep [--json]
 *
 * Every form needs `MC_SCRATCH`, the runner's own scratch directory for the
 * session. `sweep` is the runner's: it removes this session's own ready
 * exports once the session has ended, and nothing else.
 */
import { cwdsOfUser, processesStandingIn } from '../standing.js';
import { defaultRepos } from '../repos.js';
import { openFilesAmong } from '../tidy.js';
import { createExport, ownerOf, realGit, releaseExport, sweepSession } from '../scratch.js';
import { scanArgs } from './flags.js';
import { commandUsage } from '../command-help.js';

const refusal = (what) => (scanned) => (scanned.flags.repo && scanned.flags.ref && scanned.flags.path.length
  ? null : `${what} needs --repo, --ref and at least one --path`);

export const ROUTES = {
  export: {
    strictValues: ['--repo', '--ref', '--attach-deps'], repeatable: ['--path'], booleans: ['--json'],
    check: refusal('mc scratch export'),
  },
  release: {
    booleans: ['--apply', '--json'],
    check: ({ positional }) => (positional.length === 1 ? null : 'mc scratch release takes one export id'),
  },
  sweep: {
    booleans: ['--json'],
    check: ({ positional }) => (positional.length ? 'mc scratch sweep takes no arguments' : null),
  },
};

export function usage() {
  return commandUsage('scratch');
}

/** Whether the export's tree is in use: the pids standing in it, or null when that cannot be said. */
function standingIn(path, { excludePid = process.pid } = {}) {
  let running;
  try { running = cwdsOfUser(); } catch { return null; }
  if (!running || running.length === 0 || running.complete === false) return null;
  return processesStandingIn([path], { cwds: running }).map((p) => p.pid).filter((pid) => pid !== excludePid);
}

/** The pids holding a file open in the tree, or null when lsof cannot say. */
function openIn(path) {
  const found = openFilesAmong([path]);
  return found ? found.get(path) ?? null : null;
}

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const env = deps.env || process.env;
  const [sub, ...rest] = argv;
  if (!sub || !Object.hasOwn(ROUTES, sub)) {
    stderr.write(`mc: ${sub ? `no scratch subcommand ${sub}` : 'mc scratch needs a subcommand'}\n`);
    stderr.write(usage());
    return 2;
  }
  const scanned = scanArgs(rest, ROUTES[sub]);
  const refused = scanned.error || ROUTES[sub].check(scanned);
  if (refused) {
    stderr.write(`mc: ${refused}\n`);
    stderr.write(usage());
    return 2;
  }
  const json = Boolean(scanned.flags.json);
  const repos = deps.repos || defaultRepos(env);
  const git = deps.git || realGit;
  try {
    if (sub === 'export') {
      const made = await createExport({
        scratch: env.MC_SCRATCH, env, repos, repoName: scanned.flags.repo, ref: scanned.flags.ref,
        paths: scanned.flags.path, attachDeps: scanned.flags['attach-deps'] || null, git, now: deps.now,
      });
      const r = made.receipt;
      const answer = {
        id: made.id, path: made.path, reused: made.reused, commit: r.commit, paths: r.paths,
        files: r.inventory.length, bytes: r.bytes, retained_ref: r.retained_ref, attachment: r.attachment ? r.attachment.target : null,
      };
      if (json) stdout.write(`${JSON.stringify(answer, null, 2)}\n`);
      else {
        stdout.write(`${made.reused ? 'reused' : 'exported'} ${made.path}\n`);
        stdout.write(`  ${r.commit} ${r.paths.join(' ')} — ${r.inventory.length} file(s), ${r.bytes} bytes\n`);
        if (answer.attachment) stdout.write(`  node_modules → ${answer.attachment} (recorded; never removed)\n`);
      }
      return 0;
    }
    if (sub === 'release') {
      const outcome = releaseExport({
        scratch: env.MC_SCRATCH, env, id: scanned.positional[0], apply: Boolean(scanned.flags.apply), git, repos,
        standing: standingIn, openIn, now: deps.now ?? Date.now(), excludePid: process.pid,
      });
      if (json) stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
      else if (!outcome.applied) {
        stdout.write(`${outcome.target ? 'would release' : 'kept'} ${outcome.path}\n  ${outcome.why}\n`);
        if (outcome.target && !scanned.flags.apply) stdout.write(`  preview saved beside its receipt — mc scratch release ${outcome.id} --apply removes it\n`);
      } else stdout.write(`released ${outcome.path}\n`);
      // A preview is an answer either way; an apply that removed nothing is not success.
      return scanned.flags.apply && !outcome.applied ? 1 : 0;
    }
    // sweep: the runner's end-of-session step. Its exit says whether it ran, never what was removed.
    const owner = ownerOf(env.MC_SCRATCH, env, { open: false });
    const answer = sweepSession({
      stemDir: owner.dir, env, git, repos, standing: standingIn, openIn, now: deps.now ?? Date.now(), excludePid: process.pid,
    });
    if (json) stdout.write(`${JSON.stringify(answer, null, 2)}\n`);
    else {
      for (const item of answer.removed) stdout.write(`released ${item.id}\n`);
      for (const item of answer.kept) stdout.write(`kept ${item.id}: ${item.why}\n`);
      if (!answer.removed.length && !answer.kept.length) stdout.write('no exports in this session\n');
    }
    return 0;
  } catch (error) {
    stderr.write(`mc: ${String(error?.message || error).split('\n')[0]}\n`);
    return 1;
  }
}
