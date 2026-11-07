import type { VideoIR } from "@studix/video-ir";
import { describe, expect, it } from "vitest";
import {
  type AudioSourceInfo,
  audioMixGraph,
  gradeFilter,
  isGradeLook,
  loudnessProblems,
  nextLimiterDrive,
  parseLoudnormJson,
  phoneVideoKbps,
  planAudioClips,
  truePeakSafeFilter,
} from "../src/index.ts";
import { loadIrFixture } from "./render-test-helpers.ts";

function promoWithClip(): VideoIR {
  const ir: VideoIR = structuredClone(loadIrFixture("product-promo-16x9-assets"));
  ir.assets.push({ ...ir.assets[0]!, id: "clip", kind: "video", mime: "video/mp4" });
  ir.audio!.push(
    {
      id: "vo",
      kind: "voiceover",
      assetId: "music",
      startMs: 1000,
      durationMs: 9000,
      volume: 1,
      fadeInMs: 5000,
    },
    { id: "late", kind: "sfx", assetId: "music", startMs: 7000, trimStartMs: 29_500, volume: 0.5 },
  );
  // end-card starts at 5000ms on the timeline.
  ir.scenes[1]!.shots.push(
    { id: "loud-clip", type: "video", assetId: "clip", startMs: 500, durationMs: 2000, trimStartMs: 100 },
    { id: "quiet-clip", type: "video", assetId: "clip", startMs: 0, durationMs: 1000, muted: true },
  );
  return ir;
}

const files = { music: "/m/music.mp3", clip: "/m/clip.mp4" };

describe("planAudioClips", () => {
  const sources = new Map<string, AudioSourceInfo>([
    ["/m/music.mp3", { hasAudio: true, durationMs: 30_000 }],
    ["/m/clip.mp4", { hasAudio: true, durationMs: 10_000 }],
  ]);

  it("places tracks and unmuted video sound on the absolute timeline, clamped to video and source", () => {
    const clips = planAudioClips(promoWithClip(), files, sources);
    expect(clips).toEqual([
      {
        id: "bg-music",
        kind: "music",
        file: "/m/music.mp3",
        startMs: 0,
        durationMs: 8000,
        trimStartMs: 0,
        volume: 0.6,
        fadeInMs: 0,
        fadeOutMs: 1000,
      },
      // 9000ms requested from 1000ms is cut at the 8000ms video end.
      expect.objectContaining({ id: "vo", startMs: 1000, durationMs: 7000, fadeInMs: 5000, fadeOutMs: 0 }),
      // Only 500ms of source remain after the 29.5s trim.
      expect.objectContaining({ id: "late", startMs: 7000, durationMs: 500, trimStartMs: 29_500 }),
      expect.objectContaining({
        id: "loud-clip",
        kind: "video",
        file: "/m/clip.mp4",
        startMs: 5500,
        durationMs: 2000,
      }),
    ]);
  });

  it("skips video shots whose source has no audio stream", () => {
    const silent = new Map(sources).set("/m/clip.mp4", { hasAudio: false, durationMs: 10_000 });
    expect(planAudioClips(promoWithClip(), files, silent).map((c) => c.id)).toEqual([
      "bg-music",
      "vo",
      "late",
    ]);
  });

  it("folds gainDb into the linear level and keeps dialogue on its own bus", () => {
    const ir = promoWithClip();
    ir.audio = [
      {
        id: "line",
        kind: "dialogue",
        assetId: "music",
        startMs: 0,
        durationMs: 1000,
        volume: 0.5,
        gainDb: 6,
      },
      { id: "hit", kind: "sfx", assetId: "music", startMs: 0, durationMs: 1000, volume: 1, gainDb: -20 },
    ];
    const [line, hit] = planAudioClips(ir, files, sources);
    expect(line).toMatchObject({ kind: "dialogue" });
    expect(line!.volume).toBeCloseTo(0.9976, 4);
    expect(hit!.volume).toBeCloseTo(0.1, 6);
  });

  it("shortens fades that would not fit inside the clip", () => {
    const ir = promoWithClip();
    ir.audio = [
      {
        id: "s",
        kind: "sfx",
        assetId: "music",
        startMs: 0,
        durationMs: 1000,
        volume: 1,
        fadeInMs: 800,
        fadeOutMs: 800,
      },
    ];
    expect(planAudioClips(ir, files, sources)[0]).toMatchObject({ fadeInMs: 800, fadeOutMs: 200 });
  });
});

describe("audioMixGraph", () => {
  it("trims, levels, fades and delays every clip, then sums without normalisation to the exact length", () => {
    const graph = audioMixGraph(
      [
        {
          id: "a",
          kind: "music",
          file: "a",
          startMs: 0,
          durationMs: 4000,
          trimStartMs: 0,
          volume: 0.5,
          fadeInMs: 300,
          fadeOutMs: 500,
        },
        {
          id: "b",
          kind: "sfx",
          file: "b",
          startMs: 2500,
          durationMs: 300,
          trimStartMs: 120,
          volume: 1,
          fadeInMs: 0,
          fadeOutMs: 0,
        },
      ],
      4000,
    );
    expect(graph.split(";")).toEqual([
      "[0:a:0]atrim=start=0.000:duration=4.000,asetpts=PTS-STARTPTS,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,volume=0.5000,afade=t=in:st=0:d=0.300,afade=t=out:st=3.500:d=0.500[c0]",
      "[1:a:0]atrim=start=0.120:duration=0.300,asetpts=PTS-STARTPTS,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,volume=1.0000,adelay=delays=2500:all=1[c1]",
      "[c0][c1]amix=inputs=2:duration=longest:normalize=0,apad=whole_dur=4.000,atrim=duration=4.000[mix]",
    ]);
  });
});

describe("loudness helpers", () => {
  const stderr = `[Parsed_loudnorm_0 @ 0x1]
{
\t"input_i" : "-23.41",
\t"input_tp" : "-6.02",
\t"input_lra" : "3.10",
\t"input_thresh" : "-33.70",
\t"output_i" : "-14.02",
\t"output_tp" : "-2.00",
\t"output_lra" : "2.90",
\t"output_thresh" : "-24.30",
\t"normalization_type" : "linear",
\t"target_offset" : "0.02"
}
`;

  it("parses loudnorm's JSON analysis block", () => {
    expect(parseLoudnormJson(stderr)).toEqual({
      integratedLufs: -23.41,
      truePeakDbtp: -6.02,
      lra: 3.1,
      threshold: -33.7,
      targetOffset: 0.02,
    });
  });

  it("accepts -14 LUFS +/-1 with true peak at or under -1.5 dBTP only", () => {
    expect(loudnessProblems({ integratedLufs: -14.6, truePeakDbtp: -1.5 })).toEqual([]);
    expect(loudnessProblems({ integratedLufs: -15.2, truePeakDbtp: -2 })).toHaveLength(1);
    expect(loudnessProblems({ integratedLufs: -14, truePeakDbtp: -1.2 })).toEqual([
      "true peak -1.2 dBTP > -1.5",
    ]);
    expect(loudnessProblems({ integratedLufs: Number.NEGATIVE_INFINITY, truePeakDbtp: -90 })).toHaveLength(1);
  });

  it("limits on a 4x-oversampled copy with an optional drive", () => {
    expect(truePeakSafeFilter(0.6, 1.25)).toBe(
      "volume=1.25dB,lowpass=f=18000:p=2,aresample=192000,alimiter=limit=0.6:attack=1:release=50:level=false:latency=1,aresample=48000",
    );
  });
});

describe("finish helpers", () => {
  it("sizes the phone copy under the chat upload limit and caps short clips", () => {
    expect(phoneVideoKbps(120_000, 128)).toBe(1770);
    expect(phoneVideoKbps(5_000, 128)).toBe(6000);
  });

  it("only accepts named grade looks", () => {
    expect(isGradeLook("warm")).toBe(true);
    expect(isGradeLook("eq=contrast=9")).toBe(false);
    expect(gradeFilter("neutral")).toBe("format=gbrp,eq=contrast=1.02:saturation=1.02,format=yuv420p");
  });
});

describe("nextLimiterDrive", () => {
  const start = { gainDb: 0, ceilingDb: 0 };

  it("lowers the limiter ceiling below a true-peak overshoot and keeps the gain", () => {
    const next = nextLimiterDrive({ integratedLufs: -14.01, truePeakDbtp: -1.28 }, start);
    expect(next?.gainDb).toBe(0);
    expect(next?.ceilingDb).toBeCloseTo(-0.52, 5);
  });

  it("drives the missing gain into the limiter when the file is too quiet", () => {
    expect(nextLimiterDrive({ integratedLufs: -16.5, truePeakDbtp: -3 }, start)).toEqual({
      gainDb: 2.5,
      ceilingDb: 0,
    });
  });

  it("gives up once the ceiling or the gain is at its bound", () => {
    expect(
      nextLimiterDrive({ integratedLufs: -14, truePeakDbtp: 0 }, { gainDb: 0, ceilingDb: -6 }),
    ).toBeNull();
    expect(
      nextLimiterDrive({ integratedLufs: -30, truePeakDbtp: -3 }, { gainDb: 9, ceilingDb: 0 }),
    ).toBeNull();
  });
});
