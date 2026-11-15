import { createDiskPressure } from '../../src/mc/disk-pressure.js';
import { effortArgs as codexEffortArgs } from '../../src/adapters/codex.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { answerHeldDeployMend, publishDeployMend, readDeployMends, recordRepaired, requestDeployRepair } from '../../src/mc/deploy-repair.js';
import { answerHeldMend, answerMainMend, publishMainMend, readMainMends, requestMainRepair, updateMainMends } from '../../src/mc/main-repair.js';
import { MEMORY_MIN_FREE_PERCENT, RUNNER_LOG_MAX_BYTES, createRunner, dockerNote, realDeps, runLoop, UPDATE_POLL_MS } from '../../src/mc/run.js';
import { removeReadCheckouts, setUpReadCheckouts } from '../../src/mc/programme-turn.js';
import { freeMemoryPercent } from '../../src/mc/dev-servers.js';
import { rotateIfLarge } from '../../src/mc/logger.js';
import { COOLDOWN_MS, EVENTS_KEEP, POLL_MS } from '../../src/mc/disk-pressure.js';
import { parseGoal, parseLog, redMergeText, STAGES } from '../../src/mc/goals.js';
import { seenAreas, trippedAreas } from '../../src/mc/review-verdict.js';
import { mcCheckout, startRunner } from '../../src/mc/run-control.js';
import { TIDY_KIND } from '../../src/mc/run-plan.js';
import * as claudeAdapter from '../../src/adapters/claude-code.js';
import { expandRoleIncludes, sharedRoleText, textDigest } from '../../src/mc/roles.js';
import { applyObservation, applyRefusal, normaliseCapacity } from '../../src/mc/model-capacity.js';
import { DEFAULT_CATALOG } from '../../src/mc/model-config.js';
import { goalField, goalJson, goalJsonV2, withGoal } from './_helpers/goal-file.js';
import { run as goalCommand } from '../../src/mc/commands/goal.js';
import { run as martinCommand } from '../../src/mc/commands/martin.js';
import { deskBudget, deskSettingsPath } from '../../src/mc/desk-budget.js';
import { readCanonRole } from '../../src/mc/roles.js';
import { deskItemId, itemDirectory, writeDeskItem, listDeskItems, syncDeskItems } from '../../src/mc/desk-items.js';
import { deskItemQuestion } from '../../src/mc/desk-items.js';
import { addLesson, lessonsDir, listLessons, renderLesson } from '../../src/mc/desk-lessons.js';

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
function fixture({ root = '/w', plans = {}, queue = '', session, gh = {}, dirty = [], unmerged = [], live = [], areas = {}, conflicts = {}, mergeRefused = [], headFiles = {}, mergeLeft = [], roles = true, livePids = [], now = '2026-08-29T10:00:00Z', runs = null, collect = okCollect, helperTurn = okTurn, inbox = [], projectLog = {}, archive = {}, landed = [], removeFails = [], heads = {}, openPrs = {}, prsFail = [], refs = {}, fetchFails = [], rounds = {}, rebaseFails = [], prFiles = {}, block = {}, commitFails = [], conflicted = [], merged = {}, tips = {}, mergeRows = {}, stopResults = {}, revList = {}, notInMain = [], gateBusy = [], attach = { ok: true, state: 'attached', why: 'reused' }, nightly = async () => ({ at: null, started: [], running: [], waiting: [], stopped: false, done: Promise.resolve([]) }), capacity = null } = {}) {
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
  const calls = { stopped: [], git: [], gh: [], sessions: [], added: [], removed: [], collects: [], turns: [], rm: [], moved: [], rmdirs: [], rmScratch: [], checkouts: [], rounds: [], docsRounds: [], ticks: [], shelved: [], attached: [], sweeps: [] };
  /** `/w/runner/archive/<repo>` — the worktree the runner archives in. */
  const archiveRoot = `${root}/runner/archive`;
  /** `/w/runner/block/<repo>` — and the one it writes a blocked step in. */
  const blockRoot = `${root}/runner/block`;
  // A snapshot of the work root taken inside every session call — the only
  // way to see the files that exist only while a step is in flight.
  const duringSession = [];
  // A scratch directory's mtime, by path; one not named here is as old as `now`.
  const scratchAges = {};
  const sweepAnswer = () => ({ removed: [], kept: [] });
  const sweepHook = { answer: null };
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
    // The end-of-session sweep of this session's exports (scratch.js). What it saw is recorded at the call: the end marker and the
    // finalized log of this session, so a test can say the cleaner ran after both. Answered empty unless a test says otherwise.
    sweepExports: async (scratch) => {
      const marker = JSON.parse(files[`${scratch}/.mc-scratch.json`] || 'null');
      const stem = scratch.split('/').at(-1);
      calls.sweeps.push({ scratch, ended: Boolean(marker?.ended), logged: `/w/runner/log/${stem}.jsonl` in files });
      return sweepHook.answer ? sweepHook.answer(scratch) : sweepAnswer(scratch);
    },
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
    // The full runs' pass, faked: what proves it ran is `calls.ticks` and its row.
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
        // `rev-parse HEAD` of a goal worktree (the progress reading of a build session): by default
        // every reading is a new commit, so a session in an ordinary test is one that made progress.
        // A test of the stop on no progress answers it itself (`noProgressFixture`).
        if (args.join(' ') === 'rev-parse HEAD') return { ok: true, stdout: `moved-${calls.git.length}\n` };
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
  return { deps, files, dirs, scratchAges, log, calls, root, duringSession, sweepHook };
}

test('chores syncs a waiting goal item without adding a run row', async (t) => {
  const runLog='ts\tname\tkind\texit\tseconds\tpr\tturns\tinput\toutput\tcache_read\tcache_write\tsession\tnote\tland_seconds\tmodel\tclass\ttool\teffort\tbilling\tcost\n2026-08-29T09:00:00Z\thelper\thelper\t0\t0\t-\t-\t-\t-\t-\t-\t-\tsuccess,memoro,1-new\t-\t-\t-\t-\t-\t-\t-\n2026-08-29T09:00:00Z\thelper\thelper\t0\t0\t-\t-\t-\t-\t-\t-\t-\tsuccess,memoro-cli,1-new\t-\t-\t-\t-\t-\t-\t-\n';
  const f=fixture({runs:runLog}); const physical=mkdtempSync(join(tmpdir(),'mc-chores-desk-')); t.after(()=>rmSync(physical,{recursive:true,force:true}));
  const env={MC_WORK_ROOT:join(physical,'mc'),MC_HOME:join(physical,'mc-home')}; const home=join(env.MC_WORK_ROOT,'programs');
  const dir=join(home,'alpha','goals','waiting'); mkdirSync(dir,{recursive:true});
  const at='2026-11-14T10:00:00Z'; writeFileSync(join(dir,'GOAL.json'),goalJson({status:'Martin'}));
  writeFileSync(join(dir,'LOG.md'),`## ${at} · person · build · Martin\n\nComment: Martin is asked: Which option?\nOption a: A\nOption b: B\nRecommended: a\n`);
  f.deps.syncDeskItems=()=>syncDeskItems({env,home,now:()=>new Date(at)});
  const before=f.files[`${f.root}/runner/log/runs.tsv`] ?? null;
  const callsBefore=f.calls.sessions.length;
  await createRunner({deps:f.deps}).chores();
  const [item]=listDeskItems({env}); assert.equal(item.reference,'alpha/waiting'); assert.equal(item.state,'new');
  assert.equal(f.files[`${f.root}/runner/log/runs.tsv`] ?? null,before);
  assert.deepEqual(f.calls.sessions.slice(callsBefore),[], 'chores starts no session');
});

test('chores prepares the three oldest items on medium, bounds a round, and waits without a candidate', async (t) => {
  for (const mode of ['three', 'four', 'unavailable']) {
    const root = mkdtempSync(join(tmpdir(), 'mc-prepare-round-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const f = fixture({ root });
    f.deps.env.MC_HOME = join(root, 'mc-home');
    Object.assign(f.deps.env, { MC_GOAL: 'example/parent', MC_PROGRAMME: 'example', MC_ROLE: 'build-session:goal', MC_HEADLESS: '1' });
    const count = mode === 'three' ? 3 : 4;
    const items = Array.from({ length: count }, (_, n) => {
      const at = `2026-08-29T0${n}:00:00Z`;
      return { id: deskItemId('goal', `example/item-${n}`, at), kind: 'goal', reference: `example/item-${n}`, source_at: at, state: 'new' };
    });
    // Sync really precedes preparation; do not seed the store before chores.
    f.deps.syncDeskItems = () => items.toReversed().forEach(item => writeDeskItem(item, { env: f.deps.env }));
    f.deps.catalog = () => ({ ...DEFAULT_CATALOG, medium: [{ tool: 'codex', model: 'gpt-6.1-terra', effort: 'high' }, { tool: 'claude', model: 'sonnet', effort: 'high' }], large: [{ tool: 'claude', model: 'opus', effort: 'medium' }] });
    if (mode === 'unavailable') {
      f.deps.capacity.write(capacityWith({ claude: 1 }));
      f.deps.billing = { readApi: () => ({ claude: false, codex: false }) };
    }
    const calls = [];
    f.deps.deskPrepare = {
      billingRoute: () => ({ billing: 'plan' }),
      session: async call => {
        calls.push(call);
        const item = items.find(item => itemDirectory(item, f.deps.env) === call.cwd);
        assert.ok(item);
        assert.equal(call.env.MC_ROLE, 'desk-prepare'); assert.equal(call.env.MC_HEADLESS, '1');
        for (const name of ['MC_GOAL', 'MC_PROGRAMME', 'MC_STEP']) assert.equal(call.env[name], undefined);
        assert.equal(call.env.MC_TOOL, 'claude'); assert.equal(call.env.MC_MODEL, 'sonnet');
        assert.equal(call.timeoutMs, 15 * 60_000);
        assert.equal(call.args[call.args.indexOf('--model') + 1], 'sonnet');
        assert.equal(call.args[call.args.indexOf('--effort') + 1], 'high');
        const instructions = call.args[call.args.indexOf('--append-system-prompt') + 1];
        assert.ok(instructions.includes(readCanonRole('desk-prepare').overlay));
        assert.equal(call.args.includes('--resume'), false);
        writeFileSync(join(call.cwd, 'prepared.md'), 'Facts with sources.');
        assert.equal(await martinCommand(['item', item.id, 'prepared', '--sort', 'technical'], { env: call.env }), 0);
        return { status: 0, stdout: JSON.stringify({ type: 'result', total_cost_usd: 0.25 }), stderr: '' };
      },
    };
    const runner = createRunner({ deps: f.deps });
    await runner.chores();
    const expected = mode === 'unavailable' ? [] : items.slice(0, 3).map(item => item.id);
    assert.deepEqual(calls.map(call => call.cwd.split('/').at(-1)), expected);
    assert.deepEqual(calls.map(call => [call.env.MC_TOOL, call.env.MC_MODEL]), expected.map(() => ['claude', 'sonnet']), 'first usable medium candidate, never large');
    const rows = String(f.files[runner.paths.runs]).split('\n').map(line => line.split('\t')).filter(row => row[2] === 'desk-prepare');
    assert.deepEqual(rows.map(row => row[1]), expected);
    assert.deepEqual(rows.map(row => row.slice(14, 20)), expected.map(() => ['sonnet', 'medium', 'claude', 'high', 'plan', '0.2500']));
    assert.deepEqual(listDeskItems({ env: f.deps.env, state: 'prepared' }).map(item => item.id), expected);
    assert.deepEqual(listDeskItems({ env: f.deps.env, state: 'new' }).map(item => item.id), items.slice(expected.length).map(item => item.id));
    if (mode === 'four') {
      await runner.runDeskPreparation();
      assert.deepEqual(calls.map(call => call.cwd.split('/').at(-1)), items.map(item => item.id));
    }
  }
});

test('desk ceiling holds a chores round once, ignores other days and kinds, and off restores turns', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mc-prepare-ceiling-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const f = fixture({ root }); f.deps.env.MC_HOME = join(root, 'mc-home');
  const ids = ['a'.repeat(24), 'b'.repeat(24), 'c'.repeat(24)];
  f.deps.syncDeskItems = () => ids.forEach((id, n) => writeDeskItem({ id, state: 'new', source_at: `2026-08-29T0${n}:00:00Z` }, { env: f.deps.env }));
  let calls = 0;
  f.deps.deskPrepare = { billingRoute: () => ({ billing: 'plan' }), session: async call => {
    calls++;
    writeFileSync(join(call.cwd, 'prepared.md'), 'Prepared');
    await martinCommand(['item', call.cwd.split('/').at(-1), 'prepared', '--sort', 'mechanical'], { env: call.env });
    return { status: 0, stdout: '{}', stderr: '' };
  } };
  const runner = createRunner({ deps: f.deps });
  f.files[runner.paths.runs] = 'ts\tkind\tcost\n2026-08-29T01:00:00Z\tdesk-prepare\t2\n2026-08-29T02:00:00Z\tdecision\t3\n2026-08-28T23:59:00Z\tdecision\t100\n2026-08-29T01:00:00Z\tgoal\t100\n';
  f.files[deskSettingsPath(f.deps.env)] = JSON.stringify({ ceiling_usd_per_day: 5 });
  await runner.chores();
  assert.equal(calls, 0);
  assert.equal(f.log.filter(line => line.includes('desk ceiling holds turns')).length, 1);
  assert.deepEqual(deskBudget({ env: f.deps.env, now: f.deps.now(), read: f.deps.read }), { ceiling: 5, spent: 5, day: '2026-08-29', held: true });
  f.files[deskSettingsPath(f.deps.env)] = JSON.stringify({ ceiling_usd_per_day: null });
  await runner.runDeskPreparation();
  assert.equal(calls, 3);
});

/** A learning pass fixture: a real lessons store under a physical root, a fake session, the runner's own clock (2026-08-29T10:00Z). */
function learningFixture(t, { ages = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mc-learning-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const f = fixture({ root }); f.deps.env.MC_HOME = join(root, 'mc-home');
  const calls = [];
  f.deps.deskLearning = {
    launch: () => ({ ok: true, id: 'claude-code', spec: { bin: '/fake/claude' }, adapter: claudeAdapter }),
    billingRoute: () => ({ billing: 'plan' }),
    session: async call => { calls.push(call); return { status: 0, stdout: JSON.stringify({ type: 'result', num_turns: 1, total_cost_usd: 0.5 }), stderr: '' }; },
  };
  const parts = { happened: 'An item reached Martin that was not his.', rule: 'A rule that would have stopped it.', where: 'canon/roles/decision.md' };
  const add = (daysOld, n) => addLesson({ env: f.deps.env, kind: 'wrong-question', parts, by: 'decision', slug: `l${n}`, now: new Date(f.deps.now().getTime() - daysOld * 86_400_000) });
  ages.forEach((age, n) => assert.ok(add(age, n).lesson));
  const rows = runner => String(f.files[runner.paths.runs] ?? '').split('\n').map(line => line.split('\t')).filter(row => row[2] === 'learning');
  return { f, calls, add, rows, root };
}

test('chores starts no learning session with four open lessons, the youngest a day old', async (t) => {
  const l = learningFixture(t, { ages: [1, 2, 3, 4] });
  const runner = createRunner({ deps: l.f.deps });
  await runner.chores();
  assert.deepEqual(l.calls, []);
  assert.deepEqual(l.rows(runner), []);
});

test('chores starts one learning session with five open lessons: its role, headless, the first decision candidate, the lessons directory, a runs row', async (t) => {
  const l = learningFixture(t, { ages: [1, 1, 1, 1, 1] });
  const runner = createRunner({ deps: l.f.deps });
  await runner.chores();
  assert.equal(l.calls.length, 1);
  const [call] = l.calls;
  assert.equal(call.env.MC_ROLE, 'learning'); assert.equal(call.env.MC_HEADLESS, '1');
  assert.deepEqual([call.env.MC_TOOL, call.env.MC_MODEL], [DEFAULT_CATALOG.decision[0].tool, DEFAULT_CATALOG.decision[0].model], 'the first usable decision candidate');
  for (const name of ['MC_GOAL', 'MC_PROGRAMME']) assert.equal(call.env[name], undefined);
  assert.equal(call.cwd, join(l.root, 'martin', 'lessons'));
  assert.ok(call.args[call.args.indexOf('--append-system-prompt') + 1].includes(readCanonRole('learning').overlay), "the role's words");
  assert.deepEqual(l.rows(runner).map(row => [row[1], row[2], row[3]]), [['learning', 'learning', '0']]);
});

test('chores starts one learning session when one lesson is seven days old, and none at six days', async (t) => {
  const young = learningFixture(t, { ages: [6] }), old = learningFixture(t, { ages: [7] });
  await createRunner({ deps: young.f.deps }).chores();
  await createRunner({ deps: old.f.deps }).chores();
  assert.deepEqual([young.calls.length, old.calls.length], [0, 1]);
});

test('a second chores round the same UTC day starts no second learning session, and the next day does', async (t) => {
  const l = learningFixture(t, { ages: [1, 1, 1, 1, 1] });
  const runner = createRunner({ deps: l.f.deps });
  await runner.chores(); await runner.chores();
  assert.equal(l.calls.length, 1);
  const next = createRunner({ deps: { ...l.f.deps, now: () => new Date('2026-08-30T00:05:00Z') } });
  await next.chores();
  assert.equal(l.calls.length, 2);
});

test('a reached desk ceiling starts no learning session, and a reached ceiling is lifted by off', async (t) => {
  const l = learningFixture(t, { ages: [1, 1, 1, 1, 1] });
  const runner = createRunner({ deps: l.f.deps });
  l.f.files[runner.paths.runs] = 'ts\tkind\tcost\n2026-08-29T01:00:00Z\tdecision\t2\n';
  l.f.files[deskSettingsPath(l.f.deps.env)] = JSON.stringify({ ceiling_usd_per_day: 2 });
  await runner.chores();
  assert.deepEqual(l.calls, []);
  l.f.files[deskSettingsPath(l.f.deps.env)] = JSON.stringify({ ceiling_usd_per_day: null });
  await runner.chores();
  assert.equal(l.calls.length, 1);
});

test('chores marks a carried lesson landed with the goal\'s pull request once its goal is done, and opens it again when the goal is dropped', async (t) => {
  const l = learningFixture(t, { ages: [1, 1] });
  const home = join(l.root, 'programs');
  const goalDir = name => { const dir = join(home, 'mc', 'goals', name); mkdirSync(dir, { recursive: true }); return dir; };
  for (const [name, stage] of [['made', 'done'], ['gone', 'dropped']]) {
    writeFileSync(join(goalDir(name), 'GOAL.json'), withGoal(goalJson({ stage, status: 'ready' }), { prs: ['memoro-cli#1501', 'memoro-cli#1507'] }));
    writeFileSync(join(goalDir(name), 'LOG.md'), '');
  }
  const [first, second] = listLessons({ env: l.f.deps.env });
  Object.assign(first, { state: 'in-goal', goal: 'mc/made', carried_at: '2026-08-28T10:00:00Z' });
  Object.assign(second, { state: 'in-goal', goal: 'mc/gone', carried_at: '2026-08-28T10:00:00Z' });
  const dir = lessonsDir(l.f.deps.env);
  for (const lesson of [first, second]) writeFileSync(join(dir, `${lesson.name}.md`), renderLesson(lesson));
  l.f.deps.list = path => { try { return readdirSync(path); } catch { return []; } };
  l.f.deps.read = path => { try { return readFileSync(path, 'utf8'); } catch { return l.f.files[path] ?? null; } };
  await createRunner({ deps: l.f.deps }).chores();
  const after = Object.fromEntries(listLessons({ env: l.f.deps.env }).map(x => [x.goal ?? x.name, x]));
  assert.equal(after['mc/made'].state, 'landed');
  assert.deepEqual([after['mc/made'].landed_at, after['mc/made'].pr], ['2026-08-29T10:00:00.000Z', 'memoro-cli#1507'], "the goal's last registered pull request");
  const reopened = listLessons({ env: l.f.deps.env }).find(x => x.name === second.name);
  assert.deepEqual([reopened.state, reopened.goal], ['open', null]);
});

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
/** The log of a goal a review sent back to build: the build's word, then the review's move to build (a repair is next). */
const rejectedLog = (built = '2026-08-28T09:00Z', rejected = '2026-08-28T10:00Z') => `## ${built} · claude opus · review · ready · by build\n\nDone: gjort\n\n## ${rejected} · claude opus · build · ready · by review\n\nComment: rejected, round 1\n`;
const VERDICT = 'head: memoro abc1234\ncriterion 1: NOT OK — the case is missing\nchange: OK\n';
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
  for (const [name, { stage = 'build', status = 'ready', legacy: old = null, log = '', repos = 'memoro', worktree = true, phase = 1, after = null, prs = [], verdict = null }] of Object.entries(goals)) {
    const text = goalJson({ stage, status, phase, repos: repos.split(',').map((one) => one.trim()), title: name, goal: [], prs });
    const { phase: _phase, stage: _stage, ...legacy } = JSON.parse(text);
    f.files[`${GOALS}/${name}/GOAL.json`] = after === null ? text : `${JSON.stringify({ ...legacy, status: old, after: after ? after.split(',').map((one) => one.trim()) : [] }, null, 2)}\n`;
    f.files[`${GOALS}/${name}/LOG.md`] = log;
    if (verdict !== null) f.files[`${GOALS}/${name}/REVIEW.md`] = verdict;
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

test('the session end: the end marker and finalized logs are written first, then this session\'s own scratch is swept, once', async () => {
  const f = goalFixture({ alpha: {} });
  const events = [];
  const write = f.deps.write;
  f.deps.write = (path, text) => {
    write(path, text);
    if (path.endsWith('.jsonl') && path.includes('/runner/log/')) events.push('finalized logs');
  };
  const writeJson = f.deps.writeJson;
  f.deps.writeJson = (path, value) => {
    writeJson(path, value);
    if (path.endsWith('/.mc-scratch.json') && value.ended) events.push('end marker');
  };
  f.sweepHook.answer = (scratch) => {
    events.push('scoped cleanup');
    const stem = scratch.split('/').at(-1);
    assert.ok(f.files[`/w/runner/log/${stem}.jsonl`], 'finalized log bytes exist before cleanup');
    return { removed: [], kept: [] };
  };
  await createRunner({ deps: f.deps }).pass();
  assert.deepEqual(events, ['end marker', 'finalized logs', 'scoped cleanup']);
  assert.equal(f.calls.sessions.length, 1);
  const scratch = f.calls.sessions[0].env.MC_SCRATCH;
  assert.deepEqual(f.calls.sweeps, [{ scratch, ended: true, logged: true }], 'only this session, after its end marker and its finalized log');
  assert.doesNotMatch(f.files['/w/runner/log/runner.log'], /scratch/u, 'an empty sweep reports nothing');
});

test('a failed session and an interrupted-but-resolved one are swept by the same rule, after their logs', async () => {
  for (const answer of [
    () => ({ status: 1, stdout: '', stderr: 'boom', timedOut: false }),
    () => ({ status: null, stdout: '', stderr: '', timedOut: true }),
  ]) {
    const f = goalFixture({ alpha: {} });
    f.answer = answer;
    await createRunner({ deps: f.deps }).pass();
    const scratch = f.calls.sessions[0].env.MC_SCRATCH;
    assert.deepEqual(f.calls.sweeps, [{ scratch, ended: true, logged: true }]);
  }
});

test('a cleanup that is refused or fails is recorded as cleanup: the session, the goal and the log entries are those of a clean run', async () => {
  const clean = goalFixture({ alpha: {} });
  await createRunner({ deps: clean.deps }).pass();
  for (const failure of [
    { answer: { error: 'sweep exited 1: scratch is busy' } },
    { throws: new Error('spawn E2BIG') },
  ]) {
    const f = goalFixture({ alpha: {} });
    f.sweepHook.answer = failure.throws ? () => { throw failure.throws; } : () => failure.answer;
    await createRunner({ deps: f.deps }).pass();
    assert.deepEqual(goalEntries(f), goalEntries(clean), 'the goal log is the same');
    assert.equal(f.calls.sessions.length, clean.calls.sessions.length, 'the same sessions ran');
    const lines = (fx) => fx.files['/w/runner/log/runner.log'].split('\n').filter((line) => !/scratch/u.test(line));
    assert.deepEqual(lines(f), lines(clean), 'the runner log says the same about the session as a clean run');
    assert.match(f.files['/w/runner/log/runner.log'], /scratch cleanup not completed — .*; its exports stay for the next tidy/u);
  }
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

test('the pressure pass archives a goal done an hour ago, and a refused one stays with its reason', async () => {
  const f = goalFixture({
    fresh: { stage: 'done', log: doneAnHourAgo },
    held: { stage: 'done', log: doneAnHourAgo },
    work: {},
  }, { now: '2026-09-01T10:00:00Z', dirty: ['held'] });
  onDisk(f, 15 * GBYTES);
  assert.ok(f.files[`${GOALS}/fresh/GOAL.json`], 'nothing has run yet');
  await createRunner({ deps: f.deps }).pass();
  assert.equal(f.files[`${GOALS}/fresh/GOAL.json`], undefined, 'archived by the pressure pass');
  assert.equal(goalField(f.files['/w/programs/prog/goals/.archive/fresh/GOAL.json'], 'stage'), 'done');
  assert.equal(goalField(f.files[`${GOALS}/held/GOAL.json`], 'stage'), 'done', 'refused: it stays, and stays done');
  assert.equal(goalField(f.files[`${GOALS}/work/GOAL.json`], 'stage'), 'build', 'a goal not finished is never archived');
  const [archive] = pressureEvents(f)[0].steps;
  assert.deepEqual([archive.name, archive.removed], ['archive', 1]);
  assert.match(archive.kept[0].why, /^not archived — memoro's worktree has uncommitted changes/u);
  assert.match(f.files['/w/runner/log/runner.log'], /fresh: done — archived to \/w\/programs\/prog\/goals\/\.archive\/fresh$/mu);
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
  await createRunner({ deps: f.deps }).chores(); // A fresh runner process reconciles the persisted goal.
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
  const claudeAnswers = [{ ok: false, why: 'login unavailable' }, { ok: true, unread: { five_hour: 'absent' } }, { ok: true, unread: {} }];
  f.deps.refreshClaude = async () => { reads.claude.push(clock); return claudeAnswers[reads.claude.length - 1]; };
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
  const log = () => f.files['/w/runner/log/runner.log'];
  assert.match(log(), /codex capacity read — its subscription windows are noted$/mu, 'the Codex success line is as before');
  assert.match(log(), /claude capacity read — its subscription windows are noted; not read: five_hour \(absent\)$/mu, 'a read that did not validate a window names it');
  clock += 15 * 60 * 1000;
  f.files['/w/runner/UPDATE'] = '';
  timer(); await flush();
  assert.equal(reads.claude.length, 2, 'a pending UPDATE pauses reads');
  assert.ok(timer, 'an UPDATE alone does not stop the ticker: a failed handover keeps polling');
  delete f.files['/w/runner/UPDATE'];
  timer(); await flush();
  assert.equal(reads.claude.length, 3, 'polling resumes once the UPDATE is gone');
  await flush(); await flush();
  const claudeLines = log().split('\n').filter((line) => line.includes('claude capacity'));
  assert.match(claudeLines.at(-1), /claude capacity read — its subscription windows are noted$/u, 'a read that validated both windows carries no note');
  assert.equal(log().split('\n').filter((line) => line.includes('noted; not read:')).length, 1, 'only the read that did not validate a window carries the note');
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

test('Linux direct --once refuses unreadable existing owner state', async () => {
  const f = goalFixture({ a: {} }, { livePids: [7777] });
  f.deps.platform = 'linux';
  f.deps.lifecycleLock = (_root, transition) => transition();
  f.files['/w/runner/runner.json'] = `${JSON.stringify({ pid: 7777, generation: 'G', bootId: 'boot', starttime: '77' })}\n`;
  f.deps.read = (path) => path === '/w/runner/runner.json' ? null : f.files[path] ?? null;

  assert.equal(await runLoop({ once: true, deps: f.deps }), 2);
  assert.deepEqual(f.calls.sessions, [], 'direct one-shot execution started without checking existing ownership');
  assert.ok('/w/runner/runner.json' in f.files, 'unreadable owner state was erased');
  assert.match(f.files['/w/runner/log/runner.log'], /runner\.json is unreadable — refusing Linux runner admission/u);
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

test('a STOP after reserved child publication stays sticky and prevents admission', async () => {
  const f = fixture({ livePids: [4242] });
  const owner = { pid: 4242, generation: 'reserved-g1', bootId: 'boot', starttime: '42', started: '2026-08-29T10:00:00Z' };
  f.files['/w/runner/runner.json'] = `${JSON.stringify(owner)}\n`;
  f.files['/w/runner/STOP'] = 'stopped\n';
  const code = await runLoop({ deps: {
    ...f.deps,
    platform: 'linux',
    identity: () => ({ bootId: 'boot', starttime: '42' }),
    lifecycleLock: (_root, transition) => transition(),
    env: { ...f.deps.env, MC_RUN_RESERVED_GENERATION: owner.generation },
  } });
  assert.equal(code, 2);
  assert.equal(f.files['/w/runner/STOP'], 'stopped\n', 'the reserved child cleared a later STOP');
  assert.equal(f.files['/w/runner/runner.json'], undefined, 'the rejected reservation remains published');
  assert.deepEqual(f.calls.sessions, [], 'a stopped reserved child admitted work');
});

test('a losing reserved child cannot remove a newer explicit owner at admission', async () => {
  const f = fixture();
  const reservation = { pid: 4242, generation: 'reserved-g1', bootId: 'boot', starttime: '42' };
  f.files['/w/runner/runner.json'] = `${JSON.stringify(reservation)}\n`;
  f.files['/w/runner/STOP'] = 'stopped\n';
  let gates = 0;
  const code = await runLoop({ deps: {
    ...f.deps,
    platform: 'linux',
    identity: () => ({ bootId: 'boot', starttime: '42' }),
    lifecycleLock: async (_root, transition) => {
      gates += 1;
      if (gates === 1) {
        f.files['/w/runner/runner.json'] = `${JSON.stringify({ pid: 5252, generation: 'explicit-g2', bootId: 'boot', starttime: '52' })}\n`;
      }
      return transition();
    },
    env: { ...f.deps.env, MC_RUN_RESERVED_GENERATION: reservation.generation },
  } });

  assert.equal(code, 2);
  assert.equal(gates, 1, 'the losing child did not validate under the lifecycle gate');
  assert.deepEqual(JSON.parse(f.files['/w/runner/runner.json']), { pid: 5252, generation: 'explicit-g2', bootId: 'boot', starttime: '52' });
  assert.equal(f.files['/w/runner/STOP'], 'stopped\n', 'the rejected child removed STOP');
  assert.deepEqual(f.calls.sessions, [], 'the rejected child admitted work');
});

test('Linux owner pruning removes only verified dead drainers under the matching generation', async () => {
  const f = fixture();
  f.deps.platform = 'linux';
  f.deps.lifecycleLock = (_root, transition) => transition();
  f.deps.alive = (pid) => Number(pid) === 200 || Number(pid) === 4242;
  f.deps.identity = (pid) => Number(pid) === 4242 ? { bootId: 'boot-c', starttime: '4242' } : null;
  const runner = createRunner({ deps: f.deps });
  const a = { pid: 100, generation: 'A', bootId: 'boot-a', starttime: '100' };
  const b = { pid: 200, generation: 'B' }; // legacy live identity: retain, never guess it dead
  runner.markRunner({ generation: 'C', predecessor: a, drainers: [a, b] });
  await runner.dropPredecessor();
  const current = JSON.parse(f.files['/w/runner/runner.json']);
  assert.deepEqual(current.drainers, [b], 'verified-dead A is pruned while unverifiable live B is preserved');
  assert.equal(current.predecessor, undefined, 'the dead immediate predecessor is not retained');
});

test('Linux C successor retains an A drainer through B and does not claim A’s in-flight work again', async () => {
  const f = goalFixture({ a: {} }, { livePids: [100, 200, 300] });
  f.deps.platform = 'linux';
  f.deps.pid = 300;
  f.deps.identity = (pid) => ({ bootId: 'boot', starttime: String(pid) });
  f.deps.lifecycleLock = (_root, transition) => transition();
  f.deps.env = { ...f.deps.env, MC_RUN_RESERVED_GENERATION: 'C', MC_RUN_SUCCESSOR_OF: '200' };
  const owner = {
    pid: 300, generation: 'C', bootId: 'boot', starttime: '300', takeover: true,
    predecessor: { pid: 200, generation: 'B', bootId: 'boot', starttime: '200' },
    drainers: [{ pid: 100, generation: 'A', bootId: 'boot', starttime: '100' }, { pid: 200, generation: 'B', bootId: 'boot', starttime: '200' }],
  };
  f.files['/w/runner/runner.json'] = `${JSON.stringify(owner)}\n`;
  f.files['/w/runner/current-memoro.json'] = `${JSON.stringify({ name: 'goal:prog/a', pid: 100, lane: 0, generation: 'A', bootId: 'boot', starttime: '100' })}\n`;

  assert.equal(await runLoop({ once: true, deps: f.deps }), 0);

  assert.deepEqual(f.calls.sessions, [], 'C started a goal already in flight under A');
  assert.ok('/w/runner/current-memoro.json' in f.files, 'A’s live session record was removed by C');
  assert.match(f.files['/w/runner/log/runner.log'], /once: nothing to run/u, 'C did not observe the inherited A session');
  assert.deepEqual(JSON.parse(f.files['/w/runner/runner.json']).drainers.map((owner) => owner.generation), ['A', 'B'], 'idle C exit forgot its live draining owners');
});

function linuxLifecycleFixture() {
  const f = fixture({ livePids: [100, 200, 4242, 9001] });
  f.deps.platform = 'linux';
  f.deps.identity = (pid) => ({ bootId: 'boot', starttime: String(pid) });
  f.deps.lifecycleLock = async (_root, transition) => transition();
  return f;
}
const linuxOwner = (pid, generation) => ({ pid, generation, started: null, bootId: 'boot', starttime: String(pid) });

test('Linux runLoop admits once with source checkout HEAD, and tolerates failed or absent HEAD lookup', async () => {
  const checkout = mcCheckout({ exists: () => true });
  const admitted = async ({ gitResult, hasCheckout }) => {
    const f = goalFixture({ a: {} }, { livePids: [4242] });
    f.deps.platform = 'linux';
    f.deps.identity = pid => ({ bootId: 'boot', starttime: String(pid) });
    f.deps.lifecycleLock = async (_root, transition) => transition();
    if (hasCheckout) f.files[`${checkout}/.git`] = '';
    const git = f.deps.git;
    let headLookups = 0;
    f.deps.git = (cwd, args) => cwd === checkout && args.join(' ') === 'rev-parse --short HEAD'
      ? (headLookups += 1, gitResult) : git(cwd, args);
    const owners = [];
    const writeJson = f.deps.writeJson;
    f.deps.writeJson = (path, value) => {
      writeJson(path, value);
      if (path === '/w/runner/runner.json') owners.push(value);
    };
    assert.equal(await runLoop({ once: true, deps: f.deps }), 0);
    assert.equal(f.calls.sessions.length, 1, 'one goal session was admitted');
    assert.equal(owners.length, 1, 'one owner record was published');
    assert.equal(owners[0].pid, 4242);
    assert.equal(owners[0].bootId, 'boot');
    assert.equal(owners[0].starttime, '4242');
    assert.equal(owners[0].commit ?? null, hasCheckout && gitResult?.ok ? String(gitResult.stdout ?? '').trimEnd() || null : null);
    return { f, owners, headLookups };
  };

  const known = await admitted({ gitResult: { ok: true, stdout: '2051d17\n' }, hasCheckout: true });
  assert.equal(known.owners[0].commit, '2051d17');
  assert.equal(known.headLookups, 1, 'the source checkout HEAD was inspected once');
  await admitted({ gitResult: { ok: false, stdout: 'ignored' }, hasCheckout: true });
  const absent = await admitted({ gitResult: { ok: true, stdout: 'must not be read' }, hasCheckout: false });
  assert.equal(absent.headLookups, 0, 'no checkout means no Git inspection');
});

test('Linux real runLoop UPDATE publishes and admits its successor while held work completes', async () => {
  const f = goalFixture({ a: {} }, { livePids: [4242, 9001] });
  let tail = Promise.resolve();
  const gate = (_root, transition) => { const result = tail.then(transition); tail = result.catch(() => {}); return result; };
  Object.assign(f.deps, { platform: 'linux', identity: pid => ({ bootId: 'boot', starttime: String(pid) }), lifecycleLock: gate });
  let finish;
  const finished = new Promise(resolve => { finish = resolve; });
  let started;
  const sessionStarted = new Promise(resolve => { started = resolve; });
  f.answer = async call => { started(); f.files['/w/runner/UPDATE'] = ''; await finished; return okSession()(call); };
  f.deps.sleep = () => new Promise(resolve => setImmediate(resolve));
  let successor, published;
  const write = f.deps.write;
  f.deps.write = (path, value) => { write(path, value); if (path === '/w/runner/runner.json' && JSON.parse(value).pid === 9001) published = JSON.parse(value); };
  f.deps.respawn = ({ env }) => {
    successor = runLoop({ once: true, awake: false, deps: { ...f.deps, pid: 9001, env: { ...f.deps.env, ...env } } });
    successor.finally(finish);
    return 9001;
  };
  const running = runLoop({ deps: f.deps, awake: false });
  await sessionStarted;
  for (let i = 0; i < 100 && !successor; i += 1) await new Promise(resolve => setImmediate(resolve));
  if (!successor) { f.files['/w/runner/STOP'] = ''; finish(); await running; }
  assert.ok(successor, 'real Linux update never spawned a successor');
  assert.equal(await running, 0);
  assert.equal(await successor, 0, 'real Linux handover never admitted its successor');
  assert.equal(published.pid, 9001);
  assert.equal(published.predecessor.pid, 4242);
  assert.deepEqual(published.drainers.map(p => p.pid), [4242]);
  assert.equal(f.calls.sessions.length, 1, 'successor duplicated held work');
});

test('Linux direct --once holds ownership against competing manual and automatic claims', async () => {
  const f = goalFixture({ a: {} }, { livePids: [4242] });
  let tail = Promise.resolve();
  const gate = (_root, transition) => { const result = tail.then(transition); tail = result.catch(() => {}); return result; };
  Object.assign(f.deps, { platform: 'linux', identity: pid => ({ bootId: 'boot', starttime: String(pid) }), lifecycleLock: gate });
  let entered, finish;
  const sessionStarted = new Promise(resolve => { entered = resolve; });
  const sessionEnd = new Promise(resolve => { finish = resolve; });
  f.answer = async call => { entered(); await sessionEnd; return okSession()(call); };
  const direct = runLoop({ once: true, deps: f.deps });
  await sessionStarted;
  const current = f.files['/w/runner/runner.json'];
  assert.equal(await runLoop({ once: true, deps: { ...f.deps, pid: 9001 } }), 2, 'a competing direct --once bypassed ownership');
  let spawned = false;
  const control = { ...f.deps, env: { ...f.deps.env, MC_RUN_SYSTEMD_CONTEXT: 'scope' }, spawn: () => { spawned = true; return 9001; } };
  const [manual, boot] = await Promise.all([startRunner({ root: '/w', deps: control }), startRunner({ root: '/w', argv: ['--if-was-running'], deps: control })]);
  assert.equal(manual.ok, false);
  assert.equal(boot.pid, undefined);
  assert.equal(spawned, false);
  assert.equal(f.files['/w/runner/runner.json'], current);
  finish();
  assert.equal(await direct, 0);
  assert.equal(f.calls.sessions.length, 1);
});

test('Linux STOP after explicit direct claim remains sticky before its first work admission', async () => {
  const f = goalFixture({ a: {} }, { livePids: [4242] });
  Object.assign(f.deps, { platform: 'linux', identity: pid => ({ bootId: 'boot', starttime: String(pid) }) });
  let first = true;
  f.deps.lifecycleLock = async (_root, transition) => {
    const result = transition();
    if (first) { first = false; f.files['/w/runner/STOP'] = 'after claim'; }
    return result;
  };
  assert.equal(await runLoop({ once: true, deps: f.deps }), 0);
  assert.equal(f.files['/w/runner/STOP'], 'after claim');
  assert.deepEqual(f.calls.sessions, [], 'explicit claim erased or ignored a later STOP');
});

test('Linux exit cleanup is gated, keeps lane-less live drainers and leaves later owners untouched', async () => {
  const f = linuxLifecycleFixture();
  const runner = createRunner({ deps: f.deps });
  const a = linuxOwner(100, 'A');
  runner.markRunner({ generation: 'C', drainers: [a] });
  let release;
  f.deps.lifecycleLock = (_root, transition) => new Promise((resolve) => { release = () => resolve(transition()); });
  const exiting = runner.clearRunner();
  assert.equal(typeof release, 'function', 'exit cleanup bypassed the lifecycle gate');
  assert.deepEqual(JSON.parse(f.files['/w/runner/runner.json']).drainers, [a]);
  release(); await exiting;
  assert.deepEqual(JSON.parse(f.files['/w/runner/runner.json']).drainers, [a], 'a lane-less live drainer disappeared when C exited');
  const lateExit = runner.clearRunner();
  const next = linuxOwner(9001, 'D');
  f.files['/w/runner/runner.json'] = JSON.stringify(next);
  f.files['/w/runner/current-memoro.json'] = JSON.stringify({ ...next, lane: 0 });
  release(); await lateExit;
  assert.deepEqual(JSON.parse(f.files['/w/runner/runner.json']), next, 'late C cleanup deleted D');
  assert.deepEqual(JSON.parse(f.files['/w/runner/current-memoro.json']), { ...next, lane: 0 });
});

test('Linux generation loss permanently revokes admission even if the unseen successor is dead', () => {
  const f = linuxLifecycleFixture();
  const runner = createRunner({ deps: f.deps });
  runner.markRunner({ generation: 'A' });
  const original = f.files['/w/runner/runner.json'];
  f.files['/w/runner/runner.json'] = JSON.stringify(linuxOwner(7777, 'C'));
  assert.equal(runner.updateRequested(), true, 'A became entitled again because unseen C had died');
  f.files['/w/runner/runner.json'] = original;
  assert.equal(runner.updateRequested(), true, 'restoring an old record restored lost authority');
});

test('Linux missing or corrupt state never restores an admitted owner’s authority', () => {
  for (const value of [undefined, '{broken']) {
    const f = linuxLifecycleFixture();
    const runner = createRunner({ deps: f.deps });
    runner.markRunner({ generation: 'A' });
    if (value === undefined) delete f.files['/w/runner/runner.json'];
    else f.files['/w/runner/runner.json'] = value;
    assert.equal(runner.updateRequested(), true, 'loss of ownership state reopened admission');
  }
});

test('Linux rejected reserved child retains live drainers under STOP without admitting work', async () => {
  const f = linuxLifecycleFixture();
  const a = linuxOwner(100, 'A');
  f.files['/w/runner/runner.json'] = JSON.stringify({ ...linuxOwner(4242, 'C'), drainers: [a] });
  f.files['/w/runner/STOP'] = 'later stop';
  f.deps.env.MC_RUN_RESERVED_GENERATION = 'C';
  assert.equal(await runLoop({ once: true, deps: f.deps }), 2);
  assert.deepEqual(JSON.parse(f.files['/w/runner/runner.json'] || 'null')?.drainers, [a], 'STOP rejection forgot A');
  assert.equal(f.files['/w/runner/STOP'], 'later stop');
  assert.deepEqual(f.calls.sessions, []);
});

test('Linux direct claim over a dead newest owner inherits drainers and preserves live foreign current files', async () => {
  const f = linuxLifecycleFixture();
  const a = linuxOwner(100, 'A');
  const current = { ...a, name: 'goal:fixture/held', lane: 0 };
  f.files['/w/runner/runner.json'] = JSON.stringify({ ...linuxOwner(7777, 'C'), drainers: [a] });
  f.files['/w/runner/current-memoro.json'] = JSON.stringify(current);
  assert.equal(await runLoop({ once: true, deps: f.deps }), 0);
  assert.deepEqual(JSON.parse(f.files['/w/runner/runner.json']).drainers, [a]);
  assert.deepEqual(JSON.parse(f.files['/w/runner/current-memoro.json'] || 'null'), current, 'claim erased unrelated live lane');
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

/* ------------------------------------------------------- the full runs */

/**
 * The full runs are the last thing a chore pass does, and they follow main
 * (Martin, 2026-11-15): every pass asks (`fullRunTick`), whatever the clock says
 * about the last pass, and starts the repositories whose main moved, with the
 * map that keeps one run per repository across passes, and does not wait for the
 * runs. A row goes in runs.tsv only for a pass that started one, as the record
 * of what the pass did and not as a gate; STOP is asked before it, and the runs
 * in flight are ended before the runner leaves.
 */
const NIGHTLY_HEADER = 'ts\tname\tkind\texit\tseconds\tpr\tturns\tinput\toutput\tcache_read\tcache_write\tsession\tnote\n';
const nightlyRowAt = (ts) => `${ts}\tnightly\tnightly\t0\t1\t-\t-\t-\t-\t-\t-\t-\tstarted,memoro\n`;

test('a chore pass asks for the full runs a minute after a pass that started one: no day gate', async () => {
  const f = fixture({
    now: '2026-08-29T10:00:00Z',
    runs: NIGHTLY_HEADER + nightlyRowAt('2026-08-29T09:59:00Z'),
    nightly: async () => ({ started: [{ repo: 'memoro', why: 'main moved to bbbbbbb since the measurement of aaaaaaa' }], running: [], waiting: [], stopped: false, done: Promise.resolve([]) }),
  });
  await createRunner({ deps: f.deps }).chores();
  assert.equal(f.calls.ticks.length, 1, 'the pass asked, though the last row is a minute old');
  assert.equal(typeof f.calls.ticks[0].shouldStop, 'function');
  assert.ok(f.calls.ticks[0].running instanceof Map);
  const rows = runRows(f.files).filter((r) => r.kind === 'nightly');
  assert.deepEqual(rows.slice(1).map((row) => ({ name: row.name, exit: row.exit, pr: row.pr, note: row.note })),
    [{ name: 'nightly', exit: '0', pr: '-', note: 'started,memoro' }], 'the row is the record of the pass that started a run');
});

test('every chore pass asks for the full runs again, whether or not the last one started any', async () => {
  const f = fixture({ nightly: async () => ({ started: [], running: [], waiting: [{ repo: 'memoro', why: 'main is still aaaaaaa' }], stopped: false, done: Promise.resolve([]) }) });
  const runner = createRunner({ deps: f.deps });
  await runner.chores();
  await runner.chores();
  assert.equal(f.calls.ticks.length, 2);
  assert.deepEqual(runRows(f.files).filter((r) => r.kind === 'nightly'), [], 'a pass that started nothing writes no row');
});

test('a pass that started nothing writes no row', async () => {
  const f = fixture({ nightly: async () => ({ started: [], running: ['memoro'], waiting: [], stopped: false, done: Promise.resolve([]) }) });
  await createRunner({ deps: f.deps }).chores();
  assert.equal(f.calls.ticks.length, 1);
  assert.deepEqual(runRows(f.files).filter((r) => r.kind === 'nightly'), []);
});

test('a STOP file means no full run: the suite is never started', async () => {
  const f = fixture({});
  f.files['/w/runner/STOP'] = '';
  await round(createRunner({ deps: f.deps }));
  assert.equal(f.calls.ticks.length, 0);
  assert.deepEqual(runRows(f.files).filter((r) => r.kind === 'nightly'), []);
});

test('a pass that throws is a failed row', async () => {
  const f = fixture({ nightly: async () => { throw new Error('disk full'); } });
  const runner = createRunner({ deps: f.deps });
  await runner.chores();
  const rows = runRows(f.files).filter((r) => r.kind === 'nightly');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].exit, '1');
  assert.equal(rows[0].note, 'tick-failed,disk full');
});

test('the runs in flight are ended through their signal before the runner leaves', async () => {
  let release = null;
  const f = fixture({
    nightly: async ({ running, signal }) => {
      const run = new Promise((resolve) => { release = resolve; signal.addEventListener('abort', () => resolve([]), { once: true }); });
      running.set('/home/memoro', run);
      return { started: [{ repo: 'memoro', why: 'never measured' }], running: [], waiting: [], stopped: false, done: run };
    },
  });
  const runner = createRunner({ deps: f.deps });
  await runner.chores();
  const [{ signal, running }] = f.calls.ticks;
  assert.equal(signal.aborted, false, 'the chore pass did not wait for the run');
  await runner.settleFullRuns();
  assert.equal(signal.aborted, true);
  assert.equal(typeof release, 'function');
  assert.equal(running.size, 1, 'the map is the pass\'s to empty, not the runner\'s');
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

test('a medium build launches its first usable medium candidate and never falls back when that list is empty', async () => {
  const f = goalFixture({ medium: {} });
  f.files[`${GOALS}/medium/GOAL.json`] = withGoal(f.files[`${GOALS}/medium/GOAL.json`], { class: 'medium' });
  f.deps.catalog = () => ({ ...structuredClone(DEFAULT_CATALOG),
    fast: [{ tool: 'claude', model: 'haiku', effort: 'high' }],
    medium: [{ tool: 'claude', model: 'sonnet', effort: 'high' }, { tool: 'codex', model: 'gpt-6.1-terra', effort: 'high' }],
    large: [{ tool: 'claude', model: 'opus', effort: 'medium' }],
  });
  await createRunner({ deps: f.deps }).pass({ repo: 'memoro' });
  assert.equal(f.calls.sessions.length, 1);
  assert.deepEqual([f.calls.sessions[0].env.MC_TOOL, f.calls.sessions[0].env.MC_MODEL, runRows(f.files).at(-1).effort],
    ['claude', 'sonnet', 'high']);

  const empty = goalFixture({ medium: {} });
  empty.files[`${GOALS}/medium/GOAL.json`] = withGoal(empty.files[`${GOALS}/medium/GOAL.json`], { class: 'medium' });
  empty.deps.catalog = () => ({ ...structuredClone(DEFAULT_CATALOG),
    fast: [{ tool: 'claude', model: 'haiku', effort: 'high' }], medium: [],
    large: [{ tool: 'claude', model: 'opus', effort: 'medium' }],
  });
  assert.equal((await createRunner({ deps: empty.deps }).pass({ repo: 'memoro' })).ran, 0);
  assert.equal(empty.calls.sessions.length, 0, 'an empty medium list waits, not launch on fast or large');
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

test('three build sessions without a log entry leave the goal in build for Martin', async () => {
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
  assert.equal(where(), 'build · Martin');
  assert.match(entries().at(-1).comment, /^three sessions ended without a word — see the logs under runner\/log$/u);

  assert.equal((await runner.pass({ repo: 'memoro' })).ran, 0);
  assert.equal(f.calls.sessions.length, 3);
  assert.equal(runRows(f.files).length, 3);
});

/* ------------------------------------------------ build sessions without progress (the runner's stop) */

/**
 * A goal `stuck` in build whose worktree HEAD the test moves: `f.heads.stuck` is what `rev-parse HEAD` answers there,
 * `f.headsUnreadable` makes it fail. A build session is `builds(f, { commit, meet })`: it says its piece with a Next,
 * and commits (moves HEAD) or meets the criterion when told to.
 */
function noProgressFixture() {
  const f = goalFixture({ stuck: { log: goalLog('2026-08-20T10:00Z') } });
  f.heads = { stuck: 0 };
  f.headsUnreadable = false;
  const git = f.deps.git;
  f.deps.git = (cwd, args) => {
    if (cwd === `${GOALS}/stuck/memoro` && args.join(' ') === 'rev-parse HEAD') {
      return f.headsUnreadable ? { ok: false, stdout: '', stderr: 'fatal: not a git repository' } : { ok: true, stdout: `head-${f.heads.stuck}\n` };
    }
    return git(cwd, args);
  };
  return f;
}
const builds = (f, { commit = false, meet = false, inner = okSession() } = {}) => (call) => {
  if (commit) f.heads.stuck += 1;
  if (meet) f.files[`${GOALS}/stuck/GOAL.json`] = withGoal(f.files[`${GOALS}/stuck/GOAL.json`], { success_criteria: [{ criterion: 'it works', check: 'a test', met: true }] });
  f.files[`${GOALS}/stuck/LOG.md`] = `${f.files[`${GOALS}/stuck/LOG.md`]}\n## 2026-08-29T10:00Z · claude opus · build · ready\n\nDone: arbete\nNext: next ${f.calls.sessions.length}\n`;
  return inner(call);
};
const silentSession = () => ({ status: 1, stdout: '', stderr: '', timedOut: false });
const stuckEntries = (f) => parseLog(f.files[`${GOALS}/stuck/LOG.md`]);
const stuckWhere = (f) => ['stage', 'status'].map((key) => goalField(f.files[`${GOALS}/stuck/GOAL.json`], key)).join(' · ');
const stuckPass = async (f, answer) => { f.answer = answer; return createRunner({ deps: f.deps }).pass({ repo: 'memoro' }); };
const noProgressEntries = (f) => stuckEntries(f).filter((entry) => entry.tool === 'runner' && /^no progress this session/u.test(entry.comment));

test('three build sessions that meet nothing and commit nothing stop the goal with one entry the desk reads, and no fourth starts', async () => {
  const f = noProgressFixture();
  for (const n of [1, 2]) {
    await stuckPass(f, builds(f));
    assert.equal(stuckWhere(f), 'build · ready');
    assert.equal(noProgressEntries(f).length, n);
  }
  assert.match(noProgressEntries(f)[1].comment, /^no progress this session \(2 of 3\): met 0 of 1 criteria, heads memoro head-0 unchanged$/u);
  await stuckPass(f, builds(f));
  assert.equal(stuckWhere(f), 'build · Martin');
  const stop = stuckEntries(f).at(-1);
  assert.deepEqual([stop.tool, stop.stage, stop.status], ['runner', 'build', 'Martin']);
  assert.equal(noProgressEntries(f).length, 2, 'the third is the stop, not another no-progress entry');
  assert.deepEqual(stop.comment.split('\n'), [
    'no progress: three build sessions in a row met no criterion and committed nothing',
    'Heads: memoro head-0',
    'Criteria: met 0 of 1 criteria',
    'Last Next: next 3',
  ]);
  const before = f.calls.sessions.length;
  assert.equal((await stuckPass(f, builds(f))).ran, 0, 'a goal that reads Martin is not picked');
  assert.equal(f.calls.sessions.length, before, 'no fourth session');
  // Every entry of this log shares one minute with the stop: the desk still reads the stop's line.
  assert.equal(stuckEntries(f).filter((entry) => entry.at === stop.at).length > 1, true, 'the stop shares its minute with another entry');
  const item = { kind: 'goal', reference: 'prog/stuck', source_at: stop.at };
  assert.equal(deskItemQuestion(item, { home: '/w/programs', read: (path) => f.files[path] ?? null }), 'no progress: three build sessions in a row met no criterion and committed nothing');
});

test('a session that commits or meets a criterion, and any change of stage or status, starts the no-progress count again', async () => {
  const f = noProgressFixture();
  await stuckPass(f, builds(f));
  await stuckPass(f, builds(f));
  await stuckPass(f, builds(f, { commit: true }));
  assert.equal(stuckEntries(f).at(-1).tool, 'runner');
  assert.match(stuckEntries(f).at(-1).comment, /^progress again: met 0 of 1 criteria \(0 before\), heads memoro head-1 /u);
  await stuckPass(f, builds(f));
  await stuckPass(f, builds(f, { meet: true }));
  assert.match(stuckEntries(f).at(-1).comment, /^progress again: met 1 of 1 criteria \(0 before\)/u);
  await stuckPass(f, builds(f));
  await stuckPass(f, builds(f));
  assert.equal(stuckWhere(f), 'build · ready', 'two since the last progress are not three');
  // A change of status between them starts it again: Martin, then ready, by a person.
  f.files[`${GOALS}/stuck/LOG.md`] += '\n## 2026-08-29T10:00Z · person · build · Martin\n\nComment: looked at it\n\n## 2026-08-29T10:00Z · person · build · ready\n\nComment: amended\n';
  await stuckPass(f, builds(f));
  await stuckPass(f, builds(f));
  assert.equal(stuckWhere(f), 'build · ready');
  assert.equal(noProgressEntries(f).length, 7);
  await stuckPass(f, builds(f));
  assert.equal(stuckWhere(f), 'build · Martin', 'the third since the last change stops it');
});

test('sessions without a log entry are skipped by the no-progress count, and the no-progress entries are skipped by the three-silent rule', async () => {
  const f = noProgressFixture();
  await stuckPass(f, builds(f));
  await stuckPass(f, silentSession);
  await stuckPass(f, builds(f));
  await stuckPass(f, silentSession);
  assert.equal(stuckWhere(f), 'build · ready', 'two no-progress sessions with a silent one between are not three');
  await stuckPass(f, builds(f));
  assert.equal(stuckWhere(f), 'build · Martin', 'no-progress, silent, no-progress, silent, no-progress stops it');

  const g = noProgressFixture();
  await stuckPass(g, builds(g));
  await stuckPass(g, silentSession);
  await stuckPass(g, silentSession);
  assert.equal(stuckWhere(g), 'build · ready', 'a no-progress session followed by two silent ones does not stop');
  await stuckPass(g, silentSession);
  assert.equal(stuckWhere(g), 'build · Martin', 'three silent sessions with nothing between still stop');
});

test('a quota or offline ending and a HEAD that cannot be read are not counted, and do not start the count again', async () => {
  const f = noProgressFixture();
  let clock = Date.parse('2026-11-07T12:00:00Z');
  f.deps.now = () => new Date(clock);
  const pass = async (answer) => { clock += 3_600_000; f.deps.capacity.write(capacityWith({ claude: 0.1 })); return stuckPass(f, answer); };
  await pass(builds(f));
  await pass(builds(f));
  const runnerEntries = () => stuckEntries(f).filter((entry) => entry.tool === 'runner').length;
  const had = runnerEntries();
  await pass(builds(f, { inner: REFUSED_429 }));
  assert.equal(runnerEntries(), had, 'a quota ending writes no runner entry');
  await pass(builds(f, { inner: UNREACHABLE }));
  assert.equal(runnerEntries(), had, 'an offline ending writes no runner entry');
  f.headsUnreadable = true;
  await pass(builds(f));
  assert.equal(stuckWhere(f), 'build · ready');
  assert.match(stuckEntries(f).at(-1).comment, /^session not counted for progress: HEAD of memoro cannot be read \(fatal: not a git repository\)$/u);
  assert.equal(noProgressEntries(f).length, 2);
  f.headsUnreadable = false;
  await pass(builds(f));
  assert.equal(stuckWhere(f), 'build · Martin', 'the third counted session stops it: none of those between was counted or started the count');
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

test('a session that started before the offline hold ends without clearing it; one started after the hold clears it', async t => {
  const f = goalFixture({ a: {}, b: {} });
  let clock = Date.parse('2026-11-07T12:00:00Z');
  f.deps.now = () => new Date(clock);
  let release;
  const held = new Promise(resolve => { release = resolve; });
  f.answer = async call => {
    const name = call.env.MC_GOAL.split('/')[1];
    if (name === 'a' && f.calls.sessions.length === 1) {
      await held;
      return logsItself(f, 'a')(call);
    }
    return UNREACHABLE(call);
  };
  t.after(() => { f.files['/w/runner/STOP'] = ''; release(); });
  const runner = createRunner({ deps: f.deps });
  const runnerLog = () => f.files['/w/runner/log/runner.log'] || '';
  const holdLines = () => runnerLog().split('\n').filter(line => /API server cannot be reached|API answers again|started before the offline hold was set/u.test(line));

  const first = runner.pass({ repo: 'memoro', lane: 0 });
  await turns();
  assert.equal(f.calls.sessions.length, 1, 'lane 0 has started a and is held open');
  clock += 1_000;
  assert.equal((await runner.pass({ repo: 'memoro', lane: 1 })).ran, 1, 'lane 1 ends b offline');
  assert.equal(f.calls.sessions.length, 2);
  assert.equal(holdLines().filter(line => /\(n=1, 60 s\)$/u.test(line)).length, 1);

  release();
  await first;
  assert.equal(holdLines().filter(line => /API answers again/u.test(line)).length, 0);
  assert.equal(holdLines().filter(line => /started before the offline hold was set — its ending does not clear the hold/u.test(line)).length, 1);
  const count = f.calls.sessions.length;
  clock += 30_000;
  assert.equal((await runner.pass({ repo: 'memoro', lane: 0 })).ran, 0);
  assert.equal(f.calls.sessions.length, count, 'a tick inside the hold launches nothing');

  clock = Date.parse('2026-11-07T12:01:01Z');
  assert.equal((await runner.pass({ repo: 'memoro', lane: 0 })).ran, 1);
  assert.equal(f.calls.sessions.length, count + 1);
  assert.equal(holdLines().filter(line => /\(n=2, 120 s\)$/u.test(line)).length, 1, 'the count was not reset by the older session');

  clock = Date.parse('2026-11-07T12:03:02Z');
  f.answer = logsItself(f, 'a');
  assert.equal((await runner.pass({ repo: 'memoro', lane: 0 })).ran, 1);
  assert.equal(holdLines().filter(line => /API answers again/u.test(line)).length, 1);
  assert.equal((await runner.pass({ repo: 'memoro', lane: 0 })).ran, 1, 'the next tick launches at once');
});

/* ------------------------------------------------------- archive a finished goal */

/** A goal's one entry, made by a session, with the status it set. */
const finishedLog = (at, stage) => `## ${at} · claude opus · ${stage} · ready\n\nDone: arbete\n`;
const ARCHIVE_NOW = '2026-09-01T10:00:00Z';

test('the chores archive every finished goal at their pass, however recent, and a goal without a stage timestamp too', async (t) => {
  const f = goalFixture({
    late: { stage: 'done', log: finishedLog('2026-08-31T10:00Z', 'done') },
    early: { stage: 'done', log: finishedLog('2026-09-01T09:59Z', 'done') },
    'hand-set': { stage: 'done', log: '' },
    open: {},
    'dropped-one': { stage: 'dropped', log: '' },
  }, { now: ARCHIVE_NOW });
  let at = performance.now();
  const runner = createRunner({ deps: f.deps });
  const firstStartupMs = performance.now() - at;
  at = performance.now();
  await runner.chores();
  const firstRoundMs = performance.now() - at;
  at = performance.now();
  const restarted = createRunner({ deps: f.deps });
  const restartStartupMs = performance.now() - at;
  at = performance.now();
  await restarted.chores(); // A new runner instance reconciles the persisted dropped goal after restart.
  const restartRoundMs = performance.now() - at;
  t.diagnostic(`fixture timing: startup ${firstStartupMs.toFixed(3)} ms; archive round ${firstRoundMs.toFixed(3)} ms; restart startup ${restartStartupMs.toFixed(3)} ms; restart archive round ${restartRoundMs.toFixed(3)} ms`);
  assert.equal(f.files[`${GOALS}/late/GOAL.json`], undefined, 'the goal left the goals');
  assert.equal(goalField(f.files['/w/programs/prog/goals/.archive/late/GOAL.json'], 'stage'), 'done', 'in goals/.archive/');
  assert.equal(f.files[`${GOALS}/late/memoro`], undefined, 'its worktree is gone with it');
  assert.ok(f.calls.git.some((call) => call[0] === '/home/memoro' && call.slice(1).join(' ') === `worktree remove ${GOALS}/late/memoro`), 'removed through git');
  assert.ok(f.calls.git.some((call) => call[0] === '/home/memoro' && call.slice(1).join(' ') === 'branch -D goal/late'), 'its branch is deleted through git');
  assert.match(f.files['/w/programs/prog/goals/goal_log.md'], /^\| 2026-09-01 \| late \| done \|/mu, 'one row in goal_log.md');
  assert.match(f.files['/w/programs/prog/goals/goal_log.md'], /^\| 2026-09-01 \| dropped-one \| dropped \|/mu, 'a dropped goal the same');
  assert.equal((f.files['/w/programs/prog/goals/goal_log.md'].match(/dropped-one/gu) ?? []).length, 1, 'repeat reconciliation does not duplicate archive history');
  assert.equal(f.files[`${GOALS}/early/GOAL.json`], undefined, 'done a minute ago: archived at the same pass, no hold');
  assert.equal(f.files[`${GOALS}/hand-set/GOAL.json`], undefined, 'a done goal whose log does not say when: archived too');
  assert.equal(goalField(f.files[`${GOALS}/open/GOAL.json`], 'stage'), 'build', 'a goal not finished stays');
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

test('a finished goal a live session owns is left at the pass with no log entry, and archived at the pass after the session ends', async () => {
  const f = goalFixture({
    owned: { stage: 'done', log: finishedLog('2026-09-01T09:59Z', 'done') },
    free: { stage: 'done', log: finishedLog('2026-09-01T09:59Z', 'done') },
  }, { now: ARCHIVE_NOW });
  f.deps.alive = (pid) => pid === 4242;
  f.files['/w/runner/current-memoro.json'] = JSON.stringify({ name: 'goal:prog/owned', pid: 4242, lane: 0 });
  const runner = createRunner({ deps: f.deps });
  await runner.chores();
  assert.equal(f.files[`${GOALS}/free/GOAL.json`], undefined, 'the goal no session owns is archived');
  assert.equal(goalField(f.files[`${GOALS}/owned/GOAL.json`], 'stage'), 'done', 'the owned one stays');
  assert.equal(f.files[`${GOALS}/owned/LOG.md`].match(/runner/gu), null, 'and nothing is written into its log');
  assert.ok(!/owned: .*not archived/u.test(f.files['/w/runner/log/runner.log'] ?? ''), 'nor said in the runner log');
  assert.ok(f.calls.git.every((call) => !call.join(' ').includes('goal/owned')), 'its branch and worktrees are not touched');
  delete f.files['/w/runner/current-memoro.json'];
  await runner.chores();
  assert.equal(f.files[`${GOALS}/owned/GOAL.json`], undefined, 'the session ended: archived at the next pass');
  assert.equal(goalField(f.files['/w/programs/prog/goals/.archive/owned/GOAL.json'], 'stage'), 'done');
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

test('only a build routes on the goal\'s class: finish, mend and plan run on their own lists, never on fast, in the goal\'s worktree', async () => {
  const HAIKU_ONLY = { ...structuredClone(DEFAULT_CATALOG), fast: [{ tool: 'claude', model: 'haiku', effort: 'high' }] };
  // repair (the finish list): opus high / sol high; mend: sonnet medium / sol medium (DEFAULT_CATALOG), whichever has room.
  for (const [stage, role, claudeModel] of [['repair', 'build-session:goal', 'opus'], ['merge', 'mend-session', 'sonnet']]) {
    for (const tool of ['claude', 'codex']) {
      const f = goalFixture({ stuck: stage === 'merge' ? { stage, log: redMerge } : { stage: 'build', verdict: VERDICT, log: rejectedLog() } });
      f.files[`${GOALS}/stuck/GOAL.json`] = withGoal(f.files[`${GOALS}/stuck/GOAL.json`], { class: 'fast' });
      f.deps.catalog = () => structuredClone(HAIKU_ONLY);
      let capacity = capacityWith({ claude: tool === 'claude' ? 0.1 : 0.9 });
      capacity = applyObservation(capacity, 'codex', {
        windows: { primary: windowAt(tool === 'codex' ? 0.1 : 0.9) },
        models: [{ id: 'gpt-6.1-sol', efforts: ['high', 'medium'] }],
      }, ROUTING_NOW);
      f.deps.capacity.write(capacity);
      const launch = f.deps.launch;
      f.deps.launch = (tool) => {
        const selected = launch(tool);
        if (tool === 'codex') selected.adapter.effortArgs = codexEffortArgs;
        return selected;
      };
      f.answer = plans(f, 'stuck', stage === 'repair' ? 'review' : stage, 'blocked');
      const result = await createRunner({ deps: f.deps }).pass({ repo: 'memoro' });
      assert.equal(result.ran, 1, `${stage} on ${tool}`);
      const [call] = f.calls.sessions;
      assert.equal(call.env.MC_ROLE, role);
      assert.equal(call.env.MC_MODEL, tool === 'claude' ? claudeModel : 'gpt-6.1-sol', `${stage} on a fast goal is not haiku`);
      assert.equal(call.env.MC_TOOL, tool);
      assert.equal(call.cwd, `${GOALS}/stuck/memoro`, 'in the goal\'s worktree, not the programme directory');
      assert.deepEqual([call.env.MC_REPO, call.env.MC_WORKAREA], ['memoro', `${GOALS}/stuck/memoro`]);
      assert.equal('MC_PLAN_REASON' in call.env, false, 'no headless plan reason any more');
    }
  }
  const planned = goalFixture({ a: { stage: 'draft' } });
  planned.files[`${GOALS}/a/GOAL.json`] = withGoal(planned.files[`${GOALS}/a/GOAL.json`], { class: 'fast' });
  planned.deps.catalog = () => structuredClone(HAIKU_ONLY);
  planned.deps.capacity.write(capacityWith({ claude: 0.1 }));
  await createRunner({ deps: planned.deps }).pass();
  assert.deepEqual([planned.calls.sessions[0].env.MC_ROLE, planned.calls.sessions[0].env.MC_MODEL], ['plan', 'opus'], 'next-draft planning runs on the plan list');
  const built = goalFixture({ b: { stage: 'build' } });
  built.files[`${GOALS}/b/GOAL.json`] = withGoal(built.files[`${GOALS}/b/GOAL.json`], { class: 'fast' });
  built.deps.catalog = () => structuredClone(HAIKU_ONLY);
  built.deps.capacity.write(capacityWith({ claude: 0.1 }));
  await createRunner({ deps: built.deps }).pass({ repo: 'memoro' });
  assert.equal(built.calls.sessions[0].env.MC_MODEL, 'haiku', 'a build still follows its class');
});

test('a repair whose finish list has no usable subscription never borrows a class: its own API reserve, or it waits', async () => {
  const f = goalFixture({ stuck: { stage: 'build', verdict: VERDICT, log: rejectedLog() } });
  f.files[`${GOALS}/stuck/GOAL.json`] = withGoal(f.files[`${GOALS}/stuck/GOAL.json`], { class: 'fast' });
  f.deps.catalog = () => ({ ...structuredClone(DEFAULT_CATALOG), finish: [{ tool: 'codex', model: 'gpt-6.1-sol', effort: 'high' }] });
  f.deps.capacity.write(capacityWith({ claude: 0.1 }));
  f.answer = plans(f, 'stuck', 'review');
  assert.equal((await createRunner({ deps: f.deps }).pass({ repo: 'memoro' })).ran, 1);
  assert.deepEqual([f.calls.sessions[0].env.MC_TOOL, f.calls.sessions[0].env.MC_MODEL], ['codex', 'gpt-6.1-sol'], 'the repair\'s own reserve, though haiku has room');
  const off = goalFixture({ stuck: { stage: 'build', verdict: VERDICT, log: rejectedLog() } });
  off.files[`${GOALS}/stuck/GOAL.json`] = withGoal(off.files[`${GOALS}/stuck/GOAL.json`], { class: 'fast' });
  off.deps.catalog = f.deps.catalog;
  off.deps.capacity.write(capacityWith({ claude: 0.1 }));
  off.deps.billing = { ...off.deps.billing, readApi: () => ({ claude: true, codex: false }) };
  assert.equal((await createRunner({ deps: off.deps }).pass({ repo: 'memoro' })).ran, 0);
  assert.equal(off.calls.sessions.length, 0, 'with its API off it waits; no session on haiku');
});

test('a rejected goal in build starts one repair session: the build role, in the goal\'s worktree, told to read REVIEW.md and the NOT OK ids', async () => {
  const f = goalFixture({ stuck: { stage: 'build', verdict: VERDICT, log: rejectedLog() } });
  const repair = plans(f, 'stuck', 'review');
  f.answer = (call) => {
    call.onSpawn?.(98765);
    assert.equal(JSON.parse(f.files['/w/runner/current-memoro-1.json']).session_pid, 98765);
    return repair(call);
  };
  const runner = createRunner({ deps: f.deps });
  const r = await runner.pass({ repo: 'memoro', lane: 1 });
  assert.equal(r.ran, 1);
  assert.equal(r.name, 'goal:prog/stuck');
  const [call] = f.calls.sessions;
  assert.equal(call.env.MC_ROLE, 'build-session:goal');
  assert.equal(call.env.MC_HEADLESS, '1');
  assert.equal(call.env.MC_GOAL, 'prog/stuck');
  assert.equal(call.cwd, `${GOALS}/stuck/memoro`, 'in the goal\'s worktree');
  assert.equal(call.env.MC_WORKAREA, `${GOALS}/stuck/memoro`);
  assert.equal('MC_REVIEW_HEAD' in call.env, false);
  assert.match(call.prompt, /This is a repair build\. Read \/w\/programs\/prog\/goals\/stuck\/REVIEW\.md\. The NOT OK items are:\ncriterion 1: NOT OK — the case is missing/u);
  assert.doesNotMatch(call.prompt, /change: OK/u, 'only the NOT OK ids');
  const during = JSON.parse(f.duringSession[0]['/w/runner/current-memoro-1.json']);
  assert.deepEqual([during.name, during.kind, during.variant], ['goal:prog/stuck', 'repair', null]);
  assert.equal(runRows(f.files)[0].kind, 'repair');
  assert.equal(where(f, 'stuck'), 'review · ready');
  assert.equal((await runner.pass({ repo: 'memoro' })).ran, 0, 'the repair ended in review: nothing more starts for a build');
});

test('a goal in finish · ready returns to build with a log entry before any session; REVIEW.md makes it a repair, its absence an ordinary build', async () => {
  const withReview = goalFixture({ stuck: { stage: 'finish', verdict: VERDICT, log: '## 2026-08-28T10:00Z · codex sol · finish · ready\n\nDone: review\n' } });
  withReview.answer = (call) => { withReview.seenWhere = where(withReview, 'stuck'); return plans(withReview, 'stuck', 'review')(call); };
  await createRunner({ deps: withReview.deps }).pass({ repo: 'memoro' });
  assert.equal(withReview.seenWhere, 'build · ready', 'already in build when the session starts');
  const entries = goalEntries(withReview, 'stuck');
  assert.deepEqual([entries.at(-2).tool, entries.at(-2).stage, entries.at(-2).status], ['runner', 'build', 'ready']);
  assert.match(entries.at(-2).comment, /in finish, a stage no session is started on any more — returns to build to repair what REVIEW\.md names/u);
  assert.equal(withReview.calls.sessions[0].env.MC_ROLE, 'build-session:goal');
  assert.match(withReview.calls.sessions[0].prompt, /This is a repair build/u);
  assert.equal(runRows(withReview.files)[0].kind, 'repair');

  const old = goalFixture({ stuck: { stage: 'finish', verdict: 'Found: it is slow.\n', log: '## 2026-08-28T10:00Z · codex sol · finish · ready\n\nDone: review\n' } });
  old.answer = plans(old, 'stuck', 'review');
  await createRunner({ deps: old.deps }).pass({ repo: 'memoro' });
  assert.match(old.calls.sessions[0].prompt, /REVIEW\.md is in the old form or holds no item ids\./u);

  const without = goalFixture({ stuck: { stage: 'finish', log: '## 2026-08-28T10:00Z · codex sol · finish · ready\n\nDone: gone\n' } });
  without.answer = plans(without, 'stuck', 'review');
  await createRunner({ deps: without.deps }).pass({ repo: 'memoro' });
  assert.equal(goalEntries(without, 'stuck').at(-2).comment, 'in finish, a stage no session is started on any more — returns to build');
  assert.equal(without.calls.sessions[0].env.MC_ROLE, 'build-session:goal');
  assert.doesNotMatch(without.calls.sessions[0].prompt, /repair build/u, 'no REVIEW.md: an ordinary build');
  assert.equal(runRows(without.files)[0].kind, 'build-goal', 'an ordinary goal build, not a repair');
});

test('one runner applies changed provider priority to finish and mend launches', async () => {
  const f = goalFixture({ stuck: { stage: 'build', verdict: VERDICT, log: rejectedLog() } });
  let priority = 'codex';
  f.deps.catalog = () => ({ ...DEFAULT_CATALOG, providerPriority: priority });
  let capacity = capacityWith({ claude: 0.1 });
  capacity = applyObservation(capacity, 'codex', { windows: { primary: windowAt(0.9) }, models: [{ id: 'gpt-6.1-sol', efforts: ['high'] }] }, ROUTING_NOW);
  f.deps.capacity.write(capacity);
  const runner = createRunner({ deps: f.deps });
  await runner.pass({ repo: 'memoro' });
  assert.deepEqual([f.calls.sessions.at(-1).env.MC_ROLE, f.calls.sessions.at(-1).env.MC_TOOL, f.calls.sessions.at(-1).env.MC_MODEL], ['build-session:goal', 'codex', 'gpt-6.1-sol']);
  f.files[`${GOALS}/stuck/GOAL.json`] = withGoal(f.files[`${GOALS}/stuck/GOAL.json`], { stage: 'build', status: 'blocked' });
  priority = 'claude';
  assert.equal((await runner.pass({ repo: 'memoro' })).ran, 0, 'legacy blocked work migrates without launching');
  assert.equal(where(f, 'stuck'), 'build · Martin');
  assert.equal(f.calls.sessions.length, 1);
});

test('a repair that moves the goal to review leaves it to the review: the runner adds no entry and starts no build after it', async () => {
  const f = goalFixture({ stuck: { stage: 'build', verdict: VERDICT, log: rejectedLog() } });
  f.answer = plans(f, 'stuck', 'review');
  const runner = createRunner({ deps: f.deps });
  await runner.pass({ repo: 'memoro' });
  assert.equal(where(f, 'stuck'), 'review · ready');
  assert.equal(parseLog(f.files[`${GOALS}/stuck/LOG.md`]).at(-1).tool, 'claude', 'no runner entry after it');
  assert.equal(f.calls.sessions.length, 1);
});

test('a red in merge starts mend; completed ready recovery stays ready even before queue restoration', async () => {
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
  g.deps.pendingMerges = () => [{ repo: 'memoro', pr: 31, state: 'red' }];
  g.answer = plans(g, 'red', 'merge');
  await createRunner({ deps: g.deps }).pass({ repo: 'memoro' });
  assert.equal(where(g, 'red'), 'merge · ready', 'a completed repair does not become a new failure');
  assert.equal((await createRunner({ deps: g.deps }).pass({ repo: 'memoro' })).ran, 0,
    'ready recovery is delivered, not mended again');
  assert.deepEqual(g.calls.rounds.map(({ repo, pr }) => [repo, pr]), [['memoro', 31]],
    'the prior red queue entry is replaced by delivery of the repaired goal');
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
  assert.deepEqual(['first', 'second', 'third', 'judged'].map((name) => [goalField(f.files[`${GOALS}/${name}/GOAL.json`], 'phase'), where(f, name)]), [[1, 'build · Martin'], [2, 'build · ready'], [3, 'build · ready'], [1, 'review · ready']]);
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

test('a merged pull request with no landed entry is not queued again, and the goal is done', async () => {
  const f = goalFixture({ outside: { stage: 'merge', prs: ['memoro#1', 'memoro#2'] } });
  const states = { 1: 'MERGED', 2: 'OPEN' };
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
  assert.deepEqual(f.calls.rounds.map(({ repo, pr }) => [repo, pr]), [['memoro', 2]]);
  assert.deepEqual(asked, [1, 2], 'one state call per pull request per pass');
  assert.equal(where(f, 'outside'), 'merge · ready', 'the other pull request is open');
  assert.ok(f.log.some((line) => line.includes('prog/outside: memoro#1 already merged — not queued')));

  states[2] = 'MERGED';
  f.deps.now = () => new Date('2026-08-29T10:06:00Z');
  await runner.pass({ repo: 'memoro' });
  assert.deepEqual(f.calls.rounds.map(({ repo, pr }) => [repo, pr]), [['memoro', 2]], 'no additional round');
  assert.deepEqual(asked, [1, 2, 1, 2]);
  assert.equal(where(f, 'outside'), 'done · ready');
  assert.equal(parseLog(f.files[`${GOALS}/outside/LOG.md`]).at(-1).done, 'landed memoro#1, memoro#2');
});

test('a goal whose every pull request is closed without merging is set merge · Martin once, with the closed ones named, and nothing further is written', async () => {
  const f = goalFixture({ shut: { stage: 'merge', prs: ['memoro#1', 'memoro#2'] } });
  const gh = f.deps.gh;
  f.deps.gh = (cwd, args) => (args[0] === 'pr' && args[1] === 'view' && args.at(-1) === 'state'
    ? { ok: true, stdout: '{"state":"CLOSED"}' } : gh(cwd, args));
  const runner = createRunner({ deps: f.deps });
  await runner.pass({ repo: 'memoro' });
  const firstState = where(f, 'shut');
  const entries = parseLog(f.files[`${GOALS}/shut/LOG.md`]);
  const said = f.log.filter((line) => line.includes('prog/shut:'));
  const before = [f.files[`${GOALS}/shut/GOAL.json`], f.files[`${GOALS}/shut/LOG.md`]];

  f.deps.now = () => new Date('2026-08-29T10:06:00Z');
  await runner.pass({ repo: 'memoro' });
  assert.equal(firstState, 'merge · Martin', `first-pass state; runner said across both passes: ${f.log.filter((line) => line.includes('prog/shut:')).join('\n')}`);
  assert.deepEqual(entries.map(({ tool, stage, status }) => [tool, stage, status]), [['runner', 'merge', 'Martin']]);
  assert.equal(entries.at(-1).comment, 'every pull request closed without merging: memoro#1, memoro#2 — nothing to land; a person opens a new one (mc goal pr) and sets it ready, or drops the goal');
  assert.deepEqual(f.calls.rounds, []);
  assert.equal(said.length, 1, 'the state entry says it, not the recovery loop');
  assert.deepEqual([f.files[`${GOALS}/shut/GOAL.json`], f.files[`${GOALS}/shut/LOG.md`]], before, 'both files byte-identical');
  assert.deepEqual(f.log.filter((line) => line.includes('prog/shut:')), said, 'nothing further said');

  // One additional settle pass checks the boundary; the other repository's
  // lane leaves these goals' session-owned stages/statuses alone.
  const boundaries = [
    ['open', 'merge', 'ready', ['CLOSED', 'OPEN']],
    ['unknown', 'merge', 'ready', ['CLOSED', null]],
    ['building', 'build', 'ready', ['CLOSED', 'CLOSED']],
    ['blocked', 'merge', 'blocked', ['CLOSED', 'CLOSED']],
    ['already', 'merge', 'Martin', ['CLOSED', 'CLOSED']],
    ['empty', 'merge', 'ready', []],
  ];
  const states = {};
  const other = goalFixture(Object.fromEntries(boundaries.map(([name, stage, status, answers], index) => {
    const prs = answers.map((state, i) => {
      const pr = 10 + index * 2 + i;
      states[pr] = state;
      return `memoro#${pr}`;
    });
    return [name, { stage, status, prs }];
  })));
  const otherGh = other.deps.gh;
  other.deps.gh = (cwd, args) => (args[0] === 'pr' && args[1] === 'view' && args.at(-1) === 'state'
    ? { ok: true, stdout: JSON.stringify({ state: states[args[2]] }) } : otherGh(cwd, args));
  const unchanged = boundaries.map(([name]) => [other.files[`${GOALS}/${name}/GOAL.json`], other.files[`${GOALS}/${name}/LOG.md`]]);
  await createRunner({ deps: other.deps }).pass({ repo: 'memoro-cli' });
  assert.deepEqual(boundaries.map(([name]) => [other.files[`${GOALS}/${name}/GOAL.json`], other.files[`${GOALS}/${name}/LOG.md`]]), unchanged);
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

test('a repair session on a goal with no worktree makes the goal\'s worktree before it starts, and no planning checkout', async () => {
  const f = goalFixture({ stuck: { stage: 'build', worktree: false, verdict: VERDICT, log: rejectedLog() } });
  noBranches(f);
  f.dirs.add('/home/memoro');
  const adds = sessionsAtAdd(f);
  assert.equal((await createRunner({ deps: f.deps }).pass({ repo: 'memoro' })).ran, 1);
  const goalAdd = adds.find((add) => add.path === `${GOALS}/stuck/memoro`);
  assert.deepEqual(goalAdd?.args, ['worktree', 'add', '-q', '-b', 'goal/stuck', `${GOALS}/stuck/memoro`, 'origin/main']);
  assert.equal(goalAdd.sessionsBefore, 0);
  assert.equal(adds.some((add) => add.path === '/w/programs/prog/memoro'), false, 'the runner makes no plan/<programme> checkout: mc plan does');
  assert.equal(f.calls.sessions[0].cwd, `${GOALS}/stuck/memoro`, 'the repair session stands in the goal\'s worktree');
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

/** A review session that decides, as `mc goal stage merge|build` does: its one-line entry and the stage; a move to build is a rejection, with REVIEW.md left. */
const judges = (f, stage, inner = okSession()) => (call) => {
  const path = `${GOALS}/judged/LOG.md`;
  f.files[path] = `${f.files[path]}\n## 2026-08-29T10:00Z · claude opus · ${stage} · ready${stage === 'build' ? ' · by review' : ''}\n\nDone: ${stage}; proposals/2026-08-29-mc-x.md\n`;
  if (stage === 'build') f.files[`${GOALS}/judged/REVIEW.md`] = VERDICT;
  f.files[`${GOALS}/judged/GOAL.json`] = withGoal(f.files[`${GOALS}/judged/GOAL.json`], { stage, status: 'ready' });
  return inner(call);
};
const goalEntries = (f, name = 'judged') => parseLog(f.files[`${GOALS}/${name}/LOG.md`]);

test('a review releases its lane after merge handoff so the next assignment can start', async () => {
  for (const stage of ['review']) {
    const f = reviewFixture({ goals: { next: {} } });
    f.files[`${GOALS}/judged/GOAL.json`] = withGoal(f.files[`${GOALS}/judged/GOAL.json`], { stage, prs: ['memoro#31'] });
    f.files[`${GOALS}/judged/REVIEW.md`] = `head: memoro ${HEAD}\ncriterion 1: OK\n`;
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
  f.deps.catalog = () => ({ ...structuredClone(DEFAULT_CATALOG), review: [DEFAULT_CATALOG.review[0]] });
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
  assert.ok(f.log.some((line) => /review starting .* review list: preferred \(review candidate 2 — codex gpt-6\.1-sol built it\)/u.test(line)));
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

test('a review that sends the goal to build hands it to one repair session, never to a second review first', async () => {
  const f = reviewFixture();
  f.answer = judges(f, 'build');
  const runner = createRunner({ deps: f.deps });
  await runner.pass({ repo: 'memoro' });
  assert.equal(where(f, 'judged'), 'build · ready');
  assert.ok(f.files[`${GOALS}/judged/REVIEW.md`], 'REVIEW.md is left');
  f.answer = plans(f, 'judged', 'review');
  assert.equal((await runner.pass({ repo: 'memoro' })).ran, 1);
  const repair = f.calls.sessions.at(-1);
  assert.equal(repair.env.MC_ROLE, 'build-session:goal');
  assert.match(repair.prompt, /This is a repair build/u);
  assert.deepEqual(f.calls.sessions.map((call) => call.env.MC_ROLE), ['review-session:goal', 'build-session:goal']);
  assert.equal(runRows(f.files).at(-1).kind, 'repair');
});

test('a review that dies leaves review · ready and a review runs again; a second that dies waits on Martin', async () => {
  const f = reviewFixture();
  f.answer = () => ({ status: 1, stdout: '', stderr: '', timedOut: false });
  const runner = createRunner({ deps: f.deps });
  await runner.pass({ repo: 'memoro' });
  assert.equal(where(f, 'judged'), 'review · ready');
  assert.match(goalEntries(f).at(-1).comment, /^the review ended with the goal still in review — a review runs again$/u);
  assert.equal((await runner.pass({ repo: 'memoro' })).ran, 1);
  assert.equal(f.calls.sessions.at(-1).env.MC_ROLE, 'review-session:goal');
  assert.equal(where(f, 'judged'), 'review · Martin');
  assert.match(goalEntries(f).at(-1).comment, /a second time — review recovery cannot continue$/u);
  assert.equal((await runner.pass({ repo: 'memoro' })).ran, 0);
  assert.equal(f.calls.sessions.length, 2);
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

test('a review on a dirty goal worktree starts no session: the goal is review · Martin, its reason naming the worktree and the changed paths; clean, it is reviewed', async () => {
  const f = reviewFixture();
  f.answer = judges(f, 'merge');
  const worktree = `${GOALS}/judged/memoro`;
  const tree = dirtyTree(f, worktree, [' M src/mc/runner-lock.js', '?? probe.js']);
  const runner = createRunner({ deps: f.deps });
  await runner.pass({ repo: 'memoro' });
  assert.equal(f.calls.sessions.length, 0, 'no session of any kind starts on the dirty tree');
  assert.equal(where(f, 'judged'), 'review · Martin');
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

test('a review without a pull request returns once to build, then stops for Martin; a review entry resets the count', async () => {
  const f = reviewFixture({ pr: null });
  const runner = createRunner({ deps: f.deps });
  const ready = () => { f.files[`${GOALS}/judged/GOAL.json`] = withGoal(f.files[`${GOALS}/judged/GOAL.json`], { stage: 'review', status: 'ready' }); };
  await runner.pass({ repo: 'memoro' });
  assert.equal(f.calls.sessions.filter((call) => call.env.MC_ROLE === 'review-session:goal').length, 0);
  assert.equal(where(f, 'judged'), 'build · ready');
  assert.match(goalEntries(f).at(-1).comment, /^in review without an open pull request/u);
  ready();
  await runner.pass({ repo: 'memoro' });
  assert.equal(where(f, 'judged'), 'review · Martin');
  assert.match(goalEntries(f).at(-1).comment, /second time/u);
  f.files[`${GOALS}/judged/LOG.md`] += '\n## 2026-08-29T10:00Z · codex model · review · ready · by review\n\nDone: reviewed\n';
  ready();
  await runner.pass({ repo: 'memoro' });
  assert.equal(where(f, 'judged'), 'build · ready');
});

test('a review after a rejection is told the first review\'s heads and failed items; the first review, and one after an old-form REVIEW.md, is not', async () => {
  const prompts = [];
  for (const verdict of [VERDICT, null, 'Found: the page is slow.\n']) {
    const f = reviewFixture({ log: verdict === null ? builtBy('codex gpt-6.1-sol') : `${rejectedLog()}\n${builtBy('codex gpt-6.1-sol')}` });
    if (verdict !== null) f.files[`${GOALS}/judged/REVIEW.md`] = verdict;
    await createRunner({ deps: f.deps }).pass({ repo: 'memoro' });
    prompts.push(f.calls.sessions.find((call) => call.env.MC_ROLE === 'review-session:goal').prompt);
  }
  assert.match(prompts[0], /The previous review judged:\nhead: memoro abc1234\nIts NOT OK items:\ncriterion 1: NOT OK — the case is missing/u);
  assert.doesNotMatch(prompts[1], /previous review/u, 'a first review is a whole review');
  assert.doesNotMatch(prompts[2], /previous review/u, 'an old REVIEW.md without a head line gives a whole review');
});

test('a goal a person moved to merge and back after a rejection is not a repair: it is built as any build, on its class', async () => {
  const moved = `${rejectedLog()}\n## 2026-08-28T11:00Z · person · merge · ready\n\nDone: merged by hand\n\n## 2026-08-28T12:00Z · person · build · ready\n\nDone: back to build\n`;
  const f = goalFixture({ stuck: { stage: 'build', verdict: VERDICT, log: moved } });
  f.answer = plans(f, 'stuck', 'review');
  await createRunner({ deps: f.deps }).pass({ repo: 'memoro' });
  assert.equal(f.calls.sessions[0].env.MC_ROLE, 'build-session:goal');
  assert.doesNotMatch(f.calls.sessions[0].prompt, /repair build/u);
  assert.equal(runRows(f.files)[0].kind, 'build-goal');
  const plain = goalFixture({ stuck: { stage: 'build', log: '## 2026-08-28T09:00Z · claude opus · build · ready\n\nDone: begun\n' } });
  plain.answer = plans(plain, 'stuck', 'review');
  await createRunner({ deps: plain.deps }).pass({ repo: 'memoro' });
  assert.equal(runRows(plain.files)[0].kind, 'build-goal', 'a build with no rejection is routed on its class');
});

/* The untouched areas the branch changed, listed in the review prompt by the function the move out of review checks with. */
const OPS_AREAS = (paths, more = [], seen = false) => JSON.stringify({ schema_version: 1, areas: [{ id: 'ops', name: 'Operations', covers: 'deploys', standards: ['docs/technical/ops.md'], paths, questions: [{ when: 'always', ask: 'Does anything deploy?' }], ...(seen ? { seen: true } : {}) }, ...more] });
function trippedReview({ repos = ['memoro'], obligations, paths = { memoro: ['src/ops'] }, diffs = {}, sources = [], seen = false }) {
  const f = reviewFixture();
  f.files[`${GOALS}/judged/GOAL.json`] = goalJsonV2({ stage: 'review', repos, obligations });
  for (const repo of repos.slice(1)) f.dirs.add(`${GOALS}/judged/${repo}`);
  const base = f.deps.git;
  f.deps.git = (cwd, args) => {
    const repo = repos.find((one) => cwd === `${GOALS}/judged/${one}`);
    if (repo && args[0] === 'show' && args[1] === 'origin/main:.mc/areas.json') return { ok: true, stdout: OPS_AREAS(paths[repo] ?? [], sources, seen) };
    if (repo && args[0] === 'diff') return { ok: true, stdout: (diffs[repo] ?? []).join('\n') };
    if (repo && repo !== repos[0] && args[0] === 'rev-parse' && args[1] === 'HEAD') return { ok: true, stdout: 'second0head\n' };
    return base(cwd, args);
  };
  return f;
}
const untouchedOps = (repo) => ({ area: `${repo}/ops`, stand: 'untouched', text: 'Nothing deploys.' });
const reviewPrompt = async (f) => {
  await createRunner({ deps: f.deps }).pass({ repo: 'memoro' });
  if (!f.calls.sessions.length) throw new Error(`no session: ${f.log.join(' | ')}`);
  return f.calls.sessions.find((call) => call.env.MC_ROLE === 'review-session:goal').prompt;
};

test('the review prompt lists an untouched area a diff file is under, with the file, and none for a diff that touches no such path', async () => {
  const hit = await reviewPrompt(trippedReview({ obligations: [untouchedOps('memoro')], diffs: { memoro: ['src/ops/deploy.js', 'src/other.js'] } }));
  assert.match(hit, /write an `untouched <area>` line for each:\nmemoro\/ops: src\/ops\/deploy\.js\b(?!, src\/other)/u);
  const miss = await reviewPrompt(trippedReview({ obligations: [untouchedOps('memoro')], diffs: { memoro: ['src/other.js', 'README.md'] } }));
  assert.doesNotMatch(miss, /write an `untouched <area>` line/u);
});

test('a source area with a diff file under its paths is not in the review prompt\'s list, also when the goal holds an older untouched stand on it', async () => {
  const games = { id: 'games', name: 'Games', covers: 'the games', standards: [], paths: ['src/games'], questions: [], page: 'docs/areas/games.md' };
  const prompt = await reviewPrompt(trippedReview({
    obligations: [untouchedOps('memoro'), { area: 'memoro/games', stand: 'untouched', text: 'An older stand.' }], sources: [games],
    diffs: { memoro: ['src/ops/deploy.js', 'src/games/play.js'] },
  }));
  assert.match(prompt, /write an `untouched <area>` line for each:\nmemoro\/ops: src\/ops\/deploy\.js\n/u);
  assert.doesNotMatch(prompt, /memoro\/games: /u);
});

test('a file under a touched area\'s paths is not listed; a second repository\'s file under an untouched area is', async () => {
  const touched = await reviewPrompt(trippedReview({
    obligations: [{ area: 'memoro/ops', stand: 'touched', text: 'It deploys.', standard: 'memoro/docs/technical/ops.md#Deploy' }],
    diffs: { memoro: ['src/ops/deploy.js'] },
  }));
  assert.doesNotMatch(touched, /write an `untouched <area>` line/u);
  const two = await reviewPrompt(trippedReview({
    repos: ['memoro', 'memoro-cli'], obligations: [untouchedOps('memoro-cli')], paths: { memoro: ['src/ops'], 'memoro-cli': ['lib/ops'] },
    diffs: { memoro: ['src/ops/own.js'], 'memoro-cli': ['lib/ops/other.js'] },
  }));
  assert.match(two, /memoro-cli\/ops: lib\/ops\/other\.js/u);
  assert.doesNotMatch(two, /^memoro\/ops: /mu);
});

test('the prompt\'s list of tripped areas and the move out of review\'s check come from one function', async () => {
  const f = trippedReview({ obligations: [untouchedOps('memoro')], diffs: { memoro: ['src/ops/deploy.js'] } });
  const prompt = await reviewPrompt(f);
  const goal = parseGoal(f.files[`${GOALS}/judged/GOAL.json`]);
  const found = trippedAreas({ goal, dir: `${GOALS}/judged`, head: HEAD, git: f.deps.git, exists: () => true });
  assert.deepEqual(found.tripped, [{ area: 'memoro/ops', repo: 'memoro', files: ['src/ops/deploy.js'] }]);
  assert.ok(prompt.includes(`${found.tripped[0].area}: ${found.tripped[0].files.join(', ')}`), 'the prompt lists what the function returns');
  // The move to merge asks the same function: without the line it names the area the prompt listed.
  f.files[`${GOALS}/judged/REVIEW.md`] = `head: memoro ${HEAD}\ncriterion 1: OK\n`;
  const out = [];
  const rc = await goalCommand(['stage', 'merge'], {
    ...f.deps, env: { ...f.calls.sessions.find((call) => call.env.MC_ROLE === 'review-session:goal').env }, home: '/w/programs', known: () => ['/home/memoro'],
    stdout: { write() {} }, stderr: { write: (text) => out.push(text) }, queue: () => {},
  });
  assert.equal(rc, 2, out.join(''));
  assert.match(out.join(''), /no line for untouched memoro\/ops/u);
});

/* The areas judged as the user sees it: one list, asked once at the launch, in the prompt and in MC_REVIEW_SEEN. */
const touchedOps = (repo) => ({ area: `${repo}/ops`, stand: 'touched', text: 'It deploys.', standard: `${repo}/docs/technical/ops.md#Deploy` });
const reviewSession = (f) => f.calls.sessions.find((call) => call.env.MC_ROLE === 'review-session:goal');

test('a review of a goal touched on an area that declares seen is told to write a seen line for it, and MC_REVIEW_SEEN names the same area; an untouched area the branch changed is listed too', async () => {
  const f = trippedReview({ seen: true, obligations: [touchedOps('memoro')], diffs: { memoro: ['src/ops/deploy.js'] } });
  const prompt = await reviewPrompt(f);
  assert.match(prompt, /judged as the user sees it; write a `seen <area>` line for each/u);
  assert.match(prompt, /seen memoro\/ops: OK — shots\/<name>\.png/u);
  assert.equal(reviewSession(f).env.MC_REVIEW_SEEN, 'memoro/ops');
  const tripped = trippedReview({ seen: true, obligations: [untouchedOps('memoro')], diffs: { memoro: ['src/ops/deploy.js'] } });
  const trippedPrompt = await reviewPrompt(tripped);
  assert.match(trippedPrompt, /write an `untouched <area>` line for each:\nmemoro\/ops: src\/ops\/deploy\.js/u);
  assert.match(trippedPrompt, /seen memoro\/ops: OK/u);
  assert.equal(reviewSession(tripped).env.MC_REVIEW_SEEN, 'memoro/ops');
});

test('a review with no area that declares seen, or whose stand on it asks none, has no seen text in its prompt and no MC_REVIEW_SEEN key', async () => {
  for (const f of [
    trippedReview({ obligations: [touchedOps('memoro')], diffs: { memoro: ['src/ops/deploy.js'] } }),
    trippedReview({ seen: true, obligations: [untouchedOps('memoro')], diffs: { memoro: ['src/other.js'] } }),
    trippedReview({ seen: true, obligations: [{ area: 'memoro/other', stand: 'untouched', text: 'x' }], diffs: {} }),
  ]) {
    const prompt = await reviewPrompt(f);
    assert.doesNotMatch(prompt, /judged as the user sees it|`seen <area>`|seen memoro\/ops/u);
    assert.equal('MC_REVIEW_SEEN' in reviewSession(f).env, false);
  }
});

test('the prompt\'s seen areas, the session\'s MC_REVIEW_SEEN and the move out of review\'s check come from one list: the env handed to the move refuses a missing seen line and asks none without it', async () => {
  const f = trippedReview({ seen: true, obligations: [touchedOps('memoro')], diffs: { memoro: ['src/ops/deploy.js'] } });
  const prompt = await reviewPrompt(f);
  const goal = parseGoal(f.files[`${GOALS}/judged/GOAL.json`]);
  const found = seenAreas({ goal, dir: `${GOALS}/judged`, tripped: [], git: f.deps.git, exists: () => true });
  assert.deepEqual(found.seen, ['memoro/ops']);
  assert.ok(prompt.includes(`seen ${found.seen[0]}: OK`), 'the prompt names what the function returns');
  assert.equal(reviewSession(f).env.MC_REVIEW_SEEN, found.seen.join(' '));
  const verdict = `head: memoro ${HEAD}\ncriterion 1: OK\nV1: OK\nobligation memoro/ops: OK\nchange: OK\nout-of-scope: OK\nprotection: OK\nbugs: OK\n`;
  const move = async (env) => {
    const out = [];
    const rc = await goalCommand(['stage', 'merge'], { ...f.deps, env, home: '/w/programs', known: () => ['/home/memoro'], stdout: { write() {} }, stderr: { write: (text) => out.push(text) }, queue: () => {} });
    return { rc, text: out.join('') };
  };
  f.files[`${GOALS}/judged/REVIEW.md`] = verdict;
  const env = { ...reviewSession(f).env };
  const refused = await move(env);
  assert.equal(refused.rc, 2, refused.text);
  assert.match(refused.text, /no line for seen memoro\/ops/u);
  const { MC_REVIEW_SEEN, ...without } = env;
  assert.doesNotMatch((await move(without)).text, /seen memoro\/ops/u, 'a review started without the list is asked none');
});

/* The write-back line: asked of a version 2 goal's review when its programme has a record; the prompt and MC_REVIEW_WRITE_BACK say the same. */
test('a review of a version 2 goal whose programme has a record is told to write the write-back line and carries MC_REVIEW_WRITE_BACK; the move out of review asks for it', async () => {
  const f = trippedReview({ obligations: [touchedOps('memoro')], diffs: { memoro: ['src/ops/deploy.js'] } });
  f.files[`${PROG}/PROGRAMME.json`] = plainText();
  const prompt = await reviewPrompt(f);
  assert.match(prompt, /holds one `write-back` line/u);
  assert.match(prompt, /write-back: OK — <repo>\/docs\/technical\/<page>\.md § <section>/u);
  assert.match(prompt, /write-back: OK — none — <reason>/u);
  assert.match(prompt, /write-back: NOT OK — <what the goal made true that no page says>/u);
  assert.equal(reviewSession(f).env.MC_REVIEW_WRITE_BACK, '1');
  const verdict = `head: memoro ${HEAD}\ncriterion 1: OK\nV1: OK\nobligation memoro/ops: OK\nchange: OK\nout-of-scope: OK\nprotection: OK\nbugs: OK\n`;
  f.files[`${GOALS}/judged/REVIEW.md`] = verdict;
  const out = [];
  const rc = await goalCommand(['stage', 'merge'], { ...f.deps, env: { ...reviewSession(f).env }, home: '/w/programs', known: () => ['/home/memoro'], stdout: { write() {} }, stderr: { write: (text) => out.push(text) }, queue: () => {} });
  assert.equal(rc, 2, out.join(''));
  assert.match(out.join(''), /no line for write-back/u, 'the move asks what the launch said');
});

test('a review of a goal whose programme has no record, or a version 1 goal is told nothing of write-back and has no MC_REVIEW_WRITE_BACK', async () => {
  const none = trippedReview({ obligations: [touchedOps('memoro')], diffs: {} });
  const v1 = reviewFixture();
  v1.files[`${PROG}/PROGRAMME.json`] = plainText();
  for (const f of [none, v1]) {
    const prompt = await reviewPrompt(f);
    assert.doesNotMatch(prompt, /write-back/u);
    assert.equal('MC_REVIEW_WRITE_BACK' in reviewSession(f).env, false);
  }
});

/* ---------------------------------------------------------------- no loop */

test('a goal driven through a red review, a red merge and a moved head reaches merge · blocked in six sessions, its stage going back only by a review\'s rejection', async () => {
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
  // 2. The review is red: build, with REVIEW.md.
  f.answer = judges(f, 'build');
  await runner.pass({ repo: 'memoro' }); note();
  // 3. The repair build fixes and publishes: review again.
  f.answer = plans(f, 'judged', 'review');
  await runner.pass({ repo: 'memoro' }); note();
  // 3b. The second review is green: merge, queued.
  f.answer = (call) => { line = [{ repo: 'memoro', pr: 31, state: 'queued' }]; return judges(f, 'merge')(call); };
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

  assert.deepEqual(seen, ['review · ready', 'build · ready', 'review · ready', 'merge · ready', 'merge · ready', 'merge · ready', 'merge · blocked']);
  const stages = parseLog(f.files[`${GOALS}/judged/LOG.md`]).map((entry) => entry.stage).filter(Boolean);
  for (let i = 1; i < stages.length; i += 1) assert.ok(rank(stages[i]) >= rank(stages[i - 1]) || (stages[i - 1] === 'review' && stages[i] === 'build'), `${stages[i - 1]} → ${stages[i]} goes back`);
  assert.deepEqual(f.calls.sessions.map((call) => call.env.MC_ROLE), ['build-session:goal', 'review-session:goal', 'build-session:goal', 'review-session:goal', 'mend-session', 'mend-session'], 'a repair and two mends; the one step back is the review\'s rejection');
});

test('legacy pre-merge blocks migrate to Martin; a queued merge block never relaunches', async () => {
  for (const stage of ['draft', 'build', 'review', 'finish']) {
    const f = goalFixture({ stuck: { stage, status: 'blocked' } });
    const runner = createRunner({ deps: f.deps });
    assert.equal((await runner.pass({ repo: 'memoro' })).ran, 0, stage);
    assert.equal(f.calls.sessions.length, 0, 'no diagnostic session');
    assert.equal(where(f, 'stuck'), `${stage} · Martin`, stage);
    assert.match(goalEntries(f, 'stuck').at(-1).comment, /legacy .* reconciled to Martin; existing obstacle and evidence are retained above/u);
  }
  const queued = goalFixture({ stuck: { stage: 'merge', status: 'blocked' } });
  queued.files[`${GOALS}/stuck/GOAL.json`] = withGoal(queued.files[`${GOALS}/stuck/GOAL.json`], { prs: ['memoro#31'] });
  queued.deps.pendingMerges = () => [{ repo: 'memoro', pr: 31, state: 'queued' }];
  assert.equal((await createRunner({ deps: queued.deps }).pass({ repo: 'memoro' })).ran, 0);
  assert.equal(queued.calls.sessions.length, 0, 'queued PR remains merger-owned');
  assert.equal(where(queued, 'stuck'), 'merge · blocked');
});

test('a legacy blocked build waits on Martin without another session', async () => {
  const f = goalFixture({ stuck: { status: 'blocked' } });
  const runner = createRunner({ deps: f.deps });
  assert.equal((await runner.pass()).ran, 0);
  assert.equal(where(f, 'stuck'), 'build · Martin');
  assert.equal((await createRunner({ deps: f.deps }).pass()).ran, 0);
  assert.equal(f.calls.sessions.length, 0);
});

test('legacy blocked build reconciles once and does not consume a session lane', async () => {
  const f = goalFixture({ stuck: { status: 'blocked' } });
  const runner = createRunner({ deps: f.deps });
  assert.equal((await runner.pass()).ran, 0);
  assert.equal(where(f, 'stuck'), 'build · Martin');
  assert.equal(f.calls.sessions.length, 0);
  assert.equal((await createRunner({ deps: f.deps }).pass()).ran, 0);
  assert.equal(f.calls.sessions.length, 0);
});

/** The hold `mc goal hold` writes, as the runner reads it. */
const HOLD = (at = '2026-11-01T19:00Z') => JSON.stringify({ by: 'plan', tool: 'claude', at, reason: 'the fix is taken over here' });

test('a held goal gets no planning or build session, a held one left in finish stays there, and the runner says so once', async () => {
  for (const stage of ['draft', 'build', 'finish']) {
    const held = goalFixture({ held: { stage } });
    held.files[`${GOALS}/held/.hold.json`] = HOLD();
    // One runner across both passes, as a runner process is: the say is once for the hold, not once a pass.
    const runner = createRunner({ deps: held.deps });
    const logBefore = held.files[`${GOALS}/held/LOG.md`];
    assert.equal((await runner.pass({ repo: 'memoro' })).ran, 0, `${stage}: nothing starts`);
    assert.equal((await runner.pass({ repo: 'memoro' })).ran, 0, `${stage}: nothing starts on the next pass`);
    assert.equal(held.calls.sessions.length, 0, `${stage}: no session`);
    assert.equal(where(held, 'held'), `${stage} · ready`, `${stage}: stage and status stay`);
    assert.equal(held.files[`${GOALS}/held/LOG.md`], logBefore, `${stage}: no new log entry`);
    assert.equal(held.log.filter((line) => line.includes('prog/held: held by plan since 2026-11-01T19:00Z')).length, 1, `${stage}: said once`);

    // The same goal unheld gets its session, so the hold is what kept it back.
    const free = goalFixture({ free: { stage } });
    assert.equal((await createRunner({ deps: free.deps }).pass({ repo: 'memoro' })).ran, 1, `${stage}: unheld, it gets a session`);
  }
});

test('a held goal in review gets no review session; released, its review starts', async () => {
  const f = reviewFixture();
  f.files[`${GOALS}/judged/.hold.json`] = HOLD();
  const runner = createRunner({ deps: f.deps });
  assert.equal((await runner.pass({ repo: 'memoro' })).ran, 0, 'held: nothing starts');
  assert.equal(f.calls.sessions.length, 0, 'no review session');
  assert.equal(where(f, 'judged'), 'review · ready', 'stage and status stay');
  delete f.files[`${GOALS}/judged/.hold.json`];
  assert.equal((await runner.pass({ repo: 'memoro' })).ran, 1, 'released: the review starts');
  assert.equal(f.calls.sessions[0].env.MC_ROLE, 'review-session:goal');
});

test('a release starts the held goal again, and each new hold is said again', async () => {
  const f = goalFixture({ held: { stage: 'build' } });
  f.files[`${GOALS}/held/.hold.json`] = HOLD('2026-11-01T19:00Z');
  const runner = createRunner({ deps: f.deps });
  assert.equal((await runner.pass({ repo: 'memoro' })).ran, 0);
  delete f.files[`${GOALS}/held/.hold.json`];
  assert.equal((await runner.pass({ repo: 'memoro' })).ran, 1, 'released: a session starts');
  const started = f.calls.sessions.length;
  f.files[`${GOALS}/held/.hold.json`] = HOLD('2026-11-01T22:00Z');
  assert.equal((await runner.pass({ repo: 'memoro' })).ran, 0, 'held again: none starts');
  assert.equal(f.calls.sessions.length, started, 'no session after the new hold');
  assert.equal(f.log.filter((line) => line.includes('prog/held: held by plan since')).length, 2, 'said once for each hold');
});

test('a held blocked goal still reconciles to Martin outside merge, with the comment an unheld one gets, and no session starts', async () => {
  const f = goalFixture({ stuck: { status: 'blocked' } });
  f.files[`${GOALS}/stuck/.hold.json`] = HOLD();
  assert.equal((await createRunner({ deps: f.deps }).pass({ repo: 'memoro' })).ran, 0);
  assert.equal(where(f, 'stuck'), 'build · Martin');
  assert.equal(f.calls.sessions.length, 0);

  const unheld = goalFixture({ stuck: { status: 'blocked' } });
  assert.equal((await createRunner({ deps: unheld.deps }).pass({ repo: 'memoro' })).ran, 0);
  const entry = (fixture) => { const { at: _at, ...rest } = goalEntries(fixture, 'stuck').at(-1); return rest; };
  assert.deepEqual(entry(f), entry(unheld), 'the same reconcile entry, held or not');
  assert.match(entry(f).comment, /legacy .* reconciled to Martin/u);
});

test('a held merge · blocked goal gets no mend session; unheld, it does', async () => {
  const mergeBlocked = () => {
    const f = goalFixture({ stuck: { stage: 'merge', status: 'blocked' } });
    f.files[`${GOALS}/stuck/GOAL.json`] = withGoal(f.files[`${GOALS}/stuck/GOAL.json`], { prs: ['memoro#31'] });
    f.deps.pendingMerges = () => [];
    return f;
  };
  const held = mergeBlocked();
  held.files[`${GOALS}/stuck/.hold.json`] = HOLD();
  assert.equal((await createRunner({ deps: held.deps }).pass({ repo: 'memoro' })).ran, 0, 'held: nothing starts');
  assert.equal(held.calls.sessions.length, 0, 'no mend session');
  assert.equal(where(held, 'stuck'), 'merge · blocked', 'stage and status stay');

  const free = mergeBlocked();
  assert.equal((await createRunner({ deps: free.deps }).pass({ repo: 'memoro' })).ran, 1, 'unheld: a session starts');
  assert.equal(free.calls.sessions[0].env.MC_ROLE, 'mend-session');
});

test('a held Martin goal with a prepared desk item gets no decision session; unheld, it does', async () => {
  const decisionFixture = () => {
    const f = goalFixture({ held: { stage: 'build', status: 'Martin' } });
    const at = '2026-08-29T09:00:00Z';
    const item = { id: deskItemId('goal', 'prog/held', at), kind: 'goal', reference: 'prog/held', source_at: at, state: 'prepared' };
    f.deps.deskItems = { list: () => [item], read: (id) => (id === item.id ? item : null) };
    return f;
  };
  const held = decisionFixture();
  held.files[`${GOALS}/held/.hold.json`] = HOLD();
  const runner = createRunner({ deps: held.deps });
  assert.equal((await runner.pass({ repo: 'memoro' })).ran, 0, 'held: nothing starts');
  assert.equal((await runner.pass({ repo: 'memoro' })).ran, 0, 'held: nothing starts on the next pass');
  assert.equal(held.calls.sessions.length, 0, 'no decision session');
  assert.equal(where(held, 'held'), 'build · Martin', 'stage and status stay');

  const free = decisionFixture();
  assert.equal((await createRunner({ deps: free.deps }).pass({ repo: 'memoro' })).ran, 1, 'unheld: the decision starts');
  assert.equal(free.calls.sessions[0].env.MC_ROLE, 'decision');
});

test('multiple legacy blocked goals reconcile without duplicate diagnostic launches across lanes', async () => {
  const f = goalFixture({ a: { status: 'blocked' }, b: { status: 'blocked' } });
  f.deps.laneCount = () => ({ lanes: 2 });
  const runner = createRunner({ deps: f.deps });
  const [one, two] = await Promise.all([runner.pass({ lane: 1 }), runner.pass({ lane: 2 })]);
  assert.equal(one.ran + two.ran, 0);
  assert.equal(f.calls.sessions.length, 0);
  assert.equal(where(f, 'a'), 'build · Martin');
  assert.equal(where(f, 'b'), 'build · Martin');
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
  assert.equal(runner.nextWork().name, 'goal:prog/older', 'legacy blocked is reconciled; review remains eligible');
  f.files[`${base}/goals/new/GOAL.json`] = withGoal(f.files[`${base}/goals/new/GOAL.json`], { phase: 2 });
  f.files[`${base}/goals/first/GOAL.json`] = goalJson({ repos: ['memoro'], stage: 'draft' });
  assert.equal(runner.nextWork().name, 'goal:prog/older', 'priority does not bypass phases');
  f.files[`${GOALS}/older/GOAL.json`] = withGoal(f.files[`${GOALS}/older/GOAL.json`], { stage: 'build' });
  f.files[`${base}/PRIORITY.json`] = JSON.stringify({ priority: 0 });
  delete f.files[`${base}/goals/first/GOAL.json`];
  f.files[`${base}/goals/new/GOAL.json`] = withGoal(f.files[`${base}/goals/new/GOAL.json`], { phase: 1, status: 'ready' });
  assert.equal(runner.nextWork().name, 'goal:prog/older', 'reset restores oldest first');
});


test('next-draft planning launches one selected goal with PLAN identity and hands its completed brief to build', async () => {
  const f = goalFixture({ z: { stage: 'draft', phase: 2 }, a: { stage: 'draft' }, done: { stage: 'done' }, gone: { stage: 'dropped' } });
  f.files[`${GOALS}/a/GOAL.json`] = withGoal(f.files[`${GOALS}/a/GOAL.json`], { success_criteria: [] });
  f.answer = call => {
    assert.equal(call.cwd, `${GOALS}/a/memoro`);
    assert.equal(call.env.MC_ROLE, 'plan');
    assert.equal(call.env.MC_HEADLESS, '1');
    assert.equal(call.env.MC_GOAL, 'prog/a');
    assert.match(call.prompt, /complete exactly this draft/u);
    assert.match(call.prompt, /Do not implement the draft/u);
    assert.match(call.prompt, /goal-bound mc ask/u);
    assert.match(call.checkIn(60, 1), /Complete the selected draft/u);
    f.files[`${GOALS}/a/GOAL.json`] = withGoal(f.files[`${GOALS}/a/GOAL.json`], { stage: 'build', success_criteria: [{ criterion: 'bounded delivery', check: 'focused fixture', met: false }] });
    return logsItself(f, 'a')(call);
  };
  const runner = createRunner({ deps: f.deps });
  assert.equal((await runner.pass()).ran, 1);
  assert.equal(where(f, 'a'), 'build · ready');
  assert.equal(runRows(f.files).at(-1).kind, 'plan');
  assert.equal(runner.nextWork().kind, 'build');
  assert.equal(f.calls.sessions.length, 1);
});

/* ------------------------------------------- a hold written while a session runs, or between the pick and its start */

/** A session that writes the hold `mc goal hold` writes while it runs, then answers as `inner` does. */
const holdsMidSession = (f, name, inner = okSession()) => (call) => {
  f.files[`${GOALS}/${name}/.hold.json`] = HOLD();
  return inner(call);
};

test('a plan that ends on a held draft leaves it as it is: no runner entry, one line says so, and the next plan starts once released', async () => {
  const f = goalFixture({ a: { stage: 'draft' } });
  f.answer = holdsMidSession(f, 'a');
  const runner = createRunner({ deps: f.deps });
  const logBefore = f.files[`${GOALS}/a/LOG.md`];
  assert.equal((await runner.pass()).ran, 1, 'the plan session ran');
  assert.equal(where(f, 'a'), 'draft · ready', 'stage and status stay');
  assert.equal(f.files[`${GOALS}/a/LOG.md`], logBefore, 'no runner entry, and no entry of its own');
  assert.equal(f.log.filter((line) => /when its session ended — stage and status stay, nothing is written/u.test(line)).length, 1, 'said once');
  assert.equal((await runner.pass()).ran, 0, 'held: the next pass starts nothing');
  assert.equal(f.calls.sessions.length, 1);
  delete f.files[`${GOALS}/a/.hold.json`];
  f.answer = okSession();
  assert.equal((await runner.pass()).ran, 1, 'released: a plan starts');
  assert.equal(f.calls.sessions.length, 2);
});

test('a build that ends on a held goal without an entry of its own leaves it build · ready with no runner entry', async () => {
  const bare = goalFixture({ a: {} });
  bare.answer = holdsMidSession(bare, 'a');
  const before = bare.files[`${GOALS}/a/LOG.md`];
  assert.equal((await createRunner({ deps: bare.deps }).pass()).ran, 1);
  assert.equal(where(bare, 'a'), 'build · ready');
  assert.equal(bare.files[`${GOALS}/a/LOG.md`], before, 'no entry of its own, no runner entry');
});

test('a build that ends on a held goal with an entry of its own and no progress gets no no-progress entry', async () => {
  // Unheld, a build that writes its own entry, meets nothing and commits nothing gets a no-progress entry (afterBuild).
  const free = noProgressFixture();
  await stuckPass(free, builds(free));
  assert.equal(noProgressEntries(free).length, 1, 'unheld: the runner writes its no-progress entry');
  const held = noProgressFixture();
  const heldBefore = stuckEntries(held).length;
  await stuckPass(held, (call) => { held.files[`${GOALS}/stuck/.hold.json`] = HOLD(); return builds(held)(call); });
  assert.equal(stuckWhere(held), 'build · ready');
  assert.equal(stuckEntries(held).length, heldBefore + 1, 'its own entry is the only new one');
  assert.equal(stuckEntries(held).filter((entry) => entry.tool === 'runner').length, 0, 'no runner entry: no no-progress entry');
});

/** A rejected goal `stuck` in build whose worktree HEAD stays put, so a repair that commits nothing makes no progress. */
function repairFixture() {
  const f = goalFixture({ stuck: { stage: 'build', verdict: VERDICT, log: rejectedLog() } });
  const git = f.deps.git;
  f.deps.git = (cwd, args) => (cwd === `${GOALS}/stuck/memoro` && args.join(' ') === 'rev-parse HEAD' ? { ok: true, stdout: 'head-0\n' } : git(cwd, args));
  return f;
}

test('a repair that ends on a held goal leaves it in build with no runner entry', async () => {
  const free = repairFixture();
  free.answer = logsItself(free, 'stuck');
  assert.equal((await createRunner({ deps: free.deps }).pass({ repo: 'memoro' })).ran, 1);
  assert.match(free.calls.sessions[0].prompt, /REVIEW\.md/u, 'a repair session');
  assert.equal(goalEntries(free, 'stuck').at(-1).tool, 'runner', 'unheld: the runner writes its no-progress entry');
  assert.match(goalEntries(free, 'stuck').at(-1).comment, /^no progress this session/u);

  const f = repairFixture();
  f.answer = (call) => { f.files[`${GOALS}/stuck/.hold.json`] = HOLD(); return logsItself(f, 'stuck')(call); };
  const before = goalEntries(f, 'stuck').length;
  assert.equal((await createRunner({ deps: f.deps }).pass({ repo: 'memoro' })).ran, 1);
  assert.match(f.calls.sessions[0].prompt, /REVIEW\.md/u, 'a repair session');
  assert.equal(where(f, 'stuck'), 'build · ready', 'stage and status stay');
  assert.equal(goalEntries(f, 'stuck').length, before + 1, 'its own entry, and no runner entry');
  assert.notEqual(goalEntries(f, 'stuck').at(-1).tool, 'runner');
});

test('a review that ends on a held goal leaves it review · ready with no runner entry', async () => {
  const f = reviewFixture();
  f.answer = holdsMidSession(f, 'judged');
  const before = goalEntries(f).length;
  assert.equal((await createRunner({ deps: f.deps }).pass({ repo: 'memoro' })).ran, 1);
  assert.equal(where(f, 'judged'), 'review · ready');
  assert.equal(goalEntries(f).length, before, 'no runner entry');
});

/**
 * A mend on the red goal `red`: its session puts the pull request in the merger's line again, sets the status
 * `left` when given (`blocked`: the obstacle unresolved), and writes the hold when `hold`. Returns the fixture after one pass.
 */
async function mendPass({ hold = false, left = null } = {}) {
  const f = goalFixture({ red: { stage: 'merge', log: redMerge } });
  f.files[`${GOALS}/red/GOAL.json`] = withGoal(f.files[`${GOALS}/red/GOAL.json`], { prs: ['memoro#31'] });
  let line = [{ repo: 'memoro', pr: 31, state: 'red' }];
  f.deps.pendingMerges = () => line;
  f.answer = (call) => {
    line = [{ repo: 'memoro', pr: 31, state: 'queued' }];
    if (left) f.files[`${GOALS}/red/GOAL.json`] = withGoal(f.files[`${GOALS}/red/GOAL.json`], { status: left });
    if (hold) f.files[`${GOALS}/red/.hold.json`] = HOLD();
    return okSession()(call);
  };
  f.logBefore = f.files[`${GOALS}/red/LOG.md`];
  assert.equal((await createRunner({ deps: f.deps }).pass({ repo: 'memoro' })).ran, 1);
  assert.equal(f.calls.sessions[0].env.MC_ROLE, 'mend-session');
  return f;
}

test('a mend that ends on a held goal leaves it merge · ready and its log as it was', async () => {
  // Unheld, a mend that leaves the goal as it was, its pull request queued again, gets the runner's entry (afterMend).
  const free = await mendPass();
  assert.equal(parseLog(free.files[`${GOALS}/red/LOG.md`]).at(-1).done, 'mend session took the red; the pull request is in the merger\'s line again');
  const f = await mendPass({ hold: true });
  assert.equal(where(f, 'red'), 'merge · ready');
  assert.equal(f.files[`${GOALS}/red/LOG.md`], f.logBefore, 'no mend entry, no runner entry');

  // Unheld, a mend that leaves the goal blocked is set Martin (B2's shape); held, its status stays as the session left it.
  const freeBlocked = await mendPass({ left: 'blocked' });
  assert.equal(where(freeBlocked, 'red'), 'merge · Martin', 'unheld: the runner sets Martin');
  const blocked = await mendPass({ hold: true, left: 'blocked' });
  assert.equal(where(blocked, 'red'), 'merge · blocked', 'no status change');
  assert.equal(blocked.files[`${GOALS}/red/LOG.md`], blocked.logBefore, 'no runner entry');
});

test('a hold written while the dependencies attach starts no session: the goal stays as it was, with no entry, and the line says why', async () => {
  const f = goalFixture({ a: {} });
  f.deps.attachDeps = async () => { f.files[`${GOALS}/a/.hold.json`] = HOLD(); return { ok: true }; };
  const before = f.files[`${GOALS}/a/LOG.md`];
  assert.equal((await createRunner({ deps: f.deps }).pass()).ran, 0);
  assert.equal(f.calls.sessions.length, 0, 'no session');
  assert.equal(where(f, 'a'), 'build · ready');
  assert.equal(f.files[`${GOALS}/a/LOG.md`], before, 'no new entry');
  assert.ok(f.log.some((line) => line.includes('prog/a: held by plan') && line.includes('no session is started')), f.log.join('\n'));
});

test('a hold written during a review admission, after the pick, starts no session and writes no entry', async () => {
  const f = reviewFixture();
  const worktree = `${GOALS}/judged/memoro`;
  dirtyTree(f, worktree, [' M src/x.js']);
  const git = f.deps.git;
  let statusReads = 0;
  f.deps.git = (cwd, args) => {
    if (cwd === worktree && args.join(' ') === 'status --porcelain') statusReads += 1;
    return git(cwd, args);
  };
  // The first disk reading is the top of the pass, before the pick; the runner's own line for the pick comes next, so the first reading after it is the admission (run.js, before the start check).
  let written = false;
  f.deps.freeBytes = () => {
    if (!written && f.log.some((line) => /next — goal:prog\/judged/u.test(line))) { written = true; f.files[`${GOALS}/judged/.hold.json`] = HOLD(); }
    return 50e9;
  };
  const before = goalEntries(f).length;
  assert.equal((await createRunner({ deps: f.deps }).pass({ repo: 'memoro' })).ran, 0);
  assert.equal(written, true, 'the hold was written at the admission');
  assert.equal(f.calls.sessions.length, 0, 'no review session');
  assert.equal(where(f, 'judged'), 'review · ready');
  assert.equal(goalEntries(f).length, before, 'no new entry');
  assert.equal(statusReads, 0, 'the held goal\'s worktree status was not read after the hold');
});

test('a hold written while a review worktree is read starts no session and writes no entry', async () => {
  const f = reviewFixture();
  const worktree = `${GOALS}/judged/memoro`;
  const git = f.deps.git;
  let read = 0;
  f.deps.git = (cwd, args) => {
    if (cwd === worktree && args.join(' ') === 'status --porcelain') {
      read += 1;
      f.files[`${GOALS}/judged/.hold.json`] = HOLD();
      return { ok: true, stdout: ' M src/x.js\n', stderr: '' };
    }
    return git(cwd, args);
  };
  const before = goalEntries(f).length;
  assert.equal((await createRunner({ deps: f.deps }).pass({ repo: 'memoro' })).ran, 0);
  assert.equal(read, 1, 'the worktree was read, after admission');
  assert.equal(f.calls.sessions.length, 0, 'no review session');
  assert.equal(where(f, 'judged'), 'review · ready');
  assert.equal(goalEntries(f).length, before, 'no new entry');
});

test('an incomplete ordinary plan waits on Martin and holds later drafts without spinning', async () => {
  const f = goalFixture({ a: { stage: 'draft' }, b: { stage: 'draft' } });
  const runner = createRunner({ deps: f.deps });
  assert.equal((await runner.pass()).ran, 1);
  assert.equal(where(f, 'a'), 'draft · Martin');
  assert.match(f.files[`${GOALS}/a/LOG.md`], /plan session ended without completing the draft/u);
  assert.equal((await runner.pass()).ran, 0);
  assert.equal(f.calls.sessions.length, 1);
});

test('planning rechecks programme eligibility after allocation before launching', async () => {
  const f = goalFixture({ a: { stage: 'draft' }, b: { stage: 'draft' } });
  f.deps.attachDeps = async () => {
    f.files[`${GOALS}/b/GOAL.json`] = withGoal(f.files[`${GOALS}/b/GOAL.json`], { stage: 'build', status: 'Martin' });
    return { ok: true };
  };
  await createRunner({ deps: f.deps }).pass();
  assert.equal(f.calls.sessions.length, 0);
  assert.equal(where(f, 'a'), 'draft · ready');
  assert.match(f.log.join('\n'), /programme changed during admission/u);
});

test('a live predecessor session holds programme planning even when its goal has finished', () => {
  const f = goalFixture({ a: { stage: 'draft' }, old: { stage: 'done' } }, { livePids: [777] });
  f.files['/w/runner/current-memoro.json'] = JSON.stringify({ pid: 777, lane: 0, name: 'goal:prog/old', repo: 'memoro' });
  assert.equal(createRunner({ deps: f.deps }).nextWork(), null);
  f.files['/w/runner/current-memoro.json'] = JSON.stringify({ pid: 777, lane: 0, repo: 'memoro' });
  assert.equal(createRunner({ deps: f.deps }).nextWork(), null, 'unknown current ownership holds planning');
});

test('another lane cannot plan a second draft while the selected draft is held', async t => {
  const f = goalFixture({ a: { stage: 'draft' }, b: { stage: 'draft' } });
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  f.answer = async () => { await wait; return okSession()(); };
  t.after(() => release());
  const runner = createRunner({ deps: f.deps });
  const first = runner.pass({ lane: 0 });
  await turns();
  assert.equal(f.calls.sessions.length, 1);
  assert.equal((await runner.pass({ lane: 1 })).ran, 0);
  release();
  await first;
  assert.equal(f.calls.sessions.length, 1);
});

test('an offline plan ending retains its draft and existing retry hold', async () => {
  const f = goalFixture({ a: { stage: 'draft' } });
  f.answer = UNREACHABLE;
  const runner = createRunner({ deps: f.deps });
  assert.equal((await runner.pass()).ran, 1);
  assert.equal(where(f, 'a'), 'draft · ready');
  assert.equal(f.files[`${GOALS}/a/LOG.md`], '');
  assert.equal((await runner.pass()).ran, 0);
  assert.equal(f.calls.sessions.length, 1);
  assert.match(runRows(f.files).at(-1).note, /offline/u);
});


test('a quota refusal during planning preserves draft readiness and records provider backoff', async () => {
  const f = goalFixture({ a: { stage: 'draft' } });
  f.answer = REFUSED_429;
  await createRunner({ deps: f.deps }).pass();
  assert.equal(where(f, 'a'), 'draft · ready');
  assert.ok(f.deps.capacity.read().providers.claude.refusal_until);
  assert.doesNotMatch(f.files[`${GOALS}/a/LOG.md`], /without completing the draft/u);
});

/** Main-red requests use the same real state transitions with the runner fixture's IO. */
function mainRedFixture(goals = {}) {
  const f = goalFixture(goals);
  f.mainState = { root: '/w', repo: 'memoro', read: f.deps.read, write: f.deps.writeJson, lock: f.deps.lock };
  requestMainRepair({ ...f.mainState, base: 'main-head', files: ['tests/red.test.js', 'tests/other-red.test.js'], tests: [{ file: 'tests/red.test.js', name: 'red assertion', error: ['missing browser'] }], now: f.deps.now });
  const git = f.deps.git;
  const branches = new Set();
  f.deps.git = (cwd, args) => {
    if (args[0] === 'show-ref') return { ok: branches.has(args.at(-1)), stdout: '' };
    if (args[0] === 'worktree' && args[1] === 'add') {
      const path = args.at(-2);
      f.dirs.add(path);
      if (args.includes('-b')) branches.add(`refs/heads/${args[4]}`);
    }
    return git(cwd, args);
  };
  f.mainEntries = () => readMainMends(f.mainState);
  return f;
}

test('a queued main-red request precedes build, review and finish, launches goal-less mend from origin/main and records publication', async () => {
  const f = mainRedFixture({ build: {}, review: { stage: 'review' }, finish: { stage: 'finish' } });
  const runner = createRunner({ deps: f.deps });
  const pick = runner.nextWork();
  assert.equal(pick.kind, 'mend');
  assert.deepEqual(pick.mainMend.map((entry) => entry.file), ['tests/other-red.test.js', 'tests/red.test.js']);
  f.answer = (call) => {
    assert.equal(call.env.MC_ROLE, 'mend-session');
    assert.equal(call.env.MC_GOAL, undefined);
    assert.equal(call.env.MC_PROGRAMME, undefined);
    assert.equal(call.env.MC_MODEL, 'sonnet', 'the mend list default, not a build class model');
    assert.ok(call.unsetEnv.includes('MC_GOAL'));
    assert.match(call.prompt, /You are a main-red mend session/u);
    assert.match(call.prompt, /missing browser/u);
    assert.match(call.prompt, /mc gate --fresh/u);
    assert.match(call.prompt, /then bare mc gate/u);
    assert.doesNotMatch(call.prompt, /mc gate --whole-selection/u);
    assert.ok(f.mainEntries().every((entry) => entry.state === 'running'));
    assert.equal(runner.nextWork()?.name === pick.name, false, 'a second lane cannot take the same batch');
    publishMainMend({ ...f.mainState, branch: pick.branch, pr: 42 });
    return okSession()(call);
  };
  const pass = await runner.pass();
  assert.equal(pass.ran, 1);
  assert.match(pick.branch, /^mend\/main-memoro-[a-f0-9]+$/u);
  const added = f.calls.git.find((call) => call[1] === 'worktree' && call[2] === 'add');
  assert.deepEqual(added, ['/home/memoro', 'worktree', 'add', '-q', '-b', pick.branch, f.calls.sessions[0].cwd, 'origin/main']);
  assert.deepEqual(f.mainEntries().map((entry) => [entry.state, entry.pr]), [['published', 42], ['published', 42]]);
  assert.equal(f.files['/w/programs/main-health/goals'], undefined);
  assert.equal(Object.keys(f.files).some((path) => path.startsWith('/w/programs/main-health/')), false);
});

test('the third main-red attempt waits on Martin with its session log and keeps the same branch', async () => {
  const f = mainRedFixture();
  const runner = createRunner({ deps: f.deps });
  const branch = runner.nextWork().branch;
  // First attempt publishes, but its ordinary merge fails. It rejoins the mend rank.
  f.answer = (call) => { publishMainMend({ ...f.mainState, branch, pr: 42 }); return okSession()(call); };
  await runner.pass();
  answerMainMend({ ...f.mainState, pr: 42, landed: false, reason: 'candidate red' });
  assert.ok(f.mainEntries().every((entry) => entry.state === 'queued' && entry.failures === 1));
  f.answer = okSession(); // The one recovery ends without publication.
  await runner.pass();
  assert.ok(f.mainEntries().every((entry) => entry.state === 'Martin' && entry.failures === 2));
  assert.equal((await runner.pass()).ran, 0, 'the third attempt waits on Martin');
  assert.deepEqual(f.mainEntries().map((entry) => entry.branch), [branch, branch]);
  assert.ok(f.mainEntries().every((entry) => entry.session_log === f.calls.sessions.at(-1).logPath));
  assert.equal(new Set(f.calls.sessions.map((call) => call.cwd)).size, 1);
  assert.equal(f.calls.git.filter((call) => call[1] === 'worktree' && call[2] === 'add').length, 1);
  assert.equal(runner.nextWork(), null, 'Martin starts no third session');
  assert.equal(f.calls.sessions.length, 2);
});

test('a requeued main-red repair is offered again on its own branch with no failures, and its prompt carries the desk\'s reason', async () => {
  const f = mainRedFixture();
  const runner = createRunner({ deps: f.deps });
  const branch = runner.nextWork().branch;
  f.answer = (call) => { publishMainMend({ ...f.mainState, branch, pr: 42 }); return okSession()(call); };
  await runner.pass();
  answerMainMend({ ...f.mainState, pr: 42, landed: false, reason: 'candidate red' });
  f.answer = okSession();
  await runner.pass();
  assert.ok(f.mainEntries().every((entry) => entry.state === 'Martin' && entry.failures === 2));
  const [{ pr, session_log: sessionLog, worktree }] = f.mainEntries();
  for (const { id } of f.mainEntries()) {
    const answered = answerHeldMend({ ...f.mainState, id, verb: 'requeue', reason: 'the browser is installed now', role: 'martin', now: f.deps.now });
    assert.equal(answered.ok, true, answered.error);
  }
  assert.ok(f.mainEntries().every((entry) => entry.state === 'queued' && entry.failures === 0 && entry.branch === branch && entry.worktree === worktree && entry.pr === pr && entry.session_log === sessionLog && entry.answered.verb === 'requeue'));
  const again = runner.nextWork();
  assert.equal(again.kind, 'mend');
  assert.equal(again.branch, branch, 'offered on the same branch');
  f.answer = (call) => { assert.match(call.prompt, /the browser is installed now/u); return okSession()(call); };
  await runner.pass();
  assert.ok(f.mainEntries().every((entry) => entry.state === 'queued' && entry.failures === 1), 'one more failure is one more attempt, not the third that ends at Martin');
  assert.equal(f.calls.git.filter((call) => call[1] === 'worktree' && call[2] === 'add').length, 1, 'the branch and its worktree are the ones it had');
  assert.equal(new Set(f.calls.sessions.map((call) => call.cwd)).size, 1);
  assert.equal(f.calls.sessions.length, 3);
});

/** Two finished repairs\' trees and what shares them, with the runner's own sweep (`settleMainMends`) reading them. */
function sharedTreeFixture(states) {
  const f = mainRedFixture();
  const paths = ['/w/mend/shared', '/w/mend/alone'];
  paths.forEach((path) => f.dirs.add(path));
  updateMainMends(f.mainState, (entries) => {
    entries.push(...states.map(([state, worktree], i) => ({ ...entries[0], id: `extra${i}`, file: `tests/extra${i}.test.js`, state, worktree, owner: `main-red:extra${i}` })));
    entries.splice(0, 2); // the fixture's own two queued requests are not part of this case
  });
  return f;
}
const removals = (f) => f.calls.git.filter((call) => call[1] === 'worktree' && call[2] === 'remove').map((call) => call.at(-1));

test('the runner removes the tree of a landed and of a dropped repair, once, and not one an unfinished repair still names', async () => {
  const f = sharedTreeFixture([['landed', '/w/mend/shared'], ['Martin', '/w/mend/shared'], ['dropped', '/w/mend/alone'], ['landed', '/w/mend/alone']]);
  await createRunner({ deps: f.deps }).pass();
  assert.deepEqual(removals(f), ['/w/mend/alone'], 'the shared tree stays for the repair on Martin');
  assert.ok(f.dirs.has('/w/mend/shared'));
});

test('the runner removes a shared tree once the last repair that named it is finished, and says what git would not remove', async () => {
  const f = sharedTreeFixture([['landed', '/w/mend/shared'], ['dropped', '/w/mend/shared'], ['landed', '/w/mend/alone']]);
  const git = f.deps.git;
  f.deps.git = (cwd, args) => (args[1] === 'remove' && args.at(-1) === '/w/mend/alone' ? { ...git(cwd, args), ok: false, stderr: 'has uncommitted work' } : git(cwd, args));
  await createRunner({ deps: f.deps }).pass();
  assert.deepEqual(removals(f).sort(), ['/w/mend/alone', '/w/mend/shared']);
  assert.ok(f.calls.git.every((call) => call[1] !== 'worktree' || call[2] !== 'remove' || !call.includes('--force')), 'never forced');
  assert.match(f.files['/w/runner/log/runner.log'], /finished main-red worktree retained at \/w\/mend\/alone — has uncommitted work/u);
});

test('a session ending sweeps the finished repairs\' trees by the same rule', async () => {
  const f = mainRedFixture();
  f.dirs.add('/w/mend/old');
  updateMainMends(f.mainState, (entries) => { entries.push({ ...entries[0], id: 'old1', file: 'tests/old.test.js', state: 'dropped', worktree: '/w/mend/old', owner: 'main-red:old1' }); });
  f.answer = (call) => { publishMainMend({ ...f.mainState, branch: runner.nextWorkBranch, pr: 42 }); return okSession()(call); };
  const runner = createRunner({ deps: f.deps });
  runner.nextWorkBranch = runner.nextWork().branch;
  await runner.pass();
  assert.deepEqual(removals(f), ['/w/mend/old']);
  assert.ok(f.dirs.has(f.calls.sessions[0].cwd), 'its own, still unfinished tree is not touched');
});

test('a build session on a version 2 goal is handed the goal as `mc goal show` renders it: its parts in order, with each id', async () => {
  const f = goalFixture({ older: { log: goalLog('2026-08-27T10:00Z') } });
  f.files[`${GOALS}/older/GOAL.json`] = goalJsonV2({ title: 'older', repos: ['memoro'] });
  f.answer = logsItself(f, 'older');
  const r = await createRunner({ deps: f.deps }).pass({ repo: 'memoro', lane: 1, tag: 'memoro#2' });
  assert.equal(r.name, 'goal:prog/older');
  const [call] = f.calls.sessions;
  assert.match(call.prompt, /The goal, as `mc goal show` renders it:\n\n# older\n\nAIM\n  Why the goal exists\.\n\nOUTCOME\n/u);
  assert.match(call.prompt, /\nPROBLEM\n  B1 The brief is one prose field\.\n      basis: measured\n\nPREMISES\n  P1 /u);
  assert.match(call.prompt, /\nOBLIGATIONS\n  Documentation · touched — mc-goals\.md says both versions\.\n      standard: memoro-cli\/docs\/technical\/mc-goals\.md#GOAL\.json\n/u);
  assert.match(call.prompt, /\nCRITERIA 0\/1\n  1 ✗ it works\n      check: a test\n      evidence: the gate log\n/u);
});


/**
 * A stopped deploy's repair on the runner's fakes: the request is the real file, the session, GitHub, git and the
 * deploy command are the fixture's. `retries` is every call of the deploy command the runner made, `rows` the
 * deploy record it reads, `pick` what the pick is, `contains` whether the pick holds the landed memoro merge.
 */
const DEPLOY_STARTED = '2026-08-29T09:00:00.000Z';
function deployMendFixture({ started = DEPLOY_STARTED, acceptRed = false } = {}) {
  const f = goalFixture({});
  f.deployState = { root: '/w', read: f.deps.read, write: f.deps.writeJson, lock: f.deps.lock };
  requestDeployRepair({ ...f.deployState, row: { started, sha: 'a'.repeat(40), stopped_at: 'deployer', note: 'wrangler fell over' }, holder: 'martin@laptop', acceptRed, now: f.deps.now, mkdir: () => {}, copy: () => {} });
  f.entries = () => readDeployMends(f.deployState);
  f.rows = []; f.retries = []; f.pick = 'pickoid'; f.contains = true; f.prStates = {};
  f.deps.deploys = () => f.rows;
  f.deps.pickOf = async () => f.pick;
  f.retryAnswer = (options) => { f.rows.push({ holder: options.holder.name, outcome: 'deployed', started: '2026-08-29T10:00:00.000Z', ended: '2026-08-29T10:05:00.000Z' }); return 0; };
  f.deps.deployRun = async (argv, options) => { f.retries.push({ argv, options }); return f.retryAnswer(options); };
  const git = f.deps.git; const gh = f.deps.gh; const branches = new Set();
  f.deps.git = (cwd, args) => {
    if (args[0] === 'show-ref') return { ok: branches.has(args.at(-1)), stdout: '' };
    if (args[0] === 'merge-base' && args[1] === '--is-ancestor') return { ok: f.contains, stdout: '' };
    if (args[0] === 'worktree' && args[1] === 'add') { f.dirs.add(args.at(-2)); if (args.includes('-b')) branches.add(`refs/heads/${args[4]}`); }
    return git(cwd, args);
  };
  f.deps.gh = (cwd, args) => {
    if (args[0] === 'pr' && args[1] === 'view' && args.includes('state')) return { ok: true, stdout: JSON.stringify({ state: f.prStates[args[2]] || 'MERGED' }) };
    if (args[0] === 'pr' && args[1] === 'view' && args.includes('mergeCommit')) return { ok: true, stdout: JSON.stringify({ mergeCommit: { oid: `merge${args[2]}0000000000` } }) };
    return gh(cwd, args);
  };
  f.runner = createRunner({ deps: f.deps });
  f.publishes = (...prs) => (call) => { for (const [repo, pr] of prs) publishDeployMend({ ...f.deployState, repo, branch: f.entries()[0].branch, pr }); return okSession()(call); };
  return f;
}

test('a queued deploy repair is offered at the main-red mend\'s rank and launches a goal-less mend session in both worktrees', async () => {
  const f = deployMendFixture();
  const pick = f.runner.nextWork();
  assert.equal(pick.kind, 'mend');
  assert.equal(pick.deployMend.id, f.entries()[0].id);
  assert.match(pick.branch, /^mend\/deploy-[a-f0-9]{12}$/u);
  f.answer = (call) => {
    assert.equal(call.env.MC_ROLE, 'mend-session');
    assert.equal(call.env.MC_HEADLESS, '1');
    assert.equal(call.env.MC_DEPLOY_MEND, pick.deployMend.id);
    assert.equal(call.env.MC_GOAL, undefined);
    assert.equal(call.env.MC_MODEL, 'sonnet', 'class fast');
    assert.match(call.prompt, /wrangler fell over/u);
    assert.match(call.prompt, /Never run mc deploy/u);
    assert.equal(f.entries()[0].state, 'running');
    assert.equal(f.runner.nextWork()?.name === pick.name, false, 'a second lane cannot take it');
    return okSession()(call);
  };
  assert.equal((await f.runner.pass()).ran, 1);
  const added = f.calls.git.filter((call) => call[1] === 'worktree' && call[2] === 'add');
  assert.deepEqual(added.map((call) => call[0]).sort(), ['/home/memoro', '/home/memoro-cli']);
  assert.ok(added.every((call) => call.includes(pick.branch)), 'both trees are on the repair branch');
});

test('two attempts that publish nothing put a deploy repair on Martin, and no third session starts', async () => {
  const f = deployMendFixture();
  assert.equal((await f.runner.pass()).ran, 1);
  assert.deepEqual([f.entries()[0].state, f.entries()[0].failures], ['queued', 1]);
  assert.equal((await f.runner.pass()).ran, 1);
  assert.deepEqual([f.entries()[0].state, f.entries()[0].failures], ['Martin', 2]);
  assert.match(f.entries()[0].reason, /without a published PR or repaired/u);
  assert.equal(f.runner.nextWork(), null);
  assert.equal(f.calls.sessions.length, 2);
  assert.equal(f.retries.length, 0, 'nothing was repaired, so nothing is retried');
});

test('a repair whose memoro pull request landed is retried once, as the runner, with no --accept-red, through the deploy command', async () => {
  const f = deployMendFixture();
  f.answer = f.publishes(['memoro', 7]);
  await f.runner.pass();
  assert.equal(f.entries()[0].state, 'published');
  await f.runner.settleDeployMends();
  assert.equal(f.entries()[0].state, 'deployed');
  assert.equal(f.retries.length, 1);
  const [{ argv, options }] = f.retries;
  assert.deepEqual(argv, []);
  assert.equal(options.holder.name, `runner for martin@laptop, ${DEPLOY_STARTED}`);
  assert.equal(options.retry, true);
  assert.equal(options.env.MC_HEADLESS, undefined, 'the runner is the deployer of the retry');
  assert.equal(typeof options.onStop, 'function');
  await f.runner.settleDeployMends();
  assert.equal(f.retries.length, 1, 'once');
});

test('the session saying repaired is a repair too, and the retry follows', async () => {
  const f = deployMendFixture();
  f.answer = (call) => {
    const done = recordRepaired({ ...f.deployState, id: call.env.MC_DEPLOY_MEND, reason: 'removed a stale lock', role: call.env.MC_ROLE, named: call.env.MC_DEPLOY_MEND });
    assert.equal(done.ok, true, done.error);
    return okSession()(call);
  };
  await f.runner.pass();
  assert.equal(f.entries()[0].state, 'repaired');
  await f.runner.settleDeployMends();
  assert.equal(f.entries()[0].state, 'deployed');
  assert.equal(f.retries.length, 1);
});

test('the retry waits until the pick holds the landed memoro merge, and starts when it does', async () => {
  const f = deployMendFixture();
  f.answer = f.publishes(['memoro', 7]);
  await f.runner.pass();
  f.contains = false;
  await f.runner.settleDeployMends();
  assert.equal(f.retries.length, 0, 'the pick does not hold the repair: no retry');
  assert.deepEqual([f.entries()[0].state, f.entries()[0].waiting], ['repaired', 'green']);
  f.contains = true;
  await f.runner.settleDeployMends();
  assert.equal(f.retries.length, 1);
  assert.equal(f.entries()[0].state, 'deployed');
});

test('a landed repair of the runner\'s own code waits for the handover, and the retry is not started before it', async () => {
  const f = deployMendFixture();
  f.answer = f.publishes(['memoro-cli', 8]);
  await f.runner.pass();
  await f.runner.settleDeployMends();
  assert.equal(f.retries.length, 0);
  assert.deepEqual([f.entries()[0].state, f.entries()[0].waiting], ['repaired', 'handover']);
});

test('a request that carried --accept-red is repaired and not retried', async () => {
  const f = deployMendFixture({ acceptRed: true });
  f.answer = f.publishes(['memoro', 7]);
  await f.runner.pass();
  await f.runner.settleDeployMends();
  assert.equal(f.retries.length, 0);
  assert.equal(f.entries()[0].state, 'not-retried');
  assert.match(f.entries()[0].reason, /accept-red/u);
});

test('a request whose newest stop is older than 24 hours is repaired and not retried', async () => {
  const f = deployMendFixture({ started: '2026-08-27T09:00:00.000Z' });
  f.answer = f.publishes(['memoro', 7]);
  await f.runner.pass();
  await f.runner.settleDeployMends();
  assert.equal(f.retries.length, 0);
  assert.equal(f.entries()[0].state, 'not-retried');
  assert.match(f.entries()[0].reason, /24 hours/u);
});

test('a deploy that shipped since the stop ends the request unretried', async () => {
  const f = deployMendFixture();
  f.rows.push({ holder: 'someone', outcome: 'deployed', started: '2026-08-29T09:30:00.000Z', ended: '2026-08-29T09:40:00.000Z' });
  f.answer = f.publishes(['memoro', 7]);
  await f.runner.pass();
  await f.runner.settleDeployMends();
  assert.equal(f.retries.length, 0);
  assert.match(f.entries()[0].reason, /shipped since/u);
});

test('a pull request closed without merging is a failed attempt: the request is offered again', async () => {
  const f = deployMendFixture();
  f.answer = f.publishes(['memoro', 7]);
  await f.runner.pass();
  f.prStates['7'] = 'CLOSED';
  await f.runner.settleDeployMends();
  assert.deepEqual([f.entries()[0].state, f.entries()[0].failures], ['queued', 1]);
  assert.equal(f.retries.length, 0);
});

test('a retry that stops technically is never a new request and never a second retry: the request waits on Martin', async () => {
  const f = deployMendFixture();
  f.retryAnswer = (options) => {
    options.onStop({ row: { note: 'wrangler fell over again' }, code: '', technical: true });
    f.rows.push({ holder: options.holder.name, outcome: 'failed', started: '2026-08-29T10:00:00.000Z', note: 'wrangler fell over again' });
    return 1;
  };
  f.answer = f.publishes(['memoro', 7]);
  await f.runner.pass();
  await f.runner.settleDeployMends();
  assert.equal(f.entries().length, 1, 'no new request from a retry\'s stop');
  assert.deepEqual([f.entries()[0].state, f.entries()[0].failures, f.entries()[0].retried], ['Martin', 1, true]);
  assert.match(f.entries()[0].reason, /the retry stopped: wrangler fell over again/u);
  assert.equal(f.runner.nextWork(), null, 'no second mend session');
  await f.runner.pass();
  await f.runner.settleDeployMends();
  assert.equal(f.calls.sessions.length, 1);
  assert.equal(f.retries.length, 1, 'one retry, and then nothing more');
});

test('a request the desk requeues after its spent retry is mended again but never retried again', async () => {
  const f = deployMendFixture();
  f.retryAnswer = (options) => {
    options.onStop({ row: { note: 'wrangler fell over again' }, code: '', technical: true });
    f.rows.push({ holder: options.holder.name, outcome: 'failed', started: '2026-08-29T10:00:00.000Z', note: 'wrangler fell over again' });
    return 1;
  };
  f.answer = f.publishes(['memoro', 7]);
  await f.runner.pass();
  await f.runner.settleDeployMends();
  assert.equal(f.entries()[0].state, 'Martin');
  assert.equal(answerHeldDeployMend({ ...f.deployState, id: f.entries()[0].id, verb: 'requeue', reason: 'the cause is known now', role: 'person' }).ok, true);
  f.answer = f.publishes(['memoro', 9]);
  await f.runner.pass();
  await f.runner.settleDeployMends();
  assert.equal(f.entries()[0].state, 'not-retried');
  assert.match(f.entries()[0].reason, /one retry/u);
  assert.equal(f.retries.length, 1);
});

test('a retry that stops for a reason that is not technical ends the request', async () => {
  const f = deployMendFixture();
  f.retryAnswer = (options) => {
    options.onStop({ row: { note: 'the gate is red' }, code: 'red', technical: false });
    f.rows.push({ holder: options.holder.name, outcome: 'refused', started: '2026-08-29T10:00:00.000Z', note: 'the gate is red' });
    return 1;
  };
  f.answer = f.publishes(['memoro', 7]);
  await f.runner.pass();
  await f.runner.settleDeployMends();
  assert.deepEqual([f.entries()[0].state, f.entries()[0].reason], ['stopped', 'the gate is red']);
  assert.equal(f.retries.length, 1);
});

test('a retry the runner died in the middle of is settled from the deploy record, not repeated', async () => {
  const f = deployMendFixture();
  f.answer = f.publishes(['memoro', 7]);
  await f.runner.pass();
  updateDeployMendsFor(f, (entry) => Object.assign(entry, { state: 'retrying', retry_owner: 999999 }));
  f.rows.push({ holder: `runner for martin@laptop, ${DEPLOY_STARTED}`, outcome: 'deployed', started: '2026-08-29T10:00:00.000Z', ended: '2026-08-29T10:05:00.000Z' });
  await f.runner.settleDeployMends();
  assert.equal(f.entries()[0].state, 'deployed');
  assert.equal(f.retries.length, 0, 'not started a second time');
});

for (const [name, row] of [['a failed row', { outcome: 'failed', note: 'wrangler fell over again' }], ['no row at all', null]]) {
  test(`a retry the runner died in the middle of, with ${name}, waits on Martin and is never started again`, async () => {
    const f = deployMendFixture();
    f.answer = f.publishes(['memoro', 7]);
    await f.runner.pass();
    updateDeployMendsFor(f, (entry) => Object.assign(entry, { state: 'retrying', retried: true, retry_owner: 999999 }));
    if (row) f.rows.push({ holder: `runner for martin@laptop, ${DEPLOY_STARTED}`, started: '2026-08-29T10:00:00.000Z', ended: '2026-08-29T10:05:00.000Z', ...row });
    await f.runner.settleDeployMends();
    assert.equal(f.entries()[0].state, 'Martin');
    assert.match(f.entries()[0].reason, new RegExp(`runner ended during the retry; its deploy row reads ${row ? 'failed' : 'nothing'}`, 'u'));
    await f.runner.settleDeployMends();
    assert.equal(f.retries.length, 0, 'not started again');
    assert.equal(f.runner.nextWork(), null);
  });
}
function updateDeployMendsFor(f, change) { const entries = f.entries(); change(entries[0]); f.deps.writeJson('/w/runner/deploy-mend.json', { version: 1, entries }); }

/* ------------------------------------- a programme whose record states its phases */

const RECORD_AT = '/w/programs/prog/PROGRAMME.json';
const statedText = (after) => `${JSON.stringify({ schema: 'mc-programme', version: 1, horizon: null, end: 'Done when it holds.', state: 'open', created: '2026-11-14T10:20:30Z', created_by: 'person', phases: after === undefined ? { order: 'stated' } : { order: 'stated', after } }, null, 2)}\n`;
const plainText = () => `${JSON.stringify({ schema: 'mc-programme', version: 1, horizon: null, end: 'Done when it holds.', state: 'open', created: '2026-11-14T10:20:30Z', created_by: 'person' }, null, 2)}\n`;
/** Sessions that wait on `gate`, noting each goal they were started for. */
function gated(f) {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = [];
  f.answer = async (call) => { started.push(call.env.MC_GOAL); await gate; return okSession()(call); };
  return { started, release };
}
const lanes = (runner, n) => Array.from({ length: n }, (_, i) => runner.pass({ repo: 'memoro', lane: i + 1, tag: `memoro#${i + 1}` }));

test('a programme that states no dependency runs its phases side by side; a held goal and one on Martin stay out', async () => {
  const f = goalFixture({ one: {}, two: { phase: 2 }, held: { phase: 3 }, asks: { phase: 3, status: 'Martin' } });
  f.files[RECORD_AT] = statedText();
  f.files[`${GOALS}/held/.hold.json`] = HOLD();
  const { started, release } = gated(f);
  const runner = createRunner({ deps: f.deps });
  const both = lanes(runner, 2);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual([...started].sort(), ['prog/one', 'prog/two'], 'phases 1 and 2 had a session each at once');
  assert.equal((await runner.pass({ repo: 'memoro', lane: 3, tag: 'memoro#3' })).ran, 0, 'the held goal and the one waiting on Martin get none');
  release();
  await both;
  assert.deepEqual([...started].sort(), ['prog/one', 'prog/two']);
  assert.equal(where(f, 'held'), 'build · ready');
  assert.equal(where(f, 'asks'), 'build · Martin');
});

test('a dependency stated while a phase-1 session runs keeps the phase-2 goal back, with its stage and log as they were, until phase 1 is done', async () => {
  const f = goalFixture({ one: {}, two: { phase: 2 } });
  f.files[RECORD_AT] = statedText();
  const { started, release } = gated(f);
  const runner = createRunner({ deps: f.deps });
  const first = runner.pass({ repo: 'memoro', lane: 1, tag: 'memoro#1' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ['prog/one'], 'a session on phase 1 is running');
  f.files[RECORD_AT] = statedText({ 2: [1] });
  const logBefore = f.files[`${GOALS}/two/LOG.md`];
  const second = runner.pass({ repo: 'memoro', lane: 2, tag: 'memoro#2' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ['prog/one'], 'phase 2 waits now: no session starts on it');
  assert.equal((await second).ran, 0);
  assert.equal(where(f, 'two'), 'build · ready');
  assert.equal(f.files[`${GOALS}/two/LOG.md`], logBefore);
  release();
  await first;
  f.files[`${GOALS}/one/GOAL.json`] = withGoal(f.files[`${GOALS}/one/GOAL.json`], { stage: 'done' });
  f.answer = okSession();
  const next = await runner.pass({ repo: 'memoro', lane: 1, tag: 'memoro#1' });
  assert.equal(next.name, 'goal:prog/two', 'phase 1 done: phase 2 starts');
});

test('a record that is not JSON, or states a cycle, starts no session in its programme, plan session included, and is said once; another programme goes on', async () => {
  for (const [kind, text] of [['not JSON', '{ not json'], ['a cycle', statedText({ 2: [3], 3: [2] })]]) {
    const f = goalFixture({ one: {}, two: { phase: 2 }, draft: { stage: 'draft', phase: 3 } });
    f.files[RECORD_AT] = text;
    f.files[`/w/programs/other/goals/go/GOAL.json`] = goalJson({ repos: ['memoro'], title: 'go', goal: [] });
    f.files[`/w/programs/other/goals/go/LOG.md`] = '';
    f.dirs.add('/w/programs/other/goals/go/memoro');
    f.files[`${GOALS}/draft/GOAL.json`] = withGoal(f.files[`${GOALS}/draft/GOAL.json`], { success_criteria: [] });
    const runner = createRunner({ deps: f.deps });
    const otherFile = '/w/programs/other/goals/go/GOAL.json';
    f.answer = (call) => { f.files[otherFile] = withGoal(f.files[otherFile], { stage: 'done' }); return okSession()(call); };
    const results = [await runner.pass({ repo: 'memoro' }), await runner.pass({ repo: 'memoro' })];
    assert.deepEqual(f.calls.sessions.map((call) => call.env.MC_GOAL), ['other/go'], `${kind}: only the other programme's goal starts`);
    assert.equal(results[0].name, 'goal:other/go', kind);
    assert.equal(f.log.filter((line) => /prog: its record .* is invalid/u.test(line)).length, 1, `${kind}: said once`);
    for (const name of ['one', 'two', 'draft']) assert.equal(f.files[`${GOALS}/${name}/LOG.md`], '', `${kind}: nothing is written into ${name}`);
  }
});

test('a record without phases is today\'s order: the phase-2 goal gets no session while phase 1 is in build', async () => {
  const f = goalFixture({ first: { repos: 'elsewhere' }, second: { phase: 2 } });
  f.files[RECORD_AT] = plainText();
  assert.equal((await createRunner({ deps: f.deps }).pass({ repo: 'memoro' })).ran, 0);
  assert.equal(f.calls.sessions.length, 0);
  assert.equal(f.files[`${GOALS}/second/LOG.md`], '');
});

test('when the runner archives the last goal of phase 1 in a stated programme, the goals and the stated dependency keep to their phases', async () => {
  const f = goalFixture({
    late: { stage: 'done', log: finishedLog('2026-08-31T10:00Z', 'done') },
    next: { phase: 2 },
    after: { phase: 3 },
  }, { now: ARCHIVE_NOW });
  f.files[RECORD_AT] = statedText({ 3: [2] });
  await createRunner({ deps: f.deps }).chores();
  assert.equal(f.files[`${GOALS}/late/GOAL.json`], undefined, 'archived');
  assert.equal(goalField(f.files[`${GOALS}/next/GOAL.json`], 'phase'), 1);
  assert.equal(goalField(f.files[`${GOALS}/after/GOAL.json`], 'phase'), 2);
  assert.deepEqual(JSON.parse(f.files[RECORD_AT]).phases, { order: 'stated', after: { 2: [1] } });
});

/** A programme with a phase-1 goal in build and drafts in phases 2 and 3; `record` is what its record says. */
function planFixture(record) {
  const f = goalFixture({ building: {}, d2: { stage: 'draft', phase: 2 }, d3: { stage: 'draft', phase: 3 } });
  if (record !== undefined) f.files[RECORD_AT] = record;
  for (const name of ['d2', 'd3']) f.files[`${GOALS}/${name}/GOAL.json`] = withGoal(f.files[`${GOALS}/${name}/GOAL.json`], { success_criteria: [] });
  return f;
}
const planned = (f) => f.calls.sessions.filter((call) => call.env.MC_ROLE === 'plan').map((call) => call.env.MC_GOAL);

test('a stated programme plans a draft on a second lane while phase 1 builds, and only one plan session at a time, also once its draft is in build', async () => {
  const f = planFixture(statedText());
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  f.answer = async (call) => {
    if (call.env.MC_ROLE === 'plan') f.files[`${GOALS}/d2/GOAL.json`] = withGoal(f.files[`${GOALS}/d2/GOAL.json`], { stage: 'build', success_criteria: [{ criterion: 'c', check: 'k', met: false }] });
    await gate;
    return okSession()(call);
  };
  const runner = createRunner({ deps: f.deps });
  const running = lanes(runner, 2);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.calls.sessions.map((call) => call.env.MC_ROLE).sort(), ['build-session:goal', 'plan'], 'the build and the plan session run together');
  assert.deepEqual(planned(f), ['prog/d2']);
  assert.equal((await runner.pass({ repo: 'memoro', lane: 3, tag: 'memoro#3' })).ran, 0, 'no second plan session, though d2 is in build now');
  assert.equal((await runner.pass({ repo: 'memoro', lane: 4, tag: 'memoro#4' })).ran, 0);
  assert.deepEqual(planned(f), ['prog/d2']);
  release();
  await Promise.all(running);
});

test('without phases stated, a plan session is not started while a session of the programme runs', async () => {
  for (const record of [undefined, plainText()]) {
    const f = planFixture(record);
    const { release } = gated(f);
    const runner = createRunner({ deps: f.deps });
    const running = lanes(runner, 2);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(planned(f), [], 'no plan session beside the build');
    release();
    await Promise.all(running);
  }
});

test('a plan session goes to the first draft that is free: a held or decision-claimed one is passed over in a stated programme, and holds the programme otherwise', async () => {
  const claim = JSON.stringify({ pid: 777 });
  for (const [kind, block] of [['held', (f, name) => { f.files[`${GOALS}/${name}/.hold.json`] = HOLD(); }], ['decision-claimed', (f, name) => { f.files[`${GOALS}/${name}/.decision.json`] = claim; }]]) {
    const make = (record) => {
      const f = goalFixture({ d1: { stage: 'draft' }, d2: { stage: 'draft', phase: 2 } }, { livePids: [777] });
      if (record !== undefined) f.files[RECORD_AT] = record;
      for (const name of ['d1', 'd2']) f.files[`${GOALS}/${name}/GOAL.json`] = withGoal(f.files[`${GOALS}/${name}/GOAL.json`], { success_criteria: [] });
      block(f, 'd1');
      return f;
    };
    const stated = make(statedText());
    await createRunner({ deps: stated.deps }).pass({ repo: 'memoro' });
    assert.deepEqual(planned(stated), ['prog/d2'], `${kind}: the phase-2 draft is planned`);
    const plain = make(undefined);
    assert.equal((await createRunner({ deps: plain.deps }).pass({ repo: 'memoro' })).ran, 0, `${kind}: with no record the held first draft holds the programme`);
    assert.deepEqual(planned(plain), []);
  }
  // Two drafts of one phase: the older is held, the younger is not offered.
  for (const record of [statedText(), undefined]) {
    const f = goalFixture({ older: { stage: 'draft' }, younger: { stage: 'draft' } });
    if (record !== undefined) f.files[RECORD_AT] = record;
    f.files[`${GOALS}/older/GOAL.json`] = withGoal(f.files[`${GOALS}/older/GOAL.json`], { success_criteria: [], created: '2026-11-01T10:00:00Z' });
    f.files[`${GOALS}/younger/GOAL.json`] = withGoal(f.files[`${GOALS}/younger/GOAL.json`], { success_criteria: [], created: '2026-11-02T10:00:00Z' });
    f.files[`${GOALS}/older/.hold.json`] = HOLD();
    assert.equal((await createRunner({ deps: f.deps }).pass({ repo: 'memoro' })).ran, 0);
    assert.deepEqual(planned(f), [], 'the younger draft is not planned past the older');
  }
});

/* ------------------------------------------------------------ the programme planning turn */

const PROG = '/w/programs/prog';
const TURN_STATE = '/w/runner/programme-turn/prog.json';
const readCheckout = (repo) => `/w/runner/work/programme-turn-prog/${repo}`;
const recordWith = (changes) => `${JSON.stringify({ ...JSON.parse(plainText()), ...changes }, null, 2)}\n`;

/** A programme `prog` with a record and a README and no goal, as a turn finds it; `goals` are goals it already holds. */
function programmeFixture({ record = plainText(), readme = true, goals = {}, ...options } = {}) {
  const f = goalFixture(goals, options);
  if (record !== null) f.files[RECORD_AT] = record;
  if (readme) f.files[`${PROG}/README.md`] = '# prog\n\nEnd: Done when it holds.\n';
  return f;
}
/** The desk's items as the runner's fake store reads them out of the fixture's files. */
function wireDesk(f) {
  const items = () => Object.entries(f.files).filter(([path]) => /^\/w\/martin\/items\/[^/]+\/item\.json$/u.test(path)).map(([, text]) => JSON.parse(text));
  f.deps.deskItems = { list: items, read: (id) => items().find((item) => item.id === id) ?? null };
  return items;
}
/** What a turn's session leaves in the programme: goals as `mc goal new` and `mc goal stage` write them. */
function writesGoals(f, goals) {
  for (const [name, { stage = 'draft', phase = 1 }] of Object.entries(goals)) {
    const text = goalJson({ stage, status: 'ready', phase, repos: ['memoro'], title: name, goal: [], prs: [] });
    f.files[`${GOALS}/${name}/GOAL.json`] = stage === 'draft' ? withGoal(text, { success_criteria: [] }) : text;
    f.files[`${GOALS}/${name}/LOG.md`] = '';
    f.dirs.add(`${GOALS}/${name}/memoro`);
  }
}
const turnSessions = (f) => f.calls.sessions.filter((call) => call.env.MC_PROGRAMME === 'prog' && !call.env.MC_GOAL);
const turnState = (f) => JSON.parse(f.files[TURN_STATE]);
const draftPlans = (f) => planned(f).filter(Boolean);
const noRunnableTurn = (runner) => runner.nextWork()?.name !== 'programme:prog';

test('programme turn: a recorded open programme with a README and no goals gets one turn at the next pick, sequential and stated alike', async () => {
  for (const [kind, record] of [['sequential', plainText()], ['stated', statedText()]]) {
    const f = programmeFixture({ record });
    const runner = createRunner({ deps: f.deps });
    assert.equal(runner.nextWork().name, 'programme:prog', `${kind}: the turn is the pick`);
    const seen = {};
    f.answer = (call) => {
      seen.currents = Object.entries(f.files).filter(([path]) => path.startsWith('/w/runner/current-')).map(([, text]) => JSON.parse(text));
      seen.claimed = runner.claims.has('programme:prog');
      seen.next = runner.nextWork()?.name ?? null;
      return okSession()(call);
    };
    const result = await runner.pass({ repo: 'memoro' });
    assert.deepEqual([result.ran, result.name], [1, 'programme:prog'], kind);
    const [call, ...rest] = f.calls.sessions;
    assert.equal(rest.length, 0, `${kind}: one session`);
    assert.deepEqual([call.env.MC_ROLE, call.env.MC_HEADLESS, call.env.MC_PROGRAMME], ['plan', '1', 'prog'], kind);
    assert.equal('MC_GOAL' in call.env, false, `${kind}: no MC_GOAL`);
    assert.ok(call.unsetEnv.includes('MC_GOAL'), `${kind}: an inherited MC_GOAL is removed`);
    assert.equal(call.cwd, PROG, `${kind}: in the programme directory`);
    assert.match(call.prompt, new RegExp(`${PROG}/README\\.md`, 'u'), kind);
    assert.match(call.prompt, /\bEnd\b/u, kind);
    assert.deepEqual(seen.currents.map((current) => [current.name, current.kind, current.programme]), [['programme:prog', 'plan', 'prog']], `${kind}: its current record while it runs`);
    assert.equal(seen.claimed, true, `${kind}: its claim while it runs`);
    assert.equal(seen.next, null, `${kind}: no second turn of the programme while it runs`);
    assert.equal(Object.keys(f.files).some((path) => path.startsWith('/w/runner/current-')), false, `${kind}: the current record is gone after it`);
    assert.equal(runner.claims.has('programme:prog'), false, `${kind}: the claim is released`);
    const rows = runRows(f.files);
    assert.deepEqual(rows.map((row) => [row.name, row.kind]), [['programme:prog', 'plan']], kind);
  }
});

test('programme turn: no turn for a programme that is not eligible, and another programme\'s goal still starts in the same pass', async () => {
  const goalAt = (path) => (f) => { f.files[path] = goalJson({ stage: 'draft', status: 'Martin', phase: 1, repos: ['memoro'], title: 'x', goal: [], prs: [] }); };
  const table = [
    ['no record', (f) => { delete f.files[RECORD_AT]; }],
    ['an invalid record', (f) => { f.files[RECORD_AT] = '{ not json'; }],
    ['a record in state done', (f) => { f.files[RECORD_AT] = recordWith({ state: 'done' }); }],
    ['no README.md', (f) => { delete f.files[`${PROG}/README.md`]; }],
    ['a draft in goals/', goalAt(`${GOALS}/a-draft/GOAL.json`)],
    ['a goal directory with no goal file', (f) => { f.files[`${GOALS}/unreadable/LOG.md`] = ''; }],
    ['an entry in goals/.archive/', (f) => { f.files[`${GOALS}/.archive/old/LOG.md`] = ''; }],
    ['an open desk item of kind programme', (f) => { wireDesk(f); f.files['/w/martin/items/x/item.json'] = JSON.stringify({ id: 'x', kind: 'programme', reference: 'programme:prog', state: 'for-martin', sort: 'mechanical', reversible: false, due_at: null }); }],
    ['a horizon that is reached', (f) => { f.files[RECORD_AT] = recordWith({ horizon: 'h' }); f.deps.horizon = () => ({ state: 'reached' }); }],
    ['a horizon that is dropped', (f) => { f.files[RECORD_AT] = recordWith({ horizon: 'h' }); f.deps.horizon = () => ({ state: 'dropped' }); }],
    ['a horizon that is missing', (f) => { f.files[RECORD_AT] = recordWith({ horizon: 'h' }); f.deps.horizon = () => null; }],
  ];
  for (const [kind, make] of table) {
    const f = programmeFixture();
    make(f);
    const runner = createRunner({ deps: f.deps });
    assert.ok(noRunnableTurn(runner), `${kind}: programmeWork offers no candidate`);
    assert.equal((await runner.pass({ repo: 'memoro' })).ran, 0, kind);
    assert.deepEqual(turnSessions(f), [], `${kind}: no session`);
    assert.equal(f.files[TURN_STATE], undefined, `${kind}: nothing counted`);
  }
  // Dot-entries of goals/ are not goals: the programme is eligible.
  const dots = programmeFixture();
  dots.files[`${GOALS}/.hold.json`] = '{}';
  assert.equal(createRunner({ deps: dots.deps }).nextWork().name, 'programme:prog', 'a dot-entry alone is no goal');
  // A horizon that is not open is said once over two passes.
  const reached = programmeFixture({ record: recordWith({ horizon: 'h' }) });
  reached.deps.horizon = () => ({ state: 'reached' });
  const runner = createRunner({ deps: reached.deps });
  await runner.pass({ repo: 'memoro' }); await runner.pass({ repo: 'memoro' });
  assert.equal(reached.log.filter((line) => /prog: its horizon h reads reached/u.test(line)).length, 1, 'said once while it lasts');
  // An eligible programme beside another programme's build: the build starts, the turn follows on the next pass.
  const both = programmeFixture();
  both.files['/w/programs/other/goals/go/GOAL.json'] = goalJson({ repos: ['memoro'], title: 'go', goal: [] });
  both.files['/w/programs/other/goals/go/LOG.md'] = '';
  both.dirs.add('/w/programs/other/goals/go/memoro');
  const together = createRunner({ deps: both.deps });
  both.answer = (call) => { if (call.env.MC_GOAL) both.files['/w/programs/other/goals/go/GOAL.json'] = withGoal(both.files['/w/programs/other/goals/go/GOAL.json'], { stage: 'done' }); return okSession()(call); };
  assert.equal((await together.pass({ repo: 'memoro' })).name, 'goal:other/go', 'the build is the first pick');
  assert.deepEqual(turnSessions(both), []);
  assert.equal((await together.pass({ repo: 'memoro' })).name, 'programme:prog', 'the turn follows');
  assert.equal(turnSessions(both).length, 1);
});

/** A programme with one ready draft, as a turn leaves it. */
function draftedProgramme(record) {
  const f = programmeFixture({ record, goals: { d1: { stage: 'draft' } } });
  f.files[`${GOALS}/d1/GOAL.json`] = withGoal(f.files[`${GOALS}/d1/GOAL.json`], { success_criteria: [] });
  return f;
}

test('programme turn: while a turn is claimed or current no next-draft plan session of its programme starts — at the pick or at its admission — and one does once it has ended', async () => {
  for (const [kind, record] of [['sequential', plainText()], ['stated', statedText()]]) {
    // (a) The claim taken, no current record yet: the pick offers the draft to nobody.
    const claimed = draftedProgramme(record);
    const held = createRunner({ deps: claimed.deps });
    assert.equal(held.nextWork().name, 'goal:prog/d1', `${kind}: without the claim the draft is the pick`);
    held.claims.add('programme:prog');
    assert.equal(held.nextWork(), null, `${kind}: claim only — no pick`);
    assert.equal((await held.pass({ repo: 'memoro' })).ran, 0, `${kind}: claim only — no session`);
    assert.deepEqual(draftPlans(claimed), [], kind);
    held.claims.delete('programme:prog');
    assert.equal(held.nextWork().name, 'goal:prog/d1', `${kind}: the claim released, the draft is the pick`);

    // (c) The claim taken while a next-draft session is admitted: it yields and launches nothing.
    const admitted = draftedProgramme(record);
    const admitting = createRunner({ deps: admitted.deps });
    admitted.deps.attachDeps = async () => { admitting.claims.add('programme:prog'); return { ok: true }; };
    assert.equal((await admitting.pass({ repo: 'memoro' })).ran, 0, `${kind}: admission`);
    assert.deepEqual(admitted.calls.sessions, [], `${kind}: nothing launched at admission`);
    assert.match(admitted.log.join('\n'), /goal:prog\/d1: programme changed during admission/u, kind);
    assert.equal(where(admitted, 'd1'), 'draft · ready', `${kind}: the draft is as it was`);

    // (b) The turn current, a second lane's pass; (d) the turn ended, the next pass plans its draft.
    const f = programmeFixture({ record });
    const runner = createRunner({ deps: f.deps });
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    f.answer = async (call) => {
      if (call.env.MC_PROGRAMME) { writesGoals(f, { d1: {} }); await gate; }
      return okSession()(call);
    };
    const turn = runner.pass({ repo: 'memoro', lane: 1, tag: 'memoro#1' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(Object.entries(f.files).some(([path, text]) => path.startsWith('/w/runner/current-') && JSON.parse(text).name === 'programme:prog'), `${kind}: the turn is current`);
    assert.equal(where(f, 'd1'), 'draft · ready');
    assert.equal((await runner.pass({ repo: 'memoro', lane: 2, tag: 'memoro#2' })).ran, 0, `${kind}: current — the second lane starts nothing`);
    assert.deepEqual(draftPlans(f), [], `${kind}: no plan session while the turn is current`);
    release();
    assert.equal((await turn).name, 'programme:prog');
    assert.equal(runner.claims.has('programme:prog'), false);
    assert.equal((await runner.pass({ repo: 'memoro' })).name, 'goal:prog/d1', `${kind}: after the turn the draft is planned`);
    assert.deepEqual(draftPlans(f), ['prog/d1'], kind);
  }
});

test('programme turn: a turn that leaves goals writes no failure and no item; the draft it left is next-draft planning\'s, stated programme', async () => {
  const f = programmeFixture({ record: statedText() });
  const items = wireDesk(f);
  f.answer = (call) => {
    if (call.env.MC_PROGRAMME) writesGoals(f, { one: { stage: 'build', phase: 1 }, two: { phase: 2 } });
    return okSession()(call);
  };
  const runner = createRunner({ deps: f.deps });
  assert.equal((await runner.pass({ repo: 'memoro' })).name, 'programme:prog');
  assert.match(runRows(f.files)[0].note, /2 goals$/u, 'the note says how many goals the programme holds');
  assert.equal(f.files[TURN_STATE], undefined, 'no failure');
  assert.deepEqual(items(), [], 'no item');
  assert.equal(where(f, 'two'), 'draft · ready', 'the draft left is not set Martin');
  assert.equal(where(f, 'one'), 'build · ready');
  await lane(runner, 'memoro');
  assert.ok(draftPlans(f).includes('prog/two'), 'next-draft planning takes it');
  assert.deepEqual(turnSessions(f).length, 1, 'and no second turn');
});

test('programme turn: a turn that leaves goals writes no failure and no item; the draft it left waits for the sequential trigger', async () => {
  const f = programmeFixture({ record: plainText() });
  const items = wireDesk(f);
  f.answer = (call) => {
    if (call.env.MC_PROGRAMME) writesGoals(f, { one: { stage: 'build', phase: 1 }, two: { phase: 2 } });
    return okSession()(call);
  };
  const runner = createRunner({ deps: f.deps });
  assert.equal((await runner.pass({ repo: 'memoro' })).name, 'programme:prog');
  assert.match(runRows(f.files)[0].note, /2 goals$/u);
  assert.equal(f.files[TURN_STATE], undefined, 'no failure');
  assert.deepEqual(items(), [], 'no item');
  assert.equal(where(f, 'two'), 'draft · ready');
  await lane(runner, 'memoro');
  assert.deepEqual(draftPlans(f), [], 'while the staged goal is in build, no plan session for the draft');
  f.files[`${GOALS}/one/GOAL.json`] = withGoal(f.files[`${GOALS}/one/GOAL.json`], { stage: 'done' });
  assert.equal((await runner.pass({ repo: 'memoro' })).name, 'goal:prog/two', 'once it is done the draft is planned');
  assert.deepEqual(draftPlans(f), ['prog/two']);
});

test('programme turn: the second failure opens a prepared item, a closed one lets the turn start again, two more open a for-martin brief', async () => {
  const f = programmeFixture();
  const items = wireDesk(f);
  let clock = Date.parse('2026-11-15T09:00:00Z');
  f.deps.now = () => new Date(clock += 60_000);
  const runner = createRunner({ deps: f.deps });
  const pass = async () => (await runner.pass({ repo: 'memoro' })).ran;
  assert.equal(await pass(), 1);
  assert.equal(turnState(f).failures.length, 1, 'one failure written');
  assert.match(turnState(f).failures[0].reason, /^planning session exited 0 with the programme holding no goal/u);
  assert.deepEqual(items(), [], 'the first failure opens nothing and the next pick may try again');
  assert.equal(await pass(), 1, 'tried again');
  assert.equal(turnState(f).failures.length, 2);
  const [first] = items();
  assert.deepEqual([first.kind, first.reference, first.state, first.sort, first.reversible, first.due_at], ['programme', 'programme:prog', 'prepared', 'mechanical', null, null]);
  const dir = itemDirectory(first, f.deps.env);
  const prepared = f.files[`${dir}/prepared.md`];
  assert.equal(turnState(f).failures.filter((failure) => prepared.includes(failure.reason)).length, 2, 'prepared.md names both reasons');
  for (const failure of turnState(f).failures) assert.ok(prepared.includes(failure.log), 'and both session logs');
  assert.ok(`${dir}/item.json` in f.files);
  // The item is the decision lane's; no turn starts while it is open.
  f.answer = okSession();
  const before = turnSessions(f).length;
  runner.claims.add('x');
  assert.ok(noRunnableTurn(runner), 'no turn while the item is open');
  runner.claims.delete('x');
  assert.equal(turnSessions(f).length, before);
  // Closed by decision: the turn starts again; two more failures open a for-martin item.
  f.files[`${dir}/item.json`] = JSON.stringify({ ...first, state: 'closed', outcome: { by: 'decision', at: '2026-11-15T10:00:00Z' } });
  assert.equal(runner.nextWork().name, 'programme:prog', 'closed: the turn is due again');
  assert.equal(await pass(), 1);
  assert.equal(items().length, 1, 'one failure since the item opens nothing');
  assert.equal(await pass(), 1);
  const second = items().find((item) => item.id !== first.id);
  assert.deepEqual([second.kind, second.state, second.sort, second.reversible, second.due_at], ['programme', 'for-martin', 'mechanical', false, null]);
  const brief = f.files[`${itemDirectory(second, f.deps.env)}/brief.md`];
  assert.match(brief, /## Vad det gäller/u);
  assert.match(brief, /## Rekommendation och skäl/u);
  assert.equal(`${itemDirectory(second, f.deps.env)}/prepared.md` in f.files, false);
  assert.equal(turnState(f).items.length, 2);
  assert.ok(noRunnableTurn(runner), 'and no turn while that is open');
  assert.equal(await pass(), 0);
});

test('programme turn: a quota, an offline and a refused-login ending write no failure, and a missing state file reads as none', async () => {
  for (const [kind, ending] of [['quota', REFUSED_429], ['offline', UNREACHABLE], ['login', apiEndedSession('Not logged in · Please run /login', { api_error_status: null })]]) {
    const f = programmeFixture();
    wireDesk(f);
    f.answer = ending;
    const runner = createRunner({ deps: f.deps });
    assert.equal(f.files[TURN_STATE], undefined, `${kind}: no state file to begin with — no failures`);
    await runner.pass({ repo: 'memoro' });
    assert.equal(turnSessions(f).length, 1, kind);
    assert.equal(f.files[TURN_STATE], undefined, `${kind}: written nothing`);
    assert.deepEqual(Object.keys(f.files).filter((path) => path.startsWith('/w/martin/items/')), [], kind);
  }
});

test('programme turn: an unreadable state file starts no turn and is said once', async () => {
  for (const text of ['{ not json', JSON.stringify({ schema: 'mc-programme-turn', version: 1, programme: 'other', failures: [], items: [] })]) {
    const f = programmeFixture();
    f.files[TURN_STATE] = text;
    const runner = createRunner({ deps: f.deps });
    assert.ok(noRunnableTurn(runner));
    assert.equal((await runner.pass({ repo: 'memoro' })).ran, 0);
    await runner.pass({ repo: 'memoro' });
    assert.deepEqual(turnSessions(f), []);
    assert.equal(f.log.filter((line) => /prog: runner\/programme-turn\/prog\.json is unreadable/u.test(line)).length, 1, 'said once');
    assert.equal(f.files[TURN_STATE], text, 'left as it was');
  }
});

/** The runner's fake git with the read checkouts answered per repository: `dirty`, `unreachable` leftovers and `addFails` (repo → git's message). */
function servedCheckouts(f, { dirty = [], unreachable = [], addFails = {} } = {}) {
  const base = f.deps.git;
  const repoOf = (path) => String(path).split('/').at(-1);
  f.deps.git = (cwd, args) => {
    const inCheckout = String(cwd).startsWith('/w/runner/work/programme-turn-');
    if (inCheckout && args[0] === 'status') { f.calls.git.push([cwd, ...args]); return { ok: true, stdout: dirty.includes(repoOf(cwd)) ? ' M x' : '' }; }
    if (inCheckout && args[0] === 'merge-base') { f.calls.git.push([cwd, ...args]); return { ok: !unreachable.includes(repoOf(cwd)), stdout: '' }; }
    if (args[0] === 'worktree' && args[1] === 'add' && args.includes('--detach')) {
      f.calls.git.push([cwd, ...args]);
      const path = args.at(-2);
      if (repoOf(path) in addFails) return { ok: false, stdout: '', stderr: `Preparing worktree\nfatal: ${addFails[repoOf(path)]}` };
      f.dirs.add(path);
      return { ok: true, stdout: '' };
    }
    return base(cwd, args);
  };
  return (call) => call.slice(1).join(' ');
}
const gitOn = (f, path) => f.calls.git.filter((call) => call[0] === path || call.includes(path));
const TOUCHING = /^(reset|checkout|clean|restore|stash)\b|worktree remove|--force|-f\b/u;

test('programme turn: read checkouts over three served repositories — add --detach at origin/main for each, a remove for the clean leftover only, none for a dirty or an unreachable one, and no git call names plan/<programme>', () => {
  const root = '/w';
  const base = `${root}/runner/work/programme-turn-prog`;
  const repos = ['a', 'b', 'c'].map((name) => ({ name, path: `/repos/${name}` }));
  const world = ({ leftovers = [], dirty = [], unreachable = [] }) => {
    const present = new Set(leftovers.map((name) => `${base}/${name}`));
    const calls = [];
    const git = (cwd, args) => {
      calls.push([cwd, ...args]);
      if (args[0] === 'status') return { ok: true, stdout: dirty.some((name) => cwd.endsWith(`/${name}`)) ? ' M x' : '' };
      if (args[0] === 'merge-base') return { ok: !unreachable.some((name) => cwd.endsWith(`/${name}`)), stdout: '' };
      if (args[0] === 'worktree' && args[1] === 'remove') { present.delete(args[2]); return { ok: true, stdout: '' }; }
      if (args[0] === 'worktree' && args[1] === 'add') { present.add(args.at(-2)); return { ok: true, stdout: '' }; }
      return { ok: true, stdout: '' };
    };
    return { calls, git, present, exists: (path) => present.has(path) };
  };
  const text = (calls) => calls.map((call) => call.join(' '));
  const none = (calls) => assert.equal(text(calls).some((line) => line.includes('plan/prog')), false, 'no git call names plan/prog');

  const clean = world({ leftovers: ['a'] });
  const set = setUpReadCheckouts({ git: clean.git, root, programme: 'prog', repos, exists: clean.exists });
  assert.deepEqual(set, { ok: true, paths: { a: `${base}/a`, b: `${base}/b`, c: `${base}/c` } });
  for (const repo of repos) assert.ok(text(clean.calls).includes(`${repo.path} worktree add -q --detach ${base}/${repo.name} origin/main`), `${repo.name}: added detached at origin/main`);
  assert.deepEqual(text(clean.calls).filter((line) => line.includes('worktree remove')), [`/repos/a worktree remove ${base}/a`], 'the clean leftover is removed, and only it');
  assert.ok(text(clean.calls).indexOf(`/repos/a worktree remove ${base}/a`) < text(clean.calls).indexOf(`/repos/a worktree add -q --detach ${base}/a origin/main`), 'removed before it is added again');
  assert.deepEqual(removeReadCheckouts({ git: clean.git, root, programme: 'prog', repos, exists: clean.exists }), []);
  none(clean.calls);

  for (const [kind, options] of [['a dirty leftover', { dirty: ['b'] }], ['a status-clean leftover whose HEAD origin/main lacks', { unreachable: ['b'] }]]) {
    const held = world({ leftovers: ['b'], ...options });
    const refused = setUpReadCheckouts({ git: held.git, root, programme: 'prog', repos, exists: held.exists });
    assert.deepEqual(refused, { ok: false, retained: `${base}/b`, reason: `read checkout retained: ${base}/b` }, kind);
    assert.equal(text(held.calls).some((line) => line.includes(`worktree remove ${base}/b`) || line.includes(`worktree add -q --detach ${base}/b`)), false, `${kind}: never removed, never added over`);
    assert.equal(text(held.calls).some((line) => TOUCHING.test(line.split(' ').slice(1).join(' ')) && line.includes(`${base}/b`)), false, `${kind}: nothing that changes it`);
    assert.equal(held.present.has(`${base}/a`), false, `${kind}: the checkout made before it is taken down again`);
    assert.equal(text(held.calls).some((line) => line.includes(`${base}/c`)), false, `${kind}: none made after it`);
    assert.deepEqual(removeReadCheckouts({ git: held.git, root, programme: 'prog', repos, exists: held.exists }), [`${base}/b`], `${kind}: a removal after a turn leaves it too`);
    none(held.calls);
  }
});

test('programme turn: a leftover read checkout that is clean and reachable is removed and made again; the turn plans from all of them', async () => {
  const f = programmeFixture();
  servedCheckouts(f);
  f.dirs.add(readCheckout('memoro'));
  const during = [];
  f.answer = (call) => { during.push(['memoro', 'memoro-cli'].map((repo) => f.dirs.has(readCheckout(repo)))); return okSession()(call); };
  const runner = createRunner({ deps: f.deps });
  assert.equal((await runner.pass({ repo: 'memoro' })).ran, 1);
  const line = (call) => call.join(' ');
  assert.ok(f.calls.git.some((call) => line(call) === `/home/memoro worktree remove ${readCheckout('memoro')}`), 'the clean leftover removed through git');
  for (const repo of ['memoro', 'memoro-cli']) assert.ok(f.calls.git.some((call) => line(call) === `/home/${repo} worktree add -q --detach ${readCheckout(repo)} origin/main`), `${repo} added detached at origin/main`);
  assert.deepEqual(during, [[true, true]], 'both stand while the session runs');
  assert.match(f.calls.sessions[0].prompt, new RegExp(`${readCheckout('memoro')}`, 'u'));
  assert.match(f.calls.sessions[0].prompt, new RegExp(`${readCheckout('memoro-cli')}`, 'u'));
  assert.deepEqual(['memoro', 'memoro-cli'].map((repo) => f.dirs.has(readCheckout(repo))), [false, false], 'taken down after it');
  assert.equal(f.calls.git.some((call) => call.some((arg) => String(arg).includes('plan/prog'))), false, 'plan/prog is never named');
  assert.equal(f.calls.git.some((call) => call[0] === '/home/memoro' && call[1] === 'fetch'), true, 'fetched before the checkouts');
});

test('programme turn: a read checkout that holds work is retained — no session, the failure counted, said once, the second opening an item naming the path', async () => {
  for (const [kind, options] of [['dirty', { dirty: ['memoro-cli'] }], ['unreachable', { unreachable: ['memoro-cli'] }]]) {
    const f = programmeFixture();
    const items = wireDesk(f);
    servedCheckouts(f, options);
    const kept = readCheckout('memoro-cli');
    f.dirs.add(kept);
    const runner = createRunner({ deps: f.deps });
    const counts = [];
    for (let pass = 0; pass < 2; pass += 1) { await runner.pass({ repo: 'memoro' }); counts.push(turnSessions(f).length); }
    const [item] = items();
    assert.deepEqual([item.kind, item.state], ['programme', 'prepared'], kind);
    assert.ok(noRunnableTurn(runner), `${kind}: no turn while the item is open`);
    await runner.pass({ repo: 'memoro' }); counts.push(turnSessions(f).length);
    assert.deepEqual(counts, [0, 0, 0], `${kind}: no session on any pass`);
    assert.equal(f.log.filter((line) => line.includes(`read checkout retained: ${kept}`)).length, 1, `${kind}: said once`);
    const forbidden = f.calls.git.filter((call) => (call[0] === kept || call.includes(kept)) && !['status', 'merge-base'].includes(call[1]));
    assert.deepEqual(forbidden, [], `${kind}: no reset, checkout, clean, remove or add on the retained path`);
    assert.equal(f.calls.git.some((call) => call.includes('--force') || ['reset', 'clean', 'checkout'].includes(call[1])), false, kind);
    assert.ok(f.dirs.has(kept), `${kind}: still there`);
    assert.equal(f.dirs.has(readCheckout('memoro')), false, `${kind}: the checkout made before it is taken down again`);
    assert.deepEqual(turnState(f).failures.map((failure) => failure.reason), [`read checkout retained: ${kept}`, `read checkout retained: ${kept}`], kind);
    assert.ok(f.files[`${itemDirectory(item, f.deps.env)}/prepared.md`].includes(kept), `${kind}: prepared.md names the path`);
  }
});

test('programme turn: another failure to add a read checkout is a setup failure, and a failing fetch counts nothing', async () => {
  const f = programmeFixture();
  servedCheckouts(f, { addFails: { 'memoro-cli': 'invalid reference: origin/main' } });
  const runner = createRunner({ deps: f.deps });
  await runner.pass({ repo: 'memoro' });
  assert.deepEqual(turnSessions(f), []);
  assert.deepEqual(turnState(f).failures.map((failure) => failure.reason), ['setup: fatal: invalid reference: origin/main']);
  assert.equal(f.dirs.has(readCheckout('memoro')), false, 'the checkout made before it is taken down again');

  const offline = programmeFixture({ fetchFails: ['memoro-cli'] });
  const down = createRunner({ deps: offline.deps });
  await down.pass({ repo: 'memoro' });
  await down.pass({ repo: 'memoro' });
  assert.deepEqual(turnSessions(offline), []);
  assert.equal(offline.files[TURN_STATE], undefined, 'nothing counted');
  assert.ok(offline.log.some((line) => /programme:prog: fetch memoro-cli: could not read from remote — skip/u.test(line)));
  assert.equal(offline.calls.git.some((call) => call[1] === 'worktree'), false, 'no checkout made when a fetch failed');
});

/* ------------------------------------------------------------ the manager's horizon and curation turns */

const AREAS_FILE = JSON.stringify({ schema_version: 1, areas: [{ id: 'system', name: 'The system', covers: 'x', standards: [], paths: [], questions: [], page: 'docs/technical/areas/system.md' }] });
const MANAGER_STATE = '/w/runner/manager-turn/horizon/h1.json';
const CURATION_STATE = '/w/runner/manager-turn/curation.json';
const horizonCheckout = (repo) => `/w/runner/work/manager-horizon-h1/${repo}`;
const curationSeed = (started, bases = { memoro: 'a1', 'memoro-cli': 'b1' }) => JSON.stringify({ schema: 'mc-manager-turn', version: 1, kind: 'curation', started, bases });

/**
 * A runner with the manager's turns in view: `horizons` open in the fixture's `world`, both repositories declaring the
 * source area `system`, origin/main of each at the commit `world.heads` names, and the desk's items read out of the
 * fixture's files. Nothing else is due: no goal and no programme. With a horizon open the curation turn is held back
 * by a recent start (`seedCuration`), so the horizon turn is the only one in view.
 */
function managerFixture({ horizons = ['h1'], declaring = ['memoro', 'memoro-cli'], now = '2026-11-15T09:00:00Z', seedCuration = horizons.length > 0, ...options } = {}) {
  const f = goalFixture({}, { now, ...options });
  const items = wireDesk(f);
  const world = { horizons: Object.fromEntries(horizons.map((slug) => [slug, 'open'])), heads: { memoro: 'a1', 'memoro-cli': 'b1' }, ahead: {}, dirty: [], published: [], addFails: {} };
  f.world = world;
  if (seedCuration) f.files[CURATION_STATE] = curationSeed('2026-11-25T00:00:00Z');
  f.deps.horizons = () => Object.entries(world.horizons).filter(([, state]) => state === 'open').map(([slug]) => ({ slug, state: 'open' }));
  f.deps.horizon = (slug) => (slug in world.horizons ? { state: world.horizons[slug] } : null);
  const base = f.deps.git;
  const repoOf = (path) => String(path).split('/').at(-1);
  f.deps.git = (cwd, args) => {
    const repo = repoOf(cwd);
    const inRepo = cwd === `/home/${repo}`;
    if (inRepo && args[0] === 'show' && args[1] === 'origin/main:.mc/areas.json') {
      f.calls.git.push([cwd, ...args]);
      return declaring.includes(repo) ? { ok: true, stdout: AREAS_FILE } : { ok: false, stdout: '', stderr: 'fatal: path .mc/areas.json exists on disk, but not in origin/main' };
    }
    if (inRepo && args.join(' ') === 'rev-parse --verify -q origin/main') { f.calls.git.push([cwd, ...args]); return { ok: true, stdout: `${world.heads[repo]}\n` }; }
    if (args[0] === 'worktree' && args[1] === 'add' && (args.includes('--detach') || args.includes('-b'))) {
      f.calls.git.push([cwd, ...args]);
      const path = args.at(-2);
      if (repoOf(path) in world.addFails) return { ok: false, stdout: '', stderr: `fatal: ${world.addFails[repoOf(path)]}` };
      f.dirs.add(path);
      return { ok: true, stdout: '' };
    }
    const inTree = String(cwd).startsWith('/w/runner/work/manager-');
    if (inTree && args[0] === 'status') { f.calls.git.push([cwd, ...args]); return { ok: true, stdout: world.dirty.includes(repoOf(cwd)) ? ' M x' : '' }; }
    if (inTree && args[0] === 'merge-base') { f.calls.git.push([cwd, ...args]); return { ok: true, stdout: '' }; }
    if (inTree && args[0] === 'rev-list') { f.calls.git.push([cwd, ...args]); return { ok: true, stdout: `${world.ahead[repoOf(cwd)] ?? 0}\n` }; }
    if (inTree && args[0] === 'rev-parse' && args.includes('--verify') && String(args.at(-1)).startsWith('origin/manager/')) { f.calls.git.push([cwd, ...args]); return { ok: world.published.includes(repoOf(cwd)), stdout: 'tip\n' }; }
    if (args[0] === 'branch' && args[1] === '-D') { f.calls.git.push([cwd, ...args]); return { ok: true, stdout: '' }; }
    return base(cwd, args);
  };
  return { f, items, world };
}
const managerSessions = (f) => f.calls.sessions.filter((call) => call.env.MC_ROLE === 'manager');
const managerRows = (f) => runRows(f.files).filter((row) => row.kind === 'manager');
/** What a horizon session leaves: a programme record naming `slug`, as `mc programs create` writes it. */
const createsProgramme = (f, slug = 'h1') => { f.files['/w/programs/next/PROGRAMME.json'] = recordWith({ horizon: slug }); };
const deskItem = (f, id, fields) => {
  const item = { schema: 'mc-desk-item', version: 1, id, source_at: '2026-11-15T09:00:00Z', opened_at: '2026-11-15T09:00:00Z', state: 'for-martin', sort: 'mechanical', reversible: null, due_at: null, outcome: null, ...fields };
  f.files[`/w/martin/items/${id}/item.json`] = JSON.stringify(item);
};

test('manager turn: an open horizon with no record naming it gets one headless manager session in read checkouts at origin/main, large class, one run row', async () => {
  const { f } = managerFixture();
  const runner = createRunner({ deps: f.deps });
  assert.equal(runner.nextWork().name, 'manager');
  const seen = {};
  f.answer = (call) => {
    seen.currents = Object.entries(f.files).filter(([path]) => path.startsWith('/w/runner/current-')).map(([, text]) => JSON.parse(text));
    seen.claimed = runner.claims.has('manager');
    seen.next = runner.nextWork()?.name ?? null;
    seen.checkouts = ['memoro', 'memoro-cli'].map((repo) => f.dirs.has(horizonCheckout(repo)));
    createsProgramme(f);
    return okSession()(call);
  };
  const result = await runner.pass({ repo: 'memoro' });
  assert.deepEqual([result.ran, result.name], [1, 'manager']);
  const [call, ...rest] = f.calls.sessions;
  assert.equal(rest.length, 0, 'one session');
  assert.deepEqual([call.env.MC_ROLE, call.env.MC_HEADLESS, call.env.MC_HORIZON], ['manager', '1', 'h1']);
  for (const name of ['MC_GOAL', 'MC_PROGRAMME']) assert.ok(call.unsetEnv.includes(name), `${name} is removed`);
  assert.equal(call.unsetEnv.includes('MC_HORIZON'), false);
  for (const text of ['/horizons/h1/playback.md', horizonCheckout('memoro'), horizonCheckout('memoro-cli'), 'mc shot', 'mc programs create <name> --end', 'mc martin horizon reached h1', 'horizon:h1']) assert.ok(call.prompt.includes(text), text);
  assert.deepEqual(seen.currents.map((current) => [current.name, current.kind, current.class]), [['manager', 'manager', 'large']]);
  assert.equal(seen.claimed, true);
  assert.notEqual(seen.next, 'manager', 'no second manager turn while it runs');
  assert.deepEqual(seen.checkouts, [true, true], 'the checkouts stand while it runs');
  assert.deepEqual(['memoro', 'memoro-cli'].map((repo) => f.dirs.has(horizonCheckout(repo))), [false, false], 'removed after it');
  for (const repo of ['memoro', 'memoro-cli']) assert.ok(f.calls.git.some((git) => git.join(' ') === `/home/${repo} worktree add -q --detach ${horizonCheckout(repo)} origin/main`), `${repo}: detached at origin/main`);
  assert.equal(runner.claims.has('manager'), false);
  assert.equal(f.files[MANAGER_STATE], undefined, 'the record is the success: no failure written');
  assert.deepEqual(managerRows(f).map((row) => [row.name, row.kind]), [['manager:h1', 'manager']]);
  assert.notEqual(runner.nextWork()?.name, 'manager', 'a valid open record names h1: nothing is due');
});

test('manager turn: no turn while a record names the horizon, an item holds it, its state is unreadable or a record is invalid — those two said once', async () => {
  const table = [
    ['a valid open record names it', (f) => createsProgramme(f)],
    ['an open text item horizon:h1', (f) => deskItem(f, 't1', { kind: 'text', reference: 'text:t1', text: 'horizon:h1' })],
    ['an open manager item manager:h1', (f) => deskItem(f, 'm1', { kind: 'manager', reference: 'manager:h1', state: 'prepared' })],
    ['an unreadable state file', (f) => { f.files[MANAGER_STATE] = '{ not json'; }],
    ['an invalid record', (f) => { f.files['/w/programs/broken/PROGRAMME.json'] = '{ x'; }],
    ['the horizon is no longer open', (f, world) => { world.horizons.h1 = 'reached'; }],
  ];
  for (const [kind, arrange] of table) {
    const { f, world } = managerFixture();
    arrange(f, world);
    const runner = createRunner({ deps: f.deps });
    assert.notEqual(runner.nextWork()?.name, 'manager', kind);
    await runner.pass({ repo: 'memoro' });
    await runner.pass({ repo: 'memoro' });
    assert.deepEqual(managerSessions(f), [], kind);
    const said = f.log.filter((line) => /runner\/manager-turn\/horizon\/h1\.json is unreadable|the record of broken is invalid/u.test(line));
    assert.equal(said.length, ['an unreadable state file', 'an invalid record'].includes(kind) ? 1 : 0, `${kind}: said once, or not at all`);
  }
  // An invalid record holds the horizon turn of every horizon.
  const invalid = managerFixture({ horizons: ['h1', 'h2'] });
  invalid.f.files['/w/programs/broken/PROGRAMME.json'] = '{ x';
  assert.notEqual(createRunner({ deps: invalid.f.deps }).nextWork()?.name, 'manager');
  // An unreadable state of the first horizon leaves the second its turn.
  const second = managerFixture({ horizons: ['h1', 'h2'] });
  second.f.files[MANAGER_STATE] = '{ not json';
  const runner = createRunner({ deps: second.f.deps });
  assert.equal(runner.nextWork().name, 'manager');
  await runner.pass({ repo: 'memoro' });
  assert.equal(managerSessions(second.f)[0].env.MC_HORIZON, 'h2');
});

test('manager turn: each of the three endings is a success — a record, the horizon reached, an open text item — and counts nothing', async () => {
  for (const [kind, ends] of [
    ['a programme', (f) => createsProgramme(f)],
    ['the horizon reached', (f) => { f.world.horizons.h1 = 'reached'; }],
    ['a text item', (f) => deskItem(f, 't1', { kind: 'text', reference: 'text:t1', text: 'horizon:h1' })],
  ]) {
    const { f, items } = managerFixture();
    f.answer = (call) => { ends(f); return okSession()(call); };
    assert.equal((await createRunner({ deps: f.deps }).pass({ repo: 'memoro' })).ran, 1, kind);
    assert.equal(f.files[MANAGER_STATE], undefined, `${kind}: no failure`);
    assert.equal(items().filter((item) => item.kind === 'manager').length, 0, kind);
    assert.match(managerRows(f)[0].note, /,(programme|reached|text)$/u, kind);
  }
});

test('manager turn: a session that ends in none of them is a failure — the second opens a prepared item, a closed one lets the turn start again, two more open a for-martin brief', async () => {
  const { f, items } = managerFixture();
  let clock = Date.parse('2026-11-15T09:00:00Z');
  f.deps.now = () => new Date(clock += 60_000);
  const runner = createRunner({ deps: f.deps });
  const pass = async () => (await runner.pass({ repo: 'memoro' })).ran;
  const state = () => JSON.parse(f.files[MANAGER_STATE]);
  const managerItems = () => items().filter((item) => item.kind === 'manager');
  assert.equal(await pass(), 1);
  assert.equal(state().failures.length, 1);
  assert.match(state().failures[0].reason, /^horizon session exited 0: the session ended with no open programme record naming h1/u);
  assert.deepEqual(managerItems(), [], 'the first failure opens nothing');
  assert.equal(await pass(), 1);
  const [first] = managerItems();
  assert.deepEqual([first.reference, first.state, first.sort, first.reversible, first.due_at], ['manager:h1', 'prepared', 'mechanical', null, null]);
  const dir = itemDirectory(first, f.deps.env);
  for (const failure of state().failures) { assert.ok(f.files[`${dir}/prepared.md`].includes(failure.reason)); assert.ok(f.files[`${dir}/prepared.md`].includes(failure.log)); }
  assert.notEqual(runner.nextWork()?.name, 'manager', 'no turn while the item is open');
  await pass();
  assert.equal(managerSessions(f).length, 2, 'the open item holds the turn');
  f.files[`${dir}/item.json`] = JSON.stringify({ ...first, state: 'closed', outcome: { by: 'decision', at: '2026-11-15T10:00:00Z' } });
  assert.equal(runner.nextWork().name, 'manager', 'closed: due again');
  assert.equal(await pass(), 1);
  assert.equal(managerItems().length, 1, 'one failure since the item opens nothing');
  assert.equal(await pass(), 1);
  const second = managerItems().find((item) => item.id !== first.id);
  assert.deepEqual([second.state, second.reversible], ['for-martin', false]);
  assert.match(f.files[`${itemDirectory(second, f.deps.env)}/brief.md`], /^## Vad det gäller\n/u);
  assert.notEqual(runner.nextWork()?.name, 'manager');
});

test('manager turn: a quota, an offline and a refused-login ending count nothing', async () => {
  for (const [kind, ending] of [['quota', REFUSED_429], ['offline', UNREACHABLE], ['login', apiEndedSession('Not logged in · Please run /login', { api_error_status: null })]]) {
    const { f, items } = managerFixture();
    f.answer = ending;
    await createRunner({ deps: f.deps }).pass({ repo: 'memoro' });
    assert.equal(managerSessions(f).length, 1, kind);
    assert.equal(f.files[MANAGER_STATE], undefined, `${kind}: no failure written`);
    assert.deepEqual(items(), [], kind);
  }
});

test('manager turn: a read checkout that holds work and a failed add count, a failing fetch counts nothing, and no session starts on any of them', async () => {
  const { f, world } = managerFixture();
  const kept = horizonCheckout('memoro-cli');
  f.dirs.add(kept); world.dirty = ['memoro-cli'];
  const runner = createRunner({ deps: f.deps });
  await runner.pass({ repo: 'memoro' });
  assert.deepEqual(managerSessions(f), []);
  assert.deepEqual(JSON.parse(f.files[MANAGER_STATE]).failures.map((failure) => failure.reason), [`read checkout retained: ${kept}`]);
  await runner.pass({ repo: 'memoro' });
  assert.equal(f.log.filter((line) => line.includes(`read checkout retained: ${kept}`) && line.includes('no session started')).length, 1, 'said once');
  assert.equal(f.calls.git.some((call) => call.includes(kept) && ['reset', 'clean', 'checkout'].includes(call[1])), false, 'a retained checkout is never touched');
  assert.equal(f.calls.git.some((call) => call[1] === 'worktree' && call.includes(kept)), false);
  assert.ok(f.dirs.has(kept));

  const add = managerFixture();
  add.world.addFails = { 'memoro-cli': 'invalid reference: origin/main' };
  await createRunner({ deps: add.f.deps }).pass({ repo: 'memoro' });
  assert.deepEqual(JSON.parse(add.f.files[MANAGER_STATE]).failures.map((failure) => failure.reason), ['setup: fatal: invalid reference: origin/main']);
  assert.equal(add.f.dirs.has(horizonCheckout('memoro')), false, 'the checkout made before it is taken down again');

  const offline = managerFixture({ fetchFails: ['memoro-cli'] });
  await createRunner({ deps: offline.f.deps }).pass({ repo: 'memoro' });
  assert.deepEqual(managerSessions(offline.f), []);
  assert.equal(offline.f.files[MANAGER_STATE], undefined, 'a fetch that fails counts nothing');
});

test('manager turn: the due rule is read again after admission — a record made meanwhile leaves no session', async () => {
  const { f } = managerFixture();
  const runner = createRunner({ deps: f.deps });
  // `launch` is asked after the pick and before admission: the record appears there.
  const launch = f.deps.launch;
  f.deps.launch = (tool) => { createsProgramme(f); return launch(tool); };
  const result = await runner.pass({ repo: 'memoro' });
  assert.equal(result.ran, 0);
  assert.deepEqual(managerSessions(f), []);
  assert.match(f.log.join('\n'), /manager:h1: the horizon changed during admission/u);
  assert.equal(f.files[MANAGER_STATE], undefined);
});

test('curation turn: due at once with no state, in a worktree per declaring repository from origin/main, the cadence and the bases written, nothing opened on the desk', async () => {
  const { f, items, world } = managerFixture({ horizons: [] });
  let clock = Date.parse('2026-11-15T09:00:00Z');
  f.deps.now = () => new Date(clock);
  const runner = createRunner({ deps: f.deps });
  assert.equal(runner.nextWork().name, 'manager');
  const seen = {};
  f.answer = (call) => { seen.state = JSON.parse(f.files[CURATION_STATE]); seen.trees = f.calls.git.filter((git) => git[1] === 'worktree' && git[2] === 'add' && git.includes('-b')); return okSession()(call); };
  assert.equal((await runner.pass({ repo: 'memoro' })).ran, 1);
  const [call] = managerSessions(f);
  assert.deepEqual([call.env.MC_ROLE, call.env.MC_HEADLESS, 'MC_HORIZON' in call.env], ['manager', '1', false]);
  assert.ok(call.unsetEnv.includes('MC_HORIZON'));
  assert.match(call.cwd, /^\/w\/runner\/work\/manager-curation\/\d{8}T\d{6}Z$/u);
  assert.equal(seen.trees.length, 2);
  for (const tree of seen.trees) { assert.match(tree[5], /^manager\/curation-\d{8}T\d{6}Z$/u); assert.equal(tree.at(-1), 'origin/main'); }
  assert.deepEqual([seen.state.kind, seen.state.started, seen.state.bases], ['curation', '2026-11-15T09:00:00Z', {}], 'the cadence runs from the start, the bases are what the last success read');
  assert.deepEqual(JSON.parse(f.files[CURATION_STATE]).bases, world.heads, 'a success stores the commits it read');
  assert.match(managerRows(f)[0].note, /,curated$/u);
  assert.equal(managerRows(f)[0].name, 'manager:curation');
  assert.deepEqual(items(), []);
  assert.match(call.prompt, /Proposals, oldest first/u);
  // Not due again inside the 24 hours, whatever moved; after them only when main moved.
  world.heads.memoro = 'a2';
  clock += 23 * 3_600_000;
  assert.notEqual(runner.nextWork()?.name, 'manager');
  clock += 2 * 3_600_000;
  assert.equal(runner.nextWork().name, 'manager');
  world.heads.memoro = 'a1';
  clock += 120_000;
  assert.notEqual(runner.nextWork()?.name, 'manager', 'main has not moved past what the last curation read');
});

test('curation turn: a failed turn waits for the cadence and opens no item; a provider ending gives the cadence back; a published or empty worktree is removed, another kept and said once', async () => {
  const failed = managerFixture({ horizons: [] });
  failed.f.answer = () => ({ status: 1, stdout: '', stderr: 'boom', timedOut: false });
  const runner = createRunner({ deps: failed.f.deps });
  await runner.pass({ repo: 'memoro' });
  assert.match(managerRows(failed.f)[0].note, /^curation session exited 1/u);
  assert.ok(failed.f.log.some((line) => /manager:curation: curation failed/u.test(line)));
  assert.equal(JSON.parse(failed.f.files[CURATION_STATE]).started, '2026-11-15T09:00:00Z');
  assert.deepEqual(JSON.parse(failed.f.files[CURATION_STATE]).bases, {}, 'the bases stay what the last success read');
  assert.deepEqual(failed.items(), []);
  assert.notEqual(runner.nextWork()?.name, 'manager', 'bounded by the cadence');

  // A setup failure that is not the network's starts no session, spends the cadence and is said once, not every pick.
  const setup = managerFixture({ horizons: [] });
  setup.world.addFails = { 'memoro-cli': 'a branch named manager/curation-x already exists' };
  const setupRunner = createRunner({ deps: setup.f.deps });
  await setupRunner.pass({ repo: 'memoro' });
  assert.equal(managerSessions(setup.f).length, 0, 'no session');
  assert.deepEqual([JSON.parse(setup.f.files[CURATION_STATE]).started, JSON.parse(setup.f.files[CURATION_STATE]).bases], ['2026-11-15T09:00:00Z', {}]);
  assert.notEqual(setupRunner.nextWork()?.name, 'manager', 'bounded by the cadence');
  await setupRunner.pass({ repo: 'memoro' });
  assert.equal(setup.f.log.filter((line) => /manager:curation: no session started — setup:/u.test(line)).length, 1, 'said once');
  assert.deepEqual(setup.items(), []);

  const quota = managerFixture({ horizons: [] });
  quota.f.answer = REFUSED_429;
  await createRunner({ deps: quota.f.deps }).pass({ repo: 'memoro' });
  assert.equal(JSON.parse(quota.f.files[CURATION_STATE]).started, null, 'a provider ending gives the cadence back');

  // memoro's branch is published, memoro-cli's holds a commit that is not.
  const trees = managerFixture({ horizons: [] });
  trees.world.ahead = { memoro: 1, 'memoro-cli': 1 };
  trees.world.published = ['memoro'];
  await createRunner({ deps: trees.f.deps }).pass({ repo: 'memoro' });
  const stamped = (repo) => trees.f.calls.git.find((git) => git[1] === 'worktree' && git[2] === 'add' && git.at(-2).endsWith(`/${repo}`)).at(-2);
  assert.equal(trees.f.dirs.has(stamped('memoro')), false, 'the published worktree is removed');
  assert.equal(trees.f.dirs.has(stamped('memoro-cli')), true, 'the unpublished one is kept');
  assert.equal(trees.f.log.filter((line) => line.includes(`worktree ${stamped('memoro-cli')} was kept`)).length, 1, 'said once');
  assert.equal(trees.f.calls.git.some((git) => git[1] === 'worktree' && git[2] === 'remove' && git.at(-1) === stamped('memoro-cli')), false);
  assert.deepEqual(trees.items(), []);

  // Nothing to change: both empty, both removed, and it is a success.
  const empty = managerFixture({ horizons: [] });
  await createRunner({ deps: empty.f.deps }).pass({ repo: 'memoro' });
  assert.match(managerRows(empty.f)[0].note, /,curated$/u);
  assert.deepEqual([...empty.f.dirs].filter((dir) => /^\/w\/runner\/work\/manager-curation\/[^/]+\/[^/]+$/u.test(dir)), []);
});

test('curation turn: an unreadable state starts no turn and is said once; a horizon turn goes before a curation turn and the two share one claim', async () => {
  const { f } = managerFixture({ horizons: [] });
  f.files[CURATION_STATE] = '{ not json';
  const runner = createRunner({ deps: f.deps });
  assert.notEqual(runner.nextWork()?.name, 'manager');
  await runner.pass({ repo: 'memoro' }); await runner.pass({ repo: 'memoro' });
  assert.deepEqual(managerSessions(f), []);
  assert.equal(f.log.filter((line) => /runner\/manager-turn\/curation\.json is unreadable/u.test(line)).length, 1);
  assert.equal(f.files[CURATION_STATE], '{ not json');

  const both = managerFixture({ seedCuration: false });
  const second = createRunner({ deps: both.f.deps });
  assert.equal(second.nextWork().name, 'manager');
  both.f.answer = (call) => { if (call.env.MC_HORIZON) createsProgramme(both.f); return okSession()(call); };
  second.claims.add('manager');
  assert.notEqual(second.nextWork()?.name, 'manager', 'one claim: never side by side');
  second.claims.delete('manager');
  await second.pass({ repo: 'memoro' });
  await second.pass({ repo: 'memoro' });
  assert.deepEqual(managerSessions(both.f).map((call) => call.env.MC_HORIZON ?? null), ['h1', null], 'the horizon first, curation after');
});
