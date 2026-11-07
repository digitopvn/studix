import { readFileSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { AppDeps } from "../app-deps.ts";
import { jobWithVideo } from "../resource-views.ts";
import { type NativeTool, reviewUrl, type ToolContext } from "./native-tools.ts";

/**
 * MCP App (MCP Apps extension, `io.modelcontextprotocol/ui`) for reviewing a video in the chat: player,
 * storyboard, timestamp and region notes sent as `studix_feedback`, approve and re-render. Hosts without MCP
 * Apps ignore the `_meta` and keep the plain JSON result.
 */
export const REVIEW_APP_URI = "ui://studix/review.html";
export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";

const html = readFileSync(new URL("./review-app.html", import.meta.url), "utf8");

/** `_meta` for tools whose result the review app renders (MCP Apps and the OpenAI Apps SDK keys). */
export const REVIEW_APP_TOOL_META = {
  ui: { resourceUri: REVIEW_APP_URI },
  "openai/outputTemplate": REVIEW_APP_URI,
  "openai/widgetAccessible": true,
  "openai/toolInvocation/invoking": "Working on the video…",
  "openai/toolInvocation/invoked": "Video job ready",
} as const;

function mediaOrigins(deps: AppDeps): string[] {
  const origins = typeof deps.mediaOrigins === "function" ? deps.mediaOrigins() : (deps.mediaOrigins ?? []);
  return [...new Set(origins)];
}

export function registerReviewApp(server: McpServer, deps: AppDeps): void {
  server.registerResource(
    "studix-review-app",
    REVIEW_APP_URI,
    {
      title: "Studix video review",
      description: "Player, storyboard and review notes",
      mimeType: MCP_APP_MIME_TYPE,
    },
    async (uri) => {
      const media = mediaOrigins(deps);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: MCP_APP_MIME_TYPE,
            text: html,
            _meta: {
              // The player streams signed URLs from object storage; nothing else is fetched.
              ui: { csp: { resourceDomains: media, connectDomains: [] }, prefersBorder: true },
              "openai/widgetCSP": { resource_domains: media, connect_domains: [] },
              "openai/widgetDescription":
                "Plays the Studix video and its storyboard; notes become studix_feedback.",
              "openai/widgetPrefersBorder": true,
            },
          },
        ],
      };
    },
  );
}

const MAX_NOTES = 50;

async function reviewData(ctx: ToolContext, projectId: string) {
  const review = await ctx.deps.studio.getProjectReview(ctx.tenant, projectId);
  const details = await ctx.deps.studio.getProject(ctx.tenant, projectId);
  const latest = details.jobs.find((j) => j.status === "succeeded");
  const video = latest ? (await jobWithVideo(ctx.artifacts, ctx.tenant, latest)).video : undefined;
  const waiting = details.jobs.find((j) => j.status === "waiting_approval");
  return {
    projectId,
    title: review.project.title,
    reviewUrl: reviewUrl(ctx.deps, projectId),
    ...(review.timeline ? { timeline: review.timeline } : {}),
    ...(review.storyboard
      ? {
          storyboard: {
            approval: review.storyboard.approval,
            pendingShots: review.storyboard.pendingShots,
            scenes: review.storyboard.scenes.map((scene) => ({
              id: scene.id,
              title: scene.title,
              startMs: scene.startMs,
              endMs: scene.endMs,
              shots: scene.shots.map((s) => ({
                id: s.id,
                description: s.description,
                ...(s.script ? { script: s.script } : {}),
                startMs: s.startMs,
                endMs: s.endMs,
                approval: s.approval,
                render: s.render,
              })),
            })),
          },
        }
      : {}),
    ...(video ? { video } : {}),
    ...(waiting?.approval ? { pendingApprovalId: waiting.approval.id } : {}),
    notes: review.comments
      .filter((c) => c.status === "open")
      .slice(0, MAX_NOTES)
      .map((c) => ({
        feedbackId: c.id,
        target: c.targetId,
        ...(c.atMs !== undefined ? { startMs: c.atMs, endMs: c.endMs } : {}),
        comment: c.body,
      })),
  };
}

/** Data tool for the review app; `visibility: ["app"]` keeps it out of the model's tool list in MCP Apps hosts. */
export const REVIEW_APP_TOOLS = [
  {
    name: "studix_review",
    title: "Review data",
    description: "For the review app: storyboard, timeline, newest video and open notes of a project.",
    input: z.object({ projectId: z.string().trim().min(1).max(100) }),
    readOnly: true,
    meta: { ui: { resourceUri: REVIEW_APP_URI, visibility: ["app"] } },
    async run(ctx, input) {
      return { data: await reviewData(ctx, input.projectId), next: [] };
    },
  } satisfies NativeTool<z.ZodObject<{ projectId: z.ZodString }>>,
];
