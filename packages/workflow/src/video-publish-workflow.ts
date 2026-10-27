import { JOB_KINDS, type PublisherAdapter, type RenderRepository } from "@studix/core";
import { StudixError } from "@studix/shared";
import { z } from "zod";
import type { WorkflowDefinition } from "./workflow-types.ts";

export interface VideoPublishWorkflowDeps {
  renders: Pick<RenderRepository, "get">;
  /** Unset until a publisher is configured; publish jobs then fail after the approval gate. */
  publisher?: PublisherAdapter;
}

const Payload = z.object({
  renderId: z.string().min(1),
  title: z.string().trim().min(1).max(200),
  description: z.string().max(5000).optional(),
});

/**
 * `video.publish`: one approval-gated stage. The publisher is never called unless a human approved
 * publishing this job, and failures are not retried automatically (the outcome may be unknown).
 */
export function createVideoPublishWorkflow(deps: VideoPublishWorkflowDeps): WorkflowDefinition {
  return {
    kind: JOB_KINDS.publish,
    result: (outputs) => outputs.publish ?? {},
    stages: [
      {
        name: "publish",
        approval: { action: "publish" },
        retry: "never",
        async run(s) {
          const parsed = Payload.safeParse(s.job.payload);
          if (!parsed.success) {
            throw new StudixError("VALIDATION", "Invalid video.publish payload", {
              retryable: false,
              details: { issues: parsed.error.issues },
            });
          }
          if (!s.approval) {
            throw new StudixError("APPROVAL_REQUIRED", "Publishing requires a human approval", {
              retryable: false,
            });
          }
          const payload = parsed.data;
          const render = await deps.renders.get(s.ctx, payload.renderId);
          if (render?.status !== "succeeded" || !render.storageKey) {
            throw new StudixError("NOT_FOUND", `render ${payload.renderId} is not a finished render`, {
              retryable: false,
            });
          }
          if (!deps.publisher) {
            throw new StudixError("UNAVAILABLE", "No publisher is configured for this worker", {
              retryable: false,
            });
          }
          const published = await deps.publisher.publish(s.ctx, {
            renderId: render.id,
            storageKey: render.storageKey,
            title: payload.title,
            description: payload.description,
            approvalId: s.approval.id,
            idempotencyKey: `${s.job.id}:publish`,
          });
          return {
            output: {
              platform: published.platform,
              externalId: published.externalId,
              ...(published.url ? { url: published.url } : {}),
              approvalId: s.approval.id,
            },
          };
        },
      },
    ],
  };
}
