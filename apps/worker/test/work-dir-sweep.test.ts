import { mkdir, mkdtemp, readdir, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newId } from "@studix/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sweepStaleJobDirs } from "../src/work-dir-sweep.ts";

const DAY = 86_400_000;
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "studix-sweep-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function dir(name: string, ageMs: number): Promise<void> {
  const path = join(root, name, "attempt-1");
  await mkdir(path, { recursive: true });
  const when = new Date(Date.now() - ageMs);
  await utimes(join(root, name), when, when);
}

describe("sweepStaleJobDirs", () => {
  it("removes only old job directories", async () => {
    const old = newId("job");
    const fresh = newId("job");
    await dir(old, 10 * DAY);
    await dir(fresh, DAY);
    await dir("claude", 30 * DAY);
    const removed = await sweepStaleJobDirs(root, 7 * DAY);
    expect(removed).toEqual([old]);
    expect((await readdir(root)).sort()).toEqual([fresh, "claude"].sort());
  });

  it("tolerates a missing work directory", async () => {
    expect(await sweepStaleJobDirs(join(root, "absent"), DAY)).toEqual([]);
  });
});
