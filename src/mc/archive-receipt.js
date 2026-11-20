/** Evidence carried by the fenced local programme move, not by the repository PR. */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { archivedProgramsHome } from './paths.js';

const FILE = '.archive-receipt.json';
const SCHEMA = 'mc-programme-archive-receipt';
const oid = (value) => typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value);

function treeAt(git, repo, commit, path) {
  const row = git(repo.path, ['ls-tree', '-d', '--full-tree', commit, '--', path]);
  const [entry, name] = row?.split('\t') ?? [];
  const tree = entry?.match(/^040000 tree ([0-9a-f]+)$/u)?.[1];
  return name === path && oid(tree) ? tree : null;
}

/** Inspect the pinned main revisions from the repository step. */
export function writeArchiveReceipt(dir, programme, inspections, git) {
  const path = `docs/project/${programme}`;
  const entries = [];
  for (const repo of inspections) {
    const { commit } = repo;
    if (!oid(commit)) continue;
    const tree = treeAt(git, repo, commit, path);
    const identity = git(repo.path, ['remote', 'get-url', 'origin']);
    if (tree && identity) entries.push({ repository: repo.name, identity, path, commit, tree });
  }
  writeFileSync(join(dir, FILE), `${JSON.stringify({ schema: SCHEMA, version: 1, programme, entries }, null, 2)}\n`);
}

/** A shelf proves only this exact repository tree, with a directory throughout its ancestry. */
export function shelvedMembership(programme, repo, { env, git }) {
  let names;
  try { names = readdirSync(archivedProgramsHome(env)); } catch { return false; }
  const path = `docs/project/${programme}`;
  for (const name of names) {
    let receipt;
    try { receipt = JSON.parse(readFileSync(join(archivedProgramsHome(env), name, FILE), 'utf8')); } catch { continue; }
    if (receipt?.schema !== SCHEMA || receipt.version !== 1 || receipt.programme !== programme || !Array.isArray(receipt.entries)) continue;
    const identity = git(repo.path, ['remote', 'get-url', 'origin']);
    for (const entry of receipt.entries) {
      if (!entry || entry.repository !== repo.name || !identity || entry.identity !== identity || entry.path !== path || !oid(entry.commit) || !oid(entry.tree)) continue;
      const main = git(repo.path, ['rev-parse', 'origin/main']);
      if (!oid(main) || git(repo.path, ['merge-base', '--is-ancestor', entry.commit, main]) === null) continue;
      if (treeAt(git, repo, entry.commit, path) !== entry.tree || treeAt(git, repo, main, path) !== entry.tree) continue;
      const history = git(repo.path, ['rev-list', '--ancestry-path', `${entry.commit}..${main}`]);
      if (history === null) continue;
      const commits = history ? history.split('\n') : [];
      if (commits.every((commit) => oid(commit) && treeAt(git, repo, commit, path))) return true;
    }
  }
  return false;
}
