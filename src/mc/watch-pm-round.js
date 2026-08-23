/**
 * The round (designnote §3) — a script, and never a model.
 *
 * Every half hour: version what PM wrote, ask `mc doctor` how the machine is,
 * count what is unread in PM's inbox, take whatever the guard left in the
 * ledger, and knock once if any of that is worth saying. A failing step does
 * not stop the others — a git repository that will not commit is no reason to
 * stop counting an inbox.
 *
 * Three things here are decisions rather than preferences, and each one is a
 * line of code you could delete without a test failing if it were not written
 * down:
 *
 *  - **Wake on change, not on presence.** A knock happens when the set of
 *    unprocessed items gains a member. An item still sitting there on the
 *    third pass earns one reminder and then silence: it is in the log after
 *    that, not in the prompt. A nagger is read once and then never again.
 *  - **It decides nothing about the content.** It counts files and names
 *    them. It does not open them, triage them or summarise them — triage is
 *    PM's (K5.1), and a round that formed an opinion would be a round that
 *    needed a model to form it.
 *  - **It costs nothing when nothing happened.** No model turn, ever. An
 *    empty inbox and a quiet ledger is a handful of filesystem calls: a model
 *    woken every thirty minutes to look in an empty folder is the most
 *    expensive possible implementation of an `if` statement (D-0102).
 *
 * `delivered, but did not knock` is a normal outcome, not a failure. The
 * client guard (#341/#346/#348) refuses to type into a pane somebody is
 * attached to, or one whose prompt is not empty, and delivers the file
 * anyway. The message is the delivery; the knock is only latency.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

import { writeJsonAtomic } from './atomic-write.js';
import { diagnose } from './commands/doctor.js';
import { markDelivered, pendingNotices } from './watch-notices.js';
import { deliveryLines, undeliveredOrders } from './watch-pm-deliveries.js';
import { mcHome, workAreaPath } from './paths.js';
import { pmRoundStatePath } from './watch-paths.js';
import { sendToArea } from './work-send.js';

export const ROUND_SCHEMA = 'mc-watch-pm';
export const ROUND_VERSION = 1;

/** Half an hour, which is what the order says and what a flag can change. */
export const DEFAULT_INTERVAL_MS = 30 * 60 * 1000;

/**
 * How many passes an item may sit unprocessed before its one reminder.
 *
 * Three passes is ninety minutes at the default interval. The number is
 * passes rather than minutes on purpose: run the round every five minutes to
 * watch it work and the reminder still arrives on the third pass, so the rule
 * under test is the rule in production.
 */
export const REMINDER_PASS = 3;

/** The knock names files; past this many it says how many it did not name. */
const NAMED_LIMIT = 12;

/**
 * Who the message is from.
 *
 * Fixed rather than read from the working directory: the round runs detached,
 * from wherever it was started, and `currentHolder()` would sign PM's inbox
 * with whatever shell happened to launch the daemon.
 */
const SENDER = Object.freeze({ name: 'mc watch pm', kind: 'watcher' });

/**
 * One pass. Everything is injectable because a thirty-minute round has to be
 * testable in a millisecond: the clock, the channel, the diagnosis and the
 * area are all arguments, and the suite runs no daemon at all.
 */
export async function pmRound({
  root = mcHome(),
  env = process.env,
  area = 'pm',
  now = new Date(),
  send = sendToArea,
  doctor = diagnose,
  deliveries = undeliveredOrders,
  log = () => {},
} = {}) {
  const areaPath = workAreaPath(area, env);
  // Whether a knock was tried at all, which is not the same question as
  // whether one succeeded: a knock that threw left `outcome.knock` null, and
  // reading that as "nothing to say" would mark an item announced that
  // nobody was ever told about.
  let attempted = false;
  const outcome = {
    at: now.toISOString(),
    area,
    commit: null,
    doctor: null,
    inbox: null,
    notices: [],
    orders: [],
    knock: null,
    failed: [],
  };

  outcome.commit = attempt(outcome, 'commit', () => commitRoleHome(areaPath, now));
  outcome.doctor = attempt(outcome, 'doctor', () => {
    const result = doctor({ deps: {} });
    return { ok: Boolean(result?.ok), issues: (result?.issues || []).length };
  });
  const inbox = attempt(outcome, 'inbox', () => readInbox(areaPath, area));
  outcome.inbox = inbox ? { count: inbox.items.length, oldest: inbox.items[0]?.at || null, reason: inbox.reason } : null;
  outcome.notices = attempt(outcome, 'notices', () => pendingNotices({ root })) || [];
  // The delivery check (D-0170): an order line in an archived msr-design
  // report that never reached its track. A check PM has to remember to run
  // is the same kind of note as the fault it would catch (D-0113), so it
  // runs here, every pass, and is quiet when everything is delivered.
  outcome.orders = attempt(outcome, 'orders', () => deliveries({ env })) || [];

  const previous = readState(root);
  // Only a pass that actually read the directory may change what the round
  // remembers about it. An inbox mc could not open says nothing either way.
  const reachable = Boolean(inbox) && inbox.reason === null;
  const change = decide(inbox?.items || [], previous.items || {}, { reachable });
  // The same wake-on-change bookkeeping for undelivered orders as for inbox
  // items: an order newly found undelivered knocks now, one still sitting
  // there earns one reminder, and a delivered one is forgotten. The name is
  // the order's own key, so the same order in the same report is one item
  // however many passes look at it.
  const orderItems = outcome.orders.map((order) => ({ name: `${order.source} → msr-track-${order.track}: ${order.excerpt}`, at: order.at || outcome.at }));
  const undelivered = decide(orderItems, previous.orders || {}, { reachable: true });

  // The one place a pass can decide to cost somebody a turn. Everything above
  // is filesystem; this is the whole of what the round asks of PM.
  const worthSaying = change.fresh.length > 0 || change.reminders.length > 0 || outcome.notices.length > 0
    || undelivered.fresh.length > 0 || undelivered.reminders.length > 0;
  if (worthSaying) {
    attempted = true;
    outcome.knock = await attemptAsync(outcome, 'knock', () => knock({
      send,
      area,
      items: inbox?.items || [],
      fresh: change.fresh,
      reminders: change.reminders,
      notices: outcome.notices,
      orders: outcome.orders,
      doctor: outcome.doctor,
    }));
  }

  // The state advances only when the round is sure PM has the message. A
  // knock that could not even write the file leaves the items unseen, so the
  // next pass calls them new again — the alternative is an item that was
  // never announced and never will be. The timestamp advances either way:
  // that is the round saying it ran, which `mc watch pm status` reads.
  const delivered = !attempted || Boolean(outcome.knock?.ok);
  const items = delivered ? change.items : previous.items || {};
  const orders = delivered ? undelivered.items : previous.orders || {};
  if (delivered && outcome.knock?.file) remember(items, basename(outcome.knock.file), outcome.at);
  // The last knock, kept apart from the last round: "nothing to say" for
  // six passes is not the same as "the last knock was refused", and the
  // board could not tell them apart for a day (B5).
  const lastKnock = outcome.knock
    ? { at: outcome.at, woke: Boolean(outcome.knock.woke), delivered: Boolean(outcome.knock.ok), reason: outcome.knock.woke ? null : outcome.knock.reason || null }
    : previous.last_knock || null;
  attempt(outcome, 'state', () => writeState(root, { at: outcome.at, items, orders, last_round: summary(outcome), last_knock: lastKnock }));

  if (delivered && outcome.knock?.ok) {
    for (const notice of outcome.notices) {
      attempt(outcome, 'ledger', () => markDelivered(notice.id, { root, now }));
    }
  }

  log(summary(outcome));
  return outcome;
}

/**
 * Step 1 — version what PM wrote, and never write in it.
 *
 * `role-home.js` guarantees the PM home is a git repository and says in as
 * many words that committing on every heartbeat is the skeleton's job (step
 * 4). This is step 4. It stages and commits; it creates no file, edits no
 * file and resolves no conflict. A commit is not an edit, and the distinction
 * is the whole reason mc is allowed near PM's decision files at all.
 *
 * The identity is fixed for the same reason `ensureRoleHome` fixes it: the
 * commit is mc's act, and a machine with no `user.email` must not turn PM's
 * memory into an unversioned directory.
 */
export function commitRoleHome(areaPath, now = new Date()) {
  if (!existsSync(areaPath)) return { committed: false, reason: 'no-such-area' };
  if (!existsSync(join(areaPath, '.git'))) return { committed: false, reason: 'not-a-repository' };
  git(areaPath, ['add', '-A']);
  const staged = git(areaPath, ['diff', '--cached', '--name-only']).trim();
  if (staged === '') return { committed: false, reason: 'nothing-changed' };
  git(areaPath, [
    '-c', 'user.name=mc', '-c', 'user.email=mc@memoro.local',
    'commit', '-q', '-m', `mc watch pm: round ${now.toISOString()}`,
  ]);
  return {
    committed: true,
    files: staged.split('\n').length,
    id: git(areaPath, ['rev-parse', '--short', 'HEAD']).trim(),
  };
}

/**
 * Step 3 — what is unprocessed.
 *
 * Files at the top level, excluding `README.md` and directories. Archiving to
 * `inbox/archive/` is what makes an item processed, so a directory is by
 * definition not an item and the marker README that says what the directory is
 * for is not one either.
 *
 * Age is the file's modification time. The names mc writes carry a timestamp
 * of their own, but a message dropped in by hand or copied from elsewhere does
 * not, and one rule that answers for every file beats two that answer for
 * different ones.
 */
export function readInbox(areaPath, area = 'pm', { own = isOwnMessage } = {}) {
  const directory = join(areaPath, 'inbox');
  let entries = [];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    // Unreadable is not empty, and the difference decides whether the round
    // forgets what it has already announced. A directory that is missing this
    // pass and back the next must not turn the whole inbox into new arrivals.
    return {
      items: [],
      reason: error?.code === 'ENOENT' ? `no ${area}/inbox/` : `${area}/inbox/ could not be read (${error?.code || 'unknown'})`,
    };
  }
  const items = entries
    .filter((entry) => entry.isFile() && entry.name !== 'README.md' && !entry.name.startsWith('.'))
    // The round's own knocks are not PM's work (B3, 2026-08-23: five files
    // in ninety seconds whose whole content was the list of the other four).
    .filter((entry) => !own(join(directory, entry.name)))
    .map((entry) => ({ name: entry.name, at: modified(join(directory, entry.name)) }))
    .sort((a, b) => (a.at === b.at ? a.name.localeCompare(b.name) : a.at.localeCompare(b.at)));
  return { items, reason: null };
}

/**
 * Is this file one of the round's own knocks?
 *
 * Answered by the sender line the channel writes as the first thing in
 * every message, not by the filename — a round recognising its own messages
 * by how they are named would be a second copy of `work-send.js`'s naming
 * rule. Reading two lines of frontmatter is not opening the item: the round
 * still forms no opinion about what anything is about.
 */
export function isOwnMessage(path) {
  try {
    const head = readFileSync(path, 'utf8').slice(0, 200);
    return head.startsWith('---\n') && head.includes(`\nfrom: ${SENDER.name}\n`);
  } catch { return false; }
}

/**
 * Wake on change — the bookkeeping that makes it true.
 *
 * An item mc has not seen before is new and is worth a knock. An item on its
 * `REMINDER_PASS`-th pass earns one reminder, once, and is then quiet for as
 * long as it sits there. An item that has gone is forgotten, and if it comes
 * back it is new again — which is correct: PM archived it, so its return is a
 * second arrival rather than the same one lingering.
 *
 * An inbox that could not be read at all returns the previous bookkeeping
 * untouched. Otherwise a directory that vanished for one pass would forget
 * everything and announce the whole inbox as new on the next.
 */
export function decide(items, previous, { reachable = true } = {}) {
  if (!reachable) return { items: previous, fresh: [], reminders: [] };
  const next = {};
  const fresh = [];
  const reminders = [];
  for (const item of items) {
    const seen = previous[item.name];
    if (!seen) {
      next[item.name] = { first_seen_at: item.at, passes: 1, reminded: false };
      fresh.push(item.name);
      continue;
    }
    const passes = (Number(seen.passes) || 0) + 1;
    const record = {
      first_seen_at: seen.first_seen_at || item.at,
      passes,
      reminded: Boolean(seen.reminded),
    };
    if (passes >= REMINDER_PASS && !record.reminded) {
      record.reminded = true;
      reminders.push(item.name);
    }
    next[item.name] = record;
  }
  return { items: next, fresh, reminders };
}

/**
 * The message, and the one thing it must never contain.
 *
 * A count, a timestamp, filenames, and what the guard said in the guard's own
 * words. Nothing about what any of it is about: the round has not opened a
 * single one of these files and is in no position to say.
 */
export function knockText({
  area = 'pm', items = [], fresh = [], reminders = [], notices = [], orders = [], doctor = null,
} = {}) {
  const lines = [];
  // Undelivered orders first: an inbox count is housekeeping, a track
  // standing blocked on an order that exists is the evening lost (D-0170).
  if (orders.length) {
    lines.push(`${orders.length} order${orders.length === 1 ? '' : 's'} from msr-design ${orders.length === 1 ? 'has' : 'have'} not reached ${orders.length === 1 ? 'its' : 'their'} track:`);
    for (const line of deliveryLines(orders)) lines.push(`  ${line}`);
  }
  if (items.length) {
    if (lines.length) lines.push('');
    const plural = items.length === 1 ? 'item' : 'items';
    lines.push(`${items.length} unprocessed ${plural} in ${area}/inbox/, oldest ${minute(items[0].at)}`);
    // What is new and what is reminded about, by name; the rest as a count.
    // A knock that listed the whole inbox every time was, five times in
    // ninety seconds, a list of the four knocks before it (B3).
    const named = items.filter((item) => fresh.includes(item.name) || reminders.includes(item.name));
    for (const item of named.slice(0, NAMED_LIMIT)) {
      lines.push(`  ${mark(item.name, fresh, reminders)}  ${item.name}`);
    }
    // A cap that says nothing is a cap that reads as "that was all of them".
    if (named.length > NAMED_LIMIT) lines.push(`  ${'...'.padEnd(8)}  and ${named.length - NAMED_LIMIT} more new, not named here`);
    const older = items.length - named.length;
    if (older > 0) lines.push(`  ${'waiting'.padEnd(8)}  ${older} older, already announced`);
  }
  if (notices.length) {
    if (lines.length) lines.push('');
    lines.push(`${notices.length} ${notices.length === 1 ? 'notice' : 'notices'} from the guard:`);
    for (const notice of notices) {
      lines.push(`  ${notice.session}  ${notice.pattern}${notice.detail ? ` — ${notice.detail}` : ''}`);
    }
  }
  if (doctor && doctor.ok === false) {
    if (lines.length) lines.push('');
    lines.push(`mc doctor: ${doctor.issues} ${doctor.issues === 1 ? 'issue' : 'issues'} — mc doctor to read them`);
  }
  return lines.join('\n');
}

async function knock({ send, area, items, fresh, reminders, notices, orders, doctor }) {
  const message = knockText({ area, items, fresh, reminders, notices, orders, doctor });
  const result = await send({ name: area, message, sender: SENDER, wake: true });
  return {
    ok: Boolean(result?.ok),
    woke: Boolean(result?.woke),
    reason: result?.reason || null,
    guard: Boolean(result?.guard),
    file: result?.file || null,
    fresh: fresh.length,
    reminders: reminders.length,
    notices: notices.length,
    orders: (orders || []).length,
  };
}

/** `2026-08-17T15:53Z` — the form the order names, to the minute. */
export function minute(at) {
  const value = String(at || '');
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})/u.exec(value);
  return match ? `${match[1]}Z` : value;
}

/**
 * One line per pass, for the log and for `mc watch pm status`.
 *
 * A pass that did nothing says so in a dozen words, which is what makes a
 * month of this file readable: the interesting rounds are the short ones'
 * neighbours.
 */
export function summary(outcome) {
  const parts = [];
  parts.push(outcome.commit?.committed
    ? `committed ${outcome.commit.files} ${outcome.commit.files === 1 ? 'file' : 'files'}`
    : `no commit (${outcome.commit?.reason || 'failed'})`);
  parts.push(outcome.doctor ? `doctor ${outcome.doctor.ok ? 'ok' : `${outcome.doctor.issues} issues`}` : 'doctor failed');
  if (!outcome.inbox) parts.push('inbox unreadable');
  else if (outcome.inbox.reason) parts.push(outcome.inbox.reason);
  else parts.push(`${outcome.inbox.count} unprocessed`);
  if (outcome.notices.length) parts.push(`${outcome.notices.length} notices`);
  if (outcome.orders?.length) parts.push(`${outcome.orders.length} undelivered order${outcome.orders.length === 1 ? '' : 's'}`);
  if (!outcome.knock) parts.push('nothing to say');
  else if (outcome.knock.woke) parts.push('knocked');
  else if (outcome.knock.ok) parts.push(`delivered, but did not knock: ${outcome.knock.reason || 'unknown'}`);
  else parts.push(`not delivered: ${outcome.knock.reason || 'unknown'}`);
  if (outcome.failed.length) parts.push(`failed: ${outcome.failed.map((f) => f.step).join(', ')}`);
  return parts.join(' · ');
}

/**
 * The round's own message is not news to the round.
 *
 * The channel is PM's inbox, so a knock lands there as a file like any other
 * — and on the next pass that file is a member the set did not have before.
 * Left alone, every knock would knock about the knock before it, for as long
 * as PM did not archive them: the exact nagger the wake-on-change rule exists
 * to prevent, arriving from inside.
 *
 * So the message is entered in the bookkeeping the moment it is written, as
 * something already seen and already reminded about. It still counts as
 * unprocessed and is still named, because it is unprocessed until PM archives
 * it and the count has to be honest. It simply never wakes anybody.
 *
 * The name comes from what the channel returned, not from a pattern: a round
 * recognising its own messages by how they are named would be a second copy
 * of `work-send.js`'s naming rule, and the day the two disagree is the day
 * the loop comes back.
 */
function remember(items, name, at) {
  items[name] = { first_seen_at: at, passes: REMINDER_PASS, reminded: true };
}

export function readState(root = mcHome()) {
  try {
    const value = JSON.parse(readFileSync(pmRoundStatePath(root), 'utf8'));
    return value && typeof value === 'object' ? value : {};
  } catch { return {}; }
}

/**
 * The round's memory, and a pass that could not write it says so.
 *
 * A state file that will not write is not fatal — the next pass tries again —
 * but it is not harmless either: every item in the inbox reads as new for as
 * long as it lasts. Swallowed, that is a round knocking every half hour with
 * nothing in the log to say why.
 */
function writeState(root, value) {
  writeJsonAtomic(pmRoundStatePath(root), {
    schema: ROUND_SCHEMA, version: ROUND_VERSION, ...value,
  });
  return true;
}

/**
 * Run one step, and let the others run whatever it does.
 *
 * The order says a failing step does not stop the others, and this is the
 * whole of that promise. What failed is carried in the outcome rather than
 * swallowed: a step that quietly returns null every pass for a week is the
 * failure mode a background process is famous for.
 */
function attempt(outcome, step, fn) {
  try {
    return fn();
  } catch (error) {
    outcome.failed.push({ step, error: error?.message || String(error) });
    return null;
  }
}

/** The same promise, for the one step that is asynchronous. */
async function attemptAsync(outcome, step, fn) {
  try {
    return await fn();
  } catch (error) {
    outcome.failed.push({ step, error: error?.message || String(error) });
    return null;
  }
}

function mark(name, fresh, reminders) {
  if (fresh.includes(name)) return 'new'.padEnd(8);
  if (reminders.includes(name)) return 'reminder';
  return 'waiting'.padEnd(8);
}

function modified(path) {
  try { return new Date(statSync(path).mtimeMs).toISOString(); } catch { return new Date(0).toISOString(); }
}

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
}
