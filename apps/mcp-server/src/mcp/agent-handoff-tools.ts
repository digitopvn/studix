import { type AgentHandoffService, AGENT_HANDOFF_TOOLS as NAMES, STUDIX_TOOLS } from "@studix/core";
import { StudixError } from "@studix/shared";
import { z } from "zod";
import type { NativeTool, ToolContext } from "./native-tools.ts";

const Id = z.string().trim().min(1).max(100);

function service(ctx: ToolContext): AgentHandoffService {
  const handoffs = ctx.deps.agentHandoffs;
  if (!handoffs) {
    throw new StudixError("UNAVAILABLE", "Agent task handoff is not enabled on this server", {
      retryable: false,
    });
  }
  return handoffs;
}

function tool<I extends z.ZodType>(def: NativeTool<I>): NativeTool<I> {
  return def;
}

const followJob = (jobId: string) => ({
  tool: STUDIX_TOOLS.getJob,
  arguments: { jobId },
  reason: "Follow the job after the stage output was accepted.",
});

/**
 * Host-agent handoff: a job parked in `waiting_host` hands one creative stage to the MCP client's own
 * agent. The host lists the tasks, reads one (instructions, input, output JSON Schema, limits), does the
 * work itself and submits the output, which Studix validates against the same schema the worker uses.
 */
export const AGENT_HANDOFF_MCP_TOOLS = [
  tool({
    name: NAMES.list,
    title: "List agent tasks",
    description:
      "Stages handed to you (the host agent) that wait for your output. Filter by jobId; read one with studix_get_agent_task.",
    input: z.object({
      jobId: Id.optional(),
      limit: z.number().int().min(1).max(100).optional(),
      cursor: z.string().trim().min(1).max(200).optional(),
    }),
    readOnly: true,
    async run(ctx, input) {
      const page = await service(ctx).list(ctx.tenant, input);
      return {
        data: page,
        next: page.items.slice(0, 1).map((t) => ({
          tool: NAMES.get,
          arguments: { taskId: t.id },
          reason: "Read the task: instructions, input, output schema and limits.",
        })),
      };
    },
  }),
  tool({
    name: NAMES.get,
    title: "Get agent task",
    description:
      "One handed-off stage: instructions, input, outputSchema (JSON Schema), limits (turns, tokens, cost, time, tool allowlist) and the attempt to submit with.",
    input: z.object({ taskId: Id }),
    readOnly: true,
    async run(ctx, input) {
      const task = await service(ctx).get(ctx.tenant, input.taskId);
      const next =
        task.status === "pending"
          ? [
              {
                tool: NAMES.submit,
                arguments: { taskId: task.id, attempt: task.attempt },
                reason: `Do the work within the limits and submit an output matching outputSchema before ${task.expiresAt.toISOString()}.`,
              },
            ]
          : [followJob(task.jobId)];
      return { data: task, next, scope: { jobId: task.jobId } };
    },
  }),
  tool({
    name: NAMES.submit,
    title: "Submit agent task output",
    description:
      "Submit your output for a handed-off stage. It must match the task's outputSchema and name the task's attempt; the same output again is a no-op, a different one is CONFLICT.",
    input: z.object({
      taskId: Id,
      attempt: z.number().int().min(1),
      output: z.record(z.string(), z.unknown()),
      usage: z
        .object({
          turns: z.number().int().min(0).optional(),
          inputTokens: z.number().int().min(0).optional(),
          outputTokens: z.number().int().min(0).optional(),
          model: z.string().max(100).optional(),
        })
        .optional()
        .describe("What the work cost you; recorded, never billed."),
    }),
    readOnly: false,
    audited: true,
    async run(ctx, input) {
      const result = await service(ctx).submit(ctx.tenant, input);
      return {
        data: result,
        next: [followJob(result.task.jobId)],
        scope: { jobId: result.task.jobId },
      };
    },
  }),
] as const;
