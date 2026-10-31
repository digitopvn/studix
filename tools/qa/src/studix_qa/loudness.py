"""loudness: integrated loudness (LUFS), true peak (dBTP) and loudness range (LU) of the first audio stream,
measured with ffmpeg's EBU R128 meter (`ebur128=peak=true`).

Ported from zuey-workspace@10719856:.agents/skills/anime-creator/scripts/studio/delivery_encodes.py
(`parse_ebur128`, `measure`) and scripts/studio/media_inspection.py (`loudness`). The limits themselves
(-14 LUFS +/-1, <= -1.5 dBTP) are hard checks evaluated by the worker, not here.
"""
from __future__ import annotations

import math
import re

from .ff import ffmpeg, ffprobe_json, input_args
from .probe import summarize
from .sandbox import Deadline, Media

_NUMBER = r"(-?(?:\d+(?:\.\d+)?|inf))"


def parse_ebur128(stderr: str) -> dict:
    """Read the meter's Summary block. Values are None when absent; -inf (digital silence) is None too, since
    JSON has no infinity, and `silent` says so."""
    tail = stderr.split("Summary:")[-1]

    def num(label: str, unit: str) -> float | None:
        m = re.search(label + r":\s+" + _NUMBER + r"\s+" + unit, tail)
        if not m:
            return None
        v = float(m.group(1))
        return None if math.isinf(v) else v

    integrated = num("I", "LUFS")
    peak = num("Peak", "dBFS")
    return {
        "integratedLufs": integrated,
        "truePeakDbtp": peak,
        "lraLu": num("LRA", "LU"),
        # The meter floors integrated loudness of silence at -70 LUFS (its absolute gate).
        "silent": peak is None or (integrated is not None and integrated <= -70.0),
    }


def run(payload: dict, media: Media, deadline: Deadline, _outputs) -> dict:
    path = media.path(payload.get("media"))
    if summarize(ffprobe_json(path, deadline))["audio"] is None:
        return {"hasAudio": False, "integratedLufs": None, "truePeakDbtp": None, "lraLu": None, "silent": True}
    stderr = ffmpeg(["-v", "info", *input_args(path), "-map", "0:a:0", "-af", "ebur128=peak=true", "-f", "null",
                     "-"], deadline).stderr.decode("utf-8", "replace")
    return {"hasAudio": True, **parse_ebur128(stderr)}
