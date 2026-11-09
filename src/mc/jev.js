/**
 * jev — TypeSafe's System One model, asked before a question reaches Martin
 * (`mc goal martin`, docs/technical/mc-jev.md).
 *
 * A session's question comes with 2 to 4 options and its recommendation. mc
 * builds one state from the goal, the programme and the session's evidence,
 * asks jev three typed questions (`answer`, a Choice over the option keys;
 * `fits` and `settled`, Nouls) and answers the session itself when jev agrees
 * with the recommendation with high probability (`THRESHOLDS`). Everything
 * else — a miss, a failure, a malformed answer — is Martin's: jev never makes
 * the verb fail.
 *
 * The key is read here from the `mc keys` source (`keys-dotenv.js`) and goes
 * only into the Authorization header; every value of 8 or more characters
 * from that source is replaced with `[redacted]` in what is sent and written.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

/** The pinned model and its endpoint; they change only with Martin (the goal's contract). */
export const JEV_MODEL = 'jev-1.14.0';
export const JEV_URL = 'https://api.typesafe.ai/v1/systemone';
/** The name of the key in the `mc keys` source. */
export const JEV_KEY = 'TYPESAFE_API_KEY';
/**
 * When jev answers instead of Martin: its choice is the session's
 * recommendation, at this probability or more, and both Nouls at theirs or more.
 * They change only with Martin.
 */
export const THRESHOLDS = Object.freeze({ choice: 0.90, fits: 0.70, settled: 0.70 });
/** The serialized state's budget, in characters. */
export const STATE_BUDGET = 240_000;
/** One attempt's limit; the longest `retry-after` honoured; the wait when a retry has none. */
export const TIMEOUT_MS = 15_000;
export const RETRY_AFTER_MAX_MS = 10_000;
export const RETRY_DEFAULT_MS = 1_000;
/** How many LOG.md entries the state carries, newest last. */
export const LOG_ENTRIES = 5;
/** A keys-source value this long or longer is redacted. */
export const REDACT_MIN = 8;
export const REDACTED = '[redacted]';
export const TRUNCATED = '[truncated]';

export const KEY_RE = /^[a-z][a-z0-9_]{0,31}$/u;
export const RESERVED_ACTS = ['deploy', 'production-data', 'credentials', 'admin'];
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 4;

/** The three questions' instructions, as the goal states them. */
export const INSTRUCTIONS = Object.freeze({
  answer: 'Which option is the right way for this goal to proceed, given the goal, its contract and the decided standards in the state',
  fits: 'One of the options in `options` is a correct way for this goal to proceed',
  settled: 'The goal, its contract, the programme README or the technical standards in the state already decide which option is right, so no new product or policy decision by Martin is needed',
});

/** Goal-less sessions use the same questions, phrased for the work at hand. */
export const WORK_INSTRUCTIONS = Object.freeze({
  answer: 'Which option is the right way for this work to proceed, given the evidence and decided standards in the state',
  fits: 'One of the options in `options` is a correct way for this work to proceed',
  settled: 'The programme or technical standards in the state already decide which option is right, so no new product or policy decision by Martin is needed',
});

/** The ledger: one JSON line per `mc ask` or `mc goal martin` call. */
export function ledgerPath(mcHomeDir) {
  return join(mcHomeDir, 'jev', 'decisions.jsonl');
}

/** A line appended to the ledger, its directory made when it is not there. */
export function appendLedgerLine(path, line) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, line);
}

/**
 * A complete, correct call, for a return instruction: the session reads what
 * was wrong and calls again.
 */
export function exampleCall(goal = '<programme>/<goal>') {
  return [
    `  mc goal martin ${goal} --reason "Which timer should the timeout test use?" \\`,
    '    --option "fake_timer: inject a timer that fires at once, as the goal\'s deterministic clock asks" \\',
    '    --option "real_wait: wait the full 15 seconds in the test" \\',
    '    --recommend fake_timer --evidence "criterion 2: no real waits over 1 s"',
  ].join('\n');
}

/** The return instruction for a call that is refused: what is wrong, an example, and to call again. */
export function returnInstruction(problems, goal, lead = 'mc: goal martin is not called') {
  return [
    `${lead} — ${problems.join('; ')}. Nothing was written.`,
    'mc goal martin asks jev before Martin: --reason is the question, --option "<key>: <text>" is given 2 to 4 times',
    '(keys: a lower-case letter, then up to 31 of a-z, 0-9 and _, each once), --recommend names one key;',
    '--evidence "…" or --evidence-file <path|->, --document <repo>/<path> and --reserved deploy|production-data|credentials|admin are optional.',
    'For example:',
    exampleCall(goal),
    'Call mc goal martin again with this fixed; when jev answers, continue with its answer.',
    '',
  ].join('\n');
}

/**
 * The call's question, options and recommendation, checked: `{ question,
 * options: { key: text }, recommend, reserved }`, or `{ problems }` naming each
 * thing wrong.
 */
export function readMartinCall({ reason, option = [], recommend, reserved }) {
  const problems = [];
  const question = typeof reason === 'string' ? reason.trim() : '';
  if (!question) problems.push('--reason "<the question>" is required');
  const options = {};
  if (option.length < MIN_OPTIONS || option.length > MAX_OPTIONS) {
    problems.push(`--option is given ${MIN_OPTIONS} to ${MAX_OPTIONS} times, not ${option.length}`);
  }
  for (const given of option) {
    const at = given.indexOf(':');
    const key = at < 0 ? given.trim() : given.slice(0, at).trim();
    const text = at < 0 ? '' : given.slice(at + 1).trim();
    if (at < 0 || !text) { problems.push(`--option "${given}" is not "<key>: <text>"`); continue; }
    if (!KEY_RE.test(key)) { problems.push(`option key "${key}" is not a lower-case letter followed by up to 31 of a-z, 0-9 and _`); continue; }
    if (Object.hasOwn(options, key)) { problems.push(`option key "${key}" is given twice`); continue; }
    options[key] = text;
  }
  if (recommend === null || recommend === undefined || !recommend.trim()) problems.push('--recommend <key> is required');
  else if (!Object.hasOwn(options, recommend.trim())) problems.push(`--recommend ${recommend} is not one of the option keys${Object.keys(options).length ? ` (${Object.keys(options).join(', ')})` : ''}`);
  if (reserved !== null && reserved !== undefined && !RESERVED_ACTS.includes(reserved)) problems.push(`--reserved is ${RESERVED_ACTS.join(', ')}, not ${reserved}`);
  if (problems.length) return { problems };
  return { question, options, recommend: recommend.trim(), reserved: reserved ?? null };
}

/** The values of the keys source that are redacted: every one of `REDACT_MIN` characters or more, longest first. */
export function secretsOf(values) {
  return [...new Set(Object.values(values ?? {}).filter((value) => typeof value === 'string' && value.length >= REDACT_MIN))]
    .sort((a, b) => b.length - a.length);
}

/** `text` with every secret replaced by `[redacted]`. */
export function redactText(text, secrets) {
  let out = String(text);
  for (const secret of secrets) out = out.split(secret).join(REDACTED);
  return out;
}

/** A JSON value with every string in it (keys too) redacted. */
export function redactValue(value, secrets) {
  if (!secrets.length) return value;
  if (typeof value === 'string') return redactText(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, secrets));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [redactText(key, secrets), redactValue(item, secrets)]));
  }
  return value;
}

const size = (value) => JSON.stringify(value).length;

/**
 * The state sent to jev, within `budget` characters serialized:
 * `{ state, text, trimmed }`, or `{ problems }` when the core alone — question,
 * options, evidence, goal — is over it. Trimmed in this order: the oldest log
 * entries, then documents largest first (cut, ending `[truncated]`), then the
 * programme README, then documents dropped whole,
 * largest first if still needed. `trimmed` names each part cut or dropped.
 * Every string is redacted first, so the budget holds for what is sent.
 */
export function buildState({ question, options, evidence, goal, programme, documents, log }, { secrets = [], budget = STATE_BUDGET } = {}) {
  const state = redactValue({
    question, options, evidence: evidence ?? '', goal,
    programme: { readme: programme?.readme ?? null },
    documents: documents ?? [], log: (log ?? []).slice(-LOG_ENTRIES),
  }, secrets);
  const core = { question: state.question, options: state.options, evidence: state.evidence, goal: state.goal };
  if (size(core) > budget) {
    return { problems: [`the question, options, evidence and goal alone are ${size(core)} characters serialized, over jev's budget of ${budget}: shorten the question, the options or the evidence`] };
  }
  const trimmed = [];
  let dropped = 0;
  while (size(state) > budget && state.log.length) { state.log.shift(); dropped += 1; }
  if (dropped) trimmed.push(`log: ${dropped} oldest ${dropped === 1 ? 'entry' : 'entries'} left out`);
  const cut = (holder, field, name) => {
    const over = size(state) - budget;
    if (over <= 0 || typeof holder[field] !== 'string' || holder[field] === TRUNCATED) return;
    const keep = Math.max(0, holder[field].length - over - TRUNCATED.length - 16);
    holder[field] = `${holder[field].slice(0, keep)}${TRUNCATED}`;
    // JSON escapes can make the cut fall short: cut again until it fits or nothing is left.
    while (size(state) > budget && holder[field] !== TRUNCATED) {
      const body = holder[field].slice(0, -TRUNCATED.length);
      holder[field] = `${body.slice(0, Math.max(0, body.length - (size(state) - budget) - 1))}${TRUNCATED}`;
    }
    if (!trimmed.includes(name)) trimmed.push(name);
  };
  const bySize = [...state.documents].sort((a, b) => size(b) - size(a));
  for (const document of bySize) cut(document, 'text', `document ${document.path} truncated`);
  cut(state.programme, 'readme', 'programme README truncated');
  for (const document of bySize) {
    if (size(state) <= budget) break;
    state.documents.splice(state.documents.indexOf(document), 1);
    trimmed.push(`document ${document.path} dropped`);
  }
  const text = JSON.stringify(state);
  if (text.length > budget) return { problems: [`the state is ${text.length} characters serialized after trimming, over jev's budget of ${budget}: shorten the question, the options or the evidence`] };
  return { state, text, trimmed };
}

/** The request body: the pinned model, the state, and the three questions. */
export function requestBody(state, options, instructions = INSTRUCTIONS) {
  return {
    model: JEV_MODEL,
    state,
    questions: {
      answer: { type: 'choice', instructions: instructions.answer, criteria: { ...options } },
      fits: { type: 'noul', instructions: instructions.fits },
      settled: { type: 'noul', instructions: instructions.settled },
    },
  };
}

/** The real transport: Node's `fetch`, never in a test run (`NODE_TEST_CONTEXT`). */
export function defaultTransport(url, init) {
  if (process.env.NODE_TEST_CONTEXT) return Promise.reject(new Error('no live jev request in a test run'));
  return fetch(url, init);
}

/** A real wait of `ms`, which does not hold the process open. */
export function defaultSleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); });
}

/** A `retry-after` header's wait in milliseconds, at most `RETRY_AFTER_MAX_MS`. */
export function retryAfterMs(header, now = Date.now()) {
  if (header === null || header === undefined || header === '') return RETRY_DEFAULT_MS;
  const seconds = Number(header);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - now;
  if (!Number.isFinite(ms)) return RETRY_DEFAULT_MS;
  return Math.min(RETRY_AFTER_MAX_MS, Math.max(0, ms));
}

const TIMED_OUT = Symbol('timed out');

/**
 * One request to jev, with one retry on 429 or 5xx: `{ response }` (the parsed
 * body of a 2xx), or `{ unavailable: reason }`. `transport(url, init)` is
 * fetch's shape; `sleep(ms)` waits for a retry; `timer(ms)` resolves when an
 * attempt has run out of time. Never throws.
 */
export async function askJev({ body, key, transport = defaultTransport, sleep = defaultSleep, timer = defaultSleep }) {
  if (!key) return { unavailable: `no ${JEV_KEY} in the mc keys source` };
  const init = () => ({
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  for (let attempt = 1; ; attempt += 1) {
    const controller = new AbortController();
    let answer;
    try {
      const timed = Promise.resolve(timer(TIMEOUT_MS)).then(() => TIMED_OUT);
      answer = await Promise.race([
        Promise.resolve(transport(JEV_URL, { ...init(), signal: controller.signal })).then(async (response) => {
          if (Number(response?.status) >= 200 && Number(response?.status) < 300) {
            try { return { status: response.status, headers: response.headers, bodyText: await response.text() }; }
            catch (error) { return { status: response.status, bodyError: oneLine(error?.message || error) }; }
          }
          return response;
        }),
        timed,
      ]);
    } catch (error) {
      return { unavailable: `network error (${oneLine(error?.message || error)})` };
    }
    if (answer === TIMED_OUT) { controller.abort(); return { unavailable: `no answer in ${TIMEOUT_MS / 1000} seconds` }; }
    const status = Number(answer?.status);
    if (status >= 200 && status < 300) {
      if (answer.bodyError) return { unavailable: `malformed response (${answer.bodyError})` };
      try { return { response: JSON.parse(answer.bodyText) }; } catch { return { unavailable: 'malformed response (not JSON)' }; }
    }
    const retryable = status === 429 || (status >= 500 && status < 600);
    if (!retryable || attempt > 1) return { unavailable: `HTTP ${status || 'no status'}${attempt > 1 ? ' after one retry' : ''}` };
    await sleep(retryAfterMs(answer.headers?.get?.('retry-after') ?? null));
  }
}

const isProbability = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;

/**
 * jev's answers read from a response: `{ answers, model }`, or `{ unavailable }`
 * when the response is malformed or the choice is not an option key.
 */
export function readAnswers(response, options) {
  const answer = response?.answers?.answer;
  const fits = response?.answers?.fits?.noul;
  const settled = response?.answers?.settled?.noul;
  if (typeof response?.model !== 'string' || !answer || typeof answer.choice !== 'string'
      || !answer.probabilities || typeof answer.probabilities !== 'object' || !isProbability(fits) || !isProbability(settled)) {
    return { unavailable: 'malformed response (no model, answer, fits or settled)' };
  }
  if (!Object.hasOwn(options, answer.choice)) return { unavailable: `unknown choice ${JSON.stringify(answer.choice).slice(0, 40)}` };
  const probability = answer.probabilities[answer.choice];
  if (!isProbability(probability)) return { unavailable: 'malformed response (no probability for the choice)' };
  return {
    model: response.model,
    answers: {
      answer: { choice: answer.choice, probabilities: answer.probabilities, confidence: answer.confidence ?? null },
      fits, settled,
    },
  };
}

/**
 * Whether jev answers: `{ outcome: 'answered' }` when its choice is the
 * recommendation at `THRESHOLDS.choice` or more and both Nouls meet theirs,
 * else `{ outcome: 'martin', misses }` naming each condition that failed.
 */
export function judge(answers, recommend) {
  const { choice, probabilities } = answers.answer;
  const misses = [];
  if (choice !== recommend) misses.push(`chose ${choice}, not the recommendation ${recommend}`);
  if (!(probabilities[choice] >= THRESHOLDS.choice)) misses.push(`p ${fixed(probabilities[choice])} < ${fixed(THRESHOLDS.choice)}`);
  if (!(answers.fits >= THRESHOLDS.fits)) misses.push(`fits ${fixed(answers.fits)} < ${fixed(THRESHOLDS.fits)}`);
  if (!(answers.settled >= THRESHOLDS.settled)) misses.push(`settled ${fixed(answers.settled)} < ${fixed(THRESHOLDS.settled)}`);
  return misses.length ? { outcome: 'martin', misses } : { outcome: 'answered', misses };
}

/** jev's reading, in one line: `<choice> (p …, fits …, settled …, <model>)`. */
export function reading(answers, model) {
  const { choice, probabilities } = answers.answer;
  return `${choice} (p ${fixed(probabilities[choice])}, fits ${fixed(answers.fits)}, settled ${fixed(answers.settled)}, ${model})`;
}

export function fixed(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(2) : String(value);
}

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

/** A path as it is written: absolute as given, `~/…` under HOME, else under the goal's directory (`<repo>/<path>`). */
export function documentPath(path, { goalDir, home }) {
  if (path.startsWith('~/') && home) return join(home, path.slice(2));
  return isAbsolute(path) ? path : join(goalDir, path);
}

function oneLine(text) {
  return String(text).replace(/\s+/gu, ' ').trim().slice(0, 200);
}
