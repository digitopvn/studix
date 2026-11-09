import { meetsThreshold, Threshold } from "@studix/skills";
import { z } from "zod";

/**
 * The three QA layers.
 * - hard: a measured metric outside its range blocks the stage.
 * - evidence: measured or judged (including AI reviewers) and recorded; never blocks.
 * - human: a person approves through the approval policy (human-review.ts).
 */
export const QA_LAYERS = ["hard", "evidence", "human"] as const;
export type QaLayer = (typeof QA_LAYERS)[number];

/**
 * Metrics a check can name, `<tool>.<field>`. Booleans read as 1 (true) or 0 (false); counts are counts of
 * findings. Every metric comes from one of the QA tools in qa-tools.ts.
 */
export const QA_METRICS = [
  "probe.hasVideo",
  "probe.hasAudio",
  "probe.durationS",
  "probe.fps",
  "probe.width",
  "probe.height",
  "probe.sizeMib",
  "loudness.integratedLufs",
  "loudness.truePeakDbtp",
  "loudness.lraLu",
  "black.leadingS",
  "black.trailingS",
  "black.maxInnerRunS",
  "black.allBlack",
  "sync.audioDelayMs",
  "sync.durationDeltaMs",
  "prescan.pictureFlags",
  "prescan.audioFlags",
  "mixBuses.fails",
  "judge.failedRenders",
  "frames.blankSamples",
  "frames.marginSamples",
  "frames.staticPairs",
  "glyphs.missing",
] as const;
export type QaMetric = (typeof QA_METRICS)[number];

/**
 * A metric check: the metric must lie in [min, max] (either bound may be open), or meet a knowledge-pack
 * `threshold` (knowledge-checks.ts binds pack hard checks onto this shape). Ids are kebab-case; a check bound from
 * a pack keeps its `<pack-id>.<name>` id.
 */
export const QaMetricCheck = z
  .strictObject({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}(\.[a-z0-9][a-z0-9-]{0,63})?$/),
    layer: z.enum(["hard", "evidence"]),
    metric: z.enum(QA_METRICS),
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
    threshold: Threshold.optional(),
    description: z.string().max(300).optional(),
  })
  .refine((c) => (c.threshold === undefined) !== (c.min === undefined && c.max === undefined), {
    message: "a check needs min/max or a threshold, not both",
  })
  .refine((c) => c.min === undefined || c.max === undefined || c.min <= c.max, {
    message: "min must be <= max",
  });
export type QaMetricCheck = z.infer<typeof QaMetricCheck>;

export interface QaCheckResult {
  id: string;
  layer: "hard" | "evidence";
  metric: QaMetric;
  /** null when the metric could not be measured (no audio stream, a tool that failed). */
  value: number | null;
  min?: number;
  max?: number;
  threshold?: Threshold;
  pass: boolean;
  message: string;
}

export type QaMeasurements = Partial<Record<QaMetric, number | null>>;

/** Delivery loudness, the same limits the renderer finishes to (packages/renderers/src/ffmpeg/loudness.ts). */
export const LOUDNESS_LIMITS = { integratedLufs: -14, toleranceLu: 1, truePeakDbtp: -1.5 } as const;

/**
 * Audio/video alignment tolerance (EBU R37): sound may lead the picture by at most 40 ms and lag it by at most
 * 60 ms. Audio and video may end apart by at most 100 ms (an AAC frame plus a frame of picture).
 */
export const SYNC_LIMITS = { maxAudioLeadMs: 40, maxAudioLagMs: 60, maxDurationDeltaMs: 100 } as const;

/** A fade from black longer than this is a stacked fade (the source's qa-prescan default). */
export const BLACK_LIMITS = { maxLeadingS: 0.5, maxInnerRunS: 1 } as const;

export interface DefaultHardCheckOptions {
  /** Expected duration in seconds; omitted means no duration check. */
  durationS?: number;
  /** Allowed duration difference; defaults to max(0.1 s, one frame). */
  durationToleranceS?: number;
  /** Expected frame rate; omitted means no fps check. */
  fps?: number;
  /** A video that must carry sound (default true): adds the stream, loudness, true-peak and sync checks. */
  requireAudio?: boolean;
}

/** The default hard gate: picture present, loudness -14 LUFS +/-1, true peak <= -1.5 dBTP, black, sync, duration, fps. */
export function defaultHardChecks(options: DefaultHardCheckOptions = {}): QaMetricCheck[] {
  const requireAudio = options.requireAudio ?? true;
  const L = LOUDNESS_LIMITS;
  const checks: QaMetricCheck[] = [
    { id: "has-video", layer: "hard", metric: "probe.hasVideo", min: 1 },
    { id: "not-all-black", layer: "hard", metric: "black.allBlack", max: 0 },
    { id: "leading-black", layer: "hard", metric: "black.leadingS", max: BLACK_LIMITS.maxLeadingS },
    { id: "inner-black", layer: "hard", metric: "black.maxInnerRunS", max: BLACK_LIMITS.maxInnerRunS },
  ];
  if (requireAudio) {
    checks.push(
      { id: "has-audio", layer: "hard", metric: "probe.hasAudio", min: 1 },
      {
        id: "loudness",
        layer: "hard",
        metric: "loudness.integratedLufs",
        min: L.integratedLufs - L.toleranceLu,
        max: L.integratedLufs + L.toleranceLu,
      },
      { id: "true-peak", layer: "hard", metric: "loudness.truePeakDbtp", max: L.truePeakDbtp },
      {
        id: "av-sync",
        layer: "hard",
        metric: "sync.audioDelayMs",
        min: -SYNC_LIMITS.maxAudioLeadMs,
        max: SYNC_LIMITS.maxAudioLagMs,
      },
      {
        id: "av-duration",
        layer: "hard",
        metric: "sync.durationDeltaMs",
        min: -SYNC_LIMITS.maxDurationDeltaMs,
        max: SYNC_LIMITS.maxDurationDeltaMs,
      },
    );
  }
  if (options.durationS !== undefined) {
    if (!(options.durationS > 0)) throw new RangeError("durationS must be > 0");
    const frame = options.fps ? 1 / options.fps : 0;
    const tol = options.durationToleranceS ?? Math.max(0.1, frame);
    checks.push({
      id: "duration",
      layer: "hard",
      metric: "probe.durationS",
      min: options.durationS - tol,
      max: options.durationS + tol,
    });
  }
  if (options.fps !== undefined) {
    if (!(options.fps > 0)) throw new RangeError("fps must be > 0");
    checks.push({
      id: "fps",
      layer: "hard",
      metric: "probe.fps",
      min: options.fps - 0.01,
      max: options.fps + 0.01,
    });
  }
  return checks;
}

/** Parse checks declared outside this package (a pack); throws a ZodError naming the bad check. */
export function parseChecks(raw: unknown): QaMetricCheck[] {
  return z.array(QaMetricCheck).parse(raw);
}

const fmt = (n: number) => String(Math.round(n * 100) / 100);
const describeThreshold = (t: Threshold) =>
  t.op === "between" ? `${fmt(t.min)}..${fmt(t.max)}` : `${t.op} ${fmt(t.value)}`;

/** Evaluate checks against measurements. A metric that was not measured fails its check (fail closed). */
export function evaluateChecks(checks: readonly QaMetricCheck[], measured: QaMeasurements): QaCheckResult[] {
  return checks.map((c) => {
    const value = measured[c.metric];
    const bounds = {
      ...(c.min !== undefined && { min: c.min }),
      ...(c.max !== undefined && { max: c.max }),
      ...(c.threshold && { threshold: c.threshold }),
    };
    const base = { id: c.id, layer: c.layer, metric: c.metric, ...bounds };
    if (value === undefined || value === null || !Number.isFinite(value)) {
      return { ...base, value: null, pass: false, message: `${c.metric} was not measured` };
    }
    if (c.threshold) {
      const pass = meetsThreshold(c.threshold, value);
      const rule = describeThreshold(c.threshold);
      return {
        ...base,
        value,
        pass,
        message: `${c.metric} ${fmt(value)} ${pass ? "meets" : "fails"} ${rule}`,
      };
    }
    const low = c.min !== undefined && value < c.min;
    const high = c.max !== undefined && value > c.max;
    const range = `${c.min !== undefined ? fmt(c.min) : "-inf"}..${c.max !== undefined ? fmt(c.max) : "+inf"}`;
    return {
      ...base,
      value,
      pass: !low && !high,
      message:
        low || high
          ? `${c.metric} ${fmt(value)} outside ${range}`
          : `${c.metric} ${fmt(value)} within ${range}`,
    };
  });
}
