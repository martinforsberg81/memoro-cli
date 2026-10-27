/**
 * `mc model` — the model catalog (ruling 59, `src/mc/model-config.js`).
 *
 * It says which models a fast or a large step may run on, in order, and which
 * one review uses. It says nothing about capacity: that is the routing's, and
 * this verb does not poll anything.
 *
 *   mc model [list] [--json]                       the catalog, and whether it is the file's or the defaults
 *   mc model add fast|large <tool>:<model>:<effort>      append a candidate to a class
 *   mc model remove fast|large <tool>:<model>             remove the candidate with exactly that tool and model
 *   mc model set review <tool>:<model>:<effort>           replace the review candidate
 *
 * A catalog mc cannot read is an error with its path and what to do about it,
 * never a silent return to the defaults.
 */
import {
  CLASSES, ModelConfigError, addCandidate, candidateSpec, changeModels, parseCandidate, parseTarget,
  readModels, removeCandidate, setReview,
} from '../model-config.js';
import { scanArgs } from './flags.js';

export function usage() {
  return [
    'usage — mc model [list] [--json]\n',
    '        mc model add fast|large <tool>:<model>:<effort>\n',
    '        mc model remove fast|large <tool>:<model>\n',
    '        mc model set review <tool>:<model>:<effort>\n',
  ].join('');
}

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const env = deps.env || process.env;
  const { flags, positional, error } = scanArgs(argv, { booleans: ['--json'] });
  if (error) return usageError(stderr, error);
  const [verb = 'list', ...rest] = positional;

  try {
    if (verb === 'list') {
      if (rest.length) return usageError(stderr, `unexpected arg: ${rest[0]}`);
      const models = readModels(env);
      if (flags.json) stdout.write(`${JSON.stringify({ ok: true, ...models }, null, 2)}\n`);
      else stdout.write(listText(models));
      return 0;
    }

    if (flags.json) return usageError(stderr, '--json is for mc model list');

    if (verb === 'add') {
      if (rest.length !== 2) return usageError(stderr, 'mc model add fast|large <tool>:<model>:<effort>');
      const [cls, spec] = rest;
      if (!CLASSES.includes(cls)) return usageError(stderr, `"${cls}" is not a class: add takes fast or large`);
      const value = parseCandidate(spec);
      const models = changeModels(env, (catalog) => addCandidate(catalog, cls, value));
      stdout.write(`mc: added ${candidateSpec(value)} to ${cls} — ${cls} is now ${summary(models[cls])}\n`);
      return 0;
    }

    if (verb === 'remove') {
      if (rest.length !== 2) return usageError(stderr, 'mc model remove fast|large <tool>:<model>');
      const [cls, target] = rest;
      if (!CLASSES.includes(cls)) return usageError(stderr, `"${cls}" is not a class: remove takes fast or large`);
      const value = parseTarget(target);
      const models = changeModels(env, (catalog) => removeCandidate(catalog, cls, value));
      stdout.write(`mc: removed ${value.tool}:${value.model} from ${cls} — ${cls} is now ${summary(models[cls])}\n`);
      return 0;
    }

    if (verb === 'set') {
      if (rest.length !== 2 || rest[0] !== 'review') return usageError(stderr, 'mc model set review <tool>:<model>:<effort>');
      const value = parseCandidate(rest[1]);
      changeModels(env, (catalog) => setReview(catalog, value));
      stdout.write(`mc: review is now ${candidateSpec(value)}\n`);
      return 0;
    }
  } catch (caught) {
    if (caught instanceof ModelConfigError) {
      stderr.write(`mc: ${caught.message}\n`);
      return 1;
    }
    throw caught;
  }

  return usageError(stderr, `unknown model command "${verb}"`);
}

function usageError(stderr, message) {
  stderr.write(`mc: ${message}\n`);
  stderr.write(usage());
  return 2;
}

function summary(list) {
  return list.map(candidateSpec).join(', ');
}

function listText(models) {
  const head = models.source === 'config'
    ? `${models.path}  (config)`
    : `${models.path}  (defaults — no file there yet)`;
  const lines = [head];
  for (const cls of CLASSES) {
    lines.push(cls);
    models[cls].forEach((value, index) => lines.push(`  ${index + 1}  ${candidateSpec(value)}`));
  }
  lines.push('review', `  ${candidateSpec(models.review)}`);
  return `${lines.join('\n')}\n`;
}
