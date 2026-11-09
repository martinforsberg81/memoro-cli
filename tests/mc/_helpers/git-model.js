/**
 * The modeled Git boundary the scratch export tests use: `ls-tree`, `rev-parse`,
 * `update-ref` and the streamed object reads, answered from an in-memory
 * commit table. Object ids are real git blob ids, so content checks run as
 * they do on disk. It proves mechanism rules only; Git's own behaviour is the
 * separate real-Git probe recorded in the goal log.
 */
import { createHash } from 'node:crypto';

export const ZERO = '0'.repeat(40);
export const sha1 = (text) => createHash('sha1').update(text).digest('hex');
export const blobId = (content) => sha1(`blob ${Buffer.byteLength(content)}\0${content}`);

const SESSION = { session: 'goal:mc/x', started: '2026-11-09T08:00:00Z' };
const nothingStands = () => [];
const nothingOpen = () => [];

/**
 * A Git model at the boundary: commits are trees of `path → content` (or
 * `{ mode, content | target | gitlink }`); `text` answers `rev-parse`,
 * `update-ref` and `ls-tree` as git does; `blobs` streams objects in chunks.
 */
export function gitModel() {
  const commits = new Map();
  const refs = new Map();
  const objects = new Map();
  const retained = new Map();
  const faults = { retainFails: false, corrupt: null, missing: false };
  const model = {
    commit(name, files) {
      const sha = sha1(`commit ${name} ${JSON.stringify(Object.keys(files))}`);
      const tree = new Map();
      for (const [path, spec] of Object.entries(files)) {
        const value = typeof spec === 'string' ? { content: spec } : spec;
        if (value.gitlink) { tree.set(path, { mode: '160000', type: 'commit', sha: value.gitlink, size: null }); continue; }
        const mode = value.target !== undefined ? '120000' : (value.mode ?? '100644');
        const content = value.target !== undefined ? value.target : value.content;
        const sha1Of = blobId(content);
        objects.set(sha1Of, content);
        tree.set(path, { mode, type: 'blob', sha: sha1Of, size: Buffer.byteLength(content) });
      }
      commits.set(sha, tree);
      refs.set(name, sha);
      refs.set('HEAD', sha);
      return sha;
    },
    faults,
    retained,
    refs,
    text(cwd, args) {
      if (args[0] === 'rev-parse') {
        const target = args.at(-1);
        const ref = target.replace(/\^\{commit\}$/u, '');
        if (ref.startsWith('refs/mc/retained-export/')) return retained.has(ref.slice('refs/mc/retained-export/'.length)) ? `${retained.get(ref.slice('refs/mc/retained-export/'.length))}\n` : null;
        if (refs.has(ref)) return `${refs.get(ref)}\n`;
        if (commits.has(ref)) return `${ref}\n`;
        return null;
      }
      if (args[0] === 'update-ref') {
        const [, ref, sha, old] = args;
        if (faults.retainFails || old !== ZERO || !ref.startsWith('refs/mc/retained-export/')) return null;
        if (retained.has(ref.slice('refs/mc/retained-export/'.length))) return null;
        retained.set(ref.slice('refs/mc/retained-export/'.length), sha);
        return '';
      }
      if (args[0] === 'ls-tree') {
        const sha = args[args.indexOf('--full-tree') + 1];
        const tree = commits.get(sha);
        if (!tree) return null;
        const selected = args.slice(args.indexOf('--') + 1);
        let out = '';
        for (const path of [...tree.keys()].sort()) {
          const hit = selected.some((sel) => sel === '.' || path === sel || path.startsWith(`${sel}/`));
          if (!hit) continue;
          const entry = tree.get(path);
          const size = entry.size === null ? '-' : String(entry.size);
          out += `${entry.mode} ${entry.type} ${entry.sha} ${size.padStart(7)}\t${path}\0`;
        }
        return out;
      }
      return null;
    },
    async *blobs(_cwd, shas) {
      for (const sha of shas) {
        let content = objects.get(sha);
        if (content === undefined || faults.missing) throw new Error(`git cat-file exited 128: missing ${sha}`);
        if (faults.corrupt === sha) content = `X${content.slice(1)}`;
        const bytes = Buffer.from(content);
        yield { type: 'blob', sha, size: Buffer.byteLength(content) };
        for (let at = 0; at < bytes.length; at += 4) yield { type: 'data', buf: bytes.subarray(at, at + 4) };
        yield { type: 'end' };
      }
    },
  };
  return model;
}
