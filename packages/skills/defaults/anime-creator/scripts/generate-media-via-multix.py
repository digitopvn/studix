#!/usr/bin/env python3
"""Run the paid jobs of an episode's gen-plan.json through multix, with guards and a full trail.

usage: generate-media-via-multix.py <episode-dir> [--jobs id,id] [--kind video] [--dry-run] [--fetch] [--retry]
                                     [--concurrency 4] [--allow-over] [--probe-ok] [--allow-seedance] [--paid-retry-ok]
  default   submit every `planned` job (images and audio finish in place; Atlas video/upscale become `submitted`)
  --fetch   download finished `submitted` jobs (Atlas status --download); a prediction the provider refused becomes
            `failed` with its error and error_code (content_blocked or rejected), so --retry picks it up
Guards: refuses a plan over the episode ceiling (--allow-over); runs only ONE job of a model whose price is not
yet measured, so the real price can be read with `anime-studio.py ledger` first (--probe-ok); refuses a second
Seedance shot in a scene (--allow-seedance); refuses a local GPU job (provider comfyui or local): those run through
generate-video-via-comfyui.py, under the machine's heavy lease. Admission (studio/admission_leases.py): a job whose
provider is limited in episode.json `admission.providers` holds one of its slots while it submits (a limit on
concurrent submits, not on predictions still running after an async submit); a job that finds no free slot within
`admission.wait_s` is held, unchanged and unpaid, and the run exits 75. Without that config no job takes a lease, so
a run behaves as before; --dry-run lists live leases. An `sfx` job with `mode: video-to-audio` makes Foley from its clip
through a fal adapter of engines.json role sound-generation (studio/sound_generation_adapters.py). A `tts` job whose
voice routes to Fish Audio Drama 3 (provider openrouter or fish, studio/voice_direction.py) is checked against the
character's pinned voice, priced per UTF-8 byte sent, written to a new revision file, and saves its billing receipt;
one that failed after its request went out is not retried without --paid-retry-ok. Others are unchanged. Every job writes logs/jobs/<id>.log (redacted), updates
gen-plan.json (under gen-plan.json.lock, merging by job id, so a background --fetch and a new submit on one
episode keep each other's jobs), appends Atlas ids to logs/predictions.log and traces gen_submit / gen_done / error.
Supported: macOS, Linux, Windows. Needs multix on PATH with keys in ~/.multix/.env, and network access.
"""
from __future__ import annotations

import argparse
import copy
import json
import os
import shutil
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from studio import admission_leases as adm  # noqa: E402
from studio import common_io_and_paths as io  # noqa: E402
from studio import edl_validation_and_budget as vb  # noqa: E402
from studio import engine_routing as er  # noqa: E402
from studio import multix_job_commands as mx  # noqa: E402
from studio import shot_prompt_compiler as sp  # noqa: E402
from studio import sound_generation_adapters as sg  # noqa: E402
from studio import storage_policy_and_replication as stg  # noqa: E402
from studio import telemetry_trace_and_ledger as tl  # noqa: E402
from studio import voice_direction as vd  # noqa: E402

ASYNC = {"video", "upscale", "run"}
LOCK = threading.Lock()
HELD = 75  # EX_TEMPFAIL: some jobs found no free provider slot; nothing was submitted for them, run again later


def local_gpu(job: dict) -> str | None:
    """Why this runner refuses a job on the local GPU, or None. multix only reaches cloud providers."""
    if adm.resource_of(job) == "gpu-local":
        return "a local GPU job: run it with generate-video-via-comfyui.py, which holds the machine's heavy lease"
    return None


def sh(cmd: list[str], log: Path) -> str:
    r = subprocess.run(io.resolve_cmd(cmd), capture_output=True, text=True, encoding="utf-8", errors="replace")
    out = io.redact((r.stdout or "") + "\n" + (r.stderr or ""))
    with LOCK, log.open("a", encoding="utf-8") as f:
        f.write("$ " + " ".join(c if len(c) < 160 else c[:160] + "..." for c in cmd) + "\n" + out + f"\nexit {r.returncode}\n")
    if r.returncode:
        raise CmdError(out.strip().splitlines()[-1] if out.strip() else f"exit {r.returncode}", out)
    return out


class PlanSaveError(Exception):
    """gen-plan.json could not be written: not one of the errors run_job turns into a failed job, so it stops the run."""


class CmdError(RuntimeError):
    """A failed command: the message is its last line, `output` the whole redacted text."""
    def __init__(self, msg: str, output: str):
        super().__init__(msg)
        self.output = output


BASE = ("status", "pred_id")  # what a job's update was computed from; another process moving them makes it stale


def merge_jobs(disk: dict, mine: list[dict], changed: dict[str, set], loaded=frozenset(), base: dict | None = None,
               stale: list | None = None) -> dict:
    """Write only what this process changed onto the plan on disk now: the fields it set on the jobs it touched.
    Jobs and fields another process added since this one loaded the plan survive. A job in `loaded` (read at start)
    that is gone from disk was removed by hand: it is not written back. With `base` ({id: job as this process last
    saw it}), a job whose status or pred_id moved on disk since then (another run failed, retried or fetched it) is
    left alone and its id appended to `stale`: an old prediction's result never overwrites a newer submission."""
    by_id = {j["id"]: j for j in disk.setdefault("jobs", []) if isinstance(j, dict) and "id" in j}  # skip hand-made junk
    for j in mine:
        if j["id"] not in changed:
            continue
        if j["id"] not in by_id:
            if j["id"] in loaded:
                print(f"{j['id']}: removed from gen-plan.json while running; its result is not written back", file=sys.stderr)
            else:
                disk["jobs"].append(dict(j))
            continue
        was = (base or {}).get(j["id"])
        if was is not None and any(by_id[j["id"]].get(f) != was.get(f) for f in BASE):
            if stale is not None:
                stale.append(j["id"])
            continue
        for f in changed[j["id"]]:
            if f in j:
                by_id[j["id"]][f] = j[f]
            else:
                by_id[j["id"]].pop(f, None)
    return disk


def unspent_foley(j: dict) -> bool:
    """A planned or failed video-to-audio job with no provider request yet: nothing paid, so it may be re-routed or
    refused. A failed one that kept its request id may have been billed; it stays in the ceiling and resumes."""
    return j.get("status", "planned") in ("planned", "failed") and not (j.get("request_id") or j.get("pred_id"))


class Runner:
    def __init__(self, ep: Path, a: argparse.Namespace):
        self.ep, self.a = ep, a
        self.series = ep.parents[1]
        self.plan_p = ep / "gen-plan.json"
        if not getattr(a, "dry_run", False):
            self.merge_unsaved()
        elif (ep / "logs/unsaved-jobs.jsonl").exists():  # a dry run merges nothing: its preview may list paid jobs
            print("logs/unsaved-jobs.jsonl has paid updates not merged yet; a real run merges them first, "
                  "so jobs listed here may already be paid", file=sys.stderr)
        self.plan = io.load_json(self.plan_p)
        # each job as last read or written; save() merges only the fields that differ from it, however they changed
        self.snap = {j["id"]: copy.deepcopy(j) for j in self.plan.get("jobs", []) if isinstance(j, dict) and "id" in j}
        self.stop = threading.Event()  # set when the plan cannot be saved: queued jobs must not submit and pay
        self.prices = io.load_json(io.TEMPLATES / "price-table.json")
        local = self.series / "price-table.json"
        if local.exists():
            self.prices["items"].update(io.load_json(local).get("items", {}))
        self.chars = {p.stem: io.load_json(p) for p in (self.series / "bible/characters").glob("*.json")}
        self.admission = adm.config(ep)
        self.held: list[str] = []  # jobs no provider slot admitted: the run exits HELD
        # a video-to-audio job may name only its engine: price and probe it as the adapter's model, per second
        doc, self.v2a_blocked = None, {}
        policy = (io.load_json(ep / "episode.json") if (ep / "episode.json").exists() else {}).get("license_policy", {})
        for j in self.plan.get("jobs", []):
            # priced per second as the routed adapter; select() refuses one with no duration rather than guess
            if j.get("kind") == "sfx" and j.get("mode") == "video-to-audio" and unspent_foley(j):
                doc = doc or er.load(ep)
                served = {a.get("model") for a in ((doc.get("roles") or {}).get("sound-generation") or {}).get("adapters", {}).values()}
                if not j.get("engine") and (not j.get("model") or j["model"] not in served):
                    j["engine"] = "auto"  # saved with the job, so a later run still walks `order` instead of the model below
                try:  # every run, so a licence change shows up before submit; price it as what run_job will call
                    j["model"] = sg.route(doc, j, policy)[1]["model"]
                except sg.Blocked as e:
                    self.v2a_blocked[j["id"]] = str(e)
                if j.get("duration"):
                    j["units"] = j["duration"]
        # Drama 3 lines: validated against the pinned voice and priced by the UTF-8 bytes actually sent
        self.tts_lines, self.tts_blocked = {}, {}
        for j in self.plan.get("jobs", []):
            if j.get("kind") != "tts" or j.get("status", "planned") not in ("planned", "failed"):
                continue
            v = j.get("voice") or self.chars.get(j.get("speaker") or "", {}).get("voice")
            if not vd.is_drama3(j, v):
                continue
            pinned = self.chars.get(j.get("speaker") or "", {}).get("voice")
            try:
                line = vd.validate_line({**j, "pinned_voice": pinned if isinstance(pinned, dict) else None}, v)
            except vd.DirectionError as e:
                self.tts_blocked[j["id"]] = str(e)
                continue
            self.tts_lines[j["id"]] = line
            j["model"], j["units"] = line["price_key"], line["utf8_bytes"]
        (ep / "logs/jobs").mkdir(parents=True, exist_ok=True)

    def drama3(self, job: dict, log: Path) -> None:
        """One Drama 3 request: the directed text from a UTF-8 file, a fresh revision path, the receipt saved."""
        line, ep = self.tts_lines[job["id"]], self.ep
        out = vd.next_revision(job["out"], lambda rel: (ep / rel).exists())
        (ep / out).parent.mkdir(parents=True, exist_ok=True)
        txt = ep / "logs/tts-text" / f"{job['id']}.txt"
        txt.parent.mkdir(parents=True, exist_ok=True)
        txt.write_text(line["directed_text"], encoding="utf-8")
        est = self.estimate(job)
        self.save(job, request_sent=True, out=out)  # saved first: a crash after this may have been billed
        res = sh(vd.tts_cmd(line, job, str(txt), str(ep / out)), log)
        try:
            result = json.loads(next(ln for ln in reversed(res.splitlines()) if ln.strip().startswith("{")))
        except (StopIteration, ValueError):
            result = {}
        revs = list(job.get("revisions") or [])
        revs.append({"out": out, "generation_id": result.get("generation_id"), "cost_usd": result.get("cost_usd")})
        self.save(job, status="done", revisions=revs, **vd.receipt(result, line, est))

    def save(self, job: dict, **upd) -> None:
        """Write job's changes since it was loaded or last saved (fields set here or in place, such as a request id
        an adapter recorded before failing) onto the plan on disk now. Routing staged on jobs this run never saves
        stays in memory, so a background --fetch does not overwrite what a submit run recorded."""
        with LOCK:  # threads of this process; the file lock covers other processes on the same episode
            job.update(upd)
            if upd.get("status") in ("submitted", "done"):
                job.pop("error", None)
                job.pop("error_code", None)
            old = self.snap.get(job["id"], {})
            fields = {f for f in job.keys() | old.keys() if f not in job or f not in old or job[f] != old[f]}
            stale: list = []
            try:
                io.update_json_locked(self.plan_p, lambda disk: merge_jobs(disk, [job], {job["id"]: fields}, self.snap.keys(),
                                                                           {job["id"]: old} if old else None, stale))
            except (Exception, SystemExit) as e:  # any failed write: a paid result must reach the unsaved log
                self.stop.set()
                # every unsaved update lands here (paid jobs finishing on other threads too); the next run merges it
                row = {"id": job["id"], "base": {f: old.get(f) for f in BASE},
                       "fields": {f: job[f] for f in sorted(fields) if f in job}, "removed": sorted(f for f in fields if f not in job)}
                held = f" (pred_id {job['pred_id']})" if job.get("pred_id") else ""
                try:
                    io.retry_sharing(lambda: self.append_unsaved(row))
                    where = "its update is in logs/unsaved-jobs.jsonl, merged by the next run"
                except OSError as e2:  # still a PlanSaveError: a caller must never record this paid job as failed
                    where = f"logs/unsaved-jobs.jsonl is not writable either ({e2}); add this to it by hand: {json.dumps(row)}"
                raise PlanSaveError(f"could not save {job['id']}{held} to {self.plan_p.name}: {e}; {where}") from e
            if stale:
                print(f"{job['id']}: another run moved it on (status/pred_id changed) since this one read it; "
                      f"this result{' for ' + job['pred_id'] if job.get('pred_id') else ''} is not written", file=sys.stderr)
            self.snap[job["id"]] = copy.deepcopy(job)

    def merge_unsaved(self) -> None:
        """Apply logs/unsaved-jobs.jsonl from a run whose plan save failed, before anything is selected, so its paid
        jobs are not submitted again. Each row merges only if its job still has the status and pred_id it started from."""
        p = self.ep / "logs/unsaved-jobs.jsonl"
        left = [(f, 2) for f in p.parent.glob("unsaved-jobs.*.merging.jsonl")]
        left += [(f, 1) for f in p.parent.glob("unsaved-jobs.*.handback.jsonl")]
        for old, at in sorted(left):  # a run killed mid-merge or mid-handback: its rows come back
            pid = old.name.split(".")[at]
            if pid.isdigit() and int(pid) != os.getpid() and not io.pid_alive(int(pid)):
                self.hand_back(old)
        if not p.exists():
            return
        # claim the file first: rows a still-running run appends after this go to a fresh file for the next run
        claimed = p.with_name(f"unsaved-jobs.{time.strftime('%Y%m%d-%H%M%S')}.{os.getpid()}.merging.jsonl")
        try:
            io.retry_sharing(lambda: p.replace(claimed))
        except FileNotFoundError:  # another run claimed it
            return
        rows = []
        for n, ln in enumerate(claimed.read_text(encoding="utf-8").splitlines(), 1):
            if not ln.strip():
                continue
            try:
                rows.append(json.loads(ln))
            except ValueError:  # cut off mid-write by a killed run: kept in the archive, said so
                print(f"{claimed.name}:{n}: unreadable row skipped; check that job by hand", file=sys.stderr)
        stale: list = []

        def apply(disk):
            for r in rows:
                merge_jobs(disk, [{"id": r["id"], **r["fields"]}], {r["id"]: set(r["fields"]) | set(r.get("removed", []))},
                           {r["id"]}, {r["id"]: r.get("base") or {}}, stale)
            return disk
        try:
            io.update_json_locked(self.plan_p, apply)
        except (Exception, SystemExit):  # the rows go back so the next run merges them before selecting
            self.hand_back(claimed)
            raise
        claimed.replace(claimed.with_name(claimed.name.replace(".merging.", ".merged.")))
        print(f"merged {len(rows) - len(stale)} unsaved job update(s) from {p.name}"
              + (f"; skipped {', '.join(stale)} (moved on since)" if stale else ""), file=sys.stderr)

    def append_unsaved(self, row: dict) -> None:
        with (self.ep / "logs/unsaved-jobs.jsonl").open("a", encoding="utf-8") as f:
            f.write(json.dumps(row) + "\n")

    def hand_back(self, src: Path) -> None:
        """Return a claimed unsaved log's rows to logs/unsaved-jobs.jsonl; renamed first so only one run adopts it."""
        mine = src.with_name(f"unsaved-jobs.{os.getpid()}.handback.jsonl")
        try:
            io.retry_sharing(lambda: src.replace(mine))
        except FileNotFoundError:  # another run adopted it
            return
        text = mine.read_text(encoding="utf-8")
        with (self.ep / "logs/unsaved-jobs.jsonl").open("a", encoding="utf-8") as f:
            f.write(text if text.endswith("\n") or not text else text + "\n")
        mine.unlink()

    def log_pred(self, pid: str, job: dict) -> None:
        with LOCK, (self.ep / "logs/predictions.log").open("a", encoding="utf-8") as f:
            f.write(f"{pid} {job['kind']} {job['id']} {job.get('model', '')}\n")

    def upload(self, path: Path, log: Path) -> str:
        url = mx.parse_upload_url(sh(mx.upload_cmd(path), log))
        if not url:
            raise RuntimeError(f"upload gave no URL for {path.name}")
        return url

    def estimate(self, job: dict) -> float | None:
        try:
            return vb.estimate_job(job, self.prices)
        except KeyError:
            return None

    def one(self, job: dict) -> None:
        """Run one job under the leases it needs; a job with no free slot is held and stays as it was."""
        if self.stop.is_set():
            return
        if local_gpu(job):
            print(f"{job['id']}: refused, {local_gpu(job)}")
            return
        voice = self.chars.get(job.get("speaker") or "", {}).get("voice")
        need = adm.needs(job, self.admission, voice)
        try:
            held = adm.acquire_all(self.series, need, {"job": job["id"], "episode": self.ep.name, "series": self.series.resolve().as_posix(),
                                                       "out": (self.ep / str(job.get("out") or "")).resolve().as_posix(),
                                                       "resource": adm.resource_of(job),
                                                       "provider": adm.provider_of(job, voice)},
                                   ttl=self.admission["ttl_s"], wait=self.admission["wait_s"], stop=self.stop) if need else []
        except adm.Busy as e:
            with LOCK:
                self.held.append(job["id"])
            print(f"{job['id']}: held, {e}; still {job.get('status', 'planned')}, nothing submitted")
            return
        try:
            self.submit(job)
        finally:
            for lease in held:
                adm.release(lease)

    def submit(self, job: dict) -> None:
        if self.stop.is_set():
            return
        k, ep, log = job["kind"], self.ep, self.ep / "logs/jobs" / f"{job['id']}.log"
        tl.trace(ep, "gen_submit", shot=job.get("shot"), detail=f"{k} {job['id']}", tool="multix", model=job.get("model"))
        try:
            if k in ("sheet", "keyframe"):
                c = sp.compile_prompt(self.series, job, max_refs=job.get("max_refs", 3))
                tmp = ep / "gen/keyframes" / f"_{job['id']}"
                out = sh(mx.image_cmd(job, job.get("prompt_final") or c["prompt"], c["refs"], tmp), log)
                pid = mx.parse_pred_id(out)
                img = next((f for f in sorted(tmp.glob("*")) if f.suffix.lower() in (".png", ".jpg", ".jpeg", ".webp")), None)
                if not img:
                    raise RuntimeError("no image downloaded")
                dest = ep / job.get("out", f"gen/keyframes/{job['id']}.png")
                io.run(["ffmpeg", "-v", "error", "-y", "-i", str(img), str(dest)]) if img.suffix.lower() != ".png" else shutil.move(str(img), dest)
                shutil.rmtree(tmp, ignore_errors=True)
                if pid:
                    self.log_pred(pid, job)
                self.save(job, status="done", pred_id=pid, out=dest.relative_to(ep).as_posix(), prompt_used=c["prompt"], refs_used=c["refs"])
            elif k == "video":
                c = sp.compile_prompt(self.series, job)
                if job.get("last") and (job.get("model") or "").startswith(mx.NO_FIRST_FRAME):
                    raise ValueError(f"{job['id']}: {job['model']} has no last-frame field; drop `last`")
                u1 = self.upload(ep / job["first"], log)
                u2 = self.upload(ep / job["last"], log) if job.get("last") else None
                pay = ep / "logs/payloads" / f"{job['id']}.json"
                pay.parent.mkdir(parents=True, exist_ok=True)
                pay.write_text(mx.dumps(mx.video_payload(job, job.get("prompt_final") or c["prompt"], u1, u2)), encoding="utf-8")
                pid = mx.parse_pred_id(sh(mx.run_cmd(job.get("model") or mx.DEFAULT_MODELS["video"], pay), log))
                if not pid:
                    raise RuntimeError("no prediction id")
                self.log_pred(pid, job)
                self.save(job, status="submitted", pred_id=pid, prompt_used=c["prompt"])
            elif k == "upscale":
                pay = ep / "logs/payloads" / f"{job['id']}.json"
                pay.parent.mkdir(parents=True, exist_ok=True)
                pay.write_text(mx.dumps(mx.upscale_payload(job, self.upload(ep / job["input"], log))), encoding="utf-8")
                pid = mx.parse_pred_id(sh(mx.run_cmd(job.get("model") or mx.DEFAULT_MODELS["upscale"], pay, video=True), log))
                if not pid:
                    raise RuntimeError("no prediction id")
                self.log_pred(pid, job)
                self.save(job, status="submitted", pred_id=pid)
            elif k == "run":
                payload = dict(job["payload"])
                for field, path in (job.get("uploads") or {}).items():
                    payload[field] = self.upload(ep / path, log)
                pay = ep / "logs/payloads" / f"{job['id']}.json"
                pay.parent.mkdir(parents=True, exist_ok=True)
                pay.write_text(mx.dumps(payload), encoding="utf-8")
                pid = mx.parse_pred_id(sh(mx.run_cmd(job["model"], pay, video=job.get("video", False)), log))
                if not pid:
                    raise RuntimeError("no prediction id")
                self.log_pred(pid, job)
                self.save(job, status="submitted", pred_id=pid)
            elif k == "sfx" and job.get("mode") == "video-to-audio":  # Foley from the picture, via multix fal
                policy = (io.load_json(ep / "episode.json") if (ep / "episode.json").exists() else {}).get("license_policy", {})
                self.save(job, **sg.run_job(ep, job, er.load(ep), sh, log, policy))
            elif k == "tts" and job["id"] in self.tts_lines:
                self.drama3(job, log)
            elif k == "qa":
                prompts = mx.qa_prompts(io.TEMPLATES / "qa-prompts.md")
                q = prompts[job.get("qa", "clip")].replace("{{BRIEF}}", job.get("brief", "")).replace("{{LINES}}", job.get("lines", ""))
                res = mx.qa_result(sh(mx.qa_cmd(ep / job["input"], q), log))
                dest = ep / "logs/qa" / f"{Path(job['input']).stem}.{job.get('qa', 'clip')}.txt"
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_text(res + "\n", encoding="utf-8")
                self.save(job, status="done", out=dest.relative_to(ep).as_posix(), provider="gemini", cost_usd=self.estimate(job), cost_basis="estimate")
            else:
                if k == "isolate":  # the isolator wants a few seconds of audio
                    padded = ep / "gen/audio" / f"{job['id']}-pad.wav"
                    io.run(["ffmpeg", "-v", "error", "-y", "-i", str(ep / job["input"]), "-af", "apad=whole_dur=5", "-ac", "1", "-ar", "44100", str(padded)])
                    job["input_padded"] = padded.relative_to(ep).as_posix()
                (ep / job["out"]).parent.mkdir(parents=True, exist_ok=True)
                # the job's own voice wins, as in audio_cmd: the receipt must name the provider that actually ran
                voice = job.get("voice") or self.chars.get(job.get("speaker") or "", {}).get("voice")
                sh(mx.audio_cmd(job, ep, lambda c: self.chars.get(c or "", {}).get("voice")), log)
                if k == "align" and job.get("shot") and job.get("scene"):
                    edl_p = ep / "scenes" / job["scene"] / "edl.json"
                    with LOCK:  # parallel align jobs share one EDL: read-modify-write it one at a time
                        io.save_json(edl_p, mx.apply_alignment(io.load_json(edl_p), job["shot"], job.get("line", 0), io.load_json(ep / job["out"])))
                provider = mx.tts_provider(job, voice) if k == "tts" else "elevenlabs"
                self.save(job, status="done", provider=provider, cost_usd=self.estimate(job), cost_basis="estimate")
            tl.trace(ep, "gen_done", shot=job.get("shot"), detail=f"{k} {job['id']} {job.get('status')}", pred_id=job.get("pred_id"), tool="multix")
            print(f"{job['id']}: {job['status']}" + (f" {job.get('pred_id')}" if job.get("pred_id") else ""))
        except (RuntimeError, ValueError, KeyError, OSError, SystemExit) as e:
            gone = mx.fetch_failure(getattr(e, "output", ""))  # the provider's message beats multix's last hint line
            if not gone:
                job.pop("error_code", None)  # a code from an earlier refusal does not describe this failure
            self.save(job, status="failed", error=io.redact(gone["error"] if gone else str(e))[:300],
                      **({"error_code": gone["error_code"]} if gone else {}))
            tl.trace(ep, "error", shot=job.get("shot"), detail=f"{k} {job['id']}: {io.redact(str(e))[:200]}", tool="multix")
            print(f"{job['id']}: FAILED {io.redact(str(e))[:200]}")

    def fetch(self, job: dict) -> None:
        if self.stop.is_set():
            return
        sub = {"video": "gen/video", "upscale": "upscaled"}.get(job["kind"], "gen/other")
        dest = self.ep / job.get("out", f"{sub}/{job['id']}.mp4")
        dest.parent.mkdir(parents=True, exist_ok=True)
        try:
            sh(mx.fetch_cmd(job["pred_id"], dest), self.ep / "logs/jobs" / f"{job['id']}.log")
            self.save(job, status="done", out=dest.relative_to(self.ep).as_posix())
            tl.trace(self.ep, "gen_done", shot=job.get("shot"), detail=f"{job['kind']} {job['id']} downloaded", pred_id=job["pred_id"])
            print(f"{job['id']}: done -> {dest.relative_to(self.ep)}")
        except RuntimeError as e:
            gone = mx.fetch_failure(getattr(e, "output", str(e)), job["pred_id"])
            if not gone:
                print(f"{job['id']}: not ready ({e})")
                return
            # a refused prediction is final: mark it failed so --retry picks it up and the ledger stops showing it pending
            self.save(job, status="failed", error=io.redact(gone["error"])[:300], error_code=gone["error_code"])
            tl.trace(self.ep, "error", shot=job.get("shot"), detail=f"{job['kind']} {job['id']}: {gone['error_code']}: {job['error']}"[:300],
                     pred_id=job["pred_id"])
            print(f"{job['id']}: FAILED {gone['error_code']}: {job['error'][:200]}"
                  + (" (rephrase before --retry)" if gone["error_code"] == "content_blocked" else " (fix the request before --retry)"))


def select(r: Runner, a: argparse.Namespace) -> list[dict]:
    want = set(a.jobs.split(",")) if a.jobs else None
    states = {"submitted"} if a.fetch else ({"planned", "failed"} if a.retry else {"planned"})
    jobs = [j for j in r.plan["jobs"] if j.get("status", "planned") in states and (not want or j["id"] in want)
            and (not a.kind or j["kind"] == a.kind)]
    if a.fetch:
        return [j for j in jobs if j.get("pred_id")]
    def refused(j: dict) -> str | None:  # only jobs that have not spent anything; a paid job's cost stays in the budget
        if local_gpu(j):
            return local_gpu(j)
        if j.get("kind") == "sfx" and j.get("mode") == "video-to-audio" and unspent_foley(j):
            return r.v2a_blocked.get(j["id"]) or (None if j.get("duration") else "a video-to-audio job needs `duration` (seconds) to be priced")
        blocked, lines = getattr(r, "tts_blocked", {}), getattr(r, "tts_lines", {})
        if j["id"] in blocked:
            return blocked[j["id"]]
        if j["id"] in lines:
            if r.estimate(j) is None:  # an unconfirmed price never runs: no guessing what a paid call costs
                return f"no current price for {j['model']}; re-check the provider price and update price-table.json"
            if j.get("status") == "failed" and j.get("request_sent") and not a.paid_retry_ok:
                return ("its last request went out and may have been billed; check the provider's usage, then pass "
                        "--paid-retry-ok to send it again")
        return None
    ep = io.load_json(r.ep / "episode.json")
    b = vb.budget({**r.plan, "jobs": [j for j in r.plan["jobs"] if not refused(j)]}, r.prices, ep["ceiling_usd"])
    if b["over_ceiling"] and not a.allow_over:
        sys.exit(f"plan ${b['planned_usd']} is over the ceiling ${ep['ceiling_usd']}: cut takes or tiers, or pass --allow-over after the user agrees")
    if b["unknown_prices"]:
        print("unpriced models (add them to the price table): " + "; ".join(b["unknown_prices"]))
    keep, probing = [], set()
    measured_done = {j.get("model") for j in r.plan["jobs"] if j.get("status") == "done"}
    for j in jobs:
        if refused(j):
            print(f"{j['id']}: refused, {refused(j)}")
            continue
        m = j.get("model") or mx.DEFAULT_MODELS.get(j["kind"])
        basis = (r.prices["items"].get(m or "") or {}).get("basis", "unknown")
        # one probe per unmeasured model before a batch; calls under 5 cents are not worth the round-trip
        if basis != "measured" and m not in measured_done and not a.probe_ok and (r.estimate(j) or 1.0) >= 0.05:
            if m in probing:
                print(f"{j['id']}: held until the price of {m} is measured (one probe job runs first; then `anime-studio.py ledger`)")
                continue
            probing.add(m)
        if "seedance" in str(m) and not a.allow_seedance:
            same = [x for x in r.plan["jobs"] if "seedance" in str(x.get("model")) and x.get("scene") == j.get("scene") and x.get("status") != "cancelled"]
            if len(same) > 1:
                print(f"{j['id']}: refused, more than one Seedance shot in scene {j.get('scene')} (--allow-seedance)")
                continue
        keep.append(j)
    return keep


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("episode")
    for f in ("--jobs", "--kind"):
        ap.add_argument(f)
    ap.add_argument("--concurrency", type=int, default=4, help="ElevenLabs allows 5 concurrent requests; 4 leaves headroom")
    for f in ("--dry-run", "--fetch", "--retry", "--allow-over", "--probe-ok", "--allow-seedance", "--paid-retry-ok"):
        ap.add_argument(f, action="store_true")
    a = ap.parse_args()
    if not io.have("multix") and not a.dry_run:
        sys.exit("multix not on PATH (npm i -g @mrgoonie/multix@<version>; `multix update` is unreliable)")
    r = Runner(Path(a.episode).expanduser().resolve(), a)
    jobs = select(r, a)
    for j in jobs:
        est = r.estimate(j)
        print(f"{'fetch' if a.fetch else 'run'} {j['id']:12s} {j['kind']:12s} {str(j.get('model') or mx.DEFAULT_MODELS.get(j['kind'], '')):48s} "
              + (f"~${est:.3f}" if est is not None else "unpriced"))
    if a.dry_run:
        for x in adm.listing(r.series):
            if x["live"]:
                print(f"lease {x['key']}.{x.get('slot')} held by pid {x.get('pid')} on {x.get('host')} "
                      f"({x.get('episode')} {x.get('job')}) until {x['expires']}")
    if a.dry_run or not jobs:
        return
    # opt-in: only a series with catalog/policy.json reserves disk space; a fetch downloads jobs already paid for
    full = None if a.fetch else stg.preflight(r.series)
    if full:
        sys.exit(full)
    unsaved = []
    with ThreadPoolExecutor(max_workers=max(1, a.concurrency)) as pool:
        for fut in as_completed([pool.submit(r.fetch if a.fetch else r.one, j) for j in jobs]):
            try:
                fut.result()
            except (Exception, SystemExit) as e:  # each one: a job in flight on another thread may have paid too
                r.stop.set()  # whatever broke, queued jobs return without submitting
                print(f"{'NOT SAVED' if isinstance(e, PlanSaveError) else 'ERROR'}: {e}", file=sys.stderr)
                unsaved.append(e)
    if unsaved:
        saved = "" if not any(isinstance(e, PlanSaveError) for e in unsaved) else \
            "; unsaved plan updates are in logs/unsaved-jobs.jsonl and the next run merges them"
        sys.exit(f"stopped: {len(unsaved)} job(s) failed outside their own error handling{saved}")
    if getattr(r, "held", None):  # a fetch never takes a slot
        print(f"held {len(r.held)} job(s) for a provider slot ({', '.join(sorted(r.held))}); nothing submitted for them, "
              "run again later", file=sys.stderr)
        sys.exit(HELD)


if __name__ == "__main__":
    main()
