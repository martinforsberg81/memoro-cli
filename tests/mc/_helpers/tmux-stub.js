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
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function installTmuxStub(root, { mode = 'reliable', alive = [] } = {}) {
  const bin = join(root, 'bin');
  const state = join(root, 'tmux-state');
  mkdirSync(bin, { recursive: true });
  mkdirSync(state, { recursive: true });

  const log = join(state, 'calls.log');
  const prompt = join(state, 'prompt.txt');
  const screen = join(state, 'screen.txt');
  const modePath = join(state, 'mode');
  const first = join(state, 'first-enter');
  writeFileSync(log, '');
  writeFileSync(prompt, '');
  writeFileSync(screen, 'a conversation\nthat has been going a while\n');
  writeFileSync(modePath, `${mode}\n`);
  for (const name of alive) writeFileSync(join(state, `alive-mc-${name}`), '');

  writeFileSync(join(bin, 'tmux'), `#!/bin/sh
printf '%s\\n' "$*" >> "${log}"
case "$1" in
  has-session)
    if [ -f "${state}/alive-$3" ]; then exit 0; fi
    exit 1
    ;;
  send-keys)
    if [ "$4" = "-l" ]; then
      printf '%s' "$5" >> "${prompt}"
      exit 0
    fi
    if [ "$4" = "Enter" ]; then
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
    cat "${screen}"
    printf '%s\\n' "+------------------------------+"
    printf '| > %s\\n' "\`cat "${prompt}"\`"
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
    prompt: () => readFileSync(prompt, 'utf8'),
    screen: () => readFileSync(screen, 'utf8'),
    /** The turns the conversation actually received. */
    submitted: () => readFileSync(screen, 'utf8').split('\n').filter((line) => line.startsWith('> ')),
  };
}
