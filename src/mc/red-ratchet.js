/**
 * The standing red, written down where a reviewer can see it.
 *
 * The gate is differential: it compares the candidate's red set against a
 * fresh baseline and lets a change through when nothing went red that was
 * green before. That is the right rule and it is not changed here. But it
 * says nothing at all about the red that was already there — and this
 * repository has been carrying 55 red names on main while every round printed
 * the word GREEN over them.
 *
 * Two things follow, and this module is both:
 *
 * **The number belongs in the repository.** Not in a person's memory and not
 * in mc's home, where nobody reviews it. `.mc/red-ratchet.json` is versioned,
 * diffable, and changes through a pull request like everything else that
 * describes the code.
 *
 * **It may only go down.** Without that, "nothing new went red" is an
 * invitation to add a fifty-sixth — differentially invisible, permanently
 * blind. A name that is already red cannot report a new bug in the same test,
 * so the standing red is not just debt: it is that many places where the suite
 * has stopped being able to tell anyone anything.
 *
 * ## It binds names, not the number
 *
 * A count moves under load. Measured twice hours apart on the same machine,
 * main gave 55 names and then 56, and the 56th was green again on the next
 * run — a load-sensitive test, not a regression. A ratchet on the number would
 * fail good pull requests at random, and a gate that fails at random stops
 * being read, which is worse than the word it was fixing.
 *
 * So the ratchet binds the *set of names*. A rise is a name that was not in
 * the set, never a total that went up, and when it fires it says which name.
 * That turns the load-sensitive case from a recurring random failure into one
 * reviewable line added once: the name is now known, and it never fires for
 * that name again. Names carry information; a number does not.
 *
 * ## mc does not write it
 *
 * The merge round writes a line to the merge log, but that log lives outside
 * every repository. Committing to a product repository's main is a different
 * act, and mc does not do it — so when the set shrinks the gate says exactly
 * which names to drop and what the file should say, and a person lands that in
 * a pull request like any other change. A ratchet loosened by a machine is not
 * a ratchet; the deliberate commit is the point, not a limitation.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Where it lives, relative to the root of the repository it describes. */
export const RATCHET_PATH = '.mc/red-ratchet.json';

/**
 * Read the ratchet out of a checkout.
 *
 * Read from the *candidate* by the gate, not from the baseline: the file
 * describes what main's standing red will be once this lands, so a pull
 * request whose whole purpose is to acknowledge a new red name has to be able
 * to say so and pass. Reading the baseline's copy would make that pull request
 * the one thing the ratchet could never accept.
 *
 * A repository without the file has not adopted the ratchet. That is a
 * reported state, never a failure: the day this ships, no repository has one,
 * and a gate that stopped on a missing file would stop every round everywhere.
 */
export function readRatchet(checkoutDir) {
  const path = join(checkoutDir, RATCHET_PATH);
  let text = null;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return { adopted: false, names: [], standing_red: null, malformed: null, path: RATCHET_PATH };
  }

  let value = null;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { adopted: true, names: [], standing_red: null, path: RATCHET_PATH, malformed: `it is not JSON (${error?.message || 'parse failed'})` };
  }
  if (!value || typeof value !== 'object' || !Array.isArray(value.names)) {
    return { adopted: true, names: [], standing_red: null, path: RATCHET_PATH, malformed: 'it has no "names" array' };
  }

  const names = value.names.map((name) => String(name));
  const declared = Number(value.standing_red);
  // The number and the names have to agree. A file claiming 55 over a list of
  // 54 is the exact confusion this whole change exists to remove, and letting
  // it through would put that confusion inside the fix.
  if (!Number.isInteger(declared) || declared !== names.length) {
    return {
      adopted: true,
      names,
      standing_red: null,
      path: RATCHET_PATH,
      malformed: `"standing_red" is ${value.standing_red ?? 'missing'} but there are ${names.length} names — the number has to be the names it is made of`,
    };
  }
  return { adopted: true, names, standing_red: declared, malformed: null, path: RATCHET_PATH };
}

/**
 * The ratchet's verdict on one round.
 *
 * `measured` is the candidate's red set — what main's standing red becomes if
 * this lands. `rose` is what the ratchet forbids; `fell` is the direction it
 * exists to allow, and decides nothing.
 *
 * **A repository that has not adopted it is not judged by it.** The first
 * version of this bound every round whether or not the file existed, and it
 * failed the gate's own suite immediately: on the day this ships no repository
 * has the file, so a ratchet that binds in its absence stops every merge
 * everywhere, including the pull request that would introduce it. Adoption is
 * a commit somebody makes.
 *
 * A file that exists and cannot be read is the other way round: it does bind,
 * by stopping the round. A broken guard that waves things through is not a
 * guard, and there is no deadlock in stopping — the ratchet is read from the
 * candidate, so the pull request that repairs the file is exactly the one that
 * passes.
 */
export function compareRatchet({ recorded, measured }) {
  const known = new Set(recorded.names || []);
  const now = new Set(measured);
  const binding = recorded.adopted && !recorded.malformed;
  return {
    adopted: recorded.adopted,
    malformed: recorded.malformed || null,
    path: recorded.path,
    recorded_count: recorded.standing_red,
    standing_red: measured.length,
    /**
     * The file, ready to paste, for whoever has to write it.
     *
     * Carried in `--json` rather than printed: fifty-five names in a terminal
     * is not "saying exactly what to do", it is burying it. What the page
     * shows is what *changed*, which is the part a person judges.
     */
    file_text: ratchetFileText(measured),
    rose: binding ? measured.filter((name) => !known.has(name)) : [],
    fell: binding ? (recorded.names || []).filter((name) => !now.has(name)) : [],
    /** The one thing the gate has to test: does this stop the round? */
    blocks: Boolean(recorded.adopted && recorded.malformed)
      || (binding && measured.some((name) => !known.has(name))),
  };
}

/**
 * What the file should say after this round — the whole of it, ready to paste.
 *
 * Printed rather than written. Somebody reads the names before they land, and
 * a diff of names is a thing a reviewer can actually judge.
 */
export function ratchetFileText(measured) {
  const names = [...measured].sort((a, b) => a.localeCompare(b));
  return `${JSON.stringify({ standing_red: names.length, names }, null, 2)}\n`;
}

/**
 * What a round says about the ratchet, as lines.
 *
 * Every branch names names. The one thing this must never print is a bare
 * number with an instruction attached: the whole reason the ratchet binds
 * names is so a person can look at what changed and recognise a known
 * load-sensitive test instead of nodding at an increment.
 */
export function ratchetLines(ratchet, { limit = 20 } = {}) {
  const lines = [];
  if (!ratchet) return lines;

  if (ratchet.malformed) {
    lines.push(`mc: RATCHET — ${ratchet.path} exists and cannot be read: ${ratchet.malformed}`);
    lines.push(`mc: the round measured ${ratchet.standing_red} standing red, and will not guess what the file meant`);
    lines.push(`mc: repair ${ratchet.path} — the round reads it from the candidate, so the fix passes`);
    return lines;
  }

  if (!ratchet.adopted) {
    lines.push(`mc: no ${ratchet.path} — this repository has not adopted the red ratchet`);
    lines.push(`mc: ${ratchet.standing_red} standing red would be recorded, and could then only go down`);
    lines.push(`mc: --json carries the file to write, measured by this round rather than by hand`);
    return lines;
  }

  if (ratchet.rose.length) {
    lines.push(`mc: RATCHET — ${ratchet.rose.length} red name${ratchet.rose.length === 1 ? '' : 's'} not in ${ratchet.path}:`);
    for (const name of ratchet.rose.slice(0, limit)) lines.push(`      ${name}`);
    if (ratchet.rose.length > limit) lines.push(`      … and ${ratchet.rose.length - limit} more`);
    // Said plainly, because the pull request in front of the gate is almost
    // never the cause: nothing red on the baseline is this change's doing.
    // It is being stopped as the messenger, and it should know that.
    lines.push('mc: these are red on main too, so this is main getting worse rather than this change breaking it');
    lines.push(`mc: acknowledge them in ${ratchet.path} — one reviewable commit — and the round passes`);
    return lines;
  }

  if (ratchet.fell.length) {
    lines.push(`mc: ratchet — ${ratchet.fell.length} recorded name${ratchet.fell.length === 1 ? ' is' : 's are'} green here:`);
    for (const name of ratchet.fell.slice(0, limit)) lines.push(`      ${name}`);
    if (ratchet.fell.length > limit) lines.push(`      … and ${ratchet.fell.length - limit} more`);
    lines.push(`mc: ${ratchet.path} should say ${ratchet.standing_red} — drop them in a commit, and the standing red goes down for good`);
    lines.push('mc: --json carries the whole file as it should now read');
    return lines;
  }

  lines.push(`mc: ratchet — ${ratchet.standing_red} standing red, unchanged and all of them recorded`);
  return lines;
}
