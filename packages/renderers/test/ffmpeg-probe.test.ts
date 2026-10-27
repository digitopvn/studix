import { StudixError } from "@studix/shared";
import { describe, expect, it } from "vitest";
import { FfmpegProbe, parseFfprobeJson, probeMismatches } from "../src/index.ts";

const sample = JSON.stringify({
  streams: [
    { codec_type: "video", codec_name: "h264", width: 540, height: 960, avg_frame_rate: "30000/1001" },
    { codec_type: "audio", codec_name: "aac" },
  ],
  format: { duration: "15.016000", size: "123456" },
});

describe("parseFfprobeJson", () => {
  it("normalizes ffprobe output into a MediaProbe", () => {
    expect(parseFfprobeJson(sample)).toEqual({
      durationMs: 15016,
      width: 540,
      height: 960,
      fps: 29.97,
      videoCodec: "h264",
      audioCodec: "aac",
      bytes: 123456,
    });
  });

  it("falls back to r_frame_rate and the file size, and rejects audio-only or invalid output", () => {
    const probe = parseFfprobeJson(
      JSON.stringify({
        streams: [{ codec_type: "video", codec_name: "h264", r_frame_rate: "12/1" }],
        format: {},
      }),
      42,
    );
    expect(probe).toMatchObject({ fps: 12, bytes: 42, durationMs: 0 });
    expect(probe.audioCodec).toBeUndefined();
    expect(() => parseFfprobeJson(JSON.stringify({ streams: [{ codec_type: "audio" }] }))).toThrow(
      /no video stream/,
    );
    expect(() => parseFfprobeJson("not json")).toThrow(StudixError);
  });
});

describe("probeMismatches", () => {
  const probe = parseFfprobeJson(sample);

  it("accepts a matching render within the duration tolerance", () => {
    expect(
      probeMismatches(probe, { width: 540, height: 960, durationMs: 15000, videoCodec: "h264" }),
    ).toEqual([]);
  });

  it("lists every mismatch", () => {
    expect(
      probeMismatches(probe, { width: 1080, height: 1920, durationMs: 10000, videoCodec: "hevc" }),
    ).toEqual([
      "resolution 540x960, expected 1080x1920",
      "duration 15016ms, expected 10000ms (+/-120ms)",
      "video codec h264, expected hevc",
    ]);
  });
});

describe("FfmpegProbe", () => {
  it("fails with NOT_FOUND for a missing file and UNAVAILABLE for a missing binary", async () => {
    await expect(new FfmpegProbe().probe("/nonexistent/studix.mp4")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    const missingBinary = new FfmpegProbe({ ffprobePath: "studix-no-such-ffprobe" });
    await expect(missingBinary.probe(import.meta.filename)).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });
});
