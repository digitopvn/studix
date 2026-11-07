import { describe, expect, it } from "vitest";
import { modelOptions, modelWarning } from "../src/pages/multix-model-options.ts";

const entries = [
  { id: "sume:seedance-2.5", vendor: "sume", model: "seedance-2.5", capabilities: ["text-to-video"] },
  {
    id: "sume:kling-3",
    vendor: "sume",
    model: "kling-3",
    label: "Kling 3",
    capabilities: ["image-to-video"],
  },
];
const values = (list: { value: string }[]) => list.map((o) => o.value);

describe("modelOptions", () => {
  it("starts with the server-value row and lists every model when nothing is typed", () => {
    expect(values(modelOptions(entries, "", ""))).toEqual(["", "sume:seedance-2.5", "sume:kling-3"]);
  });

  it("filters by id, label or capability, every word", () => {
    expect(values(modelOptions(entries, "kling", ""))).toEqual(["sume:kling-3"]);
    expect(values(modelOptions(entries, "image video", ""))).toEqual(["sume:kling-3"]);
    expect(values(modelOptions(entries, "SEEDANCE", ""))).toEqual(["sume:seedance-2.5"]);
    expect(modelOptions(entries, "veo", "")).toEqual([]);
  });

  it("shows a saved model the catalogue does not list", () => {
    expect(values(modelOptions(entries, "", "sume:custom-x"))).toEqual([
      "",
      "sume:custom-x",
      "sume:seedance-2.5",
      "sume:kling-3",
    ]);
  });
});

describe("modelWarning", () => {
  it("warns about a value outside the catalogue without blocking it", () => {
    expect(modelWarning("", entries, [])).toBeUndefined();
    expect(modelWarning("sume:kling-3", entries, [])).toBeUndefined();
    expect(modelWarning("sume:custom-x", entries, [])).toMatch(/Not in the Multix catalogue/);
    expect(modelWarning("atlas:any/model", entries, ["atlas"])).toMatch(/atlas accepts any/);
  });
});
