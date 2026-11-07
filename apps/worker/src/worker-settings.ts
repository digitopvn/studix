import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { withSelfHostedSecretsKey } from "@studix/auth";
import { parseQualifiedToolName } from "@studix/mcp-gateway";
import { loadConfig, type StudixConfig, StudixError } from "@studix/shared";
import { z } from "zod";

/** Worker-only settings, read from the environment on top of the shared StudixConfig. */
const WorkerEnv = z.object({
  /** 0 picks an ephemeral port (tests). */
  WORKER_HEALTH_PORT: z.coerce.number().int().min(0).max(65_535).default(8081),
  WORKER_HEALTH_HOST: z.string().min(1).default("0.0.0.0"),
  /** Defaults to `<hostname>-<pid>` (the pod name on Kubernetes). */
  WORKER_ID: z
    .string()
    .regex(/^[\w.-]{1,100}$/, "1-100 letters, digits, '_', '.', '-'")
    .optional(),
  WORKER_WORK_DIR: z.string().min(1).optional(),
  /** Hours a job's scratch directory is kept after its last write; failed jobs keep theirs for retries. */
  WORKER_WORK_DIR_RETENTION_HOURS: z.coerce.number().min(24).max(8760).default(168),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(10).max(60_000).default(1000),
  WORKER_SHUTDOWN_GRACE_MS: z.coerce.number().int().min(0).max(600_000).default(25_000),
  /** COGS per rendered second; 0 until compute cost is measured. */
  RENDER_COST_CENTS_PER_SECOND: z.coerce.number().min(0).default(0),
  /** Workspace connector tool (`connector.tool`, e.g. `brand.brand_lookup`) used to enrich drafted brands. */
  STUDIX_BRAND_LOOKUP_TOOL: z
    .string()
    .refine((v) => {
      try {
        parseQualifiedToolName(v);
        return true;
      } catch {
        return false;
      }
    }, "must look like connector.tool")
    .optional(),
  /** Claude planner tuning; the planner itself is switched on by STUDIX_CLAUDE_PLANNER (shared config). */
  STUDIX_CLAUDE_PLANNER_MODEL: z
    .string()
    .regex(/^[\w.:@-]{1,100}$/, "a model id")
    .default("claude-sonnet-5-5"),
  STUDIX_CLAUDE_PLANNER_MAX_TURNS: z.coerce.number().int().min(1).max(50).default(4),
  /** Per-plan cost cap; the job's remaining budget lowers it further. */
  STUDIX_CLAUDE_PLANNER_MAX_COST_CENTS: z.coerce.number().int().min(1).max(100_000).default(200),
  STUDIX_CLAUDE_PLANNER_TIMEOUT_SECONDS: z.coerce.number().int().min(10).max(3600).default(300),
  /** Model of a Codex job that named none (Codex runs in the skill sandbox). */
  STUDIX_CODEX_MODEL: z
    .string()
    .regex(/^[\w.:@-]{1,100}$/, "a model id")
    .default("gpt-5.5"),
});

export interface ClaudePlannerSettings {
  model: string;
  maxTurns: number;
  maxCostCents: number;
  timeoutMs: number;
}

export interface WorkerSettings {
  config: StudixConfig;
  databaseUrl: string;
  workerId: string;
  concurrency: number;
  leaseMs: number;
  heartbeatIntervalMs: number;
  pollIntervalMs: number;
  shutdownGraceMs: number;
  healthPort: number;
  healthHost: string;
  workDir: string;
  workDirRetentionMs: number;
  approvalCostThresholdCents: number;
  renderCentsPerSecond: number;
  /** Qualified connector tool for brand enrichment; unset disables the lookup. */
  brandLookupTool?: string;
  /**
   * Set when STUDIX_CLAUDE_PLANNER or STUDIX_SELF_HOSTED is on; unset means jobs that select Claude fail
   * with UNAVAILABLE. On a self-hosted worker each workspace's switch still decides.
   */
  claudePlanner?: ClaudePlannerSettings;
  codexModel: string;
}

/** Parse worker settings; throws a VALIDATION StudixError naming bad variables (values never echoed). */
export function loadWorkerSettings(env: NodeJS.ProcessEnv = process.env): WorkerSettings {
  const config = withSelfHostedSecretsKey(loadConfig(env));
  const cleaned = Object.fromEntries(
    Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ""),
  );
  const parsed = WorkerEnv.safeParse(cleaned);
  if (!parsed.success) {
    const variables = parsed.error.issues.map((i) => i.path.join("."));
    throw new StudixError("VALIDATION", `Invalid worker configuration: ${variables.join(", ")}`, {
      details: {
        issues: parsed.error.issues.map((i) => ({ variable: i.path.join("."), message: i.message })),
      },
    });
  }
  if (config.STUDIX_CLAUDE_PLANNER && !config.STUDIX_SECRETS_KEY) {
    throw new StudixError("VALIDATION", "STUDIX_CLAUDE_PLANNER needs STUDIX_SECRETS_KEY", {
      suggestedAction: "Give the worker the same STUDIX_SECRETS_KEY as the app so it can open stored keys.",
    });
  }
  if (!config.DATABASE_URL) {
    throw new StudixError("VALIDATION", "DATABASE_URL is required for the worker", {
      suggestedAction: "Set DATABASE_URL to the Studix Postgres connection string.",
    });
  }
  const w = parsed.data;
  const leaseMs = config.JOB_LEASE_SECONDS * 1000;
  return {
    config,
    databaseUrl: config.DATABASE_URL,
    workerId: w.WORKER_ID ?? `${hostname()}-${process.pid}`,
    concurrency: config.WORKER_CONCURRENCY,
    leaseMs,
    // Three heartbeats per lease: one missed beat never costs the lease.
    heartbeatIntervalMs: Math.max(1000, Math.floor(leaseMs / 3)),
    pollIntervalMs: w.WORKER_POLL_INTERVAL_MS,
    shutdownGraceMs: w.WORKER_SHUTDOWN_GRACE_MS,
    healthPort: w.WORKER_HEALTH_PORT,
    healthHost: w.WORKER_HEALTH_HOST,
    workDir: w.WORKER_WORK_DIR ?? join(tmpdir(), "studix-worker"),
    workDirRetentionMs: w.WORKER_WORK_DIR_RETENTION_HOURS * 3_600_000,
    approvalCostThresholdCents: config.APPROVAL_COST_THRESHOLD_CENTS,
    renderCentsPerSecond: w.RENDER_COST_CENTS_PER_SECOND,
    codexModel: w.STUDIX_CODEX_MODEL,
    ...(w.STUDIX_BRAND_LOOKUP_TOOL ? { brandLookupTool: w.STUDIX_BRAND_LOOKUP_TOOL } : {}),
    // A self-hosted worker keeps the Claude planner ready; each workspace owner decides whether it runs.
    ...(config.STUDIX_CLAUDE_PLANNER || config.STUDIX_SELF_HOSTED
      ? {
          claudePlanner: {
            model: w.STUDIX_CLAUDE_PLANNER_MODEL,
            maxTurns: w.STUDIX_CLAUDE_PLANNER_MAX_TURNS,
            maxCostCents: w.STUDIX_CLAUDE_PLANNER_MAX_COST_CENTS,
            timeoutMs: w.STUDIX_CLAUDE_PLANNER_TIMEOUT_SECONDS * 1000,
          },
        }
      : {}),
  };
}
