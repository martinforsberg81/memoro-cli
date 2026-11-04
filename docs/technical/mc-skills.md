# Skills — task guidance every session reaches

A role ([mc-roles.md](mc-roles.md)) reaches only a session mc launches: it
rides on `--append-system-prompt` or `-c instructions=`. A session opened by
hand in a repository sees that repository's `AGENTS.md`/`CLAUDE.md` and nothing
of mc's, and the two have said different things. A skill is the one channel
both kinds of session have: Claude Code and Codex each read user-level skills
from a directory in the home, show the model every skill's `name` and
`description`, and load the body when the description says it applies.

The code is [`src/mc/skills.js`](../../src/mc/skills.js); the verb is
[`src/mc/commands/skills.js`](../../src/mc/commands/skills.js).

## The catalogue

`canon/skills/<name>/SKILL.md`, in the package beside `canon/roles/`. The format
both tools read: frontmatter with `name` (the directory's name, lowercase
letters, digits and `-`) and `description` (one line: what it covers and when
to use it), then a markdown body. Other files in the directory are installed
with it. A skill without `name` or `description` is not installed, and
`mc skills` and `mc roles check` name it. One skill per task, short; detail
that belongs to one programme goes in that programme's skill.

| Skill | What it covers |
| --- | --- |
| `publish-and-merge` | `mc gate`, `mc publish`, `mc merge` as the code has them, and the test rules; not who approves a merge |
| `merge-conflicts` | keeping both intents, separate merge and commit, generated files |
| `git` | the shared git directory: no stash, one command at a time, commits, branches, pushing |
| `proposals` | a finding that is not your job: `~/mc/proposals/`, not `~/mc/intake/` |
| `processes` | never signal a process you did not start |
| `scratch-and-probes` | `$MC_SCRATCH`, and `MC_HOME`/`MC_WORK_ROOT` for a probe of mc's own code |
| `measure-the-app` | `mc shot`, measuring, proving which tree is served |
| `dev-servers` | servers only through mc, at most two |
| `asking-martin` | a question answerable in a word; what to tell him; what a headless session leaves waiting |
| `writing-tests` | risk-based protection, credible test levels, fault evidence, cost and retirement; includes the strategy reference |
| `writing-a-goal` | executable briefs with explicit protection scope |
| `memory` | what a memory may hold; a rule about how to work goes in `canon/` |

Each rule has one home: `tests/mc/canon-text.test.js` asserts a defining
sentence of each skill is in that skill's file and no other canon file, that no
role file repeats a skill's sentence, and that each role names what it needs.

## The programme skill

`~/mc/programs/<programme>/SKILL.md`, when the file is there, is installed as
`mc-programme-<programme>`. Its description begins with the programme's name
and directory, so a tool applies it to work there; a `description` in the
file's own frontmatter follows it. A programme without the file has no skill,
and nothing is generated for it. Removing the file removes the install.

## The install

| Tool | Directory |
| --- | --- |
| Claude Code | `~/.claude/skills/` (`$CLAUDE_CONFIG_DIR/skills/` when set) |
| Codex | `~/.agents/skills/` — the user scope in Codex's skills documentation (developers.openai.com/codex/skills, read 2026-11-02; codex-cli 0.166 scans it) |

Each skill is installed as `mc-<name>`, its `name` rewritten to match and a
comment under the frontmatter naming the source. The prefix is the ownership
line: the sync makes every `mc-*` entry exactly what the sources render — a
missing one is installed, one that differs is rewritten whole, one no source
ships any more is removed — and never reads, writes or removes an entry
without the prefix.

It runs in three places:

- **`mc hook session-start`**, first. Every Claude Code session runs it,
  launched by mc or opened by hand, so the skills are current before any
  session reads them, without a person doing anything. It costs a read of a few
  small files and writes only what differs. This is where hooks differ: a hook
  cannot install itself, so `mc hook install` stays a person's verb and the page
  names drift; once the hook is there, it can keep the skills current.
- **`mc hook install`**, once, so a machine has the skills from the moment the
  hooks are registered.
- **`mc skills sync`**, by hand — for a machine where only Codex runs (mc
  registers no Codex hook) and after editing a programme's `SKILL.md`.

`mc skills` shows the state without writing. `mc roles check` ends with the
same report: per tool, a tally, and a line for each entry that is `missing`,
`drift` (installed, not what the source renders today) or `stale` (an `mc-*`
entry no source ships).

The installed mc's canon is what the hook installs. A session that runs a
worktree's `mc skills sync` installs that worktree's canon until the next
session start puts the installed one back.

## How it is tested

`tests/mc/skills.test.js`, against a temporary home: the canon skill parses and
a skill without `name` or `description` is refused; the sync installs for both
tools, rewrites a changed install, removes a stale `mc-*` one and leaves an
unprefixed one alone; a programme with `SKILL.md` gets
`mc-programme-<programme>` and one without gets nothing; `@skill` resolves and
an unknown name stays; `mc roles check` names drift.
