/**
 * What a failed command gate said, kept whole enough that nobody runs it again
 * to see what failed (Martin, 2026-11-10).
 *
 * A command gate is a script of the repository's — memoro's contract gates run
 * node's spec reporter to stdout, others print their own lines. Until
 * 2026-11-10 the round kept `stderr || stdout`, trimmed: a gate that wrote a
 * warning to stderr lost its whole failing-test list, and memoro#15149's
 * `test:browser-contracts` left `exit 1` and nothing else.
 *
 * So the failure is read three ways, in order, from stdout and stderr together:
 * TAP's red tests (`redTests`), node's spec reporter's `✖ failing tests:`
 * section verbatim, and the output's last lines. The whole output is written
 * to a file beside the round's record (`writeCommandOutput`).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { redTests } from './tap-red.js';

/** At most this many lines of the spec reporter's failure section are kept. */
export const SPEC_LINES = 600;
/** At most this many of the output's last lines are kept when it names no test. */
export const TAIL_LINES = 150;

const SPEC_FAILING = /^\s*✖ failing tests:\s*$/u;
const TAP = /^(?:TAP version \d+|\s*not ok \d+ )/mu;

/** stdout and stderr as one text, each labelled when both said something. */
export function combinedOutput({ stdout, stderr }) {
  const out = String(stdout || '').trimEnd();
  const err = String(stderr || '').trimEnd();
  if (out && err) return `${out}\n--- stderr ---\n${err}`;
  return out || err;
}

/**
 * The failure a command's output describes: `{ tests, spec, tail }` — its red
 * tests when it printed TAP (file, name, place and whole error), the spec
 * reporter's failing-tests section when it printed one, and its last lines
 * when it named neither.
 */
export function commandFailure({ stdout, stderr, cwd = null }) {
  const text = combinedOutput({ stdout, stderr });
  const lines = text.split('\n');
  const tests = TAP.test(text) ? redTests(text, null, { cwd }) : [];
  const start = lines.findIndex((line) => SPEC_FAILING.test(line));
  let spec = [];
  if (start >= 0) {
    spec = lines.slice(start + 1).filter((line, index, all) => line.trim() || (index > 0 && all[index - 1].trim()));
    if (spec.length > SPEC_LINES) spec = [...spec.slice(0, SPEC_LINES - 1), `… ${spec.length - SPEC_LINES + 1} more lines in the whole output`];
  }
  const tail = tests.length || spec.length ? [] : lines.slice(-TAIL_LINES);
  return { tests, spec, tail };
}

/**
 * A failed command's whole output written under `dir` as `<name>.log`, and its
 * path; null when it cannot be written — a record must never fail the round.
 */
export function writeCommandOutput({ dir, name, command, exit, signal = null, stdout, stderr }) {
  if (!dir) return null;
  try {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${String(name).replace(/[^A-Za-z0-9._-]+/gu, '_')}.log`);
    writeFileSync(path, `$ ${command}\nexit ${exit ?? 'none'}${signal ? `, signal ${signal}` : ''}\n\n${combinedOutput({ stdout, stderr })}\n`);
    return path;
  } catch {
    return null;
  }
}
