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

  it("runs a character cast on another model and voice than its language's route, with its direction", async () => {
    // Vietnamese is routed to Fish (no voice list); a film cast its character on Gemini with a voice of its own.
    const plan = await speech(
      { language: "vi", voice: "Leda", instructions: "giọng nữ trẻ, trách yêu" },
      "openrouter:google/gemini-3.8-flash-tts",
    );
    expect(plan.model.id).toBe("openrouter:google/gemini-3.8-flash-tts");
    expect(value(plan.argv, "model")).toBe("google/gemini-3.8-flash-tts");
    expect(value(plan.argv, "voice")).toBe("Leda");
    expect(value(plan.argv, "instructions")).toBe("giọng nữ trẻ, trách yêu");
    expect(plan).toMatchObject({ costPolicy: "estimate", outputExt: ".wav" });
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

describe("providers run through multix generate", () => {
  const context = { defaults: DEFAULT_MULTIX_MODELS, waitTimeoutMs: 900_000 };

  it("runs a non-Sume image model as one generate call with the prompt after --", async () => {
    const plan = await planMultixRequest(
      { kind: "image", model: "fal:fal-ai/flux/schnell", params: { aspectRatio: "16:9" }, prompt: "a fox" },
      undefined,
      context,
    );
    expect(plan).toMatchObject({ mode: "sync", priced: false, outputExt: ".png", operand: "a fox" });
    expect(plan.argv).toEqual([
      "generate",
      "image",
      "--model=fal:fal-ai/flux/schnell",
      "--aspect-ratio=16:9",
    ]);
  });

  it("passes video inputs and lip-sync sources, and keeps Sume on its job route", async () => {
    const video = await planMultixRequest(
      {
        kind: "video",
        model: "runway:gen4_turbo",
        params: { image: "https://x.test/a.png", durationMs: 5000 },
        prompt: "waves",
      },
      undefined,
      context,
    );
    expect(video.argv).toEqual([
      "generate",
      "video",
      "--model=runway:gen4_turbo",
      "--image=https://x.test/a.png",
      "--duration=5",
    ]);
    const lipsync = await planMultixRequest(
      {
        kind: "video",
        model: "heygen:avatar-iv",
        params: { image: "https://x.test/a.png", audio: "https://x.test/a.wav" },
        prompt: "",
      },
      undefined,
      context,
    );
    expect(lipsync.argv.slice(0, 2)).toEqual(["generate", "lipsync"]);
    expect(lipsync.operand).toBeUndefined();
    const sume = await planMultixRequest({ kind: "image", params: {}, prompt: "a fox" }, undefined, context);
    expect(sume.mode).toBe("sume-job");
  });

  it("refuses a provider that does not serve the role", async () => {
    await expect(
      planMultixRequest(
        { kind: "video", model: "openai:sora-2", params: {}, prompt: "x" },
        undefined,
        context,
      ),
    ).rejects.toThrow(/not served/);
  });
});

describe("price ceilings of providers multix cannot price", () => {
  const context = { defaults: DEFAULT_MULTIX_MODELS, waitTimeoutMs: 900_000 };

  it("reserves the per-second ceiling for the stated length, or the default length", async () => {
    const stated = await planMultixRequest(
      { kind: "video", model: "runway:gen4.5", params: { durationMs: 5000 }, prompt: "waves" },
      undefined,
      context,
    );
    expect(stated.assumed).toMatchObject({ usdPerUnit: 0.4, unit: "second", defaultQuantity: 15 });
  });

  it("leaves a provider without a public price unpriced", async () => {
    const plan = await planMultixRequest(
      { kind: "image", model: "leonardo:some-model", params: {}, prompt: "a fox" },
      undefined,
      context,
    );
    expect(plan.assumed).toBeUndefined();
    expect(plan.priced).toBe(false);
  });
});

describe("multix cost policy for Sume jobs", () => {
  it("accepts the highest listed price for images and keeps videos on a proven ceiling", async () => {
    const image = await planMultixRequest(
      { kind: "image", model: "sume:nano-banana-2.1", params: { aspectRatio: "9:16" }, prompt: "a tea shop" },
      undefined,
      context,
    );
    expect(image.costPolicy).toBe("estimate");
    expect((await plan("sume:seedance-2-mini", { durationMs: 5000 })).costPolicy).toBeUndefined();
  });
});

describe("speech timings", () => {
  const speech = (model: string, params: Record<string, unknown>) =>
    planMultixRequest({ kind: "voice", model, params, prompt: "Hello there" }, undefined, context);

  it("asks ElevenLabs for timings and lets the other speech routes ignore the request", async () => {
    expect((await speech("elevenlabs:eleven_v3", { timestamps: true })).argv).toContain("--timestamps");
    expect((await speech("elevenlabs:eleven_v3", { timestamps: false })).argv).not.toContain("--timestamps");
    for (const model of ["fish:s1", "minimax:speech-02-hd", "openrouter:openai/gpt-4o-mini-tts"]) {
      expect((await speech(model, { timestamps: true })).argv).not.toContain("--timestamps");
    }
  });

  it("refuses a timings flag that is not a boolean", async () => {
    await expect(speech("fish:s1", { timestamps: "yes" })).rejects.toThrow(/params.timestamps/);
  });
});

describe("composed ElevenLabs music", () => {
  const music = (params: Record<string, unknown>, model = "elevenlabs:music_v1") =>
    planMultixRequest({ kind: "music", model, params, prompt: "  warm synth bed  " }, undefined, context);
  const sections = [
    { name: "intro", durationMs: 4000, styles: ["soft pads"] },
    { name: "drop", durationMs: 8000 },
  ];

  it("sends a composition plan file instead of a prompt and a length, billed for its sections", async () => {
    const plan = await music({ sections, negativeStyles: ["drums"] });
    expect(plan.argv).toEqual(["elevenlabs", "music", "--plan=composition-plan.json", "--model=music_v1"]);
    expect(plan.files).toHaveLength(1);
    expect(plan.files![0]!.name).toBe("composition-plan.json");
    expect(JSON.parse(plan.files![0]!.content)).toEqual({
      positive_global_styles: ["warm synth bed"],
      negative_global_styles: ["drums"],
      sections: [
        {
          section_name: "intro",
          positive_local_styles: ["soft pads"],
          negative_local_styles: [],
          duration_ms: 4000,
          lines: [],
        },
        {
          section_name: "drop",
          positive_local_styles: [],
          negative_local_styles: [],
          duration_ms: 8000,
          lines: [],
        },
      ],
    });
    expect(plan.assumed).toMatchObject({ unit: "second", defaultQuantity: 12 });
  });

  it("keeps the bed instrumental by default and accepts a matching stated length", async () => {
    const plan = await music({ sections, durationMs: 12_000 });
    expect(JSON.parse(plan.files![0]!.content).negative_global_styles).toEqual(["vocals"]);
  });

  it("keeps the prompt call without sections, and on MiniMax", async () => {
    const plain = await music({ durationMs: 5000 });
    expect(plain.argv).toContain("--music-length-ms=5000");
    expect(plain.files).toBeUndefined();
    const minimax = await music({ sections }, "minimax:music-2.0");
    expect(minimax.argv.slice(0, 3)).toEqual(["minimax", "generate-music", "--prompt=  warm synth bed  "]);
    expect(minimax.files).toBeUndefined();
  });

  it("refuses malformed sections before anything is paid", async () => {
    const bad: unknown[] = [
      [],
      "intro",
      Array.from({ length: 9 }, () => ({ name: "a", durationMs: 3000 })),
      [{ name: "", durationMs: 3000 }],
      [{ name: "x".repeat(41), durationMs: 3000 }],
      [{ name: "intro", durationMs: 2999 }],
      [{ name: "intro", durationMs: 3000.5 }],
      [{ name: "intro" }],
      [{ name: "intro", durationMs: 3000, styles: ["y".repeat(81)] }],
      [{ name: "intro", durationMs: 3000, styles: Array.from({ length: 9 }, () => "pads") }],
      Array.from({ length: 3 }, () => ({ name: "long", durationMs: 120_000 })),
    ];
    for (const value of bad) {
      await expect(music({ sections: value })).rejects.toMatchObject({ code: "VALIDATION" });
    }
    await expect(music({ sections, negativeStyles: [3] })).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("refuses sections that do not add up to the stated length", async () => {
    await expect(music({ sections, durationMs: 15_000 })).rejects.toThrow(/add up to params.durationMs/);
  });
});
