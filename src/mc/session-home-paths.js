import { join } from 'node:path';

import { mcHome } from './paths.js';
import { normalizedPrivateRoot } from './private-state.js';
import {
  assertMcSessionId,
  normalizeSessionName,
  sessionNameDigest,
} from './session-home-schema.js';

export function sessionHomePaths({
  mcHomeDir = mcHome(),
  mcSessionId = null,
  normalizedName = null,
} = {}) {
  const root = normalizedPrivateRoot(mcHomeDir);
  const sessionsRoot = join(root, 'sessions');
  const namesRoot = join(root, 'session-names');
  const runRoot = join(root, 'run');
  const paths = {
    mcHomeDir: root,
    sessionsRoot,
    namesRoot,
    runRoot,
    locksRoot: join(runRoot, 'locks'),
  };
  if (mcSessionId !== null) {
    assertMcSessionId(mcSessionId);
    const home = join(sessionsRoot, mcSessionId);
    Object.assign(paths, {
      home,
      identityPath: join(home, 'identity.json'),
      metadataPath: join(home, 'metadata.json'),
      projectionPath: join(home, 'projection.json'),
      mutationLockPath: join(runRoot, 'locks', 'sessions', mcSessionId),
      ephemeralRunPath: join(runRoot, 'sessions', mcSessionId),
      workspacesPath: join(home, 'workspaces'),
      conversationsPath: join(home, 'conversations'),
      generationsPath: join(home, 'generations'),
      resourcesPath: join(home, 'resources'),
    });
  }
  if (normalizedName !== null) {
    const normalized = normalizeSessionName(normalizedName);
    const digest = sessionNameDigest(normalized);
    Object.assign(paths, {
      normalizedName: normalized,
      nameDigest: digest,
      nameClaimPath: join(namesRoot, `${digest}.json`),
      nameLockPath: join(runRoot, 'locks', 'names', digest),
    });
  }
  return paths;
}
