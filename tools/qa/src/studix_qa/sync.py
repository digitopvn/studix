"""sync: how the first audio stream lines up with the first video stream of one file.

audioDelayMs     audio start minus video start (positive: sound starts late)
durationDeltaMs  audio duration minus video duration (positive: sound runs past the picture)

Container timing only: it catches a muxed offset, a dropped or padded audio tail and a mismatched trim. It
does not see a lip-sync slip inside the streams; that needs a mouth or marker measurement.
"""
from __future__ import annotations

from .ff import ffprobe_json
from .probe import summarize
from .sandbox import Deadline, Media, ToolError


def alignment(info: dict) -> dict:
    video, audio = info["video"], info["audio"]
    if video is None or audio is None:
        raise ToolError("VALIDATION", "sync needs both an audio and a video stream",
                        {"hasVideo": video is not None, "hasAudio": audio is not None})
    fps = video["fps"]
    out = {
        "videoStartS": video["startS"],
        "audioStartS": audio["startS"],
        "videoDurationS": video["durationS"],
        "audioDurationS": audio["durationS"],
        "audioDelayMs": round((audio["startS"] - video["startS"]) * 1000, 2),
        "durationDeltaMs": None,
        "frameMs": round(1000 / fps, 3) if fps else None,
    }
    if video["durationS"] is not None and audio["durationS"] is not None:
        out["durationDeltaMs"] = round((audio["durationS"] - video["durationS"]) * 1000, 2)
    return out


def run(payload: dict, media: Media, deadline: Deadline, _outputs) -> dict:
    path = media.path(payload.get("media"))
    return alignment(summarize(ffprobe_json(path, deadline)))
