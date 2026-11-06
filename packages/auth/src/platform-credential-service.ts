import {
  type ActorRef,
  type AuditRepository,
  actorRef,
  assertPermission,
  type TenantContext,
} from "@studix/core";
import type {
  PlatformSecretRecord,
  PlatformSecretRepository,
  PlatformSecretTestRecord,
} from "@studix/database";
import {
  PLATFORM_SECRET_SPECS,
  type PlatformSecretSpec,
  platformSecretSpec,
  STORAGE_CREDENTIALS_NAME,
  type StorageCredentialPair,
  StudixError,
  type StudixErrorPayload,
} from "@studix/shared";
import { z } from "zod";
import { platformSecretAad } from "./platform-secret-source.ts";
import type { SecretBox } from "./secret-box.ts";

/*
 * Operator-only management of the platform's own credentials: the object-storage access key and the media
 * vendor keys. Values go in through a request body once, are sealed with the provider-connection master key
 * and never come back out: every view carries a status, a hint and metadata only. Each credential has one
 * source of truth at a time: a value stored here wins, and revoking it hands the variable back to the
 * deployment environment. Nothing is copied from the environment into the database.
 */

export type CredentialStatus = "configured" | "missing" | "invalid" | "unverified";
export type CredentialSource = "dashboard" | "environment" | "none";

export interface PlatformTestView {
  ok: boolean;
  at: Date;
  latencyMs: number;
  /** The step that failed (storage: put/get/head/delete) or the check that ran. */
  step?: string;
  httpStatus?: number;
  error?: StudixErrorPayload;
}

export interface PlatformCredentialView {
  name: string;
  label: string;
  group: PlatformSecretSpec["group"];
  vendor?: string;
  kinds?: readonly string[];
  status: CredentialStatus;
  source: CredentialSource;
  /** Last four characters of the key id (storage) or the key; never enough to use it. */
  hint?: string;
  /** Present for a dashboard-held credential. */
  version?: number;
  updatedAt?: Date;
  updatedBy?: ActorRef;
  lastTest?: PlatformTestView;
  /** The environment also defines this variable; revoking the dashboard value falls back to it. */
  environmentFallback: boolean;
}

export interface StorageProbeOutcome {
  ok: boolean;
  latencyMs: number;
  step?: "put" | "get" | "head" | "delete";
  status?: number;
  s3Code?: string;
  message?: string;
}

/** What the service needs from object storage; implemented where the S3 adapter is built. */
export interface PlatformStoragePort {
  describe(): {
    endpoint?: string;
    publicEndpoint?: string;
    bucket: string;
    region: string;
    forcePathStyle: boolean;
    signedUrlTtlSeconds: number;
  };
  /** Put, get, head and delete a throwaway object; with a pair, using those credentials instead of the active ones. */
  probe(candidate?: StorageCredentialPair): Promise<StorageProbeOutcome>;
}

export interface MediaCheckOutcome {
  /** `multix check` ran; names are the media key variables the CLI found. */
  found: string[];
}

/** What the service needs from the Multix provider of this process. */
export interface PlatformMediaPort {
  executable(): { configured: boolean; path?: string; reason?: string };
  /** `multix check --json` with the live environment; throws the provider's typed error when the CLI cannot run. */
  check(): Promise<MediaCheckOutcome>;
}

export interface VendorKeyVerdict {
  verdict: "available" | "invalid" | "unverified";
  httpStatus?: number;
  note?: string;
}

/** A free, read-only authentication check against the vendor; absent for vendors that offer none. */
export type VendorKeyTester = (name: string, value: string) => Promise<VendorKeyVerdict | undefined>;

export interface PlatformCredentialsOverview {
  /** `unavailable` when STUDIX_SECRETS_KEY is not set: nothing can be stored, the environment still works. */
  secretStorage: "available" | "unavailable";
  storage: {
    configured: boolean;
    endpoint?: string;
    publicEndpoint?: string;
    bucket?: string;
    region?: string;
    forcePathStyle?: boolean;
    signedUrlTtlSeconds?: number;
    credentials: PlatformCredentialView;
  };
  media: {
    executable: { configured: boolean; path?: string; reason?: string };
    /** Result of the last `multix check` run from this page; absent until one ran. */
    lastCheck?: PlatformTestView & { found?: string[] };
    vendors: PlatformCredentialView[];
  };
  apply: {
    /** A change reaches the app and the worker without a restart. */
    restartRequired: false;
    withinSeconds: number;
    runningJobs: string;
    scope: string;
  };
}

export interface PlatformCredentialService {
  overview(ctx: TenantContext): Promise<PlatformCredentialsOverview>;
  /** Store or replace the storage key pair after a real write/read/delete with it; nothing is saved on failure. */
  saveStorageCredentials(ctx: TenantContext, input: unknown): Promise<PlatformCredentialsOverview>;
  saveMediaKey(ctx: TenantContext, name: string, input: unknown): Promise<PlatformCredentialsOverview>;
  /** Remove the dashboard value; the environment's (if any) takes over. */
  revoke(ctx: TenantContext, name: string): Promise<PlatformCredentialsOverview>;
  testStorage(ctx: TenantContext): Promise<PlatformTestView>;
  testMediaKey(ctx: TenantContext, name: string): Promise<PlatformTestView>;
  checkMultix(ctx: TenantContext): Promise<PlatformTestView & { found: string[] }>;
}

export interface PlatformCredentialServiceDeps {
  secrets: PlatformSecretRepository;
  box?: SecretBox;
  audit: AuditRepository;
  /** The deployment environment, read only to learn which variables it defines (and the storage key's hint). */
  env: Readonly<Record<string, string | undefined>>;
  storage?: PlatformStoragePort;
  media?: PlatformMediaPort;
  vendorTester?: VendorKeyTester;
  /** Called after a change so this process uses the new value immediately. */
  onChanged?: () => Promise<void>;
  now?: () => Date;
  refreshSeconds?: number;
}

const SUBJECT = "platform_secret";
const KEY_SHAPE = /^[\x21-\x7e]{8,512}$/;

const MediaKeyInput = z
  .object({ apiKey: z.string().trim().regex(KEY_SHAPE, "must be an API key without spaces") })
  .strict();
const StorageInput = z
  .object({
    accessKeyId: z.string().trim().regex(KEY_SHAPE, "must be an access key id without spaces"),
    secretAccessKey: z.string().trim().regex(KEY_SHAPE, "must be a secret access key without spaces"),
  })
  .strict();

function validation(message: string, issues?: z.core.$ZodIssue[]): StudixError {
  return new StudixError("VALIDATION", message, {
    retryable: false,
    ...(issues
      ? { details: { issues: issues.map((i) => ({ path: i.path.join("."), message: i.message })) } }
      : {}),
  });
}

function parse<T>(schema: z.ZodType<T>, input: unknown, what: string): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw validation(`Invalid ${what}`, parsed.error.issues);
  return parsed.data;
}

const hintOf = (value: string) => `…${value.slice(-4)}`;

export function createPlatformCredentialService(
  deps: PlatformCredentialServiceDeps,
): PlatformCredentialService {
  const now = deps.now ?? (() => new Date());
  // The source re-reads every 15 s and the storage client may reuse its identity for up to 15 s more.
  const refreshSeconds = deps.refreshSeconds ?? 30;
  /** Outcomes for credentials the environment holds: there is no row to keep them on. */
  const envTests = new Map<string, PlatformTestView>();
  let lastCheck: (PlatformTestView & { found?: string[] }) | undefined;

  const requireBox = (): SecretBox => {
    if (!deps.box) {
      throw new StudixError("UNAVAILABLE", "Encrypted credential storage is not configured on this server", {
        retryable: false,
        suggestedAction:
          "Set STUDIX_SECRETS_KEY (32 random bytes, base64) on the app and the worker, then retry. Until then credentials stay in the deployment environment.",
      });
    }
    return deps.box;
  };

  const specOf = (name: string, group: PlatformSecretSpec["group"]): PlatformSecretSpec => {
    const spec = platformSecretSpec(name);
    if (!spec || spec.group !== group) {
      throw new StudixError("NOT_FOUND", "Unknown platform credential", {
        retryable: false,
        details: { allowed: PLATFORM_SECRET_SPECS.filter((s) => s.group === group).map((s) => s.name) },
      });
    }
    return spec;
  };

  const envHas = (name: string): boolean =>
    name === STORAGE_CREDENTIALS_NAME
      ? Boolean(deps.env.S3_ACCESS_KEY_ID && deps.env.S3_SECRET_ACCESS_KEY)
      : Boolean(deps.env[name]);

  const testView = (row: PlatformSecretRecord | undefined, name: string): PlatformTestView | undefined =>
    row ? row.lastTest : envTests.get(name);

  function view(spec: PlatformSecretSpec, row: PlatformSecretRecord | undefined): PlatformCredentialView {
    const environmentFallback = envHas(spec.name);
    const base = {
      name: spec.name,
      label: spec.label,
      group: spec.group,
      ...(spec.vendor ? { vendor: spec.vendor } : {}),
      ...(spec.kinds ? { kinds: spec.kinds } : {}),
      environmentFallback,
    };
    const lastTest = testView(row, spec.name);
    if (row) {
      return {
        ...base,
        status: row.status === "available" ? "configured" : row.status,
        source: "dashboard",
        hint: row.secretHint,
        version: row.version,
        updatedAt: row.updatedAt,
        updatedBy: row.updatedBy,
        ...(lastTest ? { lastTest } : {}),
      };
    }
    if (environmentFallback) {
      const envKey = spec.name === STORAGE_CREDENTIALS_NAME ? deps.env.S3_ACCESS_KEY_ID : deps.env[spec.name];
      return {
        ...base,
        status: lastTest && !lastTest.ok ? "invalid" : "configured",
        source: "environment",
        ...(envKey ? { hint: hintOf(envKey) } : {}),
        ...(lastTest ? { lastTest } : {}),
      };
    }
    return { ...base, status: "missing", source: "none" };
  }

  async function overview(ctx: TenantContext): Promise<PlatformCredentialsOverview> {
    assertPermission(ctx, "platform:manage");
    const rows = new Map((await deps.secrets.list()).map((row) => [row.name, row]));
    const storageSpec = platformSecretSpec(STORAGE_CREDENTIALS_NAME)!;
    const described = deps.storage?.describe();
    return {
      secretStorage: deps.box ? "available" : "unavailable",
      storage: {
        configured: Boolean(described),
        ...(described
          ? {
              ...(described.endpoint ? { endpoint: described.endpoint } : {}),
              ...(described.publicEndpoint ? { publicEndpoint: described.publicEndpoint } : {}),
              bucket: described.bucket,
              region: described.region,
              forcePathStyle: described.forcePathStyle,
              signedUrlTtlSeconds: described.signedUrlTtlSeconds,
            }
          : {}),
        credentials: view(storageSpec, rows.get(STORAGE_CREDENTIALS_NAME)),
      },
      media: {
        executable: deps.media?.executable() ?? { configured: false, reason: "MULTIX_BIN is not set" },
        ...(lastCheck ? { lastCheck } : {}),
        vendors: PLATFORM_SECRET_SPECS.filter((s) => s.group === "media").map((spec) =>
          view(spec, rows.get(spec.name)),
        ),
      },
      apply: {
        restartRequired: false,
        withinSeconds: refreshSeconds,
        runningJobs:
          "A job already running keeps the credential it started with; the next call it makes uses the new one.",
        scope:
          "Applies to the app and the worker that share this database. OPENROUTER_API_KEY stored here is handed to Multix only; planning and decision routing still read the environment.",
      },
    };
  }

  const audit = (ctx: TenantContext, action: string, name: string, data: Record<string, unknown>) =>
    deps.audit.append(ctx, {
      actor: actorRef(ctx.actor),
      action: `${SUBJECT}.${action}`,
      subjectType: SUBJECT,
      subjectId: name,
      data: { name, ...data },
    });

  const toRecord = (view: PlatformTestView): PlatformSecretTestRecord => ({ ...view });

  function storageFailure(outcome: StorageProbeOutcome): StudixErrorPayload {
    const denied = outcome.status === 401 || outcome.status === 403;
    return {
      code: "UNAVAILABLE",
      message: `Object storage ${outcome.step ?? "request"} failed${outcome.status ? ` (HTTP ${outcome.status}${outcome.s3Code ? ` ${outcome.s3Code}` : ""})` : ""}`,
      retryable: !denied && (outcome.status === undefined || outcome.status >= 500),
      suggestedAction: denied
        ? "The store rejected these credentials or the bucket policy. Check that the key belongs to this bucket, was not rotated, and may write under orgs/*."
        : "Check the endpoint, bucket and region, and that the store is reachable from the app.",
    };
  }

  const storageView = (outcome: StorageProbeOutcome): PlatformTestView => ({
    ok: outcome.ok,
    at: now(),
    latencyMs: outcome.latencyMs,
    ...(outcome.step ? { step: outcome.step } : {}),
    ...(outcome.status ? { httpStatus: outcome.status } : {}),
    ...(outcome.ok ? {} : { error: storageFailure(outcome) }),
  });

  const requireStorage = (): PlatformStoragePort => {
    if (!deps.storage) {
      throw new StudixError("UNAVAILABLE", "Object storage is not configured on this server", {
        retryable: false,
        suggestedAction: "Set S3_BUCKET (and S3_ENDPOINT for R2) in the app environment.",
      });
    }
    return deps.storage;
  };

  async function changed(): Promise<void> {
    await deps.onChanged?.();
  }

  return {
    overview,

    async saveStorageCredentials(ctx, input) {
      assertPermission(ctx, "platform:manage");
      const box = requireBox();
      const pair = parse(StorageInput, input, "storage credentials");
      const storage = requireStorage();
      // The pair must work before it replaces the active one, so a typo cannot take storage down.
      const outcome = await storage.probe(pair);
      if (!outcome.ok) {
        await audit(ctx, "rejected", STORAGE_CREDENTIALS_NAME, {
          step: outcome.step,
          status: outcome.status,
          s3Code: outcome.s3Code,
        });
        const payload = storageFailure(outcome);
        throw new StudixError("VALIDATION", `${payload.message}; the previous credentials stay active`, {
          retryable: false,
          details: { step: outcome.step, status: outcome.status, s3Code: outcome.s3Code },
          ...(payload.suggestedAction ? { suggestedAction: payload.suggestedAction } : {}),
        });
      }
      const test = storageView(outcome);
      const row = await deps.secrets.put(
        STORAGE_CREDENTIALS_NAME,
        {
          secretCiphertext: box.seal(JSON.stringify(pair), platformSecretAad(STORAGE_CREDENTIALS_NAME)),
          secretHint: hintOf(pair.accessKeyId),
          status: "available",
          lastTest: toRecord(test),
        },
        actorRef(ctx.actor),
      );
      await audit(ctx, row.version > 1 ? "rotated" : "created", STORAGE_CREDENTIALS_NAME, {
        hint: row.secretHint,
        version: row.version,
      });
      await changed();
      return overview(ctx);
    },

    async saveMediaKey(ctx, name, input) {
      assertPermission(ctx, "platform:manage");
      const spec = specOf(name, "media");
      const box = requireBox();
      const { apiKey } = parse(MediaKeyInput, input, "API key");
      // Informational only: a vendor check can fail for reasons unrelated to the key (a restricted key, an
      // outage), so it never blocks saving. The verdict is shown as the credential's status.
      const verdict = await deps.vendorTester?.(spec.name, apiKey).catch(() => undefined);
      const status = verdict?.verdict ?? "unverified";
      const row = await deps.secrets.put(
        spec.name,
        {
          secretCiphertext: box.seal(apiKey, platformSecretAad(spec.name)),
          secretHint: hintOf(apiKey),
          status,
          ...(verdict
            ? {
                lastTest: toRecord({
                  ok: verdict.verdict === "available",
                  at: now(),
                  latencyMs: 0,
                  step: "vendor-auth",
                  ...(verdict.httpStatus ? { httpStatus: verdict.httpStatus } : {}),
                }),
              }
            : {}),
        },
        actorRef(ctx.actor),
      );
      await audit(ctx, row.version > 1 ? "rotated" : "created", spec.name, {
        hint: row.secretHint,
        version: row.version,
        status,
      });
      await changed();
      return overview(ctx);
    },

    async revoke(ctx, name) {
      assertPermission(ctx, "platform:manage");
      const spec = platformSecretSpec(name) ?? specOf(name, "media");
      if (spec.name === STORAGE_CREDENTIALS_NAME && !envHas(spec.name)) {
        throw new StudixError("CONFLICT", "Revoking would leave object storage without credentials", {
          retryable: false,
          suggestedAction:
            "Replace the key with a new one instead, or set S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY in the environment first.",
        });
      }
      const removed = await deps.secrets.delete(spec.name);
      if (!removed)
        throw new StudixError("NOT_FOUND", "No dashboard credential is stored under this name", {
          retryable: false,
        });
      envTests.delete(spec.name);
      await audit(ctx, "revoked", spec.name, { environmentFallback: envHas(spec.name) });
      await changed();
      return overview(ctx);
    },

    async testStorage(ctx) {
      assertPermission(ctx, "platform:manage");
      const outcome = await requireStorage().probe();
      const result = storageView(outcome);
      const row = await deps.secrets.get(STORAGE_CREDENTIALS_NAME);
      if (row) {
        await deps.secrets.recordTest(
          STORAGE_CREDENTIALS_NAME,
          result.ok ? "available" : "invalid",
          toRecord(result),
        );
      } else envTests.set(STORAGE_CREDENTIALS_NAME, result);
      await audit(ctx, "tested", STORAGE_CREDENTIALS_NAME, {
        ok: result.ok,
        step: result.step,
        status: result.httpStatus,
      });
      return result;
    },

    async testMediaKey(ctx, name) {
      assertPermission(ctx, "platform:manage");
      const spec = specOf(name, "media");
      const row = await deps.secrets.get(spec.name);
      const value = row
        ? (() => {
            try {
              return requireBox().open(row.secretCiphertext, platformSecretAad(spec.name));
            } catch {
              return undefined;
            }
          })()
        : deps.env[spec.name];
      const started = Date.now();
      let result: PlatformTestView;
      let status: "available" | "invalid" | "unverified";
      if (!value) {
        status = row ? "invalid" : "unverified";
        result = {
          ok: false,
          at: now(),
          latencyMs: 0,
          step: "load",
          error: {
            code: row ? "INTERNAL" : "UNAVAILABLE",
            message: row
              ? "The stored key cannot be opened with the current STUDIX_SECRETS_KEY"
              : "No key is configured",
            retryable: false,
            suggestedAction: row ? "Replace the key." : "Add the key in this page or in the environment.",
          },
        };
      } else {
        const verdict = await deps.vendorTester?.(spec.name, value).catch(() => undefined);
        status = verdict?.verdict ?? "unverified";
        result = {
          ok: verdict?.verdict === "available",
          at: now(),
          latencyMs: Date.now() - started,
          step: "vendor-auth",
          ...(verdict?.httpStatus ? { httpStatus: verdict.httpStatus } : {}),
          ...(verdict?.verdict === "available"
            ? {}
            : {
                error: {
                  code: verdict?.verdict === "invalid" ? "UNAUTHENTICATED" : "UNAVAILABLE",
                  message:
                    verdict?.verdict === "invalid"
                      ? `${spec.label} rejected this key`
                      : (verdict?.note ??
                        `${spec.label} offers no free key check; use "Check Multix" to confirm the CLI sees it`),
                  retryable: verdict?.verdict !== "invalid",
                },
              }),
        };
      }
      if (row) await deps.secrets.recordTest(spec.name, status, toRecord(result));
      else envTests.set(spec.name, result);
      await audit(ctx, "tested", spec.name, { status, httpStatus: result.httpStatus });
      return result;
    },

    async checkMultix(ctx) {
      assertPermission(ctx, "platform:manage");
      const media = deps.media;
      const started = Date.now();
      let result: PlatformTestView & { found: string[] };
      if (!media?.executable().configured) {
        result = {
          ok: false,
          at: now(),
          latencyMs: 0,
          step: "executable",
          found: [],
          error: {
            code: "UNAVAILABLE",
            message: "MULTIX_BIN is not set on this process",
            retryable: false,
            suggestedAction:
              "Set MULTIX_BIN on the app and the worker. The worker's /readyz reports whether it can generate media.",
          },
        };
      } else {
        try {
          const { found } = await media.check();
          result = { ok: true, at: now(), latencyMs: Date.now() - started, step: "multix-check", found };
        } catch (err) {
          const e = err instanceof StudixError ? err : new StudixError("UNAVAILABLE", "multix check failed");
          result = {
            ok: false,
            at: now(),
            latencyMs: Date.now() - started,
            step: "multix-check",
            found: [],
            error: {
              code: e.code,
              message: e.message,
              retryable: e.retryable,
              ...(e.suggestedAction ? { suggestedAction: e.suggestedAction } : {}),
            },
          };
        }
      }
      lastCheck = result;
      return result;
    },
  };
}
