/**
 * `GET /api/version` — what production says it is, cached where the page can
 * read it.
 *
 * The route is public, uncached and tiny: `{ commit, build, build_time }`. Two
 * things ask it and they ask it for different reasons. `mc deploy` asks *now*,
 * because a person is about to ship and the answer is half of what they are
 * deciding on (`commands/deploy.js`). The page must not ask at all — it is
 * offline and instant (`docs/technical/mc-ui.md` § *Why it is instant*) — so it
 * reads the answer the helper's last collect left here, and says how old it is.
 *
 * That is the whole of this file: one path, one write, one read. It sits beside
 * `plans.json` and `prs.json` under `~/mc/runner/` because it is the same kind
 * of thing — a read-through cache of something the page would otherwise have to
 * go and fetch, safe to delete, refilled by the next `mc helper --collect`.
 *
 * What it is *not* is the record of what mc deployed. That is `deploys.tsv`
 * (`deploys.js`), written by the verb around the deploy itself. The two are
 * deliberately separate readings and the page draws the difference between
 * them: the row says what mc shipped, this says what is answering requests, and
 * a deploy somebody made another way is exactly the case where they differ.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { writeJsonAtomic } from './atomic-write.js';
import { workRoot } from './paths.js';

export const VERSION_FILE = 'version.json';

export function liveVersionPath(env = process.env) {
  return join(workRoot(env), 'runner', VERSION_FILE);
}

const short = (sha) => (sha ? String(sha).slice(0, 7) : null);

/**
 * Keep what the route answered, stamped with when it was asked.
 *
 * A cache that cannot be written is not an error the collect run reports: the
 * digest it was gathering is worth more than the page's convenience, and the
 * page already says "no live version" for a file that is not there.
 */
export function writeLiveVersion(version, { env = process.env, now = new Date() } = {}) {
  const entry = {
    fetched: now.toISOString(),
    version: {
      commit: version?.commit || null,
      build: version?.build ?? null,
      build_time: version?.build_time || null,
    },
  };
  try { writeJsonAtomic(liveVersionPath(env), entry); } catch { /* see above */ }
  return entry;
}

/**
 * What the helper last heard from `/api/version`, with its age — or null when
 * nothing has ever asked, which is the state on a machine where
 * `mc helper --collect` has not run.
 */
export function readLiveVersion(env = process.env, now = new Date()) {
  let raw = null;
  try { raw = JSON.parse(readFileSync(liveVersionPath(env), 'utf8')); } catch { return null; }
  const commit = raw?.version?.commit || null;
  if (!commit) return null;
  const at = Date.parse(raw.fetched);
  return {
    commit,
    short: short(commit),
    build: raw.version.build ?? null,
    build_time: raw.version.build_time || null,
    fetched: raw.fetched || null,
    age_seconds: Number.isNaN(at) ? null : Math.max(0, Math.round((now.getTime() - at) / 1000)),
  };
}
