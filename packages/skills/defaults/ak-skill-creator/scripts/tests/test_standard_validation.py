import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS_DIR))

import quick_validate  # noqa: E402
import skill_standard_report  # noqa: E402
from standard_validation import MAX_LISTING_DESCRIPTOR, known_kit_skills  # noqa: E402

COMPLETE_BODY = '''# Example

Produce the report the user asked for. Not for adjacent deployment work.

## Done when

Verify the output file exists and its checks pass.
'''


def write_skill(directory, name, description='Summarize logs. Use when a log file is attached.',
                body=COMPLETE_BODY, extra=''):
    directory.mkdir(parents=True, exist_ok=True)
    (directory / 'SKILL.md').write_text(
        f'---\nname: {name}\ndescription: "{description}"\n{extra}---\n\n{body}', encoding='utf-8')
    return directory


def rules(result):
    return [warning.get('rule') for warning in result['warnings']]


class StandardWarningTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        known_kit_skills.cache_clear()

    def tearDown(self):
        self.tmp.cleanup()

    def validate(self, skill, kit=False):
        return quick_validate.validate_skill_detailed(skill, kit=kit)

    def test_complete_skill_has_no_standard_warnings(self):
        result = self.validate(write_skill(self.root / 'log-summary', 'log-summary'))
        self.assertEqual(result['errors'], [])
        self.assertEqual(result['warnings'], [])

    def test_missing_activation_condition_warns_but_stays_valid(self):
        skill = write_skill(self.root / 'logs', 'logs', description='Summarize logs.')
        result = self.validate(skill)
        self.assertEqual(result['errors'], [])
        self.assertIn('description-trigger', rules(result))

    def test_when_to_use_supplies_the_activation_condition(self):
        skill = write_skill(self.root / 'logs', 'logs', description='Summarize logs.',
                            extra='when_to_use: "Invoke to summarize an attached log."\n')
        self.assertNotIn('description-trigger', rules(self.validate(skill)))

    def test_listing_descriptor_over_runtime_truncation_warns(self):
        when = 'w' * (MAX_LISTING_DESCRIPTOR - 40)
        skill = write_skill(self.root / 'long', 'long', extra=f'when_to_use: "Use when {when}"\n')
        result = self.validate(skill)
        self.assertEqual(result['errors'], [])
        self.assertIn('descriptor-length', rules(result))

    def test_missing_sections_warn_and_name_each_gap(self):
        skill = write_skill(self.root / 'thin', 'thin', body='Summarize the log in plain words.\n')
        result = self.validate(skill)
        messages = [w['message'] for w in result['warnings'] if w.get('rule') == 'standard-sections']
        self.assertEqual(len(messages), 1, result)
        for gap in ('activation boundary', 'section headings', 'completion or verification'):
            self.assertIn(gap, messages[0])

    def test_explicit_exemption_silences_section_check_only(self):
        body = '<!-- skill-standard-exempt: tiny restatement router -->\nRestate the last message.\n'
        skill = write_skill(self.root / 'tiny', 'tiny', description='Restate text.', body=body)
        found = rules(self.validate(skill))
        self.assertNotIn('standard-sections', found)
        self.assertIn('description-trigger', found)

    def test_empty_exemption_reason_does_not_exempt(self):
        body = '<!-- skill-standard-exempt: -->\nRestate the last message.\n'
        skill = write_skill(self.root / 'tiny', 'tiny', body=body)
        self.assertIn('standard-sections', rules(self.validate(skill)))

    def test_dead_cross_skill_reference_in_kit_layout(self):
        skills = self.root / 'kits' / 'core' / 'skills'
        write_skill(skills / 'ak-present', 'ak-present', extra='when_to_use: "Use when present."\n')
        body = COMPLETE_BODY + '\nHand off to `/ak-present`, then `/ak-missing`, then legacy /ak:gone.\n' \
            'The ak-run runtime and ak-agent-runtime server are not skills.\n' \
            'Legacy `ak-retired` maps to ak-present. skill-reference-allow\n'
        skill = write_skill(skills / 'ak-caller', 'ak-caller', body=body,
                            extra='when_to_use: "Use when calling."\n')
        dead = [w for w in self.validate(skill)['warnings'] if w.get('rule') == 'dead-skill-reference']
        self.assertEqual([w['message'].split("'")[1] for w in dead], ['ak-missing', 'ak-gone'])

    def test_nested_kit_skills_are_known_references(self):
        skills = self.root / 'kits' / 'engineer' / 'skills'
        write_skill(skills / 'ak-bundle' / 'ak-pdf', 'ak-pdf')
        skill = write_skill(skills / 'ak-bundle', 'ak-bundle', body=COMPLETE_BODY + '\nRoute PDFs to /ak-pdf.\n',
                            extra='when_to_use: "Use when bundling."\n')
        self.assertNotIn('dead-skill-reference', rules(self.validate(skill)))

    def test_project_skill_skips_cross_skill_resolution(self):
        skill = write_skill(self.root / 'project', 'project', body=COMPLETE_BODY + '\nThen run ak-anything.\n')
        self.assertNotIn('dead-skill-reference', rules(self.validate(skill)))

    def test_scripts_without_tests_or_platform_note_warn(self):
        skill = write_skill(self.root / 'scripted', 'scripted')
        (skill / 'scripts').mkdir()
        (skill / 'scripts' / 'run.py').write_text('print(1)\n', encoding='utf-8')
        found = rules(self.validate(skill))
        self.assertIn('script-tests', found)
        self.assertIn('script-platform-notes', found)

    def test_scripts_with_tests_and_compatibility_are_clean(self):
        skill = write_skill(self.root / 'scripted', 'scripted',
                            extra='compatibility: "Python 3.10+ on macOS, Linux and Windows"\n')
        (skill / 'scripts' / 'tests').mkdir(parents=True)
        (skill / 'scripts' / 'run.py').write_text('print(1)\n', encoding='utf-8')
        (skill / 'scripts' / 'tests' / 'test_run.py').write_text('', encoding='utf-8')
        found = rules(self.validate(skill))
        self.assertNotIn('script-tests', found)
        self.assertNotIn('script-platform-notes', found)

    def test_text_output_labels_rules(self):
        skill = write_skill(self.root / 'logs', 'logs', description='Summarize logs.')
        output = io.StringIO()
        with redirect_stdout(output):
            self.assertEqual(quick_validate.main([str(skill)]), 0)
        self.assertIn('[description-trigger]', output.getvalue())


class StandardReportTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        write_skill(self.root / 'good', 'good')
        write_skill(self.root / 'thin', 'thin', description='Summarize logs.', body='Plain body.\n')
        write_skill(self.root / 'broken', 'broken', body=COMPLETE_BODY + '\nSee [ref](references/missing.md).\n')
        write_skill(self.root / '.hidden' / 'skipped', 'skipped', body='x\n')

    def tearDown(self):
        self.tmp.cleanup()

    def run_report(self, *args):
        output = io.StringIO()
        with redirect_stdout(output):
            code = skill_standard_report.main([str(self.root), *args])
        return code, output.getvalue()

    def test_report_is_warning_first_and_counts_rules(self):
        code, output = self.run_report('--json')
        self.assertEqual(code, 0)
        report = json.loads(output)
        self.assertEqual(report['skills_scanned'], 3)
        self.assertEqual(report['skills_with_errors'], 1)
        self.assertEqual(report['warnings_by_rule'].get('description-trigger'), 1)
        self.assertEqual(report['warnings_by_rule'].get('standard-sections'), 1)

    def test_strict_fails_on_errors(self):
        code, output = self.run_report('--strict')
        self.assertEqual(code, 1)
        self.assertIn('references/missing.md', output)

    def test_missing_root_is_a_usage_error(self):
        self.assertEqual(skill_standard_report.main([str(self.root / 'absent')]), 2)


if __name__ == '__main__':
    unittest.main()
