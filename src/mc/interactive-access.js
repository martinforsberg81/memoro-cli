/** One execution boundary for every interactive mc tool, not a per-tool user knob. */
export function interactiveAccessOptions(spec, writableDirectories = []) {
  if (spec?.executionAccess !== 'host') {
    throw new Error('tool adapter does not support mc host execution access');
  }
  return { executionAccess: 'host', writableDirectories };
}
