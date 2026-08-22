/**
 * The one place a model is allowed in.
 *
 * Everything else the guard knows it worked out from timestamps and the
 * filesystem. This is the exception the design note carves out: the running
 * output of a session is prose, and whether it says "I am stuck waiting for a
 * decision", "you are out of quota" or "that command failed" is a reading, not
 * a subtraction. So Haiku reads the tail — and only the tail, and only when the
 * tail has moved.
 *
 * Two rules shape everything below.
 *
 * A cheap model is an amplifier of attention, never a filter. "Look here" costs
 * a glance when it is wrong; "nothing to see" is invisible when it is wrong.
 * The prompt therefore tells the model to flag when unsure, and this module
 * never lets a model's silence stand in for anybody else's reading — the round
 * counts PM's inbox on its own, and the four script patterns are computed
 * whether the model answers or not.
 *
 * And the model flags; it does not decide, summarise or rank. Its whole
 * vocabulary is three words plus a quote copied out of the output, and the
 * quote is checked against the output here rather than believed. A model that
 * paraphrased would be telling PM what the session is about, which is exactly
 * the judgement KP-05 keeps out of it.
 *
 * MEASURED, AND DELIBERATELY NOT FIXED — read this before tightening the
 * prompt below. Haiku over-flags `blocked`. On 2026-08-21 it flagged a session
 * whose output *reported that another session* was blocked, and the paragraph
 * about whose state a flag is about was added afterwards and did not stop it
 * in a short excerpt. That is the amplifier working in the direction it is
 * supposed to: a false "look here" costs one glance, and a flag withheld is
 * invisible to everybody. Tuning further trades precision for recall, and
 * recall is the one thing KP-05's first law forbids trading. If a future
 * change makes this quieter, that is a change in behaviour to be argued for on
 * its own terms — not a bug being fixed.
 */
import { spawn } from 'node:child_process';

import { MODEL_PATTERNS } from './watch-sessions-scan.js';

/**
 * Haiku, named the way the tool names it.
 *
 * mc does not validate model names anywhere else — the tool is the authority
 * on what exists, and its own error names a mistake better than a stale list
 * here could. The alias follows the current Haiku, which is what "the guard
 * runs Haiku" means; `--model` pins an exact one when somebody wants that.
 */
export const DEFAULT_MODEL = 'haiku';

/** How much of the tail the model is shown, and how long it gets to read it. */
export const EXCERPT_CHARS = 4000;

/**
 * Four minutes, and it is the tool rather than the model that needs them.
 *
 * Measured on this machine, 2026-08-21, with six conversations running and a
 * load average of fifteen: the API turn itself takes three to eleven seconds,
 * and starting the tool around it takes a hundred and twenty. `claude
 * --version` alone took twenty-one seconds while `node -e ''` took a quarter
 * of one, so this is the tool's own start-up against a busy machine and not
 * something the guard can shorten.
 *
 * That price buys the thing worth having: the guard reads through the tool the
 * user is already signed into, so it needs no API key of its own and no new
 * credential anywhere. It is worth paying — but a busy machine is exactly when
 * a watchman matters, so the round is built to survive the wait rather than to
 * hope it will not happen.
 */
export const READ_TIMEOUT_MS = 240_000;

const SYSTEM = [
  'You are a watchman. You are shown the tail of one coding session\'s output and you flag patterns in it.',
  '',
  'You do not decide anything, you do not rank anything, and you never say what the session is working on.',
  'Your entire vocabulary is three flags:',
  '',
  '  blocked          it has stopped and is waiting on a decision, an approval, a credential, or a',
  '                   resource it cannot get for itself.',
  '  quota-exhausted  it ran out of quota, credit, or rate limit.',
  '  error            something in the output failed: a crash, a stack trace, a command that exited',
  '                   non-zero and was not handled.',
  '',
  'Every flag is about the session whose output you are reading — its own state, right now. Output in',
  'which it reports, quotes, or describes somebody else being blocked, out of quota, or in error is not',
  'a flag: that is the session working, and a session at work is the ordinary case.',
  '',
  'Answer with JSON and nothing else:',
  '',
  '  {"flags":[{"pattern":"error","quote":"<up to 120 characters copied exactly out of the output>"}]}',
  '',
  'Copy the quote character for character out of the output. Do not paraphrase it, do not translate it,',
  'do not summarise it, and do not write one of your own.',
  '',
  'When you are unsure whether something matches, flag it. A flag that turns out to be nothing costs',
  'the reader one glance. A flag you held back is invisible to everybody.',
  '',
  'If nothing in the output matches, answer {"flags":[]}.',
].join('\n');

/**
 * Read one session's tail and come back with flags.
 *
 * Everything that can go wrong here — the tool missing, a timeout, JSON that is
 * not JSON — comes back as `{ patterns: [], failed: <why> }` rather than
 * throwing. A round that stopped because one model call misbehaved would stop
 * watching every other session too, and the script patterns do not need this
 * call to have succeeded.
 */
export async function readOutput(excerpt, { ask = askClaude, model = DEFAULT_MODEL } = {}) {
  const text = String(excerpt || '').trim();
  if (!text) return { patterns: [], failed: null };

  let answer = null;
  try {
    answer = await ask({ system: SYSTEM, prompt: text, model });
  } catch (error) {
    return { patterns: [], failed: error?.message || String(error) };
  }

  const parsed = parseFlags(answer);
  if (parsed === null) return { patterns: [], failed: 'the model did not answer with JSON' };

  const patterns = [];
  const seen = new Set();
  for (const flag of parsed) {
    const pattern = String(flag?.pattern || '').trim();
    // A word outside the vocabulary is dropped rather than passed on. The
    // vocabulary is the contract with PM, and a model that invented a seventh
    // pattern would be a model widening the guard's remit by itself.
    if (!MODEL_PATTERNS.includes(pattern) || seen.has(pattern)) continue;
    seen.add(pattern);
    patterns.push({ pattern, detail: quoteFrom(flag?.quote, text) });
  }
  return { patterns, failed: null };
}

/**
 * The quote, if it is really in there.
 *
 * The model is asked to copy; this checks that it did. A quote that cannot be
 * found in the output was written rather than copied, and that is the model
 * summarising — so the flag stands and the invention is thrown away, with the
 * reader told which of the two they got. Whitespace is normalised on both
 * sides because a terminal wraps and a transcript does not.
 */
export function quoteFrom(quote, text) {
  const wanted = collapse(quote).slice(0, 120);
  if (!wanted) return 'flagged, with nothing quoted';
  return collapse(text).includes(wanted)
    ? `"${wanted}"`
    : 'flagged, but the quote it gave is not in the output';
}

function collapse(value) {
  return String(value ?? '').replace(/\s+/gu, ' ').trim();
}

/**
 * The model's answer, dug out of whatever it wrapped it in.
 *
 * Asked for bare JSON and usually given bare JSON, but a fenced block or a
 * sentence in front of it is a normal thing for a small model to do and is not
 * worth losing a round over.
 */
export function parseFlags(answer) {
  const text = String(answer ?? '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  let value = null;
  try { value = JSON.parse(text.slice(start, end + 1)); } catch { return null; }
  return Array.isArray(value?.flags) ? value.flags : null;
}

/**
 * One Haiku turn, through the tool mc already depends on.
 *
 * `--print` with no tools and a system prompt of its own: no session, no
 * transcript, no filesystem, nothing to attach to. The excerpt goes in on
 * stdin rather than in argv, because argv is world-readable on this machine
 * and a session's output is the user's.
 *
 * It runs in a directory of mc's own for the same reason it carries no tools:
 * started in a repository, the tool would pull that repository's instruction
 * files into a call that has no business reading them.
 */
export function askClaude({
  system, prompt, model = DEFAULT_MODEL, cwd = null, timeoutMs = READ_TIMEOUT_MS, spawnFn = spawn,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnFn('claude', [
      '--print',
      '--model', model,
      '--tools', '',
      '--output-format', 'json',
      '--system-prompt', system,
    ], { cwd: cwd || undefined, stdio: ['pipe', 'pipe', 'pipe'] });

    let out = '';
    let err = '';
    let settled = false;
    const finish = (fn, value) => { if (!settled) { settled = true; fn(value); } };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(reject, new Error(`the model did not answer within ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', (error) => { clearTimeout(timer); finish(reject, error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        finish(reject, new Error(`claude exited ${code}${err.trim() ? `: ${err.trim().split('\n')[0]}` : ''}`));
        return;
      }
      // `--output-format json` wraps the answer in a result envelope; a plain
      // string back is accepted too, so a change of shape degrades to reading
      // the raw text rather than to reading nothing.
      let text = out;
      try {
        const envelope = JSON.parse(out);
        if (typeof envelope?.result === 'string') text = envelope.result;
      } catch { /* not the envelope — use what came back */ }
      finish(resolve, text);
    });

    child.stdin.end(prompt);
  });
}

/**
 * What the model is shown: the session's output, and not its reasoning.
 *
 * Assistant text, the names of the tools it ran, and what those tools said
 * back — that last one is where a stack trace, a non-zero exit and a quota
 * refusal actually land. Tool *inputs* are left out because they are the
 * biggest and least informative thing in a transcript, and thinking blocks are
 * left out because they are not output: the note says the guard reads what the
 * session produced, and one model reading another's private reasoning is a
 * different feature nobody asked for.
 *
 * The end is kept rather than the beginning. The question is always what is
 * happening now.
 */
export function excerptOf(entries, { chars = EXCERPT_CHARS } = {}) {
  const lines = [];
  for (const entry of entries || []) {
    for (const line of renderEntry(entry)) if (line) lines.push(line);
  }
  const text = lines.join('\n');
  return text.length > chars ? text.slice(text.length - chars) : text;
}

function renderEntry(entry) {
  // Codex keeps its messages under `payload`; Claude keeps them under
  // `message`. Both are read here so the guard has one excerpt format and the
  // prompt does not have to know which tool it is looking at.
  const payload = entry?.payload;
  if (payload && typeof payload === 'object') {
    if (payload.role === 'assistant' || payload.role === 'user') {
      return [prefix(payload.role, textOf(payload.content))];
    }
    if (payload.type === 'function_call_output') return [prefix('tool', textOf(payload.output))];
    return [];
  }

  const role = entry?.type;
  if (role !== 'assistant' && role !== 'user') return [];
  const content = entry?.message?.content;
  if (typeof content === 'string') return [prefix(role, content)];
  if (!Array.isArray(content)) return [];

  const out = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text') out.push(prefix(role, part.text));
    else if (part.type === 'tool_use') out.push(prefix('ran', part.name));
    else if (part.type === 'tool_result') {
      out.push(prefix(part.is_error ? 'tool failed' : 'tool', textOf(part.content)));
    }
  }
  return out;
}

function prefix(label, body) {
  const text = String(body ?? '').replace(/\r/gu, '').trim();
  return text ? `${label}: ${text}` : '';
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (typeof part === 'string' ? part : (typeof part?.text === 'string' ? part.text : '')))
    .filter(Boolean)
    .join('\n');
}
