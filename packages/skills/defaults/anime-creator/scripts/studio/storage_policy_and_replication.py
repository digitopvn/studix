"""Storage lifecycle of a series: tiers, remote copies with verified hashes, restore, disk preflight.

Opt-in: nothing here acts until <series>/catalog/policy.json exists (`assets policy <series> --init` writes the
default below). Without it the catalog behaves as before and no job is held back.
  {"tiers": [{"tier": "warm", "status": ["approved"]}, {"tier": "warm", "role": ["identity", ...]}, ...],
   "default_tier": "hot", "replicate": ["warm", "cold"], "reserve_gb": 20,
   "retention": {"ephemeral_days": 14, "quarantine_days": 7},
   "remotes": [{"name": "drive", "kind": "fs", "root": "G:/My Drive/anime-studio/<series>"}]}
Tiers: hot = working files on the local disk only; warm = local plus a verified remote copy; cold = archived, a
remote copy is required before the local file may go; ephemeral = rebuildable, never copied. The first rule whose
fields all match a record decides its tier.
A remote of kind "fs" is a folder: a Google Drive or other sync-client mirror, a NAS share, an external disk. Copies
are content-addressed (<root>/objects/<sha[:2]>/<sha256>, no extension), so every path with the same bytes shares one copy.
A copy counts only after its bytes hash to the record's sha256; each one appends a receipt (with its locator) to
catalog/replicas.jsonl. Restore never overwrites a local file whose bytes differ from its record unless forced.
A remote whose root is missing (drive unmounted, sync client stopped) is reported unreachable: verify says
degraded, restore copies nothing, and neither ever writes a receipt for it.
gc quarantines before it purges: `gc --quarantine` moves the derivatives nothing uses (gc_plan) to
catalog/quarantine/<stamp>/<path> with a manifest and a catalog line per file, `gc --restore <stamp>` puts a batch
back byte for byte, and `gc --purge` deletes only batches older than retention quarantine_days (or --older-than).
export_check is the licence, provenance and consent gate before an export or a publish.
"""
from __future__ import annotations

import json
import math
import os
import re
import shutil
import sys
import time
from datetime import datetime
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

from . import asset_registry_catalog as ac
from . import common_io_and_paths as io
from .reference_roles import sha256

DEFAULT_POLICY = {
    "schema_version": 1,
    "tiers": [{"tier": "ephemeral", "status": ["rejected"]},
              {"tier": "warm", "status": ["approved"]},
              {"tier": "warm", "role": ["identity", "environment", "style", "vo", "music", "edl-work"]}],
    "default_tier": "hot",
    "replicate": ["warm", "cold"],
    "reserve_gb": 20,
    "retention": {"ephemeral_days": 14, "quarantine_days": 7},
    "remotes": [],
}
TIERS = ("hot", "warm", "cold", "ephemeral")


def policy_path(series: Path) -> Path:
    return series / "catalog" / "policy.json"


def replicas_path(series: Path) -> Path:
    return series / "catalog" / "replicas.jsonl"


def load_policy(series: Path) -> dict | None:
    """-> the policy merged over DEFAULT_POLICY, or None when the series has no catalog/policy.json (feature off)."""
    p = policy_path(series)
    if not p.exists():
        return None
    raw = io.load_json(p)
    if not isinstance(raw, dict):
        raise SystemExit(f"{p}: expected a JSON object")
    pol = {**DEFAULT_POLICY, **raw}
    if not isinstance(pol.get("retention"), dict):
        raise SystemExit(f"{p}: retention must be an object of <tier>_days and quarantine_days")
    pol["retention"] = {**DEFAULT_POLICY["retention"], **pol["retention"]}  # a partial retention keeps the other ages
    for r in pol["tiers"]:
        if r.get("tier") not in TIERS:
            raise SystemExit(f"{p}: tier {r.get('tier')!r} is not one of {', '.join(TIERS)}")
    for r in pol["remotes"]:
        if r.get("kind", "fs") != "fs" or not r.get("name") or not r.get("root"):
            raise SystemExit(f"{p}: a remote needs a name, a root folder and kind \"fs\" (got {r})")
    return pol


def init_policy(series: Path, remote_root: str | None = None) -> Path:
    p = policy_path(series)
    if p.exists():
        raise SystemExit(f"{p} exists; edit it by hand")
    pol = dict(DEFAULT_POLICY)
    if remote_root:
        pol["remotes"] = [{"name": "drive", "kind": "fs", "root": remote_root}]
    io.save_json(p, pol)
    return p


def tier_of(rec: dict, pol: dict) -> str:
    for rule in pol["tiers"]:
        keys = [k for k in rule if k != "tier"]
        if keys and all(rec.get(k) in (rule[k] if isinstance(rule[k], list) else [rule[k]]) for k in keys):
            return rule["tier"]
    return pol.get("default_tier", "hot")


def remote(pol: dict, name: str | None = None) -> dict:
    rs = pol["remotes"]
    if not rs:
        raise SystemExit("catalog/policy.json lists no remotes: add {\"name\", \"kind\": \"fs\", \"root\"}")
    for r in rs:
        if name is None or r["name"] == name:
            return r
    raise SystemExit(f"no remote {name!r} in catalog/policy.json (have {', '.join(r['name'] for r in rs)})")


def reachable(rem: dict) -> bool:
    return Path(rem["root"]).is_dir()


def locator(rec: dict) -> str:
    """Content-addressed and extension-free: every path holding these bytes, whatever its suffix, finds one copy."""
    return f"objects/{rec['sha256'][:2]}/{rec['sha256']}"


def receipts(series: Path, rem_name: str) -> dict[str, dict]:
    """sha256 -> the latest receipt for that remote (its `locator` is where the copy is)."""
    return {r["sha256"]: r for r in ac.read_log(replicas_path(series))[0] if r.get("remote") == rem_name and r.get("op") == "replica"}


def live(series: Path) -> list[dict]:
    return [r for r in ac.state(series)["assets"].values() if not (r.get("superseded_by") or r.get("quarantined") or r.get("purged"))]


def _place(src: Path, dst: Path) -> None:
    """Rename src to dst on one file system without ever replacing a file at dst (FileExistsError). Windows rename
    refuses an existing dst; POSIX links then unlinks, each step retried on its own, and falls back to a checked
    rename where the file system has no hard links."""
    if os.name == "nt":
        io.retry_sharing(lambda: os.rename(src, dst))
        return
    try:
        io.retry_sharing(lambda: os.link(src, dst))
    except FileExistsError:
        raise
    except OSError:  # no hard links here (exFAT, some network shares)
        if dst.exists():
            raise FileExistsError(f"{dst} exists")
        io.retry_sharing(lambda: os.rename(src, dst))
        return
    io.retry_sharing(lambda: os.unlink(src))


def _copy_verified(src: Path, dst: Path, digest: str, *, overwrite: bool = True) -> bool:
    """Copy through a .part file and rename only when the copy hashes to digest. Never leaves a wrong file at dst;
    overwrite=False never replaces a file at dst either (FileExistsError)."""
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_name(f"{dst.name}.{os.getpid()}.part")
    try:
        shutil.copyfile(src, tmp)
        if sha256(tmp) != digest:
            return False
        if overwrite:
            io.retry_sharing(lambda: os.replace(tmp, dst))
        else:
            _place(tmp, dst)
        return True
    finally:
        tmp.unlink(missing_ok=True)


def _receipt(rec: dict, rem: dict, *, how: str) -> dict:
    return {"op": "replica", "asset_id": rec["asset_id"], "sha256": rec["sha256"], "remote": rem["name"],
            "locator": locator(rec), "bytes": rec["bytes"], "how": how, "at": io.local_iso()}


def replicate(series: Path, name: str | None = None, *, dry_run: bool = False) -> dict:
    """Copy every live asset whose tier is in policy `replicate` to the remote, once per sha256.
    -> {remote, copied, adopted, skipped, failed: [...], bytes_copied}; adopted = already there with the right hash."""
    pol = load_policy(series)
    if pol is None:
        raise SystemExit(f"no {policy_path(series)}: run `assets policy {series} --init` first")
    rem = remote(pol, name)
    out = {"remote": rem["name"], "copied": 0, "adopted": 0, "skipped": 0, "failed": [], "bytes_copied": 0}
    if not reachable(rem):
        out["failed"].append(f"unreachable remote {rem['name']}: {rem['root']} is not a folder")
        return out
    have, new, groups = receipts(series, rem["name"]), [], {}
    root = Path(rem["root"])
    for rec in sorted(live(series), key=lambda r: r["path"]):
        if tier_of(rec, pol) in pol["replicate"] and not rec.get("retired"):  # whatever order a policy's rules take
            groups.setdefault(rec["sha256"], []).append(rec)
    for sha, recs in groups.items():
        rec = recs[0]
        old = root / ((have.get(sha) or {}).get("locator") or locator(rec))  # an older receipt's locator still counts
        if sha in have and old.is_file() and old.stat().st_size == rec["bytes"]:
            out["skipped"] += 1
            continue
        dst = root / locator(rec)  # a new copy always goes where its receipt will point
        if dst.is_file() and sha256(dst) == sha:  # copied before, receipt lost: adopt it, do not copy again
            out["adopted"] += 1
            new.append(_receipt(rec, rem, how="adopted"))
            continue
        present = [r for r in recs if (series / r["path"]).is_file()]
        if not present:
            out["failed"].append(f"missing locally {rec['asset_id']} {', '.join(r['path'] for r in recs)}")
            continue
        if dry_run:
            out["copied"] += 1
            out["bytes_copied"] += rec["bytes"]
            continue
        src, errors = None, []
        for r in present:  # the first path that still holds the bytes
            try:
                if _copy_verified(series / r["path"], dst, sha):
                    src = r
                    break
            except OSError as e:
                errors.append(f"{r['path']}: {e.__class__.__name__}")
        if src:
            out["copied"] += 1
            out["bytes_copied"] += rec["bytes"]
            new.append(_receipt(src, rem, how="copied"))
        else:
            out["failed"].append(f"hash mismatch {rec['asset_id']} {', '.join(r['path'] for r in present)} "
                                 "(changed since the scan: run assets scan)" + (f"; unreadable {', '.join(errors)}" if errors else ""))
    if not dry_run:
        ac.append_log(replicas_path(series), new)
    return out


def verify_remote(series: Path, name: str | None = None, *, deep: bool = False) -> dict:
    """Is every asset the policy replicates present on the remote? deep re-hashes each copy; otherwise size is
    compared. -> {remote, status: ok|degraded, counts, problems}. Any problem, an unreachable remote above all, is
    degraded."""
    pol = load_policy(series)
    if pol is None:
        raise SystemExit(f"no {policy_path(series)}: run `assets policy {series} --init` first")
    rem = remote(pol, name)
    want = {}
    for rec in live(series):
        if tier_of(rec, pol) in pol["replicate"] and not rec.get("retired"):
            want.setdefault(rec["sha256"], rec)
    counts = dict.fromkeys(("ok", "missing", "mismatch", "unreplicated", "unreachable"), 0)
    problems = []
    if not reachable(rem):
        counts["unreachable"] = len(want)
        problems.append(f"unreachable remote {rem['name']}: {rem['root']} is not a folder ({len(want)} copies unchecked)")
    else:
        have, root = receipts(series, rem["name"]), Path(rem["root"])
        for sha, rec in sorted(want.items(), key=lambda kv: kv[1]["path"]):
            if sha not in have:
                counts["unreplicated"] += 1
                problems.append(f"unreplicated {rec['asset_id']} {rec['path']}")
                continue
            loc = have[sha].get("locator") or locator(rec)
            dst = root / loc
            if not dst.is_file():
                counts["missing"] += 1
                problems.append(f"missing  {rec['asset_id']} {rem['name']}:{loc}")
            elif dst.stat().st_size != rec["bytes"] or (deep and sha256(dst) != sha):
                counts["mismatch"] += 1
                problems.append(f"mismatch {rec['asset_id']} {rem['name']}:{loc}")
            else:
                counts["ok"] += 1
    return {"remote": rem["name"], "status": "degraded" if problems else "ok", "deep": deep, "counts": counts, "problems": problems}


def restore(series: Path, name: str | None = None, *, targets: list[str] | None = None, dry_run: bool = False,
            force: bool = False) -> dict:
    """Bring back every replicated live asset whose local file is missing, from a remote copy that hashes right,
    then run the catalog check (missing files, dangling parents). A local file whose bytes differ from its record is
    newer work not scanned yet, or bit rot: it is reported as `changed` and left alone, unless force moves it aside
    to <name>.pre-restore.<time><ext> first. targets (asset ids or paths) also reach hot assets; without targets a
    missing file of a tier the policy never copies is listed in not_replicated (an edited one in hot_changed) and
    does not fail the restore. A forced copy that fails puts the local file back.
    -> {remote, restored, changed, not_replicated, hot_changed, unrecoverable, set_aside, check, ok}."""
    pol = load_policy(series)
    if pol is None:
        raise SystemExit(f"no {policy_path(series)}: run `assets policy {series} --init` first")
    rem = remote(pol, name)
    rows = [r for r in live(series) if not r.get("retired")]  # no EDL shows it: never brought back, even by target
    if targets:
        want = set(targets)
        rows = [r for r in rows if r["asset_id"] in want or r["path"] in want]
    cache = ac.HashCache(series)
    out = {"remote": rem["name"], "checked": len(rows), "lost": 0, "restored": 0, "changed": [], "not_replicated": [],
           "hot_changed": [], "unrecoverable": [], "set_aside": [], "check": []}
    lost = []
    for r in rows:
        f = series / r["path"]
        if f.is_file() and cache.digest(f, r["path"]) == r["sha256"]:
            continue
        if not targets and tier_of(r, pol) not in pol["replicate"]:
            key = "hot_changed" if f.is_file() else "not_replicated"  # a newer take over a hot file is normal work
            out[key].append(f"{r['asset_id']} {r['path']} ({tier_of(r, pol)})")
            continue
        if f.is_file() and not force:
            out["changed"].append(f"{r['asset_id']} {r['path']} (differs from its record: run assets scan, or restore --force)")
            continue
        lost.append(r)
    out["lost"] = len(lost)
    if lost and not reachable(rem):
        out["unrecoverable"] = [f"unreachable remote {rem['name']}: {rem['root']} is not a folder ({len(lost)} files)"]
        out["ok"] = False
        return out
    have, root = receipts(series, rem["name"]), Path(rem["root"])
    for rec in lost:
        loc = (have.get(rec["sha256"]) or {}).get("locator") or locator(rec)
        src, dst = root / loc, series / rec["path"]
        if rec["sha256"] not in have or not src.is_file():
            out["unrecoverable"].append(f"no remote copy {rec['asset_id']} {rec['path']}")
            continue
        if dry_run:
            out["restored"] += 1
            continue
        aside = None
        if dst.is_file():  # force: keep the local bytes; nothing is overwritten without a copy beside it
            aside = dst.with_name(f"{dst.stem}.pre-restore.{time.strftime('%Y%m%dT%H%M%S')}{dst.suffix}")
            try:
                io.retry_sharing(lambda: os.replace(dst, aside))
            except OSError as e:
                out["unrecoverable"].append(f"cannot move the local file aside ({e.__class__.__name__}) {rec['asset_id']} {rec['path']}")
                continue
        ok, why = False, "remote copy corrupt"
        try:
            ok = _copy_verified(src, dst, rec["sha256"])
        except OSError as e:
            why = f"copy failed ({e.__class__.__name__}: {e})"
        finally:
            if aside and not ok:  # failed or interrupted: the local bytes go back where they were
                try:
                    io.retry_sharing(lambda: os.replace(aside, dst))
                except OSError:
                    out["unrecoverable"].append(f"local bytes left at {aside.relative_to(series).as_posix()}: move them back by hand")
        if not ok:
            out["unrecoverable"].append(f"{why} {rec['asset_id']} {rem['name']}:{loc}")
            continue
        out["restored"] += 1
        if aside:
            out["set_aside"].append(aside.relative_to(series).as_posix())
    if not dry_run:
        out["check"] = ac.check(series)
    # hot files the policy never copies are known gaps; with targets, only the targeted assets count
    expected = {x.split(" ", 1)[0] for x in out["not_replicated"] + out["hot_changed"]}
    ids = {r["asset_id"] for r in rows}
    out["ok"] = not (out["unrecoverable"] or out["changed"] or any(
        not c.startswith("dup") and c.split()[1] not in expected and (not targets or c.split()[1] in ids)
        for c in out["check"]))
    return out


def preflight(series: Path, need_bytes: int = 0) -> str | None:
    """-> why a new job must not start (free space below policy reserve_gb after need_bytes), or None. None also when
    the series has no policy: the guard is opt-in."""
    pol = load_policy(series)
    if pol is None or not pol.get("reserve_gb"):
        return None
    free = shutil.disk_usage(series).free
    reserve = float(pol["reserve_gb"]) * 1e9
    if free - need_bytes < reserve:
        return (f"disk preflight: {free / 1e9:.1f} GB free on {series.anchor or series}, policy reserve_gb is "
                f"{pol['reserve_gb']}: replicate warm assets and free space (assets gc --dry-run lists candidates) before new jobs")
    return None


# --- gc: quarantine before purge -------------------------------------------------------------------------------------
PROTECTED_ROLES = ("identity", "environment", "style", "render")  # originals, the bible and finals are never moved
PROTECTED_DIRS = ("bible", "reference", "renders")
IN_FLIGHT = ("submitted",)  # paid and not fetched yet: the runner writes `out` and reads the inputs again
JOB_INPUTS = ("first", "last", "input")


def quarantine_root(series: Path) -> Path:
    return series / "catalog" / "quarantine"


def _parse(ts) -> float | None:
    try:
        return time.mktime(time.strptime(str(ts)[:19], "%Y-%m-%dT%H:%M:%S"))
    except (TypeError, ValueError, OverflowError):
        return None


def _days(v, what: str) -> float:
    if isinstance(v, bool):
        raise SystemExit(f"{what} takes a number of days, not {v!r}")
    try:
        d = float(v)
    except (TypeError, ValueError):
        raise SystemExit(f"{what} takes a number of days, not {v!r}")
    if not math.isfinite(d) or d < 0:
        raise SystemExit(f"{what} takes a finite number of days >= 0, not {v!r}")
    return d


def folder(series: Path):
    """Case folding for path matches on this series' file system: lower-case where the disk ignores case (Windows,
    a default macOS volume), identity where it does not. Probed on the series folder itself."""
    p = str(series.resolve())
    alt = p.swapcase()
    try:
        insensitive = alt != p and os.path.exists(alt) and os.path.samefile(p, alt)
    except OSError:
        insensitive = os.name == "nt"
    return str.lower if insensitive or (alt == p and os.name == "nt") else str


DEVICES = {"CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$",  # Windows device names, any extension
           *(f"{d}{i}" for d in ("COM", "LPT") for i in [*range(10), "¹", "²", "³"])}


def _inside(base: Path, rel) -> Path:
    """base/rel for a manifest path, refusing anything that is not a plain forward-slash relative path inside base:
    rooted ("/x"), drive ("C:x", "C:/x"), backslash, "..", a Windows device name (NUL, con.mp4), a name Windows would
    trim (trailing dot or space), and anything a link resolves outside base."""
    if (not isinstance(rel, str) or not rel or "\\" in rel or rel.startswith("/") or ":" in rel
            or any(x in ("", ".", "..") or x[-1] in ". " or x.split(".")[0].rstrip(" ").upper() in DEVICES for x in rel.split("/"))):
        raise ValueError(f"unsafe path {rel!r}")
    p = base / rel
    if not p.resolve().is_relative_to(base.resolve()):
        raise ValueError(f"unsafe path {rel!r} (resolves outside {base.name})")
    return p


def _job_inputs(j: dict) -> list:
    return list(j.get("refs_used") or []) + [j.get(k) for k in JOB_INPUTS] + [(j.get("chain") or {}).get("source")]


def _series_rel(series: Path, ep: Path, v, *, from_series: bool = False) -> str | None:
    """Series-relative spelling of a job path (refs_used is read from the series root, the rest from the episode), or
    None when it lies outside the series or on another drive."""
    if not isinstance(v, str) or not v:
        return None
    p = v if os.path.isabs(v) else (series if from_series else ep) / v
    try:
        r = Path(os.path.relpath(os.path.normpath(p), os.path.normpath(series))).as_posix()
    except ValueError:
        return None
    return None if r == ".." or r.startswith("../") else r


def _plans(series: Path) -> list[tuple[Path, dict]]:
    """(episode dir, job) for every job; an unreadable gen-plan stops the caller: it cannot prove what jobs hold."""
    out = []
    for gp in sorted(series.glob("episodes/*/gen-plan.json")):
        try:
            jobs = io.load_json(gp).get("jobs", [])
        except (OSError, ValueError, AttributeError) as e:
            raise SystemExit(f"{gp}: unreadable ({e.__class__.__name__}); gc and export-check cannot read the jobs")
        out += [(gp.parent, j) for j in jobs if isinstance(j, dict)] if isinstance(jobs, list) else []
    return out


def leased(series: Path, now: float | None = None, jobs: list | None = None) -> set[str]:
    """Series paths a job still holds: a submitted job (its out and inputs), one whose `lease` has no `until` or an
    `until` later than now, and one a runner holds a live admission lease for. A lease that names another series is
    not this one's; one that names the output it was asked to write holds the job with that output (whatever its
    episode, which a ComfyUI run may not know); otherwise episode plus job id, or the output file name the ComfyUI
    runner records as its job, match it."""
    from . import admission_leases as adm
    now, out = now or time.time(), set()
    me = _real(series)
    running = [r for r in adm.listing(series) if r.get("live")
               and not (isinstance(r.get("series"), str) and _real(r["series"]) != me)]

    def runs(ep: Path, j: dict) -> bool:
        o = j.get("out") if isinstance(j.get("out"), str) and j.get("out") else None
        mine = _real(ep / o) if o else None
        return any((mine and isinstance(r.get("out"), str) and _real(r["out"]) == mine)
                   or (r.get("episode") == ep.name and r.get("job") in (j.get("id"), Path(o).name if o else None))
                   for r in running)

    for ep, j in _plans(series) if jobs is None else jobs:
        lease = j.get("lease")
        until = _parse(lease.get("until")) if isinstance(lease, dict) else None
        if j.get("status") in IN_FLIGHT or (lease and (until is None or until > now)) or runs(ep, j):
            out |= {r for r in [_series_rel(series, ep, j.get("out"))] + [
                _series_rel(series, ep, v, from_series=k < len(j.get("refs_used") or []))
                for k, v in enumerate(_job_inputs(j))] if r}
    return out


def gc_plan(series: Path, now: float | None = None) -> dict:
    """ac.gc_candidates narrowed to the files gc may move: a derivative whose job in the gen-plan is still `rejected`
    (and not approved), not an original, bible file or render, named by no EDL, mix, plan or edit page, held by no job
    lease, in a tier the policy does not keep (warm, cold) and older than the policy retention for its tier
    (`<tier>_days`, counted from the record's `seen`; a tier with no retention is held). The default policy applies
    when the series has none. Any EDL or episode JSON that cannot be read holds every candidate (`unreadable`).
    -> {eligible: [...], held: [... + held reason], unreadable: [...]}; rows carry asset_id, path, bytes, why, tier,
    sha256."""
    from . import asset_observability_and_dod_gates as obs  # lazy: that module imports this package's catalog
    now = now or time.time()
    pol = load_policy(series) or DEFAULT_POLICY
    st = ac.state(series)
    a, fold, bad = st["assets"], folder(series), []
    named = {fold(p) for p in obs.named_paths(series, set(st["by_path"]), bad, fold)} | {
        fold(r["path"]) for r in obs.edl_refs(series, bad) if r["path"]}
    jobs = _plans(series)
    by_job = {(ep.name, j.get("id")): j for ep, j in jobs}
    held_by_job = {fold(p) for p in leased(series, now, jobs)}
    retention = pol.get("retention") or {}
    out = {"eligible": [], "held": [], "unreadable": sorted(set(bad))}
    for c in ac.gc_candidates(series):
        rec = a[c["asset_id"]]
        src = rec.get("source") or {}
        job = by_job.get((src.get("episode"), src.get("job")))
        tier = tier_of(rec, pol)
        days = retention.get(f"{tier}_days")
        seen = _parse(rec.get("seen"))
        age = (now - seen) / 86400 if seen else None
        try:
            days = None if days is None else _days(days, f"retention.{tier}_days")
        except SystemExit:
            days = None
        why = ("superseded: the path holds newer bytes, only the record is left" if rec.get("superseded_by")
               else f"unreadable JSON may name it: {', '.join(out['unreadable'][:3])}" if out["unreadable"]
               else "not a derivative: no producing job" if not src.get("job")
               else f"protected: role {rec.get('role')}" if rec.get("role") in PROTECTED_ROLES
               else "protected: original, bible or render folder" if any(d in PROTECTED_DIRS for d in rec["path"].split("/")[:-1])
               else "its job is no longer in the gen-plan" if job is None
               else f"its job is {'approved' if job.get('approved') else job.get('status')} now" if job.get("approved") or job.get("status") != "rejected"
               else "referenced by an EDL, mix, plan or edit page" if fold(rec["path"]) in named
               else "job lease: a job in flight holds it" if fold(rec["path"]) in held_by_job
               else f"tier {tier}: kept by the policy" if tier in ("warm", "cold")
               else f"retention: no {tier}_days in the policy" if days is None
               else f"retention: {tier} kept {days:g} days (age {'unknown' if age is None else f'{age:.1f}'})"
               if age is None or age < days
               else "file missing" if not (series / rec["path"]).is_file() else None)
        row = {**c, "tier": tier, "sha256": rec["sha256"]}
        if why:
            out["held"].append({**row, "held": why})
        else:
            out["eligible"].append(row)
    return out


def _move(src: Path, dst: Path, digest: str) -> None:
    """Rename without overwriting (same disk: the bytes never move); across disks copy, verify the hash, then delete
    the source. A file already at dst raises FileExistsError."""
    if dst.exists():
        raise FileExistsError(f"{dst} exists")
    dst.parent.mkdir(parents=True, exist_ok=True)
    try:
        _place(src, dst)
    except FileExistsError:
        raise
    except OSError:  # another disk: copy, verify, never over a file, then drop the source
        if not src.is_file() or not _copy_verified(src, dst, digest, overwrite=False):
            raise
        src.unlink()


def _event(op: str, item: dict, batch: str, by: str, reason: str) -> dict:
    return {"op": op, "asset_id": item["asset_id"], "path": item["path"], "batch": batch, "by": by, "reason": reason,
            "at": io.local_iso()}


def quarantine(series: Path, *, by: str = "", reason: str = "", dry_run: bool = False, now: float | None = None) -> dict:
    """Move every gc_plan eligible file whose bytes, re-read now, still match its record to
    catalog/quarantine/<stamp>/<path>, write <stamp>/manifest.json, then append a `quarantine` line per file. The plan
    is computed again after the hashing, right before the moves, so a lease or reference taken meanwhile holds the
    file. If the append fails (another process appended meanwhile: CatalogChanged) every file goes back, except one
    whose original path was taken again: it stays in the batch, which is kept. -> {batch, moved, bytes, changed,
    held, unreadable}."""
    _, rev = ac.read_rev(series)
    plan = gc_plan(series, now)
    out = {"batch": None, "moved": [], "bytes": 0, "changed": [], "held": plan["held"], "unreadable": plan["unreadable"],
           "dry_run": dry_run}
    if dry_run:
        out.update(moved=[{k: r[k] for k in ("asset_id", "path", "sha256", "bytes", "why")} for r in plan["eligible"]],
                   bytes=sum(r["bytes"] for r in plan["eligible"]))
        return out
    todo = []
    for r in plan["eligible"]:
        if sha256(series / r["path"]) != r["sha256"]:
            out["changed"].append(f"{r['asset_id']} {r['path']} (differs from its record: run assets scan)")
        else:
            todo.append({k: r[k] for k in ("asset_id", "path", "sha256", "bytes", "why")})
    still = {r["asset_id"] for r in gc_plan(series, now)["eligible"]} if todo else set()
    out["held"] += [{**r, "held": "held since the plan (reference, lease or job status changed)"} for r in todo if r["asset_id"] not in still]
    todo = [r for r in todo if r["asset_id"] in still]
    if not todo:
        return out
    lt = time.localtime(now)
    stamp = time.strftime("%Y%m%dT%H%M%S", lt)
    if (quarantine_root(series) / stamp).exists():
        stamp = f"{stamp}-{os.getpid()}"
    batch = quarantine_root(series) / stamp
    batch.mkdir(parents=True)
    man = {"schema_version": 1, "batch": stamp, "at": time.strftime("%Y-%m-%dT%H:%M:%S", lt), "by": by, "reason": reason, "items": todo}
    io.save_json(batch / "manifest.json", man)  # first: a crash mid-move still leaves a manifest restore can read
    moved = []
    try:
        for r in todo:
            try:
                if sha256(series / r["path"]) != r["sha256"]:  # changed between the plan and this move
                    raise ValueError("bytes changed")
                _move(series / r["path"], batch / r["path"], r["sha256"])
                moved.append(r)
            except (OSError, ValueError) as e:
                out["changed"].append(f"{r['asset_id']} {r['path']} (not moved: {e.__class__.__name__})")
        io.save_json(batch / "manifest.json", {**man, "items": moved})
        ac.append_log(ac.catalog_path(series), [_event("quarantine", r, stamp, by, reason) for r in moved], expect_rev=rev)
    except BaseException:
        stuck = []
        for r in moved:  # the catalog never learned of the move: put the files back, never over a new file
            try:
                _move(batch / r["path"], series / r["path"], r["sha256"])
            except OSError:
                stuck.append(r)
        if stuck:
            io.save_json(batch / "manifest.json", {**man, "items": stuck})
            print(f"{len(stuck)} file(s) stay in catalog/quarantine/{stamp}/ because their path holds a new file: "
                  + ", ".join(r["path"] for r in stuck), file=sys.stderr)
        else:
            shutil.rmtree(batch, ignore_errors=True)
        raise
    if not moved:
        shutil.rmtree(batch, ignore_errors=True)
        stamp = None
    out.update(batch=stamp, moved=moved, bytes=sum(r["bytes"] for r in moved))
    return out


def _batch(series: Path, stamp: str) -> tuple[Path, dict]:
    if not stamp or stamp != Path(stamp).name or stamp in (".", "..") or "\\" in stamp or ":" in stamp:
        raise SystemExit(f"bad quarantine batch {stamp!r}: pass the folder name under catalog/quarantine/")
    b = quarantine_root(series) / stamp
    if not (b / "manifest.json").is_file():
        raise SystemExit(f"no quarantine batch {stamp} ({b / 'manifest.json'} missing)")
    try:
        man = io.load_json(b / "manifest.json")
    except (OSError, ValueError) as e:
        raise SystemExit(f"{b / 'manifest.json'}: unreadable ({e.__class__.__name__})")
    if not isinstance(man, dict) or not isinstance(man.get("items"), list) or not all(isinstance(r, dict) for r in man["items"]):
        raise SystemExit(f"{b / 'manifest.json'}: no list of item objects")
    return b, man


def _drop_if_empty(b: Path) -> bool:
    if any(p.is_file() and p != b / "manifest.json" for p in b.rglob("*")):
        return False
    shutil.rmtree(b)
    return True


def restore_batch(series: Path, stamp: str, *, by: str = "", reason: str = "") -> dict:
    """Put a quarantined batch back where each file came from. A file whose quarantined bytes no longer hash to the
    manifest, or whose original path holds a file again, stays in quarantine and is listed under conflicts.
    -> {batch, restored, conflicts, ok}; the batch folder goes once nothing is left in it."""
    b, man = _batch(series, stamp)
    out, back, left = {"batch": stamp, "restored": [], "conflicts": []}, [], []
    for r in man["items"]:
        try:
            q, dst = _inside(b, r.get("path")), _inside(series, r.get("path"))
        except ValueError as e:
            out["conflicts"].append(f"manifest item {r!r}: {e}")
            left.append(r)
            continue
        if not q.is_file():
            if dst.is_file() and sha256(dst) == r.get("sha256"):
                back.append(r)  # moved back by an interrupted restore, its event not written yet
            else:
                out["conflicts"].append(f"{r.get('asset_id')} {r['path']}: not in the batch")
                left.append(r)
            continue
        if sha256(q) != r.get("sha256"):
            out["conflicts"].append(f"{r.get('asset_id')} {r['path']}: quarantined bytes changed")
        else:
            try:
                _move(q, dst, r["sha256"])
                back.append(r)
                continue
            except FileExistsError:
                out["conflicts"].append(f"{r.get('asset_id')} {r['path']}: the path holds another file now (move it, then restore)")
            except OSError as e:
                out["conflicts"].append(f"{r.get('asset_id')} {r['path']}: {e.__class__.__name__}")
        left.append(r)
    a = ac.state(series)["assets"]
    ac.append_log(ac.catalog_path(series), [_event("unquarantine", r, stamp, by, reason) for r in back
                                            if (a.get(r.get("asset_id")) or {}).get("quarantined") == stamp])
    out["restored"] = [r["path"] for r in back]
    if left:
        io.save_json(b / "manifest.json", {**man, "items": left})
    else:
        _drop_if_empty(b)
    out["ok"] = not out["conflicts"]
    return out


def purge(series: Path, older_than: float | None = None, *, by: str = "", reason: str = "", dry_run: bool = False,
          now: float | None = None) -> dict:
    """Delete quarantine batches whose manifest `at` is at least older_than days old (default: policy retention
    quarantine_days). Only a manifest item whose current catalog record is quarantined in that batch, is not pinned and
    whose bytes still hash to the manifest is deleted; every other item stays and is listed under skipped. A folder
    without a readable manifest, or whose items the catalog does not record, is listed under orphans and left alone.
    `purge` lines are written for exactly the files deleted, even when a later deletion fails.
    -> {older_than, purged: [batch], kept: [batch (age)], files, bytes, skipped, orphans}."""
    pol = load_policy(series) or DEFAULT_POLICY
    days = _days((pol.get("retention") or {}).get("quarantine_days", 7) if older_than is None else older_than,
                 "--older-than" if older_than is not None else "retention.quarantine_days")
    now = now or time.time()
    out = {"older_than": days, "purged": [], "kept": [], "files": 0, "bytes": 0, "skipped": [], "orphans": [], "dry_run": dry_run}
    root = quarantine_root(series)
    a = ac.state(series)["assets"]
    for b in sorted(p for p in root.iterdir() if p.is_dir()) if root.is_dir() else []:
        try:
            _, man = _batch(series, b.name)
        except SystemExit as e:
            out["orphans"].append(f"{b.name}: {e}")
            continue
        at = _parse(man.get("at"))
        if at is None or (now - at) / 86400 < days:
            out["kept"].append(f"{b.name} (age {'unknown' if at is None else f'{(now - at) / 86400:.1f}'} days)")
            continue
        items = [r for r in man["items"] if b.name in ((a.get(r.get("asset_id")) or {}).get("quarantined"),
                                                        (a.get(r.get("asset_id")) or {}).get("purged"))]
        if not items:
            out["orphans"].append(f"{b.name}: the catalog records none of its items as quarantined here")
            continue
        gone, done = [], []
        try:
            for r in man["items"]:
                rec = a.get(r.get("asset_id")) or {}
                try:
                    q = _inside(b, r.get("path"))
                except ValueError as e:
                    out["skipped"].append(f"{b.name}: manifest item {r!r}: {e}")
                    continue
                if rec.get("purged") == b.name and not q.exists():
                    done.append(r)  # deleted by an earlier, interrupted purge: its line is written
                    continue
                try:
                    digest = sha256(q) if q.is_file() else None
                except OSError as e:
                    digest, err = None, e
                else:
                    err = None
                why = ("not quarantined here in the catalog" if rec.get("quarantined") != b.name
                       else "pinned" if rec.get("pinned")
                       else "path differs from its record" if rec.get("path") != r.get("path")
                       else "manifest hash differs from its record" if r.get("sha256") != rec.get("sha256")
                       else f"unreadable ({err.__class__.__name__})" if err
                       else "not in the batch" if not q.is_file()
                       else "bytes differ from the manifest" if digest != r.get("sha256") else None)
                if why:
                    out["skipped"].append(f"{b.name}: {r.get('asset_id')} {r.get('path')}: {why}")
                    continue
                size = q.stat().st_size
                if not dry_run:
                    try:
                        q.unlink()
                    except OSError as e:
                        out["skipped"].append(f"{b.name}: {r.get('asset_id')} {r.get('path')}: {e.__class__.__name__}")
                        continue
                out["files"] += 1
                out["bytes"] += size
                gone.append(r)
        finally:
            if not dry_run:
                ac.append_log(ac.catalog_path(series), [_event("purge", r, b.name, by, reason) for r in gone])
        if not dry_run:
            left = [r for r in man["items"] if r not in gone and r not in done]
            if left:
                io.save_json(b / "manifest.json", {**man, "items": left})
            elif not _drop_if_empty(b):
                out["skipped"].append(f"{b.name}: files the manifest does not list are left in place")
        if gone or done:
            out["purged"].append(b.name)
    return out


# --- licence, provenance and consent gate before export or publish --------------------------------------------------
UNKNOWN = ("", "unknown", "?", "none", "n/a", "tbd")
EDL_NAME = re.compile(r"^edl(\.[A-Za-z]{2,3}(-[A-Za-z0-9]+)?)?\.json$")  # edl.json and dubbed edl.<lang>.json
EDL_FILE_KEYS = ("src", "src_raw", "img", "pick")


def licences(series: Path) -> dict:
    """catalog/licences.json: {path or asset_id: {licence, consent, source, by}}. An unreadable file stops the gate."""
    p = series / "catalog" / "licences.json"
    if not p.exists():
        return {}
    try:
        d = io.load_json(p)
    except (OSError, ValueError) as e:
        raise SystemExit(f"{p}: unreadable ({e.__class__.__name__}); the export gate cannot pass without it")
    if not isinstance(d, dict):
        raise SystemExit(f"{p}: expected an object of {{path or asset_id: {{licence, consent, source, by}}}}")
    return d


def _known(v) -> bool:
    return isinstance(v, str) and v.strip().lower() not in UNKNOWN


def _render_inputs(series: Path, rel: str, bad: list[str], offs: list[dict] | None = None) -> list[str | None] | None:
    """Files a render under episodes/<ep>/renders/ was made from, or None for any other path: the shot files and
    dialogue VO of its scene's EDLs (edl.json and every dubbed edl.<lang>.json) and the mix events of that scene plus
    the scene-less ones, each with its dub.<lang> takes, when the file name names a scene of the episode
    (sc03-master.mp4); else every scene and the whole mix. None in the list stands for a file outside the series;
    an EDL or mix that cannot be read goes to bad. A scene page name no file answers (a deleted file, a template
    literal, a bare name under a `dir:` that is not a plain string) and a file:// address go to offs as offenders;
    only the engine's own suffixes (obs.engine_names) pass."""
    from . import asset_observability_and_dod_gates as obs
    parts = rel.split("/")
    if len(parts) < 4 or parts[0] != "episodes" or "renders" not in parts[2:-1]:
        return None
    ep = series / "episodes" / parts[1]
    scenes = obs.scene_dirs(series, ep, bad)
    sc = ac._where(rel)["scene"]
    if sc and any(p.name == sc for p in scenes):
        scenes = [p for p in scenes if p.name == sc]
    else:
        sc = None
    out = []
    offs = [] if offs is None else offs

    def off(path: str | None, why: str) -> None:
        offs.append({"asset_id": None, "path": path, "role": None, "missing": [why]})

    for sd in scenes:
        for edl_p in sorted(p for p in sd.glob("edl*.json") if EDL_NAME.match(p.name)):
            try:
                shots = io.load_json(edl_p).get("shots")
                if not isinstance(shots, list):  # parsed but shows nothing knowable
                    raise ValueError("shots is not a list")
            except (OSError, ValueError, AttributeError) as e:
                bad.append(f"{edl_p.relative_to(series).as_posix()}: {e.__class__.__name__}")
                continue
            for shot in shots:
                if not isinstance(shot, dict):
                    continue
                for k in EDL_FILE_KEYS:
                    v = shot.get(k)
                    if isinstance(v, str) and Path(v).suffix.lower() in ac.MEDIA:  # pick can be a note
                        out.append(obs._first(series, [ep / v, sd / v] if k in ("src", "src_raw") else [sd / v, ep / v]))
                for line in shot.get("dialogue") or []:
                    if isinstance(line, dict) and isinstance(line.get("vo"), str) and line["vo"]:
                        out.append(obs._first(series, [ep / line["vo"], sd / line["vo"]]))
        for page, text, bases, unread in obs.scene_pages(series, sd, bad):  # edit pages, scene code, bundles
            prel = obs._rel(series, page)
            if unread > 0:
                off(prel, "a `dir:` that is not a plain string (the bare names under it cannot be placed)")
            for v in map(obs.page_name, obs.MEDIA_STR.findall(text)):  # read from the bases scene_pages gives
                if _is_url(v):
                    if v.lower().startswith("file:"):  # a file outside the series, never licensable by name
                        off(v, "a file inside the series")
                    else:
                        out.append(_url(v))
                elif hits := [b / v for b in bases if "${" not in v and _exists(b / v)]:
                    out += [obs._first(series, [h]) for h in hits]  # every folder that has it: two sets may share names
                elif v not in obs.engine_names():  # an engine suffix (".depth.png") is built from a checked name
                    off(prel, f"a file for the page name {v} (the walk cannot check what it draws)")
    mix = ep / "audio" / "mix-events.json"
    if mix.is_file():
        try:
            events = io.load_json(mix).get("events", [])
        except (OSError, ValueError, AttributeError) as e:
            bad.append(f"{mix.relative_to(series).as_posix()}: {e.__class__.__name__}")
            events = []
        try:
            spaces = io.load_json(mix).get("spaces") or {}
        except (OSError, ValueError, AttributeError):
            spaces = {}
        for sp in spaces.values() if isinstance(spaces, dict) else []:  # impulse responses the mix convolves with
            if isinstance(sp, dict) and isinstance(sp.get("ir"), str) and sp["ir"]:
                out.append(obs._first(series, [ep / sp["ir"], series / sp["ir"]]))
        for ev in events if isinstance(events, list) else []:
            if not isinstance(ev, dict) or (sc is not None and ev.get("scene") not in (sc, None)):
                continue
            dubs = ev.get("dub") if isinstance(ev.get("dub"), dict) else {}
            for f in [ev.get("file")] + [d.get("file") for d in dubs.values() if isinstance(d, dict)]:
                if isinstance(f, str) and f:
                    out.append(obs._first(series, [ep / f, series / f]))
    return out


def _exists(p: Path) -> bool:
    try:
        return p.exists()
    except (OSError, ValueError):  # a name no file system takes (a NUL from %00)
        return False


def _is_url(v: str) -> bool:
    return "://" in v or v.startswith("//")


def _url(v: str) -> str:
    """One spelling of a web address: //host/x as https://host/x, the scheme and host in lower case."""
    u = urlsplit("https:" + v if v.startswith("//") else v)
    return urlunsplit((u.scheme.lower(), u.netloc.lower(), u.path, u.query, u.fragment))


def _real(p) -> str:
    return os.path.normcase(os.path.realpath(p))


def _delivery_rows(series: Path) -> list[dict]:
    """Every parsed row of episodes/*/renders/deliveries.jsonl that names a path."""
    out = []
    for p in series.glob("episodes/*/renders/deliveries.jsonl"):
        try:
            lines = p.read_text(encoding="utf-8").splitlines()
        except OSError:
            continue
        for line in lines:
            try:
                row = json.loads(line)
            except ValueError:
                continue
            if isinstance(row, dict) and isinstance(row.get("path"), str):
                out.append(row)
    return out


def _epoch(ts) -> float | None:
    """An ISO time as seconds since the epoch (a time with no zone is local)."""
    try:
        return datetime.fromisoformat(str(ts)).timestamp()
    except (TypeError, ValueError, OverflowError, OSError):
        return None


def _old_row(series: Path, f: Path, rows: list[dict] | None = None) -> dict | None:
    """The pipeline row written before rows carried hashes that still describes f: same real path, no sha256, the
    fields finish-scenes.py and assemble-episode.py write (ts, kind, tag, mib), and the file's size within 0.01 MiB
    of the row's mib. The file must also predate the row's ts, or (a copy restored from a replica has a new mtime)
    its sha256 must match a catalog/replicas.jsonl receipt or a catalog record from no later than that ts. A
    hand-written row or a file overwritten since gets None."""
    try:
        stat = f.stat()
    except OSError:
        return None
    me = _real(f)
    for row in _delivery_rows(series) if rows is None else rows:
        if _real(row["path"]) != me or isinstance(row.get("sha256"), str):
            continue
        if not all(row.get(k) is not None for k in ("ts", "kind", "tag", "mib")):
            continue
        ts, mib = _epoch(row["ts"]), row["mib"]
        if (ts is not None and isinstance(mib, (int, float)) and not isinstance(mib, bool)
                and abs(stat.st_size / 1048576 - mib) <= 0.01
                and (stat.st_mtime <= ts + 1 or _known_before(series, f, ts))):
            return row
    return None


def _known_before(series: Path, f: Path, ts: float) -> bool:
    """f's bytes were already in the catalog (a record's seen) or on a remote (a replica receipt's at) by ts."""
    try:
        digest = sha256(f)
        rows = ac.read_log(replicas_path(series))[0] + ac.read_log(ac.catalog_path(series))[0]
    except (OSError, SystemExit):  # an unreadable log vouches for nothing
        return False
    return digest is not None and any(
        isinstance(r, dict) and r.get("sha256") == digest
        and (t := _epoch(r.get("at") if r.get("op") == "replica" else r.get("seen") if r.get("op") == "add" else None)) is not None
        and t <= ts + 1 for r in rows)


def _delivered(series: Path, rows: list[dict] | None = None) -> set[tuple[str, str]]:
    """(real path, sha256) of each file finish-scenes.py, assemble-episode.py or `assets adopt-delivery` recorded in
    renders/deliveries.jsonl. Only a row with the file's path and the sha256 of the bytes delivered counts, so a
    hand-written name, a row from before hashes were recorded, or a file overwritten since grants nothing (it is
    then licence-checked like any other, and adopt-delivery can hash it in)."""
    return {(_real(r["path"]), r["sha256"]) for r in (_delivery_rows(series) if rows is None else rows)
            if isinstance(r.get("sha256"), str)}


def _bytes_delivered(series: Path, rel: str, delivered: set) -> bool:
    try:
        digest = sha256(series / rel)
    except OSError:
        return False
    return digest is not None and (_real(series / rel), digest) in delivered


def adopt_delivery(series: Path, target: str, *, by: str, reason: str, force: bool = False) -> dict:
    """Backfill the hash of a render delivered before deliveries.jsonl rows carried one: a new row with its real path,
    the sha256 of its bytes now, who vouches for it and why. Only a file an older pipeline row still describes
    (_old_row) is adopted; anything else under renders/ (a downloaded clip parked there, a file overwritten since)
    needs force, and the row then records forced. -> the row."""
    from . import delivery_encodes as de
    if not (isinstance(by, str) and by.strip() and isinstance(reason, str) and reason.strip()):
        raise SystemExit("adopt-delivery needs --by and --reason: someone vouches that the pipeline made this file")
    t = target.replace("\\", "/")
    f = Path(t) if os.path.isabs(t) else series / t
    parts = Path(os.path.relpath(_real(f), _real(series))).as_posix().split("/") if f.is_file() else []
    if len(parts) < 4 or parts[0] != "episodes" or "renders" not in parts[2:-1]:
        raise SystemExit(f"{target}: not a file under episodes/<ep>/renders/ of {series}")
    if not force and _old_row(series, f) is None:
        raise SystemExit(f"{target}: no earlier deliveries.jsonl row from the pipeline describes these bytes (none names "
                         "it, or the file changed since), so nothing says the pipeline made it; license it in "
                         "catalog/licences.json")
    row = {"ts": io.now_iso(), "scene": ac._where("/".join(parts))["scene"], "kind": "adopted",
           "path": Path(os.path.realpath(f)).as_posix(), "file": f.name, "sha256": sha256(f), "by": by.strip(),
           "reason": reason.strip(), **({"forced": True} if force else {})}
    de.record(series / "episodes" / parts[1] / "renders" / "deliveries.jsonl", row)
    return row


def export_check(series: Path, target: str) -> dict:
    """Walk everything an export is made from: the target and its catalog parents; for a render, its scene EDL shots,
    dialogue VO, dubbed EDLs and mix (with dub takes), and a render among those inputs is walked the same way; for a
    file a job made, the job's inputs as the gen-plan lists them now. A record a job made has provenance (job, model,
    request id); only the target itself is exempt as a render. Everything else is an import and needs a
    catalog/licences.json entry (by path or asset_id) with a `source` and a `licence` or `consent`; a file the catalog
    does not know is checked the same way, by path. A file outside the series, an unreadable EDL, mix or gen-plan, and
    a walk that finds no input all fail. -> {target, checked, offenders: [{asset_id, path, role, missing}], ok}."""
    st = ac.state(series)
    a, fold = st["assets"], folder(series)
    folded = {fold(k): v for k, v in st["by_path"].items()}
    t = target.replace("\\", "/")
    if os.path.isabs(t):
        try:
            t = Path(os.path.relpath(os.path.normpath(t), os.path.normpath(series))).as_posix()
        except ValueError:
            raise SystemExit(f"{target} is not inside {series}")
    rec = a.get(t) or a.get(folded.get(fold(t), ""))
    rel = rec["path"] if rec else t
    bad: list[str] = []
    if not rec and _render_inputs(series, rel, []) is None:
        raise SystemExit(f"no asset {target} (not catalogued, and not a file under episodes/<ep>/renders/)")
    jobs = {(ep.name, j.get("id")): (ep, j) for ep, j in _plans(series)}
    drows = _delivery_rows(series)
    delivered = _delivered(series, drows)
    offenders: list[dict] = []
    todo: list[tuple[str | None, str | None]] = [(rec["asset_id"] if rec else None, rel)]  # (asset_id, path)
    seen, rows, renders = set(), [], set()
    while todo:
        aid, path = todo.pop()
        aid = aid or (folded.get(fold(path)) if path else None)
        if aid is not None and aid not in a:
            offenders.append({"asset_id": aid, "path": None, "role": None, "missing": ["a catalog record (dangling parent)"]})
            continue
        if aid is None and path is None:
            offenders.append({"asset_id": None, "path": None, "role": None, "missing": ["a file inside the series"]})
            continue
        r = a[aid] if aid else {"asset_id": None, "path": path, "role": None}
        key = aid or fold(path)
        if key in seen:
            continue
        seen.add(key)
        ins = _render_inputs(series, r["path"], bad, offenders)
        todo += [(None, p) for p in ins or []] + [(p, None) for p in r.get("parents", [])]
        src = r.get("source") or {}
        ep, j = (jobs.get((src.get("episode"), src.get("job"))) or (None, None)) if src.get("job") else (None, None)
        if j:  # the job's inputs as the gen-plan lists them now, not only the parents the last scan resolved
            refs = len(j.get("refs_used") or [])
            for k, v in enumerate(_job_inputs(j)):
                if isinstance(v, str) and v:
                    p = _series_rel(series, ep, v, from_series=k < refs)
                    if p is None:
                        offenders.append({"asset_id": None, "path": v, "role": None,
                                          "missing": [f"a file inside the series (input of job {src['job']})"]})
                    else:
                        todo.append((None, p))
        if key == (rec["asset_id"] if rec else fold(rel)) and (ins is not None or r.get("role") == "render"):
            continue  # the exported render itself: its inputs are what is checked
        if ins and _bytes_delivered(series, r["path"], delivered):
            continue  # a render the pipeline delivered (renders/deliveries.jsonl, same bytes): made of the inputs above
        if ins is not None and _old_row(series, series / r["path"], drows):
            renders.add(r["path"])  # delivered before rows carried hashes: adopt-delivery backfills it
        rows.append(r)  # anything else parked under renders/ may be an import: its own licence is checked too
    lic = {(_url(k) if _is_url(k) else k): v for k, v in licences(series).items()}
    for r in sorted(rows, key=lambda r: r["path"]):
        if (r.get("source") or {}).get("job"):
            continue  # a job's output records its job, model and request
        e = lic.get(r["path"]) or (lic.get(r["asset_id"]) if r["asset_id"] else None)
        e = e if isinstance(e, dict) else {}
        miss = ([] if _known(e.get("source")) else ["provenance"]) + (
            [] if _known(e.get("licence")) or _known(e.get("consent")) else ["licence or consent"])
        if miss and r["path"] in renders:  # or the pipeline made it from the inputs walked
            miss[-1] += " (or, delivered before rows carried hashes, assets adopt-delivery --by --reason)"
        if miss:
            offenders.append({"asset_id": r["asset_id"], "path": r["path"], "role": r.get("role"), "missing": miss})
    offenders = list({(o["asset_id"], o["path"], tuple(o["missing"])): o for o in offenders}.values())
    offenders += [{"asset_id": None, "path": x.split(":", 1)[0], "role": None, "missing": ["a readable file"]} for x in sorted(set(bad))]
    if not rows and not offenders:
        offenders.append({"asset_id": None, "path": rel, "role": None, "missing": ["any input to check"]})
    return {"target": rel, "checked": len(rows), "offenders": offenders, "ok": not offenders}
