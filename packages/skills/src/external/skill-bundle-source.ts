import type { ExternalSkillRepository, ExternalSkillScope, TenantContext } from "@studix/core";
import type { Logger } from "@studix/shared";
import type { ExternalSkillService } from "./external-skill-service.ts";
import { mapLimit } from "./import-limits.ts";

/*
 * Structural copies of the agent-runtime port (packages/agent-runtime/src/skill-bundle-source.ts), so the
 * store does not depend on the runtime. TypeScript checks the two stay compatible where they are wired.
 */
export interface StoredSkillBundleFile {
  path: string;
  content: Uint8Array;
  executable?: boolean;
}

export interface StoredSkillBundle {
  name: string;
  description: string;
  scope: ExternalSkillScope;
  /** The active version id. */
  version: string;
  files: StoredSkillBundleFile[];
}

export interface StoredSkillBundleSource {
  listEnabled(ctx: TenantContext): Promise<StoredSkillBundle[]>;
}

/** The runtime mounts skills by directory name; other names cannot be mounted. */
const MOUNTABLE_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_SKILLS = 200;

/**
 * Files of the enabled skills a tenant can use: its own workspace skills plus every enabled platform
 * skill, active version only. Only stored files are returned (links and oversize files never are).
 */
export function createSkillBundleSource(deps: {
  repository: ExternalSkillRepository;
  service: Pick<ExternalSkillService, "readFile">;
  logger?: Logger;
}): StoredSkillBundleSource {
  return {
    async listEnabled(ctx) {
      const skills = [];
      let cursor: string | undefined;
      do {
        const page = await deps.repository.list(ctx, {
          scope: "visible",
          status: "enabled",
          limit: 100,
          ...(cursor ? { cursor } : {}),
        });
        skills.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor && skills.length < MAX_SKILLS);
      // Platform skills are on everywhere unless this workspace turned them off for itself.
      const off = new Set(await deps.repository.listOptOuts(ctx));
      const visible = skills.filter((s) => !(s.scope === "platform" && off.has(s.id)));

      const bundles = await mapLimit(visible.slice(0, MAX_SKILLS), 4, async (skill) => {
        if (!skill.activeVersionId) return undefined;
        if (!MOUNTABLE_NAME.test(skill.name)) {
          deps.logger?.warn("skill name cannot be mounted", { skillId: skill.id });
          return undefined;
        }
        const sctx: TenantContext = {
          organizationId: skill.organizationId,
          workspaceId: skill.workspaceId,
          actor: ctx.actor,
        };
        const version = await deps.repository.getVersion(sctx, skill.id, skill.activeVersionId);
        if (!version) return undefined;
        const stored = version.manifest.files.filter((f) => f.stored && f.sha256);
        const files = await mapLimit(stored, 8, async (f) => ({
          path: f.path,
          content: await deps.service.readFile(sctx, version, f.sha256!, f.bytes),
          ...(f.executable ? { executable: true } : {}),
        }));
        return {
          name: skill.name,
          description: skill.description,
          scope: skill.scope,
          version: version.id,
          files,
        } satisfies StoredSkillBundle;
      });
      return bundles.filter((b): b is StoredSkillBundle => b !== undefined);
    },
  };
}
