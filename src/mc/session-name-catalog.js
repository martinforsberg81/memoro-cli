import { readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import {
  fsyncDirectorySync,
  inspectPrivateDirectoryChainSync,
  readPrivateJsonSync,
} from './private-state.js';
import { sessionHomePaths } from './session-home-paths.js';
import {
  sessionNameDigest,
  unknown,
  validateSessionNameClaim,
} from './session-home-schema.js';

export function readNameClaimSync({ mcHomeDir, normalizedName }) {
  let paths;
  try {
    paths = sessionHomePaths({ mcHomeDir, normalizedName });
  } catch {
    return unknown('invalid-name-claim-path');
  }
  return readPrivateJsonSync({
    path: paths.nameClaimPath,
    trustedRoot: paths.mcHomeDir,
    validate: validateSessionNameClaim,
  });
}

export function classifyNameClaim(claim, metadata) {
  if (claim.kind !== 'present') {
    return { state: claim.kind === 'absent' ? 'unclaimed' : 'unsafe', reason: claim.reason || claim.kind };
  }
  const value = claim.value;
  if (value.mc_session_id !== metadata.mc_session_id
    || value.name !== metadata.name
    || value.normalized_name !== metadata.normalized_name
    || value.name_revision !== metadata.name_revision) {
    return { state: 'mismatch', reason: 'name-claim-mismatch' };
  }
  return { state: 'ready' };
}

export function listNameClaimsSync(mcHomeDir) {
  let paths;
  try { paths = sessionHomePaths({ mcHomeDir }); } catch {
    return { claims: [], issues: [{ scope: 'name-catalog', reason: 'invalid-private-root' }] };
  }
  const safety = inspectPrivateDirectoryChainSync({
    trustedRoot: paths.mcHomeDir,
    directory: paths.namesRoot,
  });
  if (!safety.ok) {
    return safety.missing
      ? { claims: [], issues: [] }
      : { claims: [], issues: [{ scope: 'name-catalog', reason: safety.reason }] };
  }
  const claims = [];
  const issues = [];
  let names;
  try { names = readdirSync(paths.namesRoot).sort(); } catch {
    return { claims, issues: [{ scope: 'name-catalog', reason: 'unreadable-name-catalog' }] };
  }
  for (const name of names) {
    if (!/^[a-f0-9]{64}\.json$/u.test(name)) {
      issues.push({ scope: 'name-claim', entry: name, reason: 'unexpected-name-claim' });
      continue;
    }
    const path = join(paths.namesRoot, name);
    const read = readPrivateJsonSync({
      path,
      trustedRoot: paths.mcHomeDir,
      validate: validateSessionNameClaim,
    });
    if (read.kind !== 'present') {
      issues.push({ scope: 'name-claim', entry: name, reason: read.reason || read.kind });
      continue;
    }
    if (`${sessionNameDigest(read.value.normalized_name)}.json` !== name) {
      issues.push({ scope: 'name-claim', entry: name, reason: 'name-claim-path-mismatch' });
      continue;
    }
    claims.push({ path, value: read.value });
  }
  return { claims, issues };
}

export function removeNameClaimIfOwned(paths, mcSessionId, nameRevision) {
  const current = readNameClaimSync({
    mcHomeDir: paths.mcHomeDir,
    normalizedName: paths.normalizedName,
  });
  if (current.kind !== 'present'
    || current.value.mc_session_id !== mcSessionId
    || current.value.name_revision !== nameRevision) return false;
  try {
    unlinkSync(paths.nameClaimPath);
    fsyncDirectorySync(paths.namesRoot);
    return true;
  } catch {
    return false;
  }
}
