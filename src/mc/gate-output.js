/**
 * The whole output of what a deploy's preparation ran, and what it states.
 *
 * A gate suite's or command's output used to be held in memory and cut to its
 * last eight or twelve lines, and a refusal named what was left: for a suite
 * that closes with a table of failures that was the closing braces of a
 * stack trace (msr-performance, 2026-11-15). Now each suite writes its stdout
 * and stderr, in the order they came, into one file as it runs, and nothing is
 * cut:
 *
 *   `~/mc/runner/deploy-prepare/<started>/<suite>.log`
 *
 * What the suite says of itself is its closing lines that begin `verdict: `
 * (`docs/technical/testing.md`, memoro): at most ten, verbatim and without the
 * prefix. A refusal gives those lines and the path; a red suite that states
 * none is said so, with the path, never given a guess from its last lines.
 *
 * The files of a refused preparation stay until the stop is settled — a later
 * green gate or a shipped deploy — and are never removed while a repair that
 * names them is unfinished (`settleOutputs`'s `held`).
 */
import {
  closeSync, mkdirSync, openSync, readdirSync, readSync, rmSync, statSync,
} from 'node:fs';
import { join, resolve, sep } from 'node:path';

export const VERDICT_PREFIX = 'verdict: ';

/** The most closing verdict lines a suite's statement is read as. */
export const VERDICT_LINES = 10;

/** How much of the end of a file is read to find its closing lines. */
const TAIL_BYTES = 256 * 1024;

/** Where the preparations' output directories are. */
export function outputRoot(root) {
  return join(root, 'runner', 'deploy-prepare');
}

/** The directory of the preparation started at `started` (the name is safe on every file system). */
export function outputDir(root, started) {
  return join(outputRoot(root), String(started).replace(/[^0-9A-Za-z._-]/gu, '-'));
}

/** The file one suite's whole output goes to. */
export function suiteOutputPath(dir, name) {
  return join(dir, `${String(name).replace(/[^0-9A-Za-z._-]/gu, '-')}.log`);
}

/**
 * The verdict lines a text ends with: the closing lines that begin `verdict: `,
 * with only blank lines after the last, as they were written and without the
 * prefix. At most `VERDICT_LINES` — the last ten when a suite says more. Empty
 * when the text does not end in any.
 */
export function verdictOf(text) {
  const lines = String(text || '').split('\n').map((line) => line.replace(/\r$/u, ''));
  while (lines.length && lines.at(-1).trim() === '') lines.pop();
  const found = [];
  while (lines.length && lines.at(-1).startsWith(VERDICT_PREFIX) && found.length < VERDICT_LINES) {
    found.unshift(lines.pop().slice(VERDICT_PREFIX.length));
  }
  return found;
}

/** The end of a file as text, at most `TAIL_BYTES` of it: '' when it cannot be read. */
export function tailOfFile(path, bytes = TAIL_BYTES) {
  let fd = null;
  try {
    fd = openSync(path, 'r');
    const size = statSync(path).size;
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    let text = buffer.toString('utf8');
    // A read that began inside a line must not make a verdict line of its tail.
    if (size > length) text = text.slice(text.indexOf('\n') + 1);
    return text;
  } catch {
    return '';
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** The verdict lines the file at `path` ends with. */
export function verdictOfFile(path) {
  return verdictOf(tailOfFile(path));
}

/** The last `count` lines of a file, for a person reading a report (never for a refusal). */
export function lastLinesOfFile(path, count = 12) {
  return tailOfFile(path).trimEnd().split('\n').slice(-count).join('\n');
}

/** Open the file for a suite's whole output; the caller closes it. `{ fd, path }`. */
export function openOutput(dir, name) {
  mkdirSync(dir, { recursive: true });
  const path = suiteOutputPath(dir, name);
  return { fd: openSync(path, 'w', 0o600), path };
}

/**
 * Remove the output directories of earlier preparations — every directory
 * under the root except the one of `keep` and any that contains a path in
 * `held` (the output of a repair still unfinished). `{ removed, kept }` lists
 * of directory names; a directory that cannot be removed is kept.
 */
export function settleOutputs(root, { keep = null, held = [], remove = rmSync } = {}) {
  const base = outputRoot(root);
  const holding = held.filter(Boolean).map((path) => resolve(path));
  const keepDir = keep ? resolve(outputDir(root, keep)) : null;
  const removed = [];
  const kept = [];
  let names = [];
  try { names = readdirSync(base); } catch { return { removed, kept }; }
  for (const name of names) {
    const dir = resolve(join(base, name));
    const holds = holding.some((path) => path === dir || path.startsWith(`${dir}${sep}`));
    if (dir === keepDir || holds) { kept.push(name); continue; }
    try {
      if (!statSync(dir).isDirectory()) continue;
      remove(dir, { recursive: true, force: true });
      removed.push(name);
    } catch {
      kept.push(name);
    }
  }
  return { removed, kept };
}
