import { createWorkspaceMultixSettingsService, type WorkspaceMultixSettingsService } from "@studix/auth";
import { assertPermission, type TenantContext } from "@studix/core";
import type { WorkspaceMultixSettingsRepository } from "@studix/database";
import {
  assertMultixOverrides,
  createMultixCatalogLoader,
  createMultixProviderFromConfig,
  type MultixCatalog,
  type MultixConfig,
  type MultixDiagnosis,
  markNeedsKey,
  providerReadiness,
  readMultixVersion,
  type WorkspaceMultixProviders,
} from "@studix/providers";

export interface MultixCheckView {
  /** `multix --version` of the CLI in this image; Multix itself is pinned by the image build. */
  version: string | null;
  diagnosis: MultixDiagnosis;
}

export interface WorkspaceMultixApi {
  settings: WorkspaceMultixSettingsService;
  /** One safe `multix check` with the workspace's settings (no paid call). */
  check(ctx: TenantContext): Promise<MultixCheckView>;
  /** The models each role can be set to, from the multix catalogue (free commands, cached a few minutes). */
  catalog(ctx: TenantContext): Promise<MultixCatalog>;
}

export interface WorkspaceMultixApiDeps {
  config: MultixConfig;
  repository: WorkspaceMultixSettingsRepository;
  providers: WorkspaceMultixProviders;
  audit?: Parameters<typeof createWorkspaceMultixSettingsService>[0]["audit"];
  env?: Readonly<Record<string, string | undefined>>;
  /** Key slots the workspace stored its own key for (BYOK); they make a vendor usable as well. */
  workspaceKeySlots?: (ctx: TenantContext) => Promise<readonly string[]>;
}

export function createWorkspaceMultixApi(deps: WorkspaceMultixApiDeps): WorkspaceMultixApi {
  const serverModels = createMultixProviderFromConfig(deps.config).status().models;
  const settings = createWorkspaceMultixSettingsService({
    settings: deps.repository,
    ...(deps.audit ? { audit: deps.audit } : {}),
    server: {
      enabled: Boolean(deps.config.MULTIX_BIN),
      waitTimeoutSeconds: deps.config.MULTIX_WAIT_TIMEOUT_SECONDS,
      models: serverModels,
      voiceLanguageModels: deps.config.MULTIX_VOICE_LANGUAGE_MODELS ?? null,
    },
    validate: (values) => assertMultixOverrides(deps.config, values),
  });
  let version: Promise<string | undefined> | undefined;
  const catalog = createMultixCatalogLoader({
    bin: deps.config.MULTIX_BIN,
    defaults: serverModels,
    ...(deps.env ? { env: deps.env } : {}),
  });
  return {
    settings,
    async check(ctx) {
      // Each check spawns the CLI, so only the people who may change the settings run it.
      assertPermission(ctx, "member:manage");
      version ??= readMultixVersion(deps.config.MULTIX_BIN, deps.env);
      const provider = await deps.providers.forWorkspace(ctx);
      const [v, diagnosis] = await Promise.all([version, provider.diagnose()]);
      return { version: v ?? null, diagnosis };
    },
    async catalog(ctx) {
      // Same audience as the settings form it fills.
      assertPermission(ctx, "member:manage");
      const [models, platform, own] = await Promise.all([
        catalog(),
        deps.providers.forWorkspace(ctx).then((p) => p.readiness()),
        deps.workspaceKeySlots?.(ctx) ?? [],
      ]);
      const slots: Record<string, boolean> = { ...platform };
      for (const id of own) slots[id] = true;
      return markNeedsKey(models, providerReadiness(slots));
    },
  };
}
