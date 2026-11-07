import { join } from "node:path";
import {
  createDockerSandboxDriver,
  createPiTaskWorkspaceProvider,
  type PiTaskWorkspaceProvider,
  type SandboxLimits,
  type SkillBundleSource,
  sweepDockerSandboxes,
} from "@studix/agent-runtime";
import type { StorageAdapter, TenantContext } from "@studix/core";
import { MULTIX_ENV_KEY_NAMES } from "@studix/providers";
import { type Logger, StudixError } from "@studix/shared";
import type { StageContext } from "@studix/workflow";
import { z } from "zod";

/*
 * The skill sandbox of tool-using Pi stages (docs/decisions/0018-skill-sandbox.md): one Docker container per task,
 * started by the worker. Off unless STUDIX_SANDBOX=docker.
 */

const SandboxEnv = z.object({
  STUDIX_SANDBOX: z.enum(["off", "docker"]).default("off"),
  STUDIX_SANDBOX_IMAGE: z
    .string()
    .regex(/^[\w./:@-]{1,300}$/, "an image reference")
    .default("studix-sandbox:local"),
  /** Docker network of the containers; default `bridge` (open egress). */
  STUDIX_SANDBOX_NETWORK: z
    .string()
    .regex(/^[\w.-]{1,100}$/)
    .optional(),
  STUDIX_SANDBOX_CPUS: z.coerce.number().min(0.25).max(64).default(2),
  STUDIX_SANDBOX_MEMORY_MB: z.coerce.number().int().min(256).max(262_144).default(4096),
  STUDIX_SANDBOX_PIDS: z.coerce.number().int().min(32).max(65_536).default(512),
  STUDIX_SANDBOX_WALL_SECONDS: z.coerce
    .number()
    .int()
    .min(30)
    .max(6 * 3600)
    .default(1800),
  /** Local skills (`<dir>/{platform,workspace}/<skill>/`), used when the worker has no skill store. */
  STUDIX_SANDBOX_SKILLS_DIR: z.string().min(1).optional(),
  DOCKER_BIN: z.string().min(1).optional(),
});

export interface SandboxSettings {
  image: string;
  network?: string;
  limits: SandboxLimits;
  skillsDir?: string;
  docker?: string;
}

/** Parses the STUDIX_SANDBOX_* variables; undefined while the sandbox is off. Values are never echoed. */
export function loadSandboxSettings(env: NodeJS.ProcessEnv): SandboxSettings | undefined {
  const cleaned = Object.fromEntries(
    Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ""),
  );
  const parsed = SandboxEnv.safeParse(cleaned);
  if (!parsed.success) {
    const variables = parsed.error.issues.map((i) => i.path.join("."));
    throw new StudixError("VALIDATION", `Invalid sandbox configuration: ${variables.join(", ")}`, {
      details: {
        issues: parsed.error.issues.map((i) => ({ variable: i.path.join("."), message: i.message })),
      },
    });
  }
  const s = parsed.data;
  if (s.STUDIX_SANDBOX === "off") return undefined;
  return {
    image: s.STUDIX_SANDBOX_IMAGE,
    ...(s.STUDIX_SANDBOX_NETWORK ? { network: s.STUDIX_SANDBOX_NETWORK } : {}),
    limits: {
      cpus: s.STUDIX_SANDBOX_CPUS,
      memoryMb: s.STUDIX_SANDBOX_MEMORY_MB,
      pids: s.STUDIX_SANDBOX_PIDS,
      wallTimeMs: s.STUDIX_SANDBOX_WALL_SECONDS * 1000,
    },
    ...(s.STUDIX_SANDBOX_SKILLS_DIR ? { skillsDir: s.STUDIX_SANDBOX_SKILLS_DIR } : {}),
    ...(s.DOCKER_BIN ? { docker: s.DOCKER_BIN } : {}),
  };
}

const VENDOR_KEY_NAMES = MULTIX_ENV_KEY_NAMES;

export interface SandboxKeySources {
  /** The workspace's own media vendor keys (BYOK); they win. */
  workspace?: (ctx: TenantContext) => Promise<Readonly<Record<string, string>>>;
  /** Vendor keys the operator stored in the dashboard, then the worker's MULTIX vendor variables. */
  platform?: () => Promise<Readonly<Record<string, string>>>;
  env: NodeJS.ProcessEnv;
}

/**
 * The provider keys a task's container receives: media vendor keys only (for example ELEVENLABS_API_KEY),
 * picked by name from the allowlist. Database, storage, secrets-box and model keys never qualify.
 */
export async function sandboxProviderKeys(
  sources: SandboxKeySources,
  ctx: TenantContext,
): Promise<Record<string, string>> {
  const none: Readonly<Record<string, string>> = {};
  const [own, platform] = await Promise.all([sources.workspace?.(ctx) ?? none, sources.platform?.() ?? none]);
  const keys: Record<string, string> = {};
  for (const name of VENDOR_KEY_NAMES) {
    const value = own[name] || platform[name] || sources.env[name];
    if (value) keys[name] = value;
  }
  return keys;
}

export interface SkillSandbox {
  /** The workspace provider of one stage run; its results land under the stage's attempt directory. */
  forStage(stage: StageContext): PiTaskWorkspaceProvider;
}

export async function createSkillSandbox(options: {
  settings: SandboxSettings;
  workDir: string;
  skills?: SkillBundleSource;
  /** Where a task's input files are read from, on the host, before its sandbox starts. */
  storage?: Pick<StorageAdapter, "download">;
  keys: SandboxKeySources;
  logger: Logger;
}): Promise<SkillSandbox> {
  const { settings, logger, storage } = options;
  // Containers a crashed worker left behind; their tasks were already retried or failed.
  const swept = await sweepDockerSandboxes(settings.docker).catch((err: unknown) => {
    logger.warn("skill sandbox sweep failed", { error: String(err) });
    return 0;
  });
  if (swept > 0) logger.info("removed leftover skill sandboxes", { count: swept });
  const driver = createDockerSandboxDriver({
    image: settings.image,
    workRoot: join(options.workDir, "sandboxes"),
    ...(settings.network ? { network: settings.network } : {}),
    ...(settings.docker ? { docker: settings.docker } : {}),
  });
  logger.info("skill sandbox ready", {
    image: settings.image,
    network: settings.network ?? "bridge",
    skills: options.skills ? "store" : "none",
  });
  return {
    forStage(stage) {
      return createPiTaskWorkspaceProvider({
        driver,
        ...(options.skills ? { skills: options.skills } : {}),
        env: (ctx) => sandboxProviderKeys(options.keys, ctx),
        ...(storage
          ? {
              fetchInput: async (ctx: TenantContext, key: string, hostPath: string) => {
                await storage.download(ctx, key, hostPath);
              },
            }
          : {}),
        limits: settings.limits,
        outputDir: join(options.workDir, stage.job.id, `attempt-${stage.attempt}`, "sandbox-out"),
        scratchRoot: join(options.workDir, "sandboxes"),
      });
    },
  };
}
