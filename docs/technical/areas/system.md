# The system (mc)

The `mc` command, the runner, the merger, the gate, the roles, verbs and task references in `canon/`, and how mc sessions plan, build, review and land work. The source area of the system itself: what is striven for here, the decisions that hold and where the assets are. Nobody owns an area and no programme belongs to one. The index is memoro `docs/technical/README.md`, which names the pages of the other areas; the code and these standards are in memoro-cli.

## Aim

- "One developer drives many tracks at once: the work is delivered at high quality, the system maintains and improves itself, and only the right kind of question reaches him. This is a direction, not a finish line: the programme is not done because a piece of work is." (Martin, 2026-11-14; programme `mc`)

## Closer

Measured, with the baselines of 2026-11-14 (programme `mc`):

- No technical question waits on Martin. Baseline: of 22 non-reserved questions asked since 2026-11-12, 15 went to him, about half of them technical.
- No goal waits on Martin for a mechanical reason (a third failed merge, a session that ended early). Baseline: eight places in `src/mc/run.js` set `Martin` without a question.
- The same mistake is not made twice: a question Martin rejects, or a decision he overturns, changes the instructions. Baseline: nothing did this.
- No finding waits unread. Baseline: 282 proposals waited, and nothing woke for them until Martin opened a plan session.
- Every programme page says where it stands. Baseline: nearly every README described landed work as under way.
- Work lands the first time and is verified where users meet it. Baseline: 50 % of merge attempts passed first time, 4.4 sessions per goal, and done meant merged, not deployed and checked.

## Decisions

- Three kinds of thing reach Martin: a product choice, a judgement (look, listen, try) and a reserved act (deploy, money, credentials, production data). Every technical question is decided by the system, by the goal, the standards, the app's pattern and established practice, and reported afterwards in a record he can read and overturn; a question that established practice answers is never his, also when it concerns privacy, security or cost (Martin, 2026-11-14; programme `mc`).
- `mc martin` is his one way in: he reads no ledger, queue or programme page himself (Martin, 2026-11-14; programme `mc`).
- Learning has happened only when the code of how mc works, the prompts of the sessions or a technical standard in `docs/technical/` has changed on main, in that order of preference; a list of notes that grows is the failure (Martin, 2026-11-14; programme `mc`).
- A programme page keeps the future in sight: a programme with no open goal waits for its next horizon, it is not done (Martin, 2026-11-14; programme `mc`).
- Nobody owns an area and no programme belongs to one; areas are sources and references (Martin, 2026-11-15; programme `mc`).
- A horizon is always created in `mc martin`; the system never sets one. The manager's two tasks are to keep the area texts curated and to create new programmes (Martin, 2026-11-15; programme `horizon`).
- The order of the open horizons is the one priority, and candidates for new horizons are brought to the desk by the manager and become horizons only by Martin (Martin, 2026-11-15; programme `horizon`).
- The interactive `mc manager` entrance goes; a person's manual headless run stays (Martin, 2026-11-15; programme `horizon`).
- A deviation from an area text is repaired without a horizon, inside a ceiling that is a structure and not a figure: at most one such repair in flight per area, the rest wait in order; a figure is set when a month of use shows one is needed (Martin, 2026-11-15; programme `horizon`).
- Sessions have one way to ask for advice, `mc ask`, not several (Martin, 2026-11-15; programme `reach`).
- The only questions directed to Martin are those about a reformulation of an aim, and about strategy and design at that level (Martin, 2026-11-15; programme `mc`).
- A programme with a record is bounded: it is done when its goals are done and its write-back reads OK, and the system then archives it (Martin, 2026-11-15; programme `horizon`).

## Store

- `canon/` in memoro-cli: the roles, verbs and task pages that every session is started from.
- `.mc/areas.json` in each repository: the areas it declares, their standards, paths and questions. This page is the page of the source area `system`.
- The `~/mc` layout: programmes, archive, proposals, horizons, runner state and the desk's items, as [mc-layout.md](../mc-layout.md) describes it.

## Standards

- [mc-admin.md](../mc-admin.md)
- [mc-asc.md](../mc-asc.md)
- [mc-brief.md](../mc-brief.md)
- [mc-codebase.md](../mc-codebase.md)
- [mc-cut.md](../mc-cut.md)
- [mc-deploy.md](../mc-deploy.md)
- [mc-docker.md](../mc-docker.md)
- [mc-dormant.md](../mc-dormant.md)
- [mc-gate-evidence.md](../mc-gate-evidence.md)
- [mc-goals.md](../mc-goals.md)
- [mc-helper.md](../mc-helper.md)
- [mc-help.md](../mc-help.md)
- [mc-hooks.md](../mc-hooks.md)
- [mc-interactive-access.md](../mc-interactive-access.md)
- [mc-interactive-sessions.md](../mc-interactive-sessions.md)
- [mc-jev.md](../mc-jev.md)
- [mc-keys.md](../mc-keys.md)
- [mc-language.md](../mc-language.md)
- [mc-layout.md](../mc-layout.md)
- [mc-log.md](../mc-log.md)
- [mc-manager.md](../mc-manager.md)
- [mc-martin.md](../mc-martin.md)
- [mc-merge.md](../mc-merge.md)
- [mc-plan.md](../mc-plan.md)
- [mc-roles.md](../mc-roles.md)
- [mc-run.md](../mc-run.md)
- [mc-server.md](../mc-server.md)
- [mc-session-message-transport.md](../mc-session-message-transport.md)
- [mc-shared-deps.md](../mc-shared-deps.md)
- [mc-shot.md](../mc-shot.md)
- [mc-skills.md](../mc-skills.md)
- [mc-status.md](../mc-status.md)
- [mc-tidy.md](../mc-tidy.md)
- [mc-ui.md](../mc-ui.md)
- [mc-work.md](../mc-work.md)
