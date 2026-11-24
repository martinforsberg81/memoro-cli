import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import * as codex from '../../../src/adapters/codex.js';
import { findGeneratedImage, parseImageArgs, resolveCodexModel, run } from '../../../src/mc/commands/image.js';

const CATALOG = ['gpt-5.6-luna', 'gpt-6-sol', 'gpt-6.1-sol', 'gpt-5.6-terra', 'gpt-6.2-astra', 'gpt-6.2-sol', 'gpt-6.1-terra', 'gpt-6-luna', 'gpt-5.6-sol'];
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
const LAUNCH = { ok: true, id: 'codex', adapter: codex, spec: { bin: 'codex' } };
const NOW = new Date('2026-11-24T12:00:00Z');

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'mc-image-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { MC_WORK_ROOT: join(root, 'mc'), CODEX_HOME: join(root, 'codex'), OPENAI_API_KEY: 'sk-test', MC_ROLE: 'build', MC_GOAL: 'p/g' };
  const calls = [];
  const rows = [];
  const images = join(env.CODEX_HOME, 'generated_images');
  /** A session that writes one image under its thread's directory, as Codex does. */
  const making = (thread = 'thread-1') => async (call) => {
    calls.push(call);
    mkdirSync(join(images, thread), { recursive: true });
    writeFileSync(join(images, thread, 'exec-1.png'), PNG);
    return { status: 0, stdout: `${JSON.stringify({ type: 'thread.started', thread_id: thread })}\n`, stderr: '' };
  };
  const command = async (argv, deps = {}) => {
    let out = '';
    let err = '';
    const code = await run(argv, {
      env, cwd: root, now: () => NOW, id: () => 'call-1', catalog: CATALOG, login: 'chatgpt', launch: () => LAUNCH,
      billingRoute: () => ({ billing: 'plan', why: 'plan available' }), session: making(), logRun: (row) => rows.push(row),
      stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } }, ...deps,
    });
    return { code, out, err };
  };
  return { root, env, calls, rows, images, making, command };
}

test('a family word resolves to the newest catalog slug of that family; a slug is itself', () => {
  assert.deepEqual(['luna', 'sol', 'terra'].map((word) => resolveCodexModel(word, CATALOG).model), ['gpt-6-luna', 'gpt-6.2-sol', 'gpt-6.1-terra']);
  assert.deepEqual(resolveCodexModel('gpt-5.6-luna', CATALOG), { model: 'gpt-5.6-luna' });
  assert.match(resolveCodexModel('gpt-9-nova', CATALOG).error, /not in the Codex catalog/u);
  assert.match(resolveCodexModel('luna', ['gpt-6.2-sol']).error, /no luna model/u);
  // No catalog: Codex is the authority on a slug, and a family cannot be resolved.
  assert.deepEqual(resolveCodexModel('gpt-9-nova', null), { model: 'gpt-9-nova' });
  assert.match(resolveCodexModel('luna', null).error, /cannot be read/u);
});

test('the flags: prompt and out are required, --input repeats, luna is the default model', () => {
  assert.match(parseImageArgs(['--out', 'a.png']).error, /--prompt/u);
  assert.match(parseImageArgs(['--prompt', 'x']).error, /--out/u);
  assert.match(parseImageArgs(['--prompt', 'x', '--out', 'a.png', 'extra']).error, /takes no extra/u);
  assert.match(parseImageArgs(['--prompt', 'x', '--out', 'a.png', '--size', '2']).error, /unknown flag: --size/u);
  assert.deepEqual(parseImageArgs(['--prompt', 'a cat', '--out', 'a.png', '--input', 'b.png', '--input', 'c.png', '--transparent', '--image-model', 'sunburst']), {
    prompt: 'a cat', out: 'a.png', inputs: ['b.png', 'c.png'], transparent: true, force: false, model: 'luna', imageModel: 'sunburst',
  });
});

test('an image is refused, with no session, unless the Codex route is the plan and the login is ChatGPT', async (t) => {
  const f = fixture(t);
  const credits = await f.command(['--prompt', 'x', '--out', 'a.png'], { billingRoute: () => ({ billing: 'credits', why: 'plan reached 100 %' }) });
  assert.equal(credits.code, 1);
  assert.match(credits.err, /route is credits \(plan reached 100 %\).*never on API credits/u);
  const apiKey = await f.command(['--prompt', 'x', '--out', 'a.png'], { login: 'apikey' });
  assert.equal(apiKey.code, 1);
  assert.match(apiKey.err, /logged in with apikey, not with ChatGPT/u);
  assert.deepEqual([f.calls.length, f.rows.length, existsSync(join(f.root, 'a.png'))], [0, 0, false]);
});

test('the session runs on the resolved model without API keys; the image it made is copied to --out', async (t) => {
  const f = fixture(t);
  const ref = join(f.root, 'ref.png');
  writeFileSync(ref, PNG);
  const done = await f.command(['--prompt', 'a small yellow sun', '--out', 'pics/sun.png', '--input', 'ref.png', '--transparent', '--image-model', 'sunburst']);
  assert.equal(done.code, 0, done.err);
  const out = join(f.root, 'pics', 'sun.png');
  assert.equal(done.out, `${out}\n`);
  assert.deepEqual(readFileSync(out), PNG);
  assert.match(done.err, /no model field: --image-model sunburst .* cannot be confirmed/u);
  const [call] = f.calls;
  assert.deepEqual(call.args.slice(0, 4), ['exec', '--json', '--sandbox', 'danger-full-access']);
  assert.ok(call.args.join(' ').includes('-m gpt-6-luna -c model_reasoning_effort=low'), call.args.join(' '));
  const prompt = call.args.at(-1);
  for (const said of ['built-in image generation tool', 'never scripts/image_gen.py', 'image model sunburst', JSON.stringify(ref), 'transparent_background: true']) {
    assert.ok(prompt.includes(said), said);
  }
  assert.ok(prompt.endsWith('\n\na small yellow sun'));
  assert.deepEqual([call.env.OPENAI_API_KEY, call.env.MC_ROLE, call.env.MC_GOAL, call.env.MC_HEADLESS], [undefined, undefined, undefined, '1']);
  assert.equal(call.cwd, join(f.env.MC_WORK_ROOT, 'runner', 'images', 'call-1'));
  assert.equal(existsSync(call.cwd), false, 'the scratch directory is removed');
  assert.deepEqual(f.rows.map((row) => [row.kind, row.exit, row.model, row.tool, row.effort, row.billing, row.session]), [['image', 0, 'gpt-6-luna', 'codex', 'low', 'plan', 'thread-1']]);
});

test('an existing --out is refused before any session, and replaced with --force', async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.root, 'a.png'), 'old');
  const refused = await f.command(['--prompt', 'x', '--out', 'a.png']);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /exists; --force replaces it/u);
  assert.equal(f.calls.length, 0);
  const forced = await f.command(['--prompt', 'x', '--out', 'a.png', '--force']);
  assert.equal(forced.code, 0, forced.err);
  assert.deepEqual(readFileSync(join(f.root, 'a.png')), PNG);
});

test('a missing --input is a bad argument; a session that made no image fails with the reason', async (t) => {
  const f = fixture(t);
  const missing = await f.command(['--prompt', 'x', '--out', 'a.png', '--input', 'nope.png']);
  assert.equal(missing.code, 2);
  assert.match(missing.err, /nope\.png is not a file/u);
  const none = await f.command(['--prompt', 'x', '--out', 'a.png'], { session: async () => ({ status: 3, stdout: '', stderr: 'boom\nlast word' }) });
  assert.equal(none.code, 1);
  assert.match(none.err, /codex exited 3 without an image: last word/u);
  assert.equal(existsSync(join(f.root, 'a.png')), false);
  assert.deepEqual(f.rows.map((row) => [row.kind, row.exit]), [['image', 1]]);
});

test('the image is the session directory\'s newest file, else the newest written since the launch', (t) => {
  const f = fixture(t);
  const at = (path, seconds) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, PNG); utimesSync(path, seconds, seconds); };
  at(join(f.images, 's1', 'old.png'), 100);
  at(join(f.images, 's1', 'new.png'), 200);
  at(join(f.images, 'other', 'stale.png'), 50);
  at(join(f.images, 'other', 'fresh.png'), 300);
  assert.equal(findGeneratedImage({ home: f.env.CODEX_HOME, session: 's1', since: 0 }), join(f.images, 's1', 'new.png'));
  assert.equal(findGeneratedImage({ home: f.env.CODEX_HOME, session: 'gone', since: 250_000 }), join(f.images, 'other', 'fresh.png'));
  assert.equal(findGeneratedImage({ home: f.env.CODEX_HOME, session: null, since: 400_000 }), null);
});
