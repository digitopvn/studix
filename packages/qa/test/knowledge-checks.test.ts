import { type HardCheck, knowledgeCatalog } from "@studix/skills";
import { describe, expect, it } from "vitest";
import { bindHardChecks, evaluateChecks, parseChecks } from "../src/index.ts";

const check = (overrides: Partial<HardCheck>): HardCheck => ({
  id: "test-pack.check",
  kind: "hard",
  level: "asset",
  measure: "A measurement.",
  metric: { id: "true-peak-dbtp", unit: "dbtp" },
  threshold: { op: "<=", value: -1.5 },
  ...overrides,
});

describe("knowledge-pack hard checks", () => {
  it("binds the built-in delivery checks the QA tools measure, and lists the rest as unbound", () => {
    const { checks, unbound } = bindHardChecks(knowledgeCatalog.hardChecks());
    const ids = checks.map((c) => c.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "production-failure-modes.delivery-loudness",
        "production-failure-modes.delivery-true-peak",
        "production-failure-modes.leading-black",
        "production-failure-modes.chat-delivery-size",
      ]),
    );
    expect(checks.every((c) => c.layer === "hard" || c.layer === "evidence")).toBe(true);
    expect(unbound.length).toBeGreaterThan(0);
    expect(unbound.every((u) => u.reason === "no_tool")).toBe(true);
    // Bound checks are valid QA checks.
    expect(parseChecks(checks)).toHaveLength(checks.length);
  });

  it("decides with the pack threshold, strict operators included", () => {
    const { checks } = bindHardChecks([
      check({
        id: "p.loudness",
        metric: { id: "integrated-loudness-lufs", unit: "lufs" },
        threshold: { op: "between", min: -15, max: -13 },
      }),
      check({ id: "p.peak" }),
      check({
        id: "p.size",
        metric: { id: "delivery-file-mib", unit: "mib" },
        threshold: { op: "<", value: 30 },
      }),
    ]);
    const pass = (m: Record<string, number>) => evaluateChecks(checks, m).map((r) => [r.id, r.pass]);
    expect(
      pass({ "loudness.integratedLufs": -14, "loudness.truePeakDbtp": -1.5, "probe.sizeMib": 29.9 }),
    ).toEqual([
      ["p.loudness", true],
      ["p.peak", true],
      ["p.size", true],
    ]);
    expect(
      pass({ "loudness.integratedLufs": -16.2, "loudness.truePeakDbtp": -0.9, "probe.sizeMib": 30 }),
    ).toEqual([
      ["p.loudness", false],
      ["p.peak", false],
      ["p.size", false],
    ]);
    expect(evaluateChecks(checks, {})[0]).toMatchObject({ pass: false, value: null });
  });

  it("keeps a threshold the owner has not approved out of the blocking layer", () => {
    const { checks } = bindHardChecks([check({ pendingReview: "matrix row awaiting the owner" })]);
    expect(checks[0]!.layer).toBe("evidence");
  });

  it("refuses to bind a unit or a measurement input the tool does not use", () => {
    const { checks, unbound } = bindHardChecks([
      check({ id: "p.unit", metric: { id: "true-peak-dbtp", unit: "db" } }),
      check({
        id: "p.floor",
        metric: { id: "leading-black-s", unit: "seconds" },
        threshold: { op: "<=", value: 0.5 },
        params: { lumaFloor: 24 },
      }),
      check({ id: "p.proto", metric: { id: "constructor", unit: "count" } }),
    ]);
    expect(checks).toEqual([]);
    expect(unbound.map((u) => [u.id, u.reason])).toEqual([
      ["p.unit", "unit_mismatch"],
      ["p.floor", "unsupported_params"],
      ["p.proto", "no_tool"],
    ]);
  });

  it("binds the leading-black check at the luma floor the tool measures with", () => {
    const { checks } = bindHardChecks([
      check({
        metric: { id: "leading-black-s", unit: "seconds" },
        threshold: { op: "<=", value: 0.5 },
        params: { lumaFloor: 16 },
      }),
    ]);
    expect(checks[0]).toMatchObject({ metric: "black.leadingS", layer: "hard" });
  });
});
