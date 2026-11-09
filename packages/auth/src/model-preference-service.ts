import {
  type AgentRuntimeName,
  type AuditRepository,
  actingUserId,
  actorRef,
  assertPermission,
  can,
  DEFAULT_STAGE,
  type ModelChoice,
  type ModelPreference,
  type ModelSelectionSource,
  resolveModelSelection,
  type TenantContext,
} from "@studix/core";
import type { ModelPreferenceRepository } from "@studix/database";
import { StudixError } from "@studix/shared";
import { z } from "zod";
import type { ProviderConnectionService, ProviderConnectionView } from "./provider-connection-service.ts";

/*
 * Which model the Pi runtime uses per workflow stage, workspace-wide or for one member. Workspace entries
 * follow the workspace-key rule (`member:manage`); personal entries follow the personal-key rule
 * (`project:write`, own entries only). A workspace entry may only use workspace-owned connections, so one
 * member's personal key never becomes everyone's default. The Claude runtime is chosen per job instead
 * (`PlannerSelection`), and that choice always wins over these preferences.
 */

/** Runtimes that read stage preferences. */
export const PREFERENCE_RUNTIMES = ["pi"] as const;
/** Stages that resolve a model today: `default` and the planning stage. */
export const MODEL_STAGES = [DEFAULT_STAGE, "plan"] as const;

const MAX_FALLBACKS = 3;
const Id = z.string().trim().min(1).max(64);
const ModelId = z.string().trim().min(1).max(200);

const Choice = z.object({ connectionId: Id, modelId: ModelId }).strict();

export const SavePreferenceInput = z
  .object({
    scope: z.enum(["workspace", "user"]),
    stage: z.enum(MODEL_STAGES),
    runtime: z.enum(PREFERENCE_RUNTIMES).default("pi"),
    connectionId: Id,
    modelId: ModelId,
    allowFallback: z.boolean().default(false),
    fallbacks: z.array(Choice).max(MAX_FALLBACKS).default([]),
  })
  .strict()
  .refine((input) => input.allowFallback || input.fallbacks.length === 0, {
    path: ["fallbacks"],
    message: "fallbacks need allowFallback",
  });
export type SavePreferenceInput = z.input<typeof SavePreferenceInput>;

export const PreviewInput = z
  .object({
    stage: z.enum(MODEL_STAGES).default(DEFAULT_STAGE),
    runtime: z.enum(PREFERENCE_RUNTIMES).default("pi"),
  })
  .strict();
export type PreviewInput = z.input<typeof PreviewInput>;

export interface ModelPreferenceView {
  id: string;
  scope: "workspace" | "user";
  stage: string;
  runtime: AgentRuntimeName;
  connectionId: string;
  provider: string;
  modelId: string;
  allowFallback: boolean;
  fallbacks: ModelChoice[];
  canManage: boolean;
  updatedAt: Date;
}

export interface ModelPreferenceList {
  stages: readonly string[];
  runtimes: readonly AgentRuntimeName[];
  canEditWorkspace: boolean;
  canEditPersonal: boolean;
  preferences: ModelPreferenceView[];
}

/** What a run by the caller would use for one stage right now, and why. */
export interface ModelPreview {
  runtime: AgentRuntimeName;
  stage: string;
  selection?: {
    source: ModelSelectionSource;
    preference: ModelPreferenceView;
    /** False when the chosen connection is gone, disabled for the runtime or failed its last test. */
    usable: boolean;
    problem?: string;
  };
}

export interface ModelPreferenceService {
  list(ctx: TenantContext): Promise<ModelPreferenceList>;
  save(ctx: TenantContext, input: SavePreferenceInput): Promise<ModelPreferenceView>;
  remove(ctx: TenantContext, id: string): Promise<void>;
  preview(ctx: TenantContext, input: PreviewInput): Promise<ModelPreview>;
}

export interface ModelPreferenceServiceDeps {
  preferences: ModelPreferenceRepository;
  providers: ProviderConnectionService;
  audit: AuditRepository;
  /** True when the runtime's catalog knows the model for the provider (the Pi catalog in production). */
  knownModel: (provider: string, modelId: string) => boolean;
}

const SUBJECT = "model_preference";

/** The signed-in user. Only they save or remove their personal preferences; delegated clients do not. */
function userId(ctx: TenantContext): string | undefined {
  return ctx.actor.type === "user" ? ctx.actor.id : undefined;
}

function canManage(ctx: TenantContext, pref: ModelPreference): boolean {
  return pref.scope.type === "workspace"
    ? can(ctx.actor, "member:manage")
    : pref.scope.userId === userId(ctx) && can(ctx.actor, "project:write");
}

function toView(ctx: TenantContext, pref: ModelPreference): ModelPreferenceView {
  return {
    id: pref.id,
    scope: pref.scope.type,
    stage: pref.stage,
    runtime: pref.runtime,
    connectionId: pref.connectionId,
    provider: pref.provider,
    modelId: pref.modelId,
    allowFallback: pref.allowFallback,
    fallbacks: pref.fallbacks,
    canManage: canManage(ctx, pref),
    updatedAt: pref.updatedAt,
  };
}

function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value ?? {});
  if (parsed.success) return parsed.data;
  throw new StudixError("VALIDATION", "Invalid model preference request", {
    details: { issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) },
  });
}

export function createModelPreferenceService(deps: ModelPreferenceServiceDeps): ModelPreferenceService {
  /** Each connection must be usable by the caller for the runtime; a workspace entry only takes workspace keys. */
  const checkChoice = async (
    ctx: TenantContext,
    scope: "workspace" | "user",
    runtime: AgentRuntimeName,
    choice: { connectionId: string; modelId: string },
  ): Promise<ModelChoice> => {
    const connection: ProviderConnectionView = await deps.providers.assertUsable(
      ctx,
      choice.connectionId,
      runtime,
    );
    if (scope === "workspace" && connection.owner !== "workspace") {
      throw new StudixError("VALIDATION", "A workspace preference cannot use a personal key", {
        retryable: false,
        suggestedAction: "Choose a workspace key, or save this as your personal preference.",
      });
    }
    if (!deps.knownModel(connection.provider, choice.modelId)) {
      throw new StudixError(
        "VALIDATION",
        `Model ${choice.modelId} is not available for ${connection.provider}`,
        {
          retryable: false,
          suggestedAction: "Pick a model from the provider catalog.",
        },
      );
    }
    return { connectionId: connection.id, provider: connection.provider, modelId: choice.modelId };
  };

  /** Workspace entries plus the acting user's own, which also apply to an OAuth client acting for them. */
  const visible = async (ctx: TenantContext, runtime?: AgentRuntimeName) =>
    deps.preferences.list(ctx, { userId: actingUserId(ctx.actor), ...(runtime ? { runtime } : {}) });

  return {
    async list(ctx) {
      assertPermission(ctx, "workspace:read");
      return {
        stages: MODEL_STAGES,
        runtimes: PREFERENCE_RUNTIMES,
        canEditWorkspace: can(ctx.actor, "member:manage"),
        canEditPersonal: userId(ctx) !== undefined && can(ctx.actor, "project:write"),
        preferences: (await visible(ctx)).map((p) => toView(ctx, p)),
      };
    },

    async save(ctx, rawInput) {
      const input = parse(SavePreferenceInput, rawInput);
      if (input.scope === "workspace") assertPermission(ctx, "member:manage");
      else assertPermission(ctx, "project:write");
      const me = userId(ctx);
      if (input.scope === "user" && !me) {
        throw new StudixError("FORBIDDEN", "Personal preferences can only be set by a signed-in user");
      }
      const primary = await checkChoice(ctx, input.scope, input.runtime, input);
      const fallbacks: ModelChoice[] = [];
      for (const fallback of input.fallbacks) {
        fallbacks.push(await checkChoice(ctx, input.scope, input.runtime, fallback));
      }
      const saved = await deps.preferences.upsert(ctx, {
        scope: input.scope === "workspace" ? { type: "workspace" } : { type: "user", userId: me as string },
        stage: input.stage,
        runtime: input.runtime,
        ...primary,
        allowFallback: input.allowFallback,
        fallbacks,
      });
      await deps.audit.append(ctx, {
        actor: actorRef(ctx.actor),
        action: `${SUBJECT}.saved`,
        subjectType: SUBJECT,
        subjectId: saved.id,
        data: {
          scope: input.scope,
          stage: saved.stage,
          runtime: saved.runtime,
          connectionId: saved.connectionId,
          provider: saved.provider,
          modelId: saved.modelId,
          allowFallback: saved.allowFallback,
          fallbacks: saved.fallbacks.length,
        },
      });
      return toView(ctx, saved);
    },

    async remove(ctx, id) {
      const pref = await deps.preferences.get(ctx, id);
      const mine = pref?.scope.type === "user" && pref.scope.userId === userId(ctx);
      if (!pref || (pref.scope.type === "user" && !mine)) {
        throw new StudixError("NOT_FOUND", `model preference ${id} not found`);
      }
      if (!canManage(ctx, pref)) {
        throw new StudixError("FORBIDDEN", "You cannot change this model preference", {
          suggestedAction: "Ask a workspace admin to change workspace preferences.",
        });
      }
      await deps.preferences.delete(ctx, id);
      await deps.audit.append(ctx, {
        actor: actorRef(ctx.actor),
        action: `${SUBJECT}.removed`,
        subjectType: SUBJECT,
        subjectId: id,
        data: { scope: pref.scope.type, stage: pref.stage, runtime: pref.runtime },
      });
    },

    async preview(ctx, rawInput) {
      assertPermission(ctx, "workspace:read");
      const input = parse(PreviewInput, rawInput);
      const resolved = resolveModelSelection(await visible(ctx, input.runtime), {
        runtime: input.runtime,
        stage: input.stage,
        userId: actingUserId(ctx.actor),
      });
      if (!resolved) return { runtime: input.runtime, stage: input.stage };
      let problem: string | undefined;
      if (!can(ctx.actor, "project:write")) {
        problem = "You cannot run jobs in this workspace";
      } else {
        try {
          await deps.providers.assertUsable(ctx, resolved.preference.connectionId, input.runtime);
        } catch (err) {
          if (!(err instanceof StudixError)) throw err;
          problem = err.message;
        }
      }
      return {
        runtime: input.runtime,
        stage: input.stage,
        selection: {
          source: resolved.source,
          preference: toView(ctx, resolved.preference),
          usable: problem === undefined,
          ...(problem ? { problem } : {}),
        },
      };
    },
  };
}
