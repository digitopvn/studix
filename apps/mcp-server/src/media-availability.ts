import { StudixError } from "@studix/shared";
import type { CreativeBrief } from "@studix/video-ir";

/** Whether this deployment can run paid media (voice, SFX, music, images, clips) through the Multix provider. */
export interface MediaAvailability {
  enabled: boolean;
  /** Why media is off, e.g. "MULTIX_BIN is not set". */
  reason?: string;
}

type Brief = Pick<CreativeBrief, "directions"> | { directions?: unknown } | undefined;

const hasVoiceover = (brief: Brief): boolean => {
  const directions = (brief as { directions?: Array<{ beats?: Array<{ voiceover?: string }> }> } | undefined)
    ?.directions;
  return (directions ?? []).some((d) => (d.beats ?? []).some((b) => Boolean(b.voiceover)));
};

/**
 * What a job of this workflow needs from the media provider, so a deployment without it can refuse before
 * the job runs its free stages and fails on the first paid one. `none` means the workflow renders without
 * paid media. A spec supplied by the caller skips planning but not its media stages, so it is not exempt.
 */
export function mediaNeededBy(workflowTemplate: string, brief: Brief): string | undefined {
  switch (workflowTemplate) {
    case "motion-graphic":
      return hasVoiceover(brief) ? "voice-over and sound effect" : undefined;
    case "marketing-video":
      return "image, voice-over, music and sound effect";
    default:
      return undefined;
  }
}

/** Refuses a job whose workflow needs paid media when this deployment has none. Unknown availability passes. */
export function assertMediaAvailable(
  media: MediaAvailability | undefined,
  workflowTemplate: string,
  brief: Brief,
): void {
  if (!media || media.enabled) return;
  const needed = mediaNeededBy(workflowTemplate, brief);
  if (!needed) return;
  throw new StudixError(
    "UNAVAILABLE",
    `Workflow ${workflowTemplate} needs ${needed} generation, but media generation is off on this server (${media.reason ?? "the Multix provider is not configured"})`,
    {
      retryable: false,
      details: { provider: "multix", workflowTemplate },
      suggestedAction:
        workflowTemplate === "motion-graphic"
          ? "Remove the voiceover lines from the brief to make a silent motion graphic, or ask the operator to set MULTIX_BIN on the app and worker."
          : "Ask the operator to set MULTIX_BIN on the app and worker, or use a workflow that needs no paid media.",
    },
  );
}

/** The server's own view: media is on exactly when the Multix CLI is configured (the worker needs the same value). */
export function mediaAvailability(config: { MULTIX_BIN?: string | undefined }): MediaAvailability {
  return config.MULTIX_BIN ? { enabled: true } : { enabled: false, reason: "MULTIX_BIN is not set" };
}
