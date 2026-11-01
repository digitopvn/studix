"""Studix QA measurement tools. Each tool takes a JSON input, reads only granted media, and returns JSON; the
worker wraps every tool in a typed TypeScript contract (packages/qa)."""
from __future__ import annotations

from collections.abc import Callable

from . import (
    black_frames,
    depth_maps,
    judge_reports,
    loudness,
    mix_buses,
    prescan,
    probe,
    shot_boundaries,
    speech_activity,
    sync,
)

#: tool name -> run(input, media, deadline, outputs) -> result
TOOLS: dict[str, Callable] = {
    "probe": probe.run,
    "loudness": loudness.run,
    "black-frames": black_frames.run,
    "sync": sync.run,
    "prescan": prescan.run,
    "mix-buses": mix_buses.run,
    "judge-reports": judge_reports.run,
    "depth-maps": depth_maps.run,
    "shot-boundaries": shot_boundaries.run,
    "speech-activity": speech_activity.run,
}
