import {
  assertPermission,
  FeedbackInput,
  JOB_STATUSES,
  PlannerSelection,
  PROJECT_STATUSES,
  RenderVersionInput,
  resolveWorkflowPack,
  StoryboardDecisionInput,
  WorkflowTemplateId,
} from "@studix/core";
import { packRegistry } from "@studix/skills";
import { AspectRatio, LanguageTag } from "@studix/video-ir";
import { Router } from "express";
import { z } from "zod";
import type { AppDeps } from "../app-deps.ts";
import { type ArtifactUrlDeps, isPlayable, playbackForRender, signRender } from "../artifact-urls.ts";
import { assertPlannerSelection } from "../planner-selection.ts";
import { jobWithVideo, projectView } from "../resource-views.ts";
import { idParam, parseBody, sessionOf } from "./api-context.ts";

const PageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,100}$/)
    .optional(),
});

const CreateVideoBody = z
  .object({
    prompt: z.string().trim().min(1).max(4000),
    title: z.string().trim().min(1).max(200).optional(),
    aspectRatio: AspectRatio.optional(),
    durationMs: z.number().int().min(1000).max(600_000).optional(),
    language: LanguageTag.optional(),
    budgetCents: z.number().int().min(0).max(10_000_000).optional(),
    idempotencyKey: z
      .string()
      .regex(/^[A-Za-z0-9._:-]{1,200}$/)
      .optional(),
    planner: PlannerSelection.optional(),
    workflowTemplate: WorkflowTemplateId.optional(),
  })
  .strict();

const DecisionBody = z
  .object({ decision: z.enum(["approved", "rejected"]), comment: z.string().trim().max(2000).optional() })
  .strict();

/** The JSON body with the path's project id; a body naming another project cannot redirect the call. */
function withProject(body: unknown, projectId: string): unknown {
  const fields = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  return { ...fields, projectId };
}

/**
 * Dashboard JSON API over StudioService and tenant-scoped repositories. Every handler runs in the session's
 * TenantContext; foreign ids surface as NOT_FOUND from the scoped reads.
 */
export function studioRoutes(deps: AppDeps, artifacts: ArtifactUrlDeps): Router {
  const router = Router();

  router.get("/me", async (_req, res) => {
    const session = sessionOf(res);
    const current = session.memberships.find((m) => m.workspace.id === session.ctx.workspaceId);
    res.json({
      user: session.user,
      role: session.role,
      organization: current?.organization,
      workspace: current?.workspace,
      workspaces: session.memberships.map((m) => ({
        id: m.workspace.id,
        name: m.workspace.name,
        organizationName: m.organization.name,
        role: m.member.role,
      })),
      mcpUrl: `${deps.publicUrl}/mcp`,
    });
  });

  router.get("/projects", async (req, res) => {
    const { ctx } = sessionOf(res);
    const query = parseBody(
      PageQuery.extend({ status: z.enum(PROJECT_STATUSES).optional() }),
      req.query,
      "query",
    );
    res.json(await deps.studio.listProjects(ctx, query));
  });

  router.post("/projects", async (req, res) => {
    const { ctx } = sessionOf(res);
    const body = parseBody(CreateVideoBody, req.body, "video request");
    const pack = resolveWorkflowPack(packRegistry, body.workflowTemplate);
    await assertPlannerSelection(deps, ctx, body.planner);
    const result = await deps.studio.createVideoProject(ctx, {
      brief: {
        prompt: body.prompt,
        ...(body.aspectRatio ? { aspectRatio: body.aspectRatio } : {}),
        ...(body.durationMs ? { durationMs: body.durationMs } : {}),
        ...(body.language ? { language: body.language } : {}),
      },
      title: body.title,
      budgetCents: body.budgetCents,
      idempotencyKey: body.idempotencyKey,
      planner: body.planner,
      workflowTemplate: pack.id,
    });
    await deps.activity?.record(ctx, {
      name: "dashboard.create_video",
      scope: { projectId: result.project.id, jobId: result.job.id },
      attributes: { actorId: ctx.actor.id },
    });
    res.status(result.replayed ? 200 : 201).json(result);
  });

  router.get("/projects/:projectId", async (req, res) => {
    const { ctx } = sessionOf(res);
    const details = await deps.studio.getProject(ctx, idParam(req, "projectId"));
    res.json(await projectView(artifacts, ctx, details, { includeIr: req.query.includeIr === "true" }));
  });

  router.get("/projects/:projectId/review", async (req, res) => {
    const { ctx } = sessionOf(res);
    const review = await deps.studio.getProjectReview(ctx, idParam(req, "projectId"));
    const renders = await Promise.all(
      review.renders.map(async (render) => {
        const { spec: _spec, ...rest } = render;
        const playback = isPlayable(render)
          ? await signRender(artifacts, ctx, render).catch(() => undefined)
          : undefined;
        return { ...rest, ...(playback ? { url: playback.url, urlExpiresAt: playback.expiresAt } : {}) };
      }),
    );
    res.set("Cache-Control", "no-store").json({ ...review, renders });
  });

  router.post("/projects/:projectId/storyboard/decision", async (req, res) => {
    const { ctx } = sessionOf(res);
    const input = parseBody(
      StoryboardDecisionInput,
      withProject(req.body, idParam(req, "projectId")),
      "storyboard decision",
    );
    res.json(await deps.studio.decideStoryboard(ctx, input));
  });

  router.post("/projects/:projectId/feedback", async (req, res) => {
    const { ctx } = sessionOf(res);
    const input = parseBody(FeedbackInput, withProject(req.body, idParam(req, "projectId")), "feedback");
    const result = await deps.studio.submitFeedback(ctx, input);
    res.status(result.replayed ? 200 : 201).json(result);
  });

  router.post("/projects/:projectId/render", async (req, res) => {
    const { ctx } = sessionOf(res);
    const input = parseBody(
      RenderVersionInput,
      withProject(req.body, idParam(req, "projectId")),
      "render request",
    );
    const result = await deps.studio.renderVersion(ctx, input);
    res.status(result.replayed ? 200 : 201).json(result);
  });

  router.get("/jobs", async (req, res) => {
    const { ctx } = sessionOf(res);
    assertPermission(ctx, "project:read");
    const query = parseBody(
      PageQuery.extend({
        status: z.enum(JOB_STATUSES).optional(),
        projectId: z
          .string()
          .regex(/^[A-Za-z0-9_-]{1,100}$/)
          .optional(),
      }),
      req.query,
      "query",
    );
    res.json(await deps.repos.jobs.list(ctx, query));
  });

  router.get("/jobs/:jobId", async (req, res) => {
    const { ctx } = sessionOf(res);
    const job = await deps.studio.getJob(ctx, idParam(req, "jobId"));
    const [view, activity] = await Promise.all([
      jobWithVideo(artifacts, ctx, job),
      deps.repos.activity.list(ctx, { jobId: job.id, limit: 100 }),
    ]);
    res.json({ job: view, activity: activity.items });
  });

  router.post("/jobs/:jobId/cancel", async (req, res) => {
    const { ctx } = sessionOf(res);
    const body = parseBody(
      z.object({ reason: z.string().trim().max(500).optional() }),
      req.body,
      "cancel request",
    );
    res.json(await deps.studio.cancelJob(ctx, idParam(req, "jobId"), body.reason));
  });

  router.post("/jobs/:jobId/retry", async (req, res) => {
    const { ctx } = sessionOf(res);
    res.json(await deps.studio.retryJob(ctx, idParam(req, "jobId")));
  });

  router.get("/renders/:renderId/playback", async (req, res) => {
    const { ctx } = sessionOf(res);
    assertPermission(ctx, "asset:read");
    res
      .set("Cache-Control", "no-store")
      .json(await playbackForRender(artifacts, ctx, idParam(req, "renderId")));
  });

  router.post("/approvals/:approvalId/decision", async (req, res) => {
    const { ctx } = sessionOf(res);
    const body = parseBody(DecisionBody, req.body, "approval decision");
    const approval = await deps.studio.approve(ctx, { approvalId: idParam(req, "approvalId"), ...body });
    res.json({ approval });
  });

  return router;
}
