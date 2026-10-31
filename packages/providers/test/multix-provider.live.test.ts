import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testTenant } from "@studix/core/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MultixProvider } from "../src/index.ts";

/**
 * Paid smoke test (collected only with STUDIX_LIVE=1, and skipped unless MULTIX_BIN points at the multix
 * CLI). It spends a few cents: one Sume z-image job (~$0.01), one Atlas Cloud upscale of it (~$0.01) and
 * one very short ElevenLabs TTS line, each capped at 2 cents by the provider's own pre-flight check. It then
 * collects the Sume job again by its id, which is free. Keys come from the worker env, or from
 * ~/.multix/.env when MULTIX_ALLOW_HOME_ENV=1 (local development).
 */
const bin = process.env.MULTIX_BIN;
const CAP_CENTS = 2;

describe.skipIf(!bin)("MultixProvider (live)", () => {
  const ctx = testTenant();
  let workDir: string;
  const multix = new MultixProvider({
    bin,
    allowHomeEnv: process.env.MULTIX_ALLOW_HOME_ENV === "1",
    models: { image: "sume:z-image" },
    waitTimeoutMs: 300_000,
  });

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "studix-multix-live-"));
  });
  afterAll(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  const report = (step: string, r: { costCents: number; costSource?: string; job?: unknown }) =>
    console.info(
      `[multix live] ${step}: ${r.costCents}¢ (${r.costSource}) job=${JSON.stringify(r.job ?? null)}`,
    );

  it("reports ready vendors from multix check", async () => {
    const ready = await multix.readiness();
    expect(ready.sume).toBe(true);
    const kinds = (await multix.capabilities()).map((c) => c.kind);
    expect(kinds).toContain("image");
  });

  let imagePath = "";
  let imageJob: { provider: string; id: string } | undefined;

  it("generates an image on Sume, then resumes the same job by id for free", async () => {
    const request = {
      kind: "image" as const,
      prompt: "A small red paper boat on calm water, flat illustration",
      idempotencyKey: `live-image-${Date.now()}`,
      maxCostCents: CAP_CENTS,
      workDir,
      params: { aspectRatio: "1:1" },
    };
    expect(await multix.estimateCostCents(request)).toBeLessThanOrEqual(CAP_CENTS);
    const result = await multix.generate(ctx, request);
    report("sume image", result);
    expect(result.job?.provider).toBe("sume");
    expect(result.outputs.length).toBeGreaterThan(0);
    imagePath = result.outputs[0]!.filePath;
    imageJob = result.job;
    expect((await stat(imagePath)).size).toBeGreaterThan(0);
    expect(result.costCents).toBeLessThanOrEqual(CAP_CENTS);

    const resumed = await multix.resume(ctx, { kind: "image", job: imageJob!, model: result.model, workDir });
    report("sume resume", resumed);
    expect(resumed.outputs.length).toBeGreaterThan(0);
  });

  it("upscales that image on Atlas Cloud", async () => {
    expect(imagePath).not.toBe("");
    const result = await multix.generate(ctx, {
      kind: "upscale",
      prompt: "upscale",
      idempotencyKey: `live-upscale-${Date.now()}`,
      maxCostCents: CAP_CENTS,
      workDir,
      params: { image: imagePath, scale: 2 },
    });
    report("atlas upscale", result);
    expect(result.job?.provider).toBe("atlas");
    expect(result.outputs[0]?.mime).toMatch(/^image\//);
  });

  it("speaks a short line on ElevenLabs", async () => {
    const result = await multix.generate(ctx, {
      kind: "voice",
      prompt: "Xin chào.",
      idempotencyKey: `live-voice-${Date.now()}`,
      maxCostCents: CAP_CENTS,
      workDir,
    });
    report("elevenlabs tts", result);
    expect(result.outputs[0]?.mime).toBe("audio/mpeg");
    expect((await stat(result.outputs[0]!.filePath)).size).toBeGreaterThan(0);
  });
});
