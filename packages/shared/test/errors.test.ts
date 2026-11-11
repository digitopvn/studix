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

  it("turns a thrown zod error into a one-line, actionable Studix defect", () => {
    const schema = z.object({ audio: z.object({ tracks: z.array(z.number()).max(2) }), name: z.string() });
    const thrown = (() => {
      try {
        schema.parse({ audio: { tracks: [1, 2, 3] }, name: 7 });
      } catch (e) {
        return e;
      }
    })();
    const error = toStudixError(thrown);
    expect(error.code).toBe("INTERNAL");
    expect(error.retryable).toBe(false);
    expect(error.message).toMatch(/^Studix produced invalid data at audio\.tracks: .+ \(\+1 more\)$/);
    expect(error.message).not.toContain("\n");
    expect(error.suggestedAction).toContain("Studix defect");
    expect(error.details).toEqual({
      issues: [
        { path: "audio.tracks", code: "too_big", message: expect.any(String) },
        { path: "name", code: "invalid_type", message: expect.any(String) },
      ],
      issueCount: 2,
    });
  });

  it("guards error codes", () => {
    expect(isErrorCode("APPROVAL_REQUIRED")).toBe(true);
    expect(isErrorCode("NOPE")).toBe(false);
  });
});
