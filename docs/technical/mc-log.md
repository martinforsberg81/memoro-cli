# mc log — what mc did, and what happened to it

Every mc invocation writes down that it started and that it ended. `mc log`
reads that back, and joins it to the two other files that record what mc does,
so the question "what happened in that merge?" is one command instead of three
files and a script.

```
mc log [--limit <n>]     the last invocations, oldest first
mc log --failures        only the ones that did not end well
mc log <run>             one invocation whole
mc log --open            rounds that started and never ended
mc log --repo <repo>     narrowed to one repository
mc log --since <iso>     narrowed to a window
mc log --verb <verb>     narrowed to one verb
mc log --where           the files this reads, and their sizes
mc log … --json          the same, as data
```

## The morning it is for

On 2026-08-30 two `mc merge` rounds on memoro were killed from outside
mid-round. The first had already landed **#11082** and had not reached
**#11085**. It read like a gate failure and was not one: background jobs in
that session were being reaped, and only `nohup … & disown` survived.

Every fact needed to understand it was already on disk. None of it was joined:

| file | what it knew | what it did not |
|---|---|---|
| `repo-leases/leases.log` | claim at 09:48 pid 175; reap at 10:01, pid gone | which round, what it had merged |
| `gate-rounds.jsonl` | **nothing** — it is written when a round *ends*, and these did not end | |
| `logs/mc.log` | nothing — the merge path never wrote to it | |

The only trace of the dead round was a *later* round bouncing off its
abandoned lease with `stopped_at: lease`. `gate-rounds.jsonl` is the file built
to answer "has the gate ever caught anything?", and it was silent about exactly
the two rounds of that day that went wrong — the same shape of blindness its
own header warns about, one level up.

Reconstructing it took reading three files by hand and a throwaway script.
`mc log` is that script, kept:

```
$ mc log --open
DIED  memoro  #11082 #11085  started 2026-08-30T09:48:22.097Z  pid 175  run_aaaabbbbcccc
      its lease has since been reaped — nothing is held
      2026-08-30T09:48:22.097Z  claim  merge round for #11082 #11085
      2026-08-30T10:01:45.193Z  reap   merge round for #11082 #11085
```

## The run id

Every line one invocation writes carries the same `run` — a process-lifetime
id, generated on first use, never accepted from outside (a caller that could
name its own run could name somebody else's). It is what makes the three files
one story.

`leases.log` has no run id and is not given one. It predates the idea, it is a
plain text file other eyes read, and a join that required every file to have
been rewritten could not see history. It is joined on the **pid** the round
wrote down instead.

## Start and end, and why the pair is the record

`src/mc-cli.js` writes `mc.start` before dispatching and `mc.end` after, at the
one funnel every verb passes through — `routeV1Command` plus the fallthrough to
the capability dispatcher. Seven hand-placed call sites had already proved they
miss things.

A gate round does the same at a coarser grain: `recordRoundStart()` writes a
`phase: "start"` line **before any work**, carrying its pid and run.

The pair is the point. **A start with no end is a command that died.** SIGKILL
runs no handler, so nothing can record its own death; the verdict is made by a
later reader, and it asks the operating system whether the pid is alive rather
than reading a clock. A gate round is *supposed* to take half an hour — no
timeout separates a slow round from a dead one, and one that tried would
eventually force-release a lease out from under a live round.

Lines written before 2026-08-30 carry no `phase` and are read as ends. Nothing
back-fills them: a log that rewrites its own history is worse than a short one.

## What is recorded, and what is refused

`logs/mc.log` is append-only JSONL under mc's home, `0600`, rotated at 8 MB,
and never transmitted anywhere.

An invocation is recorded as **shape, never content**:

- the verb and subcommand;
- positionals that look like identifiers — no whitespace, a short alphabet, 64
  characters at most. `memoro`, `11082`, `#473`, `mc-log` pass; prose, quoted
  text and anything with a space do not;
- flag **names**. `--model opus` is recorded as `--model`; the value is dropped
  without being inspected.

Verbs whose tail is free text by construction — `claim` and `helper` — drop
their positionals outright. That is two mechanisms where
one would do, deliberately: the filter is the rule, and the list is the
admission that the filter is not tight enough on its own. A one-word message
would pass the filter.

`mc work send x "<message>"` must never put a person's words in a file that
lives forever. Neither must an environment value, a token, or transcript text.

## It only reads

`mc log --open` shows a round that died and whether its lease was ever reaped.
It does not release it. Deciding that a holder is gone is a judgement about the
world — a person who walked away, or a machine that died — and that stays where
`mc repo who` has always kept it, with the human and the `--force` that is
written down.

`--open` also exits 0 when it finds a dead round. The finding is not this
command's failure, and a nonzero would make it unusable in anything chained
with `&&`.

## The logger never fails its caller

`log()` swallows its own errors, and `src/mc-cli.js` guards even the import.
A command must never fail because of the record it keeps. The consequence is
honest: on a full disk the log is short and nothing says so, which is the right
trade for a file whose whole job is to exist afterwards.

## Where it all lives

```
$ mc log --where
   645 KB  ~/.memoro/mc/logs/mc.log
   120 KB  ~/.memoro/mc/gate-rounds.jsonl
    86 KB  ~/.memoro/mc/repo-leases/leases.log
```

Never inside a repository, and never in a merge log — that is a human document
with a different owner.
