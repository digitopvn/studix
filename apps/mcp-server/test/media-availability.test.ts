import { testTenant } from "@studix/core/testing";
import { describe, expect, it } from "vitest";
import type { AppLimits } from "../src/app-deps.ts";
import { inspectCapabilities } from "../src/mcp/inspect-capabilities.ts";
import { NATIVE_TOOLS } from "../src/mcp/native-tools.ts";

const inspect = (media?: { enabled: boolean; reason?: string }) =>
  inspectCapabilities({
    tenant: testTenant(),
    limits: {} as AppLimits,
    skills: [],
    media,
    toolNames: [],
    include: [],
  });

describe("studix_inspect media availability", () => {
  it("reports media off with the reason and warns about voice-over", () => {
    const capabilities = inspect({ enabled: false, reason: "MULTIX_BIN is not set" });
    expect(capabilities.media).toEqual({ enabled: false, reason: "MULTIX_BIN is not set" });
    expect(capabilities.constraints.join(" ")).toContain("Paid media is off");
  });

  it("reports media on without a warning", () => {
    const capabilities = inspect({ enabled: true });
    expect(capabilities.media).toEqual({ enabled: true });
    expect(capabilities.constraints.join(" ")).not.toContain("Paid media is off");
  });

  it("omits media when the host does not report it", () => {
    expect(inspect()).not.toHaveProperty("media");
  });
});

describe("studix_create_video voice-over preflight", () => {
  const createVideo = NATIVE_TOOLS.find((t) => t.name === "studix_create_video");
  const brief = {
    prompt: "intro",
    directions: [{ id: "d1", name: "A", concept: "c", beats: [{ visual: "v", voiceover: "Xin chào" }] }],
  };
  const run = (media: { enabled: boolean } | undefined, b: unknown) =>
    // biome-ignore lint/suspicious/noExplicitAny: a minimal context is enough to reach the preflight
    (createVideo as any).run(
      {
        tenant: testTenant(),
        deps: { media, studio: { createVideoProject: () => Promise.reject(new Error("reached studio")) } },
      },
      { brief: b, workflowTemplate: "motion-graphic", idempotencyKey: "k-1234567890" },
    );

  it("refuses a voice-over brief before creating a job when media is off", async () => {
    await expect(run({ enabled: false }, brief)).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });

  it("lets a silent brief through to the studio when media is off", async () => {
    await expect(run({ enabled: false }, { prompt: "silent" })).rejects.toThrow("reached studio");
  });

  it("lets a voice-over brief through when media is on", async () => {
    await expect(run({ enabled: true }, brief)).rejects.toThrow("reached studio");
  });
});
