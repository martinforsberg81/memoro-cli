#!/usr/bin/env python3
"""Where a step's time goes — the measurement behind step-parallelism.

Reads what the runner and the sessions already write, joins them on the
session id, and prints one table per window. No dependencies beyond python3.

    python3 measure.py --since 2026-09-01 --until 2026-09-04

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


def sessions(since, until, min_turns):
    """Every step session in the window with its result json and transcript."""
    out = []
    for path in sorted(glob.glob(f'{LOG}/*-*.json')):
        stamp = os.path.basename(path).rsplit('-', 1)[1][:15]   # YYYYMMDDTHHMMSS
        if not (norm(since) <= stamp < norm(until)):
            continue
        try:
            result = json.load(open(path))
        except (json.JSONDecodeError, OSError):
            continue
        if (result.get('num_turns') or 0) < min_turns:
            continue
        sid = result.get('session_id')
        transcript = glob.glob(f'{HOME}/.claude/projects/*/{sid}.jsonl') if sid else []
        out.append((os.path.basename(path)[:-5], result, transcript[0] if transcript else None))
    return out


def walk(transcript):
    """Tool calls from a transcript: (tool, class, call→result seconds, think seconds before it)."""
    calls, order, results, think = {}, [], {}, []
    last_result = None
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
    rows = []
    for cid in order:
        name, kind, started = calls[cid]
        rows.append((name, kind, seconds(started, results[cid]) if cid in results else 0.0))
    return rows, think


def quantiles(label, xs, unit=1.0, fmt='{:6.1f}'):
    xs = sorted(xs)
    if not xs:
        return f'{label:44s} n=0'
    q = lambda p: xs[min(len(xs) - 1, int(p * len(xs)))] / unit
    return (f'{label:44s} n={len(xs):4d} med=' + fmt.format(st.median(xs) / unit)
            + ' p75=' + fmt.format(q(.75)) + ' p90=' + fmt.format(q(.9)) + ' max=' + fmt.format(xs[-1] / unit))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--since', required=True, help='first day or instant, inclusive (YYYY-MM-DD or YYYY-MM-DDTHH:MM)')
    ap.add_argument('--until', required=True, help='last day or instant, exclusive')
    ap.add_argument('--min-turns', type=int, default=10, help='ignore sessions that died before doing anything')
    args = ap.parse_args()

    found = sessions(args.since, args.until, args.min_turns)
    print(f'{len(found)} step sessions {args.since}..{args.until} with ≥{args.min_turns} turns; '
          f'{sum(1 for _, _, t in found if t)} with a transcript\n')

    walls = [r['duration_ms'] / 1000 for _, r, _ in found]
    apis = [r['duration_api_ms'] / 1000 for _, r, _ in found]
    turns = [r['num_turns'] for _, r, _ in found]
    costs = [r['total_cost_usd'] for _, r, _ in found if r.get('total_cost_usd')]
    print(quantiles('session wall (min)', walls, 60))
    print(quantiles('session API time (min)', apis, 60))
    print(quantiles('turns', turns, 1, '{:6.0f}'))
    print(quantiles('cost (USD)', costs, 1))
    errors = collections.Counter(str(r.get('result'))[:40] for _, r, _ in found if r.get('is_error'))
    print(f'ended in an API error: {sum(errors.values())} {dict(errors)}\n')

    by_class = collections.defaultdict(lambda: [0, 0.0])
    tool_calls = collections.Counter()
    tests_per, think_all, timeouts = [], [], 0
    repeats, test_commands = 0, 0
    for _, _, transcript in found:
        if not transcript:
            continue
        rows, think = walk(transcript)
        think_all.extend(think)
        seen = collections.Counter()
        n_tests = 0
        for name, kind, secs in rows:
            by_class[kind][0] += 1
            by_class[kind][1] += secs
            tool_calls[name] += 1
            if 118 <= secs <= 126:
                timeouts += 1
            if kind == 'tests':
                n_tests += 1
        tests_per.append(n_tests)
    total = sum(v[1] for v in by_class.values()) or 1
    print(f'{"tool class":24s} {"calls":>6s} {"wall":>8s} {"share":>6s}')
    for kind, (n, secs) in sorted(by_class.items(), key=lambda kv: -kv[1][1]):
        print(f'{kind:24s} {n:6d} {secs / 3600:7.1f}h {secs / total * 100:5.0f}%')
    print()
    print(quantiles('test-class calls per session', tests_per, 1, '{:6.0f}'))
    print(quantiles('model think time per turn (s)', think_all, 1))
    bash = tool_calls['Bash']
    native = sum(v for k, v in tool_calls.items() if k in ('Read', 'Grep', 'Glob', 'Edit', 'Write'))
    print(f'Bash calls {bash} vs native Read/Grep/Glob/Edit/Write {native}; Bash calls killed at the 120 s timeout: {timeouts}')


if __name__ == '__main__':
    main()
