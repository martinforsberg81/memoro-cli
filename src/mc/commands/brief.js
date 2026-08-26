/**
 * `mc brief` — the evaluation and decision session.
 *
 * `--collect` is the script half: gather the ground into
 * `~/mc/brief/<date>.md` with no model. The bare verb runs the same and then
 * opens a fresh foreground session on the file (step 2 of the plan; until it
 * lands, the bare verb says so and stops after collecting).
 */
import { collectBrief } from '../brief-collect.js';

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const flags = new Set(argv.filter((arg) => arg.startsWith('--')));
  const unknown = [...flags].filter((f) => !['--collect', '--offline'].includes(f));
  const words = argv.filter((arg) => !arg.startsWith('--'));
  if (unknown.length || words.length) {
    stderr.write(`mc: unknown argument ${[...unknown, ...words][0]}\n`);
    stderr.write('usage — mc brief [--collect] [--offline]\n');
    return 2;
  }

  const t0 = Date.now();
  const result = await collectBrief({ offline: flags.has('--offline') });
  const seconds = ((Date.now() - t0) / 1000).toFixed(1);
  const { decisions, merged, opened, notes } = result.data;
  const waiting = decisions.filter((d) => !d.answered).length;
  stdout.write(`mc: ${result.path} (${seconds}s) — ${merged.length} merged, ${opened.length} open, ${waiting} waiting on you\n`);
  for (const note of notes) stderr.write(`mc: ${note}\n`);
  if (!flags.has('--collect')) {
    stderr.write('mc: the brief session is not built yet (mc-brief step 2) — read the file above\n');
    return 1;
  }
  return 0;
}
