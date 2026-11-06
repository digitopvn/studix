import { StudixError } from "@studix/shared";
import type { CreativeBrief } from "@studix/video-ir";

/** Whether this deployment can run paid media (voice, SFX, music, images, clips) through the Multix provider. */
export interface MediaAvailability {
  enabled: boolean;
  /** Why media is off, e.g. "MULTIX_BIN is not set". */
  reason?: string;
}

type Brief = Record<string, unknown> | undefined;

/**
 * Mirrors the motion-graphic template: only a first direction with `beats`, none of which is spoken, is
 * silent. Without beats the template voices the hook, key messages and call to action.
 */
function motionGraphicIsSilent(brief: Brief): boolean {
  const directions = brief?.directions;
  const first: unknown = Array.isArray(directions) ? directions[0] : undefined;
  const beats = (first as { beats?: unknown } | null | undefined)?.beats;
  if (!Array.isArray(beats)) return false;
  return !beats.some(
    (b) =>
      typeof (b as { voiceover?: unknown } | null)?.voiceover === "string" &&
      (b as { voiceover: string }).voiceover !== "",
  );
}

/**
 * What a job of this workflow needs from the media provider, so a deployment without it can refuse before
 * the job runs its free stages and fails on the first paid one. `undefined` means no paid media. A
 * caller-supplied spec skips planning; a motion graphic built from one only renders, but the other packs
 * still generate media for it.
 */
export function mediaNeededBy(workflowTemplate: string, brief: Brief, hasSpec = false): string | undefined {
  switch (workflowTemplate) {
    case "motion-graphic":
      return hasSpec || motionGraphicIsSilent(brief) ? undefined : "voice-over and sound effect";
    case "marketing-video":
      return "image, voice-over, music and sound effect";
    case "anime":
    case "long-form-film":
      return "image, video, voice and music";
    default:
      return undefined;
  }
}

/** Refuses a job whose workflow needs paid media when this deployment has none. Unknown availability passes. */
export function assertMediaAvailable(
  media: MediaAvailability | undefined,
  workflowTemplate: string,
  brief: Brief,
  hasSpec = false,
): void {
  if (!media || media.enabled) return;
  const needed = mediaNeededBy(workflowTemplate, brief, hasSpec);
  if (!needed) return;
  throw new StudixError(
    "UNAVAILABLE",
    `Workflow ${workflowTemplate} needs ${needed} generation, but media generation is off on this server (${media.reason ?? "the Multix provider is not configured"})`,
    {
      retryable: false,
      details: { provider: "multix", workflowTemplate },
      suggestedAction:
        workflowTemplate === "motion-graphic"
          ? "Give a silent motion graphic explicit directions[0].beats with no voiceover, or ask the operator to set MULTIX_BIN on the app and worker."
          : "Ask the operator to set MULTIX_BIN on the app and worker, or use a workflow that needs no paid media.",
    },
  );
}

/** The server's own view: media is on exactly when the Multix CLI is configured (the worker needs the same value). */
export function mediaAvailability(config: { MULTIX_BIN?: string | undefined }): MediaAvailability {
  return config.MULTIX_BIN ? { enabled: true } : { enabled: false, reason: "MULTIX_BIN is not set" };
}
