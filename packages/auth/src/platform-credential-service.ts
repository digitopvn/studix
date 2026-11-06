import { type AuditRepository, actorRef, assertPlatformOperator, type TenantContext } from "@studix/core";
import type { PlatformCredentialRecord, PlatformCredentialRepository } from "@studix/database";
import { type Clock, type Logger, registerSecret, StudixError, systemClock } from "@studix/shared";
import type { SecretBox } from "./secret-box.ts";

/*
 * Platform-level credentials that a platform operator manages from the dashboard (today: the vendor keys
 * the Multix CLI receives). They are stored sealed with the same master key as provider connections
 * (STUDIX_SECRETS_KEY), so there is no second vault. A stored value overrides the process environment
 * variable of the same name, and revoking it falls back to the environment. Values are accepted in
 * request bodies only; every view carries a hint and metadata, never the key, even for the operator.
 * Only names on the injected allowlist are accepted, so this is not an arbitrary environment editor.
 */

export type PlatformCredentialSource = "dashboard" | "environment" | "missing";

export interface PlatformTestView {
  ok: boolean;
  at: Date;
  detail?: string;
}

/** What the dashboard sees; the key itself never leaves the service. */
export interface PlatformCredentialView {
  name: string;
  source: PlatformCredentialSource;
  /** Last characters of a dashboard-stored key, e.g. `…a1b2`. */
  keyHint?: string;
  version?: number;
  updatedAt?: Date;
  updatedBy?: { type: string; id: string };
  lastTest?: PlatformTestView;
}

export interface PlatformCredentialsOverview {
  /** `unavailable` until STUDIX_SECRETS_KEY is set: nothing can be stored without it. */
  storage: "available" | "unavailable";
  credentials: PlatformCredentialView[];
}

/** Stored values the worker and app pass to the Multix child, with a token that changes on every change. */
export interface PlatformCredentialValues {
  values: Readonly<Record<string, string>>;
  /** Changes whenever a stored value is added, rotated or revoked. */
  revision: string;
}

export interface PlatformCredentialService {
  overview(ctx: TenantContext): Promise<PlatformCredentialsOverview>;
  /** Store or replace a credential (operator dashboard session only). */
  set(ctx: TenantContext, name: string, value: string): Promise<PlatformCredentialView>;
  /** Remove the stored credential; the environment value, if any, applies again. */
  revoke(ctx: TenantContext, name: string): Promise<PlatformCredentialView>;
  /** Persist the outcome of a connection test (operator only). */
  recordTest(ctx: TenantContext, name: string, result: { ok: boolean; detail?: string }): Promise<void>;
  /**
   * Stored plaintext values for the processes that call vendors. Not a user-facing call: it never throws
   * (an unreadable row is skipped and logged) and is cached for a few seconds.
   */
  loadValues(): Promise<PlatformCredentialValues>;
  /** True when the allowlist contains the name. */
  isManaged(name: string): boolean;
}

export interface PlatformCredentialServiceDeps {
  credentials: PlatformCredentialRepository;
  audit: AuditRepository;
  /** Absent without STUDIX_SECRETS_KEY: nothing is stored or read, and writes answer UNAVAILABLE. */
  secrets?: SecretBox;
  /** Variable names that may be stored (the Multix vendor keys); anything else is refused. */
  allowedNames: readonly string[];
  /** The process environment, consulted only to say whether a variable is set. */
  env?: Readonly<Record<string, string | undefined>>;
  /** How long `loadValues` reuses the database read. */
  cacheMs?: number;
  clock?: Clock;
  logger?: Logger;
}

const SUBJECT = "platform_credential";
const VALUE_PATTERN = /^[\x21-\x7e]{8,512}$/;
const DEFAULT_CACHE_MS = 5_000;

function aad(name: string): string {
  return `platform:${name}`;
}

function hintOf(value: string): string {
  return `…${value.slice(-4)}`;
}

export function createPlatformCredentialService(
  deps: PlatformCredentialServiceDeps,
): PlatformCredentialService {
  const environment = deps.env ?? {};
  const clock = deps.clock ?? systemClock;
  const cacheMs = deps.cacheMs ?? DEFAULT_CACHE_MS;
  const allowed = new Set(deps.allowedNames);
  let cached: { at: number; value: PlatformCredentialValues } | undefined;
  let warnedRevision: string | undefined;

  const secretsOrThrow = (): SecretBox => {
    if (!deps.secrets) {
      throw new StudixError("UNAVAILABLE", "Credentials cannot be stored on this server", {
        retryable: false,
        suggestedAction: "Set STUDIX_SECRETS_KEY (32 random bytes, base64) on the app and the worker.",
      });
    }
    return deps.secrets;
  };

  const assertManaged = (name: string): void => {
    if (!allowed.has(name)) {
      throw new StudixError("VALIDATION", "Unknown credential name", {
        retryable: false,
        details: { name: name.slice(0, 64), allowed: [...allowed] },
        suggestedAction: "Use one of the listed media provider key names.",
      });
    }
  };

  const view = (name: string, row: PlatformCredentialRecord | undefined): PlatformCredentialView => {
    if (!row) return { name, source: environment[name] ? "environment" : "missing" };
    return {
      name,
      source: "dashboard",
      keyHint: row.secretHint,
      version: row.version,
      updatedAt: row.updatedAt,
      updatedBy: row.updatedBy,
      ...(row.lastTest
        ? {
            lastTest: {
              ok: row.lastTest.ok,
              at: row.lastTest.at,
              ...(row.lastTest.detail ? { detail: row.lastTest.detail } : {}),
            },
          }
        : {}),
    };
  };

  const audit = (ctx: TenantContext, action: string, name: string, extra: Record<string, unknown> = {}) =>
    deps.audit.append(ctx, {
      actor: actorRef(ctx.actor),
      action: `${SUBJECT}.${action}`,
      subjectType: SUBJECT,
      subjectId: name,
      data: { name, ...extra },
    });

  const invalidate = () => {
    cached = undefined;
  };

  return {
    isManaged: (name) => allowed.has(name),

    async overview(ctx) {
      assertPlatformOperator(ctx);
      const rows = new Map((await deps.credentials.list()).map((r) => [r.name, r]));
      return {
        storage: deps.secrets ? "available" : "unavailable",
        credentials: deps.allowedNames.map((name) => view(name, rows.get(name))),
      };
    },

    async set(ctx, name, value) {
      assertPlatformOperator(ctx);
      assertManaged(name);
      const box = secretsOrThrow();
      const trimmed = value.trim();
      if (!VALUE_PATTERN.test(trimmed)) {
        throw new StudixError("VALIDATION", "The key must be 8-512 visible characters without spaces", {
          retryable: false,
          details: { field: "value" },
        });
      }
      registerSecret(trimmed);
      const row = await deps.credentials.upsert(
        { name, secretCiphertext: box.seal(trimmed, aad(name)), secretHint: hintOf(trimmed) },
        actorRef(ctx.actor),
      );
      invalidate();
      await audit(ctx, row.version > 1 ? "rotated" : "created", name, {
        keyHint: row.secretHint,
        version: row.version,
        masterKeyId: box.keyId,
      });
      return view(name, row);
    },

    async revoke(ctx, name) {
      assertPlatformOperator(ctx);
      assertManaged(name);
      if (!(await deps.credentials.delete(name))) {
        throw new StudixError("NOT_FOUND", "No dashboard-stored credential with that name", {
          retryable: false,
          suggestedAction: "A key that comes from the environment is changed in the deployment settings.",
        });
      }
      invalidate();
      await audit(ctx, "revoked", name);
      return view(name, undefined);
    },

    async recordTest(ctx, name, result) {
      assertPlatformOperator(ctx);
      assertManaged(name);
      const stored = await deps.credentials.recordTest(name, {
        ok: result.ok,
        at: clock.now(),
        ...(result.detail ? { detail: result.detail.slice(0, 300) } : {}),
      });
      if (stored) await audit(ctx, "tested", name, { ok: result.ok });
    },

    async loadValues() {
      const now = clock.now().getTime();
      if (cached && now - cached.at < cacheMs) return cached.value;
      const box = deps.secrets;
      if (!box) return { values: {}, revision: "none" };
      let rows: PlatformCredentialRecord[];
      try {
        rows = await deps.credentials.list();
      } catch (err) {
        deps.logger?.warn("platform credentials could not be read; using the previous values", {
          error: err instanceof Error ? err.message : String(err),
        });
        return cached?.value ?? { values: {}, revision: "unavailable" };
      }
      const values: Record<string, string> = {};
      const revision: string[] = [];
      const unreadable: string[] = [];
      for (const row of rows) {
        if (!allowed.has(row.name)) continue;
        try {
          const plain = box.open(row.secretCiphertext, aad(row.name));
          registerSecret(plain);
          values[row.name] = plain;
          revision.push(`${row.name}:${row.version}`);
        } catch {
          unreadable.push(row.name);
        }
      }
      const token = `${box.keyId}|${revision.join(",")}`;
      if (unreadable.length > 0 && warnedRevision !== token) {
        warnedRevision = token;
        deps.logger?.warn("stored platform credentials cannot be opened with the current master keys", {
          names: unreadable,
        });
      }
      const value = { values, revision: token };
      cached = { at: now, value };
      return value;
    },
  };
}
