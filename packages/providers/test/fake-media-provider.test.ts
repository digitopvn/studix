import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MediaGenerationRequest } from "@studix/core";
import { testTenant } from "@studix/core/testing";
import { createManualClock } from "@studix/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FAKE_MODEL, FakeMediaProvider } from "../src/index.ts";

let workDir: string;
beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "studix-fake-provider-"));
});
afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

const ctx = testTenant();
const provider = new FakeMediaProvider({ clock: createManualClock(0) });
const request = (overrides: Partial<MediaGenerationRequest> = {}): MediaGenerationRequest => ({
  kind: "image",
  prompt: "Tách cà phê buổi sáng trên đồi Cầu Đất",
  idempotencyKey: "idem-1",
  maxCostCents: 0,
  workDir,
  ...overrides,
});
const sha = async (path: string) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");

describe("FakeMediaProvider", () => {
  it("advertises image and audio kinds but not video", async () => {
    const kinds = (await provider.capabilities()).map((c) => c.kind);
    expect(kinds).toEqual(["image", "audio", "voice", "music"]);
    await expect(provider.estimateCostCents({ kind: "image", prompt: "x", maxCostCents: 0 })).resolves.toBe(
      0,
    );
  });

  it("writes a deterministic PNG sized from the aspect ratio", async () => {
    const a = await provider.generate(ctx, request({ params: { aspectRatio: "9:16" } }));
    const b = await provider.generate(
      ctx,
      request({ params: { aspectRatio: "9:16" }, idempotencyKey: "idem-2" }),
    );
    expect(a).toMatchObject({ provider: "fake", model: FAKE_MODEL, costCents: 0, latencyMs: 0 });
    const out = a.outputs[0]!;
    expect(out).toMatchObject({ mime: "image/png", width: 288, height: 512 });
    expect(out.filePath.startsWith(workDir)).toBe(true);
    const png = await readFile(out.filePath);
    expect(png.subarray(1, 4).toString("ascii")).toBe("PNG");
    expect(png.readUInt32BE(16)).toBe(288);
    expect(png.readUInt32BE(20)).toBe(512);
    expect(b.outputs[0]!.filePath).toBe(out.filePath);
    const other = await provider.generate(ctx, request({ params: { aspectRatio: "9:16", seed: 7 } }));
    expect(await sha(other.outputs[0]!.filePath)).not.toBe(await sha(out.filePath));
  });

  it("writes a WAV tone of the requested duration for audio kinds", async () => {
    const result = await provider.generate(ctx, request({ kind: "voice", params: { durationMs: 1500 } }));
    const out = result.outputs[0]!;
    expect(out).toMatchObject({ mime: "audio/wav", durationMs: 1500 });
    const wav = await readFile(out.filePath);
    expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(wav.subarray(8, 12).toString("ascii")).toBe("WAVE");
    const sampleRate = wav.readUInt32LE(24);
    expect(wav.readUInt32LE(40) / 2 / sampleRate).toBeCloseTo(1.5, 3);
  });

  it("rejects unsupported kinds, foreign models and malformed params", async () => {
    await expect(provider.generate(ctx, request({ kind: "video" }))).rejects.toMatchObject({
      code: "UNAVAILABLE",
    });
    await expect(provider.generate(ctx, request({ model: "gpt-image-2" }))).rejects.toMatchObject({
      code: "VALIDATION",
    });
    await expect(provider.generate(ctx, request({ params: { width: 100 } }))).rejects.toMatchObject({
      code: "VALIDATION",
    });
    await expect(provider.generate(ctx, request({ params: { aspectRatio: "wide" } }))).rejects.toMatchObject({
      code: "VALIDATION",
    });
    await expect(
      provider.generate(ctx, request({ kind: "music", params: { durationMs: 120_000 } })),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(provider.generate(ctx, request({ workDir: "relative/dir" }))).rejects.toMatchObject({
      code: "VALIDATION",
    });
    await expect(provider.generate(ctx, request({ maxCostCents: -1 }))).rejects.toMatchObject({
      code: "VALIDATION",
    });
    await expect(provider.generate(ctx, request({ prompt: "   " }))).rejects.toMatchObject({
      code: "VALIDATION",
    });
  });

  it("honours an aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(provider.generate(ctx, request({ signal: controller.signal }))).rejects.toMatchObject({
      code: "CANCELLED",
    });
  });
});
