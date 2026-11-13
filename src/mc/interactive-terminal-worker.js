/** Internal tmux worker: existing opener owns registration and provider lifetime. */
import { readFileSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { openInWorkArea } from './work-open.js';

try {
  const request = process.argv[2];
  const options = JSON.parse(readFileSync(request, 'utf8'));
  unlinkSync(request);
  const result = await openInWorkArea({ ...options, persistentTerminal: false,
    onProvider: provider => spawnSync('tmux', ['-L', process.argv[3], 'set-option', '-t', process.argv[4], '@mc-provider', provider]),
  });
  if (!result.ok) process.stderr.write(`mc: ${result.reason}${result.hint ? ` — ${result.hint}` : ''}\n`);
  process.exitCode = result.ok ? (result.code ?? 0) : 1;
} catch (error) {
  process.stderr.write(`mc: persistent session failed: ${error.message}\n`);
  process.exitCode = 1;
}
