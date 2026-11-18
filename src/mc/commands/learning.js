import { lstatSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { commandUsage } from '../command-help.js';
import { areaKeysToName, declaredAreaKeys, keyProposalsDir } from '../area-proposals.js';
import { readDeskItem } from '../desk-items.js';
import { runLearningPass } from '../desk-learning.js';
import { readLesson, lessonWithLearning } from '../desk-lessons.js';
import { run as gitRun, tryGit } from '../git.js';
import { learningEligible, learningLine, writeLearning } from '../lesson-learning.js';
import { activeLearning, answerPublication, applyPublication, publicationAnswer, reconcileAreaLearning, updateLearning } from '../learning-publication.js';
import { areaRepositories, curationWorktreesDir, setUpCurationWorktrees } from '../manager-pulse.js';
import { workRoot } from '../paths.js';
import { defaultRepos } from '../repos.js';
import { realLock } from '../runner-lock.js';
import { scanArgs } from './flags.js';
import { run as gateRun } from './gate.js';
import { ghCommand, run as publishRun } from './publish.js';

const noArgs = ({ positional }) => positional.length ? 'mc learning takes no arguments' : null;
const one = ({ positional }) => positional.length !== 1 ? 'give exactly one name' : null;
const outs = ['accurate', 'missing', 'proposal', 'held'];
const areaKey = /^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/u;
export const ROUTES = {
  '': { check: noArgs },
  area: { check: one },
  record: { strictValues: outs.map(x => `--${x}`), check: ({ flags, ...args }) => one(args)
    || (outs.filter(x => flags[x] !== null).length !== 1 || !outs.some(x => flags[x]?.trim()) ? 'give one non-empty --accurate, --missing, --proposal or --held' : null) },
  publish: { strictValues: ['--source'], repeatable: ['--lesson'], check: ({ flags, ...args }) => one(args)
    || (!flags.lesson.length || !flags.source?.trim() ? 'publish needs --lesson and --source' : null) },
};

export function usage() { return commandUsage('learning'); }

export async function run(argv, deps = {}) {
  const env = deps.env || process.env;
  const stdout = deps.stdout || process.stdout, stderr = deps.stderr || process.stderr;
  const now = deps.now || (() => new Date());
  const cwd = deps.cwd || process.cwd();
  const say = (line) => { if (line) stdout.write(`${line}\n`); };
  const fail = (message, code = 2) => { stderr.write(`mc: ${message}\n`); return code; };
  const verb = Object.hasOwn(ROUTES, argv[0]) && argv[0] !== '' ? argv[0] : '';
  const parsed = scanArgs(verb ? argv.slice(1) : argv, ROUTES[verb]);
  const error = parsed.error || ROUTES[verb].check(parsed);
  if (error) return fail(`${error}\n${usage()}`);
  const git = deps.git || ((path, args) => { const r = gitRun(path, args); return { ...r, ok: r.status === 0 }; });
  const gh = deps.gh || ((path, args) => ghCommand(args, path));
  const repos = deps.repos || defaultRepos(env);
  if (!verb) {
    if (env.MC_HEADLESS === '1' || env.MC_ROLE || env.MC_GOAL || (env.MC_TOOL && env.MC_TOOL !== 'person')) return fail('only a person at the terminal starts mc learning; the runner has its own learning turn');
    reconcileAreaLearning({ env, now: now(), repos, gh, queue: deps.queue, say });
    const result = await (deps.pass || runLearningPass)({ env, now, manual: true, deps: { ...deps, repos, git, say } });
    if (!result.started) {
      if (result.reason) return fail(result.reason, 1);
      say('mc: no area information to update');
      return 0;
    }
    for (const line of result.account) say(line);
    if (!result.ok) return fail(`learning session did not complete (${result.note})`, 1);
    return 0;
  }
  const claim = activeLearning(env);
  if (!claim) return fail('this operation belongs to the active learning session — start with mc learning');
  const [name] = parsed.positional;
  const { flags } = parsed;
  if (verb === 'record') {
    try {
      const value = recordDisposition({ env, name, claim, flags, now: now(), repos, git });
      if (!value) return fail(`lesson ${name} already has a disposition for this evidence`);
      say(learningLine(value) || `mc: ${name} — ${value.state}`);
      return 0;
    } catch (err) { return fail(err.message); }
  }
  if (!areaKey.test(name)) return fail('name a declared <repo>/<area> (mc goal areas <repo>)');
  const [repoName, id] = name.split('/');
  const repo = areaRepositories({ repos: repos.filter(repo => repo.name === repoName), git }).repos[0];
  const page = repo?.areas.find(area => area.id === id)?.page;
  if (!repo || !page) return fail(`no declared area page for ${name}`);
  const root = workRoot(env);
  const stamp = `${claim.run}-${id}`;
  const path = join(curationWorktreesDir(root, stamp, 'learning'), repo.name);
  const branch = `learning/${stamp}`;
  if (verb === 'area') {
    const current = git(path, ['branch', '--show-current']);
    if (!current.ok || current.stdout.trim() !== branch) {
      const setup = setUpCurationWorktrees({ git, root, stamp, repos: [repo], kind: 'learning' });
      if (!setup.ok) return fail(setup.reason, 1);
    }
    say(`${path} · ${page}`);
    return 0;
  }
  if (resolve(cwd) !== path) return fail(`publish from the assigned worktree: mc learning area ${name}`);
  try {
    return await publishCorrection({ env, now, claim, path, branch, repo, id, page, flags, stdout, stderr, git, gh, say, deps });
  } catch (err) { return fail(err.message, 1); }
}

function eligible(name, env, claim, lesson = lessonWithLearning(readLesson(name, { env }), env)) {
  if (!lesson || !Object.hasOwn(claim.lessons, name) || claim.lessons[name] !== lesson.evidence) throw new Error(`lesson ${name} was not offered with this evidence; reconsider it in another turn`);
  return learningEligible(lesson, { manual: claim.manual }) ? lesson : null;
}

function recordDisposition({ env, name, claim, flags, now, repos, git }) {
  const state = flags.accurate ? 'already-accurate' : flags.missing ? 'insufficient-evidence' : flags.proposal ? 'repair-proposal' : 'held-decision';
  const reference = (flags.accurate || flags.missing || flags.proposal || flags.held).trim();
  if (state === 'held-decision' && readDeskItem(reference, { env })?.sort !== 'text') throw new Error('held decision needs an existing desk text item from mc martin propose');
  if (state === 'repair-proposal') {
    const keys = areaKeysToName(declaredAreaKeys(areaRepositories({ repos, git }).repos));
    const file = basename(reference);
    if (!/^\d{4}-\d{2}-\d{2}-(mc|memoro)-.+\.md$/u.test(file)
      || !keys.some(key => [join(keyProposalsDir(key, env), file), join(keyProposalsDir(key, env), 'archive', file)].includes(reference))
      || !lstatSync(reference, { throwIfNoEntry: false })?.isFile()) throw new Error('repair needs the path of an existing area proposal');
  }
  return updateLearning({ name, env, change: (current) => {
    if (!eligible(name, env, claim, current)) return null;
    const links = { ...current.learning?.links };
    if (['held-decision', 'repair-proposal'].includes(state)) links[state] = reference;
    return { state, reference, links, evidence: current.evidence, legacyBrief: current.learning?.legacyBrief, at: now.toISOString() };
  } });
}

async function publishCorrection({ env, now, claim, path, branch, repo, id, page, flags, stdout, stderr, gh, say, deps }) {
  const names = [...new Set(flags.lesson)];
  if (names.some(name => !eligible(name, env, claim))) { stderr.write('mc: publish needs lessons with actionable evidence\n'); return 2; }
  let receipt = '';
  let begun = false;
  const save = (change) => {
    for (const name of names) updateLearning({ name, env, change: ({ learning }) => learning?.state === 'publishing' && learning.branch === branch
      ? change(learning) : null });
  };
  const code = await (deps.publish || publishRun)(['--json'], {
    cwd: path, env, stdout: { write: text => { receipt += text; } }, stderr,
    ...deps.publishDeps,
    git: deps.publishDeps?.git || (args => tryGit(path, args)),
    gh: (args) => gh(path, args),
    learningArea: { repo: repo.name, id, page, branch },
    beforeLearningPush: async ({ head }) => {
      const gate = await (deps.gate || gateRun)([], { cwd: path, env, stdout, stderr });
      if (gate !== 0) return gate;
      const git = deps.publishDeps?.git || (args => tryGit(path, args));
      if (git(['rev-parse', 'HEAD']) !== head || git(['status', '--porcelain']) !== '') {
        stderr.write('mc: the area worktree changed during the gate; no publication\n'); return 1;
      }
      // Store the intended branch and examined evidence before anything can be published.
      realLock(workRoot(env), () => {
        const lessons = names.map(name => eligible(name, env, claim));
        if (lessons.some(x => !x || x.learning?.branch === branch)) throw new Error('this branch or lesson already has a publication attempt; use a new learning turn');
        for (const lesson of lessons) {
          const prior = lesson.learning;
          const attempts = prior?.evidence === lesson.evidence ? (prior.attempts ?? 0) + 1 : 1;
          writeLearning(lesson, { state: 'publishing', branch, head, pid: process.pid, repo: repo.name, area: `${repo.name}/${id}`,
            source: flags.source.trim(), evidence: lesson.evidence, attempts, at: now().toISOString(), links: prior?.links, legacyBrief: prior?.legacyBrief }, env);
        }
      }, { strict: true, name: 'area-learning' });
      begun = true;
      return 0;
    },
  });
  if (!begun) return code;
  const entry = lessonWithLearning(readLesson(names[0], { env }), env).learning;
  let answer;
  try {
    const pr = code === 0 ? JSON.parse(receipt) : publicationAnswer(entry, { repoPath: repo.path, gh });
    answer = answerPublication(entry, pr, { repoPath: repo.path, env, now: now(), queue: deps.queue });
  } catch (error) { stderr.write(`mc: learning publication handoff not confirmed: ${error.message}\n`); }
  // An unconfirmed network result remains discoverable by branch in ordinary chores.
  if (!answer) { save(learning => ({ ...learning, pid: null })); return 1; }
  save(learning => applyPublication(learning, answer));
  say(learningLine(answer));
  return Number(answer.state === 'publication-failed');
}
