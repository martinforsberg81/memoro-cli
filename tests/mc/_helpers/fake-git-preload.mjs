/**
 * A child process's git is the parent's model. Started with
 * `FakeGit.childEnv(env, file)` — `--import` of this file and
 * MC_FAKE_GIT_STATE naming the snapshot — the child installs the model before
 * any of its code runs and writes the model back on exit, so a push or a
 * commit the child made is what the parent sees after `reload`.
 */
import { FakeGit } from './fake-git.js';

const file = process.env.MC_FAKE_GIT_STATE;
if (file) {
  const model = FakeGit.load(file);
  model.install();
  process.prependOnceListener('exit', () => { try { model.snapshot(file); } catch { /* the parent reads what it can */ } });
}
