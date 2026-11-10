import { STUDIX_TOOLS, type TenantContext } from "@studix/core";
import {
  ASPECT_RATIOS,
  exportJsonSchemas,
  PUBLISHED_SCHEMAS,
  type PublishedSchemaName,
  RENDER_PRESETS,
  VIDEO_IR_SCHEMA_VERSION,
} from "@studix/video-ir";
import { type AppLimits, SERVER_NAME, SERVER_VERSION } from "../app-deps.ts";
import type { SkillSummary } from "../ports.ts";

export const INSPECT_SECTIONS = ["schemas"] as const;
export const SCHEMA_NAMES = Object.keys(PUBLISHED_SCHEMAS) as [PublishedSchemaName, ...PublishedSchemaName[]];

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
  include: ReadonlyArray<(typeof INSPECT_SECTIONS)[number]>;
  /** Return only these schemas (implies `include: ["schemas"]`); saves tokens against the full set. */
  schemaNames?: ReadonlyArray<PublishedSchemaName>;
}) {
  const { limits } = input;
  const capabilities = {
    server: { name: SERVER_NAME, version: SERVER_VERSION },
    workspaceId: input.tenant.workspaceId,
    schemaVersion: VIDEO_IR_SCHEMA_VERSION,
    schemaNames: SCHEMA_NAMES,
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
  };
  const names = input.schemaNames?.length ? input.schemaNames : undefined;
  if (!names && !input.include.includes("schemas")) return capabilities;
  cachedSchemas ??= exportJsonSchemas();
  if (!names) return { ...capabilities, schemas: cachedSchemas };
  const picked: Partial<typeof cachedSchemas> = {};
  for (const name of new Set(names)) picked[name] = cachedSchemas[name];
  return { ...capabilities, schemas: picked };
}
