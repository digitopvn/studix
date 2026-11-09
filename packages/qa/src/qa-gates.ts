import { isStudixError, StudixError, type StudixErrorPayload } from "@studix/shared";
import type { z } from "zod";
import {
  evaluateChecks,
  type QaCheckResult,
  type QaMeasurements,
  type QaMetric,
  type QaMetricCheck,
} from "./qa-checks.ts";
import {
  type BlackFramesResult,
  type JudgeReportsInput,
  type LoudnessResult,
  type MixBusesInput,
  type ProbeResult,
  QA_TOOLS,
  type QaRunOptions,
  runQaTool,
  type SyncResult,
} from "./qa-tools.ts";

/** Run options shared by every tool of a gate; the media grants are set by the gate itself. */
export type QaGateRunOptions = Omit<QaRunOptions, "media" | "outputDir">;

export interface HardGateReport {
  pass: boolean;
  checks: QaCheckResult[];
  failures: QaCheckResult[];
  measurements: {
    probe: ProbeResult;
    loudness?: LoudnessResult;
    black?: BlackFramesResult;
    sync?: SyncResult;
  };
}

const uses = (checks: readonly QaMetricCheck[], tool: string) =>
  checks.some((c) => c.metric.startsWith(`${tool}.`));
const bool = (v: boolean) => (v ? 1 : 0);

/**
 * Measure one file with the tools its checks need (probe always; loudness, black-frames and sync on demand) and
 * evaluate the hard checks. A tool is skipped when the stream it measures is absent, so its checks fail as "not
 * measured" instead of erroring. Tool failures (a timeout, a missing binary) propagate: an unmeasured file
 * never passes a hard gate.
 */
export async function runHardGate(
  file: string,
  checks: readonly QaMetricCheck[],
  run: QaGateRunOptions,
): Promise<HardGateReport> {
  const hard = checks.filter((c) => c.layer === "hard");
  const media = { media: file };
  const options = { ...run, media };
  const { result: probe } = await runQaTool(QA_TOOLS.probe, { media: "media" }, options);
  const measurements: HardGateReport["measurements"] = { probe };
  const m: QaMeasurements = {
    "probe.hasVideo": bool(probe.video !== null),
    "probe.hasAudio": bool(probe.audio !== null),
    "probe.durationS": probe.durationS,
    "probe.fps": probe.video?.fps ?? null,
    "probe.width": probe.video?.width ?? null,
    "probe.height": probe.video?.height ?? null,
    "probe.sizeMib": probe.sizeBytes === null ? null : probe.sizeBytes / (1024 * 1024),
  };
  if (probe.audio && uses(hard, "loudness")) {
    const { result } = await runQaTool(QA_TOOLS.loudness, { media: "media" }, options);
    measurements.loudness = result;
    m["loudness.integratedLufs"] = result.silent ? null : result.integratedLufs;
    m["loudness.truePeakDbtp"] = result.truePeakDbtp;
    m["loudness.lraLu"] = result.lraLu;
  }
  if (probe.video && uses(hard, "black")) {
    const { result } = await runQaTool(QA_TOOLS.blackFrames, { media: "media" }, options);
    measurements.black = result;
    m["black.leadingS"] = result.leadingS;
    m["black.trailingS"] = result.trailingS;
    m["black.maxInnerRunS"] = result.maxInnerRunS;
    m["black.allBlack"] = bool(result.allBlack);
  }
  if (probe.video && probe.audio && uses(hard, "sync")) {
    const { result } = await runQaTool(QA_TOOLS.sync, { media: "media" }, options);
    measurements.sync = result;
    m["sync.audioDelayMs"] = result.audioDelayMs;
    m["sync.durationDeltaMs"] = result.durationDeltaMs;
  }
  const results = evaluateChecks(hard, m);
  const failures = results.filter((r) => !r.pass);
  return { pass: failures.length === 0, checks: results, failures, measurements };
}

/** Throw the error that blocks the stage when the hard gate failed; non-retryable, since a rerun measures the same file. */
export function assertHardGate(report: HardGateReport): void {
  if (report.pass) return;
  throw new StudixError(
    "VALIDATION",
    `QA hard gate failed: ${report.failures.map((f) => f.message).join("; ")}`,
    {
      retryable: false,
      details: { failures: report.failures },
      suggestedAction: "Fix the render (re-mix, re-finish or re-cut) and run the stage again.",
    },
  );
}

export interface EvidenceRequest {
  /** Run prescan on the file: picture (wedges, holds, black) and/or audio (clicks, dropouts). */
  prescan?: { picture?: boolean; audio?: boolean; maxHoldS?: number; maxLeadBlackS?: number };
  /** Bus stems (paths) and the shot list for the mix-bus check. */
  mixBuses?: Omit<z.input<typeof MixBusesInput>, "stems"> & {
    stems: Partial<Record<"beds" | "hits" | "vo" | "music", string>>;
  };
  /**
   * Sample frames across the render: black or blank frames, content inside the safe margin and scenes that do
   * not change. With `outputDir`, a contact sheet PNG of the samples is written there (path in `data`).
   */
  frames?: { samples?: number; safeMarginPct?: number; outputDir?: string };
  /** Text the render shows and the TTF or OTF it is set in: characters the font cannot draw (Vietnamese letters named). */
  glyphs?: { font: string; texts: string[] };
  /** AI reviewer reports to consolidate. Their verdict is evidence, never a gate. */
  judgeReports?: z.input<typeof JudgeReportsInput>;
  /** Evidence-layer checks over the evidence metrics; recorded, never blocking. */
  checks?: readonly QaMetricCheck[];
}

export interface EvidenceItem {
  source: "prescan.picture" | "prescan.audio" | "mix-buses" | "judge-reports" | "frame-qa" | "glyph-coverage";
  /** Whether the tool produced a result; a failed tool is recorded, not raised. */
  ok: boolean;
  findings: string[];
  data?: unknown;
  error?: StudixErrorPayload;
}

export interface EvidenceReport {
  /** Evidence never blocks a stage; the literal documents that for every reader of a stored report. */
  blocking: false;
  items: EvidenceItem[];
  checks: QaCheckResult[];
}

async function collect(
  source: EvidenceItem["source"],
  work: () => Promise<{ findings: string[]; data: unknown }>,
): Promise<EvidenceItem> {
  try {
    return { source, ok: true, ...(await work()) };
  } catch (err) {
    // Cancellation is not a finding: the job is stopping and the stage must stop with it.
    if (isStudixError(err) && err.code === "CANCELLED") throw err;
    const payload = isStudixError(err)
      ? err.toJSON()
      : { code: "INTERNAL" as const, message: String(err), retryable: false };
    return { source, ok: false, findings: [], error: payload };
  }
}

/**
 * Gather evidence for a reviewer: prescan detectors, the mix-bus check and consolidated AI judge reports. Every
 * result, failure or tool error is recorded; nothing here blocks a stage (except cancellation).
 */
export async function collectEvidence(
  file: string,
  request: EvidenceRequest,
  run: QaGateRunOptions,
): Promise<EvidenceReport> {
  const items: EvidenceItem[] = [];
  const m: QaMeasurements = {};
  const options = { ...run, media: { media: file } };
  for (const mode of ["picture", "audio"] as const) {
    if (!request.prescan?.[mode]) continue;
    const metric: QaMetric = mode === "picture" ? "prescan.pictureFlags" : "prescan.audioFlags";
    const item = await collect(`prescan.${mode}`, async () => {
      const input =
        mode === "picture"
          ? {
              mode,
              media: ["media"],
              maxHoldS: request.prescan?.maxHoldS,
              maxLeadBlackS: request.prescan?.maxLeadBlackS,
            }
          : { mode, media: ["media"] };
      const { result } = await runQaTool(QA_TOOLS.prescan, input, options);
      return { findings: result.flags, data: result.files };
    });
    if (item.ok) m[metric] = item.findings.length;
    items.push(item);
  }
  if (request.mixBuses) {
    const { stems, ...rest } = request.mixBuses;
    const grants: Record<string, string> = {};
    const refs: Partial<Record<keyof typeof stems, string>> = {};
    for (const [bus, path] of Object.entries(stems) as [keyof typeof stems, string | undefined][]) {
      if (!path) continue;
      grants[bus] = path;
      refs[bus] = bus;
    }
    const item = await collect("mix-buses", async () => {
      const { result } = await runQaTool(
        QA_TOOLS.mixBuses,
        { ...rest, stems: refs },
        { ...run, media: grants },
      );
      return { findings: result.fails, data: result.shots };
    });
    if (item.ok) m["mixBuses.fails"] = item.findings.length;
    items.push(item);
  }
  if (request.frames) {
    const { outputDir, ...input } = request.frames;
    const item = await collect("frame-qa", async () => {
      const { result, outputs } = await runQaTool(
        QA_TOOLS.frameQa,
        { media: "media", ...input, contactSheet: outputDir !== undefined },
        { ...options, ...(outputDir !== undefined && { outputDir }) },
      );
      m["frames.blankSamples"] = result.blankSamples + result.blackSamples;
      m["frames.marginSamples"] = result.marginSamples;
      m["frames.staticPairs"] = result.staticPairs;
      const contactSheet = outputs.find((f) => f.endsWith(result.contactSheet?.file ?? "\0")) ?? null;
      return { findings: result.flags, data: { ...result, contactSheetPath: contactSheet } };
    });
    items.push(item);
  }
  if (request.glyphs) {
    const { font, texts } = request.glyphs;
    const item = await collect("glyph-coverage", async () => {
      const { result } = await runQaTool(
        QA_TOOLS.glyphCoverage,
        { font: "font", texts },
        { ...run, media: { font } },
      );
      m["glyphs.missing"] = result.missingCount;
      return {
        findings: result.missing.map((c) => `no glyph for ${c.codepoint} "${c.char}" (${c.count}x)`),
        data: result,
      };
    });
    items.push(item);
  }
  if (request.judgeReports) {
    const reports = request.judgeReports;
    const item = await collect("judge-reports", async () => {
      const { result } = await runQaTool(QA_TOOLS.judgeReports, reports, run);
      const failed = result.renders.filter((r) => !r.pass);
      return {
        findings: failed.flatMap((r) => r.problems.map((p) => `${r.file}: ${p}`)),
        data: result.renders,
      };
    });
    if (item.ok && Array.isArray(item.data)) {
      m["judge.failedRenders"] = (item.data as { pass: boolean }[]).filter((r) => !r.pass).length;
    }
    items.push(item);
  }
  const checks = evaluateChecks(
    (request.checks ?? []).filter((c) => c.layer === "evidence"),
    m,
  );
  return { blocking: false, items, checks };
}
