"""Tests for the style profile catalog and the composition resolver.

Run: python -m pytest scripts/tests/test_style_system.py   (needs PyYAML)
"""
import importlib.util
import json
import subprocess
import sys
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1]
SKILL = SCRIPTS.parent
_spec = importlib.util.spec_from_file_location("resolve_style", SCRIPTS / "resolve-style.py")
rs = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(rs)

PROFILES = rs.load_profiles()
SCENES = [
    {"id": "s01-cover", "type": "cover"},
    {"id": "s02-ui", "type": "ui-demo"},
    {"id": "s03-flow", "type": "diagram"},
    {"id": "s04-finale", "type": "cta"},
]


class CatalogTest(unittest.TestCase):
    def test_catalog_validates_and_index_is_current(self):
        self.assertEqual(rs.validate(PROFILES), [])

    def test_house_styles_keep_detail_references(self):
        for pid in ("glass-keynote", "comic-multiverse", "cinematic-product-launch"):
            self.assertTrue((SKILL / PROFILES[pid]["detail"]).is_file(), pid)

    def test_templates_resolve_together_without_warnings(self):
        def load(name):
            return json.loads((SKILL / "assets/templates/data" / name).read_text(encoding="utf-8"))

        out = rs.resolve(load("style.example.json"), PROFILES, load("script.example.json"))
        self.assertEqual(out["warnings"], [])


class LookupTest(unittest.TestCase):
    def test_names_and_aliases(self):
        self.assertEqual(rs.lookup("comic style", PROFILES), "comic-multiverse")
        self.assertEqual(rs.lookup("Apple-like", PROFILES), "cinematic-product-launch")
        self.assertEqual(rs.lookup("Glass_Keynote", PROFILES), "glass-keynote")
        self.assertEqual(rs.lookup("glass keynote", PROFILES), "glass-keynote")
        self.assertEqual(rs.lookup("spider verse", PROFILES), "comic-multiverse")

    def test_unknown_name_lists_nearest(self):
        with self.assertRaisesRegex(rs.StyleError, "nearest: .*comic-multiverse"):
            rs.lookup("comix multiverse", PROFILES)

    def test_find_ranks_exact_alias_first(self):
        self.assertEqual(rs.find("spider-verse", PROFILES)[0]["id"], "comic-multiverse")


class ResolveTest(unittest.TestCase):
    def test_base_only_uses_base_everywhere(self):
        out = rs.resolve({"base": "apple", "scenes": SCENES}, PROFILES)
        self.assertEqual(out["base"], "cinematic-product-launch")
        self.assertTrue(all(set(r["dimensions"].values()) == {out["base"]} for r in out["scenes"]))

    def test_layers_replace_only_named_dimensions_in_selected_scenes(self):
        spec = {"base": "cinematic-product-launch", "scenes": SCENES, "layers": [
            {"style": "glass-keynote", "dimensions": ["ui_choreography"], "scenes": {"types": ["ui-demo"]}},
            {"style": "comic-multiverse", "dimensions": ["transitions", "palette"], "scenes": {"ids": ["s04"]}},
        ]}
        rows = {r["id"]: r["dimensions"] for r in rs.resolve(spec, PROFILES)["scenes"]}
        self.assertEqual(rows["s02-ui"]["ui_choreography"], "glass-keynote")
        self.assertEqual(rows["s02-ui"]["transitions"], "cinematic-product-launch")
        self.assertEqual(rows["s04-finale"]["transitions"], "comic-multiverse")
        self.assertEqual(rows["s04-finale"]["palette"], "cinematic-product-launch + comic-multiverse accents")
        self.assertEqual(rows["s01-cover"]["ui_choreography"], "cinematic-product-launch")

    def test_later_layer_wins_and_full_palette(self):
        spec = {"base": "glass-keynote", "scenes": SCENES, "layers": [
            {"style": "comic-multiverse", "dimensions": ["camera"]},
            {"style": "cinematic-product-launch", "dimensions": ["camera", "palette"], "palette_mode": "full",
             "scenes": {"ids": ["s03-flow"]}},
        ]}
        rows = {r["id"]: r["dimensions"] for r in rs.resolve(spec, PROFILES)["scenes"]}
        self.assertEqual(rows["s01-cover"]["camera"], "comic-multiverse")
        self.assertEqual(rows["s03-flow"]["camera"], "cinematic-product-launch")
        self.assertEqual(rows["s03-flow"]["palette"], "cinematic-product-launch")

    def test_scene_types_come_from_script(self):
        spec = {"base": "glass-keynote", "layers": [
            {"style": "comic-multiverse", "dimensions": ["diagrams"], "scenes": {"types": ["diagram"]}}]}
        rows = {r["id"]: r["dimensions"] for r in rs.resolve(spec, PROFILES, {"scenes": SCENES})["scenes"]}
        self.assertEqual(rows["s03-flow"]["diagrams"], "comic-multiverse")
        self.assertEqual(rows["s02-ui"]["diagrams"], "glass-keynote")

    def test_rejects_bad_specs(self):
        with self.assertRaises(rs.StyleError):
            rs.resolve({"layers": []}, PROFILES)
        with self.assertRaisesRegex(rs.StyleError, "dimensions"):
            rs.resolve({"base": "glass-keynote", "layers": [{"style": "comic", "dimensions": ["vibes"]}]}, PROFILES)
        with self.assertRaisesRegex(rs.StyleError, "at most"):
            rs.resolve({"base": "glass-keynote", "layers": [{"style": "comic", "dimensions": ["camera"]}] * 5},
                       PROFILES)
        cases = {
            "unknown spec keys": {"base": "glass-keynote", "layer": []},
            "must be an object": {"base": "glass-keynote", "layers": ["comic"]},
            "unknown keys": {"base": "glass-keynote", "layers": [{"style": "comic", "dimensions": ["camera"], "x": 1}]},
            "palette_mode": {"base": "glass-keynote",
                             "layers": [{"style": "comic", "dimensions": ["palette"], "palette_mode": "Full"}]},
            "unknown scene types": {"base": "glass-keynote",
                                    "layers": [{"style": "comic", "dimensions": ["camera"],
                                                "scenes": {"types": ["ui_demo"]}}]},
            "list of strings": {"base": "glass-keynote",
                                "layers": [{"style": "comic", "dimensions": ["camera"], "scenes": {"ids": "s01"}}]},
            "unknown type": {"base": "glass-keynote", "scenes": [{"id": "s01", "type": "intro"}]},
        }
        for message, spec in cases.items():
            with self.subTest(message), self.assertRaisesRegex(rs.StyleError, message):
                rs.resolve(spec, PROFILES)

    def test_warns_on_unmatched_selector_and_many_transition_languages(self):
        spec = {"base": "glass-keynote", "scenes": SCENES, "layers": [
            {"style": "comic-multiverse", "dimensions": ["transitions"], "scenes": {"ids": ["s02"]}},
            {"style": "cinematic-product-launch", "dimensions": ["transitions"], "scenes": {"ids": ["s03"]}},
            {"style": "comic-multiverse", "dimensions": ["camera"], "scenes": {"ids": ["s99"]}},
        ]}
        warnings = " ".join(rs.resolve(spec, PROFILES)["warnings"])
        self.assertIn("selects no scene", warnings)
        self.assertIn("3 transition languages", warnings)

    def test_cli_resolve_prints_table(self):
        out = subprocess.run(
            [sys.executable, str(SCRIPTS / "resolve-style.py"), "resolve",
             str(SKILL / "assets/templates/data/style.example.json")],
            capture_output=True, text=True, encoding="utf-8",
        )
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertIn("Base: cinematic-product-launch", out.stdout)

    def test_cli_missing_spec_is_a_clean_error(self):
        out = subprocess.run(
            [sys.executable, str(SCRIPTS / "resolve-style.py"), "resolve", str(SKILL / "no-such-style.json")],
            capture_output=True, text=True, encoding="utf-8",
        )
        self.assertEqual(out.returncode, 1)
        self.assertIn("cannot read", out.stderr)
        self.assertNotIn("Traceback", out.stderr)


if __name__ == "__main__":
    unittest.main()
