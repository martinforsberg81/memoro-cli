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
  It is built by memoro's `shot-capture` project
  (`docs/project/test-architecture/shot-capture/PLAN.json` in memoro). mc knows
  no selector, and this document does not repeat the targets: read
  `.mc/shot.json`, or run `mc shot dev --list`.

## The forms

```
mc shot <dev|prod> <target> [--el <css> | --shell base|immersive|window] [--full]
        [--viewport <name|WxH[@dpr]>] [--theme light|dark] [--locale <code>]
        [--me] [--here] [--out <file.png>] [--open] [--json]
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
  warning as `mc: warning — …`. The dev-server progress lines go to stderr.
  `--json` prints the script's result object instead, and `--open` opens the
  file with the platform's opener (`open`, `xdg-open`, `start`), detached.

## Worktree, server and sign-in

The worktree is the shared memoro checkout (`sharedWorktree`), or with `--here`
the one you stand in. mc reads `.mc/shot.json` from it, plus `.mc/test.json`
through `readDeclaration`. A memoro without `.mc/shot.json` gets the error
`memoro has no .mc/shot.json at <worktree> — it comes with memoro's shot-capture project`.

| Case | Base URL | `account` | `sign_in` |
|---|---|---|---|
| `dev` | the app tier, started if it is down, through `ensureAppServer` — the same function `mc test dev` calls | `seeded` | `{ kind: "url", url: "<base>/dev/login?account=seeded&ready=1" }` |
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
`profile_dir`. The shape is fixed in the project's contract
([`PLAN.json`](../project/mc/mc-shot/PLAN.json)).

The script's stderr goes straight to your terminal, so you see its progress.
mc reads stdout, and the last non-empty line there must be the one result
object: `{ ok: true, file, url, subject, selector, width, height, warnings }`
for a capture, `{ ok: true, session }` for a login, or
`{ ok: false, code, error }`. The run times out after 180 s. mc reports an error,
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
that `/dev/login` offers, and `mc shot dev` always uses `seeded`.

## Out of scope

The capture script, the targets and the selectors belong to memoro. Also out of
scope: visual diffing, capturing every target in one run, and sending the file
anywhere but the local disk.
