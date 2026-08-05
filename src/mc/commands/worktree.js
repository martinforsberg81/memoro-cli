/**
 * `mc worktree add <session> <branch> [--repo <path>] [--from <ref>]`
 * `mc worktree list <session>`
 *
 * The verb mc never had. Sessions accumulated worktrees and branches created
 * by hand, in a layout keyed on repository and session name, and nothing
 * connected them back — which is the sprawl `mc worktrees` now measures.
 *
 * A worktree created here lands at `<mc home>/worktrees/<mc session id>/<name>`,
 * is recorded as a resource this session owns with a creation receipt, and is
 * associated as one of the session's workspaces. Ownership is structural: the
 * session id is the directory. `mc end` releases what carries a receipt.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import { mcHome, sessionWorktreePath } from '../paths.js';
import {
  createOwnedResourceIntentSync,
  listOwnedResourcesSync,
  observeGitWorktreeFingerprintSync,
  recordOwnedResourceCreationSync,
} from '../owned-resource.js';
import { resolveRepositoryIdentity } from '../repository-identity.js';
import { associateLocalWorkspaceSync, resolveLocalSessionSync } from '../session-v1.js';

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const opts = parseArgs(argv);
  if (opts.error) {
    stderr.write(`mc: ${opts.error}\n`);
    stderr.write('usage — mc worktree add <session> <branch> [--repo <path>] [--from <ref>]\n');
    stderr.write('        mc worktree list <session>\n');
    return 2;
  }
  const mcHomeDir = deps.mcHomeDir || mcHome();
  const resolved = (deps.resolveLocalSession || resolveLocalSessionSync)(opts.session, { mcHomeDir });
  if (!resolved.ok) {
    stderr.write(`mc: local session "${opts.session}" was not found (${resolved.reason})\n`);
    return 1;
  }
  const mcSessionId = resolved.session.mc_session_id;

  if (opts.verb === 'list') {
    const owned = listOwnedResourcesSync({ mcHomeDir, mcSessionId });
    const worktrees = (owned.resources || [])
      .filter((item) => item.intent.resource_kind === 'git-worktree');
    if (opts.json) {
      stdout.write(`${JSON.stringify({ ok: true, worktrees }, null, 2)}\n`);
      return 0;
    }
    stdout.write(`${opts.session}: ${worktrees.length} worktree${worktrees.length === 1 ? '' : 's'} owned by this session\n`);
    for (const item of worktrees) {
      const released = item.cleanup_receipt ? ' (released)' : '';
      stdout.write(`  ${item.intent.target.path}${released}\n`);
    }
    return 0;
  }

  const repo = resolve(opts.repo || process.cwd());
  const common = gitOutput(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!common) {
    stderr.write(`mc: ${repo} is not a Git repository\n`);
    return 1;
  }
  const identity = (deps.resolveRepositoryIdentity || resolveRepositoryIdentity)(repo);
  if (!identity?.ok) {
    stderr.write(`mc: could not identify the repository at ${repo} (${identity?.reason || 'unknown'})\n`);
    return 1;
  }
  // Git gives a worktree its own git directory at `<common>/worktrees/<name>`,
  // and that — not the repository's common directory — is what release
  // observes later. Recording the common one made every receipt disagree with
  // the thing it was supposed to prove, so nothing could ever be released.
  const worktreeGitDir = join(common, 'worktrees', opts.name);
  const path = sessionWorktreePath(mcSessionId, opts.name, mcHomeDir);
  if (existsSync(path)) {
    stderr.write(`mc: ${path} already exists\n`);
    return 1;
  }

  // The intent is written before the worktree exists, so an interrupted
  // create leaves a record of what was attempted rather than an orphan.
  const created = (deps.createIntent || createOwnedResourceIntentSync)({
    mcHomeDir,
    mcSessionId,
    resourceKind: 'git-worktree',
    target: {
      path,
      repository_identity: identity.canonical || identity.repository_identity,
      git_dir: worktreeGitDir,
      branch: opts.branch,
    },
  });

  try {
    mkdirSync(sessionWorktreePath(mcSessionId, '', mcHomeDir), { recursive: true, mode: 0o700 });
    const args = ['-C', repo, 'worktree', 'add'];
    if (opts.from) args.push('-b', opts.branch, path, opts.from);
    else args.push('-b', opts.branch, path);
    execFileSync('git', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    stderr.write(`mc: could not create the worktree (${firstLine(error)})\n`);
    return 1;
  }

  try {
    (deps.recordCreation || recordOwnedResourceCreationSync)({
      mcHomeDir,
      mcSessionId,
      resourceId: created.intent.resource_id,
      // A worktree is observed as one: its path, the repository it belongs to,
      // and the git directory that backs it. The receipt binds those three, so
      // release later revalidates the exact thing that was created.
      observeResource: ({ intent: recorded, currentPath }) => observeGitWorktreeFingerprintSync({
        path: currentPath || recorded.target.path,
        repositoryIdentity: recorded.target.repository_identity,
        gitDir: recorded.target.git_dir,
      }),
    });
  } catch (error) {
    stderr.write(`mc: worktree created at ${path}, but its receipt was not recorded (${error?.reason || error?.message || 'unknown'})\n`);
    stderr.write('mc: it will not be released by mc end until that is repaired\n');
    return 1;
  }

  // The branch is its own owned resource: it belongs to this worktree and this
  // session, and nothing else. Registered after the worktree so release takes
  // them in that order — git refuses to delete a branch that is checked out.
  try {
    const branchIntent = (deps.createIntent || createOwnedResourceIntentSync)({
      mcHomeDir,
      mcSessionId,
      resourceKind: 'git-branch',
      target: {
        repository_identity: identity.canonical || identity.repository_identity,
        git_common_dir: common,
        ref: `refs/heads/${opts.branch}`,
      },
    });
    (deps.recordCreation || recordOwnedResourceCreationSync)({
      mcHomeDir,
      mcSessionId,
      resourceId: branchIntent.intent.resource_id,
      observeResource: ({ intent: recorded }) => ({
        kind: 'git-ref',
        repository_identity: recorded.target.repository_identity,
        git_common_dir: recorded.target.git_common_dir,
        ref: recorded.target.ref,
        ref_oid: gitOutput(repo, ['rev-parse', '--verify', recorded.target.ref]),
      }),
    });
  } catch (error) {
    stderr.write(`mc: the branch was not recorded as owned (${error?.reason || error?.message || 'unknown'})\n`);
    stderr.write('mc: mc end will release the worktree but leave the branch\n');
  }

  try {
    (deps.associateWorkspace || associateLocalWorkspaceSync)({
      mcHomeDir,
      session: resolved.session,
      cwd: path,
      preferredLaunch: false,
    });
  } catch { /* the worktree exists and is owned; the association can be added later */ }

  if (opts.json) {
    stdout.write(`${JSON.stringify({ ok: true, path, branch: opts.branch, resource_id: created.intent.resource_id }, null, 2)}\n`);
  } else {
    stdout.write(`mc: added ${path}\n`);
    stdout.write(`mc: branch ${opts.branch}, owned by ${opts.session}\n`);
  }
  return 0;
}

export function parseArgs(argv) {
  const opts = {
    verb: null, session: null, branch: null, name: null,
    repo: null, from: null, json: false,
  };
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') { opts.json = true; continue; }
    if (arg === '--repo' || arg === '--from') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) return { ...opts, error: `${arg} needs a value` };
      opts[arg === '--repo' ? 'repo' : 'from'] = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('--')) return { ...opts, error: `unknown flag: ${arg}` };
    positional.push(arg);
  }
  opts.verb = positional[0] || null;
  if (!['add', 'list'].includes(opts.verb)) return { ...opts, error: 'expected `add` or `list`' };
  opts.session = positional[1] || null;
  if (!opts.session) return { ...opts, error: 'a session name is required' };
  if (opts.verb === 'add') {
    opts.branch = positional[2] || null;
    if (!opts.branch) return { ...opts, error: 'a branch name is required' };
    opts.name = basename(opts.branch);
    if (!/^[A-Za-z0-9._-]{1,64}$/u.test(opts.name)) {
      return { ...opts, error: `cannot use "${opts.branch}" as a directory name` };
    }
  }
  return opts;
}

function gitOutput(cwd, args) {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch { return null; }
}

function firstLine(error) {
  const text = error?.stderr?.toString?.() || error?.message || String(error);
  return text.split('\n').find(Boolean)?.slice(0, 200) || 'unknown';
}
