import { describe, expect, it } from "vitest";
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

  it("guards error codes", () => {
    expect(isErrorCode("APPROVAL_REQUIRED")).toBe(true);
    expect(isErrorCode("NOPE")).toBe(false);
  });
});
