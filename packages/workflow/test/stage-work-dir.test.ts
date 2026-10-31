import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type StageContext, stageMediaDir, stageWorkDir } from "../src/index.ts";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "studix-stage-dir-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const stageContext = (jobId: string, attempt: number) =>
  ({ job: { id: jobId }, attempt, services: { workRoot: root } }) as unknown as StageContext;

describe("stageMediaDir", () => {
  it("is the same directory on every attempt, so a retried stage finds the file it already paid for", async () => {
    const first = await stageMediaDir(stageContext("job_1", 1), "audio");
    await writeFile(join(first, "voiceover.mp3"), "paid-for");

    const retried = await stageMediaDir(stageContext("job_1", 2), "audio");
    expect(retried).toBe(first);
    expect(await readFile(join(retried, "voiceover.mp3"), "utf8")).toBe("paid-for");
  });

  it("is not the attempt scratch directory, which a stale attempt may clear", async () => {
    const scratch = await stageWorkDir(stageContext("job_1", 1), "audio");
    expect(await stageMediaDir(stageContext("job_1", 1), "audio")).not.toBe(scratch);
    expect(await stageWorkDir(stageContext("job_1", 2), "audio")).not.toBe(scratch);
  });

  it("keeps jobs and stages apart and stays inside the job's directory", async () => {
    const dirs = await Promise.all([
      stageMediaDir(stageContext("job_1", 1), "audio"),
      stageMediaDir(stageContext("job_1", 1), "i2v"),
      stageMediaDir(stageContext("job_2", 1), "audio"),
      stageMediaDir(stageContext("job_1", 1), "../escape"),
    ]);
    expect(new Set(dirs).size).toBe(4);
    expect(dirs.every((d) => d.startsWith(root))).toBe(true);
    expect(dirs[3]!.startsWith(join(root, "job_1"))).toBe(true);
  });
});
