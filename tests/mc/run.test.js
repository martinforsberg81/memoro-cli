import { createDiskPressure } from '../../src/mc/disk-pressure.js';
import { effortArgs as codexEffortArgs } from '../../src/adapters/codex.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MEMORY_MIN_FREE_PERCENT, RUNNER_LOG_MAX_BYTES, createRunner, dockerNote, realDeps, runLoop, UPDATE_POLL_MS } from '../../src/mc/run.js';
import { freeMemoryPercent } from '../../src/mc/dev-servers.js';
import { rotateIfLarge } from '../../src/mc/logger.js';
import { COOLDOWN_MS, EVENTS_KEEP, POLL_MS } from '../../src/mc/disk-pressure.js';
import { parseGoal, parseLog, redMergeText, STAGES } from '../../src/mc/goals.js';
import { mcCheckout } from '../../src/mc/run-control.js';
import { TIDY_KIND } from '../../src/mc/run-plan.js';
import * as claudeAdapter from '../../src/adapters/claude-code.js';
import { expandRoleIncludes, sharedRoleText, textDigest } from '../../src/mc/roles.js';
import { applyObservation, applyRefusal, normaliseCapacity } from '../../src/mc/model-capacity.js';
import { DEFAULT_CATALOG } from '../../src/mc/model-config.js';
import { goalField, goalJson, withGoal } from './_helpers/goal-file.js';
import { run as goalCommand } from '../../src/mc/commands/goal.js';

/**
 * The project a path under the fixture's root belongs to: `/w/step/<p>/…`
 * (ruling 39) or `/w/<p>/…`, an area from before `step/`.
 */
const areaOf = (path) => { const parts = String(path).split('/'); return parts[2] === 'step' ? parts[3] : parts[2]; };

/**
 * A plan of `plans` as `~/mc/programs/` holds it: naming its repository in
 * `repo`, written first so the plan's own text stays as the test wrote it. A
 * text that is not a JSON object names none.
 */
const namingRepo = (text, repo) => (/^\s*\{/u.test(text) ? text.replace(/^\s*\{/u, `{\n  "repo": ${JSON.stringify(repo)},`) : text);

/** The capacity snapshot a fixture holds in memory (ruling 59), read and written whole as model-capacity.js does on disk. */
function capacityHandle(initial = null) {
  let state = normaliseCapacity(initial);
  return { read: () => state, write: (next) => { state = normaliseCapacity(next); } };
}
/** The instant a fixture's clock starts at, and the snapshots below are observed at. */
const ROUTING_NOW = new Date('2026-08-29T10:00:00Z');
const windowAt = (fraction) => ({ fraction_used: fraction, resets_at: '2026-08-29T13:00:00Z' });
const LUNA = [{ id: 'gpt-6-luna', efforts: ['high'] }];
/** What each provider was seen to have, as the runner holds it at ROUTING_NOW: its usage fraction, and a refusal until an instant. */
function capacityWith({ claude = null, codex = null, refuse = {} } = {}) {
  let state = normaliseCapacity(null);
  if (claude !== null) state = applyObservation(state, 'claude', { windows: { five_hour: windowAt(claude), seven_day: windowAt(claude) } }, ROUTING_NOW);
  if (codex !== null) state = applyObservation(state, 'codex', { windows: { primary: windowAt(codex), secondary: windowAt(codex) }, models: LUNA }, ROUTING_NOW);
  for (const [provider, until] of Object.entries(refuse)) state = applyRefusal(state, provider, until);
  return state;
}

/**
 * A whole runner on fakes: a work root in memory, two repositories whose
 * plans (`plans`, per repository) are under `/w/programs/prog/`, git/gh/tmux
 * answered from tables, and a "session" that returns what the test says.
 * Nothing starts, nothing is written outside `files`.
 */
function fixture({ plans = {}, queue = '', session, gh = {}, dirty = [], unmerged = [], live = [], areas = {}, conflicts = {}, mergeRefused = [], headFiles = {}, mergeLeft = [], roles = true, livePids = [], now = '2026-08-29T10:00:00Z', runs = null, collect = okCollect, helperTurn = okTurn, inbox = [], projectLog = {}, archive = {}, landed = [], removeFails = [], heads = {}, openPrs = {}, prsFail = [], refs = {}, fetchFails = [], rounds = {}, rebaseFails = [], prFiles = {}, block = {}, commitFails = [], conflicted = [], merged = {}, tips = {}, mergeRows = {}, stopResults = {}, revList = {}, notInMain = [], gateBusy = [], attach = { ok: true, state: 'attached', why: 'reused' }, nightly = async () => ({ at: null, runs: [], skipped: null, stopped: false }), capacity = null } = {}) {
  const root = '/w';
  const files = { [`${root}/queue.md`]: queue };
  if (runs != null) files[`${root}/runner/log/runs.tsv`] = runs;
  const dirs = new Set([root]);
  // `~/mc/intake/` as the drain finds it. `decisions-archive/` is there in
  // reality and is a directory, so the fixture keeps one: a drain that took it
  // would archive an archive.
  if (inbox.length) {
    dirs.add(`${root}/intake`);
    dirs.add(`${root}/intake/decisions-archive`);
    files[`${root}/intake/decisions-archive/mc-2.md`] = '# an answered decision';
    for (const name of inbox) files[`${root}/intake/${name}`] = `# ${name}`;
  }
  const env = { MC_WORK_ROOT: root, MC_REPOS_HOME: '/home' };
  const repos = { memoro: '/home/memoro', 'memoro-cli': '/home/memoro-cli' };
  for (const repo of Object.keys(repos)) files[`${repos[repo]}/.git`] = '';
  // Areas that already exist: name -> { repo, planText } — the plan is on the branch too.
  for (const [name, area] of Object.entries(areas)) {
    files[`${root}/${name}/${area.repo}/.git`] = '';
    dirs.add(`${root}/${name}`);
    // The checkout itself, not only its `.git`: `runStep` asks whether the
    // worktree is there before it makes one, and an area whose directory does
    // not exist was quietly re-created from origin/main — which overwrote the
    // very plan the fixture had put on its branch.
    dirs.add(`${root}/${name}/${area.repo}`);
    if (area.plan) {
      files[`${root}/${name}/${area.repo}/docs/project/${area.programme}/${name}/PLAN.json`] = area.plan;
      dirs.add(`${root}/${name}/${area.repo}/docs/project`);
    }
    for (const [file, text] of Object.entries(area.decisions || {})) {
      files[`${root}/${name}/decisions/${file}`] = text;
      dirs.add(`${root}/${name}/decisions`);
    }
  }
  // `plans` as `/w/programs/prog/<project>/PLAN.json`, read at every call so a
  // test that changes `plans` mid-run changes what the runner reads; a file the
  // test or the runner wrote at that path wins.
  const held = () => {
    const out = {};
    for (const [repoName, projects] of Object.entries(plans)) {
      for (const [project, text] of Object.entries(projects || {})) {
        if (text != null) out[`${root}/programs/prog/${project}/PLAN.json`] = namingRepo(text, repoName);
      }
    }
    return out;
  };
  const log = [];
  const aborted = new Set();
  const calls = { stopped: [], git: [], gh: [], sessions: [], added: [], removed: [], collects: [], turns: [], rm: [], moved: [], rmdirs: [], rmScratch: [], checkouts: [], rounds: [], docsRounds: [], ticks: [], shelved: [], attached: [] };
  /** `/w/runner/archive/<repo>` — the worktree the runner archives in. */
  const archiveRoot = `${root}/runner/archive`;
  /** `/w/runner/block/<repo>` — and the one it writes a blocked step in. */
  const blockRoot = `${root}/runner/block`;
  // A snapshot of the work root taken inside every session call — the only
  // way to see the files that exist only while a step is in flight.
  const duringSession = [];
  // A scratch directory's mtime, by path; one not named here is as old as `now`.
  const scratchAges = {};
  const deps = {
    env,
    // The runner and tidy share this short owner/allocation lock. Fixture
    // work stays synchronous while exercising the same critical sections.
    lock: (_root, fn) => fn(),
    now: () => new Date(now),
    sleep: async () => {},
    // What `lanes.json` says, from the fixture rather than from the machine
    // running the suite: `runLoop` reads it at start, and without this a test
    // would answer to whatever `mc run lanes` was last set to on this laptop.
    laneCount: () => ({ lanes: 2 }),
    // Stay-awake from the fixture too: the real one spawns `caffeinate -w` and
    // runs `pmset`, and every unattended runLoop here left a caffeinate behind
    // for as long as the test file lived (17 in one hung run, 2026-10-19).
    keepAwake: () => ({ ok: true, pid: 0, flags: [], note: 'fixture' }),
    onACPower: () => true,
    tmuxHas: (name) => live.includes(name.replace(/^mc-/u, '')),
    // The liveness test the loop's own refusal uses. A table, not `ps`: a
    // fixture pid that happened to be a real process on the machine running
    // the suite would make these tests answer to something outside them.
    alive: (pid) => livePids.includes(Number(pid)),
    exists: (p) => p in files || dirs.has(p) || p in held(),
    read: (p) => files[p] ?? held()[p] ?? null,
    list: (p) => {
      // `step/<p>` is listed as `step`, as a directory listing would.
      if (p === root) return [...new Set(Object.keys(areas).map((name) => name.split('/')[0]))];
      const prefix = `${p}/`;
      const seen = new Set();
      for (const key of [...Object.keys(files), ...Object.keys(held())]) if (key.startsWith(prefix)) seen.add(key.slice(prefix.length).split('/')[0]);
      return [...seen];
    },
    // Files only — what `readdirSync(dir, { withFileTypes: true })` filtered to
    // `isFile()` answers, so the drain never takes a directory for an item.
    files: (p) => {
      const prefix = `${p}/`;
      return Object.keys(files)
        .filter((key) => key.startsWith(prefix) && !key.slice(prefix.length).includes('/'))
        .map((key) => key.slice(prefix.length))
        .filter((name) => !dirs.has(`${p}/${name}`));
    },
    write: (p, t) => { files[p] = t; },
    append: (p, t) => { files[p] = (files[p] || '') + t; },
    // Closing a workarea moves everything it kept and then takes the empty
    // folder: both are recorded, so a test can say what was moved where.
    move: (from, to) => {
      const prefix = `${from}/`;
      let moved = false;
      for (const key of Object.keys(files)) {
        if (key !== from && !key.startsWith(prefix)) continue;
        files[key === from ? to : to + key.slice(from.length)] = files[key];
        delete files[key];
        moved = true;
      }
      for (const dir of [...dirs]) if (dir === from || dir.startsWith(prefix)) { dirs.delete(dir); dirs.add(to + dir.slice(from.length)); moved = true; }
      calls.moved.push([from, to]);
      return moved;
    },
    rmdir: (p) => {
      dirs.delete(p);
      calls.rmdirs.push(p);
      return true;
    },
    // A closing workarea's dev servers: recorded with how many git calls had
    // been made, so a test can say the stop came before `git worktree remove`.
    stopServersUnder: (path, options) => {
      calls.stopped.push({ path, reason: options?.reason, gitCallsBefore: calls.git.length });
      return stopResults[path] || { stopped: [], failed: [] };
    },
    writeJson: (p, v) => { files[p] = `${JSON.stringify(v, null, 2)}\n`; },
    remove: (p) => { if (!(p in files)) return false; delete files[p]; calls.removed.push(p); return true; },
    // The scratch directories of `/w/runner/scratch/`, with an age each.
    mkdir: (p) => { dirs.add(p); },
    scratchDirs: (p) => [...dirs].filter((d) => d.startsWith(`${p}/`) && !d.slice(p.length + 1).includes('/'))
      .map((d) => ({ name: d.slice(p.length + 1), mtimeMs: scratchAges[d] ?? Date.parse(now) })),
    rmTree: (p) => { dirs.delete(p); calls.rmScratch.push(p); return true; },
    // The archive moves a done project's directory: recorded here, not moved, as the fixture's files are not the disk's.
    shelve: (dir, programme, project) => { calls.shelved.push([dir, programme, project]); return `/w/archive/projects/${programme}/${project}`; },
    // The model catalog and the capacity snapshot (ruling 59): the defaults, and the snapshot a test
    // starts from, read and written back through `deps.capacity`.
    catalog: () => structuredClone(DEFAULT_CATALOG),
    capacity: capacityHandle(capacity),
    pid: 4242,
    addWorktree: ({ name, repo }) => {
      const repoName = repo.split('/').at(-1);
      const project = name.split('/').at(-1);
      calls.added.push(name);
      files[`${root}/${name}/${repoName}/.git`] = '';
      dirs.add(`${root}/${name}`);
      const text = plans[repoName]?.[project];
      if (text) {
        files[`${root}/${name}/${repoName}/docs/project/prog/${project}/PLAN.json`] = text;
        dirs.add(`${root}/${name}/${repoName}/docs/project`);
      }
      return { ok: true, path: `${root}/${name}/${repoName}` };
    },
    // The attach before a step, faked: `calls.attached` says where it ran and how
    // many sessions had been launched by then.
    attachDeps: async (worktree) => { calls.attached.push({ worktree, sessionsBefore: calls.sessions.length }); return attach; },
    collect: async (options) => { calls.collects.push(options); return collect(options); },
    helperTurn: async (options) => { calls.turns.push(options); return helperTurn(options); },
    // The nightly's tick, faked: what proves it ran is `calls.ticks` and its row.
    nightlyTick: async (options) => { calls.ticks.push(options); return nightly(options); },
    // The one door, faked (ruling 30): the merger's queue. What the real
    // `queueMerge` writes first — the step `landing` with its pull request —
    // is written here into the fixture's register; the job itself is
    // `calls.rounds`. No merger runs: what it answers is each test's to say.
    queueMerge: (options) => {
      calls.rounds.push(options);
      void rounds;
      if (options.step) {
        const at = `${root}/runner/projects/${options.step.project}.json`;
        const entry = JSON.parse(files[at]);
        entry.steps[options.step.index] = { ...entry.steps[options.step.index], status: 'landing', pr: options.pr, session: null };
        files[at] = JSON.stringify(entry);
      }
      return { place: 0, merger: { pid: 9, started: true }, already: false };
    },
    docsMerge: async (options) => {
      calls.docsRounds.push(options);
      // Two docs pull requests go through this door — the archive's and the
      // blocked step's — and they are told apart by the worktree they were
      // opened in, so a test can refuse one without refusing the other.
      const table = options.repoPath.startsWith(`${blockRoot}/`) ? block : archive;
      const a = table[Object.keys(table).find((r) => options.repoPath.endsWith(`/${r}`)) || ''] || {};
      return a.mergeFails
        ? { ok: false, merged: false, stopped_at: 'merge', reason: 'nope', pr: { number: options.pr } }
        : { ok: true, merged: true, merged_into: 'main', pr: { number: options.pr } };
    },
    // The repositories whose gate lane a round holds (gate-lock.js): none unless a test says so.
    gateBusy: (name) => gateBusy.includes(name),
    role: (kind) => (roles ? { name: kind, overlay: `ROLE ${kind}` } : null),
    // `modelArgs` guards on a missing model exactly as both real adapters do:
    // no model named means no flag, not `--model null`. Effort and advisor
    // are the claude adapter's own, so a step's argument list here is the
    // one claude gets.
    launch: (tool) => ({
      ok: true, id: tool === 'codex' ? 'codex' : 'claude-code', shortName: tool,
      adapter: tool === 'codex'
        ? { modelArgs: (m) => (m ? ['--model', m] : []) }
        : { modelArgs: (m) => (m ? ['--model', m] : []), effortArgs: claudeAdapter.effortArgs, advisorArgs: claudeAdapter.advisorArgs },
      spec: { bin: `/bin/${tool}` },
    }),
    session: (call) => { calls.sessions.push(call); duringSession.push(structuredClone(files)); return session(call); },
    log: (line) => log.push(line),
    git: (cwd, args) => {
      calls.git.push([cwd, ...args]);
      const repoName = Object.keys(repos).find((r) => cwd === repos[r]);
      // The branch's own last committed copy of a file. Nothing in the runner
      // reads this any more (`planOf` lost `fromHead` on 2026-09-08); it is
      // kept so a test can assert that HEAD is not read at all.
      if (args[0] === 'show' && String(args[1]).startsWith('HEAD:')) {
        const at = args[1].slice('HEAD:'.length);
        const held = (headFiles[areaOf(cwd)] || {})[at];
        return { ok: true, stdout: held ?? files[`${cwd}/${at}`] ?? '' };
      }
      if (args[0] === 'ls-tree' && repoName) {
        return { ok: true, stdout: Object.keys(plans[repoName] || {}).map((n) => `docs/project/prog/${n}/PLAN.json`).join('\n') };
      }
      if (args[0] === 'show' && repoName) {
        // The project log is read straight off origin/main at the end of a
        // round: it is what says a folder was a project once its plan has gone.
        if (args[1].endsWith(':docs/project/project_log.md')) {
          return { ok: true, stdout: projectLog[repoName] ?? '' };
        }
        const name = args[1].split('/').at(-2);
        return { ok: true, stdout: (plans[repoName] || {})[name] };
      }
      // `git worktree add -b <branch> <path> origin/main` in a repository:
      // origin/main checked out, which here is its plans and its project log.
      // `git worktree remove <path>` — the checkout is handed back, so its
      // files go with it and the folder above is left holding its filing.
      // `--force` is the archive worktree being taken down, which the archive
      // tests read the files of afterwards; only a workarea's is emptied here.
      if (args[0] === 'worktree' && args[1] === 'remove' && args[2] !== '--force') {
        const prefix = `${args.at(-1)}/`;
        for (const key of Object.keys(files)) if (key.startsWith(prefix)) delete files[key];
        for (const dir of [...dirs]) if (dir === args.at(-1) || dir.startsWith(prefix)) dirs.delete(dir);
        return { ok: !removeFails.includes(areaOf(args.at(-1))), stdout: '' };
      }
      if (args[0] === 'worktree' && args[1] === 'add' && repoName) {
        const path = args[4];
        for (const [name, text] of Object.entries(plans[repoName] || {})) files[`${path}/docs/project/prog/${name}/PLAN.json`] = text;
        files[`${path}/docs/project/project_log.md`] = projectLog[repoName] ?? '';
        return { ok: true, stdout: '' };
      }
      if (args[0] === 'rm') {
        const prefix = `${cwd}/${args.at(-1)}/`;
        calls.rm.push(args.at(-1));
        for (const key of Object.keys(files)) if (key.startsWith(prefix)) delete files[key];
        return { ok: true, stdout: '' };
      }
      if (args[0] === 'remote') return { ok: true, stdout: `git@github.com:o/${repoName || 'r'}.git` };
      if (args[0] === 'log') return { ok: true, stdout: 'abc1234' };
      // A merge left in a workarea is a dirty worktree too — `UU` is what
      // `git status --porcelain` writes for a path it stopped on, and the
      // round skips the project on it exactly as it does on a modified file.
      if (args[0] === 'status') {
        // A merge in progress with its rows as git writes them; once aborted,
        // only what a merge does not own is left — a worktree change or an
        // untracked file (second column not blank), never a staged row.
        const rows = mergeRows[areaOf(cwd)];
        if (rows) {
          const left = aborted.has(cwd) ? rows.filter((row) => row[1] !== ' ' && !/^(?:DD|AU|UD|UA|DU|AA|UU)/u.test(row)) : rows;
          return { ok: true, stdout: left.join('\n') };
        }
        if (unmerged.some((d) => cwd.includes(`/${d}/`))) return { ok: true, stdout: 'UU canon/roles/step.md\n?? scratch.md' };
        return { ok: true, stdout: dirty.some((d) => cwd.includes(`/${d}/`)) ? ' M x' : '' };
      }
      // A fetch a workarea cannot do: `syncMain` gives up on it, and no
      // reading of the files could have known beforehand.
      if (args[0] === 'fetch' && fetchFails.includes(areaOf(cwd))) return { ok: false, stdout: '', stderr: 'could not read from remote' };
      if (args[0] === 'merge' && args[1] === '--abort') { aborted.add(cwd); return { ok: true, stdout: '' }; }
      if (args[0] === 'merge' && args.includes('origin/main')) {
        const name = areaOf(cwd);
        if (mergeRefused.includes(name)) return { ok: false, stdout: '', stderr: 'fatal: refusing to merge unrelated histories' };
        return conflicts[name] ? { ok: false, stdout: '', stderr: 'CONFLICT' } : { ok: true, stdout: '' };
      }
      if (args[0] === 'diff') return { ok: true, stdout: (conflicts[areaOf(cwd)] || []).join('\n') };
      // `rev-parse -q --verify MERGE_HEAD` asks whether the session left the
      // merge unfinished — `mergeLeft` names the workareas where it did, and
      // the answer is otherwise no. `rev-parse origin/main^{tree}` is
      // branchLanded's base.
      if (args[0] === 'rev-parse') {
        if (args.at(-1) === 'MERGE_HEAD') return { ok: mergeLeft.includes(areaOf(cwd)) || (areaOf(cwd) in mergeRows && !aborted.has(cwd)), stdout: 'mergehead' };
        if (args[1] === 'origin/main^{tree}') return { ok: true, stdout: 'basetree' };
        // `rev-parse --abbrev-ref HEAD` in a workarea's checkout: the branch
        // it actually sits on. `heads` names the ones that are not the folder.
        if (args[1] === '--abbrev-ref') {
          const head = heads[areaOf(cwd)];
          return head ? { ok: true, stdout: head } : { ok: false, stdout: '' };
        }
        // `rev-parse -q --verify refs/heads/<b>` — has this workarea that
        // branch at all? The same `refs` table the checkout below answers
        // from, so the round and the reading cannot be told two things.
        if (args.includes('--verify')) {
          const ref = String(args.at(-1)).replace(/^refs\/heads\//u, '');
          return { ok: (refs[areaOf(cwd)] || [areaOf(cwd)]).includes(ref), stdout: 'deadbee' };
        }
        // `rev-parse <branch>`: the tip `freshBranch` compares to the merged head.
        if (args.length === 2) return { ok: true, stdout: tips[args[1]] || `tip-${args[1]}` };
        return { ok: false, stdout: '' };
      }
      if (args[0] === 'merge-tree' && conflicted.includes(args.at(-1))) return { ok: false, stdout: 'CONFLICT' };
      if (args[0] === 'merge-tree') return { ok: true, stdout: landed.includes(args.at(-1)) ? 'basetree' : 'othertree' };
      // Where a stacked branch left its base, and the replay onto the squash
      // that landed under it. `rebaseFails` names the branches that conflict.
      // A branch's commits that the merged head lacks (`rev-list`, the range
      // `<head>...<branch>`), and which of them origin/main already has by
      // patch. `revList` answers the first, `notInMain` the second.
      if (args[0] === 'rev-list') { const range = args.find((a) => a.includes('...')); if (range in revList) return { ok: true, stdout: revList[range] }; }
      if (args[0] === 'merge-base' && args[1] === '--is-ancestor' && notInMain.includes(args[2])) return { ok: false, stdout: '' };
      if (args[0] === 'merge-base') return { ok: true, stdout: `forked-${args.at(-1)}` };
      if (args[0] === 'rebase') return { ok: !rebaseFails.includes(args.at(-1)), stdout: '', stderr: 'CONFLICT' };
      // The branches that already exist, local and on the remote — what
      // `<name>-<n>` has to step over. `refs` names them per workarea.
      if (args[0] === 'for-each-ref') return { ok: true, stdout: (refs[areaOf(cwd)] || []).join('\n') };
      if (args[0] === 'ls-remote') return { ok: true, stdout: (refs[areaOf(cwd)] || []).map((b) => `deadbee\trefs/heads/${b}`).join('\n') };
      if (args[0] === 'checkout' && args.includes('-b')) { calls.checkouts.push([cwd, args[args.indexOf('-b') + 1]]); heads[areaOf(cwd)] = args[args.indexOf('-b') + 1]; return { ok: true, stdout: '' }; }
      // `git checkout -q <branch>` — the repair path standing on the branch its
      // pull request is on. It works when the workarea has that branch, which
      // is the one fact `refs` holds.
      if (args[0] === 'checkout' && args.length === 3 && args[1] === '-q') {
        const area = areaOf(cwd);
        if (!(refs[area] || [area]).includes(args[2])) return { ok: false, stdout: '', stderr: `error: pathspec '${args[2]}' did not match` };
        calls.checkouts.push([cwd, args[2]]);
        heads[area] = args[2];
        return { ok: true, stdout: '' };
      }
      // A commit this workarea will not make — the merge of origin/main
      // resolved and refused, which is a fact about the workarea and blocks the
      // step. Named per workarea, so the block's own commit is never the one
      // that fails.
      if (args[0] === 'commit' && commitFails.includes(areaOf(cwd))) {
        return { ok: false, stdout: '', stderr: 'error: could not commit' };
      }
      // `git branch --show-current`: the branch the workarea stands on, which
      // is the folder's name unless `heads` says otherwise.
      if (args[0] === 'branch') return { ok: true, stdout: heads[areaOf(cwd)] || areaOf(cwd) };
      return { ok: true, stdout: '', stderr: '' };
    },
    gh: (cwd, args) => {
      calls.gh.push([cwd, ...args]);
      // The archive PR: opened in `/w/runner/archive/<repo>`, and asked for
      // in the repository itself ("is one still open from an earlier round?").
      const repoName = Object.keys(repos).find((r) => cwd === repos[r]);
      if (repoName) {
        // Which files a merged pull request changed, asked of GitHub in the
        // repository itself after the gate landed it — `prFiles` per number,
        // and a pull request nobody named changed nothing interesting.
        if (args[1] === 'view' && args.includes('files')) {
          return { ok: true, stdout: (prFiles[Number(args[2])] || ['README.md']).join('\n') };
        }
        // The round's own question: every open PR of the repository, asked
        // once beside the fetch in `queue()`.
        if (args.includes('--limit')) {
          if (prsFail.includes(repoName)) return { ok: false, stdout: '', stderr: 'gh: not logged in' };
          return { ok: true, stdout: JSON.stringify(openPrs[repoName] || []) };
        }
        const stale = archive[repoName]?.openFromEarlierRound;
        return { ok: true, stdout: stale ? String(stale) : '' };
      }
      if (cwd.startsWith(`${archiveRoot}/`) || cwd.startsWith(`${blockRoot}/`)) {
        const inBlock = cwd.startsWith(`${blockRoot}/`);
        const table = inBlock ? block : archive;
        const a = table[cwd.slice((inBlock ? blockRoot : archiveRoot).length + 1)] || {};
        const number = a.number ?? (inBlock ? 950 : 900);
        if (args[1] === 'create') return a.createFails ? { ok: false, stdout: '', stderr: 'no' } : { ok: true, stdout: `https://github.com/o/r/pull/${number}\n` };
        if (args[1] === 'list') return { ok: true, stdout: String(number) };
        if (args[1] === 'view' && args.includes('mergeable')) return { ok: true, stdout: 'MERGEABLE' };
        if (args[1] === 'view' && args.includes('title')) return { ok: true, stdout: 'Archive' };
        if (args[1] === 'merge') return a.mergeFails ? { ok: false, stdout: '', stderr: 'nope' } : { ok: true, stdout: '' };
        return { ok: true, stdout: '' };
      }
      // A workarea's own checkout: what this project has open *now*, asked
      // again after the session because the session is what changed it.
      // `gh[name]` is one pull request or a stack of them; a head nobody named
      // is the branch the workarea stands on.
      const name = areaOf(cwd);
      // What GitHub says merged from a branch: `merged[branch]` is the list, or
      // the word 'fails' for a `gh` that cannot answer.
      if (args[1] === 'list' && args.includes('merged')) {
        const answer = merged[args[args.indexOf('--head') + 1]];
        if (answer === 'fails') return { ok: false, stdout: '', stderr: 'gh: not logged in' };
        return { ok: true, stdout: JSON.stringify(answer || []) };
      }
      const opened = [gh[name]].flat().filter(Boolean).map((pr) => ({
        number: pr.number,
        title: pr.title || 't',
        isDraft: Boolean(pr.isDraft),
        headRefName: pr.head || heads[name] || name,
        baseRefName: pr.base || 'main',
      }));
      if (args[1] === 'list') return { ok: true, stdout: JSON.stringify(opened) };
      if (args[1] === 'edit') return { ok: true, stdout: '' };
      return { ok: true, stdout: '' };
    },
  };
  return { deps, files, dirs, scratchAges, log, calls, root, duringSession };
}

/** The helper's two halves, faked: a digest that was written and a turn that ran. */
const okCollect = async () => ({
  path: '/w/intake/errors-2026-08-29.md',
  text: '# digest',
  data: {
    delta: { first: false, fingerprints: [{ fingerprint: 'abc', count: 41, loud: true }], failing: [] },
    errors: { rows: [{ fingerprint: 'abc' }] },
    notes: [],
    analysis: {}, provider: {}, health: {}, deploy: {},
  },
});
const okTurn = async () => ({
  ok: true, status: 0, note: 'success', turns: '3', session: 'hsid',
  input: '10', output: '20', cacheRead: '30', cacheWrite: '40',
  wrote: [{ file: '2026-08-29-a.md', title: 'A' }], waiting: [{ file: '2026-08-29-a.md' }], groundNotes: [],
});

/** runs.tsv rows as objects, header and all. */
function runRows(files) {
  const tsv = files['/w/runner/log/runs.tsv'] || '';
  const lines = tsv.split('\n').filter(Boolean);
  if (!lines.length) return [];
  const header = lines[0].split('\t');
  return lines.slice(1).map((line) => Object.fromEntries(line.split('\t').map((cell, i) => [header[i], cell])));
}

/**
 * A plan as the runner now reads it: `PLAN.json`, one step, and a status that
 * belongs to the step rather than to the file. `plan()` is every fixture below
 * — the frontmatter strings these replaced could say `status: ready` while
 * saying nothing a session could act on, which is the fault the schema exists
 * to stop.
 */
function plan({ status = 'ready', title = 'The one step', done_when = 'do x', runner, steps, documents = [], met = status === 'done' } = {}) {
  const stopped = status === 'blocked';
  return JSON.stringify({
    schema: 'mc-plan',
    version: 1,
    goal: ['One thing is true when this is done.'],
    contract: ['Not without Martin.'],
    out_of_scope: ['Everything else.'],
    success_criteria: [{ met, criterion: 'It is done.', check: 'The row is in runs.tsv.' }],
    documents,
    ...(runner ? { runner } : {}),
    steps: steps || [{
      title,
      status,
      done_when,
      instruction: status === 'done' ? [] : ['Do the one step.'],
      pr: null,
      blocked_by: stopped ? { kind: 'decision', name: 'prog-1' } : null,
    }],
  }, null, 2);
}

const ready = plan();

/**
 * What the lane records about the text its session is running on. `kind` has
 * always named the role; this names the revision — the digest is over the
 * assembled instructions, `all-sessions.md` and the overlay joined the
 * way `instructionsFor` joins them, and `text_digest` is over the role's own
 * body alone. `mc roles check build-session:goal` holds both against the files on disk, so a
 * role edited during an hour-long session is something a person can see.
 */
const goalRole = {
  name: 'build-session:goal',
  source: 'canon',
  digest: textDigest(`${expandRoleIncludes(sharedRoleText())}\n\n---\n\nROLE build-session:goal`),
  text_digest: textDigest('ROLE build-session:goal'),
};
const okSession = (json = {}) => () => ({ status: 0, stdout: JSON.stringify({ subtype: 'success', num_turns: 4, session_id: 'sid', usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 }, ...json }), stderr: '', timedOut: false });

/**
 * One lane, driven to a standstill: `pass` takes one step and returns, because
 * the world it picked from is stale the moment a step has run, so a lane loop
 * calls it again. This is that loop without the sleeping — every step that
 * lane would take before it had to wait for something.
 */
async function lane(runner, repo = null) {
  let ran = 0;
  // What this lane already has an answer for. A live lane carries `last`
  // instead and re-reads the world every ten minutes; here there is no clock,
  // so a name that has had its step is not asked for a second one — which is
  // what a round did, once per name.
  const taken = new Set();
  for (;;) {
    const r = await runner.pass({ repo, passed: taken });
    ran += r.ran || 0;
    if (r.stop || !r.ran) return { ran, stop: Boolean(r.stop) };
    taken.add(r.name);
  }
}

/**
 * An unattended run that ends: the first session writes STOP, so the loop
 * takes one step and leaves. There is no `--rounds 1` to bound a run with any
 * more (2026-09-08), and `--once` is a different thing — it holds no
 * caffeinate and runs no chores.
 */
function stopAfterAStep(f) {
  const inner = f.deps.session;
  f.deps.session = (call) => { f.files['/w/runner/STOP'] = ''; return inner(call); };
}

/**
 * What a round was, driven by hand: the chores, then every step both lanes
 * would take. The runner has no round any more (2026-09-08) — the loop is
 * `chores()` on its own clock beside one lane loop per repository — and the
 * tests that used to drive one drive this.
 */
async function round(runner, { chores = true } = {}) {
  if (chores) await runner.chores();
  const results = await Promise.all(runner.repos.map((repo) => lane(runner, repo.name)));
  return { ran: results.reduce((n, r) => n + r.ran, 0), stop: results.some((r) => r.stop) };
}

/* ------------------------------------------------------------------ goals */

const GOALS = '/w/programs/prog/goals';
const goalLog = (...stamps) => stamps.map((at) => `## ${at} · claude opus · build · ready\n\nDone: arbete\n`).join('\n');
const runnerEntry = (at) => `## ${at} · runner · build · ready\n\nComment: session ended without a log entry (exit 1, 3 s)\n`;

/**
 * A fixture holding goals under `prog`: `{ name: { stage, status, log, repos, worktree } }`.
 * The worktree is there unless `worktree: false`. The router reads a claude plan
 * with room, so a goal's class has a candidate. `after` writes a GOAL.json from
 * before phases and stages: no phase, no stage, `legacy` its one status.
 */
function goalFixture(goals, options = {}) {
  const f = fixture({ capacity: capacityWith({ claude: 0.1 }), session: (call) => f.answer(call), ...options });
  f.answer = okSession();
  for (const [name, { stage = 'build', status = 'ready', legacy: old = null, log = '', repos = 'memoro', worktree = true, phase = 1, after = null }] of Object.entries(goals)) {
    const text = goalJson({ stage, status, phase, repos: repos.split(',').map((one) => one.trim()), title: name, goal: [] });
    const { phase: _phase, stage: _stage, ...legacy } = JSON.parse(text);
    f.files[`${GOALS}/${name}/GOAL.json`] = after === null ? text : `${JSON.stringify({ ...legacy, status: old, after: after ? after.split(',').map((one) => one.trim()) : [] }, null, 2)}\n`;
    f.files[`${GOALS}/${name}/LOG.md`] = log;
    if (worktree) for (const repo of repos.split(',')) f.dirs.add(`${GOALS}/${name}/${repo.trim()}`);
  }
  return f;
}

/**
 * A session that finishes its goal, as `mc goal done` does: the goal is not
 * picked again, so a lane that ran it has nothing left to take.
 */
const endsGoal = (f, inner = okSession()) => (call) => {
  const name = String(call.env?.MC_GOAL || '').split('/')[1];
  const path = `${GOALS}/${name}/GOAL.json`;
  if (f.files[path]) f.files[path] = withGoal(f.files[path], { stage: 'done', status: 'ready' });
  return inner(call);
};

/** A session that says its piece, as `mc goal log` does. */
const logsItself = (f, name, inner = okSession()) => (call) => {
  const path = `${GOALS}/${name}/LOG.md`;
  f.files[path] = `${f.files[path]}\n${goalLog('2026-08-29T10:00Z')}`;
  return inner(call);
};

test('a goal session is started with MC_SCRATCH naming an existing directory under the runner scratch dir', async () => {
  const f = goalFixture({ alpha: {} });
  const seen = [];
  f.answer = (call) => {
    seen.push({ scratch: call.env.MC_SCRATCH, existed: f.dirs.has(call.env.MC_SCRATCH), marker: JSON.parse(f.files[`${call.env.MC_SCRATCH}/.mc-scratch.json`]) });
    return okSession()(call);
  };
  await createRunner({ deps: f.deps }).pass();
  assert.equal(seen.length, 1);
  assert.match(seen[0].scratch, /^\/w\/runner\/scratch\/goal-prog-alpha-\d{8}T\d{6}Z$/u);
  assert.equal(seen[0].existed, true, 'the directory exists when the session starts');
  // Its ownership record (tidy rule S): no end while the session runs, the end and exit after.
  const { stem, ...during } = seen[0].marker;
  assert.equal(stem, seen[0].scratch.split('/').at(-1));
  assert.deepEqual(during, { schema: 'mc-scratch', version: 1, owner: 'runner', runner_pid: 4242, session: 'goal:prog/alpha', kind: 'build', started: '2026-08-29T10:00:00Z' });
  const after = JSON.parse(f.files[`${seen[0].scratch}/.mc-scratch.json`]);
  assert.deepEqual([after.started, after.ended, after.exit], ['2026-08-29T10:00:00Z', '2026-08-29T10:00:00Z', 0]);
});

test('a scratch directory that cannot be made is said, and the session starts without MC_SCRATCH', async () => {
  const f = goalFixture({ alpha: {} });
  f.deps.mkdir = () => { throw new Error('EACCES'); };
  await createRunner({ deps: f.deps }).pass();
  assert.equal(f.calls.sessions.length, 1);
  assert.equal('MC_SCRATCH' in f.calls.sessions[0].env, false);
  assert.equal(f.calls.sessions[0].env.MC_GOAL, 'prog/alpha');
  assert.match(f.files['/w/runner/log/runner.log'], /goal:prog\/alpha: no scratch directory .*EACCES/u);
});

test('the chore pass removes no scratch directory by age: what goes from scratch is tidy rule S\'s, on proof', async () => {
  const f = fixture({ now: '2026-09-19T10:00:00Z' });
  const now = Date.parse('2026-09-19T10:00:00Z');
  f.dirs.add('/w/runner/scratch/old-20260910T090000Z');
  f.scratchAges['/w/runner/scratch/old-20260910T090000Z'] = now - 9 * 24 * 60 * 60 * 1000;
  await createRunner({ deps: f.deps }).chores();
  assert.deepEqual(f.calls.rmScratch, []);
  assert.ok(f.dirs.has('/w/runner/scratch/old-20260910T090000Z'));
  assert.doesNotMatch(f.files['/w/runner/log/runner.log'] || '', /scratch:/u);
});

/* ------------------------------------------------ disk pressure (disk-pressure.js) */

/**
 * The disk as the fixture's statfs reads it, and the pressure pass's two
 * halves faked on it: each frees what the test says, which the next reading
 * sees, while its estimate may say more.
 */
function onDisk(f, free, { tidyFrees = 0, tidyEstimate = tidyFrees, dockerFrees = 0, docker = { up: true, pruned: [{ what: 'images', ok: true, reclaimed: '0B', detail: null }] } } = {}) {
  const disk = { free, steps: [], read: [], tidyFrees, dockerFrees, docker, gate: null };
  f.deps.freeBytes = (path) => { disk.read.push(path); if (disk.free instanceof Error) throw disk.free; return disk.free; };
  f.deps.pressureTidy = async () => {
    disk.steps.push('tidy');
    if (disk.gate) await disk.gate;
    disk.free += disk.tidyFrees;
    return {
      list: { targets: [{ path: '/w/runner/scratch/s/wt', bytes: tidyEstimate }], kept: [{ path: '/w/runner/scratch/legacy/wt', rule: 'S', why: 'its scratch directory has no ownership record — legacy scratch is kept' }] },
      outcome: { removed: 1, applied: [] },
    };
  };
  f.deps.pressureDocker = async () => { disk.steps.push('docker'); disk.free += disk.dockerFrees; return disk.docker; };
  return disk;
}
const pressureState = (f) => JSON.parse(f.files['/w/runner/disk-pressure.json'] ?? 'null');
const pressureEvents = (f) => JSON.parse(f.files['/w/runner/disk-pressure-events.json'] ?? '[]');
const GBYTES = 1e9;

test('cleanup starts below 30 GB while admission stays at 20 GB and preserves cleanup cooldown', async () => {
  const files = new Map(); let free = 30e9; let passes = 0;
  const policy = createDiskPressure({ path: '/disk', stateDir: '/state', pid: 1,
    freeBytes: () => free, read: (path) => files.get(path), writeJson: (path, value) => files.set(path, JSON.stringify(value)),
    now: () => Date.parse('2026-11-06T12:00:00Z'),
    steps: [{ name: 'tidy', run: async () => { passes += 1; return {}; } }],
  });
  await policy.poll(); assert.equal(passes, 0, '30 GB does not trigger cleanup');
  free = 30e9 - 1; await policy.poll(); assert.equal(passes, 1, 'cleanup begins below 30 GB');
  const cooldown = policy.readState().cooldown_until; assert.ok(cooldown);
  for (const amount of [25e9, 20e9]) {
    free = amount; assert.equal((await policy.admit()).admitted, true, `${amount} admits work`);
    assert.equal(policy.readState().cooldown_until, cooldown, 'admission does not clear cleanup pressure');
  }
  free = 20e9 - 1; assert.equal((await policy.admit()).admitted, false, 'below 20 GB still refuses');
  assert.equal(passes, 1, 'cooldown prevents repeated unsuccessful cleanup');
});

test('shared admission excludes other policy instances through allocation/start, and lock failure refuses', async () => {
  for (const otherPid of [1, 2]) {
    const files = new Map();
    let free = 20e9;
    const options = { path: '/disk', stateDir: '/state', freeBytes: () => free,
      read: (p) => files.get(p), writeJson: (p, v) => files.set(p, JSON.stringify(v)), alive: () => true };
    const first = createDiskPressure({ ...options, pid: 1 });
    const second = createDiskPressure({ ...options, pid: otherPid });
    const admitted = await first.admit({ hold: true });
    assert.equal(admitted.admitted, true);
    const contended = await second.admit({ hold: true });
    assert.deepEqual([contended.admitted, contended.busy], [false, true], 'live admission contention is a retryable wait, not a disk shortage');
    free = 19e9; // the admitted allocation consumed space before releasing
    admitted.release();
    assert.equal((await second.admit()).admitted, false);
    free = 20e9;
    assert.equal((await second.admit()).admitted, true);
  }
  const failed = createDiskPressure({ path: '/disk', stateDir: '/state', freeBytes: () => 50e9,
    read: () => null, writeJson: () => assert.fail('must not write without exclusion'), lock: () => { throw new Error('held'); } });
  assert.match((await failed.admit()).reason, /lock unavailable/u);
});

test('runner holds admission during dependency allocation and rechecks before spawning', async () => {
  const f = goalFixture({ alpha: {} });
  const disk = onDisk(f, 20e9);
  let heldAtAllocation = false;
  f.deps.attachDeps = async () => {
    heldAtAllocation = pressureState(f)?.admission_lease?.trigger === 'session:start';
    disk.free = 19e9;
    return { ok: true };
  };
  assert.equal((await createRunner({ deps: f.deps }).pass()).waited, 'skipped:disk');
  assert.equal(f.calls.sessions.length, 0);
  assert.equal(heldAtAllocation, true, 'allocation happens only while admission is held');
  assert.equal(pressureState(f).admission_lease, null);
  assert.equal(pressureEvents(f).at(-1).admission.admitted, false);
});

test('runner distinguishes admission contention at pass entry and final launch from disk shortage', async () => {
  const f = goalFixture({ a: {}, b: {} });
  const disk = onDisk(f, 33e9);
  let release;
  const allocation = new Promise((resolve) => { release = resolve; });
  f.deps.attachDeps = async () => { await allocation; return { ok: true }; };
  const runner = createRunner({ deps: f.deps });
  const first = runner.pass({ lane: 0 });
  const second = runner.pass({ lane: 1 });
  try {
    await turns();
    assert.equal((await second).waited, 'skipped:disk-busy', 'simultaneous passes contend at final launch');
    assert.equal((await runner.pass({ lane: 1 })).waited, 'skipped:disk-busy', 'a later pass contends at entry');
    assert.equal(f.files['/w/runner/disk.json'], undefined, 'contention does not claim insufficient disk');
    assert.equal(f.calls.sessions.length, 0, 'allocation remains exclusive');
    disk.free = 19e9;
  } finally { release(); }
  assert.equal((await first).waited, 'skipped:disk', 'fresh recheck refuses the consumed disk space');
  assert.equal(pressureState(f).admission_lease, null);
});

test('runLoop: STOP and UPDATE interrupt admission contention without taking a live owner lease', async () => {
  for (const order of ['STOP', 'UPDATE']) {
    const f = goalFixture({ a: {} }, { livePids: [777] });
    onDisk(f, 33e9);
    const owner = { pid: 777, token: 'live', since: '2026-08-29T09:59:00Z' };
    f.files['/w/runner/disk-pressure.json'] = JSON.stringify({ admission_lease: owner });
    const sleeps = [];
    const handovers = [];
    f.deps.sleep = async (ms) => {
      sleeps.push(ms);
      f.files[`/w/runner/${order}`] = '';
      await new Promise((resolve) => setImmediate(resolve));
    };
    f.deps.handOver = async (options) => { handovers.push(options); delete f.files['/w/runner/UPDATE']; return { ok: true }; };
    assert.equal(await runLoop({ deps: f.deps }), 0);
    assert.deepEqual(f.calls.sessions, []);
    assert.deepEqual(pressureState(f).admission_lease, owner, 'a live owner is never reclaimed');
    assert.ok(sleeps.includes(1000), 'contention uses short retry waits');
    assert.equal(handovers.length, order === 'UPDATE' ? 1 : 0);
  }
});

test('STOP and UPDATE during allocation cancel spawn and release admission and the lane slot', async () => {
  for (const order of ['STOP', 'UPDATE']) {
    const f = goalFixture({ a: {} });
    onDisk(f, 33e9);
    f.deps.laneCount = () => ({ lanes: 1 });
    f.deps.attachDeps = async () => { f.files[`/w/runner/${order}`] = ''; return { ok: true }; };
    const runner = createRunner({ deps: f.deps });
    await runner.pass();
    assert.deepEqual(f.calls.sessions, []);
    assert.equal(pressureState(f).admission_lease, null);
    assert.equal(f.files['/w/runner/current-memoro.json'], undefined);
    delete f.files[`/w/runner/${order}`];
    // STOP is sticky within a runner; a fresh runner proves restart recovery.
    f.deps.attachDeps = async () => ({ ok: true });
    const resumed = order === 'STOP' ? createRunner({ deps: f.deps }) : runner;
    assert.equal((await resumed.pass()).ran, 1);
    assert.deepEqual(f.calls.sessions.map((call) => call.env.MC_GOAL), ['prog/a']);
  }
});

test('runLoop: reboot admission contention fills all 15 lanes promptly without duplicate starts', async (t) => {
  const names = Array.from({ length: 15 }, (_, i) => `work-${i}`);
  const f = goalFixture(Object.fromEntries(names.map((name) => [name, {}])));
  onDisk(f, 33e9);
  // Persisted records from the dead runner survive reboot. Its lease and lane
  // must be recovered, without changing the configured total.
  f.files['/w/runner/disk-pressure.json'] = JSON.stringify({ admission_lease: { pid: 777, token: 'old' } });
  f.files['/w/runner/current-memoro.json'] = JSON.stringify({ pid: 777, lane: 0, name: 'goal:prog/work-0' });
  f.deps.laneCount = () => ({ lanes: 15 });
  const sleeps = [];
  const starts = [];
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  f.answer = async (call) => { starts.push(call.env.MC_GOAL); await held; return endsGoal(f)(call); };
  // Ten-minute naps stay asleep; short retry timers advance deterministically.
  // No real model, process, filesystem, or elapsed-time wait is needed.
  const wake = [];
  f.deps.sleep = (ms) => {
    sleeps.push(ms);
    return new Promise((resolve) => {
      if (ms < UPDATE_POLL_MS) setImmediate(resolve);
      else wake.push(resolve);
    });
  };
  const stop = () => { f.files['/w/runner/STOP'] = ''; release(); for (const resolve of wake.splice(0)) resolve(); };
  t.after(stop);
  const run = runLoop({ deps: f.deps });
  await turns(100);
  try {
    assert.deepEqual([...starts].sort(), names.map((name) => `prog/${name}`).sort(), 'every configured lane starts a distinct goal before the idle sleep expires');
    assert.ok(sleeps.some((ms) => ms > 0 && ms <= 1000), 'contention retries within one second');
    assert.equal(pressureState(f).admission_lease, null, 'spawn releases admission while sessions remain active');
    assert.equal(f.deps.laneCount().lanes, 15);
  } finally { stop(); await run; }
});

test('pending cleanup stays exclusive while sessions start at 20 GB or above', async () => {
  const files = new Map();
  let free = 19e9;
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const removed = [];
  const options = { path: '/disk', stateDir: '/state', pid: 1, alive: () => true,
    freeBytes: () => free, read: (p) => files.get(p), writeJson: (p, v) => files.set(p, JSON.stringify(v)),
    steps: [{ name: 'tidy', run: async () => { removed.push('safe'); await pending; free = 40e9; return {}; } }] };
  const first = createDiskPressure(options);
  const second = createDiskPressure(options);
  const pass = first.admit();
  await Promise.resolve();
  assert.equal((await second.poll()).relief.skipped, 'busy');
  assert.equal((await second.admit()).admitted, false, 'below 20 GB waits');
  for (const policy of [first, second]) {
    for (const amount of [20e9, 25e9, 30e9]) {
      free = amount;
      const admitted = await policy.admit({ hold: true });
      assert.equal(admitted.admitted, true, `${amount} starts while cleanup is pending`);
      assert.equal((await admitted.recheck()).admitted, true);
      free = 20e9 - 1;
      assert.equal((await admitted.recheck()).admitted, false, 'recheck still protects the floor');
      admitted.release();
    }
  }
  assert.deepEqual(removed, ['safe']);
  release();
  assert.equal((await pass).admitted, true, 'the original start also uses reclaimed space');
  assert.equal((await second.admit()).admitted, true);
});

test('at exactly 20 GB a session starts, and a healthy disk runs no cleanup or diagnostic event', async () => {
  const f = goalFixture({ alpha: {} });
  const disk = onDisk(f, 20e9);
  f.files['/w/runner/disk.json'] = JSON.stringify({ line: 'disk: 1.0 GB free — no session started' });
  const r = await createRunner({ deps: f.deps }).pass();
  assert.equal(r.ran, 1);
  assert.deepEqual(disk.steps, []);
  assert.deepEqual([...new Set(disk.read)], ['/w/runner/scratch'], 'the volume read is the one MC_SCRATCH is made on');
  assert.equal(pressureState(f).admission_lease, null);
  assert.equal(pressureState(f).last_cleanup, undefined);
  assert.deepEqual(pressureEvents(f), []);
  assert.equal('/w/runner/disk.json' in f.files, false, 'the page line goes');
  assert.doesNotMatch(f.files['/w/runner/log/runner.log'], /disk:/u);
});

test('20 GB minus one byte runs one pressure pass before the session, stops at 40 GB, and records measured beside estimated', async () => {
  const f = goalFixture({ alpha: {} });
  const disk = onDisk(f, 20e9 - 1, { tidyFrees: 22 * GBYTES, tidyEstimate: 30 * GBYTES });
  const r = await createRunner({ deps: f.deps }).pass();
  assert.equal(r.ran, 1);
  assert.deepEqual(disk.steps, ['tidy'], 'at 40 GB Docker is not asked');
  const [event] = pressureEvents(f);
  assert.deepEqual({
    trigger: event.trigger, before: event.before_bytes, after: event.after_bytes, delta: event.measured_delta_bytes, estimate: event.estimate_bytes,
    outcome: event.outcome, steps: event.steps.map((step) => step.name), admitted: event.admission?.admitted, shortfall: event.shortfall_bytes,
  }, {
    trigger: 'session:lane', before: 20e9 - 1, after: 20e9 - 1 + 22 * GBYTES, delta: 22 * GBYTES, estimate: 30 * GBYTES,
    outcome: 'recovered', steps: ['archive', 'tidy'], admitted: true, shortfall: 0,
  });
  assert.equal(event.steps[1].kept[0].why, 'its scratch directory has no ownership record — legacy scratch is kept');
  const state = pressureState(f);
  assert.deepEqual([state.status, state.cooldown_until, state.last_cleanup.outcome, state.lease], ['healthy', null, 'recovered', null]);
  assert.match(f.files['/w/runner/log/runner.log'], /disk: 19\.9 GB free, below 30\.0 GB \(session:lane\) — tidying toward 40\.0 GB/u);
});

test('below 20 GB with safe candidates exhausted: refused with free bytes and reason, a persisted cooldown a restart obeys, a pass again after it', async () => {
  let clock = Date.parse('2026-08-29T10:00:00Z');
  const f = goalFixture({ alpha: {} });
  f.deps.now = () => new Date(clock);
  const disk = onDisk(f, 15 * GBYTES, { tidyFrees: GBYTES });
  const r = await createRunner({ deps: f.deps }).pass();
  assert.deepEqual([r.ran, r.waited, f.calls.sessions.length], [0, 'skipped:disk', 0]);
  assert.deepEqual(disk.steps, ['tidy', 'docker'], 'every safe step, then it stops');
  let state = pressureState(f);
  assert.deepEqual(
    [state.status, state.available_bytes, state.shortfall_bytes, state.cooldown_until, state.last_cleanup.outcome],
    ['pressure', 16 * GBYTES, 24 * GBYTES, '2026-08-29T10:05:00.000Z', 'shortfall'],
  );
  assert.equal(JSON.parse(f.files['/w/runner/disk.json']).line, 'disk: 16.0 GB free — no session started: below 20.0 GB after tidying; safe candidates are exhausted');
  assert.deepEqual(pressureEvents(f)[0].admission, { admitted: false, trigger: 'session:lane', what: 'no session', available: 16 * GBYTES, reason: 'below 20.0 GB after tidying; safe candidates are exhausted' });

  // A restart: a new runner on the same files, within the five minutes.
  clock += COOLDOWN_MS - 1000;
  const again = await createRunner({ deps: f.deps }).pass();
  assert.equal(again.waited, 'skipped:disk');
  assert.equal(disk.steps.length, 2, 'the cooldown survives the restart: no second pass');
  assert.match(JSON.parse(f.files['/w/runner/disk.json']).line, /the last pressure pass could not restore it \(shortfall\), next pass after 2026-08-29T10:05:00\.000Z$/u);
  assert.equal(pressureEvents(f).at(-1).outcome, 'cooldown');

  // After it, a pass that restores the pressure line admits, short of 40 GB.
  clock += 1000;
  disk.tidyFrees = 5 * GBYTES;
  const after = await createRunner({ deps: f.deps }).pass();
  assert.equal(after.ran, 1);
  state = pressureState(f);
  assert.deepEqual([state.status, state.cooldown_until, state.last_cleanup.outcome, state.shortfall_bytes], ['pressure', '2026-08-29T10:10:00.000Z', 'shortfall', 19 * GBYTES]);
  assert.equal('/w/runner/disk.json' in f.files, false);
});

test('a disk that cannot be read refuses new sessions, shows it, and runs no pass; a reading clears it', async () => {
  const f = goalFixture({ alpha: {} });
  const disk = onDisk(f, new Error('EIO'));
  const runner = createRunner({ deps: f.deps });
  assert.equal((await runner.pass()).waited, 'skipped:disk');
  assert.deepEqual([disk.steps, f.calls.sessions.length, pressureState(f).status], [[], 0, 'unknown']);
  assert.equal(JSON.parse(f.files['/w/runner/disk.json']).line, 'disk: unknown free — no session started: free space could not be measured');
  assert.equal(pressureEvents(f).at(-1).outcome, 'unknown');
  disk.free = 50 * GBYTES;
  assert.equal((await runner.pass()).ran, 1);
  assert.equal(pressureState(f).status, 'healthy');
});

test('two lanes asking at once share one pressure pass, and each decides on the reading after it', async () => {
  for (const [frees, ran] of [[2 * GBYTES, [1, 0]], [0, [0, 0]]]) {
    const f = goalFixture({ alpha: {}, beta: {} });
    const disk = onDisk(f, 19 * GBYTES, { tidyFrees: frees });
    let open;
    disk.gate = new Promise((resolve) => { open = resolve; });
    const runner = createRunner({ deps: f.deps });
    const both = Promise.all([runner.pass({ lane: 0 }), runner.pass({ lane: 1 })]);
    await new Promise((resolve) => { setImmediate(resolve); });
    open();
    const results = await both;
    assert.deepEqual(results.map((r) => r.ran), ran);
    assert.deepEqual(disk.steps.filter((step) => step === 'tidy'), ['tidy'], 'one pass for both');
    assert.equal(f.calls.sessions.length, ran[0] + ran[1]);
    if (frees) assert.equal((await runner.pass({ lane: 1 })).ran, 1, 'deferred lane remeasures and starts on retry');
  }
});

test('a pressure lease another live process holds means no second pass here; a dead holder\'s is taken over', async () => {
  const f = goalFixture({ alpha: {} }, { livePids: [777] });
  const disk = onDisk(f, 19 * GBYTES, { tidyFrees: 2 * GBYTES });
  f.files['/w/runner/disk-pressure.json'] = JSON.stringify({ status: 'pressure', lease: { pid: 777, since: '2026-08-29T09:59:00Z', trigger: 'deploy' } });
  assert.equal((await createRunner({ deps: f.deps }).pass()).waited, 'skipped:disk');
  assert.deepEqual(disk.steps, []);
  assert.match(JSON.parse(f.files['/w/runner/disk.json']).line, /pid 777 is reclaiming space now/u);
  f.deps.alive = () => false;
  assert.equal((await createRunner({ deps: f.deps }).pass()).ran, 1);
  assert.deepEqual([disk.steps, pressureState(f).lease], [['tidy', 'docker'], null]);
});

test('the event history keeps the newest EVENTS_KEEP: the oldest goes when one more is written', async () => {
  const f = goalFixture({ alpha: {} });
  onDisk(f, new Error('EIO'));
  f.files['/w/runner/disk-pressure-events.json'] = JSON.stringify(Array.from({ length: EVENTS_KEEP }, (_, n) => ({ at: `old-${n}` })));
  await createRunner({ deps: f.deps }).pass();
  const events = pressureEvents(f);
  assert.equal(EVENTS_KEEP, 100);
  assert.deepEqual([events.length, events[0].at, events.at(-2).at, events.at(-1).outcome], [100, 'old-1', 'old-99', 'unknown']);
});

test('a failed Docker prune makes a failed pass, not a file-only success, and the cooldown says so', async () => {
  const f = goalFixture({ alpha: {} });
  onDisk(f, 15 * GBYTES, { docker: { up: true, pruned: [{ what: 'images', ok: false, reclaimed: null, detail: 'daemon busy' }] } });
  await createRunner({ deps: f.deps }).pass();
  const event = pressureEvents(f)[0];
  assert.deepEqual([event.failed, event.errors, event.outcome], [true, ['docker-images: images: daemon busy'], 'no-progress']);
  assert.deepEqual([pressureState(f).last_cleanup.failed, pressureState(f).cooldown_why], [true, 'no-progress, a step failed']);
  assert.match(f.files['/w/runner/log/runner.log'], /failed: docker-images: images: daemon busy/u);
});

test('the monitor reads the disk every minute on its own timer and relieves pressure while a session and a chore are still running', async () => {
  const f = goalFixture({ alpha: {} });
  f.deps.laneCount = () => ({ lanes: 1 });
  const disk = onDisk(f, 35 * GBYTES, { tidyFrees: 10 * GBYTES });
  const timers = [];
  f.deps.every = (ms, fn) => { const timer = { ms, fn, stopped: false }; timers.push(timer); return () => { timer.stopped = true; }; };
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let entered;
  const inSession = new Promise((resolve) => { entered = resolve; });
  f.answer = async (call) => { entered(); await held; return okSession()(call); };
  // A chore that does not end either: the monitor must not wait behind it.
  f.deps.reapDevServers = async () => { await held; return []; };
  const loop = runLoop({ deps: f.deps, awake: false });
  await inSession;
  assert.deepEqual(timers.map((timer) => timer.ms), [POLL_MS]);
  assert.equal(POLL_MS, 60_000);
  await timers[0].fn();
  assert.deepEqual([pressureState(f).last_cleanup, disk.steps], [undefined, []], 'healthy: no cleanup');
  disk.free = 18 * GBYTES;
  await timers[0].fn();
  assert.deepEqual(disk.steps, ['tidy', 'docker']);
  const [event] = pressureEvents(f);
  assert.deepEqual([event.trigger, event.before_bytes, event.after_bytes, event.outcome], ['monitor', 18 * GBYTES, 28 * GBYTES, 'shortfall']);
  assert.equal(f.calls.sessions.length, 1, 'the session in flight goes on');
  f.files['/w/runner/STOP'] = '';
  release();
  assert.equal(await loop, 0);
  assert.equal(timers[0].stopped, true, 'the timer stops with the runner');
});

const doneAnHourAgo = '## 2026-09-01T09:00Z · claude opus · done · ready\n\nDone: arbete\n';

test('under pressure a goal done an hour ago is archived without the 24 hours, and a refused one stays with its reason', async () => {
  const f = goalFixture({
    fresh: { stage: 'done', log: doneAnHourAgo },
    held: { stage: 'done', log: doneAnHourAgo },
    work: {},
  }, { now: '2026-09-01T10:00:00Z', dirty: ['held'] });
  onDisk(f, 15 * GBYTES);
  await createRunner({ deps: f.deps }).chores();
  assert.ok(f.files[`${GOALS}/fresh/GOAL.json`], 'the chores keep the 24 hours');
  await createRunner({ deps: f.deps }).pass();
  assert.equal(f.files[`${GOALS}/fresh/GOAL.json`], undefined, 'archived by the pressure pass');
  assert.equal(goalField(f.files['/w/programs/prog/goals/.archive/fresh/GOAL.json'], 'stage'), 'done');
  assert.equal(goalField(f.files[`${GOALS}/held/GOAL.json`], 'stage'), 'done', 'refused: it stays, and stays done');
  assert.equal(goalField(f.files[`${GOALS}/work/GOAL.json`], 'stage'), 'build', 'a goal not finished is never archived');
  const [archive] = pressureEvents(f)[0].steps;
  assert.deepEqual([archive.name, archive.removed], ['archive', 1]);
  assert.match(archive.kept[0].why, /^not archived — memoro's worktree has uncommitted changes/u);
  assert.match(f.files['/w/runner/log/runner.log'], /fresh: done — archived to .* \(disk pressure: without the 24 hours\)/u);
});

/**
 * 2026-10-10: one step session, three plan sessions and the brief left 30 %
 * free and swap nearly full on 8 GB. Under 20 % free a pass starts nothing,
 * says why once, and leaves the line for the page.
 */
test('under 20 % free memory no session launches, the line is said once and left for the page', async () => {
  const f = goalFixture({ alpha: {} });
  f.deps.freeMemoryPercent = () => freeMemoryPercent(undefined, {
    platform: 'linux', readFile: () => 'MemAvailable: 19 kB\nMemFree: 90 kB\nMemTotal: 100 kB\n',
  });
  const r = await createRunner({ deps: f.deps }).pass();
  assert.equal(r.ran, 0);
  assert.equal(r.waited, 'skipped:memory');
  assert.equal(f.calls.sessions.length, 0, 'no session is launched');
  const said = f.files['/w/runner/log/runner.log'].split('\n').filter((line) => /memory:/u.test(line));
  assert.equal(said.length, 1);
  assert.match(said[0], /memory: 19% free, below 20% — no session started$/u);
  const written = JSON.parse(f.files['/w/runner/memory.json']);
  assert.equal(written.free_percent, 19);
  assert.equal(written.line, 'memory: 19% free, below 20% — no session started');
});

test('at 20 % free memory a session launches, and the memory line is taken off the page', async () => {
  const f = goalFixture({ alpha: {} });
  f.files['/w/runner/memory.json'] = JSON.stringify({ line: 'memory: 12% free, below 20% — no session started' });
  f.deps.freeMemoryPercent = () => freeMemoryPercent(undefined, {
    platform: 'linux', readFile: () => 'MemAvailable: 20 kB\nMemTotal: 100 kB\n',
  });
  const r = await createRunner({ deps: f.deps }).pass();
  assert.equal(r.ran, 1);
  assert.equal(f.calls.sessions.length, 1);
  assert.equal('/w/runner/memory.json' in f.files, false);
  assert.doesNotMatch(f.files['/w/runner/log/runner.log'], /memory:/u);
});

test('a memory reading that cannot be had is room: a session launches', async () => {
  const f = goalFixture({ alpha: {} });
  f.deps.freeMemoryPercent = () => null;
  const r = await createRunner({ deps: f.deps }).pass();
  assert.equal(r.ran, 1);
  assert.equal(f.calls.sessions.length, 1);
  assert.doesNotMatch(f.files['/w/runner/log/runner.log'], /memory:/u);
});

test('the chore pass runs the reaper every pass and says what it removed', async () => {
  const f = fixture();
  let passes = 0;
  f.deps.reapDevServers = async () => {
    passes += 1;
    return [{ pid: 10, kind: 'server', done: 'reaped' }, { pid: 11, kind: 'esbuild', done: 'reaped' }];
  };
  const runner = createRunner({ deps: f.deps });
  await runner.chores();
  await runner.chores();
  assert.equal(passes, 2);
  assert.match(f.files['/w/runner/log/runner.log'], /reap: 2 orphaned dev process\(es\) removed/u);
});

test('a reaper that throws is said, and the chore pass goes on', async () => {
  const f = fixture({ now: '2026-09-19T10:00:00Z' });
  let tidied = 0;
  f.deps.tidy = async () => { tidied += 1; return { outcome: { freed: 0, removed: 0, kept: 0 } }; };
  f.deps.reapDevServers = async () => { throw new Error('ps exited 1'); };
  await createRunner({ deps: f.deps }).chores();
  assert.match(f.files['/w/runner/log/runner.log'], /reap: failed — ps exited 1/u);
  assert.equal(tidied, 1, 'the daily tidy after it still ran');
});

test('the chore pass runs the docker sweep and says its line', async () => {
  const f = fixture();
  let passes = 0;
  f.deps.dockerSweep = async () => {
    passes += 1;
    return { line: 'docker: swept 1 lease(s) whose pid is gone' };
  };
  const runner = createRunner({ deps: f.deps });
  await runner.chores();
  await runner.chores();
  assert.equal(passes, 2);
  assert.match(f.files['/w/runner/log/runner.log'], /docker: swept 1 lease\(s\) whose pid is gone/u);
});

test('a docker sweep with nothing to say says nothing', async () => {
  const f = fixture();
  f.deps.dockerSweep = async () => ({ line: null });
  await createRunner({ deps: f.deps }).chores();
  assert.doesNotMatch(f.files['/w/runner/log/runner.log'] ?? '', /docker:/u);
});

test('a docker sweep that throws is said, and the chore pass goes on', async () => {
  const f = fixture({ now: '2026-09-19T10:00:00Z' });
  let tidied = 0;
  f.deps.tidy = async () => { tidied += 1; return { outcome: { freed: 0, removed: 0, kept: 0 } }; };
  f.deps.dockerSweep = async () => { throw new Error('orbctl status timed out'); };
  await createRunner({ deps: f.deps }).chores();
  assert.match(f.files['/w/runner/log/runner.log'], /docker: sweep failed — orbctl status timed out/u);
  assert.equal(tidied, 1, 'the daily tidy after it still ran');
});

/**
 * A locked keychain made every ask hang and leave a modal behind, one more
 * each round (2026-09-20). A repository whose ask failed is left alone for
 * 1, 2, 5 and then 15 minutes, and is asked on the first pass after; the
 * first answer clears it.
 */
test('a repository GitHub could not be asked is asked again after 1, 2, 5, 15 and 15 minutes, and a success clears it', () => {
  const f = fixture();
  let clock = Date.parse('2026-08-29T10:00:00Z');
  f.deps.now = () => new Date(clock);
  let failures = 5;
  const gh = f.deps.gh;
  f.deps.gh = (cwd, args) => {
    if (cwd === '/home/memoro' && args.includes('--limit') && failures > 0) {
      failures -= 1;
      gh(cwd, args);
      return { ok: false, stdout: '', stderr: 'error connecting to api.github.com' };
    }
    return gh(cwd, args);
  };
  f.deps.diagnoseGithub = () => ({ cause: 'keychain' });
  const runner = createRunner({ deps: f.deps });
  const asks = [];
  // One round a minute for forty minutes.
  for (let minute = 0; minute <= 40; minute += 1) {
    const before = f.calls.gh.filter((c) => c[0] === '/home/memoro' && c.includes('--limit')).length;
    const world = runner.askGithub();
    const after = f.calls.gh.filter((c) => c[0] === '/home/memoro' && c.includes('--limit')).length;
    if (after > before) asks.push(minute);
    assert.equal(world.prsFailed.includes('memoro'), minute < 38, `minute ${minute}`);
    clock += 60_000;
  }
  // Failures at 0, 1, 3, 8, 23; the fifth set a 15-minute wait, the sixth ask
  // answers at 38 — then every round asks again.
  assert.deepEqual(asks, [0, 1, 3, 8, 23, 38, 39, 40]);
  assert.equal(f.files['/w/runner/github.json'], undefined, 'the first answer clears the record');
  const log = f.files['/w/runner/log/runner.log'];
  assert.match(log, /memoro: GitHub could not be asked what is open \(error connecting to api\.github\.com\) — keychain locked, run: security unlock-keychain/u);
  assert.match(log, /10:02:00Z {2}memoro: GitHub not asked — 2 failure\(s\) since 2026-08-29T10:00:00Z, next ask at 2026-08-29T10:03:00Z/u);
  assert.match(log, /memoro: GitHub answers again after 5 failure\(s\) since 2026-08-29T10:00:00Z/u);
});

test('the record a failed ask leaves is what the page reads', () => {
  const f = fixture({ prsFail: ['memoro'] });
  f.deps.diagnoseGithub = () => ({ cause: 'token' });
  createRunner({ deps: f.deps }).askGithub();
  assert.deepEqual(JSON.parse(f.files['/w/runner/github.json']), {
    memoro: {
      since: '2026-08-29T10:00:00Z', last: '2026-08-29T10:00:00Z', attempts: 1,
      error: 'gh: not logged in', cause: 'token', next_ask: '2026-08-29T10:01:00Z',
    },
  });
});

test('the chores ask GitHub once per repository, beside the fetch they already pay for', async () => {
  const f = fixture();
  const runner = createRunner({ deps: f.deps });
  const asked = runner.askGithub();
  const lists = f.calls.gh.filter((c) => c.includes('--limit'));
  assert.deepEqual(lists.map((c) => c[0]), ['/home/memoro', '/home/memoro-cli']);
  assert.deepEqual(asked.prs, []);
  assert.deepEqual(asked.prsFailed, []);
});

/**
 * The landing is `mc merge`'s own round and nothing else: the old way landed
 * without the gate and never read the base.
 */
test('run.js has no gh pr merge left in it', () => {
  const source = readFileSync(new URL('../../src/mc/run.js', import.meta.url), 'utf8');
  assert.equal(/\[\s*'pr',\s*'merge'/u.test(source), false, 'the runner lands through mc merge and nothing else');
});

/* ------------------------------------------------- work classes (ruling 59) */

test('both subscriptions are read at startup, due at 15 minutes, and a failed attempt is suppressed', async () => {
  let clock = ROUTING_NOW.getTime();
  const f = fixture({ session: okSession() });
  f.deps.now = () => new Date(clock);
  const reads = { claude: [], codex: [] };
  let timer;
  let interval;
  let releaseCodex;
  f.deps.every = (ms, fn) => { interval = ms; timer = fn; return () => { timer = null; }; };
  f.deps.refreshCodex = async () => {
    reads.codex.push(clock);
    if (reads.codex.length === 2) return new Promise((resolve) => { releaseCodex = () => resolve({ ok: false, why: 'codex vanished' }); });
    const next = applyObservation(f.deps.capacity.read(), 'codex', { windows: { primary: windowAt(0.1), secondary: null }, models: LUNA }, new Date(clock));
    f.deps.capacity.write(next);
    return { ok: true, why: null, state: next };
  };
  f.deps.refreshClaude = async () => { reads.claude.push(clock); return { ok: false, why: 'login unavailable' }; };
  const runner = createRunner({ deps: f.deps });
  runner.startCapacityTicker();
  const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
  await flush();
  assert.deepEqual(reads, { claude: [clock], codex: [clock] }, 'startup polls both providers without chores');
  assert.equal(interval, 15 * 60 * 1000);
  clock += 14 * 60 * 1000;
  timer(); await flush();
  assert.deepEqual(reads.codex, [ROUTING_NOW.getTime()], 'no attempt before fifteen minutes');
  clock += 60 * 1000;
  timer(); await flush();
  assert.equal(reads.codex.length, 2, 'the attempt is due exactly at fifteen minutes');
  timer(); await flush();
  assert.equal(reads.codex.length, 2, 'an in-flight provider read is single-flight');
  releaseCodex(); await flush();
  timer(); await flush();
  assert.equal(reads.codex.length, 2, 'failed attempt is suppressed for fifteen minutes');
  assert.equal(reads.claude.length, 2, 'Claude has its own fifteen-minute attempt window');
  clock += 15 * 60 * 1000;
  f.files['/w/runner/UPDATE'] = '';
  timer(); await flush();
  assert.equal(reads.claude.length, 2, 'a pending UPDATE pauses reads');
  assert.ok(timer, 'an UPDATE alone does not stop the ticker: a failed handover keeps polling');
  delete f.files['/w/runner/UPDATE'];
  timer(); await flush();
  assert.equal(reads.claude.length, 3, 'polling resumes once the UPDATE is gone');
  f.files['/w/runner/STOP'] = '';
  timer();
  assert.equal(timer, null, 'STOP stops the independent ticker');
});

test('the usage ticker proceeds while a chore waits on its helper turn', async () => {
  let clock = ROUTING_NOW.getTime();
  let releaseTurn;
  const f = fixture({ inbox: ['decision.md'], helperTurn: () => new Promise((resolve) => { releaseTurn = resolve; }) });
  f.deps.now = () => new Date(clock);
  let timer;
  f.deps.every = (ms, fn) => { if (ms === 15 * 60 * 1000) timer = fn; return () => { timer = null; }; };
  const attempts = { claude: 0, codex: 0 };
  f.deps.refreshClaude = async () => { attempts.claude += 1; return { ok: true }; };
  f.deps.refreshCodex = async () => { attempts.codex += 1; return { ok: true }; };
  const runner = createRunner({ deps: f.deps });
  const stop = runner.startCapacityTicker();
  const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
  await flush();
  const chores = runner.runIntakeDrain();
  await flush();
  assert.equal(typeof releaseTurn, 'function', 'the intake helper turn is still in flight');
  clock += 15 * 60 * 1000;
  timer();
  await flush();
  assert.deepEqual(attempts, { claude: 2, codex: 2 }, 'both collectors make their due attempt while chores remain blocked');
  releaseTurn({ ok: true, summary: 'done' });
  await chores;
  stop();
  assert.equal(timer, null, 'the independent ticker is stopped after its drain test ends');
});

test('STOP file: the loop exits after the session it is in, and the next start removes the STOP it left', async () => {
  const f = goalFixture({ a: {}, b: {} });
  f.answer = (call) => { f.files['/w/runner/STOP'] = ''; return okSession()(call); };
  f.deps.laneCount = () => ({ lanes: 1 });
  assert.equal(await runLoop({ deps: f.deps }), 0);
  assert.equal(f.calls.sessions.length, 1);
  assert.match(f.files['/w/runner/log/runner.log'], /lane 1: STOP — goal:prog\/a has ended, this lane takes nothing more; nothing else is in flight/u);
  assert.match(f.files['/w/runner/log/runner.log'], /runner exit on STOP — pid 4242 has ended; mc run start starts the next/u);
  // A foreground `mc run` is the same switch as `mc run start`: the STOP a
  // stopped runner left is removed and said, not a refusal.
  f.answer = okSession();
  assert.equal(await runLoop({ once: true, deps: f.deps }), 0);
  assert.equal('/w/runner/STOP' in f.files, false);
  assert.match(f.files['/w/runner/log/runner.log'], /removed the STOP the last stop left/u);
});

// A successor that finds STOP was stopped during its own handover, and obeys.
test('STOP file: a successor started into a STOP does not start', async () => {
  const f = goalFixture({ a: {} }, { livePids: [7777] });
  f.files['/w/runner/runner.json'] = `${JSON.stringify({ pid: 7777, started: '2026-08-29T06:33:25Z' })}\n`;
  f.files['/w/runner/STOP'] = '';
  f.deps.env = { ...f.deps.env, MC_RUN_SUCCESSOR_OF: '7777' };
  assert.equal(await runLoop({ once: true, deps: f.deps }), 2);
  assert.equal(f.calls.sessions.length, 0);
  assert.match(f.files['/w/runner/log/runner.log'], /a stop came during the handover/u);
});

/**
 * `runner.json` as a claim that is checked. Measured 2026-09-02: two runners
 * were alive in one work root and each handed `runner-open-prs` step 3 to a
 * session in the same worktree, 100 seconds apart — because `markRunner()`
 * writes the file without ever reading it, so the second runner overwrote the
 * first and nothing anywhere said two were running.
 */
test('runLoop: a second runner refuses to start while the first is alive, and names the pid', async () => {
  const f = goalFixture({ a: {} }, { livePids: [7777] });
  f.files['/w/runner/runner.json'] = `${JSON.stringify({ pid: 7777, started: '2026-08-29T06:33:25Z' }, null, 2)}\n`;
  assert.equal(await runLoop({ once: true, deps: f.deps }), 2);
  assert.equal(f.calls.sessions.length, 0, 'a refused runner started a session anyway');
  const log = f.files['/w/runner/log/runner.log'];
  assert.match(log, /a runner is already running — pid 7777, started 2026-08-29T06:33:25Z/u);
  assert.match(log, /mc run stop ends it · mc run --update restarts it on the newest code/u);
  assert.equal(/runner start \(mc run/u.test(log), false, 'it announced a start it did not make');
  // The holder's own file is left exactly as it was: the refusal must not be
  // the thing that makes the first runner invisible.
  assert.deepEqual(JSON.parse(f.files['/w/runner/runner.json']), { pid: 7777, started: '2026-08-29T06:33:25Z' });
});

/**
 * A runner executes the code it was spawned with, not what the checkout holds
 * now, so the page can only say *an update is available* if the runner said
 * what it is. `rev-parse --short HEAD` in mc's own checkout, once, at the start.
 */
test('createRunner: runner.json names the commit the runner started on, when mc runs from a checkout', () => {
  const f = fixture({ session: okSession() });
  const checkout = mcCheckout({ exists: () => true });
  const git = f.deps.git;
  f.deps.git = (cwd, args) => (cwd === checkout && args.join(' ') === 'rev-parse --short HEAD'
    ? { ok: true, stdout: 'abc1234\n' } : git(cwd, args));
  createRunner({ deps: f.deps }).markRunner();
  assert.equal(JSON.parse(f.files['/w/runner/runner.json']).commit, undefined, 'no checkout, no commit — and no git asked');

  f.files[`${checkout}/.git`] = '';
  createRunner({ deps: f.deps }).markRunner();
  assert.equal(JSON.parse(f.files['/w/runner/runner.json']).commit, 'abc1234');
});

test('runLoop: --once is refused by the same check — one worktree, one session', async () => {
  const f = goalFixture({ a: {} }, { livePids: [7777] });
  f.files['/w/runner/runner.json'] = `${JSON.stringify({ pid: 7777 }, null, 2)}\n`;
  assert.equal(await runLoop({ once: true, deps: f.deps }), 2);
  assert.equal(f.calls.sessions.length, 0);
  assert.match(f.files['/w/runner/log/runner.log'], /a runner is already running — pid 7777\n/u);
});

test('runLoop: a runner.json naming a pid that is gone is cleared, not a wall', async () => {
  const f = goalFixture({ a: {} });
  f.files['/w/runner/runner.json'] = `${JSON.stringify({ pid: 7777, started: '2026-08-29T06:33:25Z' }, null, 2)}\n`;
  f.files['/w/runner/current-memoro.json'] = '{}';
  assert.equal(await runLoop({ once: true, deps: f.deps }), 0);
  assert.equal(f.calls.sessions.length, 1, "a killed runner's leftovers stopped the next one from running");
  assert.match(f.files['/w/runner/log/runner.log'], /cleared runner\.json — the pid it named \(7777\) is gone/u);
  assert.equal('/w/runner/current-memoro.json' in f.files, false, 'the killed runner\'s in-flight file outlived it');
});

test('a lane file naming a dead pid is moved to runner/log and said once', () => {
  const f = fixture({ session: okSession(), livePids: [7000] });
  f.files['/w/runner/current-memoro-2.json'] = JSON.stringify({ name: 'msr-core-residue', step: 4, pid: 41100, lane: 2 });
  f.files['/w/runner/current-memoro-1.json'] = JSON.stringify({ name: 'a', step: 1, pid: 7000, lane: 1 });
  const runner = createRunner({ deps: f.deps });
  const held = runner.stepsHeld();
  assert.equal(held.length, 1);
  assert.equal(held[0].pid, 7000);
  assert.equal(held[0].other, true);
  assert.equal('/w/runner/current-memoro-2.json' in f.files, false);
  assert.equal(f.files['/w/runner/log/dead-current-memoro-2-41100.json'], JSON.stringify({ name: 'msr-core-residue', step: 4, pid: 41100, lane: 2 }));
  assert.deepEqual(f.calls.moved, [['/w/runner/current-memoro-2.json', '/w/runner/log/dead-current-memoro-2-41100.json']]);
  assert.match(f.files['/w/runner/log/runner.log'], /lane file current-memoro-2\.json names pid 41100, which is gone — msr-core-residue; moved to log\/dead-current-memoro-2-41100\.json/u);
  runner.stepsHeld();
  assert.equal(f.files['/w/runner/log/runner.log'].match(/lane file current-memoro-2\.json/gu).length, 1);
});

test('a lane file with no pid is not swept', () => {
  const f = fixture({ session: okSession() });
  f.files['/w/runner/current-memoro.json'] = '{}';
  const held = createRunner({ deps: f.deps }).stepsHeld();
  assert.equal(held.length, 1);
  assert.equal(held[0].pid, null);
  assert.equal(held[0].other, false);
  assert.equal('/w/runner/current-memoro.json' in f.files, true);
  assert.deepEqual(f.calls.moved, []);
});

/**
 * Landing a pull request is enough (Martin, 2026-10-18): the chore pass reads
 * origin/main of mc's own checkout — fetched by `askGithub()` a moment before —
 * and a runner behind it writes UPDATE itself, on a checkout that is clean and
 * fast-forwards. Once per origin/main sha.
 */
function newCodeFixture({ status = '', ff = true } = {}) {
  const f = fixture({});
  const checkout = mcCheckout({ exists: () => true });
  f.files[`${checkout}/.git`] = '';
  const git = f.deps.git;
  f.deps.git = (cwd, args) => {
    if (cwd !== checkout) return git(cwd, args);
    const said = args.join(' ');
    if (said === 'rev-parse --short HEAD') return { ok: true, stdout: 'aaa1111\n' };
    if (said === 'rev-parse --short origin/main') return { ok: true, stdout: 'bbb2222\n' };
    if (said === 'status --porcelain') return { ok: true, stdout: status };
    if (said === 'merge-base --is-ancestor HEAD origin/main') return { ok: ff, stdout: '' };
    return git(cwd, args);
  };
  const runner = createRunner({ deps: f.deps });
  runner.markRunner();
  return { f, runner };
}

test('a runner whose origin/main moved writes UPDATE itself, once', async () => {
  const { f, runner } = newCodeFixture();
  await runner.chores();
  assert.ok('/w/runner/UPDATE' in f.files, 'no UPDATE written for new code on origin/main');
  const said = /update: origin\/main is bbb2222 and this runner is on aaa1111 — UPDATE written by the runner/gu;
  assert.equal(f.files['/w/runner/log/runner.log'].match(said)?.length, 1);
  // The handover removes it; the same origin/main is not news a second time.
  delete f.files['/w/runner/UPDATE'];
  await runner.chores();
  assert.equal('/w/runner/UPDATE' in f.files, false, 'UPDATE written again for the same origin/main');
  assert.equal(f.files['/w/runner/log/runner.log'].match(said)?.length, 1);
});

test('a dirty checkout is said once and not handed over', async () => {
  const { f, runner } = newCodeFixture({ status: ' M x.js\n' });
  await runner.chores();
  await runner.chores();
  assert.equal('/w/runner/UPDATE' in f.files, false, 'a dirty checkout was handed over');
  assert.equal(f.files['/w/runner/log/runner.log'].match(/has uncommitted changes — not handing over/gu)?.length, 1);
});

test('a checkout that has diverged from origin/main is not handed over', async () => {
  const { f, runner } = newCodeFixture({ ff: false });
  await runner.chores();
  assert.equal('/w/runner/UPDATE' in f.files, false);
  assert.match(f.files['/w/runner/log/runner.log'], /has diverged from origin\/main — not handing over/u);
});

/**
 * `mc run start` on a stopping runner, from that runner's side: runner.json
 * comes to name another live pid while a step is in flight. The runner takes
 * nothing new, says who took over, finishes its step, and leaves the
 * successor's runner.json where it is (run-control.js `takeOver`).
 */
test('taken over: a runner whose runner.json names another pid finishes its session and leaves the file alone', async () => {
  const f = goalFixture({ a: {}, b: {} }, { livePids: [9001] });
  f.answer = async (call) => {
    f.files['/w/runner/runner.json'] = `${JSON.stringify({ pid: 9001, started: '2026-08-29T10:00:00Z', predecessor: { pid: 4242 } })}\n`;
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => { setImmediate(resolve); });
    return okSession()(call);
  };
  f.deps.sleep = () => new Promise((resolve) => { setImmediate(resolve); });
  f.deps.handOver = async () => { throw new Error('a runner taken over spawned a successor of its own'); };
  f.deps.laneCount = () => ({ lanes: 1 });
  assert.equal(await runLoop({ deps: f.deps }), 0);
  assert.equal(f.calls.sessions.length, 1, 'the runner taken over started another session');
  const log = f.files['/w/runner/log/runner.log'];
  assert.match(log, /taken over by pid 9001 — finishing 1 session\(s\) in flight, taking nothing new[\s\S]*goal:prog\/a: build done[\s\S]*every session pid 4242 held has ended — exiting/u);
  assert.equal(f.calls.removed.includes('/w/runner/runner.json'), false, "the old runner removed the new one's runner.json");
  assert.match(f.files['/w/runner/runner.json'], /"pid":9001/u);
});

// The start that spawned a runner writes runner.json with its pid before the
// runner has loaded; the runner finds itself there and starts, beside the
// predecessor that file names.
test('runLoop: runner.json already naming this pid is the start that spawned it, not a second runner', async () => {
  const f = goalFixture({ a: {} }, { livePids: [7777] });
  f.files['/w/runner/runner.json'] = `${JSON.stringify({ pid: 4242, started: '2026-08-29T10:00:00Z', args: ['--once'], predecessor: { pid: 7777, started: 'T0' } })}\n`;
  f.deps.env = { ...f.deps.env, MC_RUN_SUCCESSOR_OF: '7777' };
  assert.equal(await runLoop({ once: true, deps: f.deps }), 0);
  assert.equal(f.calls.sessions.length, 1);
  assert.match(f.files['/w/runner/log/runner.log'], /taking over from pid 7777/u);
});

// An idle lane's ten minutes are slices: a STOP is read within one.
test('runLoop: an idle lane reads STOP within a slice, not after its whole sleep', async () => {
  const f = fixture({ session: okSession() });
  const slept = [];
  f.deps.sleep = async (ms) => {
    slept.push(ms);
    if (slept.length === 3) f.files['/w/runner/STOP'] = '';
    await new Promise((resolve) => { setImmediate(resolve); });
  };
  assert.equal(await runLoop({ deps: f.deps }), 0);
  assert.ok(slept.every((ms) => ms <= 30_000), `a sleep longer than a slice: ${slept.join(', ')}`);
  assert.ok(slept.length < 20, `the runner slept on after STOP: ${slept.length} slices`);
});

/**
 * `mc run --update` from the runner's side, after ruling 28: the successor is
 * started at once, while the session is still in flight, and this runner only
 * finishes the session it is in — it is never cut short for the update.
 */
test('UPDATE file: the handover happens while the session is in flight, and the old runner exits after it', async () => {
  const f = goalFixture({ a: {} }, { livePids: [9001] });
  const stoppedIntervals = [];
  f.deps.every = (ms) => () => stoppedIntervals.push(ms);
  f.deps.refreshClaude = async () => ({ ok: false, why: 'fixture' });
  f.deps.refreshCodex = async () => ({ ok: false, why: 'fixture' });
  const events = [];
  f.answer = async (call) => {
    f.files['/w/runner/UPDATE'] = '';
    // Hold the session open until the handover has happened beside it.
    for (let i = 0; i < 50 && events.length === 0; i += 1) await new Promise((resolve) => { setImmediate(resolve); });
    events.push('session ends');
    return okSession()(call);
  };
  f.deps.sleep = () => new Promise((resolve) => { setImmediate(resolve); });
  const handovers = [];
  f.deps.handOver = async ({ paths, say, predecessor, finishing }) => {
    handovers.push({ update: paths.update, predecessor, finishing });
    events.push('handed over');
    // The successor writes its own files the moment it starts.
    f.files['/w/runner/runner.json'] = `${JSON.stringify({ pid: 9001, started: '2026-08-29T10:00:00Z', predecessor: { pid: 4242 } })}\n`;
    f.files['/w/runner/current-memoro-cli.json'] = `${JSON.stringify({ name: 'z', pid: 9001, lane: 0 })}\n`;
    say(`update: handed over to pid 9001 — finishing ${finishing} session(s) in flight, taking nothing new`);
    return { ok: true, pid: 9001 };
  };
  assert.equal(await runLoop({ deps: f.deps, awake: false }), 0);
  assert.ok(stoppedIntervals.includes(15 * 60 * 1000), 'the predecessor stops polling when its successor takes over');
  assert.equal(f.calls.sessions.length, 1);
  assert.deepEqual(handovers, [{ update: '/w/runner/UPDATE', predecessor: 4242, finishing: 1 }], 'one handover for the runner, not one per loop');
  assert.deepEqual(events, ['handed over', 'session ends'], 'the handover waited for the session to end');
  const log = f.files['/w/runner/log/runner.log'];
  assert.match(log, /handed over to pid 9001 — finishing 1 session\(s\) in flight, taking nothing new[\s\S]*goal:prog\/a: build done[\s\S]*every session pid 4242 held has ended — exiting/u);
  // The successor's files are its own: this runner leaves without touching them.
  assert.equal(f.calls.removed.includes('/w/runner/runner.json'), false, 'the old runner removed runner.json on its way out');
  assert.equal(f.calls.removed.includes('/w/runner/current-memoro-cli.json'), false, "the old runner removed the successor's lane file");
  assert.match(f.files['/w/runner/runner.json'], /"pid":9001/u);
});

test('UPDATE file: the successor starts beside its live predecessor, and runner.json names both', async () => {
  // The handover starts a second `mc run` while the first is still alive, on
  // purpose. The successor's start accepts that one live holder because the
  // environment it was spawned with names it. This drives the real `handOver`
  // and starts a real successor loop from `respawn`.
  const f = goalFixture({ a: {} }, { livePids: [4242, 9001] });
  const inner = f.deps.session;
  // The predecessor's session asks for the update and stays in flight until
  // its successor has had its pick.
  let finish = null;
  const finished = new Promise((resolve) => { finish = resolve; });
  f.answer = async (call) => { f.files['/w/runner/UPDATE'] = ''; await finished; return okSession()(call); };
  f.deps.sleep = () => new Promise((resolve) => { setImmediate(resolve); });
  let successor = null;
  let spawnedWith = null;
  let successorFile = null;
  f.deps.respawn = (opts) => {
    spawnedWith = opts;
    const writeJson = (p, v) => { if (p === '/w/runner/runner.json' && successorFile === null) successorFile = v; f.deps.writeJson(p, v); };
    successor = runLoop({ once: true, deps: { ...f.deps, pid: 9001, session: inner, writeJson, env: { ...f.deps.env, ...opts.env } } });
    successor.finally(() => finish());
    return 9001;
  };
  assert.equal(await runLoop({ deps: f.deps }), 0);
  assert.deepEqual(spawnedWith, { env: { MC_RUN_SUCCESSOR_OF: '4242' } });
  assert.equal(await successor, 0, 'the successor refused to start');
  const log = f.files['/w/runner/log/runner.log'];
  assert.equal(/a runner is already running/u.test(log), false, 'the handover tripped the holder refusal');
  assert.match(log, /update: taking over from pid 4242/u);
  assert.equal(successorFile.pid, 9001);
  assert.equal(successorFile.predecessor.pid, 4242, 'runner.json did not name the runner still finishing');
  // The predecessor's session in flight is claimed: the successor did not start it again.
  assert.equal(f.calls.sessions.length, 1, 'the successor started the goal its predecessor holds');
});

test('a successor lane waits while its predecessor holds the lane file, skips that goal, then starts it', async () => {
  const f = goalFixture({ a: {}, b: {} }, { livePids: [4242, 7000] });
  f.deps.laneCount = () => ({ lanes: 2 });
  f.deps.env = { ...f.deps.env, MC_RUN_SUCCESSOR_OF: '7000' };
  f.files['/w/runner/runner.json'] = `${JSON.stringify({ pid: 7000, started: '2026-08-29T09:00:00Z' })}\n`;
  f.files['/w/runner/current-memoro-1.json'] = `${JSON.stringify({ name: 'goal:prog/a', step: null, pid: 7000, lane: 1 })}\n`;
  const started = [];
  let polls = 0;
  f.answer = (call) => {
    if (!call.env.MC_GOAL) return okSession()(call);
    started.push(call.env.MC_GOAL.split('/')[1]);
    return endsGoal(f)(call);
  };
  let sleeps = 0;
  f.deps.sleep = async (ms) => {
    sleeps += 1;
    if (started.length >= 2 || sleeps > 500) f.files['/w/runner/STOP'] = '';
    if (ms !== UPDATE_POLL_MS) return;
    polls += 1;
    // Lane 2 has waited a few polls; the predecessor's session ends.
    if (polls === 3) delete f.files['/w/runner/current-memoro-1.json'];
  };
  assert.equal(await runLoop({ deps: f.deps }), 0);
  const log = f.files['/w/runner/log/runner.log'];
  assert.equal(log.split('\n').filter((line) => line.includes('lane 2: waiting for pid 7000 to finish goal:prog/a')).length, 1, `said once:\n${log}`);
  // Lane 0 took b, not the a its predecessor held; once the file was gone,
  // a was taken.
  assert.equal(started[0], 'b', `the predecessor's project was not claimed: ${started.join(', ')}`);
  assert.ok(started.includes('a'), `lane 1 never started once the file was gone: ${started.join(', ')}`);
});

/**
 * A handover that cannot start its successor used to end the process with
 * runner.json just re-marked — the page said a runner was running while none
 * was. The loop keeps going instead, and the next pick happens.
 */
test('UPDATE file: a handover that does not start keeps this runner going, and the next pick happens', async () => {
  const f = goalFixture({ a: {} });
  f.files['/w/runner/UPDATE'] = '';
  const handovers = [];
  f.deps.handOver = async ({ say }) => { handovers.push('try'); say('update: the new runner did not start'); return { ok: false }; };
  let held = null;
  f.answer = (call) => {
    held = { runner: '/w/runner/runner.json' in f.files, update: '/w/runner/UPDATE' in f.files };
    f.files['/w/runner/STOP'] = '';
    return okSession()(call);
  };
  assert.equal(await runLoop({ deps: f.deps }), 0);
  assert.deepEqual(handovers, ['try'], 'the drain did not reach the handover, or tried it twice');
  assert.equal(f.calls.sessions.length, 1, 'no pick happened after the failed handover');
  assert.deepEqual(held, { runner: true, update: false }, 'the session ran with no runner.json, or under the UPDATE that failed');
  const log = f.files['/w/runner/log/runner.log'];
  assert.match(log, /update: could not hand over — this runner keeps going on [^;]+; mc run --update to try again[\s\S]*goal:prog\/a: build done[\s\S]*runner exit on STOP/u);
  assert.equal(/runner exit — the update did not hand over/u.test(log), false);
});

/**
 * `--once` is one session: one lane over every repository, and out.
 * `--rounds N` is gone with the round (2026-09-08) — the flag is answered
 * by name in `parseRunArgs`, and this is what is left of the pair.
 */
test('runLoop: --once takes the first goal that could start and exits', async () => {
  const g = goalFixture({ a: {}, b: {} });
  assert.equal(await runLoop({ once: true, deps: g.deps }), 0);
  assert.deepEqual(g.calls.sessions.map((call) => call.cwd), [`${GOALS}/a/memoro`]);
  assert.match(g.files['/w/runner/log/runner.log'], /once: next — goal:prog\/a \(build goal\)\n[\s\S]*once: exiting/u);

  // Nothing to run is not a failure and not a silence: the one line says so.
  const empty = fixture({ session: okSession() });
  assert.equal(await runLoop({ once: true, deps: empty.deps }), 0);
  assert.equal(empty.calls.sessions.length, 0);
  assert.match(empty.files['/w/runner/log/runner.log'], /once: nothing to run/u);
});

test('current-<repo>.json exists only while the session is in flight, and runner.json only while the loop runs', async () => {
  const f = goalFixture({ alpha: {} });
  assert.equal(await runLoop({ once: true, deps: f.deps }), 0);

  const during = f.duringSession[0];
  const current = JSON.parse(during['/w/runner/current-memoro.json']);
  const { model, effort, advisor } = current;
  assert.ok(model, 'the model the class was routed to');
  assert.deepEqual(current, {
    name: 'goal:prog/alpha', step: null, kind: 'build', variant: 'goal', programme: 'prog', repo: 'memoro', lane: 0, tool: 'claude', model, effort, advisor, class: 'large', billing: 'plan', check_in_minutes: 60, check_ins: 0,
    started: '2026-08-29T10:00:00Z', pid: 4242, worktree: `${GOALS}/alpha/memoro`, role: goalRole,
  });
  assert.deepEqual(JSON.parse(during['/w/runner/runner.json']), { pid: 4242, started: '2026-08-29T10:00:00Z', args: [], takeover: true });

  // ...and both are gone once the session and the loop are over.
  assert.equal('/w/runner/current-memoro.json' in f.files, false);
  assert.equal('/w/runner/runner.json' in f.files, false);
});

test('a check-in is counted in the current file while the session runs', async () => {
  let seen = null;
  let said = null;
  const f = goalFixture({ alpha: {} });
  f.answer = (call) => {
    call.checkIn(60, 1);
    said = call.checkIn(120, 2);
    seen = JSON.parse(f.files['/w/runner/current-memoro.json']);
    return okSession()(call);
  };
  await createRunner({ deps: f.deps }).pass();
  assert.deepEqual([seen.check_in_minutes, seen.check_ins], [60, 2]);
  assert.match(f.files['/w/runner/log/runner.log'], /goal:prog\/alpha: check-in 1 at 60 min\n.*goal:prog\/alpha: check-in 2 at 120 min/u);
  assert.match(said, /running for 120 minutes \(this is check-in number 2\)[\s\S]*still moving the goal/u, "the goal's own check-in");
});

test('the current file is removed even when the session throws', async () => {
  const f = goalFixture({ alpha: {} });
  f.answer = () => { throw new Error('boom'); };
  const runner = createRunner({ deps: f.deps });
  await assert.rejects(runner.pass(), /boom/u);
  assert.equal(JSON.parse(f.duringSession[0]['/w/runner/current-memoro.json']).name, 'goal:prog/alpha');
  assert.equal('/w/runner/current-memoro.json' in f.files, false);
});

/* ---------------------------------------------------------------- lanes */

/**
 * Two lanes inside the one `mc run` process: a goal of memoro and a goal of
 * memoro-cli never touch — different worktrees, different PRs — so both run
 * at once.
 */
test('two lanes: a memoro goal and a memoro-cli goal are in flight at the same time', async () => {
  const inFlight = new Set();
  const seen = [];
  let release = () => {};
  const both = new Promise((resolve) => { release = resolve; });
  const f = goalFixture({ alpha: {}, beta: { repos: 'memoro-cli' } });
  f.answer = async (call) => {
    inFlight.add(call.cwd);
    seen.push([...inFlight].sort());
    if (inFlight.size === 2) release();
    await both;
    inFlight.delete(call.cwd);
    return okSession()();
  };
  const guard = setTimeout(release, 5000);
  await round(createRunner({ deps: f.deps }));
  clearTimeout(guard);

  assert.deepEqual(seen.at(-1), [`${GOALS}/alpha/memoro`, `${GOALS}/beta/memoro-cli`], 'both sessions were running at once');
  // And each lane said so in its own file, both present at the same moment.
  const during = f.duringSession.at(-1);
  assert.equal(JSON.parse(during['/w/runner/current-memoro.json']).name, 'goal:prog/alpha');
  assert.equal(JSON.parse(during['/w/runner/current-memoro-cli.json']).name, 'goal:prog/beta');
  // Each lane says what it took, and the two lines are the two lanes.
  assert.match(f.files['/w/runner/log/runner.log'], /memoro: next — goal:prog\/alpha[\s\S]*memoro-cli: next — goal:prog\/beta/u);
});

test('STOP ends both lanes after the session each is in', async () => {
  const f = goalFixture({ a: {}, a2: {}, b: { repos: 'memoro-cli' }, b2: { repos: 'memoro-cli' } });
  const bothStarted = Promise.withResolvers();
  let started = 0;
  f.answer = async (call) => {
    started += 1;
    if (started === 2) { f.files['/w/runner/STOP'] = ''; bothStarted.resolve(); }
    await bothStarted.promise;
    return okSession()(call);
  };
  assert.equal(await runLoop({ deps: f.deps }), 0);
  assert.equal(f.calls.sessions.length, 2, 'one session in each lane, and no more');
  assert.deepEqual(f.calls.sessions.map((call) => call.cwd).sort(), [`${GOALS}/a/memoro`, `${GOALS}/b/memoro-cli`]);
  assert.match(f.files['/w/runner/log/runner.log'], /: STOP — goal:prog\/a has ended, this lane takes nothing more/u);
  assert.match(f.files['/w/runner/log/runner.log'], /: STOP — goal:prog\/b has ended, this lane takes nothing more/u);
});

/* ------------------------------------------------------------- the helper */

/**
 * The collect is one of the two things in a round that are not steps. It opens
 * no worktree, touches no branch and calls no model: what proves it ran is its
 * rows in runs.tsv, and those rows are also the gate — there is no second stamp
 * file to fall out of step with them.
 */
test('the collect runs once per calendar day, logged as kind helper with helper in the name', async () => {
  const f = fixture({ session: okSession() });
  const runner = createRunner({ deps: f.deps });
  await round(runner);
  const first = runRows(f.files).filter((r) => r.kind === 'helper');
  // One row per repository: memoro's production is the deployed service,
  // memoro-cli's is this machine, and a single row could not say which of
  // them failed.
  assert.equal(first.length, 2);
  assert.deepEqual(
    first.map((r) => ({ name: r.name, exit: r.exit, pr: r.pr, note: r.note })),
    [
      { name: 'helper', exit: '0', pr: '-', note: 'success,memoro,1-new' },
      { name: 'helper', exit: '0', pr: '-', note: 'success,memoro-cli,1-new' },
    ],
  );
  // The outcome first and the repository after, because `summariseRuns` reads a
  // note that does not start with `success` as a failure — and every helper row
  // written before 2026-09-05 read `memoro,success,…`, which it counted as one.
  assert.equal(first[0].turns, '-', 'no model runs in the collect half');
  assert.deepEqual(f.calls.collects.map((c) => c.repo), ['memoro', 'memoro-cli']);

  await round(runner);
  assert.equal(runRows(f.files).filter((r) => r.kind === 'helper').length, 2, 'a second round the same day does not run it again');
  assert.equal(f.calls.collects.length, 2);
  assert.ok(f.log.some((line) => /already ran today/u.test(line)) === false, 'the gate is silent — nobody reads a skip line');
});

test('the helper waits for 05:00Z, and runs in the first round after it', async () => {
  const early = fixture({ now: '2026-08-29T04:59:00Z' });
  await round(createRunner({ deps: early.deps }));
  assert.equal(early.calls.collects.length, 0);
  assert.deepEqual(runRows(early.files).filter((r) => r.kind === 'helper'), []);

  const late = fixture({ now: '2026-08-29T05:00:00Z' });
  await round(createRunner({ deps: late.deps }));
  assert.equal(late.calls.collects.length, 2, 'both repositories, once the day has started');
});

test('yesterday\'s helper row does not count as today\'s', async () => {
  const yesterday = 'ts\tname\tkind\texit\tseconds\tpr\tturns\tinput\toutput\tcache_read\tcache_write\tsession\tnote\n'
    + '2026-08-28T06:00:00Z\thelper\thelper\t0\t120\t-\t3\t-\t-\t-\t-\t-\tsuccess,0-proposals\n';
  const f = fixture({ runs: yesterday });
  await round(createRunner({ deps: f.deps }));
  assert.equal(f.calls.collects.length, 2);
  assert.equal(runRows(f.files).filter((r) => r.kind === 'helper').length, 3, 'yesterday\'s one row plus today\'s two');
});

/**
 * A failed collect is a logged fact, not a retry loop: production being
 * unreachable at 05:00 must not cost twenty attempts before noon.
 */
test('a failed collect is logged and never retried within the day', async () => {
  const f = fixture({ collect: async () => { throw new Error('wrangler is not logged in'); } });
  const runner = createRunner({ deps: f.deps });
  await round(runner);
  const rows = runRows(f.files).filter((r) => r.kind === 'helper');
  assert.deepEqual(rows.map((r) => r.note), ['collect-failed,memoro', 'collect-failed,memoro-cli']);
  assert.deepEqual(rows.map((r) => r.exit), ['1', '1']);
  assert.ok(f.log.some((line) => /memoro: the collect step failed — wrangler is not logged in/u.test(line)));

  await round(runner);
  assert.equal(f.calls.collects.length, 2, 'both were tried once; neither is retried today');
});

/**
 * One repository failing must not silence the other. memoro's collect needs
 * wrangler and the network; memoro-cli's reads four files on this disk. They
 * do not share a failure domain, and the digest has always reported per
 * section rather than failing as a unit for exactly that reason.
 */
test('a repository whose collect throws does not cost the other its digest', async () => {
  const f = fixture({
    collect: async (options) => {
      if (options.repo === 'memoro') throw new Error('wrangler is not logged in');
      return { path: '/w/intake/errors-memoro-cli-2026-08-29.md', text: '# mc itself', repo: 'memoro-cli', data: { delta: { first: true, fingerprints: [], failing: [] }, errors: { rows: [] }, notes: [] } };
    },
  });
  await round(createRunner({ deps: f.deps }));
  const rows = runRows(f.files).filter((r) => r.kind === 'helper');
  assert.deepEqual(rows.map((r) => r.note), ['collect-failed,memoro', 'success,memoro-cli,first-digest']);
  assert.ok(f.log.some((line) => /memoro: the collect step failed/u.test(line)));
});

test('--once is one session, no collect and no drain', async () => {
  const f = goalFixture({ alpha: {} }, { inbox: ['errors-memoro-2026-08-28.md'] });
  assert.equal(await runLoop({ once: true, deps: f.deps }), 0);
  assert.equal(f.calls.sessions.length, 1);
  assert.equal(f.calls.collects.length, 0, '--once exists to watch one session, not to call production');
  assert.equal(f.calls.turns.length, 0);
  assert.deepEqual(runRows(f.files).map((r) => r.kind), ['build-goal']);
});

test('a STOP file stops the collect and the drain as well as the sessions', async () => {
  const f = fixture({ inbox: ['errors-memoro-2026-08-28.md'] });
  f.files['/w/runner/STOP'] = '';
  await round(createRunner({ deps: f.deps }));
  assert.equal(f.calls.collects.length, 0);
  assert.equal(f.calls.turns.length, 0);
});

/* --------------------------------------------------- the daily deps reading */

/**
 * `mc deps` of every repository, once a day, on the nightly's cadence and by
 * its own row — before the tick, so a tick a STOP ends does not leave it
 * unread. A fixture without `readDeps` reads nothing.
 */
const depsRowAt = (ts) => `${ts}\tdeps\tdeps\t0\t60\t-\t-\t-\t-\t-\t-\t-\tsuccess,2-read\n`;
const DEPS_HEADER = 'ts\tname\tkind\texit\tseconds\tpr\tturns\tinput\toutput\tcache_read\tcache_write\tsession\tnote\n';

test('the deps are read once a day, every repository, before the nightly tick', async () => {
  const f = fixture({ now: '2026-08-29T10:00:00Z', runs: DEPS_HEADER + depsRowAt('2026-08-28T09:00:00Z') });
  const read = [];
  f.deps.readDeps = async ({ repoPath, repo }) => {
    read.push({ repo, repoPath, ticks: f.calls.ticks.length });
    return { reading: { sha: 'abc1234def', audit: { counts: { critical: 0, high: 12 } } } };
  };
  await createRunner({ deps: f.deps }).chores();
  assert.deepEqual(read, [
    { repo: 'memoro', repoPath: '/home/memoro', ticks: 0 },
    { repo: 'memoro-cli', repoPath: '/home/memoro-cli', ticks: 0 },
  ]);
  const rows = runRows(f.files).filter((r) => r.kind === 'deps');
  assert.equal(rows.length, 2, 'the old row and the new one');
  assert.deepEqual({ exit: rows[1].exit, note: rows[1].note }, { exit: '0', note: 'success,2-read' });
  assert.match(f.files['/w/runner/log/runner.log'], /deps: memoro at abc1234 — 0 critical, 12 high/u);

  const recent = fixture({ now: '2026-08-29T10:00:00Z', runs: DEPS_HEADER + depsRowAt('2026-08-29T08:00:00Z') });
  recent.deps.readDeps = async () => { throw new Error('read 2 h after the last'); };
  await createRunner({ deps: recent.deps }).chores();
  assert.equal(runRows(recent.files).filter((r) => r.kind === 'deps').length, 1, 'no second row');
});

/* ------------------------------------------------------------- mc tidy */

/**
 * `mc tidy --apply` once a day by its own `TIDY_KIND` row, and after a lane
 * skipped for disk at most once an hour. A fixture without `tidy` runs none.
 */
const tidyRowAt = (ts) => `${ts}\t${TIDY_KIND}\t${TIDY_KIND}\t0\t3\t-\t-\t-\t-\t-\t-\t-\tfreed=0,items=0,kept=0\n`;
const tidied = (outcome) => async () => ({ outcome });

test('tidy runs once a day by its own row, and notes what it freed', async () => {
  const f = fixture({ now: '2026-08-29T10:00:00Z', runs: DEPS_HEADER + tidyRowAt('2026-08-28T09:00:00Z') });
  let calls = 0;
  f.deps.tidy = async () => { calls += 1; return tidied({ freed: 2.5e9, removed: 40, kept: 1 })(); };
  const runner = createRunner({ deps: f.deps });
  await runner.chores();
  await runner.chores();
  assert.equal(calls, 1, 'the second pass finds today\'s row');
  const rows = runRows(f.files).filter((r) => r.kind === TIDY_KIND);
  assert.equal(rows.length, 2, 'the old row and the new one');
  assert.deepEqual({ exit: rows[1].exit, note: rows[1].note }, { exit: '0', note: 'freed=2500000000,items=40,kept=1' });
  assert.match(f.files['/w/runner/log/runner.log'], /tidy \(daily\): freed 2\.50 GB in 40 items, kept 1 on re-check/u);
});

test('the tidy line says what Docker reclaimed, and nothing when Docker was down', async () => {
  const f = fixture({ now: '2026-08-29T10:00:00Z', runs: DEPS_HEADER + tidyRowAt('2026-08-28T09:00:00Z') });
  f.deps.tidy = async () => ({
    outcome: { freed: 0, removed: 0, kept: 0 },
    docker: { up: true, pruned: [{ what: 'images', ok: false, detail: 'busy' }] },
  });
  await createRunner({ deps: f.deps }).chores();
  assert.match(f.files['/w/runner/log/runner.log'], /kept 0 on re-check · docker: images failed — busy/u);
  assert.equal(dockerNote({ up: false, pruned: [] }), '');
  assert.equal(dockerNote(null), '');
});

test('runner.log is rotated once per chore pass, at RUNNER_LOG_MAX_BYTES', async () => {
  const f = fixture({});
  const asked = [];
  f.deps.rotate = (path, maxBytes) => { asked.push({ path, maxBytes }); return false; };
  const runner = createRunner({ deps: f.deps });
  await runner.chores();
  assert.deepEqual(asked, [{ path: '/w/runner/log/runner.log', maxBytes: RUNNER_LOG_MAX_BYTES }]);
  assert.equal(RUNNER_LOG_MAX_BYTES, 32 * 1024 * 1024);
});

test('rotateIfLarge moves a file over the limit to .1 and leaves a smaller one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mc-rotate-'));
  try {
    const path = join(dir, 'runner.log');
    writeFileSync(path, 'x'.repeat(10));
    assert.equal(rotateIfLarge(path, 11), false);
    assert.equal(readFileSync(path, 'utf8').length, 10);
    assert.equal(rotateIfLarge(path, 10), true);
    assert.equal(readFileSync(`${path}.1`, 'utf8').length, 10);
    assert.equal(rotateIfLarge(path, 10), false, 'nothing there is nothing to rotate');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a repository whose deps cannot be read is named in the row, and the others are read', async () => {
  const f = fixture({});
  f.deps.readDeps = async ({ repo }) => {
    if (repo === 'memoro') throw new Error('npm audit printed no JSON');
    return { reading: { sha: 'abc1234def', audit: { counts: {} } } };
  };
  await createRunner({ deps: f.deps }).chores();
  const [row] = runRows(f.files).filter((r) => r.kind === 'deps');
  assert.deepEqual({ exit: row.exit, note: row.note }, { exit: '1', note: 'failed,memoro' });
  assert.match(f.files['/w/runner/log/runner.log'], /deps: memoro not read — npm audit printed no JSON/u);
});

/* ------------------------------------------------------ the nightly's tick */

/**
 * The tick is the third and last thing a chore pass does. Like the helper, a
 * row in runs.tsv is its whole state — but the cadence is a day since the last
 * row, not an hour of the clock, and STOP is asked before it and between the
 * repositories it measures.
 */
const NIGHTLY_HEADER = 'ts\tname\tkind\texit\tseconds\tpr\tturns\tinput\toutput\tcache_read\tcache_write\tsession\tnote\n';
const nightlyRowAt = (ts) => `${ts}\tnightly\tnightly\t0\t900\t-\t-\t-\t-\t-\t-\t-\tsuccess,2-measured,0-unchanged\n`;

test('the nightly tick is performed when a day has passed since the last, and its row says so', async () => {
  const f = fixture({
    now: '2026-08-29T10:00:00Z',
    runs: NIGHTLY_HEADER + nightlyRowAt('2026-08-28T09:00:00Z'),
    nightly: async () => ({ runs: [{ stopped_at: null }, { stopped_at: 'unchanged' }], skipped: null, stopped: false }),
  });
  await createRunner({ deps: f.deps }).chores();
  assert.equal(f.calls.ticks.length, 1);
  assert.equal(typeof f.calls.ticks[0].shouldStop, 'function');
  const rows = runRows(f.files).filter((r) => r.kind === 'nightly');
  assert.equal(rows.length, 2, 'the old row and the new one');
  assert.deepEqual({ name: rows[1].name, exit: rows[1].exit, pr: rows[1].pr, note: rows[1].note },
    { name: 'nightly', exit: '0', pr: '-', note: 'success,1-measured,1-unchanged' });
  assert.match(f.files['/w/runner/log/runner.log'], /nightly: a full run of every repository — the last tick was 25 h ago/u);
});

test('the very first tick is due at once, and a tick 2 h old is not due', async () => {
  const first = fixture({});
  await createRunner({ deps: first.deps }).chores();
  assert.equal(first.calls.ticks.length, 1);

  const recent = fixture({ now: '2026-08-29T10:00:00Z', runs: NIGHTLY_HEADER + nightlyRowAt('2026-08-29T08:00:00Z') });
  await createRunner({ deps: recent.deps }).chores();
  assert.equal(recent.calls.ticks.length, 0);
  assert.equal(runRows(recent.files).filter((r) => r.kind === 'nightly').length, 1, 'no second row');
});

test('a STOP file means no tick: the suite is never started', async () => {
  const f = fixture({});
  f.files['/w/runner/STOP'] = '';
  await round(createRunner({ deps: f.deps }));
  assert.equal(f.calls.ticks.length, 0);
  assert.deepEqual(runRows(f.files).filter((r) => r.kind === 'nightly'), []);
});

test('a STOP file that appears mid-tick is what the tick sees before its next repository', async () => {
  const f = fixture({
    nightly: async ({ shouldStop }) => {
      const before = shouldStop();
      f.files['/w/runner/STOP'] = '';
      return { runs: [{ stopped_at: null }], skipped: null, stopped: !before && shouldStop() };
    },
  });
  await createRunner({ deps: f.deps }).chores();
  const [row] = runRows(f.files).filter((r) => r.kind === 'nightly');
  assert.equal(row.exit, '0');
  assert.match(row.note, /^success,1-measured,0-unchanged,stopped$/u);
  assert.match(f.files['/w/runner/log/runner.log'], /nightly: stopped — 1 repository read/u);
});

test('a tick that throws is a failed row and is not retried in the same day', async () => {
  const f = fixture({ nightly: async () => { throw new Error('disk full'); } });
  const runner = createRunner({ deps: f.deps });
  await runner.chores();
  await runner.chores();
  const rows = runRows(f.files).filter((r) => r.kind === 'nightly');
  assert.equal(rows.length, 1, 'the second pass finds the row and waits');
  assert.equal(rows[0].exit, '1');
  assert.equal(rows[0].note, 'tick-failed,disk full');
  assert.equal(f.calls.ticks.length, 1);
});

test('a UPDATE file ends the tick the way STOP does', async () => {
  const f = fixture({
    nightly: async ({ shouldStop }) => { f.files['/w/runner/UPDATE'] = ''; return { runs: [], skipped: null, stopped: shouldStop() }; },
  });
  await createRunner({ deps: f.deps }).chores();
  assert.match(runRows(f.files).find((r) => r.kind === 'nightly').note, /,stopped$/u);
});

/* -------------------------------------------------------------- the drain */

/** The archive a drained file lands in, under the fixture's fixed day. */
const ARCHIVE = '/w/runner/log/intake/2026-08-29';

const inboxLeft = (files) => Object.keys(files)
  .filter((key) => key.startsWith('/w/intake/') && !key.slice('/w/intake/'.length).includes('/'))
  .map((key) => key.slice('/w/intake/'.length))
  .sort();

/**
 * The whole of step 3, in one round: one turn per file, oldest first by the
 * date in the name, the file archived the moment its turn ends, and a row that
 * names it.
 */
test('the drain takes the oldest files first, one turn each, and archives every one', async () => {
  const f = fixture({
    inbox: ['note-from-martin.md', 'errors-memoro-cli-2026-08-27.md', 'errors-memoro-2026-08-26.md'],
  });
  await createRunner({ deps: f.deps }).runIntakeDrain();

  // Oldest first by the date the name carries. `note-from-martin.md` has no
  // date and sorts last: the dated files were written on the day they name,
  // and a file Martin dropped in by hand arrived now.
  assert.deepEqual(f.calls.turns.map((c) => c.file), [
    'errors-memoro-2026-08-26.md', 'errors-memoro-cli-2026-08-27.md', 'note-from-martin.md',
  ]);
  // The repository is not passed. `repoOfFile` reads it out of the collector's
  // own names, and answers null for anything a person dropped in.
  assert.deepEqual(f.calls.turns.map((c) => c.repo), [undefined, undefined, undefined]);

  const rows = runRows(f.files).filter((r) => r.kind === 'intake');
  assert.deepEqual(rows.map((r) => ({ name: r.name, exit: r.exit, note: r.note })), [
    { name: 'errors-memoro-2026-08-26.md', exit: '0', note: 'success,1-proposals' },
    { name: 'errors-memoro-cli-2026-08-27.md', exit: '0', note: 'success,1-proposals' },
    { name: 'note-from-martin.md', exit: '0', note: 'success,1-proposals' },
  ]);
  assert.equal(rows[0].turns, '3', 'the turn is a model call and its usage is logged like a step');
  assert.equal(rows[0].cache_read, '30');

  assert.deepEqual(inboxLeft(f.files), [], 'the inbox drained');
  for (const name of ['errors-memoro-2026-08-26.md', 'errors-memoro-cli-2026-08-27.md', 'note-from-martin.md']) {
    assert.equal(f.files[`${ARCHIVE}/${name}`], `# ${name}`, `${name} is in the archive, not deleted`);
  }
  // A directory in the inbox is not an item. `decisions-archive/` is an
  // archive already, and draining it would file answered decisions as news.
  assert.equal(f.files['/w/intake/decisions-archive/mc-2.md'], '# an answered decision');
});

/**
 * The rule that makes the drain terminate: a turn that failed has still had its
 * turn. A file put back is a file every round after this one takes again.
 */
test('a turn that failed still archives its file, and the row carries the failure', async () => {
  const f = fixture({
    inbox: ['errors-memoro-2026-08-26.md'],
    helperTurn: async () => ({ ok: false, status: 1, reason: 'no-tool', note: 'claude is not on PATH', wrote: [], waiting: [] }),
  });
  await createRunner({ deps: f.deps }).runIntakeDrain();

  const [row] = runRows(f.files).filter((r) => r.kind === 'intake');
  assert.deepEqual({ name: row.name, exit: row.exit, note: row.note }, {
    name: 'errors-memoro-2026-08-26.md', exit: '1', note: 'no-tool',
  });
  assert.deepEqual(inboxLeft(f.files), []);
  assert.equal(f.files[`${ARCHIVE}/errors-memoro-2026-08-26.md`], '# errors-memoro-2026-08-26.md');
  assert.ok(f.log.some((line) => /intake: errors-memoro-2026-08-26\.md — the turn did not finish: no-tool/u.test(line)));
});

/** A turn that threw is the one path that would otherwise skip the archive. */
test('a turn that threw is archived too, and named as having thrown', async () => {
  const f = fixture({
    inbox: ['errors-memoro-2026-08-26.md'],
    helperTurn: async () => { throw new Error('claude died'); },
  });
  await createRunner({ deps: f.deps }).runIntakeDrain();
  const [row] = runRows(f.files).filter((r) => r.kind === 'intake');
  assert.equal(row.note, 'turn-threw');
  assert.deepEqual(inboxLeft(f.files), []);
});

/**
 * The gate the split exists for: the drain asks whether there is a file, not
 * whether the day's collect has run. Thirteen files is five rounds, not
 * thirteen days.
 */
test('the drain runs every round until the inbox is empty, however the collect went', async () => {
  const yesterday = 'ts\tname\tkind\texit\tseconds\tpr\tturns\tinput\toutput\tcache_read\tcache_write\tsession\tnote\n'
    + '2026-08-29T05:00:00Z\thelper\thelper\t0\t2\t-\t-\t-\t-\t-\t-\t-\tsuccess,memoro,0-new\n';
  const f = fixture({
    runs: yesterday,
    inbox: ['a-2026-08-20.md', 'b-2026-08-21.md', 'c-2026-08-22.md', 'd-2026-08-23.md'],
  });
  const runner = createRunner({ deps: f.deps });

  await round(runner);
  assert.equal(f.calls.collects.length, 0, 'today\'s collect has already run');
  assert.equal(f.calls.turns.length, 3, 'three a round, so a round stays bounded');
  assert.deepEqual(inboxLeft(f.files), ['d-2026-08-23.md']);
  assert.ok(f.log.some((line) => /intake: 1 file\(s\) still waiting/u.test(line)));

  await round(runner);
  assert.equal(f.calls.turns.length, 4);
  assert.deepEqual(inboxLeft(f.files), [], 'and it keeps going across rounds until nothing is left');

  await round(runner);
  assert.equal(f.calls.turns.length, 4, 'an empty inbox costs a listing and no turn');
  assert.equal(runRows(f.files).filter((r) => r.kind === 'intake').length, 4);
});

/* ----------------------------------------------------------- archiving */

/**
 * A plan that reaches `done` is archived (Martin, 2026-08-29: "När en plan
 * är DONE ska den arkiveras. Punkt."). The runner used to answer a done plan
 * with a skip line and nothing else — measured on 2026-08-29, ten directories
 * under `docs/project/` in the two repositories held a plan that said `done`,
 * and `docs/plans/`, the directory `docs/project/` replaced, had reached 656
 * files the same way.
 */

/* ------------------------------------------------- programmes (ruling 48) */

/* ------------------------------------------------------------- closing */

/* --------------------------------------------------------------- queue */

/**
 * The runner holds the machine awake — for a real run, not for a watched one.
 *
 * The rules live in stay-awake.js and are asserted there. What this asserts is
 * the wiring: that the loop actually asks, that it asks once, before the first
 * round rather than after it, and that `--once` — a person watching a single
 * step — does not hold anything.
 */
test('runLoop: an unattended run holds the machine awake; --once does not', async () => {
  const held = [];
  const f = goalFixture({ a: {} });
  f.deps.keepAwake = (options) => {
    held.push({ ...options, stepsSoFar: f.calls.sessions.length });
    return { ok: true, pid: 9, flags: ['-i', '-m', '-s'], note: 'held' };
  };
  f.deps.onACPower = () => true;
  stopAfterAStep(f);
  assert.equal(await runLoop({ deps: f.deps }), 0);
  assert.equal(held.length, 1, 'asked once, not once per session');
  assert.equal(held[0].pid, process.pid);
  assert.equal(held[0].onAC, true);
  assert.equal(held[0].stepsSoFar, 0, 'held before the first session, not after it');
  assert.match(f.files['/w/runner/log/runner.log'], /staying awake \(caffeinate -i -m -s pid 9\)/u);

  const g = goalFixture({ a: {} });
  const watched = [];
  g.deps.keepAwake = (options) => { watched.push(options); return { ok: true, pid: 9, flags: [], note: '' }; };
  assert.equal(await runLoop({ once: true, deps: g.deps }), 0);
  assert.deepEqual(watched, [], '--once is somebody watching; it holds nothing');
});

test('runLoop: a machine that will not stay awake still runs, and says so', async () => {
  const f = goalFixture({ a: {} });
  f.deps.keepAwake = () => ({ ok: false, reason: 'caffeinate-missing', flags: [], note: 'caffeinate could not be run' });
  f.deps.onACPower = () => null;
  stopAfterAStep(f);
  assert.equal(await runLoop({ deps: f.deps }), 0, 'the run is not blocked by it');
  assert.equal(f.calls.sessions.length, 1);
  assert.match(f.files['/w/runner/log/runner.log'], /NOT staying awake \(caffeinate-missing\)/u);
});

test('runLoop: --no-caffeinate is obeyed', async () => {
  const f = goalFixture({ a: {} });
  const asked = [];
  f.deps.keepAwake = (options) => { asked.push(options); return { ok: true, pid: 1, flags: [], note: '' }; };
  stopAfterAStep(f);
  assert.equal(await runLoop({ awake: false, deps: f.deps }), 0);
  assert.deepEqual(asked, []);
});

/**
 * A runner whose lane total the test changes while it runs, against a session
 * that blocks until the test lets it go and then finishes its goal. `starts`
 * is every goal a session was started for, in order.
 */
function liveLanes(names, per) {
  const f = goalFixture(Object.fromEntries(names.map((name) => [name, {}])));
  const starts = [];
  let release = null;
  const held = new Promise((resolve) => { release = resolve; });
  f.answer = async (call) => {
    if (!call.env.MC_GOAL) return okSession()(call);
    starts.push(call.env.MC_GOAL.split('/')[1]);
    await held;
    return endsGoal(f)(call);
  };
  f.deps.sleep = () => new Promise((resolve) => { setImmediate(resolve); });
  f.deps.laneCount = () => ({ lanes: per() });
  return { f, starts, release };
}

test('runLoop: a total raised while the runner runs starts the new lane', async (t) => {
  const turns = async (n = 40) => { for (let i = 0; i < n; i += 1) await new Promise((resolve) => { setImmediate(resolve); }); };
  let per = 1;
  const { f, starts, release } = liveLanes(['a', 'b'], () => per);
  // A failed assert must not leave the loop polling for a STOP nobody writes:
  // the file then never exits, and the merger's round waits on it for hours.
  t.after(() => { f.files['/w/runner/STOP'] = ''; release(); });
  const run = runLoop({ deps: f.deps });
  await turns();
  assert.deepEqual(starts, ['a'], 'one lane, one session');

  per = 2;
  await turns(80);
  assert.deepEqual(starts, ['a', 'b'], `the new lane took the next goal: ${starts.join(', ')}`);
  const log = f.files['/w/runner/log/runner.log'];
  assert.match(log, /lanes: 2 in total now — lane 2 started/u);
  assert.match(log, /lane 2: next — goal:prog\/b /u);

  f.files['/w/runner/STOP'] = '';
  release();
  assert.equal(await run, 0);
});

test('runLoop: a total lowered while the runner runs ends the lane above it after its session', async (t) => {
  const turns = async (n = 40) => { for (let i = 0; i < n; i += 1) await new Promise((resolve) => { setImmediate(resolve); }); };
  let per = 2;
  const { f, starts, release } = liveLanes(['a', 'b', 'c'], () => per);
  // A failed assert must not leave the loop polling for a STOP nobody writes:
  // the file then never exits, and the merger's round waits on it for hours.
  t.after(() => { f.files['/w/runner/STOP'] = ''; release(); });
  const run = runLoop({ deps: f.deps });
  await turns();
  assert.deepEqual(starts, ['a', 'b'], 'two lanes, two sessions');

  per = 1;
  release();
  await turns(120);
  const log = f.files['/w/runner/log/runner.log'];
  assert.match(log, /lane 2: lanes is now 1 — this lane exits/u);
  assert.doesNotMatch(log, /lane 2: next — goal:prog\/c /u, 'the retired lane started nothing more');
  assert.equal(starts.filter((n) => n === 'c').length, 1, `c ran once, on the lane that stayed: ${starts.join(', ')}`);
  assert.equal(starts.filter((n) => n === 'b').length, 1, 'the session the retired lane was in finished, once');

  f.files['/w/runner/STOP'] = '';
  assert.equal(await run, 0);
});

/* ------------------------------------------------------ the total lane cap */

/** Real turns of the event loop, so a polling lane yields to a running one. */
const turns = async (n = 40) => { for (let i = 0; i < n; i += 1) await new Promise((resolve) => { setImmediate(resolve); }); };

/**
 * Four open goals over two repositories — a lane loop for each, every one of
 * them with a goal to run — against a session that blocks until
 * the test lets it go. `peak` is the most that were ever in flight at once,
 * which is the number both of these tests are about.
 */
function laneRace({ total }) {
  const f = goalFixture({ a: {}, b: {}, c: { repos: 'memoro-cli' }, d: { repos: 'memoro-cli' } });
  const state = { starts: [], live: 0, peak: 0 };
  let release = null;
  const held = new Promise((resolve) => { release = resolve; });
  f.answer = async (call) => {
    if (!call.env.MC_GOAL) return okSession()(call);
    state.starts.push(call.env.MC_GOAL.split('/')[1]);
    state.live += 1;
    state.peak = Math.max(state.peak, state.live);
    await held;
    try { return await endsGoal(f)(call); } finally { state.live -= 1; }
  };
  // A sleep that yields a macrotask, not a resolved promise: a lane held back
  // by the cap polls, and a no-op sleep would spin the microtask queue and
  // starve the sessions it is waiting for.
  f.deps.sleep = () => new Promise((resolve) => { setImmediate(resolve); });
  f.deps.laneCount = () => ({ lanes: total });
  return { f, state, release: () => release(), stop: () => { f.files['/w/runner/STOP'] = ''; } };
}

/**
 * An operator who sets no total gets what they always got: two repositories
 * at `lanes 2` is four sessions at once, and nothing counts anything. This is
 * the picture that started the project — six rows in the RUNNER block from a
 * setting that says three.
 */
test('runLoop: lanes 4 — four lanes over two repositories, four sessions at once', async (t) => {
  const r = laneRace({ total: 4 });
  // A failed assert must not leave the loop polling for a STOP nobody writes:
  // the file then never exits, and the merger's round waits on it for hours.
  t.after(() => { r.stop(); r.release(); });
  const run = runLoop({ deps: r.f.deps });
  await turns();
  assert.equal(r.state.peak, 4, `four sessions in flight at once: ${r.state.starts.join(', ')}`);
  r.stop();
  r.release();
  assert.equal(await run, 0);
  const log = r.f.files['/w/runner/log/runner.log'];
  assert.match(log, /lanes: 4 in total, across every repository/u);
  assert.doesNotMatch(log, /waiting for a lane/u, 'nothing was held back');
  assert.equal(r.f.files['/w/runner/waiting.json'], undefined, 'a lane with a free slot never enqueues');
});

/**
 * The other half of a cap: the slot comes back. One held lane, one waiting,
 * and the wait ends when the session does — with no line per attempt, only
 * the one that says the waiting began.
 */
test('a lane held back by the total goes through when the slot frees', async () => {
  const f = goalFixture({ a: {}, b: {} });
  const starts = [];
  let release = null;
  const held = new Promise((resolve) => { release = resolve; });
  f.answer = async (call) => { starts.push(call.env.MC_GOAL.split('/')[1]); await held; return okSession()(call); };
  f.deps.sleep = () => new Promise((resolve) => { setImmediate(resolve); });
  f.deps.laneCount = () => ({ lanes: 1 });
  const runner = createRunner({ deps: f.deps });
  const first = runner.pass({ repo: 'memoro', lane: 0 });
  await turns(4);
  const second = runner.pass({ repo: 'memoro', lane: 1 });
  await turns();
  assert.deepEqual(starts, ['a'], 'the second lane is held back by the total');
  const waiting = f.files['/w/runner/log/runner.log'].match(/waiting for a lane/gu) || [];
  assert.equal(waiting.length, 1, `one line for the wait, not one per attempt: ${waiting.length}`);
  release();
  assert.equal((await first).name, 'goal:prog/a');
  assert.equal((await second).name, 'goal:prog/b');
  assert.deepEqual(starts, ['a', 'b'], 'the freed slot was taken');
});

/**
 * `mc run lanes --total` applies to the next start, not the next restart: the
 * total is read each time a slot is taken. Lowered, it holds the next start;
 * raised, the lane that was waiting goes.
 */
test('a later lane does not overtake a waiter for a machine slot', async t => {
  const f = goalFixture({ a: {}, b: {}, c: { repos: 'memoro-cli' } });
  f.deps.laneCount = () => ({ lanes: 1 });
  const sleeps = [];
  f.deps.sleep = () => new Promise(resolve => sleeps.push(resolve));
  const starts = [];
  let release;
  const held = new Promise(resolve => { release = resolve; });
  f.answer = async call => {
    const name = call.env.MC_GOAL.split('/')[1]; starts.push(name);
    if (name === 'a') await held;
    return okSession()(call);
  };
  t.after(() => { f.files['/w/runner/STOP'] = ''; release(); for (const wake of sleeps.splice(0)) wake(); });
  const runner = createRunner({ deps: f.deps });
  const first = runner.pass({ repo: 'memoro', lane: 0 });
  await turns();
  const second = runner.pass({ repo: 'memoro', lane: 1 });
  await turns();
  const waiting = () => JSON.parse(f.files['/w/runner/waiting.json']).waiters;
  assert.deepEqual(waiting().map(({ name, repo, lane }) => ({ name, repo, lane })), [{ name: 'goal:prog/b', repo: 'memoro', lane: 1 }]);
  assert.ok(waiting()[0].pid); assert.ok(Date.parse(waiting()[0].since));
  release(); await first;
  // The old waiter has not polled yet. A newcomer sees the free slot first.
  const later = runner.pass({ repo: 'memoro-cli', lane: 0 });
  await turns();
  assert.deepEqual(starts, ['a'], 'c must not take the free slot ahead of b');
  assert.deepEqual(waiting().map(item => item.name), ['goal:prog/b', 'goal:prog/c']);
  sleeps.shift()(); await second;
  sleeps.shift()(); await later;
  assert.deepEqual(starts, ['a', 'b', 'c']);
  assert.deepEqual(waiting(), []);
});

test('a total changed while the runner runs applies to the next slot', async () => {
  const f = goalFixture({ a: {}, b: {} });
  let total = 2;
  f.deps.laneCount = () => ({ lanes: total });
  const starts = [];
  let release = null;
  const held = new Promise((resolve) => { release = resolve; });
  f.answer = async (call) => { starts.push(call.env.MC_GOAL.split('/')[1]); await held; return okSession()(call); };
  f.deps.sleep = () => new Promise((resolve) => { setImmediate(resolve); });
  const runner = createRunner({ deps: f.deps });
  const first = runner.pass({ repo: 'memoro', lane: 0 });
  await turns(4);
  total = 1;
  const second = runner.pass({ repo: 'memoro', lane: 1 });
  await turns();
  assert.deepEqual(starts, ['a'], 'a lowered total holds the next start');
  assert.match(f.files['/w/runner/log/runner.log'], /goal:prog\/b: 1 of 1 sessions in flight on this machine — waiting for a lane/u);
  total = 2;
  await turns();
  assert.deepEqual(starts, ['a', 'b'], 'a raised total lets the waiting lane go');
  release();
  assert.equal((await first).ran, 1);
  assert.equal((await second).ran, 1);
});

/**
 * Another runner's sessions count against the total while its lane files exist:
 * after a handover the predecessor finishes what it holds, and the successor
 * must not start beside it past the cap. Its file going is the slot coming back.
 */
test('a live predecessor\'s sessions count against the total', async () => {
  const f = goalFixture({ a: {} }, { livePids: [7000] });
  f.files['/w/runner/current-memoro-cli.json'] = JSON.stringify({ name: 'z', step: null, pid: 7000, lane: 0 });
  f.deps.laneCount = () => ({ lanes: 1 });
  f.deps.sleep = () => new Promise((resolve) => { setImmediate(resolve); });
  const runner = createRunner({ deps: f.deps });
  const a = runner.pass({ repo: 'memoro', lane: 0 });
  await turns();
  assert.equal(f.calls.sessions.length, 0, 'the predecessor holds the one slot');
  assert.match(f.files['/w/runner/log/runner.log'], /goal:prog\/a: 1 of 1 sessions in flight on this machine — waiting for a lane/u);
  delete f.files['/w/runner/current-memoro-cli.json'];
  await turns();
  assert.equal(f.calls.sessions.length, 1, 'the slot came back when the predecessor\'s file went');
  assert.equal((await a).ran, 1);
});

/** A dead runner's lane file is swept by `stepsHeld` and counts for nothing. */
test('a dead runner\'s lane file does not count against the total', async () => {
  const f = goalFixture({ a: {} }, { livePids: [] });
  f.files['/w/runner/current-memoro-cli.json'] = JSON.stringify({ name: 'z', step: null, pid: 7001, lane: 0 });
  f.deps.laneCount = () => ({ lanes: 1 });
  f.deps.sleep = () => new Promise((resolve) => { setImmediate(resolve); });
  const runner = createRunner({ deps: f.deps });
  assert.equal((await runner.pass({ repo: 'memoro', lane: 0 })).ran, 1);
  assert.equal(f.calls.sessions.length, 1, 'the session started without waiting');
  assert.doesNotMatch(f.files['/w/runner/log/runner.log'], /waiting for a lane/u);
});

/**
 * A lane waiting for a slot when an UPDATE arrives starts nothing. The drain
 * is meant to end within one session's length: a lane that waited out
 * somebody else's session and then launched its own would make it two.
 */
test('a lane waiting for a slot gives the wait up on UPDATE, and starts no session', async () => {
  const f = goalFixture({ a: {}, b: {} });
  const starts = [];
  let release = null;
  const held = new Promise((resolve) => { release = resolve; });
  f.answer = async (call) => { starts.push(call.env.MC_GOAL.split('/')[1]); await held; return okSession()(call); };
  f.deps.sleep = () => new Promise((resolve) => { setImmediate(resolve); });
  f.deps.laneCount = () => ({ lanes: 1 });
  const runner = createRunner({ deps: f.deps });
  const first = runner.pass({ repo: 'memoro', lane: 0 });
  await turns(4);
  const second = runner.pass({ repo: 'memoro', lane: 1 });
  await turns();
  f.files['/w/runner/UPDATE'] = '';
  assert.equal((await second).ran, 0);
  release();
  await first;
  assert.deepEqual(starts, ['a'], 'the waiting lane never launched');
  assert.deepEqual(JSON.parse(f.files['/w/runner/waiting.json']).waiters, []);
  assert.match(f.files['/w/runner/log/runner.log'], /goal:prog\/b: UPDATE while waiting for a lane — starting no session, skip/u);
});

/**
 * UPDATE hands over at once (ruling 28), and the old runner takes no new
 * session from that moment: a goal that opens while it finishes is the
 * successor's. Before, the update drained — the handover waited for the quiet
 * moment, and every idle lane sat for the busy lane's whole session.
 */
test('runLoop: an UPDATE hands over at once — the old runner starts no session, finishes the one in flight, then exits', async () => {
  const f = goalFixture({ a: {} });
  const events = [];
  let ticks = 0;
  f.answer = async (call) => {
    const name = call.env.MC_GOAL.split('/')[1];
    events.push(`${name}: start`);
    if (name === 'a') {
      // Mid-session: an update is asked for, and a memoro-cli goal opens.
      // The idle lanes see both, and start nothing.
      f.files['/w/runner/UPDATE'] = '';
      f.files[`${GOALS}/x/GOAL.json`] = goalJson({ status: 'open', repos: ['memoro-cli'], title: 'x', goal: [] });
      f.files[`${GOALS}/x/LOG.md`] = '';
      f.dirs.add(`${GOALS}/x/memoro-cli`);
      // Let the other loops poll a few times.
      while (ticks < 6) await new Promise((resolve) => { setImmediate(resolve); });
    }
    events.push(`${name}: end`);
    return endsGoal(f)(call);
  };
  // A sleep that yields a macrotask, not a resolved promise: the polling
  // loops would otherwise spin in microtasks and starve the `setImmediate` the
  // session is waiting on.
  f.deps.sleep = () => new Promise((resolve) => { setImmediate(() => { ticks += 1; resolve(); }); });
  const handovers = [];
  f.deps.handOver = async ({ say }) => { handovers.push(events.slice()); say('update: handed over to pid 9001 — finishing 1 session(s) in flight, taking nothing new'); return { ok: true, pid: 9001 }; };
  assert.equal(await runLoop({ deps: f.deps }), 0);
  assert.equal(events.indexOf('x: start'), -1, `the old runner started a session after the update: ${events.join(', ')}`);
  assert.equal(handovers.length, 1, 'the update handed over once');
  assert.deepEqual(handovers[0], ['a: start'], 'the handover waited for the session in flight');
  assert.deepEqual(events, ['a: start', 'a: end']);
  assert.match(f.files['/w/runner/log/runner.log'], /handed over to pid 9001[\s\S]*goal:prog\/a: build done[\s\S]*every session pid 4242 held has ended — exiting/u);
});

/**
 * 2026-10-05: a drain said one line when it began and nothing again until the
 * handover 42 minutes later. After the handover the old runner says every ten
 * minutes what it still holds — one line for the runner, however many loops
 * are polling.
 */
test('runLoop: an old runner finishing a long session says what it holds every ten minutes, once for the runner', async () => {
  const f = goalFixture({ a: {} }, { livePids: [4242] });
  const t0 = new Date('2026-08-26T12:00:00Z').getTime();
  let clock = t0;
  f.deps.now = () => new Date(clock);
  // Each poll is half a minute on the clock, and a macrotask so the session
  // below gets its turn.
  f.deps.sleep = (ms) => new Promise((resolve) => { setImmediate(() => { clock += Math.min(ms, UPDATE_POLL_MS); resolve(); }); });
  f.answer = async (call) => {
    f.files['/w/runner/UPDATE'] = `${new Date(clock).toISOString()}\n`;
    const asked = clock;
    while (clock - asked < 15 * 60 * 1000) await new Promise((resolve) => { setImmediate(resolve); });
    return endsGoal(f)(call);
  };
  f.deps.handOver = async ({ say }) => { say('update: handed over to pid 9001 — this runner is done'); return { ok: true, pid: 9001 }; };
  assert.equal(await runLoop({ deps: f.deps }), 0);
  const log = f.files['/w/runner/log/runner.log'];
  const ticks = log.split('\n').filter((line) => line.includes(' still waiting on'));
  assert.equal(ticks.length, 1, `one line per ten minutes for the runner, not per loop:\n${ticks.join('\n')}`);
  assert.match(ticks[0], /update: pid 4242 still waiting on goal prog\/a \(memoro#1, [^)]+\)$/u);
  assert.match(log, /handed over to pid 9001[\s\S]*update: pid 4242 still waiting on goal prog\/a/u);
});

/**
 * 2026-10-07: a STOP written three seconds after a handover was read by every
 * lane but the one already in a step, and removed before that lane looked.
 * Eleven lanes and the chore loop had exited without a word; the runner ran
 * on for twenty minutes on one lane. STOP ends the runner: once a lane has
 * read it the run is stopping, whether or not the file is still there — and
 * every lane that leaves says so.
 */
test('runLoop: a STOP read by one lane and then removed still ends the runner, and each lane says it left', async () => {
  const f = goalFixture({ a: {} });
  // Three lanes: the first takes the only goal; the other two find nothing,
  // sleep, and read STOP when they look again.
  f.deps.laneCount = () => ({ lanes: 3 });
  f.answer = async (call) => {
    // While lane 1's session runs: STOP appears, lanes 2 and 3 and the chore
    // loop read it, and it is removed again before this session ends.
    f.files['/w/runner/STOP'] = '';
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    delete f.files['/w/runner/STOP'];
    return okSession()(call);
  };
  assert.equal(await runLoop({ deps: f.deps }), 0);
  const log = f.files['/w/runner/log/runner.log'];
  assert.match(log, /lane 2: STOP — this lane exits; the runner still finishes goal:prog\/a/u, 'the lane that read STOP says so');
  assert.match(log, /lane 3: STOP — this lane exits/u);
  assert.match(log, /chores: STOP — exiting/u);
  assert.match(log, /runner exit on STOP/u, 'the runner exits although STOP is gone');
  assert.equal(f.calls.sessions.length, 1);
  assert.equal(f.files['/w/runner/runner.json'], undefined);
});

/**
 * The attach before a goal's session: in the goal's worktree, before the
 * session is launched. A failed attach is said, and the session runs anyway.
 */
test('a goal session attaches its worktree\'s dependencies once, before the session', async () => {
  const f = goalFixture({ c: {} });
  await createRunner({ deps: f.deps }).pass();
  assert.equal(f.calls.attached.length, 1);
  assert.equal(f.calls.attached[0].worktree, `${GOALS}/c/memoro`);
  assert.equal(f.calls.attached[0].sessionsBefore, 0, 'the attach came before the session was launched');
  assert.equal(f.calls.sessions.length, 1);
});

test('a failed attach is said, and the session still runs', async () => {
  const f = goalFixture({ c: {} }, { attach: { ok: false, state: 'failed', why: 'npm error boom' } });
  await createRunner({ deps: f.deps }).pass();
  assert.equal(f.calls.sessions.length, 1, 'the session is launched all the same');
  assert.match(f.files['/w/runner/log/runner.log'], /goal:prog\/c: dependencies could not be attached — npm error boom/u);
});

test('one live runner rereads provider priority for fresh fast and large launches', async () => {
  const f = goalFixture({ flexible: {} });
  let priority = 'codex';
  f.deps.catalog = () => ({ ...structuredClone(DEFAULT_CATALOG), providerPriority: priority,
    fast: [DEFAULT_CATALOG.fast[0], DEFAULT_CATALOG.fast[1]],
    large: [DEFAULT_CATALOG.large[0], { tool: 'codex', model: 'gpt-6-luna', effort: 'high' }],
  });
  f.deps.capacity.write(capacityWith({ claude: 0.1, codex: 0.9 }));
  f.files[`${GOALS}/flexible/GOAL.json`] = withGoal(f.files[`${GOALS}/flexible/GOAL.json`], { class: 'fast' });
  const runner = createRunner({ deps: f.deps });
  await runner.pass({ repo: 'memoro' });
  assert.deepEqual([f.calls.sessions.at(-1).env.MC_TOOL, f.calls.sessions.at(-1).env.MC_MODEL], ['codex', 'gpt-6-luna']);
  priority = 'claude';
  f.files[`${GOALS}/flexible/GOAL.json`] = withGoal(f.files[`${GOALS}/flexible/GOAL.json`], { class: 'large' });
  await runner.pass({ repo: 'memoro' });
  assert.deepEqual([f.calls.sessions.at(-1).env.MC_TOOL, f.calls.sessions.at(-1).env.MC_MODEL], ['claude', 'opus']);
});

/** The `rate_limit_event` as it stood in `~/mc/runner/log/*.jsonl` on 2026-10-11. */
const WINDOWS_EVENT = JSON.stringify({
  type: 'rate_limit_event',
  rate_limit_info: {
    status: 'allowed_warning', resetsAt: 1792155600, rateLimitType: 'seven_day', utilization: 0.59,
    unifiedWindows: { five_hour: { utilization: 0.08, resetsAt: 1791721200 }, seven_day: { utilization: 0.59, resetsAt: 1792155600 } },
  },
});

test('a claude session whose stream carries the plan windows records them in the billing state', async () => {
  const f = goalFixture({ r: {} });
  const patches = [];
  f.deps.billing = { readMode: () => 'plan', readState: () => ({}), patchState: (patch) => { patches.push(patch); } };
  f.answer = (call) => {
    const answer = okSession({ type: 'result' })(call);
    return { ...answer, stdout: `${WINDOWS_EVENT}\n${answer.stdout}` };
  };
  await createRunner({ deps: f.deps }).pass();
  assert.equal(patches.length, 1);
  assert.equal(patches[0].plan.seven_day.utilization, 0.59);
  assert.equal(patches[0].plan.seven_day.resets_at, new Date(1792155600 * 1000).toISOString());
  assert.equal(patches[0].plan.five_hour.utilization, 0.08);
  assert.equal(patches[0].plan.seen, '2026-08-29T10:00:00Z');
  const claude = f.deps.capacity.read().providers.claude;
  assert.equal(claude.windows.seven_day?.fraction_used, 0.59, 'the stream windows reach the capacity snapshot too');
  assert.equal(claude.windows.five_hour?.fraction_used, 0.08);
  assert.doesNotMatch(f.files['/w/runner/log/runner.log'] || '', /capacity not recorded/u);
});

test('a codex session records no plan windows, and neither does a claude stream without them', async () => {
  for (const codex of [true, false]) {
    const f = goalFixture({ r: {} });
    // A catalog whose large class is codex alone routes the goal to codex.
    if (codex) f.deps.catalog = () => ({ ...DEFAULT_CATALOG, large: [{ tool: 'codex', model: 'gpt-6.1-sol', effort: 'high' }] });
    if (codex) f.deps.capacity.write(capacityWith({ claude: 0.1, codex: 0.1 }));
    const patches = [];
    f.deps.billing = { readMode: () => 'plan', readState: () => ({}), patchState: (patch) => { patches.push(patch); } };
    f.answer = (call) => {
      const answer = okSession({ type: 'result' })(call);
      return codex ? { ...answer, stdout: `${WINDOWS_EVENT}\n${answer.stdout}` } : answer;
    };
    await createRunner({ deps: f.deps }).pass();
    assert.equal(f.calls.sessions.length, 1);
    assert.deepEqual(patches, [], codex ? 'codex' : 'no event');
  }
});

test('realDeps carries the billing files the runner reads and writes', () => {
  const deps = realDeps({});
  assert.equal(typeof deps.billing.readState, 'function');
  assert.equal(typeof deps.billing.patchState, 'function');
});

/** A runner on `mode`, its key reader stubbed and counted, its session capturing its options. */
function onBilling(mode, { key = { ok: true, key: 'sk-ant-test-key' }, stdout = '' } = {}) {
  const f = goalFixture({ r: {} });
  f.deps.billing = { readMode: () => mode, readState: () => ({}), patchState: () => {} };
  const reads = [];
  f.deps.creditKey = async () => { reads.push(1); return key; };
  const calls = [];
  f.answer = (call) => {
    calls.push({ call, current: JSON.parse(f.files['/w/runner/current-memoro.json']) });
    const answer = okSession({ type: 'result' })(call);
    return { ...answer, stdout: `${stdout}${answer.stdout}` };
  };
  return { f, reads, calls };
}

test('a full Claude plan launches through the gateway without exposing its key', async () => {
  const { f, reads, calls } = onBilling('plan');
  f.deps.capacity.read = () => capacityWith({ claude: 1 });
  await createRunner({ deps: f.deps }).pass();
  assert.equal(reads.length, 0, 'the runner never decrypts the key');
  const [{ call, current }] = calls;
  assert.equal(call.bin, process.execPath);
  assert.ok(call.args.some((arg) => arg.endsWith('/billing-gateway-session.js')));
  assert.deepEqual(call.args.slice(1, 4), ['claude', 'opus', '/bin/claude']);
  assert.equal(call.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(current.billing, 'credits');
  assert.doesNotMatch(JSON.stringify(f.files), /sk-ant-test-key/u);
});

test('an available plan launches directly and removes ambient provider keys', async () => {
  const { f, reads, calls } = onBilling('credits');
  f.deps.env = { ...f.deps.env, ANTHROPIC_API_KEY: 'from-the-runner' };
  await createRunner({ deps: f.deps }).pass();
  assert.equal(reads.length, 0);
  const [{ call, current }] = calls;
  assert.equal(call.bin, '/bin/claude');
  assert.equal('ANTHROPIC_API_KEY' in call.env, false);
  assert.deepEqual(call.unsetEnv, ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_API_KEY', 'OPENAI_API_KEY', 'MC_CODEX_API_KEY']);
  assert.equal(current.billing, 'plan');
});

test('a full Codex plan uses the same gateway route', async () => {
  const { f, calls } = onBilling('plan');
  f.deps.catalog = () => ({ ...DEFAULT_CATALOG, large: [{ tool: 'codex', model: 'gpt-6.1-sol', effort: 'high' }] });
  f.deps.capacity.read = () => capacityWith({ codex: 1 });
  await createRunner({ deps: f.deps }).pass();
  assert.equal(calls[0].call.bin, process.execPath);
  assert.ok(calls[0].call.args.includes('codex'));
  assert.equal(calls[0].current.billing, 'credits');
  assert.equal(calls[0].call.env.OPENAI_API_KEY, undefined);
});

/**
 * A runner on `mode` whose billing state is held in memory and patched the
 * way `patchBillingState` does, its first session ending on `first`, every
 * later one ending well.
 */
function onRefusal(mode, first, { state = {} } = {}) {
  const f = goalFixture({ r: {} });
  const billing = { plan: {}, credits: {}, ...state };
  f.deps.billing = {
    readMode: () => mode,
    readState: () => billing,
    patchState: (patch) => { billing.plan = { ...billing.plan, ...(patch.plan || {}) }; billing.credits = { ...billing.credits, ...(patch.credits || {}) }; },
  };
  f.deps.creditKey = async () => ({ ok: true, key: 'sk-ant-test-key' });
  const slept = [];
  f.deps.sleep = async (ms) => { slept.push(ms); };
  const calls = [];
  f.answer = (call) => {
    calls.push({ call });
    return calls.length === 1 ? first(call) : okSession({ type: 'result' })(call);
  };
  return { f, billing, slept, calls };
}

/** A session the API ended: an error result with the API's own words. */
const apiEndedSession = (result, extra = {}) => () => ({ status: 0, stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: true, num_turns: 44, session_id: 'sid-1', terminal_reason: 'api_error', result, usage: { input_tokens: 5, output_tokens: 6, cache_read_input_tokens: 7, cache_creation_input_tokens: 8 }, ...extra }), stderr: '', timedOut: false });

/** An API-ended session as a stream: its init line, then the result. */
const streamed = (ended) => (call) => {
  const answer = ended(call);
  return { ...answer, stdout: `${JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid-1' })}\n${answer.stdout}\n` };
};
const REFUSED_429 = streamed(apiEndedSession("You've hit your 5-hour limit · resets 3pm (UTC)", { api_error_status: 429 }));
const CREDIT_LOW = streamed(apiEndedSession('Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.', { api_error_status: 400 }));

test('a plan refusal is recorded and hands the next launch to the API reserve', async () => {
  const { f, billing, slept, calls } = onRefusal('plan', REFUSED_429);
  await createRunner({ deps: f.deps }).pass();
  assert.equal(billing.plan.refused_until, '2026-08-29T15:00:00.000Z');
  assert.equal(f.deps.capacity.read().providers.claude.refusal_until, '2026-08-29T15:00:00.000Z', 'the refusal reaches the capacity snapshot the chooser reads');
  assert.doesNotMatch(f.files['/w/runner/log/runner.log'] || '', /capacity not recorded/u);
  assert.equal(calls.length, 1, 'the refused session is not relaunched: the goal is picked again');
  assert.deepEqual(slept, [], 'no lane sleeps on it');
  const r = await createRunner({ deps: f.deps }).pass();
  assert.equal(r.ran, 1);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].call.bin, process.execPath, 'the next launch goes through the gateway, on the API reserve');
});

test('an API credit refusal is recorded without exposing the key', async () => {
  const { f, billing, calls } = onRefusal('credits', CREDIT_LOW);
  f.deps.capacity.read = () => capacityWith({ claude: 1 });
  await createRunner({ deps: f.deps }).pass();
  assert.equal(calls[0].call.bin, process.execPath);
  assert.equal(calls[0].call.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(billing.credits.why, 'credit balance too low');
  assert.doesNotMatch(JSON.stringify(f.files), /sk-ant-test-key/u);
});

test('a lane with no runnable step starts the oldest open goal', async () => {
  const f = goalFixture({
    newer: { log: goalLog('2026-08-20T10:00Z', '2026-08-28T10:00Z') },
    older: { log: goalLog('2026-08-27T10:00Z') },
  });
  f.answer = logsItself(f, 'older');
  const runner = createRunner({ deps: f.deps });

  const r = await runner.pass({ repo: 'memoro', lane: 1, tag: 'memoro#2' });

  assert.equal(r.ran, 1);
  assert.equal(r.name, 'goal:prog/older');
  assert.equal(r.step, null);
  const [call] = f.calls.sessions;
  assert.equal(f.calls.sessions.length, 1);
  assert.equal(call.cwd, `${GOALS}/older/memoro`);
  assert.equal(call.env.MC_ROLE, 'build-session:goal');
  assert.equal(call.env.MC_HEADLESS, '1', 'a goal session is headless: the hook refuses Martin\'s acts');
  assert.equal(call.env.MC_PROGRAMME, 'prog');
  assert.equal(call.env.MC_GOAL, 'prog/older');
  assert.equal(call.env.MC_REPO, 'memoro');
  assert.equal(call.env.MC_WORKAREA, `${GOALS}/older/memoro`);
  assert.equal(call.env.MC_TOOL, 'claude');
  assert.ok(call.env.MC_MODEL);
  assert.ok(call.env.MC_SCRATCH.startsWith('/w/runner/scratch/goal-prog-older-'));
  assert.equal('MC_STEP' in call.env, false);
  assert.equal('MC_PROJECT' in call.env, false);
  assert.match(call.prompt, /`\/w\/programs\/prog\/goals\/older`/u);
  assert.match(call.prompt, /`goal\/older`/u);
  // The brief is the goal as `mc goal show` renders it (`renderGoalText`).
  assert.match(call.prompt, /The goal, as `mc goal show` renders it:\n\n# older\n\nGOAL\n  none yet\n/u);
  assert.match(call.prompt, /\nCRITERIA 0\/1\n  1 ✗ it works\n      check: a test$/u);
  assert.equal(call.prompt.split('\n\n')[0].includes('\n'), false, 'where the goal is, in one paragraph, before the brief');
  assert.match(call.args.join('\n'), /ROLE build-session:goal/u);

  // Its current file stood for as long as the session did, and is gone.
  const during = JSON.parse(f.duringSession[0]['/w/runner/current-memoro-1.json']);
  assert.equal(during.name, 'goal:prog/older');
  assert.equal(during.step, null);
  assert.equal(during.kind, 'build');
  assert.equal(during.variant, 'goal');
  assert.equal('/w/runner/current-memoro-1.json' in f.files, false);

  const [row] = runRows(f.files);
  assert.equal(row.name, 'goal:prog/older');
  assert.equal(row.kind, 'build-goal');
  assert.equal(row.class, 'large');
  assert.equal(row.note, 'success');
  assert.deepEqual(Object.keys(f.files).filter((path) => path.startsWith('/w/runner/projects/')), [], 'nothing in the register');
});

test('the runner starts no project step: a lane beside a ready step takes the goal, and with none starts nothing', async () => {
  const f = goalFixture({ waiting: { log: goalLog('2026-08-27T10:00Z') } }, { plans: { memoro: { alpha: ready } } });
  f.answer = logsItself(f, 'waiting');
  const runner = createRunner({ deps: f.deps });
  const r = await runner.pass({ repo: 'memoro' });
  assert.equal(r.name, 'goal:prog/waiting');
  assert.equal(f.calls.sessions.length, 1);
  assert.equal(f.calls.sessions[0].cwd, `${GOALS}/waiting/memoro`);
  assert.equal('MC_STEP' in f.calls.sessions[0].env, false);

  const alone = fixture({ plans: { memoro: { alpha: ready } }, session: okSession() });
  const none = await createRunner({ deps: alone.deps }).pass({ repo: 'memoro' });
  assert.equal(none.ran, 0);
  assert.equal(alone.calls.sessions.length, 0, 'a ready step is never started');
});

test('a goal of another repository is not this lane\'s', async () => {
  const f = goalFixture({ theirs: { repos: 'memoro-cli, memoro' } });
  const r = await createRunner({ deps: f.deps }).pass({ repo: 'memoro' });
  assert.equal(r.ran, 0);
  assert.equal(f.calls.sessions.length, 0);
});

test('a goal with a current file is not started twice', async () => {
  const f = goalFixture({ busy: {}, free: { log: goalLog('2026-08-28T10:00Z') } });
  f.files['/w/runner/current-memoro-1.json'] = JSON.stringify({ name: 'goal:prog/busy', step: null, pid: 4242 });
  f.answer = logsItself(f, 'free');
  const runner = createRunner({ deps: f.deps });

  assert.equal((await runner.pass({ repo: 'memoro' })).name, 'goal:prog/free');

  delete f.files[`${GOALS}/free/GOAL.json`];
  const r = await runner.pass({ repo: 'memoro' });
  assert.equal(r.ran, 0, 'one goal left, and it is running: nothing to start');
  assert.deepEqual(f.calls.sessions.map((call) => call.env.MC_GOAL ?? null), ['prog/free'], 'busy never gets another goal session');
});

test('two lanes picking in one moment do not start one goal twice', async () => {
  const f = goalFixture({ only: {} });
  let open = null;
  f.answer = logsItself(f, 'only', () => new Promise((resolve) => { open = () => resolve(okSession()()); }));
  const runner = createRunner({ deps: f.deps });
  const first = runner.pass({ repo: 'memoro', lane: 0 });
  const second = await runner.pass({ repo: 'memoro', lane: 1 });
  assert.equal(second.ran, 0);
  for (let wait = 0; !open && wait < 50; wait += 1) await new Promise((resolve) => { setImmediate(resolve); });
  open();
  assert.equal((await first).ran, 1);
  assert.equal(f.calls.sessions.length, 1);
});

test('a build session that writes no log entry gets a runner entry, and three in a row move the goal to finish for one finish session', async () => {
  const f = goalFixture({ mute: { log: goalLog('2026-08-20T10:00Z') } });
  f.answer = () => ({ status: 1, stdout: '', stderr: '', timedOut: false });
  const runner = createRunner({ deps: f.deps });
  const entries = () => parseLog(f.files[`${GOALS}/mute/LOG.md`]);
  const where = () => ['stage', 'status'].map((key) => goalField(f.files[`${GOALS}/mute/GOAL.json`], key)).join(' · ');

  await runner.pass({ repo: 'memoro' });
  assert.equal(entries().length, 2);
  assert.deepEqual([entries()[1].tool, entries()[1].stage, entries()[1].status], ['runner', 'build', 'ready']);
  assert.match(entries()[1].comment, /^session ended without a log entry \(exit 1, 0 s\)$/u);
  assert.equal(where(), 'build · ready');
  assert.match(runRows(f.files)[0].note, /,no-log$/u);

  await runner.pass({ repo: 'memoro' });
  assert.equal(where(), 'build · ready', 'two are not three');
  await runner.pass({ repo: 'memoro' });
  assert.equal(where(), 'finish · ready');
  assert.match(entries().at(-1).comment, /^three sessions ended without a word — see the logs under runner\/log; a finish session takes it$/u);

  // In finish it wakes one finish session; that one ends with the goal still in
  // finish, so the runner sets it blocked. A mend session takes the blocked
  // goal; it leaves it blocked too, so the goal waits on Martin and nothing starts again.
  assert.equal((await runner.pass({ repo: 'memoro' })).ran, 1);
  assert.equal(f.calls.sessions.at(-1).env.MC_ROLE, 'finish-session');
  assert.equal(where(), 'finish · blocked');
  assert.equal((await runner.pass({ repo: 'memoro' })).ran, 1);
  assert.equal(f.calls.sessions.at(-1).env.MC_ROLE, 'mend-session');
  assert.equal(where(), 'finish · Martin');
  assert.equal((await runner.pass({ repo: 'memoro' })).ran, 0);
  assert.equal(runRows(f.files).length, 5);
});

/** The result of an API the runner cannot reach (2026-11-06): ten retries, then this, with no tokens. */
const UNREACHABLE = streamed(apiEndedSession("API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)", { api_error: 'connection_failed', api_error_status: null, num_turns: 1, usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }));

test('an unreachable API holds every launch with a growing wait, writes no goal entry or refusal, and an ordinary ending clears the hold', async () => {
  const f = goalFixture({ mute: { log: goalLog('2026-08-20T10:00Z') } });
  let clock = Date.parse('2026-11-07T12:00:00Z');
  f.deps.now = () => new Date(clock);
  const patches = [];
  f.deps.billing = { readMode: () => 'plan', readState: () => ({ plan: {}, credits: {} }), patchState: (patch) => { patches.push(patch); } };
  f.answer = UNREACHABLE;
  const runner = createRunner({ deps: f.deps });
  const runnerLog = () => f.files['/w/runner/log/runner.log'] || '';
  const holdLines = () => runnerLog().split('\n').filter((line) => /API server cannot be reached|API answers again/u.test(line));
  const entries = () => parseLog(f.files[`${GOALS}/mute/LOG.md`]);
  const where = () => ['stage', 'status'].map((key) => goalField(f.files[`${GOALS}/mute/GOAL.json`], key)).join(' · ');

  // The first offline ending: the goal is left as it was, and nothing is refused.
  assert.equal((await runner.pass({ repo: 'memoro' })).ran, 1);
  assert.equal(f.calls.sessions.length, 1);
  assert.equal(entries().length, 1, 'no runner entry: an offline ending answers nothing about the goal');
  assert.equal(where(), 'build · ready');
  assert.deepEqual(patches, [], 'no provider or API-reserve refusal is recorded for it');
  assert.equal(f.deps.capacity.read().providers.claude.refusal_until ?? null, null);
  assert.equal(holdLines().length, 1);
  assert.match(holdLines()[0], /until 2026-11-07T12:01:00Z \(n=1, 60 s\)$/u);
  assert.equal(runRows(f.files).length, 1);
  assert.match(runRows(f.files)[0].note, /^offline,no-log$/u);

  // A tick inside that minute launches nothing and says nothing about the goal.
  const before = runnerLog();
  clock += 30_000;
  assert.equal((await runner.pass({ repo: 'memoro' })).ran, 0);
  assert.equal(f.calls.sessions.length, 1, 'a tick inside the hold launches nothing');
  assert.equal(runnerLog(), before, 'and writes no line for the goal');

  // Once the hold has passed, one session launches; a second offline ending doubles the wait.
  clock = Date.parse('2026-11-07T12:01:00Z');
  assert.equal((await runner.pass({ repo: 'memoro' })).ran, 1);
  assert.equal(f.calls.sessions.length, 2);
  assert.match(holdLines().at(-1), /until 2026-11-07T12:03:00Z \(n=2, 120 s\)$/u);

  // A third in a row: the goal is still build · ready, and no entry says why.
  clock = Date.parse('2026-11-07T12:03:00Z');
  assert.equal((await runner.pass({ repo: 'memoro' })).ran, 1);
  assert.match(holdLines().at(-1), /until 2026-11-07T12:07:00Z \(n=3, 240 s\)$/u);
  assert.equal(where(), 'build · ready', 'three offline endings in a row do not move the goal to finish');
  assert.equal(entries().length, 1);
  assert.equal(runRows(f.files).length, 3);
  assert.ok(runRows(f.files).every((row) => /^offline/u.test(row.note)));

  // An ordinary ending clears the hold, with one line, and the next tick launches without waiting.
  clock = Date.parse('2026-11-07T12:07:00Z');
  f.answer = logsItself(f, 'mute');
  assert.equal((await runner.pass({ repo: 'memoro' })).ran, 1);
  assert.equal(entries().length, 2, 'the ordinary session wrote its own entry');
  assert.equal(holdLines().filter((line) => /API answers again/u.test(line)).length, 1, 'one line when it clears');
  assert.equal((await runner.pass({ repo: 'memoro' })).ran, 1, 'the next tick launches at once');
  assert.equal(f.calls.sessions.length, 5);
  assert.equal(holdLines().length, 4, 'three set lines and one clear line, nothing else');
});

/* ------------------------------------------------------- archive a finished goal */

/** A goal's one entry, made by a session, with the status it set. */
const finishedLog = (at, stage) => `## ${at} · claude opus · ${stage} · ready\n\nDone: arbete\n`;
const ARCHIVE_NOW = '2026-09-01T10:00:00Z';

test('the chores archive a goal done or dropped for 24 hours, and leave one finished 23 hours to the hold', async () => {
  const f = goalFixture({
    late: { stage: 'done', log: finishedLog('2026-08-31T10:00Z', 'done') },
    early: { stage: 'done', log: finishedLog('2026-08-31T11:00Z', 'done') },
    'dropped-one': { stage: 'dropped', log: finishedLog('2026-08-30T09:00Z', 'dropped') },
  }, { now: ARCHIVE_NOW });
  await createRunner({ deps: f.deps }).chores();
  assert.equal(f.files[`${GOALS}/late/GOAL.json`], undefined, 'the goal left the goals');
  assert.equal(goalField(f.files['/w/programs/prog/goals/.archive/late/GOAL.json'], 'stage'), 'done', 'in goals/.archive/');
  assert.equal(f.files[`${GOALS}/late/memoro`], undefined, 'its worktree is gone with it');
  assert.ok(f.calls.git.some((call) => call[0] === '/home/memoro' && call.slice(1).join(' ') === `worktree remove ${GOALS}/late/memoro`), 'removed through git');
  assert.ok(f.calls.git.some((call) => call[0] === '/home/memoro' && call.slice(1).join(' ') === 'branch -D goal/late'), 'its branch is deleted through git');
  assert.match(f.files['/w/programs/prog/goals/goal_log.md'], /^\| 2026-09-01 \| late \| done \|/mu, 'one row in goal_log.md');
  assert.match(f.files['/w/programs/prog/goals/goal_log.md'], /^\| 2026-09-01 \| dropped-one \| dropped \|/mu, 'a dropped goal the same');
  assert.equal(goalField(f.files[`${GOALS}/early/GOAL.json`], 'stage'), 'done', 'done 23 hours: it stays');
  assert.equal(f.files[`${GOALS}/early/LOG.md`].match(/runner/gu), null, 'and nothing is written into its log');
});

test('when the runner archives the last goal of phase 1, phase 2 is phase 1 and phase 3 phase 2', async () => {
  const f = goalFixture({
    late: { stage: 'done', log: finishedLog('2026-08-31T10:00Z', 'done') },
    next: { phase: 2 },
    after: { phase: 3 },
  }, { now: ARCHIVE_NOW });
  await createRunner({ deps: f.deps }).chores();
  assert.equal(f.files[`${GOALS}/late/GOAL.json`], undefined, 'archived');
  assert.equal(goalField(f.files[`${GOALS}/next/GOAL.json`], 'phase'), 1);
  assert.equal(goalField(f.files[`${GOALS}/after/GOAL.json`], 'phase'), 2);
  assert.ok(f.log.some((line) => /goal:prog\/next: phase 2 → 1/u.test(line)));
});

test('a goal the archive refuses stays, and the refusal is written into its log once, not at every pass', async () => {
  const f = goalFixture({ held: { stage: 'done', log: finishedLog('2026-08-31T10:00Z', 'done') } }, { now: ARCHIVE_NOW, dirty: ['held'] });
  const runner = createRunner({ deps: f.deps });
  await runner.chores();
  await runner.chores();
  assert.equal(goalField(f.files[`${GOALS}/held/GOAL.json`], 'stage'), 'done', 'it stays where it is');
  assert.equal(f.files['/w/programs/prog/goals/goal_log.md'], undefined, 'nothing is archived');
  const runnerLines = parseLog(f.files[`${GOALS}/held/LOG.md`]).filter((entry) => entry.tool === 'runner');
  assert.equal(runnerLines.length, 1, 'said once, though two passes ran');
  assert.deepEqual([runnerLines[0].stage, runnerLines[0].done], ['done', null]);
  assert.match(runnerLines[0].comment, /^not archived — memoro's worktree has uncommitted changes \(/u);
});

/* ------------------------------------------------------- finish on finish, mend on blocked and on a red in merge */

/** A finish or mend session that writes its entry and leaves the goal in `stage` · `status`, as `mc goal stage` does. */
const plans = (f, name, stage, status = 'ready', inner = okSession()) => (call) => {
  const dir = `${GOALS}/${name}`;
  f.files[`${dir}/LOG.md`] = `${f.files[`${dir}/LOG.md`]}\n## 2026-08-29T11:00Z · claude opus · ${stage} · ${status}\n\nComment: finished it\n`;
  f.files[`${dir}/GOAL.json`] = withGoal(f.files[`${dir}/GOAL.json`], { stage, status });
  return inner(call);
};
const redMerge = `## 2026-08-28T10:00Z · runner · merge · ready\n\nDone: ${redMergeText(31)}\nComment: red: 2 tests red — one mend session takes it and queues it again\n`;
const where = (f, name) => ['stage', 'status'].map((key) => goalField(f.files[`${GOALS}/${name}/GOAL.json`], key)).join(' · ');

test('a finish and a mend session route on the goal\'s class like a build, by capacity, and run in the goal\'s worktree', async () => {
  for (const [stage, role] of [['finish', 'finish-session'], ['merge', 'mend-session']]) {
    for (const tool of ['claude', 'codex']) {
      const f = goalFixture({ stuck: { stage, ...(stage === 'merge' ? { log: redMerge } : {}) } });
      let capacity = capacityWith({ claude: tool === 'claude' ? 0.1 : 0.9 });
      capacity = applyObservation(capacity, 'codex', {
        windows: { primary: windowAt(tool === 'codex' ? 0.1 : 0.9) },
        models: [{ id: 'gpt-6.1-sol', efforts: ['high'] }],
      }, ROUTING_NOW);
      f.deps.capacity.write(capacity);
      const launch = f.deps.launch;
      f.deps.launch = (tool) => {
        const selected = launch(tool);
        if (tool === 'codex') selected.adapter.effortArgs = codexEffortArgs;
        return selected;
      };
      f.answer = plans(f, 'stuck', stage, 'blocked');
      const result = await createRunner({ deps: f.deps }).pass({ repo: 'memoro' });
      assert.equal(result.ran, 1, `${stage} on ${tool}`);
      const [call] = f.calls.sessions;
      assert.equal(call.env.MC_ROLE, role);
      // The goal's class is `large`: claude opus medium, or codex gpt-6.1-sol high (DEFAULT_CATALOG), whichever has room.
      assert.equal(call.env.MC_MODEL, tool === 'claude' ? 'opus' : 'gpt-6.1-sol');
      assert.equal(call.env.MC_TOOL, tool);
      assert.equal(call.cwd, `${GOALS}/stuck/memoro`, 'in the goal\'s worktree, not the programme directory');
      assert.deepEqual([call.env.MC_REPO, call.env.MC_WORKAREA], ['memoro', `${GOALS}/stuck/memoro`]);
      assert.equal('MC_PLAN_REASON' in call.env, false, 'no headless plan reason any more');
    }
  }
});

test('a goal in finish starts one finish session: the finish role, in the goal\'s worktree, told to finish it', async () => {
  const f = goalFixture({ stuck: { stage: 'finish', log: '## 2026-08-28T10:00Z · codex sol · finish · ready\n\nDone: REVIEW.md\n' } });
  const finish = plans(f, 'stuck', 'finish', 'Martin');
  f.answer = (call) => {
    call.onSpawn?.(98765);
    assert.equal(JSON.parse(f.files['/w/runner/current-memoro-1.json']).session_pid, 98765);
    return finish(call);
  };
  const runner = createRunner({ deps: f.deps });
  const r = await runner.pass({ repo: 'memoro', lane: 1 });
  assert.equal(r.ran, 1);
  assert.equal(r.name, 'goal:prog/stuck');
  const [call] = f.calls.sessions;
  assert.equal(call.env.MC_ROLE, 'finish-session');
  assert.equal(call.env.MC_HEADLESS, '1', 'the runner\'s finish session is headless');
  assert.equal(call.env.MC_GOAL, 'prog/stuck');
  assert.equal(call.cwd, `${GOALS}/stuck/memoro`, 'in the goal\'s worktree');
  assert.equal(call.env.MC_WORKAREA, `${GOALS}/stuck/memoro`);
  assert.equal('MC_REVIEW_HEAD' in call.env, false);
  assert.match(call.args.join('\n'), /ROLE finish-session/u);
  assert.match(call.prompt, /^You finish the goal prog\/stuck, headless: it is in finish\. Read REVIEW\.md in its directory when there is one, and LOG\.md; fix what review found in its worktree, gate, publish, and move it to merge\. The last word on it: REVIEW\.md\./u);
  assert.match(call.prompt, /its worktree is `\/w\/programs\/prog\/goals\/stuck\/memoro`/u);
  const during = JSON.parse(f.duringSession[0]['/w/runner/current-memoro-1.json']);
  assert.deepEqual([during.name, during.kind, during.variant], ['goal:prog/stuck', 'finish', null]);
  assert.equal(runRows(f.files)[0].kind, 'finish');
  // It set the goal Martin itself: the runner adds nothing, and no second session starts.
  assert.equal(where(f, 'stuck'), 'finish · Martin');
  assert.equal(parseLog(f.files[`${GOALS}/stuck/LOG.md`]).at(-1).tool, 'claude');
  assert.equal((await runner.pass({ repo: 'memoro' })).ran, 0);
});

test('one runner applies changed provider priority to finish and mend launches', async () => {
  const f = goalFixture({ stuck: { stage: 'finish' } });
  let priority = 'codex';
  f.deps.catalog = () => ({ ...DEFAULT_CATALOG, providerPriority: priority });
  let capacity = capacityWith({ claude: 0.1 });
  capacity = applyObservation(capacity, 'codex', { windows: { primary: windowAt(0.9) }, models: [{ id: 'gpt-6.1-sol', efforts: ['high'] }] }, ROUTING_NOW);
  f.deps.capacity.write(capacity);
  const runner = createRunner({ deps: f.deps });
  await runner.pass({ repo: 'memoro' });
  assert.deepEqual([f.calls.sessions.at(-1).env.MC_ROLE, f.calls.sessions.at(-1).env.MC_TOOL, f.calls.sessions.at(-1).env.MC_MODEL], ['finish-session', 'codex', 'gpt-6.1-sol']);
  f.files[`${GOALS}/stuck/GOAL.json`] = withGoal(f.files[`${GOALS}/stuck/GOAL.json`], { stage: 'build', status: 'blocked' });
  priority = 'claude';
  await runner.pass({ repo: 'memoro' });
  assert.deepEqual([f.calls.sessions.at(-1).env.MC_ROLE, f.calls.sessions.at(-1).env.MC_TOOL, f.calls.sessions.at(-1).env.MC_MODEL], ['mend-session', 'claude', 'opus']);
});

test('a finish session that moves the goal to merge hands it to the merger: no session starts after it', async () => {
  const f = goalFixture({ stuck: { stage: 'finish' } });
  f.answer = plans(f, 'stuck', 'merge');
  const runner = createRunner({ deps: f.deps });
  await runner.pass({ repo: 'memoro' });
  assert.equal(where(f, 'stuck'), 'merge · ready');
  assert.equal(parseLog(f.files[`${GOALS}/stuck/LOG.md`]).at(-1).tool, 'claude', 'no runner entry after it');
  assert.equal((await runner.pass({ repo: 'memoro' })).ran, 0, 'in merge the runner starts nothing');
});

test('a red in merge starts one mend session; queued again it gets the runner\'s entry and waits for the merger, not queued it is merge · blocked', async () => {
  const f = goalFixture({ red: { stage: 'merge', log: redMerge } });
  f.files[`${GOALS}/red/GOAL.json`] = withGoal(f.files[`${GOALS}/red/GOAL.json`], { prs: ['memoro#31'] });
  let line = [];
  f.deps.pendingMerges = () => line;
  f.answer = (call) => { line = [{ repo: 'memoro', pr: 31, state: 'queued' }]; return okSession()(call); };
  const runner = createRunner({ deps: f.deps });
  assert.equal((await runner.pass({ repo: 'memoro' })).ran, 1);
  assert.equal(f.calls.sessions[0].env.MC_ROLE, 'mend-session');
  assert.match(f.calls.sessions[0].prompt, /^You mend the goal prog\/red, headless — it is in merge and the merger did not land it: .*queue it again with mc goal stage merge\. The last word on it: merger answered red on #31/u);
  assert.equal(where(f, 'red'), 'merge · ready');
  assert.equal(parseLog(f.files[`${GOALS}/red/LOG.md`]).at(-1).done, 'mend session took the red; the pull request is in the merger\'s line again');
  assert.equal((await runner.pass({ repo: 'memoro' })).ran, 0, 'the red is taken: no second session');

  const g = goalFixture({ red: { stage: 'merge', log: redMerge } });
  g.files[`${GOALS}/red/GOAL.json`] = withGoal(g.files[`${GOALS}/red/GOAL.json`], { prs: ['memoro#31'] });
  g.deps.pendingMerges = () => [];
  await createRunner({ deps: g.deps }).pass({ repo: 'memoro' });
  assert.equal(where(g, 'red'), 'merge · blocked', 'a legacy merge · ready red left unqueued blocks the goal for one mend');
  assert.match(parseLog(g.files[`${GOALS}/red/LOG.md`]).at(-1).comment, /nothing in the merger's line/u);
  // The mend of the blocked goal that leaves it unqueued waits on Martin: no loop.
  await createRunner({ deps: g.deps }).pass({ repo: 'memoro' });
  assert.equal(where(g, 'red'), 'merge · Martin');
  assert.equal((await createRunner({ deps: g.deps }).pass({ repo: 'memoro' })).ran, 0);
});

test('a Martin goal, in any stage, and a goal in draft, start nothing', async () => {
  const goals = Object.fromEntries(STAGES.map((stage) => [`in-${stage}`, { stage, status: 'Martin' }]));
  const f = goalFixture({ ...goals, planned: { stage: 'draft' } });
  assert.equal((await createRunner({ deps: f.deps }).pass({ repo: 'memoro' })).ran, 0);
  assert.equal(f.calls.sessions.length, 0);
});

test('a session with a word between runner entries keeps the goal in build', async () => {
  const log = [runnerEntry('2026-08-20T10:00Z'), goalLog('2026-08-21T10:00Z'), runnerEntry('2026-08-22T10:00Z')].join('\n');
  const f = goalFixture({ goal: { log } });
  f.answer = () => ({ status: 1, stdout: '', stderr: '', timedOut: false });
  await createRunner({ deps: f.deps }).pass({ repo: 'memoro' });
  assert.equal(where(f, 'goal'), 'build · ready');
  assert.equal(parseLog(f.files[`${GOALS}/goal/LOG.md`]).length, 4);
});

test('a goal in phase 2 is not started while a goal in phase 1 is in draft, build, review, finish or merge, and is once phase 1 is done or dropped', async () => {
  for (const stage of ['draft', 'build', 'review', 'finish', 'merge']) {
    // The phase-1 goal is on another repository, so this lane could not take it itself.
    const f = goalFixture({ first: { stage, repos: 'elsewhere' }, second: { phase: 2 } });
    assert.equal((await createRunner({ deps: f.deps }).pass({ repo: 'memoro' })).ran, 0, `phase 1 ${stage}`);
    assert.equal(f.calls.sessions.length, 0);
    assert.equal(where(f, 'second'), 'build · ready', 'it keeps its stage');
    assert.equal(f.files[`${GOALS}/second/LOG.md`], '', 'and nothing is written while it waits');
  }
  const f = goalFixture({ first: { stage: 'done', repos: 'elsewhere' }, gone: { stage: 'dropped', repos: 'elsewhere' }, second: { phase: 2 } });
  f.answer = logsItself(f, 'second');
  const r = await createRunner({ deps: f.deps }).pass({ repo: 'memoro' });
  assert.equal(r.name, 'goal:prog/second', 'phase 1 done or dropped: phase 2 starts');
  assert.ok(f.calls.git.some((call) => call[0] === `${GOALS}/second/memoro` && call.slice(1).join(' ') === 'rev-list --count origin/main..HEAD'), 'its unbuilt branch is looked at against origin/main before its first build');
});

test('a goal whose only build-stage entry is its plan\'s is remade from origin/main before its first build; a build\'s entry is not remade over', async () => {
  // rev-list --count: the branch has no commits of its own, and main is two ahead of it.
  const counted = (f) => {
    const git = f.deps.git;
    f.deps.git = (cwd, args) => (args[0] === 'rev-list' && args.includes('--count')
      ? { ok: true, stdout: args.at(-1) === 'origin/main..HEAD' ? '0\n' : '2\n' } : git(cwd, args));
    return f;
  };
  const reset = (f) => f.calls.git.some((call) => call[0] === `${GOALS}/planned/memoro` && call.slice(1).join(' ') === 'reset -q --keep origin/main');
  const planned = counted(goalFixture({ planned: { log: '## 2026-08-20T10:00Z · claude opus · build · ready · by plan\n\nDone: the plan\n' } }));
  let resetBeforeSession = null;
  planned.answer = (call) => { resetBeforeSession = reset(planned); return okSession()(call); };
  await createRunner({ deps: planned.deps }).pass({ repo: 'memoro' });
  assert.equal(resetBeforeSession, true, 'remade before the session starts');
  assert.ok(planned.log.some((line) => /goal:prog\/planned: memoro goal\/planned remade from origin\/main — it had no commits of its own, and main has 2 more/u.test(line)));

  const built = counted(goalFixture({ planned: { log: '## 2026-08-20T10:00Z · claude opus · build · ready · by build\n\nDone: built\n' } }));
  await createRunner({ deps: built.deps }).pass({ repo: 'memoro' });
  assert.equal(reset(built), false, 'a build\'s own entry: the branch is not moved');
});

test('two goals in one phase run side by side, while the next phase waits', async () => {
  const f = goalFixture({ a: { log: goalLog('2026-08-20T10:00Z') }, b: { log: goalLog('2026-08-21T10:00Z') }, later: { phase: 2 } });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = [];
  f.answer = async (call) => { started.push(call.env.MC_GOAL); if (started.length === 2) release(); await gate; return okSession()(call); };
  const runner = createRunner({ deps: f.deps });
  const both = Promise.all([runner.pass({ repo: 'memoro', lane: 1, tag: 'memoro#1' }), runner.pass({ repo: 'memoro', lane: 2, tag: 'memoro#2' })]);
  const results = await both;
  assert.deepEqual(started.sort(), ['prog/a', 'prog/b'], 'both phase-1 goals had a session at once');
  assert.deepEqual(results.map((r) => r.name).sort(), ['goal:prog/a', 'goal:prog/b']);
});

test('the runner gives goals written before phases and stages a phase by the depth of the chain and a stage from their status', async () => {
  const f = goalFixture({
    first: { legacy: 'blocked', after: '', repos: 'elsewhere' },
    second: { legacy: 'waiting', after: 'prog/first' },
    third: { legacy: 'waiting', after: 'prog/second' },
    judged: { legacy: 'review', after: '', repos: 'elsewhere' },
  });
  assert.equal((await createRunner({ deps: f.deps }).pass({ repo: 'memoro' })).ran, 0, 'phase 1 is still blocked');
  assert.deepEqual(['first', 'second', 'third', 'judged'].map((name) => [goalField(f.files[`${GOALS}/${name}/GOAL.json`], 'phase'), where(f, name)]), [[1, 'build · blocked'], [2, 'build · ready'], [3, 'build · ready'], [1, 'review · ready']]);
  const [entry] = parseLog(f.files[`${GOALS}/third/LOG.md`]);
  assert.deepEqual([entry.tool, entry.stage, entry.status, entry.done], ['runner', 'build', 'ready', 'build · ready, from waiting; phase 3, from after prog/second']);
  assert.ok(f.log.some((line) => /goal:prog\/third: phase 3, build · ready \(was waiting\)/u.test(line)));
});

test('the runner recovers missing PR jobs for an existing merge decision without resetting a red job', async () => {
  const f = goalFixture({ multi: { stage: 'merge' }, building: { stage: 'build', status: 'Martin' } });
  f.files[`${GOALS}/multi/GOAL.json`] = withGoal(f.files[`${GOALS}/multi/GOAL.json`], { repos: ['memoro', 'memoro-cli'], prs: ['memoro#14804', 'memoro-cli#31'] });
  f.files[`${GOALS}/building/GOAL.json`] = withGoal(f.files[`${GOALS}/building/GOAL.json`], { prs: ['memoro#99'] });
  const pending = [{ repo: 'memoro-cli', pr: 31, state: 'red' }];
  f.deps.pendingMerges = () => pending;
  f.deps.queueMerge = (job) => { f.calls.rounds.push(job); pending.push({ ...job, state: 'queued' }); };
  const gh = f.deps.gh;
  f.deps.gh = (cwd, args) => args[0] === 'pr' && args[1] === 'view' && args.at(-1) === 'state'
    ? { ok: true, stdout: JSON.stringify({ state: 'OPEN' }) } : gh(cwd, args);
  const runner = createRunner({ deps: f.deps });
  await runner.pass({ repo: 'memoro' });
  assert.deepEqual(f.calls.rounds.map(({ repo, pr }) => [repo, pr]), [['memoro', 14804]]);
  assert.equal(where(f, 'building'), 'build · Martin');
  assert.equal(pending[0].state, 'red');
  f.deps.now = () => new Date('2026-08-29T10:06:00Z');
  await runner.pass({ repo: 'memoro' });
  assert.deepEqual(f.calls.rounds.map(({ repo, pr }) => [repo, pr]), [['memoro', 14804]], 'no duplicate execution');
});

test('a goal whose every pull request (prs) has landed or closed is set done by the runner, at most every five minutes', async () => {
  const f = goalFixture({ asc: { stage: 'merge', status: 'Martin' }, open: { stage: 'merge', status: 'Martin' }, gone: { stage: 'dropped' } });
  const withPrs = (name, prs) => { f.files[`${GOALS}/${name}/GOAL.json`] = withGoal(f.files[`${GOALS}/${name}/GOAL.json`], { prs: prs.split(',').map((one) => one.trim()) }); };
  withPrs('asc', 'memoro#14761, memoro#14756');
  withPrs('open', 'memoro#20');
  withPrs('gone', 'memoro#30');
  const states = { 14761: 'OPEN', 14756: 'MERGED', 20: 'OPEN', 30: 'MERGED' };
  const asked = [];
  const gh = f.deps.gh;
  f.deps.gh = (cwd, args) => {
    if (args[0] === 'pr' && args[1] === 'view' && args.at(-1) === 'state') {
      asked.push(Number(args[2]));
      return { ok: true, stdout: JSON.stringify({ state: states[args[2]] }) };
    }
    return gh(cwd, args);
  };
  const runner = createRunner({ deps: f.deps });
  await runner.pass({ repo: 'memoro' });
  assert.equal(where(f, 'asc'), 'merge · Martin', 'memoro#14761 is still open');
  assert.equal(asked.includes(30), false, 'a dropped goal is not asked about');

  states[14761] = 'MERGED';
  await runner.pass({ repo: 'memoro' });
  assert.equal(where(f, 'asc'), 'merge · Martin', 'not asked again within five minutes');

  f.deps.now = () => new Date('2026-08-29T10:06:00Z');
  await runner.pass({ repo: 'memoro' });
  assert.equal(goalField(f.files[`${GOALS}/asc/GOAL.json`], 'stage'), 'done');
  const entry = parseLog(f.files[`${GOALS}/asc/LOG.md`]).at(-1);
  assert.deepEqual([entry.tool, entry.stage, entry.done], ['runner', 'done', 'landed memoro#14761, memoro#14756']);
  assert.equal(where(f, 'open'), 'merge · Martin', 'memoro#20 is open');
});

test('a closed pull request is never queued: the goal is done once the others have landed, and the closed one is named', async () => {
  const f = goalFixture({ shut: { stage: 'merge', status: 'ready' } });
  f.files[`${GOALS}/shut/GOAL.json`] = withGoal(f.files[`${GOALS}/shut/GOAL.json`], { prs: ['memoro#1', 'memoro#2'] });
  const states = { 1: 'MERGED', 2: 'CLOSED' };
  const gh = f.deps.gh;
  f.deps.gh = (cwd, args) => (args[0] === 'pr' && args[1] === 'view' && args.at(-1) === 'state'
    ? { ok: true, stdout: JSON.stringify({ state: states[args[2]] }) } : gh(cwd, args));
  await createRunner({ deps: f.deps }).pass({ repo: 'memoro' });
  assert.equal(f.calls.rounds.some(({ pr }) => pr === 2), false, 'memoro#2 is not queued');
  assert.equal(goalField(f.files[`${GOALS}/shut/GOAL.json`], 'stage'), 'done');
  const entry = parseLog(f.files[`${GOALS}/shut/LOG.md`]).at(-1);
  assert.deepEqual([entry.tool, entry.stage, entry.done, entry.comment], ['runner', 'done', 'landed memoro#1', 'closed without landing: memoro#2']);
});

test('a Martin or done goal is never started', async () => {
  const f = goalFixture({ stuck: { status: 'Martin' }, finished: { stage: 'done' } });
  f.files[`${GOALS}/broken/GOAL.json`] = 'no front matter\n';
  const r = await createRunner({ deps: f.deps }).pass({ repo: 'memoro' });
  assert.equal(r.ran, 0);
  assert.equal(f.calls.sessions.length, 0);
});

test('a goal that has lost its worktree gets it back on its branch, and says so', async () => {
  const f = goalFixture({ lost: { worktree: false } });
  f.answer = logsItself(f, 'lost');
  await createRunner({ deps: f.deps }).pass({ repo: 'memoro' });
  const add = f.calls.git.find(([cwd, ...args]) => cwd === '/home/memoro' && args[0] === 'worktree' && args[1] === 'add');
  assert.ok(add.includes(`${GOALS}/lost/memoro`));
  assert.ok(add.includes('goal/lost'));
  assert.ok(f.log.some((line) => /goal:prog\/lost: .* is not a worktree — creating it on goal\/lost/u.test(line)));
  assert.equal(f.calls.sessions.length, 1);
});

/**
 * Records each `worktree add` the runner makes, with the path it adds and how
 * many sessions had started by then: the order the runner's own proof rests on.
 */
function sessionsAtAdd(f) {
  const adds = [];
  const { git } = f.deps;
  f.deps.git = (cwd, args) => {
    if (args[0] === 'worktree' && args[1] === 'add') adds.push({ cwd, args, path: args.find((arg) => arg.startsWith('/w/')), sessionsBefore: f.calls.sessions.length });
    return git(cwd, args);
  };
  return adds;
}

/** The fixture's git with no branch yet: `show-ref` finds none, so a goal's branch is made from origin/main. */
function noBranches(f) {
  const { git } = f.deps;
  f.deps.git = (cwd, args) => (args[0] === 'show-ref' ? { ok: false, stdout: '', stderr: '' } : git(cwd, args));
}

test('a build session on a goal with no worktree makes it on goal/<goal> before the session starts', async () => {
  const f = goalFixture({ fresh: { worktree: false } });
  noBranches(f);
  const adds = sessionsAtAdd(f);
  assert.equal((await createRunner({ deps: f.deps }).pass({ repo: 'memoro' })).ran, 1);
  const [goalAdd] = adds.filter((add) => add.path === `${GOALS}/fresh/memoro`);
  assert.deepEqual([goalAdd.cwd, goalAdd.args], ['/home/memoro', ['worktree', 'add', '-q', '-b', 'goal/fresh', `${GOALS}/fresh/memoro`, 'origin/main']]);
  assert.equal(goalAdd.sessionsBefore, 0, 'made before the session');
  assert.equal(f.calls.sessions.length, 1);
});

test('a finish session on a goal with no worktree makes the goal\'s worktree before it starts, and no planning checkout', async () => {
  const f = goalFixture({ stuck: { stage: 'finish', worktree: false } });
  noBranches(f);
  f.dirs.add('/home/memoro');
  const adds = sessionsAtAdd(f);
  assert.equal((await createRunner({ deps: f.deps }).pass({ repo: 'memoro' })).ran, 1);
  const goalAdd = adds.find((add) => add.path === `${GOALS}/stuck/memoro`);
  assert.deepEqual(goalAdd?.args, ['worktree', 'add', '-q', '-b', 'goal/stuck', `${GOALS}/stuck/memoro`, 'origin/main']);
  assert.equal(goalAdd.sessionsBefore, 0);
  assert.equal(adds.some((add) => add.path === '/w/programs/prog/memoro'), false, 'the runner makes no plan/<programme> checkout: mc plan does');
  assert.equal(f.calls.sessions[0].cwd, `${GOALS}/stuck/memoro`, 'the finish session stands in the goal\'s worktree');
});

test('a released goal worktree comes back on its own existing branch, as it was: added without -b, after a prune', async () => {
  const f = goalFixture({ lost: { worktree: false } });
  const { git } = f.deps;
  f.deps.git = (cwd, args) => (args[0] === 'show-ref' ? { ok: true, stdout: '', stderr: '' } : git(cwd, args));
  const adds = sessionsAtAdd(f);
  await createRunner({ deps: f.deps }).pass({ repo: 'memoro' });
  const [goalAdd] = adds.filter((add) => add.path === `${GOALS}/lost/memoro`);
  assert.deepEqual(goalAdd.args, ['worktree', 'add', '-q', `${GOALS}/lost/memoro`, 'goal/lost']);
});

test('a goal whose worktree cannot be added starts no session, and its log says why', async () => {
  const f = goalFixture({ lost: { worktree: false } });
  const { git } = f.deps;
  f.deps.git = (cwd, args) => (args[0] === 'worktree' && args.includes(`${GOALS}/lost/memoro`) ? { ok: false, stdout: '', stderr: 'branch in use' } : git(cwd, args));
  const r = await createRunner({ deps: f.deps }).pass({ repo: 'memoro' });
  assert.equal(r.ran, 0);
  assert.equal(f.calls.sessions.length, 0);
  const last = parseLog(f.files[`${GOALS}/lost/LOG.md`]).at(-1);
  assert.deepEqual([last.tool, last.comment], ['runner', 'no session started: memoro\'s worktree could not be made (branch in use)']);
});

test('a goal whose worktree was deleted is pruned from git before its branch is added again', async () => {
  const f = goalFixture({ lost: { worktree: false } });
  f.answer = logsItself(f, 'lost');
  const { git } = f.deps;
  // The branch outlives the directory, and git still has the worktree registered.
  f.deps.git = (cwd, args) => (args[0] === 'show-ref' ? { ok: true, stdout: '', stderr: '' } : git(cwd, args));
  await createRunner({ deps: f.deps }).pass({ repo: 'memoro' });
  const at = (verb) => f.calls.git.findIndex(([cwd, ...args]) => cwd === '/home/memoro' && args[0] === 'worktree' && args[1] === verb);
  assert.ok(at('prune') >= 0, 'pruned');
  assert.ok(at('prune') < at('add'), 'before the add');
  assert.equal(f.calls.git[at('add')].at(-1), 'goal/lost');
  assert.equal(f.calls.sessions.length, 1);
});

test('a goal keeps no slot once its session has ended', async () => {
  const f = goalFixture({ capped: {}, other: {} });
  f.deps.laneCount = () => ({ lanes: 1 });
  // The first pick passes over the other goal, so capped runs; the second
  // takes the other goal and the machine's one slot without a wait.
  f.answer = logsItself(f, 'capped');
  const runner = createRunner({ deps: f.deps });
  assert.equal((await runner.pass({ repo: 'memoro', passed: ['goal:prog/other'] })).name, 'goal:prog/capped');
  f.answer = logsItself(f, 'other');
  assert.equal((await runner.pass({ repo: 'memoro', lane: 1, passed: ['goal:prog/capped'] })).name, 'goal:prog/other');
  assert.equal(f.log.some((line) => /waiting for a lane/u.test(line)), false);
});

/* ---------------------------------------------------------- goal reviews */

const HEAD = 'abc1234def5678';
const builtBy = (who, at = '2026-08-28T10:00Z') => `## ${at} · ${who} · review · ready\n\nDone: built it\n`;

/** A goal in review whose branch has `pr` open at `head` (null: none), as `gh pr list --head` answers. */
function reviewFixture({ log = builtBy('codex gpt-6.1-sol'), pr = 31, head = HEAD, goals = {} } = {}) {
  const f = goalFixture({ judged: { stage: 'review', log }, ...goals });
  const { gh } = f.deps;
  f.head = head;
  f.deps.gh = (cwd, args) => {
    if (args.includes('--head')) {
      f.calls.gh.push([cwd, ...args]);
      return { ok: true, stdout: JSON.stringify(pr === null ? [] : [{ number: pr, headRefOid: f.head }]) };
    }
    return gh(cwd, args);
  };
  return f;
}

/** A review session that decides, as `mc goal stage merge|finish` does: its one-line entry and the stage. */
const judges = (f, stage, inner = okSession()) => (call) => {
  const path = `${GOALS}/judged/LOG.md`;
  f.files[path] = `${f.files[path]}\n## 2026-08-29T10:00Z · claude opus · ${stage} · ready\n\nDone: ${stage}; proposals/2026-08-29-mc-x.md\n`;
  f.files[`${GOALS}/judged/GOAL.json`] = withGoal(f.files[`${GOALS}/judged/GOAL.json`], { stage, status: 'ready' });
  return inner(call);
};
const goalEntries = (f, name = 'judged') => parseLog(f.files[`${GOALS}/${name}/LOG.md`]);

test('review and finish release their lane after merge handoff so the next assignment can start', async () => {
  for (const stage of ['review', 'finish']) {
    const f = reviewFixture({ goals: { next: {} } });
    f.files[`${GOALS}/judged/GOAL.json`] = withGoal(f.files[`${GOALS}/judged/GOAL.json`], { stage, prs: ['memoro#31'] });
    f.deps.laneCount = () => ({ lanes: 1 });
    let starts = 0;
    f.answer = async (call) => {
      starts += 1;
      if (starts > 1) return logsItself(f, 'next')(call);
      assert.equal(call.handoff(), false);
      const queued = [];
      const rc = await goalCommand(['stage', 'merge'], {
        ...f.deps, env: call.env, home: '/w/programs', known: () => ['/home/memoro'],
        stdout: { write() {} }, stderr: { write() {} },
        queue: (job) => { queued.push([job.repo, job.pr]); assert.equal(call.handoff(), false); },
      });
      assert.equal(rc, 0);
      assert.deepEqual(queued, [['memoro', 31]]);
      assert.equal(call.handoff(), true, 'only a completed queue handoff ends the session');
      return { ...okSession()(call), handedOff: true };
    };
    const runner = createRunner({ deps: f.deps });
    assert.equal((await runner.pass({ lane: 1 })).name, 'goal:prog/judged');
    assert.deepEqual(runner.stepsHeld(), []);
    assert.equal((await runner.pass({ lane: 1 })).name, 'goal:prog/next');
    assert.equal(starts, 2);
    assert.equal(where(f, 'judged'), 'merge · ready');
    assert.equal(f.log.some((line) => /waiting for a lane/u.test(line)), false);
  }
});

test('a goal in review gets a review session: the goal-review role, the review model, its pull request and head', async () => {
  const f = reviewFixture();
  f.answer = judges(f, 'merge');
  const r = await createRunner({ deps: f.deps }).pass({ repo: 'memoro' });
  assert.equal(r.name, 'goal:prog/judged');
  const [call] = f.calls.sessions;
  assert.equal(call.env.MC_ROLE, 'review-session:goal');
  assert.equal(call.env.MC_GOAL, 'prog/judged');
  assert.equal(call.env.MC_MODEL, DEFAULT_CATALOG.review[0].model);
  assert.match(call.args.join('\n'), /ROLE review-session:goal/u);
  assert.match(call.prompt, /pull request is #31, at head abc1234def5678/u);
  assert.equal(call.env.MC_REVIEW_HEAD, HEAD, 'the head its mc goal stage merge queues');
  assert.equal(call.env.MC_REVIEW_PR, '31');
  assert.ok(Number.isFinite(Date.parse(call.env.MC_SESSION_STARTED)), 'when it began, for the Stop hook');
  assert.match(call.prompt.split('\n')[0], /Your role says the rest\.$/u, 'the first line says where; the brief follows');
  assert.match(call.prompt, /\nCRITERIA 0\/1\n  1 ✗ it works\n      check: a test/u, 'the review is briefed with the goal as mc goal show renders it');
});

test('a goal whose every review candidate is its build model is reviewed on that model, not left waiting', async () => {
  // The review catalog's model and the build session's are the same: claude opus.
  const sameModel = builtBy(`claude ${DEFAULT_CATALOG.review[0].model}`, '2026-08-20T10:00Z');
  const f = reviewFixture({ log: sameModel });
  f.answer = judges(f, 'merge');
  const r = await createRunner({ deps: f.deps }).pass({ repo: 'memoro' });
  assert.equal(r.name, 'goal:prog/judged');
  const [call] = f.calls.sessions;
  assert.equal(call.env.MC_ROLE, 'review-session:goal');
  assert.deepEqual([call.env.MC_TOOL, call.env.MC_MODEL], ['claude', DEFAULT_CATALOG.review[0].model]);
  assert.equal(f.log.some((line) => /its review waits/u.test(line)), false);
  assert.ok(f.log.some((line) => /review starting .*preferred \(review candidate 1 — claude opus built it, and no other candidate can run on its plan\)/u.test(line)));
});

test('a review\'s own entry is no build entry: the build entry before it is the model passed over', async () => {
  // Built on codex sol, then a review that died: sol is still the builder,
  // so the next review passes sol (candidate 1) for opus (candidate 2).
  const reviewed = `${builtBy('codex gpt-6.1-sol', '2026-08-20T10:00Z')}\n## 2026-08-21T10:00Z · runner · review · ready\n\nComment: the review ended with the goal still in review — a review runs again\n`;
  const f = reviewList(reviewFixture({ log: reviewed }));
  f.deps.capacity.write(capacityWith({ claude: 0.1, codex: 0.1 }));
  f.answer = judges(f, 'merge');
  await createRunner({ deps: f.deps }).pass({ repo: 'memoro' });
  assert.deepEqual([f.calls.sessions[0].env.MC_TOOL, f.calls.sessions[0].env.MC_MODEL], ['claude', 'opus']);
});

test('a goal built on the second review candidate is reviewed on it when the first one\'s plan is spent and its API is off', async () => {
  const f = reviewList(reviewFixture({ log: builtBy('claude opus') }));
  f.deps.capacity.write(capacityWith({ claude: 0.1, codex: 1 }));
  f.answer = judges(f, 'merge');
  assert.equal((await createRunner({ deps: f.deps }).pass({ repo: 'memoro' })).name, 'goal:prog/judged');
  const [call] = f.calls.sessions;
  assert.equal(call.env.MC_ROLE, 'review-session:goal');
  assert.deepEqual([call.env.MC_TOOL, call.env.MC_MODEL], ['claude', 'opus']);
  assert.equal(f.log.some((line) => /its review waits/u.test(line)), false);
});

const SOL_REVIEW = { tool: 'codex', model: 'gpt-6.1-sol', effort: 'high' };
const OPUS_REVIEW = { tool: 'claude', model: 'opus', effort: 'high' };
const LUNA_REVIEW = { tool: 'codex', model: 'gpt-6-luna', effort: 'high' };
/** A catalog whose review list is codex sol then claude opus, and a billing whose codex API is `codexApi`. */
function reviewList(f, { codexApi = false } = {}) {
  f.deps.catalog = () => ({ ...structuredClone(DEFAULT_CATALOG), review: [SOL_REVIEW, OPUS_REVIEW] });
  f.deps.billing = { readMode: () => 'plan', readState: () => ({}), patchState: () => {}, readApi: () => ({ claude: false, codex: codexApi }) };
  return f;
}

test('a goal review passes a first candidate at 100 % with its API off for the next on plan', async () => {
  const f = reviewList(reviewFixture({ log: builtBy('claude haiku') }));
  f.deps.capacity.write(capacityWith({ claude: 0.1, codex: 1 }));
  f.answer = judges(f, 'merge');
  assert.equal((await createRunner({ deps: f.deps }).pass({ repo: 'memoro' })).name, 'goal:prog/judged');
  const [call] = f.calls.sessions;
  assert.equal(call.env.MC_ROLE, 'review-session:goal');
  assert.deepEqual([call.env.MC_TOOL, call.env.MC_MODEL], ['claude', 'opus']);
  assert.equal(f.log.some((line) => /its review waits/u.test(line)), false);
});

test('a goal built on the first review candidate is reviewed by the next one when both have plan left', async () => {
  const f = reviewList(reviewFixture({ log: builtBy('codex gpt-6.1-sol') }));
  f.deps.capacity.write(capacityWith({ claude: 0.1, codex: 0.1 }));
  f.answer = judges(f, 'merge');
  await createRunner({ deps: f.deps }).pass({ repo: 'memoro' });
  assert.deepEqual([f.calls.sessions[0].env.MC_TOOL, f.calls.sessions[0].env.MC_MODEL], ['claude', 'opus']);
  assert.ok(f.log.some((line) => /review starting .* class large: preferred \(review candidate 2 — codex gpt-6\.1-sol built it\)/u.test(line)));
});

test('goal review rereads changed provider priority over headroom and build-model avoidance', async () => {
  const f = reviewFixture({ log: builtBy('codex gpt-6-luna') });
  let priority = 'codex';
  f.deps.catalog = () => ({ ...structuredClone(DEFAULT_CATALOG), providerPriority: priority, review: [OPUS_REVIEW, LUNA_REVIEW] });
  f.deps.capacity.write(capacityWith({ claude: 0.1, codex: 0.9 }));
  f.answer = judges(f, 'review');
  const runner = createRunner({ deps: f.deps });
  await runner.pass({ repo: 'memoro' });
  const call = f.calls.sessions[0];
  assert.deepEqual([call.env.MC_TOOL, call.env.MC_MODEL], ['codex', 'gpt-6-luna']);
  assert.ok(f.log.some((line) => /codex provider priority/u.test(line)));
  priority = 'claude';
  f.answer = judges(f, 'merge');
  await runner.pass({ repo: 'memoro' });
  assert.deepEqual(f.calls.sessions.map(c => [c.env.MC_TOOL, c.env.MC_MODEL]), [['codex', 'gpt-6-luna'], ['claude', 'opus']]);
});

test('a goal review with no candidate on plan goes to the API reserve, and waits while that API is off', async () => {
  const f = reviewList(reviewFixture({ log: builtBy('claude haiku') }));
  f.deps.catalog = () => ({ ...structuredClone(DEFAULT_CATALOG), providerPriority: 'codex', review: [SOL_REVIEW, OPUS_REVIEW] });
  f.deps.capacity.write(capacityWith({ claude: 0.1, codex: 1, refuse: { claude: '2026-08-29T13:00:00Z' } }));
  assert.equal((await createRunner({ deps: f.deps }).pass({ repo: 'memoro' })).ran, 0);
  assert.equal(f.calls.sessions.length, 0);
  assert.ok(f.log.some((line) => /goal:prog\/judged: its review waits — .*; API reserve; codex API off/u.test(line)));
});

test('a review decides: merge is the merger\'s — the runner queues nothing and reads nothing, and starts no session after it', async () => {
  const f = reviewFixture();
  f.answer = judges(f, 'merge');
  const runner = createRunner({ deps: f.deps });
  await runner.pass({ repo: 'memoro' });
  assert.equal(f.calls.rounds.length, 0, 'mc goal stage merge queued it; the runner does not');
  assert.equal(where(f, 'judged'), 'merge · ready');
  assert.equal(goalEntries(f).at(-1).tool, 'claude', 'no runner entry after a review that decided');
  assert.equal((await runner.pass({ repo: 'memoro' })).ran, 0, 'no second review');
  assert.equal(f.calls.sessions.length, 1);
});

test('a review that sends the goal to finish hands it to one finish session, never back to a build', async () => {
  const f = reviewFixture();
  f.answer = judges(f, 'finish');
  const runner = createRunner({ deps: f.deps });
  await runner.pass({ repo: 'memoro' });
  assert.equal(where(f, 'judged'), 'finish · ready');
  f.answer = plans(f, 'judged', 'merge');
  assert.equal((await runner.pass({ repo: 'memoro' })).ran, 1);
  assert.equal(f.calls.sessions.at(-1).env.MC_ROLE, 'finish-session');
  assert.equal(f.calls.sessions.some((call) => call.env.MC_ROLE === 'build-session:goal'), false, 'never back to a build session');
});

test('a review that dies leaves review · ready and a review runs again; a second that dies sets review · blocked', async () => {
  const f = reviewFixture();
  f.answer = () => ({ status: 1, stdout: '', stderr: '', timedOut: false });
  const runner = createRunner({ deps: f.deps });
  await runner.pass({ repo: 'memoro' });
  assert.equal(where(f, 'judged'), 'review · ready');
  assert.match(goalEntries(f).at(-1).comment, /^the review ended with the goal still in review — a review runs again$/u);
  assert.equal((await runner.pass({ repo: 'memoro' })).ran, 1);
  assert.equal(f.calls.sessions.at(-1).env.MC_ROLE, 'review-session:goal');
  assert.equal(where(f, 'judged'), 'review · blocked');
  assert.match(goalEntries(f).at(-1).comment, /a second time — a mend session takes it$/u);
  assert.equal((await runner.pass({ repo: 'memoro' })).ran, 1);
  assert.equal(f.calls.sessions.at(-1).env.MC_ROLE, 'mend-session');
  assert.equal(where(f, 'judged'), 'review · Martin');
  assert.equal((await runner.pass({ repo: 'memoro' })).ran, 0);
  assert.equal(f.calls.sessions.length, 3);
});

/** Makes `worktree`'s `git status --porcelain` answer `tree.lines`, as a fault left in it would; `tree` is mutable. */
function dirtyTree(f, worktree, lines = []) {
  const tree = { lines };
  const git = f.deps.git;
  f.deps.git = (cwd, args) => (cwd === worktree && args.join(' ') === 'status --porcelain'
    ? { ok: true, stdout: tree.lines.map((line) => `${line}\n`).join(''), stderr: '' }
    : git(cwd, args));
  return tree;
}

test('a review on a dirty goal worktree starts no session: the goal is review · blocked, its reason naming the worktree and the changed paths; clean, it is reviewed', async () => {
  const f = reviewFixture();
  f.answer = judges(f, 'merge');
  const worktree = `${GOALS}/judged/memoro`;
  const tree = dirtyTree(f, worktree, [' M src/mc/runner-lock.js', '?? probe.js']);
  const runner = createRunner({ deps: f.deps });
  await runner.pass({ repo: 'memoro' });
  assert.equal(f.calls.sessions.length, 0, 'no session of any kind starts on the dirty tree');
  assert.equal(where(f, 'judged'), 'review · blocked');
  const reason = goalEntries(f).at(-1).comment;
  assert.match(reason, /^the review did not start: /u);
  assert.ok(reason.includes(worktree) && reason.includes('src/mc/runner-lock.js') && reason.includes('probe.js'), reason);
  tree.lines = [];
  f.files[`${GOALS}/judged/GOAL.json`] = withGoal(f.files[`${GOALS}/judged/GOAL.json`], { stage: 'review', status: 'ready' });
  await runner.pass({ repo: 'memoro' });
  assert.equal(f.calls.sessions.length, 1);
  assert.equal(f.calls.sessions[0].env.MC_ROLE, 'review-session:goal', 'a clean tree is reviewed as before');
});

test('a review that dies with its tree left dirty logs the dirty paths in the entry the runner writes', async () => {
  const f = reviewFixture();
  const tree = dirtyTree(f, `${GOALS}/judged/memoro`);
  f.answer = () => {
    tree.lines = [' M src/mc/runner-lock.js'];
    return { status: 1, stdout: '', stderr: '', timedOut: false };
  };
  await createRunner({ deps: f.deps }).pass({ repo: 'memoro' });
  assert.equal(where(f, 'judged'), 'review · ready');
  assert.match(goalEntries(f).at(-1).comment, /^the review ended with the goal still in review — a review runs again; worktree not clean — .*src\/mc\/runner-lock\.js$/u);
});

test('a goal in review with no open pull request goes to finish, and no review starts', async () => {
  const f = reviewFixture({ pr: null });
  await createRunner({ deps: f.deps }).pass({ repo: 'memoro' });
  assert.equal(f.calls.sessions.filter((call) => call.env.MC_ROLE === 'review-session:goal').length, 0);
  assert.equal(where(f, 'judged'), 'finish · ready');
  assert.match(goalEntries(f).at(-1).comment, /^in review, but goal\/judged has no open pull request — a finish session takes it$/u);
});

/* ---------------------------------------------------------------- no loop */

test('a goal driven through a red review, a red merge and a moved head reaches merge · blocked in five sessions, its stage never going back', async () => {
  const f = reviewFixture({ log: '' });
  f.files[`${GOALS}/judged/GOAL.json`] = withGoal(f.files[`${GOALS}/judged/GOAL.json`], { stage: 'build', prs: ['memoro#31'] });
  let line = [];
  f.deps.pendingMerges = () => line;
  const runner = createRunner({ deps: f.deps });
  const seen = [];
  const note = () => seen.push(where(f, 'judged'));
  const rank = (stage) => Math.min(STAGES.indexOf(stage), STAGES.indexOf('done'));
  /** What the merger writes when it does not land the goal's pull request (merger.js `tellGoal`). */
  const mergerAnswers = (kind) => {
    const blocked = parseLog(f.files[`${GOALS}/judged/LOG.md`]).some((entry) => entry.tool === 'runner' && entry.stage === 'merge' && /^merger answered/u.test(entry.done ?? ''));
    line = [];
    f.files[`${GOALS}/judged/LOG.md`] += `\n## 2026-08-30T10:00Z · runner · merge · ${blocked ? 'blocked' : 'ready'}\n\nDone: ${redMergeText(31, kind)}\n`;
    f.files[`${GOALS}/judged/GOAL.json`] = withGoal(f.files[`${GOALS}/judged/GOAL.json`], { stage: 'merge', status: blocked ? 'blocked' : 'ready' });
  };
  // 1. The build session ends the task: review.
  f.answer = (call) => { f.files[`${GOALS}/judged/LOG.md`] += `\n${builtBy('codex gpt-6.1-sol')}`; f.files[`${GOALS}/judged/GOAL.json`] = withGoal(f.files[`${GOALS}/judged/GOAL.json`], { stage: 'review' }); return okSession()(call); };
  await runner.pass({ repo: 'memoro' }); note();
  // 2. The review is red: finish, with REVIEW.md.
  f.answer = judges(f, 'finish');
  await runner.pass({ repo: 'memoro' }); note();
  // 3. The finish session fixes, publishes and queues: merge.
  f.answer = (call) => { line = [{ repo: 'memoro', pr: 31, state: 'queued' }]; return plans(f, 'judged', 'merge')(call); };
  await runner.pass({ repo: 'memoro' }); note();
  assert.equal((await runner.pass({ repo: 'memoro' })).ran, 0, 'in the merger\'s line, nothing starts');
  // 4. The merger answers red: one mend session takes it and queues again.
  mergerAnswers('red'); note();
  f.answer = (call) => { line = [{ repo: 'memoro', pr: 31, state: 'queued' }]; return okSession()(call); };
  await runner.pass({ repo: 'memoro' }); note();
  // 5. The head moved past the one judged: the second answer in merge blocks it.
  mergerAnswers('moved'); note();
  f.answer = plans(f, 'judged', 'merge', 'Martin');
  assert.equal((await runner.pass({ repo: 'memoro' })).ran, 1);
  assert.equal(f.calls.sessions.at(-1).env.MC_ROLE, 'mend-session');
  assert.equal(where(f, 'judged'), 'merge · Martin');
  for (let i = 0; i < 5; i += 1) assert.equal((await runner.pass({ repo: 'memoro' })).ran, 0, `pass ${i + 1} after it starts nothing`);

  assert.deepEqual(seen, ['review · ready', 'finish · ready', 'merge · ready', 'merge · ready', 'merge · ready', 'merge · blocked']);
  const stages = parseLog(f.files[`${GOALS}/judged/LOG.md`]).map((entry) => entry.stage).filter(Boolean);
  for (let i = 1; i < stages.length; i += 1) assert.ok(rank(stages[i]) >= rank(stages[i - 1]), `${stages[i - 1]} → ${stages[i]} goes back`);
  assert.deepEqual(f.calls.sessions.map((call) => call.env.MC_ROLE), ['build-session:goal', 'review-session:goal', 'finish-session', 'mend-session', 'mend-session'], 'a finish and two mends, without moving a stage backward');
});

test('blocked work in any stage wakes a mend session, which retries the same stage; Martin never wakes it', async () => {
  for (const stage of ['draft', 'build', 'review', 'finish', 'merge']) {
    const f = goalFixture({ stuck: { stage, status: 'blocked' } });
    if (stage === 'merge') {
      f.files[`${GOALS}/stuck/GOAL.json`] = withGoal(f.files[`${GOALS}/stuck/GOAL.json`], { prs: ['memoro#31'] });
      f.deps.pendingMerges = () => [{ repo: 'memoro', pr: 31, state: 'queued' }];
    }
    f.answer = plans(f, 'stuck', stage);
    const runner = createRunner({ deps: f.deps });
    assert.equal((await runner.pass({ repo: 'memoro' })).ran, 1, stage);
    const [call] = f.calls.sessions;
    assert.equal(call.env.MC_ROLE, 'mend-session', stage);
    assert.match(call.prompt, stage === 'merge'
      ? /it is in merge · blocked and the merger did not land it/u
      : new RegExp(`it is blocked in ${stage}: read LOG\\.md and REVIEW\\.md when present, diagnose and resolve the obstacle, then retry the same stage with mc goal ready`, 'u'), stage);
    assert.equal(call.env.MC_GOAL, 'prog/stuck', stage);
    assert.equal(where(f, 'stuck'), `${stage} · ready`, stage);
    assert.equal(runner.nextWork({ repo: 'memoro' })?.kind ?? null,
      { draft: null, build: 'build', review: 'review', finish: 'finish', merge: null }[stage], stage);
    f.files[`${GOALS}/stuck/GOAL.json`] = withGoal(f.files[`${GOALS}/stuck/GOAL.json`], { status: 'Martin' });
    assert.equal((await runner.pass({ repo: 'memoro' })).ran, 0, stage);
  }
});

test('a recovery that cannot resolve the obstacle waits on Martin, without a repeated session', async () => {
  const f = goalFixture({ stuck: { status: 'blocked' } });
  const runner = createRunner({ deps: f.deps });
  assert.equal((await runner.pass()).ran, 1);
  assert.equal(where(f, 'stuck'), 'build · Martin');
  assert.equal((await createRunner({ deps: f.deps }).pass()).ran, 0);
  assert.equal(f.calls.sessions.length, 1);
});

test('repeated blocked recoveries are bounded across restarts, and a person can explicitly retry', async () => {
  const f = goalFixture({ stuck: { status: 'blocked' } });
  f.answer = plans(f, 'stuck', 'build');
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.equal((await createRunner({ deps: f.deps }).pass()).ran, 1);
    f.files[`${GOALS}/stuck/GOAL.json`] = withGoal(f.files[`${GOALS}/stuck/GOAL.json`], { status: 'blocked' });
  }
  assert.equal((await createRunner({ deps: f.deps }).pass()).ran, 0);
  assert.equal(where(f, 'stuck'), 'build · Martin');
  f.files[`${GOALS}/stuck/LOG.md`] += '\n## 2026-08-29T12:00Z · person · build · ready\n\nComment: resolved it\n';
  f.files[`${GOALS}/stuck/GOAL.json`] = withGoal(f.files[`${GOALS}/stuck/GOAL.json`], { status: 'blocked' });
  assert.equal((await createRunner({ deps: f.deps }).pass()).ran, 1);
});

test('two blocked goals in one programme are mended side by side: a mend holds no programme-wide planning claim', async () => {
  const f = goalFixture({ a: { status: 'blocked' }, b: { status: 'blocked' } });
  f.deps.laneCount = () => ({ lanes: 2 });
  let release;
  f.answer = (call) => {
    if (call.env.MC_GOAL === 'prog/a') return plans(f, 'a', 'build', 'Martin', () => new Promise((resolve) => { release = () => resolve(okSession()()); }))(call);
    return plans(f, 'b', 'build', 'ready')(call);
  };
  const runner = createRunner({ deps: f.deps });
  const first = runner.pass({ lane: 1 });
  for (let turn = 0; !release && turn < 50; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  const second = await runner.pass({ lane: 2 });
  assert.equal(second.ran, 1, 'the second lane mends b while a is being mended');
  assert.equal(second.name, 'goal:prog/b');
  release();
  assert.equal((await first).ran, 1);
  assert.deepEqual(f.calls.sessions.map((call) => call.env.MC_ROLE), ['mend-session', 'mend-session']);
});

test('programme priority is reread live within a stage; blocked recovery, review and phase eligibility take precedence', () => {
  const f = goalFixture({ older: { log: goalLog('2026-08-27T10:00Z') } });
  const base = '/w/programs/preferred';
  f.files[`${base}/goals/new/GOAL.json`] = goalJson({ repos: ['memoro'] });
  f.files[`${base}/goals/new/LOG.md`] = goalLog('2026-08-28T10:00Z');
  const runner = createRunner({ deps: f.deps });
  assert.equal(runner.nextWork().name, 'goal:prog/older');
  f.files[`${base}/PRIORITY.json`] = JSON.stringify({ priority: 10 });
  assert.equal(runner.nextWork().name, 'goal:preferred/new');
  f.files[`${GOALS}/older/GOAL.json`] = withGoal(f.files[`${GOALS}/older/GOAL.json`], { stage: 'review' });
  assert.equal(runner.nextWork().name, 'goal:prog/older', 'review precedes even a preferred build');
  f.files[`${base}/goals/new/GOAL.json`] = withGoal(f.files[`${base}/goals/new/GOAL.json`], { status: 'blocked' });
  assert.equal(runner.nextWork().name, 'goal:preferred/new', 'recovery precedes review');
  f.files[`${base}/goals/new/GOAL.json`] = withGoal(f.files[`${base}/goals/new/GOAL.json`], { phase: 2 });
  f.files[`${base}/goals/first/GOAL.json`] = goalJson({ repos: ['memoro'], stage: 'draft' });
  assert.equal(runner.nextWork().name, 'goal:prog/older', 'priority does not bypass phases');
  f.files[`${GOALS}/older/GOAL.json`] = withGoal(f.files[`${GOALS}/older/GOAL.json`], { stage: 'build' });
  f.files[`${base}/PRIORITY.json`] = JSON.stringify({ priority: 0 });
  delete f.files[`${base}/goals/first/GOAL.json`];
  f.files[`${base}/goals/new/GOAL.json`] = withGoal(f.files[`${base}/goals/new/GOAL.json`], { phase: 1, status: 'ready' });
  assert.equal(runner.nextWork().name, 'goal:prog/older', 'reset restores oldest first');
});
