/**
 * The per-session trace of an agent stage run: one JSONL object per run, in object storage under the job,
 * stage and attempt. The worker writes it (redacted, truncated) while the run goes and again when it ends;
 * `studix_job_trace` reads it back. This file is the format both sides agree on.
 */

import type { TenantContext } from "../tenant.ts";

/** Reads one stored trace object; undefined when it does not exist. */
export interface AgentTraceReader {
  read(ctx: TenantContext, key: string): Promise<string | undefined>;
}

/** How often a running agent run writes a heartbeat (and its trace so far). */
export const AGENT_TRACE_HEARTBEAT_MS = 30_000;

/** A running stage whose last activity is older than this is shown as `stalled`. */
export const STAGE_STALL_MS = 10 * 60_000;

/** Runs of one stage attempt the reader probes for (`.../<attempt>/0.jsonl`, `1.jsonl`, ...). */
export const MAX_TRACE_RUNS = 20;

/**
 * One line of a trace. `seq` counts from 0 within the run; `ts` is ISO time. Types: `run` (task, runtime,
 * model), `status`, `message`, `reasoning`, `tool_start`, `tool_end` (`durationMs`, `exitCode`), `turn`
 * (per-turn tokens, cost, latency), `artifact`, `heartbeat` (`idleMs`), `error`, `truncated`.
 */
export interface AgentTraceEvent {
  seq: number;
  ts: string;
  type: string;
  [field: string]: unknown;
}

/** Storage-key-safe stage segment: `skill-agent.run` stays as it is; anything unusual becomes `_`. */
function keySegment(value: string): string {
  const safe = value.replace(/[^\w\-.]/g, "_").replace(/^[^A-Za-z0-9]/, "_");
  return safe === "" ? "_" : safe.slice(0, 120);
}

/** Tenant-relative key of one run's trace. */
export function agentTraceKey(jobId: string, stage: string, attempt: number, run: number): string {
  return `traces/jobs/${keySegment(jobId)}/${keySegment(stage)}/${attempt}/${run}.jsonl`;
}

/** Events of a stored trace; a line that is not a JSON event (a torn write) is skipped. */
export function parseAgentTrace(text: string): AgentTraceEvent[] {
  const events: AgentTraceEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (value && typeof value === "object" && typeof (value as AgentTraceEvent).type === "string") {
        events.push(value as AgentTraceEvent);
      }
    } catch {
      // A partial line is dropped; the rest of the trace still reads.
    }
  }
  return events;
}

/** The slowest steps a summary lists. */
const SLOWEST = 5;

export interface AgentTraceStep {
  type: "turn" | "tool";
  name: string;
  durationMs: number;
  at: string;
  ok?: boolean;
}

/** One run's timeline at a glance: what it did, where time went, what failed and when it last moved. */
export interface AgentTraceSummary {
  run: number;
  runtime?: string;
  model?: string;
  status?: string;
  startedAt?: string;
  lastActivityAt?: string;
  /** Last event of any kind, heartbeats included: proves the worker was alive then. */
  lastHeartbeatAt?: string;
  events: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  costCents: number;
  toolCalls: number;
  toolFailures: number;
  /** Tools by name with call counts. */
  tools: Record<string, number>;
  slowest: AgentTraceStep[];
  errors: { at: string; message: string }[];
  /** Set when the trace hit its size cap and later events were dropped. */
  truncated?: boolean;
  /** The run's last contiguous assistant text (its answer, for a structured stage), cut to 4,000 chars. */
  finalMessage?: string;
}

/** Longest final assistant message a summary carries. */
const FINAL_MESSAGE_CHARS = 4_000;

const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const str = (value: unknown) => (typeof value === "string" ? value : undefined);

export function summarizeAgentTrace(run: number, events: readonly AgentTraceEvent[]): AgentTraceSummary {
  const summary: AgentTraceSummary = {
    run,
    events: events.length,
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    costCents: 0,
    toolCalls: 0,
    toolFailures: 0,
    tools: {},
    slowest: [],
    errors: [],
  };
  const steps: AgentTraceStep[] = [];
  // Text deltas of one block may be split across lines; a tool call or reasoning starts a new block.
  let message: string | undefined;
  let inMessage = false;
  for (const e of events) {
    if (e.type === "message" && typeof e.delta === "string") {
      message = inMessage ? `${message ?? ""}${e.delta}` : e.delta;
      inMessage = true;
    } else if (e.type === "reasoning" || e.type === "tool_start" || e.type === "tool_end") inMessage = false;
    summary.startedAt ??= e.ts;
    summary.lastHeartbeatAt = e.ts;
    if (e.type !== "heartbeat") summary.lastActivityAt = e.ts;
    switch (e.type) {
      case "run":
        summary.runtime = str(e.runtime) ?? summary.runtime;
        summary.model = str(e.model) ?? summary.model;
        break;
      case "status":
        summary.status = str(e.status);
        summary.runtime = str(e.runtime) ?? summary.runtime;
        summary.model = str(e.model) ?? summary.model;
        // A failed run also writes an `error` line with the code and suggested action; that one is listed.
        break;
      case "turn":
        // A `turn` line is one usage report; `turn` is the runtime's own running count (Claude Code and
        // Codex may report once for many turns).
        summary.turns = Math.max(summary.turns + (typeof e.turn === "number" ? 0 : 1), num(e.turn));
        summary.inputTokens += num(e.inputTokens);
        summary.outputTokens += num(e.outputTokens);
        summary.costCents += num(e.costCents);
        summary.model = str(e.model) ?? summary.model;
        steps.push({ type: "turn", name: str(e.model) ?? "model", durationMs: num(e.latencyMs), at: e.ts });
        break;
      case "tool_start":
        summary.toolCalls += 1;
        summary.tools[str(e.name) ?? "?"] = (summary.tools[str(e.name) ?? "?"] ?? 0) + 1;
        break;
      case "tool_end":
        if (e.ok === false) {
          summary.toolFailures += 1;
          summary.errors.push({
            at: e.ts,
            message: `${str(e.name) ?? "tool"} failed${e.exitCode !== undefined ? ` (exit ${String(e.exitCode)})` : ""}`,
          });
        }
        steps.push({
          type: "tool",
          name: str(e.name) ?? "?",
          durationMs: num(e.durationMs),
          at: e.ts,
          ok: e.ok !== false,
        });
        break;
      case "error":
        summary.errors.push({ at: e.ts, message: str(e.message) ?? "error" });
        break;
      case "truncated":
        summary.truncated = true;
        break;
    }
  }
  summary.costCents = Math.round(summary.costCents * 100) / 100;
  if (message?.trim()) {
    summary.finalMessage =
      message.length > FINAL_MESSAGE_CHARS ? `${message.slice(0, FINAL_MESSAGE_CHARS)}…` : message;
  }
  summary.slowest = steps.sort((a, b) => b.durationMs - a.durationMs).slice(0, SLOWEST);
  return summary;
}

/** Whether a running stage has gone quiet for longer than `STAGE_STALL_MS`; never for one with no activity record. */
export function stageIdleMs(stage: { status: string; lastActivityAt?: Date }, now: Date): number | undefined {
  if (stage.status !== "running" || !stage.lastActivityAt) return undefined;
  return Math.max(0, now.getTime() - stage.lastActivityAt.getTime());
}
