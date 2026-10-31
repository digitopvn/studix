import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { jobScopedId, retryDelayMs, type StageContext, stageWorkDir } from "../src/index.ts";

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

describe("stageWorkDir", () => {
  it("is shared by every attempt of a job, so a retry finds the media a failed attempt already produced", async () => {
    const workRoot = mkdtempSync(join(tmpdir(), "studix-workdir-test-"));
    const at = (attempt: number, jobId = "job_a") =>
      ({ attempt, job: { id: jobId }, services: { workRoot } }) as unknown as StageContext;
    const first = await stageWorkDir(at(1), "audio");
    writeFileSync(join(first, "voice.mp3"), "paid bytes");
    const second = await stageWorkDir(at(2), "audio");
    expect(second).toBe(first);
    expect(readFileSync(join(second, "voice.mp3"), "utf8")).toBe("paid bytes");
    expect(await stageWorkDir(at(2, "job_b"), "audio")).not.toBe(first);
    expect(await stageWorkDir(at(2), "other stage")).not.toBe(first);
  });
});
