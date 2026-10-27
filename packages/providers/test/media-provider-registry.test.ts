import { testTenant } from "@studix/core/testing";
import { describe, expect, it } from "vitest";
import {
  createMultixProviderFromConfig,
  FAKE_MODEL,
  FakeMediaProvider,
  MediaProviderRegistry,
  MULTIX_CAPABILITY_CATALOG,
  MultixProvider,
} from "../src/index.ts";

const request = {
  kind: "image" as const,
  prompt: "logo",
  idempotencyKey: "k",
  maxCostCents: 100,
  workDir: "/tmp/studix-unused",
};

describe("MediaProviderRegistry", () => {
  it("registers, looks up and lists providers in preference order", () => {
    const fake = new FakeMediaProvider();
    const multix = new MultixProvider();
    const registry = new MediaProviderRegistry([multix, fake]);
    expect(registry.list().map((p) => p.id)).toEqual(["multix", "fake"]);
    expect(registry.get("fake")).toBe(fake);
    expect(() => registry.get("nope")).toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
    expect(() => registry.register(new FakeMediaProvider())).toThrow(
      expect.objectContaining({ code: "CONFLICT" }),
    );
  });

  it("selects the first provider that can serve the kind and model", async () => {
    const registry = new MediaProviderRegistry([
      new MultixProvider({ bin: "multix" }),
      new FakeMediaProvider(),
    ]);
    expect((await registry.select({ kind: "image" })).id).toBe("fake");
    expect((await registry.select({ kind: "music", model: FAKE_MODEL })).id).toBe("fake");
    expect((await registry.capable("voice")).map((c) => c.capability.outputMimes)).toEqual([["audio/wav"]]);
  });

  it("fails with UNAVAILABLE instead of degrading when nothing fits", async () => {
    const registry = new MediaProviderRegistry([new MultixProvider(), new FakeMediaProvider()]);
    await expect(registry.select({ kind: "video" })).rejects.toMatchObject({ code: "UNAVAILABLE" });
    await expect(registry.select({ kind: "image", model: "gpt-image-2" })).rejects.toMatchObject({
      code: "UNAVAILABLE",
    });
    await expect(registry.select({ kind: "image", providerId: "multix" })).rejects.toMatchObject({
      code: "UNAVAILABLE",
    });
    await expect(registry.select({ kind: "image", providerId: "missing" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    // biome-ignore lint/suspicious/noExplicitAny: exercising the runtime guard with an invalid kind
    await expect(registry.select({ kind: "hologram" as any })).rejects.toMatchObject({ code: "VALIDATION" });
  });
});

describe("MultixProvider shell", () => {
  it("is disabled without MULTIX_BIN and says how to enable it", async () => {
    const multix = createMultixProviderFromConfig({ MULTIX_BIN: undefined });
    expect(multix.enabled).toBe(false);
    expect(multix.status()).toMatchObject({ enabled: false, reason: "MULTIX_BIN is not set" });
    expect(await multix.capabilities()).toEqual([]);
    await expect(multix.generate(testTenant(), request)).rejects.toMatchObject({
      code: "UNAVAILABLE",
      message: "The Multix provider is not configured",
      suggestedAction: expect.stringContaining("MULTIX_BIN"),
    });
    await expect(multix.estimateCostCents(request)).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });

  it("carries capability metadata but advertises only wired modalities", async () => {
    const multix = new MultixProvider({ bin: "multix" });
    expect(multix.enabled).toBe(true);
    expect(multix.status().catalog).toBe(MULTIX_CAPABILITY_CATALOG);
    expect(MULTIX_CAPABILITY_CATALOG.map((c) => c.kind).sort()).toEqual([
      "audio",
      "image",
      "music",
      "video",
      "voice",
    ]);
    const wired = MULTIX_CAPABILITY_CATALOG.filter((c) => c.status === "wired");
    expect(await multix.capabilities()).toHaveLength(wired.length);
    await expect(multix.generate(testTenant(), { ...request, kind: "video" })).rejects.toMatchObject({
      code: "UNAVAILABLE",
      message: "Multix video generation is not wired in this build",
      details: { status: "planned" },
    });
  });

  it("validates requests before reporting availability", async () => {
    await expect(
      new MultixProvider().generate(testTenant(), { ...request, workDir: "rel" }),
    ).rejects.toMatchObject({
      code: "VALIDATION",
    });
  });
});
