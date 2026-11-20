# The system (mc)

The `mc` command, the runner, the merger, the gate, the roles, verbs and task references in `canon/`, and how mc sessions plan, build, review and land work. The source area of the system itself: what is striven for here, the decisions that hold and where the assets are. Nobody owns an area and no programme belongs to one. The index is memoro `docs/technical/README.md`, which names the pages of the other areas; the code and these standards are in memoro-cli.

## Aim

- "One developer drives many tracks at once: the work is delivered at high quality, the system maintains and improves itself, and only the right kind of question reaches him. This is a direction, not a finish line: the programme is not done because a piece of work is." (Martin, 2026-11-14; programme `mc`)

The enduring direction in this historical quotation is the area direction. Its
programme-survival implication is superseded by the 2026-11-15 bounded-programme
decision below; it is not an active programme lifetime instruction.

- "Every mc session can be opened from any computer, survives a lost connection and feels local." (Martin, 2026-11-14; programme `mc-server`)

## Closer

Measured, with the baselines of 2026-11-14 (programme `mc`):

- No technical question waits on Martin. Baseline: of 22 non-reserved questions asked since 2026-11-12, 15 went to him, about half of them technical.
- No goal waits on Martin for a mechanical reason (a third failed merge, a session that ended early). Baseline: eight places in `src/mc/run.js` set `Martin` without a question.
- The same mistake is not made twice: a question Martin rejects, or a decision he overturns, changes the instructions. Baseline: nothing did this.
- No finding waits unread. Baseline: 282 proposals waited, and nothing woke for them until Martin opened a plan session.
- Every programme page says where it stands. Baseline: nearly every README described landed work as under way.
- Work lands the first time and is verified where users meet it. Baseline: 50 % of merge attempts passed first time, 4.4 sessions per goal, and done meant merged, not deployed and checked.

On main now:

- Opening or resuming the desk supplies a fresh snapshot and tells the session to wait for Martin's instruction. The overview groups programmes under their open horizons and shows the rest separately.
- The desk checks that the current order has been reviewed and its necessary investigations are complete before bringing it to Martin to set ready. The ordinary `state ready` command does not enforce either check.
- Before build, programme review and planning check the acceptance procedure
  and its setup ([acceptance preparation](../mc-plan.md#acceptance-preparation-before-build)).
  During delivery, goal list and show report the evidenced outcome and who
  acts next when available. A build that has more in-scope work records a
  bounded continuation instead of presenting the goal as ready for review
  ([goal verbs](../mc-goals.md#the-verbs)).
- The [learning pass](../mc-martin.md#lessons-and-the-learning-pass) can
  publish an evidenced factual correction to one area page. It does not
  change held wording or create a repair order.
- [`mc repair`](../mc-plan.md#repair-drafts) takes an evidenced defect through
  independent review to the ordinary planner, or records a scope stop at
  the desk. The release binds the reviewed order and its evidence. See the
  [repair scope and dispositions](../mc-plan.md#repair-scope-stops-and-dispositions)
  and the [terminal Repair contract](../mc-help.md#repair).
- A waiting deploy reserves the next opening for a full run when a different commit is being measured. It can still join a measurement of its own commit.
- The helper preserves anonymous app suggestions in intake before it acknowledges their receipt. Collection does not create a programme or goal.

## Decisions

- Three kinds of thing reach Martin: a product choice, a judgement (look, listen, try; superseded for orders by the 2026-11-17 decision below) and a reserved act (deploy, money, credentials, production data). Every technical question is decided by the system, by the goal, the standards, the app's pattern and established practice, and reported afterwards in a record he can read and overturn; a question that established practice answers is never his, also when it concerns privacy, security or cost (Martin, 2026-11-14; programme `mc`).
- `mc martin` is his one way in: he reads no ledger, queue or programme page himself (Martin, 2026-11-14; programme `mc`).
- `mc martin` may do everything: there are no limits in Martin's interactive sessions; what he says there is carried out, whatever it touches (Martin, 2026-11-16; programme `mc`).
- A goal stops on its own after five build sessions and waits for the desk (Martin, 2026-11-16; programme `mc`).
- Learning updates the information kept in the permanent areas. Repairs change existing functionality in memoro me or mc, using proposals, user feedback and error logs as inputs. These are separate activities. This replaces the 2026-11-14 decision that treated fixes to code, prompts and standards as the measure of learning (Martin, 2026-11-18; the desk).
- Every programme is an implementation plan, archived when its work is finished and written back. This replaces the 2026-11-14 idle-programme rule and the historical Aim quotation's programme-survival implication. For legacy programmes preserve the held Aim in the area without changing its meaning, finish active work in place, write back and archive by a supported route (Martin, 2026-11-15; programme `horizon`).
- Nobody owns an area and no programme belongs to one; areas are sources and references (Martin, 2026-11-15; programme `mc`).
- A horizon is always created in `mc martin`; the system never sets one. The manager's task is to keep the area texts curated (Martin, 2026-11-15; programme `horizon`).
- The order of the open horizons is the one priority, and candidates for new horizons are brought to the desk by the manager and become horizons only by Martin (Martin, 2026-11-15; programme `horizon`).
- The interactive `mc manager` entrance goes; a person's manual headless run stays (Martin, 2026-11-15; programme `horizon`).
- A change is ordered as a programme document — a repair programme when it is a set of small adjustments — and the planner cuts its goals; only a change small enough to run through directly skips the document, and no change needs a horizon: Martin decides what is taken up and in which form (Martin, 2026-11-16; programme `mc`). This replaces the 2026-11-15 rule that small work runs as a goal without a horizon, one in flight per area, and that a user-promise change needs a horizon.
- For a bounded repair to existing functionality, a dedicated repair session may write the programme order, run programme review, revise the order in response to the findings, and release it to build through the ordinary planner. If the order goes beyond that remit, the session sets it to Martin. The same end and archival rules apply to repair programmes. This is an exception for the repair session to the ordinary desk authority over programme orders (Martin, 2026-11-18; the desk).
- A repair session may release only the current reviewed version of its order, after it has settled the findings. This release condition applies to orders under repair session authority. Ordinary programme review remains advisory (Martin, 2026-11-18; programme `learning-and-repair`).
- A horizon is what is worked toward now, for roughly one to two months, taking several programmes; it is not standing or per area. A single deliverable with one end is a programme (Martin, 2026-11-15; programme `horizon`).
- Sessions have one way to ask for advice, `mc ask`, not several (Martin, 2026-11-15; programme `reach`).
- The only questions directed to Martin are those about a reformulation of an aim, and about strategy and design at that level (Martin, 2026-11-15; programme `mc`).
- A programme with a record is bounded: it is done when its goals are done and its write-back reads OK, and the system then archives it (Martin, 2026-11-15; programme `horizon`).
- The ordinary programme path uses `draft`, `ready` and `done`. A person or Martin's interactive session (`mc martin`) creates a draft record, and Martin sets the state with `mc programs state <programme> draft|ready` (Martin, 2026-11-16; programme `plain-programmes`).
- A programme in draft starts no new plan, build, review or mend session; planning and build take nothing from a draft programme (Martin, 2026-11-16; programme `plain-programmes`).
- `mc programs review` is advisory: Martin's interactive session calls it when he wants, it writes PROGRAMME-REVIEW.md beside the programme, and nothing reads the report (Martin, 2026-11-16; programme `plain-programmes`).
- The planner cuts goals from README.md of a ready programme (Martin, 2026-11-16; programme `plain-programmes`).
- A horizon has a basis file, and what is not designed is settled in a programme document (Martin, 2026-11-15; programme `programme-sign-off`).
- A programme is an order of what is to be built: temporary, archived when its work has landed, and of no interest afterwards. What must last is written in its permanent place before then: `docs/technical/`, the area page, or a proposal in its area (Martin, 2026-11-17; the desk).
- An order is buildable to its end without Martin: no visual or functional check of his (look, listen, try, accept, a step "on Martin's word") between ready and done. Everything he decides is decided in the document before it is set ready, and an act it needs is done before ready or after its end (Martin, 2026-11-17; the desk).
- Proposals live in the permanent areas, `~/mc/areas/<repo>/<area>/proposals/`, one folder per area page; no programme holds proposals and there is no ownerless folder (Martin, 2026-11-17; the desk).
- Main's red is to be found and repaired far earlier, not met when it is time to deploy: a deploy exists to get main into production (Martin, 2026-11-15; programme `mc`).
- No tmux in the interactive path, not even as a fallback: "Tmux är inte en fallback. Alldeles för dåligt." (Martin, 2026-11-13; programme `mc-server`).
- Claude sessions are used in the Claude app through Remote Control: every interactive Claude session mc opens carries Remote Control; Codex keeps its local terminal client (Martin, 2026-11-14; programme `mc-server`).
- The page mc draws stays English, and a waiting desk item is shown as its brief is written (Martin, 2026-11-15; programme `mc-page`).
- Plan review is removed: a complete goal moves from draft to build when its author says so: "Plan-review ska tas bort! Det är redan bestämt." (Martin, 2026-11-16; programme `no-plan-review`).
- The third agent tool is Antigravity CLI (`agy`), on Martin's Antigravity plan as a subscription like claude and codex, never an API key; the plan question is settled and not raised again (Martin, 2026-11-15; programme `antigravity`).

## Store

- `canon/` in memoro-cli: the roles, verbs and task pages that every session is started from.
- `.mc/areas.json` in each repository: the areas it declares, their standards, paths and questions. This page is the page of the source area `system`.
- The `~/mc` layout: programmes, archive, the areas' proposals, horizons, runner state and the desk's items, as [mc-layout.md](../mc-layout.md) describes it.
- `~/mc/martin/lessons/` — [lesson evidence](../mc-martin.md#lessons-and-the-learning-pass)
  used by the separate area-learning pass.

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
