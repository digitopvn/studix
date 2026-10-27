import { describe, expect, it } from "vitest";
import { jobScopedId, retryDelayMs } from "../src/index.ts";

describe("retry backoff", () => {
  it("doubles per attempt and caps", () => {
    const opts = { baseMs: 100, maxMs: 1000 };
    expect([1, 2, 3, 4, 5].map((a) => retryDelayMs(a, opts))).toEqual([100, 200, 400, 800, 1000]);
    expect(retryDelayMs(0, opts)).toBe(100);
  });
});

describe("jobScopedId", () => {
  it("derives a stable record id from the job id", () => {
    expect(jobScopedId("rnd", "job_01hzzzzzzzzzzzzzzzzzzzzzzz")).toBe("rnd_01hzzzzzzzzzzzzzzzzzzzzzzz");
    expect(jobScopedId("pver", "job_abc")).toBe(jobScopedId("pver", "job_abc"));
  });
});
