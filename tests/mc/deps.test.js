/**
 * `mc deps` — the reading of a repository's lockfile on `origin/main`.
 *
 * Every outside call is injected: git hands back fixture files, npm hands
 * back canned `npm view` and `npm audit` output, so nothing here reaches the
 * registry. The fixture is small on purpose — one exact pin, one caret range
 * on a 0.x, one devDependency, and the transitive package an audit reaches
 * through the tool.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  compareVersions, formatReading, loadSaved, readDeps, savedPath,
} from '../../src/mc/deps.js';
import { run } from '../../src/mc/commands/deps.js';

const MANIFEST = {
  name: 'fixture',
  dependencies: { pinned: '1.2.3', tiny: '^0.20.2' },
  devDependencies: { builder: '^4.1.0' },
};

const LOCK = {
  name: 'fixture',
  lockfileVersion: 3,
  packages: {
    '': { name: 'fixture', dependencies: MANIFEST.dependencies, devDependencies: MANIFEST.devDependencies },
    'node_modules/pinned': { version: '1.2.3' },
    'node_modules/tiny': { version: '0.20.2' },
    'node_modules/builder': { version: '4.1.0', dev: true },
    'node_modules/inner': { version: '2.0.0', dev: true },
  },
};

const AUDIT = {
  vulnerabilities: {
    pinned: { name: 'pinned', severity: 'critical', isDirect: true, effects: [], fixAvailable: true },
    builder: {
      name: 'builder', severity: 'high', isDirect: true, effects: [],
      fixAvailable: { name: 'builder', version: '4.9.0', isSemVerMajor: false },
    },
    inner: {
      name: 'inner', severity: 'high', isDirect: false, effects: ['builder'],
      fixAvailable: { name: 'builder', version: '4.9.0', isSemVerMajor: false },
    },
    deep: { name: 'deep', severity: 'moderate', isDirect: false, effects: ['inner', 'deep'], fixAvailable: true },
  },
  metadata: { vulnerabilities: { info: 0, low: 0, moderate: 1, high: 2, critical: 1, total: 4 } },
};

const VIEWS = {
  'pinned@^1.2.3': ['1.2.3', '1.4.0'],
  pinned: '1.4.0',
  'tiny@^0.20.2': ['0.20.2', '0.20.5'],
  tiny: '0.28.2',
  'builder@^4.1.0': '4.12.0',
  builder: '4.12.0',
};

let root;
let env;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mc-deps-'));
  env = { MC_WORK_ROOT: join(root, 'work') };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function fakeGit({ fetchFails = false, sha = 'abc1234def' } = {}) {
  const calls = [];
  const git = async (args) => {
    calls.push(args);
    if (args[0] === 'fetch') return { status: fetchFails ? 128 : 0, stdout: '', stderr: fetchFails ? 'offline' : '' };
    if (args[0] === 'rev-parse') return { status: 0, stdout: `${sha}\n`, stderr: '' };
    if (args[0] === 'cat-file') return { status: 0, stdout: '', stderr: '' };
    if (args[1] === 'origin/main:package.json') return { status: 0, stdout: JSON.stringify(MANIFEST), stderr: '' };
    if (args[1] === 'origin/main:package-lock.json') return { status: 0, stdout: JSON.stringify(LOCK), stderr: '' };
    if (args[1] === 'origin/main:check.mjs') return { status: 0, stdout: '// the script on origin/main\n', stderr: '' };
    return { status: 1, stdout: '', stderr: 'unexpected' };
  };
  return { git, calls };
}

function fakeNpm({ auditStdout = JSON.stringify(AUDIT), failView = null } = {}) {
  const calls = [];
  const npm = async (args, { cwd } = {}) => {
    calls.push({ args, cwd });
    if (args[0] === 'audit') {
      assert.ok(existsSync(join(cwd, 'package-lock.json')), 'audit ran without the lockfile beside it');
      return { status: 1, stdout: auditStdout, stderr: '' };
    }
    const name = args[1];
    if (failView && name.startsWith(failView)) return { status: 1, stdout: '', stderr: 'npm ERR! 404 Not Found' };
    const answer = VIEWS[name];
    if (answer === undefined) return { status: 1, stdout: '', stderr: 'no such fixture' };
    return { status: 0, stdout: args.includes('--json') ? JSON.stringify(answer) : `${answer}\n`, stderr: '' };
  };
  return { npm, calls };
}

const declaration = () => ({
  ok: true,
  declaration: { deps_notes: [{ name: 'builder', argv: ['node', 'check.mjs', '--summary'] }] },
});
const runNote = async () => ({ status: 0, stdout: '\nbuilder 4.1.0 → 4.12.0 (11 minor behind)\nmore\n', stderr: '' });

function read(extra = {}) {
  const { git } = fakeGit(extra.gitOptions);
  const { npm } = fakeNpm(extra.npmOptions);
  return readDeps({
    repoPath: join(root, 'fixture'), refresh: true, env, root, git, npm, runNote, declaration,
    now: () => new Date('2026-10-09T10:00:00Z'), ...extra.overrides,
  });
}

describe('compareVersions', () => {
  it('compares numerically, not as text', () => {
    assert.equal(compareVersions('0.20.2', '0.28.2'), -1);
    assert.equal(compareVersions('0.28.2', '0.20.2'), 1);
    assert.equal(compareVersions('4.10.0', '4.9.0'), 1);
    assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  });

  it('sorts a pre-release below its release', () => {
    assert.equal(compareVersions('1.0.0-rc.1', '1.0.0'), -1);
    assert.equal(compareVersions('1.0.0', '1.0.0-rc.1'), 1);
  });
});

describe('mc deps: the reading', () => {
  it('groups each direct dependency into the first group that applies, with its kind and its causes', async () => {
    const { reading, reused } = await read();
    assert.equal(reused, false);
    const { security, minor, major } = reading.groups;

    // A direct critical with a fix within ranges, and a direct high whose fix
    // names its own version within the major.
    assert.deepEqual(security.map((row) => row.name), ['pinned', 'builder']);
    const pinned = security[0];
    assert.equal(pinned.kind, 'runtime');
    assert.equal(pinned.severity, 'critical');
    assert.equal(pinned.spec, '1.2.3');
    assert.equal(pinned.target, '1.4.0');
    const builder = security[1];
    assert.equal(builder.kind, 'tool');
    assert.equal(builder.severity, 'high');
    assert.equal(builder.target, '4.9.0');
    // The transitive high is reached through the tool, and `deep` through it.
    assert.deepEqual(builder.via, ['deep', 'inner']);

    // 0.20 → 0.28 crosses the 0.x "major"; the newer 0.20.5 stays the target.
    assert.deepEqual(major.map((row) => [row.name, row.installed, row.target, row.latest, row.kind]),
      [['tiny', '0.20.2', '0.20.5', '0.28.2', 'runtime']]);
    assert.deepEqual(minor, []);

    assert.deepEqual(reading.audit.counts, AUDIT.metadata.vulnerabilities);
    assert.equal(reading.audit.transitive_fixable, 1);
    assert.equal(reading.failed, 0);
    assert.deepEqual(reading.notes, [{ name: 'builder', text: 'builder 4.1.0 → 4.12.0 (11 minor behind)' }]);
    assert.equal(reading.sha, 'abc1234def');
    assert.equal(reading.fetched, true);
  });

  it('saves the reading, and leaves no scratch directory behind', async () => {
    const { reading } = await read();
    assert.deepEqual(loadSaved('fixture', root), reading);
    assert.equal(savedPath('fixture', root), join(root, 'deps', 'fixture.json'));
    assert.deepEqual(readdirSync(join(root, 'work', 'runner', 'scratch')), []);
  });

  it('keeps a package whose npm view fails, with its error, and counts it', async () => {
    const { reading } = await read({ npmOptions: { failView: 'tiny' } });
    assert.equal(reading.failed, 1);
    const tiny = reading.unread.find((row) => row.name === 'tiny');
    assert.ok(tiny, 'the failed package was dropped');
    assert.match(tiny.error, /npm view: npm ERR! 404/u);
    assert.match(formatReading(reading, { now: new Date('2026-10-09T10:00:00Z') }), /NOT READ \(1\)\n {2}tiny/u);
  });

  it('fails with a message naming npm audit when its output is not JSON', async () => {
    await assert.rejects(read({ npmOptions: { auditStdout: 'npm ERR! network' } }), /npm audit/u);
  });

  it('goes on from the refs there are when the fetch fails', async () => {
    const { reading } = await read({ gitOptions: { fetchFails: true } });
    assert.equal(reading.fetched, false);
  });

  it('reuses a fresh saved reading of the same sha without calling npm', async () => {
    await read();
    const { git } = fakeGit();
    const { npm, calls } = fakeNpm();
    const { reading, reused } = await readDeps({
      repoPath: join(root, 'fixture'), env, root, git, npm, runNote, declaration,
      now: () => new Date('2026-10-09T12:00:00Z'),
    });
    assert.equal(reused, true);
    assert.equal(calls.length, 0, 'npm was called for a fresh reading');
    assert.equal(reading.read_at, '2026-10-09T10:00:00.000Z');

    // Another sha, or seven hours on, reads anew.
    const other = fakeNpm();
    await readDeps({
      repoPath: join(root, 'fixture'), env, root, git: fakeGit({ sha: 'fff0000' }).git, npm: other.npm, runNote, declaration,
      now: () => new Date('2026-10-09T12:00:00Z'),
    });
    assert.ok(other.calls.length > 0);
  });

  it('runs a note on origin/main: its script beside its lockfile, not in the primary checkout', async () => {
    const seen = [];
    const spy = async (argv, { cwd }) => {
      seen.push({
        cwd,
        script: readFileSync(join(cwd, 'check.mjs'), 'utf8'),
        lock: JSON.parse(readFileSync(join(cwd, 'package-lock.json'), 'utf8')),
      });
      return runNote();
    };
    const { reading } = await read({ overrides: { runNote: spy } });
    assert.equal(seen.length, 1);
    assert.notEqual(seen[0].cwd, join(root, 'fixture'));
    assert.equal(seen[0].script, '// the script on origin/main\n');
    assert.deepEqual(seen[0].lock, LOCK);
    assert.equal(reading.notes_from, 'origin/main');
  });

  it('reads anew a saved reading whose notes ran in the primary checkout', async () => {
    await read();
    const saved = JSON.parse(readFileSync(join(root, 'deps', 'fixture.json'), 'utf8'));
    delete saved.notes_from;
    writeFileSync(join(root, 'deps', 'fixture.json'), JSON.stringify(saved));
    const { npm, calls } = fakeNpm();
    const { reused } = await readDeps({
      repoPath: join(root, 'fixture'), env, root, git: fakeGit().git, npm, runNote, declaration,
      now: () => new Date('2026-10-09T10:30:00Z'),
    });
    assert.equal(reused, false);
    assert.ok(calls.length > 0);
  });

  it('a declaration that is not ok gives no notes, and a failing note is kept with its error', async () => {
    const none = await read({ overrides: { declaration: () => ({ ok: false, reason: 'x' }) } });
    assert.deepEqual(none.reading.notes, []);
    const broken = await read({ overrides: { runNote: async () => ({ status: 1, stdout: '', stderr: 'boom\n' }) } });
    assert.deepEqual(broken.reading.notes, [{ name: 'builder', text: null, error: 'boom' }]);
  });
});

describe('mc deps: printed', () => {
  it('prints the head line, the three groups, the notes and the next step', async () => {
    const { reading } = await read();
    const text = formatReading(reading, { now: new Date('2026-10-09T10:05:00Z') });
    const lines = text.split('\n');
    assert.equal(lines[0], 'mc deps fixture — origin/main abc1234, read 5 min ago: 1 critical · 2 high · 1 moderate');
    assert.match(text, /SECURITY, within the major \(2\)\n {2}critical {2}pinned {3}1\.2\.3 → 1\.4\.0 {2}runtime\n {2}high {6}builder {2}4\.1\.0 → 4\.9\.0 {2}tool {5}\(via deep, inner\)/u);
    assert.match(text, /PATCH\/MINOR \(0\)\n\nMAJOR \(1\)\n {2}tiny {2}0\.20\.2 → 0\.28\.2 {2}runtime\n/u);
    assert.match(text, /transitive: 1 more fixed by npm audit fix within ranges\nbuilder 4\.1\.0 → 4\.12\.0 \(11 minor behind\)\nnext: mc deps bump fixture security\n$/u);
  });

  it('trims transitive causes to three names', () => {
    const reading = {
      repo: 'r', sha: 'abcdef0', read_at: '2026-10-09T10:00:00Z', fetched: true,
      audit: { counts: {}, transitive_fixable: 0 },
      groups: {
        security: [], minor: [{ name: 'm', installed: '1.0.0', target: '1.1.0', kind: 'tool', via: [] }],
        major: [{ name: 'x', installed: '1.0.0', latest: '2.0.0', kind: 'runtime', severity: 'high', via: ['a', 'b', 'c', 'd', 'e'] }],
      },
      notes: [],
    };
    const text = formatReading(reading, { now: new Date('2026-10-09T10:00:00Z') });
    assert.match(text, /\(via a, b, c \+2\)/u);
    assert.match(text, /next: mc deps bump r minor\n$/u);
  });
});

describe('mc deps: the verb', () => {
  function io() {
    const out = { stdout: '', stderr: '' };
    return {
      out,
      stdout: { write: (text) => { out.stdout += text; } },
      stderr: { write: (text) => { out.stderr += text; } },
    };
  }

  it('prints the reading as JSON for a named repository', async () => {
    const streams = io();
    const code = await run(['fixture', '--json', '--refresh'], {
      ...streams, env, root, git: fakeGit().git, npm: fakeNpm().npm, runNote,
      resolveRepo: async () => join(root, 'fixture'),
    });
    assert.equal(code, 0, streams.out.stderr);
    const printed = JSON.parse(streams.out.stdout);
    assert.equal(printed.repo, 'fixture');
    assert.deepEqual(printed, loadSaved('fixture', root));
  });

  it('reads every repository with a lockfile when none is named, as an array', async () => {
    const streams = io();
    const code = await run(['--json'], {
      ...streams, env, root, git: fakeGit().git, npm: fakeNpm().npm, runNote,
      repos: [{ name: 'fixture', path: join(root, 'fixture') }],
    });
    assert.equal(code, 0, streams.out.stderr);
    const printed = JSON.parse(streams.out.stdout);
    assert.ok(Array.isArray(printed));
    assert.equal(printed[0].repo, 'fixture');
  });

  it('refuses an unknown repository', async () => {
    const streams = io();
    assert.equal(await run(['nope'], { ...streams, resolveRepo: async () => null }), 1);
    assert.match(streams.out.stderr, /no repository called "nope"/u);
  });
});
