import {
  type ApiKey,
  type ApiKeyRepository,
  actorRef,
  assertPermission,
  can,
  isPermission,
  type Permission,
  ROLE_PERMISSIONS,
  ROLES,
  type Role,
  type TenantContext,
  type TenantDirectory,
} from "@studix/core";
import { type Clock, type Logger, StudixError, systemClock } from "@studix/shared";
import { z } from "zod";
import {
  generateApiKey,
  hashApiKey,
  hashesEqual,
  isApiKeyFormat,
  parseBearerToken,
} from "./api-key-format.ts";

/** Client-safe view of a key: never includes the hash or the secret. */
export interface ApiKeyView {
  id: string;
  name: string;
  prefix: string;
  scopes: Permission[];
  /** Role whose permission set equals the scopes, or "custom". */
  role: Role | "custom";
  createdAt: Date;
  lastUsedAt?: Date;
  expiresAt?: Date;
  revokedAt?: Date;
  status: "active" | "revoked" | "expired";
}

export interface CreatedApiKey {
  apiKey: ApiKeyView;
  /** The full `stx_...` key. Returned only here; it cannot be retrieved again. */
  secret: string;
}

export const CreateApiKeyInput = z
  .object({
    name: z.string().trim().min(1).max(100),
    /** Grant the permissions of this role (default editor). Ignored when `scopes` is given. */
    role: z.enum(ROLES).optional(),
    scopes: z.array(z.string().refine(isPermission, "unknown permission")).min(1).max(32).optional(),
    expiresAt: z.coerce.date().optional(),
  })
  .strict();
export type CreateApiKeyInput = z.input<typeof CreateApiKeyInput>;

export interface ApiKeyServiceDeps {
  directory: Pick<TenantDirectory, "resolveApiKey">;
  apiKeys: ApiKeyRepository;
  /** Environment tag embedded in new keys (STUDIX_API_KEY_ENV). */
  env: string;
  clock?: Clock;
  logger?: Logger;
  /** Minimum interval between `lastUsedAt` writes for one key (default 60s) to avoid a write per request. */
  touchIntervalMs?: number;
}

export interface ApiKeyService {
  create(ctx: TenantContext, input: CreateApiKeyInput): Promise<CreatedApiKey>;
  list(ctx: TenantContext): Promise<ApiKeyView[]>;
  revoke(ctx: TenantContext, id: string): Promise<ApiKeyView>;
  /** Resolve an `Authorization` header to the key's TenantContext or throw UNAUTHENTICATED. */
  authenticate(authorization: string | string[] | undefined): Promise<TenantContext>;
}

const UNAUTHENTICATED_ACTION = "Send `Authorization: Bearer stx_...` with an active workspace API key.";

function unauthenticated(message: string): StudixError {
  // The message is fixed text; the presented key is never echoed back.
  return new StudixError("UNAUTHENTICATED", message, { suggestedAction: UNAUTHENTICATED_ACTION });
}

function roleForScopes(scopes: readonly Permission[]): Role | "custom" {
  const set = new Set(scopes);
  const matches = (perms: readonly Permission[]) =>
    perms.length === set.size && perms.every((p) => set.has(p));
  for (const role of ROLES) {
    // A key can never carry logs:system:read, so the operator role is matched without it. Operator keys made
    // before log access existed lack logs:read too and still count as operator keys.
    const perms = [...ROLE_PERMISSIONS[role]].filter((p) => p !== "logs:system:read");
    if (matches(perms)) return role;
    if (role === "operator" && matches(perms.filter((p) => p !== "logs:read"))) return role;
  }
  return "custom";
}

export function toApiKeyView(key: ApiKey, now: Date): ApiKeyView {
  const status = key.revokedAt ? "revoked" : key.expiresAt && key.expiresAt <= now ? "expired" : "active";
  return {
    id: key.id,
    name: key.name,
    prefix: key.prefix,
    scopes: [...key.scopes],
    role: roleForScopes(key.scopes),
    createdAt: key.createdAt,
    lastUsedAt: key.lastUsedAt,
    expiresAt: key.expiresAt,
    revokedAt: key.revokedAt,
    status,
  };
}

export function createApiKeyService(deps: ApiKeyServiceDeps): ApiKeyService {
  const clock = deps.clock ?? systemClock;
  const touchIntervalMs = deps.touchIntervalMs ?? 60_000;

  return {
    async create(ctx, rawInput) {
      assertPermission(ctx, "apikey:manage");
      const parsed = CreateApiKeyInput.safeParse(rawInput);
      if (!parsed.success) {
        throw new StudixError("VALIDATION", "Invalid API key request", {
          details: {
            issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
          },
        });
      }
      const input = parsed.data;
      const now = clock.now();
      if (input.expiresAt && input.expiresAt <= now) {
        throw new StudixError("VALIDATION", "expiresAt must be in the future");
      }
      if ((input.scopes as string[] | undefined)?.includes("logs:system:read")) {
        throw new StudixError("FORBIDDEN", "System log access cannot be placed on an API key", {
          details: { operatorOnly: ["logs:system:read"] },
          suggestedAction: "Use the platform operator's dashboard session for these actions.",
        });
      }
      // The operator's system-log permission is never copied onto a key, even from the operator role.
      const scopes =
        (input.scopes as Permission[] | undefined) ??
        [...ROLE_PERMISSIONS[input.role ?? "editor"]].filter((p) => p !== "logs:system:read");
      // No privilege escalation: a key can only carry permissions its creator holds.
      const missing = [...new Set(scopes)].filter((scope) => !can(ctx.actor, scope));
      if (missing.length > 0) {
        throw new StudixError("FORBIDDEN", "Cannot grant permissions you do not hold", {
          details: { missing },
          suggestedAction: "Request fewer scopes or ask a workspace owner to create the key.",
        });
      }
      const generated = generateApiKey(deps.env);
      const apiKey = await deps.apiKeys.create(ctx, {
        name: input.name,
        hash: generated.hash,
        prefix: generated.prefix,
        scopes: [...new Set(scopes)],
        createdBy: actorRef(ctx.actor),
        expiresAt: input.expiresAt,
      });
      deps.logger?.info("api key created", { apiKeyId: apiKey.id, workspaceId: ctx.workspaceId });
      return { apiKey: toApiKeyView(apiKey, now), secret: generated.key };
    },

    async list(ctx) {
      assertPermission(ctx, "apikey:manage");
      const now = clock.now();
      return (await deps.apiKeys.list(ctx)).map((key) => toApiKeyView(key, now));
    },

    async revoke(ctx, id) {
      assertPermission(ctx, "apikey:manage");
      const existing = await deps.apiKeys.get(ctx, id);
      if (!existing) throw new StudixError("NOT_FOUND", `api key ${id} not found`);
      const revoked = await deps.apiKeys.revoke(ctx, id);
      deps.logger?.info("api key revoked", { apiKeyId: id, workspaceId: ctx.workspaceId });
      return toApiKeyView(revoked, clock.now());
    },

    async authenticate(authorization) {
      const token = parseBearerToken(authorization);
      if (!token) throw unauthenticated("Missing API key");
      if (!isApiKeyFormat(token)) throw unauthenticated("Invalid API key");
      const hash = hashApiKey(token);
      const now = clock.now();
      const resolved = await deps.directory.resolveApiKey(hash, now);
      // Lookup is by digest; the constant-time compare is defense in depth against a misbehaving store.
      if (!resolved || !hashesEqual(resolved.apiKey.hash, hash)) throw unauthenticated("Invalid API key");
      const { apiKey, organization, workspace } = resolved;
      if (apiKey.revokedAt || (apiKey.expiresAt && apiKey.expiresAt <= now)) {
        throw unauthenticated("Invalid API key");
      }
      const ctx: TenantContext = {
        organizationId: organization.id,
        workspaceId: workspace.id,
        actor: { type: "apiKey", id: apiKey.id, scopes: [...apiKey.scopes] },
      };
      if (!apiKey.lastUsedAt || now.getTime() - apiKey.lastUsedAt.getTime() >= touchIntervalMs) {
        // Best effort: a failed usage timestamp must not fail the authenticated request.
        await deps.apiKeys.touch(ctx, apiKey.id, now).catch((error: unknown) => {
          deps.logger?.warn("api key last-used update failed", {
            apiKeyId: apiKey.id,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
      return ctx;
    },
  };
}
