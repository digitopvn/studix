import { describe, expect, it } from "vitest";
import { jobScopedId, priorAttemptDirs, retryDelayMs, type StageContext } from "../src/index.ts";

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

describe("priorAttemptDirs", () => {
  const stage = (attempt: number, workRoot: string | undefined) =>
    ({ attempt, job: { id: "job_1" }, services: { workRoot } }) as unknown as StageContext;

  it("maps a stage directory onto every earlier attempt", () => {
    expect(priorAttemptDirs(stage(3, "/work"), "/work/job_1/attempt-3/audio")).toEqual([
      "/work/job_1/attempt-1/audio",
      "/work/job_1/attempt-2/audio",
    ]);
  });

  it("is empty on the first attempt, without a work root, or outside the attempt directory", () => {
    expect(priorAttemptDirs(stage(1, "/work"), "/work/job_1/attempt-1/audio")).toEqual([]);
    expect(priorAttemptDirs(stage(2, undefined), "/work/job_1/attempt-2/audio")).toEqual([]);
    expect(priorAttemptDirs(stage(2, "/work"), "/elsewhere/audio")).toEqual([]);
    expect(priorAttemptDirs(stage(2, "/work"), "/work/job_1/attempt-2")).toEqual([]);
  });
});
