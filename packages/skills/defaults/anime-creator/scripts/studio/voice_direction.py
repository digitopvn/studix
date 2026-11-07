"""Provider-neutral voice direction for TTS lines, with the Fish Audio Drama 3 routes (pure: no network, no files).

A line keeps two texts: `text` (plain_text, the words only: subtitles, ASR and forced alignment use it) and
`directed_text` (what the TTS model receives: `[natural-language directions]`, paired tags such as
<whisper>...</whisper>, and `<|speaker:N|>` turns). Stripping the markup from directed_text must give back the
plain text, so a direction can never change the words. Drama 3 bills UTF-8 bytes of everything sent, tags included.

Routes: provider `openrouter` + model `fish-audio/drama-3` (multix openrouter tts) and provider `fish` + model
`drama-3` (multix fish tts, native API). Nothing falls back from one to another or to another model.
"""
from __future__ import annotations

import re
import unicodedata

PAIRED_TAGS = ("whisper", "emphasis", "soft", "fast", "slow", "stress", "forceful")
DIRECTION_RX = re.compile(r"\[[^\[\]\n]{1,200}\]")
TAG_RX = re.compile(r"<(/?)([a-z]+)>")
SPEAKER_RX = re.compile(r"<\|speaker:(\d+)\|>")
# provider -> the only model ids it serves for Drama 3, and the price-table key prefix
DRAMA3 = {"openrouter": ("fish-audio/drama-3", "fish-audio/drama-3-20261013"), "fish": ("drama-3",)}
PRICE_KEY = {"openrouter": "openrouter/fish-audio/drama-3", "fish": "fish/drama-3"}


class DirectionError(ValueError):
    """A directed line that must not be sent: the run refuses it instead of guessing."""


def plain_text(text: str) -> str:
    """The spoken words only: directions, paired tags and speaker tags removed, whitespace collapsed."""
    s = SPEAKER_RX.sub(" ", text or "")
    s = DIRECTION_RX.sub(" ", s)
    s = TAG_RX.sub(lambda m: m.group(0) if m.group(2) not in PAIRED_TAGS else "", s)
    return re.sub(r"\s+", " ", s).strip()


def has_markup(text: str) -> bool:
    return plain_text(text) != re.sub(r"\s+", " ", text or "").strip()


def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", unicodedata.normalize("NFC", s)).strip()


def check_tags(directed: str) -> None:
    """Paired tags must be known, balanced and not nested in themselves; an unknown <tag> is refused."""
    stack: list[str] = []
    for m in TAG_RX.finditer(directed):
        closing, name = m.group(1) == "/", m.group(2)
        if name not in PAIRED_TAGS:
            raise DirectionError(f"unknown tag <{closing and '/' or ''}{name}>; allowed: {', '.join(PAIRED_TAGS)}")
        if not closing:
            if name in stack:
                raise DirectionError(f"<{name}> is opened twice")
            stack.append(name)
        elif not stack or stack[-1] != name:
            raise DirectionError(f"</{name}> does not close the innermost open tag")
        else:
            stack.pop()
    if stack:
        raise DirectionError(f"unclosed tag <{stack[-1]}>")


def is_drama3(job: dict, voice=None) -> bool:
    return route(job, voice)[0] in DRAMA3


def route(job: dict, voice=None) -> tuple[str | None, str | None]:
    v = voice if isinstance(voice, dict) else {}
    provider = job.get("provider") or v.get("provider")
    return provider, job.get("tts_model") or v.get("model")


def utf8_bytes(text: str) -> int:
    return len(text.encode("utf-8"))


def directed(job: dict) -> str:
    return job.get("directed_text") or job["text"]


def validate_line(job: dict, voice, *, speakers_ok: bool = False) -> dict:
    """Check one Drama 3 tts job against its pinned voice. Returns {provider, model, voice_id, plain_text,
    directed_text, utf8_bytes, price_key}; raises DirectionError for anything that would send the wrong thing."""
    v = voice if isinstance(voice, dict) else {}
    provider, model = route(job, v)
    if provider not in DRAMA3:
        raise DirectionError(f"{job.get('id')}: provider {provider!r} is not a Drama 3 route")
    if model not in DRAMA3[provider]:
        raise DirectionError(f"{job.get('id')}: model {model!r} is not served by provider {provider} "
                             f"(use {DRAMA3[provider][0]}); no fallback to another model")
    voice_id = v.get("voice_id") or ""
    if not voice_id:
        raise DirectionError(f"{job.get('id')}: no pinned voice_id for {job.get('speaker')!r}; cast and approve a voice first")
    pinned = job.get("pinned_voice")  # the character file's approved voice, filled by the runner
    if pinned and pinned.get("approved") and pinned.get("voice_id") != voice_id and not job.get("recast_ok"):
        raise DirectionError(f"{job.get('id')}: voice {voice_id} replaces the approved voice of {job.get('speaker')}; "
                             "set recast_ok only after the user approves the recast")
    text = job.get("text") or ""
    if has_markup(text):
        raise DirectionError(f"{job.get('id')}: `text` must be plain words (subtitles and alignment read it); "
                             "put directions and tags in `directed_text`")
    sent = directed(job)
    check_tags(sent)
    if SPEAKER_RX.search(sent) and not speakers_ok:
        raise DirectionError(f"{job.get('id')}: <|speaker:N|> needs a multi-speaker job (`turns`); keep one line per job")
    if _norm(plain_text(sent)) != _norm(text):
        raise DirectionError(f"{job.get('id')}: directed_text changes the words: {plain_text(sent)!r} != {text!r}")
    for d in v.get("dictionaries", []) + job.get("dictionaries", []):
        if not d.get("version") or str(d["version"]).lower() == "latest":
            raise DirectionError(f"{job.get('id')}: pronunciation dictionary {d.get('id')} needs a fixed version, not latest")
    return {"provider": provider, "model": model, "voice_id": voice_id, "plain_text": _norm(text),
            "directed_text": sent, "utf8_bytes": utf8_bytes(sent), "price_key": PRICE_KEY[provider]}


def tts_cmd(line: dict, job: dict, text_file: str, out: str) -> list[str]:
    """multix command for a validated Drama 3 line; the text goes in a UTF-8 file so tags and Unicode survive
    any shell or Windows code page. One request, one JSON result to read the receipt from."""
    fmt = job.get("format", "mp3")
    if line["provider"] == "openrouter":
        cmd = ["multix", "openrouter", "tts", "--model", line["model"], "--voice", line["voice_id"],
               "--text-file", text_file, "--format", fmt, "--output", out, "--json",
               # OpenRouter's /generation reported no cost after the default 20 s on a live run; it did a minute later
               "--cost-wait", str(job.get("cost_wait", 60))]
        if job.get("instructions"):
            cmd += ["--instructions", job["instructions"]]
        return cmd
    cmd = ["multix", "fish", "tts", "--model", line["model"], "--voice", line["voice_id"], "--text-file", text_file,
           "--format", fmt, "--output", out, "--json"]
    if job.get("language"):
        cmd += ["--language", job["language"]]
    return cmd


def receipt(result: dict, line: dict, estimate: float | None) -> dict:
    """Fields to save on the job from multix's `--json` output: a multix.result/v1 envelope whose `data` is the
    command's own result (older builds print the result bare). Billed cost: the result's, else the envelope's."""
    env = result if result.get("schema") == "multix.result/v1" else {}
    reported = ((env.get("cost") or {}).get("provider_reported") or {}).get("cost_usd")
    result = (env.get("data") if isinstance(env.get("data"), dict) else None) or (result if not env else {})
    billed = result.get("cost_usd") if result.get("cost_usd") is not None else reported
    return {"provider": line["provider"], "model_requested": line["model"],
            "model_resolved": result.get("model_resolved") or result.get("model_header_sent"),
            "model_confirmed": bool(result.get("model_resolved")),
            "upstream_provider": result.get("provider") if line["provider"] == "openrouter" else "fish",
            "generation_id": result.get("generation_id"), "voice_id": line["voice_id"],
            "plain_text": line["plain_text"], "utf8_bytes": line["utf8_bytes"],
            "audio_sha256": result.get("sha256"), "duration_s": result.get("duration_s"),
            "estimated_cost_usd": estimate if estimate is not None else result.get("estimated_cost_usd"),
            "cost_usd": billed if billed is not None else estimate,
            "cost_basis": "billed" if billed is not None else "estimate"}


def next_revision(out: str, exists) -> str:
    """A retake never overwrites audio already on disk: name.ext, then name.r2.ext, name.r3.ext..."""
    if not exists(out):
        return out
    stem, dot, ext = out.rpartition(".")
    stem = re.sub(r"\.r\d+$", "", stem)
    n = 2
    while exists(f"{stem}.r{n}.{ext}"):
        n += 1
    return f"{stem}.r{n}.{ext}"


def check_manifest(doc: dict) -> list[str]:
    """Problems in a voice-direction manifest (characters -> identity, scenes -> lines); empty when it is sendable."""
    problems = []
    chars = doc.get("characters") or {}
    for cid, c in chars.items():
        ident = c.get("voice") or {}
        if not ident.get("voice_id"):
            problems.append(f"{cid}: voice identity has no voice_id")
        origin = ident.get("origin", "library")
        if origin in ("clone", "design"):
            if origin == "clone" and not (ident.get("consent") or {}).get("rights_confirmed"):
                problems.append(f"{cid}: a cloned voice needs consent.rights_confirmed from the voice owner")
            if not ident.get("approved_by"):
                problems.append(f"{cid}: a {origin} voice needs approved_by (G1) before any line uses it")
        for d in ident.get("dictionaries", []):
            if not d.get("version") or str(d["version"]).lower() == "latest":
                problems.append(f"{cid}: dictionary {d.get('id')} needs a fixed version, not latest")
    for scene in doc.get("scenes") or []:
        for ln in scene.get("lines") or []:
            lid = ln.get("id", "?")
            if ln.get("speaker") not in chars:
                problems.append(f"{lid}: speaker {ln.get('speaker')!r} is not cast")
                continue
            job = {"id": lid, "kind": "tts", "speaker": ln["speaker"], "text": ln.get("text", ""),
                   "directed_text": ln.get("directed_text"), "provider": doc.get("provider"),
                   "tts_model": doc.get("model")}
            try:
                validate_line(job, chars[ln["speaker"]].get("voice"))
            except DirectionError as e:
                problems.append(str(e))
    return problems


def jobs_from_manifest(doc: dict, out_dir: str = "audio/vo") -> list[dict]:
    """One planned tts job per line, so each line can be retaken alone."""
    jobs = []
    for scene in doc.get("scenes") or []:
        for ln in scene.get("lines") or []:
            j = {"id": f"tts-{ln['id']}", "kind": "tts", "scene": scene.get("id"), "shot": ln.get("shot"),
                 "speaker": ln["speaker"], "text": ln["text"], "provider": doc["provider"], "tts_model": doc["model"],
                 "out": f"{out_dir}/{ln['id']}.{doc.get('format', 'mp3')}", "status": "planned"}
            if ln.get("directed_text"):
                j["directed_text"] = ln["directed_text"]
            if doc.get("language"):
                j["language"] = doc["language"]
            jobs.append(j)
    return jobs
