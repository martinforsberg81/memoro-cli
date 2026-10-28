// Synthetic transport, not a provider capture. No model requests or credentials.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

process.on('SIGTERM', () => {}); // deliberately ignore graceful termination
if (process.argv.includes('--leaf')) {
  setInterval(() => {}, 1000);
} else if (process.argv.includes('--success') || process.argv.includes('--unexpected') || process.argv.includes('--pending-tool')) {
  const tool = process.argv[2];
  const print = () => {
    if (process.argv.includes('--pending-tool')) process.stdout.write(`${JSON.stringify({ type: 'item.started', item: { id: 'unreconciled', type: 'command_execution' } })}\n`);
    const event = process.argv.includes('--unexpected') ? '{"type":' : JSON.stringify(tool === 'codex'
      ? { type: 'turn.completed', usage: { input_tokens: 999999, output_tokens: 1 } }
      : { type: 'result', subtype: 'success', num_turns: 1, is_error: false });
    process.stdout.write(`${event}\n`, () => process.exit(0));
  };
  if (tool === 'codex') print(); else process.stdin.once('data', print);
} else {
  const tool = process.argv[2];
  const child = spawn(process.execPath, [process.argv[1], '--leaf'], { stdio: 'ignore' });
  const say = text => process.stdout.write(`${JSON.stringify(tool === 'codex'
    ? { type: 'item.completed', item: { type: 'agent_message', text } }
    : { type: 'assistant', message: { model: 'fixture', content: [{ type: 'text', text }] } })}\n`);
  say(`fixture-child:${child.pid}`);
  if (tool !== 'codex') process.stdin.resume();
  const { run } = await import('../../../src/mc/commands/session-control.js');
  writeFileSync(process.env.MC_TEST_READY, 'ready\n');
  setInterval(async () => {
    // Same persistent command response regardless of the tool's stdin shape.
    let response = '';
    try {
      const state = JSON.parse(readFileSync(process.env.MC_TEST_STATE, 'utf8'));
      const code = await run(['status', 'test-programme/test-project', '--expected-revision', String(state.revision)], {
        root: process.env.MC_TEST_ROOT, actor: state.active_run, env: {},
        stdout: { write: text => { response += text; } }, stderr: { write() {} },
      });
      if (code === 0 && JSON.parse(response).next_action === 'finish-session') {
        writeFileSync(process.env.MC_TEST_CLOSING, response);
        say('ignoring durable finish-session');
      }
    } catch { /* a concurrent revision is retried, never treated as success */ }
  }, 50);
}
