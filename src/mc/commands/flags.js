/**
 * The flag grammar the work-world commands share.
 *
 * `mc work`, `mc worker`, `mc pm` and `mc pm-helper` all read the same kinds
 * of flags — booleans, value flags, the strict `--model` dance, the
 * `--codex`/`--claude` sugar — and had started growing the same loop each.
 * One scanner, three grammars: each command hands over which flags it knows
 * and interprets the positionals itself.
 *
 * Two kinds of value flags, because they have different histories:
 *
 * `values` keeps `mc work`'s original behaviour exactly: the value is the
 * next positional word (flags in between are read first), a value that never
 * arrives is silently dropped, and when several are pending the earliest
 * declared wins the next word. Nothing new may depend on those quirks, but
 * `--repo` and `--from` behave byte-for-byte as they always have.
 *
 * `strictValues` is for flags where a silently-missing value is the failure
 * mode the flag exists to prevent: the very next word is the value whatever
 * it looks like, another flag or the end of the line is an error.
 */
export function scanArgs(argv, {
  booleans = [], values = [], strictValues = [], toolSugar = false,
} = {}) {
  const flags = {};
  for (const name of booleans) flags[key(name)] = false;
  for (const name of [...values, ...strictValues]) flags[key(name)] = null;
  if (toolSugar) flags.tool = null;
  const positional = [];
  const pending = new Set();
  let strictPending = null;

  const result = (error = undefined) => ({ flags, positional, error });

  for (const arg of argv) {
    if (strictPending) {
      if (arg.startsWith('--')) return result(`${strictPending} needs a value`);
      flags[key(strictPending)] = arg;
      strictPending = null;
      continue;
    }
    if (booleans.includes(arg)) { flags[key(arg)] = true; continue; }
    if (values.includes(arg)) { pending.add(arg); continue; }
    if (strictValues.includes(arg)) { strictPending = arg; continue; }
    if (toolSugar && arg === '--codex') { flags.tool = 'codex'; continue; }
    if (toolSugar && arg === '--claude') { flags.tool = 'claude'; continue; }
    if (arg.startsWith('--')) return result(`unknown flag: ${arg}`);
    const waiting = values.find((name) => pending.has(name));
    if (waiting) {
      flags[key(waiting)] = arg;
      pending.delete(waiting);
      continue;
    }
    positional.push(arg);
  }
  if (strictPending) return result(`${strictPending} needs a value`);
  return result();
}

function key(flag) {
  return flag.replace(/^--/u, '');
}
