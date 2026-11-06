# Claude whole-message receipt and completion — bounded diagnosis

Goal: `mc/claude-receiver-completion`. Investigation: 2026-11-06.
Companion machine-readable evidence: `mc-claude-receiver-completion.json`.

## Decision: inconclusive; no safe mechanism demonstrated

The supported `--include-partial-messages` launch flag exposes positively
observed, message-ID-keyed `message_stop` boundaries. One normal request
received a receiver-authored, text-only whole-message envelope at such a
boundary. This is narrower than a demonstrated safe normal-and-urgent
mechanism: the urgent response included a thinking block and must be rejected;
the provider moved the intended foreground command into the background;
and the investigation's process-group watchdog failed. **Criterion 1 remains
unmet.** Independent review has not happened; criterion 2 remains unmet.
Do not treat an exit-0 offline replay or documentation gate as provider safety.

No receiver requirement is relaxed. No product code, permanent tests, feature
activation or feature live-acceptance run is authorized. Both Claude and Codex
remain intended feature providers. Historical budgets remain exhausted (2/2
each); this goal adds no Codex run. This negative/inconclusive result cannot
satisfy `mc/live-session-messages` acceptance. That goal returns to plan after
report landing to reconcile launch, drain and queued-input gaps, and separately
commission actual runner/CLI/page acceptance. There is no automatic implementation.

## Provenance and launch selection

Inspected `SESSION-MESSAGES.md`, especially its Offline readiness checkpoint,
and the corrected landed `mc-session-message-transport.md`, including raw-event
reconciliation and the complete embedded `common.mjs`/`claude-probe.mjs`.
Re-extracted and ran its historical offline reconciliation (no provider calls):
Codex candidates 2 and 3, Claude candidates 0 and 0. Its unsafe block/line
parsers remain historical evidence only, never receiver proof.

Current source inspected at `27fc553d9c4e4ee608f390b6dfe72e53f62db1f3`:

- `src/mc/run-plan.js:417–443`: `headlessArgs` uses `acceptEdits`, the seven-tool
  allowlist, strict MCP, adapter session settings and appended role instructions;
  stream input/output plus verbose; `userMessageLine` has no UUID.
- `src/mc/run.js:246–410`: `send` fences after result; `onResultLine` ends stdin
  and arms result grace. **Its caller is task-aware**: a result with live
  `background_tasks_changed` tasks is not terminal; zero-turn notifications
  also have an exception. The probe deliberately follows this goal's stricter
  first-result closure, so it is not identical to that background-task policy.
- `src/adapters/claude-code.js`: session settings disable CLAUDE.md discovery
  and auto-memory, retain the role cache TTL. No hook/permission/account changes.

Offline local `claude --help` documents `--replay-user-messages` and
`--include-partial-messages`; `--json-schema` is final structured output, not
proof of per-request receiver authorship during commands, so was not selected.
No schema/contract for the exact keyed completion-event fields was independently
established. The observed keyed boundary is a candidate, not an API stability
or complete production integration guarantee. No web or credential inspection.

The exact executable launch, settings, role and task are retained in the probe
source below and raw spawn record. The existing stream-json launch is retained,
adding only replay and partial-message observation. Like the historical probe,
no explicit model, effort, advisor, resume or autocompact flag is supplied;
there is no model/provider/account switch. This does not prove equivalence to
every configured production launch. `--permission-mode acceptEdits`, tools,
strict MCP and hooks stay configured, without bypass/safe/bare-mode changes.
SessionStart hook started/responded successfully, with isolated mc roots.

| Observed item | Value |
| --- | --- |
| Claude | `/Users/martinforsberg/.local/bin/claude`, `2.1.318 (Claude Code)` |
| Model | `claude-opus-5-5` (current default, unchanged) |
| Runtime | Node `v24.10.0`, Darwin `25.4.0`, arm64 |
| Route | both `system/init` records: `apiKeySource: none`; subscription route, no API fallback |
| Owner / Claude child | Node PID 2999 / Claude PID 3087 |
| Bound session | `1083cc6b-ce2d-4f90-af6a-418dba680a53` |
| Command | one Bash `./build.sh`, `timeout:120000`, `run_in_background:false` |
| Build tool ID | `toolu_01R6RxEwhcibgDFusxfzraTT` |
| Task ID / run ID | `b3g535888` / `0mw4j8byl-9b6a11e2` |

The child environment removes mc session context and API-key/auth-token names
without reading their values, then sets only isolated `MC_HOME`, `MC_WORK_ROOT`
and `MC_HEADLESS`. No keychain/auth files, API/credits gateway or secret values
were accessed. The provider retains its own native subscription authentication.
Raw capture redacts key-shaped strings and Bearer payloads; it is not a general
secret detector. Condensed traces omit signatures/deltas and unrelated command
arguments; only process metadata (PID, PPID, PGID, executable) was sampled.
The retained raw stream includes opaque thinking signatures, not thinking text.

## Budget, invocation and failed safety guard

Durable allocation was appended to goal LOG **before invocation**, with scratch
ledger `budget.jsonl` and an exclusive `build-consumed` marker. Failures count.
The marker must never be deleted to obtain another run.

| Allowance | Consumed | Remaining |
| --- | --- | --- |
| Additional build Claude | 1/1 | 0; no retry, even to fix the watchdog |
| Independent review Claude | 0/1 | 1 reserved, serial after build; not spent here |
| Finish | 0 | 0 |
| Additional Codex / feature acceptance | 0 | 0 |

Exact allocated invocation (paths defined in Reproduction below):

```sh
python3 "$MC_SCRATCH/supervise.py" "$MC_SCRATCH"; cat "$MC_SCRATCH/budget.jsonl"; cat "$MC_SCRATCH/supervisor-output.log"
```

**Historical invocation only: do not execute it again.** The shell returned 0
because its final `cat` masked Python's uncaught `PermissionError` from
`os.killpg(p.pid, 0)`. The original Node stdout/stderr file is empty; the
observed traceback is retained separately as an explicitly labelled tool-result
transcription, not misrepresented as a runtime-generated log. The exact failed
supervisor is retained below without repair.

Allocation was recorded at 05:26:41Z; child spawn 05:26:42.639Z;
close 05:29:29.977Z, nominally 168.977 s from the ledger's second-resolution
allocation timestamp. Probe monotonic elapsed to close: 168.050 s (its own
clock begins after fixture setup). Command output dates span 05:26:48Z to
05:29:25Z, about 157 s despite `sleep 40`. Why that wait expanded is unknown;
no sleep/capacity cause is inferred. Provider `duration_ms` is not the total
process-tree wall time.

The supervisor intended TERM at 290 s, KILL at 292 s and failure by 295 s,
covering fixture setup too. **It did not establish an enforceable whole-tree
deadline.** In addition to its exception, process snapshots show Bash used a
different PGID, 3453: 3087 → zsh 3453 → sh 3456 → sleep 3530. The guard only
addressed PGID 2999. Known command completion and child close were observed
under 300 s, but that is not proof every hook/escaped descendant was bounded.
A later metadata snapshot at 05:44:34Z found no PGID 2999 or those two parent
PIDs; it is not timely evidence certifying the whole tree under 300 s.
No signal/cancellation was used to make messages arrive, and no command was
retried, repaired or re-executed. **Do not mark criterion 1 met on this record.**

## Ordered receiver and command evidence

All sequence numbers refer to retained timestamped `build.raw.jsonl`, not a
line parser. Companion JSON pins every ordered output UUID, input UUID,
assistant/request ID, content-block type, message start/stop and accepted event.

| Seq | Probe ms | Observation |
| --- | ---: | --- |
| 11 / 20 / 23 | 4875 / 5591 / 5604 | start / complete Bash content row / keyed message_stop for `msg_011Cgm7vGqBhkiWNfBJDzwLd` |
| 26 / 27 / 28 | 9650 / 9650 / 9653 | active shell/sleep metadata; normal submitted; matching UUID queued |
| 29 / 30 / 31 | 14628 / 14628 / 14629 | same active shell/sleep; urgent submitted; matching UUID queued |
| 33 / 35 | 147496 / 147512 | provider auto-backgrounded the command; tool result reports timeout 120000, `interrupted:false`, only BUILD-START |
| 36–39 | 147533–147536 | both UUIDs replayed/started in same session; delivery only |
| 41 / 61 / 64 | 151362 / 151373 / 151376 | normal assistant start / text / keyed message_stop, stop_reason end_turn |
| 65–68 | 151386–151393 | both lifecycle completed; first result; stdin ended immediately, submissions fenced |
| 70–72 | 163345–163346 | background command ends, task notification exit 3, tasks empty |
| 73 / 75 | 163396 / 165448 | same-session init and next assistant message (task-notification continuation, not our restart) |
| 82 / 104 / 107 | 166365 / 167282 / 167291 | urgent thinking row + envelope text row + keyed message_stop, all same ID; reject |
| 108 / 109 | 167307 / 168050 | second result (`origin.kind:task-notification`); actual child close 0, no signal |

### Correlation and complete messages

- Normal request `m-normal-42995c4e-5fed-48e8-93c0-fec5f1a86531`, UUID
  `21334238-0e0f-46a8-86f5-36ff12e2b25b`, sender `probe-sender`.
  Assistant `msg_011Cgm86zz16uJ6agHQWwfs2`, request
  `req_011Cgm86zWidH8VR2js9dNDY`, assistant UUID
  `a4ad8670-ce90-4e2e-ac61-36321b904b03`: exactly one text block, no tool,
  thinking or other prose. Its entire JSON is a v1 reply with `ack:true`,
  matching the pending normal ID and the bound session. `message_start`, all
  block stops, `message_delta(end_turn)` and `message_stop` agree on the
  explicit `api_message_id`. **A positive individual acknowledgement/reply
  observation**, not end-of-process grouping. It first becomes complete at
  seq 64, not at the text row or delta.
- Urgent request `m-urgent-c00d663f-2e92-4d2a-aa13-0a2bfb4821b2`, UUID
  `67133d94-ed0c-4240-ade8-079e3889d203`. Assistant
  `msg_011Cgm887hbJ3q9WMRRoynnL`, request
  `req_011Cgm887Uxb7AmyxvbPv7At`: thinking **and** text in the same completed
  message. Its correlated text alone is not receipt. Remains delivered,
  **unacknowledged/unreplied under the strict envelope mechanism**, even though
  provider lifecycle says completed and result repeats the envelope.

No structured receiver-tool hypothesis was exercised. The keyed partial-stream
boundary is a narrower useful finding, not independent confirmation of a
contract-complete runnable mechanism. No separate worker, Agent tool, hidden
resume, retry or successor input was observed; both results report spawned 0.
The second init uses the same child/session, not a second launch by the probe.

### Command and result/close safety

`build.sh` is the existing harmless boundary (source retained in JSON artifacts
and reproduced literally by the probe). Its retained provider task output is:

```text
BUILD-START 2026-11-06T05:26:48Z
BUILD-TOKEN-efc081e0
BUILD-END 2026-11-06T05:29:25Z

[exited with code 3]
```

The provider task notification binds exit 3 to the original tool/task/run IDs;
output is copied without changes into scratch. Output/token/exit survived, but
**untouched foreground/tool-result preservation was not demonstrated**: the
first tool result was a background timeout, not the completed exit-3 result.
The probe did not request backgrounding; provider behavior still violates the
required foreground scenario. There was no final BUILD RESULT line. Do not
substitute the later model's claim for tool evidence.

At first result, both identified inputs were already replayed/started/completed;
none was queued-but-not-started. There were no submissions after result. Normal
whole-message receipt remains true after exit. Urgent text arrived after stdin
end via background-task notification and is rejected as a whole message.
Closing stdin **did not stop already-enabled provider continuation**. This is
not proof that a queued-but-undelivered input is dropped or safely executed;
that race remains unknown. Current mc's task-aware policy would not close at
the first result while that task is alive, another unresolved launch/drain
integration difference. Never keep stdin open just to force a messaging turn.

Results list-price cost (not a subscription invoice): $0.028146 then cumulative
$0.0366976 (increment $0.0085516). Final cumulative model usage: 10 input,
419 output (89 thinking), 28,038 cache-read, 4,534 cache-created tokens.
No permission denial; SessionStart hook response succeeded. Neither establishes
new enforcement or equivalence of every production permission/hook boundary.

## Independent review and handoff

No safe contract-complete confirmation candidate was found: both priorities,
foreground preservation and an effective whole-tree bound were not jointly
established. Recommend **offline audit and explicitly unused reserved run**,
not spending it on repaired watchdog code, a new structured-output hypothesis,
different timeout, account, model, binary or forced extra turn. Independent
review owns that decision and its single allowance, not build. A demonstrated
conclusion would require positive independent confirmation under the full
contract; it is not claimed here.

Plan must disposition criterion 1's failed guard/foreground evidence and the
technical review handoff with criterion 2 unmet, without replenishing build's
budget. Build cannot truthfully perform the requested passing-1-and-3 handoff
because 1 is deficient. Publishing the negative record does not waive it.
Finish has zero further live runs; corrections use retained evidence only.
If review is authorized, it first replays raw evidence and audits exact launch,
route, boundary, result and budget; record criterion 2 only after that check.
Feature plan separately owns launch equivalence, completion stability, mixed
blocks, sole-owner/drain behavior, queued-input race, CLI/page and live acceptance.

## Offline reproduction and protection scope

Raw availability is a reproducibility prerequisite. Missing/changed raw files
must fail; narrative or condensed traces cannot replace raw reconciliation.
Only the two report files belong in git; probes and all raw files remain in
scratch. The JSON artifact manifest pins SHA-256 for raw/trace/source/help,
ledger, fixture, task output and historical Claude evidence. It also pins the
replay itself. No third live run is possible by reinterpreting these commands.

The report replay is commissioned bounded evidence, not a permanent test area.
Fault protected: false receipt from sender/tool/quoted/partial/mixed output or
missing completion, and erased command/budget/result failures. Existing overlap:
the old report's ended-run grouping/quote rejection, retained and rechecked;
this replay additionally reconciles indexed stream boundaries and every claimed
identity/observation. Fault-sensitive checks reject quoted, merged, fenced,
partial, wrong-ID/session/role, mixed-tool and thinking cases while the actual
normal envelope passes. It deliberately retains watchdog/foreground failures
as failures of safety, rather than asserting them away. No tests retired or
protection lost; no framework, scanner, gate or threshold added/modified.
Setup/file execution timing and final documentation gate evidence are recorded
in goal LOG/PR and scratch replay logs. No expensive or uncommissioned suite.

Extract the exact retained sources and replay **offline only**:

```sh
export MC_SCRATCH=/Users/martinforsberg/mc/runner/scratch/goal-mc-claude-receiver-completion-20261106T052417Z
node --input-type=module - <<'JS'
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const base='docs/technical/mc-claude-receiver-completion';
const md=readFileSync(base+'.md','utf8');
const report=JSON.parse(readFileSync(base+'.json','utf8'));
const out=process.env.MC_SCRATCH+'/extracted';mkdirSync(out,{recursive:true});
for(const m of md.matchAll(/<!-- source:(\S+) -->\n```(?:js|python)\n([\s\S]*?)\n```/g)) {
 const code=m[2]+'\n';
 assert.equal(createHash('sha256').update(code).digest('hex'),report.artifacts.find(a=>a.name===m[1]).sha256,m[1]);
 writeFileSync(out+'/'+m[1],code);
}
JS
node "$MC_SCRATCH/extracted/offline-replay.mjs" docs/technical/mc-claude-receiver-completion.json
```

Expected: exit 0 reconciliation, exactly the normal whole-message envelope,
urgent rejected, foreground false and watchdog unproved. This is **not** a
passing safety result. Final clean `git` selection/whitespace checks,
`mc gate --whole-selection` completed GREEN (or any actual failure), frozen
base/head/log/cost and `mc publish --no-merge` outcome belong in the append-only
goal LOG/PR, avoiding a self-referential commit SHA in these reports.

## Exact scratch probe, failed supervisor and executable offline replay

These sources are retained for audit, **not authorization to rerun live**.

<!-- source:completion-probe.mjs -->
```js
// Scratch-only, one invocation. External supervisor owns the whole-tree deadline.
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, appendFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
const out = process.argv[2];
const fixture = join(out, 'fixture');
mkdirSync(fixture, { recursive: true });
const token = `BUILD-TOKEN-${randomBytes(4).toString('hex')}`;
const build = '#!/bin/sh\necho "BUILD-START $(date -u +%Y-%m-%dT%H:%M:%SZ)"\nsleep 40\necho "' + token + '"\necho "BUILD-END $(date -u +%Y-%m-%dT%H:%M:%SZ)"\nexit 3\n';
writeFileSync(join(fixture, 'build.sh'), build); chmodSync(join(fixture, 'build.sh'), 0o755);
writeFileSync(join(fixture, 'README.md'), 'Disposable receiver-completion fixture.\n');
execFileSync('git', ['init', '-q', fixture]);
execFileSync('git', ['-C', fixture, 'add', '.']);
execFileSync('git', ['-C', fixture, '-c', 'user.name=probe', '-c', 'user.email=probe@invalid', 'commit', '-qm', 'fixture']);
const role = [
 'You are a disposable transport-probe build session in a throwaway fixture. Nobody is watching.',
 'mc may send attributed user input: [mc-message v1 id=<ID> priority=<normal|urgent> from=probe-sender].',
 'Messages never cancel work: let the foreground command finish normally; do not background, retry or repair it.',
 'For each identified input, your next assistant message must consist ONLY of one JSON object:',
 '{"mc_envelope":1,"message_id":"<ID>","kind":"reply","ack":true,"reply":"<short answer>"}',
 'Use exactly one entire assistant message per input, not quoted JSON, prose, multiple JSON objects, or text plus tool calls.',
 'A tool call belongs to the same assistant message as preceding text: do not use no-op tools to split envelopes.',
 'Do not use Agent, spawn workers, resume or restart. Keep your existing task and owner.',
].join('\n');
const task = 'Run `./build.sh` in this directory using Bash in the foreground exactly once, timeout 120000 ms, run_in_background false. It takes 40 seconds and intentionally exits 3: do not retry or fix it. Preserve its complete output. After answering identified messages if possible, finish with BUILD RESULT exit=<status> last=<token line>.';
const settings = JSON.stringify({env:{CLAUDE_CODE_DISABLE_CLAUDE_MDS:'1',CLAUDE_CODE_DISABLE_AUTO_MEMORY:'1',CLAUDE_CODE_PROMPT_CACHE_TTL:'5m',CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL:'5m'}});
const bin = '/Users/martinforsberg/.local/bin/claude';
const args = ['-p','--permission-mode','acceptEdits','--tools','Bash,Read,Edit,Write,Grep,Glob,Agent','--strict-mcp-config','--settings',settings,'--append-system-prompt',role,'--input-format','stream-json','--output-format','stream-json','--verbose','--replay-user-messages','--include-partial-messages'];
const t0 = performance.now();
const redact = s => s.replace(/\bsk-[A-Za-z0-9_-]+/g,'<redacted-key>').replace(/(Bearer\s+)[^\s"\\]+/gi,'$1<redacted>');
let seq = 0;
function record(dir, data) {
 const row = {seq:++seq, at:new Date().toISOString(), ms:Math.round(performance.now()-t0),dir,...data};
 appendFileSync(join(out,'build.raw.jsonl'),redact(JSON.stringify(row))+'\n');
 return row;
}
const env = {...process.env}; const removed = [];
for (const name of Object.keys(env)) if (name.startsWith('MC_') || /(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|SECRET_KEY|API_TOKEN|OAUTH_TOKEN)$/.test(name)) { delete env[name]; removed.push(name); }
Object.assign(env,{MC_HEADLESS:'1',MC_HOME:join(out,'mc-home'),MC_WORK_ROOT:join(out,'mc-root')});
record('control',{ev:'spawn',bin,args,cwd:fixture,token,removed,versions:{node:process.version,claude:execFileSync(bin,['--version'],{encoding:'utf8'}).trim()},owner:process.pid});
const child = spawn(bin,args,{cwd:fixture,stdio:['pipe','pipe','pipe'],env});
record('control',{ev:'pid',pid:child.pid});
let stopped = false, scheduled = false;
const timers = [];
const messages = [
 {id:'m-normal-'+randomUUID(),priority:'normal',uuid:randomUUID(),afterMs:4000,body:'What file are you working on right now? One short sentence.'},
 {id:'m-urgent-'+randomUUID(),priority:'urgent',uuid:randomUUID(),afterMs:9000,body:'Urgent status check: is your build command still running? Answer yes/no and one reason.'},
];
writeFileSync(join(out,'inputs.json'),JSON.stringify({role,task,messages,token},null,2)+'\n');
function send(text,uuid) {
 if (stopped) return;
 const event = {type:'user',message:{role:'user',content:text},parent_tool_use_id:null,session_id:'',uuid};
 record('in',{event}); child.stdin.write(JSON.stringify(event)+'\n');
}
function end(reason) {
 if (stopped) return;
 stopped=true; timers.forEach(clearTimeout);
 record('control',{ev:'stdin-end',reason}); child.stdin.end();
}
child.stdin.on('error',e=>record('control',{ev:'stdin-error',error:e.message}));
child.on('error',e=>record('control',{ev:'spawn-error',error:e.message}));
function onLine(line) {
 let e; try { e=JSON.parse(line); } catch { record('out',{unparsed:line}); return; }
 record('out',{event:e});
 if (e.type==='system' && e.subtype==='init' && e.apiKeySource!=='none') end('route not confirmed subscription; no fallback');
 if (e.type==='assistant') for (const b of e.message?.content??[]) {
  if (b.type==='tool_use' && b.name==='Bash' && b.input?.command==='./build.sh' && !scheduled) {
   scheduled=true;
   for (const m of messages) timers.push(setTimeout(()=>{
    // Metadata only; never inspect process environments or command arguments.
    record('control',{ev:'process-snapshot',rows:execFileSync('/bin/ps',['-axo','pid=,ppid=,pgid=,comm='],{encoding:'utf8'}).split('\n').filter(l=>/\b(sh|zsh|bash|sleep|claude|node)$/.test(l.trim()))});
    send(`[mc-message v1 id=${m.id} priority=${m.priority} from=probe-sender]\n${m.body}`,m.uuid);
   },m.afterMs));
  }
 }
 if (e.type==='result') end('first result; stop new submissions and observe until close');
}
const decoder = new StringDecoder('utf8'); let partial='';
child.stdout.on('data',chunk=>{const lines=(partial+decoder.write(chunk)).split('\n');partial=lines.pop();for(const line of lines) if(line.trim())onLine(line);});
child.stderr.on('data',chunk=>record('err',{text:chunk.toString('utf8')}));
child.on('close',(code,signal)=>{
 partial+=decoder.end();if(partial.trim())onLine(partial);
 timers.forEach(clearTimeout);stopped=true;
 record('control',{ev:'close',code,signal});
 // Derivation only; every full event remains in the raw file.
});
send(task,randomUUID());
```

<!-- source:supervise.py -->
```python
# Scratch-only one-shot allocation and whole-process-group watchdog.
import os,sys,time,json,subprocess,signal
from pathlib import Path
root=Path(sys.argv[1]); start=time.monotonic()
ledger=root/'budget.jsonl'
def log(**row):
 row.update(at=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),elapsed_s=round(time.monotonic()-start,3))
 with ledger.open('a') as f: f.write(json.dumps(row)+'\n'); f.flush(); os.fsync(f.fileno())
# O_EXCL forbids a second invocation, even after setup/spawn failure.
fd=os.open(root/'build-consumed',os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600);os.close(fd)
log(ev='consumed',stage='build',build_used=1,review_reserved=1,finish_allowance=0,total_allowance=2,limit_s=300)
with (root/'supervisor-output.log').open('w') as out:
 p=subprocess.Popen(['node',str(root/'completion-probe.mjs'),str(root)],start_new_session=True,stdout=out,stderr=subprocess.STDOUT)
 log(ev='group-start',pid=p.pid,pgid=p.pid,command=['node',str(root/'completion-probe.mjs'),str(root)])
 def alive():
  try: os.killpg(p.pid,0); return True
  except ProcessLookupError: return False
 terminated=False;killed=False
 while alive():
  elapsed=time.monotonic()-start
  if elapsed>=290 and not terminated:
   log(ev='deadline-term',pgid=p.pid);os.killpg(p.pid,signal.SIGTERM);terminated=True
  if elapsed>=292 and not killed:
   log(ev='deadline-kill',pgid=p.pid);os.killpg(p.pid,signal.SIGKILL);killed=True
  p.poll() # reap leader even if descendants remain
  if elapsed>=295: log(ev='group-still-present',pgid=p.pid);sys.exit(2)
  time.sleep(.1)
 status=p.wait()
 log(ev='group-empty',status=status,deadline_used=terminated)
 sys.exit(status)
```

<!-- source:offline-replay.mjs -->
```js
// Offline retained-evidence reconciliation; never launches a provider.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
const started = performance.now();
const reportPath = process.argv[2];
const report = JSON.parse(readFileSync(reportPath, 'utf8'));
const hash = b => createHash('sha256').update(b).digest('hex');
for (const a of report.artifacts) assert.equal(hash(readFileSync(a.path)), a.sha256, a.path);
const read = name => readFileSync(report.artifacts.find(a => a.name === name).path, 'utf8');
const rows = read('build.raw.jsonl').trim().split('\n').map(JSON.parse);
const inputs = JSON.parse(read('inputs.json'));
assert.deepEqual(rows.map(r => r.seq), Array.from({length:rows.length},(_,i)=>i+1));
const outgoing = rows.filter(r => r.dir === 'in');
const events = rows.filter(r => r.dir === 'out' && r.event).map(r => ({...r.event, seq:r.seq, ms:r.ms}));
const init = events.find(e=>e.type==='system' && e.subtype==='init');
const session = init.session_id;
assert.ok(session);
assert.ok(events.every(e=>e.session_id===session));
assert.ok(events.filter(e=>['assistant','stream_event'].includes(e.type)).every(e=>e.parent_tool_use_id==null));
assert.equal(init.apiKeySource,'none'); assert.equal(init.permissionMode,'acceptEdits');
assert.deepEqual(outgoing.map(r=>r.event.uuid), [outgoing[0].event.uuid,...inputs.messages.map(m=>m.uuid)]);
assert.equal(outgoing[0].event.message.content,inputs.task);
const pending = new Map(inputs.messages.map(m=>[m.id,m]));
for (const m of inputs.messages) {
 const sent=outgoing.find(r=>r.event.uuid===m.uuid);
 assert.equal(sent.event.message.content,`[mc-message v1 id=${m.id} priority=${m.priority} from=probe-sender]\n${m.body}`);
 const replay=events.find(e=>e.type==='user' && e.isReplay && e.uuid===m.uuid);
 assert.equal(replay.message.content,sent.event.message.content);
 assert.deepEqual(events.filter(e=>e.type==='command_lifecycle' && e.command_uuid===m.uuid).map(e=>e.state),['queued','started','completed']);
}
// Entire completed message only; no sender, tool, fence, quote, partial or wrong binding.
function envelope({role='assistant',session_id=session,blocks,complete=true}, expected=pending) {
 if(role!=='assistant'||session_id!==session||!complete||!blocks?.length||blocks.some(b=>b.type!=='text'))return null;
 const text=blocks.map(b=>b.text).join(''); let v;
 try {v=JSON.parse(text);} catch {return null;}
 if(!v||Array.isArray(v)||v.mc_envelope!==1||!expected.has(v.message_id)||v.ack!==true||!['ack','reply'].includes(v.kind))return null;
 if(v.kind==='reply'&&typeof v.reply!=='string')return null;
 const keys=Object.keys(v).sort();
 if(JSON.stringify(keys)!==JSON.stringify((v.kind==='reply'?['mc_envelope','message_id','kind','ack','reply']:['mc_envelope','message_id','kind','ack']).sort()))return null;
 return v;
}
const sample=JSON.stringify({mc_envelope:1,message_id:inputs.messages[0].id,kind:'reply',ack:true,reply:'sample'});
const text=t=>[{type:'text',text:t}];
assert.ok(envelope({blocks:text(sample)}));
for(const t of [`Here is an example:\n${sample}\nNot a receipt.`,sample+'\n'+sample,'```json\n'+sample+'\n```',sample.slice(0,-1)]) assert.equal(envelope({blocks:text(t)}),null);
for(const override of [{role:'user'},{session_id:'wrong'},{complete:false},{blocks:[...text(sample),{type:'tool_use',id:'x'}]},{blocks:[{type:'thinking',thinking:''},...text(sample)]},{blocks:text(sample.replace(inputs.messages[0].id,'wrong-id'))}])assert.equal(envelope({blocks:text(sample),...override}),null);
// Positive completion: message_start -> all indexed block stops -> message_delta ->
// message_stop carrying the SAME api_message_id on the bound session.
const groups=new Map();let active=null;
for(const e of events) {
 if(e.type==='stream_event') {
  const s=e.event; const id=e.api_message_id;
  if(s.type==='message_start') {
   assert.equal(active,null);assert.equal(s.message.id,id);assert.equal(s.message.role,'assistant');assert.ok(!groups.has(id));
   groups.set(id,{id,start:e.seq,blocks:[],open:new Set(),rows:[],stop:null,reason:null});active=id;
  }
  assert.equal(active,id); const g=groups.get(id);
  if(s.type==='content_block_start') {assert.equal(s.index,g.blocks.length);g.blocks.push({...s.content_block});g.open.add(s.index);}
  if(s.type==='content_block_delta') {
   assert.ok(g.open.has(s.index));const b=g.blocks[s.index], d=s.delta;
   if(d.type==='text_delta')b.text+=d.text;
   else if(d.type==='input_json_delta')b.json=(b.json??'')+d.partial_json;
   else if(d.type==='thinking_delta')b.thinking+=d.thinking;
   else if(d.type==='signature_delta')b.signature+=d.signature;
   else assert.fail('unhandled block delta: '+d.type);
  }
  if(s.type==='content_block_stop') {assert.ok(g.open.delete(s.index));}
  if(s.type==='message_delta') {assert.equal(g.open.size,0);g.reason=s.delta.stop_reason;}
  if(s.type==='message_stop') {assert.equal(g.open.size,0);assert.ok(g.reason);g.stop=e.seq;active=null;}
 }
 if(e.type==='assistant') {
  const g=groups.get(e.message.id);assert.ok(g);assert.equal(g.stop,null);assert.equal(e.message.role,'assistant');g.rows.push(e);
 }
}
assert.equal(active,null);
const accepted=[];
const completed=[...groups.values()].map(g=>{
 assert.ok(g.stop);const bs=g.rows.flatMap(e=>e.message.content);
 assert.equal(bs.length,g.blocks.length);
 for(let i=0;i<bs.length;i++) {
  const b={...g.blocks[i]};if(b.type==='tool_use'){b.input=JSON.parse(b.json);delete b.json;}
  assert.deepEqual(b,bs[i]); // includes every thinking/text/tool block, not text rows only
 }
 const env=envelope({blocks:bs,complete:!!g.stop});
 if(env) accepted.push({assistant_id:g.id,message_id:env.message_id,stop_seq:g.stop,kind:env.kind,ack:env.ack,reply:env.reply});
 return {id:g.id,start_seq:g.start,stop_seq:g.stop,stop_reason:g.reason,block_types:bs.map(b=>b.type),assistant_uuids:g.rows.map(e=>e.uuid),request_ids:[...new Set(g.rows.map(e=>e.request_id))],envelope:env};
});
const tools=events.filter(e=>e.type==='assistant').flatMap(e=>e.message.content.filter(b=>b.type==='tool_use'));
assert.deepEqual(tools.map(b=>[b.name,b.input.command]),[['Bash','./build.sh']]);
assert.equal(tools[0].input.run_in_background,false);assert.equal(tools[0].input.timeout,120000);
const tool=tools[0];const toolRow=events.find(e=>e.type==='assistant');
const resultRow=events.find(e=>e.type==='user' && Array.isArray(e.message.content) && e.message.content.some(b=>b.type==='tool_result' && b.tool_use_id===tool.id));
assert.equal(resultRow.tool_use_result.interrupted,false);assert.equal(resultRow.tool_use_result.timedOutAfterMs,120000);
assert.equal(resultRow.tool_use_result.backgroundTaskId,'b3g535888');
const done=events.find(e=>e.type==='system' && e.subtype==='task_notification');
assert.equal(done.tool_use_id,tool.id);assert.match(done.summary,/exit code 3$/);
const output=read('build-task-output.txt');
assert.match(output,new RegExp('^BUILD-START [^\\n]+\\n'+inputs.token+'\\nBUILD-END [^\\n]+\\n\\n\\[exited with code 3\\]\\n$'));
for(const m of inputs.messages){const sent=outgoing.find(r=>r.event.uuid===m.uuid);assert.ok(sent.seq>toolRow.seq&&sent.seq<resultRow.seq);}
const results=events.filter(e=>e.type==='result');assert.deepEqual(results.map(e=>e.result_index),[0,1]);
const end=rows.find(r=>r.ev==='stdin-end'),close=rows.find(r=>r.ev==='close');
assert.ok(results[0].seq<end.seq&&end.seq<done.seq&&done.seq<results[1].seq&&results[1].seq<close.seq);
assert.ok(outgoing.every(r=>r.seq<end.seq));assert.equal(close.code,0);assert.equal(close.signal,null);
assert.equal(results[1].origin.kind,'task-notification');
assert.ok(results.every(e=>e.subagent_stats.spawned===0));
const ledger=read('budget.jsonl').trim().split('\n').map(JSON.parse);
assert.deepEqual(ledger.filter(e=>e.ev==='consumed').map(e=>[e.stage,e.build_used,e.review_reserved]),[['build',1,1]]);
assert.ok(!ledger.some(e=>e.ev==='group-empty')); // fail closed on the known watchdog failure
assert.match(read('tool-result-transcript.txt'),/PermissionError: \[Errno 1\] Operation not permitted/);
const consumed=ledger.find(e=>e.ev==='consumed');const observedSeconds=(Date.parse(close.at)-Date.parse(consumed.at))/1000;
assert.ok(observedSeconds<300); // observed child close, NOT proof of whole-tree deadline enforcement
for(const name of ['claude-run1.raw.jsonl','claude-run2.raw.jsonl']) {
 const old=read(name).split('\n').filter(l=>l.startsWith('<< ')).map(l=>JSON.parse(l.slice(3)));
 const byId=new Map();
 for(const e of old.filter(e=>e.type==='assistant')) {const id=e.session_id+'/'+e.message.id;byId.set(id,[...(byId.get(id)??[]),...e.message.content]);}
 const candidates=[...byId.values()].filter(bs=>bs.every(b=>b.type==='text')).filter(bs=>{try{const v=JSON.parse(bs.map(b=>b.text).join(''));return v.mc_envelope===1;}catch{return false;}});
 assert.deepEqual(candidates,[]); // ended-record grouping is NOT a completion algorithm
}
const observations={session,model:init.model,apiKeySource:init.apiKeySource,owner:rows[0].owner,child:rows.find(r=>r.ev==='pid').pid,inputs:inputs.messages.map(m=>({id:m.id,uuid:m.uuid,priority:m.priority})),ordered_output_uuids:events.map(e=>e.uuid),completed,accepted,tool:{id:tool.id,assistant_id:toolRow.message.id,tool_result_seq:resultRow.seq,foreground_preserved:false,notification_seq:done.seq,exit:3,token:inputs.token},results:results.map(e=>({seq:e.seq,uuid:e.uuid,index:e.result_index,num_turns:e.num_turns,total_cost_usd:e.total_cost_usd,origin:e.origin??null})),stdin_end_seq:end.seq,close_seq:close.seq,close_at:close.at,observed_allocation_to_close_s:observedSeconds,watchdog_compliance:false,queued_not_started_at_first_result:inputs.messages.filter(m=>!events.some(e=>e.seq<results[0].seq&&e.type==='command_lifecycle'&&e.command_uuid===m.uuid&&e.state==='started')).map(m=>m.id)};
if(process.argv[3]==='--emit') console.log(JSON.stringify(observations,null,2));
else {assert.deepEqual(observations,report.observations);console.log(JSON.stringify({reconciled:true,artifacts:report.artifacts.length,whole_message_envelopes:accepted.map(e=>e.message_id),urgent:'rejected thinking+text',watchdog:'unproved',foreground_preserved:false,elapsed_ms:Math.round(performance.now()-started)}));}
```
