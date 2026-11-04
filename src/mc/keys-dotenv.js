import { readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

const RESERVED = /^(?:NODE_|DYLD_|LD_|MC_|GIT_|NPM_|npm_)/u;
const CONTROL = new Set(['PATH', 'HOME', 'SHELL', 'ENV', 'BASH_ENV', 'TMPDIR', 'PWD', 'USER', 'LOGNAME']);

export class KeysDotenvError extends Error {}

export function keysDotenvPath({ env = process.env, home = process.env.HOME, cwd = process.cwd() } = {}) {
  if (env.MC_KEYS_FILE) return isAbsolute(env.MC_KEYS_FILE) ? env.MC_KEYS_FILE : resolve(cwd, env.MC_KEYS_FILE);
  if (!home) throw new KeysDotenvError('cannot resolve shared dotenv source from host HOME');
  return join(home, 'mc', 'self', 'memoro', '.dev.vars');
}

/** Read a dotenv file as data. This intentionally never evaluates shell syntax. */
export function readKeysDotenv({ env = process.env, home = process.env.HOME, cwd = process.cwd() } = {}) {
  const path = keysDotenvPath({ env, home, cwd });
  let content;
  try { content = readFileSync(path, 'utf8'); }
  catch { throw new KeysDotenvError('shared dotenv source is missing or unreadable'); }
  return { path, values: parseKeysDotenv(content) };
}

export function parseKeysDotenv(content) {
  const values = Object.create(null);
  const lines = String(content).replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n').split('\n');
  for (let index = 0; index < lines.length; index++) {
    const original = lines[index];
    let line = original.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export') && /^export\s+/u.test(line)) line = line.replace(/^export\s+/u, '');
    const assignment = /^([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/u.exec(line);
    if (!assignment) throw invalid(index + 1);
    const [, name, raw] = assignment;
    if (!/^[A-Z_][A-Z0-9_]{0,127}$/u.test(name) || RESERVED.test(name) || CONTROL.has(name)) {
      throw new KeysDotenvError(`shared dotenv contains a reserved or invalid name on line ${index + 1}`);
    }
    if (Object.hasOwn(values, name)) throw new KeysDotenvError(`shared dotenv contains a duplicate name on line ${index + 1}`);
    values[name] = parseValue(raw, index + 1);
  }
  return values;
}

function invalid(line) { return new KeysDotenvError(`shared dotenv contains a malformed assignment on line ${line}`); }

function parseValue(raw, line) {
  const value = raw.trimStart();
  if (!value) return '';
  const quote = value[0];
  if (quote !== '"' && quote !== "'") return stripComment(value).trimEnd();
  let result = '';
  let escaped = false;
  let close = -1;
  for (let i = 1; i < value.length; i++) {
    const char = value[i];
    if (escaped) {
      if (quote === '"') result += ({ n: '\n', r: '\r', t: '\t' })[char] ?? char;
      else result += char;
      escaped = false;
    } else if (char === '\\') escaped = true;
    else if (char === quote) { close = i; break; }
    else result += char;
  }
  if (escaped || close < 0 || !/^(?:\s*(?:#.*)?)?$/u.test(value.slice(close + 1))) throw invalid(line);
  return result;
}

function stripComment(value) {
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '#' && (i === 0 || /\s/u.test(value[i - 1]))) return value.slice(0, i);
  }
  return value;
}
