"""Sound generation by capability: text-to-audio (ElevenLabs SFX, the legacy path) or video-to-audio Foley (fal through
multix: MMAudio V2, HunyuanVideo-Foley), routed from engines.json role `sound-generation`. Pure helpers plus run_job(),
which takes the runner's shell function so tests can drive it offline (generate-media-via-multix.py calls it).

A gen-plan `sfx` job keeps working unchanged: no `mode` means text-to-audio on ElevenLabs. `mode: video-to-audio`
picks an adapter by capability, duration limits and license policy (`engine: auto`) or by name, maps the shared job
fields onto that model's inputs (the mapping lives in the adapter entry, not in code), runs
`multix fal run <model> --input @payload --no-download`, downloads the result MP4 and extracts a 48 kHz PCM WAV with a
JSON sidecar (model, request id, source clip sha256, EDL in-point and speed, prompt, seed, offset, duration, cost
basis, license). No fal HTTP client lives in this skill; FAL_KEY stays in multix's own key store.

A local clip is never passed off as a URL: it goes as an HTTPS URL the user controls (`video_url`), or as a base64
data URI under the adapter's `data_uri_max_bytes` (the fal API accepts data URIs; nothing is published). Larger
local files wait for a multix fal upload command (mrgoonie/multix-cli#284).
"""
from __future__ import annotations

import base64
import json
import re
import urllib.request
from pathlib import Path

from .engine_routing import json_reply
from .reference_roles import sha256

MODES = ("text-to-audio", "video-to-audio")
MIX_BUSES = ("hits", "beds")  # V2A never writes vo or music
REQ_RX = re.compile(r"""["']?request[_ ]?id["']?\s*[:=]\s*["']?([0-9a-f][0-9a-f-]{15,})""", re.I)


class Blocked(RuntimeError):
    """A job that cannot run as asked (no valid input URL, license policy, duration); says what is missing."""


def mode_of(job: dict) -> str:
    m = job.get("mode") or "text-to-audio"
    if m not in MODES:
        raise Blocked(f"{job.get('id')}: mode {m!r} is not one of {MODES}")
    return m


def license_ok(adapter: dict, policy: dict) -> tuple[bool, str]:
    lic = adapter.get("license") or {}
    use = policy.get("use", "commercial")
    allowed = lic.get(use)
    if allowed is True:
        return True, ""
    if allowed is None and policy.get("allow_unknown_license"):
        return True, "license unknown, allowed by policy"
    return False, f"license for {use} use is {'unknown' if allowed is None else 'not granted'} ({lic.get('note', 'no note')})"


def route(doc: dict, job: dict, policy: dict | None = None) -> tuple[str, dict]:
    """-> (adapter name, adapter). An explicit engine (or a `model` an adapter serves) wins after its checks; `auto`
    takes the role default for text-to-audio and the first eligible adapter in `order` for video-to-audio. Never
    random, and video-to-audio is never chosen for a job that did not ask for it."""
    policy = policy or {}
    role = (doc.get("roles") or {}).get("sound-generation") or {}
    adapters = role.get("adapters") or {}
    mode = mode_of(job)
    by_model = next((n for n, a in adapters.items() if job.get("model") and a.get("model") == job.get("model")), None)
    name = job.get("engine") or by_model or "auto"
    if name != "auto":
        names = [name]
    else:  # text-to-audio keeps the default (the legacy SFX path); video-to-audio walks `order`
        names = [role.get("default")] if mode == "text-to-audio" else (role.get("order") or list(adapters))
    reasons = []
    for n in names:
        ad = adapters.get(n)
        if not ad:
            reasons.append(f"{n}: not in engines.json")
            continue
        if mode not in ad.get("capabilities", []):
            reasons.append(f"{n}: no {mode}")
            continue
        if str(ad.get("status", "")).startswith("rejected"):
            reasons.append(f"{n}: rejected")
            continue
        ok, why = license_ok(ad, policy)
        if not ok:
            reasons.append(f"{n}: {why}")
            continue
        dur, lim = job.get("duration"), ad.get("duration_s") or {}
        if dur is not None and (dur < lim.get("min", 0) or dur > lim.get("max", 1e9)):
            reasons.append(f"{n}: duration {dur}s outside {lim}")
            continue
        return n, ad
    raise Blocked(f"{job.get('id')}: no sound-generation adapter for {mode}: " + "; ".join(reasons))


def video_url(job: dict, ep: Path, adapter: dict) -> tuple[str, str]:
    """-> (url, how). An https `video_url` first; else a data URI of the local `input` if small enough."""
    url = job.get("video_url") or ""
    if url.startswith("https://"):
        return url, "https"
    if url:
        raise Blocked(f"{job.get('id')}: video_url must be https (got a {url.split(':', 1)[0]} URL)")
    src = ep / job.get("input", "")
    if not job.get("input") or not src.is_file():
        raise Blocked(f"{job.get('id')}: no video_url and input clip {job.get('input')!r} is missing")
    cap = int(adapter.get("data_uri_max_bytes") or 0)
    size = src.stat().st_size
    if cap and size <= cap:
        return "data:video/mp4;base64," + base64.b64encode(src.read_bytes()).decode(), "data-uri"
    raise Blocked(f"{job.get('id')}: local clip {src.name} is {size / 1e6:.1f} MB (data URI cap {cap / 1e6:.1f} MB); give an https "
                  "video_url you control, or wait for multix fal upload (mrgoonie/multix-cli#284)")


def payload(adapter: dict, job: dict, url: str) -> dict:
    """Shared job fields -> this model's inputs through adapter.input_map ({model_key: job_field}); unset fields drop."""
    values = {**(adapter.get("defaults") or {}), **{k: v for k, v in job.items() if v not in (None, "")}, "video_url": url}
    out = {}
    for key, field in (adapter.get("input_map") or {}).items():
        if field in values:
            out[key] = values[field]
    missing = [k for k in adapter.get("required", []) if k not in out]
    if missing:
        raise Blocked(f"{job.get('id')}: {adapter.get('model')} needs {', '.join(missing)}")
    return out


def run_cmd(adapter: dict, payload_file: Path) -> list[str]:
    return ["multix", "fal", "run", adapter["model"], "--input", f"@{payload_file}", "--no-download",
            "--wait-timeout", str(adapter.get("wait_ms", 600000))]


def result_cmd(adapter: dict, request_id: str) -> list[str]:
    """Resume a request that was submitted but timed out locally: fetch its result instead of submitting again."""
    return ["multix", "fal", "result", adapter["model"], request_id]


def parse_result(text: str) -> dict:
    """-> {video_url, request_id}; either may be None. Accepts the bare result or {data: ..., requestId}."""
    doc = json_reply(text) or {}
    data = doc.get("data", doc) if isinstance(doc, dict) else {}
    vid = (data.get("video") or {}).get("url") if isinstance(data.get("video"), dict) else None
    rid = doc.get("requestId") or doc.get("request_id") if isinstance(doc, dict) else None
    if not rid:
        m = REQ_RX.search(text)
        rid = m.group(1) if m else None
    return {"video_url": vid, "request_id": rid}


def extract_wav_cmd(src: Path, out: Path, *, rate: int = 48000) -> list[str]:
    return ["ffmpeg", "-v", "error", "-n", "-i", str(src), "-vn", "-ac", "2", "-ar", str(rate), "-c:a", "pcm_s24le", str(out)]


def sidecar(job: dict, name: str, adapter: dict, *, request_id: str | None, source: Path | None, how: str,
            edl_shot: dict | None, duration: float | None) -> dict:
    return {"schema_version": 1, "job": job.get("id"), "mode": mode_of(job), "engine": name, "model": adapter.get("model"),
            "provider": adapter.get("provider", "fal"), "request_id": request_id, "input_how": how,
            "source": {"path": job.get("input"), "sha256": sha256(source) if source else None,
                       "in": (edl_shot or {}).get("in"), "speed": (edl_shot or {}).get("speed", 1.0)},
            "prompt": job.get("text"), "negative_prompt": job.get("negative_prompt"), "seed": job.get("seed"),
            "offset": job.get("offset", 0.0), "duration": duration, "sample_rate": 48000,
            "cost_basis": "unmeasured until the ledger reads the bill", "license": adapter.get("license"),
            "adapter_status": adapter.get("status")}


def stale(side: dict, ep: Path, edl_shot: dict | None) -> list[str]:
    """Why a generated Foley stem no longer matches its picture: the clip changed, or the EDL in-point or speed moved."""
    why = []
    src = side.get("source") or {}
    if src.get("path"):
        now = sha256(ep / src["path"])
        if now is None:
            why.append(f"source {src['path']} is missing")
        elif src.get("sha256") and now != src["sha256"]:
            why.append(f"source {src['path']} changed (retake or re-conform)")
    if edl_shot is not None:
        if src.get("in") is not None and abs(float(edl_shot.get("in", 0)) - float(src["in"])) > 1e-6:
            why.append(f"EDL in-point moved {src['in']} -> {edl_shot.get('in')}; retime through a mix proposal")
        if abs(float(edl_shot.get("speed", 1.0)) - float(src.get("speed") or 1.0)) > 1e-6:
            why.append("EDL speed changed; regenerate or retime")
    return why


def mix_proposal(job: dict, wav_rel: str) -> dict:
    """A mix-add event for merge-mix-proposals.py, on the hits or beds bus only, anchored to the shot."""
    bus = job.get("bus", "hits")
    if bus not in MIX_BUSES:
        raise Blocked(f"{job.get('id')}: video-to-audio may only feed {MIX_BUSES}, not {bus}")
    ev = {"at_shot": job.get("shot"), "t": float(job.get("offset", 0.0)), "file": wav_rel, "bus": bus,
          "gain": float(job.get("gain", -12)), "source_job": job.get("id")}
    if job.get("onset") is not None:
        ev["onset"] = float(job["onset"])
    return {"scene": job.get("scene"), "add": [ev]}


def run_job(ep: Path, job: dict, doc: dict, sh, log: Path, policy: dict | None = None, fetch=None) -> dict:
    """One video-to-audio job end to end -> fields to save on the job. Never overwrites an existing stem; a job that
    already holds a request_id (a local timeout) fetches that result instead of submitting a second paid request."""
    # a held request belongs to the adapter that took it: resolve by its model, never by walking `order` again
    if job.get("request_id"):
        served = {a.get("model") for a in (((doc.get("roles") or {}).get("sound-generation") or {}).get("adapters") or {}).values()}
        if (job["model"] not in served) if job.get("model") else job.get("engine") in (None, "auto"):
            raise Blocked(f"{job['id']}: request {job['request_id']} was taken by {job.get('model') or 'an unrecorded model'}, "
                          "which no adapter serves now; restore that adapter or clear request_id to pay for a new run")
    name, ad = route(doc, {**job, "engine": None} if job.get("request_id") and job.get("model") else job, policy)
    wav = ep / job.get("out", f"audio/sfx/{job.get('scene', 'misc')}/{job['id']}.wav")
    if wav.exists():
        raise Blocked(f"{job['id']}: {wav.relative_to(ep)} exists; outputs are never overwritten (give a new `out`)")
    rid = job.get("request_id")
    how = "resumed"
    if rid:
        text = sh(result_cmd(ad, rid), log)
    else:
        url, how = video_url(job, ep, ad)
        pay = ep / "logs/payloads" / f"{job['id']}.json"
        pay.parent.mkdir(parents=True, exist_ok=True)
        pay.write_text(dumps(payload(ad, job, url)), encoding="utf-8")
        try:
            text = sh(run_cmd(ad, pay), log)
        except RuntimeError as e:  # keep a request id the log shows, so --retry resumes instead of paying twice
            seen = parse_result(log.read_text(encoding="utf-8", errors="replace") if log.exists() else "")
            if seen["request_id"]:
                job.update(request_id=seen["request_id"], engine=name, model=ad["model"])
                raise RuntimeError(f"{e}; request {seen['request_id']} kept, --retry fetches its result") from e
            raise
    res = parse_result(text)
    rid = res["request_id"] or rid
    if not res["video_url"]:
        raise RuntimeError(f"{ad['model']} returned no video.url" + (f" (request {rid})" if rid else ""))
    mp4 = wav.with_suffix(".v2a.mp4")
    wav.parent.mkdir(parents=True, exist_ok=True)
    (fetch or _download)(res["video_url"], mp4)
    sh(extract_wav_cmd(mp4, wav), log)
    edl_p = ep / "scenes" / str(job.get("scene")) / "edl.json"
    shots = {s.get("id"): s for s in (json.loads(edl_p.read_text(encoding="utf-8")).get("shots", []) if edl_p.exists() else [])}
    src = ep / job["input"] if job.get("input") else None
    side = sidecar(job, name, ad, request_id=rid, source=src, how=how, edl_shot=shots.get(job.get("shot")), duration=job.get("duration"))
    wav.with_suffix(".wav.json").write_text(json.dumps(side, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    prop = ep / "work/v2a" / f"mix-add-{job['id']}.json"
    prop.parent.mkdir(parents=True, exist_ok=True)
    prop.write_text(json.dumps(mix_proposal(job, wav.relative_to(ep).as_posix()), ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    return {"status": "done", "engine": name, "model": ad["model"], "request_id": rid, "out": wav.relative_to(ep).as_posix(),
            "proposal": prop.relative_to(ep).as_posix(), "provider": ad.get("provider", "fal"), "cost_basis": "unmeasured"}


def _download(url: str, dest: Path) -> None:
    if not url.startswith("https://"):
        raise RuntimeError(f"refusing a non-https result URL for {dest.name}")
    with urllib.request.urlopen(url, timeout=120) as r, dest.open("wb") as f:  # noqa: S310 (https checked above)
        f.write(r.read())


def dumps(doc: dict) -> str:
    return json.dumps(doc, ensure_ascii=False)
