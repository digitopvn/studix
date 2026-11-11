import { STUDIX_TOOLS, type TenantContext } from "@studix/core";
import { ASPECT_RATIOS, exportJsonSchemas, RENDER_PRESETS, VIDEO_IR_SCHEMA_VERSION } from "@studix/video-ir";
import { type AppLimits, SERVER_NAME, SERVER_VERSION } from "../app-deps.ts";
import type { MediaAvailability } from "../media-availability.ts";
import type { SkillSummary } from "../ports.ts";

export const INSPECT_SECTIONS = ["schemas"] as const;

/** Lazily built once: the JSON Schemas are static for a given build. */
let cachedSchemas: ReturnType<typeof exportJsonSchemas> | undefined;

/**
 * Capability handshake for `studix_inspect`. Compact by default; `include: ["schemas"]` adds the live JSON
 * Schemas (creative brief, VideoIR, render spec, ...) a host needs to author a spec and skip planning.
 */
export function inspectCapabilities(input: {
  tenant: TenantContext;
  limits: AppLimits;
  skills: SkillSummary[];
  media?: MediaAvailability | undefined;
  toolNames: string[];
  include: ReadonlyArray<(typeof INSPECT_SECTIONS)[number]>;
}) {
  const { limits } = input;
  const capabilities = {
    server: { name: SERVER_NAME, version: SERVER_VERSION },
    workspaceId: input.tenant.workspaceId,
    schemaVersion: VIDEO_IR_SCHEMA_VERSION,
    tools: input.toolNames,
    workflow: [
      `Call ${STUDIX_TOOLS.createVideo} with a prompt (or a brief, or a validated VideoIR spec to skip planning).`,
      `Poll ${STUDIX_TOOLS.getJob} until status is succeeded, failed or cancelled; follow next[] hints.`,
      `When succeeded, ${STUDIX_TOOLS.getJob} returns a signed MP4 URL that expires; call it again for a fresh one.`,
      `Send revisions with ${STUDIX_TOOLS.feedback} on a shot, scene, asset or time range; re-render with ${STUDIX_TOOLS.render}.`,
      "A person approves the storyboard on reviewUrl; image-to-video stages run only after that approval.",
    ],
    formats: {
      aspectRatios: [...ASPECT_RATIOS],
      container: "mp4",
      renderPresets: Object.keys(RENDER_PRESETS),
    },
    limits: {
      maxPromptChars: 4000,
      minDurationMs: 1000,
      maxDurationMs: 600_000,
      defaultJobBudgetCents: limits.defaultJobBudgetCents,
      defaultJobDeadlineSeconds: limits.defaultJobDeadlineSeconds,
      approvalCostThresholdCents: limits.approvalCostThresholdCents,
      signedUrlTtlSeconds: limits.signedUrlTtlSeconds,
    },
    constraints: [
      "Budgets above the approval threshold park the job in waiting_approval until a reviewer approves it.",
      "Re-sending the same idempotencyKey in this workspace returns the original job.",
      "Media is returned as signed URLs, never inline.",
    ],
    skills: input.skills,
    ...(input.media
      ? {
          media: {
            enabled: input.media.enabled,
            ...(input.media.enabled
              ? {}
              : {
                  reason: input.media.reason ?? "The Multix provider is not configured",
                  note: "Workflows that need paid media (voice-over, sound effects, music, generated images) are refused at creation. A motion-graphic whose first direction has beats and none of them a voiceover, or one created from a spec, still works.",
                }),
          },
        }
      : {}),
  };
  if (!input.include.includes("schemas")) return capabilities;
  cachedSchemas ??= exportJsonSchemas();
  return { ...capabilities, schemas: cachedSchemas };
}
