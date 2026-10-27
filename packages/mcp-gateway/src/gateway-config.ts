import { StudixError } from "@studix/shared";
import { z } from "zod";

/** Numeric caps enforced by the gateway. All sizes are bytes of UTF-8 JSON unless stated. */
export interface GatewayLimits {
  /** Per execute call deadline. */
  timeoutMs: number;
  /** Concurrent executes per workspace (in this process). */
  maxConcurrentPerWorkspace: number;
  /** Largest result returned inline; bigger results are compacted or stored as an asset ref. */
  maxResultBytes: number;
  /** Hard cap on any HTTP response body read from a downstream server. */
  maxResponseBytes: number;
  /** Largest tool input schema kept in the catalog; bigger schemas are replaced by a stub. */
  maxSchemaBytes: number;
  /** Largest `arguments` object accepted by execute. */
  maxArgumentBytes: number;
  maxDescriptionChars: number;
  maxSummaryChars: number;
  maxToolsPerConnector: number;
  maxConnectorsPerWorkspace: number;
  /** Catalog cache entry lifetime. */
  catalogTtlMs: number;
}

export const DEFAULT_GATEWAY_LIMITS: GatewayLimits = {
  timeoutMs: 20_000,
  maxConcurrentPerWorkspace: 4,
  maxResultBytes: 64 * 1024,
  maxResponseBytes: 8 * 1024 * 1024,
  maxSchemaBytes: 16 * 1024,
  maxArgumentBytes: 64 * 1024,
  maxDescriptionChars: 1_000,
  maxSummaryChars: 200,
  maxToolsPerConnector: 200,
  maxConnectorsPerWorkspace: 50,
  catalogTtlMs: 5 * 60_000,
};

/** Environment-derived gateway configuration. */
export interface GatewayConfig {
  limits: GatewayLimits;
  /**
   * Hostnames (optionally `host:port`) allowed to use plain http and to resolve to private addresses.
   * For local development and tests only; empty in hosted environments.
   */
  insecureHosts: string[];
  /** Studix's own public origins; connectors pointing at them are refused (recursion guard). */
  selfOrigins: string[];
}

const positiveInt = z.coerce.number().int().positive();
const csv = z
  .string()
  .optional()
  .transform((value) =>
    (value ?? "")
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  );

const EnvSchema = z.object({
  STUDIX_MCP_GATEWAY_TIMEOUT_MS: positiveInt.optional(),
  STUDIX_MCP_GATEWAY_MAX_CONCURRENCY: positiveInt.optional(),
  STUDIX_MCP_GATEWAY_MAX_RESULT_BYTES: positiveInt.optional(),
  STUDIX_MCP_GATEWAY_MAX_SCHEMA_BYTES: positiveInt.optional(),
  STUDIX_MCP_GATEWAY_INSECURE_HOSTS: csv,
  STUDIX_PUBLIC_URL: z.url().optional(),
  STUDIX_APP_URL: z.url().optional(),
});

/** Treat empty strings as unset, matching `loadConfig` in @studix/shared. */
function nonEmpty(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (value !== undefined && value !== "") out[key] = value;
  return out;
}

/**
 * Read gateway settings from the environment:
 * STUDIX_MCP_GATEWAY_TIMEOUT_MS, STUDIX_MCP_GATEWAY_MAX_CONCURRENCY, STUDIX_MCP_GATEWAY_MAX_RESULT_BYTES,
 * STUDIX_MCP_GATEWAY_MAX_SCHEMA_BYTES, STUDIX_MCP_GATEWAY_INSECURE_HOSTS (csv) and the self origins
 * STUDIX_PUBLIC_URL / STUDIX_APP_URL.
 */
export function loadGatewayConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const parsed = EnvSchema.safeParse(nonEmpty(env));
  if (!parsed.success) {
    throw new StudixError("VALIDATION", "Invalid MCP gateway configuration", {
      details: {
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
      },
    });
  }
  const cfg = parsed.data;
  const limits: GatewayLimits = {
    ...DEFAULT_GATEWAY_LIMITS,
    ...(cfg.STUDIX_MCP_GATEWAY_TIMEOUT_MS ? { timeoutMs: cfg.STUDIX_MCP_GATEWAY_TIMEOUT_MS } : {}),
    ...(cfg.STUDIX_MCP_GATEWAY_MAX_CONCURRENCY
      ? { maxConcurrentPerWorkspace: cfg.STUDIX_MCP_GATEWAY_MAX_CONCURRENCY }
      : {}),
    ...(cfg.STUDIX_MCP_GATEWAY_MAX_RESULT_BYTES
      ? { maxResultBytes: cfg.STUDIX_MCP_GATEWAY_MAX_RESULT_BYTES }
      : {}),
    ...(cfg.STUDIX_MCP_GATEWAY_MAX_SCHEMA_BYTES
      ? { maxSchemaBytes: cfg.STUDIX_MCP_GATEWAY_MAX_SCHEMA_BYTES }
      : {}),
  };
  const selfOrigins = [cfg.STUDIX_PUBLIC_URL, cfg.STUDIX_APP_URL]
    .filter((url): url is string => url !== undefined)
    .map((url) => new URL(url).origin);
  return { limits, insecureHosts: cfg.STUDIX_MCP_GATEWAY_INSECURE_HOSTS, selfOrigins };
}
