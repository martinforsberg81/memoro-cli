/** Workflow authority, not an OS sandbox. Headless flavors fail closed. */
export function reviewCommandRefusal(argv, { env = process.env, actor = null } = {}) {
  const role = actor?.role || env.MC_AUTONOMOUS_ROLE;
  if (role === 'plan' && env.MC_PROGRAMME_LEASE) {
    const [verb, operation] = argv;
    if (['--help', '-h', 'help', '--version', 'status', 'hook'].includes(verb)) return null;
    if (verb === 'programme' && ['show', 'status', 'capabilities', 'phase', 'stop', 'wait', 'events', 'operation'].includes(operation)) return null;
    if (verb === 'goal' && ['new', 'criterion', 'send', 'revise', 'retry', 'diagnose', 'show', 'done', 'recover', 'attempt', 'release'].includes(operation)) return null;
    return 'autonomous plan may only author goals within its programme; agreement edits, legacy mutations, build, publish and merge are denied';
  }
  if (role !== 'review') return null;
  const [verb, operation] = argv;
  if (['--help', '-h', 'help', '--version', 'status', 'gate'].includes(verb)) return null;
  if (verb === 'goal' && ['show', 'report'].includes(operation)) return null;
  if (verb === 'programme' && ['status', 'capabilities'].includes(operation)) return null;
  // Hook execution must remain available; it is not a scope/state mutation.
  if (verb === 'hook') return null;
  return 'autonomous review may only examine and report; scope/state changes, build, publish and merge are denied';
}
