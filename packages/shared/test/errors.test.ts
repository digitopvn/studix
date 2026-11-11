import { describe, expect, it } from "vitest";
import { z } from "zod";
import { isErrorCode, StudixError, toStudixError } from "../src/index.ts";

describe("StudixError", () => {
  it("defaults retryable by code and serializes to a stable payload", () => {
    const timeout = new StudixError("TIMEOUT", "render timed out", { suggestedAction: "Retry the job." });
    expect(timeout.retryable).toBe(true);
    expect(JSON.parse(JSON.stringify(timeout))).toEqual({
      code: "TIMEOUT",
      message: "render timed out",
      retryable: true,
      suggestedAction: "Retry the job.",
    });
    expect(new StudixError("VALIDATION", "bad").retryable).toBe(false);
    expect(new StudixError("VALIDATION", "bad", { retryable: true }).retryable).toBe(true);
  });

  it("round-trips through JSON", () => {
    const original = new StudixError("FORBIDDEN", "nope", { details: { resource: "project" } });
    const restored = StudixError.fromJSON(original.toJSON());
    expect(restored).toBeInstanceOf(StudixError);
    expect(restored.toJSON()).toEqual(original.toJSON());
  });

  it("normalizes unknown throwables", () => {
    const existing = new StudixError("CONFLICT", "dup");
    expect(toStudixError(existing)).toBe(existing);
    expect(toStudixError(new Error("boom")).code).toBe("INTERNAL");
    expect(toStudixError(new Error("boom"), "PROVIDER_ERROR").retryable).toBe(true);
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(toStudixError(abort).code).toBe("CANCELLED");
    expect(toStudixError("plain").message).toBe("plain");
    expect(toStudixError(42).details).toEqual({ thrown: "42" });
  });

  it("turns a zod error thrown inside a stage into one actionable line", () => {
    const Ir = z.object({
      audio: z.array(z.string()).max(2),
      scenes: z.array(z.object({ text: z.string() })),
    });
    const thrown = (() => {
      try {
        Ir.parse({ audio: ["a", "b", "c"], scenes: [{ text: 1 }] });
      } catch (err) {
        return err;
      }
    })();
    const error = toStudixError(thrown);
    expect(error.code).toBe("INTERNAL");
    expect(error.retryable).toBe(false);
    expect(error.message).toBe(
      "Schema check failed at /audio: Too big: expected array to have <=2 items (+1 more)",
    );
    expect(error.message).not.toContain("\n");
    expect(error.suggestedAction).toContain("Studix defect");
    expect(error.suggestedAction).toContain("shorter or simpler brief");
    expect(error.details).toEqual({
      kind: "schema",
      issueCount: 2,
      issues: [
        { path: "/audio", code: "too_big", message: "Too big: expected array to have <=2 items" },
        {
          path: "/scenes/0/text",
          code: "invalid_type",
          message: "Invalid input: expected string, received number",
        },
      ],
    });
    // A non-INTERNAL fallback keeps its own code and retry policy.
    expect(toStudixError(thrown, "PROVIDER_ERROR")).toMatchObject({
      code: "PROVIDER_ERROR",
      retryable: true,
    });
  });

  it("guards error codes", () => {
    expect(isErrorCode("APPROVAL_REQUIRED")).toBe(true);
    expect(isErrorCode("NOPE")).toBe(false);
  });
});
