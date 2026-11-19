import { randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { workRoot } from './paths.js';
import { readRecord } from './programme-record.js';
import { authorOf, readerCall, PROGRAMME_REVIEW_FILE, PROGRAMME_REVIEW_LAUNCH, PROGRAMME_REVIEW_LIMIT_MS, PROGRAMME_REVIEW_ROLE } from './programme-review.js';
import { isRepairAuthor } from './repair-authority.js';
import { repairDigest, repairSnapshot, sameRepairSnapshot, validRepairManifest } from './repair-manifest.js';

export const REPAIR_REVIEW_FILE = '.repair-review.json';
const MAX_REPORT_BYTES = 64 * 1024;

export function repairFindings(text) {
  if (typeof text !== 'string' || /[\u0000\uFFFD]/u.test(text) || Buffer.byteLength(text) > MAX_REPORT_BYTES) return null;
  const lines = text.replaceAll('\r\n', '\n').trimEnd().split('\n');
  const count = lines[0]?.match(/^findings: (0|[1-9]\d?)$/u);
  if (!count) return null;
  const blocks = lines.slice(1).join('\n').split(/^### Finding /mu);
  const unchecked = blocks.at(-1).split(/^## Not checked\s*$/mu);
  if (unchecked.length !== 2 || !unchecked[1].trim()) return null;
  blocks[blocks.length - 1] = unchecked[0];
  if (blocks.shift().trim() || blocks.length !== Number(count[1])) return null;
  const findings = [];
  for (const [i, block] of blocks.entries()) {
    const rows = block.trimEnd().split('\n');
    const fields = ['Part', 'Entry', 'Evidence', 'Narrowest fix'];
    if (rows.length !== 1 + fields.length || !new RegExp(`^${i + 1} — \\S.*$`, 'u').test(rows[0])) return null;
    const finding = {};
    for (const [index, field] of fields.entries()) {
      const prefix = `${field}: `;
      const row = rows[index + 1];
      if (!row.startsWith(prefix) || !row.slice(prefix.length).trim()) return null;
      finding[field] = row.slice(prefix.length);
    }
    findings.push(finding);
  }
  return findings;
}

function stateAt(dir, read) {
  try { return JSON.parse(read(join(dir, REPAIR_REVIEW_FILE))); }
  catch { return null; }
}

export function currentRepairReview(dir, { read, snapshot = repairSnapshot(dir) }) {
  const receipt = stateAt(dir, read)?.receipt;
  if (!receipt || !validRepairManifest(receipt.manifest) || receipt.manifest.revision !== snapshot.manifest.revision) return null;
  const report = read(join(dir, PROGRAMME_REVIEW_FILE));
  const findings = repairFindings(report);
  return findings && receipt.report === repairDigest(report) ? { receipt, report, findings, snapshot } : null;
}

const boundDraft = (target, ctx, deps) => {
  const found = readRecord(target.dir, { read: ctx.read });
  return found.status === 'valid' && found.record.repair && !found.record.repair.stop_item && found.record.state === 'draft'
    && isRepairAuthor(ctx.env, target.name, deps.authorAlive);
};

/** Revoke first, even if the document or reader cannot be opened on this attempt. */
export function beginRepairReview({ target, ctx, deps }) {
  return ctx.lock(workRoot(ctx.env), () => {
    if (!boundDraft(target, ctx, deps)) throw new Error('only the assigned repair session may review this repair draft');
    const attempt = randomUUID();
    ctx.write(join(target.dir, REPAIR_REVIEW_FILE), JSON.stringify({ attempt }));
    return { attempt, snapshot: repairSnapshot(target.dir) };
  }, { strict: true, name: 'repair-review-begin' });
}

export async function repairReviewCall({ target, ctx, repos, attempt, snapshot, deps = {} }) {
  const author = authorOf(ctx.env, null);
  if (!author) throw new Error('the repair author has no tool and model identity');
  const cwd = checkout => join(checkout, 'report');
  const input = checkout => join(checkout, 'order');
  const reportPath = checkout => join(cwd(checkout), PROGRAMME_REVIEW_FILE);
  const statePath = join(target.dir, REPAIR_REVIEW_FILE);
  const check = () => {
    if (!boundDraft(target, ctx, deps) || stateAt(target.dir, ctx.read)?.attempt !== attempt) return 'the repair review attempt is no longer current';
    return sameRepairSnapshot(snapshot, repairSnapshot(target.dir)) ? null : 'a binding programme input changed during review';
  };
  return readerCall({ target, ctx, deps, policy: {
    kind: PROGRAMME_REVIEW_ROLE, role: PROGRAMME_REVIEW_ROLE, launchFile: PROGRAMME_REVIEW_LAUNCH,
    reviewFile: PROGRAMME_REVIEW_FILE, limitMs: PROGRAMME_REVIEW_LIMIT_MS, limitWords: 'thirty minutes', invalidExit: 2,
    hash: snapshot.manifest.revision, round: 1, author, bound: true, independent: true, fallThrough: true,
    checkoutName: `mc-programme-review-${target.name}`, identity: { MC_PROGRAMME: target.name },
    tokenEnv: 'MC_PROGRAMME_REVIEW_TOKEN', runName: `programme:${target.name}`, repos,
    names: ['PROGRAMME.json'], check,
    prepare: checkout => {
      for (const { path, bytes } of snapshot.files) {
        ctx.write(join(input(checkout), path), bytes, { mode: 0o400 });
      }
      mkdirSync(cwd(checkout));
    },
    sessionDirectory: checkout => cwd(checkout),
    prompt: checkout => {
      chmodSync(cwd(checkout), 0o700);
      return [
        `Independently read the fixed repair order for ${target.name} at ${input(checkout)}, revision ${snapshot.manifest.revision}.`,
        'Read only the snapshot for programme inputs, not the live programme. Check repair remit instead of horizon fit: does this restore settled behaviour without a new user-visible design or a change to a held text?',
        `Binding inputs: ${snapshot.files.map(({ path }) => path).join(', ')}.`,
        ...repos.map(({ repo }) => `Read-only ${repo} source at origin/main: ${join(checkout, repo)}`),
        `Write only ${reportPath(checkout)}. First line: findings: <n>. For each finding, use a heading ### Finding <i> — <summary>, numbered from 1, followed by four nonempty single lines with prefixes Part: , Entry: , Evidence: , and Narrowest fix: . End with ## Not checked and what you did not check and why (or None.). No other sections.`,
      ].join('\n\n');
    },
    isolatedOutput: checkout => {
      const path = reportPath(checkout);
      const stat = lstatSync(path, { throwIfNoEntry: false });
      return stat?.isFile() && stat.size <= MAX_REPORT_BYTES ? readFileSync(path, 'utf8') : null;
    },
    store: ({ output, candidate, at }) => ctx.lock(workRoot(ctx.env), () => {
      const problem = check();
      if (problem) return problem;
      if (!repairFindings(output)) return 'the reader did not write a fresh, valid findings report';
      ctx.write(join(target.dir, PROGRAMME_REVIEW_FILE), output);
      ctx.write(statePath, JSON.stringify({ attempt, receipt: {
        manifest: snapshot.manifest, report: repairDigest(output), author, reader: { tool: candidate.tool, model: candidate.model }, at: at.toISOString(),
      } }));
      return null;
    }, { strict: true, name: 'repair-review-store' }),
  } });
}
