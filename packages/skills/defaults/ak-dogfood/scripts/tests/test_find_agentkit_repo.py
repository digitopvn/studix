import argparse
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import find_agentkit_repo as finder  # noqa: E402

HAS_GIT = shutil.which('git') is not None


def make_checkout(path, remote=None, name='origin'):
    (path / 'kits' / 'core').mkdir(parents=True)
    (path / 'kits' / 'core' / 'kit.yaml').write_text('name: core\n', encoding='utf-8')
    if remote and HAS_GIT:
        subprocess.run(['git', 'init', '-q', str(path)], check=True)
        subprocess.run(['git', '-C', str(path), 'remote', 'add', name, remote], check=True)
    return path


def args(**overrides):
    base = {'root': [], 'max_depth': 4, 'limit': 5, 'no_scan': True}
    base.update(overrides)
    return argparse.Namespace(**base)


class CanonicalRemoteTest(unittest.TestCase):
    def test_accepts_https_and_ssh_forms(self):
        for url in ('https://github.com/bestagentkits/agentkit.git',
                    'https://github.com/BestAgentKits/agentkit/',
                    'git@github.com:bestagentkits/agentkit.git',
                    'ssh://git@github.com/bestagentkits/agentkit'):
            self.assertTrue(finder.canonical_remote(url), url)

    def test_rejects_other_repositories(self):
        for url in ('https://github.com/someone/agentkit.git',
                    'https://github.com/bestagentkits/agentkit-docs.git',
                    'git@github.com:bestagentkits/ak-web.git'):
            self.assertFalse(finder.canonical_remote(url), url)


class LocateTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def test_env_repo_wins(self):
        repo = make_checkout(self.tmp / 'somewhere' / 'agentkit')
        result = finder.locate(args(), env={'AGENTKIT_REPO': str(repo)}, cwd=self.tmp)
        self.assertTrue(result['found'])
        self.assertEqual(result['repo']['source'], 'env:AGENTKIT_REPO')
        self.assertEqual(Path(result['repo']['path']), repo.resolve())

    def test_kits_dir_parent(self):
        repo = make_checkout(self.tmp / 'ak')
        result = finder.locate(args(), env={'AGENTKIT_KITS_DIR': str(repo / 'kits')}, cwd=self.tmp)
        self.assertEqual(result['repo']['source'], 'env:AGENTKIT_KITS_DIR')

    def test_cwd_ancestor(self):
        repo = make_checkout(self.tmp / 'agentkit')
        nested = repo / 'kits' / 'core'
        result = finder.locate(args(), env={}, cwd=nested)
        self.assertEqual(result['repo']['source'], 'cwd')
        self.assertEqual(Path(result['repo']['path']), repo.resolve())

    def test_nothing_found(self):
        result = finder.locate(args(), env={}, cwd=self.tmp)
        self.assertFalse(result['found'])
        self.assertIsNone(result['repo'])

    def test_scan_skips_hidden_and_heavy_dirs(self):
        make_checkout(self.tmp / 'node_modules' / 'agentkit')
        make_checkout(self.tmp / '.cache' / 'agentkit')
        repo = make_checkout(self.tmp / 'code' / 'agentkit')
        found = list(finder.scan(self.tmp, 4))
        self.assertEqual([p.resolve() for p in found], [repo.resolve()])

    def test_scan_respects_depth(self):
        make_checkout(self.tmp / 'a' / 'b' / 'c' / 'agentkit')
        self.assertEqual(list(finder.scan(self.tmp, 2)), [])

    @unittest.skipUnless(HAS_GIT, 'git is not installed')
    def test_linked_worktree_resolves_to_main_checkout(self):
        repo = make_checkout(self.tmp / 'agentkit', 'https://github.com/bestagentkits/agentkit.git')
        git = ['git', '-C', str(repo), '-c', 'user.name=t', '-c', 'user.email=t@example.invalid']
        subprocess.run(git + ['add', '.'], check=True)
        subprocess.run(git + ['commit', '-qm', 'init'], check=True)
        linked = self.tmp / 'elsewhere' / 'wt'
        subprocess.run(git + ['worktree', 'add', '-q', str(linked)], check=True)
        result = finder.locate(args(), env={}, cwd=linked)
        self.assertEqual(Path(result['repo']['path']), repo.resolve())
        self.assertFalse(result['repo']['linked_worktree'])

    @unittest.skipUnless(HAS_GIT, 'git is not installed')
    def test_verified_checkout_ranks_first(self):
        make_checkout(self.tmp / 'one' / 'agentkit', 'https://github.com/someone/agentkit.git')
        good = make_checkout(self.tmp / 'two' / 'agentkit', 'git@github.com:bestagentkits/agentkit.git',
                             name='upstream')
        result = finder.locate(args(no_scan=False, root=[str(self.tmp)], max_depth=2), env={},
                               cwd=self.tmp)
        self.assertEqual(Path(result['repo']['path']), good.resolve())
        self.assertTrue(result['repo']['verified'])
        self.assertEqual(result['repo']['canonical_remote'], 'upstream')


if __name__ == '__main__':
    unittest.main()
