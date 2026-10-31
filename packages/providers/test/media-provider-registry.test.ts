import { testTenant } from "@studix/core/testing";
import { describe, expect, it } from "vitest";
import {
  createMultixProviderFromConfig,
  FAKE_MODEL,
  FakeMediaProvider,
  MediaProviderRegistry,
  MultixProvider,
  type MultixRunner,
} from "../src/index.ts";

/** A multix CLI that only answers `check`, reporting the given key lines; catalogs are unavailable. */
const checkOnly =
  (checkText: string): MultixRunner =>
  async (argv) =>
    argv[0] === "check"
      ? { exitCode: 0, stdout: JSON.stringify({ schema: "multix.result/v1", ok: true, text: checkText }) }
      : { exitCode: 4, stdout: "" };

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
      new MultixProvider({ bin: "multix", runner: checkOnly("  ✗ SUME_API_KEY missing") }),
      new FakeMediaProvider(),
    ]);
    expect((await registry.select({ kind: "image" })).id).toBe("fake");
    expect((await registry.select({ kind: "music", model: FAKE_MODEL })).id).toBe("fake");
    expect((await registry.capable("voice")).map((c) => c.capability.outputMimes)).toEqual([["audio/wav"]]);
  });

  it("fails with UNAVAILABLE instead of degrading when nothing fits", async () => {
    const registry = new MediaProviderRegistry([new MultixProvider(), new FakeMediaProvider()]);
    await expect(registry.select({ kind: "video", model: "sume:seedance-2-mini" })).rejects.toMatchObject({
      code: "UNAVAILABLE",
    });
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

describe("MultixProvider in the registry", () => {
  it("is disabled without MULTIX_BIN and says how to enable it", async () => {
    const multix = createMultixProviderFromConfig({
      MULTIX_BIN: undefined,
      MULTIX_ALLOW_HOME_ENV: false,
      MULTIX_WAIT_TIMEOUT_SECONDS: 900,
    });
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

  it("is preferred for the kinds whose keys multix check reports", async () => {
    const multix = new MultixProvider({ bin: "multix", runner: checkOnly("  ✓ SUME_API_KEY found (…)") });
    const registry = new MediaProviderRegistry([multix, new FakeMediaProvider()]);
    expect((await registry.select({ kind: "video" })).id).toBe("multix");
    expect((await registry.select({ kind: "upscale", model: "sume:topaz-video" })).id).toBe("multix");
    // No ElevenLabs key: voice falls through to the next provider rather than failing at run time.
    expect((await registry.select({ kind: "voice" })).id).toBe("fake");
  });

  it("validates requests before reporting availability", async () => {
    await expect(
      new MultixProvider().generate(testTenant(), { ...request, workDir: "rel" }),
    ).rejects.toMatchObject({
      code: "VALIDATION",
    });
  });
});
