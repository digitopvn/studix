import { createWorkspaceMultixSettingsService, type WorkspaceMultixSettingsService } from "@studix/auth";
import { assertPermission, type TenantContext } from "@studix/core";
import type { WorkspaceMultixSettingsRepository } from "@studix/database";
import {
  assertMultixOverrides,
  createMultixProviderFromConfig,
  type MultixConfig,
  type MultixDiagnosis,
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
}

export interface WorkspaceMultixApiDeps {
  config: MultixConfig;
  repository: WorkspaceMultixSettingsRepository;
  providers: WorkspaceMultixProviders;
  audit?: Parameters<typeof createWorkspaceMultixSettingsService>[0]["audit"];
  env?: Readonly<Record<string, string | undefined>>;
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
  };
}
