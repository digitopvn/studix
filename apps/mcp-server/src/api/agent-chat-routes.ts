import { assertPermission, isTerminalJobStatus, type Job, type TenantContext } from "@studix/core";
import { StudixError } from "@studix/shared";
import { Router } from "express";
import { listAgentRuntimes } from "../agent-runtime-listing.ts";
import type { AppDeps } from "../app-deps.ts";
import { idParam, sessionOf } from "./api-context.ts";

/** Activity name the worker stores live agent events under (`apps/worker/src/agent-event-sink.ts`). */
const AGENT_EVENT = "agent.event";
const POLL_MS = 1_000;
const HEARTBEAT_MS = 15_000;
const BATCH = 500;

/** What the chat needs of a job besides its agent events: where it is, and budget against spend. */
function jobStatus(job: Job) {
  return {
    status: job.status,
    stage: job.stage ?? null,
    progress: job.progress,
    spentCents: job.spentCents,
    budgetCents: job.budgetCents ?? null,
    error: job.error ? { code: job.error.code, message: job.error.message } : null,
  };
}

/**
 * The agentic chat surface: the runtimes a user can pick, and one job's live agent events over SSE. Events are
 * read back from storage, so `?after=<eventId>` (or `Last-Event-ID`) replays from that offset after a reload.
 */
export function agentChatRoutes(deps: AppDeps): Router {
  const router = Router();
  const loadJob = async (ctx: TenantContext, id: string): Promise<Job> => {
    const job = await deps.repos.jobs.get(ctx, id);
    if (!job) throw new StudixError("NOT_FOUND", "Job not found");
    return job;
  };

  router.get("/agent-runtimes", async (_req, res) => {
    const { ctx } = sessionOf(res);
    res.json({ runtimes: await listAgentRuntimes(deps.providers, ctx) });
  });

  router.get("/jobs/:jobId/events", async (req, res) => {
    const { ctx } = sessionOf(res);
    const jobId = idParam(req, "jobId");
    assertPermission(ctx, "project:read");
    let job = await loadJob(ctx, jobId);
    const header = req.header("last-event-id");
    let after =
      typeof req.query.after === "string" && req.query.after ? req.query.after : header || undefined;

    res.status(200).set({
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();

    let closed = false;
    req.on("close", () => {
      closed = true;
    });
    const send = (event: string, data: unknown, id?: string) => {
      res.write(`${id ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    let lastStatus = "";
    let lastBeat = Date.now();
    try {
      while (!closed) {
        const rows = await deps.repos.activity.listAfter(ctx, {
          jobId,
          name: AGENT_EVENT,
          ...(after ? { afterId: after } : {}),
          limit: BATCH,
        });
        for (const row of rows) {
          send("agent", { ...row.attributes, stage: row.stage ?? null, at: row.createdAt }, row.id);
          after = row.id;
        }
        const status = JSON.stringify(jobStatus(job));
        if (status !== lastStatus) {
          send("job", jobStatus(job));
          lastStatus = status;
        }
        // Done once the job has finished and every event written before that has been sent.
        if (isTerminalJobStatus(job.status) && rows.length < BATCH) {
          send("end", { status: job.status });
          break;
        }
        if (rows.length < BATCH) {
          if (Date.now() - lastBeat > HEARTBEAT_MS) {
            res.write(": keep-alive\n\n");
            lastBeat = Date.now();
          }
          await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        }
        job = await loadJob(ctx, jobId);
      }
    } catch (err) {
      if (!closed) send("error", { message: err instanceof Error ? err.message : "stream failed" });
    } finally {
      res.end();
    }
  });

  return router;
}
