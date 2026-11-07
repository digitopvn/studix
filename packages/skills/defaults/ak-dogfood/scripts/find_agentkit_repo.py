#!/usr/bin/env python3
"""Locate the AgentKit source checkout on this machine.

Standard library only; runs on macOS, Linux and Windows with Python 3.8+.
Read-only: it lists directories and runs `git remote -v`, nothing else.

Order: $AGENTKIT_REPO, the parent of $AGENTKIT_KITS_DIR, the working
directory and its ancestors, then a depth-limited scan of common code roots
(plus every fixed drive root on Windows) and any --root given. A checkout
qualifies when it holds kits/core/kit.yaml; it is verified when one of its
remotes points at the canonical repository (a fork's `upstream` counts).

Prints JSON. Exit 0 when a checkout is found, 1 when none is.
"""

import argparse
import json
import os
import re
import string
import subprocess
import sys
from pathlib import Path

CANONICAL_SLUG = 'bestagentkits/agentkit'
MARKER = Path('kits') / 'core' / 'kit.yaml'
COMMON_ROOTS = ('code', 'src', 'projects', 'dev', 'work', 'www', 'repos', 'git', 'github',
                'workspace', 'Developer', 'Documents/GitHub', 'Sites')
SKIP_DIRS = {'node_modules', 'vendor', 'AppData', 'Library', 'Applications', 'Windows',
             'Program Files', 'Program Files (x86)', 'ProgramData', '$Recycle.Bin',
             'System Volume Information', 'Pictures', 'Music', 'Movies', 'Videos'}
REMOTE_RE = re.compile(r'^(\S+)\s+(\S+)\s+\(fetch\)$')


def is_checkout(path):
    return (path / MARKER).is_file()


def canonical_remote(url):
    tail = re.sub(r'\.git$', '', url.strip().rstrip('/'))
    tail = tail.replace(':', '/')
    return tail.lower().endswith('/' + CANONICAL_SLUG)


def remotes(path):
    try:
        out = subprocess.run(['git', '-C', str(path), 'remote', '-v'], capture_output=True,
                             text=True, timeout=10, check=False).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    found = {}
    for line in out.splitlines():
        match = REMOTE_RE.match(line.strip())
        if match:
            found[match.group(1)] = match.group(2)
    return found


def main_checkout(path):
    """Return the main checkout behind a linked worktree, else path itself."""
    if not (path / '.git').is_file():
        return path
    try:
        out = subprocess.run(['git', '-C', str(path), 'rev-parse', '--git-common-dir'],
                             capture_output=True, text=True, timeout=10, check=False).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return path
    common = (path / out).resolve() if out else None
    if common and common.name == '.git' and is_checkout(common.parent):
        return common.parent
    return path


def describe(path, source):
    path = main_checkout(path.resolve())
    remote_map = remotes(path)
    canonical = None
    if remote_map:
        for name in sorted(remote_map, key=lambda n: (n != 'upstream', n != 'origin', n)):
            if canonical_remote(remote_map[name]):
                canonical = name
                break
    return {
        'path': str(path),
        'source': source,
        'git_available': remote_map is not None,
        'remotes': sorted(remote_map) if remote_map else [],
        'canonical_remote': canonical,
        'verified': canonical is not None,
        # A linked worktree keeps a .git file; the main checkout keeps a directory.
        'linked_worktree': (path / '.git').is_file(),
    }


def scan(root, max_depth):
    """Yield checkouts below root, skipping hidden, heavy and system directories."""
    stack = [(root, 0)]
    while stack:
        current, depth = stack.pop()
        if is_checkout(current):
            yield current
            continue
        if depth >= max_depth:
            continue
        try:
            children = sorted(os.scandir(current), key=lambda e: e.name, reverse=True)
        except OSError:
            continue
        for entry in children:
            if entry.name.startswith(('.', '$')) or entry.name in SKIP_DIRS:
                continue
            try:
                if entry.is_dir(follow_symlinks=False):
                    stack.append((Path(entry.path), depth + 1))
            except OSError:
                continue


def scan_roots(extra):
    home = Path.home()
    roots = [Path(r).expanduser() for r in extra]
    roots += [home / r for r in COMMON_ROOTS]
    if os.name == 'nt':
        roots += [Path(f'{d}:\\') for d in string.ascii_uppercase if os.path.isdir(f'{d}:\\')]
    roots.append(home)
    seen, ordered = set(), []
    for root in roots:
        key = os.path.normcase(str(root))
        if key not in seen and root.is_dir():
            seen.add(key)
            ordered.append(root)
    return ordered


def candidates(args, env, cwd):
    for var, transform in (('AGENTKIT_REPO', lambda p: p), ('AGENTKIT_KITS_DIR', lambda p: p.parent)):
        value = env.get(var)
        if value:
            path = transform(Path(value).expanduser())
            if is_checkout(path):
                yield path, 'env:' + var
    for path in (cwd, *cwd.parents):
        if is_checkout(path):
            yield path, 'cwd'
            break
    if args.no_scan:
        return
    for root in scan_roots(args.root):
        for path in scan(root, args.max_depth):
            yield path, 'scan'


def locate(args, env=None, cwd=None):
    env = os.environ if env is None else env
    cwd = Path.cwd() if cwd is None else cwd
    found, seen = [], set()
    for path, source in candidates(args, env, cwd):
        info = describe(path, source)
        key = os.path.normcase(info['path'])
        if key in seen:
            continue
        seen.add(key)
        found.append(info)
        # A verified explicit or enclosing checkout, or a verified main checkout, ends the search.
        if info['verified'] and (source != 'scan' or not info['linked_worktree']):
            break
        if len(found) >= args.limit:
            break
    ranked = sorted(found, key=lambda c: (not c['verified'], c['linked_worktree']))
    return {'found': bool(ranked), 'repo': ranked[0] if ranked else None, 'candidates': ranked}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--root', action='append', default=[], metavar='DIR',
                        help='extra directory to scan first (repeatable)')
    parser.add_argument('--max-depth', type=int, default=4, help='scan depth below each root (default 4)')
    parser.add_argument('--limit', type=int, default=5, help='stop after this many checkouts (default 5)')
    parser.add_argument('--no-scan', action='store_true', help='check only the environment and working directory')
    args = parser.parse_args(argv)
    result = locate(args)
    json.dump(result, sys.stdout, indent=2)
    sys.stdout.write('\n')
    return 0 if result['found'] else 1


if __name__ == '__main__':
    sys.exit(main())
