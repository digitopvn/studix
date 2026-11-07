import { StudixError } from "@studix/shared";
import type { ExternalSkillService } from "@studix/skills";
import express, { Router } from "express";
import { z } from "zod";
import type { AppDeps } from "../app-deps.ts";
import { idParam, parseBody, sessionOf } from "./api-context.ts";

/** Upload bodies are raw zip bytes; the service applies the real archive limit after reading. */
const ARCHIVE_BODY_LIMIT = "31mb";

const Scope = z.enum(["workspace", "platform"]).optional();
const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().trim().min(1).max(200).optional(),
  status: z.enum(["enabled", "disabled", "all"]).optional(),
  q: z.string().trim().min(1).max(100).optional(),
  scope: z.enum(["workspace", "platform", "visible"]).optional(),
});
const GetQuery = z.object({
  versionId: z.string().trim().min(1).max(100).optional(),
  path: z.string().trim().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(64_000).optional(),
});
const SourceBody = z
  .object({
    repositoryUrl: z.string().trim().min(1).max(500),
    ref: z.string().trim().min(1).max(200).optional(),
    path: z.string().trim().max(500).optional(),
  })
  .strict();
const ImportBody = SourceBody.extend({
  skillPaths: z.array(z.string().trim().max(500)).max(50).optional(),
  expectedCommit: z
    .string()
    .regex(/^[0-9a-f]{40}$/i)
    .optional(),
  activate: z.boolean().optional(),
  scope: Scope,
}).strict();
const UploadQuery = z.object({
  scope: Scope,
  fileName: z.string().trim().min(1).max(200).optional(),
  activate: z.enum(["true", "false"]).optional(),
  confirmHighRisk: z.enum(["true", "false"]).optional(),
});
const ConfirmHighRisk = z.boolean().optional();
const UpdateBody = z.discriminatedUnion("action", [
  z.object({ action: z.literal("check") }).strict(),
  z
    .object({
      action: z.literal("import"),
      activate: z.boolean().optional(),
      confirmHighRisk: ConfirmHighRisk,
    })
    .strict(),
  z
    .object({
      action: z.literal("activate"),
      versionId: z.string().trim().min(1).max(100),
      confirmHighRisk: ConfirmHighRisk,
    })
    .strict(),
  z.object({ action: z.literal("enable"), confirmHighRisk: ConfirmHighRisk }).strict(),
]);

function requireSkills(deps: AppDeps): ExternalSkillService {
  if (!deps.externalSkills) {
    throw new StudixError("UNAVAILABLE", "Skills are not enabled on this server", { retryable: false });
  }
  return deps.externalSkills;
}

/**
 * The dashboard Skills page: list and read skills, import from GitHub, upload a zip (raw `application/zip`
 * body), and manage versions and status. The service enforces permissions, scope and the high-risk gate.
 */
export function skillRoutes(deps: AppDeps): Router {
  const router = Router();
  router.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  router.get("/", async (req, res) => {
    const query = parseBody(ListQuery, req.query, "skill list query");
    res.json(await requireSkills(deps).list(sessionOf(res).ctx, query));
  });
  router.post("/discover", async (req, res) => {
    const body = parseBody(SourceBody, req.body, "skill source");
    res.json(await requireSkills(deps).discover(sessionOf(res).ctx, body));
  });
  router.post("/import", async (req, res) => {
    const body = parseBody(ImportBody, req.body, "skill import");
    res.json(await requireSkills(deps).import(sessionOf(res).ctx, body));
  });
  router.post(
    "/upload",
    express.raw({ type: "application/zip", limit: ARCHIVE_BODY_LIMIT }),
    async (req, res) => {
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        throw new StudixError("VALIDATION", "Send the zip archive as the request body", {
          suggestedAction: "Set Content-Type: application/zip.",
        });
      }
      const query = parseBody(UploadQuery, req.query, "skill upload query");
      res.json(
        await requireSkills(deps).upload(sessionOf(res).ctx, {
          archive: new Uint8Array(req.body),
          scope: query.scope,
          fileName: query.fileName,
          activate: query.activate === "true",
          confirmHighRisk: query.confirmHighRisk === "true",
        }),
      );
    },
  );
  router.get("/:skillId", async (req, res) => {
    const query = parseBody(GetQuery, req.query, "skill query");
    res.json(
      await requireSkills(deps).get(sessionOf(res).ctx, {
        skillId: idParam(req, "skillId"),
        includeVersions: true,
        ...query,
      }),
    );
  });
  router.post("/:skillId/update", async (req, res) => {
    const body = parseBody(UpdateBody, req.body, "skill update");
    res.json(
      await requireSkills(deps).update(sessionOf(res).ctx, { skillId: idParam(req, "skillId"), ...body }),
    );
  });
  router.post("/:skillId/disable", async (req, res) => {
    res.json(await requireSkills(deps).disable(sessionOf(res).ctx, { skillId: idParam(req, "skillId") }));
  });
  router.delete("/:skillId", async (req, res) => {
    res.json(await requireSkills(deps).delete(sessionOf(res).ctx, { skillId: idParam(req, "skillId") }));
  });
  return router;
}
