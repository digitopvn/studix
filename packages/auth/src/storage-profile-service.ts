import {
  type AuditRepository,
  actorRef,
  assertPlatformOperator,
  can,
  type TenantContext,
} from "@studix/core";
import {
  newStorageProfileId,
  type StorageProfileInput,
  type StorageProfileRecord,
  type StorageProfileRepository,
  type StorageProviderTypeName,
} from "@studix/database";
import { type Clock, type Logger, redact, registerSecret, StudixError, systemClock } from "@studix/shared";
import type { SecretBox } from "./secret-box.ts";

/*
 * Object storage profiles under Settings > Storage & Media, in two scopes. Platform profiles are managed by a
 * platform operator; workspace profiles by that workspace's owners and admins (`member:manage`), and a
 * workspace's active profile overrides the platform choice for that workspace only. The key pair is
 * sealed with STUDIX_SECRETS_KEY (no second vault) and bound to the profile id; no view, audit record or
 * error carries it. A profile is saved only after the caller's `verify` (the put/get/head/delete probe with
 * the candidate settings) passes. At most one profile per scope is active. `env` stands for the S3_* environment
 * settings in the platform scope and for "follow the platform" in a workspace scope. Deactivated profiles stay readable; a profile that assets still reference cannot be
 * deleted. App and worker read `snapshot()` every few seconds, so a change needs no redeploy.
 */

export const ENV_PROFILE_ID = "env";

/** `platform` (operator) or `workspace` (the caller's workspace, owners and admins). */
export type StorageProfileScopeName = "platform" | "workspace";

export interface StorageProfileFields {
  name: string;
  providerType: StorageProviderTypeName;
  /** Required except for `aws-s3`, where the SDK picks the regional endpoint. */
  endpoint?: string;
  bucket: string;
  region: string;
  forcePathStyle?: boolean;
  keyPrefix?: string;
}

export interface StorageKeyPair {
  accessKeyId: string;
  secretAccessKey: string;
}

/** Settings and key pair handed to `verify` and to the storage router; plaintext, never leaves the server. */
export interface StorageProfileCandidate {
  id: string;
  providerType: StorageProviderTypeName;
  endpoint?: string;
  bucket: string;
  region: string;
  forcePathStyle: boolean;
  keyPrefix: string;
  credentials: StorageKeyPair;
}

export interface StorageProfileView {
  id: string;
  name: string;
  /** `environment`: the S3_* settings; `platform`: a workspace following the platform choice. */
  providerType: StorageProviderTypeName | "environment" | "platform";
  endpointHost?: string;
  bucket?: string;
  region: string;
  forcePathStyle: boolean;
  keyPrefix: string;
  active: boolean;
  /** `…a1b2`; the key pair itself is never returned. */
  accessKeyHint?: string;
  secretHint?: string;
  version?: number;
  updatedAt?: Date;
  updatedBy?: { type: string; id: string };
  lastTest?: { ok: boolean; at: Date; detail?: string };
  /** Asset versions and renders stored there; a referenced profile cannot be deleted. */
  references?: number;
}

export interface StorageProfileSnapshotEntry {
  id: string;
  /** Owning workspace; absent for a platform profile. */
  workspaceId?: string;
  revision: string;
  candidate: StorageProfileCandidate;
}

export interface StorageProfilesSnapshot {
  /** The platform's active profile, `env` when none. */
  activeId: string;
  /** Workspace id to that workspace's active profile; a workspace absent here follows `activeId`. */
  workspaceActive: Record<string, string>;
  profiles: StorageProfileSnapshotEntry[];
}

/** Every method takes the scope last; it defaults to `platform`. */
export interface StorageProfileService {
  list(ctx: TenantContext, scope?: StorageProfileScopeName): Promise<StorageProfileView[]>;
  create(
    ctx: TenantContext,
    fields: StorageProfileFields,
    key: StorageKeyPair,
    verify: (candidate: StorageProfileCandidate) => Promise<void>,
    scope?: StorageProfileScopeName,
  ): Promise<StorageProfileView>;
  /** Without `key` the stored pair is kept and re-verified with the new settings. */
  update(
    ctx: TenantContext,
    id: string,
    fields: StorageProfileFields,
    key: StorageKeyPair | undefined,
    verify: (candidate: StorageProfileCandidate) => Promise<void>,
    scope?: StorageProfileScopeName,
  ): Promise<StorageProfileView>;
  /** Make a stored profile (or `env`) the one new objects of the scope go to. */
  activate(ctx: TenantContext, id: string, scope?: StorageProfileScopeName): Promise<StorageProfileView>;
  /** Delete an inactive, unreferenced profile and its sealed key pair. */
  revoke(ctx: TenantContext, id: string, scope?: StorageProfileScopeName): Promise<void>;
  /** The candidate for a stored profile, to re-run the probe on it. */
  candidate(
    ctx: TenantContext,
    id: string,
    scope?: StorageProfileScopeName,
  ): Promise<StorageProfileCandidate>;
  recordTest(
    ctx: TenantContext,
    id: string,
    result: { ok: boolean; detail?: string },
    scope?: StorageProfileScopeName,
  ): Promise<void>;
  /** For the storage routers in app and worker: never throws, cached for a few seconds. */
  snapshot(): Promise<StorageProfilesSnapshot>;
}

export interface StorageProfileServiceDeps {
  profiles: StorageProfileRepository;
  audit: AuditRepository;
  /** Absent without STUDIX_SECRETS_KEY: profiles cannot be stored and none is read. */
  secrets?: SecretBox;
  /** SSRF check of the endpoint (save time); returns the normalized endpoint. */
  checkEndpoint: (endpoint: string, providerType: StorageProviderTypeName) => Promise<{ endpoint: string }>;
  checkKeyPrefix: (prefix: string) => void;
  /** Where storage_profile.* audit events go (the platform workspace); see the platform credential service. */
  auditContext?: (ctx: TenantContext) => Promise<TenantContext>;
  /** Bucket and region of the `env` profile, for the list. */
  environment?: { endpoint?: string; bucket?: string; region: string; forcePathStyle: boolean };
  cacheMs?: number;
  clock?: Clock;
  logger?: Logger;
}

const SUBJECT = "storage_profile";
const NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} ._\-()]{0,79}$/u;
const BUCKET_PATTERN = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const REGION_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
const KEY_PATTERN = /^[\x21-\x7e]{8,512}$/;
const DEFAULT_CACHE_MS = 5_000;

const aadOf = (id: string, half: "access" | "secret") => `storage-profile:${id}:${half}`;

function hintOf(value: string): string {
  return value.length >= 16 ? `…${value.slice(-4)}` : "…";
}

function invalid(field: string, message: string): StudixError {
  return new StudixError("VALIDATION", message, { retryable: false, details: { field } });
}

function hostOf(endpoint: string | undefined): string | undefined {
  if (!endpoint) return undefined;
  try {
    return new URL(endpoint).host;
  } catch {
    return undefined;
  }
}

export function createStorageProfileService(deps: StorageProfileServiceDeps): StorageProfileService {
  const clock = deps.clock ?? systemClock;
  const cacheMs = deps.cacheMs ?? DEFAULT_CACHE_MS;
  let cached: { at: number; value: StorageProfilesSnapshot } | undefined;
  let warned: string | undefined;

  const box = (): SecretBox => {
    if (!deps.secrets) {
      throw new StudixError("UNAVAILABLE", "Storage profiles cannot be stored on this server", {
        retryable: false,
        suggestedAction: "Set STUDIX_SECRETS_KEY (32 random bytes, base64) on the app and the worker.",
      });
    }
    return deps.secrets;
  };

  /** Checks the caller may manage the scope; returns the workspace the rows belong to (undefined: platform). */
  const authorize = (ctx: TenantContext, scope: StorageProfileScopeName): string | undefined => {
    if (scope === "platform") {
      assertPlatformOperator(ctx);
      return undefined;
    }
    if (ctx.actor.type !== "user" || !can(ctx.actor, "member:manage")) {
      throw new StudixError("FORBIDDEN", "Only workspace owners and admins manage the workspace storage", {
        retryable: false,
      });
    }
    return ctx.workspaceId;
  };

  const auditTarget = (ctx: TenantContext, scope: StorageProfileScopeName) =>
    deps.auditContext && scope === "platform" ? deps.auditContext(ctx) : Promise.resolve(ctx);

  /** Audit data: settings and hints only. */
  const auditData = (row: StorageProfileRecord) => ({
    id: row.id,
    name: row.name,
    providerType: row.providerType,
    ...(hostOf(row.endpoint) ? { endpointHost: hostOf(row.endpoint) } : {}),
    bucket: row.bucket,
    region: row.region,
    keyPrefix: row.keyPrefix,
    accessKeyHint: row.accessKeyHint,
    version: row.version,
  });

  const audit = (ctx: TenantContext, action: string, subjectId: string, data: Record<string, unknown>) =>
    deps.audit.append(ctx, {
      actor: actorRef(ctx.actor),
      action: `${SUBJECT}.${action}`,
      subjectType: SUBJECT,
      subjectId,
      data,
    });

  const view = (row: StorageProfileRecord, references?: number): StorageProfileView => ({
    id: row.id,
    name: row.name,
    providerType: row.providerType,
    ...(hostOf(row.endpoint) ? { endpointHost: hostOf(row.endpoint) } : {}),
    bucket: row.bucket,
    region: row.region,
    forcePathStyle: row.forcePathStyle,
    keyPrefix: row.keyPrefix,
    active: row.active,
    accessKeyHint: row.accessKeyHint,
    secretHint: row.secretHint,
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
    ...(references === undefined ? {} : { references }),
  });

  const envView = (anyActive: boolean, scope: StorageProfileScopeName): StorageProfileView => {
    if (scope === "workspace") {
      return {
        id: ENV_PROFILE_ID,
        name: "Platform default",
        providerType: "platform",
        region: "auto",
        forcePathStyle: false,
        keyPrefix: "",
        active: !anyActive,
      };
    }
    const env = deps.environment;
    return {
      id: ENV_PROFILE_ID,
      name: "Deployment environment (S3_*)",
      providerType: "environment",
      ...(hostOf(env?.endpoint) ? { endpointHost: hostOf(env?.endpoint) } : {}),
      ...(env?.bucket ? { bucket: env.bucket } : {}),
      region: env?.region ?? "auto",
      forcePathStyle: env?.forcePathStyle ?? false,
      keyPrefix: "",
      active: !anyActive,
    };
  };

  /** Validate and normalize the operator's fields; the endpoint goes through the SSRF check. */
  const normalize = async (fields: StorageProfileFields): Promise<StorageProfileInput> => {
    const name = fields.name.trim();
    if (!NAME_PATTERN.test(name)) throw invalid("name", "The name must be 1-80 letters, digits or spaces");
    const bucket = fields.bucket.trim();
    if (!BUCKET_PATTERN.test(bucket))
      throw invalid("bucket", "The bucket name is not a valid S3 bucket name");
    const region = fields.region.trim();
    if (!REGION_PATTERN.test(region)) throw invalid("region", "The region must look like auto or us-east-1");
    const keyPrefix = (fields.keyPrefix ?? "").trim();
    deps.checkKeyPrefix(keyPrefix);
    let endpoint: string | undefined;
    if (fields.endpoint?.trim()) {
      endpoint = (await deps.checkEndpoint(fields.endpoint, fields.providerType)).endpoint;
    } else if (fields.providerType !== "aws-s3") {
      throw invalid("endpoint", "The endpoint is required for this provider");
    }
    return {
      name,
      providerType: fields.providerType,
      ...(endpoint ? { endpoint } : {}),
      bucket,
      region,
      forcePathStyle: fields.forcePathStyle ?? false,
      keyPrefix,
    };
  };

  const normalizeKey = (key: StorageKeyPair): StorageKeyPair => {
    const accessKeyId = key.accessKeyId.trim();
    const secretAccessKey = key.secretAccessKey.trim();
    if (!KEY_PATTERN.test(accessKeyId)) throw invalid("accessKeyId", "The access key ID is not valid");
    if (!KEY_PATTERN.test(secretAccessKey))
      throw invalid("secretAccessKey", "The secret access key is not valid");
    registerSecret(accessKeyId);
    registerSecret(secretAccessKey);
    return { accessKeyId, secretAccessKey };
  };

  const seal = (id: string, key: StorageKeyPair) => {
    const b = box();
    return {
      accessKeyCiphertext: b.seal(key.accessKeyId, aadOf(id, "access")),
      secretCiphertext: b.seal(key.secretAccessKey, aadOf(id, "secret")),
      accessKeyHint: hintOf(key.accessKeyId),
      secretHint: hintOf(key.secretAccessKey),
    };
  };

  const open = (row: StorageProfileRecord): StorageKeyPair => {
    const b = box();
    const accessKeyId = b.open(row.accessKeyCiphertext, aadOf(row.id, "access"));
    const secretAccessKey = b.open(row.secretCiphertext, aadOf(row.id, "secret"));
    registerSecret(accessKeyId);
    registerSecret(secretAccessKey);
    return { accessKeyId, secretAccessKey };
  };

  const candidateOf = (
    id: string,
    input: StorageProfileInput,
    key: StorageKeyPair,
  ): StorageProfileCandidate => ({
    id,
    providerType: input.providerType,
    ...(input.endpoint ? { endpoint: input.endpoint } : {}),
    bucket: input.bucket,
    region: input.region,
    forcePathStyle: input.forcePathStyle,
    keyPrefix: input.keyPrefix,
    credentials: key,
  });

  /** A row of the scope; another scope's row is reported as missing. */
  const getOrThrow = async (id: string, workspaceId: string | undefined): Promise<StorageProfileRecord> => {
    const row = await deps.profiles.get(id);
    if (!row || row.workspaceId !== workspaceId)
      throw new StudixError("NOT_FOUND", "No storage profile with that id", { retryable: false });
    return row;
  };

  const invalidate = () => {
    cached = undefined;
  };

  return {
    async list(ctx, scope = "platform") {
      const ws = authorize(ctx, scope);
      const rows = await deps.profiles.listScope(ws);
      const views = await Promise.all(
        rows.map(async (row) => view(row, await deps.profiles.countReferences(row.id))),
      );
      return [
        envView(
          rows.some((r) => r.active),
          scope,
        ),
        ...views,
      ];
    },

    async create(ctx, fields, key, verify, scope = "platform") {
      const ws = authorize(ctx, scope);
      box();
      const target = await auditTarget(ctx, scope);
      const input = await normalize(fields);
      const pair = normalizeKey(key);
      const id = newStorageProfileId();
      await verify(candidateOf(id, input, pair));
      const row = await deps.profiles.create(
        { id, ...(ws ? { workspaceId: ws } : {}), ...input, ...seal(id, pair) },
        actorRef(ctx.actor),
      );
      await deps.profiles.recordTest(id, {
        ok: true,
        at: clock.now(),
        detail: "Write, read and delete passed",
      });
      invalidate();
      await audit(target, "created", id, { ...auditData(row), masterKeyId: box().keyId });
      return view({ ...row, lastTest: { ok: true, at: clock.now() } }, 0);
    },

    async update(ctx, id, fields, key, verify, scope = "platform") {
      const ws = authorize(ctx, scope);
      box();
      const target = await auditTarget(ctx, scope);
      const existing = await getOrThrow(id, ws);
      const input = await normalize(fields);
      const pair = key ? normalizeKey(key) : open(existing);
      await verify(candidateOf(id, input, pair));
      const row = await deps.profiles.update(
        id,
        { ...input, ...(key ? seal(id, pair) : {}) },
        actorRef(ctx.actor),
      );
      if (!row) throw new StudixError("NOT_FOUND", "No storage profile with that id", { retryable: false });
      await deps.profiles.recordTest(id, {
        ok: true,
        at: clock.now(),
        detail: "Write, read and delete passed",
      });
      invalidate();
      await audit(target, "updated", id, { ...auditData(row), keyRotated: Boolean(key) });
      return view(row, await deps.profiles.countReferences(id));
    },

    async activate(ctx, id, scope = "platform") {
      const ws = authorize(ctx, scope);
      const target = await auditTarget(ctx, scope);
      if (id === ENV_PROFILE_ID) {
        await deps.profiles.activate(undefined, actorRef(ctx.actor), ws);
        invalidate();
        await audit(target, "activated", ENV_PROFILE_ID, { id: ENV_PROFILE_ID, scope });
        return envView(false, scope);
      }
      const row = await getOrThrow(id, ws);
      // Opening proves this server can use it before new objects go there.
      open(row);
      await deps.profiles.activate(id, actorRef(ctx.actor), ws);
      invalidate();
      await audit(target, "activated", id, auditData(row));
      return view({ ...row, active: true }, await deps.profiles.countReferences(id));
    },

    async revoke(ctx, id, scope = "platform") {
      const ws = authorize(ctx, scope);
      const target = await auditTarget(ctx, scope);
      if (id === ENV_PROFILE_ID) {
        throw new StudixError("VALIDATION", "The environment profile is changed in the deployment settings", {
          retryable: false,
        });
      }
      const row = await getOrThrow(id, ws);
      if (row.active) {
        throw new StudixError("CONFLICT", "The active storage profile cannot be deleted", {
          retryable: false,
          suggestedAction: "Activate another profile (or the environment) first.",
        });
      }
      const references = await deps.profiles.countReferences(id);
      if (references > 0) {
        throw new StudixError("CONFLICT", "Assets are still stored in this profile; it stays readable", {
          retryable: false,
          details: { references },
          suggestedAction: "Keep it inactive: new objects already go to the active profile.",
        });
      }
      if (!(await deps.profiles.delete(id))) {
        throw new StudixError("CONFLICT", "The profile changed meanwhile; reload and retry", {
          retryable: true,
        });
      }
      invalidate();
      await audit(target, "revoked", id, auditData(row));
    },

    async candidate(ctx, id, scope = "platform") {
      const row = await getOrThrow(id, authorize(ctx, scope));
      return candidateOf(id, row, open(row));
    },

    async recordTest(ctx, id, result, scope = "platform") {
      await getOrThrow(id, authorize(ctx, scope));
      const target = await auditTarget(ctx, scope);
      const stored = await deps.profiles.recordTest(id, {
        ok: result.ok,
        at: clock.now(),
        ...(result.detail ? { detail: redact(result.detail).slice(0, 300) } : {}),
      });
      if (stored) await audit(target, "tested", id, { id, ok: result.ok });
    },

    async snapshot() {
      const now = clock.now().getTime();
      if (cached && now - cached.at < cacheMs) return cached.value;
      if (!deps.secrets) return { activeId: ENV_PROFILE_ID, workspaceActive: {}, profiles: [] };
      let rows: StorageProfileRecord[];
      try {
        rows = await deps.profiles.list();
      } catch (err) {
        deps.logger?.warn("storage profiles could not be read; using the previous ones", {
          error: err instanceof Error ? err.message : String(err),
        });
        return cached?.value ?? { activeId: ENV_PROFILE_ID, workspaceActive: {}, profiles: [] };
      }
      const profiles: StorageProfileSnapshotEntry[] = [];
      const unreadable: string[] = [];
      let activeId = ENV_PROFILE_ID;
      const workspaceActive: Record<string, string> = {};
      for (const row of rows) {
        try {
          profiles.push({
            id: row.id,
            ...(row.workspaceId ? { workspaceId: row.workspaceId } : {}),
            revision: `${row.version}:${row.updatedAt.getTime()}`,
            candidate: candidateOf(row.id, row, open(row)),
          });
          if (row.active && row.workspaceId) workspaceActive[row.workspaceId] = row.id;
          else if (row.active) activeId = row.id;
        } catch {
          unreadable.push(row.id);
        }
      }
      const token = unreadable.join(",");
      if (unreadable.length > 0 && warned !== token) {
        warned = token;
        deps.logger?.warn("storage profiles cannot be opened with the current master keys", {
          ids: unreadable,
        });
      }
      const value = { activeId, workspaceActive, profiles };
      cached = { at: now, value };
      return value;
    },
  };
}
