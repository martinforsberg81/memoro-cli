/**
 * Which of `src/` does mc actually reach?
 *
 * A static import graph — `import`, dynamic `import()`, and the router's own
 * `runModule('./…')` — seeded from the page and the verbs `mc --help`
 * describes. Everything it does not reach is what `mc-cut` removes, one
 * verb-removal at a time.
 *
 * Seeded by hand from the routers' surviving entries rather than by parsing
 * the tables, because until step 3 landed the tables held the verbs being cut
 * and seeding from them reported the whole v1 world as live. `mc status
 * <name>` was the trap: it routes through `src/cli/status.js`, which used to
 * pull in the registry, the broker, the session host and the managed
 * providers. It is a 42-line shim now — it prints where the page went and
 * hands a named project to `mc/commands/status-project.js` — so it is seeded
 * here by name, and step 4 must keep it (or fold its message into
 * `mc-cli.js`'s own `moved()`) when it empties `src/cli/`.
 *
 *   node docs/project/mc/mc-cut/reach.mjs .
 *
 * `--list` prints every unreached file rather than the per-directory totals.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';

const ROOT = resolve(process.argv[2] || '.');
const SRC = join(ROOT, 'src');
const LIST = process.argv.includes('--list');

/**
 * The surface as it stands: the page, and the twelve verbs `src/mc-cli.js`
 * routes after step 3. Every entry here is a value in that table, or a file
 * one of those values reaches through the router itself.
 */
const LIVE = [
  'mc-cli.js',                      // the router: the page's flags, `moved()`
  'mc/commands/home.js',            // bare `mc` — the page
  'cli/status.js',                  // mc status — the shim in front of…
  'mc/commands/status-project.js',  // …mc status <name>
  'mc/commands/work.js',
  'mc/commands/repo.js',
  'mc/commands/merge.js',
  'mc/commands/test.js',
  'mc/commands/worker.js',
  'mc/commands/brief.js',
  'mc/commands/helper.js',
  'mc/commands/plan.js',
  'mc/commands/run.js',
  'mc/commands/roles.js',
  'mc/commands/log.js',
  'mc/help-text.js',
];

/**
 * Kept by the contract, whatever the graph says (Martin, 2026-08-29).
 *
 * `mc vault` is the whole of `src/bin-mc.js`'s table after step 3, so
 * `bin-mc.js` is seeded with it: it is the only thing that still reaches it.
 */
const KEPT = ['bin-mc.js', 'cli/vault.js'];

const walk = (dir, out = []) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (/\.m?js$/u.test(entry.name)) out.push(path);
  }
  return out;
};

const SPECIFIER = [
  /(?:^|\n)\s*(?:import\s[^;]*?from\s*|import\s*|export\s[^;]*?from\s*)['"]([^'"]+)['"]/gu,
  /import\(\s*['"]([^'"]+)['"]\s*\)/gu,
  /runModule\(\s*['"]([^'"]+)['"]/gu,
];

const all = walk(SRC);
const edges = new Map();
for (const file of all) {
  const text = readFileSync(file, 'utf8');
  const targets = new Set();
  for (const pattern of SPECIFIER) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text))) {
      if (!match[1].startsWith('.')) continue;   // node: and npm are not ours to cut
      const base = resolve(dirname(file), match[1]);
      const found = [base, `${base}.js`, join(base, 'index.js')]
        .find((c) => existsSync(c) && statSync(c).isFile());
      if (found) targets.add(found);
    }
  }
  edges.set(file, targets);
}

function reach(seeds, stop = new Set()) {
  const seen = new Set();
  const stack = [...seeds];
  while (stack.length) {
    const file = stack.pop();
    if (!file || seen.has(file)) continue;
    seen.add(file);
    if (stop.has(file)) continue;
    for (const target of edges.get(file) || []) stack.push(target);
  }
  return seen;
}

const rel = (f) => relative(ROOT, f);
const lines = (f) => readFileSync(f, 'utf8').split('\n').length;
const sum = (fs) => fs.reduce((n, f) => n + lines(f), 0);
const seed = (names) => names.map((n) => join(SRC, n)).filter((p) => existsSync(p));

// `src/mc-cli.js` falls through to `src/bin-mc.js`, whose whole table is now
// `mc vault`. So the page's own reach stops at that door: crossing it would
// fold the contract's cost into the page's number and the two rows below
// would print the same figure.
const page = reach(seed(LIVE), new Set(seed(['bin-mc.js'])));
const live = reach(seed(LIVE).concat(seed(KEPT)));
const dead = all.filter((f) => !live.has(f));

const row = (label, files) => `${String(files.length).padStart(4)} filer ${String(sum(files)).padStart(6)} rader  ${label}`;
console.log(row('src/', all));
console.log(row('reached by the page and its verbs', [...page]));
console.log(row(`…plus ${KEPT.join(', ')} (kept by contract)`, [...live]));
console.log(row(`NOT reached — ${Math.round((100 * sum(dead)) / sum(all))}% of src/`, dead));

if (LIST) {
  console.log('');
  for (const file of dead.sort((a, b) => lines(b) - lines(a))) {
    console.log(`${String(lines(file)).padStart(5)}  ${rel(file)}`);
  }
} else {
  const group = (f) => {
    const r = rel(f);
    const two = r.match(/^src\/([^/]+)\/([^/]+)\//u);
    if (two) return `src/${two[1]}/${two[2]}/`;
    const one = r.match(/^src\/([^/]+)\//u);
    return one ? `src/${one[1]}/` : 'src/';
  };
  const by = new Map();
  for (const file of dead) by.set(group(file), (by.get(group(file)) || []).concat(file));
  console.log('');
  for (const [name, files] of [...by].sort((a, b) => sum(b[1]) - sum(a[1]))) console.log(row(name, files));
}
