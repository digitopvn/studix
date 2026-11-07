#!/usr/bin/env python3
"""Measure one skill's invocations in local agent transcripts; read-only, never prints message text.

Scans Claude Code (`<config>/projects/**/*.jsonl`) and Codex (`<home>/sessions/**/*.jsonl`)
transcripts, slices each invocation from its trigger to the next human prompt, and emits
JSON metrics (tokens, turns, tool calls, errors, latency, delegation, skill files read)
plus heuristic signals. Signals are review leads, not verdicts.
"""

import argparse
import json
import os
import re
import statistics
import sys
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path

from encoding_utils import configure_utf8_console

MECHANICAL_TOOLS = {
    'Read', 'Grep', 'Glob', 'LS', 'Bash', 'PowerShell', 'WebFetch', 'WebSearch', 'NotebookRead',
    'exec_command', 'shell', 'exec', 'read_file', 'list_dir', 'grep_files', 'view_image', 'wait',
}
DELEGATION_TOOLS = {'Agent', 'Task'}
WAIT_TOOLS = {'sleep', 'wait', 'Monitor', 'ScheduleWakeup', 'write_stdin'}
NON_HUMAN_PREFIXES = ('<system-reminder>', '<task-notification>', '<local-command', 'Caveat:', '<environment_context>',
                      '# AGENTS.md instructions', '# Files mentioned by the user', 'This session is being continued')
INJECTED_EVENT = re.compile(r'<[\w-]+-event\b')
INTERRUPT_PREFIX = '[Request interrupted'
# Only the head of a tool output is inspected, so a failed exit printed inside file content is not an error.
EXIT_CODE = re.compile(r'^.{0,300}?(?:[Ee]xit code:?|exited with code|exit status|"exit_code"\s*:)\s*[1-9]', re.S)
TOKEN_FIELDS = ('input', 'cache_read', 'cache_write', 'output', 'reasoning')


class SkillId:
    """Names and directory slug that identify one skill across runtimes."""

    def __init__(self, raw):
        path = Path(raw)
        self.dir = path.resolve() if (path / 'SKILL.md').is_file() else None
        name = self.dir.name if self.dir else raw.strip().lstrip('/$')
        if ':' in name:
            ns, slug = name.rsplit(':', 1)
            self.slug = f'{ns.rsplit(":", 1)[-1]}-{slug}'
        else:
            self.slug = name
        self.names = {name, self.slug}
        if self.slug.startswith('ak-'):
            self.names.add('ak:' + self.slug[3:])
        self.modes = argument_modes(self.dir)
        # Trigger forms only: every transcript's skill catalog mentions every skill name.
        self.needles = [form.format(n).encode() for n in self.names for form in
                        ('"skill":"{}"', '"skill": "{}"', ':{}"', '<command-name>/{}<', ':{}<', '${}', '/{}')]
        self.needles += [f'{self.slug}{sep}SKILL.md'.encode() for sep in ('/', '\\', '\\\\')]
        slug = re.escape(self.slug)
        self.file_ref = re.compile(r'(?<![\w.-])' + slug + r'[/\\]+((?:references|scripts|assets)(?:[/\\]+[\w.\-]+)+|SKILL\.md)')
        self.mention = re.compile(r'(?:^|\s)[$/](' + '|'.join(re.escape(n) for n in sorted(self.names)) + r')(?=\s|$)')

    def matches(self, value):
        value = str(value or '')
        return value in self.names or any(value.endswith(':' + n) for n in self.names)

    def files_in(self, payload):
        return {clean_rel(m) for text in strings(payload) for m in self.file_ref.findall(text)}


def clean_rel(match):
    """Normalize separators and drop what a literal escape such as `\\n` glued onto the path."""
    parts = [p for p in re.split(r'[/\\]+', match) if p]
    for index, part in enumerate(parts):
        if '.' in part.strip('.'):
            return '/'.join(parts[:index + 1])
    return '/'.join(parts[:-1] if len(parts) > 1 and parts[-1] in ('n', 'r', 't') else parts)


def strings(value):
    """Yield every string inside a tool payload; JSON-encoded argument strings are decoded first."""
    if isinstance(value, str):
        if value.lstrip()[:1] in ('{', '['):
            try:
                yield from strings(json.loads(value))
                return
            except json.JSONDecodeError:
                pass
        yield value
    elif isinstance(value, dict):
        for item in value.values():
            yield from strings(item)
    elif isinstance(value, list):
        for item in value:
            yield from strings(item)


def argument_modes(skill_dir):
    """Leading literal words of the skill's argument-hint, such as create|update|audit."""
    if not skill_dir:
        return set()
    text = (skill_dir / 'SKILL.md').read_text(encoding='utf-8', errors='replace')
    hint = re.search(r'^argument-hint:\s*["\']?(.*?)["\']?\s*$', text, re.M)
    first = re.match(r'[<\[]?([\w|-]+)', hint.group(1)) if hint else None
    return {m.lower() for m in first.group(1).split('|') if m} if first else set()


def subcommand(args, modes):
    """Report only a known mode so free-text prompt words never reach the output."""
    words = (args or '').split()
    if not words:
        return None
    return words[0].lower() if words[0].lower() in modes else '(free-text)'


def parse_ts(value):
    try:
        return datetime.fromisoformat(str(value).replace('Z', '+00:00'))
    except ValueError:
        return None


def seconds(a, b):
    return round((b - a).total_seconds(), 3) if a and b else None


def load_jsonl(path):
    events = []
    with open(path, encoding='utf-8', errors='replace') as handle:
        for line in handle:
            try:
                events.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return events


def new_record(runtime, session, trigger, args, modes=(), entrypoint=None):
    return {
        'runtime': runtime, 'session': (session or '')[:8], 'entrypoint': entrypoint, 'trigger': trigger,
        'subcommand': subcommand(args, modes),
        'started_at': None, 'duration_s': None, 'turns': 0, 'models': Counter(), 'effort': None,
        'tool_calls': 0, 'tools': Counter(), 'tool_errors': 0, 'errors_by_tool': Counter(),
        'duplicate_calls': 0, 'tool_latency_s': Counter(), 'interruptions': 0,
        'tokens': dict.fromkeys(TOKEN_FIELDS, 0), 'skill_files': Counter(), 'skills_chained': Counter(),
        'delegations': Counter(), 'subagent': {'runs': 0, 'tokens': dict.fromkeys(TOKEN_FIELDS, 0), 'models': Counter()},
    }


def record_tool(record, sid, name, payload, seen):
    record['tool_calls'] += 1
    record['tools'][name] += 1
    key = (name, payload if isinstance(payload, str) else json.dumps(payload, sort_keys=True))
    if key in seen:
        record['duplicate_calls'] += 1
    seen.add(key)
    for rel in sid.files_in(payload):
        record['skill_files'][rel] += 1


def finish(record, first, last):
    record['started_at'] = first.isoformat() if first else None
    record['duration_s'] = seconds(first, last)
    for key in ('models', 'tools', 'errors_by_tool', 'skill_files', 'skills_chained', 'delegations'):
        record[key] = dict(record[key])
    record['tool_latency_s'] = {k: round(v, 3) for k, v in record['tool_latency_s'].items()}
    record['subagent']['models'] = dict(record['subagent']['models'])
    mechanical = sum(n for t, n in record['tools'].items() if t in MECHANICAL_TOOLS or t.startswith('mcp__'))
    record['mechanical_share'] = round(mechanical / record['tool_calls'], 3) if record['tool_calls'] else None
    return record


# ---------------------------------------------------------------- Claude Code

def claude_text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return '\n'.join(b.get('text', '') for b in content if isinstance(b, dict) and b.get('type') == 'text')
    return ''


def claude_is_human(event):
    if event.get('type') != 'user' or any(event.get(flag) for flag in
                                          ('isMeta', 'isSidechain', 'isCompactSummary', 'isVisibleInTranscriptOnly')):
        return False
    content = (event.get('message') or {}).get('content')
    if isinstance(content, list) and any(isinstance(b, dict) and b.get('type') == 'tool_result' for b in content):
        return False
    return is_prompt(claude_text(content))


def is_prompt(text):
    text = (text or '').lstrip()
    return bool(text) and not text.startswith(NON_HUMAN_PREFIXES) and not INJECTED_EVENT.match(text)


def claude_start(event, sid):
    message = event.get('message') or {}
    if event.get('type') == 'assistant' and not event.get('isSidechain'):
        for block in message.get('content') or []:
            if isinstance(block, dict) and block.get('type') == 'tool_use' and block.get('name') == 'Skill':
                data = block.get('input') or {}
                if sid.matches(data.get('skill')):
                    return 'model', data.get('args', '')
    if claude_is_human(event):
        text = claude_text(message.get('content'))
        for name in sid.names:
            # Plugin delivery namespaces the command, for example /<plugin>:<name>.
            if re.search(r'<command-name>/(?:[\w.-]+:)?' + re.escape(name) + '</command-name>', text):
                args = re.search(r'<command-args>(.*?)</command-args>', text, re.S)
                return 'user', args.group(1) if args else ''
    return None


def add_usage(tokens, usage):
    tokens['input'] += usage.get('input_tokens') or 0
    tokens['cache_read'] += usage.get('cache_read_input_tokens') or 0
    tokens['cache_write'] += usage.get('cache_creation_input_tokens') or 0
    tokens['output'] += usage.get('output_tokens') or 0
    tokens['reasoning'] += (usage.get('output_tokens_details') or {}).get('thinking_tokens') or 0


def unique_usage(events, usage_by_id):
    """Claude writes one line per content block, each repeating the message usage; keep one per message id."""
    for event in events:
        message = event.get('message') or {}
        if event.get('type') == 'assistant' and message.get('usage'):
            usage_by_id[message.get('id') or id(event)] = (message.get('model'), message['usage'])
    return usage_by_id


def add_subagent(record, usage_by_id):
    for model, usage in usage_by_id.values():
        record['subagent']['models'][model or 'unknown'] += 1
        add_usage(record['subagent']['tokens'], usage)


def load_subagents(path):
    """Load each subagent transcript once per session as (first timestamp, usage by message id)."""
    folder = path.with_suffix('') / 'subagents'
    loaded = []
    for sub in sorted(folder.glob('*.jsonl')) if folder.is_dir() else []:
        events = load_jsonl(sub)
        stamps = [t for t in (parse_ts(e.get('timestamp')) for e in events) if t]
        if stamps:
            loaded.append((stamps[0], unique_usage(events, {})))
    return loaded


def claude_subagents(subagents, first, last, record):
    for began, usage_by_id in subagents:
        if first and first <= began <= (last or began):
            record['subagent']['runs'] += 1
            add_subagent(record, usage_by_id)


def claude_invocations(path, sid):
    events = load_jsonl(path)
    session = next((e.get('sessionId') for e in events if e.get('sessionId')), path.stem)
    entrypoint = next((e.get('entrypoint') for e in events if e.get('entrypoint')), None)
    starts = [(i, hit) for i, e in enumerate(events) if (hit := claude_start(e, sid))]
    subagents = load_subagents(path) if starts else []
    for n, (start, (trigger, args)) in enumerate(starts):
        limit = starts[n + 1][0] if n + 1 < len(starts) else len(events)
        record = new_record('claude-code', session, trigger, args, sid.modes, entrypoint)
        usage_by_id, side_by_id, pending, seen, stamps = {}, {}, {}, set(), []
        for event in events[start:limit]:
            if event is not events[start] and claude_is_human(event):
                if claude_text((event.get('message') or {}).get('content')).lstrip().startswith(INTERRUPT_PREFIX):
                    record['interruptions'] += 1
                    continue
                break
            ts = parse_ts(event.get('timestamp'))
            stamps.append(ts)
            message = event.get('message') or {}
            if event.get('isSidechain'):
                unique_usage([event], side_by_id)
                continue
            if event.get('type') == 'assistant':
                if message.get('usage'):
                    usage_by_id[message.get('id') or id(event)] = (message.get('model'), message['usage'])
                record['effort'] = event.get('effort') or record['effort']
                for block in message.get('content') or []:
                    if not isinstance(block, dict) or block.get('type') != 'tool_use':
                        continue
                    name, data = block.get('name', '?'), block.get('input') or {}
                    record_tool(record, sid, name, data, seen)
                    pending[block.get('id')] = (name, ts)
                    if name == 'Skill' and not sid.matches(data.get('skill')):
                        record['skills_chained'][str(data.get('skill'))] += 1
                    if name in DELEGATION_TOOLS:
                        record['delegations'][f"{data.get('subagent_type') or 'default'}@{data.get('model') or 'inherit'}"] += 1
            elif event.get('type') == 'user' and isinstance(message.get('content'), list):
                for block in message['content']:
                    if isinstance(block, dict) and block.get('type') == 'tool_result' and block.get('tool_use_id') in pending:
                        name, began = pending.pop(block['tool_use_id'])
                        latency = seconds(began, ts)
                        if latency is not None:
                            record['tool_latency_s'][name] += latency
                        if block.get('is_error'):
                            record['tool_errors'] += 1
                            record['errors_by_tool'][name] += 1
        for model, usage in usage_by_id.values():
            record['turns'] += 1
            record['models'][model or 'unknown'] += 1
            add_usage(record['tokens'], usage)
        add_subagent(record, side_by_id)
        stamps = [t for t in stamps if t]
        first, last = (stamps[0], stamps[-1]) if stamps else (None, None)
        claude_subagents(subagents, first, last, record)
        yield finish(record, first, last)


# ---------------------------------------------------------------------- Codex

def codex_user_text(payload):
    if payload.get('type') != 'message' or payload.get('role') != 'user':
        return None
    return '\n'.join(b.get('text', '') for b in payload.get('content') or [] if isinstance(b, dict)).strip()


def codex_failed(output):
    blocks = [b.get('text', '') for b in output if isinstance(b, dict)] if isinstance(output, list) else [str(output or '')]
    return any(EXIT_CODE.search(b) or b.lstrip().startswith('Script failed') for b in blocks)


def codex_model_item(payload):
    kind = payload.get('type')
    return kind in ('function_call', 'custom_tool_call', 'reasoning') or (kind == 'message' and payload.get('role') == 'assistant')


def codex_totals(info):
    usage = (info or {}).get('total_token_usage') or {}
    return {
        'input': (usage.get('input_tokens') or 0) - (usage.get('cached_input_tokens') or 0),
        'cache_read': usage.get('cached_input_tokens') or 0,
        'cache_write': usage.get('cache_write_input_tokens') or 0,
        'output': usage.get('output_tokens') or 0,
        'reasoning': usage.get('reasoning_output_tokens') or 0,
    }


def codex_invocations(path, sid):
    events = load_jsonl(path)
    meta = next(((e.get('payload') or {}) for e in events if e.get('type') == 'session_meta'), {})
    session, entrypoint = meta.get('id') or path.stem[-36:],meta.get('originator') or meta.get('source')
    record, seen, pending, stamps, baseline, latest = None, set(), {}, [], None, None
    model = effort = None
    in_response = False

    def close():
        stamps_ok = [t for t in stamps if t]
        if baseline is not None and latest is not None:
            record['tokens'] = {k: max(latest[k] - baseline[k], 0) for k in TOKEN_FIELDS}
        return finish(record, stamps_ok[0] if stamps_ok else None, stamps_ok[-1] if stamps_ok else None)

    for event in events:
        kind, payload = event.get('type'), event.get('payload') or {}
        ts = parse_ts(event.get('timestamp'))
        if kind == 'turn_context':
            model, effort = payload.get('model') or model, payload.get('effort') or effort
            continue
        if kind == 'event_msg' and payload.get('type') == 'token_count' and payload.get('info'):
            latest = codex_totals(payload['info'])
            if record is None:
                baseline = latest
            continue
        if kind == 'event_msg' and payload.get('type') == 'turn_aborted' and record is not None:
            record['interruptions'] += 1
            continue
        if kind != 'response_item':
            continue
        # One model response is a run of consecutive reasoning, message and tool-call items.
        starts_response = codex_model_item(payload) and not in_response
        in_response = codex_model_item(payload)
        if starts_response and record is not None:
            record['turns'] += 1
            record['models'][model or 'unknown'] += 1
            record['effort'] = effort
        text = codex_user_text(payload)
        if text is not None and is_prompt(text) and not text.startswith('<'):
            if record is not None:
                yield close()
                record, baseline = None, latest
            hit = sid.mention.search(text)
            if hit:
                args = text[hit.end():]
                record, seen, pending, stamps = new_record('codex', session, 'user', args, sid.modes, entrypoint), set(), {}, [ts]
                baseline = latest if latest is not None else dict.fromkeys(TOKEN_FIELDS, 0)
            continue
        call_type = payload.get('type')
        if call_type in ('function_call', 'custom_tool_call'):
            name = payload.get('name', '?')
            data = payload.get('arguments') if call_type == 'function_call' else payload.get('input')
            if record is None and 'SKILL.md' in sid.files_in(data):
                record, seen, pending, stamps = new_record('codex', session, 'model', '', sid.modes, entrypoint), set(), {}, []
                baseline = latest if latest is not None else dict.fromkeys(TOKEN_FIELDS, 0)
                record['turns'], record['effort'] = 1, effort
                record['models'][model or 'unknown'] += 1
            if record is None:
                continue
            stamps.append(ts)
            record_tool(record, sid, name, data, seen)
            pending[payload.get('call_id')] = (name, ts)
            if 'spawn' in name or name in DELEGATION_TOOLS:
                try:
                    spec = json.loads(data) if isinstance(data, str) else (data or {})
                except json.JSONDecodeError:
                    spec = {}
                record['delegations'][f"{spec.get('agent_type') or spec.get('subagent_type') or 'default'}@{spec.get('model') or 'inherit'}"] += 1
        elif record is not None and call_type in ('function_call_output', 'custom_tool_call_output'):
            stamps.append(ts)
            name, began = pending.pop(payload.get('call_id'), ('?', None))
            latency = seconds(began, ts)
            if latency is not None:
                record['tool_latency_s'][name] += latency
            if codex_failed(payload.get('output')):
                record['tool_errors'] += 1
                record['errors_by_tool'][name] += 1
    if record is not None:
        yield close()


# ------------------------------------------------------------------ discovery

def default_roots():
    claude = Path(os.environ.get('CLAUDE_CONFIG_DIR') or Path.home() / '.claude') / 'projects'
    codex_home = Path(os.environ.get('CODEX_HOME') or Path.home() / '.codex')
    return {'claude-code': [claude], 'codex': [codex_home / 'sessions', codex_home / 'archived_sessions']}


def transcripts(roots, since):
    for runtime, folders in roots.items():
        seen = set()  # Codex keeps an archived copy of a rollout under the same file name.
        for folder in folders:
            if not folder.is_dir():
                continue
            for path in sorted(folder.rglob('*.jsonl')):
                if path.parent.name == 'subagents' or path.name in seen:
                    continue
                seen.add(path.name)
                try:
                    if since and datetime.fromtimestamp(path.stat().st_mtime).date() < since:
                        continue
                except OSError:  # rotated or archived while scanning
                    continue
                yield runtime, path


def display_path(path):
    """Show roots relative to the home directory so reports do not carry the account path."""
    try:
        return '~/' + Path(path).resolve().relative_to(Path.home().resolve()).as_posix()
    except ValueError:
        return '.../' + '/'.join(Path(path).parts[-2:])


def contains_any(path, needles):
    try:
        data = path.read_bytes()
    except OSError:
        return False
    return any(n in data for n in needles)


# ----------------------------------------------------------------- aggregate

def dist(values):
    values = sorted(v for v in values if v is not None)
    if not values:
        return None
    p90 = values[min(len(values) - 1, int(round(0.9 * (len(values) - 1))))]
    return {'n': len(values), 'median': round(statistics.median(values), 3), 'p90': p90,
            'mean': round(statistics.fmean(values), 3), 'total': round(sum(values), 3)}


def skill_files_on_disk(sid):
    if not sid.dir:
        return []
    return sorted(p.relative_to(sid.dir).as_posix() for sub in ('references', 'scripts')
                  for p in (sid.dir / sub).rglob('*') if p.is_file() and 'tests' not in p.relative_to(sid.dir).parts and p.suffix in ('.md', '.py'))


def signals(records, summary, sid):
    found, n = [], len(records)
    total_calls = sum(r['tool_calls'] for r in records)
    for tool, errors in summary['errors_by_tool'].items():
        calls = summary['tools'].get(tool, 0)
        if errors >= 2 and calls and errors / calls >= 0.15:
            found.append({'id': 'tool-error-rate', 'goal': 'determinism', 'evidence': f'{tool}: {errors}/{calls} calls failed',
                          'lead': 'Check whether the skill documents a wrong command, path, flag or precondition for this tool.'})
    dup = sum(r['duplicate_calls'] for r in records)
    if total_calls and dup / total_calls >= 0.1:
        found.append({'id': 'repeated-identical-calls', 'goal': 'tokens', 'evidence': f'{dup}/{total_calls} calls repeated an identical earlier call',
                      'lead': 'Script or cache the repeated lookup, or state where its result is reused.'})
    latency = {k: v for k, v in summary['tool_latency_s'].items() if k not in WAIT_TOOLS}
    spent = sum(latency.values())
    if spent >= 60:
        tool, slow = max(latency.items(), key=lambda kv: kv[1])
        if slow / spent >= 0.4:
            found.append({'id': 'slow-tool', 'goal': 'speed', 'evidence': f'{tool}: {round(slow)}s of {round(spent)}s tool wait',
                          'lead': 'Parallelize, background, narrow or batch the slow step.'})
    if n >= 3:
        for rel, hits in summary['skill_files'].items():
            if rel.startswith('references/') and hits / n >= 0.8:
                found.append({'id': 'reference-always-loaded', 'goal': 'tokens', 'evidence': f'{rel} read in {hits}/{n} invocations',
                              'lead': 'Decide whether its needed part belongs in SKILL.md or whether routing loads it unconditionally.'})
    unread = [rel for rel in summary.get('unused_skill_files') or [] if rel.startswith('references/')]
    if n >= 5 and unread:
        found.append({'id': 'reference-never-loaded', 'goal': 'tokens', 'evidence': f'{len(unread)} references unread in {n} invocations: {", ".join(unread)}',
                      'lead': 'Rare branches are expected; confirm each route is reachable, then merge or retire content no workflow needs.'})
    heavy = [r for r in records if r['tool_calls'] >= 15 and (r['mechanical_share'] or 0) >= 0.6
             and r['subagent']['tokens']['output'] < 0.1 * max(r['tokens']['output'], 1)]
    if n and len(heavy) / n >= 0.5:
        found.append({'id': 'delegation-candidate', 'goal': 'cost', 'evidence': f'{len(heavy)}/{n} invocations ran 15+ mostly mechanical calls on the main model',
                      'lead': 'Delegate bounded mechanical execution to a lower-cost subagent tier with a scoped prompt; keep judgment and final review on the main model and compare output quality.'})
    interrupted = sum(1 for r in records if r['interruptions'])
    if n >= 4 and interrupted / n >= 0.25:
        found.append({'id': 'user-interruptions', 'goal': 'quality', 'evidence': f'{interrupted}/{n} invocations were interrupted by the user',
                      'lead': 'Inspect those sessions for a wrong default, missing question or unwanted direction.'})
    duration = summary['metrics'].get('duration_s')
    if duration and duration['n'] >= 5 and duration['median'] and duration['p90'] >= 3 * duration['median']:
        found.append({'id': 'duration-variance', 'goal': 'determinism', 'evidence': f"p90 {duration['p90']}s vs median {duration['median']}s",
                      'lead': 'Compare the slowest invocations with typical ones to find the unstable branch.'})
    return found


def aggregate(records, sid):
    counters = defaultdict(Counter)
    for r in records:
        for key in ('models', 'tools', 'errors_by_tool', 'tool_latency_s', 'skills_chained', 'delegations'):
            counters[key].update(r[key])
        counters['skill_files'].update(r['skill_files'].keys())
        counters['subagent_models'].update(r['subagent']['models'])
        counters['by_runtime'][r['runtime']] += 1
        counters['by_trigger'][r['trigger']] += 1
        counters['by_entrypoint'][r['entrypoint'] or 'unknown'] += 1
        counters['by_subcommand'][r['subcommand'] or '(none)'] += 1
    metrics = {
        'duration_s': dist(r['duration_s'] for r in records),
        'turns': dist(r['turns'] for r in records),
        'tool_calls': dist(r['tool_calls'] for r in records),
        'tool_errors': dist(r['tool_errors'] for r in records),
        'duplicate_calls': dist(r['duplicate_calls'] for r in records),
    }
    for field in TOKEN_FIELDS:
        metrics[f'tokens_{field}'] = dist(r['tokens'][field] for r in records)
        metrics[f'subagent_tokens_{field}'] = dist(r['subagent']['tokens'][field] for r in records)
    summary = {
        'invocations': len(records), 'sessions': len({(r['runtime'], r['session']) for r in records}),
        'by_runtime': dict(counters['by_runtime']), 'by_trigger': dict(counters['by_trigger']),
        'by_entrypoint': dict(counters['by_entrypoint']),
        'by_subcommand': dict(counters['by_subcommand']), 'metrics': metrics,
        'models': dict(counters['models'].most_common()), 'subagent_models': dict(counters['subagent_models'].most_common()),
        'tools': dict(counters['tools'].most_common()), 'errors_by_tool': dict(counters['errors_by_tool'].most_common()),
        'tool_latency_s': {k: round(v, 1) for k, v in counters['tool_latency_s'].most_common()},
        'skill_files': dict(counters['skill_files'].most_common()), 'skills_chained': dict(counters['skills_chained'].most_common()),
        'delegations': dict(counters['delegations'].most_common()),
    }
    on_disk = skill_files_on_disk(sid)
    if on_disk:
        summary['unused_skill_files'] = [f for f in on_disk if f not in counters['skill_files']]
    summary['signals'] = signals(records, summary, sid)
    return summary


# ----------------------------------------------------------- session inventory

# Any file under a skills/<name>/ folder: SKILL.md or a resource below it.
SKILL_FILE = re.compile(r'[/\\]skills[/\\]+([\w.:-]+)[/\\]+((?:references|scripts|assets)(?:[/\\]+[\w.\-]+)+|SKILL\.md)')
BASE_DIR = re.compile(r'Base directory for this skill:\s*\S*?[/\\]skills[/\\]+([\w.:-]+)')
SLASH = re.compile(r'<command-name>/([\w.:-]+)</command-name>')


def skill_key(name):
    """Canonical key for a skill name as a runtime spells it: /ak:bro, $ak-bro, plugin:ak-bro."""
    name = str(name or '').strip().lstrip('/$')
    if ':' in name:
        ns, slug = name.rsplit(':', 1)
        return 'ak-' + slug if ns.rsplit(':', 1)[-1] == 'ak' else slug
    return name


def project_transcripts(roots, cwd):
    """Transcripts of the project at cwd or its nearest ancestor that has any: the Claude folder named
    after it, and Codex rollouts recorded there."""
    for base in (cwd, *cwd.parents):
        found = list(project_transcripts_at(roots, base))
        if found:
            return found
    return []


def project_transcripts_at(roots, cwd):
    folder_name = re.sub(r'[^A-Za-z0-9]', '-', str(cwd))
    for folder in roots.get('claude-code', []):
        project = folder / folder_name
        if project.is_dir():
            for path in project.glob('*.jsonl'):
                yield 'claude-code', path
    wanted = os.path.normcase(str(cwd))
    for runtime, path in transcripts({'codex': roots.get('codex', [])}, None):
        with open(path, encoding='utf-8', errors='replace') as handle:
            try:
                meta = json.loads(handle.readline()).get('payload') or {}
            except json.JSONDecodeError:
                continue
        if os.path.normcase(str(meta.get('cwd') or '')) == wanted:
            yield runtime, path


def find_session(roots, session, cwd):
    """Resolve a transcript from a path, an id prefix, or latest (newest of the current project)."""
    given = Path(session).expanduser()  # --all prints lead transcripts as ~/...
    if given.is_file():
        return ('codex' if 'rollout-' in given.name else 'claude-code'), given
    pool = project_transcripts(roots, cwd) if session == 'latest' else (
        (runtime, path) for runtime, path in transcripts(roots, None)
        if path.stem.startswith(session) or path.stem.endswith(session) or session in path.stem.split('-', 1)[-1])
    found = []
    for runtime, path in pool:
        try:
            found.append((path.stat().st_mtime, runtime, path))
        except OSError:
            continue
    if not found:
        return None
    _, runtime, path = max(found, key=lambda item: item[0])
    return runtime, path


def new_skill_entry():
    return {'triggers': Counter(), 'files': Counter(), 'first_event': None}


def note_skill(skills, key, index, trigger=None, rel=None):
    entry = skills[key]
    entry['first_event'] = index if entry['first_event'] is None else entry['first_event']
    if trigger:
        entry['triggers'][trigger] += 1
    if rel:
        entry['files'][clean_rel(rel)] += 1


def note_files(skills, payload, index):
    for text in strings(payload):
        for name, rel in SKILL_FILE.findall(text):
            note_skill(skills, skill_key(name), index, rel=rel)


def inventory_claude(path):
    events = load_jsonl(path)
    skills, tools, errors, pending, seen = defaultdict(new_skill_entry), Counter(), Counter(), {}, set()
    duplicates, totals = Counter(), {'turns': 0, 'human_prompts': 0, 'interruptions': 0, 'compactions': 0}
    usage_by_id, stamps = {}, []
    for index, event in enumerate(events):
        if event.get('isSidechain'):
            continue
        stamps.append(parse_ts(event.get('timestamp')))
        message = event.get('message') or {}
        if event.get('isCompactSummary'):
            totals['compactions'] += 1
        if event.get('type') == 'user':
            text = claude_text(message.get('content'))
            for name in SLASH.findall(text):
                note_skill(skills, skill_key(name), index, trigger='user')
            for name in BASE_DIR.findall(text):
                note_skill(skills, skill_key(name), index, rel='SKILL.md')
            if claude_is_human(event):
                if text.lstrip().startswith(INTERRUPT_PREFIX):
                    totals['interruptions'] += 1
                else:
                    totals['human_prompts'] += 1
            for block in message.get('content') if isinstance(message.get('content'), list) else []:
                if isinstance(block, dict) and block.get('type') == 'tool_result' and block.get('tool_use_id') in pending:
                    name = pending.pop(block['tool_use_id'])
                    if block.get('is_error'):
                        errors[name] += 1
        elif event.get('type') == 'assistant':
            if message.get('usage'):
                usage_by_id[message.get('id') or id(event)] = message['usage']
            for block in message.get('content') or []:
                if not isinstance(block, dict) or block.get('type') != 'tool_use':
                    continue
                name, data = block.get('name', '?'), block.get('input') or {}
                tools[name] += 1
                pending[block.get('id')] = name
                key = (name, json.dumps(data, sort_keys=True))
                if key in seen:
                    duplicates[name] += 1
                seen.add(key)
                if name == 'Skill':
                    note_skill(skills, skill_key(data.get('skill')), index, trigger='model')
                note_files(skills, data, index)
    # A slash skill loads with its base directory; a slash that touches no file of a skills/ folder is a built-in or plain command.
    for key in [k for k, e in skills.items() if set(e['triggers']) == {'user'} and not e['files']]:
        del skills[key]
    totals['turns'] = len(usage_by_id)
    tokens = dict.fromkeys(TOKEN_FIELDS, 0)
    for usage in usage_by_id.values():
        add_usage(tokens, usage)
    session = next((e.get('sessionId') for e in events if e.get('sessionId')), path.stem)
    return session, skills, tools, errors, duplicates, totals, tokens, [t for t in stamps if t]


def inventory_codex(path):
    events = load_jsonl(path)
    skills, tools, errors, pending, seen = defaultdict(new_skill_entry), Counter(), Counter(), {}, set()
    duplicates, totals = Counter(), {'turns': 0, 'human_prompts': 0, 'interruptions': 0, 'compactions': 0}
    tokens, stamps, in_response = dict.fromkeys(TOKEN_FIELDS, 0), [], False
    meta = next(((e.get('payload') or {}) for e in events if e.get('type') == 'session_meta'), {})
    mention = re.compile(r'(?:^|\s)\$([\w.:-]+)')
    for index, event in enumerate(events):
        kind, payload = event.get('type'), event.get('payload') or {}
        stamps.append(parse_ts(event.get('timestamp')))
        if kind == 'event_msg' and payload.get('type') == 'token_count' and payload.get('info'):
            tokens = codex_totals(payload['info'])
        elif kind == 'event_msg' and payload.get('type') == 'turn_aborted':
            totals['interruptions'] += 1
        elif kind == 'compacted':
            totals['compactions'] += 1
        if kind != 'response_item':
            continue
        starts_response = codex_model_item(payload) and not in_response
        in_response = codex_model_item(payload)
        totals['turns'] += starts_response
        text = codex_user_text(payload)
        if text is not None and is_prompt(text) and not text.startswith('<'):
            totals['human_prompts'] += 1
            for name in mention.findall(text):
                note_skill(skills, skill_key(name), index, trigger='user')
            continue
        call_type = payload.get('type')
        if call_type in ('function_call', 'custom_tool_call'):
            name = payload.get('name', '?')
            data = payload.get('arguments') if call_type == 'function_call' else payload.get('input')
            tools[name] += 1
            pending[payload.get('call_id')] = name
            key = (name, data if isinstance(data, str) else json.dumps(data, sort_keys=True))
            if key in seen:
                duplicates[name] += 1
            seen.add(key)
            note_files(skills, data, index)
        elif call_type in ('function_call_output', 'custom_tool_call_output'):
            name = pending.pop(payload.get('call_id'), '?')
            if codex_failed(payload.get('output')):
                errors[name] += 1
    # A Codex skill load is a model read of its SKILL.md.
    for entry in skills.values():
        if entry['files'].get('SKILL.md') and not entry['triggers']:
            entry['triggers']['model'] += 1
    session = meta.get('id') or path.stem[-36:]
    return session, skills, tools, errors, duplicates, totals, tokens, [t for t in stamps if t]


def session_inventory(runtime, path):
    parse = inventory_claude if runtime == 'claude-code' else inventory_codex
    session, skills, tools, errors, duplicates, totals, tokens, stamps = parse(path)
    ordered = sorted(skills.items(), key=lambda kv: kv[1]['first_event'])
    return {
        'runtime': runtime, 'session': session[:8], 'transcript': display_path(path),
        'duration_s': seconds(stamps[0], stamps[-1]) if stamps else None, **totals, 'tokens': tokens,
        'tool_calls': sum(tools.values()), 'tool_errors': sum(errors.values()),
        'duplicate_calls': sum(duplicates.values()),
        'tools': dict(tools.most_common()), 'errors_by_tool': dict(errors.most_common()),
        'duplicates_by_tool': dict(duplicates.most_common()),
        'skills': [{'skill': key, 'invoked': bool(entry['triggers']), 'triggers': dict(entry['triggers']),
                    'files': dict(entry['files'].most_common()), 'first_event': entry['first_event']}
                   for key, entry in ordered if key],
        'limitations': [
            'Skills are detected from slash commands, skill tool calls, $mentions and file paths under a skills/ folder; '
            'a skill loaded another way is missed.',
            'invoked is false when a skill only appears in file paths, such as one being read or edited as source.',
            'first_event is the transcript line index; files counts mentions in tool arguments, not confirmed reads.',
            'An open session is measured up to its last written line.',
        ],
    }


# ------------------------------------------------------------ machine inventory

# Bytes that any Claude Code skill use leaves in a transcript; files without one are skipped unparsed.
CLAUDE_SKILL_MARKERS = (b'<command-name>/', b'"name":"Skill"', b'"name": "Skill"', b'skills/', b'skills\\\\')


def inventory_or_none(item):
    """Inventory one transcript for the machine-wide scan; None when it shows no skill or cannot be read."""
    runtime, path = item
    if runtime == 'claude-code' and not contains_any(path, CLAUDE_SKILL_MARKERS):
        return None
    try:
        inventory = session_inventory(runtime, path)
    except (OSError, ValueError):
        return None
    return inventory if any(s['invoked'] for s in inventory['skills']) else None


def lead_score(inventory):
    return inventory['tool_errors'] + inventory['duplicate_calls'] + 3 * inventory['interruptions']


def machine_inventory(roots, since, excluded, top, jobs):
    """Every invoked skill across all local transcripts, with session-level trouble counts and the
    sessions most worth reading first."""
    items = list(transcripts(roots, since))
    if jobs > 1 and len(items) > 1:
        from concurrent.futures import ProcessPoolExecutor
        with ProcessPoolExecutor(max_workers=jobs) as pool:
            inventories = list(pool.map(inventory_or_none, items, chunksize=8))
    else:
        inventories = [inventory_or_none(item) for item in items]
    skills = defaultdict(lambda: {'sessions': 0, 'triggers': Counter(), 'files': Counter(), 'runtimes': Counter(),
                                  'sessions_with_errors': 0, 'tool_errors': 0, 'errors_by_tool': Counter(),
                                  'duplicate_calls': 0, 'interrupted_sessions': 0, 'compacted_sessions': 0, 'leads': []})
    used = 0
    for inventory in inventories:
        if not inventory or any(inventory['session'].startswith(e) or e.startswith(inventory['session']) for e in excluded):
            continue
        used += 1
        lead = {'session': inventory['session'], 'runtime': inventory['runtime'], 'transcript': inventory['transcript'],
                'tool_errors': inventory['tool_errors'], 'duplicate_calls': inventory['duplicate_calls'],
                'interruptions': inventory['interruptions'], 'errors_by_tool': dict(Counter(inventory['errors_by_tool']).most_common(3)),
                'score': lead_score(inventory)}
        for skill in inventory['skills']:
            if not skill['invoked']:
                continue
            entry = skills[skill['skill']]
            entry['sessions'] += 1
            entry['triggers'].update(skill['triggers'])
            entry['files'].update(skill['files'].keys())
            entry['runtimes'][inventory['runtime']] += 1
            entry['sessions_with_errors'] += bool(inventory['tool_errors'])
            entry['tool_errors'] += inventory['tool_errors']
            entry['errors_by_tool'].update(inventory['errors_by_tool'])
            entry['duplicate_calls'] += inventory['duplicate_calls']
            entry['interrupted_sessions'] += bool(inventory['interruptions'])
            entry['compacted_sessions'] += bool(inventory['compactions'])
            if lead['score']:
                entry['leads'].append(lead)
    ranked = []
    for name, entry in skills.items():
        entry['leads'] = sorted(entry['leads'], key=lambda lead: -lead['score'])[:top]
        for key in ('triggers', 'files', 'runtimes'):
            entry[key] = dict(entry[key].most_common())
        entry['errors_by_tool'] = dict(entry['errors_by_tool'].most_common(5))
        ranked.append({'skill': name, **entry})
    ranked.sort(key=lambda s: (-s['sessions'], s['skill']))
    return {
        'scope': 'all', 'roots': {k: [display_path(p) for p in v] for k, v in roots.items()},
        'transcripts_scanned': len(items), 'sessions_with_skills': used, 'skills': ranked,
        'limitations': [
            'Errors, duplicates, interruptions and compactions are counted per session, not per skill: a session that used '
            'several skills counts toward each; confirm the owner by reading the lead session.',
            'leads are the sessions with the highest score (tool errors + duplicate calls + 3 x interruptions), at most --top per skill.',
            'Claude Code transcripts without a skill marker are skipped unparsed; detection limits of --session apply.',
        ],
    }


def main(argv=None):
    configure_utf8_console()
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('skill', nargs='?', help='skill name (ak:skill-creator, ak-skill-creator) or skill directory')
    parser.add_argument('--session', metavar='ID|latest|PATH',
                        help='inventory one session instead: every skill it used, with files and tool error counts')
    parser.add_argument('--all', action='store_true',
                        help='inventory every local session instead: each used skill with session counts and lead sessions')
    parser.add_argument('--top', type=int, default=5, help='with --all: lead sessions kept per skill (default 5)')
    parser.add_argument('--jobs', type=int, default=min(8, os.cpu_count() or 1), help='with --all: parallel parse workers')
    parser.add_argument('--runtime', choices=('all', 'claude-code', 'codex'), default='all')
    parser.add_argument('--root', action='append', default=[], metavar='RUNTIME=DIR',
                        help='transcript root override, e.g. claude-code=/tmp/projects (repeatable)')
    parser.add_argument('--since', type=lambda v: datetime.strptime(v, '%Y-%m-%d').date(), help='skip transcripts last modified before YYYY-MM-DD')
    parser.add_argument('--exclude-session', action='append', default=[], metavar='ID', help='session id or prefix to skip, such as the current session')
    parser.add_argument('--entrypoint', action='append', default=[], metavar='NAME',
                        help='keep only these entrypoints/originators, e.g. cli or codex_exec (repeatable)')
    parser.add_argument('--summary-only', action='store_true', help='omit per-invocation records')
    args = parser.parse_args(argv)
    if sum(map(bool, (args.skill, args.session, args.all))) != 1:
        parser.error('give exactly one of a skill, --session or --all')

    roots = default_roots()
    if args.root:
        roots = defaultdict(list)
        for spec in args.root:
            runtime, _, folder = spec.partition('=')
            if runtime not in ('claude-code', 'codex') or not folder:
                parser.error(f'--root expects claude-code=DIR or codex=DIR, got {spec!r}')
            roots[runtime].append(Path(folder))
    if args.runtime != 'all':
        roots = {args.runtime: roots.get(args.runtime, [])}
    if args.session:
        found = find_session(roots, args.session, Path.cwd())
        if not found:
            print(f'no transcript matches --session {args.session}', file=sys.stderr)
            return 1
        json.dump(session_inventory(*found), sys.stdout, indent=2, default=str)
        sys.stdout.write('\n')
        return 0

    excluded = [e[:8] for e in args.exclude_session]
    if args.all:
        result = machine_inventory(roots, args.since, excluded, max(args.top, 0), max(args.jobs, 1))
        json.dump(result, sys.stdout, indent=2, default=str)
        sys.stdout.write('\n')
        return 0 if result['skills'] else 1

    sid = SkillId(args.skill)

    records, scanned, matched = [], 0, 0
    for runtime, path in transcripts(roots, args.since):
        scanned += 1
        if not contains_any(path, sid.needles):
            continue
        matched += 1
        parse = claude_invocations if runtime == 'claude-code' else codex_invocations
        try:
            for record in parse(path, sid):
                if args.entrypoint and record['entrypoint'] not in args.entrypoint:
                    continue
                if not any(record['session'].startswith(e) or e.startswith(record['session']) for e in excluded):
                    records.append(record)
        except (OSError, ValueError) as exc:
            print(f'warning: skipped {path.name}: {type(exc).__name__}', file=sys.stderr)
    records.sort(key=lambda r: r['started_at'] or '')
    result = {
        'skill': sorted(sid.names), 'roots': {k: [display_path(p) for p in v] for k, v in roots.items()},
        'transcripts_scanned': scanned, 'transcripts_matched': matched, 'summary': aggregate(records, sid),
        'limitations': [
            'Signals are heuristic leads; confirm each against the session and the skill text before proposing a change.',
            'Claude subagent usage is attributed by time window; Codex subagent sessions are separate rollouts and are not attributed.',
            'Codex tool errors are inferred from exit codes in tool output.',
            'A span runs from the trigger to the next human prompt, so it includes chained work (see skills_chained); a model-triggered Codex span may be a SKILL.md read for another purpose.',
        ],
    }
    if not args.summary_only:
        result['invocations'] = records
    json.dump(result, sys.stdout, indent=2, default=str)
    sys.stdout.write('\n')
    return 0 if records else 1


if __name__ == '__main__':
    sys.exit(main())
