/** Self-contained Git recovery bundles made without mutating source repositories. */
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
    const sourceIndex = readFileSync(join(gitDir, 'index'));
    const initialStatus = output(['status', '--porcelain=v2', '--untracked-files=all'], { cwd, env: cleanEnv });
    const indexCopy = join(isolated, 'index.v2');
    writeFileSync(indexCopy, sourceIndex, { mode: 0o600 });
    for (const name of readdirSync(gitDir).filter((item) => /^sharedindex\.[a-f0-9]+$/u.test(item))) {
      writeFileSync(join(isolated, name), readFileSync(join(gitDir, name)), { mode: 0o600 });
    }
    const indexEnv = { ...cleanEnv, GIT_INDEX_FILE: indexCopy, GIT_OPTIONAL_LOCKS: '0' };
    git(['update-index', '--no-split-index', '--no-untracked-cache', '--no-fsmonitor', '--index-version=2'], { cwd, env: indexEnv });
    const normalizedIndex = readFileSync(indexCopy);
    const stageRows = git(['ls-files', '--stage', '-z'], { cwd, env: indexEnv }).stdout.toString('utf8').split('\0').filter(Boolean);
    const stages = stageRows.map((row) => {
      const match = /^(\d+) ([0-9a-f]+) (\d+)\t([\s\S]*)$/u.exec(row);
      if (!match) throw new Error(`unparseable Git index stage record in ${repository.path}`);
      return { mode: Number.parseInt(match[1], 8), oid: match[2], stage: Number(match[3]), path: match[4] };
    });
    const flagRows = (args) => git(['ls-files', ...args, '-z'], { cwd, env: indexEnv }).stdout.toString('utf8').split('\0').filter(Boolean);
    const assume = new Set(flagRows(['-v']).filter((row) => /^[a-z] /u.test(row)).map((row) => row.slice(2)));
    const skip = new Set(flagRows(['-t']).filter((row) => /^S /u.test(row)).map((row) => row.slice(2)));
    const trackedPaths = [...new Set(stages.map(({ path }) => path))].sort();
    const intentToAdd = new Set(stages.filter((entry) => /^0+$/u.test(entry.oid)).map(({ path }) => path));
    const flags = [...new Set([...assume, ...skip, ...intentToAdd])].sort().map((path) => ({
      path, assume_unchanged: assume.has(path), skip_worktree: skip.has(path),
      intent_to_add: intentToAdd.has(path),
    }));
    const stageOids = stages.map(({ oid }) => oid).filter((oid) => !/^0+$/u.test(oid));

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
    if (status !== initialStatus || finalHead !== head || finalRefs !== refs.map(({ name, oid }) => `${name} ${oid}`).join('\n')
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
        index: {
          format: 2,
          sha256: sha256(normalizedIndex),
          payload_base64: normalizedIndex.toString('base64'),
          stages,
          semantic_flags: flags,
          unstaged_status_porcelain_v2: initialStatus,
          tracked_paths: trackedPaths,
        },
        source_index_sha256: sha256(sourceIndex),
        worktree_status: initialStatus ? 'dirty-captured' : 'clean',
      },
    };
  } finally {
    rmSync(isolated, { recursive: true, force: true });
  }
}

/** Stable repository descriptor key for callers that need to assert source identity. */
export function repositoryPathKey(repository) { return `${repository.path}\0${repository.kind}`; }
