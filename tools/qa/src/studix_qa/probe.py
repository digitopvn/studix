"""probe: container, video and audio facts of one media file (ffprobe), the base of the duration, fps and sync
checks."""
from __future__ import annotations

from .ff import ffprobe_json, rational
from .sandbox import Deadline, Media, ToolError


def _num(value: object) -> float | None:
    try:
        v = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return v if v == v else None  # NaN -> None


def summarize(info: dict) -> dict:
    """Reduce ffprobe's -show_format -show_streams JSON to the facts the gates read (first video and first
    audio stream; attached pictures such as cover art are not video)."""
    fmt = info.get("format") or {}
    streams = info.get("streams") or []
    video = next((s for s in streams if s.get("codec_type") == "video"
                  and not (s.get("disposition") or {}).get("attached_pic")), None)
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
    duration = _num(fmt.get("duration"))
    out: dict = {
        "formatName": fmt.get("format_name"),
        "durationS": duration,
        "sizeBytes": int(fmt["size"]) if str(fmt.get("size", "")).isdigit() else None,
        "streamCount": len(streams),
        "video": None,
        "audio": None,
    }
    if video:
        out["video"] = {
            "codec": video.get("codec_name"),
            "width": int(video.get("width") or 0),
            "height": int(video.get("height") or 0),
            "fps": rational(video.get("avg_frame_rate")) or rational(video.get("r_frame_rate")),
            "pixFmt": video.get("pix_fmt"),
            "startS": _num(video.get("start_time")) or 0.0,
            "durationS": _num(video.get("duration")) or duration,
            "frames": int(video["nb_frames"]) if str(video.get("nb_frames", "")).isdigit() else None,
        }
    if audio:
        out["audio"] = {
            "codec": audio.get("codec_name"),
            "sampleRate": int(audio.get("sample_rate") or 0),
            "channels": int(audio.get("channels") or 0),
            "startS": _num(audio.get("start_time")) or 0.0,
            "durationS": _num(audio.get("duration")) or duration,
        }
    return out


def run(payload: dict, media: Media, deadline: Deadline, _outputs) -> dict:
    path = media.path(payload.get("media"))
    info = summarize(ffprobe_json(path, deadline))
    if info["video"] is None and info["audio"] is None:
        raise ToolError("VALIDATION", "file has no audio or video stream", {"media": payload.get("media")})
    return info
