import { describe, expect, it } from "vitest";
import { parseAudibleSpan } from "../src/ffmpeg/audible-span.ts";

const log = (...lines: string[]) =>
  ["Input #0, wav, from 'take.wav':", "  Duration: 00:00:02.12, bitrate: 705 kb/s", ...lines].join("\n");

describe("audible span from a silencedetect log", () => {
  it("skips leading and trailing silence (FFmpeg that ends trailing silence at the end of the file)", () => {
    const stderr = log(
      "[silencedetect @ 0x1] silence_start: 0",
      "[silencedetect @ 0x1] silence_end: 0.2 | silence_duration: 0.2",
      "[silencedetect @ 0x1] silence_start: 0.95",
      "[silencedetect @ 0x1] silence_end: 1.05 | silence_duration: 0.1",
      "[silencedetect @ 0x1] silence_start: 1.966",
      "[silencedetect @ 0x1] silence_end: 2.116 | silence_duration: 0.15",
      "size=N/A time=00:00:02.11 bitrate=N/A speed=32x",
    );
    expect(parseAudibleSpan(stderr)).toEqual({ durationMs: 2116, startMs: 200, endMs: 1966 });
  });

  it("reads trailing silence that older FFmpeg leaves open", () => {
    const stderr = log("[silencedetect @ 0x1] silence_start: 1.8");
    expect(parseAudibleSpan(stderr)).toEqual({ durationMs: 2120, startMs: 0, endMs: 1800 });
  });

  it("keeps a pause inside the sound and a file that is sound throughout", () => {
    expect(parseAudibleSpan(log())).toEqual({ durationMs: 2120, startMs: 0, endMs: 2120 });
    const pause = log("silence_start: 0.9", "silence_end: 1.2 | silence_duration: 0.3");
    expect(parseAudibleSpan(pause)).toEqual({ durationMs: 2120, startMs: 0, endMs: 2120 });
  });

  it("has no span for a silent file or a log without a length", () => {
    expect(parseAudibleSpan(log("silence_start: 0"))).toBeUndefined();
    expect(
      parseAudibleSpan(log("silence_start: 0", "silence_end: 2.12 | silence_duration: 2.12")),
    ).toBeUndefined();
    expect(parseAudibleSpan("silence_start: 0.5")).toBeUndefined();
  });
});
