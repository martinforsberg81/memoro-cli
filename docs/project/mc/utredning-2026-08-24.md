# mc — det dagliga arbetet, och grunden för en levande app

*Fable-utredning, 2026-08-24. Beställd av Martin, uppdrag skrivet av PM.
Ingenting byggt. Alla tal märkta **M** (mätt, med källa) eller **A** (antaget/uppskattat).*

---

## 0. Utfallet på en sida

1. **Pengarna ligger inte där vi letat.** Vakternas modellanrop kostade **~$13 på 48 h** (M, listpris). Hela systemet drog **~$2 300 på 48 h** i listpris-ekvivalent (M), och **~85 % av det är cache-läsning** — samma 170–800k-kontext som läses om varje tur i varje session. Den dyraste posten är inte en vakt, det är **långa kontexter i Opus/Fable-sessioner**, PM inräknad.
2. **Vakterna kostar via det de väcker, inte via det de kör.** En PM-tur i går kväll = ~8,6 API-anrop på median 170k kontext ≈ **~$1 per tur** (A ur M). 202 knackningar på 70 h. Men bara **7 av 32** knackningar i PM:s kvällspass följdes av en PM-tur inom 90 s (M) — de flesta knackningar väckte ingen alls, och de som gjorde det gav sällan något att göra.
3. **Vaktarkitekturen är fel på ett sätt, inte fyra.** Både PM-ronden och sessionsvakten skriver in i den katalog de själva räknar och fs-bevakar. Tre filter staplade ovanpå (`isWatcherMessage`, `remember()`, fs-watch-undantag) är tre lagningar av samma konstruktionsfel. Repo-vakten har inte felet — den skriver till en egen statusfil ingen vakt läser tillbaka.
4. **PM som mellanled är ett mellanled till.** Med D-0193/D-0224 finns tre uppgifter kvar hos PM: prioritera, besluta det som är PM:s, hålla verktygen igång. Ingen av dem kräver en Opus-session som lever i 3,5 h på 170k kontext. Mitt förslag: PM blir **en daglig rond på 30 minuter i en färsk session**, inte en resident.
5. **"Vad kör i prod" finns redan:** `GET https://meetmemoro.app/api/version` svarar med commit, build, tid (M, publikt). Grunden för fråga 2 börjar med en curl, inte med ett bygge.
6. **Vakten hade oftare fel än rätt där det går att se.** 86 av 155 `unreachable` och 64 av 129 `blocked` motsägs av att sessionen levererade inom 30 min (M). 117 flaggor handlade om PM:s egen pane. 65 % av PM-rondens 458 filer innehöll bara en inkorgsräkning och `mc doctor: N issues` — och hälften listade vaktens egna filer som olästa.
7. **Fyra saker vi inte kan mäta i dag** (viktigare än de tio vi kan): vad en väckning faktiskt kostar i PM-turer · om någon enskild vaktflagga var *rätt* · hur lång memoros testsvit är · om #408 stoppade slingan (ingen körning efter fixen finns i loggen).

---

## 1. Talen

### 1.1 Vad systemet kostade (M — transkript i `~/.claude/projects/*/…jsonl`, dedupe på `message.id`, listpris 2026-06)

| fönster | anrop | output-token | cache-läst | listpris |
|---|---|---|---|---|
| senaste 24 h | 4 302 | 3,9 M | **1 535 M** | **~$1 130** |
| senaste 48 h | 8 878 | 7,8 M | **3 181 M** | **~$2 300** |

Per modell 48 h: opus-5 ~$1 500 · fable-5 ~$720–800 · opus-4.8 ~$52 · sonnet-5 ~$13 · haiku ~$13.

**Obs.** `costUSD` är 0 överallt i Claude Codes egen statistik; inloggningen ser ut som abonnemang (Max 20x enligt K5.2), inte API-nyckel — inte verifierat, credentials-läsning är spärrad. Talen ovan är alltså **kvot-ekvivalenter**, inte faktura. Men proportionerna håller oavsett prislista.

**Var det gick, 48 h, per yta (M):**

| yta | modell | listpris | kommentar |
|---|---|---|---|
| mc-repo (mc-utveckling) | fable + opus-4.8 | ~$537 | en Fable-session 360 anrop |
| msr-track-1 | opus-5 | ~$437 | **en enda session**, 1 395 anrop |
| **PM** | opus-5 | **~$404** | 1 656 anrop |
| project-management-improvement | opus-5 | ~$334 | |
| msr-track-3 | opus-5 | ~$247 | |
| msr-design | fable | ~$197 | |
| ytor, docx, main-red-fix | opus/fable | ~$80 | |
| pm-helper | sonnet | ~$13 | |
| **alla vakter** (1 090 Haiku-engångsanrop) | haiku | **~$13** | 0 cache |
| denna utredning (t.o.m. läsning) | fable | ~$13 | |

### 1.2 Vad vakterna gjorde (M — `~/.memoro/mc/watch/*.log`, `notices.jsonl`)

| vakt | konfig | verklig takt | modell | kostnad/dygn | upptäckte |
|---|---|---|---|---|---|
| `mc watch pm` | 30 min + fs-watch på `pm/inbox` | **956 pass / 70 h = 13,7/h** (847 fs-triggade) | ingen | ~0 direkt; 202 knackningar → PM-turer | 155 pass med "N notices"; doctor 23→29 issues, **alla 27 stående är gamla session-homes** |
| `mc watch sessions` | 10 min | 203 rundor / 37 h = 5,5/h | Haiku, ~2,9 anrop/runda, ~3,2k token/anrop | **~$5 listpris** | 616 flaggor: unreachable 155, error 155, blocked 129, waiting 124 … **dead 9, quota 3** |
| repo-vakt | 60 s | 27 rundor/h, 6 518 rundor sedan 14 aug | ingen (git + gh) | 0 | loggar inga upptäckter, bara "wrote 2 repositories" |
| improve-puls | "var 30:e min" | ej loggad separat — **går på varje tyst PM-pass**, alltså 13,7/h när slingan snurrade | väcker Sonnet-hjälparen | hjälparen ~$6/dygn | — |
| `mc doctor` | i varje PM-pass | 956 gånger | ingen | 0 | 27 identiska rader × 956 |

Sessionsvaktens 616 flaggor: **9 dead + 3 quota-exhausted = 12 (2 %)** är den klass som per design (D-0130) får knacka direkt. Av 8 vaktknackningar i PM:s kvällspass följdes **0** av en PM-tur inom 90 s (M).

**Hur många flaggor var sanna?** Delvis mätbart mot leveranser i `pm/inbox/archive` (M — en flagga räknas motsagd om den flaggade sessionen levererade till PM inom ±30 min):

| flagga | antal | motsagd ±30 min | motsagd ±2 h | ingen leverans på 2 h |
|---|---|---|---|---|
| unreachable | 155 | **86** | 25 | 44 |
| blocked | 129 | **64** | 31 | 34 |
| dead | 29 | 8 | 10 | 11 |
| unattended | 11 | 10 | 1 | 0 |
| quiet-group | 15 | 14 | 1 | 0 |

117 av flaggorna gällde **PM själv** (vakten beskrev PM:s egen pane som "unreachable — something is drawn in its prompt"). Konkret: `pm-helper: dead` 18:32 — hjälparen hade levererat 10 ärenden de föregående 28 minuterna. `mc-repo unreachable — 107 unread` 18:23 — mc-repo levererade 18:35, 18:44, 18:53, 19:33. "Ingen leverans på 2 h" är inte bevis för att flaggan var sann (en session kan bygga i timmar utan att skriva till PM), så den rätta läsningen är: **minst hälften av unreachable/blocked var fel, och vi vet inte om resten var rätt.**

### 1.2b PM:s inkorg, hela arkivet (M — `~/mc/pm/inbox/archive`, 1 018 filer, 15–24 aug)

- **508 av 1 018 (49,9 %) är vakter.** `mc-watch-pm` 458, `mc-watch-sessions` 32, reläer 18. I byte: 18 % — vakterna är många och korta.
- **296 av 458 PM-rondsfiler (65 %) innehåller enbart en inkorgsräkning och raden `mc doctor: N issues`.** Ingen fil namnger någonsin ett doctor-issue.
- **241 av 458 (53 %) listar vaktens egna tidigare filer som "unprocessed".** Den mest upprepade raden i hela arkivet: `waiting 2026-08-22T21-22-12.265Z-mc-watch-pm.md` — 69 gånger. 1 011 av 2 512 listade filrader (40 %) namnger en vaktfil.
- Kadens: en rondsfil 2–3 s efter varje sessionsleverans. Nattetid 24 aug (00–02, 05–06) innehöll inkorgen **enbart** vaktutdata.
- **De 511 icke-vaktärendena:** 345 (67,5 %) levererar arbete, 240 (47 %) innehåller något PM behövde agera på, **65 (12,7 %) är brus** — varav 15 automatiska `CLAIM REFUSED`, 4 hjälpar-dubbletter, 5 "inbox tom, väntar"-kollar. Uppskattat ~55 (11 %) nära-dubbletter (A, lästa av fyra läsare).

Det vill säga: **sessionerna själva är inte problemet.** Nio av tio sessionsärenden är arbete eller ett beslut. Hälften av inkorgen var vakter, och två tredjedelar av vakternas ärenden hade inget innehåll.

### 1.3 Slingan, i siffror (M — `pm.log`)

Gap mellan två fs-triggar (n = 846): **383 under 10 s**, median 24 s. Typmönster:

```
19:20:52.888  committed 2 files · doctor 23 · 8 unprocessed · delivered
19:20:53.091  new file in pm/inbox/ — a pass now
19:20:55.209  committed 1 file · doctor 23 · 9 unprocessed · delivered
```

Ronden levererar en fil till `pm/inbox`, fs-watchen tänder på filen, nästa pass 0,2 s senare, "unprocessed" stiger med ett per varv (8 → 53). **415 av 847** triggade pass slutade med "committed 1 file … nothing to say" — passet committade sin egen utdata och hittade inget annat. Loggen slutar 19:32 med slingan fortfarande igång; **#408 är inte bevisad i drift**.

### 1.4 PM (M — session `a682c553`, 16:17–19:42Z)

337 API-anrop på 39 Martin-turer = 8,6 anrop/tur. Kontext per anrop 41k–317k, **median 170k**. 61 M cache-lästa token på 3,4 h ≈ 1,6 M per tur. Output 286k. 32 knackningar i fönstret, 7 följda av PM-tur inom 90 s.

**PM:s turkostnad (A ur M):** 1,6 M × $0,5/M + 7k × $25/M ≈ **$1 per tur i listpris**. Det är inte turen som är dyr — det är att varje tur bär 170k kontext, och att kontexten består av inkorgsräkningar och doctor-rader PM aldrig läste (D-0222).

### 1.5 Repot (M — `wc`, importspårning)

78,3k rader. `src/mc` 39,4k men **~17,7k av dem är gammal vision** (session-*, managed-*, cloud-*, registry, dev-servers, tool-auth …). Levande väg ≈ **21,7k rader** (watch/wake/work/repo/suite/task/roles/pm-helper/enforcement/red-ratchet/status/conversations/portrait + commands). Resten: runtime 12,5k, cli 7,9k, vault 6,1k, adapters 5,6k, capabilities 2,1k, commands 1,3k.

Gammal kod nås från levande väg på tre ställen: `work-open.js:17` → `adapters/index.js` (varje launch), `doctor` → `session-maintenance-v1` → `runtime/session-host/ephemeral-state` (de 27 raderna), `sidecar-cleanup` → `runtime/broker`. Subprocess-spawns av mc självt finns bara i cloud/vault/auth — **inte** på PM/watch-vägen.

Verb utan en enda referens från `~/mc`, roller eller skills: `dispatch read delete migrate install-shell auth setup vault tool-auth deps connections cloud-session security worktrees` (14).

### 1.6 Grinden (M, en körning i denna worktree)

`npm test`: ~2:55 väggtid, 127 s CPU. Röda filer i `tests/runtime/**` (certified-execution, session-host). Jag har **inte** pass/fail-talen — Martin stoppade en andra körning, korrekt: maskinen har 8 GB och en svit i taget är regeln. PM:s tal (2 107 tester, 28 röda, identisk mängd två körningar) är PM:s, inte mina.

### 1.7 memoro (M — `~/memoro` @ `dc3d50fa55`)

- `GET /api/version` (publikt, `no-store`): `{"commit":"c7d2fa5","build":23124,"build_time":"2026-08-24T15:54:18Z"}` → **prod-SHA är läsbar i dag.**
- `deploy.mjs` 782 rader, 13 steg, stämplar `src/version.js` och `sw.js`, verifierar live-version i 120 s. **Kör inga tester.** `release-race.mjs` (432 rader) gör validate → `npm test` → deploy → smoke → changelog → PR — **den grinden finns redan i appen.**
- 13 workflows: **12 är `workflow_dispatch`**, 1 (`legal-gate`) går på PR med sökvägsfilter. Avsiktligt: "Actions minutes are constrained" (`docs/runbooks/deploy.md`).
- 21 runbooks: 5 är skript i dag, 6 kräver credentials + omdöme, resten omdöme/historik.
- Cloudflare: D1 (281 migrationer), R2, 2 KV, 2 Vectorize, 1 kö, 11 Durable Objects, 5 containers, 8 Workflows, 4 cron, tail-worker som grupperar fel i D1. `scripts/mtail.zsh`, `/ping*`, `scripts/canary/compute.mjs`, ~190 `scripts/admin/*`.
- LLM-överlapp: `llm-pr-review.mjs` (OpenAI o4-mini, manuell, inte i någon workflow), `sync-todo.mjs` (server-side analys via ADMIN_TOKEN), `llm-issue-analyze.mjs` (Sonnet 4.5, dispatch), `changelog-draft.mjs` (o4-mini).
- Storlek: src 508k rader, 1 976 testfiler, ~16 900 testfall (A). **Testtid: odokumenterad, omätt.** `inventory.mjs` kraschar med stack overflow (M).

### 1.8 Vad vi inte kan mäta

1. **Vad en knackning kostar.** Vakten kostar 0; PM-turen den väcker kostar ~$1; men vilka turer knackningar orsakade går bara att se via tidsnärhet (7/32). D-0006:s telemetri per yta är beställd sedan 15 aug och aldrig levererad.
2. **Hur många vaktflaggor som var sanna.** Vi kan visa att minst hälften av `unreachable`/`blocked` var fel (leverans inom 30 min). Vi kan **inte** visa att någon enskild flagga var rätt — ingen loggade vad sessionen gjorde när den flaggades. Utan det facitet går inte "förstärkare av uppmärksamhet" att skilja från brus.
3. **memoros testsvit i tid och på 8 GB.** mc:s grind ÄR memoros CI, och ingen vet hur lång den är.
4. **Faktisk kostnad i kronor.** Abonnemang → marginalkostnad 0 upp till kvoten, sedan stopp. Det gör "slöseri" till en kvotfråga: det vi bränner på cache-läsning är det som saknas när en byggsession behöver det.

---

## 2. Var pengarna ligger — i storleksordning

1. **Kontextlängd i Opus/Fable-sessioner: ~85 % av allt.** En session på 170–800k kontext betalar hela kontexten om, tur efter tur. msr-track-1:s ena session: $437/48 h. Sessionen som var på 99 % (D-0203) var per definition den dyraste per tur. **Hävstången är D-0218 tillämpad på alla: 150k för underhåll, och ett mätt tak för bygge.** Ingen annan åtgärd i den här utredningen är i närheten.
2. **PM som resident: ~$200–400/dygn.** Inte för att PM tänker dyrt, utan för att PM sitter på 170k kontext och tar 8,6 anrop per tur på inkorgsinnehåll som till 66 % var vakter (PM:s mätning) — 48 % över hela arkivet (M, 490/1018).
3. **Väckningar utan värde.** 202 knackningar/70 h. Om varje hade väckt PM: ~$200. De flesta gjorde det inte, och det är tur, inte design.
4. **Improve-pulsen.** Sonnet-hjälparen är billig ($6/dygn) men pulsen gick på varje tyst pass, dvs 13,7/h. Det som kostar är inte Sonnet, det är att hjälparens rapporter blev nya inkorgsfiler → nya pass → nya pulser (D-0221).
5. **Haiku-vakten: $5/dygn.** Rätt storleksordning för en vakt. Fel bara i vad den flaggar.
6. **Repo-vakten, doctor: $0 i modell**, men doctor gav 27 identiska rader i 956 pass in i PM:s kontext. Det är post 1 igen, förklädd.

---

## 3. Svaren på fråga 1

### 3.1 Var är modellanrop rätt, var är de slöseri?

D-0102:s gräns håller **i koden** — PM-ronden, repo-vakten och doctor är skript utan modell. Den håller **inte i effekten**: skripten producerar text som hamnar i en Opus-kontext. En regel som säger "skript, inte modell" men låter skriptets utdata bli modellinput har inte flyttat kostnaden, bara fördröjt den en nivå.

Rätt: en modell som läser en sessions utdata och avgör *blocked* (fuzzy). Rätt: Fable när strukturen är ifrågasatt, Opus inom struktur, Sonnet på klara direktiv.
Slöseri: Haiku som sätter `unreachable`/`error` på 310 av 616 flaggor när `quota-exhausted` och de flesta `error` är regex-bara; en Opus-session som läser "doctor 27 issues" 956 gånger; Sonnet som väcks 13 gånger i timmen för att skriva improve-noter ingen beställt.

**Gränsen ska dras om:** *deterministiskt svar → skript; skriptets utdata → fil, aldrig kontext; modell läser filen först när en människa eller en session frågar.*

### 3.2 Är vaktarkitekturen rätt från början?

Nej, och det är ett mönster, inte fyra buggar. Definitionen av felet: **en process som skriver in i det tillstånd den observerar.** PM-ronden räknar `pm/inbox` och skriver till `pm/inbox`. Sessionsvakten räknar områdes-inboxar för `unattended` och skriver till dem. Doctor läser vaktens pid-fil och rapporterar in i vaktens knackning. Alla tre lagningar (D-0210, D-0214, D-0221/#408) lade filter på läsningen. Filtret är rätt så länge alla avsändare är kända; det går sönder nästa gång någon lägger till en avsändare. Repo-vakten har inte felet, för den skriver till `repo-status/all.json` som ingen vakt läser.

**Rätt form:** en vakt har en *utfil* (append-only, egen katalog) och *ingen inbox-skrivning alls*. Knackning är ett separat, dumt verb som läser utfilen och skriver till sessionen — och som aldrig triggas av filhändelser i det den skriver till. Då kan ingen ny avsändare sluta slingan.

Följd: **fler lagningar är fel svar.** PM godkände tre; den fjärde ska vara en omkonstruktion (liten: `watch-pm-round.js` är ~460 rader, och det som ska bort är `sendToArea` på rad 370 och pulsen på 153–170).

### 3.3 Vad kostar PM, vad ger PM — och är PM rätt konstruktion?

**Kostar:** ~$200/dygn (M, 24 h) / $404 på 48 h, i en session på median 170k kontext. Plus det PM väcker (hjälparen, sessioner via `--wake`).

**Ger, mätt i går:** 225 beslutsposter totalt, varav ~30 i går. Handoff-8, state.md destillerad 400→202 rader, regelboken. Fem merger. Men också: tre godkända lagningar av samma slinga, 16 minuter tappade på arkivering (D-0175), en vakt som körde 24 h gammal kod utan att PM såg det (D-0180), och Fables svar "långsammare, inte bättre" varje gång PM stod emellan (D-0224, PM:s egna ord).

**Svaret på frågan, som om PM inte skrivit den:** Det Martin beskrev i D-0193 — "sessionerna äger sina projekt", "PM ska hålla koll, prioritera och driva" — är inte en roll som behöver vara *vaken*. Prioritering sker en gång om dagen. Beslut som är PM:s kommer några i veckan. "Verktygen fungerar" är ett skript (repo-vakten visar redan hur). Det som gjorde PM till en resident var inkorgen, och inkorgen var till 48–66 % vakter som pratade med PM.

**Förslag:** PM blir **en rond, inte en resident.** En färsk Opus-session en gång per dag (eller när Martin kallar), som läser `state.md` + dagens leveranser (inte vaktnotiser), skriver prioritering och order till sessionerna, uppdaterar state, och avslutas. Kontext < 150k av konstruktion. Kostnad: **~$10–20/dygn** (A: 1 session à ~50k kontext, ~15 turer). Sessioner som är blockerade skriver till `pm/inbox` som i dag; de läses vid nästa rond eller när Martin tittar. Akut (dead, quota) knackar **Martin**, inte PM — det är två flaggor per dygn.

Det som *inte* ska flyttas tillbaka: PM får inte bli kontrollant igen (D-0193). Ronden beordrar och prioriterar; den granskar inte leveranser — grinden gör det.

Det som försvinner med resident-PM: latens på minuter för "en session är blockerad". Priset är att en blockerad session väntar till nästa rond eller till Martin. Med tre spår är det acceptabelt; det var PM:s egen design redan i K5.1 ("latens på minuter är acceptabel").

### 3.4 Vad ska en människa göra, och aldrig behöva göra?

**Göra:** öppna dagen (läsa ett statusblad, inte en inkorg) · prata direkt med den session som bygger det viktigaste · besluta K9-klasserna (deploy, merge, secrets, kontraktsändring) · stänga dagen med ett ord till ronden.
**Aldrig:** läsa vaktnotiser · räkna inkorgar · gissa vilket SHA prod kör · undra om en vakt lever · upprepa en order en session redan fått (D-0180 var "byggd är inte i kraft" — det ska ett skript säga, inte Martin upptäcka).

---

## 4. Hur en dag borde se ut (i morgon)

Förutsättning: allt är stoppat, som nu. Ingen vakt startas förrän steg 1 i grunden är gjort.

**07:30 — Martin, 5 min.** `mc status` (skript, ingen modell). Den ska visa: sessioner och kontextfyllnad, öppna PR:er och grindresultat, main röd/grön, **prod-SHA mot main** (`curl /api/version` + `git rev-parse`). Inget annat.

**07:35 — PM-rond, färsk session, 20–30 min.** Läser `state.md`, gårdagens leveranser i `pm/inbox` (filtrerat på `from:` ≠ vakt — och efter steg 1 finns inga vaktfiler där), regelboken. Skriver: dagens prioritering (tre rader), order till sessioner via `mc work send`, uppdaterat state. Avslutas. Om det finns ett beslut som är Martins: en fil, inte en knackning.

**08:00–17:00 — sessionerna bygger.** Varje session: färsk vid start (`/clear`), planerar själv, egna subagenter, eget grindvarv, `mc repo merge --check`. Omstart vid 150k för allt som är underhåll; byggsessioner sätter sitt tak i kontraktet. Sessionen levererar till `pm/inbox` **en gång**: "levererat #N" — inte lägesbesked.

**Martin under dagen:** går in i den session som bygger det viktigaste. Fable direkt. Ingen väntan på PM.

**Vakt under dagen (efter steg 1):** sessionsvakten kör var 10:e min, skriver till `watch/notices.jsonl`, rör inga inboxar. Knackar Martin (inte PM) enbart på `dead`/`quota-exhausted`. Allt annat syns på `mc status` nästa gång någon tittar.

**17:00 — stängning, Martin 5 min.** `mc status`. Om deploy: `release-race` (finns) med grinden framför. Ett ord till PM-ronden i morgon om något ändrats.

**Kostnad för en sådan dag (A):** 3 byggsessioner à ~$100–150 om de hålls under 150–200k kontext, PM-rond $10–20, vakt $5. **~$350–500 listpris/dygn mot ~$1 130 i går**, och det mesta av skillnaden är kontextlängd, inte vakter.

---

## 5. Grunden — fråga 2

### 5.1 Var mc slutar och appen börjar

memoro har redan: deploy med preflight och live-verifiering, `release-race`, `/api/version`, `mtail`, canary, 190 admin-skript, egen LLM-review och improve. **mc får inte bygga något av det en gång till.** mc:s jobb är att *anropa* det med grinden framför och *visa* resultatet på ett blad.

Regel: **mc äger sessioner, grinden, leases och tavlan. Appen äger deploy, drift, runbooks och sina egna LLM-skript.** Glidningsrisk konkret: `llm-pr-review.mjs` (o4-mini) och mc:s grindvarv gör olika saker i dag; om mc någonsin får en "review"-modellroll är det en dubblett. Improve-rotationen i pm-helper och `sync-todo.mjs` är **redan** två system som gör samma sak — den ena bör avvecklas, och det är hjälparens (D-0205: mc bygger för memoro, inte tvärtom).

### 5.2 Det minsta som måste vara sant för fredagsdeploy

1. Jag vet vilket SHA prod kör och att det är main (finns: `/api/version`).
2. Kandidaten har passerat hela sviten, inte affected-only — och jag vet hur lång sviten är.
3. Jag kan se fel i prod inom fem minuter (finns: tail-worker → D1, `mtail`).
4. Jag kan rulla tillbaka med ett verb (finns: `wrangler rollback` — omätt om runbook finns).
5. Ingen vakt eller session kan trigga deploy — bara Martin (K9-I, håller i dag: deploy är `npm run deploy` lokalt).

Tre av fem finns redan i appen. Två saknas: **testtiden** och **rollback som verifierad procedur**.

### 5.3 Ordning, med en mätning per steg

| steg | vad | mätning efteråt | bygg/skala bort |
|---|---|---|---|
| **1. Tystnad** | Vakter skriver bara till egna utfiler; ingen inbox-skrivning, ingen improve-puls ur ronden, doctor ur ronden. Ta bort `sendToArea` i `watch-pm-round.js`. | `pm/inbox/archive`: andel `from: mc watch` **= 0** över en vecka (i dag 48 %). Pass/h = 2 (i dag 13,7). | skala bort |
| **2. Ett blad** | `mc status` visar prod-SHA vs main, grind, kontext per session, vaktnotiser (läst ur `notices.jsonl`). Ingen modell. | Martin öppnar dagen utan att läsa en inbox: **0 inkorgsfiler lästa av Martin/vecka**. | bygg (litet: `curl` + status-render) |
| **3. PM-rond** | PM som daglig färsk session; roll-overlay omskriven till rond. Resident-PM avslutas. | PM-kostnad/dygn (transkript-skriptet från denna utredning): **< $30** mot $200. Kontext per anrop median **< 80k**. | omkonstruera roll |
| **4. Kontexttak i kraft** | Per-roll-larm (beställt D-0218) + `mc status` visar det. Byggsessioners tak: mät första veckan, sätt sedan. | Cache-läst/dygn **halverat** (1,5 G → < 0,8 G). Andel anrop > 200k kontext **< 10 %**. | bygg (finns delvis: `contextUsage`) |
| **5. Telemetri per yta** (D-0006) | Transkriptskriptet som ett `mc`-verb: token per yta/modell/dygn, i status. Kostar 0 modell. | Den här utredningen kan upprepas på 30 s. | bygg (skriptet finns i scratchpad, ~100 rader) |
| **6. Grinden mätt** | Memoros fulla svit körd en gång med tid och minne på 8 GB. Dokumentera. | **Ett tal**: minuter och GB. Om > 30 min: hosted (`affected-test-gate` finns) eller uppdelad. | mät |
| **7. Deploy bakom grind** | `mc` anropar `release-race` (inte egen deploy); förbjudet utanför Martin. Rollback-runbook verifierad en gång i dev. | Fredagsdeploy genomförd med de fem punkterna i 5.2 gröna. | bygg (tunt: ett verb som exec:ar appens skript) |
| **8. Gammal kod bort** | `runtime`, `vault`, `adapters` (utom `resolveLaunch`), `capabilities`, gamla `cli`-verb, `session-*-v1`. ~50k rader. Doctor byts mot något som läser levande tillstånd. | `wc -l src` **< 30k**. Röda tester i `tests/runtime/**` = 0 för att de inte finns. Doctor: 0 stående issues. | skala bort |
| **9. Incident** | Senare. `mtail`, tail-D1, `/ping*` finns; mc visar dem på bladet. Inget nytt. | Tid från prod-fel till synligt på `mc status` **< 5 min**. | bygg litet, sist |

Ordningen är vald så att steg 1–3 kostar **negativt** (de tar bort) och kan göras i morgon; steg 4–5 ger mätverktygen; 6–7 är grunden för fredagsdeploy; 8 är städning som ska vänta tills 1–7 visat vad som faktiskt används; 9 är det enda nya.

### 5.4 Grund eller byggnadsställning?

**Grund:** `mc work`/`repo`/`suite`/`task` (leases, grind, merge-check), `notices.jsonl` som form, `contextUsage`, transkripten som kostnadskälla, memoros `release-race` + `/api/version`, regelboken på 124 rader.
**Byggnadsställning som ska bort:** PM-ronden som knackare, improve-pulsen, doctor i sin nuvarande form, resident-PM, 14 oanvända verb, ~50k rader gammal vision, de tre filtren mot självmatning (överflödiga när vakter inte skriver till inboxar), K1.2 "PM är Martins enda dörr" i konstitutionen (upphävd i praktiken av D-0193/D-0224, texten står kvar).

---

## 6. Vad som inte får glida

- **D-0193 hålls:** ronden prioriterar och beordrar, kontrollerar inte.
- **D-0102 hålls:** Haiku-vakten blir kvar som förstärkare — men bara på `blocked`; det regex-bara flyttar till skript, och en människa (Martin) är den som tittar på `dead`/`quota`.
- **D-0217 hålls:** inget i förslaget rör verktygsval; codex-buggen (747/vecka) är en bugg, inte ett argument.
- **D-0218 hålls och utvidgas** till huvudhävstången.
- **D-0212:** steg 5.3 är mätningar, inte regler. Det som saknar mekanism efter steg 3 är: "PM startar en rond om dagen" — det är Martins hand eller en cron, och det ska sägas.

---

## 7. Osäkerheter, rakt ut

- Dollartalen är listpris på abonnemang. Riktningen är säker; nivån är inte en faktura.
- "$1 per PM-tur" är ett medel på en kväll. Turer varierar 41k–317k.
- Vaktflaggorna: minst hälften av unreachable/blocked motsägs av leveranser. Hur många av resten som var rätt vet jag inte. Klassificeringen av de 511 sessionsärendena (arbete/beslut/brus) är läsning av fyra subagenter — omdöme, inte mätning.
- Jag körde mc:s svit en gång, inte två; PM:s "28 röda, identisk mängd" är PM:s tal.
- memoros testtid är omätt av alla. Steg 6 finns för att göra det.
- #408 stoppade kanske slingan — loggen slutar innan det gick att se.

*Källor: `~/.claude/projects/*/…jsonl` (usage-fält), `~/.memoro/mc/watch/{pm,sessions}.log`, `notices.jsonl`, `repo-status/watcher.log`, `logs/mc.log`, `~/mc/pm/{state.md,decisions/log.md,inbox/archive}`, `~/mc/pm-helper/briefs/`, `~/mc/large-scale-llm-project/`, mc-repot på `380e393`, `~/memoro` på `dc3d50fa55`. Aggregeringsskript och råutdata: `~/mc/mc-utredning/underlag/usage48h.py`, `usage24h.out`, `usage48h.out`.*

---

## 8. Tillägg efter Martins svar (2026-08-24, kväll)

Martins ram, ordagrant i sak: Max-abonnemang i botten · PM-konceptet är en vecka gammalt, hjälparen några timmar · mc byggs enbart som underhålls-/uppdateringsprogram för memoro me · Fable överallt tömmer 20x på tre dagar, Opus räcker för det mesta med rätt input · grindar och vakter togs fram mot överlappande merger och en glidande main, löste inte det, och gjorde allt krångligt · fokus ska vara appen, inte mc.

### 8.1 Vad det ändrar i analysen

**Kostnad = kvot.** På Max är marginalpriset noll tills kvoten är slut, sedan stopp. Då är det enda som räknas *token per dygn mot kvoten*, och den posten är till 85 % cache-läsning av lång kontext (§1.1). Modellval är sekundärt: en Opus-session på 400k kontext bränner mer kvot per tur än en Fable-session på 60k. **Kvotens hävstång är kontextlängd × antal samtidiga sessioner, sedan modell.**

**Det ursprungliga problemet var merge-överlapp och röd main.** Det problemet har ett standardsvar som inte är mc: *branch protection + CI på PR + merge queue*. mc:s lease/claim/suite-lease/red-ratchet/gate-rounds är en lokal återuppfinning av det, byggd för att GitHub Actions-minuter var begränsade (`docs/runbooks/deploy.md`). Det är rotorsaken till att grinden blev krånglig: den försöker göra på en 8 GB-laptop, i tur och ordning, det GitHub gör parallellt och gratis vid rätt uppsättning.

**Antal sessioner är den andra rotorsaken.** Överlapp uppstår för att många sessioner rör samma träd samtidigt. 13 döda ytor stängdes i går, 20 grenhållande finns kvar (state.md). Med två samtidiga sessioner på olika områden finns nästan inget att grinda.

### 8.2 Minsta struktur som löser det ursprungliga problemet

1. **Martin är PM.** Ingen PM-session, ingen hjälpare, ingen inbox, inga knackningar. Prioritering ligger i `docs/TODO.md` i memoro (finns; `sync-todo.mjs` skriver redan dit). En session läser den vid start.
2. **Två Opus-sessioner samtidigt, inte nio.** Var och en med ett avgränsat område och en färsk kontext; `/clear` vid leverans; omstart vid 150k. Fable kallas in av Martin för struktur, aldrig som arbetshäst.
3. **Sessioner mergar aldrig.** De levererar en PR. Merge är en handling, seriell, en i taget — Martins hand eller en merge-kö.
4. **CI på PR i GitHub, inte i mc.** Två vägar, båda utan Actions-minuter: (a) **self-hosted runner** på Macen (`actions/runner`, gratis minuter, kör befintliga workflows omskrivna från `workflow_dispatch` till `pull_request`) — begränsning: 8 GB och testtiden är omätt; (b) affected-test-gate finns redan hosted. När CI ligger på PR ger *branch protection* röd-main-skyddet och GitHubs **merge queue** överlappsskyddet. Då försvinner: `repo claim/release`, `suite claim/release`, gate-rounds, red-ratchet, `mc repo merge --check`.
5. **mc krymper till tre verb:** `mc work <område>` (starta session med rätt kontext — det mc gör bäst, och det som var kärnan från början), `mc status` (prod-SHA vs main, öppna PR:er + CI-status, kontextfyllnad per session), `mc release` (anropar memoros `release-race`, Martin-only). Allt annat är byggnadsställning.

Kvotuppskattning (A): två Opus-sessioner under 150k ≈ 2 × $60–100/dygn listpris ≈ **$150–200 mot $1 130 i går** — och kvotdelen som är Fable kan sparas till de tillfällen Martin kallar in den.

### 8.3 Vad som måste mätas innan punkt 4 går att välja

- memoros fulla testsvit: minuter och GB på den här maskinen (steg 6 i §5.3). Om > 8 GB eller > 30 min är self-hosted runner på laptopen ute, och affected-gate hosted är svaret.
- Hur många Actions-minuter affected-test-gate faktiskt drar per PR (`gh run list` ger det).

### 8.4 Vad som går förlorat, sagt rakt ut

- Latens: en blockerad session väntar på Martin, inte på en vakt. Med två sessioner är det en titt i timmen.
- Den fleet-vision som mc byggdes för (en människa orkestrerar många) skjuts upp, inte för alltid — men allt som bara finns för den ska inte underhållas nu.
- Om self-hosted runner: maskinen kör CI åt sig själv; det konkurrerar med sessionerna om 8 GB. Det är det verkliga priset, och det är mätbart.

---

## 9. Omtag: det faktiska målet är en maskin som arbetar dygnet runt

Martins precisering: appen utvecklas på fritiden · 10–20 parallella sessioner ströp datorn och tiden · det mesta av interaktionen var "ja, fortsätt" · syftet är att **automatisera detta, låta arbetet pågå dygnet runt i lagom takt**, med en plats att dumpa ärenden (= pm-helpers idé). §8 är fel svar på det: det gör Martin till flaskhals igen.

### 9.1 Var dagens konstruktion missar målet

Dagens mc är **push**: PM knackar sessioner, vakter knackar PM, hjälparen väcks av pulser. Push kräver att någon vet att någon annan lever — därav vakter, inboxar, liveness-flaggor, och slingorna. Och det tar inte bort "ja, fortsätt": det flyttar det från Martin till PM, som är en dyrare Martin.

"Ja, fortsätt" har två mekaniska orsaker: (1) Claude Code stannar vid turens slut och väntar på input, (2) permission-prompter. Ingen av dem löses av en PM. Båda löses av att sessionen körs **headless** (`claude -p` med uppgiften som prompt, auto-permission i sandbox) — då finns ingen tur att avsluta och ingen att fråga. mc kör redan `claude --print` för vakten; samma sak för arbete.

### 9.2 Förslag: en kö och en löpare (pull, inte push)

```
Martin ──dumpar──▶ intake/   ──(triage, en modell-tur per ärende)──▶ queue/
                                                                       │
                                       runner (skript, ingen modell) ◀─┘
                                       tar nästa ärende, startar EN headless
                                       Opus-session med ärende + kontext,
                                       väntar tills den är klar, tar nästa
                                                │
                                        PR → rebase på main → affected tests
                                        → merge (seriell av konstruktion)
                                                │
                                  Martin ser:  mc status · merged i natt · prod-SHA
```

- **Intake** = det pm-helper skulle vara: en katalog (eller GitHub Issues) där Martin slänger in text, skärmdumpar, halva tankar. **Triage** är en modelltur *per ärende* (Sonnet/Opus, `--print`), inte en resident: skriver om till ett uppdrag med acceptanskriterier och lägger i kön. Ingen puls, ingen rotation.
- **Prioritering** = ordningen i `queue/` (en fil). Martin ändrar den när han vill; annars FIFO. Behövs en nattlig omsortering är det en modelltur, inte en session.
- **Runner** = ett skript, ingen modell. Tar översta ärendet, `mc work` startar en **färsk** headless Opus-session med ärendet + Coding Profile + repo-kontext, sätter kontexttak, väntar. Klar → PR → rebase → tester → merge → nästa. **Samtidighet 1, kanske 2.** Det är vad 8 GB bär, och 24 h × 1 session är mer genomströmning än 3 h × 10.
- **Ingen vakt.** Löparen *är* processens förälder: den vet exit-kod, den ser transkriptet, den ser `quota-exhausted` som en sträng och sover till reset. Ingen Haiku som läser paneler. Ingen liveness-gissning: en process man startat behöver man inte gissa om.
- **Ingen grind i mc-mening.** Merge är seriell därför att löparen är en. Röd main → löparen lägger automatiskt "fixa main" överst och tar det först. Överlapp kan inte uppstå med en mergare.
- **Blockerat** = sessionen skriver `decisions/<ärende>.md` med frågan och avslutar; löparen tar nästa. Martin svarar när han vill; ärendet går tillbaka i kön. **Aldrig en knackning.**
- **Live-test/dev-server**: en i taget, ägd av löparen; startas för ärenden som deklarerar det.

### 9.3 Vad Martin gör

Dumpar ärenden. Tittar på `mc status` när han vill: merged sedan sist, kö, blockerade beslut, prod vs main. Svarar på beslut. Deployar (`mc release`). Kallar in Fable själv när strukturen är i fråga. **Aldrig "ja, fortsätt".**

### 9.4 Kvot (A — måste mätas, `/status` är källan)

En headless Opus-session under 150k: kanske 50–100 API-anrop/h × ~120k cache-läst ≈ 6–12 M token/h ≈ $3–6/h listpris ≈ **$70–150/dygn dygnet runt** — i nivå med enbart PM i går, för 24 h arbete i stället för 3,5 h knackningar. Om 20x räcker till det vet jag inte; det syns i `/status` efter en natt. **Takten är ratten:** löparen kan köra N ärenden/dygn eller sova när kvoten är under X %.

### 9.5 Vad av dagens mc detta bygger på, och vad som faller

Bygger på: `mc work` (start med rätt kontext), `task`-journalen, `contextUsage`, `work-open`:s launch-väg, memoros `release-race` och affected-gate. Faller: PM-session, pm-helper-session, inboxar som kanal, knackningar, `watch pm/sessions`, leases/claims (löparen är låset), red-ratchet, gate-rounds, doctor i sin form, det mesta av 22 verb.

### 9.6 Det jag vill mäta först

1. **En natt med löparen i enklaste form**: ett skalskript som tar ett ärende ur en fil och kör `claude -p` i memoro, en gång. Mät: tid, token (transkriptskriptet), kvot före/efter, PR-kvalitet. Innan något byggs i mc.
2. Memoros affected-svit: minuter och GB för en typisk PR.
3. Hur ofta en headless session faktiskt stannar på en fråga (det som "ja, fortsätt" var) — räknat, inte gissat.

---

## 10. Arbetsenheten är ett område med en plan — och planen bor på fel ställe

### 10.1 Inventering av `~/mc` (M, 2026-08-24 kväll)

35 områden. 29 har en worktree (24 memoro, 5 memoro-cli), 6 är rena roll-/dokumentområden (pm, pm-helper, large-scale-llm-project, inbox, status, mc-utredning).

| | antal |
|---|---|
| senast rörda i dag | 9 |
| 22–23 aug | 8 |
| **orörda ≥ 7 dagar** | **14** (revise-test-architecture 07 aug … week-focus 18 aug) |
| grenar ≤ 1 commit före main | 17 (troligen redan mergade via squash, eller ett litet orphan — måste kontrolleras per innehåll, inte per commit) |
| grenar ≥ 4 commits före main | 8 (msr-track-1: **30**) |
| områden med **egna plandokument** (utanför worktree och inbox) | **5 av 29 arbetsområden** — docx-editor 1, focused-session-ui 1, session-watch 1, mc-repo 2, msr-track-1 1 |
| områden med inbox > 20 filer | 7 (mc-repo 117, msr-track-1 97, msr-track-3 85, msr-design 55, pm-helper 43, klient-guard 25, docx-editor 20) |

**24 av 29 arbetsområden har ingen plan i en fil.** Planen finns i sessionens kontext, i PM:s inbox, eller i en PR-text. Det är därför sessionerna måste hållas vid liv, därför de växer till 500k, därför någon måste bevaka om de lever, därför PM. Det är en kedja: **plan i kontext → långlivad session → liveness-bevakning → PM → knackningar.** Bryter man första länken faller resten.

### 10.2 Martins insikt, som mekanism

"Det är först när man gör kod av planen som den visar sig bära eller brista." Alltså ska planen revideras **av den som skriver koden, i samma steg**, inte via plan → kö → arbete → rapport → Martin → Fable → kö. Varje varv i den kedjan är en kontextomladdning (kvot) och en väntan (tid).

Förslag: **planen är en fil i området, och sessionen äger den.**

- `~/mc/<område>/PLAN.md` (eller i worktree:n under `docs/plans/`, så den följer med i PR): *mål · kontrakt (vad som inte får ändras utan Martin) · steg · nästa steg · det koden lärt oss*. Kort. Sessionen uppdaterar den i slutet av varje steg.
- **Ett steg = en färsk session.** Löparen (§9) startar en headless Opus-session med `PLAN.md` + Coding Profile + repo-kontext: "gör nästa steg, revidera planen om koden säger emot den, leverera PR, skriv nästa steg". Sessionen avslutas. Ingen kontext att bevaka.
- **Planändring inom kontraktet** gör sessionen själv och skriver varför under "det koden lärt oss". **Kontraktsändring** (mål, omfattning, det som rör andra) → `decisions/<område>-<datum>.md`, sessionen tar nästa steg som inte beror på det eller avslutar; området markeras väntande. Martin svarar när han vill.
- **Fable** kallas in av Martin på ett område när "det koden lärt oss" säger att strukturen är fel — inte per varv. Fable läser `PLAN.md` och koden, skriver om planen, går. En tur, inte en session.
- **Utforskning och dialog** — det som alla 35 började med — är också ett steg: "utforska X, skriv en plan". Det ger en `PLAN.md`. Sedan är området körbart.

### 10.3 Vad det gör med 35 områden

1. **14 orörda ≥ 7 dagar:** kontrollera per innehåll om grenen är mergad (`mc`s unmerged-räkning finns), stäng det som är det. Sannolikt hälften.
2. **Resten:** ett triage-steg per område — en modelltur som läser gren, inbox, PR:er och skriver första `PLAN.md` med nästa steg. Det är pm-helpers riktiga jobb, en gång, inte en rotation.
3. **Sedan** är kön = listan av områden vars `PLAN.md` har ett nästa steg, i Martins ordning. Löparen tar överst, 1–2 åt gången, dygnet runt.

### 10.4 Vad "dumpa ett ärende" blir

Ett ärende är antingen en rad i ett befintligt områdes `PLAN.md` (löparen ser att planen ändrats) eller ett nytt område med steg 1 = "utforska och planera". Intake-katalogen från §9 är bara postlådan för det; triage-turen sorterar in det. Ingen hjälpare som väntar.

### 10.5 Det som kvarstår att mäta (samma som §9.6, plus en)

4. **Hur många steg per natt** en löpare hinner på ett riktigt område, och hur ofta `PLAN.md` ändras av koden. Det talet säger om stegen är rätt stora.

---

## 11. `PLAN.md` i `docs/project/<programme>/<project>/`

Läst: `~/memoro/docs/project/README.md` (M). Strukturen: `docs/project/<programme>/<project>/`, projekt = mc:s workarea-namn, close-out = katalogen tas bort + en rad i `project_log.md` + ett dokument i `docs/technical/`. I dag finns ett programme (`msr-core`) med ett projekt (`msr-design`, 12 dokument); övriga 28 arbetsområden har ingen katalog än.

### 11.1 Det passar — av fyra skäl

1. **Projektkatalogens namn = workarea-namnet.** Löparen hittar planen utan register: `docs/project/*/<workarea>/PLAN.md` i områdets worktree. Saknas den är steg 1 "utforska, skriv PLAN.md" — och det är en liten PR som Martin kan läsa i GitHub i stället för i en dialog.
2. **Planen följer med i PR:n.** Varje steg som ändrar kod ändrar samtidigt "nästa steg" och "det koden lärt oss" i samma diff. Historiken ligger i git, exakt som README:n vill. Ingen rapport till PM behövs — diffen *är* rapporten.
3. **Close-out-regeln är löparens sista steg.** När `PLAN.md` säger klart: ta bort katalogen, skriv loggraden, skriv/uppdatera `docs/technical/…`, PR. mc stänger området när den PR:n är mergad.
4. **Ingen konflikt mellan områden**: varje projekt rör bara sin egen katalog. Det enda dokument flera rör är programmets — det ska ändras sällan.

### 11.2 Vad `PLAN.md` måste vara för att en löpare ska kunna läsa den utan modell (D-0102)

Frontmatter maskinläsbar, resten kort prosa som pekar på de andra dokumenten i katalogen:

```markdown
---
status: ready | waiting-decision | blocked | done
next: "Step 4 — replace the card renderer behind the flag"
contract_owner: martin          # what below "Contract" needs Martin to change
budget: 150k                    # context cap for one step
needs: [dev-server]             # optional: live test, suite, secrets
---
# <project>
## Goal                ← one paragraph: what is true when done
## Success criteria    ← checklist a fresh session can verify from code/tests
## Contract            ← changes here → decisions/, not this file
## Steps               ← done / current / remaining; each remaining step has a "done when"
## What the code taught us   ← appended per step, newest first
## Documents           ← links to the design docs in this directory
```

Löparen läser bara frontmatter för att välja; sessionen läser allt. `status` och `next` är det enda som *måste* stämma.

### 11.3 Var prioriteringen bor — inte i repot

Ordningen mellan projekt ändras dagligen och är Martins operativa tillstånd, inte appens dokumentation. Den ska inte göra commits på main. Förslag: `~/mc/queue.md` — en lista med workarea-namn i ordning, och inget annat. Löparen: första namnet i `queue.md` vars `PLAN.md` säger `ready`. Martin flyttar rader. **Planen i repot säger *vad och var vi är*; kön i mc säger *vilket först*.**

Programme-nivån kan bära *sin* ordning (`track-1-order.md` finns redan i msr-design) — det är en designfråga, inte en operativ, och hör hemma i repot.

### 11.4 Två saker att vara vaksam på

- **Planen ligger på en gren tills PR:n mergas.** Löparen måste läsa den ur områdets worktree, inte ur main. Det är naturligt (området är worktree:n) men får inte glömmas när något ska visa "alla planer" — då är det 29 worktrees, inte en.
- **`docs/plans/` är inte tömd** (README: "a large minority were still under active edit"). Triage-steget per område ska hitta sin gamla plan där och migrera den, annars får vi två planer per område — samma glidning som två improve-system.

### 11.5 Samma sak för memoro-cli

mc:s egna projekt (mc-repo, session-watch, watch-pm, gate-word, klient-guard) är fem områden. Samma konvention i `memoro-cli/docs/project/` — ett programme, `mc`, och det räcker. Inget nytt att uppfinna.

---

## 12. Löparen, migreringen, och vad helper och pm blir

### 12.1 Löparen är inte en roll — den är ett skript

En roll har omdöme och kontext. Löparen har inget av det: den läser en kö, läser frontmatter, startar en process, väntar, läser exit-kod. ~100–150 rader. Ingen modell i löparen någonsin (D-0102).

**Snabbaste vägen, tre steg:**

**Natt 1 — ett skalskript i `~/mc/bin/runner.sh`, utanför mc.**
```
loop:
  name = första raden i ~/mc/queue.md vars docs/project/*/<name>/PLAN.md har status: ready
  cd ~/mc/<name>/memoro
  git fetch && git rebase origin/main            # eller stoppa och markera blocked
  claude -p "$(cat PLAN.md) — do the next step, revise the plan if the code
             contradicts it, open a PR, update next:/status:, stop." \
         --model opus --append-system-prompt "$(mc coding-profile read)" \
         --permission-mode acceptEdits            # + allowlist i settings, se nedan
  logga: tid, exit-kod, PR-nummer, token (usage48h.py på transkriptet)
  sömn 60 s; om exit sa quota → sömn till reset
```
Samtidighet 1. **Löparen mergar inte natt 1** — Martin mergar på morgonen från briefingen. Det är det enklaste sättet att mäta PR-kvalitet innan man litar på den.

**Vecka 1 — mät, sedan flytta in i mc som `mc run`.** Återanvänd `work-open`:s launch-väg (Coding Profile, roll-overlay, worktree) — det är det som redan fungerar. Lägg till: seriell merge (`rebase → affected tests → gh pr merge --squash`) när mätningen visar att PR:erna håller. Samtidighet 2 när minnet mätts.

**Permissioner är Martins beslut, inte löparens:** headless kräver antingen `acceptEdits` + en allowlist i `settings.json` (git, npm test, gh) eller `--dangerously-skip-permissions` i sandbox. Det förra är mc-kontraktets linje (security-first). Mät hur ofta sessionen stannar på en fråga; det talet avgör allowlistan.

### 12.2 Migreringen är löparens första arbete, inte Martins

29 områden utan `PLAN.md` + `docs/plans/` att rensa är omfattande **om en människa gör det**. Gör det till kö-poster:

1. **Stäng det som är mergat** (skript: innehållsjämförelse mot main, finns i mc). 14 orörda områden → sannolikt hälften bort utan att någon läser dem.
2. **Ett triage-steg per kvarvarande område** = första kö-posten för varje: "läs gren, inbox, PR:er, gamla planen i `docs/plans/`; skriv `docs/project/<programme>/<name>/PLAN.md`; flytta/frys den gamla; PR." En headless-session per område, 20–40 min styck (A). Löparen gör 15–20 per natt. **Två nätter.** Martin läser PR:erna — det är hans granskning av migreringen, i GitHub, i sin takt.
3. **`docs/plans/`-rensningen är ett eget projekt** i kön (`docs-plans-cleanup`), med `docs-plans-activity-2026-08-22.md` som steg 0. Löparen tar det i steg som alla andra.

Så: omfattande i timmar, inte i Martin-timmar.

### 12.3 helper (inte pm-helper)

**Jobb:** hålla koll på felen i drift och skriva uppdrag till kön. Två delar, i rätt ordning:

- **Skript först:** en fel-digest ur det som redan finns — tail-worker → D1 (grupperade fel), `scripts/admin/survey-errors`, `inspect-ai-provider-errors`, `/ping*`. Körs dagligen (cron) och skriver `~/mc/intake/errors-<datum>.md`. Ingen modell.
- **Modell sedan, en tur:** `claude -p` (Sonnet räcker för det mesta; Opus när digesten är tvetydig) läser digesten + `project_log.md` + befintliga `PLAN.md`-frontmatters och skriver **förslag** till `~/mc/intake/proposals/`: nytt projekt (med steg 1 = utforska) eller en rad i ett befintligt projekts plan. **Helper skriver inte i kön.** Martin (eller pm i briefingen) flyttar förslag till `queue.md`. Det är gränsen mot en helper som beställer arbete åt sig själv.

Ingen resident, ingen puls, ingen rotation. Trigger: cron + "nytt fel med > N träffar".

### 12.4 pm

**Jobb:** daglig briefing, och guida Martin genom de beslut som samlats.

- **Briefing** = en färsk Opus-session varje morgon (Martin startar den, eller cron kl 06 skriver den som fil med `claude -p`). Läser: `queue.md`, alla `PLAN.md`-frontmatters (skriptet samlar dem ur worktrees), `decisions/` som väntar, mergade/öppna PR:er senaste dygnet, löparens logg (steg, misslyckanden, token), prod-SHA vs main, intake/proposals. Skriver en sida: *gjort · fastnat · väntar på dig · förslag att lägga i kön · kvot* (kvoten läser Martin själv i `/status` — headless når den inte).
- **Beslutsguidning** = samma session, interaktiv: "tre beslut väntar; det första är …; alternativen är …; min rekommendation …". Martin svarar med ett ord; pm skriver svaret i `decisions/<x>.md` och sätter projektets `status: ready`. Sedan avslutas sessionen. Kontext < 100k av konstruktion.
- **pm mergar inte, prioriterar inte utan Martin, knackar ingen, har ingen inbox.** State är `queue.md` + `decisions/` + `project_log.md`. Ingen `state.md` på 200 rader att destillera.

### 12.5 Hela bilden

| | vad | modell | när | tillstånd i |
|---|---|---|---|---|
| **runner** | tar nästa steg ur kön, kör, loggar | ingen | dygnet runt | `queue.md`, runner-logg |
| **worker** | ett steg i ett projekt, PR | Opus (Fable på Martins order) | när löparen startar den | `PLAN.md` i repot |
| **helper** | fel-digest → förslag | skript + Sonnet-tur | cron | `intake/` |
| **pm** | briefing + beslut | Opus, färsk | morgon / på begäran | `decisions/`, `queue.md` |
| **Martin** | kö-ordning, beslut, merge/deploy, kallar Fable | — | när han vill | — |

Fem saker. Ingen bevakar någon annan. Det enda som lever dygnet runt är ett skript.

---

## 13. Stora program, designsteg, och vad löparen faktiskt ser

Martins invändning: dagens områden är stora flerstegsprogram (sql-readiness m.fl.), inte något en session kör igenom, och de kräver designutredning.

### 13.1 Löparen ser aldrig ett program — bara ett projekts nästa steg

`docs/project/README.md` har redan nivåerna: **programme** (överlever projekten) → **project** (= workarea) → och i `PLAN.md`: **steps**. sql-readiness (M — `docs/plans/sql-readiness.md`, 542 rader) är redan skrivet så: åtta "independently stable program states" S0–S7, validation gates, nio "decisions still required". Det är ett programme med åtta projekt och en beslutslista — dokumentet vet det, katalogstrukturen saknar bara det.

Mappning:

```
docs/project/sql-readiness/            ← programme: sql-readiness.md flyttar hit (ordning, invarianter, gates)
  s1-dormant-capability/PLAN.md        ← project = workarea, status: ready
  s2-search-boundary/PLAN.md           ← status: blocked (needs s1)
  …
~/mc/decisions/sql-readiness-*.md      ← de nio besluten, ett per fil, väntar på Martin
```

Löparen tar `s1-dormant-capability` när `status: ready` och gör **steget** i `next:`. Ett projekt på 20 steg är 20 färska sessioner över kanske två veckor. Programmet lever i sin katalog och rör sig när projekt stängs (close-out-regeln + `project_log.md`). Ingen session behöver hålla programmet i huvudet — det är det som gör färska sessioner möjliga.

**Steget är enheten, och steget måste rymmas i en session under 150k med ett verifierbart "done when".** Det är den enda dimensioneringsregeln. Ett steg som inte gör det är två steg.

### 13.2 Designsteg är steg — med samma krav

"Utred X", "kodanalys av Y", "designplan för Z" är legitima kö-poster. Skillnaden mot kodsteg är bara vad "done when" pekar på: ett dokument i projektkatalogen som **besvarar namngivna frågor** (skrivna *innan* steget startar, i `next:`), plus ett uppdaterat `PLAN.md` som slutar i **antingen** ett konkret nästa kodsteg **eller** ett beslut i `decisions/`. Aldrig i "mer design".

Det är också svaret på hur ett stort program *blir* projekt: **första steget i ett nytt programme är ett designsteg** — "läs `docs/plans/sql-readiness.md`, skriv programme-katalogen, dela S0–S7 i projekt med varsin `PLAN.md`, lyft de nio besluten till `decisions/`". En session, en PR, Martin läser den.

Designsteg körs av Opus med egna subagenter (breda läsningar är subagentarbete, inte kontext). **Fable** kallar Martin in på ett designsteg när frågan är strukturen själv — som en tur på ett projekt, inte som en session som lever.

### 13.3 Skyddet mot det gamla mönstret

Alla 35 områden började med utforskning och dialog, och 24 har ingen plan i fil. Risken med designsteg är samma: dokument som ingen kodar. Två mekanismer, båda utan modell:

- **Ett designsteg måste namnge sina frågor i `next:` innan det startar.** Löparen kör inte ett steg vars `next:` bara säger "utred". (Frontmatter-kontroll: `next:` för ett designsteg listar ≥ 1 fråga.)
- **Briefingen räknar.** Ett projekt med två designsteg i rad utan kodsteg eller beslut markeras i morgonens sida: *"sql-readiness/s0-baseline: tredje designvarvet — vill du ha kod, ett beslut, eller Fable?"* Martin avgör; ingen regel avgör åt honom.

### 13.4 Långlivade grenar

msr-track-1 ligger 30 commits före main (M). Med ett steg per PR och seriell merge landar varje steg på main — bakom flagga när det måste. Det är samma disciplin som D-0193 redan ville ha, men buren av löparen i stället för av en regel. Grenar som lever i veckor är då ett tecken på att stegen är för stora, och det syns i briefingen som "PR öppen > 3 dagar".

### 13.5 Vad det betyder för natt 1

Inget ändras i uppdraget: `docx-editor` har redan en stegindelad plan (slices), så triage + ett kodsteg är rätt test. Men **natt 2:s** naturliga kandidat är ett rent designsteg — sql-readiness → programme-katalog + projekt + beslut — för det testar den andra halvan: kan en färsk session dela ett 542-raders program i körbara projekt utan att fråga någon.
