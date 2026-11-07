/**
 * Price ceilings for the providers Studix runs through `multix generate`, which cannot price a request
 * before it runs (mrgoonie/multix-cli#581). Each ceiling is rounded up from the provider's public list
 * price and covers its costly common models, so it bounds a call rather than predicting it: the job
 * reserves the ceiling and books the receipt multix reports afterwards. A provider and task without a
 * verified public price has no row and stays unrunnable ("No trusted price").
 */
export type GenerateTask = "image" | "video" | "lipsync" | "upscale";

export interface GeneratePriceCeiling {
  usdPerUnit: number;
  unit: "image" | "second";
  /** Public price list the ceiling is rounded up from. */
  source: string;
}

export const GENERATE_PRICE_CEILINGS: Readonly<
  Record<string, Readonly<Partial<Record<GenerateTask, GeneratePriceCeiling>>>>
> = {
  // Checked 2026-11-07. Leonardo and HeyGen publish prices only behind a login: no row, not runnable.
  gemini: {
    image: { usdPerUnit: 0.24, unit: "image", source: "https://ai.google.dev/gemini-api/docs/pricing" },
    video: { usdPerUnit: 0.31, unit: "second", source: "https://ai.google.dev/gemini-api/docs/pricing" },
  },
  openai: {
    image: { usdPerUnit: 0.41, unit: "image", source: "https://developers.openai.com/api/docs/pricing" },
  },
  minimax: {
    image: { usdPerUnit: 0.004, unit: "image", source: "https://platform.minimax.io/docs/pricing/overview" },
    video: { usdPerUnit: 0.15, unit: "second", source: "https://platform.minimax.io/docs/pricing/overview" },
  },
  openrouter: {
    image: {
      usdPerUnit: 0.41,
      unit: "image",
      source: "https://openrouter.ai/api/v1/models?output_modalities=image",
    },
    video: { usdPerUnit: 0.78, unit: "second", source: "https://openrouter.ai/api/v1/videos/models" },
  },
  byteplus: {
    image: { usdPerUnit: 0.09, unit: "image", source: "https://docs.byteplus.com/en/docs/ModelArk/1544106" },
    video: { usdPerUnit: 0.8, unit: "second", source: "https://docs.byteplus.com/en/docs/ModelArk/1544106" },
  },
  cloudflare: {
    image: {
      usdPerUnit: 0.002,
      unit: "image",
      source: "https://developers.cloudflare.com/workers-ai/platform/pricing/",
    },
    // Served through Cloudflare's AI Gateway from Replicate, which publishes the price.
    video: { usdPerUnit: 0.04, unit: "second", source: "https://replicate.com/prunaai/p-video" },
  },
  fal: {
    image: { usdPerUnit: 0.41, unit: "image", source: "https://fal.ai/models/openai/gpt-image-2" },
    video: {
      usdPerUnit: 1.56,
      unit: "second",
      source: "https://fal.ai/models/bytedance/seedance-2.0/text-to-video",
    },
  },
  atlas: {
    image: { usdPerUnit: 0.3, unit: "image", source: "https://www.atlascloud.ai/pricing" },
    video: {
      usdPerUnit: 0.4,
      unit: "second",
      source: "https://static.atlascloud.ai/model/readme/google-veo3.1-image-to-video.md",
    },
  },
  replicate: {
    image: { usdPerUnit: 0.3, unit: "image", source: "https://replicate.com/google/nano-banana-pro" },
    video: { usdPerUnit: 1.25, unit: "second", source: "https://replicate.com/bytedance/seedance-2.0" },
  },
  runway: {
    image: { usdPerUnit: 0.08, unit: "image", source: "https://docs.dev.runwayml.com/guides/pricing/" },
    video: { usdPerUnit: 0.4, unit: "second", source: "https://docs.dev.runwayml.com/guides/pricing/" },
  },
  // Credits at the dearest plan's rate ($0.36).
  topview: {
    image: { usdPerUnit: 0.51, unit: "image", source: "https://www.topview.ai/pricing" },
    video: { usdPerUnit: 1.24, unit: "second", source: "https://www.topview.ai/pricing" },
  },
};

/** Seconds billed when a video request states no duration: longer than most models make in one call. */
export const DEFAULT_GENERATED_VIDEO_SECONDS = 15;

export function generatePriceCeiling(vendor: string, task: GenerateTask): GeneratePriceCeiling | undefined {
  return GENERATE_PRICE_CEILINGS[vendor]?.[task];
}
