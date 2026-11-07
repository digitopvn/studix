#!/usr/bin/env python3
# /// script
# dependencies = ["PyYAML==6.0.3"]
# ///
"""Run quick_validate over every skill under one or more roots and summarize.

The report is warning-first: it exits 0 unless --strict is given and a skill
has validation errors, so it can run on a whole kit tree without failing on
drift that predates the production skill standard.

Usage:
    python3 skill_standard_report.py <root> [<root> ...] [--json] [--details] [--strict]
"""

import argparse
import json
import sys
from collections import Counter
from pathlib import Path

from encoding_utils import configure_utf8_console
from frontmatter_validation import MissingDependencyError
from quick_validate import validate_skill_detailed

configure_utf8_console()

SKIP_PARTS = {'node_modules', '__pycache__', 'dist', 'build'}


def skill_dirs(roots):
    """Yield each directory that holds a SKILL.md, nested skills included."""
    seen = set()
    for raw in roots:
        root = Path(raw)
        candidates = [root / 'SKILL.md'] if (root / 'SKILL.md').is_file() else []
        candidates += sorted(root.rglob('SKILL.md'))
        for skill_md in candidates:
            relative = skill_md.relative_to(root).parts[:-1]
            if any(part in SKIP_PARTS or part.startswith('.') for part in relative):
                continue
            resolved = skill_md.parent.resolve()
            if resolved not in seen:
                seen.add(resolved)
                yield skill_md.parent


def build_report(roots):
    skills = []
    warnings_by_rule = Counter()
    for directory in skill_dirs(roots):
        result = validate_skill_detailed(directory)
        for item in result['warnings']:
            warnings_by_rule[item.get('rule', 'unlabelled')] += 1
        skills.append(result)
    return {
        'skills_scanned': len(skills),
        'skills_with_errors': sum(1 for item in skills if item['errors']),
        'skills_with_warnings': sum(1 for item in skills if item['warnings']),
        'errors': sum(len(item['errors']) for item in skills),
        'warnings_by_rule': dict(sorted(warnings_by_rule.items())),
        'skills': skills,
    }


def format_text(report, details):
    lines = []
    for item in report['skills']:
        if not item['errors'] and not (details and item['warnings']):
            continue
        lines.append(item['path'])
        for error in item['errors']:
            lines.append(f"  ERROR   {error['file']}:{error['line']}: {error['message']}")
        if details:
            for warning in item['warnings']:
                rule = warning.get('rule', 'unlabelled')
                lines.append(f"  WARNING {warning['file']}:{warning['line']}: [{rule}] {warning['message']}")
    lines.append(f"{report['skills_scanned']} skill(s) scanned; {report['skills_with_errors']} with errors, "
                 f"{report['skills_with_warnings']} with warnings")
    for rule, count in report['warnings_by_rule'].items():
        lines.append(f'  {rule}: {count}')
    return '\n'.join(lines)


def main(argv=None):
    parser = argparse.ArgumentParser(description='Summarize skill standard drift across skill roots.')
    parser.add_argument('roots', nargs='+', help='Directories to scan for SKILL.md files')
    parser.add_argument('--json', action='store_true', help='Emit the full JSON report')
    parser.add_argument('--details', action='store_true', help='List every warning, not only the summary')
    parser.add_argument('--strict', action='store_true', help='Exit 1 when any skill has validation errors')
    args = parser.parse_args(argv)
    missing = [root for root in args.roots if not Path(root).is_dir()]
    if missing:
        print(f"Not a directory: {', '.join(missing)}", file=sys.stderr)
        return 2
    try:
        report = build_report(args.roots)
    except MissingDependencyError as exc:
        print(str(exc), file=sys.stderr)
        return 3
    print(json.dumps(report, indent=2) if args.json else format_text(report, args.details))
    return 1 if args.strict and report['skills_with_errors'] else 0


if __name__ == '__main__':
    sys.exit(main())
