#!/usr/bin/env node
/**
 * The live page, checked in a real terminal.
 *
 * `tests/mc/page-live.test.js` asserts the bytes and the timing with no
 * terminal involved, which is the right way to test a differ and a loop. It
 * cannot say what a terminal does with those bytes — whether the scrollback
 * above the page is still intact after ten refreshes, whether a half-typed
 * answer is still under the cursor, whether the terminal `mc` gives back is
 * the one it was handed. That is what this is: a real pty, the real `mc`, and
 * an xterm reading the screen afterwards.
 *
 *     node scripts/mc-live-page-check.mjs [refreshes]     # default 10
 *
 * It is slow by construction — the interval is 30 s and there is no way to
 * configure it, which is the point — so ten refreshes take a little over five
 * minutes. It is not part of `npm test`.
 *
 * The work root is a fixture in a temporary directory, not `~/mc`: the check
 * needs the page to change on every refresh, and the only honest way to have
 * that is to change something the page reads. It rewrites the PR cache's
 * timestamp, which moves one row — the cache's age — without moving any other.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import headlessPackage from '@xterm/headless';
import { spawn } from 'node-pty';

const { Terminal } = headlessPackage;

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const REFRESH_MS = 30_000;
const COLS = 100;
const ROWS = 40;
const MARKER = 'MARKER-the-scrollback-above-the-page';

const refreshes = Number(process.argv[2] || 10);
const failures = [];
const say = (ok, what, detail = '') => {
  if (!ok) failures.push(what);
  process.stdout.write(`${ok ? '  ok  ' : '  NO  '}${what}${detail ? ` — ${detail}` : ''}\n`);
};

/** A work root with two areas, a queue, and a PR cache whose age can be moved. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mc-live-check-'));
  const workRoot = join(root, 'work');
  mkdirSync(join(workRoot, 'runner', 'log'), { recursive: true });
  writeFileSync(join(workRoot, 'queue.md'), '# the queue\nalpha\n');
  // A machine that has been set up, which is what the check is about: a fresh
  // MC_HOME sends the front door to the keychain before it prints anything.
  mkdirSync(join(root, 'home'), { recursive: true });
  writeFileSync(join(root, 'home', '.setup-done-v1'), new Date().toISOString());
  for (const name of ['alpha', 'beta']) mkdirSync(join(workRoot, name, 'memoro-cli', '.git'), { recursive: true });
  return { root, workRoot };
}

const fx = fixture();
const stty = { before: join(fx.root, 'stty-before'), after: join(fx.root, 'stty-after') };
/**
 * Age the PR cache, so exactly one row moves and nothing else does.
 *
 * Kept under 90 seconds and stepped by 7: `ageWords` says seconds below 90 and
 * rounded minutes above it, so an age that walks upwards by one second stops
 * changing the row it draws — which is a page that is right to write nothing,
 * and useless for counting refreshes.
 */
let age = 0;
const movePage = () => {
  age = (age + 7) % 80;
  const fetched = new Date(Date.now() - (age + 1) * 1000).toISOString();
  writeFileSync(join(fx.workRoot, 'runner', 'prs.json'), JSON.stringify({ fetched, prs: [] }));
};
movePage();

const term = new Terminal({ cols: COLS, rows: ROWS, scrollback: 5000, allowProposedApi: true });
let raw = '';

// stty before and after, in the same terminal and the same shell: the exact
// question "is this the terminal mc was handed" has an exact answer.
const script = [
  `stty -g > ${stty.before}`,
  `echo "${MARKER}"`,
  `node ${join(REPO, 'src', 'mc-cli.js')}`,
  'code=$?',
  `stty -g > ${stty.after}`,
  'echo "mc-exit=$code"',
].join('; ');

const pty = spawn('/bin/sh', ['-c', script], {
  name: 'xterm-256color',
  cols: COLS,
  rows: ROWS,
  cwd: REPO,
  env: {
    ...process.env,
    MC_HOME: join(fx.root, 'home'),
    MC_WORK_ROOT: fx.workRoot,
    MC_REPOS_HOME: join(fx.root, 'repos'),
    MC_ROLES_DIR: join(fx.root, 'roles'),
    CLAUDE_CONFIG_DIR: join(fx.root, 'claude'),
    CODEX_HOME: join(fx.root, 'codex'),
    MC_REPOS: '',
    NO_COLOR: '1',
  },
});
pty.onData((data) => { raw += data; term.write(data); });

let exited = null;
pty.onExit(({ exitCode }) => { exited = exitCode; });

const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const until = async (fn, ms) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await wait(200);
  }
  return false;
};

/** Every line the terminal holds, scrollback included. */
function lines() {
  const buffer = term.buffer.active;
  const all = [];
  for (let i = 0; i < buffer.length; i += 1) all.push(buffer.getLine(i)?.translateToString(true) ?? '');
  return all;
}
const count = (needle) => lines().filter((line) => line.includes(needle)).length;
const promptRow = () => {
  const buffer = term.buffer.active;
  return buffer.getLine(buffer.baseY + buffer.cursorY)?.translateToString(true) ?? '';
};

/** One SAVE-cursor per frame that wrote something: that is how many refreshed. */
const framesWritten = () => (raw.match(/\x1b7/gu) || []).length;

process.stdout.write(`the live page in a real terminal — ${refreshes} refreshes, ${REFRESH_MS / 1000}s apart\n`);

const promptUp = await until(() => promptRow().startsWith('>'), 60_000);
say(promptUp, 'the page is printed and the prompt is waiting', promptRow());
if (!promptUp) finish();

const markersBefore = count(MARKER);
const pagesBefore = count('PROGRAMMES');
say(markersBefore === 1, 'the marker line above the page is on screen once', `${markersBefore}`);

// Half-typed, and left half-typed for the whole run.
pty.write('1');
await wait(500);
say(promptRow() === '> 1', 'the typed 1 is at the prompt', JSON.stringify(promptRow()));

const started = Date.now();
for (let round = 1; round <= refreshes; round += 1) {
  // Keep the page moving, so a refresh that happens has something to write and
  // one that does not happen cannot hide behind an unchanged page.
  const moving = setInterval(movePage, 2000);
  const seen = framesWritten();
  const ok = await until(() => framesWritten() > seen, REFRESH_MS * 2);
  clearInterval(moving);
  process.stdout.write(`  · refresh ${round}/${refreshes} ${ok ? 'drawn' : 'MISSING'} at +${Math.round((Date.now() - started) / 1000)}s\n`);
  if (!ok) say(false, `refresh ${round} arrived`);
}

const markersAfter = count(MARKER);
say(markersAfter === 1 && markersBefore === 1, `the marker is still there, once, after ${refreshes} refreshes`, `${markersAfter}`);
say(count('PROGRAMMES') === pagesBefore, 'the page is on the screen once, not printed again under itself', `${count('PROGRAMMES')} of ${pagesBefore}`);
say(promptRow() === '> 1', 'the half-typed 1 survived every refresh', JSON.stringify(promptRow()));
say(term.buffer.active.cursorX === 3, 'and the cursor is still after it', `column ${term.buffer.active.cursorX}`);
say(raw.includes('\x1b['), 'the refreshes were writes, not reprints', `${framesWritten()} frames written`);

// Take the 1 back and leave the way a person leaves.
pty.write('\x7f');
await wait(300);
say(promptRow().trimEnd() === '>' && term.buffer.active.cursorX === 2, 'backspace takes it back', `${JSON.stringify(promptRow())} column ${term.buffer.active.cursorX}`);
pty.write('q\r');

const gone = await until(() => exited !== null, 30_000);
say(gone && raw.includes('mc-exit=0'), 'q leaves, and mc exits 0');
say(!raw.includes('\x1b[?1049'), 'no alternate screen buffer was ever entered');

const before = readFileSync(stty.before, 'utf8').trim();
const after = readFileSync(stty.after, 'utf8').trim();
say(before === after && before !== '', 'the terminal is exactly as mc found it', before === after ? 'stty -g matches' : `${before} vs ${after}`);

finish();

function finish() {
  try { pty.kill(); } catch { /* gone */ }
  const tail = lines().filter(Boolean).slice(-6).join('\n');
  process.stdout.write(`\nthe last frame, left in the scrollback:\n${tail}\n\n`);
  if (failures.length) process.stdout.write(`${failures.length} failed: ${failures.join('; ')}\n`);
  else process.stdout.write('all checks passed\n');
  rmSync(fx.root, { recursive: true, force: true });
  process.exit(failures.length ? 1 : 0);
}

