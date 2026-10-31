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
  it("advertises every kind the Multix provider serves", async () => {
    const kinds = (await provider.capabilities()).map((c) => c.kind);
    expect(kinds).toEqual(["image", "video", "audio", "voice", "music", "sfx", "upscale"]);
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

  it("writes an uncompressed AVI of the requested length for video", async () => {
    const result = await provider.generate(
      ctx,
      request({ kind: "video", params: { aspectRatio: "16:9", durationMs: 1000 } }),
    );
    const out = result.outputs[0]!;
    expect(out).toMatchObject({ mime: "video/x-msvideo", width: 160, height: 90, durationMs: 1000 });
    const avi = await readFile(out.filePath);
    expect(avi.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(avi.readUInt32LE(4)).toBe(avi.length - 8);
    expect(avi.subarray(8, 12).toString("ascii")).toBe("AVI ");
    const avih = avi.indexOf("avih");
    expect(avi.readUInt32LE(avih + 8 + 16)).toBe(12); // frames: 1 s at 12 fps
    expect(avi.readUInt32LE(avih + 8 + 32)).toBe(160);
    expect(avi.readUInt32LE(avih + 8 + 36)).toBe(90);
    const movi = avi.indexOf("movi");
    const idx1 = avi.indexOf("idx1");
    // Every index entry points at a "00db" chunk relative to the "movi" fourcc.
    for (let f = 0; f < 12; f++) {
      const offset = avi.readUInt32LE(idx1 + 8 + f * 16 + 8);
      expect(avi.subarray(movi + offset, movi + offset + 4).toString("ascii")).toBe("00db");
    }
  });

  it("covers sfx and upscales images and video by params.scale", async () => {
    const sfx = await provider.generate(ctx, request({ kind: "sfx", params: { durationMs: 500 } }));
    expect(sfx.outputs[0]).toMatchObject({ mime: "audio/wav", durationMs: 500 });

    const image = await provider.generate(
      ctx,
      request({ kind: "upscale", params: { image: "https://example.com/a.png", scale: 4 } }),
    );
    expect(image.outputs[0]).toMatchObject({ mime: "image/png", width: 1024, height: 1024 });
    const video = await provider.generate(
      ctx,
      request({ kind: "upscale", params: { video: "/in/clip.mp4" } }),
    );
    expect(video.outputs[0]).toMatchObject({ mime: "video/x-msvideo", width: 160, height: 160 });

    await expect(provider.generate(ctx, request({ kind: "upscale" }))).rejects.toMatchObject({
      code: "VALIDATION",
    });
    await expect(
      provider.generate(ctx, request({ kind: "upscale", params: { image: "a", video: "b" } })),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("resumes a job by its id without generating again", async () => {
    const first = await provider.generate(ctx, request({ params: { seed: "resume" } }));
    expect(first.job).toEqual({ provider: "fake", id: expect.stringMatching(/^fake_[0-9a-f]{16}$/) });
    const resumed = await provider.resume(ctx, { kind: "image", job: first.job!, workDir });
    expect(resumed.outputs).toEqual(first.outputs);
    expect(resumed.costSource).toBe("receipt");

    await expect(
      provider.resume(ctx, { kind: "image", job: { provider: "fake", id: "fake_missing" }, workDir }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      provider.resume(testTenant({ workspaceId: "ws_other" }), { kind: "image", job: first.job!, workDir }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("simulates estimates and receipts when given prices", async () => {
    const priced = new FakeMediaProvider({
      pricing: { estimateCents: () => 3, chargeCents: (r) => (r.kind === "image" ? 4 : undefined) },
    });
    await expect(priced.estimateCostCents({ kind: "image", prompt: "x", maxCostCents: 10 })).resolves.toBe(3);
    const image = await priced.generate(ctx, request({ maxCostCents: 10 }));
    expect(image).toMatchObject({ costCents: 4, costSource: "receipt" });
    const voice = await priced.generate(ctx, request({ kind: "voice", maxCostCents: 10 }));
    expect(voice).toMatchObject({ costCents: 3, costSource: "estimate" });
    await expect(priced.generate(ctx, request({ maxCostCents: 2 }))).rejects.toMatchObject({
      code: "BUDGET_EXCEEDED",
    });
  });

  it("rejects foreign models and malformed params", async () => {
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
