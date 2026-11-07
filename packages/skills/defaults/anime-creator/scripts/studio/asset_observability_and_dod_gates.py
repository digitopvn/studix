"""Asset observability and DoD gate records. Both only read the pipeline's files; nothing is generated or deleted.

observe        catalog health for a series, per episode and in total:
               time-to-find  ms of the first catalog load in this process, then the mean of >= 10,000 path lookups
               resolve rate  share of the files the scene EDLs show that resolve to a current catalog record
               duplicates    bytes held more than once by present files with the same sha256
               cache hit     share of current files whose size and mtime match catalog/hash-cache.json (a scan skips them)
               orphans       present files named by nothing: no child in the catalog, no episode JSON (EDL, mix, job
                             refs) and no scene edit page (index.html, *.js); not pinned, rejected, a bible reference
                             or a render. Missing files are counted under `missing` only.
               provenance    generated-role files (keyframe, clip, vo, sfx, music, audio) with no producing job
               licence       files with no producing job and no entry in catalog/licences.json
               jobs          done jobs whose `out` is missing, or exists but is not catalogued
               quarantined   files gc moved to catalog/quarantine/ (count and bytes); like purged and superseded
                             records they are retired: never missing, duplicates or orphans
               --record appends the totals to catalog/metrics.jsonl, so runs can be compared before and after.
context-bytes  bytes of tool results the session transcript took in, per trace phase and per tool: the context an
               agent spent per task (same transcript and phase split as `tokens`).
dod            DoD-1..4 (asset, shot, scene, episode) results in catalog/dod.jsonl, append-only:
               {level, target, check, kind, result: PASS|FAIL|WAIVED, evidence, approver, note, at}.
               PASS and FAIL need evidence (a human check needs its approver instead); WAIVED needs an approver and
               a reason. `status` takes the latest result per check and lists the required checks from the FilmSpec
               checklist when that module is installed; hard, evidence and human results are counted apart, never
               averaged.
"""
from __future__ import annotations

import json
import os
import posixpath
import re
import time
from pathlib import Path
from urllib.parse import unquote

from . import asset_registry_catalog as ac
from .common_io_and_paths import append_jsonl, load_json, now_iso, read_jsonl
from .telemetry_trace_and_ledger import run_events
from .telemetry_tokens_report_insights import _ts, transcript_files

GENERATED_ROLES = ("keyframe", "clip", "vo", "sfx", "music", "audio")
EXEMPT_ROLES = ("identity", "environment", "style", "render")  # references and finals are allowed to have no user
FILE_KEYS = ("src", "src_raw", "img", "pick")
SELF_KEYS = ("out", "outputs")  # a job naming its own output is not a use of it
WALK_SKIP = {"node_modules", "vendor", "__pycache__"}  # dependencies; work/ and logs/ JSON can still name a file
LEVELS = {"asset": 1, "shot": 2, "scene": 3, "episode": 4}
RESULTS = ("PASS", "FAIL", "WAIVED")
KINDS = ("hard", "evidence", "human")
MEDIA_STR = re.compile(r"""["'`]([^"'`\s<>]+?\.(?:%s))(?:[?#][^"'`\s<>]*)?["'`]""" % "|".join(x[1:] for x in ac.MEDIA), re.I)
DIR_KEY = re.compile(r"""(?<![\w$.])["']?dir["']?\s*:\s*(?![\s\[{\d.+-]|true|false|null)""")  # a `dir:` that may
# name a folder, read or not (a vector `dir: [x, y]`, a number or an object is not one)
DIR_STR = re.compile(r"""(?<![\w$.])dir["']?\s*:\s*(["'`])([^"'`\s<>:]+)\1(?!\s*[+.\[(])""")  # a scene config's
# folder for bare names: one whole string literal (not "a" + "b", "a".concat(b), nor a template literal with ${...})
_fold = str.lower if os.name == "nt" else str  # Windows paths match whatever their letter case


def _target(t: str) -> str:
    n = posixpath.normpath(t.replace("\\", "/")).strip("/")
    return "" if n == "." else n


def _rel(series: Path, p: Path) -> str | None:
    """Series-relative path of p, worked out lexically, so a linked folder keeps its in-series spelling (the
    catalog walk follows links and stores that spelling)."""
    try:
        r = Path(os.path.relpath(os.path.normpath(p), os.path.normpath(series))).as_posix()
    except ValueError:  # another drive
        return None
    return None if r == ".." or r.startswith("../") else r


def _first(series: Path, cands: list[Path]) -> str | None:
    """Series-relative path of the first candidate that exists, else of the first one that lies inside the series."""
    rels = [(c.exists(), _rel(series, c)) for c in cands]
    return next((r for ok, r in rels if ok and r), None) or next((r for _, r in rels if r), None)


def scene_dirs(series: Path, ep: Path, bad: list[str]) -> list[Path]:
    """The scene folders of an episode, listed explicitly: a scenes/ folder that cannot be listed goes to bad instead
    of reading as an episode with no scenes."""
    d = ep / "scenes"
    try:
        with os.scandir(d) as it:
            return sorted(Path(e.path) for e in it if e.is_dir())
    except FileNotFoundError:
        return []
    except OSError as e:
        bad.append(f"{_rel(series, d)}: cannot list ({e.__class__.__name__})")
        return []


ENGINE_SRC = Path(__file__).resolve().parents[2] / "assets" / "film-engine" / "engine" / "src"
_engine_names: set[str] | None = None


def engine_names() -> set[str]:
    """Media names the shipped film engine's own code carries, which name no file of a scene: suffixes such as
    ".depth.png", built from a cel's name (checked on its own), that every bundled dist/film.js inlines. A scene
    config's names get no such pass: the engine preloads every set layer and fails without them, so a name no file
    answers at gate time is a file moved away after the render."""
    global _engine_names
    if _engine_names is None:
        _engine_names = set()
        for page in ENGINE_SRC.rglob("*") if ENGINE_SRC.is_dir() else []:
            if page.suffix.lower() in (".html", ".js") and page.is_file():
                _engine_names |= {page_name(v) for v in MEDIA_STR.findall(page.read_text(encoding="utf-8", errors="ignore"))}
    return _engine_names


def page_name(v: str) -> str:
    """A media name as a page spells it, as a path: percent escapes decoded (MEDIA_STR leaves ?query and #fragment out)."""
    return unquote(v)


def scene_pages(series: Path, sd: Path, bad: list[str]):
    """(page, text, bases, dirs_unread) for every *.html and *.js under a scene folder (index.html, src/scene/*.js,
    dist/film.js), skipping dependencies and dot folders and walking each real folder once (a junction loop ends).
    bases are where a name on the page is read from, every one that has it counts: the page's folder, each `dir:` folder the page
    sets (a scene config whose layers are bare names), the scene folder, the episode, the series. dirs_unread counts
    the `dir:` keys whose value is not a plain string literal (a bare name under one cannot be placed). A folder that
    cannot be listed or a page that cannot be read goes to bad."""
    def err(e: OSError) -> None:
        bad.append(f"{_rel(series, Path(e.filename) if e.filename else sd)}: cannot list ({e.__class__.__name__})")

    seen = set()
    for d, dirs, files in os.walk(sd, onerror=err):
        real = os.path.normcase(os.path.realpath(d))
        if real in seen:
            dirs[:] = []
            continue
        seen.add(real)
        dirs[:] = sorted(x for x in dirs if x not in WALK_SKIP and not x.startswith("."))
        for f in sorted(x for x in files if x.lower().endswith((".html", ".js"))):
            page = Path(d) / f
            try:
                text = page.read_text(encoding="utf-8", errors="ignore")
            except OSError as e:
                bad.append(f"{_rel(series, page)}: {e.__class__.__name__}")
                continue
            named = [m.group(2) for m in DIR_STR.finditer(text) if "${" not in m.group(2)]
            yield (page, text, list(dict.fromkeys([page.parent, *(sd / page_name(x) for x in named), sd, sd.parents[1], series])),
                   len(DIR_KEY.findall(text)) - len(named))


def edl_refs(series: Path, bad: list[str]) -> list[dict]:
    """Every file a scene EDL shows: {episode, scene, shot, key, path}. src/src_raw are relative to the episode,
    img/pick to the scene (as the edit page reads them). Unreadable EDLs go to bad."""
    out = []
    for edl_p in sorted(series.glob("episodes/*/scenes/*/edl.json")):
        sd, ep = edl_p.parent, edl_p.parents[2]
        try:
            shots = load_json(edl_p).get("shots")
            if not isinstance(shots, list):  # parsed but shows nothing knowable: not an edit that dropped every shot
                raise ValueError("shots is not a list")
        except (OSError, ValueError, AttributeError) as e:
            bad.append(f"{_rel(series, edl_p)}: {e.__class__.__name__}")
            continue
        for shot in shots:
            if not isinstance(shot, dict):
                continue
            for k in FILE_KEYS:
                v = shot.get(k)
                if isinstance(v, str) and Path(v).suffix.lower() in ac.MEDIA:  # pick can be a note, not a file
                    cands = [ep / v, sd / v] if k in ("src", "src_raw") else [sd / v, ep / v]
                    out.append({"episode": ep.name, "scene": sd.name, "shot": shot.get("id"), "key": k, "path": _first(series, cands)})
    return out


def _strings(node, key=None):
    if isinstance(node, dict):
        for k, v in node.items():
            if k not in SELF_KEYS:
                yield from _strings(v, k)
    elif isinstance(node, list):
        for v in node:
            yield from _strings(v, key)
    elif isinstance(node, str) and Path(node).suffix.lower() in ac.MEDIA:
        yield node


def _norm(series: Path, base: tuple, v: str) -> list[str]:
    """Series-relative spellings v can stand for (episode dir, the JSON's own dir, the series), without touching disk."""
    if os.path.isabs(v):
        try:
            r = os.path.relpath(v, series)
        except ValueError:  # another drive
            return []
        return [] if r.startswith("..") else [Path(r).as_posix()]
    v = v.replace("\\", "/")
    return [posixpath.normpath(posixpath.join(b, v)) for b in base]


def _episode_json(series: Path, bad: list[str] | None = None):
    """JSON files under episodes/*/, following linked folders once (as the catalog walk does). A folder that cannot
    be listed goes to bad, so a caller about to move files never mistakes it for an empty one."""
    seen = set()

    def err(e: OSError) -> None:
        if bad is not None:
            bad.append(f"{_rel(series, Path(e.filename)) if e.filename else 'episodes'}: cannot list ({e.__class__.__name__})")

    try:
        tops = sorted(p for p in (series / "episodes").iterdir() if p.is_dir()) if (series / "episodes").exists() else []
    except OSError as e:
        err(e)
        tops = []
    for top in tops:
        for d, dirs, files in os.walk(top, followlinks=True, onerror=err):
            real = os.path.realpath(d)
            if real in seen:
                dirs[:] = []
                continue
            seen.add(real)
            dirs[:] = [x for x in dirs if x not in WALK_SKIP and not x.startswith(".")]
            yield from (Path(d) / f for f in sorted(files) if f.endswith(".json"))


def named_paths(series: Path, known: set[str], bad: list[str] | None = None, fold=None) -> set[str]:
    """Catalogued media paths that any JSON under episodes/ (EDLs, mixes, job refs; outputs excluded) or a scene
    page (any *.html or *.js under the scene folder) names. A JSON value is read against the file's own folder, then
    the episode folder, then the series root, stopping at the first hit, so one spelling never marks two files. A
    page value marks every catalogued file the bases scene_pages gives hold: two scene sets may reuse one layer
    name, and gc must hold both. EDL shot files are left
    to edl_refs, which reads each key from its own base. A JSON file or edit page that cannot be read goes to bad (a
    caller about to move files must not trust the result then); fold overrides the case folding of path matches."""
    _f = fold or _fold
    fold = {_f(k): k for k in known}
    out = set()

    def take(base: tuple, v: str, every: bool = False) -> None:
        for b in base:
            hit = [fold[_f(r)] for r in _norm(series, (b,), v) if _f(r) in fold]
            out.update(hit)
            if hit and not every:
                return

    for jp in _episode_json(series, bad):
        parts = jp.relative_to(series).parts
        base = ("/".join(parts[:-1]), "/".join(parts[:2]), "")
        try:
            data = json.loads(jp.read_text(encoding="utf-8"))
        except (OSError, ValueError) as e:
            if bad is not None:
                bad.append(f"{_rel(series, jp)}: {e.__class__.__name__}")
            continue
        if jp.name == "edl.json" and isinstance(data, dict) and isinstance(data.get("shots"), list):
            # shot files resolve per key in edl_refs (src from the episode, img/pick from the scene)
            data = dict(data, shots=[{k: v for k, v in sh.items() if k not in FILE_KEYS} if isinstance(sh, dict) else sh
                                     for sh in data["shots"]])
        for v in _strings(data):
            take(base, v)
    pb: list[str] = []
    for ep in sorted(p for p in (series / "episodes").glob("*") if p.is_dir()):
        for sd in scene_dirs(series, ep, pb):
            for _, text, bases, _ in scene_pages(series, sd, pb):
                rb = tuple(r for r in (_rel(series, b) for b in bases) if r is not None)
                for v in MEDIA_STR.findall(text):
                    take(rb, page_name(v), every=True)
    if bad is not None:
        bad += pb
    return out


def _plan_jobs(series: Path, bad: list[str]) -> list[tuple[Path, dict]]:
    """(episode dir, job) for every job object in the gen-plans; a plan that cannot be read goes to bad."""
    out = []
    for gp in sorted(series.glob("episodes/*/gen-plan.json")):
        try:
            jobs = load_json(gp).get("jobs", [])
        except (OSError, ValueError, AttributeError) as e:
            bad.append(f"{_rel(series, gp)}: {e.__class__.__name__}")
            continue
        if not isinstance(jobs, list):
            bad.append(f"{_rel(series, gp)}: jobs is not a list")
            continue
        out += [(gp.parent, j) for j in jobs if isinstance(j, dict)]
    return out


def _licences(series: Path) -> dict:
    p = series / "catalog" / "licences.json"
    try:
        d = load_json(p) if p.exists() else {}
    except (OSError, ValueError):
        return {}
    return d if isinstance(d, dict) else {}


def _cache(series: Path) -> dict:
    try:
        d = json.loads((series / "catalog" / "hash-cache.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return d if isinstance(d, dict) else {}


def observe(series: Path) -> dict:
    t0 = time.perf_counter()
    st = ac.state(series)
    load_ms = (time.perf_counter() - t0) * 1000
    assets, by_path = st["assets"], st["by_path"]
    retired = ("superseded_by", "quarantined", "purged")  # gc moved or deleted quarantined and purged files on purpose
    cur = [r for r in assets.values() if not any(r.get(k) for k in retired)]
    held = [r for r in assets.values() if r.get("quarantined") and not r.get("superseded_by")]
    bad: list[str] = []
    refs = edl_refs(series, bad)
    unresolved = []
    folded = {_fold(k): v for k, v in by_path.items()}
    by_path_fold = {_fold(k): k for k in by_path}
    for r in refs:
        aid = folded.get(_fold(r["path"] or ""))
        rec = assets.get(aid) if aid else None
        if not rec or any(rec.get(k) for k in retired) or not (series / rec["path"]).exists():
            unresolved.append(r)
    keys = [r["path"] or "" for r in refs] or list(by_path)[:1] or [""]
    reps = -(-10_000 // len(keys))
    t = time.perf_counter()
    for _ in range(reps):
        for k in keys:
            by_path.get(k)
    lookup_us = (time.perf_counter() - t) * 1e6 / (reps * len(keys))
    used = {p for r in cur for p in r.get("parents", [])}
    named = named_paths(series, set(by_path)) | {by_path_fold[_fold(r["path"])] for r in refs
                                                 if r["path"] and _fold(r["path"]) in by_path_fold}
    lic, cache = _licences(series), _cache(series)
    stats = {}
    for r in cur:
        try:
            stats[r["asset_id"]] = (series / r["path"]).stat()
        except OSError:
            pass
    by_sha: dict[str, list[dict]] = {}
    for r in cur:
        if r["asset_id"] in stats:  # a file that is gone is counted under missing, not as a copy
            by_sha.setdefault(r["sha256"], []).append(r)
    dup_groups = [g for g in by_sha.values() if len(g) > 1]
    hits = 0
    eps: dict[str, dict] = {}
    orphans, no_prov, no_lic = [], [], []
    for r in cur:
        e = eps.setdefault(r.get("episode") or "-", {"assets": 0, "bytes": 0, "orphans": 0, "provenance_unknown": 0,
                                                    "licence_unknown": 0, "unresolved_refs": 0})
        e["assets"] += 1
        e["bytes"] += r.get("bytes") or 0
        s = stats.get(r["asset_id"])
        if s:
            c = cache.get(r["path"])
            hits += int(isinstance(c, list) and len(c) == 3 and c[0] == s.st_size and c[1] == s.st_mtime_ns)
        if (s and r["asset_id"] not in used and r["path"] not in named and not r.get("pinned")
                and r.get("role") not in EXEMPT_ROLES and r.get("status") != "rejected"):
            orphans.append(r)
            e["orphans"] += 1
        if not r.get("source"):
            if r.get("role") in GENERATED_ROLES:
                no_prov.append(r)
                e["provenance_unknown"] += 1
            if r["path"] not in lic and r["asset_id"] not in lic:
                no_lic.append(r)
                e["licence_unknown"] += 1
    for r in unresolved:
        eps.setdefault(r["episode"], {"assets": 0, "bytes": 0, "orphans": 0, "provenance_unknown": 0, "licence_unknown": 0,
                                      "unresolved_refs": 0})["unresolved_refs"] += 1
    jobs_missing, jobs_uncat, bad_plans = [], [], []
    for ep, j in _plan_jobs(series, bad_plans):
        if j.get("status") != "done" or not isinstance(j.get("out"), str) or not j["out"]:
            continue
        rel = _rel(series, ep / j["out"])
        if not (ep / j["out"]).exists():
            jobs_missing.append(f"{ep.name}/{j.get('id')}")
        elif _fold(rel or "") not in folded:
            jobs_uncat.append(f"{ep.name}/{j.get('id')}")
    present = len(stats)
    tot = {
        "assets": len(cur), "bytes": sum(r.get("bytes") or 0 for r in cur), "records": len(assets),
        "time_to_find": {"load_ms": round(load_ms, 1), "lookup_us": round(lookup_us, 3), "lookups": reps * len(keys)},
        "refs": len(refs), "resolved": len(refs) - len(unresolved),
        "resolve_rate": round((len(refs) - len(unresolved)) / len(refs), 4) if refs else None,
        "duplicate_files": sum(len(g) - 1 for g in dup_groups),
        "duplicate_bytes": sum(sum(r.get("bytes") or 0 for r in g) - max(r.get("bytes") or 0 for r in g) for g in dup_groups),
        "cache_hit": round(hits / present, 4) if present else None, "present": present, "missing": len(cur) - present,
        "orphans": len(orphans), "orphan_bytes": sum(r.get("bytes") or 0 for r in orphans),
        "provenance_unknown": len(no_prov), "licence_unknown": len(no_lic),
        "jobs_missing_out": len(jobs_missing), "jobs_uncatalogued": len(jobs_uncat),
        "quarantined": len(held), "quarantined_bytes": sum(r.get("bytes") or 0 for r in held),
    }
    return {"series": series.name, "total": tot, "episodes": eps, "unreadable_edls": sorted(set(bad)),
            "unreadable_plans": bad_plans,
            "samples": {"unresolved": [f"{r['episode']}/{r['scene']}/{r['shot']} {r['key']}={r['path']}" for r in unresolved[:10]],
                        "orphans": [r["path"] for r in orphans[:10]], "provenance_unknown": [r["path"] for r in no_prov[:10]],
                        "jobs_missing_out": jobs_missing[:10], "jobs_uncatalogued": jobs_uncat[:10]}}


def record_metrics(series: Path, m: dict, *, run: str = "") -> Path:
    p = series / "catalog" / "metrics.jsonl"
    append_jsonl(p, {"at": now_iso(), "run": run, **m["total"]})
    return p


def _result_bytes(content) -> tuple[int, int]:
    """(text bytes, image bytes) of one tool result; images are base64 and are billed as pictures, not as text."""
    if isinstance(content, str):
        return len(content.encode("utf-8")), 0
    text = img = 0
    for c in content if isinstance(content, list) else []:
        if not isinstance(c, dict):
            continue
        if c.get("type") == "text":
            text += len((c.get("text") or "").encode("utf-8"))
        elif c.get("type") == "image":
            img += len(str((c.get("source") or {}).get("data") or ""))
        else:
            text += len(json.dumps(c).encode("utf-8"))
    return text, img


def _when(v):
    """An aware timestamp, or None for a missing, unparseable or naive one."""
    try:
        t = _ts(v)
    except (TypeError, ValueError, AttributeError):
        return None
    return t if t.tzinfo else None


def context_bytes(files: list[Path], start: str, end: str | None, phases: list[tuple[str, str]]) -> dict:
    """Tool-result bytes per phase and per tool (text; images apart), de-duplicated by tool_use_id."""
    t0, t1 = _ts(start), (_ts(end) if end else None)
    ph = sorted(((n, _ts(t)) for n, t in phases), key=lambda x: x[1])
    names, results = {}, {}
    for f in files:
        with f.open(errors="ignore", encoding="utf-8") as fh:
            for ln, line in enumerate(fh):
                try:
                    r = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(r, dict):
                    continue
                m = r.get("message") if isinstance(r.get("message"), dict) else {}
                body = m.get("content") if isinstance(m.get("content"), list) else []
                for i, c in enumerate(body):
                    if not isinstance(c, dict):
                        continue
                    if c.get("type") == "tool_use":
                        names[c.get("id")] = c.get("name", "?")
                    elif c.get("type") == "tool_result" and (tt := _when(r.get("timestamp"))):
                        if tt >= t0 and not (t1 and tt > t1):
                            results[c.get("tool_use_id") or (f.name, ln, i)] = (tt, _result_bytes(c.get("content")))
    per: dict[str, dict] = {}
    for tid, (tt, n) in results.items():
        name = "pre"
        for pn, s in ph:
            if tt >= s:
                name = pn
        p = per.setdefault(name, {"bytes": 0, "image_bytes": 0, "results": 0, "by_tool": {}})
        p["bytes"] += n[0]
        p["image_bytes"] += n[1]
        p["results"] += 1
        tool = names.get(tid, "?")
        p["by_tool"][tool] = p["by_tool"].get(tool, 0) + n[0]
    return {"phases": per, "total": {k: sum(p[k] for p in per.values()) for k in ("bytes", "image_bytes", "results")},
            "files": len(files)}


def context_for_run(episode_dir: Path, transcript: str | None = None) -> dict | None:
    ev = run_events(episode_dir)
    start = next((e for e in ev if e["event"] == "run_start"), None)
    tr = transcript or (start or {}).get("transcript")
    if not start or not tr or not Path(tr).exists():
        return None
    end = next((e["ts"] for e in reversed(ev) if e["event"] == "run_end"), None)
    return context_bytes(transcript_files(Path(tr)), start["ts"], end, [(e["phase"], e["ts"]) for e in ev if e["event"] == "phase_start"])


def dod_path(series: Path) -> Path:
    return series / "catalog" / "dod.jsonl"


def _filmspec_packs(series: Path, target: str) -> list[str]:
    p = series / "episodes" / target.split("/")[0] / "filmspec.json"
    try:
        packs = load_json(p).get("packs", []) if p.exists() else []
    except (OSError, ValueError, AttributeError):
        return []
    return [x for x in packs if isinstance(x, str)] if isinstance(packs, list) else []


def checklist(series: Path, level: str, target: str) -> list[dict] | None:
    """The FilmSpec DoD for this level, with the packs the episode's filmspec.json applies; None when that module is
    not installed (then only recorded checks are reported)."""
    try:
        from . import knowledge_packs_and_film_spec as kf
    except ImportError:
        return None
    try:
        return kf.dod_checklist(level, _filmspec_packs(series, target))
    except (SystemExit, KeyError, OSError, ValueError):  # a filmspec naming a pack that is not installed
        return kf.dod_checklist(level, [])


def _gate_rows(series: Path, level: str, target: str) -> list[dict]:
    return [r for r in read_jsonl(dod_path(series)) if isinstance(r, dict) and r.get("op") == "gate" and isinstance(r.get("check"), str)
            and r.get("level") == level and _target(str(r.get("target") or "")) == target]


def record(series: Path, *, level: str, target: str, check: str, result: str, evidence=(), approver: str = "",
           note: str = "", kind: str | None = None) -> dict:
    if level not in LEVELS:
        raise SystemExit(f"level must be one of {', '.join(LEVELS)}")
    if result not in RESULTS:
        raise SystemExit(f"result must be one of {', '.join(RESULTS)}")
    target = _target(target)
    req = {c["id"]: c for c in checklist(series, level, target) or []}
    c = req.get(check) or {}
    first = next((r["kind"] for r in _gate_rows(series, level, target) if r.get("check") == check and r.get("kind") in KINDS), None)
    listed, where = (c.get("kind"), f"the {level} checklist") if c else (first, "its first record")
    if kind and listed and kind != listed:
        raise SystemExit(f"{check} is a {listed} check in {where}, not {kind}")
    kind = kind or listed
    if kind not in KINDS:
        raise SystemExit(f"{check} is not in the {level} checklist: pass --kind ({', '.join(KINDS)})")
    evidence = [e.strip() for e in evidence if isinstance(e, str) and e.strip()]
    approver, note = approver.strip(), note.strip()
    if result == "WAIVED" and not (approver and note):
        raise SystemExit("WAIVED needs --approver and --note (the reason)")
    if result != "WAIVED":
        if kind == "human" and not approver:
            raise SystemExit("a human check needs --approver: the person who decided")
        if kind != "human" and not evidence:
            raise SystemExit(f"{result} on a {kind} check needs --evidence (a command output, frames, timestamps or a measurement)")
        cmd = c.get("source") or ("filmspec" if c.get("fn") else "")
        if kind == "hard" and cmd and not any(cmd in e for e in evidence):
            raise SystemExit(f"{check} is computed by `{cmd}`: the evidence must quote its output (e.g. '{cmd}: exit 0')")
    row = {"op": "gate", "level": level, "dod": LEVELS[level], "target": target, "check": check, "kind": kind, "result": result,
           "evidence": evidence, "approver": approver, "note": note, "at": now_iso()}
    append_jsonl(dod_path(series), row)
    return row


def status(series: Path, level: str, target: str) -> dict:
    """Latest result per check. A result that is not PASS, FAIL or WAIVED (a hand-edited row) reads as INVALID and
    fails the level like a FAIL."""
    if level not in LEVELS:
        raise SystemExit(f"level must be one of {', '.join(LEVELS)}")
    target = _target(target)
    latest = {r.get("check"): r for r in _gate_rows(series, level, target)}
    req = checklist(series, level, target)

    def row(check, kind, r):
        res = r.get("result", "MISSING") if r else "MISSING"
        return {"check": check, "kind": kind, "result": res if res in (*RESULTS, "MISSING") else "INVALID",
                "approver": r.get("approver", "") if r else "", "evidence": r.get("evidence", []) if r else []}

    rows = [row(c["id"], c["kind"], latest.get(c["id"])) for c in req or []]
    known = {r["check"] for r in rows}
    rows += [row(k, r.get("kind") if r.get("kind") in KINDS else "?", r) for k, r in latest.items() if k not in known]
    by_kind = {k: {x: sum(1 for r in rows if r["kind"] == k and r["result"] == x) for x in (*RESULTS, "MISSING", "INVALID")}
               for k in KINDS}
    res = {r["result"] for r in rows}
    verdict = "FAIL" if res & {"FAIL", "INVALID"} else "INCOMPLETE" if "MISSING" in res or not rows else "PASS"
    return {"level": level, "dod": LEVELS[level], "target": target, "verdict": verdict, "checklist": req is not None,
            "by_kind": by_kind, "checks": rows}


GROUP = "observability observe, context-bytes, dod (record|status)"


def register(add, O) -> None:
    add("observe", "series", O("--json", action="store_true"), O("--record", action="store_true"), O("--run", default=""),
        help="catalog health: time-to-find, resolve rate, duplicates, cache hit, orphans, unknown provenance/licence")
    add("context-bytes", "episode", O("--transcript"), O("--json", action="store_true"), help="tool-result bytes per trace phase")
    add("dod", O("action", choices=("record", "status")), "series", O("level", choices=list(LEVELS)), "target", O("check", nargs="?"),
        O("result", nargs="?", choices=RESULTS), O("--evidence", action="append", default=[]), O("--approver", default=""),
        O("--note", default=""), O("--kind", choices=KINDS), O("--json", action="store_true"),
        help="DoD-1..4 results (PASS|FAIL|WAIVED) with evidence and approver, in catalog/dod.jsonl")


def _print_observe(m: dict) -> None:
    t = m["total"]
    tf = t["time_to_find"]
    pct = lambda v: "n/a" if v is None else f"{v * 100:.1f}%"  # noqa: E731
    print(f"{m['series']}: {t['assets']} current assets ({t['bytes'] / 1e9:.2f} GB), {t['records']} records")
    print(f"  time-to-find   load {tf['load_ms']} ms, lookup {tf['lookup_us']} us (mean of {tf['lookups']})")
    print(f"  resolve rate   {pct(t['resolve_rate'])} ({t['resolved']}/{t['refs']} EDL refs)")
    print(f"  duplicates     {t['duplicate_files']} files, {t['duplicate_bytes'] / 1e6:.1f} MB")
    print(f"  cache hit      {pct(t['cache_hit'])} of {t['present']} present files ({t['missing']} missing)")
    print(f"  orphans        {t['orphans']} ({t['orphan_bytes'] / 1e6:.1f} MB)")
    print(f"  provenance     {t['provenance_unknown']} generated files without a job; licence unknown {t['licence_unknown']}")
    print(f"  jobs           {t['jobs_missing_out']} done jobs without their out, {t['jobs_uncatalogued']} not catalogued")
    for e, v in sorted(m["episodes"].items()):
        print(f"  {e:8} assets {v['assets']:5}  orphans {v['orphans']:4}  provenance? {v['provenance_unknown']:4}  "
              f"licence? {v['licence_unknown']:4}  unresolved {v['unresolved_refs']}")
    if m["unreadable_edls"]:
        print("  unreadable EDLs: " + ", ".join(m["unreadable_edls"]))
    if m["unreadable_plans"]:
        print("  unreadable gen-plans: " + ", ".join(m["unreadable_plans"]))


def run(a) -> bool:
    if a.cmd == "observe":
        series = Path(a.series).expanduser().resolve()
        if not ac.catalog_path(series).exists():
            raise SystemExit(f"no catalog at {ac.catalog_path(series)}: run `assets scan {a.series}` first")
        m = observe(series)
        if a.record:
            m["recorded"] = str(record_metrics(series, m, run=a.run))
        print(json.dumps(m, indent=2, ensure_ascii=False)) if a.json else _print_observe(m)
        return True
    if a.cmd == "context-bytes":
        c = context_for_run(Path(a.episode).expanduser().resolve(), a.transcript)
        if c is None:
            raise SystemExit("no run_start with a transcript in this episode's trace (pass --transcript)")
        if a.json:
            print(json.dumps(c, indent=2))
        else:
            for n, p in c["phases"].items():
                top = ", ".join(f"{k} {v / 1e3:.0f} KB" for k, v in sorted(p["by_tool"].items(), key=lambda x: -x[1])[:4])
                print(f"{n:16} {p['bytes'] / 1e3:9.0f} KB text + {p['image_bytes'] / 1e6:6.1f} MB images in {p['results']:4} results  ({top})")
            t = c["total"]
            print(f"{'total':16} {t['bytes'] / 1e3:9.0f} KB text + {t['image_bytes'] / 1e6:6.1f} MB images in {t['results']:4} results")
        return True
    if a.cmd == "dod":
        series = Path(a.series).expanduser().resolve()
        if a.action == "record":
            if not (a.check and a.result):
                raise SystemExit("dod record needs <check> <PASS|FAIL|WAIVED>")
            row = record(series, level=a.level, target=a.target, check=a.check, result=a.result, evidence=a.evidence,
                         approver=a.approver, note=a.note, kind=a.kind)
            print(json.dumps(row, ensure_ascii=False) if a.json else f"DoD-{row['dod']} {a.target} {a.check}: {a.result}")
            return True
        if a.check or a.result:
            raise SystemExit("dod status takes <series> <level> <target> only")
        s = status(series, a.level, a.target)
        if a.json:
            print(json.dumps(s, indent=2, ensure_ascii=False))
        else:
            print(f"DoD-{s['dod']} {s['level']} {s['target']}: {s['verdict']}"
                  + ("" if s["checklist"] else " (FilmSpec checklist not installed: recorded checks only)"))
            for r in s["checks"]:
                who = f" by {r['approver']}" if r["approver"] else ""
                print(f"  {r['result']:8} {r['kind']:8} {r['check']}{who}")
        if s["verdict"] != "PASS":
            raise SystemExit(1)
        return True
    return False
