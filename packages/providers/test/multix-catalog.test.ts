import { describe, expect, it } from "vitest";
import { buildMultixCatalog, createMultixCatalogLoader } from "../src/multix-catalog.ts";
import type { MultixRunner } from "../src/multix-cli-runner.ts";
import { DEFAULT_MULTIX_MODELS } from "../src/multix-routes.ts";

const models = [
  { task: "speech", provider: "elevenlabs", default_model: "eleven_multilingual_v2", models: ["eleven_v3"] },
  { task: "speech", provider: "gemini", models: ["gemini-tts"] },
  { task: "speech", provider: "openrouter", models: ["fish-audio/drama-3"], any_model: true },
  { task: "music", provider: "minimax", models: ["music-2.5"] },
  { task: "video", provider: "gemini", models: ["veo-*"] },
];
const sume = {
  models: [
    { id: "nano-banana-pro", kind: "image", name: "Nano Banana Pro", modes: ["text-to-image"] },
    { id: "seedance-2.5", kind: "video", modes: ["text-to-video", "image-to-video"] },
    { id: "topaz-video", kind: "video", modes: ["video-to-video"] },
    { id: "remix", kind: "video", modes: ["motion-transfer"], capabilities: { routes: ["POST /x"] } },
    { id: "sync-lipsync-3", kind: "lipsync", modes: ["video-to-lipsync"] },
    { id: "veed-subtitles", kind: "captions" },
  ],
};

const ids = (list: { id: string }[]) => list.map((e) => e.id);

describe("buildMultixCatalog", () => {
  const catalog = buildMultixCatalog({ models, sume, defaults: DEFAULT_MULTIX_MODELS });

  it("groups Sume models by role and skips special routes and captions", () => {
    expect(ids(catalog.roles.image)).toEqual(["sume:nano-banana-2.1", "sume:nano-banana-pro"]);
    expect(catalog.roles.image[1]).toMatchObject({
      label: "Nano Banana Pro",
      capabilities: ["text-to-image"],
    });
    expect(ids(catalog.roles.video)).toEqual(["sume:seedance-2-mini", "sume:seedance-2.5"]);
    expect(ids(catalog.roles.videoUpscale)).toEqual(["sume:topaz-video"]);
    expect(ids(catalog.roles.lipsync)).toEqual(["sume:sync-lipsync-2", "sume:sync-lipsync-3"]);
  });

  it("keeps only the vendors a role runs on and drops wildcard ids", () => {
    expect(ids(catalog.roles.voice)).toEqual([
      "elevenlabs:eleven_multilingual_v2",
      "elevenlabs:eleven_v3",
      "openrouter:fish-audio/drama-3",
    ]);
    expect(ids(catalog.roles.music)).toEqual(["elevenlabs:music_v1", "minimax:music-2.5"]);
    expect(ids(catalog.roles.sfx)).toEqual(["elevenlabs:sound-effects"]);
  });

  it("marks vendors that take any model id", () => {
    expect(catalog.openVendors).toEqual(["atlas", "openrouter"]);
    expect(ids(catalog.roles.imageUpscale)).toEqual(["atlas:atlascloud/image-upscaler"]);
  });

  it("still lists the server defaults when multix returned nothing", () => {
    const empty = buildMultixCatalog({ defaults: DEFAULT_MULTIX_MODELS, models: "junk", sume: null });
    expect(ids(empty.roles.image)).toEqual([DEFAULT_MULTIX_MODELS.image]);
  });
});

describe("createMultixCatalogLoader", () => {
  const envelope = (data: unknown) => `${JSON.stringify({ schema: "multix.result/v1", ok: true, data })}\n`;

  it("runs the free catalogue commands once per TTL and retries after a failure", async () => {
    const calls: string[] = [];
    let fail = true;
    const runner: MultixRunner = async (argv) => {
      calls.push(argv.join(" "));
      if (fail) return { exitCode: 1, stdout: "" };
      return { exitCode: 0, stdout: envelope(argv[0] === "sume" ? sume : models) };
    };
    let clock = 0;
    const load = createMultixCatalogLoader({
      bin: "multix",
      defaults: DEFAULT_MULTIX_MODELS,
      runner,
      env: {},
      ttlMs: 1000,
      now: () => clock,
    });
    expect((await load()).errors).toHaveLength(2);
    fail = false;
    const first = await load();
    expect(first.errors).toEqual([]);
    expect(ids(first.roles.videoUpscale)).toEqual(["sume:topaz-video"]);
    expect(await load()).toBe(first);
    expect(calls).toEqual(["models --json", "sume models --json", "models --json", "sume models --json"]);
    clock = 1000;
    await load();
    expect(calls).toHaveLength(6);
  });

  it("serves only the defaults when Multix is not installed", async () => {
    const catalog = await createMultixCatalogLoader({ bin: undefined, defaults: DEFAULT_MULTIX_MODELS })();
    expect(catalog.errors).toEqual(["Multix is not installed"]);
  });
});
