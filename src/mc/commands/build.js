/**
 * `mc build ios` — whether memoro needs a new iOS binary, and (in the steps
 * after this one) the binary itself.
 *
 * With no flag it is the question (`iosQuestion`, ios-build.js): it builds
 * nothing and touches no worktree. `--shipped <build> <sha>` records a binary
 * made before the verb existed (`recordShipped`). `--device` and
 * `--testflight` are declared and refused until their steps land.
 *
 * Exit codes: 0 for an answer or a recorded seed; 1 for a question that
 * cannot be answered or a sha that does not resolve; 2 for a bad argument or
 * a build that is not here yet.
 */
import { iosQuestion, recordShipped } from '../ios-build.js';
import { scanArgs } from './flags.js';

export function usage() {
  return [
    'usage — mc build ios                          does memoro need a new iOS binary? builds nothing\n',
    '        mc build ios --device [--sha <ref>] [--device-id <id>]\n',
    '                                              build the commit production runs, install it on the paired iPhone\n',
    '        mc build ios --testflight [--no-upload] [--sha <ref>]\n',
    '                                              build, verify and, after one question, upload to TestFlight\n',
    '        mc build ios --shipped <build> <sha>  record a binary built before this verb existed\n',
    '        mc build ios --follow                 watch the build that is running\n',
  ].join('');
}

/** `--shipped` takes two words, which the shared scanner has no grammar for. */
export function parseBuildArgs(argv) {
  const words = [...argv];
  let shipped = null;
  const at = words.indexOf('--shipped');
  if (at !== -1) {
    const [build, sha] = words.slice(at + 1, at + 3);
    if (!build || !sha || build.startsWith('--') || sha.startsWith('--')) {
      return { error: '--shipped needs a build number and a sha' };
    }
    shipped = { build, sha };
    words.splice(at, 3);
  }
  const scanned = scanArgs(words, {
    booleans: ['--device', '--testflight', '--no-upload', '--follow', '--json'],
    strictValues: ['--sha', '--device-id'],
  });
  if (scanned.error) return { error: scanned.error };
  const [platform, ...rest] = scanned.positional;
  if (platform !== 'ios') return { error: platform ? `mc build builds ios and nothing else (${platform})` : 'mc build needs ios' };
  if (rest.length) return { error: `mc build ios takes no further arguments (${rest[0]})` };
  const { flags } = scanned;
  return {
    platform,
    device: flags.device,
    testflight: flags.testflight,
    noUpload: flags['no-upload'],
    follow: flags.follow,
    json: flags.json,
    sha: flags.sha,
    deviceId: flags['device-id'],
    shipped,
  };
}

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const env = deps.env || process.env;
  const opts = parseBuildArgs(argv);
  if (opts.error) {
    stderr.write(`mc: ${opts.error}\n`);
    stderr.write(usage());
    return 2;
  }
  if (opts.shipped) {
    return recordShipped({ ...opts.shipped, env, repos: deps.repos, git: deps.git, stdout, stderr });
  }
  if (opts.device || opts.testflight || opts.noUpload || opts.follow || opts.sha || opts.deviceId) {
    stderr.write('mc: not yet: mc-build-ios step 2/3\n');
    return 2;
  }
  return iosQuestion({
    env, repos: deps.repos, git: deps.git, fetchVersion: deps.fetchVersion, lastShipped: deps.lastShipped,
    stdout, stderr, json: opts.json,
  });
}
