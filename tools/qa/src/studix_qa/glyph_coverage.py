"""glyph-coverage: which characters of some on-screen text a font file has no glyph for.

A missing glyph renders as a blank or a tofu box, and the picture alone cannot say whether a box is a design
choice. This reads the font's `cmap` directly (TrueType and OpenType, formats 4 and 12), so it needs no font
library. Text is NFC-normalised first, as the renderers do (precomposed Vietnamese letters shape most reliably).
WOFF and WOFF2 are compressed and not read: pass the TTF or OTF the web font was made from.
"""
from __future__ import annotations

import struct
import unicodedata
from collections import Counter

from .sandbox import Deadline, Media, ToolError

MAX_TEXTS, MAX_TEXT_CHARS, MAX_FONT_BYTES = 200, 2000, 32 * 1024 * 1024


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


def codepoints(data: bytes) -> set[int]:
    found = _table(data, b"cmap")
    if found is None:
        raise ToolError("VALIDATION", "font has no cmap table")
    base, _length = found
    (n,) = struct.unpack(">H", data[base + 2:base + 4])
    covered: set[int] = set()
    seen = set()
    try:
        for i in range(n):
            platform, encoding, off = struct.unpack(">HHI", data[base + 4 + 8 * i:base + 12 + 8 * i])
            if not (platform == 0 or (platform == 3 and encoding in (1, 10))) or off in seen:
                continue
            seen.add(off)
            sub = base + off
            (fmt,) = struct.unpack(">H", data[sub:sub + 2])
            if fmt == 4:
                (seg2,) = struct.unpack(">H", data[sub + 6:sub + 8])
                seg = seg2 // 2
                end = struct.unpack(f">{seg}H", data[sub + 14:sub + 14 + seg2])
                start = struct.unpack(f">{seg}H", data[sub + 16 + seg2:sub + 16 + 2 * seg2])
                delta = struct.unpack(f">{seg}h", data[sub + 16 + 2 * seg2:sub + 16 + 3 * seg2])
                range_off = struct.unpack(f">{seg}H", data[sub + 16 + 3 * seg2:sub + 16 + 4 * seg2])
                for s, e, d, r, k in zip(start, end, delta, range_off, range(seg)):
                    for c in range(s, e + 1):
                        if c == 0xFFFF:
                            continue
                        if r == 0:
                            gid = (c + d) & 0xFFFF
                        else:
                            at = sub + 16 + 3 * seg2 + 2 * k + r + 2 * (c - s)
                            (gid,) = struct.unpack(">H", data[at:at + 2])
                            gid = (gid + d) & 0xFFFF if gid else 0
                        if gid:
                            covered.add(c)
            elif fmt == 12:
                (groups,) = struct.unpack(">I", data[sub + 12:sub + 16])
                for g in range(groups):
                    s, e, gid = struct.unpack(">III", data[sub + 16 + 12 * g:sub + 28 + 12 * g])
                    if e - s > 0x110000:
                        raise ToolError("VALIDATION", "font cmap is malformed")
                    if gid:
                        covered.update(range(s, e + 1))
    except struct.error as err:
        raise ToolError("VALIDATION", "font cmap is truncated or malformed") from err
    if not covered:
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
    covered = codepoints(font.read_bytes())
    wanted: Counter[str] = Counter()
    for text in texts:
        for ch in unicodedata.normalize("NFC", text):
            cat = unicodedata.category(ch)
            if cat[0] in ("C", "Z"):
                continue
            wanted[ch] += 1
    missing = [{"char": ch, "codepoint": f"U+{ord(ch):04X}", "count": n}
               for ch, n in sorted(wanted.items(), key=lambda kv: ord(kv[0])) if ord(ch) not in covered]
    return {"checked": len(wanted), "missing": missing, "missingCount": len(missing),
            "vietnameseMissing": sum(1 for m in missing if _vietnamese(m["char"]))}


VIETNAMESE_MARKS = {"\u0300", "\u0301", "\u0303", "\u0309", "\u0323", "\u0302", "\u0306", "\u031b"}


def _vietnamese(ch: str) -> bool:
    """A letter Vietnamese writes with a tone mark or its own diacritics (a, e, o, u, y variants, d with stroke)."""
    return ch in "đĐ" or any(m in VIETNAMESE_MARKS for m in unicodedata.normalize("NFD", ch)[1:])
