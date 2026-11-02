/** Shared descriptions must not fork when a handler or the reference changes. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { VERB_MODULES } from '../../src/mc-verbs.js';
import { COMMAND_USAGE, commandReference, commandUsage } from '../../src/mc/command-help.js';
import { HELP_TEXT } from '../../src/mc/help-text.js';
import { parseRunArgs } from '../../src/mc/commands/run.js';

/** Expand the runner's finite synopsis grammar, never its descriptions. */
function runnerExamples(text) {
  const examples = [];
  for (const line of text.split('\n')) {
    const match = /^\s*(?:usage — )?mc run\b(.*)$/u.exec(line);
    if (!match) continue;
    const synopsis = match[1].trim().split(/ {2,}/u)[0]
      .replace('[same flags]', '[--once] [--no-merge] [--idle-sleep <seconds>] [--no-caffeinate]');
    let pending = [synopsis];
    // Values are substituted before [] so <n|none> remains one flag's value.
    for (const pattern of [/<([^>]+)>/u, /\[([^\[\]]+)\]/u]) {
      let remaining = true;
      while (remaining) {
        remaining = false;
        pending = pending.flatMap((candidate) => {
          const part = pattern.exec(candidate);
          if (!part) return [candidate];
          remaining = true;
          const values = pattern.source.startsWith('<')
            ? part[1].split('|').map((value) => ['n', 'seconds'].includes(value) ? '1' : value)
            : ['', part[1]];
          return values.map((value) => candidate.slice(0, part.index) + value + candidate.slice(part.index + part[0].length));
        });
      }
    }
    for (const example of pending) examples.push(example.trim() ? example.trim().split(/\s+/u) : []);
  }
  return examples;
}

function checkRunner(text) {
  const examples = runnerExamples(text);
  assert.ok(examples.length, 'no runner synopses found');
  for (const argv of examples) {
    assert.equal(parseRunArgs(argv).error, undefined, `not routed: mc run ${argv.join(' ')}`);
  }
  return examples;
}

describe('shared command help', () => {
  it('uses exactly the handler text once in IN FULL for each migrated verb', async () => {
    const reference = HELP_TEXT.split('\nIN FULL\n')[1];
    assert.deepEqual(Object.keys(COMMAND_USAGE).sort(), ['goal', 'helper', 'model', 'project', 'run', 'status', 'step']);
    for (const verb of Object.keys(COMMAND_USAGE)) {
      assert.ok(VERB_MODULES[verb], `${verb} is not routed`);
      const handler = await import(new URL(`../../src/${VERB_MODULES[verb]}`, import.meta.url));
      assert.equal(handler.usage(), commandUsage(verb), verb);
      const block = commandReference(verb);
      assert.equal(reference.split(block).length - 1, 1, `${verb}'s shared reference is absent or duplicated`);
      assert.equal(block.replace(/^  /u, 'usage — ') + '\n', handler.usage());
    }
  });

  it('rejects unknown shared entries instead of silently hiding missing documentation', () => {
    for (const verb of ['invented', 'toString', '__proto__']) assert.throws(() => commandUsage(verb), RangeError);
  });

  it('keeps top-level help dependent only on static help data', () => {
    const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
    const source = read('../../src/mc/help-text.js');
    assert.deepEqual([...source.matchAll(/^import .* from '(.*?)';$/gmu)].map((m) => m[1]), ['./command-help.js']);
    assert.doesNotMatch(read('../../src/mc/command-help.js'), /^(?:import|export .* from)\b|\bimport\(/mu);
  });

  it('routes every runner synopsis and flag through its real parser without help interception', () => {
    const examples = checkRunner(commandUsage('run'));
    assert.ok(examples.length >= 40, `only ${examples.length} examples expanded`);
    for (const example of [[], ['start', '--once'], ['stop', '--force'], ['lanes', '1', '--total', 'none'], ['--billing', 'codex', 'off']]) {
      assert.ok(examples.some((seen) => JSON.stringify(seen) === JSON.stringify(example)), `missed ${example.join(' ')}`);
    }
  });

  it('the runner audit catches invented subcommands, misplaced flags and retired flags', () => {
    for (const synopsis of ['mc run invented', 'mc run stop --once', 'mc run --rounds 2', 'mc run lanes --fictional 1']) {
      assert.throws(() => checkRunner(synopsis), /not routed/u, synopsis);
    }
  });
});
