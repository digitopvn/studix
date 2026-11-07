"""Tests for the filmmaking production-graph tooling (standard library only).

Run: python -m pytest scripts/tests/test_film_tools.py
Each mutation test copies the bundled example film to a temp folder, breaks one
production rule, and asserts the matching finding, so the fixture itself stays
the single source of valid data.
"""

import contextlib
import io
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))

import film  # noqa: E402
from film_continuity import qc_report  # noqa: E402
from film_prompt import compile_prompt, route  # noqa: E402
from film_reports import build_timeline, costs, cue_sheet, dialogue_coverage, ffconcat  # noqa: E402
from film_schema import SchemaError, SchemaSet, load_json  # noqa: E402

EXAMPLE = SCRIPTS.parent / "assets" / "examples" / "rain-check"


def run_cli(*argv):
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        code = film.main([str(a) for a in argv])
    return code, out.getvalue(), err.getvalue()


class FilmCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / "rain-check"
        shutil.copytree(EXAMPLE, self.root)

    def edit(self, rel, mutate):
        path = self.root / rel
        data = json.loads(path.read_text(encoding="utf-8"))
        mutate(data)
        path.write_text(json.dumps(data, indent=2), encoding="utf-8")

    def shot_path(self, shot_id):
        return f"scenes/{shot_id[:3]}/shots/{shot_id}/shot.json"

    def cue(self, cue_id, mutate):
        def apply(doc):
            mutate(next(c for c in doc["cues"] if c["id"] == cue_id))
        self.edit("audio/cues.json", apply)

    def findings(self, check_media=False):
        return film._validated(self.root, check_media).findings

    def codes(self, severity="error", **kw):
        return [(f.code, f.where) for f in self.findings(**kw) if f.severity == severity]

    def assertFinding(self, code, where, severity="error", contains=None):
        matches = [f for f in self.findings() if f.severity == severity and f.code == code and f.where == where]
        self.assertTrue(matches, f"no {severity} {code} at {where}; got {[(f.code, f.where, f.message) for f in self.findings()]}")
        if contains:
            self.assertTrue(any(contains in f.message for f in matches), [f.message for f in matches])
        return matches[0]


class ExampleFilmTest(FilmCase):
    def test_example_is_clean(self):
        self.assertEqual([f.as_dict() for f in self.findings()], [])

    def test_two_recurring_characters_across_dialogue_scenes(self):
        loaded = film._validated(self.root)
        speakers = {}
        for cue in loaded.cues.values():
            if cue["stem"] == "DX":
                speakers.setdefault(cue["character"], set()).add(cue["scene_id"])
        self.assertEqual(set(speakers), {"MAI_01", "LINH_01"})
        self.assertTrue(all(len(scenes) >= 2 for scenes in speakers.values()))

    def test_reaction_and_cutaway_coverage_reduces_visible_lipsync(self):
        report = dialogue_coverage(film._validated(self.root))
        self.assertLess(report["visible_lipsync_seconds"], report["dialogue_seconds"])
        self.assertAlmostEqual(report["visible_lipsync_seconds"] + report["off_screen_seconds"], report["dialogue_seconds"])
        off_screen_types = {row["shot_type"] for row in report["shots"] if row["coverage"] == "off_screen"}
        self.assertTrue({"reaction", "insert", "cutaway"} <= off_screen_types, off_screen_types)
        self.assertTrue(all(row["lipsync"] != "none" for row in report["shots"] if row["coverage"] == "lipsync"))

    def test_reports_are_deterministic(self):
        first = [run_cli(cmd, self.root)[1] for cmd in ("route", "coverage", "cue-sheet", "costs", "qc")]
        second = [run_cli(cmd, self.root)[1] for cmd in ("route", "coverage", "cue-sheet", "costs", "qc")]
        self.assertEqual(first, second)


class SchemaTest(unittest.TestCase):
    def setUp(self):
        self.schemas = SchemaSet()

    def test_relative_path_rejects_escape_and_absolute(self):
        def asset_with(path):
            frame = {"id": "REF_A", "view": "front", "path": path, "status": "canonical", "version": 1}
            return {"id": "LOC_A", "kind": "location", "name": "n", "description": "d", "references": [frame]}

        self.assertEqual(self.schemas.validate(asset_with("bibles/locations/a..b/wide.png"), "bible-asset.schema.json"), [])
        for bad in ("/etc/passwd", "../x.png", "a/../../x", "a\\..\\x", "C:\\x.png", "\\\\server\\x", "", "a\nb.png", "a\x00.png", "a\x7f.png",
                    "a\x85.png", "a" + chr(0x2028) + "b.png"):
            self.assertTrue(self.schemas.validate(asset_with(bad), "bible-asset.schema.json"), bad)

    def test_unknown_field_and_bad_ids_rejected(self):
        doc = load_json(EXAMPLE / "scenes/S02/shots/S02_SH004/shot.json")
        self.assertEqual(self.schemas.validate(doc, "shot.schema.json"), [])
        bad = dict(doc, shot_id="S2_SH4", mood="sad")
        errors = self.schemas.validate(bad, "shot.schema.json")
        self.assertTrue(any("shot_id" in e for e in errors))
        self.assertTrue(any("unknown field 'mood'" in e for e in errors))

    def test_unsupported_keyword_fails_loudly(self):
        with tempfile.TemporaryDirectory() as tmp:
            Path(tmp, "x.schema.json").write_text('{"type": "string", "format": "email"}', encoding="utf-8")
            with self.assertRaises(SchemaError):
                SchemaSet(tmp).validate("a", "x.schema.json")

    def test_non_finite_numbers_are_not_json_numbers(self):
        doc = load_json(EXAMPLE / "project.json")
        for bad in (float("nan"), float("inf")):
            self.assertTrue(self.schemas.validate(dict(doc, fps=bad), "project.schema.json"), bad)

    def test_duplicate_keys_and_nan_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp, "d.json")
            path.write_text('{"a": 1, "a": 2}', encoding="utf-8")
            with self.assertRaises(ValueError):
                load_json(path)
            path.write_text('{"a": NaN}', encoding="utf-8")
            with self.assertRaises(ValueError):
                load_json(path)


class IntegrityTest(FilmCase):
    def test_undeclared_wardrobe_change_is_flagged(self):
        def swap(shot):
            shot["wardrobe"]["MAI_01"] = "LINH_KNIT_01"
        self.edit(self.shot_path("S02_SH007"), swap)
        self.assertFinding("wardrobe", "shot S02_SH007", contains="scene state")

    def test_candidate_reference_must_be_promoted(self):
        self.edit(self.shot_path("S02_SH007"), lambda s: s["references"].append("CHAR_MAI_CAND_007"))
        self.assertFinding("non-canonical-ref", "shot S02_SH007", contains="promote")

    def test_character_without_identity_reference(self):
        self.edit(self.shot_path("S02_SH007"), lambda s: s.update(references=["WARDROBE_MAI_RAINCOAT_01", "LOC_CAFE_TABLE"]))
        self.assertFinding("identity-unanchored", "shot S02_SH007")

    def test_identity_pack_needs_canonical_front(self):
        def drop_front(doc):
            doc["references"] = [r for r in doc["references"] if r["id"] != "CHAR_LINH_FRONT"]
        self.edit("bibles/characters/linh-01.json", drop_front)
        self.assertFinding("identity-pack", "bibles/characters LINH_01")

    def test_visible_speaker_without_lipsync(self):
        self.edit(self.shot_path("S02_SH007"), lambda s: s.update(lipsync="none"))
        finding = self.assertFinding("lipsync", "shot S02_SH007")
        self.assertEqual(finding.timecode, "00:00:40.000")

    def test_budget_policy_recommends_dedicated_lipsync(self):
        self.edit(self.shot_path("S02_SH004"), lambda s: s.update(lipsync="native", state="GENERATED"))
        self.assertFinding("lipsync-policy", "shot S02_SH004", severity="warning")

    def test_temp_dialogue_blocks_lipsync_generation(self):
        self.cue("DX_MAI_001", lambda c: c.update(status="temp"))
        self.assertFinding("audio-first", "shot S02_SH002", contains="master dialogue")

    def test_missing_alignment_blocks_lipsync_generation(self):
        (self.root / "audio/alignment/DX_MAI_001.json").unlink()
        self.assertFinding("audio-first", "shot S02_SH002", contains="alignment")

    def test_generation_requires_approved_keyframe(self):
        self.edit(self.shot_path("S02_SH002"), lambda s: s["keyframe"].update(status="draft"))
        self.assertFinding("gate", "shot S02_SH002", contains="approved keyframe")

    def test_selected_generation_before_frame_approval(self):
        def early(shot):
            shot["state"] = "STORYBOARDED"
        self.edit(self.shot_path("S02_SH002"), early)
        self.assertFinding("gate", "shot S02_SH002", contains="still STORYBOARDED")

    def test_qc_failed_state_must_match_record(self):
        self.edit(self.shot_path("S02_SH006"), lambda s: s.update(state="APPROVED"))
        self.assertFinding("gate", "shot S02_SH006", contains="passed QC")

    def test_dialogue_running_past_scene_end(self):
        self.cue("DX_MAI_003", lambda c: c.update(start=34.0))
        self.assertFinding("timing", "audio cue DX_MAI_003", contains="fix audio or shot timing")

    def test_sync_event_outside_its_shot(self):
        self.cue("FX_CUP_LIFT", lambda c: c.update(start=10.0))
        self.assertFinding("sync-event", "audio cue FX_CUP_LIFT")

    def test_dangling_location_and_asymmetric_link(self):
        self.edit("scenes/S03/scene.json", lambda s: s.update(location="MOON_BASE_01"))
        self.edit(self.shot_path("S03_SH002"), lambda s: s.update(continuity_to=None))
        self.assertFinding("dangling-ref", "scenes/S03")
        self.assertFinding("continuity-link", "shot S03_SH003", contains="does not link back")

    def test_bible_file_must_match_id(self):
        (self.root / "bibles/props/umbrella-01.json").rename(self.root / "bibles/props/umbrella.json")
        self.assertIn(("file-name", "bibles/props/umbrella.json"), self.codes())

    def test_scene_can_pin_an_earlier_identity_version(self):
        def new_look(doc):
            doc["identity_version"] = 2
            doc["references"].append({"id": "CHAR_MAI_V2_FRONT", "view": "front", "status": "canonical", "version": 2,
                                      "path": "bibles/characters/mai-01/v2-front.png"})
        self.edit("bibles/characters/mai-01.json", new_look)
        for scene_id in ("S01", "S02", "S03"):
            self.edit(f"scenes/{scene_id}/scene.json", lambda s: s.setdefault("identity_versions", {}).update(MAI_01=1))
        self.assertEqual([f.message for f in self.findings() if f.code == "identity-version"], [])

        self.edit("scenes/S03/scene.json", lambda s: s.pop("identity_versions"))
        self.assertFinding("identity-version", "shot S03_SH001", contains="scene S03 uses v2")
        self.assertNotIn(("identity-version", "shot S02_SH002"), self.codes())

    def test_scene_identity_version_must_exist(self):
        self.edit("scenes/S02/scene.json", lambda s: s.update(identity_versions={"MAI_01": 3, "GHOST_01": 1}))
        self.assertFinding("identity-version", "scenes/S02", contains="above the bible")
        self.assertFinding("identity-version", "scenes/S02", contains="GHOST_01")

    def test_video_generation_waits_for_animatic_approval(self):
        self.edit("project.json", lambda p: p.update(animatic={"status": "pending"}))
        self.assertFinding("gate", "shot S02_SH002", contains="animatic")
        self.assertNotIn(("gate", "shot S03_SH001"), self.codes())

    def candidate_generation(self, shot_id, **extra):
        gen = {"id": f"GEN_{shot_id}_09", "prompt_version": 1, "provider": "example-provider", "model": "example-video-model",
               "output": f"scenes/{shot_id[:3]}/shots/{shot_id}/generations/09.mp4", "seconds": 5, "status": "candidate", **extra}
        self.edit(self.shot_path(shot_id), lambda s: s.setdefault("generations", []).append(gen))

    def test_recorded_generation_before_frame_approval_is_caught(self):
        self.candidate_generation("S03_SH004")
        self.assertFinding("gate", "shot S03_SH004", contains="before the storyboard/keyframe was approved")

    def test_recorded_generation_before_animatic_approval_is_caught(self):
        self.edit("project.json", lambda p: p.update(animatic={"status": "pending"}))
        self.candidate_generation("S02_SH007")
        self.assertFinding("gate", "shot S02_SH007", contains="animatic")

    def test_discarded_history_survives_a_qc_return(self):
        def send_back(shot):
            shot["state"] = "STORYBOARDED"
            shot["generations"][0]["status"] = "discarded"
            shot["qc"]["status"] = "pending"
        self.edit(self.shot_path("S02_SH006"), send_back)
        self.assertNotIn(("gate", "shot S02_SH006"), self.codes())
        self.assertEqual([r for r in qc_report(film._validated(self.root)) if r["shot_id"] == "S02_SH006"], [])

    def test_approved_animatic_needs_every_frame(self):
        self.edit(self.shot_path("S03_SH002"), lambda s: s.pop("storyboard"))
        self.edit(self.shot_path("S03_SH002"), lambda s: s.update(state="PLANNED"))
        self.assertFinding("gate", "shot S03_SH002", contains="no frame in it")

    def test_rejected_storyboard_is_not_an_animatic_frame(self):
        self.edit(self.shot_path("S03_SH003"), lambda s: s["storyboard"].update(status="rejected"))
        self.edit(self.shot_path("S03_SH003"), lambda s: s.update(state="PLANNED"))
        self.assertFinding("gate", "shot S03_SH003", contains="no frame in it")
        blockers = build_timeline(film._validated(self.root), "animatic")["blockers"]
        self.assertTrue(any(b.startswith("S03_SH003: no usable frame") for b in blockers), blockers)

    def test_recorded_generation_references_must_be_canonical(self):
        self.candidate_generation("S02_SH007", references=["CHAR_MAI_CAND_007", "NOPE_01"])
        self.assertFinding("non-canonical-ref", "shot S02_SH007", contains="CHAR_MAI_CAND_007")
        self.assertFinding("dangling-ref", "shot S02_SH007", contains="NOPE_01")

    def test_continuity_link_to_itself(self):
        self.edit(self.shot_path("S03_SH002"), lambda s: s.update(continuity_from="S03_SH002"))
        self.assertFinding("continuity-link", "shot S03_SH002", contains="itself")

    def test_qc_failure_end_must_follow_start(self):
        self.edit(self.shot_path("S02_SH006"), lambda s: s["qc"]["failures"][0].update(end=1.0))
        self.assertFinding("qc", "shot S02_SH006", contains="between its start and the shot end")

    def test_same_speaker_lines_must_not_overlap(self):
        self.cue("DX_MAI_002", lambda c: c.update(start=6.0))
        self.assertFinding("dialogue", "audio cue DX_MAI_002", severity="warning", contains="overlaps DX_MAI_001")

    def test_overlap_is_checked_against_the_longest_earlier_line(self):
        self.cue("DX_MAI_001", lambda c: c.update(duration=20.0))
        self.cue("DX_MAI_003", lambda c: c.update(start=20.0))
        self.assertFinding("dialogue", "audio cue DX_MAI_003", severity="warning", contains="overlaps DX_MAI_001")

    def test_word_and_silence_alignment_order(self):
        path = self.root / "audio/alignment/DX_MAI_001.json"
        doc = json.loads(path.read_text(encoding="utf-8"))
        doc["words"] = [{"text": "late", "start": 1.0, "end": 1.4}, {"text": "again", "start": 0.5, "end": 0.9}]
        doc["silences"] = [{"start": 4.0, "end": 9.0}]
        path.write_text(json.dumps(doc), encoding="utf-8")
        self.assertFinding("alignment", "audio cue DX_MAI_001", contains="word 'again'")
        self.assertFinding("alignment", "audio cue DX_MAI_001", contains="silence at 4.0s")

    def test_duration_should_land_on_a_frame(self):
        self.edit(self.shot_path("S01_SH001"), lambda s: s.update(duration_target=5.01))
        self.assertFinding("timing", "shot S01_SH001", severity="warning", contains="whole number of frames")

    def test_check_media_reports_missing_files(self):
        self.assertEqual(self.codes(), [])
        self.assertIn("missing-media", {code for code, _ in self.codes(check_media=True)})


class ContinuityTest(FilmCase):
    def test_screen_side_flip_needs_declaration(self):
        self.edit(self.shot_path("S02_SH002"), lambda s: s["continuity"]["screen_positions"].update(MAI_01="right", LINH_01="left"))
        finding = self.assertFinding("continuity", "shot S02_SH002", contains="screen_positions.MAI_01")
        self.assertEqual(finding.timecode, "00:00:16.000")

        def declare(shot):
            shot["continuity_changes"] = [
                {"field": "screen_positions.MAI_01", "reason": "camera crosses the line on a visible dolly move"},
                {"field": "screen_positions.LINH_01", "reason": "camera crosses the line on a visible dolly move"}]
        self.edit(self.shot_path("S02_SH002"), declare)
        self.assertNotIn(("continuity", "shot S02_SH002"), self.codes())
        self.assertNotIn(("continuity", "shot S02_SH003"), self.codes())

    def test_state_is_carried_through_reaction_shots(self):
        # Mai is off screen in S02_SH005 (insert); her return in SH006 must match SH002.
        self.edit(self.shot_path("S02_SH006"), lambda s: s["continuity"]["conditions"].update(MAI_01=[]))
        self.assertFinding("continuity", "shot S02_SH006", contains="last seen in S02_SH002")

    def test_undeclared_prop_move_and_stale_declaration(self):
        self.edit(self.shot_path("S02_SH005"), lambda s: s.pop("continuity_changes"))
        self.assertFinding("continuity", "shot S02_SH005", contains="prop_states.COFFEE_CUP_01")
        self.edit(self.shot_path("S02_SH003"), lambda s: s.update(continuity_changes=[{"field": "conditions.LINH_01", "reason": "x"}]))
        self.assertFinding("continuity", "shot S02_SH003", severity="warning", contains="does not differ")

    def test_movement_direction_reversal(self):
        self.edit(self.shot_path("S03_SH001"), lambda s: s["continuity"].update(screen_direction="right_to_left"))
        self.edit(self.shot_path("S02_SH007"), lambda s: s["continuity"].update(screen_direction="left_to_right"))
        self.assertFinding("continuity", "shot S03_SH001", contains="screen_direction")

    def test_qc_report_routes_to_cheapest_stage(self):
        rows = qc_report(film._validated(self.root))
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["timecode"], "00:00:37.800")
        self.assertEqual(rows[0]["return_to"], "STORYBOARDED")

        def lipsync_fail(shot):
            shot["state"] = "QC_FAILED"
            shot["qc"] = {"status": "failed", "failures": [{"category": "lipsync_drift", "at": 2.0, "note": "drifts late"},
                                                           {"category": "music", "at": 0.5, "note": "music masks line"}]}
        self.edit(self.shot_path("S02_SH004"), lipsync_fail)
        stages = {row["category"]: row["return_to"] for row in qc_report(film._validated(self.root))}
        self.assertEqual(stages["lipsync_drift"], "GENERATED")
        self.assertEqual(stages["music"], "audio")

    def test_native_lipsync_failure_returns_to_the_frame(self):
        def native_fail(shot):
            shot["state"] = "QC_FAILED"
            shot["qc"] = {"status": "failed", "failures": [{"category": "lipsync_offset", "at": 1.0, "note": "late"}]}
        self.edit(self.shot_path("S02_SH002"), native_fail)
        row = next(r for r in qc_report(film._validated(self.root)) if r["shot_id"] == "S02_SH002")
        self.assertEqual(row["return_to"], "APPROVED_FRAME")
        self.assertIn("dedicated lipsync pass", row["action"])


class OutputTest(FilmCase):
    def test_prompt_orders_inputs_and_binds_audio(self):
        loaded = film._validated(self.root)
        compiled = compile_prompt(loaded, "S02_SH004")
        roles = [slot["role"] for slot in compiled["image_inputs"]]
        self.assertEqual(roles, sorted(roles, key=["identity", "wardrobe", "location", "prop"].index))
        self.assertEqual([a["cue_id"] for a in compiled["audio_inputs"]], ["DX_LINH_002", "DX_LINH_003"])
        for heading in ("IDENTITY REFERENCES", "WARDROBE", "AUDIO AUTHORITY", "LIPSYNC", "CONTINUITY", "NEGATIVE CONSTRAINTS"):
            self.assertIn(heading, compiled["prompt"])
        self.assertIn("round tortoiseshell glasses", compiled["prompt"])

        insert = compile_prompt(loaded, "S02_SH005")
        self.assertEqual(insert["audio_inputs"], [])
        self.assertIn("Off-screen dialogue by Linh", insert["prompt"])

    def test_route_tiers_follow_budget_mode(self):
        rows = {row["shot_id"]: row for row in route(film._validated(self.root))}
        self.assertEqual(rows["S03_SH004"]["tier"], "premium")
        self.assertEqual(rows["S02_SH005"]["tier"], "economy")
        self.assertIn("native_lipsync", rows["S02_SH002"]["capabilities"])
        self.edit("project.json", lambda p: p.update(budget_mode="low"))
        rows = {row["shot_id"]: row for row in route(film._validated(self.root))}
        self.assertEqual(rows["S01_SH002"]["tier"], "economy")

    def test_animatic_is_complete_and_final_is_blocked(self):
        loaded = film._validated(self.root)
        animatic = build_timeline(loaded, "animatic")
        self.assertEqual(animatic["blockers"], [])
        self.assertEqual(animatic["duration"], 68)
        self.assertEqual(animatic["video_audio"], "discard")
        self.assertEqual(set(animatic["audio"]), {"DX", "FX", "AMB", "MX"})
        final = build_timeline(loaded, "final")
        self.assertTrue(any("S03_SH004" in b for b in final["blockers"]))
        self.assertTrue(any("FX_CUP_LIFT" in b for b in final["blockers"]))
        concat = ffconcat(loaded, animatic, loaded.root / "animatic")
        self.assertTrue(concat.startswith("ffconcat version 1.0\nfile '../storyboard/S01_SH001.png'\nduration 5\n"))

    def test_final_never_uses_raw_video_for_dedicated_lipsync(self):
        self.edit(self.shot_path("S02_SH004"), lambda s: s["lipsync_pass"].update(status="pending"))
        loaded = film._validated(self.root)
        final = build_timeline(loaded, "final")
        sh004 = next(item for item in final["video"] if item["shot_id"] == "S02_SH004")
        self.assertIsNone(sh004["source"])
        self.assertIn("S02_SH004: no selected generation or finished lipsync pass", final["blockers"])

    def test_final_blocks_on_open_validation_errors(self):
        self.edit(self.shot_path("S02_SH007"), lambda s: s.update(lipsync="none"))
        loaded = film._validated(self.root)
        final = build_timeline(loaded, "final", loaded.findings)
        self.assertTrue(any(b.startswith("shot S02_SH007:") and "lipsync" in b for b in final["blockers"]), final["blockers"])
        self.assertEqual(build_timeline(loaded, "animatic", loaded.findings)["blockers"], [])

    def test_ffconcat_escapes_apostrophes(self):
        self.edit(self.shot_path("S01_SH001"), lambda s: s["storyboard"].update(path="storyboard/it's.png"))
        loaded = film._validated(self.root)
        concat = ffconcat(loaded, build_timeline(loaded, "animatic"), loaded.root / "animatic")
        self.assertIn("file '../storyboard/it'\\''s.png'\n", concat)

    def test_prompt_states_declared_continuity_changes(self):
        prompt = compile_prompt(film._validated(self.root), "S02_SH005")["prompt"]
        self.assertIn("Intended change (prop_states.COFFEE_CUP_01)", prompt)

    def test_animatic_needs_master_dialogue(self):
        self.cue("DX_LINH_004", lambda c: c.update(status="temp"))
        blockers = build_timeline(film._validated(self.root), "animatic")["blockers"]
        self.assertEqual(blockers, ["DX_LINH_004: DX cue is temp; animatic needs approved/master"])

    def test_costs_never_mix_currencies(self):
        def euro(shot):
            shot["generations"][0]["cost"] = {"amount": 5, "currency": "EUR", "source": "test"}
        self.edit(self.shot_path("S01_SH001"), euro)
        report = costs(film._validated(self.root))
        self.assertEqual(report["by_class"]["CHEAP_BROLL"]["actual_cost"], 0.6)
        self.assertEqual(report["foreign_currency"][0]["currency"], "EUR")
        self.assertEqual(report["by_class"]["STANDARD"]["discarded_seconds"], 6)

    def test_cue_sheet_keeps_stems_and_themes(self):
        sheet = cue_sheet(film._validated(self.root))
        self.assertEqual(sheet["themes"], ["THEME_A_EMOTIONAL", "THEME_A_MAIN", "THEME_A_TENSION"])
        self.assertEqual(sheet["stems"]["DX"]["cues"], 10)
        self.assertEqual(sheet["sync_events"][0]["cue_id"], "FX_UMBRELLA_SNAP")


class CliTest(FilmCase):
    def test_init_creates_valid_project_and_refuses_overwrite(self):
        films = Path(self.tmp.name) / "films"
        code, out, _ = run_cli("init", films, "night-shift", "--title", "Night Shift", "--budget", "low")
        self.assertEqual(code, 0, out)
        code, out, _ = run_cli("validate", films / "night-shift", "--json")
        self.assertEqual((code, json.loads(out)["errors"]), (0, 0))
        self.assertEqual(run_cli("init", films, "night-shift", "--title", "x")[0], 2)
        self.assertEqual(run_cli("init", films, "../escape", "--title", "x")[0], 2)
        self.assertFalse((Path(self.tmp.name) / "escape").exists())
        project = json.loads((films / "night-shift" / "project.json").read_text(encoding="utf-8"))
        self.assertEqual(project["animatic"], {"status": "pending"})

    def test_init_rejects_invalid_settings_before_writing(self):
        films = Path(self.tmp.name) / "films"
        for flags in (["--fps", "nan"], ["--currency", "usd"], ["--aspect", "wide"]):
            code, _, err = run_cli("init", films, "bad-settings", "--title", "x", *flags)
            self.assertEqual(code, 2, flags)
            self.assertIn("invalid project settings", err)
            self.assertFalse((films / "bad-settings").exists())

    def test_validate_exit_codes(self):
        self.assertEqual(run_cli("validate", self.root)[0], 0)
        self.edit(self.shot_path("S02_SH007"), lambda s: s.update(lipsync="none"))
        code, out, _ = run_cli("validate", self.root)
        self.assertEqual(code, 1)
        self.assertIn("[ERROR] lipsync shot S02_SH007 @ 00:00:40.000", out)

    def test_reports_refuse_structurally_broken_graph(self):
        (self.root / "scenes/S02/shots/S02_SH003/shot.json").write_text("{", encoding="utf-8")
        code, _, err = run_cli("coverage", self.root)
        self.assertEqual(code, 2)
        self.assertIn("structural errors", err)

    def test_prompt_unknown_shot_and_timeline_write(self):
        self.assertEqual(run_cli("prompt", self.root, "S09_SH001")[0], 2)
        code, _, _ = run_cli("timeline", self.root, "--mode", "animatic", "--write")
        self.assertEqual(code, 0)
        self.assertTrue((self.root / "animatic/video.ffconcat").is_file())
        self.assertEqual(run_cli("timeline", self.root, "--mode", "final")[0], 1)

    def test_timeline_write_refuses_while_blocked(self):
        code, _, err = run_cli("timeline", self.root, "--mode", "final", "--write")
        self.assertEqual(code, 1)
        self.assertIn("nothing written", err)
        self.assertFalse((self.root / "final/video.ffconcat").exists())
        self.assertFalse((self.root / "final/timeline.json").exists())


if __name__ == "__main__":
    unittest.main()
