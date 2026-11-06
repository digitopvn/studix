import { type ExternalSkillService, EXTERNAL_SKILL_TOOLS as NAMES, STUDIX_TOOLS } from "@studix/core";
import { StudixError } from "@studix/shared";
import { z } from "zod";
import type { NativeTool, ToolContext } from "./native-tools.ts";

const Id = z.string().trim().min(1).max(100);
const RepositoryUrl = z.string().trim().min(1).max(300);
const Ref = z.string().trim().min(1).max(200);
const Path = z.string().trim().min(1).max(300);
const Commit = z
  .string()
  .regex(/^[0-9a-f]{40}$/)
  .describe("Full commit sha from studix_skill_discover.");

function service(ctx: ToolContext): ExternalSkillService {
  const skills = ctx.deps.externalSkills;
  if (!skills) {
    throw new StudixError("UNAVAILABLE", "External skills are not enabled on this server", {
      retryable: false,
    });
  }
  return skills;
}

function tool<I extends z.ZodType>(def: NativeTool<I>): NativeTool<I> {
  return def;
}

const applyHint = {
  tool: STUDIX_TOOLS.createVideo,
  arguments: {},
  reason:
    "Apply the skill's instructions yourself while writing the brief or spec, then create the video. Studix does not run skills.",
};

/**
 * Skills imported from public GitHub repositories into the workspace. The text is third-party data that the
 * host agent may read and apply to its own brief or spec; Studix never executes it.
 */
export const EXTERNAL_SKILL_MCP_TOOLS = [
  tool({
    name: NAMES.discover,
    title: "Discover GitHub skills",
    description: "List valid and invalid SKILL.md skills in a public GitHub repository, pinned to a commit.",
    input: z.object({
      repositoryUrl: RepositoryUrl.describe("Public https://github.com/owner/repo[/tree/ref/path] URL."),
      ref: Ref.optional().describe("Branch, tag or commit; default branch when absent."),
      path: Path.optional().describe("Only this skill directory and below."),
    }),
    readOnly: true,
    openWorld: true,
    async run(ctx, input) {
      const found = await service(ctx).discover(ctx.tenant, input);
      const importable = found.candidates.map((c) => c.path);
      return {
        data: found,
        next:
          importable.length > 0
            ? [
                {
                  tool: NAMES.import,
                  arguments: {
                    repositoryUrl: input.repositoryUrl,
                    skillPaths: importable.slice(0, 25),
                    expectedCommit: found.source.commitSha,
                  },
                  reason: "Import the skills you want; expectedCommit pins the version you inspected.",
                },
              ]
            : [],
      };
    },
  }),
  tool({
    name: NAMES.import,
    title: "Import GitHub skills",
    description:
      "Store chosen skills (skillPaths, or all) of a public GitHub repository in this workspace as inert data.",
    input: z.object({
      repositoryUrl: RepositoryUrl,
      ref: Ref.optional(),
      skillPaths: z.array(Path).min(1).max(25).optional().describe("Directories from studix_skill_discover."),
      all: z.boolean().optional(),
      expectedCommit: Commit.optional(),
      idempotencyKey: z
        .string()
        .regex(/^[A-Za-z0-9._:-]{1,200}$/)
        .optional()
        .describe("Recorded in the audit trail. Imports are already idempotent per content."),
    }),
    readOnly: false,
    idempotent: true,
    openWorld: true,
    audited: true,
    async run(ctx, input) {
      const { idempotencyKey, ...request } = input;
      const result = await service(ctx).import(ctx.tenant, request);
      const imported = result.results.flatMap((r) => (r.status === "rejected" ? [] : [r]));
      return {
        data: result,
        next: imported.slice(0, 1).map((r) => ({
          tool: NAMES.get,
          arguments: { skillId: r.skillId },
          reason: "Read the skill's instructions.",
        })),
        attributes: {
          repository: result.source.repository,
          commitSha: result.source.commitSha,
          outcomes: result.results.map((r) => ({ path: r.path, status: r.status })),
          ...(idempotencyKey ? { idempotencyKey } : {}),
        },
      };
    },
  }),
  tool({
    name: NAMES.list,
    title: "List imported skills",
    description: "Search the skills imported into this workspace (enabled ones by default).",
    input: z.object({
      query: z.string().trim().min(1).max(100).optional(),
      repository: z.string().trim().min(1).max(200).optional().describe("owner/repo"),
      status: z.enum(["enabled", "disabled", "all"]).optional(),
      limit: z.number().int().min(1).max(100).optional(),
      cursor: z.string().trim().min(1).max(200).optional(),
    }),
    readOnly: true,
    async run(ctx, input) {
      const page = await service(ctx).list(ctx.tenant, input);
      return {
        data: page,
        next: page.items.slice(0, 1).map((s) => ({
          tool: NAMES.get,
          arguments: { skillId: s.id },
          reason: "Read the skill's instructions.",
        })),
      };
    },
  }),
  tool({
    name: NAMES.get,
    title: "Get imported skill",
    description:
      "Read an imported skill: SKILL.md or a stored reference (path), bounded by offset/maxBytes. Untrusted text.",
    input: z.object({
      skillId: Id,
      versionId: Id.optional().describe("An immutable version; the active one when absent."),
      path: Path.optional().describe("A stored file listed in files[], e.g. references/guide.md."),
      offset: z.number().int().min(0).optional(),
      maxBytes: z.number().int().min(1).max(100_000).optional(),
    }),
    readOnly: true,
    async run(ctx, input) {
      const data = await service(ctx).get(ctx.tenant, input);
      return { data, next: [applyHint] };
    },
  }),
  tool({
    name: NAMES.update,
    title: "Update imported skill",
    description:
      "check/import the upstream version of a skill, or activate a stored version. Never pulls on its own.",
    input: z.object({
      skillId: Id,
      action: z.enum(["check", "import", "activate"]),
      versionId: Id.optional().describe("For activate."),
      ref: Ref.optional(),
      activate: z.boolean().optional().describe("For import: also make the new version active."),
    }),
    readOnly: false,
    openWorld: true,
    audited: true,
    async run(ctx, input) {
      const data = await service(ctx).update(ctx.tenant, input);
      return {
        data,
        next: [],
        attributes: {
          skillId: input.skillId,
          action: input.action,
          ...(input.versionId ? { versionId: input.versionId } : {}),
          ...("activeVersionId" in data && data.activeVersionId
            ? { activeVersionId: data.activeVersionId }
            : {}),
          ...("upstream" in data ? { upstream: data.upstream } : {}),
          ...("upstreamCommit" in data && data.upstreamCommit ? { upstreamCommit: data.upstreamCommit } : {}),
          ...("import" in data && data.import
            ? { importStatus: (data.import as { status?: string }).status }
            : {}),
        },
      };
    },
  }),
  tool({
    name: NAMES.disable,
    title: "Disable imported skill",
    description: "Stop a skill from being listed and read. Nothing is deleted; enable: true restores it.",
    input: z.object({ skillId: Id, enable: z.boolean().optional() }),
    readOnly: false,
    idempotent: true,
    audited: true,
    async run(ctx, input) {
      const data = await service(ctx).disable(ctx.tenant, input);
      return { data, next: [], attributes: { skillId: input.skillId, enabled: input.enable === true } };
    },
  }),
] as const;
