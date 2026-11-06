import {
  type ActorRef,
  type AuditRepository,
  actorRef,
  assertPermission,
  type TenantContext,
} from "@studix/core";
import type { WorkspaceSettingsRepository } from "@studix/database";
import { StudixError } from "@studix/shared";
import { z } from "zod";

/** The Claude switches in effect for one workspace. */
export interface WorkspaceFeatures {
  claudePlanner: boolean;
  claudeSubscription: boolean;
}

export type FeatureSource = "operator" | "workspace" | "off";

export interface FeatureSwitchView {
  enabled: boolean;
  /** `operator`: forced on by env; `workspace`: the owner's Dashboard switch; `off`. */
  source: FeatureSource;
  /** The viewer may flip it here (self-hosted server, workspace owner, not forced by env). */
  canChange: boolean;
}

export interface WorkspaceFeaturesView {
  selfHosted: boolean;
  claudePlanner: FeatureSwitchView;
  claudeSubscription: FeatureSwitchView;
}

export interface WorkspaceFeatureServiceDeps {
  settings: WorkspaceSettingsRepository;
  audit?: AuditRepository;
  /** STUDIX_SELF_HOSTED: without it the Dashboard switches are ignored and cannot be changed. */
  selfHosted: boolean;
  /** STUDIX_CLAUDE_PLANNER / STUDIX_CLAUDE_SUBSCRIPTION: the operator turned the feature on for everyone. */
  operator: WorkspaceFeatures;
}

export interface WorkspaceFeatureService {
  effective(ctx: TenantContext): Promise<WorkspaceFeatures>;
  view(ctx: TenantContext): Promise<WorkspaceFeaturesView>;
  update(ctx: TenantContext, patch: unknown): Promise<WorkspaceFeaturesView>;
}

const UpdateInput = z
  .object({ claudePlanner: z.boolean().optional(), claudeSubscription: z.boolean().optional() })
  .strict();

const isOwner = (ctx: TenantContext) => ctx.actor.type === "user" && ctx.actor.role === "owner";

/**
 * Per-workspace Claude switches. The env flags still win (and are the only switch on a hosted server); on a
 * self-hosted server (STUDIX_SELF_HOSTED) the workspace owner may also turn each feature on in the Dashboard.
 */
export function createWorkspaceFeatureService(deps: WorkspaceFeatureServiceDeps): WorkspaceFeatureService {
  async function stored(ctx: TenantContext): Promise<WorkspaceFeatures> {
    if (!deps.selfHosted) return { claudePlanner: false, claudeSubscription: false };
    const row = await deps.settings.get(ctx);
    return { claudePlanner: row.claudePlanner, claudeSubscription: row.claudeSubscription };
  }

  function switchView(ctx: TenantContext, operator: boolean, saved: boolean): FeatureSwitchView {
    return {
      enabled: operator || saved,
      source: operator ? "operator" : saved ? "workspace" : "off",
      canChange: deps.selfHosted && !operator && isOwner(ctx),
    };
  }

  async function view(ctx: TenantContext): Promise<WorkspaceFeaturesView> {
    const saved = await stored(ctx);
    return {
      selfHosted: deps.selfHosted,
      claudePlanner: switchView(ctx, deps.operator.claudePlanner, saved.claudePlanner),
      claudeSubscription: switchView(ctx, deps.operator.claudeSubscription, saved.claudeSubscription),
    };
  }

  return {
    async effective(ctx) {
      const saved = await stored(ctx);
      return {
        claudePlanner: deps.operator.claudePlanner || saved.claudePlanner,
        claudeSubscription: deps.operator.claudeSubscription || saved.claudeSubscription,
      };
    },

    async view(ctx) {
      assertPermission(ctx, "workspace:read");
      return view(ctx);
    },

    async update(ctx, rawPatch) {
      if (!deps.selfHosted) {
        throw new StudixError("FORBIDDEN", "Workspace switches are only available on a self-hosted server", {
          retryable: false,
          suggestedAction: "Ask the operator to set STUDIX_SELF_HOSTED=true, or enable the feature by env.",
        });
      }
      if (!isOwner(ctx)) {
        throw new StudixError("FORBIDDEN", "Only the workspace owner can change these switches", {
          retryable: false,
        });
      }
      const parsed = UpdateInput.safeParse(rawPatch);
      if (!parsed.success) {
        throw new StudixError("VALIDATION", "Invalid workspace settings", {
          details: {
            issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
          },
        });
      }
      const by: ActorRef = actorRef(ctx.actor);
      await deps.settings.update(ctx, parsed.data, by);
      await deps.audit?.append(ctx, {
        actor: by,
        action: "workspace_settings.updated",
        subjectType: "workspace_settings",
        subjectId: ctx.workspaceId,
        data: { ...parsed.data },
      });
      return view(ctx);
    },
  };
}
