import { describe, expect, it } from "vitest";
import { inspectCapabilities } from "../src/mcp/inspect-capabilities.ts";
import { assertMediaAvailable, mediaAvailability, mediaNeededBy } from "../src/media-availability.ts";

const off = { enabled: false, reason: "MULTIX_BIN is not set" };
const spoken: Record<string, unknown> = {
  directions: [{ beats: [{ visual: "a" }, { visual: "b", voiceover: "Xin chào" }] }],
};
const silent: Record<string, unknown> = {
  directions: [{ beats: [{ visual: "a", onScreen: "x" }, { visual: "b" }] }],
};

describe("media availability", () => {
  it("derives the server view from MULTIX_BIN", () => {
    expect(mediaAvailability({})).toEqual(off);
    expect(mediaAvailability({ MULTIX_BIN: "multix" })).toEqual({ enabled: true });
  });

  it("needs media for a spoken motion graphic but not a silent one", () => {
    expect(mediaNeededBy("motion-graphic", spoken)).toBeDefined();
    expect(mediaNeededBy("motion-graphic", silent)).toBeUndefined();
    expect(mediaNeededBy("motion-graphic", undefined)).toBeDefined();
    expect(mediaNeededBy("motion-graphic", { prompt: "x" })).toBeDefined();
    expect(mediaNeededBy("motion-graphic", { directions: [{ hook: "h" }] })).toBeDefined();
    expect(mediaNeededBy("motion-graphic", spoken, true)).toBeUndefined();
    expect(mediaNeededBy("motion-graphic", { directions: "x" })).toBeDefined();
    expect(mediaNeededBy("motion-graphic", { directions: [null] })).toBeDefined();
    expect(mediaNeededBy("anime", undefined)).toBeDefined();
    expect(mediaNeededBy("long-form-film", undefined)).toBeDefined();
    expect(mediaNeededBy("brand-intro", spoken)).toBeUndefined();
  });

  it("refuses early with an actionable, non-retryable error", () => {
    expect(() => assertMediaAvailable(off, "motion-graphic", spoken)).toThrowError(
      expect.objectContaining({
        code: "UNAVAILABLE",
        retryable: false,
        details: { provider: "multix", workflowTemplate: "motion-graphic" },
      }),
    );
    expect(() => assertMediaAvailable(off, "marketing-video", undefined)).toThrow(/media generation is off/);
  });

  it("lets silent jobs, enabled media and unknown availability through", () => {
    expect(() => assertMediaAvailable(off, "motion-graphic", silent)).not.toThrow();
    expect(() => assertMediaAvailable({ enabled: true }, "motion-graphic", spoken)).not.toThrow();
    expect(() => assertMediaAvailable(undefined, "motion-graphic", spoken)).not.toThrow();
  });

  it("advertises the state in studix_inspect", () => {
    const base = {
      tenant: { workspaceId: "ws_1" } as never,
      limits: {
        defaultJobBudgetCents: 1,
        defaultJobDeadlineSeconds: 1,
        approvalCostThresholdCents: 1,
        signedUrlTtlSeconds: 1,
      },
      skills: [],
      toolNames: [],
      include: [],
    };
    expect(inspectCapabilities({ ...base, media: off })).toMatchObject({
      media: { enabled: false, reason: "MULTIX_BIN is not set" },
    });
    expect(inspectCapabilities({ ...base, media: { enabled: true } })).toMatchObject({
      media: { enabled: true },
    });
    expect(inspectCapabilities(base)).not.toHaveProperty("media");
  });
});
