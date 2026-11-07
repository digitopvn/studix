"""Knowledge packs loaded on demand, and the FilmSpec / DoD contract from asset to episode.

Knowledge packs live in <skill>/knowledge: index.json lists each pack in one line, and packs/<id>.json holds its
purpose, use cases, anti-patterns, permitted tool roles, checks and references. An agent loads one pack (or one
section of it) for the task at hand instead of reading every reference file.

Every check is one of three kinds, and they are never averaged into one score:
  hard      deterministic: a function here computes it from filmspec.json, or a gate command (`source`, one of
            GATE_COMMANDS, which exit 1 on a failure) does
  evidence  a reviewer attaches evidence (frames, timestamps, measurements), not "looks cinematic"
  human     the user's creative sign-off; taste stays with people

filmspec.json (optional, per episode) is the machine-readable story and shot contract: which packs apply, the look,
setups and payoffs, and per scene its want, stakes, change, room tone and shots (intent, camera, blocking,
performance, wardrobe, physics, sound). Nothing reads it unless `filmspec` is run.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

from .common_io_and_paths import load_json

KNOWLEDGE = Path(__file__).resolve().parents[2] / "knowledge"
LEVELS = ("asset", "shot", "scene", "episode")
KINDS = ("hard", "evidence", "human")
PACK_FIELDS = ("id", "version", "title", "purpose", "load_when", "use_cases", "anti_patterns", "tool_roles", "checks",
               "spec_fields", "references")
SECTIONS = ("purpose", "use_cases", "anti_patterns", "tool_roles", "checks", "references", "registry", "spec_fields")
STATIC_MOVES = ("", "static", "locked")
SOUND_CUTS = ("", "straight", "j", "l")
# commands that exit 1 when their check fails; a command that only prints a measurement backs an evidence check (`tool`)
GATE_COMMANDS = ("validate", "validate-action", "continuity", "assets check")

# DoD per level. Hard checks name the gate command that already computes them; packs add their own checks per level.
DOD_BASE = {
    "asset": [
        {"id": "asset.integrity", "kind": "hard", "source": "assets check", "what": "file exists and hashes to its record"},
        {"id": "asset.refs-resolve", "kind": "hard", "source": "assets check", "what": "every parent and reference resolves"},
        {"id": "asset.provenance", "kind": "evidence", "tool": "assets get", "what": "source (job, prediction or import) is recorded"},
        {"id": "asset.licence", "kind": "evidence", "tool": "assets export-check",
         "what": "licence or consent of imported material is recorded with its source"},
    ],
    "shot": [
        {"id": "shot.edl-valid", "kind": "hard", "source": "validate", "what": "EDL row valid: timing inside the scene, files exist"},
        {"id": "shot.boundary", "kind": "hard", "source": "validate", "what": "join contract with the previous shot: axis, hands, mode"},
        {"id": "shot.continuity", "kind": "hard", "source": "continuity", "what": "no definite continuity break at the cut"},
        {"id": "shot.technical-qa", "kind": "evidence", "what": "two QA reviewers: anatomy, props, artefacts, with frames"},
        {"id": "shot.intent-read", "kind": "evidence", "what": "the shot's intent from filmspec reads in the frames"},
    ],
    "scene": [
        {"id": "scene.change", "kind": "hard", "fn": "scene-change", "what": "filmspec names what changes in the scene"},
        {"id": "scene.silent-story", "kind": "evidence", "what": "muted playback: the change still reads from picture alone"},
        {"id": "scene.signoff", "kind": "human", "what": "the user accepts the emotional and narrative change"},
    ],
    "episode": [
        {"id": "episode.loudness", "kind": "evidence", "tool": "loudness", "what": "master within the delivery loudness target"},
        {"id": "episode.deliverables", "kind": "evidence", "tool": "status", "what": "every gate approved, renders and subtitles present"},
        {"id": "episode.consistency", "kind": "evidence", "what": "characters, sets and look hold across scenes, with a contact sheet"},
        {"id": "episode.appeal", "kind": "human", "what": "the user signs off the episode"},
    ],
}


def _d(x) -> dict:
    return x if isinstance(x, dict) else {}


def _l(x) -> list:
    return x if isinstance(x, list) else []


def _s(x) -> str:
    return x.strip() if isinstance(x, str) else ""


def _scenes(spec: dict) -> list[dict]:
    return [s for s in _l(spec.get("scenes")) if isinstance(s, dict)]


def _shots(spec: dict):
    for sc in _scenes(spec):
        for sh in _l(sc.get("shots")):
            if isinstance(sh, dict):
                yield sc, sh


def _scene_change(spec, order):
    return [f"{sc.get('id')}: no `change` (what is different at the end of the scene)" for sc in _scenes(spec) if not _s(sc.get("change"))]


def _payoff_setup(spec, order):
    """Every payoff names a setup that comes no later; order is episode.json's scene order when known."""
    pos = {sid: i for i, sid in enumerate(order) if isinstance(sid, str)}
    setups = [s for s in _l(spec.get("setups")) if isinstance(s, dict)]
    payoffs = [p for p in _l(spec.get("payoffs")) if isinstance(p, dict)]
    by_id = {s["id"]: s for s in setups if _s(s.get("id"))}
    out = [f"setup #{i + 1}: no `id`" for i, s in enumerate(setups) if not _s(s.get("id"))]
    for p in payoffs:
        s = by_id.get(p.get("setup")) if _s(p.get("setup")) else None
        if not s:
            out.append(f"payoff {p.get('id')}: setup {p.get('setup')!r} is not in setups")
            continue
        unknown = [x for x in (s.get("scene"), p.get("scene")) if not isinstance(x, str) or x not in pos]
        if unknown:
            out.append(f"payoff {p.get('id')}: scene {', '.join(map(repr, unknown))} is not in the episode")
        elif pos[p["scene"]] < pos[s["scene"]]:
            out.append(f"payoff {p.get('id')}: comes in {p['scene']}, before its setup in {s['scene']}")
    paid = {p.get("setup") for p in payoffs if isinstance(p.get("setup"), str)}
    out += [f"setup {sid}: no payoff (add one, or `payoff_later` with the episode)" for sid, s in by_id.items()
            if sid not in paid and not s.get("payoff_later")]
    return out


def _motivated_move(spec, order):
    return [f"{sc.get('id')}/{sh.get('id')}: camera moves ({_d(sh.get('camera')).get('move')}) with no motivation"
            for sc, sh in _shots(spec)
            if _s(_d(sh.get("camera")).get("move")).lower() not in STATIC_MOVES and not _s(_d(sh.get("camera")).get("motivation"))]


def _lens_recorded(spec, order):
    out = []
    for sc, sh in _shots(spec):
        cam = _d(sh.get("camera"))
        if not _s(cam.get("size")) or not (cam.get("lens_mm") or cam.get("fov")):
            out.append(f"{sc.get('id')}/{sh.get('id')}: camera needs `size` and `lens_mm` or `fov`")
    return out


def _subtext(spec, order):
    out = []
    for sc, sh in _shots(spec):
        perf = _d(sh.get("performance"))
        hidden = _s(perf.get("hidden")).lower()
        if hidden and hidden == _s(perf.get("surface")).lower():
            out.append(f"{sc.get('id')}/{sh.get('id')}: hidden emotion repeats the surface one; drop it or name the subtext")
    return out


def _wardrobe_event(spec, order):
    out, last = [], {}
    for sc, sh in _shots(spec):
        for who, w in _d(sh.get("wardrobe")).items():
            w = _d(w)
            look = _s(w.get("look"))
            if look and who in last and last[who] != look and not _s(w.get("event")):
                out.append(f"{sc.get('id')}/{sh.get('id')}: {who} changes look ({last[who]} -> {look}) with no `event`")
            if look:
                last[who] = look
    return out


def _physics_exception(spec, order):
    return [f"{sc.get('id')}/{sh.get('id')}: stylised exception {p.get('exception')!r} has no `reason`"
            for sc, sh in _shots(spec) for p in map(_d, _l(sh.get("physics"))) if p.get("exception") and not _s(p.get("reason"))]


def _room_tone(spec, order):
    return [f"{sc.get('id')}: no `room_tone` (the bed under dialogue and cuts)" for sc in _scenes(spec) if not _s(sc.get("room_tone"))]


def _sound_cut(spec, order):
    return [f"{sc.get('id')}/{sh.get('id')}: sound.cut {_d(sh.get('sound')).get('cut')!r} is not one of J, L, straight"
            for sc, sh in _shots(spec) if _s(_d(sh.get("sound")).get("cut")).lower() not in SOUND_CUTS]


def _look_in_registry(spec, order):
    look = _s(_d(spec.get("look")).get("style"))
    styles = {r["id"] for r in pack("art-direction").get("registry", [])}
    if not look:
        return ["no `look.style` (an art-direction registry id)"]
    return [] if look in styles else [f"look.style {look!r} is not in the art-direction registry ({', '.join(sorted(styles))})"]


HARD_CHECKS = {"scene-change": _scene_change, "payoff-setup": _payoff_setup, "motivated-move": _motivated_move,
               "lens-recorded": _lens_recorded, "subtext": _subtext, "wardrobe-event": _wardrobe_event,
               "physics-exception": _physics_exception, "room-tone": _room_tone, "sound-cut": _sound_cut,
               "look-in-registry": _look_in_registry}


def _index_rows() -> list:
    return _l(_d(load_json(KNOWLEDGE / "index.json")).get("packs"))


def index() -> list[dict]:
    """Index rows that can be used: objects with a string id (`knowledge lint` reports the others)."""
    return [r for r in _index_rows() if isinstance(r, dict) and _s(r.get("id"))]


def _pack_file(row: dict) -> Path:
    """The pack's file, which must lie inside the knowledge folder."""
    f = (KNOWLEDGE / str(row.get("file") or "")).resolve()
    if not f.is_relative_to(KNOWLEDGE.resolve()) or f == KNOWLEDGE.resolve():
        raise ValueError(f"{row.get('file')!r} is not a file inside {KNOWLEDGE}")
    return f


def pack(pid: str) -> dict:
    row = next((r for r in index() if r.get("id") == pid), None)
    if not row:
        raise SystemExit(f"no knowledge pack {pid!r} (have: {', '.join(str(r.get('id')) for r in index())})")
    try:
        p = load_json(_pack_file(row))
    except (OSError, ValueError) as e:
        raise SystemExit(f"cannot read pack {pid!r} ({e}); `knowledge lint` checks every pack") from None
    if not isinstance(p, dict) or not isinstance(p.get("checks", []), list):
        raise SystemExit(f"pack {pid!r} is not a pack object; `knowledge lint` checks every pack")
    return p


def for_task(words: list[str]) -> list[dict]:
    """Packs whose load_when terms appear as whole words (or their plural) in the task words, most matches first.
    Hyphens count as spaces, so `close-up` matches `close up`."""
    text = " ".join(words).lower().replace("-", " ")
    hits = []
    for row in index():
        terms = [t.lower().replace("-", " ").strip() for t in _l(row.get("load_when")) if isinstance(t, str) and t.strip()]
        n = sum(1 for t in terms if re.search(rf"\b{re.escape(t)}(e?s)?\b", text))
        if n:
            hits.append((n, row))
    return [r for _, r in sorted(hits, key=lambda x: -x[0])]


def _sections(p: dict, sections: list[str] | None) -> list[str]:
    for sec in sections or []:
        if sec not in SECTIONS or sec not in p:
            raise SystemExit(f"pack {p.get('id')} has no section {sec!r} (have: {', '.join(s for s in SECTIONS if s in p)})")
    return sections or [s for s in SECTIONS if s in p]


def render(p: dict, sections: list[str] | None = None) -> str:
    """Compact text of a pack, or only the named sections."""
    lines = [f"# {p['title']} ({p['id']} v{p['version']})"]
    for sec in _sections(p, sections):
        v = p[sec]
        lines.append(f"## {sec}")
        if isinstance(v, str):
            lines.append(v)
        elif sec == "checks":
            lines += [f"- [{c['kind']}] {c['id']} ({c['level']}): {c['measure']} -> pass: {c['pass']}"
                      + (f"  <- {c.get('source') or c.get('tool')}" if c.get("source") or c.get("tool") else "") for c in v]
        elif sec == "registry":
            for r in v:
                lines.append(f"- {r['id']}: " + "; ".join(f"{k} {x}" for k, x in r.items() if k != "id"))
        elif isinstance(v, dict):
            lines += [f"- {k}: {', '.join(x)}" for k, x in v.items()]
        else:
            lines += [f"- {x}" for x in v]
    return "\n".join(lines)


def _lint_check(where: str, c, seen: set, err: list[str]) -> None:
    if not isinstance(c, dict):
        err.append(f"{where}: every check must be an object")
        return
    cid = c.get("id")
    if not _s(cid):
        err.append(f"{where}: a check has no string id")
    elif cid in seen:
        err.append(f"{where}: duplicate check id {cid}")
    else:
        seen.add(cid)
    if c.get("kind") not in KINDS:
        err.append(f"{where}: check {cid} needs kind ({'/'.join(KINDS)})")
    if c.get("fn") is not None and not isinstance(c["fn"], str):
        err.append(f"{where}: check {cid} fn must be a string")
    elif c.get("fn") and c["fn"] not in HARD_CHECKS:
        err.append(f"{where}: check {cid} names fn {c['fn']!r}, which is not computed here ({', '.join(HARD_CHECKS)})")
    if c.get("source") and (not isinstance(c["source"], str) or c["source"] not in GATE_COMMANDS):
        err.append(f"{where}: check {cid} source {c['source']!r} is not a gate command ({', '.join(GATE_COMMANDS)}); "
                   "a command that only measures goes in `tool` on an evidence check")
    if c.get("kind") == "hard" and not (c.get("fn") or c.get("source")):
        err.append(f"{where}: hard check {cid} names no computed fn or gate command")
    if c.get("kind") != "hard" and (c.get("fn") or c.get("source")):
        err.append(f"{where}: check {cid} is {c.get('kind')} but names a fn or gate command: make it hard")


def lint() -> list[str]:
    """Every pack is complete, its checks are well formed, and every hard check is really computed somewhere: by a
    function here or by a command that exits 1 on a failure."""
    err, seen, ids = [], set(), set()
    for lv, checks in DOD_BASE.items():
        for c in checks:
            _lint_check(f"base {lv}", c, seen, err)
    for row in _index_rows():
        if not isinstance(row, dict):
            err.append(f"index: every pack row must be an object, not {row!r}")
            continue
        rid = row.get("id")
        if not _s(rid):
            err.append(f"index: a pack row has no string id ({row.get('file')})")
        elif rid in ids:
            err.append(f"index: duplicate pack id {rid}")
        else:
            ids.add(rid)
        for k in ("id", "file", "version", "summary", "load_when"):
            if not row.get(k):
                err.append(f"index {rid}: no {k}")
        if any(not _s(t) for t in _l(row.get("load_when"))):
            err.append(f"index {rid}: every load_when term must be a non-empty string")
        try:
            p = load_json(_pack_file(row))
        except (OSError, ValueError) as e:
            err.append(f"{rid}: cannot read {row.get('file')} ({e})")
            continue
        if not isinstance(p, dict):
            err.append(f"{rid}: {row.get('file')} must be a JSON object")
            continue
        err += [f"{rid}: no {k}" for k in PACK_FIELDS if not p.get(k)]
        if p.get("id") != rid or p.get("version") != row.get("version"):
            err.append(f"{rid}: id/version differ between index.json and {row.get('file')}")
        for c in _l(p.get("checks")):
            _lint_check(str(rid), c, seen, err)
            if isinstance(c, dict) and (c.get("level") not in LEVELS or not c.get("measure") or not c.get("pass")):
                err.append(f"{rid}: check {c.get('id')} needs level ({'/'.join(LEVELS)}), measure and pass")
        for r in _l(p.get("references")):
            if not isinstance(r, str):
                err.append(f"{rid}: reference {r!r} must be a string")
                continue
            f = KNOWLEDGE.parent / r.split("#", 1)[0]
            if not r.startswith("http") and not f.is_file():
                err.append(f"{rid}: reference {r} does not exist")
    return err


def _known_packs(packs) -> list[str]:
    known = {r.get("id") for r in index()}
    return [p for p in _l(packs) if isinstance(p, str) and p in known]


def dod_checklist(level: str, packs: list[str] | None = None) -> list[dict]:
    """The checks a `level` item must pass: the base DoD plus the checks of the packs the spec applies (packs that are
    not installed are skipped; `filmspec` reports them)."""
    if level not in LEVELS:
        raise SystemExit(f"level must be one of {', '.join(LEVELS)}")
    out = [dict(c, pack=None) for c in DOD_BASE[level]]
    for pid in _known_packs(packs):
        out += [dict(c, pack=pid) for c in pack(pid)["checks"] if c["level"] == level]
    return out


def spec_path(episode_dir: Path) -> Path:
    return episode_dir / "filmspec.json"


def _json(p: Path, what: str):
    try:
        return load_json(p)
    except OSError:
        raise SystemExit(f"no {what} at {p}") from None
    except ValueError as e:
        raise SystemExit(f"{p} is not valid JSON ({e})") from None


def _edl_ids(edl_p: Path) -> list | None:
    """Shot ids of a scene EDL, or None when it is missing, unreadable or has no `shots` list."""
    try:
        shots = load_json(edl_p).get("shots", [])
    except (OSError, ValueError, AttributeError):
        return None
    return [s.get("id") for s in shots if isinstance(s, dict)] if isinstance(shots, list) else None


def init_spec(episode_dir: Path) -> dict:
    """A skeleton from episode.json and the scene EDLs; the creative fields stay empty for people to fill."""
    ep = _json(episode_dir / "episode.json", "episode.json")
    scenes = []
    for sc in _l(ep.get("scenes")):
        ids = _edl_ids(episode_dir / "scenes" / str(sc) / "edl.json") or []
        scenes.append({"id": sc, "want": "", "stakes": "", "change": "", "room_tone": "", "motif": "",
                       "shots": [{"id": i, "intent": "", "camera": {"size": "", "lens_mm": None, "height": "", "move": "",
                                                                     "motivation": ""},
                                  "blocking": "", "performance": {"surface": "", "hidden": ""}} for i in ids]})
    return {"version": 1, "episode": episode_dir.name, "packs": [r["id"] for r in index()], "logline": "", "arc": "",
            "look": {"style": ""}, "setups": [], "payoffs": [], "scenes": scenes}


SHOT_TYPES = {"camera": dict, "performance": dict, "wardrobe": dict, "physics": list, "sound": dict}
FIELD_TYPES = {("camera", "move"): str, ("camera", "lens_mm"): (int, float), ("camera", "fov"): (int, float),
               ("sound", "cut"): str, ("performance", "surface"): str, ("performance", "hidden"): str}


def validate_spec(spec: dict, episode_dir: Path | None = None) -> tuple[list[str], list[str]]:
    """Structure and field types, plus scene and shot ids against episode.json and the EDLs. -> (errors, warnings)."""
    err, warn = [], []
    if not isinstance(spec, dict):
        return ["filmspec must be a JSON object"], warn
    if spec.get("version") != 1:
        err.append("version must be 1")
    for k, t in (("packs", list), ("look", dict), ("setups", list), ("payoffs", list)):
        if k in spec and not isinstance(spec[k], t):
            err.append(f"{k} must be a {t.__name__}")
    known = {r.get("id") for r in index()}
    err += [f"packs: unknown pack {p!r}" for p in _l(spec.get("packs")) if not isinstance(p, str) or p not in known]
    for k in ("setups", "payoffs"):
        err += [f"{k}: every entry must be an object" for x in _l(spec.get(k)) if not isinstance(x, dict)][:1]
        for x in _l(spec.get(k)):
            for f in ("id", "scene", "setup") if k == "payoffs" else ("id", "scene"):
                if isinstance(x, dict) and x.get(f) is not None and not isinstance(x[f], str):
                    err.append(f"{k}: {f} {x[f]!r} must be a string")
    sids = [x.get("id") for x in _l(spec.get("setups")) if isinstance(x, dict) and _s(x.get("id"))]
    err += [f"setups: duplicate id {i}" for i in sorted({i for i in sids if sids.count(i) > 1})]
    if not isinstance(spec.get("scenes"), list):
        return err + ["scenes must be a list"], warn
    for sc in spec["scenes"]:
        if not isinstance(sc, dict) or not _s(sc.get("id")):
            err.append("every scene needs a string id")
            continue
        if "shots" in sc and not isinstance(sc["shots"], list):
            err.append(f"{sc['id']}: shots must be a list")
        for sh in _l(sc.get("shots")):
            if not isinstance(sh, dict) or not sh.get("id"):
                err.append(f"{sc['id']}: every shot needs an id")
                continue
            for k, t in SHOT_TYPES.items():
                if sh.get(k) is not None and not isinstance(sh[k], t):
                    err.append(f"{sc['id']}/{sh['id']}: {k} must be a {t.__name__}")
            for (k, f), t in FIELD_TYPES.items():
                v = _d(sh.get(k)).get(f)
                if v is not None and (not isinstance(v, t) or isinstance(v, bool)):
                    err.append(f"{sc['id']}/{sh['id']}: {k}.{f} must be a {'number' if t != str else 'string'}")
            if any(not isinstance(w, dict) for w in _d(sh.get("wardrobe")).values()):
                err.append(f"{sc['id']}/{sh['id']}: wardrobe is {{character: {{look, event}}}}")
            if any(not isinstance(p, dict) for p in _l(sh.get("physics"))):
                err.append(f"{sc['id']}/{sh['id']}: physics is a list of {{what, exception, reason}}")
            if not _s(sh.get("intent")):
                warn.append(f"{sc['id']}/{sh['id']}: no intent (what the shot must make the audience feel or learn)")
    if episode_dir:
        ep, bad = _episode(episode_dir)
        if bad:
            err.append(bad)
        have = [sc["id"] for sc in _scenes(spec) if _s(sc.get("id"))]
        warn += [f"scene {s} is in episode.json but not in filmspec" for s in _l(ep.get("scenes")) if s not in have]
        warn += [f"scene {s} is in filmspec but not in episode.json" for s in have if ep and s not in _l(ep.get("scenes"))]
        for sc in _scenes(spec):
            if not _s(sc.get("id")):
                continue
            edl = episode_dir / "scenes" / sc["id"] / "edl.json"
            ids = _edl_ids(edl)
            if ids is None and edl.exists():
                warn.append(f"{sc['id']}: cannot read the shots of {edl}; shot ids not checked")
            if ids is not None:
                warn += [f"{sc['id']}/{sh.get('id')}: not in the scene EDL" for sh in _l(sc.get("shots"))
                         if isinstance(sh, dict) and sh.get("id") not in ids]
    return err, warn


def _episode(episode_dir: Path) -> tuple[dict, str | None]:
    """episode.json as a dict ({} when absent), plus an error when it exists but cannot be used."""
    p = episode_dir / "episode.json"
    if not p.exists():
        return {}, None
    try:
        ep = load_json(p)
    except (OSError, ValueError) as e:
        return {}, f"episode.json cannot be read ({e}); scene order falls back to the filmspec"
    if not isinstance(ep, dict):
        return {}, "episode.json must be a JSON object; scene order falls back to the filmspec"
    return ep, None


def run_hard_checks(spec: dict, episode_dir: Path | None = None) -> list[dict]:
    """The computed hard checks of the base DoD and of every installed pack the spec applies.
    Scene order comes from episode.json when the episode is given, else from the spec. -> [{id, pack, level, failures}]."""
    order = [s for s in _l(_episode(episode_dir)[0].get("scenes")) if isinstance(s, str)] if episode_dir else []
    order = order or [sc.get("id") for sc in _scenes(spec) if isinstance(sc.get("id"), str)]
    rows = [{"id": c["id"], "pack": None, "level": lv, "fn": c["fn"]} for lv in LEVELS for c in DOD_BASE[lv] if c.get("fn")]
    for pid in _known_packs(spec.get("packs")):
        rows += [{"id": c["id"], "pack": pid, "level": c["level"], "fn": c["fn"]} for c in pack(pid)["checks"]
                 if c["kind"] == "hard" and c.get("fn") in HARD_CHECKS]
    seen, out = set(), []
    for r in rows:
        if r["fn"] in seen:
            continue  # the same function behind a base check and a pack check runs once
        seen.add(r["fn"])
        out.append({"id": r["id"], "pack": r["pack"], "level": r["level"], "failures": HARD_CHECKS[r["fn"]](spec, order)})
    return out


def register(add, O) -> None:
    add("knowledge", O("action", choices=("list", "show", "for", "lint")), O("words", nargs="*", help="show: pack id; for: task words"),
        O("--section", action="append", help=f"show: only these sections ({', '.join(SECTIONS)})"), O("--json", action="store_true"),
        help="knowledge packs, loaded on demand: list, show <id>, for <task words>, lint")
    add("filmspec", "episode", O("--init", action="store_true", help="write a skeleton filmspec.json (never overwrites)"),
        O("--checklist", choices=LEVELS, help="print the DoD checklist for a level"), O("--json", action="store_true"),
        help="FilmSpec story/shot contract: validate and run the computed hard checks")


def run(a) -> bool:
    if a.cmd == "knowledge":
        if a.action == "list":
            rows = index()
            print(json.dumps(rows, indent=2) if a.json else "\n".join(
                f"{r['id']:<14} v{r['version']}  {r['summary']}  [load when: {', '.join(r['load_when'][:6])}]" for r in rows))
        elif a.action == "show":
            if len(a.words) != 1:
                raise SystemExit("knowledge show <pack id>")
            p = pack(a.words[0])
            secs = _sections(p, a.section)
            print(json.dumps({k: p[k] for k in secs} if a.section else p, ensure_ascii=False, indent=2) if a.json
                  else render(p, a.section))
        elif a.action == "for":
            rows = for_task(a.words)
            print("\n".join(f"{r['id']}: {r['summary']}" for r in rows) or "no pack matches; `knowledge list` shows them all")
        else:
            err = lint()
            print("\n".join(f"ERROR {x}" for x in err) or f"{len(index())} packs ok")
            raise SystemExit(1 if err else 0)
        return True
    if a.cmd == "filmspec":
        e = Path(a.episode).expanduser().resolve()
        if a.checklist:
            spec = _d(_json(spec_path(e), "filmspec.json")) if spec_path(e).exists() else {}
            packs = _l(spec.get("packs"))
            unknown = [p for p in packs if p not in _known_packs(packs)]
            if spec.get("packs") is not None and not isinstance(spec["packs"], list):
                unknown.append(spec["packs"])  # `packs` must be a list; a bare id is not applied
            if unknown:
                print(f"filmspec names packs that are not installed: {', '.join(map(repr, unknown))}", file=sys.stderr)
            rows = dod_checklist(a.checklist, packs)
            print(json.dumps(rows, indent=2) if a.json else "\n".join(
                f"[{c['kind']}] {c['id']}{' (' + c['pack'] + ')' if c['pack'] else ''}: {c.get('what') or c.get('measure')}"
                + (f"  <- {c.get('source') or c.get('tool')}" if c.get("source") or c.get("tool") else "") for c in rows))
            if unknown:
                raise SystemExit(1)
            return True
        if a.init:
            body = json.dumps(init_spec(e), ensure_ascii=False, indent=2) + "\n"
            try:
                with spec_path(e).open("x", encoding="utf-8") as f:
                    f.write(body)
            except FileExistsError:
                raise SystemExit(f"{spec_path(e)} exists; edit it instead") from None
            print(f"wrote {spec_path(e)}")
        if not spec_path(e).exists():
            raise SystemExit(f"no {spec_path(e)}: run `filmspec {a.episode} --init` for a skeleton")
        spec = _json(spec_path(e), "filmspec.json")
        err, warn = validate_spec(spec, e)
        checks = run_hard_checks(spec, e) if isinstance(spec, dict) else []
        if a.json:
            print(json.dumps({"errors": err, "warnings": warn, "checks": checks}, ensure_ascii=False, indent=2))
        else:
            print("\n".join([f"ERROR {x}" for x in err] + [f"warn  {x}" for x in warn]))
            for c in checks:
                print(f"{'FAIL' if c['failures'] else 'pass'} {c['id']}" + "".join(f"\n       {x}" for x in c["failures"]))
            n = sum(1 for c in checks if c["failures"])
            print(f"{len(err)} errors, {len(warn)} warnings, {n} of {len(checks)} hard checks failing")
        raise SystemExit(1 if err or any(c["failures"] for c in checks) else 0)
    return False
