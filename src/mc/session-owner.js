/**
 * Whose a session is. Every session belongs to a programme — a build or
 * review the runner starts, a project opened from the
 * page — or to a desk: the desk (`mc martin`), or the eye's intake turn, which keeps the name `helper`. There is no third kind
 * (goal mc/no-work, Martin 2026-11-03: *"sessioner hör alltid till ett
 * program eller så är det t ex BRIEF"*).
 *
 * The page reads it off the foreground register (`sessionsSection`), and the
 * launcher asks it before anything starts (`openInWorkArea`), so a session mc
 * would start for nobody is refused rather than drawn as a stray afterwards.
 */
/** The singleton desks, drawn whether or not anybody is at them. */
export const DESKS = Object.freeze(['helper', 'manager', 'martin']);

/**
 * `{ kind: 'desk', name }` for the desks and the eye's intake turn (verb `helper`), `{ kind:
 * 'programme', name }` for a project opened from the page, and
 * null for anything else.
 */
export function ownerOf(item) {
  if (item?.verb === 'brief') return { kind: 'desk', name: 'manager' };
  if (DESKS.includes(item?.verb)) return { kind: 'desk', name: item.verb };
  if (item?.verb === 'project' && item.programme) return { kind: 'programme', name: item.programme };
  return null;
}

/** What a launch with no owner is told: what it should belong to. */
export const OWNERLESS_HINT = 'a session belongs to a programme (a project\'s number on the page) or to the desk (mc martin)';
