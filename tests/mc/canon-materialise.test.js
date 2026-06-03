/**
 * `mc adapter materialise` — copy package canon into a repo (plan §13c).
 *
 * Coverage:
 *   - Pure helpers: CANON_DESTINATIONS mapping, detectCanonDrift,
 *     planMaterialise (create / noop / drift / broken-install skip).
 *   - parseMaterialiseArgs: flags + unknown-flag rejection.
 *   - In-process verb (runMaterialiseWith with stubbed deps): create,
 *     idempotent noop, drift refusal (exit 1, non-JSON path), --force,
 *     --dry-run, broken-install exit 2, partial-install skip, --json.
 *   - Subprocess wiring: `mc adapter materialise` reaches the verb +
 *     against the REAL package canon materialises into a temp repo
 *     (real on-disk layout, Pattern 6).
 *
 * The destination mapping is asserted against the real on-disk layout via
 * the inverse drift guard (tests/mc/canon-drift.test.js) AND a live
 * subprocess materialise into a temp dir, not just a hand-rolled fixture.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CANON_DESTINATIONS,
  detectCanonDrift,
  planMaterialise,
} from '../../src/mc/canon-materialise.js';
import {
  parseMaterialiseArgs,
  runMaterialiseWith,
} from '../../src/mc/commands/adapter.js';
import { CANON_MANIFEST, readPackageCanon } from '../../src/mc/canon.js';
import { runMc } from './_helpers/cli.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// ─────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────

describe('CANON_DESTINATIONS', () => {
  it('maps every canon manifest key to a repo destination', () => {
    // Lock-step with CANON_MANIFEST — no key may be without a destination.
    for (const key of Object.keys(CANON_MANIFEST)) {
      assert.ok(CANON_DESTINATIONS[key], `missing destination for ${key}`);
    }
  });

  it('uses the verified on-disk destinations (inverse of canon-drift PAIRS)', () => {
    assert.equal(CANON_DESTINATIONS.protocol, 'docs/coding-agent-protocol.md');
    assert.equal(CANON_DESTINATIONS.coordination, '.claude/skills/agent-coordination.md');
    assert.equal(CANON_DESTINATIONS.beCoordinator, '.claude/commands/be-coordinator.md');
  });
});

describe('detectCanonDrift', () => {
  it('missing on disk → "missing"', () => {
    assert.equal(detectCanonDrift({ existing: null, packaged: 'x' }).state, 'missing');
  });
  it('byte-equal → "up-to-date"', () => {
    assert.equal(detectCanonDrift({ existing: 'x\n', packaged: 'x\n' }).state, 'up-to-date');
  });
  it('present but differs → "drift"', () => {
    assert.equal(detectCanonDrift({ existing: 'edited\n', packaged: 'x\n' }).state, 'drift');
  });
});

describe('planMaterialise', () => {
  const canon = { protocol: 'P\n', coordination: 'C\n', beCoordinator: 'B\n' };

  function makeReadStub(filesByPath) {
    return (abs) => Object.prototype.hasOwnProperty.call(filesByPath, abs)
      ? filesByPath[abs]
      : null;
  }

  it('all-missing → action="create" per canon file', () => {
    const actions = planMaterialise({
      canon,
      resolveDest: (p) => `/repo/${p}`,
      readDest: makeReadStub({}),
    });
    assert.equal(actions.length, 3);
    for (const a of actions) {
      assert.equal(a.action, 'create');
      assert.equal(a.driftState, 'missing');
    }
  });

  it('idempotent — already-materialised files report "noop"', () => {
    const actions = planMaterialise({
      canon,
      resolveDest: (p) => `/repo/${p}`,
      readDest: makeReadStub({
        [`/repo/${CANON_DESTINATIONS.protocol}`]: 'P\n',
        [`/repo/${CANON_DESTINATIONS.coordination}`]: 'C\n',
        [`/repo/${CANON_DESTINATIONS.beCoordinator}`]: 'B\n',
      }),
    });
    for (const a of actions) assert.equal(a.action, 'noop');
  });

  it('hand-edited file → action="drift"', () => {
    const actions = planMaterialise({
      canon,
      resolveDest: (p) => `/repo/${p}`,
      readDest: makeReadStub({
        [`/repo/${CANON_DESTINATIONS.protocol}`]: '# I hand-edited this\n',
      }),
    });
    const protoAction = actions.find((a) => a.key === 'protocol');
    assert.equal(protoAction.action, 'drift');
    assert.equal(protoAction.driftState, 'drift');
  });

  it('soft-degrade: a null canon entry (broken install) → "skip" with reason, never written', () => {
    const actions = planMaterialise({
      canon: { protocol: null, coordination: 'C\n', beCoordinator: 'B\n' },
      resolveDest: (p) => `/repo/${p}`,
      readDest: makeReadStub({}),
    });
    const protoAction = actions.find((a) => a.key === 'protocol');
    assert.equal(protoAction.action, 'skip');
    assert.match(protoAction.reason, /missing from the mc package/);
    assert.equal(protoAction.absPath, null);
  });

  it('throws on a missing canon object (programmer error, not soft-degrade)', () => {
    assert.throws(() => planMaterialise({ canon: null, resolveDest: () => '', readDest: () => null }));
  });
});

// ─────────────────────────────────────────────────────────────
// parseMaterialiseArgs
// ─────────────────────────────────────────────────────────────

describe('parseMaterialiseArgs', () => {
  it('accepts no args', () => {
    assert.deepEqual(parseMaterialiseArgs([]), { dryRun: false, force: false, json: false });
  });
  it('parses --dry-run, --force, --json', () => {
    const o = parseMaterialiseArgs(['--dry-run', '--force', '--json']);
    assert.equal(o.dryRun, true);
    assert.equal(o.force, true);
    assert.equal(o.json, true);
  });
  it('rejects an unknown flag', () => {
    assert.match(parseMaterialiseArgs(['--nope']).error, /unknown flag/);
  });
});

// ─────────────────────────────────────────────────────────────
// runMaterialiseWith — in-process verb with stub deps
// ─────────────────────────────────────────────────────────────

const FULL_CANON = { protocol: 'PROTO\n', coordination: 'COORD\n', beCoordinator: 'BE\n' };

function makeDeps({ files = {}, canon = FULL_CANON, root = '/repo' } = {}) {
  const writes = [];
  const dep = {
    cwd: root,
    repoRoot: () => root,
    readCanon: () => canon,
    readFileText: (abs) => Object.prototype.hasOwnProperty.call(files, abs) ? files[abs] : null,
    writeFileText: (abs, body) => { writes.push({ abs, body }); files[abs] = body; },
  };
  return { dep, writes, files };
}

function captureStreams(fn) {
  const out = []; const err = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  const origLog = console.log;
  const origError = console.error;
  process.stdout.write = (s) => { out.push(typeof s === 'string' ? s : s.toString()); return true; };
  process.stderr.write = (s) => { err.push(typeof s === 'string' ? s : s.toString()); return true; };
  console.log = (...a) => { out.push(a.join(' ') + '\n'); };
  console.error = (...a) => { err.push(a.join(' ') + '\n'); };
  const restore = () => {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    console.log = origLog;
    console.error = origError;
  };
  return fn().then((code) => { restore(); return { code, stdout: out.join(''), stderr: err.join('') }; },
    (e) => { restore(); throw e; });
}

describe('runMaterialiseWith — clean repo (human path)', () => {
  it('creates all three canon files and exits 0', async () => {
    const { dep, writes } = makeDeps();
    const { code, stdout } = await captureStreams(() =>
      runMaterialiseWith({ dryRun: false, force: false, json: false }, dep));
    assert.equal(code, 0, stdout);
    assert.equal(writes.length, 3);
    const wrote = writes.map((w) => w.abs).sort();
    assert.deepEqual(wrote, [
      '/repo/.claude/commands/be-coordinator.md',
      '/repo/.claude/skills/agent-coordination.md',
      '/repo/docs/coding-agent-protocol.md',
    ]);
    // It copies the PACKAGE content verbatim, not a wrapper.
    const proto = writes.find((w) => w.abs.endsWith('coding-agent-protocol.md'));
    assert.equal(proto.body, 'PROTO\n');
    assert.match(stdout, /created/);
  });
});

describe('runMaterialiseWith — idempotency', () => {
  it('re-run on already-materialised files writes nothing and exits 0', async () => {
    const { dep, writes } = makeDeps({
      files: {
        '/repo/docs/coding-agent-protocol.md': 'PROTO\n',
        '/repo/.claude/skills/agent-coordination.md': 'COORD\n',
        '/repo/.claude/commands/be-coordinator.md': 'BE\n',
      },
    });
    const { code, stdout } = await captureStreams(() =>
      runMaterialiseWith({ dryRun: false, force: false, json: false }, dep));
    assert.equal(code, 0);
    assert.equal(writes.length, 0);
    assert.match(stdout, /up to date/);
  });
});

describe('runMaterialiseWith — drift handling', () => {
  it('a differing file without --force → exit 1, no writes, DRIFT on stdout (non-JSON)', async () => {
    const { dep, writes } = makeDeps({
      files: { '/repo/docs/coding-agent-protocol.md': '# locally edited\n' },
    });
    const { code, stdout, stderr } = await captureStreams(() =>
      runMaterialiseWith({ dryRun: false, force: false, json: false }, dep));
    assert.equal(code, 1, `stderr:${stderr} stdout:${stdout}`);
    // Exit-before-side-effect: NOTHING is written when drift blocks, even
    // the two clean (missing) files — no half-materialised state.
    assert.equal(writes.length, 0);
    assert.match(stdout, /DRIFT/);
    assert.match(stdout, /--force/);
  });

  it('--force overwrites the differing file, exits 0', async () => {
    const { dep, writes, files } = makeDeps({
      files: { '/repo/docs/coding-agent-protocol.md': '# locally edited\n' },
    });
    const { code, stdout } = await captureStreams(() =>
      runMaterialiseWith({ dryRun: false, force: true, json: false }, dep));
    assert.equal(code, 0);
    assert.equal(files['/repo/docs/coding-agent-protocol.md'], 'PROTO\n');
    // overwrites the drifted one + creates the two missing ones.
    assert.equal(writes.length, 3);
    assert.match(stdout, /overwritten/);
  });

  it('--dry-run with drift → exit 1, no writes', async () => {
    const { dep, writes } = makeDeps({
      files: { '/repo/docs/coding-agent-protocol.md': '# edited\n' },
    });
    const { code, stdout } = await captureStreams(() =>
      runMaterialiseWith({ dryRun: true, force: false, json: false }, dep));
    assert.equal(code, 1);
    assert.equal(writes.length, 0);
    assert.match(stdout, /DRIFT/);
  });

  it('--dry-run on a clean repo previews creates but writes nothing', async () => {
    const { dep, writes } = makeDeps();
    const { code, stdout } = await captureStreams(() =>
      runMaterialiseWith({ dryRun: true, force: false, json: false }, dep));
    assert.equal(code, 0);
    assert.equal(writes.length, 0);
    assert.match(stdout, /would create/);
  });
});

describe('runMaterialiseWith — broken / partial install', () => {
  it('wholly-absent canon → exit 2 with a friendly stderr message (non-JSON)', async () => {
    const { dep, writes } = makeDeps({ canon: { protocol: null, coordination: null, beCoordinator: null } });
    const { code, stdout, stderr } = await captureStreams(() =>
      runMaterialiseWith({ dryRun: false, force: false, json: false }, dep));
    assert.equal(code, 2);
    assert.equal(writes.length, 0);
    assert.match(stderr, /install looks broken/);
    assert.equal(stdout, '');
  });

  it('partial install — materialises present files, skips the missing one, exits 0', async () => {
    const { dep, writes, files } = makeDeps({
      canon: { protocol: 'PROTO\n', coordination: null, beCoordinator: 'BE\n' },
    });
    const { code, stdout } = await captureStreams(() =>
      runMaterialiseWith({ dryRun: false, force: false, json: false }, dep));
    assert.equal(code, 0);
    assert.equal(writes.length, 2);
    assert.ok(files['/repo/docs/coding-agent-protocol.md']);
    assert.ok(files['/repo/.claude/commands/be-coordinator.md']);
    assert.ok(!files['/repo/.claude/skills/agent-coordination.md']);
    assert.match(stdout, /skipped/);
  });
});

describe('runMaterialiseWith — --json', () => {
  it('clean repo → parseable object with actions + written', async () => {
    const { dep } = makeDeps();
    const { code, stdout } = await captureStreams(() =>
      runMaterialiseWith({ dryRun: false, force: false, json: true }, dep));
    assert.equal(code, 0);
    const parsed = JSON.parse(stdout.trim());
    assert.equal(parsed.ok, true);
    assert.equal(parsed.actions.length, 3);
    assert.equal(parsed.written.length, 3);
    assert.equal(parsed.destinations.protocol, 'docs/coding-agent-protocol.md');
  });

  it('drift → ok:false with drift_state for machine consumers, exit 1', async () => {
    const { dep } = makeDeps({
      files: { '/repo/docs/coding-agent-protocol.md': '# edited\n' },
    });
    const { code, stdout } = await captureStreams(() =>
      runMaterialiseWith({ dryRun: false, force: false, json: true }, dep));
    assert.equal(code, 1);
    const parsed = JSON.parse(stdout.trim());
    assert.equal(parsed.ok, false);
    const proto = parsed.actions.find((a) => a.canon === 'protocol');
    assert.equal(proto.action, 'drift');
  });

  it('broken install → ok:false error on the --json path too', async () => {
    const { dep } = makeDeps({ canon: { protocol: null, coordination: null, beCoordinator: null } });
    const { code, stdout, stderr } = await captureStreams(() =>
      runMaterialiseWith({ dryRun: false, force: false, json: true }, dep));
    assert.equal(code, 2);
    const parsed = JSON.parse(stdout.trim());
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, /install looks broken/);
    assert.match(stderr, /install looks broken/);
  });
});

// ─────────────────────────────────────────────────────────────
// Real package canon → real on-disk layout (Pattern 6)
// ─────────────────────────────────────────────────────────────

describe('runMaterialiseWith — against the REAL package canon, into a temp repo', () => {
  it('writes the actual canon files to their real destinations, byte-identical to the package', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mc-materialise-'));
    try {
      const dep = {
        cwd: tmp,
        repoRoot: () => tmp,
        readCanon: () => readPackageCanon(), // the real shipped canon
        readFileText: (abs) => existsSync(abs) ? readFileSync(abs, 'utf8') : null,
        writeFileText: (abs, body) => { mkdirSync(dirname(abs), { recursive: true }); writeFileSync(abs, body, 'utf8'); },
      };
      const { code } = await captureStreams(() =>
        runMaterialiseWith({ dryRun: false, force: false, json: false }, dep));
      assert.equal(code, 0);

      // The files landed at the verified destinations.
      const packaged = readPackageCanon();
      const onDisk = {
        protocol: readFileSync(join(tmp, 'docs', 'coding-agent-protocol.md'), 'utf8'),
        coordination: readFileSync(join(tmp, '.claude', 'skills', 'agent-coordination.md'), 'utf8'),
        beCoordinator: readFileSync(join(tmp, '.claude', 'commands', 'be-coordinator.md'), 'utf8'),
      };
      assert.equal(onDisk.protocol, packaged.protocol);
      assert.equal(onDisk.coordination, packaged.coordination);
      assert.equal(onDisk.beCoordinator, packaged.beCoordinator);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────
// Subprocess wiring — dispatch glue only
// ─────────────────────────────────────────────────────────────

describe('mc adapter materialise — subprocess wiring', () => {
  it('`mc adapter --help` lists materialise', () => {
    const r = runMc(['adapter', '--help']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /materialise/);
  });

  it('`mc adapter materialise --neverflag` exits 2 (unknown flag) — stderr', () => {
    const r = runMc(['adapter', 'materialise', '--neverflag']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /unknown flag/);
  });

  it('`mc adapter materialise --dry-run --json` reaches the verb against real canon', () => {
    // Run from a temp dir so it doesn't touch this repo's files.
    const tmp = mkdtempSync(join(tmpdir(), 'mc-materialise-sub-'));
    try {
      const r = runMc(['adapter', 'materialise', '--dry-run', '--json'], { cwd: tmp });
      assert.equal(r.status, 0, r.stderr);
      const parsed = JSON.parse(r.stdout.trim());
      assert.equal(parsed.dry_run, true);
      assert.equal(parsed.actions.length, 3);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
