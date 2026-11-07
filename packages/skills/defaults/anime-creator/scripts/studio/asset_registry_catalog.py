"""Asset registry: one append-only catalog of every media file a series made or approved, with lineage.

<series>/catalog/assets.jsonl holds one JSON object per line (schema assets/schemas/asset-record.v1.schema.json):
  {"op": "add", record}                 a file seen by scan; asset_id from its sha256 and path (asset_id())
  {"op": "pin"|"unpin", asset_id, ...}  keep an asset out of gc, with who and why
  {"op": "quarantine"|"unquarantine"|"purge", asset_id, path, batch, ...}  gc moved the file to (or back from)
                                        catalog/quarantine/<batch>/, or deleted it (storage_policy_and_replication)
  {"op": "retire"|"revive", asset_id, reason, at}  an edl-work file no EDL shows any more (status rejected), and back
Lines are never rewritten; appends take catalog/assets.jsonl.lock and check the revision they read, and a write cut
short is set aside, not parsed. A path whose bytes changed gets a NEW record that `supersedes` the old one, so a clip a
mix event or a chain proposal used can always be found by hash. Media never move: the catalog points at files where
the pipeline wrote them. Lineage comes from gen-plan.json (a job's refs_used, first, last and input are the parents
of its `out`). Commands (anime-studio.py assets ...): scan, list, get, resolve, refs, lineage, impact, check, pin,
gc (--dry-run reports; --quarantine, --restore and --purge
live in storage_policy_and_replication).
scan and check hash only files whose size or mtime differ from catalog/hash-cache.json ({path: [bytes, mtime_ns,
sha256]}, rewritten by each run, not part of the log); rehash=True hashes every file for a full verify. A file
modified within RACY_NS of the run is never cached, so a same-size rewrite inside one clock tick is still caught.
scan skips work/ (scratch), except a file a scene EDL shows: that one is catalogued with role EDL_WORK_ROLE, retired
when no EDL shows it any more (check and restore then leave it alone) and revived when one shows it again.
"""
from __future__ import annotations

import contextlib
import hashlib
import json
import os
import sys
import time
from pathlib import Path

from . import common_io_and_paths as io

from .reference_roles import sha256

SCHEMA_VERSION = 1
MEDIA = {".png": "image", ".jpg": "image", ".jpeg": "image", ".webp": "image", ".mp4": "video", ".mov": "video", ".webm": "video",
         ".wav": "audio", ".mp3": "audio", ".flac": "audio", ".m4a": "audio", ".glb": "model", ".gltf": "model"}
SKIP = {"catalog", "logs", "node_modules", "work", ".git", "__pycache__", "vendor"}
ROLE_BY_DIR = (("bible/characters", "identity"), ("bible/sets", "environment"), ("bible", "style"), ("gen/keyframes", "keyframe"),
               ("gen/video", "clip"), ("upscaled", "clip"), ("audio/vo", "vo"), ("audio/sfx", "sfx"), ("audio/music", "music"),
               ("gen/audio", "audio"), ("renders", "render"), ("scenes", "scene-asset"))
EDL_WORK_ROLE = "edl-work"  # a scratch file under work/ that a cut shows; warm by default, so replicate copies it
_fold = str.lower if os.name == "nt" else str  # Windows paths match whatever their letter case


RACY_NS = 2_000_000_000


def catalog_path(series: Path) -> Path:
    return series / "catalog" / "assets.jsonl"


class HashCache:
    """sha256 by (bytes, mtime_ns) per series path; a hit skips reading the file."""

    def __init__(self, series: Path, *, rehash: bool = False):
        self.path = series / "catalog" / "hash-cache.json"
        try:
            self.prev = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            self.prev = {}
        if not isinstance(self.prev, dict):
            self.prev = {}
        self.old = {} if rehash else self.prev
        self.new: dict[str, list] = {}
        self.hashed = 0

    def digest(self, f: Path, rel: str) -> str | None:
        try:
            st = f.stat()
        except OSError:
            return None
        hit = self.old.get(rel)
        if isinstance(hit, list) and len(hit) == 3 and hit[0] == st.st_size and hit[1] == st.st_mtime_ns:
            self.new[rel] = hit
            return hit[2]
        d = sha256(f)
        self.hashed += 1
        if d and time.time_ns() - st.st_mtime_ns > RACY_NS:
            self.new[rel] = [st.st_size, st.st_mtime_ns, d]
        return d

    def save(self, *, keep_old: bool = False) -> None:
        rows = {**self.prev, **self.new} if keep_old else self.new
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_name(f"{self.path.name}.{os.getpid()}.tmp")
        tmp.write_text(json.dumps(rows, separators=(",", ":"), sort_keys=True), encoding="utf-8")
        try:
            io.retry_sharing(lambda: tmp.replace(self.path))
        except OSError:  # a cache: the next run hashes what this one could not record
            tmp.unlink(missing_ok=True)


def media_files(series: Path):
    """Media files under series, never descending into SKIP or dot directories; linked directories are followed once."""
    seen = set()
    for d, dirs, files in os.walk(series, followlinks=True):
        st = os.stat(d)
        if st.st_ino and (st.st_dev, st.st_ino) in seen:  # a link loop, or a folder linked in twice (0: no inodes)
            dirs[:] = []
            continue
        seen.add((st.st_dev, st.st_ino))
        dirs[:] = sorted(x for x in dirs if x not in SKIP and not x.startswith("."))
        for name in sorted(files):
            if not name.startswith(".") and Path(name).suffix.lower() in MEDIA:
                yield Path(d) / name


def _on_disk(series: Path, rel: str) -> str:
    """rel as the directory listing spells it: a case-insensitive file system opens Work/Comp.mp4 as work/comp.mp4."""
    cur, segs = series, rel.split("/")
    for i, seg in enumerate(segs):
        try:
            names = os.listdir(cur)
        except OSError:  # gone between the check and the listing: keep the EDL's spelling
            return rel
        if seg not in names:
            segs[i] = next((n for n in names if n.lower() == seg.lower()), seg)
        cur = cur / segs[i]
    return "/".join(segs)


def edl_work_refs(series: Path, bad: list[str]) -> set[str]:
    """Series-relative media paths under a work/ folder that a scene EDL shows, in their on-disk spelling when the
    file exists (a missing one is still shown, so its record is not retired). The walk skips the rest of work/.
    EDLs that do not load go to bad: what they show is unknown."""
    from .asset_observability_and_dod_gates import edl_refs  # lazy: that module imports this one
    out = set()
    for r in edl_refs(series, bad):
        p = r["path"]
        if p and Path(p).suffix.lower() in MEDIA and "work" in [_fold(x) for x in p.split("/")[:-1]]:
            out.add(_on_disk(series, p) if (series / p).is_file() else p)
    return out


class CatalogChanged(RuntimeError):
    """Another process appended to the catalog between this one's read and its write."""


def read(series: Path) -> list[dict]:
    return read_rev(series)[0]


def read_rev(series: Path) -> tuple[list[dict], int]:
    return read_log(catalog_path(series))


def read_log(p: Path) -> tuple[list[dict], int]:
    """-> (rows, revision) of an append-only JSONL log. The revision is the byte length of the complete lines read:
    an append moves it. A last line with no newline that does not parse is a write cut short (a crash, a full disk):
    it is skipped here and set aside by the next append. A bad line in the middle is never skipped silently."""
    if not p.exists():
        return [], 0
    data = p.read_bytes()
    body = data
    if data and not data.endswith(b"\n"):
        cut = data.rfind(b"\n") + 1
        try:
            json.loads(data[cut:])
            body = data + b"\n"  # a whole record that only lacks its newline: the next append adds it
        except ValueError:
            print(f"{p}: ignoring a half-written last line ({len(data) - cut} bytes); the next append sets it aside", file=sys.stderr)
            body = data[:cut]
    rows = []
    for n, line in enumerate(body.split(b"\n"), 1):  # bytes split: U+2028 inside a value is not a line break
        if not line.strip():
            continue
        try:
            rows.append(json.loads(line))
        except ValueError as e:
            raise SystemExit(f"{p}:{n} is not JSON ({e}); fix or remove that line by hand, lines are never rewritten")
    return rows, len(body)


def _set_aside_torn_tail(p: Path) -> None:
    data = p.read_bytes()
    if not data or data.endswith(b"\n"):
        return
    cut = data.rfind(b"\n") + 1
    tail = data[cut:]
    try:
        json.loads(tail)
        with p.open("ab") as f:  # a whole record that only lacks its newline
            f.write(b"\n")
        return
    except ValueError:
        pass
    torn = p.with_name(f"{p.stem}.torn.{time.strftime('%Y%m%dT%H%M%S')}.{os.getpid()}.jsonl")
    torn.write_bytes(tail)
    with p.open("r+b") as f:
        f.truncate(cut)
    print(f"{p}: set a half-written line aside in {torn.name}", file=sys.stderr)


@contextlib.contextmanager
def log_lock(p: Path):
    """Hold <log>.lock: the lock append_log takes. A caller that must write more than one file as one change holds it
    across all of them and appends with append_log(..., held=True)."""
    p.parent.mkdir(parents=True, exist_ok=True)
    lock = p.with_name(p.name + ".lock")
    if lock in io._UNRELEASED and io.lock_owner(lock) == os.getpid():  # this process's own leftover, not a holder
        try:
            lock.unlink()
            io._UNRELEASED.discard(lock)
        except OSError:
            pass
    io.take_lock(lock, f"append {p.name}", wait=120, poll=0.05)
    try:
        yield
    finally:
        for _ in range(100):  # Windows refuses the unlink while a waiter is reading the owner line
            try:
                lock.unlink(missing_ok=True)
                break
            except PermissionError:
                time.sleep(0.02)
        else:  # the append itself succeeded: the next append in this process clears it
            io._UNRELEASED.add(lock)
            print(f"could not remove {lock.name} (held open); this process clears it on its next append", file=sys.stderr)


def append_log(p: Path, rows: list[dict], *, expect_rev: int | None = None, held: bool = False) -> None:
    """Append under <log>.lock (held=True: the caller already holds it through log_lock). With expect_rev (read_log's
    revision when the rows were computed), a log another process appended to since then raises CatalogChanged
    instead of writing rows from a stale fold."""
    if not rows:
        return
    if not held:
        with log_lock(p):
            return append_log(p, rows, expect_rev=expect_rev, held=True)
    p.parent.mkdir(parents=True, exist_ok=True)
    if p.exists():
        _set_aside_torn_tail(p)
    size = p.stat().st_size if p.exists() else 0
    if expect_rev is not None and size != expect_rev:
        raise CatalogChanged(f"{p} changed while this run worked (revision {expect_rev} -> {size}); run it again")
    with p.open("a", encoding="utf-8", newline="\n") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False, sort_keys=True) + "\n")


def _append(series: Path, rows: list[dict], *, expect_rev: int | None = None) -> None:
    append_log(catalog_path(series), rows, expect_rev=expect_rev)


def state(series: Path, rows: list[dict] | None = None) -> dict:
    """Fold the log -> {assets: {id: record+pinned+superseded_by}, by_path: {path: current id}}."""
    assets, by_path = {}, {}
    for row in read(series) if rows is None else rows:
        op = row.get("op")
        if op == "add":
            rec = {k: v for k, v in row.items() if k != "op"}
            rec.setdefault("pinned", False)
            assets[rec["asset_id"]] = rec
            old = rec.get("supersedes")
            if old in assets:
                assets[old]["superseded_by"] = rec["asset_id"]
            by_path[rec["path"]] = rec["asset_id"]
        elif op in ("pin", "unpin") and row.get("asset_id") in assets:
            assets[row["asset_id"]]["pinned"] = op == "pin"
        elif op in ("quarantine", "unquarantine", "purge") and row.get("asset_id") in assets:
            rec = assets[row["asset_id"]]
            rec.pop("quarantined", None)
            if op != "unquarantine":
                rec["purged" if op == "purge" else "quarantined"] = row.get("batch")
        elif op == "retire" and row.get("asset_id") in assets and not assets[row["asset_id"]].get("retired"):
            rec = assets[row["asset_id"]]  # rejected maps to the ephemeral tier: never replicated or restored
            rec.update({"retired": row.get("reason") or "retired", "status_before": rec["status"], "status": "rejected"})
        elif op == "revive" and assets.get(row.get("asset_id"), {}).get("retired"):
            rec = assets[row["asset_id"]]
            rec["status"] = rec.pop("status_before", "candidate")
            del rec["retired"]
    return {"assets": assets, "by_path": by_path}


def asset_id(digest: str, rel: str, *, taken: dict | None = None) -> str:
    """Stable id from content AND path (two copies of one file are two assets); a path that returns to bytes it held
    before gets a revision suffix, so an id never names two records."""
    base = "ast_" + hashlib.sha256(f"{digest}:{rel}".encode()).hexdigest()[:16]
    aid, n = base, 1
    while taken and aid in taken:
        aid, n = f"{base}-r{n}", n + 1
    return aid


def _where(rel: str) -> dict:
    parts = rel.split("/")
    out = {"episode": None, "scene": None, "shot": None}
    if "episodes" in parts and parts.index("episodes") + 1 < len(parts):
        out["episode"] = parts[parts.index("episodes") + 1]
    for p in parts:
        if len(p) == 4 and p.startswith("sc") and p[2:].isdigit():
            out["scene"] = p
    stem = parts[-1].rsplit(".", 1)[0]
    for tok in stem.replace("_", "-").split("-"):
        if len(tok) >= 3 and tok[0] == "s" and tok[1:3].isdigit() and not tok.startswith("sc"):
            out["shot"] = tok
        elif out["scene"] is None and len(tok) == 4 and tok.startswith("sc") and tok[2:].isdigit():
            out["scene"] = tok
    return out


def _jobs(series: Path) -> list[tuple[Path, dict]]:
    out = []
    for gp in sorted(series.glob("episodes/*/gen-plan.json")):
        for j in json.loads(gp.read_text(encoding="utf-8")).get("jobs", []):
            out.append((gp.parent, j))
    return out


def scan(series: Path, *, now: str | None = None, rehash: bool = False, cache: HashCache | None = None) -> dict:
    """Add every new or changed media file; retire edl-work records no EDL shows, revive those one shows again.
    -> {added, changed, unchanged, retired, revived, unreadable_edls}. Idempotent: a re-scan adds nothing. Unchanged files (same bytes
    and mtime as the hash cache) are not read; rehash reads them all."""
    cache = cache or HashCache(series, rehash=rehash)
    log, rev = read_rev(series)
    st = state(series, log)
    known = {r["sha256"]: i for i, r in st["assets"].items() if not r.get("superseded_by")}
    produced = {}
    for ep, j in _jobs(series):
        if j.get("out"):
            rel = (ep / j["out"]).resolve().relative_to(series.resolve()).as_posix() if (ep / j["out"]).exists() else None
            if rel:
                produced[rel] = (ep, j)
    rows, added, changed, same = [], 0, 0, 0
    ts = now or io.local_iso()
    bad: list[str] = []
    shown = edl_work_refs(series, bad)
    edl_work = {r for r in shown if (series / r).is_file()}
    files = {f.relative_to(series).as_posix(): f for f in media_files(series)} | {r: series / r for r in edl_work}
    for rel, f in sorted(files.items(), key=lambda x: x[1]):
        digest = cache.digest(f, rel)
        if digest is None:  # vanished between the walk and the read
            continue
        cur = st["by_path"].get(rel)
        refresh = bool(cur and st["assets"][cur]["sha256"] == digest)
        if refresh and rel not in produced:
            same += 1
            continue
        aid = asset_id(digest, rel, taken=st["assets"])
        role = EDL_WORK_ROLE if rel in edl_work else next((r for d, r in ROLE_BY_DIR if f"/{d}/" in f"/{rel}" or rel.startswith(d + "/")), "other")
        rec = {"op": "add", "schema_version": SCHEMA_VERSION, "asset_id": aid, "sha256": digest, "path": rel,
               "kind": MEDIA[f.suffix.lower()], "role": role, "bytes": f.stat().st_size, "seen": ts, **_where(rel),
               "status": "candidate", "parents": [], "source": None}
        if rel in produced:
            ep, j = produced[rel]
            rec["status"] = {"done": "approved" if j.get("approved") else "candidate", "rejected": "rejected"}.get(j.get("status"), "candidate")
            rec["source"] = {"job": j.get("id"), "kind": j.get("kind"), "model": j.get("model"),
                             "pred_id": j.get("pred_id") or j.get("request_id"), "episode": ep.name}
            rec.update({k: j[k] for k in ("scene", "shot") if j.get(k)})  # the job knows its shot better than the filename
            chained = [ep / j["chain"]["source"]] if (j.get("chain") or {}).get("source") else []  # a chained first frame descends from that clip
            rec["_parent_paths"] = [str(p) for p in (j.get("refs_used") or []) + [ep / j[k] for k in ("first", "last", "input") if j.get(k)] + chained]
        if refresh:  # same bytes: a new record only if the job now tells more (scene, shot, parents), checked below
            rec.update({"supersedes": cur, "pinned": st["assets"][cur].get("pinned", False), "_refresh": True})
        elif cur:
            rec["supersedes"] = cur
            changed += 1
        else:
            added += 1
        if digest in known and known[digest] != cur:
            rec["duplicate_of"] = known[digest]
        rows.append(rec)
    # new or changed files take their parents' new records; a same-bytes refresh keeps the parent records it already
    # names (renamed below only when such a parent was itself refreshed), so regenerating a parent never rewrites a
    # child, and only a parent path it did not have yet resolves to the newest record
    index = {**st["by_path"], **{r["path"]: r["asset_id"] for r in rows if not r.get("_refresh")}}
    for r in rows:
        pp = r.pop("_parent_paths", [])
        had = {st["assets"][p]["path"]: p for p in st["assets"][r["supersedes"]].get("parents", []) if p in st["assets"]} if r.get("_refresh") else {}
        idx = {**index, **had}
        for p in pp:
            pth = Path(p)
            try:
                rel = (pth if pth.is_absolute() else series / pth).resolve().relative_to(series.resolve()).as_posix()
            except ValueError:
                continue
            if rel in idx:
                r["parents"].append(idx[rel])
    # a kept refresh renames its asset, which changes its children's parents: repeat until no refresh is added
    refresh = [r for r in rows if r.get("_refresh")]
    renamed, grew = {}, True
    while grew:
        grew = False
        for r in refresh:
            old = st["assets"][r["supersedes"]]
            if old["asset_id"] in renamed:
                continue
            cand = {**r, "parents": [renamed.get(p, p) for p in r["parents"]]}
            if old.get("retired"):  # a retired record reads as rejected; shown again with the same bytes, it revives
                old = {**old, "status": old.get("status_before", old["status"])}
            if any(cand.get(k) != old.get(k) for k in ("scene", "shot", "status", "parents", "source")):
                renamed[old["asset_id"]], grew = r["asset_id"], True
    kept = [r for r in rows if not r.pop("_refresh", False) or r["supersedes"] in renamed]
    changed += len(renamed)
    same += len(refresh) - len(renamed)
    for r in kept:
        r["parents"] = [renamed.get(p, p) for p in r["parents"]]
    # an edl-work record lives only while an EDL shows its path; a record this scan supersedes needs neither event.
    # An EDL that does not load may show any of them: no retire that scan, reviving is still safe
    shown_f, gone = {_fold(p) for p in shown}, {r.get("supersedes") for r in kept}
    life = [{"op": "retire" if r.get("retired") is None else "revive", "asset_id": r["asset_id"], "at": ts,
             "reason": "no EDL shows it" if r.get("retired") is None else "an EDL shows it again"}
            for r in st["assets"].values() if r.get("role") == EDL_WORK_ROLE and not r.get("superseded_by")
            and r["asset_id"] not in gone and (_fold(r["path"]) in shown_f) == bool(r.get("retired"))
            and (r.get("retired") or not bad)]
    cache.save()  # the hashes stay true even when the append below is refused
    _append(series, kept + life, expect_rev=rev)
    return {"added": added, "changed": changed, "unchanged": same, "retired": sum(e["op"] == "retire" for e in life),
            "revived": sum(e["op"] == "revive" for e in life), "unreadable_edls": sorted(set(bad))}


def get(series: Path, key: str) -> dict | None:
    st = state(series)
    return st["assets"].get(key) or st["assets"].get(st["by_path"].get(key, ""))


def query(series: Path, *, kind=None, role=None, episode=None, scene=None, status=None, limit: int = 50, offset: int = 0) -> dict:
    rows = [r for r in state(series)["assets"].values() if not (r.get("superseded_by") or r.get("quarantined") or r.get("purged"))
            and all(v is None or r.get(k) == v for k, v in (("kind", kind), ("role", role), ("episode", episode), ("scene", scene), ("status", status)))]
    rows.sort(key=lambda r: r["path"])
    page = rows[offset: offset + limit]
    return {"total": len(rows), "offset": offset, "limit": limit, "items": page,
            "next_offset": offset + limit if offset + limit < len(rows) else None}


def lineage(series: Path, aid: str) -> list[dict]:
    a, out, todo, seen = state(series)["assets"], [], [aid], set()
    while todo:
        cur = todo.pop()
        for p in (a.get(cur) or {}).get("parents", []):
            if p not in seen and p in a:
                seen.add(p)
                out.append(a[p])
                todo.append(p)
    return out


def impact(series: Path, aid: str) -> list[dict]:
    a = state(series)["assets"]
    kids = {}
    for r in a.values():
        for p in r.get("parents", []):
            kids.setdefault(p, []).append(r["asset_id"])
    out, todo, seen = [], [aid], set()
    while todo:
        for k in kids.get(todo.pop(), []):
            if k not in seen:
                seen.add(k)
                out.append(a[k])
                todo.append(k)
    return out


def refs(series: Path, episode: str, scene: str, shot: str | None = None) -> list[dict]:
    return [r for r in query(series, episode=episode, scene=scene, limit=10 ** 6)["items"] if shot is None or r.get("shot") == shot]


def check(series: Path, *, rehash: bool = False, cache: HashCache | None = None) -> list[str]:
    """Missing, changed, dangling and duplicate assets. Only files whose size or mtime moved are re-hashed (rehash:
    every one)."""
    cache = cache or HashCache(series, rehash=rehash)
    st, out = state(series), []
    for r in st["assets"].values():
        if r.get("superseded_by") or r.get("retired") or r.get("quarantined") or r.get("purged"):  # retired work/ files and files gc moved or deleted
            continue
        f = series / r["path"]
        if not f.exists():
            out.append(f"missing  {r['asset_id']} {r['path']}")
        elif cache.digest(f, r["path"]) != r["sha256"]:
            out.append(f"changed  {r['asset_id']} {r['path']} (run assets scan)")
        for p in r.get("parents", []):
            if p not in st["assets"]:
                out.append(f"dangling {r['asset_id']} parent {p}")
        if r.get("duplicate_of"):
            out.append(f"dup      {r['asset_id']} {r['path']} same bytes as {r['duplicate_of']}")
    cache.save(keep_old=True)  # check sees only catalogued paths: keep scan's entries for the rest
    return out


def pin(series: Path, aid: str, *, on: bool = True, by: str = "", reason: str = "") -> None:
    log, rev = read_rev(series)
    if aid not in state(series, log)["assets"]:
        raise SystemExit(f"no asset {aid}")
    _append(series, expect_rev=rev, rows=[{"op": "pin" if on else "unpin", "asset_id": aid, "by": by, "reason": reason, "at": io.local_iso()}])


def gc_candidates(series: Path) -> list[dict]:
    """Rejected or superseded assets nothing depends on and nobody pinned, not retired, quarantined or purged (a
    retired edl-work record may have a newer take at its path). storage_policy_and_replication.gc_plan narrows them
    to the files gc may move."""
    a = state(series)["assets"]
    used = {p for r in a.values() for p in r.get("parents", [])}
    # a record a scan only refreshed (same path, same bytes) still names the live file
    def head(r: dict) -> dict:
        while r.get("superseded_by"):
            r = a[r["superseded_by"]]
        return r
    live = {r["asset_id"] for r in a.values() if r.get("superseded_by") and (head(r)["path"], head(r)["sha256"]) == (r["path"], r["sha256"])}
    return [{"asset_id": r["asset_id"], "path": r["path"], "bytes": r["bytes"], "why": "superseded" if r.get("superseded_by") else "rejected"}
            for r in a.values() if not r.get("pinned") and not (r.get("retired") or r.get("quarantined") or r.get("purged"))
            and r["asset_id"] not in used | live and (r.get("superseded_by") or r.get("status") == "rejected")]
