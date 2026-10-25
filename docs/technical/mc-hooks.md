# mc hooks — the session's state at start, and the mc verb before the raw tool

`mc hook session-start` and `mc hook pre-tool` answer Claude Code's
`SessionStart` and `PreToolUse` hooks. Martin asked for them on 2026-10-15:
"mc programmen ska vara första valet … minska antalet anrop som modellen
behöver göra … flytta mekaniska delar från modell till logik." The same day a
session had shown why, three ways:

- It started in a workarea (`~/mc/plan/assistant`), so neither memoro's
  `CLAUDE.md` nor its `.claude/settings.json` was loaded.
- Its memoro worktree stood on a branch whose PR had merged and which was 1025
  commits behind `origin/main`; it read and measured that code for an hour.
- It used `git push`, `gh pr create`, `npm run ci`, `npm run dev:agent` and
  hand-written Playwright, because nothing it read named `mc publish`,
  `mc gate` or `mc shot`.

All three are facts git and mc already hold, so mc says them; the model does
not have to remember to ask.

## Where they are registered

In `~/.claude/settings.json`, not in a repository: a session that starts in a
workarea loads no repository settings, and that is the session that needs the
warning most.

```json
"hooks": {
  "SessionStart": [{ "hooks": [{ "type": "command", "command": "mc hook session-start 2>/dev/null || true" }] }],
  "PreToolUse": [{ "matcher": "Bash|Write|Read|Edit|MultiEdit|mcp__claude-in-chrome__.*", "hooks": [{ "type": "command", "command": "mc hook pre-tool 2>/dev/null || true" }] }]
}
```

`mc hook install` writes the block above into that file, changing only the
entries whose command starts with `mc hook session-start` or `mc hook pre-tool`;
every other entry is left as it is, and a file that is not JSON is refused and
left alone. `mc hook install --check` writes nothing and exits 1 when the
registration has drifted from the block, and the page's MC line names the drift
as `hooks: … · mc hook install`.

`Read` lets memoro's `block-sqlite-state.sh` answer the Read tool too. `Edit`
and `MultiEdit` are there so the plan-file refusal below sees them, and
`mcp__claude-in-chrome__.*` so the Chrome rule does. When the matcher changes,
`mc hook install` rewrites mc's entry in place (no second entry), and
`--check` reports the old matcher as drift until it has run.

`|| true` because a hook must never stand between a session and its work: an
mc that does not know the verb yet, or any failure, is silence. The verbs
themselves always exit 0 and print at most one JSON object.

## `mc hook session-start`

Reads the hook JSON (`cwd`) on stdin. The worktrees are the one `cwd` stands
in, or — in a workarea — each child directory that is a worktree of a
repository `defaultRepos` names, decided by the shared git directory. For each,
from local refs only (no fetch, so it is instant): branch, behind and ahead of
`origin/main`, changed files, a live dev server from the `mc dev` inventory,
and how old `FETCH_HEAD` is. Warnings, each with the one command that answers
it:

| Condition | Warning |
| --- | --- |
| the branch tracked a remote branch that no longer resolves | its PR has merged — cut a new branch from `origin/main` |
| otherwise 50 or more commits behind `origin/main` | old code — cut a new branch unless this is the work in hand |
| on `main` or `master` | never commit here |
| origin fetched 24 h or more ago | the counts may be low — `git fetch origin` |
| `cwd` is outside the repositories | their `CLAUDE.md` was not loaded — read it first; their `PreToolUse` hooks are run by `mc hook pre-tool` |

Then the toolbox: one line per job, the verb first. The answer is
`{ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext } }`.
Outside mc's repositories it prints nothing.

## `mc hook pre-tool`

Acts only on mc's ground (under `workRoot()`, or in a worktree of a known
repository).

Before its own rules, pre-tool runs the `PreToolUse` hooks in
`.claude/settings.json` of every worktree `worktreesAt` finds at `cwd`, except
the one `$CLAUDE_PROJECT_DIR` names (Claude Code already ran that one's), with
`CLAUDE_PROJECT_DIR` set to that worktree and the hook JSON on stdin. A `deny`
on stdout or exit 2 is the answer, named by repository (`mc: memoro hook:
Blocked by …`). A session started in a plan directory or a workarea never
loaded those hooks itself, and memoro's are its data-access policy.

A `Bash` command is matched on its words:

| Command | Turned to |
| --- | --- |
| `gh pr create` | `mc publish` |
| `gh pr edit` | `mc publish` (on an open pull request each of `--title`, `--body-file`, `--base` edits only its own field) |
| `git push` | `mc publish` |
| `gh pr merge` without `--admin` | `mc merge <repo> <pr>` (the admin merge stays memoro's documented livelock fallback) |
| `npm run ci`, `npm test`, `npm run test` | `mc gate <files…>` — the whole suite is the merger's (ruling 52) |
| `node --test …` | `mc gate <files…>`, which runs it in the gate lane |
| `npm ci`, `npm install` / `npm i` with no package | `npm run deps:ensure` in memoro (links to the per-lockfile cache); nothing in memoro-cli. `npm install <pkg>` and `--package-lock-only` pass |
| `npm run dev`, `npm run dev:agent` | `mc test dev --here --url`, or `mc shot dev` |

A `Write` whose content imports Playwright, to a path outside every known
repository, is turned to `mc shot dev … --measure`: a scratch measurement
script is the thing `mc shot` exists to replace, and when it cannot, the reason
is what mc should learn next. A repository's own Playwright code is left alone.

A Claude in Chrome call (`mcp__claude-in-chrome__*`) that sends the browser to a
server on this machine is turned to `mc shot dev <path> --keep` and
`mc shot next` (`chrome-dev`): a `navigate` or `tabs_create_mcp` whose `url`
host is `127.0.0.1`, `localhost` or `[::1]` (a URL without a scheme is read as
`http://`), or a `browser_batch` whose `actions` hold such a `navigate`.
Everything else in Chrome passes — a real site, a published artifact on
claude.ai, a screenshot or click in a tab already open. Measured 2026-10-24:
three sessions in ten days drove the dev server through Chrome, 76 calls, one
model turn each, because `mc shot` could not yet run JavaScript, wait longer
than 10 s, upload a file or keep a browser between calls. It can now (`--eval`,
`--timeout`, `--upload`, `--keep`, `mc shot next`), and each step answers with
the page, request, server and dialog errors in the same call. The escape is
`MC_HOOK_ALLOW=1` anywhere in the tool input — a `#MC_HOOK_ALLOW=1` fragment on
the URL — with the reason said, so what `mc shot` lacks is what mc learns next.

A `Write`, `Edit` or `MultiEdit` of a `PLAN.json`, `DRAFT.json`, `STATE.json` or
`CLOSEOUT.json` under `~/mc/programs/` is refused (`plan-file`): a plan changes
through `mc project`, a step's state through `mc step`, a criterion through
`mc project criterion met`. A relative `file_path` is resolved against the
session's `cwd`. This refusal has no escape. A `Bash` command that writes one of
those names — a `>` or `>>` redirect, `tee`, `sed -i`, or `mv`, `cp`, `rm`,
`truncate`, `install` of it — is refused the same way, under the `MC_HOOK_ALLOW=1`
escape like every Bash rule. That rule matches the name alone, so a file of that
name anywhere is refused too; no repository holds such a file any more. Codex
sessions are not covered: mc registers no hook for them, so this catches
mistakes, not intent.

The answer is a `deny` with the reason, which names the verb and the escape: a
command (or a written file) that contains `MC_HOOK_ALLOW=1` passes — a
`--force-with-lease` after rebasing a stack, a drag `mc shot` cannot do — and
the session says why.

The rules are `src/mc/hooks.js`, pure over a git runner and the inputs; the
door is `src/mc/commands/hook.js`; `tests/mc/hooks.test.js` holds both.
