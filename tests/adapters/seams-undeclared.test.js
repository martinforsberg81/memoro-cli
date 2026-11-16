/**
 * A tool whose adapter lacks a capability is refused at the seams that launch,
 * bill, route or act for it, and read as unknown at the seams that only read
 * (D2). A planned tool (cursor) stands for it: the registry knows its name,
 * and it has no adapter. A seam that fell back to claude or codex
 * would run the third tool with the wrong flags, misread its output and cost,
 * record its plan window on claude, or delete its conversation as a file.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import * as registry from '../../src/adapters/index.js';
import { contextUsage, deleteConversation, lastModel } from '../../src/mc/conversations.js';
import { billingRoute } from '../../src/mc/billing-route.js';
import { gatewayToolConfig } from '../../src/mc/billing-gateway-session.js';
import { quotaScopeOf, refusePlanOnRead } from '../../src/mc/plan-refusal.js';
import { profileArgs } from '../../src/mc/portrait.js';
import { describeWatch, headlessArgs, readSessionOutput } from '../../src/mc/run-plan.js';

const refuses = (call, capability) => assert.throws(call, (error) => {
  assert.match(error.message, new RegExp(`\\bcursor\\b.*${capability}|${capability}.*\\bcursor\\b`, 'u'));
  return true;
});

describe('a tool with no declaration is refused where it would launch, bill or act', () => {
  it('headlessArgs names the tool and headlessArgs', () => {
    refuses(() => headlessArgs({ toolId: 'cursor', adapter: null, model: 'm', instructions: null, prompt: 'p', profileArgs }), 'headlessArgs');
    refuses(() => headlessArgs({ toolId: 'cursor', adapter: null, model: 'm', instructions: null, prompt: 'p', profileArgs }), 'headlessArgs');
  });

  it('readSessionOutput names the tool and OUTPUT_READER', () => {
    refuses(() => readSessionOutput({ toolId: 'cursor', stdout: '', exitCode: 0 }), 'OUTPUT_READER');
  });

  it('describeWatch names the tool and WATCH', () => {
    refuses(() => describeWatch('cursor', { checkInMinutes: 1, stallMinutes: 1 }), 'WATCH');
  });

  it('profileArgs names the tool and INSTRUCTIONS', () => {
    refuses(() => profileArgs('cursor', '# role'), 'INSTRUCTIONS');
    assert.deepEqual(profileArgs('cursor', null), []);
  });

  it('billingRoute names the tool and BILLING_PROVIDER', () => {
    refuses(() => billingRoute({ provider: 'cursor' }), 'BILLING_PROVIDER');
  });

  it('a quota refusal names the tool and QUOTA_SCOPE', () => {
    refuses(() => refusePlanOnRead({ read: { quota: true }, launch: { id: 'cursor' }, model: 'm', billing: 'plan', write: () => {} }), 'QUOTA_SCOPE');
    refuses(() => quotaScopeOf({ id: 'cursor' }), 'QUOTA_SCOPE');
  });

  it('every implemented tool declares QUOTA_SCOPE: agy by model, claude and codex by plan', () => {
    assert.deepEqual(registry.implementedTools().map((tool) => [tool, registry.requireCapability(tool, 'QUOTA_SCOPE')]).sort(), [['agy', 'model'], ['claude', 'plan'], ['codex', 'plan']]);
  });

  it('gatewayToolConfig names the tool and API_ROUTE', () => {
    refuses(() => gatewayToolConfig({ provider: 'cursor', base: 'http://127.0.0.1:1', grant: 'g', args: [], env: {} }), 'API_ROUTE');
  });

  it('deleteConversation does not remove the transcript as a file', () => {
    const result = deleteConversation({ tool: 'cursor', id: 'c1', path: '/nonexistent/c1.jsonl' }, {});
    assert.equal(result.ok, false);
    assert.match(result.reason, /\bcursor\b.*CONVERSATION_DELETE/u);
  });
});

describe('a tool with no declaration is read as unknown where a seam only reads', () => {
  it('gives no context usage and no last model', () => {
    const entries = [{ type: 'assistant', message: { model: 'claude-opus-5-5', usage: { input_tokens: 10 } } },
      { type: 'turn_context', payload: { model: 'gpt-6.1-sol' } }];
    assert.equal(contextUsage('cursor', entries), null);
    assert.equal(lastModel('cursor', entries), null);
  });
});

describe('the registry', () => {
  it('implements antigravity-cli as agy, plans only cursor and windsurf, and does not know gemini', () => {
    const agy = registry.resolveToolInput('agy');
    assert.equal(agy.id, 'antigravity-cli');
    assert.equal(agy.planned, false);
    assert.ok(agy.adapter);
    assert.equal(registry.resolveToolInput('antigravity-cli')?.shortName, 'agy');
    assert.equal(registry.resolveToolInput('cursor').planned, true);
    assert.equal(registry.resolveToolInput('gemini'), null);
    assert.equal(registry.resolveToolInput('gemini-cli'), null);
    assert.deepEqual(registry.listPlanned().map((entry) => entry.id), ['cursor', 'windsurf']);
    assert.equal(registry.resolveLaunch('cursor').reason, 'planned');
    assert.equal(registry.toolShortName('claude-code'), 'claude');
    assert.equal(registry.toolShortName('codex'), 'codex');
  });
});
