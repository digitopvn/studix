import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
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
});

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
  approvalCostThresholdCents: number;
  renderCentsPerSecond: number;
  /** Qualified connector tool for brand enrichment; unset disables the lookup. */
  brandLookupTool?: string;
}

/** Parse worker settings; throws a VALIDATION StudixError naming bad variables (values never echoed). */
export function loadWorkerSettings(env: NodeJS.ProcessEnv = process.env): WorkerSettings {
  const config = loadConfig(env);
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
    approvalCostThresholdCents: config.APPROVAL_COST_THRESHOLD_CENTS,
    renderCentsPerSecond: w.RENDER_COST_CENTS_PER_SECOND,
    ...(w.STUDIX_BRAND_LOOKUP_TOOL ? { brandLookupTool: w.STUDIX_BRAND_LOOKUP_TOOL } : {}),
  };
}
