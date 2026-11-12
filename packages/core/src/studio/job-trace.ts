import { type Clock, StudixError } from "@studix/shared";
import { z } from "zod";
import {
  type AgentTraceEvent,
  type AgentTraceReader,
  type AgentTraceSummary,
  agentTraceKey,
  MAX_TRACE_RUNS,
  parseAgentTrace,
  STAGE_STALL_MS,
  stageIdleMs,
  summarizeAgentTrace,
} from "../entities/agent-trace.ts";
import type { Stage } from "../entities/job.ts";
import type { JobRepository } from "../repositories/job-repository.ts";
import { assertPermission, type TenantContext } from "../tenant.ts";
import { type NextAction, STUDIX_TOOLS } from "./studio-types.ts";

const DEFAULT_PAGE = 50;

/** `studix_job_trace` input; the API route and WebMCP take the same fields. */
export const JobTraceInput = z.object({
  jobId: z.string().trim().min(1).max(100),
  /** A stage name from `studix_get_job` `stages[].name`; omitted, every stage (summary) or the current one (full). */
  stage: z.string().trim().min(1).max(200).optional(),
  /** The job attempt; omitted, each stage's latest. */
  attempt: z.number().int().min(1).max(1000).optional(),
  view: z.enum(["summary", "full"]).default("summary"),
  /** `nextCursor` of the previous full page. */
  cursor: z
    .string()
    .regex(/^\d{1,7}$/, "a cursor from nextCursor")
    .optional(),
  limit: z.number().int().min(1).max(200).optional(),
});
export type JobTraceInput = z.input<typeof JobTraceInput>;

export interface StageTraceView {
  name: string;
  attempt: number;
  status: Stage["status"];
  startedAt?: Date;
  finishedAt?: Date;
  lastActivityAt?: Date;
  stalled?: boolean;
  /** One summary per agent run of the attempt, oldest first; empty for a stage that ran no traced agent. */
  runs: AgentTraceSummary[];
}

export type JobTraceView =
  | { jobId: string; view: "summary"; stages: StageTraceView[]; next: NextAction[] }
  | {
      jobId: string;
      view: "full";
      stage: string;
      attempt: number;
      /** Events of every run of the attempt in order; `run` says which run each came from. */
      events: (AgentTraceEvent & { run: number })[];
      total: number;
      nextCursor?: string;
      next: NextAction[];
    };

interface JobTraceDeps {
  jobs: Pick<JobRepository, "get" | "listStages">;
  traces?: AgentTraceReader;
  clock: Clock;
}

/** Every run of one stage attempt: `0.jsonl`, `1.jsonl`, ... until the first missing one. */
async function readRuns(
  deps: JobTraceDeps & { traces: AgentTraceReader },
  ctx: TenantContext,
  jobId: string,
  stage: Stage,
): Promise<AgentTraceEvent[][]> {
  const runs: AgentTraceEvent[][] = [];
  for (let run = 0; run < MAX_TRACE_RUNS; run++) {
    const text = await deps.traces.read(ctx, agentTraceKey(jobId, stage.name, stage.attempt, run));
    if (text === undefined) break;
    runs.push(parseAgentTrace(text));
  }
  return runs;
}

/** The rows the call is about: the named stage (or all), at the named attempt (or each stage's latest). */
function selectStages(rows: readonly Stage[], input: z.output<typeof JobTraceInput>): Stage[] {
  const named = rows.filter((s) => !input.stage || s.name === input.stage);
  if (input.attempt !== undefined) return named.filter((s) => s.attempt === input.attempt);
  const latest = new Map<string, Stage>();
  for (const s of named) {
    const seen = latest.get(s.name);
    if (!seen || s.attempt > seen.attempt) latest.set(s.name, s);
  }
  return [...latest.values()];
}

/**
 * What each agent stage run of a job did, from its stored session traces. Workspace-scoped with the same
 * permission as `getJob`. The summary is a per-stage timeline; the full view pages one stage's events.
 */
export async function readJobTrace(
  deps: JobTraceDeps,
  ctx: TenantContext,
  raw: JobTraceInput,
): Promise<JobTraceView> {
  assertPermission(ctx, "project:read");
  const input = JobTraceInput.parse(raw);
  const job = await deps.jobs.get(ctx, input.jobId);
  if (!job) throw new StudixError("NOT_FOUND", `job ${input.jobId} not found`);
  const traces = deps.traces;
  if (!traces) {
    throw new StudixError("UNAVAILABLE", "Agent session traces need object storage", {
      retryable: false,
      suggestedAction: "Configure S3 storage for the server, or read the job's stages with studix_get_job.",
    });
  }
  const rows = await deps.jobs.listStages(ctx, job.id);
  const now = deps.clock.now();
  const getJob: NextAction = {
    tool: STUDIX_TOOLS.getJob,
    arguments: { jobId: job.id },
    reason: "Job status, stages and next steps.",
  };

  if (input.view === "summary") {
    const stages: StageTraceView[] = [];
    for (const s of selectStages(rows, input)) {
      if (s.status === "skipped") continue;
      const runs = await readRuns({ ...deps, traces }, ctx, job.id, s);
      const idle = stageIdleMs(s, now);
      stages.push({
        name: s.name,
        attempt: s.attempt,
        status: s.status,
        startedAt: s.startedAt,
        finishedAt: s.finishedAt,
        ...(s.lastActivityAt ? { lastActivityAt: s.lastActivityAt } : {}),
        ...(idle !== undefined && idle >= STAGE_STALL_MS ? { stalled: true } : {}),
        runs: runs.map((events, run) => summarizeAgentTrace(run, events)),
      });
    }
    const worst =
      stages.find((s) => s.stalled) ??
      stages.find((s) => s.runs.some((r) => r.errors.length > 0)) ??
      stages.findLast((s) => s.runs.length > 0);
    return {
      jobId: job.id,
      view: "summary",
      stages,
      next: worst
        ? [
            {
              tool: STUDIX_TOOLS.jobTrace,
              arguments: { jobId: job.id, stage: worst.name, attempt: worst.attempt, view: "full" },
              reason: `Every event of stage ${worst.name} (attempt ${worst.attempt}): prompts, tool calls, results and errors.`,
            },
            getJob,
          ]
        : [getJob],
    };
  }

  const named = input.stage ?? job.stage ?? rows.at(-1)?.name;
  const stage = selectStages(rows, { ...input, stage: named })[0];
  if (!stage) {
    throw new StudixError("NOT_FOUND", `job ${job.id} has no stage ${named ?? ""} to trace`.trim(), {
      suggestedAction: "Pick a stage name and attempt from studix_get_job stages[].",
    });
  }
  const events = (await readRuns({ ...deps, traces }, ctx, job.id, stage)).flatMap((run, index) =>
    run.map((e) => ({ ...e, run: index })),
  );
  const offset = input.cursor ? Number(input.cursor) : 0;
  const limit = input.limit ?? DEFAULT_PAGE;
  const page = events.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  const more = nextOffset < events.length;
  return {
    jobId: job.id,
    view: "full",
    stage: stage.name,
    attempt: stage.attempt,
    events: page,
    total: events.length,
    ...(more ? { nextCursor: String(nextOffset) } : {}),
    next: more
      ? [
          {
            tool: STUDIX_TOOLS.jobTrace,
            arguments: {
              jobId: job.id,
              stage: stage.name,
              attempt: stage.attempt,
              view: "full",
              cursor: String(nextOffset),
            },
            reason: `${events.length - nextOffset} more events.`,
          },
        ]
      : [getJob],
  };
}
