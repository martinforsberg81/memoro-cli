import { describe, it, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AUTOCOMPACT_TOKENS, CLAUDE_TOOLS, DEFAULT_CHECK_IN_MINUTES, DEFAULT_STALL_MINUTES, SESSION_DEFAULTS, quietPrompt, collectNote,
  describeSettings, describeWatch, headlessArgs, helperDue,
  intakeNote, nightlyDue, intakeQueue, landingNote,
  quotaResetAt, quotaSeen, apiInterruption, creditsResetAt,
  readSessionOutput, streamRateLimit, streamSummary, sessionResult, sessionSettings,
  tsvHeader, tsvRow, routedSettings,
} from '../../src/mc/run-plan.js';
import { profileArgs } from '../../src/mc/portrait.js';
import { instructionsFor, readCanonRole } from '../../src/mc/roles.js';
import * as claudeAdapter from '../../src/adapters/claude-code.js';
import * as codexAdapter from '../../src/adapters/codex.js';
import { parseRunArgs } from '../../src/mc/commands/run.js';

test('SESSION_DEFAULTS: the review session runs on opus at high effort, with no advisor', () => {
  assert.deepEqual(SESSION_DEFAULTS.review, { model: 'opus', effort: 'high', advisor: null });
  const settings = sessionSettings({}, null, { kind: 'review' });
  assert.deepEqual([settings.model, settings.effort, settings.advisor], ['opus', 'high', null]);
});

test('headlessArgs: claude is -p on stream-json with the prompt on stdin; codex is exec --json', () => {
  const claude = headlessArgs({ toolId: 'claude-code', adapter: { modelArgs: (m) => ['--model', m] }, model: 'opus', instructions: 'INSTRUCTIONS', prompt: 'do it', profileArgs });
  assert.deepEqual(claude, ['-p', '--model', 'opus', '--permission-mode', 'acceptEdits', '--autocompact', String(AUTOCOMPACT_TOKENS), '--tools', CLAUDE_TOOLS, '--strict-mcp-config', '--append-system-prompt', 'INSTRUCTIONS', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose']);
  assert.equal(claude.includes('do it'), false, 'the prompt is the first message on stdin, not an argument');
  assert.equal(AUTOCOMPACT_TOKENS, 150_000);
  // The helper and intake turns opt out: step-cost's contract leaves them be —
  // no compaction, and the positional prompt with one JSON object back.
  const helper = headlessArgs({ toolId: 'claude-code', adapter: { modelArgs: (m) => ['--model', m] }, model: 'opus', instructions: 'INSTRUCTIONS', prompt: 'do it', profileArgs, autocompact: null, stream: false });
  assert.equal(helper.includes('--autocompact'), false);
  assert.deepEqual(helper, ['-p', 'do it', '--model', 'opus', '--permission-mode', 'acceptEdits', '--tools', CLAUDE_TOOLS, '--strict-mcp-config', '--append-system-prompt', 'INSTRUCTIONS', '--output-format', 'json']);
  // Every launch includes native Agent, but no Skill or MCP server, including
  // the helper. Grep and Glob are in it: the default set omits them.
  assert.equal(CLAUDE_TOOLS, 'Bash,Read,Edit,Write,Grep,Glob,Agent');
  assert.deepEqual(helper.slice(helper.indexOf('--tools'), helper.indexOf('--tools') + 3), ['--tools', CLAUDE_TOOLS, '--strict-mcp-config']);
  const codex = headlessArgs({ toolId: 'codex', adapter: { modelArgs: (m) => ['-m', m] }, model: 'o3', instructions: 'INSTRUCTIONS', prompt: 'do it', profileArgs });
  assert.deepEqual(codex, ['exec', '--json', '--sandbox', 'danger-full-access', '-m', 'o3', '-c', 'instructions="INSTRUCTIONS"', '--skip-git-repo-check', 'do it']);
  assert.equal(codex.includes('--autocompact'), false, 'codex has no such flag');
  // Never `--full-auto`: workspace-write has no network and no writes outside
  // the working directory, so the step could not push or open its PR — and a
  // workarea's `.git` lives outside it, so it could not even commit.
  assert.equal(codex.includes('--full-auto'), false);
  // No model named means no `-m` at all — the tool's own default, not opus.
  const bare = headlessArgs({ toolId: 'codex', adapter: { modelArgs: (m) => (m ? ['-m', m] : []) }, model: null, instructions: null, prompt: 'do it', profileArgs });
  assert.deepEqual(bare, ['exec', '--json', '--sandbox', 'danger-full-access', '--skip-git-repo-check', 'do it']);
});

/**
 * Ruling 18: a step runs on sonnet at medium effort with an opus advisor. The
 * flags are the adapter's, so this goes through the real claude adapter — a
 * fixture that spelled them would pass with a flag claude does not take.
 */
test('headlessArgs: claude gets --model, --effort and --advisor, and none when unset', async () => {
  const adapter = await import('../../src/adapters/claude-code.js');
  const args = headlessArgs({ toolId: 'claude-code', adapter, model: 'sonnet', effort: 'medium', advisor: 'opus', instructions: null, prompt: 'do it', profileArgs });
  assert.deepEqual(args.slice(0, 7), ['-p', '--model', 'sonnet', '--effort', 'medium', '--advisor', 'opus']);
  assert.equal(args[7], '--permission-mode');
  const repair = headlessArgs({ toolId: 'claude-code', adapter, model: 'opus', effort: null, advisor: null, instructions: null, prompt: 'do it', profileArgs });
  assert.deepEqual(repair.slice(0, 4), ['-p', '--model', 'opus', '--permission-mode']);
  assert.deepEqual(adapter.advisorArgs('off'), [], '`off` is no advisor, not an advisor called off');
  // Codex takes no advisor, whatever it is handed; its effort is its own override.
  const codex = headlessArgs({ toolId: 'codex', adapter: { modelArgs: codexAdapter.modelArgs, effortArgs: codexAdapter.effortArgs, advisorArgs: () => ['--advisor', 'y'] }, model: 'o3', effort: 'high', advisor: 'opus', instructions: null, prompt: 'do it', profileArgs });
  assert.deepEqual(codex, ['exec', '--json', '--sandbox', 'danger-full-access', '-m', 'o3', '-c', 'model_reasoning_effort=high', '--skip-git-repo-check', 'do it']);
});

test('headlessArgs: codex new and resumed launches take the Codex model and effort, and no claude flag', () => {
  const fresh = headlessArgs({ toolId: 'codex', adapter: codexAdapter, model: 'gpt-6.1-sol', effort: 'high', advisor: 'opus', instructions: null, prompt: 'do it', profileArgs });
  assert.deepEqual(fresh.slice(0, 8), ['exec', '--json', '--sandbox', 'danger-full-access', '-m', 'gpt-6.1-sol', '-c', 'model_reasoning_effort=high']);
  assert.equal(fresh.at(-1), 'do it');

  const resumed = headlessArgs({ toolId: 'codex', adapter: codexAdapter, model: 'gpt-6-luna', effort: 'medium', advisor: 'opus', instructions: null, resume: 'sess-1', prompt: 'go on', profileArgs });
  assert.deepEqual(resumed.slice(0, 9), ['exec', 'resume', '--json', '-m', 'gpt-6-luna', '-c', 'model_reasoning_effort=medium', '-c', 'sandbox_mode="danger-full-access"']);
  assert.deepEqual(resumed.slice(-2), ['sess-1', 'go on']);

  for (const argv of [fresh, resumed]) {
    assert.equal(argv.filter(arg => arg === '--skip-git-repo-check').length, 1,
      'headless programme planning runs from mc-owned directories outside Git');
    assert.equal(argv.includes('--effort'), false);
    assert.equal(argv.includes('--advisor'), false);
  }
  const unnamed = headlessArgs({ toolId: 'codex', adapter: codexAdapter, model: 'gpt-6.1-sol', effort: null, instructions: null, prompt: 'do it', profileArgs });
  assert.deepEqual(unnamed.slice(0, 6), ['exec', '--json', '--sandbox', 'danger-full-access', '-m', 'gpt-6.1-sol']);
  assert.equal(unnamed.some((arg) => arg.startsWith('model_reasoning_effort')), false, 'no effort named, no override');
});

test('headlessArgs: every role including plan has native delegation, fresh and resumed, stream and single-turn', () => {
  for (const name of ['build-session:goal', 'review-session:goal', 'finish-session', 'mend-session', 'plan', 'manager', 'helper', 'intake']) {
    const role = readCanonRole(name);
    assert.ok(role, name);
    for (const resume of [null, 'sid']) {
      for (const stream of [true, false]) {
        const base = { cache: role.cache, prompt: 'do it', profileArgs, resume, stream };
        const claude = headlessArgs({ ...base, toolId: 'claude-code', adapter: claudeAdapter, model: 'opus', instructions: instructionsFor('claude-code', role.overlay) });
        assert.deepEqual(claude.slice(claude.indexOf('--tools'), claude.indexOf('--tools') + 3), [
          '--tools', 'Bash,Read,Edit,Write,Grep,Glob,Agent', '--strict-mcp-config',
        ], name);
        assert.equal(claude.includes('--agents'), false, name);

        const codex = headlessArgs({ ...base, toolId: 'codex', adapter: codexAdapter, model: 'gpt-6.1-sol', instructions: instructionsFor('codex', role.overlay) });
        assert.equal(codex.filter(arg => arg === '--skip-git-repo-check').length, 1, name);
        const at = codex.indexOf('features.multi_agent=true');
        assert.ok(at > 0, name);
        assert.equal(codex[at - 1], '-c', name);
        assert.ok(at < codex.indexOf(resume || 'do it'), name);
      }
    }
  }
});

test('routedSettings: the candidate\'s tool, model and effort; the plan\'s own model and effort set aside; a step\'s explicit effort kept', () => {
  const planRunner = { tool: 'claude', model: 'opus', effort: 'low', check_in_minutes: 30, stall_minutes: 15 };
  const codex = routedSettings(planRunner, { model: 'fast' }, { candidate: { tool: 'codex', model: 'gpt-6-luna', effort: 'high' } });
  assert.deepEqual([codex.tool, codex.model, codex.effort, codex.advisor], ['codex', 'gpt-6-luna', 'high', null]);
  assert.deepEqual([codex.checkInMinutes, codex.stallMinutes], [30, 15], 'the plan\'s watch intervals still apply');
  const pinned = routedSettings(planRunner, { model: 'review', effort: 'xhigh' }, { kind: 'review', candidate: { tool: 'claude', model: 'opus', effort: 'high' } });
  assert.deepEqual([pinned.tool, pinned.model, pinned.effort], ['claude', 'opus', 'xhigh']);
});

test('sessionSettings: a sent plan\'s removed runner key changes nothing', () => {
  assert.deepEqual(sessionSettings({ subagents: 'on' }, { subagents: 'on' }), sessionSettings({}));
  assert.equal(describeSettings('claude', sessionSettings({}, { subagents: 'on' })), 'claude opus · effort medium');
});

test('readSessionOutput: claude json usage fields, dashes when absent', () => {
  const out = JSON.stringify({ subtype: 'success', num_turns: 7, session_id: 's1', usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30 } });
  const r = readSessionOutput({ toolId: 'claude-code', stdout: out, exitCode: 0 });
  assert.deepEqual(r, { turns: '7', session: 's1', input: '10', output: '20', cacheRead: '30', cacheWrite: '-', cost: null, note: 'success', quota: false, quotaReset: null });
  assert.equal(readSessionOutput({ toolId: 'claude-code', stdout: 'garbage', exitCode: 1 }).note, 'no-json');
});

test('streamSummary: a stream mc merge ended before its result still gives turns, usage, model and session', () => {
  const ev = (id, usage, model = 'claude-sonnet-5') => JSON.stringify({ type: 'assistant', session_id: 'sid-1', message: { id, model, usage } });
  const usage1 = { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 50_000, cache_creation_input_tokens: 2_000 };
  const usage2 = { input_tokens: 5, output_tokens: 50, cache_read_input_tokens: 52_000, cache_creation_input_tokens: 500 };
  const stdout = [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid-1' }),
    ev('m1', usage1), ev('m1', usage1),            // one message, two content blocks: one turn
    ev('m2', usage2),
    ev('m3', {}, '<synthetic>'),                    // claude's placeholder: not a turn
    JSON.stringify({ type: 'user', message: { role: 'user', content: [] } }),
  ].join('\n');
  const summary = streamSummary(stdout);
  assert.equal(summary.subtype, 'killed');
  assert.equal(summary.session_id, 'sid-1');
  assert.equal(summary.num_turns, 2);
  assert.deepEqual(summary.usage, { input_tokens: 15, output_tokens: 150, cache_read_input_tokens: 102_000, cache_creation_input_tokens: 2_500 });
  assert.deepEqual(Object.keys(summary.modelUsage), ['claude-sonnet-5']);
  // List price on sonnet-5 (2/10): input 15, output 150, cache read 102k at 0.1×, cache write 2.5k at 2×.
  const expected = (15 * 2 + 150 * 10 + 102_000 * 2 * 0.1 + 2_500 * 2 * 2) / 1e6;
  assert.ok(Math.abs(summary.total_cost_usd - expected) < 1e-9);
  assert.equal(streamSummary('garbage'), null);
  assert.equal(sessionResult(stdout), null, 'a summary is not a result: the session did not answer');
  // readSessionOutput keeps the note (`no-json`) and fills the row's counts from the stream.
  const read = readSessionOutput({ toolId: 'claude-code', stdout, exitCode: 143 });
  assert.equal(read.note, 'no-json');
  assert.equal(read.quota, false);
  assert.deepEqual([read.turns, read.session, read.input, read.output, read.cacheRead, read.cacheWrite], ['2', 'sid-1', '15', '150', '102000', '2500']);
  // The helper's own wall-clock cap is still a timeout; the runner's kill is a stall.
  assert.equal(readSessionOutput({ toolId: 'claude-code', stdout: '', exitCode: 142, timedOut: true }).note, 'timeout');
  assert.equal(readSessionOutput({ toolId: 'claude-code', stdout: '', exitCode: 142, timedOut: true, stalled: true }).note, 'stalled');
});

/** Ruling 40: a cache write is priced at the TTL it carried — 5m at 1.25×, 1h at 2× input. */
test('streamSummary: cache writes split by TTL are priced at 1.25× (5m) and 2× (1h)', () => {
  const ev = (id, usage) => JSON.stringify({ type: 'assistant', session_id: 's', message: { id, model: 'claude-opus-5', usage } });
  const stdout = [
    ev('m1', { cache_creation_input_tokens: 1_000, cache_creation: { ephemeral_5m_input_tokens: 1_000, ephemeral_1h_input_tokens: 0 } }),
    ev('m2', { cache_creation_input_tokens: 1_000, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1_000 } }),
  ].join('\n');
  const summary = streamSummary(stdout);
  const entry = summary.modelUsage['claude-opus-5'];
  assert.deepEqual([entry.cacheCreationInputTokens, entry.cacheWrite5mTokens, entry.cacheWrite1hTokens], [2_000, 1_000, 1_000]);
  // opus-5 input is 5 $/M: 1k at 1.25× plus 1k at 2×.
  const expected = (1_000 * 5 * 1.25 + 1_000 * 5 * 2) / 1e6;
  assert.ok(Math.abs(summary.total_cost_usd - expected) < 1e-12);
  // No split on the line: the total is the 1-hour default, 2×.
  const plain = streamSummary(ev('m3', { cache_creation_input_tokens: 1_000 }));
  assert.ok(Math.abs(plain.total_cost_usd - (1_000 * 5 * 2) / 1e6) < 1e-12);
});

/**
 * Stream-json: one event per line, the `result` line the session's answer.
 * Proven live 2026-09-11 (step-cost step 3's comments): a check-in written
 * after a result starts a new turn with its own `result`, and each carries
 * the numbers of its own turn group — so turns and usage are added up, and
 * cost and modelUsage (running totals, ruling 42) are the last one's.
 */
describe('readSessionOutput on a stream-json run', () => {
  const event = (value) => JSON.stringify(value);
  const init = event({ type: 'system', subtype: 'init', session_id: 'sid' });
  const assistant = event({ type: 'assistant', message: { content: [{ type: 'text', text: 'the result is in' }] } });
  const result = (extra = {}) => event({
    type: 'result', subtype: 'success', is_error: false, num_turns: 4, session_id: 'sid', result: 'done',
    usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 300, cache_creation_input_tokens: 40 },
    ...extra,
  });

  it('reads the result line when it is the last one', () => {
    const r = readSessionOutput({ toolId: 'claude-code', stdout: [init, assistant, result()].join('\n'), exitCode: 0 });
    assert.deepEqual(r, { turns: '4', session: 'sid', input: '10', output: '20', cacheRead: '300', cacheWrite: '40', cost: null, note: 'success', quota: false, quotaReset: null });
  });

  it('reads it with junk after it', () => {
    const r = readSessionOutput({ toolId: 'claude-code', stdout: [init, result(), 'not json', '{"type":"resu'].join('\n'), exitCode: 0 });
    assert.equal(r.note, 'success');
    assert.equal(r.turns, '4');
  });

  it('is no-json with no result line at all', () => {
    const r = readSessionOutput({ toolId: 'claude-code', stdout: [init, assistant].join('\n'), exitCode: 1 });
    assert.equal(r.note, 'no-json');
    assert.equal(sessionResult([init, assistant].join('\n')), null);
  });

  it('a zero-turn task-notification result is no answer', () => {
    const stale = result({ num_turns: 0, duration_api_ms: 0, result: '', origin: { kind: 'task-notification' } });
    assert.equal(sessionResult([init, stale, assistant].join('\n')), null);
    assert.equal(readSessionOutput({ toolId: 'claude-code', stdout: [init, stale, assistant].join('\n'), exitCode: 143 }).note, 'no-json');
    const r = sessionResult([init, stale, assistant, result()].join('\n'));
    assert.equal(r.num_turns, 4);
    assert.equal(r.result, 'done');
  });

  it('adds the turn group amounts, and takes the running totals from the last', () => {
    const first = result({
      num_turns: 30, total_cost_usd: 1.5, duration_ms: 1000, duration_api_ms: 800, session_id: 'sid',
      modelUsage: { sonnet: { inputTokens: 5, outputTokens: 7, contextWindow: 200000 } },
    });
    const second = result({
      num_turns: 2, total_cost_usd: 1.75, duration_ms: 200, duration_api_ms: 900, session_id: 'sid', subtype: 'error_during_execution', is_error: true, result: 'blocked',
      usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 },
      modelUsage: { sonnet: { inputTokens: 6, outputTokens: 8, contextWindow: 200000 }, opus: { inputTokens: 9, outputTokens: 9 } },
    });
    const stdout = [init, first, assistant, second].join('\n');
    const summed = sessionResult(stdout);
    assert.equal(summed.num_turns, 32);
    assert.equal(summed.total_cost_usd, 1.75);
    assert.equal(summed.duration_ms, 1200);
    assert.equal(summed.duration_api_ms, 900);
    assert.deepEqual(summed.usage, { input_tokens: 11, output_tokens: 22, cache_read_input_tokens: 303, cache_creation_input_tokens: 44 });
    assert.deepEqual(summed.modelUsage, { sonnet: { inputTokens: 6, outputTokens: 8, contextWindow: 200000 }, opus: { inputTokens: 9, outputTokens: 9 } });
    assert.equal(summed.session_id, 'sid');
    assert.equal(summed.subtype, 'error_during_execution');
    assert.equal(summed.result, 'blocked');
    const r = readSessionOutput({ toolId: 'claude-code', stdout, exitCode: 0 });
    // The cost is claude's own running total, the last result line's.
    assert.deepEqual(r, { turns: '32', session: 'sid', input: '11', output: '22', cacheRead: '303', cacheWrite: '44', cost: 1.75, note: 'failed', quota: false, quotaReset: null });
  });

  it('keeps the quota rule: a short limit answer is quota', () => {
    const limit = result({ num_turns: 1, result: "You've hit your weekly limit · resets Aug 28 at 3pm" });
    assert.equal(readSessionOutput({ toolId: 'claude-code', stdout: [init, limit].join('\n'), exitCode: 1 }).note, 'quota');
  });

  // 2026-10-07: six 30-minute pauses in a day, each a killed session (rc=143,
  // no result line) whose own work said "rate limiting" while every
  // rate_limit_event in its stream said allowed.
  it('a killed session is quota only when its stream says the API refused', () => {
    const rate = (status, resetsAt = 1791409800) => event({ type: 'rate_limit_event', rate_limit_info: { status, resetsAt, rateLimitType: 'five_hour' } });
    const prose = event({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'Rate limiting and abuse controls — quota rows, usage limit text' }] } });
    const allowed = readSessionOutput({ toolId: 'claude-code', stdout: [init, rate('allowed'), assistant, prose].join('\n'), exitCode: 143 });
    assert.equal(allowed.note, 'no-json');
    assert.equal(allowed.quota, false);
    const refused = readSessionOutput({ toolId: 'claude-code', stdout: [init, rate('allowed'), assistant, rate('rejected')].join('\n'), exitCode: 1 });
    assert.equal(refused.note, 'quota');
    assert.equal(refused.quota, true);
    assert.equal(refused.quotaReset.toISOString(), '2026-10-07T21:50:00.000Z');
    // A refusal answered by a later allowed event is over.
    assert.equal(readSessionOutput({ toolId: 'claude-code', stdout: [init, rate('rejected'), rate('allowed_warning')].join('\n'), exitCode: 143 }).quota, false);
    assert.equal(streamRateLimit('garbage'), null);
  });
});

test('quietPrompt: names the silence, each background task, and what follows no answer', () => {
  const text = quietPrompt({ minutes: 20, tasks: [{ task_id: 'b4swqbpox', task_type: 'local_bash', description: 'node scripts/msr-legacy-projection-compare.mjs' }] });
  assert.match(text, /written nothing for 20 minutes/u);
  assert.match(text, /- b4swqbpox: node scripts\/msr-legacy-projection-compare\.mjs/u);
  assert.match(text, /for another 20 minutes is killed/u);
});

test('readSessionOutput: a quota answer is logged as quota, never success', () => {
  const out = JSON.stringify({ subtype: 'success', num_turns: 1, result: "You've hit your weekly limit · resets Aug 28 at 3pm" });
  const r = readSessionOutput({ toolId: 'claude-code', stdout: out, exitCode: 1 });
  assert.equal(r.note, 'quota');
  assert.equal(r.quota, true);
  assert.equal(quotaSeen('Rate limit reached'), true);
  assert.equal(quotaSeen('all good'), false);
  // is_error is a failure whatever the subtype says (2026-08-29: "API Error:
  // No response from API" after 83 turns came back subtype success).
  const err = JSON.stringify({ subtype: 'success', is_error: true, num_turns: 83, result: 'API Error: No response from API' });
  assert.equal(readSessionOutput({ toolId: 'claude-code', stdout: err, exitCode: 1 }).note, 'failed');
  // A finished session whose prose mentions quota is success, not quota.
  const done = JSON.stringify({ subtype: 'success', num_turns: 39, result: 'PR open: the page shows quota rows of the last 24 h' });
  const d = readSessionOutput({ toolId: 'claude-code', stdout: done, exitCode: 0 });
  assert.equal(d.note, 'success');
  assert.equal(d.quota, false);
});

test('readSessionOutput: codex events give what they give', () => {
  const lines = [JSON.stringify({ type: 'thread.started', thread_id: 't9' }), 'not json', JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 5, cached_input_tokens: 2, output_tokens: 3 } })].join('\n');
  const r = readSessionOutput({ toolId: 'codex', stdout: lines, exitCode: 0 });
  assert.deepEqual(r, { turns: '-', session: 't9', input: '5', output: '3', cacheRead: '2', cacheWrite: '-', cost: null, note: 'success', quota: false, quotaReset: null });
  // With its model, a codex session is priced on its totals: 3 uncached and 2 cached input, 3 output.
  const priced = readSessionOutput({ toolId: 'codex', stdout: lines, exitCode: 0, model: 'gpt-6.1-sol' });
  assert.equal(priced.cost, (3 * 2 + 2 * 0.1 + 3 * 10) / 1e6);
});

/** Haiku 5.5 lists a 5× tier for a request whose prompt is over 100k tokens; only a request can cross it. */
test('streamSummary prices each message on its own, so a long prompt is tiered and a short one is not', () => {
  const ev = (id, usage) => JSON.stringify({ type: 'assistant', session_id: 's', message: { id, model: 'claude-haiku-5-5', usage } });
  const stdout = [ev('m1', { input_tokens: 50_000, output_tokens: 1_000 }), ev('m2', { input_tokens: 10, cache_read_input_tokens: 150_000, output_tokens: 1_000 })].join('\n');
  // m1 at 0.1/0.5; m2 over 100k at 0.5/2.5 with its cache read at 0.1× of 0.5.
  const expected = (50_000 * 0.1 + 1_000 * 0.5) / 1e6 + (10 * 0.5 + 150_000 * 0.05 + 1_000 * 2.5) / 1e6;
  assert.ok(Math.abs(streamSummary(stdout).total_cost_usd - expected) < 1e-12);
  assert.ok(Math.abs(readSessionOutput({ toolId: 'claude-code', stdout, exitCode: 143 }).cost - expected) < 1e-12);
});

test('readSessionOutput: a codex crash whose work mentions quota is a failure, a refusal event is quota', () => {
  const work = JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', aggregated_output: 'Keep pause, quota, external waits and planned stops explicit.' } });
  const crashed = readSessionOutput({ toolId: 'codex', stdout: work, stderr: "thread 'codex-main' panicked: failed printing to stdout: Resource temporarily unavailable (os error 35)", exitCode: 101 });
  assert.equal(crashed.note, 'failed');
  assert.equal(crashed.quota, false);
  const refused = [work, JSON.stringify({ type: 'turn.failed', error: { message: 'You’ve hit your usage limit. Try again at Nov 4th, 2026 7:35 AM.' } })].join('\n');
  const limit = readSessionOutput({ toolId: 'codex', stdout: refused, exitCode: 1 });
  assert.equal(limit.note, 'quota');
  assert.equal(limit.quota, true);
});

/**
 * The shell runner's thirteen, and `land_seconds` appended after them: the
 * gate costs 20–35 minutes on memoro where the old `gh pr merge` cost
 * seconds, and a reader of runs.tsv can only see where a night went if the
 * session's time and the landing's are not added up into one cell. Appended
 * and not inserted beside `seconds`, because the header is written once, when
 * the file is created, and the one on this machine still carries thirteen.
 */
test('tsvRow has the shell runner\'s thirteen columns in order, then the landing\'s own time, the model, and the cost', () => {
  assert.equal(tsvHeader(), 'ts\tname\tkind\texit\tseconds\tpr\tturns\tinput\toutput\tcache_read\tcache_write\tsession\tnote\tland_seconds\tmodel\tclass\ttool\teffort\tbilling\tcost');
  const row = tsvRow({ ts: 'T', name: 'n', kind: 'step', exit: 0, seconds: 9, pr: '12', turns: '3', input: '1', output: '2', cacheRead: '3', cacheWrite: '4', session: 's', note: 'success,merged', landSeconds: 1830, model: 'sonnet' });
  assert.equal(row.split('\t').length, 20);
  assert.equal(row, 'T\tn\tstep\t0\t9\t12\t3\t1\t2\t3\t4\ts\tsuccess,merged\t1830\tsonnet\t-\t-\t-\t-\t-');
  assert.equal(tsvRow({ ts: 'T', note: 'a\tb' }).split('\t').length, 20);
  assert.match(tsvRow({ ts: 'T', note: 'timeout' }), /\ttimeout\t-\t-\t-\t-\t-\t-\t-$/u, 'a step that never reached a landing says so, and a row with no model a dash');
  assert.match(tsvRow({ ts: 'T', cost: 1.234567 }), /\t1\.2346$/u, 'the session\'s cost, to a hundredth of a cent');
});

const wait = (checkInMinutes = 60, stallMinutes = 20) => ({ checkInMinutes, stallMinutes });

test('sessionSettings: tool, check_in_minutes and stall_minutes from the plan, with the runner defaults', () => {
  assert.equal(sessionSettings({}).tool, 'claude');
  assert.equal(DEFAULT_CHECK_IN_MINUTES, 60);
  assert.equal(DEFAULT_STALL_MINUTES, 20);
  assert.equal(sessionSettings({}).checkInMinutes, 60);
  assert.equal(sessionSettings({}).stallMinutes, 20);
  assert.deepEqual(sessionSettings({ tool: 'codex', model: 'o3', check_in_minutes: 30, stall_minutes: '15' }), { ...wait(30, 15), tool: 'codex', model: 'o3', effort: null, advisor: null });
  assert.equal(sessionSettings({ check_in_minutes: 'lots' }).checkInMinutes, 60);
  // A step cannot set them: they are the plan's, like the tool.
  assert.equal(sessionSettings({}, { check_in_minutes: 5 }).checkInMinutes, 60);
  assert.equal('budgetMinutes' in sessionSettings({ budget_minutes: 30 }), false, 'the budget is gone (ruling 18)');
  assert.equal(describeWatch('claude-code', sessionSettings({})), 'check-in every 60 min, killed after 20 min silent');
  assert.equal(describeWatch('codex', sessionSettings({ tool: 'codex' })), 'no check-in, no stall guard');
});

/**
 * Ruling 18 (2026-09-11) put a step on sonnet at medium with opus as its
 * advisor; its second addendum (2026-09-25) put it on opus at medium with no
 * advisor. Each key resolves step over plan over default on its own, so a
 * step naming only its effort keeps the plan's model.
 */
test('sessionSettings: the step defaults, plan and step overrides, advisor off, codex getting none', () => {
  assert.deepEqual(SESSION_DEFAULTS, { step: { model: 'opus', effort: 'medium', advisor: null }, review: { model: 'opus', effort: 'high', advisor: null } }, 'two kinds: the repair is gone (ruling 21), and the review has its own');
  assert.deepEqual(sessionSettings({}), { tool: 'claude', model: 'opus', effort: 'medium', advisor: null, ...wait() });
  // Since 2026-09-25 the default names no advisor, so a plan back on sonnet
  // gets one only by naming it.
  assert.equal(sessionSettings({ model: 'sonnet' }).advisor, null);
  assert.equal(sessionSettings({ model: 'sonnet', advisor: 'opus' }).advisor, 'opus');

  // The plan overrides the default key by key. An advisor that is the model
  // itself is no advisor (Martin, 2026-09-12: "Om step har opus => advisor = null, inte
  // opus+opus.").
  assert.deepEqual(sessionSettings({ model: 'opus' }), { tool: 'claude', model: 'opus', effort: 'medium', advisor: null, ...wait() });
  assert.deepEqual(sessionSettings({ model: 'opus', advisor: 'sonnet' }).advisor, 'sonnet');

  // The step overrides the plan, again key by key.
  const plan = { model: 'opus', effort: 'low', advisor: 'opus' };
  assert.deepEqual(sessionSettings(plan, { effort: 'xhigh' }), { tool: 'claude', model: 'opus', effort: 'xhigh', advisor: null, ...wait() });
  assert.deepEqual(sessionSettings(plan, { model: 'haiku', effort: null }), { tool: 'claude', model: 'haiku', effort: 'low', advisor: 'opus', ...wait() });
  assert.deepEqual(sessionSettings({}, { model: 'opus' }).advisor, null, 'a step on opus gets no opus advisor');

  // `off` at any level is no advisor, and a step can turn off the plan's.
  assert.equal(sessionSettings({ advisor: 'off' }).advisor, null);
  assert.equal(sessionSettings({}, { advisor: 'off' }).advisor, null);
  assert.equal(sessionSettings({ advisor: 'off' }, { advisor: 'fable' }).advisor, 'fable');

  // `opus` is claude's: codex gets no model it did not name, and no advisor
  // even when one is named. Effort is the plan's word on either tool.
  assert.deepEqual(sessionSettings({ tool: 'codex' }), { tool: 'codex', model: null, effort: null, advisor: null, ...wait() });
  assert.deepEqual(sessionSettings({ tool: 'codex', effort: 'high', advisor: 'opus' }, { model: 'o3' }), { tool: 'codex', model: 'o3', effort: 'high', advisor: null, ...wait() });
  assert.deepEqual(sessionSettings({ tool: 'codex' }, { model: 'gpt-6-luna', effort: 'medium' }), { tool: 'codex', model: 'gpt-6-luna', effort: 'medium', advisor: null, ...wait() });
  assert.equal(sessionSettings({ tool: 'codex' }, { model: 'gpt-6.1-sol' }).effort, null, 'no effort named, none passed');
});

test('describeSettings: what the starting line says a session runs on', () => {
  assert.equal(describeSettings('claude', sessionSettings({})), 'claude opus · effort medium');
  assert.equal(describeSettings('claude', sessionSettings({ model: 'sonnet', advisor: 'opus' })), 'claude sonnet · effort medium · advisor opus');
  assert.equal(describeSettings('claude', sessionSettings({ model: 'opus' })), 'claude opus · effort medium', 'an opus plan gets no opus advisor');
  assert.equal(describeSettings('codex', sessionSettings({ tool: 'codex' })), 'codex own default model');
});

test('parseRunArgs: defaults, flags, errors', () => {
  // `awake` defaults to true: a runner waits ten minutes between rounds and
  // this laptop sleeps after one of them on battery, so the default that keeps
  // an unattended run alive is the one nobody has to remember (stay-awake.js).
  assert.deepEqual(parseRunArgs([]), { once: false, merge: true, idleSleep: 600, awake: true, verb: 'run' });
  assert.deepEqual(parseRunArgs(['--once', '--no-merge', '--idle-sleep', '5']), { once: true, merge: false, idleSleep: 5, awake: true, verb: 'run' });
  assert.equal(parseRunArgs(['--no-caffeinate']).awake, false);
  assert.match(parseRunArgs(['--idle-sleep', 'x']).error, /whole number of seconds/u);
  assert.match(parseRunArgs(['--idle-sleep']).error, /needs a value/u);
  assert.match(parseRunArgs(['extra']).error, /unexpected argument/u);
});

/**
 * `--rounds N` went with the round on 2026-09-08: a lane takes the next step
 * and picks again, so there is no pass over the queue to count. It is answered
 * by name — the form `mc-cut` gave a retired verb — rather than as an
 * unexpected argument, because the flag was in somebody's muscle memory and in
 * every `mc run start` line ever written down.
 */
test('parseRunArgs: --rounds is retired, and says what to type instead', () => {
  for (const argv of [['--rounds', '3'], ['--rounds=3'], ['--rounds'], ['start', '--rounds', '3']]) {
    assert.match(parseRunArgs(argv).error, /a round no longer exists/u, argv.join(' '));
    assert.match(parseRunArgs(argv).error, /`mc run --once` takes one/u, argv.join(' '));
  }
});

test('parseRunArgs: the three orders, and the flags start carries through', () => {
  assert.deepEqual(parseRunArgs(['stop']), { verb: 'stop', force: false });
  assert.deepEqual(parseRunArgs(['stop', '--force']), { verb: 'stop', force: true });
  assert.deepEqual(parseRunArgs(['--update']), { verb: 'update', force: false });
  assert.deepEqual(parseRunArgs(['--update', '--force']), { verb: 'update', force: true });
  // The word form the page's menu takes, from the shell too.
  assert.deepEqual(parseRunArgs(['update']), { verb: 'update', force: false });
  assert.deepEqual(parseRunArgs(['update', '--force']), { verb: 'update', force: true });

  // `start` is the run, in the background: its flags are parsed here so a typo
  // is answered at the terminal rather than in a log nobody is watching, and
  // passed on untouched because the background runner is the same runner.
  const start = parseRunArgs(['start', '--no-merge', '--idle-sleep', '30']);
  assert.equal(start.verb, 'start');
  assert.equal(start.merge, false);
  assert.equal(start.idleSleep, 30);
  assert.deepEqual(start.pass, ['--no-merge', '--idle-sleep', '30']);
  assert.match(parseRunArgs(['start', '--idle-sleep', 'x']).error, /whole number of seconds/u);

  // An order to a runner that is already up takes nothing else: every flag it
  // could take is a property that runner already has.
  assert.match(parseRunArgs(['--update', '--idle-sleep', '2']).error, /one order on its own/u);
  assert.match(parseRunArgs(['stop', 'now']).error, /unexpected argument/u);
});

/* ------------------------------------------------------------- the helper */

const RUNS = (...rows) => [tsvHeader(), ...rows].join('\n');
const helperRow = (ts, note = 'success,0-proposals') => tsvRow({
  ts, name: 'helper', kind: 'helper', exit: 0, seconds: 120, pr: '-', note,
});

test('helperDue: not before 05:00Z, and only once per UTC day', () => {
  assert.deepEqual(helperDue({ now: new Date('2026-08-29T04:59:59Z') }), { due: false, why: 'not before 05:00Z' });
  assert.equal(helperDue({ now: new Date('2026-08-29T05:00:00Z') }).due, true);

  const today = RUNS(helperRow('2026-08-29T05:01:00Z'));
  assert.equal(helperDue({ tsv: today, now: new Date('2026-08-29T23:00:00Z') }).due, false);
  assert.match(helperDue({ tsv: today, now: new Date('2026-08-29T23:00:00Z') }).why, /already ran today/u);
  assert.equal(helperDue({ tsv: today, now: new Date('2026-08-30T05:00:00Z') }).due, true, 'a new UTC day is a new run');
});

/**
 * The nightly's cadence is a day since the last tick's row — not a clock hour —
 * and the row is the only state. Only a `nightly` row counts.
 */
test('nightlyDue: never ticked is due, a day after the last is due, sooner is not', () => {
  const nightly = (ts) => tsvRow({ ts, name: 'nightly', kind: 'nightly', exit: 0, seconds: 900, pr: '-', note: 'success,2-measured,0-unchanged' });
  const now = new Date('2026-08-29T10:00:00Z');
  assert.deepEqual(nightlyDue({ now }), { due: true, why: null });
  assert.deepEqual(nightlyDue({ tsv: RUNS(helperRow('2026-08-29T05:01:00Z')), now }), { due: true, why: null }, 'a helper row is not a tick');

  const old = nightlyDue({ tsv: RUNS(nightly('2026-08-28T09:00:00Z')), now });
  assert.equal(old.due, true);
  assert.match(old.why, /the last tick was 25 h ago \(2026-08-28T09:00:00\.000Z\)/u);

  const recent = nightlyDue({ tsv: RUNS(nightly('2026-08-29T08:00:00Z')), now });
  assert.equal(recent.due, false);
  assert.match(recent.why, /2 h ago.*the next is due in 22 h/u);

  assert.equal(nightlyDue({ tsv: RUNS(nightly('2026-08-28T10:00:00Z')), now }).due, true, 'exactly 24 h is due');
  assert.equal(nightlyDue({ tsv: RUNS(nightly('2026-08-28T10:00:01Z')), now }).due, false);
});

test('nightlyDue: the latest row counts, and an unparseable ts is ignored', () => {
  const nightly = (ts) => tsvRow({ ts, name: 'nightly', kind: 'nightly', exit: 0, seconds: 1, pr: '-', note: 'success' });
  const now = new Date('2026-08-29T10:00:00Z');
  assert.equal(nightlyDue({ tsv: RUNS(nightly('2026-08-01T00:00:00Z'), nightly('2026-08-29T09:00:00Z')), now }).due, false);
  assert.equal(nightlyDue({ tsv: RUNS(nightly('not-a-time')), now }).due, true);
});

/**
 * The row is the state, and it is written whether the run worked or not:
 * that is the whole of "a failed collect is logged and never retried within
 * the day". A step row for a project called something else must not count.
 */
test('helperDue: a failed run still closes the day, and only a helper row counts', () => {
  const failed = RUNS(helperRow('2026-08-29T05:01:00Z', 'collect-failed'));
  assert.equal(helperDue({ tsv: failed, now: new Date('2026-08-29T12:00:00Z') }).due, false);

  const steps = RUNS(tsvRow({ ts: '2026-08-29T06:00:00Z', name: 'mc-helper', kind: 'step', exit: 0, seconds: 1, pr: '-', note: 'success,merged' }));
  assert.equal(helperDue({ tsv: steps, now: new Date('2026-08-29T12:00:00Z') }).due, true);
});

/**
 * Both notes put the outcome first, because `summariseRuns` reads a note that
 * does not start with `success` as a failure — and every helper row written
 * before 2026-09-05 read `memoro,success,0-proposals`, which it counted as one.
 */
test('collectNote and intakeNote keep the success, shape every other row uses', () => {
  const digest = (delta) => ({ data: { delta } });
  assert.equal(collectNote({ repo: 'memoro', digest: null }), 'collect-failed,memoro');
  assert.equal(collectNote({ repo: 'memoro', digest: digest({ first: true }) }), 'success,memoro,first-digest');
  assert.equal(collectNote({ repo: 'memoro-cli', digest: digest({ first: false, fingerprints: [1, 2] }) }), 'success,memoro-cli,2-new');

  assert.equal(intakeNote(null), 'turn-missing');
  assert.equal(intakeNote({ ok: true, wrote: [] }), 'success,0-proposals');
  assert.equal(intakeNote({ ok: true, wrote: [1, 2, 3] }), 'success,3-proposals');
  assert.equal(intakeNote({ ok: false, reason: 'no-role' }), 'no-role');
  assert.equal(intakeNote({ ok: false, note: 'timeout' }), 'timeout');
});

/**
 * The order the inbox drains in. By the date the name carries and not by the
 * name itself: the collector's two generations of filename sort wrongly against
 * each other as strings, which would put every memoro digest ahead of every
 * memoro-cli one whatever day either was written.
 */
test('intakeQueue is oldest first by the date in the name, with dateless names last', () => {
  assert.deepEqual(intakeQueue([
    'errors-memoro-cli-2026-08-31.md',
    'screenshot.png',
    'errors-memoro-2026-09-04.md',
    '.DS_Store',
    'errors-2026-08-29.md',
    'note.md',
  ]), [
    'errors-2026-08-29.md',
    'errors-memoro-cli-2026-08-31.md',
    'errors-memoro-2026-09-04.md',
    // No date in the name, so under its own name, after everything dated.
    'note.md',
    'screenshot.png',
  ]);
  assert.deepEqual(intakeQueue([]), []);
  assert.deepEqual(intakeQueue(['.hidden']), [], 'a dotfile is not an inbox item');
});

/**
 * Which refusals block a step on `main` and which the lane waits out — the
 * distinction ruling 17 turns on, held as a list rather than as a habit.
 *
 * The blocking ones are facts a person has to act on: nothing the runner does
 * next changes them, so meeting one again in ten minutes is the failure this
 * project exists to end. The rest are about this moment — the network, the
 * quota, a pull request somebody is still working on — and there the lane
 * waits and asks the same question again.
 */
test('landingNote: a merge that did not land on main is not recorded as merged', () => {
  assert.equal(landingNote({ merged: true, merged_into: 'main', default_branch: 'main' }), 'merged');
  assert.equal(landingNote({ merged: true, merged_into: 'msr-track-3', default_branch: 'main', off_default: true }), 'off-main');
  assert.equal(landingNote({ merged: false, stopped_at: 'red' }), 'open,gate-red');
  assert.equal(landingNote(null), 'open');
});

describe('quotaResetAt', () => {
  const logged = "You've hit your weekly limit · resets Sep 11 at 3pm (Europe/Stockholm)";
  const iso = (d) => (d ? d.toISOString() : d);

  it('reads the logged refusal as an instant', () => {
    assert.equal(iso(quotaResetAt(logged, new Date('2026-09-08T09:05:00Z'))), '2026-09-11T13:00:00.000Z');
  });

  it('a time with no date is today in the zone, or tomorrow when it has passed', () => {
    const text = "You've hit your limit · resets 3pm (Europe/Stockholm)";
    assert.equal(iso(quotaResetAt(text, new Date('2026-09-08T09:05:00Z'))), '2026-09-08T13:00:00.000Z');
    assert.equal(iso(quotaResetAt(text, new Date('2026-09-08T14:00:00Z'))), '2026-09-09T13:00:00.000Z');
  });

  it('a date that has passed is next year, and minutes and winter offsets are read', () => {
    assert.equal(iso(quotaResetAt('resets Jan 2 at 9:30am (America/New_York)', new Date('2026-12-30T12:00:00Z'))), '2027-01-02T14:30:00.000Z');
  });

  it('is null for text it cannot read, an unknown zone, and a time more than eight days out', () => {
    const now = new Date('2026-09-08T09:05:00Z');
    assert.equal(quotaResetAt('You have hit the limit', now), null);
    assert.equal(quotaResetAt('resets Sep 11 at 3pm (Mars/Olympus)', now), null);
    assert.equal(quotaResetAt('resets Sep 30 at 3pm (Europe/Stockholm)', now), null);
    assert.equal(quotaResetAt('resets Foo 11 at 3pm (Europe/Stockholm)', now), null);
    assert.equal(quotaResetAt('resets 13pm', now), null);
  });

  it('readSessionOutput carries it for a quota answer and null for anything else', () => {
    const now = new Date('2026-09-08T09:05:00Z');
    const stdout = JSON.stringify({ subtype: 'success', num_turns: 1, result: logged });
    assert.equal(iso(readSessionOutput({ toolId: 'claude', stdout, exitCode: 1, now }).quotaReset), '2026-09-11T13:00:00.000Z');
    const fine = JSON.stringify({ subtype: 'success', num_turns: 9, result: logged });
    assert.equal(readSessionOutput({ toolId: 'claude', stdout: fine, exitCode: 0, now }).quotaReset, null);
  });
});

/**
 * The four refusals the API ended step sessions with, 2026-09-13..25, as
 * claude wrote them: `subtype: "success"`, `is_error`, and
 * `terminal_reason: "api_error"` — after 44 to 293 turns of work.
 */
const apiEnded = (result, extra = {}) => ({ type: 'result', subtype: 'success', is_error: true, num_turns: 286, session_id: 'sid', terminal_reason: 'api_error', result, usage: {}, ...extra });

test('apiInterruption: a limit is quota, a lost login is login, a 5xx is server, a step\'s own end is none', () => {
  assert.deepEqual(apiInterruption(apiEnded("You've hit your monthly spend limit · raise it at claude.ai/settings/usage", { api_error_status: 429 })),
    { kind: 'quota', said: "You've hit your monthly spend limit · raise it at claude.ai/settings/usage" });
  assert.equal(apiInterruption(apiEnded("API Error: This request would exceed your account's rate limit. Please try again later.", { api_error_status: 429 })).kind, 'quota');
  assert.equal(apiInterruption(apiEnded('Not logged in · Please run /login', { api_error_status: null })).kind, 'login');
  assert.equal(apiInterruption(apiEnded('API Error: 529 Overloaded. This is a server-side issue, usually temporary', { api_error_status: 529 })).kind, 'server');
  assert.equal(apiInterruption(apiEnded('API Error: 500 Internal server error.', { api_error_status: 500 })).kind, 'server');
  assert.equal(apiInterruption({ type: 'result', subtype: 'success', is_error: false, result: 'Step 3 is blocked on a decision.' }), null);
  assert.equal(apiInterruption({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in' }), null, 'no terminal_reason, no reading');
  assert.equal(apiInterruption(null), null);
});

test('apiInterruption: a server that cannot be reached is offline, marked or not; a limit still wins, and a 5xx stays server', () => {
  // The result of 2026-11-06 (runner/log/goal-surfaces-popover-behaviour-20261106T211246Z.json), after ten retries.
  const unreachable = "API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)";
  assert.deepEqual(apiInterruption(apiEnded(unreachable, { api_error: 'connection_failed', api_error_status: null, num_turns: 1 })), { kind: 'offline', said: unreachable });
  assert.equal(apiInterruption(apiEnded(unreachable, { api_error_status: null })).kind, 'offline', 'the same words without the connection_failed mark');
  assert.equal(apiInterruption(apiEnded('API Error: connect ETIMEDOUT 160.79.104.10:443', { api_error_status: null })).kind, 'offline');
  assert.equal(apiInterruption(apiEnded('API Error: connect ECONNREFUSED 127.0.0.1:443', { api_error_status: null })).kind, 'offline');
  assert.equal(apiInterruption(apiEnded("You've hit your 5-hour limit · resets 3pm (UTC)", { api_error: 'connection_failed', api_error_status: 429 })).kind, 'quota', 'a limit is read before the connection');
  assert.equal(apiInterruption(apiEnded('API Error: 500 Internal server error.', { api_error_status: 500 })).kind, 'server');
});

test('apiInterruption: an exhausted credit is credits and a rejected key is key, before the quota test', () => {
  const low = 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.';
  assert.deepEqual(apiInterruption(apiEnded(low, { api_error_status: 400 })), { kind: 'credits', said: low });
  assert.deepEqual(apiInterruption(apiEnded(low, { api_error_status: 429 })), { kind: 'credits', said: low }, 'before the 429 test');
  assert.deepEqual(apiInterruption(apiEnded('Invalid API key · Fix external API key', { api_error_status: null })), { kind: 'key', said: 'Invalid API key · Fix external API key' });
  assert.equal(apiInterruption(apiEnded("You've hit your weekly limit · resets Sep 25 at 3pm", { api_error_status: 429 })).kind, 'quota');
  const read = readSessionOutput({ toolId: 'claude-code', stdout: JSON.stringify(apiEnded(low)), exitCode: 1 });
  assert.equal(read.interrupted, 'credits');
  assert.equal(read.note, 'interrupted');
  assert.equal(read.quota, false);
  assert.equal(readSessionOutput({ toolId: 'claude-code', stdout: JSON.stringify(apiEnded('Invalid API key · Fix external API key')), exitCode: 1 }).note, 'interrupted');
});

test('apiInterruption: a spent workspace limit is credits until the date it names, not quota', () => {
  const limit = 'API Error: 400 You have reached your specified workspace API usage limits. You will regain access on 2026-11-01 at 00:00 UTC.';
  assert.deepEqual(apiInterruption(apiEnded(limit, { api_error_status: 400 })), { kind: 'credits', said: limit, until: new Date('2026-11-01T00:00:00.000Z') });
  const short = readSessionOutput({ toolId: 'claude-code', stdout: JSON.stringify(apiEnded(limit, { num_turns: 1 })), exitCode: 1 });
  assert.equal(short.interrupted, 'credits');
  assert.equal(short.note, 'interrupted');
  assert.equal(short.quota, false, 'a session of one turn is not a quota either');
  assert.equal(short.creditsUntil.toISOString(), '2026-11-01T00:00:00.000Z');
  assert.equal(readSessionOutput({ toolId: 'claude-code', stdout: JSON.stringify(apiEnded('Your credit balance is too low to access the Anthropic API.', { api_error_status: 400 })), exitCode: 1 }).creditsUntil, null);
});

test('creditsResetAt reads the instant a workspace limit names, 00:00 UTC without a time, and nothing else', () => {
  assert.deepEqual(creditsResetAt('You will regain access on 2026-11-01 at 00:00 UTC.'), new Date('2026-11-01T00:00:00.000Z'));
  assert.deepEqual(creditsResetAt('You will regain access on 2026-11-03 at 09:30 UTC.'), new Date('2026-11-03T09:30:00.000Z'));
  assert.deepEqual(creditsResetAt('You will regain access on 2026-11-01.'), new Date('2026-11-01T00:00:00.000Z'));
  assert.equal(creditsResetAt("You've hit your weekly limit · resets Sep 25 at 3pm"), null);
  assert.equal(creditsResetAt('You will regain access on 2026-02-30 at 00:00 UTC.'), null);
  assert.equal(creditsResetAt('You will regain access on 2026-11-01 at 25:00 UTC.'), null);
  assert.equal(creditsResetAt(null), null);
});

test('readSessionOutput: a long session the API ended is interrupted, and a limit is quota whatever the turn count', () => {
  const login = readSessionOutput({ toolId: 'claude-code', stdout: JSON.stringify(apiEnded('Not logged in · Please run /login')), exitCode: 0 });
  assert.equal(login.note, 'interrupted');
  assert.equal(login.interrupted, 'login');
  assert.equal(login.said, 'Not logged in · Please run /login');
  assert.equal(login.quota, false);
  const limit = readSessionOutput({ toolId: 'claude-code', stdout: JSON.stringify(apiEnded("You've hit your monthly spend limit · your weekly limit resets Sep 25 at 3pm (Europe/Stockholm)", { api_error_status: 429 })), exitCode: 0, now: new Date('2026-09-22T07:00:00Z') });
  assert.equal(limit.note, 'quota');
  assert.equal(limit.interrupted, 'quota');
  assert.equal(limit.quota, true, '286 turns in, still a limit — not the session\'s own word');
  assert.ok(limit.quotaReset instanceof Date);
  const own = readSessionOutput({ toolId: 'claude-code', stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 40, session_id: 'sid', result: 'done', usage: {} }), exitCode: 0 });
  assert.equal(own.interrupted, undefined);
  assert.equal(own.note, 'success');
});

test('headlessArgs: a resumed claude session is -p --resume <id>, the rest unchanged', () => {
  const adapter = { modelArgs: (m) => ['--model', m] };
  const fresh = headlessArgs({ toolId: 'claude-code', adapter, model: 'opus', instructions: null, prompt: 'do it', profileArgs });
  const resumed = headlessArgs({ toolId: 'claude-code', adapter, model: 'opus', instructions: null, prompt: 'go on', profileArgs, resume: 'sid' });
  assert.deepEqual(resumed, ['-p', '--resume', 'sid', ...fresh.slice(1)]);
});

test('headlessArgs: a codex resume is `exec resume` with the sandbox through -c and the id before the prompt', () => {
  const args = headlessArgs({ toolId: 'codex', adapter: { modelArgs: (m) => ['-m', m] }, model: 'o3', instructions: 'INSTRUCTIONS', prompt: 'go on', profileArgs, resume: 'thread-1' });
  assert.deepEqual(args.slice(0, 6), ['exec', 'resume', '--json', '-m', 'o3', '-c']);
  assert.equal(args[6], 'sandbox_mode="danger-full-access"');
  assert.equal(args.includes('--sandbox'), false);
  assert.deepEqual(args.slice(-2), ['thread-1', 'go on']);
  const claude = headlessArgs({ toolId: 'claude-code', adapter: { modelArgs: (m) => ['--model', m] }, model: 'opus', instructions: null, prompt: 'go on', profileArgs, resume: 'sid' });
  assert.deepEqual(claude.slice(0, 3), ['-p', '--resume', 'sid']);
});

test('headlessArgs: every launch carries the session switches, new and resumed, with the role TTL', () => {
  const settingsEnv = (args) => {
    const at = args.indexOf('--settings');
    assert.ok(at >= 0, 'expected --settings');
    return JSON.parse(args[at + 1]).env;
  };
  const switches = (cache) => ({
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    CLAUDE_CODE_PROMPT_CACHE_TTL: cache,
    CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: cache,
  });
  const claude = { toolId: 'claude-code', adapter: claudeAdapter, model: 'opus', instructions: 'INSTRUCTIONS', prompt: 'do it', profileArgs };
  assert.deepEqual(settingsEnv(headlessArgs({ ...claude, cache: '5m' })), switches('5m'));
  assert.deepEqual(settingsEnv(headlessArgs({ ...claude, cache: '5m', resume: 'sid' })), switches('5m'));
  assert.deepEqual(settingsEnv(headlessArgs(claude)), switches('1h'));
  assert.deepEqual(settingsEnv(headlessArgs({ ...claude, resume: 'sid' })), switches('1h'));

  const codex = { toolId: 'codex', adapter: codexAdapter, model: 'o3', instructions: 'INSTRUCTIONS', prompt: 'do it', profileArgs, cache: '5m' };
  for (const args of [headlessArgs(codex), headlessArgs({ ...codex, resume: 'thread-1' })]) {
    const at = args.indexOf('project_doc_max_bytes=0');
    assert.ok(at > 0, 'expected -c project_doc_max_bytes=0');
    assert.equal(args[at - 1], '-c');
    assert.ok(at < args.indexOf('do it'), 'before the prompt');
    if (args.includes('thread-1')) assert.ok(at < args.indexOf('thread-1'), 'before the session id');
    assert.equal(args.includes('--settings'), false);
  }
});

test('cacheTtlMs: claude follows the role, codex keeps its five minutes', () => {
  assert.equal(claudeAdapter.cacheTtlMs('5m'), 5 * 60_000);
  assert.equal(claudeAdapter.cacheTtlMs('1h'), 60 * 60_000);
  assert.equal(claudeAdapter.cacheTtlMs(undefined), 60 * 60_000);
  assert.equal(codexAdapter.cacheTtlMs('1h'), 5 * 60_000);
  assert.equal(codexAdapter.cacheTtlMs('5m'), 5 * 60_000);
});
