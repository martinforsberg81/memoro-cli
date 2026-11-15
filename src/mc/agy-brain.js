/**
 * What mc reads of agy's own storage, in one place.
 *
 * agy keeps a conversation as `brain/<id>/.system_generated/logs/transcript.jsonl`
 * (one JSON step per line) and, beside it, `conversations/<id>.db`. The
 * transcript says what was said; the database says where: the workspace is a
 * `file://` string inside `trajectory_metadata_blob`, an undocumented protobuf.
 * Nothing here writes. A database mc cannot read, or one that names no
 * workspace, means "not this area's": a conversation that cannot be placed is
 * never listed, never resumed and never deleted.
 */
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, lstatSync, openSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { readLaunchMarker } from './launch-marker.js';

const HEAD_BYTES = 1024 * 1024;
const FILE_PREFIX = Buffer.from('file://');

export function agyHome(env = process.env) {
  return join(env.HOME || homedir(), '.gemini', 'antigravity-cli');
}

export function agyBrainDir(env = process.env) {
  return join(agyHome(env), 'brain');
}

export function agyTranscriptPath(brainDir, id, full = false) {
  return join(brainDir, id, '.system_generated', 'logs', full ? 'transcript_full.jsonl' : 'transcript.jsonl');
}

let sqlite;
/** `node:sqlite` without its experimental warning on mc's stderr; null where this Node has none. */
function loadSqlite() {
  if (sqlite !== undefined) return sqlite;
  const emit = process.emitWarning;
  process.emitWarning = (warning, ...rest) => {
    if (/SQLite/u.test(String(warning?.message ?? warning))) return undefined;
    return emit.call(process, warning, ...rest);
  };
  try { sqlite = process.getBuiltinModule?.('node:sqlite') ?? null; } catch { sqlite = null; }
  finally { process.emitWarning = emit; }
  return sqlite;
}

const printable = (buffer, from, to) => {
  for (let i = from; i < to; i += 1) if (buffer[i] < 0x20 || buffer[i] > 0x7e) return false;
  return true;
};

/**
 * Every `file://` string in a protobuf blob. A string is length-prefixed (a
 * varint, one or two bytes here), so the length is read rather than guessed:
 * scanning for the end of the printable run takes the next field's tag byte
 * along with the path.
 */
export function workspacesIn(blob) {
  const buffer = Buffer.from(blob);
  const found = [];
  let from = 0;
  for (;;) {
    const at = buffer.indexOf(FILE_PREFIX, from);
    if (at < 0) break;
    from = at + FILE_PREFIX.length;
    const candidates = [];
    if (at >= 2 && (buffer[at - 2] & 0x80) && buffer[at - 1] < 0x80) candidates.push((buffer[at - 2] & 0x7f) | (buffer[at - 1] << 7));
    if (at >= 1 && buffer[at - 1] < 0x80) candidates.push(buffer[at - 1]);
    for (const length of candidates) {
      if (length < FILE_PREFIX.length || at + length > buffer.length || !printable(buffer, at, at + length)) continue;
      let path = buffer.toString('latin1', at + FILE_PREFIX.length, at + length);
      try { path = decodeURIComponent(path); } catch { /* keep it as written */ }
      if (path.startsWith('/') && !found.includes(path)) found.push(path);
      break;
    }
  }
  return found;
}

/**
 * The workspaces a conversation was run in, read-only from its database, or
 * null when they cannot be read (no database, locked, not a database, not the
 * shape mc knows, no `node:sqlite`). An empty list is a database that names none.
 */
export function agyWorkspaces(env, id) {
  const module = loadSqlite();
  if (!module?.DatabaseSync) return null;
  let db = null;
  try {
    db = new module.DatabaseSync(join(agyHome(env), 'conversations', `${id}.db`), { readOnly: true });
    const rows = db.prepare('select data from trajectory_metadata_blob').all();
    const paths = [];
    for (const row of rows) {
      if (!(row.data instanceof Uint8Array)) continue;
      for (const path of workspacesIn(row.data)) if (!paths.includes(path)) paths.push(path);
    }
    return paths;
  } catch { return null; }
  finally { try { db?.close(); } catch { /* closed */ } }
}

/** The bounded head of a transcript, parsed. */
export function readSteps(path, bytes = HEAD_BYTES) {
  let fd = null;
  try {
    fd = openSync(path, 'r');
    const buffer = Buffer.alloc(bytes);
    const read = readSync(fd, buffer, 0, bytes, 0);
    return buffer.subarray(0, read).toString('utf8').split('\n').flatMap((line) => {
      if (!line.startsWith('{')) return [];
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  } catch { return []; } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* closed */ } }
  }
}

/** The opening user message of a transcript, or null. */
export function firstUserContent(path) {
  for (const step of readSteps(path)) {
    if (step?.type === 'USER_INPUT') return typeof step.content === 'string' ? step.content : null;
  }
  return null;
}

/** The launch marker mc put at the head of the conversation's opening message, or null. */
export function conversationLaunch(brainDir, id) {
  for (const full of [false, true]) {
    const marker = readLaunchMarker(firstUserContent(agyTranscriptPath(brainDir, id, full)));
    if (marker) return marker;
  }
  return null;
}

/**
 * Whether any process holds one of these files, or anything under this
 * directory, open: true, false, or null when lsof cannot say (callers treat
 * null as "open": what cannot be shown closed is not removed).
 */
export function agyHeldOpen({ files = [], directory = null }, { run = spawnSync } = {}) {
  const asks = [];
  const present = files.filter((path) => { try { lstatSync(path); return true; } catch { return false; } });
  if (present.length) asks.push(['-nP', '-t', '--', ...present]);
  if (directory && existsSync(directory)) asks.push(['-nP', '-t', '+D', directory]);
  for (const args of asks) {
    let result;
    try { result = run('lsof', args, { encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }); } catch { return null; }
    if (result.error || String(result.stderr || '').trim()) return null;
    const held = String(result.stdout || '').split('\n').some((line) => /^[1-9]\d*$/u.test(line.trim()));
    if (held) return true;
    if (result.status !== 0 && result.status !== 1) return null;
  }
  return false;
}
