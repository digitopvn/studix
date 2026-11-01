import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StudixError } from "@studix/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSpeechProbe, QA_TOOLS, type QaToolchain, SPEECH_MIN_MS } from "../src/index.ts";

const fake: QaToolchain = {
  python: process.execPath,
  args: [join(import.meta.dirname, "fixtures", "fake-qa-tool.mjs")],
};

let dir: string;
const clip = async (name: string) => {
  const path = join(dir, name);
  await writeFile(path, "audio");
  return path;
};
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "studix-speech-probe-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const probe = (minSpeechMs?: number) =>
  createSpeechProbe({
    run: { toolchain: fake, sandboxRoot: join(dir, "sandboxes"), timeoutMs: 10_000 },
    ...(minSpeechMs === undefined ? {} : { minSpeechMs }),
  });
const signal = new AbortController().signal;

describe("speech probe", () => {
  it("measures the granted file and calls a voiced one speech", async () => {
    expect(await probe().measure(await clip("voiced.wav"), signal)).toEqual({
      speechMs: 1400,
      durationMs: 3000,
      speech: true,
    });
  });

  it("calls a file with no voiced stretch clean", async () => {
    expect(await probe().measure(await clip("wind.wav"), signal)).toEqual({
      speechMs: 0,
      durationMs: 3000,
      speech: false,
    });
  });

  it("keeps a short blip below the threshold, and lets the worker move the threshold", async () => {
    const blip = await clip("breath.wav");
    expect(200).toBeLessThan(SPEECH_MIN_MS);
    expect((await probe().measure(blip, signal)).speech).toBe(false);
    expect((await probe(150).measure(blip, signal)).speech).toBe(true);
  });

  it("fails, never reports clean, when the detector is not installed", async () => {
    const err = await probe()
      .measure(await clip("no-model.wav"), signal)
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(StudixError);
    expect(err).toMatchObject({ code: "UNAVAILABLE" });
  });

  it("runs on the optional speech image", () => {
    expect(QA_TOOLS.speechActivity).toMatchObject({ name: "speech-activity", image: "speech" });
  });
});
