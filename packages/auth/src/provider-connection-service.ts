import {
  type ActorRef,
  type AuditRepository,
  actorRef,
  assertPermission,
  can,
  type TenantContext,
} from "@studix/core";
import type {
  ProviderConnectionRecord,
  ProviderConnectionRepository,
  ProviderTestResultRecord,
} from "@studix/database";
import { type Logger, newId, StudixError, type StudixErrorPayload } from "@studix/shared";
import { z } from "zod";
import {
  ANTHROPIC_API_KEY_PATTERN,
  anthropicKeyHint,
  type ProviderKeyTester,
  type ProviderKeyTestResult,
} from "./anthropic-key-tester.ts";
import type { SecretBox } from "./secret-box.ts";

/*
 * Outbound AI provider credentials (Anthropic). Two authentication methods are modelled and kept
 * apart: an API key billed by usage (works today) and a Claude subscription through OAuth, which is
 * reported as restricted until Anthropic approves that use for a multi-tenant service (ADR 0011).
 * Nothing here ever falls back from one method to the other, and Studix inbound credentials
 * (`stx_` keys, dashboard sessions) are never used as provider credentials.
 */

export type ConnectionOwner = "workspace" | "user";

export interface ProviderTestView {
  ok: boolean;
  at: Date;
  latencyMs: number;
  httpStatus?: number;
  error?: StudixErrorPayload;
}

/** Client-safe view: the key itself never leaves the service, only its hint. */
export interface ProviderConnectionView {
  id: string;
  provider: "anthropic";
  authMethod: "api_key";
  billing: "usage_based";
  owner: ConnectionOwner;
  ownedByMe: boolean;
  label: string;
  status: "available" | "invalid" | "unverified";
  keyHint?: string;
  lastTest?: ProviderTestView;
  canManage: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface ApiKeyMethodInfo {
  authMethod: "api_key";
  title: string;
  billing: "usage_based";
  availability: "available" | "unavailable";
  reason?: string;
  /** What the caller may add, so the dashboard offers only owners the server will accept. */
  canAddWorkspaceKey: boolean;
  canAddPersonalKey: boolean;
}

export interface SubscriptionMethodInfo {
  authMethod: "oauth_subscription";
  title: string;
  billing: "subscription";
  availability: "restricted";
  reason: string;
  alternative: string;
  references: string[];
}

export interface ProviderConnectionsOverview {
  provider: "anthropic";
  methods: [ApiKeyMethodInfo, SubscriptionMethodInfo];
  connections: ProviderConnectionView[];
}

export const SaveApiKeyInput = z
  .object({
    owner: z.enum(["workspace", "user"]),
    apiKey: z.string().trim().regex(ANTHROPIC_API_KEY_PATTERN, "must be an Anthropic API key (sk-ant-…)"),
    label: z.string().trim().min(1).max(80).optional(),
  })
  .strict();
export type SaveApiKeyInput = z.input<typeof SaveApiKeyInput>;

export const RotateApiKeyInput = SaveApiKeyInput.pick({ apiKey: true }).strict();
export type RotateApiKeyInput = z.input<typeof RotateApiKeyInput>;

export interface ResolvedProviderCredential {
  apiKey: string;
  connection: ProviderConnectionView;
  /**
   * Called after a run got a 401 with this key. It re-tests the key directly and, only if Anthropic
   * still rejects it, marks the connection `invalid` so the API pre-check stops accepting it. A key
   * rotated in the meantime is left alone.
   */
  markRejected(): Promise<void>;
}

export interface ProviderConnectionService {
  overview(ctx: TenantContext): Promise<ProviderConnectionsOverview>;
  saveApiKey(ctx: TenantContext, input: SaveApiKeyInput): Promise<ProviderConnectionView>;
  rotateApiKey(ctx: TenantContext, id: string, input: RotateApiKeyInput): Promise<ProviderConnectionView>;
  test(ctx: TenantContext, id: string): Promise<ProviderConnectionView>;
  remove(ctx: TenantContext, id: string): Promise<ProviderConnectionView>;
  /**
   * The plaintext key for one execution. `requestedBy` is whoever asked for the work (the job's
   * creator): a user-owned key is released only for its owner. Never picks another connection.
   */
  resolveForExecution(
    ctx: TenantContext,
    input: { connectionId: string; requestedBy: ActorRef },
  ): Promise<ResolvedProviderCredential>;
  /**
   * Check, without decrypting anything, that the caller could run a job with this connection. Used when a
   * job is created so a bad selection fails fast; the worker checks again with resolveForExecution.
   */
  assertUsable(ctx: TenantContext, connectionId: string): Promise<ProviderConnectionView>;
}

export interface ProviderConnectionServiceDeps {
  connections: ProviderConnectionRepository;
  audit: AuditRepository;
  tester: ProviderKeyTester;
  /** Without it the API-key method is reported unavailable and nothing can be stored. */
  secrets?: SecretBox;
  logger?: Logger;
}

export const SUBSCRIPTION_RESTRICTION: SubscriptionMethodInfo = {
  authMethod: "oauth_subscription",
  title: "Claude subscription (OAuth)",
  billing: "subscription",
  availability: "restricted",
  reason:
    "Not available for Studix cloud. Anthropic does not allow third-party services to offer Claude.ai login or use Free, Pro or Max plan credentials on behalf of their users without approval, and Studix has none.",
  alternative:
    "Use an Anthropic API key (usage-based billing), or run Claude Code on your own machine and connect it to Studix as an MCP client.",
  references: [
    "https://code.claude.com/docs/en/legal-and-compliance",
    "https://code.claude.com/docs/en/agent-sdk/overview",
  ],
};

const SUBJECT = "provider_connection";

function associatedData(ctx: TenantContext, id: string): string {
  return `${ctx.organizationId}/${ctx.workspaceId}/${SUBJECT}/${id}`;
}

function userId(ctx: TenantContext): string | undefined {
  return ctx.actor.type === "user" ? ctx.actor.id : undefined;
}

function isMine(ctx: TenantContext, row: ProviderConnectionRecord): boolean {
  return row.ownerType === "user" && row.ownerUserId === userId(ctx);
}

/** Workspace keys are managed by admins; a personal key by its owner (admins may still remove it). */
function canManage(ctx: TenantContext, row: ProviderConnectionRecord): boolean {
  return row.ownerType === "workspace" ? can(ctx.actor, "member:manage") : isMine(ctx, row);
}

function canSee(ctx: TenantContext, row: ProviderConnectionRecord): boolean {
  return row.ownerType === "workspace" || isMine(ctx, row) || can(ctx.actor, "member:manage");
}

function toTestRecord(result: ProviderKeyTestResult): ProviderTestResultRecord {
  const { verdict: _verdict, ...rest } = result;
  return rest;
}

function toView(ctx: TenantContext, row: ProviderConnectionRecord): ProviderConnectionView {
  return {
    id: row.id,
    provider: row.provider,
    authMethod: "api_key",
    billing: "usage_based",
    owner: row.ownerType,
    ownedByMe: isMine(ctx, row),
    label: row.label,
    status: row.status === "revoked" ? "invalid" : row.status,
    keyHint: row.secretHint,
    lastTest: row.lastTest,
    canManage: canManage(ctx, row),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value ?? {});
  if (parsed.success) return parsed.data;
  // Issues carry paths and messages only, never the submitted value.
  throw new StudixError("VALIDATION", "Invalid provider credential request", {
    details: { issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) },
  });
}

/**
 * A key Anthropic refuses is bad input, not a Studix auth failure: answering 401/403 would read as
 * "your Studix session expired" or "Studix denied you". The upstream verdict stays in details.
 */
function rejected(result: ProviderKeyTestResult): StudixError {
  const error = result.error;
  return new StudixError("VALIDATION", error?.message ?? "Anthropic rejected the API key", {
    retryable: false,
    suggestedAction: error?.suggestedAction ?? "Check the key in Claude Console, then paste it again.",
    details: { httpStatus: result.httpStatus, providerCode: error?.code },
  });
}

function canAddPersonal(ctx: TenantContext): boolean {
  return userId(ctx) !== undefined && can(ctx.actor, "project:write");
}

export function createProviderConnectionService(
  deps: ProviderConnectionServiceDeps,
): ProviderConnectionService {
  const requireSecrets = (): SecretBox => {
    if (!deps.secrets) {
      throw new StudixError("UNAVAILABLE", "Encrypted credential storage is not configured on this server", {
        retryable: false,
        suggestedAction: "Ask the operator to set STUDIX_SECRETS_KEY.",
      });
    }
    return deps.secrets;
  };

  /** A stored key that no longer decrypts (lost or rotated-out master key) is not a server bug for the user. */
  const openKey = (ctx: TenantContext, row: ProviderConnectionRecord, ciphertext: string): string => {
    try {
      return requireSecrets().open(ciphertext, associatedData(ctx, row.id));
    } catch (err) {
      if (err instanceof StudixError && err.code === "UNAVAILABLE") throw err;
      deps.logger?.error("provider credential could not be decrypted", {
        connectionId: row.id,
        workspaceId: ctx.workspaceId,
      });
      throw new StudixError("UNAVAILABLE", "The stored Anthropic key can no longer be decrypted", {
        retryable: false,
        suggestedAction: "Replace the key in Settings → AI & Providers.",
      });
    }
  };

  const load = async (ctx: TenantContext, id: string): Promise<ProviderConnectionRecord> => {
    const row = await deps.connections.get(ctx, id);
    if (!row || row.revokedAt || !canSee(ctx, row)) {
      throw new StudixError("NOT_FOUND", `provider connection ${id} not found`);
    }
    return row;
  };

  const requireManage = (ctx: TenantContext, row: ProviderConnectionRecord) => {
    if (!canManage(ctx, row)) {
      throw new StudixError("FORBIDDEN", "You cannot change this provider connection", {
        suggestedAction:
          row.ownerType === "workspace"
            ? "Ask a workspace admin to change workspace keys."
            : "Only the owner can change a personal key.",
      });
    }
  };

  const audit = (ctx: TenantContext, action: string, row: ProviderConnectionRecord) =>
    deps.audit.append(ctx, {
      actor: actorRef(ctx.actor),
      action: `${SUBJECT}.${action}`,
      subjectType: SUBJECT,
      subjectId: row.id,
      data: {
        provider: row.provider,
        authMethod: row.authMethod,
        owner: row.ownerType,
        status: row.status,
        keyHint: row.secretHint,
      },
    });

  /** The rules both resolveForExecution and assertUsable enforce; no fallback to any other row. */
  async function usableRow(
    ctx: TenantContext,
    connectionId: string,
    requestedBy: ActorRef,
  ): Promise<ProviderConnectionRecord> {
    assertPermission(ctx, "project:write");
    const row = await deps.connections.get(ctx, connectionId);
    if (!row || row.revokedAt || !row.secretCiphertext || row.authMethod !== "api_key") {
      throw new StudixError("UNAVAILABLE", "The selected Anthropic connection no longer exists", {
        retryable: false,
        suggestedAction: "Choose another provider connection in Settings → AI & Providers.",
      });
    }
    if (row.ownerType === "user" && !(requestedBy.type === "user" && requestedBy.id === row.ownerUserId)) {
      throw new StudixError("FORBIDDEN", "A personal Anthropic key can only be used by its owner", {
        retryable: false,
        suggestedAction: "Use a workspace key or your own personal key.",
      });
    }
    if (row.status === "invalid") {
      throw new StudixError("UNAUTHENTICATED", "The Anthropic API key was rejected at its last test", {
        retryable: false,
        suggestedAction: "Replace the key in Settings → AI & Providers, then retry.",
      });
    }
    return row;
  }

  return {
    async overview(ctx) {
      assertPermission(ctx, "workspace:read");
      const rows = await deps.connections.listActive(ctx);
      return {
        provider: "anthropic",
        methods: [
          {
            authMethod: "api_key",
            title: "Anthropic API key (usage-based)",
            billing: "usage_based",
            availability: deps.secrets ? "available" : "unavailable",
            canAddWorkspaceKey: Boolean(deps.secrets) && can(ctx.actor, "member:manage"),
            canAddPersonalKey: Boolean(deps.secrets) && canAddPersonal(ctx),
            ...(deps.secrets
              ? {}
              : { reason: "Encrypted credential storage is not configured on this server." }),
          },
          SUBSCRIPTION_RESTRICTION,
        ],
        connections: rows
          .filter((row) => row.authMethod === "api_key" && canSee(ctx, row))
          .map((row) => toView(ctx, row)),
      };
    },

    async saveApiKey(ctx, rawInput) {
      const input = parse(SaveApiKeyInput, rawInput);
      if (input.owner === "workspace") assertPermission(ctx, "member:manage");
      else {
        assertPermission(ctx, "project:write");
        if (!userId(ctx)) {
          throw new StudixError("FORBIDDEN", "Personal keys can only be added by a signed-in user");
        }
      }
      const secrets = requireSecrets();
      // Fail before calling Anthropic: the unique index still settles a concurrent race.
      const ownerUserId = input.owner === "user" ? userId(ctx) : undefined;
      const active = await deps.connections.listActive(ctx);
      if (
        active.some(
          (row) =>
            row.authMethod === "api_key" && row.ownerType === input.owner && row.ownerUserId === ownerUserId,
        )
      ) {
        throw new StudixError("CONFLICT", "An active connection already exists for this owner", {
          retryable: false,
          suggestedAction: "Replace the existing key instead of adding another one.",
        });
      }
      const result = await deps.tester.test(input.apiKey);
      if (result.verdict === "invalid") throw rejected(result);
      const id = newId("pcon");
      const row = await deps.connections.create(ctx, {
        id,
        provider: "anthropic",
        authMethod: "api_key",
        ownerType: input.owner,
        ownerUserId,
        label: input.label ?? (input.owner === "workspace" ? "Workspace key" : "Personal key"),
        status: result.verdict,
        secretCiphertext: secrets.seal(input.apiKey, associatedData(ctx, id)),
        secretHint: anthropicKeyHint(input.apiKey),
        lastTest: toTestRecord(result),
        createdBy: actorRef(ctx.actor),
      });
      await audit(ctx, "created", row);
      deps.logger?.info("provider connection created", { connectionId: id, workspaceId: ctx.workspaceId });
      return toView(ctx, row);
    },

    async rotateApiKey(ctx, id, rawInput) {
      const input = parse(RotateApiKeyInput, rawInput);
      const existing = await load(ctx, id);
      requireManage(ctx, existing);
      const secrets = requireSecrets();
      const result = await deps.tester.test(input.apiKey);
      if (result.verdict === "invalid") throw rejected(result);
      const row = await deps.connections.update(ctx, id, {
        status: result.verdict,
        secretCiphertext: secrets.seal(input.apiKey, associatedData(ctx, id)),
        secretHint: anthropicKeyHint(input.apiKey),
        lastTest: toTestRecord(result),
      });
      await audit(ctx, "rotated", row);
      return toView(ctx, row);
    },

    async test(ctx, id) {
      const existing = await load(ctx, id);
      requireManage(ctx, existing);
      if (!existing.secretCiphertext)
        throw new StudixError("NOT_FOUND", `provider connection ${id} has no key`);
      const apiKey = openKey(ctx, existing, existing.secretCiphertext);
      const result = await deps.tester.test(apiKey);
      const row = await deps.connections.recordTest(ctx, id, existing.secretCiphertext, {
        status: result.verdict,
        lastTest: toTestRecord(result),
      });
      // The key was replaced while it was being tested: report the current key, not the old result.
      if (!row) return toView(ctx, await load(ctx, id));
      await audit(ctx, "tested", row);
      return toView(ctx, row);
    },

    async remove(ctx, id) {
      const existing = await load(ctx, id);
      // Admins may remove a member's personal key (offboarding); they still never see the key.
      if (!canManage(ctx, existing) && !can(ctx.actor, "member:manage")) requireManage(ctx, existing);
      const row = await deps.connections.revoke(ctx, id);
      await audit(ctx, "revoked", row);
      return { ...toView(ctx, existing), status: "invalid", canManage: false };
    },

    async resolveForExecution(ctx, input) {
      const row = await usableRow(ctx, input.connectionId, input.requestedBy);
      const apiKey = openKey(ctx, row, row.secretCiphertext as string);
      const ciphertext = row.secretCiphertext as string;
      return {
        apiKey,
        connection: toView(ctx, row),
        async markRejected() {
          // A 401 can come from a gateway or a short provider incident; only a direct test of this key decides.
          const result = await deps.tester.test(apiKey);
          if (result.verdict !== "invalid") return;
          const updated = await deps.connections.recordTest(ctx, row.id, ciphertext, {
            status: "invalid",
            lastTest: toTestRecord(result),
          });
          if (!updated) return;
          await audit(ctx, "rejected", updated);
          deps.logger?.warn("provider connection marked invalid after Anthropic rejected the key", {
            connectionId: row.id,
            workspaceId: ctx.workspaceId,
          });
        },
      };
    },

    async assertUsable(ctx, connectionId) {
      return toView(ctx, await usableRow(ctx, connectionId, actorRef(ctx.actor)));
    },
  };
}
