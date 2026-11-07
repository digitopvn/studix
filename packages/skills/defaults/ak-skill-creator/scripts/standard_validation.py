"""Warning-only checks for the production skill standard.

Each check reports structural drift that a reviewer can confirm mechanically;
none of them judges prose quality, and none fails validation. The standard and
the reasoning behind each rule live in references/production-skill-standard.md.
"""

import functools
import re
from pathlib import Path

from encoding_utils import read_text_utf8

# Claude Code truncates the combined description and when_to_use text at this
# many characters in its skill listing. The 1024-character description cap is a
# separate, hard limit enforced by quick_validate.
MAX_LISTING_DESCRIPTOR = 1536

EXEMPT_MARKER = re.compile(r'<!--\s*skill-standard-exempt:\s*(\S[^>]*?)\s*-->')
REFERENCE_ALLOW_MARKER = 'skill-reference-allow'
SKIP_PARTS = {'node_modules', '__pycache__', '.venv', 'venv', 'dist', 'build'}

TRIGGER_WORDING = re.compile(
    r'\b(?:use|invoke|activate|run|load)(?: it| this(?: skill)?)? (?:when|for|to|if|after|before|on|while|whenever)\b'
    r'|\bwhen(?:ever)?\b|\btrigger', re.IGNORECASE)
BOUNDARY_SIGNAL = re.compile(
    r'\bnot for\b|\bhand(?:s)? ?off\b|\bhand it off\b|\broute[sd]? (?:to|it|work)\b|\bout of scope\b'
    r'|\bwhen to use\b|\bbelongs to\b|\binstead\b|\bdoes not (?:cover|own|handle)\b|\bonly (?:when|for)\b'
    r'|\badjacent\b|\boutside (?:this|the) (?:skill|scope)\b',
    re.IGNORECASE)
COMPLETION_SIGNAL = re.compile(
    r'\bverif\w*|\bvalidat\w*|\bdone\b|\bcomplet\w*|\bevidence\b|\bacceptance\b|\bsuccess criteria\b'
    r'|\bchecklist\b|\bconfirm\w*|\btests?\b|\bpass(?:es|ing)?\b', re.IGNORECASE)
HEADING = re.compile(r'^#{1,4}\s+\S', re.MULTILINE)
PLATFORM_NOTE = re.compile(
    r'\b(?:windows|macos|linux|posix|cross-platform|powershell|wsl)\b', re.IGNORECASE)
# Matches /ak-<slug> and $ak-<slug> invocations and the legacy ak:<slug> alias. A bare
# ak-<slug> is not checked: runtimes, MCP servers and plugins share that spelling.
SKILL_TOKEN = re.compile(r'(?<![\w:./<-])(?:[/$]ak-|[/$]?ak:)([a-z0-9]+(?:-[a-z0-9]+)*)\b(?![\w-])')
SCRIPT_SUFFIXES = {'.py', '.js', '.cjs', '.mjs', '.ts', '.sh', '.ps1', '.rb', '.go'}
TEST_NAME = re.compile(r'(?:^test_|_test\.|\.test\.|\.spec\.|^conftest\.py$)')


def _kits_root(skill_path):
    """Return the kits/ directory above a kits/<kit>/skills/... skill, else None."""
    parts = skill_path.resolve().parts
    for index in range(len(parts) - 3, -1, -1):
        if parts[index] == 'kits' and parts[index + 2] == 'skills':
            return Path(*parts[:index + 1])
    return None


@functools.lru_cache(maxsize=8)
def known_kit_skills(kits_root):
    """Slugs of every SKILL.md directory under kits/*/skills, nested ones included."""
    slugs = set()
    root = Path(kits_root)
    for skill_md in root.glob('*/skills/**/SKILL.md'):
        # Judge only the path inside kits/, so a dot-named checkout folder is not skipped.
        if any(part in SKIP_PARTS or part.startswith('.') for part in skill_md.relative_to(root).parts[:-1]):
            continue
        name = skill_md.parent.name
        slugs.add(name[3:] if name.startswith('ak-') else name)
    return frozenset(slugs)


def _script_files(skill_path):
    scripts = skill_path / 'scripts'
    if not scripts.is_dir():
        return [], []
    code, tests = [], []
    for path in sorted(skill_path.rglob('*')):
        relative = path.relative_to(skill_path).parts
        if not path.is_file() or any(part in SKIP_PARTS or part.startswith('.') for part in relative):
            continue
        is_test = TEST_NAME.search(path.name) or any(part in ('tests', 'test', '__tests__') for part in relative[:-1])
        if is_test:
            tests.append(path)
        elif relative[0] == 'scripts' and path.suffix.lower() in SCRIPT_SUFFIXES:
            code.append(path)
    return code, tests


def check_standard(skill_path, data, body, markdown_files, warn):
    """Report warning-level drift from the production skill standard.

    ``data`` is the parsed frontmatter, ``body`` the SKILL.md text after it and
    ``markdown_files`` the (path, flag) pairs quick_validate already lints.
    """
    skill_path = Path(skill_path)
    description = data.get('description') or ''
    when_to_use = data.get('when_to_use') if isinstance(data.get('when_to_use'), str) else ''
    metadata_text = f'{description}\n{when_to_use}'

    if not TRIGGER_WORDING.search(metadata_text):
        warn('SKILL.md', 1, "Description and when_to_use state no activation condition (for example 'Use when ...')",
             rule='description-trigger')
    descriptor = len(description) + len(when_to_use)
    if descriptor > MAX_LISTING_DESCRIPTOR:
        warn('SKILL.md', 1, f'Description plus when_to_use is {descriptor} characters; runtime listings truncate '
             f'past {MAX_LISTING_DESCRIPTOR}, so front-load the owned task', rule='descriptor-length')

    exemption = EXEMPT_MARKER.search(body)
    if not exemption:
        missing = []
        if not BOUNDARY_SIGNAL.search(metadata_text + '\n' + body):
            missing.append('activation boundary or hand-off')
        if not HEADING.search(body):
            missing.append('section headings')
        if not COMPLETION_SIGNAL.search(body):
            missing.append('completion or verification evidence')
        if missing:
            warn('SKILL.md', 1, 'Standard sections missing: ' + ', '.join(missing) +
                 "; add them or mark a tiny router/validator with '<!-- skill-standard-exempt: reason -->'",
                 rule='standard-sections')

    kits_root = _kits_root(skill_path)
    if kits_root is not None:
        known = known_kit_skills(kits_root)
        for markdown, _ in markdown_files:
            rel = markdown.relative_to(skill_path).as_posix()
            try:
                text = read_text_utf8(markdown)
            except (OSError, UnicodeDecodeError):
                continue
            reported = set()
            for number, line in enumerate(text.splitlines(), 1):
                if REFERENCE_ALLOW_MARKER in line:
                    continue
                for match in SKILL_TOKEN.finditer(line):
                    slug = match.group(1)
                    if slug not in known and slug not in reported:
                        reported.add(slug)
                        warn(rel, number, f"Skill reference 'ak-{slug}' resolves to no skill under kits/; "
                             f"update it or mark an intentional alias with '{REFERENCE_ALLOW_MARKER}'",
                             rule='dead-skill-reference')

    code, tests = _script_files(skill_path)
    if code:
        if not tests:
            warn('scripts', 0, f'{len(code)} script file(s) without tests; add scripts/tests/ or document why '
                 'the script is exercised elsewhere', rule='script-tests')
        texts = [body, data.get('compatibility') or '']
        for markdown, _ in markdown_files:
            if markdown.name != 'SKILL.md':
                try:
                    texts.append(read_text_utf8(markdown))
                except (OSError, UnicodeDecodeError):
                    continue
        readme = skill_path / 'scripts' / 'README.md'
        if readme.is_file():
            try:
                texts.append(read_text_utf8(readme))
            except (OSError, UnicodeDecodeError):
                pass
        if not any(PLATFORM_NOTE.search(text) for text in texts):
            warn('scripts', 0, 'Scripts ship without a platform note; state supported operating systems or '
                 "set 'compatibility'", rule='script-platform-notes')
