/**
 * The manifest reader: only the fields mc uses, and another schema or
 * version is unreadable by name rather than run.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { closingManifests, CUTOVER_DIR, readManifest, readManifests } from '../../src/mc/language-manifest.js';
import { manifest } from './_helpers/language-manifest.js';

describe('readManifest', () => {
  it('reads a manifest of the shape mc uses', () => {
    const read = readManifest(JSON.stringify(manifest()));
    assert.equal(read.ok, true);
    assert.equal(read.manifest.name, 'sv-forms-cutover');
    assert.equal(read.manifest.acts[1].execute, null);
  });

  it('lists another schema or version as unreadable, by name', () => {
    const schema = readManifest(JSON.stringify(manifest({ schema: 'something-else' })));
    assert.equal(schema.ok, false);
    assert.equal(schema.name, 'sv-forms-cutover');
    assert.match(schema.problems[0], /schema/u);
    const version = readManifest(JSON.stringify(manifest({ version: 2 })));
    assert.equal(version.ok, false);
    assert.match(version.problems[0], /version is 2/u);
  });

  it('refuses an act whose shape mc would misread', () => {
    const bad = manifest();
    bad.acts[0].check = 'node ingest.js';
    bad.acts[0].expect.check = [{ path: 'x', exact: 1, advisory: 'both' }];
    delete bad.acts[0].if_not;
    const read = readManifest(JSON.stringify(bad));
    assert.equal(read.ok, false);
    assert.ok(read.problems.some((p) => /check must be an argument array/u.test(p)));
    assert.ok(read.problems.some((p) => /not both/u.test(p)));
    assert.ok(read.problems.some((p) => /no if_not/u.test(p)));
  });

  it('names text that is not JSON after its file', () => {
    const read = readManifest('{', { file: 'broken.json' });
    assert.equal(read.ok, false);
    assert.equal(read.name, 'broken');
  });
});

describe('readManifests', () => {
  it('reads every manifest in the worktree, and none when the directory is not there', () => {
    const worktree = mkdtempSync(join(tmpdir(), 'mc-manifests-'));
    assert.deepEqual(readManifests(worktree), { manifests: [], unreadable: [] });
    mkdirSync(join(worktree, CUTOVER_DIR), { recursive: true });
    writeFileSync(join(worktree, CUTOVER_DIR, 'sv-forms-cutover.json'), JSON.stringify(manifest()));
    writeFileSync(join(worktree, CUTOVER_DIR, 'old.json'), JSON.stringify(manifest({ name: 'old', version: 0 })));
    writeFileSync(join(worktree, CUTOVER_DIR, 'README.md'), 'not a manifest');
    const { manifests, unreadable } = readManifests(worktree);
    assert.deepEqual(manifests.map((m) => m.name), ['sv-forms-cutover']);
    assert.deepEqual(unreadable.map((u) => u.name), ['old']);
  });
});

describe('closingManifests', () => {
  it('names the manifests of that language whose closes contains the use', () => {
    const all = [manifest(), manifest({ name: 'fr-forms', lang: 'fr' }), manifest({ name: 'sv-lemmas', closes: ['language_lemma'] })];
    assert.deepEqual(closingManifests(all, 'sv', 'language_form'), ['sv-forms-cutover']);
    assert.deepEqual(closingManifests(all, 'sv', 'language_lemma'), ['sv-lemmas']);
    assert.deepEqual(closingManifests(all, 'da', 'language_form'), []);
  });
});
