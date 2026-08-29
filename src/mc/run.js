/**
 * `mc run` — the runner, inside mc.
 *
 * One round is one pass over the queue; one step is one fresh headless
 * session in one workarea, then the merge of the PR it opened. The runner
 * itself never calls a model: it reads files, runs git and gh, starts the
 * session through the launch adapter and waits for it. No inbox, no knock,
 * no watcher — it is the parent of the process it starts.
 *
 * Every process boundary is a dependency on `deps`, so the round can be
 * driven in a test with a fake git, gh, tmux and session and no network.
 * The rules themselves live in run-plan.js.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { resolveLaunch } from '../adapters/index.js';
import { NOT_A_DECISION, defaultRepos, listPlans, parsePlanFrontmatter, planFields } from './brief-collect.js';
import { workRoot } from './paths.js';
import { loadProfile, profileArgs } from './portrait.js';
import { readCanonRole } from './roles.js';
import { addWorktree } from './work-area.js';
import {
  QUOTA_SLEEP_MS, TIMEOUT_EXIT, assembleQueue, chooseKind, headlessArgs, isAnswered, readSessionOutput,
  reconcilePrompt, retireDecisions, sessionSettings, stepPrompt, triagePrompt, tsvHeader, tsvRow,
} from './run-plan.js';

export const REPO_NAMES = ['memoro', 'memoro-cli'];

/* ------------------------------------------------------------ real deps */

function sh(cmd, args, { cwd, timeout = 120_000 } = {}) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout, maxBuffer: 64 << 20 });
  return { ok: r.status === 0, status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

export function realDeps(env = process.env) {
  return {
    env,
    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
    git: (cwd, args) => sh('git', ['-C', cwd, ...args]),
    gh: (cwd, args) => sh('gh', args, { cwd }),
    tmuxHas: (name) => sh('tmux', ['has-session', '-t', name]).ok,
    exists: existsSync,
    read: (path) => { try { return readFileSync(path, 'utf8'); } catch { return null; } },
    list: (path) => { try { return readdirSync(path); } catch { return []; } },
    remove: (path) => { try { rmSync(path); return true; } catch { return false; } },
    write: (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); },
    append: (path, text) => { mkdirSync(dirname(path), { recursive: true }); appendFileSync(path, text); },
    addWorktree,
    profile: () => loadProfile({ env }),
    role: readCanonRole,
    launch: resolveLaunch,
    // The session: the adapter's binary with the headless argument list,
    // stdin closed (claude -p reads a piped stdin and would eat it), a
    // wall-clock cap after which it is killed and logged as a timeout.
    session: ({ bin, args, cwd, timeoutMs }) => {
      const r = spawnSync(bin, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs, killSignal: 'SIGTERM', maxBuffer: 256 << 20, env });
      const timedOut = r.error?.code === 'ETIMEDOUT' || (r.status == null && r.signal === 'SIGTERM');
      return { status: timedOut ? TIMEOUT_EXIT : (r.status ?? 1), stdout: r.stdout || '', stderr: r.stderr || (r.error ? String(r.error.message) : ''), timedOut };
    },
    log: (line) => process.stdout.write(`${line}\n`),
  };
}

/* --------------------------------------------------------------- runner */

export function createRunner({
  merge = true, deps = realDeps(),
} = {}) {
  const root = workRoot(deps.env);
  const paths = {
    queue: join(root, 'queue.md'),
    log: join(root, 'runner', 'log'),
    runs: join(root, 'runner', 'log', 'runs.tsv'),
    runnerLog: join(root, 'runner', 'log', 'runner.log'),
    stop: join(root, 'runner', 'STOP'),
  };
  const repos = defaultRepos(deps.env);
  const stamp = () => deps.now().toISOString().replace(/\.\d{3}Z$/u, 'Z');
  const say = (text) => {
    const line = `${stamp()}  ${text}`;
    deps.append(paths.runnerLog, `${line}\n`);
    deps.log(line);
  };
  const gitOut = (cwd, args) => { const r = deps.git(cwd, args); return r.ok ? String(r.stdout ?? '').trimEnd() : null; };
  const stopRequested = () => deps.exists(paths.stop);

  function planOf(worktree, name) {
    const base = join(worktree, 'docs', 'project');
    for (const programme of deps.list(base)) {
      const path = join(base, programme, name, 'PLAN.md');
      if (deps.exists(path)) {
        const text = deps.read(path) || '';
        return { path, programme, text, ...parsePlanFrontmatter(text), fields: planFields(text) };
      }
    }
    return null;
  }

  /** memoro | memoro-cli | null — an existing workarea first, then the main trees. */
  function repoOf(name, plans) {
    for (const repo of repos) if (deps.exists(join(root, name, repo.name, '.git'))) return repo;
    const plan = plans.find((p) => p.project === name);
    return plan ? repos.find((r) => r.name === plan.repo) || null : null;
  }

  /**
   * Merge origin/main into the area branch — never rebase. The one conflict
   * resolved here is an identical .gitignore hunk; anything else is left in
   * progress for a reconcile step.
   */
  function syncMain(worktree, name) {
    if (!deps.git(worktree, ['fetch', '-q', 'origin']).ok) return { ok: false, conflicts: [] };
    if (deps.git(worktree, ['merge', '-q', '--no-edit', 'origin/main']).ok) return { ok: true, conflicts: [] };
    const conflicts = (gitOut(worktree, ['diff', '--name-only', '--diff-filter=U']) || '').split('\n').filter(Boolean);
    if (conflicts.length === 1 && conflicts[0] === '.gitignore') {
      if (deps.git(worktree, ['checkout', '--theirs', '.gitignore']).ok && deps.git(worktree, ['add', '.gitignore']).ok && deps.git(worktree, ['commit', '-q', '--no-edit']).ok) return { ok: true, conflicts: [] };
    }
    say(`${name}: merge conflict in: ${conflicts.join(' ')}`);
    return { ok: false, conflicts };
  }

  function answeredDecisions(name, programme) {
    const files = new Set();
    for (const area of deps.list(root)) {
      const dir = join(root, area, 'decisions');
      for (const file of deps.list(dir)) {
        if (!file.endsWith('.md')) continue;
        const mine = area === name || file.startsWith(`${programme}-`) || file.startsWith(`${name}-`);
        if (mine && isAnswered(deps.read(join(dir, file)))) files.add(join(dir, file));
      }
    }
    return [...files].sort();
  }

  /**
   * Every `<area>/decisions/*.md` on disk, as `retireDecisions()` wants it.
   * The bookkeeping names are skipped by name, the way `scanDecisions()` does
   * it — `pm/decisions/log.md` is 358 kB of append-only log and one of its
   * lines starts with `**Beslut`.
   */
  function allDecisions() {
    const out = [];
    for (const area of deps.list(root)) {
      const dir = join(root, area, 'decisions');
      for (const file of deps.list(dir)) {
        if (!file.endsWith('.md') || NOT_A_DECISION.has(file)) continue;
        out.push({ area, base: file.replace(/\.md$/u, ''), path: join(dir, file), answered: isAnswered(deps.read(join(dir, file))) });
      }
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  /**
   * End of round: an answered decision whose plan has absorbed it is deleted,
   * so `decisions/` holds open questions and nothing else. Held and orphaned
   * files are said out loud rather than removed — see `retireDecisions()`.
   */
  function retireAnswered(plans) {
    const { remove, orphans, held } = retireDecisions({ decisions: allDecisions(), plans });
    for (const d of remove) {
      if (deps.remove(d.path)) say(`retired ${d.area}/decisions/${d.base}.md (applied in ${d.appliedBy.join(', ')})`);
      else say(`could not remove ${d.path}`);
    }
    for (const d of held) say(`kept ${d.area}/decisions/${d.base}.md — ${d.why}`);
    for (const d of orphans) say(`orphan ${d.area}/decisions/${d.base}.md — ${d.why}; answer it or delete it by hand`);
    return { removed: remove.length, held: held.length, orphans: orphans.length };
  }

  async function waitMergeable(worktree, pr) {
    let verdict = 'UNKNOWN';
    for (let i = 0; i < 12 && verdict === 'UNKNOWN'; i += 1) {
      const r = deps.gh(worktree, ['pr', 'view', String(pr), '--json', 'mergeable', '-q', '.mergeable']);
      verdict = (r.ok && r.stdout.trim()) || 'UNKNOWN';
      if (verdict === 'UNKNOWN') await deps.sleep(5000);
    }
    return verdict;
  }

  async function mergePr(worktree, name, pr) {
    const title = deps.gh(worktree, ['pr', 'view', String(pr), '--json', 'title', '-q', '.title']).stdout.trim();
    const squash = () => deps.gh(worktree, ['pr', 'merge', String(pr), '--squash', '--subject', `${title} (#${pr})`]);
    await waitMergeable(worktree, pr);
    let r = squash();
    if (r.ok) { say(`${name}: merged #${pr}`); deps.git(worktree, ['fetch', '-q', 'origin']); return true; }
    say(`${name}: merge of #${pr} failed: ${r.stderr.trim().split('\n').at(-1) || r.stdout.trim()}`);
    // Usually main moved during the step: bring it in and try once more. A
    // conflict is aborted here — the next round's reconcile step owns it; a
    // merge left in progress would make the worktree dirty and skipped forever.
    const sync = syncMain(worktree, name);
    if (!sync.ok) { deps.git(worktree, ['merge', '--abort']); say(`${name}: #${pr} needs reconcile next round`); return false; }
    if (deps.git(worktree, ['push', '-q', 'origin', 'HEAD']).ok) {
      await waitMergeable(worktree, pr);
      r = squash();
      if (r.ok) { say(`${name}: merged #${pr} (after syncing main)`); deps.git(worktree, ['fetch', '-q', 'origin']); return true; }
    }
    say(`${name}: #${pr} left open — could not merge`);
    return false;
  }

  /** One project. Returns 'ran' | 'skipped' | 'stop'. */
  async function runStep(name, plans) {
    if (stopRequested()) { say(`STOP file present (${paths.stop}) — not starting ${name}`); return 'stop'; }
    const repo = repoOf(name, plans);
    if (!repo) { say(`${name}: no workarea and no plan on main, skip`); return 'skipped'; }
    const worktree = join(root, name, repo.name);
    if (!deps.exists(worktree)) {
      say(`${name}: no workarea — creating ${repo.name} worktree from origin/main`);
      deps.git(repo.path, ['fetch', '-q', 'origin']);
      const added = deps.addWorktree({ name, repo: repo.path, branch: name, from: 'origin/main', env: deps.env });
      if (!added.ok) { say(`${name}: worktree add failed (${added.reason}), skip`); return 'skipped'; }
    }
    if (deps.tmuxHas(`mc-${name}`)) { say(`${name}: live tmux session, skip`); return 'skipped'; }
    if ((gitOut(worktree, ['status', '--porcelain']) || '').trim()) { say(`${name}: dirty worktree, skip`); return 'skipped'; }

    const sync = syncMain(worktree, name);
    if (!sync.ok && !sync.conflicts.length) { say(`${name}: fetch/merge failed, skip`); return 'skipped'; }
    const plan = sync.conflicts.length ? null : planOf(worktree, name);
    const answered = plan?.status === 'waiting-decision' ? answeredDecisions(name, plan.programme) : [];
    const choice = chooseKind({ plan, conflicts: sync.conflicts, answered });
    if (!choice.kind) { say(`${name}: ${choice.skip}, skip`); return 'skipped'; }
    const { kind } = choice;

    const role = deps.role(kind);
    if (!role?.overlay) { say(`${name}: canon/roles/${kind}.md is missing — skip`); return 'skipped'; }
    const settings = sessionSettings(plan?.fields || {});
    const launch = deps.launch(settings.tool);
    if (!launch?.ok) { say(`${name}: ${settings.tool} is not available (${launch?.hint || launch?.reason}), skip`); return 'skipped'; }
    const now = deps.now();
    const prompt = kind === 'reconcile'
      ? reconcilePrompt({ name, repo: repo.name, conflicts: sync.conflicts })
      : kind === 'triage'
        ? triagePrompt({ name, repo: repo.name, now })
        : stepPrompt({ name, repo: repo.name, planPath: plan.path, planText: plan.text, answered, now });
    const instructions = [await deps.profile(), role.overlay].filter(Boolean).join('\n\n---\n\n');
    const args = headlessArgs({ toolId: launch.id, adapter: launch.adapter, model: settings.model, instructions, prompt, profileArgs });

    const ts = stamp().replace(/[-:]/gu, '');
    const out = join(paths.log, `${name}-${ts}.json`);
    say(`${name}: ${kind} starting (${launch.shortName} ${settings.model}, ${settings.budgetMinutes} min)`);
    const t0 = deps.now().getTime();
    const result = deps.session({ bin: launch.spec.bin, args, cwd: worktree, timeoutMs: settings.budgetMinutes * 60_000 });
    const seconds = Math.round((deps.now().getTime() - t0) / 1000);
    deps.write(out, result.stdout);
    deps.write(`${out}.err`, result.stderr);

    if (kind === 'reconcile' && deps.git(worktree, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).ok) {
      deps.git(worktree, ['merge', '--abort']);
      say(`${name}: reconcile did not finish — merge aborted`);
    }
    const branch = gitOut(worktree, ['branch', '--show-current']) || name;
    const prList = deps.gh(worktree, ['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number', '-q', '.[0].number']);
    const pr = (prList.ok && prList.stdout.trim()) || '-';
    const read = readSessionOutput({ toolId: launch.id, stdout: result.stdout, stderr: result.stderr, exitCode: result.status, timedOut: result.timedOut });
    let { note } = read;
    if (merge && pr !== '-' && note === 'success') note = (await mergePr(worktree, name, pr)) ? 'success,merged' : 'success,open';

    if (!deps.exists(paths.runs)) deps.write(paths.runs, `${tsvHeader()}\n`);
    deps.append(paths.runs, `${tsvRow({ ts: stamp(), name, kind, exit: result.status, seconds, pr, turns: read.turns, input: read.input, output: read.output, cacheRead: read.cacheRead, cacheWrite: read.cacheWrite, session: read.session, note })}\n`);
    say(`${name}: ${kind} done rc=${result.status} ${seconds}s pr=${pr} turns=${read.turns} note=${note}`);
    if (read.quota) { say(`quota/rate limit seen — sleeping ${QUOTA_SLEEP_MS / 60000}m`); await deps.sleep(QUOTA_SLEEP_MS); }
    return 'ran';
  }

  /** The queue, re-read every round: queue.md, then every plan on origin/main. */
  function queue() {
    const plans = [];
    for (const repo of repos) {
      if (!deps.exists(join(repo.path, '.git'))) continue;
      deps.git(repo.path, ['fetch', '-q', 'origin']);
      plans.push(...listPlans(repo, { git: gitOut }));
    }
    return { names: assembleQueue(deps.read(paths.queue) || '', plans), plans };
  }

  /** One pass. Returns { ran, stop }. */
  async function round({ once = false } = {}) {
    const { names, plans } = queue();
    let ran = 0;
    for (const name of names) {
      const r = await runStep(name, plans);
      if (r === 'stop') return { ran, stop: true };
      if (r === 'ran') {
        ran += 1;
        if (once) return { ran, stop: false, once: true };
        await deps.sleep(60_000);
      }
      if (stopRequested()) { say(`runner exit on STOP after ${name} (remove ${paths.stop} before the next start)`); return { ran, stop: true }; }
    }
    // After the steps, so a decision applied by a step this round is retired
    // in the same round and the next brief never sees it. The plans are
    // re-read: a step that merged has changed the status this rests on.
    const retired = retireAnswered(queue().plans);
    return { ran, stop: false, retired };
  }

  return { paths, say, round, runStep, queue, stopRequested, syncMain, answeredDecisions, allDecisions, retireAnswered, mergePr, planOf, repoOf };
}

/**
 * The loop: rounds until `rounds` is reached (0 = forever), a STOP file
 * appears, or `--once` has run its one step.
 */
export async function runLoop({ rounds = 0, once = false, merge = true, idleSleepMs = 600_000, deps = realDeps() } = {}) {
  const runner = createRunner({ merge, deps });
  if (runner.stopRequested()) { runner.say(`STOP file present (${runner.paths.stop}) — remove it before starting`); return 2; }
  runner.say(`runner start (mc run, merge=${merge ? 1 : 0} rounds=${rounds} once=${once ? 1 : 0})`);
  let n = 0;
  while (rounds === 0 || n < rounds) {
    n += 1;
    const r = await runner.round({ once });
    if (r.stop) { runner.say(`runner exit on STOP (remove ${runner.paths.stop} before the next start)`); return 0; }
    if (r.once) { runner.say('once: exiting'); return 0; }
    runner.say(`round ${n} done (${r.ran} ran)`);
    if (r.ran === 0 && (rounds === 0 || n < rounds)) await deps.sleep(idleSleepMs);
  }
  runner.say(`runner exit after ${rounds} round(s)`);
  return 0;
}
