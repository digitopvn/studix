import { listCodexModels, listPiCatalog } from "@studix/agent-runtime";
import {
  AGENT_RUNTIMES,
  type AgentHandoffService,
  AGENT_HANDOFF_TOOLS as NAMES,
  STUDIX_TOOLS,
} from "@studix/core";
import { StudixError } from "@studix/shared";
import { z } from "zod";
import { assertReportedModel, ReasoningEffortInput } from "../agent-model-selection.ts";
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
    description: "Stages waiting for your (host agent) output, optionally for one jobId.",
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
    description: "A handed-off stage: instructions, input, outputSchema, limits and the attempt to submit.",
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
      "Submit the output (must match outputSchema) for the task's attempt. Resubmitting it is a no-op.",
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
          reasoningEffort: ReasoningEffortInput.optional(),
        })
        .optional()
        .describe("What the work cost you; recorded, never billed. model is provider/modelId."),
      agent: z
        .object({
          runtime: z.enum(AGENT_RUNTIMES).optional(),
          model: z.string().max(100).optional(),
          reasoningEffort: ReasoningEffortInput.optional(),
        })
        .optional()
        .describe("The agent you ran on; model and effort here win over usage."),
    }),
    readOnly: false,
    audited: true,
    async run(ctx, { agent, ...rest }) {
      const usage =
        agent?.model || agent?.reasoningEffort
          ? {
              ...rest.usage,
              ...(agent.model ? { model: agent.model } : {}),
              ...(agent.reasoningEffort ? { reasoningEffort: agent.reasoningEffort } : {}),
            }
          : rest.usage;
      const input = { ...rest, ...(usage ? { usage } : {}) };
      // A declared model must be one the catalog knows, and an effort needs a reasoning model.
      if (usage?.model?.includes("/") || usage?.reasoningEffort) {
        assertReportedModel(usage.model, usage.reasoningEffort);
      }
      const result = await service(ctx).submit(ctx.tenant, input);
      return {
        data: result,
        next: [followJob(result.task.jobId)],
        scope: { jobId: result.task.jobId },
      };
    },
  }),
  tool({
    name: "studix_list_agent_runtimes",
    title: "List agent runtimes",
    description:
      "Agent runtimes (claude, codex, pi) with your usable connections (no secrets) and their models, for create_video agent.",
    input: z.object({}),
    readOnly: true,
    async run(ctx) {
      const providers = ctx.deps.providers;
      const { connections } = providers ? await providers.list(ctx.tenant) : { connections: [] };
      const catalog = new Map(listPiCatalog().map((p) => [p.id, p.models] as const));
      const models = (runtime: (typeof AGENT_RUNTIMES)[number], provider: string) =>
        (runtime === "codex" ? listCodexModels() : runtime === "pi" ? (catalog.get(provider) ?? []) : []).map(
          (m) => ({ id: m.id, reasoning: m.reasoning }),
        );
      const runtimes = AGENT_RUNTIMES.map((runtime) => ({
        runtime,
        connections: connections
          .filter((c) => c.runtimes.includes(runtime) && c.status !== "invalid")
          .map((c) => ({
            providerConnectionId: c.id,
            provider: c.provider,
            label: c.label,
            owner: c.owner,
            authMethod: c.authMethod,
            status: c.status,
            models: models(runtime, c.provider),
          })),
      }));
      return { data: { runtimes }, next: [] };
    },
  }),
] as const;
