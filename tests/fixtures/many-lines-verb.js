/**
 * A verb that writes more to stdout than a pipe holds, for
 * tests/mc/verb-epipe.test.js. It is not a test: its name does not end in
 * `.test.js`, so the suite does not run it.
 *
 * `run` with `boom` as its first argument throws instead, so the test can see
 * that an error other than a closed reader still reaches stderr.
 */

export function usage() {
  return 'usage — fixture\n';
}

export async function run(argv) {
  if (argv[0] === 'boom') throw new Error('boom');
  for (let i = 0; i < 200000; i += 1) process.stdout.write(`line ${i}\n`);
  return 3;
}
