import { z } from "zod";

/**
 * Knowledge packs: creative and technical craft knowledge a stage loads on demand (camera grammar, motion
 * timing, sound design, GL techniques). A pack is data only. It says where it came from, which production
 * phases it serves, what it teaches and which checks prove the work follows it.
 */

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SEMVER = /^\d+\.\d+\.\d+$/;
/** `<40-hex sha>:<path relative to the source repository root>`. */
const SOURCE_REF = /^([0-9a-f]{40}):([^\s:][^\s]*)$/;

const kebab = (what: string) => z.string().regex(KEBAB, `${what} must be lowercase kebab-case`);
const text = z.string().trim().min(1);

/** Production phases a pack serves; a stage of any pack maps onto one of them. */
export const KnowledgePhase = z.enum([
  "brief",
  "script",
  "storyboard",
  "design",
  "keyframe",
  "motion",
  "composition",
  "sound",
  "edit",
  "grade",
  "qa",
]);
export type KnowledgePhase = z.infer<typeof KnowledgePhase>;

/** Where a pack's content was ported from, at a pinned commit (see docs/PORTING.md). */
export const KnowledgeSource = z
  .object({
    repo: z.enum(["zuey-workspace", "agentkit"]),
    /** `<sha>:<path>`, the path relative to the source repository root. */
    ref: z.string().regex(SOURCE_REF, "ref must be `<40-hex sha>:<relative path>`"),
    /** Row of docs/porting/migration-matrix.md this source belongs to, e.g. `AC-37`. */
    matrix: z.string().regex(/^[A-Z]{2}-\d{2}$/, "matrix must be a migration matrix row id like AC-37"),
    /** Upstream licence notice for a third-party portion (kept as the source licence requires). */
    notice: text.optional(),
  })
  .strict();
export type KnowledgeSource = z.infer<typeof KnowledgeSource>;

/** Splits a source ref into its commit and path. */
export function parseSourceRef(ref: string): { sha: string; path: string } | undefined {
  const m = SOURCE_REF.exec(ref);
  return m ? { sha: m[1]!, path: m[2]! } : undefined;
}

/** What a check is about: one asset, a shot, a scene, the whole video, or the job that produces it. */
export const CheckLevel = z.enum(["asset", "shot", "scene", "video", "job"]);
export type CheckLevel = z.infer<typeof CheckLevel>;

export const MetricUnit = z.enum([
  "count",
  "ratio",
  "seconds",
  "ms",
  "frames",
  "db",
  "lufs",
  "dbtp",
  "mib",
  "score",
]);
export type MetricUnit = z.infer<typeof MetricUnit>;

export const Threshold = z.discriminatedUnion("op", [
  z.object({ op: z.enum(["<=", ">=", "==", "<", ">"]), value: z.number().finite() }).strict(),
  z
    .object({ op: z.literal("between"), min: z.number().finite(), max: z.number().finite() })
    .strict()
    .refine((t) => t.min <= t.max, "between needs min <= max"),
]);
export type Threshold = z.infer<typeof Threshold>;

const checkBase = {
  /** `<pack-id>.<name>`, unique across every pack. */
  id: z.string().regex(/^[a-z0-9-]+\.[a-z0-9-]+$/, "check id must be `<pack-id>.<kebab-name>`"),
  level: CheckLevel,
  /** What is looked at or measured. */
  measure: text,
};

/**
 * Decided by a machine: a tool computes `metric` and the check passes when the value meets `threshold`.
 * The tool itself is attached by metric id (the QA tool runner owns that); this is the contract.
 */
export const HardCheck = z
  .object({
    ...checkBase,
    kind: z.literal("hard"),
    metric: z
      .object({
        /** Stable id a measuring tool registers under, e.g. `still-hold-max-s`. */
        id: kebab("metric id"),
        unit: MetricUnit,
      })
      .strict(),
    threshold: Threshold,
    /** Fixed inputs of the measurement (window sizes, margins), not part of the pass rule. */
    params: z.record(z.string(), z.union([z.number(), z.string()])).optional(),
    /** Set when the owner has not approved the threshold yet; the reason names the matrix row. */
    pendingReview: text.optional(),
  })
  .strict();
export type HardCheck = z.infer<typeof HardCheck>;

/** Decided by a judge looking at evidence: an AI judge, a human reviewer, or the user. */
export const EvidenceCheck = z
  .object({
    ...checkBase,
    kind: z.literal("evidence"),
    /** Who may decide. `ai` alone is never enough to approve; it produces evidence for a human. */
    judges: z.array(z.enum(["ai", "human"])).min(1),
    /** What the judge must be shown. */
    evidence: z
      .array(
        z.enum([
          "frame",
          "frame-strip",
          "contact-sheet",
          "clip",
          "audio",
          "measurement",
          "prompt",
          "document",
        ]),
      )
      .min(1),
    /** The pass rule the judge applies. */
    pass: text,
  })
  .strict();
export type EvidenceCheck = z.infer<typeof EvidenceCheck>;

export const KnowledgeCheck = z.discriminatedUnion("kind", [HardCheck, EvidenceCheck]);
export type KnowledgeCheck = z.infer<typeof KnowledgeCheck>;

/** One unit of knowledge: a rule, a technique, a registry row (a look, an easing, an API). */
export const KnowledgeEntry = z
  .object({
    id: kebab("entry id"),
    title: text,
    text,
    /** Structured attributes of a registry row (palette, duration, risk...). */
    fields: z.record(z.string(), text).optional(),
    tags: z.array(text).optional(),
  })
  .strict();
export type KnowledgeEntry = z.infer<typeof KnowledgeEntry>;

export const KnowledgeSection = z
  .object({
    id: kebab("section id"),
    title: text,
    entries: z.array(KnowledgeEntry).min(1),
  })
  .strict();
export type KnowledgeSection = z.infer<typeof KnowledgeSection>;

export const KnowledgePack = z
  .object({
    id: kebab("pack id"),
    /** Semantic version of the pack content. */
    version: z.string().regex(SEMVER, "version must be semver x.y.z"),
    title: text,
    /** One line shown in listings. */
    summary: text,
    purpose: text,
    sources: z.array(KnowledgeSource).min(1),
    /** Phases the pack serves; a stage outside them should not need it. */
    phases: z.array(KnowledgePhase).min(1),
    /** Task words that make the pack relevant, for search. */
    loadWhen: z.array(text).min(1),
    useCases: z.array(text).min(1),
    antiPatterns: z.array(text).min(1),
    sections: z.array(KnowledgeSection),
    checks: z.array(KnowledgeCheck),
  })
  .strict();
export type KnowledgePack = z.infer<typeof KnowledgePack>;

/** Whether a measured value passes a hard check's threshold. */
export function meetsThreshold(threshold: Threshold, value: number): boolean {
  if (!Number.isFinite(value)) return false;
  switch (threshold.op) {
    case "<=":
      return value <= threshold.value;
    case ">=":
      return value >= threshold.value;
    case "==":
      return value === threshold.value;
    case "<":
      return value < threshold.value;
    case ">":
      return value > threshold.value;
    case "between":
      return value >= threshold.min && value <= threshold.max;
  }
}
