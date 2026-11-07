import { z } from "zod";
import { StudixError } from "./errors.ts";
import { LOG_LEVELS } from "./logger.ts";

/**
 * Runtime configuration, read from the environment only. Hostnames, provider ids and model ids are
 * configuration, never code. Development/test fall back to localhost URLs; production requires them.
 */

const optionalString = z.string().min(1).optional();
const optionalUrl = z.url().optional();
const bool = z.enum(["true", "false", "1", "0"]).transform((v) => v === "true" || v === "1");
const csv = z
  .string()
  .transform((v) =>
    v
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  )
  .pipe(z.array(z.string()));
/** Origin-only URL (no trailing slash) so callers can safely concatenate paths. */
const origin = z
  .url()
  .refine((v) => /^https?:\/\//.test(v), "must be an http(s) URL")
  .transform((v) => v.replace(/\/+$/, ""));

const SSO_CLIENT_KEYS = [
  ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"],
  ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
] as const;

export const ConfigSchema = z
  .object({
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),
    PORT: z.coerce.number().int().min(1).max(65_535).default(8787),

    STUDIX_PUBLIC_URL: origin.optional(),
    STUDIX_APP_URL: origin.optional(),
    STUDIX_MARKETING_URL: origin.optional(),
    STUDIX_ALLOWED_HOSTS: csv.default([]),

    DATABASE_URL: z
      .string()
      .regex(/^postgres(ql)?:\/\//, "must be a postgres:// connection string")
      .optional(),

    S3_ENDPOINT: optionalUrl,
    /** Endpoint used only to presign client URLs when browsers reach storage on another host than the app. */
    S3_PUBLIC_ENDPOINT: optionalUrl,
    S3_REGION: z.string().min(1).default("us-east-1"),
    S3_BUCKET: optionalString,
    S3_ACCESS_KEY_ID: optionalString,
    S3_SECRET_ACCESS_KEY: optionalString,
    S3_FORCE_PATH_STYLE: bool.default(false),
    S3_SIGNED_URL_TTL_SECONDS: z.coerce.number().int().min(60).max(604_800).default(3600),

    STUDIX_API_KEY_ENV: z
      .string()
      .regex(/^[a-z0-9]{2,8}$/, "2-8 lowercase alphanumerics")
      .default("dev"),
    BETTER_AUTH_SECRET: z.string().min(32).optional(),
    /** Dashboard SSO. A provider is on only when both its client id and secret are set. */
    GITHUB_CLIENT_ID: optionalString,
    GITHUB_CLIENT_SECRET: optionalString,
    GOOGLE_CLIENT_ID: optionalString,
    GOOGLE_CLIENT_SECRET: optionalString,
    /** 32 random bytes (base64) sealing stored provider credentials; without it none can be saved. */
    STUDIX_SECRETS_KEY: optionalString,
    /** Operators' workspace (wsp_...): platform credential audit events go there instead of a tenant's. */
    STUDIX_PLATFORM_WORKSPACE_ID: optionalString,
    /** Earlier STUDIX_SECRETS_KEY values that may still open stored credentials during a rotation. */
    STUDIX_SECRETS_KEYS_PREVIOUS: csv.default([]),
    ANTHROPIC_BASE_URL: origin.default("https://api.anthropic.com"),
    /** Optional token for importing GitHub skills (raises the API rate limit); sent to api.github.com only. */
    STUDIX_GITHUB_TOKEN: optionalString,
    /** Jobs may select `planner: {runtime: "claude"}` (Claude Agent SDK on the worker). Off by default. */
    STUDIX_CLAUDE_PLANNER: bool.default(false),
    /**
     * Self-hosted/personal servers only: each user may connect their own Claude subscription, signed in
     * with Claude Code's built-in `claude setup-token`, and only the unmodified `claude` binary consumes it.
     * Off by default so a hosted multi-tenant deployment keeps the method restricted.
     */
    STUDIX_CLAUDE_SUBSCRIPTION: bool.default(false),
    /**
     * Self-hosted/personal server: workspace owners may switch the Claude planner and Claude subscriptions on
     * in the Dashboard, and a missing STUDIX_SECRETS_KEY is generated into STUDIX_SECRETS_KEY_FILE. Off by
     * default; a hosted multi-tenant deployment must leave it off.
     */
    STUDIX_SELF_HOSTED: bool.default(false),
    /** Where a self-hosted server keeps its generated master key (default `.studix/secrets.key`). */
    STUDIX_SECRETS_KEY_FILE: optionalString,

    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(1),
    JOB_LEASE_SECONDS: z.coerce.number().int().min(5).max(3600).default(60),
    JOB_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(3),
    DEFAULT_JOB_BUDGET_CENTS: z.coerce.number().int().min(0).default(500),
    DEFAULT_JOB_DEADLINE_SECONDS: z.coerce.number().int().min(10).default(1800),
    APPROVAL_COST_THRESHOLD_CENTS: z.coerce.number().int().min(0).default(1000),

    DECISION_PROVIDERS: csv.default(["rules"]),
    OPENROUTER_API_KEY: optionalString,
    OPENROUTER_BASE_URL: z.url().default("https://openrouter.ai/api/v1"),
    OPENROUTER_DECISION_MODEL: optionalString,
    TYPESAFE_API_KEY: optionalString,
    TYPESAFE_BASE_URL: optionalUrl,
    TYPESAFE_DECISION_MODEL: optionalString,

    HYPERFRAMES_BIN: optionalString,
    FFMPEG_PATH: z.string().min(1).default("ffmpeg"),
    FFPROBE_PATH: z.string().min(1).default("ffprobe"),
    MULTIX_BIN: optionalString,
    /**
     * Check every generated sound effect for a human voice (Silero VAD in the optional `speech` QA image) before
     * it joins the mix. A voiced effect is generated once more, then fails the job. Needs that image: on the
     * default one the check fails UNAVAILABLE rather than letting an unchecked effect through.
     */
    STUDIX_SPEECH_GATE: bool.default(false),
    /** Default "<vendor>:<model>" per media role; unset means the provider's built-in default. */
    MULTIX_IMAGE_MODEL: optionalString,
    MULTIX_VIDEO_MODEL: optionalString,
    MULTIX_LIPSYNC_MODEL: optionalString,
    MULTIX_VOICE_MODEL: optionalString,
    /** Speech model per language, `<language>=<vendor>:<model>[@<voice>]` comma-separated (`vi=openrouter:fish-audio/drama-3`). */
    MULTIX_VOICE_LANGUAGE_MODELS: optionalString,
    MULTIX_MUSIC_MODEL: optionalString,
    MULTIX_SFX_MODEL: optionalString,
    MULTIX_IMAGE_UPSCALE_MODEL: optionalString,
    MULTIX_VIDEO_UPSCALE_MODEL: optionalString,
    /** Let multix read ~/.multix/.env. Local development only: workers get keys from their environment. */
    MULTIX_ALLOW_HOME_ENV: bool.default(false),
    /** Longest wait for one upstream job before the call fails retryably (the job keeps its id). */
    MULTIX_WAIT_TIMEOUT_SECONDS: z.coerce.number().int().min(30).max(7200).default(900),

    OTEL_SERVICE_NAME: z.string().min(1).default("studix"),
    OTEL_EXPORTER_OTLP_ENDPOINT: optionalUrl,

    STUDIX_LIVE: bool.default(false),
  })
  .superRefine((cfg, ctx) => {
    for (const [id, secret] of SSO_CLIENT_KEYS) {
      if ((cfg[id] === undefined) !== (cfg[secret] === undefined)) {
        const missing = cfg[id] === undefined ? id : secret;
        ctx.addIssue({ code: "custom", path: [missing], message: `set ${id} and ${secret} together` });
      }
    }
    if (cfg.NODE_ENV !== "production") return;
    const required = [
      "STUDIX_PUBLIC_URL",
      "STUDIX_APP_URL",
      "DATABASE_URL",
      "S3_BUCKET",
      "S3_ACCESS_KEY_ID",
      "S3_SECRET_ACCESS_KEY",
      "BETTER_AUTH_SECRET",
    ] as const;
    for (const key of required) {
      if (cfg[key] === undefined) {
        ctx.addIssue({ code: "custom", path: [key], message: `${key} is required in production` });
      }
    }
  })
  .transform((cfg) => {
    const local = `http://localhost:${cfg.PORT}`;
    const publicUrl = cfg.STUDIX_PUBLIC_URL ?? local;
    return {
      ...cfg,
      STUDIX_PUBLIC_URL: publicUrl,
      STUDIX_APP_URL: cfg.STUDIX_APP_URL ?? publicUrl,
      STUDIX_MARKETING_URL: cfg.STUDIX_MARKETING_URL ?? publicUrl,
    };
  });

export type StudixConfig = z.output<typeof ConfigSchema>;

export interface SsoClient {
  clientId: string;
  clientSecret: string;
}

/** OAuth clients of the dashboard SSO providers that are configured; an absent provider is disabled. */
export function ssoClients(config: StudixConfig): { github?: SsoClient; google?: SsoClient } {
  const client = (clientId?: string, clientSecret?: string) =>
    clientId && clientSecret ? { clientId, clientSecret } : undefined;
  return {
    github: client(config.GITHUB_CLIENT_ID, config.GITHUB_CLIENT_SECRET),
    google: client(config.GOOGLE_CLIENT_ID, config.GOOGLE_CLIENT_SECRET),
  };
}

/** Hosts accepted in the HTTP Host header: configured URL hosts plus STUDIX_ALLOWED_HOSTS. */
export function allowedHosts(config: StudixConfig): string[] {
  const hosts = new Set(config.STUDIX_ALLOWED_HOSTS);
  for (const url of [config.STUDIX_PUBLIC_URL, config.STUDIX_APP_URL]) hosts.add(new URL(url).host);
  return [...hosts];
}

/**
 * Parse configuration from an environment map (defaults to process.env). Empty strings count as unset.
 * Throws a VALIDATION StudixError listing the offending variable names (values are never echoed).
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): StudixConfig {
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && value.trim() !== "") cleaned[key] = value.trim();
  }
  const parsed = ConfigSchema.safeParse(cleaned);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.map((issue) => ({
    variable: issue.path.join("."),
    message: issue.message,
  }));
  throw new StudixError(
    "VALIDATION",
    `Invalid configuration: ${issues.map((i) => `${i.variable} (${i.message})`).join("; ")}`,
    {
      details: { issues },
      suggestedAction: "Fix the listed environment variables; see .env.example.",
    },
  );
}
