/**
 * A repository model that answers git from memory and the files on disk.
 *
 * Martin, 2026-11-01: tests make no git call. Measured the same day, one
 * autonomy test made ~380 git processes at ≥47 ms each; the fixtures built
 * repositories with `init`, `commit` and `clone --bare`, and the code asked
 * them `rev-parse`, `ls-files`, `write-tree` and `merge-base`. This model
 * takes the place of every one of those processes: installed through
 * `useGitRunner` (src/mc/git.js) it receives `(cwd, args, options)` exactly
 * as `spawnSync('git', …)` would and answers in the same shape, so neither
 * the code under test nor the fixtures change what they say — only who
 * answers.
 *
 * It implements the commands the suite was measured to issue and nothing
 * else. An argument shape it does not know is an error, thrown and recorded
 * in `unsupported`, so a new question the code learns to ask shows up here
 * instead of being answered wrong in silence. Content identity is real:
 * blobs are hashed from the bytes on disk, trees from their blobs, so two
 * worktrees with the same files have the same tree, and a commit's tree is
 * the tree the index had — the properties the gate's evidence rests on.
 * Merge/conflict, hook and ref-update answers below model fixture scenarios.
 * They prove our decisions against modelled answers, not git semantics; the
 * production merge round is where those are measured (decided 2026-11-01).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { useGitRunner } from '../../../src/mc/git.js';

const sha1 = (text) => createHash('sha1').update(text).digest('hex');
const real = (path) => { try { return realpathSync(path); } catch { return resolve(path); } };
const ok = (stdout = '') => ({ status: 0, stdout, stderr: '', signal: null });
const fail = (stderr, status = 128) => ({ status, stdout: '', stderr: stderr.endsWith('\n') ? stderr : `${stderr}\n`, signal: null });

/** One repository: refs, commits, trees, blobs, worktrees, remotes, config. */
class Repo {
  constructor(gitDir, { bare = false } = {}) {
    this.gitDir = gitDir;
    this.bare = bare;
    this.refs = new Map();       // 'refs/heads/x' | 'refs/remotes/origin/x' → sha
    this.commits = new Map();    // sha → { tree, parents, message }
    this.trees = new Map();      // tree sha → Map(path → blob sha)
    this.blobs = new Map();      // blob sha → Buffer
    this.worktrees = new Map();  // real path → { head: 'refs/heads/x' | sha, index: Map(path → blob sha) }
    this.indexes = new Map();    // isolated index file path → Map(path → blob sha)
    this.remotes = new Map();    // name → url
    this.config = new Map();     // 'user.name' → value
    this.symbolicRefs = new Map([['HEAD', 'refs/heads/main']]);
    this.fetchHead = null;
    this.serial = 0;
  }
}

export class FakeGit {
  constructor() {
    this.repos = new Map();      // real git dir → Repo
    this.worktreeOwner = new Map(); // real worktree path → Repo
    this.unsupported = [];
    this.calls = [];
    this.now = 1_700_000_000;
    this.runner = this.runner.bind(this);
  }

  /** Stand in for git in this process; returns the function that restores git. */
  install() {
    const restore = useGitRunner(this.runner);
    return () => { restore(); };
  }

  /**
   * The model as JSON, for a child process that must see the same
   * repositories: write it before the spawn, `reload` it after, and start the
   * child with `childEnv` so `fake-git-preload.mjs` installs the model there
   * and writes it back on exit.
   */
  snapshot(file) {
    const repos = [...this.repos.values()].map((repo) => ({
      gitDir: repo.gitDir, bare: repo.bare, refs: [...repo.refs], commits: [...repo.commits], trees: [...repo.trees].map(([sha, tree]) => [sha, [...tree]]),
      blobs: [...repo.blobs].map(([sha, bytes]) => [sha, bytes.toString('base64')]),
      worktrees: [...repo.worktrees].map(([path, state]) => [path, { head: state.head, index: [...state.index] }]),
      symbolicRefs: [...repo.symbolicRefs], remotes: [...repo.remotes], config: [...repo.config], fetchHead: repo.fetchHead, serial: repo.serial,
    }));
    writeFileSync(file, JSON.stringify({ repos, now: this.now }));
    return file;
  }

  reload(file) {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    this.repos = new Map();
    this.worktreeOwner = new Map();
    for (const entry of data.repos) {
      const repo = new Repo(entry.gitDir, { bare: entry.bare });
      repo.refs = new Map(entry.refs);
      repo.commits = new Map(entry.commits);
      repo.trees = new Map(entry.trees.map(([sha, tree]) => [sha, new Map(tree)]));
      repo.blobs = new Map(entry.blobs.map(([sha, text]) => [sha, Buffer.from(text, 'base64')]));
      repo.worktrees = new Map(entry.worktrees.map(([path, state]) => [path, { head: state.head, index: new Map(state.index) }]));
      repo.symbolicRefs = new Map(entry.symbolicRefs ?? [['HEAD', 'refs/heads/main']]);
      repo.remotes = new Map(entry.remotes);
      repo.config = new Map(entry.config);
      repo.fetchHead = entry.fetchHead;
      repo.serial = entry.serial;
      this.repos.set(repo.gitDir, repo);
      for (const path of repo.worktrees.keys()) this.worktreeOwner.set(path, repo);
    }
    this.now = data.now;
    return this;
  }

  static load(file) {
    return new FakeGit().reload(file);
  }

  /** The environment a child process needs to answer git from this model's snapshot at `file`. */
  static childEnv(env, file) {
    const preload = new URL('./fake-git-preload.mjs', import.meta.url).href;
    return { ...env, MC_FAKE_GIT_STATE: file, NODE_OPTIONS: `${env.NODE_OPTIONS || ''} --import ${preload}`.trim() };
  }

  /** Run `spawnChild(env)` with the model shared: snapshot before, reload after. */
  inChild(env, spawnChild) {
    const file = join(this.scratch(), `fake-git-${process.pid}-${this.now}.json`);
    this.snapshot(file);
    const result = spawnChild(FakeGit.childEnv(env, file));
    this.reload(file);
    return result;
  }

  scratch() {
    const dir = join(process.env.TMPDIR || '/tmp', 'fake-git-state');
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** Every call is answered here. */
  runner(cwd, args, options = {}) {
    const argv = [...args];
    let dir = cwd ? resolve(cwd) : process.cwd();
    let gitDir = null;
    while (argv.length && (argv[0] === '-C' || argv[0] === '--git-dir' || argv[0].startsWith('--git-dir=') || argv[0] === '-c')) {
      if (argv[0].startsWith('--git-dir=')) { gitDir = resolve(dir, argv.shift().slice('--git-dir='.length)); continue; }
      const flag = argv.shift();
      const value = argv.shift();
      if (flag === '-C') dir = resolve(dir, value);
      else if (flag === '--git-dir') gitDir = resolve(dir, value);
    }
    this.calls.push({ cwd: dir, args: [...args] });
    const command = argv.shift();
    if (command === '--version') return this.cmd_version() && ok(this.cmd_version());
    const handler = this[`cmd_${command?.replace(/-/gu, '_')}`];
    if (!handler) return this.refuse(args, `no such command in the model: ${command}`);
    try {
      const result = handler.call(this, { dir, gitDir, argv, env: options.env || process.env, input: options.input, args });
      return typeof result === 'string' ? ok(result) : result;
    } catch (error) {
      if (error?.fakeGit) return error.result;
      throw error;
    }
  }

  refuse(args, why) {
    const message = `fake git: unsupported — git ${args.join(' ')} (${why})`;
    this.unsupported.push(message);
    throw new Error(message);
  }

  // ---- repositories and worktrees ----

  repoAt(dir, gitDir = null) {
    if (gitDir) {
      const repo = this.repos.get(real(gitDir));
      if (!repo) this.die(`fatal: not a git repository: '${gitDir}'`);
      return { repo, worktree: null };
    }
    let probe = real(dir);
    for (;;) {
      const owner = this.worktreeOwner.get(probe);
      if (owner) return { repo: owner, worktree: probe };
      const bare = this.repos.get(probe);
      if (bare) return { repo: bare, worktree: null };
      const parent = dirname(probe);
      if (parent === probe) this.die(`fatal: not a git repository (or any of the parent directories): .git`);
      probe = parent;
    }
  }

  worktreeOf(dir, gitDir) {
    const { repo, worktree } = this.repoAt(dir, gitDir);
    if (!worktree) this.die('fatal: this operation must be run in a work tree');
    return { repo, worktree, state: repo.worktrees.get(worktree) };
  }

  die(message, status = 128) {
    const error = new Error(message);
    error.fakeGit = true;
    error.result = fail(message, status);
    throw error;
  }

  // ---- content ----

  blob(repo, bytes) {
    const sha = sha1(`blob ${bytes.length}\0${bytes.toString('latin1')}`);
    if (!repo.blobs.has(sha)) repo.blobs.set(sha, bytes);
    return sha;
  }

  treeOf(repo, entries) {
    const sorted = [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const sha = sha1(`tree\0${sorted.map(([path, blob]) => `${path}\0${blob}`).join('\n')}`);
    if (!repo.trees.has(sha)) repo.trees.set(sha, new Map(sorted));
    return sha;
  }

  /** Every file under a worktree that is not ignored, as `path → blob sha`. */
  workingFiles(repo, worktree) {
    const ignore = this.ignoreRules(worktree);
    const files = new Map();
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === '.git') continue;
        const full = join(dir, entry.name);
        const rel = relative(worktree, full).split(sep).join('/');
        if (ignore(rel, entry.isDirectory())) continue;
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile()) files.set(rel, this.blob(repo, this.normalized(worktree, rel)));
      }
    };
    walk(worktree);
    return files;
  }

  /** A file's bytes as git would store them: `*.ext text eol=lf` in .gitattributes turns CRLF to LF. */
  normalized(worktree, rel) {
    const bytes = readFileSync(join(worktree, rel));
    let rules = '';
    try { rules = readFileSync(join(worktree, '.gitattributes'), 'utf8'); } catch { return bytes; }
    const applies = rules.split('\n').some((line) => {
      const [pattern, ...attributes] = line.trim().split(/\s+/u);
      return attributes.includes('eol=lf') && (pattern === '*' || (pattern.startsWith('*.') && rel.endsWith(pattern.slice(1))) || pattern === rel);
    });
    return applies ? Buffer.from(bytes.toString('latin1').replace(/\r\n/gu, '\n'), 'latin1') : bytes;
  }

  /** `.gitignore` at the root, the shapes fixtures write: `name`, `dir/`, `*.ext`, `/rooted`. */
  ignoreRules(worktree) {
    let patterns = [];
    try { patterns = readFileSync(join(worktree, '.gitignore'), 'utf8').split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#')); } catch { /* none */ }
    const rules = patterns.map((pattern) => {
      const dirOnly = pattern.endsWith('/');
      const rooted = pattern.startsWith('/');
      const body = pattern.replace(/^\//u, '').replace(/\/$/u, '');
      const regex = new RegExp(`^${body.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/gu, '\\$&')).join('[^/]*')}$`, 'u');
      return { dirOnly, rooted, regex, hasSlash: body.includes('/') };
    });
    return (rel, isDir) => {
      const segments = rel.split('/');
      return rules.some((rule) => {
        if (rule.dirOnly && !isDir && !segments.slice(0, -1).some((segment) => rule.regex.test(segment))) return false;
        if (rule.rooted || rule.hasSlash) return rule.regex.test(rel) || segments.some((_, index) => rule.regex.test(segments.slice(0, index + 1).join('/')));
        return segments.some((segment) => rule.regex.test(segment));
      });
    };
  }

  headSha(repo, state) {
    if (!state.head) return null;
    return state.head.startsWith('refs/') ? repo.refs.get(state.head) ?? null : state.head;
  }

  headTree(repo, state) {
    const sha = this.headSha(repo, state);
    return sha ? repo.trees.get(repo.commits.get(sha).tree) : new Map();
  }

  indexFor(repo, state, env) {
    const isolated = env?.GIT_INDEX_FILE;
    if (!isolated) return state.index;
    if (!repo.indexes.has(isolated)) {
      // A copied real index starts as the checkout's own; a fresh file is empty.
      let size = 0;
      try { size = statSync(isolated).size; } catch { /* no file yet */ }
      repo.indexes.set(isolated, size > 0 ? new Map(state.index) : new Map());
    }
    return repo.indexes.get(isolated);
  }

  resolveRev(repo, state, rev) {
    let name = rev;
    let peel = null;
    const peeled = name.match(/^(.*)\^\{(commit|tree)\}$/u);
    if (peeled) { name = peeled[1]; peel = peeled[2]; }
    let tilde = 0;
    const back = name.match(/^(.*?)((?:~\d*|\^)+)$/u);
    if (back) { name = back[1]; tilde = back[2].split(/(?=[~^])/u).reduce((sum, part) => sum + (part === '^' ? 1 : Number(part.slice(1) || 1)), 0); }
    let sha = null;
    if (name === 'HEAD') sha = state ? this.headSha(repo, state) : repo.refs.get(repo.symbolicRefs.get('HEAD')) ?? null;
    else if (name === 'FETCH_HEAD') sha = repo.fetchHead;
    else if (/^[0-9a-f]{40}$/u.test(name)) sha = repo.commits.has(name) || repo.trees.has(name) ? name : null;
    else if (/^[0-9a-f]{4,39}$/u.test(name)) sha = [...repo.commits.keys()].find((key) => key.startsWith(name)) ?? null;
    else {
      for (const candidate of [name, `refs/heads/${name}`, `refs/remotes/${name}`, `refs/tags/${name}`]) {
        const target = repo.symbolicRefs.get(candidate) ?? candidate;
        if (repo.refs.has(target)) { sha = repo.refs.get(target); break; }
      }
    }
    for (let i = 0; sha && i < tilde; i++) sha = repo.commits.get(sha)?.parents[0] ?? null;
    if (!sha) return null;
    if (peel === 'tree') return repo.commits.get(sha)?.tree ?? (repo.trees.has(sha) ? sha : null);
    if (peel === 'commit') return repo.commits.has(sha) ? sha : null;
    return sha;
  }

  ancestors(repo, sha) {
    const seen = new Set();
    const queue = [sha];
    while (queue.length) {
      const current = queue.shift();
      if (!current || seen.has(current)) continue;
      seen.add(current);
      queue.push(...(repo.commits.get(current)?.parents ?? []));
    }
    return seen;
  }

  mergeBase(repo, a, b) {
    const ours = this.ancestors(repo, a);
    // Breadth-first from b: the first commit also reachable from a is the base.
    const queue = [b];
    const seen = new Set();
    while (queue.length) {
      const current = queue.shift();
      if (!current || seen.has(current)) continue;
      seen.add(current);
      if (ours.has(current)) return current;
      queue.push(...(repo.commits.get(current)?.parents ?? []));
    }
    return null;
  }

  commit(repo, state, { message, allowEmpty = false, env }) {
    const index = this.indexFor(repo, state, env);
    const tree = this.treeOf(repo, index);
    const parent = this.headSha(repo, state);
    if (!allowEmpty && parent && repo.commits.get(parent).tree === tree) this.die('nothing to commit, working tree clean', 1);
    const at = this.now++;
    const sha = sha1(`commit ${tree} ${parent ?? ''} ${message} ${repo.serial++} ${at}`);
    repo.commits.set(sha, { tree, parents: parent ? [parent] : [], message, at });
    if (state.head.startsWith('refs/')) repo.refs.set(state.head, sha); else state.head = sha;
    return sha;
  }

  checkout(repo, state, worktree, sha) {
    // The files of a tree, written over the worktree's tracked files.
    const tree = repo.trees.get(repo.commits.get(sha).tree);
    const current = this.headTree(repo, state);
    for (const path of current.keys()) {
      if (!tree.has(path)) {
        rmSync(join(worktree, path), { force: true });
        // Checkout removes now-empty tracked directories, not untracked files.
        for (let parent = dirname(join(worktree, path)); parent !== worktree && !readdirSync(parent).length; parent = dirname(parent)) rmSync(parent, { recursive: true });
      }
    }
    for (const [path, blob] of tree) {
      const full = join(worktree, path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, repo.blobs.get(blob));
    }
    state.index = new Map(tree);
  }

  branchName(state) {
    return state.head.startsWith('refs/heads/') ? state.head.slice('refs/heads/'.length) : null;
  }

  openRepo(path, { bare }) {
    // Made before it is named: the temp directory on macOS is a symlink, and
    // every lookup below goes by the real path, which only exists once made.
    mkdirSync(path, { recursive: true });
    const dir = real(path);
    const repo = new Repo(bare ? dir : join(dir, '.git'), { bare });
    this.repos.set(repo.gitDir, repo);
    if (!bare) {
      mkdirSync(join(repo.gitDir, 'hooks'), { recursive: true });
      writeFileSync(join(repo.gitDir, 'HEAD'), 'ref: refs/heads/main\n');
      writeFileSync(join(repo.gitDir, 'index'), 'DIRC\n');
      repo.worktrees.set(dir, { head: 'refs/heads/main', index: new Map() });
      this.worktreeOwner.set(dir, repo);
    } else {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'HEAD'), 'ref: refs/heads/main\n');
    }
    return repo;
  }

  remoteRepo(repo, name) {
    // A path works where a name does: `git push -q <dir> HEAD:refs/heads/x`.
    const url = repo.remotes.get(name) ?? (name.includes('/') ? name : null);
    if (!url) this.die(`fatal: '${name}' does not appear to be a git repository`);
    const target = this.repoByPath(url);
    if (!target) this.die(`fatal: '${url}' does not appear to be a git repository`);
    return target;
  }

  /** A repository named by its directory — a bare one, or a checkout's root. */
  repoByPath(path) {
    for (const candidate of new Set([real(path), resolve(path)])) {
      const found = this.repos.get(candidate) || this.repos.get(join(candidate, '.git')) || this.worktreeOwner.get(candidate);
      if (found) return found;
    }
    return null;
  }

  // ---- commands ----

  cmd_version() { return 'git version 2.50.1 (fake)\n'; }

  cmd_init({ dir, argv }) {
    const flags = parse(argv, { b: 1, 'initial-branch': 1 }, ['q', 'quiet', 'bare']);
    const target = flags.rest[0] ? resolve(dir, flags.rest[0]) : dir;
    mkdirSync(target, { recursive: true });
    const repo = this.openRepo(target, { bare: Boolean(flags.bare) });
    const branch = flags.b || flags['initial-branch'] || 'main';
    repo.symbolicRefs.set('HEAD', `refs/heads/${branch}`);
    if (!repo.bare) repo.worktrees.get(real(target)).head = `refs/heads/${branch}`;
    return '';
  }

  cmd_config({ dir, gitDir, argv }) {
    const flags = parse(argv, [], ['local', 'global', 'get']);
    const { repo } = this.repoAt(dir, gitDir);
    const [key, value] = flags.rest;
    if (flags.get || value === undefined) {
      const found = repo.config.get(key);
      if (found === undefined) this.die('', 1);
      return `${found}\n`;
    }
    repo.config.set(key, value);
    return '';
  }

  cmd_add({ dir, gitDir, argv, env, input }) {
    const flags = parse(argv, { 'pathspec-from-file': 1 }, ['A', 'all', 'force', 'f', 'pathspec-file-nul', 'u']);
    const { repo, worktree, state } = this.worktreeOf(dir, gitDir);
    const index = this.indexFor(repo, state, env);
    const files = this.workingFiles(repo, worktree);
    let specs = flags.rest.filter((spec) => spec !== '--');
    if (flags["pathspec-from-file"] === "-") specs = String(input ?? "").split('\0').filter(Boolean);
    const all = flags.A || flags.all || specs.includes('.');
    if (all) {
      if (flags.force || flags.f) for (const spec of specs) if (spec !== '.' && existsSync(join(worktree, spec)) && statSync(join(worktree, spec)).isFile()) index.set(spec, this.blob(repo, this.normalized(worktree, spec)));
      for (const path of [...index.keys()]) {
        if (files.has(path)) continue;
        // Tracked stays tracked though .gitignore now names it, while the file is there.
        if (existsSync(join(worktree, path))) index.set(path, this.blob(repo, this.normalized(worktree, path)));
        else index.delete(path);
      }
      for (const [path, blob] of files) index.set(path, blob);
      return '';
    }
    for (const spec of specs) {
      const rel = spec.replace(/\/$/u, '');
      let matched = false;
      if ((flags.force || flags.f) && !files.has(rel) && existsSync(join(worktree, rel)) && statSync(join(worktree, rel)).isFile()) {
        index.set(rel, this.blob(repo, this.normalized(worktree, rel)));
        continue;
      }
      for (const [path, blob] of files) if (path === rel || path.startsWith(`${rel}/`)) { index.set(path, blob); matched = true; }
      if (!matched) {
        if (index.has(rel)) { index.delete(rel); matched = true; }
        if (!matched && !flags.force && !flags.f) this.die(`fatal: pathspec '${spec}' did not match any files`);
      }
    }
    return '';
  }

  cmd_commit({ dir, gitDir, argv, env }) {
    const flags = parse(argv, { m: 1, qm: 1, am: 1 }, ['q', 'quiet', 'allow-empty', 'a', 'no-verify']);
    const { repo, worktree, state } = this.worktreeOf(dir, gitDir);
    if (flags.a || flags.am !== undefined) {
      const files = this.workingFiles(repo, worktree);
      for (const path of [...state.index.keys()]) state.index.set(path, files.get(path) ?? state.index.get(path));
      for (const path of [...state.index.keys()]) if (!files.has(path)) state.index.delete(path);
    }
    const message = flags.m ?? flags.qm ?? flags.am ?? '';
    const sha = this.commit(repo, state, { message, allowEmpty: Boolean(flags['allow-empty']), env });
    return flags.q || flags.quiet || flags.qm !== undefined ? '' : `[${this.branchName(state) ?? 'detached HEAD'} ${sha.slice(0, 7)}] ${message}\n`;
  }

  cmd_write_tree({ dir, gitDir, env }) {
    const { repo, state } = this.worktreeOf(dir, gitDir);
    return `${this.treeOf(repo, this.indexFor(repo, state, env))}\n`;
  }

  cmd_read_tree({ dir, gitDir, argv, env }) {
    const { repo, state } = this.worktreeOf(dir, gitDir);
    const rev = argv.filter((arg) => !arg.startsWith('-'))[0] ?? 'HEAD';
    const sha = this.resolveRev(repo, state, rev);
    if (!sha) this.die(`fatal: Not a valid object name ${rev}`);
    const tree = repo.trees.get(repo.commits.get(sha)?.tree ?? sha);
    const index = this.indexFor(repo, state, env);
    index.clear();
    for (const [path, blob] of tree) index.set(path, blob);
    return '';
  }

  cmd_ls_files({ dir, gitDir, argv, env }) {
    const flags = parse(argv, [], ['cached', 'c', 'others', 'o', 'exclude-standard', 'ignored', 'i', 'z', 'v', 'stage', 's', 'deleted', 'modified', 'error-unmatch']);
    const { repo, worktree, state } = this.worktreeOf(dir, gitDir);
    const index = this.indexFor(repo, state, env);
    const nul = flags.z ? '\0' : '\n';
    const prefix = relative(worktree, real(dir));
    if (prefix === '.git' || prefix.startsWith('.git/')) this.die('fatal: this operation must be run in a work tree');
    const paths = flags.rest.filter((p) => p !== '--').map((p) => relative(worktree, resolve(real(dir), p)));
    const within = (path) => !paths.length || paths.some((p) => pathspecMatches(p, path));
    if (flags.others || flags.o) {
      const files = this.workingFiles(repo, worktree);
      if (flags.ignored || flags.i) {
        // Ignored files: everything on disk the ignore rules hide, minus the index.
        const ignore = this.ignoreRules(worktree);
        const hidden = [];
        const walk = (d) => {
          for (const entry of readdirSync(d, { withFileTypes: true })) {
            if (entry.name === '.git') continue;
            const full = join(d, entry.name);
            const rel = relative(worktree, full).split(sep).join('/');
            if (entry.isDirectory()) { walk(full); continue; }
            if (ignore(rel, false) && !index.has(rel)) hidden.push(rel);
          }
        };
        walk(worktree);
        return hidden.filter(within).sort().map((p) => `${p}${nul}`).join('');
      }
      return [...files.keys()].filter((p) => !index.has(p) && within(p)).sort().map((p) => `${p}${nul}`).join('');
    }
    const sorted = [...index.entries()].filter(([p]) => within(p)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    if (flags['error-unmatch'] && paths.some((spec) => !sorted.some(([path]) => pathspecMatches(spec, path)))) this.die('error: pathspec did not match any file(s) known to git', 1);
    if (flags.stage || flags.s) return sorted.map(([p, blob]) => `100644 ${blob} 0\t${p}${nul}`).join('');
    if (flags.v) return sorted.map(([p]) => `H ${p}${nul}`).join('');
    return sorted.map(([p]) => `${p}${nul}`).join('');
  }

  cmd_status({ dir, gitDir, argv }) {
    const flags = parse(argv, { 'untracked-files': 1, porcelain: 0 }, ['z', 'porcelain', 'porcelain=v1', 'short', 's', 'b']);
    const { repo, worktree, state } = this.worktreeOf(dir, gitDir);
    const files = this.workingFiles(repo, worktree);
    const head = this.headTree(repo, state);
    const lines = [];
    const untracked = [];
    const all = new Set([...files.keys(), ...state.index.keys(), ...head.keys()]);
    for (const path of [...all].sort()) {
      const inHead = head.get(path);
      const inIndex = state.index.get(path);
      const onDisk = files.get(path);
      const x = inIndex === undefined ? (inHead === undefined ? '?' : 'D') : inHead === undefined ? 'A' : inIndex === inHead ? ' ' : 'M';
      const y = onDisk === undefined ? (inIndex === undefined ? '?' : 'D') : inIndex === undefined ? '?' : onDisk === inIndex ? ' ' : 'M';
      if (x === '?' && y === '?') { untracked.push(`?? ${path}`); continue; }
      if (x === ' ' && y === ' ') continue;
      lines.push(`${x}${y} ${path}`);
    }
    // As git prints it: tracked changes first, then the untracked files.
    lines.push(...untracked);
    const end = flags.z ? '\0' : '\n';
    return lines.length ? `${lines.join(end)}${end}` : '';
  }

  cmd_rev_parse({ dir, gitDir, argv }) {
    const flags = parse(argv, { 'path-format': 1, 'git-path': 1, 'abbrev-ref': 0 }, ['verify', 'quiet', 'q', 'show-toplevel', 'git-dir', 'git-common-dir', 'absolute-git-dir', 'is-inside-work-tree', 'is-bare-repository', 'abbrev-ref', 'symbolic-full-name', 'short']);
    const { repo, worktree } = this.repoAt(dir, gitDir);
    const state = worktree ? repo.worktrees.get(worktree) : null;
    if (flags['git-path'] !== undefined) return `${join(repo.gitDir, flags['git-path'])}\n`;
    if (flags['show-toplevel']) { if (!worktree) this.die('fatal: this operation must be run in a work tree'); return `${worktree}\n`; }
    if (flags['git-dir'] || flags['absolute-git-dir'] || flags['git-common-dir']) return `${repo.gitDir}\n`;
    if (flags['is-inside-work-tree']) return `${worktree ? 'true' : 'false'}\n`;
    if (flags['is-bare-repository']) return `${repo.bare ? 'true' : 'false'}\n`;
    const out = [];
    for (const rev of flags.rest) {
      if (flags['abbrev-ref']) {
        if (rev === 'HEAD') { out.push(state ? this.branchName(state) ?? 'HEAD' : 'HEAD'); continue; }
        if (rev === '@{upstream}' || rev === '@{u}') {
          const branch = state ? this.branchName(state) : null;
          const upstream = branch && repo.refs.has(`refs/remotes/origin/${branch}`) ? `origin/${branch}` : null;
          if (!upstream) this.die(`fatal: no upstream configured for branch '${branch}'`);
          out.push(upstream); continue;
        }
      }
      const colon = rev.indexOf(':');
      if (colon > 0) {
        const tree = this.resolveRev(repo, state, `${rev.slice(0, colon)}^{tree}`);
        const blob = tree && repo.trees.get(tree)?.get(rev.slice(colon + 1));
        if (!blob) this.die(`fatal: path '${rev.slice(colon + 1)}' does not exist in '${rev.slice(0, colon)}'`);
        out.push(blob);
        continue;
      }
      const sha = this.resolveRev(repo, state, rev);
      if (!sha) {
        if (flags.quiet || flags.q) this.die('', 1);
        this.die(`fatal: Needed a single revision`);
      }
      out.push(flags.short ? sha.slice(0, 7) : sha);
    }
    return out.map((line) => `${line}\n`).join('');
  }

  checkRefName(repo, ref, progress = '') {
    const collision = [...repo.refs.keys()].find((existing) => existing.startsWith(`${ref}/`) || ref.startsWith(`${existing}/`));
    if (collision) this.die(`${progress}fatal: cannot lock ref '${ref}': '${collision}' exists; cannot create '${ref}'`);
  }

  cmd_branch({ dir, gitDir, argv }) {
    const flags = parse(argv, { 'set-upstream-to': 1, u: 1 }, ['show-current', 'D', 'd', 'a', 'r', 'f', 'force', 'list', 'q', 'M', 'm']);
    const { repo, worktree } = this.repoAt(dir, gitDir);
    const state = worktree ? repo.worktrees.get(worktree) : null;
    if (flags.M || flags.m) {
      const old = flags.rest.length === 2 ? flags.rest[0] : this.branchName(state);
      const name = flags.rest.at(-1);
      const ref = `refs/heads/${name}`;
      const sha = repo.refs.get(`refs/heads/${old}`);
      if (!sha) this.die(`fatal: No branch named '${old}'`);
      this.checkRefName(repo, ref);
      repo.refs.delete(`refs/heads/${old}`); repo.refs.set(ref, sha);
      if (state?.head === `refs/heads/${old}`) state.head = ref;
      return '';
    }
    if (flags['show-current']) return state && this.branchName(state) ? `${this.branchName(state)}\n` : '';
    if (flags['set-upstream-to'] || flags.u) return '';
    if (flags.D || flags.d) { for (const name of flags.rest) repo.refs.delete(`refs/heads/${name}`); return ''; }
    if (!flags.rest.length || flags.list) {
      const names = [...repo.refs.keys()].filter((ref) => ref.startsWith('refs/heads/')).map((ref) => ref.slice('refs/heads/'.length))
        .filter((name) => !flags.rest.length || flags.rest.some((pattern) => globMatches(pattern, name))).sort();
      return names.map((name) => `${state && this.branchName(state) === name ? '* ' : '  '}${name}\n`).join('');
    }
    const [name, start] = flags.rest;
    if (repo.refs.has(`refs/heads/${name}`) && !flags.f && !flags.force) this.die(`fatal: a branch named '${name}' already exists`);
    const sha = this.resolveRev(repo, state, start ?? 'HEAD');
    if (!sha) this.die(`fatal: Not a valid object name: '${start ?? 'HEAD'}'.`);
    this.checkRefName(repo, `refs/heads/${name}`);
    repo.refs.set(`refs/heads/${name}`, sha);
    return '';
  }

  cmd_switch({ dir, gitDir, argv }) {
    const flags = parse(argv, { c: 1, C: 1 }, ['q', 'quiet', 'detach', 'qc']);
    const { repo, worktree, state } = this.worktreeOf(dir, gitDir);
    const create = flags.c ?? flags.C ?? (flags.qc !== undefined ? flags.rest.shift() : undefined);
    const target = create ?? flags.rest[0];
    if (!target) this.die('fatal: missing branch');
    if (create !== undefined) {
      if (repo.refs.has(`refs/heads/${create}`) && flags.C === undefined) this.die(`fatal: a branch named '${create}' already exists`);
      this.checkRefName(repo, `refs/heads/${create}`);
      repo.refs.set(`refs/heads/${create}`, this.headSha(repo, state));
      state.head = `refs/heads/${create}`;
      return '';
    }
    if (!repo.refs.has(`refs/heads/${target}`)) {
      // `switch <name>` makes a local branch from origin/<name> when one exists.
      if (repo.refs.has(`refs/remotes/origin/${target}`)) repo.refs.set(`refs/heads/${target}`, repo.refs.get(`refs/remotes/origin/${target}`));
      else this.die(`fatal: invalid reference: ${target}`);
    }
    for (const [path, other] of repo.worktrees) if (path !== worktree && other.head === `refs/heads/${target}`) this.die(`fatal: '${target}' is already checked out at '${path}'`);
    this.checkout(repo, state, worktree, repo.refs.get(`refs/heads/${target}`));
    state.head = `refs/heads/${target}`;
    return '';
  }

  cmd_checkout({ dir, gitDir, argv }) {
    const flags = parse(argv, { b: 1, B: 1 }, ['q', 'quiet', 'detach', 'force', 'f', 'no-guess']);
    const { repo, worktree, state } = this.worktreeOf(dir, gitDir);
    if (flags.b !== undefined || flags.B !== undefined) {
      const name = flags.b ?? flags.B;
      const start = this.resolveRev(repo, state, flags.rest[0] ?? 'HEAD');
      if (!start) this.die(`fatal: invalid reference: ${flags.rest[0]}`);
      if (repo.refs.has(`refs/heads/${name}`) && flags.B === undefined) this.die(`fatal: a branch named '${name}' already exists`);
      this.checkRefName(repo, `refs/heads/${name}`);
      repo.refs.set(`refs/heads/${name}`, start);
      this.checkout(repo, state, worktree, start);
      state.head = `refs/heads/${name}`;
      return '';
    }
    const target = flags.rest.filter((arg) => arg !== '--')[0];
    if (!target) this.die('fatal: missing target');
    if (flags.detach || !repo.refs.has(`refs/heads/${target}`)) {
      const sha = this.resolveRev(repo, state, target);
      if (!sha || !repo.commits.has(sha)) this.die(`error: pathspec '${target}' did not match any file(s) known to git`);
      this.checkout(repo, state, worktree, sha);
      state.head = sha;
      return '';
    }
    this.checkout(repo, state, worktree, repo.refs.get(`refs/heads/${target}`));
    state.head = `refs/heads/${target}`;
    return '';
  }

  cmd_symbolic_ref({ dir, gitDir, argv }) {
    const flags = parse(argv, [], ['short', 'quiet', 'q', 'delete']);
    const { repo, worktree } = this.repoAt(dir, gitDir);
    const [name, target] = flags.rest;
    const state = worktree ? repo.worktrees.get(worktree) : null;
    if (flags.delete) {
      if (!repo.symbolicRefs.delete(name)) this.die(`fatal: ref ${name} is not a symbolic ref`, 1);
      return '';
    }
    if (target) {
      repo.symbolicRefs.set(name, target);
      if (name === 'HEAD' && state) state.head = target;
      return '';
    }
    const ref = name === 'HEAD' && state ? state.head : repo.symbolicRefs.get(name);
    if (!ref?.startsWith('refs/')) this.die(flags.quiet || flags.q ? '' : `fatal: ref ${name} is not a symbolic ref`, 1);
    return `${flags.short ? ref.replace(/^refs\/(heads|remotes)\//u, '') : ref}\n`;
  }

  cmd_show_ref({ dir, gitDir, argv }) {
    const flags = parse(argv, [], ['verify', 'quiet', 'q', 'heads']);
    const { repo } = this.repoAt(dir, gitDir);
    const [ref] = flags.rest;
    if (flags.heads && !ref) {
      const lines = [...repo.refs].filter(([name]) => name.startsWith('refs/heads/')).sort(([x], [y]) => (x < y ? -1 : 1)).map(([name, sha]) => `${sha} ${name}\n`);
      if (!lines.length) this.die('', 1);
      return lines.join('');
    }
    if (!repo.refs.has(ref)) this.die('', 1);
    return flags.quiet || flags.q ? '' : `${repo.refs.get(ref)} ${ref}\n`;
  }

  cmd_for_each_ref({ dir, gitDir, argv }) {
    const flags = parse(argv, { format: 1 }, []);
    const { repo } = this.repoAt(dir, gitDir);
    const prefix = flags.rest[0] ?? 'refs/';
    const format = flags.format ?? '%(refname)';
    return [...repo.refs.keys()].filter((ref) => ref === prefix || ref.startsWith(`${prefix.replace(/\/$/u, '')}/`)).sort()
      .map((ref) => `${format.replace('%(refname:short)', ref.replace(/^refs\/(heads|tags|remotes)\//u, '')).replace('%(refname)', ref).replace('%(objectname)', repo.refs.get(ref)).replace('%(upstream)', ref.startsWith('refs/heads/') && repo.refs.has(`refs/remotes/origin/${ref.slice(11)}`) ? `refs/remotes/origin/${ref.slice(11)}` : '')}\n`).join('');
  }

  cmd_check_ref_format({ argv }) {
    const flags = parse(argv, [], ['branch', 'allow-onelevel', 'normalize']);
    const [name] = flags.rest;
    const valid = typeof name === 'string' && name.length > 0 && !/[\s~^:?*[\\]|\.\.|@\{|^\/|\/$|\.lock$|^\.|\/\.|\/\/|^@$/u.test(name) && !name.endsWith('.');
    if (!valid) this.die('', 1);
    return flags.branch ? `${name}\n` : `${name}\n`;
  }

  cmd_update_ref({ dir, gitDir, argv }) {
    const flags = parse(argv, [], ['d']);
    const { repo, worktree } = this.repoAt(dir, gitDir);
    const state = worktree ? repo.worktrees.get(worktree) : null;
    const [ref, value, expected] = flags.rest;
    if (flags.d) { repo.refs.delete(ref); return ''; }
    const sha = this.resolveRev(repo, state, value);
    if (!sha) this.die(`fatal: ${value}: not a valid SHA1`);
    if (expected !== undefined) {
      const old = this.resolveRev(repo, state, expected);
      if ((repo.refs.get(ref) ?? null) !== old) this.die(`fatal: update_ref failed for ref '${ref}': is at ${repo.refs.get(ref) ?? 'nothing'} but expected ${old}`);
    }
    repo.refs.set(ref, sha);
    return '';
  }

  cmd_merge_base({ dir, gitDir, argv }) {
    const flags = parse(argv, [], ['is-ancestor']);
    const { repo, worktree } = this.repoAt(dir, gitDir);
    const state = worktree ? repo.worktrees.get(worktree) : null;
    const [a, b] = flags.rest.map((rev) => this.resolveRev(repo, state, rev));
    if (!a || !b) this.die('fatal: Not a valid commit name');
    if (flags['is-ancestor']) { if (this.ancestors(repo, b).has(a)) return ''; this.die('', 1); }
    const base = this.mergeBase(repo, a, b);
    if (!base) this.die('', 1);
    return `${base}\n`;
  }

  cmd_rev_list({ dir, gitDir, argv }) {
    const flags = parse(argv, { 'max-count': 1, n: 1 }, ['count', 'left-right', 'first-parent', 'reverse', 'no-merges', 'cherry-pick', 'right-only']);
    const { repo, worktree } = this.repoAt(dir, gitDir);
    const state = worktree ? repo.worktrees.get(worktree) : null;
    const [range] = flags.rest;
    const list = (ref) => { const sha = this.resolveRev(repo, state, ref); if (!sha) this.die(`fatal: bad revision '${ref}'`); return sha; };
    if (range?.includes('...')) {
      const [l, r] = range.split('...').map(list);
      const left = [...this.ancestors(repo, l)].filter((sha) => !this.ancestors(repo, r).has(sha));
      let right = [...this.ancestors(repo, r)].filter((sha) => !this.ancestors(repo, l).has(sha));
      if (flags['no-merges']) right = right.filter((sha) => repo.commits.get(sha).parents.length <= 1);
      if (flags['cherry-pick']) {
        const patches = new Set(left.map((sha) => this.patchId(repo, sha)));
        right = right.filter((sha) => !patches.has(this.patchId(repo, sha)));
      }
      if (flags['right-only']) return flags.count ? `${right.length}\n` : right.map((sha) => `${sha}\n`).join('');
      if (flags.count) return `${left.length}\t${right.length}\n`;
      return [...left.map((sha) => `<${sha}`), ...right.map((sha) => `>${sha}`)].map((line) => `${line}\n`).join('');
    }
    let shas;
    if (range?.includes('..')) {
      const [l, r] = range.split('..').map(list);
      const exclude = this.ancestors(repo, l);
      shas = this.ordered(repo, r).filter((sha) => !exclude.has(sha));
    } else shas = this.ordered(repo, list(range ?? 'HEAD'));
    if (flags['max-count'] ?? flags.n) shas = shas.slice(0, Number(flags['max-count'] ?? flags.n));
    if (flags.count) return `${shas.length}\n`;
    return shas.map((sha) => `${sha}\n`).join('');
  }

  /** Patch equivalence for these fixtures: changed paths and before/after blobs. */
  patchId(repo, sha) {
    const commit = repo.commits.get(sha);
    const before = repo.trees.get(repo.commits.get(commit.parents[0])?.tree) ?? new Map();
    const after = repo.trees.get(commit.tree);
    return sha1([...new Set([...before.keys(), ...after.keys()])].sort()
      .filter((path) => before.get(path) !== after.get(path))
      .map((path) => `${path}\0${before.get(path) ?? ''}\0${after.get(path) ?? ''}`).join('\n'));
  }

  /** Commits reachable from `sha`, newest first along first parents, then the rest. */
  ordered(repo, sha) {
    const out = [];
    const seen = new Set();
    const queue = [sha];
    while (queue.length) {
      const current = queue.shift();
      if (!current || seen.has(current)) continue;
      seen.add(current);
      out.push(current);
      queue.push(...(repo.commits.get(current)?.parents ?? []));
    }
    return out;
  }

  cmd_log({ dir, gitDir, argv }) {
    const flags = parse(argv.map((arg) => /^-\d+$/u.test(arg) ? `--max-count=${arg.slice(1)}` : arg), { format: 1, pretty: 1, n: 1, 'max-count': 1 }, ['oneline', '1', 'no-decorate', 'reverse', 'first-parent']);
    const { repo, worktree } = this.repoAt(dir, gitDir);
    const state = worktree ? repo.worktrees.get(worktree) : null;
    const range = flags.rest.filter((arg) => arg !== '--')[0] ?? 'HEAD';
    let shas;
    if (range.includes('..')) {
      const [l, r] = range.split('..').map((ref) => this.resolveRev(repo, state, ref));
      if (!l || !r) this.die(`fatal: bad revision '${range}'`);
      const exclude = this.ancestors(repo, l);
      shas = this.ordered(repo, r).filter((sha) => !exclude.has(sha));
    } else {
      const sha = this.resolveRev(repo, state, range);
      if (!sha) this.die(`fatal: bad revision '${range}'`);
      shas = this.ordered(repo, sha);
    }
    const limit = flags['1'] ? 1 : Number(flags.n ?? flags['max-count'] ?? shas.length);
    shas = shas.slice(0, limit);
    const format = (flags.format ?? flags.pretty ?? (flags.oneline ? '%h %s' : '%H%n%s')).replace(/^(format:|tformat:)/u, '');
    return shas.map((sha) => {
      const commit = repo.commits.get(sha);
      // One commit time stands for both author and committer: the model's clock.
      const seconds = commit.at ?? this.now;
      const iso = new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/u, '+00:00');
      const fields = {
        H: sha, h: sha.slice(0, 7), s: commit.message.split('\n')[0], B: `${commit.message}\n`,
        T: commit.tree, P: commit.parents.join(' '), n: '\n', cI: iso, aI: iso, ct: String(seconds), at: String(seconds),
      };
      const line = format.replace(/%(x[0-9a-fA-F]{2}|cI|aI|ct|at|[HhsBTPn])/gu, (_, code) => (
        code.startsWith('x') ? String.fromCharCode(Number.parseInt(code.slice(1), 16)) : fields[code]));
      return `${line}\n`;
    }).join('');
  }

  cmd_diff({ dir, gitDir, argv }) {
    const flags = parse(argv, { unified: 1, 'diff-filter': 1 }, ['name-only', 'no-renames', 'z', 'cached', 'staged', 'quiet', 'exit-code', 'stat']);
    const { repo, worktree, state } = this.worktreeOf(dir, gitDir);
    const revs = flags.rest.filter((arg) => arg !== '--' && (arg.includes('..') || this.resolveRev(repo, state, arg)));
    const pathspecs = flags.rest.filter((arg) => arg !== '--' && !revs.includes(arg));
    const treeOf = (rev) => { const sha = this.resolveRev(repo, state, rev); return repo.trees.get(repo.commits.get(sha)?.tree ?? sha); };
    let left;
    let right;
    if (revs.length >= 2) { left = treeOf(revs[0]); right = treeOf(revs[1]); } else if (revs[0]?.includes('..')) {
      const [a, b] = revs[0].split(/\.\.\.?/u);
      const base = revs[0].includes('...') ? this.mergeBase(repo, this.resolveRev(repo, state, a), this.resolveRev(repo, state, b)) : a;
      left = treeOf(base); right = treeOf(b);
    } else {
      left = revs[0] ? treeOf(revs[0]) : flags.cached || flags.staged ? this.headTree(repo, state) : new Map(state.index);
      right = flags.cached || flags.staged ? new Map(state.index) : this.workingFiles(repo, worktree);
      if (!revs[0] && !(flags.cached || flags.staged)) {
        // Working tree against the index: untracked files are not a diff.
        for (const path of [...right.keys()]) if (!state.index.has(path)) right.delete(path);
      }
    }
    const changed = [...new Set([...left.keys(), ...right.keys()])].filter((path) => left.get(path) !== right.get(path))
      .filter((path) => !flags['diff-filter'] || flags['diff-filter'].includes(!left.has(path) ? 'A' : !right.has(path) ? 'D' : 'M'))
      .filter((path) => !pathspecs.length || pathspecs.some((spec) => path === spec || path.startsWith(`${spec.replace(/\/$/u, '')}/`))).sort();
    if (flags.quiet || flags['exit-code']) { if (changed.length) this.die('', 1); return ''; }
    if (flags['name-only']) return changed.map((path) => `${path}${flags.z ? '\0' : '\n'}`).join('');
    if (flags.unified !== undefined && flags.unified !== '0') return this.refuse(['diff', ...argv], 'only --unified=0 hunks are modelled');
    return changed.map((path) => {
      const header = `diff --git a/${path} b/${path}\n`;
      if (flags.unified === undefined) return header;
      const lines = (blob) => {
        if (!blob) return [];
        const text = repo.blobs.get(blob).toString('utf8');
        return text.endsWith('\n') ? text.slice(0, -1).split('\n') : text ? text.split('\n') : [];
      };
      return `${header}--- ${left.has(path) ? `a/${path}` : '/dev/null'}\n+++ ${right.has(path) ? `b/${path}` : '/dev/null'}\n${zeroContextDiff(lines(left.get(path)), lines(right.get(path)))}`;
    }).join('');
  }

  cmd_diff_tree({ dir, gitDir, argv }) {
    return this.cmd_diff({ dir, gitDir, argv: ['--name-only', ...argv.filter((arg) => arg !== '-r')] });
  }

  cmd_cat_file({ dir, gitDir, argv, input }) {
    if (argv.length === 1 && argv[0] === '--batch') {
      return Buffer.concat(String(input ?? '').split('\n').filter(Boolean).map(object => {
        const body = Buffer.from(this.cmd_cat_file({ dir, gitDir, argv: ['-p', object] }));
        return Buffer.concat([Buffer.from(`${sha1(Buffer.concat([Buffer.from(`blob ${body.length}\0`), body]))} blob ${body.length}\n`), body, Buffer.from('\n')]);
      })).toString('utf8');
    }
    const flags = parse(argv, [], ['e', 't', 'p']);
    const { repo, worktree } = this.repoAt(dir, gitDir);
    const state = worktree ? repo.worktrees.get(worktree) : null;
    const [object] = flags.rest;
    const [rev, path] = object.split(':');
    const sha = this.resolveRev(repo, state, rev);
    if (!sha) this.die('', 1);
    if (path !== undefined) {
      const blob = repo.trees.get(repo.commits.get(sha)?.tree ?? sha)?.get(path);
      if (!blob) this.die(`fatal: path '${path}' does not exist in '${rev}'`);
      if (flags.e) return '';
      return repo.blobs.get(blob).toString('utf8');
    }
    if (flags.e) return '';
    if (flags.t) return `${repo.commits.has(sha) ? 'commit' : 'tree'}\n`;
    return `${repo.commits.get(sha)?.message ?? ''}\n`;
  }

  cmd_show({ dir, gitDir, argv }) {
    const flags = parse(argv, { format: 1, pretty: 1 }, ['s', 'quiet', 'no-patch', 'stat', 'name-only']);
    const { repo, worktree } = this.repoAt(dir, gitDir);
    const state = worktree ? repo.worktrees.get(worktree) : null;
    const [object] = flags.rest.filter((arg) => arg !== '--');
    if (object?.includes(':')) return this.cmd_cat_file({ dir, gitDir, argv: ['-p', object] });
    const sha = this.resolveRev(repo, state, object ?? 'HEAD');
    if (!sha) this.die(`fatal: bad revision '${object}'`);
    if (flags.format !== undefined || flags.pretty !== undefined) return this.cmd_log({ dir, gitDir, argv: ['-1', `--format=${flags.format ?? flags.pretty}`, sha] });
    return `commit ${sha}\n\n    ${repo.commits.get(sha)?.message ?? ''}\n`;
  }

  cmd_remote({ dir, gitDir, argv }) {
    const flags = parse(argv, [], ['v']);
    const { repo } = this.repoAt(dir, gitDir);
    const [verb, name, url] = flags.rest;
    if (!verb) return [...repo.remotes.keys()].sort().map((remote) => `${remote}\n`).join('');
    if (verb === 'add') { if (repo.remotes.has(name)) this.die(`error: remote ${name} already exists.`, 3); repo.remotes.set(name, resolve(dir, url)); return ''; }
    if (verb === 'get-url') { if (!repo.remotes.has(name)) this.die(`error: No such remote '${name}'`, 2); return `${repo.remotes.get(name)}\n`; }
    if (verb === 'remove' || verb === 'rm') {
      repo.remotes.delete(name);
      for (const refs of [repo.refs, repo.symbolicRefs]) for (const ref of refs.keys()) if (ref.startsWith(`refs/remotes/${name}/`)) refs.delete(ref);
      return '';
    }
    if (verb === 'rename') {
      for (const [ref, target] of [...repo.symbolicRefs]) if (ref.startsWith(`refs/remotes/${name}/`)) {
        repo.symbolicRefs.delete(ref);
        repo.symbolicRefs.set(ref.replace(`refs/remotes/${name}/`, `refs/remotes/${url}/`), target.replace(`refs/remotes/${name}/`, `refs/remotes/${url}/`));
      }
    }
    if (verb === 'rename') { const url2 = repo.remotes.get(name); repo.remotes.delete(name); repo.remotes.set(url, url2); for (const [ref, sha] of [...repo.refs]) if (ref.startsWith(`refs/remotes/${name}/`)) { repo.refs.delete(ref); repo.refs.set(ref.replace(`refs/remotes/${name}/`, `refs/remotes/${url}/`), sha); } return ''; }
    if (verb === 'set-url') { repo.remotes.set(name, resolve(dir, url)); return ''; }
    return this.refuse(['remote', ...argv], 'remote verb');
  }

  cmd_clone({ dir, argv }) {
    const flags = parse(argv, { b: 1, branch: 1, o: 1 }, ['q', 'quiet', 'bare', 'mirror', 'no-checkout', 'n', 'shared']);
    const [source, destination] = flags.rest;
    const from = this.repoByPath(resolve(dir, source));
    if (!from) this.die(`fatal: repository '${source}' does not exist`);
    const target = resolve(dir, destination ?? source.replace(/\/?(\.git)?$/u, '').split('/').pop());
    const repo = this.openRepo(target, { bare: Boolean(flags.bare || flags.mirror) });
    this.copyObjects(from, repo, [...from.refs].filter(([ref]) => ref.startsWith('refs/heads/')).map(([, sha]) => sha));
    const sourceHead = from.bare ? from.symbolicRefs.get('HEAD') : from.worktrees.values().next().value?.head;
    repo.symbolicRefs.set('HEAD', sourceHead ?? 'refs/heads/main');
    if (!repo.bare && sourceHead) repo.symbolicRefs.set('refs/remotes/origin/HEAD', sourceHead.replace('refs/heads/', 'refs/remotes/origin/'));
    for (const [ref, sha] of from.refs) {
      if (!ref.startsWith('refs/heads/')) continue;
      if (repo.bare) repo.refs.set(ref, sha);
      else repo.refs.set(`refs/remotes/origin/${ref.slice('refs/heads/'.length)}`, sha);
    }
    repo.remotes.set('origin', real(resolve(dir, source)));
    if (!repo.bare) {
      const branch = flags.b ?? flags.branch ?? (sourceHead.startsWith('refs/heads/') ? sourceHead.slice('refs/heads/'.length) : 'main');
      const sha = from.refs.get(`refs/heads/${branch}`);
      const state = repo.worktrees.get(real(target));
      state.head = `refs/heads/${branch}`;
      if (sha) { repo.refs.set(`refs/heads/${branch}`, sha); this.checkout(repo, state, real(target), sha); }
    }
    return '';
  }

  cmd_fetch({ dir, gitDir, argv }) {
    const flags = parse(argv, { depth: 1 }, ['q', 'quiet', 'no-tags', 'prune', 'p', 'all', 'tags', 'force', 'f']);
    const { repo } = this.repoAt(dir, gitDir);
    const [remoteName = 'origin', ...refspecs] = flags.rest;
    const remote = this.remoteRepo(repo, remoteName);
    if (!refspecs.length) {
      if (flags.prune || flags.p) for (const ref of [...repo.refs.keys()]) if (ref.startsWith(`refs/remotes/${remoteName}/`) && !remote.refs.has(`refs/heads/${ref.slice(`refs/remotes/${remoteName}/`.length)}`)) repo.refs.delete(ref);
      for (const [ref, sha] of remote.refs) if (ref.startsWith('refs/heads/')) repo.refs.set(`refs/remotes/${remoteName}/${ref.slice('refs/heads/'.length)}`, sha);
      this.copyObjects(remote, repo, [...remote.refs].filter(([ref]) => ref.startsWith('refs/heads/')).map(([, sha]) => sha));
      const head = remote.bare ? remote.symbolicRefs.get('HEAD') : remote.worktrees.values().next().value?.head;
      if (head) repo.symbolicRefs.set(`refs/remotes/${remoteName}/HEAD`, head.replace('refs/heads/', `refs/remotes/${remoteName}/`));
      repo.fetchHead = remote.refs.get(head) ?? null;
      return '';
    }
    for (const spec of refspecs) {
      const [source, destination] = spec.split(':');
      const sourceRef = source.startsWith('refs/') ? source : `refs/heads/${source}`;
      const sha = remote.refs.get(sourceRef);
      if (!sha) this.die(`fatal: couldn't find remote ref ${source}`);
      this.copyObjects(remote, repo, [sha]);
      repo.fetchHead = sha;
      if (destination) repo.refs.set(destination.startsWith('refs/') ? destination : `refs/heads/${destination}`, sha);
      if (sourceRef.startsWith('refs/heads/')) repo.refs.set(`refs/remotes/${remoteName}/${sourceRef.slice('refs/heads/'.length)}`, sha);
    }
    return '';
  }

  copyObjects(from, to, heads = [...from.refs.values()]) {
    const reachable = new Set(heads.flatMap((sha) => [...this.ancestors(from, sha)]));
    for (const sha of reachable) {
      const commit = from.commits.get(sha);
      if (!commit) continue;
      to.commits.set(sha, commit);
      const tree = from.trees.get(commit.tree);
      to.trees.set(commit.tree, tree);
      for (const blob of tree.values()) to.blobs.set(blob, from.blobs.get(blob));
    }
  }

  cmd_push({ dir, gitDir, argv, env }) {
    const flags = parse(argv, { 'force-with-lease': 0 }, ['q', 'quiet', 'u', 'set-upstream', 'delete', 'd', 'force', 'f', 'no-thin', 'tags', 'force-with-lease']);
    let { repo, worktree } = this.repoAt(dir, gitDir);
    const state = worktree ? repo.worktrees.get(worktree) : null;
    const [remoteName = 'origin', ...specs] = flags.rest;
    let remote = this.remoteRepo(repo, remoteName);
    if (!specs.length) {
      const branch = state ? this.branchName(state) : null;
      if (!branch) this.die('fatal: You are not currently on a branch.');
      specs.push(branch);
    }
    const zero = '0'.repeat(40);
    const updates = specs.map((spec) => {
      const [source, destination = source === 'HEAD' && state && this.branchName(state) ? this.branchName(state) : source] = spec.split(':');
      const targetRef = destination.startsWith('refs/') ? destination : `refs/heads/${destination}`;
      const current = remote.refs.get(targetRef);
      const deleting = Boolean(flags.delete || flags.d || !source);
      const sha = deleting ? zero : this.resolveRev(repo, state, source);
      if (!sha) this.die(`error: src refspec ${source} does not match any`);
      if (!deleting && current && current !== sha && !this.ancestors(repo, sha).has(current) && !(flags.force || flags.f || flags['force-with-lease'] !== undefined)) {
        this.die(`error: failed to push some refs to '${repo.remotes.get(remoteName)}'\nhint: Updates were rejected because the remote contains work that you do not have locally.`, 1);
      }
      for (const [path, other] of remote.worktrees) if (other.head === targetRef) this.die(`error: refusing to update checked out branch: ${targetRef} at ${path}`, 1);
      const sourceRef = deleting ? '(delete)' : source === 'HEAD' ? state.head : repo.refs.has(`refs/heads/${source}`) ? `refs/heads/${source}` : source;
      return { sha, targetRef, current, sourceRef, deleting };
    });
    const hooks = repo.config.get('core.hooksPath');
    const hook = join(hooks ? resolve(worktree ?? dir, hooks) : join(repo.gitDir, 'hooks'), 'pre-push');
    let stderr = '';
    let executable = false;
    try { accessSync(hook, constants.X_OK); executable = true; } catch { /* no executable hook */ }
    if (executable) {
      const result = this.inChild(env, (childEnv) => spawnSync('sh', [hook, remoteName, repo.remotes.get(remoteName) ?? remoteName], {
        cwd: worktree ?? dir, env: childEnv, encoding: 'utf8',
        input: updates.filter((update) => update.current !== update.sha).map(({ sourceRef, sha, targetRef, current }) => `${sourceRef} ${sha} ${targetRef} ${current ?? zero}\n`).join(''),
      }));
      stderr = result.stderr || '';
      if (result.error || result.status !== 0) return { ...fail(stderr || result.error?.message || 'pre-push refused', result.status || 1), stdout: result.stdout || '' };
      // The hook's children may have refreshed refs: do not write stale objects.
      ({ repo } = this.repoAt(dir, gitDir));
      remote = this.remoteRepo(repo, remoteName);
    }
    for (const { sha, targetRef, deleting } of updates) {
      const tracking = `refs/remotes/${remoteName}/${targetRef.replace(/^refs\/heads\//u, '')}`;
      if (deleting) { remote.refs.delete(targetRef); repo.refs.delete(tracking); continue; }
      this.copyObjects(repo, remote, [sha]);
      remote.refs.set(targetRef, sha);
      repo.refs.set(tracking, sha);
    }
    return { ...ok(), stderr };
  }

  cmd_ls_remote({ dir, gitDir, argv }) {
    const flags = parse(argv, [], ['heads', 'h', 'tags', 'q', 'quiet', 'exit-code', 'refs']);
    const { repo } = this.repoAt(dir, gitDir);
    const [remoteName = 'origin', ...patterns] = flags.rest;
    const remote = this.remoteRepo(repo, remoteName);
    const lines = [];
    for (const [ref, sha] of [...remote.refs.entries()].sort()) {
      if (!ref.startsWith('refs/heads/')) continue;
      if (patterns.length && !patterns.some((pattern) => ref === pattern || ref === `refs/heads/${pattern}` || ref.endsWith(`/${pattern}`))) continue;
      lines.push(`${sha}\t${ref}`);
    }
    if (!patterns.length || patterns.includes('HEAD')) {
      const head = remote.refs.get('refs/heads/main');
      if (head && !flags.heads && !flags.h) lines.unshift(`${head}\tHEAD`);
    }
    if (flags['exit-code'] && !lines.length) this.die('', 2);
    return lines.length ? `${lines.join('\n')}\n` : '';
  }

  cmd_worktree({ dir, gitDir, argv }) {
    const [verb, ...rest] = argv;
    const { repo } = this.repoAt(dir, gitDir);
    if (verb === 'list') {
      const flags = parse(rest, [], ['porcelain', 'z']);
      const main = repo.bare ? [`worktree ${repo.gitDir}\nbare`] : [];
      const entries = [...repo.worktrees.entries()].map(([path, state]) => {
        const sha = this.headSha(repo, state) ?? '0000000000000000000000000000000000000000';
        return flags.porcelain
          ? `worktree ${path}\nHEAD ${sha}\n${state.head.startsWith('refs/') ? `branch ${state.head}` : 'detached'}`
          : `${path}  ${sha.slice(0, 7)} ${state.head.startsWith('refs/') ? `[${this.branchName(state)}]` : '(detached HEAD)'}`;
      });
      const output = `${[...main, ...entries].join(flags.porcelain ? '\n\n' : '\n')}\n${flags.porcelain ? '\n' : ''}`;
      return flags.porcelain && flags.z ? output.replaceAll('\n', '\0') : output;
    }
    if (verb === 'add') {
      const flags = parse(rest, { b: 1, B: 1 }, ['q', 'quiet', 'detach', 'force', 'f', 'lock']);
      const [pathArg, commitish] = flags.rest;
      const path = resolve(dir, pathArg);
      if (existsSync(path) && readdirSync(path).length && !flags.force && !flags.f) this.die(`fatal: '${path}' already exists`);
      let realPath = real(path);
      let head;
      let sha;
      if (flags.b !== undefined || flags.B !== undefined) {
        const name = flags.b ?? flags.B;
        sha = this.resolveRev(repo, null, commitish ?? 'HEAD') ?? this.resolveRev(repo, repo.worktrees.values().next().value ?? null, commitish ?? 'HEAD');
        if (!sha) this.die(`fatal: invalid reference: ${commitish}`);
        if (repo.refs.has(`refs/heads/${name}`) && flags.B === undefined) this.die(`fatal: a branch named '${name}' already exists`);
        this.checkRefName(repo, `refs/heads/${name}`, `Preparing worktree (new branch '${name}')\n`);
        repo.refs.set(`refs/heads/${name}`, sha);
        head = `refs/heads/${name}`;
      } else if (flags.detach) {
        sha = this.resolveRev(repo, repo.worktrees.values().next().value ?? null, commitish ?? 'HEAD');
        if (!sha) this.die(`fatal: invalid reference: ${commitish}`);
        head = sha;
      } else {
        const name = commitish ?? pathArg.split('/').pop();
        if (repo.refs.has(`refs/heads/${name}`)) { head = `refs/heads/${name}`; sha = repo.refs.get(head); }
        else if (repo.refs.has(`refs/remotes/origin/${name}`)) { sha = repo.refs.get(`refs/remotes/origin/${name}`); repo.refs.set(`refs/heads/${name}`, sha); head = `refs/heads/${name}`; }
        else { sha = this.resolveRev(repo, null, name); if (!sha) this.die(`fatal: invalid reference: ${name}`); head = sha; }
        for (const [other, state] of repo.worktrees) if (state.head === head) this.die(`fatal: '${name}' is already checked out at '${other}'`);
      }
      mkdirSync(path, { recursive: true });
      realPath = real(path);
      const state = { head, index: new Map() };
      repo.worktrees.set(realPath, state);
      this.worktreeOwner.set(realPath, repo);
      // What a linked worktree has: a file naming its directory under the repository.
      const admin = join(repo.gitDir, 'worktrees', realPath.split(sep).pop());
      mkdirSync(admin, { recursive: true });
      writeFileSync(join(admin, 'index'), 'DIRC\n');
      writeFileSync(join(realPath, '.git'), `gitdir: ${admin}\n`);
      this.checkout(repo, state, realPath, sha);
      return '';
    }
    if (verb === 'remove') {
      const flags = parse(rest, [], ['force', 'f']);
      const path = real(resolve(dir, flags.rest.filter((arg) => arg !== '--')[0]));
      const state = repo.worktrees.get(path);
      if (!state) this.die(`fatal: '${flags.rest[0]}' is not a working tree`);
      if (!flags.force && !flags.f && existsSync(path)) {
        const files = this.workingFiles(repo, path);
        const head = this.headTree(repo, state);
        const dirty = [...files.keys()].some((file) => head.get(file) !== files.get(file)) || [...head.keys()].some((file) => !files.has(file));
        if (dirty) this.die(`fatal: '${flags.rest[0]}' contains modified or untracked files, use --force to delete it`);
      }
      repo.worktrees.delete(path);
      this.worktreeOwner.delete(path);
      rmSync(path, { recursive: true, force: true });
      return '';
    }
    if (verb === 'move') {
      // As git does it: into an existing directory under the worktree's own
      // name, never over something there, never the main worktree; the
      // directory is renamed whole and its `.git` keeps naming the same record.
      const [fromArg, toArg] = parse(rest, [], []).rest;
      const from = real(resolve(dir, fromArg));
      const state = repo.worktrees.get(from);
      if (!state) this.die(`fatal: '${fromArg}' is not a working tree`);
      if (from === real(dirname(repo.gitDir))) this.die(`fatal: '${fromArg}' is a main working tree`);
      let to = resolve(dir, toArg);
      if (existsSync(to) && statSync(to).isDirectory()) to = join(to, from.split(sep).pop());
      if (existsSync(to)) this.die(`fatal: '${to}' already exists`);
      renameSync(from, to);
      const moved = real(to);
      repo.worktrees.delete(from);
      repo.worktrees.set(moved, state);
      this.worktreeOwner.delete(from);
      this.worktreeOwner.set(moved, repo);
      return '';
    }
    if (verb === 'prune') {
      for (const [path] of [...repo.worktrees]) if (!existsSync(path)) { repo.worktrees.delete(path); this.worktreeOwner.delete(path); }
      return '';
    }
    return this.refuse(['worktree', ...argv], 'worktree verb');
  }

  cmd_merge({ dir, gitDir, argv }) {
    const flags = parse(argv, { m: 1 }, ['q', 'quiet', 'ff-only', 'no-ff', 'no-edit', 'ff', 'squash']);
    const { repo, worktree, state } = this.worktreeOf(dir, gitDir);
    const [rev] = flags.rest;
    const theirs = this.resolveRev(repo, state, rev);
    const ours = this.headSha(repo, state);
    if (!theirs) this.die(`merge: ${rev} - not something we can merge`);
    if (flags.squash) {
      const { merged, conflicts, ourTree } = this.threeWay(repo, ours, theirs);
      if (conflicts.length) this.die(`CONFLICT (content): Merge conflict in ${conflicts.join(', ')}\nSquash commit -- not updating HEAD\nAutomatic merge failed; fix conflicts and then commit the result.`, 1);
      for (const [path, blob] of merged) { const full = join(worktree, path); mkdirSync(dirname(full), { recursive: true }); writeFileSync(full, repo.blobs.get(blob)); }
      for (const path of ourTree.keys()) if (!merged.has(path)) rmSync(join(worktree, path), { force: true });
      state.index = new Map(merged);
      return 'Squash commit -- not updating HEAD\n';
    }
    if (this.ancestors(repo, ours).has(theirs)) return 'Already up to date.\n';
    if (this.ancestors(repo, theirs).has(ours)) { this.checkout(repo, state, worktree, theirs); if (state.head.startsWith('refs/')) repo.refs.set(state.head, theirs); else state.head = theirs; return '';
    }
    if (flags['ff-only']) this.die('fatal: Not possible to fast-forward, aborting.', 128);
    // A true merge: three-way by path; the same path changed on both sides is a conflict.
    const { merged, conflicts, ourTree } = this.threeWay(repo, ours, theirs);
    if (conflicts.length) this.die(`CONFLICT (content): Merge conflict in ${conflicts.join(', ')}\nAutomatic merge failed; fix conflicts and then commit the result.`, 1);
    for (const [path, blob] of merged) { const full = join(worktree, path); mkdirSync(dirname(full), { recursive: true }); writeFileSync(full, repo.blobs.get(blob)); }
    for (const path of ourTree.keys()) if (!merged.has(path)) { rmSync(join(worktree, path), { force: true }); }
    state.index = new Map(merged);
    const tree = this.treeOf(repo, merged);
    const sha = sha1(`merge ${tree} ${ours} ${theirs} ${repo.serial++}`);
    repo.commits.set(sha, { tree, parents: [ours, theirs], message: flags.m ?? `Merge ${rev}` });
    if (state.head.startsWith('refs/')) repo.refs.set(state.head, sha); else state.head = sha;
    return '';
  }

  /** Three-way merge of two commits by path: the merged tree entries and the paths both sides changed differently. */
  threeWay(repo, ours, theirs) {
    const base = this.mergeBase(repo, ours, theirs);
    const baseTree = base ? repo.trees.get(repo.commits.get(base).tree) : new Map();
    const ourTree = repo.trees.get(repo.commits.get(ours).tree);
    const theirTree = repo.trees.get(repo.commits.get(theirs).tree);
    const merged = new Map(ourTree);
    const conflicts = [];
    for (const path of new Set([...ourTree.keys(), ...theirTree.keys(), ...baseTree.keys()])) {
      const b = baseTree.get(path); const o = ourTree.get(path); const t = theirTree.get(path);
      if (o === t) continue;
      if (o === b) { if (t === undefined) merged.delete(path); else merged.set(path, t); continue; }
      if (t === b) continue;
      conflicts.push(path);
    }
    return { merged, conflicts, ourTree, theirTree, base };
  }

  /** `merge-tree --write-tree A B`: the merged tree's id, or exit 1 with it and the conflicted paths. */
  cmd_merge_tree({ dir, gitDir, argv }) {
    const flags = parse(argv, [], ['write-tree', 'z', 'name-only', 'no-messages']);
    if (!flags['write-tree']) return this.refuse(['merge-tree', ...argv], 'only --write-tree is modelled');
    const { repo, worktree } = this.repoAt(dir, gitDir);
    const state = worktree ? repo.worktrees.get(worktree) : null;
    const [a, b] = flags.rest.map((rev) => this.resolveRev(repo, state, rev));
    if (!a || !b) this.die('fatal: Not a valid commit name');
    const { merged, conflicts } = this.threeWay(repo, a, b);
    const tree = this.treeOf(repo, merged);
    if (conflicts.length) {
      const error = new Error('merge conflict');
      error.fakeGit = true;
      error.result = { status: 1, stdout: `${tree}\n${conflicts.map((path) => `${path}\n`).join('')}\nCONFLICT (content): Merge conflict in ${conflicts.join(', ')}\n`, stderr: '', signal: null };
      throw error;
    }
    return `${tree}\n`;
  }

  cmd_cherry_pick({ dir, gitDir, argv }) {
    const flags = parse(argv, [], ['q', 'quiet', 'n', 'no-commit', 'x', 'allow-empty']);
    const { repo, worktree, state } = this.worktreeOf(dir, gitDir);
    for (const rev of flags.rest) {
      const sha = this.resolveRev(repo, state, rev);
      if (!sha) this.die(`fatal: bad revision '${rev}'`);
      const commit = repo.commits.get(sha);
      const parentTree = commit.parents[0] ? repo.trees.get(repo.commits.get(commit.parents[0]).tree) : new Map();
      const theirTree = repo.trees.get(commit.tree);
      const ours = new Map(this.headTree(repo, state));
      for (const path of new Set([...parentTree.keys(), ...theirTree.keys()])) {
        const before = parentTree.get(path); const after = theirTree.get(path);
        if (before === after) continue;
        if (ours.get(path) !== before && ours.get(path) !== after) this.die(`error: could not apply ${sha.slice(0, 7)}... ${commit.message}\nCONFLICT (content): Merge conflict in ${path}`, 1);
        if (after === undefined) ours.delete(path); else ours.set(path, after);
      }
      for (const [path, blob] of ours) { const full = join(worktree, path); mkdirSync(dirname(full), { recursive: true }); writeFileSync(full, repo.blobs.get(blob)); }
      state.index = new Map(ours);
      if (!(flags.n || flags['no-commit'])) this.commit(repo, state, { message: commit.message, allowEmpty: true, env: {} });
    }
    return '';
  }

  cmd_clean({ dir, gitDir, argv }) {
    const flags = parse(argv, [], ['f', 'd', 'x', 'q', 'ffdx', 'fd', 'fdx']);
    const { repo, worktree, state } = this.worktreeOf(dir, gitDir);
    const files = this.workingFiles(repo, worktree);
    for (const path of files.keys()) if (!state.index.has(path)) rmSync(join(worktree, path), { force: true });
    void flags;
    return '';
  }

  /** A regular-file ustar stream, preserving the requested tree paths for tar -x. */
  cmd_archive({ dir, gitDir, argv }) {
    const flags = parse(argv, { format: 1 }, []);
    if (flags.format !== 'tar') return this.refuse(['archive', ...argv], 'only --format=tar is modelled');
    const { repo, worktree } = this.repoAt(dir, gitDir);
    const state = worktree ? repo.worktrees.get(worktree) : null;
    const [rev, ...paths] = flags.rest.filter((arg) => arg !== '--');
    const sha = this.resolveRev(repo, state, rev);
    if (!sha) this.die(`fatal: not a valid object name: ${rev}`);
    const tree = repo.trees.get(repo.commits.get(sha)?.tree ?? sha);
    const entries = [...tree].filter(([path]) => !paths.length || paths.some((spec) => pathspecMatches(spec, path)));
    if (paths.some((spec) => !entries.some(([path]) => pathspecMatches(spec, path)))) this.die('fatal: pathspec did not match any files');
    const blocks = [];
    for (const [path, blob] of entries) {
      if (Buffer.byteLength(path) > 100) return this.refuse(['archive', ...argv], 'tar path longer than 100 bytes');
      const bytes = repo.blobs.get(blob);
      const header = Buffer.alloc(512);
      const octal = (offset, width, value) => header.write(`${value.toString(8).padStart(width - 1, '0')}\0`, offset, width, 'ascii');
      header.write(path, 0, 100);
      octal(100, 8, 0o644); octal(108, 8, 0); octal(116, 8, 0);
      octal(124, 12, bytes.length); octal(136, 12, 0);
      header.fill(32, 148, 156);
      header.write('0', 156); header.write('ustar\0', 257); header.write('00', 263);
      const checksum = header.reduce((sum, byte) => sum + byte, 0);
      header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
      blocks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
    }
    blocks.push(Buffer.alloc(1024));
    return ok(Buffer.concat(blocks));
  }
  /**
   * `git grep -l -F [--] <text> [-- <pathspec>…]`: the tracked files whose
   * working copy holds the text, exit 1 when none does. Anything else is refused.
   */
  cmd_grep({ dir, gitDir, argv, env }) {
    const flags = parse(argv, [], ['l', 'F', 'files-with-matches', 'fixed-strings']);
    if (!(flags.l || flags['files-with-matches']) || !(flags.F || flags['fixed-strings'])) return this.refuse(['grep', ...argv], 'grep without -l -F');
    const rest = flags.rest[0] === '--' ? flags.rest.slice(1) : flags.rest;
    const [text, ...after] = rest;
    if (text === undefined) this.die('fatal: no pattern given');
    const paths = after.filter((p) => p !== '--');
    const { repo, worktree, state } = this.worktreeOf(dir, gitDir);
    const index = this.indexFor(repo, state, env);
    const hits = [...index.keys()].sort()
      .filter((path) => !paths.length || paths.some((p) => pathspecMatches(p, path)))
      .filter((path) => existsSync(join(worktree, path)) && readFileSync(join(worktree, path), 'utf8').includes(text));
    if (!hits.length) this.die('', 1);
    return hits.map((path) => `${path}\n`).join('');
  }
  cmd_ls_tree({ dir, gitDir, argv }) {
    const flags = parse(argv, [], ['r', 'd', 'name-only', 'z', 'full-tree']);
    const { repo, worktree } = this.repoAt(dir, gitDir);
    const state = worktree ? repo.worktrees.get(worktree) : null;
    const [rev, ...paths] = flags.rest.filter((arg) => arg !== '--');
    const sha = this.resolveRev(repo, state, rev);
    if (!sha) this.die(`fatal: Not a valid object name ${rev}`);
    const tree = repo.trees.get(repo.commits.get(sha)?.tree ?? sha);
    const nul = flags.z ? '\0' : '\n';
    if (flags.d) {
      // Trees only, as git names them: `dir` is the directory itself, `dir/`
      // the directories directly inside it.
      const dirs = new Set();
      for (const path of tree.keys()) {
        for (const p of paths) {
          if (p.endsWith('/') && path.startsWith(p) && path.slice(p.length).includes('/')) dirs.add(`${p}${path.slice(p.length).split('/')[0]}`);
          else if (!p.endsWith('/') && path.startsWith(`${p}/`)) dirs.add(p);
        }
      }
      return [...dirs].sort()
        .map((p) => (flags['name-only'] ? `${p}${nul}` : `040000 tree ${createHash('sha1').update(`tree ${sha} ${p}`).digest('hex')}\t${p}${nul}`)).join('');
    }
    return [...tree.entries()].filter(([path]) => !paths.length || paths.some((p) => path === p || path.startsWith(`${p.replace(/\/$/u, '')}/`))).sort()
      .map(([path, blob]) => (flags['name-only'] ? `${path}${nul}` : `100644 blob ${blob}\t${path}${nul}`)).join('');
  }
  cmd_commit_tree({ dir, gitDir, argv }) {
    const flags = parse(argv, { m: 1, p: 1 }, []);
    const { repo } = this.repoAt(dir, gitDir);
    const [tree] = flags.rest;
    if (!repo.trees.has(tree)) this.die(`fatal: not a valid object name ${tree}`);
    const sha = sha1(`commit ${tree} ${flags.p ?? ''} ${flags.m ?? ''} ${repo.serial++}`);
    repo.commits.set(sha, { tree, parents: flags.p ? [flags.p] : [], message: flags.m ?? '' });
    return `${sha}\n`;
  }
  cmd_hash_object({ dir, gitDir, argv, input }) {
    const flags = parse(argv, [], ['w', 'stdin']);
    const { repo } = this.repoAt(dir, gitDir);
    const bytes = flags.stdin ? Buffer.from(String(input ?? '')) : readFileSync(resolve(dir, flags.rest[0]));
    return `${this.blob(repo, bytes)}\n`;
  }
  cmd_rm({ dir, gitDir, argv, env }) {
    const flags = parse(argv, [], ['q', 'quiet', 'f', 'force', 'r', 'cached']);
    const { repo, worktree, state } = this.worktreeOf(dir, gitDir);
    const index = this.indexFor(repo, state, env);
    for (const arg of flags.rest.filter((item) => item !== '--')) {
      const path = relative(worktree, resolve(real(dir), arg));
      const paths = [...index.keys()].filter((entry) => entry === path || entry.startsWith(`${path}/`));
      if (!paths.length) this.die(`fatal: pathspec '${arg}' did not match any files`);
      for (const entry of paths) { index.delete(entry); if (!flags.cached) rmSync(join(worktree, entry), { force: true }); }
    }
    return '';
  }

  cmd_mv({ dir, gitDir, argv, env }) {
    const flags = parse(argv, [], ['q', 'quiet', 'f', 'force', 'k']);
    const { repo, worktree, state } = this.worktreeOf(dir, gitDir);
    const index = this.indexFor(repo, state, env);
    const [from, to] = flags.rest.map((arg) => relative(worktree, resolve(real(dir), arg)));
    if (!index.has(from)) this.die(`fatal: not under version control, source=${from}, destination=${to}`);
    mkdirSync(dirname(join(worktree, to)), { recursive: true });
    writeFileSync(join(worktree, to), readFileSync(join(worktree, from)));
    rmSync(join(worktree, from), { force: true });
    index.set(to, index.get(from));
    index.delete(from);
    return '';
  }

  cmd_update_index({ dir, gitDir, argv, env }) {
    const flags = parse(argv, { cacheinfo: 1 }, ['add', 'remove', 'refresh', 'q', 'really-refresh']);
    const { repo, worktree, state } = this.worktreeOf(dir, gitDir);
    const index = this.indexFor(repo, state, env);
    const files = this.workingFiles(repo, worktree);
    for (const path of flags.rest.filter((arg) => arg !== '--')) {
      if (flags.remove && !files.has(path)) index.delete(path);
      else if (files.has(path)) index.set(path, files.get(path));
      else if (flags.add) this.die(`error: ${path}: does not exist and --remove not passed`);
    }
    return '';
  }
}

/**
 * A small argv parser: `valued` names flags that take a value (as a map of
 * name → 1, or a list), `boolean` names flags that do not. Combined short
 * flags (`-qm`, `-qc`, `-am`) are kept whole when they are declared. Anything
 * else is a positional in `rest`. Unknown flags are kept in `rest` too, so a
 * command can refuse them.
 */
/** A shell glob (`*`, `?`) as git's wildmatch reads it without `**`: `*` crosses `/`. */
function globMatches(pattern, text) {
  const source = [...pattern].map((ch) => (ch === '*' ? '.*' : ch === '?' ? '.' : ch.replace(/[.+^${}()|[\]\\]/u, '\\$&'))).join('');
  return new RegExp(`^${source}$`, 'su').test(text);
}

/** Whether a pathspec names a path: itself, a directory above it, `.`, or a glob over it. */
function pathspecMatches(spec, path) {
  if (spec === '.' || path === spec || path.startsWith(`${spec.replace(/\/$/u, '')}/`)) return true;
  return /[*?]/u.test(spec) && globMatches(spec, path);
}

function parse(argv, valued = {}, boolean = []) {
  const takesValue = new Set(Array.isArray(valued) ? valued : Object.keys(valued).filter((key) => valued[key] === 1));
  const noValue = new Set(Array.isArray(valued) ? [] : Object.keys(valued).filter((key) => valued[key] === 0));
  const flags = { rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') { flags.rest.push('--', ...argv.slice(i + 1)); break; }
    if (!arg.startsWith('-') || arg === '-') { flags.rest.push(arg); continue; }
    const name = arg.replace(/^--?/u, '');
    const [bare, inline] = name.includes('=') ? [name.slice(0, name.indexOf('=')), name.slice(name.indexOf('=') + 1)] : [name, undefined];
    if (takesValue.has(bare)) { flags[bare] = inline ?? argv[++i]; continue; }
    if (noValue.has(bare)) { flags[bare] = inline ?? true; continue; }
    if (boolean.includes(bare)) { flags[bare] = true; continue; }
    if (bare.startsWith('porcelain')) { flags.porcelain = true; continue; }
    if (bare.startsWith('untracked-files')) { flags['untracked-files'] = inline ?? 'all'; continue; }
    // A run of short booleans, like `-qf`.
    if (!arg.startsWith('--') && [...bare].every((ch) => boolean.includes(ch) || takesValue.has(ch))) {
      for (const ch of bare) { if (takesValue.has(ch)) flags[ch] = argv[++i]; else flags[ch] = true; }
      continue;
    }
    flags.rest.push(arg);
  }
  return flags;
}

export { parse as parseGitArgs };

/** Minimal line edit script via LCS; unchanged lines never become additions. */
function zeroContextDiff(before, after) {
  const lengths = Array.from({ length: before.length + 1 }, () => new Uint32Array(after.length + 1));
  for (let i = before.length - 1; i >= 0; i--) for (let j = after.length - 1; j >= 0; j--) {
    lengths[i][j] = before[i] === after[j] ? lengths[i + 1][j + 1] + 1 : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
  }
  let i = 0; let j = 0; let output = '';
  while (i < before.length || j < after.length) {
    if (i < before.length && j < after.length && before[i] === after[j]) { i++; j++; continue; }
    const startI = i; const startJ = j; const edits = [];
    while ((i < before.length || j < after.length) && !(i < before.length && j < after.length && before[i] === after[j])) {
      if (j < after.length && (i === before.length || lengths[i][j + 1] > lengths[i + 1][j])) edits.push(`+${after[j++]}\n`);
      else edits.push(`-${before[i++]}\n`);
    }
    const countI = i - startI; const countJ = j - startJ;
    const range = (start, count) => count === 1 ? `${start + 1}` : `${count ? start + 1 : start},${count}`;
    output += `@@ -${range(startI, countI)} +${range(startJ, countJ)} @@\n${edits.join('')}`;
  }
  return output;
}
