"""Load a films/<slug>/ production graph into memory and derive its cut timeline.

Loading never stops at the first problem: every schema or layout defect becomes a
finding so one run reports the whole project. Documents that fail their schema
are kept out of the graph, which keeps later integrity checks from crashing on
malformed data.
"""

from dataclasses import dataclass, field
from pathlib import Path

from film_schema import SchemaSet, load_json

STATES = ["PLANNED", "STORYBOARDED", "APPROVED_FRAME", "GENERATED", "LIPSYNCED", "QC_FAILED", "APPROVED", "ASSEMBLED"]
STATE_RANK = {name: rank for rank, name in enumerate(STATES)}
BIBLE_DIRS = {"locations": "location", "props": "prop", "wardrobe": "wardrobe"}
TIME_EPSILON = 0.05  # seconds of rounding slack between audio and picture timing


@dataclass
class Finding:
    severity: str  # "error" blocks the next production stage; "warning" needs a decision
    code: str
    where: str
    message: str
    timecode: str = None

    def as_dict(self):
        data = {"severity": self.severity, "code": self.code, "where": self.where, "message": self.message}
        if self.timecode is not None:
            data["timecode"] = self.timecode
        return data


@dataclass
class Film:
    root: Path
    project: dict = None
    beats: dict = None
    characters: dict = field(default_factory=dict)
    assets: dict = field(default_factory=dict)  # id -> bible-asset document (location/prop/wardrobe)
    references: dict = field(default_factory=dict)  # reference id -> (owner id, reference dict)
    scenes: dict = field(default_factory=dict)
    shots: dict = field(default_factory=dict)
    cues: dict = field(default_factory=dict)
    alignments: dict = field(default_factory=dict)  # cue id -> alignment document
    findings: list = field(default_factory=list)
    _placements: list = field(default=None, repr=False)

    def add(self, severity, code, where, message, timecode=None):
        self.findings.append(Finding(severity, code, where, message, timecode))

    def scene_order(self):
        return [sid for sid in (self.project or {}).get("scenes", []) if sid in self.scenes]

    def shot_order(self, scene_id):
        return [sh for sh in self.scenes[scene_id]["shots"] if sh in self.shots]

    def identity_version_for(self, char_id, scene_id):
        """Identity version a scene uses: its explicit override, else the character's latest."""
        scene = self.scenes.get(scene_id) or {}
        return scene.get("identity_versions", {}).get(char_id, self.characters[char_id]["identity_version"])

    def scene_duration(self, scene_id):
        return sum(self.shots[sh]["duration_target"] for sh in self.shot_order(scene_id))

    def timeline(self):
        """Shot placements on the cut: film_start and scene_start in seconds.

        Cached: the graph is read-only once loaded, and checks query it per shot.
        """
        if self._placements is not None:
            return self._placements
        placements, film_clock = [], 0.0
        for scene_id in self.scene_order():
            scene_clock = 0.0
            for shot_id in self.shot_order(scene_id):
                duration = self.shots[shot_id]["duration_target"]
                placements.append({"shot_id": shot_id, "scene_id": scene_id, "film_start": film_clock,
                                   "scene_start": scene_clock, "duration": duration})
                film_clock += duration
                scene_clock += duration
        self._placements = placements
        return placements

    def placement(self, shot_id):
        return next((p for p in self.timeline() if p["shot_id"] == shot_id), None)

    def scene_film_start(self, scene_id):
        clock = 0.0
        for sid in self.scene_order():
            if sid == scene_id:
                return clock
            clock += self.scene_duration(sid)
        return None

    def dialogue_over(self, shot_id):
        """DX cues overlapping a shot, as (cue, start_in_shot, end_in_shot) tuples."""
        spot = self.placement(shot_id)
        if spot is None:
            return []
        lo, hi = spot["scene_start"], spot["scene_start"] + spot["duration"]
        overlaps = []
        for cue in self.cues.values():
            if cue["stem"] != "DX" or cue["scene_id"] != spot["scene_id"]:
                continue
            start, end = max(lo, cue["start"]), min(hi, cue["start"] + cue["duration"])
            if end - start > TIME_EPSILON:
                overlaps.append((cue, round(start - lo, 3), round(end - lo, 3)))
        return overlaps

    def visible_dialogue(self, shot_id):
        """Dialogue whose speaker's mouth is readable in this shot."""
        visible = set(self.shots[shot_id]["visible_speakers"])
        return [item for item in self.dialogue_over(shot_id) if item[0].get("character") in visible]


def animatic_frame(shot):
    """Still a shot shows in the animatic: its approved keyframe, else a non-rejected storyboard."""
    keyframe, storyboard = shot.get("keyframe"), shot.get("storyboard")
    if keyframe and keyframe["status"] == "approved":
        return keyframe["path"]
    if storyboard and storyboard["status"] != "rejected":
        return storyboard["path"]
    return None


def timecode(seconds):
    millis = int(round(seconds * 1000))
    hours, rem = divmod(millis, 3_600_000)
    minutes, rem = divmod(rem, 60_000)
    secs, millis = divmod(rem, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d}.{millis:03d}"


def file_stem_for(asset_id):
    """Bible files are named after their ID in kebab case: MAI_01 -> mai-01.json."""
    return asset_id.lower().replace("_", "-")


def _read(film, schemas, path, schema_name):
    where = path.relative_to(film.root).as_posix()
    try:
        doc = load_json(path)
    except (OSError, ValueError) as exc:
        film.add("error", "invalid-json", where, str(exc))
        return None
    errors = schemas.validate(doc, schema_name)
    for message in errors:
        film.add("error", "schema", where, message)
    return None if errors else doc


def _index_references(film, owner_id, doc, where):
    for ref in doc.get("references", []):
        if ref["id"] in film.references:
            film.add("error", "duplicate-id", where, f"reference ID {ref['id']} is declared twice")
        film.references[ref["id"]] = (owner_id, ref)


def _register(film, doc, path, table):
    where = path.relative_to(film.root).as_posix()
    if path.stem != file_stem_for(doc["id"]):
        film.add("error", "file-name", where, f"file must be named {file_stem_for(doc['id'])}.json for ID {doc['id']}")
    if doc["id"] in film.characters or doc["id"] in film.assets:
        film.add("error", "duplicate-id", where, f"bible ID {doc['id']} is declared twice")
        return
    table[doc["id"]] = doc
    _index_references(film, doc["id"], doc, where)


def load_film(root, schemas=None):
    """Read every production-graph document under root; return a Film with findings."""
    schemas = schemas or SchemaSet()
    film = Film(root=Path(root).resolve())
    project_path = film.root / "project.json"
    if not project_path.is_file():
        film.add("error", "missing", "project.json", "not a film project: project.json is missing")
        return film
    film.project = _read(film, schemas, project_path, "project.schema.json")
    if film.project is None:
        return film

    beat_path = film.root / "beat-sheet.json"
    if beat_path.is_file():
        film.beats = _read(film, schemas, beat_path, "beat-sheet.schema.json")
    else:
        film.add("warning", "missing", "beat-sheet.json", "no beat sheet; scenes have no recorded narrative purpose")

    for path in sorted((film.root / "bibles" / "characters").glob("*.json")):
        doc = _read(film, schemas, path, "character.schema.json")
        if doc:
            _register(film, doc, path, film.characters)
    for folder, kind in BIBLE_DIRS.items():
        for path in sorted((film.root / "bibles" / folder).glob("*.json")):
            doc = _read(film, schemas, path, "bible-asset.schema.json")
            if not doc:
                continue
            if doc["kind"] != kind:
                film.add("error", "wrong-kind", path.relative_to(film.root).as_posix(),
                         f"bibles/{folder}/ holds kind {kind!r}, found {doc['kind']!r}")
                continue
            _register(film, doc, path, film.assets)

    _load_scenes(film, schemas)
    _load_audio(film, schemas)
    return film


def _load_scenes(film, schemas):
    declared = set(film.project["scenes"])
    if not declared:
        film.add("warning", "empty", "project.json", "no scenes yet; break the screenplay down before planning shots")
    scenes_dir = film.root / "scenes"
    for scene_id in film.project["scenes"]:
        path = scenes_dir / scene_id / "scene.json"
        if not path.is_file():
            film.add("error", "missing", f"scenes/{scene_id}/scene.json", "scene listed in project.json has no scene.json")
            continue
        scene = _read(film, schemas, path, "scene.schema.json")
        if not scene:
            continue
        if scene["scene_id"] != scene_id:
            film.add("error", "id-mismatch", f"scenes/{scene_id}/scene.json", f"scene_id {scene['scene_id']} does not match its folder")
            continue
        film.scenes[scene_id] = scene
        for shot_id in scene["shots"]:
            shot_path = scenes_dir / scene_id / "shots" / shot_id / "shot.json"
            where = shot_path.relative_to(film.root).as_posix()
            if not shot_id.startswith(scene_id + "_"):
                film.add("error", "id-mismatch", where, f"shot {shot_id} does not belong to scene {scene_id}")
                continue
            if not shot_path.is_file():
                film.add("error", "missing", where, "shot listed in scene.json has no shot.json")
                continue
            shot = _read(film, schemas, shot_path, "shot.schema.json")
            if not shot:
                continue
            if shot["shot_id"] != shot_id or shot["scene_id"] != scene_id:
                film.add("error", "id-mismatch", where, "shot_id/scene_id do not match the folder layout")
                continue
            film.shots[shot_id] = shot
        listed = set(scene["shots"])
        for orphan in sorted(p.name for p in (scenes_dir / scene_id / "shots").glob("*") if p.is_dir()):
            if orphan not in listed:
                film.add("warning", "orphan", f"scenes/{scene_id}/shots/{orphan}", "shot folder is not listed in scene.json")
    for orphan in sorted(p.name for p in scenes_dir.glob("*") if p.is_dir()):
        if orphan not in declared:
            film.add("warning", "orphan", f"scenes/{orphan}", "scene folder is not listed in project.json")


def _load_audio(film, schemas):
    cues_path = film.root / "audio" / "cues.json"
    if not cues_path.is_file():
        film.add("warning", "missing", "audio/cues.json", "no audio cue list; dialogue timing and stems are unplanned")
        return
    doc = _read(film, schemas, cues_path, "audio-cue.schema.json")
    if not doc:
        return
    for cue in doc["cues"]:
        if cue["id"] in film.cues:
            film.add("error", "duplicate-id", "audio/cues.json", f"cue ID {cue['id']} is declared twice")
            continue
        film.cues[cue["id"]] = cue
        if cue["stem"] == "DX" and cue.get("alignment"):
            path = film.root / cue["alignment"]
            if path.is_file():
                alignment = _read(film, schemas, path, "alignment.schema.json")
                if alignment:
                    film.alignments[cue["id"]] = alignment
