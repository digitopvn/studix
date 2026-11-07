import { StudixError } from "@studix/shared";
import { JOB_KINDS } from "../entities/job.ts";
import type { JobQueue } from "../ports/job-queue.ts";
import type { AssetRepository } from "../repositories/asset-repository.ts";
import type { AuditRepository } from "../repositories/governance-repositories.ts";
import { actorRef, assertPermission, type TenantContext } from "../tenant.ts";
import { toJobView } from "./job-view.ts";
import { parseMediaExecRequest } from "./media-exec.ts";

export interface StartMediaExecInput {
  request: unknown;
  idempotencyKey?: string;
  budgetCents?: number;
}

export interface MediaExecServiceDeps {
  queue: JobQueue;
  assets: Pick<AssetRepository, "get">;
  audit: Pick<AuditRepository, "append">;
  defaults: { jobBudgetCents: number };
}

export type MediaExecService = ReturnType<typeof createMediaExecService>;

/**
 * Starts `media.exec` jobs. The request is checked in full before a job exists, and the audit event
 * records its shape (tool, argument count, input kinds, output names), never argument text or file contents.
 */
export function createMediaExecService(deps: MediaExecServiceDeps) {
  return {
    async start(ctx: TenantContext, input: StartMediaExecInput) {
      assertPermission(ctx, "media:exec");
      const request = parseMediaExecRequest(input.request);
      for (const [name, source] of Object.entries(request.inputs)) {
        if ("assetId" in source && !(await deps.assets.get(ctx, source.assetId))) {
          throw new StudixError("NOT_FOUND", `asset ${source.assetId} (input ${name}) not found`, {
            retryable: false,
            details: { field: `inputs.${name}` },
          });
        }
      }
      const { job, created } = await deps.queue.enqueue(ctx, {
        kind: JOB_KINDS.mediaExec,
        payload: { request },
        ...(input.idempotencyKey ? { idempotencyKey: `media-exec:${input.idempotencyKey}` } : {}),
        budgetCents: input.budgetCents ?? deps.defaults.jobBudgetCents,
        // Deterministic but not free: a failed run is reported, not retried.
        maxAttempts: 1,
        createdBy: actorRef(ctx.actor),
      });
      if (created) {
        await deps.audit.append(ctx, {
          actor: actorRef(ctx.actor),
          action: "media.exec_started",
          subjectType: "job",
          subjectId: job.id,
          data: {
            tool: request.tool,
            argCount: request.args.length,
            inputs: Object.entries(request.inputs).map(([name, s]) => ({
              name,
              source: "assetId" in s ? "asset" : "url" in s ? "url" : "base64",
            })),
            outputs: request.outputs.map((o) => o.name),
            timeoutSeconds: request.timeoutSeconds,
          },
        });
      }
      return { job: toJobView(job, []), replayed: !created };
    },
  };
}
