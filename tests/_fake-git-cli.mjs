/**
 * `git` for a process node's preload cannot reach, such as a shell script: one
 * call against the snapshot in MC_FAKE_GIT_STATE. It costs a node start, and
 * starts no git.
 */
import { FakeGit } from './mc/_helpers/fake-git.js';

const file = process.env.MC_FAKE_GIT_STATE;
const model = FakeGit.load(file);
let input;
if (!process.stdin.isTTY) { try { input = (await import('node:fs')).readFileSync(0, 'utf8'); } catch { input = undefined; } }
const result = model.runner(process.cwd(), process.argv.slice(2), { env: process.env, input: input || undefined });
model.snapshot(file);
process.stdout.write(result.stdout || '');
process.stderr.write(result.stderr || '');
process.exitCode = result.status ?? 1;
