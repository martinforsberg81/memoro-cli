/** Evidence carried by the fenced local programme move, not by the repository PR. */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { archivedProgramsHome } from './paths.js';

const FILE = '.archive-receipt.json';
const SCHEMA = 'mc-programme-archive-receipt';
const oid = (value) => /^[0-9a-f]{40,64}$/u.test(value || '');

/** Inspect origin/main after the repository step; failures simply leave no proof. */
export function writeArchiveReceipt(dir, programme, repos, git) {
  const path = `docs/project/${programme}`;
  const entries = [];
  for (const repo of repos) {
    const commit = git(repo.path, ['rev-parse', 'origin/main']);
    const tree = git(repo.path, ['rev-parse', `origin/main:${path}`]);
    const identity = git(repo.path, ['remote', 'get-url', 'origin']);
    if (oid(commit) && oid(tree) && identity) entries.push({ repository: repo.name, identity, path, commit, tree });
  }
  writeFileSync(join(dir, FILE), `${JSON.stringify({ schema: SCHEMA, version: 1, programme, entries }, null, 2)}\n`);
}

/** A shelf proves only this exact repository tree, with no intervening deletion. */
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
      if (git(repo.path, ['rev-parse', `${entry.commit}:${path}`]) !== entry.tree || git(repo.path, ['rev-parse', `${main}:${path}`]) !== entry.tree) continue;
      const history = git(repo.path, ['rev-list', '--ancestry-path', `${entry.commit}..${main}`]);
      if (history === null) continue;
      const commits = history ? history.split('\n') : [];
      if (commits.every((commit) => oid(git(repo.path, ['rev-parse', `${commit}:${path}`])))) return true;
    }
  }
  return false;
}
