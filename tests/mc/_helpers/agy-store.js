/**
 * A throwaway agy home for tests: `<home>/.gemini/antigravity-cli/` with the
 * pieces mc reads (`brain/<id>/.system_generated/logs/transcript.jsonl`,
 * `conversations/<id>.db` and `annotations/<id>.pbtxt`). Every byte is made
 * here; nothing is copied from a real agy home. The database holds the one
 * table mc reads, `trajectory_metadata_blob`, whose blob carries the workspace
 * as a length-prefixed `file://` string inside protobuf-like framing.
 */
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { launchMarker } from '../../../src/mc/launch-marker.js';

function sqlite() {
  const emit = process.emitWarning;
  process.emitWarning = (warning, ...rest) => (/SQLite/u.test(String(warning?.message ?? warning)) ? undefined : emit.call(process, warning, ...rest));
  try { return process.getBuiltinModule('node:sqlite'); } finally { process.emitWarning = emit; }
}

const varint = (value) => (value < 0x80 ? [value] : [(value & 0x7f) | 0x80, value >> 7]);

/** The blob agy keeps its workspaces in: a tag byte, then each path as a length-prefixed `file://` string. */
export function workspaceBlob(...paths) {
  return Buffer.concat(paths.map((path) => {
    const text = Buffer.from(`file://${path}`);
    return Buffer.concat([Buffer.from([0x0a, ...varint(text.length)]), text, Buffer.from([0x12, 0x00])]);
  }));
}

export function agyStore(root = mkdtempSync(join(tmpdir(), 'mc-agy-'))) {
  const home = join(root, '.gemini', 'antigravity-cli');
  const brain = join(home, 'brain');
  mkdirSync(brain, { recursive: true });
  mkdirSync(join(home, 'conversations'), { recursive: true });
  mkdirSync(join(home, 'annotations'), { recursive: true });
  const store = {
    root, home, brain, env: { HOME: root },
    /** The opening message agy records for a launch of mc's: the wrapper, the marker, then the words. */
    opening: ({ launch = null, role = null, programme = null, words = 'do the thing' } = {}) => `<USER_REQUEST>\n${launch ? `${launchMarker({ launch, role, programme })}\n\n` : ''}${words}\n</USER_REQUEST>`,
    transcriptPath: (id) => join(brain, id, '.system_generated', 'logs', 'transcript.jsonl'),
    /** One conversation. `workspace: null` leaves no database, a string the blob names it, `workspaces` several. */
    addConversation({ id, workspace = null, workspaces = workspace ? [workspace] : [], steps = null, content = 'hello', model = null, mtime = null, db = true, blob = null }) {
      const path = store.transcriptPath(id);
      mkdirSync(join(path, '..'), { recursive: true });
      const written = steps || [
        { type: 'USER_INPUT', content },
        { type: 'PLANNER_RESPONSE', content: 'done', ...(model ? { model } : {}) },
      ];
      writeFileSync(path, `${written.map((step) => JSON.stringify(step)).join('\n')}\n`);
      if (db) {
        const { DatabaseSync } = sqlite();
        const file = join(home, 'conversations', `${id}.db`);
        const handle = new DatabaseSync(file);
        handle.exec('create table trajectory_metadata_blob (data blob)');
        handle.prepare('insert into trajectory_metadata_blob (data) values (?)').run(blob || workspaceBlob(...workspaces));
        handle.close();
      }
      writeFileSync(join(home, 'annotations', `${id}.pbtxt`), 'note: "x"\n');
      if (mtime !== null) { utimesSync(path, mtime / 1000, mtime / 1000); }
      return { id, path };
    },
  };
  return store;
}
