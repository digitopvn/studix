import type { MediaGenerationRequest, MediaKind } from "@studix/core";
import { StudixError } from "@studix/shared";
import type { MediaBillingUnit } from "./media-price-book.ts";
import { type MediaInput, numberParam, resolveMediaInput, stringParam } from "./media-request-guards.ts";
import {
  DEFAULT_GENERATED_VIDEO_SECONDS,
  type GenerateTask,
  generatePriceCeiling,
} from "./multix-generate-prices.ts";
import { MULTIX_KEY_NAMES } from "./multix-key-slots.ts";

/**
 * Providers `multix generate` runs image, video, lip-sync and upscale on (multix's generate adapters). Studix
 * drives them all through that one command, so a provider multix adds needs only its id here.
 */
export const GENERATE_VENDORS = [
  "gemini",
  "minimax",
  "openai",
  "openrouter",
  "leonardo",
  "byteplus",
  "cloudflare",
  "fal",
  "atlas",
  "replicate",
  "runway",
  "heygen",
  "topview",
] as const;

/** Upstream routes Studix drives through multix. Sume media keeps its own job route; the rest run on generate. */
export const MULTIX_VENDORS = ["sume", ...GENERATE_VENDORS, "elevenlabs", "fish"] as const;
export type MultixVendor = (typeof MULTIX_VENDORS)[number];

/** The key `multix check` must report for a vendor before its kinds are advertised (from multix's own list). */
export const MULTIX_VENDOR_KEYS: Readonly<Record<MultixVendor, string>> = Object.fromEntries(
  MULTIX_VENDORS.map((vendor) => {
    const keyName = MULTIX_KEY_NAMES[vendor];
    if (!keyName) throw new Error(`multix lists no key for ${vendor}; regenerate with pnpm multix:keys`);
    return [vendor, keyName];
  }),
) as Record<MultixVendor, string>;

/** A media role is a kind refined by its inputs (lip-sync is video with audio; upscale splits by input). */
export type MultixRole =
  | "image"
  | "video"
  | "lipsync"
  | "voice"
  | "music"
  | "sfx"
  | "imageUpscale"
  | "videoUpscale";

export const MULTIX_ROLE_VENDORS: Readonly<Record<MultixRole, readonly MultixVendor[]>> = {
  image: ["sume", ...GENERATE_VENDORS.filter((v) => v !== "heygen")],
  video: ["sume", ...GENERATE_VENDORS.filter((v) => v !== "openai")],
  lipsync: ["sume", "heygen"],
  videoUpscale: ["sume"],
  imageUpscale: ["atlas", "leonardo"],
  voice: ["elevenlabs", "fish", "minimax", "openrouter"],
  music: ["elevenlabs", "minimax"],
  sfx: ["elevenlabs"],
};

/**
 * Built-in defaults, each overridable through config (MULTIX_<ROLE>_MODEL). They live here, in the
 * adapter, so workflow code never names a model.
 */
export const DEFAULT_MULTIX_MODELS: Readonly<Record<MultixRole, string>> = {
  image: "sume:nano-banana-2.1",
  video: "sume:seedance-2-mini",
  lipsync: "sume:sync-lipsync-2",
  videoUpscale: "sume:topaz-video",
  imageUpscale: "atlas:atlascloud/image-upscaler",
  voice: "elevenlabs:eleven_multilingual_v2",
  music: "elevenlabs:music_v1",
  sfx: "elevenlabs:sound-effects",
};

export type MultixModelDefaults = Readonly<Record<MultixRole, string>>;

export interface QualifiedModel {
  vendor: MultixVendor;
  model: string;
  /** "<vendor>:<model>", the id results and capabilities use. */
  id: string;
}

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;

/** Parse "<vendor>:<model>" (or a bare model, which takes the role's default vendor). */
export function parseQualifiedModel(
  value: string,
  role: MultixRole,
  defaults: MultixModelDefaults,
): QualifiedModel {
  const allowed = MULTIX_ROLE_VENDORS[role];
  const sep = value.indexOf(":");
  const vendor =
    sep === -1
      ? parseQualifiedModel(defaults[role], role, DEFAULT_MULTIX_MODELS).vendor
      : value.slice(0, sep);
  const model = sep === -1 ? value : value.slice(sep + 1);
  if (!(allowed as readonly string[]).includes(vendor)) {
    throw new StudixError(
      "VALIDATION",
      `Model "${value}" is not served by ${allowed.join(" or ")} for ${role}`,
      {
        details: { role, allowedVendors: allowed },
      },
    );
  }
  if (!MODEL_ID.test(model)) throw new StudixError("VALIDATION", `Invalid model id "${value}"`);
  return { vendor: vendor as MultixVendor, model, id: `${vendor}:${model}` };
}

export function roleFor(kind: MediaKind, params: Record<string, unknown>): MultixRole {
  switch (kind) {
    case "image":
      return "image";
    case "video":
      return params.audio !== undefined ? "lipsync" : "video";
    case "voice":
      return "voice";
    case "music":
      return "music";
    case "sfx":
      return "sfx";
    case "upscale":
      if (params.video !== undefined && params.image !== undefined) {
        throw new StudixError("VALIDATION", "upscale takes params.image or params.video, not both");
      }
      if (params.video !== undefined) return "videoUpscale";
      if (params.image !== undefined) return "imageUpscale";
      throw new StudixError("VALIDATION", "upscale needs params.image or params.video");
    case "audio":
      throw new StudixError(
        "UNAVAILABLE",
        "Multix serves audio as voice, music or sfx; pick one of those kinds",
        {
          retryable: false,
        },
      );
  }
}

/**
 * Prices Studix assumes for routes multix cannot price before the call. They only bound a single call;
 * batches on these models still run the probe first (see runMediaBatchWithProbe).
 */
export interface AssumedPrice {
  usdPerUnit: number;
  unit: MediaBillingUnit;
  /** Quantity to bill when the request does not state one. */
  defaultQuantity: number;
  source: string;
}

export function assumedPrice(role: MultixRole, model: QualifiedModel): AssumedPrice | undefined {
  const task = generateTask(role, model);
  if (task) {
    const ceiling = generatePriceCeiling(model.vendor, task);
    if (!ceiling) return undefined;
    return {
      usdPerUnit: ceiling.usdPerUnit,
      unit: ceiling.unit,
      defaultQuantity: ceiling.unit === "second" ? DEFAULT_GENERATED_VIDEO_SECONDS : 1,
      source: ceiling.source,
    };
  }
  if (role === "sfx" && model.vendor === "elevenlabs") {
    return {
      usdPerUnit: 0.01,
      unit: "second",
      defaultQuantity: 30,
      source: "source audit: SFX up to $0.01/s",
    };
  }
  if (role === "music" && model.vendor === "elevenlabs") {
    return { usdPerUnit: 0.015, unit: "second", defaultQuantity: 30, source: "assumed ceiling" };
  }
  if (role === "music" && model.vendor === "minimax") {
    return { usdPerUnit: 0.25, unit: "call", defaultQuantity: 1, source: "assumed ceiling" };
  }
  if (role === "voice" && model.vendor === "minimax") {
    return { usdPerUnit: 0.0001, unit: "character", defaultQuantity: 1, source: "assumed ceiling" };
  }
  if (role === "imageUpscale" && model.id === "atlas:atlascloud/image-upscaler") {
    return {
      usdPerUnit: 0.01,
      unit: "image",
      defaultQuantity: 1,
      source: "Atlas Cloud model list 2026-10-31",
    };
  }
  return undefined;
}

export type MultixPlanMode = "sume-job" | "atlas-job" | "sync";

/** How one request runs through multix. argv never includes --json or run-specific flags. */
export interface MultixPlan {
  role: MultixRole;
  model: QualifiedModel;
  mode: MultixPlanMode;
  argv: string[];
  /** Positional prompt, passed after "--" so it can never be read as a flag. */
  operand?: string;
  /** multix can price argv with --estimate. */
  priced: boolean;
  /**
   * How multix applies `--max-cost`: "strict" (default) needs a proven ceiling, "estimate" accepts the
   * estimated high end, for models billed by an output whose length the model decides.
   */
  costPolicy?: "strict" | "estimate";
  assumed?: AssumedPrice;
  /** Atlas: request fields, and local files to upload into `uploads` fields before submitting. */
  atlas?: { modelId: string; fields: Record<string, unknown>; uploads: { field: string; path: string }[] };
  /** Sync runs: extension of the file multix writes. */
  outputExt?: string;
  /**
   * Sync runs: files the provider writes into the run's directory (the child's working directory) before
   * the run. argv names them by their bare `name`, which multix resolves against that directory.
   */
  files?: MultixPlanFile[];
  waitTimeoutMs: number;
}

/** A file a run reads, e.g. an ElevenLabs composition plan. `name` is a bare file name. */
export interface MultixPlanFile {
  name: string;
  content: string;
}

const ASPECT = /^(\d{1,2}:\d{1,2}|auto|adaptive)$/;
const RESOLUTION = /^(\d{3,4}p|[1-8][Kk])$/;
const TOKEN = /^[A-Za-z0-9_.-]{1,128}$/;
const LANGUAGE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;
const IMAGE_FORMAT = /^(png|jpeg|jpg|webp)$/;
const MAX_DURATION_MS = 600_000;

const flag = (name: string, value: string | number | undefined): string[] =>
  value === undefined ? [] : [`--${name}=${value}`];
const inputFlag = (name: string, input: MediaInput | undefined): string[] =>
  input ? [`--${name}=${input.kind === "url" ? input.url : input.path}`] : [];

/**
 * Resolution Studix asks for when a request names none, by model. Seedance 2.5 bills per output second by
 * resolution and Sume's own default is far above what a draft or review cut needs, so Studix pins it to
 * 480p (about $0.10/s); pass `params.resolution` to choose another.
 */
export const DEFAULT_VIDEO_RESOLUTIONS: Readonly<Record<string, string>> = { "sume:seedance-2.5": "480p" };

function videoResolution(params: Record<string, unknown>, model: QualifiedModel): string | undefined {
  return stringParam(params, "resolution", RESOLUTION) ?? DEFAULT_VIDEO_RESOLUTIONS[model.id];
}

function seconds(params: Record<string, unknown>): number | undefined {
  const ms = numberParam(params, "durationMs", 1, MAX_DURATION_MS);
  return ms === undefined ? undefined : Math.ceil(ms / 1000);
}

function boolParam(params: Record<string, unknown>, name: string): boolean | undefined {
  const value = params[name];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new StudixError("VALIDATION", `params.${name} must be a boolean`);
  return value;
}

export interface PlanContext {
  defaults: MultixModelDefaults;
  voiceRoutes?: VoiceLanguageRoutes;
  waitTimeoutMs: number;
}

const codes = (list: string) => list.split(" ");
/** Languages ElevenLabs multilingual v2 speaks (source: ElevenLabs model docs, as listed by multix 1.26). */
const ELEVENLABS_V2_LANGUAGES = codes(
  "en ja zh de hi fr ko pt it es id nl tr fil pl sv bg ro ar cs el fi hr ms sk da ta uk ru",
);
/**
 * What each ElevenLabs speech model speaks, and whether it takes an explicit `language_code`. Multilingual
 * v2 detects the language from the text and rejects `language_code`; the v2.5 and v3 models take it.
 */
const ELEVENLABS_SPEECH: Readonly<Record<string, { languages?: readonly string[]; languageCode: boolean }>> =
  {
    eleven_multilingual_v2: { languages: ELEVENLABS_V2_LANGUAGES, languageCode: false },
    eleven_flash_v2: { languages: ["en"], languageCode: false },
    eleven_turbo_v2: { languages: ["en"], languageCode: false },
    eleven_flash_v2_5: { languages: [...ELEVENLABS_V2_LANGUAGES, ...codes("hu no vi")], languageCode: true },
    eleven_turbo_v2_5: { languages: [...ELEVENLABS_V2_LANGUAGES, ...codes("hu no vi")], languageCode: true },
    // Seventy-odd languages; Studix leaves the check to ElevenLabs.
    eleven_v3: { languageCode: true },
    eleven_v3_conversational: { languageCode: true },
  };
/** The speech model a voice request moves to when the default one does not speak its language. */
export const ELEVENLABS_WIDE_VOICE_MODEL = "elevenlabs:eleven_v3";

/** Primary subtag of a BCP 47 language, lower-case ("vi-VN" -> "vi"); undefined when there is none. */
function primaryLanguage(params: Record<string, unknown>): string | undefined {
  return stringParam(params, "language", LANGUAGE)?.split("-")[0]?.toLowerCase();
}

/** False only when the model is known not to speak `language`. */
function speaks(model: QualifiedModel, language: string): boolean {
  if (model.vendor !== "elevenlabs") return true;
  const languages = ELEVENLABS_SPEECH[model.model]?.languages;
  return languages === undefined || languages.includes(language);
}

/** The speech model one language is spoken with, and the voice used when a request names none. */
export interface VoiceRoute {
  model: QualifiedModel;
  voice?: string;
}
/** Speech routes by primary language subtag ("vi"), from config; a language without one takes the default. */
export type VoiceLanguageRoutes = Readonly<Record<string, VoiceRoute>>;

const ROUTE_LANGUAGE = /^[a-z]{2,3}$/;

/**
 * Parse `MULTIX_VOICE_LANGUAGE_MODELS`: comma-separated `<language>=<vendor>:<model>[@<voice>]`, e.g.
 * `vi=openrouter:fish-audio/drama-3` or `vi=openrouter:google/gemini-3.8-flash-tts@Sulafat`. Throws
 * VALIDATION on a malformed entry, a vendor that does not serve speech or a language named twice, so a
 * bad setting fails at startup instead of on a paid call.
 */
export function parseVoiceLanguageRoutes(
  value: string | undefined,
  defaults: MultixModelDefaults,
): VoiceLanguageRoutes {
  const routes: Record<string, VoiceRoute> = {};
  for (const entry of (value ?? "").split(",").map((e) => e.trim())) {
    if (entry === "") continue;
    const eq = entry.indexOf("=");
    const language = entry.slice(0, Math.max(0, eq)).trim().toLowerCase();
    const target = entry.slice(eq + 1).trim();
    const at = target.lastIndexOf("@");
    const model = at === -1 ? target : target.slice(0, at);
    const voice = at === -1 ? undefined : target.slice(at + 1);
    if (eq === -1 || !ROUTE_LANGUAGE.test(language) || (voice !== undefined && !TOKEN.test(voice))) {
      throw new StudixError(
        "VALIDATION",
        `Voice language route "${entry}" must read <language>=<vendor>:<model>[@<voice>]`,
        { retryable: false },
      );
    }
    if (routes[language]) {
      throw new StudixError("VALIDATION", `Voice language "${language}" is routed twice`, {
        retryable: false,
      });
    }
    routes[language] = {
      model: parseQualifiedModel(model, "voice", defaults),
      ...(voice !== undefined ? { voice } : {}),
    };
  }
  return routes;
}

/** Resolve the role and model of a request without touching its inputs (used for grouping and pricing). */
export function resolveMultixModel(
  request: Pick<MediaGenerationRequest, "kind" | "model" | "params">,
  defaults: MultixModelDefaults,
  voiceRoutes: VoiceLanguageRoutes = {},
): { role: MultixRole; model: QualifiedModel; voice?: string } {
  const params = request.params ?? {};
  const role = roleFor(request.kind, params);
  const language = role === "voice" ? primaryLanguage(params) : undefined;
  // A configured route for the language wins over the role default; a model the request names wins over both.
  const route = request.model === undefined && language !== undefined ? voiceRoutes[language] : undefined;
  if (route)
    return { role, model: route.model, ...(route.voice !== undefined ? { voice: route.voice } : {}) };
  const model = parseQualifiedModel(request.model ?? defaults[role], role, defaults);
  if (language === undefined || speaks(model, language)) return { role, model };
  // A model the request named is the caller's choice: refuse it before anything is paid.
  if (request.model !== undefined) {
    throw new StudixError("VALIDATION", `${model.id} does not speak "${language}"`, {
      retryable: false,
      details: { model: model.id, language, suggestedModel: ELEVENLABS_WIDE_VOICE_MODEL },
    });
  }
  // The role default cannot say it: use the widest ElevenLabs model instead of a call that is refused.
  return { role, model: parseQualifiedModel(ELEVENLABS_WIDE_VOICE_MODEL, role, defaults) };
}

/** Build the multix invocation for a request. Validates every value that reaches argv. */
export async function planMultixRequest(
  request: Pick<MediaGenerationRequest, "kind" | "model" | "params" | "prompt">,
  workDir: string | undefined,
  context: PlanContext,
): Promise<MultixPlan> {
  const params = request.params ?? {};
  const {
    role,
    model,
    voice: routeVoice,
  } = resolveMultixModel(request, context.defaults, context.voiceRoutes);
  const input = async (name: string) =>
    workDir === undefined ? estimateInput(params, name) : resolveMediaInput(params, name, workDir);
  const base = { role, model, assumed: assumedPrice(role, model) };
  const wait = (ms: number) => Math.min(ms, context.waitTimeoutMs);

  const generated = generateTask(role, model);
  if (generated) {
    const image = await input("image");
    const audio = boolParam(params, "generateAudio");
    const video = role === "lipsync" ? await input("video") : undefined;
    if (role === "lipsync" && !video && !image)
      throw new StudixError("VALIDATION", "lip-sync needs params.video or params.image");
    return {
      ...base,
      mode: "sync",
      // multix cannot price these yet (mrgoonie/multix-cli#581): the job reserves the ceiling instead.
      priced: false,
      outputExt: generated === "video" || generated === "lipsync" ? ".mp4" : ".png",
      waitTimeoutMs: wait(generated === "image" || generated === "upscale" ? 300_000 : 900_000),
      argv: [
        "generate",
        generated,
        `--model=${model.id}`,
        ...inputFlag("image", image),
        ...inputFlag("end-image", generated === "video" ? await input("endImage") : undefined),
        ...inputFlag("video", video),
        ...inputFlag("audio", role === "lipsync" ? await input("audio") : undefined),
        ...flag("aspect-ratio", stringParam(params, "aspectRatio", ASPECT)),
        ...flag("resolution", stringParam(params, "resolution", RESOLUTION)),
        ...(generated === "video" ? flag("duration", seconds(params)) : []),
        ...(audio === undefined || generated !== "video"
          ? []
          : [audio ? "--generate-audio" : "--no-generate-audio"]),
      ],
      ...(generated === "image" || generated === "video" ? { operand: request.prompt } : {}),
    };
  }

  switch (role) {
    case "image": {
      const image = await input("image");
      return {
        ...base,
        mode: "sume-job",
        priced: true,
        // Sume prices an image per option (resolution, quality). When the request leaves an option to the
        // model, multix bounds the run by the highest listed price and calls that an estimate; it is still a
        // ceiling for the images asked for, so it is accepted against the cap.
        costPolicy: "estimate",
        waitTimeoutMs: wait(300_000),
        argv: [
          "sume",
          "image",
          `--model=${model.model}`,
          ...inputFlag("image", image),
          ...flag("aspect-ratio", stringParam(params, "aspectRatio", ASPECT)),
          ...flag("resolution", stringParam(params, "resolution", RESOLUTION)),
          ...flag("quality", stringParam(params, "quality", TOKEN)),
          ...flag("num-images", numberParam(params, "numImages", 1, 4, true)),
          ...flag("output-format", stringParam(params, "outputFormat", IMAGE_FORMAT)),
        ],
        operand: request.prompt,
      };
    }
    case "video": {
      const audio = boolParam(params, "generateAudio");
      return {
        ...base,
        mode: "sume-job",
        priced: true,
        waitTimeoutMs: wait(900_000),
        argv: [
          "sume",
          "video",
          `--model=${model.model}`,
          ...inputFlag("image", await input("image")),
          ...inputFlag("end-image", await input("endImage")),
          ...flag("duration", seconds(params)),
          ...flag("resolution", videoResolution(params, model)),
          ...flag("aspect-ratio", stringParam(params, "aspectRatio", ASPECT)),
          ...(audio === undefined ? [] : [audio ? "--generate-audio" : "--no-generate-audio"]),
        ],
        operand: request.prompt,
      };
    }
    case "lipsync": {
      const video = await input("video");
      const image = await input("image");
      if (!video && !image)
        throw new StudixError("VALIDATION", "lip-sync needs params.video or params.image");
      return {
        ...base,
        mode: "sume-job",
        priced: true,
        waitTimeoutMs: wait(900_000),
        argv: [
          "sume",
          "video",
          `--model=${model.model}`,
          ...inputFlag("video", video),
          ...inputFlag("image", video ? undefined : image),
          ...inputFlag("audio", await input("audio")),
          ...flag("duration", seconds(params)),
          ...flag("resolution", videoResolution(params, model)),
        ],
      };
    }
    case "videoUpscale":
      return {
        ...base,
        mode: "sume-job",
        priced: true,
        waitTimeoutMs: wait(900_000),
        argv: [
          "sume",
          "video",
          `--model=${model.model}`,
          ...inputFlag("video", await input("video")),
          ...flag("duration", seconds(params)),
          ...flag("resolution", videoResolution(params, model)),
        ],
      };
    case "imageUpscale": {
      const image = await input("image");
      const fields: Record<string, unknown> = {
        outscale: numberParam(params, "scale", 1, 4) ?? 2,
        output_format: stringParam(params, "outputFormat", IMAGE_FORMAT) ?? "png",
      };
      const uploads: { field: string; path: string }[] = [];
      if (image?.kind === "url") fields.image = image.url;
      if (image?.kind === "file") uploads.push({ field: "image", path: image.path });
      return {
        ...base,
        mode: "atlas-job",
        priced: false,
        waitTimeoutMs: wait(300_000),
        argv: [],
        atlas: { modelId: model.model, fields, uploads },
      };
    }
    case "voice": {
      const openrouter = model.vendor === "openrouter";
      return {
        ...base,
        mode: "sync",
        priced: model.vendor !== "minimax",
        // OpenRouter bills some speech models by output audio, which multix can estimate but not prove.
        ...(openrouter ? { costPolicy: "estimate" as const } : {}),
        outputExt: openrouter && PCM_ONLY_SPEECH.test(model.model) ? ".wav" : ".mp3",
        waitTimeoutMs: wait(300_000),
        argv: voiceArgv(model, request.prompt, params, routeVoice),
      };
    }
    case "music": {
      const music = musicPlan(model, request.prompt, params);
      return {
        ...base,
        // A composition plan is billed for the length of its sections, stated or not.
        ...(music.totalMs !== undefined && base.assumed
          ? { assumed: { ...base.assumed, defaultQuantity: Math.ceil(music.totalMs / 1000) } }
          : {}),
        mode: "sync",
        priced: false,
        outputExt: ".mp3",
        waitTimeoutMs: wait(600_000),
        argv: music.argv,
        ...(music.files ? { files: music.files } : {}),
      };
    }
    case "sfx": {
      const ms = numberParam(params, "durationMs", 500, 30_000);
      return {
        ...base,
        mode: "sync",
        priced: false,
        outputExt: ".mp3",
        waitTimeoutMs: wait(300_000),
        argv: [
          "elevenlabs",
          "sfx",
          `--text=${request.prompt}`,
          ...flag("duration-seconds", ms === undefined ? undefined : ms / 1000),
          ...(boolParam(params, "loop") ? ["--loop"] : []),
        ],
      };
    }
  }
}

/** The `multix generate` task a role runs as on a non-Sume provider, if it runs there at all. */
function generateTask(role: MultixRole, model: QualifiedModel): GenerateTask | undefined {
  if (model.vendor === "sume") return undefined;
  if (role === "image" || role === "video" || role === "lipsync") return role;
  if (role === "imageUpscale" && model.vendor === "leonardo") return "upscale";
  return undefined;
}

/** OpenRouter speech models that return raw PCM only; multix wraps it in a WAV header (per multix 1.26). */
const PCM_ONLY_SPEECH = /^(google|heygen)\//;
const MAX_INSTRUCTIONS = 1000;

/**
 * Delivery direction for a speech model (tone, pace, emotion), as free text. Only routes that take
 * direction (OpenRouter's Gemini and Fish Audio speech) receive it; the others read the line plainly.
 */
function instructionsParam(params: Record<string, unknown>): string | undefined {
  const value = params.instructions;
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value.length > MAX_INSTRUCTIONS ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused.
    /[\u0000-\u0008\u000b-\u001f\u007f]/.test(value)
  ) {
    throw new StudixError(
      "VALIDATION",
      `params.instructions must be plain text of at most ${MAX_INSTRUCTIONS} characters`,
    );
  }
  return value.trim();
}

function voiceArgv(
  model: QualifiedModel,
  prompt: string,
  params: Record<string, unknown>,
  routeVoice: string | undefined,
): string[] {
  const voice = stringParam(params, "voice", TOKEN) ?? routeVoice;
  const language = stringParam(params, "language", LANGUAGE);
  const instructions = instructionsParam(params);
  // Every route accepts the flag, so a caller can ask for timings without knowing the route; only
  // ElevenLabs reports them.
  const timestamps = boolParam(params, "timestamps") === true;
  switch (model.vendor) {
    case "openrouter":
      // The model reads the language from the text; OpenRouter has no language field for speech.
      return [
        "openrouter",
        "tts",
        `--text=${prompt}`,
        `--model=${model.model}`,
        `--format=${PCM_ONLY_SPEECH.test(model.model) ? "wav" : "mp3"}`,
        ...flag("voice", voice),
        ...flag("instructions", instructions),
      ];
    case "elevenlabs":
      return [
        "elevenlabs",
        "tts",
        `--text=${prompt}`,
        `--model=${model.model}`,
        ...flag("voice", voice),
        // Models without `language_code` refuse it; they detect the language from the text.
        ...flag(
          "language-code",
          ELEVENLABS_SPEECH[model.model]?.languageCode === false ? undefined : language,
        ),
        ...flag("seed", numberParam(params, "seed", 0, 4_294_967_295, true)),
        // Saves the character timings next to the audio as `<audio>.timestamps.json`.
        ...(timestamps ? ["--timestamps"] : []),
      ];
    case "fish":
      return [
        "fish",
        "tts",
        `--text=${prompt}`,
        `--model=${model.model}`,
        "--format=mp3",
        ...flag("voice", voice),
        ...flag("language", language),
      ];
    default:
      return [
        "minimax",
        "generate-speech",
        `--text=${prompt}`,
        `--model=${model.model}`,
        "--output-format=mp3",
        ...flag("voice", voice),
      ];
  }
}

const DEFAULT_MUSIC_MS = 30_000;
const MAX_MUSIC_MS = 300_000;
const MAX_SECTIONS = 8;
const MAX_STYLES = 8;
const MAX_STYLE_LENGTH = 80;
const MAX_SECTION_NAME = 40;
const MAX_GLOBAL_STYLE_LENGTH = 400;
/** The name argv gives the composition plan file the provider writes into the run's directory. */
export const COMPOSITION_PLAN_FILE = "composition-plan.json";

/** One section of a composed music bed, as a request states it. */
export interface MusicSection {
  name: string;
  durationMs: number;
  styles?: string[];
}

/**
 * The ElevenLabs composition plan (`composition_plan` of the music API) for a request with
 * `params.sections`: the prompt is the global style, each section keeps its own length and styles.
 */
export interface ElevenLabsCompositionPlan {
  positive_global_styles: string[];
  negative_global_styles: string[];
  sections: {
    section_name: string;
    positive_local_styles: string[];
    negative_local_styles: string[];
    duration_ms: number;
    lines: string[];
  }[];
}

const isPlainText = (value: unknown, max: number): value is string =>
  typeof value === "string" &&
  value.trim() !== "" &&
  value.length <= max &&
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused.
  !/[\u0000-\u001f\u007f]/.test(value);

/** An optional list of at most MAX_STYLES short plain-text styles. */
function stylesParam(value: unknown, name: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length > MAX_STYLES ||
    !value.every((style) => isPlainText(style, MAX_STYLE_LENGTH))
  ) {
    throw new StudixError(
      "VALIDATION",
      `${name} must be at most ${MAX_STYLES} styles of 1..${MAX_STYLE_LENGTH} characters`,
    );
  }
  return value.map((style: string) => style.trim());
}

/**
 * `params.sections`: 1..8 sections, each a name of 1..40 characters, an integer `durationMs` in
 * 3000..120000 and optional `styles`. Their lengths add up to at most five minutes, and to
 * `params.durationMs` when the request states one.
 */
function sectionsParam(params: Record<string, unknown>): MusicSection[] | undefined {
  const value = params.sections;
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SECTIONS) {
    throw new StudixError("VALIDATION", `params.sections must be a list of 1..${MAX_SECTIONS} sections`);
  }
  const sections = value.map((raw: unknown, i): MusicSection => {
    const at = `params.sections[${i}]`;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new StudixError("VALIDATION", `${at} must be an object`);
    }
    const section = raw as Record<string, unknown>;
    if (!isPlainText(section.name, MAX_SECTION_NAME)) {
      throw new StudixError(
        "VALIDATION",
        `${at}.name must be plain text of 1..${MAX_SECTION_NAME} characters`,
      );
    }
    const durationMs = numberParam(section, "durationMs", 3_000, 120_000, true);
    if (durationMs === undefined) {
      throw new StudixError("VALIDATION", `${at}.durationMs must be an integer in 3000..120000`);
    }
    const styles = stylesParam(section.styles, `${at}.styles`);
    return { name: section.name.trim(), durationMs, ...(styles ? { styles } : {}) };
  });
  const total = sections.reduce((sum, s) => sum + s.durationMs, 0);
  if (total > MAX_MUSIC_MS) {
    throw new StudixError("VALIDATION", `params.sections must add up to at most ${MAX_MUSIC_MS} ms`, {
      details: { totalMs: total },
    });
  }
  const stated = params.durationMs;
  if (stated !== undefined && stated !== total) {
    throw new StudixError("VALIDATION", "params.sections must add up to params.durationMs", {
      details: { totalMs: total, durationMs: stated },
    });
  }
  return sections;
}

/** The composition plan for a sectioned ElevenLabs music request. */
export function compositionPlan(
  prompt: string,
  sections: readonly MusicSection[],
  negativeStyles: readonly string[] | undefined,
): ElevenLabsCompositionPlan {
  const global = prompt.trim().slice(0, MAX_GLOBAL_STYLE_LENGTH);
  return {
    positive_global_styles: global === "" ? [] : [global],
    // A bed sits under a voice-over: keep it instrumental unless the request says otherwise.
    negative_global_styles: [...(negativeStyles ?? ["vocals"])],
    sections: sections.map((s) => ({
      section_name: s.name,
      positive_local_styles: [...(s.styles ?? [])],
      negative_local_styles: [],
      duration_ms: s.durationMs,
      lines: [],
    })),
  };
}

/**
 * The music call. MiniMax takes the prompt (and lyrics) only. ElevenLabs takes the prompt and a stated
 * length, or, with `params.sections`, a composition plan file in place of both; `totalMs` is then the
 * length the plan bills for.
 */
function musicPlan(
  model: QualifiedModel,
  prompt: string,
  params: Record<string, unknown>,
): { argv: string[]; files?: MultixPlanFile[]; totalMs?: number } {
  if (model.vendor === "minimax") {
    const lyrics = params.lyrics;
    if (lyrics !== undefined && (typeof lyrics !== "string" || lyrics.length > 4000)) {
      throw new StudixError("VALIDATION", "params.lyrics must be a string of at most 4000 characters");
    }
    return {
      argv: [
        "minimax",
        "generate-music",
        `--prompt=${prompt}`,
        `--model=${model.model}`,
        "--output-format=mp3",
        ...flag("lyrics", lyrics as string | undefined),
      ],
    };
  }
  // A stated length keeps the price bounded; the model would otherwise choose one.
  const ms = numberParam(params, "durationMs", 3_000, MAX_MUSIC_MS, true) ?? DEFAULT_MUSIC_MS;
  const sections = sectionsParam(params);
  const negativeStyles = stylesParam(params.negativeStyles, "params.negativeStyles");
  if (!sections) {
    return {
      argv: [
        "elevenlabs",
        "music",
        `--prompt=${prompt}`,
        `--model=${model.model}`,
        `--music-length-ms=${ms}`,
      ],
    };
  }
  const plan = compositionPlan(prompt, sections, negativeStyles);
  return {
    // multix sends the plan instead of a prompt and a length; the sections carry the length.
    argv: ["elevenlabs", "music", `--plan=${COMPOSITION_PLAN_FILE}`, `--model=${model.model}`],
    files: [{ name: COMPOSITION_PLAN_FILE, content: `${JSON.stringify(plan, null, 2)}\n` }],
    totalMs: sections.reduce((sum, s) => sum + s.durationMs, 0),
  };
}

/** For estimates no file is read: local inputs are checked for shape only and stand in as their path. */
function estimateInput(params: Record<string, unknown>, name: string): MediaInput | undefined {
  const value = params[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "" || /[\r\n\0]/.test(value)) {
    throw new StudixError("VALIDATION", `params.${name} must be a file path or an https URL`);
  }
  return /^https:\/\//i.test(value) ? { kind: "url", url: value } : { kind: "file", path: value };
}
