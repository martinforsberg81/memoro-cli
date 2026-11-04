# mc context on demand

mc installs one discoverable skill for both tools. Its source is
[`canon/SKILL.md`](../../canon/SKILL.md); its installer is
[`src/mc/skills.js`](../../src/mc/skills.js).

```
mc/
  SKILL.md                 short entrypoint: when to read which reference
  roles/                   shared essentials and session roles
  verbs/goal.md            goal command semantics
  tasks/*.md               operation-specific guidance
  tasks/references/        details such as the test strategy
  programmes/<name>.md     only programmes with a source SKILL.md
```

The tool sees one name and description at discovery. When mc applies, the
model reads the short entrypoint, then the reference required by the operation.
There are no nested SKILL.md files. Grouping sixteen entrypoints under a new
parent would still expose sixteen descriptions to recursive discovery.

A session mc launches receives shared essentials and its selected role/part
through the existing launch channel. `@mc` becomes one pointer to the root
entrypoint; `@verb goal` becomes a pointer to the goal reference. Neither task
catalogues nor verb manuals are pasted into role instructions. The role's
purpose and authority remain present. A session opened by hand discovers the
same mc skill and follows the same routing without acquiring a role.

Programme sources stay at `~/mc/programs/<programme>/SKILL.md`. Sync copies
their bodies into `mc/programmes/<programme>.md`; the entrypoint tells the
model to read only the named programme, once when work there begins. It does
not list all programmes or embed their details.

## Install and migration

| Tool | Bundle |
| --- | --- |
| Claude Code | `~/.claude/skills/mc/`, or `$CLAUDE_CONFIG_DIR/skills/mc/` |
| Codex | `~/.agents/skills/mc/` |

`mc skills` and `mc roles check` report bundle drift and marked legacy entries.
`mc skills sync` builds and validates the source bundle before writing, stages
all files outside the discovery directory, swaps in the completed bundle, and
then removes old `mc-*` directories bearing mc's installed-source marker.
Unmarked skills and symlinks are left alone. An existing unowned `mc/` is
refused. An invalid source or failed replacement leaves legacy guidance intact.
A second sync without source changes writes nothing. Removed programme sources
and obsolete resources disappear with the next bundle replacement.

Sync also runs on `mc hook install` and Claude's `mc hook session-start`.
Edit the canon source, not generated installs. A worktree's sync can temporarily
install that worktree's canon; the next hook uses the installed mc. For probes,
use isolated HOME, CLAUDE_CONFIG_DIR, MC_HOME and MC_WORK_ROOT as described in
[the scratch reference](../../canon/tasks/scratch-and-probes.md).

Existing conversations retain instructions already in their history. Smaller
discovery and launch contexts take effect in fresh conversations; files are
loaded when requested by the model, not forcibly evicted afterwards.

## Protection

`tests/mc/skills.test.js` exercises real fixture directories: one entrypoint,
legacy migration, unrelated-file preservation, drift repair, idempotence,
programme removal, invalid-source preservation, and installed reference paths.
Role and launch tests check that manuals are reached by reference without
preloading them. These deterministic checks need no live model or network.
