/** Compatibility entrance; existing scripts open the same Manager session. */
export { run, ROUTES, managerLaunch as briefLaunch } from './manager.js';
import { commandUsage } from '../command-help.js';
export function usage() { return commandUsage('brief'); }
