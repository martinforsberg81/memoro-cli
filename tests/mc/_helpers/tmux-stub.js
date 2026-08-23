/**
 * A tmux that behaves like the real one — including the way it misbehaves.
 *
 * The bug this exists for: text and Enter sent together often leave the text
 * sitting in a TUI's prompt, unsubmitted. Nobody can assert a fix for that
 * against the real tmux in a test suite, so the stub can be told to swallow
 * the first Enter (`sticky`), to swallow every Enter (`broken`), or to behave
 * (`reliable`) — and it records every call, so a test can also assert *how*
 * the keystrokes were sent, not only what came of them.
 *
 * The pane it draws is the shape that matters: a conversation above, an input
 * box of four lines at the foot. Reading back more than that box would make a
 * submitted turn look like an unsubmitted one.
 *
 * `drawAfter` makes it slow to paint: the first N captures show an empty box
 * even though the text is in it, which is a loaded TUI seen from outside — and
 * the reason a single glance at the prompt was not enough.
 *
 * `busyFor` makes those first N captures say so, the way a streaming TUI does
 * — the difference between a pane that is working and one that is gone.
 *
 * `C-u` clears the prompt here as it does in a real one, so a test can assert
 * that a wake mc gave up on left nothing behind.
 *
 * The prompt row is drawn with `❯`, which is what a real pane draws — captured
 * from live panes while fixing the wake guards. It also matters beyond looks:
 * `clearTrustDialog` waits for that character to decide a session has settled,
 * and against a `>` it waited out its whole twelve-second budget every time.
 *
 * `clients` puts somebody at the keyboard: `list-clients` names them, which is
 * how mc decides a pane is occupied. `typedAlready` puts text in the input box
 * before mc arrives — a draft, or a notice an earlier wake abandoned.
 *
 * `windowIndex` is what `list-windows` reports, because a window is respawned
 * at the index tmux says it has and `base-index` is the user's setting to
 * make. `clientSession` is what `display-message` answers: the session the
 * caller is sitting in, which decides whether mc can ask a tool to leave
 * politely or has to replace the pane it is itself running in.
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function installTmuxStub(root, {
  mode = 'reliable', alive = [], drawAfter = 0, busyFor = 0, clients = [], typedAlready = '',
  windowIndex = '0', clientSession = '', ghost = '', panes = [], menu = null,
} = {}) {
  const bin = join(root, 'bin');
  const state = join(root, 'tmux-state');
  mkdirSync(bin, { recursive: true });
  mkdirSync(state, { recursive: true });

  const log = join(state, 'calls.log');
  const prompt = join(state, 'prompt.txt');
  const screen = join(state, 'screen.txt');
  const modePath = join(state, 'mode');
  const first = join(state, 'first-enter');
  const captures = join(state, 'captures');
  writeFileSync(log, '');
  writeFileSync(prompt, typedAlready);
  writeFileSync(join(state, 'clients'), clients.join('\n') + (clients.length ? '\n' : ''));
  // `list-panes -a`: one line per pane, the fields the discovery asks for —
  // `{ session, pane, active, windows, panes, path }`, tab-separated.
  writeFileSync(join(state, 'panes'), panes.map((pane) => [pane.session, pane.pane || '%1', pane.active ?? '1', pane.windows ?? '1', pane.panes ?? '1', pane.path].join('\t')).join('\n') + (panes.length ? '\n' : ''));
  writeFileSync(screen, 'a conversation\nthat has been going a while\n');
  // A menu instead of a box: the tool is asking the session something.
  writeFileSync(join(state, 'menu'), menu ? [menu.question || '', ...(menu.options || []).map((option, index) => `${index === 0 ? '❯ ' : '  '}${index + 1}. ${option}`), '', '  Enter to select · ↑/↓ to navigate · Esc to cancel'].join('\n') + '\n' : '');
  writeFileSync(modePath, `${mode}\n`);
  writeFileSync(captures, '0\n');
  for (const name of alive) writeFileSync(join(state, `alive-mc-${name}`), '');

  writeFileSync(join(bin, 'tmux'), `#!/bin/sh
printf '%s\\n' "$*" >> "${log}"
case "$1" in
  has-session)
    if [ -f "${state}/alive-$3" ]; then exit 0; fi
    exit 1
    ;;
  list-clients)
    cat "${state}/clients"
    exit 0
    ;;
  list-windows)
    printf '%s\n' "${windowIndex}"
    exit 0
    ;;
  list-panes)
    cat "${state}/panes"
    exit 0
    ;;
  display-message)
    printf '%s\n' "${clientSession}"
    exit 0
    ;;
  send-keys)
    if [ "$4" = "-l" ]; then
      printf '%s' "$5" >> "${prompt}"
      exit 0
    fi
    if [ "$4" = "C-u" ]; then
      : > "${prompt}"
      exit 0
    fi
    if [ "$4" = "BSpace" ]; then
      current=\`cat "${prompt}"\`
      printf '%s' "\${current%?}" > "${prompt}"
      exit 0
    fi
    # Enter and C-m are the same carriage return to this stub; the real
    # thing was measured to honour one and not the other in some state.
    if [ "$4" = "Enter" ] || [ "$4" = "C-m" ]; then
      mode=\`cat "${modePath}"\`
      case "$mode" in
        broken) exit 0 ;;
        sticky)
          if [ ! -f "${first}" ]; then touch "${first}"; exit 0; fi
          ;;
      esac
      if [ -s "${prompt}" ]; then
        printf '> %s\\n' "\`cat "${prompt}"\`" >> "${screen}"
        : > "${prompt}"
      fi
      exit 0
    fi
    exit 0
    ;;
  capture-pane)
    seen=\`cat "${captures}"\`
    seen=\`expr "$seen" + 1\`
    printf '%s\\n' "$seen" > "${captures}"
    if [ "$seen" -le "${drawAfter}" ]; then shown=""; else shown=\`cat "${prompt}"\`; fi
    # The ghost (D-0151): an empty input is drawn as an old order, and the
    # drawing comes back the moment the input is empty again.
    if [ -z "$shown" ] && [ -n "${ghost}" ]; then shown="${ghost}"; fi
    cat "${screen}"
    if [ -s "${state}/menu" ]; then cat "${state}/menu"; exit 0; fi
    if [ "$seen" -le "${busyFor}" ]; then printf '%s\\n' "  * Thinking… (esc to interrupt)"; fi
    printf '%s\\n' "+------------------------------+"
    printf '| \\342\\235\\257 %s\\n' "$shown"
    printf '%s\\n' "+------------------------------+"
    printf '%s\\n' "  ? for shortcuts"
    exit 0
    ;;
esac
exit 0
`);
  chmodSync(join(bin, 'tmux'), 0o755);

  return {
    bin,
    state,
    calls: () => readFileSync(log, 'utf8').split('\n').filter(Boolean),
    captures: () => Number(readFileSync(captures, 'utf8').trim()),
    /** Keystrokes only — `list-clients` and `capture-pane` are looking, not touching. */
    keys: () => readFileSync(log, 'utf8').split('\n').filter((line) => line.startsWith('send-keys')),
    prompt: () => readFileSync(prompt, 'utf8'),
    screen: () => readFileSync(screen, 'utf8'),
    /** The turns the conversation actually received. */
    submitted: () => readFileSync(screen, 'utf8').split('\n').filter((line) => line.startsWith('> ')),
  };
}
