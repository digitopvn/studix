"""Generate a scene's HyperFrames index.html from src/edit-template.html + edl.json, and episode-level timing.

build_edit       fills the template: one muted <video> per video shot (HyperFrames cuts them by data-start /
                 data-duration), the title card, and one live-caption block per dialogue line (spoken text,
                 translation, per-word spans for karaoke, speaker colour). --duration renders a short slice.
episode_timeline scene order and absolute offsets from episode.json + each scene's EDL, used by the mixer,
                 the subtitle export and the episode concat.
export_subtitles SRT or WebVTT for the whole episode (sidecar captions for upload platforms).
"""
from __future__ import annotations

import html
import re
from pathlib import Path

from .common_io_and_paths import load_json


def _words_html(line: dict) -> str:
    words = line.get("words") or []
    if not words:
        # a literal newline forces a caption line break (e.g. a caption-only aside on its own line)
        return html.escape(line["text"]).replace("\n", "<br>")
    spaced = " " in line["text"].strip()
    return (" " if spaced else "").join(f'<span class="w{i}">{html.escape(w["text"])}</span>' for i, w in enumerate(words))


def captions_html(edl: dict, until: float | None = None) -> str:
    spk = edl.get("speakers") or {}
    out = []
    for s in edl["shots"]:
        for n, line in enumerate(s.get("dialogue") or []):
            if until is not None and line["t0"] >= until:
                continue
            color = (spk.get(line.get("speaker")) or {}).get("color", "#ffffff")
            mono = "" if line.get("tr") else " mono"
            l2 = f'<span class="l2">{html.escape(line["tr"])}</span>' if line.get("tr") else ""
            # cap_bottom (px from the frame bottom) lifts a line clear of a close-up mouth or on-screen UI
            pos = f";bottom:{line['cap_bottom']}px" if line.get("cap_bottom") is not None else ""
            out.append(f'      <div class="cap{mono}" id="cap-{s["id"]}-{n}" style="--spk:{color}{pos}"><span class="l1">{_words_html(line)}</span>{l2}</div>')
    return "\n".join(out)


def videos_html(edl: dict, until: float | None = None) -> str:
    out = []
    for s in edl["shots"]:
        if s.get("kind") != "video" or (until is not None and s["start"] >= until):
            continue
        end = min(s["end"], until) if until is not None else s["end"]
        out.append(f'          <video class="clip" id="v-{s["id"]}" src="clips/{s["id"]}.mp4" data-start="{s["start"]:.6f}" '
                   f'data-duration="{end - s["start"]:.6f}" muted playsinline preload="auto"></video>')
    return "\n".join(out)


def build_edit(scene_dir: Path, *, duration: float | None = None, lang: str = "vi") -> Path:
    edl = load_json(scene_dir / "edl.json")
    tpl_p = scene_dir / "src" / "edit-template.html"
    tpl = tpl_p.read_text(encoding="utf-8")
    dur = min(duration, edl["duration"]) if duration else edl["duration"]
    until = dur if duration else None
    missing = [s["id"] for s in edl["shots"] if s.get("kind") == "video" and not (scene_dir / "clips" / f"{s['id']}.mp4").exists()
               and (until is None or s["start"] < until)]
    if missing:
        raise SystemExit(f"missing clips (run conform first): {', '.join(missing)}")
    title = edl.get("title") or {}
    title_html = ""
    if title.get("text"):
        title_html = (f'      <div id="title"><span class="t1">{html.escape(title["text"])}</span>'
                      f'<span class="t2">{html.escape(title.get("sub", ""))}</span></div>')
    rep = {"__LANG__": lang, "__W__": str(edl.get("width", 1920)), "__H__": str(edl.get("height", 1080)),
           "__FPS__": str(edl["fps"]), "__DURATION__": f"{dur:.4f}",
           "__TITLE_PAGE__": html.escape(title.get("text") or scene_dir.name)}
    for k, v in rep.items():
        tpl = tpl.replace(k, v)
    tpl = tpl.replace("<!--VIDEOS-->", videos_html(edl, until).lstrip()).replace("<!--TITLE-->", title_html.lstrip())
    tpl = tpl.replace("<!--CAPTIONS-->", captions_html(edl, until).lstrip())
    out = scene_dir / "index.html"
    out.write_text(tpl, encoding="utf-8")
    return out


def episode_timeline(episode_dir: Path) -> list[dict]:
    ep = load_json(episode_dir / "episode.json")
    t, rows = 0.0, []
    for sc in ep["scenes"]:
        if not (episode_dir / "scenes" / sc / "edl.json").exists():
            continue  # scene planned but not cut yet
        edl = load_json(episode_dir / "scenes" / sc / "edl.json")
        rows.append({"scene": sc, "offset": round(t, 6), "duration": edl["duration"], "fps": edl["fps"], "edl": edl})
        t += edl["duration"]
    return rows


def _stamp(t: float, sep: str) -> str:
    ms = int(round(t * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d}{sep}{ms:03d}"


_SENTENCE_END = re.compile(r"[.!?…。！？][\"'”’)\]」]*$")


def _sentences(text: str) -> list[str]:
    return [p for p in re.split(r"(?<=[.!?…])[\"'”’)\]]*\s+|(?<=[。！？])[”’」]*\s*", text.strip()) if p]


def _line_cues(line: dict, hold: float, max_cue: float) -> list[tuple[float, float, str, str]]:
    """(t0, t1, spoken, tr) for one dialogue line. An aligned line starts on its first spoken word, as the burned-in
    caption does; a line longer than max_cue splits at its sentence ends on the word timings, and the translation
    splits with it only when it has the same number of sentences (otherwise the line stays one cue)."""
    words, tr = line.get("words") or [], line.get("tr") or ""
    on = max(line["t0"], words[0]["t0"] - 0.04) if words else line["t0"]
    whole = [(on, line["t1"] + hold, line["text"], tr)]
    if not words or line["t1"] - on <= max_cue:
        return whole
    groups, cur = [], []
    for w in words:
        cur.append(w)
        if _SENTENCE_END.search(w["text"]):
            groups.append(cur)
            cur = []
    if cur:
        groups.append(cur)
    tr_parts = _sentences(tr) if tr else []
    if len(groups) < 2 or (tr and len(tr_parts) != len(groups)):
        return whole
    starts = [max(line["t0"], g[0]["t0"] - 0.04) for g in groups]
    ends = starts[1:] + [line["t1"] + hold]
    said = _sentences(line["text"])  # the script's own wording when it splits the same way as the words
    if len(said) != len(groups):
        said = [" ".join(w["text"] for w in g) for g in groups]
    return [(a, b, said[i], tr_parts[i] if tr else "") for i, (a, b) in enumerate(zip(starts, ends))]


def _caption_off(line: dict, on: float, off: float, cuts: list[float], frame: float) -> float:
    """Where a line's last cue ends, by the burned-in caption's rule (engine edit/captions-from-edl.js): the hold
    stops at a hard cut, and once the last word has been up long enough to read (0.25 s) the take's silent tail
    does not carry the caption over the next shot."""
    cut = next((c for c in cuts if c >= line["t1"] - 2 * frame), None)
    if cut is not None and cut < off:
        off = max(on + frame, cut)
    words = line.get("words") or []
    tail = next((c for c in cuts if c >= words[-1]["t0"] + 0.25), None) if words else None
    if tail is not None and tail < off:
        off = max(on + frame, tail)
    return off


def export_subtitles(episode_dir: Path, fmt: str = "srt", *, hold: float = 0.15, which: str = "both",
                     max_cue: float = 7.0, name: str | None = None) -> Path:
    """which: spoken | tr | both (two lines). name: file stem in renders/ (default: the episode folder name, which
    every export overwrites; pass e.g. "ep01-cut3-en" to keep one subtitle file per cut or language)."""
    cues = []
    for row in episode_timeline(episode_dir):
        cuts, frame = [s["end"] for s in row["edl"]["shots"]], 1 / (row["edl"].get("fps") or 24)
        for s in row["edl"]["shots"]:
            for line in s.get("dialogue") or []:
                parts = _line_cues(line, hold, max_cue)
                a, b, spoken, tr = parts[-1]
                parts[-1] = (a, _caption_off(line, a, b, cuts, frame), spoken, tr)
                for a, b, spoken, tr in parts:
                    text = {"spoken": spoken, "tr": tr or spoken, "both": spoken + ("\n" + tr if tr else "")}[which]
                    cues.append((row["offset"] + a, row["offset"] + b, text))
    cues.sort()
    # a cue never runs under the next one: the hold tail is trimmed to the next start
    cues = [(a, min(b, cues[i + 1][0]) if i + 1 < len(cues) else b, t) for i, (a, b, t) in enumerate(cues)]
    sep = "," if fmt == "srt" else "."
    lines = [] if fmt == "srt" else ["WEBVTT", ""]
    for i, (a, b, text) in enumerate(cues, 1):
        if fmt == "srt":
            lines.append(str(i))
        lines += [f"{_stamp(a, sep)} --> {_stamp(b, sep)}", text, ""]
    out = episode_dir / "renders" / f"{name or episode_dir.name}.{fmt}"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(lines), encoding="utf-8")
    return out
