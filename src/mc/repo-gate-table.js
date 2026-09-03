/**
 * What each repository needs before its suite means anything.
 *
 * A gate worktree is a fresh checkout with no `node_modules` in it. For some
 * repositories that is fine and the suite runs; for others the suite cannot run
 * at all, or — far worse — runs a *subset* and reports a summary anyway. Two
 * such runs, one per side, produce two small red sets that match, and the gate
 * calls that green.
 *
 * The unfinished-run guard catches the first case and not the second, which is
 * why this file exists. It is a table of declarations, not a heuristic:
 *
 * The obvious heuristic — "it has dependencies, so install them" — still
 * cannot be read off a manifest. A repository can need a build step that has
 * nothing to do with `npm install`, and a manifest can name a package no test
 * file reaches. But the example this file gave for the second half was *this*
 * repository, and it was false: the entry below declared `prepare: null` beside
 * three dependencies, one of them native, on the strength of gate rounds that
 * had every one of them run the same five-files-short suite. So the shape this
 * table has actually got wrong is a null next to declared dependencies that
 * nothing installs, and `repo-gate-table.test.js` now reads the shipped entry
 * against `package.json` rather than against a sentence about it.
 *
 * So the rule is: what a repository needs is written down, or the round stops.
 * Never guessed, never attempted in hope. A guess that works nine times and
 * quietly produces a green from an incomplete suite on the tenth is worse than
 * a stop, because the stop is visible and the green is not.
 *
 * Two things can be *proved* rather than declared, and both carve-outs are
 * narrow on purpose. A repository with nothing to install has nothing that
 * could be missing. And a repository whose tree mc itself keeps above the
 * candidate — `work-deps.js`, one `node_modules` at the work root that the
 * gate's worktree and every workarea resolve through — has nothing for the
 * *round* to install: `prepare` says what the round must run, not whether the
 * suite has dependencies. The second one is only safe because it is not taken
 * on trust: `repo-gate.js` asks whether every declared name actually resolves
 * from the candidate, and stops when one does not.
 *
 * There are therefore three answers a declaration can give about preparation,
 * not two. `null` is a claim that none is needed and carries its evidence.
 * A command is a claim that this is what to run, and carries where that was
 * decided. `UNKNOWN` is the honest third: something about this repository is
 * known — which gates it needs, where it logs — and this part is not. It stops
 * the round exactly as hard as no entry at all, because a partial declaration
 * that let a round proceed would be the guess wearing a uniform.
 *
 * Written down, but not necessarily *here*. There are three places, read in
 * this order: what mc ships in this file, what a repository writes in its own
 * `.mc/test.json`, and what an operator writes in `~/mc/repo-gates.json`. The
 * middle layer is the one that was missing: how memoro tests itself is a fact
 * about memoro, and holding it in mc's source made every change to it a
 * memoro-cli release — two places answering one question about one repository,
 * which this file has already paid for once (the memoro entry said UNKNOWN for
 * a day while the operator table beside it carried the measurement). The rule
 * is unchanged; only the address is.
 *
 * The same rule reaches one field further than preparation. `--full` asks for
 * a repository's *whole* suite, and mc used to read that off `package.json`:
 * `npm test`, verbatim, on the argument that mc must not keep a second
 * definition of somebody else's suite. The argument holds; the assumption
 * under it did not. memoro's `npm test` is `node scripts/testing/ci.mjs`, a
 * diff-selector — and with no pull request to diff against, `--full` measured
 * `origin/main` against `origin/main` and ran 6 files of 2,018 while calling
 * it the whole suite. So `suite` is declared here beside `select`, and the
 * narrow rule that makes the old guess impossible is in `repo-gate.js`: a
 * declaration carrying `select` and no `suite` may not answer a `--full`. A
 * repository that declares a selector has said, by declaring one, that its
 * `npm test` is not the whole thing. One with no `select` is unaffected and
 * keeps `npm test`.
 *
 * And a `prepare_why` may never carry a provenance that does not exist. This
 * rule is written rather than tested because its content cannot be checked by
 * code: a string saying "declared by the PM" looks identical whether or not
 * anybody declared it. It got in here once — a `npm ci` for memoro attributed
 * to an order nobody gave — and it was worse than leaving the field blank,
 * because a false explanation looks reviewed. If a `source` names a decision,
 * that decision has to be findable in the decision log or in a written order.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { mcHome, workRoot } from './paths.js';

/** Preparation that is deliberately not known, as opposed to not needed. */
export const UNKNOWN = 'unknown';

/**
 * The declarations mc ships with.
 *
 * `merge_log` sits beside `runs.tsv` in `runner/log/`, one file per
 * repository. It used to be two arbitrary places: memoro's in
 * `pm/decisions/merge-log.md`, from when a resident PM kept the record, and
 * memoro-cli's in `large-scale-llm-project/merge-log.md` — a *workarea*, which
 * `mc run` is free to close. mc writing its own records into somebody's role
 * home and into a folder it can remove is the same mistake twice; the merge
 * log is a record of rounds, and rounds are logged under `runner/log/`.
 *
 * Data, not logic. Each entry says three things: what has to happen before the
 * suite can be believed, which gates beyond the suite the repository requires,
 * and where its merges are written down. `prepare: null` is a claim — that the
 * suite runs from a clean worktree — and `prepare_why` is the evidence for it,
 * because an unexplained null is indistinguishable from a forgotten one.
 */
export const SHIPPED = Object.freeze({
  'memoro-cli': Object.freeze({
    // Nothing for the *round* to run, because the tree is the environment's.
    // `src/runtime/session-host/` imports `@xterm/addon-serialize`,
    // `@xterm/headless` and `node-pty`, and five test files cannot run without
    // them — but the candidate now stands under the work root
    // (`paths.js`: `WORK_GATE` beside `WORK_DEPS`), so node's own parent walk
    // finds `~/mc/node_modules` two directories above it, the same tree every
    // workarea resolves. The `npm ci` this entry carried from 2026-09-02 was
    // true and was a second copy of a tree the candidate could already see.
    //
    // This null is not the old one. That one was a sentence — "verified across
    // every gate round" — and it was false for months while five files went
    // unrun and uncounted, because nothing measured it. `repo-gate.js` now
    // asks `dependencyTree` whether every declared name resolves from the
    // candidate, walking the parents as node does, and stops the round when
    // one does not. The field says what the round must run; the measurement
    // says whether the suite can run at all.
    prepare: null,
    prepare_why: 'nothing to install: mc keeps one tree at <work root>/node_modules (work-deps.js) and '
      + 'builds the candidate at <work root>/gate/<repo>/candidate, so the three declared packages '
      + 'resolve by node\'s parent walk with no node_modules inside the checkout. Measured 2026-09-03 '
      + 'on a gate round for #566: the five session-host files that need them ran green in a candidate '
      + 'with no node_modules of its own. Re-run it: mc test memoro-cli <pr> on a change reaching '
      + 'tests/runtime/session-host/ — and the round checks the resolution itself, so a broken tree '
      + 'stops it rather than shrinking the suite',
    // This repository's own answer to "what does this change reach": the import
    // closure of each test file, plus the source files a test reads as *text*
    // — which is a real edge here, not a hypothetical one. `merge-doc.test.js`
    // asserts against `repo-gate.js`'s source that no merge call is in it, and
    // an import graph cannot see that.
    select: 'node scripts/affected-tests.js --base-ref origin/main',
    select_why: 'measured 2026-08-30 on this repository\'s own gate work: 17 of 257 test files, '
      + '241 tests in 25 s, against 2,353 tests in ~100 s for the whole suite — twice, once a side. '
      + 'It fails closed to the full suite whenever a changed path is not source it can trace',
    // Its `npm test` really is everything, so `suite` says so rather than
    // exempting this repository from the rule. The declaration is the point:
    // "npm test happens to be the whole suite here" and "mc assumes npm test
    // is always the whole suite" produce the same command and are not the
    // same claim, and only the first one is checkable.
    suite: 'npm test',
    suite_why: 'its test script is `node --test --import ./tests/_isolate-home.mjs "tests/**/*.test.js"` '
      + '— a glob over the whole tree, not a selector; read off package.json 2026-09-02',
    extra_gates: Object.freeze([]),
    merge_log: Object.freeze({ under: 'work-root', path: 'runner/log/merge-memoro-cli.md' }),
    // The flag its own `test` script gives node, stated rather than parsed.
    pr_tests_flags: Object.freeze(['--import', './tests/_isolate-home.mjs']),
  }),
  memoro: Object.freeze({
    // Measured, not guessed (D-0089, delivered 2026-08-18; declared by the PM
    // in the operator table 2026-08-21, shipped here 2026-08-22). A clean
    // checkout without `npm ci`: exit 1, ~30 files fail with
    // ERR_MODULE_NOT_FOUND (typescript, fflate). With it, 6.6 s: the contract
    // suite 2352/2352 in 146 s — repeated with PLAYWRIGHT_BROWSERS_PATH at an
    // empty directory, identical, so no browser is needed; CI runs the same
    // two steps. This shipped entry existed as UNKNOWN beside the measured
    // override for a day, and mc's own reading of itself quoted the stale
    // half: two places answering one question about one repository.
    prepare: 'npm ci',
    prepare_why: 'measured in D-0089: without npm ci ~30 files fail with ERR_MODULE_NOT_FOUND; '
      + 'with it the contract suite is 2352/2352, no browser binaries involved (verified with an '
      + 'empty PLAYWRIGHT_BROWSERS_PATH); matches .github/workflows/msr-contract.yml',
    // How memoro lists what a change reaches (2026-08-30). Its `npm test` is
    // `scripts/testing/ci.mjs`, which selects by diff against the base and
    // follows the pin graph, so the list is the honest answer to "what does
    // this change touch" rather than a profile that rides every round.
    select: 'node scripts/testing/ci.mjs --list --json --base-ref origin/main',
    select_why: 'measured 2026-08-30: a documentation diff selected 332 files and 6 of them were '
      + 'the diff\'s; 326 were the always-on msr-contract profile. With that profile bound to its '
      + 'own surface and pin-following closing the blindness it covered, the same diff selects 6',
    // The whole suite, which `npm test` here is not: `ci.mjs` selects by diff,
    // so a `--full` round with no pull request diffed origin/main against
    // itself and ran the 6 mandatory-core files as if they were everything.
    // `test:full` is `node scripts/testing/run.mjs --profile full`, which
    // takes the registry rather than a diff.
    suite: 'npm run test:full',
    suite_why: 'measured 2026-09-02 on an Apple M1 (8 cores, 8 GB, machine not idle): '
      + '`npm run test:full` is 2,018 files and 17,928 tests in 337.42 s wall (~808 s of CPU across '
      + '7 lanes), with six tests red on main. The same day `node scripts/testing/ci.mjs --list '
      + '--base-ref HEAD` reported 0 changed paths and 6 selected files — which is what --full ran '
      + 'while `npm test` was assumed to be the whole suite',
    // No extra gates. `msr contract` was one until 2026-08-30, and it was the
    // same 326 files the suite already ran — `test:msr:contract` globs exactly
    // the `msr-contract` profile, so the round paid for that suite four times
    // over: both sides of `npm test`, then both sides of the gate. memoro's own
    // gate-consolidation plan says the same thing from its end — the contract
    // suite belongs inside `npm run ci`, not beside it.
    extra_gates: Object.freeze([]),
    merge_log: Object.freeze({ under: 'work-root', path: 'runner/log/merge-memoro.md' }),
    // Measured 2026-08-23: memoro's runner (scripts/testing/runner.mjs) runs
    // `node --test --import ./tests/_helpers/browser-paths.mjs`, which
    // rewrites `/js/…` imports; 3 of 1962 test files import that way. The
    // 14 files from one night's merged PRs gave 123/123 with and without the
    // import — so the gate's bare runs were right, and the three are the gap.
    pr_tests_flags: Object.freeze(['--import', './tests/_helpers/browser-paths.mjs']),
  }),
});

/** Where an operator can add or override a declaration without a release. */
export function tablePath(root = mcHome()) {
  return join(root, 'repo-gates.json');
}

/** Where a repository writes its own half of the declaration, in its own tree. */
export function repoDeclarationPath(repoPath) {
  return join(repoPath, '.mc', 'test.json');
}

/**
 * The repository's own declaration, if it has written one.
 *
 * Three answers, and the third is why this is not a one-liner. Absent means
 * the repository has said nothing and the shipped table answers alone — the
 * case that has to keep behaving exactly as it did. Present and readable is a
 * layer. Present and unreadable is a **stop**: a file that will not parse is a
 * repository that tried to say something mc could not hear, and falling back
 * to the shipped table there would run a round on an instruction somebody
 * believes they replaced. That is the same failure as a partial declaration,
 * and it stops exactly as hard.
 *
 * The operator's file at `~/mc/repo-gates.json` deliberately keeps the
 * opposite behaviour — a broken file there hides no declaration, because it is
 * additions on top of one. Here the file *is* the repository's declaration.
 */
function readRepoDeclaration(repoPath) {
  const path = repoDeclarationPath(repoPath);
  if (!existsSync(path)) return { present: false, entry: null };
  let parsed = null;
  try { parsed = JSON.parse(readFileSync(path, 'utf8')); } catch (error) {
    return { present: true, entry: null, error: `it could not be read as JSON (${error.message})` };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { present: true, entry: null, error: 'it does not hold a JSON object of declaration fields' };
  }
  return { present: true, entry: parsed };
}

/** Which of the three files each field of a declaration came from. */
function layerSources({ shipped, own, override }) {
  const sources = {};
  if (override) {
    for (const field of Object.keys(override)) sources[field] = 'override';
    return sources;
  }
  for (const field of Object.keys(shipped || {})) sources[field] = 'shipped';
  for (const field of Object.keys(own || {})) sources[field] = 'repository';
  return sources;
}

/**
 * The declaration for a repository, or the reason there is none.
 *
 * `ok: false` is a stop, and the round has to treat it as one. The caller is
 * not offered a default to fall back on, because a default is the guess this
 * whole file exists to refuse.
 *
 * Three layers, in order: what mc ships, what the repository writes in
 * `.mc/test.json`, what the operator writes in `~/mc/repo-gates.json`. The
 * middle one exists because how memoro tests itself is a fact about memoro,
 * and holding it here made every change to it a memoro-cli release. The
 * operator's file stays the last word — it is how a machine-local fact gets in
 * without a release at all.
 *
 * The two upper layers merge differently on purpose. The repository's file is
 * merged **field by field**: it is written by a repository about itself, and
 * it cannot know facts that are not its own — where its merges are logged is
 * one, and a whole-entry replacement would make a file that says `select` drop
 * `merge_log` in silence, which is the hole D-0135 already cost this table
 * twice. The operator's file keeps replacing the entry whole, as it always
 * has, and the fields it drops are still named in `shadowed`.
 */
export function declarationFor(repoPath, { root = mcHome(), env = process.env } = {}) {
  const name = basenameOf(repoPath);
  const own = readRepoDeclaration(repoPath);
  if (own.error) {
    return {
      ok: false,
      name,
      reason: `${name} declares itself in ${repoDeclarationPath(repoPath)}, but ${own.error}. `
        + 'mc will not fall back to what it ships when a repository has tried to say something else — '
        + 'that would run the round on an instruction somebody believes they replaced. '
        + 'Fix that file, or delete it and let the shipped table answer.',
    };
  }

  const shipped = SHIPPED[name];
  const overrides = readOverrides(root);
  const overridden = overrides[name];
  // The repository's layer on top of the shipped one, then the operator's
  // whole entry if there is one.
  const base = own.entry ? { ...(shipped || {}), ...own.entry } : shipped;
  const declared = overridden || base;

  // A repository file can declare a repository mc ships nothing for — and
  // then it has to state its preparation, like any other declaration. Saying
  // `select` and nothing else is exactly the partial declaration this file
  // refuses, and without this it would quietly mean "prepare: null".
  if (own.entry && !overridden && !shipped && !('prepare' in declared) && !nothingToInstall(repoPath).proven) {
    return {
      ok: false,
      name,
      known: normalise(declared, env),
      reason: `${name} declares itself in ${repoDeclarationPath(repoPath)}, but says nothing about `
        + 'its preparation — and mc ships no entry for it, so nothing else does either. '
        + 'Add "prepare" and "prepare_why" to that file: a command, or null with the evidence '
        + 'that its suite runs from a clean checkout.',
    };
  }

  if (declared) {
    // A partial declaration stops exactly as hard as a missing one. What is
    // known about the rest is reported anyway, so whoever writes the missing
    // half can see what they are completing.
    if (declared.prepare === UNKNOWN) {
      return {
        ok: false,
        name,
        known: normalise({ ...declared, prepare: null }, env),
        reason: `${name} is declared, but its preparation step is not: ${declared.prepare_why || 'no reason recorded'}. `
          + `What is known about it — ${describeKnown(declared)} — is not enough to run a round on. `
          + `Complete it where the fact belongs — in the repository, ${repoDeclarationPath(repoPath)}: `
          + '{"prepare": "<command>", "prepare_why": "<where that was decided>"}, '
          + `or, if it is a fact about this machine, in ${tablePath(root)}: `
          + `{"${name}": {"prepare": "<command>", "prepare_why": "<where that was decided>"}} `
          + '— or "prepare": null with the evidence that its suite runs from a clean checkout.',
      };
    }
    // Which fields of the layers below it this override silently dropped, if
    // it is one. A shallow table means an override states every field it
    // wants — a rule this table's own operator wrote into the memoro entry
    // after extra_gates fell out (D-0135) — but a rule people must remember is
    // a hole (pr_tests_flags fell out the same way, 2026-08-24), so the
    // dropped fields are named to whoever reads the declaration. A repository
    // that has written its own file is one more layer that can be dropped
    // that way, so it is counted here too.
    const shadowed = overridden && base
      ? Object.keys(base).filter((field) => overridden[field] === undefined
        && base[field] != null && (!Array.isArray(base[field]) || base[field].length > 0))
      : [];
    return {
      ok: true,
      name,
      declaration: normalise(declared, env),
      source: 'declared',
      shadowed,
      // Which of the three files each field came from. A reader who disagrees
      // with a declaration has to know which one to edit, and "it is declared"
      // does not say that once there are three places it could be declared in.
      sources: layerSources({ shipped, own: own.entry, override: overridden }),
    };
  }

  // No entry. The only thing that lets a round proceed anyway is proof that
  // preparation could not have been needed.
  const nothing = nothingToInstall(repoPath);
  if (nothing.proven) {
    return {
      ok: true,
      name,
      source: 'nothing-to-install',
      declaration: normalise({ prepare: null, prepare_why: nothing.why, extra_gates: [], merge_log: null }, env),
    };
  }

  return {
    ok: false,
    name,
    reason: `${name} has no gate declaration, and ${nothing.why} — so mc cannot tell whether its suite `
      + `needs anything installed first. Declare it in the repository itself, ${repoDeclarationPath(repoPath)}: `
      + '{"prepare": "<command>", "prepare_why": "<where that was decided>"} '
      + `— or, for a fact about this machine rather than about the repository, in ${tablePath(root)}: `
      + '{"' + name + '": {"prepare": "<command>", "prepare_why": "<where that was decided>"}}. '
      + 'Either way "prepare": null with a "prepare_why" says the suite runs from a clean checkout. '
      + 'mc suggests no command here on purpose: the one it would suggest is the guess this refusal exists to prevent.',
  };
}

/**
 * Can it be proved that nothing needs installing?
 *
 * Only one shape proves it: a manifest that asks for nothing. Anything else —
 * dependencies present, no manifest at all, a manifest that will not parse — is
 * unproven, and unproven is not the same as fine.
 */
function nothingToInstall(repoPath) {
  const manifest = join(repoPath, 'package.json');
  if (!existsSync(manifest)) {
    return { proven: false, why: 'it has no package.json for mc to reason about' };
  }
  let parsed = null;
  try { parsed = JSON.parse(readFileSync(manifest, 'utf8')); } catch {
    return { proven: false, why: 'its package.json could not be read' };
  }
  const wanted = [
    ...Object.keys(parsed?.dependencies || {}),
    ...Object.keys(parsed?.devDependencies || {}),
  ];
  if (wanted.length) {
    return { proven: false, why: `it declares ${wanted.length} dependenc${wanted.length === 1 ? 'y' : 'ies'}` };
  }
  return { proven: true, why: 'its package.json declares no dependencies at all, so nothing can be missing' };
}

/** A declaration with every field present, and the log path resolved. */
function normalise(entry, env) {
  return {
    prepare: entry.prepare ?? null,
    prepare_why: entry.prepare_why ?? null,
    // How this repository lists the test files a change reaches: a command
    // that prints JSON carrying a `files` array, run in the candidate
    // worktree. Declaring it turns the round from two full suites into the
    // reached files measured on both sides; not declaring it keeps the full
    // suite, which is the right answer for a repository whose suite is small
    // enough to run whole.
    //
    // Both sides run the CANDIDATE's list, never each side's own. A repository
    // that selects by diff answers "nothing changed" on the baseline, and a
    // round that let each side choose would compare 56 files against 6 and
    // report main's own red as this change's doing.
    select: entry.select ?? null,
    select_why: entry.select_why ?? null,
    // What this repository calls its *whole* suite, for `--full`. Not read off
    // `package.json` any more: `npm test` is a selector in at least one of the
    // two repositories mc knows, and a selector run with nothing to select
    // against reports a handful of files as the whole tree.
    //
    // `null` is only safe where nothing else claims to narrow. `repo-gate.js`
    // refuses a `--full` for a declaration that has `select` and not this;
    // a repository with neither keeps `npm test`, which is what it always was.
    suite: entry.suite ?? null,
    suite_why: entry.suite_why ?? null,
    // What a branch runs when it is freshened against a new main —
    // `repo-freshen.js` has described this path since it was written, and the
    // field it names has been `undefined` for every repository, so the path
    // never ran. Present here so a repository can answer; no shipped entry
    // fills it, because what it should hold for memoro is a live question:
    // ruling 4 said `npm run ci`, and that is 554.7 s, ruled out 2026-08-31.
    affected: entry.affected ?? null,
    // Paths whose test files must not run beside each other. mc runs a
    // repository's selected files itself rather than through the repository's
    // own runner, which is the faster of the two — and which means it does not
    // see the resource class memoro's `buildExecutionBatches` knows and its
    // `printablePlan` does not report. Until a selection carries that per
    // file, a repository can say here which paths it will not survive being
    // run seven-wide.
    //
    // `null` and `[]` are different answers on purpose: `null` is "this
    // repository has not said", `[]` is "it has said, and nothing is serial".
    // A round that wants to report the honest first one needs it expressible.
    serial_paths: Array.isArray(entry.serial_paths) ? entry.serial_paths.map(String) : null,
    extra_gates: (entry.extra_gates || []).map((gate) => ({
      name: gate.name || gate.command,
      command: gate.command,
    })),
    merge_log: resolveLog(entry.merge_log, env),
    // The node flags the pull request's own tests run with (D-0157). Empty
    // means "read them off a `node --test` test script, or none": a guess,
    // and for memoro the wrong one — its runner is ci.mjs and adds
    // `--import ./tests/_helpers/browser-paths.mjs`, which three of its test
    // files cannot run without. Declared here, the round measures with the
    // repository's own environment rather than an inference about it.
    pr_tests_flags: Array.isArray(entry.pr_tests_flags) ? entry.pr_tests_flags.map(String) : [],
  };
}

/**
 * Where the merge log lives, if anywhere.
 *
 * Written relative to the work root rather than absolutely, so a declaration
 * shipped in the source does not carry one machine's home directory in it.
 */
function resolveLog(log, env) {
  if (!log) return null;
  if (typeof log === 'string') return log;
  if (log.under === 'work-root') return join(workRoot(env), log.path);
  return log.path || null;
}

function readOverrides(root) {
  try { return JSON.parse(readFileSync(tablePath(root), 'utf8')) || {}; } catch { return {}; }
}

/** What an incomplete entry does say, for the person completing it. */
function describeKnown(entry) {
  const parts = [];
  const gates = (entry.extra_gates || []).map((gate) => (gate.source ? `${gate.name} (${gate.source})` : gate.name));
  parts.push(gates.length ? `extra gates: ${gates.join(', ')}` : 'no extra gates');
  parts.push(entry.merge_log ? 'a merge log' : 'no merge log');
  return parts.join('; ');
}

function basenameOf(path) {
  return String(path).replace(/\/+$/u, '').split('/').pop();
}
