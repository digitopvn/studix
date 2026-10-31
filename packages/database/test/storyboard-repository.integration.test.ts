import {
  createDefaultApprovalPolicy,
  StudioService,
  storyboardFromVideoIR,
  storyboardStatus,
  type TenantContext,
} from "@studix/core";
import { systemClock } from "@studix/shared";
import type { VideoIR } from "@studix/video-ir";
import brandIntro from "@studix/video-ir/fixtures/brand-intro-9x16.json" with { type: "json" };
import { describe, expect, it } from "vitest";
import { withTestDatabase } from "../src/testing/index.ts";

const db = withTestDatabase();
const actor = { type: "user" as const, id: "usr_1", role: "owner" as const };
const createdBy = { type: "user" as const, id: "usr_1" };

async function tenant(slug: string): Promise<TenantContext> {
  const { organization, workspace } = await db.current.repos.directory.provisionWorkspace({
    organization: { name: slug, slug },
    workspace: { name: "Main", slug: "main" },
  });
  return { organizationId: organization.id, workspaceId: workspace.id, actor };
}

async function projectWithVersion(ctx: TenantContext) {
  const { projects } = db.current.repos;
  const project = await projects.create(ctx, {
    title: "S",
    status: "draft",
    brief: { prompt: "s" },
    createdBy,
  });
  const version = await projects.createVersion(ctx, {
    projectId: project.id,
    ir: brandIntro as VideoIR,
    source: "client",
    createdBy,
  });
  return { project, version };
}

describe("Postgres storyboard repository", () => {
  it("appends revisions in order and refuses a revision that skips or repeats", async () => {
    const { storyboards } = db.current.repos;
    const ctx = await tenant("sb-append");
    const { project, version } = await projectWithVersion(ctx);
    const storyboard = storyboardFromVideoIR(brandIntro as VideoIR);
    expect(await storyboards.latest(ctx, project.id)).toBeUndefined();

    const first = await storyboards.append(ctx, {
      projectId: project.id,
      revision: 1,
      versionId: version.id,
      storyboard,
      createdBy,
    });
    expect(first).toMatchObject({ revision: 1, versionId: version.id });
    const approved = { ...storyboard, approval: { status: "approved" as const, reviewer: "usr_1" } };
    await storyboards.append(ctx, {
      projectId: project.id,
      revision: 2,
      versionId: version.id,
      storyboard: approved,
      createdBy,
    });

    const latest = await storyboards.latest(ctx, project.id);
    expect(latest?.revision).toBe(2);
    expect(latest?.storyboard.approval.status).toBe("approved");
    for (const revision of [2, 4]) {
      await expect(
        storyboards.append(ctx, {
          projectId: project.id,
          revision,
          versionId: version.id,
          storyboard,
          createdBy,
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    }
  });

  it("keeps storyboards inside their tenant and rejects a version of another project", async () => {
    const { storyboards } = db.current.repos;
    const a = await tenant("sb-tenant-a");
    const b = await tenant("sb-tenant-b");
    const { project, version } = await projectWithVersion(a);
    const other = await projectWithVersion(a);
    const storyboard = storyboardFromVideoIR(brandIntro as VideoIR);
    await storyboards.append(a, {
      projectId: project.id,
      revision: 1,
      versionId: version.id,
      storyboard,
      createdBy,
    });

    expect(await storyboards.latest(b, project.id)).toBeUndefined();
    await expect(
      storyboards.append(b, {
        projectId: project.id,
        revision: 2,
        versionId: version.id,
        storyboard,
        createdBy,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      storyboards.append(a, {
        projectId: project.id,
        revision: 2,
        versionId: other.version.id,
        storyboard,
        createdBy,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("drives the storyboard gate through the studio service on Postgres", async () => {
    const ctx = await tenant("sb-studio");
    const studio = new StudioService({
      ...db.current.repos,
      approvalPolicy: createDefaultApprovalPolicy({ costThresholdCents: 1000 }),
      clock: systemClock,
    });
    const { project } = await studio.createVideoProject(ctx, {
      brief: { prompt: "Sương Mai" },
      spec: brandIntro as VideoIR,
    });
    expect(await storyboardStatus(db.current.repos, ctx, project.id)).toBe("draft");
    await studio.decideStoryboard(ctx, { projectId: project.id, target: "storyboard", decision: "approved" });
    expect(await storyboardStatus(db.current.repos, ctx, project.id)).toBe("approved");

    await studio.submitFeedback(ctx, {
      projectId: project.id,
      shotId: "feature-1",
      comment: "Đổi câu",
      patch: { ops: [{ op: "replace", path: "/scenes/2/shots/0/text", value: "Giao hàng trong 2 giờ" }] },
    });
    expect(await storyboardStatus(db.current.repos, ctx, project.id)).toBe("in_review");
  });
});
