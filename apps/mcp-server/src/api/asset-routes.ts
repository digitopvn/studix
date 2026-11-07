import { ASSET_KINDS } from "@studix/core";
import { StudixError } from "@studix/shared";
import express, { Router } from "express";
import { z } from "zod";
import type { AppDeps } from "../app-deps.ts";
import { idParam, parseBody, sessionOf } from "./api-context.ts";

/** 1.5 MB of file bytes is about 2 MB of base64, the same cap as a /mcp request. */
const UPLOAD_BODY_LIMIT = "2mb";

const Id = z.string().trim().min(1).max(100);
const ListQuery = z.object({
  projectId: Id.optional(),
  kind: z.enum(ASSET_KINDS).optional(),
  q: z.string().trim().min(1).max(100).optional(),
  state: z.enum(["active", "deleted", "all"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().trim().min(1).max(200).optional(),
});
const GetQuery = z.object({ versionId: Id.optional() });
const UpdateBody = z
  .object({ name: z.string().trim().min(1).max(200).optional(), projectId: Id.nullable().optional() })
  .strict();

function requireAssets(deps: AppDeps) {
  if (!deps.assets) {
    throw new StudixError("UNAVAILABLE", "Asset management is not enabled on this server", {
      retryable: false,
    });
  }
  return deps.assets;
}

/**
 * `/api/assets`: the same operations as the `studix_*_asset` MCP tools, for the dashboard and scripts. The
 * service enforces `asset:read` / `asset:write` and the workspace of the session.
 *
 * - `GET /` list and search, `GET /:id` details with versions, lineage and a signed URL
 * - `POST /` upload (JSON `base64` or `url`; with `assetId` it adds a version)
 * - `PATCH /:id` rename or move, `DELETE /:id` trash, `POST /:id/restore`
 */
export function assetRoutes(deps: AppDeps): Router {
  const router = Router();
  router.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  router.get("/", async (req, res) => {
    const query = parseBody(ListQuery, req.query, "asset list query");
    res.json(await requireAssets(deps).list(sessionOf(res).ctx, query));
  });
  router.post("/", express.json({ limit: UPLOAD_BODY_LIMIT }), async (req, res) => {
    // The service validates the body in full; the URL fetch stops when the client disconnects.
    const abort = new AbortController();
    res.once("close", () => abort.abort());
    res.status(201).json(await requireAssets(deps).upload(sessionOf(res).ctx, req.body ?? {}, abort.signal));
  });
  router.get("/:assetId", async (req, res) => {
    const query = parseBody(GetQuery, req.query, "asset query");
    res.json(
      await requireAssets(deps).get(sessionOf(res).ctx, { assetId: idParam(req, "assetId"), ...query }),
    );
  });
  router.patch("/:assetId", express.json({ limit: "256kb" }), async (req, res) => {
    const body = parseBody(UpdateBody, req.body, "asset update");
    res.json(
      await requireAssets(deps).update(sessionOf(res).ctx, { assetId: idParam(req, "assetId"), ...body }),
    );
  });
  router.delete("/:assetId", async (req, res) => {
    res.json(await requireAssets(deps).setDeleted(sessionOf(res).ctx, idParam(req, "assetId"), true));
  });
  router.post("/:assetId/restore", async (req, res) => {
    res.json(await requireAssets(deps).setDeleted(sessionOf(res).ctx, idParam(req, "assetId"), false));
  });
  return router;
}
