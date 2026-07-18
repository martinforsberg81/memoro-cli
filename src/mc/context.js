/**
 * Compact Memoro context for mc startup grounding.
 *
 * The server owns durable profile state. The CLI only fetches a small approved
 * projection and renders it into the launch bundle. Missing auth, missing API,
 * old servers, or network failures all degrade to null so a coding tool launch
 * is never blocked by context assembly.
 */

import { getSecret as defaultGetSecret } from '../lib/keychain.js';
import { memoroFetch as defaultMemoroFetch } from '../lib/api.js';
import { readConfig as defaultReadConfig, getApiUrl as defaultGetApiUrl } from '../lib/config.js';
import { ACCOUNTS } from '../commands/auth.js';
import { derivePublicRepoRef, deriveRepoName } from '../lib/git-context.js';

export const MC_CONTEXT_PATH = '/api/mc/context';

const DEFAULT_API_URL = 'https://meetmemoro.app';

export function buildMcContextQuery({
  repoId = null,
  repo = null,
  tool = null,
  codingSessionId = null,
  coding_session_id = null,
  sessionName = null,
  branch = null,
} = {}) {
  const params = new URLSearchParams();
  addParam(params, 'repo_id', repoId);
  addParam(params, 'repo', repo);
  addParam(params, 'tool', tool);
  addParam(params, 'coding_session_id', codingSessionId || coding_session_id);
  addParam(params, 'session_name', sessionName);
  addParam(params, 'branch', branch);
  return params.toString();
}

export function buildMcContextPath(input = {}) {
  const query = buildMcContextQuery(input);
  return query ? `${MC_CONTEXT_PATH}?${query}` : MC_CONTEXT_PATH;
}

export async function fetchMcContextData({
  repoContext = null,
  repoName = null,
  repoId = null,
  tool = null,
  codingSessionId = null,
  coding_session_id = null,
  sessionName = null,
  branch = null,
  argv = [],
  deps = {},
} = {}) {
  try {
    const token = await resolveToken(deps);
    if (!token) return null;

    const apiUrl = await resolveApiUrl(argv, deps);
    if (!apiUrl) return null;

    const repo = firstNonEmpty(
      deps.repo,
      derivePublicRepoRef(repoContext),
      repoName,
      repoContext ? deriveRepoName(repoContext) : null,
    );
    const path = buildMcContextPath({
      repoId: firstNonEmpty(repoId, repoContext?.repoId, repoContext?.repo_id),
      repo,
      tool,
      codingSessionId: codingSessionId || coding_session_id,
      sessionName,
      branch: firstNonEmpty(branch, repoContext?.branch),
    });
    const memoroFetch = deps.memoroFetch || defaultMemoroFetch;
    const res = await memoroFetch(apiUrl, path, { token });
    return isObj(res?.context) ? res.context : null;
  } catch {
    return null;
  }
}

export function renderMcContextMarkdown(context) {
  if (!isObj(context)) return null;
  const sections = [];

  const userProfile = renderUserProfile(context.user_profile);
  if (userProfile) sections.push(section('User Profile', userProfile));

  const codingProfile = renderCodingProfile(context.coding_profile);
  if (codingProfile) sections.push(section('Coding Profile', codingProfile));

  const repo = renderRepo(context.repo);
  if (repo) sections.push(section('Repo', repo));

  const session = renderSession(context.session);
  if (session) sections.push(section('Session', session));

  return sections.length ? sections.join('\n\n') : null;
}

function renderUserProfile(profile) {
  if (!isObj(profile)) return null;
  const lines = [];
  addLine(lines, 'Name', profile.display_name);
  addLine(lines, 'Locale', profile.locale);
  addLine(lines, 'Timezone', profile.timezone);
  return lines.length ? lines.join('\n') : null;
}

function renderCodingProfile(profile) {
  if (!isObj(profile)) return null;
  const markdown = nonEmpty(profile.markdown);
  const lines = [];
  if (Number.isInteger(profile.revision)) lines.push(`Approved revision: ${profile.revision}`);
  if (markdown) {
    if (lines.length) lines.push('');
    lines.push(markdown);
  }
  return lines.length ? lines.join('\n') : null;
}

function renderRepo(repo) {
  if (!isObj(repo)) return null;
  const lines = [];
  addLine(lines, 'Name', repo.name);
  addLine(lines, 'Tool', repo.tool);
  if (Array.isArray(repo.selected_docs) && repo.selected_docs.length) {
    lines.push(`- Selected docs: ${repo.selected_docs.map((d) => `\`${String(d)}\``).join(', ')}`);
  }
  return lines.length ? lines.join('\n') : null;
}

function renderSession(session) {
  if (!isObj(session)) return null;
  const lines = [];
  addLine(lines, 'Coding session', session.coding_session_id, { code: true });
  addLine(lines, 'Name', session.mc_session_name);
  addLine(lines, 'Branch', session.branch);
  return lines.length ? lines.join('\n') : null;
}

async function resolveToken(deps) {
  if (deps.token) return deps.token;
  const getSecret = deps.getSecret || defaultGetSecret;
  try {
    return await getSecret(ACCOUNTS.TOKEN);
  } catch {
    return null;
  }
}

async function resolveApiUrl(argv, deps) {
  if (deps.apiUrl) return deps.apiUrl;
  const getApiUrl = deps.getApiUrl || defaultGetApiUrl;
  const override = getApiUrl(argv);
  if (override) return override;
  const readConfig = deps.readConfig || defaultReadConfig;
  try {
    const config = await readConfig();
    return config.apiUrl || DEFAULT_API_URL;
  } catch {
    return DEFAULT_API_URL;
  }
}

function addParam(params, key, value) {
  const text = nonEmpty(value);
  if (text) params.set(key, text);
}

function addLine(lines, label, value, { code = false } = {}) {
  const text = nonEmpty(value);
  if (!text) return;
  lines.push(`- ${label}: ${code ? `\`${text}\`` : text}`);
}

function section(title, content) {
  return `### ${title}\n\n${content.trim()}`;
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = nonEmpty(value);
    if (text) return text;
  }
  return null;
}

function nonEmpty(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text ? text : null;
}

function isObj(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}
