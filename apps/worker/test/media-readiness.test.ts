import type { MediaProvider } from "@studix/core";
import { describe, expect, it } from "vitest";
import { mediaReadiness } from "../src/pack-services.ts";

const provider = (capabilities: MediaProvider["capabilities"]) => ({ capabilities }) as MediaProvider;

describe("mediaReadiness", () => {
  it("reports no media without a provider", async () => {
    expect(await mediaReadiness(undefined)).toEqual({ configured: false, kinds: [] });
  });

  it("treats a provider with no kinds (MULTIX_BIN unset) as not configured", async () => {
    expect(await mediaReadiness(provider(async () => []))).toEqual({ configured: false, kinds: [] });
  });

  it("lists the generatable kinds by name only", async () => {
    const media = provider(async () => [
      { kind: "voice", models: ["x"], outputMimes: [] },
      { kind: "sfx", models: ["y"], outputMimes: [] },
    ]);
    expect(await mediaReadiness(media)).toEqual({ configured: true, kinds: ["voice", "sfx"] });
  });

  it("does not throw when the capability probe fails", async () => {
    const media = provider(async () => {
      throw new Error("multix check failed");
    });
    expect(await mediaReadiness(media)).toEqual({ configured: false, kinds: [] });
  });
});
