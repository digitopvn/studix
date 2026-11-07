"""Create and locate series / episode / scene projects.

<root>/<series>/
  studio.json                  series manifest (title, style, fps, aspect, languages)
  bible/                       series bible, characters/<id>.json, sets/<id>.json, style.json, refs/
  story/                       story-so-far.md (rolling digest), continuity.json (state at each episode end)
  engine/                      shared film engine (src/, vendor/three, build-scene.sh)
  episodes/epNN/
    episode.json               scenes, target length, budget ceiling, gate status
    scope-lock.md              the contract the user signed at G0
    gen-plan.json              every paid generation job (keyframes, video, upscale, audio)
    scenes/scNN/               one HyperFrames project per scene (edl.json, src/, assets/, clips/)
    gen/ trimmed/ upscaled/ audio/ renders/ logs/ reports/
  runs.jsonl                   one summary row per finished run (cost, tokens, scores, lessons)
"""
from __future__ import annotations

import shutil
import urllib.request
from pathlib import Path

from .common_io_and_paths import ENGINE_ASSET, TEMPLATES, load_json, now_iso, save_json

THREE_VERSION = "0.180.0"
THREE_FILES = ("three.module.js", "three.core.js")
FONT_URL = "https://github.com/google/fonts/raw/main/ofl/bevietnampro/BeVietnamPro-SemiBold.ttf"
EPISODE_DIRS = ("gen/keyframes", "gen/video", "gen/audio", "trimmed", "upscaled", "audio/sfx", "audio/vo", "audio/mus",
                "renders", "logs", "reports", "scenes")


def _fetch(url: str, dest: Path) -> bool:
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "curl/8.7.1"})
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(urllib.request.urlopen(req, timeout=60).read())
        return True
    except OSError as e:  # offline: the caller reports what is missing
        print(f"  could not fetch {url}: {e}")
        return False


def install_engine(series_dir: Path, *, fetch: bool = True, three_from: Path | None = None) -> Path:
    """Copy the engine into the series and vendor three.js (copied from a local dir, else jsdelivr)."""
    eng = series_dir / "engine"
    shutil.copytree(ENGINE_ASSET / "engine", eng, dirs_exist_ok=True)
    (eng / "build-scene.sh").chmod(0o755)
    vendor = eng / "vendor"
    vendor.mkdir(exist_ok=True)
    for f in THREE_FILES:
        if (vendor / f).exists():
            continue
        if three_from and (three_from / f).exists():
            shutil.copy2(three_from / f, vendor / f)
        elif fetch:
            _fetch(f"https://cdn.jsdelivr.net/npm/three@{THREE_VERSION}/build/{f}", vendor / f)
    return eng


def init_series(root: Path, slug: str, *, title: str = "", fps: int = 24, aspect: str = "16:9", languages=("vi",),
                fetch: bool = True, three_from: Path | None = None) -> Path:
    s = root / slug
    for d in ("bible/characters", "bible/sets", "bible/refs", "story", "episodes"):
        (s / d).mkdir(parents=True, exist_ok=True)
    if not (s / "studio.json").exists():
        save_json(s / "studio.json", {"slug": slug, "title": title or slug, "fps": fps, "aspect": aspect, "width": 1920, "height": 1080,
                                       "languages": list(languages), "created": now_iso(), "engine": THREE_VERSION})
    for name, dest in (("series-bible.md", "bible/series-bible.md"), ("character.example.json", "bible/characters/_example.json"),
                       ("set.example.json", "bible/sets/_example.json"), ("style.json", "bible/style.json"),
                       ("story-so-far.md", "story/story-so-far.md"), ("continuity.json", "story/continuity.json")):
        if not (s / dest).exists():
            shutil.copy2(TEMPLATES / name, s / dest)
    install_engine(s, fetch=fetch, three_from=three_from)
    return s


def init_episode(series_dir: Path, ep: str, *, target_seconds: float = 15.0, ceiling_usd: float = 4.0) -> Path:
    e = series_dir / "episodes" / ep
    for d in EPISODE_DIRS:
        (e / d).mkdir(parents=True, exist_ok=True)
    if not (e / "episode.json").exists():
        save_json(e / "episode.json", {"episode": ep, "target_seconds": target_seconds, "ceiling_usd": ceiling_usd, "scenes": [],
                                        "gates": {g: "pending" for g in ("G0-scope", "G1-designs", "G2-animatic", "G3-rough-cut", "G4-final")},
                                        "created": now_iso()})
    for name, dest in (("scope-lock.md", "scope-lock.md"), ("gen-plan.example.json", "gen-plan.json"),
                       ("mix-events.example.json", "audio/mix-events.json"), ("music-plan.example.json", "audio/mus/plan.json")):
        if not (e / dest).exists():
            shutil.copy2(TEMPLATES / name, e / dest)
    (e / "logs" / "predictions.log").touch()
    return e


def init_scene(episode_dir: Path, scene: str, *, fetch_font: bool = True) -> Path:
    sc = episode_dir / "scenes" / scene
    shutil.copytree(ENGINE_ASSET / "scene-template", sc, dirs_exist_ok=True)
    for d in ("assets/set", "assets/cels", "assets/cards", "assets/fonts", "clips", "dist"):
        (sc / d).mkdir(parents=True, exist_ok=True)
    font = sc / "assets/fonts/BeVietnamPro-SemiBold.ttf"
    if fetch_font and not font.exists():
        _fetch(FONT_URL, font)
    ep = load_json(episode_dir / "episode.json")
    if scene not in ep["scenes"]:
        ep["scenes"].append(scene)
        save_json(episode_dir / "episode.json", ep)
    return sc


def engine_dir_for(scene_dir: Path) -> Path:
    """<series>/episodes/<ep>/scenes/<sc> -> <series>/engine"""
    return scene_dir.resolve().parents[3] / "engine"


def set_gate(episode_dir: Path, gate: str, status: str, note: str = "") -> dict:
    ep = load_json(episode_dir / "episode.json")
    key = next((g for g in ep["gates"] if g == gate or g.startswith(gate + "-")), None)
    if not key:
        raise SystemExit(f"unknown gate {gate}; known: {', '.join(ep['gates'])}")
    ep["gates"][key] = status
    ep.setdefault("gate_log", []).append({"gate": key, "status": status, "note": note, "ts": now_iso()})
    save_json(episode_dir / "episode.json", ep)
    return ep
