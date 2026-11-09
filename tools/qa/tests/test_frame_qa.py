"""frame-qa and glyph-coverage through the CLI, on lavfi media and a synthetic font with known coverage."""
from __future__ import annotations

import struct

from conftest import av_file, ffmpeg, result, run_tool

SAMPLES = 4


def _clip(path, vf: str, *, source="testsrc2=s=320x180:r=24:d=4"):
    ffmpeg("-f", "lavfi", "-i", source, "-vf", vf, "-t", "4", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(path))
    return path


def test_a_moving_picture_passes_and_writes_a_contact_sheet(tmp_path, ffmpeg_available):
    out = tmp_path / "out"
    r = result("frame-qa", {"media": "v", "samples": SAMPLES, "safeMarginPct": 0, "contactSheet": True}, {"v": av_file(tmp_path / "a.mkv", audio=None, video="testsrc2=s=320x180:r=24:d=4")}, out_dir=out)
    assert (r["blankSamples"], r["blackSamples"], r["staticPairs"]) == (0, 0, 0)
    assert len(r["samples"]) == SAMPLES
    sheet = out / r["contactSheet"]["file"]
    assert sheet.read_bytes()[:8] == b"\x89PNG\r\n\x1a\n"
    assert (r["contactSheet"]["columns"], r["contactSheet"]["rows"]) == (4, 1)


def test_black_and_blank_frames_are_told_apart(tmp_path, ffmpeg_available):
    black = result("frame-qa", {"media": "v"}, {"v": _clip(tmp_path / "k.mp4", "null", source="color=c=black:s=320x180:r=24:d=4")})
    assert black["blackSamples"] == 6 and black["blankSamples"] == 0
    grey = result("frame-qa", {"media": "v"}, {"v": _clip(tmp_path / "g.mp4", "null", source="color=c=0x808080:s=320x180:r=24:d=4")})
    assert grey["blankSamples"] == 6 and grey["blackSamples"] == 0
    assert any("blank frame" in f for f in grey["flags"])


def test_a_scene_that_never_changes_is_reported_static(tmp_path, ffmpeg_available):
    still = _clip(tmp_path / "s.mp4", "null", source="testsrc2=s=320x180:r=24:d=4,trim=end_frame=1,loop=loop=-1:size=1")
    r = result("frame-qa", {"media": "v", "samples": 3}, {"v": still})
    assert r["staticPairs"] == 2
    assert r["blankSamples"] == 0


def test_text_like_content_in_the_margin_is_flagged_only_there(tmp_path, ffmpeg_available):
    # Thin white strokes on a dark background: one pair of bars at the left edge, one well inside the frame.
    edge = _clip(tmp_path / "e.mp4", "drawbox=x=2:y=40:w=3:h=100:c=white:t=fill,drawbox=x=8:y=40:w=3:h=100:c=white:t=fill",
                 source="color=c=0x202020:s=320x180:r=24:d=2")
    inner = _clip(tmp_path / "i.mp4", "drawbox=x=150:y=60:w=3:h=60:c=white:t=fill,drawbox=x=160:y=60:w=3:h=60:c=white:t=fill",
                  source="color=c=0x202020:s=320x180:r=24:d=2")
    assert result("frame-qa", {"media": "v", "samples": 2}, {"v": edge})["marginSamples"] == 2
    assert result("frame-qa", {"media": "v", "samples": 2}, {"v": inner})["marginSamples"] == 0
    assert result("frame-qa", {"media": "v", "samples": 2, "safeMarginPct": 0}, {"v": edge})["marginSamples"] == 0


def test_no_output_dir_means_no_contact_sheet_and_audio_only_is_rejected(tmp_path, ffmpeg_available):
    r = result("frame-qa", {"media": "v"}, {"v": av_file(tmp_path / "a.mkv", audio=None)})
    assert r["contactSheet"] is None
    from conftest import wav
    audio = wav(tmp_path / "a.wav", "sine=f=440:d=1")
    assert run_tool("frame-qa", {"media": "v"}, {"v": audio})["error"]["code"] == "VALIDATION"
    assert run_tool("frame-qa", {"media": "v", "samples": 1}, {"v": av_file(tmp_path / "b.mkv", audio=None)})["error"]["code"] == "VALIDATION"


def _font(path, codepoints, *, fmt=4):
    """A bare sfnt with only a cmap table mapping each code point to a non-zero glyph."""
    cps = sorted(codepoints)
    if fmt == 12:
        groups = b"".join(struct.pack(">III", c, c, i + 1) for i, c in enumerate(cps))
        sub = struct.pack(">HHIII", 12, 0, 16 + len(groups), 0, len(cps)) + groups
    else:
        segs = [(c, c) for c in cps] + [(0xFFFF, 0xFFFF)]
        n = len(segs)
        ends = struct.pack(f">{n}H", *[e for _, e in segs])
        starts = struct.pack(f">{n}H", *[s for s, _ in segs])
        deltas = struct.pack(f">{n}h", *[(1 - s) if s != 0xFFFF else 1 for s, _ in segs])
        ranges = struct.pack(f">{n}H", *([0] * n))
        body = ends + b"\x00\x00" + starts + deltas + ranges
        sub = struct.pack(">HHHHHHH", 4, 14 + len(body), 0, n * 2, 0, 0, 0) + body
    cmap = struct.pack(">HHHHI", 0, 1, 3, 10 if fmt == 12 else 1, 12) + sub
    header = struct.pack(">4sHHHH", b"\x00\x01\x00\x00", 1, 16, 0, 0)
    record = struct.pack(">4sIII", b"cmap", 0, 28, len(cmap))
    path.write_bytes(header + record + cmap)
    return path


def test_glyph_coverage_names_the_missing_vietnamese_letters(tmp_path):
    ascii_only = _font(tmp_path / "a.ttf", [ord(c) for c in "Chao ban C"])
    r = result("glyph-coverage", {"font": "f", "texts": ["Chào bạn", "ĐƯỢC"]}, {"f": ascii_only})
    assert {m["char"] for m in r["missing"]} == set("àạĐƯỢ") - set()
    assert r["vietnameseMissing"] == r["missingCount"] == 5
    full = _font(tmp_path / "f.ttf", [ord(c) for c in "Chào bạn ĐƯỢC"], fmt=12)
    r = result("glyph-coverage", {"font": "f", "texts": ["Chào bạn", "ĐƯỢC"]}, {"f": full})
    assert r["missing"] == [] and r["checked"] == len(set("ChàobạnĐƯỢC"))


def test_glyph_coverage_normalises_decomposed_input_and_rejects_non_fonts(tmp_path):
    font = _font(tmp_path / "v.ttf", [ord(c) for c in "à"])
    r = result("glyph-coverage", {"font": "f", "texts": ["à"]}, {"f": font})  # NFD input
    assert r["missing"] == []
    junk = tmp_path / "x.ttf"
    junk.write_bytes(b"not a font")
    assert run_tool("glyph-coverage", {"font": "f", "texts": ["a"]}, {"f": junk})["error"]["code"] == "VALIDATION"


def test_short_clips_and_a_container_longer_than_its_picture_still_sample(tmp_path, ffmpeg_available):
    short = _clip(tmp_path / "short.mp4", "null", source="testsrc2=s=320x180:r=24:d=1")
    r = result("frame-qa", {"media": "v", "samples": 16}, {"v": short})
    assert len(r["samples"]) == 16 and all(s["kind"] == "ok" for s in r["samples"])
    # 2 s of picture, 6 s of audio in Matroska: the container is 6 s long, the picture is not.
    tail = tmp_path / "tail.mkv"
    ffmpeg("-f", "lavfi", "-i", "testsrc2=s=320x180:r=24:d=2", "-f", "lavfi", "-i", "sine=f=440:d=6",
           "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "pcm_s16le", str(tail))
    r = result("frame-qa", {"media": "v", "samples": 16}, {"v": tail})
    assert abs(r["durationS"] - 2.0) < 0.1 and r["blackSamples"] == 0
    one = tmp_path / "one.mp4"
    ffmpeg("-f", "lavfi", "-i", "testsrc2=s=320x180:r=24:d=1", "-frames:v", "1", "-c:v", "libx264", str(one))
    assert run_tool("frame-qa", {"media": "v"}, {"v": one})["error"]["code"] == "VALIDATION"


def test_portrait_renders_keep_their_aspect_in_the_sheet(tmp_path, ffmpeg_available):
    out = tmp_path / "out"
    clip = _clip(tmp_path / "p.mp4", "null", source="testsrc2=s=180x320:r=24:d=2")
    r = result("frame-qa", {"media": "v", "samples": 2, "contactSheet": True}, {"v": clip}, out_dir=out)
    assert (r["contactSheet"]["frameWidth"], r["contactSheet"]["frameHeight"]) == (180, 320)
    assert (out / "contact-sheet.png").exists()


def test_the_contact_sheet_is_off_unless_asked_for(tmp_path, ffmpeg_available):
    out = tmp_path / "out"
    r = result("frame-qa", {"media": "v"}, {"v": av_file(tmp_path / "a.mkv", audio=None)}, out_dir=out)
    assert r["contactSheet"] is None and not out.exists()


def test_crafted_fonts_cost_no_more_than_the_text_asks_for(tmp_path):
    import time

    def sfnt(sub, platform=3, encoding=10):
        cmap = struct.pack(">HHHHI", 0, 1, platform, encoding, 12) + sub
        return struct.pack(">4sHHHH", b"\x00\x01\x00\x00", 1, 16, 0, 0) + struct.pack(">4sIII", b"cmap", 0, 28, len(cmap)) + cmap

    # 40 format-12 groups, each one covering a million code points: a walk over the ranges would exhaust memory.
    groups = b"".join(struct.pack(">III", i * 0x100000, i * 0x100000 + 0xFFFFF, 1) for i in range(40))
    huge = tmp_path / "huge.ttf"
    huge.write_bytes(sfnt(struct.pack(">HHIII", 12, 0, 16 + len(groups), 0, 40) + groups))
    started = time.monotonic()
    r = result("glyph-coverage", {"font": "f", "texts": ["Chào"]}, {"f": huge})
    assert time.monotonic() - started < 5 and r["missingCount"] == 0
    # Format 4: 4000 segments each spanning 0..0xFFFE.
    n = 4000
    body = (struct.pack(f">{n}H", *[0xFFFE] * n) + b"\x00\x00" + struct.pack(f">{n}H", *[0] * n)
            + struct.pack(f">{n}h", *[0] * n) + struct.pack(f">{n}H", *[0] * n))
    wide = tmp_path / "wide.ttf"
    wide.write_bytes(sfnt(struct.pack(">HHHHHHH", 4, 14 + len(body), 0, n * 2, 0, 0, 0) + body, 3, 1))
    started = time.monotonic()
    result("glyph-coverage", {"font": "f", "texts": ["Chào"]}, {"f": wide})
    assert time.monotonic() - started < 5


def test_malformed_font_headers_are_validation_errors(tmp_path):
    for name, blob in {"short": b"\x00\x01\x00\x00", "ttc": b"ttcf" + bytes(8) + struct.pack(">I", 10**6),
                       "cut": struct.pack(">4sHHHH", b"\x00\x01\x00\x00", 3, 0, 0, 0)}.items():
        path = tmp_path / f"{name}.ttf"
        path.write_bytes(blob)
        assert run_tool("glyph-coverage", {"font": "f", "texts": ["a"]}, {"f": path})["error"]["code"] == "VALIDATION", name


def test_a_group_that_starts_at_glyph_zero_still_covers_its_other_letters(tmp_path):
    sub = struct.pack(">HHIII", 12, 0, 28, 0, 1) + struct.pack(">III", 0x61, 0x62, 0)  # a -> .notdef, b -> glyph 1
    cmap = struct.pack(">HHHHI", 0, 1, 3, 10, 12) + sub
    font = tmp_path / "z.ttf"
    font.write_bytes(struct.pack(">4sHHHH", b"\x00\x01\x00\x00", 1, 16, 0, 0)
                     + struct.pack(">4sIII", b"cmap", 0, 28, len(cmap)) + cmap)
    r = result("glyph-coverage", {"font": "f", "texts": ["ab"]}, {"f": font})
    assert [m["char"] for m in r["missing"]] == ["a"]
