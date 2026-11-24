/**
 * What a headless Claude launch relies on from the host, and how a session
 * the host refused reads.
 *
 * A runner session has nobody at a terminal to approve a tool. It runs only
 * when the user's `~/.claude/settings.json` allows Bash and reading — `"Read"`
 * unscoped, or `Read(...)` rules covering `~/mc/**` and `~/.claude/skills/**`
 * — and when every repository under `~/mc/repos` is trusted in
 * `~/.claude.json`: Claude walks from a worktree to its git root, the bare
 * repository, and ignores every allow rule in a folder it has not trusted
 * (2026-11-13: two goals' sessions ended this way, every tool call refused,
 * and each counted against its goal). `claudeHostMissing` reads both files
 * and names what is missing; the runner refuses the claude provider while it
 * names anything (mc-run.md, "Launch settings"). The settings are the user's
 * to change, at a terminal; mc only reads them.
 *
 * `hostRefusedStream` reads a finished claude stream: a session whose every
 * tool result is a permission refusal was refused by the host, whatever its
 * prompt asked.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { claudeConfigPath } from './claude-trust.js';
import { reposHome, workRoot } from './paths.js';

/** The user's Claude settings file: `CLAUDE_CONFIG_DIR/settings.json`, else `~/.claude/settings.json`. */
export function claudeSettingsPath(env = process.env, home = homedir()) {
  return join(env.CLAUDE_CONFIG_DIR || join(env.HOME || home, '.claude'), 'settings.json');
}

/** Claude's skills directory, which a session's role tells it to read. */
function skillsDir(env, home) {
  return join(env.CLAUDE_CONFIG_DIR || join(env.HOME || home, '.claude'), 'skills');
}

const UNSCOPED = (tool) => new Set([tool, `${tool}(*)`, `${tool}(**)`]);

/** The absolute directory a `Read(<spec>)` rule covers with all below it, or null for one this check does not read. */
function readRuleDir(rule, home) {
  const spec = /^Read\((.*)\)$/u.exec(rule)?.[1];
  if (!spec) return null;
  const tree = /^(.*?)\/\*\*$/u.exec(spec)?.[1];
  if (tree == null) return null;
  // `//<path>` is absolute (`//**` the whole disk), `~/<path>` the home's; a bare `/<path>` is relative to the settings file, and not read here.
  if (tree === '/') return '/';
  if (tree.startsWith('//')) return tree.slice(1);
  if (tree === '~') return home;
  if (tree.startsWith('~/')) return join(home, tree.slice(2));
  return null;
}

const covers = (base, dir) => base === '/' || dir === base || dir.startsWith(`${base}/`);

const tilde = (path, home) => (home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path);

function readJsonFile(read, path) {
  let text;
  try { text = read(path); } catch { text = null; }
  if (text == null) return { missing: true };
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? { value } : { bad: true };
  } catch { return { bad: true }; }
}

/**
 * What a headless Claude launch needs that the host does not give, as one
 * line (`~/.claude/settings.json does not allow Bash`), or null when nothing
 * is missing. `read(path)` returns a file's text or null; `list(dir)` its
 * entry names ([] when absent); `real(path)` the path Claude keys trust by.
 * Never throws.
 */
export function claudeHostMissing({ env = process.env, home = env.HOME || homedir(), read, list, real = (path) => path }) {
  const missing = [];
  const settingsPath = claudeSettingsPath(env, home);
  const settings = readJsonFile(read, settingsPath);
  const shown = tilde(settingsPath, home);
  if (!settings.value) missing.push(settings.missing ? `${shown} cannot be read` : `${shown} is not a JSON object`);
  else {
    const permissions = settings.value.permissions && typeof settings.value.permissions === 'object' ? settings.value.permissions : {};
    const rules = (key) => (Array.isArray(permissions[key]) ? permissions[key].filter((rule) => typeof rule === 'string') : []);
    const allow = rules('allow');
    const deny = rules('deny');
    const unscoped = (list, tool) => list.some((rule) => UNSCOPED(tool).has(rule));
    if (!unscoped(allow, 'Bash') || unscoped(deny, 'Bash')) missing.push(`${shown} does not allow Bash`);
    const needed = [workRoot(env), skillsDir(env, home)];
    const trees = allow.map((rule) => readRuleDir(rule, home)).filter(Boolean);
    const reads = !unscoped(deny, 'Read') && (unscoped(allow, 'Read') || needed.every((dir) => trees.some((base) => covers(base, dir))));
    if (!reads) missing.push(`${shown} does not allow reading ${needed.map((dir) => tilde(dir, home)).join(' and ')}`);
  }
  const configPath = claudeConfigPath(env, home);
  let repos = [];
  try { repos = (list(reposHome(env)) ?? []).filter((entry) => entry.endsWith('.git')).sort(); } catch { repos = []; }
  if (repos.length) {
    const config = readJsonFile(read, configPath);
    const untrusted = repos.map((entry) => join(reposHome(env), entry))
      .filter((path) => config.value?.projects?.[real(path)]?.hasTrustDialogAccepted !== true);
    for (const path of untrusted) missing.push(`${tilde(path, home)} is not trusted in ${tilde(configPath, home)}`);
  }
  return missing.length ? missing.join('; ') : null;
}

/** The words Claude answers a refused tool call with (2026-11-13 streams and `.json.err`). */
const REFUSAL = /requires approval|you haven't granted it yet|has not been trusted/u;

const resultText = (content) => (typeof content === 'string' ? content
  : Array.isArray(content) ? content.map((part) => (typeof part === 'string' ? part : part?.text ?? '')).join('\n') : '');

/**
 * Whether a claude stream's every tool result is a permission refusal: one
 * whose text is Claude's refusal, or whose call a `permission_denied` event or
 * the result's `permission_denials` names. A stream with no tool result is not
 * one: a session that called no tool was not refused anything.
 */
export function hostRefusedStream(stdout) {
  const denied = new Set();
  const results = [];
  for (const line of String(stdout || '').split('\n')) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event?.type === 'system' && event.subtype === 'permission_denied' && event.tool_use_id) denied.add(event.tool_use_id);
    if (event?.type === 'result' && Array.isArray(event.permission_denials)) {
      for (const denial of event.permission_denials) if (denial?.tool_use_id) denied.add(denial.tool_use_id);
    }
    if (event?.type === 'user' && Array.isArray(event.message?.content)) {
      for (const part of event.message.content) if (part?.type === 'tool_result') results.push(part);
    }
  }
  return results.length > 0 && results.every((part) => denied.has(part.tool_use_id) || (part.is_error === true && REFUSAL.test(resultText(part.content))));
}
