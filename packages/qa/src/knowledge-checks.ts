import type { HardCheck, MetricUnit } from "@studix/skills";
import type { QaLayer, QaMetric, QaMetricCheck } from "./qa-checks.ts";

/**
 * Knowledge-pack metric ids the QA tools measure. A pack hard check names `metric.id`; this table is where a QA
 * tool registers under it. `params` lists the measurement inputs the tool honours and the value it measures with:
 * a check asking for another value is not bound, rather than measured differently and passed.
 */
export interface MetricBinding {
  metric: QaMetric;
  unit: MetricUnit;
  params?: Readonly<Record<string, number | string>>;
}

export const QA_METRIC_BINDINGS: Readonly<Record<string, MetricBinding>> = {
  "integrated-loudness-lufs": { metric: "loudness.integratedLufs", unit: "lufs" },
  "true-peak-dbtp": { metric: "loudness.truePeakDbtp", unit: "dbtp" },
  "leading-black-s": { metric: "black.leadingS", unit: "seconds", params: { lumaFloor: 16 } },
  "delivery-file-mib": { metric: "probe.sizeMib", unit: "mib" },
};

export type UnboundReason = "no_tool" | "unit_mismatch" | "unsupported_params";

export interface UnboundCheck {
  id: string;
  metric: string;
  reason: UnboundReason;
  message: string;
}

export interface BoundChecks {
  /** Ready for runHardGate / collectEvidence. */
  checks: QaMetricCheck[];
  /** Checks no QA tool measures yet; the caller decides whether that is acceptable, nothing drops them silently. */
  unbound: UnboundCheck[];
}

function unsupportedParams(
  params: HardCheck["params"],
  supported: Readonly<Record<string, number | string>> | undefined,
): string[] {
  return Object.entries(params ?? {})
    .filter(([key, value]) => supported?.[key] !== value)
    .map(([key, value]) => `${key}=${value}`);
}

/**
 * Bind knowledge-pack hard checks onto QA metric checks. The pack's threshold is kept as is and decided with
 * `meetsThreshold`. A check whose threshold is still `pendingReview` (the owner has not approved it) is bound to
 * the evidence layer: it is measured and recorded but cannot block a stage until the owner approves it.
 */
export function bindHardChecks(checks: readonly HardCheck[]): BoundChecks {
  const bound: QaMetricCheck[] = [];
  const unbound: UnboundCheck[] = [];
  for (const check of checks) {
    // Own keys only: a metric id like `constructor` must not resolve to an Object prototype member.
    const binding = Object.hasOwn(QA_METRIC_BINDINGS, check.metric.id)
      ? QA_METRIC_BINDINGS[check.metric.id]
      : undefined;
    const base = { id: check.id, metric: check.metric.id };
    if (!binding) {
      unbound.push({ ...base, reason: "no_tool", message: `no QA tool measures ${check.metric.id}` });
      continue;
    }
    if (binding.unit !== check.metric.unit) {
      unbound.push({
        ...base,
        reason: "unit_mismatch",
        message: `${check.metric.id} is measured in ${binding.unit}, the check declares ${check.metric.unit}`,
      });
      continue;
    }
    const bad = unsupportedParams(check.params, binding.params);
    if (bad.length > 0) {
      unbound.push({
        ...base,
        reason: "unsupported_params",
        message: `${check.metric.id} cannot be measured with ${bad.join(", ")}`,
      });
      continue;
    }
    const layer: Exclude<QaLayer, "human"> = check.pendingReview ? "evidence" : "hard";
    bound.push({
      id: check.id,
      layer,
      metric: binding.metric,
      threshold: check.threshold,
      description: check.measure.slice(0, 300),
    });
  }
  return { checks: bound, unbound };
}
