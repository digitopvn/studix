"""glyph-coverage: which characters of some on-screen text a font file has no glyph for.

A missing glyph renders as a blank or a tofu box, and the picture alone cannot say whether a box is a design
choice. This reads the font's `cmap` directly (TrueType and OpenType, formats 4 and 12), so it needs no font
library. Text is NFC-normalised first, as the renderers do (precomposed Vietnamese letters shape most reliably).
WOFF and WOFF2 are compressed and not read: pass the TTF or OTF the web font was made from.
"""
from __future__ import annotations

import struct
import unicodedata
from bisect import bisect_left
from collections import Counter

from .sandbox import Deadline, Media, ToolError

MAX_TEXTS, MAX_TEXT_CHARS, MAX_FONT_BYTES, MAX_SUBTABLES = 200, 2000, 32 * 1024 * 1024, 8


def _table(data: bytes, tag: bytes) -> tuple[int, int] | None:
    if data[:4] in (b"wOFF", b"wOF2"):
        raise ToolError("VALIDATION", "WOFF fonts are not supported; pass the TTF or OTF")
    if data[:4] == b"ttcf":
        offset = struct.unpack(">I", data[12:16])[0]
    elif data[:4] in (b"\x00\x01\x00\x00", b"OTTO", b"true"):
        offset = 0
    else:
        raise ToolError("VALIDATION", "file is not a TrueType or OpenType font")
    (count,) = struct.unpack(">H", data[offset + 4:offset + 6])
    for i in range(count):
        rec = offset + 12 + 16 * i
        t, _chk, off, length = struct.unpack(">4sIII", data[rec:rec + 16])
        if t == tag:
            return off, length
    return None


def _wanted_in(wanted: list[int], lo: int, hi: int):
    """The wanted code points inside [lo, hi]; the work is the number of hits, never the width of the range."""
    for i in range(bisect_left(wanted, lo), len(wanted)):
        if wanted[i] > hi:
            return
        yield wanted[i]


def codepoints(data: bytes, wanted: set[int], deadline: Deadline) -> set[int]:
    """The `wanted` code points the font draws. Only those are looked up, so a crafted cmap (huge ranges, many
    segments) costs no more than the text asks for."""
    try:
        return _covered(data, sorted(wanted), deadline)
    except struct.error as err:
        raise ToolError("VALIDATION", "font header or cmap is truncated or malformed") from err


def _covered(data: bytes, wanted: list[int], deadline: Deadline) -> set[int]:
    found = _table(data, b"cmap")
    if found is None:
        raise ToolError("VALIDATION", "font has no cmap table")
    base, _length = found
    (n,) = struct.unpack(">H", data[base + 2:base + 4])
    covered: set[int] = set()
    seen: set[int] = set()
    unicode_tables = 0
    for i in range(n):
        platform, encoding, off = struct.unpack(">HHI", data[base + 4 + 8 * i:base + 12 + 8 * i])
        if not (platform == 0 or (platform == 3 and encoding in (1, 10))) or off in seen:
            continue
        seen.add(off)
        unicode_tables += 1
        if unicode_tables > MAX_SUBTABLES:
            raise ToolError("VALIDATION", "font cmap has too many Unicode subtables")
        deadline.remaining()
        sub = base + off
        (fmt,) = struct.unpack(">H", data[sub:sub + 2])
        if fmt == 4:
            (seg2,) = struct.unpack(">H", data[sub + 6:sub + 8])
            seg = seg2 // 2
            end = struct.unpack(f">{seg}H", data[sub + 14:sub + 14 + seg2])
            start = struct.unpack(f">{seg}H", data[sub + 16 + seg2:sub + 16 + 2 * seg2])
            delta = struct.unpack(f">{seg}h", data[sub + 16 + 2 * seg2:sub + 16 + 3 * seg2])
            range_off = struct.unpack(f">{seg}H", data[sub + 16 + 3 * seg2:sub + 16 + 4 * seg2])
            for k in range(seg):
                for c in _wanted_in(wanted, start[k], end[k]):
                    if c == 0xFFFF:
                        continue
                    if range_off[k] == 0:
                        gid = (c + delta[k]) & 0xFFFF
                    else:
                        at = sub + 16 + 3 * seg2 + 2 * k + range_off[k] + 2 * (c - start[k])
                        (gid,) = struct.unpack(">H", data[at:at + 2])
                        gid = (gid + delta[k]) & 0xFFFF if gid else 0
                    if gid:
                        covered.add(c)
        elif fmt == 12:
            (groups,) = struct.unpack(">I", data[sub + 12:sub + 16])
            if groups > (len(data) - sub - 16) // 12:
                raise ToolError("VALIDATION", "font cmap is truncated or malformed")
            for g in range(groups):
                s, e, gid = struct.unpack(">III", data[sub + 16 + 12 * g:sub + 28 + 12 * g])
                for c in _wanted_in(wanted, s, e):
                    if gid + (c - s) != 0:  # glyph 0 is .notdef: a group may start at it
                        covered.add(c)
    if not seen:
        raise ToolError("VALIDATION", "font has no Unicode cmap (format 4 or 12)")
    return covered


def run(payload: dict, media: Media, deadline: Deadline, _outputs) -> dict:
    font = media.path(payload.get("font"))
    texts = payload.get("texts")
    if (not isinstance(texts, list) or not texts or len(texts) > MAX_TEXTS
            or not all(isinstance(t, str) and len(t) <= MAX_TEXT_CHARS for t in texts)):
        raise ToolError("VALIDATION", f"texts must be 1 to {MAX_TEXTS} strings of at most {MAX_TEXT_CHARS} characters")
    if font.stat().st_size > MAX_FONT_BYTES:
        raise ToolError("VALIDATION", "font file is larger than 32 MiB")
    wanted: Counter[str] = Counter()
    for text in texts:
        for ch in unicodedata.normalize("NFC", text):
            if unicodedata.category(ch)[0] not in ("C", "Z"):
                wanted[ch] += 1
    covered = codepoints(font.read_bytes(), {ord(ch) for ch in wanted}, deadline)
    missing = [{"char": ch, "codepoint": f"U+{ord(ch):04X}", "count": n}
               for ch, n in sorted(wanted.items(), key=lambda kv: ord(kv[0])) if ord(ch) not in covered]
    return {"checked": len(wanted), "missing": missing, "missingCount": len(missing),
            "vietnameseMissing": sum(1 for m in missing if _vietnamese(m["char"]))}


VIETNAMESE_MARKS = {"\u0300", "\u0301", "\u0303", "\u0309", "\u0323", "\u0302", "\u0306", "\u031b"}


def _vietnamese(ch: str) -> bool:
    """A letter Vietnamese writes with a tone mark or its own diacritics (a, e, o, u, y variants, d with stroke)."""
    return ch in "đĐ" or any(m in VIETNAMESE_MARKS for m in unicodedata.normalize("NFD", ch)[1:])
