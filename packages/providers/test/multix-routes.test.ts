import { describe, expect, it } from "vitest";
import { DEFAULT_MULTIX_MODELS, parseVoiceLanguageRoutes, planMultixRequest } from "../src/multix-routes.ts";

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

describe("ElevenLabs speech language", () => {
  const speech = (params: Record<string, unknown>, model?: string) =>
    planMultixRequest(
      { kind: "voice", prompt: "Sáng nay bạn đã uống trà chưa?", params, ...(model ? { model } : {}) },
      undefined,
      context,
    );
  const languageCode = (argv: readonly string[]) =>
    argv.find((a) => a.startsWith("--language-code="))?.slice("--language-code=".length);

  it("moves a Vietnamese line off the default model, which does not speak it, and names the language", async () => {
    const plan = await speech({ language: "vi" });
    expect(plan.model.id).toBe("elevenlabs:eleven_v3");
    expect(plan.argv).toContain("--model=eleven_v3");
    expect(languageCode(plan.argv)).toBe("vi");
  });

  it("keeps the default model for a language it speaks, without the language_code it refuses", async () => {
    const plan = await speech({ language: "en-US" });
    expect(plan.model.id).toBe("elevenlabs:eleven_multilingual_v2");
    expect(languageCode(plan.argv)).toBeUndefined();
  });

  it("passes language_code to a model that takes it", async () => {
    const plan = await speech({ language: "vi-VN" }, "elevenlabs:eleven_turbo_v2_5");
    expect(plan.model.id).toBe("elevenlabs:eleven_turbo_v2_5");
    expect(languageCode(plan.argv)).toBe("vi-VN");
  });

  it("refuses a named model that does not speak the language before anything is paid", async () => {
    await expect(speech({ language: "vi" }, "elevenlabs:eleven_multilingual_v2")).rejects.toMatchObject({
      code: "VALIDATION",
      details: { suggestedModel: "elevenlabs:eleven_v3" },
    });
  });
});

describe("speech routed by language", () => {
  const routes = parseVoiceLanguageRoutes(
    "vi=openrouter:fish-audio/drama-3, ja=openrouter:google/gemini-3.8-flash-tts@Kore",
    DEFAULT_MULTIX_MODELS,
  );
  const routed = { ...context, voiceRoutes: routes };
  const speech = (params: Record<string, unknown>, model?: string) =>
    planMultixRequest(
      { kind: "voice", prompt: "Sáng nay bạn đã uống trà chưa?", params, ...(model ? { model } : {}) },
      undefined,
      routed,
    );
  const value = (argv: readonly string[], name: string) =>
    argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

  it("sends a routed language to its model with the delivery direction, priced by estimate", async () => {
    const plan = await speech({ language: "vi-VN", instructions: "Warm, bright hook; inviting close." });
    expect(plan.model.id).toBe("openrouter:fish-audio/drama-3");
    expect(plan.argv.slice(0, 2)).toEqual(["openrouter", "tts"]);
    expect(value(plan.argv, "model")).toBe("fish-audio/drama-3");
    expect(value(plan.argv, "instructions")).toBe("Warm, bright hook; inviting close.");
    expect(value(plan.argv, "format")).toBe("mp3");
    expect(value(plan.argv, "voice")).toBeUndefined();
    expect(plan).toMatchObject({ priced: true, costPolicy: "estimate", outputExt: ".mp3" });
  });

  it("asks PCM-only models for WAV and uses the route's voice unless the request names one", async () => {
    const plan = await speech({ language: "ja" });
    expect(plan.outputExt).toBe(".wav");
    expect(value(plan.argv, "format")).toBe("wav");
    expect(value(plan.argv, "voice")).toBe("Kore");
    expect(value((await speech({ language: "ja", voice: "Puck" })).argv, "voice")).toBe("Puck");
  });

  it("leaves unrouted languages and named models where they were", async () => {
    expect((await speech({ language: "en" })).model.id).toBe("elevenlabs:eleven_multilingual_v2");
    const named = await speech({ language: "vi", instructions: "calm" }, "elevenlabs:eleven_v3");
    expect(named.model.id).toBe("elevenlabs:eleven_v3");
    expect(named.costPolicy).toBeUndefined();
    expect(named.argv.some((a) => a.startsWith("--instructions="))).toBe(false);
  });

  it("refuses direction that is not bounded plain text before anything is paid", async () => {
    for (const instructions of ["", "x".repeat(1001), "calm\u0007", 42]) {
      await expect(speech({ language: "vi", instructions })).rejects.toMatchObject({ code: "VALIDATION" });
    }
  });

  it("refuses malformed routes at startup", () => {
    for (const bad of ["vi", "vi=sume:seedance-2-mini", "vi=openrouter:a,vi=openrouter:b", "x1=fish:s1"]) {
      expect(() => parseVoiceLanguageRoutes(bad, DEFAULT_MULTIX_MODELS)).toThrow(/route|served|routed/);
    }
    expect(parseVoiceLanguageRoutes(undefined, DEFAULT_MULTIX_MODELS)).toEqual({});
  });
});
