import { StudixError } from "@studix/shared";
import { z } from "zod";
import { MEDIA_ID, type PythonToolRunOptions, runPythonTool } from "./python-tool-runner.ts";

/**
 * A Python QA tool behind a typed contract: the input is validated before anything starts, the tool only sees
 * the grants its input references, and an answer that does not match `output` is a broken contract (INTERNAL).
 */
export interface QaTool<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> {
  /** CLI name in tools/qa (`python -m studix_qa <name>`). */
  name: string;
  description: string;
  input: I;
  output: O;
  /** Grant ids the input references. */
  mediaRefs(input: z.infer<I>): string[];
  /**
   * When false, references without a grant are allowed and reported by the tool itself (prescan events flag
   * them as missing); otherwise each must be granted.
   */
  strictMedia: boolean;
  timeoutMs: number;
  memoryMb: number;
  /** Image that carries the tool's dependencies; `depth` and `vad` are the optional torch images. */
  image: "default" | "depth" | "vad";
}

export type QaRunOptions = Omit<PythonToolRunOptions, "timeoutMs" | "memoryMb"> & {
  timeoutMs?: number;
  memoryMb?: number;
};

const MediaRef = z.string().regex(MEDIA_ID);
const MediaRefs = z.array(MediaRef).min(1).max(64);
const nullableNumber = z.number().nullable();

// ---------------------------------------------------------------- probe

export const ProbeInput = z.strictObject({ media: MediaRef });
export const ProbeOutput = z.object({
  formatName: z.string().nullable(),
  durationS: nullableNumber,
  sizeBytes: z.number().int().nullable(),
  streamCount: z.number().int(),
  video: z
    .object({
      codec: z.string().nullable(),
      width: z.number().int(),
      height: z.number().int(),
      fps: nullableNumber,
      pixFmt: z.string().nullable(),
      startS: z.number(),
      durationS: nullableNumber,
      frames: z.number().int().nullable(),
    })
    .nullable(),
  audio: z
    .object({
      codec: z.string().nullable(),
      sampleRate: z.number().int(),
      channels: z.number().int(),
      startS: z.number(),
      durationS: nullableNumber,
    })
    .nullable(),
});
export type ProbeResult = z.infer<typeof ProbeOutput>;

// ---------------------------------------------------------------- loudness

export const LoudnessInput = z.strictObject({ media: MediaRef });
export const LoudnessOutput = z.object({
  hasAudio: z.boolean(),
  integratedLufs: nullableNumber,
  truePeakDbtp: nullableNumber,
  lraLu: nullableNumber,
  silent: z.boolean(),
});
export type LoudnessResult = z.infer<typeof LoudnessOutput>;

// ---------------------------------------------------------------- black-frames

export const BlackFramesInput = z.strictObject({
  media: MediaRef,
  thresholdLuma: z.number().gt(0).lt(255).optional(),
});
export const BlackFramesOutput = z.object({
  thresholdLuma: z.number(),
  fps: z.number(),
  frames: z.number().int(),
  blackFrames: z.number().int(),
  leadingS: z.number(),
  trailingS: z.number(),
  maxInnerRunS: z.number(),
  allBlack: z.boolean(),
  runs: z.array(z.object({ startS: z.number(), endS: z.number(), frames: z.number().int() })),
});
export type BlackFramesResult = z.infer<typeof BlackFramesOutput>;

// ---------------------------------------------------------------- sync

export const SyncInput = z.strictObject({ media: MediaRef });
export const SyncOutput = z.object({
  videoStartS: z.number(),
  audioStartS: z.number(),
  videoDurationS: nullableNumber,
  audioDurationS: nullableNumber,
  audioDelayMs: z.number(),
  durationDeltaMs: nullableNumber,
  frameMs: nullableNumber,
});
export type SyncResult = z.infer<typeof SyncOutput>;

// ---------------------------------------------------------------- prescan

const MixEvent = z.strictObject({
  file: MediaRef,
  bus: z.string().min(1).max(32),
  t: z.number().optional(),
  len: z.number().positive().optional(),
  offset: z.number().min(0).optional(),
  fadeOut: z.number().min(0).optional(),
  gain: z.number().optional(),
  onset: z.number().min(0).nullable().optional(),
  loop: z.boolean().optional(),
  scene: z.string().max(64).optional(),
  atShot: z.string().max(64).optional(),
});

export const PrescanInput = z.discriminatedUnion("mode", [
  z.strictObject({
    mode: z.literal("picture"),
    media: MediaRefs,
    fps: z.number().positive().optional(),
    maxLeadBlackS: z.number().min(0).optional(),
    maxHoldS: z.number().min(0).optional(),
  }),
  z.strictObject({
    mode: z.literal("clips"),
    media: MediaRefs,
    fps: z.number().positive().optional(),
    ranges: z
      .record(
        MediaRef,
        z.array(
          z.strictObject({ shot: z.string().min(1).max(64), inS: z.number().min(0), outS: z.number() }),
        ),
      )
      .optional(),
  }),
  z.strictObject({ mode: z.literal("audio"), media: MediaRefs }),
  z.strictObject({
    mode: z.literal("events"),
    events: z.array(MixEvent).max(2000),
    fps: z.number().positive().optional(),
  }),
]);
export const PrescanOutput = z.object({
  mode: z.enum(["picture", "clips", "audio", "events"]),
  files: z.array(z.looseObject({ media: z.string(), flags: z.array(z.string()) })),
  flags: z.array(z.string()),
  events: z.number().int().optional(),
});
export type PrescanResult = z.infer<typeof PrescanOutput>;

// ---------------------------------------------------------------- mix-buses

export const MIX_BUSES = ["beds", "hits", "vo", "music"] as const;
export const MixBusesInput = z.strictObject({
  stems: z.partialRecord(z.enum(MIX_BUSES), MediaRef).refine((s) => Object.keys(s).length > 0, {
    message: "at least one stem",
  }),
  sampleRate: z.number().int().min(8000).max(192_000).optional(),
  shots: z
    .array(
      z
        .strictObject({
          id: z.string().min(1).max(64),
          startS: z.number().min(0),
          endS: z.number(),
          dialogue: z.array(z.strictObject({ t0: z.number(), t1: z.number() })).optional(),
        })
        .refine((s) => s.endS > s.startS, { message: "endS must be after startS" }),
    )
    .min(1)
    .max(2000),
  allow: z.array(z.string()).optional(),
  minMaskPct: z.number().min(0).max(100).optional(),
  maxUnderMusicDb: z.number().optional(),
  minVoOverBedsDb: z.number().optional(),
});
export const MixBusesOutput = z.object({
  shots: z.array(
    z.object({
      id: z.string(),
      allowed: z.boolean(),
      beds: z.number(),
      hits: z.number(),
      vo: z.number(),
      music: z.number(),
      maskPct: nullableNumber,
      bedsMinusMusic: nullableNumber,
      voMinusBeds: nullableNumber,
      fail: z.array(z.string()),
    }),
  ),
  fails: z.array(z.string()),
  pass: z.boolean(),
});
export type MixBusesResult = z.infer<typeof MixBusesOutput>;

// ---------------------------------------------------------------- judge-reports

export const JudgeReportsInput = z.strictObject({
  /** Report objects, or the raw text of a reviewer's reply with a JSON block inside. */
  reports: z
    .array(z.union([z.record(z.string(), z.unknown()), z.string().max(2_000_000)]))
    .min(1)
    .max(50),
  agents: z.number().int().min(1).max(10).optional(),
  minScore: z.number().min(0).max(10).optional(),
});
export const JudgeReportsOutput = z.object({
  renders: z.array(
    z.object({
      file: z.string(),
      agents: z.array(z.string()),
      pass: z.boolean(),
      problems: z.array(z.string()),
    }),
  ),
  pass: z.boolean(),
});
export type JudgeReportsResult = z.infer<typeof JudgeReportsOutput>;

// ---------------------------------------------------------------- depth-maps (optional image)

export const DepthMapsInput = z.strictObject({
  images: MediaRefs,
  size: z
    .number()
    .int()
    .min(14)
    .max(1036)
    .refine((n) => n % 14 === 0, { message: "size must be a multiple of 14" })
    .optional(),
});
export const DepthMapsOutput = z.object({
  outputs: z.array(
    z.object({ media: z.string(), file: z.string(), width: z.number().int(), height: z.number().int() }),
  ),
});
export type DepthMapsResult = z.infer<typeof DepthMapsOutput>;

// ---------------------------------------------------------------- speech (optional image)

export const SpeechInput = z.strictObject({ media: MediaRef });
export const SpeechOutput = z.object({
  speechMs: z.number().min(0),
  durationMs: z.number().min(0),
  /** Share of the audio the voice activity detector marks as speech, 0 to 1. */
  speechRatio: z.number().min(0).max(1),
  segments: z.number().int().min(0),
});
export type SpeechResult = z.infer<typeof SpeechOutput>;

// ---------------------------------------------------------------- shot-boundaries

/** How a shot joins the previous one (the film production `boundary`); thresholds apply to the first two. */
export const SHOT_BOUNDARY_MODES = ["locked-composition", "camera-transition", "intentional-cut"] as const;

export const ShotBoundariesInput = z.strictObject({
  media: MediaRef,
  joins: z
    .array(
      z.strictObject({
        a: z.string().min(1).max(64),
        b: z.string().min(1).max(64),
        /** Time of the cut in the render, in seconds. */
        atS: z.number().min(0),
        mode: z.enum(SHOT_BOUNDARY_MODES),
        /** The second shot was generated from a still of the first (judged on `chainedRatio`). */
        chained: z.boolean().optional(),
      }),
    )
    .min(1)
    .max(2000),
  n: z.number().int().min(2).max(48).optional(),
  luma: z.number().positive().optional(),
  hist: z.number().positive().optional(),
  ratio: z.number().positive().optional(),
  chainedRatio: z.number().positive().optional(),
});
export const ShotBoundariesOutput = z.object({
  fps: z.number(),
  joins: z.array(
    z.object({
      join: z.string(),
      mode: z.enum(SHOT_BOUNDARY_MODES),
      chained: z.boolean(),
      verdict: z.enum(["ok", "flag", "allowed", "skip"]),
      why: z.array(z.string()),
      luma: z.number().optional(),
      hist: z.number().optional(),
      joinDiff: z.number().optional(),
      innerDiff: z.number().optional(),
      ratio: z.number().optional(),
    }),
  ),
  flagged: z.number().int(),
  pass: z.boolean(),
});
export type ShotBoundariesResult = z.infer<typeof ShotBoundariesOutput>;

// ---------------------------------------------------------------- registry

function tool<I extends z.ZodType, O extends z.ZodType>(
  definition: Omit<QaTool<I, O>, "strictMedia" | "image" | "memoryMb"> &
    Partial<Pick<QaTool<I, O>, "strictMedia" | "image" | "memoryMb">>,
): QaTool<I, O> {
  return { strictMedia: true, image: "default", memoryMb: 4096, ...definition };
}

const one = (input: { media: string }) => [input.media];

export const QA_TOOLS = {
  probe: tool({
    name: "probe",
    description: "Container, video and audio facts (ffprobe): duration, fps, size, stream timing.",
    input: ProbeInput,
    output: ProbeOutput,
    mediaRefs: one,
    timeoutMs: 60_000,
  }),
  loudness: tool({
    name: "loudness",
    description: "Integrated loudness (LUFS), true peak (dBTP) and loudness range of the first audio stream.",
    input: LoudnessInput,
    output: LoudnessOutput,
    mediaRefs: one,
    timeoutMs: 10 * 60_000,
  }),
  blackFrames: tool({
    name: "black-frames",
    description: "Leading, trailing and inner runs of black frames.",
    input: BlackFramesInput,
    output: BlackFramesOutput,
    mediaRefs: one,
    timeoutMs: 10 * 60_000,
  }),
  sync: tool({
    name: "sync",
    description: "Audio start offset and duration difference against the video stream.",
    input: SyncInput,
    output: SyncOutput,
    mediaRefs: one,
    timeoutMs: 60_000,
  }),
  prescan: tool({
    name: "prescan",
    description:
      "Cheap defect detectors (wedges, holds, black, internal cuts, clicks, dropouts, mix events).",
    input: PrescanInput,
    output: PrescanOutput,
    mediaRefs: (input) => (input.mode === "events" ? input.events.map((e) => e.file) : input.media),
    strictMedia: false,
    timeoutMs: 15 * 60_000,
  }),
  mixBuses: tool({
    name: "mix-buses",
    description: "Per-shot bus levels and the ambience masking check on bus stems.",
    input: MixBusesInput,
    output: MixBusesOutput,
    mediaRefs: (input) => Object.values(input.stems).filter((v): v is string => typeof v === "string"),
    timeoutMs: 10 * 60_000,
    memoryMb: 8192,
  }),
  judgeReports: tool({
    name: "judge-reports",
    description: "Consolidate AI reviewer reports into one verdict per render (evidence only).",
    input: JudgeReportsInput,
    output: JudgeReportsOutput,
    mediaRefs: () => [],
    timeoutMs: 60_000,
  }),
  depthMaps: tool({
    name: "depth-maps",
    description: "Relative depth map per image (Depth Anything V2, CPU). Optional torch image only.",
    input: DepthMapsInput,
    output: DepthMapsOutput,
    mediaRefs: (input) => input.images,
    timeoutMs: 15 * 60_000,
    memoryMb: 8192,
    image: "depth",
  }),
  speech: tool({
    name: "speech",
    description: "Share of one audio file that is human speech (Silero VAD, CPU). Optional vad image only.",
    input: SpeechInput,
    output: SpeechOutput,
    mediaRefs: one,
    timeoutMs: 2 * 60_000,
    // Address space, not resident memory: torch maps far more than it uses (same cap as depth-maps).
    memoryMb: 8192,
    image: "vad",
  }),
  shotBoundaries: tool({
    name: "shot-boundaries",
    description:
      "Luma, colour and pose jumps across each shot join of a render, judged by the join's boundary mode.",
    input: ShotBoundariesInput,
    output: ShotBoundariesOutput,
    mediaRefs: one,
    timeoutMs: 10 * 60_000,
  }),
} as const;

/** Validate the input, grant only the media it references, run the tool and validate its answer. */
export async function runQaTool<I extends z.ZodType, O extends z.ZodType>(
  qaTool: QaTool<I, O>,
  input: z.input<I>,
  options: QaRunOptions,
): Promise<{ result: z.infer<O>; outputs: string[] }> {
  const parsed = qaTool.input.safeParse(input);
  if (!parsed.success) {
    throw new StudixError("VALIDATION", `invalid input for QA tool ${qaTool.name}`, {
      retryable: false,
      details: { issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) },
    });
  }
  const granted = options.media ?? {};
  const media: Record<string, string> = {};
  for (const ref of new Set(qaTool.mediaRefs(parsed.data as z.infer<I>))) {
    const path = granted[ref];
    if (path !== undefined) media[ref] = path;
    else if (qaTool.strictMedia)
      throw new StudixError(
        "VALIDATION",
        `QA tool ${qaTool.name} references media "${ref}" without a grant`,
        {
          retryable: false,
        },
      );
  }
  const run = await runPythonTool(qaTool.name, parsed.data, {
    ...options,
    media,
    timeoutMs: options.timeoutMs ?? qaTool.timeoutMs,
    memoryMb: options.memoryMb ?? qaTool.memoryMb,
  });
  const result = qaTool.output.safeParse(run.result);
  if (!result.success) {
    throw new StudixError("INTERNAL", `QA tool ${qaTool.name} answered outside its output contract`, {
      details: { issues: result.error.issues.slice(0, 10).map((i) => `${i.path.join(".")}: ${i.message}`) },
    });
  }
  return { result: result.data, outputs: run.outputs };
}
