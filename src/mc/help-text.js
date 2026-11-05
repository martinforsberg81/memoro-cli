import { commandReference } from './command-help.js';

/**
 * The complete top-level help text. Its only dependency is shared help data,
 * so the thin entry point never loads a runtime handler to print help.
 */
export const HELP_TEXT = `mc — source-owned coding sessions

THE PAGE
  mc                              The one page; at a terminal, a way in
  mc --json [--fresh]              The same page as data; --fresh asks GitHub

PLAN AND FOLLOW
  mc manager                      Person: manage work across all programmes
  mc plan [<programme>]            Person: open or resume a plan session
  mc goal list [<programme>]       Goals and their last session's next action
  mc programs list [--json]        Every programme, active or dormant
  mc goal show <programme>/<goal>  One goal, its log and its worktrees

RUN AND LAND
  mc run                          The headless runner
  mc run start|stop               Start or stop the runner
  mc run lanes [<n>]              Headless sessions at once, in total
  mc run --billing                Plan usage and next billing
  mc gate [<test files…>]          Affected tests and gates, or a focused rerun
  mc test <repo> <pr>              Measure a pull request; merge nothing
  mc publish                      Push, open the PR and queue it for the merger
  mc merge <repo> <pr>             Gate and merge a pull request

SEE AND SHIP
  mc test dev | prod              Measure the running app, locally or live
  mc shot dev | prod <target>     A PNG of the running app; prints its path
  mc dev list                     Which dev server runs in which worktree
  mc deploy [--dry-run]            memoro's main to production, after a question
  mc asc build                    Does memoro need a new iOS binary?
  mc asc status [<version>]       An iOS version's state, build and storefronts

WORKSPACES
  mc prs [--offline] [--json]      Open pull requests and whose they are
  mc tidy [--apply]               Preview removals; --apply rechecks and removes

IN FULL
WHO USES THE VERBS
  Person: mc plan, mc manager, mc helper open interactive sessions;
          mc run start|stop controls the headless runner. A session never
          starts itself with these verbs. mc plan refuses inside a session.
  Session: mc goal new / set / criterion add writes goals; mc goal log
           records progress; mc gate, mc shot and mc publish do the work.
  Headless sessions (MC_HEADLESS=1, set by the runner) are refused mc deploy,
                 merge --admin, production data and credentials; with
                 Martin at the terminal nothing is refused.

  mc                               The one page: what is running now, how deep
                                    the queue is, the decisions waiting on
                                    you, what waits in intake, and every
                                    goal numbered, by programme. At a
                                    terminal it ends in a way in — a number
                                    shows that goal. No model; reads only
  mc --json [--fresh]              The same page as one object. The page is
                                    offline and instant; --fresh fetches and
                                    asks GitHub, and without it the page says
                                    how old its PR cache is
${commandReference('goal')}

${commandReference('programs')}

${commandReference('run')}

${commandReference('gate')}

${commandReference('test')}

${commandReference('publish')}

${commandReference('merge')}

${commandReference('dev')}

${commandReference('shot')}

${commandReference('deploy')}

${commandReference('asc')}

${commandReference('tidy')}

${commandReference('layout')}

${commandReference('repos')}

${commandReference('repo')}

${commandReference('prs')}

${commandReference('docker')}

${commandReference('hook')}

${commandReference('keys')}

${commandReference('language')}

${commandReference('deps')}

${commandReference('log')}

${commandReference('manager')}

${commandReference('plan')}

${commandReference('helper')}

${commandReference('roles')}

${commandReference('skills')}

${commandReference('model')}
  mc vault <verb>                  The Memoro token vault: setup, unlock,
                                    lock, status, set, get, list, rm, rotate,
                                    bind, bindings, import, scan, audit,
                                    adopt, hydrate, devices, revoke-device,
                                    change-password, recovery, recover,
                                    destroy-forgotten, migrate. mc vault with
                                    no verb prints them with what each one
                                    takes. The one capability verb that is
                                    not a door into the session manager

WHAT IS NOT HERE
  There is no verb that lists work. mc is the page; a second list beside the
  first one is what this replaced.

  The session manager is not here either. A registry, a broker, a PTY host,
  managed providers and cloud runtimes were the product before this one, and
  the fourteen verbs that were their doors — setup, install-shell, auth,
  tool-auth, connections, github, coding-profile, dev, deps, cloud-session,
  cloud-runtime, security, doctor, migrate, and the session verbs before them
  — went on 2026-09-03. Today's mc dev and mc deps are later verbs that
  share only the name: dev servers, and dependency updates.

  Nor is a session of nobody's. Every session belongs to a programme (plan,
  build, review) or a desk (manager, helper); the verbs that opened folders of
  their own, and the page's list of them, went on 2026-11-03.

REQUIREMENTS
  - Plain mc prints the page and, at a terminal, opens what you pick.
  - Install and authenticate the selected coding tool.
  - Sign in to Memoro for mc vault.

HELP
  mc <command> --help              Show command-specific usage
  mc --version                     Print version
`;
