import { type ActorRef, type AuditRepository, actorRef, type TenantContext } from "@studix/core";
import type { PlatformCredentialRecord, PlatformCredentialRepository } from "@studix/database";
import { type Logger, registerSecret, StudixError } from "@studix/shared";
import { z } from "zod";
import type { SecretBox } from "./secret-box.ts";

/**
 * Platform-level credentials the operator manages from the dashboard (the media vendor keys Studix gives
 * the Multix CLI). One source of truth per name: the sealed database row wins over an environment value,
 * and a revoked row switches the name off even when the environment still has it. The same sealed rows are
 * read by the app and by the worker through `createLiveCredentialEnv`, so a change reaches both without a
 * redeploy and without restarting a job that is already running (a running child keeps the env it started
 * with).
 */

/** Printable ASCII without spaces: no newline, NUL or quote can smuggle a second variable or option. */
const API_KEY = z
  .string()
  .min(8, "too short")
  .max(512, "too long")
  .regex(/^[\x21-\x7e]+$/, "must be one token of printable ASCII characters without spaces");

const SaveInput = z.object({ apiKey: API_KEY }).strict();

export type PlatformCredentialSource = "platform" | "env" | "none";
export type PlatformCredentialStatus = "configured" | "missing" | "revoked" | "invalid";

export interface PlatformCredentialView {
  /** Stable id used in URLs (for media vendors, the vendor name). */
  id: string;
  /** Name of the environment variable the key becomes in the CLI process. */
  envName: string;
  status: PlatformCredentialStatus;
  /** Where an active value comes from; `none` when missing or revoked. */
  source: PlatformCredentialSource;
  /** Masked tail of the stored key, e.g. `…a1b2`. The value itself is never returned. */
  keyHint?: string;
  version?: number;
  updatedAt?: string;
  updatedBy?: ActorRef;
  lastTest?: { ok: boolean; at: string; outcome: string; message?: string };
}

export interface PlatformCredentialService {
  list(): Promise<PlatformCredentialView[]>;
  save(ctx: TenantContext, id: string, input: unknown): Promise<PlatformCredentialView>;
  revoke(ctx: TenantContext, id: string): Promise<PlatformCredentialView>;
  /** Remember the outcome of a connectivity check for the dashboard. */
  recordTest(id: string, result: { ok: boolean; outcome: string; message?: string }): Promise<void>;
}

export interface PlatformCredentialServiceDeps {
  credentials: PlatformCredentialRepository;
  audit: AuditRepository;
  /** Without a secrets key nothing can be stored; reads of environment values still work. */
  secrets?: SecretBox;
  /** Allowlist: credential id -> environment variable name. Nothing else can be stored. */
  names: Readonly<Record<string, string>>;
  /** Environment values count as configured when nothing is stored (names only are read). */
  env?: Readonly<Record<string, string | undefined>>;
  clock?: { now(): Date };
}

const SUBJECT = "platform_credential";
const NO_SECRETS_KEY =
  "Encrypted credential storage is not configured on this server. The operator must set STUDIX_SECRETS_KEY.";

/** The AAD binds a ciphertext to its name, so a sealed value copied to another row fails to open. */
export const platformCredentialAad = (envName: string) => `platform-credential:${envName}`;

export function keyHintOf(apiKey: string): string {
  return apiKey.length >= 12 ? `…${apiKey.slice(-4)}` : "…";
}

export function createPlatformCredentialService(
  deps: PlatformCredentialServiceDeps,
): PlatformCredentialService {
  const entries = Object.entries(deps.names);

  const envNameOf = (id: string): string => {
    const name = Object.hasOwn(deps.names, id) ? deps.names[id] : undefined;
    if (!name) {
      throw new StudixError("NOT_FOUND", `Unknown credential "${id}"`, {
        retryable: false,
        details: { known: entries.map(([known]) => known) },
      });
    }
    return name;
  };

  const requireSecrets = (): SecretBox => {
    if (!deps.secrets) {
      throw new StudixError("UNAVAILABLE", NO_SECRETS_KEY, {
        retryable: false,
        suggestedAction: "Set STUDIX_SECRETS_KEY on the app and the worker, then save the key again.",
      });
    }
    return deps.secrets;
  };

  function toView(
    id: string,
    envName: string,
    row: PlatformCredentialRecord | undefined,
  ): PlatformCredentialView {
    const base = { id, envName };
    if (row?.status === "revoked") {
      return {
        ...base,
        status: "revoked",
        source: "none",
        version: row.version,
        updatedAt: row.updatedAt.toISOString(),
        updatedBy: row.updatedBy,
      };
    }
    if (row?.secretCiphertext) {
      let readable = true;
      try {
        deps.secrets?.open(row.secretCiphertext, platformCredentialAad(envName));
        if (!deps.secrets) readable = false;
      } catch {
        readable = false;
      }
      const last = row.lastTest;
      return {
        ...base,
        status: readable && last?.ok !== false ? "configured" : "invalid",
        source: "platform",
        ...(row.secretHint ? { keyHint: row.secretHint } : {}),
        version: row.version,
        updatedAt: row.updatedAt.toISOString(),
        updatedBy: row.updatedBy,
        ...(last ? { lastTest: last } : {}),
      };
    }
    const fromEnv = (deps.env?.[envName] ?? "") !== "";
    return { ...base, status: fromEnv ? "configured" : "missing", source: fromEnv ? "env" : "none" };
  }

  const audit = (
    ctx: TenantContext,
    action: string,
    id: string,
    envName: string,
    v: PlatformCredentialView,
  ) =>
    deps.audit.append(ctx, {
      actor: actorRef(ctx.actor),
      action: `${SUBJECT}.${action}`,
      subjectType: SUBJECT,
      subjectId: id,
      // Names and a masked hint only: the key value never enters the audit trail.
      data: { envName, status: v.status, keyHint: v.keyHint, version: v.version },
    });

  return {
    async list() {
      const rows = new Map((await deps.credentials.list()).map((row) => [row.name, row]));
      return entries.map(([id, envName]) => toView(id, envName, rows.get(envName)));
    },

    async save(ctx, id, rawInput) {
      const envName = envNameOf(id);
      const parsed = SaveInput.safeParse(rawInput);
      if (!parsed.success) {
        throw new StudixError("VALIDATION", "Invalid credential", {
          retryable: false,
          // Paths only; zod messages for a value never echo it back.
          details: {
            issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
          },
          suggestedAction: 'Send {"apiKey": "<key>"} with the vendor key as one token.',
        });
      }
      const secrets = requireSecrets();
      const { apiKey } = parsed.data;
      registerSecret(apiKey);
      const row = await deps.credentials.save(
        envName,
        {
          secretCiphertext: secrets.seal(apiKey, platformCredentialAad(envName)),
          secretHint: keyHintOf(apiKey),
        },
        actorRef(ctx.actor),
      );
      const result = toView(id, envName, row);
      await audit(ctx, "saved", id, envName, result);
      return result;
    },

    async revoke(ctx, id) {
      const envName = envNameOf(id);
      // A name that was never stored still gets a marker, so revoking also switches off an environment value.
      const row = await deps.credentials.revoke(envName, actorRef(ctx.actor));
      const result = toView(id, envName, row);
      await audit(ctx, "revoked", id, envName, result);
      return result;
    },

    async recordTest(id, result) {
      const envName = envNameOf(id);
      await deps.credentials.recordTest(envName, {
        ok: result.ok,
        outcome: result.outcome,
        at: (deps.clock?.now() ?? new Date()).toISOString(),
        ...(result.message ? { message: result.message } : {}),
      });
    },
  };
}

export interface LiveCredentialEnvOptions {
  credentials: PlatformCredentialRepository;
  secrets?: SecretBox;
  /** Process environment used when nothing is stored for a name. */
  base: Readonly<Record<string, string | undefined>>;
  /** Names the stored rows may override; any other row is ignored. */
  names: readonly string[];
  logger?: Logger;
  /** How long a loaded snapshot is trusted before the next background reload. Default 15 seconds. */
  ttlMs?: number;
}

export interface LiveCredentialEnv {
  /** Read-only view: stored credentials over the base environment. Safe to hand to the Multix provider. */
  env: Readonly<Record<string, string | undefined>>;
  /** Reload now (awaited at startup and after the operator changes a key). Keeps the last good snapshot on failure. */
  refresh(): Promise<void>;
  /** Begin periodic reloads; the returned function stops them. The timer never keeps the process alive. */
  start(): () => void;
}

/**
 * The environment the Multix child is built from: sealed rows from the database over the process
 * environment. A row that cannot be opened (wrong key, tampered) is treated as absent, never replaced by
 * the environment value, and a revoked row hides the environment value.
 */
export function createLiveCredentialEnv(options: LiveCredentialEnvOptions): LiveCredentialEnv {
  const allowed = new Set(options.names);
  let overlay = new Map<string, string | null>();
  // Until the first successful load nobody knows which names were revoked, so managed names read as unset
  // rather than falling back to an environment value an operator may have revoked.
  let loaded = false;
  const reload = async () => {
    const next = new Map<string, string | null>();
    for (const row of await options.credentials.list()) {
      if (!allowed.has(row.name)) continue;
      if (row.status === "revoked" || !row.secretCiphertext) {
        next.set(row.name, null);
        continue;
      }
      if (!options.secrets) {
        options.logger?.warn(
          "a platform credential is stored but STUDIX_SECRETS_KEY is not set here; treating it as missing",
          { name: row.name },
        );
        next.set(row.name, null);
        continue;
      }
      try {
        const value = options.secrets.open(row.secretCiphertext, platformCredentialAad(row.name));
        registerSecret(value);
        next.set(row.name, value);
      } catch {
        options.logger?.warn("stored platform credential cannot be opened; treating it as missing", {
          name: row.name,
        });
        next.set(row.name, null);
      }
    }
    overlay = next;
    loaded = true;
  };

  const env = new Proxy(options.base as Record<string, string | undefined>, {
    get(target, prop) {
      if (typeof prop !== "string") return undefined;
      if (overlay.has(prop)) return overlay.get(prop) ?? undefined;
      if (!loaded && allowed.has(prop)) return undefined;
      return target[prop];
    },
    has(target, prop) {
      return (
        typeof prop === "string" &&
        (overlay.has(prop) ? overlay.get(prop) != null : (loaded || !allowed.has(prop)) && prop in target)
      );
    },
    set() {
      return false;
    },
    deleteProperty() {
      return false;
    },
  });

  return {
    env,
    async refresh() {
      try {
        await reload();
      } catch (err) {
        options.logger?.warn("platform credential reload failed; keeping the previous values", {
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    },
    start() {
      const timer = setInterval(() => {
        void reload().catch((err) =>
          options.logger?.warn("platform credential reload failed; keeping the previous values", {
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }, options.ttlMs ?? 15_000);
      timer.unref();
      return () => clearInterval(timer);
    },
  };
}
