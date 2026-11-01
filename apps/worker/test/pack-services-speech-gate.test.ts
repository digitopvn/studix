import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StudixDb } from "@studix/database";
import { createLogger } from "@studix/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadPackServices } from "../src/pack-services.ts";
import { loadWorkerSettings } from "../src/worker-settings.ts";

const DB = "postgres://studix:studix@127.0.0.1:55432/studix";
let workDir: string;
beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "studix-pack-services-"));
});
afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function load(vars: NodeJS.ProcessEnv, signal = new AbortController().signal) {
  const full = { DATABASE_URL: DB, WORKER_WORK_DIR: workDir, ...vars };
  return loadPackServices(loadWorkerSettings(full), {
    db: {} as StudixDb,
    env: full,
    logger: createLogger({ service: "test" }, { level: "error" }),
    signal,
  });
}

describe("loadPackServices with the speech gate", () => {
  it("refuses to start when the speech tool cannot run, with the way to fix it", async () => {
    await expect(
      load({ STUDIX_SPEECH_GATE: "true", STUDIX_QA_PYTHON: join(workDir, "no-such-python") }),
    ).rejects.toMatchObject({
      code: "UNAVAILABLE",
      suggestedAction: expect.stringContaining("STUDIX_QA_EXTRAS=speech"),
    });
  });

  it("does not probe, and wires no speech port, when the gate is off", async () => {
    const services = await load({ STUDIX_QA_PYTHON: join(workDir, "no-such-python") });
    expect(services.speech).toBeUndefined();
  });
});
