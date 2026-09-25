#!/usr/bin/env python3
"""Where a step's time goes — the measurement behind step-parallelism (2026-09-03).

Lived in docs/project/mc/step-parallelism/ until that plan was archived; the
baseline it produced is in that directory's history and in project_log.md.

Reads what the runner and the sessions already write, joins them on the
session id, and prints one table per window. No dependencies beyond python3.

    python3 scripts/measure-steps.py --since 2026-09-01 --until 2026-09-04
    python3 scripts/measure-steps.py --since 2026-09-03T19:35 --until 2026-09-05   # an instant works too

Sources (all local, see docs/technical/mc-run.md):
  ~/mc/runner/log/runs.tsv              one row per step/reconcile session
  ~/mc/runner/log/<project>-<ts>.json   the session's own result (claude -p --output-format json)
  ~/.claude/projects/<cwd>/<sid>.jsonl  the transcript, for what the turns were spent on
  ~/mc/runner/log/runner.log            the runner's narration: starts, ends, landings, skips
"""
import argparse
import collections
import datetime as dt
import glob
import json
import os
import re
import statistics as st

HOME = os.path.expanduser('~')
LOG = f'{HOME}/mc/runner/log'


def parse_ts(s):
    return dt.datetime.fromisoformat(s.replace('Z', '+00:00'))


def seconds(a, b):
    try:
        return (parse_ts(b) - parse_ts(a)).total_seconds()
    except (TypeError, ValueError):
        return 0.0


def classify(cmd):
    """One Bash command → what it was for."""
    first = cmd.strip().split('\n')[0]
    if re.search(r'\b(npm (run )?(test|ci)|node --test|npx .*test|vitest|playwright|test:)', cmd):
        return 'tests'
    if re.search(r'\bsleep\b|until |for i in \$\(seq|while kill|while sleep', cmd):
        return 'poll/wait'
    if re.match(r'\s*(sed -n|grep|cat |head|tail|ls|find|wc|rg|cat -n)', first):
        return 'read/search'
    if re.match(r'\s*(git|gh)\b', first):
        return 'git/gh'
    if re.match(r'\s*(cat >|python3? -|node -e|perl|tee)', first):
        return 'write/script'
    if re.search(r'npm (ci|install)|npm run (build|dev|start)|wrangler|curl', cmd):
        return 'build/run'
    return 'other'


def norm(bound):
    """A day (2026-09-03) or an instant (2026-09-03T19:35) as the file stamp compares."""
    digits = ''.join(ch for ch in bound if ch.isdigit())
    padded = (digits + '0' * 14)[:14]
    return f'{padded[:8]}T{padded[8:]}'


# List prices, $ per million tokens — src/mc/prices.js, kept by hand. Cache
# reads at 0.1× input, cache writes at 2× (the 1-hour cache Claude Code writes).
PRICES = {'claude-opus': (5, 25), 'claude-sonnet-5': (2, 10), 'claude-sonnet': (3, 15), 'claude-haiku': (1, 5), 'claude-fable': (10, 50)}


def price(model, usage):
    best = max((k for k in PRICES if model.startswith(k)), key=len, default=None)
    if not best:
        return 0.0
    i, o = PRICES[best]
    return (usage.get('input_tokens', 0) * i + usage.get('output_tokens', 0) * o
            + usage.get('cache_creation_input_tokens', 0) * i * 2 + usage.get('cache_read_input_tokens', 0) * i * 0.1) / 1e6


def stream_summary(path):
    """The result-shaped object `streamSummary` (run-plan.js) makes of a stream with no `result` line.

    A session `mc merge` ended (ruling 21: green ends the process) never prints
    one; before 2026-09-25 the runner wrote no `.json` for it either, so the
    landed steps — most of them — were invisible here. Turns are distinct
    assistant message ids, usage is summed over them, cost is list price.
    """
    messages, session, model = {}, None, None
    for line in open(path, errors='replace'):
        if '"type":"assistant"' not in line:
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        message = event.get('message') or {}
        if event.get('type') != 'assistant' or not message.get('id') or message.get('model') == '<synthetic>':
            continue
        session = event.get('session_id') or session
        model = message.get('model') or model
        messages[message['id']] = (message.get('model'), message.get('usage') or {})
    if not messages:
        return None
    usage, by_model, cost = collections.Counter(), {}, 0.0
    for m, u in messages.values():
        for key in ('input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'):
            usage[key] += u.get(key, 0)
        into = by_model.setdefault(m, collections.Counter())
        into['outputTokens'] += u.get('output_tokens', 0)
        cost += price(m or '', u)
    return {'subtype': 'killed', 'session_id': session, 'num_turns': len(messages), 'usage': dict(usage),
            'modelUsage': {m: dict(c) for m, c in by_model.items()}, 'total_cost_usd': cost, 'model': model}


def sessions(since, until, min_turns):
    """Every step session in the window with its result json (or the summary of its stream) and transcript."""
    out = []
    for path in sorted(glob.glob(f'{LOG}/*-*.jsonl')):
        stamp = os.path.basename(path).rsplit('-', 1)[1][:15]   # YYYYMMDDTHHMMSS
        if not (norm(since) <= stamp < norm(until)):
            continue
        try:
            result = json.load(open(path[:-1]))
        except (json.JSONDecodeError, OSError):
            result = stream_summary(path)
        if not result:
            continue
        if (result.get('num_turns') or 0) < min_turns:
            continue
        sid = result.get('session_id')
        transcript = glob.glob(f'{HOME}/.claude/projects/*/{sid}.jsonl') if sid else []
        name = os.path.basename(path)[:-6]
        SESSION_OF[name] = sid or ''
        out.append((name, result, transcript[0] if transcript else None))
    return out


def result_chars(part):
    """How much a tool result put into the context: its text, in characters (≈ 4 per token)."""
    content = part.get('content')
    if isinstance(content, str):
        return len(content)
    if isinstance(content, list):
        return sum(len(c.get('text', '')) for c in content if isinstance(c, dict))
    return 0


def walk(transcript):
    """Tool calls from a transcript: (tool, class, call→result seconds, result characters, think seconds before it)."""
    calls, order, results, sizes, think = {}, [], {}, {}, []
    last_result = None
    multi = 0   # assistant turns that carried more than one tool call — the batching the prompt asks for
    for line in open(transcript):
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        message = event.get('message') or {}
        ts = event.get('timestamp')
        if event.get('type') == 'assistant':
            content = message.get('content') or []
            uses = [c for c in content if isinstance(c, dict) and c.get('type') == 'tool_use']
            if len(uses) > 1:
                multi += 1
            if uses and last_result:
                think.append(seconds(last_result, ts))
                last_result = None
            for use in uses:
                name = use['name']
                kind = classify(use.get('input', {}).get('command', '')) if name == 'Bash' else f'native {name}'
                calls[use['id']] = (name, kind, ts)
                order.append(use['id'])
        elif event.get('type') == 'user' and isinstance(message.get('content'), list):
            for part in message['content']:
                if isinstance(part, dict) and part.get('type') == 'tool_result':
                    last_result = ts
                    if part.get('tool_use_id') in calls:
                        results[part['tool_use_id']] = ts
                        sizes[part['tool_use_id']] = result_chars(part)
    rows = []
    for cid in order:
        name, kind, started = calls[cid]
        rows.append((name, kind, seconds(started, results[cid]) if cid in results else 0.0, sizes.get(cid, 0)))
    return rows, think, multi


def quantiles(label, xs, unit=1.0, fmt='{:6.1f}'):
    xs = sorted(xs)
    if not xs:
        return f'{label:44s} n=0'
    q = lambda p: xs[min(len(xs) - 1, int(p * len(xs)))] / unit
    return (f'{label:44s} n={len(xs):4d} med=' + fmt.format(st.median(xs) / unit)
            + ' p75=' + fmt.format(q(.75)) + ' p90=' + fmt.format(q(.9)) + ' max=' + fmt.format(xs[-1] / unit))


def main_model(result):
    """The model that did the session's work: the modelUsage key with the most output.

    A session's json lists every model it touched — claude's own haiku calls, an
    advisor — so the main one is the one that wrote the most, not the first.
    """
    usage = result.get('modelUsage') or {}
    if not usage:
        return 'unknown'
    return max(usage.items(), key=lambda kv: (kv[1] or {}).get('outputTokens', 0))[0]


RUNS = {}


def load_runs():
    """runs.tsv by session id and by (project, start time): a row ended `mc merge`
    killed carries no session id, so it is found from its project and its start
    — the row's `ts` minus its `seconds`, which is the log stem's timestamp."""
    try:
        with open(f'{LOG}/runs.tsv') as f:
            header = f.readline().rstrip('\n').split('\t')
            for line in f:
                row = dict(zip(header, line.rstrip('\n').split('\t')))
                note = row.get('note', '')
                RUNS[row.get('session', '-')] = note
                try:
                    start = parse_ts(row['ts']) - dt.timedelta(seconds=int(row['seconds']))
                except (KeyError, ValueError):
                    continue
                RUNS.setdefault(('start', row.get('name')), []).append((start, note))
    except OSError:
        pass
    RUNS['-'] = ''


def merged(name):
    """Did runs.tsv say `merged` for this session (by id, else by project and start within two minutes)?"""
    if not RUNS:
        load_runs()
    sid = SESSION_OF.get(name, '')
    if sid and sid in RUNS:
        return 'merged' in RUNS[sid]
    project, stamp = name.rsplit('-', 1)
    started = dt.datetime.strptime(stamp, '%Y%m%dT%H%M%SZ').replace(tzinfo=dt.timezone.utc)
    for start, note in RUNS.get(('start', project), []):
        if abs((start - started).total_seconds()) <= 120:
            return 'merged' in note
    return False


SESSION_OF = {}


def summary(found, indent=''):
    """Wall, API time, turns, cost and context per turn for a set of sessions."""
    walls = [r['duration_ms'] / 1000 for _, r, _ in found if r.get('duration_ms') is not None]
    apis = [r['duration_api_ms'] / 1000 for _, r, _ in found if r.get('duration_api_ms') is not None]
    turns = [r['num_turns'] for _, r, _ in found]
    costs = [r['total_cost_usd'] for _, r, _ in found if r.get('total_cost_usd')]
    # What every turn re-read: the session's whole input (cache hits and the rest)
    # over its turns — the same usage fields readSessionOutput puts in runs.tsv.
    # The number step-cost's step 1 (the plan excerpt, --autocompact) is measured on.
    contexts = [((r.get('usage') or {}).get('cache_read_input_tokens', 0) + (r.get('usage') or {}).get('input_tokens', 0))
                / r['num_turns'] for _, r, _ in found if r.get('num_turns')]
    # Cache health: the share of the session's input that was served from cache.
    # Under ~0.8 something is invalidating the prefix — a changing system prompt,
    # a tool set that varies — and every turn is paying write price for it.
    shares = []
    for _, r, _ in found:
        u = r.get('usage') or {}
        read = u.get('cache_read_input_tokens', 0)
        total = read + u.get('input_tokens', 0) + u.get('cache_creation_input_tokens', 0)
        if total:
            shares.append(read / total)
    # The unit is the landed step, not the session (ruling 18): a session that
    # gave up early looks cheap per session and is pure cost per landed step.
    landed = [r['total_cost_usd'] for name, r, _ in found if r.get('total_cost_usd') and merged(name)]
    for line in (quantiles('session wall (min)', walls, 60),
                 quantiles('session API time (min)', apis, 60),
                 quantiles('turns', turns, 1, '{:6.0f}'),
                 quantiles('cost (USD)', costs, 1),
                 quantiles('context per turn (k tokens)', contexts, 1000),
                 quantiles('cache share of input', shares, 1, '{:6.2f}')):
        print(indent + line)
    if costs:
        print(indent + f'{"cost per landed step (USD)":44s} landed={len(landed):3d}/{len(found):<3d} '
              f'sum/landed={sum(costs) / max(len(landed), 1):6.1f} med(landed)={st.median(landed) if landed else 0:6.1f}')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--since', required=True, help='first day or instant, inclusive (YYYY-MM-DD or YYYY-MM-DDTHH:MM)')
    ap.add_argument('--until', required=True, help='last day or instant, exclusive')
    ap.add_argument('--min-turns', type=int, default=10, help='ignore sessions that died before doing anything')
    args = ap.parse_args()

    found = sessions(args.since, args.until, args.min_turns)
    print(f'{len(found)} step sessions {args.since}..{args.until} with ≥{args.min_turns} turns; '
          f'{sum(1 for _, _, t in found if t)} with a transcript\n')

    summary(found)
    # The same rows once per main model — the comparison step-cost (ruling 18)
    # is measured on: opus at high effort before, sonnet at medium with an opus
    # advisor after.
    by_model = collections.defaultdict(list)
    for item in found:
        by_model[main_model(item[1])].append(item)
    for model, items in sorted(by_model.items(), key=lambda kv: -len(kv[1])):
        print(f'\nmain model {model}: {len(items)} sessions')
        summary(items, '  ')
    print()
    errors = collections.Counter(str(r.get('result'))[:40] for _, r, _ in found if r.get('is_error'))
    print(f'ended in an API error: {sum(errors.values())} {dict(errors)}\n')

    by_class = collections.defaultdict(lambda: [0, 0.0, 0])
    tool_calls = collections.Counter()
    tests_per, think_all, timeouts, multi_per = [], [], 0, []
    repeats, test_commands = 0, 0
    for _, _, transcript in found:
        if not transcript:
            continue
        rows, think, multi = walk(transcript)
        think_all.extend(think)
        multi_per.append(multi)
        seen = collections.Counter()
        n_tests = 0
        for name, kind, secs, chars in rows:
            by_class[kind][0] += 1
            by_class[kind][1] += secs
            by_class[kind][2] += chars
            tool_calls[name] += 1
            if 118 <= secs <= 126:
                timeouts += 1
            if kind == 'tests':
                n_tests += 1
        tests_per.append(n_tests)
    # Result tokens: what each class put into the context (chars / 4), which every
    # later turn of that session re-reads. The wall column is where the time went;
    # this column is where the context went.
    total = sum(v[1] for v in by_class.values()) or 1
    total_chars = sum(v[2] for v in by_class.values()) or 1
    print(f'{"tool class":24s} {"calls":>6s} {"wall":>8s} {"share":>6s} {"result ktok":>12s} {"share":>6s} {"tok/call":>9s}')
    for kind, (n, secs, chars) in sorted(by_class.items(), key=lambda kv: -kv[1][2]):
        print(f'{kind:24s} {n:6d} {secs / 3600:7.1f}h {secs / total * 100:5.0f}% {chars / 4000:11.0f}k {chars / total_chars * 100:5.0f}% {chars / 4 / max(n, 1):9.0f}')
    print()
    print(quantiles('test-class calls per session', tests_per, 1, '{:6.0f}'))
    print(quantiles('model think time per turn (s)', think_all, 1))
    print(quantiles('turns with more than one tool call', multi_per, 1, '{:6.0f}'))
    bash = tool_calls['Bash']
    native = sum(v for k, v in tool_calls.items() if k in ('Read', 'Grep', 'Glob', 'Edit', 'Write'))
    print(f'Bash calls {bash} vs native Read/Grep/Glob/Edit/Write {native}; Bash calls killed at the 120 s timeout: {timeouts}')


if __name__ == '__main__':
    main()
