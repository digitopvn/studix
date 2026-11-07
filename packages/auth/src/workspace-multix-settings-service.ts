import {
  type ActorRef,
  type AuditRepository,
  actorRef,
  assertPermission,
  can,
  type TenantContext,
} from "@studix/core";
import type { WorkspaceMultixSettingsRepository, WorkspaceMultixSettingsValues } from "@studix/database";
import { StudixError } from "@studix/shared";
import { z } from "zod";

/** The server's own Multix settings (the MULTIX_* env), which a workspace may override. */
export interface MultixServerSettings {
  enabled: boolean;
  waitTimeoutSeconds: number;
  /** The model of every role the server runs on, env or built-in default. */
  models: Readonly<Record<string, string>>;
  voiceLanguageModels: string | null;
}

export type MultixSettingSource = "workspace" | "server";

export interface MultixEffectiveValue<T> {
  value: T;
  source: MultixSettingSource;
}

export interface WorkspaceMultixSettingsView {
  /** The viewer may change the settings (`member:manage`). */
  canChange: boolean;
  server: MultixServerSettings;
  /** What the workspace saved; null when it runs on the server settings. */
  workspace: WorkspaceMultixSettingsValues | null;
  effective: {
    enabled: MultixEffectiveValue<boolean>;
    waitTimeoutSeconds: MultixEffectiveValue<number>;
    models: Record<string, MultixEffectiveValue<string>>;
    voiceLanguageModels: MultixEffectiveValue<string | null>;
  };
  updatedAt?: string;
  updatedBy?: ActorRef;
}

export interface WorkspaceMultixSettingsServiceDeps {
  settings: WorkspaceMultixSettingsRepository;
  audit?: AuditRepository;
  server: MultixServerSettings;
  /** Throws VALIDATION when the overrides would not build a provider (unknown role, model or voice route). */
  validate(values: WorkspaceMultixSettingsValues): void;
}

export interface WorkspaceMultixSettingsService {
  view(ctx: TenantContext): Promise<WorkspaceMultixSettingsView>;
  /** Replace the workspace's overrides; `null` for a field (or a role left out) restores the server value. */
  update(ctx: TenantContext, input: unknown): Promise<WorkspaceMultixSettingsView>;
  /** Drop every override: the workspace runs on the server settings again. */
  reset(ctx: TenantContext): Promise<WorkspaceMultixSettingsView>;
}

const MODEL = z
  .string()
  .trim()
  .regex(/^[a-z0-9-]+:[\w./@-]{1,200}$/i, "a <vendor>:<model> id");

const UpdateInput = z
  .object({
    enabled: z.boolean().nullable().default(null),
    waitTimeoutSeconds: z.number().int().min(30).max(7200).nullable().default(null),
    models: z.record(z.string().max(40), MODEL).default({}),
    voiceLanguageModels: z.string().trim().max(2000).nullable().default(null),
  })
  .strict();

const EMPTY: WorkspaceMultixSettingsValues = {
  enabled: null,
  waitTimeoutSeconds: null,
  models: {},
  voiceLanguageModels: null,
};

function pick<T>(saved: T | null | undefined, server: T): MultixEffectiveValue<T> {
  return saved === null || saved === undefined
    ? { value: server, source: "server" }
    : { value: saved, source: "workspace" };
}

/**
 * Per-workspace Multix settings: models per role, voice routes, the on/off switch and the wait timeout.
 * Saved values win over the server env, field by field. Vendor keys are the workspace media keys.
 */
export function createWorkspaceMultixSettingsService(
  deps: WorkspaceMultixSettingsServiceDeps,
): WorkspaceMultixSettingsService {
  async function view(ctx: TenantContext): Promise<WorkspaceMultixSettingsView> {
    const row = await deps.settings.get(ctx);
    const { server } = deps;
    const models: Record<string, MultixEffectiveValue<string>> = {};
    for (const [role, model] of Object.entries(server.models)) models[role] = pick(row?.models[role], model);
    return {
      canChange: can(ctx.actor, "member:manage"),
      server,
      workspace: row
        ? {
            enabled: row.enabled,
            waitTimeoutSeconds: row.waitTimeoutSeconds,
            models: row.models,
            voiceLanguageModels: row.voiceLanguageModels,
          }
        : null,
      effective: {
        // A workspace can turn Multix off, never on where the server has no CLI.
        enabled: server.enabled ? pick(row?.enabled, true) : { value: false, source: "server" },
        waitTimeoutSeconds: pick(row?.waitTimeoutSeconds, server.waitTimeoutSeconds),
        models,
        voiceLanguageModels: pick(row?.voiceLanguageModels, server.voiceLanguageModels),
      },
      ...(row?.updatedAt ? { updatedAt: row.updatedAt.toISOString() } : {}),
      ...(row?.updatedBy ? { updatedBy: row.updatedBy } : {}),
    };
  }

  async function save(ctx: TenantContext, values: WorkspaceMultixSettingsValues, action: string) {
    const by = actorRef(ctx.actor);
    await deps.settings.put(ctx, values, by);
    await deps.audit?.append(ctx, {
      actor: by,
      action,
      subjectType: "workspace_multix_settings",
      subjectId: ctx.workspaceId,
      data: { ...values },
    });
    return view(ctx);
  }

  return {
    async view(ctx) {
      assertPermission(ctx, "workspace:read");
      return view(ctx);
    },

    async update(ctx, input) {
      assertPermission(ctx, "member:manage");
      const parsed = UpdateInput.safeParse(input ?? {});
      if (!parsed.success) {
        throw new StudixError("VALIDATION", "Invalid Multix settings", {
          retryable: false,
          details: {
            issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
          },
        });
      }
      const values: WorkspaceMultixSettingsValues = {
        ...parsed.data,
        voiceLanguageModels: parsed.data.voiceLanguageModels || null,
      };
      deps.validate(values);
      return save(ctx, values, "multix_settings.updated");
    },

    async reset(ctx) {
      assertPermission(ctx, "member:manage");
      return save(ctx, { ...EMPTY }, "multix_settings.reset");
    },
  };
}
