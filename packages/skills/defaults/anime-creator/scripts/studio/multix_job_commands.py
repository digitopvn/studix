"""Turn one gen-plan job into multix command lines (pure: no network, no files written), plus output parsing.

Kinds: sheet, keyframe (Nano Banana via Atlas), video (Atlas image-to-video: Omni, Seedance), upscale (byteplus),
run (any Atlas model with a raw payload), sfx, music, tts (ElevenLabs, Gemini when the voice says provider gemini, Fish Audio Drama 3 via provider openrouter or fish), voice-changer, isolate, align (ElevenLabs), qa (Gemini).
Atlas video and upscale jobs are async: submit returns a prediction id, `fetch` downloads when done.
Hard-won flags: --no-webp keeps PNG quality, `--` guards prompts that start with a dash, edit-video rejects
--aspect-ratio, `atlas status --wait-timeout` is in milliseconds.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

from . import voice_direction as vd

PRED_RX = re.compile(r"\b([0-9a-f]{32})\b")
URL_RX = re.compile(r"https://\S+")
DEFAULT_MODELS = {"sheet": "google/nano-banana-2.1-developer/edit", "keyframe": "google/nano-banana-2.1-developer/edit",
                  "t2i": "google/nano-banana-2.1-developer/text-to-image",
                  "video": "google/gemini-omni-1.1-flash/image-to-video", "upscale": "byteplus/video/upscaler",
                  # direct ElevenLabs / Gemini calls: the model name is only the price-table key
                  "sfx": "elevenlabs/sfx", "music": "elevenlabs/music", "tts": "elevenlabs/tts",
                  "voice-changer": "elevenlabs/voice-changer", "isolate": "elevenlabs/isolate", "align": "elevenlabs/align",
                  "qa": "gemini/analyze"}
QA_SECTION_RX = re.compile(r"^## (\w[\w-]*)\s*\n(.*?)(?=^## |\Z)", re.S | re.M)


def qa_prompts(md_path: Path) -> dict[str, str]:
    """assets/templates/qa-prompts.md: one '## <name>' section per prompt; the fenced block is the prompt."""
    out = {}
    for name, body in QA_SECTION_RX.findall(md_path.read_text(encoding="utf-8")):
        m = re.search(r"```(?:text)?\n(.*?)```", body, re.S)
        out[name] = (m.group(1) if m else body).strip()
    return out


def parse_pred_id(text: str) -> str | None:
    m = re.search(r"Prediction\s+([0-9a-f]{32})", text) or PRED_RX.search(text)
    return m.group(1) if m else None


# `atlas status` exits non-zero while a prediction still runs (wait timeout), when a download fails, and when the
# provider refused it; only the last is final, and only when the output names this prediction. multix labels every
# refusal CONTENT_BLOCKED, even a Seedance HTTP 400 validation error, so the provider's own message decides the code.
REFUSAL_RX = re.compile(r'"status"\s*:\s*"failed"|prediction\s+[0-9a-f]{32}\s+failed|\bHTTP 4(?:00|22)\b|content_blocked', re.I)
PROVIDER_MSG_RX = re.compile(r'"message"\s*:\s*"((?:[^"\\]|\\.)*)"')
CONTENT_RX = re.compile(r"content_blocked|responsible ai|safety (?:filter|system|polic)|nsfw|violates? (?:\S+ ){0,3}(?:policy|policies|guidelines)", re.I)


def fetch_final(text: str, pred_id: str) -> bool:
    """True when `atlas status <pred_id>` output says that prediction failed for good (not a timeout or a download)."""
    pid = re.escape(pred_id)
    return bool(re.search(rf'"status"\s*:\s*"failed"|prediction\s+{pid}\s+failed|HTTP 4(?:00|22) from \S*/prediction/{pid}\b', text, re.I))


def fetch_failure(text: str, pred_id: str | None = None) -> dict | None:
    """{"error", "error_code"} when the output is a provider refusal, else None. With pred_id (a --fetch), only a
    final failure of that prediction counts; a timeout or a failed download is not ready, not failed.
    error_code is content_blocked for a safety refusal (rephrase before a retry), rejected for any other refusal."""
    if not REFUSAL_RX.search(text) or (pred_id and not fetch_final(text, pred_id)):
        return None
    body = text.find(" from http")  # the provider's JSON body follows the request URL
    m = PROVIDER_MSG_RX.search(text, max(body, 0))
    if m:
        try:
            msg = json.loads(f'"{m.group(1)}"')
        except ValueError:
            msg = m.group(1)
    else:
        lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
        msg = next((ln[len("Error:"):].strip() for ln in lines if ln.startswith("Error:")), lines[-1] if lines else "failed")
    return {"error": msg, "error_code": "content_blocked" if CONTENT_RX.search(msg) else "rejected"}


def parse_upload_url(text: str) -> str | None:
    urls = URL_RX.findall(text)
    return urls[-1].rstrip(".,)") if urls else None


def image_cmd(job: dict, prompt: str, refs: list[str], out_dir: Path) -> list[str]:
    model = job.get("model") or DEFAULT_MODELS[job["kind"]]
    common = ["--aspect-ratio", job.get("aspect", "16:9"), "--resolution", job.get("resolution", "2k"), "--no-webp", "--output", str(out_dir)]
    if job.get("seed") is not None:
        common += ["--seed", str(job["seed"])]
    if refs:
        args = ["multix", "atlas", "image-to-image", "-m", model]
        for r in refs:
            args += ["--ref", r]
        return args + common + ["--prompt", prompt]
    # no reference yet (the very first model sheet or set painting): text-to-image, same family and price
    return ["multix", "atlas", "image", "-m", job.get("t2i_model", DEFAULT_MODELS["t2i"])] + common + ["--", prompt]


# image-to-video families that name the last-frame field differently from Omni's `last_image`
LAST_FRAME_KEY = {"minimax/h3": "end_image"}
# reference-to-video families with no first/last-frame field: Seedance rejects `image` next to reference media
# (HTTP 400), so the keyframe goes last in `reference_images` and the reel's own image tags keep their numbers
NO_FIRST_FRAME = ("bytedance/seedance-2.0-mini/reference-to-video",)


def video_payload(job: dict, prompt: str, first_url: str, last_url: str | None) -> dict:
    model = job.get("model") or DEFAULT_MODELS["video"]
    no_frames = model.startswith(NO_FIRST_FRAME)
    if no_frames and last_url:
        raise ValueError(f"{job.get('id')}: {model} has no last-frame field; drop `last` or use an image-to-video model")
    p = {"prompt": prompt} if no_frames else {"image": first_url, "prompt": prompt}
    if last_url:
        p[next((v for k, v in LAST_FRAME_KEY.items() if model.startswith(k)), "last_image")] = last_url
    for k in ("duration", "resolution", "seed"):
        if job.get(k) is not None:
            p[k] = job[k]
    p.update(job.get("extra") or {})
    if no_frames:
        p["reference_images"] = list(p.get("reference_images") or []) + [first_url]
    return p


def upscale_payload(job: dict, video_url: str) -> dict:
    return {"video_url": video_url, "tool_version": job.get("tool_version", "standard"), "scene": "aigc",
            "resolution": job.get("resolution", "1080p"), "fps": job.get("fps", 24), "bitrate_level": "high"}


def run_cmd(model: str, payload_file: Path, *, video: bool = False) -> list[str]:
    return ["multix", "atlas", "run", model, "--input", f"@{payload_file}", "--async"] + (["--type", "video"] if video else [])


def fetch_cmd(pred_id: str, out: Path, wait_ms: int = 600000) -> list[str]:
    return ["multix", "atlas", "status", pred_id, "--download", "--wait-timeout", str(wait_ms), "--no-thumb", "--output", str(out)]


def upload_cmd(path: Path) -> list[str]:
    return ["multix", "atlas", "upload", str(path)]


TAG_RX = re.compile(r"^\s*\[([^\]]+)\]\s*")


def tts_provider(job: dict, voice) -> str:
    """A character voice picks its provider (elevenlabs, gemini, openrouter or fish); ElevenLabs is the default."""
    return job.get("provider") or (voice.get("provider") if isinstance(voice, dict) else None) or "elevenlabs"


def gemini_tts_cmd(job: dict, v: dict, out: str) -> list[str]:
    """Gemini Flash TTS: a prebuilt voice name plus a free-text delivery direction. A leading ElevenLabs-style
    [tag] would be read aloud, so it moves into the direction instead."""
    text, style = job["text"], [v.get("style", ""), job.get("direction", "")]
    m = TAG_RX.match(text)
    if m:
        text, style = text[m.end():], style + [f"this line: {m.group(1)}"]
    cmd = ["multix", "gemini", "generate-speech", "--model", job.get("tts_model") or v.get("model", "gemini-3.8-flash-tts"),
           "--voice", v.get("voice_name") or v.get("voice_id"), "--text", text, "--output-format", "wav", "--output", out]
    direction = "; ".join(s for s in style if s)
    return cmd + (["--style", direction] if direction else [])


def audio_cmd(job: dict, ep: Path, voice_of=lambda c: None) -> list[str]:
    k, out = job["kind"], str(ep / job["out"])
    if k == "sfx":
        return ["multix", "elevenlabs", "sfx", "--text", job["text"], "--duration-seconds", str(job.get("duration", 1.5)),
                "--prompt-influence", str(job.get("prompt_influence", 0.5)), "--format", "mp3_44100_192", "--output", out]
    if k == "music":
        return ["multix", "elevenlabs", "music", "--plan", str(ep / job["plan"]), "--format", "mp3_44100_192", "--output", out]
    if k == "tts":
        v = job.get("voice") or voice_of(job.get("speaker")) or {}
        if tts_provider(job, v) == "gemini":
            return gemini_tts_cmd(job, v, out)
        if vd.is_drama3(job, v):
            raise ValueError(f"{job.get('id')}: Drama 3 lines run through voice_direction.tts_cmd (text file, receipt)")
        vid = v.get("voice_id") if isinstance(v, dict) else v
        cmd = ["multix", "elevenlabs", "tts", "--text", job["text"], "--voice", vid, "--model", job.get("tts_model", "eleven_v3"),
               "--stability", str(job.get("stability", 0.45)), "--similarity-boost", str(job.get("similarity", 0.8)),
               "--style", str(job.get("style", 0.3)), "--format", "mp3_44100_192", "--output", out]
        lang = job.get("language") or (v.get("language") if isinstance(v, dict) else None)
        if lang:
            cmd += ["--language-code", lang]
        if job.get("seed") is not None:
            cmd += ["--seed", str(job["seed"])]
        return cmd
    if k == "voice-changer":
        v = job.get("voice") or voice_of(job.get("speaker")) or {}
        vid = v.get("voice_id") if isinstance(v, dict) else v
        return ["multix", "elevenlabs", "voice-changer", "--input", str(ep / job["input"]), "--voice", vid, "--remove-background-noise",
                "--stability", str(job.get("stability", 0.45)), "--similarity-boost", str(job.get("similarity", 0.8)),
                "--style", str(job.get("style", 0.3)), "--output", out]
    if k == "isolate":
        return ["multix", "elevenlabs", "isolate", "--input", str(ep / job["input_padded"]), "--output", out]
    if k == "align":
        # alignment reads the spoken words only: performance markup would misplace every word after it
        return ["multix", "elevenlabs", "align", "--input", str(ep / job["input"]), "--text", vd.plain_text(job["text"]), "--output", out]
    raise ValueError(f"not an audio kind: {k}")


def qa_cmd(file: Path, prompt: str) -> list[str]:
    return ["multix", "gemini", "analyze", "--files", str(file), "--prompt", prompt]


def qa_result(stdout: str) -> str:
    """multix prints progress before 'Result:'; keep only the answer."""
    i = stdout.find("Result:")
    return stdout[i + len("Result:"):].strip() if i >= 0 else stdout.strip()


def apply_alignment(edl: dict, shot_id: str, line_idx: int, align_json: dict, *, offset: float | None = None) -> dict:
    """Write word timings (edit time) into one dialogue line; offset defaults to the line's t0."""
    shot = next(s for s in edl["shots"] if s["id"] == shot_id)
    line = shot["dialogue"][line_idx]
    base = line["t0"] if offset is None else offset
    words = align_json.get("words") or []
    line["words"] = [{"text": w.get("text", w.get("word", "")).strip(), "t0": round(base + float(w.get("start", w.get("start_time", 0))), 3)}
                     for w in words if str(w.get("text", w.get("word", ""))).strip()]
    return edl


def dumps(payload: dict) -> str:
    return json.dumps(payload, ensure_ascii=False)
