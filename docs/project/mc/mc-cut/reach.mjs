/**
 * Which of `src/` does mc actually reach?
 *
 * A static import graph — `import`, dynamic `import()`, and the router's own
 * `runModule('./…')` — seeded from the page and the verbs `mc --help`
 * describes. Everything it does not reach is what `mc-cut` removes, one
 * verb-removal at a time.
 *
 * Seeded from `mc/commands/*`, never from `src/mc-cli.js`'s `modules` map:
 * the map still holds the verbs being cut, and seeding from it reports the
 * whole v1 world as live. `mc status <name>` is the trap — it routes through
 * `src/cli/status.js`, and that one shim pulls in the registry, the broker,
 * the session host and the managed providers.
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

/** The surface as it stands: the page, and the verbs the help text names. */
const LIVE = [
  'mc/commands/home.js',            // bare `mc` — the page
  'mc/commands/status-page.js',
  'mc/commands/status-project.js',  // mc status <name>
  'mc/commands/brief.js',
  'mc/commands/plan.js',
  'mc/commands/run.js',
  'mc/commands/merge.js',
  'mc/commands/repo.js',
  'mc/commands/work.js',
  'mc/commands/helper.js',
  'mc/commands/worker.js',
  'mc/commands/roles.js',
  'mc/help-text.js',
];

/** Kept by the contract, whatever the graph says (Martin, 2026-08-29). */
const KEPT = ['cli/vault.js'];

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

function reach(seeds) {
  const seen = new Set();
  const stack = [...seeds];
  while (stack.length) {
    const file = stack.pop();
    if (!file || seen.has(file)) continue;
    seen.add(file);
    for (const target of edges.get(file) || []) stack.push(target);
  }
  return seen;
}

const rel = (f) => relative(ROOT, f);
const lines = (f) => readFileSync(f, 'utf8').split('\n').length;
const sum = (fs) => fs.reduce((n, f) => n + lines(f), 0);
const seed = (names) => names.map((n) => join(SRC, n)).filter((p) => existsSync(p));

const page = reach(seed(LIVE));
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
