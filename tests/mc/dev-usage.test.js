/**
 * `mc dev`'s usage, and the reason it went stale.
 *
 * It listed seven of the nine verbs — `register` and `unregister` were accepted
 * and invisible — and said nothing about selectors or which flag belongs to
 * which verb, all of which the parser enforces.
 *
 * It went stale because nobody could see it. The line sat after the verb
 * dispatch, and every verb returns from its own branch, so the only way to
 * reach it was a verb the parser had already rejected. A usage nobody can
 * reach is a usage nobody corrects.
 *
 * So it is printed where somebody is actually stuck — on a parse error — and
 * what it claims is checked against the parser rather than against memory.
 */
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { run } from '../../src/cli/dev.js';

const VERBS = ['plan', 'ensure', 'list', 'status', 'logs', 'stop', 'restart', 'register', 'unregister'];

/** Run the command and collect what each stream got. */
async function dev(argv) {
  let stdout = '';
  let stderr = '';
  const code = await run(argv, {
    stdout: { write: (text) => { stdout += text; } },
    stderr: { write: (text) => { stderr += text; } },
  });
  return { code, stdout, stderr };
}

describe('mc dev tells you what it takes', () => {
  it('prints its usage when the verb is missing', async () => {
    const { code, stderr } = await dev([]);
    assert.equal(code, 2);
    assert.match(stderr, /usage — mc dev <verb>/u);
  });

  it('prints it for an unknown verb too', async () => {
    const { stderr } = await dev(['frobnicate']);
    assert.match(stderr, /usage — mc dev <verb>/u);
  });

  it('lists every verb the parser accepts — including the two it used to hide', async () => {
    const { stderr } = await dev([]);
    for (const verb of VERBS) {
      assert.match(stderr, new RegExp(`^\\s{2}${verb}\\b`, 'mu'), `${verb} is accepted but not listed`);
    }
  });

  it('claims no verb the parser would reject', async () => {
    const { stderr } = await dev([]);
    const listed = [...stderr.matchAll(/^ {2}([a-z]+)[ []/gmu)].map((match) => match[1]);
    assert.ok(listed.length >= VERBS.length, `only found ${listed.length} listed verbs`);
    for (const verb of new Set(listed)) {
      assert.ok(VERBS.includes(verb), `usage offers "${verb}", which the parser does not accept`);
    }
  });

  it('says which verbs need a selector, and the parser agrees', async () => {
    const { stderr } = await dev([]);
    assert.match(stderr, /selector is required by every verb except list, plan and ensure/u);
    // Checked against the parser rather than trusted: the three named ones get
    // past argument parsing without a selector, and the rest are refused.
    for (const verb of VERBS) {
      const refused = (await dev([verb])).stderr.includes('requires a selector');
      const exempt = ['list', 'plan', 'ensure'].includes(verb);
      assert.equal(refused, !exempt, `${verb} disagrees with what the usage says about selectors`);
    }
  });

  it('names each flag against the verb that owns it', async () => {
    const { stderr } = await dev([]);
    assert.match(stderr, /logs <selector> \[--lines N\]/u);
    assert.match(stderr, /--profile <name>/u);
    assert.match(stderr, /--restart/u);
    // And those restrictions are real, not decoration.
    assert.match((await dev(['list', '--lines', '5'])).stderr, /--lines is only valid with mc dev logs/u);
    assert.match((await dev(['list', '--profile', 'x'])).stderr, /--profile is only valid/u);
    assert.match((await dev(['list', '--restart'])).stderr, /--restart is only valid with mc dev ensure/u);
  });
});

describe('the usage cannot drift out of reach again', () => {
  it('is printed from the parse-error path, not after the dispatch', () => {
    // The shape that made it invisible: a message after a dispatch every branch
    // returns from. If it moves back there, this fails.
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, '..', '..', 'src', 'cli', 'dev.js'), 'utf8');
    const beforeDispatch = source.slice(0, source.indexOf('try {'));
    assert.match(beforeDispatch, /stderr\.write\(usage\(\)\)/u, 'the usage is no longer printed where a user can reach it');
  });

  it('mc dev appears in the top-level help', () => {
    // It was absent entirely, so `mc --help` gave no hint the family existed.
    const here = dirname(fileURLToPath(import.meta.url));
    const help = readFileSync(join(here, '..', '..', 'src', 'mc', 'help-text.js'), 'utf8');
    assert.match(help, /mc dev list/u);
  });
});
