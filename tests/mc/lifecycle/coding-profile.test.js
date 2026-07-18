import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

import {
  createUnifiedDiff,
  DEFAULT_CODING_PROFILE_TEMPLATE,
  formatReadJson,
  parseCandidateArgs,
  parseReadArgs,
  run,
  runDiff,
  runRead,
  runWrite,
} from '../../../src/mc/commands/coding-profile.js';

const VALID_PROFILE = `# Coding Profile

## Language

Prefer Swedish collaboration.

## Planning

Start implementation steps with a short analysis.

## Autonomy

Act on small fixes. Ask before risky changes.

## Git And GitHub

Do not force-push unless explicitly approved.

## Rules

- Do not commit .mc/brief.md.
`;

describe('mc coding-profile argv parsing', () => {
  test('help documents the explicit read-diff-write workflow', async () => {
    const stdout = makeWritable();
    const code = await run(['--help'], {
      stdout,
      stderr: makeWritable(),
    });
    assert.equal(code, 0);
    assert.match(stdout.text, /WORKFLOW/);
    assert.match(stdout.text, /read --json/);
    assert.match(stdout.text, /Discuss the intended durable work-method changes/);
    assert.match(stdout.text, /After approval/);
  });

  test('read accepts --json and --api', () => {
    assert.deepEqual(parseReadArgs(['--json', '--api', 'http://test']), {
      json: true,
      help: false,
    });
  });

  test('candidate commands require exactly one input source', () => {
    assert.ok(parseCandidateArgs([], { requireBaseRevision: false }).error);
    assert.ok(parseCandidateArgs(['--file', 'a.md', '--stdin']).error);
    assert.equal(parseCandidateArgs(['profile.md']).file, 'profile.md');
    assert.equal(parseCandidateArgs(['-']).stdin, true);
  });

  test('write requires an explicit non-negative base revision', () => {
    assert.match(parseCandidateArgs(['--stdin'], { requireBaseRevision: true }).error, /base-revision/);
    assert.match(parseCandidateArgs(['--stdin', '--base-revision', '-1'], { requireBaseRevision: true }).error, /non-negative/);
    const opts = parseCandidateArgs(['--stdin', '--base-revision', '3'], { requireBaseRevision: true });
    assert.equal(opts.baseRevision, 3);
  });
});

describe('createUnifiedDiff', () => {
  test('returns an empty string when unchanged', () => {
    assert.equal(createUnifiedDiff('a\n', 'a\n'), '');
  });

  test('renders a unified diff for changed profile text', () => {
    const diff = createUnifiedDiff('a\nb\n', 'a\nc\n', { from: 'server revision 1', to: 'candidate' });
    assert.match(diff, /^--- server revision 1\n\+\+\+ candidate\n@@ -1,2 \+1,2 @@/);
    assert.match(diff, /^-b$/m);
    assert.match(diff, /^\+c$/m);
  });
});

describe('formatReadJson', () => {
  test('expands an existing profile into LLM-friendly top-level fields', () => {
    const body = formatReadJson({
      revision: 4,
      markdown: VALID_PROFILE,
      updated_at: '2026-07-18T10:00:00Z',
      created_at: '2026-07-17T10:00:00Z',
      updated_by: 'mc_cli:device',
      change_summary: 'Initial profile',
      version_id: 'ver_1',
      version_created_at: '2026-07-18T10:01:00Z',
      source_session_id: 'sess_abc',
    });

    assert.equal(body.ok, true);
    assert.equal(body.exists, true);
    assert.equal(body.revision, 4);
    assert.equal(body.base_revision, 4);
    assert.equal(body.markdown, VALID_PROFILE);
    assert.deepEqual(body.last_update, {
      updated_at: '2026-07-18T10:00:00Z',
      created_at: '2026-07-17T10:00:00Z',
      version_id: 'ver_1',
      version_created_at: '2026-07-18T10:01:00Z',
      updated_by: 'mc_cli:device',
      change_summary: 'Initial profile',
      source_session_id: 'sess_abc',
    });
    assert.match(body.workflow.join('\n'), /--base-revision 4/);
  });

  test('includes a compact first-profile template when no profile exists', () => {
    const body = formatReadJson(null);
    assert.equal(body.ok, true);
    assert.equal(body.exists, false);
    assert.equal(body.revision, 0);
    assert.equal(body.base_revision, 0);
    assert.equal(body.markdown, '');
    assert.equal(body.profile, null);
    assert.equal(body.template_markdown, DEFAULT_CODING_PROFILE_TEMPLATE);
    assert.match(body.template_markdown, /## Language/);
    assert.match(body.template_markdown, /## Git And GitHub/);
    assert.match(body.template_markdown, /## Rules/);
    assert.match(body.workflow.join('\n'), /mc coding-profile diff --stdin/);
    assert.match(body.workflow.join('\n'), /--base-revision 0/);
  });
});

describe('mc coding-profile read', () => {
  test('subcommand help does not require auth', async () => {
    const stdout = makeWritable();
    const code = await runRead(['--help'], {
      getSecret: async () => { throw new Error('should not read token'); },
      stdout,
      stderr: makeWritable(),
    });
    assert.equal(code, 0);
    assert.match(stdout.text, /Usage: mc coding-profile read/);
  });

  test('prints approved Markdown only on the default path', async () => {
    const stdout = makeWritable();
    const stderr = makeWritable();
    const calls = [];
    const code = await runRead([], {
      apiUrl: 'http://test',
      getSecret: async () => 'mem_token',
      memoroFetch: async (_apiUrl, path, opts) => {
        calls.push({ path, opts });
        return { ok: true, profile: { revision: 4, markdown: VALID_PROFILE } };
      },
      stdout,
      stderr,
    });

    assert.equal(code, 0);
    assert.equal(stdout.text, VALID_PROFILE);
    assert.equal(stderr.text, '');
    assert.deepEqual(calls.map((call) => call.path), ['/api/mc/coding-profile']);
  });

  test('--json preserves null profile state', async () => {
    const stdout = makeWritable();
    const code = await runRead(['--json'], {
      apiUrl: 'http://test',
      getSecret: async () => 'mem_token',
      memoroFetch: async () => ({ ok: true, profile: null }),
      stdout,
      stderr: makeWritable(),
    });
    assert.equal(code, 0);
    const body = JSON.parse(stdout.text);
    assert.equal(body.ok, true);
    assert.equal(body.profile, null);
    assert.equal(body.exists, false);
    assert.equal(body.base_revision, 0);
    assert.match(body.template_markdown, /# Coding Profile/);
  });

  test('--json exposes revision, markdown, and last update metadata', async () => {
    const stdout = makeWritable();
    const code = await runRead(['--json'], {
      apiUrl: 'http://test',
      getSecret: async () => 'mem_token',
      memoroFetch: async () => ({
        ok: true,
        profile: {
          revision: 9,
          markdown: VALID_PROFILE,
          updatedAt: '2026-07-18T11:00:00Z',
          updatedBy: 'mc_cli:device',
          versionId: 'ver_9',
          versionCreatedAt: '2026-07-18T11:01:00Z',
          changeSummary: 'Clarify autonomy',
        },
      }),
      stdout,
      stderr: makeWritable(),
    });
    assert.equal(code, 0);
    const body = JSON.parse(stdout.text);
    assert.equal(body.exists, true);
    assert.equal(body.revision, 9);
    assert.equal(body.base_revision, 9);
    assert.equal(body.markdown, VALID_PROFILE);
    assert.equal(body.updated_at, '2026-07-18T11:00:00Z');
    assert.equal(body.last_update.change_summary, 'Clarify autonomy');
    assert.equal(body.last_update.updated_by, 'mc_cli:device');
    assert.equal(body.last_update.version_id, 'ver_9');
    assert.equal(body.last_update.version_created_at, '2026-07-18T11:01:00Z');
    assert.match(body.workflow.join('\n'), /--base-revision 9/);
    assert.equal(body.profile.revision, 9);
  });
});

describe('mc coding-profile diff', () => {
  test('compares stdin candidate against the approved revision', async () => {
    const stdout = makeWritable();
    const code = await runDiff(['--stdin', '--json'], {
      apiUrl: 'http://test',
      getSecret: async () => 'mem_token',
      stdin: Readable.from([VALID_PROFILE.replace('Swedish', 'Swedish-first')]),
      memoroFetch: async () => ({ ok: true, profile: { revision: 7, markdown: VALID_PROFILE } }),
      stdout,
      stderr: makeWritable(),
    });

    assert.equal(code, 0);
    const body = JSON.parse(stdout.text);
    assert.equal(body.ok, true);
    assert.equal(body.base_revision, 7);
    assert.equal(body.changed, true);
    assert.match(body.diff, /server revision 7/);
    assert.match(body.diff, /\+Prefer Swedish-first collaboration\./);
  });

  test('returns zero for unchanged candidates', async () => {
    const stdout = makeWritable();
    const code = await runDiff(['--stdin'], {
      apiUrl: 'http://test',
      getSecret: async () => 'mem_token',
      stdin: Readable.from([VALID_PROFILE]),
      memoroFetch: async () => ({ ok: true, profile: { revision: 1, markdown: VALID_PROFILE } }),
      stdout,
      stderr: makeWritable(),
    });

    assert.equal(code, 0);
    assert.equal(stdout.text, '');
  });
});

describe('mc coding-profile write', () => {
  test('writes a full replacement with base revision and summary', async () => {
    const stdout = makeWritable();
    const calls = [];
    const code = await runWrite(['--stdin', '--base-revision', '4', '--summary', 'Tighten Git rules', '--json'], {
      apiUrl: 'http://test',
      getSecret: async () => 'mem_token',
      stdin: Readable.from([VALID_PROFILE]),
      memoroFetch: async (_apiUrl, path, opts) => {
        calls.push({ path, opts });
        return { ok: true, profile: { revision: 5, markdown: opts.body.markdown } };
      },
      stdout,
      stderr: makeWritable(),
    });

    assert.equal(code, 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].path, '/api/mc/coding-profile');
    assert.equal(calls[0].opts.method, 'PUT');
    assert.equal(calls[0].opts.body.baseRevision, 4);
    assert.equal(calls[0].opts.body.changeSummary, 'Tighten Git rules');
    assert.equal(calls[0].opts.body.markdown, VALID_PROFILE);
    assert.equal(JSON.parse(stdout.text).profile.revision, 5);
  });

  test('surfaces stale revision conflicts with exit code 3', async () => {
    const stdout = makeWritable();
    const err = new Error('Memoro 409: Coding Profile base revision is stale.');
    err.status = 409;
    err.data = {
      ok: false,
      error: 'Coding Profile base revision is stale.',
      code: 'coding_profile_revision_conflict',
      currentRevision: 8,
      baseRevision: 4,
    };
    const code = await runWrite(['--stdin', '--base-revision', '4', '--json'], {
      apiUrl: 'http://test',
      getSecret: async () => 'mem_token',
      stdin: Readable.from([VALID_PROFILE]),
      memoroFetch: async () => { throw err; },
      stdout,
      stderr: makeWritable(),
    });

    assert.equal(code, 3);
    const body = JSON.parse(stdout.text);
    assert.equal(body.ok, false);
    assert.equal(body.code, 'coding_profile_revision_conflict');
    assert.equal(body.currentRevision, 8);
    assert.equal(body.baseRevision, 4);
  });
});

function makeWritable() {
  const writes = [];
  return {
    writes,
    write(s) { writes.push(String(s)); return true; },
    get text() { return writes.join(''); },
  };
}
