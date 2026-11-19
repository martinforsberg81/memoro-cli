import { dirname } from 'node:path';

/** One execution boundary for every interactive mc tool, not a per-tool user knob. */
export function interactiveAccessOptions(spec, writableDirectories = []) {
  if (spec?.executionAccess !== 'host') {
    throw new Error('tool adapter does not support mc host execution access');
  }
  return { executionAccess: 'host', writableDirectories };
}

/** Report a measured host directory refusal. Provider errors have their own channel. */
export function directoryAccessRefusal(error, fallbackPath) {
  if (!['EACCES', 'EPERM', 'EROFS'].includes(error?.code)) return null;
  if (error.syscall === 'mkdir') {
    const path = error.path || fallbackPath;
    return `host denied creating ${path} — check permissions on ${dirname(path)}, then retry`;
  }
  if (error.syscall === 'mkdtemp') {
    const parent = error.path ? dirname(error.path) : fallbackPath;
    return `host denied creating a session directory in ${parent} — check permissions on ${parent}, then retry`;
  }
  return null;
}
