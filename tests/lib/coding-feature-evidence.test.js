import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { describe } from 'node:test';

import {
  buildCodingFeatureEvidenceRecords,
  CODING_FEATURE_DETECTORS,
  CODING_FEATURE_DETECTOR_VERSION,
  CODING_FEATURE_EVIDENCE_CONTRACT_VERSION,
  collectCodingArtifacts,
  detectCodingFeatures,
  detectCodingFeaturesSafely,
  publishCodingFeatureEvidence,
  sanitizeCodingFeatureEvidenceRecord,
} from '../../src/lib/coding-feature-evidence.js';

const CONTRACT_FIXTURE = JSON.parse(readFileSync(
  new URL('../fixtures/coding-feature-evidence-v1.json', import.meta.url),
  'utf8',
));

function claudeMutation(path, content, { name = 'Edit', id = 'tool_1' } = {}) {
  return [{
    message: {
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id,
        name,
        input: { file_path: path, new_string: content },
      }],
    },
  }];
}

function claudeRead(path, content, { id = 'tool_read_1' } = {}) {
  return [
    {
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: path } }],
      },
    },
    {
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: id, content }],
      },
    },
  ];
}

function detection(entries, featureId) {
  return detectCodingFeatures(entries).find((item) => item.feature_id === featureId);
}

describe('coding feature detector contract', () => {
  test('matches the server fixture byte-for-byte at the semantic boundary', () => {
    const actual = {
      contract_version: CODING_FEATURE_EVIDENCE_CONTRACT_VERSION,
      detector_version: CODING_FEATURE_DETECTOR_VERSION,
      features: Object.fromEntries(Object.entries(CODING_FEATURE_DETECTORS).map(([id, definition]) => [
        id,
        {
          evidence_codes: definition.signals.map((entry) => entry.code).sort(),
          high_signal_codes: [...definition.highSignalCodes].sort(),
        },
      ])),
    };
    assert.deepEqual(actual, CONTRACT_FIXTURE);
  });

  test('keeps detector failures non-blocking', () => {
    assert.deepEqual(detectCodingFeaturesSafely([], {
      detect() { throw new Error('detector failed'); },
    }), []);
  });
});

describe('initial feature detectors', () => {
  test('detects Durable Object WebSocket hibernation from associated Read results', () => {
    const entries = [
      ...claudeRead('src/socket.js', `
        state.acceptWebSocket(socket);
        const sockets = state.getWebSockets();
      `, { id: 'read_socket' }),
      ...claudeRead('wrangler.toml', `
        [durable_objects]
        bindings = [{ name = "ROOM", class_name = "Room" }]
      `, { id: 'read_config' }),
    ];
    const found = detection(entries, 'cloudflare.durable_objects.websocket_hibernation');
    assert.deepEqual(found.evidence_codes, [
      'api:acceptWebSocket',
      'api:getWebSockets',
      'config:durable_objects',
    ]);
    assert.equal(found.files_observed, 2);
  });

  test('detects Cloudflare queue delivery semantics from actual producer and consumer APIs', () => {
    const entries = [
      ...claudeMutation('src/producer.ts', 'await env.EVENTS.sendBatch(messages);', { id: 'queue_producer' }),
      ...claudeMutation('src/consumer.ts', `
        export default { async queue(batch, env) {
          for (const message of batch.messages) message.ack();
        }};
      `, { id: 'queue_consumer' }),
    ];
    const found = detection(entries, 'cloudflare.workers.queues_delivery');
    assert.ok(found.evidence_codes.includes('api:queue.sendBatch'));
    assert.ok(found.evidence_codes.includes('handler:queue'));
    assert.ok(found.evidence_codes.includes('api:message.ack'));
    assert.equal(found.files_observed, 2);
  });

  test('detects Cloudflare service bindings only with config plus use', () => {
    const entries = [
      ...claudeMutation('wrangler.jsonc', '{ "services": [{ "binding": "AUTH", "service": "auth" }] }', { id: 'service_config' }),
      ...claudeMutation('src/index.ts', 'const response = await env.AUTH.fetch(request);', { id: 'service_code' }),
    ];
    const found = detection(entries, 'cloudflare.workers.service_bindings');
    assert.deepEqual(found.evidence_codes, ['api:service.fetch', 'config:services']);
  });

  test('detects SQLite FTS5 search from concrete schema and query syntax', () => {
    const found = detection(claudeMutation('migrations/search.sql', `
      CREATE VIRTUAL TABLE documents_fts USING fts5(title, body);
      SELECT rowid, bm25(documents_fts) FROM documents_fts
      WHERE documents_fts MATCH ?;
    `), 'sqlite.fts5_search');
    assert.ok(found.evidence_codes.includes('sql:create_virtual_table_fts5'));
    assert.ok(found.evidence_codes.includes('sql:match_query'));
    assert.ok(found.evidence_codes.includes('api:fts5_rank_bm25'));
  });

  test('detects PostgreSQL row-level security from policy DDL', () => {
    const found = detection(claudeMutation('migrations/rls.sql', `
      ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
      CREATE POLICY owner_documents ON documents USING (owner_id = current_user_id());
    `), 'postgres.row_level_security');
    assert.deepEqual(found.evidence_codes, [
      'sql:create_policy',
      'sql:enable_row_level_security',
    ]);
  });

  test('detects node worker_threads from a Codex patch without retaining the patch', () => {
    const patch = `*** Begin Patch
*** Update File: src/worker.js
@@
+import { Worker, MessageChannel } from 'node:worker_threads';
+const worker = new Worker(new URL('./job.js', import.meta.url));
+const channel = new MessageChannel();
*** End Patch`;
    const entries = [{
      type: 'response_item',
      payload: {
        type: 'function_call',
        call_id: 'call_patch',
        name: 'apply_patch',
        arguments: JSON.stringify({ patch }),
      },
    }];
    const found = detection(entries, 'node.worker_threads');
    assert.deepEqual(found.evidence_codes, [
      'api:MessageChannel',
      'api:new_Worker',
      'import:node_worker_threads',
    ]);
    assert.equal(JSON.stringify(found).includes('src/worker.js'), false);
    assert.equal(JSON.stringify(found).includes('new URL'), false);
  });

  test('associates bounded Codex read-command output with its local file only', () => {
    const entries = [
      {
        type: 'response_item',
        payload: {
          type: 'function_call',
          call_id: 'call_read',
          name: 'exec_command',
          arguments: JSON.stringify({ command: "sed -n '1,120p' src/request.ts" }),
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'call_read',
          output: 'const signal = AbortSignal.any([AbortSignal.timeout(5000), parent]);',
        },
      },
    ];
    const found = detection(entries, 'web.abort_signal_composition');
    assert.deepEqual(found, {
      feature_id: 'web.abort_signal_composition',
      evidence_codes: ['api:AbortSignal.any', 'api:AbortSignal.timeout'],
      files_observed: 1,
    });
  });

  test('detects AbortSignal composition from generic structured tool calls', () => {
    const entries = [{
      type: 'function_call',
      id: 'gemini_write',
      name: 'write_file',
      args: {
        path: 'src/request.ts',
        content: 'const signal = AbortSignal.any([AbortSignal.timeout(5000), parent]);',
      },
    }];
    const found = detection(entries, 'web.abort_signal_composition');
    assert.deepEqual(found.evidence_codes, [
      'api:AbortSignal.any',
      'api:AbortSignal.timeout',
    ]);
  });
});

describe('cross-tool structured inputs', () => {
  const code = "import { Worker } from 'node:worker_threads';\nconst worker = new Worker('./job.js');";
  const cases = {
    'claude-code': claudeMutation('src/jobs.js', code),
    codex: [{
      type: 'response_item',
      payload: {
        type: 'function_call',
        call_id: 'codex_patch',
        name: 'apply_patch',
        arguments: JSON.stringify({ patch: `*** Update File: src/jobs.js\n+${code}` }),
      },
    }],
    cursor: [{
      message: {
        tool_calls: [{
          id: 'cursor_edit',
          function: { name: 'edit_file', arguments: JSON.stringify({ path: 'src/jobs.js', content: code }) },
        }],
      },
    }],
    windsurf: [{ type: 'tool_call', id: 'windsurf_write', name: 'write_file', input: { path: 'src/jobs.js', content: code } }],
    'gemini-cli': [{ type: 'function_call', id: 'gemini_write', name: 'write_file', args: { file_path: 'src/jobs.js', content: code } }],
  };

  for (const [tool, entries] of Object.entries(cases)) {
    test(`detects the same normalized evidence for ${tool}`, () => {
      const found = detection(entries, 'node.worker_threads');
      assert.deepEqual(found, {
        feature_id: 'node.worker_threads',
        evidence_codes: ['api:new_Worker', 'import:node_worker_threads'],
        files_observed: 1,
      });
    });
  }
});

describe('false-positive guards', () => {
  test('ignores assistant and user prose even when it names APIs', () => {
    const entries = [
      { message: { role: 'user', content: 'Could AbortSignal.any and AbortSignal.timeout help?' } },
      { message: { role: 'assistant', content: 'Use acceptWebSocket and getWebSockets.' } },
    ];
    assert.deepEqual(detectCodingFeatures(entries), []);
  });

  test('does not treat an installed dependency as feature use', () => {
    const entries = claudeMutation('package.json', JSON.stringify({
      dependencies: { 'node:worker_threads': '^1.0.0' },
    }));
    assert.deepEqual(detectCodingFeatures(entries), []);
  });

  test('requires at least two signals and rejects config-only presence', () => {
    assert.deepEqual(detectCodingFeatures(
      claudeMutation('src/request.ts', 'const timeout = AbortSignal.timeout(1000);'),
    ), []);
    assert.deepEqual(detectCodingFeatures(
      claudeMutation('wrangler.toml', '[durable_objects]\nbindings = []'),
    ), []);
  });

  test('does not scan search command text as code evidence', () => {
    const entries = [{
      type: 'response_item',
      payload: {
        type: 'function_call',
        call_id: 'search_only',
        name: 'exec_command',
        arguments: JSON.stringify({ command: 'rg "AbortSignal.any|AbortSignal.timeout" src' }),
      },
    }];
    assert.deepEqual(detectCodingFeatures(entries), []);
  });

  test('ignores this detector and its fixture paths', () => {
    const entries = claudeMutation('src/lib/coding-feature-evidence.js', `
      const a = AbortSignal.any([]);
      const b = AbortSignal.timeout(1000);
    `);
    assert.deepEqual(detectCodingFeatures(entries), []);
  });

  test('does not associate orphan tool output with a file', () => {
    const entries = [{
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'missing_call',
        output: 'AbortSignal.any([]); AbortSignal.timeout(1);',
      },
    }];
    assert.deepEqual(collectCodingArtifacts(entries), []);
    assert.deepEqual(detectCodingFeatures(entries), []);
  });

  test('bounds artifact count and per-artifact tool output size', () => {
    const entries = [];
    for (let index = 0; index < 250; index += 1) {
      entries.push(...claudeRead(`src/file-${index}.js`, 'x'.repeat(70 * 1024), {
        id: `read_${index}`,
      }));
    }
    const artifacts = collectCodingArtifacts(entries);
    assert.equal(artifacts.length, 200);
    assert.ok(artifacts.every((artifact) => artifact.content.length <= 64 * 1024));
  });
});

describe('normalized evidence publication', () => {
  const detections = [{
    feature_id: 'web.abort_signal_composition',
    evidence_codes: ['api:AbortSignal.timeout', 'api:AbortSignal.any'],
    files_observed: 2,
  }];

  test('builds the exact server shape and falls through invalid path-like repo candidates', () => {
    const records = buildCodingFeatureEvidenceRecords({
      detections,
      sourceId: 'local:martins-mac',
      codingSessionId: 'sess_123456',
      repoCandidates: ['/Users/martin/repo', 'src/secret/file.js', 'martinforsberg81/memoro'],
      observedAt: '2026-07-21T10:00:00Z',
    });
    assert.deepEqual(records, [{
      contract_version: 'coding-feature-evidence-v1',
      feature_id: 'web.abort_signal_composition',
      source_id: 'local:martins-mac',
      coding_session_id: 'sess_123456',
      repo: 'martinforsberg81/memoro',
      observed_at: '2026-07-21T10:00:00.000Z',
      evidence_codes: ['api:AbortSignal.any', 'api:AbortSignal.timeout'],
      files_observed: 2,
      confidence: 'high',
      detector_version: 'coding-features-v1',
    }]);
  });

  test('returns no records when source, session, repo, or timestamp identity is missing', () => {
    for (const overrides of [
      { sourceId: null },
      { codingSessionId: null },
      { repoCandidates: ['/private/repo/path'] },
      { observedAt: 'not-a-date' },
    ]) {
      assert.deepEqual(buildCodingFeatureEvidenceRecords({
        detections,
        sourceId: 'local:mac',
        codingSessionId: 'sess_123456',
        repoCandidates: ['memoro'],
        observedAt: '2026-07-21T10:00:00.000Z',
        ...overrides,
      }), []);
    }
  });

  test('reconstructs an exact safe record and strips unknown raw fields', () => {
    const [record] = buildCodingFeatureEvidenceRecords({
      detections,
      sourceId: 'local:mac',
      codingSessionId: 'sess_123456',
      repoCandidates: ['memoro'],
      observedAt: '2026-07-21T10:00:00.000Z',
    });
    const safe = sanitizeCodingFeatureEvidenceRecord({
      ...record,
      transcript: 'SECRET TRANSCRIPT',
      file_paths: ['src/private.js'],
      patch: 'SECRET PATCH',
    });
    assert.deepEqual(safe, record);
    const serialized = JSON.stringify(safe);
    assert.equal(serialized.includes('SECRET'), false);
    assert.equal(serialized.includes('src/private.js'), false);
  });

  test('publishes only sanitized normalized records and never throws on transport failure', async () => {
    const [record] = buildCodingFeatureEvidenceRecords({
      detections,
      sourceId: 'local:mac',
      codingSessionId: 'sess_123456',
      repoCandidates: ['memoro'],
      observedAt: '2026-07-21T10:00:00.000Z',
    });
    const calls = [];
    const accepted = await publishCodingFeatureEvidence([{ ...record, code: 'SECRET CODE' }], {
      apiUrl: 'https://meetmemoro.test',
      token: 'mem_test',
      async request(...args) { calls.push(args); return { ok: true }; },
    });
    assert.deepEqual(accepted, { attempted: 1, accepted: 1, rejected: 0 });
    assert.equal(calls[0][1], '/api/sessions/coding-feature-evidence');
    assert.deepEqual(calls[0][2].body, record);
    assert.equal(JSON.stringify(calls).includes('SECRET CODE'), false);

    const failed = await publishCodingFeatureEvidence([record], {
      apiUrl: 'https://meetmemoro.test',
      token: 'mem_test',
      async request() { throw new Error('offline'); },
    });
    assert.deepEqual(failed, { attempted: 1, accepted: 0, rejected: 1 });
  });

  test('does not call transport for a malformed record', async () => {
    let called = false;
    const summary = await publishCodingFeatureEvidence([{ transcript: 'raw' }], {
      async request() { called = true; },
    });
    assert.deepEqual(summary, { attempted: 1, accepted: 0, rejected: 1 });
    assert.equal(called, false);
  });
});
