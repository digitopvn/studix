import type { McpServer } from "@modelcontextprotocol/server";
import { ResourceTemplate } from "@modelcontextprotocol/server";
import { isTerminalJobStatus, type JobView, type TenantContext } from "@studix/core";
import { StudixError } from "@studix/shared";
import { z } from "zod";
import type { AppDeps } from "../app-deps.ts";
import type { ArtifactUrlDeps } from "../artifact-urls.ts";
import { jobResourceUri } from "../job-change-feed.ts";
import { jobWithVideo } from "../resource-views.ts";
import type { NativeTool, ToolContext } from "./native-tools.ts";

export const JOB_RESOURCE_TEMPLATE = "studix://jobs/{jobId}";
const WAIT_POLL_MS = 1_000;

/**
 * `studix://jobs/{jobId}`: the job as `studix_get_job` returns it. Subscribe to it (`subscriptions/listen`
 * with `resourceSubscriptions`) to get `notifications/resources/updated` on every status or stage change.
 */
export function registerJobResource(
  server: McpServer,
  deps: AppDeps,
  artifacts: ArtifactUrlDeps,
  tenant: TenantContext,
): void {
  server.registerResource(
    "studix-job",
    new ResourceTemplate(JOB_RESOURCE_TEMPLATE, { list: undefined }),
    {
      title: "Studix job",
      description: "Job status, stages, progress and, once succeeded, the signed MP4 URL.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const jobId = decodeURIComponent(String(variables.jobId ?? ""));
      const job = await deps.studio.getJob(tenant, jobId);
      const view = await jobWithVideo(artifacts, tenant, job);
      return {
        contents: [{ uri: jobResourceUri(job.id), mimeType: "application/json", text: JSON.stringify(view) }],
      };
    },
  );
}

/**
 * Hold a `studix_get_job` call until the job changes status or finishes, at most `waitSeconds`, sending
 * `notifications/progress` while it waits. Returns the latest job.
 */
export async function waitForJobChange(
  ctx: ToolContext,
  job: JobView,
  waitSeconds: number,
): Promise<JobView> {
  if (isTerminalJobStatus(job.status) || waitSeconds <= 0) return job;
  const deadline = Date.now() + waitSeconds * 1000;
  const start = job.status;
  let last = "";
  let current = job;
  while (Date.now() < deadline && !ctx.signal?.aborted) {
    const key = `${current.status}|${current.stage ?? ""}|${current.progress}`;
    if (key !== last) {
      last = key;
      await ctx.progress?.(
        Math.round(current.progress * 100),
        100,
        [current.status, current.stage].filter(Boolean).join(" · "),
      );
    }
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(WAIT_POLL_MS, Math.max(0, deadline - Date.now()))),
    );
    current = await ctx.deps.studio.getJob(ctx.tenant, job.id);
    if (current.status !== start || isTerminalJobStatus(current.status)) break;
  }
  return current;
}

const Webhook = z.object({
  action: z
    .enum(["get", "set", "delete"])
    .describe("set saves the URL with a new signing secret, shown once."),
  url: z.string().trim().max(2000).optional().describe("https URL for set."),
});

/** Per-workspace job webhook, the same as `GET|PUT|DELETE /api/webhook`. */
export const WEBHOOK_MCP_TOOLS = [
  {
    name: "studix_webhook",
    title: "Job webhook",
    description:
      "Get, set or delete the workspace webhook: Studix POSTs job status changes, signed (HMAC-SHA256, header studix-signature). Polling keeps working.",
    input: Webhook,
    readOnly: false,
    idempotent: true,
    audited: true,
    async run(ctx, input) {
      const hooks = ctx.deps.webhooks;
      if (!hooks) throw new StudixError("UNAVAILABLE", "Webhooks are not configured on this server");
      if (input.action === "get") return { data: { webhook: await hooks.get(ctx.tenant) }, next: [] };
      if (input.action === "delete") return { data: await hooks.remove(ctx.tenant), next: [] };
      if (!input.url) throw new StudixError("VALIDATION", "url is required for set");
      const saved = await hooks.set(ctx.tenant, input.url);
      return {
        data: { webhook: saved, note: "Store the secret now; it is not shown again." },
        next: [],
      };
    },
  } satisfies NativeTool<typeof Webhook>,
];
