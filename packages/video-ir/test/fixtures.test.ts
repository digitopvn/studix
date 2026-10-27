import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  migrateVideoIR,
  resolveSceneSpans,
  type ValidationIssueCode,
  validateVideoIR,
} from "../src/index.ts";
import { FIXTURES_DIR, loadFixture } from "./load-fixture.ts";

const VALID = ["brand-intro-9x16.json", "product-promo-16x9-assets.json"];

const INVALID: Record<string, { code: ValidationIssueCode; path: string }> = {
  "invalid-timeline-gap.json": { code: "timeline", path: "/timeline/entries/2/startMs" },
  "invalid-unknown-asset.json": { code: "unknown_reference", path: "/scenes/1/shots/0/assetId" },
  "invalid-aspect-ratio.json": { code: "schema", path: "/format/width" },
  "invalid-shot-overflow.json": { code: "out_of_bounds", path: "/scenes/0/shots/0/durationMs" },
  "invalid-future-version.json": { code: "schema", path: "/schemaVersion" },
};

describe("golden fixtures", () => {
  it("every fixture file is covered by a test case", () => {
    const files = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".json"));
    expect(files.sort()).toEqual([...VALID, ...Object.keys(INVALID)].sort());
  });

  it.each(VALID)("%s is valid and round-trips unchanged", (name) => {
    const doc = loadFixture(name);
    const result = validateVideoIR(doc);
    if (!result.ok) throw new Error(JSON.stringify(result.issues, null, 2));
    expect(result.value).toEqual(doc);
    expect(migrateVideoIR(doc).migrated).toBe(false);
  });

  it.each(Object.entries(INVALID))("%s reports a structured issue", (name, expected) => {
    const result = validateVideoIR(loadFixture(name));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toContainEqual(expect.objectContaining(expected));
  });

  it("brand intro timeline resolves to contiguous spans covering the duration", () => {
    const result = validateVideoIR(loadFixture("brand-intro-9x16.json"));
    if (!result.ok) throw new Error("fixture invalid");
    const spans = resolveSceneSpans(result.value.timeline, result.value.scenes);
    expect(spans.map((s) => [s.startMs, s.endMs])).toEqual([
      [0, 3000],
      [3000, 7000],
      [7000, 11500],
      [11500, 15000],
    ]);
  });
});
