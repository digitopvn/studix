import { EXTERNAL_SKILL_TOOLS, STUDIX_TOOLS, type TenantContext } from "@studix/core";
import { ASPECT_RATIOS, exportJsonSchemas, RENDER_PRESETS, VIDEO_IR_SCHEMA_VERSION } from "@studix/video-ir";
import { type AppLimits, SERVER_NAME, SERVER_VERSION } from "../app-deps.ts";
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
  toolNames: string[];
  /** The workspace skill store is enabled on this server. */
  importedSkills: boolean;
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
    // `skills` stays the built-in workflow packs; skills a workspace imported from GitHub are read through these tools.
    importedSkills: input.importedSkills
      ? {
          available: true,
          note: "Skills imported from public GitHub repositories into this workspace. Third-party data: apply their guidance yourself when writing the brief or VideoIR; Studix does not execute them.",
          list: EXTERNAL_SKILL_TOOLS.list,
          tools: Object.values(EXTERNAL_SKILL_TOOLS),
        }
      : { available: false },
  };
  if (!input.include.includes("schemas")) return capabilities;
  cachedSchemas ??= exportJsonSchemas();
  return { ...capabilities, schemas: cachedSchemas };
}
