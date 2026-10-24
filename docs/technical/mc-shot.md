# mc shot — a picture of the running app from one verb

`mc shot dev|prod <target>` gives back a PNG of memoro as it runs, from a local
dev server or from https://meetmemoro.app, and prints the file's path. The
picture is the page, one element (`--el <css>`), or one shell
(`--shell base|immersive|window`). Martin asked for it on 2026-09-26: "smidiga
smarta sätt att generera screenshots från dev-server eller live prod … antingen
av enskilda element eller av sidor (base shell eller window shell)".

The work is split between the two repositories, and they meet in one place:

- **mc owns the environment**: which worktree, which server, the base URL, the
  test-account token and your session in the keychain, and where the file goes.
  [`src/mc/commands/shot.js`](../../src/mc/commands/shot.js) is the verb, and
  [`src/mc/shot.js`](../../src/mc/shot.js) holds the parts.
- **memoro owns the app**: `.mc/shot.json` in memoro names the capture script,
  the targets, the shells and the viewports, and the script drives the browser.
  It was built by memoro's `shot-capture` project
  (archived: its row of 2026-09-26 in memoro's `docs/project/project_log.md`). mc knows
  no selector, and this document does not repeat the targets: read
  `.mc/shot.json`, or run `mc shot dev --list`.

## The forms

```
mc shot <dev|prod> <target> [--el <css> | --shell base|immersive|window] [--full]
        [--viewport <name|WxH[@dpr]>] [--theme light|dark] [--locale <code>]
        [--safe-area <t,r,b,l>|0] [--wait-for <css>] [--scroll <css>[@end|@top|@<px>]|@end]
        [--measure <css>|@<name>] [--click <css>]… [--context-click <css>]…
        [--long-press <css>[@ms]]… [--fill <css>=<text>]… [--eval <js>|--eval-file <path>]…
        [--upload <css>=<file>]… [--press <key>]… [--timeout <s>]
        [--account <name>] [--onboarding]
        [--me] [--here] [--keep] [--out <file.png>] [--open] [--json]
mc shot next [<id>] [step flags]
mc shot close [<id>|--all]
mc shot sessions
mc shot <dev|prod> --list
mc shot login prod [--paste]
mc shot logout prod
```

- **The target** is a path starting with `/app`, or a name from
  `.mc/shot.json` `targets[].name`. An unknown name is an error that lists the
  known ones.
- **`--viewport`** is a name from `viewports`, or `WxH[@dpr]`, which becomes
  `{ width, height, dpr, mobile }` with dpr 2 unless you give one and `mobile`
  true below 600 px wide. Without it the viewport is `default_viewport`.
- **`--el` and `--shell`** both choose what is pictured, so they are refused
  together. `--full` takes the whole scrolled page.
- **`--me`** works only on `prod`. **`--here`** works only on `dev`, and gives a
  server for the worktree you stand in, as `mc test dev --here` does.
  `login` and `logout` work only with `prod`. Each refusal is one line and
  exits 2.
- **The output** is the file path, alone on the first stdout line, so
  `$(mc shot … | head -1)` is the path. The page URL comes next, then any
  warning as `mc: warning — …`; what the shot met in between is § *What comes
  back*. The dev-server progress lines go to stderr.
  `--json` prints the script's result object instead, and `--open` opens the
  file with the platform's opener (`open`, `xdg-open`, `start`), detached.

## Measuring a layout (2026-10-15)

A picture answers "how does it look"; a layout bug is answered by numbers. A
session fixing the main chat's bottom safe area on 2026-10-15 wrote its own
Playwright scripts for an hour because `mc shot` could do neither of the two
things the bug needed — a phone's safe area and the bottom of a scroller — and
gave no numbers. Each of these is now one flag, and the capture script does it:

- **`--safe-area top,right,bottom,left`** (or one number, or `0` for none):
  the insets Chrome reports to `env(safe-area-inset-*)`, through CDP
  `Emulation.setSafeAreaInsetsOverride`, set before the first navigation. A
  declared viewport may carry its own (`viewports.iphone.safe_area` in
  memoro's `.mc/shot.json`: 47, 0, 34, 0), so `--viewport iphone` is a phone
  with a notch and a home indicator without saying so; the flag overrides it.
- **`--wait-for <css>`**: wait until it is visible (10 s unless `--timeout`
  says), else `no-element`.
- **`--scroll <css>[@end|@top|@<px>]`**: scroll that element first; `@end`
  when nothing follows the `@`. The last `@` separates, so an attribute
  selector keeps its own characters. A bare `@end` or `@top` (no selector)
  scrolls the surface's declared scroller, which memoro resolves: the request
  carries `selector: null`.
- **`--measure <css> | @<name>`**: every element the selector matches (at most
  20; a selector list measures each part), as `{ element, rect, position,
  padding, margin, overflow_y, z_index, background_color, color, scroll,
  visible }`, with `visible` walking the ancestors. The two colours are the
  computed values as CSS reports them (`rgb(…)`/`rgba(…)`), and `--compare`
  compares them only when both trees report them. A name is one of the surface's declared measurements
  (`mc dev surfaces`). Printed as one JSON line `{ measure, safe_area }` after
  the path and the URL; with `--json` it is part of the result.
- **`--account <name>`** (dev only) picks an account `.mc/shot.json` declares
  (seeded by default), and **`--onboarding`** (dev only) asks for its `fresh`
  onboarding state. The account and state come from the `accounts` table: each
  state is a `/dev/login` path, and `fresh` reseeds the account, so the picture
  is the onboarding, the same every time. A target may declare `"onboarding":
  "fresh"` itself. Without a table (an older memoro) the paths are
  `account=<name>&ready=1`, or `reseed=1` for `fresh`.
- **`--compare <ref>`** (dev only) pictures and measures the same surface on
  `<ref>` too, in one call: the ref is checked out detached under
  `~/.memoro/mc/compare/<worktree>-<sha10>` (reused while it is at that commit,
  `npm run deps:prepare` when it has no `node_modules`, pruned after 24 h
  without a server), served by its own server, and captured with the same
  request and this worktree's script. Line 1 is this tree's PNG, line 2 the
  ref's (`-<sha7>` before `.png`), then one `diff  <element>  <field>  <ref> →
  <here>` line per measured value that moved, or that none did. With `--json`:
  `{ here, ref: { ref, commit, result }, diff }`. Refused with `--out` and with
  a ref that is HEAD while nothing is edited. A compare tree is per commit, so
  `--compare origin/main` after main moved needs a new tree and a new server.
  The compare server of an older commit of the same worktree name, unused for
  15 minutes, is stopped first to free its slot (`mc: stopped <id>, the compare
  server of <sha> idle <n> min, to free its slot`). The ref side waits at most
  60 s for a slot. A refusal names the compare servers still running, and
  `--compare <sha>` reuses one of them, with its tree and its database.
- `--click <selector>`, repeatable: the capture script presses each selector in
  order, after the page and its window are open and before `--wait-for`,
  `--scroll` and `--el`. The request carries them as `click`. A result that does
  not answer `clicked` with one entry per click is refused (exit 1, no path), so
  until memoro's capture script honours `click` every `--click` is refused. With
  `--compare`, both sides are pressed and either side's refusal refuses the pair.
- `--context-click <css>` (right-click), `--long-press <css>[@ms]` (press and
  hold, 600 ms unless said) and `--fill <css>=<text>` (type into it), all
  repeatable. They join `--click` in one list, and the four act in the order
  they are given. `--fill` splits at its first `=`, so a selector holds none.
  The text is read from the command line like any flag's value: type no secret
  into it. A result that does not answer `acted` with one entry per action is
  refused (exit 1, no path), as `clicked` does for clicks alone.
- `--eval <js>` (run it in the page; its value comes back as an `eval` line),
  `--upload <css>=<file>` (choose the file in that file input) and `--press
  <key>` (a Playwright key name — `Enter`, `Escape`, `Meta+K` — pressed on the
  page, no selector), all repeatable, join the same list: the seven act in the
  order they are given. `--eval-file <path>` is `--eval` with the file's text,
  read by mc (refused when unreadable), so a long probe needs no shell
  quoting; it keeps its place in the order. `--upload` splits at its first
  `=`, as `--fill` does; the file is resolved against the current directory and
  refused when it does not exist (`mc: --upload: no file at <path>`).
- `--timeout <s>`, whole seconds 1 to 120 (else `mc: --timeout is whole
  seconds, 1 to 120`, exit 2): how long each wait and each action may take —
  `--wait-for` and every acting flag — not the whole shot. Without it the
  script's own 10 s stands. mc lets the script run `max(180 s, 60 s + 4 ×
  timeout × (1 + actions))`, so a long wait is not killed by mc first.

The request gains `safe_area`, `wait_for`, `scroll`, `measure`, `onboarding`,
`click`, `actions` and `timeout_ms`, after `out`; a capture result gains
`safe_area` and, when asked, `measure`.

## What comes back (2026-10-24)

Measured on 2026-10-24 from the transcripts of three sessions in ten days: a
session left `mc shot` for Claude in Chrome every time `mc shot` could not
answer, and then spent one model turn per browser action. One needed to run
JavaScript in the page (a stacking chain, a hit test, a live CSS change);
another waited on a setup longer than the fixed 10 s, so two shots failed with
`.hero-card__actions was not visible within 10 s`, and its CSV import needed a
file chooser. Martin: "alla felmeddelanden ska komma tillbaka direkt". So
`--eval`, `--upload`, `--press` and `--timeout` above, and everything the shot
met comes back in the same call, on stdout after the path, the URL and the
measure line (and the access line of a gated target), in this order, each line
scrubbed:

```
error  <kind>  <text>[ ×<count>]
eval <n>  <json>
eval <n>  threw: <error>
failed  step <n> (<kind> <selector|key>): <error>
  here: <what is visible instead>
mc: warning — …
```

- **`error`**: one line per entry of the result's `errors`, `kind` one of
  `page`, `console`, `request`, `server`, `dialog`; ` ×<count>` when the same
  error came more than once. Each text is one line, cut at 300 characters. At
  most 20 lines, then `error  … <n> more — --json has them all`.
- **`eval`**: one line per entry of `evaluated`, `<n>` counting the `--eval`s
  from 1; the value as JSON on one line, cut at 4000 characters with `…
  (<bytes> bytes; --json has it whole)`.
- **`failed`**: the step that failed, counted from 1 over the acting flags,
  then `here:` when the script names what was visible instead. The picture is
  still taken and printed first — it is the page as it stood when the step
  failed.

`--json` prints the result whole, as before. **Exit codes**: 0 when nothing
failed, whatever `errors` holds — an app's console error is information, not a
failed shot; 1 when a step failed, or a gate did not hold; 2 for a flag mc
refuses. When the script answers `ok: false`, mc prints `mc: <error>` on stderr
and then the result's `error` lines, so a page that crashed before the picture
still says why. With `--compare`, each side's `error`, `eval` and `failed`
lines come after the diff, each prefixed with its side (`here: ` or `<ref>: `),
so lines 1 and 2 stay the two files; a failed step on either side exits 1.

## A kept browser

A shot opens one browser and closes it in the same call. A session that cannot
foresee every step then signs in again, navigates again and repeats every
earlier action on each call, and loses what the page held in memory (an
unlocked vault, typed text). Measured 2026-10-24: vault's planning session
drove Claude in Chrome for 58 calls through setup → unlock → add entry →
search → import, and ran `mc shot` in between only to get the dev server
restarted after its edits. Martin: "det är viktigt att mc shot också hela tiden
kan stegas vidare på ett enkelt sätt, om nu inte modellen kan förutse alla
stegen redan från början. Alla felmeddelanden ska komma tillbaka direkt." So a
browser can be kept, and stepped one call at a time:

```
mc shot <dev|prod> <target> --keep [shot flags]
mc shot next [<id>] [--click …]… [--context-click …]… [--long-press …]… [--fill …]…
        [--eval …|--eval-file …]… [--upload …]… [--press …]… [--wait-for <css>]
        [--scroll …] [--measure …] [--el <css>|--shell …] [--full] [--timeout <s>]
        [--goto <path|target>|--reload] [--no-shot] [--out <file.png>] [--json] [--open]
mc shot close [<id>|--all]
mc shot sessions
```

For example:

```
mc shot dev /app/tools/vault --keep --fill 'input[name=setupPassword]=…' --click 'text=Create Vault' --timeout 30
mc shot next --click 'text=New entry' --eval 'document.activeElement.name'
```

- **`--keep`** is a shot whose request has `mode: "session"` and `socket`. The
  script answers the first capture as a shot does, and mc prints exactly what a
  shot prints, then `mc: kept as <id> — mc shot next <id> [--click …] [--eval …]
  …; mc shot close <id>` on stdout (with `--json`, the object carries `kept`
  instead). It is refused with `--compare`: `--keep` keeps one browser and
  `--compare` runs two. The script is spawned as `mc dev open --open` spawns
  one (`spawnDetached` in [`src/mc/shot.js`](../../src/mc/shot.js)), its stderr
  to the session's log, and the request directory goes once the first line is
  read. A first answer of `ok: false` ends the process and keeps nothing.
- **`next`** is one step on that page. Without an id it is the most recently
  used session of the worktree `shotWorktree` chooses where you stand, else the
  only one; with several elsewhere it refuses and names them. Its answer prints
  exactly as a shot's — path, URL, measure, access, `error`, `eval`, `failed`
  and warning lines, the same exit codes — so a session reads every step the
  same way; every error since the previous step comes back with it. `--goto`
  goes to a path or a declared target inside the app, as a capture navigates;
  `--reload` loads the current URL again; `--no-shot` answers without a
  picture, so there is no path line and the URL comes first. Without `--out`
  the file is named as a shot's with `-<id>-<step>` after the target. **A failed
  step leaves the page where it stood**: the next call continues from there.
- **`close`** asks the session to close, waits up to 5 s for its process to
  leave, else ends its process group, and removes its files. **`sessions`**
  prints one line per live session — `<id>  <where> <target>  <worktree
  basename>  <viewport>  idle <n> min` — and removes the files of dead ones.
- **At most four** are live. A fifth `--keep` closes the longest idle one first
  and says so on stderr. The id is `s<n>`, the lowest number no live session
  holds.

### The session file and the socket

Both live in `~/.memoro/mc/shots/sessions/` (`mcHome()/shots/sessions`), mode
0700. `<id>.json` is mode 0600:

```
{ id, pid, socket, log, where, worktree, account, target, viewport, base_url,
  server_id, started, last_used, steps, sign_in_path? }
```

`steps` counts the steps sent; `sign_in_path` is a dev session's `/dev/login`
path, which holds no secret. Neither file carries a token, a cookie or a prod
sign-in URL: those reach the script once, in the request file, which is gone
before the session file is written. `<id>.sock` is the script's unix socket;
mc narrows it to 0600 once it exists. `<id>.log` is the script's stderr.

On the socket, one JSON line goes each way per connection. mc sends a step:

```
{ step, actions, wait_for, scroll, measure, element, shell, full_page, out,
  goto, reload, shot, timeout_ms, rebase? }
```

`step` counts from 1; `actions` is the acting flags in argv order, as a
capture's; `goto` is `{ path }` or `{ name }`, as a capture's `target`; `out` is
null when `shot` is false. The script answers one capture result line, as a
shot's result. `{ close: true }` asks it to close; it answers a line and
exits. Every read has a timeout — a step's as `runCapture`'s, from
`timeout_ms`; a close's 5 s — so a dead session is never a hang.

### A dead session

`next` on a session whose process is gone, or whose socket refuses or closes
without an answer, prints one line and exits 1: `mc: <id> has ended (<the last
line of its log>) — start again with mc shot <where> <target> --keep`, and the
session's files go. A script ends itself when it has been idle long enough; how
long is memoro's capture script's to say (project shot-session-capture), and mc
meets it as a dead session.

### Rebasing after an edit

Before each step of a dev session, `next` runs `ensureAppServer` for the
session's worktree, as a shot does: a server whose tree moved or was edited is
started over. When the server's id or URL is no longer the session's, the step
carries `rebase: { base_url, sign_in }` — the new base URL and the dev
`/dev/login` URL — and the script signs in again and opens the page it stood on
there, answering `rebased` (`true` or `{ path }`). mc writes the new
`base_url` and `server_id` to the session file and prints, after the result,
`mc: the tree was edited, so the server restarted — the page was opened again at
<path>; what it held in memory is gone`. A script that does not answer
`rebased` gets a warning instead, and the next step tries again. Prod never
rebases: production has one server.

## mc dev open and mc dev surfaces

They read the same `.mc/shot.json` as `mc shot`, choose the worktree the same
way (`shotWorktree`: the one you stand in when it has `.mc/shot.json`, else the
shared checkout; `--here` forces the first), and start or restart its server
through the same `ensureAppServer`.

```sh
mc dev surfaces [--here] [--json]
mc dev open <surface> [--account <name>] [--onboarding] [--here] [--json]
mc dev open <surface> --open [--viewport <v>] [--theme light|dark] [--locale <code>] [--safe-area <t,r,b,l>|0]
```

`mc dev surfaces` starts no server. It prints one line per declared target —
name, path, summary (`-` when there is none) — then a blank line and
`accounts: seeded (done, fresh) · new (done, fresh)`, the default first.
`--json` is `{ schema_version, worktree, surfaces: [{ name, path, summary,
window, scroller, chrome, measure, onboarding }], accounts, default_account }`,
with `measure` as the declared names `--measure @<name>` takes.

`mc dev open <surface>` takes a declared name or a path under `/app`. The
surface and the account are resolved before any server, so a wrong word costs
nothing. Then it prints one line on stdout:

```
http://127.0.0.1:8920/dev/login?account=new&ready=1&next=%2Fapp%2Fassistant  new/done  my-branch @ 1025664171
```

— the URL that signs in as the account in its onboarding state and lands on
the surface (`next`), the account and state, and the tree served. A target that
opens a window by clicking adds `then click: <selector> → <selector>`: the
clicks a person or a browser tool makes after landing. A `fresh` state says on
stderr that the URL reseeds the account each time it is opened. `--json` is
`{ url, account, onboarding, surface, served, then }`.

**`--open`** hands memoro's capture script a request in mode `open` — the URL
above as `sign_in`, the target, the viewport, theme, locale and safe area —
and the script leaves a headed browser on the surface. mc spawns it detached,
its stderr to `~/.memoro/mc/shots/open-<YYYYMMDD-HHMMSS>.log`, reads its stdout
until the first result line, and lets go: the request file is removed, the
same one line is printed, and the browser lives until its window is closed.
A script that exits first, or has not answered in 150 s, is an error naming the
log. `--viewport`, `--theme`, `--locale` and `--safe-area` are for `--open`
only (a URL has no viewport); `--open` is refused on a Linux machine with no
display.

A layout question is two calls: look, then measure.

```sh
mc dev open assistant --viewport iphone --open
mc shot dev assistant --viewport iphone --scroll @end --measure @layout
```

## Worktree, server and sign-in

The worktree is the one you stand in when it is a memoro worktree (it has
`.mc/shot.json`); elsewhere it is the shared memoro checkout
(`sharedWorktree`). `--here` still names the one you stand in explicitly.
Until 2026-10-15 the shared checkout was the default everywhere, so a session
on its own branch photographed `main` unless it remembered `--here`.

The dev server is `ensureAppServer`'s, and it is started over when its tree
moved (`builtFromMoved`) **or when a file git reports as changed or new was
written after the server started** (`editedSince`): workerd reads the tree
once, so an uncommitted fix was invisible until someone restarted the server
by hand. mc then prints, on stderr, `mc: serving <worktree> — <branch> @
<commit> on <url>`, and `--json` carries it as `served` — the evidence that
the picture is of the tree you mean, which a port never was. mc reads `.mc/shot.json` from it, plus `.mc/test.json`
through `readDeclaration`. A memoro without `.mc/shot.json` gets the error
`memoro has no .mc/shot.json at <worktree> — it comes with memoro's shot-capture project`.

| Case | Base URL | `account` | `sign_in` |
|---|---|---|---|
| `dev` | the app tier, started if it is down, through `ensureAppServer` — the same function `mc test dev` calls | the table's `default_account` (`seeded`), or `--account <name>` | `{ kind: "url", url: "<base><path>" }`, where the path is the `accounts` table's entry for the account and state |
| `prod` | `.mc/test.json` `environments.prod.base_url` | `seeded` | `{ kind: "url", url: "<base><account.route>/<token>" }`, with the token from `tokenFor` (environment, then keychain) |
| `prod --me` | the same | `me` | `{ kind: "session", cookie }`, from the keychain entry `MEMORO_SHOT_SESSION` |

When the token is missing, mc says `no test-account token — printf %s <token> | mc test token --set`.
When no session is stored, it says `no session of yours is stored — mc shot login prod`.
Both exit 1.

## The interface to memoro

mc runs `.mc/shot.json` `argv` with `cwd` set to the memoro worktree and
`MEMORO_SHOT_REQUEST=<path>` in the environment. The request is a JSON file,
mode 0600, in a fresh `mkdtemp` directory, and it is removed in a `finally`. It
is the only place the token or the cookie is written. Before the script runs, mc
removes the test-account variables (`account.token_env` and `account.url_env`)
from the script's environment, so a token exported in your shell reaches the
script only through the request file. Capture mode sends `mode`, `base_url`,
`account`, `sign_in`, `target`, `element`, `shell`, `full_page`, `viewport`,
`theme`, `locale` and `out`. Login mode sends `mode`, `base_url`, `account` and
`profile_dir`. The shape is fixed in the `mc-shot` project's contract (its row of 2026-09-26 in `docs/project/project_log.md`).

Capture mode also sends `click` and `actions`. `actions` is every acting flag in
the order given, one object each: `{ kind, selector }`, with `text` on a `fill`
and `ms` on a `long-press`; `kind` is `click`, `context-click`, `long-press` or
`fill`. `click` is the same selectors when every action is a plain click, and
`null` when one is not, so a script that knows only `click` takes the picture
without its actions and mc says so. A result answers `clicked`, one entry per
click, when every action is a click, and `acted`, one entry per action,
otherwise.

Three more kinds: `{ kind: "eval", script }`, `{ kind: "upload", selector, file }`
(`file` an absolute path) and `{ kind: "press", key }` (no selector). Each makes
`click` null. After `actions` comes `timeout_ms`: milliseconds each wait and
action may take, or `null` for the script's own 10 s. A capture result may
carry `errors` (`[{ kind, text, count? }]`, `kind` one of `page`, `console`,
`request`, `server`, `dialog`), `evaluated` (`[{ value }]` or `[{ error }]`,
one per eval action, in order) and `failed` (`{ step, kind, selector?, key?,
error, here? }`, `step` counted from 1). A result with `failed` is not asked for
a full `acted`: the steps after the failed one were not done, and the `failed`
line says so. A failure result (`ok: false`) may carry `errors` too. The
capture script performing these is memoro's project `shot-report-capture`.

The script's stderr goes straight to your terminal, so you see its progress.
mc reads stdout, and the last non-empty line there must be the one result
object: `{ ok: true, file, url, subject, selector, width, height, warnings }`
for a capture, `{ ok: true, session }` for a login, or
`{ ok: false, code, error }`. The run times out after 180 s, or longer with
`--timeout` (§ *Measuring a layout*). mc reports an error,
with the script's exit code in it, when the last line does not parse, when there
is no result line, or when the run times out. On `ok: false`, mc prints
`mc: <error>` and exits 1. If the code is `not-signed-in` and the account is
`me`, it adds a second line: `mc shot login prod`. As a second safeguard, mc
also scrubs the token and the cookie from everything it prints, in case a script
echoes them.

## Where the file goes

`--out` is resolved against the current directory. It must end in `.png`, and
mc creates its directory. Without `--out` the file goes to
`~/.memoro/mc/shots/` (`mcHome()/shots`), named in local time:

```
<YYYYMMDD-HHMMSS>-<dev|prod>[-me]-<target>[-<shell>|-el]-<viewport>[-<theme>].png
```

`<target>` is the target name, or the path as a slug (`/app/people` →
`app-people`, `/app/` → `app`), and `<viewport>` is the name or `WxH`. Nothing
in the name comes from a secret.

## What `--me` can and cannot do

`mc shot login prod` runs the script in login mode. A Chrome window opens on a
profile mc keeps at `~/.memoro/mc/shots/.chrome-profile-prod`, you sign in with
Google or Apple, and the script hands back the `memoro_session` cookie. mc then
stores the cookie in the keychain as `MEMORO_SHOT_SESSION`, prints
`mc: your session is stored — mc shot prod <target> --me`, and never prints the
value. The profile persists, so the next login is one click. Google sometimes
refuses an automated browser. When that happens, the script's timeout message
names the fallback: `mc shot login prod --paste`. It reads the cookie value from
stdin (copy it from meetmemoro.app in Chrome, under DevTools → Application →
Cookies), trims it, and strips a leading `memoro_session=`. `mc shot logout prod`
deletes the keychain entry.

mc does not check the session when it stores it. memoro keeps a session alive
for 90 days of disuse. A wrong or expired session shows up on the next `--me`
shot, which reports `not-signed-in` and tells you to run `mc shot login prod`.

There is no `--me` on a dev server. A local server has only the managed accounts
that `/dev/login` offers, and `mc shot dev` uses the table's default account
unless `--account` names another one.

## Out of scope

The capture script, the targets and the selectors belong to memoro. Also out of
scope: visual diffing, capturing every target in one run, and sending the file
anywhere but the local disk.
