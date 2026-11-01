/** Immutable local measurements. A receipt describes checks, not permission to
 * publish or merge. Limited runs never enter the merger's full-selection cache. */
import { createHash } from 'node:crypto';
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GATE_MEASUREMENT_VERSION, checksHash, fullCoverage, readGreenReceipt, recordGreen, selectionHash } from './gate-greens.js';
import { run as runGit } from './git.js';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Git's prospective commit tree plus raw worktree bytes, in a disposable
 * index. Ignored untracked files (dependencies, scratch output) are
 * deliberately excluded. */
export function captureWorktree(cwd) {
  const temp = mkdtempSync(join(tmpdir(), 'mc-gate-index-'));
  const index = join(temp, 'index');
  const git = (args, isolated = false, input) => {
    const env = { ...process.env };
    delete env.GIT_INDEX_FILE;
    if (isolated) {
      // A copied index's fsmonitor token and untracked cache are not trusted.
      Object.assign(env, { GIT_INDEX_FILE: index, GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'core.fsmonitor',
        GIT_CONFIG_VALUE_0: 'false', GIT_CONFIG_KEY_1: 'core.untrackedCache', GIT_CONFIG_VALUE_1: 'false' });
    }
    const run = runGit(cwd, args, { env, input, timeoutMs: 60_000, maxBuffer: 64 << 20 });
    if (run.error || run.status !== 0) throw new Error(`cannot fingerprint worktree: git ${args[0]} (${run.error?.code || run.status})`);
    return run.stdout;
  };
  try {
    const repository = realpathSync(git(['rev-parse', '--path-format=absolute', '--git-common-dir']).trim());
    const tracked = git(['ls-files', '--cached', '-z']);
    const untracked = git(['ls-files', '--others', '--exclude-standard', '-z']);
    // The real index's stat cache spares rehashing every file: from HEAD, a
    // 16k-file checkout took half a minute per fingerprint. Only a copy whose
    // every entry is ordinary: assume-unchanged, skip-worktree or unmerged
    // entries would hide bytes, so then the index starts from HEAD.
    let seeded = false;
    try {
      const real = git(['rev-parse', '--path-format=absolute', '--git-path', 'index']).trim();
      const { atimeMs, mtimeMs } = statSync(real);
      copyFileSync(real, index);
      // Git's racy-entry check compares against the index file's own mtime.
      utimesSync(index, atimeMs / 1000, mtimeMs / 1000);
      seeded = git(['ls-files', '-v', '-z'], true).split('\0').every((entry) => !entry || entry.startsWith('H '));
    } catch { seeded = false; }
    if (!seeded) {
      rmSync(index, { force: true });
      git(['read-tree', 'HEAD'], true);
      // Include staged additions even when .gitignore would now hide them. This
      // also refreshes skip-worktree/assume-unchanged entries from actual bytes.
      if (tracked) git(['add', '-A', '--force', '--pathspec-from-file=-', '--pathspec-file-nul'], true, tracked);
    }
    git(['add', '-A', '--', '.'], true);
    if (git(['ls-files', '--stage'], true).split('\n').some((line) => line.startsWith('160000 '))) {
      throw new Error('cannot fingerprint submodule worktree content');
    }
    const tree = git(['write-tree'], true).trim();
    const paths = [...new Set((tracked + untracked + git(['ls-files', '--cached', '-z'], true)).split('\0').filter(Boolean))].sort();
    const raw = paths.map((path) => {
      try {
        const stat = lstatSync(join(cwd, path));
        if (stat.isSymbolicLink()) return [path, 'symlink', hash(readlinkSync(join(cwd, path), { encoding: 'buffer' }))];
        if (!stat.isFile()) throw new Error(`cannot fingerprint non-file ${path}`);
        return [path, stat.mode & 0o111 ? 'executable' : 'file', hash(readFileSync(join(cwd, path)))];
      } catch (error) {
        // The tree records deletions. Raw missing-path markers would change
        // merely because committing removes those paths from the real index.
        if (error.code === 'ENOENT') return null;
        throw error;
      }
    }).filter(Boolean);
    return Object.freeze({ repository, tree, fingerprint: hash(JSON.stringify(raw)) });
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

export function sameContent(a, b) {
  return Boolean(a?.repository && a?.tree && a?.fingerprint
    && a.repository === b?.repository && a.tree === b?.tree && a.fingerprint === b?.fingerprint);
}

/** No running/unknown/empty/partially executed attempt can become green. */
export function gateReceipt({ measurement, before, after, result, started, ended }) {
  const coverage = result.coverage || null;
  const execution = result.execution || null;
  const tests = execution?.tests;
  const commands = execution?.commands || [];
  const complete = Boolean(coverage && (coverage.files.length || coverage.commands.length)
    && (!coverage.files.length || (tests?.exit === 0 && tests.finished === true
      && tests.totals?.tests > 0 && tests.totals?.pass > 0 && tests.totals?.fail === 0 && !tests.totals?.cancelled))
    && commands.length === coverage.commands.length
    && commands.every((command) => command.exit === 0 && command.ok === true && !command.error));
  const unchanged = sameContent(measurement.candidate, before) && sameContent(before, after);
  const valid = Boolean(measurement.repo && measurement.run && /^[0-9a-f]{40,64}$/u.test(measurement.base || '')
    && Number.isFinite(Date.parse(started)) && Date.parse(ended) >= Date.parse(started));
  const outcome = !unchanged ? 'invalid' : result.ok === true && result.code === 0 && complete && valid ? 'green'
    : result.code === 1 ? 'red' : 'incomplete';
  return freeze(JSON.parse(JSON.stringify({
    schema: 'mc-session-gate-evidence', version: 1, gate_version: GATE_MEASUREMENT_VERSION,
    repo: measurement.repo, repository: measurement.candidate.repository, run: measurement.run,
    session_run: measurement.session_run ?? null, goal_revision: measurement.goal_revision ?? null,
    configuration: measurement.configuration ?? null,
    base: measurement.base, tree: measurement.candidate.tree, fingerprint: measurement.candidate.fingerprint,
    started, ended, outcome, coverage, execution, exit: result.code ?? null,
    stopped_at: result.stopped_at ?? null,
  })));
}

/** Exclusive creation, with byte-identical retry only. There is no mutable
 * "latest green" receipt; cache entries only point back to completed receipts. */
export function persistGateReceipt({ root, receipt }) {
  if (!/^[a-zA-Z0-9-]+$/u.test(receipt.run)) throw new Error('invalid gate run id');
  const dir = join(root, 'gate-evidence');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${receipt.run}.json`);
  const bytes = `${JSON.stringify(receipt, null, 2)}\n`;
  try { writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST' || readFileSync(path, 'utf8') !== bytes) throw error;
  }
  return path;
}

/** Only an entire unfiltered selector result is compatible with the existing
 * cache. Named files are still limited even if they happen to equal it. */
export function recordReceiptGreen({ root, receipt, path }) {
  if (receipt.outcome !== 'green' || !fullCoverage(receipt.coverage)) return false;
  recordGreen({ root, entry: {
    repo: receipt.repo, tree: receipt.tree, head_tree: receipt.tree, base: receipt.base,
    selection: selectionHash(receipt.coverage), gate_version: receipt.gate_version,
    at: receipt.ended, session: receipt.session_run || receipt.run,
    files: receipt.coverage.files, commands: receipt.coverage.commands.map((command) => command.packageScript),
    receipt: path,
  } });
  return true;
}

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

/** Future autonomous finish boundary. The caller supplies a frozen local head
 * and an independently observed pushed SHA (not a tracking-ref assumption).
 * This lookup grants no publication/merge authority and performs no push. */
export function findPublicationReceipt({ root, cwd, repo, run, sessionRun = null, goalRevision = null,
  head, pushed, selection, configuration } = {}) {
  if (!/^[0-9a-f]{40,64}$/u.test(head || '') || pushed !== head
    || !Array.isArray(selection?.files) || !Array.isArray(selection.commands)) return null;
  try {
    const git = (ref) => {
      const result = runGit(cwd, ['rev-parse', '--verify', ref], { timeoutMs: 60_000 });
      if (result.status !== 0 || result.error) throw new Error('commit unavailable');
      return result.stdout.trim();
    };
    if (git('HEAD') !== head) return null;
    const content = captureWorktree(cwd);
    if (git(`${head}^{tree}`) !== content.tree) return null;
    const receipt = readGreenReceipt({ root, repo, repository: content.repository, run, sessionRun, goalRevision, configuration });
    if (!receipt || !sameContent(receipt, content) || !fullCoverage(receipt.coverage)
      || checksHash(receipt.coverage) !== checksHash(selection)) return null;
    return freeze(receipt);
  } catch { return null; }
}
