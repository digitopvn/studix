import type { JobView, Render, RenderRepository, TenantContext } from "@studix/core";
import { StudixError } from "@studix/shared";
import { describe, expect, it } from "vitest";
import { type ArtifactUrlDeps, playbackForJob, playbackForRender } from "../src/artifact-urls.ts";
import { errorEnvelope, okEnvelope, ToolEnvelopeSchema } from "../src/mcp/tool-envelope.ts";

const ctx: TenantContext = {
  organizationId: "org_1",
  workspaceId: "wsp_1",
  actor: { type: "apiKey", id: "key_1", scopes: ["project:read"] },
};

describe("tool envelope", () => {
  it("serialises ok results to JSON-safe structured content", () => {
    const at = new Date("2026-01-01T00:00:00Z");
    const result = okEnvelope({ createdAt: at, skipped: undefined }, [], "trace-1");
    expect(result.isError).toBeUndefined();
    expect(ToolEnvelopeSchema.parse(result.structuredContent)).toMatchObject({
      status: "ok",
      data: { createdAt: at.toISOString() },
      traceId: "trace-1",
    });
    expect(JSON.parse(result.content[0]!.text)).toEqual(result.structuredContent);
  });

  it("masks internal errors and surfaces follow-up hints", () => {
    const internal = errorEnvelope(new StudixError("INTERNAL", "db password=hunter2 leaked"), "t");
    expect(internal.isError).toBe(true);
    expect(JSON.stringify(internal)).not.toContain("hunter2");

    const approval = errorEnvelope(
      new StudixError("APPROVAL_REQUIRED", "needs approval", {
        details: { next: { tool: "studix_approve", arguments: { approvalId: "apr_1" } } },
        suggestedAction: "Ask an owner to approve.",
      }),
      "t",
    );
    const envelope = ToolEnvelopeSchema.parse(approval.structuredContent);
    expect(envelope.error?.code).toBe("APPROVAL_REQUIRED");
    expect(envelope.next[0]).toMatchObject({ tool: "studix_approve", arguments: { approvalId: "apr_1" } });
  });
});

function render(overrides: Partial<Render>): Render {
  return {
    id: "ren_1",
    organizationId: ctx.organizationId,
    workspaceId: ctx.workspaceId,
    projectId: "prj_1",
    versionId: "ver_1",
    preset: "preview",
    spec: {} as Render["spec"],
    status: "succeeded",
    storageKey: "renders/ren_1.mp4",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Render;
}

function deps(rows: Render[], withStorage = true): ArtifactUrlDeps {
  const renders = {
    async get(scope: TenantContext, id: string) {
      return rows.find((r) => r.id === id && r.workspaceId === scope.workspaceId);
    },
    async listByProject(scope: TenantContext, projectId: string) {
      return { items: rows.filter((r) => r.projectId === projectId && r.workspaceId === scope.workspaceId) };
    },
  } as unknown as RenderRepository;
  return {
    renders,
    ttlSeconds: 300,
    clock: () => new Date("2026-01-01T00:00:00Z"),
    storage: withStorage
      ? {
          signedUrl: async (c, key, o) =>
            `https://s3.test/${c.workspaceId}/${key}?ttl=${o?.expiresInSeconds}`,
        }
      : undefined,
  };
}

describe("artifact URLs", () => {
  it("signs a succeeded render through the tenant-scoped storage port", async () => {
    const url = await playbackForRender(deps([render({})]), ctx, "ren_1");
    expect(url).toEqual({
      renderId: "ren_1",
      url: "https://s3.test/wsp_1/renders/ren_1.mp4?ttl=300",
      expiresAt: "2026-01-01T00:05:00.000Z",
      preset: "preview",
    });
  });

  it("refuses foreign, unfinished and unsignable renders", async () => {
    const foreign = render({ workspaceId: "wsp_other" });
    await expect(playbackForRender(deps([foreign]), ctx, "ren_1")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    const running = render({ status: "rendering", storageKey: undefined });
    await expect(playbackForRender(deps([running]), ctx, "ren_1")).rejects.toMatchObject({
      code: "CONFLICT",
    });
    await expect(playbackForRender(deps([render({})], false), ctx, "ren_1")).rejects.toMatchObject({
      code: "UNAVAILABLE",
    });
  });

  it("finds a finished job's render by job id or recorded result", async () => {
    const job = { id: "job_1", projectId: "prj_1", status: "succeeded" } as JobView;
    expect(await playbackForJob(deps([render({ jobId: "job_1" })]), ctx, job)).toMatchObject({
      renderId: "ren_1",
    });
    const viaResult = { ...job, result: { renderId: "ren_2" } } as JobView;
    expect(await playbackForJob(deps([render({ id: "ren_2" })]), ctx, viaResult)).toMatchObject({
      renderId: "ren_2",
    });
    expect(await playbackForJob(deps([render({ jobId: "job_1" })]), ctx, { ...job, status: "running" })).toBe(
      undefined,
    );
  });
});
