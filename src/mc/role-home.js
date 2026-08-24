/**
 * Role homes: the fixed directory layout a singleton role's workspace is
 * born with (design plan §7).
 *
 * The layout is the interface between the roles: the helper writes in
 * defined places, the PM reads only summaries — so "the PM never reads raw
 * logs" is a property of the filesystem, not an instruction. Each directory
 * carries a README marker saying what belongs in it, which makes the layout
 * self-documenting to whoever — person or model — stands in it.
 *
 * The PM home is its own little git repository (K8.1): the state files are
 * the system's memory, and without versioning a corrupt state.md is
 * unrecoverable. mc guarantees the repository exists; committing on every
 * heartbeat is the PM skeleton's job (step 4), not mc's.
 *
 * The helper's memoro-mirror stays an empty marked directory: the mirror is
 * initialised by the helper itself, through git/gh directly — that is its
 * defined, legitimate git surface — never by mc.
 *
 * Everything here is idempotent and additive: a start after a crash creates
 * whatever is missing and touches nothing that exists. The marker files and
 * state.md are written once and never overwritten — they are the role's
 * memory, and mc does not edit memories.
 *
 * The files themselves are in Swedish: they are the user's rulebook domain
 * (the constitution they cite is Swedish), not mc's code.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PM_STATE = `# PM — state

*Det första boot-sekvensen läser (K8.3): läs nuläget, sanity-checka köer och
inbox, agera sedan. Auto-commit vid hjärtslag är PM-skelettets ansvar
(steg 4); mc garanterar bara att repot finns.*

## Nuläge

(tomt — första start)

## Väntar på Martin

(inget)
`;

const HOMES = {
  pm: {
    git: true,
    state: PM_STATE,
    dirs: {
      inbox: 'Ett ärende per fil: Martins meddelanden, buggrapporter, eskaleringar (K5.1). Triageras vid varje hjärtslag.',
      queues: 'Köerna: projekt, småfixar, väntar-på-Martin. Prioritetsordning är PM:s beslut (klass E).',
      decisions: 'Beslutsloggen: append-only, roteras aldrig (K8.1). Post enligt K8.2.',
      digests: 'Skickade sammandrag till Martin (K5.2). Roteras.',
      handoff: 'Baton notes vid continue (K4). Efterträdaren ska inte behöva fråga något företrädaren visste.',
    },
  },
  // v0.2 of the design note (2026-08-17, built 2026-08-24): English
  // directory names per D-0084 — `underlag` became `briefs` before the home
  // ever existed on disk, so nothing migrates. `intake/` is Martin's
  // mailbox and the one surface that cannot wait its turn (§3).
  'pm-helper': {
    git: false,
    state: null,
    dirs: {
      intake: 'Martins råmaterial: skärmdumpar, textrader, felmeddelanden — vad som helst, i vilken form som helst. Icke-.md är bilaga; .md med samma filnamnsstam är dess beskrivning; samma kvart hör ihop. Behandlat flyttas till processed/, raderas aldrig.',
      [join('intake', 'processed')]: 'Behandlat intag, per datum. Martin ska kunna gå tillbaka till sin egen skärmdump.',
      sweeps: 'Komprimerade sessionssvep. Roteras.',
      briefs: 'Sammanställningar PM beställt.',
      improve: 'Improve-resultat per projekt: improve/<projekt>/<datum>.md. Ett projekt per varv i rotation; turordningen är ingen prioritering.',
      'memoro-mirror': 'Läs-spegel av repot. Initieras av helpern själv (git/gh direkt) — aldrig av mc, aldrig commits.',
      inbox: 'Kanalens transport: ett ärende per fil (§7b). Hit kommer PM:s beställningar och hjärtslagets improve-puls.',
      logs: 'Helperns egna loggar.',
    },
  },
};

export function roleHomeLayout(roleName) {
  return HOMES[roleName] || null;
}

/**
 * Make the home whole. Returns what was actually done, so the caller can
 * tell a first boot from a routine start — and can say out loud when the
 * one hard guarantee (the PM repo exists) could not be kept.
 */
export function ensureRoleHome(roleName, areaPath) {
  const layout = HOMES[roleName];
  if (!layout) return { known: false, created: [], git_initialised: false, git_failed: null };
  const created = [];

  for (const [dir, purpose] of Object.entries(layout.dirs)) {
    const path = join(areaPath, dir);
    if (!existsSync(path)) {
      mkdirSync(path, { recursive: true, mode: 0o700 });
      created.push(`${dir}/`);
    }
    const readme = join(path, 'README.md');
    if (!existsSync(readme)) {
      writeFileSync(readme, `# ${dir}\n\n${purpose}\n`, { encoding: 'utf8', mode: 0o600 });
    }
  }

  if (layout.state) {
    const statePath = join(areaPath, 'state.md');
    if (!existsSync(statePath)) {
      writeFileSync(statePath, layout.state, { encoding: 'utf8', mode: 0o600 });
      created.push('state.md');
    }
  }

  let gitInitialised = false;
  let gitFailed = null;
  if (layout.git && !existsSync(join(areaPath, '.git'))) {
    try {
      git(areaPath, ['init', '-q']);
      git(areaPath, ['add', '-A']);
      // A fixed identity rather than whatever the machine's git config says:
      // the commit is mc's act, and a missing user.email must not turn the
      // one hard guarantee here into a failure.
      git(areaPath, [
        '-c', 'user.name=mc', '-c', 'user.email=mc@memoro.local',
        'commit', '-q', '-m', 'Role home: first boot',
      ]);
      gitInitialised = true;
      created.push('.git');
    } catch (error) {
      gitFailed = String(error?.message || error);
    }
  }

  return { known: true, created, git_initialised: gitInitialised, git_failed: gitFailed };
}

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
}
