/** Self-contained Git recovery bundles made without mutating source repositories. */
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function git(args, { cwd, env, allowFailure = false } = {}) {
  const result = spawnSync('git', args, { cwd, env, encoding: 'buffer', timeout: 120_000, maxBuffer: 128 << 20 });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr.toString().trim()}`);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function output(args, options) { return git(args, options).stdout.toString('utf8').trim(); }

function repositoryIdentity(cwd, env) {
  const remotes = output(['remote'], { cwd, env }).split(/\r?\n/u).filter(Boolean);
  if (remotes.some((name) => name !== 'origin')) throw new Error(`repository ${cwd} has undeclared remotes; backup refuses to export remote configuration`);
  const origin = remotes.includes('origin') ? output(['remote', 'get-url', 'origin'], { cwd, env }) : null;
  const configuredFormat = git(['config', '--get', 'extensions.objectFormat'], { cwd, env, allowFailure: true });
  const objectFormat = configuredFormat.status === 0 ? configuredFormat.stdout.toString('utf8').trim() : 'sha1';
  if (objectFormat !== 'sha1' && objectFormat !== 'sha256') throw new Error(`unsupported Git object format ${objectFormat} in ${cwd}`);
  const repoName = basename(resolve(cwd));
  const normalizedOrigin = origin?.replace(/^git@github\.com:/u, 'https://github.com/').replace(/\.git$/u, '').replace(/\/$/u, '') ?? null;
  return { name: repoName, origin: normalizedOrigin, object_format: objectFormat };
}

/**
 * Pin every source ref, reflog tip, stash and index-stage object in an isolated
 * bare export repository, then emit a self-contained bundle. The source object
 * database is only an alternate and is never given a synthetic ref or index.
 */
export function exportRepository(repository, { env = process.env, run = git } = {}) {
  const cwd = repository.pathOnDisk;
  const isolated = mkdtempSync(join(tmpdir(), 'mc-backup-git-'));
  const exportRepo = join(isolated, 'export.git');
  const bundlePath = join(isolated, 'recovery.bundle');
  const privateHome = join(isolated, 'home');
  mkdirSync(privateHome, { mode: 0o700 });
  const cleanEnv = { ...env, HOME: privateHome, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
  try {
    const gitDir = output(['rev-parse', '--absolute-git-dir'], { cwd, env: cleanEnv });
    const commonDir = output(['rev-parse', '--git-common-dir'], { cwd, env: cleanEnv });
    const objectDir = resolve(cwd, commonDir, 'objects');
    const identity = repositoryIdentity(cwd, cleanEnv);
    const head = output(['rev-parse', '--verify', 'HEAD'], { cwd, env: cleanEnv });
    const symbolic = git(['symbolic-ref', '-q', 'HEAD'], { cwd, env: cleanEnv, allowFailure: true });
    const headRef = symbolic.status === 0 ? symbolic.stdout.toString('utf8').trim() : null;
    const refs = output(['for-each-ref', '--format=%(refname) %(objectname)'], { cwd, env: cleanEnv })
      .split(/\r?\n/u).filter(Boolean).map((line) => {
        const split = line.indexOf(' ');
        return { name: line.slice(0, split), oid: line.slice(split + 1) };
      });
    const reflogs = output(['reflog', 'show', '--all', '--format=%H'], { cwd, env: cleanEnv })
      .split(/\r?\n/u).filter(Boolean);
    const stageRows = git(['ls-files', '--stage', '-z'], { cwd, env: cleanEnv }).stdout.toString('utf8').split('\0').filter(Boolean);
    const stageOids = stageRows.map((row) => row.match(/^\d+ ([0-9a-f]+) \d+\t/u)?.[1]).filter(Boolean);
    const sourceIndex = readFileSync(join(gitDir, 'index'));
    const initialStatus = output(['status', '--porcelain=v2', '--untracked-files=all'], { cwd, env: cleanEnv });
    if (initialStatus) throw new Error(`repository ${repository.path} has working/index changes; normalized index and worktree-state capture is not yet available`);

    run(['init', '--bare', '--object-format', identity.object_format, exportRepo], { cwd: isolated, env: cleanEnv });
    const exportObjects = join(exportRepo, 'objects');
    mkdirSync(join(exportObjects, 'info'), { recursive: true });
    writeFileSync(join(exportObjects, 'info', 'alternates'), `${objectDir}\n`, { mode: 0o600 });
    const pin = (name, oid) => run(['--git-dir', exportRepo, 'update-ref', name, oid], { cwd: isolated, env: cleanEnv });
    for (const ref of refs) pin(ref.name, ref.oid);
    if (headRef) pin(`refs/archive/worktree-head/${sha256(Buffer.from(repository.path)).slice(0, 16)}`, head);
    else pin(`refs/archive/detached-head/${sha256(Buffer.from(repository.path)).slice(0, 16)}`, head);
    reflogs.forEach((oid, index) => pin(`refs/archive/reflog/${String(index).padStart(6, '0')}`, oid));
    stageOids.forEach((oid, index) => pin(`refs/archive/index/${String(index).padStart(6, '0')}`, oid));
    run(['--git-dir', exportRepo, 'bundle', 'create', bundlePath, '--all'], { cwd: isolated, env: cleanEnv });
    const bundle = readFileSync(bundlePath);
    run(['--git-dir', exportRepo, 'bundle', 'verify', bundlePath], { cwd: isolated, env: cleanEnv });
    const status = output(['status', '--porcelain=v2', '--untracked-files=all'], { cwd, env: cleanEnv });
    const finalHead = output(['rev-parse', '--verify', 'HEAD'], { cwd, env: cleanEnv });
    const finalRefs = output(['for-each-ref', '--format=%(refname) %(objectname)'], { cwd, env: cleanEnv });
    const finalReflogs = output(['reflog', 'show', '--all', '--format=%H'], { cwd, env: cleanEnv });
    const finalIndex = readFileSync(join(gitDir, 'index'));
    if (status || finalHead !== head || finalRefs !== refs.map(({ name, oid }) => `${name} ${oid}`).join('\n')
      || finalReflogs !== reflogs.join('\n') || !finalIndex.equals(sourceIndex)) {
      throw new Error(`repository ${repository.path} changed during Git bundle capture`);
    }
    return {
      bundle: { repository: repository.path, bytes: bundle },
      record: {
        path: repository.path,
        kind: repository.kind,
        identity,
        head: { oid: head, ref: headRef, detached: headRef === null },
        refs,
        recovery: { reflog_objects: reflogs, index_stage_objects: stageOids },
        source_index_sha256: sha256(sourceIndex),
        worktree_status: 'clean',
      },
    };
  } finally {
    rmSync(isolated, { recursive: true, force: true });
  }
}

/** Stable repository descriptor key for callers that need to assert source identity. */
export function repositoryPathKey(repository) { return `${repository.path}\0${repository.kind}`; }
