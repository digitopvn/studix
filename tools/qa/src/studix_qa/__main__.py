"""CLI: `python -I -m studix_qa <tool>` reads one JSON request on stdin and prints one JSON response on stdout.

request   {"input": {...}, "media": {"<id>": "<absolute path>"}, "timeoutS": 120, "memoryMb": 4096}
response  {"ok": true, "tool": "<tool>", "result": {...}}
          {"ok": false, "tool": "<tool>", "error": {"code", "message", "details"?}}

Exit status 0 with a result, 1 with an error. Writes go only to $STUDIX_QA_OUT. `--list` prints the tool names.
"""
from __future__ import annotations

import json
import math
import os
import sys
import traceback

from . import TOOLS
from .sandbox import Deadline, Media, Outputs, ToolError, disable_network, limit_memory

MAX_REQUEST_BYTES = 8 * 1024 * 1024


def _clean(value):
    """JSON has no NaN or infinity: report them as null instead of printing invalid JSON."""
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, dict):
        return {str(k): _clean(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_clean(v) for v in value]
    if hasattr(value, "item"):  # numpy scalar
        return _clean(value.item())
    return value


def _request() -> dict:
    raw = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
    if len(raw) > MAX_REQUEST_BYTES:
        raise ToolError("VALIDATION", "request is larger than 8 MiB")
    try:
        req = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as err:
        raise ToolError("VALIDATION", "request is not UTF-8 JSON") from err
    if not isinstance(req, dict) or not isinstance(req.get("input", {}), dict):
        raise ToolError("VALIDATION", "request must be an object with an `input` object")
    return req


def execute(tool: str) -> tuple[int, dict]:
    try:
        if tool not in TOOLS:
            raise ToolError("VALIDATION", f"unknown tool {tool!r}", {"tools": sorted(TOOLS)})
        req = _request()
        memory = req.get("memoryMb")
        limit_memory(int(memory) if isinstance(memory, (int, float)) and memory > 0 else None)
        disable_network()
        timeout = req.get("timeoutS", 120)
        if not isinstance(timeout, (int, float)):
            raise ToolError("VALIDATION", "timeoutS must be a number")
        deadline = Deadline(float(timeout))
        result = TOOLS[tool](req.get("input", {}), Media(req.get("media", {})), deadline,
                             Outputs(os.environ.get("STUDIX_QA_OUT")))
        return 0, {"ok": True, "tool": tool, "result": _clean(result)}
    except ToolError as err:
        return 1, {"ok": False, "tool": tool, "error": _clean(err.payload())}
    except MemoryError:
        return 1, {"ok": False, "tool": tool, "error": {"code": "INTERNAL", "message": "tool ran out of memory"}}
    except Exception as err:  # noqa: BLE001 - every failure must still answer in JSON
        traceback.print_exc(file=sys.stderr)
        return 1, {"ok": False, "tool": tool, "error": {"code": "INTERNAL", "message": f"{type(err).__name__}: {err}"}}


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if args == ["--list"]:
        print(json.dumps(sorted(TOOLS)))
        return 0
    if len(args) != 1:
        print(__doc__, file=sys.stderr)
        return 2
    code, response = execute(args[0])
    sys.stdout.write(json.dumps(response, ensure_ascii=False, allow_nan=False))
    sys.stdout.flush()
    return code


if __name__ == "__main__":
    sys.exit(main())
