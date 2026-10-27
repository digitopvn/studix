// Routes summarized from motion-mcp packages/media/src/capability-matrix.ts @ 408ceccd (MIT, Copyright (c) 2026 Digitop).
import type { MediaCapability } from "@studix/core";

/**
 * "wired": generation runs end to end through this provider and may be advertised by capabilities().
 * "planned": a Multix route exists upstream but Studix has not wired, verified and priced it yet.
 */
export type MultixCapabilityStatus = "wired" | "planned";

export interface MultixCapabilityInfo extends MediaCapability {
  status: MultixCapabilityStatus;
  /** Upstream vendors behind the Multix routes for this kind. */
  vendors: string[];
}

/**
 * What Multix can front, as metadata. Nothing is wired in this build, so MultixProvider.capabilities()
 * advertises none of it; callers that list it (e.g. an admin view) must show the status.
 */
export const MULTIX_CAPABILITY_CATALOG: readonly MultixCapabilityInfo[] = [
  {
    kind: "image",
    status: "planned",
    vendors: ["gemini", "openai", "openrouter", "minimax", "fal", "cloudflare", "leonardo"],
    models: [
      "gemini-2.5-flash-image",
      "gpt-image-2",
      "image-01",
      "fal-ai/flux/schnell",
      "@cf/black-forest-labs/flux-1-schnell",
    ],
    outputMimes: ["image/png"],
  },
  {
    kind: "video",
    status: "planned",
    vendors: ["gemini", "minimax", "byteplus", "fal"],
    models: ["veo-3.1-fast-generate-preview", "MiniMax-Hailuo-2.3", "seedance-2.0"],
    maxDurationMs: 10_000,
    outputMimes: ["video/mp4"],
  },
  {
    kind: "voice",
    status: "planned",
    vendors: ["openai", "elevenlabs", "gemini", "minimax"],
    models: ["gpt-4o-mini-tts", "eleven_multilingual_v2", "speech-2.8-turbo"],
    outputMimes: ["audio/mpeg", "audio/wav"],
  },
  {
    kind: "music",
    status: "planned",
    vendors: ["elevenlabs", "minimax"],
    models: ["music_v1", "music-2.5"],
    outputMimes: ["audio/mpeg"],
  },
  {
    kind: "audio",
    status: "planned",
    vendors: ["elevenlabs"],
    models: ["sound-effects"],
    outputMimes: ["audio/mpeg"],
  },
];
