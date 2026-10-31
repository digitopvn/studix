import { describe, expect, it } from "vitest";
import { DEFAULT_MULTIX_MODELS, planMultixRequest } from "../src/multix-routes.ts";

const context = { defaults: DEFAULT_MULTIX_MODELS, waitTimeoutMs: 60_000 };
const resolution = (argv: readonly string[]) =>
  argv.find((a) => a.startsWith("--resolution="))?.slice("--resolution=".length);

async function plan(model: string, params: Record<string, unknown> = {}) {
  return planMultixRequest({ kind: "video", model, params, prompt: "a slow dolly-in" }, undefined, context);
}

describe("multix video resolution defaults", () => {
  it("asks Seedance 2.5 for 480p when the request names no resolution", async () => {
    expect(resolution((await plan("sume:seedance-2.5", { durationMs: 5000 })).argv)).toBe("480p");
  });

  it("keeps a resolution the request names", async () => {
    expect(resolution((await plan("sume:seedance-2.5", { resolution: "720p" })).argv)).toBe("720p");
  });

  it("applies to Seedance 2.5 image-to-video and lip-sync calls too", async () => {
    const i2v = await plan("sume:seedance-2.5", { image: "https://example.com/frame.png" });
    expect(resolution(i2v.argv)).toBe("480p");
    const lipsync = await plan("sume:seedance-2.5", {
      image: "https://example.com/frame.png",
      audio: "https://example.com/line.mp3",
    });
    expect(lipsync.role).toBe("lipsync");
    expect(resolution(lipsync.argv)).toBe("480p");
  });

  it("leaves other models on the upstream default", async () => {
    expect(resolution((await plan("sume:seedance-2-mini")).argv)).toBeUndefined();
  });
});
