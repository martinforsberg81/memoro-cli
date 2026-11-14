/** Commissioned decision-lane protection: real runner/store, fake tool session and Git. */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRunner, realDeps } from '../../../src/mc/run.js';
import { deskItemId, itemDirectory, readDeskItem, writeDeskItem } from '../../../src/mc/desk-items.js';
import { run as martin } from '../../../src/mc/commands/martin.js';
import { DEFAULT_CATALOG } from '../../../src/mc/model-config.js';
import { normaliseCapacity } from '../../../src/mc/model-capacity.js';
import * as claude from '../../../src/adapters/claude-code.js';
import * as codex from '../../../src/adapters/codex.js';
import { goalJson } from './goal-file.js';

export const NOW = new Date('2026-11-14T12:00:00Z');
export const result = { status: 0, stdout: '{"type":"result","num_turns":1,"total_cost_usd":1}', stderr: '' };
const sink = { write() {} };
export function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'mc-decision-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { MC_WORK_ROOT: root, MC_HOME: join(root, 'home'), MC_REPOS_HOME: join(root, 'repos') };
  const calls = [], git = [];
  const deps = { ...realDeps(env), platform: 'darwin', freeBytes: undefined, freeMemoryPercent: undefined,
    now: () => NOW, laneCount: () => 4, sleep: async () => assert.fail('unexpected slot wait'),
    billing: { readState: () => ({}), readApi: () => ({ claude: false, codex: false }) },
    catalog: () => DEFAULT_CATALOG,
    capacity: { read: () => normaliseCapacity(null), write() {} },
    attachDeps: async () => ({ ok: true }), sweepExports: async () => ({}),
    git: (cwd, args) => { git.push({ cwd, args }); return { ok: true, stdout: '', stderr: '' }; },
    gh: () => assert.fail('no GitHub for decision work'),
    launch: tool => ({ ok: true, id: tool === 'claude' ? 'claude-code' : 'codex', spec: { bin: `/fake/${tool}` }, adapter: tool === 'claude' ? claude : codex }),
    session: async call => { calls.push(call); return result; }, log() {},
  };
  const add = (reference, fields = {}) => {
    const kind = reference.startsWith('decision:') ? 'decision' : 'goal';
    const at = fields.source_at || '2026-11-14T10:00:00Z';
    const item = { schema: 'mc-desk-item', version: 1, id: deskItemId(kind, reference, at), kind, reference, source_at: at,
      opened_at: at, state: 'prepared', sort: 'technical', reversible: null, due_at: null, outcome: null, ...fields };
    writeDeskItem(item, { env });
    writeFileSync(join(itemDirectory(item, env), 'prepared.md'), 'Prepared evidence.');
    if (kind === 'goal') {
      const dir = join(root, 'programs', reference.split('/')[0], 'goals', reference.split('/')[1]);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'GOAL.json'), goalJson({ status: 'Martin' }));
      writeFileSync(join(dir, 'LOG.md'), '## 2026-11-14T10:00Z · runner · build · Martin\n\nComment: waiting\n');
    }
    return item;
  };
  const runner = () => createRunner({ deps, merge: false });
  const state = item => readDeskItem(item.id, { env });
  const close = async (item, by = 'decision') => {
    assert.equal(await martin(['item', item.id, 'close', '--by', by, '--summary', 'Arbetet kan fortsätta. Regeln är redan bestämd.'], { env: { ...env, MC_ROLE: 'decision' }, stdout: sink, stderr: sink, now: () => NOW }), 0);
  };
  return { env, root, deps, calls, git, add, runner, state, close };
}

