/** Read the optional setting without loading SSH, providers or entrance machinery. */
import * as fs from 'node:fs';
import { join } from 'node:path';
import { workRoot } from './paths.js';

const settingPath = env => join(workRoot(env), 'runner', 'server.json');
const refusal = message => { throw new Error(message); };

export function sshDestination(value) {
  if (typeof value !== 'string' || !value || value.startsWith('-') || /[\x00-\x20\x7f]/u.test(value)) refusal('SSH destination must be one OpenSSH destination, not options or a command');
  return value;
}
export function readServer(env = process.env, io = fs) {
  let value;
  try { value = JSON.parse(io.readFileSync(settingPath(env), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!value || Object.keys(value).join() !== 'destination') refusal('invalid mc server setting');
  return sshDestination(value.destination);
}
export function saveServer(destination, env = process.env, io = fs) {
  sshDestination(destination);
  const file = settingPath(env);
  io.mkdirSync(join(workRoot(env), 'runner'), { recursive: true, mode: 0o700 });
  const pending = `${file}.${process.pid}.tmp`;
  try { io.writeFileSync(pending, `${JSON.stringify({ destination })}\n`, { mode: 0o600 }); io.renameSync(pending, file); }
  finally { io.rmSync(pending, { force: true }); }
}
export function clearServer(env = process.env, io = fs) { io.rmSync(settingPath(env), { force: true }); }

