import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { AREAS_PATH, checkAreas, readAreas } from '../../src/mc/areas.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const AREA = { id: 'data', name: 'Data', covers: 'Schemas.', standards: ['docs/technical/data.md'], paths: ['src/db/'], questions: [{ when: 'A table changes.', ask: 'Is there a migration?' }] };
const FILE = { schema_version: 1, areas: [AREA, { ...AREA, id: 'ops-2', paths: [] }] };
const check = (value) => checkAreas(typeof value === 'string' ? value : JSON.stringify(value), 'x.json at main');
const withArea = (fields) => ({ ...FILE, areas: [{ ...AREA, ...fields }] });

test('checkAreas accepts a valid file, with an empty paths list, and returns its areas', () => {
  const r = check(FILE);
  assert.deepEqual([r.ok, r.declared, r.areas.map((a) => a.id)], [true, true, ['data', 'ops-2']]);
});

test('checkAreas names the field and where the file was read for each kind of invalid file', () => {
  const cases = [
    ['{ no', /^x\.json at main is not JSON/u],
    [[], /the file must be a JSON object/u],
    [{ ...FILE, schema_version: 2 }, /schema_version is 2; mc reads 1/u],
    [{ areas: FILE.areas }, /schema_version is missing/u],
    [{ ...FILE, extra: 1 }, /extra is an unknown key/u],
    [{ ...FILE, areas: [] }, /areas must be a non-empty array/u],
    [{ ...FILE, areas: 'x' }, /areas must be a non-empty array/u],
    [{ ...FILE, areas: [null] }, /areas\[0\] must be an object/u],
    [withArea({ id: 'Data' }), /areas\[0\]\.id must be lower-case/u],
    [withArea({ id: '1a' }), /areas\[0\]\.id must be lower-case/u],
    [withArea({ id: undefined }), /areas\[0\]\.id must be lower-case/u],
    [{ ...FILE, areas: [AREA, AREA] }, /areas\[1\]\.id data is given twice/u],
    [withArea({ name: ' ' }), /areas\[0\]\.name must be a non-blank text/u],
    [withArea({ covers: undefined }), /areas\[0\]\.covers must be a non-blank text/u],
    [withArea({ standards: [] }), /areas\[0\]\.standards must be a non-empty array/u],
    [withArea({ standards: [''] }), /areas\[0\]\.standards must be a non-empty array/u],
    [withArea({ paths: [' '] }), /areas\[0\]\.paths must be an array of non-blank/u],
    [withArea({ paths: undefined }), /areas\[0\]\.paths must be an array of non-blank/u],
    [withArea({ questions: [] }), /areas\[0\]\.questions must be a non-empty array/u],
    [withArea({ questions: [{ ask: 'a' }] }), /areas\[0\]\.questions\[0\]\.when must be a non-blank text/u],
    [withArea({ questions: [{ when: 'w', ask: '' }] }), /areas\[0\]\.questions\[0\]\.ask must be a non-blank text/u],
    [withArea({ questions: [{ when: 'w', ask: 'a', why: 'b' }] }), /areas\[0\]\.questions\[0\]\.why is an unknown key/u],
    [withArea({ owner: 'x' }), /areas\[0\]\.owner is an unknown key/u],
  ];
  for (const [value, reason] of cases) {
    const r = check(value);
    assert.equal(r.ok, false, JSON.stringify(value));
    assert.match(r.reason, reason, JSON.stringify(value));
    if (typeof value !== 'string') assert.match(r.reason, /^x\.json at main: /u);
  }
});

test('readAreas shows <at>:.mc/areas.json in the repository path through the given git, origin/main unless told', () => {
  const calls = [];
  const git = (cwd, args) => { calls.push({ cwd, args }); return { ok: true, stdout: JSON.stringify(FILE), stderr: '' }; };
  const r = readAreas('/repos/memoro-cli.git', { git, repo: 'memoro-cli' });
  assert.deepEqual([r.ok, r.declared, r.areas.length], [true, true, 2]);
  readAreas('/repos/memoro-cli.git', { git, at: 'goal/x' });
  assert.deepEqual(calls, [
    { cwd: '/repos/memoro-cli.git', args: ['show', 'origin/main:.mc/areas.json'] },
    { cwd: '/repos/memoro-cli.git', args: ['show', 'goal/x:.mc/areas.json'] },
  ]);
});

test('readAreas answers no declaration for empty output and for a path git says is not in the revision, and an error with git\'s words for any other failure', () => {
  const answer = (result) => readAreas('/r', { git: () => ({ stdout: '', stderr: '', ...result }) });
  for (const result of [{ ok: true }, { ok: true, stdout: '\n' }, { ok: false, stderr: "fatal: path '.mc/areas.json' does not exist in 'origin/main'\n" }, { ok: false, stderr: "fatal: path '.mc/areas.json' exists on disk, but not in 'origin/main'" }]) {
    assert.deepEqual(answer(result), { ok: true, declared: false, areas: [] }, JSON.stringify(result));
  }
  for (const stderr of ["fatal: invalid object name 'origin/main'.", 'fatal: not a git repository', '', 'fatal: bad revision']) {
    const r = answer({ ok: false, stderr });
    assert.equal(r.ok, false, stderr);
    assert.equal(r.declared, undefined);
    assert.match(r.reason, new RegExp(`could not read \\.mc/areas\\.json at origin/main in /r — ${stderr ? stderr.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&') : 'git failed'}`, 'u'));
  }
  assert.match(readAreas('/r', { git: () => ({ ok: true, stdout: '{', stderr: '' }), repo: 'memoro' }).reason, /^memoro's \.mc\/areas\.json at origin\/main is not JSON/u);
});

test('this repository\'s own .mc/areas.json validates, and every standard and path in it exists in the checkout', () => {
  const text = readFileSync(join(ROOT, AREAS_PATH), 'utf8');
  const r = checkAreas(text, AREAS_PATH);
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(r.areas.map((area) => area.id), ['reserved-acts', 'session-roles', 'command-contract', 'tests-gate', 'operations', 'documentation']);
  const missing = r.areas.flatMap((area) => [...area.standards, ...area.paths].filter((path) => !existsSync(join(ROOT, path))).map((path) => `${area.id}: ${path}`));
  assert.deepEqual(missing, []);
});
