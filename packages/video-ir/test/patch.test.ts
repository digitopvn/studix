import { StudixError } from "@studix/shared";
import { describe, expect, it } from "vitest";
import { applyJsonPatch, applyPatch, type VideoIR } from "../src/index.ts";
import { loadFixture } from "./load-fixture.ts";

const ir = () => loadFixture("brand-intro-9x16.json") as VideoIR;

function errorOf(fn: () => unknown): StudixError {
  try {
    fn();
  } catch (err) {
    if (err instanceof StudixError) return err;
    throw err;
  }
  throw new Error("expected a StudixError");
}

describe("applyPatch", () => {
  it("returns a new validated IR and leaves the input untouched", () => {
    const original = ir();
    const snapshot = structuredClone(original);
    const next = applyPatch(original, {
      description: "Shorter hook copy",
      ops: [
        { op: "test", path: "/scenes/0/shots/0/text", value: "Mỗi sáng một tách mộc" },
        { op: "replace", path: "/scenes/0/shots/0/text", value: "Sáng nay uống gì?" },
      ],
    });
    expect(next.scenes[0]!.shots[0]).toMatchObject({ text: "Sáng nay uống gì?" });
    expect(original).toEqual(snapshot);
    expect(next).not.toBe(original);
  });

  it("supports add/remove/move/copy on arrays", () => {
    const doc = { list: [1, 2, 3], obj: { a: 1 } };
    const out = applyJsonPatch(doc, [
      { op: "add", path: "/list/-", value: 4 },
      { op: "remove", path: "/list/0" },
      { op: "move", from: "/obj/a", path: "/obj/b" },
      { op: "copy", from: "/list/0", path: "/list/0" },
    ]);
    expect(out).toEqual({ list: [2, 2, 3, 4], obj: { b: 1 } });
  });

  it("rejects patches that would produce an invalid IR", () => {
    const err = errorOf(() =>
      applyPatch(ir(), { ops: [{ op: "replace", path: "/scenes/0/durationMs", value: 4000 }] }),
    );
    expect(err.code).toBe("VALIDATION");
    expect(err.details?.issues).toBeDefined();
  });

  it("reports failed test ops as CONFLICT", () => {
    const err = errorOf(() => applyPatch(ir(), { ops: [{ op: "test", path: "/title", value: "stale" }] }));
    expect(err.code).toBe("CONFLICT");
  });

  it("rejects missing paths, bad indexes and prototype pollution", () => {
    expect(errorOf(() => applyJsonPatch({ a: 1 }, [{ op: "remove", path: "/b" }])).code).toBe("VALIDATION");
    expect(errorOf(() => applyJsonPatch({ a: [1] }, [{ op: "replace", path: "/a/5", value: 1 }])).code).toBe(
      "VALIDATION",
    );
    expect(
      errorOf(() => applyJsonPatch({}, [{ op: "add", path: "/__proto__/polluted", value: true }])).code,
    ).toBe("VALIDATION");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("validates the patch envelope", () => {
    expect(errorOf(() => applyPatch(ir(), { ops: [] })).code).toBe("VALIDATION");
  });
});
