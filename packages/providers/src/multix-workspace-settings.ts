import { createHash } from "node:crypto";
import type { TenantContext } from "@studix/core";
import { StudixError, toStudixError } from "@studix/shared";
import { createSpawnMultixRunner } from "./multix-cli-runner.ts";
import {
  createMultixProviderFromConfig,
  type MultixProvider,
  type MultixProviderOptions,
} from "./multix-provider.ts";
import { DEFAULT_MULTIX_MODELS, type MultixRole } from "./multix-routes.ts";

/** The server settings a Multix provider is built from (the MULTIX_* part of StudixConfig). */
export type MultixConfig = Parameters<typeof createMultixProviderFromConfig>[0];

export const MULTIX_ROLES = Object.keys(DEFAULT_MULTIX_MODELS) as MultixRole[];

/** The MULTIX_*_MODEL variable of each role. */
export const MULTIX_ROLE_ENV: Readonly<Record<MultixRole, keyof MultixConfig>> = {
  image: "MULTIX_IMAGE_MODEL",
  video: "MULTIX_VIDEO_MODEL",
  lipsync: "MULTIX_LIPSYNC_MODEL",
  voice: "MULTIX_VOICE_MODEL",
  music: "MULTIX_MUSIC_MODEL",
  sfx: "MULTIX_SFX_MODEL",
  imageUpscale: "MULTIX_IMAGE_UPSCALE_MODEL",
  videoUpscale: "MULTIX_VIDEO_UPSCALE_MODEL",
};

/** What a workspace overrides from the dashboard; null (or a role missing from `models`) keeps the server value. */
export interface MultixWorkspaceOverrides {
  enabled: boolean | null;
  waitTimeoutSeconds: number | null;
  models: Readonly<Record<string, string>>;
  voiceLanguageModels: string | null;
}

/**
 * The server config with a workspace's overrides applied. `enabled: false` drops MULTIX_BIN, which turns the
 * provider off; `enabled: true` cannot turn on a server without the CLI.
 */
export function multixConfigFor(
  config: MultixConfig,
  overrides: MultixWorkspaceOverrides | undefined,
): MultixConfig {
  if (!overrides) return config;
  const next: MultixConfig = { ...config };
  if (overrides.enabled === false) next.MULTIX_BIN = undefined;
  if (overrides.waitTimeoutSeconds !== null) next.MULTIX_WAIT_TIMEOUT_SECONDS = overrides.waitTimeoutSeconds;
  if (overrides.voiceLanguageModels !== null)
    next.MULTIX_VOICE_LANGUAGE_MODELS = overrides.voiceLanguageModels;
  for (const role of MULTIX_ROLES) {
    const model = overrides.models[role];
    if (model) (next as Record<string, unknown>)[MULTIX_ROLE_ENV[role]] = model;
  }
  return next;
}

/**
 * Throw VALIDATION unless the overrides build a provider: every model must be a known `<vendor>:<model>` route
 * of its role and every voice route must parse. The provider constructor runs the same checks jobs rely on.
 */
export function assertMultixOverrides(config: MultixConfig, overrides: MultixWorkspaceOverrides): void {
  const unknown = Object.keys(overrides.models).filter((role) => !(MULTIX_ROLES as string[]).includes(role));
  if (unknown.length > 0) {
    throw new StudixError("VALIDATION", `Unknown Multix role: ${unknown.join(", ")}`, { retryable: false });
  }
  try {
    createMultixProviderFromConfig(multixConfigFor(config, overrides));
  } catch (err) {
    const cause = toStudixError(err);
    throw new StudixError("VALIDATION", `Invalid Multix settings: ${cause.message}`, {
      retryable: false,
      cause: err,
    });
  }
}

const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export interface WorkspaceMultixProvidersOptions {
  config: MultixConfig;
  /** Shared by every provider built here (env, credential sources, runner, clock). */
  options?: Omit<
    MultixProviderOptions,
    "bin" | "models" | "voiceLanguageModels" | "allowHomeEnv" | "waitTimeoutMs"
  >;
  /** The workspace's saved overrides; undefined when it saved none. */
  load(ctx: TenantContext): Promise<MultixWorkspaceOverrides | undefined>;
}

export interface WorkspaceMultixProviders {
  /** Provider of the server settings, used by workspaces that saved none. */
  readonly server: MultixProvider;
  /** The provider for this workspace's settings; a failed read keeps the server provider. */
  forWorkspace(ctx: TenantContext): Promise<MultixProvider>;
}

/**
 * One provider per distinct settings fingerprint, so workspaces with equal settings share its capability
 * cache and a changed setting applies to the next job without a restart.
 */
export function createWorkspaceMultixProviders(
  deps: WorkspaceMultixProvidersOptions,
): WorkspaceMultixProviders {
  const server = createMultixProviderFromConfig(deps.config, deps.options);
  const serverKey = fingerprint(deps.config);
  const built = new Map<string, MultixProvider>();
  return {
    server,
    async forWorkspace(ctx) {
      let overrides: MultixWorkspaceOverrides | undefined;
      try {
        overrides = await deps.load(ctx);
      } catch {
        return server;
      }
      if (!overrides) return server;
      const config = multixConfigFor(deps.config, overrides);
      const key = fingerprint(config);
      if (key === serverKey) return server;
      let provider = built.get(key);
      if (!provider) {
        try {
          provider = createMultixProviderFromConfig(config, deps.options);
        } catch {
          // Settings saved by an older version that no longer validate fall back to the server's.
          return server;
        }
        built.set(key, provider);
      }
      return provider;
    },
  };
}

const VERSION = /\d+\.\d+\.\d+(?:-[\w.]+)?/;

/** `multix --version` of the CLI at `bin`, or undefined when it cannot be read. Calls no provider. */
export async function readMultixVersion(
  bin: string | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env,
  cwd: string = process.cwd(),
): Promise<string | undefined> {
  if (!bin?.trim()) return undefined;
  const childEnv: Record<string, string> = { MULTIX_DISABLE_HOME_ENV: "1" };
  for (const name of ["PATH", "Path", "PATHEXT", "SystemRoot", "HOME", "USERPROFILE", "TEMP", "TMP"]) {
    const value = env[name];
    if (value) childEnv[name] = value;
  }
  try {
    const run = await createSpawnMultixRunner(bin.trim())(["--version"], {
      cwd,
      env: childEnv,
      timeoutMs: 15_000,
    });
    return run.exitCode === 0 ? run.stdout.match(VERSION)?.[0] : undefined;
  } catch {
    return undefined;
  }
}
