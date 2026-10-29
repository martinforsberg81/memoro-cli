/** Workflow authority, not an OS sandbox. Unknown commands fail closed for review. */
export function reviewCommandRefusal(argv, { env = process.env, actor = null } = {}) {
  if ((actor?.role || env.MC_AUTONOMOUS_ROLE) !== 'review') return null;
  const [verb, operation] = argv;
  if (['--help', '-h', 'help', '--version', 'status', 'gate'].includes(verb)) return null;
  if (verb === 'autonomous-project' && ['show', 'report'].includes(operation)) return null;
  // Hook execution must remain available; it is not a scope/state mutation.
  if (verb === 'hook') return null;
  return 'autonomous review may only examine and report; scope/state changes, build, publish and merge are denied';
}
