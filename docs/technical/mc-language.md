# mc language — one door for language data, and a record of every run

`mc language` is the verb a person types to put language data in production,
the way `mc deploy` is the verb that puts code there (ruling 31). It is not a
language tool. What is read and what is written is memoro's: its cutover
manifests in `scripts/language-library/cutovers/<name>.json`, validated in full
by memoro's own `cutover-manifest.js`, and the `--json` scripts those manifests
and the reads below name. mc runs those argument arrays exactly as written, in
the memoro worktree `mc deploy` uses (`deploySource`), and changes no part of
them.

What the verb adds is everything around the scripts:

- **the reading**, so the person deciding sees where a language stands —
  unresolved selectors, forms, grammar waiting, anchors — before anything is
  written, and a cache of it that the page and `mc deploy --dry-run` read
  offline;
- **one question before every write**, with no flag that skips it;
- **the key**, held in this machine's keychain, given to one child at a time
  and never to anything else;
- **the record**, written before the first child starts and completed act by
  act, so a run that dies half-way says which write it was in, and
  `resume` starts from there;
- **one writer at a time**: a language run and a deploy never write to
  production at once.

It is Martin's verb, as `mc deploy` is. The runner never calls it, and no role
tells a session to (`canon/roles/_session-work.md`). Only the verb, its help,
its record, the page and `mc deploy --dry-run` name its subcommands, and the
last two name them only as the next thing to type; a test checks that
(`tests/mc/language-runs.test.js`).

## The subcommands

| command | does |
|---|---|
| `mc language [--json]` | each language's last reading and last run, from the cache — offline, instant |
| `mc language status <lang>` | the language's four reads, run now in memoro's `main`, and cached |
| `mc language key [--json]` | whether the Cloudflare key is held, and its account |
| `printf %s "<token>" \| mc language key set --account <id>` | keep the key in this machine's keychain |
| `mc language run <manifest> [--dry-run]` | a cutover's acts in order, asking before every write |
| `mc language resume [--manifest <name>] [--from-head]` | the stopped run again, from the act it stopped at |
| `mc language promote [--langs <list>]` | the curated grammar waiting, to production after one question |

Exit codes:

- **0** — a reading with every read answered, the cache shown, a key kept,
  or a run whose every act held.
- **1** — a reading with a failed read, a refusal (a deploy or a run going
  on, a dirty or diverged `main`, no wrangler, no key), a deviation, a `no`,
  or a keychain that would not write.
- **2** — a bad argument, a token not piped in, or no terminal to ask at.
- **130** — a run stopped by ^C.

## The reading

`mc language status <lang>` runs four reads in memoro's `main`, each
`node <script> … --json` (`READS`, [`src/mc/commands/language.js`](../../src/mc/commands/language.js)):

| read | script | kept |
|---|---|---|
| selectors | `grammar-selector-readiness-report.mjs --env production` | unresolved selectors, rows without a usable one, the count per use |
| forms | `readiness-report.mjs --env production` | forms in D1 |
| grammar | `language-grammar-promote.mjs --check` | status, and rows waiting (`upsert + delete_stale`) |
| anchors | `apply-curated-lemma-anchors.mjs --env production` | would update, missing |

A read that exits non-zero but printed its report is a reading and not a
failure: the anchors script exits 1 whenever anchors are missing. The reads
need no key. They run on wrangler's login, with every `CLOUDFLARE_*` taken out
of their environment.

The worktree is prepared the way `mc deploy` prepares it: `main` found or
made, fetched and fast-forwarded. Any of the following refuses, touching
nothing:

- a deploy running;
- a `main` that is dirty, or that has commits `origin/main` does not.

The reading is written to `~/mc/runner/log/language/status-<lang>.json`. That
cache is what bare `mc language`, the page and `mc deploy --dry-run` read. None
of them runs anything.

## The manifest, as far as mc reads it

`src/mc/language-manifest.js` checks only the fields mc uses, so that mc never
runs an act whose shape it would misread. It is not a second validator.

- **The contract:** `schema` must be `memoro-language-cutover` and `version`
  must be `1`. A manifest with another schema or version is listed as
  unreadable, by name, and never run.
- **The manifest's own fields:** `name`, `lang` and `closes` — the selector
  uses the cutover closes, which `status` prints beside each unresolved use.
  `ran: { on, note }` is optional and is printed when the manifest is run
  again.
- **Each act's fields:**
  - `id`, `title` and `target` (`production` or `local`);
  - `check`, an argument array;
  - `execute`, an argument array, or `null` for an act that only reads;
  - `credentials`, `requires_runnable`, `expect.check` and `expect.execute`;
  - `if_not`, and an optional `opens_gap: { until, says }`.
- **Expectations:** every expectation has a `path` and is either `exact` or
  `advisory`, never both and never neither.

## A run

`run`, `resume` and `promote` share one sequence (`conduct`):

1. **The worktree**, prepared as for `status`. There must be wrangler in it:
   `node_modules/.bin/wrangler`.
2. **The manifest**, read from that worktree by name. A `resume` refuses when
   memoro's `main` has moved since the stopped run, because the manifest may
   have changed; `--from-head` resumes there regardless.
3. **The record**, under the register's lock, the same lock `mc deploy`
   decides under:
   - a running deploy refuses;
   - so does another live language run;
   - a run whose process is gone is closed as `failed`;
   - then this run's record is written.
4. **Preflight**, before anything is written:
   - an act that names a credential mc does not hold refuses;
   - a missing key refuses;
   - the first credentialed act's check is run with the key, to show that
     the key reads;
   - every `local` act is checked;
   - the first write's `requires_runnable` acts are checked.
5. **The acts, in order.** Each act's `check` runs and is compared with
   `expect.check`:
   - an `exact` expectation that differs stops the run before the next
     write, printing the act's `if_not`;
   - an `advisory` one is printed and never enforced.

   For an act that writes:
   - the question comes first, the act's own or `<id>: write to <target>?
     [y/N]`;
   - then `execute` runs;
   - then its report is compared with `expect.execute`.

   When what an act writes already holds, the question is whether to run it
   anyway.

`--dry-run` runs every check up to the first production write, says what it
would run, and stops. The acts after it cannot be checked until that write has
happened.

Without a terminal, `run`, `resume` and `promote` exit 2 before reading
anything. A dry run needs no terminal.

## The record and `resume`

`~/mc/runner/log/language/runs/` holds one JSON file per run
([`src/mc/language-runs.js`](../../src/mc/language-runs.js)), rewritten whole
on every change. It follows the deploy record:

- the run exists, saying `running`, before the first child starts;
- an execute row is written `running` before its child starts, and completed
  after.

The run's `outcome` is `running`, `done`, `stopped`, `failed` or `refused`. An
execute act row carries the manifest's `opens_gap`, so the records alone say
when production is inside a gap: `openGap` finds the newest done act with an
`opens_gap` whose `until` act has not been done since. Dry runs are ignored.
Each run's output goes to a `.log` beside the record, with the key scrubbed
out.

`mc language resume` takes the newest stopped or failed run that was not a dry
run (`--manifest` picks which). It skips every act whose execute is done
across that run and the runs it resumes, and checks the act it stopped inside
relaxed, because that act may have written part of what it was writing.

## The key

The Cloudflare token and its account are kept under `cloudflare-d1-edit-token`
and `cloudflare-account-id`, in the keychain or, on a machine with none, in
`~/.memoro/secrets.json` (mode 0600). The key is **never an argument**:

- `mc.log` keeps a command's positionals when they look like identifiers, and
  a shell keeps its history;
- so `key set` reads the token from stdin and only from there.

Nothing prints the key or writes it to a log. Every child starts with mc's
environment minus the runtime secrets and minus every `CLOUDFLARE_*`. Only the
child of an act whose `credentials` names `cloudflare-d1-edit` gets
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

## The grammar promotion

`mc deploy` no longer promotes grammar. `mc language promote` does it, as a
one-act manifest built in mc (`promoteManifest`) around memoro's
`language-grammar-promote.mjs`:

- **the check:** it runs on wrangler's login (`check_without_key`), and the
  act judges what it says itself;
- **nothing waiting:** it prints `nothing waiting` and exits 0, asking
  nothing;
- **rows waiting:** it prints each ready language's counts and asks once;
- **after the write:** it rewrites the cached reading of every language it
  promoted, so the page stops saying rows are waiting.

The record calls the run `grammar-promote`, and `resume` rebuilds the manifest
the same way.

## Never at the same time as a deploy

A language run and a deploy write to the same production. Each one reads the
other's record under the register's lock before writing its own:

- `mc deploy` refuses while a language run is alive (`liveRun`) and writes a
  `refused` row saying so;
- a language run refuses while a deploy is running (`runningDeploy`);
- `status` refuses too, because its reads would wait for the deploy anyway.

## On the page and in `mc deploy --dry-run`

The `mc` page has a **LANGUAGE** section after DEPLOY
([`mc-ui.md`](mc-ui.md)). It reads the cache and the run records and nothing
else:

- **the heading:** the last run, with its outcome;
- **the rows:** a row only for a language with something to say — unresolved
  selectors, rows waiting (`· mc language promote`), or a reading older than
  seven days.

With nothing to say and no run recorded, the section is not drawn at all.
While a gap is open, one red line comes above every section: `language:
<manifest> stopped after <act> — <says> · mc language resume`.

`mc deploy --dry-run` adds one language line from the same cache, before its
closing line. It is one of:

- `sv 724 rows waiting (read 2h ago) · mc language promote`;
- `nothing waiting (read …)`;
- `no reading; mc language status <lang>`.

It adds the open-gap line when a gap is open. `--json` has both as `language`.

## How it is tested

Every child is faked:

- `tests/mc/commands/language.test.js` fakes git, the spawns, the keychain,
  stdin and the prompt. It asserts that the token never appears in a fake
  spawn's argv or in `mc.log`, and appears only in a credentialed act's child
  env.
- `tests/mc/language-runs.test.js` covers the record, `openGap` across a
  resume, and the check that nothing outside the verb names a run.
- The page and the dry-run lines are covered in `tests/mc/page.test.js` and
  `tests/mc/commands/deploy.test.js`.

**Not measured live:** no step session ran an act against production. The
first live run is Martin's: `mc language run sv-forms-cutover --dry-run`.
