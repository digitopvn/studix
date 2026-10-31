import type { HardCheckContract } from "@studix/skills";
import type { QaExpectation, QaGate } from "@studix/workflow";
import { bindHardChecks, type UnboundCheck } from "./knowledge-checks.ts";
import { defaultHardChecks, type QaMetricCheck } from "./qa-checks.ts";
import { assertHardGate, type QaGateRunOptions, runHardGate } from "./qa-gates.ts";

export interface HardQaGateOptions {
  /** Toolchain, timeouts and sandbox root; the stage's abort signal is added per run. */
  run: Omit<QaGateRunOptions, "signal">;
  /** Hard checks of the registered knowledge packs (`knowledgeCatalog.hardChecks`). */
  hardChecks?: () => readonly HardCheckContract[];
}

export interface HardQaGateReport extends Record<string, unknown> {
  pass: true;
  checks: Awaited<ReturnType<typeof runHardGate>>["checks"];
  measurements: Awaited<ReturnType<typeof runHardGate>>["measurements"];
  /** Pack checks no QA tool measures yet; recorded, never silently dropped. */
  unbound?: UnboundCheck[];
}

/** Metric families measured on the sound; a render without audio has nothing for them to measure. */
const AUDIO_METRICS = ["loudness.", "sync."];

/**
 * The checks one render is gated on: the default hard gate for its length, frame rate and sound, plus the
 * hard checks of the knowledge packs the stage declared. Audio checks of a pack are left out of a silent render.
 */
export function hardChecksFor(
  expectation: QaExpectation,
  packChecks: readonly HardCheckContract[] = [],
): { checks: QaMetricCheck[]; unbound: UnboundCheck[] } {
  const defaults = defaultHardChecks({
    durationS: expectation.durationMs / 1000,
    fps: expectation.fps,
    requireAudio: expectation.requireAudio,
  });
  const wanted = new Set(expectation.knowledge ?? []);
  const bound = bindHardChecks(packChecks.filter((c) => wanted.has(c.pack)));
  const fromPacks = expectation.requireAudio
    ? bound.checks
    : bound.checks.filter((c) => !AUDIO_METRICS.some((m) => c.metric.startsWith(m)));
  return { checks: [...defaults, ...fromPacks], unbound: bound.unbound };
}

/**
 * The QA gate pack stages call on a finished render. It measures the file with the QA tools and throws the
 * non-retryable VALIDATION error of `assertHardGate` when any hard check fails, so nothing downstream ships.
 */
export function createHardQaGate(options: HardQaGateOptions): QaGate {
  return {
    async assertPasses(filePath, expectation, signal) {
      const { checks, unbound } = hardChecksFor(expectation, options.hardChecks?.() ?? []);
      const report = await runHardGate(filePath, checks, { ...options.run, signal });
      assertHardGate(report);
      const result: HardQaGateReport = {
        pass: true,
        checks: report.checks,
        measurements: report.measurements,
        ...(unbound.length > 0 ? { unbound } : {}),
      };
      return result;
    },
  };
}
