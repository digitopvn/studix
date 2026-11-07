#!/usr/bin/env python3
"""Generate one image-to-video clip on a local ComfyUI server (free per clip, no cloud API), from any engine's workflow.

usage: generate-video-via-comfyui.py --image first.png [--last-image last.png] (--prompt TEXT | --prompt-file F)
                                     [--engine NAME | --workflow FILE.json] [--seconds 5] [--width 864 --height 480]
                                     [--seed N] [--negative TEXT] [--lora FILE --lora-strength 1.0] [--crf 12]
                                     [--unet FILE] [--turbo | --no-turbo] [--steps N] [--audio]
                                     [--guide-audio take.wav --guide-frame 10]
                                     --out clip.mp4 [--server http://127.0.0.1:8188] [--dry-run]
The engine is the `i2v-local` role of engines.json (assets/templates/, or <series>/engines.json): an adapter names
a workflow in assets/comfyui-workflows/ and its default params. Two ways a workflow is filled:
- a workflow that carries `_slots` (ltx-2.5-i2v-api.json): each slot lists the [node, input] pairs that take a
  value (prompt, negative, first_image, width, height, longer_side, seconds, seed, seed2, first_strength, unet,
  prefix); `_lora` names the model node and every consumer a style LoRA must feed; `_save` how to force an H.264
  CRF. A new engine is a new workflow file with these keys plus an engines.json adapter: no code change.
- MiniMax H3 (minimax-h3-i2v-api.json, the default) keeps its own wiring in build_graph(): turbo LoRA, optional
  last frame, audio decode and the MiniMaxH3AddGuide speech anchor. Its length snaps to H3's 17k+5 frame grid.
Uploads the frame(s) to ComfyUI's input/, submits /prompt, polls /history, downloads the video via /view, and
writes <out>.json beside it: params, prompt id, wall time, peak VRAM (nvidia-smi, when present), frame count
(ffprobe, when present) and cost_usd 0, so engines can be compared on the same keyframe and seed. Never
overwrites: an existing --out gets a -2, -3... suffix. --dry-run prints the filled graph (no server needed).
Comparing engines: same keyframe, prompt and seed; measure wall time and VRAM; for anime add a style LoRA (on
every stage of a multi-stage workflow); re-encode at a low CRF (--crf) before judging faces; put the takes in a
labelled grid (make-review-tiles.py) and let the user pick.
Start the server first: <ComfyUI>/main.py --listen 127.0.0.1 --port 8188 (optional speedups such as
--use-sage-attention depend on the install). One GPU job at a time: each run holds the machine's heavy lease
(studio/admission_leases.py, ~/.anime-studio/leases) from upload to download; a run that finds it busy waits
--lease-wait seconds (default the episode's admission.wait_s, else 600), then exits 75 with nothing submitted. A
timeout, an error or Ctrl-C after submit interrupts the prompt and deletes it from the queue before the lease frees.
Supported: Windows, macOS, Linux. Stdlib only.
"""
from __future__ import annotations

import argparse
import json
import mimetypes
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from studio import admission_leases as adm  # noqa: E402
from studio import engine_routing as er  # noqa: E402

HELD = 75  # EX_TEMPFAIL: the GPU is busy with another job; nothing was submitted, run it again later
WORKFLOW = er.WORKFLOWS / "minimax-h3-i2v-api.json"
FPS = 24
TURBO_LORA = "minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors"
# node ids inside the H3 workflow file
N_UNET, N_LORA, N_FIRST, N_LAST, N_I2V, N_NOISE, N_SCHED, N_GUIDER = "1", "2", "6", "7", "8", "9", "11", "12"
N_AUDIO_VAE, N_AUDIO_DEC, N_CREATE, N_SAVE = "5", "15", "16", "17"
N_LOAD_AUDIO, N_GUIDE = "18", "19"


def snap_length(seconds: float) -> int:
    """Seconds -> frame count on H3's 17k+5 grid (same formula as the ComfyUI template's Math Expression)."""
    n = max(5, round(seconds * FPS))
    return n + (5 - n % 17) % 17


def build_graph(first: str, last: str | None, prompt: str, width: int, height: int, seconds: float,
                turbo: bool, steps: int, seed: int, audio: bool, prefix: str,
                lora: str = TURBO_LORA, unet: str | None = None, workflow: Path = WORKFLOW,
                guide_audio: str | None = None, guide_frame: int = 10) -> dict:
    """Return the filled H3 API graph. `first`/`last`/`guide_audio` are names as ComfyUI's loaders see them.
    `guide_audio` chains MiniMaxH3AddGuide after the I2V node so that audio (an approved TTS take) is anchored at
    `guide_frame` and drives the lips; the audio VAE stays in the graph even when the mp4 is silent."""
    if width % 32 or height % 32:
        raise ValueError("width and height must be multiples of 32")
    g = {k: v for k, v in json.loads(workflow.read_text(encoding="utf-8")).items() if not k.startswith("_")}
    if unet:
        g[N_UNET]["inputs"]["unet_name"] = unet
    if turbo:
        g[N_LORA]["inputs"]["lora_name"] = lora
    else:
        del g[N_LORA]
        g[N_SCHED]["inputs"]["model"] = [N_UNET, 0]
        g[N_GUIDER]["inputs"]["model"] = [N_UNET, 0]
    i2v = g[N_I2V]["inputs"]
    i2v.update(prompt=prompt, width=width, height=height, length=snap_length(seconds))
    g[N_FIRST]["inputs"]["image"] = first
    if last:
        g[N_LAST]["inputs"]["image"] = last
    else:
        del g[N_LAST], i2v["last_frame"]
    if guide_audio:
        g[N_LOAD_AUDIO] = {"class_type": "LoadAudio", "inputs": {"audio": guide_audio}}
        g[N_GUIDE] = {"class_type": "MiniMaxH3AddGuide",
                      "inputs": {"positive": [N_I2V, 0], "audio_vae": [N_AUDIO_VAE, 0], "latent": [N_I2V, 1],
                                 "audio": [N_LOAD_AUDIO, 0], "frame_idx": guide_frame}}
        g[N_GUIDER]["inputs"]["conditioning"] = [N_GUIDE, 0]
    if not audio:
        del g[N_AUDIO_DEC], g[N_CREATE]["inputs"]["audio"]
        if not guide_audio:
            del g[N_AUDIO_VAE]
    g[N_NOISE]["inputs"]["noise_seed"] = seed
    g[N_SCHED]["inputs"]["steps"] = steps
    g[N_SAVE]["inputs"]["filename_prefix"] = prefix
    return g


def workflow_doc(workflow: Path) -> dict:
    return json.loads(workflow.read_text(encoding="utf-8"))


def build_slot_graph(workflow: Path, values: dict, lora: str | None = None, lora_strength: float = 1.0,
                     crf: float | None = None) -> dict:
    """Fill a workflow that declares `_slots` (see the module doc). `values` keys are slot names; a slot the
    workflow does not declare is ignored, a declared slot without a value keeps the workflow's own input."""
    doc = workflow_doc(workflow)
    g = {k: v for k, v in doc.items() if not k.startswith("_")}
    for name, targets in doc["_slots"].items():
        if values.get(name) is None:
            continue
        for node, key in targets:
            g[node]["inputs"][key] = values[name]
    if lora:  # every consumer, or a second stage refines the style back out
        spec = doc.get("_lora")
        if not spec:
            raise ValueError(f"{workflow.name} declares no _lora wiring")
        g["lora_style"] = {"class_type": "LoraLoaderModelOnly",
                           "inputs": {"model": spec["model_from"], "lora_name": lora, "strength_model": lora_strength}}
        for node, key in spec["consumers"]:
            g[node]["inputs"][key] = ["lora_style", 0]
    if crf is not None:
        save = doc.get("_save")
        if not save:
            raise ValueError(f"{workflow.name} declares no _save encoder keys")
        g[save["node"]]["inputs"].update({**save["crf_inputs"], save["crf_key"]: crf})
    return g


def slot_values(workflow: Path, prompt: str, first: str, width: int, height: int, seconds: float, seed: int,
                prefix: str, **extra) -> dict:
    """The values every slot workflow may map; `extra` (unet, negative, first_strength...) wins when not None."""
    d = workflow_doc(workflow).get("_defaults", {})
    v = {"prompt": d.get("prompt_prefix", "") + prompt, "first_image": first, "width": width, "height": height,
         "longer_side": max(width, height), "seconds": seconds, "seed": seed, "seed2": seed + 1, "prefix": prefix,
         "negative": d.get("negative"), "first_strength": d.get("first_strength")}
    v.update({k: x for k, x in extra.items() if x is not None})
    return v


class VramPeak:
    """Peak GPU memory (MiB) sampled once a second through nvidia-smi; stays None when it is not installed."""

    def __init__(self):
        self.peak, self._stop, self._smi = None, threading.Event(), shutil.which("nvidia-smi")

    def __enter__(self):
        if self._smi:
            threading.Thread(target=self._loop, daemon=True).start()
        return self

    def _loop(self):
        while not self._stop.is_set():
            out = subprocess.run([self._smi, "--query-gpu=memory.used", "--format=csv,noheader,nounits"],
                                 capture_output=True, text=True).stdout.split()
            if out and out[0].isdigit():
                self.peak = max(self.peak or 0, int(out[0]))
            self._stop.wait(1)

    def __exit__(self, *exc):
        self._stop.set()


def frame_count(path: Path) -> int | None:
    if not shutil.which("ffprobe"):
        return None
    r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-count_packets", "-show_entries",
                        "stream=nb_read_packets", "-of", "csv=p=0", str(path)], capture_output=True, text=True)
    return int(r.stdout.strip()) if r.stdout.strip().isdigit() else None


def unique_path(p: Path) -> Path:
    """p if neither p nor its sidecar exists, else p-2, p-3, ..."""
    cand, i = p, 2
    while cand.exists() or cand.with_suffix(".json").exists():
        cand = p.with_name(f"{p.stem}-{i}{p.suffix}")
        i += 1
    return cand


def http(server: str, path: str, data: bytes | None = None, headers: dict | None = None, timeout: int = 60) -> bytes:
    req = urllib.request.Request(server.rstrip("/") + path, data=data, headers=headers or {})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def upload(server: str, path: Path, subfolder: str) -> str:
    """POST /upload/image; return the name LoadImage needs (subfolder/filename)."""
    boundary = uuid.uuid4().hex
    ctype = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    parts = [
        f'--{boundary}\r\nContent-Disposition: form-data; name="subfolder"\r\n\r\n{subfolder}\r\n'.encode(),
        f'--{boundary}\r\nContent-Disposition: form-data; name="type"\r\n\r\ninput\r\n'.encode(),
        (f'--{boundary}\r\nContent-Disposition: form-data; name="image"; filename="{path.name}"\r\n'
         f"Content-Type: {ctype}\r\n\r\n").encode() + path.read_bytes() + b"\r\n",
        f"--{boundary}--\r\n".encode(),
    ]
    res = json.loads(http(server, "/upload/image", b"".join(parts),
                          {"Content-Type": f"multipart/form-data; boundary={boundary}"}))
    return f"{res['subfolder']}/{res['name']}" if res.get("subfolder") else res["name"]


def wait_history(server: str, prompt_id: str, timeout: int, poll: float = 5.0) -> dict:
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        hist = json.loads(http(server, f"/history/{prompt_id}")).get(prompt_id)
        if hist:
            st = hist.get("status", {})
            if st.get("status_str") == "error":
                msgs = [m for m in st.get("messages", []) if m[0] == "execution_error"]
                detail = msgs[-1][1].get("exception_message", "").strip() if msgs else "unknown error"
                raise RuntimeError(f"ComfyUI execution error: {detail}")
            if st.get("completed"):
                return hist
        time.sleep(poll)
    raise TimeoutError(f"prompt {prompt_id} not finished after {timeout}s")


def cancel(server: str, prompt_id: str) -> None:
    """Stop a prompt this run gave up on: interrupt it if it is running, delete it from the queue if it waits.
    Best effort: a server that is gone has nothing left on the GPU."""
    body = {"Content-Type": "application/json"}
    for path, data in (("/interrupt", {"prompt_id": prompt_id}), ("/queue", {"delete": [prompt_id]})):
        try:
            http(server, path, json.dumps(data).encode(), body, timeout=30)
        except (OSError, ValueError) as e:
            print(f"could not {path.strip('/')} prompt {prompt_id}: {e}", file=sys.stderr)


def saved_file(hist: dict, node: str = N_SAVE) -> dict:
    for item in hist.get("outputs", {}).get(node, {}).values():
        if isinstance(item, list):
            for f in item:
                if isinstance(f, dict) and str(f.get("filename", "")).endswith((".mp4", ".webm", ".mkv")):
                    return f
    raise RuntimeError("no video in ComfyUI outputs")


def first_set(*vals):
    return next((v for v in vals if v is not None), None)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--image", required=True, type=Path, help="first frame")
    ap.add_argument("--last-image", type=Path, help="optional last frame (H3: cover-cropped to the canvas)")
    pr = ap.add_mutually_exclusive_group(required=True)
    pr.add_argument("--prompt")
    pr.add_argument("--prompt-file", type=Path)
    ap.add_argument("--engine", help="i2v-local adapter in engines.json (default: the role's default)")
    ap.add_argument("--workflow", type=Path, help="API-format workflow file; overrides the engine's")
    ap.add_argument("--episode", type=Path, help="episode dir, to read <series>/engines.json overrides")
    ap.add_argument("--seconds", type=float)
    ap.add_argument("--width", type=int)
    ap.add_argument("--height", type=int)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--negative", help="negative prompt (slot workflows; default from the workflow)")
    ap.add_argument("--first-strength", type=float, help="first-frame conditioning strength (slot workflows)")
    ap.add_argument("--lora", help="H3: the turbo LoRA file; slot workflows: a style LoRA fed to every stage")
    ap.add_argument("--lora-strength", type=float)
    ap.add_argument("--crf", type=float, help="force an H.264 re-encode at this CRF (slot workflows with _save)")
    ap.add_argument("--turbo", action=argparse.BooleanOptionalAction, default=True, help="H3 turbo 8-step LoRA (default on)")
    ap.add_argument("--steps", type=int, help="H3: default 8 with --turbo, 20 without")
    ap.add_argument("--audio", action="store_true", help="H3: also decode its audio track into the mp4")
    ap.add_argument("--guide-audio", type=Path, help="H3: approved speech take (wav) anchored with MiniMaxH3AddGuide")
    ap.add_argument("--guide-frame", type=int, default=10, help="H3: video frame where --guide-audio starts (default 10)")
    ap.add_argument("--unet", help="override diffusion model file name")
    ap.add_argument("--out", required=True, type=Path, help="target .mp4 (a -N suffix is added if it exists)")
    ap.add_argument("--server", default="http://127.0.0.1:8188")
    ap.add_argument("--timeout", type=int, default=7200, help="seconds to wait for the job")
    ap.add_argument("--lease-wait", type=float, help="seconds to wait for the GPU's heavy lease before exiting held (default: "
                                                     "the episode's admission.wait_s, else 600)")
    ap.add_argument("--dry-run", action="store_true", help="print the filled graph; no server, no files")
    a = ap.parse_args()

    engine, adapter = (None, {}) if a.workflow and not a.engine else er.pick(er.load(a.episode), "i2v-local", a.engine)
    pa = adapter.get("params", {})
    workflow = a.workflow or (er.WORKFLOWS / adapter["workflow"] if adapter.get("workflow") else WORKFLOW)
    slots = "_slots" in workflow_doc(workflow)
    wd = workflow_doc(workflow).get("_defaults", {})

    def opt(name: str, fallback=None):  # command line, then the engine's params, then the workflow's defaults
        return first_set(getattr(a, name), pa.get(name), wd.get(name), fallback)

    seconds, width, height = opt("seconds", 5.0), opt("width", 864), opt("height", 480)
    lora, lora_strength, unet, crf = opt("lora") or None, opt("lora_strength", 1.0), opt("unet"), opt("crf")
    prompt = a.prompt if a.prompt is not None else a.prompt_file.read_text(encoding="utf-8").strip()
    for p in (a.image, a.last_image, a.guide_audio):
        if p and not p.is_file():
            ap.error(f"not a file: {p}")
    if slots and (a.last_image or a.guide_audio or a.audio):
        ap.error(f"{workflow.name}: --last-image, --guide-audio and --audio are H3 options")
    out = unique_path(a.out.with_suffix(".mp4"))
    prefix = f"{workflow.stem.replace('-api', '')}/{out.stem}"
    steps = a.steps or (8 if a.turbo else 20)

    def graph(first: str, last: str | None, guide: str | None) -> dict:
        if slots:
            vals = slot_values(workflow, prompt, first, width, height, seconds, a.seed, prefix, unet=unet,
                               negative=a.negative, first_strength=opt("first_strength"))
            return build_slot_graph(workflow, vals, lora, lora_strength, crf)
        return build_graph(first, last, prompt, width, height, seconds, a.turbo, steps, a.seed, a.audio, prefix,
                           lora=lora or TURBO_LORA, unet=unet, workflow=workflow, guide_audio=guide,
                           guide_frame=a.guide_frame)

    if a.dry_run:
        print(json.dumps(graph(a.image.name, a.last_image.name if a.last_image else None,
                               a.guide_audio.name if a.guide_audio else None), indent=2, ensure_ascii=False))
        return 0

    cfg = adm.config(a.episode) if a.episode else dict(adm.DEFAULTS)
    try:  # the machine's one heavy slot: another GPU job (any series, either runner) holds this one back
        held = adm.acquire_all(None, [(adm.HEAVY, 1)], {"job": out.name, "episode": a.episode.name if a.episode else None,
                                                     "series": a.episode.resolve().parents[1].as_posix() if a.episode else None,
                                                     "out": a.out.with_suffix(".mp4").resolve().as_posix(),  # as asked, before -N
                                                     "resource": "gpu-local", "provider": "comfyui"},
                               ttl=max(cfg["ttl_s"], a.timeout + 900), wait=cfg["wait_s"] if a.lease_wait is None else a.lease_wait)
    except adm.Busy as e:
        print(f"held: {e}; nothing was submitted to ComfyUI", file=sys.stderr)
        return HELD
    except adm.Unwritable as e:
        print(f"lease folder: {e} (or set ANIME_STUDIO_LEASES to a writable folder every runner shares)", file=sys.stderr)
        return 1
    try:
        t0 = time.time()
        sub = "i2v-runner"
        with VramPeak() as vram:
            first = upload(a.server, a.image, sub)
            last = upload(a.server, a.last_image, sub) if a.last_image else None
            guide = upload(a.server, a.guide_audio, sub) if a.guide_audio else None
            body = json.dumps({"prompt": graph(first, last, guide), "client_id": uuid.uuid4().hex}).encode()
            try:
                res = json.loads(http(a.server, "/prompt", body, {"Content-Type": "application/json"}))
            except urllib.error.HTTPError as e:
                print(e.read().decode("utf-8", "replace"), file=sys.stderr)
                raise
            pid = res["prompt_id"]
            print(f"submitted {pid}", file=sys.stderr)
            try:
                hist = wait_history(a.server, pid, a.timeout)
            except BaseException:  # timeout, server error, Ctrl-C: the GPU must be free before the lease is
                cancel(a.server, pid)
                raise
        f = saved_file(hist, workflow_doc(workflow).get("_save", {}).get("node", N_SAVE))
        q = urllib.parse.urlencode({"filename": f["filename"], "subfolder": f.get("subfolder", ""), "type": f.get("type", "output")})
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(http(a.server, f"/view?{q}", timeout=600))
        wall = round(time.time() - t0, 1)
        sidecar = {
            "engine": engine or "comfyui-local", "workflow": workflow.name, "server": a.server, "prompt_id": pid,
            "image": str(a.image.resolve()), "last_image": str(a.last_image.resolve()) if a.last_image else None,
            "guide_audio": str(a.guide_audio.resolve()) if a.guide_audio else None, "prompt": prompt,
            "negative": a.negative, "width": width, "height": height, "seconds": seconds, "seed": a.seed,
            "lora": (lora or TURBO_LORA) if not slots and a.turbo else lora, "lora_strength": lora_strength if lora else None,
            "unet": unet, "crf": crf, "frames": frame_count(out) or (None if slots else snap_length(seconds)), "fps": FPS,
            **({} if slots else {"turbo": a.turbo, "steps": steps, "audio": a.audio, "guide_frame": a.guide_frame}),
            "comfy_output": f"{f.get('subfolder', '')}/{f['filename']}".lstrip("/"),
            "wall_seconds": wall, "vram_peak_mib": vram.peak, "cost_usd": 0, "created_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        }
        out.with_suffix(".json").write_text(json.dumps(sidecar, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print(f"{out}  ({wall}s, vram peak {vram.peak} MiB)")
        return 0
    finally:
        for lease in held:
            adm.release(lease)


if __name__ == "__main__":
    sys.exit(main())
